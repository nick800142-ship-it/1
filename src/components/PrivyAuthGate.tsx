import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { usePrivy, useIdentityToken } from "@privy-io/react-auth";
import { supabase } from "@/lib/supabase";

type GateCopy = { button: string; connecting: string; error: string };

const BRIDGE_TIMEOUT_MS = 15_000;

const embeddedWalletAddress = (
  user: ReturnType<typeof usePrivy>["user"],
): string | null => {
  const linked = user?.linkedAccounts?.find(
    (account) =>
      account.type === "wallet" &&
      "walletClientType" in account &&
      account.walletClientType === "privy",
  ) as { address?: string } | undefined;
  return linked?.address ?? user?.wallet?.address ?? null;
};

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export function PrivyAuthGate({ copy }: { copy: GateCopy }) {
  const { ready, authenticated, user, login } = usePrivy();
  const { identityToken } = useIdentityToken();
  const [bridging, setBridging] = useState(false);
  const [failed, setFailed] = useState(false);
  const bridgedFor = useRef<string | null>(null);

  const bridge = useCallback(
    async (token: string) => {
      setBridging(true);
      setFailed(false);
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);
      try {
        const response = await fetch("/api/privy-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            identityToken: token,
            walletAddress: embeddedWalletAddress(user),
          }),
          signal: controller.signal,
        });
        const rawText = await response.text();
        let payload: { tokenHash?: string; error?: string } = {};
        try {
          payload = rawText ? (JSON.parse(rawText) as typeof payload) : {};
        } catch {
          // Non-JSON response (e.g. dev server returned index.html) — surface it.
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
        // Success: App's auth listener swaps in the platform automatically.
        // We intentionally leave `bridging` true so the button keeps spinning
        // during the brief unmount; the timeout guards against a real hang.
      } catch (error) {
        // Never leave the user stuck: log, surface a retry, and re-enable login.
        console.error("[v0] Privy → Supabase bridge failed:", error);
        bridgedFor.current = null;
        setFailed(true);
        setBridging(false);
      } finally {
        clearTimeout(abortTimer);
      }
    },
    [user],
  );

  useEffect(() => {
    // Only run post-login logic once Privy is ready AND the user is authenticated.
    if (!ready || !authenticated || !identityToken) return;
    if (bridgedFor.current === identityToken) return;
    bridgedFor.current = identityToken;
    void bridge(identityToken);
  }, [ready, authenticated, identityToken, bridge]);

  const busy = !ready || bridging || (authenticated && !failed);

  return (
    <div className="flex w-full flex-col items-center gap-3">
      <button
        type="button"
        onClick={() => login()}
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-400 px-4 py-3 text-base font-bold text-slate-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-70"
      >
        {busy && <LoaderCircle aria-hidden="true" className="size-5 animate-spin" />}
        {busy ? copy.connecting : copy.button}
      </button>
      {failed && (
        <p role="alert" className="text-sm text-red-400">
          {copy.error}
        </p>
      )}
    </div>
  );
}
