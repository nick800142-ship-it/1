import { useState } from "react";
import { usePrivy, useIdentityToken, useWallets } from "@privy-io/react-auth";
import { supabase } from "@/lib/supabase";
import {
  bridgePrivySession,
  embeddedWalletAddress,
  privyUserEmail,
} from "@/hooks/usePrivySupabaseSync";

type GateCopy = {
  button: string;
  language: string;
  success: string;
  email: string;
  wallet: string;
  walletPending: string;
  walletWarning: string;
  syncing: string;
  preparingWallet: string;
  waitingAccount: string;
  enterDashboard: string;
  signOut: string;
  signingOut: string;
  missingEmail: string;
  walletNotReady: string;
  syncFallback: string;
  syncError?: string;
};

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
      if (!email) throw new Error(copy.missingEmail);
      if (!walletAddress) throw new Error(copy.walletNotReady);
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
        error instanceof Error ? error.message : copy.syncFallback,
      );
      setEntering(false);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <p className="text-base font-bold text-emerald-400">{copy.success}</p>
      <div className="w-full space-y-1.5 rounded-xl bg-slate-800 px-4 py-3 text-left text-sm">
        <p className="text-slate-400">
          {copy.email}<span className="text-slate-100">{email ?? "—"}</span>
        </p>
        <p className="break-all font-mono text-xs text-slate-400">
          {copy.wallet}
          <span className="text-slate-100">{walletAddress ?? copy.walletPending}</span>
        </p>
      </div>
      {!walletAddress && (
        <p role="status" className="text-sm leading-6 text-amber-200">
          {copy.walletWarning}
        </p>
      )}
      <button
        type="button"
        onClick={enterDashboard}
        disabled={entering || !ready || !email || !walletAddress}
        className="flex w-full items-center justify-center rounded-xl bg-amber-400 px-4 py-3 text-base font-bold text-slate-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-70"
      >
        {entering
          ? copy.syncing
          : !walletAddress
            ? copy.preparingWallet
            : !email
              ? copy.waitingAccount
              : copy.enterDashboard}
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
        {signingOut ? copy.signingOut : copy.signOut}
      </button>
    </div>
  );
}
