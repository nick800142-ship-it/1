// 後端 relayer 的鏈上工具模組（Vercel serverless / Node runtime）。
//
// 這裡持有唯一一把後端熱錢包私鑰（ADMIN_PRIVATE_KEY），代發所有需要「合約
// owner」或「Safe 已核准的動用者」身分才能送出的鏈上交易：RWA/AE 一級認購、
// 二級市場撮合、以及把子合約位址寫進母合約的一次性初始化。私鑰只存在後端
// 環境變數，永遠不會回傳給前端。
//
// 2026-09-19：全面換成使用者提供的新一批合約部署（原地址與其 owner 私鑰
// 0x7ea2…6cd3 已在對話記錄中明文曝光，視為已洩漏，不再信任、不再使用）。
// 架構同時簡化為單一熱錢包：
//  - 移除先前的 RELAYER_PRIVATE_KEY（合約 owner）／DELEGATE_PRIVATE_KEY
//    （Safe Allowance Module 的額度動用者）雙錢包分工，統一改成一把
//    ADMIN_PRIVATE_KEY，同時擁有兩者的權限與職責。
//  - JC/AE 發放給使用者改為「營運熱錢包直接轉帳」模型（使用者明確指定）：
//    Safe 金庫的 JC/AE 由人工手動轉帳「補貨」到 ADMIN 熱錢包，之後所有
//    對使用者的發放都是 ADMIN 用標準 ERC-20 transfer(to, amount) 從自己
//    的餘額直接轉出——**不使用 approve/allowance/transferFrom，也不使用
//    Safe Allowance Module**，沒有任何額外授權步驟。
//  - **已知風險（使用者已知情並選擇接受）**：ADMIN 熱錢包本身持有隨時可轉出
//    的 JC/AE 庫存（補貨後留在熱錢包裡），私鑰一旦洩漏，攻擊者可轉出熱錢包
//    當下持有的全部庫存（風險上限＝熱錢包餘額，而非整個 Safe 金庫）。務必
//    只把這把私鑰放在後端環境變數，絕不寫進任何前端程式碼、元件或
//    .env.local；並建議只留必要的營運庫存在熱錢包，其餘留在 Safe 金庫。
//  - RWA 一級認購 / 二級市場沿用既有合約介面（executeSubscription /
//    executeTrade），這批不受影響——JC/AE 的異動只影響「發放給使用者」這
//    一步；AE 現在也有專屬一級認購合約（aePrimarySale），不再需要
//    「pullJcToVault 兩步湊出認購」的舊手法。
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  getAddress,
  http,
  maxUint256,
  parseEther,
  parseUnits,
  type Address,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { withAdminNonceLock } from "./_relayerLock";

export const RELAYER_CHAIN = baseSepolia;
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

