// 全用戶 × 全模式 × 全情境的分潤驗證。整個測試在一個交易內執行，最後一律 rollback，不會改動任何實際資料。
// 用法：node --env-file-if-exists=/vercel/share/.env.project scripts/test-commission-matrix.mjs
import pg from "pg";

const url = (process.env.POSTGRES_URL_NON_POOLING || "").replace(/[?&]sslmode=[^&]*/, "");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const num = (v) => (v === null || v === undefined ? null : Number(v));
const parentOf = (profiles, id) => {
  const p = profiles.get(id);
  return p ? p.referrer_id ?? p.parent_id ?? null : null;
};
const levelOf = (profiles, id) => {
  let lvl = 0;
  let w = parentOf(profiles, id);
  while (w && lvl < 10) {
    lvl += 1;
    w = parentOf(profiles, w);
  }
  return lvl;
};

async function loadState() {
  const profiles = new Map((await c.query("select id,email,referrer_id,parent_id,promo_code,special_promo_code from public.profiles")).rows.map((p) => [p.id, p]));
  const settings = {};
  for (const s of (await c.query("select agency_role,asset_mode,private_rate,secondary_rate from public.commission_settings")).rows) {
    settings[`${s.agency_role}|${s.asset_mode}`] = { p: num(s.private_rate), s: num(s.secondary_rate) };
  }
  const overrides = new Map();
  for (const o of (await c.query("select * from public.commission_user_overrides")).rows) overrides.set(`${o.user_id}|${o.asset_mode}`, o);
  return { profiles, settings, overrides };
}

function expectedRate(state, kind, slot, beneficiary, mode) {
  if (kind === "secondary" && slot === "self") return 0;
  const o = state.overrides.get(`${beneficiary}|${mode}`);
  const col = { "private:self": "self_private_rate", "private:l1": "l1_private_rate", "private:l2": "l2_private_rate", "secondary:l1": "l1_secondary_rate", "secondary:l2": "l2_secondary_rate" }[`${kind}:${slot}`];
  if (o && o[col] !== null && o[col] !== undefined) return Number(o[col]);
  const lvl = levelOf(state.profiles, beneficiary);
  const role = kind === "private" && slot === "self" ? "總代理直屬" : kind === "private" && slot === "l1" && lvl === 0 ? "總代理直屬" : slot === "l1" ? "總代理" : "代理";
  const s = state.settings[`${role}|${mode}`];
  return s ? (kind === "private" ? s.p : s.s) ?? 0 : 0;
}

async function selfUnlocked(state, buyer) {
  const b = state.profiles.get(buyer);
  const code = String(b.special_promo_code ?? b.promo_code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code === "RWMT88888") return true;
  const kids = [...state.profiles.values()].filter((p) => (p.referrer_id ?? p.parent_id) === buyer).map((p) => p.id);
  const grandkids = [...state.profiles.values()].filter((p) => kids.includes(p.referrer_id ?? p.parent_id)).map((p) => p.id);
  const ids = [...kids, ...grandkids];
  if (!ids.length) return false;
  const r = await c.query("select 1 from public.jc_ledger where user_id = any($1::uuid[]) and entry_type='private_purchase' and amount<0 limit 1", [ids]);
  return r.rowCount > 0;
}

let failures = 0;
let checks = 0;
let seq = 0;
const fail = (msg) => {
  failures += 1;
  console.log("  FAIL:", msg);
};

