export type TradeAttemptEvent = {
  event_key: string;
  message: string;
  metadata: unknown;
};

export function getConsecutiveTradeFailureStreak(events: TradeAttemptEvent[]) {
  const failuresNewestFirst: TradeAttemptEvent[] = [];

  for (const event of events) {
    const metadata = event.metadata && typeof event.metadata === "object"
      ? event.metadata as Record<string, unknown>
      : {};
    if (metadata.success !== false) break;
    failuresNewestFirst.push(event);
  }

  return {
    count: failuresNewestFirst.length,
    firstEventKey: failuresNewestFirst.at(-1)?.event_key ?? null,
    failuresNewestFirst,
  };
}

export function isValidTradeRequestKey(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isValidTradeQuantity(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1_000_000;
}

export function estimateTradeAmount(price: unknown, quantity: number) {
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) return null;
  const amount = numericPrice * quantity;
  return Number.isFinite(amount) ? amount : null;
}

export function formatTradeAlertAmount(value: number | null) {
  return value === null ? "無法估算" : value.toLocaleString("zh-TW", { maximumFractionDigits: 6 });
}

export function tradeFailureAlertMessage(input: {
  displayName: string;
  email: string;
  placementName: string;
  quantity: number;
  estimatedJc: number | null;
  failures: TradeAttemptEvent[];
}) {
  const errorLines = [...input.failures].reverse().map((failure, index) => {
    const metadata = failure.metadata && typeof failure.metadata === "object"
      ? failure.metadata as Record<string, unknown>
      : {};
    return `${index + 1}. ${String(metadata.failure_reason ?? failure.message).slice(0, 240)}`;
  });

  return [
    "用戶連續交易失敗告警",
    `連續失敗：${input.failures.length} 次`,
    `用戶：${input.displayName}（${input.email}）`,
    `標的：${input.placementName}`,
    `份額數量：${input.quantity.toLocaleString("zh-TW", { maximumFractionDigits: 6 })}`,
    `預估金額：${formatTradeAlertAmount(input.estimatedJc)} JC`,
    "失敗原因：",
    ...errorLines,
  ].join("\n").slice(0, 3000);
}

export function settlementFailureAlertMessage(input: {
  stage: string;
  participants: string[];
  item: string;
  quantity: string | number | null;
  amountJc: string | number | null;
  reason: string;
  txHash?: string | null;
}) {
  const display = (value: string | number | null) => {
    if (value === null) return "—";
    const numeric = Number(value);
    return Number.isFinite(numeric)
      ? numeric.toLocaleString("zh-TW", { maximumFractionDigits: 6 })
      : String(value);
  };

  return [
    "交割失敗即時告警",
    `失敗階段：${input.stage}`,
    ...input.participants.map((participant) => `用戶：${participant}`),
    `交割標的：${input.item}`,
    `交割數量：${display(input.quantity)}`,
    `JC 金額：${display(input.amountJc)} JC`,
    `失敗原因：${input.reason.slice(0, 700)}`,
    input.txHash ? `交易雜湊：${input.txHash}` : null,
  ].filter(Boolean).join("\n").slice(0, 3000);
}

export function consecutiveFailureAlertKey(userId: string, firstEventKey: string) {
  return `trade-failure-streak:${userId}:${firstEventKey}`;
}

export function settlementFailureSourceKey(settlementId: string) {
  return `settlement-failure:${settlementId}`;
}

export function escrowFailureSourceKey(txHash: string) {
  return `escrow-failure:${txHash.toLowerCase()}`;
}

export function tradeAttemptEventKey(userId: string, requestKey: string) {
  return `trade-result:${userId}:${requestKey}`;
}

export function thirdFailureReached(count: number) {
  return count === 3;
}

export function hasRecordedTradeResult(insertErrorCode: string | undefined) {
  return insertErrorCode === "23505";
}

export function stableFailureAlertSource(alertKey: string) {
  return alertKey.slice(0, 80);
}

export function isTradeFailureMetadata(value: unknown): value is { success: boolean; user_id: string } {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Record<string, unknown>;
  return typeof metadata.success === "boolean" && typeof metadata.user_id === "string";
}

export function formatSettlementQuantity(value: string | number | null) {
  if (value === null) return "—";
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toLocaleString("zh-TW", { maximumFractionDigits: 6 }) : String(value);
}
