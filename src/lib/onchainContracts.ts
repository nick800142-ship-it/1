import { useCallback, useEffect, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type EIP1193Provider,
  type PublicClient,
} from "viem";
import { erc20Abi } from "viem";
import { useWallets } from "@privy-io/react-auth";
import { CHAIN, CHAIN_ID, CONTRACT_ADDRESSES, CONTRACT_ABIS, normalizeAddress } from "@/lib/contracts";

/**
 * 六個自訂合約（RWA 母合約、AE 代幣、JC 結算代幣、RWA 一級認購、RWA 二級市場、
 * AE 二級市場）的讀取／簽署呼叫。地址與 ABI 一律從 @/lib/contracts 取得。
 *
 * 命名對應 CONTRACT_ADDRESSES / CONTRACT_ABIS 的 key：
 * "rwaMaster" | "aeToken" | "jcToken" | "rwaPrimarySale" | "rwaSecondaryMarket" | "aeSecondaryMarket"
 */
export type ContractKey = keyof typeof CONTRACT_ADDRESSES;
type TokenKey = "rwaMaster" | "aeToken" | "jcToken";

const RPC_URL = "https://sepolia.base.org";

let cachedClient: PublicClient | null = null;
function getClient(): PublicClient {
  if (!cachedClient) {
    cachedClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) }) as PublicClient;
  }
  return cachedClient;
}

// ---------------------------------------------------------------------------
// 唯讀查詢
// ---------------------------------------------------------------------------

// 三個代幣合約（RWA 母合約 / AE 代幣 / JC 結算代幣）都各自有 decimals()，快取
// 起來避免每次交易都重新查詢。
const decimalsCache = new Map<TokenKey, number>();
export async function fetchTokenDecimals(tokenKey: TokenKey): Promise<number> {
  const cached = decimalsCache.get(tokenKey);
  if (cached != null) return cached;
  // 用 try/catch 包住並在失敗時退回 18：目前部署的 RWA 母合約（rwaMaster，鑄造工廠）
  // 是一顆 Factory 而非可正常運作的 ERC-20，它的 decimals()/name()/symbol()/balanceOf()
  // 在鏈上都會 revert（已實測）。若不吞掉這個 revert，錢包頁每 4 秒輪詢 RWA 餘額時
  // 就會不斷丟「The contract function "decimals" reverted」並上報到告警頻道。
  // 這裡與後端 _onchain.ts 的 tokenDecimals 一致，預設 18 decimals。
  let value = 18;
  try {
    value = Number(
      await getClient().readContract({
        address: CONTRACT_ADDRESSES[tokenKey],
        abi: CONTRACT_ABIS[tokenKey],
        functionName: "decimals",
      }),
    );
  } catch {
    value = 18;
  }
  decimalsCache.set(tokenKey, value);
  return value;
}

// 單次查詢某個地址在 RWA 母合約／AE 代幣／JC 結算代幣的鏈上真實餘額。
export async function fetchTokenOnChainBalance(
  tokenKey: TokenKey,
  address: string | null | undefined,
): Promise<number> {
  const account = normalizeAddress(address);
  if (!account) return 0;
  // 同 fetchTokenDecimals：RWA 母合約（Factory）的 balanceOf() 也會 revert，錢包頁
  // 每 4 秒輪詢時不該因此丟錯並上報告警。讀取失敗時回傳 0（顯示為無餘額），而非拋出。
  try {
    const [raw, decimals] = await Promise.all([
      getClient().readContract({
        address: CONTRACT_ADDRESSES[tokenKey],
        abi: CONTRACT_ABIS[tokenKey],
        functionName: "balanceOf",
        args: [account],
      }),
      fetchTokenDecimals(tokenKey),
    ]);
    return Number(formatUnits(raw as bigint, decimals));
  } catch {
    return 0;
  }
}

