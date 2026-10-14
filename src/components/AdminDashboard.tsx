import { useCallback, useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, WalletCards } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { useVisiblePolling } from "@/hooks/useVisiblePolling";

const keepStable = <T,>(previous: T, next: T): T =>
  JSON.stringify(previous) === JSON.stringify(next) ? previous : next;

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
  asset_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};
// 二級市場手續費流水（platform_fee_ledger 的 p2p_fee）：每筆成交 1% + 掛賣單一次性
// 1 JC（含取消掛單仍不退還的預扣 1 JC），是「二級市場營收」的唯一來源。
type Fee = {
  id: string;
  amount: number;
  source_type: string;
  created_at: string;
  payer_id: string | null;
  asset_id: string | null;
};
// 推廣分潤流水（commission_logs）：每筆代理商應得的獎金，不論已派發或待派發，
// 都是平台已產生的獎金支出。以此為「代理商獎金總支出」的唯一來源，避免用
// jc_ledger 的 commission_pending + commission_payout 加總造成派發後重複計算。
type Commission = {
  id: string;
  commission_amount: number;
  bonus_type: "l1" | "l2" | null;
  created_at: string;
};
const money = (value: number) =>
  `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} JC`;
type Period = "today" | "7d" | "30d" | "all" | "custom";
const periodOptions: { value: Exclude<Period, "custom">; label: string }[] = [
  { value: "today", label: "今日" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "all", label: "全部" },
];
const toDateInput = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
const quickRange = (period: Exclude<Period, "custom">) => {
  if (period === "all") return { from: "", to: "" };
  const to = new Date();
  const from = new Date(to);
  if (period === "7d") from.setDate(from.getDate() - 6);
  if (period === "30d") from.setDate(from.getDate() - 29);
  return { from: toDateInput(from), to: toDateInput(to) };
};
const displayDate = (value: string) =>
  new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "short", day: "numeric" }).format(
    new Date(`${value}T00:00:00`),
  );