// 合約地址一律以下方硬編碼的「新部署」位址為唯一真相來源，**刻意不再讀取
// NEXT_PUBLIC_*_ADDRESS 環境變數**：專案環境變數裡那批 NEXT_PUBLIC_*_ADDRESS
// 仍留著上一批（舊）部署的位址，後端 serverless 讀得到，一旦被讀到 relayer 就
// 會把 JC/認購/成交結算送到舊合約上（例：JC 舊合約 0xa85e0664…）。要換合約時
// 直接改下面這幾行即可，並同步 src/lib/contracts.ts。
export const RELAYER_ADDRESSES = {
  rwaMaster: normalizeOrThrow(undefined, "0x79F1C6aDFCcD916cde668D88a6dda3918e5d6835", "RWA 鑄造工廠合約"),
  rwaPrimarySale: normalizeOrThrow(undefined, "0x1BF9Bfd5cFF90A3307ce4AaD0098A1AAEaBEaed0", "RWA 一級認購合約"),
  rwaSecondaryMarket: normalizeOrThrow(undefined, "0x9617b751445b8DF7f1c57f10b12065700c7a6117", "RWA 二級市場合約"),
  jcToken: normalizeOrThrow(undefined, "0xF7Ac96B9b4e01A432c40501644C7721497faa446", "JC 結算代幣合約"),
  // 手續費 / 認購 JC 的收款金庫。JC/AE 發放給使用者已改為 ADMIN 熱錢包直接
  // transfer，不再從這裡 transferFrom；這個地址僅保留供人工補貨轉帳時參考，
  // 程式碼中不會再讀取或動用這個地址的資產。
  safeVault: normalizeOrThrow(undefined, "0xe886e67fd9CFe66fdb0A1F47cEf0001548a078cf", "Safe 金庫"),
  aeToken: normalizeOrThrow(undefined, "0x38ceB1c4A4dC308eF668B75e56EbC468D451Ad5a", "AE 代幣合約"),
  aePrimarySale: normalizeOrThrow(undefined, "0x006a585f0B4aDF0663Dc2175A82D6BabbDc5e3A4", "AE 一級認購合約"),
  aeSecondaryMarket: normalizeOrThrow(
    undefined,
    "0x835D61FF69743B0f5F39223ba45F5062A7A5E5c9",
    "AE 二級市場合約",
  ),
  // 2026-09-20 部署：每個私募標的一顆專屬 RWA 份額代幣的工廠 + 通用結算入口
  // （見 contracts/RWAFactory.sol）。只有 private_placements.token_address 已
  // 回填的標的才會走這裡；未回填的標的沿用上面舊的 rwaMaster/rwaPrimarySale/
  // rwaSecondaryMarket（兩套並存，直到全部標的都遷移完成）。
  rwaFactory: normalizeOrThrow(undefined, "0x491B3a7204F52Aa59968B81a5faf744dEe321b2A", "RWA Factory 合約"),
} as const;

function normalizeOrThrow(envValue: string | undefined, fallback: string, label: string): Address {
  try {
    return getAddress((envValue ?? fallback).trim());
  } catch {
    throw new Error(`${label} 地址格式錯誤`);
  }
}

// JC/AE 都是標準 ERC-20（新部署，無 mint / market / safeVault 等自訂函式）。
// 發放給使用者一律由 ADMIN 熱錢包直接 transfer(to, amount)（動用自己的餘額，
// 不經過 approve/allowance），因此只放本模組實際會呼叫到的函式：transfer、
// balanceOf（發放前的庫存預檢查）、decimals。
const erc20MinimalAbi = [
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], name: "allowance", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], name: "approve", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
] as const;
const jcAbi = erc20MinimalAbi;
const aeAbi = erc20MinimalAbi;

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

// RWA 與 AE 的一級認購合約共用同一個介面（executeSubscription(buyer, amount, totalPayment)）。
const subscriptionAbi = [
  { inputs: [{ name: "buyer", type: "address" }, { name: "rwaAmount", type: "uint256" }, { name: "totalPayment", type: "uint256" }], name: "executeSubscription", outputs: [], stateMutability: "nonpayable", type: "function" },
] as const;

const secondaryAbi = [
  { inputs: [{ name: "seller", type: "address" }, { name: "buyer", type: "address" }, { name: "amount", type: "uint256" }, { name: "payment", type: "uint256" }], name: "executeTrade", outputs: [], stateMutability: "nonpayable", type: "function" },
] as const;

// RWA Factory（contracts/RWAFactory.sol）：一標的一顆代幣的工廠 + 通用結算入口。
// subscribe()/trade() 的支付幣種是呼叫參數，不是合約狀態；createRWAToken 建立
// 標的時把全額份額一次鑄給 Safe 金庫，之後 subscribe() 把份額從 owner（本模組，
// 即 ADMIN 熱錢包）transferFrom 給買方——因此 ADMIN 需先對本合約 approve 該
// 標的代幣額度，見下方 ensureFactoryApproval。
const rwaFactoryAbi = [
  {
    inputs: [
      { name: "placementId", type: "string" },
      { name: "name_", type: "string" },
      { name: "symbol_", type: "string" },
      { name: "decimals_", type: "uint8" },
      { name: "totalSupply_", type: "uint256" },
    ],
    name: "createRWAToken",
    outputs: [{ name: "token", type: "address" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "currency", type: "address" },
      { name: "buyer", type: "address" },
      { name: "shareAmount", type: "uint256" },
      { name: "payment", type: "uint256" },
    ],
    name: "subscribe",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "currency", type: "address" },
      { name: "seller", type: "address" },
      { name: "buyer", type: "address" },
      { name: "shareAmount", type: "uint256" },
      { name: "paymentToSeller", type: "uint256" },
      { name: "feeAmount", type: "uint256" },
    ],
    name: "trade",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  { inputs: [{ name: "", type: "string" }], name: "tokenByPlacement", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
] as const;

