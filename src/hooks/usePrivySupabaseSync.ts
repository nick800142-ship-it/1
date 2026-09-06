import { useEffect, useRef } from "react";
import { usePrivy, useIdentityToken } from "@privy-io/react-auth";
import { supabase } from "@/lib/supabase";

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

/**
 * Fully decoupled from the login UI: once Privy reports an authenticated
 * user, this fires a background bridge to Supabase (create/refresh the
 * session + upsert the profile's email/wallet_address/privy_id). It never
 * blocks, never surfaces its state to the caller, and any failure is only
 * logged — the login screen must keep working regardless of the outcome.
 */
export function usePrivySupabaseSync() {
  const { ready, authenticated, user } = usePrivy();
  const { identityToken } = useIdentityToken();
  const syncedFor = useRef<string | null>(null);

  useEffect(() => {
    console.log("Privy Authenticated:", authenticated, user);
    if (!ready || !authenticated || !user || !identityToken) return;
    if (syncedFor.current === identityToken) return;
    syncedFor.current = identityToken;

    void (async () => {
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);
      try {
        const response = await fetch("/api/privy-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            identityToken,
            walletAddress: embeddedWalletAddress(user),
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
      } catch (error) {
        // Never let a Supabase sync failure affect the Privy login UI — log only.
        console.error("[v0] Privy → Supabase background sync failed:", error);
        syncedFor.current = null;
      } finally {
        clearTimeout(abortTimer);
      }
    })();
  }, [ready, authenticated, user, identityToken]);
}
