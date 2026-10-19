import { base, baseSepolia } from "viem/chains";

/**
 * 網站目前跑哪一條鏈，由建置時的環境變數 NETWORK 決定（vite.config.ts 注入）。
 * 未設定時一律是測試網，所以既有的 rwmt.link 不需要任何設定就維持原樣。
 * 主網網站是另一個 Vercel 專案，設 NETWORK=mainnet。
 */
export type NetworkName = "testnet" | "mainnet";

export const NETWORK: NetworkName = process.env.NETWORK === "mainnet" ? "mainnet" : "testnet";
export const IS_MAINNET = NETWORK === "mainnet";

export const NETWORK_LABEL = IS_MAINNET ? "Base 主網" : "Base Sepolia 測試網";

export const NETWORK_CHAIN = IS_MAINNET ? base : baseSepolia;

/** 買入／回收 JC 用的穩定幣：主網為 Circle 原生 USDC，測試網沿用自訂測試 USDT。兩者都是 6 位小數。 */
export const STABLECOIN_SYMBOL = IS_MAINNET ? "USDC" : "USDT";

/**
 * 介面文案大多以「USDT」撰寫；主網顯示時統一換成 USDC，測試網原樣輸出。
 * 只替換大寫的幣種名稱，不影響程式識別字（usdt_amount 等）。
 */
export const withStablecoinSymbol = (text: string) => (IS_MAINNET ? text.replace(/USDT/g, "USDC") : text);

export const NETWORK_RPC_URL = IS_MAINNET ? "https://mainnet.base.org" : "https://sepolia.base.org";

const EXPLORER = IS_MAINNET ? "https://basescan.org" : "https://sepolia.basescan.org";
const BLOCKSCOUT_API = IS_MAINNET ? "https://base.blockscout.com" : "https://base-sepolia.blockscout.com";

export const explorerTxUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const explorerAddressUrl = (address: string) => `${EXPLORER}/address/${address}`;
export const blockscoutTokenTransfersUrl = (account: string) =>
  `${BLOCKSCOUT_API}/api/v2/addresses/${account}/token-transfers`;

/** 主網正式開放前只允許管理員登入；由主網專案的 MAINNET_PUBLIC_OPEN 控制。 */
export const MAINNET_ADMIN_ONLY = IS_MAINNET && process.env.MAINNET_PUBLIC_OPEN !== "true";