export function AdminDashboard({
  onViewUser,
}: {
  onViewUser: (userId: string) => void;
}) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [fees, setFees] = useState<Fee[]>([]);
  const [commissions, setCommissions] = useState<Commission[]>([]);
  // AE 標的的 asset_id 集合，用來從認購帳本區分「AE 認購」與「RWA 認購」。
  const [aeAssetIds, setAeAssetIds] = useState<Set<string>>(new Set(["ae-token-daily"]));
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [performanceQuery, setPerformanceQuery] = useState("");
  const [performanceRole, setPerformanceRole] = useState("全部");
  const [period, setPeriod] = useState<Period>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const load = useCallback(async () => {
    const results = await Promise.all([
      fetchAllRows((rangeFrom, rangeTo) =>
        supabase
          .from("profiles")
          .select(
            "id,email,display_name,nickname,agency_role,parent_id,referrer_id,master_agent_id",
          )
          .order("email")
          .order("id")
          .range(rangeFrom, rangeTo),
      ),
      fetchAllRows((rangeFrom, rangeTo) =>
        supabase
          .from("jc_ledger")
          .select("id,user_id,entry_type,amount,asset_id,metadata,created_at")
          .order("created_at", { ascending: false })
          .order("id")
          .range(rangeFrom, rangeTo),
      ),
      // platform_fee_ledger 開啟 RLS 但無 policy，前端無法直接 select，改用管理員
      // RPC 讀取 p2p_fee 手續費列（二級市場營收來源）。
      fetchAllRows((rangeFrom, rangeTo) =>
        supabase
          .rpc("admin_secondary_fee_attribution_rows")
          .order("created_at", { ascending: false })
          .order("id")
          .range(rangeFrom, rangeTo),
      ),
      // 讀 AE 標的旗標，用來把認購帳本分成 AE 認購與 RWA 認購。
      supabase
        .from("private_placements")
        .select("id,is_ae_token"),
      // 讀推廣分潤流水（代理商獎金總支出來源）。RLS 允許管理員讀全部。
      fetchAllRows((rangeFrom, rangeTo) =>
        supabase
          .from("commission_logs")
          .select("id,commission_amount,bonus_type,created_at")
          .order("created_at", { ascending: false })
          .order("id")
          .range(rangeFrom, rangeTo),
      ),
    ]);
    const [profilesResult, ledgerResult, feesResult, placementsResult, commissionsResult] =
      results;
    const firstError = profilesResult.error ?? ledgerResult.error;
    setErrorMessage(firstError ? "無法載入系統監控資料，請稍後再試。" : "");
    setProfiles((previous) => keepStable(previous, (profilesResult.data ?? []) as Profile[]));
    setLedger((previous) => keepStable(previous, (ledgerResult.data ?? []) as Ledger[]));
    if (!feesResult.error) {
      setFees((previous) => keepStable(previous, (feesResult.data ?? []) as Fee[]));
    }
    if (!placementsResult.error) {
      const aeIds = (
        (placementsResult.data ?? []) as {
          id: string;
          is_ae_token: boolean;
        }[]
      )
        .filter((row) => row.is_ae_token)
        .map((row) => String(row.id).trim());
      // Keep the canonical AE id even if the placement query is temporarily
      // empty or limited by RLS; otherwise the dashboard silently reports 0.
      setAeAssetIds(new Set(["ae-token-daily", ...aeIds]));
    }
    if (!commissionsResult.error) {
      setCommissions((previous) =>
        keepStable(previous, (commissionsResult.data ?? []) as Commission[]),
      );
    }
    setLoading(false);
  }, []);

  useVisiblePolling(load, 5_000, true);

  const dateError = Boolean(from && to && from > to);
  const filteredLedger = useMemo(() => {
    if (dateError) return [];
    const start = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const end = to ? new Date(`${to}T23:59:59.999`).getTime() : null;
    return ledger.filter((row) => {
      const createdAt = new Date(row.created_at).getTime();
      return (
        (start === null || createdAt >= start) &&
        (end === null || createdAt <= end)
      );
    });
  }, [dateError, from, ledger, to]);
  const periodSummary = dateError
    ? "日期範圍無效"
      : !from && !to
      ? "全部歷史資料"
      : `${from ? displayDate(from) : "全部歷史資料"}－${to ? displayDate(to) : "今日"}`;
  const selectPeriod = (nextPeriod: Exclude<Period, "custom">) => {
    const range = quickRange(nextPeriod);
    setPeriod(nextPeriod);
    setFrom(range.from);
    setTo(range.to);
  };

  const filteredFees = useMemo(() => {
    if (dateError) return [];
    const start = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const end = to ? new Date(`${to}T23:59:59.999`).getTime() : null;
    return fees.filter((row) => {
      const createdAt = new Date(row.created_at).getTime();
      return (
        (start === null || createdAt >= start) &&
        (end === null || createdAt <= end)
      );
    });
  }, [dateError, from, fees, to]);

  const filteredCommissions = useMemo(() => {
    if (dateError) return [];
    const start = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const end = to ? new Date(`${to}T23:59:59.999`).getTime() : null;
  return commissions.filter((row) => {
  const createdAt = new Date(row.created_at).getTime();
      return (
        (start === null || createdAt >= start) &&
        (end === null || createdAt <= end)
      );
    });
  }, [commissions, dateError, from, to]);

  const isAePurchase = useCallback(
    (row: Ledger) =>
      row.entry_type === "private_purchase" &&
      row.asset_id != null &&
      (String(row.asset_id).trim() === "ae-token-daily" ||
        aeAssetIds.has(String(row.asset_id).trim())),
    [aeAssetIds],
  );

  const financials = useMemo(() => {
    const grossFor = (row: Ledger) =>
      Math.abs(Number(row.metadata?.gross ?? row.amount));
    const purchaseRows = filteredLedger.filter(
      (row) => row.entry_type === "private_purchase",
    );
    // 篩選期間「私募金額」卡片：全部認購（AE + RWA）。
    const privateAmount = purchaseRows.reduce((sum, row) => sum + grossFor(row), 0);
    // AE 認購金額：只計 AE 標的的認購（平台自有代幣的銷售）。RWA 認購屬代售性質，
    // 不計入平台總營收。
    const aeSubscriptionAmount = purchaseRows
      .filter(isAePurchase)
      .reduce((sum, row) => sum + grossFor(row), 0);
    // 二級市場營收 = 平台實收的二級市場手續費（每筆成交 1% + 掛賣單一次性 1 JC，
    // 含取消掛單仍不退還的預扣 1 JC）。取自 platform_fee_ledger 的 p2p_fee，
    // 不是成交金額本身。
    const secondaryRevenue = filteredFees.reduce(
      (sum, row) => sum + Math.abs(Number(row.amount)),
      0,
    );
    // 總營收 = AE 認購金額 + 二級市場營收。
    const revenue = aeSubscriptionAmount + secondaryRevenue;
    // 代理商獎金總支出 = 期間內產生的推廣分潤（commission_logs），不論已派發或
    // 待派發，都是平台已產生的獎金支出。用 commission_logs 為唯一來源可避免
    // jc_ledger 派發後 pending + payout 兩筆重複計算。
    const expenses = filteredCommissions.reduce(
      (sum, row) => sum + Math.abs(Number(row.commission_amount)),
      0,
    );
    return {
      privateAmount,
      aeSubscriptionAmount,
      secondaryRevenue,
      revenue,
      expenses,
      net: revenue - expenses,
    };
  }, [filteredLedger, filteredFees, filteredCommissions, aeAssetIds]);

  const performance = useMemo(() => {
    const childrenByParent = new Map<string, Set<string>>();
    for (const profile of profiles) {
      // L0/L1/L2 uses the actual referral tree. The legacy master_agent_id and
      // agency_role fields are intentionally not used for hierarchy anymore.
      const parentId = profile.referrer_id ?? profile.parent_id;
      if (!parentId || parentId === profile.id) continue;
      const children = childrenByParent.get(parentId) ?? new Set<string>();
      children.add(profile.id);
      childrenByParent.set(parentId, children);
    }

    return profiles.map((agent) => {
        const l1Ids = childrenByParent.get(agent.id) ?? new Set<string>();
        const l2Ids = new Set<string>();
        for (const l1Id of l1Ids) {
          for (const l2Id of childrenByParent.get(l1Id) ?? []) l2Ids.add(l2Id);
        }
        const lineIds = new Set([agent.id, ...l1Ids, ...l2Ids]);
        const downlineIds = new Set([...l1Ids, ...l2Ids]);
        const aeSubscriptionRevenue = filteredLedger
          .filter(
            (row) =>
              lineIds.has(row.user_id) &&
              isAePurchase(row),
          )
          .reduce(
            (sum, row) =>
              sum + Math.abs(Number(row.metadata?.gross ?? row.amount)),
            0,
          );
        const secondaryFeeRevenue = filteredFees
          .filter((fee) => fee.payer_id != null && lineIds.has(fee.payer_id))
          .reduce((sum, fee) => sum + Math.abs(Number(fee.amount)), 0);

          return {
          agent,
          l0Count: 1,
          l1Count: l1Ids.size,
          l2Count: l2Ids.size,
          downlineCount: downlineIds.size,
          volume: aeSubscriptionRevenue + secondaryFeeRevenue,
        };
      })
      .sort((a, b) => b.volume - a.volume);
  }, [filteredFees, filteredLedger, isAePurchase, profiles]);

  const filteredPerformance = useMemo(() => {
    const keyword = performanceQuery.trim().toLocaleLowerCase();
    return performance.filter(({ agent }) => {
      const roleMatches =
        performanceRole === "全部" ||
        (performanceRole === "L0" && agent.id === agent.id);
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

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold tracking-wider text-amber-300">
            SYSTEM OVERVIEW
          </p>
          <h2 className="mt-2 text-2xl font-bold text-slate-100">管理儀表板</h2>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="w-fit rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-300 hover:border-amber-400 hover:text-amber-200"
        >
          重新整理
        </button>
      </header>
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="flex min-w-0 flex-col gap-3">
            <div>
              <p className="text-xs font-bold tracking-wider text-slate-500">統計期間</p>
              <p className="mt-1 text-sm font-semibold text-slate-200">{periodSummary}</p>
              <p className="mt-1 text-xs text-slate-500">
                未設定日期時統計全部歷史交易；設定日期後才依日期篩選。
              </p>
            </div>
            <div className="flex flex-wrap gap-2" aria-label="快捷時間範圍">
              {periodOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => selectPeriod(option.value)}
                  aria-pressed={period === option.value}
                  className={`rounded-lg border px-3 py-2 text-sm font-semibold transition ${
                    period === option.value
                      ? "border-amber-400 bg-amber-400 text-slate-950"
                      : "border-slate-700 text-slate-300 hover:border-amber-400/60 hover:text-amber-200"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-slate-400">開始日期</span>
              <input
                type="date"
                value={from}
                onChange={(event) => {
                  setFrom(event.target.value);
                  setPeriod("custom");
                }}
                className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-amber-400"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-slate-400">結束日期</span>
              <input
                type="date"
                value={to}
                onChange={(event) => {
                  setTo(event.target.value);
                  setPeriod("custom");
                }}
                className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-amber-400"
              />
            </label>
          </div>
        </div>
        {dateError && (
          <p role="alert" className="mt-3 text-sm font-semibold text-rose-300">
            開始日期不可晚於結束日期，請重新選擇。
          </p>
        )}
      </div>
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
          label="篩選期間私募金額"
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
      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
        <div className="border-b border-slate-800 p-5">
          <h3 className="font-bold">推廣績效表</h3>
          <p className="mt-1 text-xs text-slate-400">
            貢獻業績＝本人及整條下線的 AE 認購營收＋二級市場手續費；不含 RWA 認購本金或投資成交額。
          </p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <label className="min-w-0 flex-1">
              <span className="sr-only">搜尋用戶</span>
              <input
                type="search"
                value={performanceQuery}
                onChange={(event) => setPerformanceQuery(event.target.value)}
                placeholder="搜尋暱稱、Email 或 ID"
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-amber-400"
              />
            </label>
            <label className="sm:w-36">
              <span className="sr-only">創世紀層級篩選</span>
              <select
                value={performanceRole}
                onChange={(event) => setPerformanceRole(event.target.value)}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-200 outline-none focus:border-amber-400"
              >
                <option value="全部">全部身分</option>
                <option value="L0">L0（全部用戶）</option>
              </select>
            </label>
          </div>
        </div>
        {loading ? (
          <p className="p-5 text-sm text-slate-400">載入績效中…</p>
        ) : filteredPerformance.length === 0 ? (
          <p className="p-5 text-sm text-slate-500">找不到符合條件的用戶。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-xl text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-3">代理商</th>
                  <th className="whitespace-nowrap px-5 py-3">L1</th>
                  <th className="whitespace-nowrap px-5 py-3">L2</th>
                  <th className="whitespace-nowrap px-5 py-3">營收貢獻（總營收占比）</th>
                  <th className="whitespace-nowrap px-5 py-3">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredPerformance.map(({ agent, l1Count, l2Count, volume }) => (
                  <tr key={agent.id} className="border-t border-slate-800">
                  <td className="break-all px-5 py-3">
                    <span className="block font-semibold text-slate-200">
                      {agent.nickname ||
                        agent.display_name ||
                        agent.email.split("@")[0]}
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-500">
                      {agent.email}
                    </span>
                  </td>
                    <td className="whitespace-nowrap px-5 py-3 font-semibold text-slate-200">
                      {l1Count}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 font-semibold text-slate-200">
                      {l2Count}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 font-semibold text-amber-200">
                      <span className="block">{money(volume)}</span>
                      <span className="mt-1 block text-xs font-normal text-slate-400">
                        {financials.revenue > 0
                          ? `${((volume / financials.revenue) * 100).toFixed(2)}% 總營收`
                          : "0.00% 總營收"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3">
                      <button
                        type="button"
                        onClick={() => onViewUser(agent.id)}
                        className="rounded-lg border border-amber-400/40 px-3 py-2 text-xs font-bold text-amber-200 hover:bg-amber-400 hover:text-slate-950"
                      >
                        查看詳情
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
