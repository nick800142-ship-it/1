// 結算列（onchain_settlements）同時是「誰可以動這筆訂單」的鎖：自動補發、買方「完成交割」、
// 買方「取消」都必須先取得這把鎖才可動作，避免同一筆訂單一邊被取消、一邊被收款。

// relayer 函式最長 60 秒（vercel.json），pending 且 10 分鐘未更新必然已中斷，可安全接手。
export const SETTLEMENT_ABANDONED_MS = 10 * 60 * 1000;

export type SettlementClaimRow = {
  status: string;
  error: string | null;
  payload: unknown;
  updated_at: string;
};

export type SettlementOwnership =
  | "confirmed"
  | "cancelled"
  | "in_flight"
  | "failed"
  | "parked"
  | "abandoned";

function payloadOf(row: SettlementClaimRow): Record<string, unknown> {
  return row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
}

/**
 * in_flight：有請求正持有鎖，其他人一律不得動作。
 * failed／parked（上一輪失敗後停放，status 仍為 pending 但帶 error）／abandoned（逾時中斷）：無人持有，可原子接手。
 * cancelled：買方已取消，永遠不得再收款或發放。
 */
export function settlementOwnership(row: SettlementClaimRow, now = Date.now()): SettlementOwnership {
  if (row.status === "confirmed") return "confirmed";
  if (payloadOf(row).cancelled === true) return "cancelled";
  if (row.status === "failed") return "failed";
  if (row.status === "pending") {
    if (row.error) return "parked";
    const updatedAt = Date.parse(row.updated_at);
    if (Number.isFinite(updatedAt) && now - updatedAt >= SETTLEMENT_ABANDONED_MS) return "abandoned";
  }
  return "in_flight";
}

export function isSettlementReclaimable(ownership: SettlementOwnership): boolean {
  return ownership === "failed" || ownership === "parked" || ownership === "abandoned";
}
