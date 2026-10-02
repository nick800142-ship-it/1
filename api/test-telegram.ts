import type { IncomingMessage, ServerResponse } from "node:http";
import { getAdminClient, sendTelegramMessage } from "./_telegram.js";

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

    await sendTelegramMessage("【測試】");
    return json(response, 200, { ok: true, message: "測試訊息已送至 Telegram 群組" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Telegram test failed";
    return json(response, 502, { error: message });
  }
}