// 每個標的一顆專屬的 RWAShareToken：標準 ERC-20（含 decimals/approve/allowance），
// 地址是動態的（存於 private_placements.token_address），因此不能放進固定的
// RELAYER_ADDRESSES，改用這份最小 ABI 搭配呼叫端傳入的地址。
const shareTokenAbi = [
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], name: "allowance", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], name: "approve", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
] as const;

const shareTokenDecimalsCache = new Map<Address, number>();
async function shareTokenDecimals(token: Address): Promise<number> {
  const cached = shareTokenDecimalsCache.get(token);
  if (cached != null) return cached;
  let value = 18;
  try {
    value = Number(await publicClient().readContract({ address: token, abi: shareTokenAbi, functionName: "decimals" }));
  } catch {
    value = 18;
  }
  shareTokenDecimalsCache.set(token, value);
  return value;
}

/**
 * subscribe() 會用 ADMIN（Factory owner）身分 transferFrom 自己的份額給買方，
 * 因此 ADMIN 需先對 Factory approve 足夠額度。這裡在每次認購前自動檢查現有
 * allowance，不足就自動送出一次 approve(maxUint256)——這是 ADMIN 對自己控制
 * 的合約做的自我授權，不涉及使用者資產，因此可以完全自動化，不需要人工簽署。
 */
