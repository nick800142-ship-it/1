import { useEffect, useMemo, useState } from "react";
import {
  BadgeDollarSign,
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
type Dashboard = {
  profile: { email: string; agency_role: string; promo_code: string };
  members: Member[];
  commissions: Commission[];
  new_effective_count: number;
  boost_rate: number;
};
const money = (value: number) =>
  `${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;

export function AgentPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [nameQuery, setNameQuery] = useState("");
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
  const commissions = useMemo(
    () =>
      data?.commissions.filter(
        (item) =>
          (!from ||
            new Date(item.created_at) >= new Date(`${from}T00:00:00`)) &&
          (!to || new Date(item.created_at) <= new Date(`${to}T23:59:59`)),
      ) ?? [],
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
      <section>
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <h2 className="text-xl font-bold">會員與代理名單</h2>
          <label className="relative w-full sm:max-w-xs">
            <span className="sr-only">依名稱查詢</span>
            <Search className="absolute left-3 top-3 size-4 text-slate-500" />
            <input
              value={nameQuery}
              onChange={(e) => setNameQuery(e.target.value)}
              placeholder="輸入暱稱、名稱、Email 或 User ID 查詢"
              className="w-full rounded-xl border border-slate-700 bg-slate-950 py-2.5 pl-10 pr-3"
            />
          </label>
        </div>
        <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead>
              <tr className="text-slate-500">
                <Th>會員</Th>
                <Th>角色</Th>
                <Th>本月投資</Th>
                <Th>帳本餘額</Th>
                <Th>手續費</Th>
                <Th>有效狀態</Th>
                <Th>最後登入</Th>
              </tr>
            </thead>
            <tbody>
              {members.map((item) => (
                <tr key={item.id} className="border-t border-slate-800">
                  <Td>
                    <b className="text-slate-200">
                      {item.nickname ||
                        item.display_name ||
                        item.email.split("@")[0]}
                    </b>
                    <br />
                    <span className="text-xs text-slate-400">{item.email}</span>
                    <br />
                    <span className="text-xs">{item.id}</span>
                  </Td>
                  <Td>{item.agency_role}</Td>
                  <Td>{money(item.monthly_investment)}</Td>
                  <Td>{money(item.balance)}</Td>
                  <Td>{money(item.fees)}</Td>
                  <Td>
                    <span
                      className={
                        item.effective ? "text-emerald-300" : "text-slate-500"
                      }
                    >
                      {item.effective ? "有效" : "未達門檻"}
                    </span>
                  </Td>
                  <Td>
                    {item.last_login_at
                      ? new Date(item.last_login_at).toLocaleString()
                      : "—"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
          {members.length === 0 && (
            <p className="p-6 text-center text-sm text-slate-500">
              找不到符合名稱的會員或代理
            </p>
          )}
        </div>
      </section>
      <section>
        <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <h2 className="text-xl font-bold">獎金明細</h2>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="text-xs text-slate-400">
              開始日期
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="mt-1 block rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm text-slate-200"
              />
            </label>
            <label className="text-xs text-slate-400">
              結束日期
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="mt-1 block rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm text-slate-200"
              />
            </label>
            <button
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
        <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="text-slate-500">
                <Th>時間</Th>
                <Th>類型</Th>
                <Th>交易</Th>
                <Th>基礎比例</Th>
                <Th>加碼</Th>
                <Th>獎金</Th>
              </tr>
            </thead>
            <tbody>
              {commissions.map((item) => (
                <tr key={item.id} className="border-t border-slate-800">
                  <Td>{new Date(item.created_at).toLocaleString()}</Td>
                  <Td>{item.bonus_type === "personal" ? "個人" : "團隊"}</Td>
                  <Td>
                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-xs ring-1 ${getCommissionTypeMeta(item.transaction_type).badgeClass}`}
                    >
                      {getCommissionTypeMeta(item.transaction_type).label}
                    </span>
                    <span className="ml-2 whitespace-nowrap">
                      {money(item.transaction_amount)}
                    </span>
                  </Td>
                  <Td>{Number(item.base_rate) * 100}%</Td>
                  <Td>+{Number(item.boost_rate) * 100}%</Td>
                  <Td>
                    <b className="text-amber-200">
                      {money(item.commission_amount)}
                    </b>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
          {commissions.length === 0 && (
            <p className="p-6 text-center text-sm text-slate-500">
              所選時間內沒有獎金明細
            </p>
          )}
        </div>
      </section>
    </div>
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
