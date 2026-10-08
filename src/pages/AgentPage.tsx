import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BadgeDollarSign,
  ChevronDown,
  Copy,
  Network,
  QrCode,
  Search,
  TrendingUp,
  Users,
} from "lucide-react";
import { Modal, Notice } from "@/components/Modal";
import { AnnouncementFeed } from "@/components/AnnouncementFeed";
import { supabase } from "@/lib/supabase";
import { getGenesisRoleLabel } from "@/lib/roleLabels";
import { getCommissionTypeMeta } from "@/lib/commission-types";
import { formatJC, localizedUiText, useLanguage } from "@/platform";
import { getLegacyText } from "@/i18n/legacy";
import QRCode from "qrcode";
import { buildReferralUrl } from "@/lib/referral";
import {
  isTransactionHistoryVisible,
  TRANSACTION_HISTORY_START_LABEL,
} from "@/lib/transactionHistory";

type Member = {
  id: string;
  email: string;
  display_name: string | null;
  nickname: string | null;
  agency_role: string;
  promo_code: string | null;
  referrer_id: string | null;
  parent_id?: string | null;
  master_agent_id: string | null;
  last_login_at: string | null;
  created_at: string;
  monthly_investment: number;
  effective: boolean;
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
  paid_at: string | null;
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
  const { language } = useLanguage();
  const uiText = (languageArg: import("@/platform").Lang, korean: string, fallback: string) => {
    const translated = getLegacyText(languageArg, fallback);
    return translated !== fallback ? translated : localizedUiText(languageArg, korean, fallback);
  };
  const roleLabel = (role: string) => localizedUiText(language, getGenesisRoleLabel(role), getGenesisRoleLabel(role));
  // 代理中心金額與分潤一律以 JC 顯示（沿用 jc_ledger / commission_logs 的 JC 欄位）。
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [referralQrOpen, setReferralQrOpen] = useState(false);
  const [referralUrl, setReferralUrl] = useState("");
  const [qrImage, setQrImage] = useState("");
  const [qrError, setQrError] = useState("");
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
  useEffect(() => {
    if (!referralQrOpen || !referralUrl) return;
    let active = true;
    void QRCode.toDataURL(referralUrl, {
      errorCorrectionLevel: "H",
      margin: 2,
      width: 280,
      color: { dark: "#0f172a", light: "#ffffff" },
    })
      .then((image) => {
        if (active) setQrImage(image);
      })
      .catch(() => {
        if (active) setQrError(uiText(language, "QR 코드 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.", "QR Code 暫時無法產生，請稍後再試。"));
      });
    return () => {
      active = false;
    };
  }, [language, referralQrOpen, referralUrl]);

  const inDateRange = useCallback(
    (createdAt: string) =>
      isTransactionHistoryVisible(createdAt) &&
      (!from || new Date(createdAt) >= new Date(`${from}T00:00:00`)) &&
      (!to || new Date(createdAt) <= new Date(`${to}T23:59:59`)),
    [from, to],
  );
  const commissions = useMemo(
    () =>
      data?.commissions.filter((item) => inDateRange(item.created_at)) ?? [],
    [data, inDateRange],
  );
  const trades = useMemo(
    () => data?.trades?.filter((item) => inDateRange(item.created_at)) ?? [],
    [data, inDateRange],
  );
  const isAgentRole = (role: string) =>
    ["代理", "一代代理", "二代代理", "總代理"].includes(role);
  const allMembers = useMemo(() => data?.members ?? [], [data]);
  const currentMonthStart = useMemo(() => {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }, []);
  const monthlyStatsByMember = useMemo(() => {
    const stats = new Map<string, { investment: number; fees: number }>();
    for (const trade of data?.trades ?? []) {
      const createdAt = new Date(trade.created_at).getTime();
      if (
        !isTransactionHistoryVisible(trade.created_at) ||
        createdAt < currentMonthStart
      ) {
        continue;
      }
      const current = stats.get(trade.user_id) ?? { investment: 0, fees: 0 };
      if (trade.entry_type === "private_purchase" || trade.entry_type === "p2p_buy") {
        current.investment += Math.abs(Number(trade.amount));
      }
      current.fees += Math.abs(Number(trade.fee ?? 0));
      stats.set(trade.user_id, current);
    }
    return stats;
  }, [currentMonthStart, data]);
  const newEffectiveCount = useMemo(() => {
    if (!data) return 0;
    return allMembers.filter((member) => {
      const isCountedForAgent =
        member.referrer_id === data.profile.id ||
        (data.profile.agency_role === "總代理" &&
          member.master_agent_id === data.profile.id);
      return (
        isCountedForAgent &&
        new Date(member.created_at).getTime() >= currentMonthStart &&
        (monthlyStatsByMember.get(member.id)?.investment ?? 0) >= 100
      );
    }).length;
  }, [allMembers, currentMonthStart, data, monthlyStatsByMember]);
  const query = nameQuery.trim().toLowerCase();
  const matches = (member: Member) =>
    `${member.nickname ?? ""} ${member.display_name ?? ""} ${member.email} ${member.id}`
      .toLowerCase()
      .includes(query);
  // Every account is L0. The tree is built only from referral relationships.
  const { agentGroups, directMembers } = useMemo(() => {
    const childrenOf = (parentId: string) =>
      allMembers.filter(
        (member) =>
          member.referrer_id === parentId || member.parent_id === parentId,
      );
    const firstLevel = childrenOf(data?.profile.id ?? "");
    const groups = firstLevel
      .map((member) => ({ agent: member, children: childrenOf(member.id) }))
      .filter((group) => group.children.length > 0);
    const groupedIds = new Set(groups.map((group) => group.agent.id));
    const direct = firstLevel.filter((member) => !groupedIds.has(member.id));
    return { agentGroups: groups, directMembers: direct };
  }, [allMembers, data?.profile.id]);
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
  // 彙總卡一律�� JC 呈現（分潤金額已直接以 JC 記於 commission_logs）。
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
      map.set(data.profile.id, { name: uiText(language, "본인", "本人"), email: data.profile.email });
    }
    return map;
  }, [allMembers, data, language]);
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
    setNotice(uiText(language, "추천 코드가 복사되었습니다.", "推廣碼已複製"));
  };
  const openReferralQr = () => {
    if (!data?.profile.promo_code) return;
    setQrImage("");
    setQrError("");
    setReferralUrl(buildReferralUrl(window.location.origin, data.profile.promo_code));
    setReferralQrOpen(true);
  };
  const copyReferralLink = async () => {
    if (!referralUrl) return;
    await navigator.clipboard.writeText(referralUrl);
    setNotice(uiText(language, "추천 링크가 복사되었습니다.", "推廣連結已複製"));
  };
  const memberRole = (role: string) =>
    roleLabel(["代理", "一代代理", "二代代理", "總代理"].includes(role) ? "代理" : "一般用戶");
  const tradeLabel = (entryType: Trade["entry_type"]) => {
    const labels = {
      private_purchase: uiText(language, "프라이빗 청약", "私��認購"),
      secondary_buy: uiText(language, "2차 시장 매수", "二級買入"),
      secondary_sell: uiText(language, "2차 시장 매도", "二級賣出"),
      p2p_buy: uiText(language, "2차 시장 매수", "二級買入"),
      p2p_sell: uiText(language, "2차 시장 매도", "二級賣出"),
    };
    return labels[entryType];
  };
  if (loading)
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-400">
        {uiText(language, "에이전트 정보를 불러오는 중…", "載入代理資料中…")}
      </div>
    );
  if (!data)
    return <Notice tone="error" message={uiText(language, "에이전트 센터를 불러올 수 없습니다. 계정 권한을 확인해 주세요.", "無法載入代理後台，請確認帳號角色。")} />;
  return (
    <div className="flex flex-col gap-7">
      <AnnouncementFeed />
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold tracking-[.18em] text-amber-300">
            AGENCY NETWORK
          </p>
          <h1 className="mt-2 text-3xl font-bold">{uiText(language, "에이전트 운영 센터", "代理營運中心")}</h1>
          <p className="mt-2 text-sm text-slate-400">
            {roleLabel(data.profile.agency_role)} · {data.profile.email}
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
          <button
            type="button"
            onClick={() => void copy()}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 font-mono font-bold text-amber-200 sm:w-auto"
          >
            <Copy className="size-4" />
            {data.profile.promo_code}
          </button>
          <button
            type="button"
            onClick={openReferralQr}
            className="inline-flex items-center gap-2 self-end rounded-lg px-2 py-1 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/10 hover:text-amber-100"
          >
            <QrCode className="size-4" aria-hidden="true" />
            {uiText(language, "QR 코드 추천", "QR Code 推廣碼")}
          </button>
        </div>
      </header>
      {notice && <Notice tone="success" message={notice} />}
      <div className="space-y-1 text-xs text-slate-500">
        <p>{localizedUiText(language, `실적과 보너스는 ${TRANSACTION_HISTORY_START_LABEL}(타이베이) 이후 데이터만 집계합니다. 이전 원장은 감사 목적으로 보관되며 합계에 포함되지 않습니다.`, `業績與獎金僅統計 ${TRANSACTION_HISTORY_START_LABEL}（台北）後的資料；更早的帳本保留供稽核，不納入彙總。`)}</p>
        <p>{localizedUiText(language, "하위 실적이 있어야 자기 투자 3% 보너스가 잠금 해제됩니다. 2차 시장에서 본인 매매는 보상 대상이 아니며, 직속 상위와 상위 2단계는 각각 13/10000 및 7/10000을 받습니다.", "需具備下線業績方可解鎖自身 3% 認購返利；二級市場自己買賣無反饋，上兩級分別為 13/10000 與 7/10000。")}</p>
        <p>{localizedUiText(language, "일반 투자: 자기 3%, 직속 상위 2%, 상위 2단계 1%. 중간 단계가 없으면 위로 누적하지 않습니다.", "一般投資：自己 3%、直屬上級 2%、上上級 1%；中間層級缺失時不向上累積。")}</p>
        <p>{localizedUiText(language, "2차 시장: 본인 거래는 보상 없음，직속 상위 13/10000，上上級 7/10000，最多兩級。", "二級市場：自己買賣無反饋，直屬上級 13/10000、上上級 7/10000，最多兩級。")}</p>
      </div>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          language={language}
          icon={<Users />}
          label={uiText(language, "팀 회원", "團隊會員")}
          value={String(data.members.length)}
        />
        <Metric
          language={language}
          icon={<TrendingUp />}
          label={uiText(language, "이번 달 신규 유효 회원", "本月新增有效會員")}
          value={String(newEffectiveCount)}
        />
        <Metric
          language={language}
          icon={<BadgeDollarSign />}
          label={uiText(language, "선택 기간 개인 보너스", "篩選期間個人獎金")}
          value={formatJC(totals.personal)}
          hint={
            data.profile.agency_role === "總代理"
              ? uiText(language, "직속 회원과 본인 투자로 발생한 ��미션", "直屬會員與您本人投資帶來的分潤")
              : uiText(language, "본인 투자로 발생한 커미션", "您本人投資帶來的分潤")
          }
          onClick={() => setBonusModal("personal")}
        />
        <Metric
          language={language}
          icon={<Network />}
          label={uiText(language, "선택 기간 팀 보너스", "篩選期間團隊獎金")}
          value={formatJC(totals.team)}
          hint={
            data.profile.agency_role === "總���理"
              ? uiText(language, "에이전트와 하위 일반 회원이 ���생시킨 커미션", "代理及其底下一般用戶帶來的分潤")
              : uiText(language, "하위 일반 회원이 발생시킨 �����션", "底下一般用戶帶來的分潤")
          }
          onClick={() => setBonusModal("team")}
        />
      </section>
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-lg font-bold">{uiText(language, "누적 추가 보너스 진행 상황", "動態加碼進度")}</h2>
        <div className="mt-3 flex items-center justify-between">
          <p className="text-sm text-slate-400">{uiText(language, "현재 적용 중인 추가 보너스 비율", "目前已生效加碼百分點")}</p>
          <b className="text-2xl text-amber-300">
            +{Number(data.boost_rate) * 100}%
          </b>
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-800">
          <div
            className="h-full bg-amber-400"
            style={{
              width: `${Math.min(100, (newEffectiveCount / 5) * 100)}%`,
            }}
          />
        </div>
      </section>
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-xl font-bold">{uiText(language, "회원 거래 및 커미션 내역", "用戶交易與分潤紀錄")}</h2>
            <p className="mt-1 text-sm text-slate-400">
              {uiText(language, "에이전트 또는 일반 회원을 선택하면 상세 내역을 확인할 수 있습니다.", "先選擇代理或一般用戶，再檢視該用戶的詳細紀錄。")}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="relative w-full sm:w-72">
              <span className="sr-only">{uiText(language, "이름으로 검색", "依名稱查詢")}</span>
              <Search className="absolute left-3 top-3 size-4 text-slate-500" />
              <input
                value={nameQuery}
                onChange={(event) => setNameQuery(event.target.value)}
                placeholder={uiText(language, "이름, 이메일 또는 사용자 ID", "名稱、Email 或 User ID")}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 py-2.5 pl-10 pr-3"
              />
            </label>
            <label className="text-xs text-slate-400">
              {uiText(language, "시작일", "開始日期")}
              <input
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                className="mt-1 block rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm text-slate-200"
              />
            </label>
            <label className="text-xs text-slate-400">
              {uiText(language, "종료일", "結束日期")}
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
              {uiText(language, "기간 초기화", "清除時間")}
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
                    badge={uiText(language, "직속 에이전트", "直屬代理")}
                    onOpen={() => setSelectedMemberId(agent.id)}
                  />
                  <span className="ml-auto shrink-0 text-xs text-slate-500">
                    {language === "ko" ? `하위 회원 ${children.length}명` : `${children.length} 位下線`}
                  </span>
                </div>
                {expanded && (
                  <div className="flex flex-col border-t border-slate-800 bg-slate-950/40">
                    {children.length === 0 ? (
                      <p className="px-5 py-4 pl-16 text-sm text-slate-500">
                        {uiText(language, "이 에이전트의 하위 회원이 없습니다.", "此代理目前沒有下線用戶")}
                      </p>
                    ) : (
                      children.map((child) => (
                        <div
                          key={child.id}
                          className="flex items-center gap-3 py-4 pl-16 pr-5"
                        >
                          <MemberIdentity
                            member={child}
                            badge={uiText(language, "일반 회원", "一般用戶")}
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
                badge={uiText(language, "직속 회원", "直屬")}
                onOpen={() => setSelectedMemberId(member.id)}
              />
            </div>
          ))}
          {!hasResults && (
            <p className="p-8 text-center text-sm text-slate-500">
              {uiText(language, "검색 조건에 맞는 회원이 없습니다.", "找不到符合條件的用戶")}
            </p>
          )}
        </div>
      </section>
      <Modal
        open={!!selectedMember}
        onClose={() => setSelectedMemberId(null)}
        title={uiText(language, "회원 상세 내역", "用戶詳細紀錄")}
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
            <div className="grid gap-3 text-sm sm:grid-cols-3">
              <RecordMetric
                label={uiText(language, "이번 달 투자", "本月投資")}
                value={formatJC(monthlyStatsByMember.get(selectedMember.id)?.investment ?? 0)}
              />
              <RecordMetric
                label={uiText(language, "수수료", "手續費")}
                value={formatJC(monthlyStatsByMember.get(selectedMember.id)?.fees ?? 0)}
              />
              <RecordMetric
                label={uiText(language, "회원 상태", "會員狀態")}
                value={
                  (monthlyStatsByMember.get(selectedMember.id)?.investment ?? 0) >= 100
                    ? uiText(language, "유효", "有效")
                    : uiText(language, "기준 미달", "未達門檻")
                }
              />
            </div>
            <RecordTable
              title={uiText(language, "거래 내역", "交易紀錄")}
              empty={uiText(language, "선택한 기간에 거래 내역이 없습니다.", "所選時間內沒有交易紀錄")}
              headers={[uiText(language, "시간", "時間"), uiText(language, "유형", "類型"), uiText(language, "자산", "標的"), uiText(language, "수량", "份額"), uiText(language, "거래 금액", "交易金額"), uiText(language, "수수료", "手續費")]}
            >
              {trades
                .filter(
                  (trade) =>
                    trade.user_id === selectedMember.id &&
                    isTransactionHistoryVisible(trade.created_at),
                )
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
              title={uiText(language, "커미션 내���", "分潤紀錄")}
              empty={uiText(language, "선택한 기간에 이 회원으로 인해 발생한 커미션이 ���습니다.", "所選時間內沒有因該用戶產生的分潤紀錄")}
              headers={[uiText(language, "시간", "時間"), uiText(language, "보너스 유형", "獎金類型"), uiText(language, "거래 유형", "交易類型"), uiText(language, "거래 금액", "交易金額"), uiText(language, "비율", "比例"), uiText(language, "보너스", "獎金"), uiText(language, "지급 상태", "發放狀態")]}
            >
              {commissions
                .filter(
                  (commission) =>
                  commission.buyer_id === selectedMember.id &&
                  isTransactionHistoryVisible(commission.created_at),
                )
                .map((commission) => (
                  <tr key={commission.id} className="border-t border-slate-800">
                    <Td>{new Date(commission.created_at).toLocaleString()}</Td>
                    <Td>
                      {commission.bonus_type === "personal" ? uiText(language, "개인", "個人") : uiText(language, "팀", "團隊")}
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
                    <Td>
                      <PayoutStatus paidAt={commission.paid_at} language={language} />
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
        title={bonusModal === "team" ? uiText(language, "팀 보너스 커미션 내역", "團隊獎金分潤紀錄") : uiText(language, "개인 보너스 커미션 내역", "個人獎金分潤紀錄")}
        wide
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-400">
              {bonusModal === "team"
                ? uiText(language, "에이전트와 하위 일반 회원의 주문으로 발생한 커미션", "代理及其底下一般用戶下單所產生的分潤")
                : data.profile.agency_role === "總代理"
                  ? uiText(language, "본인과 직속 회원의 주문으로 발생한 커미션", "您本人與直屬會員下單所產生的分潤")
                  : uiText(language, "본인 투자 주문으로 발생한 커미션", "您本人投資下單所產生的分潤")}
            </p>
            <span className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-sm font-bold text-amber-200">
              {uiText(language, "합계", "合計")} {" "}
              {formatJC(bonusModal === "team" ? totals.team : totals.personal)}
            </span>
          </div>
          <RecordTable
            title={uiText(language, "커미션 상세 내역", "分潤明細")}
            empty={uiText(language, "선택한 기간에 커미션 내역이 없습니다.", "所選時間內沒有分潤紀錄")}
            headers={[uiText(language, "시간", "時間"), uiText(language, "주문 회원", "下單用戶"), uiText(language, "거래 유형", "交易類型"), uiText(language, "거래 금액", "交易金額"), uiText(language, "비율", "比例"), uiText(language, "보너스", "獎金"), uiText(language, "지급 상태", "發放狀態")]}
          >
            {bonusCommissions
              .filter((commission) => isTransactionHistoryVisible(commission.created_at))
              .map((commission) => {
              const buyer = memberById.get(commission.buyer_id);
              return (
                <tr key={commission.id} className="border-t border-slate-800">
                  <Td>{new Date(commission.created_at).toLocaleString()}</Td>
                  <Td>
                    <span className="block text-slate-200">
                      {buyer?.name ?? uiText(language, "알 수 없는 회원", "未知用戶")}
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
                  <Td>
                    <PayoutStatus paidAt={commission.paid_at} language={language} />
                  </Td>
                </tr>
              );
            })}
          </RecordTable>
        </div>
      </Modal>
      <Modal
        open={referralQrOpen}
        onClose={() => setReferralQrOpen(false)}
        title={uiText(language, "QR 코드 추천", "QR Code 推廣碼")}
      >
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="max-w-md text-sm leading-6 text-slate-300">
            {uiText(language, "QR 코드를 스캔하면 웹사이트 로그인/가입 화면이 열립니다. 로그인 후 추천 코드가 ���정에 자동 연결되고 추천 관계가 설정됩니다.", "掃描 QR Code 後會開啟網站登入／註冊畫面。用戶完成登入後，系統會自動將此推廣碼綁定至帳號並建立代理層級。")}
          </p>
          <div className="flex min-h-72 min-w-72 items-center justify-center rounded-2xl border border-slate-700 bg-white p-4">
            {qrImage ? (
              <img
                src={qrImage}
                alt={uiText(language, "전용 추천 로그인 링크 QR 코드", "專屬推廣登入連結 QR Code")}
                className="size-64 max-w-full"
              />
            ) : qrError ? (
              <p role="alert" className="text-sm text-red-600">{qrError}</p>
            ) : (
              <p role="status" className="text-sm text-slate-600">{uiText(language, "QR 코드를 생성하는 중…", "正在產生 QR Code…")}</p>
            )}
          </div>
          <div className="w-full rounded-xl border border-slate-700 bg-slate-950/60 p-3 text-left">
            <p className="mb-1 text-xs font-semibold text-slate-400">{uiText(language, "전용 추천 링크", "專屬推廣連結")}</p>
            <p className="break-all font-mono text-xs leading-5 text-slate-200">{referralUrl}</p>
          </div>
          <button
            type="button"
            onClick={() => void copyReferralLink()}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/20"
          >
            <Copy className="size-4" aria-hidden="true" />
            {uiText(language, "추천 링크 복사", "複製推廣連結")}
          </button>
        </div>
      </Modal>
    </div>
  );
}
// 逐筆分潤的派發狀態徽章。paid_at 不為 null 代表已由平台熱錢包上鏈發放到受益人錢包。
function PayoutStatus({ paidAt, language }: { paidAt: string | null; language: import("@/platform").Lang }) {
  const uiText = (languageArg: import("@/platform").Lang, korean: string, fallback: string) => {
    const translated = getLegacyText(languageArg, fallback);
    return translated !== fallback ? translated : localizedUiText(languageArg, korean, fallback);
  };
  if (paidAt) {
    return (
      <span
        className="inline-flex items-center rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-300 ring-1 ring-emerald-500/20"
        title={uiText(language, `${new Date(paidAt).toLocaleString(language)} 온체인 지급 완료`, `已於 ${new Date(paidAt).toLocaleString(language)} 上鏈發放`)}
      >
        {uiText(language, "지급 완료", "已發放")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-300 ring-1 ring-amber-500/20">
      {uiText(language, "지급 대기", "待發放")}
    </span>
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
  language,
}: {
  icon: React.ReactNode;
  language: import("@/platform").Lang;
  label: string;
  value: string;
  hint?: string;
  onClick?: () => void;
}) {
  const uiText = (languageArg: import("@/platform").Lang, korean: string, fallback: string) => {
    const translated = getLegacyText(languageArg, fallback);
    return translated !== fallback ? translated : localizedUiText(languageArg, korean, fallback);
  };
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
          {uiText(language, "커미션 내역 보기 →", "點擊查看分潤紀錄 →")}
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
