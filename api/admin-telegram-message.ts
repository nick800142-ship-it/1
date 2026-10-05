import type { IncomingMessage, ServerResponse } from "node:http";
import { sendUserTelegramNotification } from "./_telegram.js";
import { authenticateTelegramRequest, isTelegramAdmin, jsonResponse, readJsonBody } from "./_telegram-auth.js";

type TelegramMessageBody = {
  recipientId?: string;
  requestKey?: string;
  title?: string;
  body?: string;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "GET" && request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    return jsonResponse(response, 405, { error: "Method not allowed" });
  }
  const auth = await authenticateTelegramRequest(request);
  if (!auth) return jsonResponse(response, 401, { error: "登入狀態已失效，請重新登入。" });
  if (!isTelegramAdmin(auth.profile)) return jsonResponse(response, 403, { error: "僅限管理員使用。" });

  if (request.method === "GET") {
    const recipients: Array<{ id: string; telegramUsername: string | null; email: string; displayName: string | null; agencyRole: string }> = [];
    for (let offset = 0; ; offset += 1000) {
      const { data: links, error: linkError } = await auth.admin
        .from("telegram_user_links")
        .select("user_id,telegram_username")
        .order("user_id")
        .range(offset, offset + 999);
      if (linkError) return jsonResponse(response, 500, { error: "Telegram 收件人清單讀取失敗。" });
      const linkRows = links ?? [];
      if (linkRows.length) {
        const userIds = linkRows.map((link) => link.user_id as string);
        const { data: profiles, error: profileError } = await auth.admin
          .from("profiles")
          .select("id,email,nickname,display_name,agency_role")
          .in("id", userIds);
        if (profileError) return jsonResponse(response, 500, { error: "Telegram 收件人資料讀取失敗。" });
        const profileById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
        for (const link of linkRows) {
          const profile = profileById.get(link.user_id);
          if (!profile) continue;
          recipients.push({
            id: profile.id,
            telegramUsername: link.telegram_username,
            email: profile.email,
            displayName: profile.nickname || profile.display_name || null,
            agencyRole: profile.agency_role,
          });
        }
      }
      if (linkRows.length < 1000) break;
    }
    recipients.sort((left, right) => left.email.localeCompare(right.email));
    const { data: logs, error: logsError } = await auth.admin
      .from("telegram_delivery_logs")
      .select("id,target_user_id,title,body,status,error_message,sent_at,created_at")
      .eq("category", "admin_direct")
      .eq("sent_by", auth.user.id)
      .order("created_at", { ascending: false })
      .limit(30);
    if (logsError) return jsonResponse(response, 500, { error: "Telegram 發送紀錄讀取失敗。" });
    const profileById = new Map(recipients.map((recipient) => [recipient.id, recipient]));
    return jsonResponse(response, 200, {
      recipients,
      logs: (logs ?? []).map((log) => ({
        ...log,
        recipientLabel: log.target_user_id ? profileById.get(log.target_user_id)?.email ?? "已解除連結的用戶" : "已刪除帳號",
      })),
    });
  }

  let input: TelegramMessageBody;
  try {
    input = await readJsonBody(request, 8_192);
  } catch {
    return jsonResponse(response, 400, { error: "訊息內容格式錯誤。" });
  }
  const recipientId = input.recipientId?.trim() ?? "";
  const requestKey = input.requestKey?.trim() ?? "";
  const title = input.title?.trim() ?? "";
  const body = input.body?.trim() ?? "";
  if (!uuidPattern.test(recipientId) || !uuidPattern.test(requestKey) || !title || title.length > 120 || !body || body.length > 3_500) {
    return jsonResponse(response, 400, { error: "請選擇收件人，並填寫標題（最多 120 字）與內容（最多 3500 字）。" });
  }

  const result = await sendUserTelegramNotification(auth.admin, {
    userId: recipientId,
    category: "admin_direct",
    eventKey: `admin-direct:${auth.user.id}:${requestKey}`,
    sentBy: auth.user.id,
    title,
    body,
  });
  if (result.sent || result.duplicate) return jsonResponse(response, 200, result);
  if (result.skipped) return jsonResponse(response, 409, { ...result, error: "此用戶的 Telegram 尚未連結，請重新整理收件人清單。" });
  return jsonResponse(response, 502, { ...result, error: result.error ?? "Telegram 訊息發送失敗，請查看發送紀錄後再重試。" });
}

export const config = { maxDuration: 15 };
