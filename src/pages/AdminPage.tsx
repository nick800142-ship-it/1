import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  ArrowLeft,
  BadgeDollarSign,
  Bell,
  Building2,
  ChartNoAxesCombined,
  Download,
  Landmark,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Modal, Notice } from "@/components/Modal";
import { supabase } from "@/lib/supabase";
import { getCommissionTypeMeta } from "@/lib/commission-types";
import { translateAdminContent } from "@/lib/translate";
import { LANGUAGES, useLanguage, type AssetTranslation, type Lang } from "@/platform";
import { AdminOperations } from "@/components/AdminOperations";
import { UserDetailView } from "@/components/UserDetailView";
import { AdminDashboard } from "@/components/AdminDashboard";
import { ClickableAssetImage } from "@/components/AssetImageGallery";
import { FormattedNumberInput } from "@/components/FormattedNumberInput";
import { useVisiblePolling } from "@/hooks/useVisiblePolling";
import {
  CommissionDateReport,
  downloadCsv,
  isWithinDateRange,
} from "@/components/CommissionDateReport";
import {
  SearchSuggest,
  type SearchSuggestion,
} from "@/components/SearchSuggest";

const keepStable = <T,>(previous: T, next: T): T =>
  JSON.stringify(previous) === JSON.stringify(next) ? previous : next;

type Module =
  | "dashboard"
  | "users"
  | "private"
  | "secondary"
  | "agency"
  | "announcements"
  | "payouts"
  | "earnings";
type Profile = {
  id: string;
  email: string;
  display_name: string | null;
  nickname: string | null;
  wallet_address: string | null;
  agency_role: string;
  parent_id: string | null;
  referrer_id: string | null;
  master_agent_id: string | null;
  created_at: string;
  last_seen_at: string | null;
};
type Ledger = {
  id: string;
  user_id: string;
  entry_type: string;
  amount: number;
  asset_id: string | null;
  quantity: number | null;
  metadata?: Record<string, unknown>;
  created_at: string;
};
type PlatformFee = {
  id: string;
  source_type: "p2p_fee" | "p2p_gas" | "private_principal" | "private_gas";
  payer_email: string;
  asset_id: string | null;
  amount: number;
  treasury_address: string;
  created_at: string;
};
type Placement = {
  id: string;
  name: string;
  location: string;
  address: string;
  image: string;
  images: string[];
  information: string;
  translations: Partial<Record<Lang, AssetTranslation>>;
  history: string[];
  comparables: string[];
  advantages: string[];
  price: number;
  change: number;
  available: number;
  total_supply: number;
  apy: string;
  valuation: number;
  ends_at: string;
  market_started_at: string | null;
  price_locked_until: string | null;
  is_active: boolean;
  is_delisted: boolean;
};
type Commission = {
  id: string;
  agent_id: string;
  buyer_id: string;
  asset_id: string | null;
  transaction_type: string;
  transaction_amount: number;
  commission_rate: number;
  commission_amount: number;
  created_at: string;
};
type Audit = {
  id: string;
  admin_email: string;
  action: string;
  target_type: string;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
};
type AgencyApplication = {
  id: string;
  user_id: string;
  requested_role: string;
  contact_name: string;
  contact_method: string;
  region: string;
  reason: string;
  master_promo_code: string | null;
  status: string;
  rejection_reason: string | null;
  created_at: string;
};
const modules = [
  {
    id: "dashboard" as const,
    label: "系統監控總覽",
    short: "總覽",
    icon: Landmark,
  },
  { id: "users" as const, label: "用戶與帳號", short: "用戶", icon: Users },
  {
    id: "private" as const,
    label: "私募標的物管理",
    short: "私募",
    icon: Building2,
  },
  {
    id: "secondary" as const,
    label: "二級市場標的物",
    short: "二級市場",
    icon: ChartNoAxesCombined,
  },
  {
    id: "agency" as const,
    label: "總代理及代理結構",
    short: "代理結構",
    icon: ShieldCheck,
  },
  {
    id: "announcements" as const,
    label: "公告管理",
    short: "公告",
    icon: Bell,
  },
  {
    id: "payouts" as const,
    label: "獎金派發",
    short: "獎金",
    icon: BadgeDollarSign,
  },
  {
    id: "earnings" as const,
    label: "交易報表與稽核",
    short: "報表",
    icon: BadgeDollarSign,
  },
];
const adminNavigationCopy: Record<Lang, { title: string; front: string; modules: Record<Module, string> }> = {
  "zh-TW": { title: "後台管理中心", front: "前台", modules: { dashboard: "系統監控總覽", users: "用戶與帳號", private: "私募標的物管理", secondary: "二級市場標的物", agency: "總代理及代理結構", announcements: "公告管理", payouts: "獎金派發", earnings: "交易報表與稽核" } },
  "zh-CN": { title: "后台管理中心", front: "前台", modules: { dashboard: "系统监控总览", users: "用户与账号", private: "私募标的管理", secondary: "二级市场标的", agency: "总代理及代理结构", announcements: "公告管理", payouts: "奖金发放", earnings: "交易报表与审核" } },
  en: { title: "Admin center", front: "Main site", modules: { dashboard: "System overview", users: "Users and accounts", private: "Private placements", secondary: "Secondary market", agency: "Agency structure", announcements: "Announcements", payouts: "Bonus payouts", earnings: "Reports and audit" } },
  ja: { title: "管理センター", front: "フロント", modules: { dashboard: "システム概要", users: "ユーザーとアカウント", private: "私募資産管理", secondary: "二次市場資産", agency: "代理店構造", announcements: "お知らせ管理", payouts: "ボーナス支給", earnings: "取引レポートと監査" } },
  ko: { title: "관리 센터", front: "메인 사이트", modules: { dashboard: "시스템 개요", users: "사용자 및 계정", private: "사모 자산 관리", secondary: "2차 시장 자산", agency: "대리점 구조", announcements: "공지 관리", payouts: "보너스 지급", earnings: "거래 보고서 및 감사" } },
  th: { title: "ศูนย์ผู้ดูแลระบบ", front: "หน้าหลัก", modules: { dashboard: "ภาพรวมระบบ", users: "ผู้ใช้และบัญชี", private: "การจัดการสินทรัพย์เสนอขายส่วนตัว", secondary: "สินทรัพย์ตลาดรอง", agency: "โครงสร้างตัวแทน", announcements: "จัดการประกาศ", payouts: "จ่ายโบนัส", earnings: "รายงานและการตรวจสอบ" } },
  vi: { title: "Trung tâm quản trị", front: "Trang chính", modules: { dashboard: "Tổng quan hệ thống", users: "Người dùng và tài khoản", private: "Quản lý tài sản phát hành riêng lẻ", secondary: "Tài sản thị trường thứ cấp", agency: "Cơ cấu đại lý", announcements: "Quản lý thông báo", payouts: "Phân phối thưởng", earnings: "Báo cáo và kiểm toán" } },
  id: { title: "Pusat admin", front: "Situs utama", modules: { dashboard: "Ringkasan sistem", users: "Pengguna dan akun", private: "Pengelolaan penempatan privat", secondary: "Aset pasar sekunder", agency: "Struktur agen", announcements: "Kelola pengumuman", payouts: "Pembayaran bonus", earnings: "Laporan dan audit" } },
  ms: { title: "Pusat pentadbir", front: "Laman utama", modules: { dashboard: "Gambaran sistem", users: "Pengguna dan akaun", private: "Pengurusan penempatan persendirian", secondary: "Aset pasaran sekunder", agency: "Struktur ejen", announcements: "Urus pengumuman", payouts: "Pembayaran bonus", earnings: "Laporan dan audit" } },
  es: { title: "Centro de administración", front: "Sitio principal", modules: { dashboard: "Resumen del sistema", users: "Usuarios y cuentas", private: "Colocaciones privadas", secondary: "Mercado secundario", agency: "Estructura de agentes", announcements: "Anuncios", payouts: "Pago de bonos", earnings: "Informes y auditoría" } },
  fr: { title: "Centre d’administration", front: "Site principal", modules: { dashboard: "Vue d’ensemble du système", users: "Utilisateurs et comptes", private: "Placements privés", secondary: "Marché secondaire", agency: "Structure des agents", announcements: "Annonces", payouts: "Versement des bonus", earnings: "Rapports et audit" } },
  de: { title: "Admin-Center", front: "Hauptseite", modules: { dashboard: "Systemübersicht", users: "Benutzer und Konten", private: "Privatplatzierungen", secondary: "Sekundärmarkt", agency: "Agentenstruktur", announcements: "Ankündigungen", payouts: "Bonusauszahlungen", earnings: "Berichte und Prüfung" } },
  pt: { title: "Centro administrativo", front: "Site principal", modules: { dashboard: "Visão geral do sistema", users: "Utilizadores e contas", private: "Colocações privadas", secondary: "Mercado secundário", agency: "Estrutura de agentes", announcements: "Anúncios", payouts: "Pagamento de bónus", earnings: "Relatórios e auditoria" } },
  ru: { title: "Центр администратора", front: "Главная", modules: { dashboard: "Обзор системы", users: "Пользователи и аккаунты", private: "Частные размещения", secondary: "Вторичный рынок", agency: "Структура агентов", announcements: "Объявления", payouts: "Выплата бонусов", earnings: "Отчёты и аудит" } },
  ar: { title: "مركز الإدارة", front: "الموقع الرئيسي", modules: { dashboard: "نظرة عامة على النظام", users: "المستخدمون والحسابات", private: "الطروحات الخاصة", secondary: "السوق الثانوية", agency: "هيكل الوكلاء", announcements: "إدارة الإعلانات", payouts: "صرف المكافآت", earnings: "الت����رير والتدقيق" } },
  hi: { title: "व्यवस्थापन केंद्र", front: "मुख्य साइट", modules: { dashboard: "सिस्टम अवलोकन", users: "उपयोगकर्ता और खाते", private: "निजी प्लेसमेंट प्रबंधन", secondary: "द्वितीयक बाज़ार एसेट", agency: "एजेंट संरचना", announcements: "घोषणा प्रबंधन", payouts: "बोनस वितरण", earnings: "रिपोर्ट और ऑडिट" } },
};

