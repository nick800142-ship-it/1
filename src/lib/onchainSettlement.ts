import { useCallback } from "react";
import {
  createWalletClient,
  custom,
  http,
  createPublicClient,
  maxUint256,
  type Address,
  type EIP1193Provider,
  type PublicClient,
} from "viem";
import { useWallets } from "@privy-io/react-auth";
import { CHAIN, CHAIN_ID, CONTRACT_ADDRESSES, CONTRACT_ABIS, ERC20_ABI, normalizeAddress } from "@/lib/contracts";
import { supabase } from "@/lib/supabase";

// 前端串接後端 relayer（合約 owner）的薄封裝。
//
// 分工：
//  - 需要「使用者本人簽名」的動作（approve 授權自己的代幣）留在前端錢包。
//  - 需要「合約 owner 簽名」的動作（mint / executeSubscription / executeTrade）
//    一律送到 /api/relayer，由後端用 owner 私鑰代發。
//
// 所有鏈上結算都是「盡力而為」的鏡像：失敗只回傳錯誤訊息供 UI 附註，永遠不
// 回退已成功的站內（Supabase 帳本）結果。

const RPC_URL = "https://sepolia.base.org";
type TokenKey = "rwaMaster" | "aeToken" | "jcToken";

let cachedClient: PublicClient | null = null;
// 平台收款地址（ADMIN 熱錢包）在整個 session 內固定，快取一次即可。
let cachedRelayerAddress: Address | null = null;
function getClient(): PublicClient {
  if (!cachedClient) {
    cachedClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) }) as PublicClient;
  }
  return cachedClient;
}

type RelayerAction =
  | "mint-jc"
  | "subscribe"
  | "trade"
  | "sync-holding"
  | "wire-contracts"
  | "relayer-address"
  | "admin-list-settlements"
  | "admin-retry-settlement"
  | "admin-vault-status"
  | "admin-create-rwa-token";

export async function callRelayer(
  action: RelayerAction,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("登入狀態已失效，請重新登入");
  const res = await fetch("/api/relayer", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...params }),
  });
  // 先讀原始文字，才能在「回傳的不是 JSON」（例：/api/relayer 被 SPA 改寫成
  // index.html、或部署保護回傳 SSO 頁）時，把真正的狀態碼與內容片段帶進錯誤，
  // 而不是一律顯示籠統的「relayer X 失敗」。
  const raw = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    // 非 JSON 回應：多半是端點根本沒打到 serverless function。
    const looksHtml = /^\s*<(?:!doctype|html)/i.test(raw);
    throw new Error(
      `relayer ${action} 失敗（HTTP ${res.status}${looksHtml ? "，回傳的是網頁而非 API，通常代表此版本尚未重新部署 /api 路由" : `：${raw.slice(0, 120)}`}）`,
    );
  }
  if (!res.ok) {
    throw new Error(
      typeof json.error === "string" ? json.error : `relayer ${action} 失敗（HTTP ${res.status}）`,
    );
  }
  return json;
}

// 把「從 Safe 金庫直接鏈上轉入、繞過站內帳本」的 RWA 份額同步回 holdings 帳本，
// 讓二級市場的可交易額度反映錢包的鏈上真實持有。純伺服器端讀鏈＋補帳，不需要
// 使用者簽名；盡力而為，失敗只回傳結果供 UI 參考，不阻擋任何流程。
export async function syncHoldingFromChain(
  placementId: string,
): Promise<{ synced: boolean; to?: number }> {
  try {
    const res = await callRelayer("sync-holding", { placementId });
    return { synced: Boolean(res.synced), to: typeof res.to === "number" ? res.to : undefined };
  } catch {
    return { synced: false };
  }
}

