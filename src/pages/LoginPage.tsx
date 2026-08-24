import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { LANGUAGES, useLanguage, type Lang } from "@/platform";

const loginCopy: Record<Lang, [string, string, string, string, string]> = {
  "zh-TW": ["登入 RWMT", "請使用 Google 帳號繼續", "使用 Google 帳號登入", "正在前往 Google…", "目前無法登入，請稍後再試。"],
  "zh-CN": ["登录 RWMT", "请使用 Google 账号继续", "使用 Google 账号登录", "正在前往 Google…", "目前无法登录，请稍后再试。"],
  en: ["Sign in to RWMT", "Continue with your Google account", "Sign in with Google", "Going to Google…", "Unable to sign in. Please try again later."],
  ja: ["RWMT にログイン", "Google アカウントで続行してください", "Google でログイン", "Google に移動しています…", "現在ログインできません。後でもう一度お試しください。"],
  ko: ["RWMT 로그인", "Google 계정으로 계속하세요", "Google로 로그인", "Google로 이동 중…", "현재 로그인할 수 없습니다. 나중에 다시 시도하세요."],
  th: ["เข้าสู่ระบบ RWMT", "ดำเนินการต่อด้วยบัญชี Google", "เข้าสู่ระบบด้วย Google", "กำลังไปที่ Google…", "ไม่สามารถเข้าสู่ระบบได้ โปรดลองอีกครั้งในภายหลัง"],
  vi: ["Đăng nhập RWMT", "Tiếp tục bằng tài khoản Google", "Đăng nhập bằng Google", "Đang chuyển đến Google…", "Hiện không thể đăng nhập. Vui lòng thử lại sau."],
  id: ["Masuk ke RWMT", "Lanjutkan dengan akun Google", "Masuk dengan Google", "Membuka Google…", "Tidak dapat masuk saat ini. Coba lagi nanti."],
  ms: ["Log masuk ke RWMT", "Teruskan dengan akaun Google", "Log masuk dengan Google", "Membuka Google…", "Tidak dapat log masuk sekarang. Cuba lagi kemudian."],
  es: ["Iniciar sesión en RWMT", "Continúa con tu cuenta de Google", "Iniciar sesión con Google", "Abriendo Google…", "No se puede iniciar sesión. Inténtalo más tarde."],
  fr: ["Se connecter à RWMT", "Continuez avec votre compte Google", "Se connecter avec Google", "Ouverture de Google…", "Connexion impossible. Réessayez plus tard."],
  de: ["Bei RWMT anmelden", "Mit Ihrem Google-Konto fortfahren", "Mit Google anmelden", "Google wird geöffnet…", "Anmeldung derzeit nicht möglich. Bitte später erneut versuchen."],
  pt: ["Iniciar sessão no RWMT", "Continue com a sua conta Google", "Iniciar sessão com Google", "A abrir o Google…", "Não foi possível iniciar sessão. Tente novamente mais tarde."],
  ru: ["Войти в RWMT", "Продолжите с аккаунтом Google", "Войти через Google", "Переход к Google…", "Сейчас войти невозможно. Повторите попытку позже."],
  ar: ["تسجيل الدخول إلى RWMT", "تابع باستخدام حساب Google", "تسجيل الدخول باستخدام Google", "جارٍ الانتقال إلى Google…", "يتعذر تسجيل الدخول حاليًا. حاول مرة أخرى لاحقًا."],
  hi: ["RWMT में साइन इन करें", "अपने Google खाते से जारी रखें", "Google से साइन इन करें", "Google पर जा रहे हैं…", "अभी साइन इन नहीं हो सका। कृपया बाद में फिर प्रयास करें।"],
};

export function LoginPage() {
  const { language, setLanguage } = useLanguage();
  const [title, subtitle, signInLabel, loadingLabel, errorLabel] = loginCopy[language];
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const signIn = async () => {
    setLoading(true);
    setError(false);
    const previewRedirectUrl =
      process.env.NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL;
    const isPreview = Boolean(previewRedirectUrl);
    const authWindow = isPreview ? window.open("about:blank", "_blank") : null;
    if (isPreview && !authWindow) {
      setError(true);
      setLoading(false);
      return;
    }
    const redirectTo =
      previewRedirectUrl ?? `${window.location.origin}/auth/callback`;
    const { data, error: authError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        skipBrowserRedirect: true,
      },
    });

    if (authError || !data.url) {
      authWindow?.close();
      setError(true);
      setLoading(false);
      return;
    }

    if (authWindow) {
      authWindow.location.href = data.url;
      setLoading(false);
      return;
    }

    window.location.assign(data.url);
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">
      <section
        aria-labelledby="login-title"
        className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-2xl"
      >
        <div className="flex flex-col items-center gap-6 text-center">
          <label className="sr-only" htmlFor="login-language">Language</label>
          <select
            id="login-language"
            value={language}
            onChange={(event) => setLanguage(event.target.value as Lang)}
            className="self-end rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-sm text-slate-200"
          >
            {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
          <div className="flex size-12 items-center justify-center rounded-xl bg-amber-400 text-xl font-black text-slate-950">
            R
          </div>
          <div className="flex flex-col gap-2">
            <h1 id="login-title" className="text-2xl font-bold text-white">
              {title}
            </h1>
            <p className="text-sm text-slate-400">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={signIn}
            disabled={loading}
            className="flex w-full items-center justify-center gap-3 rounded-xl bg-white px-4 py-3 font-semibold text-slate-950 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <LoaderCircle
                aria-hidden="true"
                className="size-5 animate-spin"
              />
            ) : (
              <GoogleMark />
            )}
            {loading ? loadingLabel : signInLabel}
          </button>
          {error && (
            <p role="alert" className="text-sm text-red-400">
              {errorLabel}
            </p>
          )}
        </div>
      </section>
    </main>
  );
}

function GoogleMark() {
  return (
    <span
      aria-hidden="true"
      className="flex size-5 items-center justify-center rounded-full bg-slate-100 text-sm font-black text-blue-600"
    >
      G
    </span>
  );
}
