import { useEffect, useMemo, useState } from "react";
import {
  BadgeDollarSign,
  ChevronDown,
  Copy,
  Network,
  Search,
  TrendingUp,
  Users,
} from "lucide-react";
import { Notice } from "@/components/Modal";
import { AnnouncementFeed } from "@/components/AnnouncementFeed";
import { supabase } from "@/lib/supabase";
import { getCommissionTypeMeta } from "@/lib/commission-types";
import { interfaceText, useLanguage } from "@/platform";

type Member = {
  id: string;
  email: string;
  display_name: string | null;
  nickname: string | null;
  agency_role: string;
  promo_code: string | null;
  last_login_at: string | null;
  created_at: string;
  monthly_investment: number;
  effective: boolean;
  balance: number;
  fees: number;
};
type Commission = {
  id: string;
  buyer_id: string;
  asset_id: string;
  transaction_type: string;
  transaction_amount: number;
  bonus_type: "personal" | "team";
  base_rate: number;
  boost_rate: number;
  effective_rate: number;
  commission_amount: number;
  created_at: string;
};
type Trade = {
  id: string;
  user_id: string;
  entry_type: "private_purchase" | "secondary_buy" | "secondary_sell";
  asset_id: string;
  quantity: number;
  amount: number;
  gross: number;
  fee: number;
  created_at: string;
};
type Dashboard = {
  profile: { email: string; agency_role: string; promo_code: string };
  members: Member[];
  commissions: Commission[];
  trades: Trade[];
  new_effective_count: number;
  boost_rate: number;
};
const money = (value: number) =>
  `${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;

export function AgentPage() {
  const { language } = useLanguage();
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [nameQuery, setNameQuery] = useState("");
  const [expandedMemberId, setExpandedMemberId] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([
      supabase.rpc("get_agent_dashboard"),
      supabase.rpc("touch_last_login"),
    ]).then(([result]) => {
      if (active) {
        setData(result.data as Dashboard);
        setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, []);
  const inDateRange = (createdAt: string) =>
    (!from || new Date(createdAt) >= new Date(`${from}T00:00:00`)) &&
    (!to || new Date(createdAt) <= new Date(`${to}T23:59:59`));
  const commissions = useMemo(
    () =>
      data?.commissions.filter((item) => inDateRange(item.created_at)) ?? [],
    [data, from, to],
  );
  const trades = useMemo(
    () => data?.trades?.filter((item) => inDateRange(item.created_at)) ?? [],
    [data, from, to],
  );
  const members = useMemo(
    () =>
      data?.members.filter((item) =>
        `${item.nickname ?? ""} ${item.display_name ?? ""} ${item.email} ${item.id}`
          .toLowerCase()
          .includes(nameQuery.trim().toLowerCase()),
      ) ?? [],
    [data, nameQuery],
  );
  const totals = useMemo(
    () => ({
      personal: commissions
        .filter((x) => x.bonus_type === "personal")
        .reduce((s, x) => s + Number(x.commission_amount), 0),
      team: commissions
        .filter((x) => x.bonus_type === "team")
        .reduce((s, x) => s + Number(x.commission_amount), 0),
    }),
    [commissions],
  );
  const copy = async () => {
    if (!data?.profile.promo_code) return;
    await navigator.clipboard.writeText(data.profile.promo_code);
    setNotice("推廣碼已複製");
  };
  const memberRole = (role: string) =>
    ["代理", "一代代理", "二代代理", "總代理"].includes(role)
      ? "代理"
      : "一般用戶";
  const tradeLabel = (entryType: Trade["entry_type"]) =>
    ({
      private_purchase: "私募認購",
      secondary_buy: "二級買入",
      secondary_sell: "二級賣出",
    })[entryType];
  if (loading)
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-400">
        載入代理資料中…
      </div>
    );
  if (!data)
    return <Notice tone="error" message="無法載入代理後台，請確認帳號角色。" />;
  return (
    <div className="flex flex-col gap-7">
      <AnnouncementFeed />
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold tracking-[.18em] text-amber-300">
            AGENCY NETWORK
          </p>
          <h1 className="mt-2 text-3xl font-bold">代理營運中心</h1>
          <p className="mt-2 text-sm text-slate-400">
            {data.profile.agency_role} · {data.profile.email}
          </p>
        </div>
        <button
          onClick={() => void copy()}
          className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 font-mono font-bold text-amber-200"
        >
          <Copy className="size-4" />
          {data.profile.promo_code}
        </button>
      </header>
      {notice && <Notice tone="success" message={notice} />}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          icon={<Users />}
          label="團隊會員"
          value={String(data.members.length)}
        />
        <Metric
          icon={<TrendingUp />}
          label="本月新增有效會員"
          value={String(data.new_effective_count)}
        />
        <Metric
          icon={<BadgeDollarSign />}
          label="篩選期間個人獎金"
          value={money(totals.personal)}
        />
        <Metric
          icon={<Network />}
          label="篩選期間團隊獎金"
          value={money(totals.team)}
        />
      </section>
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-lg font-bold">動態加碼進度</h2>
        <div className="mt-3 flex items-center justify-between">
          <p className="text-sm text-slate-400">目前已生效加碼百分點</p>
          <b className="text-2xl text-amber-300">
            +{Number(data.boost_rate) * 100}%
          </b>
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-800">
          <div
            className="h-full bg-amber-400"
            style={{
              width: `${Math.min(100, (Number(data.new_effective_count) / 5) * 100)}%`,
            }}
          />
        </div>
      </section>
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-xl font-bold">用戶交易與分潤紀錄</h2>
            <p className="mt-1 text-sm text-slate-400">
              先選擇代理或一般用戶，再檢視該用戶的詳細紀錄。
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="relative w-full sm:w-72">
              <span className="sr-only">依名稱查詢</span>
              <Search className="absolute left-3 top-3 size-4 text-slate-500" />
              <input
                value={nameQuery}
                onChange={(event) => setNameQuery(event.target.value)}
                placeholder="名稱、Email 或 User ID"
                className="w-full rounded-xl border border-slate-700 bg-slate-950 py-2.5 pl-10 pr-3"
              />
            </label>
            <label className="text-xs text-slate-400">
              開始日期
              <input
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                className="mt-1 block rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm text-slate-200"
              />
            </label>
            <label className="text-xs text-slate-400">
              結束日期
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
              清除時間
            </button>
          </div>
        </div>
        <div className="flex flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
          {members.map((member) => {
            const expanded = expandedMemberId === member.id;
            const memberTrades = trades.filter(
              (trade) => trade.user_id === member.id,
            );
            const memberCommissions = commissions.filter(
              (commission) => commission.buyer_id === member.id,
            );
            return (
              <article
                key={member.id}
                className="border-b border-slate-800 last:border-b-0"
              >
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={`member-records-${member.id}`}
                  onClick={() =>
                    setExpandedMemberId(expanded ? null : member.id)
                  }
                  className="flex w-full flex-col gap-4 p-5 text-left hover:bg-slate-800/40 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-400 font-bold text-slate-950">
                      {(member.nickname ||
                        member.display_name ||
                        member.email)[0].toUpperCase()}
                    </span>
                    <span className="min-w-0">
                      <b className="block truncate text-slate-100">
                        {member.nickname ||
                          member.display_name ||
                          member.email.split("@")[0]}
                      </b>
                      <span className="block truncate text-xs text-slate-400">
                        {member.email}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-full border border-slate-700 px-2.5 py-1 text-xs text-slate-300">
                      {memberRole(member.agency_role)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-5 sm:justify-end">
                    <span className="text-xs text-slate-500">
                      {memberTrades.length} 筆交易 · {memberCommissions.length}{" "}
                      筆分潤
                    </span>
                    <ChevronDown
                      className={`size-5 text-amber-300 transition-transform ${expanded ? "rotate-180" : ""}`}
                    />
                  </div>
                </button>
                {expanded && (
                  <div
                    id={`member-records-${member.id}`}
                    className="flex flex-col gap-5 border-t border-slate-800 bg-slate-950/40 p-5"
                  >
                    <div className="grid gap-3 text-sm sm:grid-cols-4">
                      <RecordMetric
                        label="本月投資"
                        value={money(member.monthly_investment)}
                      />
                      <RecordMetric
                        label="帳本餘額"
                        value={money(member.balance)}
                      />
                      <RecordMetric label="手續費" value={money(member.fees)} />
                      <RecordMetric
                        label="會員狀態"
                        value={member.effective ? "有效" : "未達門檻"}
                      />
                    </div>
                    <RecordTable
                      title="交易紀錄"
                      empty="所選時間內沒有交易紀錄"
                      headers={[
                        "時間",
                        "類型",
                        "標的",
                        "份額",
                        "交易金額",
                        "手續費",
                      ]}
                    >
                      {memberTrades.map((trade) => (
                        <tr
                          key={trade.id}
                          className="border-t border-slate-800"
                        >
                          <Td>{new Date(trade.created_at).toLocaleString()}</Td>
                          <Td>{tradeLabel(trade.entry_type)}</Td>
                          <Td>{trade.asset_id}</Td>
                          <Td>{Number(trade.quantity).toLocaleString()}</Td>
                          <Td>{money(trade.gross)}</Td>
                          <Td>{money(trade.fee)}</Td>
                        </tr>
                      ))}
                    </RecordTable>
                    <RecordTable
                      title="分潤紀錄"
                      empty="所選時間內沒有因該用戶產生的分潤紀錄"
                      headers={[
                        "時間",
                        "獎金類型",
                        "交易類型",
                        "交易金額",
                        "比例",
                        "獎金",
                      ]}
                    >
                      {memberCommissions.map((commission) => (
                        <tr
                          key={commission.id}
                          className="border-t border-slate-800"
                        >
                          <Td>
                            {new Date(commission.created_at).toLocaleString()}
                          </Td>
                          <Td>
                            {commission.bonus_type === "personal"
                              ? "個人"
                              : "團隊"}
                          </Td>
                          <Td>
                            {
                              getCommissionTypeMeta(commission.transaction_type)
                                .label
                            }
                          </Td>
                          <Td>{money(commission.transaction_amount)}</Td>
                          <Td>{Number(commission.effective_rate) * 100}%</Td>
                          <Td>
                            <b className="text-amber-200">
                              {money(commission.commission_amount)}
                            </b>
                          </Td>
                        </tr>
                      ))}
                    </RecordTable>
                  </div>
                )}
              </article>
            );
          })}
          {members.length === 0 && (
            <p className="p-8 text-center text-sm text-slate-500">
              找不到符合名稱的代理或一般用戶
            </p>
          )}
        </div>
      </section>
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
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <span className="text-amber-300">{icon}</span>
      <p className="mt-4 text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-bold">{value}</p>
    </div>
  );
}
function Th({ children }: { children: React.ReactNode }) {
  return <th className="border-b border-slate-800 px-5 py-3">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-5 py-4 text-slate-400">{children}</td>;
}
