import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, jwtVerify } from "jose";

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
  return JSON.parse(raw || "{}") as { identityToken?: string; walletAddress?: string };
}

const isAddress = (value: unknown): value is string =>
  typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);

// Privy identity tokens are signed with the app's public key, so we can verify
// email + embedded wallet claims via the public JWKS without any app secret.
const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const jwks = appId
  ? createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`))
  : null;

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return json(response, 405, { error: "Method not allowed" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceKey || !appId || !jwks) {
    return json(response, 503, { error: "Privy session bridge is not configured" });
  }

  let identityToken: string | undefined;
  let clientWallet: string | undefined;
  try {
    const body = await readBody(request);
    identityToken = body.identityToken;
    clientWallet = body.walletAddress;
  } catch {
    return json(response, 400, { error: "Invalid request body" });
  }
  if (!identityToken) return json(response, 400, { error: "identityToken required" });

  // 1. Verify the Privy identity token and read trusted claims.
  let privyId: string;
  let email: string | null = null;
  let verifiedWallet: string | null = null;
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
    return json(response, 401, { error: "Invalid Privy identity token" });
  }
  if (!privyId) return json(response, 401, { error: "Privy identity missing subject" });
  if (!email) return json(response, 422, { error: "Privy account has no email to link" });

  // Only trust the client-supplied wallet when it matches the verified claim.
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
