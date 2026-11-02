import { describe, expect, it } from "vitest";
import {
  classifyRpcBroadcastError,
  resolveAdminTransactionStatus,
  shouldPersistBroadcastHash,
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

  it("classifies underpriced and nonce conflicts as ambiguous, not retryable", () => {
    expect(classifyRpcBroadcastError("replacement transaction underpriced")).toBe("conflict");
    expect(shouldPersistBroadcastHash(["conflict"])).toBe(true);
  });

  it("treats a network timeout as ambiguous so the signed hash is retained", () => {
    expect(classifyRpcBroadcastError("fetch failed: request timeout")).toBe("ambiguous");
    expect(shouldPersistBroadcastHash(["ambiguous", "rejected"])).toBe(true);
  });

  it("throws only when every RPC definitively rejects the signed transaction", () => {
    expect(shouldPersistBroadcastHash(["rejected", "rejected"])).toBe(false);
    expect(classifyRpcBroadcastError("insufficient funds for gas")).toBe("rejected");
  });
});
