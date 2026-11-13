import { describe, expect, it } from "vitest";
import { waitForSufficientAllowance, type AllowanceSnapshot } from "../api/_allowanceWait";
import { requiredJcAllowance, type PendingJcReservation } from "../src/lib/jcAllowance";

const UNIT = 1_000_000n;
const toUnits = (jc: number) => BigInt(Math.round(jc * 1e6));

describe("requiredJcAllowance", () => {
  it("covers this order plus every still-unpaid pending order", () => {
    const pending: PendingJcReservation[] = [
      { request_key: "a", action: "subscribe", jc_amount: "0.3" },
      { request_key: "b", action: "redeem", jc_amount: 2, chain_payload: { order_id: "o1" } },
    ];
    expect(requiredJcAllowance(0.1, pending)).toEqual({ pendingJc: 2.3, totalJc: 2.4 });
  });

  it("does not count orders whose JC was already collected", () => {
    const pending: PendingJcReservation[] = [
      { request_key: "a", action: "subscribe", jc_amount: 0.3 },
      { request_key: "b", action: "subscribe", jc_amount: 5 },
      { request_key: "c", action: "redeem", jc_amount: 7, chain_payload: { order_id: "o9" } },
    ];
    const payloads = new Map([
      ["subscribe:b", { jcToVaultTx: "0xabc" }],
      ["redeem:o9", { jcPullTx: "0xdef" }],
    ]);
    expect(requiredJcAllowance(1, pending, payloads)).toEqual({ pendingJc: 0.3, totalJc: 1.3 });
  });

  it("completing an existing order (gross 0) still approves that order's own amount", () => {
    const pending: PendingJcReservation[] = [{ request_key: "a", action: "subscribe", jc_amount: 0.3 }];
    expect(requiredJcAllowance(0, pending).totalJc).toBe(0.3);
  });

  it("ignores unrelated actions, invalid amounts, and float drift", () => {
    const pending: PendingJcReservation[] = [
      { request_key: "v", action: "vault_buy", jc_amount: 100 },
      { request_key: "x", action: "subscribe", jc_amount: null },
      { request_key: "y", action: "subscribe", jc_amount: "abc" },
      { request_key: "z", action: "subscribe", jc_amount: -4 },
      { request_key: "p", action: "subscribe", jc_amount: 0.1 },
      { request_key: "q", action: "subscribe", jc_amount: 0.2 },
    ];
    expect(requiredJcAllowance(0.7, pending)).toEqual({ pendingJc: 0.3, totalJc: 1 });
  });
});

describe("waitForSufficientAllowance", () => {
  const noSleep = async () => {};

  it("waits for a lagging RPC node to see a just-mined approve", async () => {
    const reads: AllowanceSnapshot[] = [
      { allowance: toUnits(0.2), balance: 10n * UNIT },
      { allowance: toUnits(0.2), balance: 10n * UNIT },
      { allowance: toUnits(0.3), balance: 10n * UNIT },
    ];
    let i = 0;
    const result = await waitForSufficientAllowance({ read: async () => reads[Math.min(i++, reads.length - 1)], required: toUnits(0.3), sleep: noSleep });
    expect(result.allowance).toBe(toUnits(0.3));
    expect(i).toBe(3);
  });

  it("does not wait when the allowance is already enough", async () => {
    let calls = 0;
    await waitForSufficientAllowance({ read: async () => { calls++; return { allowance: UNIT, balance: UNIT }; }, required: UNIT, sleep: noSleep });
    expect(calls).toBe(1);
  });

  it("gives up after the configured attempts so a truly missing approve still fails clearly", async () => {
    let calls = 0;
    const result = await waitForSufficientAllowance({ read: async () => { calls++; return { allowance: 0n, balance: UNIT }; }, required: UNIT, attempts: 6, sleep: noSleep });
    expect(result.allowance).toBe(0n);
    expect(calls).toBe(7);
  });
});

