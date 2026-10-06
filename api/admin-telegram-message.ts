import type { IncomingMessage, ServerResponse } from "node:http";
import { sendUserTelegramNotification } from "./_telegram.js";
import { authenticateTelegramRequest, isTelegramAdmin, jsonResponse, readJsonBody } from "./_telegram-auth.js";
import supportQuestionAnalyticsHandler from "./_admin-support-question-analytics.js";

type TelegramMessageBody = {
  audience?: "all" | "master_agent" | "agent" | "individual";
  recipientId?: string;
  requestKey?: string;
  title?: string;
  body?: string;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isMasterAgentRole(role: string) {
  return role === "總代理" || role === "master_agent";
}

function isAgentRole(role: string) {
  return !isMasterAgentRole(role) && (role === "agent" || role.includes("代理"));
}

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  const mode = new URL(request.url ?? "/", "http://localhost").searchParams.get("mode");
  if (mode === "support-analytics") return supportQuestionAnalyticsHandler(request, response);

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
  const audience = input.audience;
  const recipientId = input.recipientId?.trim() ?? "";
  const requestKey = input.requestKey?.trim() ?? "";
  const title = input.title?.trim() ?? "";
  const body = input.body?.trim() ?? "";
  if (!audience || !["all", "master_agent", "agent", "individual"].includes(audience) ||
      (audience === "individual" && !uuidPattern.test(recipientId)) ||
      !uuidPattern.test(requestKey) || !title || title.length > 120 || !body || body.length > 3_500) {
    return jsonResponse(response, 400, { error: "請選擇有效的 Telegram 收件對象，並填寫標題（最多 120 字）與內容（最多 3500 字）。" });
  }

  const linkedIds: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data: links, error } = await auth.admin
      .from("telegram_user_links")
      .select("user_id")
      .order("user_id")
      .range(offset, offset + 999);
    if (error) return jsonResponse(response, 500, { error: "Telegram 收件名單讀取失敗，請稍後再試。" });
    linkedIds.push(...(links ?? []).map((link) => link.user_id as string));
    if ((links ?? []).length < 1000) break;
  }

  const uniqueLinkedIds = [...new Set(linkedIds)];
  let recipientIds: string[];
  if (audience === "individual") {
    if (!uniqueLinkedIds.includes(recipientId)) {
      return jsonResponse(response, 409, { error: "此用戶的 Telegram 尚未連結，請重新整理收件人清單。" });
    }
    recipientIds = [recipientId];
  } else if (audience === "all") {
    recipientIds = uniqueLinkedIds;
  } else {
    const roleById = new Map<string, string>();
    for (let offset = 0; offset < uniqueLinkedIds.length; offset += 100) {
      const batch = uniqueLinkedIds.slice(offset, offset + 100);
      const { data: profiles, error } = await auth.admin
        .from("profiles")
        .select("id,agency_role")
        .in("id", batch);
      if (error) return jsonResponse(response, 500, { error: "Telegram 身分名單讀取失敗，請稍後再試。" });
      for (const profile of profiles ?? []) roleById.set(profile.id, profile.agency_role ?? "");
    }
    recipientIds = uniqueLinkedIds.filter((id) => {
      const role = roleById.get(id) ?? "";
      return audience === "master_agent" ? isMasterAgentRole(role) : isAgentRole(role);
    });
  }

  if (recipientIds.length === 0) {
    return jsonResponse(response, 409, { error: "此收件對象目前沒有已連結 Telegram 的用戶。" });
  }

  const totals = { attempted: recipientIds.length, sent: 0, failed: 0, skipped: 0, duplicate: 0 };
  for (let offset = 0; offset < recipientIds.length; offset += 20) {
    const batch = recipientIds.slice(offset, offset + 20);
    const results = await Promise.allSettled(batch.map((userId) =>
      sendUserTelegramNotification(auth.admin, {
        userId,
        category: "admin_direct",
        eventKey: `admin-direct:${auth.user.id}:${requestKey}`,
        sentBy: auth.user.id,
        title,
        body,
      }),
    ));
    for (const outcome of results) {
      if (outcome.status === "rejected") {
        totals.failed += 1;
        continue;
      }
      const result = outcome.value;
      if (result.sent) totals.sent += 1;
      else if (result.skipped) totals.skipped += 1;
      else if (result.duplicate) totals.duplicate += 1;
      else totals.failed += 1;
    }
  }
  return jsonResponse(response, 200, totals);
}

export const config = { maxDuration: 60 };
