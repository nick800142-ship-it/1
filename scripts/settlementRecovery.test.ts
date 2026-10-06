import { describe, expect, it } from "vitest";
import {
  indexReservationsByRequestKey,
  isReservationBackedLedgerRow,
  isReservationBackedLegacySettlement,
  requestKeyForLedgerRow,
  reservationForLedgerRow,
} from "../api/_settlementRecovery";

const requestKey = "826e53d2-8be5-4f1f-bd66-9e28608e8c17";
const ledgerId = "4b1a3a5b-4d62-4a7e-99af-a4c1f2777bfb";
const reservation = { request_key: requestKey, action: "subscribe", status: "confirmed" };
const ledger = { id: ledgerId, idempotency_key: requestKey };

describe("reservation-backed subscription recovery", () => {
  const reservations = indexReservationsByRequestKey([reservation]);

  it("matches a finalized ledger row through its idempotency key, not its ledger UUID", () => {
    expect(reservationForLedgerRow(ledger, "subscribe", reservations)).toEqual(reservation);
    expect(isReservationBackedLedgerRow(ledger, "subscribe", reservations)).toBe(true);
  });

  it("recognizes the legacy settlement key produced by a retry sweep", () => {
    const ledgerRowsById = new Map([[ledgerId, ledger]]);
    expect(isReservationBackedLegacySettlement(`subscribe:${ledgerId}`, "subscribe", ledgerRowsById, reservations)).toBe(true);
  });

  it("does not classify a true legacy purchase as reservation-backed", () => {
    const legacyLedger = { id: ledgerId, idempotency_key: "legacy-request" };
    expect(isReservationBackedLedgerRow(legacyLedger, "subscribe", reservations)).toBe(false);
    expect(isReservationBackedLegacySettlement(
      `subscribe:${ledgerId}`,
      "subscribe",
      new Map([[ledgerId, legacyLedger]]),
      reservations,
    )).toBe(false);
  });

  it("maps vault-buy ledger keys that carry the :jc suffix back to their reservation", () => {
    const vaultReservations = indexReservationsByRequestKey([
      { request_key: requestKey, action: "vault_buy", status: "confirmed" },
    ]);
    const vaultLedger = { id: ledgerId, idempotency_key: `${requestKey}:jc` };
    expect(requestKeyForLedgerRow(vaultLedger, "vault_buy")).toBe(requestKey);
    expect(isReservationBackedLedgerRow(vaultLedger, "vault_buy", vaultReservations)).toBe(true);
    expect(isReservationBackedLegacySettlement(
      `mint_jc:${ledgerId}`,
      "vault_buy",
      new Map([[ledgerId, vaultLedger]]),
      vaultReservations,
    )).toBe(true);
  });

  it("does not treat unrelated settlement keys as reservation matches", () => {
    expect(isReservationBackedLegacySettlement(
      `trade:${ledgerId}`,
      "subscribe",
      new Map([[ledgerId, ledger]]),
      reservations,
    )).toBe(false);
  });
});
