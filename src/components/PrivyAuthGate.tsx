import { useState } from "react";
import { usePrivy, useIdentityToken } from "@privy-io/react-auth";
import { supabase } from "@/lib/supabase";
import {
  bridgePrivySession,
  embeddedWalletAddress,
  privyUserEmail,
  usePrivySupabaseSync,
} from "@/hooks/usePrivySupabaseSync";

type GateCopy = { button: string };

export function PrivyAuthGate({ copy }: { copy: GateCopy }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { identityToken } = useIdentityToken();
  const [entering, setEntering] = useState(false);
  const [entryError, setEntryError] = useState<string | null>(null);

  // Fully decoupled background sync — never affects what this renders.
  usePrivySupabaseSync();

  if (!authenticated) {
    return (
      <button
        type="button"
        onClick={() => login()}
        disabled={!ready}
        className="flex w-full items-center justify-center rounded-xl bg-amber-400 px-4 py-3 text-base font-bold text-slate-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-70"
      >
        {copy.button}
      </button>
    );
  }

  const email = privyUserEmail(user);
  const walletAddress = embeddedWalletAddress(user);

  const enterDashboard = async () => {
    setEntering(true);
    setEntryError(null);
    try {
      // If the background sync already finished, this is instant.
      // Otherwise, actively wait for (or kick off) the same bridge instead
      // of blindly reloading before a Supabase session actually exists.
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        const accessToken = await getAccessToken().catch(() => null);
        await bridgePrivySession({
          identityToken: identityToken ?? null,
          accessToken,
          email,
          walletAddress,
        });
      }
      window.location.reload();
    } catch (error) {
      console.error("[v0] Enter dashboard failed:", error);
      setEntryError("同步帳號時發生問題，請再試一次");
      setEntering(false);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <p className="text-base font-bold text-emerald-400">已成功登入！</p>
      <div className="w-full space-y-1.5 rounded-xl bg-slate-800 px-4 py-3 text-left text-sm">
        <p className="text-slate-400">
          Email：<span className="text-slate-100">{email ?? "—"}</span>
        </p>
        <p className="break-all font-mono text-xs text-slate-400">
          錢包地址：
          <span className="text-slate-100">{walletAddress ?? "生成中…"}</span>
        </p>
      </div>
      <button
        type="button"
        onClick={enterDashboard}
        disabled={entering}
        className="flex w-full items-center justify-center rounded-xl bg-amber-400 px-4 py-3 text-base font-bold text-slate-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-70"
      >
        {entering ? "同步中…" : "進入平台儀表板"}
      </button>
      {entryError && (
        <p role="alert" className="text-sm text-red-400">
          {entryError}
        </p>
      )}
      <button
        type="button"
        onClick={() => logout()}
        className="text-sm text-slate-400 transition hover:text-slate-200 hover:underline"
      >
        登出
      </button>
    </div>
  );
}
