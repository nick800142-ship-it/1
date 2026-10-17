import { getAddress, type Address } from "viem";
import { base } from "viem/chains";

/**
 * Base 主網正式版設定（尚未啟用）。
 *
 * 四顆合約都用 CREATE2 決定性部署，地址在部署前就已固定，來源為
 * contracts/mainnet/deployment.json（`node scripts/mainnet/build-contracts.mjs` 產生）。
 * 合約原始碼或編譯設定一改，地址就會變；`node scripts/mainnet/verify-config.mjs`
 * 會檢查這裡、api/_mainnetConfig.ts 與 deployment.json 是否一致。
 *
 * 目前全站仍讀 src/lib/contracts.ts（Base Sepolia）。切換主網時才把呼叫端改讀這裡。
 */
export const MAINNET_CHAIN = base;
export const MAINNET_CHAIN_ID = base.id; // 8453
export const MAINNET_RPC_URL = "https://mainnet.base.org";
export const MAINNET_EXPLORER = "https://basescan.org";

export const MAINNET_ADDRESSES = {
  /** 平台 Safe（Safe 1.5.0，2/3 門檻）：JC/AE/RWA Factory/託管的 owner、手續費收款、庫存金庫。 */
  safe: getAddress("0x75653E53DE9b7b390e803295DdB4Afc461b55A9b"),
  /** 營運熱錢包：託管 operator（撮合、forceCancel、pause）、代付 Gas、日常撥款；不能鑄造或銷毀。 */
  hotWallet: getAddress("0x9FB5c5315Dc4329BFd04c17AB099a2e01327377F"),
  /** Base 主網 USDT（Bridged Tether USD，6 decimals）。 */
  usdt: getAddress("0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2"),
  jcToken: getAddress("0xeE12e3829B86265795108E99F161757BBE89199C"),
  aeToken: getAddress("0x647F8bC9CaE2cE3bC6f11Ebe50C34A133706629F"),
  rwaFactory: getAddress("0x402DD7360B6efeDbAB580c36Ce6FfE697E4a88d9"),
  p2pEscrow: getAddress("0xE53717C6812C06420a36A8e1018d1bb5eDd585a9"),
} as const satisfies Record<string, Address>;

export const MAINNET_TOKEN_DECIMALS = { usdt: 6, jc: 18, ae: 18 } as const;

/** 託管合約部署時的初始費率；之後由 Safe 呼叫 setFees 調整（上限 5% / 10 JC）。 */
export const MAINNET_P2P_DEFAULT_FEES = { feeBps: 100, listingFeeJc: 1 } as const;

export const mainnetTxUrl = (hash: string) => `${MAINNET_EXPLORER}/tx/${hash}`;
export const mainnetAddressUrl = (address: string) => `${MAINNET_EXPLORER}/address/${address}`;
