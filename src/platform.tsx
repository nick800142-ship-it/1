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
import { reportMonitorEventInBackground } from "@/lib/monitoring";
import { useVisiblePolling } from "@/hooks/useVisiblePolling";
import { useOnChainUsdtBalance } from "@/lib/onchainUsdt";

const keepStable = <T,>(previous: T, next: T): T =>
  JSON.stringify(previous) === JSON.stringify(next) ? previous : next;

export type AssetTranslation = {
  name?: string;
  location?: string;
  information?: string;
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
};
export type Transaction = {
  id: string;
  type: "buy" | "sell" | "deposit" | "withdraw" | "dividend";
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
  currency?: "jc" | "usdt";
  date: string;
  createdAt: string;
  hash: string;
  status: "confirmed";
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
    name: "東京澀谷商業大樓",
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
      "灣���豪宅中位價：3.9M USDT",
      "每平方呎均價：2,850 USDT",
      "租賃需求年增：6.4%",
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
      "甲級辦公室���益率：5.8%",
      "平均租金：每呎 58 USDT",
      "空置率低於區域平均",
    ],
    advantages: ["Elizabeth Line 直達", "ESG 認證建���", "多元企業租戶組合"],
  },
];

type TradeResult = {
  ok: boolean;
  message: string;
  enteredSecondaryMarket?: boolean;
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
  assets: Asset[];
  featuredAssetId: string | null;
  walletAddress: string | null;
  // Spendable JC balance (platform currency). From get_my_jc_balance.
  jcBalance: number;
  // Admin-set JC unit price in USDT (vault exchange + gas conversion rate).
  jcPrice: number;
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
  const [assets, setAssets] = useState(ASSETS);
  const [featuredAssetId, setFeaturedAssetId] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [jcBalance, setJcBalance] = useState(0);
  const [jcPrice, setJcPrice] = useState(1);
  const [loading, setLoading] = useState(true);
  // 「可用 USDT 餘額」極簡模式：不做充值/approve，直接輪詢 Base Sepolia 測試網上
  // 該用戶錢包地址的真實 balanceOf，每 4 秒自動刷新一次。
  const { balance } = useOnChainUsdtBalance(walletAddress);
  const refresh = useCallback(async () => {
    const clearUserAssets = () => {
      setHoldings([]);
      setTransactions([]);
      setWalletAddress(null);
      setJcBalance(0);
    };
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) {
      clearUserAssets();
      setLoading(false);
      return;
    }
    const [
      placementsResult,
      jcBalanceResult,
      ledgerResult,
      jcLedgerResult,
      positionsResult,
      platformConfigResult,
      walletResult,
      commissionLogsResult,
      allPlacementsResult,
    ] = await Promise.all([
      supabase.rpc("list_visible_private_placements"),
      // Spendable JC balance (platform currency), pending commissions excluded.
      supabase.rpc("get_my_jc_balance"),
      // USDT ledger: deposits, gas, and JC↔USDT vault movements.
      supabase
        .from("asset_ledger")
        .select("*")
        .eq("user_id", authData.user.id)
        .order("created_at", { ascending: false }),
      // JC ledger: subscriptions, secondary trades, commissions, vault.
      supabase
        .from("jc_ledger")
        .select("*")
        .eq("user_id", authData.user.id)
        .order("created_at", { ascending: false }),
      supabase.from("holdings").select("*").eq("user_id", authData.user.id),
      supabase
        .from("platform_config")
        .select("featured_asset_id,jc_price")
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
        .select("id,asset_id")
        .eq("beneficiary_id", authData.user.id),
      // Every placement's id+name so any traded asset (including delisted ones)
      // resolves to its real name in the transaction list.
      supabase.from("private_placements").select("id,name"),
    ]);
    if (!jcBalanceResult.error) {
      setJcBalance(Number(jcBalanceResult.data ?? 0));
    }
    if (!walletResult.error) {
      const address = walletResult.data?.wallet_address ?? null;
      setWalletAddress((previous) => (previous === address ? previous : address));
    }
    const userDataFailed = ledgerResult.error || positionsResult.error;
    if (userDataFailed) {
      clearUserAssets();
    } else {
      const ledger = ledgerResult.data ?? [];
      const jcLedger = jcLedgerResult.data ?? [];
      const ledgerById = new Map(
        [...ledger, ...jcLedger].map((row) => [row.id, row]),
      );
      const commissionAssetById = new Map(
        (commissionLogsResult.data ?? []).map((row) => [row.id, row.asset_id]),
      );
      const placementNameById = new Map(
        (allPlacementsResult.data ?? []).map((row) => [row.id, row.name]),
      );
      type LedgerRow = {
        id: string;
        entry_type: string;
        amount: number;
        asset_id?: string | null;
        quantity?: number | null;
        metadata?: Record<string, unknown> | null;
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
      const jcTypeMap: Record<string, Transaction["type"]> = {
        private_purchase: "buy",
        p2p_buy: "buy",
        p2p_sell: "sell",
        commission_payout: "dividend",
        refund: "dividend",
        vault_buy: "deposit",
        vault_redeem: "withdraw",
        // 贖回佇列：申請時扣 JC（withdraw），若被拒絕則退回 JC（deposit）。
        redemption_pending: "withdraw",
        redemption_refund: "deposit",
      };
      const usdtTypeMap: Record<string, Transaction["type"]> = {
        sandbox_deposit: "deposit",
        vault_redeem_jc: "deposit",
        vault_buy_jc: "withdraw",
      };
      const buildTx = (
        row: LedgerRow,
        currency: "jc" | "usdt",
        type: Transaction["type"],
      ): Transaction => {
        const meta = row.metadata ?? {};
        const resolvedAssetId = resolveAssetId(row);
        const resolvedName =
          (resolvedAssetId ? placementNameById.get(resolvedAssetId) : undefined) ??
          (resolvedAssetId ? assetDetails.get(resolvedAssetId)?.name : undefined);
        const fallbackName =
          row.entry_type === "sandbox_deposit"
            ? "測試 USDT"
            : row.entry_type.startsWith("vault") || row.entry_type.startsWith("redemption")
              ? "JC 金庫兌換"
              : "代理分潤";
        return {
          id: row.id,
          type,
          assetId: resolvedAssetId ?? undefined,
          asset: resolvedName ?? fallbackName,
          quantity: row.quantity ? Math.abs(Number(row.quantity)) : undefined,
          gross: Math.abs(Number(meta.gross ?? row.amount)),
          fee: Number(meta.fee ?? 0),
          gas: Number(meta.gas ?? 0),
          net: Number(row.amount),
          currency,
          date: new Date(row.created_at).toLocaleString(),
          createdAt: row.created_at,
          hash: row.id,
          status: "confirmed" as const,
        };
      };
      const jcTx = (jcLedger as LedgerRow[])
        .filter((row) => row.entry_type !== "commission_pending")
        .map((row) => buildTx(row, "jc", jcTypeMap[row.entry_type] ?? "dividend"));
      const usdtTx = (ledger as LedgerRow[])
        .filter((row) => usdtTypeMap[row.entry_type])
        .map((row) => buildTx(row, "usdt", usdtTypeMap[row.entry_type]));
      const nextTransactions = [...jcTx, ...usdtTx].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      );
      setTransactions((previous) => keepStable(previous, nextTransactions));
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
    setJcPrice(Number(platformConfig?.jc_price ?? 1) || 1);
    const placements = placementsResult.data;
    if (placements) {
      const nextAssets = placements.map(
        (row: NonNullable<typeof placementsResult.data>[number]) => {
        const details = assetDetails.get(row.id) ?? ASSETS[0];
        return {
          ...details,
          id: row.id,
          name: row.name,
          location: row.location,
          address: row.address,
          image: row.images?.[0] ?? row.image,
          images: row.images?.length ? row.images : [row.image],
          information: row.information ?? "",
          translations: row.translations ?? {},
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
          isAeToken: row.is_ae_token ?? false,
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
        };
      });
      setAssets((previous) => keepStable(previous, nextAssets));
    }
    setLoading(false);
  }, []);
  useVisiblePolling(refresh, 1_000, true);
  useEffect(() => {
    const syncAssets = () => void refresh();
    window.addEventListener("platform-assets-updated", syncAssets);
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
      void refresh();
    });
    return () => {
      window.removeEventListener("platform-assets-updated", syncAssets);
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
    const { data: settlement, error } = await supabase.rpc(
      "execute_private_purchase",
      {
        asset_key: assetId,
        trade_quantity: quantity,
        request_key: crypto.randomUUID(),
      },
    );
    if (error) {
      reportMonitorEventInBackground({
        type: "trade_result",
        success: false,
        message: error.message,
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
        "insufficient usdt for gas": "USDT 餘額不足以支付 Gas 費",
        "jc price unavailable": "JC 單價暫時無法取得，請稍後再試",
        "price update cooldown": "此標的剛完成調價，一分鐘內暫停新增掛單",
      };
      return {
        ok: false,
        message: messages[error.message] ?? "交易未完成，請稍後再試",
      };
    }

    await refresh();
    const result = settlement as {
      gross?: number;
      gas_fee?: number;
      total?: number;
      entered_secondary_market?: boolean;
    } | null;
    const enteredSecondaryMarket = Boolean(result?.entered_secondary_market);
    reportMonitorEventInBackground({ type: "trade_result", success: true });
    if (enteredSecondaryMarket) {
      reportMonitorEventInBackground({
        type: "private_sale_complete",
        placementId: assetId,
      });
    }
    const grossJc = Number(result?.gross ?? 0).toLocaleString(undefined, {
      maximumFractionDigits: 6,
    });
    const gasUsdt = Number(result?.gas_fee ?? 0).toFixed(6);
    return {
      ok: true,
      message: enteredSecondaryMarket
        ? `最後一份認購成功，本金 ${grossJc} JC，Gas ${gasUsdt} USDT，標的已進入二級市場`
        : `認購成功，本金 ${grossJc} JC，Gas ${gasUsdt} USDT`,
      enteredSecondaryMarket,
    };
  };
  return (
    <PlatformContext.Provider
      value={{
        balance,
        holdings,
        transactions,
        assets,
        featuredAssetId,
        walletAddress,
        jcBalance,
        jcPrice,
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
  ["ar", "العربي��"],
  ["hi", "हिन्दी"],
] as const;
export type Lang = (typeof LANGUAGES)[number][0];
type InterfaceCopyKey = "welcome" | "platformAnnouncements" | "viewMore" | "announcementHistory" | "close" | "appearance" | "displayMode" | "accentColor" | "agencyRelationship" | "currentRole" | "applyAgency" | "searchSubscribe" | "searchMarket" | "accountInformation" | "email" | "userId" | "nickname" | "saveChanges" | "saving" | "signOut" | "signingOut" | "transactionType" | "asset" | "amount" | "time" | "ledgerId";
const interfaceCopyKeys: InterfaceCopyKey[] = ["welcome", "platformAnnouncements", "viewMore", "announcementHistory", "close", "appearance", "displayMode", "accentColor", "agencyRelationship", "currentRole", "applyAgency"];
const interfaceCopyRows: Record<Lang, string[]> = {
  "zh-TW": ["歡迎登入 RWMT，{name}", "平台公告", "查看更多", "歷史公告", "關閉", "外觀設定", "顯示模式", "主題顏色", "代理與推廣關係", "目前角色", "申請成為代理／總代理"],
  "zh-CN": ["欢迎登录 RWMT，{name}", "平台公告", "查看更多", "历史公告", "关闭", "外观设置", "显示模式", "主题颜色", "代理与推广关系", "当前角色", "申请成为代理／总代理"],
  en: ["Welcome to RWMT, {name}", "Platform announcements", "View more", "Announcement history", "Close", "Appearance", "Display mode", "Accent color", "Agency and referral relationship", "Current role", "Apply as agent / general agent"],
  ja: ["RWMTへようこそ、{name}", "プラットフォームのお知らせ", "もっと見る", "お知らせ履歴", "閉じる", "外観設定", "表示モード", "アクセントカラー", "代理店・紹介関係", "現在の役割", "代理店／総代理店に申請"],
  ko: ["RWMT에 오신 것을 환��합니다, {name}", "플랫폼 공지", "더 보기", "공지 내역", "닫기", "화면 설정", "표시 모드", "강조 색상", "대리점 및 추천 관계", "현재 역할", "대리점／총대리점 신청"],
  th: ["ยินดีต้อนรับสู่ RWMT, {name}", "ประกาศแพลตฟอร์ม", "ดูเพิ่มเติม", "ประวัติประกาศ", "ปิด", "ลักษณะที��ปรากฏ", "โหมดการแสดงผล", "สีเน้น", "ความสัมพันธ์ตัวแทนและการแนะนำ", "บทบาทปัจจุบัน", "สมัครเป็นตัวแทน / ตัวแทนทั่วไป"],
  vi: ["Chào mừng đến RWMT, {name}", "Thông báo nền tảng", "Xem thêm", "Lịch sử thông báo", "Đóng", "Giao diện", "Chế độ hiển thị", "Màu nhấn", "Quan hệ đại lý và giới thiệu", "Vai trò hiện tại", "Đăng ký làm đại lý / tổng đại lý"],
  id: ["Selamat datang di RWMT, {name}", "Pengumuman platform", "Lihat lainnya", "Riwayat pengumuman", "Tutup", "Tampilan", "Mode tampilan", "Warna aksen", "Hubungan agen dan referensi", "Peran saat ini", "Daftar sebagai agen / agen umum"],
  ms: ["Selamat datang ke RWMT, {name}", "Pengumuman platform", "Lihat lagi", "Sejarah pengumuman", "Tutup", "Penampilan", "Mod paparan", "Warna aksen", "Hubungan ejen dan rujukan", "Peranan semasa", "Mohon sebagai ejen / ejen am"],
  es: ["Te damos la bienvenida a RWMT, {name}", "Anuncios de la plataforma", "Ver más", "Historial de anuncios", "Cerrar", "Apariencia", "Modo de visualización", "Color de acento", "Relación de agencia y referidos", "Rol actual", "Solicitar ser agente / agente general"],
  fr: ["Bienvenue sur RWMT, {name}", "Annonces de la plateforme", "Voir plus", "Historique des annonces", "Fermer", "Apparence", "Mode d’affichage", "Couleur d’accent", "Relation d���agence et de parrainage", "Rôle actuel", "Devenir agent / agent général"],
  de: ["Willkommen bei RWMT, {name}", "Plattformankündigungen", "Mehr anzeigen", "Ankündigungsverlauf", "Schließen", "Darstellung", "Anzeigemodus", "Akzentfarbe", "Agentur- und Empfehlungsbeziehung", "Aktuelle Rolle", "Als Agent / Generalagent bewerben"],
  pt: ["Boas-vindas à RWMT, {name}", "Anúncios da plataforma", "Ver mais", "Histórico de anúncios", "Fechar", "Aparência", "Modo de exibição", "Cor de destaque", "Relação de agência e indicação", "Função atual", "Candidatar-se a agente / agente geral"],
  ru: ["Добро пожаловать в RWMT, {name}", "Объявления платформы", "Показать больше", "История объявлений", "Закрыть", "Оформление", "Режим отображения", "Акцентный цвет", "Агентские и реферальные связи", "Текущая роль", "Стать агентом / генеральным агентом"],
  ar: ["مرحبًا بك في RWMT، {name}", "إعلانات المنصة", "عرض المزيد", "سجل الإعلانات", "إغلاق", "المظهر", "وضع العرض", "لون التمييز", "علاقة الوكالة والإحالة", "الدور الحالي", "التقدم كوكيل / وكيل عام"],
  hi: ["RWMT में आपका स्वागत है, {name}", "प्लेटफ़ॉर्म घोषणाएँ", "और देखें", "घोषणा इतिहास", "बंद करें", "दिखावट", "डिस्प्ले मोड", "एक्सेंट रंग", "एजेंसी और रेफ़रल संबंध", "���र्तमान भूमिका", "एजेंट / जनरल एजेंट के लिए आवेदन करें"],
};
const screenCopy: Partial<Record<Lang, Partial<Record<InterfaceCopyKey, string>>>> = {
  "zh-TW": { platformAnnouncements: "平台公告", appearance: "外觀設定", searchSubscribe: "搜尋認購標的物", searchMarket: "搜尋二級市場標的物", accountInformation: "帳號資訊", email: "電子郵件", userId: "使用者 ID", nickname: "暱稱", saveChanges: "儲存變更", saving: "儲存中…", signOut: "登出帳號", signingOut: "登出中…", transactionType: "類型", asset: "資產", amount: "金額", time: "時間", ledgerId: "流水 ID" },
  "zh-CN": { searchSubscribe: "搜索认购标的物", searchMarket: "搜索二级市场标的物", accountInformation: "账户信息", email: "电子邮件", userId: "用户 ID", nickname: "昵称", saveChanges: "保存更改", saving: "保存中…", signOut: "退出登录", signingOut: "正在退出…", transactionType: "类型", asset: "资产", amount: "金额", time: "时间", ledgerId: "流水 ID" },
  en: { searchSubscribe: "Search subscription assets", searchMarket: "Search secondary-market assets", accountInformation: "Account information", email: "Email", userId: "User ID", nickname: "Nickname", saveChanges: "Save changes", saving: "Saving…", signOut: "Sign out", signingOut: "Signing out…", transactionType: "Type", asset: "Asset", amount: "Amount", time: "Time", ledgerId: "Ledger ID" },
  ja: { searchSubscribe: "申込対象資産を検索", searchMarket: "二次市場の資産を検索", accountInformation: "アカウント情報", email: "メールアドレス", userId: "ユーザー ID", nickname: "ニックネーム", saveChanges: "変更を保存", saving: "保存中…", signOut: "ログアウト", signingOut: "ログアウト中…", transactionType: "種類", asset: "資産", amount: "金額", time: "日時", ledgerId: "取引 ID" },
  ko: { searchSubscribe: "청약 자산 검색", searchMarket: "2차 시장 자산 검색", accountInformation: "계정 정보", email: "이메일", userId: "사용자 ID", nickname: "닉네임", saveChanges: "변���사항 저장", saving: "저장 중…", signOut: "로그아웃", signingOut: "로그아웃 중…", transactionType: "유형", asset: "자산", amount: "금액", time: "시간", ledgerId: "거래 ID" },
};
export const interfaceText = (language: Lang, key: InterfaceCopyKey, values?: Record<string, string>) => {
  let text = screenCopy[language]?.[key] ?? screenCopy.en?.[key] ?? interfaceCopyRows[language]?.[interfaceCopyKeys.indexOf(key)] ?? interfaceCopyRows.en[interfaceCopyKeys.indexOf(key)] ?? key;
  for (const [name, value] of Object.entries(values ?? {})) text = text.replace(`{${name}}`, value);
  return text;
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
    "提領",
    "持倉資產",
    "近期交易",
    "模擬鏈上",
    "確認交易",
    "取消",
    "份額",
    "每份價格",
    "成交總額",
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
    "ブロックチェーン検証済み不動産を探索",
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
    "블록체인 검증 부���산 토큰 탐색",
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
    "주문장",
    "자산 상세",
  ],
  th: [
    "หน้าหลัก",
    "ตลาดรอง",
    "กระเป��า",
    "ตั้งค่า",
    "สินทรัพย์แนะนำ",
    "สำรวจอสังหาฯ โทเคนที่ตรวจสอบแล้ว",
    "ประกาศ",
    "��ูรายละเอียด",
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
    "ยกเลิก",
    "หน่วย",
    "ราคาต่อหน่วย",
    "ยอดรวม",
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
    "Đã xác minh KYC",
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
    "Объявления",
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
    "Доли",
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
    "تم الت��قق من KYC",
    "إيداع",
    "سحب",
    "المقتنيات",
    "المعاملات الأخيرة",
    "محاكاة على السلسلة",
    "تأكيد",
    "إلغاء",
    "الوحدات",
    "س��ر الوحدة",
    "المبلغ الإجمالي",
    "دفت�� الطلبات",
    "تفاصيل الأصل",
  ],
  hi: [
    "होम",
    "द्वितीयक बाज़ार",
    "वॉ���ेट",
    "सेटिंग्स",
    "विशेष एसेट",
    "सत्यापित टोकन रियल एस्टेट खोजें",
    "घोषणाएँ",
    "विवरण देखें",
    "खरीदें",
    "बेचें",
    "उपलब्�� बैलेंस",
    "ट्र���ड इतिहास",
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
    "ऑर्डर बुक",
    "एसेट विवरण",
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
    "所有交易以 USDT 結算；買入免平台費，賣出收成交額 1% + 1 USDT。本平台目前為完整前端模擬，不會送出真實鏈上交易。",
  more: "更多項目",
  valuation: "總資產估值",
  expectedApy: "預計 APY",
  verification: "資產驗證",
  fullAddress: "完整地址",
  propertyHistory: "物件歷史",
  nearbyPricing: "周邊定價",
  advantages: "投資優勢",
  buyFee: "買入平台手續費：0 USDT+Gas Fee",
  liveMatching: "USDT 即時撮合 · 所有鏈上狀態均為前端模擬",
  all: "全部",
  rising: "上漲",
  falling: "下跌",
  available: "可購",
  backMarket: "返回市場",
  candlestick: "K 線圖",
  asks: "賣單",
  bids: "買單",
  owned: "持有份額",
  totalAssets: "總��產價值",
  networkFee: "網路手續費",
  status: "狀態",
  confirmed: "已確認",
  preferences: "偏好設定",
  notifications: "通知",
  changeLanguage: "變更整個介面語言",
  identity: "身分驗證",
  verifiedDate: "驗證日期",
  level: "等級",
  price: "價格通知",
  dividend: "收益分配通知",
  listings: "新項目通知",
  receiveAlerts: "接收帳戶與資產通知",
  investor: "投資者",
  subscribeEyebrow: "初級市場",
  subscribeTitle: "認購",
  subscribing: "認購中",
  soldOut: "已售罄",
  ended: "已結束",
  subscriptionUnitPrice: "認購單價",
  subscribeNow: "立即認購",
  unavailableSubscribe: "目前不可認購",
  noSubscriptions: "目前沒有可顯示的非二級市��標的。",
  availableBalance: "可用餘額",
  subscriptionUnits: "認購份額",
  subscriptionTotal: "認購總額",
  confirmSubscription: "確認認購",
  agentCenter: "代理中心",
  dateRange: "時間範圍",
};
const extraEn: Record<string, string> = {
  announcement:
    "All trades settle in USDT. Buying has no platform fee; selling costs 1% of the gross amount + 1 USDT. This platform is a complete front-end simulation and sends no real on-chain transaction.",
  more: "More assets",
  valuation: "Total asset valuation",
  expectedApy: "Expected APY",
  verification: "Asset verification",
  fullAddress: "Full address",
  propertyHistory: "Property history",
  nearbyPricing: "Nearby pricing",
  advantages: "Investment advantages",
  buyFee: "Buy platform fee: 0 USDT",
  liveMatching: "Live USDT matching · All on-chain states are simulated",
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
      "すべての取引はUSDTで��済されます。購入手数料は無料、売却手数料は総額の1% + 1 USDTです。現在は完全なフロントエンドシミュレーションです。",
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
    available: "購���可能",
    backMarket: "市場に戻る",
    candlestick: "ローソク足チャート",
    asks: "売り注文",
    bids: "買い注文",
    owned: "保有口数",
    totalAssets: "総資産価値",
    status: "ステータス",
    confirmed: "確認済み",
    preferences: "環境設��",
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
    noSubscriptions: "現在表示できる申込���象資産はありません。",
    availableBalance: "利用可能残高",
    subscriptionUnits: "申込口数",
    subscriptionTotal: "申込合計",
    confirmSubscription: "申込み��確定",
  },
  ko: {
    more: "더 많은 자산",
    announcement:
      "��든 거래는 USDT로 결제됩니다. 매수 수수료는 없으며 매도 수수료는 총액의 1% + 1 USDT입니다. 현재 완전한 프런트엔드 시뮬레이션입니다.",
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
    preferences: "환경설정",
    notifications: "알림",
    changeLanguage: "전체 인터페이스 언어 변경",
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
    availableBalance: "사용 가능 잔액",
    subscriptionUnits: "청약 수량",
    subscriptionTotal: "청약 총액",
    confirmSubscription: "청약 확인",
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
    "複製地址",
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
    "投资者",
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
    "レベル",
    "価格通知",
    "配当通知",
    "新規上��通知",
    "口座と資産の通知を受信",
    "投資家",
    "総資産価値",
    "ネットワーク手数料",
    "状態",
    "確認済み",
    "利用可能",
    "数量",
    "日付",
    "取引ハッシュ",
    "USDTを入金",
    "USDTを出金",
    "金額",
    "送信",
    "アドレスをコピー",
  ],
  ko: [
    "환경 설정",
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
    "총 자�� 가치",
    "네트워크 수수료",
    "상태",
    "확인됨",
    "사용 가능",
    "수량",
    "날짜",
    "거래 해시",
    "USDT 입금",
    "USDT 출금",
    "금액",
    "제출",
    "주소 복사",
  ],
  th: [
    "การตั้งค่า",
    "การแจ้งเตือน",
    "เปลี่ยนภาษาของอินเทอร์เฟซทั้งหมด",
    "การยืนยันตัวตน",
    "วันที่ยืนยัน",
    "ระดับ",
    "แจ้งเตือนราคา",
    "แจ้งเตือนเงินปันผล",
    "แจ้งเตือนรายการใหม่",
    "รับการแจ้งเตือนบัญชีและสินทรัพย์",
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
    "Thông báo",
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
    "Vérification d’identité",
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
    "Data de verificação",
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
    "Подтвер��дено",
    "Доступно",
    "Количество",
    "Дата",
    "Хэш транзакции",
    "Пополнить USDT",
    "Вывести USDT",
    "Сумма",
    "Отправить",
    "Копировать а��рес",
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
    "تنبيهات الإدراج الجديد",
    "تلقي إشعارات الحساب والأصول",
    "مستثمر",
    "إجمالي قيمة الأصول",
    "رسوم الشبكة",
    "الحالة",
    "مؤك��",
    "متاح",
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
    "सूचनाएँ",
    "पूरे इंटरफ़ेस की भाषा ब��लें",
    "पहचान सत्यापन",
    "सत्यापन तिथि",
    "स्तर",
    "मूल्य सूचनाएँ",
    "लाभांश सूचनाएँ",
    "नई लिस्टिंग सूचनाएँ",
    "खाता और एसेट सूचनाएँ प्राप्त करें",
    "निवेशक",
    "कुल एसेट मूल्य",
    "नेटवर���क शुल्क",
    "स्थिति",
    "पुष्टि हुई",
    "उपलब्ध",
    "मात्रा",
    "तिथि",
    "लेनदेन हैश",
    "USDT ज���ा करें",
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
    "新加坡 Marina Bay 景观住宅",
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
    "シンガポール・マリーナベイ眺望住宅",
    "ロンドン・���ナリーワーフ オフィス",
  ],
  ko: [
    "멜버른 사우스뱅크 리버뷰 주거",
    "도쿄 시부야 상업 빌딩",
    "싱가포르 마리나베이 전망 주거",
    "런던 카나리워프 오피스",
  ],
  th: [
    "ที่พักวิวแม่น้ำเมลเบิร์นเซาท์แบงก์",
    "อาคารพาณิชย์โตเกียวชิบูย่า",
    "ที่พักวิวมารีนาเบย์สิงคโปร์",
    "สำนักงานลอนดอนคานารีวอร์ฟ",
  ],
  vi: [
    "Căn hộ hướng sông Melbourne Southbank",
    "Tòa nhà thương mại Tokyo Shibuya",
    "Căn hộ Marina Bay Singapore",
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
    "سكن ملبورن ساوث بانك بإطلالة على النهر",
    "مبنى طوكيو شيبويا التجاري",
    "سكن سنغافورة مارينا باي",
    "مكتب لندن كناري وارف",
  ],
  hi: [
    "मेलबर्न साउथबैंक रिवर व्यू निवास",
    "टोक्यो शिबुय��� वाणिज्यिक भवन",
    "सिंगापुर मरीना बे निवास",
    "लंदन कैनरी व्हार्फ कार्यालय",
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
  typeof value === "string" && (!value.trim() || value.includes("�"));

const safeLocalizedText = (preferred: unknown, fallback: unknown, key: string) => {
  if (typeof preferred === "string" && !hasInvalidText(preferred)) return preferred;
  if (typeof fallback === "string" && !hasInvalidText(fallback)) return fallback;
  return key;
};

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Lang>("zh-TW");
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("lang") as Lang;
    if (LANGUAGES.some((x) => x[0] === q)) setLanguageState(q);
  }, []);
  const setLanguage = useCallback((l: Lang) => {
    setLanguageState(l);
    try {
      const u = new URL(location.href);
      if (u.searchParams.get("lang") === l) return;
      u.searchParams.set("lang", l);
      history.replaceState(null, "", u);
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
          : simpleExtra[language]?.[k] ??
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
