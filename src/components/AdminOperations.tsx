import {
  Fragment,
  useEffect,
  useRef,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { AlertTriangle, Bell, CheckCircle2, Coins, Send, Trash2, X } from "lucide-react";
import { Notice } from "@/components/Modal";
import { CommissionOverrides } from "@/components/CommissionOverrides";
import {
  CommissionDateReport,
  downloadCsv,
  isWithinDateRange,
} from "@/components/CommissionDateReport";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { factoryTokenOrNull } from "@/lib/contracts";
import { getGenesisRoleLabel } from "@/lib/roleLabels";
import { useVisiblePolling } from "@/hooks/useVisiblePolling";
import { formatJC, type Lang } from "@/platform";
import { translateAdminContent } from "@/lib/translate";
import {
  CONTRACT_INFO_VISIBLE_AFTER,
  isTransactionHistoryVisible,
  TRANSACTION_HISTORY_START_LABEL,
} from "@/lib/transactionHistory";
import { explorerTxUrl, STABLECOIN_SYMBOL } from "@/lib/network";

const keepStable = <T,>(previous: T, next: T): T =>
  JSON.stringify(previous) === JSON.stringify(next) ? previous : next;

type AnnouncementTranslation = { title: string; content: string };
type Announcement = {
  id: string;
  title: string;
  content: string;
  translations?: Partial<Record<Lang, AnnouncementTranslation>>;
  is_active: boolean;
  created_at: string;
  background_push?: boolean | null;
};
type Setting = {
  agency_role: string;
  asset_mode: "ae_coin" | "rwa";
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
type PayoutPlacement = {
  id: string;
  name: string;
  is_ae_token: boolean;
  token_address: string | null;
  updated_at: string;
  is_active: boolean;
  is_delisted: boolean;
};
type PayoutAsset = "jc" | "ae" | "rwa" | "usdt";
type Commission = {
  id: string;
  beneficiary_id: string;
  transaction_type: "private" | "secondary";
  commission_amount: number;
  bonus_type: "l1" | "l2" | null;
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
type PayoutRecord = {
  id: string;
  requestKey: string;
  recipientId: string | null;
  recipientEmail: string | null;
  assetType: PayoutAsset;
  placementId: string | null;
  placementName: string | null;
  amount: string;
  status: "pending" | "confirmed" | "failed";
  txHash: string | null;
  error: string | null;
  accounted: boolean;
  superseded?: boolean;
  createdAt: string;
  updatedAt: string;
};
// 獎金派發錯誤稽核列：應派發（owed）與實際入帳（paid）對不上時出現。diff>0 為多發、diff<0 為少發。
type Discrepancy = {
  beneficiary_id: string;
  email: string | null;
  nickname: string | null;
  display_name: string | null;
  agency_role: string | null;
  owed: number;
  paid: number;
  diff: number;
};
type TelegramRecipient = {
  id: string;
  telegramUsername: string | null;
  email: string;
  displayName: string | null;
  agencyRole: string;
};
type TelegramDeliveryLog = {
  id: string;
  target_user_id: string | null;
  recipientLabel: string;
  title: string;
  body: string;
  status: "pending" | "sent" | "failed" | "skipped";
  error_message: string | null;
  sent_at: string | null;
  created_at: string;
};
type TelegramAudience = "all" | "master_agent" | "agent" | "individual";

function isTelegramMasterRole(role: string) {
  return role === "總代理" || role === "master_agent";
}

function isTelegramAgentRole(role: string) {
  return !isTelegramMasterRole(role) && (role === "agent" || role.includes("代理"));
}
const money = (value: number) =>
  `${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} JC`;

export function AdminOperations({ mode }: { mode: "announcements" | "payouts" }) {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [showAnnouncementHistory, setShowAnnouncementHistory] = useState(false);
  const [telegramRecipients, setTelegramRecipients] = useState<TelegramRecipient[]>([]);
  const [telegramAudience, setTelegramAudience] = useState<TelegramAudience>("individual");
  const [telegramRecipientId, setTelegramRecipientId] = useState("");
  const [telegramDraft, setTelegramDraft] = useState<AnnouncementTranslation>({ title: "", content: "" });
  const [telegramRequestKey, setTelegramRequestKey] = useState<string | null>(null);
  const [telegramSending, setTelegramSending] = useState(false);
  const [telegramHistory, setTelegramHistory] = useState<TelegramDeliveryLog[]>([]);
  const [telegramRecipientsError, setTelegramRecipientsError] = useState("");
  const [settings, setSettings] = useState<Setting[]>([]);
  const [assetMode, setAssetMode] = useState<"ae_coin" | "rwa">("ae_coin");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [payoutPlacements, setPayoutPlacements] = useState<PayoutPlacement[]>([]);
  const [payoutRecipientId, setPayoutRecipientId] = useState("");
  const [payoutWalletAddress, setPayoutWalletAddress] = useState("");
  const [payoutWalletLoading, setPayoutWalletLoading] = useState(false);
  const payoutWalletRequest = useRef(0);
  const [payoutAsset, setPayoutAsset] = useState<PayoutAsset>("jc");
  const [payoutPlacementId, setPayoutPlacementId] = useState("");
  const [payoutAmount, setPayoutAmount] = useState("");
  const [payoutRequestKey, setPayoutRequestKey] = useState<string | null>(null);
  const [payoutPending, setPayoutPending] = useState(false);
  const [payoutTxHash, setPayoutTxHash] = useState<string | null>(null);
  const [payoutHistory, setPayoutHistory] = useState<PayoutRecord[]>([]);
  const [payoutHistoryError, setPayoutHistoryError] = useState("");
  const [retryingPayoutId, setRetryingPayoutId] = useState<string | null>(null);
  const [checkingPayoutId, setCheckingPayoutId] = useState<string | null>(null);
  const [commissions, setCommissions] = useState<Commission[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [discrepancies, setDiscrepancies] = useState<Discrepancy[]>([]);
  const [selectedReversals, setSelectedReversals] = useState<string[]>([]);
  useEffect(() => {
    setSelectedReversals((current) => {
      const ids = discrepancies.map((item) => item.beneficiary_id);
      const kept = current.filter((id) => ids.includes(id));
      const added = ids.filter((id) => !current.includes(id));
      return added.length === 0 && kept.length === current.length ? current : [...kept, ...added];
    });
  }, [discrepancies]);
  const [reversing, setReversing] = useState(false);
  const [stuckCommissions, setStuckCommissions] = useState<
    { commissionId: string; userLabel: string; amount: number | null; status: string; error?: string | null }[]
  >([]);
  const [verifyingCommissionId, setVerifyingCommissionId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [expandedMasters, setExpandedMasters] = useState<string[]>([]);
  const [expandedAgents, setExpandedAgents] = useState<string[]>([]);
  const [reportStartDate, setReportStartDate] = useState("");
  const [reportEndDate, setReportEndDate] = useState("");
  const [payoutQuery, setPayoutQuery] = useState("");
  const [showAllBatches, setShowAllBatches] = useState(false);
  const emptyAnnouncement = (): AnnouncementTranslation => ({ title: "", content: "" });
  const [announcementDraft, setAnnouncementDraft] = useState(emptyAnnouncement);
  const [announcementPaste, setAnnouncementPaste] = useState("");
  const updateAnnouncementDraft = (
    field: keyof AnnouncementTranslation,
    value: string,
  ) => setAnnouncementDraft((current) => ({ ...current, [field]: value }));
  const detectAnnouncementFields = (rawText: string) => {
    setAnnouncementPaste(rawText);
    const normalized = rawText.replace(/\r\n?/g, "\n").trim();
    const lines = normalized.split("\n");
    const titlePattern = /^(?:公告)?標題\s*[:：]\s*/i;
    const contentPattern = /^(?:公告)?(?:內容|內文)\s*[:：]\s*/i;
    const titleIndex = lines.findIndex((line) => titlePattern.test(line.trim()));
    const contentIndex = lines.findIndex((line) => contentPattern.test(line.trim()));
    const firstContentLine = lines.findIndex((line) => line.trim());
    const makeTitle = (text: string) =>
      (text.split(/[。！？.!?]/u).find((part) => part.trim()) ?? text).trim().slice(0, 120);
    let title = "";
    let content = "";

    if (titleIndex >= 0) {
      title = lines[titleIndex].trim().replace(titlePattern, "").trim();
      content = contentIndex >= 0
        ? [lines[contentIndex].trim().replace(contentPattern, ""), ...lines.slice(contentIndex + 1)].join("\n").trim()
        : lines.filter((_, index) => index !== titleIndex).join("\n").trim();
    } else if (contentIndex >= 0) {
      content = [lines[contentIndex].trim().replace(contentPattern, ""), ...lines.slice(contentIndex + 1)].join("\n").trim();
      title = makeTitle(content);
    } else if (normalized.includes("\n")) {
      title = (lines[firstContentLine] ?? "").trim();
      content = lines.filter((_, index) => index !== firstContentLine).join("\n").trim();
    } else {
      content = normalized;
      title = makeTitle(content);
    }

    setAnnouncementDraft({ title: title.slice(0, 120), content: content.slice(0, 2000) });
  };
  const updateTelegramDraft = (
    field: keyof AnnouncementTranslation,
    value: string,
  ) => {
    setTelegramDraft((current) => ({ ...current, [field]: value }));
    setTelegramRequestKey(null);
  };
  const [notice, setNotice] = useState<{ text: string; ok: boolean; pending?: boolean } | null>(
    null,
  );
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const [a, s, p, c, b, d, payoutAssets] = await Promise.all([
      supabase
        .from("platform_announcements")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase.from("commission_settings").select("*"),
      fetchAllRows((rangeFrom, rangeTo) =>
        supabase
          .from("profiles")
          .select("id,email,agency_role,parent_id,referrer_id,master_agent_id")
          .order("id")
          .range(rangeFrom, rangeTo),
      ),
      fetchAllRows((rangeFrom, rangeTo) =>
        supabase
          .from("commission_logs")
          .select(
            "id,beneficiary_id,transaction_type,commission_amount,bonus_type,paid_at,created_at",
          )
          .order("created_at", { ascending: false })
          .order("id")
          .range(rangeFrom, rangeTo),
      ),
      supabase
        .from("commission_payout_batches")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(10),
      supabase.rpc("admin_commission_discrepancies"),
      supabase
        .from("private_placements")
        .select("id,name,is_ae_token,token_address,is_active,is_delisted,updated_at")
        .gte("updated_at", CONTRACT_INFO_VISIBLE_AFTER)
        .order("name"),
    ]);
    setAnnouncements((previous) => keepStable(previous, (a.data ?? []) as Announcement[]));
    setSettings((previous) => keepStable(previous, (s.data ?? []) as Setting[]));
    setProfiles((previous) => keepStable(previous, (p.data ?? []) as Profile[]));
    setPayoutPlacements((previous) => keepStable(previous, (payoutAssets.data ?? []) as PayoutPlacement[]));
    setCommissions((previous) => keepStable(previous, (c.data ?? []) as Commission[]));
    setBatches((previous) => keepStable(previous, (b.data ?? []) as Batch[]));
    if (!d.error) {
      setDiscrepancies((previous) => keepStable(previous, (d.data ?? []) as Discrepancy[]));
    }
  };
  useVisiblePolling(load, 1_000, true);
  const loadTelegramAdminData = async () => {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) throw new Error("登入狀態已失效");
      const response = await fetch("/api/admin-telegram-message", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const result = await response.json() as {
        recipients?: TelegramRecipient[];
        logs?: TelegramDeliveryLog[];
        error?: string;
      };
      if (!response.ok) throw new Error(result.error || "Telegram 資料載入失敗");
      setTelegramRecipients((previous) => keepStable(previous, result.recipients ?? []));
      setTelegramHistory((previous) => keepStable(previous, result.logs ?? []));
      setTelegramRecipientsError("");
    } catch (error) {
      setTelegramRecipientsError(error instanceof Error ? error.message : "Telegram 資料載入失敗");
    }
  };
  useVisiblePolling(loadTelegramAdminData, 30_000, mode === "announcements");
  const telegramAudienceRecipients = useMemo(() => {
    if (telegramAudience === "all") return telegramRecipients;
    if (telegramAudience === "master_agent") return telegramRecipients.filter((recipient) => isTelegramMasterRole(recipient.agencyRole));
    if (telegramAudience === "agent") return telegramRecipients.filter((recipient) => isTelegramAgentRole(recipient.agencyRole));
    return telegramRecipients.filter((recipient) => recipient.id === telegramRecipientId);
  }, [telegramAudience, telegramRecipientId, telegramRecipients]);
  const sendAdminTelegramMessage = async () => {
    if (telegramAudienceRecipients.length === 0) {
      setNotice({ text: "此收件對象目前沒有已連結 Telegram 的用戶。", ok: false });
      return;
    }
    const title = telegramDraft.title.trim();
    const body = telegramDraft.content.trim();
    if (!title || !body) {
      setNotice({ text: "請填寫 Telegram 訊息標題與內容。", ok: false });
      return;
    }
    const audienceLabel = telegramAudience === "all"
      ? "全部已連結用戶"
      : telegramAudience === "master_agent"
        ? "創世紀L0"
        : telegramAudience === "agent"
          ? "有下級"
          : telegramAudienceRecipients[0]?.email ?? "個別用戶";
    if (!window.confirm(`確定透過 Telegram 傳送給「${audienceLabel}」共 ${telegramAudienceRecipients.length} 人？\n訊息送出後無法撤回。`)) return;
    const requestKey = telegramRequestKey ?? crypto.randomUUID();
    setTelegramRequestKey(requestKey);
    setTelegramSending(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) throw new Error("登入狀態已失效");
      const response = await fetch("/api/admin-telegram-message", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          audience: telegramAudience,
          recipientId: telegramAudience === "individual" ? telegramRecipientId : undefined,
          requestKey,
          title,
          body,
        }),
      });
      const result = await response.json() as {
        attempted?: number;
        sent?: number;
        failed?: number;
        skipped?: number;
        duplicate?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(result.error || "Telegram 訊息發送失敗");
      const sentCount = result.sent ?? 0;
      const failedCount = result.failed ?? 0;
      const duplicateCount = result.duplicate ?? 0;
      const skippedCount = result.skipped ?? 0;
      if (failedCount > 0 || skippedCount > 0) {
        setNotice({
          text: `群發處理完成：送達 ${sentCount} 人、失敗 ${failedCount} 人、略過 ${skippedCount} 人${duplicateCount ? `、已處理 ${duplicateCount} ��` : ""}。可再次傳送以重試未成功對象。`,
          ok: false,
        });
      } else {
        setNotice({
          text: `Telegram 訊息處理完成：送達 ${sentCount} 人${duplicateCount ? `，${duplicateCount} 人已送出或正在處理` : ""}。`,
          ok: true,
          pending: duplicateCount > 0 && sentCount === 0,
        });
        setTelegramDraft({ title: "", content: "" });
        setTelegramRequestKey(null);
      }
      await loadTelegramAdminData();
    } catch (error) {
      setNotice({ text: `Telegram 訊息未確認送達：${error instanceof Error ? error.message : "請稍後再試"}`, ok: false });
    } finally {
      setTelegramSending(false);
    }
  };
  const pending = useMemo(
    () =>
      profiles.map((profile) => {
        const userCommissions = commissions.filter(
(commission) =>
        commission.beneficiary_id === profile.id,
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
      isTransactionHistoryVisible(commission.created_at) &&
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
      .reduce((sum, commission) => sum + Number(commission.commission_amount), 0);
    const secondaryAmount = profileCommissions
      .filter((commission) => commission.transaction_type === "secondary")
      .reduce((sum, commission) => sum + Number(commission.commission_amount), 0);
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
      ["創世紀L0歸屬", "推廣人員", "創世紀層級", "私募獎金", "二級獎金", "區間總獎金"],
      [
        ...reportByPromoter.map(
          ({ profile, privateAmount, secondaryAmount, totalAmount }) => [
            masterFor(profile)?.email || "未歸屬",
            profile.email,
            profile.agency_role,
            formatJC(privateAmount),
            formatJC(secondaryAmount),
            formatJC(totalAmount),
          ],
        ),
        [],
        [
          "區間統計",
          "",
          "",
          formatJC(reportTotals.privateAmount),
          formatJC(reportTotals.secondaryAmount),
          formatJC(reportTotals.totalAmount),
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
      setNotice({ text: "正在翻譯並發布公告…", ok: true });
      try {
        const title = announcementDraft.title.trim();
        const content = announcementDraft.content.trim();
        const translations = await translateAdminContent("announcement", { title, content });
        const { data, error } = await supabase.rpc("admin_publish_announcement", {
          title_text: title,
          content_text: content,
          translations_json: translations,
        });
      if (error) throw error;
      const published = Array.isArray(data) ? data[0] : data;
  const { data: confirmed, error: confirmError } = await supabase
  .from("platform_announcements")
  .select("id,translations")
  .eq("id", published?.id)
  .maybeSingle();
  const translationCount = confirmed?.translations && typeof confirmed.translations === "object"
    ? Object.keys(confirmed.translations).length
    : 0;
  if (confirmError || !confirmed || translationCount < 16) {
    throw confirmError ?? new Error("公告翻譯未完整寫入，公告尚未完成發布");
  }
      setAnnouncementDraft(emptyAnnouncement());
      setAnnouncementPaste("");
      await load();
      setNotice({ text: "公告已發布到首頁與代理後台", ok: true });
    } catch (error) {
      setNotice({
        text: `公告發布失敗：${error instanceof Error ? error.message : "請稍後再試"}`,
        ok: false,
      });
    } finally {
      setBusy(false);
    }
  };
  const testTelegramGroup = async () => {
    setTelegramTesting(true);
    setNotice({ text: "正在傳送 Telegram 群組測試訊息…", ok: true });
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) throw new Error("登入狀態已失效");
      const response = await fetch("/api/test-telegram", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const result = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(result.error || "Telegram 群組測試失敗");
      setNotice({ text: result.message || "測試訊息已送至 Telegram 群組", ok: true });
    } catch (error) {
      setNotice({
        text: `Telegram 群組測試未送出：${error instanceof Error ? error.message : "請稍後再試"}`,
        ok: false,
      });
    } finally {
      setTelegramTesting(false);
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
  const removeAnnouncement = async (item: Announcement) => {
    if (!window.confirm(`確定永久刪除公告「${item.title}」？此操作無法復原。`)) return;
    const { error } = await supabase.rpc("admin_delete_announcement", {
      announcement_id: item.id,
    });
    setNotice({
      text: error ? `公告刪除失敗：${error.message}` : "公告已永久刪除",
      ok: !error,
    });
    if (!error) await load();
  };
  const setRates = async (role: string) => {
    const privatePercent = Number(
      (
        document.getElementById(
          `private-${role}-${assetMode}`,
        ) as HTMLInputElement
      ).value,
    );
    const secondaryPercent = Number(
      (
        document.getElementById(
          `secondary-${role}-${assetMode}`,
        ) as HTMLInputElement
      ).value,
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
      asset_mode_text: assetMode,
    });
    setNotice({
      text: error
        ? "分潤比例更新失敗"
        : `${role}統一比例（${assetMode === "ae_coin" ? "AE" : "RWA"}）已更新，將套用於後續新交易`,
      ok: !error,
    });
    if (!error) await load();
  };
  const callRelayer = async (
    action: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) throw new Error("登入狀態已失效");
    const response = await fetch("/api/relayer", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ action, ...extra }),
    });
    const result = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(result?.error ?? `${action} 失敗`));
    return result;
  };
  const loadStuckCommissions = async () => {
    try {
      const result = await callRelayer("admin-list-settlements");
      setStuckCommissions((result.stuckCommissions ?? []) as typeof stuckCommissions);
    } catch {
      setStuckCommissions([]);
    }
  };
  useVisiblePolling(
    () => (mode === "payouts" ? loadStuckCommissions() : undefined),
    15_000,
    mode === "payouts",
  );
  const verifyAndPayCommission = async (item: (typeof stuckCommissions)[number], dryRun: boolean) => {
    if (
      !dryRun &&
      !window.confirm(
        `將先核對鏈上沒有相同轉帳，確認後由 ADMIN 熱錢包發放 ${formatJC(item.amount ?? 0)} 給 ${item.userLabel}。此鏈上轉帳不可逆，確定繼續？`,
      )
    )
      return;
    setVerifyingCommissionId(item.commissionId);
    try {
      const result = await callRelayer("admin-verify-pay-commission", { commissionId: item.commissionId, dryRun });
      const status = result.status as string | undefined;
      setNotice({
        text: dryRun
          ? "核對通過：鏈上沒有相同的轉帳，可以安全發放。"
          : status === "confirmed"
            ? `分潤已發放並確認${result.tx_hash ? `（Tx：${String(result.tx_hash)}）` : ""}`
            : status === "already_paid"
              ? "這筆分潤已經是已發放狀態。"
              : "已送出發放請求，請稍後重新整理確認結果",
        ok: true,
      });
      await load();
      await loadStuckCommissions();
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "核對或發放失敗", ok: false });
    } finally {
      setVerifyingCommissionId(null);
    }
  };
  const loadPayoutHistory = async () => {
    try {
      const result = await callRelayer("admin-asset-payout-history");
      setPayoutHistory((result.payouts ?? []) as PayoutRecord[]);
      setPayoutHistoryError("");
    } catch (error) {
      setPayoutHistoryError(error instanceof Error ? error.message : "派發紀錄載入失敗");
    }
  };
  useVisiblePolling(
    () => (mode === "payouts" ? loadPayoutHistory() : undefined),
    5_000,
    mode === "payouts",
  );
  const selectPayoutRecipient = async (recipientId: string) => {
    setPayoutRecipientId(recipientId);
    setPayoutWalletAddress("");
    if (!payoutPending) {
      setPayoutTxHash(null);
      setPayoutRequestKey(null);
    }
    const requestId = ++payoutWalletRequest.current;
    if (!recipientId) return;
    setPayoutWalletLoading(true);
    try {
      const result = await callRelayer("admin-agent-wallet", { recipientId });
      if (payoutWalletRequest.current === requestId) {
        setPayoutWalletAddress(typeof result.wallet === "string" ? result.wallet : "");
      }
    } catch (error) {
      if (payoutWalletRequest.current === requestId) {
        setNotice({ text: error instanceof Error ? error.message : "無法載入管理錢包地址", ok: false });
      }
    } finally {
      if (payoutWalletRequest.current === requestId) setPayoutWalletLoading(false);
    }
  };
  const payoutAssetPlacements = payoutPlacements.filter((placement) =>
    payoutAsset === "ae"
      ? placement.is_ae_token && !placement.is_delisted
      : payoutAsset === "rwa"
        ? !placement.is_ae_token && Boolean(factoryTokenOrNull(placement.token_address))
        : false,
  );
  const selectedPayoutRecipient = profiles.find((profile) => profile.id === payoutRecipientId);
  const sendIndividualPayout = async () => {
    const amount = payoutAmount.trim();
    if (!selectedPayoutRecipient || !payoutWalletAddress) {
      setNotice({ text: "請選擇已綁定錢包的代理", ok: false });
      return;
    }
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(amount) || !(Number(amount) > 0)) {
      setNotice({ text: "請輸入大於 0 的數量，最多 6 位小數", ok: false });
      return;
    }
    if ((payoutAsset === "ae" || payoutAsset === "rwa") && !payoutPlacementId) {
      setNotice({ text: "請選擇網站持倉對應的標的", ok: false });
      return;
    }
    const assetName = payoutAsset.toUpperCase();
    const placementName = payoutAssetPlacements.find((item) => item.id === payoutPlacementId)?.name;
    if (!window.confirm(`確定從熱錢包派發 ${amount} ${assetName}${placementName ? `（${placementName}）` : ""} 給 ${selectedPayoutRecipient.email}？\n收款錢包：${payoutWalletAddress}`)) return;

    const requestKey = payoutRequestKey ?? crypto.randomUUID();
    setPayoutRequestKey(requestKey);
    setBusy(true);
    try {
      const result = await callRelayer("admin-asset-payout", {
        recipientId: payoutRecipientId,
        assetType: payoutAsset,
        amount,
        placementId: payoutPlacementId || undefined,
        requestKey,
      });
      const txHash = typeof result.tx_hash === "string" ? result.tx_hash : null;
      if (txHash) setPayoutTxHash(txHash);
      if (result.status === "pending") {
        setPayoutPending(true);
        setNotice({
          text: txHash
            ? `交易已送出，正在等待鏈上確認。只有確認後才會顯示完成；交易雜湊也會列在下方紀錄。`
            : "這筆紀錄尚無鏈上交易雜湊，尚未確認派發。請查看下方紀錄並重新派發。",
          ok: true,
          pending: true,
        });
        await loadPayoutHistory();
        return;
      }
      setNotice({ text: `鏈上已確認派發 ${amount} ${assetName} 給 ${selectedPayoutRecipient.email}，網站帳本已同步。${txHash ? ` 交易：${txHash}` : ""}`, ok: true });
      setPayoutRequestKey(null);
      setPayoutPending(false);
      window.dispatchEvent(new Event("platform-assets-updated"));
      await load();
    } catch (error) {
      const message = error instanceof Error ? error.message : "請稍後再試";
      if (message.includes("鏈上已成功轉帳")) setPayoutPending(true);
      setNotice({ text: `個別派發失敗：${message}`, ok: false });
    } finally {
      setBusy(false);
      await loadPayoutHistory();
    }
  };
  const checkPayoutRecord = async (record: PayoutRecord) => {
    setCheckingPayoutId(record.id);
    try {
      const result = await callRelayer("admin-asset-payout-check", { requestKey: record.requestKey });
      if (result.status === "confirmed") {
        setNotice({ text: "鏈上交易已確認，網站帳本同步完成。", ok: true });
        window.dispatchEvent(new Event("platform-assets-updated"));
      } else if (result.status === "failed") {
        setNotice({ text: "鏈上交易失敗，沒有完成派發。", ok: false });
      } else {
        setNotice({ text: "交易仍在等待鏈上確認，請稍後再查。", ok: true });
      }
      await loadPayoutHistory();
    } catch (error) {
      setNotice({ text: `查詢派發狀態失敗：${error instanceof Error ? error.message : "請稍後再試"}`, ok: false });
    } finally {
      setCheckingPayoutId(null);
    }
  };
  const retryPayoutRecord = async (record: PayoutRecord) => {
    if (!record.recipientId || !["jc", "ae", "rwa", "usdt"].includes(record.assetType)) return;
    setRetryingPayoutId(record.id);
    try {
      const recipientResult = await callRelayer("admin-agent-wallet", { recipientId: record.recipientId });
      const recipientWallet = String(recipientResult.wallet ?? "");
      const requestKey = crypto.randomUUID();
      if (!window.confirm(
        `這筆舊紀錄沒有鏈上交易雜湊，無法由原紀錄確認已送出。確定建立新派發交易，將 ${record.amount} ${record.assetType.toUpperCase()} 發給 ${record.recipientEmail ?? "此代理"}？\n收款錢包：${recipientWallet}\n請先確認收款人與金額正確。`,
      )) return;
      setBusy(true);
      setPayoutRecipientId(record.recipientId);
      setPayoutWalletAddress(recipientWallet);
      setPayoutAsset(record.assetType);
      setPayoutPlacementId(record.placementId ?? "");
      setPayoutAmount(record.amount);
      setPayoutRequestKey(requestKey);
      setPayoutTxHash(null);
      const result = await callRelayer("admin-asset-payout", {
        recipientId: record.recipientId,
        assetType: record.assetType,
        amount: record.amount,
        placementId: record.placementId ?? undefined,
        requestKey,
      });
      const txHash = typeof result.tx_hash === "string" ? result.tx_hash : null;
      setPayoutTxHash(txHash);
      if (result.status === "pending") {
        setPayoutPending(true);
        setNotice({ text: txHash ? "新交易已送出，等待鏈上確認；下方會保留新舊兩筆紀錄。" : "尚未取得交易雜湊，請查看下方紀錄。", ok: true, pending: true });
      } else {
        setPayoutPending(false);
        setPayoutRequestKey(null);
        setNotice({ text: `鏈上已確認派發 ${record.amount} ${record.assetType.toUpperCase()}。`, ok: true });
        window.dispatchEvent(new Event("platform-assets-updated"));
      }
      await load();
      await loadPayoutHistory();
    } catch (error) {
      setNotice({ text: `重新派發失敗：${error instanceof Error ? error.message : "請稍後再試"}`, ok: false });
    } finally {
      setBusy(false);
      setRetryingPayoutId(null);
      await loadPayoutHistory();
    }
  };
  const payout = async (_role?: string, ids?: string[]) => {
    if (
      !window.confirm(
        "確定把待派發獎金實際上鏈發放給受益人？此操作會從平台熱錢包轉出 JC 並留下日誌。",
      )
    )
      return;
    setBusy(true);
    try {
      const result = await callRelayer(
        "settle-commissions",
        ids && ids.length > 0 ? { beneficiaryIds: ids } : {},
      );
      const settled = Number(result.settled ?? 0);
      const skipped = Number(result.skipped ?? 0);
      setNotice({
        text: `已上鏈派發：成功 ${settled} 筆${skipped ? `，略過 ${skipped} 筆（受益人尚未綁定錢包，或結算卡在處理中——卡住的請用下方「卡住的分潤派發」核對並發放）` : ""}`,
        ok: settled > 0 || skipped === 0,
      });
      setSelected([]);
      await load();
      await loadStuckCommissions();
    } catch (error) {
      setNotice({
        text: `獎金派發失敗：${error instanceof Error ? error.message : "請稍後再試"}`,
        ok: false,
      });
    } finally {
      setBusy(false);
    }
  };
  const reverseSelected = async (ids: string[]) => {
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `確定沖正選取的 ${ids.length} 位人員的獎金派發錯誤？少發將實際上鏈補發差額，多發僅校正站內帳本（鏈上多發的 JC 無法自動回收）。`,
      )
    )
      return;
    setReversing(true);
    try {
      const result = await callRelayer("commission-reverse", { beneficiaryIds: ids });
      const rows = (result.results ?? []) as { applied?: boolean; error?: string }[];
      const applied = rows.filter((r) => r.applied).length;
      const failed = rows.filter((r) => r.error);
      setNotice({
        text: failed.length
          ? `沖正完成 ${applied} 筆，失敗 ${failed.length} 筆：${failed[0].error}`
          : applied === 0
            ? "沖正未執行：伺服器重算後沒有可校正的差額，請重新整理確認列表"
            : `沖正完成：已校正 ${applied} 筆`,
        ok: failed.length === 0 && applied > 0,
      });
      setSelectedReversals([]);
      await load();
    } catch (error) {
      setNotice({
        text: `沖正失敗：${error instanceof Error ? error.message : "請稍後再試"}`,
        ok: false,
      });
    } finally {
      setReversing(false);
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
                {label || getGenesisRoleLabel(row.agency_role)} · 點擊查看下層名單
              </span>
            </button>
          ) : (
            <div className="min-w-0">
              <span className="block break-all font-medium leading-5 text-slate-200">
                {row.email}
              </span>
              <span className="mt-1 block text-xs text-slate-500">
                {label || getGenesisRoleLabel(row.agency_role)}
              </span>
            </div>
          )}
        </div>
      </td>
      <td className="min-w-32 py-3 pr-4 text-amber-200">
        {formatJC(row.privateAmount)}
      </td>
      <td className="min-w-32 py-3 pr-4 text-sky-300">
        {formatJC(row.secondaryAmount)}
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
        <Notice message={notice.text} tone={notice.pending ? "pending" : notice.ok ? "success" : "error"} />
      )}
      {mode === "announcements" && (
        <>
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
            公告會自動翻譯成全部 16 種介面語言；翻譯未完成時不會發布。
          </p>
          <label className="grid gap-2 text-xs text-slate-400">
            貼上或輸入完整公告，系統會自動拆分標題與內容；也可用「標題：」「內容：」標記。
            <textarea
              value={announcementPaste}
              onChange={(event) => detectAnnouncementFields(event.target.value)}
              rows={3}
              aria-label="快速帶入完整公告"
              placeholder="標題：公告標題\n內容：公告完整內容"
              className="rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100"
            />
          </label>
          <p className="text-xs text-emerald-300/80">
            已自動帶入標題與公告內容欄位，可在下方修改後發布。
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
            {busy ? "發布中…" : "發布公告"}
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
                <time className="mt-2 block text-xs text-slate-500">
                  {new Date(item.created_at).toLocaleString()}
                </time>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={() => void toggle(item)}
                  className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold"
                >
                  {item.is_active ? "下架" : "重新上架"}
                </button>
                <button
                  onClick={() => void removeAnnouncement(item)}
                  aria-label={`刪除公告 ${item.title}`}
                  className="flex items-center gap-1.5 rounded-lg border border-rose-500/40 px-3 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-500/10"
                >
                  <Trash2 className="size-3.5" />
                  刪除
                </button>
              </div>
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
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Send className="size-5 text-sky-300" />
            <div>
              <h3 className="font-bold">新營運 Telegram 群組測試</h3>
              <p className="text-xs leading-5 text-slate-500">
                由獨立營運機器人設定 Webhook，並將測試訊息傳送至 TELEGRAM_OPS_CHAT_ID 指定的新群組；客服機器人不會接收群組播報。
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={telegramTesting}
            onClick={() => void testTelegramGroup()}
            className="shrink-0 rounded-xl border border-sky-400/50 px-4 py-2 text-sm font-bold text-sky-300 transition hover:bg-sky-400/10 disabled:opacity-50"
          >
            {telegramTesting ? "傳送中…" : "傳送測試"}
          </button>
        </div>
      </section>
      <section className="rounded-2xl border border-sky-500/25 bg-slate-900 p-5" aria-labelledby="admin-telegram-direct-title">
        <div className="flex items-start gap-3">
          <Send className="mt-0.5 size-5 shrink-0 text-sky-300" />
          <div>
            <h3 id="admin-telegram-direct-title" className="font-bold">Telegram 通知</h3>
            <p className="mt-1 text-xs leading-5 text-slate-400">
              可傳送給全部已連結用戶、指定創世紀層級群組，或單一用戶；每位收件人都會分別留下發送紀錄。
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-3">
          <label className="block text-sm text-slate-300">
            Telegram 收件對象
            <select
              value={telegramAudience}
              disabled={telegramSending}
              onChange={(event) => {
                setTelegramAudience(event.target.value as TelegramAudience);
                setTelegramRecipientId("");
                setTelegramRequestKey(null);
              }}
              className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100 disabled:opacity-50"
            >
              <option value="all">全部已連結用戶（{telegramRecipients.length} 人）</option>
              <option value="master_agent">創世紀L0（{telegramRecipients.filter((recipient) => isTelegramMasterRole(recipient.agencyRole)).length} 人）</option>
              <option value="agent">有下級（{telegramRecipients.filter((recipient) => isTelegramAgentRole(recipient.agencyRole)).length} 人）</option>
              <option value="individual">個別用戶</option>
            </select>
          </label>
          {telegramAudience === "individual" && (
            <label className="block text-sm text-slate-300">
              個別 Telegram 收件人
              <select
                value={telegramRecipientId}
                disabled={telegramSending}
                onChange={(event) => {
                  setTelegramRecipientId(event.target.value);
                  setTelegramRequestKey(null);
                }}
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100 disabled:opacity-50"
              >
                <option value="">選擇一位已連結用戶</option>
                {telegramRecipients.map((recipient) => (
                  <option key={recipient.id} value={recipient.id}>
                    {recipient.displayName ? `${recipient.displayName} · ` : ""}{recipient.email} · {recipient.agencyRole}{recipient.telegramUsername ? ` · @${recipient.telegramUsername}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          {telegramRecipientsError ? (
            <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{telegramRecipientsError}</p>
          ) : telegramRecipients.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-700 p-3 text-sm text-slate-500">目前沒有已連結 Telegram 的用戶。</p>
          ) : telegramAudience !== "individual" && telegramAudienceRecipients.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-700 p-3 text-sm text-slate-500">這個身分目前沒有已連結 Telegram 的用戶。</p>
          ) : null}
          <label className="block text-sm text-slate-300">
            訊息標題
            <input
              value={telegramDraft.title}
              onChange={(event) => updateTelegramDraft("title", event.target.value)}
              maxLength={120}
              placeholder="輸入通知標題"
              className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100"
            />
          </label>
          <label className="block text-sm text-slate-300">
            訊息內容
            <textarea
              value={telegramDraft.content}
              onChange={(event) => updateTelegramDraft("content", event.target.value)}
              maxLength={3500}
              rows={4}
              placeholder="輸入要傳送的 Telegram 通知內容"
              className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100"
            />
            <span className="mt-1 block text-right text-xs text-slate-500">{telegramDraft.content.length} / 3500</span>
          </label>
          <p className="rounded-lg border border-sky-500/25 bg-sky-500/10 px-3 py-2 text-xs leading-5 text-sky-200">
            發送前會再次確認對象與人數。管理員直接通知不受用戶的分潤、成交或市場提醒開關影響；每位收件人都會保留獨立稽核紀錄，部分失敗可用同一次發送安全重試。
          </p>
          <button
            type="button"
            disabled={telegramSending || telegramAudienceRecipients.length === 0 || (telegramAudience === "individual" && !telegramRecipientId) || !telegramDraft.title.trim() || !telegramDraft.content.trim()}
            onClick={() => void sendAdminTelegramMessage()}
            className="flex items-center justify-center gap-2 rounded-xl bg-sky-400 px-5 py-3 font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send className="size-4" />
            {telegramSending ? "傳送中…" : `傳送給 ${telegramAudienceRecipients.length} 位收件人`}
          </button>
        </div>
        <div className="mt-6 border-t border-slate-800 pt-5">
          <div className="flex items-center justify-between gap-3">
            <h4 className="font-semibold text-slate-200">Telegram 發送紀錄</h4>
            <span className="text-xs text-slate-500">最近 {telegramHistory.length} 筆</span>
          </div>
          {telegramHistory.length === 0 ? (
            <p className="mt-3 rounded-xl border border-dashed border-slate-700 px-4 py-5 text-center text-sm text-slate-500">尚無 Telegram 發送紀錄。</p>
          ) : (
            <div className="mt-3 grid gap-3">
              {telegramHistory.slice(0, 8).map((log) => {
                const status = log.status === "sent" ? "已送達" : log.status === "failed" ? "發送失敗" : log.status === "skipped" ? "未送出" : "處理中";
                const tone = log.status === "sent" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : log.status === "failed" ? "border-rose-500/30 bg-rose-500/10 text-rose-200" : "border-amber-500/30 bg-amber-500/10 text-amber-200";
                return (
                  <article key={log.id} className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="break-all text-sm font-semibold text-slate-100">{log.recipientLabel}</p>
                        <p className="mt-1 break-words text-sm text-slate-300">{log.title}</p>
                        <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-slate-500">{log.body}</p>
                        <time className="mt-2 block text-xs text-slate-600">{new Date(log.created_at).toLocaleString("zh-TW")}</time>
                      </div>
                      <span className={`w-fit shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold ${tone}`}>{status}</span>
                    </div>
                    {log.error_message && <p className="mt-2 break-words text-xs text-rose-300">{log.error_message}</p>}
                  </article>
                );
              })}
            </div>
          )}
        </div>
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
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <time>{new Date(item.created_at).toLocaleString()}</time>
                {item.background_push && (
                  <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-semibold text-amber-200">
                    已背景推播
                  </span>
                )}
              </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => void toggle(item)}
                      className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold"
                    >
                      {item.is_active ? "下架" : "重新上架"}
                    </button>
                    <button
                      onClick={() => void removeAnnouncement(item)}
                      aria-label={`刪除公告 ${item.title}`}
                      className="flex items-center gap-1.5 rounded-lg border border-rose-500/40 px-3 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-500/10"
                    >
                      <Trash2 className="size-3.5" />
                      刪除
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}
        </>
      )}
      {mode === "payouts" && (
        <>
      <div
        role="tablist"
        aria-label="分潤資產模式"
        className="inline-flex w-fit rounded-xl border border-slate-800 bg-slate-900 p-1"
      >
        {(
          [
            { key: "ae_coin", label: "AE" },
            { key: "rwa", label: "RWA" },
          ] as const
        ).map(({ key, label }) => (
          <button
            key={key}
            role="tab"
            aria-selected={assetMode === key}
            onClick={() => setAssetMode(key)}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
              assetMode === key
                ? "bg-amber-400 text-slate-950"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <CommissionOverrides key={assetMode} assetMode={assetMode} />
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-center gap-3">
          <Coins className="size-5 text-amber-300" />
          <div>
            <h3 className="font-bold">分潤設定</h3>
            <p className="text-xs text-slate-500">
              目前編輯模式：{assetMode === "ae_coin" ? "AE" : "RWA"}，兩個模式的比例互不影響
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {(
            [
{ role: "總代理直屬", label: "創世紀L0直屬", defP: 0.03, defS: 0, note: "私募：創世紀 L0 本人認購回饋，以及 L0 直接推薦的會員認購時 L0 所得。二級市場不適用（L0 本人買賣無回饋）。" },
      { role: "總代理", label: "創世紀L0透過下級", defP: 0.02, defS: 0.0013, note: "私募：下線的直屬上級（非 L0）所得。二級市場：賣出者的直屬上級（L1）所得，含 L0。" },
              { role: "代理", label: "L2 會員", defP: 0.01, defS: 0.0007, note: "私募與二級市場：賣出／買入者的上上級（L2 上線）所得。" },
            ] as const
          ).map(({ role, label, defP, defS, note }) => {
            const setting = settings.find(
              (s) => s.agency_role === role && s.asset_mode === assetMode,
            );
            const privateValue = (setting?.private_rate ?? defP) * 100;
            const secondaryValue = (setting?.secondary_rate ?? defS) * 100;
            return (
              <div
                key={`${role}-${assetMode}-${setting?.updated_at ?? "default"}`}
                className="rounded-xl bg-slate-950 p-4 text-sm"
              >
                <b>{label}分潤</b>
                <div className="mt-3 grid gap-3">
                  <label>
                    私募百分比
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      defaultValue={privateValue}
                      id={`private-${role}-${assetMode}`}
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
                      id={`secondary-${role}-${assetMode}`}
                      disabled={role === "總代理直屬"}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 p-2 disabled:opacity-40"
                    />
                  </label>
                  <p className="text-xs text-slate-400">{note}</p>
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
  <p className="mt-3 text-xs text-slate-500">
    報表僅統計 {TRANSACTION_HISTORY_START_LABEL} 起的新資料；歷史帳本保留，尚未派發的歷史分潤仍會列在下方派發清單。
  </p>
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
        <section className="mt-6 rounded-xl border border-sky-500/30 bg-slate-950/70 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <Send className="mt-1 size-5 shrink-0 text-sky-300" />
            <div>
              <h4 className="font-semibold text-slate-100">個別代理資產派發</h4>
              <p className="mt-1 text-xs leading-5 text-slate-400">
                從 ADMIN 熱錢包直接轉入代理已綁定的網站錢包。JC 會同步可用餘額；AE／RWA 會同步網站持倉，{STABLECOIN_SYMBOL} 餘額由鏈上即時讀取。
              </p>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block text-sm text-slate-300">
              選擇 L1／L2 會員
              <select
                value={payoutRecipientId}
                disabled={busy || payoutPending}
                onChange={(event) => void selectPayoutRecipient(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-3 text-sm text-slate-100 disabled:opacity-50"
              >
                <option value="">選擇 L1／L2 會員人員</option>
                {profiles
                  .filter((profile) => profile.agency_role === "總代理" || isAgentRole(profile.agency_role))
                  .sort((left, right) => left.email.localeCompare(right.email))
                  .map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.email} · {getGenesisRoleLabel(profile.agency_role)}
                    </option>
                  ))}
              </select>
            </label>
            <label className="block text-sm text-slate-300">
              派發資產
              <select
                value={payoutAsset}
                disabled={busy || payoutPending}
                onChange={(event) => {
                  setPayoutAsset(event.target.value as PayoutAsset);
                  setPayoutPlacementId("");
                  setPayoutPending(false);
                  setPayoutRequestKey(null);
                  setPayoutTxHash(null);
                }}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-3 text-sm text-slate-100"
              >
                <option value="jc">JC</option>
                <option value="ae">AE</option>
                <option value="rwa">RWA</option>
                <option value="usdt">{STABLECOIN_SYMBOL}</option>
              </select>
            </label>
          </div>
          <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900/80 p-3">
            <p className="text-xs text-slate-500">會員網站錢包地址</p>
            <p className="mt-1 break-all font-mono text-xs text-sky-100">
              {!payoutRecipientId
                ? "選擇 L1／L2 會員後自動顯示"
                : payoutWalletLoading
                  ? "正在載入錢包地址…"
                  : payoutWalletAddress || "此代理尚未綁定有效錢包"}
            </p>
          </div>
          {(payoutAsset === "ae" || payoutAsset === "rwa") && (
            <label className="mt-3 block text-sm text-slate-300">
              網站持倉標的
              <select
                value={payoutPlacementId}
                disabled={busy || payoutPending}
                onChange={(event) => {
                  setPayoutPlacementId(event.target.value);
                  setPayoutPending(false);
                  setPayoutRequestKey(null);
                  setPayoutTxHash(null);
                }}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-3 text-sm text-slate-100"
              >
                <option value="">選擇{payoutAsset.toUpperCase()}標的</option>
                {payoutAssetPlacements.map((placement) => (
                  <option key={placement.id} value={placement.id}>{placement.name}</option>
                ))}
              </select>
              {payoutAsset === "rwa" && payoutAssetPlacements.length === 0 && (
                <span className="mt-1 block text-xs text-amber-300">目前沒有已部署專屬代幣的 RWA 標的。</span>
              )}
            </label>
          )}
          <label className="mt-3 block text-sm text-slate-300">
            派發數量
            <div className="relative mt-1">
              <input
                type="number"
                min="0"
                step={payoutAsset === "rwa" ? "1" : "0.000001"}
                inputMode="decimal"
                value={payoutAmount}
                disabled={busy || payoutPending}
                onChange={(event) => {
                  setPayoutAmount(event.target.value);
                  setPayoutPending(false);
                  setPayoutRequestKey(null);
                  setPayoutTxHash(null);
                }}
                placeholder={payoutAsset === "rwa" ? "輸入整數份額" : "輸入數量，最多 6 位小數"}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-3 pr-16 text-sm text-slate-100 outline-none focus:border-sky-400"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500">{payoutAsset.toUpperCase()}</span>
            </div>
          </label>
          <button
            type="button"
            disabled={busy || payoutWalletLoading || !payoutRecipientId || !payoutWalletAddress || !payoutAmount || ((payoutAsset === "ae" || payoutAsset === "rwa") && !payoutPlacementId)}
            onClick={() => void sendIndividualPayout()}
            className="mt-4 w-full rounded-lg bg-sky-400 px-4 py-3 font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {busy ? "鏈上派發處理中…" : payoutRequestKey ? "確認／重試這筆派發" : "從熱錢包派發給此代理"}
          </button>
          {payoutTxHash && (
            <a
              href={explorerTxUrl(payoutTxHash)}
              target="_blank"
              rel="noreferrer"
              className="mt-3 block break-all text-xs text-sky-300 underline underline-offset-2"
            >
              查看鏈上交易：{payoutTxHash}
            </a>
          )}
        </section>
        <section className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 sm:p-5" aria-labelledby="individual-payout-history-title">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h4 id="individual-payout-history-title" className="font-semibold text-slate-100">個別派發紀錄</h4>
              <p className="mt-1 text-xs leading-5 text-slate-400">每 5 秒更新。只有顯示「鏈上已確認」才代表真的完成轉帳；等待中或沒有交易雜湊都不算成功。</p>
            </div>
              <span className="text-xs text-slate-500">最多顯示最近 5 筆</span>
          </div>
          {payoutHistoryError ? (
            <p role="alert" className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{payoutHistoryError}</p>
          ) : payoutHistory.length === 0 ? (
            <p className="mt-3 rounded-lg border border-dashed border-slate-800 p-4 text-sm text-slate-500">尚無個別派發紀錄。</p>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {payoutHistory.map((record) => {
                const ageMs = Date.now() - new Date(record.createdAt).getTime();
                const statusText = record.superseded
                  ? "已有後續派發完成 · 保留此筆紀錄"
                  : record.status === "confirmed"
                    ? record.accounted ? "派發完成" : "鏈上已確認 · 網站帳本待同步"
                    : record.status === "failed"
                      ? "派發失敗 · 未完成"
                      : record.txHash
                        ? "交易已送出 · 等待鏈上確認"
                        : "沒有交易雜湊 · 尚未確認派發";
                const statusClass = record.superseded || record.status === "confirmed"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                  : record.status === "failed"
                    ? "border-rose-500/30 bg-rose-500/10 text-rose-200"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-200";
                const canRetry = !record.superseded && (record.status === "failed" || (record.status === "pending" && !record.txHash && ageMs > 60_000));
                const canCheck = !record.superseded && ((record.status === "pending" && Boolean(record.txHash)) || (record.status === "confirmed" && !record.accounted));
                return (
                  <article key={record.id} className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="break-all text-sm font-medium text-slate-100">{record.recipientEmail ?? "管理帳號"}</p>
                        <p className="mt-1 text-sm text-sky-100">
                          {record.amount} {record.assetType.toUpperCase()}{record.placementName ? ` · ${record.placementName}` : ""}
                        </p>
                        <time className="mt-1 block text-xs text-slate-500">{new Date(record.createdAt).toLocaleString("zh-TW")}</time>
                      </div>
                      <div className="flex flex-col items-start gap-2 sm:items-end">
                        <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${statusClass}`}>{statusText}</span>
                        {canCheck && (
                          <button type="button" disabled={checkingPayoutId === record.id} onClick={() => void checkPayoutRecord(record)} className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 disabled:opacity-50">
                            {checkingPayoutId === record.id ? "查詢中…" : record.status === "confirmed" ? "重試網站帳本同步" : "查詢鏈上確認"}
                          </button>
                        )}
                        {canRetry && (
                          <button type="button" disabled={busy || retryingPayoutId === record.id} onClick={() => void retryPayoutRecord(record)} className="rounded-md border border-amber-500/40 px-3 py-1.5 text-xs font-semibold text-amber-200 disabled:opacity-50">
                            {retryingPayoutId === record.id ? "重新派發中…" : "重新派發（建立新紀錄）"}
                          </button>
                        )}
                      </div>
                    </div>
                    {record.txHash && (
                      <a href={explorerTxUrl(record.txHash)} target="_blank" rel="noreferrer" className="mt-2 block break-all text-xs text-sky-300 underline underline-offset-2">
                        查看鏈上交易：{record.txHash}
                      </a>
                    )}
                    {!record.superseded && record.error && <p className="mt-2 break-words text-xs text-rose-300">{record.error}</p>}
                  </article>
                );
              })}
            </div>
          )}
        </section>
        {stuckCommissions.length > 0 && (
          <div className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-4 shrink-0 text-amber-300" />
              <h4 className="font-semibold text-amber-100">卡住的分潤派發（{stuckCommissions.length}）</h4>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              這些分潤的結算卡在處理中、沒有交易雜湊，「全平台派發」不會重發它們（避免重複付款）。系統會先掃描鏈上有沒有相同轉帳、確認 ADMIN 沒有在途交易，通過才會發放；任何一項無法確證就停止。
            </p>
            <div className="mt-3 space-y-3">
              {stuckCommissions.map((item) => {
                const busyItem = verifyingCommissionId === item.commissionId;
                return (
                  <article key={item.commissionId} className="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
                    <p className="text-sm text-slate-200">
                      受益人：<b>{item.userLabel}</b> · 金額：<b>{formatJC(item.amount ?? 0)}</b>
                    </p>
                    <p className="mt-1 break-all font-mono text-xs text-slate-500">{item.commissionId}</p>
                    {item.error && <p className="mt-2 break-words text-xs text-rose-300">原因：{item.error}</p>}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busyItem}
                        onClick={() => void verifyAndPayCommission(item, true)}
                        className="rounded-lg border border-slate-600 px-3 py-2 text-xs font-bold text-slate-200 disabled:opacity-50"
                      >
                        僅核對鏈上（不付款）
                      </button>
                      <button
                        type="button"
                        disabled={busyItem}
                        onClick={() => void verifyAndPayCommission(item, false)}
                        className="rounded-lg bg-amber-400 px-3 py-2 text-xs font-bold text-slate-950 disabled:opacity-50"
                      >
                        {busyItem ? "處理中…" : "核對並發放"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        )}
        <div className="mt-6 rounded-xl border border-rose-500/30 bg-rose-500/5 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <AlertTriangle className="size-4 shrink-0 text-rose-300" />
              <h4 className="font-semibold text-rose-100">獎金派發錯誤需要沖正</h4>
            </div>
            {discrepancies.length > 0 && (
              <button
                type="button"
                disabled={reversing || selectedReversals.length === 0}
                onClick={() => void reverseSelected(selectedReversals)}
                className="shrink-0 rounded-lg bg-rose-400 px-3 py-2 text-xs font-bold text-slate-950 disabled:opacity-40"
              >
                一鍵沖正（{selectedReversals.length}）
              </button>
            )}
          </div>
          {discrepancies.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">
              目前沒有派發錯誤，所有已派發分潤與實際入帳金額一致。（此處只比對「已派發」的金額；尚未派發的待發放分潤不算錯誤，不會出現在這裡。）
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="text-slate-500">
                    <th className="p-2">選取</th>
                    <th>推廣人員</th>
                    <th>應派發</th>
                    <th>實際入帳</th>
                    <th>錯誤原因</th>
                  </tr>
                </thead>
                <tbody>
                  {discrepancies.map((item) => {
                    const over = item.diff > 0;
                    const gap = Math.abs(item.diff);
                    return (
                      <tr
                        key={item.beneficiary_id}
                        className="border-t border-slate-800 align-top"
                      >
                        <td className="p-2">
                          <input
                            type="checkbox"
                            aria-label={`選取 ${item.email ?? item.beneficiary_id}`}
                            checked={selectedReversals.includes(item.beneficiary_id)}
                            onChange={(event) =>
                              setSelectedReversals((items) =>
                                event.target.checked
                                  ? [...items, item.beneficiary_id]
                                  : items.filter((id) => id !== item.beneficiary_id),
                              )
                            }
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <div className="break-all font-medium text-slate-200">
                            {item.nickname || item.display_name || item.email || item.beneficiary_id}
                          </div>
                          <div className="text-xs text-slate-500">{item.agency_role || "—"}</div>
                        </td>
                        <td className="py-2 pr-3 text-slate-300">{money(item.owed)}</td>
                        <td className="py-2 pr-3 text-slate-300">{money(item.paid)}</td>
                        <td className="py-2 pr-3">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-bold ${
                              over
                                ? "bg-amber-400/15 text-amber-200"
                                : "bg-rose-400/15 text-rose-200"
                            }`}
                          >
                            {over ? "多發" : "少發"} {money(gap)}
                          </span>
                          <div className="mt-1 text-xs text-slate-500">
                            {over
                              ? `實際入帳比應派發多 ${money(gap)}，沖正將扣回站內帳本（鏈上多發的 JC 無法自動回收）`
                              : `實際入帳比應派發少 ${money(gap)}，沖正將由平台熱錢包上鏈補發差額`}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
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
        </>
      )}
    </div>
  );
}
