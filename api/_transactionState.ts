export type RpcBroadcastOutcome = "accepted" | "known" | "conflict" | "ambiguous" | "rejected";
export type AdminTransactionStatus = "confirmed" | "reverted" | "pending" | "unknown";

export interface TransactionProbe {
  receiptStatus?: "success" | "reverted";
  transactionFound?: boolean;
}

export function classifyRpcBroadcastError(message: string): RpcBroadcastOutcome {
  if (/already known|known transaction|already imported/i.test(message)) return "known";
  if (/replacement transaction underpriced|transaction underpriced|nonce too low|nonce has already been used|already used/i.test(message)) {
    return "conflict";
  }
  if (/timeout|timed out|fetch failed|connection reset|econn|etimedout|temporarily unavailable|\b50[234]\b|aborted/i.test(message)) {
    return "ambiguous";
  }
  return "rejected";
}

export function shouldPersistBroadcastHash(outcomes: readonly RpcBroadcastOutcome[]): boolean {
  return outcomes.some((outcome) => outcome !== "rejected");
}

export function resolveAdminTransactionStatus(observations: readonly TransactionProbe[]): AdminTransactionStatus {
  const receiptStatuses = new Set(
    observations.flatMap((observation) => observation.receiptStatus ? [observation.receiptStatus] : []),
  );

  if (receiptStatuses.size > 1) return "unknown";
  if (receiptStatuses.has("success")) return "confirmed";
  if (receiptStatuses.has("reverted")) return "reverted";
  if (observations.some((observation) => observation.transactionFound)) return "pending";
  return "unknown";
}
