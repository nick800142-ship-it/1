import { useEffect, useRef } from "react";
import { usePrivy, useIdentityToken, useWallets } from "@privy-io/react-auth";
import { supabase } from "@/lib/supabase";

// Earliest authoritative source for the embedded wallet address. `useWallets()`
// reports the Privy embedded wallet as soon as it is provisioned during login
// (createOnLogin), typically before it shows up in `user.linkedAccounts`. Using
// it means the wallet gets bound into Supabase on the very first login without
// the user having to wait or log in again.
function embeddedWalletFromWallets(
  wallets: ReturnType<typeof useWallets>["wallets"],
): string | null {
  const embedded =
    wallets.find((w) => w.walletClientType === "privy") ?? wallets[0] ?? null;
  return embedded?.address ?? null;
}

const BRIDGE_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export function embeddedWalletAddress(
  user: ReturnType<typeof usePrivy>["user"],
): string | null {
  const linked = user?.linkedAccounts?.find(
    (account) =>
      account.type === "wallet" &&
      "walletClientType" in account &&
      account.walletClientType === "privy",
  ) as { address?: string } | undefined;
  return linked?.address ?? user?.wallet?.address ?? null;
}

export function privyUserEmail(user: ReturnType<typeof usePrivy>["user"]): string | null {
  return user?.email?.address ?? user?.google?.email ?? null;
}

type BridgeParams = {
  /** Present only when the Privy Dashboard has "return user data in identity
   *  token" enabled. When present, the backend verifies email + wallet from
   *  its signed claims — the strongest trust path. */
  identityToken: string | null;
  /** Always available for any authenticated Privy session. Used as a
   *  fallback proof-of-session when the identity token feature isn't
   *  enabled, so login never gets permanently stuck. */
  accessToken: string | null;
  email: string | null;
  walletAddress: string | null;
};

let inFlight: { key: string; promise: Promise<void> } | null = null;

/**
 * Bridges the current Privy session into a real Supabase session.
 * Calls are deduped by token so the background auto-sync effect and a
 * manual "進入平台儀表板" click never fire two competing requests.
 */
export function bridgePrivySession(params: BridgeParams): Promise<void> {
  const key = params.identityToken ?? params.accessToken ?? "";
  if (!key) return Promise.reject(new Error("No Privy token available yet"));
  if (inFlight && inFlight.key === key) return inFlight.promise;

  const promise = (async () => {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);
    try {
      const response = await fetch("/api/privy-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identityToken: params.identityToken,
          accessToken: params.accessToken,
          email: params.email,
          walletAddress: params.walletAddress,
        }),
        signal: controller.signal,
      });
      const rawText = await response.text();
      let payload: { tokenHash?: string; error?: string } = {};
      try {
        payload = rawText ? (JSON.parse(rawText) as typeof payload) : {};
      } catch {
        throw new Error(
          `bridge returned non-JSON (${response.status}): ${rawText.slice(0, 120)}`,
        );
      }
      if (!response.ok || !payload.tokenHash) {
        throw new Error(payload.error ?? `bridge failed (${response.status})`);
      }
      const { error } = await withTimeout(
        supabase.auth.verifyOtp({ token_hash: payload.tokenHash, type: "magiclink" }),
        BRIDGE_TIMEOUT_MS,
        "verifyOtp",
      );
      if (error) throw error;
    } finally {
      clearTimeout(abortTimer);
      if (inFlight?.key === key) inFlight = null;
    }
  })();

  inFlight = { key, promise };
  return promise;
}

/**
 * Fully decoupled from the login UI: once Privy reports an authenticated
 * user, this fires a background bridge to Supabase (create/refresh the
 * session + upsert the profile's email/wallet_address/privy_id). It never
 * blocks, never surfaces its state to the caller, and any failure is only
 * logged — the login screen must keep working regardless of the outcome.
 */
export function usePrivySupabaseSync() {
  const { ready, authenticated, user, getAccessToken } = usePrivy();
  const { identityToken } = useIdentityToken();
  const { wallets } = useWallets();
  const attemptedFor = useRef<string | null>(null);

  useEffect(() => {
    console.log("Privy Authenticated:", authenticated, user);
    if (!ready || !authenticated || !user) return;

    void (async () => {
      // Identity tokens require a Privy Dashboard toggle; the access token
      // is always available, so it's the fallback proof-of-session.
      const accessToken = await getAccessToken().catch(() => null);
      const tokenKey = identityToken ?? accessToken ?? "";
      if (!tokenKey) return;

      // The embedded wallet is created during login, so it can still be null
      // on the very first run of this effect. Prefer `useWallets()` (earliest
      // authoritative source) and fall back to the `user.linkedAccounts`
      // reader. Folding the address into the dedupe key (instead of just the
      // token) guarantees we fire a second, real sync the moment Privy
      // provisions the wallet — otherwise wallet_address could stay stuck at
      // null in Supabase, even though the token never changes.
      const walletAddress =
        embeddedWalletFromWallets(wallets) ?? embeddedWalletAddress(user);
      const attemptKey = `${tokenKey}::${walletAddress ?? "pending"}`;
      if (attemptedFor.current === attemptKey) return;
      attemptedFor.current = attemptKey;

      try {
        await bridgePrivySession({
          identityToken: identityToken ?? null,
          accessToken,
          email: privyUserEmail(user),
          walletAddress,
        });
      } catch (error) {
        // Never let a Supabase sync failure affect the Privy login UI — log only.
        console.error("[v0] Privy → Supabase background sync failed:", error);
        attemptedFor.current = null;
      }
    })();
  }, [ready, authenticated, user, identityToken, getAccessToken, wallets]);
}
