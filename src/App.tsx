import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { Sidebar } from "@/components/Sidebar";
import { HomePage } from "@/pages/HomePage";
import { MarketPage } from "@/pages/MarketPage";
import { SubscribePage } from "@/pages/SubscribePage";
import { WalletPage } from "@/pages/WalletPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { LoginPage } from "@/pages/LoginPage";
import { AuthCallbackPage } from "@/pages/AuthCallbackPage";
import { AdminPage } from "@/pages/AdminPage";
import { AgentPage } from "@/pages/AgentPage";
import { RwmtTownPage } from "@/pages/RwmtTownPage";
import { supabase } from "@/lib/supabase";
import { InstallGuide, useShouldShowInstallGuide } from "@/components/InstallGuide";
import { playNotificationSound } from "@/lib/pushNotifications";
import { UserPreferencesProvider } from "@/contexts/UserPreferences";
import { interfaceText, LanguageProvider, PlatformProvider, ThemeProvider, useLanguage } from "@/platform";
import { usePrivySupabaseSync } from "@/hooks/usePrivySupabaseSync";
import { useAutoVersionReload } from "@/hooks/useAutoVersionReload";
import { BackgroundEffects } from "@/components/BackgroundEffects";
import { NotFoundPage } from "@/components/NotFoundPage";
import {
  captureReferralFromLocation,
  clearPendingReferralCode,
  getPendingReferralCode,
  isReferralAlreadyBoundError,
  isTerminalReferralError,
} from "@/lib/referral";
import type { PageKey } from "@/nav";
import { IS_MAINNET, MAINNET_ADMIN_ONLY } from "@/lib/network";

const pages: PageKey[] = [
  "home",
  "subscribe",
  "market",
  "wallet",
  "agent",
  "town",
  "settings",
];

function readInitialLocation() {
  const params = new URLSearchParams(window.location.search);
  const requestedPage = params.get("page") as PageKey;
  return {
    pathname: window.location.pathname,
    requestedAdmin: params.get("view") === "admin",
    page: pages.includes(requestedPage) ? requestedPage : ("home" as PageKey),
  };
}

const ADMIN_ENTRY_KEY = "rwmt-admin-entry";

// 主網尚未對外開放時，只有開過 ?view=admin 的瀏覽器才看得到登入頁，其他人一律 404。
function hasAdminEntry() {
  try {
    if (new URLSearchParams(window.location.search).get("view") === "admin") {
      localStorage.setItem(ADMIN_ENTRY_KEY, "1");
      return true;
    }
    return localStorage.getItem(ADMIN_ENTRY_KEY) === "1";
  } catch {
    return false;
  }
}

function App() {
  const [capturedReferralCode, setCapturedReferralCode] = useState<string | null>(null);
  useEffect(() => {
    setCapturedReferralCode(captureReferralFromLocation());
  }, []);
  useAutoVersionReload();
  const privySession = usePrivySupabaseSync();
  const [isMounted, setIsMounted] = useState(false);
  const showInstallGuide = useShouldShowInstallGuide();

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // App 內所有依賴 URL、瀏覽器儲存空間、時間及登入狀態的內容，
  // 一律等到瀏覽器完成 mount 後才建立 React tree。
  if (!isMounted)
    return (
      <main
        role="status"
        aria-live="polite"
        aria-busy="true"
        className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-sm text-slate-400"
      >
        正在載入 RWMT…
      </main>
    );

  if (MAINNET_ADMIN_ONLY && !hasAdminEntry()) return <NotFoundPage />;

  // 在手機瀏覽器（尚未加入主畫面）中開啟時，先引導使用者加入主畫面。
  if (showInstallGuide) return <InstallGuide />;

  return (
    <ThemeProvider>
      <LanguageProvider>
        <BackgroundEffects />
        {IS_MAINNET && (
          <div role="status" className="relative z-20 bg-amber-400 px-4 py-1.5 text-center text-xs font-semibold text-slate-950">
            {MAINNET_ADMIN_ONLY ? "Base 主網（真實資產）・尚未對外開放，僅限管理員" : "Base 主網（真實資產）"}
          </div>
        )}
        <div className="relative z-10">
          <AppContent privySession={privySession} capturedReferralCode={capturedReferralCode} />
        </div>
      </LanguageProvider>
    </ThemeProvider>
  );
}

