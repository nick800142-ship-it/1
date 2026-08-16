import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  WalletCards,
} from "lucide-react";
import { supabase } from "@/lib/supabase";

type Profile = {
  id: string;
  email: string;
  display_name: string | null;
  nickname: string | null;
  agency_role: string;
  parent_id: string | null;
  referrer_id: string | null;
  master_agent_id: string | null;
};
type Ledger = {
  id: string;
  user_id: string;
  entry_type: string;
  amount: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
};
type ProcessingError = {
  id: string;
  user_id: string;
  gross: number;
  error_message: string;
  created_at: string;
};
type QueueItem = {
  id: string;
  status: "Pending" | "Error";
  userId: string;
  amount: number;
  detail: string;
  createdAt: string;
};

const REVENUE_TYPES = new Set(["private_purchase", "secondary_buy"]);
const EXPENSE_TYPES = new Set(["secondary_sell", "commission_payout"]);
const AGENT_ROLES = new Set(["總代理", "代理", "一代代理", "二代代理"]);
const money = (value: number) =>
  `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;

export function AdminDashboard() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [errors, setErrors] = useState<ProcessingError[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [performanceQuery, setPerformanceQuery] = useState("");
  const [performanceRole, setPerformanceRole] = useState("全部");

  const load = useCallback(async () => {
    setLoading(true);
    setErrorMessage("");
    const [profilesResult, ledgerResult, errorsResult] = await Promise.all([
      supabase
        .from("profiles")
        .select(
          "id,email,display_name,nickname,agency_role,parent_id,referrer_id,master_agent_id",
        )
        .order("email"),
      supabase
        .from("asset_ledger")
        .select("id,user_id,entry_type,amount,metadata,created_at")
        .order("created_at", { ascending: false }),
      supabase
        .from("commission_processing_errors")
        .select("id,user_id,gross,error_message,created_at")
        .order("created_at", { ascending: false })
        .limit(20),
    ]);
    const firstError =
      profilesResult.error ?? ledgerResult.error ?? errorsResult.error;
    if (firstError) setErrorMessage("無法載入系統監控資料，請稍後再試。");
    setProfiles((profilesResult.data ?? []) as Profile[]);
    setLedger((ledgerResult.data ?? []) as Ledger[]);
    setErrors((errorsResult.data ?? []) as ProcessingError[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const financials = useMemo(() => {
    const grossFor = (row: Ledger) =>
      Math.abs(Number(row.metadata?.gross ?? row.amount));
    const privateAmount = ledger
      .filter((row) => row.entry_type === "private_purchase")
      .reduce((sum, row) => sum + grossFor(row), 0);
    const secondaryRevenue = ledger
      .filter((row) => row.entry_type === "secondary_buy")
      .reduce((sum, row) => sum + grossFor(row), 0);
    const revenue = privateAmount + secondaryRevenue;
    const expenses = ledger
      .filter((row) => EXPENSE_TYPES.has(row.entry_type))
      .reduce((sum, row) => sum + Math.abs(Number(row.amount)), 0);
    return {
      privateAmount,
      secondaryRevenue,
      revenue,
      expenses,
      net: revenue - expenses,
    };
  }, [ledger]);

  const performance = useMemo(
    () =>
      profiles
        .filter((profile) => AGENT_ROLES.has(profile.agency_role))
        .map((agent) => {
          const downlines = profiles.filter(
            (profile) =>
              profile.id !== agent.id &&
              (profile.parent_id === agent.id ||
                profile.referrer_id === agent.id ||
                (agent.agency_role === "總代理" &&
                  profile.master_agent_id === agent.id)),
          );
          const downlineIds = new Set(downlines.map((profile) => profile.id));
          const volume = ledger
            .filter(
              (row) =>
                downlineIds.has(row.user_id) &&
                REVENUE_TYPES.has(row.entry_type),
            )
            .reduce(
              (sum, row) =>
                sum + Math.abs(Number(row.metadata?.gross ?? row.amount)),
              0,
            );
          return { agent, downlineCount: downlines.length, volume };
        })
        .sort((a, b) => b.volume - a.volume),
    [ledger, profiles],
  );

  const filteredPerformance = useMemo(() => {
    const keyword = performanceQuery.trim().toLocaleLowerCase();
    return performance.filter(({ agent }) => {
      const roleMatches =
        performanceRole === "全部" ||
        (performanceRole === "總代理"
          ? agent.agency_role === "總代理"
          : ["代理", "一代代理", "二代代理"].includes(agent.agency_role));
      const queryMatches =
        !keyword ||
        [
          agent.email,
          agent.id,
          agent.nickname,
          agent.display_name,
          agent.agency_role,
        ].some((value) =>
          String(value ?? "")
            .toLocaleLowerCase()
            .includes(keyword),
        );
      return roleMatches && queryMatches;
    });
  }, [performance, performanceQuery, performanceRole]);

  const queue = useMemo<QueueItem[]>(
    () =>
      [
        ...ledger
          .filter((row) => row.entry_type === "commission_pending")
          .map((row) => ({
            id: `pending-${row.id}`,
            status: "Pending" as const,
            userId: row.user_id,
            amount: Math.abs(Number(row.amount)),
            detail: "代理分潤等待派發",
            createdAt: row.created_at,
          })),
        ...errors.map((row) => ({
          id: `error-${row.id}`,
          status: "Error" as const,
          userId: row.user_id,
          amount: Math.abs(Number(row.gross)),
          detail: row.error_message,
          createdAt: row.created_at,
        })),
      ]
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )
        .slice(0, 10),
    [errors, ledger],
  );
  const emailFor = (id: string) =>
    profiles.find((profile) => profile.id === id)?.email ?? id;

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold tracking-wider text-amber-300">
            SYSTEM OVERVIEW
          </p>
          <h2 className="mt-2 text-2xl font-bold text-slate-100">管理儀表板</h2>
          <p className="mt-1 text-sm text-slate-400">
            依現有帳本即時計算營運、代理績效與異常佇列。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="w-fit rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-300 hover:border-amber-400 hover:text-amber-200"
        >
          重新整理
        </button>
      </header>
      {errorMessage && (
        <p
          role="alert"
          className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300"
        >
          {errorMessage}
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <FinancialCard
          label="總私募金額"
          value={financials.privateAmount}
          icon={WalletCards}
          tone="text-amber-300"
        />
        <FinancialCard
          label="二級市場營收"
          value={financials.secondaryRevenue}
          icon={ArrowUpRight}
          tone="text-emerald-300"
        />
        <FinancialCard
          label="總營收"
          value={financials.revenue}
          icon={ArrowUpRight}
          tone="text-emerald-300"
        />
        <FinancialCard
          label="代理商獎金總支出"
          value={financials.expenses}
          icon={ArrowDownRight}
          tone="text-rose-300"
        />
        <FinancialCard
          label="目前淨利"
          value={financials.net}
          icon={WalletCards}
          tone={financials.net >= 0 ? "text-amber-300" : "text-rose-300"}
        />
      </div>
      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
          <div className="border-b border-slate-800 p-5">
            <h3 className="font-bold">推廣績效表</h3>
            <p className="mt-1 text-xs text-slate-500">
              依代理關係與下線交易 gross 金額彙總。
            </p>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <label className="min-w-0 flex-1">
                <span className="sr-only">搜尋代理</span>
                <input
                  type="search"
                  value={performanceQuery}
                  onChange={(event) => setPerformanceQuery(event.target.value)}
                  placeholder="搜尋代理名稱、Email 或 ID"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-amber-400"
                />
              </label>
              <label className="sm:w-36">
                <span className="sr-only">代理身分篩選</span>
                <select
                  value={performanceRole}
                  onChange={(event) => setPerformanceRole(event.target.value)}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-amber-400"
                >
                  <option value="全部">全部身分</option>
                  <option value="總代理">總代理</option>
                  <option value="代理">代理</option>
                </select>
              </label>
            </div>
          </div>
          {loading ? (
            <p className="p-5 text-sm text-slate-400">載入績效中…</p>
          ) : filteredPerformance.length === 0 ? (
            <p className="p-5 text-sm text-slate-500">找不到符合條件的代理。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-xl text-left text-sm">
                <thead className="text-xs text-slate-500">
                  <tr>
                    <th className="px-5 py-3">代理商</th>
                    <th className="px-5 py-3">身分</th>
                    <th className="px-5 py-3">下線用戶數</th>
                    <th className="px-5 py-3">帶來總業績</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPerformance.map(
                    ({ agent, downlineCount, volume }) => (
                      <tr key={agent.id} className="border-t border-slate-800">
                        <td className="break-all px-5 py-3 font-semibold text-slate-200">
                          {agent.email}
                        </td>
                        <td className="px-5 py-3 text-slate-400">
                          {agent.agency_role}
                        </td>
                        <td className="px-5 py-3">{downlineCount}</td>
                        <td className="px-5 py-3 font-semibold text-amber-200">
                          {money(volume)}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
          <div className="flex items-center gap-3 border-b border-slate-800 p-5">
            <AlertTriangle className="size-5 text-amber-300" />
            <div>
              <h3 className="font-bold">待處理清單</h3>
              <p className="mt-1 text-xs text-slate-500">
                近期 Pending 與 Error 交易
              </p>
            </div>
          </div>
          {loading ? (
            <p className="p-5 text-sm text-slate-400">載入清單中…</p>
          ) : queue.length === 0 ? (
            <p className="p-5 text-sm text-slate-500">目前沒有待處理項目。</p>
          ) : (
            <div className="flex flex-col">
              {queue.map((item) => (
                <article
                  key={item.id}
                  className="border-b border-slate-800 p-4 last:border-0"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded-full px-2.5 py-1 text-xs font-bold ${item.status === "Error" ? "bg-rose-500/10 text-rose-300" : "bg-amber-400/10 text-amber-300"}`}
                        >
                          {item.status}
                        </span>
                        <b className="truncate text-sm text-slate-200">
                          {emailFor(item.userId)}
                        </b>
                      </div>
                      <p className="mt-2 line-clamp-2 text-xs text-slate-400">
                        {item.detail}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs font-semibold text-slate-300">
                      {money(item.amount)}
                    </span>
                  </div>
                  <time className="mt-2 block text-xs text-slate-600">
                    {new Date(item.createdAt).toLocaleString()}
                  </time>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function FinancialCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  icon: typeof ArrowUpRight;
  tone: string;
}) {
  return (
    <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-400">{label}</p>
        <Icon className={`size-5 ${tone}`} />
      </div>
      <p className={`mt-4 text-2xl font-bold ${tone}`}>{money(value)}</p>
    </article>
  );
}
