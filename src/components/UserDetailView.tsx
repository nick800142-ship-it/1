import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ArrowLeft, CalendarDays, Filter } from "lucide-react";
import { supabase } from "@/lib/supabase";

const money = (value: number) =>
  `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;

const number = (value: number | null) =>
  value == null
    ? "—"
    : value.toLocaleString("en-US", { maximumFractionDigits: 6 });

type Profile = {
  id: string;
  email: string;
  display_name: string | null;
  nickname: string | null;
  agency_role: string | null;
};

type SourceFilter = "all" | "commission" | "trade";

type MemberProfile = {
  id: string;
  email: string;
  display_name: string | null;
  nickname: string | null;
  agency_role: string;
  balance: number | string | null;
  created_at: string | null;
  referrer_id: string | null;
  parent_id: string | null;
};

const AGENT_ROLES = new Set(["總代理", "代理", "一代代理", "二代代理"]);

const transactionTypeLabel: Record<string, string> = {
  private_purchase: "私募認購",
  secondary_buy: "二級市場買入",
  secondary_sell: "二級市場賣出",
  p2p_buy: "二級市場買入",
  p2p_sell: "二級市場賣出",
  private: "私募分潤",
  secondary: "二級市場分潤",
};

type TurnoverCategory =
  | "rwa_purchase"
  | "rwa_secondary"
  | "ae_purchase"
  | "ae_secondary";

type DetailRow = {
  id: string;
  source: "交易紀錄" | "分潤";
  type: string;
  amount: number;
  fee: number | null;
  asset: string;
  quantity: number | null;
  buyer: string | null;
  buyerId: string | null;
  purchaseAmount: number | null;
  rate: number | null;
  createdAt: string;
  turnoverCategory: TurnoverCategory | null;
};

const TURNOVER_CATEGORY_LABEL: Record<TurnoverCategory, string> = {
  rwa_purchase: "RWA認購",
  rwa_secondary: "RWA二級市場",
  ae_purchase: "AE認購",
  ae_secondary: "AE二級市場",
};

type LedgerRow = {
  id: string;
  entry_type:
    | "private_purchase"
    | "secondary_buy"
    | "secondary_sell"
    | "p2p_buy"
    | "p2p_sell";
  amount: number | string;
  quantity: number | string | null;
  asset_id: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

type SimpleTurnoverRow = {
  turnoverCategory: TurnoverCategory;
  purchaseAmount: number;
  createdAt: string;
};

type DirectMemberLedgerRow = {
  entry_type:
    | "private_purchase"
    | "secondary_buy"
    | "secondary_sell"
    | "p2p_buy"
    | "p2p_sell";
  amount: number | string;
  asset_id: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

type CommissionRow = {
  id: string;
  transaction_type: string;
  commission_amount: number | string;
  transaction_amount: number | string;
  commission_rate: number | string;
  asset_id: string | null;
  source_user_id: string | null;
  buyer_id: string | null;
  source_ledger_id: string | null;
  created_at: string;
};

function profileName(profile?: Profile) {
  if (!profile) return "未知用戶";
  return (
    profile.nickname ||
    profile.display_name ||
    profile.email?.split("@")[0] ||
    "未知用戶"
  );
}

function metadataNumber(metadata: Record<string, unknown> | null, key: string) {
  const value = metadata?.[key];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function UserDetailView({
  userId,
  onBack,
  embedded = false,
}: {
  userId: string;
  onBack: () => void;
  embedded?: boolean;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [balance, setBalance] = useState(0);
  const [rows, setRows] = useState<DetailRow[]>([]);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [turnoverView, setTurnoverView] = useState<
    "personal" | "commission" | "direct_members"
  >("personal");
  const [directMemberTradeRows, setDirectMemberTradeRows] = useState<
    SimpleTurnoverRow[]
  >([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");

    const [
      profileResult,
      balanceResult,
      commissionResult,
      tradeResult,
      assetsResult,
      profilesResult,
    ] = await Promise.all([
      supabase
        .from("profiles")
        .select("id,email,display_name,nickname,agency_role")
        .eq("id", userId)
        .maybeSingle(),
      supabase.rpc("admin_get_wallet_balance", { target_user_id: userId }),
      supabase
        .from("commission_logs")
        .select(
          "id,transaction_type,commission_amount,transaction_amount,commission_rate,asset_id,source_user_id,buyer_id,source_ledger_id,created_at",
        )
        .eq("beneficiary_id", userId),
      supabase
        .from("asset_ledger")
        .select("id,entry_type,amount,quantity,asset_id,created_at,metadata")
        .eq("user_id", userId)
        .in("entry_type", [
          "private_purchase",
          "secondary_buy",
          "secondary_sell",
          "p2p_buy",
          "p2p_sell",
        ]),
      supabase.from("private_placements").select("id,name,is_ae_token"),
      supabase
        .from("profiles")
        .select(
          "id,email,display_name,nickname,agency_role,balance,created_at,referrer_id,parent_id",
        ),
    ]);

    const firstError =
      profileResult.error ??
      balanceResult.error ??
      commissionResult.error ??
      tradeResult.error ??
      assetsResult.error ??
      profilesResult.error;
    if (firstError) {
      setError("無法載入用戶紀錄，請稍後再試。");
      setLoading(false);
      return;
    }

    const targetProfile = profileResult.data as Profile | null;
    setProfile(targetProfile);
    setBalance(Number(balanceResult.data ?? 0));

    const assetsData = (assetsResult.data ?? []) as {
      id: string;
      name: string;
      is_ae_token: boolean | null;
    }[];
    const assetNames = new Map(
      assetsData.map((asset) => [asset.id, asset.name]),
    );
    const assetIsAeToken = new Map(
      assetsData.map((asset) => [asset.id, Boolean(asset.is_ae_token)]),
    );
    const profiles = (profilesResult.data ?? []) as MemberProfile[];
    const profileNames = new Map(
      profiles.map((item) => [item.id, profileName(item)]),
    );

    // 直屬會員四項數據：只彙總「總代理」本人直接推薦（非代理身分）的會員，
    // 依購買/二級市場與 RWA/AE 分類加總他們自己的交易金額。
    const directMemberIds =
      targetProfile?.agency_role === "總代理"
        ? profiles
            .filter(
              (member) =>
                !AGENT_ROLES.has(member.agency_role) &&
                (member.referrer_id === targetProfile.id ||
                  member.parent_id === targetProfile.id),
            )
            .map((member) => member.id)
        : [];

    const directMemberTradeResult = directMemberIds.length
      ? await supabase
          .from("asset_ledger")
          .select("entry_type,amount,asset_id,created_at,metadata")
          .in("user_id", directMemberIds)
          .in("entry_type", [
            "private_purchase",
            "secondary_buy",
            "secondary_sell",
            "p2p_buy",
            "p2p_sell",
          ])
      : { data: [] as DirectMemberLedgerRow[], error: null };
    if (directMemberTradeResult.error) {
      setError("無法載入用戶紀錄，請稍後再試。");
      setLoading(false);
      return;
    }

    // 分潤來自「買方」的原始交易，買方通常不是受益人本人，所以不能只用
    // 受益人自己的 asset_ledger 紀錄來查數量，否則永遠對不到（顯示「—」）。
    // 這裡直接依 commission_logs 記下的 source_ledger_id 去撈對應的原始交易，
    // 不限定 user_id，新舊分潤紀錄都能正確補上數量。
    const commissionRowsRaw = (commissionResult.data ?? []) as CommissionRow[];
    const sourceLedgerIds = Array.from(
      new Set(
        commissionRowsRaw
          .map((row) => row.source_ledger_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const sourceLedgerResult = sourceLedgerIds.length
      ? await supabase
          .from("asset_ledger")
          .select("id,entry_type,amount,quantity,asset_id,created_at,metadata")
          .in("id", sourceLedgerIds)
      : { data: [] as LedgerRow[], error: null };
    if (sourceLedgerResult.error) {
      setError("無法載入用戶紀錄，請稍後再試。");
      setLoading(false);
      return;
    }
    const sourceLedger = new Map(
      ((sourceLedgerResult.data ?? []) as LedgerRow[]).map((entry) => [
        entry.id,
        entry,
      ]),
    );

    const commissionRows = commissionRowsRaw.map(
      (row) => {
        const sourceTrade = row.source_ledger_id
          ? sourceLedger.get(row.source_ledger_id)
          : undefined;
        const buyerId = row.source_user_id ?? row.buyer_id;
        const isAeToken = row.asset_id
          ? assetIsAeToken.get(row.asset_id) ?? false
          : false;
        const isPurchase = row.transaction_type === "private";
        const turnoverCategory: TurnoverCategory = isPurchase
          ? isAeToken
            ? "ae_purchase"
            : "rwa_purchase"
          : isAeToken
            ? "ae_secondary"
            : "rwa_secondary";
        return {
          id: `commission-${row.id}`,
          source: "分潤" as const,
          type: transactionTypeLabel[row.transaction_type] ?? "代理分潤",
          amount: Number(row.commission_amount),
          fee: null,
          asset: row.asset_id
            ? assetNames.get(row.asset_id) ?? row.asset_id
            : "—",
          quantity: sourceTrade?.quantity == null ? null : Number(sourceTrade.quantity),
          buyer: buyerId ? profileNames.get(buyerId) ?? "未知用戶" : "未知用戶",
          buyerId: buyerId ?? null,
          purchaseAmount: Number(row.transaction_amount),
          rate: Number(row.commission_rate),
          createdAt: row.created_at,
          turnoverCategory,
        } satisfies DetailRow;
      },
    );

    const tradeRows = ((tradeResult.data ?? []) as LedgerRow[]).map((row) => {
      const gross = metadataNumber(row.metadata, "gross");
      const fee = metadataNumber(row.metadata, "fee");
      const isAeToken = row.asset_id
        ? assetIsAeToken.get(row.asset_id) ?? false
        : false;
      const isPurchase = row.entry_type === "private_purchase";
      const turnoverCategory: TurnoverCategory = isPurchase
        ? isAeToken
          ? "ae_purchase"
          : "rwa_purchase"
        : isAeToken
          ? "ae_secondary"
          : "rwa_secondary";
      return {
        id: `trade-${row.id}`,
        source: "交易紀錄" as const,
        type: transactionTypeLabel[row.entry_type] ?? row.entry_type,
        amount: Number(row.amount),
        fee,
        asset: row.asset_id
          ? assetNames.get(row.asset_id) ?? row.asset_id
          : "—",
        quantity: row.quantity == null ? null : Number(row.quantity),
        buyer: null,
        buyerId: null,
        purchaseAmount: gross || Math.abs(Number(row.amount)) - fee,
        rate: null,
        createdAt: row.created_at,
        turnoverCategory,
      } satisfies DetailRow;
    });

    setRows(
      [...commissionRows, ...tradeRows].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    );

    setDirectMemberTradeRows(
      ((directMemberTradeResult.data ?? []) as DirectMemberLedgerRow[]).map(
        (row) => {
          const gross = metadataNumber(row.metadata, "gross");
          const fee = metadataNumber(row.metadata, "fee");
          const isAeToken = row.asset_id
            ? assetIsAeToken.get(row.asset_id) ?? false
            : false;
          const isPurchase = row.entry_type === "private_purchase";
          const turnoverCategory: TurnoverCategory = isPurchase
            ? isAeToken
              ? "ae_purchase"
              : "rwa_purchase"
            : isAeToken
              ? "ae_secondary"
              : "rwa_secondary";
          return {
            turnoverCategory,
            purchaseAmount: gross || Math.abs(Number(row.amount)) - fee,
            createdAt: row.created_at,
          } satisfies SimpleTurnoverRow;
        },
      ),
    );

    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredRows = useMemo(() => {
    const start = startDate
      ? new Date(`${startDate}T00:00:00`).getTime()
      : Number.NEGATIVE_INFINITY;
    const end = endDate
      ? new Date(`${endDate}T23:59:59.999`).getTime()
      : Number.POSITIVE_INFINITY;
    return rows.filter((row) => {
      const matchesSource =
        sourceFilter === "all" ||
        (sourceFilter === "commission" && row.source === "分潤") ||
        (sourceFilter === "trade" && row.source === "交易紀錄");
      const time = new Date(row.createdAt).getTime();
      return matchesSource && time >= start && time <= end;
    });
  }, [endDate, rows, sourceFilter, startDate]);

  const turnoverTotals = useMemo(() => {
    const totals: Record<TurnoverCategory, number> = {
      rwa_purchase: 0,
      rwa_secondary: 0,
      ae_purchase: 0,
      ae_secondary: 0,
    };
    for (const row of filteredRows) {
      if (row.source !== "交易紀錄" || !row.turnoverCategory) continue;
      totals[row.turnoverCategory] += Math.abs(row.purchaseAmount ?? 0);
    }
    return totals;
  }, [filteredRows]);

  // 「分潤」頁籤只顯示下線帶來的業績與分潤，扣除自己投資產生的自我分潤，
  // 避免總業績/分潤金額灌入自己本人的部分。
  const commissionTurnoverTotals = useMemo(() => {
    const totals: Record<
      TurnoverCategory,
      { business: number; commission: number }
    > = {
      rwa_purchase: { business: 0, commission: 0 },
      rwa_secondary: { business: 0, commission: 0 },
      ae_purchase: { business: 0, commission: 0 },
      ae_secondary: { business: 0, commission: 0 },
    };
    for (const row of filteredRows) {
      if (row.source !== "分潤" || !row.turnoverCategory) continue;
      if (profile && row.buyerId === profile.id) continue;
      totals[row.turnoverCategory].business += Math.abs(
        row.purchaseAmount ?? 0,
      );
      totals[row.turnoverCategory].commission += Math.abs(row.amount);
    }
    return totals;
  }, [filteredRows, profile]);

  // 「個人業績」頁籤額外顯示自己投資所產生的自我分潤金額。
  const personalCommissionTotals = useMemo(() => {
    const totals: Record<TurnoverCategory, number> = {
      rwa_purchase: 0,
      rwa_secondary: 0,
      ae_purchase: 0,
      ae_secondary: 0,
    };
    if (!profile) return totals;
    for (const row of filteredRows) {
      if (row.source !== "分潤" || !row.turnoverCategory) continue;
      if (row.buyerId !== profile.id) continue;
      totals[row.turnoverCategory] += Math.abs(row.amount);
    }
    return totals;
  }, [filteredRows, profile]);

  const isAgent =
    profile?.agency_role === "總代理" || profile?.agency_role === "代理";
  const isMasterAgent = profile?.agency_role === "總代理";

  // 直屬會員四項數據：加總總代理所有直屬會員（非代理身分）在所選區間內
  // 各自產生的 RWA/AE 認購與二級市場交易金額。
  const directMemberTotals = useMemo(() => {
    const start = startDate
      ? new Date(`${startDate}T00:00:00`).getTime()
      : Number.NEGATIVE_INFINITY;
    const end = endDate
      ? new Date(`${endDate}T23:59:59.999`).getTime()
      : Number.POSITIVE_INFINITY;
    const totals: Record<TurnoverCategory, number> = {
      rwa_purchase: 0,
      rwa_secondary: 0,
      ae_purchase: 0,
      ae_secondary: 0,
    };
    for (const row of directMemberTradeRows) {
      const time = new Date(row.createdAt).getTime();
      if (time < start || time > end) continue;
      totals[row.turnoverCategory] += Math.abs(row.purchaseAmount);
    }
    return totals;
  }, [directMemberTradeRows, endDate, startDate]);

  return (
    <section className="flex flex-col gap-5">
      {!embedded && (
        <button
          type="button"
          onClick={onBack}
          className="flex w-fit items-center gap-2 rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-300 hover:border-amber-400 hover:text-amber-200"
        >
          <ArrowLeft className="size-4" />
          返回
        </button>
      )}

      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <p className="text-xs font-bold tracking-wider text-amber-300">用戶名稱</p>
        <h2 className="mt-2 break-all text-xl font-bold text-slate-100">
          {profile?.nickname ||
            profile?.display_name ||
            profile?.email?.split("@")[0] ||
            "載入用戶資料中…"}
        </h2>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <Info label="Email" value={profile?.email ?? "—"} />
          <Info label="目前餘額" value={money(balance)} />
          <Info label="代理身分" value={profile?.agency_role || "一般用戶"} />
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-center gap-3">
          <CalendarDays className="size-5 text-amber-300" />
          <div>
            <h3 className="font-bold">時間與來源篩選</h3>
            <p className="text-xs text-slate-500">
              日期區間包含開始日與結束日。
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <DateInput label="開始日期" value={startDate} onChange={setStartDate} />
          <DateInput label="結束日期" value={endDate} onChange={setEndDate} />
          <label className="text-xs font-medium text-slate-400">
            來源選擇
            <span className="relative mt-2 flex items-center">
              <Filter className="pointer-events-none absolute left-3 size-4 text-slate-500" />
              <select
                value={sourceFilter}
                onChange={(event) =>
                  setSourceFilter(event.target.value as SourceFilter)
                }
                className="w-full appearance-none rounded-xl border border-slate-700 bg-slate-950 py-3 pr-8 pl-9 text-sm text-slate-200"
              >
                <option value="all">全部</option>
                <option value="commission">分潤</option>
                <option value="trade">交易紀錄</option>
              </select>
            </span>
          </label>
        </div>
        {(startDate || endDate || sourceFilter !== "all") && (
          <button
            type="button"
            onClick={() => {
              setStartDate("");
              setEndDate("");
              setSourceFilter("all");
            }}
            className="mt-3 text-xs font-semibold text-amber-300 hover:text-amber-200"
          >
            清除篩選
          </button>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {isAgent && (
          <div className="flex items-center gap-2">
            <ToggleButton
              active={turnoverView === "personal"}
              onClick={() => setTurnoverView("personal")}
            >
              個人業績
            </ToggleButton>
            <ToggleButton
              active={turnoverView === "commission"}
              onClick={() => setTurnoverView("commission")}
            >
              分潤
            </ToggleButton>
            {isMasterAgent && (
              <ToggleButton
                active={turnoverView === "direct_members"}
                onClick={() => setTurnoverView("direct_members")}
              >
                直屬會員資料
              </ToggleButton>
            )}
          </div>
        )}
        {turnoverView === "direct_members" && (
          <p className="text-xs text-slate-500">
            顯示所選區間內，總代理所有直屬會員（不含代理身分）加總的交易金額。
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {turnoverView === "commission" && isAgent ? (
            <>
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.rwa_purchase}
                primaryLabel="總業績"
                primaryValue={commissionTurnoverTotals.rwa_purchase.business}
                secondaryLabel="分潤金額"
                secondaryValue={commissionTurnoverTotals.rwa_purchase.commission}
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.rwa_secondary}
                primaryLabel="總業績"
                primaryValue={commissionTurnoverTotals.rwa_secondary.business}
                secondaryLabel="分潤金額"
                secondaryValue={commissionTurnoverTotals.rwa_secondary.commission}
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.ae_purchase}
                primaryLabel="總業績"
                primaryValue={commissionTurnoverTotals.ae_purchase.business}
                secondaryLabel="分潤金額"
                secondaryValue={commissionTurnoverTotals.ae_purchase.commission}
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.ae_secondary}
                primaryLabel="總業績"
                primaryValue={commissionTurnoverTotals.ae_secondary.business}
                secondaryLabel="分潤金額"
                secondaryValue={commissionTurnoverTotals.ae_secondary.commission}
              />
            </>
          ) : turnoverView === "direct_members" && isMasterAgent ? (
            <>
              <TurnoverCard
                label={TURNOVER_CATEGORY_LABEL.rwa_purchase}
                value={directMemberTotals.rwa_purchase}
              />
              <TurnoverCard
                label={TURNOVER_CATEGORY_LABEL.rwa_secondary}
                value={directMemberTotals.rwa_secondary}
              />
              <TurnoverCard
                label={TURNOVER_CATEGORY_LABEL.ae_purchase}
                value={directMemberTotals.ae_purchase}
              />
              <TurnoverCard
                label={TURNOVER_CATEGORY_LABEL.ae_secondary}
                value={directMemberTotals.ae_secondary}
              />
            </>
          ) : (
            <>
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.rwa_purchase}
                primaryLabel="個人業績"
                primaryValue={turnoverTotals.rwa_purchase}
                secondaryLabel="分潤金額"
                secondaryValue={personalCommissionTotals.rwa_purchase}
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.rwa_secondary}
                primaryLabel="個人業績"
                primaryValue={turnoverTotals.rwa_secondary}
                secondaryLabel="分潤金額"
                secondaryValue={personalCommissionTotals.rwa_secondary}
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.ae_purchase}
                primaryLabel="個人業績"
                primaryValue={turnoverTotals.ae_purchase}
                secondaryLabel="分潤金額"
                secondaryValue={personalCommissionTotals.ae_purchase}
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.ae_secondary}
                primaryLabel="個人業績"
                primaryValue={turnoverTotals.ae_secondary}
                secondaryLabel="分潤金額"
                secondaryValue={personalCommissionTotals.ae_secondary}
              />
            </>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
        <div className="border-b border-slate-800 px-5 py-4">
          <h3 className="font-bold">區間交易明細</h3>
          <p className="mt-1 text-xs text-slate-500">
            顯示分潤明細與投資買賣 · 共 {filteredRows.length} 筆紀錄
          </p>
        </div>
        {error ? (
          <p role="alert" className="p-5 text-sm text-rose-300">{error}</p>
        ) : loading ? (
          <p className="p-5 text-sm text-slate-400">查詢紀錄中…</p>
        ) : filteredRows.length === 0 ? (
          <p className="p-5 text-sm text-slate-500">此篩選條件沒有紀錄。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-6xl text-left text-sm">
              <thead className="bg-slate-950/40 text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-3">來源</th>
                  <th className="px-5 py-3">類型</th>
                  <th className="px-5 py-3">購買人</th>
                  <th className="px-5 py-3">標的物</th>
                  <th className="px-5 py-3">數量</th>
                  <th className="px-5 py-3">交易金額</th>
                  <th className="px-5 py-3">分潤／收支</th>
                  <th className="px-5 py-3">比例／手續費</th>
                  <th className="px-5 py-3">時間</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr key={row.id} className="border-t border-slate-800 align-top">
                    <td className="px-5 py-3">
                      <SourceBadge source={row.source} />
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-slate-300">
                      {row.type}
                    </td>
                    <td className="px-5 py-3 text-slate-300">
                      {row.buyer ?? "本人"}
                    </td>
                    <td className="min-w-44 px-5 py-3 text-slate-400">
                      {row.asset}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-slate-300">
                      {number(row.quantity)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-slate-300">
                      {row.purchaseAmount == null ? "—" : money(row.purchaseAmount)}
                    </td>
                    <td
                      className={`whitespace-nowrap px-5 py-3 font-semibold ${row.amount >= 0 ? "text-emerald-300" : "text-rose-300"}`}
                    >
                      {money(row.amount)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-slate-300">
                      {row.source === "分潤"
                        ? row.rate == null
                          ? "—"
                          : `${(row.rate * 100).toLocaleString("en-US", { maximumFractionDigits: 4 })}%`
                        : money(row.fee ?? 0)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-slate-400">
                      {new Date(row.createdAt).toLocaleString()}
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

function SourceBadge({ source }: { source: DetailRow["source"] }) {
  const isCommission = source === "分潤";
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${
        isCommission
          ? "bg-sky-400/10 text-sky-300"
          : "bg-amber-400/10 text-amber-300"
      }`}
    >
      {source}
    </span>
  );
}

function TurnoverCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <p className="text-xs font-bold tracking-wider text-amber-300">
        {label}
      </p>
      <p className="mt-2 break-all text-lg font-bold text-slate-100">
        {money(value)}
      </p>
    </div>
  );
}

function MetricCard({
  label,
  primaryLabel,
  primaryValue,
  secondaryLabel,
  secondaryValue,
}: {
  label: string;
  primaryLabel: string;
  primaryValue: number;
  secondaryLabel: string;
  secondaryValue: number;
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <p className="text-xs font-bold tracking-wider text-amber-300">
        {label}
      </p>
      <p className="mt-2 text-xs text-slate-500">{primaryLabel}</p>
      <p className="break-all text-lg font-bold text-slate-100">
        {money(primaryValue)}
      </p>
      <p className="mt-2 text-xs text-slate-500">{secondaryLabel}</p>
      <p className="break-all text-lg font-bold text-emerald-300">
        {money(secondaryValue)}
      </p>
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
        active
          ? "bg-amber-400 text-slate-950"
          : "border border-slate-700 text-slate-400 hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-950 p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 break-all font-semibold text-slate-200">{value}</p>
    </div>
  );
}

function DateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-xs font-medium text-slate-400">
      {label}
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm text-slate-200"
      />
    </label>
  );
}
