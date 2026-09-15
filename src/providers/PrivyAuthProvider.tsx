import type { ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { baseSepolia } from "viem/chains";

// Privy 的 App ID 是公開的用戶端識別碼；優先讀取環境變數，
// 未設定時退回專案指定的 App ID，確保預覽環境可直接運作。
const PRIVY_APP_ID =
  process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "cmtory3qt01gc0dl83bbj4pcw";

export function PrivyAuthProvider({ children }: { children: ReactNode }) {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: { theme: "dark" },
        loginMethods: ["email", "google"],
        // 測試 USDT 代幣與鏈上餘額讀取都在 Base Sepolia 測試網，
        // 內嵌錢包也必須用同一條鏈才能簽署轉帳交易。
        defaultChain: baseSepolia,
        supportedChains: [baseSepolia],
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
