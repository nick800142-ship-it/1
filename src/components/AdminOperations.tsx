import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Bell, CheckCircle2, Coins, Send, X } from "lucide-react";
import { Notice } from "@/components/Modal";
import { CommissionOverrides } from "@/components/CommissionOverrides";
import {
  CommissionDateReport,
  downloadCsv,
  isWithinDateRange,
} from "@/components/CommissionDateReport";
import { supabase } from "@/lib/supabase";
import { translateAdminContent } from "@/lib/translate";
import { type Lang } from "@/platform";

type AnnouncementTranslation = { title: string; content: string };
type Announcement = {
  id: string;
  title: string;
  content: string;
  translations?: Partial<Record<Lang, AnnouncementTranslation>>;
  is_active: boolean;
  created_at: string;
};
type Setting = {
  agency_role: string;
  private_rate: number;
  secondary_rate: number;
  updated_at: string;
};
type Profile = {
  id: string;
  email: string;
  agency_role: string;
  parent_id: string | null;
  referrer_id: string | null;
  master_agent_id: string | null;
};
type Commission = {
  id: string;
  beneficiary_id: string;
  transaction_type: "private" | "secondary";
  commission_amount: number;
  paid_at: string | null;
  created_at: string;
};
type Batch = {
  id: string;
  scope: string;
  role_filter: string | null;
  recipient_count: number;
  total_amount: number;
  created_at: string;
};
const money = (value: number) =>
  `${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;

export function AdminOperations() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [showAnnouncementHistory, setShowAnnouncementHistory] = useState(false);
  const [settings, setSettings] = useState<Setting[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [commissions, setCommissions] = useState<Commission[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [expandedMasters, setExpandedMasters] = useState<string[]>([]);
  const [expandedAgents, setExpandedAgents] = useState<string[]>([]);
  const [reportStartDate, setReportStartDate] = useState("");
  const [reportEndDate, setReportEndDate] = useState("");
  const [payoutQuery, setPayoutQuery] = useState("");
  const [showAllBatches, setShowAllBatches] = useState(false);
  const emptyAnnouncement = (): AnnouncementTranslation => ({ title: "", content: "" });
  const [announcementDraft, setAnnouncementDraft] = useState(emptyAnnouncement);
  const updateAnnouncementDraft = (
    field: keyof AnnouncementTranslation,
    value: string,
  ) => setAnnouncementDraft((current) => ({ ...current, [field]: value }));
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const [a, s, p, c, b] = await Promise.all([
      supabase
        .from("platform_announcements")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase.from("commission_settings").select("*"),
      supabase
        .from("profiles")
        .select("id,email,agency_role,parent_id,referrer_id,master_agent_id"),
      supabase
        .from("commission_logs")
        .select(
          "id,beneficiary_id,transaction_type,commission_amount,paid_at,created_at",
        )
        .order("created_at", { ascending: false }),
      supabase
        .from("commission_payout_batches")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(10),
    ]);
    setAnnouncements((a.data ?? []) as Announcement[]);
    setSettings((s.data ?? []) as Setting[]);
    setProfiles((p.data ?? []) as Profile[]);
    setCommissions((c.data ?? []) as Commission[]);
    setBatches((b.data ?? []) as Batch[]);
  };
  useEffect(() => {
    void load();
  }, []);
  const pending = useMemo(
    () =>
      profiles.map((profile) => {
        const userCommissions = commissions.filter(
          (commission) => commission.beneficiary_id === profile.id,
        );
        const privateAmount = userCommissions
          .filter(
            (commission) =>
              !commission.paid_at && commission.transaction_type === "private",
          )
          .reduce(
            (sum, commission) => sum + Number(commission.commission_amount),
            0,
          );
        const secondaryAmount = userCommissions
          .filter(
            (commission) =>
              !commission.paid_at &&
              commission.transaction_type === "secondary",
          )
          .reduce(
            (sum, commission) => sum + Number(commission.commission_amount),
            0,
          );
        return {
          ...profile,
          privateAmount,
          secondaryAmount,
          amount: privateAmount + secondaryAmount,
          lastPaid:
            userCommissions.find((commission) => commission.paid_at)?.paid_at ??
            null,
        };
      }),
    [profiles, commissions],
  );
  const masters = pending.filter((profile) => profile.agency_role === "總代理");
  const isAgentRole = (role: string) =>
    role !== "總代理" && role.includes("代理");
  const agentsFor = (master: (typeof pending)[number]) =>
    pending.filter(
      (profile) =>
        isAgentRole(profile.agency_role) &&
        (profile.master_agent_id === master.id ||
          profile.parent_id === master.id ||
          profile.referrer_id === master.id),
    );
  const membersFor = (agent: (typeof pending)[number]) =>
    pending.filter(
      (profile) =>
        !profile.agency_role.includes("代理") &&
        (profile.parent_id === agent.id || profile.referrer_id === agent.id),
    );
  const payoutKeyword = payoutQuery.trim().toLocaleLowerCase();
  const matchesPayoutQuery = (profile: Profile) =>
    [profile.email, profile.agency_role].some((value) =>
      value.toLocaleLowerCase().includes(payoutKeyword),
    );
  const visibleMasters = masters.filter((master) => {
    if (!payoutKeyword || matchesPayoutQuery(master)) return true;
    return agentsFor(master).some(
      (agent) =>
        matchesPayoutQuery(agent) || membersFor(agent).some(matchesPayoutQuery),
    );
  });
  const visibleAgentsFor = (master: (typeof pending)[number]) => {
    const agents = agentsFor(master);
    if (!payoutKeyword || matchesPayoutQuery(master)) return agents;
    return agents.filter(
      (agent) =>
        matchesPayoutQuery(agent) || membersFor(agent).some(matchesPayoutQuery),
    );
  };
  const visibleMembersFor = (agent: (typeof pending)[number]) => {
    const members = membersFor(agent);
    if (!payoutKeyword || matchesPayoutQuery(agent)) return members;
    return members.filter(matchesPayoutQuery);
  };
  const reportProfiles = profiles.filter(
    (profile) =>
      profile.agency_role === "總代理" || isAgentRole(profile.agency_role),
  );
  const reportProfileIds = new Set(reportProfiles.map((profile) => profile.id));
  const reportCommissions = commissions.filter(
    (commission) =>
      reportProfileIds.has(commission.beneficiary_id) &&
      isWithinDateRange(commission.created_at, reportStartDate, reportEndDate),
  );
  const reportTotals = reportCommissions.reduce(
    (totals, commission) => {
      const value = Number(commission.commission_amount);
      if (commission.transaction_type === "private")
        totals.privateAmount += value;
      if (commission.transaction_type === "secondary")
        totals.secondaryAmount += value;
      totals.totalAmount += value;
      totals.count += 1;
      return totals;
    },
    { privateAmount: 0, secondaryAmount: 0, totalAmount: 0, count: 0 },
  );
  const masterFor = (profile: Profile) => {
    if (profile.agency_role === "總代理") return profile;
    return masters.find(
      (master) =>
        profile.master_agent_id === master.id ||
        profile.parent_id === master.id ||
        profile.referrer_id === master.id,
    );
  };
  const reportByPromoter = reportProfiles.map((profile) => {
    const profileCommissions = reportCommissions.filter(
      (commission) => commission.beneficiary_id === profile.id,
    );
    const privateAmount = profileCommissions
      .filter((commission) => commission.transaction_type === "private")
      .reduce(
        (sum, commission) => sum + Number(commission.commission_amount),
        0,
      );
    const secondaryAmount = profileCommissions
      .filter((commission) => commission.transaction_type === "secondary")
      .reduce(
        (sum, commission) => sum + Number(commission.commission_amount),
        0,
      );
    return {
      profile,
      privateAmount,
      secondaryAmount,
      totalAmount: privateAmount + secondaryAmount,
    };
  });
  const exportCommissionReport = () => {
    const rangeName = `${reportStartDate || "all"}-${reportEndDate || "all"}`;
    downloadCsv(
      `commission-report-${rangeName}`,
      ["總代理歸屬", "推廣人員", "身份", "私募獎金", "二級獎金", "區間總獎金"],
      [
        ...reportByPromoter.map(
          ({ profile, privateAmount, secondaryAmount, totalAmount }) => [
            masterFor(profile)?.email || "未歸屬",
            profile.email,
            profile.agency_role,
            privateAmount.toFixed(2),
            secondaryAmount.toFixed(2),
            totalAmount.toFixed(2),
          ],
        ),
        [],
        [
          "全部合計",
          "",
          "",
          reportTotals.privateAmount.toFixed(2),
          reportTotals.secondaryAmount.toFixed(2),
          reportTotals.totalAmount.toFixed(2),
        ],
      ],
    );
  };
  const toggleExpanded = (
    id: string,
    setter: Dispatch<SetStateAction<string[]>>,
  ) =>
    setter((items) =>
      items.includes(id) ? items.filter((item) => item !== id) : [...items, id],
    );
  const publish = async () => {
    if (!announcementDraft.title.trim() || !announcementDraft.content.trim()) {
      setNotice({ text: "請完整填寫繁體中文公告標題與內容", ok: false });
      return;
    }
    setBusy(true);
    setNotice({ text: "正在翻譯為其餘 15 種語言…", ok: true });
    try {
      const translations = await translateAdminContent("announcement", {
        title: announcementDraft.title.trim(),
        content: announcementDraft.content.trim(),
      });
      const { error } = await supabase.rpc("admin_publish_announcement", {
        title_text: announcementDraft.title.trim(),
        content_text: announcementDraft.content.trim(),
        translations_json: translations,
      });
      setNotice({
        text: error ? `公告發布失敗：${error.message}` : "公告已自動翻譯並發布到首頁與代理後台",
        ok: !error,
      });
      if (!error) {
        setAnnouncementDraft(emptyAnnouncement());
        await load();
      }
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "自動翻譯失敗，繁中草稿已保留", ok: false });
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (item: Announcement) => {
    const { error } = await supabase.rpc("admin_set_announcement_active", {
      announcement_id: item.id,
      active: !item.is_active,
    });
    setNotice({
      text: error
        ? "公告狀態更新失敗"
        : item.is_active
          ? "公告已下架"
          : "公告已重新上架",
      ok: !error,
    });
    if (!error) await load();
  };
  const setRates = async (role: string) => {
    const privatePercent = Number(
      (document.getElementById(`private-${role}`) as HTMLInputElement).value,
    );
    const secondaryPercent = Number(
      (document.getElementById(`secondary-${role}`) as HTMLInputElement).value,
    );
    if (
      ![privatePercent, secondaryPercent].every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 100,
      )
    ) {
      setNotice({ text: "比例需介於 0% 至 100%", ok: false });
      return;
    }
    const { error } = await supabase.rpc("admin_update_commission_rates", {
      role_text: role,
      private_percent: privatePercent,
      secondary_percent: secondaryPercent,
    });
    setNotice({
      text: error ? "分潤比例更新失敗" : `${role}私募與二級市場分潤已即時更新`,
      ok: !error,
    });
    if (!error) await load();
  };
  const payout = async (role?: string, ids?: string[]) => {
    if (
      !window.confirm(
        "確定派發目前符合條件的待領獎金？此操作會立即入帳並留下日誌。",
      )
    )
      return;
    setBusy(true);
    const { data, error } = await supabase.rpc(
      "admin_pay_pending_commissions",
      { role_text: role ?? null, recipient_ids: ids ?? null },
    );
    setBusy(false);
    const batch = data as Batch | null;
    setNotice({
      text: error
        ? error.message.includes("not authorized")
          ? "獎金派發失敗：目前帳號沒有管理員權限"
          : `獎金派發失敗：${error.message}`
        : `派發完成：${batch?.recipient_count ?? 0} 人，共 ${money(batch?.total_amount ?? 0)}`,
      ok: !error,
    });
    if (!error) {
      setSelected([]);
      await load();
    }
  };
  const renderPayoutRow = (
    row: (typeof pending)[number],
    level = 0,
    expandable = false,
    expanded = false,
    onToggle?: () => void,
    label?: string,
  ) => (
    <tr
      key={`${row.id}-${level}`}
      className="border-t border-slate-800 align-top"
    >
      <td className="p-3">
        <input
          aria-label={`選取 ${row.email}`}
          type="checkbox"
          checked={selected.includes(row.id)}
          onChange={(event) =>
            setSelected((items) =>
              event.target.checked
                ? [...items, row.id]
                : items.filter((id) => id !== row.id),
            )
          }
        />
      </td>
      <td className="min-w-64 py-3 pr-4">
        <div
          className="flex min-w-0 items-start gap-2"
          style={{ paddingLeft: level * 20 }}
        >
          {expandable ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              className="size-6 rounded-md border border-slate-700 text-xs text-amber-200"
            >
              {expanded ? "−" : "+"}
            </button>
          ) : (
            level > 0 && <span className="h-px w-6 bg-slate-700" />
          )}
          {expandable ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              className="min-w-0 text-left"
            >
              <span className="block break-all font-medium leading-5 text-slate-200 underline decoration-slate-600 underline-offset-4 hover:text-amber-200">
                {row.email}
              </span>
              <span className="mt-1 block text-xs text-slate-500">
                {label || row.agency_role} · 點擊查看下層名單
              </span>
            </button>
          ) : (
            <div className="min-w-0">
              <span className="block break-all font-medium leading-5 text-slate-200">
                {row.email}
              </span>
              <span className="mt-1 block text-xs text-slate-500">
                {label || row.agency_role}
              </span>
            </div>
          )}
        </div>
      </td>
      <td className="min-w-32 py-3 pr-4 text-amber-200">
        {money(row.privateAmount)}
      </td>
      <td className="min-w-32 py-3 pr-4 text-sky-300">
        {money(row.secondaryAmount)}
      </td>
      <td className="min-w-44 py-3 pr-3 leading-5">
        {row.amount > 0
          ? "待發放"
          : row.lastPaid
            ? `已發放 · 上次 ${new Date(row.lastPaid).toLocaleString()}`
            : "尚無獎金"}
      </td>
    </tr>
  );
  return (
    <div className="flex flex-col gap-8">
      {notice && (
        <Notice message={notice.text} tone={notice.ok ? "success" : "error"} />
      )}
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-center gap-3">
          <Bell className="size-5 text-amber-300" />
          <div>
            <h3 className="font-bold">平台公告</h3>
            <p className="text-xs text-slate-500">
              發布後立即顯示於首頁與代理營運中心。
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-3">
          <p className="text-xs text-slate-500">
            只需輸入繁體中文；發布前會自動翻譯為其餘 15 種語言，失敗時會保留草稿。
          </p>
          <input
            value={announcementDraft.title}
            onChange={(event) => updateAnnouncementDraft("title", event.target.value)}
            maxLength={120}
            placeholder="繁體中文公告標題"
            className="rounded-xl border border-slate-700 bg-slate-950 p-3"
          />
          <textarea
            value={announcementDraft.content}
            onChange={(event) => updateAnnouncementDraft("content", event.target.value)}
            maxLength={2000}
            rows={4}
            placeholder="繁體中文公告內容"
            className="rounded-xl border border-slate-700 bg-slate-950 p-3"
          />
          <button
            disabled={busy}
            onClick={() => void publish()}
            className="flex items-center justify-center gap-2 rounded-xl bg-amber-400 px-5 py-3 font-bold text-slate-950 disabled:opacity-50"
          >
            <Send className="size-4" />
            {busy ? "翻譯並發布中…" : "翻譯並發布公告"}
          </button>
        </div>
        <div className="mt-5 flex flex-col gap-2">
          {announcements.slice(0, 2).map((item) => (
            <article
              key={item.id}
              className="flex flex-col gap-3 rounded-xl border border-slate-800 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <b>{item.title}</b>
                <p className="mt-1 text-sm text-slate-400">{item.content}</p>
                <time className="mt-1 block text-xs text-slate-500">
                  {new Date(item.created_at).toLocaleString()}
                </time>
              </div>
              <button
                onClick={() => void toggle(item)}
                className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold"
              >
                {item.is_active ? "下架" : "重新上架"}
              </button>
            </article>
          ))}
        </div>
        {announcements.length > 0 && (
          <div className="mt-4 border-t border-slate-800 pt-3">
            <button
              type="button"
              onClick={() => setShowAnnouncementHistory(true)}
              className="w-full rounded-lg px-3 py-2 text-sm font-semibold text-amber-300 transition hover:bg-slate-800"
            >
              查看更多
            </button>
          </div>
        )}
      </section>
      {showAnnouncementHistory && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="admin-announcement-history-title"
          className="fixed inset-0 z-50 flex max-w-full items-end justify-center overflow-x-hidden bg-slate-950/80 px-4 py-3 sm:items-center sm:p-6"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              setShowAnnouncementHistory(false);
          }}
        >
          <section className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <header className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold text-amber-300">平台公告</p>
                <h2
                  id="admin-announcement-history-title"
                  className="mt-1 text-xl font-bold"
                >
                  公告歷史紀錄
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowAnnouncementHistory(false)}
                aria-label="關閉公告歷史紀錄"
                className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800"
              >
                <X className="size-5" />
              </button>
            </header>
            <div className="mt-5 flex flex-col gap-3 overflow-y-auto pr-1">
              {announcements.map((item) => (
                <article
                  key={item.id}
                  className="flex flex-col gap-3 rounded-xl border border-slate-800 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <b>{item.title}</b>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-400">
                      {item.content}
                    </p>
                    <time className="mt-1 block text-xs text-slate-500">
                      {new Date(item.created_at).toLocaleString()}
                    </time>
                  </div>
                  <button
                    onClick={() => void toggle(item)}
                    className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold"
                  >
                    {item.is_active ? "下架" : "重新上架"}
                  </button>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}
      <CommissionOverrides />
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-center gap-3">
          <Coins className="size-5 text-amber-300" />
          <div>
            <h3 className="font-bold">分潤設定</h3>
            <p className="text-xs text-slate-500">
              比例修改會即時套用後續獎金；已產生的待領金額不回溯重算。
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {["總代理", "代理"].map((role) => {
            const setting = settings.find((s) => s.agency_role === role);
            const privateValue =
              (setting?.private_rate ?? (role === "總代理" ? 0.02 : 0.01)) *
              100;
            const secondaryValue =
              (setting?.secondary_rate ??
                (role === "總代理" ? 0.0013 : 0.0007)) * 100;
            return (
              <div key={role} className="rounded-xl bg-slate-950 p-4 text-sm">
                <b>{role}分潤</b>
                <div className="mt-3 grid gap-3">
                  <label>
                    私募百分比
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      defaultValue={privateValue}
                      id={`private-${role}`}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 p-2"
                    />
                  </label>
                  <label>
                    二級市場百分比
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.001"
                      defaultValue={secondaryValue}
                      id={`secondary-${role}`}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 p-2"
                    />
                  </label>
                  <p className="text-xs text-slate-500">
                    目前：私募 {privateValue}% · 二級市場 {secondaryValue}%
                  </p>
                  <button
                    onClick={() => void setRates(role)}
                    className="rounded-lg bg-amber-400 px-4 py-2 font-bold text-slate-950"
                  >
                    儲存兩項比例
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Coins className="size-5 shrink-0 text-amber-300" />
            <div>
              <h3 className="font-bold">一鍵派發</h3>
              <p className="text-xs text-slate-500">
                搜尋推廣人員、查看階層獎金，並進行全平台或指定人員派發。
              </p>
            </div>
          </div>
          <button
            disabled={busy}
            onClick={() => void payout()}
            className="shrink-0 rounded-lg bg-amber-400 px-3 py-2 text-xs font-bold text-slate-950 disabled:opacity-50"
          >
            全平台派發
          </button>
        </div>
        <label className="mt-5 block">
          <span className="sr-only">搜尋推廣人員</span>
          <input
            type="search"
            value={payoutQuery}
            onChange={(event) => setPayoutQuery(event.target.value)}
            placeholder="搜尋推廣人員 Email 或身份"
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm outline-none placeholder:text-slate-600 focus:border-amber-400"
          />
        </label>
        <div className="mt-5">
          <CommissionDateReport
            startDate={reportStartDate}
            endDate={reportEndDate}
            onStartDateChange={setReportStartDate}
            onEndDateChange={setReportEndDate}
            totals={reportTotals}
            onExport={exportCommissionReport}
          />
        </div>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="text-slate-500">
                <th className="p-3">選取</th>
                <th>推廣人員階層</th>
                <th>私募獎金</th>
                <th>二級獎金</th>
                <th>發放狀態</th>
              </tr>
            </thead>
            <tbody>
              {visibleMasters.map((master) => {
                const agents = visibleAgentsFor(master);
                const masterExpanded =
                  Boolean(payoutKeyword) || expandedMasters.includes(master.id);
                return (
                  <Fragment key={master.id}>
                    {renderPayoutRow(
                      master,
                      0,
                      agents.length > 0,
                      masterExpanded,
                      () => toggleExpanded(master.id, setExpandedMasters),
                    )}
                    {masterExpanded &&
                      agents.map((agent) => {
                        const members = visibleMembersFor(agent);
                        const agentExpanded =
                          Boolean(payoutKeyword) ||
                          expandedAgents.includes(agent.id);
                        return (
                          <Fragment key={agent.id}>
                            {renderPayoutRow(
                              agent,
                              1,
                              members.length > 0,
                              agentExpanded,
                              () => toggleExpanded(agent.id, setExpandedAgents),
                              agent.agency_role,
                            )}
                            {agentExpanded &&
                              members.map((member) =>
                                renderPayoutRow(
                                  member,
                                  2,
                                  false,
                                  false,
                                  undefined,
                                  "一般會員",
                                ),
                              )}
                          </Fragment>
                        );
                      })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <button
          disabled={busy || selected.length === 0}
          onClick={() => void payout(undefined, selected)}
          className="mt-4 w-full rounded-xl border border-amber-500/40 p-3 font-bold text-amber-200 disabled:opacity-40"
        >
          派發已選取人員（{selected.length}）
        </button>
        <div className="mt-6">
          <div className="flex items-center justify-between gap-3">
            <h4 className="font-semibold">最近派發日誌</h4>
            {batches.length > 3 && (
              <button
                type="button"
                onClick={() => setShowAllBatches((visible) => !visible)}
                className="text-xs font-semibold text-amber-300 hover:text-amber-200"
              >
                {showAllBatches
                  ? "收合日誌"
                  : `查閱更多（${batches.length - 3}）`}
              </button>
            )}
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {(showAllBatches ? batches : batches.slice(0, 3)).map((batch) => (
              <div
                key={batch.id}
                className="flex flex-col justify-between gap-1 rounded-xl bg-slate-950 p-3 text-sm sm:flex-row"
              >
                <span>
                  <CheckCircle2 className="mr-2 inline size-4 text-emerald-400" />
                  {batch.scope === "all"
                    ? "全平台"
                    : batch.scope === "role"
                      ? batch.role_filter
                      : "指定人員"}{" "}
                  · {batch.recipient_count} 人 · {money(batch.total_amount)}
                </span>
                <time className="text-xs text-slate-500">
                  {new Date(batch.created_at).toLocaleString()}
                </time>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
