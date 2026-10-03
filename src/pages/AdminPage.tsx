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
  Coins,
  Download,
  Landmark,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Users,
  Wallet,
} from "lucide-react";
import { Modal, Notice } from "@/components/Modal";
import { supabase } from "@/lib/supabase";
import { getCommissionTypeMeta } from "@/lib/commission-types";
import { translateAdminContent } from "@/lib/translate";
import { formatJC, LANGUAGES, useLanguage, type AssetTranslation, type Lang } from "@/platform";
import { AdminOperations } from "@/components/AdminOperations";
import { UserDetailView } from "@/components/UserDetailView";
import { AdminDashboard } from "@/components/AdminDashboard";
import { ClickableAssetImage } from "@/components/AssetImageGallery";
import { FormattedNumberInput } from "@/components/FormattedNumberInput";
import { useVisiblePolling } from "@/hooks/useVisiblePolling";
import { useOnChainUsdtBalances } from "@/lib/onchainUsdt";
import { callRelayer } from "@/lib/onchainSettlement";
import { CONTRACT_ADDRESSES, factoryTokenOrNull } from "@/lib/contracts";
import {
  CommissionDateReport,
  downloadCsv,
  isWithinDateRange,
} from "@/components/CommissionDateReport";
import {
  SearchSuggest,
  type SearchSuggestion,
} from "@/components/SearchSuggest";
import {
  isTransactionHistoryVisible,
  TRANSACTION_HISTORY_START_LABEL,
} from "@/lib/transactionHistory";

const keepStable = <T,>(previous: T, next: T): T =>
  JSON.stringify(previous) === JSON.stringify(next) ? previous : next;

type Module =
  | "dashboard"
  | "users"
  | "private"
  | "ae_token"
  | "secondary"
  | "agency"
  | "announcements"
  | "payouts"
  | "earnings"
  | "redemptions";
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
  source_type: "p2p_fee" | "p2p_gas" | "private_principal" | "private_gas" | "safe_treasury";
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
  is_ae_token: boolean;
  ae_token_kind: "daily" | "bonus" | null;
  release_frozen_at: string | null;
  release_interval_seconds: number | null;
  release_amount_per_interval: number | null;
  release_started_at: string | null;
  settlement_currency: "usdt" | "ae" | null;
  rwa_total_value: number | null;
  ae_per_share: number | null;
  ae_per_share_price_ref: number | null;
  // RWA Factory 上鏈參數（供後續生產／部署時直接對照）
  token_name: string | null;
  token_symbol: string | null;
  token_decimals: number | null;
  // RWA Factory 部署後回填的鏈上代幣合約地址（每個標的一顆專屬代幣）。
  token_address: string | null;
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
  // 凍結 AE 快照與顯示單位。AE 認購維持 usdt，其餘 ae。
  commission_amount_ae: number | null;
  transaction_amount_ae: number | null;
  display_currency: "ae" | "usdt" | null;
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
    id: "ae_token" as const,
    label: "AE 代幣管理",
    short: "AE代幣",
    icon: Coins,
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
  {
    id: "redemptions" as const,
    label: "鏈上結算與贖回審核",
    short: "鏈上與贖回",
    icon: Wallet,
  },
];
const adminNavigationCopy: Record<Lang, { title: string; front: string; modules: Record<Module, string> }> = {
  "zh-TW": { title: "後台管理中心", front: "前台", modules: { dashboard: "系統監控總覽", users: "用戶與帳號", private: "私募標的物管理", ae_token: "AE 代幣管理", secondary: "二級市場標的物", agency: "總代理及代理結構", announcements: "公告管理", payouts: "獎金派發", earnings: "交易報表與稽核", redemptions: "USDT 贖回審核" } },
  "zh-CN": { title: "后台管理中心", front: "前台", modules: { dashboard: "系统监控总览", users: "用户与账号", private: "私募标的管理", ae_token: "AE 代币管理", secondary: "二级市场标的", agency: "总代理及代理结构", announcements: "公告管理", payouts: "奖金发放", earnings: "交易报表与审核", redemptions: "USDT 赎回审核" } },
  en: { title: "Admin center", front: "Main site", modules: { dashboard: "System overview", users: "Users and accounts", private: "Private placements", ae_token: "AE token", secondary: "Secondary market", agency: "Agency structure", announcements: "Announcements", payouts: "Bonus payouts", earnings: "Reports and audit", redemptions: "USDT redemptions" } },
  ja: { title: "管理センター", front: "フロント", modules: { dashboard: "システム概要", users: "ユーザーとアカウント", private: "私募資産管理", ae_token: "AEトークン管理", secondary: "二次市場資産", agency: "代理店構造", announcements: "お知らせ管理", payouts: "ボーナス支給", earnings: "取引レポートと監査", redemptions: "USDT償還審査" } },
  ko: { title: "관리 센터", front: "메인 사이트", modules: { dashboard: "시스템 개요", users: "사용자 및 계정", private: "사모 자산 관리", ae_token: "AE 토큰 관리", secondary: "2차 시장 자산", agency: "대리점 구조", announcements: "공지 관리", payouts: "보너스 지급", earnings: "거래 보고서 및 감사", redemptions: "USDT 환매 심사" } },
  th: { title: "ศูนย์ผู้ดูแลระบบ", front: "หน้าหลัก", modules: { dashboard: "ภาพรวมระบบ", users: "ผู้ใช้และบัญชี", private: "การจัดการสินทรัพย์เสนอขายส่วนตัว", ae_token: "จัดการโทเค็น AE", secondary: "สินทรัพย์ตลาดรอง", agency: "โครงสร้างตัวแทน", announcements: "จัดการประกาศ", payouts: "จ่ายโบนัส", earnings: "รายงานและการตรวจสอบ", redemptions: "ตรวจสอบการไถ่ถอน USDT" } },
  vi: { title: "Trung tâm quản trị", front: "Trang chính", modules: { dashboard: "Tổng quan hệ thống", users: "Người dùng và tài khoản", private: "Quản lý tài sản phát hành riêng lẻ", ae_token: "Quản lý token AE", secondary: "Tài sản thị trường thứ cấp", agency: "Cơ cấu đại lý", announcements: "Quản lý thông báo", payouts: "Phân phối thưởng", earnings: "Báo cáo và kiểm toán", redemptions: "Duyệt hoàn tiền USDT" } },
  id: { title: "Pusat admin", front: "Situs utama", modules: { dashboard: "Ringkasan sistem", users: "Pengguna dan akun", private: "Pengelolaan penempatan privat", ae_token: "Manajemen token AE", secondary: "Aset pasar sekunder", agency: "Struktur agen", announcements: "Kelola pengumuman", payouts: "Pembayaran bonus", earnings: "Laporan dan audit", redemptions: "Peninjauan penukaran USDT" } },
  ms: { title: "Pusat pentadbir", front: "Laman utama", modules: { dashboard: "Gambaran sistem", users: "Pengguna dan akaun", private: "Pengurusan penempatan persendirian", ae_token: "Pengurusan token AE", secondary: "Aset pasaran sekunder", agency: "Struktur ejen", announcements: "Urus pengumuman", payouts: "Pembayaran bonus", earnings: "Laporan dan audit", redemptions: "Semakan tebusan USDT" } },
  es: { title: "Centro de administración", front: "Sitio principal", modules: { dashboard: "Resumen del sistema", users: "Usuarios y cuentas", private: "Colocaciones privadas", ae_token: "Gestión de tokens AE", secondary: "Mercado secundario", agency: "Estructura de agentes", announcements: "Anuncios", payouts: "Pago de bonos", earnings: "Informes y auditoría", redemptions: "Revisión de reembolsos USDT" } },
  fr: { title: "Centre d’administration", front: "Site principal", modules: { dashboard: "Vue d’ensemble du système", users: "Utilisateurs et comptes", private: "Placements privés", ae_token: "Gestion des jetons AE", secondary: "Marché secondaire", agency: "Structure des agents", announcements: "Annonces", payouts: "Versement des bonus", earnings: "Rapports et audit", redemptions: "Revue des remboursements USDT" } },
  de: { title: "Admin-Center", front: "Hauptseite", modules: { dashboard: "Systemübersicht", users: "Benutzer und Konten", private: "Privatplatzierungen", ae_token: "AE-Token-Verwaltung", secondary: "Sekundärmarkt", agency: "Agentenstruktur", announcements: "Ankündigungen", payouts: "Bonusauszahlungen", earnings: "Berichte und Prüfung", redemptions: "USDT-Rückkaufprüfung" } },
  pt: { title: "Centro administrativo", front: "Site principal", modules: { dashboard: "Visão geral do sistema", users: "Utilizadores e contas", private: "Colocações privadas", ae_token: "Gestão de tokens AE", secondary: "Mercado secundário", agency: "Estrutura de agentes", announcements: "Anúncios", payouts: "Pagamento de bónus", earnings: "Relatórios e auditoria", redemptions: "Revisão de resgates USDT" } },
  ru: { title: "Центр администратора", front: "Главная", modules: { dashboard: "Обзор системы", users: "Пользователи и аккаунты", private: "Частные размещения", ae_token: "Управление токеном AE", secondary: "Вторичный рынок", agency: "Структура агентов", announcements: "Объявления", payouts: "Выплата бонусов", earnings: "Отчёты и аудит", redemptions: "Проверка вывода USDT" } },
  ar: { title: "مركز الإدارة", front: "الموقع الرئيسي", modules: { dashboard: "نظرة عامة على النظام", users: "المستخدمون والحسابات", private: "الطروحات الخاصة", ae_token: "إدارة رمز AE", secondary: "السوق الثانوية", agency: "هيكل الوكلاء", announcements: "إدارة الإعلانات", payouts: "صرف المكافآت", earnings: "التقارير والتدقيق", redemptions: "مراجعة استرداد USDT" } },
  hi: { title: "व्यवस्थापन केंद्र", front: "मुख्य साइट", modules: { dashboard: "सिस्टम अवलोकन", users: "उपयोगकर्ता और खाते", private: "निजी प्लेसमेंट प्रबंधन", ae_token: "AE टोकन प्रबंधन", secondary: "द्वितीयक बाज़ार एसेट", agency: "एजेंट संरचना", announcements: "घोषणा प्रबंधन", payouts: "बोनस वितरण", earnings: "रिपोर्ट और ऑडिट", redemptions: "USDT रिडेम्पशन समीक्षा" } },
};

