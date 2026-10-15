/* eslint-disable react-refresh/only-export-components */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, Check, Copy, Download, ExternalLink, Share } from "lucide-react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type Platform = "ios" | "android" | "desktop";
type InAppBrowser = "line" | "facebook" | "instagram" | "wechat" | null;

const DISMISS_KEY = "rwmt-install-dismissed";

function detectStandalone(): boolean {
  if (typeof window === "undefined") return true;
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  const displayStandalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.matchMedia?.("(display-mode: fullscreen)").matches ||
    window.matchMedia?.("(display-mode: minimal-ui)").matches;
  const androidApp = document.referrer.startsWith("android-app://");
  return Boolean(iosStandalone || displayStandalone || androidApp);
}

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "desktop";
  const ua = navigator.userAgent || "";
  const isIOS =
    /iphone|ipad|ipod/i.test(ua) ||
    // iPadOS 13+ reports as MacIntel with touch support.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isIOS) return "ios";
  if (/android/i.test(ua)) return "android";
  return "desktop";
}

function detectInAppBrowser(): InAppBrowser {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent || "";
  if (/\bLine\//i.test(ua)) return "line";
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return "facebook";
  if (/Instagram/i.test(ua)) return "instagram";
  if (/MicroMessenger/i.test(ua)) return "wechat";
  return null;
}

/**
 * True while the site is opened in a mobile browser tab (not yet installed to
 * the home screen). Re-evaluates when the display-mode media query flips, e.g.
 * right after the user installs and relaunches.
 */
export function useShouldShowInstallGuide(): boolean {
  const [standalone, setStandalone] = useState(detectStandalone);
  const [dismissed, setDismissed] = useState(() => {
    if (typeof sessionStorage === "undefined") return false;
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  });

  useEffect(() => {
    const query = window.matchMedia("(display-mode: standalone)");
    const update = () => setStandalone(detectStandalone());
    query.addEventListener?.("change", update);
    window.addEventListener("visibilitychange", update);
    return () => {
      query.removeEventListener?.("change", update);
      window.removeEventListener("visibilitychange", update);
    };
  }, []);

  useEffect(() => {
    const onDismiss = () => setDismissed(true);
    window.addEventListener("install-guide-dismissed", onDismiss);
    return () => window.removeEventListener("install-guide-dismissed", onDismiss);
  }, []);

  const platform = useMemo(detectPlatform, []);
  // Only take over the screen on phones/tablets — "add to home screen" is a
  // mobile concept, and blocking desktop users would be pointless.
  if (platform === "desktop") return false;
  return !standalone && !dismissed;
}

export function InstallGuide() {
  const platform = useMemo(detectPlatform, []);
  const inApp = useMemo(detectInAppBrowser, []);
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(
    () => ((window as unknown as { __deferredInstallPrompt?: InstallPromptEvent }).__deferredInstallPrompt ?? null),
  );
  const [installing, setInstalling] = useState(false);
  const [copied, setCopied] = useState(false);
  const [promptFailed, setPromptFailed] = useState(false);

  useEffect(() => {
    const pickUp = () => {
      const stashed = (window as unknown as { __deferredInstallPrompt?: InstallPromptEvent }).__deferredInstallPrompt;
      if (stashed) setPrompt(stashed);
    };
    window.addEventListener("install-prompt-ready", pickUp);
    return () => window.removeEventListener("install-prompt-ready", pickUp);
  }, []);

  const triggerInstall = useCallback(async () => {
    const current = prompt ?? (window as unknown as { __deferredInstallPrompt?: InstallPromptEvent }).__deferredInstallPrompt;
    if (!current) {
      setPromptFailed(true);
      return;
    }
    setInstalling(true);
    try {
      await current.prompt();
      await current.userChoice;
    } catch {
      setPromptFailed(true);
    } finally {
      setInstalling(false);
      (window as unknown as { __deferredInstallPrompt?: InstallPromptEvent }).__deferredInstallPrompt = undefined;
      setPrompt(null);
    }
  }, [prompt]);

  // Android / Chromium: open the native install sheet directly, as soon as the
  // deferred prompt is available — no tutorial. If the browser rejects the
  // programmatic call (needs a gesture / already dismissed), fall back to the
  // big button below.
  useEffect(() => {
    if (platform !== "android" || inApp) return;
    if (!prompt) return;
    let cancelled = false;
    (async () => {
      setInstalling(true);
      try {
        await prompt.prompt();
        await prompt.userChoice;
      } catch {
        if (!cancelled) setPromptFailed(true);
      } finally {
        if (!cancelled) {
          setInstalling(false);
          (window as unknown as { __deferredInstallPrompt?: InstallPromptEvent }).__deferredInstallPrompt = undefined;
          setPrompt(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Fire once when the prompt first becomes available.
  }, [prompt, platform, inApp]);

  const copyUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — user can copy from the address bar manually */
    }
  }, []);

  const continueInBrowser = useCallback(() => {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* sessionStorage unavailable — dismissing for this render is enough */
    }
    window.dispatchEvent(new Event("install-guide-dismissed"));
  }, []);

  // In-app browsers (LINE / FB / IG / WeChat) can't add to the home screen at
  // all — the only path is to reopen in the system browser.
  if (inApp) {
    return (
      <Shell>
        <p className="mt-5 text-2xl font-bold tracking-tight text-amber-400">請用瀏覽器開啟</p>
        <p className="mt-3 text-sm leading-relaxed text-slate-400">
          您目前在
          {inApp === "line" ? " LINE " : inApp === "facebook" ? " Facebook " : inApp === "instagram" ? " Instagram " : " 微信 "}
          內建瀏覽器中，無法加入主畫面。請點右上角選單，選擇「用
          {platform === "ios" ? "Safari" : "系統瀏覽器"}開啟」後再試一次。
        </p>
        <button
          type="button"
          onClick={copyUrl}
          className="mt-8 flex w-full items-center justify-center gap-2 rounded-2xl border border-slate-700 bg-slate-800 px-4 py-4 text-base font-semibold text-slate-100 transition active:scale-[0.98]"
        >
          {copied ? <Check className="h-5 w-5 text-emerald-400" /> : <Copy className="h-5 w-5" />}
          {copied ? "已複製網址" : "複製網址"}
        </button>
        <DismissLink onClick={continueInBrowser} />
      </Shell>
    );
  }

  // iOS Safari: there is no API to open the native "Add to Home Screen" sheet.
  // Keep it to a single direct call-to-action + an arrow pointing at the Share
  // button (bottom toolbar on iPhone) — no numbered tutorial.
  if (platform === "ios") {
    return (
      <Shell>
        <p className="mt-5 text-2xl font-bold tracking-tight text-amber-400">加入主畫面</p>
        <p className="mt-3 text-sm leading-relaxed text-slate-400">
          點下方工具列的分享按鈕，選擇「加入主畫面」即可完成。
        </p>
        <div className="mt-8 flex w-full flex-col items-center gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 px-5 py-6">
          <div className="flex items-center gap-3 text-base font-semibold text-slate-100">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-sky-500/15 text-sky-400">
              <Share className="h-5 w-5" />
            </span>
            <span>
              點<span className="text-sky-400">分享</span> → 加入主畫面
            </span>
          </div>
        </div>
        <div className="mt-6 flex flex-col items-center text-sky-400">
          <span className="text-xs font-medium text-slate-500">分享按鈕在畫面最下方</span>
          <ArrowDown className="mt-2 h-7 w-7 animate-bounce" />
        </div>
        <DismissLink onClick={continueInBrowser} />
      </Shell>
    );
  }

  // Android / Chromium.
  return (
    <Shell>
      <p className="mt-5 text-2xl font-bold tracking-tight text-amber-400">加入主畫面</p>
      <p className="mt-3 text-sm leading-relaxed text-slate-400">
        {installing ? "正在開啟安裝視窗…" : "點下方按鈕，依系統提示即可加入主畫面。"}
      </p>
      <button
        type="button"
        onClick={triggerInstall}
        disabled={installing}
        className="mt-8 flex w-full items-center justify-center gap-2 rounded-2xl bg-amber-500 px-4 py-4 text-base font-bold text-slate-950 transition active:scale-[0.98] disabled:opacity-60"
      >
        <Download className="h-5 w-5" />
        {installing ? "開啟中…" : "加入主畫面"}
      </button>
      {promptFailed ? (
        <p className="mt-4 text-center text-xs leading-relaxed text-slate-500">
          若沒有跳出安裝視窗，請點瀏覽器右上角選單，選擇「安裝應用程式 / 加入主畫面」。
        </p>
      ) : null}
      <DismissLink onClick={continueInBrowser} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[100] flex flex-col overflow-y-auto bg-slate-950 text-slate-100">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-10">
        <div className="flex flex-col items-center text-center">
          <img
            src="/pwa-192x192.png"
            alt="RWMT"
            className="h-20 w-20 rounded-2xl border border-slate-800 shadow-2xl shadow-amber-500/10"
          />
          {children}
        </div>
      </div>
    </div>
  );
}

function DismissLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-8 flex items-center gap-1.5 text-xs font-medium text-slate-500 transition hover:text-slate-300"
    >
      <ExternalLink className="h-3.5 w-3.5" />
      先在瀏覽器繼續使用
    </button>
  );
}
