import { useState } from "react";
import { usePrivy, useIdentityToken, useWallets } from "@privy-io/react-auth";
import { supabase } from "@/lib/supabase";
import {
  bridgePrivySession,
  embeddedWalletAddress,
  privyUserEmail,
} from "@/hooks/usePrivySupabaseSync";

type GateCopy = { button: string; syncError?: string };

export function PrivyAuthGate({ copy }: { copy: GateCopy }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { identityToken } = useIdentityToken();
  const { wallets } = useWallets();
  const [entering, setEntering] = useState(false);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  // Logging out must clear BOTH Privy and Supabase sessions. Privy's
  // logout() alone leaves the previous account's Supabase session active,
  // so switching to a different account on the next login can keep showing
  // the old account's wallet address until a reload happens to line back
  // up by chance. Clearing Supabase here makes account switching reliable.
  const signOutEverywhere = async () => {
    setSigningOut(true);
    try {
      await supabase.auth.signOut();
    } catch (error) {
      console.error("[v0] Supabase sign-out failed:", error);
    } finally {
      await logout();
      setSigningOut(false);
    }
  };

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
  // Prefer useWallets() — it reports the embedded wallet the moment it is
  // provisioned during login, so the address shows (and binds) immediately
  // instead of sitting on "生成中…".
  const walletFromWallets =
    wallets.find((w) => w.walletClientType === "privy")?.address ?? null;
  const walletAddress = walletFromWallets ?? embeddedWalletAddress(user);

  const enterDashboard = async () => {
    setEntering(true);
    setEntryError(null);
    try {
      if (!email) throw new Error("Privy 帳號尚未提供 Email，請先完成登入驗證。");
      if (!walletAddress) throw new Error("Privy 嵌入式錢包尚未準備完成，請稍候後重試。");
      const accessToken = await getAccessToken().catch(() => null);
      await bridgePrivySession({
        identityToken: identityToken ?? null,
        accessToken,
        email,
        walletAddress,
      });
      window.location.reload();
    } catch (error) {
      console.error("[v0] Enter dashboard failed:", error);
      setEntryError(
        error instanceof Error ? error.message : "同步帳號時發生問題，請再試一次",
      );
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
      {!walletAddress && (
        <p role="status" className="text-sm leading-6 text-amber-200">
          嵌入式錢包尚未準備好；完成錢包同步前不會開放平台交易。若持續無法完成，請登出後重新登入。
        </p>
      )}
      <button
        type="button"
        onClick={enterDashboard}
        disabled={entering || !ready || !email || !walletAddress}
        className="flex w-full items-center justify-center rounded-xl bg-amber-400 px-4 py-3 text-base font-bold text-slate-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-70"
      >
        {entering
          ? "同步平台帳號與錢包中…"
          : !walletAddress
            ? "錢包準備中…"
            : !email
              ? "等待帳號資料…"
              : "進入平台儀表板"}
      </button>
      {(entryError || copy.syncError) && (
        <p role="alert" className="text-sm text-red-400">
          {entryError || copy.syncError}
        </p>
      )}
      <button
        type="button"
        onClick={() => void signOutEverywhere()}
        disabled={signingOut}
        className="text-sm text-slate-400 transition hover:text-slate-200 hover:underline disabled:cursor-not-allowed disabled:opacity-70"
      >
        {signingOut ? "登出中…" : "登出"}
      </button>
    </div>
  );
}
