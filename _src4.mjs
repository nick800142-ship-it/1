import { Client } from "pg";
let url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
try { const p=new URL(url); p.searchParams.delete("sslmode"); url=p.toString(); } catch {}
const c = new Client({ connectionString: url, ssl:{rejectUnauthorized:false} });
await c.connect();
const r = await c.query(`select pg_get_functiondef(oid) as src from pg_proc where proname = 'create_p2p_order'`);
console.log(r.rows[0].src);
await c.end();
