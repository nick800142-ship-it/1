import { useCallback, useEffect, useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  parseUnits,
  http,
  type Address,
  type EIP1193Provider,
  type PublicClient,
} from "viem";
import { useWallets } from "@privy-io/react-auth";
import { CHAIN, CHAIN_ID, CONTRACT_ADDRESSES, ERC20_ABI, normalizeAddress } from "@/lib/contracts";

// Base Sepolia 測試網上的自訂 USDT 測試代幣。前端「極簡模式」：不做 approve / 充值
// 流程，只直接讀取用戶錢包在鏈上的真實 balanceOf 作為「可用 USDT 餘額」。
// 地址與鏈設定統一從 @/lib/contracts 讀取，這裡只保留 re-export 方便舊呼叫端。
export const USDT_CHAIN_ID = CHAIN_ID;
export const USDT_TOKEN_ADDRESS = CONTRACT_ADDRESSES.usdt;
export const USDT_DECIMALS = 6;
const RPC_URL = "https://sepolia.base.org";

// Safe 多簽金庫地址：全站購買/兌換的 USDT 一律轉入這裡。
export const SAFE_VAULT_ADDRESS = CONTRACT_ADDRESSES.safeVault;

let cachedClient: PublicClient | null = null;
function getClient(): PublicClient {
  if (!cachedClient) {
    cachedClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) }) as PublicClient;
  }
  return cachedClient;
}

// 單次查詢：在「下單/投資」按鈕點擊當下，重新讀取最新鏈上餘額做判斷，
// 不依賴輪詢的舊值。
export async function fetchOnChainUsdtBalance(address: string | null | undefined): Promise<number> {
  const account = normalizeAddress(address);
  if (!account) return 0;
  const raw = await getClient().readContract({
    address: USDT_TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account],
  });
  return Number(formatUnits(raw as bigint, USDT_DECIMALS));
}

// 批次查詢多個地址的鏈上 USDT 餘額（用 multicall 一次打包，供後台用戶列表使用）。
// key 統一轉小寫，方便呼叫端用原始地址字串查找。
export async function fetchOnChainUsdtBalances(
  addresses: (string | null | undefined)[],
): Promise<Record<string, number>> {
  const valid = Array.from(
    new Set(
      addresses
        .map((address) => normalizeAddress(address))
        .filter((address): address is Address => address != null),
    ),
  );
  if (valid.length === 0) return {};
  const results = await getClient().multicall({
    contracts: valid.map((address) => ({
      address: USDT_TOKEN_ADDRESS,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [address],
    })),
  });
  const balances: Record<string, number> = {};
  valid.forEach((address, index) => {
    const result = results[index];
    balances[address.toLowerCase()] =
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
  const key = Array.from(
    new Set(
      addresses
        .map((address) => normalizeAddress(address))
        .filter((address): address is Address => address != null)
        .map((address) => address.toLowerCase()),
    ),
  )
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
    balanceOf: (address: string | null | undefined) => {
      const normalized = normalizeAddress(address);
      return normalized ? balances[normalized.toLowerCase()] ?? 0 : 0;
    },
  };
}

// 每 4 秒輪詢鏈上 USDT 餘額，讓用戶從外部錢包轉入測試幣後，頁面能自動反映最新餘額。
export function useOnChainUsdtBalance(address: string | null | undefined, intervalMs = 4000) {
  const [balance, setBalance] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const account = normalizeAddress(address);
  const requestKeyRef = useRef(account);

  useEffect(() => {
    requestKeyRef.current = account;
    if (!account) {
      setBalance(0);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const next = await fetchOnChainUsdtBalance(account);
        if (!cancelled && requestKeyRef.current === account) {
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
  }, [account, intervalMs]);

  return { balance, loading, error };
}

// 用 Privy 內嵌錢包簽署一筆真實的 ERC-20 USDT transfer 到任意 BASE 鏈地址。
// 回傳鏈上交易 hash。USDT 存在使用者「自己的」內嵌錢包（自我保管），因此提領
// ＝使用者自己簽名把自己的 USDT 轉出，不需要任何平台/管理員審核或代簽。
export function useSendUsdt() {
  const { wallets } = useWallets();
  const [sending, setSending] = useState(false);

  const sendUsdt = useCallback(
    async (to: string, amount: number): Promise<`0x${string}`> => {
      const recipient = normalizeAddress(to);
      if (!recipient) throw new Error("提領地址無效，請確認為正確的 BASE 鏈 USDT 錢包地址");
      const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
      if (!wallet) throw new Error("找不到可用的錢包，請重新登入");
      const account = normalizeAddress(wallet.address);
      if (!account) throw new Error("錢包地址無效");
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("轉帳金額無效");

      setSending(true);
      try {
        await wallet.switchChain(USDT_CHAIN_ID);
        const provider = (await wallet.getEthereumProvider()) as EIP1193Provider;
        const walletClient = createWalletClient({
          account,
          chain: CHAIN,
          transport: custom(provider),
        });
        const amountUnits = parseUnits(amount.toFixed(USDT_DECIMALS), USDT_DECIMALS);
        const hash = await walletClient.writeContract({
          address: USDT_TOKEN_ADDRESS,
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [recipient, amountUnits],
        });
        await getClient().waitForTransactionReceipt({ hash });
        return hash;
      } finally {
        setSending(false);
      }
    },
    [wallets],
  );

  return { sendUsdt, sending };
}

// 把測試 USDT 轉入 Safe 金庫（全站購買/兌換用）。沿用 useSendUsdt 的簽署邏輯，
// 只是把收款地址固定成 Safe 金庫。回傳鏈上交易 hash；呼叫端應等到 hash 後才送
// 出對應的後端 RPC，確保「內部帳本異動」永遠對應一筆真實的鏈上轉帳。
export function useSendUsdtToVault() {
  const { sendUsdt, sending } = useSendUsdt();
  const sendToVault = useCallback(
    (amount: number) => sendUsdt(SAFE_VAULT_ADDRESS, amount),
    [sendUsdt],
  );
  return { sendToVault, sending };
}
