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
