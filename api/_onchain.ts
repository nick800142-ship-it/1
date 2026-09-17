// 後端 relayer 的鏈上工具模組（Vercel serverless / Node runtime）。
//
// 這裡持有「合約 owner」的私鑰（RELAYER_PRIVATE_KEY），用來代發所有 onlyOwner
// 的鏈上交易：JC/RWA 一級/二級結算、以及一次性把子合約位址寫進 RWA 母合約。
// 私鑰只存在後端環境變數，永遠不會回傳給前端。
//
// RWA、JC、AE 都走真實鏈上流程：RWA 一級/二級透過對應合約，AE 一級採兩步
// （transferFrom JC → 從金庫 transferFrom AE）、AE 二級透過 AE_Market_Thin.executeTrade。
//
// 2026-09-18：JC／AE 的「發放給使用者」已從 mintReward（憑空鑄造）改成
// transferFrom(safeVault, to, amount)——真的從 Safe 金庫既有庫存撥出，金庫
// 餘額會隨每次兌換真實減少，符合「金庫兌換」的商業邏輯。前提：Safe 是多簽
// 錢包（此專案 threshold=1，owner 是 Safe 自己的簽署人，不是 relayer），
// relayer 私鑰無法代表 Safe 簽署交易，因此 Safe 擁有人必須先手動執行一次性
// 的 `approve(relayer, 足夠大的額度)`，之後 relayer 才能每次都自動用
// transferFrom 撥款，不需要 Safe 再簽署第二次。詳見 ensureVaultCanCover。
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
import { withRelayerNonceLock } from "./_relayerLock";

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
//
// 2026-09-18：JC/AE 的「發放」已改為從 Safe 金庫實際 transferFrom 既有庫存，
// 不再 mintReward 憑空鑄造——金庫餘額會隨每次兌換真實減少。前提是 Safe 必須
// 先對 relayer 做過一次性 approve（見 ensureVaultCanCover 的錯誤訊息說明），
// 因此這裡也需要 balanceOf/allowance 供發放前的預檢查使用。
const jcAbi = [
  { inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], name: "mintReward", outputs: [], stateMutability: "nonpayable", type: "function" },
  // 金庫發放 JC、以及 AE 一級認購把 buyer 的 JC transferFrom 到金庫，都是同一個
  // ERC-20 transferFrom（msg.sender 為 relayer owner，需先取得對應方 approve）。
  { inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }], name: "transferFrom", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], name: "allowance", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
] as const;

// AE 代幣：transferFrom 用於金庫發放 AE 給認購者（同上，改為真實庫存轉帳而非
// mintReward）；setMarketContract 用於把代幣的授權市場重新指到我們採用的新市場合約。
const aeAbi = [
  { inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], name: "mintReward", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }], name: "transferFrom", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], name: "allowance", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
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
  const raw = (process.env.RELAYER_PRIVATE_KEY ?? "").trim();
  if (!raw) throw new Error("RELAYER_PRIVATE_KEY 未設定");
  // 支援兩種格式：
  //  1. 原始私鑰（0x + 64 hex，或不含 0x 的 64 hex）
  //  2. BIP-39 助記詞（以空白分隔的 12 / 15 / 18 / 21 / 24 個單字），
  //     使用預設衍生路徑（index 0）——此帳號即合約 owner。
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

/**
 * 送出「從 Safe 金庫 transferFrom 給使用者」之前的預檢查：Safe 是多簽錢包
 * （threshold=1，owner 不是 relayer），relayer 的私鑰無法代表 Safe 簽署任何
 * 交易，所以 Safe 必須先自己執行過一次性的 `approve(relayer, 一個足夠大的額度)`
 * 才能讓 relayer 之後每一筆都用 transferFrom 自動撥款——之後就完全不需要
 * Safe 再手動簽署，也完全不必再用 mint 憑空鑄造。
 *
 * 這裡在真正呼叫合約前，先讀一次 Safe 的餘額與對 relayer 的 allowance：
 *  - allowance 不足 → 代表 Safe 還沒做過那次性 approve（或額度用完了），
 *    丟出清楚指示要 Safe 擁有人做什麼操作的錯誤，而不是讓 transferFrom
 *    在鏈上 revert 成一句看不懂的 ERC20InsufficientAllowance。
 *  - balance 不足 → 代表金庫實際庫存不夠了，需要管理員補充庫存。
 */
export async function ensureVaultCanCover(token: "jcToken" | "aeToken", amount: number): Promise<void> {
  const address = RELAYER_ADDRESSES[token];
  const abi = token === "jcToken" ? jcAbi : aeAbi;
  const decimals = await tokenDecimals(token);
  const needed = parseUnits(amount.toFixed(decimals), decimals);
  const [balance, allowance] = await Promise.all([
    publicClient().readContract({ address, abi, functionName: "balanceOf", args: [RELAYER_ADDRESSES.safeVault] }),
    publicClient().readContract({
      address,
      abi,
      functionName: "allowance",
      args: [RELAYER_ADDRESSES.safeVault, relayerAddress()],
    }),
  ]);
  const label = token === "jcToken" ? "JC" : "AE";
  if ((allowance as bigint) < needed) {
    throw new Error(
      `Safe 金庫尚未授權 relayer 動用 ${label}（目前額度 ${formatUnits(allowance as bigint, decimals)}）。` +
        `請 Safe 擁有人（${RELAYER_ADDRESSES.safeVault}）用 Safe{Wallet} 對 ${label} 代幣合約（${address}）` +
        `執行一次性 approve(${relayerAddress()}, 足夠大的額度)，之後所有兌換即可完全自動化，不需要再手動簽署`,
    );
  }
  if ((balance as bigint) < needed) {
    throw new Error(`Safe 金庫 ${label} 庫存不足（剩餘 ${formatUnits(balance as bigint, decimals)}），請管理員補充金庫庫存`);
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

/**
 * 發放 JC 給指定錢包：從 Safe 金庫既有庫存 transferFrom 撥出（不再 mintReward
 * 憑空鑄造），金庫餘額會隨每次兌換真實減少，符合金庫真的在「賣出」JC 的商業
 * 邏輯。前提是 Safe 已對 relayer 做過一次性 approve，見 ensureVaultCanCover。
 * amount 為人類可讀單位。
 */
export async function mintJc(to: Address, amount: number) {
  await ensureVaultCanCover("jcToken", amount);
  const decimals = await tokenDecimals("jcToken");
  const hash = await sendOwnerTx((nonce) =>
    ownerWalletClient().writeContract({
      address: RELAYER_ADDRESSES.jcToken,
      abi: jcAbi,
      functionName: "transferFrom",
      args: [RELAYER_ADDRESSES.safeVault, getAddress(to), parseUnits(amount.toFixed(decimals), decimals)],
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
  return waitAndReturn(hash);
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
 * 發放 AE 給指定錢包：從 Safe 金庫既有庫存 transferFrom 撥出（不再 mintReward
 * 憑空鑄造），同上 mintJc 的理由。amount 為人類可讀單位。
 */
export async function mintAe(to: Address, amount: number) {
  await ensureVaultCanCover("aeToken", amount);
  const decimals = await tokenDecimals("aeToken");
  const hash = await sendOwnerTx((nonce) =>
    ownerWalletClient().writeContract({
      address: RELAYER_ADDRESSES.aeToken,
      abi: aeAbi,
      functionName: "transferFrom",
      args: [RELAYER_ADDRESSES.safeVault, getAddress(to), parseUnits(amount.toFixed(decimals), decimals)],
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
  return waitAndReturn(hash);
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
