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
    if (!body.message?.trim()) return json(response, 400, { error: "Message required" });
    const result = await recordSystemError(body.source?.slice(0, 80) || "backend_api", body.message.trim(), {
      user_id: data.user.id,
      ...body.metadata,
    });
    return json(response, 200, result);
  } catch (reportError) {
    console.error("Backend error report failed", reportError instanceof Error ? reportError.message : "unknown error");
    return json(response, 500, { error: "Unable to report error" });
  }
}
