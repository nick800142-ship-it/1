import { describe, expect, it } from "vitest";
import { isQuestionReportRequest, parseQuestionDateRange } from "../api/telegram-callback";

describe("Telegram support question reports", () => {
  it("routes natural-language requests for today's support statistics", () => {
    const text = "查詢今天客服統計數據";

    expect(isQuestionReportRequest(text)).toBe(true);
    expect(parseQuestionDateRange(text)).not.toBeNull();
  });

  it("uses Taipei calendar-day boundaries for today and yesterday", () => {
    const today = parseQuestionDateRange("今天客服統計")!;
    const yesterday = parseQuestionDateRange("昨天客服提問統計")!;

    expect(new Date(today.startDate).getUTCHours()).toBe(16);
    expect(new Date(today.endDate).getTime() - new Date(today.startDate).getTime()).toBe(24 * 60 * 60 * 1000);
    expect(new Date(yesterday.endDate).getTime()).toBe(new Date(today.startDate).getTime());
  });

  it("does not mistake ordinary support questions for statistics requests", () => {
    expect(isQuestionReportRequest("客服的聯絡方式是什麼？")).toBe(false);
    expect(parseQuestionDateRange("客服的聯絡方式是什麼？")).toBeNull();
  });
});
