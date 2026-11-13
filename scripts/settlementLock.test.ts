import { describe, expect, it } from "vitest";
import {
  isSettlementReclaimable,
  SETTLEMENT_ABANDONED_MS,
  settlementOwnership,
} from "../api/_settlementClaim";

// 以模型重播 api/relayer.ts 的認購交割鎖：同樣的條件更新、同樣的步驟順序，在任意交錯、
// 任意時間點中斷（含「已廣播、尚未存 hash」）、時間跳躍下，驗證資金安全與最終一定能完成。

type Row = { status: string; error: string | null; payload: Record<string, unknown>; updated_at: string };
type Reservation = "pending" | "released" | "confirmed";

const AMOUNT = 5;
const FUNCTION_LIMIT_MS = 60_000;

class World {
  now = Date.parse("2026-11-13T00:00:00Z");
  reservation: Reservation = "pending";
  row: Row | null = null;
  allowance = 0;
  balance = AMOUNT * 3;
  chainTx: { hash: string; kind: "collect" | "deliver" }[] = [];
  collected = 0;
  delivered = 0;
  violations: string[] = [];
  private seq = 0;
  hash() { return `0x${(++this.seq).toString(16)}`; }
  iso() { return new Date(this.now).toISOString(); }
  check() {
    if (this.collected > 1) this.violations.push("JC 被重複收取");
    if (this.delivered > 1) this.violations.push("標的被重複發放");
    if (this.reservation === "released" && (this.collected > 0 || this.delivered > 0)) {
      this.violations.push("已取消的訂單仍被收款或發放");
    }
    if (this.reservation === "confirmed" && (this.collected !== 1 || this.delivered !== 1)) {
      this.violations.push("正式入帳但未收款或未發放");
    }
  }
}

type Rules = { legacy: boolean };

function ownership(world: World, row: Row, rules: Rules) {
  if (rules.legacy) {
    if (row.status === "confirmed") return "confirmed";
    return row.status === "failed" ? "failed" : "in_flight";
  }
  return settlementOwnership(row, world.now);
}

function touched(row: Row | null) {
  if (!row) return false;
  return row.status === "confirmed" || ["jcToVaultTx", "assetTransferTx"].some((k) => typeof row.payload[k] === "string");
}

// 與 takeSettlementOwnership 相同的條件更新（單一原子步驟）。
function take(world: World, seen: Row, rules: Rules): boolean {
  const row = world.row;
  if (!row) return false;
  const kind = ownership(world, seen, rules);
  if (!isSettlementReclaimable(kind as never)) return false;
  const matches = kind === "failed"
    ? row.status === "failed"
    : kind === "parked"
      ? row.status === "pending" && row.error === seen.error
      : row.status === "pending" && row.error === null && Date.parse(row.updated_at) < world.now - SETTLEMENT_ABANDONED_MS;
  if (!matches) return false;
  const previousFailure = seen.error ?? (kind === "abandoned" ? "timeout" : "unknown");
  world.row = { status: "pending", error: null, payload: { ...row.payload, previousFailure }, updated_at: world.iso() };
  return true;
}

function finish(world: World, patch: { status: string; error?: string | null }) {
  if (!world.row) return;
  if (patch.status !== "confirmed" && world.row.status === "confirmed") return;
  world.row = { ...world.row, status: patch.status, error: patch.error ?? (patch.status === "confirmed" ? null : world.row.error), updated_at: world.iso() };
}

function merge(world: World, patch: Record<string, unknown>) {
  if (!world.row) throw new Error("no row");
  world.row = { ...world.row, payload: { ...world.row.payload, ...patch }, updated_at: world.iso() };
}

type Actor = Generator<void, void, void>;