function AppContent({
  privySession,
  capturedReferralCode,
}: {
  privySession: ReturnType<typeof usePrivySupabaseSync>;
  capturedReferralCode: string | null;
}) {
  const [initialLocation] = useState(readInitialLocation);
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [introFinished, setIntroFinished] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => setIntroFinished(true), 12_000);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    let active = true;
    const refreshSession = async () => {
      const { data } = await supabase.auth.getSession();
      if (active) {
        setSession(data.session);
        setChecking(false);
      }
    };
    const handleAuthMessage = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.data?.type !== "AUTH_SUCCESS"
      )
        return;
      void refreshSession();
    };

    void refreshSession();
    window.addEventListener("message", handleAuthMessage);
    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => {
        setSession(nextSession);
        setChecking(false);
      },
    );
    return () => {
      active = false;
      window.removeEventListener("message", handleAuthMessage);
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const userId = session?.user.id;
    const promoCode = capturedReferralCode ?? getPendingReferralCode();
    if (!userId || !promoCode || privySession.status !== "ready") return;

    let active = true;
    let attempt = 0;
    const bindReferral = async () => {
      while (active && attempt < 30) {
        attempt += 1;
        const { data: profile, error: profileError } = await supabase
          .from("profiles")
          .select("parent_id,referrer_id")
          .eq("id", userId)
          .maybeSingle();
        if (!active) return;
        if (profileError) {
          console.error("[v0] Referral profile lookup failed:", profileError);
        } else if (profile?.parent_id || profile?.referrer_id) {
          clearPendingReferralCode(promoCode);
          return;
        } else if (profile) {
          const { error } = await supabase.rpc("bind_referral_code", {
            promo: promoCode,
          });
          if (!active) return;
          if (!error || isReferralAlreadyBoundError(error.message)) {
            clearPendingReferralCode(promoCode);
            return;
          }
          if (isTerminalReferralError(error.message)) {
            clearPendingReferralCode(promoCode);
            console.warn("[v0] Referral code could not be applied:", error.message);
            return;
          }
          console.error("[v0] Referral binding failed:", error);
        }
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
    };
    void bindReferral();
    return () => {
      active = false;
    };
  }, [session?.user.id, privySession.status, capturedReferralCode]);

  if (
    initialLocation.pathname === "/auth/callback" ||
    initialLocation.pathname === "/auth-callback"
  )
    return <AuthCallbackPage />;
  if (
    !introFinished ||
    checking ||
    privySession.status === "waiting" ||
    privySession.status === "syncing"
  )
    return (
      <main
        role="status"
        aria-live="polite"
        aria-busy={!introFinished}
        className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-950"
      >
        {!introFinished ? (
          <>
            <div className="relative inline-flex max-h-screen max-w-full items-center justify-center">
              <video
                className="max-h-screen max-w-full object-contain"
                src="/rwmt-town-victory.mp4"
                autoPlay
                muted
                playsInline
                preload="auto"
                onEnded={() => setIntroFinished(true)}
                onError={() => setIntroFinished(true)}
                onCanPlay={(event) => {
                  void event.currentTarget.play().catch(() => setIntroFinished(true));
                }}
                aria-hidden="true"
                tabIndex={-1}
              />
              <div
                className="pointer-events-none absolute right-[1%] top-[2%] h-[14%] w-[26%] rounded-full blur-[2px]"
                style={{
                  background:
                    "radial-gradient(ellipse at center, rgba(2, 6, 23, 1) 0%, rgba(2, 6, 23, 1) 90%, rgba(2, 6, 23, 0.55) 96%, rgba(2, 6, 23, 0) 100%)",
                }}
                aria-hidden="true"
              />
            </div>
            <button
              type="button"
              onClick={() => setIntroFinished(true)}
              className="absolute bottom-6 rounded-full border border-white/20 bg-slate-950/80 px-5 py-3 text-sm font-medium text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              跳過動畫，直接登入
            </button>
          </>
        ) : (
          <p className="px-6 text-center text-sm text-slate-400">
            正在確認平台登入與錢包狀態…
          </p>
        )}
      </main>
    );
  const samePrivyAccount =
    session?.user.email?.toLowerCase() === privySession.email?.toLowerCase();
  if (!session || privySession.status !== "ready" || !samePrivyAccount)
    return <LoginPage syncError={privySession.error} />;
  return (
    <UserPreferencesProvider userId={session.user.id}>
      <AuthenticatedApp session={session} initialLocation={initialLocation} />
    </UserPreferencesProvider>
  );
}

