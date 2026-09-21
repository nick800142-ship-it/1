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
import { Modal, Notice } from "@/components/Modal";
import { AnnouncementFeed } from "@/components/AnnouncementFeed";
import { supabase } from "@/lib/supabase";
import { getCommissionTypeMeta } from "@/lib/commission-types";
import { formatJC } from "@/platform";

type Member = {
  id: string;
  email: string;
  display_name: string | null;
  nickname: string | null;
  agency_role: string;
  promo_code: string | null;
  referrer_id: string | null;
  master_agent_id: string | null;
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
  // 代理中心金額與分潤一律以 JC 顯示（沿用 jc_ledger / commission_logs 的 JC 欄位）。
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [nameQuery, setNameQuery] = useState("");
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [bonusModal, setBonusModal] = useState<"personal" | "team" | null>(null);
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
  const isAgentRole = (role: string) =>
    ["代理", "一代代理", "二代代理", "總代理"].includes(role);
  const allMembers = useMemo(() => data?.members ?? [], [data]);
  const query = nameQuery.trim().toLowerCase();
  const matches = (member: Member) =>
    `${member.nickname ?? ""} ${member.display_name ?? ""} ${member.email} ${member.id}`
      .toLowerCase()
      .includes(query);
  // Build a two-level tree: direct agents (直屬代理) with their downline
  // members nested underneath, plus 直屬 members referred straight by me.
  const { agentGroups, directMembers } = useMemo(() => {
    const meId = data?.profile.id;
    const agents = allMembers.filter((m) => isAgentRole(m.agency_role));
    const agentIds = new Set(agents.map((a) => a.id));
    const groups = agents.map((agent) => ({
      agent,
      children: allMembers.filter(
        (m) => !isAgentRole(m.agency_role) && m.referrer_id === agent.id,
      ),
    }));
    const direct = allMembers.filter(
      (m) =>
        !isAgentRole(m.agency_role) &&
        !(m.referrer_id && agentIds.has(m.referrer_id)),
    );
    return { agentGroups: groups, directMembers: direct };
  }, [allMembers, data]);
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
  const selectedMember =
    allMembers.find((m) => m.id === selectedMemberId) ?? null;
  // 彙總卡一律以 JC 呈現（分潤金額已直接以 JC 記於 commission_logs）。
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
      map.set(data.profile.id, { name: "本人", email: data.profile.email });
    }
    return map;
  }, [allMembers, data]);
  // Commission records for the currently opened bonus card, newest first.
  const bonusCommissions = useMemo(() => {
    if (!bonusModal) return [];
    return commissions
      .filter((commission) => commission.bonus_type === bonusModal)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }, [commissions, bonusModal]);
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
      p2p_buy: "二級買入",
      p2p_sell: "二級賣出",
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
          value={formatJC(totals.personal)}
          hint={
            data.profile.agency_role === "總代理"
              ? "直屬會員與您本人投資帶來的分潤"
              : "您本人投資帶來的分潤"
          }
          onClick={() => setBonusModal("personal")}
        />
        <Metric
          icon={<Network />}
          label="篩選期間團隊獎金"
          value={formatJC(totals.team)}
          hint={
            data.profile.agency_role === "總代理"
              ? "代理及其底下一般用戶帶來的分潤"
              : "底下一般用戶帶來的分潤"
          }
          onClick={() => setBonusModal("team")}
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
                    badge="直屬代理"
                    onOpen={() => setSelectedMemberId(agent.id)}
                  />
                  <span className="ml-auto shrink-0 text-xs text-slate-500">
                    {children.length} 位下線
                  </span>
                </div>
                {expanded && (
                  <div className="flex flex-col border-t border-slate-800 bg-slate-950/40">
                    {children.length === 0 ? (
                      <p className="px-5 py-4 pl-16 text-sm text-slate-500">
                        此代理目前沒有下線用戶
                      </p>
                    ) : (
                      children.map((child) => (
                        <div
                          key={child.id}
                          className="flex items-center gap-3 py-4 pl-16 pr-5"
                        >
                          <MemberIdentity
                            member={child}
                            badge="一般用戶"
                            onOpen={() => setSelectedMemberId(child.id)}
                          />
                        </div>
                      ))
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
                badge="直屬"
                onOpen={() => setSelectedMemberId(member.id)}
              />
            </div>
          ))}
          {!hasResults && (
            <p className="p-8 text-center text-sm text-slate-500">
              找不到符合名稱的代理或一般用戶
            </p>
          )}
        </div>
      </section>
      <Modal
        open={!!selectedMember}
        onClose={() => setSelectedMemberId(null)}
        title="用戶詳細紀錄"
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
            <div className="grid gap-3 text-sm sm:grid-cols-4">
              <RecordMetric
                label="本月投資"
                value={formatJC(selectedMember.monthly_investment)}
              />
              <RecordMetric
                label="JC 餘額"
                value={formatJC(selectedMember.balance)}
              />
              <RecordMetric label="手續費" value={formatJC(selectedMember.fees)} />
              <RecordMetric
                label="會員狀態"
                value={selectedMember.effective ? "有效" : "未���門檻"}
              />
            </div>
            <RecordTable
              title="交易紀錄"
              empty="所選時間內沒有交易紀錄"
              headers={["時間", "類型", "標的", "份額", "交易金額", "手續費"]}
            >
              {trades
                .filter((trade) => trade.user_id === selectedMember.id)
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
              {commissions
                .filter(
                  (commission) => commission.buyer_id === selectedMember.id,
                )
                .map((commission) => (
                  <tr key={commission.id} className="border-t border-slate-800">
                    <Td>{new Date(commission.created_at).toLocaleString()}</Td>
                    <Td>
                      {commission.bonus_type === "personal" ? "個人" : "團隊"}
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
                  </tr>
                ))}
            </RecordTable>
          </div>
        )}
      </Modal>
      <Modal
        open={!!bonusModal}
        onClose={() => setBonusModal(null)}
        title={bonusModal === "team" ? "團隊獎金分潤紀錄" : "個人獎金分潤紀錄"}
        wide
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-400">
              {bonusModal === "team"
                ? "代理及其底下一般用戶下單所產生的分潤"
                : data.profile.agency_role === "總代理"
                  ? "您本人與直屬會員下單所產生的分潤"
                  : "您本人投資下單所產生的分潤"}
            </p>
            <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-sm font-bold text-amber-200">
              合計{" "}
              {formatJC(bonusModal === "team" ? totals.team : totals.personal)}
            </span>
          </div>
          <RecordTable
            title="分潤明細"
            empty="所選時間內沒有分潤紀錄"
            headers={["時間", "下單用戶", "交易類型", "交易金額", "比例", "獎金"]}
          >
            {bonusCommissions.map((commission) => {
              const buyer = memberById.get(commission.buyer_id);
              return (
                <tr key={commission.id} className="border-t border-slate-800">
                  <Td>{new Date(commission.created_at).toLocaleString()}</Td>
                  <Td>
                    <span className="block text-slate-200">
                      {buyer?.name ?? "未知用戶"}
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
                </tr>
              );
            })}
          </RecordTable>
        </div>
      </Modal>
    </div>
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
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  onClick?: () => void;
}) {
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
          點擊查看分潤紀錄 →
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
