import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { pregenerateWalletForEmail } from "./_thirdweb.js";

type ProfileRow = { id: string; email: string; wallet_address: string | null };
type Failure = { userId: string; message: string };

function json(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

function isMissingWallet(value: string | null) {
  const normalized = value?.trim().toLowerCase();
  return !normalized || normalized === "未綁定" || normalized === "unbound";
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        await worker(items[index]);
      }
    }),
  );
}

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return json(response, 405, { error: "Method not allowed" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceKey || !process.env.THIRDWEB_SECRET_KEY) {
    return json(response, 503, { error: "Wallet backfill service is not configured" });
  }

  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return json(response, 401, { error: "Authentication required" });

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return json(response, 401, { error: "Invalid session" });

  const { data: actorProfile, error: actorError } = await admin
    .from("profiles")
    .select("agency_role")
    .eq("id", authData.user.id)
    .single();
  if (actorError || !["admin", "super_admin", "管理員"].includes(actorProfile?.agency_role ?? "")) {
    return json(response, 403, { error: "Admin access required" });
  }

  const profiles: ProfileRow[] = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await admin
      .from("profiles")
      .select("id,email,wallet_address")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) return json(response, 500, { error: "Unable to load profiles" });
    const rows = (data ?? []) as ProfileRow[];
    profiles.push(...rows.filter((profile) => isMissingWallet(profile.wallet_address)));
    if (rows.length < pageSize) break;
  }

  let updated = 0;
  let skipped = 0;
  const failures: Failure[] = [];
  await mapWithConcurrency(profiles, 4, async (profile) => {
    if (!profile.email?.trim()) {
      failures.push({ userId: profile.id, message: "Missing email" });
      return;
    }
    try {
      const address = await pregenerateWalletForEmail(profile.email.trim().toLowerCase());
      let updateQuery = admin
        .from("profiles")
        .update({ wallet_address: address })
        .eq("id", profile.id);
      updateQuery = profile.wallet_address === null
        ? updateQuery.is("wallet_address", null)
        : updateQuery.eq("wallet_address", profile.wallet_address);
      const { data, error } = await updateQuery.select("id").maybeSingle();
      if (error) throw error;
      if (data) updated += 1;
      else skipped += 1;
    } catch (error) {
      failures.push({
        userId: profile.id,
        message: error instanceof Error ? error.message.slice(0, 240) : "Unknown error",
      });
    }
  });

  return json(response, failures.length ? 207 : 200, {
    scanned: profiles.length,
    updated,
    skipped,
    failed: failures.length,
    failures,
  });
}
