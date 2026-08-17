import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type TelegramButton = { text: string; callback_data: string };

export function getAdminClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Supabase server credentials are unavailable");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function telegramConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID ?? process.env.CHAT_ID;
  if (!token || !chatId) throw new Error("Telegram service is not configured");
  return { token, chatId };
}

export async function sendTelegramMessage(
  text: string,
  options: { buttons?: TelegramButton[][]; parseMode?: "HTML" } = {},
) {
  const { token, chatId } = telegramConfig();
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: options.parseMode,
      reply_markup: options.buttons ? { inline_keyboard: options.buttons } : undefined,
    }),
  });
  if (!response.ok) throw new Error(`Telegram send failed (${response.status})`);
  return response.json() as Promise<{ ok: boolean }>;
}

export async function answerCallbackQuery(callbackQueryId: string, text: string) {
  const { token } = telegramConfig();
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
  });
}

export async function recordSystemError(source: string, errorMessage: string, metadata: Record<string, unknown> = {}) {
  const admin = getAdminClient();
  const cleanMessage = errorMessage.slice(0, 1000);
  const bucket = new Date();
  bucket.setMinutes(Math.floor(bucket.getMinutes() / 5) * 5, 0, 0);
  const eventKey = `error:${source}:${cleanMessage.slice(0, 160)}:${bucket.toISOString()}`;
  const { error } = await admin.from("system_monitor_events").insert({
    event_type: "global_error",
    event_key: eventKey,
    severity: "critical",
    message: cleanMessage,
    metadata: { source, ...metadata },
  });
  if (error?.code === "23505") return { duplicate: true };
  if (error) throw error;
  await sendTelegramMessage(`🚨 系統發生故障：${cleanMessage}，是否立即啟動自動修復？`, {
    buttons: [[
      { text: "✅ 確認維修", callback_data: "repair_request" },
      { text: "❌ 暫不處理", callback_data: "repair_decline" },
    ]],
  });
  return { duplicate: false };
}

export async function performAutoRepair() {
  const admin = getAdminClient();
  const checks: Record<string, boolean> = {};
  const { error: databaseError } = await admin.from("system_monitor_state").select("key").limit(1);
  checks.database = !databaseError;
  checks.telegram = Boolean(process.env.TELEGRAM_BOT_TOKEN && (process.env.TELEGRAM_CHAT_ID ?? process.env.CHAT_ID));
  if (!checks.database || !checks.telegram) throw new Error("Health check failed; repair state was not reset");

  const now = new Date().toISOString();
  const { error: stateError } = await admin.from("system_monitor_state").upsert([
    { key: "trade_failures", value: { count: 0, alerted: false, repaired_at: now }, updated_at: now },
    { key: "repair_status", value: { status: "healthy", checks, repaired_at: now }, updated_at: now },
  ]);
  if (stateError) throw stateError;
  await admin.from("system_monitor_events").update({ status: "resolved", resolved_at: now }).eq("status", "open");
  return { healthy: true, checks, repairedAt: now };
}

export function isAuthorizedTelegramChat(value: unknown) {
  const configured = String(process.env.TELEGRAM_CHAT_ID ?? process.env.CHAT_ID ?? "");
  return Boolean(configured) && String(value ?? "") === configured;
}
