// 後端 relayer 的鏈上工具模組（Vercel serverless / Node runtime）。
//
// 這裡持有「合約 owner」的私鑰（RELAYER_PRIVATE_KEY），用來代發所有 onlyOwner
// 的鏈上交易：RWA 一級/二級結算、以及一次性把子合約位址寫進 RWA 母合約。
// 私鑰只存在後端環境變數，永遠不會回傳給前端。
//
// RWA、JC、AE 都走真實鏈上流程：RWA 一級/二級透過對應合約，AE 一級採兩步
// （transferFrom JC → 從金庫 transferFrom AE）、AE 二級透過 AE_Market_Thin.executeTrade。
//
// 2026-09-18（第一版）：JC／AE 的「發放給使用者」曾短暫改成
// transferFrom(safeVault, to, amount) + Safe 對 relayer(owner) 做無上限
// approve。**這個模型已被下面的 Safe Allowance Module 模型取代並移除**——
// 理由：對 owner 做「無上限 approve」等於讓一個單一 EOA 私鑰完全掌控整個金庫
// 資產，一旦這把私鑰洩漏，攻擊者可以直接掏空金庫，沒有任何鏈上額度或白名單
// 擋著。
//
// 2026-09-18（現行）：改用 Safe 官方的 Allowance Module
// （https://github.com/safe-global/safe-modules/tree/main/modules/allowances，
// 在 Base Sepolia 已驗證部署於 0xAA46724893dedD72658219405185Fb0Fc91e091C，
// NAME()="Allowance Module"／VERSION()="0.1.1"，與官方原始碼逐行核對一致）。
// 架構：
//  - 新增一個低權限的 DELEGATE_PRIVATE_KEY（全新 EOA，不是 Safe owner、也不是
//    任何合約的 owner），只用來呼叫 Allowance Module 的 executeAllowanceTransfer。
//  - Safe 擁有人手動在 Safe{Wallet} 對 Allowance Module 執行一次性
//    `enableModule` → `addDelegate(delegate)` → 對 JC/AE 各執行一次
//    `setAllowance(delegate, token, 每日上限, 1440, 0)`。
//  - 之後 delegate 每次呼叫 executeAllowanceTransfer 都會被鏈上合約強制檢查：
//    (a) token 必須是曾經 setAllowance 過的白名單代幣，其他資產完全動不了；
//    (b) 累計轉出不能超過設定的每日額度，超過會 revert。
//  - **已知且尚未解決的鏈上殘餘風險**：Allowance Module 的
//    executeAllowanceTransfer 對「收款地址 to」沒有任何鏈上白名單限制——
//    delegate 可以在額度內把錢轉給任意地址，不只是站內使用者的錢包。這一層
//    完全依賴後端程式碼保證：payoutViaAllowance 的呼叫端只能傳入從
//    Supabase `profiles.wallet_address` 讀出的地址，从来不接受前端直接傳入
//    的任意地址。如果需要鏈上層級的 recipient 白名單，需要额外加裝 Zodiac
//    Guard 之類的模組，這是 Phase 2 的潛在加強項目，目前尚未實作。
//  - 好處：即使 DELEGATE_PRIVATE_KEY 洩漏，攻擊者能造成的最大損失被鏈上結構
//    性限制在「每日額度 × 洩漏後到被 Safe 擁有人發現並移除 delegate 之間的
//    時間」，而不是整個金庫。
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseEther,
  parseUnits,
  type Address,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { withDelegateNonceLock, withRelayerNonceLock } from "./_relayerLock";

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
  // Safe 官方 Allowance Module，已在 Base Sepolia 用 NAME()/VERSION() 核對確認
  // 部署於此位址（見上方模組說明）。所有「從金庫發放給使用者」的動作都改走
  // 這裡，不再對 owner 做無上限 approve。
  allowanceModule: normalizeOrThrow(
    process.env.ALLOWANCE_MODULE_ADDRESS,
    "0xAA46724893dedD72658219405185Fb0Fc91e091C",
    "Safe Allowance Module",
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
//
// transferFrom 仍保留：AE 一級認購把 buyer 的 JC transferFrom 到金庫
// （pullJcToVault，buyer 自己 approve 給 relayer，跟 Safe 金庫的資產無關）。
// balanceOf 保留供 Allowance Module 額度狀態的診斷顯示（金庫目前餘額）使用。
const jcAbi = [
  { inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }], name: "transferFrom", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
] as const;

