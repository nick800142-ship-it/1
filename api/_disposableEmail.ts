import { isDisposableEmailDomain } from "disposable-email-domains-js";

export const DISPOSABLE_EMAIL_ERROR = "不接受一次性（臨時）電子郵件，請改用常用信箱（例如 Gmail）登入。";

/**
 * Checks the email's domain and each parent domain (mx.tempmail.com → tempmail.com)
 * against a weekly-updated disposable-domain list.
 */
export function isDisposableEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  const labels = domain.split(".").filter(Boolean);
  for (let start = 0; start < labels.length - 1; start += 1) {
    if (isDisposableEmailDomain(labels.slice(start).join("."))) return true;
  }
  return false;
}
