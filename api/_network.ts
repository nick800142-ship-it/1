import { base, baseSepolia } from "viem/chains";

/**
 * 後端目前跑哪一條鏈，由 Vercel 專案的環境變數 NETWORK 決定。
 * 未設定＝測試網（既有 rwmt.link 專案不需任何設定）。主網專案設 NETWORK=mainnet。
 * 前端對應的是 src/lib/network.ts，兩邊讀同一個變數。
 */
export const IS_MAINNET = process.env.NETWORK === "mainnet";
export const NETWORK_NAME = IS_MAINNET ? "mainnet" : "testnet";
export const NETWORK_LABEL = IS_MAINNET ? "Base 主網" : "Base Sepolia 測試網";

export const NETWORK_CHAIN = IS_MAINNET ? base : baseSepolia;

export const NETWORK_RPC_URLS: readonly string[] = IS_MAINNET
  ? [process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org", "https://base-rpc.publicnode.com"]
  : [process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"];

export const EXPLORER_TX_URL = (hash: string) =>
  `${IS_MAINNET ? "https://basescan.org" : "https://sepolia.basescan.org"}/tx/${hash}`;

/** 主網正式開放前只允許管理員登入（MAINNET_PUBLIC_OPEN=true 才開放一般用戶）。 */
export const MAINNET_ADMIN_ONLY = IS_MAINNET && process.env.MAINNET_PUBLIC_OPEN !== "true";
