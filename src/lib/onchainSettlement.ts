import { useCallback, useRef } from "react";
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
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { CHAIN, CHAIN_ID, CONTRACT_ADDRESSES, ERC20_ABI, P2P_ESCROW_ABI, P2P_ESCROW_ADDRESS, isKnownP2PEscrow, normalizeAddress } from "@/lib/contracts";
import { supabase } from "@/lib/supabase";
import { NETWORK_RPC_URL } from "@/lib/network";

// 前端串接後端 relayer（合約 owner）的薄封裝。
//
// 分工：
//  - 需要「使用者本人簽名」的動作（approve 授權自己的代幣）留在前端錢包。
//  - 需要「合約 owner 簽名」的動作（mint / executeSubscription / executeTrade）
//    一律送到 /api/relayer，由後端用 owner 私鑰代發。
//
// 所有鏈上結算都是「盡力而為」的鏡像：失敗只回傳錯誤訊息供 UI 附註，永遠不
// 回退已成功的站內（Supabase 帳本）結果。

const RPC_URL = NETWORK_RPC_URL;
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
  | "admin-preflight"
  | "mint-jc"
  | "settle-vault-buy"
  | "settlement-status"
  | "subscribe"
  | "redeem-jc"
  | "sync-holding"
  | "sync-jc-balance"
  | "sponsor-gas"
  | "wire-contracts"
  | "relayer-address"
  | "admin-list-settlements"
  | "admin-retry-settlement"
  | "admin-verify-pay-commission"
  | "admin-price-change-notification"
  | "bonus-sold-out-notification"
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
  | "admin-retry-escrow-event"
  | "admin-p2p-fees"
  | "admin-set-p2p-fees"
  | "safe-status"
  | "safe-handoff"
  | "safe-propose-owners"
  | "safe-migrate-preview"
  | "safe-propose-migration"
  | "safe-propose-accept"
  | "safe-sign"
  | "safe-execute"
  | "safe-refresh"
  | "safe-resync"
  | "safe-cancel";

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
  // Read text before parsing so an SPA fallback or deployment-protection page is reported
  // as an API routing issue instead of a generic JSON failure.
  const raw = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
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

async function callSettlementWithStatusFallback(
  action: "settle-vault-buy" | "subscribe" | "redeem-jc",
  params: Record<string, unknown>,
  statusParams: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    return await callRelayer(action, params);
  } catch (settleError) {
    try {
      return await callRelayer("settlement-status", statusParams);
    } catch {
      throw settleError;
    }
  }
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

// 對帳只使用目前新 JC 合約、登入者 profile 綁定錢包的鏈上 balanceOf；後端以服務端
// transaction 原子調整 jc_ledger，讓歷史舊合約餘額不再影響資料庫的可用額檢查。
export async function syncJcBalanceFromChain(): Promise<void> {
  await callRelayer("sync-jc-balance", {});
}

