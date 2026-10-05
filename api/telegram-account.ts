import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticateTelegramRequest, jsonResponse, readJsonBody } from "./_telegram-auth.js";
import { getTelegramBotUsername } from "./_telegram.js";

const preferenceColumns = [
  "market_alerts_enabled",
  "commission_updates_enabled",
  "order_partial_fills_enabled",
  "order_completed_enabled",
] as const;

type PreferenceColumn = (typeof preferenceColumns)[number];
type AccountAction = "create_link" | "unlink" | "preferences";

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
    try {
      const botUsername = await getTelegramBotUsername();
      return jsonResponse(response, 200, {
        linkUrl: `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(token)}`,
        expiresAt,
      });
    } catch {
      return jsonResponse(response, 503, { error: "Telegram Bot 尚未完成設定，請稍後再試。" });
    }
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
