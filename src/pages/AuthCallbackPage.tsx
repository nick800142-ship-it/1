import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export function AuthCallbackPage() {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;

    const finish = async () => {
      const code = new URLSearchParams(window.location.search).get('code');
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error && active) {
          setFailed(true);
          return;
        }
      }

      const { data, error } = await supabase.auth.getSession();
      if (!active) return;

      if (error || !data.session) {
        setFailed(true);
        return;
      }

      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(
          { type: 'AUTH_SUCCESS' },
          window.location.origin,
        );
        window.close();
        return;
      }

      window.location.replace('/');
    };

    void finish();
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-center text-slate-100">
      <p role={failed ? 'alert' : 'status'} className="text-sm text-slate-400">
        {failed ? '登入未完成，請關閉此頁面後重試。' : '正在完成登入…'}
      </p>
    </main>
  );
}
