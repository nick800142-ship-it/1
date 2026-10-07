import { useEffect, useRef, useState } from "react";
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
  const embedded = wallets.find((w) => w.walletClientType === "privy") ?? null;
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
  return linked?.address ?? null;
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

let bridgeQueue: Promise<void> = Promise.resolve();
const inFlightBridges = new Map<string, Promise<void>>();

/**
 * Bridges the current Privy session into a real Supabase session.
 * Requests are deduped by identity and serialized so an older account cannot
 * finish after a newer account and silently replace its Supabase session.
 */
export function bridgePrivySession(params: BridgeParams): Promise<void> {
  const tokenKey = params.identityToken ?? params.accessToken ?? "";
  if (!tokenKey) return Promise.reject(new Error("No Privy token available yet"));
  const key = `${tokenKey}::${params.walletAddress?.toLowerCase() ?? "pending"}`;
  const existing = inFlightBridges.get(key);
  if (existing) return existing;

  const promise = bridgeQueue.catch(() => undefined).then(async () => {
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
    }
  });

  inFlightBridges.set(key, promise);
  bridgeQueue = promise;
  void promise.finally(() => {
    if (inFlightBridges.get(key) === promise) inFlightBridges.delete(key);
  }).catch(() => undefined);
  return promise;
}

export type PrivySessionSyncState = {
  status: "waiting" | "unauthenticated" | "preparing" | "syncing" | "ready" | "error";
  email: string | null;
  walletAddress: string | null;
  error?: string;
};

/**
 * Keeps the platform closed until the active Privy identity, embedded wallet,
 * Supabase session, and persisted profile wallet all refer to the same login.
 */
export function usePrivySupabaseSync(): PrivySessionSyncState {
  const { ready, authenticated, user, getAccessToken } = usePrivy();
  const { identityToken } = useIdentityToken();
  const { wallets } = useWallets();
  const completedFor = useRef<string | null>(null);
  const email = privyUserEmail(user);
  const walletAddress =
    embeddedWalletFromWallets(wallets) ?? embeddedWalletAddress(user);
  const [syncState, setSyncState] = useState<PrivySessionSyncState>({
    status: "waiting",
    email: null,
    walletAddress: null,
  });

  useEffect(() => {
    let active = true;
    const current = { email, walletAddress };

    if (!ready) {
      setSyncState({ status: "waiting", ...current });
      return () => { active = false; };
    }
    if (!authenticated || !user) {
      completedFor.current = null;
      setSyncState({ status: "unauthenticated", ...current });
      return () => { active = false; };
    }
    if (!email || !walletAddress) {
      completedFor.current = null;
      setSyncState({ status: "preparing", ...current });
      return () => { active = false; };
    }

    void (async () => {
      try {
        const accessToken = await getAccessToken().catch(() => null);
        if (!active) return;
        const tokenKey = identityToken ?? accessToken ?? "";
        if (!tokenKey) throw new Error("Privy 登入憑證尚未準備完成，請稍候重試。");
        const attemptKey = `${tokenKey}::${walletAddress.toLowerCase()}`;
        if (completedFor.current === attemptKey) {
          setSyncState({ status: "ready", ...current });
          return;
        }

        setSyncState({ status: "syncing", ...current });
        await bridgePrivySession({
          identityToken: identityToken ?? null,
          accessToken,
          email,
          walletAddress,
        });
        if (!active) return;

        const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;
        const sessionEmail = sessionData.session?.user.email?.toLowerCase();
        if (!sessionData.session || sessionEmail !== email.toLowerCase()) {
          throw new Error("平台登入帳號與 Privy 帳號不一致，請重新同步登入。");
        }

        const { data: profile, error: profileError } = await supabase
          .from("profiles")
          .select("wallet_address")
          .eq("id", sessionData.session.user.id)
          .maybeSingle();
        if (profileError) throw profileError;
        if (profile?.wallet_address?.toLowerCase() !== walletAddress.toLowerCase()) {
          throw new Error("平台錢包資料尚未同步完成，請重新同步登入。");
        }

        completedFor.current = attemptKey;
        setSyncState({ status: "ready", ...current });
      } catch (error) {
        if (!active) return;
        completedFor.current = null;
        console.error("[v0] Privy → Supabase sync failed:", error);
        setSyncState({
          status: "error",
          ...current,
          error: error instanceof Error ? error.message : "平台登入同步失敗，請重試。",
        });
      }
    })();

    return () => { active = false; };
  }, [ready, authenticated, user, identityToken, getAccessToken, wallets, email, walletAddress]);

  return syncState;
}
