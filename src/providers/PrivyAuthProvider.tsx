import type { ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { base } from "viem/chains";

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
        defaultChain: base,
        supportedChains: [base],
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