async function runScenario(label, state, placements) {
  console.log(`\n== ${label}`);
  for (const [mode, assetId] of Object.entries(placements)) {
    for (const kind of ["private", "secondary"]) {
      for (const buyer of state.profiles.keys()) {
        seq += 1;
        const gross = 1000 + seq;
        const entry = kind === "private" ? "private_purchase" : "p2p_sell";
        const amount = kind === "private" ? -gross : gross;
        const key = `matrix-${Date.now()}-${seq}`;
        const unlocked = kind === "private" ? await selfUnlocked(state, buyer) : false;
        const ins = await c.query(
          "insert into public.jc_ledger(user_id,entry_type,amount,asset_id,idempotency_key,metadata) values($1,$2,$3,$4,$5,'{}'::jsonb) returning id",
          [buyer, entry, amount, assetId, key],
        );
        const srcId = ins.rows[0].id;
        await c.query("select private.post_referral_commissions($1,$2,$3,$4,$5,$6)", [buyer, assetId, kind, gross, srcId, key + ":c"]);
        const logs = (await c.query("select bonus_type,beneficiary_id,commission_rate,commission_amount from public.commission_logs where source_ledger_id=$1", [srcId])).rows;
        const got = new Map(logs.map((l) => [l.bonus_type, l]));
        const expected = [];
        if (kind === "private" && unlocked) expected.push(["self_rebate", buyer, expectedRate(state, kind, "self", buyer, mode)]);
        const p1 = parentOf(state.profiles, buyer);
        if (p1) expected.push(["l1", p1, expectedRate(state, kind, "l1", p1, mode)]);
        const p2 = p1 ? parentOf(state.profiles, p1) : null;
        if (p2) expected.push(["l2", p2, expectedRate(state, kind, "l2", p2, mode)]);
        const email = state.profiles.get(buyer).email;
        for (const [bonus, ben, rate] of expected) {
          checks += 1;
          const amt = Math.round(gross * rate * 1e6) / 1e6;
          const row = got.get(bonus);
          if (amt <= 0) {
            if (row) fail(`${email} ${mode}/${kind} ${bonus}: 費率 0 不應產生分潤，實際 ${row.commission_amount}`);
          } else if (!row) fail(`${email} ${mode}/${kind} ${bonus}: 缺少分潤，應為 ${amt}`);
          else if (row.beneficiary_id !== ben) fail(`${email} ${mode}/${kind} ${bonus}: 受益人錯誤`);
          else if (Math.abs(Number(row.commission_amount) - amt) > 0.000002) fail(`${email} ${mode}/${kind} ${bonus}: 金額 ${row.commission_amount} ≠ 後台計算 ${amt}`);
        }
        const allowed = new Set(expected.map((e) => e[0]));
        for (const l of logs) {
          checks += 1;
          if (!allowed.has(l.bonus_type)) fail(`${email} ${mode}/${kind}: 多出不該有的 ${l.bonus_type}`);
        }
      }
    }
  }
}

