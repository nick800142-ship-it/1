import { getAddress, erc20Abi, type Address } from "viem";
import { baseSepolia } from "viem/chains";

/**
 * 全站鏈上合約設定的唯一來源。所有讀取/簽署鏈上交易的程式碼都應該從這裡
 * 匯入地址與 ABI，不要在個別檔案裡各自寫死地址——換合約或換鏈時只要改這裡。
 *
 * 目前鎖定在 Base Sepolia 測試網，所有合約與代幣都部署在同一條鏈上。
 */
export const CHAIN = baseSepolia;
export const CHAIN_ID = baseSepolia.id; // 84532

/**
 * 把任意來源（Privy 錢包、profiles.wallet_address、環境變數…）的地址字串，
 * 先去除前後空白再用 viem 的 getAddress() 做 checksum 校驗與正規化。
 *
 * 這是修掉「Address is invalid」的關鍵：viem 在編碼合約參數（如 balanceOf 的
 * account）或設定 walletClient.account 時，會對「帶有大小寫」的地址重新驗證
 * checksum，只要來源地址大小寫不符合 EIP-55 或夾帶空白就會直接丟錯。先用
 * getAddress() 統一轉成正確 checksum 格式即可避免。
 *
 * 校驗失敗（真的不是合法地址）時回傳 null，讓呼叫端安全地跳過而不是崩潰。
 */
export function normalizeAddress(address: string | null | undefined): Address | null {
  if (!address) return null;
  try {
    return getAddress(address.trim());
  } catch {
    return null;
  }
}

function requireAddress(envValue: string | undefined, fallback: string, label: string): Address {
  const value = (envValue ?? fallback).trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error(`${label} 地址格式錯誤: "${value}"`);
  }
  return value as Address;
}

