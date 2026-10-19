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
  fallback,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseAbiItem,
  parseEther,
  parseUnits,
  type Address,
  type PublicClient,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { IS_MAINNET, NETWORK_CHAIN, NETWORK_RPC_URLS } from "./_network";
import { MAINNET_RELAYER_ADDRESSES } from "./_mainnetConfig";
import type { SupabaseClient } from "@supabase/supabase-js";
import { withAdminNonceLock } from "./_relayerLock";
// Keep serverless contract config in the API bundle; importing the frontend
// contracts module makes Vercel's CommonJS relayer require an ESM file at runtime.
// 2026-10-17 部署的可調費率託管合約：所有新掛單都走這裡。
export const P2P_ESCROW_ADDRESS: Address = IS_MAINNET
  ? MAINNET_RELAYER_ADDRESSES.p2pEscrow
  : normalizeOrThrow(undefined, "0x587F60cc0833b5988197373D51F737d942192397", "P2P 託管合約");
// 舊託管合約（費率寫死 1% / 1 JC）：不再接受新掛單，但既有掛單可照常成交、撮合與取消直到清空。
export const P2P_ESCROW_LEGACY_ADDRESSES: readonly Address[] = IS_MAINNET
  ? []
  : [normalizeOrThrow(undefined, "0xBfb3456226cA1e46Cf2BDB3b2d42619a2B7B8Db0", "舊 P2P 託管合約")];
export const P2P_ESCROW_KNOWN_ADDRESSES: readonly Address[] = [P2P_ESCROW_ADDRESS, ...P2P_ESCROW_LEGACY_ADDRESSES];

export function isKnownP2PEscrow(address: string): boolean {
  return P2P_ESCROW_KNOWN_ADDRESSES.some((known) => known.toLowerCase() === address.toLowerCase());
}