// AE 代幣：setMarketContract 用於把代幣的授權市場重新指到我們採用的新市場合約。
const aeAbi = [
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "m", type: "address" }], name: "setMarketContract", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "marketContract", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
] as const;

// Safe 官方 Allowance Module 的最小 ABI（只放本模組會呼叫/讀取的函式）。
// executeAllowanceTransfer 的簽名驗證：若 signature 傳空 bytes，合約會直接把
// `msg.sender` 當成簽署人（recoverSignature 的規則）——因此只要「delegate 錢包
// 本人」直接送出這筆交易，完全不需要另外做任何 EIP-712 簽名，這也是本模組
// 採用的方式，避免額外的簽名編碼風險。
const allowanceModuleAbi = [
  {
    inputs: [
      { name: "safe", type: "address" },
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint96" },
      { name: "paymentToken", type: "address" },
      { name: "payment", type: "uint96" },
      { name: "delegate", type: "address" },
      { name: "signature", type: "bytes" },
    ],
    name: "executeAllowanceTransfer",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "safe", type: "address" },
      { name: "delegate", type: "address" },
      { name: "token", type: "address" },
    ],
    name: "getTokenAllowance",
    outputs: [{ type: "uint256[5]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "safe", type: "address" },
      { name: "start", type: "uint48" },
      { name: "pageSize", type: "uint8" },
    ],
    name: "getDelegates",
    outputs: [{ name: "results", type: "address[]" }, { name: "next", type: "uint48" }],
    stateMutability: "view",
    type: "function",
  },
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
  const raw = (process.env.RELAYER_PRIVATE_KEY ?? "").trim();
  if (!raw) throw new Error("RELAYER_PRIVATE_KEY 未設定");
  // 支援兩種格式：
  //  1. 原始私鑰（0x + 64 hex，或不含 0x 的 64 hex）
  //  2. BIP-39 助記詞（以空白分隔的 12 / 15 / 18 / 21 / 24 個單字），
  //     使用��設衍生路徑（index 0）——此帳號即合約 owner。
  const looksMnemonic = /\s/.test(raw) && !raw.startsWith("0x");
  if (looksMnemonic) {
    const words = raw.split(/\s+/).length;
    if (![12, 15, 18, 21, 24].includes(words)) {
      throw new Error("RELAYER_PRIVATE_KEY 疑似助記詞但單字數不正確");
    }
    return mnemonicToAccount(raw);
  }
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("RELAYER_PRIVATE_KEY 格式錯誤（需為 0x + 64 hex 私鑰，或 BIP-39 助記詞）");
  }
  return privateKeyToAccount(key);
}

export function ownerWalletClient() {
  return createWalletClient({ account: ownerAccount(), chain: RELAYER_CHAIN, transport: http(RPC_URL) });
}

export function relayerAddress(): Address {
  return ownerAccount().address;
}

/** relayer 錢包目前的 Base Sepolia ETH 餘額（用來付所有 owner-only 交易的礦工費）。 */
export async function relayerEthBalance(): Promise<bigint> {
  return publicClient().getBalance({ address: relayerAddress() });
}

// 每筆 writeContract 在 Base Sepolia 上花費的 gas 很小，但認購/成交常常需要連續
// 兩筆交易（例如 AE 一級認購的 pullJcToVault + mintAe）。這裡保留約可覆蓋 5 筆
// 一般交易的餘裕，餘額低於此值就先擋下，避免交易卡在「送出但沒錢付 gas」的
// 半途狀態，讓使用者的 JC/USDT 已經被扣款卻拿不到對應的鏈上結算。
const MIN_RELAYER_ETH_WEI = parseEther("0.0015");

/**
 * 送出任何 owner-only 鏈上交易前的防呆檢查：relayer 錢包 ETH 太少會導致交易
 * 卡住甚至完全送不出去。這裡先讀鏈上餘額擋下，回報清楚的中文錯誤，而不是讓
 * 使用者卡在一個看不懂的底層 RPC 錯誤，或讓內部帳本已經扣款卻永遠等不到鏈上結算。
 */