function* settle(world: World, rules: Rules): Actor {
  if (world.reservation !== "pending") return;
  yield;
  const seen = world.row ? { ...world.row, payload: { ...world.row.payload } } : null;
  yield;
  if (!seen) {
    if (world.row) return; // unique(ref_key)
    world.row = { status: "pending", error: null, payload: {}, updated_at: world.iso() };
  } else {
    if (ownership(world, seen, rules) === "cancelled") return;
    if (!take(world, seen, rules)) return;
  }
  yield;
  if (!rules.legacy) {
    if (world.reservation === "confirmed") { finish(world, { status: "confirmed" }); return; }
    if (world.reservation !== "pending") { finish(world, { status: "failed", error: "cancelled" }); return; }
    yield;
  }
  try {
    for (const [key, kind] of [["jcToVaultTx", "collect"], ["assetTransferTx", "deliver"]] as const) {
      const payload = world.row!.payload;
      if (typeof payload[key] === "string") continue;
      if (!rules.legacy && typeof payload.previousFailure === "string") {
        const found = world.chainTx.find((tx) => tx.kind === kind);
        yield;
        if (found) { merge(world, { [key]: found.hash }); yield; continue; }
      }
      if (kind === "collect" && (world.allowance < AMOUNT || world.balance < AMOUNT)) throw new Error("insufficient allowance");
      yield;
      if (kind === "collect") {
        if (world.allowance < AMOUNT || world.balance < AMOUNT) throw new Error("transferFrom reverted");
        world.allowance -= AMOUNT;
        world.balance -= AMOUNT;
        world.collected += 1;
      } else {
        world.delivered += 1;
      }
      const hash = world.hash();
      world.chainTx.push({ hash, kind });
      world.check();
      yield; // 已廣播、hash 尚未保存：中斷點
      merge(world, { [key]: hash });
      yield;
    }
    if (world.reservation !== "pending") throw new Error("finalize: reservation not pending");
    world.reservation = "confirmed";
    world.check();
    yield;
    finish(world, { status: "confirmed" });
  } catch (error) {
    finish(world, { status: "pending", error: (error as Error).message });
  }
}

