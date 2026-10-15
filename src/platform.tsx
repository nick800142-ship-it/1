/* eslint-disable react-refresh/only-export-components */

import { useWallets } from "@privy-io/react-auth";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetchAllRows";
import { getLegacyText } from "@/i18n/legacy";
import { reportMonitorEventInBackground } from "@/lib/monitoring";
import { useVisiblePolling } from "@/hooks/useVisiblePolling";
import { useOnChainUsdtBalance } from "@/lib/onchainUsdt";
import {
  getCurrentRwaFactoryToken,
  useTokenOnChainBalance,
} from "@/lib/onchainContracts";
import { callRelayer, reconcilePendingSettlements, syncJcBalanceFromChain } from "@/lib/onchainSettlement";
import {
  CONTRACT_INFO_VISIBLE_AFTER,
  isContractInfoVisible,
  isUserTransactionEntry,
} from "@/lib/transactionHistory";

const keepStable = <T,>(previous: T, next: T): T =>
  JSON.stringify(previous) === JSON.stringify(next) ? previous : next;

export type AssetTranslation = {
  name?: string;
  location?: string;
  information?: string;
  history?: string[];
  comparables?: string[];
  advantages?: string[];
};
/**
 * The price to show/value an asset at right now. AE tokens let buyers and
 * sellers set their own order price, so `asset.price` is only the fixed
 * subscription price — once real P2P trades exist, the market's actual
 * clearing price is `lastTradedPrice`. Non-AE assets keep using `price`,
 * since that field is the authoritative admin-set reference price for them.
 */
export const currentMarketPrice = (asset: Asset) =>
  asset.isAeToken && asset.lastTradedPrice != null
    ? asset.lastTradedPrice
    : asset.price;

export const formatApy = (value?: string | null) => {
  const normalized = value?.trim();
  if (!normalized) return "—";
  return normalized.includes("%") ? normalized : `${normalized}%`;
};

/**
 * AE token rounds (daily and bonus, when no end date is set) store
 * ends_at as Postgres 'infinity', which comes back over the API as the
 * string "infinity" and produces an Invalid Date in JS. Intl.DateTimeFormat
 * throws a RangeError on an Invalid Date, so every caller that formats
 * endsAt must go through this helper instead of calling Date formatters
 * directly on the raw value.
 */
export const formatEndsAt = (
  value: string,
  format: (date: Date) => string,
  noEndLabel = "無期限",
) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? format(date) : noEndLabel;
};

export type Asset = {
  id: string;
  name: string;
  location: string;
  address: string;
  image: string;
  images?: string[];
  information?: string;
  translations?: Partial<Record<Lang, AssetTranslation>>;
  price: number;
  // Most recent real P2P matched price for this asset (set by fill_p2p_order /
  // settle_p2p_match), independent from `price`. `price` stays the fixed
  // admin/subscription reference price — for AE tokens it must never be
  // overwritten by secondary-market trades since buyers/sellers set their
  // own order price. Null until the asset's first secondary-market trade.
  lastTradedPrice?: number | null;
  change: number;
  available: number;
  total: number;
  apy: string;
  valuation: number;
  endsAt: string;
  // Placement row creation time, used to surface newly-listed assets first.
  createdAt?: string | null;
  marketStartedAt?: string | null;
  priceLockedUntil?: string | null;
  isActive?: boolean;
  history: string[];
  comparables: string[];
  advantages: string[];
  // AE token rounds release a fixed amount of inventory on a timer instead
  // of selling the full lump sum immediately. See lib/aeToken.ts for the
  // client-side display math (the database is authoritative for purchases).
  isAeToken?: boolean;
  aeTokenKind?: "daily" | "bonus" | null;
  releaseIntervalSeconds?: number | null;
  releaseAmountPerInterval?: number | null;
  releaseStartedAt?: string | null;
  releaseFrozenAt?: string | null;
  // RWA private placements are priced in AE for every non-AE-token asset:
  // buying immediately deducts the per-share AE (aePerShare ?? price) from the
  // wallet and credits the shares. `settlementCurrency` / `rwaTotalValue` /
  // `aePerShare` are set when an admin configures the dynamic per-share formula
  // (aePerShare = rwaTotalValue / (totalSupply * aePrice)); plain placements
  // leave aePerShare null and use `price` directly as the fixed AE per share.
  settlementCurrency?: "usdt" | "ae";
  aePerShare?: number | null;
  rwaTotalValue?: number | null;
  aePerSharePriceRef?: number | null;
  // 目前份額代幣地址由資產載入流程向 Factory 查詢；不以資料庫殘留地址作為鏈上來源。
  // AE 標的使用固定 AE 代幣，不使用此欄位。
  tokenAddress?: string | null;
};
export type Transaction = {
  id: string;
  type: "buy" | "sell" | "deposit" | "withdraw" | "dividend" | "fee" | "refund";
  assetId?: string;
  asset: string;
  quantity?: number;
  gross: number;
  fee: number;
  gas?: number;
  net: number;
  // AE 計價 RWA 認購：帳本 amount/net 為 0（USDT 不動），實付 AE 記於此。
  aePaid?: number;
  // AE 結算二級市場：買方付出／賣方收到的 AE 數量（買=ae_paid、賣=ae_received）。
  aeAmount?: number;
  settlement?: "ae" | "usdt";
  // Display currency for this transaction's amounts. JC for on-platform
  // trades/commissions; USDT for deposits and JC↔USDT vault movements.
  currency?: "jc" | "usdt" | "ae";
  date: string;
  createdAt: string;
  hash: string;
  status: "confirmed" | "pending" | "failed" | "refunded" | "cancelled";
  statusReason?: string | null;
};
export type Holding = { assetId: string; tokens: number };

// A user's still-locked RWA placement subscription. During private placement,
// subscribing locks AE into escrow (rwa_placement_escrows) instead of creating
// a holding — the holding only appears once the placement settles into the
// secondary market. Aggregated per asset for the "私募中資產" wallet section.
export type RwaEscrowPosition = {
  assetId: string;
  quantity: number;
  aeLocked: number;
};

export const ASSETS: Asset[] = [
  {
    id: "mel-southbank",
    name: "墨爾本 Southbank 河景公寓",
    location: "Southbank, Melbourne, Australia",
    address: "180 City Road, Southbank VIC 3006, Australia",
    image:
      "https://images.pexels.com/photos/1517586/pexels-photo-1517586.jpeg?auto=compress&cs=tinysrgb&w=1600",
    price: 1.02,
    change: 2.4,
    available: 8420,
    total: 25000,
    apy: "8.8%",
    valuation: 2500000,
    endsAt: "2026-12-31T18:00:00Z",
    history: [
      "2018 年完工並取得使用執照",
      "2022 年完成全面翻新",
      "2026 年由獨立估值機構評估為 250 萬 USDT",
    ],
    comparables: [
      "Southbank 一房均價：740,000 USDT",
      "每平方公尺均價：11,280 USDT",
      "同區租金年增率：5.2%",
    ],
    advantages: ["步行 8 分鐘到 CBD", "雅拉河永久景觀", "平均出租率 96.8%"],
  },
  {
    id: "tokyo-shibuya",
    name: "東京澀谷商業資料資料資料資料樓",
    location: "Shibuya, Tokyo, Japan",
    address: "2-24-12 Shibuya, Shibuya-ku, Tokyo",
    image:
      "https://images.pexels.com/photos/2506947/pexels-photo-2506947.jpeg?auto=compress&cs=tinysrgb&w=1200",
    price: 0.87,
    change: -1.1,
    available: 12300,
    total: 40000,
    apy: "7.2%",
    valuation: 3200000,
    endsAt: "2027-02-28T18:00:00Z",
    history: ["2016 年完工", "2024 年完成節能升級", "2026 年 SPV 收購完成"],
    comparables: [
      "澀谷商辦每坪均價：42,000 USDT",
      "區域空置率：2.1%",
      "年租金成長：4.7%",
    ],
    advantages: ["澀谷站步行 3 分鐘", "長期企業租約", "核心商業區稀缺供給"],
  },
  {
    id: "singapore-marina",
    name: "新加坡 Marina Bay 景觀宅",
    location: "Marina Bay, Singapore",
    address: "12 Marina Boulevard, Singapore 018982",
    image:
      "https://images.pexels.com/photos/7746733/pexels-photo-7746733.jpeg?auto=compress&cs=tinysrgb&w=1200",
    price: 1.35,
    change: 3.8,
    available: 5600,
    total: 18000,
    apy: "9.1%",
    valuation: 4800000,
    endsAt: "2027-03-31T18:00:00Z",
    history: [
      "2020 年取得 TOP",
      "2025 年完成室內升級",
      "2026 年完成鏈上資產驗證",
    ],
    comparables: [
      "灣區豪宅中位價：3.9M USDT",
      "每平方呎均價：2,850 USDT",
      "租賃資料資料資料資料資料年增：6.4%",
    ],
    advantages: ["濱海灣核心景觀", "國際金融中心旁", "高資產租戶需求"],
  },
  {
    id: "london-canary",
    name: "倫敦 Canary Wharf 辦公室",
    location: "Canary Wharf, London, UK",
    address: "25 Canada Square, London E14 5LQ, UK",
    image:
      "https://images.pexels.com/photos/672532/pexels-photo-672532.jpeg?auto=compress&cs=tinysrgb&w=1200",
    price: 0.94,
    change: 0.6,
    available: 9800,
    total: 30000,
    apy: "6.5%",
    valuation: 2900000,
    endsAt: "2027-06-30T18:00:00Z",
    history: [
      "2015 年取得 BREEAM Excellent",
      "2023 年公共空間翻新",
      "2026 年估值更新",
    ],
    comparables: [
      "甲級辦公室收益率：5.8%",
      "平均租金：每呎 58 USDT",
      "空置率低於區域平均",
    ],
    advantages: ["Elizabeth Line 直達", "ESG 認證建築", "多元企業租戶組合"],
  },
];

type TradeResult = {
  ok: boolean;
  message: string;
  enteredSecondaryMarket?: boolean;
  // 認購預留成功時回傳 requestKey；必須等後端確認所有鏈上交割與正式帳本同步後，
  // 頁面才可向使用者回報交易成功。
  requestKey?: string;
  onchain?: { units: number; paymentJc: number; isAe: boolean } | null;
};
// Every non-AE-token RWA private placement is AE-denominated: the per-share
// price is expressed in AE tokens and buying deducts real AE from the wallet.
// AE-token subscriptions are the sole exception (bought with USDT).
export const isRwaAeSettled = (asset: Asset) => !asset.isAeToken;

// Per-share AE for a RWA placement. Admin-configured AE placements store an
// explicit aePerShare (dynamic formula); plain placements leave it null and
// use `price` directly as the fixed AE-per-share amount.
export const rwaAePerShare = (asset: Asset) => asset.aePerShare ?? asset.price;

// Live ratchet projection for a non-AE RWA placement against the current
// secondary-market AE price. Mirrors private.recompute_rwa_shares for a single
// step from the committed reference price so the UI reflects the live AE price
// instantly and matches what a purchase deducts (execute_private_purchase
// re-runs the same ratchet at the current price before charging). Degrades to
// the committed DB values when there is no anchor/live price — and in
// production the committed reference already equals the live price, so the
// projection returns the stored values unchanged until the next AE trade.
export const rwaLiveView = (
  asset: Asset,
  aePrice: number,
): { perShareAE: number; total: number; available: number } => {
  const perShare = asset.aePerShare ?? asset.price;
  const total = asset.total;
  const available = asset.available;
  const ref = asset.aePerSharePriceRef ?? null;
  const totalValue = asset.rwaTotalValue ?? null;
  if (
    asset.isAeToken ||
    aePrice <= 0 ||
    ref == null ||
    totalValue == null ||
    totalValue <= 0 ||
    perShare <= 0 ||
    total <= 0
  ) {
    return { perShareAE: perShare, total, available };
  }
  const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
  if (aePrice > ref) {
    // AE 上漲：總份額固定，調降每份所需 AE（= 總估值 /(總份額 × AE現價)）
    return { perShareAE: round6(totalValue / (total * aePrice)), total, available };
  }
  if (aePrice < ref) {
    // AE 下跌：每份 AE 固定，擴增總份額（available 同步增加，只增不減）
    const nextTotal = Math.ceil(totalValue / (perShare * aePrice));
    const delta = Math.max(0, nextTotal - total);
    return { perShareAE: perShare, total: nextTotal, available: available + delta };
  }
  return { perShareAE: perShare, total, available };
};

// Live AE token price in USDT — the secondary-market clearing price of the
// daily AE token, falling back to its subscription price before any trade.
// This is the "current AE price" used to convert live valuations (wallet
// holdings, RWA current price) into AE. Frozen commission snapshots use the
// price captured at distribution time instead (stored in commission_logs).
export const getAePrice = (assets: Asset[]) => {
  const ae = assets.find((a) => a.id === "ae-token-daily");
  const price = ae ? currentMarketPrice(ae) : 0;
  return price > 0 ? price : 0;
};

type PlatformContextValue = {
  balance: number;
  holdings: Holding[];
  transactions: Transaction[];
  // 已入帳的推廣分潤紀錄（commission_payout ＋ commission_reversal 沖正）。與一般交易
  // 紀錄分開，供錢包「近期交易」的「分潤紀錄」分頁使用。
  commissionTransactions: Transaction[];
  assets: Asset[];
  featuredAssetId: string | null;
  walletAddress: string | null;
  // Actual holder balance from the configured JC token contract.
  jcOnChainBalance: number;
  jcOnChainLoading: boolean;
  jcOnChainError: boolean;
  jcBuyPrice: number;
  jcRedeemPrice: number;
  // AE token's live market price, now denominated in JC (see getAePrice).
  aePrice: number;
  loading: boolean;
  trade: (
    assetId: string,
    type: "buy" | "sell" | "private_buy",
    quantity: number,
  ) => Promise<TradeResult>;
  refresh: () => Promise<void>;
};
const PlatformContext = createContext<PlatformContextValue | null>(null);
const assetDetails = new Map(ASSETS.map((asset) => [asset.id, asset]));
export function PlatformProvider({ children }: { children: ReactNode }) {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [commissionTransactions, setCommissionTransactions] = useState<Transaction[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [featuredAssetId, setFeaturedAssetId] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const { wallets } = useWallets();
  const privyWalletAddress =
    wallets.find((wallet) => wallet.walletClientType === "privy")?.address ?? null;
  const activeWalletAddress = privyWalletAddress ?? walletAddress;
  const {
    balance: jcOnChainBalance,
    loading: jcOnChainLoading,
    error: jcOnChainError,
  } = useTokenOnChainBalance("jcToken", activeWalletAddress);
  const [jcBuyPrice, setJcBuyPrice] = useState(1);
  const [jcRedeemPrice, setJcRedeemPrice] = useState(1);
  const [loading, setLoading] = useState(true);
  // 「可用 USDT 餘額」極簡模式：不做充值/approve，直接輪詢 Base Sepolia 測試網上
  // 該用戶錢包地址的真實 balanceOf，每 4 秒自動刷新一次。
  const { balance } = useOnChainUsdtBalance(activeWalletAddress);
  const refresh = useCallback(async () => {
    const clearUserAssets = () => {
      setHoldings([]);
      setTransactions([]);
      setCommissionTransactions([]);
      setAssets([]);
      setWalletAddress(null);
    };
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) {
      clearUserAssets();
      setLoading(false);
      return;
    }
    const [
      placementsResult,
      ledgerResult,
      jcLedgerResult,
      positionsResult,
      platformConfigResult,
      walletResult,
      commissionLogsResult,
      allPlacementsResult,
      townTransactionsResult,
      settlementsResult,
    ] = await Promise.all([
      supabase.rpc("list_visible_private_placements"),
      // USDT ledger: deposits, gas, and JC↔USDT vault movements.
      fetchAllRows((rangeFrom, rangeTo) =>
        supabase
          .from("asset_ledger")
          .select("*")
          .eq("user_id", authData.user.id)
          .order("created_at", { ascending: false })
          .order("id")
          .range(rangeFrom, rangeTo),
      ),
      // JC ledger: subscriptions, secondary trades, commissions, vault.
      fetchAllRows((rangeFrom, rangeTo) =>
        supabase
          .from("jc_ledger")
          .select("*")
          .eq("user_id", authData.user.id)
          .order("created_at", { ascending: false })
          .order("id")
          .range(rangeFrom, rangeTo),
      ),
      supabase.from("holdings").select("*").eq("user_id", authData.user.id),
      supabase
        .from("platform_config")
        .select("featured_asset_id,jc_price,jc_redeem_price")
        .maybeSingle(),
      supabase
        .from("profiles")
        .select("wallet_address")
        .eq("id", authData.user.id)
        .maybeSingle(),
      // Commission ledger rows carry the underlying asset only on the source
      // purchase or on the commission_logs row itself. Fetch commission logs so
      // payouts resolve the real asset name instead of the generic label.
      supabase
        .from("commission_logs")
        .select("id,asset_id,bonus_type")
        .eq("beneficiary_id", authData.user.id),
      // Every placement's id+name so any traded asset (including delisted ones)
      // resolves to its real name in the transaction list.
      supabase
        .from("private_placements")
        .select("id,name,translations,updated_at,is_ae_token")
        .gte("updated_at", CONTRACT_INFO_VISIBLE_AFTER),
      supabase.rpc("get_my_rwmt_town_transactions"),
      supabase
        .from("onchain_settlements")
        .select("ref_key,status,tx_hash,error,updated_at")
        .eq("user_id", authData.user.id)
        .in("action", ["subscribe", "trade", "redeem", "mint_jc"])
        .order("updated_at", { ascending: false })
        .limit(500),
    ]);
    if (!walletResult.error) {
      const address = walletResult.data?.wallet_address ?? null;
      setWalletAddress((previous) => (previous === address ? previous : address));
    }
    const userDataFailed =
      ledgerResult.error || jcLedgerResult.error || positionsResult.error;
    if (userDataFailed) {
      clearUserAssets();
    } else {
      const ledger = ledgerResult.data ?? [];
      const jcLedger = jcLedgerResult.data ?? [];
      const ledgerById = new Map(
        [...ledger, ...jcLedger].map((row) => [row.id, row]),
      );
      const commissionById = new Map(
        (commissionLogsResult.data ?? []).map((row) => [row.id, row]),
      );
      const commissionAssetById = new Map(
        (commissionLogsResult.data ?? []).map((row) => [row.id, row.asset_id]),
      );
      const activeLanguage = (document.documentElement.lang || "zh-TW") as Lang;
      const placementNameById = new Map(
        (allPlacementsResult.data ?? []).map((row) => {
          const translatedName = (row.translations as Partial<Record<Lang, AssetTranslation>> | null | undefined)?.[activeLanguage]?.name;
          return [row.id, translatedName?.trim() || row.name] as const;
        }),
      );
      const aePlacementIds = new Set(
        (allPlacementsResult.data ?? [])
          .filter((row) => row.is_ae_token)
          .map((row) => row.id),
      );
      type LedgerRow = {
        id: string;
        entry_type: string;
        amount: number;
        asset_id?: string | null;
        quantity?: number | null;
  metadata?: Record<string, unknown> | null;
  idempotency_key?: string | null;
  created_at: string;
      };
      const resolveAssetId = (row: LedgerRow) => {
        if (row.asset_id) return row.asset_id;
        const meta = row.metadata ?? {};
        const commissionLogId = meta.commission_log_id;
        if (typeof commissionLogId === "string") {
          const fromPayout = commissionAssetById.get(commissionLogId);
          if (fromPayout) return fromPayout;
        }
        const sourceLedgerId = meta.source_ledger_id;
        if (typeof sourceLedgerId === "string") {
          const fromPending = ledgerById.get(sourceLedgerId)?.asset_id;
          if (fromPending) return fromPending;
        }
        return row.asset_id ?? undefined;
      };
      const settlementByRef = new Map(
        (settlementsResult.data ?? []).map((row) => [row.ref_key, row] as const),
      );
      const settlementForLedger = (row: LedgerRow) => {
        const action =
          row.entry_type === "private_purchase"
            ? "subscribe"
            : row.entry_type === "vault_buy"
              ? "mint_jc"
              : row.entry_type.startsWith("p2p_") || row.entry_type.startsWith("secondary_")
                ? "trade"
                : null;
        const requestKey =
          typeof row.idempotency_key === "string" && row.idempotency_key.length > 0
            ? row.idempotency_key
            : typeof row.metadata?.request_key === "string"
              ? row.metadata.request_key
              : null;
        if (action) {
          const direct = settlementByRef.get(`${action}:${row.id}`);
          if (direct) return direct;
        }
        return (settlementsResult.data ?? []).find((settlement) =>
          (requestKey && settlement.ref_key.includes(requestKey)) || settlement.ref_key.endsWith(`:${row.id}`),
        );
      };
      const transactionStatusFor = (row: LedgerRow): Transaction["status"] => {
        const settlement = settlementForLedger(row);
        const requiresSettlement =
          row.entry_type === "private_purchase" ||
          row.entry_type === "vault_buy" ||
          row.entry_type === "p2p_buy" ||
          row.entry_type === "p2p_sell" ||
          row.entry_type === "secondary_buy" ||
          row.entry_type === "secondary_sell";
        if (!settlement && requiresSettlement && row.idempotency_key) return "pending";
        if (!settlement) return "confirmed";
        if (settlement.status === "failed") return "failed";
        if (settlement.status === "cancelled") return "cancelled";
        if (settlement.status === "pending") return "pending";
        return "confirmed";
      };
      const jcTypeMap: Record<string, Transaction["type"]> = {
        private_purchase: "buy",
        secondary_buy: "buy",
        secondary_sell: "sell",
        p2p_buy: "buy",
        p2p_sell: "sell",
        p2p_listing_fee: "fee",
        commission_payout: "dividend",
        refund: "refund",
        vault_buy: "deposit",
        admin_payout: "deposit",
        vault_redeem: "withdraw",
        // 贖回佇列：申請時扣 JC（withdraw），若被拒絕則退回 JC（deposit）。
        redemption_pending: "withdraw",
        redemption_refund: "deposit",
        town_bomb: "fee",
      };
      // vault_buy_jc is only an internal mirror of the USDT transfer; the
      // actual on-chain transfer is listed separately with its real tx hash.
      const usdtTypeMap: Record<string, Transaction["type"]> = {
        sandbox_deposit: "deposit",
        vault_redeem_jc: "deposit",
      };
      const buildTx = (
        row: LedgerRow,
        currency: "jc" | "usdt",
        type: Transaction["type"],
      ): Transaction => {
        const meta = row.metadata ?? {};
        const resolvedAssetId = resolveAssetId(row);
        const isAeAsset =
          Boolean(resolvedAssetId) &&
          (aePlacementIds.has(resolvedAssetId!) ||
            assetDetails.get(resolvedAssetId!)?.isAeToken === true);
        const resolvedName = isAeAsset
          ? "AE"
          : (resolvedAssetId ? placementNameById.get(resolvedAssetId) : undefined) ??
            (resolvedAssetId ? assetDetails.get(resolvedAssetId)?.name : undefined);
        const fallbackName =
          row.entry_type === "sandbox_deposit"
            ? localizedUiText(activeLanguage, "샌드박스 USDT", "測試 USDT")
            : row.entry_type === "p2p_listing_fee"
              ? localizedUiText(activeLanguage, "挂单手续费", "掛單手續費")
              : row.entry_type === "town_bomb"
                ? localizedUiText(activeLanguage, "RWMT 炸彈罰款", "RWMT 炸彈罰款")
              : row.entry_type === "refund"
                ? localizedUiText(activeLanguage, "청약 환불", "認購退款")
                : row.entry_type === "admin_payout"
                  ? localizedUiText(activeLanguage, "관리자 입금", "管理員入帳")
                  : row.entry_type.startsWith("vault") ||
                      row.entry_type.startsWith("redemption")
                    ? localizedUiText(activeLanguage, "JC 금고 교환", "兌換JC")
                    : localizedUiText(activeLanguage, "추천 커미션", "代理分潤");
        const rawQuantity =
          row.quantity ?? meta.quantity ?? meta.fill_quantity ?? meta.match_quantity;
        const parsedQuantity = Number(rawQuantity);
        const quantity =
          Number.isFinite(parsedQuantity) && parsedQuantity > 0
            ? Math.abs(parsedQuantity)
            : undefined;
        const rawGross = Number(meta.gross);
        const gross =
          Number.isFinite(rawGross) && rawGross > 0
            ? rawGross
            : Math.abs(Number(row.amount));
        const rawFee = Number(meta.fee);
        const fee =
          meta.fee != null && Number.isFinite(rawFee)
            ? Math.abs(rawFee)
            : row.entry_type === "p2p_listing_fee"
              ? Math.abs(Number(row.amount))
              : 0;
        const settlement = settlementForLedger(row);
        return {
          id: row.id,
          type,
          assetId: resolvedAssetId ?? undefined,
          asset: resolvedName ?? fallbackName,
          quantity,
          gross,
          fee,
          gas: Number(meta.gas ?? 0),
          net: Number(row.amount),
          currency,
          date: new Date(row.created_at).toLocaleString(document.documentElement.lang || undefined),
          createdAt: row.created_at,
          hash: row.id,
          status: transactionStatusFor(row),
          statusReason:
            settlement?.error ??
            (transactionStatusFor(row) === "pending" ? "鏈上結算紀錄尚未確認，請等待後台補發或重試" : null),
        };
      };
      const jcTx = (jcLedger as LedgerRow[])
        // 分潤紀錄另列；個人交易只顯示共用的交易 entry types。
        .filter((row) => isUserTransactionEntry(row.entry_type))
        .map((row) => buildTx(row, "jc", jcTypeMap[row.entry_type] ?? "dividend"));
      const usdtTx = (ledger as LedgerRow[])
        .filter((row) => usdtTypeMap[row.entry_type])
        .map((row) => buildTx(row, "usdt", usdtTypeMap[row.entry_type]));
      type TownTransaction = { id: string; kind: "bomb" | "ae"; house: number; amount: number; net: number; tx_hash: string | null; status: "confirmed" | "pending"; created_at: string };
      const townTransactions = ((townTransactionsResult.data ?? []) as TownTransaction[]).map((row): Transaction => ({
        id: row.id,
        type: row.kind === "bomb" ? "fee" : "deposit",
        asset: row.kind === "bomb" ? "RWMT 炸彈罰款" : "AE",
        quantity: row.kind === "ae" ? row.amount : undefined,
        gross: row.amount,
        fee: row.kind === "bomb" ? row.amount : 0,
        net: row.net,
        currency: row.kind === "bomb" ? "jc" : "ae",
        date: new Date(row.created_at).toLocaleString(document.documentElement.lang || undefined),
        createdAt: row.created_at,
        hash: row.tx_hash ?? row.id,
        status: row.status,
      }));
      const nextTransactions = [...jcTx, ...usdtTx, ...townTransactions].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      );
      setTransactions((previous) => keepStable(previous, nextTransactions));
      // 分潤紀錄：只收「已入帳且屬於 L1/L2」的推廣分潤——commission_payout（實際派發）與
      // commission_reversal（沖正校正，可正可負）。尚未派發的 commission_pending
      // 屬內部應計、不重複顯示，避免與後續派發列看起來像重複入帳。
      const commissionTx = (jcLedger as LedgerRow[])
        .filter((row) => {
          if (row.entry_type !== "commission_payout" && row.entry_type !== "commission_reversal") return false;
          const commissionLogId = row.metadata?.commission_log_id;
          if (typeof commissionLogId !== "string") return false;
          return Boolean(commissionById.get(commissionLogId));
        })
        .map((row) => buildTx(row, "jc", "dividend"))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      setCommissionTransactions((previous) => keepStable(previous, commissionTx));
      const nextHoldings = (positionsResult.data ?? []).map(
        (row: { asset_id: string; quantity: number }) => ({
          assetId: row.asset_id,
          tokens: Number(row.quantity),
        }),
      );
      setHoldings((previous) => keepStable(previous, nextHoldings));
    }
    const platformConfig = platformConfigResult.data;
    setFeaturedAssetId((previous) => {
      const next = platformConfig?.featured_asset_id ?? null;
      return previous === next ? previous : next;
    });
    const buyPrice = Number(platformConfig?.jc_price ?? 1) || 1;
    setJcBuyPrice(buyPrice);
    setJcRedeemPrice(Number(platformConfig?.jc_redeem_price ?? buyPrice) || buyPrice);
    const placements = (placementsResult.data ?? []).filter(
      (row: NonNullable<typeof placementsResult.data>[number]) =>
        isContractInfoVisible(row.updated_at),
    );
    if (placements.length > 0 || placementsResult.data) {
      const nextAssets: Asset[] = placements.map(
        (row: NonNullable<typeof placementsResult.data>[number]) => {
        const details = assetDetails.get(row.id) ?? ASSETS[0];
        const isAeToken = row.is_ae_token ?? false;
        const sourceTranslations = (row.translations ?? {}) as Partial<
          Record<Lang, AssetTranslation>
        >;
        const translations = isAeToken
          ? Object.fromEntries(
              Object.entries(sourceTranslations).map(([code, translation]) => [
                code,
                { ...(translation ?? {}), name: "AE" },
              ]),
            ) as Partial<Record<Lang, AssetTranslation>>
          : sourceTranslations;
        return {
          ...details,
          id: row.id,
          name: isAeToken ? "AE" : row.name,
          location: row.location,
          address: row.address,
          image: row.images?.[0] ?? row.image,
          images: row.images?.length ? row.images : [row.image],
          information: row.information ?? "",
          translations,
            history: Array.isArray(row.history) ? row.history.filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0) : [],
            comparables: Array.isArray(row.comparables) ? row.comparables.filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0) : [],
            advantages: Array.isArray(row.advantages) ? row.advantages.filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0) : [],
          price: Number(row.price),
          lastTradedPrice:
            row.last_traded_price == null ? null : Number(row.last_traded_price),
          change: Number(row.change),
          available: Number(row.available),
          total: Number(row.total_supply),
          apy: String(row.apy ?? ""),
          valuation: Number(row.valuation),
          endsAt: row.ends_at,
          createdAt: row.created_at ?? null,
          marketStartedAt: row.market_started_at,
          priceLockedUntil: row.price_locked_until,
          isActive: row.is_active,
          isAeToken,
          aeTokenKind: row.ae_token_kind ?? null,
          releaseIntervalSeconds: row.release_interval_seconds ?? null,
          releaseAmountPerInterval: row.release_amount_per_interval ?? null,
          releaseStartedAt: row.release_started_at ?? null,
          releaseFrozenAt: row.release_frozen_at ?? null,
          settlementCurrency: (row.settlement_currency ?? "usdt") as "usdt" | "ae",
          aePerShare: row.ae_per_share == null ? null : Number(row.ae_per_share),
          rwaTotalValue: row.rwa_total_value == null ? null : Number(row.rwa_total_value),
          aePerSharePriceRef:
            row.ae_per_share_price_ref == null ? null : Number(row.ae_per_share_price_ref),
          tokenAddress: null,
        };
      });
      const verifiedAssets = await Promise.all(
        nextAssets.map(async (asset) => {
          if (asset.isAeToken) return asset;
          try {
            return {
              ...asset,
              tokenAddress: await getCurrentRwaFactoryToken(asset.id),
            };
          } catch {
            return { ...asset, tokenAddress: null };
          }
        }),
      );
      setAssets((previous) => keepStable(previous, verifiedAssets));
    }
    setLoading(false);
  }, []);
  useVisiblePolling(refresh, 1_000, true);
  useEffect(() => {
    const syncAssets = () => void refresh();
    window.addEventListener("platform-assets-updated", syncAssets);
    window.addEventListener("platform-language-updated", syncAssets);
    const channel = supabase
      .channel("private-placement-market-state")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "private_placements" },
        syncAssets,
      )
      .subscribe();
    const { data: authListener } = supabase.auth.onAuthStateChange(() => {
      setHoldings([]);
      setTransactions([]);
      setCommissionTransactions([]);
      void refresh();
      // 全站層級的自動補發：只要有人登入（首次進站或 token 刷新），就補跑一次
      // 「站內已扣款但鏈上還沒真的收到幣」的檢查，不需要使用者特地打開錢包頁
      // 才會資料資料資料發。reconcilePendingSettlements 內建 in-flight 保護，重複觸發安全。
      supabase.auth.getUser().then(({ data }) => {
        if (data.user) void reconcilePendingSettlements();
      });
    });
    // 首次掛載（例如重新整理頁面、已是登入狀態）也補跑一次。
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) void reconcilePendingSettlements();
    });
    return () => {
      window.removeEventListener("platform-assets-updated", syncAssets);
      window.removeEventListener("platform-language-updated", syncAssets);
      authListener.subscription.unsubscribe();
      void supabase.removeChannel(channel);
    };
  }, [refresh]);
  const trade = async (
    assetId: string,
    type: "buy" | "sell" | "private_buy",
    quantity: number,
  ): Promise<TradeResult> => {
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 1_000_000)
      return { ok: false, message: "請輸入 1 至 1,000,000 之間的整數份額" };
    if (type !== "private_buy") {
      return { ok: false, message: "請至二級市場選擇真人掛單成交" };
    }
  const targetAsset = assets.find((item) => item.id === assetId);
  // 售罄是正常的商業狀態，不應進入鏈上結算再發「交割失敗」通知。
  // 先在前端攔截，後端仍保留相同檢查作為最後一道防線。
  if (targetAsset?.isActive === false || (targetAsset && targetAsset.available < quantity)) {
    return { ok: false, message: "此標的一級認購已結束，目前僅開放二級市場交易" };
  }
  // 鏈上代幣門檻：RWA 標的資料資料級認購需要在 RWA Factory 部署專屬份額代幣，
  // 否則鏈上結算無份額可發。AE 標的走固定 AE 代幣，不需要此門檻。
  if (targetAsset && !targetAsset.isAeToken && !targetAsset.tokenAddress) {
      return { ok: false, message: "此標的尚未部署鏈上代幣，暫時無法認購，請稍後再試或聯繫平台" };
    }
    try {
      await syncJcBalanceFromChain();
      await callRelayer("check-subscription-stock", { placementId: assetId, quantity });
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "無法確認熱錢包庫存，認購尚未扣除 JC",
      };
    }
    const requestKey = crypto.randomUUID();
    const { data: settlement, error } = await supabase.rpc(
      "execute_private_purchase",
      {
        asset_key: assetId,
        trade_quantity: quantity,
        request_key: requestKey,
      },
    );
    if (error) {
      reportMonitorEventInBackground({
        type: "trade_result",
        success: false,
        message: error.message,
        action: "一級認購",
        assetId,
        assetName: targetAsset?.name,
        quantity,
        amount: targetAsset ? quantity * Number(targetAsset.price) : undefined,
      });
      const messages: Record<string, string> = {
        "placement ended": "私募已結束",
        "asset unavailable": "此標的目前未開放交易",
        "secondary market unavailable": "此標的尚未進入二級市場",
        "trade too small": "賣出金額需高於手續費",
        "invalid quantity": "請輸入有效份額",
        "invalid side": "交易類型不正確",
        "not authenticated": "登入狀態已失效，請重新登入",
        "insufficient balance": "USDT 餘額不足",
        "insufficient holdings": "持有份額不足",
        "insufficient supply": "可購份額不足",
        "insufficient jc": "JC 餘額不足，請先至錢包用 USDT 兌換 JC",
        "jc price unavailable": "JC 單價暫時無法取得，請稍後再試",
        "price update cooldown": "此標的剛完成調價，一分鐘內暫停新增掛單",
      };
      return {
        ok: false,
        message: messages[error.message] ?? "交易未完成，請稍後再試",
      };
    }

    await refresh();
    if (targetAsset?.isAeToken && targetAsset.aeTokenKind === "bonus") {
      try {
        await callRelayer("bonus-sold-out-notification", { placementId: assetId });
      } catch (error) {
        console.warn("[v0] Bonus sellout notification skipped", error);
      }
    }
    const result = settlement as {
      gross?: number;
      total?: number;
      entered_secondary_market?: boolean;
    } | null;
    const enteredSecondaryMarket = Boolean(result?.entered_secondary_market);
    const grossJc = Number(result?.gross ?? 0).toLocaleString(undefined, {
      maximumFractionDigits: 6,
    });
    // RWA 與 AE 都回傳鏈上結算所需資訊；isAe 讓前端決定授權對象與 relayer 分支。
    const purchasedAsset = assets.find((item) => item.id === assetId);
    const onchain = purchasedAsset
      ? { units: quantity, paymentJc: Number(result?.gross ?? 0), isAe: !!purchasedAsset.isAeToken }
      : null;
    return {
      ok: true,
      message: enteredSecondaryMarket
        ? `已鎖定份額（${grossJc} JC）；等待交割完畢後，標的才會進入二級市場。`
        : `已鎖定份額（${grossJc} JC）；等待交割完畢。`,
      enteredSecondaryMarket,
      requestKey,
      onchain,
    };
  };
  return (
    <PlatformContext.Provider
      value={{
        balance,
        holdings,
        transactions,
        commissionTransactions,
        assets,
        featuredAssetId,
        walletAddress: activeWalletAddress,
        jcOnChainBalance,
        jcOnChainLoading,
        jcOnChainError,
        jcBuyPrice,
        jcRedeemPrice,
        aePrice: getAePrice(assets),
        loading,
        trade,
        refresh,
      }}
    >
      {children}
    </PlatformContext.Provider>
  );
}
export const usePlatform = () => {
  const v = useContext(PlatformContext);
  if (!v) throw new Error("PlatformProvider missing");
  return v;
};

