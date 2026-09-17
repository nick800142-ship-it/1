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

// 合約地址：優先讀取專案環境變數，未設定時退回下方指定的正式地址，確保
// 預覽環境可直接運作。
export const CONTRACT_ADDRESSES = {
  /** Base Sepolia 測試網上的自訂 USDT 測試代幣（ERC-20）。 */
  usdt: requireAddress(
    process.env.NEXT_PUBLIC_USDT_CONTRACT_ADDRESS,
    "0x1d6E0eC7ef658758A5b3Dc518422E302A5436B85",
    "USDT 測試代幣",
  ),
  /** 手續費 / 兌換用的 Safe 多簽金庫，全站 USDT 收款地址統一指向這裡。 */
  safeVault: requireAddress(
    process.env.NEXT_PUBLIC_SAFE_VAULT_ADDRESS,
    "0xe886e67fd9CFe66fdb0A1F47cEf0001548a078cf",
    "Safe 金庫",
  ),
  /** RWA 母合約（RWA_Token，發行/管理 RWA 份額的 ERC-20）。 */
  rwaMaster: requireAddress(
    process.env.NEXT_PUBLIC_RWA_MASTER_ADDRESS,
    "0x406555b7F4AD841e62a40B926A0864c8a8549775",
    "RWA 母合約",
  ),
  /** RWA 一級認購合約（RWA_Subscription_Thin）。 */
  rwaPrimarySale: requireAddress(
    process.env.NEXT_PUBLIC_RWA_PRIMARY_SALE_ADDRESS,
    "0xFeB4871230151DF02f8476F9c9295356A1412ab8",
    "RWA 一級認購合約",
  ),
  /** RWA 二級市場合約（RWA_Secondary_Exchange）。 */
  rwaSecondaryMarket: requireAddress(
    process.env.NEXT_PUBLIC_RWA_SECONDARY_MARKET_ADDRESS,
    "0x3Ec85939a5e3BAC78A3F38d0587362782AEd6968",
    "RWA 二級市場合約",
  ),
  /** JC 結算代幣合約（JC_Token_v2，ERC-20 + market/safeVault 設定）。 */
  jcToken: requireAddress(
    process.env.NEXT_PUBLIC_JC_TOKEN_ADDRESS,
    "0xa85e0664701fBec23596bFE88eB26d4efd1C7723",
    "JC 結算代幣合約",
  ),
  /**
   * AE 代幣合約（ERC-20，owner = 0x53d2…c1a9，與 relayer owner 相同）。
   * 2026-09-17 已部署並確認：symbol=AE，AE 二級市場合約實際綁定的就是這一顆。
   * 注意：前端 Vite 只 inject 4 個 NEXT_PUBLIC_* 變數（見 vite.config.ts），
   * AE 位址不在其中，因此瀏覽器端 process.env 為 undefined、以下方 fallback 為準。
   */
  aeToken: requireAddress(
    process.env.NEXT_PUBLIC_AE_TOKEN_ADDRESS,
    "0x45C50E069F013B2b4Ae11a8F8F89C97d31e8D7cb",
    "AE 代幣合約",
  ),
  /**
   * AE 二級市場合約（owner = 0x53d2…c1a9，aeToken() 綁定上方 0x45C50E06…）。
   * 舊部署 0x4cd896de… 綁定同一顆代幣，這裡採用 2026-09-17 新部署地址。
   */
  aeSecondaryMarket: requireAddress(
    process.env.NEXT_PUBLIC_AE_SECONDARY_MARKET_ADDRESS,
    "0xE57d846e50883C3F6d9b2B52E18C7F976493A7Db",
    "AE 二級市場合約",
  ),
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

// AE 代幣合約（AE_Token_v2）：ERC-20 + mintReward / marketContract / safeVault 設定。
const aeTokenAbi = [
  {
    inputs: [{ internalType: "address", name: "_safeVault", type: "address" }],
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
    inputs: [{ indexed: true, internalType: "address", name: "newMarket", type: "address" }],
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
    inputs: [{ indexed: true, internalType: "address", name: "newVault", type: "address" }],
    name: "SafeVaultUpdated",
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
    name: "mintReward",
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
    inputs: [],
    name: "safeVault",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "_newMarket", type: "address" }],
    name: "setMarketContract",
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

// JC 結算代幣合約（JC_Token_v2）：與 AE_Token_v2 ABI 形狀完全一致
// （ERC-20 + mintReward / marketContract / safeVault 設定），僅合約位址不同。
const jcTokenAbi = aeTokenAbi;

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

/**
 * 六個自訂合約的完整 ABI（來自 Remix 編譯產物的 "abi" 欄位，已逐一核對
 * 對應到 CONTRACT_ADDRESSES 的哪個位址）：
 * - rwaMaster ← RWA_Token.json（RWA 母合約）
 * - aeToken ← AE_Token_v2.json（AE 代幣合約）
 * - jcToken ← JC_Token_v2.json（JC 結算代幣合約）
 * - rwaPrimarySale ← RWA_Subscription_Thin.json（RWA 一級認購合約）
 * - rwaSecondaryMarket ← RWA_Secondary_Exchange.json（RWA 二級市場合約）
 * - aeSecondaryMarket ← AE_Market_Thin.json（AE 二級市場合約）
 */
export const CONTRACT_ABIS = {
  rwaMaster: rwaMasterAbi,
  aeToken: aeTokenAbi,
  jcToken: jcTokenAbi,
  rwaPrimarySale: rwaPrimarySaleAbi,
  rwaSecondaryMarket: rwaSecondaryMarketAbi,
  aeSecondaryMarket: aeSecondaryMarketAbi,
};
