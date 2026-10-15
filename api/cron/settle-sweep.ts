// 系統自動補發卡單的入口：由 vercel.json 設定的 Vercel Cron 定期呼叫（不需要
// 任何使用者/管理員手動點擊）。
//
// 為什麼需要這支獨立於 relayer.ts 之外的排程：即使 _relayerLock.ts 已經修掉
// 「同時兩筆交易搶同一個 nonce」這個真正造成 mint-jc 間歇性失敗的根因，仍然
// 有少數情境無法單靠修正 relayer 本身解決——例如使用者站內扣款成功那一刻，
// 瀏覽器分頁被關掉、手機切到背景、或網路在呼叫 /api/relayer 的 fetch 途中斷線
// ——這些情況下「發起補發」這個動作本身就沒有機會被送出。這支排程會定期主動
// 掃描 onchain_settlements + jc_ledger，找出這類卡單並自動重試，讓使用者完全
// 不需要知道、也不需要手動按任何補發按鈕。
import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { sweepStuckSettlements, sweepPendingCommissions, sweepPendingSettlementReservations } from "../relayer";
import { monitorHotWalletInventory } from "../_hot-wallet-monitor.js";
import { recordSystemError } from "../_telegram.js";

async function json(response: ServerResponse, status: number, payload: unknown) {
  if (status >= 500) {
    const body = payload && typeof payload === "object" ? payload as { error?: unknown } : {};
    await recordSystemError("cron_settle_sweep", String(body.error ?? `HTTP ${status}`), { status })
      .catch((error) => console.error("[telegram] Cron error alert failed", error instanceof Error ? error.message : "unknown error"));
  }
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  // This endpoint can spend gas and must never be publicly callable without a secret.
  const configuredSecret = process.env.CRON_SECRET;
  if (!configuredSecret) {
    return json(response, 503, { error: "CRON_SECRET 尚未設定" });
  }
  const authHeader = request.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (token !== configuredSecret) {
    return json(response, 401, { error: "Unauthorized" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceKey) {
    return json(response, 503, { error: "尚未設定 Supabase 連線" });
  }
  if (!process.env.ADMIN_PRIVATE_KEY) {
    return json(response, 503, { error: "尚未設定 ADMIN_PRIVATE_KEY（後端熱錢包私鑰）" });
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const result = await sweepStuckSettlements(admin);
    const reservations = await sweepPendingSettlementReservations(admin, 100);
    // 同一輪順帶把待派發的推廣分潤（commission_logs.paid_at 為 null）實際上鏈發放。
    const commissions = await sweepPendingCommissions(admin, 100);
    const inventory = await monitorHotWalletInventory(admin);
    return json(response, 200, { ...result, reservations, commissions, inventory });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json(response, 500, { error: message });
  }
}