// 模擬真實 ERC-20：approve 是「設定」額度、transferFrom 會消耗額度；後端讀的 RPC 節點可能落後數個區塊。
class SimulatedJc {
  balance: bigint;
  allowanceHistory: bigint[] = [0n];
  constructor(balance: bigint) { this.balance = balance; }
  get allowance() { return this.allowanceHistory[this.allowanceHistory.length - 1]; }
  approve(value: bigint) { this.allowanceHistory.push(value); }
  transferFrom(value: bigint) {
    if (this.allowance < value) throw new Error("ERC20InsufficientAllowance");
    if (this.balance < value) throw new Error("ERC20InsufficientBalance");
    this.balance -= value;
    this.allowanceHistory.push(this.allowance - value);
  }
  laggingRead(lag: number): AllowanceSnapshot {
    const index = Math.max(0, this.allowanceHistory.length - 1 - lag);
    return { allowance: this.allowanceHistory[index], balance: this.balance };
  }
}

type Reservation = { key: string; jc: number; paid: boolean };

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

async function runScenario(seed: number, approvalRule: "fixed" | "legacy" = "fixed") {
  const random = seededRandom(seed);
  const chain = new SimulatedJc(1_000n * UNIT);
  const reservations: Reservation[] = [];
  let walletCompletions = 0;
  const pendingRows = () => reservations.filter((r) => !r.paid).map((r) => ({ request_key: r.key, action: "subscribe", jc_amount: r.jc }));

  // 前端流程：先依規則授權，再建立預留，再請後端收款。
  const placeOrder = (jc: number) => {
    const { totalJc } = approvalRule === "fixed" ? requiredJcAllowance(jc, pendingRows()) : { totalJc: jc };
    if (chain.allowance < toUnits(totalJc)) chain.approve(toUnits(totalJc));
    const reservation = { key: `r${reservations.length}`, jc, paid: false };
    reservations.push(reservation);
    return reservation;
  };

  // 後端流程：落後的節點讀額度，必要時等待同步，再 transferFrom。
  const settle = async (reservation: Reservation, lag: number) => {
    let reads = 0;
    const snapshot = await waitForSufficientAllowance({
      read: async () => chain.laggingRead(Math.max(0, lag - reads++)),
      required: toUnits(reservation.jc),
      sleep: async () => {},
    });
    if (snapshot.allowance < toUnits(reservation.jc)) return false;
    chain.transferFrom(toUnits(reservation.jc));
    reservation.paid = true;
    return true;
  };

  // 買方按「完成交割」：重新授權涵蓋自己所有未付預留後再收款。
  const completeFromWallet = async (reservation: Reservation) => {
    walletCompletions++;
    const { totalJc } = requiredJcAllowance(0, pendingRows());
    if (chain.allowance < toUnits(totalJc)) chain.approve(toUnits(totalJc));
    return settle(reservation, 0);
  };

  const steps = 3 + Math.floor(random() * 8);
  for (let step = 0; step < steps; step++) {
    const jc = Math.round((0.1 + random() * 3) * 10) / 10;
    const reservation = placeOrder(jc);
    const settleNow = random() < 0.7;
    // 落後最多 4 個額度狀態，模擬節點尚未同步剛上鏈的 approve。
    if (settleNow) await settle(reservation, Math.floor(random() * 5));
  }

  // 背景重試：任一未付預留，在節點同步後一定能收款，不需釋放。
  for (const reservation of reservations.filter((r) => !r.paid)) {
    const settledByRetry = await settle(reservation, 0);
    if (!settledByRetry) await completeFromWallet(reservation);
  }
  return { reservations, chain, walletCompletions };
}

