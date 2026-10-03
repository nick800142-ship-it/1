export const TRANSACTION_HISTORY_START_AT = "2026-10-03T10:57:00.000Z";
export const TRANSACTION_HISTORY_START_LABEL = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
}).format(new Date(TRANSACTION_HISTORY_START_AT));

export function isTransactionHistoryVisible(createdAt: string): boolean {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && timestamp >= Date.parse(TRANSACTION_HISTORY_START_AT);
}
