import type { ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { CHAIN } from "@/lib/contracts";

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
        // 所有合約（USDT、JC、AE、RWA 一二級市場）都部署在 Base Sepolia 測試網，
        // 內嵌錢包也必須用同一條鏈才能簽署轉帳交易。鏈設定統一從 @/lib/contracts 讀取。
        defaultChain: CHAIN,
        supportedChains: [CHAIN],
        embeddedWallets: {
          ethereum: { createOnLogin: "all-users" },
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
