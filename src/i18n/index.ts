import { useCallback } from "react";
import { getMessage, type Locale } from "./dictionaries";
import { useLanguage } from "@/platform";

export type { Locale } from "./dictionaries";
export { SUPPORTED_LOCALES, dictionaries, getMessage, isLocale } from "./dictionaries";

export function useTranslation() {
  const { language, setLanguage } = useLanguage();
  const t = useCallback((key: string, variables?: Record<string, string | number>) => getMessage(language as Locale, key, variables), [language]);
  return { t, language: language as Locale, setLanguage };
}