describe("subscribeReservationAwaitsBuyer (popup trigger)", () => {
  const created = "2026-11-13T06:00:00.000Z";
  const at = (minutes: number) => new Date(created).getTime() + minutes * 60_000;
  const probe = (overrides: Partial<{ status: string; tx_hash: string | null; payload: unknown; updated_at: string; error: string | null }>) => ({
    status: "failed", tx_hash: null, payload: {}, updated_at: created, error: null, ...overrides,
  });

  it("stays quiet while the buyer's own checkout is still running", async () => {
    const { subscribeReservationAwaitsBuyer } = await import("../api/relayer");
    expect(subscribeReservationAwaitsBuyer(created, undefined, at(1))).toBe(false);
  });

  it("asks the buyer once the order is unpaid and nothing is in flight", async () => {
    const { subscribeReservationAwaitsBuyer } = await import("../api/relayer");
    expect(subscribeReservationAwaitsBuyer(created, undefined, at(3))).toBe(true);
    expect(subscribeReservationAwaitsBuyer(created, probe({ status: "failed" }), at(3))).toBe(true);
  });

  it("never asks when JC was already collected or the order is confirmed", async () => {
    const { subscribeReservationAwaitsBuyer } = await import("../api/relayer");
    expect(subscribeReservationAwaitsBuyer(created, probe({ payload: { jcToVaultTx: "0xabc" } }), at(30))).toBe(false);
    expect(subscribeReservationAwaitsBuyer(created, probe({ status: "confirmed" }), at(30))).toBe(false);
  });

  it("waits while a settlement attempt is still in flight", async () => {
    const { subscribeReservationAwaitsBuyer } = await import("../api/relayer");
    const updated = new Date(at(4)).toISOString();
    expect(subscribeReservationAwaitsBuyer(created, probe({ status: "pending", updated_at: updated }), at(5))).toBe(false);
    expect(subscribeReservationAwaitsBuyer(created, probe({ status: "pending", updated_at: updated }), at(15))).toBe(true);
  });
});

describe("subscription settlement simulation", () => {
  it("replays today's incident: a new order no longer starves the stuck 0.3 JC order", async () => {
    const chain = new SimulatedJc(10n * UNIT);
    const pending: PendingJcReservation[] = [];
    chain.approve(toUnits(requiredJcAllowance(0.3, pending).totalJc));
    pending.push({ request_key: "stuck", action: "subscribe", jc_amount: 0.3 });
    // 後端讀到落後節點（額度 0）並等待，這次會等到同步而收款成功；
    // 即使當下失敗，下一筆 0.1 訂單也必須授權 0.4，舊單仍有 0.3 可收。
    const { totalJc } = requiredJcAllowance(0.1, pending);
    expect(totalJc).toBe(0.4);
    if (chain.allowance < toUnits(totalJc)) chain.approve(toUnits(totalJc));
    chain.transferFrom(toUnits(0.1));
    expect(chain.allowance).toBe(toUnits(0.3));
    chain.transferFrom(toUnits(0.3));
    expect(chain.allowance).toBe(0n);
  });

  it("every reservation is eventually paid, never released, across 5,000 random order sequences", async () => {
    for (let seed = 1; seed <= 5_000; seed++) {
      const { reservations, chain, walletCompletions } = await runScenario(seed);
      const unpaid = reservations.filter((r) => !r.paid);
      expect(unpaid, `seed ${seed}`).toEqual([]);
      // 授權在下單時就已涵蓋所有未付預留，背景重試即可收款，不需要買方再補簽。
      expect(walletCompletions, `seed ${seed}: needed a manual re-sign`).toBe(0);
      const charged = reservations.reduce((sum, r) => sum + toUnits(r.jc), 0n);
      expect(chain.balance, `seed ${seed}: buyer charged exactly once per order`).toBe(1_000n * UNIT - charged);
    }
  });

  it("control: the old approve-this-order-only rule strands orders in the same simulation", async () => {
    let stranded = 0;
    for (let seed = 1; seed <= 5_000; seed++) {
      const { walletCompletions } = await runScenario(seed, "legacy");
      stranded += walletCompletions;
    }
    expect(stranded).toBeGreaterThan(0);
  });
});
