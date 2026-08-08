import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Sidebar } from '@/components/Sidebar';
import { HomePage } from '@/pages/HomePage';
import { MarketPage } from '@/pages/MarketPage';
import { WalletPage } from '@/pages/WalletPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { LoginPage } from '@/pages/LoginPage';
import { AuthCallbackPage } from '@/pages/AuthCallbackPage';
import { AdminPage } from '@/pages/AdminPage';
import { supabase } from '@/lib/supabase';
import { LanguageProvider, PlatformProvider, ThemeProvider } from '@/platform';
import type { PageKey } from '@/nav';

const pages: PageKey[] = ['home', 'market', 'wallet', 'settings'];

function App() {
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
      if (event.origin !== window.location.origin || event.data?.type !== 'AUTH_SUCCESS') return;
      void refreshSession();
    };

    void refreshSession();
    window.addEventListener('message', handleAuthMessage);
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setChecking(false);
    });
    return () => {
      active = false;
      window.removeEventListener('message', handleAuthMessage);
      listener.subscription.unsubscribe();
    };
  }, []);

  if (window.location.pathname === '/auth-callback') return <AuthCallbackPage />;
  if (checking) return <main className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-400">正在確認登入狀態…</main>;
  if (!session) return <LoginPage />;
  return <AuthenticatedApp session={session} />;
}

function AuthenticatedApp({ session }: { session: Session }) {
  const accountIsAdmin = session.user.email?.toLowerCase() === 'nick800142@gmail.com';
  const [devAdmin, setDevAdmin] = useState(accountIsAdmin);
  const isAdmin = import.meta.env.DEV ? devAdmin : accountIsAdmin;
  const requestedAdmin = new URLSearchParams(location.search).get('view') === 'admin';
  const [adminView, setAdminView] = useState(requestedAdmin && isAdmin);
  const [page, setPageState] = useState<PageKey>(() => {
    const value = new URLSearchParams(location.search).get('page') as PageKey;
    return pages.includes(value) ? value : 'home';
  });

  useEffect(() => {
    if (!requestedAdmin || isAdmin) return;
    window.alert('您沒有後台管理權限，將返回前台首頁。');
    const url = new URL(location.href);
    url.searchParams.delete('view');
    url.searchParams.set('page', 'home');
    history.replaceState(null, '', url);
    setPageState('home');
  }, [isAdmin, requestedAdmin]);

  const setPage = (next: PageKey) => {
    setAdminView(false);
    setPageState(next);
    const url = new URL(location.href);
    url.searchParams.delete('view');
    url.searchParams.set('page', next);
    history.replaceState(null, '', url);
  };
  const showAdmin = () => {
    if (!isAdmin) {
      window.alert('您沒有後台管理權限。');
      setPage('home');
      return;
    }
    setAdminView(true);
    const url = new URL(location.href);
    url.searchParams.set('view', 'admin');
    history.replaceState(null, '', url);
  };
  const exitAdmin = () => setPage('home');
  const toggleDevAdmin = () => {
    const next = !isAdmin;
    setDevAdmin(next);
    if (!next && adminView) {
      window.alert('已切換為普通用戶，將返回前台首頁。');
      setPage('home');
    }
  };

  return <ThemeProvider><LanguageProvider><PlatformProvider><div className="min-h-screen bg-slate-950 text-slate-100 antialiased">{!adminView&&<Sidebar current={page} onNavigate={setPage} user={session.user}/>}<main className={`relative ${adminView?'':'mx-auto max-w-6xl px-4 py-8 pb-24 sm:px-6 lg:ml-60 lg:px-10 lg:py-10'}`}>{isAdmin && !adminView && <div className="mb-6 flex justify-end"><button type="button" onClick={showAdmin} className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm font-semibold text-amber-300 transition hover:bg-amber-500/20">切換至後台 (Admin Panel)</button></div>}{adminView ? <AdminPage onExit={exitAdmin}/> : <>{page === 'home' && <HomePage/>}{page === 'market' && <MarketPage/>}{page === 'wallet' && <WalletPage/>}{page === 'settings' && <SettingsPage sessionUser={session.user}/>}</>}</main>{import.meta.env.DEV&&<button type="button" onClick={toggleDevAdmin} className="fixed bottom-24 right-4 z-50 rounded-full border border-slate-700 bg-slate-900 px-4 py-2 text-xs font-bold text-slate-200 shadow-xl lg:bottom-5" aria-pressed={isAdmin}>測試身份：{isAdmin?'管理員':'普通用戶'}</button>}</div></PlatformProvider></LanguageProvider></ThemeProvider>;
}

export default App;
