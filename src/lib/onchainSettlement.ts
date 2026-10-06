import { useCallback } from "react";
import {
  createWalletClient,
  custom,
  http,
  createPublicClient,
  parseUnits,
  keccak256,
  toBytes,
  type Address,
  type EIP1193Provider,
  type PublicClient,
} from "viem";
import { useWallets } from "@privy-io/react-auth";
import { CHAIN, CHAIN_ID, CONTRACT_ADDRESSES, ERC20_ABI, P2P_ESCROW_ABI, P2P_ESCROW_ADDRESS, normalizeAddress } from "@/lib/contracts";
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

async function confirmEscrowTransaction(hash: `0x${string}`, failureMessage: string): Promise<`0x${string}`> {
  let receipt;
  try {
    receipt = await getClient().waitForTransactionReceipt({ hash, timeout: 90_000 });
  } catch {
    const pending = new Error("交易已提交但收據尚未確認；可用此交易雜湊稍後重試同步");
    Object.assign(pending, { transactionHash: hash });
    throw pending;
  }
  if (receipt.status !== "success") {
    const reverted = new Error(failureMessage);
    Object.assign(reverted, { transactionHash: hash, reverted: true });
    throw reverted;
  }
  return hash;
}

type RelayerAction =
  | "mint-jc"
  | "settle-vault-buy"
  | "subscribe"
  | "redeem-jc"
  | "sync-holding"
  | "sponsor-gas"
  | "wire-contracts"
  | "relayer-address"
  | "admin-list-settlements"
  | "admin-retry-settlement"
  | "admin-collect-manual-settlement-jc"
  | "admin-vault-status"
  | "check-subscription-stock"
  | "admin-create-rwa-token"
  | "admin-mint"
  | "admin-burn-inventory"
  | "admin-rwa-reclaim"
  | "admin-ae-reclaim"
  | "register-escrow-order"
  | "settle-escrow-fill"
  | "register-escrow-cancel"
  | "admin-escrow-status"
  | "admin-retry-escrow-event";

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

