export function stripNumberGrouping(value: string | number | null | undefined) {
  return String(value ?? "").replace(/,/g, "");
}

export function formatNumberInput(value: string | number | null | undefined) {
  const raw = stripNumberGrouping(value).replace(/[^\d.-]/g, "");
  if (!raw) return "";

  const negative = raw.startsWith("-");
  const unsigned = raw.replace(/-/g, "");
  const decimalIndex = unsigned.indexOf(".");
  const integerRaw = decimalIndex >= 0 ? unsigned.slice(0, decimalIndex) : unsigned;
  const fraction = decimalIndex >= 0 ? unsigned.slice(decimalIndex + 1).replace(/\./g, "") : "";
  const integer = integerRaw.replace(/^0+(?=\d)/, "") || "0";
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const decimal = decimalIndex >= 0 ? `.${fraction}` : "";
  return `${negative ? "-" : ""}${grouped}${decimal}`;
}

export function parseFormattedNumber(value: string | number | null | undefined) {
  const parsed = Number(stripNumberGrouping(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatQuantity(value: string | number | null | undefined, maximumFractionDigits = 20) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "0";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(parsed);
}