function* cancel(world: World, rules: Rules): Actor {
  if (world.reservation !== "pending") return;
  yield;
  const seen = world.row ? { ...world.row, payload: { ...world.row.payload } } : null;
  yield;
  if (rules.legacy) {
    if (touched(seen)) return;
    if (seen?.status === "pending" && world.now - Date.parse(seen.updated_at) < SETTLEMENT_ABANDONED_MS) return;
    if (world.reservation !== "pending") return;
    world.reservation = "released";
    world.check();
    yield;
    if (world.row) world.row = { ...world.row, status: "failed", error: "cancelled" };
    return;
  }
  if (!seen) {
    if (world.row) return;
    world.row = { status: "pending", error: null, payload: { cancelling: true }, updated_at: world.iso() };
  } else {
    if (seen.status === "confirmed" || touched(seen)) return;
    if (settlementOwnership(seen, world.now) !== "cancelled" && !take(world, seen, rules)) return;
  }
  yield;
  if (touched(world.row)) { finish(world, { status: "failed", error: "cancel aborted" }); return; }
  yield;
  if (seen) {
    // 與 findUnrecordedSubscribeChainStep 相同：先前請求可能已廣播卻沒存 hash。
    const unrecorded = world.chainTx.find((tx) => tx.kind === "collect") ?? world.chainTx.find((tx) => tx.kind === "deliver");
    if (unrecorded) {
      merge(world, { [unrecorded.kind === "collect" ? "jcToVaultTx" : "assetTransferTx"]: unrecorded.hash });
      finish(world, { status: "failed", error: "cancel aborted" });
      return;
    }
    yield;
  }
  if (world.reservation !== "pending") { finish(world, { status: "failed", error: "cancel aborted" }); return; }
  world.reservation = "released";
  world.check();
  yield;
  world.row = { ...world.row!, status: "failed", error: "cancelled", payload: { ...world.row!.payload, cancelled: true }, updated_at: world.iso() };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runSchedule(seed: number, rules: Rules) {
  const random = rng(seed);
  const world = new World();
  world.allowance = random() < 0.5 ? 0 : AMOUNT * (random() < 0.5 ? 1 : 2);
  const live: { gen: Actor; deadline: number }[] = [];
  let budget = 6 + Math.floor(random() * 6);
  for (let step = 0; step < 400 && (budget > 0 || live.length); step++) {
    const r = random();
    if (r < 0.2 && budget > 0) {
      budget -= 1;
      const pick = random();
      if (pick < 0.15) world.allowance = AMOUNT * (random() < 0.5 ? 1 : 2); // 買方補授權
      else live.push({ gen: pick < 0.65 ? settle(world, rules) : cancel(world, rules), deadline: world.now + FUNCTION_LIMIT_MS });
    } else if (r < 0.3) {
      world.now += [1_000, 30_000, 11 * 60_000][Math.floor(random() * 3)];
    } else if (live.length) {
      const index = Math.floor(random() * live.length);
      const actor = live[index];
      const killed = world.now > actor.deadline || random() < 0.04;
      if (killed || actor.gen.next().done) live.splice(index, 1);
    }
    world.check();
  }
  // 中斷的請求一定已結束（超過 60 秒）；買方完成授權後按「完成交割」，必須一定能完成或維持已取消。
  const cancelledEarlier = world.reservation === "released";
  world.now += SETTLEMENT_ABANDONED_MS + 1;
  world.allowance = Math.max(world.allowance, AMOUNT);
  world.balance = Math.max(world.balance, AMOUNT);
  for (let attempt = 0; attempt < 2 && world.reservation === "pending"; attempt++) {
    const gen = settle(world, rules);
    while (!gen.next().done) { /* run to completion */ }
  }
  world.check();
  if (world.reservation === "pending") world.violations.push("買方已完成授權，訂單仍無法交割");
  if (world.reservation === "released" && !cancelledEarlier) world.violations.push("未取消卻被釋出");
  return world;
}

describe("settlementOwnership", () => {
  const now = Date.parse("2026-11-13T01:00:00Z");
  const base = { error: null, payload: {}, updated_at: new Date(now - 1_000).toISOString() };
  it("classifies lock states", () => {
    expect(settlementOwnership({ ...base, status: "pending" }, now)).toBe("in_flight");
    expect(settlementOwnership({ ...base, status: "pending", error: "x" }, now)).toBe("parked");
    expect(settlementOwnership({ ...base, status: "failed" }, now)).toBe("failed");
    expect(settlementOwnership({ ...base, status: "confirmed" }, now)).toBe("confirmed");
    expect(settlementOwnership({ ...base, status: "failed", payload: { cancelled: true } }, now)).toBe("cancelled");
    expect(settlementOwnership({ ...base, status: "pending", updated_at: new Date(now - SETTLEMENT_ABANDONED_MS).toISOString() }, now)).toBe("abandoned");
  });
  it("abandoned threshold outlives the 60s function limit", () => {
    expect(SETTLEMENT_ABANDONED_MS).toBeGreaterThan(FUNCTION_LIMIT_MS * 5);
  });
});

describe("subscription settlement lock (model check)", () => {
  const SCHEDULES = Number(process.env.LOCK_SCHEDULES ?? 20_000);

  it(`holds every safety and liveness guarantee across ${SCHEDULES} random schedules`, () => {
    const failures: string[] = [];
    let confirmed = 0;
    let released = 0;
    for (let seed = 1; seed <= SCHEDULES; seed++) {
      const world = runSchedule(seed, { legacy: false });
      if (world.reservation === "confirmed") confirmed += 1;
      if (world.reservation === "released") released += 1;
      if (world.violations.length) failures.push(`seed ${seed}: ${[...new Set(world.violations)].join("、")}`);
    }
    expect(failures.slice(0, 5)).toEqual([]);
    // 確認測試真的覆蓋到「完成」與「取消」兩種結局。
    expect(confirmed).toBeGreaterThan(SCHEDULES * 0.2);
    expect(released).toBeGreaterThan(SCHEDULES * 0.05);
  });

  it("control: the previous rules are caught by the same checks", () => {
    const kinds = new Set<string>();
    for (let seed = 1; seed <= SCHEDULES; seed++) {
      for (const violation of runSchedule(seed, { legacy: true }).violations) kinds.add(violation);
    }
    expect(kinds.has("買方已完成授權，訂單仍無法交割")).toBe(true);
    expect([...kinds].some((kind) => kind === "已取消的訂單仍被收款或發放" || kind === "JC 被重複收取")).toBe(true);
  });
});