function WelcomeMessage({ nickname }: { nickname: string }) {
  const { language } = useLanguage();
  return (
    <p className="mt-2 whitespace-normal break-words text-base font-semibold leading-relaxed text-slate-200">
      {interfaceText(language, "welcome", { name: nickname })}
    </p>
  );
}

function AuthenticatedApp({
  session,
  initialLocation,
}: {
  session: Session;
  initialLocation: ReturnType<typeof readInitialLocation>;
}) {
  const [profileIsAdmin, setProfileIsAdmin] = useState(false);
  const [isAgent, setIsAgent] = useState(false);
  const [nickname, setNickname] = useState(
    session.user.email?.split("@")[0] || "會員",
  );
  const [checkingRole, setCheckingRole] = useState(true);
  const [devOverride, setDevOverride] = useState<boolean | null>(null);
  const isAdmin =
    import.meta.env.DEV && devOverride !== null ? devOverride : profileIsAdmin;
  const requestedAdmin = initialLocation.requestedAdmin;
  const [adminView, setAdminView] = useState(false);
  const [page, setPageState] = useState<PageKey>(initialLocation.page);
  const [settingsFocusTarget, setSettingsFocusTarget] = useState<"nickname" | "agencyRelationship" | "telegramNotifications" | null>(null);

  useEffect(() => {
    let active = true;
    void supabase
      .from("profiles")
      .select("agency_role,role,nickname")
      .eq("id", session.user.id)
      .single()
      .then(({ data, error }) => {
        if (!active) return;
        if (data?.nickname?.trim()) setNickname(data.nickname.trim());
        setProfileIsAdmin(
          !error &&
            (["admin", "管理員", "super_admin"].includes(data?.agency_role ?? "") ||
              ["admin", "super_admin"].includes(data?.role ?? "")),
        );
        // Every authenticated account is a Genesis L0 and gets the agent center.
        setIsAgent(!error);
        setCheckingRole(false);
      });
    return () => {
      active = false;
    };
  }, [session.user.id]);

  useEffect(() => {
    const handleServiceWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type !== "PUSH_NOTIFICATION") return;
      const payload = event.data.payload as { announcementId?: string; title?: string; body?: string };
      if (payload.announcementId && sessionStorage.getItem("last-notified-announcement") === payload.announcementId) return;
      playNotificationSound();
      if (payload.announcementId) sessionStorage.setItem("last-notified-announcement", payload.announcementId);
    };
    navigator.serviceWorker?.addEventListener("message", handleServiceWorkerMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", handleServiceWorkerMessage);
  }, [session.user.id]);

  useEffect(() => {
    let stopped = false;
    const heartbeat = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      await supabase
        .from("profiles")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", session.user.id);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void heartbeat();
    };
    void heartbeat();
    const interval = window.setInterval(() => void heartbeat(), 60_000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [session.user.id]);

  useEffect(() => {
    if (checkingRole || !requestedAdmin) return;
    if (isAdmin) {
      setAdminView(true);
      return;
    }
    window.alert("您沒有後台管理權限，將返回前台首頁。");
    const url = new URL(location.href);
    url.searchParams.delete("view");
    url.searchParams.set("page", "home");
    history.replaceState(null, "", url);
    setPageState("home");
  }, [checkingRole, isAdmin, requestedAdmin]);

  const setPage = (next: PageKey, assetId?: string) => {
    setAdminView(false);
    setSettingsFocusTarget(null);
    setPageState(next);
    const url = new URL(location.href);
    url.searchParams.delete("view");
    url.searchParams.set("page", next);
    if ((next === "market" || next === "subscribe") && assetId) url.searchParams.set("asset", assetId);
    else url.searchParams.delete("asset");
    history.replaceState(null, "", url);
  };

  useEffect(() => {
    const navigateToMarket = (event: Event) => {
      const assetId = (event as CustomEvent<{ assetId?: string }>).detail?.assetId;
      setPage("market", assetId);
    };
    const navigateToAnnouncementTarget = (event: Event) => {
      const target = (event as CustomEvent<{ page: PageKey; assetId?: string; section?: "nickname" | "agencyRelationship" | "telegramNotifications" }>).detail;
      if (!target || !pages.includes(target.page)) return;
      setPage(target.page, target.assetId);
      if (target.page === "settings" && target.section) {
        setSettingsFocusTarget(null);
        window.requestAnimationFrame(() => setSettingsFocusTarget(target.section ?? null));
      }
    };
    window.addEventListener("navigate-to-market", navigateToMarket);
    window.addEventListener("navigate-to-announcement-target", navigateToAnnouncementTarget);
    return () => {
      window.removeEventListener("navigate-to-market", navigateToMarket);
      window.removeEventListener("navigate-to-announcement-target", navigateToAnnouncementTarget);
    };
  }, []);
  const showAdmin = () => {
    if (!isAdmin) {
      window.alert("您沒有後台管理權限。");
      setPage("home");
      return;
    }
    setAdminView(true);
    const url = new URL(location.href);
    url.searchParams.set("view", "admin");
    history.replaceState(null, "", url);
  };
  const exitAdmin = () => setPage("home");
  const toggleDevAdmin = () => {
    const next = !isAdmin;
    setDevOverride(next);
    if (!next && adminView) {
      window.alert("已切換為普通用戶，將返回前台首頁。");
      setPage("home");
    }
  };

  if (MAINNET_ADMIN_ONLY) {
    if (checkingRole)
      return (
        <main className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-400">
          正在確認平台登入與錢包狀態…
        </main>
      );
    if (!isAdmin) return <NotFoundPage />;
  }

  return (
        <PlatformProvider>
          <div className="min-h-screen max-w-full overflow-x-hidden bg-slate-950 text-slate-100 antialiased">
            {!adminView && (
              <Sidebar
                current={page}
                onNavigate={(next) => setPage(next)}
                user={session.user}
                isAgent={isAgent}
              />
            )}
            <main
              className={`relative ${adminView ? "" : "mx-auto max-w-6xl px-4 py-8 pb-24 sm:px-6 lg:ml-60 lg:px-10 lg:py-10"}`}
            >
              {!adminView && (isAdmin || page === "home") && (
                <div className="mb-6 flex items-start justify-between gap-3">
                  {page === "home" && (
                    <div className="min-w-0 flex-1 pt-1 lg:hidden">
                      <p className="text-3xl font-bold tracking-tight text-amber-400">
                        RWMT
                      </p>
                      <WelcomeMessage nickname={nickname} />
                    </div>
                  )}
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={showAdmin}
                      className="ml-auto shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs font-semibold text-amber-300 transition hover:bg-amber-500/20 sm:rounded-xl sm:px-4 sm:py-2.5 sm:text-sm"
                    >
                      切換至後台 (Admin Panel)
                    </button>
                  )}
                </div>
              )}
              {adminView ? (
                <AdminPage onExit={exitAdmin} />
              ) : (
                <>
                  {page === "home" && <HomePage user={session.user} />}
                  {page === "subscribe" && <SubscribePage />}
                  {page === "market" && <MarketPage />}
                  {page === "wallet" && <WalletPage />}
                  {page === "agent" &&
                    (isAgent ? (
                      <AgentPage />
                    ) : (
                      <SettingsPage sessionUser={session.user} focusTarget={settingsFocusTarget} />
                    ))}
                  {page === "town" && <RwmtTownPage />}
                  {page === "settings" && (
                    <SettingsPage sessionUser={session.user} focusTarget={settingsFocusTarget} />
                  )}
                </>
              )}
            </main>
            {import.meta.env.DEV && (
              <button
                type="button"
                onClick={toggleDevAdmin}
                className="fixed bottom-24 right-4 z-50 rounded-full border border-slate-700 bg-slate-900 px-4 py-2 text-xs font-bold text-slate-200 shadow-xl lg:bottom-5"
                aria-pressed={isAdmin}
              >
                測試身份：{isAdmin ? "管理員" : "普通用戶"}
              </button>
            )}
          </div>
        </PlatformProvider>
  );
}

export default App;
