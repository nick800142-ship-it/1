import { describe, expect, it } from "vitest";
import {
  MAX_PRIORITY_FEE_WEI,
  MIN_PRIORITY_FEE_WEI,
  classifyRpcBroadcastError,
  decideBroadcastPersistence,
  isUnrecoverableBroadcastRejection,
  quoteFees,
  resolveAdminTransactionStatus,
} from "../api/_transactionState";

describe("admin transaction reliability", () => {
  it("treats a receipt from any RPC as confirmed", () => {
    expect(resolveAdminTransactionStatus([
      { transactionFound: false },
      { receiptStatus: "success", transactionFound: true },
    ])).toBe("confirmed");
  });

  it("treats a reverted receipt from any RPC as reverted", () => {
    expect(resolveAdminTransactionStatus([
      { transactionFound: false },
      { receiptStatus: "reverted", transactionFound: true },
    ])).toBe("reverted");
  });

  it("keeps a transaction pending when at least one RPC sees it", () => {
    expect(resolveAdminTransactionStatus([
      { transactionFound: false },
      { transactionFound: true },
    ])).toBe("pending");
  });

  it("does not claim a result when RPCs disagree about receipt status", () => {
    expect(resolveAdminTransactionStatus([
      { receiptStatus: "success" },
      { receiptStatus: "reverted" },
    ])).toBe("unknown");
  });

  it("requires verification before keeping a hash that only produced nonce conflicts", () => {
    expect(classifyRpcBroadcastError("replacement transaction underpriced")).toBe("conflict");
    expect(classifyRpcBroadcastError("nonce too low: next nonce 2277, tx nonce 2276")).toBe("conflict");
    expect(decideBroadcastPersistence(["conflict", "conflict"])).toBe("verify");
    expect(decideBroadcastPersistence(["conflict", "rejected"])).toBe("verify");
  });

  it("treats a too-low tip as a definitive rejection that is safe to re-sign", () => {
    expect(classifyRpcBroadcastError("transaction underpriced: gas tip cap 1000000, minimum needed 25000000")).toBe("rejected");
    expect(isUnrecoverableBroadcastRejection("transaction underpriced")).toBe(false);
    expect(isUnrecoverableBroadcastRejection("insufficient funds for gas * price + value")).toBe(true);
  });

  it("treats a network timeout as ambiguous so the signed hash is retained", () => {
    expect(classifyRpcBroadcastError("fetch failed: request timeout")).toBe("ambiguous");
    expect(decideBroadcastPersistence(["ambiguous", "rejected"])).toBe("persist");
    expect(decideBroadcastPersistence(["accepted", "conflict"])).toBe("persist");
  });

  it("rejects only when every RPC definitively refuses the signed transaction", () => {
    expect(decideBroadcastPersistence(["rejected", "rejected"])).toBe("reject");
    expect(classifyRpcBroadcastError("insufficient funds for gas")).toBe("rejected");
  });
});

describe("fee quote", () => {
  it("never drops below the priority fee floor even when the RPC suggests 0.001 gwei", () => {
    const quote = quoteFees({ baseFeePerGas: 5_000_000n, rewards: [1_000_000n, 1_000_000n], suggestedTip: 1_000_000n });
    expect(quote.maxPriorityFeePerGas).toBe(MIN_PRIORITY_FEE_WEI);
    expect(quote.maxFeePerGas).toBe(5_000_000n * 2n + MIN_PRIORITY_FEE_WEI);
  });

  it("follows observed tips with headroom when the network is busier", () => {
    const quote = quoteFees({
      baseFeePerGas: 5_000_000n,
      rewards: [20_000_000n, 24_000_000n, 40_000_000n, 169_000_000n],
      suggestedTip: 1_000_000n,
    });
    expect(quote.maxPriorityFeePerGas).toBe((169_000_000n * 125n) / 100n);
    expect(quote.maxFeePerGas).toBe(10_000_000n + quote.maxPriorityFeePerGas);
  });

  it("caps runaway tips and still applies the replacement boost on top", () => {
    const quote = quoteFees({ baseFeePerGas: 5_000_000n, rewards: [50_000_000_000n], boost: 1.6 });
    expect(quote.maxPriorityFeePerGas).toBe((MAX_PRIORITY_FEE_WEI * 160n) / 100n);
  });

  it("boosts by at least the 10% replacement threshold", () => {
    const base = quoteFees({ baseFeePerGas: 5_000_000n, rewards: [] });
    const bumped = quoteFees({ baseFeePerGas: 5_000_000n, rewards: [], boost: 1.6 });
    expect(bumped.maxPriorityFeePerGas * 100n >= base.maxPriorityFeePerGas * 110n).toBe(true);
    expect(bumped.maxFeePerGas * 100n >= base.maxFeePerGas * 110n).toBe(true);
  });
});
