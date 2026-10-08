import type { IncomingMessage, ServerResponse } from "node:http";
import { escapeHtml, getAdminClient, notifyTelegramPreferenceGroup, recordSystemError, sendTelegramMessage } from "./_telegram.js";
import { isTelegramAdmin } from "./_telegram-auth.js";
import { recordUserTradeResult, sanitizeTradeFailureContext } from "./_tradeAlerts.js";

type MonitorBody =
  | { type: "global_error"; message?: string; source?: string; metadata?: Record<string, unknown> }
  | { type: "trade_result"; success?: boolean; message?: string; action?: string; assetId?: string; assetName?: string; quantity?: number; amount?: number }
  | { type: "private_sale_complete"; placementId?: string }
  | { type: "new_project"; placementId?: string }
  | { type: "agency_application"; applicationType?: string; name?: string; contact?: string; notes?: string };

function json(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

async function readBody(request: IncomingMessage) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 32_768) throw new Error("Payload too large");
  }
  return JSON.parse(raw || "{}") as MonitorBody;
}

async function authenticate(request: IncomingMessage) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const admin = getAdminClient();
  const { data, error } = await admin.auth.getUser(token);
  return error ? null : data.user;
}

async function handleTradeResult(userId: string, body: Extract<MonitorBody, { type: "trade_result" }>) {
  const admin = getAdminClient();
  const context = sanitizeTradeFailureContext(body as unknown as Record<string, unknown>);
  return recordUserTradeResult(admin, userId, body.success === true, context);
}

export async function handleAgentApplication(formData: { applicationType: string; name: string; contact: string; notes?: string }) {
  const message = [
    "🆕 <b>收到新代理申請：</b>",
    `<b>👤 申請類型：</b>${escapeHtml(formData.applicationType)}`,
    `<b>📝 申請人姓名：</b>${escapeHtml(formData.name)}`,
    `<b>📞 聯絡資訊：</b>${escapeHtml(formData.contact)}`,
    `<b>💬 備註說明：</b>${escapeHtml(formData.notes || "無")}`,
  ].join("\n");
  await sendTelegramMessage(message, { parseMode: "HTML" });
}

async function handlePrivateSaleComplete(placementId: string) {
  const admin = getAdminClient();
  const { data, error } = await admin.from("private_placements")
    .select("id,name,available,market_started_at")
    .eq("id", placementId)
    .single();
  if (error || !data) throw new Error("Private placement not found");
  if (Number(data.available) !== 0 || !data.market_started_at) return { completed: false };
  const eventKey = `private_sale_complete:${data.id}`;
  const { error: insertError } = await admin.from("system_monitor_events").insert({
    event_type: "private_sale_complete",
    event_key: eventKey,
    severity: "info",
    message: `${data.name} private sale completed`,
    metadata: { placement_id: data.id },
    status: "resolved",
    resolved_at: new Date().toISOString(),
  });
  if (insertError?.code === "23505") return { completed: true, duplicate: true };
  if (insertError) throw insertError;
  await sendTelegramMessage(`⚠️ ${data.name} 私募份額已完售，系統已自動進入二級市場。`);
  return { completed: true, duplicate: false };
}

async function handleNewProject(placementId: string, userId: string) {
  const admin = getAdminClient();
  const [{ data: profile, error: profileError }, { data: placement, error: placementError }] = await Promise.all([
    admin.from("profiles").select("agency_role,role").eq("id", userId).maybeSingle(),
    admin.from("private_placements")
      .select("id,name,price,is_active,is_delisted,ae_token_kind,is_ae_token")
      .eq("id", placementId)
      .maybeSingle(),
  ]);
  if (profileError) throw profileError;
  if (!isTelegramAdmin(profile)) return { forbidden: true };
  if (placementError) throw placementError;
  if (!placement) throw new Error("Private placement not found");
  if (!placement.is_active || placement.is_delisted) return { notified: false, skipped: "inactive" };
  if (placement.ae_token_kind === "bonus" || placement.id === "ae-token-bonus") {
    return { notified: false, skipped: "ae_reward" };
  }

  const result = await notifyTelegramPreferenceGroup(
    admin,
    "market_alert",
    `new_project:${placement.id}`,
    "新項目上架",
    `${placement.is_ae_token ? "AE" : placement.name} 已新增至認購項目，參考價格：${Number(placement.price).toLocaleString("zh-TW")} JC。請至 RWMT 平台查看項目詳情。`,
  );
  return { notified: true, ...result };
}

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "POST") return json(response, 405, { error: "Method not allowed" });
  const user = await authenticate(request);
  if (!user) return json(response, 401, { error: "Authentication required" });

  let body: MonitorBody;
  try { body = await readBody(request); } catch { return json(response, 400, { error: "Invalid request body" }); }

  try {
    if (body.type === "global_error") {
      if (!body.message?.trim()) return json(response, 400, { error: "Error message required" });
      return json(response, 200, await recordSystemError(body.source?.slice(0, 80) || "client", body.message.trim(), { user_id: user.id, ...body.metadata }));
    }
    if (body.type === "trade_result") return json(response, 200, await handleTradeResult(user.id, body));
    if (body.type === "private_sale_complete") {
      if (!body.placementId) return json(response, 400, { error: "Placement ID required" });
      return json(response, 200, await handlePrivateSaleComplete(body.placementId));
    }
    if (body.type === "new_project") {
      if (!body.placementId) return json(response, 400, { error: "Placement ID required" });
      const result = await handleNewProject(body.placementId, user.id);
      if ("forbidden" in result) return json(response, 403, { error: "Administrator access required" });
      return json(response, 200, result);
    }
    if (body.type === "agency_application") {
      const values = [body.applicationType, body.name, body.contact];
      if (values.some((value) => !value?.trim())) return json(response, 400, { error: "Application fields required" });
      await handleAgentApplication({ applicationType: body.applicationType!, name: body.name!, contact: body.contact!, notes: body.notes });
      return json(response, 200, { ok: true });
    }
    return json(response, 400, { error: "Unknown monitor event" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Telegram monitor failed", message);
    if (body.type !== "global_error") {
      await recordSystemError("telegram_monitor", message, { event_type: body.type })
        .catch((notificationError) => console.error("[telegram] Monitor error alert failed", notificationError instanceof Error ? notificationError.message : "unknown error"));
    }
    return json(response, 500, { error: "Monitor event failed" });
  }
}
