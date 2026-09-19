// ADMIN 熱錢包是「單一 EOA」，鏈上每筆交易的 nonce 必須嚴格遞增且不可重複。
//
// 真正導致「mint-jc 失敗」的隱藏 bug 在這裡：Vercel serverless function 每次呼叫
// 都是獨立的執行環境，彼此完全沒有共享記憶體。當兩位使用者幾乎同時分別觸發
// 金庫買 JC / 認購 / 成交（甚至只是同一使用者連續點兩次、或使用者自己重試疊加
// 上背景自動補發），就會有兩個獨立的 Node process 同時呼叫
// `eth_getTransactionCount` 取得 nonce、幾乎同時送出交易——viem 內部沒有跨
// process 的鎖，兩邊很可能拿到「同一個」nonce，導致其中一筆在鏈上被拒絕
// （nonce too low / already known / replacement transaction underpriced），
// 使用者端就會看到「relayer mint-jc 失敗」，而且是間歇性、難以重現的失敗。
//
// 修法：用 Postgres 的 session 級 advisory lock 把「取得 nonce → 送出交易」這段
// 關鍵區間，在所有 serverless 執行環境之間強制序列化。之所以選 Postgres 而不是
// process 記憶體內的鎖，正是因為 Postgres 是這個系統裡唯一在多個 serverless
// 執行環境之間真正共享狀態的地方。拿到鎖之後只需要取 nonce、送出交易（不用等
// 上鏈確認），一送出就馬上釋放鎖——因為當一筆交易「送出」（進入 mempool）之後，
// blockTag "pending" 的下一次查詢就會正確反映遞增後的 nonce，不需要等它被
// 挖入區塊才能讓下一筆交易排上正確的 nonce。這讓交易仍可以並行等待收據確認，
// 只有「決定 nonce＋送出」這一小段真正需要序列化。
//
// 2026-09-19：架構簡化為單一 ADMIN_PRIVATE_KEY 熱錢包（取代先前的
// relayer(owner) + delegate 雙錢包分工），因此只需要一個 lock key。
import { Client } from "pg";

const ADMIN_LOCK_KEY = 913_224_501; // 任意固定整數，僅作為 advisory lock 的 key，與其他用途的 lock 區隔。

function connectionString(): string {
  const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!url) throw new Error("缺少 POSTGRES_URL_NON_POOLING / POSTGRES_URL，無法取得 nonce 鎖");
  return url;
}

async function withAdvisoryLock<T>(lockKey: number, fn: () => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  try {
    await client.query("BEGIN");
    // pg_advisory_xact_lock 會一直阻塞直到取得鎖為止；鎖的生命週期綁定這個
    // transaction，COMMIT/ROLLBACK 時自動釋放，不需要另外呼叫 unlock。
    await client.query("SELECT pg_advisory_xact_lock($1)", [lockKey]);
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * 取得全域 ADMIN 熱錢包 nonce 鎖（跨所有 serverless 執行環境），在鎖內執行
 * `fn`（通常是「查詢 pending nonce → 組好交易 → 呼叫
 * sendTransaction/writeContract 拿到 tx hash」），拿到結果後立刻釋放鎖再回傳——
 * 不在鎖內等待上鏈確認，確保單一交易的確認延遲不會拖住後面所有排隊中的其他
 * 使用者操作。
 */
export async function withAdminNonceLock<T>(fn: () => Promise<T>): Promise<T> {
  return withAdvisoryLock(ADMIN_LOCK_KEY, fn);
}
