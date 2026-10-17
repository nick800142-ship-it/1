import { getAddress } from "viem";
import { base } from "viem/chains";

// Base 主網正式版後端設定（尚未啟用）。與 src/lib/mainnetConfig.ts 內容一致，
// 但 serverless 不能 import 前端模組（CJS/ESM），所以分開維護；
// `node scripts/mainnet/verify-config.mjs` 會檢查兩邊與 contracts/mainnet/deployment.json 一致。
// 目前 relayer 仍讀 api/_onchain.ts 的 Base Sepolia 設定。
export const MAINNET_RELAYER_CHAIN = base;
export const MAINNET_RPC_URLS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"] as const;

export const MAINNET_RELAYER_ADDRESSES = {
  safe: getAddress("0x75653E53DE9b7b390e803295DdB4Afc461b55A9b"),
  hotWallet: getAddress("0x9FB5c5315Dc4329BFd04c17AB099a2e01327377F"),
  usdt: getAddress("0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2"),
  jcToken: getAddress("0xeE12e3829B86265795108E99F161757BBE89199C"),
  aeToken: getAddress("0x647F8bC9CaE2cE3bC6f11Ebe50C34A133706629F"),
  rwaFactory: getAddress("0x402DD7360B6efeDbAB580c36Ce6FfE697E4a88d9"),
  p2pEscrow: getAddress("0xE53717C6812C06420a36A8e1018d1bb5eDd585a9"),
  // Safe 官方 MultiSendCallOnly v1.4.1，Base 主網與 Sepolia 同地址（已確認鏈上有程式碼）。
  multiSendCallOnly: getAddress("0x9641d764fc13c8B624c04430C7356C1C7C8102e2"),
} as const;

// 主網與測試網 ABI 差異（切換時 api/_safe.ts、api/_onchain.ts 需照此調整）：
// - JC/AE：mint(amount) 只鑄給 Safe；burn(amount) 只燒呼叫者自己（Safe 銷毀庫存＝Safe 呼叫 burn）；
//   沒有 burnVaultInventory、adminReclaim、burnFrom。
// - RWA Factory：份額鑄給 owner（Safe）；沒有 subscribe/trade/safeVault/feeRecipient；
//   新增 migrateToken/importToken；RWAShareToken 的 factory 可轉移。
// - 四顆合約都是 Ownable2Step：transferOwnership 後需新 Safe acceptOwnership；renounceOwnership 停用。
export const MAINNET_ABI_NOTES = true;
