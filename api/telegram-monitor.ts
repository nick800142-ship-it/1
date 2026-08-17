import type { IncomingMessage, ServerResponse } from "node:http";
import { escapeHtml, getAdminClient, recordSystemError, sendTelegramMessage } from "./_telegram.js";

type MonitorBody =
  | { type: "global_error"; message?: string; source?: string; metadata?: Record<string, unknown> }
  | { type: "trade_result"; success?: boolean; message?: string }
  | { type: "private_sale_complete"; placementId?: string }
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

async function handleTradeResult(success: boolean, message?: string) {
  const admin = getAdminClient();
  if (success) {
    const { data } = await admin.from("system_monitor_state").select("value").eq("key", "trade_failures").maybeSingle();
    const previous = Number((data?.value as { count?: number } | null)?.count ?? 0);
    if (previous > 0) {
      await admin.from("system_monitor_state").upsert({ key: "trade_failures", value: { count: 0, alerted: false }, updated_at: new Date().toISOString() });
    }
    return { count: 0, alerted: false };
  }
  const { data } = await admin.from("system_monitor_state").select("value").eq("key", "trade_failures").maybeSingle();
  const previous = Number((data?.value as { count?: number } | null)?.count ?? 0);
  const count = previous + 1;
  const shouldAlert = count >= 4;
  await admin.from("system_monitor_state").upsert({
    key: "trade_failures",
    value: { count, alerted: shouldAlert, last_error: message?.slice(0, 500), updated_at: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  });
  if (count === 4) await sendTelegramMessage("📉 注意：偵測到連續交易失敗，請檢查系統穩定性。");
  return { count, alerted: shouldAlert };
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
    if (body.type === "trade_result") return json(response, 200, await handleTradeResult(body.success === true, body.message));
    if (body.type === "private_sale_complete") {
      if (!body.placementId) return json(response, 400, { error: "Placement ID required" });
      return json(response, 200, await handlePrivateSaleComplete(body.placementId));
    }
    if (body.type === "agency_application") {
      const values = [body.applicationType, body.name, body.contact];
      if (values.some((value) => !value?.trim())) return json(response, 400, { error: "Application fields required" });
      await handleAgentApplication({ applicationType: body.applicationType!, name: body.name!, contact: body.contact!, notes: body.notes });
      return json(response, 200, { ok: true });
    }
    return json(response, 400, { error: "Unknown monitor event" });
  } catch (error) {
    console.error("Telegram monitor failed", error instanceof Error ? error.message : "unknown error");
    return json(response, 500, { error: "Monitor event failed" });
  }
}
