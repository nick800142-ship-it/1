import type { PublicClient } from "viem";

// 使用者錢包（Privy 內嵌錢包）送出的 approve／transfer 的 EIP-1559 費率報價。
// 與後端 api/_transactionState.ts 的 quoteFees 為同一份純邏輯。
//
// Base 公開 RPC 的 eth_maxPriorityFeePerGas 常回傳 0.001 gwei，遠低於實際被打包交易的小費
// （feeHistory p50 約 0.02 gwei）。錢包照該建議值送出時，交易會被定序器拒收或長期排隊；
// 使用者按「重試」又以同 nonce 重送，就出現 replacement transaction underpriced。
// Base 單筆 gas 成本極低（約 0.000003 ETH），寧可多付小費也不要讓使用者卡單。

export type FeeQuote = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

export const MIN_PRIORITY_FEE_WEI = 25_000_000n; // 0.025 gwei
export const MAX_PRIORITY_FEE_WEI = 2_000_000_000n; // 2 gwei 上限
const BASE_FEE_HEADROOM_MULTIPLIER = 2n;

export function quoteFees(input: {
  baseFeePerGas: bigint;
  rewards: readonly bigint[];
  suggestedTip?: bigint | null;
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

/**
 * 讀取最近區塊的實際小費並產生報價；RPC 失敗時回傳 undefined，讓錢包沿用自己的估算。
 * boost＞1 用於同 nonce 重送（需比原交易高 ≥10% 才能取代）。
 */
export async function fetchFeeQuote(client: PublicClient, boost = 1): Promise<FeeQuote | undefined> {
  try {
    const [history, suggested] = await Promise.all([
      client.request({ method: "eth_feeHistory", params: ["0x5", "latest", [60, 75]] }),
      client.request({ method: "eth_maxPriorityFeePerGas" }).catch(() => null),
    ]);
    const baseFees = (history?.baseFeePerGas ?? []).map((value) => BigInt(value));
    if (!baseFees.length) return undefined;
    const rewards = (history?.reward ?? []).flat().map((value) => BigInt(value));
    return quoteFees({
      baseFeePerGas: baseFees[baseFees.length - 1],
      rewards,
      suggestedTip: suggested ? BigInt(suggested) : null,
      boost,
    });
  } catch {
    return undefined;
  }
}
