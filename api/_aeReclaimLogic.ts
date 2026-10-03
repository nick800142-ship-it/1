export const LEGACY_AE_RECLAIM_CUTOFF = "2026-10-04T00:00:00+08:00";

export type LegacyAeLedgerEntry = {
  entry_type: string;
  quantity: number | string | null;
  created_at: string;
};

const COUNTED_ENTRY_TYPES = new Set(["private_purchase", "p2p_buy", "p2p_sell"]);
const CUTOFF_TIME = new Date(LEGACY_AE_RECLAIM_CUTOFF).getTime();

export function netLegacyAeAmount(entries: LegacyAeLedgerEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    if (!COUNTED_ENTRY_TYPES.has(entry.entry_type)) continue;
    const createdAt = Date.parse(entry.created_at);
    if (!Number.isFinite(createdAt) || createdAt >= CUTOFF_TIME) continue;
    const quantity = Number(entry.quantity);
    if (Number.isFinite(quantity)) total += quantity;
  }
  return Math.max(0, Math.round(total * 1_000_000) / 1_000_000);
}

export function capLegacyAeAmount(
  ledgerNet: number,
  onChainBalance: number,
  previousClaimLimit = Number.POSITIVE_INFINITY,
): number {
  const values = [ledgerNet, onChainBalance, previousClaimLimit];
  if (values.some((value) => !Number.isFinite(value) && value !== Number.POSITIVE_INFINITY)) return 0;
  const amount = Math.min(...values);
  if (!(amount > 0)) return 0;
  return Math.floor((amount + Number.EPSILON) * 1_000_000) / 1_000_000;
}

export function formatAeAmount(amount: number): string {
  if (!(amount > 0) || !Number.isFinite(amount)) return "0";
  return amount.toFixed(6).replace(/\.?0+$/, "");
}

export function parseAeAmount(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 1_000_000) / 1_000_000 : 0;
}

export function minUnits(...amounts: bigint[]): bigint {
  return amounts.reduce((current, amount) => (amount < current ? amount : current));
}

export function maxUnits(...amounts: bigint[]): bigint {
  return amounts.reduce((current, amount) => (amount > current ? amount : current));
}

export function capUnits(ledgerUnits: bigint, balanceUnits: bigint, previousClaimUnits?: bigint): bigint {
  const candidates = previousClaimUnits == null
    ? [ledgerUnits, balanceUnits]
    : [ledgerUnits, balanceUnits, previousClaimUnits];
  return maxUnits(0n, minUnits(...candidates));
}

export function aeUnitsToAmount(units: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const scaled = units / (divisor / 1_000_000n);
  const whole = scaled / 1_000_000n;
  const fraction = String(scaled % 1_000_000n).padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function amountToAeUnits(amount: number, decimals: number): bigint {
  const canonical = formatAeAmount(amount);
  return BigInt(Math.round(Number(canonical) * 1_000_000)) * (10n ** BigInt(decimals - 6));
}

export function isAeAmountAllowed(amount: string): boolean {
  return /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(amount) && Number(amount) > 0;
}

export function parseAeAmountToUnits(amount: string, decimals: number): bigint {
  const [whole, fraction = ""] = amount.split(".");
  const padded = fraction.padEnd(decimals, "0");
  if (padded.length > decimals) throw new Error("AE 數量超出代幣支援的小數位數");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

export function formatUnitsToAeAmount(units: bigint, decimals: number): string {
  const whole = units / 10n ** BigInt(decimals);
  const fraction = String(units % 10n ** BigInt(decimals)).padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function toAeUnitsFromLedgerAmount(amount: number, decimals: number): bigint {
  if (!(amount > 0) || !Number.isFinite(amount)) return 0n;
  const scaled = BigInt(Math.round(amount * 1_000_000));
  return scaled * 10n ** BigInt(decimals - 6);
}

export function formatUnitsForAeApi(units: bigint, decimals: number): string {
  const whole = units / 10n ** BigInt(decimals);
  const fraction = String(units % 10n ** BigInt(decimals)).padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function normalizedLedgerAeAmount(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 1_000_000) / 1_000_000;
}

export function amountToUnits(amount: string, decimals: number): bigint {
  if (!isAeAmountAllowed(amount) || decimals < 6) throw new Error("AE 回收數量無效");
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0"));
}

export function unitsToAmount(units: bigint, decimals: number): string {
  const whole = units / 10n ** BigInt(decimals);
  const fraction = String(units % 10n ** BigInt(decimals)).padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function minAeUnits(ledgerUnits: bigint, balanceUnits: bigint): bigint {
  return ledgerUnits < balanceUnits ? ledgerUnits : balanceUnits;
}

export function capAeUnits(ledgerUnits: bigint, balanceUnits: bigint, priorLimitUnits?: bigint): bigint {
  let cap = minAeUnits(ledgerUnits, balanceUnits);
  if (priorLimitUnits != null && priorLimitUnits < cap) cap = priorLimitUnits;
  return cap > 0n ? cap : 0n;
}

export function validAeReclaimQuantity(quantity: number): boolean {
  return Number.isFinite(quantity) && quantity > 0 && quantity <= 1_000_000_000;
}

export function numberToAeLedgerString(quantity: number): string {
  return formatAeAmount(Math.round(quantity * 1_000_000) / 1_000_000);
}

export function aeAmountToUnits(amount: number, decimals: number): bigint {
  const scaled = BigInt(Math.round(amount * 1_000_000));
  return scaled * 10n ** BigInt(decimals - 6);
}

export function aeUnitsToDecimal(units: bigint, decimals: number): string {
  const whole = units / 10n ** BigInt(decimals);
  const remainder = units % 10n ** BigInt(decimals);
  const fraction = String(remainder).padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
  return fraction.length ? `${whole}.${fraction}` : String(whole);
}

export function safeAeUnits(amount: string, decimals: number): bigint {
  if (!isAeAmountAllowed(amount) || decimals < 6) return 0n;
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0"));
}

export function capAeReclaim(ledgerNet: number, balance: number, priorLimit = Number.POSITIVE_INFINITY): number {
  if (![ledgerNet, balance].every(Number.isFinite)) return 0;
  const limit = Math.min(ledgerNet, balance, priorLimit);
  return limit > 0 ? Math.floor((limit + 1e-9) * 1_000_000) / 1_000_000 : 0;
}

export function toAeDisplayAmount(amount: string | number): string {
  const value = typeof amount === "number" ? amount : Number(amount);
  return Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 6 }) : "0";
}
