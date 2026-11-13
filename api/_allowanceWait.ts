export type AllowanceSnapshot = { allowance: bigint; balance: bigint };

/**
 * 買方的 approve 通常只比收款早幾秒上鏈，落後的 RPC 節點可能仍回報舊額度。
 * 額度不足時每隔 delayMs 重讀一次，最多 attempts 次，給節點同步時間後才判定失敗。
 */
export async function waitForSufficientAllowance(params: {
  read: () => Promise<AllowanceSnapshot>;
  required: bigint;
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<AllowanceSnapshot> {
  const { read, required, attempts = 6, delayMs = 2_500 } = params;
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let snapshot = await read();
  for (let attempt = 0; snapshot.allowance < required && attempt < attempts; attempt++) {
    await sleep(delayMs);
    snapshot = await read();
  }
  return snapshot;
}
