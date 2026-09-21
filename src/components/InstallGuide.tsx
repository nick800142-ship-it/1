import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  MoreVertical,
  Plus,
  Share,
  SquarePlus,
} from "lucide-react";

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

function Step({ index, children }: { index: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-xs font-bold text-amber-300">
        {index}
      </span>
      <span className="text-sm leading-relaxed text-slate-300">{children}</span>
    </li>
  );
}

function InlineIcon({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <span
      className="mx-0.5 inline-flex h-6 w-6 translate-y-1 items-center justify-center rounded-md border border-slate-700 bg-slate-800 text-slate-200"
      aria-label={label}
      role="img"
    >
      {children}
    </span>
  );
}

export function InstallGuide() {
  const platform = useMemo(detectPlatform, []);
  const inApp = useMemo(detectInAppBrowser, []);
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(
    () => ((window as unknown as { __deferredInstallPrompt?: InstallPromptEvent }).__deferredInstallPrompt ?? null),
  );
  const [installing, setInstalling] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const pickUp = () => {
      const stashed = (window as unknown as { __deferredInstallPrompt?: InstallPromptEvent }).__deferredInstallPrompt;
      if (stashed) setPrompt(stashed);
    };
    window.addEventListener("install-prompt-ready", pickUp);
    return () => window.removeEventListener("install-prompt-ready", pickUp);
  }, []);

  const triggerInstall = useCallback(async () => {
    if (!prompt) return;
    setInstalling(true);
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } finally {
      setInstalling(false);
      (window as unknown as { __deferredInstallPrompt?: InstallPromptEvent }).__deferredInstallPrompt = undefined;
      setPrompt(null);
    }
  }, [prompt]);

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

  return (
    <div className="fixed inset-0 z-[100] flex flex-col overflow-y-auto bg-slate-950 text-slate-100">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-6 py-10">
        <div className="flex flex-1 flex-col justify-center">
          <div className="flex flex-col items-center text-center">
            <img
              src="/pwa-192x192.png"
              alt="RWMT"
              className="h-20 w-20 rounded-2xl border border-slate-800 shadow-2xl shadow-amber-500/10"
            />
            <p className="mt-5 text-2xl font-bold tracking-tight text-amber-400">
              加入主畫面
            </p>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              將 RWMT 加入主畫面，獲得如原生 App 的全螢幕體驗，並可即時接收認購與交易推播通知。
            </p>
          </div>

          <div className="mt-8 rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
            {inApp ? (
              <div className="flex flex-col gap-4">
                <p className="text-sm font-semibold text-amber-300">
                  請改用系統瀏覽器開啟
                </p>
                <p className="text-sm leading-relaxed text-slate-300">
                  您目前在
                  {inApp === "line"
                    ? " LINE "
                    : inApp === "facebook"
                      ? " Facebook "
                      : inApp === "instagram"
                        ? " Instagram "
                        : " 微信 "}
                  內建瀏覽器中，無法直接加入主畫面。請點右
                  {platform === "ios" ? "上" : "上"}角的
                  <InlineIcon label="選單">
                    <MoreVertical className="h-4 w-4" />
                  </InlineIcon>
                  選單，選擇「用
                  {platform === "ios" ? "Safari" : "Chrome"}
                  開啟」或「在瀏覽器中開啟」，再依指示加入主畫面。
                </p>
                <button
                  type="button"
                  onClick={copyUrl}
                  className="flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-sm font-semibold text-slate-100 transition hover:bg-slate-700"
                >
                  {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                  {copied ? "已複製網址" : "複製網址"}
                </button>
              </div>
            ) : platform === "ios" ? (
              <ol className="flex flex-col gap-4">
                <Step index={1}>
                  點擊瀏覽器底部（或頂部）工具列的
                  <InlineIcon label="分享">
                    <Share className="h-4 w-4" />
                  </InlineIcon>
                  「分享」按鈕。
                </Step>
                <Step index={2}>
                  在選單中向下滑動，選擇
                  <InlineIcon label="加入主畫面">
                    <SquarePlus className="h-4 w-4" />
                  </InlineIcon>
                  「加入主畫面」。
                </Step>
                <Step index={3}>
                  點擊右上角的「加入」，即可在主畫面看到 RWMT 圖示。
                </Step>
              </ol>
            ) : (
              <div className="flex flex-col gap-5">
                {prompt ? (
                  <button
                    type="button"
                    onClick={triggerInstall}
                    disabled={installing}
                    className="flex items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-3.5 text-sm font-bold text-slate-950 transition hover:bg-amber-400 disabled:opacity-60"
                  >
                    <Download className="h-4 w-4" />
                    {installing ? "安裝中…" : "一鍵加入主畫面"}
                  </button>
                ) : null}
                <ol className="flex flex-col gap-4">
                  <Step index={1}>
                    點擊瀏覽器右上角的
                    <InlineIcon label="選單">
                      <MoreVertical className="h-4 w-4" />
                    </InlineIcon>
                    選單。
                  </Step>
                  <Step index={2}>
                    選擇
                    <InlineIcon label="安裝">
                      <Plus className="h-4 w-4" />
                    </InlineIcon>
                    「加入主畫面」或「安裝應用程式」。
                  </Step>
                  <Step index={3}>
                    點擊「安裝／新增」，即可在主畫面看到 RWMT 圖示。
                  </Step>
                </ol>
              </div>
            )}
          </div>
        </div>

        <div className="mt-8 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={continueInBrowser}
            className="flex items-center gap-1.5 text-xs font-medium text-slate-500 transition hover:text-slate-300"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            先在瀏覽器繼續使用
          </button>
        </div>
      </div>
    </div>
  );
}