async function ensureFactoryApproval(token: Address, neededUnits: bigint): Promise<void> {
  const current = (await publicClient().readContract({
    address: token,
    abi: shareTokenAbi,
    functionName: "allowance",
    args: [relayerAddress(), RELAYER_ADDRESSES.rwaFactory],
  })) as bigint;
  if (current >= neededUnits) return;
  const hash = await sendAdminTx((nonce) =>
    adminWalletClient().writeContract({
      address: token,
      abi: shareTokenAbi,
      functionName: "approve",
      args: [RELAYER_ADDRESSES.rwaFactory, maxUint256],
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
  await waitAndReturn(hash);
}

/**
 * 為一個私募標的部署專屬 RWA 份額代幣（RWA Factory createRWAToken），把全額
 * 份額一次鑄給 Safe 金庫。若該 placementId 已建立過代幣（tokenByPlacement 非
 * 零地址），直接回傳既有地址，不重複建立（Factory 合約本身也會擋，這裡先讀
 * 一次避免浪費一筆注定失敗的交易）。
 */
export async function createRwaFactoryToken(
  placementId: string,
  name: string,
  symbol: string,
  decimals: number,
  totalSupply: number,
): Promise<{ tokenAddress: Address; txHash: string; alreadyExisted: boolean }> {
  await ensureRelayerGas();
  const existing = (await publicClient().readContract({
    address: RELAYER_ADDRESSES.rwaFactory,
    abi: rwaFactoryAbi,
    functionName: "tokenByPlacement",
    args: [placementId],
  })) as Address;
  if (existing && existing !== "0x0000000000000000000000000000000000000000") {
    return { tokenAddress: getAddress(existing), txHash: "already-exists", alreadyExisted: true };
  }
  const totalSupplyUnits = parseUnits(String(totalSupply), decimals);
  const hash = await sendAdminTx((nonce) =>
    adminWalletClient().writeContract({
      address: RELAYER_ADDRESSES.rwaFactory,
      abi: rwaFactoryAbi,
      functionName: "createRWAToken",
      args: [placementId, name, symbol, decimals, totalSupplyUnits],
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
  await waitAndReturn(hash);
  const tokenAddress = (await publicClient().readContract({
    address: RELAYER_ADDRESSES.rwaFactory,
    abi: rwaFactoryAbi,
    functionName: "tokenByPlacement",
    args: [placementId],
  })) as Address;
  return { tokenAddress: getAddress(tokenAddress), txHash: hash, alreadyExisted: false };
}

let cachedPublic: ReturnType<typeof createPublicClient> | null = null;
export function publicClient() {
  if (!cachedPublic) {
    cachedPublic = createPublicClient({ chain: RELAYER_CHAIN, transport: http(RPC_URL) });
  }
  return cachedPublic;
}

function adminAccount() {
  const raw = (process.env.ADMIN_PRIVATE_KEY ?? "").trim();
  if (!raw) throw new Error("ADMIN_PRIVATE_KEY 未設定");
  // 支援兩種格式：
  //  1. 原始私鑰（0x + 64 hex，或不含 0x 的 64 hex）
  //  2. BIP-39 助記詞（以空白分隔的 12 / 15 / 18 / 21 / 24 個單字），使用預設
  //     衍生路徑（index 0）。
  const looksMnemonic = /\s/.test(raw) && !raw.startsWith("0x");
  if (looksMnemonic) {
    const words = raw.split(/\s+/).length;
    if (![12, 15, 18, 21, 24].includes(words)) {
      throw new Error("ADMIN_PRIVATE_KEY 疑似助記詞但單字數不正確");
    }
    return mnemonicToAccount(raw);
  }
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("ADMIN_PRIVATE_KEY 格式錯誤（需為 0x + 64 hex 私鑰，或 BIP-39 助記詞）");
  }
  return privateKeyToAccount(key);
}

export function adminWalletClient() {
  return createWalletClient({ account: adminAccount(), chain: RELAYER_CHAIN, transport: http(RPC_URL) });
}

export function relayerAddress(): Address {
  return adminAccount().address;
}

/** ADMIN 熱錢包目前的 Base Sepolia ETH 餘額（用來付所有鏈上交易的礦工費）。 */
export async function relayerEthBalance(): Promise<bigint> {
  return publicClient().getBalance({ address: relayerAddress() });
}

// 每筆 writeContract 在 Base Sepolia 上花費的 gas 很小，但認購/成交常常需要連續
// 兩筆交易。這裡保留約可覆蓋 5 筆一般交易的餘裕，餘額低於此值就先擋下，避免
// 交易卡在「送出但沒錢付 gas」的半途狀態，讓使用者的 JC/USDT 已經被扣款卻拿
// 不到對應的鏈上結算。
const MIN_RELAYER_ETH_WEI = parseEther("0.0015");

/**
 * 送出任何鏈上交易前的防呆檢查：ADMIN 熱錢包 ETH 太少會導致交易卡住甚至完全
 * 送不出去。這裡先讀鏈上餘額擋下，回報清楚的中文錯誤，而不是讓使用者卡在一
 * 個看不懂的底層 RPC 錯誤，或讓內部帳本已經扣款卻永遠等不到鏈上結算。
 */
export async function ensureRelayerGas(): Promise<void> {
  const balance = await relayerEthBalance();
  if (balance < MIN_RELAYER_ETH_WEI) {
    throw new Error(
      `ADMIN 熱錢包 Base Sepolia ETH 餘額過低（${formatEther(balance)} ETH），請管理員先儲值測試網 ETH 後再重試`,
    );
  }
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

/**
 * 所有 ADMIN 鏈上交易的唯一送出入口：在 nonce 鎖內查詢當前 pending nonce、
 * 組好交易並送出（不等待上鏈確認），一拿到 tx hash 就立刻釋放鎖。這是修掉
 * 「同時有兩筆交易在跑就可能 nonce 衝突」問題的關鍵——所有發放/結算函式都
 * 必須透過這裡送出交易，不可以再各自直接呼叫 writeContract。
 */
async function sendAdminTx(build: (nonce: number) => Promise<`0x${string}`>): Promise<`0x${string}`> {
  return withAdminNonceLock(async () => {
    const nonce = await publicClient().getTransactionCount({
      address: relayerAddress(),
      blockTag: "pending",
    });
    return build(nonce);
  });
}

/**
 * 送出「ADMIN 熱錢包直接轉帳發放給使用者」之前的預檢查：熱錢包自己的餘額
 * 若不足，代表需要人工從 Safe 金庫再轉一批 JC/AE 過來補貨。
 * amountUnits 已是代幣最小單位（wei）。
 */
async function ensureHotWalletCanCover(token: "jcToken" | "aeToken", amountUnits: bigint): Promise<void> {
  const tokenAddress = RELAYER_ADDRESSES[token];
  const abi = token === "jcToken" ? jcAbi : aeAbi;
  const balance = (await publicClient().readContract({
    address: tokenAddress,
    abi,
    functionName: "balanceOf",
    args: [relayerAddress()],
  })) as bigint;
  const label = token === "jcToken" ? "JC" : "AE";
  if (balance < amountUnits) {
    throw new Error(`ADMIN 熱錢包 ${label} 庫存不足，請管理員先從 Safe 金庫轉一批 ${label} 到熱錢包補貨後再重試`);
  }
}

/**
 * 發放 JC/AE 給指定錢包：ADMIN 熱錢包直接用標準 ERC-20 transfer 動用自己的
 * 餘額轉給使用者，不經過 approve/allowance/transferFrom。庫存由人工從 Safe
 * 金庫手動轉帳補貨到熱錢包。amount 為人類可讀單位。
 */
async function transferFromHotWallet(token: "jcToken" | "aeToken", to: Address, amount: number) {
  await ensureRelayerGas();
  const decimals = await tokenDecimals(token);
  const amountUnits = parseUnits(amount.toFixed(decimals), decimals);
  await ensureHotWalletCanCover(token, amountUnits);
  const abi = token === "jcToken" ? jcAbi : aeAbi;
  const hash = await sendAdminTx((nonce) =>
    adminWalletClient().writeContract({
      address: RELAYER_ADDRESSES[token],
      abi,
      functionName: "transfer",
      args: [getAddress(to), amountUnits],
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
  return waitAndReturn(hash);
}

/** 發放 JC 給指定錢包（見 transferFromHotWallet）。 */
export async function mintJc(to: Address, amount: number) {
  return transferFromHotWallet("jcToken", to, amount);
}

/** 發放 AE 給指定錢包（見 transferFromHotWallet）。 */
export async function mintAe(to: Address, amount: number) {
  return transferFromHotWallet("aeToken", to, amount);
}

/**
 * RWA 一級認購結算。
 *
 * `factoryToken` 有值時（該標的已在 RWA Factory 建立專屬代幣，見
 * private_placements.token_address）：改走 Factory.subscribe()——買方需先
 * approve JC 給 Factory（前端 spender 需改成 CONTRACT_ADDRESSES.rwaFactory），
 * 份額則由 ADMIN 自動 approve 給 Factory 後 transferFrom 給買方，不需要買方
 * 額外操作。
 *
 * `factoryToken` 為 undefined 時：沿用舊的 rwaPrimarySale 合約（尚未遷移到
 * Factory 的標的）。buyer 需先 approve JC 給 rwaPrimarySale。
 */
export async function executeSubscription(
  buyer: Address,
  rwaUnits: number,
  paymentJc: number,
  factoryToken?: Address,
) {
  await ensureRelayerGas();
  const jcDecimals = await tokenDecimals("jcToken");
  if (factoryToken) {
    const shareDecimals = await shareTokenDecimals(factoryToken);
    const shareUnits = parseUnits(String(rwaUnits), shareDecimals);
    const paymentUnits = parseUnits(paymentJc.toFixed(jcDecimals), jcDecimals);
    await ensureFactoryApproval(factoryToken, shareUnits);
    const hash = await sendAdminTx((nonce) =>
      adminWalletClient().writeContract({
        address: RELAYER_ADDRESSES.rwaFactory,
        abi: rwaFactoryAbi,
        functionName: "subscribe",
        args: [factoryToken, RELAYER_ADDRESSES.jcToken, getAddress(buyer), shareUnits, paymentUnits],
        chain: RELAYER_CHAIN,
        nonce,
      }),
    );
    return waitAndReturn(hash);
  }
  const rwaDecimals = await tokenDecimals("rwaMaster");
  const hash = await sendAdminTx((nonce) =>
    adminWalletClient().writeContract({
      address: RELAYER_ADDRESSES.rwaPrimarySale,
      abi: subscriptionAbi,
      functionName: "executeSubscription",
      args: [
        getAddress(buyer),
        parseUnits(String(rwaUnits), rwaDecimals),
        parseUnits(paymentJc.toFixed(jcDecimals), jcDecimals),
      ],
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
  return waitAndReturn(hash);
}

/**
 * 2026-09-20 探測到：`aePrimarySale` 合約本身持有 0 顆 AE，`owner()` 就是
 * ADMIN——即 executeSubscription() 內部是 `AE.transferFrom(owner(), buyer,
 * amount)`（跟新版 RWA Factory 的 subscribe() 同一種「從 owner 自己的餘額
 * 撥出」設計），但 ADMIN 從未 approve 過這顆合約，導致每一筆 AE 一級認購都
 * 在鏈上 revert（帳本卻已經扣款/入帳，造成兩邊不一致）。修法與
 * `ensureFactoryApproval` 相同：ADMIN 對自己控制的合約做自我授權，不涉及
 * 使用者資產，可完全自動化，不需要人工簽署。
 */
async function ensureAeSaleApproval(neededUnits: bigint): Promise<void> {
  const current = (await publicClient().readContract({
    address: RELAYER_ADDRESSES.aeToken,
    abi: erc20MinimalAbi,
    functionName: "allowance",
    args: [relayerAddress(), RELAYER_ADDRESSES.aePrimarySale],
  })) as bigint;
  if (current >= neededUnits) return;
  const hash = await sendAdminTx((nonce) =>
    adminWalletClient().writeContract({
      address: RELAYER_ADDRESSES.aeToken,
      abi: erc20MinimalAbi,
      functionName: "approve",
      args: [RELAYER_ADDRESSES.aePrimarySale, maxUint256],
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
  await waitAndReturn(hash);
}

/** AE 一級認購結算：buyer 需先 approve JC 給 AE 一級認購合約。 */
export async function executeAeSubscription(buyer: Address, aeUnits: number, paymentJc: number) {
  await ensureRelayerGas();
  const [aeDecimals, jcDecimals] = await Promise.all([tokenDecimals("aeToken"), tokenDecimals("jcToken")]);
  const aeUnitsRaw = parseUnits(String(aeUnits), aeDecimals);
  await ensureAeSaleApproval(aeUnitsRaw);
  const hash = await sendAdminTx((nonce) =>
    adminWalletClient().writeContract({
      address: RELAYER_ADDRESSES.aePrimarySale,
      abi: subscriptionAbi,
      functionName: "executeSubscription",
      args: [getAddress(buyer), aeUnitsRaw, parseUnits(paymentJc.toFixed(jcDecimals), jcDecimals)],
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
  return waitAndReturn(hash);
}

// 平台二級市場手續費公式（與 fill_p2p_order/settle_p2p_match 的
// `platform_fee := round(gross*0.01+1,6)` 一致）。RWA Factory ��� trade() 需要
// 呼叫端明確拆出 paymentToSeller / feeAmount（合約本身不計算手續費，不像舊的
// rwaSecondaryMarket 合約內建固定費率），因此這裡在後端重算一次同一條公式。
function splitTradeFee(gross: number): { net: number; fee: number } {
  const fee = Math.round((gross * 0.01 + 1) * 1e6) / 1e6;
  const net = Math.round((gross - fee) * 1e6) / 1e6;
  return { net, fee };
}

/**
 * 二級市場成交結算。
 *
 * `factoryToken` 有值時：改走 Factory.trade()——賣方需先 approve 該標的的
 * 專屬份額代幣給 Factory、買方需先 approve JC 給 Factory（前端 spender 與
 * assetToken 地址都需改成 Factory / 該標的專屬代幣，而非固定的
 * rwaSecondaryMarket / rwaMaster）。手續費由後端依平台公式拆出後傳入。
 *
 * `factoryToken` 為 undefined 時：沿用舊的 rwaSecondaryMarket 合約（手續費由
 * 合約內部計算，呼叫端只傳總價）。
 */
export async function executeRwaTrade(
  seller: Address,
  buyer: Address,
  rwaUnits: number,
  paymentJc: number,
  factoryToken?: Address,
) {
  await ensureRelayerGas();
  const jcDecimals = await tokenDecimals("jcToken");
  if (factoryToken) {
    const shareDecimals = await shareTokenDecimals(factoryToken);
    const shareUnits = parseUnits(String(rwaUnits), shareDecimals);
    const { net, fee } = splitTradeFee(paymentJc);
    const paymentUnits = parseUnits(net.toFixed(jcDecimals), jcDecimals);
    const feeUnits = parseUnits(fee.toFixed(jcDecimals), jcDecimals);
    const hash = await sendAdminTx((nonce) =>
      adminWalletClient().writeContract({
        address: RELAYER_ADDRESSES.rwaFactory,
        abi: rwaFactoryAbi,
        functionName: "trade",
        args: [
          factoryToken,
          RELAYER_ADDRESSES.jcToken,
          getAddress(seller),
          getAddress(buyer),
          shareUnits,
          paymentUnits,
          feeUnits,
        ],
        chain: RELAYER_CHAIN,
        nonce,
      }),
    );
    return waitAndReturn(hash);
  }
  const rwaDecimals = await tokenDecimals("rwaMaster");
  const hash = await sendAdminTx((nonce) =>
    adminWalletClient().writeContract({
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
      nonce,
    }),
  );
  return waitAndReturn(hash);
}

/** AE 二級市場成交：seller approve AE、buyer approve JC 給市場後由 ADMIN 撮合。 */
export async function executeAeTrade(seller: Address, buyer: Address, aeUnits: number, paymentJc: number) {
  await ensureRelayerGas();
  const [aeDecimals, jcDecimals] = await Promise.all([tokenDecimals("aeToken"), tokenDecimals("jcToken")]);
  const hash = await sendAdminTx((nonce) =>
    adminWalletClient().writeContract({
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
      nonce,
    }),
  );
  return waitAndReturn(hash);
}

/** wireRwaContracts 的回傳型別：每個子合約各自回報狀態，任一項失敗都不影響另一項。 */
export type WireResult = {
  subscription: string; // tx hash | "already-set"
  market: string; // tx hash | "already-set" | "failed"
  marketError?: string; // market 設定失敗時的人類可讀原因
};

/** 讀取母合約上某個 address getter；若該 getter 在鏈上 revert（新版工廠合約的
 * marketContract() 就會 revert），回傳 null 當作「未知／未設定」，絕不讓一個壞掉的
 * getter 中斷整個初始化流程。 */
async function readAddressGetter(functionName: "marketContract" | "subscriptionContract"): Promise<Address | null> {
  try {
    const value = await publicClient().readContract({
      address: RELAYER_ADDRESSES.rwaMaster,
      abi: rwaAbi,
      functionName,
    });
    return getAddress(value as Address);
  } catch {
    return null;
  }
}

/**
 * 一次性把子合約位址寫進 RWA 鑄造工廠合約，讓一級認購 / 二級市場合約有權移動 RWA。
 *
 * 重要：實測目前部署的這顆鑄造工廠合約，`setMarketContract(...)` 對「任何」參數
 * （含 address(0)、二級市場位址、甚至工廠自己）都會無條件 revert，且
 * `marketContract()` getter 也 revert——這是該合約 bytecode 內的既有缺陷，後端
 * 無法用程式修正（只能重新部署一顆可正常設定二級市場的工廠合約）。相對地
 * `setSubscriptionContract(...)` 正常可用。因此這裡改成：
 *   1. 各項獨立處理，一級認購先設定好（讓一級認購流程可運作）；
 *   2. 二級市場設定前先用 eth_call 模擬，模擬就 revert 時「不送出」交易（省下
 *      注定失敗的 gas、也不會在鏈上留下一筆令人困惑的失敗交易），改回報清楚原因；
 *   3. 回傳每項狀態，讓前端顯示「一級已設定、二級因合約缺陷失敗」的部分成功結果，
 *      而不是整顆按鈕丟一個看不懂的 "marketContract reverted"。
 */
export async function wireRwaContracts(): Promise<WireResult> {
  await ensureRelayerGas();
  const results: WireResult = { subscription: "unknown", market: "unknown" };

  // ---- 一級認購合約（正常可設定）----
  const currentSub = await readAddressGetter("subscriptionContract");
  if (currentSub && currentSub === RELAYER_ADDRESSES.rwaPrimarySale) {
    results.subscription = "already-set";
  } else {
    const hash = await sendAdminTx((nonce) =>
      adminWalletClient().writeContract({
        address: RELAYER_ADDRESSES.rwaMaster,
        abi: rwaAbi,
        functionName: "setSubscriptionContract",
        args: [RELAYER_ADDRESSES.rwaPrimarySale],
        chain: RELAYER_CHAIN,
        nonce,
      }),
    );
    results.subscription = await waitAndReturn(hash);
  }

  // ---- 二級市場合約 ----
  const currentMarket = await readAddressGetter("marketContract");
  if (currentMarket && currentMarket === RELAYER_ADDRESSES.rwaSecondaryMarket) {
    results.market = "already-set";
    return results;
  }
  try {
    // 送出前先模擬；模擬 revert 代表這筆交易上鏈也必然 revert，直接不送出。
    await publicClient().simulateContract({
      account: relayerAddress(),
      address: RELAYER_ADDRESSES.rwaMaster,
      abi: rwaAbi,
      functionName: "setMarketContract",
      args: [RELAYER_ADDRESSES.rwaSecondaryMarket],
    });
    const hash = await sendAdminTx((nonce) =>
      adminWalletClient().writeContract({
        address: RELAYER_ADDRESSES.rwaMaster,
        abi: rwaAbi,
        functionName: "setMarketContract",
        args: [RELAYER_ADDRESSES.rwaSecondaryMarket],
        chain: RELAYER_CHAIN,
        nonce,
      }),
    );
    results.market = await waitAndReturn(hash);
  } catch {
    results.market = "failed";
    results.marketError =
      "已部署的 RWA 鑄造工廠合約 setMarketContract() 在鏈上被無條件拒絕（對任何位址都 revert，marketContract() getter 也 revert），研判為該合約本身的缺陷，需重新部署一顆能正常設定二級市場的鑄造工廠合約才能修復——此問題無法由後端程式修正。RWA 一級認購已設定完成，不受影響。";
  }
  return results;
}

// 熱錢包庫存低於此值視為「該補貨了」，供 AdminPage 顯示提醒（僅供顯示用的
// 門檻，不影響實際能否轉帳——實際檢查一律看當下 balanceOf 是否夠這一筆）。
const LOW_HOT_WALLET_BALANCE_UNITS = 100;

/**
 * 唯讀診斷：回報 ADMIN 熱錢包目前持有的 JC/AE 庫存，供 AdminPage 顯示「是否
 * 需要人工從 Safe 金庫轉帳補貨」。純讀取，不做任何鏈上寫入。
 */
export async function getVaultStatus(token: "jcToken" | "aeToken") {
  const tokenAddress = RELAYER_ADDRESSES[token];
  const abi = token === "jcToken" ? jcAbi : aeAbi;
  const decimals = await tokenDecimals(token);
  const balance = (await publicClient().readContract({
    address: tokenAddress,
    abi,
    functionName: "balanceOf",
    args: [relayerAddress()],
  })) as bigint;
  return {
    token,
    tokenAddress,
    decimals,
    balance,
    balanceFormatted: formatUnits(balance, decimals),
    low: balance < parseUnits(String(LOW_HOT_WALLET_BALANCE_UNITS), decimals),
  };
}