// 合約地址：以程式碼內硬編碼的正式地址為唯一真相來源（見下方 CONTRACT_ADDRESSES
// 上方說明，刻意不再讀環境變數，避免被殘留的舊部署位址悄悄覆蓋）。
//
// 2026-09-19 全面換成使用者提供的新一批部署（原地址與其 owner 私鑰已在對話中
// 曝光，視為已洩漏，不再信任）。JC/AE 代幣的發放模式改為「營運熱錢包直接轉帳」：
// Safe 金庫的庫存由人工手動轉一批到 ADMIN_PRIVATE_KEY 熱錢包補貨，之後所有對
// 使用者的發放都是 ADMIN 熱錢包用標準 ERC-20 transfer 直接轉出自己的餘額，
// 不使用 approve/allowance/transferFrom，也不透過 Safe Allowance Module。
// 詳見 api/_onchain.ts 開頭說明。
// 2026-09-19：合約地址一律以下方「這批新部署」的硬編碼值為唯一真相來源，
// **刻意不再讀取 NEXT_PUBLIC_*_ADDRESS 環境變數**。原因：專案環境變數裡的那批
// NEXT_PUBLIC_*_ADDRESS 仍留著上一批（舊）部署的位址，一旦被讀到就會整站悄悄
// 指回舊合約（例：JC 舊合約 0xa85e0664… 對管理員錢包還有 300，會蓋掉新合約的
// 0）。要換合約時直接改下面這幾行即可，不要改回讀環境變數。
export const CONTRACT_ADDRESSES = {
  /** Base Sepolia 測試網上的自訂 USDT 測試代幣（ERC-20）。 */
  usdt: requireAddress(undefined, "0x1d6E0eC7ef658758A5b3Dc518422E302A5436B85", "USDT 測試代幣"),
  /** 手續費 / 兌換用的 Safe 多簽金庫，全站 USDT 收款地址統一指向這裡。 */
  safeVault: requireAddress(undefined, "0xe886e67fd9CFe66fdb0A1F47cEf0001548a078cf", "Safe 金庫"),
  /** RWA 鑄造工廠合約（RWA_Factory，發行/管理 RWA 份額的 ERC-20）。 */
  rwaMaster: requireAddress(undefined, "0x79F1C6aDFCcD916cde668D88a6dda3918e5d6835", "RWA 鑄造工廠合約"),
  /** RWA 一級認購合約（RWA_Subscription）。 */
  rwaPrimarySale: requireAddress(undefined, "0x1BF9Bfd5cFF90A3307ce4AaD0098A1AAEaBEaed0", "RWA 一級認購合約"),
  /** RWA 二級市場合約（RWA_Secondary_Exchange）。 */
  rwaSecondaryMarket: requireAddress(undefined, "0x9617b751445b8DF7f1c57f10b12065700c7a6117", "RWA 二級市場合約"),
  /**
   * JC 結算代幣合約（JC_Token，標準 ERC-20，無自訂函式）。
   * 發放給使用者一律由 ADMIN 熱錢包直接 transfer，不再鑄造。
   */
  jcToken: requireAddress(undefined, "0xF7Ac96B9b4e01A432c40501644C7721497faa446", "JC 結算代幣合約"),
  /** AE 代幣合約（AE_Token，標準 ERC-20，無自訂函式）。 */
  aeToken: requireAddress(undefined, "0x38ceB1c4A4dC308eF668B75e56EbC468D451Ad5a", "AE 代幣合約"),
  /** AE 一級認購合約（與 rwaPrimarySale 相同介面：executeSubscription(buyer, aeAmount, totalPayment)）。 */
  aePrimarySale: requireAddress(undefined, "0x006a585f0B4aDF0663Dc2175A82D6BabbDc5e3A4", "AE 一級認購合約"),
  /** AE 二級市場合約（AE_Market_Thin）。 */
  aeSecondaryMarket: requireAddress(undefined, "0x835D61FF69743B0f5F39223ba45F5062A7A5E5c9", "AE 二級市場合約"),
  /**
   * RWA Factory（contracts/RWAFactory.sol，2026-09-20 部署）：每個私募標的一顆專屬
   * RWA 份額代幣的工廠 + 通用結算入口（subscribe/trade 的支付幣種 currency 是呼叫
   * 參數，不寫死在合約裡）。目前僅記錄地址，尚未接線 —— 現有 RWA 一級/二級認購仍走
   * 舊的 rwaMaster/rwaPrimarySale/rwaSecondaryMarket，直到明確要求切換為止。
   */
  rwaFactory: requireAddress(undefined, "0x18F4490cBfB1007ee1C7D1949404AF0E0A33201E", "RWA Factory 合約"),
} as const;

// 標準 ERC-20 ABI（balanceOf / transfer / approve / allowance / decimals ...），
// 適用於 usdt 這個沒有自訂函式的純代幣合約。
export const ERC20_ABI = erc20Abi;