export const LANGUAGES = [
  ["zh-TW", "繁體中文"],
  ["zh-CN", "简体中文"],
  ["en", "English"],
  ["ja", "日本語"],
  ["ko", "한국어"],
  ["th", "ไทย"],
  ["vi", "Tiếng Việt"],
  ["id", "Bahasa Indonesia"],
  ["ms", "Bahasa Melayu"],
  ["es", "Español"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["pt", "Português"],
  ["ru", "Русский"],
  ["ar", "العربية"],
  ["hi", "हिन्दी"],
] as const;
export type Lang = (typeof LANGUAGES)[number][0];
const LANGUAGE_STORAGE_KEY = "rwmt:language";
const isLang = (value: string | null): value is Lang =>
  LANGUAGES.some(([code]) => code === value);

export function readPreferredLanguage(): Lang | null {
  if (typeof window === "undefined") return null;
  const queryLanguage = new URLSearchParams(window.location.search).get("lang");
  if (isLang(queryLanguage)) return queryLanguage;
  try {
    const storedLanguage = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLang(storedLanguage) ? storedLanguage : null;
  } catch {
    return null;
  }
}

type InterfaceCopyKey = "welcome" | "platformAnnouncements" | "viewMore" | "announcementHistory" | "close" | "appearance" | "displayMode" | "accentColor" | "agencyRelationship" | "currentRole" | "applyAgency" | "searchSubscribe" | "searchMarket" | "accountInformation" | "email" | "userId" | "nickname" | "saveChanges" | "saving" | "signOut" | "signingOut" | "transactionType" | "asset" | "unitPrice" | "quantity" | "amount" | "time" | "ledgerId";
const interfaceCopyKeys: InterfaceCopyKey[] = ["welcome", "platformAnnouncements", "viewMore", "announcementHistory", "close", "appearance", "displayMode", "accentColor", "agencyRelationship", "currentRole", "applyAgency"];
const interfaceCopyRows: Record<Lang, string[]> = {
  "zh-TW": ["歡迎登入 RWMT，{name}", "平台公告", "查看更多", "歷史公告", "關閉", "外觀設定", "顯示模式", "主題顏色", "代理與推廣關係", "目前角色", "申請成為代理／總代理"],
  "zh-CN": ["欢迎登录 RWMT，{name}", "平台公告", "查看更多", "历史公告", "关闭", "外观设置", "显示模式", "主题颜色", "代理与推广关系", "当前角色", "申请成为代理／总代理"],
  en: ["Welcome to RWMT, {name}", "Platform announcements", "View more", "Announcement history", "Close", "Appearance", "Display mode", "Accent color", "Agency and referral relationship", "Current role", "Apply as agent / general agent"],
  ja: ["RWMTへようこそ、{name}", "プラットフォームのお知らせ", "もっと見る", "お知らせ履歴", "閉じる", "外観設定", "表示モード", "アクセントカラー", "代理店・紹介関係", "現在の役割", "代理店／総代理店に申請"],
  ko: ["RWMT에 오신 것을 환영합니다, {name}", "플랫폼 공지", "더 보기", "공지 내역", "닫기", "화면 설정", "표시 모드", "강조 색상", "대리점 및 추천 관계", "현재 역할", "대리점／총대리점 신청"],
  th: ["ยินดีต้อนรับสู่ RWMT, {name}", "ประกาศแพลตฟอร์ม", "ดูเพิ่มเติม", "ประวัติประกาศ", "ปิด", "ลักษณะที่ปรากฏ", "โหมดการแสดงผล", "สีเน้น", "ความสัมพันธ์ตัวแทนและการแนะนำ", "บทบาทปัจจุบัน", "สมัครเป็นตัวแทน / ตัวแทนทั่วไป"],
  vi: ["Chào mừng đến RWMT, {name}", "Thông báo nền tảng", "Xem thêm", "Lịch sử thông báo", "資料資料óng", "Giao diện", "Chế độ hiển thị", "Màu nhấn", "Quan hệ đại lý và giới thiệu", "Vai trò hiện tại", "Đăng ký làm đại lý / tổng đại lý"],
  id: ["Selamat datang di RWMT, {name}", "Pengumuman platform", "Lihat lainnya", "Riwayat pengumuman", "Tutup", "Tampilan", "Mode tampilan", "Warna aksen", "Hubungan agen dan referensi", "Peran saat ini", "Daftar sebagai agen / agen umum"],
  ms: ["Selamat datang ke RWMT, {name}", "Pengumuman platform", "Lihat lagi", "Sejarah pengumuman", "Tutup", "Penampilan", "Mod paparan", "Warna aksen", "Hubungan ejen dan rujukan", "Peranan semasa", "Mohon sebagai ejen / ejen am"],
  es: ["Te damos la bienvenida a RWMT, {name}", "Anuncios de la plataforma", "Ver más", "Historial de anuncios", "Cerrar", "Apariencia", "Modo de visualización", "Color de acento", "Relación de agencia y referidos", "Rol actual", "Solicitar ser agente / agente general"],
  fr: ["Bienvenue sur RWMT, {name}", "Annonces de la plateforme", "Voir plus", "Historique des annonces", "Fermer", "Apparence", "Mode d’affichage", "Couleur d’accent", "Relation d’agence et de parrainage", "Rôle actuel", "Devenir agent / agent général"],
  de: ["Willkommen bei RWMT, {name}", "Plattformankündigungen", "Mehr anzeigen", "Ankündigungsverlauf", "Schließen", "Darstellung", "Anzeigemodus", "Akzentfarbe", "Agentur- und Empfehlungsbeziehung", "Aktuelle Rolle", "Als Agent / Generalagent bewerben"],
  pt: ["Boas-vindas à RWMT, {name}", "Anúncios da plataforma", "Ver mais", "Histórico de anúncios", "Fechar", "Aparência", "Modo de exibição", "Cor de destaque", "Relação de agência e indicação", "Função atual", "Candidatar-se a agente / agente geral"],
  ru: ["Добро пожаловать в RWMT, {name}", "Объявления платформы", "Показать больше", "История объявлений", "Закрыть", "Оформление", "Режим отображения", "Акцентный цвет", "Агентские и реферальные связи", "Текущая роль", "Стать агентом / генеральным агентом"],
  ar: ["مرحبًا بك في RWMT، {name}", "إعلانات المنصة", "عرض المزيد", "سجل الإعلانات", "إغلاق", "المظهر", "وضع العرض", "لون التمييز", "علاقة الوكالة والإحالة", "الدور الحالي", "التقدم كوكيل / وكيل عام"],
  hi: ["RWMT में आपका स्वागत है, {name}", "प्लेटफ़ॉर्म घोषणाएँ", "और देखें", "घोषणा इतिहास", "बंद करें", "दिखावट", "डिस्प्ले मोड", "एक्सेंट रंग", "एजेंसी और रेफ़रल संबंध", "वर्तमान भूमिका", "एजेंट / जनरल एजेंट के लिए आवेदन करें"],
};
const screenCopy: Partial<Record<Lang, Partial<Record<InterfaceCopyKey, string>>>> = {
  "zh-TW": { platformAnnouncements: "平台公告", appearance: "外觀設定", searchSubscribe: "搜尋認購標的物", searchMarket: "搜尋二級市場標的物", accountInformation: "帳號資訊", email: "電子郵件", userId: "使用者 ID", nickname: "暱稱", saveChanges: "儲存變更", saving: "儲存中…", signOut: "登出帳號", signingOut: "登出中…", transactionType: "類型", asset: "資產", amount: "金額", time: "時間", ledgerId: "流水 ID" },
  "zh-CN": { searchSubscribe: "搜索认购标的物", searchMarket: "搜索二级市场标的物", accountInformation: "账户信息", email: "电子邮件", userId: "用户 ID", nickname: "昵称", saveChanges: "保存更改", saving: "保存中…", signOut: "退出登录", signingOut: "正在退出…", transactionType: "类型", asset: "资产", amount: "金额", time: "时间", ledgerId: "流水 ID" },
  en: { searchSubscribe: "Search subscription assets", searchMarket: "Search secondary-market assets", accountInformation: "Account information", email: "Email", userId: "User ID", nickname: "Nickname", saveChanges: "Save changes", saving: "Saving…", signOut: "Sign out", signingOut: "Signing out…", transactionType: "Type", asset: "Asset", amount: "Amount", time: "Time", ledgerId: "Ledger ID" },
  ja: { searchSubscribe: "申込対象資産を検索", searchMarket: "二次市場の資産を検索", accountInformation: "アカウント情報", email: "メールアドレス", userId: "ユーザー ID", nickname: "ニックネーム", saveChanges: "変更を保存", saving: "保存中…", signOut: "ログアウト", signingOut: "ログアウト中…", transactionType: "種類", asset: "資産", amount: "金額", time: "日時", ledgerId: "取資料資料資料 ID" },
  ko: { searchSubscribe: "청약 자산 검색", searchMarket: "2차 시장 자산 검색", accountInformation: "계정 정보", email: "이메일", userId: "사용자 ID", nickname: "닉네임", saveChanges: "변경사항 저장", saving: "저장 중…", signOut: "로그아웃", signingOut: "로그아웃 중…", transactionType: "유형", asset: "자산", amount: "금액", time: "시간", ledgerId: "거래 ID" },
};
const tableHeadingCopy: Record<Lang, Partial<Record<InterfaceCopyKey, string>>> = {
  "zh-TW": { transactionType: "類型", asset: "資產", unitPrice: "單價", quantity: "數量", amount: "金額", time: "時間", ledgerId: "流水 ID" },
  "zh-CN": { transactionType: "类型", asset: "资产", unitPrice: "单价", quantity: "数量", amount: "金额", time: "时间", ledgerId: "流水 ID" },
  en: { transactionType: "Type", asset: "Asset", unitPrice: "Unit price", quantity: "Quantity", amount: "Amount", time: "Time", ledgerId: "Ledger ID" },
  ja: { transactionType: "種類", asset: "資産", unitPrice: "単価", quantity: "数量", amount: "金額", time: "日時", ledgerId: "取引 ID" },
  ko: { transactionType: "유형", asset: "자산", unitPrice: "단가", quantity: "수량", amount: "금액", time: "시간", ledgerId: "거래 ID" },
  th: { transactionType: "ประเภท", asset: "สินทรัพย์", unitPrice: "ราคาต่อหน่วย", quantity: "จำนวนหน่วย", amount: "จำนวน", time: "เวลา", ledgerId: "รหัสบัญชี" },
  vi: { transactionType: "Loại", asset: "Tài sản", unitPrice: "Đơn giá", quantity: "Số lượng", amount: "Số tiền", time: "Thời gian", ledgerId: "Mã sổ cái" },
  id: { transactionType: "Jenis", asset: "Aset", unitPrice: "Harga satuan", quantity: "Kuantitas", amount: "Jumlah", time: "Waktu", ledgerId: "ID buku besar" },
  ms: { transactionType: "Jenis", asset: "Aset", unitPrice: "Harga seunit", quantity: "Kuantiti", amount: "Jumlah", time: "Masa", ledgerId: "ID lejar" },
  es: { transactionType: "Tipo", asset: "Activo", unitPrice: "Precio unitario", quantity: "Cantidad", amount: "Importe", time: "Fecha", ledgerId: "ID del registro" },
  fr: { transactionType: "Type", asset: "Actif", unitPrice: "Prix unitaire", quantity: "Quantité", amount: "Montant", time: "Date", ledgerId: "ID du registre" },
  de: { transactionType: "Typ", asset: "Asset", unitPrice: "Stückpreis", quantity: "Menge", amount: "Betrag", time: "Zeit", ledgerId: "Buchungs-ID" },
  pt: { transactionType: "Tipo", asset: "Ativo", unitPrice: "Preço unitário", quantity: "Quantidade", amount: "Montante", time: "Data", ledgerId: "ID do registo" },
  ru: { transactionType: "Тип", asset: "Актив", unitPrice: "Цена за единицу", quantity: "Количество", amount: "Сумма", time: "Время", ledgerId: "ID за資料資料иси" },
  ar: { transactionType: "النوع", asset: "الأصل", unitPrice: "سعر الوحدة", quantity: "الكمية", amount: "المبلغ", time: "الوقت", ledgerId: "معرّف السجل" },
  hi: { transactionType: "प्रकार", asset: "संपत्ति", unitPrice: "इकाई मूल्य", quantity: "मात्रा", amount: "राशि", time: "समय", ledgerId: "資料資料資料資料資料資料資料資料資料資料資料資料資料資料資料資料資料資料資料資料जर ID" },
};

export const interfaceText = (language: Lang, key: InterfaceCopyKey, values?: Record<string, string>) => {
  let text = screenCopy[language]?.[key] ?? tableHeadingCopy[language]?.[key] ?? screenCopy.en?.[key] ?? interfaceCopyRows[language]?.[interfaceCopyKeys.indexOf(key)] ?? interfaceCopyRows.en[interfaceCopyKeys.indexOf(key)] ?? key;
  for (const [name, value] of Object.entries(values ?? {})) text = text.replace(`{${name}}`, value);
  return text;
};

const localizedUiCopy: Partial<Record<Lang, Record<string, string>>> = {
  "zh-TW": {
    "보유 자산 평가액:": "持倉市值：", "온체인 잔資料資料資料資料資料資料 일시資料資料資料으로 불러올 수 없습니다. 총액은 0資料資料로 표시되지 않습니다.": "鏈上餘額資料資料資料時無資料資料資料讀取，總額不會以 0 代替。", "사용 가능 JC": "可用 JC", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "可用 USDT（鏈上餘額，自動更新）", "JC 금고 교환": "兌換JC", "지갑 생성 중…": "錢包生成中…", "자금 출금": "提領資金", "현재 등록된 자산이 없습니다.": "目前沒有上架的標的", "청약 단가": "認購單價", "2차 시장 실시간 등락": "二級市場即時漲跌", "2차 시장에서 구매": "進入二級市場買入", "지분 구매": "購買份額", "개인 간 거래 시장": "個人間交易市場", "조건에 맞는 2차 시장 자산이 없습니다.": "目前沒有符合條件的二級市場標的", "현재가(최근 체결가)": "現價（最新成交價）", "청약 기준가": "認購原價", "참고 가격(JC)": "參考價格（JC）", "시장으로 이동": "進入市場",
  },
  "zh-CN": {
    "보유 자산 평가액:": "持仓市值：", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "链上余额暂时无法读取，总额不会以 0 代替。", "사용 가능 JC": "可用 JC", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "可用 USDT（链上余额，自动更新）", "JC 금고 교환": "JC 金库兑换", "지갑 생성 중…": "钱包生成中…", "자금 출금": "提取资金", "현재 등록된 자산이 없습니다.": "目前没有上架的标的", "청약 단가": "认购单价", "2차 시장 실시간 등락": "二级市场实时涨跌", "2차 시장에서 구매": "进入二级市场买入", "지분 구매": "购买份额", "개인 간 거래 시장": "个人间交易市场", "조건에 맞는 2차 시장 자산이 없습니다.": "目前没有符合条件的二级市场标的", "현재가(최근 체결가)": "现价（最新成交价）", "청약 기준가": "认购原价", "참고 가격(JC)": "参考价格（JC）", "시장으로 이동": "进入市场",
  },
  en: {
    "보유 자산 평가액:": "Holdings valuation:", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "On-chain balances are temporarily unavailable. The total will not be shown as zero.", "사용 가능 JC": "Available JC", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "Available USDT (on-chain balance, updates automatically)", "JC 금고 교환": "JC vault exchange", "지갑 생성 중…": "Creating wallet…", "자금 출금": "Withdraw funds", "현재 등록된 자산이 없습니다.": "There are no listed assets yet", "청약 단가": "Subscription price", "2차 시장 실시간 등락": "Live secondary-market change", "2차 시장에서 구매": "Buy on secondary market", "지분 구매": "Buy shares", "개인 간 거래 시장": "Peer-to-peer market", "조資料資料資料에 맞는 2차 시장 자산이 없습니다.": "No secondary-market assets match these filters", "현재가(최근 체결가)": "Current price (latest trade)", "청약 기준가": "Subscription price", "참고 가격(JC)": "Reference price (JC)", "시장으로 이동": "Go to market",
  },
  ja: {
    "보유 자산 평가액:": "保資料資料資料資産の評価額：", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "オンチェーン残高を一時的に読み込めません。合計を0として表示することはありません。", "사용 가능 JC": "利用可能なJC", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "利用可能なUSDT（オンチェーン残高・自動更新）", "JC 금고 교환": "JC金庫交換", "지갑 생성 중…": "ウォレットを作成中…", "자금 출금": "資金を出金", "資料資料資料資料資料資料資料 資料資料資料록資料資料資料 자산이 資料資料습資料資料다.": "掲載中の資産はありません", "청약 단가": "申込単価", "2차 시장 실시간 등락": "二次市場のリアルタイム変動", "2차 시장에서 구매": "二次市場で購入", "지분 구매": "持分を購入", "개인 간 거래 시장": "個人間取引市場", "조건에 資料資料는 2차 시장 자資料資料資料이 없습니다.": "条件に一致する二次資料資料資料場資産はありません", "현재가(최근 체결資料資料)": "資料資料資料在価格（直近約定価格）", "청약 기준가": "申込基準価格", "참고 가격(JC)": "参考価格（JC）", "시장으로 이동": "市場へ移動",
  },
  ko: {
    "보유 자산 평가액:": "보유 자산 평가액:", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.", "사용 가능 JC": "사용 가능 JC", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "사용 가능 USDT (온체인 잔액, 자동 업데이트)", "JC 금고 교환": "JC 금고 교환", "지갑 생성 중…": "지갑 생성 중…", "자금 출금": "자금 출금", "현재 등록된 자산이 없습니다.": "현재 등록된 자산이 없습니다.", "청약 단가": "청약 단가", "2차 시장 실시간 등락": "2차 시장 실시간 등락", "2차 시장에서 구매": "2차 시장에서 구매", "지분 구매": "지분 구매", "개인 간 거래 시장": "개인 간 거래 시장", "조건에 맞는 2차 시장 자산이 없습니다.": "조건에 맞는 2차 시장 자산이 없습니다.", "현재가(최근 체결가)": "현재가(최근 체결가)", "청약 기준가": "청약 기준가", "참고 가격(JC)": "참고 가격(JC)", "시장으로 이동": "시장으로 이동",
  },
  th: {
    "보유 자산 평가액:": "มูลค่าประเมินสินทรัพย์ที่ถือ:", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "ไม่สามารถโหลดสินทรัพ資料資料์คงเหลือบนเชนได้ชั่วคราว โดยจะไม่แสดงยอดรวมเป็นศูนย์", "사용 가능 JC": "JC ที่ใช้ได้", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "USDT ที่ใช้ได้ (資料資料資料อดบนเชน อัปเดตอัตโนมัติ)", "JC 금고 교환": "แลกเปลี่ยน JC กับคลัง", "지갑 생성 중…": "กำลังสร้างกระเป๋า…", "자금 출금": "ถอนเงิน", "현재 등록된 자산이 없습니다.": "ยังไม่มีสินทรัพย์ที่ลงรายการ", "청약 단가": "ราคาจองซื้อต่อหน่วย", "2차 시장 실시간 등락": "การเปลี่ยนแปลงตลาดรองแบบเรียลไทม์", "2차 시장에서 구매": "ซื้อในตลาดรอง", "지분 구매": "ซื้อหน่วยลงทุน", "개인 간 거래 시장": "ตลาดซื้อขายระหว่างบุคคล", "조건에 맞는 2차 시장 자산이 없습니다.": "ไม่資料資料資料資料資料ส資料資料資料นทร資料資料พย์資料資料ลาดรอ資料資料ท資料資料่ต資料資料資料資料ง資料資料資料ับตัวกรอง", "현재가(최근 체결가)": "ราคาปัจจุบัน (รายการล่าสุด)", "청약 기준가": "ราคาอ้างอิงการจองซื้อ", "참고 가격(JC)": "ราคาอ้างอิง (JC)", "시장으로 이동": "資料資料資料ปยังตล資料資料資料ด",
  },
  vi: {
    "보유 자산 평가액:": "Giá trị danh mục đang nắm giữ:", "온체인 잔資料資料資料資料 일시적으로 資料資料러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "Tạm thời không thể tải số dư on-chain. Tổng tài sản sẽ không bị hiển thị thành 0.", "사용 가능 JC": "JC khả dụng", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "USDT khả dụng (số dư on-chain, tự động cập nhật)", "JC 금고 교환": "Đổi JC tại kho", "지갑 생성 중…": "Đang tạo ví…", "자금 출금": "Rút tiền", "현재 등록된 자산이 없습니다.": "Chưa có tài sản nào được niêm yết", "청약 단가": "Giá đăng ký mỗi đơn vị", "2차 시장 실시간 등락": "Biến động thị trường thứ cấp theo thời gian thực", "2차 시장에서 구매": "Mua trên thị trường thứ cấp", "지분 구매": "Mua phần sở hữu", "개인 간 거래 시장": "Thị trường giao dịch ngang hàng", "조건에 맞는 2차 시장 자산이 없습니다.": "Không có tài sản thị trường thứ cấp phù hợp", "현재가(최근 체결가)": "Giá hiện tại (giao dịch gần nhất)", "청약 기준가": "Giá đăng ký", "참고 가격(JC)": "Giá tham khảo (JC)", "시장으로 이동": "Đi đến thị trường",
  },
  id: {
    "보유 자산 평가액:": "Nilai kepemilikan:", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "Saldo on-chain tidak tersedia sementara. Total tidak akan ditampilkan sebagai nol.", "사용 가능 JC": "JC tersedia", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "USDT tersedia (saldo on-chain, diperbarui otomatis)", "JC 금고 교환": "Penukaran JC di brankas", "지갑 생성 중…": "Membuat dompet…", "자금 출금": "Tarik dana", "현재 등록된 자산이 없습니다.": "Belum ada aset yang terdaftar", "청약 단가": "Harga langganan per unit", "2차 시장 실시간 등락": "Perubahan pasar sekunder langsung", "2차 시장에서 구매": "Beli di pasar sekunder", "지분 구매": "Beli unit saham", "개인 간 거래 시장": "Pasar perdagangan antar pengguna", "조건에 맞는 2차 시장 자산이 없습니다.": "Tidak ada aset pasar sekunder yang sesuai", "현재가(최근 체결가)": "Harga saat ini (transaksi terbaru)", "청약 기준가": "Harga langganan", "참고 가격(JC)": "Harga referensi (JC)", "시장으로 이동": "Buka pasar",
  },
  ms: {
    "보유 자산 평가액:": "Nilai pegangan:", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "Baki dalam rantaian tidak tersedia buat sementara. Jumlah tidak akan dipaparkan sebagai sifar.", "사용 가능 JC": "JC tersedia", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "USDT tersedia (baki dalam rantaian, dikemas kini automatik)", "JC 금고 교환": "Pertukaran JC perbendaharaan", "지갑 생성 중…": "Dompet sedang dicipta…", "자금 출금": "Keluarkan dana", "현재 등록된 자산이 없습니다.": "Tiada aset disenaraikan lagi", "청약 단가": "Harga langganan seunit", "2차 시장 실시간 등락": "Perubahan pasaran sekunder langsung", "2차 시장에서 구매": "Beli di pasaran sekunder", "지분 구매": "Beli unit pegangan", "개인 간 거래 시장": "Pasaran dagangan sesama pengguna", "조건에 맞는 2차 시장 자산이 없습니다.": "Tiada aset pasaran sekunder yang sepadan", "현재가(최근 체결가)": "Harga semasa (dagangan terkini)", "청약 기준가": "Harga langganan", "참고 가격(JC)": "Harga rujukan (JC)", "시장으로 이동": "Pergi ke pasaran",
  },
  es: {
    "보유 자산 평가액:": "Valor de las posiciones:", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "El saldo on-chain no está disponible temporalmente. El total no se mostrará como cero.", "사용 가능 JC": "JC disponible", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "USDT disponible (saldo on-chain, actualización automática)", "JC 금고 교환": "Cambio de JC en la tesorería", "지갑 생성 중…": "Creando cartera…", "자금 출금": "Retirar fondos", "현재 등록된 자산이 없습니다.": "Aún no hay activos publicados", "청약 단가": "Precio de suscripción", "2차 시장 실시간 등락": "Variación en tiempo real del mercado secundario", "2차 시장에서 구매": "Comprar en el mercado secundario", "지분 구매": "Comprar participaciones", "개인 간 거래 시장": "Mercado entre particulares", "조건에 맞는 2차 시장 자산이 없습니다.": "No hay activos de mercado secundario que coincidan", "현재가(최근 체결가)": "Precio actual (última operación)", "청약 기준가": "Precio de suscripción", "참고 가격(JC)": "Precio de referencia (JC)", "시장으로 이동": "Ir al mercado",
  },
  fr: {
    "보유 자산 평가액:": "Valeur des positions :", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "Le solde on-chain est temporairement indisponible. Le total ne sera pas affiché comme égal à zéro.", "사용 가능 JC": "JC disponible", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "USDT disponible (solde on-chain, mise à jour automatique)", "JC 금고 교환": "Échange JC de la trésorerie", "지갑 생성 중…": "Création du portefeuille…", "자금 출금": "Retirer des fonds", "현재 등록된 자산資料資料資料 없습니다.": "Aucun actif n’est encore publié", "청약 단가": "Prix de souscription", "2차 시장 실시간 등락": "Variation en direct du marché secondaire", "2차 시장에서 구매": "Acheter sur le marché secondaire", "지분 구매": "Acheter des parts", "개인 간 거래 資料資料장": "Marché entre particuliers", "조건에 맞는 2차 시장 자산이 없습니다.": "Aucun actif du marché secondaire ne correspond", "현재가(최근 체결가)": "Cours actuel (dernière transaction)", "청약 기준가": "Prix de souscription", "참고 가격(JC)": "Prix de référence (JC)", "시장으로 이동": "Accéder au marché",
  },
  de: {
    "보유 자산 평가액:": "Bewertung der Bestände:", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "Der On-Chain-Kontostand ist vorübergehend nicht verfügbar. Der Gesamtwert wird nicht als null angezeigt.", "사용 가능 JC": "Verfügbares JC", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "Verfügbares USDT (On-Chain-Guthaben, automatische Aktualisierung)", "JC 금고 교환": "JC-Tresortausch", "지갑 생성 중…": "Wallet wird erstellt…", "자금 출금": "Geld auszahlen", "현재 등록된 자산이 없습니다.": "Derzeit sind keine Assets gelistet", "資料資料資料약 단가": "Zeichnungspreis", "2차 시資料資料 실資料資料資料간 등락": "Live-Veränderung am Sekundärmarkt", "2차 시장에서 구매": "Am Sekundärmarkt kaufen", "지분 구매": "Anteile kaufen", "개인 간 거래 시장": "Peer-to-Peer-Markt", "조건에 맞는 2資料資料資料 시장 자산이 없資料資料資料니다.": "Keine passenden Sekundärmarkt-Assets", "현재가(최근 체資料資料資料가)": "Aktueller Preis (letzter Handel)", "청약 資料資料資料준가": "Zeichnungspreis", "참고 가격(JC)": "Referenzpreis (JC)", "시資料資料資料으資料資料資料 이동": "Zum Markt",
  },
  pt: {
    "보유 자산 평가액:": "Avaliação dos ativos detidos:", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액資料資料資料 0으로 표시資料資料資料지 않습니다.": "O saldo on-chain está temporariamente indisponível. O total não será apresentado como zero.", "사용 가능 JC": "JC disponível", "사용 가資料資料資料 USDT (온체인 잔資料資料資料, 자동 업데이트)": "USDT disponível (saldo on-chain, atualização automática)", "JC 금고 교환": "Troca de JC da tesouraria", "지갑 생성 중…": "A criar carteira…", "자금 출금": "Levantar fundos", "현재 등록된 자산이 없습니다.": "Ainda não existem ativos publicados", "청약 단가": "Preço de subscrição", "2차 시장 실시간 등락": "Variação em tempo real do mercado secundário", "2차 시장에서 구매": "Comprar no mercado secundário", "지분 구매": "Comprar unidades", "개인 간 거래 시장": "Mercado entre utilizadores", "조건에 맞는 2차 시장 자산이 없습니다.": "Não há ativos secundários correspondentes", "현재가(최근 체결가)": "Preço atual (última negociação)", "청약 기준가": "Preço de subscrição", "참고 가격(JC)": "Preço de referência (JC)", "시장으로 이동": "Ir para o mercado",
  },
  ru: {
    "보유 자산 평가액:": "Оценка активов в портфеле:", "온체인 잔액을 일시적으로 불러資料資料 수 없습니다. 총액은 0으로 표시되지 않습니다.": "Баланс в блокчейне временно недоступен. Общая сумма не будет показ資料資料на как ноль.", "사용 가능 JC": "Доступно JC", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "Доступно USDT (баланс в блокчейне, автообновление)", "JC 금고 교환": "Обмен JC в казначействе", "지갑 생성 중…": "Создание кошелька…", "자금 출금": "Вывести средства", "현재 등록된 자산이 없습니다.": "Пока нет активов в ли資料資料тинге", "청약 단가": "Цена подписки", "2차 시장 실시간 등락": "Изменение цены на вторичном рынке", "2차 시장에서 구매": "Купить на вторичном рынке", "지분 구매": "Купить доли", "개인 간 거래 시장": "Рынок между пользователями", "조건에 맞는 2차 시장 자산이 없습니다.": "Подходящих активов вторичного рынка нет", "현재가(최근 체결가)": "Текущая цена (последняя сделка)", "청약 기준가": "Цена подписки", "참고 가격(JC)": "Справочная цена (JC)", "시장으로 이동": "Перейти на рынок",
  },
  ar: {
    "보유 자산 평가액:": "ت資料資料ييم الأصول المح資料資料فظ به資料資料:", "온체인 잔액을 일시資料資料으로 불資料資料資料올 수 없습니資料資料. 총액은 0으資料資料資料 표시되지 않습니다.": "تعذر تحميل الرصيد على السلسلة مؤقتًا. لن يُعرض الإجمالي على أنه صفر.", "사용 가능 JC": "JC المتاح", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "USDT المتاح (رصيد على السلسلة، تحديث تلقائي)", "JC 금고 교환": "تح資料資料يل JC من الخزين資料資料", "지갑 생성 중…": "جارٍ إنشاء المحفظ資料資料…", "자資料資料資料 출금": "سحب الأموال", "현資料資料資料 등록된 資料資料산이 資料資料資料습니다.": "لا توجد أصول مدرجة حاليًا", "청약 단가": "سعر الاكتتاب للوحدة", "2차 시장 실시간 등락": "تغير السوق الثانوية مباشرةً", "2차 시장에서 구매": "شراء من السوق الثانوية", "지분 구매": "شراء حصص", "개인 간 거래 시장": "سوق تداول بين المستخدمين", "조건에 맞는 2차 시장 자산이 없습니다.": "لا توجد أصول ثانوية تطابق هذه الشروط", "현재가(최근 체결가)": "السعر الحالي (آخر صفقة)", "청약 기준가": "سعر الاكتتاب", "참고 가격(JC)": "السعر المرجعي (JC)", "시장으로 이동": "الانتقال إلى السوق",
  },
  hi: {
    "보유 자산 평가액:": "धारित संपत्तियों का मूल्य:", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "ऑन-चेन बैलेंस अभी उपलब्ध नहीं है। कुल राशि शून्य के रूप में नहीं दिखाई जाएगी।", "사용 가능 JC": "उपलब्ध JC", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "उपलब्ध USDT (ऑन-चेन बैलेंस, स्वतः अपडेट)", "JC 금고 교환": "JC कोष विनिमय", "지갑 생성 중…": "वॉलेट बनाया जा रहा है…", "자금 출금": "धन निकालें", "현재 등록된 자산이 없습니다.": "अभी कोई संपत्ति सूचीबद्ध नहीं है", "청약 단가": "सब्सक्रिप्शन मूल्य", "2차 시장 실시간 등락": "द्वितीयक बाज़ार में लाइव बदलाव", "2차 시장에서 구매": "द्वितीयक बाज़ार में खरीदें", "지분 구매": "शेयर खरीदें", "개인 간 거래 시장": "पीयर-टू-पीयर बाज़ार", "조건에 맞는 2차 시장 자산이 없습니다.": "कोई मेल खाती द्वितीयक बाज़ार संपत्ति नहीं है", "현재가(최근 체결가)": "वर्तमान मूल्य (नवीनतम ट्रेड)", "청약 기준가": "सब्सक्रिप्शन मूल्य", "참고 가격(JC)": "संदर्भ मूल्य (JC)", "시장으로 이동": "बाज़ार पर जाएँ",
  },
};

const walletUiCopy: Partial<Record<Lang, Record<string, string>>> = {
  "zh-TW": { "거래 내역": "交易紀錄", "유형": "類型", "거래": "交易紀錄", "분배 내역": "分潤紀錄", "이번 주": "本週", "이번 달": "本月", "올해": "今年", "직접 날짜": "自訂日期", "시작 날짜": "開始日期", "종료 날짜": "結束日期", "이 기간에 분배 기록이 없습니다": "此區間沒有分潤紀錄", "이 기간에 거래 기록이 없습니다": "此區間沒有交易紀錄", "JC 구매 (USDT→JC)": "買入 JC（USDT→JC）", "JC 상환 (JC→USDT)": "回收 JC（JC→USDT）", "구매 단가": "買入單價", "상환 단가": "回收單價", "사용 가능 USDT": "可用 USDT", "JC 수량": "JC 數量", "전체": "全部", "지불할 금액": "需支付", "환급 예상": "可換回", "나의 환급 신청": "我的贖回申請", "지급 완료": "已撥款", "JC 반환 완료": "已退回 JC", "심사 대기": "等待審核", "닫기": "關閉", "교환 확인": "確認兌換", "금고로 전송 중…": "轉帳至金庫中…", "기록 중…": "記帳中…", "처리 중…": "處理中…", "이번 주 거래": "本週", "수수료": "手續費", "환불": "退款", "링크를 열어 BaseScan에서 확인": "在 BaseScan 查看鏈上交易" },
  "zh-CN": { "거래 내역": "交易记录", "유형": "类型", "거래": "交易记录", "분배 내역": "分润记录", "이번 주": "本周", "이번 달": "本月", "올해": "今年", "직접 날짜": "自定义日期", "시작 날짜": "开始日期", "종료 날짜": "结束日期", "이 기간에 분배 기록이 없습니다": "此区间没有分润记录", "이 기간에 거래 기록이 없습니다": "此区间没有交易记录", "JC 구매 (USDT→JC)": "买入 JC（USDT→JC）", "JC 상환 (JC→USDT)": "回收 JC（JC→USDT）", "구매 단가": "买入单价", "상환 단가": "回收单价", "사용 가능 USDT": "可用 USDT", "JC 수량": "JC 数量", "전체": "全部", "지불할 금액": "需支付", "환급 예상": "可换回", "나의 환급 신청": "我的赎回申请", "지급 완료": "已拨款", "JC 반환 완료": "已退回 JC", "심사 대기": "等待审核", "닫기": "关闭", "교환 확인": "确认兑换", "금고로 전송 중…": "转账至金库中…", "기록 중…": "记账中…", "처리 중…": "处理中…", "이번 주 거래": "本周", "수수료": "手续费", "환불": "退款", "링크를 열어 BaseScan에서 확인": "在 BaseScan 查看链上交易" },
  en: { "거래 내역": "Trade history", "유형": "Type", "거래": "Transactions", "분배 내역": "Commission history", "이번 주": "This week", "이번 달": "This month", "올해": "This year", "직접 날짜": "Custom dates", "시작 날짜": "Start date", "종료 날짜": "End date", "이 기간에 분배 기록이 없습니다": "No commissions in this date range", "이 기간에 거래 기록이 없습니다": "No transactions in this date range", "JC 구매 (USDT→JC)": "Buy JC (USDT → JC)", "JC 상환 (JC→USDT)": "Redeem JC (JC → USDT)", "구매 단가": "Purchase price", "상환 단가": "Redemption price", "사용 가능 USDT": "Available USDT", "JC 수량": "JC amount", "전체": "Max", "지불할 금액": "You pay", "환급 예상": "You receive", "나의 환급 신청": "My redemption requests", "지급 완료": "Paid", "JC 반환 완료": "JC refunded", "심사 대기": "Pending review", "닫기": "Close", "교환 확인": "Confirm exchange", "금고로 전송 중…": "Transferring to vault…", "기록 중…": "Recording…", "처리 중…": "Processing…", "이번 주 거래": "This week", "수수료": "Fee", "환불": "Refund", "링크를 열어 BaseScan에서 확인": "View on BaseScan" },
  ja: { "거래 내역": "取引履歴", "유형": "種類", "거래": "取引", "분배 내역": "報酬履歴", "이번 주": "今週", "이번 달": "今月", "올해": "今年", "직접 날짜": "日付を指定", "시작 날짜": "開始日", "종료 날짜": "終了日", "이 기간에 분배 기록이 없습니다": "この期間の報酬はありません", "이 기간에 거래 기록資料資料 없습니다": "この資料資料間の取引は資料資料資料りません", "JC 資料資料資料매 (USDT→JC)": "JCを購入資料資料資料USDT→JC）", "JC 상환 (JC→USDT)": "JCを換金（JC資料資料資料USDT）", "구매 단가": "購入価格", "상환 단가": "換金価格", "사용 가능 USDT": "利用可能なUSDT", "JC 수량": "JC数量", "전체": "全額", "지불할 금액": "お支払い", "환급 예상": "受取予定", "나의 환급 신청": "換金申請", "지급 완료": "支払済み", "JC 반환 완료": "JC返金済み", "심사 대기": "審査待ち", "닫기": "閉じる", "교환 확인": "交換を確定", "금고로 전송 중…": "金庫へ送金中…", "기록 중…": "記資料資料資料中…", "처리 중…": "処理中…", "이번 주 거래": "今週", "수수료": "手数料", "환불": "返金", "링크를 열어 BaseScan에서 확인": "BaseScanで取引を表示" },
  ko: { "거래 내역": "거래 내역", "유형": "유형", "거래": "거래", "분배 내역": "분배 내역", "이번 주": "이번 주", "이번 달": "이번 달", "올해": "올해", "직접 날짜": "직접 날짜", "시작 날짜": "시작 날짜", "종료 날짜": "종료 날짜", "이 기간에 분배 기록이 없습니다": "이 기간에 분배 기록이 없습니다", "이 기간에 거래 기록이 없습니다": "이 기간에 거래 기록이 없습니다", "JC 구매 (USDT→JC)": "JC 구매 (USDT→JC)", "JC 상환 (JC→USDT)": "JC 상환 (JC→USDT)", "구매 단가": "구매 단가", "상환 단가": "상환 단가", "사용 가능 USDT": "사용 가능 USDT", "JC 수량": "JC 수량", "전체": "전체", "지불할 금액": "지불할 금액", "환급 예상": "환급 예상", "나의 환급 신청": "나의 환급 신청", "지급 완료": "지급 완료", "JC 반환 완료": "JC 반환 완료", "심사 대기": "심사 대기", "닫기": "닫기", "교환 확인": "교환 확인", "금고로 전송 중…": "금고로 전송 중…", "기록 중…": "기록 중…", "처리 중…": "처리 중…", "이번 주 거래": "이번 주 거래", "수수료": "수수료", "환불": "환불", "링크를 열어 BaseScan에서 확인": "BaseScan에서 확인" },
  th: { "거래 내역": "ประวัติการซื้อขาย", "유형": "ประเภท", "거래": "ธุรกรรม", "분배 내역": "ประวัติค่าคอมมิชชัน", "이번 주": "สัปดาห์นี้", "이번 달": "เดือนนี้", "올해": "ปีนี้", "직접 날짜": "กำหนดวันที่เอง", "시작 날짜": "วันที่เริ่มต้น", "종료 날짜": "วันที่สิ้นสุด", "이 기간에 분배 기록이 없습니다": "ไม่มีค่าคอมมิชชันในช่วงนี้", "이 기간에 거래 기록이 없습니다": "ไม่มีธุรกรรมในช่วงนี้", "JC 구매 (USDT→JC)": "ซื้อ JC (USDT → JC)", "JC 상환 (JC→USDT)": "แลกคืน JC (JC → USDT)", "구매 단가": "ราคาซื้อ", "상환 단가": "ราคาแลกคืน", "사용 가능 USDT": "USDT ที่ใช้ได้", "JC 수량": "จำนวน JC", "전체": "ทั้งหมด", "지불할 금액": "ยอ資料資料資料ชำ資料資料ะ", "환급 예상": "ยอดรับคืน", "나의 환급 신청": "คำขอแลกคืนของฉัน", "지급 완료": "จ่ายแล้ว", "JC 반환 완료": "คืน JC แล้ว", "심사 대기": "รอตรวจสอบ", "닫기": "ปิด", "교환 확인": "ยืนยันการแลก", "금고로 전송 중…": "กำลังโอนไปคลัง…", "기록 중…": "กำลังบันทึก…", "처리 중…": "กำลังดำเนินการ…", "이번 주 거래": "สัปดาห์นี้", "수수료": "ค่าธรรมเนียม", "환불": "คืนเงิน", "링크를 열어 BaseScan에서 확인": "ดูธุรกรรมบน BaseScan" },
  vi: { "거래 資料資料資料역": "Lịch sử giao dịch", "유형": "Loại", "거資料資料資料": "Giao dịch", "資料資料배 내역": "Lịch sử hoa hồng", "이번 주": "Tuần này", "이번 달": "Tháng này", "올해": "Năm nay", "직접 날짜": "Chọn ngày", "시작 날짜": "Ngày bắt đầu", "종료 날짜": "Ngày kết thúc", "이 기간에 분배 기록이 없습니다": "Không có hoa hồng trong khoảng thời gian này", "이 기간資料資料資料 거래 기록이 없습資料資料資料다": "Không có giao dịch trong khoảng thời gian này", "JC 구매 (USDT→JC)": "Mua JC (USDT → JC)", "JC 상환 (JC→USDT)": "Đổi JC (JC → USDT)", "구資料資料 단가": "Giá mua", "상환 단資料資料資料": "Giá đổi lại", "사용 가능 USDT": "USDT khả dụng", "JC 수량": "Số lượng JC", "전체": "Tất cả", "지불할 금액": "Số tiền cần trả", "환급 예상": "Số tiền nhận lại", "나의 환급 신청": "Yêu cầu đổi lại của tôi", "지급 완료": "Đã thanh toán", "JC 반환 완료": "Đã hoàn JC", "심사 대기": "Đang chờ duyệt", "닫기": "Đóng", "교환 확인": "Xác nhận đổi", "금고로 전송 중…": "Đang chuyển vào kho…", "기록 중…": "Đang ghi sổ…", "처리 중…": "Đang xử lý…", "이번 주 거래": "Tuần này", "수수료": "Phí", "환불": "Hoàn tiền", "링크를 열어 BaseScan에서 확인": "Xem giao dịch trên BaseScan" },
  id: { "거래 내역": "Riwayat transaksi", "유형": "Jenis", "거래": "Transaksi", "분배 내역": "Riwayat komisi", "이번 주": "Minggu ini", "이번 달": "Bulan ini", "올해": "Tahun ini", "직접 날짜": "Tanggal khusus", "시작 날짜": "Tanggal mulai", "資料資料資料료 날짜": "Tanggal akhir", "이 기간에 분배 기록이 없습니다": "Tidak ada komisi pada rentang ini", "이 기간에 거래 기록이 없습니다": "Tidak ada transaksi pada rentang ini", "JC 구매 (USDT→JC)": "Beli JC (USDT → JC)", "JC 상환 (JC→USDT)": "Tukar kembali JC (JC → USDT)", "구매 단가": "Harga beli", "상환 단가": "Harga penukaran", "사용 가능 USDT": "USDT tersedia", "JC 수량": "Jumlah JC", "전체": "Maksimum", "지불할 금액": "Jumlah bayar", "환급 예상": "Jumlah diterima", "나의 환급 신청": "Permintaan penukaran saya", "지급 완료": "Sudah dibayar", "JC 반환 완료": "JC dikembalikan", "심사 대기": "Menunggu tinjauan", "닫기": "Tutup", "교환 확인": "Konfirmasi penukaran", "금고로 전송 중…": "Mengirim ke brankas…", "기록 중…": "Mencatat…", "처리 중…": "Memproses…", "이번 주 거래": "Minggu ini", "수수료": "Biaya", "환불": "Pengembalian dana", "링크를 열어 BaseScan에서 확인": "Lihat transaksi di BaseScan" },
  ms: { "거래 내역": "Sejarah transaksi", "유형": "Jenis", "거래": "Transaksi", "분배 내역": "Sejarah komisen", "이번 주": "Minggu ini", "이번 달": "Bulan ini", "올해": "Tahun ini", "직접 날짜": "Tarikh tersuai", "시작 날짜": "Tarikh mula", "종료 날짜": "Tarikh tamat", "이 기간에 분배 기록이 없습니다": "Tiada komisen dalam julat ini", "이 기간에 거래 기록이 없습니다": "Tiada transaksi dalam julat ini", "JC 구매 (USDT→JC)": "Beli JC (USDT → JC)", "JC 상환 (JC→USDT)": "Tebus JC (JC → USDT)", "구資料資料 단가": "Harga beli", "資料資料資料환 단가": "Harga tebus", "資料資料資料용 가능 USDT": "USDT tersedia", "JC 수량": "Jumlah JC", "전체": "Semua", "지資料資料資料資料資料資料 금액": "Jumlah bayaran", "환급 資料資料상": "Jumlah diterima", "나의 환급 신청": "Permohonan tebusan saya", "지급 완료": "Telah dibayar", "JC 반환 완료": "JC dipulangkan", "심사 대기": "Menunggu semakan", "닫기": "Tutup", "교환 확인": "Sahkan pertukaran", "금고로 전송 중…": "Sedang memindahkan ke perbendaharaan…", "기록 중…": "Sedang merekod…", "資料資料리 중…": "Sedang diproses…", "이번 주 거래": "Minggu ini", "수수료": "Yuran", "환불": "Bayaran balik", "링크를 열어 BaseScan에서 확인": "Lihat transaksi di BaseScan" },
  es: { "거래 내역": "Historial de transacciones", "유형": "Tipo", "거래": "Transacciones", "분배 내역": "Historial de comisiones", "이번 주": "Esta semana", "이번 달": "Este mes", "올해": "Este año", "직접 날짜": "Fechas personalizadas", "시작 날짜": "Fecha inicial", "종료 날짜": "Fecha final", "이 기간에 분배 기록이 없습니다": "No hay comisiones en este periodo", "이 기간에 거래 기록이 없습니다": "No hay transacciones en este periodo", "JC 구매 (USDT→JC)": "Comprar JC (USDT → JC)", "JC 상환 (JC→USDT)": "Canjear JC (JC → USDT)", "구매 단가": "Precio de compra", "상환 단가": "Precio de canje", "사용 가능 USDT": "USDT disponible", "JC 수량": "Cantidad de JC", "전체": "Máximo", "지불할 금액": "Total a pagar", "환급 예상": "Importe a recibir", "나의 환급 신청": "Mis solicitudes de canje", "지급 완료": "Pagado", "JC 반환 완료": "JC devuelto", "심사 대기": "Pendiente de revisión", "닫기": "Cerrar", "교환 확인": "Confirmar cambio", "금고로 전송 중…": "Enviando a la tesorería…", "기록 중…": "Registrando…", "처리 중…": "Procesando…", "이번 주 거래": "Esta semana", "수수료": "Comisión", "환불": "Reembolso", "링크를 열어 BaseScan에서 확인": "Ver transacción en BaseScan" },
  fr: { "거래 내역": "Historique des transactions", "유형": "Type", "거래": "Transactions", "분배 내역": "Historique des commissions", "이번 주": "Cette semaine", "이번 달": "Ce mois-ci", "올해": "Cette année", "직접 날짜": "Dates personnalisées", "시작 날짜": "Date de début", "종료 날짜": "Date de fin", "이 기간에 분배 기록이 없습니다": "Aucune commission sur cette période", "이 기간에 거래 기록이 없습니다": "Aucune transaction sur cette période", "JC 구매 (USDT→JC)": "Acheter des JC (USDT → JC)", "JC 상환 (JC→USDT)": "Convertir des JC (JC → USDT)", "구매 단가": "Prix d’achat", "상환 단가": "Prix de conversion", "사용 가능 USDT": "USDT disponible", "JC 수량": "Quantité de JC", "전체": "Tout", "지불할 금액": "À payer", "환급 예상": "À recevoir", "나의 환급 신청": "Mes demandes de conversion", "지급 완료": "Payé", "JC 반환 완료": "JC remboursés", "심사 대기": "En attente de vérification", "닫기": "Fermer", "교환 확인": "Confirmer l’échange", "금고로 전송 중…": "Transfert vers la trésorerie…", "기록 중…": "Enregistrement…", "처리 중…": "Traitement…", "이번 주 거래": "Cette semaine", "수수료": "Frais", "환불": "Remboursement", "링크를 열어 BaseScan에서 확인": "Voir la transaction sur BaseScan" },
  de: { "거래 내역": "Transaktionsverlauf", "유형": "Typ", "거래": "Transaktionen", "분배 내역": "Provisionsverlauf", "이번 주": "Diese Woche", "이번 달": "Diesen Monat", "올해": "Dieses Jahr", "직접 날짜": "Benutzerdefinierter Zeitraum", "시작 날짜": "Startdatum", "종료 날짜": "Enddatum", "이 기간에 분배 기록이 없습니다": "Keine Provisionen in diesem Zeitraum", "이 기간에 거래 기록이 없습니다": "Keine Transaktionen in diesem Zeitraum", "JC 구매 (USDT→JC)": "JC kaufen (USDT → JC)", "JC 상환 (JC→USDT)": "JC einlösen (JC → USDT)", "구매 단가": "Kaufpreis", "상환 단가": "Einlösepreis", "사용 가능 USDT": "Verfügbares USDT", "JC 수량": "JC-Betrag", "전체": "Maximal", "지불할 금액": "Zu zahlen", "환급 예상": "Voraussichtlicher Erhalt", "나의 환급 신청": "Meine Einlösungen", "지급 완료": "Ausgezahlt", "JC 반환 완료": "JC zurückerstattet", "심사 대기": "Prüfung ausstehend", "닫기": "Schließen", "교환 확인": "Tausch bestätigen", "금고로 전송 중…": "Übertragung an die Treasury…", "기록 중…": "Wird verbucht…", "처리 중…": "Wird verarbeitet…", "이번 주 거래": "Diese Woche", "수수료": "Gebühr", "환불": "Erstattung", "링크를 열어 BaseScan에서 확인": "Transaktion auf BaseScan ansehen" },
  pt: { "거래 내역": "Histórico de transações", "유형": "Tipo", "거래": "Transações", "분배 내역": "Histórico de comissões", "이번 주": "Esta semana", "이번 달": "Este mês", "올해": "Este ano", "직접 날짜": "Datas personalizadas", "시작 날짜": "Data inicial", "종료 날짜": "Data final", "이 기간에 분배 기록이 없습니다": "Sem comissões neste período", "이 기간에 거래 기록이 없습니다": "Sem transações neste período", "JC 구매 (USDT→JC)": "Comprar JC (USDT → JC)", "JC 상환 (JC→USDT)": "Resgatar JC (JC → USDT)", "구매 단가": "Preço de compra", "상환 단가": "Preço de resgate", "사용 가능 USDT": "USDT disponível", "JC 수량": "Quantidade de JC", "전체": "Tudo", "지불할 금액": "Valor a pagar", "환급 예상": "Valor a receber", "나의 資料資料資料급 신청": "Os meus pedidos de resgate", "지급 완료": "Pago", "JC 반환 완료": "JC devolvido", "심사 대기": "A aguardar análise", "닫기": "Fechar", "교환 확인": "Confirmar troca", "금고로 전송 중…": "A transferir para a tesouraria…", "기록 중…": "A registar…", "처리 중…": "A processar…", "이번 주 거래": "Esta semana", "수수료": "Taxa", "환불": "Reembolso", "링크를 열어 BaseScan에서 확인": "Ver transação na BaseScan" },
  ru: { "거래 내역": "История транзакций", "유형": "Тип", "거래": "Транзакции", "분배 내역": "История комиссий", "이번 주": "Эта неделя", "이번 달": "Этот месяц", "올해": "Этот год", "직접 날짜": "Выбрать даты", "시작 날짜": "Начальная дата", "종료 날짜": "Конечная дата", "이 기간에 분배 기록이 없습니다": "За 資料資料тот период комиссий нет", "이 기간에 거래 기록이 없습니다": "За этот период транзакций нет", "JC 구매 (USDT→JC)": "Купить JC (USDT → JC)", "JC 상환 (JC→USDT)": "Обменять JC (JC → USDT)", "구매 단가": "Цена покупки", "상환 단가": "Цена обмена", "사용 가능 USDT": "Доступно USDT", "JC 수량": "Количество JC", "전체": "Максимум", "지불할 금액": "К оплате", "환급 예상": "К получению", "나의 환급 신청": "Мои заявки на обмен", "지급 완료": "Выплачено", "JC 반환 완료": "JC возвращены", "심사 대기": "Ожидает проверки", "닫기": "Закрыть", "교환 확인": "Подтвердить обмен", "금고資料資料資料 전송 중…": "Перево資料資料 в казначейство…", "기록 資料資料…": "Запись в учёт…", "資料資料資料리 중…": "資料資料браб資料資料т資料資料а…", "資料資料번 주 거래": "Эта неделя", "수수료": "Комиссия", "환불": "Возврат", "링크를 열어 BaseScan에서 확인": "Открыть транзакцию в BaseScan" },
  ar: { "거래 내역": "سجل المعاملات", "유형": "النوع", "거래": "المعاملات", "분資料資料 내역": "سجل العمولات", "이번 주": "هذا ال資料資料سبوع", "이번 달": "هذا الشهر", "올해": "هذا العام", "직접 날짜": "تواريخ مخصصة", "시작 날짜": "تار資料資料خ البد資料資料", "종료 날짜": "تاريخ الانتهاء", "이 기간에 분배 기록이 없습니다": "لا توجد عمولات خلال هذه الفترة", "이 기간에 거래 기록이 없습니다": "لا توجد معاملات خلال هذه الفترة", "JC 구매 (USDT→JC)": "شراء JC (USDT → JC)", "JC 상환 (JC→USDT)": "استرداد JC (JC → USDT)", "구매 단가": "سعر الشراء", "상환 단가": "سعر الاسترداد", "사용 가능 USDT": "USDT المتاح", "JC 수량": "كمية JC", "전체": "الحد الأقصى", "지불할 금액": "المبلغ المستحق", "환급 예상": "المبلغ المتوقع استلامه", "나의 환급 신청": "طلبات الاسترداد", "지급 완료": "تم الدفع", "JC 반환 완료": "تم إرجاع JC", "심사 대기": "بانتظار المراجعة", "닫기": "إغلاق", "교환 확인": "تأكيد التحويل", "금고로 전송 중…": "جارٍ التحويل إلى الخزينة…", "기록 중…": "جارٍ التسجيل…", "처리 중…": "جارٍ المعالجة…", "이번 주 거래": "هذا الأسبوع", "수수료": "الرسوم", "환불": "استرداد", "링크를 열어 BaseScan에서 확인": "عرض المعاملة على BaseScan" },
  hi: { "거래 내역": "लेनदेन इति資料資料ास", "유형": "प्रक資料資料र", "거래": "लेनदेन", "분배 내역": "कमीशन इतिहास", "이번 주": "資料資料資料料स स資料資料資料्ताह", "이번 달": "इस महीने", "올해": "इस वर्ष", "직접 날짜": "कस्टम तिथियाँ", "시작 날짜": "आरंभ तिथि", "종료 날짜": "समाप्ति तिथि", "이 기간에 분배 기록이 없습니다": "इस अवधि में कोई कमीश資料資料 नहीं", "이 기간에 거래 기록이 없습니다": "इस अवधि में कोई लेनदेन नहीं", "JC 구매 (USDT→JC)": "JC खरीदें (USDT → JC)", "JC 상환 (JC→USDT)": "JC भुनाए資料資料 (JC → USDT)", "구매 단가": "खरीद मूल्य", "상환 단가": "रिडेम्प्शन मूल्य", "사용 가능 USDT": "उपलब्ध USDT", "JC 수량": "JC मात्रा", "전체": "अधिकतम", "지불할 금액": "देय राशि", "환급 예상": "प्राप्त होने वाली राशि", "나의 환급 신청": "मेर資料資料資料 रिडेम्प資料資料शन अ資料資料ुरोध", "지급 완료": "भुगतान हो गया", "JC 반환 완료": "JC वापस किया गया", "심사 대기": "समीक्षा लंबित", "닫기": "बंद करें", "교환 확인": "एक्सचेंज की पुष्टि करें", "금고로 전송 중…": "खज़ाने में भेजा जा रहा है…", "기록 중…": "रिकॉर्ड किया जा रहा है…", "처리 중…": "प्रक्रिया जारी…", "이번 주 거래": "इस सप्ताह", "수수료": "शुल्क", "환불": "रिफंड", "링크를 열어 BaseScan에서 확인": "BaseScan पर लेन資料資料資料ेन देख資料資料資料ं" },
};

const walletExtraUiCopy: Partial<Record<Lang, Record<string, string>>> = {
  "zh-TW": { "보유 지분": "資料資料資料額", "거래 단가": "成交單價", "이 자산의 거래 내역이 없資料資料니다": "沒有此資料資料的的交資料資料紀錄", "資料資料資料資料資料資料資料인 USDT 받資料資料": "鏈上 USDT 轉入", "온체인 USDT 보냄": "鏈上 USDT 轉出", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "暫時無法載入鏈上 USDT 轉帳紀錄，稍後會自動重試。" },
  "zh-CN": { "보유 지분": "份额", "거래 단가": "成交資料資料資料价", "이 자산의 거래 資料資料資料역이 없습니다": "没有此标的的交資料資料資料记录", "온체資料資料 USDT 받음": "链上 USDT 转入", "온체인 USDT 보냄": "链上 USDT 转出", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 資料資料資料시 시도합니다.": "暂时无法加载資料資料上 USDT 转账记資料資料，稍后会資料資料資料动重试。" },
  en: { "보유 지분": "Shares", "거래 단가": "Trade price", "이 자산의 거래 내역이 없습니다": "No trades for this asset", "온체인 USDT 받음": "On-chain USDT received", "온체인 USDT 보냄": "On-chain USDT sent", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "On-chain USDT history is temporarily unavailable and will retry." },
  ja: { "보유 지분": "保資料資料口数", "거래 단가": "約定単価", "이 자산의 거래 내역이 없습니다": "この資産の取引履歴はありません", "온체인 USDT 받음": "オンチェーンUSDT受取", "온체인 USDT 보냄": "オンチェーンUSDT送金", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "オンチェーンUSDT履歴を読み込めません。自動で再試行します。" },
  ko: { "보유 지분": "보유 지분", "거래 단가": "거래 단가", "이 자산의 거래 내역이 없습니다": "이 자산의 거래 내역이 없습니다", "온체인 USDT 받음": "온체인 USDT 받음", "온체인 USDT 보냄": "온체인 USDT 보냄", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다." },
  th: { "보유 지분": "จำนวนหน่วยที่ถือ", "거래 단가": "ราคาซื้อขาย", "이 자산의 거래 내역이 없습니다": "ไม่มีประวัติการซื้อขายสินทรัพย์นี้", "온체인 USDT 받음": "รับ USDT บนเชน", "온체인 USDT 보냄": "ส่ง USDT บนเชน", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "โหลดประวัติ USDT บนเชนไม่ได้ชั่วคราว ระบบจะลองอีกครั้งโดยอัตโนมัติ" },
  vi: { "보유 지분": "Số phần đang nắm giữ", "거래 단가": "Giá giao dịch", "이 자산의 거래 내역이 없습니다": "Không có giao dịch cho tài sản này", "온체인 USDT 받음": "USDT nhận on-chain", "온체인 USDT 보냄": "USDT gửi on-chain", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "Lịch sử USDT on-chain tạm thời không khả dụng và sẽ tự thử lại." },
  id: { "보유 지분": "Unit yang dimiliki", "거래 단가": "Harga transaksi", "이 자산資料資料資料 거래 내역이 없습니다": "Tidak ada transaksi untuk aset ini", "온資料資料인 USDT 받음": "USDT on-chain diterima", "온체資料資料 USDT 보냄": "USDT on-chain dikirim", "온체인 USDT 내역을 불러올 수 없습니다. 資料資料資料資料資料資料資料로 다시 시도합니다.": "Riwayat USDT on-chain sementara tidak tersedia dan akan dicoba kembali." },
  ms: { "보유 지분": "Unit pegangan", "거래 단가": "Harga dagangan", "이 자산의 거래 내역이 없습니다": "Tiada transaksi untuk aset ini", "온체인 USDT 받음": "USDT dalam rantaian diterima", "온체資料資料資料 USDT 보냄": "USDT dalam rantaian dihantar", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시資料資料資料합니다.": "Sejarah USDT dalam rantaian tidak tersedia sementara dan akan dicuba semula." },
  es: { "보유 지분": "Participaciones", "거래 단가": "Precio de operación", "이 자산의 거래 내역資料資料資料 없습니다": "No hay operaciones de este activo", "온체인 USDT 받음": "USDT recibido on-chain", "온체인 USDT 보냄": "USDT enviado on-chain", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "El historial de USDT on-chain no está disponible temporalmente y se volverá a intentar." },
  fr: { "보유 지분": "Parts détenues", "거래 단가": "Prix de transaction", "이 자산의 거래 내역資料資料資料 없습니다": "Aucune transaction pour cet actif", "온체인 USDT 받음": "USDT reçu on-chain", "온체인 USDT 보냄": "USDT envoyé on-chain", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "L’historique USDT on-chain est temporairement indisponible et sera réessayé." },
  de: { "보유 지분": "Gehaltene Anteile", "거래 단가": "Handelspreis", "이 자산의 거래 내역이 없습니다": "Keine Transaktionen für dieses Asset", "온체인 USDT 받음": "On-Chain-USDT erhalten", "온체인 USDT 보냄": "On-Chain-USDT gesendet", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "Der On-Chain-USDT-Verlauf ist vorübergehend nicht verfügbar; es wird erneut versucht." },
  pt: { "보유 지분": "Unidades detidas", "거래 단가": "Preço da negociação", "이 자산의 거래 내역이 없습니다": "Não existem transações deste ativo", "온체인 USDT 받음": "USDT recebido on-chain", "온체인 USDT 보냄": "USDT enviado on-chain", "온체인 USDT 내역을 불러올 資料資料資料 없습니다. 자동으로 다시 시도합니다.": "O histórico de USDT on-chain está temporariamente indisponível e será novamente consultado." },
  ru: { "보유 지분": "Доли во владении", "거래 단가": "Цена сделки", "이 자산의 거래 내역이 없습니다": "По этому активу нет сделок", "온체인 USDT 받음": "Получен USDT в блокчейне", "온체인 USDT 보냄": "Отправлен USDT в блокчейне", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "История USDT в блокчейне временно недоступна; будет выполнена повторная попытка." },
  ar: { "보유 지분": "الحصص المملوكة", "거래 단가": "سعر التداول", "이 자산의 거래 내역이 없습니다": "لا توجد معاملات لهذا الأصل", "온체인 USDT 받음": "استلام USDT على السلسلة", "온체인 USDT 보냄": "إرسال USDT على السلسلة", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "سجل USDT على السلسلة غير متاح مؤقتًا وستتم إعادة المحاولة تلقائيًا." },
  hi: { "보유 지분": "धारित हिस्से", "거래 단가": "ट्रेड मूल्य", "이 자산의 거래 내역이 없습니다": "इस संपत्ति के लिए कोई ट्रेड नहीं", "온체인 USDT 받음": "ऑन-चेन USDT प्राप्त", "온체인 USDT 보냄": "ऑन-चेन USDT भेजा", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "ऑन-चेन USDT इतिहास अभी उपलब्ध नहीं है; अपने आप फिर प्रयास होगा।" },
};

const walletStatusUiCopy: Record<Lang, Record<string, string>> = {
  "zh-TW": { "잔액을 읽는 중…": "讀取中…", "잔액을 읽지 못했습니다": "讀取失敗", "USDT 잔액 부족": "USDT 餘額不足", "JC 잔액 부족": "JC 餘額不足" },
  "zh-CN": { "잔액을 읽는 중…": "读取中…", "잔액을 읽지 못했습니다": "读取失败", "USDT 잔액 부족": "USDT 余额不足", "JC 잔액 부족": "JC 余额不足" },
  en: { "잔액을 읽는 중…": "Loading balance…", "잔액을 읽지 못했습니다": "Balance unavailable", "USDT 잔액 부족": "Insufficient USDT balance", "JC 잔액 부족": "Insufficient JC balance" },
  ja: { "잔액을 읽는 중…": "残高を読み込み中…", "잔액을 읽지 못했습資料資料다": "残高を取得できません", "USDT 잔액 부족": "USDT残高が不足しています", "JC 잔액 부족": "JC残高が不足しています" },
  ko: { "잔액을 읽는 중…": "잔액을 읽는 중…", "잔액을 읽지 못했습니다": "잔액을 읽지 못했습니다", "USDT 잔액 부족": "USDT 잔액 부족", "JC 잔액 부족": "JC 잔액 부족" },
  th: { "잔액을 읽는 중…": "กำลังอ่านยอดคงเหลือ…", "잔액을 읽지 못했습니다": "ไม่สามารถอ่านยอดคงเหลือได้", "USDT 잔액 부족": "ยอด USDT ไม่เพียงพอ", "JC 잔액 부족": "ยอด JC ไม่เพียงพอ" },
  vi: { "잔액을 읽는 중…": "Đang tải số dư…", "잔액을 읽지 못했습니다": "Không thể tải số dư", "USDT 잔액 부족": "Số dư USDT không đủ", "JC 잔액 부족": "Số dư JC không đủ" },
  id: { "잔액을 읽는 중…": "Memuat saldo…", "잔액을 읽지 못했습니다": "Saldo tidak dapat dimuat", "USDT 잔액 부족": "Saldo USDT tidak mencukupi", "JC 잔액 부족": "Saldo JC tidak mencukupi" },
  ms: { "잔액을 읽는 중…": "Memuatkan baki…", "잔액을 읽지 못했습니다": "Baki tidak dapat dimuatkan", "USDT 잔액 부족": "Baki USDT tidak mencukupi", "JC 잔액 부족": "Baki JC tidak mencukupi" },
  es: { "잔액을 읽는 중…": "Cargando saldo…", "잔액을 읽지 못했습니다": "Saldo no disponible", "USDT 잔액 부족": "Saldo de USDT insuficiente", "JC 잔액 부족": "Saldo de JC insuficiente" },
  fr: { "잔액을 읽는 중…": "Chargement du solde…", "資料資料액을 읽지 못했습니다": "Solde indisponible", "USDT 잔액 부족": "Solde USDT insuffisant", "JC 잔액 부족": "Solde JC insuffisant" },
  de: { "잔액을 읽는 중…": "Kontostand wird geladen…", "잔액을 읽지 못했습니다": "Kontostand nicht verfügbar", "USDT 잔액 부족": "USDT-Guthaben nicht ausreichend", "JC 잔액 부족": "JC-Guthaben nicht ausreichend" },
  pt: { "잔액을 읽는 중…": "A carregar saldo…", "잔액을 읽지 못했습니다": "Saldo indisponível", "USDT 잔액 부족": "Saldo USDT insuficiente", "JC 잔액 부족": "Saldo JC insuficiente" },
  ru: { "잔액을 읽는 중…": "Загрузка баланса…", "잔액을 읽지 못했습니다": "Баланс недоступен", "USDT 잔액 부족": "Н資料資料достаточно USDT", "JC 잔액 부족": "Недостаточно JC" },
  ar: { "잔액을 읽는 중…": "جارٍ تحميل 資料資料لرصيد…", "잔액을 읽지 못했습니다": "ا資料資料رصيد غير متاح", "USDT 資料資料액 부족": "資料資料صيد USDT غي資料資料 كافٍ", "JC 잔액 資料資料족": "رصي資料資料 JC غير كافٍ" },
  hi: { "잔액을 읽는 중…": "बैलेंस लोड हो रहा है…", "잔액을 읽지 못했습니다": "बैलेंस उपलब्ध नहीं है", "USDT 잔액 부족": "USDT बैलेंस अपर्याप्त", "JC 잔액 부족": "JC बैलेंस अ資料資料र्याप्त" },
};

type WalletExchangeMessageKey =
  | "purchaseSuccess"
  | "purchasePending"
  | "purchaseUnconfirmed"
  | "redemptionSuccess"
  | "redemptionPending";

const walletExchangeMessages: Record<Lang, Record<WalletExchangeMessageKey, string>> = {
  "zh-TW": {
    purchaseSuccess: "已轉帳 {usdt} 到金庫並完成資料資料換 {jc}。{tx}",
    purchasePending: "USDT 已上鏈，但 JC 交割／入帳仍在處理中。預留已保留並會自動重試，請勿重複購買。{tx}",
    purchaseUnconfirmed: "無法確認 USDT 是否送出。預留仍保留，請檢查錢包活動並聯絡客服。{error}",
    redemptionSuccess: "JC 贖回完成：{jc} 換回 {usdt}。{tx}",
    redemptionPending: "JC 贖回已預留，但鏈上交割尚未確認。額度保留並會自動重試，請勿重複申請。{tx}",
  },
  "zh-CN": {
    purchaseSuccess: "已转账 {usdt} 到金库并完成兑换 {jc}。{tx}",
    purchasePending: "USDT 已上链，但 JC 交割／入账仍在处理中。预留已保留并会自动重试，请勿重复购买。{tx}",
    purchaseUnconfirmed: "无法确认 USDT 是否已发送。预留仍保留，请检查钱包活动并联系客服。{error}",
    redemptionSuccess: "JC 赎回完成：{jc} 换回 {usdt}。{tx}",
    redemptionPending: "JC 赎回已预留，但链上交割尚未确认。额度保留并会自动重试，資料資料勿重复申请。{tx}",
  },
  en: {
    purchaseSuccess: "Transferred {usdt} to the vault and credited {jc}. {tx}",
    purchasePending: "USDT is on-chain, but JC settlement or accounting is still pending. The reservation is kept and will retry automatically. Do not buy again. {tx}",
    purchaseUnconfirmed: "We could not confirm whether USDT was sent. The reservation remains held. Check wallet activity and contact support. {error}",
    redemptionSuccess: "JC redemption confirmed: {jc} exchanged for {usdt}. {tx}",
    redemptionPending: "Your JC redemption is reserved, but on-chain settlement is not confirmed. The reservation is held and will retry automatically. Do not submit again. {tx}",
  },
  ja: {
    purchaseSuccess: "{usdt}を金庫へ送金し、{jc}への交換が完了しました。{tx}",
    purchasePending: "USDTはオンチェーンで確認されましたが、JCの決済／記帳は処理中です。予約額は保持され、自動で再試行されます。重複購入しないでください。{tx}",
    purchaseUnconfirmed: "USDTの送信を確認できません。予約額は保持されています。ウォレットの履歴を確認し、サポートへご連絡ください。{error}",
    redemptionSuccess: "JCの換金資料資料資料完了しました：{jc}を{usdt}に交換しました。{tx}",
    redemptionPending: "JC換金を受け付け、額を予約しました。資料資料ンチェーン決済は未資料資料資料認で、自動資料資料試行されます。重複申請しないでください。{tx}",
  },
  ko: {
    purchaseSuccess: "{usdt}를 금고로 전송하고 {jc} 교환을 완료했습니다. {tx}",
    purchasePending: "USDT는 온체인에서 확인됐지만 JC 정산／입금은 처리 중입니다. 예약 금액은 유지되며 자동 재시도됩니다. 중복 구매하지 마세요. {tx}",
    purchaseUnconfirmed: "USDT 전송 여부를 확인할 수 없습니다. 예약 금액은 유지됩니다. 지갑 내역을 확인하고 고객 지원에 문의하세요. {error}",
    redemptionSuccess: "JC 환매 완료: {jc}를 {usdt}로 교환했습니다. {tx}",
    redemptionPending: "JC 환매가 예약됐지만 온체인 정산은 아직 확인되지 않았습니다. 예약 금액은 유資料資料資料되며 자동 재시도됩資料資料資料다. 資料資料복 신청하지 마세요. {tx}",
  },
  th: {
    purchaseSuccess: "資料資料資料อน {usdt} เข資料資料資料าคลังและแลกเป็น {jc} สำเร็จแล้ว {tx}",
    purchasePending: "USDT อยู่บ資料資料เชน資料資料ล้ว แ資料資料่การชำ資料資料資料ะ／資料資料資料ันทึ資料資料 JC ยั資料資料資料資料資料ำเ資料資料ินการอยู่ ระบบจะเก็บยอดสำรองและลองใหม่อัตโนมัติ โปรดอย่าซื้อซ้ำ {tx}",
    purchaseUnconfirmed: "ยังยืนยันไม่ได้ว่าส่ง USDT แล้วหรือไม่ ระบบยังเก็บย資料資料ดสำรองไว้ โปร資料資料資料ตรวจสอบประวัต資料資料資料กระเป๋資料資料และติดต่อฝ่ายช่วยเหลือ {error}",
    redemptionSuccess: "แลก資料資料ืน JC สำเร็จ: {jc} แลกเป็น {usdt} {tx}",
    redemptionPending: "ส資料資料資料รองคำขอแลกคื資料資料資料 JC แล้ว แ資料資料่ยังไม่ยืนยันการชำระบนเชน ระบบจะลองใหม่อัตโนมัติ โปรดอย่าส่งคำขอซ้ำ {tx}",
  },
  vi: {
    purchaseSuccess: "Đã chuyển {usdt} vào kho và đổi thành {jc}. {tx}",
    purchasePending: "USDT đã lên chuỗi nhưng việc quyết toán／ghi sổ JC vẫn đang xử lý. Khoản giữ chỗ được bảo toàn và sẽ tự thử lại. Vui lòng không mua lại. {tx}",
    purchaseUnconfirmed: "Chưa thể xác nhận USDT đã được gửi hay chưa. Khoản giữ chỗ vẫn được bảo toàn. Hãy kiểm tra ví và liên hệ hỗ trợ. {error}",
    redemptionSuccess: "Đã đổi JC: {jc} lấy {usdt}. {tx}",
    redemptionPending: "Yêu cầu đổi JC đã được giữ chỗ nhưng chưa xác nhận quyết toán on-chain. Hệ thống sẽ tự thử lại; vui lòng không gửi lại. {tx}",
  },
  id: {
    purchaseSuccess: "{usdt} telah dikirim ke brankas dan ditukar menjadi {jc}. {tx}",
    purchasePending: "USDT sudah tercatat on-chain, tetapi penyelesaian／pencatatan JC masih diproses. Dana reservasi dipertahankan dan akan dicoba ulang otomatis. Jangan membeli lagi. {tx}",
    purchaseUnconfirmed: "Pengiriman USDT belum dapat dipastikan. Reservasi tetap ditahan. Periksa aktivitas dompet dan hubungi dukungan. {error}",
    redemptionSuccess: "Penukaran JC selesai: {jc} ditukar menjadi {usdt}. {tx}",
    redemptionPending: "Penukaran JC telah dicadangkan, tetapi penyelesaian on-chain belum terkonfirmasi. Reservasi dipertahankan dan akan dicoba ulang. Jangan ajukan lagi. {tx}",
  },
  ms: {
    purchaseSuccess: "{usdt} telah dipindahkan ke perbendaharaan dan ditukar kepada {jc}. {tx}",
    purchasePending: "USDT telah disahkan dalam rantaian, tetapi penyelesaian／catatan JC masih diproses. Tempahan dikekalkan dan akan dicuba semula secara automatik. Jangan beli sekali lagi. {tx}",
    purchaseUnconfirmed: "Penghantaran USDT belum dapat dipastikan. Tempahan masih dikekalkan. Semak aktiviti dompet dan hubungi sokongan. {error}",
    redemptionSuccess: "Penebusan JC selesai: {jc} ditukar kepada {usdt}. {tx}",
    redemptionPending: "Permohonan penebusan JC telah ditempah, tetapi penyelesaian dalam rantaian belum disahkan. Tempahan dikekalkan dan akan dicuba semula. Jangan hantar lagi. {tx}",
  },
  es: {
    purchaseSuccess: "Se enviaron {usdt} a la tesorería y se acreditaron {jc}. {tx}",
    purchasePending: "USDT está confirmado en la cadena, pero la liquidación／contabilización de JC sigue pendiente. La reserva se mantiene y se reintentará automáticamente. No repitas la compra. {tx}",
    purchaseUnconfirmed: "No se pudo confirmar si se envió el USDT. La reserva sigue retenida. Revisa la actividad de la cartera y contacta con soporte. {error}",
    redemptionSuccess: "Canje de JC confirmado: {jc} por {usdt}. {tx}",
    redemptionPending: "El canje de JC está reservado, pero la liquidación en cadena aún no está confirmada. Se reintentará automáticamente. No envíes otra solicitud. {tx}",
  },
  fr: {
    purchaseSuccess: "{usdt} ont été transférés vers la trésorerie et {jc} crédités. {tx}",
    purchasePending: "Les USDT sont confirmés sur la chaîne, mais le règlement／l’écriture des JC est en attente. La réservation est conservée et sera réessayée automatiquement. Ne relancez pas l’achat. {tx}",
    purchaseUnconfirmed: "L’envoi des USDT n’a pas pu être confirmé. La réservation est maintenue. Vérifiez l’activité du portefeuille et contactez l’assistance. {error}",
    redemptionSuccess: "Conversion des JC confirmée : {jc} contre {usdt}. {tx}",
    redemptionPending: "Votre conversion de JC est réservée, mais le règlement sur la chaîne n’est pas confirmé. La réservation est conservée et sera réessayée automatiquement. Ne soumettez pas une nouvelle demande. {tx}",
  },
  de: {
    purchaseSuccess: "{usdt} wurden an die Treasury übertragen und {jc} gutgeschrieben. {tx}",
    purchasePending: "USDT sind on-chain bestätigt, die Abwicklung／Buchung von JC läuft noch. Die Reservierung bleibt bestehen und wird automatisch erneut versucht. Bitte nicht erneut kaufen. {tx}",
    purchaseUnconfirmed: "Es konnte nicht bestätigt werden, ob USDT gesendet wurden. Die Reservierung bleibt bestehen. Prüfen Sie Ihre Wallet-Aktivität und wenden Sie sich an den Support. {error}",
    redemptionSuccess: "JC-Einlösung bestätigt: {jc} gegen {usdt}. {tx}",
    redemptionPending: "Ihre JC-Einlösung ist reserviert, aber die On-Chain-Abwicklung ist noch nicht bestätigt. Die Reservierung bleibt bestehen und wird automatisch erneut versucht. Bitte nicht erneut beantragen. {tx}",
  },
  pt: {
    purchaseSuccess: "{usdt} foram transferidos para a tesouraria e {jc} foram creditados. {tx}",
    purchasePending: "USDT confirmado na blockchain, mas a liquidação／contabilização de JC continua pendente. A reserva é mantida e será tentada novamente automaticamente. Não repita a compra. {tx}",
    purchaseUnconfirmed: "Não foi possível confirmar se os USDT foram enviados. A reserva continua retida. Verifique a atividade da carteira e contacte o suporte. {error}",
    redemptionSuccess: "Resgate de JC confirmado: {jc} por {usdt}. {tx}",
    redemptionPending: "O resgate de JC está reservado, mas a liquidação on-chain ainda não foi confirmada. A reserva será mantida e tentada novamente. Não envie outro pedido. {tx}",
  },
  ru: {
    purchaseSuccess: "{usdt} переведены в казначейство, зачислено {jc}. {tx}",
    purchasePending: "USDT подтверждены в блокчейне, но расчёт／зачисление JC ещё выполняется. Резерв сохранён, система повторит попытку автоматически. Не покупайте повторно. {tx}",
    purchaseUnconfirmed: "Не удалось подтвердить отправку USDT. Резерв сохранён. Пров資料資料рьте операции кошелька и обратитесь в поддержку. {error}",
    redemptionSuccess: "Обмен JC подтверждён: {jc} на {usdt}. {tx}",
    redemptionPending: "Заявка на обмен JC зарезервирована, но расчёт в блокчейне ещё не подтверждён. Резерв сохранён, система повторит попытку. Не отправляйте заявку повторно. {tx}",
  },
  ar: {
    purchaseSuccess: "تم تحويل {usdt} إلى الخزينة وإضافة {jc}. {tx}",
    purchasePending: "تم تأكيد USDT على السلسلة، لكن تسوية／تسجيل JC ما زالت قيد المعالجة. سيبقى المبلغ محجوزًا وستتم إعادة المحاولة تلقائيًا. لا 資料資料كرر الشراء. {tx}",
    purchaseUnconfirmed: "تعذر تأكيد إرسال USDT. سيبقى الحجز قائمًا. تحقق من نشاط المحفظ資料資料 وتواصل مع الدعم. {error}",
    redemptionSuccess: "تم تأكيد استرداد JC: استبدال {jc} مقابل {usdt}. {tx}",
    redemptionPending: "تم حجز طل資料資料 استرداد JC، لكن التسوية على السلسلة لم تتأكد بعد. سيبقى الحجز قائمًا وستتم إعادة المحاولة تلقائيًا. لا تكرر الطلب. {tx}",
  },
  hi: {
    purchaseSuccess: "{usdt} ट्रेज़री में भेजे गए और {jc} जमा किए गए। {tx}",
    purchasePending: "USDT ऑन-च資料資料न पुष्टि हो गया है, लेकिन JC सेटलमेंट／लेजर प्रविष्टि अभी जारी है। आरक्षण सुरक्षित है औ資料資料 अपने आप फिर प्रयास होगा। खरीद दोबारा न करें। {tx}",
    purchaseUnconfirmed: "यह पुष्ट資料資料資料 नहीं हो स資料資料ी कि USDT भेजा गया या नहीं। आरक्षण सुरक्षित है। वॉलेट गतिविधि जाँचें और सहायता से संपर्क करें। {error}",
    redemptionSuccess: "JC रिडेम्प्शन की पुष्टि: {jc} के बदले {usdt}। {tx}",
    redemptionPending: "JC रिडेम्प्शन अनुरोध आरक्षित है, लेकिन ऑन-चेन निपटान की पुष्टि नहीं हुई। आरक्षण सुरक्षित है और अपने आप फिर प्रयास होगा। दोबारा अनुरोध न करें। {tx}",
  },
};

export const walletExchangeMessage = (
  language: Lang,
  key: WalletExchangeMessageKey,
  values: Record<string, string> = {},
) =>
  Object.entries(values).reduce(
    (message, [name, value]) => message.split(`{${name}}`).join(value),
    walletExchangeMessages[language][key],
  );

const interfaceCoverageCopy: Record<Lang, Record<string, string>> = {
  "zh-TW": {
    "누적 공개 수량": "已釋出份額", "현재 청약 가능": "目前可認購", "다음 공개까지": "下次釋出倒數", "다음 정기 공개까지": "平常日下次釋出倒數", "청약 진행률": "認購進度", "거래량": "成交量", "동일한 자산과 결제 통화로 등록된 주문은 지갑이 달라도 매수 가격이 매도 가격에 도달하면 가격·시간 우선순위에 따라 자동 체결됩니다. 미체결 수량은 에스크로에 보관되어 주문장에 남습니다. 매도 주문에는 1 JC의 일회성 수수료(취소 시 환불되지 않음)가 부과되며, 체결 시 1% 수수료가 추가됩니다. 온체인 가스비는 플랫폼이 부담합니다.": "同標的、同計價幣且跨錢包的掛單，買方出價達到賣價時會依價格與時間優先自動撮合；未成交部分仍由合約託管並留在訂單簿。賣方掛單一次性收取 1 JC（取消不退），成交另收 1% 費用，鏈上 Gas 由平台代付。", "팀 회원": "團隊會員", "이번 달 신규 유효 회원": "本月新增有效會員", "누적 추가 보너스 진행 상황": "動態加碼進度", "현재 적용 중인 추가 보資料資料資料스 비율": "目前已生效加碼百分點", "회원 거래 및 資料資料資料미션 내역": "用戶交易與分潤紀錄", "이름, 이메일 또는 사용자 ID": "資料資料資料稱、Email 或 User ID", "시작일": "開始日資料資料", "종료일": "結束日期", "기간 초기화": "清除時間", "내 프로모션 코드": "我的推廣碼", "프로모션 코드 업데이트": "資料資料資料新推廣資料資料", "동적加碼進度": "動態加碼進度", "에이전트 또는 일반 회원을 선택하면 상세 내역을 확인할 수 있습니다.": "先選擇創世紀L1或創世紀L2，再檢視該用戶的詳細紀錄。", "검색 조건에 맞는 에이전트 또는 일반 회원이 없습니다.": "找不到符合名稱的代理或一般用戶",
  },
  "zh-CN": {}, en: {}, ja: {}, ko: {}, th: {}, vi: {}, id: {}, ms: {}, es: {}, fr: {}, de: {}, pt: {}, ru: {}, ar: {}, hi: {},
};

const translatedCoverage: Record<Lang, Record<string, string>> = {
  "zh-TW": {},
  en: { "누적 공개 수량": "Released shares", "현재 청약 가능": "Available to subscribe", "다資料資料 공개까지": "Next release in", "청약 진행률": "Subscription progress", "거래량": "Trading volume", "팀 회원": "Team members", "이번 달 신규 유효 회원": "New active members this month", "누적 추가 보너스 진행 상황": "Cumulative bonus progress", "현재 적용 중인 추가 보너스 비율": "Current active bonus rate", "회원 거래 및 커미션 내역": "Member trades and commissions", "시작일": "Start date", "종료일": "End date", "기간 초기화": "Clear dates", "내 프로모션 코드": "My referral code", "프로모션 코드 업데이트": "Update referral code" },
  ja: { "누적 공개 수량": "公開済み口数", "현재 청약 가능": "現在申込可能", "다음 공개까지": "次回公開まで", "청약 진행률": "申込進捗", "거래량": "取引量", "팀 회원": "チーム会員", "이번 달 신규 유효 회원": "今月の新規有効会員", "누적 추가 보너스 진행 상황": "追加ボーナス進捗", "현재 적용 중인 추가 보너스 비율": "現在適用中の追加ボーナス率", "회원 거래 및 커미션 내역": "会員の取引・コミッション履歴", "시작일": "開始日", "종료일": "終了日", "기간 초기화": "期間をクリア", "내 프로모션 코드": "紹介コード", "프로모션 코드 업데이트": "紹介コードを更新" },
  ko: {},
  "zh-CN": { "누적 공개 수량": "已释放份额", "현재 청약 가능": "当前可认购", "다음 공개까지": "距离下次释放", "청약 진행률": "认购进度", "거래량": "成交量", "팀 회원": "团队会员", "이번 달 신규 유효 회원": "本月新增有效会员", "누적 추가 보너스 진행 상황": "动态加码进度", "현재 적용 중인 추가 보너스 비율": "当前生效加码比例", "회원 거래 및 커미션 내역": "用户交易与分润记录", "시작일": "开始日期", "종료일": "结束日期", "기간 초기화": "清除时间", "내 프로모션 코드": "我的推广码", "프로모션 코드 업데이트": "更新推广码" },
  "th": { "資料資料資料적 공개 수량": "จำนวนที่เปิดขายแล้ว", "현재 청약 가능": "จำนวนที่สมัค資料資料資料資料ด้ขณะนี้", "다음 공개까지": "จนกว่าจะเปิดขายครั้งถัดไป", "청약 진행률": "ความคืบหน้าการสมัคร", "거래량": "ปริมาณการซื้อขาย", "팀 회원": "สมาชิกทีม", "이번 달 신규 유효 회원": "สมาชิกที่ใช้งานใหม่ในเดือนนี้", "資料資料資料작일": "วันที่เริ่มต้น", "종료일": "วันที่สิ้นสุด", "기간 초기화": "ล้างช่วงเวลา", "내 프로모션 코드": "รหัสแนะนำของฉัน", "프로모션 코드 업데이트": "อัปเดตรหัสแนะนำ" },
  "vi": { "누적 공資料資料資料 수량": "Số lượng đã phát hành", "현재 청약 가능": "Có thể đăng ký hiện tại", "다음 공개까지": "Đến đợt phát hành tiếp theo", "청약 진행률": "Tiến độ đăng ký", "거래량": "Khối lượng giao dịch", "資料資料資料 회원": "Thành viên nhóm", "이번 달 資料資料資料규 유효 회원": "Thành viên hiệu lực mới th資料資料ng này", "資料資料資料작일": "Ngày b資料資料t đầu", "종료資料資料資料資料資料": "Ngày kết thúc", "기간 초기화": "Xóa thời gian", "내 프로모션 코드": "Mã giới thiệu của tôi", "프로모션 코드 업데이트": "Cập nhật mã giới thiệu" },
  id: { "누적 공개 수량": "Jumlah yang telah dirilis", "현재 청약 가능": "Tersedia untuk berlangganan", "다음 공개까지": "Menuju rilis berikutnya", "청약 진행률": "Progress langganan", "거래량": "Volume perdagangan", "팀 회원": "Anggota tim", "이번 달 신규 유효 회원": "Anggota aktif baru bulan ini", "시작일": "Tanggal mulai", "종資料資料資料일": "Tanggal selesai", "기간 초기화": "Hapus waktu", "내 프로모資料資料資料 코드": "Kode referral saya", "프로資料資料資料션 코드 업데이트": "Perbarui kode referral" },
  ms: { "누적 공개 수량": "Jumlah diterbitkan", "현재 청약 가능": "Boleh dilanggan sekarang", "다음 공개까지": "Sehingga keluaran seterusnya", "청약 진행률": "Kemajuan langganan", "거래량": "Jumlah dagangan", "팀 회원": "Ahli pasukan", "이번 달 신규 유효 회원": "Ahli aktif baharu bulan ini", "시작일": "Tarikh mula", "종료일": "Tarikh tamat", "기간 초기화": "Kosongkan masa", "내 프로모션 코드": "Kod rujukan saya", "프로모션 코드 업데이트": "Kemas kini kod rujukan" },
  es: { "누적 공개 수량": "Cantidad liberada", "현재 청약 가능": "Disponible para suscribir", "다음 공개까지": "Hasta la próxima emisión", "청약 진행률": "Progreso de suscripción", "거래량": "Volumen de operaciones", "팀 회원": "Miembros del equipo", "이번 달 신규 유효 회원": "Nuevos miembros activos este mes", "시작일": "Fecha de inicio", "종료일": "Fecha de fin", "기간 초기화": "Borrar fechas", "내 프로모션 코드": "Mi código de referido", "프로모션 코드 업데이트": "Actualizar código de referido" },
  fr: { "누적 공개 수량": "Parts libérées", "현재 청약 가능": "Disponible à la souscription", "다음 공개까지": "Jusqu'à la prochaine émission", "청약 진행률": "Progression de la souscription", "거래량": "Volume des échanges", "팀 회원": "Membres de l'équipe", "이번 달 신규 유효 회원": "Nouveaux membres actifs ce mois-ci", "시작일": "Date de début", "종료일": "Date de fin", "기간 초기화": "Effacer les dates", "내 프로모션 코드": "Mon code de parrainage", "프로모션 코드 업데이트": "Mettre à jour le code" },
  de: { "누적 공개 수량": "Freigegebene Anteile", "현재 청약 가능": "Jetzt verfügbar", "다음 공개까지": "Bis zur nächsten Freigabe", "청약 진행률": "Zeichnungsfortschritt", "거래량": "Handelsvolumen", "팀 회원": "Teammitglieder", "이번 달 신규 유효 회원": "Neue aktive Mitglieder diesen Monat", "시작일": "Startdatum", "종료일": "Enddatum", "기간 초기화": "Zeitraum löschen", "내 프로모션 코드": "Mein Empfehlungscode", "프로모션 코드 업데이트": "Empfehlungscode aktualisieren" },
  pt: { "누적 공개 수량": "Quantidade liberada", "현재 청약 가資料資料資料": "Disponível para subscrição", "다음 공개까지": "Até à próxima emissão", "청약 진행률": "Progresso da subscrição", "거래량": "Volume de negociação", "팀 회원": "Membros da equipa", "이번 달 신규 유효 회원": "Novos membros ativos este mês", "시작일": "Data inicial", "종료일": "Data final", "기간 資料資料기화": "Limpar datas", "내 프로모션 코드": "Meu código de referência", "프로모션 코드 업데이트": "Atualizar código" },
  ru: { "누적 공개 수량": "Выпущено долей", "현재 청약 가능": "Доступно для подписки", "다음 공개까지": "До следующего выпуска", "청資料資料資料 진행률": "Прогресс подписки", "거래량": "Объём торгов", "팀 회원": "Участники команды", "이번 달 신규 유효 회원": "Новые активные участники 資料資料а месяц", "시작일": "Дата начала", "종료일": "Дата окончания", "기간 초기화": "О資料資料истить даты", "내 資料資料로모션 코드": "資料資料ой реферальный код", "프로모션 코드 업데이트": "Обновить код" },
  ar: { "누적 공개 수량": "الكمية المُصدرة", "현재 청약 가능": "متاح للاكتتاب", "다음 공개까지": "حتى الإصدار التالي", "청약 진행률": "تقدم الاكتتاب", "거래량": "حجم التداول", "팀 회원": "أعضاء الفريق", "이번 달 신규 유효 회원": "الأعضاء النشطون الجدد هذا الشهر", "시작일": "تاريخ البدء", "종료일": "تاريخ الانتهاء", "기간 초기화": "مسح التواريخ", "내 프로모션 코드": "رمز الإحالة الخاص بي", "프로모션 코드 업데이트": "تحديث رمز الإحالة" },
  hi: { "누적 공개 수량": "जारी की गई मात्रा", "현재 청약 가능": "अभी सदस्यता उपलब्ध", "다음 공개까지": "अगली रिलीज़ तक", "청약 진행률": "सदस्यता प्रगति", "거래량": "ट्रेडिंग वॉल्यूम", "팀 회원": "टीम सदस्य", "이번 달 신규 유효 회원": "इस महीने के नए सक्रिय सदस्य", "시작일": "आरंभ तिथि", "종료일": "समाप्ति तिथि", "기간 초기화": "तिथियां साफ़ करें", "내 프로모션 코드": "मेरा रेफरल कोड", "프로모션 코드 업데이트": "रेफरल कोड अपडेट करें" },
};

const fallbackCoverageCopy: Record<Lang, Record<string, string>> = {
  "zh-TW": {},
  "zh-CN": { "掛單現況": "订单状資料資料資料", "鏈上託管": "链上托管", "賣單": "卖单", "買單": "买单", "購買": "购买", "出售": "出售", "可用 JC": "可用 JC", "持有份資料資料資料": "持有份额", "單價（JC）": "单价（JC）", "固定價": "固定价", "掛單份額": "挂单份额", "掛單總額": "挂单总额", "我的掛單": "我的挂单", "尚未刊登任何掛單": "尚未刊登任何挂单", "我的成交紀錄": "我的成交记录", "時間": "时间", "成交份額": "成交份额", "成交額": "成交额", "平台費": "平台费", "淨額": "净额", "掛單": "挂单", "目前沒有掛單": "目前没有挂单", "兌換JC": "JC 金库兑换" },
  en: { "掛單現況": "Order status", "鏈上託管": "On-chain escrow", "賣單": "Sell orders", "買單": "Buy orders", "購買": "Buy", "出售": "Sell", "可用 JC": "Available JC", "持有份額": "Holdings", "單價（JC）": "Unit price (JC)", "固定價": "Fixed price", "掛單份額": "Order quantity", "掛單總額": "Order total", "我的掛單": "My orders", "尚未刊資料資料任何掛單": "No orders listed", "我的成交紀錄": "My trade history", "時間": "Time", "成交份額": "Filled quantity", "成交額": "Trade amount", "平台費": "Platform fee", "淨額": "Net amount", "掛單": "Place order", "目前沒資料資料掛單": "No orders", "兌換JC": "JC vault exchange" },
  ja: { "掛單現況": "資料資料資料文状況", "鏈上託管": "オ資料資料チェーン資料資料スクロー", "賣單": "売り注文", "買單": "資料資料資料い資料資料資料資料資料資料", "購資料資料資料": "購入", "出售": "売却", "可用 JC": "利用可能なJC", "持有份額": "保有口数", "單價（JC）": "単価（JC）", "固定價": "固定価格", "掛單份額": "注文数量", "掛單總額": "注文合計", "我的掛單": "自分の注文", "尚未刊登任何掛單": "注文はありません", "我的成交紀錄": "自分の取引履歴", "時間": "時資料資料", "成交份額": "約定数量", "成交額": "取引金額", "平台費": "プラットフォー資料資料資料手数料", "淨額": "純額", "掛單": "注文する", "目前沒有掛單": "注文はありません", "兌換JC": "JC金庫交換" },
  ko: { "資料資料資料單現況": "주문 현황", "鏈上託管": "온체인 에스크로", "賣單": "매도 주문", "買單": "매수 주資料資料資料", "購買": "구매", "出售": "판매", "可用 JC": "사용 가능 JC", "持有份額": "보유 수량", "單價（JC）": "단가(JC)", "固定價": "고정 가격", "掛單份額": "주문 수량", "掛單總額": "주문 총액", "我的掛單": "내 주문", "尚未刊登任何掛單": "등록된 주문이 없습니다.", "我的成交紀錄": "내 체결 내역", "時間": "시간", "成交份額": "체결 수량", "成交額": "거래 금액", "平台費": "플랫폼 수수료", "淨額": "정산 금액", "掛單": "주문 등록", "目前沒有掛單": "등록된 주문이 없습니다.", "兌換JC": "JC 금고 교환" },
  th: { "掛單現況": "สถานะคำสั่ง", "鏈上託管": "เอสโครว์บนเชน", "賣單": "คำสั่งขาย", "買單": "คำสั่งซื้อ", "購買": "ซื้อ", "出售": "ขาย", "可用 JC": "JC ที่ใช้ได้", "持有份額": "จำนวนที่ถือครอง", "單價（JC）": "ราคาต่อหน่วย (JC)", "固定價": "ราคาคงที่", "掛單份額": "จำนวนคำสั่ง", "掛單總額": "ยอดรวมคำสั่ง", "我的掛單": "คำสั่งของฉัน", "尚未刊登任何掛單": "ยังไม่มีคำสั่ง", "我的成交紀錄": "ประวัติการซื้อขายของฉัน", "時間": "เวลา", "掛單": "วางคำสั่ง", "兌換JC": "แลกเปลี่ยน JC ในคลัง" },
  vi: { "掛單現況": "Trạng thái lệnh", "鏈上託管": "Ký quỹ on-chain", "賣單": "Lệnh bán", "買單": "Lệnh mua", "購買": "Mua", "出售": "Bán", "可用 JC": "JC khả dụng", "持有份額": "Số lượng nắm giữ", "單價（JC）": "Đơn giá (JC)", "固定價": "Giá cố định", "掛單份額": "Số lượng lệnh", "掛單總額": "Tổng lệnh", "我的掛單": "Lệnh của tôi", "尚未刊登任何掛單": "Chưa có lệnh", "我的成交紀錄": "Lịch sử giao dịch", "時間": "Thời gian", "掛單": "Đặt lệnh", "兌換JC": "Đổi JC trong kho" },
  id: { "掛單現況": "Status pesanan", "鏈上託管": "Escrow on-chain", "賣單": "Pesanan jual", "買單": "Pesanan beli", "購買": "Beli", "出售": "Jual", "可用 JC": "JC tersedia", "持有份額": "Kepemilikan", "單價（JC）": "Harga satuan (JC)", "固定價": "Harga tetap", "掛單份額": "Jumlah pesanan", "掛單總額": "Total pesanan", "我的掛單": "Pesanan saya", "尚未刊登任何掛單": "Belum ada pesanan", "我的成交紀錄": "Riwayat transaksi", "時間": "Waktu", "掛單": "Buat pesanan", "兌換JC": "Penukaran JC di vault" },
  ms: { "掛單現況": "Status pesanan", "鏈上託管": "Escrow rantaian", "賣單": "Pesanan jual", "買單": "Pesanan beli", "購買": "Beli", "出售": "Jual", "可用 JC": "JC tersedia", "持有份額": "Pegangan", "單價（JC）": "Harga seunit (JC)", "固定價": "Harga tetap", "掛單份額": "Kuantiti pesanan", "掛單總額": "Jumlah pesanan", "我的掛單": "Pesanan saya", "尚未刊登任何掛單": "Tiada pesanan", "我的成交紀錄": "Sejarah dagangan saya", "時間": "Masa", "掛單": "Buat pesanan", "兌換JC": "Pertukaran JC peti besi" },
  es: { "掛單現況": "Estado de órdenes", "鏈上託管": "Custodia on-chain", "賣單": "Órdenes de venta", "買單": "Órdenes de compra", "購買": "Comprar", "資料資料售": "Vender", "可用 JC": "JC disponible", "持有份額": "Participaciones", "單價（JC）": "Precio unitario (JC)", "固定價": "Precio fijo", "掛單份額": "Cantidad de orden", "掛單總額": "Total de orden", "我的掛單": "Mis órdenes", "尚未刊登任何掛單": "No hay órdenes", "我的成交紀錄": "Mi historial", "時間": "Hora", "掛單": "Crear orden", "兌換JC": "Cambio de JC en bóveda" },
  fr: { "掛單現況": "État des ordres", "鏈上託管": "Séquestre on-chain", "賣單": "Ordres de vente", "買單": "Ordres d'achat", "購買": "Acheter", "出售": "Vendre", "可用 JC": "JC disponible", "持有份額": "Parts détenues", "單價（JC）": "Prix unitaire (JC)", "固定價": "Prix fixe", "掛單份額": "Quantité", "掛單總額": "Total de l'ordre", "我的掛單": "Mes ordres", "尚未刊登任何掛單": "Aucun ordre", "我的成交紀錄": "Mon historique", "時間": "Heure", "掛單": "Placer l'ordre", "兌換JC": "Échange JC du coffre" },
  de: { "掛單現況": "Orderstatus", "鏈上託管": "On-Chain-Treuhand", "賣單": "Verkaufsorders", "買單": "Kauforders", "購買": "Kaufen", "出售": "Verkaufen", "可用 JC": "Verfügbares JC", "持有份額": "Bestand", "單價（JC）": "Stückpreis (JC)", "固定價": "Festpreis", "掛單份額": "Ordermenge", "掛單總額": "Ordersumme", "我的掛單": "Meine Orders", "尚未刊登任何掛單": "Keine Orders", "我的成交紀錄": "Meine Handelshistorie", "時間": "Zeit", "掛單": "Order platzieren", "兌換JC": "JC-Tresorwechsel" },
  pt: { "掛單現況": "Estado das ordens", "鏈上託管": "Custódia on-chain", "賣單": "Ordens de venda", "資料資料單": "Ordens de compra", "購買": "Comprar", "出售": "Vender", "可用 JC": "JC disponível", "持有份額": "Participações", "單價（JC）": "Preço unitário (JC)", "固定價": "Preço fixo", "掛單份額": "Quantidade", "掛單總額": "Total da ordem", "我的掛單": "Minhas ordens", "尚未刊登任何掛單": "Sem ordens", "我的成交紀錄": "Meu histórico", "時間": "Hora", "掛單": "Criar ordem", "兌換JC": "Troca JC do cofre" },
  ru: { "掛單現況": "Статус заявок", "鏈上託管": "Ончейн-эскроу", "賣單": "Заявки на продажу", "買單": "Заявки на покупку", "購買": "Купить", "出售": "Продать", "可用 JC": "Доступно JC", "持有份額": "Доли", "單價（JC）": "Цена за единицу (JC)", "固定價": "Фиксированная це資料資料а", "掛單份資料資料資料": "Количество", "掛單總額": "Сумма заявки", "我的掛單": "Мои 資料資料аявки", "尚未刊登任何掛單": "Заявок 資料資料ет", "我的成交紀錄": "Моя 資料資料資料стория", "時間": "Врем資料資料", "掛單": "資料資料азместить заявку", "兌換JC": "Об資料資料ен JC в хранилище" },
  ar: { "掛單資料資料資料況": "حا資料資料ة الطلبات", "鏈上託管": "ضمان على 資料資料لسلسلة", "賣單": "طلبات الب資料資料ع", "買單": "طلبات الشراء", "購買": "شراء", "出售": "بيع", "可用 JC": "JC المتاح", "持有份額": "الحصص", "單價（JC）": "سعر الوحدة (JC)", "固定價": "سعر ثابت", "掛單份額": "كمية الطلب", "掛單總額": "إجمالي الطلب", "我的掛單": "طلباتي", "尚未刊登任何掛單": "لا توجد طلب資料資料ت", "我的成交紀錄": "سجل تداولاتي", "時間": "ال資料資料قت", "掛單": "إنشاء طلب", "兌換JC": "تبادل JC في الخزينة" },
  hi: { "掛單現況": "ऑर資料資料डर स्थित資料資料", "目前沒有掛單": "कोई ऑर्資料資料र नहीं", "方向": "資料資料िशा", "轉入": "अंदर आया", "轉出": "बाहर गया", "鏈上託管": "ऑन-चेन एस्क्रो", "賣單": "बिक्री ऑर्डर", "買資料資料": "खरीद ऑर्डर", "購買": "खरीदें", "出售": "बेचें", "可用 JC": "उपलब्ध JC", "持有份額": "होल्डिंग", "單價（JC）": "इकाई मूल्य (JC)", "固定價": "निश्चित मूल्य", "掛單份額": "ऑर्डर मात्रा", "掛單總額": "ऑर्डर कुल", "我的掛單": "मेरे ऑर्डर", "尚未刊登任何掛單": "कोई ऑर्डर नहीं", "我的成交紀錄": "मेरी ट्रेडिंग हिस्ट्री", "時間": "समय", "掛單": "ऑर्डर रखें", "成交份額": "भरी गई मात्रा", "成交額": "लेन-देन राशि", "平台費": "प्लेटफ़ॉर्म शुल्क", "淨額": "शुद्ध राशि", "兌換JC": "JC वॉल्ट एक्सचेंज", "買入": "खरीद", "賣出": "बिक्री", "購買份額": "शेयर खरीदें", "總發行量": "कुल जारी मात्रा", "剩餘發行量": "शेष जारी मात्रा", "私募結束時間": "निजी बिक्री समाप्ति समय", "訂單總": "ऑर्डर कुल", "確認後份額會直接鎖在鏈上託管合約；收取一次性 1 JC 掛單費（取消不退），成交再收 1%。": "पुष्टि के बाद शेयर ऑन-चेन एस्क्रो में लॉक होंगे; एक बार 1 JC ऑर्डर शुल्क लिया जाएगा (रद्द करने पर वापसी नहीं), और निपटान पर 1% शुल्क लिया जाएगा।", "可掛出份額": "बेचने योग्य शेयर", "訂單數量": "ऑर्डर मात्रा", "單位價格（JC）": "इकाई मूल्य (JC)" },
};

const commonUiCopy: Partial<Record<Lang, Record<string, string>>> = {
  hi: {
    "방향": "दिशा", "금액": "राशि", "상대 주소": "प्रतिपक्ष पता", "시간": "समय", "온체인 거래": "ऑन-चेन लेन-देन",
    "온체인 USDT 받음": "ऑन-चेन USDT प्राप्त", "온체인 USDT 보냄": "ऑन-चेन USDT भेजा", "신규 기록만 표시": "केवल नई प्रविष्टियां दिखा रहे हैं",
    "본인": "आप", "추천 코드가 복사되었습니다.": "रेफ़रल कोड कॉपी हो गया है।", "추천 링크가 복사되었습니다.": "रेफ़रल लिंक कॉपी हो गया है।",
    "프라이빗 청약": "प्राइवेट सब्सक्रिप्शन", "2차 시장 매수": "द्वितीयक बाज़ार खरीद", "2차 시장 매도": "द्वितीयक बाज़ार बिक्री",
    "에이전트 정보를 불러오는 중…": "एजेंट डेटा लोड हो रहा है…", "에이전트 센터를 불러올 수 없습니다. 계정 권한을 확인해 주세요.": "एजेंट केंद्र लोड नहीं हो सका। कृपया खाते की अनुमति जांचें।",
    "에이전트 운영 센터": "एजेंसी संचालन केंद्र", "QR 코드 추천": "QR कोड रेफ़रल", "팀 회원": "टीम सदस्य", "이번 달 신규 유효 회원": "इस महीने के नए सक्रिय सदस्य",
    "선택 기간 개인 보너스": "चयनित अवधि का व्यक्तिगत बोनस", "직속 회원과 본인 투자로 발생한 커미션": "प्रत्यक्ष सदस्यों और आपके निवेश से अर्जित कमीशन", "본인 투자로 발생한 커미션": "आपके निवेश से अर्जित कमीशन",
    "선택 기간 팀 보너스": "चयनित अवधि का टीम बोनस", "에이전트와 하위 일반 회원이 발생시킨 커미션": "एजेंटों और अधीनस्थ सदस्यों से अर्जित कमीशन", "하위 일반 회원이 발생시킨 커미션": "अधीनस्थ सदस्यों से अर्जित कमीशन",
    "누적 추가 보너스 진행 상황": "संचयी अतिरिक्त बोनस प्रगति", "현재 적용 중인 추가 보너스 비율": "वर्तमान अतिरिक्त बोनस दर",
    "회원 거래 및 커미션 내역": "सदस्य लेन-देन और कमीशन रिकॉर्ड", "에이전트 또는 일반 회원을 선택하면 상세 내역을 확인할 수 있습니다.": "विस्तृत रिकॉर्ड देखने के लिए एजेंट या सामान्य सदस्य चुनें।",
    "資料資料資料름으로 검색": "नाम से खोजें", "이름, 이메일 또는 사용자 ID": "नाम, ईमेल या यूज़र ID", "시작일": "आरंभ तिथि", "종료일": "सम資料資料資料प्ति तिथि", "기간 초기화": "अवधि साफ़ करें",
    "직속 에이전트": "प्रत्यक्ष एजेंट", "이 에이전트의 하위 회원이 없습니다.": "इस एजेंट के कोई अधीनस्थ सदस्य नहीं हैं।", "일반 회원": "सामान्य सदस्य", "직속 회원": "प्रत्यक्ष सदस्य",
    "검색 조건에 맞는 에이전트 또는 일반 회원이 없습니다.": "खोज शर्तों से मेल खाने वाला कोई एजेंट या सदस्य नहीं मिला।", "회원 상세 내역": "सदस्य विवरण", "이번 달 투자": "इस महीने का निवेश", "수수료": "शुल्क", "회원 상태": "सदस्य स्थिति", "유효": "सक्रि資料資料", "기준 미달": "मानदंड पूरा नह資料資料資料ं",
    "거래 내역": "लेन-देन रि資料資料資料資料資料र्ड", "선資料資料한 기간에 거래 내역이 없습니다.": "資料資料資料यनित अवधि में कोई लेन-देन नही資料資料資料 है।", "커미션 내역": "कमीशन रिकॉर्ड", "선택한 기간에 이 회원으로 인해 발생한 커미션이 資料資料습니다.": "इस सदस्य से संब資料資料ध資料資料資料त कोई 資料資料मीशन नह資料資料資料ं है।",
    "개인": "व्यक्तिगत", "팀": "टीम", "팀 보너스 커미션 내역": "टीम बोनस कमीशन रिकॉर्ड", "개인 보너스 커미션 내역": "व्यक्तिगत बोनस कमीशन रिकॉर्ड", "합계": "कुल", "커미션 상세 내역": "कमीशन विवरण",
    "資料資料資料택한 기간에 커미션 내역이 없습니다.": "चयनित अवधि में कोई कमीशन रिकॉर्ड नहीं है।", "알 수 없는 회원": "अज्ञात सदस्य", "전용 추천 링크": "विशे資料資料 रेफ़रल लिंक", "추천 링크 복사": "रेफ़रल लिंक कॉपी करें", "지급 완료": "भुगतान किया गया", "지급 대기": "भुगतान लंबित",     "커미션 내역 보기 →": "資料資料मीशन रिकॉर्ड देखें →",
    "業資料資料與獎金僅統計 2026/10/04 11:57（台北）後的資料；更早的帳本保留供稽核，不納入彙總。": "प्रदर्शन और बोनस केवल 2026/10/04 11:57 (ताइपे) के बाद के डेटा से गिने जाते हैं; पुराने लेज़र ऑडिट के लिए रखे गए हैं और कुल में शामिल नहीं हैं।",
    "團隊會員": "टीम सदस्य", "本月新增有效會員": "इस महीने के नए सक्रिय सदस्य", "篩選期間個人獎金": "चयनित अवधि का व्यक्तिगत बोनस", "篩選期間團隊獎金": "चयनित अवधि का टीम बोनस", "動態加碼進度": "संचयी अतिरिक्त बोनस प्रगति", "目前已生效加碼百分點": "वर्तमान अतिरिक्त बोनस दर",
    "代理營運中心": "एजेंसी संचालन केंद्र", "QR Code推廣碼": "QR कोड रेफ़रल", "載入代理資料中…": "एजेंट डेटा लोड हो रहा है…", "無法載入代理後台，請確認帳號角色。": "एजेंट केंद्र लोड नहीं हो सका। कृपया खाते की अनुमति जांचें।",
    "QR Code 暫時無法產生，請稍後再試。": "QR कोड अभी नहीं बन सका। कृपया बाद में पुनः प्रयास करें।", "掃描 QR Code 後會開啟網站登入／註冊畫面。用戶完成登入後，系統會自動將此推廣碼綁定至帳號並建立代理層級。": "QR कोड स्कैन करने पर वेबसाइट का लॉगिन/पंजीकरण पृष्ठ खुलेगा। लॉगिन के बाद यह रेफ़रल कोड खाते से जुड़ जाएगा और एजेंट स्तर बनाया जाएगा।", "專屬推廣登入連結 QR Code": "विशेष रेफ़रल लॉगिन लिंक QR कोड", "正在產生 QR Code…": "QR कोड बनाया जा रहा है…", "專屬推廣連結": "विशेष रेफ़रल लिंक", "複製推廣連結": "रेफ़रल लिंक कॉपी करें",
    "用戶交易與分潤紀錄": "सदस्य लेन-देन और कमीशन रिकॉर्ड", "先選擇創世紀L1或創世紀L2，再檢視該用戶的詳細紀錄。": "विस्तृत रिकॉर्ड देखने के लिए एजेंट या सामान्य सदस्य चुनें।", "依名稱查詢": "नाम से खोजें", "名稱、Email 或 User ID": "नाम, ईमेल या यूज़र ID", "開始日期": "आरंभ तिथि", "結束日期": "समाप्ति तिथि", "清除時間": "अवधि साफ़ करें",
    "直屬代理": "प्रत्यक्ष एजेंट", "此代理目前沒有下線用戶": "इस एजेंट के कोई अधीनस्थ सदस्य नहीं हैं।", "一般用戶": "創世紀L2", "直屬": "प्रत्यक्ष सदस्य", "找不到符合名稱的代理或一般用戶": "खोज शर्तों से मेल खाने वाला कोई एजेंट या सदस्य नहीं मिला।", "用戶詳細紀錄": "सदस्य विवरण", "本月投資": "इस महीने का निवेश", "手續費": "शुल्क", "會員狀態": "सदस्य स्थिति", "有效": "सक्रिय", "未達門檻": "मानदंड पूरा नहीं", "交易紀錄": "लेन-देन रिकॉर्ड", "所選時間內沒有交易紀錄": "चयनित अवधि में कोई लेन-देन नहीं है", "分潤紀錄": "कमीशन रिकॉर्ड", "所選時間內沒有因該用戶產生的分潤紀錄": "इस सदस्य से संबंधित कोई कमीशन नहीं है",
    "個人": "व्यक्तिगत", "團隊": "टीम", "團隊獎金分潤紀錄": "टीम बोनस कमीशन रिकॉर्ड", "個人獎金分潤紀錄": "व्यक्तिगत बोनस कमीशन रिकॉर्ड", "創世紀L1及其底下創世紀L2下單所產生的分潤": "एजेंटों और अधीनस्थ सदस्यों से अर्जित कमीशन", "您本人與直屬會員下單所產生的分潤": "आप और प्रत्यक्ष सदस्यों से अर्जित कमीशन", "您本人投資下單所產生的分潤": "आपके निवेश से अर्जित कमीशन", "合計": "कुल", "分潤明細": "कमीशन विवरण", "所選時間內沒有分潤紀錄": "चयनित अवधि में कोई कमीशन रिकॉर्ड नहीं है", "未知用戶": "अ資料資料資料्ञात सदस्य", "推廣碼已複製": "रेफ़रल कोड कॉपी हो गया है।", "推廣連結已複製": "資料資料資料ेफ़रल लिंक कॉपी हो 資料資料या है।", "本人": "आप", "點擊查看分潤紀錄 →": "कमीशन रिकॉर्ड देखें →", "已於": "इस समय ऑन-चेन भुगतान पूरा हुआ", "已發放": "भुगतान किया गया", "待發放": "भुगतान लंबित",
  },
  en: {
    "방향": "Direction", "금액": "Amount", "상대 주소": "Counterparty address", "시간": "Time", "온체인 거래": "On-chain transaction",
    "온체인 USDT 받음": "On-chain USDT received", "온체인 USDT 보냄": "On-chain USDT sent", "신규 기록만 표시": "Showing new records only",
  },
};



const agentDashboardCopy: Record<Lang, Record<string, string>> = {
  "zh-TW": { "動態加碼進度": "動態加碼進度", "目前已生效加碼百分點": "目前已生效加碼百分點", "L1分潤紀錄": "L1分潤紀錄", "L2分潤紀錄": "L2分潤紀錄", "L1 與 L2 會員下單所產生的分潤": "L1 與 L2 會員下單所產生的分潤", "您本人與 L1 會員下單所產生的分潤": "您本人與 L1 會員下單所產生的分潤", "您本資料資料資料投資下單所產生的分潤": "您本人投資下單所產生的分潤", "分潤明細": "分潤明細", "所選時間內沒有分潤紀錄": "所選時間內沒有分潤紀錄" },
  "zh-CN": { "動態加碼進度": "动态加码进度", "目前已生效加碼百分點": "当前已生效加码百分点", "L1分潤紀錄": "L1分润记录", "L2分潤紀錄": "L2分润记录", "L1 與 L2 會員下單所產生的分潤": "L1 与 L2 会员下单产生的分润", "您本人與 L1 會員下單所產生的分潤": "您本人和 L1 会员下单产生的分润", "您本人投資下單所產生的分潤": "您本人投资下单产生的分润", "分潤明細": "分润明细", "所選時間內沒有分潤紀錄": "所选时间内没有分润记录" },
  en: { "動態加碼進度": "Dynamic bonus progress", "目前已生效加碼百分點": "Currently active bonus percentage points", "L1分潤紀錄": "L1 Commission Records", "L2分潤紀錄": "L2 Commission Records", "L1 與 L2 會員下單所產生的分潤": "Commissions generated by L1 and L2 member orders", "您本人與 L1 會員下單所產生的分潤": "Commissions from your orders and L1 member orders", "您本人投資下單所產生的分潤": "Commissions from your investment orders", "分潤明細": "Commission details", "所選時間內沒有分潤紀錄": "No commission records in the selected period" },
  ja: { "動態加碼進度": "動的ボーナス進捗", "目前已生效加碼百分點": "現在適用されているボーナス率", "L1分潤紀錄": "L1分配記録", "L2分潤紀錄": "L2分配記録", "L1 與 L2 會員下單所產生的分潤": "L1・L2会員の注文による分配", "您本人與 L1 會員下單所產生的分潤": "本人とL1会員の注文による分配", "您本人投資下單所產生的分潤": "本人の投資注文による分配", "分潤明細": "分配詳細", "所選時間內沒有分潤紀錄": "選択期間に分配記録はありません" },
  ko: { "動態加碼進度": "동적 보너스 진행률", "目前已生效加碼百分點": "현재 적용 중인 보너스 비율", "L1分潤紀錄": "L1 수수료 기록", "L2分潤紀錄": "L2 수수료 기록", "L1 與 L2 會員下單所產生的分潤": "L1 및 L2 회원 주문으로 발생한 수수료", "您本人與 L1 會員下單所產生的分潤": "본인 및 L1 회원 주문으로 발생한 수수료", "您本人投資下單所產生的分潤": "본인 투자 주문으로 발생한 수수료", "分潤明細": "수수료 상세", "所選時間內沒有分潤紀錄": "선택한 기간에 수수료 기록이 없습니다" },
  th: { "動態加碼進度": "ความคืบหน้าโบนัสแบบไดนามิก", "目前已生效加碼百分點": "เปอร์เซ็นต์โบนัสที่ใช้อยู่ในปัจจุบัน", "L1分潤紀錄": "บันทึกค่าคอมมิชชัน L1", "L2分潤紀錄": "บันทึกค่าคอมมิชชัน L2", "L1 與 L2 會員下單所產生的分潤": "ค่าคอมมิชชันจากคำสั่งซื้อของสมาชิก L1 และ L2", "您本人與 L1 會員下單所產生的分潤": "ค่าคอมมิชชันจากคำสั่งซื้อของคุณและสมาชิก L1", "您本人投資下單所產生的分潤": "ค่าคอมมิชชันจากคำสั่งซื้อการลงทุนของคุณ", "分潤明細": "รายละเอียดค่าคอมมิชชัน", "所選時間內沒有分潤紀錄": "ไม่มีบันทึกค่าคอมมิชชันในช่วงเวลาที่เลือก" },
  vi: { "動態加碼進度": "Tiến độ thưởng động", "目前已生效加碼百分點": "Phần trăm thưởng đang áp dụng", "L1分潤紀錄": "Lịch sử hoa hồng L1", "L2分潤紀錄": "Lịch sử hoa hồng L2", "L1 與 L2 會員下單所產生的分潤": "Hoa hồng từ đơn hàng của thành viên L1 và L2", "您本人與 L1 會員下單所產生的分潤": "Hoa hồng từ đơn hàng của bạn và thành viên L1", "您本人投資下單所產生的分潤": "Hoa hồng từ đơn đầu tư của bạn", "分潤明細": "Chi tiết hoa hồng", "所選時間內沒有分潤紀錄": "Không có lịch sử hoa hồng trong kỳ đã chọn" },
  id: { "動態加碼進度": "Progres bonus dinamis", "目資料資料資料已生效加碼百分點": "Persentase bonus yang sedang berlaku", "L1分潤紀錄": "Riwayat komisi L1", "L2分潤紀錄": "Riwayat komisi L2", "L1 與 L2 會員下單所產生的分潤": "Komisi dari pesanan anggota L1 dan L2", "您本人與 L1 會員下單所產生的分潤": "Komisi dari pesanan Anda dan anggota L1", "您本人投資下單所產生的分潤": "Komisi dari pesanan investasi Anda", "分潤明細": "Detail komisi", "所選時間內沒有分潤紀錄": "Tidak ada riwayat komisi pada periode yang dipilih" },
  ms: { "動態加碼進度": "Kemajuan bonus dinamik", "目前已生效加碼百分點": "Peratus bonus yang sedang berkuat kuasa", "L1分潤紀錄": "Rekod komisen L1", "L2分潤紀錄": "Rekod komisen L2", "L1 與 L2 會員下單所產生的分潤": "Komisen daripada pesanan ahli L1 dan L2", "您本人與 L1 會員下單所產生的分潤": "Komisen daripada pesanan anda dan ahli L1", "您本人投資下單所產生的分潤": "Komisen daripada pesanan pelaburan anda", "分潤明細": "Butiran komisen", "所選時間內沒有分潤紀錄": "Tiada rekod komisen dalam tempoh dipilih" },
  es: { "動態加碼進度": "Progreso del bono dinámico", "目前已生效加碼百分點": "Porcentaje de bono actualmente activo", "L1分潤紀錄": "Registros de comisión L1", "L2分潤紀錄": "Registros de comisión L2", "L1 與 L2 會員下單所產生的分潤": "Comisiones de pedidos de miembros L1 y L2", "您本人與 L1 會員下單所產生的分潤": "Comisiones de tus pedidos y de miembros L1", "您本人投資下單所產生的分潤": "Comisiones de tus pedidos de inversión", "分潤明細": "Detalles de comisión", "所選時間內沒有分潤紀錄": "No hay registros de comisión en el período seleccionado" },
  fr: { "動態加碼進度": "Progression du bonus dynamique", "目前已生效加碼百分點": "Pourcentage de bonus actuellement actif", "L1分潤紀錄": "Relevé des commissions L1", "L2分潤紀錄": "Relevé des commissions L2", "L1 與 L2 會員下單所產生的分潤": "Commissions générées par les commandes L1 et L2", "您本人與 L1 會員下單所產生的分潤": "Commissions de vos commandes et des membres L1", "您本人投資下單所產生的分潤": "Commissions de vos commandes d’investissement", "分潤明細": "Détails des commissions", "所選時間內沒有分潤紀錄": "Aucune commission sur la période sélectionnée" },
  de: { "動態加碼進度": "Dynamischer Bonusfortschritt", "目前已生效加碼百分點": "Aktuell gültiger Bonusprozentsatz", "L1分潤紀錄": "L1-Provisionsprotokoll", "L2分潤紀錄": "L2-Provisionsprotokoll", "L1 與 L2 會員下單所產生的分潤": "Provisionen aus Bestellungen von L1- und L2-Mitgliedern", "您本人與 L1 會員下單所產生的分潤": "Provisionen aus Ihren und L1-Bestellungen", "您資料資料人投資下單所產生的分潤": "Provisionen aus Ihren Anlagebestellungen", "分潤明細": "Provisionsdetails", "所選時間內沒有分潤紀錄": "Keine Provisionen im ausgewählten Zeitraum" },
  pt: { "動態加碼進度": "Progresso do bônus dinâmico", "目前已生效加碼百分點": "Percentual de bônus atualmente ativo", "L1分潤紀錄": "Registros de comissão L1", "L2分潤紀錄": "Registros de comissão L2", "L1 與 L2 會員下單所產生的分潤": "Comissões de pedidos de membros L1 e L2", "您本人與 L1 會員下單所產生的分潤": "Comissões dos seus pedidos e dos membros L1", "您本人投資下單所產生的分潤": "Comissões dos seus pedidos de investimento", "分潤明細": "Detalhes da comissão", "所選時間內沒有分潤紀錄": "Não há registros de comissão no período selecionado" },
  ru: { "動態加碼進度": "Динамика бонуса", "目前已生效加碼百分點": "Текущий процент бонуса", "L1分潤紀錄": "История комиссий L1", "L2分潤紀錄": "История комиссий L2", "L1 與 L2 會員下單所產生的分潤": "Комиссия от заказов участников L1 и L2", "您本人與 L1 會員下單所產生的分潤": "Комиссия от ваших заказов и заказов L1", "您本人投資下單所產生的分潤": "Комиссия от ваших инвестиционных заказов", "分潤明細": "Детали комиссии", "所選時間內沒有分潤紀錄": "За выбранный период комиссий нет" },
  ar: { "動態加碼進度": "تقدم المكافأة الديناميكية", "目前已生效加碼百分點": "نسبة المكافأة المطبقة حالياً", "L1分潤紀錄": "سجلات عمولة L1", "L2分潤紀錄": "سجلات عمولة L2", "L1 與 L2 會員下單所產生的分潤": "العمولات الناتجة عن طلبات أعضاء L1 وL2", "您本人與 L1 會員下單所產生的分潤": "عمولات طلباتك وطلبات أعضاء L1", "您本人投資下單所產生的分潤": "عمولات طلباتك الاستثمارية", "分潤明細": "تفاصيل العمولة", "所選時間內沒有分潤紀錄": "لا توجد سجلات عمولة في الفترة المحددة" },
  hi: { "動態加碼進度": "डायनामिक बोनस प्रगति", "目前已生效加碼百分點": "वर्तमान सक्रिय बोनस प्रतिशत", "L1分潤紀錄": "L1 कमीशन रिकॉर्ड", "L2分潤紀錄": "L2 कमीशन रिकॉर्ड", "L1 與 L2 會員下單所產生的分潤": "L1 और L2 सदस्यों के ऑर्डर से कमीशन", "您本人與 L1 會員下單所產生的分潤": "आपके और L1 सदस्यों के ऑर्डर से कमीशन", "您本人投資下單所產生的分潤": "आपके निवेश ऑर्डर से कमीशन", "分潤明細": "कमीशन विवरण", "所選時間內沒有分潤紀錄": "चयनित अवधि में कोई कमीशन रिकॉर्ड नहीं है" },
  };

const agentReferralCopy: Record<Lang, Record<string, string>> = {
  "zh-TW": { "QR Code 推廣碼": "QR Code 推廣碼", "L1 + L2 會員": "L1 + L2 會員", "篩選期間個人獎金": "篩選期間個人獎金", "L1 會員與您本人投資帶來的分潤": "L1 會員與您本人投資帶來的分潤", "篩選期間團隊獎金": "篩選期間團隊獎金", "L2 會員帶來的分潤": "L2 會員帶來的分潤", "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。", "找不到符合條件的用戶": "找不到符合條件的用戶" },
  "zh-CN": { "QR Code 推廣碼": "QR Code 推广码", "L1 + L2 會員": "L1 + L2 会员", "篩選期間個人獎金": "筛选期间个人奖金", "L1 會員與您本人投資帶來的分潤": "L1 会员与您本人投资带来的分润", "篩選期間團隊獎金": "筛选期间团队奖金", "L2 會員帶來的分潤": "L2 会员带来的分润", "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "先选择 L1 或 L2 会员，再查看该用户的详细记录。", "找不到符合條件的用戶": "找不到符合条件的用户" },
  en: { "QR Code 推廣碼": "QR Code Referral Code", "L1 + L2 會員": "L1 + L2 Members", "篩選期間個人獎金": "Personal bonus for selected period", "L1 會員資料資料您本人投資帶來的分潤": "Commissions from L1 members and your investments", "篩選期間團隊獎金": "Team bonus for selected period", "L2 會員帶來的分潤": "Commissions from L2 members", "先選擇 L1 或 L2 會資料資料，再檢視該用戶的詳細紀錄資料資料": "Select an L1 or L2 member to view detailed records.", "找不到符合條件的用戶": "No matching users found" },
  ja: { "QR Code 推廣碼": "QRコード紹介資料資料資料ード", "L1 + L2 會員": "L1 + L2会員", "篩選期間個人獎金": "選択期間の個人ボーナス", "L1 會員與您本人投資帶來的分潤": "L1会員と本人投資による分配", "篩選期間團隊獎金": "選択期間のチームボーナス", "L2 會員帶來的分潤": "L2会員による分配", "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "L1またはL2会員を選択して詳細記録を確認してください。", "找不到符合條件的用戶": "条件に一致するユーザーが見つかりません" },
  ko: { "QR Code 推廣碼": "QR 코드 추천 코드", "L1 + L2 會員": "L1 + L2 회원", "篩選期間個人獎金": "선택 기간 개인 보너스", "L1 會員與您本人投資帶來的分資料資料資料": "L1 회원 및 본인 투자로 발생資料資資料資料 수수료", "篩選期間團隊獎資料資料": "선택 기간 팀 보資料資料스", "L2 會資料資料帶來的分潤": "L2 회資料資料資料資料資料로 발생한 資料資料수료", "先選擇 L1 或 L2 資料資料資料員，再檢視該用戶的詳細紀錄。": "L1 또는 L2 회원資料資料 선택해 상세 기록을 확資料資料資料하세요.", "找不到符合條件的用戶": "조건에 맞는 사용자가 없습니다" },
  th: { "QR Code 推廣碼": "QR Code รหัสแนะนำ", "L1 + L2 會員": "สมาชิก L1 + L2", "篩選期間個人獎金": "โบนัสส่วนตัวในช่วงที่เลือก", "L1 會員與您本人投資帶來的分潤": "ค่าคอมมิชชันจากสมาชิก L1 และการลงทุนของคุณ", "篩選期間團隊獎金": "โบนัสทีมในช่วงที่เลือก", "L2 會員帶來的分潤": "ค่าคอมมิชชันจากสมาชิก L2", "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "เลือกสมาชิก L1 หรือ L2 เพื่อดูรายละเอียด", "找不到符合條件的用戶": "ไม่พบผู้ใช้ที่ตรงตามเงื่อนไข" },
  vi: { "QR Code 推廣碼": "Mã giới thiệu QR Code", "L1 + L2 會員": "Thành viên L1 + L2", "篩選期間個人獎金": "Thưởng cá nhân trong kỳ đã chọn", "L1 會員與您本人投資帶來的分潤": "Hoa hồng từ thành viên L1 và khoản đầu tư của bạn", "篩選期間團隊獎金": "Thưởng đội nhóm trong kỳ đã chọn", "L2 會員帶來的分潤": "Hoa hồng từ thành viên L2", "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "Chọn thành viên L1 hoặc L2 để xem chi tiết.", "找不到符合條件的用戶": "Không tìm thấy người dùng phù hợp" },
  id: { "QR Code 推廣碼": "Kode Referral QR", "L1 + L2 會員": "Anggota L1 + L2", "篩選期間個人獎金": "Bonus pribadi periode yang dipilih", "L1 會員與您本人投資帶來的分潤": "Komisi dari anggota L1 dan investasi Anda", "篩選期間團隊獎金": "Bonus tim periode yang dipilih", "L2 會員帶來的分潤": "Komisi dari anggota L2", "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "Pilih anggota L1 atau L2 untuk melihat detail.", "找不到符合條件的用戶": "Tidak ada pengguna yang sesuai" },
  ms: { "QR Code 推廣碼": "Kod Rujukan QR", "L1 + L2 會員": "Ahli L1 + L2", "篩選期間個人獎金": "Bonus peribadi untuk tempoh dipilih", "L1 會員與您本人投資帶來的分潤": "Komisen daripada ahli L1 dan pelaburan anda", "篩選期間團隊獎金": "Bonus pasukan untuk tempoh dipilih", "L2 會員帶來的分潤": "Komisen daripada ahli L2", "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "Pilih ahli L1 atau L2 untuk melihat rekod terperinci.", "找不到符合條件的用戶": "Tiada pengguna yang sepadan" },
  es: { "QR Code 推廣碼": "Código de referido QR", "L1 + L2 會員": "Miembros L1 + L2", "篩選期間個人獎金": "Bono personal del período seleccionado", "L1 會員與您本人投資帶來的分潤": "Comisiones de miembros L1 y de tus inversiones", "篩選期間團隊獎金": "Bono de equipo del período seleccionado", "L2 會員帶來的分潤": "Comisiones de miembros L2", "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "Selecciona un miembro L1 o L2 para ver sus registros.", "找不到資料資料合條件資料資料資料用戶": "No se encontraron usuarios coincidentes" },
  fr: { "QR Code 推廣碼": "Code de parrainage QR", "L1 + L2 會員": "Membres L1 + L2", "篩選期間個人獎金": "Bonus personnel de la période sélectionnée", "L1 會員與您本人投資帶來的分潤": "Commissions des membres L1 et de vos investissements", "篩選期間團隊獎金": "Bonus d’équipe de la période sélectionnée", "L2 會員帶來的分潤": "Commissions des membres L2", "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "Sélectionnez un membre L1 ou L2 pour voir ses détails.", "找不到符合條件的用戶": "Aucun utilisateur correspondant trouvé" },
  de: { "QR Code 推廣碼": "QR-Empfehlungscode", "L1 + L2 會員": "L1 + L2-Mitglieder", "篩選期間個人獎金": "Persönlicher Bonus im ausgewählten Zeitraum", "L1 會員與您本人投資帶來的分潤": "Provisionen von L1-Mitgliedern und Ihren Anlagen", "篩選期間團隊獎金": "Teambonus im ausgewählten Zeitraum", "L2 會員帶來的分潤": "Provisionen von L2-Mitgliedern", "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "Wählen Sie ein L1- oder L2-Mitglied für die Details.", "找不到符合條件的用戶": "Keine passenden Benutzer gefunden" },
  pt: { "QR Code 推廣碼": "Código de indicação QR", "L1 + L2 會員": "Membros L1 + L2", "篩選期間個人獎金": "Bônus pessoal do período selecionado", "L1 會員與您本人投資帶來的分潤": "Comissões de membros L1 e dos seus investimentos", "篩選期間團隊獎金": "Bônus da equipe do período selecionado", "L2 會員帶來的分潤": "Comissões de membros L2", "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "Selecione um membro L1 ou L2 para ver os detalhes.", "找不到符合條件的用戶": "Nenhum usuário correspondente encontrado" },
  ru: { "QR Code 推廣碼": "Реферальный QR-код", "L1 + L2 會員": "Участники L1 + L2", "篩選期間個人獎金": "Личный бонус за выбранный период", "L1 會員與您本人投資帶來的分潤": "Комиссия от участников L1 и ваших инвестиций", "篩選期間團隊獎金": "Командный бонус за выбранный период", "L2 會員帶來的分潤": "Комиссия от участников L2", "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "Выберите участника L1 или L2 для просмотра деталей.", "找不到符合條件的用戶": "Подходящие пользователи не найдены" },
  ar: { "QR Code 推廣碼": "رمز الإحالة عبر QR", "L1 + L2 會員": "أعضاء L1 + L2", "篩選期間個人獎金": "المكافأة الشخصية للفترة المحددة", "L1 會員與您本人投資帶來的分潤": "عمولات أعضاء L1 واستثماراتك", "篩選資料資料間團隊獎金": "مكافأة الفريق للفترة المحددة", "L2 會員帶來的分潤": "عمولات أعضاء L2", "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "اختر عضواً من L1 أو L2 لعرض التفاصيل.", "找不到資料資料合條件的用戶": "لم يتم العثور على مستخدمين مطابقين" },
  hi: { "QR Code 推廣碼": "QR कोड रेफ़रल कोड", "L1 + L2 會員": "L1 + L2 सदस्य", "篩選期間個人獎金": "चयनित अवधि का व्यक्तिगत बोनस", "L1 會員與您本人投資帶來的分潤": "L1 सदस्यों और आपके निवेश से कमीशन", "篩選期間團隊獎金": "चयनित अवधि का टीम बोनस", "L2 會員帶來的分潤": "L2 सदस्यों से कमीशन", "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "विवरण देखने के लिए L1 या L2 सदस्य चुनें।", "找不到符合條件的用戶": "कोई मेल खाता उपयोगकर्ता नहीं मिला" },
  };
const agentFilterCopy: Record<Lang, Record<string, string>> = {
  "zh-TW": { "先選擇 L1 或 L2 資料資料資料員，再檢視該用戶的詳細紀錄。": "資料資料資料選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。", "找不到符合條資料資料資料的用戶": "找不到符合條件的用戶", "名稱、Email 或 User ID": "名稱、Email 或 User ID", "開始日期": "開始日期", "結束日期": "結束日期", "清除時間": "清除時間" },
  "zh-CN": { "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "先选择 L1 或 L2 会员，再查看该用户的详细记录。", "找不到符合條件的用戶": "找不到符合条件的用户", "名稱、Email 或 User ID": "姓名、Email 或用户 ID", "開始日期": "开始日期", "結束日期": "结束日期", "清除時間": "清除时间" },
  en: { "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "Select an L1 or L2 member to view detailed records.", "找不到符合條件的用戶": "No matching users found", "名稱、Email 或 User ID": "Name, email, or user ID", "開始日期": "Start date", "結束日期": "End date", "清除時間": "Clear date range" },
  ja: { "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "L1またはL2会員を選択して詳細記録を確認してください。", "找不到符合條件的用戶": "条件に一致するユーザーが見つかりません", "名稱、Email 或 User ID": "名前、メール、またはユーザーID", "開始日期": "開始日", "結束日期": "終了日", "清除時間": "期間をクリア" },
  ko: { "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "L1 또는 L2 회원을 선택해 상세 기록을 확인하세요.", "找不到符合條件的用戶": "조건에 맞는 사용자가 없습니다", "名稱、Email 或 User ID": "이름, 이메일 또는 사용자 ID", "開始日期": "시작일", "結束日期": "종료일", "清除時間": "기간 초기화" },
  th: { "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "เลือกสมาชิก L1 หรือ L2 เพื่อดูรายละเอียด", "找不到符合條件的用戶": "ไม่พบผู้ใช้ที่ตรงตามเงื่อนไข", "名稱、Email 或 User ID": "ชื่อ อีเมล หรือรหัสผู้ใช้", "開始日期": "วันที่เริ่มต้น", "結束日期": "วันที่สิ้นสุด", "清除時間": "ล้างช่วงเวลา" },
  vi: { "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "Chọn thành viên L1 hoặc L2 để xem chi tiết.", "找不到符合條件的用戶": "Không tìm thấy người dùng phù hợp", "名稱、Email 或 User ID": "Tên, email hoặc ID người dùng", "開始日期": "Ngày bắt đầu", "結束日期": "Ngày kết thúc", "清除時間": "Xóa khoảng thời gian" },
  id: { "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "Pilih anggota L1 atau L2 untuk melihat detail.", "找不到符合條件的用戶": "Tidak ada pengguna yang sesuai", "名稱、Email 或 User ID": "Nama, email, atau ID pengguna", "開始日期": "Tanggal mulai", "結束日期": "Tanggal selesai", "清除時間": "Hapus rentang tanggal" },
  ms: { "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "Pilih ahli L1 atau L2 untuk melihat rekod terperinci.", "找不到符合條件的用戶": "Tiada pengguna yang sepadan", "名稱、Email 或 User ID": "Nama, e-mel atau ID pengguna", "開始日期": "Tarikh mula", "結束日期": "Tarikh tamat", "清除時間": "Kosongkan julat tarikh" },
  es: { "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "Selecciona un miembro L1 o L2 para ver sus registros.", "找不到符合條件的用戶": "No se encontraron usuarios coincidentes", "名稱、Email 或 User ID": "Nombre, email o ID de usuario", "開始日期": "Fecha de inicio", "結束日期": "Fecha de finalización", "清除時間": "Borrar intervalo" },
  fr: { "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "Sélectionnez un membre L1 ou L2 pour voir ses détails.", "找不到符合條件的用戶": "Aucun utilisateur correspondant trouvé", "名稱、Email 或 User ID": "Nom, e-mail ou ID utilisateur", "開始日期": "Date de début", "結資料資料資料日期": "Date de fin", "清除時間": "Effacer la période" },
  de: { "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "Wählen Sie ein L1- oder L2-Mitglied für die Details.", "找不到符合條件的用戶": "Keine passenden Benutzer gefunden", "名稱、Email 或 User ID": "Name, E-Mail oder Benutzer-ID", "開始日期": "Startdatum", "結束日期": "Enddatum", "清除時間": "Zeitraum löschen" },
  pt: { "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "Selecione um membro L1 ou L2 para ver os detalhes.", "找不到符合條件的用戶": "Nenhum usuário correspondente encontrado", "名稱、Email 或 User ID": "Nome, e-mail ou ID do usuário", "開始日期": "Data inicial", "結束日期": "Data final", "清除時間": "Limpar período" },
  ru: { "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "Выберите участника L1 или L2 для просмотра деталей.", "找不到符合條件的用戶": "Подходящие пользователи не найдены", "名稱、Email 或 User ID": "Имя, email или ID пользователя", "開始日期": "Дата начала", "結束日期": "Дата окончания", "清除時間": "Очистить период" },
  ar: { "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "اختر عضواً من L1 أو L2 لعرض التفاصيل.", "找不到符合條件的用戶": "لم يتم العثور على مستخدمين مطابقين", "名稱、Email 或 User ID": "الاسم أو البريد الإلكتروني أو معرّف المستخدم", "開始日期": "تاريخ البدء", "結束日期": "تاريخ الانتهاء", "清除時間": "مسح الفترة" },
  hi: { "先選擇 L1 或 L2 會員，再檢視該用戶的詳細紀錄。": "विवरण देखने के लिए L1 या L2 सदस्य चुनें।", "找不到符合條件的用戶": "कोई मेल खाता उपयोगकर्ता नहीं मिला", "名稱、Email 或 User ID": "नाम, ईमेल या यूज़र ID", "開始日期": "आरंभ तिथि", "結束日期": "समाप्ति तिथि", "清除時間": "अवधि साफ़ करे資料資料" },
};

const approvedStatusCopy: Record<Lang, Record<string, string>> = { "zh-TW": { "已核准": "已核准", "審核中": "審核中", "已拒絕": "已拒絕" }, "zh-CN": { "已核准": "已批准", "審核中": "审核中", "已拒絕": "已拒绝" }, en: { "已核准": "Approved", "審核中": "Under review", "已拒絕": "Rejected" }, ja: { "已核准": "承認済み", "審核中": "審査中", "已拒絕": "却下" }, ko: { "已核准": "승인됨", "審核中": "심사 중", "已拒絕": "거절됨" }, th: { "已核准": "อนุมัติแล้ว", "審核中": "อยู่ระหว่างการตรวจสอบ", "已拒絕": "ถูกปฏิเสธ" }, vi: { "已核准": "Đã phê duyệt", "審核中": "Đang xét duyệt", "已拒絕": "Đã từ chối" }, id: { "已核准": "Disetujui", "審核中": "Sedang ditinjau", "已拒絕": "Ditolak" }, ms: { "已核准": "Diluluskan", "審核中": "Sedang disemak", "已拒絕": "Ditolak" }, es: { "已核准": "Aprobado", "審核中": "En revisión", "已拒絕": "Rechazado" }, fr: { "已核准": "Approuvé", "審核中": "En cours d’examen", "已拒絕": "Refusé" }, de: { "已核准": "Genehmigt", "審核中": "In Prüfung", "已拒絕": "Abgelehnt" }, pt: { "已核准": "Aprovado", "審核中": "Em análise", "已拒絕": "Rejeitado" }, ru: { "已核准": "Одобрено", "審核中": "На проверке", "已拒絕": "Отклонено" }, ar: { "已核准": "تمت الموافقة", "審核中": "قيد المراجعة", "已拒絕": "مرفوض" }, hi: { "已核准": "स्वीकृत", "審核中": "समीक्षाधीन", "已拒絕": "अस्वीकृत" } };

const principalLabelCopy: Record<Lang, Record<string, string>> = {
  "zh-TW": { "標的物本金": "標的物本金", "認購本金總額": "認購本金總額" }, "zh-CN": { "標的物本金": "标的物本金", "認購本金總額": "认购本金总额" }, en: { "標的物本金": "Asset principal", "認購本金總額": "Total subscription principal" }, ja: { "標的物本金": "対象資産の元本", "認購本金總額": "認購元本合計" }, ko: { "標的物本金": "자산 원금", "認購本金總額": "총 청약 원금" }, th: { "標的物本金": "เงินต้นของสินทรัพย์", "認購本金總額": "เงินต้นการจองซื้อรวม" }, vi: { "標的物本金": "Vốn gốc tài sản", "認購本金總額": "Tổng vốn gốc đăng ký mua" }, id: { "標的物本金": "Pokok aset", "認購本金總額": "Total pokok langganan" }, ms: { "標的物本金": "Pokok aset", "認購本金總額": "Jumlah pokok langganan" }, es: { "標的物本金": "Principal del activo", "認購本金總額": "Principal total de suscripción" }, fr: { "標的物本金": "Principal de l’actif", "認購本金總額": "Principal total de souscription" }, de: { "標的物本金": "Anlagekapital", "認購本金總額": "Gesamtes Zeichnungskapital" }, pt: { "標的物本金": "Principal do ativo", "認購本金總額": "Principal total da subscrição" }, ru: { "標的物本金": "Основная сумма актива", "認購本金總額": "Общая сумма подписки" }, ar: { "標的物本金": "أصل قيمة الأصل", "認購本金總額": "إجمالي أصل الاكتتاب" }, hi: { "標的物本金": "परिसंपत्ति मूलधन", "認購本金總額": "कुल सदस्यता मूलधन" },
};

const fixedUiTextCopy: Record<Lang, Record<string, string>> = {
  "zh-TW": { "兌換JC": "兌換JC", "私募結束時間": "私募結束時間", "創世紀L0": "創世紀L0", "已核准": "已核准", "審核中": "審核中", "已拒絕": "已拒絕" },
  "zh-CN": { "兌換JC": "JC 金库兑换", "私募結束時間": "私募结束时间", "創世紀L0": "创世纪L0" }, en: { "兌換JC": "JC Vault Exchange", "私募結束時間": "Private offering end time", "創世紀L0": "Genesis L0" }, ja: { "兌換JC": "JC金庫交換", "私募結束時間": "私募終了時間", "創世紀L0": "創世紀L0" }, ko: { "兌換JC": "JC 금고 교환", "私募結束時間": "사모 종료 시간", "創世紀L0": "창세기 L0" }, th: { "兌換JC": "แลกเปลี่ยน JC ในคลัง", "私募結束時間": "เวลาสิ้นสุดการเสนอขายส่วนตัว", "創世紀L0": "Genesis L0" }, vi: { "兌換JC": "Đổi JC trong kho", "私募結束時間": "Thời gian kết thúc chào bán riêng", "創世紀L0": "Genesis L0" }, id: { "兌換JC": "Penukaran JC di brankas", "私募結束時間": "Waktu berakhir penawaran privat", "創世紀L0": "Genesis L0" }, ms: { "兌換JC": "Pertukaran JC dalam peti besi", "私募結束時間": "Masa tamat tawaran persendirian", "創世紀L0": "Genesis L0" }, es: { "兌換JC": "Intercambio de JC en bóveda", "私募結束時間": "Hora de finalización de la oferta privada", "創世紀L0": "Genesis L0" }, fr: { "兌換JC": "Échange JC dans le coffre", "私募結束時間": "Fin de l’offre privée", "創世紀L0": "Genesis L0" }, de: { "兌換JC": "JC-Tresor-Tausch", "私募結束時間": "Ende des Privatangebots", "創世紀L0": "Genesis L0" }, pt: { "兌換JC": "Troca de JC no cofre", "私募結束時間": "Hora de término da oferta privada", "創世紀L0": "Genesis L0" }, ru: { "兌換JC": "Обмен JC в хранилище", "私募結束時間": "Время окончания частного размещения", "創世紀L0": "Genesis L0" }, ar: { "兌換JC": "تبادل JC في الخزينة", "私募結束時間": "وقت انتهاء الطرح الخاص", "創世紀L0": "Genesis L0" }, hi: { "兌換JC": "JC वॉल्ट एक्सचेंज", "私募結束時間": "निज資料資料資料 पेशकश समाप्ति समय", "創世紀L0": "Genesis L0" },
};

const frontendLabelCopy: Partial<Record<Lang, Record<string, string>>> = {
  "zh-TW": { "全部": "全部", "上漲": "上漲", "下跌": "下跌", "代理營運中心": "代理營運中心", "兌換JC": "兌換JC", "分潤紀錄": "分潤紀錄", "用戶交易與分潤紀錄": "用戶交易與分潤紀錄", "點擊查看分潤紀錄 →": "點擊查看分潤紀錄 →", "儲存推薦設定": "儲存推薦設定", "上線推廣碼": "上線推廣碼", "指定代碼": "指定代碼" },
  "zh-CN": { "代理資料資料資料運中心": "代理运营中心", "兌換JC": "JC 金库兑换", "分潤紀錄": "分润记录", "用戶交易與分潤紀錄": "用户交易与分润记录", "點擊查看分潤紀錄 →": "点击查看分润记录 →", "儲存推薦設定": "保存推荐设置", "上線推廣碼": "上线推广码", "指定代碼": "指定代码" },
  en: { "代理營運中心": "Agent operations center", "兌換JC": "JC vault exchange", "分潤紀錄": "Commission history", "用戶交易與分潤紀錄": "Member transactions and commissions", "點擊查看分潤紀錄 →": "View commission history →", "儲存推薦設定": "Save referral settings", "上線推廣碼": "Upline referral code", "指定代碼": "Special code" },
  ja: { "代理營運中心": "エージェント運営センター", "兌換JC": "JC金庫交換", "分潤紀錄": "報酬履歴", "用戶交易與分潤紀錄": "会員の取引と報酬履歴", "點擊查看分潤紀錄 →": "報酬履歴を見る →", "儲存推薦設定": "紹介設定を資料資料資料存", "上線推廣碼": "上位紹介コード", "指定代碼": "指定コード" },
  ko: { "代理營運中心": "에이전트 운영 센터", "兌換JC": "JC 금고 교환", "資料資料潤紀錄": "커미션 내역", "用戶交易與分潤紀錄": "회원 거래 및 커미션 내역", "點擊查看分潤紀錄 →": "커미션 내역 보기 →", "儲存推薦設定": "추천 설정 저장", "上線推廣碼": "상위 추천 코드", "指定代碼": "지정 코드" },
  th: { "代理營運中心": "ศูนย์ดำเนินงานตัวแทน", "兌換JC": "แลกเปลี่ยน JC ในคลัง", "分潤紀錄": "ประวัติคอมมิชชัน", "用戶交易與分潤紀錄": "ธุรกรรมและคอมมิชชันสมาชิก", "點擊查看分潤紀錄 →": "ดูประวัติคอมมิชชัน →", "儲存推薦設定": "บันทึกการตั้งค่าการแนะนำ", "上線推廣碼": "รหัสแนะนำผู้แนะนำ", "指定代碼": "รหัสเฉพาะ" },
  vi: { "代理營運中心": "Trung tâm vận hành đại lý", "兌換JC": "Đổi JC trong kho", "分潤紀錄": "Lịch sử hoa hồng", "用戶交易與分潤紀錄": "Giao dịch và hoa hồng thành viên", "點擊查看分潤紀錄 →": "Xem lịch sử hoa hồng →", "儲存推薦設定": "Lưu cài đặt giới thiệu", "上線推廣碼": "Mã giới thiệu cấp trên", "指定代碼": "Mã chỉ định" },
  id: { "代理營運中心": "Pusat operasional agen", "兌換JC": "Penukaran JC di brankas", "分潤紀錄": "Riwayat komisi", "用戶交易與分潤紀錄": "Transaksi dan komisi anggota", "點擊查看分潤紀錄 →": "Lihat riwayat komisi →", "儲存推薦設定": "Simpan pengaturan referral", "上線推廣碼": "Kode referral upline", "指定代碼": "Kode khusus" },
  ms: { "代理資料資料運中心": "Pusat operasi ejen", "兌換JC": "Pertukaran JC peti besi", "分潤紀錄": "Sejarah komisen", "用戶交易與分潤紀錄": "Transaksi dan komisen ahli", "點擊查看分潤紀錄 →": "Lihat sejarah komisen →", "儲存推薦設定": "Simpan tetapan rujukan", "上線推廣碼": "Kod rujukan upline", "指定代碼": "Kod khas" },
  es: { "代理營運中心": "Centro de operaciones de agentes", "兌換JC": "Cambio de JC en bóveda", "分潤紀錄": "Historial de comisiones", "用戶交易與分潤紀錄": "Transacciones y comisiones de miembros", "點擊查看分潤紀錄 →": "Ver historial de comisiones →", "儲存推薦設定": "Guardar configuración de referidos", "上線推廣碼": "Código de referido superior", "指定代碼": "Código especial" },
  fr: { "代理營運中心": "Centre des opérations des agents", "兌換JC": "Échange JC du coffre", "分潤紀錄": "Historique des commissions", "用戶交易與分潤紀資料資料資料": "Transactions et commissions des membres", "點擊查看分潤紀錄 →": "Voir l'historique des commissions →", "儲存推薦設定": "Enregistrer les paramètres de parrainage", "上線推廣碼": "Code de parrainage supérieur", "指定代碼": "Code spécial" },
  de: { "代理營運中心": "Agenten-Betriebszentrum", "兌換JC": "JC-Tresortausch", "分潤紀錄": "Provisionsverlauf", "用戶交易與分潤紀錄": "Mitgliedstransaktionen und Provisionen", "點擊查看分潤紀錄 →": "Provisionsverlauf anzeigen →", "儲存推薦設定": "Empfehlungseinstellungen speichern", "上線推廣碼": "Empfehlungscode des übergeordneten Agents", "指定代碼": "Sondercode" },
  pt: { "代理營運中心": "Centro de operações de agentes", "兌換JC": "Troca de JC no cofre", "分潤紀錄": "Histórico de comissões", "用戶交易與分潤紀錄": "Transações e comissões dos membros", "點擊查看分潤紀錄 →": "Ver histórico de comissões →", "儲存推薦設定": "Guardar definições de referência", "上線推廣碼": "Código de referência superior", "指定代碼": "Código especial" },
  ru: { "代理營運中資料資料資料": "Центр работы агентов", "兌換JC": "Обмен JC в хранилище", "分潤紀錄": "История комиссий", "用戶交易與分潤紀錄": "Операции и комиссии участников", "點擊查看分潤紀錄 →": "Открыть историю комиссий →", "儲存推薦設定": "Сохранить настройки рекомендаций", "上線推廣碼": "Реферальный код в資料資料шестоящего", "指定代碼": "Специальный код" },
  ar: { "代理資料資料資料運中心": "مركز عمليات الوكلاء", "兌換JC": "تبادل JC في الخزينة", "分潤紀錄": "سجل العمولات", "用戶交易與分潤紀錄": "معاملات وعمولات الأعضاء", "點擊查看分潤紀錄 →": "عرض سجل ال資料資料مولات ←", "儲存推薦設定": "حفظ إعدادات الإحالة", "上線推廣碼": "رمز إحالة المشرف", "指定代碼": "رمز خاص" },
  hi: { "代理營運中心": "एजेंसी संचालन केंद्र", "兌換JC": "JC वॉल्ट एक्सचेंज", "分潤紀錄": "कमीशन इतिहास", "用戶交易與分潤紀錄": "सदस्य लेन-देन और कमीशन", "點擊查看分潤紀錄 →": "कमीशन इतिहास देखें →", "儲存推薦設定": "रेफ़रल सेटिंग सहेजें", "上線推廣碼": "ऊपरी रेफ़रल कोड", "指定代碼": "विशेष कोड" },
};

export const localizedUiText = (language: Lang, korean: string, fallback: string) => {
  const legacyText = getLegacyText(language, fallback);
  const marketFilterCopy: Record<Lang, Record<string, string>> = {
    "zh-TW": { "全部": "全部", "上漲": "上漲", "下跌": "下跌" }, "zh-CN": { "全部": "全部", "上漲": "上涨", "下跌": "下跌" }, en: { "全部": "All", "上漲": "Up", "下跌": "Down" }, ja: { "全部": "すべて", "上漲": "上昇", "下跌": "下落" }, ko: { "全部": "전체", "上漲": "상승", "下跌": "하락" }, th: { "全部": "ทั้งหมด", "上漲": "ขึ้น", "下跌": "ลง" }, vi: { "全部": "Tất cả", "上漲": "Tăng", "下跌": "Giảm" }, id: { "全部": "Semua", "上漲": "Naik", "下跌": "Turun" }, ms: { "全部": "Semua", "上漲": "Naik", "下跌": "Turun" }, es: { "全部": "Todos", "上漲": "Subidas", "下跌": "Bajadas" }, fr: { "全部": "Tous", "上漲": "Hausse", "下跌": "Baisse" }, de: { "全部": "Alle", "上漲": "Steigend", "下跌": "Fallend" }, pt: { "全部": "Todos", "上漲": "Alta", "下跌": "Baixa" }, ru: { "全部": "Все", "上漲": "Рост", "下跌": "Падение" }, ar: { "全部": "الكل", "上漲": "صعود", "下跌": "هبوط" }, hi: { "全部": "सभी", "上漲": "बढ़त", "下跌": "गिरावट" },
  };
  const marketFilter = marketFilterCopy[language][fallback];
  const cleanPromoCodeCopy: Record<Lang, string> = {
    "zh-TW": "推廣碼需為 9 位英數字，且不得與他人重複。", "zh-CN": "推广码必须为 9 位英数字，且不得与他人重复。", en: "The referral code must be 9 letters or numbers and cannot duplicate another user's code.", ja: "紹介コードは英数字9文字で、他のユーザーと重複できません。", ko: "추천 코드는 資料資料資料문 또는 숫자 9자리이며 다른 사용자와 중복될 수 없습니다.", th: "รหัสแนะนำต้องเป็นตัวอักษร資料資料資料รือตัวเลข 9 ตัว และ資料資料้ามซ้ำกับผู้ใ資料資料資料้อื่น", vi: "Mã giới thiệu phải gồm 9 chữ cái hoặc chữ số và không được trùng với người khác.", id: "Kode referral harus terdiri dari 9 huruf atau angka dan tidak boleh sama dengan kode pengguna lain.", ms: "Kod rujukan mesti terdiri daripada 9 huruf atau angka dan tidak boleh sama dengan pengguna lain.", es: "El código de referido debe tener 9 letras o números y no puede repetirse.", fr: "Le code de parrainage doit comporter 9 lettres ou chiffres et ne peut pas être répété.", de: "Der Empfehlungscode muss aus 9 Buchstaben oder Zahlen bestehen und darf nicht doppelt vorkommen.", pt: "O código de referência deve ter 9 letras ou números e não pode ser repetido.", ru: "Реферальный код должен содержать 9 бук資料資料 или цифр и не может повторятьс資料資料.", ar: "يجب أن يتكون رم資料資料 الإحالة من 9 أحرف أو أرقام وألا يتكرر مع مستخدم آخر.", hi: "रेफ़रल कोड 9 अक्षरों या अंकों का होना चाहिए और किसी अन्य उपयोगकर्ता से दोहराया नहीं जा सकता।",
  };
  const promoCodeValidation = fallback.includes("推廣碼需為 9 位英數字") || fallback.includes("9 位英數字")
    ? cleanPromoCodeCopy[language]
    : undefined;
  const tradeDetailsCopy: Record<Lang, Record<string, string>> = {
    "zh-TW": { "交易明細": "交易明細", "標的物名稱": "標的物名稱", "份額": "份額", "份": "份", "手續費": "手續費", "合計金額": "合計金額", "取消": "取消", "確認購買": "確認購買", "確認認購": "確認認購", "處理中…": "處理中…" },
    "zh-CN": { "交易明細": "交易明细", "標的物名稱": "标的物名称", "份額": "份额", "份": "份", "手續費": "手续费", "合計金額": "合计金额", "取消": "取消", "確認購買": "确认购买", "確認認購": "确认认购", "處理中…": "处理中…" },
    en: { "交易明細": "Transaction Details", "標的物名稱": "Asset Name", "份額": "Units", "份": "units", "手續費": "Fee", "合計金額": "Total Amount", "取消": "Cancel", "確認購買": "Confirm Purchase", "確認認購": "Confirm Subscription", "處理中…": "Processing…" },
    ja: { "交易明細": "取引詳細", "標的物名稱": "資産名", "份額": "口数", "份": "口", "手續費": "手数料", "合計金額": "合計金額", "取消": "キャンセル", "確認購買": "購入を確認", "確認認購": "申込みを確認", "處理中…": "処理中…" },
    ko: { "交易明細": "거래 상세 정보", "標的物名稱": "자산명", "份額": "수량", "份": "단위", "手續費": "수수료", "合計金額": "총액", "取消": "취소", "確認購買": "구매 확인", "確認認購": "청약 확인", "處理中…": "처리 중…" },
    th: { "交易明細": "รายละเอียดธุรกรรม", "標的物名稱": "ชื่อสินทรัพย์", "份額": "จำนวนหน่วย", "份": "หน่วย", "手續費": "ค่าธรรมเนียม", "合計金額": "ยอดรวม", "取消": "ยกเลิก", "確認購買": "ยืนยันการซื้อ", "確認認購": "ยืนยันการจองซื้อ", "處理中…": "กำลังดำเนินการ…" },
    vi: { "交易明細": "Chi tiết giao dịch", "標的物名稱": "Tên tài sản", "份額": "Số lượng", "份": "đơn vị", "手續費": "Phí", "合計金額": "Tổng số tiền", "取消": "Hủy", "確認購買": "Xác nhận mua", "確認認購": "Xác nh資料資料n đăng ký mua", "處理中…": "Đang xử lý…" },
    id: { "交易明細": "Detail Transaksi", "標的物名稱": "Nama aset", "份額": "Unit", "份": "unit", "手續費": "Biaya", "合計金額": "Jumlah total", "取消": "Batal", "確認購買": "Konfirmasi pembelian", "確認認購": "Konfirmasi langganan", "處理中…": "Memproses…" },
    ms: { "交易明細": "Butiran Transaksi", "標的物名稱": "Nama aset", "份額": "Unit", "份": "unit", "手續費": "Yuran", "合計金額": "Jumlah keseluruhan", "取消": "Batal", "確認購買": "Sahkan pembelian", "確認認購": "Sahkan langganan", "處理中…": "Sedang diproses…" },
    es: { "交易明細": "Detalles de la transacción", "標的物名稱": "Nombre del activo", "份額": "Unidades", "份": "unidades", "手續費": "Comisión", "合計金額": "Importe total", "取消": "Cancelar", "確認購資料資料": "Confirmar compra", "確認認購": "Confirmar suscripción", "處理中…": "Procesando…" },
    fr: { "交易明細": "Détails de la transaction", "標的物名稱": "Nom de l’actif", "份額": "Unités", "份": "unités", "手續費": "Frais", "合計金額": "Montant total", "取消": "Annuler", "確認購買": "Confirmer l’achat", "確認認購": "Confirmer la souscription", "處理中…": "Traitement…" },
    de: { "交易明細": "Transaktionsdetails", "標的物名稱": "Anlagenname", "份額": "Einheiten", "份": "Einheiten", "手續費": "Gebühr", "合計金額": "Gesamtbetrag", "取消": "Abbrechen", "確認購買": "Kauf bestätigen", "確認認購": "Zeichnung bestätigen", "處理中…": "Wird verarbeitet…" },
    pt: { "交易明細": "Detalhes da transação", "標的物名稱": "Nome do ativo", "份額": "Unidades", "份": "unidades", "手續費": "Taxa", "合計金額": "Valor total", "取消": "Cancelar", "確認購買": "Confirmar compra", "確認認購": "Confirmar subscrição", "處理中…": "A processar…" },
    ru: { "交易明細": "Детали операции", "標的物名稱": "Название актива", "份額": "Количество", "份": "ед.", "手續費": "Комиссия", "合計金額": "Итого", "取消": "Отмена", "確認購買": "Подтвердить покупку", "確認認購": "Подтвердить подписку", "處理中…": "Обработка…" },
    ar: { "交易明細": "تفاصيل المعاملة", "標的物名稱": "اسم الأصل", "份額": "الوحدات", "份": "وحدة", "手續費": "الرسوم", "合計金額": "المبلغ الإجمالي", "取消": "إلغاء", "確認購買": "تأكيد الشراء", "確認認購": "تأكيد الاكتتاب", "處理中…": "جارٍ المعالجة…" },
    hi: { "交易明細": "लेन-देन विवरण", "標的物名稱": "परिसंपत्ति का नाम", "份額": "इकाइयाँ", "份": "इकाई", "手續費": "शुल्क", "合計金額": "कुल राशि", "取消": "रद्द करें", "確認購買": "खरीद की पुष्टि करें", "確認認購": "सब्सक्रिप्शन की पुष्टि करें", "處理中…": "प्रक्रिया जारी…" },
  };
  const subscriptionCopy: Record<Lang, Record<string, string>> = {
    "zh-TW": { "認購資訊": "認購資訊", "私募認購免手續費": "私募認購免手續費", "需支付的本金": "需支付的本金" },
    "zh-CN": { "認購資訊": "认购信息", "私募認購免手續費": "私募认购免手续费", "需支付的本金": "需支付的本金" },
    en: { "認購資訊": "Subscription Information", "私募認購免手續費": "No private subscription fee", "需支付的本金": "Principal payable" },
    ja: { "認購資訊": "申込み情報", "私募認購免手續費": "私募購入手数料なし", "需支付的本金": "支払元本" },
    ko: { "認購資訊": "청약 정보", "私募認購免手續費": "프라이빗 청약 수수료 없음", "需支付的本金": "납부할 원금" },
    th: { "認購資訊": "ข้อมูลการจองซื้อ", "私募認購免手續費": "ไม่มีค่าธรรมเนียมการจองซื้อส่วนตัว", "需支付的本金": "เงินต้นที่ต้องชำระ" },
    vi: { "認購資訊": "Thông tin đăng ký mua", "私募認購免手續費": "Không có phí đăng ký mua riêng", "需支付的本金": "Vốn gốc cần thanh toán" },
    id: { "認購資訊": "Informasi langganan", "私募認資料資料免手續費": "Tanpa biaya langganan privat", "需支付的本金": "Pokok yang harus dibayar" },
    ms: { "認購資訊": "Maklumat langganan", "私募認購免手續費": "Tiada yuran langganan persendirian", "需支付的本金": "Pokok yang perlu dibayar" },
    es: { "認購資訊": "Información de suscripción", "私募認購免手續費": "Sin comisión de suscripción privada", "需支付的本金": "Principal a pagar" },
    fr: { "認購資訊": "Informations de souscription", "私募認購免手續費": "Aucun frais de souscription privée", "需支付的本金": "Principal à payer" },
    de: { "認購資訊": "Zeichnungsinformationen", "私募認購免手續費": "Keine Gebühr für private Zeichnung", "需支付的本金": "Zu zahlender Kapitalbetrag" },
    pt: { "認購資訊": "Informações da subscrição", "私募認購免手續費": "Sem taxa de subscrição privada", "需支付的本金": "Capital a pagar" },
    ru: { "認購資訊": "Информация о подписке", "私募認購免手續費": "Без комиссии за частную подписку", "需支付的本金": "Основная сумма к оплате" },
    ar: { "認購資訊": "معلومات الاكتتاب", "私募認購免手續費": "لا توجد رسوم اكتتاب خاص", "需支付的本金": "أصل المبلغ المستحق" },
    hi: { "認購資訊": "सब्सक्रिप्शन जानकारी", "私募認購免手續費": "प्राइवेट सब्सक्रिप्शन शुल्क नहीं", "需支付的本金": "देय मूलधन" },
  };
  const paymentNoteCopy: Record<Lang, string> = {
    "zh-TW": "需支付的本金 {amount}。系統會先保留 JC 與庫存，待鏈上收款及份額交割確認後，才正式扣帳並入帳分潤。（私募認購免手續費）",
    "zh-CN": "需支付的本金 {amount}。系统会先保留 JC 与库存，待链上收款及份额交割确认后，才正式扣账并入账分润。（私募认购免手续费）",
    en: "Principal payable: {amount}. JC and inventory are reserved first; the account is debited and commissions are recorded only after on-chain payment and share settlement are confirmed. (No private subscription fee)",
    ja: "支払元本は{amount}です。オンチェーン決済と持分決済が確認されるまで、JCと在庫を先に確保します。確認後に正式に引き落とし、コミッションを計上します。（私募購入手数料なし）",
    ko: "납부할 원금은 {amount}입니다. 온체인 결제와 지분 이전이 확인된 후에만 정식으로 차감하고 資料資料資料미션을 반영합니다. (프라이빗 청약 수수료 없음)",
    th: "เงินต้นที่ต้องชำระคือ {amount} ระบบจะสำร資料資料ง JC และสินค้าคงคลัง資料資料資料่อน และจะหักบัญชี資料資料資料ร้อมบันทึกค่าคอมมิชชันเมื่อยืนยันการชำระเงินบนเชนและการโอนหน่วยแล้วเท่านั้น (ไม่มีค่าธรรมเนียมการจองซื้อส่วนตัว)",
    vi: "Vốn gốc cần thanh toán là {amount}. Hệ thống sẽ giữ JC và tồn kho trước, chỉ trừ tiền và ghi nhận hoa hồng sau khi xác nhận thanh toán on-chain và chuyển giao phần sở hữu. (Không có phí đăng ký mua riêng)",
    id: "Pokok yang harus dibayar adalah {amount}. JC dan inventaris akan dicadangkan terlebih dahulu; saldo hanya dipotong dan komisi dicatat setelah pembayaran on-chain dan penyelesaian unit dikonfirmasi. (Tanpa biaya langganan privat)",
    ms: "Pokok yang perlu dibayar ialah {amount}. JC dan inventori akan ditempah dahulu; potongan dan rekod komisen dibuat selepas bayaran on-chain serta penyerahan unit disahkan. (Tiada yuran langganan persendirian)",
    es: "El principal a pagar es {amount}. Primero se reservan los JC y el inventario; el débito y el registro de comisiones se realizan tras confirmar el pago on-chain y la liquidación de unidades. (Sin comisión de suscripción privada)",
    fr: "Le principal à payer est de {amount}. Les JC et le stock sont d’abord réservés ; le débit et l’enregistrement de la commission n’ont lieu qu’après confirmation du paiement on-chain et du règlement des unités. (Aucun frais de souscription privée)",
    de: "Der zu zahlende Kapitalbetrag beträgt {amount}. JC und Bestand werden zunächst reserviert; Belastung und Provisionsbuchung erfolgen erst nach bestätigter On-Chain-Zahlung und Abwicklung der Einheiten. (Keine Gebühr für private Zeichnung)",
    pt: "O capital a pagar é {amount}. Os JC e o inventário são reservados primeiro; o débito e o registo da comissão só ocorrem após a confirmação do pagamento on-chain e da liquidação das unidades. (Sem taxa de subscrição privada)",
    ru: "Основная сумма к оплате: {amount}. Сначала резервируются JC и запасы; списание и начисление комиссии выполняются только после подтверждения ончейн-платежа и расчёта по единицам. (Без комиссии за частную подписку)",
    ar: "أصل المبلغ المستحق هو {amount}. سيتم حجز JC والمخزون أولاً، ولن يتم الخصم وتسجيل العمولة إلا بعد تأكيد الدفع على السلسلة وتسوية الوحدات. (لا توجد رسوم اكتتاب خاص)",
    hi: "देय मूलधन {amount} है। पहले JC और इन्वेंटरी आरक्षित की जाएगी; ऑन-चेन भुगतान और यूनिट निपटान की पुष्टि के बाद ही राशि काटी और कमीशन दर्ज किया जाएगा। (प्राइवेट सब्सक्रिप्शन शुल्क नहीं)",
  };
  const tradeDetailsTranslation = tradeDetailsCopy[language]?.[fallback];
  const subscriptionTranslation = subscriptionCopy[language]?.[fallback];
  const paymentAmount = fallback.match(/^需支付的本金\\s+(.+?)。/)?.[1];
  const paymentNoteTranslation = paymentAmount
    ? paymentNoteCopy[language]?.replace("{amount}", paymentAmount)
    : undefined;
  const candidates = [
    interfaceCoverageCopy[language]?.[korean],
    translatedCoverage[language]?.[korean],
    commonUiCopy[language]?.[korean],
    walletStatusUiCopy[language]?.[korean],
    walletExtraUiCopy[language]?.[korean],
    walletUiCopy[language]?.[korean],
    localizedUiCopy[language]?.[korean],
    promoCodeValidation,
    tradeDetailsTranslation,
    subscriptionTranslation,
    paymentNoteTranslation,
    marketFilter,
    agentDashboardCopy[language]?.[fallback],
    agentReferralCopy[language]?.[fallback],
  agentFilterCopy[language]?.[fallback],
  principalLabelCopy[language]?.[fallback],
  approvedStatusCopy[language]?.[fallback],
    fixedUiTextCopy[language]?.[fallback],
    frontendLabelCopy[language]?.[fallback],
    legacyText !== fallback ? legacyText : undefined,
    fallbackCoverageCopy[language]?.[fallback],
    language === "ko" ? korean : fallback,
  ];
  return candidates.find((text): text is string => typeof text === "string" && !text.includes("資料")) ?? fallback;
};
const words: Record<Lang, string[]> = {
  "zh-TW": [
    "首頁",
    "二級市場",
    "錢包",
    "設定",
    "精選項目",
    "探索經鏈上驗證的房地產代幣化資產",
    "公告",
    "了解詳情",
    "買入",
    "賣出",
    "可用餘額",
    "交易紀錄",
    "手續費",
    "實收金額",
    "語言",
    "帳戶與安全設定",
    "已通過 KYC",
    "充值",
    "出金",
    "持倉資產",
    "近期交易",
    "模擬鏈上",
    "確認交易",
    "取消",
    "份額",
    "每份價格",
    "成交資料資料資料額",
    "掛單簿",
    "資產詳情",
  ],
  "zh-CN": [
    "首页",
    "二级市场",
    "钱包",
    "设置",
    "精选项目",
    "探索经链上验证的房地产代币化资产",
    "公告",
    "了解详情",
    "买入",
    "卖出",
    "可用余额",
    "交易记录",
    "手续费",
    "实收金额",
    "语言",
    "账户与安全设置",
    "已通过 KYC",
    "充值",
    "提现",
    "持仓资产",
    "近期交易",
    "模拟上链",
    "确认交易",
    "取消",
    "份额",
    "每份价格",
    "成交总额",
    "挂单簿",
    "资产详情",
  ],
  en: [
    "Home",
    "Secondary market",
    "Wallet",
    "Settings",
    "Featured assets",
    "Explore blockchain-verified tokenized real estate",
    "Announcements",
    "View details",
    "Buy",
    "Sell",
    "Available balance",
    "Trade history",
    "Fee",
    "Net amount",
    "Language",
    "Account and security settings",
    "KYC verified",
    "Deposit",
    "Withdraw",
    "Holdings",
    "Recent transactions",
    "Simulated on-chain",
    "Confirm trade",
    "Cancel",
    "Units",
    "Price per unit",
    "Gross amount",
    "Order book",
    "Asset details",
  ],
  ja: [
    "ホーム",
    "二次市場",
    "ウォレット",
    "設定",
    "注目資産",
    "ブロックチェーン検証済み不動産資料資料資料探索",
    "お知らせ",
    "詳細を見る",
    "購入",
    "売却",
    "利用可能残高",
    "取引履歴",
    "手数料",
    "受取額",
    "言語",
    "アカウントとセキュリティ",
    "KYC認証済み",
    "入金",
    "出金",
    "保有資産",
    "最近の取引",
    "オンチェーン模擬",
    "取引確認",
    "キャンセル",
    "口数",
    "単価",
    "取引総額",
    "注文板",
    "資産詳細",
  ],
  ko: [
    "홈",
    "2차 시장",
    "지갑",
    "설정",
    "추천 자산",
    "블록체인 검증 부동산 토큰 탐색",
    "공지",
    "상세 보기",
    "구매",
    "판매",
    "사용 가능 잔액",
    "거래 내역",
    "수수료",
    "실수령액",
    "언어",
    "계정 및 보안 설정",
    "KYC 인증 완료",
    "입금",
    "출금",
    "보유 자산",
    "최근 거래",
    "온체인 시뮬레이션",
    "거래 확인",
    "취소",
    "수량",
    "단가",
    "거래 총액",
    "주資料資料장",
    "자산 상세",
  ],
  th: [
    "หน้าหลัก",
    "ตลาดรอง",
    "กระเป๋า",
    "ตั้งค่า",
    "สินทรัพย์แนะนำ",
    "สำรวจอสังหาฯ โทเคนที่ตรวจสอบแล้ว",
    "ประกาศ",
    "ดูรายละเอียด",
    "ซื้อ",
    "ขาย",
    "ยอดคงเหลือ",
    "ประวัติการซื้อขาย",
    "ค่าธรรมเนียม",
    "ยอดสุทธิ",
    "ภาษา",
    "บัญชีและความปลอดภัย",
    "ยืนยัน KYC แล้ว",
    "ฝาก",
    "ถอน",
    "สินทรัพย์ถือครอง",
    "ธุรกรรมล่าสุด",
    "จำลองบนเชน",
    "ยืนยันรายการ",
    "ย資料資料資料เลิก",
    "หน่วย",
    "ราคาต่อหน่วย",
    "資料資料資料資料資料อดรวม",
    "สมุดคำสั่ง",
    "รายละเอียดสินทรัพย์",
  ],
  vi: [
    "Trang chủ",
    "Thị trường thứ cấp",
    "Ví",
    "Cài đặt",
    "Tài sản nổi bật",
    "Khám phá bất động sản token hóa đã xác minh",
    "Thông báo",
    "Xem chi tiết",
    "Mua",
    "Bán",
    "Số dư khả dụng",
    "Lịch sử giao dịch",
    "Phí",
    "Số tiền thực nhận",
    "Ngôn ngữ",
    "Tài khoản và bảo mật",
    "資料資料ã xác minh KYC",
    "Nạp",
    "Rút",
    "Tài sản nắm giữ",
    "Giao dịch gần đây",
    "Mô phỏng on-chain",
    "Xác nhận",
    "Hủy",
    "Phần",
    "Giá mỗi phần",
    "Tổng giao dịch",
    "Sổ lệnh",
    "Chi tiết tài sản",
  ],
  id: [
    "Beranda",
    "Pasar sekunder",
    "Dompet",
    "Pengaturan",
    "Aset unggulan",
    "Jelajahi real estat token terverifikasi",
    "Pengumuman",
    "Lihat detail",
    "Beli",
    "Jual",
    "Saldo tersedia",
    "Riwayat perdagangan",
    "Biaya",
    "Jumlah bersih",
    "Bahasa",
    "Akun dan keamanan",
    "KYC terverifikasi",
    "Setor",
    "Tarik",
    "Kepemilikan",
    "Transaksi terbaru",
    "Simulasi on-chain",
    "Konfirmasi",
    "Batal",
    "Unit",
    "Harga per unit",
    "Jumlah kotor",
    "Buku pesanan",
    "Detail aset",
  ],
  ms: [
    "Utama",
    "Pasaran sekunder",
    "Dompet",
    "Tetapan",
    "Aset pilihan",
    "Terokai hartanah token yang disahkan",
    "Pengumuman",
    "Lihat butiran",
    "Beli",
    "Jual",
    "Baki tersedia",
    "Sejarah dagangan",
    "Yuran",
    "Jumlah bersih",
    "Bahasa",
    "Akaun dan keselamatan",
    "KYC disahkan",
    "Deposit",
    "Pengeluaran",
    "Pegangan",
    "Transaksi terkini",
    "Simulasi atas rantaian",
    "Sahkan dagangan",
    "Batal",
    "Unit",
    "Harga seunit",
    "Jumlah kasar",
    "Buku pesanan",
    "Butiran aset",
  ],
  es: [
    "Inicio",
    "Mercado secundario",
    "Cartera",
    "Ajustes",
    "Activos destacados",
    "Explora inmuebles tokenizados verificados",
    "Anuncios",
    "Ver detalles",
    "Comprar",
    "Vender",
    "Saldo disponible",
    "Historial",
    "Comisión",
    "Importe neto",
    "Idioma",
    "Cuenta y seguridad",
    "KYC verificado",
    "Depositar",
    "Retirar",
    "Posiciones",
    "Transacciones recientes",
    "Simulación en cadena",
    "Confirmar",
    "Cancelar",
    "Unidades",
    "Precio unitario",
    "Importe bruto",
    "Libro de órdenes",
    "Detalles del activo",
  ],
  fr: [
    "Accueil",
    "Marché secondaire",
    "Portefeuille",
    "Paramètres",
    "Actifs vedettes",
    "Explorez les biens tokenisés vérifiés",
    "Annonces",
    "Voir détails",
    "Acheter",
    "Vendre",
    "Solde disponible",
    "Historique",
    "Frais",
    "Montant net",
    "Langue",
    "Compte et sécurité",
    "KYC vérifié",
    "Déposer",
    "Retirer",
    "Positions",
    "Transactions récentes",
    "Simulation on-chain",
    "Confirmer",
    "Annuler",
    "Unités",
    "Prix unitaire",
    "Montant brut",
    "Carnet d’ordres",
    "Détails de l’actif",
  ],
  de: [
    "Start",
    "Sekundärmarkt",
    "Wallet",
    "Einstellungen",
    "Ausgewählte Assets",
    "Verifizierte tokenisierte Immobilien entdecken",
    "Ankündigungen",
    "Details",
    "Kaufen",
    "Verkaufen",
    "Verfügbares Guthaben",
    "Handelsverlauf",
    "Gebühr",
    "Nettobetrag",
    "Sprache",
    "Konto und Sicherheit",
    "KYC verifiziert",
    "Einzahlen",
    "Auszahlen",
    "Bestände",
    "Letzte Transaktionen",
    "On-Chain-Simulation",
    "Bestätigen",
    "Abbrechen",
    "Anteile",
    "Preis je Anteil",
    "Bruttobetrag",
    "Orderbuch",
    "Asset-Details",
  ],
  pt: [
    "Início",
    "Mercado secundário",
    "Carteira",
    "Definições",
    "Ativos em destaque",
    "Explore imóveis tokenizados verificados",
    "Anúncios",
    "Ver detalhes",
    "Comprar",
    "Vender",
    "Saldo disponível",
    "Histórico",
    "Taxa",
    "Valor líquido",
    "Idioma",
    "Conta e segurança",
    "KYC verificado",
    "Depositar",
    "Retirar",
    "Posições",
    "Transações recentes",
    "Simulação on-chain",
    "Confirmar",
    "Cancelar",
    "Unidades",
    "Preço unitário",
    "Valor bruto",
    "Livro de ordens",
    "Detalhes do ativo",
  ],
  ru: [
    "Главная",
    "Вторичный рынок",
    "Кошелёк",
    "Настройки",
    "Избранные активы",
    "Токенизированная недвижимость с проверкой",
    "Объявл資料資料ния",
    "Подробнее",
    "Купить",
    "Продать",
    "Доступный баланс",
    "История сделок",
    "Комиссия",
    "Чистая сумма",
    "Язык",
    "Аккаунт и безопасность",
    "KYC подтвержден",
    "Пополнить",
    "Вывести",
    "Активы",
    "Последние операции",
    "Симуляция в сети",
    "Подтвердить",
    "Отмена",
    "Д資料資料ли",
    "Цена доли",
    "Общая сумма",
    "Книга заявок",
    "Детали актива",
  ],
  ar: [
    "الرئيسية",
    "السوق الثانوية",
    "المحفظة",
    "الإعدادات",
    "الأصول المميزة",
    "استكشف العقارات المرمزة الموثقة",
    "الإعلانات",
    "عرض التفاصيل",
    "شراء",
    "بيع",
    "الرصيد المتاح",
    "سجل التداول",
    "الرسوم",
    "المبلغ الصافي",
    "اللغة",
    "الحساب والأمان",
    "تم التحقق من KYC",
    "إيداع",
    "سحب",
    "المقتنيات",
    "المعاملات الأخيرة",
    "محاكا資料資料資料資料 على السل資料資料لة",
    "تأكيد",
    "إلغاء",
    "الوحدات",
    "سعر الوحدة",
    "المبلغ الإجمالي",
    "دفتر الطلبات",
    "تفاصيل الأصل",
  ],
  hi: [
    "होम",
    "द्वितीयक बाज़ार",
    "वॉलेट",
    "सेटिंग्स",
    "विशेष एसेट",
    "सत्यापित टोकन रियल एस्टेट खोजें",
    "घोषणाएँ",
    "विवरण देखें",
    "खरीदें",
    "बेचें",
    "उपलब्ध बैलेंस",
    "ट्रेड इतिहास",
    "शुल्क",
    "शुद्ध राशि",
    "भाषा",
    "खाता और सुरक्षा",
    "KYC सत्यापित",
    "जमा",
    "निकासी",
    "होल्डिंग्स",
    "हाल के लेनदेन",
    "ऑन-चेन सिमुलेशन",
    "पुष्टि करें",
    "रद्द करें",
    "यूनिट",
    "प्रति यूनिट मूल्य",
    "कुल राशि",
    "ऑर्資料資料資料र बुक",
    "資料資料資料सेट विवरण",
  ],
};
const keys = [
  "home",
  "market",
  "wallet",
  "settings",
  "featured",
  "subtitle",
  "announcements",
  "details",
  "buy",
  "sell",
  "balance",
  "history",
  "fee",
  "net",
  "language",
  "accountSecurity",
  "kycPassed",
  "deposit",
  "withdraw",
  "holdings",
  "recent",
  "simulated",
  "confirm",
  "cancel",
  "units",
  "unitPrice",
  "gross",
  "orderbook",
  "assetDetails",
] as const;
type Key = (typeof keys)[number];
const extraZh: Record<string, string> = {
  announcement:
    "平台資產依標的設定以 JC 計價；鏈上交易需等待確認完成後才會更新為成功。",
  more: "更多項目",
  valuation: "總資產估值",
  expectedApy: "預計 APY",
  verification: "資產驗證",
  fullAddress: "完整地址",
  propertyHistory: "物件歷史",
  nearbyPricing: "周邊定價",
  advantages: "投資優勢",
  buyFee: "認購手續費：0 JC",
  liveMatching: "二級市場委託 · 鏈上交易確認後更新狀態",
  all: "全部",
  rising: "上漲",
  falling: "下跌",
  available: "可購",
  backMarket: "返回市場",
  candlestick: "K 線圖",
  asks: "賣單",
  bids: "買資料資料資料",
  owned: "持有份額",
  totalAssets: "總資產價值",
  networkFee: "網路手續費",
  status: "狀態",
  confirmed: "已確認",
  preferences: "偏好設定",
  notifications: "通知",
  changeLanguage: "變更整個介面語言",
  identity: "身份驗證",
  verifiedDate: "驗證日期",
  level: "等級",
  price: "價格通知",
  dividend: "收益分配資料資料資料知",
  listings: "新項目通知",
  receiveAlerts: "接收帳戶與資產資料資料知",
  investor: "投資者",
  subscribeEyebrow: "初級市場",
  subscribeTitle: "認購",
  subscribing: "認購中",
  soldOut: "已售罄",
  ended: "已結束",
  subscriptionUnitPrice: "認購單價",
  subscribeNow: "立即認購",
  unavailableSubscribe: "目前不可認購",
  noSubscriptions: "目前沒有可顯示的非二級市資料資料標的。",
  availableBalance: "可用餘額",
  subscriptionUnits: "認購份額",
  subscriptionTotal: "認購總額",
  confirmSubscription: "確認認購",
  agentCenter: "代理中心",
  dateRange: "時間範圍",
};
const extraEn: Record<string, string> = {
  announcement:
    "Platform assets are priced in JC according to each listing. On-chain transactions are marked complete only after confirmation.",
  more: "More assets",
  valuation: "Total asset valuation",
  expectedApy: "Expected APY",
  verification: "Asset verification",
  fullAddress: "Full address",
  propertyHistory: "Property history",
  nearbyPricing: "Nearby pricing",
  advantages: "Investment advantages",
  buyFee: "Subscription fee: 0 JC",
  liveMatching: "Secondary-market orders · Status updates after on-chain confirmation",
  all: "All",
  rising: "Rising",
  falling: "Falling",
  available: "Available",
  backMarket: "Back to market",
  candlestick: "Candlestick chart",
  asks: "Sell orders",
  bids: "Buy orders",
  owned: "Units owned",
  totalAssets: "Total asset value",
  networkFee: "Network fee",
  status: "Status",
  confirmed: "Confirmed",
  preferences: "Preferences",
  notifications: "Notifications",
  changeLanguage: "Change the entire interface language",
  identity: "Identity verification",
  verifiedDate: "Verification date",
  level: "Level",
  price: "Price alerts",
  dividend: "Dividend alerts",
  listings: "New listing alerts",
  receiveAlerts: "Receive account and asset notifications",
  investor: "Investor",
  subscribeEyebrow: "Primary offering",
  subscribeTitle: "Subscribe",
  subscribing: "Open",
  soldOut: "Sold out",
  ended: "Ended",
  subscriptionUnitPrice: "Subscription unit price",
  subscribeNow: "Subscribe now",
  unavailableSubscribe: "Currently unavailable",
  noSubscriptions:
    "There are currently no pre-secondary-market assets to display.",
  availableBalance: "Available balance",
  subscriptionUnits: "Subscription units",
  subscriptionTotal: "Subscription total",
  confirmSubscription: "Confirm subscription",
  agentCenter: "Agent center",
  dateRange: "Date range",
};
const simplified = (value: string) =>
  [
    ["臺", "台"],
    ["買入", "买入"],
    ["賣出", "卖出"],
    ["額", "额"],
    ["項目", "项目"],
    ["資產", "资产"],
    ["驗證", "验证"],
    ["歷史", "历史"],
    ["價", "价"],
    ["優勢", "优势"],
    ["網路", "网络"],
    ["確認", "确认"],
    ["設定", "设置"],
    ["鏈", "链"],
    ["實", "实"],
    ["總", "总"],
    ["與", "与"],
    ["為", "为"],
    ["會", "会"],
    ["發", "发"],
    ["區", "区"],
    ["國", "国"],
    ["長", "长"],
    ["間", "间"],
    ["樓", "楼"],
    ["觀", "观"],
    ["辦", "办"],
    ["處", "处"],
  ].reduce((text, [from, to]) => text.split(from).join(to), value);
const simpleExtra: Partial<Record<Lang, Record<string, string>>> = {
  "zh-CN": Object.fromEntries(
    Object.entries(extraZh).map(([k, v]) => [k, simplified(v)]),
  ),
  ja: {
    more: "その他の資産",
    announcement:
      "プラットフォームの資産は各募集に応じてJCで評価されます。オンチェーン取引は確認後に完了として表示されます。",
    valuation: "資産評価額",
    expectedApy: "予想APY",
    verification: "資産検証",
    fullAddress: "完全な住所",
    propertyHistory: "物件履歴",
    nearbyPricing: "周辺価格",
    advantages: "投資メリット",
    all: "すべて",
    rising: "上昇",
    falling: "下落",
    available: "購入可能",
    backMarket: "市場に戻資料資料資料",
    candlestick: "ローソク足チャート",
    asks: "売り注文",
    bids: "買い注文",
    owned: "保有口数",
    totalAssets: "総資産価値",
    status: "ステータス",
    confirmed: "確認済み",
    preferences: "環境設定",
    notifications: "通知",
    changeLanguage: "インターフェース全体の言語を変更",
    identity: "本人確認",
    receiveAlerts: "アカウントと資産の通知を受信",
    subscribeEyebrow: "プライマリーマーケット",
  subscribeTitle: "申込み",
  subscribing: "申込受付中",
    soldOut: "完売",
    ended: "終了",
    subscriptionUnitPrice: "申込単価",
    subscribeNow: "今すぐ申し込む",
    unavailableSubscribe: "現在申込不可",
    noSubscriptions: "現在表示できる申込対資料資料資産はありません。",
    availableBalance: "利用可能残高",
    subscriptionUnits: "申込口数",
    subscriptionTotal: "申込合計",
    confirmSubscription: "申込みを確定",
  },
  ko: {
    more: "더 많은 자산",
    announcement:
      "플랫폼 자산은 각 상품에 따라 JC로 표시됩니다. 온체인 거래는 확인이 완료된 뒤에만 완료로 표시됩니다.",
    valuation: "총 자산 가치",
    expectedApy: "예상 APY",
    verification: "자산 검증",
    fullAddress: "전체 주소",
    propertyHistory: "부동산 이력",
    nearbyPricing: "주변 가격",
    advantages: "투자 장점",
    all: "전체",
    rising: "상승",
    falling: "하락",
    available: "구매 가능",
    backMarket: "시장으로 돌아가기",
    candlestick: "캔들 차트",
    asks: "매도 주문",
    bids: "매수 주문",
    owned: "보유 수량",
    totalAssets: "총 자산 가치",
    status: "상태",
    confirmed: "확인됨",
    preferences: "환경資料資料資料정",
    notifications: "알림",
    changeLanguage: "전체 인터資料資料이스 언어 변경",
    identity: "신원 인증",
    receiveAlerts: "계정 및 자산 알림 수신",
    subscribeEyebrow: "프라이머리 마켓",
  subscribeTitle: "청약",
  subscribing: "청약 중",
    soldOut: "매진",
    ended: "종료",
    subscriptionUnitPrice: "청약 단가",
    subscribeNow: "지금 청약하기",
    unavailableSubscribe: "현재 청약 불가",
    noSubscriptions: "현재 표시할 수 있는 청약 자산이 없습니다.",
    availableBalance: "사용 가능 잔資料資料",
    subscriptionUnits: "청약 수량",
    subscriptionTotal: "청약 총액",
    confirmSubscription: "청약 확정",
  },
};
const pageExtra: Partial<Record<Lang, Record<string, string>>> = {
  th: {
    announcement: "สินทรัพย์ของแพลตฟอร์มกำหนดราคาเป็น JC ตามรายการ และจะระบุว่าธุรกรรมบนเชนเสร็จสมบูรณ์หลังได้รับการยืนยันเท่าน資料資料資料้น",
    more: "สินทรัพย์เพิ่มเติม", valuation: "มูลค่าประเมินสิ資料資料ทรัพย์", expectedApy: "APY ที่คาดหวัง", verification: "การตรวจสอบสินทรัพย์", fullAddress: "ที่อยู่เต็ม", propertyHistory: "ประวัติอสังหาริ資料資料ทรัพย์", nearbyPricing: "ราคาอสังหาริ資料資料ทรัพย์ใกล้เคียง", advantages: "จุดเด่นการลงทุน",
    all: "ทั้งหมด", rising: "ปรับขึ้น", falling: "ปรับลง", owned: "จำนวนหน่วยที่ถือ", totalAssets: "มูลค่าสินทรัพย์ร資料資料ม", status: "สถานะ", confirmed: "ยืนยันแล้ว", subscribeEyebrow: "ตลาดแรก", subscribeTitle: "จองซื้อ", subscribing: "เปิด資料資料資料ั資料資料จอง", soldOut: "ขายหมดแล้ว", ended: "สิ้นสุดแล้ว", subscriptionUnitPrice: "ราคาต่อหน่วย", subscribeNow: "จองซื้อเลย", unavailableSubscribe: "ขณะนี้ไม่เปิดให้จองซื้อ", noSubscriptions: "ไม่มีสินทรัพย์ที่เปิดให้จองซื้อในขณะนี้", availableBalance: "ยอดคงเหลือที่ใช้ได้", subscriptionUnits: "จำนวนหน資料資料資料วยที่จอง", subscriptionTotal: "ยอดจองรวม", confirmSubscription: "ยืนยันการจอง", agentCenter: "ศูนย์資料資料ัวแทน", dateRange: "ช่วงวันที่",
  },
  vi: {
    announcement: "Tài sản trên nền tảng được định giá bằng JC theo từng sản phẩm; giao dịch on-chain chỉ được đánh dấu hoàn tất sau khi xác nhận.",
    more: "Thêm tài sản", valuation: "Giá trị định giá", expectedApy: "APY dự kiến", verification: "Xác minh tài sản", fullAddress: "Địa chỉ đầy đủ", propertyHistory: "Lịch sử bất động sản", nearbyPricing: "Giá tham khảo lân cận", advantages: "Ưu điểm đầu tư",
    all: "Tất cả", rising: "Tăng", falling: "Gi資料資料m", owned: "Số lượng đang n資料資料m giữ", totalAssets: "Tổng giá trị tài sản", status: "Trạng thái", confirmed: "Đã xác nhận", subscribeEyebrow: "Thị trường sơ cấp", subscribeTitle: "Đ資料資料ng ký mua", subscribing: "Đang mở bán", soldOut: "Đã bán hết", ended: "Đã kết thúc", subscriptionUnitPrice: "Giá đăng ký mỗi đơn vị", subscribeNow: "Đăng ký ngay", unavailableSubscribe: "Hiện không thể đăng ký mua", noSubscriptions: "Hiện không có tài sản sơ cấp để hiển thị.", availableBalance: "Số dư khả dụng", subscriptionUnits: "Số đơn vị đăng ký", subscriptionTotal: "Tổng giá trị đăng ký", confirmSubscription: "Xác nhận đăng ký", agentCenter: "Trung tâm đại lý", dateRange: "Khoảng thời gian",
  },
  id: {
    announcement: "Aset platform dihargai dalam JC sesuai daftar masing-masing; transaksi on-chain hanya dinyatakan selesai setelah dikonfirmasi.",
    more: "Aset lainnya", valuation: "Nilai valuasi aset", expectedApy: "APY yang diharapkan", verification: "Verifikasi aset", fullAddress: "Alamat lengkap", propertyHistory: "Riwayat properti", nearbyPricing: "Harga properti sekitar", advantages: "Keunggulan investasi",
    all: "Semua", rising: "Naik", falling: "Turun", owned: "Unit yang dimiliki", totalAssets: "Total nilai aset", status: "Status", confirmed: "Terkonfirmasi", subscribeEyebrow: "Pasar primer", subscribeTitle: "Berlangganan", subscribing: "Sedang dibuka", soldOut: "Habis terjual", ended: "Berakhir", subscriptionUnitPrice: "Harga per unit", subscribeNow: "Berlangganan sekarang", unavailableSubscribe: "Langganan belum tersedia", noSubscriptions: "Saat ini tidak ada aset primer untuk ditampilkan.", availableBalance: "Saldo tersedia", subscriptionUnits: "Unit langganan", subscriptionTotal: "Total langganan", confirmSubscription: "Konfirmasi langganan", agentCenter: "Pusat agen", dateRange: "Rentang tanggal",
  },
  ms: {
    announcement: "Aset platform dinilai dalam JC mengikut penyenaraian; transaksi dalam rantaian hanya ditandakan selesai selepas pengesahan.",
    more: "Lagi aset", valuation: "Nilai penilaian aset", expectedApy: "APY dijangka", verification: "Pengesahan aset", fullAddress: "Alamat penuh", propertyHistory: "Sejarah hartanah", nearbyPricing: "Harga hartanah berhampiran", advantages: "Kelebihan pelaburan",
    all: "Semua", rising: "Meningkat", falling: "Menurun", owned: "Unit dimiliki", totalAssets: "Jumlah nilai aset", status: "Status", confirmed: "Disahkan", subscribeEyebrow: "Pasaran utama", subscribeTitle: "Langgan", subscribing: "Langganan dibuka", soldOut: "Habis dijual", ended: "Tamat", subscriptionUnitPrice: "Harga setiap unit", subscribeNow: "Langgan sekarang", unavailableSubscribe: "Langganan tidak tersedia sekarang", noSubscriptions: "Tiada aset pasaran utama untuk dipaparkan buat masa ini.", availableBalance: "Baki tersedia", subscriptionUnits: "Unit langganan", subscriptionTotal: "Jumlah langganan", confirmSubscription: "Sahkan langganan", agentCenter: "Pusat ejen", dateRange: "Julat tarikh",
  },
  es: {
    announcement: "Los activos de la plataforma se valoran en JC según cada oferta; una operación on-chain solo se marca como completada tras su confirmación.",
    more: "Más activos", valuation: "Valor de tasación", expectedApy: "APY esperado", verification: "Verificación del activo", fullAddress: "Dirección completa", propertyHistory: "Historial del inmueble", nearbyPricing: "Precios de la zona", advantages: "Ventajas de inversión",
    all: "Todos", rising: "Al alza", falling: "A la baja", owned: "Unidades en propiedad", totalAssets: "Valor total de los activos", status: "Estado", confirmed: "Confirmado", subscribeEyebrow: "Mercado primario", subscribeTitle: "Suscripción", subscribing: "Suscripción abierta", soldOut: "Agotado", ended: "Finalizado", subscriptionUnitPrice: "Precio por unidad", subscribeNow: "Suscribirse", unavailableSubscribe: "Suscripción no disponible", noSubscriptions: "No hay activos disponibles para suscripción en este momento.", availableBalance: "Saldo disponible", subscriptionUnits: "Unidades de suscripción", subscriptionTotal: "Total de la suscripción", confirmSubscription: "Confirmar suscripción", agentCenter: "Centro de agentes", dateRange: "Intervalo de fechas",
  },
  fr: {
    announcement: "Les actifs de la plateforme sont valorisés en JC selon chaque offre ; une opération on-chain n’est marquée comme terminée qu’après confirmation.",
    more: "Plus d’actifs", valuation: "Valeur estimée", expectedApy: "APY attendu", verification: "Vérification de l’actif", fullAddress: "Adresse complète", propertyHistory: "Historique du bien", nearbyPricing: "Prix du quartier", advantages: "Atouts de l’investissement",
    all: "Tout", rising: "En hausse", falling: "En baisse", owned: "Unités détenues", totalAssets: "Valeur totale des actifs", status: "Statut", confirmed: "Confirmé", subscribeEyebrow: "Marché primaire", subscribeTitle: "Souscription", subscribing: "Souscription ouverte", soldOut: "Épuisé", ended: "Terminé", subscriptionUnitPrice: "Prix par unité", subscribeNow: "Souscrire", unavailableSubscribe: "Souscription indisponible", noSubscriptions: "Aucun actif disponible à la souscription pour le moment.", availableBalance: "Solde disponible", subscriptionUnits: "Unités souscrites", subscriptionTotal: "Total de la souscription", confirmSubscription: "Confirmer la souscription", agentCenter: "Centre des agents", dateRange: "Période",
  },
  de: {
    announcement: "Plattformanlagen werden je Angebot in JC bewertet; eine On-Chain-Transaktion gilt erst nach Bestätigung als abgeschlossen.",
    more: "Weitere Anlagen", valuation: "Vermögensbewertung", expectedApy: "Erwartete APY", verification: "Anlagenprüfung", fullAddress: "Vollständige Adresse", propertyHistory: "Objekthistorie", nearbyPricing: "Preise in der Umgebung", advantages: "Anlagevorteile",
    all: "Alle", rising: "Steigend", falling: "Fallend", owned: "Gehaltene Einheiten", totalAssets: "Gesamtwert der Anlagen", status: "Status", confirmed: "Bestätigt", subscribeEyebrow: "Primärmarkt", subscribeTitle: "Zeichnung", subscribing: "Zeichnung geöffnet", soldOut: "Ausverkauft", ended: "Beendet", subscriptionUnitPrice: "Preis je Einheit", subscribeNow: "Jetzt zeichnen", unavailableSubscribe: "Zeichnung derzeit nicht verfügbar", noSubscriptions: "Derzeit sind keine zeichnungsfähigen Anlagen verfügbar.", availableBalance: "Verfügbares Guthaben", subscriptionUnits: "Zeichnungseinheiten", subscriptionTotal: "Zeichnungssumme", confirmSubscription: "Zeichnung bestätigen", agentCenter: "Agentenzentrum", dateRange: "Zeitraum",
  },
  pt: {
    announcement: "Os ativos da plataforma são avaliados em JC conforme cada oferta; uma transação on-chain só é marcada como concluída após confirmação.",
    more: "Mais ativos", valuation: "Valor de avaliaç資料資料o", expectedApy: "APY esperado", verification: "Verificação do ativo", fullAddress: "Endereço completo", propertyHistory: "Histórico do imóvel", nearbyPricing: "Preços da região", advantages: "Vantagens do investimento",
    all: "Todos", rising: "Em alta", falling: "Em baixa", owned: "Unidades detidas", totalAssets: "Valor total dos ativos", status: "Estado", confirmed: "Confirmado", subscribeEyebrow: "Mercado primário", subscribeTitle: "Subscrição", subscribing: "Subscrição aberta", soldOut: "Esgotado", ended: "Terminado", subscriptionUnitPrice: "Preço por unidade", subscribeNow: "Subscrever agora", unavailableSubscribe: "Subscrição indisponível", noSubscriptions: "Não existem ativos disponíveis para subscrição neste momento.", availableBalance: "Saldo disponível", subscriptionUnits: "Unidades da subscrição", subscriptionTotal: "Total da subscrição", confirmSubscription: "Confirmar subscrição", agentCenter: "Centro de agentes", dateRange: "Período",
  },
  ru: {
    announcement: "Активы платформы оцениваются в JC согласно каждому предложению; транзакция в блокчейне считается завершённой 資料資料олько после подтверждения.",
    more: "Другие активы", valuation: "Оценочная стоимость", expectedApy: "Ожидаемая APY", verification: "Проверка актива", fullAddress: "Полный адрес", propertyHistory: "История объекта", nearbyPricing: "Цены поблизости", advantages: "Преимущ資料資料ства инвестиций",
    all: "Все", rising: "Рост", falling: "Снижение", owned: "Количество во владении", totalAssets: "Общая стоимость активов", status: "Статус", confirmed: "Подтверждено", subscribeEyebrow: "Первичный рынок", subscribeTitle: "Подписка", subscribing: "Подписка открыта", soldOut: "Распродано", ended: "Завершено", subscriptionUnitPrice: "Цена за единицу", subscribeNow: "Подписаться", unavailableSubscribe: "Подписка сейчас недоступна", noSubscriptions: "Сейчас нет активов, доступных для подписки.", availableBalance: "Доступный баланс", subscriptionUnits: "Количество единиц", subscriptionTotal: "Сумма подписки", confirmSubscription: "Подтвердить подписку", agentCenter: "Центр агентов", dateRange: "Период",
  },
  ar: {
    announcement: "تُسعّر أصول المنصة بعملة JC وفقًا لكل طرح؛ ولا تُعدّ المعاملة على السلسلة مكتملة إلا بعد تأكيدها.",
    more: "المزيد من الأصول", valuation: "القيمة التقديرية", expectedApy: "العائد ال資料資料نوي المتوقع", verification: "التحقق من الأصل", fullAddress: "العنوان الكامل", propertyHistory: "سجل العقار", nearbyPricing: "أسعار الم資料資料طقة", advantages: "مزايا الاستثمار",
    all: "الكل", rising: "ارتفاع", falling: "انخفاض", owned: "الوحدات المملوكة", totalAssets: "إجمالي قيمة الأصول", status: "الحالة", confirmed: "تم التأكيد", subscribeEyebrow: "السوق الأولية", subscribeTitle: "الاكتتاب", subscribing: "الاكتتاب متاح", soldOut: "نفدت الكمية", ended: "انتهى", subscriptionUnitPrice: "سعر الو資料資料دة", subscribeNow: "اكتتب الآن", unavailableSubscribe: "الاكتت資料資料ب غير متاح حاليًا", noSubscriptions: "لا توجد أصول متاحة للاكتتاب حاليًا.", availableBalance: "الرصيد المتاح", subscriptionUnits: "وحدات الاكتتاب", subscriptionTotal: "إجمالي الاكتتاب", confirmSubscription: "تأكيد الاكتتاب", agentCenter: "مركز الوكلاء", dateRange: "النطاق الزمني",
  },
  hi: {
    announcement: "प्लेटफ़ॉर्म की संपत्तियों का मूल्य प्रत्येक सूची के अनुसार JC में है; ऑन-चेन लेनदेन की पुष्टि के बाद ही उसे पूरा माना जाता है।",
    more: "और संपत्तियाँ", valuation: "संपत्ति का मूल्यांकन", expectedApy: "अपेक्षित APY", verification: "संपत्ति सत्यापन", fullAddress: "पूरा पता", propertyHistory: "संपत्ति का इतिहास", nearbyPricing: "आसपास के मूल्य", advantages: "निवेश के लाभ",
    all: "सभी", rising: "बढ़त", falling: "गिरावट", owned: "स्वामित्व वाली इकाइयाँ", totalAssets: "कुल संपत्ति मूल्य", status: "स्थिति", confirmed: "पुष्टि की गई", subscribeEyebrow: "प्राथमिक बाज़ार", subscribeTitle: "सब्सक्रिप्शन", subscribing: "सब्सक्रिप्शन खुला है", soldOut: "बिक गया", ended: "समाप्त", subscriptionUnitPrice: "प्रति इकाई मूल्य", subscribeNow: "अभी सब्सक्राइब करें", unavailableSubscribe: "अभी उपलब्ध नहीं", noSubscriptions: "फ़िलहाल दिखाने के लिए कोई प्राथमिक संपत्ति उपलब्ध नहीं है।", availableBalance: "उपलब्ध शेष", subscriptionUnits: "सब्सक्रिप्शन इकाइयाँ", subscriptionTotal: "कुल सब्सक्रिप्शन", confirmSubscription: "सब्सक्रिप्शन की पुष्टि करें", agentCenter: "एजेंट केंद्र", dateRange: "तिथि सीमा",
  },
};
const extraKeys = [
  "preferences",
  "notifications",
  "changeLanguage",
  "identity",
  "verifiedDate",
  "level",
  "price",
  "dividend",
  "listings",
  "receiveAlerts",
  "investor",
  "totalAssets",
  "networkFee",
  "status",
  "confirmed",
  "available",
  "quantity",
  "date",
  "transactionHash",
  "depositTitle",
  "withdrawTitle",
  "amount",
  "submit",
  "copyAddress",
] as const;
const extraRows: Record<Lang, string[]> = {
  "zh-TW": [
    "偏好設定",
    "通知",
    "變更整個介面語言",
    "身分驗證",
    "驗證日期",
    "等級",
    "價格通知",
    "收益分配通知",
    "新項目通知",
    "接收帳戶與資產通知",
    "投資者",
    "總資產價值",
    "網路手續費",
    "狀態",
    "已確認",
    "可用",
    "數量",
    "日期",
    "交易雜湊",
    "充值 USDT",
    "提領 USDT",
    "金額",
    "提交",
    "資料資料資料製地址",
  ],
  "zh-CN": [
    "偏好设置",
    "通知",
    "更改整个界面语言",
    "身份验证",
    "验证日期",
    "等级",
    "价格通知",
    "收益分配通知",
    "新项目通知",
    "接收账户与资产通知",
    "資料資料资者",
    "总资产价值",
    "网络手续费",
    "状态",
    "已确认",
    "可用",
    "数量",
    "日期",
    "交易哈希",
    "充值 USDT",
    "提现 USDT",
    "金额",
    "提交",
    "复制地址",
  ],
  en: [
    "Preferences",
    "Notifications",
    "Change the entire interface language",
    "Identity verification",
    "Verification date",
    "Level",
    "Price alerts",
    "Dividend alerts",
    "New listing alerts",
    "Receive account and asset notifications",
    "Investor",
    "Total asset value",
    "Network fee",
    "Status",
    "Confirmed",
    "Available",
    "Quantity",
    "Date",
    "Transaction hash",
    "Deposit USDT",
    "Withdraw USDT",
    "Amount",
    "Submit",
    "Copy address",
  ],
  ja: [
    "環境設定",
    "通知",
    "インターフェース全体の言語を変更",
    "本人確認",
    "確認日",
    "レ資料資料ル",
    "価格通知",
    "配当通資料資料資料",
    "新規上場通知",
    "口座と資産の通知を受信",
    "投資家",
    "資料資料資料資産価値",
    "ネットワーク手数料",
    "状態",
    "確認済み",
    "利資料資料資料可能",
    "数量",
    "日付",
    "取引ハ資料資料シュ",
    "USDTを入金",
    "USDTを出金",
    "金額",
    "送信",
    "アドレスをコピー",
  ],
  ko: [
    "資料資料資料경 설정",
    "알림",
    "전체 인터페이스 언어 변경",
    "신원 인증",
    "인증 날짜",
    "등급",
    "가격 알림",
    "수익 배분 알림",
    "신규 자산 알림",
    "계정 및 자산 알림 수신",
    "투자자",
    "총 자산 가치",
    "네트워크 수수료",
    "상태",
    "확인됨",
    "사용 가능",
    "수량",
    "날짜",
    "거래 해시",
    "USDT 입금",
    "USDT 資料資料資料금",
    "금액",
    "제출",
    "주소 복사",
  ],
  th: [
    "การตั้งค่資料資料",
    "การแจ้งเตือน",
    "เปลี่ยนภาษาของอินเทอร์เฟซทั้งหมด",
    "การยืนยันตัวตน",
    "วันที่ยืนยัน",
    "ระดับ",
    "แจ้งเตือนราคา",
    "แจ้งเตือนเงินปันผล",
    "แจ้งเตือนรายการใหม่",
    "資料資料ับการแจ้งเตือนบัญชีและสินทรัพย์",
    "นักลงทุน",
    "มูลค่าสินทรัพย์รวม",
    "ค่าธรรมเนียมเครือข่าย",
    "สถานะ",
    "ยืนยันแล้ว",
    "พร้อมใช้",
    "จำนวน",
    "วันที่",
    "แฮชธุรกรรม",
    "ฝาก USDT",
    "ถอน USDT",
    "จำนวนเงิน",
    "ส่ง",
    "คัดลอกที่อยู่",
  ],
  vi: [
    "Tùy chọn",
    "Thông b資料資料o",
    "Thay đổi ngôn ngữ toàn bộ giao diện",
    "Xác minh danh tính",
    "Ngày xác minh",
    "Cấp độ",
    "Cảnh báo giá",
    "Cảnh báo lợi nhuận",
    "Cảnh báo niêm yết mới",
    "Nhận thông báo tài khoản và tài sản",
    "Nhà đầu tư",
    "Tổng giá trị tài sản",
    "Phí mạng",
    "Trạng thái",
    "Đã xác nhận",
    "Khả dụng",
    "Số lượng",
    "Ngày",
    "Mã giao dịch",
    "Nạp USDT",
    "Rút USDT",
    "Số tiền",
    "Gửi",
    "Sao chép địa chỉ",
  ],
  id: [
    "Preferensi",
    "Notifikasi",
    "Ubah bahasa seluruh antarmuka",
    "Verifikasi identitas",
    "Tanggal verifikasi",
    "Tingkat",
    "Peringatan harga",
    "Peringatan dividen",
    "Peringatan listing baru",
    "Terima notifikasi akun dan aset",
    "Investor",
    "Total nilai aset",
    "Biaya jaringan",
    "Status",
    "Dikonfirmasi",
    "Tersedia",
    "Jumlah",
    "Tanggal",
    "Hash transaksi",
    "Setor USDT",
    "Tarik USDT",
    "Jumlah",
    "Kirim",
    "Salin alamat",
  ],
  ms: [
    "Keutamaan",
    "Pemberitahuan",
    "Tukar bahasa seluruh antara muka",
    "Pengesahan identiti",
    "Tarikh pengesahan",
    "Tahap",
    "Makluman harga",
    "Makluman dividen",
    "Makluman penyenaraian baharu",
    "Terima pemberitahuan akaun dan aset",
    "Pelabur",
    "Jumlah nilai aset",
    "Yuran rangkaian",
    "Status",
    "Disahkan",
    "Tersedia",
    "Kuantiti",
    "Tarikh",
    "Hash transaksi",
    "Deposit USDT",
    "Keluarkan USDT",
    "Jumlah",
    "Hantar",
    "Salin alamat",
  ],
  es: [
    "Preferencias",
    "Notificaciones",
    "Cambiar el idioma de toda la interfaz",
    "Verificación de identidad",
    "Fecha de verificación",
    "Nivel",
    "Alertas de precio",
    "Alertas de dividendos",
    "Alertas de nuevos activos",
    "Recibir avisos de cuenta y activos",
    "Inversor",
    "Valor total de activos",
    "Comisión de red",
    "Estado",
    "Confirmado",
    "Disponible",
    "Cantidad",
    "Fecha",
    "Hash de transacción",
    "Depositar USDT",
    "Retirar USDT",
    "Importe",
    "Enviar",
    "Copiar dirección",
  ],
  fr: [
    "Préférences",
    "Notifications",
    "Changer la langue de toute l’interface",
    "Vérification d’identit資料資料",
    "Date de vérification",
    "Niveau",
    "Alertes de prix",
    "Alertes de dividendes",
    "Alertes de nouvelles cotations",
    "Recevoir les notifications du compte et des actifs",
    "Investisseur",
    "Valeur totale des actifs",
    "Frais réseau",
    "Statut",
    "Confirmé",
    "Disponible",
    "Quantité",
    "Date",
    "Hachage de transaction",
    "Déposer des USDT",
    "Retirer des USDT",
    "Montant",
    "Envoyer",
    "Copier l’adresse",
  ],
  de: [
    "Präferenzen",
    "Benachrichtigungen",
    "Sprache der gesamten Oberfläche ändern",
    "Identitätsprüfung",
    "Prüfdatum",
    "Stufe",
    "Preisalarme",
    "Ausschüttungsalarme",
    "Alarme für neue Angebote",
    "Konto- und Asset-Benachrichtigungen erhalten",
    "Investor",
    "Gesamtwert der Assets",
    "Netzwerkgebühr",
    "Status",
    "Bestätigt",
    "Verfügbar",
    "Menge",
    "Datum",
    "Transaktions-Hash",
    "USDT einzahlen",
    "USDT auszahlen",
    "Betrag",
    "Senden",
    "Adresse kopieren",
  ],
  pt: [
    "Preferências",
    "Notificações",
    "Alterar o idioma de toda a interface",
    "Verificação de identidade",
    "Data de verificaç資料資料o",
    "Nível",
    "Alertas de preço",
    "Alertas de dividendos",
    "Alertas de novas listagens",
    "Receber notificações da conta e dos ativos",
    "Investidor",
    "Valor total dos ativos",
    "Taxa de rede",
    "Estado",
    "Confirmado",
    "Disponível",
    "Quantidade",
    "Data",
    "Hash da transação",
    "Depositar USDT",
    "Retirar USDT",
    "Montante",
    "Enviar",
    "Copiar endereço",
  ],
  ru: [
    "Предпочтения",
    "Уведомления",
    "Изменить язык всего интерфейса",
    "Проверка личности",
    "Дата проверки",
    "Уровень",
    "Оповещения о цене",
    "Оповещения о выплатах",
    "Оповещения о новых активах",
    "Получать уведомления об аккаунте и активах",
    "Инвестор",
    "Общая стоимость активов",
    "Сетевая комиссия",
    "Статус",
    "Подтверждено",
    "Доступно",
    "Количество",
    "Дата",
    "Хэш транзакции",
    "Пополнить USDT",
    "Вывести USDT",
    "Сумма",
    "Отправить",
    "Копировать адрес",
  ],
  ar: [
    "التفضيلات",
    "الإشعارات",
    "تغيير لغة الواجهة بالكامل",
    "التحقق من الهوية",
    "تاريخ التحقق",
    "المستوى",
    "تنبيهات الأسعار",
    "تنبيهات الأرباح",
    "تنب資料資料هات الإدراج الجديد",
    "تلقي إشعارات الحساب 資料資料الأصول",
    "مستثمر",
    "إجمالي قيمة 資料資料لأصو資料資料",
    "رسوم الشبكة",
    "資料資料لحالة",
    "مؤكد",
    "مت資料資料ح",
    "الكمية",
    "التاريخ",
    "معرّف المعاملة",
    "إيداع USDT",
    "سحب USDT",
    "المبلغ",
    "إرسال",
    "نسخ العنوان",
  ],
  hi: [
    "प्राथमिकताएँ",
    "資料資料資料ूचनाएँ",
    "पूरे इंटरफ資料資料資料ेस की भाषा बदलें",
    "पहच資料資料न सत्यापन",
    "सत्यापन तिथ資料資料",
    "स्तर",
    "मू資料資料्य सूचन資料資料資料एँ",
    "लाभांश सूचनाएँ",
    "नई लिस्टिंग सूचनाएँ",
    "खाता 資料資料資料र एसेट 資料資料ूचनाएँ प्राप्त करें",
    "नि資料資料資料ेशक",
    "कुल एसेट म資料資料資料ल्य",
    "न資料資料資料टवर्क शुल्क",
    "स्थिति",
    "पुष्टि हुई",
    "उपलब्ध",
    "मात्रा",
    "तिथि",
    "लेनदेन हैश",
    "USDT जमा करें",
    "USDT निकालें",
    "राशि",
    "जमा करें",
    "पता कॉपी करें",
  ],
};
const LanguageContext = createContext<{
  language: Lang;
  setLanguage: (l: Lang) => void;
  t: (k: Key) => string;
  tr: (k: string) => string;
  assets: Asset[];
} | null>(null);
const assetNames: Record<Lang, string[]> = {
  "zh-TW": ASSETS.map((a) => a.name),
  "zh-CN": [
    "墨尔本 Southbank 河景公寓",
    "东京涩谷商业大楼",
    "新加坡 Marina Bay 景观資料資料資料宅",
    "伦敦 Canary Wharf 办公室",
  ],
  en: [
    "Melbourne Southbank River View Residence",
    "Tokyo Shibuya Commercial Building",
    "Singapore Marina Bay Residence",
    "London Canary Wharf Office",
  ],
  ja: [
    "メルボルン・サウスバンク リバービュー住宅",
    "東京渋谷 商業ビル",
    "シン資料資料資料ポール・マリーナベイ眺望住宅",
    "ロンドン・カナリ資料資料ワーフ オフィス",
  ],
  ko: [
    "멜버른 사우스뱅크 리버뷰 주거",
    "도쿄 시부야 상업 빌딩",
    "싱가포르 마리나베이 전망 주거",
    "런던 카나리워프 오피資料資料資料",
  ],
  th: [
    "ที่พักวิวแม่น้ำเมลเบิร์นเซาท์แบงก์",
    "อาคารพาณิชย์โตเกี資料資料วชิบูย่า",
    "ที่พักวิวมารีนาเบย์สิงคโปร์",
    "สำนักงานลอนดอนคานารีวอร์ฟ",
  ],
  vi: [
    "Căn hộ hướng sông Melbourne Southbank",
    "Tòa nhà thương mại Tokyo Shibuya",
    "C資料資料n hộ Marina Bay Singapore",
    "Văn phòng London Canary Wharf",
  ],
  id: [
    "Hunian Pemandangan Sungai Melbourne Southbank",
    "Gedung Komersial Tokyo Shibuya",
    "Hunian Marina Bay Singapura",
    "Kantor London Canary Wharf",
  ],
  ms: [
    "Kediaman Pemandangan Sungai Melbourne Southbank",
    "Bangunan Komersial Tokyo Shibuya",
    "Kediaman Marina Bay Singapura",
    "Pejabat London Canary Wharf",
  ],
  es: [
    "Residencia con vistas al río Melbourne Southbank",
    "Edificio comercial Tokyo Shibuya",
    "Residencia Marina Bay Singapur",
    "Oficina London Canary Wharf",
  ],
  fr: [
    "Résidence avec vue sur la rivière Melbourne Southbank",
    "Immeuble commercial Tokyo Shibuya",
    "Résidence Marina Bay Singapour",
    "Bureaux London Canary Wharf",
  ],
  de: [
    "Melbourne Southbank Residenz mit Flussblick",
    "Geschäftshaus Tokyo Shibuya",
    "Singapore Marina Bay Residenz",
    "London Canary Wharf Büro",
  ],
  pt: [
    "Residência com vista para o rio Melbourne Southbank",
    "Edifício comercial Tokyo Shibuya",
    "Residência Marina Bay Singapura",
    "Escritório London Canary Wharf",
  ],
  ru: [
    "Резиденция Melbourne Southbank с видом на реку",
    "Коммерческое здание Tokyo Shibuya",
    "Резиденция Singapore Marina Bay",
    "Офис London Canary Wharf",
  ],
  ar: [
    "سكن ملبورن س資料資料وث بانك بإطلالة على النهر",
    "مبنى طوكيو شيبويا التجاري",
    "سكن سنغافورة مارينا باي",
    "مكتب 資料資料ندن كناري وارف",
  ],
  hi: [
    "मेलबर्न साउथबैंक रिवर व्यू निवास",
    "टोक्यो शिबुया वाणिज्यिक भवन",
    "सिंगापुर मरीना बे निवास",
    "लं資料資料न कैनरी व्हार्फ कार्यालय",
  ],
};
const localizeAssets = (language: Lang) =>
  ASSETS.map((a, index) =>
    language === "zh-TW"
      ? a
      : language === "zh-CN"
        ? {
            ...a,
            name: assetNames[language][index],
            history: a.history.map(simplified),
            comparables: a.comparables.map(simplified),
            advantages: a.advantages.map(simplified),
          }
        : {
            ...a,
            name: assetNames[language][index],
            history:
              a.id === "mel-southbank"
                ? [
                    "Completed and licensed in 2018",
                    "Fully renovated in 2022",
                    "Independently valued at 2.5M USDT in 2026",
                  ]
                : [
                    "Completed and fully licensed",
                    "Recent efficiency and interior upgrades",
                    "Independent valuation and on-chain verification completed",
                  ],
            comparables: [
              "Pricing benchmarked against recent nearby transactions",
              "Local vacancy rate remains below the regional average",
              "Rental demand and rates continue to grow",
            ],
            advantages: [
              "Prime location near major transit",
              "Stable occupancy and tenant demand",
              "Independently verified real-world asset",
            ],
          },
  );
const hasInvalidText = (value: unknown): value is string =>
  typeof value === "string" && (!value.trim() || value.includes("資料"));

const safeLocalizedText = (preferred: unknown, fallback: unknown, key: string) => {
  if (typeof preferred === "string" && !hasInvalidText(preferred)) return preferred;
  if (typeof fallback === "string" && !hasInvalidText(fallback)) return fallback;
  return key;
};

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Lang>(
    () => readPreferredLanguage() ?? "zh-TW",
  );
  const setLanguage = useCallback((l: Lang) => {
    setLanguageState(l);
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, l);
    } catch {
      // Private mode / full storage can block persistence; the URL remains a fallback.
    }
    window.dispatchEvent(new CustomEvent("platform-language-updated", { detail: l }));
    try {
      const u = new URL(location.href);
      if (u.searchParams.get("lang") !== l) {
        u.searchParams.set("lang", l);
        history.replaceState(null, "", u);
      }
    } catch {
      // Safari rate-limits history updates; language state stays authoritative.
    }
  }, []);
  useEffect(() => {
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
    document.documentElement.lang = language;
  }, [language]);
  const value = useMemo(
    () => ({
      language,
      setLanguage,
      t: (k: Key) => {
        const index = keys.indexOf(k);
        return safeLocalizedText(words[language]?.[index], words.en?.[index], k);
      },
      tr: (k: string) => {
        const index = extraKeys.indexOf(k as (typeof extraKeys)[number]);
        const preferred = index >= 0
          ? extraRows[language]?.[index]
          : pageExtra[language]?.[k] ??
            simpleExtra[language]?.[k] ??
            (language === "zh-TW" ? extraZh[k] : undefined);
        return safeLocalizedText(preferred, extraEn[k] ?? extraZh[k], k);
      },
      assets: localizeAssets(language),
    }),
    [language, setLanguage],
  );
  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}
export const useLanguage = () => {
  const v = useContext(LanguageContext);
  if (!v) throw new Error("LanguageProvider missing");
  return v;
};

export type ColorMode = "dark" | "light" | "system";
type ThemeValue = {
  mode: ColorMode;
  hue: number;
  saturation: number;
  lightness: number;
  setMode: (mode: ColorMode) => void;
  setColor: (hue: number, saturation: number, lightness: number) => void;
};
const ThemeContext = createContext<ThemeValue | null>(null);
const modes: ColorMode[] = ["dark", "light", "system"];
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ColorMode>("dark");
  const [hue, setHue] = useState(43);
  const [saturation, setSaturation] = useState(96);
  const [lightness, setLightness] = useState(56);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const nextMode = params.get("theme") as ColorMode;
    if (modes.includes(nextMode)) setModeState(nextMode);
    setHue(clamp(Number(params.get("hue") ?? 43), 0, 360));
    setSaturation(clamp(Number(params.get("saturation") ?? 96), 20, 100));
    setLightness(clamp(Number(params.get("lightness") ?? 56), 30, 75));
  }, []);
  const pendingParams = useRef<Record<string, string>>({});
  const flushTimer = useRef<number | null>(null);
  // Safari throws a SecurityError after ~100 history.replaceState calls per 30s,
  // so URL updates are coalesced, throttled and never allowed to break the UI.
  const updateUrl = useCallback((key: string, value: string) => {
    pendingParams.current[key] = value;
    if (flushTimer.current !== null) return;
    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = null;
      const params = pendingParams.current;
      pendingParams.current = {};
      if (Object.keys(params).length === 0) return;
      try {
        const url = new URL(location.href);
        for (const [name, next] of Object.entries(params))
          url.searchParams.set(name, next);
        history.replaceState(null, "", url);
      } catch {
        // Ignore rate-limited or blocked history updates; theme state is authoritative.
      }
    }, 400);
  }, []);
  useEffect(
    () => () => {
      if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
    },
    [],
  );
  const setMode = useCallback((value: ColorMode) => {
    setModeState(value);
    updateUrl("theme", value);
  }, [updateUrl]);
  const setColor = useCallback((
    nextHue: number,
    nextSaturation: number,
    nextLightness: number,
  ) => {
    const values = {
      hue: clamp(Math.round(nextHue), 0, 360),
      saturation: clamp(Math.round(nextSaturation), 20, 100),
      lightness: clamp(Math.round(nextLightness), 30, 75),
    };
    setHue(values.hue);
    setSaturation(values.saturation);
    setLightness(values.lightness);
    Object.entries(values).forEach(([key, value]) =>
      updateUrl(key, String(value)),
    );
  }, [updateUrl]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        mode === "system" ? (media.matches ? "dark" : "light") : mode;
      document.documentElement.dataset.accent = "custom";
      document.documentElement.style.setProperty("--accent-h", String(hue));
      document.documentElement.style.setProperty(
        "--accent-s",
        `${saturation}%`,
      );
      document.documentElement.style.setProperty("--accent-l", `${lightness}%`);
      document.documentElement.style.colorScheme =
        mode === "system" ? "light dark" : mode;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode, hue, saturation, lightness]);
  return (
    <ThemeContext.Provider
      value={{ mode, hue, saturation, lightness, setMode, setColor }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
export const useTheme = () => {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("ThemeProvider missing");
  return value;
};
export const formatUSDT = (n: number) =>
  `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;

// AE amounts can be fractional (a USDT figure divided by the AE price), so we
// allow up to 6 decimals but trim trailing zeros for readability.
export const formatAE = (n: number) =>
  `${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 })} AE`;

// Unit-aware formatter: commission/transaction figures carry a display_currency
// flag ("ae" | "usdt"). AE-token subscriptions stay in USDT; everything else
// (RWA subscription, RWA/AE secondary market) shows AE. Callers pass the
// already-unit-appropriate numeric value.
// JC is the platform currency. Amounts can be fractional so allow up to 6
// decimals, trimming trailing zeros for readability.
export const formatJC = (n: number) =>
  `${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 })} JC`;

export const formatUnit = (n: number, currency: "ae" | "usdt" | "jc") =>
  currency === "usdt" ? formatUSDT(n) : currency === "ae" ? formatAE(n) : formatJC(n);
