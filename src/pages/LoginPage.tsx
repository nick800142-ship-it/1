import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { supabase } from '@/lib/supabase';

export function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const signIn = async () => {
    setLoading(true);
    setError(false);
    const popup = window.open('', 'rwmt-google-auth', 'popup=yes,width=520,height=720');
    if (!popup) {
      setError(true);
      setLoading(false);
      return;
    }

    const redirectTo = 'https://rwa1-1.vercel.app';
    const { data, error: authError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        skipBrowserRedirect: true,
      },
    });

    if (authError || !data.url) {
      popup.close();
      setError(true);
      setLoading(false);
      return;
    }

    popup.location.assign(data.url);
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">
      <section aria-labelledby="login-title" className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-2xl">
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-amber-400 text-xl font-black text-slate-950">R</div>
          <div className="flex flex-col gap-2">
            <h1 id="login-title" className="text-2xl font-bold text-white">登入 RWMT</h1>
            <p className="text-sm text-slate-400">請使用 Google 帳號繼續</p>
          </div>
          <button type="button" onClick={signIn} disabled={loading} className="flex w-full items-center justify-center gap-3 rounded-xl bg-white px-4 py-3 font-semibold text-slate-950 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60">
            {loading ? <LoaderCircle aria-hidden="true" className="size-5 animate-spin" /> : <GoogleMark />}
            {loading ? '正在前往 Google…' : '使用 Google 帳號登入'}
          </button>
          {error && <p role="alert" className="text-sm text-red-400">目前無法登入，請稍後再試。</p>}
        </div>
      </section>
    </main>
  );
}

function GoogleMark() {
  return <span aria-hidden="true" className="flex size-5 items-center justify-center rounded-full bg-slate-100 text-sm font-black text-blue-600">G</span>;
}
