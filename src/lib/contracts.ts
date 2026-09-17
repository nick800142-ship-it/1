import { erc20Abi, type Address } from "viem";
import { baseSepolia } from "viem/chains";

/**
 * 全站鏈上合約設定的唯一來源。所有讀取/簽署鏈上交易的程式碼都應該從這裡
 * 匯入地址與 ABI，不要在個別檔案裡各自寫死地址——換合約或換鏈時只要改這裡。
 *
 * 目前鎖定在 Base Sepolia 測試網，所有合約與代幣都部署在同一條鏈上。
 */
export const CHAIN = baseSepolia;
export const CHAIN_ID = baseSepolia.id; // 84532

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
  /** RWA 母合約（自訂合約，ABI 待補）。 */
  rwaMaster: requireAddress(
    process.env.NEXT_PUBLIC_RWA_MASTER_ADDRESS,
    "0x406555b7F4AD841e62a40B926A0864c8a8549775",
    "RWA 母合約",
  ),
  /** RWA 一級認購合約（自訂合約，ABI 待補）。 */
  rwaPrimarySale: requireAddress(
    process.env.NEXT_PUBLIC_RWA_PRIMARY_SALE_ADDRESS,
    "0xFeB4871230151DF02f8476F9c9295356A1412ab8",
    "RWA 一級認購合約",
  ),
  /** RWA 二級市場合約（自訂合約，ABI 待補）。 */
  rwaSecondaryMarket: requireAddress(
    process.env.NEXT_PUBLIC_RWA_SECONDARY_MARKET_ADDRESS,
    "0x3Ec85939a5e3BAC78A3F38d0587362782AEd6968",
    "RWA 二級市場合約",
  ),
  /** JC 結算代幣合約（標準 ERC-20）。 */
  jcToken: requireAddress(
    process.env.NEXT_PUBLIC_JC_TOKEN_ADDRESS,
    "0xa85e0664701fBec23596bFE88eB26d4efd1C7723",
    "JC 結算代幣合約",
  ),
  /** AE 代幣合約（標準 ERC-20）。 */
  aeToken: requireAddress(
    process.env.NEXT_PUBLIC_AE_TOKEN_ADDRESS,
    "0x3C498D377B86E837a7267597A81A5F11cf15a3Cf",
    "AE 代幣合約",
  ),
  /** AE 二級市場合約（自訂合約，ABI 待補）。 */
  aeSecondaryMarket: requireAddress(
    process.env.NEXT_PUBLIC_AE_SECONDARY_MARKET_ADDRESS,
    "0x4cd896de633e189928de46032647c32270cD9663",
    "AE 二級市場合約",
  ),
} as const;

// 標準 ERC-20 ABI（balanceOf / transfer / approve / allowance / decimals ...），
// 適用於 usdt、jcToken、aeToken 這三個代幣合約。
export const ERC20_ABI = erc20Abi;

/**
 * rwaMaster / rwaPrimarySale / rwaSecondaryMarket / aeSecondaryMarket 是自訂合約，
 * 目前尚未取得實際部署的函式介面（ABI）。瞎猜函式名稱或參數可能呼叫失敗，
 * 甚至誤呼叫到危險的函式，所以先留空陣列，等拿到正式 ABI（例如從 BaseScan
 * 已驗證原始碼複製，或編譯產物 artifacts/*.json 的 "abi" 欄位）再補上。
 *
 * 補上時直接改這裡的值，所有引用 CONTRACT_ABIS.* 的程式碼不需要再改。
 */
export const CONTRACT_ABIS = {
  rwaMaster: [] as const,
  rwaPrimarySale: [] as const,
  rwaSecondaryMarket: [] as const,
  aeSecondaryMarket: [] as const,
};