// 三種「站內帳本先成功、鏈上結算盡力而為」的鏡像流程，都可能因為使用者付款
// 後關掉瀏覽器、網路中斷、relayer 當下 gas 不足等原因，讓站內顯示已扣款/已成交，
// 但鏈上錢包從未真的收到幣——而且沒有任何人會發現。這裡統一自動補跑：找出
// 目前使用者「已入帳但還沒有對應已確認鏈上結算」的紀錄，重新請 relayer 補發。
// 每個 relayer action 本身都以 ref_key 做冪等（見 api/relayer.ts claimSettlement），
// 重複呼叫不會重複發幣或重複結算，可以放心自動重試。
const RECONCILE_SOURCES = [
  { entryType: "vault_buy", action: "mint-jc" as const, settlementAction: "mint_jc", deriveRequestKey: (k: string) => k.replace(/:jc$/, "") },
  { entryType: "private_purchase", action: "subscribe" as const, settlementAction: "subscribe", deriveRequestKey: (k: string) => k },
  { entryType: "p2p_buy", action: "trade" as const, settlementAction: "trade", deriveRequestKey: (k: string) => k.replace(/:buyer$/, "") },
];

let reconcileInFlight = false;

export async function reconcilePendingSettlements(): Promise<{ retried: number; fixed: number }> {
  // 避免多個元件（例如頁面掛載＋登入狀態變化）同時觸發，造成重複的 relayer 請求。
  if (reconcileInFlight) return { retried: 0, fixed: 0 };
  reconcileInFlight = true;
  try {
    const { data: settledRows } = await supabase
      .from("onchain_settlements")
      .select("ref_key")
      .in("action", ["mint_jc", "subscribe", "trade"])
      .eq("status", "confirmed");
    const confirmed = new Set((settledRows ?? []).map((r) => (r as { ref_key: string }).ref_key));

    let retried = 0;
    let fixed = 0;
    for (const source of RECONCILE_SOURCES) {
      const { data: ledgerRows } = await supabase
        .from("jc_ledger")
        .select("id,idempotency_key")
        .eq("entry_type", source.entryType)
        .not("idempotency_key", "is", null);
      const rows = (ledgerRows ?? []) as { id: string; idempotency_key: string | null }[];
      const pending = rows.filter((row) => !confirmed.has(`${source.settlementAction}:${row.id}`));
      retried += pending.length;
      for (const row of pending) {
        const requestKey = source.deriveRequestKey(row.idempotency_key ?? "");
        if (!requestKey) continue;
        try {
          await callRelayer(source.action, { requestKey });
          fixed += 1;
        } catch {
          // 盡力而為：這次還是失敗（例如標的已下架、relayer 暫時沒有 gas）就留給
          // 下次登入或重新整理時再補一次，也仍會出現在管理員後台的補發列表裡。
        }
      }
    }
    return { retried, fixed };
  } finally {
    reconcileInFlight = false;
  }
}

