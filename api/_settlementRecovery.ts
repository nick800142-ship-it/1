export type ReservationReference = {
  request_key: string;
  action: string;
  status: string;
};

export type PurchaseLedgerReference = {
  id: string;
  idempotency_key?: string | null;
};

export function indexReservationsByRequestKey<T extends ReservationReference>(
  reservations: readonly T[],
) {
  return new Map(reservations.map((reservation) => [reservation.request_key, reservation]));
}

export function requestKeyForLedgerRow(
  ledgerRow: PurchaseLedgerReference,
  action: "subscribe" | "vault_buy",
): string | null {
  const key = ledgerRow.idempotency_key;
  if (!key) return null;
  return action === "vault_buy" ? key.replace(/:jc$/, "") : key;
}

export function reservationForLedgerRow<T extends ReservationReference>(
  ledgerRow: PurchaseLedgerReference,
  action: "subscribe" | "vault_buy",
  reservationsByRequestKey: ReadonlyMap<string, T>,
): T | null {
  const requestKey = requestKeyForLedgerRow(ledgerRow, action);
  if (!requestKey) return null;
  const reservation = reservationsByRequestKey.get(requestKey);
  return reservation?.action === action ? reservation : null;
}

export function isReservationBackedLedgerRow<T extends ReservationReference>(
  ledgerRow: PurchaseLedgerReference,
  action: "subscribe" | "vault_buy",
  reservationsByRequestKey: ReadonlyMap<string, T>,
): boolean {
  return reservationForLedgerRow(ledgerRow, action, reservationsByRequestKey) !== null;
}

export function isReservationBackedLegacySettlement<T extends ReservationReference>(
  refKey: string,
  expectedAction: "subscribe" | "vault_buy",
  ledgerRowsById: ReadonlyMap<string, PurchaseLedgerReference>,
  reservationsByRequestKey: ReadonlyMap<string, T>,
): boolean {
  const prefix = `${expectedAction === "subscribe" ? "subscribe" : "mint_jc"}:`;
  if (!refKey.startsWith(prefix)) return false;
  const ledgerRow = ledgerRowsById.get(refKey.slice(prefix.length));
  return ledgerRow ? isReservationBackedLedgerRow(ledgerRow, expectedAction, reservationsByRequestKey) : false;
}
