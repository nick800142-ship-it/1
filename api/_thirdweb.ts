import { createThirdwebClient } from "thirdweb";

/**
 * Creates a server-only Thirdweb client using the Vercel environment secret.
 * Never import this module from src/ or expose the secret in an API response.
 */
export function createThirdwebServerClient() {
  const secretKey = process.env.THIRDWEB_SECRET_KEY?.trim();

  if (!secretKey) {
    throw new Error("THIRDWEB_SECRET_KEY is not configured");
  }

  return createThirdwebClient({ secretKey });
}

type PregeneratedWalletResponse = {
  result?: { address?: string };
  error?: { message?: string } | string;
};

export async function pregenerateWalletForEmail(email: string) {
  const secretKey = process.env.THIRDWEB_SECRET_KEY?.trim();
  if (!secretKey) throw new Error("THIRDWEB_SECRET_KEY is not configured");

  // Validate the server SDK configuration before calling Thirdweb's official
  // pregeneration endpoint. The secret remains server-only in both paths.
  createThirdwebServerClient();
  const response = await fetch("https://api.thirdweb.com/v1/wallets/user", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-secret-key": secretKey,
    },
    body: JSON.stringify({ type: "email", email }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = (await response.json().catch(() => ({}))) as PregeneratedWalletResponse;
  const address = payload.result?.address?.trim();
  if (!response.ok || !address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    const detail = typeof payload.error === "string" ? payload.error : payload.error?.message;
    throw new Error(detail || `Thirdweb wallet creation failed (${response.status})`);
  }
  return address;
}