const includes = (values: unknown[], query: string) =>
  values.some((value) =>
    String(value ?? "")
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
const money = (value: number) =>
  `${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
const ledgerTypeLabel: Record<string, string> = {
  sandbox_deposit: "測試入金",
  private_purchase: "私募認購",
  secondary_buy: "舊二級市場買入",
  secondary_sell: "舊二級市場賣出",
  p2p_buy: "P2P 買方支付",
  p2p_sell: "P2P 賣方實收",
  commission: "代理分潤",
  commission_pending: "待發放分潤",
  commission_payout: "代理分潤發放",
};
const formatLedgerType = (entryType: string) =>
  ledgerTypeLabel[entryType] ?? "其他資產異動";
const ONLINE_WINDOW_MS = 120_000;
const taipeiDateTime = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const formatLastSeen = (value: string | null) => {
  if (!value) return "尚無紀錄";
  const parts = Object.fromEntries(
    taipeiDateTime
      .formatToParts(new Date(value))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
};
const isOnline = (value: string | null, now: number) => {
  if (!value) return false;
  const elapsed = now - new Date(value).getTime();
  return elapsed >= 0 && elapsed < ONLINE_WINDOW_MS;
};
const compareLastSeen = (a: Profile, b: Profile, direction: "asc" | "desc") => {
  if (!a.last_seen_at) return b.last_seen_at ? 1 : 0;
  if (!b.last_seen_at) return -1;
  const difference =
    new Date(a.last_seen_at).getTime() - new Date(b.last_seen_at).getTime();
  return direction === "asc" ? difference : -difference;
};
function LastSeenStatus({ value, now }: { value: string | null; now: number }) {
  const online = isOnline(value, now);
  return (
    <span className="flex min-w-48 flex-col items-start gap-1 text-xs">
      <span
        className={`inline-flex items-center gap-2 ${online ? "text-emerald-300" : "text-slate-400"}`}
      >
        <span
          aria-hidden="true"
          className={`size-2 rounded-full ${online ? "bg-emerald-300" : "bg-slate-400"}`}
        />
        {online ? "線上" : "離線"}
      </span>
      <span className="text-slate-500">最後上線時間（台北）</span>
      <time
        className="font-mono text-slate-400"
        dateTime={value ?? undefined}
        title={value ? new Date(value).toISOString() : undefined}
      >
        {formatLastSeen(value)}
      </time>
    </span>
  );
}
const csv = (name: string, headers: string[], rows: unknown[][]) => {
  const escape = (value: unknown) =>
    `"${String(value ?? "")
      .split('"')
      .join('""')}"`;
  const body = [headers, ...rows]
    .map((row) => row.map(escape).join(","))
    .join("\n");
  const blob = new Blob([`\ufeff${body}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
};

export function AdminPage({ onExit }: { onExit: () => void }) {
  const { language } = useLanguage();
  const copy = adminNavigationCopy[language];
  const [module, setModule] = useState<Module>("dashboard");
  const [detailUserId, setDetailUserId] = useState<string | null>(null);
 const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState("");
  const refreshAdminData = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshMessage("");
 window.dispatchEvent(new Event("platform-assets-updated"));
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    setRefreshing(false);
    setRefreshMessage("資料已刷新");
  };
  const openUserDetail = (userId: string) => {
    setDetailUserId(userId);
  };
  return (
    <div className="min-h-screen max-w-full overflow-x-hidden">
      <div className="flex min-h-screen max-w-full flex-col lg:flex-row">
        <aside className="hidden w-64 shrink-0 border-r border-slate-800 bg-slate-900/60 p-5 lg:flex lg:flex-col">
          <div className="border-b border-slate-800 pb-5">
            <p className="text-xs font-bold tracking-[.18em] text-amber-300">
              SANDBOX CONTROL
            </p>
            <h1 className="mt-2 text-xl font-bold text-white">{copy.title}</h1>
          </div>
          <nav className="mt-5 flex flex-1 flex-col gap-1">
            {modules.map(({ id, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setModule(id)}
                className={`flex items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium ${module === id ? "bg-amber-400 text-slate-950" : "text-slate-400 hover:bg-slate-800"}`}
              >
                <Icon className="size-5" />
                {copy.modules[id]}
              </button>
            ))}
          </nav>
          <button
            onClick={onExit}
            className="flex items-center justify-center gap-2 rounded-xl border border-slate-700 px-4 py-3 text-sm font-semibold"
          >
            <ArrowLeft className="size-4" />
            {copy.front}
          </button>
        </aside>
        <div className="min-w-0 flex-1">
          <header className="flex items-center justify-between border-b border-slate-800 px-4 py-4 sm:px-6 lg:px-8">
            <div>
              <p className="text-xs font-bold text-amber-300">
                測試階段 · Sandbox
              </p>
              <h2 className="text-lg font-bold">{copy.modules[module]}</h2>
            </div>
            <div className="flex items-center gap-2">
              <span className="sr-only" role="status" aria-live="polite">
                {refreshing ? "正在刷新資料" : refreshMessage}
              </span>
              <button
                type="button"
                onClick={() => void refreshAdminData()}
                disabled={refreshing}
                className="flex min-w-28 items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:border-amber-400/60 hover:text-amber-200 disabled:cursor-wait disabled:opacity-60"
              >
                <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
                {refreshing ? "刷新中…" : "刷新數據"}
              </button>
              <button
                onClick={onExit}
                className="rounded-lg border border-slate-700 px-3 py-2 text-xs lg:hidden"
              >
                {copy.front}
              </button>
            </div>
          </header>
          <nav className="mobile-bottom-nav fixed inset-x-0 bottom-0 z-50 flex min-h-20 overflow-x-auto border-t border-slate-800 bg-slate-950/95 px-2 pt-2 backdrop-blur lg:hidden">
            {modules.map(({ id, short, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setModule(id)}
                aria-current={module === id ? "page" : undefined}
                className={`flex min-w-20 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-3 py-2 text-xs ${module === id ? "bg-amber-400 text-slate-950" : "text-slate-400"}`}
              >
                <Icon className="size-4" />
                <span>{short}</span>
              </button>
            ))}
          </nav>
          <main className="p-4 pb-32 sm:p-6 sm:pb-32 lg:p-8">
            {module === "dashboard" && (
              <AdminDashboard onViewUser={openUserDetail} />
            )}
            {module === "users" && (
              <UsersModule onOpenDetail={openUserDetail} />
            )}
            {module === "private" && <PrivateModule />}
            {module === "secondary" && <SecondaryModule />}
            {module === "agency" && (
              <div className="flex flex-col gap-8">
                <AgencyApplications />
                <AgencyModule onOpenDetail={openUserDetail} />
              </div>
            )}
            {module === "earnings" && <ReportsModule />}
            {module === "announcements" && (
              <AdminOperations mode="announcements" />
            )}
            {module === "payouts" && <AdminOperations mode="payouts" />}
          </main>
        </div>
      </div>
      <Modal
        open={!!detailUserId}
        onClose={() => setDetailUserId(null)}
        title="用戶詳細紀錄"
        wide
      >
        {detailUserId && (
          <UserDetailView
            userId={detailUserId}
            onBack={() => setDetailUserId(null)}
            embedded
          />
        )}
      </Modal>
    </div>
  );
}

function useAdminData() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [commissions, setCommissions] = useState<Commission[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    const [p, l, pp, c, a] = await Promise.all([
      supabase
        .from("profiles")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase
        .from("asset_ledger")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase.rpc("admin_list_private_placements"),
      supabase
        .from("commission_logs")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase
        .from("admin_audit_logs")
        .select("*")
        .order("created_at", { ascending: false }),
    ]);
    setProfiles((previous) => keepStable(previous, (p.data ?? []) as Profile[]));
    setLedger((previous) => keepStable(previous, (l.data ?? []) as Ledger[]));
    setPlacements((previous) => keepStable(previous, (pp.data ?? []) as Placement[]));
    setCommissions((previous) => keepStable(previous, (c.data ?? []) as Commission[]));
    setAudits((previous) => keepStable(previous, (a.data ?? []) as Audit[]));
    setLoading(false);
  };
 useVisiblePolling(refresh, 1_000, true);
  return {
    profiles,
    ledger,
    placements,
    commissions,
    audits,
    loading,
    refresh,
  };
}

function useCurrentTime() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);
  return now;
}

function UsersModule({
  onOpenDetail,
}: {
  onOpenDetail: (userId: string) => void;
}) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [walletBalances, setWalletBalances] = useState<Record<string, number>>({});
  const [userCommissions, setUserCommissions] = useState<
    { beneficiary_id: string; commission_amount: number }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [walletSyncing, setWalletSyncing] = useState(false);
  const refresh = useCallback(async () => {
    const [
      profilesResult,
      ledgerResult,
      balancesResult,
      commissionsResult,
    ] = await Promise.all([
      supabase
        .from("profiles")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase
        .from("asset_ledger")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase.rpc("admin_list_wallet_balances"),
      supabase
        .from("commission_logs")
        .select("beneficiary_id,commission_amount"),
    ]);
    const firstError =
      profilesResult.error ??
      ledgerResult.error ??
      balancesResult.error ??
      commissionsResult.error;
    if (firstError) {
      setLoadError("用戶資料載入失敗，請稍後重新整理。");
      setWalletBalances({});
    }
    setProfiles((previous) => keepStable(previous, (profilesResult.data ?? []) as Profile[]));
    setLedger((previous) => keepStable(previous, (ledgerResult.data ?? []) as Ledger[]));
    if (!balancesResult.error) {
      const nextBalances = Object.fromEntries(
        ((balancesResult.data ?? []) as { user_id: string; balance: number }[]).map(
          (row) => [row.user_id, Number(row.balance)],
        ),
      );
      setWalletBalances((previous) => keepStable(previous, nextBalances));
    }
    setUserCommissions((previous) =>
      keepStable(
        previous,
        (commissionsResult.data ?? []) as {
          beneficiary_id: string;
          commission_amount: number;
        }[],
      ),
    );
    if (!firstError) setLoadError("");
    setLoading(false);
  }, []);
 useVisiblePolling(refresh, 1_000, true);
  const now = useCurrentTime();
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("全部");
  const [bonusSort, setBonusSort] = useState<"asc" | "desc">("desc");
  const [expandedMasters, setExpandedMasters] = useState<string[]>([]);
  const [expandedAgents, setExpandedAgents] = useState<string[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(
    null,
  );
  const balance = (id: string) => walletBalances[id] ?? 0;
  const investmentAmount = (id: string, entryType: string) =>
    ledger
      .filter((row) => row.user_id === id && row.entry_type === entryType)
      .reduce((sum, row) => sum + Math.abs(Number(row.amount)), 0);
  const bonusAmount = useCallback(
    (id: string) =>
      userCommissions
        .filter((row) => row.beneficiary_id === id)
        .reduce((sum, row) => sum + Number(row.commission_amount), 0),
    [userCommissions],
  );
  const shown = useMemo(
    () =>
      profiles
        .filter((user) => {
          const matchesRole =
            roleFilter === "全部" ||
            (roleFilter === "管理員"
              ? ["管理員", "admin"].includes(user.agency_role)
              : roleFilter === "代理"
                ? ["代理", "一代代理", "二代代理"].includes(user.agency_role)
                : roleFilter === "一般用戶"
                  ? ["一般用戶", "用戶", "user"].includes(user.agency_role)
                  : user.agency_role === roleFilter);
          const onlineLabel = isOnline(user.last_seen_at, now)
            ? "線上"
            : "離線";
          return (
            matchesRole &&
            includes(
              [
                user.email,
                user.id,
                user.wallet_address,
                user.nickname,
                user.display_name,
                user.agency_role,
                onlineLabel,
                formatLastSeen(user.last_seen_at),
              ],
              q,
            )
          );
        })
        .sort((a, b) => {
          const difference = bonusAmount(a.id) - bonusAmount(b.id);
          return bonusSort === "asc" ? difference : -difference;
        }),
    [profiles, q, roleFilter, bonusSort, bonusAmount, now],
  );
  const isMaster = (user: Profile) => user.agency_role === "總代理";
  const isAgent = (user: Profile) =>
    ["代理", "一代代理", "二代代理"].includes(user.agency_role);
  const isMember = (user: Profile) =>
    ["一般用戶", "用戶", "user"].includes(user.agency_role);
  const profileIds = new Set(shown.map((user) => user.id));
  const masters = shown.filter(isMaster);
  const agentsFor = (master: Profile) =>
    shown.filter(
      (user) =>
        isAgent(user) &&
        (user.master_agent_id === master.id ||
          user.parent_id === master.id ||
          user.referrer_id === master.id),
    );
  const membersFor = (parent: Profile) =>
    shown.filter(
      (user) =>
        isMember(user) &&
        (user.parent_id === parent.id || user.referrer_id === parent.id),
    );
  const assignedIds = new Set(
    masters.flatMap((master) => [
      master.id,
      ...agentsFor(master).flatMap((agent) => [
        agent.id,
        ...membersFor(agent).map((member) => member.id),
      ]),
      ...membersFor(master).map((member) => member.id),
    ]),
  );
  const standalone = shown.filter(
    (user) => profileIds.has(user.id) && !assignedIds.has(user.id),
  );
  const toggleExpanded = (
    id: string,
    setter: Dispatch<SetStateAction<string[]>>,
  ) =>
    setter((items) =>
      items.includes(id) ? items.filter((item) => item !== id) : [...items, id],
    );
  const backfillWallets = async () => {
    if (walletSyncing) return;
    setWalletSyncing(true);
    setNotice(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("登入狀態已失效，請重新登入");
      const response = await fetch("/api/backfill-wallets", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const result = (await response.json()) as {
        scanned?: number;
        updated?: number;
        skipped?: number;
        failed?: number;
        error?: string;
      };
      if (!response.ok && response.status !== 207) {
        throw new Error(result.error || "批次補齊失敗");
      }
      await refresh();
      const failed = result.failed ?? 0;
      setNotice({
        ok: failed === 0,
        text: `錢包同步完成：掃描 ${result.scanned ?? 0} 位，成功回寫 ${result.updated ?? 0} 位，略過 ${result.skipped ?? 0} 位${failed ? `，失敗 ${failed} 位` : ""}。`,
      });
    } catch (error) {
      setNotice({
        ok: false,
        text: error instanceof Error ? error.message : "批次補齊失敗，請稍後重試",
      });
    } finally {
      setWalletSyncing(false);
    }
  };
  const deposit = async (user: Profile) => {
    const amount = Number(amounts[user.id]);
    if (!Number.isFinite(amount) || amount <= 0) {
      setNotice({ text: "請輸入有效的測試 USDT 金額", ok: false });
      return;
    }
    const { error } = await supabase.rpc("sandbox_deposit", {
      target_user_id: user.id,
      deposit_amount: amount,
      request_key: crypto.randomUUID(),
    });
    if (error) {
      setNotice({ text: "發放失敗，請確認權限與金額", ok: false });
      return;
    }
    setNotice({ text: `已發放 ${money(amount)} 給 ${user.email}`, ok: true });
    setAmounts((value) => ({ ...value, [user.id]: "" }));
    await refresh();
    window.dispatchEvent(new Event("platform-assets-updated"));
  };
  const renderUserRow = (
    user: Profile,
    level = 0,
    expandable = false,
    expanded = false,
    onToggle?: () => void,
    label?: string,
  ) => (
    <tr key={`${user.id}-${level}`} className="border-t border-slate-800">
      <Td>
        <div
          className="flex items-start gap-2"
          style={{ paddingLeft: level * 20 }}
        >
          {expandable ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              className="mt-0.5 size-6 rounded-md border border-slate-700 text-xs text-amber-200"
            >
              {expanded ? "−" : "+"}
            </button>
          ) : (
            level > 0 && <span className="mt-3 h-px w-6 bg-slate-700" />
          )}
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onOpenDetail(user.id)}
                className="text-left font-bold text-slate-200 hover:text-amber-200"
              >
                {user.nickname || user.display_name || user.email.split("@")[0]}
              </button>
              <Tag>{label || user.agency_role}</Tag>
            </div>
            <span className="block text-xs text-slate-400">{user.email}</span>
            <span className="block text-xs">{user.id}</span>
          </div>
        </div>
      </Td>
      <Td>
        <LastSeenStatus value={user.last_seen_at} now={now} />
      </Td>
      <Td>
        <span className="block w-44 whitespace-normal break-all font-mono text-xs leading-5 text-slate-300">
          {user.wallet_address || "未綁定"}
        </span>
      </Td>
      <Td>
        <b className="text-amber-200">{money(balance(user.id))}</b>
      </Td>
      <Td>
        <span className="font-semibold text-slate-200">
          {money(investmentAmount(user.id, "private_purchase"))}
        </span>
      </Td>
      <Td>
        <span className="font-semibold text-slate-200">
          {money(investmentAmount(user.id, "secondary_buy"))}
        </span>
      </Td>
      <Td>
        <b className="text-amber-200">{money(bonusAmount(user.id))}</b>
      </Td>
      <Td>
        <div className="flex gap-2">
  <FormattedNumberInput
  aria-label={`${user.email} 測試 USDT 金額`}
  value={amounts[user.id] ?? ""}
  onValueChange={(rawValue) =>
  setAmounts((value) => ({
  ...value,
  [user.id]: rawValue,
  }))
  }
  min="0.01"
  placeholder="10,000"
  className="w-28 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
  />
          <button
            onClick={() => void deposit(user)}
            className="rounded-lg bg-amber-400 px-3 py-2 text-xs font-bold text-slate-950"
          >
            發放
          </button>
        </div>
      </Td>
    </tr>
  );
  return (
    <Panel
      title="用戶與帳號"
      action={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => void backfillWallets()}
            disabled={walletSyncing}
            className="inline-flex items-center gap-2 rounded-xl bg-amber-400 px-4 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-amber-300 disabled:cursor-wait disabled:opacity-60"
          >
            <RefreshCw className={`size-4 ${walletSyncing ? "animate-spin" : ""}`} />
            {walletSyncing ? "正在補齊錢包…" : "一鍵補齊錢包"}
          </button>
          <Export
            onClick={() =>
              csv(
                "users",
                ["Email", "Wallet", "Balance", "Created"],
                shown.map((user) => [
                  user.email,
                  user.wallet_address,
                  balance(user.id),
                  user.created_at,
                ]),
              )
            }
          />
        </div>
      }
    >
      <SearchBar
        value={q}
        onChange={setQ}
        placeholder="依暱稱、Email、User ID、錢包地址或身份搜尋"
        suggestions={profiles.map((user) => ({
          value: user.nickname || user.email,
          label: user.nickname || user.display_name || user.email,
          detail: `${user.email} · ${user.agency_role}${user.wallet_address ? ` · ${user.wallet_address}` : ""}`,
        }))}
      />
      <div className="flex flex-wrap gap-2" aria-label="用戶身份篩選">
        {["全部", "管理員", "總代理", "代理", "一般用戶"].map((role) => (
          <button
            key={role}
            type="button"
            onClick={() => setRoleFilter(role)}
            aria-pressed={roleFilter === role}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${roleFilter === role ? "bg-amber-400 text-slate-950" : "border border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-100"}`}
          >
            {role}
          </button>
        ))}
      </div>
      {notice && (
        <Notice message={notice.text} tone={notice.ok ? "success" : "error"} />
      )}
      {loadError && <Notice message={loadError} tone="error" />}
      {loading ? (
        <Empty text="載入用戶中…" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>用戶</Th>
              <Th>上線狀態／最後上線時間</Th>
              <Th>錢包地址</Th>
              <Th>帳本餘額</Th>
              <Th>私募投資金額</Th>
              <Th>二級市場投資金額</Th>
              <Th>
                <button
                  type="button"
                  onClick={() =>
                    setBonusSort((value) => (value === "desc" ? "asc" : "desc"))
                  }
                  className="inline-flex items-center gap-1 text-left hover:text-amber-200"
                  aria-label={`獎金排序，現在為${bonusSort === "desc" ? "由高到低" : "由低到高"}，點擊切換`}
                >
                  {bonusSort === "desc" ? "獎金由高到低" : "獎金由低到高"}
                  <span aria-hidden="true">
                    {bonusSort === "desc" ? "↓" : "↑"}
                  </span>
                </button>
              </Th>
              <Th>發放測試 USDT</Th>
            </tr>
          </thead>
          <tbody>
            {masters.map((master) => {
              const agents = agentsFor(master);
              const directMembers = membersFor(master);
              const masterExpanded = expandedMasters.includes(master.id);
              return (
                <Fragment key={master.id}>
                  {renderUserRow(
                    master,
                    0,
                    agents.length + directMembers.length > 0,
                    masterExpanded,
                    () => toggleExpanded(master.id, setExpandedMasters),
                  )}
                  {masterExpanded &&
                    agents.map((agent) => {
                      const members = membersFor(agent);
                      const agentExpanded = expandedAgents.includes(agent.id);
                      return (
                        <Fragment key={agent.id}>
                          {renderUserRow(
                            agent,
                            1,
                            members.length > 0,
                            agentExpanded,
                            () => toggleExpanded(agent.id, setExpandedAgents),
                          )}
                          {agentExpanded &&
                            members.map((member) =>
                              renderUserRow(
                                member,
                                2,
                                false,
                                false,
                                undefined,
                                "會員",
                              ),
                            )}
                        </Fragment>
                      );
                    })}
                  {masterExpanded &&
                    directMembers.map((member) =>
                      renderUserRow(
                        member,
                        1,
                        false,
                        false,
                        undefined,
                        "總代理直屬會員",
                      ),
                    )}
                </Fragment>
              );
            })}
            {standalone.map((user) => renderUserRow(user))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

function AgencyApplications() {
  const [items, setItems] = useState<AgencyApplication[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(
    null,
  );
  const [rebind, setRebind] = useState({ email: "", promo: "", reason: "" });
  const [selectedEmail, setSelectedEmail] = useState("");
  const load = async () => {
    const [applications, users] = await Promise.all([
      supabase
        .from("agency_applications")
        .select("*")
        .neq("status", "approved")
        .order("created_at", { ascending: false }),
      supabase
        .from("profiles")
        .select("id,email,display_name,wallet_address,agency_role,created_at")
        .order("email"),
    ]);
    setItems((applications.data ?? []) as AgencyApplication[]);
    setProfiles((users.data ?? []) as Profile[]);
  };
  useVisiblePolling(load, 1_000, true);
  const review = async (
    item: AgencyApplication,
    decision: "approved" | "rejected",
  ) => {
    const reason =
      decision === "rejected"
        ? window.prompt("請輸入拒絕原因") || "資格未符"
        : null;
    const { error } = await supabase.rpc("review_agency_application", {
      application_id: item.id,
      decision,
      reject_reason: reason,
    });
    setNotice({
      text: error
        ? "審核未完成，請確認申請與權限"
        : decision === "approved"
          ? "申請已核准並建立推廣碼"
          : "申請已拒絕",
      ok: !error,
    });
    if (!error) await load();
  };
  const selectedProfile = profiles.find(
    (profile) =>
      profile.email.toLowerCase() === rebind.email.trim().toLowerCase(),
  );
  const chooseUser = (email: string) => {
    setSelectedEmail(email);
    setRebind((value) => ({ ...value, email }));
  };
  const submitRebind = async () => {
    if (!selectedProfile) {
      setNotice({ text: "請輸入有效 Email 或從選單選擇用戶", ok: false });
      return;
    }
    const { error } = await supabase.rpc("admin_rebind_referral_by_email", {
      target_email: rebind.email.trim(),
      new_promo_code: rebind.promo,
      reason_text: rebind.reason,
    });
    setNotice({
      text: error
        ? "改綁失敗，請確認 Email、推廣碼、角色與原因"
        : "推廣關係已修正並留下稽核紀錄",
      ok: !error,
    });
    if (!error) {
      setRebind({ email: "", promo: "", reason: "" });
      setSelectedEmail("");
    }
  };
  return (
    <Panel
      title="代理申請審核"
    >
      {notice && (
        <Notice message={notice.text} tone={notice.ok ? "success" : "error"} />
      )}
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h3 className="font-bold">修正用戶／代理綁定</h3>
        <div className="mt-4 flex flex-col gap-3">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-xs font-medium text-slate-400">
              搜尋用戶 Email
              <input
                aria-label="目標用戶 Email"
                type="email"
                list="rebind-user-emails"
                value={rebind.email}
                onChange={(e) => {
                  setSelectedEmail("");
                  setRebind((v) => ({ ...v, email: e.target.value }));
                }}
                placeholder="輸入完整 Email"
                className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm"
              />
              <datalist id="rebind-user-emails">
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.email}>
                    {profile.display_name || profile.agency_role}
                  </option>
                ))}
              </datalist>
            </label>
            <label className="text-xs font-medium text-slate-400">
              或從用戶選單選擇
              <select
                aria-label="選擇目標用戶"
                value={selectedEmail}
                onChange={(e) => chooseUser(e.target.value)}
                className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm"
              >
                <option value="">選擇用戶…</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.email}>
                    {profile.email} · {profile.agency_role}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {selectedProfile && (
            <div className="flex flex-col gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-semibold text-slate-200">
                  {selectedProfile.email}
                </p>
                <p className="text-xs text-slate-500">
                  {selectedProfile.display_name || "未設定名稱"}
                </p>
              </div>
              <Tag>{selectedProfile.agency_role}</Tag>
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-3">
            <input
              aria-label="新推廣碼"
              value={rebind.promo}
              maxLength={9}
              onChange={(e) =>
                setRebind((v) => ({
                  ...v,
                  promo: e.target.value.toUpperCase(),
                }))
              }
              placeholder="新 9 碼推廣碼"
              className="rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm"
            />
            <input
              aria-label="改綁原因"
              value={rebind.reason}
              onChange={(e) =>
                setRebind((v) => ({ ...v, reason: e.target.value }))
              }
              placeholder="稽核原因（至少 5 字）"
              className="rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm"
            />
            <button
              onClick={() => void submitRebind()}
              className="rounded-xl bg-amber-400 px-4 py-3 font-bold text-slate-950"
            >
              確認改綁
            </button>
          </div>
        </div>
      </section>
      <div className="flex flex-col gap-3">
        {items.length === 0 && <Empty text="目前沒有代理申請" />}
        {items.map((item) => (
          <article
            key={item.id}
            className="rounded-2xl border border-slate-800 bg-slate-900 p-5"
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <b>{item.contact_name}</b>
                  <Tag>{item.requested_role}</Tag>
                  <Tag>{item.status}</Tag>
                </div>
                <p className="mt-2 text-sm text-slate-400">
                  {item.contact_method} · {item.region}
                </p>
                <p className="mt-2 text-sm">{item.reason}</p>
                {item.master_promo_code && (
                  <p className="mt-2 font-mono text-xs text-amber-300">
                    上線碼：{item.master_promo_code}
                  </p>
                )}
              </div>
              {item.status === "pending" && (
                <div className="flex gap-2">
                  <button
                    onClick={() => void review(item, "approved")}
                    className="rounded-xl bg-amber-400 px-4 py-2 font-bold text-slate-950"
                  >
                    核准
                  </button>
                  <button
                    onClick={() => void review(item, "rejected")}
                    className="rounded-xl border border-red-500/30 px-4 py-2 text-red-300"
                  >
                    拒絕
                  </button>
                </div>
              )}
            </div>
          </article>
        ))}
      </div>
    </Panel>
  );
}

type DetailListKey = "history" | "comparables" | "advantages";

function DetailListEditor({
  title,
  description,
  items,
  onChange,
}: {
  title: string;
  description: string;
  items: string[];
  onChange: (items: string[]) => void;
}) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-slate-100">{title}</h4>
          <p className="mt-1 text-xs text-slate-500">{description}</p>
        </div>
        <button
          type="button"
          onClick={() => onChange([...items, ""])}
          className="rounded-lg border border-amber-400/50 px-3 py-2 text-xs font-semibold text-amber-200"
        >
          新增項目
        </button>
      </div>
      <div className="mt-4 flex flex-col gap-3">
        {items.length === 0 && (
          <p className="rounded-xl border border-dashed border-slate-700 p-4 text-center text-xs text-slate-500">
            尚無內容，點選「新增項目」建立第一筆條列。
          </p>
        )}
        {items.map((item, index) => (
          <div key={index} className="flex items-start gap-2">
            <span className="mt-3 text-xs font-bold text-amber-300">{index + 1}</span>
            <textarea
              rows={2}
              value={item}
              maxLength={300}
              aria-label={`${title}第 ${index + 1} 項`}
              onChange={(event) => onChange(items.map((value, itemIndex) => itemIndex === index ? event.target.value : value))}
              className="min-w-0 flex-1 resize-y rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm leading-relaxed"
              placeholder={`輸入${title}內容`}
            />
            <button
              type="button"
              onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
              className="mt-1 rounded-lg border border-rose-500/40 px-3 py-2 text-xs font-semibold text-rose-300"
              aria-label={`刪除${title}第 ${index + 1} 項`}
            >
              刪除
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function PrivateModule() {
  const { placements, refresh } = useAdminData();
  const [q, setQ] = useState("");
  const [notice, setNotice] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingApy, setSavingApy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deactivateTarget, setDeactivateTarget] = useState<Placement | null>(null);
  const [deactivating, setDeactivating] = useState(false);
  const [featuredAssetId, setFeaturedAssetId] = useState("");
  const [savingFeatured, setSavingFeatured] = useState(false);
  useEffect(() => {
    void supabase
      .from("platform_config")
      .select("featured_asset_id")
      .maybeSingle()
      .then(({ data }) => setFeaturedAssetId(data?.featured_asset_id ?? ""));
  }, []);
  const emptyTranslations = () =>
    Object.fromEntries(
      LANGUAGES.map(([code]) => [code, { name: "", location: "", information: "" }]),
    ) as Record<Lang, AssetTranslation>;
  const [draft, setDraft] = useState({
    id: "",
    address: "",
    images: [] as string[],
    price: "",
    valuation: "",
    apy: "",
    total: "",
    available: "",
    endsAt: "",
    history: [] as string[],
    comparables: [] as string[],
    advantages: [] as string[],
    translations: emptyTranslations(),
  });
  const resetDraft = () => {
    setEditingId(null);
    setImageUrl("");
    setDraft({ id: "", address: "", images: [], price: "", valuation: "", apy: "", total: "", available: "", endsAt: "", history: [], comparables: [], advantages: [], translations: emptyTranslations() });
  };
  const closeEditor = () => {
    if (saving || uploading) return;
    setEditorOpen(false);
    resetDraft();
  };
  const openCreateEditor = () => {
    resetDraft();
    setNotice("");
    setEditorOpen(true);
  };
  useEffect(() => {
    if (!editorOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving && !uploading) setEditorOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [editorOpen, saving, uploading]);
  const editPlacement = (item: Placement) => {
    const translations = emptyTranslations();
    for (const [code] of LANGUAGES) translations[code] = { ...translations[code], ...(item.translations?.[code] ?? {}) };
    translations["zh-TW"] = {
      name: translations["zh-TW"].name || item.name,
      location: translations["zh-TW"].location || item.location,
      information: translations["zh-TW"].information ?? item.information ?? "",
    };
    setEditingId(item.id);
    setDraft({
      id: item.id,
      address: item.address,
      images: item.images?.length ? [...item.images] : [item.image],
      price: String(item.price),
      valuation: String(item.valuation),
      apy: String(item.apy ?? "").trim(),
      total: String(item.total_supply),
      available: String(item.available),
      endsAt: item.ends_at.slice(0, 16),
      history: Array.isArray(item.history) ? [...item.history] : [],
      comparables: Array.isArray(item.comparables) ? [...item.comparables] : [],
      advantages: Array.isArray(item.advantages) ? [...item.advantages] : [],
      translations,
    });
    setNotice("");
    setEditorOpen(true);
  };
  const traditionalChinese = draft.translations["zh-TW"] ?? {};
  const updateTraditionalChinese = (field: keyof AssetTranslation, value: string) =>
    setDraft((current) => ({
      ...current,
      translations: {
        ...current.translations,
        "zh-TW": { ...current.translations["zh-TW"], [field]: value },
      },
    }));
  const updateDetailList = (key: DetailListKey, items: string[]) =>
    setDraft((current) => ({ ...current, [key]: items }));
  const normalizedDetailList = (items: string[]) =>
    items.map((item) => item.trim()).filter(Boolean);
  const addImageUrl = () => {
    try {
      const url = new URL(imageUrl.trim());
      if (url.protocol !== "https:") throw new Error("invalid protocol");
      setDraft((current) => ({ ...current, images: [...current.images, url.toString()] }));
      setImageUrl("");
    } catch {
      setNotice("圖片網址必須是有效的 HTTPS 網址");
    }
  };
  const uploadImages = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    const urls: string[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/") || file.size > 10 * 1024 * 1024) {
        setNotice("僅支援 JPG、PNG、WebP、GIF，每張上限 10MB");
        continue;
      }
      const path = `${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
      const { error } = await supabase.storage.from("placement-images").upload(path, file);
      if (error) {
        setNotice("部分圖片上傳失敗，請稍後再試");
        continue;
      }
      urls.push(supabase.storage.from("placement-images").getPublicUrl(path).data.publicUrl);
    }
    setDraft((current) => ({ ...current, images: [...current.images, ...urls] }));
    setUploading(false);
  };
  const moveImage = (index: number, direction: -1 | 1) =>
    setDraft((current) => {
      const images = [...current.images];
      const target = index + direction;
      if (target < 0 || target >= images.length) return current;
      [images[index], images[target]] = [images[target], images[index]];
      return { ...current, images };
    });
  const listedPlacements = placements.filter((item) => !item.is_delisted);
  const activePrivatePlacements = listedPlacements.filter((item) => {
    if (item.market_started_at) return false;
    const totalSupply = Math.max(0, Number(item.total_supply));
    const remaining = Math.max(0, Number(item.available));
    return totalSupply === 0 || remaining > 0;
  });
  const shown = activePrivatePlacements.filter((item) =>
    includes([item.name, item.location, item.ends_at, item.total_supply], q),
  );
  const saveFeaturedAsset = async () => {
    setSavingFeatured(true);
    const { error } = await supabase.rpc("admin_set_featured_asset", {
      asset_key: featuredAssetId || null,
    });
    setSavingFeatured(false);
    setNotice(error ? "首頁精選標的更新失敗" : "首頁精選標的已立即更新");
  };
  const normalizedApy = () => {
    const value = draft.apy.trim();
    return value && value.length <= 80 ? value : null;
  };
  const saveApy = async () => {
    const apy = normalizedApy();
    if (!editingId || !apy) {
      setNotice("請輸入 APY，例如 7.77% 或 8.1%-9.9%（最多 80 個字元）");
      return;
    }
    setSavingApy(true);
    const { error } = await supabase.rpc("admin_update_placement_apy", {
      placement_id: editingId,
      new_apy: apy,
    });
    setSavingApy(false);
    setNotice(error ? `APY 更新失敗：${error.message}` : `APY 已更新為 ${apy}，並同步至前台`);
    if (!error) {
      await refresh();
      window.dispatchEvent(new Event("platform-assets-updated"));
    }
  };
  const saveDraft = async () => {
    const zh = draft.translations["zh-TW"];
    const apy = normalizedApy();
    const values = { price: Number(draft.price), valuation: Number(draft.valuation), total: Number(draft.total), available: Number(draft.available) };
    if (!zh.name?.trim() || !zh.location?.trim() || !draft.address.trim() || draft.images.length === 0 || !draft.endsAt || values.price <= 0 || values.valuation <= 0 || values.total <= 0 || values.available < 0 || values.available > values.total || !apy) {
      setNotice("請完整填寫繁中名稱、地區、英文地址、圖片、價格、總資產估值、供應量與結束時間；總資產估值須大於 0，剩餘量不可高於總發行量");
      return;
    }
    setSaving(true);
    setNotice("正在建立標的並準備多語內容…");
    try {
      const sourceContent = {
        name: zh.name.trim(),
        location: zh.location.trim(),
        information: zh.information?.trim() ?? "",
      };
      let translationWarning = false;
      let translations: Partial<Record<Lang, AssetTranslation>>;
      try {
        translations = await translateAdminContent("asset", sourceContent);
      } catch {
        translationWarning = true;
        translations = Object.fromEntries(
          LANGUAGES.map(({ code }) => [code, sourceContent]),
        ) as Record<Lang, AssetTranslation>;
      }
      const isEditing = Boolean(editingId);
      const placementId = editingId ?? `asset-${crypto.randomUUID()}`;
      const { data: savedPlacement, error } = await supabase.rpc(isEditing ? "admin_upsert_placement" : "admin_create_placement", {
        p_id: placementId,
        p_name: zh.name.trim(),
        p_location: zh.location.trim(),
        p_address: draft.address.trim(),
        p_images: draft.images,
        p_price: values.price,
        p_valuation: values.valuation,
        p_apy: apy,
        p_information: zh.information?.trim() ?? "",
        p_translations: translations,
        p_history: normalizedDetailList(draft.history),
        p_comparables: normalizedDetailList(draft.comparables),
        p_advantages: normalizedDetailList(draft.advantages),
        p_total_supply: values.total,
        p_available: values.available,
        p_ends_at: new Date(draft.endsAt).toISOString(),
      });
      if (error || !savedPlacement || savedPlacement.id !== placementId) {
        const databaseMessage = error?.message.toLowerCase() ?? "";
        const reason =
          error?.code === "23505" || databaseMessage.includes("duplicate key")
            ? "標的代碼已存在，請更換代碼"
            : error?.code === "42501" || databaseMessage.includes("not authorized")
              ? "目前帳號沒有管理員新增權限，請重新登入後再試"
              : databaseMessage.includes("invalid values")
                ? "欄位資料無效，請確認結束時間在未來、圖片為 HTTPS 網址，且價格、估值及供應量皆正確"
                : error?.message ?? "資料庫未回傳已儲存標的，請重試";
        setNotice(`${isEditing ? "更新" : "新增"}失敗：${reason}`);
        return;
      }
      await refresh();
      window.dispatchEvent(new Event("platform-assets-updated"));
      setNotice(
        translationWarning
          ? `${isEditing ? "標的已更新" : "標的已建立"}，前後台已同步；翻譯服務暫時失敗，目前其他語言先顯示繁體中文`
          : isEditing
            ? "標的已自動翻譯並更新，前後台已同步"
            : "標的已自動翻譯並新增，前後台已同步",
      );
      setEditorOpen(false);
      resetDraft();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "自動翻譯失敗，繁中草稿已保留");
    } finally {
      setSaving(false);
    }
  };
  const endNow = async (item: Placement) => {
    if (!window.confirm(`確定馬上結束「${item.name}」並開放到二級市場？`))
      return;
    const { error } = await supabase.rpc("admin_end_private_placement", {
      placement_id: item.id,
    });
    setNotice(error ? `馬上結束失敗：${error.message}` : "私募已結束，標的已進入二級市場");
    if (!error) {
      await refresh();
      window.dispatchEvent(new Event("platform-assets-updated"));
    }
  };
  const deactivatePlacement = async () => {
    if (!deactivateTarget || deactivating) return;
    setDeactivating(true);
    const target = deactivateTarget;
    const { error } = await supabase.rpc("admin_deactivate_placement", {
      placement_id: target.id,
    });
    setDeactivating(false);
    if (error) {
      setNotice(`下架「${target.name}」失敗，請稍後再試`);
      return;
    }
    setDeactivateTarget(null);
    setNotice(`「${target.name}」已下架，前端已停止顯示與交易`);
    if (featuredAssetId === target.id) setFeaturedAssetId("");
    await refresh();
    window.dispatchEvent(new Event("platform-assets-updated"));
  };
  return (
    <Panel
      title="私募標的物管理"
    >
      <section className="mb-5 rounded-2xl border border-amber-500/20 bg-slate-900 p-5">
        <h3 className="font-bold">首頁精選標的</h3>
        <p className="mt-1 text-xs text-slate-500">可選擇認購中或已進入二級市場的任一標的；首頁會依階段顯示正確操作。</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <select value={featuredAssetId} onChange={(event) => setFeaturedAssetId(event.target.value)} className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm">
            <option value="">自動選擇有效標的</option>
            {listedPlacements.map((item) => (
              <option key={item.id} value={item.id}>
                {item.market_started_at ? "二級市場" : "認購"} · {item.name} · {item.id}
              </option>
            ))}
          </select>
          <button type="button" disabled={savingFeatured} onClick={() => void saveFeaturedAsset()} className="rounded-xl bg-amber-400 px-5 py-3 text-sm font-bold text-slate-950 disabled:cursor-wait disabled:opacity-60">
            {savingFeatured ? "儲存中…" : "儲存精選"}
          </button>
        </div>
      </section>
      <section className="mb-5 flex flex-col gap-4 rounded-2xl border border-amber-500/20 bg-slate-900 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="font-bold">建立新私募標的</h3>
          <p className="mt-1 text-xs text-slate-500">完整表單將在彈出視窗中開啟，保持管理頁面簡潔。</p>
        </div>
        <button
          type="button"
          onClick={openCreateEditor}
          className="rounded-xl bg-amber-400 px-6 py-3 text-sm font-bold text-slate-950 shadow-lg shadow-amber-950/30 transition hover:bg-amber-300"
        >
          建立新標的物
        </button>
      </section>
      {editorOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-3 backdrop-blur-sm sm:p-6"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeEditor();
          }}
        >
          <section
            id="placement-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="placement-editor-title"
            className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-amber-500/30 bg-slate-900 shadow-2xl sm:max-h-[calc(100vh-3rem)]"
          >
            <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-800 bg-slate-900 px-5 py-4 sm:px-6">
              <div>
                <h3 id="placement-editor-title" className="font-bold text-slate-100">{editingId ? `完整編輯標的 · ${editingId}` : "建立新私募標的"}</h3>
                <p className="mt-1 text-xs text-slate-500">{editingId ? "可修改所有上架內容，儲存後前台同步更新。" : "建立後會立即顯示於用戶認購頁，直到進入二級市場。"}</p>
              </div>
              <button
                type="button"
                onClick={closeEditor}
                disabled={saving || uploading}
                autoFocus
                className="shrink-0 rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-amber-400 hover:text-amber-200 disabled:cursor-wait disabled:opacity-50"
                aria-label="關閉標的表單"
              >
                關閉
              </button>
            </header>
            <div className="overflow-y-auto p-5 sm:p-6">
        <div className="mt-5 flex flex-col gap-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(
          [
            ["address", "完整地址（僅英文）"],
                ["price", "認購單價"],
                ["valuation", "總資產估值（USDT）"],
                ["apy", "APY（%）"],
                ["total", "總供�������"],
                ["available", "可認購量"],
                ["endsAt", "認購結束時間"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="text-xs text-slate-400">
                {label}
                <span className="relative mt-2 block">
                  {["price", "valuation", "total", "available"].includes(key) ? (
                    <FormattedNumberInput
                      min="0"
                      inputMode={["total", "available"].includes(key) ? "numeric" : "decimal"}
                      placeholder={key === "valuation" ? "例如：37,500" : undefined}
                      value={draft[key]}
                      onValueChange={(rawValue) => setDraft((value) => ({ ...value, [key]: rawValue }))}
                      className="w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm"
                    />
                  ) : (
                    <input
                      type={key === "endsAt" ? "datetime-local" : "text"}
                      maxLength={key === "apy" ? 80 : undefined}
                      placeholder={key === "apy" ? "例如：8.1%-9.9%" : undefined}
                      value={draft[key]}
                      onChange={(event) => setDraft((value) => ({ ...value, [key]: event.target.value }))}
                      onKeyDown={(event) => {
                        if (key === "apy" && event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                          event.preventDefault();
                          void saveApy();
                        }
                      }}
                      className="w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm"
                    />
                  )}
                </span>
                {key === "apy" && <span className="mt-2 block text-[11px] text-slate-500">可輸入固定值或區間，例如 7.77% 或 8.1%-9.9%。{editingId ? "輸入後按 Enter，或點下方「只儲存 APY」即可同步前台。" : ""}</span>}
              </label>
            ))}
          </div>
          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <p className="text-sm font-semibold">繁體中文內容</p>
            <p className="mt-1 text-xs text-slate-500">儲存時會自動翻譯為其餘 15 種語言，翻譯失敗時不會送出半成品。</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-slate-400">標的名稱<input value={traditionalChinese.name ?? ""} onChange={(event) => updateTraditionalChinese("name", event.target.value)} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm" /></label>
              <label className="text-xs text-slate-400">地區<input value={traditionalChinese.location ?? ""} onChange={(event) => updateTraditionalChinese("location", event.target.value)} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm" /></label>
              <label className="text-xs text-slate-400 sm:col-span-2">資訊<textarea rows={5} value={traditionalChinese.information ?? ""} onChange={(event) => updateTraditionalChinese("information", event.target.value)} className="mt-2 w-full resize-y rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm leading-relaxed" /></label>
            </div>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <DetailListEditor
              title="物件歷史"
              description="依時間順序新增、修改或刪除歷史紀錄。"
              items={draft.history}
              onChange={(items) => updateDetailList("history", items)}
            />
            <DetailListEditor
              title="周邊定價"
              description="維護周邊成交、租金或市場比較資料。"
              items={draft.comparables}
              onChange={(items) => updateDetailList("comparables", items)}
            />
            <DetailListEditor
              title="投資優勢"
              description="列出此標的最重要的投資亮點。"
              items={draft.advantages}
              onChange={(items) => updateDetailList("advantages", items)}
            />
          </div>
          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <p className="text-sm font-semibold">圖片（不限張數）</p>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row">
              <label className="cursor-pointer rounded-xl border border-dashed border-amber-400/50 px-4 py-3 text-center text-sm text-amber-200">
                {uploading ? "上傳中…" : "上傳圖片"}
                <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple disabled={uploading} onChange={(event) => void uploadImages(event.target.files)} className="sr-only" />
              </label>
              <input type="url" value={imageUrl} onChange={(event) => setImageUrl(event.target.value)} placeholder="https:// 圖片網址" className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm" />
              <button type="button" onClick={addImageUrl} className="rounded-xl border border-slate-700 px-4 py-3 text-sm">加入網址</button>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {draft.images.map((url, index) => (
                <figure key={`${url}-${index}`} className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
                  <ClickableAssetImage images={draft.images} assetName={draft.translations["zh-TW"].name || draft.id || "標的"} className="aspect-video w-full object-cover" initialIndex={index} />
                  <figcaption className="flex items-center justify-between gap-2 p-2 text-xs">
                    <span className="truncate">{index === 0 ? "封面圖片" : `圖片 ${index + 1}`}</span>
                    <span className="flex gap-1">
                      <button type="button" disabled={index === 0} onClick={() => moveImage(index, -1)} className="rounded bg-slate-800 px-2 py-1 disabled:opacity-30">上移</button>
                      <button type="button" disabled={index === draft.images.length - 1} onClick={() => moveImage(index, 1)} className="rounded bg-slate-800 px-2 py-1 disabled:opacity-30">下移</button>
                      <button type="button" onClick={() => setDraft((current) => ({ ...current, images: current.images.filter((_, imageIndex) => imageIndex !== index) }))} className="rounded bg-red-950 px-2 py-1 text-red-200">刪除</button>
                    </span>
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        </div>
              {notice && <div className="mt-4"><Notice message={notice} /></div>}
              <div className="mt-4 flex flex-wrap justify-end gap-3 border-t border-slate-800 pt-4">
                <button
                  type="button"
                  disabled={saving || uploading}
                  onClick={closeEditor}
                  className="rounded-xl border border-slate-700 px-5 py-3 font-bold text-slate-300 hover:border-slate-500 disabled:cursor-wait disabled:opacity-50"
                >
                  取消
                </button>
                {editingId && (
                  <button
                    type="button"
                    disabled={savingApy}
                    onClick={() => void saveApy()}
                    className="rounded-xl border border-amber-400 px-5 py-3 font-bold text-amber-300 disabled:cursor-wait disabled:opacity-60"
                  >
                    {savingApy ? "儲存 APY 中…" : "只儲存 APY"}
                  </button>
                )}
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void saveDraft()}
                  className="rounded-xl bg-amber-400 px-5 py-3 font-bold text-slate-950 disabled:cursor-wait disabled:opacity-60"
                >
                  {saving ? "翻譯並儲存中…" : editingId ? "翻譯並儲存全部修改" : "翻譯並建立標的"}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
      {deactivateTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deactivating) setDeactivateTarget(null);
          }}
        >
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="deactivate-title"
            aria-describedby="deactivate-description"
            className="w-full max-w-md rounded-2xl border border-red-500/50 bg-slate-900 p-6 shadow-2xl"
          >
            <p className="text-xs font-bold uppercase tracking-widest text-red-300">高風險操作</p>
            <h3 id="deactivate-title" className="mt-3 text-xl font-bold text-slate-100">確定要下架此標的物嗎？</h3>
            <p id="deactivate-description" className="mt-3 text-sm leading-relaxed text-slate-300">
              即將下架「{deactivateTarget.name}」。下架後將無法在前端顯示與交易，此操作無法復原。
            </p>
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setDeactivateTarget(null)}
                disabled={deactivating}
                autoFocus
                className="rounded-xl border border-slate-700 px-5 py-3 font-bold text-slate-300 disabled:cursor-wait disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void deactivatePlacement()}
                disabled={deactivating}
                className="rounded-xl bg-red-600 px-5 py-3 font-bold text-white transition hover:bg-red-500 disabled:cursor-wait disabled:opacity-60"
              >
                {deactivating ? "下架中…" : "確認下架"}
              </button>
            </div>
          </section>
        </div>
      )}
      <SearchBar
        value={q}
        onChange={setQ}
        placeholder="搜尋標的、地點、結束時間或總代幣數量"
        suggestions={activePrivatePlacements.map((item) => ({
          value: item.name,
          label: item.name,
          detail: item.location,
        }))}
      />
      {notice && <Notice message={notice} />}
      <div className="grid gap-4 md:grid-cols-2">
        {shown.map((item) => {
          const totalSupply = Math.max(0, Number(item.total_supply));
          const remaining = Math.max(0, Number(item.available));
          const progress =
            totalSupply > 0
              ? Math.min(
                  100,
                  Math.max(0, ((totalSupply - remaining) / totalSupply) * 100),
                )
              : 0;
          return (
            <article
              key={item.id}
              className="rounded-2xl border border-slate-800 bg-slate-900 p-5"
            >
              <button type="button" onClick={() => editPlacement(item)} className="block w-full text-left" aria-label={`完整編輯 ${item.name}`}>
                <img src={item.images?.[0] || item.image} alt={item.name} className="mb-4 h-40 w-full rounded-xl object-cover" />
                <div className="flex items-start justify-between gap-3">
                  <div><h3 className="font-bold text-slate-100">{item.name}</h3><p className="mt-1 text-xs text-slate-500">{item.location}</p></div>
                  <span className="rounded-lg bg-amber-400 px-3 py-2 text-xs font-bold text-slate-950">完整編輯</span>
                </div>
              </button>
              <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
                <div className="flex items-center justify-between gap-4 text-sm">
                  <span className="text-slate-400">私募進度百分比</span>
                  <b className="text-amber-200">{progress.toFixed(1)}%</b>
                </div>
                <div
                  className="mt-3 h-2 overflow-hidden rounded-full bg-slate-800"
                  aria-label={`私募進度 ${progress.toFixed(1)}%`}
                >
                  <div
                    className="h-full rounded-full bg-amber-400"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Metric label="單價" value={money(item.price)} />
                <Metric label="APY" value={item.apy ? (item.apy.includes("%") ? item.apy : `${item.apy}%`) : "—"} />
                <Metric
                  label="總代幣數量"
                  value={Number(item.total_supply).toLocaleString()}
                />
                <Metric
                  label="剩餘未認購代幣"
                  value={remaining.toLocaleString()}
                />
                <Metric
                  label="狀態"
                  value={
                    item.is_delisted
                      ? "已下架"
                      : item.market_started_at
                        ? "二級市場交易中"
                        : Date.now() > new Date(item.ends_at).getTime()
                          ? "已結束"
                          : "進行中"
                  }
                />
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" onClick={() => editPlacement(item)} className="flex-1 rounded-xl bg-amber-400 px-4 py-3 font-bold text-slate-950">完整編輯所有內容</button>
                {!item.market_started_at && <button type="button" onClick={() => void endNow(item)} disabled={item.is_delisted} className="flex-1 rounded-xl border border-rose-500/50 px-4 py-3 font-bold text-rose-300 disabled:cursor-not-allowed disabled:opacity-40">馬上結束並進入二級市場</button>}
                {!item.is_delisted && (
                  <button
                    type="button"
                    onClick={() => setDeactivateTarget(item)}
                    className="w-full rounded-xl border border-red-500/70 bg-red-950/30 px-4 py-3 font-bold text-red-200 transition hover:border-red-400 hover:bg-red-950/60"
                  >
                    下架標的物
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </Panel>
  );
}

function SecondaryModule() {
  const { placements, refresh } = useAdminData();
  const [q, setQ] = useState("");
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [deactivateTarget, setDeactivateTarget] = useState<Placement | null>(null);
  const [deactivating, setDeactivating] = useState(false);
  const secondaryPlacements = placements.filter(
    (item) => item.market_started_at && !item.is_delisted,
  );
  const shown = secondaryPlacements.filter((item) =>
    includes([item.name, item.location, item.price, item.change], q),
  );
  const changePrice = async (item: Placement) => {
    const price = Number(prices[item.id]);
    if (!Number.isFinite(price) || price <= 0) {
      setNotice("請輸入有效的新價格");
      return;
    }
    if (
      !window.confirm(
        `確定將「${item.name}」價格改為 ${money(price)}？新價格立即生效並暫停新掛單一分鐘；既有掛單（含部分成交）將依新價格重新計價（份額不變），因此變為可撮合的掛單將立即自動成交。`,
      )
    )
      return;
    const { error } = await supabase.rpc("admin_change_secondary_price", {
      asset_key: item.id,
      new_price: price,
    });
    setNotice(
      error
        ? "價格更新失敗"
        : "價格已更新；既有掛單已同步改為新價格（份額不變），新掛單暫停一分鐘，因改價而可撮合的掛單已自動成交",
    );
    if (!error) {
      setPrices((value) => ({ ...value, [item.id]: "" }));
      await refresh();
    }
  };
  const deactivatePlacement = async () => {
    if (!deactivateTarget || deactivating) return;
    setDeactivating(true);
    const target = deactivateTarget;
    const { error } = await supabase.rpc("admin_deactivate_placement", {
      placement_id: target.id,
    });
    setDeactivating(false);
    if (error) {
      setNotice(`下架「${target.name}」失敗，請稍後再試`);
      return;
    }
    setDeactivateTarget(null);
    setNotice(`「${target.name}」已下架，前端已停止顯示與交易`);
    await refresh();
    window.dispatchEvent(new Event("platform-assets-updated"));
  };
  return (
    <Panel
      title="二級市場標的物"
    >
      {deactivateTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deactivating) setDeactivateTarget(null);
          }}
        >
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="secondary-deactivate-title"
            aria-describedby="secondary-deactivate-description"
            className="w-full max-w-md rounded-2xl border border-red-500/50 bg-slate-900 p-6 shadow-2xl"
          >
            <p className="text-xs font-bold uppercase tracking-widest text-red-300">高風險操作</p>
            <h3 id="secondary-deactivate-title" className="mt-3 text-xl font-bold text-slate-100">
              確定要下架此標的物嗎？
            </h3>
            <p id="secondary-deactivate-description" className="mt-3 text-sm leading-relaxed text-slate-300">
              即將下架「{deactivateTarget.name}」。下架後將無法在前端顯示與交易，此操作無法復原。
            </p>
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setDeactivateTarget(null)}
                disabled={deactivating}
                autoFocus
                className="rounded-xl border border-slate-700 px-5 py-3 font-bold text-slate-300 disabled:cursor-wait disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void deactivatePlacement()}
                disabled={deactivating}
                className="rounded-xl bg-red-600 px-5 py-3 font-bold text-white transition hover:bg-red-500 disabled:cursor-wait disabled:opacity-60"
              >
                {deactivating ? "下架中…" : "確認下架"}
              </button>
            </div>
          </section>
        </div>
      )}
      <SearchBar
        value={q}
        onChange={setQ}
        placeholder="搜尋標的、地點、價格或漲跌"
        suggestions={secondaryPlacements.map((item) => ({
            value: item.name,
            label: item.name,
            detail: `${money(item.price)} · ${Number(item.change).toFixed(2)}%`,
          }))}
      />
      {notice && <Notice message={notice} />}
      <Table>
        <thead>
          <tr>
            <Th>標的</Th>
            <Th>價格</Th>
            <Th>24h 漲跌</Th>
            <Th>待搓合量 / 發行量</Th>
            <Th>價格與操作</Th>
          </tr>
        </thead>
        <tbody>
          {shown.map((item) => (
            <tr key={item.id} className="border-t border-slate-800">
              <Td>
                <b>{item.name}</b>
              </Td>
              <Td>{money(item.price)}</Td>
              <Td className={Number(item.change) >= 0 ? "text-emerald-400" : "text-rose-400"}>
                {Number(item.change) >= 0 ? "+" : ""}{Number(item.change).toFixed(2)}%
              </Td>
              <Td>
                {Number(item.available).toLocaleString()} /{" "}
                {Number(item.total_supply).toLocaleString()}
              </Td>
              <Td>
                <div className="flex min-w-80 flex-wrap gap-2">
  <FormattedNumberInput
  aria-label={`${item.name} 新價格`}
  min="0.01"
  value={prices[item.id] ?? ""}
  onValueChange={(rawValue) =>
  setPrices((value) => ({
  ...value,
  [item.id]: rawValue,
  }))
  }
  placeholder={item.price.toLocaleString("en-US")}
  className="w-28 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
  />
                  <button
                    type="button"
                    onClick={() => void changePrice(item)}
                    className="rounded-lg bg-amber-400 px-3 py-2 font-bold text-slate-950"
                  >
                    更改價格
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeactivateTarget(item)}
                    className="rounded-lg border border-red-500/70 bg-red-950/30 px-3 py-2 font-bold text-red-200 transition hover:border-red-400 hover:bg-red-950/60"
                  >
                    下架
                  </button>
                </div>
                {item.price_locked_until &&
                  new Date(item.price_locked_until).getTime() > Date.now() && (
                    <p className="mt-2 text-xs text-amber-300">新掛單冷卻中</p>
                  )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
}

function AgencyModule({
  onOpenDetail,
}: {
  onOpenDetail: (userId: string) => void;
}) {
  const { profiles, ledger, commissions } = useAdminData();
  const now = useCurrentTime();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [openAgent, setOpenAgent] = useState<string | null>(null);
  const [openUser, setOpenUser] = useState<string | null>(null);
  const [reportStartDate, setReportStartDate] = useState("");
  const [reportEndDate, setReportEndDate] = useState("");
  const [lastSeenSort, setLastSeenSort] = useState<"asc" | "desc">("desc");
  const agents = profiles.filter((profile) =>
    ["總代理", "代理", "一代代理", "二代代理"].includes(profile.agency_role),
  );
  const masters = agents.filter((profile) => profile.agency_role === "總代理");
  const agentsFor = (master: Profile) =>
    agents.filter(
      (profile) =>
        profile.agency_role !== "總代理" &&
        (profile.master_agent_id === master.id ||
          profile.parent_id === master.id ||
          profile.referrer_id === master.id),
    );
  const usersFor = (agent: Profile) =>
    profiles.filter(
      (profile) =>
        !["總代理", "代理", "一代代理", "二代代理"].includes(
          profile.agency_role,
        ) &&
        (profile.parent_id === agent.id || profile.referrer_id === agent.id),
    );
  const profileName = (profile: Profile) =>
    profile.nickname || profile.display_name || profile.email.split("@")[0];
  const matchesSearch = (profile: Profile) =>
    includes(
      [
        profile.nickname,
        profile.display_name,
        profile.email,
        profile.wallet_address,
        profile.agency_role,
        isOnline(profile.last_seen_at, now) ? "線上" : "離線",
        formatLastSeen(profile.last_seen_at),
      ],
      q,
    );
  const shown = masters
    .filter(
      (master) =>
        matchesSearch(master) ||
        agentsFor(master).some(
          (agent) =>
            matchesSearch(agent) || usersFor(agent).some(matchesSearch),
        ),
    )
    .sort((a, b) => compareLastSeen(a, b, lastSeenSort));
  const buyer = (id: string) => {
    const profile = profiles.find((item) => item.id === id);
    return profile ? profileName(profile) : id;
  };
  const reportCommissions = commissions.filter(
    (log) =>
      agents.some((agent) => agent.id === log.agent_id) &&
      isWithinDateRange(log.created_at, reportStartDate, reportEndDate),
  );
  const isPrivateCommission = (log: Commission) =>
    log.transaction_type === "private" ||
    log.transaction_type.toLowerCase().includes("private");
  const reportTotals = reportCommissions.reduce(
    (totals, log) => {
      const value = Number(log.commission_amount);
      if (isPrivateCommission(log)) totals.privateAmount += value;
      else totals.secondaryAmount += value;
      totals.totalAmount += value;
      totals.count += 1;
      return totals;
    },
    { privateAmount: 0, secondaryAmount: 0, totalAmount: 0, count: 0 },
  );
  const masterForAgent = (agent: Profile) => {
    if (agent.agency_role === "總代理") return agent;
    return masters.find(
      (master) =>
        agent.master_agent_id === master.id ||
        agent.parent_id === master.id ||
        agent.referrer_id === master.id,
    );
  };
  const exportAgencyReport = () => {
    const rangeName = `${reportStartDate || "all"}-${reportEndDate || "all"}`;
    downloadCsv(
      `agency-commissions-${rangeName}`,
      [
        "總代理歸屬",
        "代理",
        "來源買家",
        "類型",
        "交易金額",
        "比例",
        "分潤金額",
        "時間",
      ],
      [
        ...reportCommissions.map((log) => {
          const agent = profiles.find((profile) => profile.id === log.agent_id);
          return [
            agent
              ? masterForAgent(agent)
                ? profileName(masterForAgent(agent)!)
                : "未歸屬"
              : "未歸屬",
            buyer(log.agent_id),
            buyer(log.buyer_id),
            getCommissionTypeMeta(log.transaction_type).label,
            Number(log.transaction_amount).toFixed(2),
            `${Number(log.commission_rate) * 100}%`,
            Number(log.commission_amount).toFixed(2),
            new Date(log.created_at).toLocaleString(),
          ];
        }),
        [],
        [
          "合計",
          "",
          "",
          "私募",
          "",
          "",
          reportTotals.privateAmount.toFixed(2),
          "",
        ],
        [
          "合計",
          "",
          "",
          "二級市場",
          "",
          "",
          reportTotals.secondaryAmount.toFixed(2),
          "",
        ],
        [
          "總計",
          "",
          "",
          "全部",
          "",
          "",
          reportTotals.totalAmount.toFixed(2),
          "",
        ],
      ],
    );
  };
  const renderAgent = (agent: Profile, level: "master" | "agent") => {
    const logs = reportCommissions.filter((log) => log.agent_id === agent.id);
    const total = logs.reduce(
      (sum, log) => sum + Number(log.commission_amount),
      0,
    );
    const childAgents = level === "master" ? agentsFor(agent) : [];
    const users = level === "agent" ? usersFor(agent) : [];
    const expanded =
      level === "master" ? open === agent.id : openAgent === agent.id;
    return (
      <article
        key={agent.id}
        className={`min-w-0 rounded-2xl border bg-slate-900 p-4 sm:p-5 ${
          level === "master" ? "border-amber-500/35" : "border-slate-800"
        }`}
      >
        <button
          type="button"
          onClick={() => {
            if (level === "master") {
              setOpen(expanded ? null : agent.id);
              setOpenAgent(null);
              setOpenUser(null);
            } else {
              setOpenAgent(expanded ? null : agent.id);
              setOpenUser(null);
            }
          }}
          className="flex w-full min-w-0 flex-col gap-4 text-left md:flex-row md:items-center"
          aria-expanded={expanded}
        >
          <div className="flex w-full min-w-0 items-start gap-3 sm:flex-1">
            <Landmark className="mt-0.5 size-5 shrink-0 text-amber-300" />
            <div className="min-w-0 flex-1">
              <b className="block break-all text-sm leading-5 text-slate-200">
                {profileName(agent)}
              </b>
              <p className="mt-1 break-all text-xs text-slate-400">
                {agent.email}
              </p>
              <p className="mt-1 break-all font-mono text-xs text-slate-500">
                {agent.wallet_address || "未綁定錢包"}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Tag>{agent.agency_role}</Tag>
                <LastSeenStatus value={agent.last_seen_at} now={now} />
              </div>
            </div>
          </div>
          <div className="flex w-full flex-wrap items-end justify-between gap-3 border-t border-slate-800 pt-3 md:w-auto md:flex-col md:flex-nowrap md:border-0 md:pt-0">
            <span className="text-xs text-slate-500">
              累計分潤 · {logs.length} 筆
            </span>
            <b className="text-sm text-amber-200">{money(total)}</b>
          </div>
        </button>
        <div className="mt-3 flex justify-end border-t border-slate-800 pt-3">
          <button
            type="button"
            onClick={() => onOpenDetail(agent.id)}
            className="rounded-lg border border-amber-400/40 px-3 py-2 text-xs font-bold text-amber-200 hover:bg-amber-400 hover:text-slate-950"
          >
            查看詳細紀錄
          </button>
        </div>
        {expanded && level === "master" && (
          <div className="mt-4 flex flex-col gap-3 border-t border-slate-800 pt-4">
            <p className="text-xs text-slate-500">旗下代理</p>
            {childAgents.map((child) => renderAgent(child, "agent"))}
            {!childAgents.length && <Empty text="此總代理旗下尚無代理" />}
          </div>
        )}
        {expanded && level === "agent" && (
          <div className="mt-4 flex flex-col gap-3 border-t border-slate-800 pt-4">
            <p className="text-xs text-slate-500">
              選擇一般用戶後，才會顯示該用戶的交易與分潤紀錄。
            </p>
            {users.map((user) => {
              const userLogs = logs.filter((log) => log.buyer_id === user.id);
              const trades = ledger.filter(
                (entry) =>
                  entry.user_id === user.id &&
                  [
                    "private_purchase",
                    "secondary_buy",
                    "secondary_sell",
                  ].includes(entry.entry_type),
              );
              const userExpanded = openUser === `${agent.id}:${user.id}`;
              return (
                <article
                  key={user.id}
                  className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950/50"
                >
                  <button
                    type="button"
                    onClick={() =>
                      setOpenUser(
                        userExpanded ? null : `${agent.id}:${user.id}`,
                      )
                    }
                    aria-expanded={userExpanded}
                    className="flex w-full flex-col gap-3 p-4 text-left hover:bg-slate-800/50 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="min-w-0">
                      <b className="block break-all text-sm leading-5 text-slate-200">
                        {user.nickname || user.display_name || user.email}
                      </b>
                      <span className="block break-all text-xs leading-5 text-slate-500">
                        {user.email}
                      </span>
                    </span>
                    <span className="flex w-full flex-wrap items-center justify-between gap-3 sm:w-auto sm:shrink-0 sm:justify-end">
                      <Tag>一般用戶</Tag>
                      <span className="text-xs text-slate-500">
                        {trades.length} 筆交易 · {userLogs.length} 筆分潤
                      </span>
                      <span className="text-amber-300">
                        {userExpanded ? "−" : "+"}
                      </span>
                    </span>
                  </button>
                  <div className="flex justify-end border-t border-slate-800 px-4 py-3">
                    <button
                      type="button"
                      onClick={() => onOpenDetail(user.id)}
                      className="rounded-lg border border-amber-400/40 px-3 py-2 text-xs font-bold text-amber-200 hover:bg-amber-400 hover:text-slate-950"
                    >
                      查看詳細紀錄
                    </button>
                  </div>
                  {userExpanded && (
                    <div className="flex flex-col gap-5 border-t border-slate-800 p-4">
                      <AuditRecordsTable
                        title="交易紀錄"
                        empty="此用戶尚無交易紀錄"
                        headers={["類型", "標的", "份額", "金額", "時間"]}
                      >
                        {trades.map((entry) => (
                          <tr
                            key={entry.id}
                            className="border-t border-slate-800"
                          >
                            <Td>
                              {entry.entry_type === "private_purchase"
                                ? "私募認購"
                                : entry.entry_type === "secondary_buy"
                                  ? "二級買入"
                                  : "二級賣出"}
                            </Td>
                            <Td>{entry.asset_id || "—"}</Td>
                            <Td>
                              {Number(entry.quantity || 0).toLocaleString()}
                            </Td>
                            <Td>{money(Math.abs(Number(entry.amount)))}</Td>
                            <Td>
                              {new Date(entry.created_at).toLocaleString()}
                            </Td>
                          </tr>
                        ))}
                      </AuditRecordsTable>
                      <AuditRecordsTable
                        title="分潤紀錄"
                        empty="此用戶尚未產生分潤"
                        headers={["類型", "交易金額", "比例", "分潤", "時間"]}
                      >
                        {userLogs.map((log) => (
                          <tr
                            key={log.id}
                            className="border-t border-slate-800"
                          >
                            <Td>
                              {
                                getCommissionTypeMeta(log.transaction_type)
                                  .label
                              }
                            </Td>
                            <Td>{money(log.transaction_amount)}</Td>
                            <Td>{Number(log.commission_rate) * 100}%</Td>
                            <Td>
                              <b className="text-amber-200">
                                {money(log.commission_amount)}
                              </b>
                            </Td>
                            <Td>{new Date(log.created_at).toLocaleString()}</Td>
                          </tr>
                        ))}
                      </AuditRecordsTable>
                    </div>
                  )}
                </article>
              );
            })}
            {!users.length && <Empty text="此代理旗下尚無一般用戶" />}
          </div>
        )}
      </article>
    );
  };
  return (
    <Panel
      title="代理結構與分潤稽核"
      description="總代理：私募 2% / 二級市場 0.13%；一般代理：私募 1% / 二級市場 0.07%。"
    >
      <SearchBar
        value={q}
        onChange={setQ}
        placeholder="依暱稱、Email、錢包地址或身份搜尋"
        suggestions={agents.map((agent) => ({
          value: profileName(agent),
          label: profileName(agent),
          detail: `${agent.agency_role} · ${agent.email}${agent.wallet_address ? ` · ${agent.wallet_address}` : ""}`,
        }))}
      />
      <CommissionDateReport
        startDate={reportStartDate}
        endDate={reportEndDate}
        onStartDateChange={setReportStartDate}
        onEndDateChange={setReportEndDate}
        totals={reportTotals}
        onExport={exportAgencyReport}
      />
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() =>
            setLastSeenSort((value) => (value === "desc" ? "asc" : "desc"))
          }
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-300 hover:text-amber-200"
          aria-label={`最近上線時間，現在為${lastSeenSort === "desc" ? "倒序" : "正序"}，點擊切換`}
        >
          最近上線時間 {lastSeenSort === "desc" ? "↓" : "↑"}
        </button>
      </div>
      <div className="flex flex-col gap-3">
        {shown.map((master) => renderAgent(master, "master"))}
        {!shown.length && <Empty text="尚無總代理帳號" />}
      </div>
    </Panel>
  );
}

function AuditRecordsTable({
  title,
  headers,
  empty,
  children,
}: {
  title: string;
  headers: string[];
  empty: string;
  children: ReactNode;
}) {
  const hasRows = Array.isArray(children)
    ? children.length > 0
    : Boolean(children);
  return (
    <section>
      <h3 className="mb-2 text-sm font-bold text-slate-200">{title}</h3>
      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
        {hasRows ? (
          <table className="w-full min-w-[640px] text-xs">
            <thead>
              <tr>
                {headers.map((header) => (
                  <Th key={header}>{header}</Th>
                ))}
              </tr>
            </thead>
            <tbody>{children}</tbody>
          </table>
        ) : (
          <Empty text={empty} />
        )}
      </div>
    </section>
  );
}

function ReportsModule() {
  const { profiles, ledger, audits, placements, commissions } = useAdminData();
  const [treasury, setTreasury] = useState<PlatformFee[]>([]);
  const refreshTreasury = useCallback(async () => {
    const { data } = await supabase.rpc("admin_list_platform_fees");
    setTreasury((previous) =>
      keepStable(previous, (data ?? []) as PlatformFee[]),
    );
  }, []);
  useVisiblePolling(refreshTreasury, 2_000, true);
  const [q, setQ] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [showAllTransactions, setShowAllTransactions] = useState(false);
  const [showAllAudits, setShowAllAudits] = useState(false);
  const email = (id: string) =>
    profiles.find((profile) => profile.id === id)?.email ?? id;
  const ledgerById = new Map(ledger.map((row) => [row.id, row]));
  const commissionById = new Map(commissions.map((row) => [row.id, row]));
  // Commission ledger rows never store asset_id directly — commission_payout
  // only carries a commission_log_id in metadata (the underlying asset lives
  // on that commission_logs row), and commission_pending only carries a
  // source_ledger_id pointing back to the original purchase row. Resolve
  // through those references so the "資產" column shows the real underlying
  // placement instead of the generic transaction-type label.
  const resolveAssetId = (row: Ledger): string | null => {
    if (row.asset_id) return row.asset_id;
    const commissionLogId = row.metadata?.commission_log_id;
    if (typeof commissionLogId === "string") {
      const fromPayout = commissionById.get(commissionLogId)?.asset_id;
      if (fromPayout) return fromPayout;
    }
    const sourceLedgerId = row.metadata?.source_ledger_id;
    if (typeof sourceLedgerId === "string") {
      const fromPending = ledgerById.get(sourceLedgerId)?.asset_id;
      if (fromPending) return fromPending;
    }
    return null;
  };
  const assetName = (row: Ledger) =>
    placements.find((placement) => placement.id === resolveAssetId(row))
      ?.name ??
    (row.entry_type === "sandbox_deposit" ? "測試 USDT" : "代理分潤");
  const invalidRange = Boolean(startDate && endDate && startDate > endDate);
  const rows = ledger.filter(
    (row) =>
      !invalidRange &&
      isWithinDateRange(row.created_at, startDate, endDate) &&
      includes(
        [
          email(row.user_id),
          formatLedgerType(row.entry_type),
          assetName(row),
          row.amount,
        ],
        q,
      ),
  );
  const filteredTreasury = treasury.filter(
    (row) =>
      !invalidRange &&
      isWithinDateRange(row.created_at, startDate, endDate),
  );
  const filteredAudits = audits.filter(
    (audit) =>
      !invalidRange &&
      isWithinDateRange(audit.created_at, startDate, endDate),
  );
  const rangeName = `${startDate || "all"}-${endDate || "all"}`;
  return (
    <Panel
      title="交易報表與管理員操作日誌"
      action={
        <Export
          disabled={invalidRange}
          onClick={() =>
            csv(
              `transactions-${rangeName}`,
              [
                "User",
                "Type",
                "Amount",
                "Asset",
                "Quantity",
                "Created",
                "Ledger ID",
              ],
              rows.map((row) => [
                email(row.user_id),
                formatLedgerType(row.entry_type),
                row.amount,
                assetName(row),
                row.quantity,
                row.created_at,
                row.id,
              ]),
            )
          }
        />
      }
    >
      <SearchBar
        value={q}
        onChange={setQ}
        placeholder="搜尋 Email、交易類型、資產或金額"
        suggestions={rows.map((row) => ({
          value: email(row.user_id),
          label: email(row.user_id),
          detail: `${formatLedgerType(row.entry_type)} · ${assetName(row)} · ${money(row.amount)}`,
        }))}
      />
      <div className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-xs text-slate-400">
          開始日期
          <input
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-200"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs text-slate-400">
          結束日期
          <input
            type="date"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
            className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-200"
          />
        </label>
        <button
          type="button"
          onClick={() => {
            setStartDate("");
            setEndDate("");
          }}
          className="rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-300"
        >
          清除日期
        </button>
      </div>
      {invalidRange && (
        <p role="alert" className="text-sm text-rose-300">
          結束日期不可早於開始日期。
        </p>
      )}
  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
  <Metric label="流水筆數" value={String(rows.length)} />
  <Metric
  label="Safe 金庫累計"
  value={money(filteredTreasury.reduce((sum, row) => sum + Number(row.amount), 0))}
  />
        <Metric
          label="測試入金"
          value={money(
            rows
              .filter((row) => row.entry_type === "sandbox_deposit")
              .reduce((sum, row) => sum + Number(row.amount), 0),
          )}
        />
        <Metric
          label="代理分潤"
          value={money(
            rows
              .filter((row) => row.entry_type === "commission_payout")
              .reduce((sum, row) => sum + Number(row.amount), 0),
          )}
        />
  </div>
  <section>
  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
  <div>
  <h3 className="font-semibold">Safe 金庫入帳稽核</h3>
  <p className="mt-1 break-all text-xs text-slate-500">0x199a423317cE38349574Deb652E4841C29D0De8A</p>
  </div>
  <span className="text-xs text-slate-500">本金、平台費與 Gas 分項記錄</span>
  </div>
  <div className="mt-3">
  <Table>
  <thead><tr><Th>付款人</Th><Th>來源</Th><Th>標的</Th><Th>入帳金額</Th><Th>時間</Th></tr></thead>
  <tbody>
  {filteredTreasury.slice(0, 20).map((row) => (
  <tr key={row.id} className="border-t border-slate-800">
  <Td>{row.payer_email}</Td>
  <Td>{{ p2p_fee: "P2P 平台費", p2p_gas: "P2P Gas", private_principal: "私募本金", private_gas: "私募 Gas" }[row.source_type]}</Td>
  <Td>{placements.find((item) => item.id === row.asset_id)?.name ?? row.asset_id ?? "—"}</Td>
  <Td>{money(row.amount)}</Td>
  <Td>{new Date(row.created_at).toLocaleString()}</Td>
  </tr>
  ))}
  </tbody>
  </Table>
  {filteredTreasury.length === 0 && <p className="p-6 text-center text-sm text-slate-500">所選時間範圍內尚無金庫���帳流水</p>}
  </div>
  </section>
  <section>
  <div className="flex items-center justify-between gap-3">
  <h3 className="font-semibold">交易紀錄</h3>
          {rows.length > 10 && (
            <button
              type="button"
              onClick={() => setShowAllTransactions((visible) => !visible)}
              className="text-xs font-semibold text-amber-300 hover:text-amber-200"
            >
              {showAllTransactions
                ? "收合紀錄"
                : `查閱更多（${rows.length - 10}）`}
            </button>
          )}
        </div>
        <div className="mt-3">
          <Table>
            <thead>
              <tr>
                <Th>用戶</Th>
                <Th>類型</Th>
                <Th>金額</Th>
                <Th>資產</Th>
                <Th>時間</Th>
              </tr>
            </thead>
            <tbody>
              {(showAllTransactions ? rows : rows.slice(0, 10)).map((row) => (
                <tr key={row.id} className="border-t border-slate-800">
                  <Td>{email(row.user_id)}</Td>
                  <Td>{formatLedgerType(row.entry_type)}</Td>
                  <Td>{money(row.amount)}</Td>
                  <Td>{assetName(row)}</Td>
                  <Td>{new Date(row.created_at).toLocaleString()}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </section>
      <section>
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold">管理員操作日誌</h3>
          {filteredAudits.length > 3 && (
            <button
              type="button"
              onClick={() => setShowAllAudits((visible) => !visible)}
              className="text-xs font-semibold text-amber-300 hover:text-amber-200"
            >
              {showAllAudits ? "收合日誌" : `查閱更多（${filteredAudits.length - 3}）`}
            </button>
          )}
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {filteredAudits.length === 0 && (
            <p className="rounded-xl bg-slate-950 p-6 text-center text-sm text-slate-500">
              所選時間範圍內尚無管理員操作日誌
            </p>
          )}
          {(showAllAudits ? filteredAudits : filteredAudits.slice(0, 3)).map((audit) => (
            <article
              key={audit.id}
              className="flex flex-col justify-between gap-1 rounded-xl bg-slate-950 p-3 text-sm sm:flex-row"
            >
              <div className="min-w-0">
                <b className="break-all">{audit.admin_email}</b>
                <p className="mt-1 break-words text-xs text-slate-400">
                  {audit.action} · {audit.target_type} · {audit.target_id}
                </p>
              </div>
              <time className="shrink-0 text-xs text-slate-500">
                {new Date(audit.created_at).toLocaleString()}
              </time>
            </article>
          ))}
        </div>
      </section>
    </Panel>
  );
}

function Export({
  onClick,
  disabled = false,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center justify-center gap-2 rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Download className="size-4" />
      匯出 CSV 報表
    </button>
  );
}
function SearchBar({
  value,
  onChange,
  placeholder,
  suggestions,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  suggestions: SearchSuggestion[];
}) {
  return (
    <SearchSuggest
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      suggestions={suggestions}
    />
  );
}
function Panel({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-5">
      <header className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 className="break-words text-2xl font-bold">{title}</h2>
          {description && (
            <p className="mt-1 break-words text-sm text-slate-400">
              {description}
            </p>
          )}
        </div>
        {action}
      </header>
      {children}
    </div>
  );
}
function Table({ children }: { children: ReactNode }) {
  return (
    <div className="w-full max-w-full overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900 overscroll-x-contain [-webkit-overflow-scrolling:touch]">
      <table className="w-full min-w-[1280px] text-left text-sm">
        {children}
      </table>
    </div>
  );
}
function Th({ children }: { children: ReactNode }) {
  return (
    <th className="whitespace-nowrap border-b border-slate-800 px-5 py-3 text-slate-500">
      {children}
    </th>
  );
}
function Td({ children }: { children: ReactNode }) {
  return <td className="whitespace-nowrap px-5 py-4 text-slate-400">{children}</td>;
}
function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="whitespace-nowrap rounded-full bg-amber-500/10 px-2.5 py-1 text-xs text-amber-300">
      {children}
    </span>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-slate-900 p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 break-words font-semibold text-slate-200">{value}</p>
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-700 p-6 text-center text-sm text-slate-500">
      {text}
    </div>
  );
}
