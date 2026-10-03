export const TRANSACTION_HISTORY_START_AT = "2026-10-03T10:57:00.000Z";

export function isTransactionHistoryVisible(createdAt: string): boolean {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && timestamp >= Date.parse(TRANSACTION_HISTORY_START_AT);
}
