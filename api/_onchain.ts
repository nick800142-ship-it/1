// 後端 relayer 的鏈上工具模組（Vercel serverless / Node runtime）。
//
// 這裡持有「合約 owner」的私鑰（RELAYER_PRIVATE_KEY），用來代發所有 onlyOwner
// 的鏈上交易：JC/RWA 發幣、一級認購結算、二級市場成交結算、以及一次性把
// 子合約位址寫進 RWA 母合約。私鑰只存在後端環境變數，永遠不會回傳給前端。
//
// 注意：AE 代幣（AE_Token_v2 / AE_Market_Thin）目前在設定的位址上尚未部署，
// 因此本模組只處理 RWA + JC 的真實鏈上流程；AE 仍走 Supabase 沙盒帳本。
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseUnits,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

export const RELAYER_CHAIN = baseSepolia;
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

export const RELAYER_ADDRESSES = {
  rwaMaster: normalizeOrThrow(
    process.env.NEXT_PUBLIC_RWA_MASTER_ADDRESS,
    "0x406555b7F4AD841e62a40B926A0864c8a8549775",
    "RWA 母合約",
  ),
  rwaPrimarySale: normalizeOrThrow(
    process.env.NEXT_PUBLIC_RWA_PRIMARY_SALE_ADDRESS,
    "0xFeB4871230151DF02f8476F9c9295356A1412ab8",
    "RWA 一級認購合約",
  ),
  rwaSecondaryMarket: normalizeOrThrow(
    process.env.NEXT_PUBLIC_RWA_SECONDARY_MARKET_ADDRESS,
    "0x3Ec85939a5e3BAC78A3F38d0587362782AEd6968",
    "RWA 二級市場合約",
  ),
  jcToken: normalizeOrThrow(
    process.env.NEXT_PUBLIC_JC_TOKEN_ADDRESS,
    "0xa85e0664701fBec23596bFE88eB26d4efd1C7723",
    "JC 結算代幣合約",
  ),
} as const;

function normalizeOrThrow(envValue: string | undefined, fallback: string, label: string): Address {
  try {
    return getAddress((envValue ?? fallback).trim());
  } catch {
    throw new Error(`${label} 地址格式錯誤`);
  }
}

// 只放本模組實際會呼叫到的函式，避免夾帶整包 ABI。
const jcAbi = [
  { inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], name: "mintReward", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
] as const;

const rwaAbi = [
  { inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], name: "mint", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "m", type: "address" }], name: "setMarketContract", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "s", type: "address" }], name: "setSubscriptionContract", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "marketContract", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "subscriptionContract", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "owner", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
] as const;

const subscriptionAbi = [
  { inputs: [{ name: "buyer", type: "address" }, { name: "rwaAmount", type: "uint256" }, { name: "totalPayment", type: "uint256" }], name: "executeSubscription", outputs: [], stateMutability: "nonpayable", type: "function" },
] as const;

const secondaryAbi = [
  { inputs: [{ name: "seller", type: "address" }, { name: "buyer", type: "address" }, { name: "amount", type: "uint256" }, { name: "payment", type: "uint256" }], name: "executeTrade", outputs: [], stateMutability: "nonpayable", type: "function" },
] as const;

let cachedPublic: ReturnType<typeof createPublicClient> | null = null;
export function publicClient() {
  if (!cachedPublic) {
    cachedPublic = createPublicClient({ chain: RELAYER_CHAIN, transport: http(RPC_URL) });
  }
  return cachedPublic;
}

