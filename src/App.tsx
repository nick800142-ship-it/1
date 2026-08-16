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
import { supabase } from "@/lib/supabase";
import { playNotificationSound, registerPushSubscription } from "@/lib/pushNotifications";
import { interfaceText, LanguageProvider, PlatformProvider, ThemeProvider, useLanguage } from "@/platform";
import type { PageKey } from "@/nav";

const pages: PageKey[] = [
  "home",
  "subscribe",
  "market",
  "wallet",
  "agent",
  "settings",
];

function App() {
  return (
    <ThemeProvider>
      <LanguageProvider>
        <AppContent />
      </LanguageProvider>
    </ThemeProvider>
  );
}

function AppContent() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);

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

  if (window.location.pathname === "/auth-callback")
    return <AuthCallbackPage />;
  if (checking)
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-400">
        正在確認登入狀態…
      </main>
    );
  if (!session) return <LoginPage />;
  return <AuthenticatedApp session={session} />;
}

function WelcomeMessage({ nickname }: { nickname: string }) {
  const { language } = useLanguage();
  return (
    <p className="mt-2 whitespace-normal break-words text-base font-semibold leading-relaxed text-slate-200">
      {interfaceText(language, "welcome", { name: nickname })}
    </p>
  );
}

function AuthenticatedApp({ session }: { session: Session }) {
  const [profileIsAdmin, setProfileIsAdmin] = useState(false);
  const [isAgent, setIsAgent] = useState(false);
  const [nickname, setNickname] = useState(
    session.user.email?.split("@")[0] || "會員",
  );
  const [checkingRole, setCheckingRole] = useState(true);
  const [devOverride, setDevOverride] = useState<boolean | null>(null);
  const isAdmin =
    import.meta.env.DEV && devOverride !== null ? devOverride : profileIsAdmin;
  const requestedAdmin =
    new URLSearchParams(location.search).get("view") === "admin";
  const [adminView, setAdminView] = useState(false);
  const [page, setPageState] = useState<PageKey>(() => {
    const value = new URLSearchParams(location.search).get("page") as PageKey;
    return pages.includes(value) ? value : "home";
  });

  useEffect(() => {
    let active = true;
    void supabase
      .from("profiles")
      .select("agency_role,nickname")
      .eq("id", session.user.id)
      .single()
      .then(({ data, error }) => {
        if (!active) return;
        if (data?.nickname?.trim()) setNickname(data.nickname.trim());
        setProfileIsAdmin(
          !error && ["admin", "管理員"].includes(data?.agency_role ?? ""),
        );
        setIsAgent(
          !error &&
            [
              "agent",
              "master_agent",
              "代理",
              "一代代理",
              "二代代理",
              "總代理",
            ].includes(data?.agency_role ?? ""),
        );
        setCheckingRole(false);
      });
    return () => {
      active = false;
    };
  }, [session.user.id]);

  useEffect(() => {
    void registerPushSubscription(true);
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

  const setPage = (next: PageKey) => {
    setAdminView(false);
    setPageState(next);
    const url = new URL(location.href);
    url.searchParams.delete("view");
    url.searchParams.set("page", next);
    history.replaceState(null, "", url);
  };
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

  return (
        <PlatformProvider>
          <div className="min-h-screen max-w-full overflow-x-hidden bg-slate-950 text-slate-100 antialiased">
            {!adminView && (
              <Sidebar
                current={page}
                onNavigate={setPage}
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
                      <SettingsPage sessionUser={session.user} />
                    ))}
                  {page === "settings" && (
                    <SettingsPage sessionUser={session.user} />
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
