// 後端 relayer 的鏈上工具模組（Vercel serverless / Node runtime）。
//
// 這裡持有「合約 owner」的私鑰（RELAYER_PRIVATE_KEY），用來代發所有 onlyOwner
// 的鏈上交易：JC/RWA 發幣、一級認購結算、二級市場成交結算、以及一次性把
// 子合約位址寫進 RWA 母合約。私鑰只存在後端環境變數，永遠不會回傳給前端。
//
// RWA、JC、AE 都走真實鏈上流程：RWA 一級/二級透過對應合約，AE 一級採兩步
// （transferFrom JC → mint AE）、AE 二級透過 AE_Market_Thin.executeTrade。
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
  // 手續費 / 認購 JC 的收款金庫（AE 一級認購的 JC 匯入此處）。
  safeVault: normalizeOrThrow(
    process.env.NEXT_PUBLIC_SAFE_VAULT_ADDRESS,
    "0xe886e67fd9CFe66fdb0A1F47cEf0001548a078cf",
    "Safe 金庫",
  ),
  // AE 代幣：刻意「不」讀 NEXT_PUBLIC_AE_TOKEN_ADDRESS —— 專案該環境變數目前指向
  // 一顆沒有任何市場合約綁定的代幣（0x098cE097…）。二級市場合約實際綁定、且與
  // relayer 同 owner 的是下面這顆，因此在後端硬寫死為唯一真相來源。
  aeToken: normalizeOrThrow(undefined, "0x45C50E069F013B2b4Ae11a8F8F89C97d31e8D7cb", "AE 代幣合約"),
  aeSecondaryMarket: normalizeOrThrow(
    undefined,
    "0xE57d846e50883C3F6d9b2B52E18C7F976493A7Db",
    "AE 二級市場合約",
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
  // AE 一級認購走「兩步」：buyer 先 approve JC 給 relayer，relayer 再把 JC 從 buyer
  // transferFrom 到金庫（msg.sender 為 relayer owner）。
  { inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }], name: "transferFrom", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
] as const;

// AE 代幣：mintReward 與 JC 相同（owner-only 發幣）；setMarketContract 用於把代幣
// 的授權市場重新指到我們採用的新市場合約。
const aeAbi = [
  { inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], name: "mintReward", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "m", type: "address" }], name: "setMarketContract", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "marketContract", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
] as const;

// AE 二級市場撮合：注意第一個參數是「結算幣別」（此處固定傳 JC），與 RWA 的
// executeTrade 簽名不同。
const aeMarketAbi = [
  { inputs: [{ name: "currencyToken", type: "address" }, { name: "seller", type: "address" }, { name: "buyer", type: "address" }, { name: "aeAmount", type: "uint256" }, { name: "totalPayment", type: "uint256" }], name: "executeTrade", outputs: [], stateMutability: "nonpayable", type: "function" },
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
async function tokenDecimals(token: "jcToken" | "rwaMaster" | "aeToken"): Promise<number> {
  const address = RELAYER_ADDRESSES[token];
  const cached = decimalsCache.get(address);
  if (cached != null) return cached;
  const abi = token === "jcToken" ? jcAbi : token === "aeToken" ? aeAbi : rwaAbi;
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

/** 發放 AE 給指定錢包（owner-only mintReward）。amount 為人類可讀單位。 */
export async function mintAe(to: Address, amount: number) {
  const decimals = await tokenDecimals("aeToken");
  const hash = await ownerWalletClient().writeContract({
    address: RELAYER_ADDRESSES.aeToken,
    abi: aeAbi,
    functionName: "mintReward",
    args: [getAddress(to), parseUnits(amount.toFixed(decimals), decimals)],
    chain: RELAYER_CHAIN,
  });
  return waitAndReturn(hash);
}

/**
 * 把 buyer 的 JC 從其錢包 transferFrom 到 Safe 金庫（AE 一級認購第一步）。
 * buyer 需先 approve JC 給 relayer owner 地址，spender 才是本次 msg.sender。
 */
export async function pullJcToVault(from: Address, amountJc: number) {
  const decimals = await tokenDecimals("jcToken");
  const hash = await ownerWalletClient().writeContract({
    address: RELAYER_ADDRESSES.jcToken,
    abi: jcAbi,
    functionName: "transferFrom",
    args: [getAddress(from), RELAYER_ADDRESSES.safeVault, parseUnits(amountJc.toFixed(decimals), decimals)],
    chain: RELAYER_CHAIN,
  });
  return waitAndReturn(hash);
}

/** AE 二級市場成交：seller approve AE、buyer approve JC 給市場後由 owner 撮合。 */
export async function executeAeTrade(seller: Address, buyer: Address, aeUnits: number, paymentJc: number) {
  const [aeDecimals, jcDecimals] = await Promise.all([tokenDecimals("aeToken"), tokenDecimals("jcToken")]);
  const hash = await ownerWalletClient().writeContract({
    address: RELAYER_ADDRESSES.aeSecondaryMarket,
    abi: aeMarketAbi,
    functionName: "executeTrade",
    args: [
      RELAYER_ADDRESSES.jcToken,
      getAddress(seller),
      getAddress(buyer),
      parseUnits(String(aeUnits), aeDecimals),
      parseUnits(paymentJc.toFixed(jcDecimals), jcDecimals),
    ],
    chain: RELAYER_CHAIN,
  });
  return waitAndReturn(hash);
}

/** 一次性把 AE 代幣的授權市場指到我們採用的新 AE 二級市場合約。 */
export async function wireAeToken() {
  const current = (await publicClient().readContract({
    address: RELAYER_ADDRESSES.aeToken,
    abi: aeAbi,
    functionName: "marketContract",
  })) as Address;
  if (getAddress(current) === RELAYER_ADDRESSES.aeSecondaryMarket) {
    return { market: "already-set" };
  }
  const hash = await ownerWalletClient().writeContract({
    address: RELAYER_ADDRESSES.aeToken,
    abi: aeAbi,
    functionName: "setMarketContract",
    args: [RELAYER_ADDRESSES.aeSecondaryMarket],
    chain: RELAYER_CHAIN,
  });
  return { market: await waitAndReturn(hash) };
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
