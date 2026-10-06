import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticateTelegramRequest, isTelegramAdmin, readJsonBody } from "./_telegram-auth.js";

const categories = [
  "認購／購買流程",
  "二級市場／掛單成交",
  "AE／RWA 資產與標的",
  "錢包／JC／USDT",
  "設定／登入／帳號",
  "代理／分潤／獎金",
  "費率／價格／手續費",
  "網站操作／錯誤",
  "其他",
] as const;

const categoryAliases: Record<string, string> = {
  "登入／帳號／綁定": "設定／登入／帳號",
};

type DateRequest = { startDate?: unknown; endDate?: unknown };
type TopicRow = { category: string; subcategory: string | null };

function json(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

function taipeiDateBoundary(value: unknown, includeFollowingDay = false) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0, 10) !== value) return null;
  return new Date(Date.UTC(year, month - 1, day + Number(includeFollowingDay)) - 8 * 60 * 60 * 1000).toISOString();
}

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return json(response, 405, { error: "Method not allowed" });
  }

  try {
    const auth = await authenticateTelegramRequest(request);
    if (!auth) return json(response, 401, { error: "登入狀態已失效，請重新登入。" });
    if (!isTelegramAdmin(auth.profile)) return json(response, 403, { error: "僅限管理員使用。" });

    let input: DateRequest;
    try {
      input = await readJsonBody<DateRequest>(request, 2_048);
    } catch {
      return json(response, 400, { error: "查詢條件格式錯誤。" });
    }

    const startDate = typeof input.startDate === "string" ? input.startDate : "";
    const endDate = typeof input.endDate === "string" ? input.endDate : "";
    const startAt = taipeiDateBoundary(startDate);
    const endAt = taipeiDateBoundary(endDate, true);
    if (!startAt || !endAt || startAt > endAt || startDate > endDate) {
      return json(response, 400, { error: "請提供有效的起訖日期。" });
    }

    const counts = new Map<string, { count: number; subcategories: Map<string, number> }>();
    let total = 0;
    const pageSize = 1_000;
    const maximumRows = 200_000;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await auth.admin
        .from("telegram_support_question_topics")
        .select("category,subcategory")
        .gte("asked_at", startAt)
        .lt("asked_at", endAt)
        .order("asked_at", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) {
        console.error("[support-analytics] Could not load topic rows", error.message);
        return json(response, 500, { error: "客服數據讀取失敗，請稍後再試。" });
      }

      const rows = (data ?? []) as TopicRow[];
      for (const row of rows) {
        const name = categoryAliases[row.category] ?? row.category;
        const subcategory = row.subcategory?.trim() || "未分類";
        const entry = counts.get(name) ?? { count: 0, subcategories: new Map<string, number>() };
        entry.count += 1;
        entry.subcategories.set(subcategory, (entry.subcategories.get(subcategory) ?? 0) + 1);
        counts.set(name, entry);
        total += 1;
      }

      if (total >= maximumRows && rows.length === pageSize) {
        return json(response, 413, { error: "此日期範圍的資料量過大，請縮短查詢區間。" });
      }
      if (rows.length < pageSize) break;
    }

    const categoryNames = [...categories, ...Array.from(counts.keys()).filter((name) => !categories.includes(name as (typeof categories)[number]))];
    const result = categoryNames.map((name) => {
      const entry = counts.get(name);
      const count = entry?.count ?? 0;
      return {
        name,
        count,
        percentage: total ? Number(((count / total) * 100).toFixed(1)) : 0,
        subcategories: Array.from(entry?.subcategories ?? [], ([subcategoryName, subcategoryCount]) => ({
          name: subcategoryName,
          count: subcategoryCount,
          percentage: count ? Number(((subcategoryCount / count) * 100).toFixed(1)) : 0,
        })).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
      };
    });

    return json(response, 200, { total, categories: result });
  } catch (error) {
    console.error("[support-analytics] Request failed", error instanceof Error ? error.message : "unknown error");
    return json(response, 500, { error: "客服數據服務暫時無法使用，請稍後再試。" });
  }
}

