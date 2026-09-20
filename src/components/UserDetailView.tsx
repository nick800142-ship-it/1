import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ArrowLeft, CalendarDays, Filter, Wallet } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { formatJC, formatUnit } from "@/platform";
import { useOnChainUsdtBalance } from "@/lib/onchainUsdt";
import {
  useTokenOnChainBalance,
  useErc20BalancesSum,
  fetchErc20BalanceByAddress,
} from "@/lib/onchainContracts";

const money = (value: number) =>
  `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;

const number = (value: number | null) =>
  value == null
    ? "—"
    : value.toLocaleString("en-US", { maximumFractionDigits: 6 });

// 鏈上代幣持有量顯示：完全依鏈上 balanceOf 的原始數量，最多保留 6 位小數
// （與錢包 App 一致，不做任何站內帳本換算）。
const formatTokenAmount = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 6 });

type Profile = {
  id: string;
  email: string;
  display_name: string | null;
  nickname: string | null;
  agency_role: string | null;
  wallet_address: string | null;
  account_status: string | null;
  funds_frozen_at: string | null;
  funds_seized_at: string | null;
  funds_seized_amount: number | string | null;
};

type SourceFilter = "all" | "commission" | "trade" | "holding";
type AssetFilter = "all" | "rwa" | "ae";

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

// 「直屬會員資料」與「分潤」業績只排除「代理／總代理」這種代理層級身分本身，
// 不排除其他身分。特別注意：`agency_role = "admin"` 只代表帳號擁有後台權限，
// 只要其 referrer_id/parent_id 指向某位總代理，它就是該總代理真實的直屬會員
// （例如去發狗同時是 admin、又掛在摔狗底下），其交易必須計入該總代理的直屬
// 會員業績，不能因為身分是 admin 就被當成系統測試帳號排除。
const AGENT_ROLES = new Set(["總代理", "代理", "一代代理", "二代代理"]);

const transactionTypeLabel: Record<string, string> = {
  private_purchase: "私募認購",
  secondary_buy: "二級市場買入",
  secondary_sell: "二級市場賣出",
  p2p_buy: "二級市場買入",
  p2p_sell: "二級市場賣出",
  private: "私募分潤",
  secondary: "二級市場分潤",
  // 金庫買 JC 與贖回佇列（申請時先扣 JC，被拒絕時退回 JC）。
  vault_buy: "金庫買入 JC",
  redemption_pending: "申請贖回 JC",
  redemption_refund: "贖回退回 JC",
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
  // 分潤金額的凍結 AE 快照（來自 commission_logs.commission_amount_ae）。
  // 交易紀錄列沒有快照，為 null，需以即時 AE 價換算。
  amountAe: number | null;
  fee: number | null;
  asset: string;
  quantity: number | null;
  buyer: string | null;
  buyerId: string | null;
  buyerRole: string | null;
  purchaseAmount: number | null;
  // 交易金額（業績）的凍結 AE 快照（commission_logs.transaction_amount_ae）。
  purchaseAmountAe: number | null;
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

// 全站金額一律以 JC 顯示（分潤與交易金額皆已直接以 JC 記錄於 jc_ledger /
// commission_logs）。
const categoryUnit = (_category: TurnoverCategory | null): "ae" | "usdt" | "jc" =>
  "jc";

type LedgerRow = {
  id: string;
  entry_type:
    | "private_purchase"
    | "secondary_buy"
    | "secondary_sell"
    | "p2p_buy"
    | "p2p_sell"
    | "vault_buy"
    | "redemption_pending"
    | "redemption_refund";
  amount: number | string;
  quantity: number | string | null;
  asset_id: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

type SimpleTurnoverRow = {
  turnoverCategory: TurnoverCategory | null;
  purchaseAmount: number;
  createdAt: string;
  // 交易的擁有者（賣方/買方）id，用來在「分潤」頁排除直屬會員的貢獻。
  ownerId?: string | null;
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
  user_id?: string | null;
};

type CommissionRow = {
  id: string;
  transaction_type: string;
  commission_amount: number | string;
  transaction_amount: number | string;
  commission_rate: number | string;
  commission_amount_ae: number | string | null;
  transaction_amount_ae: number | string | null;
  display_currency: "ae" | "usdt" | null;
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

// 二級市場（含站內掛牌 secondary_* 與 P2P p2p_*）的一筆成交會同時在買方與
// 賣方各留下一筆 asset_ledger 紀錄。「業績」只計入賣方賣出的成交金額，買入
// 不計算，否則同一筆撮合會被買賣雙方各算一次而讓總業績灌水一倍。
// 私募認購（private_purchase）沒有對應賣方，維持原樣全額計入。
function resolveTurnoverCategory(
  entryType:
    | "private_purchase"
    | "secondary_buy"
    | "secondary_sell"
    | "p2p_buy"
    | "p2p_sell"
    | "vault_buy"
    | "redemption_pending"
    | "redemption_refund",
  isAeToken: boolean,
): TurnoverCategory | null {
  if (entryType === "private_purchase") {
    return isAeToken ? "ae_purchase" : "rwa_purchase";
  }
  if (entryType === "secondary_sell" || entryType === "p2p_sell") {
    return isAeToken ? "ae_secondary" : "rwa_secondary";
  }
  return null;
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
  // USDT 是真實鏈上資產（Base Sepolia 測試網），直接依錢包地址讀鏈上餘額，
  // 不再用內部沙盒帳本 RPC 加總。
  const { balance } = useOnChainUsdtBalance(profile?.wallet_address);
  // JC / AE 是單一 ERC-20 合約，直接依錢包地址讀鏈上 balanceOf；RWA 於 Factory
  // 模式下每個標的各一顆專屬代幣，需依動態地址清單加總。全部完全依鏈上錢包顯示。
  const { balance: jcOnChain } = useTokenOnChainBalance("jcToken", profile?.wallet_address);
  const { balance: aeOnChain } = useTokenOnChainBalance("aeToken", profile?.wallet_address);
  const [rwaTokenAddresses, setRwaTokenAddresses] = useState<string[]>([]);
  const { balance: rwaOnChain } = useErc20BalancesSum(rwaTokenAddresses, profile?.wallet_address);
  // 「持有資產」檢視：逐標的顯示該用戶錢��在每顆 RWA 專屬代幣的鏈上持有份額。
  const [rwaHoldingsMeta, setRwaHoldingsMeta] = useState<
    { name: string; address: string }[]
  >([]);
  const [rwaPerHolding, setRwaPerHolding] = useState<
    { name: string; address: string; amount: number }[]
  >([]);
  // 可用 JC 一律以站內 jc_ledger 為準（與用戶錢包頁的 get_my_jc_balance 一致）。
  // 鏈上 JC 餘額（新版合約 balanceOf）在「JC 不再上鏈」的架構下已與站內帳本脫鉤、
  // 會顯示偏高的舊值，故這裡改讀 admin_get_jc_balance（sum 除 commission_pending 外全部）。
  const [ledgerJc, setLedgerJc] = useState(0);
  useEffect(() => {
    if (!userId) {
      setLedgerJc(0);
      return;
    }
    let cancelled = false;
    void supabase
      .rpc("admin_get_jc_balance", { p_user_id: userId })
      .then(({ data }) => {
        if (!cancelled) setLedgerJc(Number(data ?? 0));
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);
  const walletForHoldings = profile?.wallet_address ?? null;
  useEffect(() => {
    if (!walletForHoldings || rwaHoldingsMeta.length === 0) {
      setRwaPerHolding([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const parts = await Promise.all(
        rwaHoldingsMeta.map(async (meta) => ({
          name: meta.name,
          address: meta.address,
          amount: await fetchErc20BalanceByAddress(meta.address, walletForHoldings),
        })),
      );
      if (!cancelled) setRwaPerHolding(parts);
    };
    void load();
    const timer = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [walletForHoldings, rwaHoldingsMeta]);
  const [rows, setRows] = useState<DetailRow[]>([]);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [assetFilter, setAssetFilter] = useState<AssetFilter>("all");
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
  // 「分潤」頁籤二級市場「總業績」改看下線的「賣出量」，需另外撈下線的賣出
  // ledger（commission_logs 只記錄觸發分潤的買入，撈不到賣出）。
  const [commissionSellRows, setCommissionSellRows] = useState<
    SimpleTurnoverRow[]
  >([]);
  // 總代理的直屬會員 id 集合，用來把直屬會員的業績/分潤從「分潤」頁移到
  // 「直屬會員資料」頁分開呈現。
  const [directMemberIds, setDirectMemberIds] = useState<string[]>([]);
  // 白名單／黑名單（凍結、回收資金、恢復）操作狀態。
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusNotice, setStatusNotice] = useState<{
    text: string;
    ok: boolean;
  } | null>(null);

  // 業績/交易金額與分潤皆已直接以 JC 記錄，無需換算（保留 passthrough 以維持
  // 既有計算流程）。
  const toAe = useCallback((jc: number) => jc, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");

    const [
      profileResult,
      commissionResult,
      tradeResult,
      assetsResult,
      profilesResult,
    ] = await Promise.all([
      supabase
        .from("profiles")
        .select(
          "id,email,display_name,nickname,agency_role,wallet_address,account_status,funds_frozen_at,funds_seized_at,funds_seized_amount",
        )
        .eq("id", userId)
        .maybeSingle(),
      supabase
        .from("commission_logs")
        .select(
          "id,transaction_type,commission_amount,transaction_amount,commission_rate,commission_amount_ae,transaction_amount_ae,display_currency,asset_id,source_user_id,buyer_id,source_ledger_id,created_at",
        )
        .eq("beneficiary_id", userId),
      supabase
        .from("jc_ledger")
        .select("id,entry_type,amount,quantity,asset_id,created_at,metadata")
        .eq("user_id", userId)
        .in("entry_type", [
          "private_purchase",
          "secondary_buy",
          "secondary_sell",
          "p2p_buy",
          "p2p_sell",
          "vault_buy",
          "redemption_pending",
          "redemption_refund",
        ]),
      supabase.from("private_placements").select("id,name,is_ae_token,token_address"),
      supabase
        .from("profiles")
        .select(
          "id,email,display_name,nickname,agency_role,balance,created_at,referrer_id,parent_id",
        ),
    ]);

    const firstError =
      profileResult.error ??
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

    const assetsData = (assetsResult.data ?? []) as {
      id: string;
      name: string;
      is_ae_token: boolean | null;
      token_address: string | null;
    }[];
    // RWA Factory 模式下每個 RWA 標的各有一顆專屬 ERC-20（AE 標的除外，AE 統一
    // 使用單一 aeToken 合約，不在此列）。收集所有已回填 token_address 的 RWA 標的
    // 代幣地址，供錢包持有量加總查詢。
    setRwaTokenAddresses(
      assetsData
        .filter((asset) => !asset.is_ae_token && asset.token_address)
        .map((asset) => asset.token_address as string),
    );
    setRwaHoldingsMeta(
      assetsData
        .filter((asset) => !asset.is_ae_token && asset.token_address)
        .map((asset) => ({
          name: asset.name,
          address: asset.token_address as string,
        })),
    );
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
    const profileRoleById = new Map(
      profiles.map((item) => [item.id, item.agency_role]),
    );

    // 直屬會員的定義：由「總代理本人」直接推薦（referrer_id 指向本人）的一般
    // 會員，才算直屬會員。若某會員的推薦人是「代理」，代表他屬於代理線下的
    // 用戶（例：RWMT 由代理『風生水起』推薦，雖然 parent_id/master_agent_id
    // 仍指向總代理，但他是代理線用戶），這種要歸類到「分潤」而非「直屬會員」。
    // 規則：排除代理層級身分本身；排除推薦人為「代理」者；直屬＝推薦人就是本
    // 總代理，或無推薦人但直接歸屬於本總代理（parent_id 指向本人）。
    const directMemberIds =
      targetProfile?.agency_role === "總代理"
        ? profiles
            .filter((member) => {
              if (AGENT_ROLES.has(member.agency_role)) return false;
              const referrerRole = member.referrer_id
                ? profileRoleById.get(member.referrer_id)
                : null;
              // 推薦人是代理 → 代理線下用戶，不算直屬會員。
              if (referrerRole === "代理") return false;
              return (
                member.referrer_id === targetProfile.id ||
                (!member.referrer_id && member.parent_id === targetProfile.id)
              );
            })
            .map((member) => member.id)
        : [];
    setDirectMemberIds(directMemberIds);

    const directMemberTradeResult = directMemberIds.length
      ? await supabase
          .from("jc_ledger")
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
          .from("jc_ledger")
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

    // 「分潤」頁籤二級市場業績依規則改看下線的「賣出量」。下線範圍與
    // commission_logs 一致（買方/來源用戶集合，含次級代理底下成員），並排除
    // 受益人本人（本人賣出屬於個人業績，不算下線業績）。
    const commissionDownlineIds = Array.from(
      new Set(
        commissionRowsRaw
          .map((row) => row.source_user_id ?? row.buyer_id)
          .filter((id): id is string => Boolean(id) && id !== userId),
      ),
    );
    const downlineSellResult = commissionDownlineIds.length
      ? await supabase
          .from("jc_ledger")
          .select("entry_type,amount,asset_id,created_at,metadata,user_id")
          .in("user_id", commissionDownlineIds)
          .in("entry_type", ["secondary_sell", "p2p_sell"])
      : { data: [] as DirectMemberLedgerRow[], error: null };
    if (downlineSellResult.error) {
      setError("無法載入用戶紀錄，請稍後再試。");
      setLoading(false);
      return;
    }

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
          amountAe:
            row.commission_amount_ae == null
              ? null
              : Number(row.commission_amount_ae),
          fee: null,
          asset: row.asset_id
            ? assetNames.get(row.asset_id) ?? row.asset_id
            : "—",
          quantity: sourceTrade?.quantity == null ? null : Number(sourceTrade.quantity),
          buyer: buyerId ? profileNames.get(buyerId) ?? "未知用戶" : "未知用戶",
          buyerId: buyerId ?? null,
          buyerRole: buyerId ? profileRoleById.get(buyerId) ?? null : null,
          purchaseAmount: Number(row.transaction_amount),
          purchaseAmountAe:
            row.transaction_amount_ae == null
              ? null
              : Number(row.transaction_amount_ae),
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
      const turnoverCategory = resolveTurnoverCategory(
        row.entry_type,
        isAeToken,
      );
      return {
        id: `trade-${row.id}`,
        source: "交易紀錄" as const,
        type: transactionTypeLabel[row.entry_type] ?? row.entry_type,
        amount: Number(row.amount),
        amountAe: null,
        fee,
        asset: row.asset_id
          ? assetNames.get(row.asset_id) ?? row.asset_id
          : row.entry_type === "vault_buy" ||
              row.entry_type === "redemption_pending" ||
              row.entry_type === "redemption_refund"
            ? "JC 金庫兌換"
            : "—",
        quantity: row.quantity == null ? null : Number(row.quantity),
        buyer: null,
        buyerId: null,
        buyerRole: null,
        purchaseAmount: gross || Math.abs(Number(row.amount)) - fee,
        purchaseAmountAe: null,
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
          const turnoverCategory = resolveTurnoverCategory(
            row.entry_type,
            isAeToken,
          );
          return {
            turnoverCategory,
            purchaseAmount: gross || Math.abs(Number(row.amount)) - fee,
            createdAt: row.created_at,
          } satisfies SimpleTurnoverRow;
        },
      ),
    );

    setCommissionSellRows(
      ((downlineSellResult.data ?? []) as DirectMemberLedgerRow[]).map((row) => {
        const gross = metadataNumber(row.metadata, "gross");
        const fee = metadataNumber(row.metadata, "fee");
        const isAeToken = row.asset_id
          ? assetIsAeToken.get(row.asset_id) ?? false
          : false;
        const turnoverCategory = resolveTurnoverCategory(
          row.entry_type,
          isAeToken,
        );
        return {
          turnoverCategory,
          purchaseAmount: gross || Math.abs(Number(row.amount)) - fee,
          createdAt: row.created_at,
          ownerId: row.user_id ?? null,
        } satisfies SimpleTurnoverRow;
      }),
    );

    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const runStatusAction = useCallback(
    async (action: "freeze" | "reclaim" | "restore") => {
      if (statusBusy) return;
      const labels = {
        freeze: "凍結帳號（列入黑名單）",
        reclaim: "回收帳號內全部 JC 資金並凍結",
        restore: "恢復為白名單",
      } as const;
      if (!window.confirm(`確定要${labels[action]}？`)) return;
      setStatusBusy(true);
      setStatusNotice(null);
      const rpc =
        action === "freeze"
          ? "admin_freeze_account"
          : action === "reclaim"
            ? "admin_reclaim_account_funds"
            : "admin_restore_whitelist";
      const { error: rpcError } = await supabase.rpc(rpc, {
        p_user_id: userId,
      });
      setStatusBusy(false);
      if (rpcError) {
        setStatusNotice({ text: `操作失敗：${rpcError.message}`, ok: false });
        return;
      }
      setStatusNotice({
        text:
          action === "freeze"
            ? "已凍結帳號並列入黑名單"
            : action === "reclaim"
              ? "已回收帳號內 JC 資金並凍結帳號"
              : "已恢復為白名單",
        ok: true,
      });
      void load();
    },
    [load, statusBusy, userId],
  );

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
      const matchesAsset =
        assetFilter === "all" ||
        (assetFilter === "rwa" &&
          (row.turnoverCategory === "rwa_purchase" ||
            row.turnoverCategory === "rwa_secondary")) ||
        (assetFilter === "ae" &&
          (row.turnoverCategory === "ae_purchase" ||
            row.turnoverCategory === "ae_secondary"));
      const time = new Date(row.createdAt).getTime();
      return matchesSource && matchesAsset && time >= start && time <= end;
    });
  }, [assetFilter, endDate, rows, sourceFilter, startDate]);

  const turnoverTotals = useMemo(() => {
    const totals: Record<TurnoverCategory, number> = {
      rwa_purchase: 0,
      rwa_secondary: 0,
      ae_purchase: 0,
      ae_secondary: 0,
    };
    for (const row of filteredRows) {
      if (row.source !== "交易紀錄" || !row.turnoverCategory) continue;
      const raw = Math.abs(row.purchaseAmount ?? 0);
      totals[row.turnoverCategory] +=
        categoryUnit(row.turnoverCategory) === "ae" ? toAe(raw) : raw;
    }
    return totals;
  }, [filteredRows, toAe]);

  // 「分潤」頁籤顯示下線帶來的業績與分潤，並扣除：
  //   1) 自己投資產生的自我分潤（buyerId === 自己）；
  //   2) 直屬會員的貢獻（buyerId ∈ directMemberIds）——這部分改在「直屬會員資料」
  //      頁單獨呈現，避免同一筆業績/分潤在兩個頁籤重複���示。
  // 業績（總業績）依標的物型態採不同口徑：
  //   - 認購（rwa_purchase / ae_purchase）：業績＝觸發分潤的買入金額，直接取自
  //     commission_logs（認購只在買入時產生分潤）。
  //   - 二級市場（rwa_secondary / ae_secondary）：業績＝下線的「賣出成交量」
  //     （gross），改由 commissionSellRows（下線賣出 ledger）依日期彙總。
  // 「分潤金額」一律取自 commission_logs 實際發生的分潤，與業績口徑分開計算。
  const commissionTurnoverTotals = useMemo(() => {
    const start = startDate
      ? new Date(`${startDate}T00:00:00`).getTime()
      : Number.NEGATIVE_INFINITY;
    const end = endDate
      ? new Date(`${endDate}T23:59:59.999`).getTime()
      : Number.POSITIVE_INFINITY;
    const directSet = new Set(directMemberIds);
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
      if (row.buyerId && directSet.has(row.buyerId)) continue;
      const cat = row.turnoverCategory;
      const unit = categoryUnit(cat);
      // 認購業績取自買入金額；二級市場業績改由賣出量計算（見下方），此處不累加。
      if (cat === "rwa_purchase" || cat === "ae_purchase") {
        const bizUsdt = Math.abs(row.purchaseAmount ?? 0);
        // 認購業績源自 commission_logs，優先用凍結 AE 快照。
        totals[cat].business +=
          unit === "ae"
            ? row.purchaseAmountAe ?? toAe(bizUsdt)
            : bizUsdt;
      }
      const commUsdt = Math.abs(row.amount);
      totals[cat].commission +=
        unit === "ae" ? row.amountAe ?? toAe(commUsdt) : commUsdt;
    }
    // 二級市場總業績＝下線賣出成交量（gross），依所選日期區間彙總；同樣排除
    // 直屬會員的賣出（改列在「直屬會員資料」頁）。賣出量源自 ledger，無凍結
    // 快照，二級市場一律 AE，以即時 AE 價換算。
    for (const row of commissionSellRows) {
      if (!row.turnoverCategory) continue;
      if (row.ownerId && directSet.has(row.ownerId)) continue;
      const time = new Date(row.createdAt).getTime();
      if (time < start || time > end) continue;
      const raw = Math.abs(row.purchaseAmount);
      totals[row.turnoverCategory].business +=
        categoryUnit(row.turnoverCategory) === "ae" ? toAe(raw) : raw;
    }
    return totals;
  }, [filteredRows, profile, commissionSellRows, directMemberIds, startDate, endDate, toAe]);

  // 「直屬會員資料」頁的分潤金額：受益人（本人）從直屬會員交易所賺得的分潤，
  // 依 RWA/AE × 認購/二級市場 分類。資料來自 commission_logs（buyerId ∈ 直屬會員）。
  const directMemberCommissionTotals = useMemo(() => {
    const directSet = new Set(directMemberIds);
    const totals: Record<TurnoverCategory, number> = {
      rwa_purchase: 0,
      rwa_secondary: 0,
      ae_purchase: 0,
      ae_secondary: 0,
    };
    for (const row of filteredRows) {
      if (row.source !== "分潤" || !row.turnoverCategory) continue;
      if (!row.buyerId || !directSet.has(row.buyerId)) continue;
      const commUsdt = Math.abs(row.amount);
      totals[row.turnoverCategory] +=
        categoryUnit(row.turnoverCategory) === "ae"
          ? row.amountAe ?? toAe(commUsdt)
          : commUsdt;
    }
    return totals;
  }, [filteredRows, directMemberIds, toAe]);

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
      const commUsdt = Math.abs(row.amount);
      totals[row.turnoverCategory] +=
        categoryUnit(row.turnoverCategory) === "ae"
          ? row.amountAe ?? toAe(commUsdt)
          : commUsdt;
    }
    return totals;
  }, [filteredRows, profile, toAe]);

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
      if (!row.turnoverCategory) continue;
      const time = new Date(row.createdAt).getTime();
      if (time < start || time > end) continue;
      const raw = Math.abs(row.purchaseAmount);
      totals[row.turnoverCategory] +=
        categoryUnit(row.turnoverCategory) === "ae" ? toAe(raw) : raw;
    }
    return totals;
  }, [directMemberTradeRows, endDate, startDate, toAe]);

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
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <Info label="Email" value={profile?.email ?? "—"} />
          <Info label="代理身分" value={profile?.agency_role || "一般用戶"} />
        </div>
        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
          <p className="text-xs font-bold tracking-wider text-amber-300">
            鏈上錢包持有（即時）
          </p>
          <p className="mt-1 text-xs text-slate-500 break-all">
            {profile?.wallet_address
              ? `錢包地址：${profile.wallet_address}`
              : "此用戶尚未綁定鏈上錢包地址"}
          </p>
          <div className="mt-4 grid gap-3 grid-cols-2 lg:grid-cols-4">
            <HoldingCell label="USDT" value={formatTokenAmount(balance)} />
            <HoldingCell label="JC" value={formatTokenAmount(jcOnChain)} />
            <HoldingCell label="AE" value={formatTokenAmount(aeOnChain)} />
            <HoldingCell
              label="RWA"
              value={
                rwaTokenAddresses.length === 0
                  ? "—"
                  : formatTokenAmount(rwaOnChain)
              }
              hint={
                rwaTokenAddresses.length === 0
                  ? "尚無標的部署專屬代幣"
                  : `${rwaTokenAddresses.length} 檔標的加總`
              }
            />
          </div>
        </div>
        {(() => {
          const isBlacklisted = profile?.account_status === "blacklist";
          const seized = Number(profile?.funds_seized_amount ?? 0);
          return (
            <div className="mt-5 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-slate-400">
                    帳號狀態
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-bold ${
                      isBlacklisted
                        ? "bg-red-500/15 text-red-300"
                        : "bg-emerald-500/15 text-emerald-300"
                    }`}
                  >
                    {isBlacklisted ? "黑名單（已凍結）" : "白名單（正常）"}
                  </span>
                  {seized > 0 && (
                    <span className="text-xs text-slate-500">
                      已回收 {formatJC(seized)}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {isBlacklisted ? (
                    <button
                      type="button"
                      disabled={statusBusy}
                      onClick={() => runStatusAction("restore")}
                      className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition hover:border-emerald-400 disabled:opacity-50"
                    >
                      恢復白名單
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={statusBusy}
                        onClick={() => runStatusAction("freeze")}
                        className="rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs font-semibold text-amber-300 transition hover:border-amber-400 disabled:opacity-50"
                      >
                        凍結（列黑名單）
                      </button>
                      <button
                        type="button"
                        disabled={statusBusy}
                        onClick={() => runStatusAction("reclaim")}
                        className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs font-semibold text-red-300 transition hover:border-red-400 disabled:opacity-50"
                      >
                        凍結並回收資金
                      </button>
                    </>
                  )}
                </div>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                黑名單帳號無法進行認購、二級掛單／成交、金庫買 JC 與贖回等資金操作。「回收資金」會將帳號內全部可用 JC 一次沖銷。
              </p>
              {statusNotice && (
                <p
                  className={`mt-2 text-xs font-semibold ${
                    statusNotice.ok ? "text-emerald-300" : "text-red-300"
                  }`}
                >
                  {statusNotice.text}
                </p>
              )}
            </div>
          );
        })()}
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
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
                <option value="holding">持有資產</option>
              </select>
            </span>
          </label>
          <label className="text-xs font-medium text-slate-400">
            資產類別
            <span className="relative mt-2 flex items-center">
              <Filter className="pointer-events-none absolute left-3 size-4 text-slate-500" />
              <select
                value={assetFilter}
                onChange={(event) =>
                  setAssetFilter(event.target.value as AssetFilter)
                }
                className="w-full appearance-none rounded-xl border border-slate-700 bg-slate-950 py-3 pr-8 pl-9 text-sm text-slate-200"
              >
                <option value="all">全部</option>
                <option value="rwa">RWA</option>
                <option value="ae">AE</option>
              </select>
            </span>
          </label>
        </div>
        {(startDate || endDate || sourceFilter !== "all" || assetFilter !== "all") && (
          <button
            type="button"
            onClick={() => {
              setStartDate("");
              setEndDate("");
              setSourceFilter("all");
              setAssetFilter("all");
            }}
            className="mt-3 text-xs font-semibold text-amber-300 hover:text-amber-200"
          >
            清除篩選
          </button>
        )}
      </div>

      {sourceFilter !== "holding" && (
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
            顯示所選區間內，總代理所有直屬會員（不含代理身分）加總的交易金額，以及本人從這些直屬會員賺得的分潤金額。
          </p>
        )}
        {turnoverView === "commission" && (
          <p className="text-xs text-slate-500">
            顯示所選區間內，來自下線的業績與分潤（不含直屬會員，直屬會員請見「直屬會員資料」頁）。
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
                unit={categoryUnit("rwa_purchase")}
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.rwa_secondary}
                primaryLabel="總業績"
                primaryValue={commissionTurnoverTotals.rwa_secondary.business}
                secondaryLabel="分潤金額"
                secondaryValue={commissionTurnoverTotals.rwa_secondary.commission}
                unit={categoryUnit("rwa_secondary")}
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.ae_purchase}
                primaryLabel="總業績"
                primaryValue={commissionTurnoverTotals.ae_purchase.business}
                secondaryLabel="分潤金額"
                secondaryValue={commissionTurnoverTotals.ae_purchase.commission}
                unit={categoryUnit("ae_purchase")}
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.ae_secondary}
                primaryLabel="總業績"
                primaryValue={commissionTurnoverTotals.ae_secondary.business}
                secondaryLabel="分潤金額"
                secondaryValue={commissionTurnoverTotals.ae_secondary.commission}
                unit={categoryUnit("ae_secondary")}
              />
            </>
          ) : turnoverView === "direct_members" && isMasterAgent ? (
            <>
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.rwa_purchase}
                primaryLabel="交易金額"
                primaryValue={directMemberTotals.rwa_purchase}
                secondaryLabel="分潤金額"
                secondaryValue={directMemberCommissionTotals.rwa_purchase}
                unit={categoryUnit("rwa_purchase")}
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.rwa_secondary}
                primaryLabel="交易金額"
                primaryValue={directMemberTotals.rwa_secondary}
                secondaryLabel="分潤金額"
                secondaryValue={directMemberCommissionTotals.rwa_secondary}
                unit={categoryUnit("rwa_secondary")}
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.ae_purchase}
                primaryLabel="交易金額"
                primaryValue={directMemberTotals.ae_purchase}
                secondaryLabel="分潤金額"
                secondaryValue={directMemberCommissionTotals.ae_purchase}
                unit={categoryUnit("ae_purchase")}
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.ae_secondary}
                primaryLabel="交易金額"
                primaryValue={directMemberTotals.ae_secondary}
                secondaryLabel="分潤金額"
                secondaryValue={directMemberCommissionTotals.ae_secondary}
                unit={categoryUnit("ae_secondary")}
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
                unit={categoryUnit("rwa_purchase")}
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.rwa_secondary}
                primaryLabel="個人業績"
                primaryValue={turnoverTotals.rwa_secondary}
                secondaryLabel="分潤金額"
                secondaryValue={personalCommissionTotals.rwa_secondary}
                unit={categoryUnit("rwa_secondary")}
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.ae_purchase}
                primaryLabel="個人業績"
                primaryValue={turnoverTotals.ae_purchase}
                secondaryLabel="分潤金額"
                secondaryValue={personalCommissionTotals.ae_purchase}
                unit={categoryUnit("ae_purchase")}
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.ae_secondary}
                primaryLabel="個人業績"
                primaryValue={turnoverTotals.ae_secondary}
                secondaryLabel="分潤金額"
                secondaryValue={personalCommissionTotals.ae_secondary}
                unit={categoryUnit("ae_secondary")}
              />
            </>
          )}
        </div>
      </div>
      )}

      {sourceFilter === "holding" && (
        <HoldingsPanel
          walletAddress={walletForHoldings}
          jc={ledgerJc}
          usdt={balance}
          ae={aeOnChain}
          rwaHoldings={rwaPerHolding}
        />
      )}

      {sourceFilter !== "holding" && (
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
                      {row.purchaseAmount == null
                        ? "—"
                        : formatJC(row.purchaseAmount)}
                    </td>
                    <td
                      className={`whitespace-nowrap px-5 py-3 font-semibold ${row.amount >= 0 ? "text-emerald-300" : "text-rose-300"}`}
                    >
                      {formatJC(row.amount)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-slate-300">
                      {row.source === "分潤"
                        ? row.rate == null
                          ? "—"
                          : `${(row.rate * 100).toLocaleString("en-US", { maximumFractionDigits: 4 })}%`
                        : formatJC(row.fee ?? 0)}
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
      )}
    </section>
  );
}

