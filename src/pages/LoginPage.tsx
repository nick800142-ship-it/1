import { PrivyAuthGate } from "@/components/PrivyAuthGate";
import { LANGUAGES, useLanguage, type Lang } from "@/platform";

// [title, subtitle, button, connecting, error]
const loginCopy: Record<Lang, [string, string, string, string, string]> = {
  "zh-TW": ["登入 RWMT", "點擊按鈕後可選擇 Google 或 Email 繼續", "登入 / 註冊", "正在登入平台…", "目前無法登入，請稍後再試。"],
  "zh-CN": ["登录 RWMT", "点击按钮后可选择 Google 或 Email 继续", "登录 / 注册", "正在登录平台…", "目前无法登录，请稍后再试。"],
  en: ["Sign in to RWMT", "Choose Google or Email after tapping the button", "Log in / Sign up", "Signing you in…", "Unable to sign in. Please try again later."],
  ja: ["RWMT にログイン", "ボタンをタップ後、Google または Email を選択", "ログイン / 登録", "ログインしています…", "現在ログインできません。後でもう一度お試しください。"],
  ko: ["RWMT 로그인", "버튼을 누른 후 Google 또는 Email 선택", "로그인 / 회원가입", "로그인 중…", "현재 로그인할 수 없습니다. 나중에 다시 시도하세요."],
  th: ["เข้าสู่ระบบ RWMT", "เลือก Google หรือ Email หลังจากแตะปุ่ม", "เข้าสู่ระบบ / สมัคร", "กำลังเข้าสู่ระบบ…", "ไม่สามารถเข้าสู่ระบบได้ โปรดลองอีกครั้งในภายหลัง"],
  vi: ["Đăng nhập RWMT", "Chọn Google hoặc Email sau khi nhấn nút", "Đăng nhập / Đăng ký", "Đang đăng nhập…", "Hiện không thể đăng nhập. Vui lòng thử lại sau."],
  id: ["Masuk ke RWMT", "Pilih Google atau Email setelah menekan tombol", "Masuk / Daftar", "Sedang masuk…", "Tidak dapat masuk saat ini. Coba lagi nanti."],
  ms: ["Log masuk ke RWMT", "Pilih Google atau Email selepas menekan butang", "Log masuk / Daftar", "Sedang log masuk…", "Tidak dapat log masuk sekarang. Cuba lagi kemudian."],
  es: ["Iniciar sesión en RWMT", "Elige Google o Email tras pulsar el botón", "Entrar / Registrarse", "Iniciando sesión…", "No se puede iniciar sesión. Inténtalo más tarde."],
  fr: ["Se connecter à RWMT", "Choisissez Google ou Email après avoir appuyé", "Connexion / Inscription", "Connexion en cours…", "Connexion impossible. Réessayez plus tard."],
  de: ["Bei RWMT anmelden", "Wähle Google oder E-Mail nach dem Tippen", "Anmelden / Registrieren", "Anmeldung läuft…", "Anmeldung derzeit nicht möglich. Bitte später erneut versuchen."],
  pt: ["Iniciar sessão no RWMT", "Escolha Google ou Email após tocar no botão", "Entrar / Registar", "A iniciar sessão…", "Não foi possível iniciar sessão. Tente novamente mais tarde."],
  ru: ["Войти в RWMT", "Выберите Google или Email после нажатия", "Вход / Регистрация", "Выполняется вход…", "Сейчас войти невозможно. Повторите попытку позже."],
  ar: ["تسجيل الدخول إلى RWMT", "اختر Google أو البريد بعد الضغط على الزر", "تسجيل الدخول / التسجيل", "جارٍ تسجيل الدخول…", "يتعذر تسجيل الدخول حاليًا. حاول مرة أخرى لاحقًا."],
  hi: ["RWMT में साइन इन करें", "बटन दबाने के बाद Google या Email चुनें", "लॉग इन / साइन अप", "साइन इन हो रहा है…", "अभी साइन इन नहीं हो सका। कृपया बाद में फिर प्रयास करें।"],
};

export function LoginPage() {
  const { language, setLanguage } = useLanguage();
  const [title, subtitle, button, connecting, error] = loginCopy[language];

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
          <PrivyAuthGate copy={{ button, connecting, error }} />
        </div>
      </section>
    </main>
  );
}
