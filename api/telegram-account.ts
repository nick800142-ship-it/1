import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticateTelegramRequest, jsonResponse, readJsonBody } from "./_telegram-auth.js";
import { getTelegramBotUsername, registerTelegramWebhook } from "./_telegram.js";

const preferenceColumns = [
  "market_alerts_enabled",
  "commission_updates_enabled",
  "order_partial_fills_enabled",
  "order_completed_enabled",
] as const;

type PreferenceColumn = (typeof preferenceColumns)[number];
type AccountAction = "create_link" | "unlink" | "preferences";

function productionTelegramWebhookUrl(request: IncomingMessage) {
  if (process.env.VERCEL_ENV !== "production") {
    throw new Error("請從正式網站重新建立 Telegram 綁定連結。預覽站不能設定正式 Bot webhook。");
  }

  const configuredHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const requestHost = Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host;
  const candidate = (configuredHost || requestHost || "").trim().toLowerCase();
  const hostname = candidate.replace(/:\d+$/, "");

  if (!/^[a-z0-9.-]+$/.test(hostname)) {
    throw new Error("無法確認正式網站網域，請稍後重試。");
  }
  if (!configuredHost && hostname !== "rwmt.link" && hostname !== "www.rwmt.link") {
    throw new Error("正式網站網域尚未設定，請聯絡管理員。");
  }

  return `https://${hostname}/api/telegram-callback`;
}

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "GET" && request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    return jsonResponse(response, 405, { error: "Method not allowed" });
  }
  const auth = await authenticateTelegramRequest(request);
  if (!auth) return jsonResponse(response, 401, { error: "登入狀態已失效，請重新登入。" });

  if (request.method === "GET") {
    const [{ data: link, error: linkError }, { data: current, error: preferenceError }] = await Promise.all([
      auth.admin.from("telegram_user_links").select("telegram_username,linked_at").eq("user_id", auth.user.id).maybeSingle(),
      auth.admin.from("telegram_notification_preferences").select("market_alerts_enabled,commission_updates_enabled,order_partial_fills_enabled,order_completed_enabled").eq("user_id", auth.user.id).maybeSingle(),
    ]);
    if (linkError || preferenceError) return jsonResponse(response, 500, { error: "Telegram 設定讀取失敗。" });
    const botUsername = await getTelegramBotUsername().catch(() => null);
    return jsonResponse(response, 200, {
      linked: Boolean(link),
      telegramUsername: link?.telegram_username ?? null,
      linkedAt: link?.linked_at ?? null,
      botUsername,
      preferences: {
        market_alerts_enabled: current?.market_alerts_enabled ?? true,
        commission_updates_enabled: current?.commission_updates_enabled ?? true,
        order_partial_fills_enabled: current?.order_partial_fills_enabled ?? true,
        order_completed_enabled: current?.order_completed_enabled ?? true,
      },
    });
  }

  let body: { action?: AccountAction; preferences?: Partial<Record<PreferenceColumn, unknown>> };
  try {
    body = await readJsonBody(request);
  } catch {
    return jsonResponse(response, 400, { error: "Invalid JSON" });
  }

  if (body.action === "create_link") {
    let botUsername: string;
    try {
      botUsername = await getTelegramBotUsername();
      const webhookUrl = productionTelegramWebhookUrl(request);
      await registerTelegramWebhook(webhookUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Telegram webhook 設定失敗。";
      return jsonResponse(response, 503, { error: `Telegram 綁定初始化失敗：${message}` });
    }

    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const { error: invalidateError } = await auth.admin
      .from("telegram_link_tokens")
      .update({ used_at: now })
      .eq("user_id", auth.user.id)
      .is("used_at", null)
      .gt("expires_at", now);
    if (invalidateError) return jsonResponse(response, 500, { error: "無法建立 Telegram 連結，請稍後再試。" });
    const { error } = await auth.admin.from("telegram_link_tokens").insert({
      token_hash: tokenHash,
      user_id: auth.user.id,
      expires_at: expiresAt,
    });
    if (error) return jsonResponse(response, 500, { error: "無法建立 Telegram 連結，請稍後再試。" });
    return jsonResponse(response, 200, {
      linkUrl: `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(token)}`,
      expiresAt,
    });
  }

  if (body.action === "unlink") {
    const { error } = await auth.admin.from("telegram_user_links").delete().eq("user_id", auth.user.id);
    if (error) return jsonResponse(response, 500, { error: "解除 Telegram 連結失敗。" });
    return jsonResponse(response, 200, { linked: false });
  }

  if (body.action === "preferences") {
    const supplied = body.preferences;
    if (!supplied || Object.keys(supplied).some((key) => !preferenceColumns.includes(key as PreferenceColumn)) ||
      Object.values(supplied).some((value) => typeof value !== "boolean") || Object.keys(supplied).length === 0) {
      return jsonResponse(response, 400, { error: "通知設定內容無效。" });
    }
    const { error } = await auth.admin.from("telegram_notification_preferences").upsert({
      user_id: auth.user.id,
      ...supplied,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (error) return jsonResponse(response, 500, { error: "Telegram 通知偏好儲存失敗。" });
    return jsonResponse(response, 200, { saved: true });
  }

  return jsonResponse(response, 400, { error: "Invalid Telegram account action" });
}

export const config = { maxDuration: 15 };
