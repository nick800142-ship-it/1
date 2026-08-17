import { supabase } from "@/lib/supabase";
import type { Lang } from "@/platform";

type AssetFields = { name: string; location: string; information: string };
type AnnouncementFields = { title: string; content: string };
const requiredLanguages: Lang[] = [
  "zh-TW", "zh-CN", "en", "ja", "ko", "th", "vi", "id",
  "ms", "es", "fr", "de", "pt", "ru", "ar", "hi",
];

export async function translateAdminContent<T extends AssetFields | AnnouncementFields>(kind: "asset" | "announcement", fields: T) {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error("登入已過期，請重新登入");
  const response = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` },
    body: JSON.stringify({ kind, fields }),
  });
  const result = (await response.json().catch(() => null)) as { translations?: Record<Lang, T>; error?: string } | null;
  if (!response.ok || !result?.translations) throw new Error(result?.error || "自動翻譯失敗，請稍後再試");
  const fieldNames = Object.keys(fields) as (keyof T)[];
  const complete = requiredLanguages.every((language) =>
    fieldNames.every((field) => {
      const sourceValue = fields[field]?.trim();
      const translated = result.translations?.[language]?.[field]?.trim();
      return (!sourceValue || Boolean(translated)) && !translated?.includes("�");
    }),
  );
  if (!complete) throw new Error("翻譯內容不完整或含有無法辨識的字元，尚未儲存，請稍後再試");
  return result.translations;
}
