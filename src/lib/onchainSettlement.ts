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
import { CHAIN, CHAIN_ID, CONTRACT_ADDRESSES, CONTRACT_ABIS, normalizeAddress } from "@/lib/contracts";
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
function getClient(): PublicClient {
  if (!cachedClient) {
    cachedClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) }) as PublicClient;
  }
  return cachedClient;
}

type RelayerAction = "mint-jc" | "subscribe" | "trade" | "wire-contracts";

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
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : `relayer ${action} 失敗`);
  return json;
}

export function useOnchainSettlement() {
  const { wallets } = useWallets();
  const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0] ?? null;

  // 確保使用者已授權指定合約動用其代幣（allowance 足夠時直接略過，避免每次都
  // 跳簽名）。授權是使用者對自己資產的安全動作，用其內嵌錢包簽名。
  const ensureAllowance = useCallback(
    async (tokenKey: TokenKey, spender: Address): Promise<void> => {
      if (!wallet) throw new Error("找不到可用的錢包，請重新登入");
      const owner = normalizeAddress(wallet.address);
      if (!owner) throw new Error("錢包地址無效");
      const abi = CONTRACT_ABIS[tokenKey];
      const allowance = (await getClient().readContract({
        address: CONTRACT_ADDRESSES[tokenKey],
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
        address: CONTRACT_ADDRESSES[tokenKey],
        abi,
        functionName: "approve",
        args: [spender, maxUint256],
      });
      await getClient().waitForTransactionReceipt({ hash });
    },
    [wallet],
  );

  // 金庫買 JC 後，請 relayer 把等量 JC mint 到使用者錢包（無需授權）。
  const mintJcOnchain = useCallback(async (requestKey: string) => {
    return callRelayer("mint-jc", { requestKey });
  }, []);

  // 一級認購：先授權認購合約動用 JC，再請 relayer 代發 executeSubscription。
  const settleSubscription = useCallback(
    async (requestKey: string) => {
      await ensureAllowance("jcToken", CONTRACT_ADDRESSES.rwaPrimarySale);
      return callRelayer("subscribe", { requestKey });
    },
    [ensureAllowance],
  );

  // 掛單時的預先授權：賣單先授權二級市場動用 RWA、買單先授權動用 JC，
  // 確保日後被成交時 relayer 的 executeTrade 能順利 transferFrom 雙方。
  const approveForOrder = useCallback(
    async (side: "buy" | "sell") => {
      await ensureAllowance(
        side === "sell" ? "rwaMaster" : "jcToken",
        CONTRACT_ADDRESSES.rwaSecondaryMarket,
      );
    },
    [ensureAllowance],
  );

  // 成交後：taker 先補上自己這側的授權，再請 relayer 代發 executeTrade。
  // takerSide 指「目前使用者在這筆成交中的角色」：買方需授權 JC、賣方需授權 RWA。
  const settleTrade = useCallback(
    async (requestKey: string, takerSide: "buy" | "sell") => {
      await ensureAllowance(
        takerSide === "sell" ? "rwaMaster" : "jcToken",
        CONTRACT_ADDRESSES.rwaSecondaryMarket,
      );
      return callRelayer("trade", { requestKey });
    },
    [ensureAllowance],
  );

  return { mintJcOnchain, settleSubscription, approveForOrder, settleTrade, walletReady: !!wallet };
}
