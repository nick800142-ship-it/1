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
  type PublicClient,
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
  // 2026-10-04 重新部署（contracts/JCToken.sol）：移除舊合約的 P2P 轉帳限制，
  // owner 保留 mint 權限可再增發。同步 src/lib/contracts.ts。
  jcToken: normalizeOrThrow(undefined, "0x2D68f252827C754D0bE06628CEf2C7afE69Bf084", "JC 結算代幣合約"),
  // 手續費 / 認購 JC 的收款金庫。JC/AE 發放給使用者已改為 ADMIN 熱錢包直接
  // transfer，不再從這裡 transferFrom；這個地址僅保留供人工補貨轉帳時參考，
  // 程式碼中不會再讀取或動用這個地址的資產。
  safeVault: normalizeOrThrow(undefined, "0xe886e67fd9CFe66fdb0A1F47cEf0001548a078cf", "Safe 金庫"),
  usdt: normalizeOrThrow(undefined, "0x1d6E0eC7ef658758A5b3Dc518422E302A5436B85", "USDT 測試代幣"),
  // 2026-10-04 重新部署（contracts/AEToken.sol）：移除舊合約的「AE P2P 轉帳限制」，
  // 二級市場可直接 transferFrom(賣方→買方) 一次交割；owner 保留 mint 權限。
  // 同步 src/lib/contracts.ts。
  aeToken: normalizeOrThrow(undefined, "0x696207D80c6da932c5679C139C241bDD0D574547", "AE 代幣合約"),
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
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], name: "allowance", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], name: "approve", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], name: "transfer", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
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
  // 極少數情況下（RPC 尚未同步剛上鏈的狀態）這裡可能讀到零地址。絕不回傳零地址
  // 讓上層存進 DB，否則之後會被誤判為「已建立」而��死。此時直接丟錯，管理員用
  // 同一顆按鈕重試即可——屆����� tokenByPlacement ��回傳正確地址並自動回填。
  if (!tokenAddress || tokenAddress === "0x0000000000000000000000000000000000000000") {
    throw new Error("代幣已上鏈但暫時讀不到地址（RPC 尚未同步），請於數秒後用同一顆按鈕重試，系統會自動修復並回填地址");
  }
  return { tokenAddress: getAddress(tokenAddress), txHash: hash, alreadyExisted: false };
}

