import type { IncomingMessage, ServerResponse } from "node:http";
import { getAdminClient, registerOpsTelegramWebhook, sendTelegramMessage } from "./_telegram.js";

function productionOpsWebhookUrl(request: IncomingMessage) {
  if (process.env.VERCEL_ENV !== "production") {
    throw new Error("請從正式網站設定營運 Telegram Bot；預覽站不能設定正式 Webhook。");
  }
  const configuredHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const requestHost = Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host;
  const hostname = (configuredHost || requestHost || "").trim().toLowerCase().replace(/:\d+$/, "");
  if (!/^[a-z0-9.-]+$/.test(hostname)) throw new Error("無法確認正式網站網域。");
  if (!configuredHost && hostname !== "rwmt.link" && hostname !== "www.rwmt.link") {
    throw new Error("正式網站網域尚未設定。");
  }
  return `https://${hostname}/api/telegram-ops-callback`;
}

function json(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return json(response, 405, { error: "Method not allowed" });
  }

  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return json(response, 401, { error: "Authentication required" });

  try {
    const admin = getAdminClient();
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    if (authError || !authData.user) return json(response, 401, { error: "Invalid session" });

    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("agency_role,role")
      .eq("id", authData.user.id)
      .single();
    if (
      profileError ||
      (!["admin", "super_admin", "管理員"].includes(profile?.agency_role ?? "") &&
        !["admin", "super_admin"].includes(profile?.role ?? ""))
    ) {
      return json(response, 403, { error: "Admin access required" });
    }

    await registerOpsTelegramWebhook(productionOpsWebhookUrl(request));
    await sendTelegramMessage("【營運機器人測試】Webhook 已設定，群組播報與平台查詢已啟用。輸入 /help 查看指令。");
    return json(response, 200, { ok: true, message: "測試訊息已送至 Telegram 群組" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Telegram test failed";
    return json(response, 502, { error: message });
  }
}