// RWA 母合約（RWA_Token）：ERC-20 + mint / marketContract / subscriptionContract 設定。
const rwaMasterAbi = [
  {
    inputs: [
      { internalType: "string", name: "name", type: "string" },
      { internalType: "string", name: "symbol", type: "string" },
    ],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  {
    inputs: [
      { internalType: "address", name: "spender", type: "address" },
      { internalType: "uint256", name: "allowance", type: "uint256" },
      { internalType: "uint256", name: "needed", type: "uint256" },
    ],
    name: "ERC20InsufficientAllowance",
    type: "error",
  },
  {
    inputs: [
      { internalType: "address", name: "sender", type: "address" },
      { internalType: "uint256", name: "balance", type: "uint256" },
      { internalType: "uint256", name: "needed", type: "uint256" },
    ],
    name: "ERC20InsufficientBalance",
    type: "error",
  },
  {
    inputs: [{ internalType: "address", name: "approver", type: "address" }],
    name: "ERC20InvalidApprover",
    type: "error",
  },
  {
    inputs: [{ internalType: "address", name: "receiver", type: "address" }],
    name: "ERC20InvalidReceiver",
    type: "error",
  },
  {
    inputs: [{ internalType: "address", name: "sender", type: "address" }],
    name: "ERC20InvalidSender",
    type: "error",
  },
  {
    inputs: [{ internalType: "address", name: "spender", type: "address" }],
    name: "ERC20InvalidSpender",
    type: "error",
  },
  {
    inputs: [{ internalType: "address", name: "owner", type: "address" }],
    name: "OwnableInvalidOwner",
    type: "error",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "OwnableUnauthorizedAccount",
    type: "error",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "owner", type: "address" },
      { indexed: true, internalType: "address", name: "spender", type: "address" },
      { indexed: false, internalType: "uint256", name: "value", type: "uint256" },
    ],
    name: "Approval",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, internalType: "address", name: "newContract", type: "address" }],
    name: "MarketContractUpdated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "previousOwner", type: "address" },
      { indexed: true, internalType: "address", name: "newOwner", type: "address" },
    ],
    name: "OwnershipTransferred",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, internalType: "address", name: "newContract", type: "address" }],
    name: "SubscriptionContractUpdated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "from", type: "address" },
      { indexed: true, internalType: "address", name: "to", type: "address" },
      { indexed: false, internalType: "uint256", name: "value", type: "uint256" },
    ],
    name: "Transfer",
    type: "event",
  },
  {
    inputs: [],
    name: "SAFE_VAULT",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "owner", type: "address" },
      { internalType: "address", name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "spender", type: "address" },
      { internalType: "uint256", name: "value", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "marketContract",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "mint",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "name",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "owner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "renounceOwnership",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "_contract", type: "address" }],
    name: "setMarketContract",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "_contract", type: "address" }],
    name: "setSubscriptionContract",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "subscriptionContract",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "value", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "from", type: "address" },
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "value", type: "uint256" },
    ],
    name: "transferFrom",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "newOwner", type: "address" }],
    name: "transferOwnership",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// 2026-09-19：JC_Token / AE_Token 這批新合約是標準 ERC-20（無 mint / market /
// safeVault 等自訂函式）——發放給使用者一律由後端 ADMIN 錢包對 Safe 金庫既有
// 庫存執行 transferFrom，不再鑄造。直接沿用 viem 內建 erc20Abi 即可
// （balanceOf / transfer / transferFrom / approve / allowance / decimals ...）。
const jcTokenAbi = erc20Abi;
const aeTokenAbi = erc20Abi;

