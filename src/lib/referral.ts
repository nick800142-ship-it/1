export const PENDING_REFERRAL_STORAGE_KEY = "rwmt-pending-referral-code";

const referralCodePattern = /^[A-Z0-9_-]{1,64}$/i;
type ReferralStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function normalizeReferralCode(value: string | null | undefined): string | null {
  const code = value?.trim() ?? "";
  return referralCodePattern.test(code) ? code : null;
}

export function captureReferralFromSearch(
  search: string,
  storage: ReferralStorage,
): string | null {
  const code = normalizeReferralCode(new URLSearchParams(search).get("ref"));
  if (!code) return null;

  try {
    storage.setItem(PENDING_REFERRAL_STORAGE_KEY, code);
  } catch {
    return null;
  }
  return code;
}

export function readPendingReferral(storage: ReferralStorage): string | null {
  try {
    return normalizeReferralCode(storage.getItem(PENDING_REFERRAL_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function clearPendingReferral(
  storage: ReferralStorage,
  expectedCode: string,
): void {
  try {
    if (storage.getItem(PENDING_REFERRAL_STORAGE_KEY) === expectedCode) {
      storage.removeItem(PENDING_REFERRAL_STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

export function buildReferralUrl(origin: string, promoCode: string): string {
  const code = normalizeReferralCode(promoCode);
  if (!code) throw new Error("Invalid referral code");

  const url = new URL("/register", origin);
  url.searchParams.set("ref", code);
  return url.toString();
}

export function isTerminalReferralError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("invalid referral code") ||
    normalized.includes("self referral is not allowed")
  );
}

export function isReferralAlreadyBoundError(message: string): boolean {
  return message.toLowerCase().includes("referral already bound");
}

export function referralErrorMessage(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("invalid referral code")) {
    return "這組推廣碼無效，請確認連結或推廣碼後再試。";
  }
  if (normalized.includes("self referral is not allowed")) {
    return "無法使用自己的推廣碼綁定帳號。";
  }
  return "目前無法完成推廣碼綁定，請檢查網路後重試。";
}