let cachedPublic: PublicClient | null = null;
export function publicClient(): PublicClient {
  if (!cachedPublic) {
    cachedPublic = createPublicClient({ chain: RELAYER_CHAIN, transport: http(RPC_URL) }) as PublicClient;
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

// ---------------------------------------------------------------------------
// 使用者錢包 Gas 贊助（平台代付）
// ---------------------------------------------------------------------------
//
// USDT 存在使用者「自己的」內嵌錢包（自我保管）。金庫入金（買 JC）與提領都需要
// 使用者本人簽名把自己的 USDT 轉出——這是自我保管資產的正確做法（尤其提領到任
// 意地址，絕不該由後端代簽）。但簽名送交易需要 Base Sepolia ETH 付 Gas，全新錢
// 包 ETH=0 時連交易都建立不出來（「insufficient funds for gas」）。
//
// 本站的 USDT 測試代幣不支援 EIP-2612 permit（已鏈上驗證 DOMAIN_SEPARATOR/nonces
// 都 revert），因此無法用「簽一次無 Gas 的 permit 讓 ADMIN 代轉」的方式；也不能
// 用「approve 一次再由 ADMIN transferFrom」，因為那個 approve 本身就是一筆需要
// Gas 的交易，一樣會被 ETH=0 擋住。
//
// 所以採「Gas 贊助」：使用者簽 USDT 交易前，後端 ADMIN 熱錢包先幫使用者錢包補
// 一點點 ETH（只夠付 Gas），使用者再用自己的錢包簽名。ETH 成本由平台承擔，收
// 款地址一律是「呼叫者本人」的錢包（伺服器端從 profiles.wallet_address 推導，不
// 信任前端），金額極小（每筆 USDT transfer 約 0.0000004 ETH）。
const SPONSOR_MIN_WEI = parseEther("0.00005"); // 低於此餘額才贊助
const SPONSOR_TARGET_WEI = parseEther("0.0003"); // 贊助後補到此餘額（可覆蓋數百筆交易）

export async function sponsorUserGas(
  userWallet: Address,
): Promise<{ sponsored: boolean; balanceWei: string; txHash?: string }> {
  const wallet = getAddress(String(userWallet).trim());
  const current = await publicClient().getBalance({ address: wallet });
  if (current >= SPONSOR_MIN_WEI) {
    return { sponsored: false, balanceWei: current.toString() };
  }
  // ADMIN 熱錢包本身要有足夠 ETH 付「這筆補助轉帳」的 Gas 與轉出的 value。
  await ensureRelayerGas();
  const topUp = SPONSOR_TARGET_WEI - current;
  const hash = await sendAdminTx((nonce) =>
    adminWalletClient().sendTransaction({
      to: wallet,
      value: topUp,
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
  await waitAndReturn(hash);
  const after = await publicClient().getBalance({ address: wallet });
  return { sponsored: true, balanceWei: after.toString(), txHash: hash };
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

const mintableAbi = [
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "mint",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/**
 * 管理員專用：在 JC/AE 新合約上呼叫 owner 的 `mint`，增發供給量給任意地址
 * （通常是 Safe 金庫）。這會真的增加代幣總供給量，與 transferFromHotWallet
 * （只是搬動熱錢包既有餘額）不同，故獨立成另一個函式、由獨立 action 把關。
 */
export async function mintTokenSupply(token: "jcToken" | "aeToken", to: Address, amount: number) {
  await ensureRelayerGas();
  const decimals = await tokenDecimals(token);
  const amountUnits = parseUnits(amount.toFixed(decimals), decimals);
  const hash = await sendAdminTx((nonce) =>
    adminWalletClient().writeContract({
      address: RELAYER_ADDRESSES[token],
      abi: mintableAbi,
      functionName: "mint",
      args: [getAddress(to), amountUnits],
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
  return waitAndReturn(hash);
}

/**
 * 由 ADMIN 熱錢包把指定 ERC-20 轉到已由伺服器驗證的網站錢包。
 * 合約地址必須由 API 從固定白名單或 placements.token_address 推導；不接受使用者任意合約地址。
 * 回傳交易雜湊但不等待收據，讓 API 能先保存雜湊，避免逾時後重複發送。
 */
export async function sendAdminAssetPayout(input: {
  tokenAddress: string;
  recipient: Address;
  amount: string;
  label: string;
}): Promise<`0x${string}`> {
  await ensureRelayerGas();
  const token = getAddress(input.tokenAddress);
  const decimals = Number(await publicClient().readContract({
    address: token,
    abi: erc20MinimalAbi,
    functionName: "decimals",
  }));
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`${input.label} 合約回傳了無效的小數位數`);
  }

  let amountUnits: bigint;
  try {
    amountUnits = parseUnits(input.amount, decimals);
  } catch {
    throw new Error(`${input.label} 數量超出代幣支援的小數位數`);
  }
  if (amountUnits <= 0n) throw new Error("派發數量必須大於 0");

  const balance = (await publicClient().readContract({
    address: token,
    abi: erc20MinimalAbi,
    functionName: "balanceOf",
    args: [relayerAddress()],
  })) as bigint;
  if (balance < amountUnits) {
    throw new Error(`ADMIN 熱錢包 ${input.label} 庫存不足，請先補貨後再派發`);
  }

  return sendAdminTx((nonce) =>
    adminWalletClient().writeContract({
      address: token,
      abi: erc20MinimalAbi,
      functionName: "transfer",
      args: [getAddress(input.recipient), amountUnits],
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
}

/** 等待已保存雜湊的轉帳收據；超時會丟出錯誤，呼叫端保留 pending 防止重複派發。 */
export async function waitForAdminAssetPayout(hash: `0x${string}`): Promise<boolean> {
  const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 20_000 });
  return receipt.status === "success";
}

/** 查詢經伺服器驗證的代幣地址及指定使用者錢包的鏈上餘額與 ADMIN allowance。 */
export async function getLegacyAssetChainState(tokenAddress: string, owner: Address) {
  const token = getAddress(tokenAddress);
  const decimals = Number(
    await publicClient().readContract({
      address: token,
      abi: erc20MinimalAbi,
      functionName: "decimals",
    }),
  );
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("資產代幣合約回傳了無效的小數位數");
  }
  const [balance, allowance] = (await Promise.all([
    publicClient().readContract({
      address: token,
      abi: erc20MinimalAbi,
      functionName: "balanceOf",
      args: [getAddress(owner)],
    }),
    publicClient().readContract({
      address: token,
      abi: erc20MinimalAbi,
      functionName: "allowance",
      args: [getAddress(owner), relayerAddress()],
    }),
  ])) as [bigint, bigint];
  return {
    decimals,
    balance: formatUnits(balance, decimals),
    allowance: formatUnits(allowance, decimals),
  };
}

/**
 * 使用者本人先簽署精確額度 approve 後，由 ADMIN 只把核准的舊資產數量轉入熱錢包。
 * tokenAddress 必須由 API 從 AE 固定地址或私募標的資料推導，不可採用前端傳值。
 */
export async function sendAdminAssetReclaim(input: {
  tokenAddress: string;
  owner: Address;
  amount: string;
  label: string;
}): Promise<`0x${string}`> {
  await ensureRelayerGas();
  const token = getAddress(input.tokenAddress);
  const owner = getAddress(input.owner);
  const decimals = Number(
    await publicClient().readContract({
      address: token,
      abi: erc20MinimalAbi,
      functionName: "decimals",
    }),
  );
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`${input.label} 合約回傳了無效的小數位數`);
  }
  let amountUnits: bigint;
  try {
    amountUnits = parseUnits(input.amount, decimals);
  } catch {
    throw new Error(`${input.label} 數量超出代幣支援的小數位數`);
  }
  if (amountUnits <= 0n) throw new Error("回收數量必須大於 0");

  const [allowance, balance] = (await Promise.all([
    publicClient().readContract({
      address: token,
      abi: erc20MinimalAbi,
      functionName: "allowance",
      args: [owner, relayerAddress()],
    }),
    publicClient().readContract({
      address: token,
      abi: erc20MinimalAbi,
      functionName: "balanceOf",
      args: [owner],
    }),
  ])) as [bigint, bigint];
  if (allowance < amountUnits) {
    throw new Error(`${input.label} 尚未授權或授權額度不足，請先在錢包簽署精確額度授權`);
  }
  if (balance < amountUnits) {
    throw new Error(`${input.label} 鏈上餘額已變動，請重新整理後確認可回收數量`);
  }

  return sendAdminTx((nonce) =>
    adminWalletClient().writeContract({
      address: token,
      abi: erc20MinimalAbi,
      functionName: "transferFrom",
      args: [owner, relayerAddress(), amountUnits],
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
}

/** 等待已保存的舊資產回收交易收據；超時時保留 pending 及 tx hash 以避免重複轉出。 */
export async function waitForAdminAssetReclaim(hash: `0x${string}`): Promise<boolean> {
  const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 20_000 });
  return receipt.status === "success";
}

/** 非阻塞地檢查已保存交易是否完成；RPC 查不到收據時保留 pending，不重送交易。 */
export async function getAdminAssetReclaimReceiptStatus(
  hash: `0x${string}`,
): Promise<"confirmed" | "failed" | "pending"> {
  try {
    const receipt = await publicClient().getTransactionReceipt({ hash });
    return receipt.status === "success" ? "confirmed" : "failed";
  } catch {
    return "pending";
  }
}

// ---------------------------------------------------------------------------
// JC 收款：使用者 → ADMIN → Safe金庫／賣方（兩跳）
// ---------------------------------------------------------------------------
//
// 新 JC 合約限制轉帳：鏈上實測只允許「與 owner(=ADMIN 熱錢包) 相關」的轉帳
// （transferFrom(使用者→ADMIN)、transfer(ADMIN→任意)），而使用者「直接」轉給
// Safe 金庫或其他使用者（真正的 P2P）會被合約 revert（`JC: Private P2P transfers
// are restricted`）。因此要把使用者付的 JC 收進金庫/轉給賣方，必須走兩跳：
//   1) pullJcFromUser：ADMIN 憑使用者一次性授權 transferFrom(使用者 → ADMIN)���
//   2) adminSendJc：ADMIN 用自己餘額 transfer(ADMIN → Safe金庫 或 賣方)。
// 兩端都與 ADMIN(owner) 相關，故都被合約允許。使用者需事先在 App 內對 JC 代幣
// approve ADMIN（一次 maxUint256，之後免簽），這樣管理員「一鍵補發」也能代收。

/**
 * 兩跳收款的第一跳：把 JC 從使用者錢包拉進 ADMIN 熱錢包（transferFrom(from→ADMIN)）。
 * 送出前預檢 from 對 ADMIN 的授權與 JC 餘額，任一不足丟出清楚中文錯誤（供上層據以
 * 擋下交易）——特別提醒分潤 JC 尚未上鏈，需先在金庫購買足額 JC。
 */
export async function pullJcFromUser(from: Address, jcAmount: number): Promise<string> {
  const decimals = await tokenDecimals("jcToken");
  return transferFromViaAdmin({
    token: RELAYER_ADDRESSES.jcToken,
    from,
    to: relayerAddress(),
    amountUnits: parseUnits(jcAmount.toFixed(decimals), decimals),
    noAllowanceMsg:
      "尚未授權平台動用您的 JC（或授權額度不足），無法完成鏈上 JC 收款。請在 App 內重新操作以完成一次性 JC 授權後再試。",
    lowBalanceMsg:
      "您的鏈上 JC 餘額不足以支付本筆金額。注意：分潤 JC 僅記在站內帳本、尚未上鏈，需先在錢包金庫用 USDT 購買足額 JC 才能認購或交易。",
  });
}

/**
 * 兩跳收款的第二跳：ADMIN 熱錢包用自己的 JC 餘額 transfer 給 `to`（Safe 金庫或
 * 賣方）。因與 owner 相關，JC 合約允許。amount<=0 回傳 null（無需轉帳）。
 */
export async function adminSendJc(to: Address, jcAmount: number): Promise<string | null> {
  if (!(jcAmount > 0)) return null;
  await ensureRelayerGas();
  const decimals = await tokenDecimals("jcToken");
  const amountUnits = parseUnits(jcAmount.toFixed(decimals), decimals);
  await ensureHotWalletCanCover("jcToken", amountUnits);
  const hash = await sendAdminTx((nonce) =>
    adminWalletClient().writeContract({
      address: RELAYER_ADDRESSES.jcToken,
      abi: jcAbi,
      functionName: "transfer",
      args: [getAddress(to), amountUnits],
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
  return waitAndReturn(hash);
}

/** 兩跳收款的第二跳（收進 Safe 金庫）：ADMIN → Safe 金庫。 */
export async function sendJcToVault(jcAmount: number): Promise<string | null> {
  return adminSendJc(RELAYER_ADDRESSES.safeVault, jcAmount);
}

/**
 * 把 JC 從買方錢包實際收進 Safe 金庫。
 *
 * 用途：一級認購本金 JC（買方付款）需真的回到 Safe 金庫。做法採「買方一次性
 * 授權 ADMIN，relayer 代收」模型——買方先在 App 內對 JC 代幣 approve ADMIN 熱
 * 錢包（一次 maxUint256，之後免簽），之後由 ADMIN 用該授權執行
 * `transferFrom(買方 → Safe, amount)`。這樣管理員「一鍵補發」也能代收（不需要
 * 買方當下在線簽名），只要買方先前授權過且鏈上 JC 餘額足夠即可。
 *
 * 送出前預檢買方對 ADMIN 的授權額度與 JC 餘額，任一不足就丟出清楚中文錯誤而
 * 不送出注定 revert 的交易。amount<=0 時回傳 null（無需收款）。
 */
export async function collectJcToVault(from: Address, jcAmount: number): Promise<string | null> {
  return collectJc(from, RELAYER_ADDRESSES.safeVault, jcAmount, {
    noAllowanceMsg:
      "買方尚未授權平台動用其 JC（或授權額度不足），無法把認購 JC 收進金庫。請買方在 App 內重新送出一次認購以完成一次性 JC 授權後再重試。",
    lowBalanceMsg: "買方 JC 鏈上餘額不足，無法把認購 JC 收進 Safe 金庫��",
  });
}

/**
 * 通用「ADMIN 憑買方一次性授權，把 JC 從 `from` 轉到 `to`」。
 *
 * 二級市場成交也用此模型把 JC 分流：買方付的 gross JC 拆成 net→賣方、fee→Safe
 * 金庫兩筆 transferFrom（都動用買方對 ADMIN 的授權）。與認購共用同一套「買方
 * 一次性授權 ADMIN、relayer 代收」機制，因此管理員一鍵補發也能代收（不需買方
 * 當下在線簽名）。送出前預檢買方對 ADMIN 的授權與 JC 餘額，任一不足丟清楚中文
 * 錯誤而不送出注定 revert 的交易。amount<=0 回傳 null（無需轉帳）。
 */
export async function collectJc(
  from: Address,
  to: Address,
  jcAmount: number,
  msgs?: { noAllowanceMsg?: string; lowBalanceMsg?: string },
): Promise<string | null> {
  if (!(jcAmount > 0)) return null;
  const decimals = await tokenDecimals("jcToken");
  return transferFromViaAdmin({
    token: RELAYER_ADDRESSES.jcToken,
    from,
    to,
    amountUnits: parseUnits(jcAmount.toFixed(decimals), decimals),
    noAllowanceMsg:
      msgs?.noAllowanceMsg ??
      "買方尚未授權平台動用其 JC（或授權額度不足），無法完成鏈上 JC 收付。請買方在 App 內重新操作以完成一次性 JC 授權後再重試。",
    lowBalanceMsg: msgs?.lowBalanceMsg ?? "買方 JC 鏈上餘額不足，無法完成鏈上 JC 收付。",
  });
}

/**
 * 二級市場交割：ADMIN 憑賣方一次性授權，把賣方持有的標的代幣（RWA 專屬份額 /
 * AE）transferFrom 給買方。與 JC 收付對稱——賣方掛賣單時已一次性 approve 該
 * 代幣給 ADMIN，因此被自動撮合或由管理員補發時都能代交割，不需賣方當下在線。
 */
async function deliverAssetFromSeller(
  assetToken: Address,
  seller: Address,
  buyer: Address,
  units: number,
  isShareToken: boolean,
): Promise<string> {
  const decimals = isShareToken ? await shareTokenDecimals(assetToken) : await tokenDecimals("aeToken");
  return transferFromViaAdmin({
    token: assetToken,
    from: seller,
    to: buyer,
    amountUnits: parseUnits(String(units), decimals),
    noAllowanceMsg:
      "賣方尚未授權平台動用其持有的標的代幣（或授權額度不足），無法完成鏈上交割。請賣方在 App 內重新掛單以完���一次性授權後再重試。",
    lowBalanceMsg: "賣方鏈上標的代幣餘額不足，無法完成鏈上交割。",
  });
}

/**
 * 「ADMIN 憑 `from` 的一次性授權，用 transferFrom 把 `token` 從 `from` 轉到
 * `to`」的共用底層。所有二級收付/交割與認購收款都經此送出，統一預檢
 * allowance/balance 並沿用 sendAdminTx 的 nonce 鎖。amountUnits 為代幣最小單位。
 */
async function transferFromViaAdmin(params: {
  token: Address;
  from: Address;
  to: Address;
  amountUnits: bigint;
  noAllowanceMsg: string;
  lowBalanceMsg: string;
}): Promise<string> {
  const { token, from, to, amountUnits, noAllowanceMsg, lowBalanceMsg } = params;
  await ensureRelayerGas();
  const owner = getAddress(from);
  const spender = relayerAddress();
  const [allowance, balance] = (await Promise.all([
    publicClient().readContract({ address: token, abi: erc20MinimalAbi, functionName: "allowance", args: [owner, spender] }),
    publicClient().readContract({ address: token, abi: erc20MinimalAbi, functionName: "balanceOf", args: [owner] }),
  ])) as [bigint, bigint];
  if (allowance < amountUnits) throw new Error(noAllowanceMsg);
  if (balance < amountUnits) throw new Error(lowBalanceMsg);
  const hash = await sendAdminTx((nonce) =>
    adminWalletClient().writeContract({
      address: token,
      abi: erc20MinimalAbi,
      functionName: "transferFrom",
      args: [owner, getAddress(to), amountUnits],
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
  return waitAndReturn(hash);
}

/**
 * 發放 RWA 份額給指定錢包：ADMIN 熱錢包直接用標準 ERC-20 transfer 動用自己
 * 持有的該標的專屬代幣餘額轉給買方，不經過 approve/allowance/transferFrom，
 * 也不在鏈上向買方收 JC。庫存由人工從 Safe 金庫（建立代幣時全額鑄入）轉一批
 * 到 ADMIN 熱錢包補貨。amount 為人類可讀單位（份數）。
 */
async function transferShareFromHotWallet(token: Address, to: Address, amount: number) {
  await ensureRelayerGas();
  const decimals = await shareTokenDecimals(token);
  const amountUnits = parseUnits(String(amount), decimals);
  const balance = (await publicClient().readContract({
    address: token,
    abi: shareTokenAbi,
    functionName: "balanceOf",
    args: [relayerAddress()],
  })) as bigint;
  if (balance < amountUnits) {
    throw new Error(
      `ADMIN 熱錢包此 RWA 份額（代幣 ${token}）庫存不足，請管理員先從 Safe 金庫把份額轉入熱錢包（${relayerAddress()}）後重試`,
    );
  }
  const hash = await sendAdminTx((nonce) =>
    adminWalletClient().writeContract({
      address: token,
      abi: shareTokenAbi,
      functionName: "transfer",
      args: [getAddress(to), amountUnits],
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
  return waitAndReturn(hash);
}

/**
 * RWA 一級認購結算（2026-09-20 改為「只發份額」，比照 AE）。
 *
 * 背景：RWA Factory 的 subscribe() 是「原子雙動作」——除了從 ADMIN 熱錢包
 * 撥份額給買方，還會 `JC.transferFrom(buyer, …)` 在鏈上向買方收 JC，需要買方
 * 本人事先對 Factory 簽 approve。這造成管理員代買方一鍵補發時無法代簽 JC
 * approve（買方對 Factory 的 JC allowance 為 0），鏈上必然 revert，但站內
 * jc_ledger 早已扣過 JC，兩邊不一致。
 *
 * 依使用者決定改為「只發份額」：站內帳本已完成 JC 扣款、鏈上 JC 餘額也已不對
 * 使用者顯示，因此鏈上這一步只需由 ADMIN 熱錢包 transfer 該標的專屬代幣份額
 * 給買方即可，不再向買方收 JC。這樣補發一定成功，且不受買方 JC 來源與 approve
 * 狀態影響。paymentJc 僅保留給呼叫端相容，鏈上不再使用。
 *
 * `factoryToken`（= private_placements.token_address）必須有值：即該標的須先在
 * RWA Factory 建立過專屬代幣、並把份額從 Safe 金庫轉入 ADMIN 熱錢包。尚未建立
 * 代幣的標的無份額可發，直接丟出清楚錯誤，而非呼叫已停用的舊 rwaPrimarySale。
 */
export async function executeSubscription(
  buyer: Address,
  rwaUnits: number,
  _paymentJc?: number,
  factoryToken?: Address,
) {
  if (!factoryToken) {
    throw new Error(
      "此 RWA 標的尚未在 RWA Factory 建立專屬代幣，無法鏈上發放份額。請先在後台標的編輯器「一鍵建立 RWA 代幣」並回填代幣地址，再把份額從 Safe 金庫轉入 ADMIN 熱錢包後重試。",
    );
  }
  return transferShareFromHotWallet(factoryToken, buyer, rwaUnits);
}

/**
 * AE 一級認購結算（2026-09-20 改為「只發 AE」）。
 *
 * 背景：`aePrimarySale` 合約的 executeSubscription() 會「同時」在鏈上向買方
 * 收 JC（`JC.transferFrom(buyer, …)`，需買方本人事先簽署 approve）＋從 owner
 * (ADMIN) 撥 AE 給買方。這造成兩個問題：(1) 管理員代買方補發時無法代簽 JC
 * approve；(2) 換過合約位址後買方對新合約的 JC allowance 為 0，導致鏈上必然
 * revert，但站內 jc_ledger 早已扣過 JC。
 *
 * 依使用者決定：站內帳本已完成 JC 扣款，鏈上 JC 餘額也已不對使用者顯示，因此
 * 鏈上這一步「只發 AE」即可——直接由 ADMIN 熱錢包 transfer AE 給買方，不再向
 * 買方收 JC。這樣補發一定成功，且不受買方 JC 來源（金庫/二級/分潤）與 approve
 * 狀態影響。paymentJc 僅保留給呼叫端相容，鏈上不再使用。
 */
export async function executeAeSubscription(buyer: Address, aeUnits: number, _paymentJc?: number) {
  return transferFromHotWallet("aeToken", buyer, aeUnits);
}

// 平台二級市場「每筆成交」手續費公式（與 fill_p2p_order/settle_p2p_match 的
// `platform_fee := round(gross*0.01,6)` 一致）。2026-09-21 起移除舊的「+1 JC」
// 固定項——那筆固定 1 JC 改成賣家「掛賣單」時一次性收取（見 create_p2p_order 的
// p2p_listing_fee 與 relayer 的 list-fee action），避免一張賣單被多位買家分批
// 買走時重複收取固定費。每筆成交這裡只收成交額的 1%。RWA Factory 的 trade()
// 需要呼叫端明確拆出 paymentToSeller / feeAmount，因此這裡在後端重算同一條公式。
export function splitTradeFee(gross: number): { net: number; fee: number } {
  const fee = Math.round(gross * 0.01 * 1e6) / 1e6;
  const net = Math.round((gross - fee) * 1e6) / 1e6;
  return { net, fee };
}

/**
 * 二級市場「交割」（2026-09-20 改為 relayer 代扣付，取代原子市場合約）。
 *
 * 這裡只負責把標的份額從賣方交割給買方；JC 的收付（買方 gross → 賣方 net、
 * 平台 fee → Safe 金庫）由 relayer core 用 collectJc 另外處理，兩邊都採「一次性
 * 授權 ADMIN、relayer transferFrom」模型。這樣二級與認購共用同一套收付機制，
 * 手續費 JC 會實際進 Safe 金庫，且被自動撮合或管理員補發時都能代為完成。
 *
 * `factoryToken`（= private_placements.token_address）必須有值：即該 RWA 標的須
 * 先在 Factory 建立過專屬份額代幣。無值則丟清楚錯誤，不再呼叫已停用的舊
 * rwaSecondaryMarket 合約。
 */
export async function executeRwaTrade(
  seller: Address,
  buyer: Address,
  rwaUnits: number,
  factoryToken?: Address,
) {
  if (!factoryToken) {
    throw new Error(
      "此 RWA 標的尚未在 RWA Factory 建立專屬代幣，無法鏈上交割份額。請先在後台建立 RWA 代幣並回填代幣地址後重試。",
    );
  }
  return deliverAssetFromSeller(factoryToken, seller, buyer, rwaUnits, true);
}

/**
 * AE 二級市場交割（2026-10-04 修復）：ADMIN 憑賣方一次性授權把 AE 從賣方交割
 * 給買方（JC 收付另處理）。
 *
 * 背景：鏈上探測發現 AE_Token 合約跟 JC_Token 一樣內建「Private P2P transfers
 * are restricted」限制——只允許跟 owner（ADMIN 熱錢包）有關的轉帳方向，使用者
 * 對使用者的直接 transferFrom（賣方→買方）一律 revert。原本直接呼叫
 * `deliverAssetFromSeller` 做單跳 transferFrom(賣方→買方) 因此必然失敗。
 *
 * 修法比照 JC 的兩跳模式：第一跳 transferFrom(賣方→ADMIN)（使用者→ADMIN，
 * 合約允許，賣方掛賣單時已一次性 approve ADMIN）；第二跳 ADMIN 用自己餘額
 * transfer(買方)（ADMIN→使用者，合約允許）。不需要改動或重新部署 AE 合約。
 */
export async function executeAeTrade(seller: Address, buyer: Address, aeUnits: number) {
  await pullAeFromSeller(seller, aeUnits);
  const hash = await transferFromHotWallet("aeToken", buyer, aeUnits);
  if (!hash) throw new Error("AE 交割失敗：ADMIN 轉出 AE 給買方未送出交易。");
  return hash;
}

/**
 * AE 二級交割第一跳：ADMIN 憑賣方一次性授權，把 AE 從賣方 transferFrom 到
 * ADMIN 熱錢包自己（與 owner 相關，AE 合約允許）。
 */
async function pullAeFromSeller(seller: Address, aeUnits: number): Promise<string> {
  const decimals = await tokenDecimals("aeToken");
  return transferFromViaAdmin({
    token: RELAYER_ADDRESSES.aeToken,
    from: seller,
    to: relayerAddress(),
    amountUnits: parseUnits(String(aeUnits), decimals),
    noAllowanceMsg:
      "賣方尚未授權平台動用其持有的 AE（或授權額度不足），無法完成鏈上交割。請賣方在 App 內重新掛單以完成一次性授權後再重試。",
    lowBalanceMsg: "賣方鏈上 AE 餘額不足，無法完成鏈上交割。",
  });
}

/** wireRwaContracts 的回傳型別：每個子合約各自回報狀態，任一項失敗都��影響另一項。 */
export type WireResult = {
  subscription: string; // tx hash | "already-set"
  market: string; // tx hash | "already-set" | "failed"
  marketError?: string; // market 設定失敗時的人類可讀原因
};

/** 讀取母合約上某個 address getter；若該 getter 在鏈上 revert（��版工廠合約的
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
// 讀 ADMIN 熱錢包在某顆 RWA 專屬份額代幣的鏈上餘額（唯讀診斷用）。
// 地址是動態的（存於 private_placements.token_address），故不走 RELAYER_ADDRESSES。
export async function getHotWalletShareBalance(tokenAddress: string): Promise<{
  tokenAddress: Address;
  decimals: number;
  balanceFormatted: string;
}> {
  const token = getAddress(tokenAddress.trim());
  const decimals = await shareTokenDecimals(token);
  const balance = (await publicClient().readContract({
    address: token,
    abi: shareTokenAbi,
    functionName: "balanceOf",
    args: [relayerAddress()],
  })) as bigint;
  return { tokenAddress: token, decimals, balanceFormatted: formatUnits(balance, decimals) };
}

// 讀「任一使用者錢包」在某顆 RWA 專屬份額代幣的鏈上真實餘額（唯讀）。
// 用於把「使用者從 Safe 金庫直接鏈上轉入、繞過站內帳本」的份額，反映回
// holdings 帳��（見 relayer.ts 的 sync-holding action）。回傳整數份額字串／數值。
export async function getWalletShareBalance(
  tokenAddress: string,
  walletAddress: string,
): Promise<{ tokenAddress: Address; decimals: number; balance: number; balanceFormatted: string }> {
  const token = getAddress(tokenAddress.trim());
  const wallet = getAddress(walletAddress.trim());
  const decimals = await shareTokenDecimals(token);
  const balance = (await publicClient().readContract({
    address: token,
    abi: shareTokenAbi,
    functionName: "balanceOf",
    args: [wallet],
  })) as bigint;
  const balanceFormatted = formatUnits(balance, decimals);
  return { tokenAddress: token, decimals, balance: Number(balanceFormatted), balanceFormatted };
}

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
