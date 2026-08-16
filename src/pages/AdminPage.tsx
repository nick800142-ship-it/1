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
  ShieldCheck,
  Users,
} from "lucide-react";
import { Notice } from "@/components/Modal";
import { supabase } from "@/lib/supabase";
import { getCommissionTypeMeta } from "@/lib/commission-types";
import { AdminOperations } from "@/components/AdminOperations";
import { UserDetailView } from "@/components/UserDetailView";
import { AdminDashboard } from "@/components/AdminDashboard";
import {
  CommissionDateReport,
  downloadCsv,
  isWithinDateRange,
} from "@/components/CommissionDateReport";
import {
  SearchSuggest,
  type SearchSuggestion,
} from "@/components/SearchSuggest";

type Module =
  | "dashboard"
  | "users"
  | "private"
  | "secondary"
  | "agency"
  | "operations"
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
  created_at: string;
};
type Placement = {
  id: string;
  name: string;
  location: string;
  address: string;
  image: string;
  price: number;
  change: number;
  available: number;
  total_supply: number;
  apy: number;
  valuation: number;
  ends_at: string;
  market_started_at: string | null;
  price_locked_until: string | null;
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
    short: "市場",
    icon: ChartNoAxesCombined,
  },
  {
    id: "agency" as const,
    label: "總代理及代理結構",
    short: "代理",
    icon: ShieldCheck,
  },
  {
    id: "operations" as const,
    label: "公告與獎金派發",
    short: "營運",
    icon: Bell,
  },
  {
    id: "earnings" as const,
    label: "交易報表與稽核",
    short: "報表",
    icon: BadgeDollarSign,
  },
];
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
  secondary_buy: "二級市場買入",
  secondary_sell: "二級市場賣出",
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
    <span className="inline-flex flex-wrap items-center gap-2 text-xs">
      <span className={online ? "text-emerald-300" : "text-slate-400"}>
        {online ? "🟢 線上" : "⚪ 離線"}
      </span>
      {!online && (
        <time
          className="font-mono text-slate-500"
          dateTime={value ?? undefined}
        >
          {formatLastSeen(value)}
        </time>
      )}
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
  const [module, setModule] = useState<Module>("dashboard");
  const [dashboardUserId, setDashboardUserId] = useState<string | null>(null);
  const openUserDetail = (userId: string) => {
    setDashboardUserId(userId);
    setModule("users");
  };
  return (
    <div className="min-h-screen max-w-full overflow-x-hidden">
      <div className="flex min-h-screen max-w-full flex-col lg:flex-row">
        <aside className="hidden w-64 shrink-0 border-r border-slate-800 bg-slate-900/60 p-5 lg:flex lg:flex-col">
          <div className="border-b border-slate-800 pb-5">
            <p className="text-xs font-bold tracking-[.18em] text-amber-300">
              SANDBOX CONTROL
            </p>
            <h1 className="mt-2 text-xl font-bold text-white">後台管理中心</h1>
          </div>
          <nav className="mt-5 flex flex-1 flex-col gap-1">
            {modules.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setModule(id)}
                className={`flex items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium ${module === id ? "bg-amber-400 text-slate-950" : "text-slate-400 hover:bg-slate-800"}`}
              >
                <Icon className="size-5" />
                {label}
              </button>
            ))}
          </nav>
          <button
            onClick={onExit}
            className="flex items-center justify-center gap-2 rounded-xl border border-slate-700 px-4 py-3 text-sm font-semibold"
          >
            <ArrowLeft className="size-4" />
            返回前台網站
          </button>
        </aside>
        <div className="min-w-0 flex-1">
          <header className="flex items-center justify-between border-b border-slate-800 px-4 py-4 sm:px-6 lg:px-8">
            <div>
              <p className="text-xs font-bold text-amber-300">
                測試階段 · Sandbox
              </p>
              <h2 className="text-lg font-bold">
                {modules.find((item) => item.id === module)?.label}
              </h2>
            </div>
            <button
              onClick={onExit}
              className="rounded-lg border border-slate-700 px-3 py-2 text-xs lg:hidden"
            >
              前台
            </button>
          </header>
          <nav className="flex overflow-x-auto border-b border-slate-800 p-2 lg:hidden">
            {modules.map(({ id, short, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setModule(id)}
                className={`flex min-w-20 flex-1 flex-col items-center gap-1 rounded-lg px-3 py-2 text-xs ${module === id ? "bg-amber-400 text-slate-950" : "text-slate-400"}`}
              >
                <Icon className="size-4" />
                {short}
              </button>
            ))}
          </nav>
          <main className="p-4 pb-28 sm:p-6 lg:p-8">
            {module === "dashboard" && (
              <AdminDashboard onViewUser={openUserDetail} />
            )}
            {module === "users" && (
              <UsersModule
                initialUserId={dashboardUserId}
                onReturnDashboard={() => {
                  setDashboardUserId(null);
                  setModule("dashboard");
                }}
              />
            )}
            {module === "private" && <PrivateModule />}
            {module === "secondary" && <SecondaryModule />}
            {module === "agency" && (
              <div className="flex flex-col gap-8">
                <AgencyApplications />
                <AgencyModule />
              </div>
            )}
            {module === "earnings" && <ReportsModule />}
            {module === "operations" && <AdminOperations />}
          </main>
        </div>
      </div>
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
      supabase.from("private_placements").select("*").order("created_at"),
      supabase
        .from("commission_logs")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase
        .from("admin_audit_logs")
        .select("*")
        .order("created_at", { ascending: false }),
    ]);
    setProfiles((p.data ?? []) as Profile[]);
    setLedger((l.data ?? []) as Ledger[]);
    setPlacements((pp.data ?? []) as Placement[]);
    setCommissions((c.data ?? []) as Commission[]);
    setAudits((a.data ?? []) as Audit[]);
    setLoading(false);
  };
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(interval);
  }, []);
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
  initialUserId,
  onReturnDashboard,
}: {
  initialUserId: string | null;
  onReturnDashboard: () => void;
}) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [userCommissions, setUserCommissions] = useState<
    { beneficiary_id: string; commission_amount: number }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const [profilesResult, ledgerResult, commissionsResult] = await Promise.all(
      [
        supabase
          .from("profiles")
          .select("*")
          .order("created_at", { ascending: false }),
        supabase
          .from("asset_ledger")
          .select("*")
          .order("created_at", { ascending: false }),
        supabase
          .from("commission_logs")
          .select("beneficiary_id,commission_amount"),
      ],
    );
    if (profilesResult.error || ledgerResult.error || commissionsResult.error) {
      setLoadError("用戶資料載入失敗，請稍後重新整理。");
    }
    setProfiles((profilesResult.data ?? []) as Profile[]);
    setLedger((ledgerResult.data ?? []) as Ledger[]);
    setUserCommissions(
      (commissionsResult.data ?? []) as {
        beneficiary_id: string;
        commission_amount: number;
      }[],
    );
    setLoading(false);
  }, []);
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(interval);
  }, [refresh]);
  const now = useCurrentTime();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(
    initialUserId,
  );
  useEffect(() => {
    if (initialUserId) setSelectedUserId(initialUserId);
  }, [initialUserId]);
  const closeDetail = () => {
    setSelectedUserId(null);
    onReturnDashboard();
  };
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("全部");
  const [bonusSort, setBonusSort] = useState<"asc" | "desc">("desc");
  const [expandedMasters, setExpandedMasters] = useState<string[]>([]);
  const [expandedAgents, setExpandedAgents] = useState<string[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(
    null,
  );
  const balance = (id: string) =>
    ledger
      .filter((row) => row.user_id === id)
      .reduce((sum, row) => sum + Number(row.amount), 0);
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
          if (selectedUserId && user.id !== selectedUserId) return false;
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
    [profiles, q, roleFilter, bonusSort, bonusAmount, now, selectedUserId],
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
  };
  const selectedUser = profiles.find((user) => user.id === selectedUserId);
  if (selectedUserId && !selectedUser && !loading) {
    return (
      <Panel
        title="用戶與帳號"
        description="找不到指定用戶，請返回列表重新選擇。"
      >
        <button
          type="button"
          onClick={closeDetail}
          className="w-fit rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-300 hover:border-amber-400 hover:text-amber-200"
        >
          返回用戶列表
        </button>
      </Panel>
    );
  }
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
                onClick={() => setSelectedUserId(user.id)}
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
        <span className="block max-w-44 truncate font-mono text-xs">
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
          <input
            aria-label={`${user.email} 測試 USDT 金額`}
            value={amounts[user.id] ?? ""}
            onChange={(event) =>
              setAmounts((value) => ({
                ...value,
                [user.id]: event.target.value,
              }))
            }
            type="number"
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
  if (selectedUserId) {
    return <UserDetailView userId={selectedUserId} onBack={closeDetail} />;
  }
  return (
    <Panel
      title="用戶與帳號"
      description="搜尋後直接管理用戶資料、投資金額、錢包與測試 USDT。"
      action={
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
  useEffect(() => {
    void load();
  }, []);
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
      description="核准後自動產生唯一 9 碼推廣碼；代理會綁定申請時指定的總代理。"
    >
      {notice && (
        <Notice message={notice.text} tone={notice.ok ? "success" : "error"} />
      )}
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h3 className="font-bold">修正用戶／代理綁定</h3>
        <p className="mt-1 text-xs text-slate-500">
          僅 Admin 可執行，原因與前後關係會寫入稽核紀錄。
        </p>
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

function PrivateModule() {
  const { placements, refresh } = useAdminData();
  const [q, setQ] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState({
    id: "",
    name: "",
    location: "",
    address: "",
    image: "",
    price: "",
    total: "",
    available: "",
    endsAt: "",
  });
  const shown = placements.filter((item) =>
    includes([item.name, item.location, item.ends_at, item.total_supply], q),
  );
  const create = async () => {
    const values = {
      price: Number(draft.price),
      total: Number(draft.total),
      available: Number(draft.available),
    };
    if (
      !draft.id.trim() ||
      !draft.name.trim() ||
      !draft.location.trim() ||
      !draft.address.trim() ||
      !draft.image.trim() ||
      !draft.endsAt ||
      values.price <= 0 ||
      values.total <= 0 ||
      values.available < 0 ||
      values.available > values.total
    ) {
      setNotice("請完整填寫資料，並確認價格、供應量與結束時間");
      return;
    }
    const { error } = await supabase.rpc("admin_create_placement", {
      p_id: draft.id.trim(),
      p_name: draft.name.trim(),
      p_location: draft.location.trim(),
      p_address: draft.address.trim(),
      p_image: draft.image.trim(),
      p_price: values.price,
      p_total_supply: values.total,
      p_available: values.available,
      p_ends_at: new Date(draft.endsAt).toISOString(),
    });
    setNotice(
      error ? "新增失敗，請確認標的代碼未重複且資料有效" : "私募標的物已新增",
    );
    if (!error) {
      setDraft({
        id: "",
        name: "",
        location: "",
        address: "",
        image: "",
        price: "",
        total: "",
        available: "",
        endsAt: "",
      });
      await refresh();
    }
  };
  const save = async (item: Placement) => {
    const { error } = await supabase.rpc("admin_upsert_placement", {
      p_id: item.id,
      p_name: item.name,
      p_location: item.location,
      p_address: item.address,
      p_image: item.image,
      p_price: item.price,
      p_total_supply: item.total_supply,
      p_available: item.available,
      p_ends_at: item.ends_at,
    });
    setNotice(error ? "更新失敗" : "私募標的與操作日誌已更新");
    if (!error) await refresh();
  };
  const endNow = async (item: Placement) => {
    if (!window.confirm(`確定馬上結束「${item.name}」並開放到二級市場？`))
      return;
    const { error } = await supabase.rpc("admin_end_private_placement", {
      placement_id: item.id,
    });
    setNotice(error ? "馬上結束失敗" : "私募已結束，標的已進入二級市場");
    if (!error) await refresh();
  };
  return (
    <Panel
      title="私募標的物管理"
      description="修改標的資訊會自動留下管理員操作日誌。"
    >
      <section className="rounded-2xl border border-amber-500/20 bg-slate-900 p-5">
        <h3 className="font-bold">建立新私募標的</h3>
        <p className="mt-1 text-xs text-slate-500">
          建立後會立即顯示於用戶認購頁，直到進入二級市場。
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(
            [
              ["id", "標的代碼"],
              ["name", "標的名稱"],
              ["location", "地區"],
              ["address", "完整地址"],
              ["image", "圖片網址"],
              ["price", "認購單價"],
              ["total", "總供應量"],
              ["available", "可認購量"],
              ["endsAt", "認購結束時間"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="text-xs text-slate-400">
              {label}
              <input
                type={
                  key === "endsAt"
                    ? "datetime-local"
                    : ["price", "total", "available"].includes(key)
                      ? "number"
                      : "text"
                }
                min={["price", "total"].includes(key) ? "0.01" : undefined}
                value={draft[key]}
                onChange={(event) =>
                  setDraft((value) => ({ ...value, [key]: event.target.value }))
                }
                className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm"
              />
            </label>
          ))}
        </div>
        <button
          onClick={() => void create()}
          className="mt-4 rounded-xl bg-amber-400 px-5 py-3 font-bold text-slate-950"
        >
          建立標的
        </button>
      </section>
      <SearchBar
        value={q}
        onChange={setQ}
        placeholder="搜尋標的、地點、結束時間或總代幣數量"
        suggestions={placements.map((item) => ({
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
              <h3 className="font-bold">{item.name}</h3>
              <p className="mt-1 text-xs text-slate-500">{item.location}</p>
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
                    Date.now() > new Date(item.ends_at).getTime()
                      ? "已結束"
                      : "進行中"
                  }
                />
              </div>
              <label className="mt-4 block text-xs text-slate-400">
                私募結束時間
                <input
                  type="datetime-local"
                  defaultValue={item.ends_at.slice(0, 16)}
                  onChange={(event) =>
                    (item.ends_at = new Date(event.target.value).toISOString())
                  }
                  className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-3"
                />
              </label>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <button
                  onClick={() => void save(item)}
                  className="rounded-xl bg-amber-400 py-3 font-bold text-slate-950"
                >
                  儲存標的物
                </button>
                <button
                  onClick={() => void endNow(item)}
                  disabled={Date.now() > new Date(item.ends_at).getTime()}
                  className="rounded-xl border border-rose-500/50 py-3 font-bold text-rose-300 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  馬上結束並進入二級市場
                </button>
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
  const shown = placements.filter(
    (item) =>
      item.market_started_at &&
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
        `確定將「${item.name}」價格改為 ${money(price)}？新價格立即生效，並暫停新掛單一分鐘。`,
      )
    )
      return;
    const { error } = await supabase.rpc("admin_change_secondary_price", {
      asset_key: item.id,
      new_price: price,
    });
    setNotice(
      error ? "價格更新失敗" : "價格已更新；新掛單暫停一分鐘，既有訂單不受影響",
    );
    if (!error) {
      setPrices((value) => ({ ...value, [item.id]: "" }));
      await refresh();
    }
  };
  return (
    <Panel
      title="二級市場標的物"
      description="目前 Sandbox 市場價格與供應狀態。"
    >
      <SearchBar
        value={q}
        onChange={setQ}
        placeholder="搜尋標的、地點、��格或漲跌"
        suggestions={placements
          .filter((item) => item.market_started_at)
          .map((item) => ({
            value: item.name,
            label: item.name,
            detail: `${money(item.price)} · ${item.change}%`,
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
            <Th>更改價格</Th>
          </tr>
        </thead>
        <tbody>
          {shown.map((item) => (
            <tr key={item.id} className="border-t border-slate-800">
              <Td>
                <b>{item.name}</b>
              </Td>
              <Td>{money(item.price)}</Td>
              <Td>{item.change}%</Td>
              <Td>
                {Number(item.available).toLocaleString()} /{" "}
                {Number(item.total_supply).toLocaleString()}
              </Td>
              <Td>
                <div className="flex min-w-56 gap-2">
                  <input
                    aria-label={`${item.name} 新價格`}
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={prices[item.id] ?? ""}
                    onChange={(event) =>
                      setPrices((value) => ({
                        ...value,
                        [item.id]: event.target.value,
                      }))
                    }
                    placeholder={String(item.price)}
                    className="w-28 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                  />
                  <button
                    onClick={() => void changePrice(item)}
                    className="rounded-lg bg-amber-400 px-3 py-2 font-bold text-slate-950"
                  >
                    更改價格
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

function AgencyModule() {
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
  const matchesSearch = (profile: Profile) =>
    includes(
      [
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
  const buyer = (id: string) =>
    profiles.find((profile) => profile.id === id)?.email ?? id;
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
            agent ? masterForAgent(agent)?.email || "未歸屬" : "未歸屬",
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
                {agent.email}
              </b>
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
        placeholder="依 Email、錢包地址或身份搜尋"
        suggestions={agents.map((agent) => ({
          value: agent.email,
          label: agent.email,
          detail: `${agent.agency_role}${agent.wallet_address ? ` · ${agent.wallet_address}` : ""}`,
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
  const { profiles, ledger, audits, placements } = useAdminData();
  const [q, setQ] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [showAllTransactions, setShowAllTransactions] = useState(false);
  const [showAllAudits, setShowAllAudits] = useState(false);
  const email = (id: string) =>
    profiles.find((profile) => profile.id === id)?.email ?? id;
  const assetName = (assetId: string | null, entryType: string) =>
    placements.find((placement) => placement.id === assetId)?.name ??
    (entryType === "sandbox_deposit" ? "測試 USDT" : "代理分潤");
  const invalidRange = Boolean(startDate && endDate && startDate > endDate);
  const rows = ledger.filter(
    (row) =>
      !invalidRange &&
      isWithinDateRange(row.created_at, startDate, endDate) &&
      includes(
        [
          email(row.user_id),
          formatLedgerType(row.entry_type),
          assetName(row.asset_id, row.entry_type),
          row.amount,
        ],
        q,
      ),
  );
  const rangeName = `${startDate || "all"}-${endDate || "all"}`;
  return (
    <Panel
      title="交易報表與管理員操作日誌"
      description="所有 Sandbox 資產異動與關鍵��理操作均可追蹤。"
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
                assetName(row.asset_id, row.entry_type),
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
          detail: `${formatLedgerType(row.entry_type)} · ${assetName(row.asset_id, row.entry_type)} · ${row.amount}`,
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
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label="流水筆數" value={String(rows.length)} />
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
                  <Td>{assetName(row.asset_id, row.entry_type)}</Td>
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
          {audits.length > 3 && (
            <button
              type="button"
              onClick={() => setShowAllAudits((visible) => !visible)}
              className="text-xs font-semibold text-amber-300 hover:text-amber-200"
            >
              {showAllAudits ? "收合日誌" : `查閱更多（${audits.length - 3}）`}
            </button>
          )}
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {(showAllAudits ? audits : audits.slice(0, 3)).map((audit) => (
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
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-5">
      <header className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 className="break-words text-2xl font-bold">{title}</h2>
          <p className="mt-1 break-words text-sm text-slate-400">
            {description}
          </p>
        </div>
        {action}
      </header>
      {children}
    </div>
  );
}
function Table({ children }: { children: ReactNode }) {
  return (
    <div className="w-full max-w-full overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900">
      <table className="w-full min-w-[760px] text-left text-sm">
        {children}
      </table>
    </div>
  );
}
function Th({ children }: { children: ReactNode }) {
  return (
    <th className="border-b border-slate-800 px-5 py-3 text-slate-500">
      {children}
    </th>
  );
}
function Td({ children }: { children: ReactNode }) {
  return <td className="px-5 py-4 text-slate-400">{children}</td>;
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