// 由後端從目前新合約讀取登入者的餘額並同步可用持倉，涵蓋熱錢包直接轉入的 AE/RWA。
// RWA 地址由現行 Factory 查得；JC 另以同步 action 對帳新合約 balanceOf 與 jc_ledger。
export async function syncHoldingFromChain(
  placementId: string,
): Promise<{
  synced: boolean;
  chainVerified: boolean;
  to?: number;
  available?: number;
  error?: string;
}> {
  try {
    const res = await callRelayer("sync-holding", { placementId });
    return {
      synced: Boolean(res.synced),
      chainVerified: Boolean(res.chainVerified),
      to: typeof res.to === "number" ? res.to : undefined,
      available: typeof res.available === "number" ? res.available : undefined,
    };
  } catch (error) {
    return {
      synced: false,
      chainVerified: false,
      error: error instanceof Error ? error.message : "無法確認新合約鏈上餘額",
    };
  }
}

  // 金庫買 JC 與一級認購先建立預留；鏈上交易收據全數確認後才正式寫帳本。
  // 登入時會補跑未完成的預留；二級市場由 P2PEscrow 託管，不走舊 relayer trade/list-fee。
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
    try {
      await syncJcBalanceFromChain();
    } catch {
      // Money-moving actions retry this sync and fail closed if the current chain balance cannot be verified.
    }
    const { data: settledRows } = await supabase
      .from("onchain_settlements")
      .select("ref_key")
      .in("action", ["mint_jc", "subscribe"])
      .eq("status", "confirmed");
    const confirmed = new Set((settledRows ?? []).map((r) => (r as { ref_key: string }).ref_key));

    let retried = 0;
    let fixed = 0;
    const { data: reservationRows, error: reservationReadError } = await supabase
      .from("settlement_reservations")
      .select("request_key,action,status,source_tx_hash,chain_payload");
    if (reservationReadError) return { retried: 0, fixed: 0 };
    const reservations = reservationRows ?? [];
    const reservationActionByRequestKey = new Map(
      reservations.map((reservation) => [reservation.request_key, reservation.action]),
    );
    for (const reservation of reservations) {
      if (reservation.status !== "pending") continue;
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
      const reservationAction = source.entryType === "vault_buy" ? "vault_buy" : "subscribe";
      const pending = rows.filter((row) => {
        const requestKey = source.deriveRequestKey(row.idempotency_key ?? "");
        const reservationBacksLedger = requestKey && reservationActionByRequestKey.get(requestKey) === reservationAction;
        // 舊版結算以帳本列 id 當 ref_key，新版用 request key；兩種都算已確認，避免登入時重送已完成的舊單。
        const alreadyConfirmed = confirmed.has(`${source.settlementAction}:${requestKey}`)
          || confirmed.has(`${source.settlementAction}:${row.id}`);
        return !alreadyConfirmed && !reservationBacksLedger;
      });
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
  const { ready: privyReady, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0] ?? null;
  const walletRef = useRef(wallet);
  const authStateRef = useRef({ ready: privyReady, authenticated });
  walletRef.current = wallet;
  authStateRef.current = { ready: privyReady, authenticated };

  const openPrivyLogin = useCallback(() => login(), [login]);

  const requireWallet = useCallback(async () => {
    const startedAt = Date.now();
    const deadline = startedAt + 12_000;
    while (Date.now() < deadline) {
      const authState = authStateRef.current;
      const current = walletRef.current;
      if (authState.ready && authState.authenticated && current) return current;
      if (authState.ready && !authState.authenticated && Date.now() - startedAt >= 3_000) {
        throw new Error("Privy 目前沒有登入中的錢包。請先按登入／註冊完成 Privy 登入，再重試此操作；不需要重新整理頁面。");
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    const authState = authStateRef.current;
    if (!authState.ready) {
      throw new Error("Privy 初始化逾時，請稍候片刻後重試；不需要重新登入。");
    }
    if (!authState.authenticated) {
      throw new Error("Privy 目前沒有登入中的錢包。請先按登入／註冊完成 Privy 登入，再重試此操作。");
    }
    throw new Error("Privy 錢包載入逾時，請稍候後重試；不需要重新登入。");
  }, []);

  // 優先重用鏈上仍有效的額度；不足時才要求使用者簽署本筆精確額度，絕不授予 ADMIN 無上限額度。
  const ensureAllowanceForToken = useCallback(
    async (
      tokenAddress: Address,
      abi: typeof ERC20_ABI,
      spender: Address,
      amount: number,
    ): Promise<`0x${string}` | null> => {
      const signer = await requireWallet();
      const owner = normalizeAddress(signer.address);
      if (!owner) throw new Error("錢包地址無效");
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("授權金額無效");
      const decimals = (await getClient().readContract({
        address: tokenAddress,
        abi,
        functionName: "decimals",
      })) as number;
      const amountUnits = parseUnits(amount.toFixed(decimals), decimals);
      if (amountUnits <= 0n) throw new Error("授權金額必須大於 0");
      const existingAllowance = (await getClient().readContract({
        address: tokenAddress,
        abi,
        functionName: "allowance",
        args: [owner, spender],
      })) as bigint;
      if (existingAllowance >= amountUnits) return null;

      await sponsorGasBestEffort();
      await signer.switchChain(CHAIN_ID);
      const provider = (await signer.getEthereumProvider()) as EIP1193Provider;
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
    [requireWallet],
  );

  const ensureAllowance = useCallback(
    async (tokenKey: TokenKey, spender: Address, amount: number): Promise<void> => {
      await ensureAllowanceForToken(CONTRACT_ADDRESSES[tokenKey], ERC20_ABI, spender, amount);
    },
    [ensureAllowanceForToken],
  );

  // 使用者轉出 USDT 後，後端先驗收鏈上 Transfer 收據，再發 JC 並原子寫正式帳本。
  const settleVaultPurchase = useCallback(async (requestKey: string, txHash: string) => {
    return callSettlementWithStatusFallback(
      "settle-vault-buy",
      { requestKey, txHash },
      { requestKey },
    );
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

  // 使用者可花用的 JC 門檻檢查（在建立認購預留前呼叫）：鏈上餘額需足額；
  // allowance 不足時只授權本次 gross，已足額授權則不再彈簽名。分潤 JC 只記帳、
  // 尚未上鏈，故鏈上餘額可能小於站內可用 JC，此時不允許認購／交易。
  const ensureJcSpendable = useCallback(
    async (gross: number): Promise<void> => {
      const signer = await requireWallet();
      const owner = normalizeAddress(signer.address);
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
    [requireWallet, getRelayerAddress, ensureAllowance],
  );

  // 使用者完成逐筆 JC approve 後，才呼叫 relayer 執行贖回。
  const settleRedemption = useCallback(async (orderId: string) => {
    return callSettlementWithStatusFallback(
      "redeem-jc",
      { orderId },
      { orderId },
    );
  }, []);

  // 認購頁面在扣站內帳本前已請用戶對本筆 JC 金額簽署 approve；此處僅執行鏈上結算。
  const settleSubscription = useCallback(async (requestKey: string) => {
    return callSettlementWithStatusFallback(
      "subscribe",
      { requestKey },
      { requestKey },
    );
  }, []);

  const ensureWalletReady = useCallback(async () => {
    await requireWallet();
  }, [requireWallet]);

  // Escrow actions are signed by the connected user; the ADMIN wallet never moves order assets.
  const escrowWalletClient = useCallback(async () => {
    const signer = await requireWallet();
    const owner = normalizeAddress(signer.address);
    if (!owner) throw new Error("錢包地址無效");
    await sponsorGasBestEffort();
    await signer.switchChain(CHAIN_ID);
    const provider = (await signer.getEthereumProvider()) as EIP1193Provider;
    return createWalletClient({ account: owner, chain: CHAIN, transport: custom(provider) });
  }, [requireWallet]);

  const approveEscrowUnits = useCallback(async (tokenAddress: Address, amountUnits: bigint, escrow: Address = P2P_ESCROW_ADDRESS) => {
    const signer = await requireWallet();
    if (amountUnits <= 0n) throw new Error("授權金額無效");
    const owner = normalizeAddress(signer.address);
    if (!owner) throw new Error("錢包地址無效");
    const [decimals, balance] = await Promise.all([
      getClient().readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "decimals" }),
      getClient().readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }),
    ]);
    if (decimals !== 18) throw new Error("此標的代幣目前必須使用 18 位精度才能進入託管");
    if (balance < amountUnits) throw new Error("鏈上代幣餘額不足以完成此託管操作");
    if (!isKnownP2PEscrow(escrow)) throw new Error("二級市場託管合約地址無效，暫時無法交易");
    const client = await escrowWalletClient();
    const hash = await client.writeContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [escrow, amountUnits],
    });
    const receipt = await getClient().waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("代幣授權交易失敗");
  }, [requireWallet, escrowWalletClient]);

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
      const listingFeeUnits = await getClient().readContract({
        address: P2P_ESCROW_ADDRESS,
        abi: P2P_ESCROW_ABI,
        functionName: "listingFee",
      });
      if (listingFeeUnits > 0n) await approveEscrowUnits(CONTRACT_ADDRESSES.jcToken, listingFeeUnits);
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
    escrowContractAddress?: string | null;
  }) => {
    const escrow = normalizeAddress(input.escrowContractAddress ?? P2P_ESCROW_ADDRESS);
    if (!escrow || !isKnownP2PEscrow(escrow)) throw new Error("此掛單的託管合約地址無效，無法安全成交");
    const assetToken = normalizeAddress(input.assetToken);
    if (!assetToken) throw new Error("標的代幣地址無效");
    const priceUnits = parseUnits(input.price, 18);
    const quantityUnits = parseUnits(input.quantity, 18);
    const rawGross = (priceUnits * quantityUnits) / 10n ** 18n;
    const grossUnits = ((rawGross + 500_000_000_000n) / 1_000_000_000_000n) * 1_000_000_000_000n;
    if (grossUnits < 2n * 10n ** 18n) throw new Error("每次成交金額最低為 2 JC");
    if (input.orderSide === "sell") {
      await approveEscrowUnits(CONTRACT_ADDRESSES.jcToken, grossUnits, escrow);
    } else {
      await approveEscrowUnits(assetToken, quantityUnits, escrow);
    }
    const client = await escrowWalletClient();
    const hash = await client.writeContract({
      address: escrow,
      abi: P2P_ESCROW_ABI,
      functionName: "fillOrder",
      args: [BigInt(input.orderId), quantityUnits, keccak256(toBytes(input.fillKey))],
    });
    await confirmEscrowTransaction(hash, "鏈上成交失敗；本筆資產未交割");
    return hash;
  }, [approveEscrowUnits, escrowWalletClient]);

  const cancelEscrowOrder = useCallback(async (orderId: string, escrowContractAddress: string) => {
    const address = normalizeAddress(escrowContractAddress);
    if (!address) throw new Error("掛單缺少有效的託管合約地址，無法安全取消");
    const client = await escrowWalletClient();
    try {
      await getClient().simulateContract({
        address,
        abi: P2P_ESCROW_ABI,
        functionName: "cancelOrder",
        args: [BigInt(orderId)],
        account: client.account,
      });
    } catch (error) {
      const reason = error instanceof Error && "shortMessage" in error
        ? String((error as { shortMessage?: string }).shortMessage)
        : error instanceof Error ? error.message : "未知原因";
      throw new Error(`鏈上合約拒絕取消此掛單（可能已成交或已取消，請重新整理）：${reason}`);
    }
    const hash = await client.writeContract({
      address,
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
    ensureWalletReady,
    openPrivyLogin,
    walletReady: Boolean(wallet && privyReady && authenticated),
  };
}
