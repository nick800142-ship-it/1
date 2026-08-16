import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CalendarDays } from "lucide-react";
import { supabase } from "@/lib/supabase";

type Profile = {
  id: string;
  email: string;
  display_name: string | null;
  nickname: string | null;
  agency_role: string | null;
};

const transactionTypeLabel: Record<string, string> = {
  private_purchase: "私募認購",
  private_buy: "私募認購",
  secondary_buy: "二級市場買入",
  secondary_sell: "二級市場賣出",
  commission: "代理分潤",
  commission_payout: "代理分潤",
};

type DetailRow = {
  id: string;
  source: "帳本" | "分潤";
  type: string;
  amount: number;
  fee: number;
  asset: string;
  createdAt: string;
};

export function UserDetailView({
  userId,
  onBack,
}: {
  userId: string;
  onBack: () => void;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [balance, setBalance] = useState(0);
  const [rows, setRows] = useState<DetailRow[]>([]);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");

    let commissionQuery = supabase
      .from("commission_logs")
      .select("id,transaction_type,commission_amount,asset_id,created_at")
      .eq("beneficiary_id", userId)
      .order("created_at", { ascending: false });

    if (startDate) {
      const start = new Date(`${startDate}T00:00:00`).toISOString();
      commissionQuery = commissionQuery.gte("created_at", start);
    }
    if (endDate) {
      const nextDay = new Date(`${endDate}T00:00:00`);
      nextDay.setDate(nextDay.getDate() + 1);
      const end = nextDay.toISOString();
      commissionQuery = commissionQuery.lt("created_at", end);
    }

    const [profileResult, balanceResult, commissionResult, assetsResult] =
      await Promise.all([
        supabase
          .from("profiles")
          .select("id,email,display_name,nickname,agency_role")
          .eq("id", userId)
          .maybeSingle(),
        supabase.from("asset_ledger").select("amount").eq("user_id", userId),
        commissionQuery,
        supabase.from("private_placements").select("id,name"),
      ]);

    const firstError =
      profileResult.error ??
      balanceResult.error ??
      commissionResult.error ??
      assetsResult.error;
    if (firstError) {
      setError("無法載入用戶紀錄，請稍後再試。");
      setLoading(false);
      return;
    }

    setProfile(profileResult.data as Profile | null);
    setBalance(
      (balanceResult.data ?? [])
        .filter((row) => row.amount !== null)
        .reduce((sum, row) => sum + Number(row.amount), 0),
    );
    const assetNames = new Map(
      (assetsResult.data ?? []).map((asset) => [asset.id, asset.name]),
    );
    setRows(
      (commissionResult.data ?? [])
        .map((row) => ({
          id: `commission-${row.id}`,
          source: "分潤" as const,
          type: transactionTypeLabel[row.transaction_type] ?? "代理分潤",
          amount: Number(row.commission_amount),
          fee: 0,
          asset: assetNames.get(row.asset_id) ?? "代理分潤",
          createdAt: row.created_at,
        }))
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        ),
    );
    setLoading(false);
  }, [endDate, startDate, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="flex flex-col gap-5">
      <button
        type="button"
        onClick={onBack}
        className="flex w-fit items-center gap-2 rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-300 hover:border-amber-400 hover:text-amber-200"
      >
        <ArrowLeft className="size-4" />
        返回
      </button>

      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <p className="text-xs font-bold tracking-wider text-amber-300">
          用戶名稱
        </p>
        <h2 className="mt-2 break-all text-xl font-bold text-slate-100">
          {profile?.nickname ||
            profile?.display_name ||
            profile?.email?.split("@")[0] ||
            "載入用戶資料中…"}
        </h2>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <Info label="Email" value={profile?.email ?? "—"} />
          <Info label="目前餘額" value={`${balance.toFixed(2)} USDT`} />
          <Info label="代理身分" value={profile?.agency_role || "一般用戶"} />
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-center gap-3">
          <CalendarDays className="size-5 text-amber-300" />
          <div>
            <h3 className="font-bold">時間篩選引擎</h3>
            <p className="text-xs text-slate-500">
              日期區間包含開始日與結束日。
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <DateInput
            label="開始日期"
            value={startDate}
            onChange={setStartDate}
          />
          <DateInput label="結束日期" value={endDate} onChange={setEndDate} />
        </div>
        {(startDate || endDate) && (
          <button
            type="button"
            onClick={() => {
              setStartDate("");
              setEndDate("");
            }}
            className="mt-3 text-xs font-semibold text-amber-300 hover:text-amber-200"
          >
            清除日期
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
        <div className="border-b border-slate-800 px-5 py-4">
          <h3 className="font-bold">區間交易明細</h3>
          <p className="mt-1 text-xs text-slate-500">
            僅顯示分潤明細 · 共 {rows.length} 筆紀錄
          </p>
        </div>
        {error ? (
          <p role="alert" className="p-5 text-sm text-rose-300">
            {error}
          </p>
        ) : loading ? (
          <p className="p-5 text-sm text-slate-400">查詢紀錄中…</p>
        ) : rows.length === 0 ? (
          <p className="p-5 text-sm text-slate-500">此區間沒有交易紀錄。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-3xl text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-3">來源</th>
                  <th className="px-5 py-3">類型</th>
                  <th className="px-5 py-3">金額</th>
                  <th className="px-5 py-3">手續費</th>
                  <th className="px-5 py-3">資產</th>
                  <th className="px-5 py-3">時間</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t border-slate-800">
                    <td className="px-5 py-3">
                      <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs text-slate-300">
                        {row.source}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-slate-300">{row.type}</td>
                    <td
                      className={`px-5 py-3 font-semibold ${row.amount >= 0 ? "text-emerald-300" : "text-rose-300"}`}
                    >
                      {row.amount.toFixed(2)} USDT
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-slate-300">
                      {row.fee.toFixed(2)} USDT
                    </td>
                    <td className="px-5 py-3 text-slate-400">{row.asset}</td>
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