// 金庫買 JC 與一級認購仍採「站內先入帳、鏈上盡力結算」，登入時會補跑尚未
// confirmed 的紀錄。二級市場則由 P2PEscrow 原子託管，不走舊 relayer trade/list-fee。
const RECONCILE_SOURCES = [
  { entryType: "vault_buy", action: "mint-jc" as const, settlementAction: "mint_jc", deriveRequestKey: (k: string) => k.replace(/:jc$/, "") },
  { entryType: "private_purchase", action: "subscribe" as const, settlementAction: "subscribe", deriveRequestKey: (k: string) => k },
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
      .in("action", ["mint_jc", "subscribe"])
      .eq("status", "confirmed");
    const confirmed = new Set((settledRows ?? []).map((r) => (r as { ref_key: string }).ref_key));

    let retried = 0;
    let fixed = 0;
    const { data: reservations } = await supabase
      .from("settlement_reservations")
      .select("request_key,action,source_tx_hash,chain_payload")
      .eq("status", "pending");
    for (const reservation of reservations ?? []) {
      if (reservation.action === "vault_buy" && !reservation.source_tx_hash) continue;
      retried += 1;
      try {
        let result: Record<string, unknown>;
        if (reservation.action === "subscribe") {
          result = await callRelayer("subscribe", { requestKey: reservation.request_key });
        } else if (reservation.action === "vault_buy") {
          result = await callRelayer("mint-jc", { requestKey: reservation.request_key });
        } else {
          const payload = reservation.chain_payload as { order_id?: string } | null;
          if (!payload?.order_id) continue;
          result = await callRelayer("redeem-jc", { orderId: payload.order_id });
        }
        if (result.status === "confirmed") fixed += 1;
      } catch {
        // Pending reservations remain held until the server confirms all chain steps and finalizes their ledger.
      }
    }
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

  // 每次都由用戶透過 Privy 簽署本筆精確金額的 approve；不���用舊 allowance，
  // 也不再授予 ADMIN 無上限額度。支援地址動態的 RWA Factory 專屬代幣。
  const ensureAllowanceForToken = useCallback(
    async (
      tokenAddress: Address,
      abi: typeof ERC20_ABI,
      spender: Address,
      amount: number,
    ): Promise<`0x${string}`> => {
      if (!wallet) throw new Error("找不到可用的錢包，請重新登入");
      const owner = normalizeAddress(wallet.address);
      if (!owner) throw new Error("錢包地址無效");
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("授權金額無效");
      const decimals = (await getClient().readContract({
        address: tokenAddress,
        abi,
        functionName: "decimals",
      })) as number;
      const amountUnits = parseUnits(amount.toFixed(decimals), decimals);
      if (amountUnits <= 0n) throw new Error("授權金額必須大於 0");

      await sponsorGasBestEffort();
      await wallet.switchChain(CHAIN_ID);
      const provider = (await wallet.getEthereumProvider()) as EIP1193Provider;
      const walletClient = createWalletClient({ account: owner, chain: CHAIN, transport: custom(provider) });
      const hash = await walletClient.writeContract({
        address: tokenAddress,
        abi,
        functionName: "approve",
        args: [spender, amountUnits],
      });
      const receipt = await getClient().waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("JC 授權交易失敗");
      return hash;
    },
    [wallet],
  );

  const ensureAllowance = useCallback(
    async (tokenKey: TokenKey, spender: Address, amount: number): Promise<`0x${string}`> => {
      return ensureAllowanceForToken(CONTRACT_ADDRESSES[tokenKey], ERC20_ABI, spender, amount);
    },
    [ensureAllowanceForToken],
  );

  // 使用者轉出 USDT 後，後端先驗收鏈上 Transfer 收據，再發 JC 並原子寫正式帳本。
  const settleVaultPurchase = useCallback(async (requestKey: string, txHash: string) => {
    return callRelayer("settle-vault-buy", { requestKey, txHash });
  }, []);

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

  // 使用者可花用的 JC 門檻檢查（在扣站內帳本前呼叫）：讀鏈上餘額足額後，
  // 每筆都由 Privy 彈出 approve，授權 ADMIN 僅可動用本次 gross；分潤 JC 只記帳、
  //     尚未上鏈，故鏈上餘額可能小於站內可用 JC，此時不允許認購／交易。
  const ensureJcSpendable = useCallback(
    async (gross: number): Promise<void> => {
      if (!wallet) throw new Error("找不到可用的錢包，請重新登入");
      const owner = normalizeAddress(wallet.address);
      if (!owner) throw new Error("錢包地址無效");
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
      const admin = await getRelayerAddress();
      await ensureAllowance("jcToken", admin, gross);
    },
    [wallet, getRelayerAddress, ensureAllowance],
  );

  // 使用者完成逐筆 JC approve 後，才呼叫 relayer 執行贖回。
  const settleRedemption = useCallback(async (orderId: string) => {
    return callRelayer("redeem-jc", { orderId });
  }, []);

  // 認購頁在扣站內帳本前已請用戶對本筆 JC 金額簽署 approve；此處僅執行鏈上結算。
  const settleSubscription = useCallback(async (requestKey: string) => {
    return callRelayer("subscribe", { requestKey });
  }, []);

  // Escrow actions are signed by the connected user; the ADMIN wallet never moves order assets.
  const escrowWalletClient = useCallback(async () => {
    if (!wallet) throw new Error("找不到可用的錢包，請重新登入");
    const owner = normalizeAddress(wallet.address);
    if (!owner) throw new Error("錢包地址無效");
    await sponsorGasBestEffort();
    await wallet.switchChain(CHAIN_ID);
    const provider = (await wallet.getEthereumProvider()) as EIP1193Provider;
    return createWalletClient({ account: owner, chain: CHAIN, transport: custom(provider) });
  }, [wallet]);

  const approveEscrowUnits = useCallback(async (tokenAddress: Address, amountUnits: bigint) => {
    if (!wallet) throw new Error("找不到可用的錢包，請重新登入");
    if (amountUnits <= 0n) throw new Error("授權金額無效");
    const owner = normalizeAddress(wallet.address);
    if (!owner) throw new Error("錢包地址無效");
    const [decimals, balance] = await Promise.all([
      getClient().readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "decimals" }),
      getClient().readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }),
    ]);
    if (decimals !== 18) throw new Error("此標的代幣目前必須使用 18 位精度才能進入託管");
    if (balance < amountUnits) throw new Error("鏈上代幣餘額不足以完成此託管操作");
    if (!P2P_ESCROW_ADDRESS) throw new Error("二級市場託管合約尚未部署，暫時無法交易");
    const client = await escrowWalletClient();
    const hash = await client.writeContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [P2P_ESCROW_ADDRESS, amountUnits],
    });
    const receipt = await getClient().waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("代幣授權交易失敗");
  }, [wallet, escrowWalletClient]);

  const createEscrowOrder = useCallback(async (input: {
    side: "buy" | "sell";
    assetToken: string;
    price: string;
    quantity: string;
    requestKey: string;
  }) => {
    if (!P2P_ESCROW_ADDRESS) throw new Error("二級市場託管合約尚未部署，暫時無法交易");
    const assetToken = normalizeAddress(input.assetToken);
    if (!assetToken) throw new Error("標的代幣地址無效");
    const priceUnits = parseUnits(input.price, 18);
    const quantityUnits = parseUnits(input.quantity, 18);
    if (priceUnits <= 0n || quantityUnits <= 0n) throw new Error("掛單價格或份額無效");
    const rawGross = (priceUnits * quantityUnits) / 10n ** 18n;
    const grossUnits = ((rawGross + 500_000_000_000n) / 1_000_000_000_000n) * 1_000_000_000_000n;
    if (grossUnits < 2n * 10n ** 18n) throw new Error("掛單總額最低為 2 JC");

    if (input.side === "sell") {
      await approveEscrowUnits(assetToken, quantityUnits);
      await approveEscrowUnits(CONTRACT_ADDRESSES.jcToken, 10n ** 18n);
    } else {
      await approveEscrowUnits(CONTRACT_ADDRESSES.jcToken, grossUnits);
    }

    const clientOrderId = keccak256(toBytes(input.requestKey));
    const client = await escrowWalletClient();
    const hash = await client.writeContract({
      address: P2P_ESCROW_ADDRESS,
      abi: P2P_ESCROW_ABI,
      functionName: "createOrder",
      args: [
        clientOrderId,
        input.side === "sell",
        assetToken,
        CONTRACT_ADDRESSES.jcToken,
        priceUnits,
        quantityUnits,
      ],
    });
    await confirmEscrowTransaction(hash, "鏈上掛單已 reverted；資產未進入託管");
    return { txHash: hash, clientOrderId };
  }, [approveEscrowUnits, escrowWalletClient]);

  const fillEscrowOrder = useCallback(async (input: {
    orderId: string;
    orderSide: "buy" | "sell";
    assetToken: string;
    price: string;
    quantity: string;
    fillKey: string;
  }) => {
    if (!P2P_ESCROW_ADDRESS) throw new Error("二級市場託管合約尚未部署，暫時無法交易");
    const assetToken = normalizeAddress(input.assetToken);
    if (!assetToken) throw new Error("標的代幣地址無效");
    const priceUnits = parseUnits(input.price, 18);
    const quantityUnits = parseUnits(input.quantity, 18);
    const rawGross = (priceUnits * quantityUnits) / 10n ** 18n;
    const grossUnits = ((rawGross + 500_000_000_000n) / 1_000_000_000_000n) * 1_000_000_000_000n;
    if (grossUnits < 2n * 10n ** 18n) throw new Error("每次成交金額最低為 2 JC");
    if (input.orderSide === "sell") {
      await approveEscrowUnits(CONTRACT_ADDRESSES.jcToken, grossUnits);
    } else {
      await approveEscrowUnits(assetToken, quantityUnits);
    }
    const client = await escrowWalletClient();
    const hash = await client.writeContract({
      address: P2P_ESCROW_ADDRESS,
      abi: P2P_ESCROW_ABI,
      functionName: "fillOrder",
      args: [BigInt(input.orderId), quantityUnits, keccak256(toBytes(input.fillKey))],
    });
    await confirmEscrowTransaction(hash, "鏈上成交失敗；本筆資產未交割");
    return hash;
  }, [approveEscrowUnits, escrowWalletClient]);

  const cancelEscrowOrder = useCallback(async (orderId: string) => {
    if (!P2P_ESCROW_ADDRESS) throw new Error("二級市場託管合約尚未部署，暫時無法取消");
    const client = await escrowWalletClient();
    const hash = await client.writeContract({
      address: P2P_ESCROW_ADDRESS,
      abi: P2P_ESCROW_ABI,
      functionName: "cancelOrder",
      args: [BigInt(orderId)],
    });
    await confirmEscrowTransaction(hash, "鏈上取消失敗；託管資產仍保留在原掛單");
    return hash;
  }, [escrowWalletClient]);

  return {
    createEscrowOrder,
    fillEscrowOrder,
    cancelEscrowOrder,
    mintJcOnchain,
    settleVaultPurchase,
    ensureJcSpendable,
    settleRedemption,
    settleSubscription,
    walletReady: !!wallet,
  };
}
