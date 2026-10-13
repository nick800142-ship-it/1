import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BadgeDollarSign,
  ChevronDown,
  Copy,
  Network,
  QrCode,
  Search,
  TrendingUp,
  Users,
} from "lucide-react";
import { Modal, Notice } from "@/components/Modal";
import { AnnouncementFeed } from "@/components/AnnouncementFeed";
import { supabase } from "@/lib/supabase";
import { getGenesisRoleLabel } from "@/lib/roleLabels";
import { getCommissionTypeMeta } from "@/lib/commission-types";
import { formatJC, localizedUiText, useLanguage } from "@/platform";
import { getLegacyText } from "@/i18n/legacy";
import QRCode from "qrcode";
import { buildReferralUrl } from "@/lib/referral";
import {
  isTransactionHistoryVisible,
  TRANSACTION_HISTORY_START_LABEL,
} from "@/lib/transactionHistory";

type Member = {
  id: string;
  email: string;
  display_name: string | null;
  nickname: string | null;
  agency_role: string;
  promo_code: string | null;
  referrer_id: string | null;
  parent_id?: string | null;
  level?: 1 | 2;
  master_agent_id: string | null;
  last_login_at: string | null;
  created_at: string;
  monthly_investment: number;
  effective: boolean;
  fees: number;
};
type Commission = {
  id: string;
  buyer_id: string;
  asset_id: string;
  transaction_type: string;
  transaction_amount: number;
  bonus_type: "l1" | "l2" | "personal" | "team" | "self_rebate";
  base_rate: number;
  boost_rate: number;
  effective_rate: number;
  commission_amount: number;
  paid_at: string | null;
  created_at: string;
};
type Trade = {
  id: string;
  user_id: string;
  entry_type:
    | "private_purchase"
    | "secondary_buy"
    | "secondary_sell"
    | "p2p_buy"
    | "p2p_sell";
  asset_id: string;
  quantity: number;
  amount: number;
  gross: number;
  fee: number;
  created_at: string;
};
type Dashboard = {
  profile: {
    id: string;
    email: string;
    agency_role: string;
    promo_code: string;
    master_agent_id: string | null;
  };
  members: Member[];
  commissions: Commission[];
  trades: Trade[];
  new_effective_count: number;
  boost_rate: number;
};
export function AgentPage() {
  const { language } = useLanguage();
  const uiText = (languageArg: import("@/platform").Lang, korean: string, fallback: string) => {
  return localizedUiText(languageArg, korean, fallback);
  };
  const roleLabel = (role: string) => localizedUiText(language, getGenesisRoleLabel(role), getGenesisRoleLabel(role));
  const qrCopy: Record<string, Record<string, string>> = {
    "zh-TW": { title: "QR Code 推廣碼", description: "掃描 QR Code 後會開啟網站登入／註冊畫面。用戶完成登入後，系統會自動將此推廣碼綁定至帳號並建立代理層級。", alt: "專屬推廣登入連結 QR Code", generating: "正在產生 QR Code…", link: "專屬推廣連結", copy: "複製推廣連結" },
    "zh-CN": { title: "QR Code 推广码", description: "扫描 QR Code 后会打开网站登录／注册页面。用户完成登录后，系统会自动将此推广码绑定到账户并建立代理层级。", alt: "专属推广登录链接 QR Code", generating: "正在生成 QR Code…", link: "专属推广链接", copy: "复制推广链接" },
    en: { title: "QR Code Referral Code", description: "Scanning the QR Code opens the website login or registration page. After signing in, the referral code is automatically linked to the account and the agent hierarchy is created.", alt: "Dedicated referral login QR Code", generating: "Generating QR Code…", link: "Dedicated referral link", copy: "Copy referral link" },
    ja: { title: "QRコード紹介コード", description: "QRコードをスキャンするとログイン／登録画面が開きます。ログイン後、紹介コードが自動的にアカウントに紐づき、代理店階層が作成されます。", alt: "専用紹介ログインQRコード", generating: "QRコードを生成中…", link: "専用紹介リンク", copy: "紹介リンクをコピー" },
    ko: { title: "QR 코드 추천 코드", description: "QR 코드를 스캔하면 웹사이트 로그인/가입 화면이 열립니다. 로그인 후 추천 코드가 계정에 자동 연결되고 추천 관계가 설정됩니다.", alt: "전용 추천 로그인 링크 QR 코드", generating: "QR 코드를 생성하는 중…", link: "전용 추천 링크", copy: "추천 링크 복사" },
    th: { title: "รหัสแนะนำ QR Code", description: "สแกน QR Code เพื่อเปิดหน้าล็อกอินหรือสมัครสมาชิก หลังเข้าสู่ระบบ รหัสแนะนำจะเชื่อมโยงกับบัญชีและสร้างระดับตัวแทนอัตโนมัติ", alt: "QR Code ลิงก์เข้าสู่ระบบสำหรับการแนะนำ", generating: "กำลังสร้าง QR Code…", link: "ลิงก์แนะนำเฉพาะของคุณ", copy: "คัดลอกลิงก์แนะนำ" },
    vi: { title: "Mã giới thiệu QR Code", description: "Quét QR Code để mở trang đăng nhập hoặc đăng ký. Sau khi đăng nhập, mã giới thiệu sẽ tự động liên kết với tài khoản và tạo cấp đại lý.", alt: "Mã QR đăng nhập giới thiệu riêng", generating: "Đang tạo QR Code…", link: "Liên kết giới thiệu riêng", copy: "Sao chép liên kết giới thiệu" },
    id: { title: "Kode Referral QR", description: "Pindai QR Code untuk membuka halaman masuk atau pendaftaran. Setelah masuk, kode referral akan otomatis ditautkan ke akun dan hierarki agen dibuat.", alt: "QR Code login referral khusus", generating: "Membuat QR Code…", link: "Tautan referral khusus", copy: "Salin tautan referral" },
    ms: { title: "Kod Rujukan QR", description: "Imbas QR Code untuk membuka halaman log masuk atau pendaftaran. Selepas log masuk, kod rujukan akan dipautkan secara automatik ke akaun dan hierarki ejen diwujudkan.", alt: "QR Code log masuk rujukan khas", generating: "Menjana QR Code…", link: "Pautan rujukan khas", copy: "Salin pautan rujukan" },
    es: { title: "Código de referido QR", description: "Escanea el código QR para abrir la página de inicio de sesión o registro. Al iniciar sesión, el código se vinculará automáticamente a la cuenta y se creará la jerarquía de agentes.", alt: "Código QR de acceso de referido", generating: "Generando código QR…", link: "Enlace de referido", copy: "Copiar enlace de referido" },
    fr: { title: "Code de parrainage QR", description: "Scannez le code QR pour ouvrir la page de connexion ou d’inscription. Après la connexion, le code sera automatiquement lié au compte et la hiérarchie des agents sera créée.", alt: "Code QR de connexion de parrainage", generating: "Génération du code QR…", link: "Lien de parrainage", copy: "Copier le lien de parrainage" },
    de: { title: "QR-Empfehlungscode", description: "Scannen Sie den QR-Code, um die Anmelde- oder Registrierungsseite zu öffnen. Nach der Anmeldung wird der Empfehlungscode automatisch mit dem Konto verknüpft und die Agentenhierarchie erstellt.", alt: "QR-Code für den Empfehlungs-Login", generating: "QR-Code wird erstellt…", link: "Persönlicher Empfehlungslink", copy: "Empfehlungslink kopieren" },
    pt: { title: "Código de indicação QR", description: "Leia o QR Code para abrir a página de login ou cadastro. Após o login, o código será vinculado automaticamente à conta e a hierarquia de agentes será criada.", alt: "QR Code de login por indicação", generating: "Gerando QR Code…", link: "Link de indicação", copy: "Copiar link de indicação" },
    ru: { title: "Реферальный QR-код", description: "Отсканируйт���������� QR-код, чт��бы открыть страницу входа или регистрации. После входа код автоматически привяжется к аккаунту и будет создана иерархия агентов.", alt: "QR-код реферального входа", generating: "Создание QR-кода…", link: "Реферальная ссылка", copy: "Копировать реферальную ссылку" },
    ar: { title: "رمز الإحالة عبر QR", description: "امسح رمز QR لفتح صفحة تسجيل الدخول أو التسجيل. بعد تسجيل الدخول، سيتم ربط رمز الإحالة بالحساب تلقائياً وإنشاء ا��تسلسل الهرمي للوكلاء.", alt: "رمز QR لتسجيل الدخول عبر الإحالة", generating: "جارٍ إنشاء رمز QR…", link: "رابط الإحالة الخاص", copy: "نسخ رابط الإحالة" },
    hi: { title: "QR ���ेफ़रल ���ोड", description: "लॉगिन या पंजीकरण पृष्ठ खोलने के लिए QR कोड स्कैन करें। लॉगिन के बाद रेफ़रल कोड खाते से अपने आप जुड़ जाएगा और एजेंट स्तर बनाया जाएगा।", alt: "विशेष रेफ़रल लॉगिन QR कोड", generating: "QR कोड बनाया जा रहा है…", link: "विशेष रेफ़रल लिंक", copy: "रेफ़रल लिंक कॉपी करें" },
  };
  const qrText = qrCopy[language] ?? qrCopy.en;
  const commissionRulesCopy: Record<string, [string, string, string]> = {
    "zh-TW": ["需具備下線業績方可解鎖自身 3% 認購返利；二級市場自己買賣無反饋，上兩級分別為 13/10000 與 7/10000。", "一般投資：自己 3%、直屬上級 2%、上上級 1%；中間層級缺失時不向上累積。", "二級市場：自己買賣無反饋，直屬上級 13/10000、上上級 7/10000，最多兩級。"],
    "zh-CN": ["需具备下线业绩方可解锁自身 3% 认购返利；二级市场自己买卖无反馈，上两级分别为 13/10000 与 7/10000。", "一般投资：自己 3%、直属上级 2%、上上级 1%；中间层级缺失时不向上累积。", "二级市场：自己买卖无反馈，直属上级 13/10000、上上级 7/10000，最多两级。"],
    en: ["Your 3% subscription rebate unlocks after downstream performance is established; personal secondary-market trades earn no referral reward. The two uplines receive 13/10000 and 7/10000.", "Standard investment: self 3%, direct upline 2%, second-level upline 1%; missing levels do not roll upward.", "Secondary market: personal trades earn no reward; direct upline 13/10000 and second-level upline 7/10000, up to two levels."],
    ja: ["下位実績の達成後、自分の3%購入還元が解放されます。二次市場の自己取引には報酬がなく、上位2段階は13/10000と7/10000です。", "通常投資：本人3%、直属上位2%、2段階上位1%。中間階層がない場合は繰り上げません。", "二次市場：自己取引の報酬なし。直属上位13/10000、2段階上位7/10000、最大2段階。"],
    ko: ["하위 실적이 있어야 자기 투자 3% 보너스가 잠금 해제됩니다. 2차 시장 본인 거래는 보상 대상이 아니며 상위 2단계는 13/10000과 7/10000을 받습니다.", "일반 투자: 본인 3%, 직속 상위 2%, 상위 2단계 1%. 중간 단계가 없으면 누적하지 않습니다.", "2차 시장: 본인 거래는 보상 없음. 직속 상위 13/10000, 상위 2단계 7/10000, 최대 2단계."],
    th: ["ปลดล็อกโบนัสคืนเงินลงทุน 3% เมื่อมีผลงานจากสมาชิกสายงาน; การซื้อขายของตนเองในตลาดรองไม่มีโบนัส โดยผู้แนะนำสองระดับได้รับ 13/10000 และ 7/10000", "การลงทุนทั่วไป: ตนเอง 3% ผู้แนะนำโดยตรง 2% ผู้แนะนำระดับสอง 1%; ไม่เลื่อนระดับเมื่อขาดช่วง", "ตลาดรอง: การซื้อขายของตนเองไม่มีโบนัส ผู้แนะนำโดยตรง 13/10000 และระดับสอง 7/10000 สูงสุดสองระดับ"],
    vi: ["Mở khóa hoàn tiền đầu tư 3% khi có doanh số tuyến dưới; giao dịch cá nhân trên thị trường thứ cấp không nhận thưởng, hai cấp trên nhận 13/10000 và 7/10000.", "Đầu tư thông thường: bản thân 3%, cấp trên trực tiếp 2%, cấp trên cấp hai 1%; cấp thiếu không được cộng dồn.", "Thị trường thứ cấp: giao dịch cá nhân không nhận thưởng; cấp trên trực tiếp 13/10000, cấp trên cấp hai 7/10000, tối đa hai cấp."],
    id: ["Bonus pengembalian investasi 3% terbuka setelah ada kinerja downline; transaksi pribadi di pasar sekunder tidak mendapat bonus, dua upline menerima 13/10000 dan 7/10000.", "Investasi umum: diri sendiri 3%, upline langsung 2%, upline tingkat dua 1%; tingkat yang hilang tidak digabungkan.", "Pasar sekunder: transaksi pribadi tanpa bonus; upline langsung 13/10000 dan tingkat dua 7/10000, maksimal dua tingkat."],
    ms: ["Rebat pelaburan 3% dibuka selepas prestasi downline tersedia; dagangan sendiri di pasaran sekunder tiada ganjaran, dua upline menerima 13/10000 dan 7/10000.", "Pelaburan biasa: diri sendiri 3%, upline langsung 2%, upline tahap dua 1%; tahap yang hilang tidak dikumpulkan.", "Pasaran sekunder: dagangan sendiri tiada ganjaran; upline langsung 13/10000 dan tahap dua 7/10000, maksimum dua tahap."],
    es: ["El reembolso del 3% se desbloquea con rendimiento descendente; las operaciones propias en el mercado secundario no generan recompensa, y los dos niveles superiores reciben 13/10000 y 7/10000.", "Inversión normal: propio 3%, superior directo 2%, segundo nivel 1%; los niveles faltantes no se acumulan.", "Mercado secundario: las operaciones propias no generan recompensa; superior directo 13/10000 y segundo nivel 7/10000, máximo dos niveles."],
    fr: ["La remise de 3 % se débloque avec une performance en aval ; les opérations personnelles sur le marché secondaire ne rapportent rien, les deux niveaux supérieurs reçoivent 13/10000 et 7/10000.", "Investissement standard : soi-même 3 %, supérieur direct 2 %, second niveau 1 % ; les niveaux manquants ne se cumulent pas.", "Marché secondaire : aucune récompense sur ses propres opérations ; supérieur direct 13/10000 et second niveau 7/10000, deux niveaux maximum."],
    de: ["Der 3%-Rückvergütungsbonus wird nach Downline-Leistung freigeschaltet; eigene Geschäfte im Sekundärmarkt bringen keine Prämie, die zwei oberen Ebenen erhalten 13/10000 und 7/10000.", "Standardanlage: selbst 3 %, direkte Upline 2 %, zweite Ebene 1 %; fehlende Ebenen werden nicht addiert.", "Sekundärmarkt: eigene Geschäfte ohne Prämie; direkte Upline 13/10000, zweite Ebene 7/10000, maximal zwei Ebenen."],
    pt: ["O rebate de 3% é desbloqueado após desempenho da linha descendente; operações próprias no mercado secundário não geram recompensa, e os dois níveis acima recebem 13/10000 e 7/10000.", "Investimento normal: próprio 3%, superior direto 2%, segundo nível 1%; níveis ausentes não são acumulados.", "Mercado secundário: operações próprias sem recompensa; superior direto 13/10000 e segundo nível 7/10000, no máximo dois níveis."],
    ru: ["Возврат 3% открывается после появления оборота нижестоящей сети; собственные 資料資料д��лки на вт����ричном рынке не вознаграждаются, два уровня выше получают 13/10000 и 7/10000.", "Обычная инвестиция: свои 3%, прямой вышестоящий 2%, второй уровень 1%; пропущенные уровни не суммируются.", "Вторичный рынок: собственные сделки без вознаграждения; прямой уровень 13/10000 и второй 7/10000, максимум два уровня."],
    ar: ["تُفتح مكافأة استرداد الاستثمار 3% بعد تحقق أداء من المستوى الأدنى؛ التداول الشخصي في السوق الثانوية لا يحصل على مكافأة، ويحصل المستويان الأعلى على 13/10000 و7/10000.", "الاستثمار العادي: 3% للنفس، 2% للمستوى الأعلى المباشر، 1% للمستوى الثاني؛ لا تُرحّل المستويات المفقودة.", "السوق الثانوية: لا مكافأة للتداول الشخصي؛ 13/10000 للمستوى المباشر و7/10000 للمستوى الثاني، بحد أقصى مستويان."],
    hi: ["डाउनलाइन प्रदर्शन के बाद 3% निवेश रिबेट खुलता है; द्वितीयक बाजार में अपने लेन-देन पर पुरस्कार नही�� मिलता, ऊपर के दो स्तरों को 13/10000 और 7/10000 मिलते हैं।", "सामान्य निवेश: स्वयं 3%, प्रत्यक्ष अपलाइन 2%, दूसरे स्तर की अपलाइन 1%; अनुपस्थित स्तर आगे नहीं जुड़ते।", "द्वितीयक बाजार: अपने लेन-देन पर कोई पुरस्कार नहीं; प्रत्यक्ष अपलाइन 13/10000 और दूसरा स्तर 7/10000, अधिकतम दो स्तर।"],
  };
  const commissionCopy = commissionRulesCopy[language] ?? commissionRulesCopy.en;
  // 代理中心金額與分潤一律以 JC 顯示（沿用 jc_ledger / commission_logs 的 JC 欄位）。
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [referralQrOpen, setReferralQrOpen] = useState(false);
  const [referralUrl, setReferralUrl] = useState("");
  const [qrImage, setQrImage] = useState("");
  const [qrError, setQrError] = useState("");
  const [nameQuery, setNameQuery] = useState("");
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [bonusModal, setBonusModal] = useState<"l1" | "l2" | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const mergePerformanceMembers = (dashboard: Dashboard, rawMembers: unknown): Dashboard => {
    const members = Array.isArray(rawMembers)
      ? rawMembers
      : rawMembers && typeof rawMembers === "object" && "members" in rawMembers
        ? (rawMembers as { members: unknown }).members
        : [];
    if (!Array.isArray(members)) return dashboard;
    const existing = new Map(dashboard.members.map((member) => [member.id, member]));
    return {
      ...dashboard,
      members: (members as Member[]).map((profile) =>
        existing.get(profile.id) ?? {
          ...profile,
          level: undefined,
          monthly_investment: 0,
          effective: false,
          fees: 0,
        },
      ),
    };
  };
  useEffect(() => {
    let active = true;
    void Promise.all([
      supabase.rpc("get_agent_dashboard"),
      supabase.rpc("touch_last_login"),
      supabase.rpc("get_all_agent_performance_members"),
    ]).then(([result, , profilesResult]) => {
      if (!active) return;
      if (result.error) {
        setLoadError(result.error.message);
      } else {
        const dashboard = mergePerformanceMembers(
          result.data as Dashboard,
          !profilesResult.error ? profilesResult.data : [],
        );
        setData(dashboard);
      }
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => {
      void Promise.all([
        supabase.rpc("get_agent_dashboard"),
        supabase.rpc("get_all_agent_performance_members"),
      ]).then(([result, profilesResult]) => {
        if (result.error) return;
        const dashboard = mergePerformanceMembers(
          result.data as Dashboard,
          !profilesResult.error ? profilesResult.data : [],
        );
        setData(dashboard);
      });
    }, 15000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!referralQrOpen || !referralUrl) return;
    let active = true;
    void QRCode.toDataURL(referralUrl, {
      errorCorrectionLevel: "H",
      margin: 2,
      width: 280,
      color: { dark: "#0f172a", light: "#ffffff" },
    })
      .then((image) => {
        if (active) setQrImage(image);
      })
      .catch(() => {
        if (active) setQrError(uiText(language, "QR 코드 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.", "QR Code 暫時無法產生，請稍後再試。"));
      });
    return () => {
      active = false;
    };
  }, [language, referralQrOpen, referralUrl]);

  const inDateRange = useCallback(
    (createdAt: string) =>
      isTransactionHistoryVisible(createdAt) &&
      (!from || new Date(createdAt) >= new Date(`${from}T00:00:00`)) &&
      (!to || new Date(createdAt) <= new Date(`${to}T23:59:59`)),
    [from, to],
  );
  const commissions = useMemo(
    () =>
      data?.commissions.filter((item) => inDateRange(item.created_at)) ?? [],
    [data, inDateRange],
  );
  const trades = useMemo(
    () => data?.trades?.filter((item) => inDateRange(item.created_at)) ?? [],
    [data, inDateRange],
  );
  const isAgentRole = (role: string) =>
    ["代理", "一代代理", "二代代理", "總代理"].includes(role);
  const allMembers = useMemo(() => data?.members ?? [], [data]);
  const currentMonthStart = useMemo(() => {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }, []);
  const monthlyStatsByMember = useMemo(() => {
    const stats = new Map<string, { investment: number; fees: number }>();
    for (const trade of data?.trades ?? []) {
      const createdAt = new Date(trade.created_at).getTime();
      if (
        !isTransactionHistoryVisible(trade.created_at) ||
        createdAt < currentMonthStart
      ) {
        continue;
      }
      const current = stats.get(trade.user_id) ?? { investment: 0, fees: 0 };
      if (trade.entry_type === "private_purchase" || trade.entry_type === "p2p_buy") {
        current.investment += Math.abs(Number(trade.amount));
      }
      current.fees += Math.abs(Number(trade.fee ?? 0));
      stats.set(trade.user_id, current);
    }
    return stats;
  }, [currentMonthStart, data]);
  const newEffectiveCount = useMemo(() => {
    if (!data) return 0;
    return allMembers.filter((member) => {
      const isCountedForAgent =
        member.referrer_id === data.profile.id ||
        (data.profile.agency_role === "總代理" &&
          member.master_agent_id === data.profile.id);
      return (
        isCountedForAgent &&
        new Date(member.created_at).getTime() >= currentMonthStart &&
        (monthlyStatsByMember.get(member.id)?.investment ?? 0) >= 100
      );
    }).length;
  }, [allMembers, currentMonthStart, data, monthlyStatsByMember]);
  const teamMemberCount = useMemo(() => {
    const ids = new Set<string>();
    for (const member of allMembers) {
      if (member.referrer_id === data?.profile.id || member.parent_id === data?.profile.id) {
        ids.add(member.id);
      }
      if (member.referrer_id && allMembers.some((parent) => parent.id === member.referrer_id && parent.referrer_id === data?.profile.id)) {
        ids.add(member.id);
      }
    }
    return ids.size;
  }, [allMembers, data?.profile.id]);
  const query = nameQuery.trim().toLowerCase();
  const matches = (member: Member) =>
    `${member.nickname ?? ""} ${member.display_name ?? ""} ${member.email} ${member.id}`
      .toLowerCase()
      .includes(query);
  // Every account is an independent L0 root. Descendants remain visible beneath
  // each root so the referral relationship is still available as context.
  const { agentGroups, directMembers } = useMemo(() => {
    const childrenOf = (parentId: string) => {
      const seen = new Set<string>();
      return allMembers.filter((member) => {
        const isChild =
          member.referrer_id === parentId || member.parent_id === parentId;
        if (!isChild || seen.has(member.id)) return false;
        seen.add(member.id);
        return true;
      });
    };
    return {
      agentGroups: allMembers.map((agent) => ({
        agent,
        children: childrenOf(agent.id),
      })),
      directMembers: [] as Member[],
    };
  }, [allMembers]);
  // Apply the name/email/ID search across both levels.
  const filteredDirect = directMembers.filter(matches);
  const filteredAgentGroups = agentGroups
    .map((group) => ({
      agent: group.agent,
      children: group.children.filter(matches),
    }))
    .filter((group) => matches(group.agent) || group.children.length > 0);
  const hasResults =
    filteredDirect.length > 0 || filteredAgentGroups.length > 0;
  const renderDescendants = (parentId: string, depth: 1 | 2, indent = 16): JSX.Element[] => {
    if (depth > 2) return [];
    return allMembers
      .filter((member) => member.referrer_id === parentId || member.parent_id === parentId)
      .map((member) => (
        <div key={`${parentId}-${member.id}`} className="flex flex-col">
          <div className="flex items-center gap-3 border-t border-slate-800 py-4 pr-5" style={{ paddingLeft: indent }}>
            <MemberIdentity
              member={member}
              badge={uiText(language, depth === 1 ? "L1 회원" : "L2 회원", depth === 1 ? "L1 會員" : "L2 會員")}
              onOpen={() => setSelectedMemberId(member.id)}
            />
          </div>
          {renderDescendants(member.id, (depth + 1) as 1 | 2, indent + 32)}
        </div>
      ));
  };
  const selectedMember =
    allMembers.find((m) => m.id === selectedMemberId) ?? null;
  // 彙總卡一律資料資料 JC 呈現（分潤金額已直接以 JC 記於 commission_logs）。
  const totals = useMemo(
    () => ({
      personal: commissions
        .filter(
          (x) =>
            x.bonus_type === "l1" ||
            x.bonus_type === "personal" ||
            x.bonus_type === "self_rebate",
        )
        .reduce((s, x) => s + Number(x.commission_amount), 0),
      team: commissions
        .filter((x) => x.bonus_type === "l2" || x.bonus_type === "team")
        .reduce((s, x) => s + Number(x.commission_amount), 0),
    }),
    [commissions],
  );
  // Resolve a commission's buyer_id (下單用戶) into a readable name + email.
  // Downline buyers come from the members list; the agent's own investments
  // resolve to 本人 via the profile.
  const memberById = useMemo(() => {
    const map = new Map<string, { name: string; email: string }>();
    for (const member of allMembers) {
      map.set(member.id, {
        name:
          member.nickname || member.display_name || member.email.split("@")[0],
        email: member.email,
      });
    }
    if (data?.profile) {
      map.set(data.profile.id, { name: uiText(language, "본인", "本人"), email: data.profile.email });
    }
    return map;
  }, [allMembers, data, language]);
  // Commission records for the currently opened bonus card, newest first.
  const bonusCommissions = useMemo(() => {
    if (!bonusModal) return [];
    return commissions
      .filter((commission) =>
        bonusModal === "l1"
          ? commission.bonus_type === "l1" ||
            commission.bonus_type === "personal" ||
            commission.bonus_type === "self_rebate"
          : commission.bonus_type === "l2",
      )
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }, [commissions, bonusModal]);
  const copy = async () => {
    if (!data?.profile.promo_code) return;
    await navigator.clipboard.writeText(data.profile.promo_code);
    setNotice(uiText(language, "추천 코드가 복사되었습니다.", "推廣碼已複製"));
  };
  const openReferralQr = () => {
    if (!data?.profile.promo_code) return;
    setQrImage("");
    setQrError("");
    setReferralUrl(buildReferralUrl(window.location.origin, data.profile.promo_code));
    setReferralQrOpen(true);
  };
  const copyReferralLink = async () => {
    if (!referralUrl) return;
    await navigator.clipboard.writeText(referralUrl);
    setNotice(uiText(language, "추천 링크가 복사되었습니다.", "推廣連結已複製"));
  };
  const memberRole = (role: string) =>
    roleLabel(["代理", "一代代理", "二代代理", "總代理"].includes(role) ? "代理" : "一般用戶");
  const tradeLabel = (entryType: Trade["entry_type"]) => {
    const labels = {
      private_purchase: uiText(language, "프라이빗 청약", "私資料資料認購"),
      secondary_buy: uiText(language, "2차 시장 매수", "二級買入"),
      secondary_sell: uiText(language, "2차 시장 매도", "二級賣出"),
      p2p_buy: uiText(language, "2차 시장 매수", "二級買入"),
      p2p_sell: uiText(language, "2차 시장 매도", "二級賣出"),
    };
    return labels[entryType];
  };
  if (loading)
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-400">
        {uiText(language, "에이전트 정보를 불러오는 중…", "載入代理資料中…")}
      </div>
    );
  if (!data)
    return (
      <Notice
        tone="error"
        message={
          loadError
            ? `${uiText(language, "에이전트 센터를 불러올 수 없습니다.", "代理中心目前無法載入。請先套用最新資料庫腳本；錯誤：")}${loadError}`
            : uiText(language, "에이전트 센터를 불러올 수 없습니다.", "代理中心目前無法載入，請稍後再試。")
        }
      />
    );
  return (
    <div className="flex flex-col gap-7">
      <AnnouncementFeed />
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold tracking-[.18em] text-amber-300">
            AGENCY NETWORK
          </p>
          <h1 className="mt-2 text-3xl font-bold">{uiText(language, "에이전트 운영 센터", "代理營運中心")}</h1>
          <p className="mt-2 text-sm text-slate-400">
            {roleLabel(data.profile.agency_role)} · {data.profile.email}
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
          <button
            type="button"
            onClick={() => void copy()}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 font-mono font-bold text-amber-200 sm:w-auto"
          >
            <Copy className="size-4" />
            {data.profile.promo_code}
          </button>
          <button
            type="button"
            onClick={openReferralQr}
            className="inline-flex items-center gap-2 self-end rounded-lg px-2 py-1 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/10 hover:text-amber-100"
          >
            <QrCode className="size-4" aria-hidden="true" />
            {uiText(language, "QR 코드 추천", "QR Code 推廣碼")}
          </button>
        </div>
      </header>
      {notice && <Notice tone="success" message={notice} />}
      <div className="space-y-1 text-xs text-slate-500">
              <p>{commissionCopy[0]}</p>
        <p>{commissionCopy[1]}</p>
        <p>{commissionCopy[2]}</p>
      </div>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          language={language}
          icon={<Users />}
  label={uiText(language, "L1 + L2 회원", "L1 + L2 會員")}
  value={String(teamMemberCount)}
        />
        <Metric
          language={language}
          icon={<TrendingUp />}
          label={uiText(language, "이번 달 신규 유효 회원", "本月新增有效會員")}
          value={String(newEffectiveCount)}
        />
        <Metric
          language={language}
          icon={<BadgeDollarSign />}
          label={uiText(language, "資料資料택 기간 개인 보너스", "篩選期間個人獎金")}
          value={formatJC(totals.personal)}
          hint={
            data.profile.agency_role === "總代理"
              ? uiText(language, "직속 회��과 본인 투자로 발생한 資料資料미션", "L1 會員與您本人投資帶來的分潤")
              : uiText(language, "본인 투자로 발생한 커미션", "您本人投資帶來的分潤")
          }
          onClick={() => setBonusModal("l1")}
        />
        <Metric
          language={language}
          icon={<Network />}
          label={uiText(language, "선택 기간 팀 보너스", "篩選期間團隊獎金")}
          value={formatJC(totals.team)}
          hint={
            data.profile.agency_role === "總資料資料資料理"
              ? uiText(language, "에이전트와 하위 일반 회원이 資料資料資料생시킨 커미션", "L1 與 L2 會員帶來的分潤")
              : uiText(language, "하위 일반 회��이 발생시킨 資料資��資料資料資料션", "L2 會員帶來的分潤")
          }
          onClick={() => setBonusModal("l2")}
        />
      </section>
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-lg font-bold">{uiText(language, "누적 추가 보너스 진행 상황", "動態加碼進度")}</h2>
        <div className="mt-3 flex items-center justify-between">
          <p className="text-sm text-slate-400">{uiText(language, "현재 적용 중인 추가 보너스 비율", "目前已生效加資料資料百分點")}</p>
          <b className="text-2xl text-amber-300">
            +{Number(data.boost_rate) * 100}%
          </b>
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-800">
          <div
            className="h-full bg-amber-400"
            style={{
              width: `${Math.min(100, (newEffectiveCount / 5) * 100)}%`,
            }}
          />
        </div>
      </section>
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-xl font-bold">{uiText(language, "회원 거래 및 커미션 내역", "用戶交易與分潤紀錄")}</h2>
            <p className="mt-1 text-sm text-slate-400">
              {uiText(language, "에이전트 또는 일반 회원을 선택하면 상세 내역을 확인할 수 있습니다.", "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。")}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="relative w-full sm:w-72">
              <span className="sr-only">{uiText(language, "이름으로 검색", "依名稱查詢")}</span>
              <Search className="absolute left-3 top-3 size-4 text-slate-500" />
              <input
                value={nameQuery}
                onChange={(event) => setNameQuery(event.target.value)}
                placeholder={uiText(language, "이름, 이메일 또는 사용자 ID", "名稱、Email 或 User ID")}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 py-2.5 pl-10 pr-3"
              />
            </label>
            <label className="text-xs text-slate-400">
              {uiText(language, "시작일", "開始日期")}
              <input
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                className="mt-1 block rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm text-slate-200"
              />
            </label>
            <label className="text-xs text-slate-400">
              {uiText(language, "종료일", "結束日期")}
              <input
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                className="mt-1 block rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm text-slate-200"
              />
            </label>
            <button
              type="button"
              onClick={() => {
                setFrom("");
                setTo("");
              }}
              className="self-end rounded-lg border border-slate-700 px-4 py-2 text-sm"
            >
              {uiText(language, "기간 초기화", "清除時間")}
            </button>
          </div>
        </div>
        <div className="flex flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
          {filteredAgentGroups.map(({ agent, children }) => {
            const expanded = expandedAgentId === agent.id || query.length > 0;
            return (
              <div
                key={agent.id}
                className="border-b border-slate-800 last:border-b-0"
              >
                <div className="flex items-center gap-3 p-5">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() =>
                      setExpandedAgentId(expanded ? null : agent.id)
                    }
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-slate-700 text-amber-300 hover:border-amber-400"
                  >
                    <ChevronDown
                      className={`size-4 transition-transform ${expanded ? "rotate-180" : ""}`}
                    />
                  </button>
                  <MemberIdentity
                    member={agent}
                    badge={uiText(language, "독립 L0 에이전트", "獨立 L0 代理商")}
                    onOpen={() => setSelectedMemberId(agent.id)}
                  />
                  <span className="ml-auto shrink-0 text-xs text-slate-500">
                    {language === "ko" ? `하위 회원 ${children.length}명` : `${children.length} 位下線`}
                  </span>
                </div>
                {expanded && (
                  <div className="flex flex-col border-t border-slate-800 bg-slate-950/40">
                    {children.length === 0 ? (
                      <p className="px-5 py-4 pl-16 text-sm text-slate-500">
                        {uiText(language, "이 에이전트의 하위 회원이 없습니다.", "此 L1 會員目前沒有 L2 會員")}
                      </p>
                    ) : (
                      renderDescendants(agent.id, 1, 64)
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {filteredDirect.map((member) => (
            <div
              key={member.id}
              className="flex items-center gap-3 border-b border-slate-800 p-5 last:border-b-0"
            >
              <MemberIdentity
                member={member}
                badge={uiText(language, "L1 회원", "L1 會員")}
                onOpen={() => setSelectedMemberId(member.id)}
              />
            </div>
          ))}
          {!hasResults && (
            <p className="p-8 text-center text-sm text-slate-500">
              {uiText(language, "검색 조건에 맞는 회원이 ���습니다.", "找不到符合條件的用戶")}
            </p>
          )}
        </div>
      </section>
      <Modal
        open={!!selectedMember}
        onClose={() => setSelectedMemberId(null)}
        title={uiText(language, "회원 상세 내역", "用戶詳細紀錄")}
        wide
      >
        {selectedMember && (
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-amber-400 text-lg font-bold text-slate-950">
                {(selectedMember.nickname ||
                  selectedMember.display_name ||
                  selectedMember.email)[0].toUpperCase()}
              </span>
              <div className="min-w-0">
                <b className="block truncate text-slate-100">
                  {selectedMember.nickname ||
                    selectedMember.display_name ||
                    selectedMember.email.split("@")[0]}
                </b>
                <span className="block truncate text-xs text-slate-400">
                  {selectedMember.email}
                </span>
              </div>
              <span className="ml-auto shrink-0 rounded-full border border-slate-700 px-2.5 py-1 text-xs text-slate-300">
                {memberRole(selectedMember.agency_role)}
              </span>
            </div>
            <div className="grid gap-3 text-sm sm:grid-cols-3">
              <RecordMetric
                label={uiText(language, "이번 달 투자", "本月投資")}
                value={formatJC(monthlyStatsByMember.get(selectedMember.id)?.investment ?? 0)}
              />
              <RecordMetric
                label={uiText(language, "수수료", "手續費")}
                value={formatJC(monthlyStatsByMember.get(selectedMember.id)?.fees ?? 0)}
              />
              <RecordMetric
                label={uiText(language, "회원 상태", "會員狀態")}
                value={
                  (monthlyStatsByMember.get(selectedMember.id)?.investment ?? 0) >= 100
                    ? uiText(language, "유효", "有效")
                    : uiText(language, "기준 미달", "未達門檻")
                }
              />
            </div>
            <RecordTable
              title={uiText(language, "거래 내역", "交易紀錄")}
              empty={uiText(language, "선택한 기간에 거래 내역이 없습니다.", "所選時間內沒有交易紀錄")}
              headers={[uiText(language, "시간", "時間"), uiText(language, "유형", "類型"), uiText(language, "자산", "標的"), uiText(language, "수량", "份額"), uiText(language, "거래 금액", "交易金額"), uiText(language, "수수료", "手續費")]}
            >
              {trades
                .filter(
                  (trade) =>
                    trade.user_id === selectedMember.id &&
                    isTransactionHistoryVisible(trade.created_at),
                )
                .map((trade) => (
                  <tr key={trade.id} className="border-t border-slate-800">
                    <Td>{new Date(trade.created_at).toLocaleString()}</Td>
                    <Td>{tradeLabel(trade.entry_type)}</Td>
                    <Td>{trade.asset_id}</Td>
                    <Td>{Number(trade.quantity).toLocaleString()}</Td>
                    <Td>{formatJC(trade.gross)}</Td>
                    <Td>{formatJC(trade.fee)}</Td>
                  </tr>
                ))}
            </RecordTable>
            <RecordTable
              title={uiText(language, "커미션 내資料資料資料", "分潤紀錄")}
              empty={uiText(language, "선택한 기간에 이 회원으로 인해 발생한 커미션이 資料資料資料습니다.", "所選時間內沒有因該用戶產生的分潤紀錄")}
              headers={[uiText(language, "시간", "時間"), uiText(language, "보너스 유형", "獎金類型"), uiText(language, "거래 유형", "交易類型"), uiText(language, "거래 금액", "交易金額"), uiText(language, "비율", "比例"), uiText(language, "보너스", "獎金"), uiText(language, "지급 상태", "發放狀態")]}
            >
              {commissions
                .filter(
                  (commission) =>
                  commission.buyer_id === selectedMember.id &&
                  isTransactionHistoryVisible(commission.created_at),
                )
                .map((commission) => (
                  <tr key={commission.id} className="border-t border-slate-800">
                    <Td>{new Date(commission.created_at).toLocaleString()}</Td>
                    <Td>
                      {commission.bonus_type === "l1" || commission.bonus_type === "personal" ? "L1" : "L2"}
                    </Td>
                    <Td>
                      {
                        getCommissionTypeMeta(commission.transaction_type)
                          .label
                      }
                    </Td>
                    <Td>{formatJC(commission.transaction_amount)}</Td>
                    <Td>{Number(commission.effective_rate) * 100}%</Td>
                    <Td>
                      <b className="text-amber-200">
                        {formatJC(commission.commission_amount)}
                      </b>
                    </Td>
                    <Td>
                      <PayoutStatus paidAt={commission.paid_at} language={language} />
                    </Td>
                  </tr>
                ))}
            </RecordTable>
          </div>
        )}
      </Modal>
      <Modal
        open={!!bonusModal}
        onClose={() => setBonusModal(null)}
        title={uiText(language, bonusModal === "l2" ? "L2 커미션 기록" : "L1 커미션 기록", bonusModal === "l2" ? "L2分潤紀錄" : "L1分潤紀錄")}
        wide
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-400">
              {bonusModal === "l2"
                ? uiText(language, "에이전트와 하위 일반 회원의 주문으로 발생한 커미션", "L1 與 L2 會員下單所產生的分潤")
                : data.profile.agency_role === "總代理"
                  ? uiText(language, "본인과 직속 회원의 주문으로 발생한 커미션", "您本人與 L1 會員下單所產生的分潤")
                  : uiText(language, "본인 투자 주문으로 발생한 커미션", "您本人投資下單所產生的分潤")}
            </p>
            <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-sm font-bold text-amber-200">
              {uiText(language, "합��", "合計")} {" "}
              {formatJC(bonusModal === "l2" ? totals.team : totals.personal)}
            </span>
          </div>
          <RecordTable
            title={uiText(language, "커미션 상세 내역", "分潤明細")}
            empty={uiText(language, "선택한 기간에 커미션 내資料資料이 없습니다.", "所選時間內沒有分潤紀錄")}
            headers={[uiText(language, "시간", "時間"), uiText(language, "주문 회원", "下單用戶"), uiText(language, "거래 유형", "交易類型"), uiText(language, "거래 금액", "交易金額"), uiText(language, "비율", "比例"), uiText(language, "보너스", "獎金"), uiText(language, "지급 상태", "發放狀態")]}
          >
            {bonusCommissions
              .filter((commission) => isTransactionHistoryVisible(commission.created_at))
              .map((commission) => {
              const buyer = memberById.get(commission.buyer_id);
              return (
                <tr key={commission.id} className="border-t border-slate-800">
                  <Td>{new Date(commission.created_at).toLocaleString()}</Td>
                  <Td>
                    <span className="block text-slate-200">
                      {buyer?.name ?? uiText(language, "알 수 없는 회원", "未知用戶")}
                    </span>
                    <span className="block text-xs text-slate-500">
                      {buyer?.email ?? commission.buyer_id}
                    </span>
                  </Td>
                  <Td>
                    {getCommissionTypeMeta(commission.transaction_type).label}
                  </Td>
                  <Td>{formatJC(commission.transaction_amount)}</Td>
                  <Td>{Number(commission.effective_rate) * 100}%</Td>
                  <Td>
                    <b className="text-amber-200">
                      {formatJC(commission.commission_amount)}
                    </b>
                  </Td>
                  <Td>
                    <PayoutStatus paidAt={commission.paid_at} language={language} />
                  </Td>
                </tr>
              );
            })}
          </RecordTable>
        </div>
      </Modal>
      <Modal
        open={referralQrOpen}
        onClose={() => setReferralQrOpen(false)}
        title={qrText.title}
      >
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="max-w-md text-sm leading-6 text-slate-300">
            {qrText.description}
          </p>
          <div className="flex min-h-72 min-w-72 items-center justify-center rounded-2xl border border-slate-700 bg-white p-4">
            {qrImage ? (
              <img
                src={qrImage}
                alt={qrText.alt}
                className="size-64 max-w-full"
              />
            ) : qrError ? (
              <p role="alert" className="text-sm text-red-600">{qrError}</p>
            ) : (
              <p role="status" className="text-sm text-slate-600">{qrText.generating}</p>
            )}
          </div>
          <div className="w-full rounded-xl border border-slate-700 bg-slate-950/60 p-3 text-left">
            <p className="mb-1 text-xs font-semibold text-slate-400">{qrText.link}</p>
            <p className="break-all font-mono text-xs leading-5 text-slate-200">{referralUrl}</p>
          </div>
          <button
            type="button"
            onClick={() => void copyReferralLink()}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/20"
          >
            <Copy className="size-4" aria-hidden="true" />
            {qrText.copy}
          </button>
        </div>
      </Modal>
    </div>
  );
}
// 逐筆分潤的派發狀態徽章。paid_at 不為 null 代表已由平台熱錢包上鏈發放到受益人錢包。
function PayoutStatus({ paidAt, language }: { paidAt: string | null; language: import("@/platform").Lang }) {
  const uiText = (languageArg: import("@/platform").Lang, korean: string, fallback: string) => {
  return localizedUiText(languageArg, korean, fallback);
  };
  if (paidAt) {
    return (
      <span
        className="inline-flex items-center rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-300 ring-1 ring-emerald-500/20"
        title={uiText(language, `${new Date(paidAt).toLocaleString(language)} 온체인 지급 완료`, `已於 ${new Date(paidAt).toLocaleString(language)} 上鏈發放`)}
      >
        {uiText(language, "지급 완료", "已發放")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-300 ring-1 ring-amber-500/20">
      {uiText(language, "지급 대기", "待發放")}
    </span>
  );
}
function MemberIdentity({
  member,
  badge,
  onOpen,
}: {
  member: Member;
  badge: string;
  onOpen: () => void;
}) {
  const name =
    member.nickname || member.display_name || member.email.split("@")[0];
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-400 font-bold text-slate-950">
        {(member.nickname || member.display_name || member.email)[0].toUpperCase()}
      </span>
      <span className="min-w-0">
        <button
          type="button"
          onClick={onOpen}
          className="block max-w-full truncate text-left font-bold text-slate-100 hover:text-amber-200"
        >
          {name}
        </button>
        <span className="block truncate text-xs text-slate-400">
          {member.email}
        </span>
      </span>
      <span className="shrink-0 rounded-full border border-slate-700 px-2.5 py-1 text-xs text-slate-300">
        {badge}
      </span>
    </div>
  );
}
function RecordMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-3">
      <span className="text-xs text-slate-500">{label}</span>
      <b className="mt-1 block text-slate-200">{value}</b>
    </div>
  );
}
function RecordTable({
  title,
  headers,
  empty,
  children,
}: {
  title: string;
  headers: string[];
  empty: string;
  children: React.ReactNode;
}) {
  const hasRows = Array.isArray(children)
    ? children.length > 0
    : Boolean(children);
  return (
    <section>
      <h3 className="mb-2 font-bold text-slate-200">{title}</h3>
      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
        {hasRows ? (
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="text-slate-500">
                {headers.map((header) => (
                  <Th key={header}>{header}</Th>
                ))}
              </tr>
            </thead>
            <tbody>{children}</tbody>
          </table>
        ) : (
          <p className="p-5 text-center text-sm text-slate-500">{empty}</p>
        )}
      </div>
    </section>
  );
}
function Metric({
  icon,
  label,
  value,
  hint,
  onClick,
  language,
}: {
  icon: React.ReactNode;
  language: import("@/platform").Lang;
  label: string;
  value: string;
  hint?: string;
  onClick?: () => void;
}) {
  const uiText = (languageArg: import("@/platform").Lang, korean: string, fallback: string) => {
  return localizedUiText(languageArg, korean, fallback);
  };
  const body = (
    <>
      <span className="text-amber-300">{icon}</span>
      <p className="mt-4 text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-bold">{value}</p>
      {hint ? (
        <p className="mt-2 text-[11px] leading-relaxed text-slate-600">{hint}</p>
      ) : null}
      {onClick ? (
        <p className="mt-2 text-[11px] font-semibold text-amber-300/80">
          {uiText(language, "커미션 내역 보기 →", "點擊查看分潤紀錄 →")}
        </p>
      ) : null}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="rounded-2xl border border-slate-800 bg-slate-900 p-5 text-left transition hover:border-amber-400/60 hover:bg-slate-900/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
      >
        {body}
      </button>
    );
  }
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      {body}
    </div>
  );
}
function Th({ children }: { children: React.ReactNode }) {
  return <th className="border-b border-slate-800 px-5 py-3">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-5 py-4 text-slate-400">{children}</td>;
}
