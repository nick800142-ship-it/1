import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  getAdminClient,
  isAuthorizedTelegramChat,
  opsTelegramWebhookSecret,
  sendTelegramOpsChatMessage,
} from "./_telegram.js";

type TelegramUpdate = {
  update_id?: number;
  message?: {
    chat?: { id?: string | number; type?: string };
    from?: { id?: number };
    text?: string;
  };
};

function json(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

async function readBody(request: IncomingMessage) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 16_384) throw new Error("Payload too large");
  }
  return JSON.parse(raw || "{}") as TelegramUpdate;
}

function validWebhookSecret(value: string | string[] | undefined) {
  const expected = Buffer.from(opsTelegramWebhookSecret());
  const received = Buffer.from(Array.isArray(value) ? value[0] ?? "" : value ?? "");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function formatNumber(value: number) {
  return value.toLocaleString("zh-TW", { maximumFractionDigits: 2 });
}

async function countRows(query: PromiseLike<{ count: number | null; error: { message: string } | null }>) {
  const result = await query;
  if (result.error) throw new Error(result.error.message);
  return result.count ?? 0;
}

async function queryUsers(admin: ReturnType<typeof getAdminClient>) {
  const [users, linked] = await Promise.all([
    countRows(admin.from("profiles").select("id", { count: "exact", head: true })),
    countRows(admin.from("telegram_user_links").select("user_id", { count: "exact", head: true })),
  ]);
  return `平台會員\n會員總數：${formatNumber(users)}\n已連結客服 Telegram：${formatNumber(linked)}`;
}

async function queryPlacements(admin: ReturnType<typeof getAdminClient>, search = "", isAeToken: boolean | null = null) {
  let request = admin
    .from("private_placements")
    .select("name,price,available,is_active,is_delisted,is_ae_token")
    .order("name", { ascending: true })
    .limit(25);
  const cleanSearch = search.trim().replace(/[%_,]/g, "").slice(0, 60);
  if (cleanSearch) request = request.ilike("name", `%${cleanSearch}%`);
  if (isAeToken !== null) request = request.eq("is_ae_token", isAeToken);
  const { data, error } = await request;
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  if (!rows.length) return cleanSearch ? `找不到名稱包含「${cleanSearch}」的標的。` : "目前查無平台標的。";
  const lines = rows.map((row) => {
    const status = row.is_delisted ? "已下架" : row.is_active ? "上架中" : "未啟用";
    const type = row.is_ae_token ? "AE" : "RWA";
    return `• ${row.name}｜${type}｜${status}\n  價格 ${formatNumber(Number(row.price))} JC｜可認購 ${formatNumber(Number(row.available))} 份`;
  });
  return `平台標的${cleanSearch ? `｜搜尋：${cleanSearch}` : "（最多 25 筆）"}\n${lines.join("\n")}`;
}

async function queryCommissions(admin: ReturnType<typeof getAdminClient>) {
  const { data, error } = await admin
    .from("commission_logs")
    .select("commission_amount,paid_at")
    .limit(5000);
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  const pending = rows.filter((row) => !row.paid_at);
  const paid = rows.filter((row) => row.paid_at);
  const sum = (items: typeof rows) => items.reduce((total, row) => total + Number(row.commission_amount), 0);
  return `代理分潤概況（最多讀取 5,000 筆）\n待發放：${pending.length} 筆｜${formatNumber(sum(pending))} JC\n已發放：${paid.length} 筆｜${formatNumber(sum(paid))} JC`;
}

async function querySettlements(admin: ReturnType<typeof getAdminClient>) {
  const [pending, failed, confirmed] = await Promise.all([
    countRows(admin.from("onchain_settlements").select("id", { count: "exact", head: true }).eq("status", "pending")),
    countRows(admin.from("onchain_settlements").select("id", { count: "exact", head: true }).eq("status", "failed")),
    countRows(admin.from("onchain_settlements").select("id", { count: "exact", head: true }).eq("status", "confirmed")),
  ]);
  return `鏈上結算狀態\n處理中：${formatNumber(pending)} 筆\n失敗待處理：${formatNumber(failed)} 筆\n已確認：${formatNumber(confirmed)} 筆`;
}

async function querySystem(admin: ReturnType<typeof getAdminClient>) {
  const [open, critical] = await Promise.all([
    countRows(admin.from("system_monitor_events").select("id", { count: "exact", head: true }).eq("status", "open")),
    countRows(admin.from("system_monitor_events").select("id", { count: "exact", head: true }).eq("status", "open").eq("severity", "critical")),
  ]);
  return `系統監控\n未結案事件：${formatNumber(open)} 件\n未結案嚴重事件：${formatNumber(critical)} 件`;
}

async function querySummary(admin: ReturnType<typeof getAdminClient>) {
  const [users, placements, pendingCommissions, failedSettlements, openEvents] = await Promise.all([
    countRows(admin.from("profiles").select("id", { count: "exact", head: true })),
    countRows(admin.from("private_placements").select("id", { count: "exact", head: true }).eq("is_active", true).eq("is_delisted", false)),
    countRows(admin.from("commission_logs").select("id", { count: "exact", head: true }).is("paid_at", null)),
    countRows(admin.from("onchain_settlements").select("id", { count: "exact", head: true }).eq("status", "failed")),
    countRows(admin.from("system_monitor_events").select("id", { count: "exact", head: true }).eq("status", "open")),
  ]);
  return `RWMT 營運摘要\n會員：${formatNumber(users)} 人\n上架標的：${formatNumber(placements)} 個\n待發分潤：${formatNumber(pendingCommissions)} 筆\n失敗鏈上結算：${formatNumber(failedSettlements)} 筆\n未結案系統事件：${formatNumber(openEvents)} 件\n\n輸入 /help 查看其他查詢。`;
}

function queryKind(value: string) {
  if (/會員|用戶|使用者|帳號|user/i.test(value)) return "users";
  if (/標的|資產|項目|認購|RWA|AE/i.test(value)) return "placements";
  if (/分潤|佣金|獎金|commission/i.test(value)) return "commissions";
  if (/鏈上|結算|交易狀態|settlement|chain/i.test(value)) return "settlements";
  if (/系統|錯誤|監控|事件|error|system/i.test(value)) return "system";
  if (/總覽|摘要|平台|summary|overview/i.test(value)) return "summary";
  return null;
}

async function runQuery(admin: ReturnType<typeof getAdminClient>, input: string) {
  const kind = queryKind(input);
  if (!kind) return null;
  if (kind === "users") return queryUsers(admin);
  if (kind === "placements") {
    const isAeToken = /\bAE\b/i.test(input) ? true : /\bRWA\b/i.test(input) ? false : null;
    const search = input.replace(/^(?:請)?(?:查詢|查|搜尋)?(?:平台)?(?:AE|RWA)?\s*(?:標的|資產|項目)?(?:名稱)?\s*/i, "").trim();
    return queryPlacements(admin, search, isAeToken);
  }
  if (kind === "commissions") return queryCommissions(admin);
  if (kind === "settlements") return querySettlements(admin);
  if (kind === "system") return querySystem(admin);
  return querySummary(admin);
}

async function isLinkedPlatformAdmin(senderId: number) {
  const admin = getAdminClient();
  const { data: link, error: linkError } = await admin
    .from("telegram_user_links")
    .select("user_id")
    .eq("chat_id", String(senderId))
    .maybeSingle();
  if (linkError) throw new Error(linkError.message);
  if (!link) return false;
  const { data: profile, error } = await admin.from("profiles").select("agency_role,role").eq("id", link.user_id).maybeSingle();
  if (error) throw new Error(error.message);
  return ["admin", "super_admin", "管理員"].includes(profile?.agency_role ?? "") ||
    ["admin", "super_admin"].includes(profile?.role ?? "");
}

async function sendHelp(chatId: string | number) {
  await sendTelegramOpsChatMessage(chatId, [
    "RWMT 營運機器人",
    "/summary — 平台營運摘要",
    "/query 會員 — 會員與客服連結數",
    "/query 標的 — 上架標的、價格與可認購份額",
    "/query AE 或 /query RWA — 依資產類型篩選",
    "/query 標的 <名稱> — 搜尋標的資訊",
    "/query 分潤 — 待發與已發分潤彙總",
    "/query 鏈上 — 結算狀態統計",
    "/query 系統 — 未結案監控事件數",
    "/broadcast 內容 — 管理員向營運群組播報",
  ].join("\n"));
}

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "POST") return json(response, 405, { error: "Method not allowed" });

  try {
    if (!validWebhookSecret(request.headers["x-telegram-bot-api-secret-token"])) {
      return json(response, 401, { error: "Invalid webhook signature" });
    }
  } catch {
    return json(response, 503, { error: "Operations Telegram bot is not configured" });
  }

  let update: TelegramUpdate;
  try {
    update = await readBody(request);
  } catch {
    return json(response, 400, { error: "Invalid update" });
  }

  const message = update.message;
  const chat = message?.chat;
  const chatId = chat?.id;
  if (!message || chatId == null || chat?.type === "private") return json(response, 200, { ok: true, ignored: true });
  if (!isAuthorizedTelegramChat(chatId)) return json(response, 403, { error: "Forbidden chat" });

  const text = message?.text?.trim() ?? "";
  if (!text) return json(response, 200, { ok: true, ignored: true });

  try {
    if (/^\/(?:start|help|menu)(?:@\w+)?$/i.test(text)) {
      await sendHelp(chatId);
      return json(response, 200, { ok: true });
    }

    const broadcast = text.match(/^\/(?:broadcast|announce)(?:@\w+)?\s+([\s\S]+)$/i);
    if (broadcast) {
      if (!message.from?.id || !await isLinkedPlatformAdmin(message.from.id)) {
        await sendTelegramOpsChatMessage(chatId, "播報功能僅限已連結 RWMT 管理員帳號使用。");
        return json(response, 200, { ok: true, forbidden: true });
      }
      const body = broadcast[1].trim().slice(0, 3000);
      if (!body) {
        await sendHelp(chatId);
        return json(response, 200, { ok: true });
      }
      await sendTelegramOpsChatMessage(chatId, `平台播報\n${body}`);
      return json(response, 200, { ok: true, broadcast: true });
    }

    const command = text.match(/^\/(?:summary|query|ask)(?:@\w+)?(?:\s+([\s\S]+))?$/i);
    const queryText = command ? command[1]?.trim() || "平台總覽" : text;
    if (!queryKind(queryText)) {
      if (command) {
        await sendHelp(chatId);
        return json(response, 200, { ok: true, help: true });
      }
      return json(response, 200, { ok: true, ignored: true });
    }
    if (!message.from?.id || !await isLinkedPlatformAdmin(message.from.id)) {
      await sendTelegramOpsChatMessage(chatId, "平台資料查詢僅限已連結 RWMT 管理員帳號使用。");
      return json(response, 200, { ok: true, forbidden: true });
    }

    const answer = await runQuery(getAdminClient(), queryText);
    if (answer) {
      await sendTelegramOpsChatMessage(chatId, answer);
      return json(response, 200, { ok: true, queried: true });
    }
    return json(response, 200, { ok: true, ignored: true });
  } catch (error) {
    console.error("Telegram operations query failed", error instanceof Error ? error.message : "unknown error");
    await sendTelegramOpsChatMessage(chatId, "查詢暫時無法完成，請稍後再試；詳細錯誤已記錄在伺服器端。").catch(() => undefined);
    return json(response, 200, { ok: true, queryFailed: true });
  }
}

export const config = { maxDuration: 15 };