export const P2P_ESCROW_ABI = [
  {
    type: "function",
    name: "createOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "clientOrderId", type: "bytes32" },
      { name: "isSell", type: "bool" },
      { name: "assetToken", type: "address" },
      { name: "currencyToken", type: "address" },
      { name: "price", type: "uint256" },
      { name: "quantity", type: "uint256" },
    ],
    outputs: [{ name: "orderId", type: "uint256" }],
  },
    {
      type: "function",
      name: "matchEscrowOrders",
      stateMutability: "nonpayable",
      inputs: [
        { name: "buyOrderId", type: "uint256" },
        { name: "sellOrderId", type: "uint256" },
        { name: "quantity", type: "uint256" },
        { name: "fillKey", type: "bytes32" },
      ],
      outputs: [
        {
          name: "result",
          type: "tuple",
          components: [
            { name: "orderId", type: "uint256" },
            { name: "buyer", type: "address" },
            { name: "seller", type: "address" },
            { name: "quantity", type: "uint256" },
            { name: "gross", type: "uint256" },
            { name: "fee", type: "uint256" },
          ],
        },
        { name: "duplicate", type: "bool" },
      ],
    },
    {
      type: "function",
      name: "fillOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "uint256" },
      { name: "quantity", type: "uint256" },
      { name: "fillKey", type: "bytes32" },
    ],
    outputs: [
      {
        name: "result",
        type: "tuple",
        components: [
          { name: "orderId", type: "uint256" },
          { name: "buyer", type: "address" },
          { name: "seller", type: "address" },
          { name: "quantity", type: "uint256" },
          { name: "gross", type: "uint256" },
          { name: "fee", type: "uint256" },
        ],
      },
      { name: "duplicate", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "cancelOrder",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "uint256" }],
    outputs: [{ name: "refundedAmount", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalLocked",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "feeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "listingFee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "setFees",
    stateMutability: "nonpayable",
    inputs: [
      { name: "newFeeBps", type: "uint256" },
      { name: "newListingFee", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "OrderCreated",
    anonymous: false,
    inputs: [
      { indexed: true, name: "orderId", type: "uint256" },
      { indexed: true, name: "clientOrderId", type: "bytes32" },
      { indexed: true, name: "maker", type: "address" },
      { indexed: false, name: "isSell", type: "bool" },
      { indexed: false, name: "assetToken", type: "address" },
      { indexed: false, name: "currencyToken", type: "address" },
      { indexed: false, name: "price", type: "uint256" },
      { indexed: false, name: "quantity", type: "uint256" },
      { indexed: false, name: "listingFee", type: "uint256" },
    ],
  },
  // 新版合約的 OrderCreated 多了 feeBps（不同 topic selector）；viem 依 selector 對應解碼，新舊兩版都能解析。
  {
    type: "event",
    name: "OrderCreated",
    anonymous: false,
    inputs: [
      { indexed: true, name: "orderId", type: "uint256" },
      { indexed: true, name: "clientOrderId", type: "bytes32" },
      { indexed: true, name: "maker", type: "address" },
      { indexed: false, name: "isSell", type: "bool" },
      { indexed: false, name: "assetToken", type: "address" },
      { indexed: false, name: "currencyToken", type: "address" },
      { indexed: false, name: "price", type: "uint256" },
      { indexed: false, name: "quantity", type: "uint256" },
      { indexed: false, name: "listingFee", type: "uint256" },
      { indexed: false, name: "feeBps", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "OrderFilled",
    anonymous: false,
    inputs: [
      { indexed: true, name: "fillKey", type: "bytes32" },
      { indexed: true, name: "orderId", type: "uint256" },
        { indexed: true, name: "buyer", type: "address" },
        { indexed: false, name: "seller", type: "address" },
      { indexed: false, name: "assetToken", type: "address" },
      { indexed: false, name: "currencyToken", type: "address" },
      { indexed: false, name: "quantity", type: "uint256" },
      { indexed: false, name: "price", type: "uint256" },
      { indexed: false, name: "gross", type: "uint256" },
      { indexed: false, name: "fee", type: "uint256" },
      { indexed: false, name: "currencyReleased", type: "uint256" },
    ],
  },
    {
      type: "event",
      name: "AutoOrderMatched",
      anonymous: false,
      inputs: [
        { indexed: true, name: "fillKey", type: "bytes32" },
        { indexed: true, name: "orderId", type: "uint256" },
        { indexed: true, name: "buyer", type: "address" },
        { indexed: false, name: "counterOrderId", type: "uint256" },
        { indexed: false, name: "seller", type: "address" },
        { indexed: false, name: "assetToken", type: "address" },
        { indexed: false, name: "currencyToken", type: "address" },
        { indexed: false, name: "quantity", type: "uint256" },
        { indexed: false, name: "price", type: "uint256" },
        { indexed: false, name: "gross", type: "uint256" },
        { indexed: false, name: "fee", type: "uint256" },
        { indexed: false, name: "currencyReleased", type: "uint256" },
      ],
    },
    {
      type: "event",
      name: "OrderCancelled",
    anonymous: false,
    inputs: [
      { indexed: true, name: "orderId", type: "uint256" },
      { indexed: true, name: "maker", type: "address" },
      { indexed: false, name: "refundedAmount", type: "uint256" },
    ],
  },
] as const;

/** 測試網專用的熱錢包管理函式；主網一律由 Safe 提案處理，熱錢包也不是合約 owner。 */
function assertTestnetOnly(label: string) {
  if (IS_MAINNET) throw new Error(`主網不支援由熱錢包執行「${label}」，請改用後台 Safe 提案`);
}

export const RELAYER_CHAIN = NETWORK_CHAIN;
const rpcTransport = fallback(NETWORK_RPC_URLS.map((url) => http(url)));

// 合約地址一律以下方硬編碼的「新部署」位址為唯一真相來源，**刻意不再讀取
// NEXT_PUBLIC_*_ADDRESS 環境變數**：專案環境變數裡那批 NEXT_PUBLIC_*_ADDRESS
// 仍留著上一批（舊）部署的位址，後端 serverless 讀得到，一旦被讀到 relayer 就
// 會把 JC/認購/成交結算送到舊合約上（例：JC 舊合約 0xa85e0664…）。要換合約時
// 直接改下面這幾行即可，並同步 src/lib/contracts.ts。
// 主網只有 JC/AE/RWA Factory/託管＋真 USDT；測試網專用的舊合約在主網填零地址，誤用會直接失敗。
export const RELAYER_ADDRESSES = {
  rwaMaster: IS_MAINNET ? "0x0000000000000000000000000000000000000000" as Address : normalizeOrThrow(undefined, "0x79F1C6aDFCcD916cde668D88a6dda3918e5d6835", "RWA 鑄造工廠合約"),
  rwaPrimarySale: IS_MAINNET ? "0x0000000000000000000000000000000000000000" as Address : normalizeOrThrow(undefined, "0x1BF9Bfd5cFF90A3307ce4AaD0098A1AAEaBEaed0", "RWA 一級認購合約"),
  rwaSecondaryMarket: IS_MAINNET ? "0x0000000000000000000000000000000000000000" as Address : normalizeOrThrow(undefined, "0x9617b751445b8DF7f1c57f10b12065700c7a6117", "RWA 二級市場合約"),
  // 2026-10-04 重新部署（contracts/JCToken.sol）：移除舊合約的 P2P 轉帳限制，
  // owner 保留 mint 權限可再增發。同步 src/lib/contracts.ts。
  jcToken: IS_MAINNET ? MAINNET_RELAYER_ADDRESSES.jcToken : normalizeOrThrow(undefined, "0xE035d5A79664843089F9Ee9F8dA2980cfB5eE4D9", "JC 結算代幣合約"),
  // 手續費 / 認購 JC 的收款金庫。JC/AE 發放給使用者已改為 ADMIN 熱錢包直接
  // transfer，不再從這裡 transferFrom；這個地址僅保留供人工補貨轉帳時參考，
  // 程式碼中不會再讀取或動用這個地址的資產。
  // 目前生效的 Safe 由資料庫 platform_config.active_safe_address 決定（見 loadActiveSafeVault），
  // 更換 Safe 提案執行成功後會自動切換，不需改程式碼或重新部署。
  get safeVault(): Address {
    return activeSafeVault;
  },
  usdt: IS_MAINNET ? MAINNET_RELAYER_ADDRESSES.stablecoin : normalizeOrThrow(undefined, "0x1d6E0eC7ef658758A5b3Dc518422E302A5436B85", "USDT 測試代幣"),
  // 2026-10-04 重新部署（contracts/AEToken.sol）：移除舊合約的「AE P2P 轉帳限制」，
  // 二級市場可直接 transferFrom(賣方→買方) 一次交割；owner 保留 mint 權限。
  // 同步 src/lib/contracts.ts。
  aeToken: IS_MAINNET ? MAINNET_RELAYER_ADDRESSES.aeToken : normalizeOrThrow(undefined, "0x62452c4fd6950D2B5BaE251F39f082900D43B37f", "AE 合約"),
  aePrimarySale: IS_MAINNET ? "0x0000000000000000000000000000000000000000" as Address : normalizeOrThrow(undefined, "0x006a585f0B4aDF0663Dc2175A82D6BabbDc5e3A4", "AE 一級認購合約"),
  aeSecondaryMarket: IS_MAINNET ? "0x0000000000000000000000000000000000000000" as Address : normalizeOrThrow(
    undefined,
    "0x835D61FF69743B0f5F39223ba45F5062A7A5E5c9",
    "AE 二級市場合約",
  ),
  // 2026-10-04 新部署的 RWA Factory，負責建立標的代幣與管理 Safe 未售庫存。
  rwaFactory: IS_MAINNET ? MAINNET_RELAYER_ADDRESSES.rwaFactory : normalizeOrThrow(undefined, "0xD453454118BA8b76e68C16f6Bc965349794EdF9A", "RWA Factory 合約"),
} as const;

function normalizeOrThrow(envValue: string | undefined, fallback: string, label: string): Address {
  try {
    return getAddress((envValue ?? fallback).trim());
  } catch {
    throw new Error(`${label} 地址格式錯誤`);
  }
}

const DEFAULT_SAFE_VAULT = IS_MAINNET ? MAINNET_RELAYER_ADDRESSES.safe : "0xe886e67fd9CFe66fdb0A1F47cEf0001548a078cf";
let activeSafeVault: Address = getAddress(DEFAULT_SAFE_VAULT);
let activeSafeLoadedAt = 0;
const ACTIVE_SAFE_TTL_MS = 30_000;

export function setActiveSafeVault(address: string) {
  activeSafeVault = getAddress(address);
  activeSafeLoadedAt = Date.now();
}

/**
 * 每個請求開頭呼叫一次，讓整個後端使用資料庫目前的 Safe。
 * 讀取失敗時保留上一次的值（冷啟動則用預設值），不阻擋請求。
 */
export async function loadActiveSafeVault(admin: SupabaseClient, force = false): Promise<Address> {
  if (!force && Date.now() - activeSafeLoadedAt < ACTIVE_SAFE_TTL_MS) return activeSafeVault;
  try {
    const { data } = await admin.from("platform_config").select("active_safe_address").eq("id", true).maybeSingle();
    const address = (data as { active_safe_address?: string | null } | null)?.active_safe_address;
    if (address) setActiveSafeVault(address);
    else activeSafeLoadedAt = Date.now();
  } catch {
    // 保留目前值
  }
  return activeSafeVault;
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
// AE 代幣（2026-10-04 二次重新部署）額外多了 owner-only 的 adminReclaim(from,to,amount)：
// 不受 allowance 限制的強制收回，用於「AE 歸零」把使用者持有的 AE 強制收回金庫，
// 即使該使用者從未對 ADMIN 做過 approve 也能收回。
const aeAbi = [
  ...erc20MinimalAbi,
  {
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "adminReclaim",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
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

// RWA Factory 用於建立份額代幣、查詢目前代幣、確認代幣歸屬並管理 Safe 庫存。

const rwaFactoryAbi = [
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "holder", type: "address" },
    ],
    name: "reclaimShares",
    outputs: [{ name: "amount", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
    name: "burnVaultInventory",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  { inputs: [{ name: "token", type: "address" }], name: "isFactoryToken", outputs: [{ type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "safeVault", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
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

// 每個標的一顆專屬份額代幣；地址由目前 Factory 的 tokenByPlacement 查得，
// 不使用資料庫內可能殘留的舊代幣地址。
const shareTokenAbi = [
  { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], name: "allowance", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], name: "approve", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], name: "transfer", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
] as const;

const shareTokenDecimalsCache = new Map<Address, number>();
const erc20TransferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

async function assertCurrentFactoryToken(token: Address): Promise<void> {
  const isFactoryToken = await publicClient().readContract({
    address: RELAYER_ADDRESSES.rwaFactory,
    abi: rwaFactoryAbi,
    functionName: "isFactoryToken",
    args: [getAddress(token)],
  });
  if (!isFactoryToken) throw new Error("此 RWA 代幣不屬於目前 Factory，已停止讀取與處理");
}

export async function getCurrentRwaFactoryToken(placementId: string): Promise<Address | null> {
  const value = (await publicClient().readContract({
    address: RELAYER_ADDRESSES.rwaFactory,
    abi: rwaFactoryAbi,
    functionName: "tokenByPlacement",
    args: [placementId.trim()],
  })) as Address;
  if (!value || value === "0x0000000000000000000000000000000000000000") return null;
  const token = getAddress(value);
  await assertCurrentFactoryToken(token);
  return token;
}

async function shareTokenDecimals(token: Address): Promise<number> {
  await assertCurrentFactoryToken(token);
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
  assertTestnetOnly("熱錢包直接建立 RWA 代幣");
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
  // 讓上層存進 DB，否則之後會被誤判為「已建立」而卡死。此時直接丟錯，管理員用
  // 用同一顆按鈕重試即可——屆時 tokenByPlacement 會回傳正確地址並自動回填。
  if (!tokenAddress || tokenAddress === "0x0000000000000000000000000000000000000000") {
    throw new Error("代幣已上鏈但暫時讀不到地址（RPC 尚未同步），請於數秒後用同一顆按鈕重試，系統會自動修復並回填地址");
  }
  return { tokenAddress: getAddress(tokenAddress), txHash: hash, alreadyExisted: false };
}

let cachedPublic: PublicClient | null = null;
export function publicClient(): PublicClient {
  if (!cachedPublic) {
    cachedPublic = createPublicClient({ chain: RELAYER_CHAIN, transport: rpcTransport }) as PublicClient;
  }
  return cachedPublic;
}

export async function verifyVaultUsdtDeposit(
  txHash: string,
  from: Address,
  usdtAmount: number,
): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("USDT 入金交易雜湊格式錯誤");
  const receipt = await publicClient().getTransactionReceipt({ hash: txHash as `0x${string}` });
  if (receipt.status !== "success") throw new Error("USDT 入金交易尚未成功確認");

  const fromTopic = `0x${from.slice(2).toLowerCase().padStart(64, "0")}`;
  const toTopic = `0x${RELAYER_ADDRESSES.safeVault.slice(2).toLowerCase().padStart(64, "0")}`;
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const decimals = await usdtDecimals();
  const expectedAmount = parseUnits(usdtAmount.toFixed(decimals), decimals);
  const verified = receipt.logs.some((log) =>
    log.address.toLowerCase() === RELAYER_ADDRESSES.usdt.toLowerCase() &&
    log.topics[0]?.toLowerCase() === transferTopic &&
    log.topics[1]?.toLowerCase() === fromTopic &&
    log.topics[2]?.toLowerCase() === toTopic &&
    log.data.length >= 66 && BigInt(log.data) === expectedAmount,
  );
  if (!verified) throw new Error("鏈上收據不符合預期：未找到由本人轉入 Safe 的足額 USDT Transfer");
}

export function p2pEscrowAddress(): Address {
  if (!P2P_ESCROW_ADDRESS) throw new Error("P2PEscrow 尚未部署或尚未設定合約地址");
  return P2P_ESCROW_ADDRESS;
}

export async function getP2PEscrowLocked(token: Address, escrow: Address = p2pEscrowAddress()): Promise<bigint> {
  return publicClient().readContract({
    address: escrow,
    abi: P2P_ESCROW_ABI,
    functionName: "totalLocked",
    args: [token],
  });
}

export async function getP2PEscrowFees(): Promise<{ feeBps: number; listingFee: number }> {
  const [feeBps, listingFee] = await Promise.all([
    publicClient().readContract({ address: p2pEscrowAddress(), abi: P2P_ESCROW_ABI, functionName: "feeBps" }),
    publicClient().readContract({ address: p2pEscrowAddress(), abi: P2P_ESCROW_ABI, functionName: "listingFee" }),
  ]);
  return { feeBps: Number(feeBps), listingFee: Number(formatUnits(listingFee, 18)) };
}

/** 只改目前（新）託管合約的費率；舊合約費率寫死，既有掛單也一律沿用建立當下的費率。 */
export async function setP2PEscrowFees(feeBps: number, listingFeeJc: string): Promise<`0x${string}`> {
  await ensureRelayerGas();
  const hash = await sendAdminTx((nonce) =>
    adminWalletClient().writeContract({
      address: p2pEscrowAddress(),
      abi: P2P_ESCROW_ABI,
      functionName: "setFees",
      args: [BigInt(feeBps), parseUnits(listingFeeJc, 18)],
      nonce,
    }),
  );
  return waitAndReturn(hash);
}

export async function matchP2PEscrowOrders(input: {
  buyOrderId: bigint;
  sellOrderId: bigint;
  quantity: bigint;
  fillKey: `0x${string}`;
  escrow?: Address;
}): Promise<`0x${string}`> {
  await ensureRelayerGas();
  const escrow = input.escrow ?? p2pEscrowAddress();
  if (!isKnownP2PEscrow(escrow)) throw new Error("不是平台託管合約，拒絕撮合");
  const hash = await sendAdminTx((nonce) =>
    adminWalletClient().writeContract({
      address: escrow,
      abi: P2P_ESCROW_ABI,
      functionName: "matchEscrowOrders",
      args: [input.buyOrderId, input.sellOrderId, input.quantity, input.fillKey],
      nonce,
    }),
  );
  return waitAndReturn(hash);
}

export async function getP2PEscrowReceipt(hash: `0x${string}`) {
  return publicClient().getTransactionReceipt({ hash });
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
  return createWalletClient({ account: adminAccount(), chain: RELAYER_CHAIN, transport: rpcTransport });
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
// 不到對應���鏈上結算。
const MIN_RELAYER_ETH_WEI = parseEther("0.0015");

/**
 * 送出任何鏈上交易前的防呆檢查：ADMIN 熱錢包 ETH 太少會導致交易卡住甚至完全
 * 送不出去。這裡先讀鏈上餘額擋下，回報清楚的中文錯誤，而不是讓使用者卡在一
 * 個看不懂的底�� RPC 錯誤，或讓內部帳本已經扣款卻永遠等不到鏈上結算。
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
// Base 主網一筆 ERC20 授權／轉帳約 0.0000003～0.0000005 ETH；0.00001 在 Gas 漲約 20 倍時仍夠一筆。
const SPONSOR_MIN_WEI = parseEther("0.00001"); // 低於此餘額才贊助
const SPONSOR_TARGET_WEI = parseEther("0.0001"); // 贊助後補到此餘額

export async function sponsorUserGas(
  userWallet: Address,
): Promise<{ sponsored: boolean; balanceWei: string; txHash?: string }> {
  const wallet = getAddress(String(userWallet).trim());
  const current = await publicClient().getBalance({ address: wallet });
  if (current >= SPONSOR_MIN_WEI) {
    return { sponsored: false, balanceWei: current.toString() };
  }
  // ADMIN 熱錢包本身要有足夠 ETH 付「這筆補助轉帳」����� Gas 與轉出的 value。
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

export async function getAdminTransactionStatus(
  hash: `0x${string}`,
): Promise<"confirmed" | "reverted" | "pending" | "unknown"> {
  try {
    const receipt = await publicClient().getTransactionReceipt({ hash });
    return receipt.status === "success" ? "confirmed" : "reverted";
  } catch {
    try {
      const transaction = await publicClient().getTransaction({ hash });
      return transaction ? "pending" : "unknown";
    } catch {
      return "unknown";
    }
  }
}

/**
 * 熱錢包只負責「代付 Gas 送出」已由 Safe 簽署人（Ledger）簽好的 execTransaction；
 * 交易內容與簽章都由 Safe 合約自己驗證，熱錢包本身沒有任何權限。
 */
export async function relaySafeExecTransaction(input: {
  safe: Address;
  to: Address;
  value: bigint;
  data: `0x${string}`;
  operation: 0 | 1;
  signatures: `0x${string}`;
}): Promise<`0x${string}`> {
  await ensureRelayerGas();
  const args = [
    input.to, input.value, input.data, input.operation,
    0n, 0n, 0n,
    "0x0000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000000",
    input.signatures,
  ] as const;
  const { result } = await publicClient().simulateContract({
    account: relayerAddress(),
    address: input.safe,
    abi: SAFE_EXEC_ABI,
    functionName: "execTransaction",
    args,
  });
  if (!result) throw new Error("Safe 模擬執行回傳失敗，交易未送出");
  return sendAdminTx((nonce) =>
    adminWalletClient().writeContract({
      address: input.safe,
      abi: SAFE_EXEC_ABI,
      functionName: "execTransaction",
      args,
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
}

/** 僅供一次性「管理權移交 Safe」使用：由熱錢包送出指定 calldata 並等待確認。 */
export async function sendAdminRawCall(to: Address, data: `0x${string}`): Promise<`0x${string}`> {
  await ensureRelayerGas();
  await publicClient().call({ account: relayerAddress(), to, data });
  const hash = await sendAdminTx((nonce) =>
    adminWalletClient().sendTransaction({ to, data, chain: RELAYER_CHAIN, nonce }),
  );
  return waitAndReturn(hash);
}

export const SAFE_EXEC_ABI = [
  {
    type: "function",
    name: "execTransaction",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

export async function waitForAdminTransaction(hash: `0x${string}`): Promise<string> {
  return waitAndReturn(hash);
}

export type OnAdminTransactionSubmitted = (hash: `0x${string}`) => Promise<void>;

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
 * 若不��，代表需要人工從 Safe 金庫再轉一批 JC/AE 過來補貨。
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
 * 金庫手動轉帳補貨到熱錢包。amount 為人類可讀單���。
 */
async function transferFromHotWallet(
  token: "jcToken" | "aeToken",
  to: Address,
  amount: number,
  onSubmitted?: OnAdminTransactionSubmitted,
) {
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
  await onSubmitted?.(hash);
  return waitAndReturn(hash);
}

/** 發放 JC 給指定錢包（見 transferFromHotWallet）。 */
export async function mintJc(
  to: Address,
  amount: number,
  onSubmitted?: OnAdminTransactionSubmitted,
) {
  return transferFromHotWallet("jcToken", to, amount, onSubmitted);
}

/** 發放 AE 給指定錢包（見 transferFromHotWallet）。 */
export async function mintAe(to: Address, amount: number) {
  return transferFromHotWallet("aeToken", to, amount);
}

/**
 * 「AE 歸零」專用：用 AEToken 的 owner-only adminReclaim 把某錢包持有的 AE
 * 強制收回金庫（Safe），不受 allowance 限制，確保即使該使用者從未對 ADMIN
 * approve 過也能收回。amount<=0 時直接回 null（不送出交易）。
 */
export async function adminReclaimAe(from: Address, amount: number, to: Address = RELAYER_ADDRESSES.safeVault) {
  assertTestnetOnly("AE 歸零收回");
  if (amount <= 0) return null;
  await ensureRelayerGas();
  const decimals = await tokenDecimals("aeToken");
  const amountUnits = parseUnits(amount.toFixed(decimals), decimals);
  const hash = await sendAdminTx((nonce) =>
    adminWalletClient().writeContract({
      address: RELAYER_ADDRESSES.aeToken,
      abi: aeAbi,
      functionName: "adminReclaim",
      args: [getAddress(from), getAddress(to), amountUnits],
      chain: RELAYER_CHAIN,
      nonce,
    }),
  );
  return waitAndReturn(hash);
}

/** 以精確 decimal 字串讀取目前新 JC 合約餘額，供資料庫帳本對帳使用。 */
export async function getJcChainBalance(wallet: Address): Promise<string> {
  const [raw, decimals] = await Promise.all([
    publicClient().readContract({ address: RELAYER_ADDRESSES.jcToken, abi: jcAbi, functionName: "balanceOf", args: [wallet] }),
    tokenDecimals("jcToken"),
  ]);
  return formatUnits(raw as bigint, decimals);
}

/** 讀取某錢包目前鏈上 AE 餘額（decimals 已還原為一般單位的 number）。 */
  export async function getAeChainBalance(wallet: Address): Promise<number> {
  const [raw, decimals] = await Promise.all([
    publicClient().readContract({ address: RELAYER_ADDRESSES.aeToken, abi: aeAbi, functionName: "balanceOf", args: [wallet] }),
    tokenDecimals("aeToken"),
  ]);
  return Number(formatUnits(raw as bigint, decimals));
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
  {
    inputs: [{ name: "amount", type: "uint256" }],
    name: "burnVaultInventory",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/**
 * 管理員專用：在 JC/AE 代幣合約上呼叫 owner 的 `mint`，增發供給量給任意地址
 * （通常是 Safe 金庫）。這會真的增加代幣總供給量，與 transferFromHotWallet
 * （只是搬動熱錢包既有餘額）不同，故獨立成另一個函式、由獨立 action 把關。
 */
export async function mintTokenSupply(token: "jcToken" | "aeToken", to: Address, amount: number) {
  assertTestnetOnly("熱錢包直接增發");
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

/** 管理員只能銷毀 Safe 金庫庫存；絕不接受任意持有人地址作為銷毀來源。 */
export async function burnVaultInventory(token: "jc" | "ae" | "rwa", amount: number, rwaTokenAddress?: Address) {
  assertTestnetOnly("熱錢包直接銷毀");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("銷毀數量必須大於 0");
  await ensureRelayerGas();

  if (token === "rwa") {
    if (!rwaTokenAddress) throw new Error("RWA 必須指定 Factory 建立的標的代幣地址");
    const rwaToken = getAddress(rwaTokenAddress);
    const factoryAddress = RELAYER_ADDRESSES.rwaFactory;
    const isFactoryToken = await publicClient().readContract({ address: factoryAddress, abi: rwaFactoryAbi, functionName: "isFactoryToken", args: [rwaToken] });
    if (!isFactoryToken) throw new Error("該地址不是目前 RWA Factory 建立的標的代幣");
    const vaultAddress = await publicClient().readContract({ address: factoryAddress, abi: rwaFactoryAbi, functionName: "safeVault" });
    const decimals = await shareTokenDecimals(rwaToken);
    const amountUnits = parseUnits(amount.toFixed(decimals), decimals);
    const balance = await publicClient().readContract({ address: rwaToken, abi: shareTokenAbi, functionName: "balanceOf", args: [vaultAddress] });
    if (balance < amountUnits) throw new Error("Safe 金庫的該 RWA 庫存不足，未送出銷毀交易");
    await publicClient().simulateContract({ account: relayerAddress(), address: factoryAddress, abi: rwaFactoryAbi, functionName: "burnVaultInventory", args: [rwaToken, amountUnits] });
    const hash = await sendAdminTx((nonce) =>
      adminWalletClient().writeContract({ address: factoryAddress, abi: rwaFactoryAbi, functionName: "burnVaultInventory", args: [rwaToken, amountUnits], chain: RELAYER_CHAIN, nonce }),
    );
    return waitAndReturn(hash);
  }

  const tokenKey = token === "jc" ? "jcToken" : "aeToken";
  const contractAddress = RELAYER_ADDRESSES[tokenKey];
  const vaultAddress = RELAYER_ADDRESSES.safeVault;
  const decimals = await tokenDecimals(tokenKey);
  const amountUnits = parseUnits(amount.toFixed(decimals), decimals);
  const balance = await publicClient().readContract({ address: contractAddress, abi: erc20MinimalAbi, functionName: "balanceOf", args: [vaultAddress] });
  if (balance < amountUnits) throw new Error(`Safe 金庫的 ${token.toUpperCase()} 庫存不足，未送出銷毀交易`);
  await publicClient().simulateContract({ account: relayerAddress(), address: contractAddress, abi: mintableAbi, functionName: "burnVaultInventory", args: [amountUnits] });
  const hash = await sendAdminTx((nonce) =>
    adminWalletClient().writeContract({ address: contractAddress, abi: mintableAbi, functionName: "burnVaultInventory", args: [amountUnits], chain: RELAYER_CHAIN, nonce }),
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
 * 使用者本人先簽署精確額度 approve 後，ADMIN 只把核准的舊資產數量轉入熱錢包。
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
// JC 收款與分流
// ---------------------------------------------------------------------------
//
// 2026-10-04 新 JC 合約已移除舊版 P2P 轉帳限制，符合標準 ERC-20。新認購直接由
// ADMIN 憑買方本筆精確 approve，單筆 transferFrom(買方 → Safe)；舊版兩跳 helper
// pullJcFromUser/adminSendJc 保留給歷史結算續跑及二級市場分流，避免重扣買方 JC。


/**
 * 兩跳收款的第一跳：把 JC 從使用者錢包拉進 ADMIN 熱錢包（transferFrom(from→ADMIN)）。
 * 送出前預檢 from 對 ADMIN 的授權與 JC 餘額，任一不足丟出清楚中文錯誤（供上層據以
 * 擋下交易）——特別提醒分潤 JC 尚未上鏈，需先在金庫購買足額 JC。
 */
export async function pullJcFromUser(
  from: Address,
  jcAmount: number,
  onSubmitted?: OnAdminTransactionSubmitted,
): Promise<string> {
  const decimals = await tokenDecimals("jcToken");
  return transferFromViaAdmin({
    token: RELAYER_ADDRESSES.jcToken,
    from,
    to: relayerAddress(),
    amountUnits: parseUnits(jcAmount.toFixed(decimals), decimals),
    noAllowanceMsg:
      "尚未授權平台動用您的 JC（或本筆額度不足），無法完成鏈上 JC 收款。請在 App 內重新操作並簽署本筆精確額度授權後再試；此額度使用後，下一筆需重新授權。",
    lowBalanceMsg:
      "您的鏈上 JC 餘額不足以支付本筆金額。注意：分潤 JC 僅記在站內帳本、尚未上鏈，需先在錢包金庫用 USDT 購買足額 JC 才能認購或交易。",
    onSubmitted,
  });
}


/**
 * 兩跳收款的第二跳：ADMIN 熱錢包用自己的 JC 餘額 transfer �� `to`（Safe 金庫或
 * 賣方）。因與 owner 相關，JC 合約允許。amount<=0 回傳 null（無需轉帳）。
 */
export async function adminSendJc(
  to: Address,
  jcAmount: number,
  onSubmitted?: OnAdminTransactionSubmitted,
): Promise<string | null> {
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
  await onSubmitted?.(hash);
  return waitAndReturn(hash);
}

/** 兩跳收款的第二跳（收進 Safe 金庫）：ADMIN → Safe 金庫。 */
export async function sendJcToVault(
  jcAmount: number,
  onSubmitted?: OnAdminTransactionSubmitted,
): Promise<string | null> {
  return adminSendJc(RELAYER_ADDRESSES.safeVault, jcAmount, onSubmitted);
}


  const usdtDecimalsCache: { value: number | null } = { value: null };
  async function usdtDecimals(): Promise<number> {
  if (usdtDecimalsCache.value != null) return usdtDecimalsCache.value;
  let value = 6;
  try {
  value = Number(
  await publicClient().readContract({ address: RELAYER_ADDRESSES.usdt, abi: erc20MinimalAbi, functionName: "decimals" }),
  );
  } catch {
  value = 6;
  }
  usdtDecimalsCache.value = value;
  return value;
  }

  /**
  * JC 贖回撥款：ADMIN 熱錢包直接用自己的 USDT 餘額 transfer 給使用者。與
  * collectJcToVault（把使用者鏈上 JC 收回 Safe）是各自獨立的兩筆交易，互不
  * 依賴彼此的成敗，呼叫端自行決定執行順序與是否互為前提。amount<=0 回傳
  * null（無需撥款）。送出前預檢熱錢包 USDT 餘額，不足就丟出清楚中文錯誤，
  * 提示管理員從 Safe 金庫轉入 USDT 補貨，而不是送出注定失敗的交易。
  */
  export async function adminSendUsdt(
  to: Address,
  usdtAmount: number,
  onSubmitted?: OnAdminTransactionSubmitted,
): Promise<string | null> {
  if (!(usdtAmount > 0)) return null;
  await ensureRelayerGas();
  const decimals = await usdtDecimals();
  const amountUnits = parseUnits(usdtAmount.toFixed(decimals), decimals);
  const balance = (await publicClient().readContract({
  address: RELAYER_ADDRESSES.usdt,
  abi: erc20MinimalAbi,
  functionName: "balanceOf",
  args: [relayerAddress()],
  })) as bigint;
  if (balance < amountUnits) {
  throw new Error(
  `ADMIN 熱錢包 USDT 餘額不足（目前 ${formatUnits(balance, decimals)} USDT，需要 ${formatUnits(amountUnits, decimals)} USDT），請管理員從 Safe 金庫轉入 USDT 補貨`,
  );
  }
  const hash = await sendAdminTx((nonce) =>
  adminWalletClient().writeContract({
  address: RELAYER_ADDRESSES.usdt,
  abi: erc20MinimalAbi,
  functionName: "transfer",
  args: [getAddress(to), amountUnits],
  chain: RELAYER_CHAIN,
  nonce,
  }),
  );
  await onSubmitted?.(hash);
  return waitAndReturn(hash);
  }

/**
 * 把 JC 從買方錢包實際收進 Safe 金庫。
 *
 * 用途：一級認購本金 JC（買方付款）直接回到 Safe 金庫。新認購採單筆精確授權：
 * 買方在 App 內 approve ADMIN 本筆金額，再由 ADMIN 執行
 * `transferFrom(買方 → Safe, amount)`。這樣自動補發時不需要買方再次簽名，前提是
 * 初次認購前已完成該筆 approve 且鏈上 JC 餘額足夠。
 *
 * 送出前預檢買方對 ADMIN 的授權額度與 JC 餘額，任一不足就丟出清楚中文錯誤而
 * 不送出注定 revert 的交易。amount<=0 時回傳 null（無需收款）。
 */
export async function collectJcToVault(
  from: Address,
  jcAmount: number,
  onSubmitted?: OnAdminTransactionSubmitted,
): Promise<string | null> {
  return collectJc(from, RELAYER_ADDRESSES.safeVault, jcAmount, {
    noAllowanceMsg:
      "買方尚未授權平台動用其 JC（或本筆額度不足），無法把認購 JC 收進金庫。請買方在 App 內重試本筆認購並簽署精確額度授權後再重試；授權額度使用後，下一筆需重新授權。",
    lowBalanceMsg: "買方 JC 鏈上餘額不足，無法把認購 JC 收進 Safe 金庫。",
  }, onSubmitted);
}

/**
 * 通用「ADMIN 憑買方對本筆金額的 JC allowance，把 JC 從 `from` 轉到 `to`」。
 *
 * 二級市場成交也用此模型把 JC 分流：買方付的 gross JC 拆成 net→賣方、fee→Safe
 * 金庫兩筆 transferFrom（都動用買方對 ADMIN 的 allowance）。與認購共用同一套「買方
 * 授權 ADMIN 本筆所需額度、relayer 代收」機制，因此管理員一鍵補發只在原授權尚有
 * 足額時才可代收（不需買方當下在線簽名）。送出前預檢買方對 ADMIN 的授權與 JC
 * 餘額，任一不足丟清楚中文錯誤而不送出注��� revert 的交易。amount<=0 回傳 null（無需轉帳）。
 */
export async function collectJc(
  from: Address,
  to: Address,
  jcAmount: number,
  msgs?: { noAllowanceMsg?: string; lowBalanceMsg?: string },
  onSubmitted?: OnAdminTransactionSubmitted,
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
      "買方尚未授權平台動用其 JC（或本筆額度不足），無法完成鏈上 JC 收付。請買方在 App 內重試本筆交易並簽署精確額度授權後再試；授權額度使用後，下一筆需重新授權。",
    lowBalanceMsg: msgs?.lowBalanceMsg ?? "買方 JC 鏈上餘額不足，無法完成鏈上 JC 收付。",
    onSubmitted,
  });
}

/**
 * 「ADMIN 憑 `from` 對本筆 amount 的 ERC-20 allowance，以 transferFrom 把 `token`
 * 從 `from` 轉到 `to`」的共用底層。所有 ADMIN 代使用者執行的 transferFrom 都經此送出，
 * 統一預檢 allowance/balance 並沿用 sendAdminTx 的 nonce 鎖。amountUnits 為代幣最小單位。
 */
async function transferFromViaAdmin(params: {
  token: Address;
  from: Address;
  to: Address;
  amountUnits: bigint;
  noAllowanceMsg: string;
  lowBalanceMsg: string;
  onSubmitted?: OnAdminTransactionSubmitted;
}): Promise<string> {
  const { token, from, to, amountUnits, noAllowanceMsg, lowBalanceMsg, onSubmitted } = params;
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
  await onSubmitted?.(hash);
  return waitAndReturn(hash);
}

/**
 * 發放 RWA 份額給指定錢包：ADMIN 熱錢包直接用標準 ERC-20 transfer 動用自己
 * 持有的該標的專屬代幣餘額轉給買方，且不經過 approve/allowance/transferFrom，
 * 也不在鏈上向買方收 JC。庫存由人工從 Safe ��庫（建立代幣時全額鑄入）轉一批
 * 到 ADMIN 熱錢包補貨。amount 為人類可讀單位（份數）。
 */
async function transferShareFromHotWallet(
  token: Address,
  to: Address,
  amount: number,
  onSubmitted?: OnAdminTransactionSubmitted,
) {
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
  await onSubmitted?.(hash);
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
  onSubmitted?: OnAdminTransactionSubmitted,
) {
  if (!factoryToken) {
    throw new Error(
      "此 RWA 標的尚未在 RWA Factory 建立專屬代幣，無法鏈上發放份額。請先在後台標的編輯器「一鍵建立 RWA 代幣」並回填代幣地址，再把份額從 Safe 金庫轉入 ADMIN 熱錢包後重試。",
    );
  }
  return transferShareFromHotWallet(factoryToken, buyer, rwaUnits, onSubmitted);
}

export async function findRecentAssetTransfer(
  token: Address,
  buyer: Address,
  amount: number,
  afterHash: `0x${string}`,
  isShareToken: boolean,
): Promise<string | null> {
  const reference = await publicClient().getTransactionReceipt({ hash: afterHash });
  const decimals = isShareToken ? await shareTokenDecimals(token) : await tokenDecimals("aeToken");
  const amountUnits = parseUnits(String(amount), decimals);
  const logs = await publicClient().getLogs({
    address: token,
    event: erc20TransferEvent,
    args: { from: relayerAddress(), to: getAddress(buyer) },
    fromBlock: reference.blockNumber,
    toBlock: "latest",
  });
  const matches = logs.filter((log) => {
    if (log.args.value !== amountUnits || log.blockNumber == null) return false;
    if (log.blockNumber > reference.blockNumber) return true;
    return log.transactionIndex != null && log.transactionIndex > reference.transactionIndex;
  });
  if (matches.length > 1) {
    throw new Error("找到多筆符合的舊版標的轉帳；為避免重複發放，系統暫停自動重送並保留待確認紀錄");
  }
  return matches[0]?.transactionHash ?? null;
}

/**
 * AE 一級認��結算（2026-09-20 改為「只發 AE」）。
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
export async function executeAeSubscription(
  buyer: Address,
  aeUnits: number,
  onSubmitted?: OnAdminTransactionSubmitted,
) {
  return transferFromHotWallet("aeToken", buyer, aeUnits, onSubmitted);
}

/** wireRwaContracts 的回傳型別：每個子合約各自回報狀態，任一項失敗都不影響另一項。 */
export type WireResult = {
  subscription: string; // tx hash | "already-set"
  market: string; // tx hash | "already-set" | "failed"
  marketError?: string; // market 設定失敗時的人類可讀原因
};

/** 讀取母合約上某個 address getter；若該 getter 在鏈上 revert（舊版工廠合約的
 * marketContract() ��會 revert），回傳 null 當作「未知／未設定」，絕不讓一個壞掉的
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
  assertTestnetOnly("RWA 母合約初始化");
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
      "已部署的 RWA 鑄造工廠合約 setMarketContract() 在鏈上被無條件拒絕（對任何位址都 revert，marketContract() getter 也 revert），研判為該合約本身的缺陷，需��新部署一顆能正常設定二級市場的鑄造工廠合約才能修復——此問題無法由後端程式修正。RWA 一級認購已設定完成，不受影響。";
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
// holdings 帳本（見 relayer.ts 的 sync-holding action）。回傳整數份額字串／數值。
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

/**
 * 「RWA 下架」專用：嘗試把某錢包持有的 RWA 專屬份額代幣收回金庫（Safe）。
 * RWA 份額代幣（RWAFactory 鑄造）沒有像 JC/AE 新合約那樣 owner-only 的
 * adminReclaim，只能用一般 transferFrom——若該使用者從未對 ADMIN approve
 * 過（例如從未在二級市場掛過賣單），此呼叫會丟出清楚中文錯誤，由呼叫端
 * 捕捉並列為「需人工處理」，不影響下架本身（站內 JC 已原路退款、holdings
 * 已清空）。amount<=0 時直接回 null（不送出交易）。
 */
export async function reclaimRwaShare(
  tokenAddress: Address,
  from: Address,
  amount: number,
  to: Address = RELAYER_ADDRESSES.safeVault,
): Promise<string | null> {
  assertTestnetOnly("熱錢包直接收回 RWA 份額");
  if (amount <= 0) return null;
  // 新版 Factory 代幣支援 reclaimShares（不需持有人授權）；先模擬，可行就直接強制收回。
  try {
    await publicClient().simulateContract({
      account: relayerAddress(),
      address: RELAYER_ADDRESSES.rwaFactory,
      abi: rwaFactoryAbi,
      functionName: "reclaimShares",
      args: [tokenAddress, from],
    });
    const hash = await sendAdminTx((nonce) =>
      adminWalletClient().writeContract({
        address: RELAYER_ADDRESSES.rwaFactory,
        abi: rwaFactoryAbi,
        functionName: "reclaimShares",
        args: [tokenAddress, from],
        chain: RELAYER_CHAIN,
        nonce,
      }),
    );
    const receipt = await publicClient().waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("reclaimShares reverted");
    return hash;
  } catch {
    // 舊代幣不支援強制回收，退回「持有人已授權」的 transferFrom。
  }
  const decimals = await shareTokenDecimals(tokenAddress);
  return transferFromViaAdmin({
    token: tokenAddress,
    from,
    to,
    amountUnits: parseUnits(amount.toFixed(decimals), decimals),
    noAllowanceMsg: "該使用者尚未授權平台動用其 RWA 份額（或授權額度不足），無法強制收回，需人工處理。",
    lowBalanceMsg: "該使用者鏈上 RWA 份額餘額不足，無法收回。",
  });
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

export async function getAdminWalletStatus() {
  const address = relayerAddress();
  const balance = await publicClient().getBalance({ address });
  return {
    address,
    ethBalanceFormatted: formatEther(balance),
    gasLow: balance < MIN_RELAYER_ETH_WEI,
  };
}
