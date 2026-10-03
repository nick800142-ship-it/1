import { useCallback } from "react";
import {
  createWalletClient,
  custom,
  http,
  createPublicClient,
  maxUint256,
  parseUnits,
  type Address,
  type EIP1193Provider,
  type PublicClient,
} from "viem";
import { useWallets } from "@privy-io/react-auth";
import { CHAIN, CHAIN_ID, CONTRACT_ADDRESSES, ERC20_ABI, normalizeAddress } from "@/lib/contracts";
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
type TokenKey = "aeToken" | "jcToken";

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
  | "list-fee"
  | "redeem-jc"
  | "sync-holding"
  | "sponsor-gas"
  | "wire-contracts"
  | "relayer-address"
  | "admin-list-settlements"
  | "admin-retry-settlement"
  | "admin-vault-status"
  | "admin-create-rwa-token"
  | "admin-mint"
  | "admin-rwa-reclaim"
  | "admin-ae-reclaim";

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

// 在「使用者自己的錢包要簽 USDT 交易（金庫入金／提領）」之前呼叫：請後端 ADMIN
// 幫使用者錢包補一點 Base Sepolia ETH 付 Gas，讓 ETH=0 的全新錢包也能自己簽名。
// 盡力而為——後端會等補助交易上鏈才回傳，成功後使用者錢包即有 Gas；若失敗（網路
// 等）也不阻擋，讓使用者照常嘗試簽名（可能本來就有 ETH），簽名步驟仍是最終判斷。
export async function sponsorGasBestEffort(): Promise<void> {
  try {
    await callRelayer("sponsor-gas", {});
  } catch (err) {
    console.log("[v0] sponsor-gas best-effort failed:", err instanceof Error ? err.message : err);
  }
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
  { entryType: "p2p_listing_fee", action: "list-fee" as const, settlementAction: "list_fee", deriveRequestKey: (k: string) => k.replace(/:listfee$/, "") },
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
      .in("action", ["mint_jc", "subscribe", "trade", "list_fee"])
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
  // 跳簽名）。授權是使用者對自己資產的安全動作，由其內嵌錢包簽名。這裡收 raw
  // 地址+ABI，讓 RWA Factory 那些「每個標的一顆專屬代幣、地址是動態的」環境
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

      // approve 本身是一筆需要 Gas 的鏈上交易，全新錢包 ETH=0 會簽不出來。簽名前
      // 先請後端 ADMIN 幫這個錢包補一點 ETH（平台代付），盡力而為不阻擋。
      await sponsorGasBestEffort();
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
      return ensureAllowanceForToken(CONTRACT_ADDRESSES[tokenKey], ERC20_ABI, spender);
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

  // 使用者可花用的 JC 門檻檢查（在扣站內帳本、送出鏈上結算「之前」呼叫）：
  //  1) 對 ADMIN 熱錢包做一次性 JC 授權（之後 relayer 才能 transferFrom 收款）；
  //  2) 讀鏈上 JC 餘額，若不足以支付 gross 就丟錯擋下——分潤 JC 只記在站內帳本、
  //     尚未上鏈，故鏈上餘額可能小於站內可用 JC，此時不允許認購／交易。
  const ensureJcSpendable = useCallback(
    async (gross: number): Promise<void> => {
      if (!wallet) throw new Error("找不到可用的錢包，請重新登入");
      const owner = normalizeAddress(wallet.address);
      if (!owner) throw new Error("錢包地址無效");
      const admin = await getRelayerAddress();
      await ensureAllowance("jcToken", admin);
      const [balance, decimals] = (await Promise.all([
        getClient().readContract({ address: CONTRACT_ADDRESSES.jcToken, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }),
        getClient().readContract({ address: CONTRACT_ADDRESSES.jcToken, abi: ERC20_ABI, functionName: "decimals" }),
      ])) as [bigint, number];
      const need = parseUnits(gross.toFixed(decimals), decimals);
      if (balance < need) {
        throw new Error(
          "您的鏈上 JC 餘額不足以支付本筆金額。分潤 JC 尚未上鏈，請先在錢包金庫用 USDT 購買足額 JC 後再認購／交易。",
        );
      }
    },
    [wallet, getRelayerAddress, ensureAllowance],
  );

  // 掛賣單一次性手續費（1 JC）的鏈上門檻檢查：在扣站內帳本、送出鏈上結算「之前」
  // 呼叫。要求賣方鏈上錢包可用 JC ≥ 1（掛單手續費），並對 ADMIN 熱錢包做一次性 JC
  // 授權（之後 relayer 才能 transferFrom 收這 1 JC 進金庫）。餘額不足就丟錯擋下掛單。
  const ensureJcListingFee = useCallback(
    async (listingFee = 1): Promise<void> => {
      if (!wallet) throw new Error("找不到可用的錢包，請重新登入");
      const owner = normalizeAddress(wallet.address);
      if (!owner) throw new Error("錢包地址無效");
      const admin = await getRelayerAddress();
      await ensureAllowance("jcToken", admin);
      const [balance, decimals] = (await Promise.all([
        getClient().readContract({ address: CONTRACT_ADDRESSES.jcToken, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }),
        getClient().readContract({ address: CONTRACT_ADDRESSES.jcToken, abi: ERC20_ABI, functionName: "decimals" }),
      ])) as [bigint, number];
      const need = parseUnits(listingFee.toFixed(decimals), decimals);
      if (balance < need) {
        throw new Error(
          `掛賣單需收取 ${listingFee} JC 一次性手續費，您的鏈上錢包可用 JC 不足。請先在錢包金庫用 USDT 購買足額 JC（可用 JC 餘額需 ≥ ${listingFee}）後再掛單。`,
        );
      }
    },
    [wallet, getRelayerAddress, ensureAllowance],
  );

  // 掛賣單成功後：請 relayer 把 1 JC 掛單手續費從賣方錢包收進 Safe 金庫。
  const settleListingFee = useCallback(async (requestKey: string) => {
    return callRelayer("list-fee", { requestKey });
  }, []);

  // JC 贖回：request_jc_redemption 成功建立 pending 訂單後立刻呼叫，請 relayer
  // 把使用者鏈上 JC 收回 Safe 金庫＋直接撥 USDT 給使用者。需先對 ADMIN 授權 JC
  // （若先前已在 ensureJcSpendable/掛單等流程授權過則是 no-op，不會重複跳簽名）。
  const settleRedemption = useCallback(
    async (orderId: string) => {
      try {
        const admin = await getRelayerAddress();
        await ensureAllowance("jcToken", admin);
      } catch {
        /* 授權失敗不阻擋：relayer 撥款時會回報，並可由管理員一鍵補發 */
      }
      return callRelayer("redeem-jc", { orderId });
    },
    [ensureAllowance, getRelayerAddress],
  );

  // 一級認購：鏈上把標的（RWA 專屬份額 / AE）由 ADMIN 熱錢包 transfer 給買方，並把
  // 買方付的本金 JC 由 relayer 收進 Safe 金庫（買方→ADMIN→Safe 兩跳，見後端）。買方
  // 需先對 ADMIN 授權 JC——這裡確保授權存在（若頁面已在扣款前 ensureJcSpendable 授權
  // 過就是 no-op），之後 relayer 才能 transferFrom 收款。
  const settleSubscription = useCallback(
    async (requestKey: string) => {
      try {
        const admin = await getRelayerAddress();
        await ensureAllowance("jcToken", admin);
      } catch {
        /* 授權失敗不阻擋：relayer 收款時會回報，並可由管理員一鍵補發 */
      }
      return callRelayer("subscribe", { requestKey });
    },
    [ensureAllowance, getRelayerAddress],
  );

  // 二級成交鏈上做兩件事：JC 收付（買方 gross → 賣方 net、平台 fee → Safe 金庫，走
  // 買方→ADMIN→x 兩跳）＋標的份額由賣方交割給買方。兩者都由 ADMIN 憑「一次性授權」
  // 代為 transferFrom，因此雙方都要先授權 ADMIN：
  //  - 賣方（side/takerSide = "sell"）：授權標的代幣（RWA 專屬份額 / AE）給 ADMIN。
  //  - 買方（side/takerSide = "buy"）：授權 JC 給 ADMIN，之後 relayer 才能收其 JC。
  // 掛單時就先授權，之後被自動撮合或管理員補發時 relayer 才能代收付／代交割（即使
  // 當事人當下離線）。
  const approveOrderSide = useCallback(
    async (side: "buy" | "sell", isAe: boolean, factoryTokenAddress?: string | null) => {
      const admin = await getRelayerAddress();
      if (side === "buy") {
        await ensureAllowance("jcToken", admin);
        return;
      }
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

  return {
    mintJcOnchain,
    ensureJcSpendable,
    ensureJcListingFee,
    settleListingFee,
    settleRedemption,
    settleSubscription,
    approveForOrder,
    settleTrade,
    walletReady: !!wallet,
  };
}
