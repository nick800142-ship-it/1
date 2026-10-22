// 把測試網（來源）的用戶身分與推薦／代理關係搬到主網（目標）。
// 只搬身分資料；JC／AE／RWA 餘額、持倉、帳本、訂單都不搬（鏈上資產是各自獨立的）。
// 可重複執行：以 email 對應，已存在的主網帳號不會被覆蓋角色，只補空欄位。
//
// 試跑：  node scripts/mainnet/migrate-users.mjs
// 正式寫入：node scripts/mainnet/migrate-users.mjs --apply
//
// 必要環境變數：
//   SOURCE_DB_URL          測試網資料庫（POSTGRES_URL_NON_POOLING）
//   TARGET_DB_URL          主網資料庫（POSTGRES_URL_NON_POOLING）
//   TARGET_SUPABASE_URL / TARGET_SERVICE_ROLE_KEY   主網 Supabase（建立登入帳號用）
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const pg = require("pg");
const { createClient } = require("@supabase/supabase-js");

const APPLY = process.argv.includes("--apply");
const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`缺少環境變數 ${k}`);
  return v;
};
const client = (url) =>
  new pg.Client({ connectionString: url.replace(/[?&]sslmode=[^&]*/g, ""), ssl: { rejectUnauthorized: false } });

const src = client(need("SOURCE_DB_URL"));
const dst = client(need("TARGET_DB_URL"));
const supabase = createClient(need("TARGET_SUPABASE_URL"), need("TARGET_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const COLUMNS = `id, email, display_name, nickname, wallet_address, privy_id, agency_role, role,
  promo_code, special_promo_code, account_status, referrer_id, master_agent_id, parent_id,
  role_approved_at, created_at`;

await src.connect();
await dst.connect();

const source = (await src.query(`select ${COLUMNS} from public.profiles order by created_at`)).rows;
const target = (await dst.query(`select ${COLUMNS} from public.profiles`)).rows;
const targetByEmail = new Map(target.map((p) => [p.email.toLowerCase(), p]));
const targetIds = new Set(target.map((p) => p.id));
const usedPromo = new Map(target.filter((p) => p.promo_code).map((p) => [p.promo_code, p.id]));

const idMap = new Map();
const toCreate = [];
for (const p of source) {
  const existing = targetByEmail.get(p.email.toLowerCase());
  if (existing) {
    idMap.set(p.id, existing.id);
  } else {
    const id = targetIds.has(p.id) ? randomUUID() : p.id;
    idMap.set(p.id, id);
    toCreate.push({ ...p, newId: id });
  }
}

const report = { existing: [], created: [], conflicts: [], skipped: [] };
for (const p of source) {
  const existing = targetByEmail.get(p.email.toLowerCase());
  (existing ? report.existing : report.created).push(p.email);
}

const mapRel = (id) => (id ? (idMap.get(id) ?? null) : null);
const updates = [];
for (const p of source) {
  const targetId = idMap.get(p.id);
  const existing = targetByEmail.get(p.email.toLowerCase());
  const rel = {
    referrer_id: mapRel(p.referrer_id),
    master_agent_id: mapRel(p.master_agent_id),
    parent_id: mapRel(p.parent_id),
  };

  if (existing) {
    const patch = {};
    for (const k of ["wallet_address", "privy_id", "display_name", "nickname", "special_promo_code"]) {
      if (!existing[k] && p[k]) patch[k] = p[k];
    }
    for (const k of Object.keys(rel)) {
      if (existing[k] == null && rel[k]) patch[k] = rel[k];
      else if (existing[k] != null && rel[k] && existing[k] !== rel[k]) {
        report.conflicts.push(`${p.email}：${k} 主網已是 ${existing[k]}，測試網為 ${rel[k]}，保留主網`);
      }
    }
    if (existing.wallet_address && p.wallet_address && existing.wallet_address.toLowerCase() !== p.wallet_address.toLowerCase()) {
      report.conflicts.push(`${p.email}：錢包不同（主網 ${existing.wallet_address}／測試網 ${p.wallet_address}）`);
    }
    if (Object.keys(patch).length) updates.push({ id: targetId, email: p.email, patch });
    continue;
  }

  const patch = {
    display_name: p.display_name,
    nickname: p.nickname,
    wallet_address: p.wallet_address,
    privy_id: p.privy_id,
    agency_role: p.agency_role,
    role: p.role,
    special_promo_code: p.special_promo_code,
    account_status: p.account_status,
    role_approved_at: p.role_approved_at,
    created_at: p.created_at,
    ...rel,
  };
  if (p.promo_code) {
    const holder = usedPromo.get(p.promo_code);
    if (holder && holder !== targetId) {
      report.conflicts.push(`${p.email}：推薦碼 ${p.promo_code} 已被主網其他帳號使用，改由系統重新產生`);
    } else {
      patch.promo_code = p.promo_code;
      usedPromo.set(p.promo_code, targetId);
    }
  }
  updates.push({ id: targetId, email: p.email, patch });
}

console.log(`來源 ${source.length} 人，主網現有 ${target.length} 人`);
console.log(`已存在（只補空欄位）：${report.existing.length}  ${report.existing.join(", ")}`);
console.log(`將新建：${report.created.length}  ${report.created.join(", ")}`);
console.log(`將更新 ${updates.length} 筆個人資料`);
if (report.conflicts.length) console.log("需留意：\n  " + report.conflicts.join("\n  "));

if (!APPLY) {
  console.log("\n這是試跑，沒有寫入任何資料。確認無誤後加上 --apply 正式寫入。");
  await src.end();
  await dst.end();
  process.exit(0);
}

for (const u of toCreate) {
  const { data, error } = await supabase.auth.admin.createUser({
    id: u.newId,
    email: u.email,
    email_confirm: true,
  });
  if (error) throw new Error(`建立 ${u.email} 失敗：${error.message}`);
  if (data.user.id !== u.newId) throw new Error(`${u.email} 建立後的 id 與預期不同`);
}

await dst.query("begin");
try {
  // 先停用觸發器對關係欄位的檢查：以資料庫連線更新時 auth.uid() 為空，不會被擋
  for (const u of updates) {
    const keys = Object.keys(u.patch);
    if (!keys.length) continue;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    await dst.query(`update public.profiles set ${sets}, updated_at = now() where id = $1`, [u.id, ...keys.map((k) => u.patch[k])]);
  }
  await dst.query("commit");
} catch (e) {
  await dst.query("rollback");
  throw e;
}

const after = (await dst.query("select count(*) n, count(referrer_id) ref, count(master_agent_id) master, count(wallet_address) wallets from public.profiles")).rows[0];
console.log("\n已寫入。主網現況：", after);
await src.end();
await dst.end();
