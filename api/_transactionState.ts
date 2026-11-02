export type RpcBroadcastOutcome = "accepted" | "known" | "conflict" | "ambiguous" | "rejected";
export type AdminTransactionStatus = "confirmed" | "reverted" | "pending" | "unknown";
/**
 * persist：至少一個節點收下（或早已認得）這筆簽名交易，hash 可保留並等待收據。
 * verify：只有「同 nonce 衝突」類錯誤——節點裡佔住 nonce 的是另一筆交易，這筆未必進了 mempool，
 *         必須先向各節點確認認得此 hash 才可保留，否則視為未送出。
 * reject：所有節點都明確拒收，交易不在任何 mempool，可安全換費率重簽。
 */
export type BroadcastDecision = "persist" | "verify" | "reject";

export interface TransactionProbe {
  receiptStatus?: "success" | "reverted";
  transactionFound?: boolean;
}

export function classifyRpcBroadcastError(message: string): RpcBroadcastOutcome {
  if (/already known|known transaction|already imported/i.test(message)) return "known";
  if (/replacement transaction underpriced|nonce too low|nonce has already been used|already used/i.test(message)) {
    return "conflict";
  }
  if (/timeout|timed out|fetch failed|connection reset|econn|etimedout|temporarily unavailable|\b50[234]\b|aborted/i.test(message)) {
    return "ambiguous";
  }
  // 含「transaction underpriced」（小費低於定序器門檻）與餘額不足等：節點明確拒收，交易不在 mempool。
  return "rejected";
}

export function decideBroadcastPersistence(outcomes: readonly RpcBroadcastOutcome[]): BroadcastDecision {
  if (outcomes.some((outcome) => outcome === "accepted" || outcome === "known" || outcome === "ambiguous")) {
    return "persist";
  }
  if (outcomes.some((outcome) => outcome === "conflict")) return "verify";
  return "reject";
}

/** 加價重送也不可能成功的拒收原因（餘額不足、交易本身無效）。 */
export function isUnrecoverableBroadcastRejection(message: string): boolean {
  return /insufficient funds|intrinsic gas too low|exceeds block gas limit|invalid sender|invalid chain id|chainid mismatch|oversized data|max initcode size/i.test(
    message,
  );
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

// ---------------------------------------------------------------------------
// EIP-1559 費率報價（前端 src/lib/txFees.ts 有同一份純邏輯的鏡像）
// ---------------------------------------------------------------------------
//
// Base 公開 RPC 的 eth_maxPriorityFeePerGas 常回傳 0.001 gwei，遠低於實際被打包交易的小費
// （feeHistory p50 約 0.02 gwei）。小費過低時定序器會直接拒收（transaction underpriced）
// 或讓交易長期排隊；之後同 nonce 重送又變成 replacement transaction underpriced。
// Base 單筆 gas 成本極低，寧可多付小費也不要卡單。

export type FeeQuote = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

export const MIN_PRIORITY_FEE_WEI = 25_000_000n; // 0.025 gwei
export const MAX_PRIORITY_FEE_WEI = 2_000_000_000n; // 2 gwei：feeHistory 偶發尖峰時的付費上限
export const BASE_FEE_HEADROOM_MULTIPLIER = 2n; // maxFeePerGas 預留 2 倍 baseFee 的漲幅空間

export function quoteFees(input: {
  baseFeePerGas: bigint;
  rewards: readonly bigint[];
  suggestedTip?: bigint | null;
  /** 同 nonce 重送時的加價倍率（需 ≥ 1.1 才能取代原交易）。 */
  boost?: number;
}): FeeQuote {
  const rewards = [...input.rewards].filter((reward) => reward >= 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const p75 = rewards.length ? rewards[Math.min(rewards.length - 1, Math.floor(rewards.length * 0.75))] : 0n;
  let tip = (p75 * 125n) / 100n;
  if (input.suggestedTip && input.suggestedTip * 2n > tip) tip = input.suggestedTip * 2n;
  if (tip < MIN_PRIORITY_FEE_WEI) tip = MIN_PRIORITY_FEE_WEI;
  if (tip > MAX_PRIORITY_FEE_WEI) tip = MAX_PRIORITY_FEE_WEI;
  const boostPercent = input.boost && input.boost > 1 ? BigInt(Math.round(input.boost * 100)) : 100n;
  tip = (tip * boostPercent) / 100n;
  return {
    maxFeePerGas: input.baseFeePerGas * BASE_FEE_HEADROOM_MULTIPLIER + tip,
    maxPriorityFeePerGas: tip,
  };
}
