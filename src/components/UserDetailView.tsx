import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ArrowLeft, CalendarDays, Filter, Wallet } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { getGenesisRoleLabel } from "@/lib/roleLabels";
import { formatJC, formatUnit, localizedUiText, useLanguage } from "@/platform";
import useSWR from "swr";
import { fetchOnChainUsdtTransfers, useOnChainUsdtBalance } from "@/lib/onchainUsdt";
import {
  CONTRACT_INFO_VISIBLE_AFTER,
  isTransactionHistoryVisible,
  TRANSACTION_HISTORY_START_LABEL,
  USER_TRANSACTION_ENTRY_TYPES,
} from "@/lib/transactionHistory";
import {
  buildWalletTransactions,
  type WalletLedgerRow,
  type WalletTownRow,
} from "@/lib/walletTransactions";
import {
  useTokenOnChainBalance,
  useErc20BalancesSum,
  fetchErc20BalanceByAddress,
  getCurrentRwaFactoryToken,
} from "@/lib/onchainContracts";
import { explorerTxUrl, NETWORK_LABEL } from "@/lib/network";

// 鏈上代幣持有量顯示：完全依鏈上 balanceOf 的原始數量，最多保留 6 位小數
// （與錢包 App 一致，不做任何站內帳本換算）。
const formatTokenAmount = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 6 });

