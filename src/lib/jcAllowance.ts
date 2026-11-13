export type PendingJcReservation = {
  request_key: string;
  action: string;
  jc_amount: number | string | null;
  chain_payload?: Record<string, unknown> | null;
};

export type SettlementPayloadByRef = ReadonlyMap<string, Record<string, unknown> | null | undefined>;

// 這些步驟代表買方 JC 已經被 transferFrom 收走（授權已消耗、餘額已離開錢包）。
const JC_COLLECTED_STEP_KEYS = ["jcToVaultTx", "jcPullTx", "jcCollectTx"] as const;

export function settlementRefKeyForReservation(row: PendingJcReservation): string | null {
  if (row.action === "subscribe") return `subscribe:${row.request_key}`;
  if (row.action === "redeem") {
    const orderId = row.chain_payload?.order_id;
    return typeof orderId === "string" && orderId ? `redeem:${orderId}` : null;
  }
  return null;
}

export function jcAlreadyCollected(payload: Record<string, unknown> | null | undefined): boolean {
  return Boolean(payload) && JC_COLLECTED_STEP_KEYS.some((key) => typeof payload?.[key] === "string");
}

function roundJc(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * ERC-20 approve 是「設定」額度而非累加。為了不讓新訂單吃掉尚在交割中的舊訂單額度，
 * 授權額度必須涵蓋本筆＋本人其他仍待收 JC 的預留；已收過 JC 的預留不再計入。
 */
export function requiredJcAllowance(
  gross: number,
  pendingReservations: readonly PendingJcReservation[],
  settlementPayloads: SettlementPayloadByRef = new Map(),
): { pendingJc: number; totalJc: number } {
  const pendingJc = roundJc(pendingReservations.reduce((sum, row) => {
    if (row.action !== "subscribe" && row.action !== "redeem") return sum;
    const refKey = settlementRefKeyForReservation(row);
    if (refKey && jcAlreadyCollected(settlementPayloads.get(refKey))) return sum;
    const amount = Number(row.jc_amount);
    return Number.isFinite(amount) && amount > 0 ? sum + amount : sum;
  }, 0));
  const safeGross = Number.isFinite(gross) && gross > 0 ? gross : 0;
  return { pendingJc, totalJc: roundJc(safeGross + pendingJc) };
}
