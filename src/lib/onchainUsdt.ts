import { useEffect, useRef, useState } from "react";
import { createPublicClient, formatUnits, http, type Address, type PublicClient } from "viem";
import { baseSepolia } from "viem/chains";

// Base Sepolia 測試網上的自訂 USDT 測試代幣。前端「極簡模式」：不做 approve / 充值
// 流程，只直接讀取用戶錢包在鏈上的真實 balanceOf 作為「可用 USDT 餘額」。
export const USDT_CHAIN_ID = 84532;
export const USDT_TOKEN_ADDRESS = "0x1d6E0eC7ef658758A5b3Dc518422E302A5436B85" as const;
export const USDT_DECIMALS = 6;
const RPC_URL = "https://sepolia.base.org";

const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

let cachedClient: PublicClient | null = null;
function getClient(): PublicClient {
  if (!cachedClient) {
    cachedClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) }) as PublicClient;
  }
  return cachedClient;
}

const isValidAddress = (address: string | null | undefined): address is Address =>
  !!address && /^0x[a-fA-F0-9]{40}$/.test(address);

// 單次查詢：在「下單/投資」按鈕點擊當下，重新讀取最新鏈上餘額做判斷，
// 不依賴輪詢的舊值。
export async function fetchOnChainUsdtBalance(address: string | null | undefined): Promise<number> {
  if (!isValidAddress(address)) return 0;
  const raw = await getClient().readContract({
    address: USDT_TOKEN_ADDRESS,
    abi: BALANCE_OF_ABI,
    functionName: "balanceOf",
    args: [address],
  });
  return Number(formatUnits(raw as bigint, USDT_DECIMALS));
}

// 批次查詢多個地址的鏈上 USDT 餘額（用 multicall 一次打包，供後台用戶列表使用）。
// key 統一轉小寫，方便呼叫端用原始地址字串查找。
export async function fetchOnChainUsdtBalances(
  addresses: (string | null | undefined)[],
): Promise<Record<string, number>> {
  const valid = Array.from(
    new Set(addresses.filter(isValidAddress).map((address) => address.toLowerCase())),
  ) as Address[];
  if (valid.length === 0) return {};
  const results = await getClient().multicall({
    contracts: valid.map((address) => ({
      address: USDT_TOKEN_ADDRESS,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [address],
    })),
  });
  const balances: Record<string, number> = {};
  valid.forEach((address, index) => {
    const result = results[index];
    balances[address] =
      result.status === "success" ? Number(formatUnits(result.result as bigint, USDT_DECIMALS)) : 0;
  });
  return balances;
}

// 後台用戶列表：每 4 秒輪詢一批錢包地址的鏈上 USDT 餘額。
export function useOnChainUsdtBalances(
  addresses: (string | null | undefined)[],
  intervalMs = 4000,
) {
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const key = addresses
    .filter(isValidAddress)
    .map((address) => address.toLowerCase())
    .sort()
    .join(",");

  useEffect(() => {
    if (!key) {
      setBalances({});
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const next = await fetchOnChainUsdtBalances(key.split(","));
        if (!cancelled) setBalances(next);
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
  }, [key, intervalMs]);

  return {
    balances,
    loading,
    balanceOf: (address: string | null | undefined) =>
      isValidAddress(address) ? balances[address.toLowerCase()] ?? 0 : 0,
  };
}

// 每 4 秒輪詢鏈上 USDT 餘額，讓用戶從外部錢包轉入測試幣後，頁面能自動反映最新餘額。
export function useOnChainUsdtBalance(address: string | null | undefined, intervalMs = 4000) {
  const [balance, setBalance] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestKeyRef = useRef(address);

  useEffect(() => {
    requestKeyRef.current = address;
    if (!isValidAddress(address)) {
      setBalance(0);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const next = await fetchOnChainUsdtBalance(address);
        if (!cancelled && requestKeyRef.current === address) {
          setBalance(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "讀取鏈上 USDT 餘額失敗");
        }
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
  }, [address, intervalMs]);

  return { balance, loading, error };
}