export async function ensureRelayerGas(): Promise<void> {
  const balance = await relayerEthBalance();
  if (balance < MIN_RELAYER_ETH_WEI) {
    throw new Error(
      `relayer 錢包 Base Sepolia ETH 餘額過低（${formatEther(balance)} ETH），請管理員先儲值測試網 ETH 後再重試`,
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

function delegateAccount() {
  const raw = (process.env.DELEGATE_PRIVATE_KEY ?? "").trim();
  if (!raw) throw new Error("DELEGATE_PRIVATE_KEY 未設定");
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("DELEGATE_PRIVATE_KEY 格式錯誤（需為 0x + 64 hex 私鑰）");
  }
  return privateKeyToAccount(key);
}

function delegateWalletClient() {
  return createWalletClient({ account: delegateAccount(), chain: RELAYER_CHAIN, transport: http(RPC_URL) });
}

/** delegate（Allowance Module 額度動用者）錢包地址。不是 Safe owner，也不是任何合約 owner。 */
export function delegateAddress(): Address {
  return delegateAccount().address;
}

/** delegate 錢包目前的 Base Sepolia ETH 餘額（用來付 executeAllowanceTransfer 的礦工費）。 */
export async function delegateEthBalance(): Promise<bigint> {
  return publicClient().getBalance({ address: delegateAddress() });
}

const MIN_DELEGATE_ETH_WEI = parseEther("0.0015");

/** 同 ensureRelayerGas，但檢查的是 delegate 錢包（發放 JC/AE 用）。 */
export async function ensureDelegateGas(): Promise<void> {
  const balance = await delegateEthBalance();
  if (balance < MIN_DELEGATE_ETH_WEI) {
    throw new Error(
      `delegate 錢包 Base Sepolia ETH 餘額過低（${formatEther(balance)} ETH），請管理員先儲值測試網 ETH 後再重試`,
    );
  }
}

/**
 * 讀取 Allowance Module 上，Safe 金庫目前授權 delegate 動用某代幣的額度狀態。
 * 回傳皆為原始（未依代幣 decimals 轉換）big int，供 ensureAllowanceCanCover
 * 與 AdminPage 診斷卡片使用。resetTimeMin/lastResetMin/nonce 直接透傳供除錯。
 *
 * 注意：`amount`/`spent` 是合約 view function 內部已經套用過「若已到重置時間
 * 則視為 spent=0」邏輯之後的值（見 AllowanceModule.getAllowance 私有函式），
 * 因此這裡不需要自己再判斷是否該重置。
 */
export async function getAllowanceStatus(token: "jcToken" | "aeToken") {
  const tokenAddress = RELAYER_ADDRESSES[token];
  const [amount, spent, resetTimeMin, lastResetMin, nonce] = (await publicClient().readContract({
    address: RELAYER_ADDRESSES.allowanceModule,
    abi: allowanceModuleAbi,
    functionName: "getTokenAllowance",
    args: [RELAYER_ADDRESSES.safeVault, delegateAddress(), tokenAddress],
  })) as readonly [bigint, bigint, bigint, bigint, bigint];
  const decimals = await tokenDecimals(token);
  return {
    token,
    tokenAddress,
    decimals,
    amount,
    spent,
    remaining: amount > spent ? amount - spent : 0n,
    resetTimeMin,
    lastResetMin,
    nonce,
    registered: nonce > 0n,
    amountFormatted: formatUnits(amount, decimals),
    spentFormatted: formatUnits(spent, decimals),
    remainingFormatted: formatUnits(amount > spent ? amount - spent : 0n, decimals),
  };
}

/**
 * 送出「用 Allowance Module 額度發放給使用者」之前的預檢查。
 *  - nonce === 0 → Safe 擁有人還沒對這個 token 做過 setAllowance（delegate
 *    可能也還沒 addDelegate），丟出清楚指示要 Safe 擁有人做什麼操作的錯誤。
 *  - remaining 不足 → 今日額度已用完或設定的上限太低，需要管理員或 Safe
 *    擁有人重新設定 setAllowance 的每日額度。
 * amountUnits 已是代幣最小單位（wei）。
 */
export async function ensureAllowanceCanCover(
  token: "jcToken" | "aeToken",
  amountUnits: bigint,
): Promise<void> {
  const status = await getAllowanceStatus(token);
  const label = token === "jcToken" ? "JC" : "AE";
  if (!status.registered) {
    throw new Error(
      `Safe 尚未在 Allowance Module 對 delegate（${delegateAddress()}）設定 ${label} 額度。` +
        `請 Safe 擁有人（${RELAYER_ADDRESSES.safeVault}）用 Safe{Wallet} 對 Allowance Module` +
        `（${RELAYER_ADDRESSES.allowanceModule}）執行 addDelegate(${delegateAddress()}) →` +
        `setAllowance(${delegateAddress()}, ${status.tokenAddress}, 每日上限, 1440, 0)`,
    );
  }
  if (status.remaining < amountUnits) {
    throw new Error(
      `Allowance Module 額度不足：${label} 今日剩餘額度 ${status.remainingFormatted}，` +
        `需要 ${formatUnits(amountUnits, status.decimals)}。請 Safe 擁有人提高每日額度，或等待額度重置`,
    );
  }
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
 * 所有 owner-only 交易的唯一送出入口：在 relayer nonce 鎖內查詢當前 pending
 * nonce、組好交易並送出（不等待上鏈確認），一拿到 tx hash 就立刻釋放鎖。這是
 * 修掉「同時有兩筆交易在跑就可能 nonce 衝突」問題的關鍵——所有 mint/結算函式
 * 都必須透過這裡送出交易，不可以再各自直接呼叫 writeContract。
 */
async function sendOwnerTx(
  build: (nonce: number) => Promise<`0x${string}`>,
): Promise<`0x${string}`> {
  return withRelayerNonceLock(async () => {
    const nonce = await publicClient().getTransactionCount({
      address: relayerAddress(),
      blockTag: "pending",
    });
    return build(nonce);
  });
}

/** 同 sendOwnerTx，但用於 delegate 錢包自己的 nonce（Allowance Module 額度發放）。 */
async function sendDelegateTx(
  build: (nonce: number) => Promise<`0x${string}`>,
): Promise<`0x${string}`> {
  return withDelegateNonceLock(async () => {
    const nonce = await publicClient().getTransactionCount({
      address: delegateAddress(),
      blockTag: "pending",
    });
    return build(nonce);
  });
}

/**
 * 用 Safe Allowance Module 的額度，把 Safe 金庫既有庫存的代幣發放給指定地址。
 * 這是 mintJc/mintAe 的共用實作——delegate 錢包直接呼叫
 * executeAllowanceTransfer，signature 傳空 bytes 讓合約把 msg.sender（delegate
 * 自己）當作簽署人，不需要另外做 EIP-712 簽名。
 *
 * 鏈上強制的兩層限制：(1) token 必須是 Safe 曾經 setAllowance 過的白名單代幣，
 * (2) 累計轉出不能超過每日額度。**沒有**鏈上限制的是收款地址 `to`——這一層
 * 完全依賴呼叫端只能傳入從 profiles.wallet_address 讀出的地址（見
 * api/relayer.ts 的 settleMintJcCore/settleSubscribeCore，永遠不接受前端直接
 * 傳入任意地址）。amount 為人類可讀單位。
 */
export async function payoutViaAllowance(token: "jcToken" | "aeToken", to: Address, amount: number) {
  await ensureDelegateGas();
  const decimals = await tokenDecimals(token);
  const amountUnits = parseUnits(amount.toFixed(decimals), decimals);
  await ensureAllowanceCanCover(token, amountUnits);
  const hash = await sendDelegateTx((nonce) =>
    delegateWalletClient().writeContract({
      address: RELAYER_ADDRESSES.allowanceModule,
      abi: allowanceModuleAbi,
      functionName: "executeAllowanceTransfer",
      args: [
        RELAYER_ADDRESSES.safeVault,
        RELAYER_ADDRESSES[token],
        getAddress(to),
        amountUnits,
        "0x0000000000000000000000000000000000000000",
        0n,
        delegateAddress(),
        "0x",
      ],
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
  return waitAndReturn(hash);
}

/**
 * 發放 JC 給指定錢包：透過 Safe Allowance Module 的每日額度撥出（見
 * payoutViaAllowance），金庫餘額會隨每次兌換真實減少。amount 為人類可讀單位。
 */
export async function mintJc(to: Address, amount: number) {
  return payoutViaAllowance("jcToken", to, amount);
}

/** 一級認購結算：buyer 需先 approve JC 給認購合約（owner-only executeSubscription）。 */
export async function executeSubscription(buyer: Address, rwaUnits: number, paymentJc: number) {
  const [rwaDecimals, jcDecimals] = await Promise.all([tokenDecimals("rwaMaster"), tokenDecimals("jcToken")]);
  const hash = await sendOwnerTx((nonce) =>
    ownerWalletClient().writeContract({
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

/** 二級市場成交結算：seller approve RWA、buyer approve JC 後由 owner 撮合。 */
export async function executeRwaTrade(seller: Address, buyer: Address, rwaUnits: number, paymentJc: number) {
  const [rwaDecimals, jcDecimals] = await Promise.all([tokenDecimals("rwaMaster"), tokenDecimals("jcToken")]);
  const hash = await sendOwnerTx((nonce) =>
    ownerWalletClient().writeContract({
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

/**
 * 發放 AE 給指定錢包：同上 mintJc，透過 Safe Allowance Module 的每日額度撥出。
 * amount 為人類可讀單位。
 */
export async function mintAe(to: Address, amount: number) {
  return payoutViaAllowance("aeToken", to, amount);
}

/**
 * 把 buyer 的 JC 從其錢包 transferFrom 到 Safe 金庫（AE 一級認購第一步）。
 * buyer 需先 approve JC 給 relayer owner 地址，spender 才是本次 msg.sender。
 */
export async function pullJcToVault(from: Address, amountJc: number) {
  const decimals = await tokenDecimals("jcToken");
  const hash = await sendOwnerTx((nonce) =>
    ownerWalletClient().writeContract({
      address: RELAYER_ADDRESSES.jcToken,
      abi: jcAbi,
      functionName: "transferFrom",
      args: [getAddress(from), RELAYER_ADDRESSES.safeVault, parseUnits(amountJc.toFixed(decimals), decimals)],
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
  return waitAndReturn(hash);
}

/** AE 二級市場成交：seller approve AE、buyer approve JC 給市場後由 owner 撮合。 */
export async function executeAeTrade(seller: Address, buyer: Address, aeUnits: number, paymentJc: number) {
  const [aeDecimals, jcDecimals] = await Promise.all([tokenDecimals("aeToken"), tokenDecimals("jcToken")]);
  const hash = await sendOwnerTx((nonce) =>
    ownerWalletClient().writeContract({
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
  const hash = await sendOwnerTx((nonce) =>
    ownerWalletClient().writeContract({
      address: RELAYER_ADDRESSES.aeToken,
      abi: aeAbi,
      functionName: "setMarketContract",
      args: [RELAYER_ADDRESSES.aeSecondaryMarket],
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
  return { market: await waitAndReturn(hash) };
}

/** 一次性把子合約位址寫進 RWA 母合約，讓認購/二級合約有權移動 RWA。 */
export async function wireRwaContracts() {
  const [currentMarket, currentSub] = await Promise.all([
    publicClient().readContract({ address: RELAYER_ADDRESSES.rwaMaster, abi: rwaAbi, functionName: "marketContract" }),
    publicClient().readContract({ address: RELAYER_ADDRESSES.rwaMaster, abi: rwaAbi, functionName: "subscriptionContract" }),
  ]);
  const results: Record<string, string> = {};
  if (getAddress(currentSub as Address) !== RELAYER_ADDRESSES.rwaPrimarySale) {
    const hash = await sendOwnerTx((nonce) =>
      ownerWalletClient().writeContract({
        address: RELAYER_ADDRESSES.rwaMaster,
        abi: rwaAbi,
        functionName: "setSubscriptionContract",
        args: [RELAYER_ADDRESSES.rwaPrimarySale],
        chain: RELAYER_CHAIN,
        nonce,
      }),
    );
    results.subscription = await waitAndReturn(hash);
  } else {
    results.subscription = "already-set";
  }
  if (getAddress(currentMarket as Address) !== RELAYER_ADDRESSES.rwaSecondaryMarket) {
    const hash = await sendOwnerTx((nonce) =>
      ownerWalletClient().writeContract({
        address: RELAYER_ADDRESSES.rwaMaster,
        abi: rwaAbi,
        functionName: "setMarketContract",
        args: [RELAYER_ADDRESSES.rwaSecondaryMarket],
        chain: RELAYER_CHAIN,
        nonce,
      }),
    );
    results.market = await waitAndReturn(hash);
  } else {
    results.market = "already-set";
  }
  return results;
}