// RWA 二級市場合約（RWA_Secondary_Exchange）：撮合後由 relayer/owner 呼叫
// executeTrade 一次性結算 RWA↔JC 交換。
const rwaSecondaryMarketAbi = [
  { inputs: [], stateMutability: "nonpayable", type: "constructor" },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "buyer", type: "address" },
      { indexed: true, internalType: "address", name: "seller", type: "address" },
      { indexed: false, internalType: "uint256", name: "rwaAmount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "paymentAmount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "feeAmount", type: "uint256" },
    ],
    name: "TradeExecuted",
    type: "event",
  },
  {
    inputs: [
      { internalType: "address", name: "seller", type: "address" },
      { internalType: "address", name: "buyer", type: "address" },
      { internalType: "uint256", name: "rwaAmount", type: "uint256" },
      { internalType: "uint256", name: "paymentAmount", type: "uint256" },
    ],
    name: "executeTrade",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "feeRecipient",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "owner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "rwaToken",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "_feeRecipient", type: "address" }],
    name: "setFeeRecipient",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "settlementToken",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// RWA 一級認購合約（RWA_Subscription_Thin）：買方以 JC 支付 totalPayment，
// 合約鑄發 rwaAmount 的 RWA 母代幣給買方，價款轉入 Safe 金庫。
const rwaPrimarySaleAbi = [
  {
    inputs: [{ internalType: "address", name: "_rwaToken", type: "address" }],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  {
    inputs: [{ internalType: "address", name: "owner", type: "address" }],
    name: "OwnableInvalidOwner",
    type: "error",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "OwnableUnauthorizedAccount",
    type: "error",
  },
  { inputs: [], name: "ReentrancyGuardReentrantCall", type: "error" },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "previousOwner", type: "address" },
      { indexed: true, internalType: "address", name: "newOwner", type: "address" },
    ],
    name: "OwnershipTransferred",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, internalType: "address", name: "newToken", type: "address" }],
    name: "PaymentTokenUpdated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "buyer", type: "address" },
      { indexed: true, internalType: "address", name: "payToken", type: "address" },
      { indexed: false, internalType: "uint256", name: "rwaAmount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "totalPayment", type: "uint256" },
    ],
    name: "RWA_Subscribed",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, internalType: "address", name: "newVault", type: "address" }],
    name: "SafeVaultUpdated",
    type: "event",
  },
  {
    inputs: [],
    name: "JC_TOKEN",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "SAFE_VAULT",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "buyer", type: "address" },
      { internalType: "uint256", name: "rwaAmount", type: "uint256" },
      { internalType: "uint256", name: "totalPayment", type: "uint256" },
    ],
    name: "executeSubscription",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "owner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "paymentToken",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "renounceOwnership",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "rwaToken",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "safeVault",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "_newToken", type: "address" }],
    name: "setPaymentToken",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "_newVault", type: "address" }],
    name: "setSafeVault",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "newOwner", type: "address" }],
    name: "transferOwnership",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// AE 二級市場合約（AE_Market_Thin）：撮合後由 relayer/owner 呼叫 executeTrade
// 一次性結算 AE↔JC（或其他 currencyToken）交換。
const aeSecondaryMarketAbi = [
  { inputs: [], stateMutability: "nonpayable", type: "constructor" },
  {
    inputs: [{ internalType: "address", name: "owner", type: "address" }],
    name: "OwnableInvalidOwner",
    type: "error",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "OwnableUnauthorizedAccount",
    type: "error",
  },
  { inputs: [], name: "ReentrancyGuardReentrantCall", type: "error" },
  {
    anonymous: false,
    inputs: [{ indexed: true, internalType: "address", name: "newCurrency", type: "address" }],
    name: "DefaultCurrencyUpdated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "previousOwner", type: "address" },
      { indexed: true, internalType: "address", name: "newOwner", type: "address" },
    ],
    name: "OwnershipTransferred",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, internalType: "address", name: "newVault", type: "address" }],
    name: "SafeVaultUpdated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "payToken", type: "address" },
      { indexed: true, internalType: "address", name: "seller", type: "address" },
      { indexed: true, internalType: "address", name: "buyer", type: "address" },
      { indexed: false, internalType: "uint256", name: "aeAmount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "totalPayment", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "feeAmount", type: "uint256" },
    ],
    name: "TradeExecuted",
    type: "event",
  },
  {
    inputs: [],
    name: "AE_TOKEN",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "FEE_PERCENT",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "FIXED_FEE",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "JC_TOKEN",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "MIN_TRADE_TOTAL",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "aeToken",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "defaultCurrency",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "currencyToken", type: "address" },
      { internalType: "address", name: "seller", type: "address" },
      { internalType: "address", name: "buyer", type: "address" },
      { internalType: "uint256", name: "aeAmount", type: "uint256" },
      { internalType: "uint256", name: "totalPayment", type: "uint256" },
    ],
    name: "executeTrade",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "owner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "renounceOwnership",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "safeVault",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "_newCurrency", type: "address" }],
    name: "setDefaultCurrency",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "_newVault", type: "address" }],
    name: "setSafeVault",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "newOwner", type: "address" }],
    name: "transferOwnership",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// RWA Factory（contracts/RWAFactory.sol）：createRWAToken / subscribe / trade 皆為
