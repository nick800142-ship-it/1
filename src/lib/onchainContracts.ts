import { useEffect, useState } from "react";
import {
  createPublicClient,
  formatUnits,
  http,
  type Address,
  type PublicClient,
} from "viem";
import { erc20Abi } from "viem";
import { CHAIN, CONTRACT_ADDRESSES, CONTRACT_ABIS, normalizeAddress } from "@/lib/contracts";

/**
 * 錢包餘額查詢使用 JC、AE 目前設定的代幣地址；RWA 份額只從目前 Factory 的
 * tokenByPlacement 查得，不讀取資料庫保存的舊代幣地址。
 */
export type ContractKey = keyof typeof CONTRACT_ADDRESSES;
type TokenKey = "aeToken" | "jcToken";

const RPC_URL = "https://sepolia.base.org";

let cachedClient: PublicClient | null = null;
function getClient(): PublicClient {
  if (!cachedClient) {
    cachedClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) }) as PublicClient;
  }
  return cachedClient;
}

const factoryTokenCache = new Map<string, { address: Address | null; expiresAt: number }>();
const factoryTokenRequests = new Map<string, Promise<Address | null>>();

export async function getCurrentRwaFactoryToken(placementId: string): Promise<Address | null> {
  const key = placementId.trim();
  if (!key) return null;
  const cached = factoryTokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.address;
  const pending = factoryTokenRequests.get(key);
  if (pending) return pending;

  const request = getClient()
    .readContract({
      address: CONTRACT_ADDRESSES.rwaFactory,
      abi: CONTRACT_ABIS.rwaFactory,
      functionName: "tokenByPlacement",
      args: [key],
    })
    .then((value) => {
      const address = normalizeAddress(value);
      const current = address && address !== "0x0000000000000000000000000000000000000000"
        ? address
        : null;
      factoryTokenCache.set(key, { address: current, expiresAt: Date.now() + 15_000 });
      return current;
    })
    .finally(() => factoryTokenRequests.delete(key));

  factoryTokenRequests.set(key, request);
  return request;
}

// ---------------------------------------------------------------------------
// 唯讀查詢
// ---------------------------------------------------------------------------

// JC 與 AE 代幣各自有 decimals()，快取起來避免每次查詢都重新讀取。
const decimalsCache = new Map<TokenKey, number>();
export async function fetchTokenDecimals(tokenKey: TokenKey): Promise<number> {
  const cached = decimalsCache.get(tokenKey);
  if (cached != null) return cached;
  // 讀取 decimals 失敗時，使用標準 ERC-20 常見的 18 位小數作為格式 fallback。
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

// 單次查詢某個地址在 JC 或 AE 代幣上的鏈上餘額。
export async function fetchTokenOnChainBalance(
  tokenKey: TokenKey,
  address: string | null | undefined,
): Promise<number> {
  const account = normalizeAddress(address);
  if (!account) return 0;
  // 讀取錯誤交由 hook 標記，避免把 RPC 失敗誤顯示成「鏈上餘額為 0」。
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
}

// 每 4 秒輪詢一個地址在 JC 或 AE 代幣上的鏈上餘額。
export function useTokenOnChainBalance(
  tokenKey: TokenKey,
  address: string | null | undefined,
  intervalMs = 4000,
) {
  const [balance, setBalance] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const account = normalizeAddress(address);

  useEffect(() => {
    if (!account) {
      setBalance(0);
      setError(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const next = await fetchTokenOnChainBalance(tokenKey, account);
        if (!cancelled) {
          setBalance(next);
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
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

  return { balance, loading, error };
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

// 一次輪詢「多個標的各自的鏈上餘額」，回傳 key -> 餘額 的對照表。entries 每筆
// 給定呼叫端自訂的 key（例如 assetId 或群組 id）與該標的的代幣合約地址；AE 標的
// 直接傳 CONTRACT_ADDRESSES.aeToken 即可（AE 為標準 ERC-20）。用於錢包頁「持倉份額」
// 改以鏈上 balanceOf 即時顯示，涵蓋站外（如金庫直接轉入）造成的份額變動。
export function useOnChainBalancesByKey(
  entries: { key: string; tokenAddress: string }[],
  address: string | null | undefined,
  intervalMs = 4000,
): { balances: Record<string, number>; loading: boolean } {
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  const account = normalizeAddress(address);
  // 以「key|tokenAddress」串接後當作 effect 依賴，避免每次 render 產生新陣列造成無限輪詢。
  const signature = entries
    .map((e) => `${e.key}|${normalizeAddress(e.tokenAddress) ?? ""}`)
    .filter((s) => !s.endsWith("|"))
    .sort()
    .join(",");

  useEffect(() => {
    const pairs = signature
      ? signature.split(",").map((s) => {
          const [key, tokenAddress] = s.split("|");
          return { key, tokenAddress };
        })
      : [];
    if (!account || pairs.length === 0) {
      setBalances({});
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const results = await Promise.all(
          pairs.map(async (p) => [p.key, await fetchErc20BalanceByAddress(p.tokenAddress, account)] as const),
        );
        if (!cancelled) setBalances(Object.fromEntries(results));
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
  }, [signature, account, intervalMs]);

  return { balances, loading };
}

// ---------------------------------------------------------------------------
// 簽署交易（Privy 內嵌錢包）
// ---------------------------------------------------------------------------
//
// 平台採「後端代付 Gas（Backend-driven）」架構：所有需要送出合約交易的動作
// （認購 executeSubscription、二級成交 executeTrade、發幣 mint、份額交割 transfer）
// 一律由後端營運熱錢包（ADMIN）在 api/relayer.ts 內以 ADMIN_PRIVATE_KEY 簽署送出，
// Gas 由平台支付。前端只負責打 API 請求（見 src/lib/onchainSettlement.ts 的
// callRelayer / useOnchainSettlement），絕不讓使用者錢包直接呼叫合約。
//
// 因此這裡刻意「不」提供任何讓使用者錢包 writeContract 送合約交易的 hook。
// 唯一保留在前端、由使用者本人錢包簽名的動作是：
//   1. ERC-20 approve（授權 ADMIN 動用使用者自己的份額代幣，二級賣方掛單用）——
//      見 onchainSettlement.ts 的 ensureAllowance。這是 ERC-20 標準規定第三方
//      動用他人代幣前必須取得的授權，屬於使用者對「自我保管」資產的安全動作。
//   2. USDT 自我保管轉帳（金庫入金／提領）——見 onchainUsdt.ts，使用者搬動自己的
//      USDT，本就不該由後端代簽。
// 兩者都不是「呼叫 RWAFactory／市場合約送交易」，符合 backend-driven 原則。
