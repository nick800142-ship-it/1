import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabase } from "@/lib/supabase";
import { disablePushSubscription, registerPushSubscription } from "@/lib/pushNotifications";
import { LANGUAGES, useLanguage, useTheme, type ColorMode, type Lang } from "@/platform";

export type AlertPreferences = {
  price: boolean;
  dividend: boolean;
  listings: boolean;
};

type UserPreferences = {
  language: Lang;
  color_mode: ColorMode;
  accent_hue: number;
  accent_saturation: number;
  accent_lightness: number;
  browser_push_enabled: boolean;
  price_alerts_enabled: boolean;
  dividend_alerts_enabled: boolean;
  listings_alerts_enabled: boolean;
};

type SaveStatus = "idle" | "saving" | "saved" | "error";

type PreferencesContextValue = {
  preferences: UserPreferences;
  ready: boolean;
  saveStatus: SaveStatus;
  setLanguagePreference: (language: Lang) => void;
  setThemePreference: (mode: ColorMode) => void;
  setAccentPreference: (hue: number, saturation: number, lightness: number) => void;
  setPushPreference: (enabled: boolean) => Promise<boolean>;
  setAlertPreference: (key: keyof AlertPreferences, enabled: boolean) => void;
};

const defaults: UserPreferences = {
  language: "zh-TW",
  color_mode: "dark",
  accent_hue: 43,
  accent_saturation: 96,
  accent_lightness: 56,
  browser_push_enabled: false,
  price_alerts_enabled: true,
  dividend_alerts_enabled: true,
  listings_alerts_enabled: false,
};

const PreferencesContext = createContext<PreferencesContextValue | null>(null);
const modes: ColorMode[] = ["dark", "light", "system"];
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));
const cacheKey = (userId: string) => `rwmt:user-preferences:${userId}`;

function normalize(value: Partial<UserPreferences> | null | undefined): UserPreferences {
  const language = LANGUAGES.some(([code]) => code === value?.language) ? value!.language! : defaults.language;
  const colorMode = modes.includes(value?.color_mode as ColorMode) ? value!.color_mode! : defaults.color_mode;
  return {
    language,
    color_mode: colorMode,
    accent_hue: clamp(Number(value?.accent_hue ?? defaults.accent_hue), 0, 360),
    accent_saturation: clamp(Number(value?.accent_saturation ?? defaults.accent_saturation), 20, 100),
    accent_lightness: clamp(Number(value?.accent_lightness ?? defaults.accent_lightness), 30, 75),
    browser_push_enabled: value?.browser_push_enabled ?? defaults.browser_push_enabled,
    price_alerts_enabled: value?.price_alerts_enabled ?? defaults.price_alerts_enabled,
    dividend_alerts_enabled: value?.dividend_alerts_enabled ?? defaults.dividend_alerts_enabled,
    listings_alerts_enabled: value?.listings_alerts_enabled ?? defaults.listings_alerts_enabled,
  };
}

function writeCache(userId: string, value: UserPreferences) {
  try {
    localStorage.setItem(cacheKey(userId), JSON.stringify(value));
  } catch {
    // Private mode / full storage on iOS Safari throws; preferences stay in memory.
  }
}

function readCache(userId: string) {
  try {
    const value = localStorage.getItem(cacheKey(userId));
    return value ? normalize(JSON.parse(value) as Partial<UserPreferences>) : defaults;
  } catch {
    return defaults;
  }
}

export function UserPreferencesProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const { setLanguage } = useLanguage();
  const { setMode, setColor } = useTheme();
  const [preferences, setPreferences] = useState<UserPreferences>(() => readCache(userId));
  const [ready, setReady] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const saveTimer = useRef<number | null>(null);
  const latest = useRef<UserPreferences>(preferences);

  const apply = useCallback((next: UserPreferences) => {
    setLanguage(next.language);
    setMode(next.color_mode);
    setColor(next.accent_hue, next.accent_saturation, next.accent_lightness);
  }, [setColor, setLanguage, setMode]);

  const persist = useCallback((next: UserPreferences) => {
    writeCache(userId, next);
    setSaveStatus("saving");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void supabase
        .from("user_preferences")
        .upsert({ user_id: userId, ...next }, { onConflict: "user_id" })
        .then(({ error }) => setSaveStatus(error ? "error" : "saved"));
    }, 450);
  }, [userId]);

  // Side effects must never run inside a state updater, so the next value is
  // derived from a ref and applied outside of React's render phase.
  const update = useCallback((patch: Partial<UserPreferences>) => {
    window.dispatchEvent(new Event("rwmt:preferences-changed"));
    const next = normalize({ ...latest.current, ...patch });
    latest.current = next;
    setPreferences(next);
    apply(next);
    persist(next);
  }, [apply, persist]);

  useEffect(() => {
    let active = true;
    let changedLocally = false;
    setReady(false);
    setSaveStatus("idle");
    const cached = readCache(userId);
    latest.current = cached;
    setPreferences(cached);
    apply(cached);
    const markChangedLocally = () => {
      changedLocally = true;
    };
    window.addEventListener("rwmt:preferences-changed", markChangedLocally);
    void supabase.from("user_preferences").select("*").eq("user_id", userId).maybeSingle().then(({ data, error }) => {
      if (!active) return;
      if (changedLocally) {
        setReady(true);
        return;
      }
      const next = data ? normalize(data as UserPreferences) : cached;
      latest.current = next;
      setPreferences(next);
      apply(next);
      writeCache(userId, next);
      if (!data && !error) persist(next);
      setReady(true);
      if (next.browser_push_enabled) {
        if ("Notification" in window && Notification.permission === "granted") {
          void registerPushSubscription(false).then((result) => {
            if (!result.ok) update({ browser_push_enabled: false });
          });
        } else {
          update({ browser_push_enabled: false });
        }
      } else {
        void disablePushSubscription();
      }
    });
    return () => {
      active = false;
      window.removeEventListener("rwmt:preferences-changed", markChangedLocally);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [apply, persist, update, userId]);

  const value = useMemo<PreferencesContextValue>(() => ({
    preferences,
    ready,
    saveStatus,
    setLanguagePreference: (language) => update({ language }),
    setThemePreference: (color_mode) => update({ color_mode }),
    setAccentPreference: (accent_hue, accent_saturation, accent_lightness) => update({ accent_hue, accent_saturation, accent_lightness }),
    setPushPreference: async (enabled) => {
      if (!enabled) {
        await disablePushSubscription();
        update({ browser_push_enabled: false });
        return false;
      }
      const result = await registerPushSubscription(true);
      update({ browser_push_enabled: result.ok });
      return result.ok;
    },
    setAlertPreference: (key, enabled) => update({ [`${key}_alerts_enabled`]: enabled }),
  }), [preferences, ready, saveStatus, update]);

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function useUserPreferences() {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error("UserPreferencesProvider missing");
  return value;
}