function HoldingsPanel({
  walletAddress,
  jc,
  usdt,
  ae,
  rwaHoldings,
}: {
  walletAddress: string | null;
  jc: number;
  usdt: number;
  ae: number;
  rwaHoldings: { name: string; address: string; amount: number }[];
}) {
  const heldRwa = rwaHoldings.filter((holding) => Number(holding.amount) > 0);
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex items-center gap-3">
        <Wallet className="size-5 text-amber-300" />
        <div>
          <h3 className="font-bold">持有資產（即時鏈上）</h3>
          <p className="break-all text-xs text-slate-500">
            {walletAddress
              ? `錢包地址：${walletAddress}`
              : "此用戶尚未綁定鏈上錢包地址"}
          </p>
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
          <p className="text-xs text-slate-500">可用 JC（站內帳本）</p>
          <p className="mt-1 text-2xl font-bold text-sky-300">
            {formatTokenAmount(Number(jc) || 0)}{" "}
            <span className="text-sm text-slate-500">JC</span>
          </p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
          <p className="text-xs text-slate-500">可用 USDT</p>
          <p className="mt-1 text-2xl font-bold text-emerald-300">
            {formatTokenAmount(Number(usdt) || 0)}{" "}
            <span className="text-sm text-slate-500">USDT</span>
          </p>
        </div>
      </div>
      <div className="mt-5">
        <p className="text-xs font-bold tracking-wider text-amber-300">
          持倉資產
        </p>
        <p className="mt-1 text-xs text-slate-500">
          依錢包鏈上 balanceOf 即時顯示。
        </p>
        <div className="mt-3 flex flex-col gap-2">
          <HoldingRow name="AE 代幣" amount={Number(ae) || 0} unit="AE" />
          {heldRwa.length === 0 ? (
            <p className="text-xs text-slate-500">目前無 RWA 標的鏈上持倉。</p>
          ) : (
            heldRwa.map((holding) => (
              <HoldingRow
                key={holding.address}
                name={holding.name}
                amount={holding.amount}
                unit="份"
              />
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function HoldingRow({
  name,
  amount,
  unit,
}: {
  name: string;
  amount: number;
  unit: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
      <span className="text-sm text-slate-300">{name}</span>
      <span className="text-sm font-semibold text-slate-100">
        {formatTokenAmount(amount)}{" "}
        <span className="text-xs text-slate-500">{unit}</span>
      </span>
    </div>
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

function MetricCard({
  label,
  primaryLabel,
  primaryValue,
  secondaryLabel,
  secondaryValue,
  unit,
}: {
  label: string;
  primaryLabel: string;
  primaryValue: number;
  secondaryLabel: string;
  secondaryValue: number;
  // 卡片金額顯示單位。AE 認購維持 "usdt"，其餘 "ae"。傳入的數值皆已換算成
  // 對應單位（AE 業績以即時價換算、AE 分潤取凍結快照）。
  unit: "ae" | "usdt" | "jc";
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <p className="text-xs font-bold tracking-wider text-amber-300">
        {label}
      </p>
      <p className="mt-2 text-xs text-slate-500">{primaryLabel}</p>
      <p className="break-all text-lg font-bold text-slate-100">
        {formatUnit(primaryValue, unit)}
      </p>
      <p className="mt-2 text-xs text-slate-500">{secondaryLabel}</p>
      <p className="break-all text-lg font-bold text-emerald-300">
        {formatUnit(secondaryValue, unit)}
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

function HoldingCell({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl bg-slate-950 p-4">
      <p className="text-xs font-semibold text-slate-400">{label}</p>
      <p className="mt-1 break-all text-lg font-bold text-slate-100">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>}
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