// onlyOwner，subscribe/trade 的支付幣種 currency 是呼叫參數，不寫死在合約裡。
const rwaFactoryAbi = [
  {
    inputs: [
      { internalType: "string", name: "placementId", type: "string" },
      { internalType: "string", name: "name_", type: "string" },
      { internalType: "string", name: "symbol_", type: "string" },
      { internalType: "uint8", name: "decimals_", type: "uint8" },
    ],
    name: "createRWAToken",
    outputs: [{ internalType: "address", name: "token", type: "address" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "address", name: "currency", type: "address" },
      { internalType: "address", name: "buyer", type: "address" },
      { internalType: "uint256", name: "shareAmount", type: "uint256" },
      { internalType: "uint256", name: "payment", type: "uint256" },
    ],
    name: "subscribe",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "token", type: "address" },
      { internalType: "address", name: "currency", type: "address" },
      { internalType: "address", name: "seller", type: "address" },
      { internalType: "address", name: "buyer", type: "address" },
      { internalType: "uint256", name: "shareAmount", type: "uint256" },
      { internalType: "uint256", name: "paymentToSeller", type: "uint256" },
      { internalType: "uint256", name: "feeAmount", type: "uint256" },
    ],
    name: "trade",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "string", name: "", type: "string" }],
    name: "tokenByPlacement",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "isFactoryToken",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalTokens",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "offset", type: "uint256" },
      { internalType: "uint256", name: "limit", type: "uint256" },
    ],
    name: "getTokens",
    outputs: [{ internalType: "address[]", name: "out", type: "address[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "v", type: "address" }],
    name: "setSafeVault",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "v", type: "address" }],
    name: "setFeeRecipient",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "string", name: "placementId", type: "string" },
      { indexed: true, internalType: "address", name: "token", type: "address" },
      { indexed: false, internalType: "string", name: "name", type: "string" },
      { indexed: false, internalType: "string", name: "symbol", type: "string" },
      { indexed: false, internalType: "uint8", name: "decimals", type: "uint8" },
    ],
    name: "RWATokenCreated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "token", type: "address" },
      { indexed: true, internalType: "address", name: "currency", type: "address" },
      { indexed: true, internalType: "address", name: "buyer", type: "address" },
      { indexed: false, internalType: "uint256", name: "shareAmount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "payment", type: "uint256" },
    ],
    name: "Subscribed",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "token", type: "address" },
      { indexed: true, internalType: "address", name: "currency", type: "address" },
      { indexed: true, internalType: "address", name: "seller", type: "address" },
      { indexed: false, internalType: "address", name: "buyer", type: "address" },
      { indexed: false, internalType: "uint256", name: "shareAmount", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "paymentToSeller", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "feeAmount", type: "uint256" },
    ],
    name: "Traded",
    type: "event",
  },
] as const;

/**
 * 2026-09-19：BaseScan 已驗證原始碼頁面被 Cloudflare 人機驗證擋住抓不到，
 * 依使用者指示改為直接沿用「這批合約大多是標準 ERC20，或是我們已經寫好的
 * 自訂介面」——JC/AE 代幣是標準 ERC20（沿用 erc20Abi），其餘四個自訂合約
 * （rwaMaster、rwaPrimarySale、rwaSecondaryMarket、aeSecondaryMarket）沿用
 * 原本就已經核對過的介面，僅换成新位址；aePrimarySale 是全新合約，介面與
 * rwaPrimarySale 完全一致（executeSubscription(buyer, amount, totalPayment)），
 * 因此直接重用同一份 ABI。
 */
export const CONTRACT_ABIS = {
  rwaMaster: rwaMasterAbi,
  aeToken: aeTokenAbi,
  jcToken: jcTokenAbi,
  rwaPrimarySale: rwaPrimarySaleAbi,
  aePrimarySale: rwaPrimarySaleAbi,
  rwaSecondaryMarket: rwaSecondaryMarketAbi,
  aeSecondaryMarket: aeSecondaryMarketAbi,
  rwaFactory: rwaFactoryAbi,
};
