// One-off runner: executes the SAME production settlement code against the live
// chain + DB, so stuck settlements and pending commissions are really settled
// on-chain right now (real ERC-20 transfers via ADMIN wallet), not ledger edits.
// Usage: node --env-file=/vercel/share/.env.project --import tsx scripts/run-sweep-now.mts
import { createClient } from "@supabase/supabase-js";
import { sweepStuckSettlements, sweepPendingCommissions } from "../api/relayer";

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL!;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY!;
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log("=== sweepStuckSettlements (no limit = all) ===");
  const stuck = await sweepStuckSettlements(admin);
  console.log(JSON.stringify(stuck, null, 2));

  console.log("=== sweepPendingCommissions (200) ===");
  const comm = await sweepPendingCommissions(admin, 200);
  console.log(JSON.stringify(comm, null, 2));
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
