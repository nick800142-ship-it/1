import { createHash } from "node:crypto";
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

function supportTelegramToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram customer-support bot is not configured");
  return token;
}

function opsTelegramToken() {
  const token = process.env.TELEGRAM_OPS_BOT_TOKEN;
  if (!token) throw new Error("Telegram operations bot is not configured");
  return token;
}

function telegramConfig() {
  const token = opsTelegramToken();
  const chatId = process.env.TELEGRAM_OPS_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error("Telegram operations group is not configured");
  return { token, chatId };
}

async function sendTelegramWithToken(
  token: string,
  chatId: string | number,
  text: string,
  options: { buttons?: TelegramButton[][]; parseMode?: "HTML" } = {},
) {
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
  const result = await response.json() as { ok?: boolean; description?: string };
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram send failed (${response.status})`);
  return result;
}

export async function sendTelegramChatMessage(
  chatId: string | number,
  text: string,
  options: { buttons?: TelegramButton[][]; parseMode?: "HTML" } = {},
) {
  return sendTelegramWithToken(supportTelegramToken(), chatId, text, options);
}

export async function sendTelegramOpsChatMessage(
  chatId: string | number,
  text: string,
  options: { buttons?: TelegramButton[][]; parseMode?: "HTML" } = {},
) {
  return sendTelegramWithToken(opsTelegramToken(), chatId, text, options);
}

export async function sendTelegramMessage(
  text: string,
  options: { buttons?: TelegramButton[][]; parseMode?: "HTML" } = {},
) {
  const { chatId } = telegramConfig();
  return sendTelegramOpsChatMessage(chatId, text, options);
}

export function isAuthorizedTelegramChat(value: unknown) {
  const configuredGroupId = String(process.env.TELEGRAM_OPS_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID ?? "");
  return Boolean(configuredGroupId) && configuredGroupId.startsWith("-") && String(value ?? "") === configuredGroupId;
}

function webhookSecret(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

export function telegramWebhookSecret() {
  return webhookSecret(supportTelegramToken());
}

export function opsTelegramWebhookSecret() {
  return webhookSecret(opsTelegramToken());
}

export type TelegramNotificationCategory = "market_alert" | "commission" | "order_partial_fill" | "order_completed" | "admin_direct";

type TelegramPreferenceRow = {
  market_alerts_enabled: boolean;
  commission_updates_enabled: boolean;
  order_partial_fills_enabled: boolean;
  order_completed_enabled: boolean;
};

const preferenceColumn: Partial<Record<TelegramNotificationCategory, keyof TelegramPreferenceRow>> = {
  market_alert: "market_alerts_enabled",
  commission: "commission_updates_enabled",
  order_partial_fill: "order_partial_fills_enabled",
  order_completed: "order_completed_enabled",
};

export async function sendUserTelegramNotification(
  admin: SupabaseClient,
  input: {
    userId: string;
    category: TelegramNotificationCategory;
    eventKey: string;
    title: string;
    body: string;
    sentBy?: string;
  },
) {
  const eventKey = `${input.eventKey}:${input.userId}`.slice(0, 240);
  let logId: string | null = null;
  const { data: inserted, error: insertError } = await admin
    .from("telegram_delivery_logs")
    .insert({
      event_key: eventKey,
      target_user_id: input.userId,
      sent_by: input.sentBy ?? null,
      category: input.category,
      title: input.title.slice(0, 160),
      body: input.body.slice(0, 3500),
      status: "pending",
    })
    .select("id")
    .maybeSingle();

  if (insertError?.code === "23505") {
    const { data: existing, error } = await admin
      .from("telegram_delivery_logs")
      .select("id,status")
      .eq("event_key", eventKey)
      .maybeSingle();
    if (error) throw error;
    const retryableStatuses = input.category === "admin_direct" ? ["failed", "skipped"] : ["failed"];
    if (!existing || !retryableStatuses.includes(existing.status)) return { sent: false, duplicate: true };
    const { data: claimed, error: claimError } = await admin
      .from("telegram_delivery_logs")
      .update({ status: "pending", error_message: null })
      .eq("id", existing.id)
      .in("status", retryableStatuses)
      .select("id")
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) return { sent: false, duplicate: true };
    logId = claimed.id;
  } else if (insertError || !inserted) {
    throw insertError ?? new Error("Telegram notification log was not created");
  } else {
    logId = inserted.id;
  }

  try {
    const { data: link, error: linkError } = await admin
      .from("telegram_user_links")
      .select("chat_id")
      .eq("user_id", input.userId)
      .maybeSingle();
    if (linkError) throw linkError;
    if (!link) {
      await admin.from("telegram_delivery_logs").update({ status: "skipped", error_message: "Telegram account is not linked" }).eq("id", logId);
      return { sent: false, skipped: true };
    }
    const preferenceKey = preferenceColumn[input.category];
    if (preferenceKey) {
      const { data: preferences, error } = await admin
        .from("telegram_notification_preferences")
        .select("market_alerts_enabled,commission_updates_enabled,order_partial_fills_enabled,order_completed_enabled")
        .eq("user_id", input.userId)
        .maybeSingle();
      if (error) throw error;
      if ((preferences as TelegramPreferenceRow | null)?.[preferenceKey] === false) {
        await admin.from("telegram_delivery_logs").update({ status: "skipped", error_message: "User opted out" }).eq("id", logId);
        return { sent: false, skipped: true };
      }
    }
    const message = input.category === "admin_direct"
      ? `${input.title}\n${input.body}`
      : `<b>${escapeHtml(input.title)}</b>\n${escapeHtml(input.body)}`;
    await sendTelegramChatMessage(link.chat_id, message, { parseMode: input.category === "admin_direct" ? undefined : "HTML" });
    await admin.from("telegram_delivery_logs").update({ status: "sent", sent_at: new Date().toISOString(), error_message: null }).eq("id", logId);
    return { sent: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Telegram delivery failed";
    await admin.from("telegram_delivery_logs").update({ status: "failed", error_message: message.slice(0, 500) }).eq("id", logId);
    await recordSystemError("telegram_user_notification", `${input.category}: ${message}`, { category: input.category })
      .catch((notificationError) => console.error("[telegram] User delivery error alert failed", notificationError instanceof Error ? notificationError.message : "unknown error"));
    return { sent: false, error: message };
  }
}

export async function notifyTelegramPreferenceGroup(
  admin: SupabaseClient,
  category: TelegramNotificationCategory,
  eventKey: string,
  title: string,
  body: string,
) {
  const linkedIds: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin
      .from("telegram_user_links")
      .select("user_id")
      .order("user_id")
      .range(offset, offset + 999);
    if (error) throw error;
    linkedIds.push(...(data ?? []).map((row) => row.user_id as string));
    if ((data ?? []).length < 1000) break;
  }

  const column = preferenceColumn[category];
  const optedOut = new Set<string>();
  if (column) {
    for (let offset = 0; offset < linkedIds.length; offset += 100) {
      const batch = linkedIds.slice(offset, offset + 100);
      const { data, error } = await admin
        .from("telegram_notification_preferences")
        .select("user_id")
        .in("user_id", batch)
        .eq(column, false);
      if (error) throw error;
      for (const row of data ?? []) optedOut.add(row.user_id as string);
    }
  }

  const recipients = [...new Set(linkedIds)].filter((userId) => !optedOut.has(userId));
  let sent = 0;
  for (let offset = 0; offset < recipients.length; offset += 20) {
    const batch = recipients.slice(offset, offset + 20);
    const results = await Promise.all(batch.map((userId) =>
      sendUserTelegramNotification(admin, { userId, category, eventKey, title, body }),
    ));
    sent += results.filter((result) => result.sent).length;
  }
  return { attempted: recipients.length, sent };
}

export function telegramPreferences(row?: Partial<TelegramPreferenceRow> | null) {
  return {
    market_alerts_enabled: row?.market_alerts_enabled ?? true,
    commission_updates_enabled: row?.commission_updates_enabled ?? true,
    order_partial_fills_enabled: row?.order_partial_fills_enabled ?? true,
    order_completed_enabled: row?.order_completed_enabled ?? true,
  };
}

export const telegramPreferenceKeys = {
  market_alert: "market_alerts_enabled",
  commission: "commission_updates_enabled",
  order_partial_fill: "order_partial_fills_enabled",
  order_completed: "order_completed_enabled",
} as const;

export const TELEGRAM_FAQ_KNOWLEDGE = `
RWMT 是實體資產（RWA，Real-World Assets）數位化與流動性賦能平台，提供資產資訊、認購及二級市場交易服務。RWA 是以數位方式呈現或連結實體資產權益的標的。各標的的權利、收益安排、交易條件與風險可能不同，請詳閱個別標的頁面及平台公告。

AE 是 RWMT 平台上的數位資產標的，平台以 JC 顯示價格及��購金額。AE 的發行排程、供應與時間基礎釋放規則，請以最新公告及 AE 標的頁面為準。

認購流程：登入或註冊 RWMT → 選擇可認購標的並閱讀資訊與風險 → 輸入份額、確認 JC 金額與交易內容 → 送出後查看認購及資產紀錄。認購相關鏈上操作所需 Gas 費由平台代付，用戶不需要自行準備或支付 Gas；仍請確認交易畫面列出的認購金額及其他適用費用。RWA 標的需先部署專屬鏈上代幣才能認購。

二級市場：賣方掛出賣單時收取一次性 1 JC 掛單費，取消不退；每筆成交另收該筆成交金額 1% 的 JC 成交手續費。例如成交 100 JC，該筆成交手續費為 1 JC。賣單分批成交時，成交費按各批金額計算，掛單費仍只收一次。買方不支付賣方掛單費。鏈上交易所需 Gas 費由平台代付。

RWA 與 AE 依各自規則於每年 12 月 31 日至隔年 1 月 1 日計算股利，計算結果以 AE 發放；資格、數量及時間依個別標的規則與公告為準，不保證收益。

代理分潤依推薦關係及目前後台費率計算：認購成立可能產生分潤；二級市場只對符合條件的賣出成交計算，買入不計。每層按適用規則分別計算，實際金額以正式分潤紀錄為準。用 /commission 查詢本人近 30 日分潤、/agent 進入代理專區、/estimate 試算、/downlines 查詢下級綁定；用 /settings 管理 Telegram 通知。

若資料未列明或涉及個人帳戶餘額、交易資格、法律／稅務意見，請勿猜測；請以 RWMT 平台紀錄或客服回覆為準。請勿在 Telegram 傳送密碼、私鑰或助記詞。
`.trim();

export async function getTelegramBotUsername() {
  const token = supportTelegramToken();
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const result = await response.json() as { ok?: boolean; result?: { username?: string }; description?: string };
  if (!response.ok || !result.ok || !result.result?.username) {
    throw new Error(result.description || "無法讀取 Telegram Bot 帳號");
  }
  return result.result.username;
}

export async function getTelegramWebhookInfo() {
  const token = supportTelegramToken();
  const response = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const result = await response.json() as { ok?: boolean; result?: { url?: string; pending_update_count?: number }; description?: string };
  if (!response.ok || !result.ok) throw new Error(result.description || "無法讀取 Telegram Webhook 狀態");
  return { url: result.result?.url ?? "", pendingUpdates: result.result?.pending_update_count ?? 0 };
}

export async function registerTelegramWebhook(url: string) {
  const token = supportTelegramToken();
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      secret_token: telegramWebhookSecret(),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    }),
  });
  const result = await response.json() as { ok?: boolean; description?: string };
  if (!response.ok || !result.ok) throw new Error(result.description || "Telegram Webhook 設定失敗");
  return { configured: true, url };
}

export async function registerOpsTelegramWebhook(url: string) {
  const token = opsTelegramToken();
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      secret_token: opsTelegramWebhookSecret(),
      allowed_updates: ["message"],
      drop_pending_updates: false,
    }),
  });
  const result = await response.json() as { ok?: boolean; description?: string };
  if (!response.ok || !result.ok) throw new Error(result.description || "營運 Telegram Webhook 設定失敗");
  return { configured: true, url };
}

export async function answerOpsCallbackQuery(callbackQueryId: string, text: string) {
  const token = opsTelegramToken();
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
  });
}

export async function answerCallbackQuery(callbackQueryId: string, text: string) {
  const token = supportTelegramToken();
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
  });
}

export async function recordSystemError(source: string, errorMessage: string, metadata: Record<string, unknown> = {}) {
  const safeSource = String(source || "unknown").slice(0, 80);
  const cleanMessage = String(errorMessage || "Unknown system error").slice(0, 1000);
  const bucket = new Date();
  bucket.setMinutes(Math.floor(bucket.getMinutes() / 5) * 5, 0, 0);
  const fingerprint = createHash("sha256").update(`${safeSource}:${cleanMessage}`).digest("hex").slice(0, 24);
  const eventKey = `error:${fingerprint}:${bucket.toISOString()}`;
  let admin: SupabaseClient | null = null;
  let eventId: string | null = null;
  let logFailure: string | null = null;

  try {
    admin = getAdminClient();
    const { data: inserted, error: insertError } = await admin.from("system_monitor_events").insert({
      event_type: "global_error",
      event_key: eventKey,
      severity: "critical",
      message: cleanMessage,
      metadata: { ...metadata, source: safeSource, notification_status: "pending" },
    }).select("id").maybeSingle();

    if (insertError?.code === "23505") {
      const { data: existing, error: lookupError } = await admin
        .from("system_monitor_events")
        .select("id,metadata")
        .eq("event_key", eventKey)
        .maybeSingle();
      if (lookupError) logFailure = lookupError.message;
      else if (existing && (existing.metadata as Record<string, unknown> | null)?.notification_status !== "failed") {
        return { duplicate: true };
      } else eventId = existing?.id ?? null;
    } else if (insertError) {
      logFailure = insertError.message;
    } else {
      eventId = inserted?.id ?? null;
    }
  } catch (databaseError) {
    logFailure = databaseError instanceof Error ? databaseError.message : String(databaseError);
  }

  try {
    const logFailureText = logFailure ? `\n監控資料庫寫入失敗：${logFailure.slice(0, 400)}` : "";
    await sendTelegramMessage(`系統錯誤通知\n來源：${safeSource}\n錯誤：${cleanMessage}${logFailureText}\n時間：${new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}`);
    if (admin && eventId) {
      await admin.from("system_monitor_events").update({
        metadata: { ...metadata, source: safeSource, notification_status: "sent" },
      }).eq("id", eventId);
    }
    return { duplicate: false, logged: !logFailure };
  } catch (notificationError) {
    if (admin && eventId) {
      await admin.from("system_monitor_events").update({
        metadata: { ...metadata, source: safeSource, notification_status: "failed" },
      }).eq("id", eventId);
    }
    throw notificationError;
  }
}

export async function performAutoRepair() {
  const admin = getAdminClient();
  const checks: Record<string, boolean> = {};
  const { error: databaseError } = await admin.from("system_monitor_state").select("key").limit(1);
  checks.database = !databaseError;
  checks.telegram = Boolean(
    process.env.TELEGRAM_OPS_BOT_TOKEN &&
      (process.env.TELEGRAM_OPS_CHAT_ID || process.env.TELEGRAM_CHAT_ID),
  );
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

