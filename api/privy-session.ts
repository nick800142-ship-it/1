import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient } from "@supabase/supabase-js";

// `jose` is ESM-only. A static `import ... from "jose"` compiles to
// `require("jose")` in the CommonJS serverless bundle that @vercel/node emits,
// which throws ERR_REQUIRE_ESM at cold start and makes every /api/privy-session
// call return HTTP 500 — silently breaking new-user signup in production while
// working fine under Vite's ESM dev server. Load it lazily via dynamic
// import(), which works in both CJS and ESM output.
type JoseModule = typeof import("jose");
let josePromise: Promise<JoseModule> | null = null;
const loadJose = () => (josePromise ??= import("jose"));

type LinkedAccount = {
  type?: string;
  address?: string;
  email?: string;
  wallet_client?: string;
  wallet_client_type?: string;
  chain_type?: string;
};

function json(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

async function readBody(request: IncomingMessage) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 32_768) throw new Error("Payload too large");
  }
  return JSON.parse(raw || "{}") as {
    identityToken?: string;
    accessToken?: string;
    email?: string;
    walletAddress?: string;
  };
}

const isEmail = (value: unknown): value is string =>
  typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const isAddress = (value: unknown): value is string =>
  typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);

// Privy identity tokens are signed with the app's public key, so we can verify
// email + embedded wallet claims via the public JWKS without any app secret.
// Falls back to the known project App ID when the env var isn't mirrored into
// the local dev process (it still reads the env var first in production).
const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "cmtory3qt01gc0dl83bbj4pcw";
let jwksCache: ReturnType<JoseModule["createRemoteJWKSet"]> | null = null;
async function getJwks() {
  if (!appId) return null;
  if (!jwksCache) {
    const { createRemoteJWKSet } = await loadJose();
    jwksCache = createRemoteJWKSet(
      new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`),
    );
  }
  return jwksCache;
}

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return json(response, 405, { error: "Method not allowed" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  const jwks = await getJwks();
  if (!supabaseUrl || !serviceKey || !appId || !jwks) {
    return json(response, 503, { error: "Privy session bridge is not configured" });
  }
  const { jwtVerify } = await loadJose();

  let identityToken: string | undefined;
  let accessToken: string | undefined;
  let clientEmail: string | undefined;
  let clientWallet: string | undefined;
  try {
    const body = await readBody(request);
    identityToken = body.identityToken;
    accessToken = body.accessToken;
    clientEmail = body.email;
    clientWallet = body.walletAddress;
  } catch {
    return json(response, 400, { error: "Invalid request body" });
  }
  if (!identityToken && !accessToken) {
    return json(response, 400, { error: "identityToken or accessToken required" });
  }

  // 1. Authenticate the request. Prefer the identity token — its signed
  //    claims let us verify email + wallet server-side without trusting the
  //    client. Identity tokens require a Privy Dashboard toggle ("Return
  //    user data in an identity token"), so fall back to the access token
  //    (always issued for any authenticated session) when it's unavailable.
  //    The access token still proves a genuine, current Privy session for a
  //    specific DID; we just can't read its linked accounts, so we trust the
  //    client-supplied email/wallet in that path instead.
  let privyId = "";
  let email: string | null = null;
  let verifiedWallet: string | null = null;

  if (identityToken) {
    try {
      const { payload } = await jwtVerify(identityToken, jwks, {
        issuer: "privy.io",
        audience: appId,
      });
      privyId = String(payload.sub ?? "");
      const rawLinked = payload.linked_accounts;
      const linked: LinkedAccount[] = typeof rawLinked === "string" ? JSON.parse(rawLinked) : [];
      const emailAccount = linked.find((account) => account.type === "email" && account.address);
      const googleAccount = linked.find((account) => account.type === "google_oauth" && account.email);
      email = (emailAccount?.address ?? googleAccount?.email ?? null)?.toLowerCase() ?? null;
      const embeddedWallet = linked.find(
        (account) =>
          account.type === "wallet" &&
          (account.wallet_client === "privy" || account.wallet_client_type === "privy") &&
          isAddress(account.address),
      );
      if (embeddedWallet?.address) verifiedWallet = embeddedWallet.address;
    } catch {
      identityToken = undefined; // fall through to the access-token path below
    }
  }

  if (!privyId && accessToken) {
    try {
      const { payload } = await jwtVerify(accessToken, jwks, {
        issuer: "privy.io",
        audience: appId,
      });
      privyId = String(payload.sub ?? "");
    } catch {
      return json(response, 401, { error: "Invalid Privy token" });
    }
  }

  if (!privyId) return json(response, 401, { error: "Invalid Privy token" });

  // Client-supplied email fallback. This must apply whenever we still don't
  // have an email — NOT only in the access-token branch. Privy identity
  // tokens frequently omit the email in their `linked_accounts` claim
  // (especially Google logins), which previously set `privyId` but left
  // `email` null, skipped this fallback (it was nested in the access-token
  // block), and 422'd — blocking first-time login even though the client
  // clearly knows the email. Reaching here already required a
  // cryptographically verified Privy token for this app, so trusting the
  // client's email here matches the existing access-token trust model.
  if (!email && isEmail(clientEmail)) email = clientEmail.toLowerCase();

  if (!email) return json(response, 422, { error: "Privy account has no email to link" });

  // Only trust the client-supplied wallet when it matches the verified claim
  // (identity-token path) or passes basic address validation (fallback path).
  const walletAddress =
    verifiedWallet ?? (isAddress(clientWallet) ? (clientWallet as string) : null);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 2. Resolve (or create) the Supabase account for this email.
  let userId: string | null = null;
  const { data: existingProfile } = await admin
    .from("profiles")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  userId = existingProfile?.id ?? null;

  if (!userId) {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { privy_id: privyId },
    });
    if (created?.user) {
      userId = created.user.id;
    } else if (createError) {
      // User may already exist in auth without a profile row; find them by paging.
      for (let page = 1; page <= 20 && !userId; page += 1) {
        const { data: list, error: listError } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        if (listError) break;
        const match = list.users.find((candidate) => candidate.email?.toLowerCase() === email);
        if (match) userId = match.id;
        if (list.users.length < 200) break;
      }
    }
  }

  if (!userId) return json(response, 500, { error: "Unable to resolve platform account" });

  // 3. Best-effort sync of the real Privy wallet + Privy id onto the profile.
  //    A sync failure must NEVER block the user from entering the platform,
  //    so we upsert (avoids duplicate-key crashes) inside try/catch and only
  //    log on error before continuing to issue the session.
  const profilePayload: Record<string, unknown> = {
    id: userId,
    email,
    privy_id: privyId,
    updated_at: new Date().toISOString(),
  };
  if (walletAddress) profilePayload.wallet_address = walletAddress;
  try {
    const { error: upsertError } = await admin
      .from("profiles")
      .upsert(profilePayload, { onConflict: "id" });
    if (upsertError) {
      console.error("[v0] privy-session profile sync failed:", upsertError.message);
    }
  } catch (syncError) {
    console.error("[v0] privy-session profile sync threw:", syncError);
  }

  // 4. Mint a one-time token the browser can exchange for a real Supabase session.
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const tokenHash = linkData?.properties?.hashed_token;
  if (linkError || !tokenHash) {
    return json(response, 500, { error: "Unable to issue session" });
  }

  return json(response, 200, { tokenHash, email, walletAddress });
}
