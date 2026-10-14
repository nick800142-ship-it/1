// One-off runner: really pays (on-chain, via ADMIN wallet) every pending commission
// of the given beneficiary emails, using the same production code path as the cron sweep.
// Usage: node --env-file=/vercel/share/.env.project --import tsx scripts/sweep-beneficiaries.mts a@x.com b@y.com
import { createClient } from "@supabase/supabase-js";
import { sweepPendingCommissions } from "../api/relayer";

async function main() {
  const emails = process.argv.slice(2).map((e) => e.toLowerCase());
  if (emails.length === 0) throw new Error("請提供至少一個 email");

  const admin = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data: profiles, error } = await admin
    .from("profiles")
    .select("id,email")
    .in("email", emails);
  if (error) throw new Error(error.message);
  const ids = (profiles ?? []).map((p) => p.id as string);
  console.log("beneficiaries:", profiles);

  for (let round = 1; round <= 10; round += 1) {
    const result = await sweepPendingCommissions(admin, 25, ids);
    console.log(`round ${round}:`, JSON.stringify(result));
    if (result.scanned === 0 || result.settled === 0) break;
  }
}

main()
  .then(() => {
    console.log("DONE");
    process.exit(0);
  })
  .catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
