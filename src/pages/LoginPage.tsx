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

const loginGateCopy: Record<Lang, {
  language: string;
  success: string;
  email: string;
  wallet: string;
  walletPending: string;
  walletWarning: string;
  syncing: string;
  preparingWallet: string;
  waitingAccount: string;
  enterDashboard: string;
  signOut: string;
  signingOut: string;
  missingEmail: string;
  walletNotReady: string;
  syncFallback: string;
}> = {
  "zh-TW": { language: "語言", success: "已成功登入！", email: "電子郵件：", wallet: "錢包地址：", walletPending: "生成中…", walletWarning: "嵌入式錢包尚未準備好；完成錢包同步前不會開放平台交易。若持續無法完成，請登出後重新登入。", syncing: "同步平台帳號與錢包中…", preparingWallet: "錢包準備中…", waitingAccount: "等待帳號資料…", enterDashboard: "進入平台儀表板", signOut: "登出", signingOut: "登出中…", missingEmail: "Privy 帳號尚未提供 Email，請先完成登入驗證。", walletNotReady: "Privy 嵌入式錢包尚未準備完成，請稍候後重試。", syncFallback: "同步帳號時發生問題，請再試一次。" },
  "zh-CN": { language: "语言", success: "已成功登录！", email: "电子邮件：", wallet: "钱包地址：", walletPending: "生成中…", walletWarning: "嵌入式钱包尚未准备好；完成钱包同步前不会开放平台交易。如果持续无法完成，请退出后重新登录。", syncing: "正在同步平台账号与钱包…", preparingWallet: "钱包准备中…", waitingAccount: "等待账号资料…", enterDashboard: "进入平台仪表板", signOut: "退出登录", signingOut: "正在退出…", missingEmail: "Privy 账号尚未提供 Email，请先完成登录验证。", walletNotReady: "Privy 嵌入式钱包尚未准备好，请稍后重试。", syncFallback: "同步账号时发生问题，请再试一次。" },
  en: { language: "Language", success: "You are signed in.", email: "Email:", wallet: "Wallet address:", walletPending: "Creating…", walletWarning: "Your embedded wallet is not ready yet. Trading stays unavailable until wallet sync completes. If this continues, sign out and sign in again.", syncing: "Syncing your account and wallet…", preparingWallet: "Preparing wallet…", waitingAccount: "Waiting for account details…", enterDashboard: "Open dashboard", signOut: "Sign out", signingOut: "Signing out…", missingEmail: "Your Privy account has not provided an email. Complete sign-in verification first.", walletNotReady: "Your Privy embedded wallet is not ready yet. Please wait and try again.", syncFallback: "There was a problem syncing your account. Please try again." },
  ja: { language: "言語", success: "ログインしました。", email: "メールアドレス：", wallet: "ウォレットアドレス：", walletPending: "作成中…", walletWarning: "埋め込みウォレットの準備がまだできていません。同期が完了するまで取引は利用できません。解決しない場合はログアウトして再度ログインしてください。", syncing: "アカウントとウォレットを同期中…", preparingWallet: "ウォレットを準備中…", waitingAccount: "アカウント情報を待っています…", enterDashboard: "ダッシュボードへ", signOut: "ログアウト", signingOut: "ログアウト中…", missingEmail: "Privy アカウントのメールアドレスがありません。ログイン認証を完了してください。", walletNotReady: "Privy 埋め込みウォレットの準備ができていません。少し待ってから再試行してください。", syncFallback: "アカウントの同期に失敗しました。もう一度お試しください。" },
  ko: { language: "언어", success: "로그인되었습니다.", email: "이메일:", wallet: "지갑 주소:", walletPending: "생성 중…", walletWarning: "임베디드 지갑이 아직 준비되지 않았습니다. 지갑 동기화가 완료될 때까지 거래할 수 없습니다. 계속 문제가 발생하면 로그아웃한 후 다시 로그인하세요.", syncing: "계정과 지갑 동기화 중…", preparingWallet: "지갑 준비 중…", waitingAccount: "계정 정보 대기 중…", enterDashboard: "대시보드로 이동", signOut: "로그아웃", signingOut: "로그아웃 중…", missingEmail: "Privy 계정에서 이메일을 제공하지 않았습니다. 로그인을 먼저 인증하세요.", walletNotReady: "Privy 임베디드 지갑이 아직 준비되지 않았습니다. 잠시 후 다시 시도하세요.", syncFallback: "계정 동기화에 문제가 발생했습니다. 다시 시도하세요." },
  th: { language: "ภาษา", success: "เข้าสู่ระบบแล้ว", email: "อีเมล:", wallet: "ที่อยู่กระเป๋า:", walletPending: "กำลังสร้าง…", walletWarning: "กระเป๋าเงินแบบฝังยังไม่พร้อมใช้งาน จะยังไม่สามารถทำธุรกรรมได้จนกว่าจะซิงค์เสร็จ หากยังมีปัญหา โปรดออกจากระบบแล้วเข้าสู่ระบบอีกครั้ง", syncing: "กำลังซิงค์บัญชีและกระเป๋าเงิน…", preparingWallet: "กำลังเตรียมกระเป๋าเงิน…", waitingAccount: "กำลังรอข้อมูลบัญชี…", enterDashboard: "เข้าสู่แดชบอร์ด", signOut: "ออกจากระบบ", signingOut: "กำลังออกจากระบบ…", missingEmail: "บัญชี Privy ยังไม่มีอีเมล โปรดยืนยันการเข้าสู่ระบบก่อน", walletNotReady: "กระเป๋าเงิน Privy ยังไม่พร้อม โปรดรอสักครู่แล้วลองอีกครั้ง", syncFallback: "ซิงค์บัญชีไม่สำเร็จ โปรดลองอีกครั้ง" },
  vi: { language: "Ngôn ngữ", success: "Bạn đã đăng nhập.", email: "Email:", wallet: "Địa chỉ ví:", walletPending: "Đang tạo…", walletWarning: "Ví nhúng chưa sẵn sàng. Bạn chưa thể giao dịch cho đến khi đồng bộ ví hoàn tất. Nếu vẫn gặp sự cố, hãy đăng xuất rồi đăng nhập lại.", syncing: "Đang đồng bộ tài khoản và ví…", preparingWallet: "Đang chuẩn bị ví…", waitingAccount: "Đang chờ thông tin tài khoản…", enterDashboard: "Mở bảng điều khiển", signOut: "Đăng xuất", signingOut: "Đang đăng xuất…", missingEmail: "Tài khoản Privy chưa cung cấp email. Vui lòng hoàn tất xác minh đăng nhập.", walletNotReady: "Ví nhúng Privy chưa sẵn sàng. Vui lòng đợi rồi thử lại.", syncFallback: "Không thể đồng bộ tài khoản. Vui lòng thử lại." },
  id: { language: "Bahasa", success: "Anda telah masuk.", email: "Email:", wallet: "Alamat dompet:", walletPending: "Membuat…", walletWarning: "Dompet tertanam belum siap. Transaksi belum tersedia sampai sinkronisasi dompet selesai. Jika masalah berlanjut, keluar lalu masuk kembali.", syncing: "Menyinkronkan akun dan dompet…", preparingWallet: "Menyiapkan dompet…", waitingAccount: "Menunggu detail akun…", enterDashboard: "Buka dasbor", signOut: "Keluar", signingOut: "Sedang keluar…", missingEmail: "Akun Privy belum memberikan email. Selesaikan verifikasi masuk terlebih dahulu.", walletNotReady: "Dompet tertanam Privy belum siap. Tunggu sebentar lalu coba lagi.", syncFallback: "Akun tidak dapat disinkronkan. Silakan coba lagi." },
  ms: { language: "Bahasa", success: "Anda telah log masuk.", email: "E-mel:", wallet: "Alamat dompet:", walletPending: "Sedang dicipta…", walletWarning: "Dompet terbenam belum sedia. Transaksi tidak tersedia sehingga penyegerakan selesai. Jika masalah berterusan, log keluar dan log masuk semula.", syncing: "Menyegerakkan akaun dan dompet…", preparingWallet: "Menyediakan dompet…", waitingAccount: "Menunggu butiran akaun…", enterDashboard: "Buka papan pemuka", signOut: "Log keluar", signingOut: "Sedang log keluar…", missingEmail: "Akaun Privy belum memberikan e-mel. Lengkapkan pengesahan log masuk dahulu.", walletNotReady: "Dompet terbenam Privy belum sedia. Tunggu sebentar dan cuba lagi.", syncFallback: "Akaun tidak dapat disegerakkan. Sila cuba lagi." },
  es: { language: "Idioma", success: "Has iniciado sesión.", email: "Correo electrónico:", wallet: "Dirección de la cartera:", walletPending: "Creando…", walletWarning: "La cartera integrada aún no está lista. No podrás operar hasta que finalice la sincronización. Si el problema continúa, cierra sesión y vuelve a entrar.", syncing: "Sincronizando la cuenta y la cartera…", preparingWallet: "Preparando la cartera…", waitingAccount: "Esperando los datos de la cuenta…", enterDashboard: "Abrir el panel", signOut: "Cerrar sesión", signingOut: "Cerrando sesión…", missingEmail: "Tu cuenta de Privy no ha proporcionado un correo electrónico. Completa primero la verificación.", walletNotReady: "La cartera integrada de Privy aún no está lista. Espera un momento e inténtalo de nuevo.", syncFallback: "No se pudo sincronizar la cuenta. Inténtalo de nuevo." },
  fr: { language: "Langue", success: "Vous êtes connecté.", email: "E-mail :", wallet: "Adresse du portefeuille :", walletPending: "Création…", walletWarning: "Le portefeuille intégré n’est pas encore prêt. Les transactions resteront indisponibles jusqu’à la fin de la synchronisation. Si le problème persiste, déconnectez-vous puis reconnectez-vous.", syncing: "Synchronisation du compte et du portefeuille…", preparingWallet: "Préparation du portefeuille…", waitingAccount: "En attente des informations du compte…", enterDashboard: "Ouvrir le tableau de bord", signOut: "Se déconnecter", signingOut: "Déconnexion…", missingEmail: "Votre compte Privy n’a pas fourni d’adresse e-mail. Terminez d’abord la vérification de connexion.", walletNotReady: "Le portefeuille intégré Privy n’est pas prêt. Patientez puis réessayez.", syncFallback: "La synchronisation du compte a échoué. Veuillez réessayer." },
  de: { language: "Sprache", success: "Du bist angemeldet.", email: "E-Mail:", wallet: "Wallet-Adresse:", walletPending: "Wird erstellt…", walletWarning: "Die eingebettete Wallet ist noch nicht bereit. Transaktionen sind erst nach der Synchronisierung möglich. Wenn das Problem bleibt, melde dich ab und erneut an.", syncing: "Konto und Wallet werden synchronisiert…", preparingWallet: "Wallet wird vorbereitet…", waitingAccount: "Warte auf Kontodaten…", enterDashboard: "Zum Dashboard", signOut: "Abmelden", signingOut: "Wird abgemeldet…", missingEmail: "Dein Privy-Konto hat keine E-Mail-Adresse übermittelt. Schließe zuerst die Anmeldeprüfung ab.", walletNotReady: "Die eingebettete Privy-Wallet ist noch nicht bereit. Warte kurz und versuche es erneut.", syncFallback: "Das Konto konnte nicht synchronisiert werden. Bitte versuche es erneut." },
  pt: { language: "Idioma", success: "Sessão iniciada.", email: "E-mail:", wallet: "Endereço da carteira:", walletPending: "A criar…", walletWarning: "A carteira incorporada ainda não está pronta. As transações ficam indisponíveis até à sincronização. Se o problema persistir, termine a sessão e volte a entrar.", syncing: "A sincronizar conta e carteira…", preparingWallet: "A preparar carteira…", waitingAccount: "À espera dos dados da conta…", enterDashboard: "Abrir painel", signOut: "Terminar sessão", signingOut: "A terminar sessão…", missingEmail: "A conta Privy não forneceu um e-mail. Conclua primeiro a verificação de início de sessão.", walletNotReady: "A carteira incorporada Privy ainda não está pronta. Aguarde e tente novamente.", syncFallback: "Não foi possível sincronizar a conta. Tente novamente." },
  ru: { language: "Язык", success: "Вы вошли в систему.", email: "Электронная почта:", wallet: "Адрес кошелька:", walletPending: "Создание…", walletWarning: "Встроенный кошелёк ещё не готов. Торговля будет недоступна до завершения синхронизации. Если проблема не исчезнет, выйдите и войдите снова.", syncing: "Синхронизация аккаунта и кошелька…", preparingWallet: "Подготовка кошелька…", waitingAccount: "Ожидание данных аккаунта…", enterDashboard: "Открыть панель", signOut: "Выйти", signingOut: "Выход…", missingEmail: "Аккаунт Privy не предоставил электронную почту. Сначала завершите проверку входа.", walletNotReady: "Встроенный кошелёк Privy ещё не готов. Подождите и попробуйте снова.", syncFallback: "Не удалось синхронизировать аккаунт. Повторите попытку." },
  ar: { language: "اللغة", success: "تم تسجيل الدخول.", email: "البريد الإلكتروني:", wallet: "عنوان المحفظة:", walletPending: "جارٍ الإنشاء…", walletWarning: "المحفظة المضمنة غير جاهزة بعد. ستظل المعاملات غير متاحة حتى اكتمال المزامنة. إذا استمرت المشكلة، سجّل الخروج ثم سجّل الدخول مجددًا.", syncing: "جارٍ مزامنة الحساب والمحفظة…", preparingWallet: "جارٍ تجهيز المحفظة…", waitingAccount: "بانتظار بيانات الحساب…", enterDashboard: "فتح لوحة التحكم", signOut: "تسجيل الخروج", signingOut: "جارٍ تسجيل الخروج…", missingEmail: "لم يقدّم حساب Privy بريدًا إلكترونيًا. أكمل التحقق من تسجيل الدخول أولًا.", walletNotReady: "محفظة Privy المضمنة غير جاهزة بعد. انتظر قليلًا ثم أعد المحاولة.", syncFallback: "تعذرت مزامنة الحساب. يُرجى المحاولة مرة أخرى." },
  hi: { language: "भाषा", success: "आप साइन इन हैं।", email: "ईमेल:", wallet: "वॉलेट पता:", walletPending: "बनाया जा रहा है…", walletWarning: "एम्बेडेड वॉलेट अभी तैयार नहीं है। वॉलेट सिंक पूरा होने तक ट्रेडिंग उपलब्ध नहीं होगी। समस्या बनी रहे तो साइन आउट करके फिर साइन इन करें।", syncing: "खाता और वॉलेट सिंक हो रहे हैं…", preparingWallet: "वॉलेट तैयार हो रहा है…", waitingAccount: "खाते की जानकारी की प्रतीक्षा…", enterDashboard: "डैशबोर्ड खोलें", signOut: "साइन आउट", signingOut: "साइन आउट हो रहा है…", missingEmail: "आपके Privy खाते ने ईमेल नहीं दिया। पहले साइन-इन सत्यापन पूरा करें।", walletNotReady: "Privy एम्बेडेड वॉलेट अभी तैयार नहीं है। थोड़ी देर बाद फिर प्रयास करें।", syncFallback: "खाता सिंक नहीं हो सका। कृपया फिर से प्रयास करें।" },
};

export function LoginPage({ syncError }: { syncError?: string }) {
  const { language, setLanguage } = useLanguage();
  const [title, subtitle, button] = loginCopy[language];
  const gateCopy = loginGateCopy[language];

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">
      <section
        aria-labelledby="login-title"
        className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-2xl"
      >
        <div className="flex flex-col items-center gap-6 text-center">
          <label className="sr-only" htmlFor="login-language">{gateCopy.language}</label>
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
          <PrivyAuthGate copy={{ ...gateCopy, button, syncError }} />
        </div>
      </section>
    </main>
  );
}
