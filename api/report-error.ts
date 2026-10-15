import type { IncomingMessage, ServerResponse } from "node:http";
import { getAdminClient, recordSystemError } from "./_telegram.js";

function json(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

async function readBody(request: IncomingMessage) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 16_384) throw new Error("Payload too large");
  }
  return JSON.parse(raw || "{}") as { source?: string; message?: string; metadata?: Record<string, unknown> };
}

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "POST") return json(response, 405, { error: "Method not allowed" });
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return json(response, 401, { error: "Authentication required" });
  const admin = getAdminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return json(response, 401, { error: "Invalid session" });

  try {
    const body = await readBody(request);
    const message = body.message?.trim().slice(0, 2000);
    if (!message) return json(response, 400, { error: "Message required" });
    const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : {};
    const safeMetadata = Object.fromEntries(
      Object.entries(metadata)
        .filter(([key, value]) => key !== "user_id" && key !== "email" && key !== "role" && typeof value !== "function")
        .slice(0, 20)
        .map(([key, value]) => [key.slice(0, 64), typeof value === "string" ? value.slice(0, 500) : value]),
    );
    const source = typeof body.source === "string" ? body.source.trim().slice(0, 80) : "backend_api";
    const result = await recordSystemError(source || "backend_api", message, {
      ...safeMetadata,
      user_id: data.user.id,
    });
    return json(response, 200, result);
  } catch (reportError) {
    const message = reportError instanceof Error ? reportError.message : String(reportError);
    console.error("Backend error report failed", message);
    await recordSystemError("api/report_error", message).catch((notificationError) => {
      console.error("[telegram] Error-report failure alert failed", notificationError instanceof Error ? notificationError.message : "unknown error");
    });
    return json(response, 500, { error: "Unable to report error" });
  }
}