export function useOnchainSettlement() {
  const { wallets } = useWallets();
  const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0] ?? null;

  // 確保使用者已授權指定合約動用其代幣（allowance 足夠時直接略過，避免每次都
  // 跳簽名）。授權是使用者對自己資產的安全動作，用其內嵌錢包簽名。這裡收 raw
  // 地址+ABI，讓 RWA Factory 那些「每個標的一顆專屬代幣、地址是動態的」���境
  // 也能沿用同一套邏輯，不必侷限於 CONTRACT_ADDRESSES 裡固定的幾個 key。
  const ensureAllowanceForToken = useCallback(
    async (tokenAddress: Address, abi: typeof ERC20_ABI, spender: Address): Promise<void> => {
      if (!wallet) throw new Error("找不到可用的錢包，請重新登入");
      const owner = normalizeAddress(wallet.address);
      if (!owner) throw new Error("錢包地址無效");
      const allowance = (await getClient().readContract({
        address: tokenAddress,
        abi,
        functionName: "allowance",
        args: [owner, spender],
      })) as bigint;
      // 已有足夠（接近無上限）授權就不重複簽名。
      if (allowance > maxUint256 / 2n) return;

      await wallet.switchChain(CHAIN_ID);
      const provider = (await wallet.getEthereumProvider()) as EIP1193Provider;
      const walletClient = createWalletClient({ account: owner, chain: CHAIN, transport: custom(provider) });
      const hash = await walletClient.writeContract({
        address: tokenAddress,
        abi,
        functionName: "approve",
        args: [spender, maxUint256],
      });
      await getClient().waitForTransactionReceipt({ hash });
    },
    [wallet],
  );

  const ensureAllowance = useCallback(
    async (tokenKey: TokenKey, spender: Address): Promise<void> => {
      return ensureAllowanceForToken(CONTRACT_ADDRESSES[tokenKey], CONTRACT_ABIS[tokenKey], spender);
    },
    [ensureAllowanceForToken],
  );

  // 金庫買 JC 後，請 relayer 把等量 JC mint 到使用者錢包（無需授權）。
  const mintJcOnchain = useCallback(async (requestKey: string) => {
    return callRelayer("mint-jc", { requestKey });
  }, []);

  // 取得平台收款地址（ADMIN 熱錢包），供「買方授權 ADMIN 動用 JC」用。整個
  // session 內位址不變，快取避免每次認購都多打一次 relayer。
  const getRelayerAddress = useCallback(async (): Promise<Address> => {
    if (cachedRelayerAddress) return cachedRelayerAddress;
    const res = await callRelayer("relayer-address", {});
    const addr = normalizeAddress(res.address as string);
    if (!addr) throw new Error("無法取得平台收款地址，請稍後再試");
    cachedRelayerAddress = addr;
    return addr;
  }, []);

  // 一級認購：鏈上只把標的（RWA 專屬份額 / AE）由 ADMIN 熱錢包直接 transfer 給
  // 買方，買方不需要任何授權。JC 本金不在鏈上收取——JC 合約限制 P2P 轉帳（只允許
  // 與 owner 有關的轉帳），買方無法把 JC 轉給 Safe 或其他人，故 JC 以站內 jc_ledger
  // 為準（認購當下已扣款）。因此這裡直接請 relayer 發標的，不再要求買方簽 JC 授權。
  const settleSubscription = useCallback(
    async (requestKey: string, _isAe = false, _factoryTokenAddress?: string | null) => {
      return callRelayer("subscribe", { requestKey });
    },
    [],
  );

  // 二級成交：鏈上只做「賣方 → 買方 交割標的份額」，由 ADMIN 憑賣方授權代交割。
  // JC 的收付（買方付 net 給賣方、fee 給平台）不在鏈上進行——JC 合約限制 P2P 轉帳，
  // 買方無法把 JC 轉給賣方或平台，故 JC 收付全以站內 jc_ledger 為準。因此：
  //  - 賣方（side/takerSide = "sell"）：授權標的代幣（RWA 專屬份額 / AE）給 ADMIN。
  //  - 買方（side/takerSide = "buy"）：不需要任何鏈上授權。
  // 賣單掛單時就先授權，之後被自動撮合或管理員補發時 relayer 才能代交割。
  const approveOrderSide = useCallback(
    async (side: "buy" | "sell", isAe: boolean, factoryTokenAddress?: string | null) => {
      if (side === "buy") return;
      const admin = await getRelayerAddress();
      // 賣方授權標的代幣：AE 用固定 aeToken；RWA 用該標的專屬份額代幣地址。
      if (isAe) {
        await ensureAllowance("aeToken", admin);
        return;
      }
      const factoryToken = normalizeAddress(factoryTokenAddress);
      if (!factoryToken) {
        throw new Error("此 RWA 標的尚未建立專屬代幣，無法授權賣出。請先在後台建立 RWA 代幣並回填代幣地址。");
      }
      await ensureAllowanceForToken(factoryToken, ERC20_ABI, admin);
    },
    [ensureAllowance, ensureAllowanceForToken, getRelayerAddress],
  );

  const approveForOrder = useCallback(
    async (side: "buy" | "sell", isAe = false, factoryTokenAddress?: string | null) => {
      await approveOrderSide(side, isAe, factoryTokenAddress);
    },
    [approveOrderSide],
  );

  // 成交後：taker 先補上自己這側對 ADMIN 的授權，再請 relayer 代扣付並交割。
  // takerSide 指「目前使用者在這筆成交中的角色」。
  const settleTrade = useCallback(
    async (requestKey: string, takerSide: "buy" | "sell", isAe = false, factoryTokenAddress?: string | null) => {
      await approveOrderSide(takerSide, isAe, factoryTokenAddress);
      return callRelayer("trade", { requestKey });
    },
    [approveOrderSide],
  );

  return { mintJcOnchain, settleSubscription, approveForOrder, settleTrade, walletReady: !!wallet };
}
