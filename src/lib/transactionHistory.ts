// All dashboards/history views start at the new contracts launch; earlier ledger rows remain for audit.
export const NEW_CONTRACTS_LAUNCHED_AT = "2026-10-04T03:57:00.000Z";
export const CONTRACT_INFO_VISIBLE_AFTER = NEW_CONTRACTS_LAUNCHED_AT;

export function isContractInfoVisible(updatedAt: string | null | undefined): boolean {
  const timestamp = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  return Number.isFinite(timestamp) && timestamp >= Date.parse(CONTRACT_INFO_VISIBLE_AFTER);
}

export const TRANSACTION_HISTORY_START_AT = NEW_CONTRACTS_LAUNCHED_AT;
export const TRANSACTION_HISTORY_START_LABEL = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
}).format(new Date(TRANSACTION_HISTORY_START_AT));

export function isTransactionHistoryVisible(createdAt: string): boolean {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && timestamp >= Date.parse(TRANSACTION_HISTORY_START_AT);
}

export const USER_TRANSACTION_ENTRY_TYPES: string[] = [
  "private_purchase",
  "secondary_buy",
  "secondary_sell",
  "p2p_buy",
  "p2p_sell",
  "p2p_listing_fee",
  "refund",
  "vault_buy",
  "admin_payout",
  "vault_redeem",
  "redemption_pending",
  "redemption_refund",
  "town_bomb",
];

const userTransactionEntryTypeSet = new Set(USER_TRANSACTION_ENTRY_TYPES);

export function isUserTransactionEntry(entryType: string): boolean {
  return userTransactionEntryTypeSet.has(entryType);
}