const includes = (values: unknown[], query: string) =>
  values.some((value) =>
    String(value ?? "")
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
const money = (value: number) =>
  `${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
// 分潤/交易金額一律以 JC 記錄與顯示（commission_logs 已直接存 JC）。
const commissionAeValue = (log: { commission_amount: number }) =>
  Number(log.commission_amount);
const logCommissionCell = (log: Commission) => formatJC(log.commission_amount);
const logTransactionCell = (log: Commission) => formatJC(log.transaction_amount);
const ledgerTypeLabel: Record<string, string> = {
  sandbox_deposit: "測試入金",
  private_purchase: "私募認購",
  secondary_buy: "舊二級市場買入",
  secondary_sell: "舊二級市場賣出",
  p2p_buy: "P2P 買方支付",
  p2p_sell: "P2P 賣方實收",
  p2p_gas: "P2P Gas 費",
  commission: "代理分潤",
  commission_pending: "待發放分潤",
  commission_payout: "代理分潤發放",
  // 金庫買 JC（鏈上轉帳 USDT 進 Safe）與贖回（USDT 出金，尚未上鏈自動撥款）。
  vault_buy_jc: "金庫買 JC（USDT 支出）",
  vault_redeem_jc: "金庫贖回（USDT 入帳）",
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
          <main className="admin-mobile-main p-4 sm:p-6 lg:p-8">
            {module === "dashboard" && (
              <AdminDashboard onViewUser={openUserDetail} />
            )}
            {module === "users" && (
              <UsersModule onOpenDetail={openUserDetail} />
            )}
            {module === "private" && <PrivateModule />}
            {module === "ae_token" && <AeTokenModule />}
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
                {module === "redemptions" && (
                  <div className="flex flex-col gap-4">
          <OnchainWiringCard />
              <VaultStatusCard />
              <MintTokenCard />
              <SettlementRetryModule />
              <RedemptionsModule />
                  </div>
                )}
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
  // 2026-09-12 導入 JC 幣後，本金/認購/金庫買幣等記帳都改寫進 jc_ledger，
  // asset_ledger 現在只剩 USDT 側的 vault_buy_jc 鏡射列。任何要看「本金、認購、
  // 分潤待入帳、退款」的地方都要讀 jcLedger，不能只讀 ledger（asset_ledger）。
  const [jcLedger, setJcLedger] = useState<Ledger[]>([]);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [commissions, setCommissions] = useState<Commission[]>([]);
  const [commissionLoadError, setCommissionLoadError] = useState("");
  const [audits, setAudits] = useState<Audit[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    const [p, l, jl, pp, c, a] = await Promise.all([
      supabase
        .from("profiles")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase
        .from("asset_ledger")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase
        .from("jc_ledger")
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
    setJcLedger((previous) => keepStable(previous, (jl.data ?? []) as Ledger[]));
    setPlacements((previous) => keepStable(previous, (pp.data ?? []) as Placement[]));
    if (c.error) {
      setCommissionLoadError("分潤紀錄載入失敗；請重新整理或重新登入後再試。");
    } else {
      setCommissionLoadError("");
      setCommissions((previous) => keepStable(previous, (c.data ?? []) as Commission[]));
    }
    setAudits((previous) => keepStable(previous, (a.data ?? []) as Audit[]));
    setLoading(false);
  };
 useVisiblePolling(refresh, 1_000, true);
  return {
    profiles,
    ledger,
    jcLedger,
    placements,
    commissions,
    commissionLoadError,
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
  const [userCommissions, setUserCommissions] = useState<
    {
      beneficiary_id: string;
      commission_amount: number;
      created_at: string;
    }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const refresh = useCallback(async () => {
    const [
      profilesResult,
      ledgerResult,
      commissionsResult,
    ] = await Promise.all([
      supabase
        .from("profiles")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase
        .from("jc_ledger")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase
        .from("commission_logs")
        .select("beneficiary_id,commission_amount,created_at"),
    ]);
    const firstError =
      profilesResult.error ??
      ledgerResult.error ??
      commissionsResult.error;
    if (firstError) {
      setLoadError("用戶資料載入失敗，請稍後重新整理。");
    }
    setProfiles((previous) => keepStable(previous, (profilesResult.data ?? []) as Profile[]));
    setLedger((previous) => keepStable(previous, (ledgerResult.data ?? []) as Ledger[]));
    setUserCommissions((previous) =>
      keepStable(
        previous,
        (commissionsResult.data ?? []) as {
          beneficiary_id: string;
          commission_amount: number;
          created_at: string;
        }[],
      ),
    );
    if (!firstError) setLoadError("");
    setLoading(false);
  }, []);
 useVisiblePolling(refresh, 1_000, true);
  // USDT 是真實鏈上資產（Base Sepolia 測試網），後台一律直接讀鏈上 balanceOf，
  // 不再用內部沙盒帳本（asset_ledger）加總，避免顯示與真實資產脫節。
  const walletAddresses = useMemo(
    () => profiles.map((user) => user.wallet_address),
    [profiles],
  );
  const { balanceOf: onChainBalanceOf } = useOnChainUsdtBalances(walletAddresses);
  const now = useCurrentTime();
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("全部");
  const [bonusSort, setBonusSort] = useState<"asc" | "desc">("desc");
  const [expandedMasters, setExpandedMasters] = useState<string[]>([]);
  const [expandedAgents, setExpandedAgents] = useState<string[]>([]);
  // USDT 為真實鏈上資產，一律依錢包地址讀鏈上餘額；未綁定錢包則顯示 0。
  const balance = (id: string) =>
    onChainBalanceOf(profiles.find((user) => user.id === id)?.wallet_address);
  const investmentAmount = (id: string, entryTypes: string | string[]) => {
    const types = Array.isArray(entryTypes) ? entryTypes : [entryTypes];
    return ledger
      .filter(
        (row) =>
          row.user_id === id &&
          types.includes(row.entry_type) &&
          isTransactionHistoryVisible(row.created_at),
      )
      .reduce((sum, row) => sum + Math.abs(Number(row.amount)), 0);
  };
  // 累積分潤一律以 JC 呈現（commission_logs 已直接以 JC 記錄）。
  const bonusAmount = useCallback(
    (id: string) =>
      userCommissions
        .filter(
          (row) =>
            row.beneficiary_id === id &&
            isTransactionHistoryVisible(row.created_at),
        )
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
          {formatJC(investmentAmount(user.id, "private_purchase"))}
        </span>
      </Td>
      <Td>
        <span className="font-semibold text-slate-200">
          {formatJC(investmentAmount(user.id, ["secondary_buy", "p2p_buy"]))}
        </span>
      </Td>
      <Td>
        <b className="text-amber-200">{formatJC(bonusAmount(user.id))}</b>
      </Td>
    </tr>
  );
  return (
    <Panel
      title="用戶與帳號"
      action={
        <div className="flex flex-wrap items-center justify-end gap-2">
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
      <p className="mb-3 text-xs text-slate-500">
        投資與獎金統計自 {TRANSACTION_HISTORY_START_LABEL}（台北）起；更早的帳本保留供稽核，不納入彙總。
      </p>
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
              <Th>USDT 餘額（鏈上即時）</Th>
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

type RedemptionOrderAdminRow = {
  id: string;
  user_id: string;
  wallet_address: string;
  jc_amount: number;
  usdt_amount: number;
  jc_price: number;
  status: "pending" | "completed" | "rejected";
  tx_hash: string | null;
  admin_note: string | null;
  created_at: string;
  resolved_at: string | null;
};

// 一次性把 RWA 一級認購 / 二級市場子合約位址寫進 RWA 鑄造工廠合約，讓 relayer
// 代發的 executeSubscription / executeTrade 有權在鏈上鑄發／移轉 RWA。若這兩
// 項設定仍是 0x0（未初始化），所有鏈上認購/成交結算都會 revert。僅需執行一次。
// 若失敗提示「不是 owner」，需先由合約部署者將母合約的 owner 轉移給 ADMIN
// 熱錢包地址。2026-09-19：JC/AE 代幣改為標準 ERC20 + Safe 金庫 transferFrom
// 發放模式，不再需要對代幣本身呼叫 setMarketContract，因此這裡只剩 RWA 母合約
// 需要初始化。
function OnchainWiringCard() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      const rwa = await callRelayer("wire-contracts");
      const wired = (rwa.results ?? {}) as {
        subscription?: string;
        market?: string;
        marketError?: string;
      };
      if (wired.marketError) {
        setResult({
          text: `RWA 一級認購已設定完成（${wired.subscription ?? "-"}）。但二級市場設定失敗：${wired.marketError}`,
          ok: false,
        });
      } else {
        setResult({
          text: `已初始化：RWA 認購 ${wired.subscription ?? "-"}；RWA 二級 ${wired.market ?? "-"}`,
          ok: true,
        });
      }
    } catch (error) {
      setResult({ text: error instanceof Error ? error.message : "初始化失敗", ok: false });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-sky-500/20 bg-sky-500/5 p-4">
      <div>
        <h3 className="font-bold text-slate-200">鏈上合約初始化（一次性）</h3>
        <p className="mt-1 text-xs text-slate-400">
          把 RWA 一級認購 / 二級市場合約位址寫入 RWA 鑄造工廠合約，啟用 relayer 的鏈上結算。僅需執行一次；重複執行會自動略過已設定項目。
        </p>
      </div>
      {result && <Notice message={result.text} tone={result.ok ? "success" : "error"} />}
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="w-fit rounded-xl bg-sky-500 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50"
      >
        {busy ? "初始化中…" : "初始化鏈上合約"}
      </button>
    </section>
  );
}

type VaultTokenStatus = {
  token: "jcToken" | "aeToken";
  tokenAddress: string;
  balance: string;
  low: boolean;
};

type VaultRwaStatus = {
  name: string;
  tokenAddress: string;
  balance: string;
};

// 唯讀診斷卡片：顯示 ADMIN 熱錢包目前持有的 JC/AE 庫存，用來確認是否需要人
// 工從 Safe 金庫轉一批代幣補貨。刻意不提供任何「一鍵補貨」按鈕——從 Safe 金
// 庫轉出資產必須由 Safe 擁有人在 Safe{Wallet} 上簽署，這裡的 ADMIN 私鑰無權
// 代表 Safe 執行這個操作，前端也不應該誘導管理員以為按個按鈕就能完成。
function VaultStatusCard() {
  const [admin, setAdmin] = useState<string | null>(null);
  const [jc, setJc] = useState<VaultTokenStatus | null>(null);
  const [ae, setAe] = useState<VaultTokenStatus | null>(null);
  const [rwa, setRwa] = useState<VaultRwaStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const res = await callRelayer("admin-vault-status");
      setAdmin(String(res.admin ?? ""));
      setJc(res.jc as VaultTokenStatus);
      setAe(res.ae as VaultTokenStatus);
      setRwa(Array.isArray(res.rwa) ? (res.rwa as VaultRwaStatus[]) : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "讀取熱錢包庫存失敗");
    } finally {
      setLoading(false);
    }
  };
  useVisiblePolling(load, 30_000, true);

  const renderToken = (label: string, status: VaultTokenStatus | null) => {
    if (!status) return null;
    return (
      <div className="flex flex-col gap-1 rounded-xl border border-slate-700/60 bg-slate-900/40 p-3">
        <p className="font-bold text-slate-200">{label}</p>
        <p className="font-mono text-xs text-slate-500">{status.tokenAddress}</p>
        <p className="text-sm text-slate-300">
          熱錢包庫存 <span className="font-bold text-emerald-300">{status.balance}</span>
        </p>
        {status.low && (
          <p className="text-sm text-amber-300">庫存偏低，建議管理員從 Safe 金庫轉一批到 ADMIN 熱錢包補貨</p>
        )}
      </div>
    );
  };

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
      <div>
        <h3 className="font-bold text-slate-200">ADMIN 熱錢包庫存（唯讀診斷）</h3>
        <p className="mt-1 text-xs text-slate-400">
          發放 JC/AE 由 ADMIN 熱錢包直接轉帳自己的餘額給使用者。庫存由管理員人工從 Safe 金庫轉一批
          JC/AE 到下方 ADMIN 熱錢包地址補貨，不需要任何 approve 或授權設定。
        </p>
        <p className="mt-1 font-mono text-xs text-slate-500">ADMIN 熱錢包：{loading ? "讀取中…" : admin}</p>
      </div>
      {error && <Notice message={error} tone="error" />}
      <div className="grid gap-3 sm:grid-cols-2">
        {renderToken("JC", jc)}
        {renderToken("AE", ae)}
      </div>
      <div>
        <p className="text-sm font-bold text-slate-200">RWA 標的份額（上架中）</p>
        <p className="mt-1 text-xs text-slate-400">
          僅顯示上架中、已部署專屬代幣的 RWA 標的，數字為 ADMIN 熱錢包目前持有的份額；下架標的不列出。
        </p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {rwa.length === 0 ? (
            <p className="text-xs text-slate-500">目前沒有已部署專屬代幣的上架中 RWA 標的。</p>
          ) : (
            rwa.map((item) => (
              <div
                key={item.tokenAddress}
                className="flex flex-col gap-1 rounded-xl border border-slate-700/60 bg-slate-900/40 p-3"
              >
                <p className="font-bold text-slate-200">{item.name || "未命名標的"}</p>
                <p className="font-mono text-xs text-slate-500">{item.tokenAddress}</p>
                <p className="text-sm text-slate-300">
                  熱錢包份額 <span className="font-bold text-emerald-300">{item.balance}</span>
                </p>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

// 增發卡片：呼叫新版 JC/AE 合約的 owner `mint`，真的增加鏈上總供給量。這跟上面
// VaultStatusCard 的「熱錢包轉帳」不同、風險較高（會增加總供給），故獨立成另一
// 張卡片、需手動輸入數量才會送出，且預設收款地址是 Safe 金庫。
function MintTokenCard() {
  const [token, setToken] = useState<"jc" | "ae">("jc");
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setError("請輸入大於 0 的增發數量");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await callRelayer("admin-mint", { token, amount: n, to: to.trim() || undefined });
      setResult(`已增發 ${n} ${token.toUpperCase()} 給 ${String(res.to ?? "Safe 金庫")}，tx: ${String(res.txHash ?? "")}`);
      setAmount("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "增發失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
      <div>
        <h3 className="font-bold text-slate-200">增發 JC / AE（鏈上 mint）</h3>
        <p className="mt-1 text-xs text-slate-400">
          直接呼叫新版合約的 owner 增發權限，會真的增加該代幣的總供給量。不填收款地址預設發到 Safe 金庫。
        </p>
      </div>
      {error && <Notice message={error} tone="error" />}
      {result && <Notice message={result} tone="success" />}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm text-slate-300">
          代幣
          <select
            value={token}
            onChange={(e) => setToken(e.target.value as "jc" | "ae")}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-200"
          >
            <option value="jc">JC</option>
            <option value="ae">AE</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-300">
          增發數量
          <input
            type="number"
            min="0"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="例如 100000"
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-200"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-300 sm:col-span-2">
          收款地址（留空＝Safe 金庫）
          <input
            type="text"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="0x…（留空預設 Safe 金庫）"
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-200"
          />
        </label>
      </div>
      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="self-start rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50"
      >
        {busy ? "增發中…" : "確認增發"}
      </button>
    </section>
  );
}

type SettlementAttentionItem = {
  id: string | null;
  action: "mint_jc" | "subscribe" | "trade" | "list_fee" | "redeem";
  ledgerRowId: string;
  userId: string;
  userLabel: string;
  assetId: string | null;
  assetName: string | null;
  amount: number | null;
  payment?: number | null;
  status: "failed" | "stale_pending" | "orphan";
  error: string | null;
  txHash?: string | null;
  createdAt: string;
  updatedAt?: string;
};

const SETTLEMENT_ACTION_LABEL: Record<SettlementAttentionItem["action"], string> = {
  mint_jc: "金庫買 JC 發幣",
  subscribe: "一級認購結算",
  trade: "二級市場成交結算",
  list_fee: "掛單手續費入金庫",
  redeem: "JC 贖回撥款",
  };
const SETTLEMENT_STATUS_LABEL: Record<SettlementAttentionItem["status"], string> = {
  failed: "鏈上結算失敗",
  stale_pending: "卡在處理中太久",
  orphan: "已扣款但從未送出結算",
};

// 這是本系統對「使用者付了錢卻沒拿到幣」這個風險的核心防線：無論是鏈上呼叫
// 失敗、relayer 當下沒有 gas、還是使用者付款後瀏覽器直接關掉導致從未送出任何
// 結算請求，都會出現在這份清單中，而不會悄悄消失。使用者端也會在登入/開錢包
// 時自動背景重試（見 src/lib/onchainSettlement.ts reconcilePendingSettlements），
// 這裡則是管理員可以看見全站現況、並在自動重試仍失敗時一鍵強制補發的地方。
function SettlementRetryModule() {
  const [items, setItems] = useState<SettlementAttentionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [retryingKey, setRetryingKey] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await callRelayer("admin-list-settlements");
      setItems((res.items ?? []) as SettlementAttentionItem[]);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "讀取補發清單失敗", ok: false });
    } finally {
      setLoading(false);
    }
  };
  useVisiblePolling(load, 15_000, true);

  const retry = async (item: SettlementAttentionItem) => {
    const key = item.id ?? `${item.action}:${item.ledgerRowId}`;
    setRetryingKey(key);
    setNotice(null);
    try {
      const res = item.id
        ? await callRelayer("admin-retry-settlement", { settlementId: item.id })
        : await callRelayer("admin-retry-settlement", {
            ledgerAction: item.action,
            ledgerRowId: item.ledgerRowId,
          });
      const status = res.status as string | undefined;
      setNotice({
        text:
          status === "confirmed"
            ? `補發成功：${item.userLabel} 的${SETTLEMENT_ACTION_LABEL[item.action]}已完成${res.tx_hash ? `（Tx：${String(res.tx_hash)}）` : ""}`
            : status === "pending"
              ? "已在處理中，請稍候再重新整理"
              : "已送出補發請求",
        ok: true,
      });
      await load();
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "補發失敗", ok: false });
    } finally {
      setRetryingKey(null);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-rose-500/20 bg-rose-500/5 p-4">
      <div>
        <h3 className="font-bold text-slate-200">鏈上發幣／結算補發（{items.length}）</h3>
        <p className="mt-1 text-xs text-slate-400">
          列出所有站內已扣款、但鏈上結算失敗、卡在處理中太久、或從未送出結算請求的紀錄，涵蓋金庫買 JC、一級認購、二級市場成交三種流程。系統會在使用者登入時自動背景重試；若仍失敗，請在此一鍵補發。
        </p>
      </div>
      {notice && <Notice message={notice.text} tone={notice.ok ? "success" : "error"} />}
      {loading && items.length === 0 && <Empty text="讀取中…" />}
      {!loading && items.length === 0 && <Empty text="目前沒有需要補發的鏈上結算" />}
      <div className="flex flex-col gap-3">
        {items.map((item) => {
          const key = item.id ?? `${item.action}:${item.ledgerRowId}`;
          return (
            <article key={key} className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Tag>{SETTLEMENT_ACTION_LABEL[item.action]}</Tag>
                    <span className="rounded-full bg-rose-500/10 px-2.5 py-1 text-xs text-rose-300">
                      {SETTLEMENT_STATUS_LABEL[item.status]}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-slate-200">
                    使用者：<b>{item.userLabel}</b>
                    {item.assetName && (
                      <>
                        {" "}
                        · 標的：<b>{item.assetName}</b>
                      </>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {item.amount != null && <>數量/JC：{formatJC(item.amount)} </>}
                    {item.payment != null && <>· 金額：{formatJC(item.payment)} </>}
                    · 發生時間：{new Date(item.createdAt).toLocaleString("zh-TW")}
                  </p>
                  {item.error && (
                    <p className="mt-2 break-all text-xs text-rose-300">原因：{item.error}</p>
                  )}
                  {item.txHash && (
                    <p className="mt-1 break-all font-mono text-xs text-slate-500">Tx：{item.txHash}</p>
                  )}
                </div>
                <button
                  onClick={() => void retry(item)}
                  disabled={retryingKey === key}
                  className="w-fit shrink-0 rounded-xl bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50"
                >
                  {retryingKey === key ? "補發中…" : "一鍵補發"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

// Safe 是多簽金庫，前端使用者的錢包簽名無法讓 Safe 主動撥款，因此贖回是佇列制：
// 用戶申請時已扣 JC，這裡只負責「Safe 完成鏈上撥款後回填 tx hash 結案」或「拒絕退回 JC」。
function RedemptionsModule() {
  const [orders, setOrders] = useState<RedemptionOrderAdminRow[]>([]);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [txDrafts, setTxDrafts] = useState<Record<string, string>>({});
  const load = async () => {
    const { data } = await supabase
      .from("redemption_orders")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    setOrders((data ?? []) as RedemptionOrderAdminRow[]);
  };
  useVisiblePolling(load, 4_000, true);
  const pending = orders.filter((order) => order.status === "pending");
  const resolved = orders.filter((order) => order.status !== "pending");

  const complete = async (order: RedemptionOrderAdminRow) => {
    const txHash = (txDrafts[order.id] ?? "").trim();
    if (!/^0x[a-fA-F0-9]{10,}$/.test(txHash)) {
      setNotice({ text: "請輸入有效的鏈上交易 Tx Hash", ok: false });
      return;
    }
    const { error } = await supabase.rpc("admin_complete_redemption", {
      order_id: order.id,
      tx_hash: txHash,
    });
    setNotice({
      text: error ? "結案失敗，請確認 Tx Hash 與訂單狀態" : "已標記完成撥款",
      ok: !error,
    });
    if (!error) {
      setTxDrafts((v) => ({ ...v, [order.id]: "" }));
      await load();
    }
  };
  const reject = async (order: RedemptionOrderAdminRow) => {
    const note = window.prompt("請輸入拒絕原因") || "審核未通過";
    const { error } = await supabase.rpc("admin_reject_redemption", {
      order_id: order.id,
      note,
    });
    setNotice({
      text: error ? "拒絕失敗，請確認訂單狀態" : "已拒絕並退回用戶 JC",
      ok: !error,
    });
    if (!error) await load();
  };

  return (
    <Panel title="USDT 贖回審核">
      {notice && <Notice message={notice.text} tone={notice.ok ? "success" : "error"} />}
      <p className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-200">
        Safe 為多簽金庫，無法由前端自動撥款。請先在 Safe 完成鏈上 USDT 轉帳給用戶錢包地址，再回填
        Tx Hash 標記完成；若不通過，用戶的 JC 會自動退回。
      </p>
      <section className="flex flex-col gap-3">
        <h3 className="font-bold text-slate-200">待審核（{pending.length}）</h3>
        {pending.length === 0 && <Empty text="目前沒有待審核的贖回申請" />}
        {pending.map((order) => (
          <article key={order.id} className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <b className="text-slate-100">{formatJC(order.jc_amount)}</b>
                  <span className="text-slate-500">→</span>
                  <b className="text-emerald-300">{order.usdt_amount.toFixed(2)} USDT</b>
                  <Tag>{order.status}</Tag>
                </div>
                <p className="mt-2 break-all font-mono text-xs text-slate-400">
                  收款地址：{order.wallet_address}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  申請時間：{new Date(order.created_at).toLocaleString("zh-TW")} · 單價 {order.jc_price}
                </p>
              </div>
              <div className="flex w-full flex-col gap-2 sm:w-72">
                <input
                  aria-label="鏈上交易 Tx Hash"
                  value={txDrafts[order.id] ?? ""}
                  onChange={(e) => setTxDrafts((v) => ({ ...v, [order.id]: e.target.value }))}
                  placeholder="貼上 Safe 撥款的 Tx Hash（0x…）"
                  className="rounded-xl border border-slate-700 bg-slate-950 p-3 font-mono text-xs"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => void complete(order)}
                    className="flex-1 rounded-xl bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950"
                  >
                    標記完成
                  </button>
                  <button
                    onClick={() => void reject(order)}
                    className="flex-1 rounded-xl border border-red-500/30 px-4 py-2 text-sm text-red-300"
                  >
                    拒絕
                  </button>
                </div>
              </div>
            </div>
          </article>
        ))}
      </section>
      <section className="flex flex-col gap-3">
        <h3 className="font-bold text-slate-200">已處理紀錄</h3>
        {resolved.length === 0 && <Empty text="尚無已處理的贖回紀錄" />}
        {resolved.map((order) => (
          <article
            key={order.id}
            className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <b>{formatJC(order.jc_amount)}</b>
              <span className="text-slate-500">→</span>
              <b>{order.usdt_amount.toFixed(2)} USDT</b>
              <Tag>{order.status === "completed" ? "已撥款" : "已拒絕"}</Tag>
            </div>
            {order.tx_hash && (
              <p className="mt-2 break-all font-mono text-xs text-slate-500">
                Tx：{order.tx_hash}
              </p>
            )}
            {order.admin_note && (
              <p className="mt-1 text-xs text-slate-500">備註：{order.admin_note}</p>
            )}
          </article>
        ))}
      </section>
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
  const [creatingRwaToken, setCreatingRwaToken] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deactivateTarget, setDeactivateTarget] = useState<Placement | null>(null);
  const [deactivating, setDeactivating] = useState(false);
  const [featuredAssetId, setFeaturedAssetId] = useState("");
  const [savingFeatured, setSavingFeatured] = useState(false);
  const [jcBuyPriceInput, setJcBuyPriceInput] = useState("");
  const [jcRedeemPriceInput, setJcRedeemPriceInput] = useState("");
  const [savingJcBuyPrice, setSavingJcBuyPrice] = useState(false);
  const [savingJcRedeemPrice, setSavingJcRedeemPrice] = useState(false);
  useEffect(() => {
    void supabase
      .from("platform_config")
      .select("featured_asset_id,jc_price,jc_redeem_price")
      .maybeSingle()
      .then(({ data }) => {
        setFeaturedAssetId(data?.featured_asset_id ?? "");
        const buyPrice = Number(data?.jc_price ?? 1) || 1;
        setJcBuyPriceInput(String(buyPrice));
        setJcRedeemPriceInput(String(data?.jc_redeem_price ?? buyPrice));
      });
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
    tokenName: "",
    tokenSymbol: "",
    tokenDecimals: "",
    tokenAddress: "",
    history: [] as string[],
    comparables: [] as string[],
    advantages: [] as string[],
    translations: emptyTranslations(),
  });
  const resetDraft = () => {
    setEditingId(null);
    setImageUrl("");
    setDraft({ id: "", address: "", images: [], price: "", valuation: "", apy: "", total: "", available: "", endsAt: "", tokenName: "", tokenSymbol: "", tokenDecimals: "", tokenAddress: "", history: [], comparables: [], advantages: [], translations: emptyTranslations() });
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
      tokenName: item.token_name ?? "",
      tokenSymbol: item.token_symbol ?? "",
      tokenDecimals: item.token_decimals == null ? "" : String(item.token_decimals),
      tokenAddress: factoryTokenOrNull(item.token_address) ?? "",
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
  const saveJcBuyPrice = async () => {
    const price = Number(jcBuyPriceInput);
    if (!Number.isFinite(price) || price <= 0 || price > 1_000_000) {
      setNotice("JC 買入單價需大於 0 且不得超過 1,000,000 USDT");
      return;
    }

    setSavingJcBuyPrice(true);
    try {
      const { data, error } = await supabase.rpc("admin_set_jc_price", {
        new_price: price,
      });
      if (error) {
        const detail = [error.message, error.details, error.hint, error.code]
          .filter(Boolean)
          .join(" · ");
        setNotice(`JC 買入單價更新失敗：${detail || "未知資料庫錯誤"}`);
        return;
      }

      const savedPrice = Number(data);
      if (!Number.isFinite(savedPrice) || savedPrice <= 0) {
        setNotice("JC 買入單價更新請求已送出，但未收到有效的新單價，請重新整理確認");
        return;
      }

      setJcBuyPriceInput(String(savedPrice));
      window.dispatchEvent(new Event("platform-assets-updated"));
      setNotice(`JC 買入單價已更新：買入 1 JC = ${savedPrice} USDT`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知連線錯誤";
      setNotice(`JC 買入單價更新失敗：${message}`);
    } finally {
      setSavingJcBuyPrice(false);
    }
  };
  const saveJcRedeemPrice = async () => {
    const price = Number(jcRedeemPriceInput);
    if (!Number.isFinite(price) || price <= 0 || price > 1_000_000) {
      setNotice("JC 回收單價需大於 0 且不得超過 1,000,000 USDT");
      return;
    }

    setSavingJcRedeemPrice(true);
    try {
      const { data, error } = await supabase.rpc("admin_set_jc_redeem_price", {
        new_price: price,
      });
      if (error) {
        const detail = [error.message, error.details, error.hint, error.code]
          .filter(Boolean)
          .join(" · ");
        setNotice(`JC 回收單價更新失敗：${detail || "未知資料庫錯誤"}`);
        return;
      }

      const savedPrice = Number(data);
      if (!Number.isFinite(savedPrice) || savedPrice <= 0) {
        setNotice("JC 回收單價更新請求已送出，但未收到有效的新單價，請重新整理確認");
        return;
      }

      setJcRedeemPriceInput(String(savedPrice));
      window.dispatchEvent(new Event("platform-assets-updated"));
      setNotice(`JC 回收單價已更新：回收 1 JC = ${savedPrice} USDT`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知連線錯誤";
      setNotice(`JC 回收單價更新失敗：${message}`);
    } finally {
      setSavingJcRedeemPrice(false);
    }
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
  // 在 RWA Factory 為此標的部署專屬份額代幣（一鍵，讀後端已儲存的
  // 名稱/符號/小數位數/總供給量，成功後直接回填 tokenAddress，不需要另外
  // 儲存一次）。僅在標的已存在（editingId）且尚未有 token_address 時可用。
  const createRwaToken = async () => {
    if (!editingId || creatingRwaToken) return;
    if (!draft.tokenSymbol.trim()) {
      setNotice("請先填寫「代幣符號（Token Symbol）」並儲存後再建立代幣");
      return;
    }
    setCreatingRwaToken(true);
    setNotice("正在於 RWA Factory 建立專屬代幣（需要一次鏈上交易，請稍候）…");
    try {
      const res = await callRelayer("admin-create-rwa-token", { placementId: editingId });
      const tokenAddress = typeof res.tokenAddress === "string" ? res.tokenAddress : "";
      if (!tokenAddress) {
        setNotice("建立失敗：relayer 未回傳代幣地址");
        return;
      }
      setDraft((current) => ({ ...current, tokenAddress }));
      setNotice(
        res.alreadyExisted
          ? `此標的已建立過代幣：${tokenAddress}`
          : `RWA 代幣已建立：${tokenAddress}（已自動回填，關閉編輯器前請確認已儲存）`,
      );
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? `建立 RWA 代幣失敗：${error.message}` : "建立 RWA 代幣失敗");
    } finally {
      setCreatingRwaToken(false);
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
    // RWA Factory 上鏈參數為選填（供生產對照），但填了小數位數就必須是合法整數。
    const decimalsRaw = draft.tokenDecimals.trim();
    if (decimalsRaw !== "" && !/^(?:[0-9]|[12][0-9]|3[0-6])$/.test(decimalsRaw)) {
      setNotice("小數位數必須為 0–36 的整數（可留空，鏈上通常使用 18）");
      return;
    }
    const tokenAddressRaw = draft.tokenAddress.trim();
    if (tokenAddressRaw !== "" && !/^0x[0-9a-fA-F]{40}$/.test(tokenAddressRaw)) {
      setNotice("代幣合約地址格式須為 0x 開頭的 40 位十六進位（可留空，部署後再回填）");
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
          LANGUAGES.map(([code]) => [code, sourceContent]),
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
      // 儲存 RWA Factory 上鏈參數（獨立 RPC，不影響上方建立/更新的核心流程；
      // 失敗時只提示、不回滾已建立的標的，管理員可重新編輯補存）。
      const { error: factoryError } = await supabase.rpc("admin_set_placement_factory_params", {
        p_id: placementId,
        p_token_name: draft.tokenName.trim(),
        p_token_symbol: draft.tokenSymbol.trim().toUpperCase(),
        p_token_decimals: decimalsRaw === "" ? null : Number(decimalsRaw),
      });
      const { error: tokenAddressError } = await supabase.rpc("admin_set_placement_token_address", {
        p_id: placementId,
        p_token_address: tokenAddressRaw === "" ? null : tokenAddressRaw,
      });
      await refresh();
      window.dispatchEvent(new Event("platform-assets-updated"));
      const baseNotice = translationWarning
        ? `${isEditing ? "標的已更新" : "標的已建立"}，前後台已同步；翻譯服務暫時失敗，目前其他語言先顯示繁體中文`
        : isEditing
          ? "標的已自動翻譯並更新，前後台已同步"
          : "標的已自動翻譯並新增，前後台已同步";
      setNotice(
        factoryError || tokenAddressError
          ? `${baseNotice}（注意：RWA Factory 上鏈參數或代幣地址儲存失敗，請重新編輯此標的補存）`
          : baseNotice,
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
    // 先嘗試把該標的所有持有人鏈上的 RWA 份額強制收回 Safe 金庫（best-effort，
    // 需持有人曾對 ADMIN 授權過才能收回；無論成功與否都繼續往下走下架流程，
    // 因為使用者本金已由 admin_deactivate_placement 原路退回 JC）。
    let reclaimNote = "";
    try {
      const reclaimRes = await callRelayer("admin-rwa-reclaim", { placementId: target.id });
      const reclaimed = (reclaimRes as { reclaimed?: unknown[] })?.reclaimed?.length ?? 0;
      const failed = (reclaimRes as { failed?: unknown[] })?.failed?.length ?? 0;
      if (reclaimed || failed) reclaimNote = `；鏈上份額收回 ${reclaimed} 筆成功${failed ? `、${failed} 筆需人工處理` : ""}`;
    } catch {
      reclaimNote = "；鏈上份額收回未完成，請於需要時人工處理";
    }
    const { error } = await supabase.rpc("admin_deactivate_placement", {
      placement_id: target.id,
    });
    setDeactivating(false);
    if (error) {
      setNotice(`下架「${target.name}」失敗，請稍後再試`);
      return;
    }
    setDeactivateTarget(null);
    setNotice(`「${target.name}」已下架，前端已停止顯示與交易，本金已原路退回 JC${reclaimNote}`);
    if (featuredAssetId === target.id) setFeaturedAssetId("");
    await refresh();
    window.dispatchEvent(new Event("platform-assets-updated"));
  };
  return (
    <Panel
      title="私募標的物管理"
    >
      <section className="mb-5 rounded-2xl border border-amber-500/20 bg-slate-900 p-5">
        <h3 className="font-bold">JC 買入單價</h3>
        <p className="mt-1 text-xs text-slate-500">設定使用者以 USDT 買入 JC 時的價格；買入 1 JC 需支付多少 USDT。</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <input
              aria-label="JC 買入單價（USDT / JC）"
              type="number"
              min="0"
              step="0.000001"
              value={jcBuyPriceInput}
              onChange={(event) => setJcBuyPriceInput(event.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 pr-16 text-sm"
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-slate-500">USDT / JC</span>
          </div>
          <button type="button" disabled={savingJcBuyPrice} onClick={() => void saveJcBuyPrice()} className="rounded-xl bg-amber-400 px-5 py-3 text-sm font-bold text-slate-950 disabled:cursor-wait disabled:opacity-60">
            {savingJcBuyPrice ? "儲存中…" : "儲存買入單價"}
          </button>
        </div>
      </section>
      <section className="mb-5 rounded-2xl border border-amber-500/20 bg-slate-900 p-5">
        <h3 className="font-bold">JC 回收單價</h3>
        <p className="mt-1 text-xs text-slate-500">設定使用者向平台回收 JC 時的價格；回收 1 JC 可換回多少 USDT。</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <input
              aria-label="JC 回收單價（USDT / JC）"
              type="number"
              min="0"
              step="0.000001"
              value={jcRedeemPriceInput}
              onChange={(event) => setJcRedeemPriceInput(event.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 pr-16 text-sm"
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-slate-500">USDT / JC</span>
          </div>
          <button type="button" disabled={savingJcRedeemPrice} onClick={() => void saveJcRedeemPrice()} className="rounded-xl bg-amber-400 px-5 py-3 text-sm font-bold text-slate-950 disabled:cursor-wait disabled:opacity-60">
            {savingJcRedeemPrice ? "儲存中…" : "儲存回收單價"}
          </button>
        </div>
      </section>
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
                ["total", "總供給量"],
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
          <div className="rounded-2xl border border-sky-500/30 bg-sky-950/20 p-4">
            <p className="text-sm font-semibold text-sky-200">RWA Factory 上鏈參數</p>
            <p className="mt-1 text-xs text-slate-400">每個 RWA 標的需要一顆專屬的鏈上份額代幣，一級認購與二級成交才能在鏈上結算。你不需要自己去別處部署合約——填好代幣符號並儲存後，點下方「一鍵在 RWA Factory 建立此標的代幣」即可由平台自動部署並回填地址。鏈上發行量對照上方「總供給量」，估值對照「總資產估值（USDT）」。</p>
            {editingId && (
              <p
                className={`mt-3 rounded-lg border px-3 py-2 text-xs font-semibold ${
                  draft.tokenAddress
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-300"
                }`}
              >
                {draft.tokenAddress
                  ? `已部署鏈上代幣，可正常認購：${draft.tokenAddress}`
                  : "尚未部署鏈上代幣——此標的目前無法認購，請先建立代幣並把份額從 Safe 金庫轉入 ADMIN 熱錢包。"}
              </p>
            )}
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="text-xs text-slate-400">
                代幣名稱（Token Name，英文）
                <input
                  value={draft.tokenName}
                  maxLength={64}
                  placeholder="例如：RWMT Property 001"
                  onChange={(event) => setDraft((current) => ({ ...current, tokenName: event.target.value }))}
                  className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm"
                />
              </label>
              <label className="text-xs text-slate-400">
                代幣符號（Token Symbol）
                <input
                  value={draft.tokenSymbol}
                  maxLength={16}
                  placeholder="例如：RWMT001"
                  onChange={(event) => setDraft((current) => ({ ...current, tokenSymbol: event.target.value.toUpperCase() }))}
                  className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm uppercase"
                />
              </label>
              <label className="text-xs text-slate-400">
                小數位數（Decimals）
                <input
                  type="text"
                  inputMode="numeric"
                  value={draft.tokenDecimals}
                  placeholder="留空預設 18"
                  onChange={(event) => setDraft((current) => ({ ...current, tokenDecimals: event.target.value.replace(/[^0-9]/g, "") }))}
                  className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm"
                />
                <span className="mt-2 block text-[11px] text-slate-500">鏈上通常使用 18（與 JC／AE 一致）。</span>
              </label>
              <label className="text-xs text-slate-400 sm:col-span-2 lg:col-span-3">
                已部署代幣合約地址（Token Address）
                <input
                  value={draft.tokenAddress}
                  maxLength={42}
                  placeholder="0x…（在 RWA Factory 部署此標的代幣後回填，可留空）"
                  onChange={(event) => setDraft((current) => ({ ...current, tokenAddress: event.target.value.trim() }))}
                  className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 font-mono text-sm"
                />
                <span className="mt-2 block text-[11px] text-slate-500">每個標的一顆專屬 RWA 代幣。部署完成後把合約地址填入這裡，供結算與前台對照使用。</span>
              </label>
              {!editingId && (
                <div className="sm:col-span-2 lg:col-span-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[11px] leading-relaxed text-amber-200">
                  「一鍵在 RWA Factory 建立此標的代幣」按鈕只會在「編輯已儲存的標的」時出現。請填妥上方資料（含代幣符號）並按下方「儲存」完成建立，接著在標的列表點該標的的「編輯」重新開啟，就會在這一區看到一鍵建立代幣的按鈕。
                </div>
              )}
              {editingId && !draft.tokenAddress && (
                <div className="sm:col-span-2 lg:col-span-3">
                  <button
                    type="button"
                    disabled={creatingRwaToken}
                    onClick={() => void createRwaToken()}
                    className="rounded-xl border border-sky-400 px-4 py-3 text-sm font-bold text-sky-200 disabled:cursor-wait disabled:opacity-60"
                  >
                    {creatingRwaToken ? "建立中（鏈上交易）…" : "一鍵在 RWA Factory 建立此標的代幣"}
                  </button>
                  <p className="mt-2 text-[11px] text-slate-500">
                    請先填寫並儲存「代幣符號」（名稱可留空，會用標的中文名稱代替），儲存後再點此按鈕。建立時會把「總供給量」全額一次鑄給 Safe 金庫；建立後仍需請 Safe 擁有人手動把份額轉到 ADMIN 熱錢包，一級認購/二級成交才能正常結算。
                  </p>
                </div>
              )}
            </div>
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
                <Metric label={item.is_ae_token ? "單價" : "每份 JC"} value={formatJC(item.price)} />
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

function AeTokenModule() {
  const { placements, jcLedger, refresh } = useAdminData();
  const [dailyNotice, setDailyNotice] = useState("");
  const [dailySaving, setDailySaving] = useState(false);
  const [bonusNotice, setBonusNotice] = useState("");
  const [bonusSaving, setBonusSaving] = useState(false);
  const [endingBonusId, setEndingBonusId] = useState<string | null>(null);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetNotice, setResetNotice] = useState("");

  const dailyPlacement = placements.find((item) => item.is_ae_token && item.ae_token_kind === "daily");
  const bonusRounds = placements.filter((item) => item.is_ae_token && item.ae_token_kind === "bonus");
  const activeBonusRound = bonusRounds.find((item) => item.is_active && item.available > 0 && !item.release_frozen_at);
  const clearingBonusRounds = bonusRounds.filter((item) => item.release_frozen_at && item.available > 0);
  const pastBonusRounds = bonusRounds
    .filter((item) => item !== activeBonusRound && !clearingBonusRounds.includes(item))
    .sort((a, b) => b.id.localeCompare(a.id));

  // Traffic-light style issuance status: bonus running always takes priority
  // (it pauses daily), then daily-running-while-clearing-leftover-bonus-stock,
  // then plain daily, then a fallback for when neither track is active.
  const issuanceStatus = activeBonusRound
    ? { label: "獎勵發行中（平常日暫停）", dot: "bg-amber-400" }
    : clearingBonusRounds.length > 0 && dailyPlacement?.is_active
      ? { label: "平常日發行中（優先清空獎勵庫存）", dot: "bg-rose-400" }
      : dailyPlacement?.is_active
        ? { label: "平常日發行中", dot: "bg-emerald-400" }
        : { label: "尚未啟用", dot: "bg-slate-500" };

  // Platform fee ledger (secondary-market fees) is a separate table from
  // asset_ledger, so it needs its own fetch — same RPC ReportsModule uses.
  const [platformFees, setPlatformFees] = useState<PlatformFee[]>([]);
  const refreshPlatformFees = useCallback(async () => {
    const { data } = await supabase.rpc("admin_list_platform_fees");
    setPlatformFees((previous) => keepStable(previous, (data ?? []) as PlatformFee[]));
  }, []);
  useVisiblePolling(refreshPlatformFees, 2_000, true);

  const [statsStart, setStatsStart] = useState("");
  const [statsEnd, setStatsEnd] = useState("");
  const statsRangeInvalid = Boolean(statsStart && statsEnd && statsStart > statsEnd);
  const applyStatsPreset = (preset: "today" | "week") => {
    const today = new Date();
    const start = new Date(today);
    if (preset === "week") {
      const day = today.getDay() || 7;
      start.setDate(today.getDate() - day + 1);
    }
    const formatDate = (date: Date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    };
    setStatsStart(formatDate(start));
    setStatsEnd(formatDate(today));
  };

  const dailyIds = new Set(placements.filter((item) => item.ae_token_kind === "daily").map((item) => item.id));
  const bonusIds = new Set(placements.filter((item) => item.ae_token_kind === "bonus").map((item) => item.id));
  const aeTokenIds = new Set([...dailyIds, ...bonusIds]);
  // 2026-09-12 導入 JC 幣後 private_purchase 改寫進 jc_ledger，asset_ledger
  // 已不再收到這類紀錄（只剩 USDT 側 vault_buy_jc 鏡射列）——此區塊必須讀
  // jcLedger，否則認購統計會永遠是 0。metadata.gross 是扣 Gas 前的認購本金
  // （JC），用它才不會把 Gas 誤算進營收。
  const grossOf = (row: Ledger) => {
    const metaGross = row.metadata?.gross;
    return typeof metaGross === "number" ? metaGross : Math.abs(Number(row.amount));
  };
  const purchasesInRange = jcLedger.filter(
    (row) =>
      row.entry_type === "private_purchase" &&
      row.asset_id &&
      aeTokenIds.has(row.asset_id) &&
      isTransactionHistoryVisible(row.created_at) &&
      !statsRangeInvalid &&
      isWithinDateRange(row.created_at, statsStart, statsEnd),
  );
  const dailyPurchases = purchasesInRange.filter((row) => dailyIds.has(row.asset_id as string));
  const bonusPurchases = purchasesInRange.filter((row) => bonusIds.has(row.asset_id as string));
  const dailyPurchaseCount = dailyPurchases.reduce((sum, row) => sum + Number(row.quantity ?? 0), 0);
  const bonusPurchaseCount = bonusPurchases.reduce((sum, row) => sum + Number(row.quantity ?? 0), 0);
  const dailyRevenue = dailyPurchases.reduce((sum, row) => sum + grossOf(row), 0);
  const bonusRevenue = bonusPurchases.reduce((sum, row) => sum + grossOf(row), 0);
  const totalRevenue = dailyRevenue + bonusRevenue;
  // Weighted average price actually paid within the range, since price can
  // be edited on the daily row or differ across bonus rounds over time.
  const dailyAvgPrice = dailyPurchaseCount > 0 ? dailyRevenue / dailyPurchaseCount : null;
  const bonusAvgPrice = bonusPurchaseCount > 0 ? bonusRevenue / bonusPurchaseCount : null;
  const secondaryFeeRevenue = platformFees
    .filter(
      (row) =>
        row.source_type === "p2p_fee" &&
        row.asset_id &&
        aeTokenIds.has(row.asset_id) &&
        isTransactionHistoryVisible(row.created_at) &&
        !statsRangeInvalid &&
        isWithinDateRange(row.created_at, statsStart, statsEnd),
    )
    .reduce((sum, row) => sum + Number(row.amount), 0);

  const [dailyForm, setDailyForm] = useState({
    name: "AE 代幣",
    price: "",
    intervalSeconds: "",
    amountPerInterval: "",
    information: "",
  });
  useEffect(() => {
    if (!dailyPlacement) return;
    setDailyForm({
      name: dailyPlacement.name,
      price: String(dailyPlacement.price),
      intervalSeconds: String(dailyPlacement.release_interval_seconds ?? ""),
      amountPerInterval: String(dailyPlacement.release_amount_per_interval ?? ""),
      information: dailyPlacement.information ?? "",
    });
    // Only re-sync when the daily row itself changes; user edits shouldn't be clobbered by unrelated refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailyPlacement?.id, dailyPlacement?.price, dailyPlacement?.release_interval_seconds, dailyPlacement?.release_amount_per_interval]);

  const saveDaily = async () => {
    const price = Number(dailyForm.price);
    const intervalSeconds = Number(dailyForm.intervalSeconds);
    const amountPerInterval = Number(dailyForm.amountPerInterval);
    if (!dailyForm.name.trim() || price <= 0 || intervalSeconds <= 0 || amountPerInterval <= 0) {
      setDailyNotice("請完整填寫名稱、單價、釋出間隔秒數與每次釋出量（皆須大於 0）");
      return;
    }
    setDailySaving(true);
    const { error } = await supabase.rpc("admin_save_ae_token_daily", {
      p_price: price,
      p_release_interval_seconds: intervalSeconds,
      p_release_amount_per_interval: amountPerInterval,
      p_name: dailyForm.name.trim(),
      p_information: dailyForm.information.trim(),
    });
    setDailySaving(false);
    if (error) {
      const message = error.message.toLowerCase();
      setDailyNotice(
        error.code === "42501" || message.includes("not authorized")
          ? "目前帳號沒有管理員權限，請重新登入後再試"
          : `儲存失敗：${error.message}`,
      );
      return;
    }
    setDailyNotice(dailyPlacement ? "平常日設定已更新" : "平常日發行已啟用，前台已同步");
    await refresh();
    window.dispatchEvent(new Event("platform-assets-updated"));
  };

  const [bonusForm, setBonusForm] = useState({
    name: "AE 代幣獎勵",
    price: "",
    total: "",
    intervalSeconds: "",
    amountPerInterval: "",
    information: "",
    endsAt: "",
  });
  const startBonusRound = async () => {
    const price = Number(bonusForm.price);
    const total = Number(bonusForm.total);
    const intervalSeconds = Number(bonusForm.intervalSeconds);
    const amountPerInterval = Number(bonusForm.amountPerInterval);
    if (!bonusForm.name.trim() || price <= 0 || total <= 0 || intervalSeconds <= 0 || amountPerInterval <= 0) {
      setBonusNotice("請完整填寫名稱、單價、本次總發行量、釋出間隔天數與每次釋出量（皆須大於 0）");
      return;
    }
    setBonusSaving(true);
    const { error } = await supabase.rpc("admin_start_ae_token_bonus_round", {
      p_price: price,
      p_total_supply: total,
      p_release_interval_seconds: intervalSeconds,
      p_release_amount_per_interval: amountPerInterval,
      p_name: bonusForm.name.trim(),
      p_information: bonusForm.information.trim(),
      p_ends_at: bonusForm.endsAt ? new Date(bonusForm.endsAt).toISOString() : null,
    });
    setBonusSaving(false);
    if (error) {
      const message = error.message.toLowerCase();
      setBonusNotice(
        message.includes("尚有未售完")
          ? error.message
          : error.code === "42501" || message.includes("not authorized")
            ? "目前帳號沒有管理員權限，請重新登入後再試"
            : `啟動失敗：${error.message}`,
      );
      return;
    }
    setBonusNotice("獎勵機制已啟動，平常日已自動暫停，前台已同步");
    setBonusForm({ name: "AE 代幣獎勵", price: "", total: "", intervalSeconds: "", amountPerInterval: "", information: "", endsAt: "" });
    await refresh();
    window.dispatchEvent(new Event("platform-assets-updated"));
  };

  const endBonusRound = async (assetId: string) => {
    setEndingBonusId(assetId);
    setBonusNotice("");
    const { error } = await supabase.rpc("admin_end_ae_token_bonus_round", { p_asset_id: assetId });
    setEndingBonusId(null);
    if (error) {
      setBonusNotice(`結束失敗：${error.message}`);
      return;
    }
    setBonusNotice("獎勵機制已結束，平常日已自動恢復；剩餘庫存已全數解鎖，可依獎勵價買到清空為止");
    await refresh();
    window.dispatchEvent(new Event("platform-assets-updated"));
  };

  // Development-only reset: force-delists AE token from subscription and
  // the secondary market (daily round + every bonus round, past or
  // present), cancels every open AE token order, and deletes every user's
  // AE token holdings outright. Irreversible — the daily form's "更新平常日設定"
  // button revives the daily round afterwards if issuance needs to restart.
  const resetAeToken = async () => {
    setResetting(true);
    setResetNotice("");
    // 先把所有使用者鏈上真實持有的 AE 強制收回 Safe 金庫（AEToken 合約的
    // owner-only adminReclaim，不受 allowance 限制一定能收回），再清空站內
    // holdings／退款，避免歸零後使用者錢包裡仍留有鏈上 AE 餘額。
    let reclaimNote = "";
    try {
      const reclaimRes = await callRelayer("admin-ae-reclaim");
      const reclaimed = (reclaimRes as { reclaimed?: unknown[] })?.reclaimed?.length ?? 0;
      const failed = (reclaimRes as { failed?: unknown[] })?.failed?.length ?? 0;
      if (reclaimed || failed) reclaimNote = `、鏈上收回 ${reclaimed} 筆成功${failed ? `、${failed} 筆失敗` : ""}`;
    } catch (e) {
      reclaimNote = `、鏈上收回未完成（${e instanceof Error ? e.message : "請稍後人工確認"}）`;
    }
    const { data, error } = await supabase.rpc("admin_reset_ae_token");
    setResetting(false);
    if (error) {
      setResetNotice(`歸零失敗：${error.message}`);
      return;
    }
    const result = data as { cancelled_orders: number; wiped_holdings: number; delisted_placements: number } | null;
    setResetConfirmOpen(false);
    setResetNotice(
      `AE 代幣已歸零：取消 ${result?.cancelled_orders ?? 0} 筆掛單、清空 ${result?.wiped_holdings ?? 0} 筆用戶持倉、下架 ${result?.delisted_placements ?? 0} 個輪次${reclaimNote}。`,
    );
    await refresh();
    window.dispatchEvent(new Event("platform-assets-updated"));
  };

  return (
    <Panel title="AE 代幣管理">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/20 bg-slate-900 p-4">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className={`size-2.5 rounded-full ${issuanceStatus.dot}`} />
          <span className="text-sm font-bold text-slate-200">發行狀態：{issuanceStatus.label}</span>
        </div>
        <button
          type="button"
          onClick={() => setResetConfirmOpen(true)}
          className="rounded-xl border border-red-500/70 bg-red-950/30 px-4 py-2 text-xs font-bold text-red-200 transition hover:border-red-400 hover:bg-red-950/60"
        >
          AE 代幣歸零（開發用）
        </button>
      </div>
      {resetNotice && <p className="mb-5 text-xs text-slate-300">{resetNotice}</p>}

      {resetConfirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !resetting) setResetConfirmOpen(false);
          }}
        >
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="reset-ae-token-title"
            aria-describedby="reset-ae-token-description"
            className="w-full max-w-md rounded-2xl border border-red-500/50 bg-slate-900 p-6 shadow-2xl"
          >
            <p className="text-xs font-bold uppercase tracking-widest text-red-300">高風險操作 · 開發用</p>
            <h3 id="reset-ae-token-title" className="mt-3 text-xl font-bold text-slate-100">確定要將 AE 代幣歸零嗎？</h3>
            <p id="reset-ae-token-description" className="mt-3 text-sm leading-relaxed text-slate-300">
              此操作會立即：取消所有用戶在 AE 代幣（平常日與所有獎勵輪次）的二級市場掛單；<b className="text-red-300">清空所有用戶手上的 AE 代幣持倉</b>；並強制下架平常日與所有獎勵輪次，使其從認購頁與二級市場完全消失。此操作無法復原，且不影響其他標的物或用戶的其他資產。下架後可到下方「平常日設定」重新儲存以再次啟用。
            </p>
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setResetConfirmOpen(false)}
                disabled={resetting}
                autoFocus
                className="rounded-xl border border-slate-700 px-5 py-3 font-bold text-slate-300 disabled:cursor-wait disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void resetAeToken()}
                disabled={resetting}
                className="rounded-xl bg-red-600 px-5 py-3 font-bold text-white transition hover:bg-red-500 disabled:cursor-wait disabled:opacity-60"
              >
                {resetting ? "歸零中…" : "確認歸零"}
              </button>
            </div>
          </section>
        </div>
      )}

      <section className="mb-5 rounded-2xl border border-amber-500/20 bg-slate-900 p-5">
        <h3 className="font-bold">釋出規則說明</h3>
        <p className="mt-1 text-xs text-slate-500">
          AE 代幣分成「平常日」與「獎勵機制」兩條發行線：平常日無總發行量上限，只要開著就依釋出間隔持續釋出；獎勵機制維持「一輪一輪」，每次啟動要設定本次總發行量，售完或被手動結束前不可開啟下一輪。兩者互斥——啟動獎勵機制會自動暫停平常日，獎勵機制結束（售完或手動結束）後平常日會自動恢復；若手動結束時獎勵機制還有已釋出但未售出的庫存，會凍結釋出進度（不再新增），但該庫存仍會繼續開放依獎勵價買到清空為止，與已恢復的平常日同時並存。AE 代幣新一輪／平常日一開始就同時開放「認購」與「二級市場」——用戶可一邊依釋出額度認購，一邊在二級市場掛單買賣（沒有持有份額則無法掛賣單）。認購走 <code className="text-slate-400">execute_private_purchase</code>、二級市場撮合走 <code className="text-slate-400">fill_p2p_order</code>，皆與一般私募標的共用完全相同的函式與費率設定（<code className="text-slate-400">private.post_referral_commissions</code>），僅多一道「已釋出量」上限檢查，因此代理分潤（私募 1%／總代理 2%／總代理直屬 3%）與二級市場分潤（7‱／13‱／20‱）計算方式與其他標的完全一致，不會走到任何獨立邏輯。唯一的差異：AE 代幣的二級市場單價由買賣雙方掛單時自行輸入，不是平台固定參考價，因此後台「二級市場標的物」的統一改價功能不適用於 AE 代幣。
        </p>
      </section>

      <section className="mb-5 rounded-2xl border border-amber-500/20 bg-slate-900 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-bold">平常日設定</h3>
          {dailyPlacement && (
            <span className={`rounded-full px-2 py-1 text-xs font-bold ${dailyPlacement.is_active ? "bg-amber-400 text-slate-950" : "bg-slate-800 text-slate-400"}`}>
              {dailyPlacement.is_active ? "運作中" : "已暫停（獎勵機制進行中）"}
            </span>
          )}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-slate-400">
            名稱
            <input value={dailyForm.name} onChange={(event) => setDailyForm((current) => ({ ...current, name: event.target.value }))} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
          </label>
          <label className="text-xs text-slate-400">
            單價（USDT）
            <input value={dailyForm.price} onChange={(event) => setDailyForm((current) => ({ ...current, price: event.target.value }))} inputMode="decimal" className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
          </label>
          <label className="text-xs text-slate-400">
            釋出間隔（秒）
            <input value={dailyForm.intervalSeconds} onChange={(event) => setDailyForm((current) => ({ ...current, intervalSeconds: event.target.value }))} inputMode="numeric" className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
          </label>
          <label className="text-xs text-slate-400">
            每次釋出量
            <input value={dailyForm.amountPerInterval} onChange={(event) => setDailyForm((current) => ({ ...current, amountPerInterval: event.target.value }))} inputMode="numeric" className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
          </label>
          <label className="text-xs text-slate-400 sm:col-span-2">
            專案簡介（選填）
            <textarea value={dailyForm.information} onChange={(event) => setDailyForm((current) => ({ ...current, information: event.target.value }))} rows={2} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
          </label>
        </div>
        {dailyNotice && <p className="mt-3 text-xs text-slate-300">{dailyNotice}</p>}
        <button
          type="button"
          disabled={dailySaving}
          onClick={() => void saveDaily()}
          className="mt-4 rounded-xl bg-amber-400 px-6 py-3 text-sm font-bold text-slate-950 shadow-lg shadow-amber-950/30 transition hover:bg-amber-300 disabled:cursor-wait disabled:opacity-60"
        >
          {dailySaving ? "儲存中…" : dailyPlacement ? "更新平常日設定" : "啟用平常日發行"}
        </button>
      </section>

      <section className="mb-5 rounded-2xl border border-amber-500/20 bg-slate-900 p-5">
        <h3 className="font-bold">獎勵機制</h3>

        {(activeBonusRound || clearingBonusRounds.length > 0) && (
          <div className="mt-4 flex flex-col gap-2">
            {activeBonusRound && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-slate-200">{activeBonusRound.name}</span>
                  <span className="text-slate-500">{activeBonusRound.id}</span>
                  <span className="rounded-full bg-amber-400 px-2 py-1 font-bold text-slate-950">進行中</span>
                </div>
                <div className="flex flex-wrap items-center gap-4 text-slate-400">
                  <span>單價 <b className="text-slate-200">{activeBonusRound.price}</b></span>
                  <span>每次釋出 <b className="text-slate-200">{activeBonusRound.release_amount_per_interval ?? "—"}</b></span>
                  <span>間隔 <b className="text-slate-200">{activeBonusRound.release_interval_seconds ?? "—"}s</b></span>
                  <span>已售出／總量 <b className="text-slate-200">{(activeBonusRound.total_supply - activeBonusRound.available).toLocaleString()} / {activeBonusRound.total_supply.toLocaleString()}</b></span>
                  <button
                    type="button"
                    disabled={endingBonusId === activeBonusRound.id}
                    onClick={() => void endBonusRound(activeBonusRound.id)}
                    className="rounded-full border border-red-500/40 px-3 py-1 font-bold text-red-300 transition hover:bg-red-500/10 disabled:cursor-wait disabled:opacity-60"
                  >
                    {endingBonusId === activeBonusRound.id ? "結束中…" : "提前結束獎勵機制"}
                  </button>
                </div>
              </div>
            )}
            {clearingBonusRounds.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-slate-200">{item.name}</span>
                  <span className="text-slate-500">{item.id}</span>
                  <span className="rounded-full bg-slate-800 px-2 py-1 font-bold text-slate-400">已結束·清倉中</span>
                </div>
                <div className="flex flex-wrap items-center gap-4 text-slate-400">
                  <span>單價 <b className="text-slate-200">{item.price}</b></span>
                  <span>剩餘可售出 <b className="text-slate-200">{item.available.toLocaleString()}</b></span>
                </div>
              </div>
            ))}
          </div>
        )}

        {!activeBonusRound && (
          <div className="mt-4">
            <p className="text-xs text-slate-500">目前沒有進行中的獎勵機制，可啟動新一輪。</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-slate-400">
                名稱
                <input value={bonusForm.name} onChange={(event) => setBonusForm((current) => ({ ...current, name: event.target.value }))} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
              </label>
              <label className="text-xs text-slate-400">
                單價（USDT）
                <input value={bonusForm.price} onChange={(event) => setBonusForm((current) => ({ ...current, price: event.target.value }))} inputMode="decimal" className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
              </label>
              <label className="text-xs text-slate-400">
                本次獎勵發行總量
                <input value={bonusForm.total} onChange={(event) => setBonusForm((current) => ({ ...current, total: event.target.value }))} inputMode="numeric" className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
              </label>
              <label className="text-xs text-slate-400">
                釋出間隔（秒）
                <input value={bonusForm.intervalSeconds} onChange={(event) => setBonusForm((current) => ({ ...current, intervalSeconds: event.target.value }))} inputMode="numeric" className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
              </label>
              <label className="text-xs text-slate-400">
                每次釋出量
                <input value={bonusForm.amountPerInterval} onChange={(event) => setBonusForm((current) => ({ ...current, amountPerInterval: event.target.value }))} inputMode="numeric" className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
              </label>
              <label className="text-xs text-slate-400">
                結束時間（選填，留空代表不設限）
                <input type="datetime-local" value={bonusForm.endsAt} onChange={(event) => setBonusForm((current) => ({ ...current, endsAt: event.target.value }))} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
              </label>
              <label className="text-xs text-slate-400 sm:col-span-2">
                專案簡介（選填）
                <textarea value={bonusForm.information} onChange={(event) => setBonusForm((current) => ({ ...current, information: event.target.value }))} rows={2} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
              </label>
            </div>
            <button
              type="button"
              disabled={bonusSaving}
              onClick={() => void startBonusRound()}
              className="mt-4 rounded-xl bg-amber-400 px-6 py-3 text-sm font-bold text-slate-950 shadow-lg shadow-amber-950/30 transition hover:bg-amber-300 disabled:cursor-wait disabled:opacity-60"
            >
              {bonusSaving ? "啟動中…" : "啟動新一輪獎勵"}
            </button>
          </div>
        )}
        {bonusNotice && <p className="mt-3 text-xs text-slate-300">{bonusNotice}</p>}

        {pastBonusRounds.length > 0 && (
          <div className="mt-5 border-t border-slate-800 pt-4">
            <h4 className="text-xs font-bold text-slate-400">歷史輪次</h4>
            <div className="mt-2 flex flex-col gap-2">
              {pastBonusRounds.map((item) => (
                <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-200">{item.name}</span>
                    <span className="text-slate-500">{item.id}</span>
                  </div>
                  <div className="flex items-center gap-4 text-slate-400">
                    <span>單價 <b className="text-slate-200">{item.price}</b></span>
                    <span>已售出／總量 <b className="text-slate-200">{(item.total_supply - item.available).toLocaleString()} / {item.total_supply.toLocaleString()}</b></span>
                    <span className="rounded-full bg-slate-800 px-2 py-1 font-bold text-slate-400">已結束</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-amber-500/20 bg-slate-900 p-5">
        <h3 className="font-bold">營運數據統計</h3>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-400">
            快速區間
            <select
              aria-label="快速選擇日期區間"
              defaultValue=""
              onChange={(event) => {
                const value = event.target.value as "today" | "week" | "";
                if (value) applyStatsPreset(value);
                event.target.value = "";
              }}
              className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-200"
            >
              <option value="" disabled>
                選擇區間
              </option>
              <option value="today">本日</option>
              <option value="week">本週</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-400">
            開始日期
            <input
              type="date"
              value={statsStart}
              onChange={(event) => setStatsStart(event.target.value)}
              className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-200"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-slate-400">
            結束日期
            <input
              type="date"
              value={statsEnd}
              onChange={(event) => setStatsEnd(event.target.value)}
              className="min-h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-200"
            />
          </label>
          <button
            type="button"
            onClick={() => {
              setStatsStart("");
              setStatsEnd("");
            }}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-700 px-3 text-xs font-semibold text-slate-300 hover:text-amber-200"
          >
            <RotateCcw className="size-4" />
            清除日期
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          統計僅包含 {TRANSACTION_HISTORY_START_LABEL} 起的新資料；重置前歷史紀錄保留但不計入。
        </p>
        {statsRangeInvalid && (
          <p role="alert" className="mt-2 text-xs text-rose-300">
            開始日期不可晚於結束日期。
          </p>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
            <p className="text-xs text-slate-500">已認購總顆數</p>
            <div className="mt-2 flex flex-col gap-1 text-sm text-slate-400">
              <span>
                平常日 <b className="text-slate-200">{dailyPurchaseCount.toLocaleString()}</b>
              </span>
              <span>
                獎勵機制 <b className="text-slate-200">{bonusPurchaseCount.toLocaleString()}</b>
              </span>
            </div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
            <p className="text-xs text-slate-500">AE 代幣總收入（認購總金額）</p>
            <b className="mt-2 block text-lg text-amber-300">{formatJC(totalRevenue)}</b>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
            <p className="text-xs text-slate-500">二級市場手續費收入</p>
            <b className="mt-2 block text-lg text-amber-300">{formatJC(secondaryFeeRevenue)}</b>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
            <p className="text-xs text-slate-500">平常日單價（區間內成交均價）</p>
            <b className="mt-2 block text-sm text-slate-200">
              {dailyAvgPrice !== null ? formatJC(dailyAvgPrice) : "區間內無成交"}
            </b>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
            <p className="text-xs text-slate-500">獎勵機制單價（區間內成交均價）</p>
            <b className="mt-2 block text-sm text-slate-200">
              {bonusAvgPrice !== null ? formatJC(bonusAvgPrice) : "區間內無成交"}
            </b>
          </div>
        </div>
      </section>
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
  // AE tokens let each user set their own order price (see AeTokenModule),
  // so they don't belong in this uniform admin-repricing list.
  const secondaryPlacements = placements.filter(
    (item) => item.market_started_at && !item.is_delisted && !item.is_ae_token,
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
        `確定將「${item.name}」價格改為 ${money(price)}？新價格立即生效並暫停新掛單一分鐘；既有掛單（含部分成交）會依新價格重新計價（份額不變），因此變為可撮合的掛單將立即自動成交。`,
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
    let reclaimNote = "";
    try {
      const reclaimRes = await callRelayer("admin-rwa-reclaim", { placementId: target.id });
      const reclaimed = (reclaimRes as { reclaimed?: unknown[] })?.reclaimed?.length ?? 0;
      const failed = (reclaimRes as { failed?: unknown[] })?.failed?.length ?? 0;
      if (reclaimed || failed) reclaimNote = `；鏈上份額收回 ${reclaimed} 筆成功${failed ? `、${failed} 筆需人工處理` : ""}`;
    } catch {
      reclaimNote = "；鏈上份額收回未完成，請於需要時人工處理";
    }
    const { error } = await supabase.rpc("admin_deactivate_placement", {
      placement_id: target.id,
    });
    setDeactivating(false);
    if (error) {
      setNotice(`下架「${target.name}」失敗，請稍後再試`);
      return;
    }
    setDeactivateTarget(null);
    setNotice(`「${target.name}」已下架，前端已停止顯示與交易，本金已原路退回 JC${reclaimNote}`);
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
  const { profiles, ledger, commissions, commissionLoadError } = useAdminData();
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
      isTransactionHistoryVisible(log.created_at) &&
      isWithinDateRange(log.created_at, reportStartDate, reportEndDate),
  );
  const isPrivateCommission = (log: Commission) =>
    log.transaction_type === "private" ||
    log.transaction_type.toLowerCase().includes("private");
  // 彙總一律以 AE 呈現，取凍結 AE 快照（含 AE 認購亦以其 AE 快照計入）。
  const reportTotals = reportCommissions.reduce(
    (totals, log) => {
      const value = commissionAeValue(log);
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
            logTransactionCell(log),
            `${Number(log.commission_rate) * 100}%`,
            logCommissionCell(log),
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
          formatJC(reportTotals.privateAmount),
          "",
        ],
        [
          "合計",
          "",
          "",
          "二級市場",
          "",
          "",
          formatJC(reportTotals.secondaryAmount),
          "",
        ],
        [
          "總計",
          "",
          "",
          "全部",
          "",
          "",
          formatJC(reportTotals.totalAmount),
          "",
        ],
      ],
    );
  };
  const renderAgent = (agent: Profile, level: "master" | "agent") => {
    const logs = reportCommissions.filter((log) => log.agent_id === agent.id);
    const total = logs.reduce((sum, log) => sum + commissionAeValue(log), 0);
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
              <b className="text-sm text-amber-200">{formatJC(total)}</b>
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
      const userLogs = logs.filter(
        (log) => log.buyer_id === user.id && isTransactionHistoryVisible(log.created_at),
      );
      const trades = ledger.filter(
        (entry) =>
          entry.user_id === user.id &&
          isTransactionHistoryVisible(entry.created_at) &&
          [

                    "private_purchase",
                    "secondary_buy",
                    "secondary_sell",
                    "p2p_buy",
                    "p2p_sell",
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
                                : entry.entry_type === "secondary_buy" ||
                                    entry.entry_type === "p2p_buy"
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
                            <Td>{logTransactionCell(log)}</Td>
                            <Td>{Number(log.commission_rate) * 100}%</Td>
                            <Td>
                              <b className="text-amber-200">
                                {logCommissionCell(log)}
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
      {commissionLoadError && (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200"
        >
          {commissionLoadError}
        </p>
      )}
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
  const { profiles, ledger, jcLedger, audits, placements, commissions } = useAdminData();
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
  const [showAllTreasury, setShowAllTreasury] = useState(false);
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
    (row.entry_type === "sandbox_deposit"
      ? "測試 USDT"
      : row.entry_type === "vault_buy_jc" || row.entry_type === "vault_redeem_jc"
        ? "JC 金庫兌換"
        : row.entry_type === "p2p_gas"
          ? "Gas 費"
          : "代理分潤");
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
  // 金庫入帳稽核：改成「每個用戶存入 Safe 金庫多少 USDT、多少 JC」的彙總。
  //  - 存入 USDT：金庫買 JC 時使用者真的把測試 USDT 轉進 Safe（jc_ledger.vault_buy，
  //    金額取 metadata.usdt）。
  //  - 存入 JC：使用者花在認購的本金（jc_ledger.private_purchase）＋ P2P 平台費
  //    （platform_fee_ledger.p2p_fee），皆為流向平台/金庫的 JC。
  type TreasuryUser = {
    key: string;
    email: string;
    usdtIn: number;
    jcIn: number;
    lastAt: string;
  };
  const treasuryMap = new Map<string, TreasuryUser>();
  const bumpTreasury = (
    key: string,
    field: "usdtIn" | "jcIn",
    value: number,
    at: string,
  ) => {
    if (invalidRange || !isWithinDateRange(at, startDate, endDate)) return;
    const current =
      treasuryMap.get(key) ??
      ({ key, email: key, usdtIn: 0, jcIn: 0, lastAt: at } as TreasuryUser);
    current[field] += value;
    if (at > current.lastAt) current.lastAt = at;
    treasuryMap.set(key, current);
  };
  jcLedger
    .filter((row) => row.entry_type === "vault_buy")
    .forEach((row) =>
      bumpTreasury(
        email(row.user_id),
        "usdtIn",
        Number(row.metadata?.usdt ?? row.amount),
        row.created_at,
      ),
    );
  jcLedger
    .filter((row) => row.entry_type === "private_purchase")
    .forEach((row) =>
      bumpTreasury(
        email(row.user_id),
        "jcIn",
        Math.abs(Number(row.amount)),
        row.created_at,
      ),
    );
  treasury
    .filter((row) => row.source_type === "p2p_fee")
    .forEach((row) =>
      bumpTreasury(row.payer_email, "jcIn", Number(row.amount), row.created_at),
    );
  const treasuryUsers = Array.from(treasuryMap.values())
    .filter((user) => user.usdtIn > 0 || user.jcIn > 0)
    .sort((a, b) => b.usdtIn + b.jcIn - (a.usdtIn + a.jcIn));
  const visibleTreasury = showAllTreasury
    ? treasuryUsers
    : treasuryUsers.slice(0, 10);
  const treasuryUsdtTotal = treasuryUsers.reduce(
    (sum, user) => sum + user.usdtIn,
    0,
  );
  const treasuryJcTotal = treasuryUsers.reduce(
    (sum, user) => sum + user.jcIn,
    0,
  );
  // Safe 金流流水（交易紀錄）：改為「什麼時候、誰、在網站上做了會動到 Safe 金流的
  // 事」的時間軸，涵蓋使用者要求的三類：
  //  1) JC 兌換 USDT（雙向）：金庫買 JC（USDT 進金庫、JC 由金庫釋出）＋金庫贖回
  //     （JC 收回金庫、USDT 由金庫撥出）＋贖回退回。
  //  2) 二級市場：成交手續費（JC）進金庫（platform_fee_ledger.p2p_fee）。
  //  3) 認購：本金 JC 進金庫（private_purchase）＋認購退款（JC 退回用戶）。
  // USDT/JC 一律以「Safe 視角」帶正負號：正=進金庫、負=出金庫。
  type SafeFlow = {
    id: string;
    at: string;
    email: string;
    category: string;
    usdt: number;
    jc: number;
  };
  const safeFlow: SafeFlow[] = [];
  const pushFlow = (flow: SafeFlow) => {
    if (
      invalidRange ||
      !isTransactionHistoryVisible(flow.at) ||
      !isWithinDateRange(flow.at, startDate, endDate)
    ) return;
    safeFlow.push(flow);
  };
  jcLedger.forEach((row) => {
    const who = email(row.user_id);
    const usdtMeta = Number(row.metadata?.usdt ?? 0);
    if (row.entry_type === "vault_buy") {
      pushFlow({
        id: row.id,
        at: row.created_at,
        email: who,
        category: "金庫買 JC（USDT→JC）",
        usdt: usdtMeta || Math.abs(Number(row.amount)),
        jc: -Math.abs(Number(row.amount)),
      });
    } else if (row.entry_type === "redemption_pending") {
      pushFlow({
        id: row.id,
        at: row.created_at,
        email: who,
        category: "金庫贖回（JC→USDT）",
        usdt: -usdtMeta,
        jc: Math.abs(Number(row.amount)),
      });
    } else if (row.entry_type === "redemption_refund") {
      pushFlow({
        id: row.id,
        at: row.created_at,
        email: who,
        category: "贖回退回（JC 退回用戶）",
        usdt: 0,
        jc: -Math.abs(Number(row.amount)),
      });
    } else if (row.entry_type === "private_purchase") {
      pushFlow({
        id: row.id,
        at: row.created_at,
        email: who,
        category: "認購（本金入金庫）",
        usdt: 0,
        jc: Math.abs(Number(row.amount)),
      });
    } else if (row.entry_type === "refund") {
      pushFlow({
        id: row.id,
        at: row.created_at,
        email: who,
        category: "認購退款（JC 退回用戶）",
        usdt: 0,
        jc: -Math.abs(Number(row.amount)),
      });
    }
  });
  treasury
    .filter((row) => row.source_type === "p2p_fee")
    .forEach((row) =>
      pushFlow({
        id: row.id,
        at: row.created_at,
        email: row.payer_email,
        category: "二級市場手續費",
        usdt: 0,
        jc: Number(row.amount),
      }),
    );
  const safeFlowFiltered = safeFlow
    .filter((flow) => includes([flow.email, flow.category, flow.usdt, flow.jc], q))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
  const visibleSafeFlow = showAllTransactions
    ? safeFlowFiltered
    : safeFlowFiltered.slice(0, 10);
  const filteredAudits = audits.filter(
    (audit) =>
      !invalidRange &&
      isWithinDateRange(audit.created_at, startDate, endDate),
  );
  const rangeName = `${startDate || "all"}-${endDate || "all"}`;
  // Safe 視角的帶正負號金額顯示：正=進金庫（綠）、負=出金庫（紅）、0=不適用（—）。
  const flowAmount = (value: number, kind: "usdt" | "jc") => {
    if (!value) return <span className="text-slate-600">—</span>;
    const into = value > 0;
    const text = kind === "usdt" ? money(Math.abs(value)) : formatJC(Math.abs(value));
    return (
      <span className={into ? "text-emerald-300" : "text-rose-300"}>
        {into ? "+" : "−"}
        {text}
      </span>
    );
  };
  return (
    <Panel
      title="交易報表與管理員操作日誌"
      action={
        <Export
          disabled={invalidRange}
          onClick={() =>
            csv(
              `safe-flow-${rangeName}`,
              ["User", "Category", "USDT (Safe)", "JC (Safe)", "Time", "ID"],
              safeFlowFiltered.map((flow) => [
                flow.email,
                flow.category,
                flow.usdt,
                flow.jc,
                flow.at,
                flow.id,
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
  <Metric label="存入 Safe 用戶數" value={String(treasuryUsers.length)} />
  <Metric label="存入 Safe USDT 總計" value={money(treasuryUsdtTotal)} />
  <Metric label="存入 Safe JC 總計" value={formatJC(treasuryJcTotal)} />
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
  <p className="mt-1 break-all text-xs text-slate-500">{CONTRACT_ADDRESSES.safeVault}</p>
  </div>
  <span className="text-xs text-slate-500">依用戶彙總存入 Safe 的 USDT 與 JC</span>
  </div>
  <div className="mt-3">
  <Table>
  <thead><tr><Th>用戶</Th><Th>存入 USDT</Th><Th>存入 JC</Th><Th>最後入帳時間</Th></tr></thead>
  <tbody>
  {visibleTreasury.map((user) => (
  <tr key={user.key} className="border-t border-slate-800">
  <Td>{user.email}</Td>
  <Td>{user.usdtIn > 0 ? money(user.usdtIn) : "—"}</Td>
  <Td>{user.jcIn > 0 ? formatJC(user.jcIn) : "—"}</Td>
  <Td>{new Date(user.lastAt).toLocaleString()}</Td>
  </tr>
  ))}
  </tbody>
  </Table>
  {treasuryUsers.length === 0 && <p className="p-6 text-center text-sm text-slate-500">所選時間範圍內尚無金庫出入帳流水</p>}
  {treasuryUsers.length > 10 && (
  <div className="mt-3 flex justify-center">
  <button
  type="button"
  onClick={() => setShowAllTreasury((visible) => !visible)}
  className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-semibold text-amber-300 hover:bg-slate-800 hover:text-amber-200"
  >
  {showAllTreasury ? "收合" : `查看更多（其餘 ${treasuryUsers.length - 10} 位用戶）`}
  </button>
  </div>
  )}
  </div>
  </section>
      <section>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
              <h3 className="font-semibold">交易紀錄（Safe 金流流水）</h3>
              <p className="mt-1 text-xs text-slate-500">
                僅列出 2026-10-03 起的新紀錄；歷史帳本與報表彙總保留。依時間排序，含 JC 兌換 USDT（雙向）、二級市場、認購。金額為 Safe 視角：

              <span className="text-emerald-300"> 正＝進金庫</span> ·
              <span className="text-rose-300"> 負＝出金庫</span>
            </p>
          </div>
          {safeFlowFiltered.length > 10 && (
            <button
              type="button"
              onClick={() => setShowAllTransactions((visible) => !visible)}
              className="shrink-0 text-xs font-semibold text-amber-300 hover:text-amber-200"
            >
              {showAllTransactions
                ? "收合紀錄"
                : `查閱更多（${safeFlowFiltered.length - 10}）`}
            </button>
          )}
        </div>
        <div className="mt-3">
          <Table>
            <thead>
              <tr>
                <Th>用戶</Th>
                <Th>類型</Th>
                <Th>USDT</Th>
                <Th>JC</Th>
                <Th>時間</Th>
              </tr>
            </thead>
            <tbody>
              {visibleSafeFlow.map((flow) => (
                <tr key={flow.id} className="border-t border-slate-800">
                  <Td>{flow.email}</Td>
                  <Td>{flow.category}</Td>
                  <Td>{flowAmount(flow.usdt, "usdt")}</Td>
                  <Td>{flowAmount(flow.jc, "jc")}</Td>
                  <Td>{new Date(flow.at).toLocaleString()}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {safeFlowFiltered.length === 0 && (
            <p className="p-6 text-center text-sm text-slate-500">
              所選時間範圍內尚無 Safe 金流紀錄
            </p>
          )}
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
function Td({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <td className={`whitespace-nowrap px-5 py-4 text-slate-400${className ? ` ${className}` : ""}`}>
      {children}
    </td>
  );
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
