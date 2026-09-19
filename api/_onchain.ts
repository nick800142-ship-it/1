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
//  - 移除 Safe 官方 Allowance Module 那條路徑（每日額度限制），改回「Safe
//    金庫維持持有 JC/AE 庫存，ADMIN 對 Safe 執行 transferFrom 撥出」——這是
//    使用者在權衡「單一熱錢包全權負責」與「額度限制」後明確選擇的模式。
//  - **已知風險（使用者已知情並選擇接受）**：Safe 擁有人需要對 ADMIN 地址
//    做一次「無上限 approve」，才能讓 transferFrom 動用金庫庫存。這代表
//    ADMIN_PRIVATE_KEY 一旦洩漏，攻擊者可在 Safe 核准的額度內（若是無上限
//    approve，等同整個金庫餘額）任意轉出 JC/AE，沒有 Allowance Module 那層
//    每日額度限制。務必只把這把私鑰放在後端環境變數，絕不寫進任何前端
//    程式碼、元件或 .env.local。
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
  parseEther,
  parseUnits,
  type Address,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { withAdminNonceLock } from "./_relayerLock";

export const RELAYER_CHAIN = baseSepolia;
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

export const RELAYER_ADDRESSES = {
  rwaMaster: normalizeOrThrow(
    process.env.NEXT_PUBLIC_RWA_MASTER_ADDRESS,
    "0x79F1C6aDFCcD916cde668D88a6dda3918e5d6835",
    "RWA 鑄造工廠合約",
  ),
  rwaPrimarySale: normalizeOrThrow(
    process.env.NEXT_PUBLIC_RWA_PRIMARY_SALE_ADDRESS,
    "0x1BF9Bfd5cFF90A3307ce4AaD0098A1AAEaBEaed0",
    "RWA 一級認購合約",
  ),
  rwaSecondaryMarket: normalizeOrThrow(
    process.env.NEXT_PUBLIC_RWA_SECONDARY_MARKET_ADDRESS,
    "0x9617b751445b8DF7f1c57f10b12065700c7a6117",
    "RWA 二級市場合約",
  ),
  jcToken: normalizeOrThrow(
    process.env.NEXT_PUBLIC_JC_TOKEN_ADDRESS,
    "0xF7Ac96B9b4e01A432c40501644C7721497faa446",
    "JC 結算代幣合約",
  ),
  // 手續費 / 認購 JC 的收款金庫，也是 JC/AE 發放給使用者時 transferFrom 的來源。
  safeVault: normalizeOrThrow(
    process.env.NEXT_PUBLIC_SAFE_VAULT_ADDRESS,
    "0xe886e67fd9CFe66fdb0A1F47cEf0001548a078cf",
    "Safe 金庫",
  ),
  // AE 代幣：刻意「不」讀 NEXT_PUBLIC_AE_TOKEN_ADDRESS —— 前端 Vite 只 inject
  // 4 個 NEXT_PUBLIC_* 變數（見 vite.config.ts），AE 位址不在其中，後端這裡
  // 直接用 contracts.ts 的正式位址作為唯一真相來源。
  aeToken: normalizeOrThrow(undefined, "0x38ceB1c4A4dC308eF668B75e56EbC468D451Ad5a", "AE 代幣合約"),
  aePrimarySale: normalizeOrThrow(undefined, "0x006a585f0B4aDF0663Dc2175A82D6BabbDc5e3A4", "AE 一級認購合約"),
  aeSecondaryMarket: normalizeOrThrow(
    undefined,
    "0x835D61FF69743B0f5F39223ba45F5062A7A5E5c9",
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

// JC/AE 都是標準 ERC-20（新部署，無 mint / market / safeVault 等自訂函式）。
// 發放給使用者一律 transferFrom(safeVault, to, amount)，因此只放本模組實際
// 會呼叫到的函式：transferFrom（發放 + 舊路徑相容）、balanceOf/allowance（發
// 放前的庫存與授權額度預檢查）、decimals。
const erc20MinimalAbi = [
  {
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transferFrom",
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
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
 * 送出「用 Safe 金庫既有庫存 transferFrom 發放給使用者」之前的預檢查：
 *  - Safe 金庫餘額不足 → 提示需要補充庫存。
 *  - Safe 對 ADMIN 的 allowance 不足 → 提示需要 Safe 擁有人補做一次 approve。
 * amountUnits 已是代幣最小單位（wei）。
 */
async function ensureVaultCanCover(token: "jcToken" | "aeToken", amountUnits: bigint): Promise<void> {
  const tokenAddress = RELAYER_ADDRESSES[token];
  const abi = token === "jcToken" ? jcAbi : aeAbi;
  const [balance, allowance] = await Promise.all([
    publicClient().readContract({
      address: tokenAddress,
      abi,
      functionName: "balanceOf",
      args: [RELAYER_ADDRESSES.safeVault],
    }) as Promise<bigint>,
    publicClient().readContract({
      address: tokenAddress,
      abi,
      functionName: "allowance",
      args: [RELAYER_ADDRESSES.safeVault, relayerAddress()],
    }) as Promise<bigint>,
  ]);
  const label = token === "jcToken" ? "JC" : "AE";
  if (allowance < amountUnits) {
    throw new Error(
      `Safe 金庫尚未授權足夠額度：請 Safe 擁有人用 Safe{Wallet} 對 ${label} 代幣` +
        `（${tokenAddress}）執行一次 approve(${relayerAddress()}, 足夠大的額度)`,
    );
  }
  if (balance < amountUnits) {
    throw new Error(`Safe 金庫 ${label} 庫存不足，請管理員先補充金庫庫存後再重試`);
  }
}

/**
 * 發放 JC/AE 給指定錢包：ADMIN 對 Safe 金庫既有庫存執行 transferFrom，金庫
 * 餘額會隨每次撥出真實減少。amount 為人類可讀單位。
 */
async function transferFromVault(token: "jcToken" | "aeToken", to: Address, amount: number) {
  await ensureRelayerGas();
  const decimals = await tokenDecimals(token);
  const amountUnits = parseUnits(amount.toFixed(decimals), decimals);
  await ensureVaultCanCover(token, amountUnits);
  const abi = token === "jcToken" ? jcAbi : aeAbi;
  const hash = await sendAdminTx((nonce) =>
    adminWalletClient().writeContract({
      address: RELAYER_ADDRESSES[token],
      abi,
      functionName: "transferFrom",
      args: [RELAYER_ADDRESSES.safeVault, getAddress(to), amountUnits],
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
  return waitAndReturn(hash);
}

/** 發放 JC 給指定錢包（見 transferFromVault）。 */
export async function mintJc(to: Address, amount: number) {
  return transferFromVault("jcToken", to, amount);
}

/** 發放 AE 給指定錢包（見 transferFromVault）。 */
export async function mintAe(to: Address, amount: number) {
  return transferFromVault("aeToken", to, amount);
}

/** RWA 一級認購結算：buyer 需先 approve JC 給認購合約。 */
export async function executeSubscription(buyer: Address, rwaUnits: number, paymentJc: number) {
  await ensureRelayerGas();
  const [rwaDecimals, jcDecimals] = await Promise.all([tokenDecimals("rwaMaster"), tokenDecimals("jcToken")]);
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

/** AE 一級認購結算：buyer 需先 approve JC 給 AE 一級認購合約。 */
export async function executeAeSubscription(buyer: Address, aeUnits: number, paymentJc: number) {
  await ensureRelayerGas();
  const [aeDecimals, jcDecimals] = await Promise.all([tokenDecimals("aeToken"), tokenDecimals("jcToken")]);
  const hash = await sendAdminTx((nonce) =>
    adminWalletClient().writeContract({
      address: RELAYER_ADDRESSES.aePrimarySale,
      abi: subscriptionAbi,
      functionName: "executeSubscription",
      args: [
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

/** 二級市場成交結算：seller approve RWA、buyer approve JC 後由 ADMIN 撮合。 */
export async function executeRwaTrade(seller: Address, buyer: Address, rwaUnits: number, paymentJc: number) {
  await ensureRelayerGas();
  const [rwaDecimals, jcDecimals] = await Promise.all([tokenDecimals("rwaMaster"), tokenDecimals("jcToken")]);
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

/** 一次性把子合約位址寫進 RWA 母合約，讓認購/二級合約有權移動 RWA。 */
export async function wireRwaContracts() {
  await ensureRelayerGas();
  const [currentMarket, currentSub] = await Promise.all([
    publicClient().readContract({ address: RELAYER_ADDRESSES.rwaMaster, abi: rwaAbi, functionName: "marketContract" }),
    publicClient().readContract({ address: RELAYER_ADDRESSES.rwaMaster, abi: rwaAbi, functionName: "subscriptionContract" }),
  ]);
  const results: Record<string, string> = {};
  if (getAddress(currentSub as Address) !== RELAYER_ADDRESSES.rwaPrimarySale) {
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
  } else {
    results.subscription = "already-set";
  }
  if (getAddress(currentMarket as Address) !== RELAYER_ADDRESSES.rwaSecondaryMarket) {
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
  } else {
    results.market = "already-set";
  }
  return results;
}

/**
 * 唯讀診斷：回報 Safe 金庫目前的 JC/AE 餘額，以及 Safe 對 ADMIN 熱錢包的
 * approve 額度，供 AdminPage 顯示「是否已完成手動設定」。純讀取，不做任何
 * 鏈上寫入。
 */
export async function getVaultStatus(token: "jcToken" | "aeToken") {
  const tokenAddress = RELAYER_ADDRESSES[token];
  const abi = token === "jcToken" ? jcAbi : aeAbi;
  const decimals = await tokenDecimals(token);
  const [balance, allowance] = await Promise.all([
    publicClient().readContract({
      address: tokenAddress,
      abi,
      functionName: "balanceOf",
      args: [RELAYER_ADDRESSES.safeVault],
    }) as Promise<bigint>,
    publicClient().readContract({
      address: tokenAddress,
      abi,
      functionName: "allowance",
      args: [RELAYER_ADDRESSES.safeVault, relayerAddress()],
    }) as Promise<bigint>,
  ]);
  return {
    token,
    tokenAddress,
    decimals,
    balance,
    allowance,
    balanceFormatted: formatUnits(balance, decimals),
    allowanceFormatted: formatUnits(allowance, decimals),
    approved: allowance > 0n,
  };
}