function OnChainUsdtHistory({ walletAddress }: { walletAddress: string | null }) {
  const { language } = useLanguage();
  const { data: transfers = [], error, isLoading } = useSWR(
    walletAddress ? `admin-usdt-transfer-history:${walletAddress.toLowerCase()}` : null,
    () => fetchOnChainUsdtTransfers(walletAddress),
    { refreshInterval: 30_000, revalidateOnFocus: true },
  );

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
      <div className="mb-3">
        <h3 className="text-sm font-bold text-slate-200">{localizedUiText(language, "온체인 USDT 받음", "鏈上 USDT 轉入／轉出")}</h3>
        <p className="mt-1 text-xs text-slate-500">{NETWORK_LABEL} · {localizedUiText(language, "신규 기록만 표시", `僅顯示 ${TRANSACTION_HISTORY_START_LABEL}（台北時間）起的新紀錄`)}</p>
      </div>
      {error ? (
        <p role="status" className="text-sm text-amber-300">鏈上轉帳紀錄暫時無法載入，稍後會自動重試。</p>
      ) : isLoading ? (
        <p className="text-sm text-slate-500">載入鏈上轉帳紀錄…</p>
      ) : !walletAddress ? (
        <p className="text-sm text-slate-500">此用戶尚未綁定鏈上錢包地址。</p>
      ) : transfers.length === 0 ? (
        <p className="text-sm text-slate-500">目前沒有新的 USDT 轉入或轉出。</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-2 pr-3">{localizedUiText(language, "방향", "方向")}</th>
                <th className="py-2 pr-3">{localizedUiText(language, "금액", "金額")}</th>
                <th className="py-2 pr-3">{localizedUiText(language, "상대 주소", "對手地址")}</th>
                <th className="py-2 pr-3">{localizedUiText(language, "시간", "時間")}</th>
                <th className="py-2">{localizedUiText(language, "온체인 거래", "鏈上交易")}</th>
              </tr>
            </thead>
            <tbody>
              {transfers.map((transfer) => (
                <tr key={transfer.id} className="border-t border-slate-800">
                  <td className={`py-2 pr-3 ${transfer.direction === "incoming" ? "text-emerald-300" : "text-rose-300"}`}>
                    {transfer.direction === "incoming" ? localizedUiText(language, "온체인 USDT 받음", "轉入") : localizedUiText(language, "온체인 USDT 보냄", "轉出")}
                  </td>
                  <td className="py-2 pr-3 font-semibold">{formatTokenAmount(transfer.amount)} USDT</td>
                  <td className="py-2 pr-3 font-mono text-xs text-slate-400">{transfer.counterparty ? `${transfer.counterparty.slice(0, 8)}…${transfer.counterparty.slice(-6)}` : "—"}</td>
                  <td className="py-2 pr-3 text-slate-400">{new Date(transfer.createdAt).toLocaleString()}</td>
                  <td className="py-2 font-mono text-xs">
                    <a href={explorerTxUrl(transfer.hash)} target="_blank" rel="noreferrer" className="text-sky-300 hover:underline">
                      {transfer.hash.slice(0, 12)}…
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

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
  p2p_listing_fee: "掛單手續費",
  refund: "認購退款",
  private: "私募分潤",
  secondary: "二級市場分潤",
  // 金庫買 JC 與贖回佇列（申請時先扣 JC，被拒絕時退回 JC）。
  vault_buy: "金庫買入 JC",
  vault_redeem: "金庫贖回 JC",
  admin_payout: "管理員入帳",
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
  unitPrice: number | null;
  // 交易金額（業績）的凍結 AE 快照（commission_logs.transaction_amount_ae）。
  purchaseAmountAe: number | null;
  rate: number | null;
  createdAt: string;
  turnoverCategory: TurnoverCategory | null;
  bonusType: "l1" | "l2" | null;
  currency?: "jc" | "usdt" | "ae";
  };

const TURNOVER_CATEGORY_LABEL: Record<TurnoverCategory, string> = {
  rwa_purchase: "RWA認購",
  rwa_secondary: "RWA二級市場",
  ae_purchase: "AE認購",
  ae_secondary: "AE二級市場",
};

// 全站金額一律以 JC 顯示（分潤與交易金額皆已直接�� JC 記錄於 jc_ledger /
// commission_logs）。
const categoryUnit = (): "jc" | "ae" => "jc";

type LedgerRow = {
  id: string;
  entry_type: string;
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
  bonus_type: "l1" | "l2" | null;
};

function profileName(
  profile?: Pick<Profile, "nickname" | "display_name" | "email">,
) {
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
// 賣方各留���一筆 asset_ledger 紀錄。「業績」只計入賣方賣出的成交金額，買入
// 不計算，否則同一筆撮合會被買賣雙方各算一次而讓總業績灌水一倍。
// 私募認購（private_purchase）沒有對應賣方，維持原樣全額計入。
function resolveTurnoverCategory(
  entryType: string,
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
  const [jcLedgerBalance, setJcLedgerBalance] = useState<number | null>(null);
  // USDT 是真實鏈上資產（Base Sepolia 測試網），直接依錢包地址讀鏈上餘額，
  // 不再用內部沙盒帳本 RPC 加總。
  const { balance } = useOnChainUsdtBalance(profile?.wallet_address);
  // JC / AE 是單一 ERC-20 合約，直接依錢包地址讀鏈上 balanceOf；RWA 於 Factory
  // 模式下每個標的各一顆專屬代幣，需依動態地址清單加總。全部完全依鏈上錢包顯示。
  const {
    balance: jcOnChain,
    loading: jcOnChainLoading,
    error: jcOnChainError,
  } = useTokenOnChainBalance("jcToken", profile?.wallet_address);
  const { balance: aeOnChain } = useTokenOnChainBalance("aeToken", profile?.wallet_address);
  const [aePrice, setAePrice] = useState<number | null>(null);
  const [rwaTokenAddresses, setRwaTokenAddresses] = useState<string[]>([]);
  const { balance: rwaOnChain } = useErc20BalancesSum(rwaTokenAddresses, profile?.wallet_address);
  // 「持有資產」檢視：逐標的顯示該用戶錢包在每顆 RWA 專屬代幣的鏈上持有份額。
  const [rwaHoldingsMeta, setRwaHoldingsMeta] = useState<
    { name: string; address: string; price: number; averageBuy: number | null }[]
  >([]);
  const [rwaPerHolding, setRwaPerHolding] = useState<
{ name: string; address: string; price: number; averageBuy: number | null; amount: number }[]
  >([]);
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
          price: meta.price,
          averageBuy: meta.averageBuy,
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
  // 與用戶錢包「交易紀錄」一致：錢包同時列出鏈上 USDT 轉入／轉出。
  const { data: chainUsdtTransfers = [] } = useSWR(
    walletForHoldings
      ? `admin-detail-usdt-transfers:${walletForHoldings.toLowerCase()}`
      : null,
    () => fetchOnChainUsdtTransfers(walletForHoldings),
    { refreshInterval: 30_000, revalidateOnFocus: true },
  );
  const allRows = useMemo<DetailRow[]>(() => {
    const chainRows = chainUsdtTransfers.map(
      (transfer) =>
        ({
          id: `trade-${transfer.id}`,
          source: "交易紀錄",
          type: transfer.direction === "incoming" ? "鏈上 USDT 轉入" : "鏈上 USDT 轉出",
          amount: transfer.direction === "incoming" ? transfer.amount : -transfer.amount,
          amountAe: null,
          fee: 0,
          asset: transfer.counterparty
            ? `USDT · ${transfer.counterparty.slice(0, 8)}…${transfer.counterparty.slice(-4)}`
            : "USDT",
          quantity: null,
          unitPrice: null,
          buyer: null,
          buyerId: null,
          buyerRole: null,
          purchaseAmount: null,
          purchaseAmountAe: null,
          rate: null,
          createdAt: transfer.createdAt,
          turnoverCategory: null,
          bonusType: null,
          currency: "usdt",
        }) satisfies DetailRow,
    );
    return [...rows, ...chainRows].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [rows, chainUsdtTransfers]);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("trade");
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
  // 依推薦鏈層級的會員集合：L1 = 本人直接推薦，L2 = L1 的下線。
  const [levelMemberIds, setLevelMemberIds] = useState<{
    l1: string[];
    l2: string[];
  }>({ l1: [], l2: [] });
  const [, setDirectMemberIds] = useState<string[]>([]);
  // 白名單／黑名單（凍結、回收資金、恢復）操作狀態。
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusNotice, setStatusNotice] = useState<{
    text: string;
    ok: boolean;
  } | null>(null);

  // 業績/交易金額與分潤皆已直接以 JC 記錄，無需換算（保留 passthrough 以維持
  // ���有計算流程）。
  const toAe = useCallback((jc: number) => jc, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setJcLedgerBalance(null);

  const [
  profileResult,
  commissionResult,
  tradeResult,
  jcBalanceResult,
  assetsResult,
  profilesResult,
  marketPriceResult,
  marketOrderResult,
  townResult,
  walletJcResult,
  walletAssetLedgerResult,
  walletPlacementsResult,
  walletSettlementsResult,
  ] = await Promise.all([
      supabase
        .from("profiles")
        .select(
          "id,email,display_name,nickname,agency_role,wallet_address,account_status,funds_frozen_at,funds_seized_at,funds_seized_amount",
        )
        .eq("id", userId)
        .maybeSingle(),
      fetchAllRows((rangeFrom, rangeTo) =>
        supabase
          .from("commission_logs")
          .select(
            "id,transaction_type,commission_amount,transaction_amount,commission_rate,commission_amount_ae,transaction_amount_ae,display_currency,asset_id,source_user_id,buyer_id,source_ledger_id,bonus_type,created_at",
          )
          .eq("beneficiary_id", userId)
          .order("id")
          .range(rangeFrom, rangeTo),
      ),
      fetchAllRows((rangeFrom, rangeTo) =>
        supabase
          .from("jc_ledger")
          .select("id,entry_type,amount,quantity,asset_id,created_at,metadata")
          .eq("user_id", userId)
          .in("entry_type", USER_TRANSACTION_ENTRY_TYPES)
          .order("id")
          .range(rangeFrom, rangeTo),
      ),
      fetchAllRows((rangeFrom, rangeTo) =>
        supabase
          .from("jc_ledger")
          .select("id,entry_type,amount")
          .eq("user_id", userId)
          .order("id")
          .range(rangeFrom, rangeTo),
      ),
      supabase
        .from("private_placements")
        .select("id,name,is_ae_token,price,last_traded_price"),
      fetchAllRows((rangeFrom, rangeTo) =>
        supabase
          .from("profiles")
          .select(
            "id,email,display_name,nickname,agency_role,balance,created_at,referrer_id,parent_id",
          )
          .order("id")
          .range(rangeFrom, rangeTo),
      ),
      supabase
  .from("p2p_escrow_fills")
  .select("asset_id,price,created_at")
  .order("created_at", { ascending: false }),
  supabase
  .from("p2p_orders")
  .select("asset_id,price,created_at,status")
  .in("status", ["open", "partially_filled", "filled"])
  .order("created_at", { ascending: false }),
  supabase.rpc("admin_get_user_wallet_town_transactions", { p_user_id: userId }),
      // 以下四個來源與用戶錢包完全相同，交給共用的 buildWalletTransactions 組裝。
      fetchAllRows((rangeFrom, rangeTo) =>
        supabase
          .from("jc_ledger")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .order("id")
          .range(rangeFrom, rangeTo),
      ),
      fetchAllRows((rangeFrom, rangeTo) =>
        supabase
          .from("asset_ledger")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .order("id")
          .range(rangeFrom, rangeTo),
      ),
      supabase
        .from("private_placements")
        .select("id,name,translations,updated_at,is_ae_token")
        .gte("updated_at", CONTRACT_INFO_VISIBLE_AFTER),
      supabase
        .from("onchain_settlements")
        .select("ref_key,status,tx_hash,error,updated_at")
        .eq("user_id", userId)
        .in("action", ["subscribe", "trade", "redeem", "mint_jc"])
        .order("updated_at", { ascending: false })
        .limit(500),
  ]);

    const firstError =
      profileResult.error ??
      commissionResult.error ??
      tradeResult.error ??
      assetsResult.error ??
      profilesResult.error ??
      walletJcResult.error ??
      walletAssetLedgerResult.error ??
      walletPlacementsResult.error ??
      townResult.error;
    if (firstError) {
      setError("無法載入用戶紀錄，請稍後再試。");
      setLoading(false);
      return;
    }

    const targetProfile = profileResult.data as Profile | null;
    setProfile(targetProfile);
    if (!jcBalanceResult.error) {
      const balanceRows = (jcBalanceResult.data ?? []) as { entry_type: string; amount: number | string }[];
      setJcLedgerBalance(
        balanceRows.reduce(
          (total, row) => total + (row.entry_type === "commission_pending" ? 0 : Number(row.amount)),
          0,
        ),
      );
    }

    const assetsData = (assetsResult.data ?? []) as {
      id: string;
      name: string;
      is_ae_token: boolean | null;
      price: number | string | null;
      last_traded_price: number | string | null;
    }[];
    const purchaseTotals = new Map<string, { amount: number; quantity: number }>();
    for (const row of (tradeResult.data ?? []) as LedgerRow[]) {
      if (!row.asset_id || !["private_purchase", "secondary_buy", "p2p_buy"].includes(row.entry_type)) continue;
      const quantity = Math.abs(Number(row.quantity ?? metadataNumber(row.metadata, "quantity")));
      const amount = Math.abs(Number(row.amount));
      if (quantity <= 0 || amount <= 0) continue;
      const total = purchaseTotals.get(row.asset_id) ?? { amount: 0, quantity: 0 };
      total.amount += amount;
      total.quantity += quantity;
      purchaseTotals.set(row.asset_id, total);
    }
    const marketBookResults = await Promise.all(
      assetsData.map(async (asset) => {
        const { data } = await supabase.rpc("get_p2p_order_book", {
          asset_key: asset.id,
        });
        return ((data ?? []) as { asset_id?: string; price?: number | string; created_at?: string }[]).map((row) => ({
          ...row,
          asset_id: row.asset_id ?? asset.id,
        }));
      }),
    );
    const latestMarketPrices = new Map<string, { price: number; createdAt: number }>();
    const marketRows = [
      ...marketBookResults.flat(),
      ...((marketPriceResult.data ?? []) as { asset_id: string; price: number | string; created_at: string }[]),
      ...((marketOrderResult.data ?? []) as { asset_id: string; price: number | string; created_at: string }[]),
    ].filter(
      (row): row is { asset_id: string; price: number | string; created_at: string } =>
        Boolean(row.asset_id && row.price != null && row.created_at),
    ).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    for (const row of marketRows) {
      if (!latestMarketPrices.has(row.asset_id)) {
        latestMarketPrices.set(row.asset_id, { price: Number(row.price), createdAt: Date.parse(row.created_at) });
      }
    }
    const currentAeAsset = assetsData.find((asset) => asset.is_ae_token);
    const currentAePrice = currentAeAsset
      ? Number(currentAeAsset.last_traded_price ?? currentAeAsset.price ?? 0) || null
      : null;
    setAePrice(currentAePrice);
    const currentRwaTokenResults = await Promise.all(
      assetsData
        .filter((asset) => !asset.is_ae_token)
        .map(async (asset) => {
          try {
            const address = await getCurrentRwaFactoryToken(asset.id);
            const purchase = purchaseTotals.get(asset.id);
            return address ? {
              name: asset.name,
              address: String(address),
              price: Number(asset.price ?? 0),
              averageBuy: purchase && purchase.quantity > 0 ? purchase.amount / purchase.quantity : null,
            } : null;
          } catch {
            return null;
          }
        }),
    );
    const currentRwaTokens = currentRwaTokenResults.flatMap((asset) =>
      asset ? [asset] : [],
    );
    setRwaTokenAddresses(currentRwaTokens.map((asset) => asset.address));
    setRwaHoldingsMeta(currentRwaTokens);
    const assetNames = new Map(
      assetsData.map((asset) => [asset.id, asset.is_ae_token ? "AE" : asset.name]),
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

    // L1 = 本人直接推薦的會員；L2 = L1 會員直接推薦的會員（依推薦鏈，不分身分）。
    // 與資料庫 commission_logs 的 l1 / l2 受益人鏈一致。
    const l1Ids = profiles
      .filter((member) => member.id !== userId && member.referrer_id === userId)
      .map((member) => member.id);
    const l1IdSet = new Set(l1Ids);
    const l2Ids = profiles
      .filter(
        (member) =>
          member.id !== userId &&
          !l1IdSet.has(member.id) &&
          member.referrer_id != null &&
          l1IdSet.has(member.referrer_id),
      )
      .map((member) => member.id);
    setLevelMemberIds({ l1: l1Ids, l2: l2Ids });
    const levelIds = [...l1Ids, ...l2Ids];

    const directMemberTradeResult = levelIds.length
      ? await fetchAllRows((rangeFrom, rangeTo) =>
          supabase
            .from("jc_ledger")
            .select("id,entry_type,amount,asset_id,created_at,metadata,user_id")
            .in("user_id", levelIds)
            .in("entry_type", ["private_purchase", "secondary_sell", "p2p_sell"])
            .order("id")
            .range(rangeFrom, rangeTo),
        )
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
      ? await fetchAllRows(async (rangeFrom, rangeTo) => {
          const ids = sourceLedgerIds.slice(rangeFrom, rangeTo + 1);
          if (ids.length === 0) return { data: [] as LedgerRow[], error: null };
          return supabase
            .from("jc_ledger")
            .select("id,entry_type,amount,quantity,asset_id,created_at,metadata")
            .in("id", ids);
        }, 200)
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
        const sourceQuantity =
          sourceTrade?.quantity ??
          sourceTrade?.metadata?.quantity ??
          sourceTrade?.metadata?.fill_quantity ??
          sourceTrade?.metadata?.match_quantity;
        const parsedSourceQuantity = Number(sourceQuantity);
        const quantity =
          sourceQuantity != null &&
          Number.isFinite(parsedSourceQuantity) &&
          parsedSourceQuantity !== 0
            ? Math.abs(parsedSourceQuantity)
            : null;
        const purchaseAmount = Number(row.transaction_amount);
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
          quantity,
          unitPrice:
            quantity != null && quantity > 0 && purchaseAmount > 0
              ? purchaseAmount / quantity
              : null,
          buyer: buyerId ? profileNames.get(buyerId) ?? "未知用戶" : "未知用戶",
          buyerId: buyerId ?? null,
          buyerRole: buyerId ? profileRoleById.get(buyerId) ?? null : null,
          purchaseAmount,
          purchaseAmountAe:
            row.transaction_amount_ae == null
              ? null
              : Number(row.transaction_amount_ae),
          rate: Number(row.commission_rate),
          createdAt: row.created_at,
          turnoverCategory,
          bonusType: row.bonus_type ?? null,
        } satisfies DetailRow;
      },
    );

    const staticAssets = new Map(
      (
        (assetsResult.data ?? []) as {
          id: string;
          name: string;
          is_ae_token: boolean | null;
        }[]
      ).map(
        (asset) =>
          [
            asset.id,
            { id: asset.id, name: asset.name, isAeToken: asset.is_ae_token === true },
          ] as const,
      ),
    );
    const walletLanguage = document.documentElement.lang || "zh-TW";
    const walletBuilt = buildWalletTransactions({
      jcLedger: (walletJcResult.data ?? []) as WalletLedgerRow[],
      assetLedger: (walletAssetLedgerResult.data ?? []) as WalletLedgerRow[],
      townRows: (Array.isArray(townResult.data) ? townResult.data : []) as WalletTownRow[],
      commissionLogs: commissionRowsRaw,
      placements: walletPlacementsResult.data ?? [],
      settlements: walletSettlementsResult.data ?? [],
      staticAssets,
      language: walletLanguage,
      localize: (_korean, chinese) => chinese,
    });
    const statusLabel: Record<string, string> = {
      pending: "待處理",
      failed: "失敗",
      cancelled: "已取消",
    };
    const usdtTypeLabel: Record<string, string> = {
      sandbox_deposit: "測試 USDT 入帳",
      vault_redeem_jc: "金庫贖回 USDT",
    };
    const walletRows = walletBuilt.transactions.map((tx) => {
      const entryType = tx.entryType ?? "";
      const isTown = entryType === "town_ae";
      const baseLabel = isTown
        ? "小鎮找到 AE"
        : entryType === "town_bomb"
          ? "RWMT 炸彈罰款"
          : transactionTypeLabel[entryType] ?? usdtTypeLabel[entryType] ?? entryType;
      let suffix = "";
      if (isTown) {
        suffix = tx.status === "confirmed" ? "（已發放）" : "（待發放）";
      } else if (tx.status && tx.status !== "confirmed") {
        suffix = " · " + (statusLabel[tx.status] ?? tx.status);
      }
      const quantity = tx.quantity ?? null;
      const isUsdt = tx.currency === "usdt";
      return {
        id: "trade-" + tx.id,
        source: "交易紀錄" as const,
        type: baseLabel + suffix,
        amount: tx.net,
        amountAe: null,
        fee: tx.fee,
        asset: tx.asset,
        quantity,
        unitPrice:
          !isUsdt && quantity != null && quantity > 0
            ? tx.gross / quantity
            : null,
        buyer: null,
        buyerId: null,
        buyerRole: null,
        purchaseAmount: isTown ? 0 : tx.gross,
        purchaseAmountAe: null,
        rate: null,
        createdAt: tx.createdAt,
        turnoverCategory:
          isTown || isUsdt
            ? null
            : resolveTurnoverCategory(entryType, tx.isAeAsset === true),
        bonusType: null,
        currency: isUsdt ? ("usdt" as const) : tx.currency === "ae" ? ("ae" as const) : undefined,
      } satisfies DetailRow;
    });

    setRows(
      [...commissionRows, ...walletRows].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    );

    setDirectMemberTradeRows(
      ((directMemberTradeResult.data ?? []) as DirectMemberLedgerRow[]).map(
        (row) => {
          const gross = metadataNumber(row.metadata, "gross");
  const isAeToken = row.asset_id
            ? assetIsAeToken.get(row.asset_id) ?? false
            : false;
          const turnoverCategory = resolveTurnoverCategory(
            row.entry_type,
            isAeToken,
          );
          return {
            turnoverCategory,
            purchaseAmount: gross || Math.abs(Number(row.amount)),
            createdAt: row.created_at,
            ownerId: row.user_id ?? null,
          } satisfies SimpleTurnoverRow;
        },
      ),
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
    return allRows.filter((row) => {
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
      return (
        matchesSource &&
        matchesAsset &&
        isTransactionHistoryVisible(row.createdAt) &&
        time >= start &&
        time <= end
      );
    });
  }, [assetFilter, endDate, allRows, sourceFilter, startDate]);
  const visibleRows = useMemo(
    () => filteredRows.filter((row) => isTransactionHistoryVisible(row.createdAt)),
    [filteredRows],
  );

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
        categoryUnit() === "ae" ? toAe(raw) : raw;
    }
    return totals;
  }, [filteredRows, toAe]);

  // L1 / L2 業績與分潤依推薦鏈層級計算，與資料庫 commission_logs 的 bonus_type 一致：
  //   - 業績 = 該層級會員在所選區間內的認購金額 + 二級市場賣出成交量（RWA / AE 分開）。
  //   - 分潤 = 本人在 commission_logs 中 bonus_type 為 l1 / l2 的實際分潤金額。
  const levelTotals = useMemo(() => {
    const start = startDate
      ? new Date(`${startDate}T00:00:00`).getTime()
      : Number.NEGATIVE_INFINITY;
    const end = endDate
      ? new Date(`${endDate}T23:59:59.999`).getTime()
      : Number.POSITIVE_INFINITY;
    const l1Set = new Set(levelMemberIds.l1);
    const l2Set = new Set(levelMemberIds.l2);
    const empty = (): Record<TurnoverCategory, number> => ({
      rwa_purchase: 0,
      rwa_secondary: 0,
      ae_purchase: 0,
      ae_secondary: 0,
    });
    const business = { l1: empty(), l2: empty() };
    const commission = { l1: empty(), l2: empty() };
    for (const row of directMemberTradeRows) {
      if (!row.turnoverCategory || !row.ownerId) continue;
      const time = new Date(row.createdAt).getTime();
      if (
        !isTransactionHistoryVisible(row.createdAt) ||
        time < start ||
        time > end
      ) continue;
      const level = l1Set.has(row.ownerId)
        ? "l1"
        : l2Set.has(row.ownerId)
          ? "l2"
          : null;
      if (!level) continue;
      business[level][row.turnoverCategory] += Math.abs(row.purchaseAmount);
    }
    for (const row of filteredRows) {
      if (row.source !== "分潤" || !row.turnoverCategory) continue;
      if (row.bonusType !== "l1" && row.bonusType !== "l2") continue;
      commission[row.bonusType][row.turnoverCategory] += Math.abs(row.amount);
    }
    return { business, commission };
  }, [directMemberTradeRows, filteredRows, levelMemberIds, startDate, endDate]);


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
        categoryUnit() === "ae"
          ? row.amountAe ?? toAe(commUsdt)
          : commUsdt;
    }
    return totals;
  }, [filteredRows, profile, toAe]);

  const isAgent =
    profile?.agency_role === "總代理" || profile?.agency_role === "代理";

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
          <Info label="創世紀層級" value={getGenesisRoleLabel(profile?.agency_role)} />
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
          {jcOnChainError && profile?.wallet_address && (
            <p role="status" className="mt-2 text-xs text-amber-300">
              JC 餘額暫時無法讀取。
            </p>
          )}
          <div className="mt-4 grid gap-3 grid-cols-2 lg:grid-cols-4">
            <HoldingCell label="USDT" value={formatTokenAmount(balance)} />
            <HoldingCell
              label="JC"
              value={
                !profile?.wallet_address
                  ? "—"
                  : jcOnChainLoading
                    ? "讀取中…"
                    : jcOnChainError
                      ? "讀取失敗"
                      : formatTokenAmount(jcOnChain)
              }
            />
            <HoldingCell label="AE" value={formatTokenAmount(aeOnChain)} />
  <HoldingCell
  label="RWA 持倉總價值"
  value={
  rwaTokenAddresses.length === 0
  ? "—"
  : `${formatTokenAmount(rwaOnChain)} 份`
  }
  hint="份額取用戶錢包鏈上持有量；現價取全市場最新二級成交價"
  />
  <div className="col-span-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3 lg:col-span-4">
  <p className="text-xs font-bold text-sky-300">RWA／AE 錢包持倉市值（JC）</p>
  {rwaPerHolding.length === 0 ? (
  <p className="mt-2 text-sm text-slate-500">尚無已部署 RWA 代幣或鏈上持倉。</p>
  ) : (
  <div className="mt-2 space-y-2">
  {rwaPerHolding.filter((holding) => holding.amount > 0).map((holding) => (
  <div key={holding.address} className="flex items-center justify-between gap-3 rounded-lg bg-slate-900 px-3 py-2 text-sm">
  <span className="min-w-0 truncate text-slate-300">{holding.name}</span>
  <span className="shrink-0 text-right font-semibold text-white">{formatTokenAmount(holding.amount)} 份 · 現價 {holding.price > 0 ? formatJC(holding.price) : "尚無二級成交價"} · 持倉市值 {holding.price > 0 ? formatJC(holding.amount * holding.price) : "—"}</span>
  </div>
  ))}
  {aeOnChain > 0 && (
  <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-900 px-3 py-2 text-sm">
  <span className="text-slate-300">AE</span>
  <span className="font-semibold text-white">{formatTokenAmount(aeOnChain)} 份 · 現價 {aePrice === null ? "尚無二級成交價" : formatJC(aePrice)} · 持倉市值 {aePrice === null ? "—" : formatJC(aeOnChain * aePrice)}</span>
  </div>
  )}
  <div className="flex items-center justify-between border-t border-slate-800 pt-2 text-sm font-bold">
  <span>錢包持倉市值總計</span>
  <span className="text-amber-300">{formatJC(rwaPerHolding.reduce((total, holding) => total + holding.amount * holding.price, 0) + (aePrice === null ? 0 : aeOnChain * aePrice))}</span>
  </div>
  </div>
  )}
  </div>
          </div>
          <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-3">
            <p className="text-xs font-bold text-amber-300">JC 餘額對帳</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              站內帳本餘額排除待發放分潤；鏈上數字是錢包即時持有量，兩者差異需依鏈上收付與結算紀錄逐筆核對。
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <HoldingCell
                label="站內可用 JC"
                value={jcLedgerBalance == null ? "讀取失敗" : formatTokenAmount(jcLedgerBalance)}
              />
              <HoldingCell
                label="鏈上 JC"
                value={jcOnChainLoading ? "讀取中…" : jcOnChainError ? "讀取失敗" : formatTokenAmount(jcOnChain)}
              />
            </div>
            {jcLedgerBalance != null && !jcOnChainLoading && !jcOnChainError && Math.abs(jcOnChain - jcLedgerBalance) >= 0.0000005 && (
              <p role="status" className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs leading-5 text-amber-200">
                差額 {formatTokenAmount(Math.abs(jcOnChain - jcLedgerBalance))} JC（鏈上{jcOnChain > jcLedgerBalance ? "多" : "少"}於站內帳本）。請先核對人工補發與 JC 收付結算，不要直接改寫交易帳本。
              </p>
            )}
          </div>
        </div>
        <OnChainUsdtHistory walletAddress={profile?.wallet_address ?? null} />
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
              日期區間包含開始日與結束資料資料。
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
            L1分潤
          </ToggleButton>
            <ToggleButton
              active={turnoverView === "direct_members"}
              onClick={() => setTurnoverView("direct_members")}
            >
              L2分潤
            </ToggleButton>
          </div>
        )}
        {turnoverView === "direct_members" && (
          <p className="text-xs text-slate-500">
            顯示所選區間內，L1 會員所推薦的 L2 會員交易金額，以及本人從 L2 會員賺得的分潤。
          </p>
        )}
        {turnoverView === "commission" && (
          <p className="text-xs text-slate-500">
            顯示所選區間內，本人直接推薦的 L1 會員交易金額，以及本人從 L1 會員賺得的分潤。
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {turnoverView === "commission" && isAgent ? (
            <>
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.rwa_purchase}
                primaryLabel="交易金額"
                primaryValue={levelTotals.business.l1.rwa_purchase}
                secondaryLabel="L1分潤"
                secondaryValue={levelTotals.commission.l1.rwa_purchase}
                unit="jc"
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.rwa_secondary}
                primaryLabel="交易金額"
                primaryValue={levelTotals.business.l1.rwa_secondary}
                secondaryLabel="L1分潤"
                secondaryValue={levelTotals.commission.l1.rwa_secondary}
                unit="jc"
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.ae_purchase}
                primaryLabel="交易金額"
                primaryValue={levelTotals.business.l1.ae_purchase}
                secondaryLabel="L1分潤"
                secondaryValue={levelTotals.commission.l1.ae_purchase}
                unit="jc"
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.ae_secondary}
                primaryLabel="交易金額"
                primaryValue={levelTotals.business.l1.ae_secondary}
                secondaryLabel="L1分潤"
                secondaryValue={levelTotals.commission.l1.ae_secondary}
                unit="jc"
              />
            </>
          ) : turnoverView === "direct_members" && isAgent ? (
            <>
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.rwa_purchase}
                primaryLabel="交易金額"
                primaryValue={levelTotals.business.l2.rwa_purchase}
                secondaryLabel="L2分潤"
                secondaryValue={levelTotals.commission.l2.rwa_purchase}
                unit="jc"
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.rwa_secondary}
                primaryLabel="交易金額"
                primaryValue={levelTotals.business.l2.rwa_secondary}
                secondaryLabel="L2分潤"
                secondaryValue={levelTotals.commission.l2.rwa_secondary}
                unit="jc"
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.ae_purchase}
                primaryLabel="交易金額"
                primaryValue={levelTotals.business.l2.ae_purchase}
                secondaryLabel="L2分潤"
                secondaryValue={levelTotals.commission.l2.ae_purchase}
                unit="jc"
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.ae_secondary}
                primaryLabel="交易金額"
                primaryValue={levelTotals.business.l2.ae_secondary}
                secondaryLabel="L2分潤"
                secondaryValue={levelTotals.commission.l2.ae_secondary}
                unit="jc"
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
                unit="jc"
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.rwa_secondary}
                primaryLabel="個人業績"
                primaryValue={turnoverTotals.rwa_secondary}
                secondaryLabel="分潤金額"
                secondaryValue={personalCommissionTotals.rwa_secondary}
                unit="jc"
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.ae_purchase}
                primaryLabel="個人業績"
                primaryValue={turnoverTotals.ae_purchase}
                secondaryLabel="分潤金額"
                secondaryValue={personalCommissionTotals.ae_purchase}
                unit="jc"
              />
              <MetricCard
                label={TURNOVER_CATEGORY_LABEL.ae_secondary}
                primaryLabel="個人業績"
                primaryValue={turnoverTotals.ae_secondary}
                secondaryLabel="分潤金額"
                secondaryValue={personalCommissionTotals.ae_secondary}
                unit="jc"
              />
            </>
          )}
        </div>
      </div>
      )}

      {sourceFilter === "holding" && (
        <HoldingsPanel
          walletAddress={walletForHoldings}
          jcOnChain={jcOnChain}
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
            顯示更新後的分潤明細與投資買賣 · 共 {visibleRows.length} 筆紀錄
          </p>
        </div>
        {error ? (
          <p role="alert" className="p-5 text-sm text-rose-300">{error}</p>
        ) : loading ? (
          <p className="p-5 text-sm text-slate-400">查詢紀錄中…</p>
        ) : visibleRows.length === 0 ? (
          <p className="p-5 text-sm text-slate-500">此篩選條件沒有紀錄。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1120px] text-left text-sm">
              <thead className="bg-slate-900 text-xs text-slate-500">
                <tr>
                  <th className="whitespace-nowrap p-4">時間</th>
                  <th className="whitespace-nowrap p-4">類型</th>
                  <th className="whitespace-nowrap p-4">資產</th>
                  <th className="whitespace-nowrap p-4">單價</th>
                  <th className="whitespace-nowrap p-4">數量</th>
                  <th className="whitespace-nowrap p-4">金額</th>
                  <th className="whitespace-nowrap p-4">手續費</th>
                  <th className="whitespace-nowrap p-4">流水 ID</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const ledgerId = row.id.replace(/^(trade|commission)-/, "");
                  return (
                    <tr key={row.id} className="border-t border-slate-800">
                      <td className="whitespace-nowrap p-4 text-slate-400">
                        {new Intl.DateTimeFormat("zh-TW", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(row.createdAt))}
                      </td>
                      <td className="whitespace-nowrap p-4">{row.type}</td>
                      <td className="whitespace-nowrap p-4 text-slate-300">{row.asset}</td>
                      <td className="whitespace-nowrap p-4 text-slate-300">
                        {row.unitPrice == null ? "—" : formatJC(row.unitPrice)}
                      </td>
                      <td className="whitespace-nowrap p-4 text-slate-300">
                        {row.quantity == null ? "—" : formatTokenAmount(row.quantity)}
                      </td>
                      <td
                        className={`whitespace-nowrap p-4 font-semibold ${row.amount >= 0 ? "text-emerald-400" : "text-red-400"}`}
                      >
                        {row.amount >= 0 ? "+" : "-"}
                        {formatUnit(Math.abs(row.amount), row.currency ?? "jc")}
                      </td>
                      <td className="whitespace-nowrap p-4 text-slate-400">
                        {row.fee == null ? "—" : formatUnit(row.fee, row.currency === "usdt" ? "usdt" : "jc")}
                      </td>
                      <td className="whitespace-nowrap p-4 font-mono text-xs text-slate-500" title={ledgerId}>
                        {ledgerId.slice(0, 12)}…
                      </td>
                    </tr>
                  );
                })}
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
  jcOnChain,
  usdt,
  ae,
  rwaHoldings,
}: {
  walletAddress: string | null;
  jcOnChain: number;
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
          <h3 className="font-bold">鏈上資產</h3>
          <p className="break-all text-xs text-slate-500">
            {walletAddress
              ? `錢包地址：${walletAddress}`
              : "此用戶尚未綁定鏈上錢包地址"}
          </p>
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
          <p className="text-xs text-slate-500">JC</p>
          <p className="mt-1 text-2xl font-bold text-sky-300">
            {formatTokenAmount(Number(jcOnChain) || 0)}{" "}
            <span className="text-sm text-slate-500">JC</span>
          </p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
          <p className="text-xs text-slate-500">USDT</p>
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
          <HoldingRow name="AE" amount={Number(ae) || 0} unit="AE" />
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

function MetricCard({
  label,
  primaryLabel,
  primaryValue,
  secondaryLabel,
  secondaryValue,
  tertiaryLabel,
  tertiaryValue,
  unit,
}: {
  label: string;
  primaryLabel: string;
  primaryValue: number;
  secondaryLabel: string;
  secondaryValue: number;
  tertiaryLabel?: string;
  tertiaryValue?: number;
  // 卡資料資料金額顯示單位。AE 資料資料購維持 "usdt"，其餘 "ae"。傳入的數值皆已換算成
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
      {tertiaryLabel && tertiaryValue !== undefined && (
        <>
          <p className="mt-2 text-xs text-slate-500">{tertiaryLabel}</p>
          <p className="break-all text-lg font-bold text-sky-300">
            {formatUnit(tertiaryValue, unit)}
          </p>
        </>
      )}
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