// 每 4 秒輪詢一個地址在指定代幣合約的鏈上餘額（RWA 母合約 / AE 代幣 / JC 結算代幣）。
export function useTokenOnChainBalance(
  tokenKey: TokenKey,
  address: string | null | undefined,
  intervalMs = 4000,
) {
  const [balance, setBalance] = useState(0);
  const [loading, setLoading] = useState(true);

  const account = normalizeAddress(address);
  useEffect(() => {
    if (!account) {
      setBalance(0);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const next = await fetchTokenOnChainBalance(tokenKey, account);
        if (!cancelled) setBalance(next);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    setLoading(true);
    void load();
    const timer = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tokenKey, account, intervalMs]);

  return { balance, loading };
}

// 以「任意 ERC-20 合約地址」讀取某個錢包的鏈上真實餘額（標準 balanceOf/decimals）。
// 用於 RWA Factory 模式下每個標的各有一顆專屬代幣：清單不固定，需以動態地址查詢。
// 讀取失敗（地址非有效 ERC-20、或合約 revert）時回傳 0，不拋出、不上報告警。
export async function fetchErc20BalanceByAddress(
  tokenAddress: string | null | undefined,
  address: string | null | undefined,
): Promise<number> {
  const token = normalizeAddress(tokenAddress);
  const account = normalizeAddress(address);
  if (!token || !account) return 0;
  try {
    const [raw, decimals] = await Promise.all([
      getClient().readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
      getClient()
        .readContract({ address: token, abi: erc20Abi, functionName: "decimals" })
        .then((d) => Number(d))
        .catch(() => 18),
    ]);
    return Number(formatUnits(raw as bigint, decimals));
  } catch {
    return 0;
  }
}

// 每 intervalMs 輪詢一組 ERC-20 代幣地址在某錢包的鏈上餘額加總（例如 RWA
// Factory 下多顆標的專屬代幣的總持有量）。tokenAddresses 以逗號串接後當作
// effect 依賴，避免每次 render 產生新陣列造成無限輪詢。
export function useErc20BalancesSum(
  tokenAddresses: string[],
  address: string | null | undefined,
  intervalMs = 4000,
) {
  const [balance, setBalance] = useState(0);
  const [loading, setLoading] = useState(true);

  const account = normalizeAddress(address);
  const key = tokenAddresses
    .map((t) => normalizeAddress(t))
    .filter((t): t is Address => Boolean(t))
    .join(",");

  useEffect(() => {
    const tokens = key ? key.split(",") : [];
    if (!account || tokens.length === 0) {
      setBalance(0);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const parts = await Promise.all(tokens.map((t) => fetchErc20BalanceByAddress(t, account)));
        if (!cancelled) setBalance(parts.reduce((sum, n) => sum + n, 0));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    setLoading(true);
    void load();
    const timer = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key, account, intervalMs]);

  return { balance, loading };
}

// 讀取自訂合約目前設定的關聯地址／參數（診斷用途：確認 ABI 與部署狀態一致）。
export async function fetchRwaPrimarySaleConfig() {
  const address = CONTRACT_ADDRESSES.rwaPrimarySale;
  const abi = CONTRACT_ABIS.rwaPrimarySale;
  const [rwaToken, paymentToken, safeVault, owner] = await Promise.all([
    getClient().readContract({ address, abi, functionName: "rwaToken" }),
    getClient().readContract({ address, abi, functionName: "paymentToken" }),
    getClient().readContract({ address, abi, functionName: "safeVault" }),
    getClient().readContract({ address, abi, functionName: "owner" }),
  ]);
  return { rwaToken, paymentToken, safeVault, owner } as {
    rwaToken: Address;
    paymentToken: Address;
    safeVault: Address;
    owner: Address;
  };
}

export async function fetchRwaSecondaryMarketConfig() {
  const address = CONTRACT_ADDRESSES.rwaSecondaryMarket;
  const abi = CONTRACT_ABIS.rwaSecondaryMarket;
  const [rwaToken, settlementToken, feeRecipient, owner] = await Promise.all([
    getClient().readContract({ address, abi, functionName: "rwaToken" }),
    getClient().readContract({ address, abi, functionName: "settlementToken" }),
    getClient().readContract({ address, abi, functionName: "feeRecipient" }),
    getClient().readContract({ address, abi, functionName: "owner" }),
  ]);
  return { rwaToken, settlementToken, feeRecipient, owner } as {
    rwaToken: Address;
    settlementToken: Address;
    feeRecipient: Address;
    owner: Address;
  };
}

export async function fetchAeSecondaryMarketConfig() {
  const address = CONTRACT_ADDRESSES.aeSecondaryMarket;
  const abi = CONTRACT_ABIS.aeSecondaryMarket;
  const [aeToken, defaultCurrency, safeVault, feePercent, fixedFee, minTradeTotal, owner] =
    await Promise.all([
      getClient().readContract({ address, abi, functionName: "aeToken" }),
      getClient().readContract({ address, abi, functionName: "defaultCurrency" }),
      getClient().readContract({ address, abi, functionName: "safeVault" }),
      getClient().readContract({ address, abi, functionName: "FEE_PERCENT" }),
      getClient().readContract({ address, abi, functionName: "FIXED_FEE" }),
      getClient().readContract({ address, abi, functionName: "MIN_TRADE_TOTAL" }),
      getClient().readContract({ address, abi, functionName: "owner" }),
    ]);
  return {
    aeToken,
    defaultCurrency,
    safeVault,
    feePercent,
    fixedFee,
    minTradeTotal,
    owner,
  } as {
    aeToken: Address;
    defaultCurrency: Address;
    safeVault: Address;
    feePercent: bigint;
    fixedFee: bigint;
    minTradeTotal: bigint;
    owner: Address;
  };
}

// ---------------------------------------------------------------------------
// 簽署交易（Privy 內嵌錢包）
// ---------------------------------------------------------------------------

function useConnectedWallet() {
  const { wallets } = useWallets();
  return wallets.find((w) => w.walletClientType === "privy") ?? wallets[0] ?? null;
}

async function getWalletClient(wallet: NonNullable<ReturnType<typeof useConnectedWallet>>) {
  const account = normalizeAddress(wallet.address);
  if (!account) throw new Error("錢包地址無效");
  await wallet.switchChain(CHAIN_ID);
  const provider = (await wallet.getEthereumProvider()) as EIP1193Provider;
  return createWalletClient({
    account,
    chain: CHAIN,
    transport: custom(provider),
  });
}

// 對 RWA 母合約／AE 代幣／JC 結算代幣三者之一核准（approve）某個合約地址可
// 動用指定數量。任何持有代幣的錢包都能呼叫，屬於安全、無爭議的動作。
export function useApproveToken() {
  const wallet = useConnectedWallet();
  const [approving, setApproving] = useState(false);

  const approve = useCallback(
    async (tokenKey: TokenKey, spender: Address, amount: number): Promise<`0x${string}`> => {
      if (!wallet) throw new Error("找不到可用的錢包，請重新登入");
      const spenderAddr = normalizeAddress(spender);
      if (!spenderAddr) throw new Error("授權對象地址無效");
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("授權金額無效");
      setApproving(true);
      try {
        const decimals = await fetchTokenDecimals(tokenKey);
        const walletClient = await getWalletClient(wallet);
        const amountUnits = parseUnits(amount.toFixed(decimals), decimals);
        const hash = await walletClient.writeContract({
          address: CONTRACT_ADDRESSES[tokenKey],
          abi: CONTRACT_ABIS[tokenKey],
          functionName: "approve",
          args: [spenderAddr, amountUnits],
        });
        await getClient().waitForTransactionReceipt({ hash });
        return hash;
      } finally {
        setApproving(false);
      }
    },
    [wallet],
  );

  return { approve, approving };
}

// RWA 私募認購的完整鏈上結算：
// 1) approve rwaPrimarySale 動用 totalPaymentJc 數量的 JC（實際付款代幣以合約
//    當下設定的 paymentToken() 為準，避免地址寫死錯誤）。
// 2) 呼叫 executeSubscription(buyer, rwaAmount, totalPayment)，由合約把價款
//    轉入 Safe 金庫、並鑄發 RWA 母代幣給買方。
// 回傳兩筆交易的 hash，供呼叫端記錄／顯示。這是買方用自己的錢包發起、單方
// 動作（不涉及第三方地址），可以安全地在前端直接串接。
export function useExecuteRwaSubscription() {
  const wallet = useConnectedWallet();
  const [submitting, setSubmitting] = useState(false);

  const subscribe = useCallback(
    async (rwaShareUnits: number, totalPaymentJc: number) => {
      if (!wallet) throw new Error("找不到可用的錢包，請重新登入");
      const buyer = normalizeAddress(wallet.address);
      if (!buyer) throw new Error("錢包地址無效");
      if (!Number.isSafeInteger(rwaShareUnits) || rwaShareUnits <= 0) throw new Error("份額無效");
      if (!Number.isFinite(totalPaymentJc) || totalPaymentJc <= 0) throw new Error("金額無效");

      setSubmitting(true);
      try {
        const [{ paymentToken }, rwaDecimals] = await Promise.all([
          fetchRwaPrimarySaleConfig(),
          fetchTokenDecimals("rwaMaster"),
        ]);
        const paymentTokenKey: TokenKey = "jcToken"; // JC 結算代幣；paymentToken() 讀值僅供核對稽核用途
        const paymentDecimals = await fetchTokenDecimals(paymentTokenKey);
        const walletClient = await getWalletClient(wallet);

        const paymentUnits = parseUnits(totalPaymentJc.toFixed(paymentDecimals), paymentDecimals);
        const approveHash = await walletClient.writeContract({
          address: paymentToken,
          abi: CONTRACT_ABIS[paymentTokenKey],
          functionName: "approve",
          args: [CONTRACT_ADDRESSES.rwaPrimarySale, paymentUnits],
        });
        await getClient().waitForTransactionReceipt({ hash: approveHash });

        const rwaAmountUnits = parseUnits(String(rwaShareUnits), rwaDecimals);
        const subscribeHash = await walletClient.writeContract({
          address: CONTRACT_ADDRESSES.rwaPrimarySale,
          abi: CONTRACT_ABIS.rwaPrimarySale,
          functionName: "executeSubscription",
          args: [buyer, rwaAmountUnits, paymentUnits],
        });
        await getClient().waitForTransactionReceipt({ hash: subscribeHash });
        return { approveHash, subscribeHash };
      } finally {
        setSubmitting(false);
      }
    },
    [wallet],
  );

  return { subscribe, submitting };
}

// RWA 二級市場撮合結算：executeTrade(seller, buyer, rwaAmount, paymentAmount)。
// 注意：這是「雙方交易」，需要 seller 事先核准 rwaSecondaryMarket 動用其 RWA
// 母代幣、buyer 事先核准動用其 JC，且合約若限制只有 owner/relayer 才能呼叫
// executeTrade，一般用戶錢包呼叫會 revert。目前平台的 P2P 掛單簿（Supabase
// create_p2p_order / fill_p2p_order）不會把對手方的錢包地址回傳給前端（避免
// 洩漏其他用戶身分），因此無法在瀏覽器端組出雙方地址呼叫這個函式——這裡先把
// 呼叫本身「接好」備用，尚未接進二級市場頁面的實際成交流程。
export function useExecuteRwaSecondaryTrade() {
  const wallet = useConnectedWallet();
  const [submitting, setSubmitting] = useState(false);

  const executeTrade = useCallback(
    async (seller: Address, buyer: Address, rwaShareUnits: number, paymentJc: number) => {
      if (!wallet) throw new Error("找不到可用的錢包，請重新登入");
      const sellerAddr = normalizeAddress(seller);
      const buyerAddr = normalizeAddress(buyer);
      if (!sellerAddr || !buyerAddr) throw new Error("買賣雙方地址無效");
      setSubmitting(true);
      try {
        const [rwaDecimals, jcDecimals] = await Promise.all([
          fetchTokenDecimals("rwaMaster"),
          fetchTokenDecimals("jcToken"),
        ]);
        const walletClient = await getWalletClient(wallet);
        const rwaAmountUnits = parseUnits(String(rwaShareUnits), rwaDecimals);
        const paymentUnits = parseUnits(paymentJc.toFixed(jcDecimals), jcDecimals);
        const hash = await walletClient.writeContract({
          address: CONTRACT_ADDRESSES.rwaSecondaryMarket,
          abi: CONTRACT_ABIS.rwaSecondaryMarket,
          functionName: "executeTrade",
          args: [sellerAddr, buyerAddr, rwaAmountUnits, paymentUnits],
        });
        await getClient().waitForTransactionReceipt({ hash });
        return hash;
      } finally {
        setSubmitting(false);
      }
    },
    [wallet],
  );

  return { executeTrade, submitting };
}

// AE 二級市場撮合結算：executeTrade(currencyToken, seller, buyer, aeAmount,
// totalPayment)。與上面 RWA 版本相同的雙方交易 + relayer 權限限制考量，先把
// 呼叫本身接好備用。
export function useExecuteAeSecondaryTrade() {
  const wallet = useConnectedWallet();
  const [submitting, setSubmitting] = useState(false);

  const executeTrade = useCallback(
    async (
      currencyToken: Address,
      seller: Address,
      buyer: Address,
      aeShareUnits: number,
      totalPayment: number,
    ) => {
      if (!wallet) throw new Error("找不到可用的錢包，請重新登入");
      const currencyAddr = normalizeAddress(currencyToken);
      const sellerAddr = normalizeAddress(seller);
      const buyerAddr = normalizeAddress(buyer);
      if (!currencyAddr || !sellerAddr || !buyerAddr) throw new Error("交易地址無效");
      setSubmitting(true);
      try {
        const [aeDecimals, currencyDecimals] = await Promise.all([
          fetchTokenDecimals("aeToken"),
          fetchTokenDecimals("jcToken"),
        ]);
        const walletClient = await getWalletClient(wallet);
        const aeAmountUnits = parseUnits(String(aeShareUnits), aeDecimals);
        const paymentUnits = parseUnits(totalPayment.toFixed(currencyDecimals), currencyDecimals);
        const hash = await walletClient.writeContract({
          address: CONTRACT_ADDRESSES.aeSecondaryMarket,
          abi: CONTRACT_ABIS.aeSecondaryMarket,
          functionName: "executeTrade",
          args: [currencyAddr, sellerAddr, buyerAddr, aeAmountUnits, paymentUnits],
        });
        await getClient().waitForTransactionReceipt({ hash });
        return hash;
      } finally {
        setSubmitting(false);
      }
    },
    [wallet],
  );

  return { executeTrade, submitting };
}