try {
  await c.connect();
  await c.query("begin");
  await c.query("alter table public.jc_ledger disable trigger jc_ledger_guard_settlement_reservations");
  const pl = (await c.query("select id,is_ae_token from public.private_placements order by created_at desc nulls last")).rows;
  const placements = {};
  const ae = pl.find((p) => p.is_ae_token);
  const rwa = pl.find((p) => !p.is_ae_token);
  if (ae) placements.ae_coin = ae.id;
  if (rwa) placements.rwa = rwa.id;
  console.log("placements:", placements);

  let state = await loadState();
  console.log("users:", state.profiles.size, "settings:", JSON.stringify(state.settings));
  await runScenario("A. 目前後台設定（全用戶）", state, placements);

  // B. 後台改費率後，所有路徑必須立刻跟著變
  await c.query("update public.commission_settings set private_rate=0.037, secondary_rate=0.0021 where agency_role='總代理直屬'");
  await c.query("update public.commission_settings set private_rate=0.0213, secondary_rate=0.0017 where agency_role='總代理'");
  await c.query("update public.commission_settings set private_rate=0.0111, secondary_rate=0.0009 where agency_role='代理'");
  state = await loadState();
  await runScenario("B. 後台改費率後（全用戶）", state, placements);

  // C. 個人覆蓋：每個總代理/代理都設不同值
  let i = 0;
  for (const p of state.profiles.values()) {
    i += 1;
    for (const mode of Object.keys(placements)) {
      await c.query(
        `insert into public.commission_user_overrides(user_id,asset_mode,self_private_rate,l1_private_rate,l2_private_rate,self_secondary_rate,l1_secondary_rate,l2_secondary_rate)
         values($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict(user_id,asset_mode) do update set self_private_rate=excluded.self_private_rate,l1_private_rate=excluded.l1_private_rate,l2_private_rate=excluded.l2_private_rate,self_secondary_rate=excluded.self_secondary_rate,l1_secondary_rate=excluded.l1_secondary_rate,l2_secondary_rate=excluded.l2_secondary_rate`,
        [p.id, mode, 0.01 * (i % 5), i % 3 === 0 ? null : 0.005 * (i % 7), i % 4 === 0 ? null : 0.0025 * (i % 4), 0, i % 2 === 0 ? null : 0.0004 * (i % 6), 0.0002 * (i % 5)],
      );
    }
  }
  state = await loadState();
  await runScenario("C. 全員個別覆蓋（全用戶）", state, placements);

  // D. 新加入用戶：在交易內建立 L0->L1->L2->L3 的新鏈（含新用戶），驗證任何新增用戶都走同一套
  const roots = [...state.profiles.values()].filter((p) => !p.referrer_id && !p.parent_id);
  if (roots.length) {
    let parent = roots[0].id;
    const created = [];
    for (let n = 0; n < 3; n += 1) {
      const id = (await c.query("select gen_random_uuid() id")).rows[0].id;
      await c.query("insert into auth.users(id,email,aud,role,instance_id,created_at,updated_at) values($1,$2,'authenticated','authenticated','00000000-0000-0000-0000-000000000000',now(),now())", [id, `matrix-new-${n}@example.test`]);
      await c.query("insert into public.profiles(id,email,referrer_id,parent_id) values($1,$2,$3,$3) on conflict(id) do update set referrer_id=excluded.referrer_id,parent_id=excluded.parent_id", [id, `matrix-new-${n}@example.test`, parent]);
      created.push(id);
      parent = id;
    }
    state = await loadState();
    await runScenario("D. 新加入用戶（含 L3 深鏈，覆蓋保留）", state, placements);
  }

  // E. 守門觸發器：任何手動寫入錯誤費率都必須被拒絕
  const anyLog = (await c.query("select * from public.commission_logs limit 1")).rows[0];
  if (anyLog) {
    await c.query("savepoint guard_test");
    try {
      const src = (await c.query("select id from public.jc_ledger where entry_type='private_purchase' and amount<0 limit 1")).rows[0].id;
      await c.query(
        "insert into public.jc_ledger(user_id,entry_type,amount,idempotency_key,metadata) values($1,'commission_pending',999,$2,'{}'::jsonb)",
        [anyLog.beneficiary_id, `guard-${Date.now()}`],
      );
      const led = (await c.query("select id from public.jc_ledger where idempotency_key like 'guard-%' order by created_at desc limit 1")).rows[0].id;
      await c.query(
        `insert into public.commission_logs(agent_id,buyer_id,asset_id,transaction_type,transaction_amount,commission_rate,commission_amount,ledger_id,bonus_type,beneficiary_id,source_agent_id,source_user_id,source_ledger_id,base_rate,boost_rate,effective_rate,calculation_month,display_currency)
         values($1,$2,$3,'private',1000,0.5,500,$4,'personal',$1,$1,$2,$5,0.5,0,0.5,date_trunc('month',now())::date,'jc')`,
        [anyLog.beneficiary_id, anyLog.buyer_id, anyLog.asset_id, led, src],
      );
      fail("守門觸發器沒有擋下寫死費率的 personal 分潤");
    } catch (e) {
      console.log("\n== E. 守門觸發器擋下手動寫入的錯誤費率 OK：", e.message);
    }
    await c.query("rollback to savepoint guard_test");
  }
} catch (e) {
  failures += 1;
  console.log("ERROR", e.message);
} finally {
  await c.query("rollback").catch(() => {});
  await c.end().catch(() => {});
}
console.log(`\n檢查 ${checks} 項，失敗 ${failures} 項（已 rollback，資料庫未被改動）`);
process.exit(failures ? 1 : 0);