function ownerAccount() {
  const raw = process.env.RELAYER_PRIVATE_KEY;
  if (!raw) throw new Error("RELAYER_PRIVATE_KEY 未設定");
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`).trim() as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("RELAYER_PRIVATE_KEY 格式錯誤");
  return privateKeyToAccount(key);
}

export function ownerWalletClient() {
  return createWalletClient({ account: ownerAccount(), chain: RELAYER_CHAIN, transport: http(RPC_URL) });
}

export function relayerAddress(): Address {
  return ownerAccount().address;
}

const decimalsCache = new Map<Address, number>();
async function tokenDecimals(token: "jcToken" | "rwaMaster"): Promise<number> {
  const address = RELAYER_ADDRESSES[token];
  const cached = decimalsCache.get(address);
  if (cached != null) return cached;
  const abi = token === "jcToken" ? jcAbi : rwaAbi;
  let value = 18;
  try {
    value = Number(await publicClient().readContract({ address, abi, functionName: "decimals" }));
  } catch {
    value = 18;
  }
  decimalsCache.set(address, value);
  return value;
}

// Vercel function maxDuration 設 60 秒（見 vercel.json），這裡留一些餘裕給函式
// 其餘邏輯（讀 Supabase、簽名送出），逾時就不繼續等待收據，讓前端改用交易雜湊
// 自行查詢最終狀態，避免整個請求被平台強制中斷成 504。
async function waitAndReturn(hash: `0x${string}`) {
  const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 45_000 });
  if (receipt.status !== "success") throw new Error(`鏈上交易失敗（reverted）: ${hash}`);
  return hash;
}

/** 發放 JC 給指定錢包（owner-only mintReward）。amount 為人類可讀單位。 */
export async function mintJc(to: Address, amount: number) {
  const decimals = await tokenDecimals("jcToken");
  const hash = await ownerWalletClient().writeContract({
    address: RELAYER_ADDRESSES.jcToken,
    abi: jcAbi,
    functionName: "mintReward",
    args: [getAddress(to), parseUnits(amount.toFixed(decimals), decimals)],
    chain: RELAYER_CHAIN,
  });
  return waitAndReturn(hash);
}

/** 一級認購結算：buyer 需先 approve JC 給認購合約（owner-only executeSubscription）。 */
export async function executeSubscription(buyer: Address, rwaUnits: number, paymentJc: number) {
  const [rwaDecimals, jcDecimals] = await Promise.all([tokenDecimals("rwaMaster"), tokenDecimals("jcToken")]);
  const hash = await ownerWalletClient().writeContract({
    address: RELAYER_ADDRESSES.rwaPrimarySale,
    abi: subscriptionAbi,
    functionName: "executeSubscription",
    args: [
      getAddress(buyer),
      parseUnits(String(rwaUnits), rwaDecimals),
      parseUnits(paymentJc.toFixed(jcDecimals), jcDecimals),
    ],
    chain: RELAYER_CHAIN,
  });
  return waitAndReturn(hash);
}

/** 二級市場成交結算：seller approve RWA、buyer approve JC 後由 owner 撮合。 */
export async function executeRwaTrade(seller: Address, buyer: Address, rwaUnits: number, paymentJc: number) {
  const [rwaDecimals, jcDecimals] = await Promise.all([tokenDecimals("rwaMaster"), tokenDecimals("jcToken")]);
  const hash = await ownerWalletClient().writeContract({
    address: RELAYER_ADDRESSES.rwaSecondaryMarket,
    abi: secondaryAbi,
    functionName: "executeTrade",
    args: [
      getAddress(seller),
      getAddress(buyer),
      parseUnits(String(rwaUnits), rwaDecimals),
      parseUnits(paymentJc.toFixed(jcDecimals), jcDecimals),
    ],
    chain: RELAYER_CHAIN,
  });
  return waitAndReturn(hash);
}

/** 一次性把子合約位址寫進 RWA 母合約，讓認購/二級合約有權移動 RWA。 */
export async function wireRwaContracts() {
  const client = ownerWalletClient();
  const [currentMarket, currentSub] = await Promise.all([
    publicClient().readContract({ address: RELAYER_ADDRESSES.rwaMaster, abi: rwaAbi, functionName: "marketContract" }),
    publicClient().readContract({ address: RELAYER_ADDRESSES.rwaMaster, abi: rwaAbi, functionName: "subscriptionContract" }),
  ]);
  const results: Record<string, string> = {};
  if (getAddress(currentSub as Address) !== RELAYER_ADDRESSES.rwaPrimarySale) {
    const hash = await client.writeContract({
      address: RELAYER_ADDRESSES.rwaMaster,
      abi: rwaAbi,
      functionName: "setSubscriptionContract",
      args: [RELAYER_ADDRESSES.rwaPrimarySale],
      chain: RELAYER_CHAIN,
    });
    results.subscription = await waitAndReturn(hash);
  } else {
    results.subscription = "already-set";
  }
  if (getAddress(currentMarket as Address) !== RELAYER_ADDRESSES.rwaSecondaryMarket) {
    const hash = await client.writeContract({
      address: RELAYER_ADDRESSES.rwaMaster,
      abi: rwaAbi,
      functionName: "setMarketContract",
      args: [RELAYER_ADDRESSES.rwaSecondaryMarket],
      chain: RELAYER_CHAIN,
    });
    results.market = await waitAndReturn(hash);
  } else {
    results.market = "already-set";
  }
  return results;
}
