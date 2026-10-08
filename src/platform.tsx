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
      "灣區豪宅中位價：3.9M USDT",
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
    ] = await Promise.all([
      supabase.rpc("list_visible_private_placements"),
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
        .select("id,asset_id")
        .eq("beneficiary_id", authData.user.id),
      // Every placement's id+name so any traded asset (including delisted ones)
      // resolves to its real name in the transaction list.
      supabase
        .from("private_placements")
        .select("id,name,updated_at,is_ae_token")
        .gte("updated_at", CONTRACT_INFO_VISIBLE_AFTER),
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
      const commissionAssetById = new Map(
        (commissionLogsResult.data ?? []).map((row) => [row.id, row.asset_id]),
      );
      const placementNameById = new Map(
        (allPlacementsResult.data ?? []).map((row) => [row.id, row.name]),
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
            ? "測試 USDT"
            : row.entry_type === "p2p_listing_fee"
              ? "掛單手續費"
              : row.entry_type === "refund"
                ? "認購退款"
                : row.entry_type === "admin_payout"
                  ? "管理員入帳"
                  : row.entry_type.startsWith("vault") ||
                      row.entry_type.startsWith("redemption")
                    ? "JC 金庫兌換"
                    : "代理分潤";
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
          date: new Date(row.created_at).toLocaleString(),
          createdAt: row.created_at,
          hash: row.id,
          status: "confirmed" as const,
        };
      };
      const jcTx = (jcLedger as LedgerRow[])
        // 分潤紀錄另列；個人交易只顯示共用的交易 entry types。
        .filter((row) => isUserTransactionEntry(row.entry_type))
        .map((row) => buildTx(row, "jc", jcTypeMap[row.entry_type] ?? "dividend"));
      const usdtTx = (ledger as LedgerRow[])
        .filter((row) => usdtTypeMap[row.entry_type])
        .map((row) => buildTx(row, "usdt", usdtTypeMap[row.entry_type]));
      const nextTransactions = [...jcTx, ...usdtTx].sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      );
      setTransactions((previous) => keepStable(previous, nextTransactions));
      // 分潤紀錄：只收「已入帳」的推廣分潤——commission_payout（實際派發）與
      // commission_reversal（沖正校正，可正可負）。尚未派發的 commission_pending
      // 屬內部應計、不重複顯示，避免與後續派發列看起來像重複入帳。
      const commissionTx = (jcLedger as LedgerRow[])
        .filter(
          (row) =>
            row.entry_type === "commission_payout" ||
            row.entry_type === "commission_reversal",
        )
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
      // 才會觸發。reconcilePendingSettlements 內建 in-flight 保護，重複觸發安全。
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
    // 鏈上代幣門檻：RWA 標的的一級認購／二級成交都需要該標的在 RWA Factory
    // 部署過專屬份額代幣（token_address），否則鏈上結算無份額可發、必然失敗，
    // 且會造成「站內已扣 JC、鏈上沒發幣」的破口。因此未部署代幣的 RWA 標的直接
    // 在扣款前擋下認購。AE 標的（isAeToken）走 AE 代幣，不需要此門檻。
    const targetAsset = assets.find((item) => item.id === assetId);
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
        "insufficient jc": "JC 餘額���足，請先至錢包用 USDT 兌換 JC",
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
        ? `認購預留已建立：${grossJc} JC；待鏈上交割與正式帳本確認後，標的才會進入二級市場。`
        : `認購預留已建立：${grossJc} JC；等待鏈上交割與正式帳本確認。`,
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
  vi: ["Chào mừng đến RWMT, {name}", "Thông báo nền tảng", "Xem thêm", "Lịch sử thông báo", "Đóng", "Giao diện", "Chế độ hiển thị", "Màu nhấn", "Quan hệ đại lý và giới thiệu", "Vai trò hiện tại", "Đăng ký làm đại lý / tổng đại lý"],
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
  ja: { searchSubscribe: "申込対象資産を検索", searchMarket: "二次市場の資産を検索", accountInformation: "アカウント情報", email: "メールアドレス", userId: "ユーザー ID", nickname: "ニックネーム", saveChanges: "変更を保存", saving: "保存中…", signOut: "ログアウト", signingOut: "ログアウト中…", transactionType: "種類", asset: "資産", amount: "金額", time: "日時", ledgerId: "取引 ID" },
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
  ru: { transactionType: "Тип", asset: "Актив", unitPrice: "Цена за единицу", quantity: "Количество", amount: "Сумма", time: "Время", ledgerId: "ID записи" },
  ar: { transactionType: "النوع", asset: "الأصل", unitPrice: "سعر الوحدة", quantity: "الكمية", amount: "المبلغ", time: "الوقت", ledgerId: "معرّف السجل" },
  hi: { transactionType: "प्रकार", asset: "संपत्ति", unitPrice: "इकाई मूल्य", quantity: "मात्रा", amount: "राशि", time: "समय", ledgerId: "लेजर ID" },
};

export const interfaceText = (language: Lang, key: InterfaceCopyKey, values?: Record<string, string>) => {
  let text = screenCopy[language]?.[key] ?? tableHeadingCopy[language]?.[key] ?? screenCopy.en?.[key] ?? interfaceCopyRows[language]?.[interfaceCopyKeys.indexOf(key)] ?? interfaceCopyRows.en[interfaceCopyKeys.indexOf(key)] ?? key;
  for (const [name, value] of Object.entries(values ?? {})) text = text.replace(`{${name}}`, value);
  return text;
};

const localizedUiCopy: Partial<Record<Lang, Record<string, string>>> = {
  "zh-TW": {
    "보유 자산 평가액:": "持倉市值：", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "鏈上餘額暫時無法讀取，總額不會以 0 代替。", "사용 가능 JC": "可用 JC", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "可用 USDT（鏈上餘額，自動更新）", "JC 금고 교환": "JC 金庫兌換", "지갑 생성 중…": "錢包生成中…", "자금 출금": "提領資金", "현재 등록된 자산이 없습니다.": "目前沒有上架的標的", "청약 단가": "認購單價", "2차 시장 실시간 등락": "二級市場即時漲跌", "2차 시장에서 구매": "進入二級市場買入", "지분 구매": "購買份額", "개인 간 거래 시장": "個人間交易市場", "조건에 맞는 2차 시장 자산이 없습니다.": "目前沒有符合條件的二級市場標的", "현재가(최근 체결가)": "現價（最新成交價）", "청약 기준가": "認購原價", "참고 가격(JC)": "參考價格（JC）", "시장으로 이동": "進入市場",
  },
  "zh-CN": {
    "보유 자산 평가액:": "持仓市值：", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "链上余额暂时无法读取，总额不会以 0 代替。", "사용 가능 JC": "可用 JC", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "可用 USDT（链上余额，自动更新）", "JC 금고 교환": "JC 金库兑换", "지갑 생성 중…": "钱包生成中…", "자금 출금": "提取资金", "현재 등록된 자산이 없습니다.": "目前没有上架的标的", "청약 단가": "认购单价", "2차 시장 실시간 등락": "二级市场实时涨跌", "2차 시장에서 구매": "进入二级市场买入", "지분 구매": "购买份额", "개인 간 거래 시장": "个人间交易市场", "조건에 맞는 2차 시장 자산이 없습니다.": "目前没有符合条件的二级市场标的", "현재가(최근 체결가)": "现价（最新成交价）", "청약 기준가": "认购原价", "참고 가격(JC)": "参考价格（JC）", "시장으로 이동": "进入市场",
  },
  en: {
    "보유 자산 평가액:": "Holdings valuation:", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "On-chain balances are temporarily unavailable. The total will not be shown as zero.", "사용 가능 JC": "Available JC", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "Available USDT (on-chain balance, updates automatically)", "JC 금고 교환": "JC vault exchange", "지갑 생성 중…": "Creating wallet…", "자금 출금": "Withdraw funds", "현재 등록된 자산이 없습니다.": "There are no listed assets yet", "청약 단가": "Subscription price", "2차 시장 실시간 등락": "Live secondary-market change", "2차 시장에서 구매": "Buy on secondary market", "지분 구매": "Buy shares", "개인 간 거래 시장": "Peer-to-peer market", "조건에 맞는 2차 시장 자산이 없습니다.": "No secondary-market assets match these filters", "현재가(최근 체결가)": "Current price (latest trade)", "청약 기준가": "Subscription price", "참고 가격(JC)": "Reference price (JC)", "시장으로 이동": "Go to market",
  },
  ja: {
    "보유 자산 평가액:": "保有資産の評価額：", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "オンチェーン残高を一時的に読み込めません。合計を0として表示することはありません。", "사용 가능 JC": "利用可能なJC", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "利用可能なUSDT（オンチェーン残高・自動更新）", "JC 금고 교환": "JC金庫交換", "지갑 생성 중…": "ウォレットを作成中…", "자금 출금": "資金を出金", "현재 등록된 자산이 없습니다.": "掲載中の資産はありません", "청약 단가": "申込単価", "2차 시장 실시간 등락": "二次市場のリアルタイム変動", "2차 시장에서 구매": "二次市場で購入", "지분 구매": "持分を購入", "개인 간 거래 시장": "個人間取引市場", "조건에 맞는 2차 시장 자산이 없습니다.": "条件に一致する二次市場資産はありません", "현재가(최근 체결가)": "現在価格（直近約定価格）", "청약 기준가": "申込基準価格", "참고 가격(JC)": "参考価格（JC）", "시장으로 이동": "市場へ移動",
  },
  ko: {
    "보유 자산 평가액:": "보유 자산 평가액:", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.", "사용 가능 JC": "사용 가능 JC", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "사용 가능 USDT (온체인 잔액, 자동 업데이트)", "JC 금고 교환": "JC 금고 교환", "지갑 생성 중…": "지갑 생성 중…", "자금 출금": "자금 출금", "현재 등록된 자산이 없습니다.": "현재 등록된 자산이 없습니다.", "청약 단가": "청약 단가", "2차 시장 실시간 등락": "2차 시장 실시간 등락", "2차 시장에서 구매": "2차 시장에서 구매", "지분 구매": "지분 구매", "개인 간 거래 시장": "개인 간 거래 시장", "조건에 맞는 2차 시장 자산이 없습니다.": "조건에 맞는 2차 시장 자산이 없습니다.", "현재가(최근 체결가)": "현재가(최근 체결가)", "청약 기준가": "청약 기준가", "참고 가격(JC)": "참고 가격(JC)", "시장으로 이동": "시장으로 이동",
  },
  th: {
    "보유 자산 평가액:": "มูลค่าประเมินสินทรัพย์ที่ถือ:", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "ไม่สามารถโหลดสินทรัพย์คงเหลือบนเชนได้ชั่วคราว โดยจะไม่แสดงยอดรวมเป็นศูนย์", "사용 가능 JC": "JC ที่ใช้ได้", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "USDT ที่ใช้ได้ (ยอดบนเชน อัปเดตอัตโนมัติ)", "JC 금고 교환": "แลกเปลี่ยน JC กับคลัง", "지갑 생성 중…": "กำลังสร้างกระเป๋า…", "자금 출금": "ถอนเงิน", "현재 등록된 자산이 없습니다.": "ยังไม่มีสินทรัพย์ที่ลงรายการ", "청약 단가": "ราคาจองซื้อต่อหน่วย", "2차 시장 실시간 등락": "การเปลี่ยนแปลงตลาดรองแบบเรียลไทม์", "2차 시장에서 구매": "ซื้อในตลาดรอง", "지분 구매": "ซื้อหน่วยลงทุน", "개인 간 거래 시장": "ตลาดซื้อขายระหว่างบุคคล", "조건에 맞는 2차 시장 자산이 없습니다.": "ไม่มีสินทรัพย์ตลาดรองที่ตรงกับตัวกรอง", "현재가(최근 체결가)": "ราคาปัจจุบัน (รายการล่าสุด)", "청약 기준가": "ราคาอ้างอิงการจองซื้อ", "참고 가격(JC)": "ราคาอ้างอิง (JC)", "시장으로 이동": "ไปยังตลาด",
  },
  vi: {
    "보유 자산 평가액:": "Giá trị danh mục đang nắm giữ:", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "Tạm thời không thể tải số dư on-chain. Tổng tài sản sẽ không bị hiển thị thành 0.", "사용 가능 JC": "JC khả dụng", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "USDT khả dụng (số dư on-chain, tự động cập nhật)", "JC 금고 교환": "Đổi JC tại kho", "지갑 생성 중…": "Đang tạo ví…", "자금 출금": "Rút tiền", "현재 등록된 자산이 없습니다.": "Chưa có tài sản nào được niêm yết", "청약 단가": "Giá đăng ký mỗi đơn vị", "2차 시장 실시간 등락": "Biến động thị trường thứ cấp theo thời gian thực", "2차 시장에서 구매": "Mua trên thị trường thứ cấp", "지분 구매": "Mua phần sở hữu", "개인 간 거래 시장": "Thị trường giao dịch ngang hàng", "조건에 맞는 2차 시장 자산이 없습니다.": "Không có tài sản thị trường thứ cấp phù hợp", "현재가(최근 체결가)": "Giá hiện tại (giao dịch gần nhất)", "청약 기준가": "Giá đăng ký", "참고 가격(JC)": "Giá tham khảo (JC)", "시장으로 이동": "Đi đến thị trường",
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
    "보유 자산 평가액:": "Valeur des positions :", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "Le solde on-chain est temporairement indisponible. Le total ne sera pas affiché comme égal à zéro.", "사용 가능 JC": "JC disponible", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "USDT disponible (solde on-chain, mise à jour automatique)", "JC 금고 교환": "Échange JC de la trésorerie", "지갑 생성 중…": "Création du portefeuille…", "자금 출금": "Retirer des fonds", "현재 등록된 자산이 없습니다.": "Aucun actif n’est encore publié", "청약 단가": "Prix de souscription", "2차 시장 실시간 등락": "Variation en direct du marché secondaire", "2차 시장에서 구매": "Acheter sur le marché secondaire", "지분 구매": "Acheter des parts", "개인 간 거래 시장": "Marché entre particuliers", "조건에 맞는 2차 시장 자산이 없습니다.": "Aucun actif du marché secondaire ne correspond", "현재가(최근 체결가)": "Cours actuel (dernière transaction)", "청약 기준가": "Prix de souscription", "참고 가격(JC)": "Prix de référence (JC)", "시장으로 이동": "Accéder au marché",
  },
  de: {
    "보유 자산 평가액:": "Bewertung der Bestände:", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "Der On-Chain-Kontostand ist vorübergehend nicht verfügbar. Der Gesamtwert wird nicht als null angezeigt.", "사용 가능 JC": "Verfügbares JC", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "Verfügbares USDT (On-Chain-Guthaben, automatische Aktualisierung)", "JC 금고 교환": "JC-Tresortausch", "지갑 생성 중…": "Wallet wird erstellt…", "자금 출금": "Geld auszahlen", "현재 등록된 자산이 없습니다.": "Derzeit sind keine Assets gelistet", "청약 단가": "Zeichnungspreis", "2차 시장 실시간 등락": "Live-Veränderung am Sekundärmarkt", "2차 시장에서 구매": "Am Sekundärmarkt kaufen", "지분 구매": "Anteile kaufen", "개인 간 거래 시장": "Peer-to-Peer-Markt", "조건에 맞는 2차 시장 자산이 없습니다.": "Keine passenden Sekundärmarkt-Assets", "현재가(최근 체결가)": "Aktueller Preis (letzter Handel)", "청약 기준가": "Zeichnungspreis", "참고 가격(JC)": "Referenzpreis (JC)", "시장으로 이동": "Zum Markt",
  },
  pt: {
    "보유 자산 평가액:": "Avaliação dos ativos detidos:", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "O saldo on-chain está temporariamente indisponível. O total não será apresentado como zero.", "사용 가능 JC": "JC disponível", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "USDT disponível (saldo on-chain, atualização automática)", "JC 금고 교환": "Troca de JC da tesouraria", "지갑 생성 중…": "A criar carteira…", "자금 출금": "Levantar fundos", "현재 등록된 자산이 없습니다.": "Ainda não existem ativos publicados", "청약 단가": "Preço de subscrição", "2차 시장 실시간 등락": "Variação em tempo real do mercado secundário", "2차 시장에서 구매": "Comprar no mercado secundário", "지분 구매": "Comprar unidades", "개인 간 거래 시장": "Mercado entre utilizadores", "조건에 맞는 2차 시장 자산이 없습니다.": "Não há ativos secundários correspondentes", "현재가(최근 체결가)": "Preço atual (última negociação)", "청약 기준가": "Preço de subscrição", "참고 가격(JC)": "Preço de referência (JC)", "시장으로 이동": "Ir para o mercado",
  },
  ru: {
    "보유 자산 평가액:": "Оценка активов в портфеле:", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "Баланс в блокчейне временно недоступен. Общая сумма не будет показ��на как ноль.", "사용 가능 JC": "Доступно JC", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "Доступно USDT (баланс в блокчейне, автообновление)", "JC 금고 교환": "Обмен JC в казначействе", "지갑 생성 중…": "Создание кошелька…", "자금 출금": "Вывести средства", "현재 등록된 자산이 없습니다.": "Пока нет активов в листинге", "청약 단가": "Цена подписки", "2차 시장 실시간 등락": "Изменение цены на вторичном рынке", "2차 시장에서 구매": "Купить на вторичном рынке", "지분 구매": "Купить доли", "개인 간 거래 시장": "Рынок между пользователями", "조건에 맞는 2차 시장 자산이 없습니다.": "Подходящих активов вторичного рынка нет", "현재가(최근 체결가)": "Текущая цена (последняя сделка)", "청약 기준가": "Цена подписки", "참고 가격(JC)": "Справочная цена (JC)", "시장으로 이동": "Перейти на рынок",
  },
  ar: {
    "보유 자산 평가액:": "تقييم الأصول المحتفظ بها:", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "تعذر تحميل الرصيد على السلسلة مؤقتًا. لن يُعرض الإجمالي على أنه صفر.", "사용 가능 JC": "JC المتاح", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "USDT المتاح (رصيد على السلسلة، تحديث تلقائي)", "JC 금고 교환": "تحويل JC من الخزينة", "지갑 생성 중…": "جارٍ إنشاء المحفظة…", "자금 출금": "سحب الأموال", "현재 등록된 자산이 없습니다.": "لا توجد أصول مدرجة حاليًا", "청약 단가": "سعر الاكتتاب للوحدة", "2차 시장 실시간 등락": "تغير السوق الثانوية مباشرةً", "2차 시장에서 구매": "شراء من السوق الثانوية", "지분 구매": "شراء حصص", "개인 간 거래 시장": "سوق تداول بين المستخدمين", "조건에 맞는 2차 시장 자산이 없습니다.": "لا توجد أصول ثانوية تطابق هذه الشروط", "현재가(최근 체결가)": "السعر الحالي (آخر صفقة)", "청약 기준가": "سعر الاكتتاب", "참고 가격(JC)": "السعر المرجعي (JC)", "시장으로 이동": "الانتقال إلى السوق",
  },
  hi: {
    "보유 자산 평가액:": "धारित संपत्तियों का मूल्य:", "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.": "ऑन-चेन बैलेंस अभी उपलब्ध नहीं है। कुल राशि शून्य के रूप में नहीं दिखाई जाएगी।", "사용 가능 JC": "उपलब्ध JC", "사용 가능 USDT (온체인 잔액, 자동 업데이트)": "उपलब्ध USDT (ऑन-चेन बैलेंस, स्वतः अपडेट)", "JC 금고 교환": "JC कोष विनिमय", "지갑 생성 중…": "वॉलेट बनाया जा रहा है…", "자금 출금": "धन निकालें", "현재 등록된 자산이 없습니다.": "अभी कोई संपत्ति सूचीबद्ध नहीं है", "청약 단가": "सब्सक्रिप्शन मूल्य", "2차 시장 실시간 등락": "द्वितीयक बाज़ार में लाइव बदलाव", "2차 시장에서 구매": "द्वितीयक बाज़ार में खरीदें", "지분 구매": "शेयर खरीदें", "개인 간 거래 시장": "पीयर-टू-पीयर बाज़ार", "조건에 맞는 2차 시장 자산이 없습니다.": "कोई मेल खाती द्वितीयक बाज़ार संपत्ति नहीं है", "현재가(최근 체결가)": "वर्तमान मूल्य (नवीनतम ट्रेड)", "청약 기준가": "सब्सक्रिप्शन मूल्य", "참고 가격(JC)": "संदर्भ मूल्य (JC)", "시장으로 이동": "बाज़ार पर जाएँ",
  },
};

const walletUiCopy: Partial<Record<Lang, Record<string, string>>> = {
  "zh-TW": { "거래 내역": "交易紀錄", "유형": "類型", "거래": "交易紀錄", "분배 내역": "分潤紀錄", "이번 주": "本週", "이번 달": "本月", "올해": "今年", "직접 날짜": "自訂日期", "시작 날짜": "開始日期", "종료 날짜": "結束日期", "이 기간에 분배 기록이 없습니다": "此區間沒有分潤紀錄", "이 기간에 거래 기록이 없습니다": "此區間沒有交易紀錄", "JC 구매 (USDT→JC)": "買入 JC（USDT→JC）", "JC 상환 (JC→USDT)": "回收 JC（JC→USDT）", "구매 단가": "買入單價", "상환 단가": "回收單價", "사용 가능 USDT": "可用 USDT", "JC 수량": "JC 數量", "전체": "全部", "지불할 금액": "需支付", "환급 예상": "可換回", "나의 환급 신청": "我的贖回申請", "지급 완료": "已撥款", "JC 반환 완료": "已退回 JC", "심사 대기": "等待審核", "닫기": "關閉", "교환 확인": "確認兌換", "금고로 전송 중…": "轉帳至金庫中…", "기록 중…": "記帳中…", "처리 중…": "處理中…", "이번 주 거래": "本週", "수수료": "手續費", "환불": "退款", "링크를 열어 BaseScan에서 확인": "在 BaseScan 查看鏈上交易" },
  "zh-CN": { "거래 내역": "交易记录", "유형": "类型", "거래": "交易记录", "분배 내역": "分润记录", "이번 주": "本周", "이번 달": "本月", "올해": "今年", "직접 날짜": "自定义日期", "시작 날짜": "开始日期", "종료 날짜": "结束日期", "이 기간에 분배 기록이 없습니다": "此区间没有分润记录", "이 기간에 거래 기록이 없습니다": "此区间没有交易记录", "JC 구매 (USDT→JC)": "买入 JC（USDT→JC）", "JC 상환 (JC→USDT)": "回收 JC（JC→USDT）", "구매 단가": "买入单价", "상환 단가": "回收单价", "사용 가능 USDT": "可用 USDT", "JC 수량": "JC 数量", "전체": "全部", "지불할 금액": "需支付", "환급 예상": "可换回", "나의 환급 신청": "我的赎回申请", "지급 완료": "已拨款", "JC 반환 완료": "已退回 JC", "심사 대기": "等待审核", "닫기": "关闭", "교환 확인": "确认兑换", "금고로 전송 중…": "转账至金库中…", "기록 중…": "记账中…", "처리 중…": "处理中…", "이번 주 거래": "本周", "수수료": "手续费", "환불": "退款", "링크를 열어 BaseScan에서 확인": "在 BaseScan 查看链上交易" },
  en: { "거래 내역": "Trade history", "유형": "Type", "거래": "Transactions", "분배 내역": "Commission history", "이번 주": "This week", "이번 달": "This month", "올해": "This year", "직접 날짜": "Custom dates", "시작 날짜": "Start date", "종료 날짜": "End date", "이 기간에 분배 기록이 없습니다": "No commissions in this date range", "이 기간에 거래 기록이 없습니다": "No transactions in this date range", "JC 구매 (USDT→JC)": "Buy JC (USDT → JC)", "JC 상환 (JC→USDT)": "Redeem JC (JC → USDT)", "구매 단가": "Purchase price", "상환 단가": "Redemption price", "사용 가능 USDT": "Available USDT", "JC 수량": "JC amount", "전체": "Max", "지불할 금액": "You pay", "환급 예상": "You receive", "나의 환급 신청": "My redemption requests", "지급 완료": "Paid", "JC 반환 완료": "JC refunded", "심사 대기": "Pending review", "닫기": "Close", "교환 확인": "Confirm exchange", "금고로 전송 중…": "Transferring to vault…", "기록 중…": "Recording…", "처리 중…": "Processing…", "이번 주 거래": "This week", "수수료": "Fee", "환불": "Refund", "링크를 열어 BaseScan에서 확인": "View on BaseScan" },
  ja: { "거래 내역": "取引履歴", "유형": "種類", "거래": "取引", "분배 내역": "報酬履歴", "이번 주": "今週", "이번 달": "今月", "올해": "今年", "직접 날짜": "日付を指定", "시작 날짜": "開始日", "종료 날짜": "終了日", "이 기간에 분배 기록이 없습니다": "この期間の報酬はありません", "이 기간에 거래 기록이 없습니다": "この期間の取引はありません", "JC 구매 (USDT→JC)": "JCを購入（USDT→JC）", "JC 상환 (JC→USDT)": "JCを換金（JC→USDT）", "구매 단가": "購入価格", "상환 단가": "換金価格", "사용 가능 USDT": "利用可能なUSDT", "JC 수량": "JC数量", "전체": "全額", "지불할 금액": "お支払い", "환급 예상": "受取予定", "나의 환급 신청": "換金申請", "지급 완료": "支払済み", "JC 반환 완료": "JC返金済み", "심사 대기": "審査待ち", "닫기": "閉じる", "교환 확인": "交換を確定", "금고로 전송 중…": "金庫へ送金中…", "기록 중…": "記帳中…", "처리 중…": "処理中…", "이번 주 거래": "今週", "수수료": "手数料", "환불": "返金", "링크를 열어 BaseScan에서 확인": "BaseScanで取引を表示" },
  ko: { "거래 내역": "거래 내역", "유형": "유형", "거래": "거래", "분배 내역": "분배 내역", "이번 주": "이번 주", "이번 달": "이번 달", "올해": "올해", "직접 날짜": "직접 날짜", "시작 날짜": "시작 날짜", "종료 날짜": "종료 날짜", "이 기간에 분배 기록이 없습니다": "이 기간에 분배 기록이 없습니다", "이 기간에 거래 기록이 없습니다": "이 기간에 거래 기록이 없습니다", "JC 구매 (USDT→JC)": "JC 구매 (USDT→JC)", "JC 상환 (JC→USDT)": "JC 상환 (JC→USDT)", "구매 단가": "구매 단가", "상환 단가": "상환 단가", "사용 가능 USDT": "사용 가능 USDT", "JC 수량": "JC 수량", "전체": "전체", "지불할 금액": "지불할 금액", "환급 예상": "환급 예상", "나의 환급 신청": "나의 환급 신청", "지급 완료": "지급 완료", "JC 반환 완료": "JC 반환 완료", "심사 대기": "심사 대기", "닫기": "닫기", "교환 확인": "교환 확인", "금고로 전송 중…": "금고로 전송 중…", "기록 중…": "기록 중…", "처리 중…": "처리 중…", "이번 주 거래": "이번 주 거래", "수수료": "수수료", "환불": "환불", "링크를 열어 BaseScan에서 확인": "BaseScan에서 확인" },
  th: { "거래 내역": "ประวัติการซื้อขาย", "유형": "ประเภท", "거래": "ธุรกรรม", "분배 내역": "ประวัติค่าคอมมิชชัน", "이번 주": "สัปดาห์นี้", "이번 달": "เดือนนี้", "올해": "ปีนี้", "직접 날짜": "กำหนดวันที่เอง", "시작 날짜": "วันที่เริ่มต้น", "종료 날짜": "วันที่สิ้นสุด", "이 기간에 분배 기록이 없습니다": "ไม่มีค่าคอมมิชชันในช่วงนี้", "이 기간에 거래 기록이 없습니다": "ไม่มีธุรกรรมในช่วงนี้", "JC 구매 (USDT→JC)": "ซื้อ JC (USDT → JC)", "JC 상환 (JC→USDT)": "แลกคืน JC (JC → USDT)", "구매 단가": "ราคาซื้อ", "상환 단가": "ราคาแลกคืน", "사용 가능 USDT": "USDT ที่ใช้ได้", "JC 수량": "จำนวน JC", "전체": "ทั้งหมด", "지불할 금액": "ยอดชำระ", "환급 예상": "ยอดรับคืน", "나의 환급 신청": "คำขอแลกคืนของฉัน", "지급 완료": "จ่ายแล้ว", "JC 반환 완료": "คืน JC แล้ว", "심사 대기": "รอตรวจสอบ", "닫기": "ปิด", "교환 확인": "ยืนยันการแลก", "금고로 전송 중…": "กำลังโอนไปคลัง…", "기록 중…": "กำลังบันทึก…", "처리 중…": "กำลังดำเนินการ…", "이번 주 거래": "สัปดาห์นี้", "수수료": "ค่าธรรมเนียม", "환불": "คืนเงิน", "링크를 열어 BaseScan에서 확인": "ดูธุรกรรมบน BaseScan" },
  vi: { "거래 내역": "Lịch sử giao dịch", "유형": "Loại", "거래": "Giao dịch", "분배 내역": "Lịch sử hoa hồng", "이번 주": "Tuần này", "이번 달": "Tháng này", "올해": "Năm nay", "직접 날짜": "Chọn ngày", "시작 날짜": "Ngày bắt đầu", "종료 날짜": "Ngày kết thúc", "이 기간에 분배 기록이 없습니다": "Không có hoa hồng trong khoảng thời gian này", "이 기간에 거래 기록이 없습니다": "Không có giao dịch trong khoảng thời gian này", "JC 구매 (USDT→JC)": "Mua JC (USDT → JC)", "JC 상환 (JC→USDT)": "Đổi JC (JC → USDT)", "구매 단가": "Giá mua", "상환 단가": "Giá đổi lại", "사용 가능 USDT": "USDT khả dụng", "JC 수량": "Số lượng JC", "전체": "Tất cả", "지불할 금액": "Số tiền cần trả", "환급 예상": "Số tiền nhận lại", "나의 환급 신청": "Yêu cầu đổi lại của tôi", "지급 완료": "Đã thanh toán", "JC 반환 완료": "Đã hoàn JC", "심사 대기": "Đang chờ duyệt", "닫기": "Đóng", "교환 확인": "Xác nhận đổi", "금고로 전송 중…": "Đang chuyển vào kho…", "기록 중…": "Đang ghi sổ…", "처리 중…": "Đang xử lý…", "이번 주 거래": "Tuần này", "수수료": "Phí", "환불": "Hoàn tiền", "링크를 열어 BaseScan에서 확인": "Xem giao dịch trên BaseScan" },
  id: { "거래 내역": "Riwayat transaksi", "유형": "Jenis", "거래": "Transaksi", "분배 내역": "Riwayat komisi", "이번 주": "Minggu ini", "이번 달": "Bulan ini", "올해": "Tahun ini", "직접 날짜": "Tanggal khusus", "시작 날짜": "Tanggal mulai", "종료 날짜": "Tanggal akhir", "이 기간에 분배 기록이 없습니다": "Tidak ada komisi pada rentang ini", "이 기간에 거래 기록이 없습니다": "Tidak ada transaksi pada rentang ini", "JC 구매 (USDT→JC)": "Beli JC (USDT → JC)", "JC 상환 (JC→USDT)": "Tukar kembali JC (JC → USDT)", "구매 단가": "Harga beli", "상환 단가": "Harga penukaran", "사용 가능 USDT": "USDT tersedia", "JC 수량": "Jumlah JC", "전체": "Maksimum", "지불할 금액": "Jumlah bayar", "환급 예상": "Jumlah diterima", "나의 환급 신청": "Permintaan penukaran saya", "지급 완료": "Sudah dibayar", "JC 반환 완료": "JC dikembalikan", "심사 대기": "Menunggu tinjauan", "닫기": "Tutup", "교환 확인": "Konfirmasi penukaran", "금고로 전송 중…": "Mengirim ke brankas…", "기록 중…": "Mencatat…", "처리 중…": "Memproses…", "이번 주 거래": "Minggu ini", "수수료": "Biaya", "환불": "Pengembalian dana", "링크를 열어 BaseScan에서 확인": "Lihat transaksi di BaseScan" },
  ms: { "거래 내역": "Sejarah transaksi", "유형": "Jenis", "거래": "Transaksi", "분배 내역": "Sejarah komisen", "이번 주": "Minggu ini", "이번 달": "Bulan ini", "올해": "Tahun ini", "직접 날짜": "Tarikh tersuai", "시작 날짜": "Tarikh mula", "종료 날짜": "Tarikh tamat", "이 기간에 분배 기록이 없습니다": "Tiada komisen dalam julat ini", "이 기간에 거래 기록이 없습니다": "Tiada transaksi dalam julat ini", "JC 구매 (USDT→JC)": "Beli JC (USDT → JC)", "JC 상환 (JC→USDT)": "Tebus JC (JC → USDT)", "구매 단가": "Harga beli", "상환 단가": "Harga tebus", "사용 가능 USDT": "USDT tersedia", "JC 수량": "Jumlah JC", "전체": "Semua", "지불할 금액": "Jumlah bayaran", "환급 예상": "Jumlah diterima", "나의 환급 신청": "Permohonan tebusan saya", "지급 완료": "Telah dibayar", "JC 반환 완료": "JC dipulangkan", "심사 대기": "Menunggu semakan", "닫기": "Tutup", "교환 확인": "Sahkan pertukaran", "금고로 전송 중…": "Sedang memindahkan ke perbendaharaan…", "기록 중…": "Sedang merekod…", "처리 중…": "Sedang diproses…", "이번 주 거래": "Minggu ini", "수수료": "Yuran", "환불": "Bayaran balik", "링크를 열어 BaseScan에서 확인": "Lihat transaksi di BaseScan" },
  es: { "거래 내역": "Historial de transacciones", "유형": "Tipo", "거래": "Transacciones", "분배 내역": "Historial de comisiones", "이번 주": "Esta semana", "이번 달": "Este mes", "올해": "Este año", "직접 날짜": "Fechas personalizadas", "시작 날짜": "Fecha inicial", "종료 날짜": "Fecha final", "이 기간에 분배 기록이 없습니다": "No hay comisiones en este periodo", "이 기간에 거래 기록이 없습니다": "No hay transacciones en este periodo", "JC 구매 (USDT→JC)": "Comprar JC (USDT → JC)", "JC 상환 (JC→USDT)": "Canjear JC (JC → USDT)", "구매 단가": "Precio de compra", "상환 단가": "Precio de canje", "사용 가능 USDT": "USDT disponible", "JC 수량": "Cantidad de JC", "전체": "Máximo", "지불할 금액": "Total a pagar", "환급 예상": "Importe a recibir", "나의 환급 신청": "Mis solicitudes de canje", "지급 완료": "Pagado", "JC 반환 완료": "JC devuelto", "심사 대기": "Pendiente de revisión", "닫기": "Cerrar", "교환 확인": "Confirmar cambio", "금고로 전송 중…": "Enviando a la tesorería…", "기록 중…": "Registrando…", "처리 중…": "Procesando…", "이번 주 거래": "Esta semana", "수수료": "Comisión", "환불": "Reembolso", "링크를 열어 BaseScan에서 확인": "Ver transacción en BaseScan" },
  fr: { "거래 내역": "Historique des transactions", "유형": "Type", "거래": "Transactions", "분배 내역": "Historique des commissions", "이번 주": "Cette semaine", "이번 달": "Ce mois-ci", "올해": "Cette année", "직접 날짜": "Dates personnalisées", "시작 날짜": "Date de début", "종료 날짜": "Date de fin", "이 기간에 분배 기록이 없습니다": "Aucune commission sur cette période", "이 기간에 거래 기록이 없습니다": "Aucune transaction sur cette période", "JC 구매 (USDT→JC)": "Acheter des JC (USDT → JC)", "JC 상환 (JC→USDT)": "Convertir des JC (JC → USDT)", "구매 단가": "Prix d’achat", "상환 단가": "Prix de conversion", "사용 가능 USDT": "USDT disponible", "JC 수량": "Quantité de JC", "전체": "Tout", "지불할 금액": "À payer", "환급 예상": "À recevoir", "나의 환급 신청": "Mes demandes de conversion", "지급 완료": "Payé", "JC 반환 완료": "JC remboursés", "심사 대기": "En attente de vérification", "닫기": "Fermer", "교환 확인": "Confirmer l’échange", "금고로 전송 중…": "Transfert vers la trésorerie…", "기록 중…": "Enregistrement…", "처리 중…": "Traitement…", "이번 주 거래": "Cette semaine", "수수료": "Frais", "환불": "Remboursement", "링크를 열어 BaseScan에서 확인": "Voir la transaction sur BaseScan" },
  de: { "거래 내역": "Transaktionsverlauf", "유형": "Typ", "거래": "Transaktionen", "분배 내역": "Provisionsverlauf", "이번 주": "Diese Woche", "이번 달": "Diesen Monat", "올해": "Dieses Jahr", "직접 날짜": "Benutzerdefinierter Zeitraum", "시작 날짜": "Startdatum", "종료 날짜": "Enddatum", "이 기간에 분배 기록이 없습니다": "Keine Provisionen in diesem Zeitraum", "이 기간에 거래 기록이 없습니다": "Keine Transaktionen in diesem Zeitraum", "JC 구매 (USDT→JC)": "JC kaufen (USDT → JC)", "JC 상환 (JC→USDT)": "JC einlösen (JC → USDT)", "구매 단가": "Kaufpreis", "상환 단가": "Einlösepreis", "사용 가능 USDT": "Verfügbares USDT", "JC 수량": "JC-Betrag", "전체": "Maximal", "지불할 금액": "Zu zahlen", "환급 예상": "Voraussichtlicher Erhalt", "나의 환급 신청": "Meine Einlösungen", "지급 완료": "Ausgezahlt", "JC 반환 완료": "JC zurückerstattet", "심사 대기": "Prüfung ausstehend", "닫기": "Schließen", "교환 확인": "Tausch bestätigen", "금고로 전송 중…": "Übertragung an die Treasury…", "기록 중…": "Wird verbucht…", "처리 중…": "Wird verarbeitet…", "이번 주 거래": "Diese Woche", "수수료": "Gebühr", "환불": "Erstattung", "링크를 열어 BaseScan에서 확인": "Transaktion auf BaseScan ansehen" },
  pt: { "거래 내역": "Histórico de transações", "유형": "Tipo", "거래": "Transações", "분배 내역": "Histórico de comissões", "이번 주": "Esta semana", "이번 달": "Este mês", "올해": "Este ano", "직접 날짜": "Datas personalizadas", "시작 날짜": "Data inicial", "종료 날짜": "Data final", "이 기간에 분배 기록이 없습니다": "Sem comissões neste período", "이 기간에 거래 기록이 없습니다": "Sem transações neste período", "JC 구매 (USDT→JC)": "Comprar JC (USDT → JC)", "JC 상환 (JC→USDT)": "Resgatar JC (JC → USDT)", "구매 단가": "Preço de compra", "상환 단가": "Preço de resgate", "사용 가능 USDT": "USDT disponível", "JC 수량": "Quantidade de JC", "전체": "Tudo", "지불할 금액": "Valor a pagar", "환급 예상": "Valor a receber", "나의 환급 신청": "Os meus pedidos de resgate", "지급 완료": "Pago", "JC 반환 완료": "JC devolvido", "심사 대기": "A aguardar análise", "닫기": "Fechar", "교환 확인": "Confirmar troca", "금고로 전송 중…": "A transferir para a tesouraria…", "기록 중…": "A registar…", "처리 중…": "A processar…", "이번 주 거래": "Esta semana", "수수료": "Taxa", "환불": "Reembolso", "링크를 열어 BaseScan에서 확인": "Ver transação na BaseScan" },
  ru: { "거래 내역": "История транзакций", "유형": "Тип", "거래": "Транзакции", "분배 내역": "История комиссий", "이번 주": "Эта неделя", "이번 달": "Этот месяц", "올해": "Этот год", "직접 날짜": "Выбрать даты", "시작 날짜": "Начальная дата", "종료 날짜": "Конечная дата", "이 기간에 분배 기록이 없습니다": "За этот период комиссий нет", "이 기간에 거래 기록이 없습니다": "За этот период транзакций нет", "JC 구매 (USDT→JC)": "Купить JC (USDT → JC)", "JC 상환 (JC→USDT)": "Обменять JC (JC → USDT)", "구매 단가": "Цена покупки", "상환 단가": "Цена обмена", "사용 가능 USDT": "Доступно USDT", "JC 수량": "Количество JC", "전체": "Максимум", "지불할 금액": "К оплате", "환급 예상": "К получению", "나의 환급 신청": "Мои заявки на обмен", "지급 완료": "Выплачено", "JC 반환 완료": "JC возвращены", "심사 대기": "Ожидает проверки", "닫기": "Закрыть", "교환 확인": "Подтвердить обмен", "금고로 전송 중…": "Перевод в казначейство…", "기록 중…": "Запись в учёт…", "처리 중…": "Обработка…", "이번 주 거래": "Эта неделя", "수수료": "Комиссия", "환불": "Возврат", "링크를 열어 BaseScan에서 확인": "Открыть транзакцию в BaseScan" },
  ar: { "거래 내역": "سجل المعاملات", "유형": "النوع", "거래": "المعاملات", "분배 내역": "سجل العمولات", "이번 주": "هذا الأسبوع", "이번 달": "هذا الشهر", "올해": "هذا العام", "직접 날짜": "تواريخ مخصصة", "시작 날짜": "تاريخ البدء", "종료 날짜": "تاريخ الانتهاء", "이 기간에 분배 기록이 없습니다": "لا توجد عمولات خلال هذه الفترة", "이 기간에 거래 기록이 없습니다": "لا توجد معاملات خلال هذه الفترة", "JC 구매 (USDT→JC)": "شراء JC (USDT → JC)", "JC 상환 (JC→USDT)": "استرداد JC (JC → USDT)", "구매 단가": "سعر الشراء", "상환 단가": "سعر الاسترداد", "사용 가능 USDT": "USDT المتاح", "JC 수량": "كمية JC", "전체": "الحد الأقصى", "지불할 금액": "المبلغ المستحق", "환급 예상": "المبلغ المتوقع استلامه", "나의 환급 신청": "طلبات الاسترداد", "지급 완료": "تم الدفع", "JC 반환 완료": "تم إرجاع JC", "심사 대기": "بانتظار المراجعة", "닫기": "إغلاق", "교환 확인": "تأكيد التحويل", "금고로 전송 중…": "جارٍ التحويل إلى الخزينة…", "기록 중…": "جارٍ التسجيل…", "처리 중…": "جارٍ المعالجة…", "이번 주 거래": "هذا الأسبوع", "수수료": "الرسوم", "환불": "استرداد", "링크를 열어 BaseScan에서 확인": "عرض المعاملة على BaseScan" },
  hi: { "거래 내역": "लेनदेन इतिहास", "유형": "प्रकार", "거래": "लेनदेन", "분배 내역": "कमीशन इतिहास", "이번 주": "इस सप्ताह", "이번 달": "इस महीने", "올해": "इस वर्ष", "직접 날짜": "कस्टम तिथियाँ", "시작 날짜": "आरंभ तिथि", "종료 날짜": "समाप्ति तिथि", "이 기간에 분배 기록이 없습니다": "इस अवधि में कोई कमीशन नहीं", "이 기간에 거래 기록이 없습니다": "इस अवधि में कोई लेनदेन नहीं", "JC 구매 (USDT→JC)": "JC खरीदें (USDT → JC)", "JC 상환 (JC→USDT)": "JC भुनाएँ (JC → USDT)", "구매 단가": "खरीद मूल्य", "상환 단가": "रिडेम्प्शन मूल्य", "사용 가능 USDT": "उपलब्ध USDT", "JC 수량": "JC मात्रा", "전체": "अधिकतम", "지불할 금액": "देय राशि", "환급 예상": "प्राप्त होने वाली राशि", "나의 환급 신청": "मेरे रिडेम्प्शन अनुरोध", "지급 완료": "भुगतान हो गया", "JC 반환 완료": "JC वापस किया गया", "심사 대기": "समीक्षा लंबित", "닫기": "बंद करें", "교환 확인": "एक्सचेंज की पुष्टि करें", "금고로 전송 중…": "खज़ाने में भेजा जा रहा है…", "기록 중…": "रिकॉर्ड किया जा रहा है…", "처리 중…": "प्रक्रिया जारी…", "이번 주 거래": "इस सप्ताह", "수수료": "शुल्क", "환불": "रिफंड", "링크를 열어 BaseScan에서 확인": "BaseScan पर लेनदेन देखें" },
};

const walletExtraUiCopy: Partial<Record<Lang, Record<string, string>>> = {
  "zh-TW": { "보유 지분": "份額", "거래 단가": "成交單價", "이 자산의 거래 내역이 없습니다": "沒有此標的的交易紀錄", "온체인 USDT 받음": "鏈上 USDT 轉入", "온체인 USDT 보냄": "鏈上 USDT 轉出", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "暫時無法載入鏈上 USDT 轉帳紀錄，稍後會自動重試。" },
  "zh-CN": { "보유 지분": "份额", "거래 단가": "成交单价", "이 자산의 거래 내역이 없습니다": "没有此标的的交易记录", "온체인 USDT 받음": "链上 USDT 转入", "온체인 USDT 보냄": "链上 USDT 转出", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "暂时无法加载链上 USDT 转账记录，稍后会自动重试。" },
  en: { "보유 지분": "Shares", "거래 단가": "Trade price", "이 자산의 거래 내역이 없습니다": "No trades for this asset", "온체인 USDT 받음": "On-chain USDT received", "온체인 USDT 보냄": "On-chain USDT sent", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "On-chain USDT history is temporarily unavailable and will retry." },
  ja: { "보유 지분": "保有口数", "거래 단가": "約定単価", "이 자산의 거래 내역이 없습니다": "この資産の取引履歴はありません", "온체인 USDT 받음": "オンチェーンUSDT受取", "온체인 USDT 보냄": "オンチェーンUSDT送金", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "オンチェーンUSDT履歴を読み込めません。自動で再試行します。" },
  ko: { "보유 지분": "보유 지분", "거래 단가": "거래 단가", "이 자산의 거래 내역이 없습니다": "이 자산의 거래 내역이 없습니다", "온체인 USDT 받음": "온체인 USDT 받음", "온체인 USDT 보냄": "온체인 USDT 보냄", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다." },
  th: { "보유 지분": "จำนวนหน่วยที่ถือ", "거래 단가": "ราคาซื้อขาย", "이 자산의 거래 내역이 없습니다": "ไม่มีประวัติการซื้อขายสินทรัพย์นี้", "온체인 USDT 받음": "รับ USDT บนเชน", "온체인 USDT 보냄": "ส่ง USDT บนเชน", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "โหลดประวัติ USDT บนเชนไม่ได้ชั่วคราว ระบบจะลองอีกครั้งโดยอัตโนมัติ" },
  vi: { "보유 지분": "Số phần đang nắm giữ", "거래 단가": "Giá giao dịch", "이 자산의 거래 내역이 없습니다": "Không có giao dịch cho tài sản này", "온체인 USDT 받음": "USDT nhận on-chain", "온체인 USDT 보냄": "USDT gửi on-chain", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "Lịch sử USDT on-chain tạm thời không khả dụng và sẽ tự thử lại." },
  id: { "보유 지분": "Unit yang dimiliki", "거래 단가": "Harga transaksi", "이 자산의 거래 내역이 없습니다": "Tidak ada transaksi untuk aset ini", "온체인 USDT 받음": "USDT on-chain diterima", "온체인 USDT 보냄": "USDT on-chain dikirim", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "Riwayat USDT on-chain sementara tidak tersedia dan akan dicoba kembali." },
  ms: { "보유 지분": "Unit pegangan", "거래 단가": "Harga dagangan", "이 자산의 거래 내역이 없습니다": "Tiada transaksi untuk aset ini", "온체인 USDT 받음": "USDT dalam rantaian diterima", "온체인 USDT 보냄": "USDT dalam rantaian dihantar", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "Sejarah USDT dalam rantaian tidak tersedia sementara dan akan dicuba semula." },
  es: { "보유 지분": "Participaciones", "거래 단가": "Precio de operación", "이 자산의 거래 내역이 없습니다": "No hay operaciones de este activo", "온체인 USDT 받음": "USDT recibido on-chain", "온체인 USDT 보냄": "USDT enviado on-chain", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "El historial de USDT on-chain no está disponible temporalmente y se volverá a intentar." },
  fr: { "보유 지분": "Parts détenues", "거래 단가": "Prix de transaction", "이 자산의 거래 내역이 없습니다": "Aucune transaction pour cet actif", "온체인 USDT 받음": "USDT reçu on-chain", "온체인 USDT 보냄": "USDT envoyé on-chain", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "L’historique USDT on-chain est temporairement indisponible et sera réessayé." },
  de: { "보유 지분": "Gehaltene Anteile", "거래 단가": "Handelspreis", "이 자산의 거래 내역이 없습니다": "Keine Transaktionen für dieses Asset", "온체인 USDT 받음": "On-Chain-USDT erhalten", "온체인 USDT 보냄": "On-Chain-USDT gesendet", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "Der On-Chain-USDT-Verlauf ist vorübergehend nicht verfügbar; es wird erneut versucht." },
  pt: { "보유 지분": "Unidades detidas", "거래 단가": "Preço da negociação", "이 자산의 거래 내역이 없습니다": "Não existem transações deste ativo", "온체인 USDT 받음": "USDT recebido on-chain", "온체인 USDT 보냄": "USDT enviado on-chain", "온체인 USDT 내역을 불러올 ��� 없습니다. 자동으로 다시 시도합니다.": "O histórico de USDT on-chain está temporariamente indisponível e será novamente consultado." },
  ru: { "보유 지분": "Доли во владении", "거래 단가": "Цена сделки", "이 자산의 거래 내역이 없습니다": "По этому активу нет сделок", "온체인 USDT 받음": "Получен USDT в блокчейне", "온체인 USDT 보냄": "Отправлен USDT в блокчейне", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "История USDT в блокчейне временно недоступна; будет выполнена повторная попытка." },
  ar: { "보유 지분": "الحصص المملوكة", "거래 단가": "سعر التداول", "이 자산의 거래 내역이 없습니다": "لا توجد معاملات لهذا الأصل", "온체인 USDT 받음": "استلام USDT على السلسلة", "온체인 USDT 보냄": "إرسال USDT على السلسلة", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "سجل USDT على السلسلة غير متاح مؤقتًا وستتم إعادة المحاولة تلقائيًا." },
  hi: { "보유 지분": "धारित हिस्से", "거래 단가": "ट्रेड मूल्य", "이 자산의 거래 내역이 없습니다": "इस संपत्ति के लिए कोई ट्रेड नहीं", "온체인 USDT 받음": "ऑन-चेन USDT प्राप्त", "온체인 USDT 보냄": "ऑन-चेन USDT भेजा", "온체인 USDT 내역을 불러올 수 없습니다. 자동으로 다시 시도합니다.": "ऑन-चेन USDT इतिहास अभी उपलब्ध नहीं है; अपने आप फिर प्रयास होगा।" },
};

const walletStatusUiCopy: Record<Lang, Record<string, string>> = {
  "zh-TW": { "잔액을 읽는 중…": "讀取中…", "잔액을 읽지 못했습니다": "讀取失敗", "USDT 잔액 부족": "USDT 餘額不足", "JC 잔액 부족": "JC 餘額不足" },
  "zh-CN": { "잔액을 읽는 중…": "读取中…", "잔액을 읽지 못했습니다": "读取失败", "USDT 잔액 부족": "USDT 余额不足", "JC 잔액 부족": "JC 余额不足" },
  en: { "잔액을 읽는 중…": "Loading balance…", "잔액을 읽지 못했습니다": "Balance unavailable", "USDT 잔액 부족": "Insufficient USDT balance", "JC 잔액 부족": "Insufficient JC balance" },
  ja: { "잔액을 읽는 중…": "残高を読み込み中…", "잔액을 읽지 못했습니다": "残高を取得できません", "USDT 잔액 부족": "USDT残高が不足しています", "JC 잔액 부족": "JC残高が不足しています" },
  ko: { "잔액을 읽는 중…": "잔액을 읽는 중…", "잔액을 읽지 못했습니다": "잔액을 읽지 못했습니다", "USDT 잔액 부족": "USDT 잔액 부족", "JC 잔액 부족": "JC 잔액 부족" },
  th: { "잔액을 읽는 중…": "กำลังอ่านยอดคงเหลือ…", "잔액을 읽지 못했습니다": "ไม่สามารถอ่านยอดคงเหลือได้", "USDT 잔액 부족": "ยอด USDT ไม่เพียงพอ", "JC 잔액 부족": "ยอด JC ไม่เพียงพอ" },
  vi: { "잔액을 읽는 중…": "Đang tải số dư…", "잔액을 읽지 못했습니다": "Không thể tải số dư", "USDT 잔액 부족": "Số dư USDT không đủ", "JC 잔액 부족": "Số dư JC không đủ" },
  id: { "잔액을 읽는 중…": "Memuat saldo…", "잔액을 읽지 못했습니다": "Saldo tidak dapat dimuat", "USDT 잔액 부족": "Saldo USDT tidak mencukupi", "JC 잔액 부족": "Saldo JC tidak mencukupi" },
  ms: { "잔액을 읽는 중…": "Memuatkan baki…", "잔액을 읽지 못했습니다": "Baki tidak dapat dimuatkan", "USDT 잔액 부족": "Baki USDT tidak mencukupi", "JC 잔액 부족": "Baki JC tidak mencukupi" },
  es: { "잔액을 읽는 중…": "Cargando saldo…", "잔액을 읽지 못했습니다": "Saldo no disponible", "USDT 잔액 부족": "Saldo de USDT insuficiente", "JC 잔액 부족": "Saldo de JC insuficiente" },
  fr: { "잔액을 읽는 중…": "Chargement du solde…", "잔액을 읽지 못했습니다": "Solde indisponible", "USDT 잔액 부족": "Solde USDT insuffisant", "JC 잔액 부족": "Solde JC insuffisant" },
  de: { "잔액을 읽는 중…": "Kontostand wird geladen…", "잔액을 읽지 못했습니다": "Kontostand nicht verfügbar", "USDT 잔액 부족": "USDT-Guthaben nicht ausreichend", "JC 잔액 부족": "JC-Guthaben nicht ausreichend" },
  pt: { "잔액을 읽는 중…": "A carregar saldo…", "잔액을 읽지 못했습니다": "Saldo indisponível", "USDT 잔액 부족": "Saldo USDT insuficiente", "JC 잔액 부족": "Saldo JC insuficiente" },
  ru: { "잔액을 읽는 중…": "Загрузка баланса…", "잔액을 읽지 못했습니다": "Баланс недоступен", "USDT 잔액 부족": "Недостаточно USDT", "JC 잔액 부족": "Недостаточно JC" },
  ar: { "잔액을 읽는 중…": "جارٍ تحميل الرصيد…", "잔액을 읽지 못했습니다": "الرصيد غير متاح", "USDT 잔액 부족": "رصيد USDT غير كافٍ", "JC 잔액 부족": "رصيد JC غير كافٍ" },
  hi: { "잔액을 읽는 중…": "बैलेंस लोड हो रहा है…", "잔액을 읽지 못했습니다": "बैलेंस उपलब्ध नहीं है", "USDT 잔액 부족": "USDT बैलेंस अपर्याप्त", "JC 잔액 부족": "JC बैलेंस अपर्याप्त" },
};

type WalletExchangeMessageKey =
  | "purchaseSuccess"
  | "purchasePending"
  | "purchaseUnconfirmed"
  | "redemptionSuccess"
  | "redemptionPending";

const walletExchangeMessages: Record<Lang, Record<WalletExchangeMessageKey, string>> = {
  "zh-TW": {
    purchaseSuccess: "已轉帳 {usdt} 到金庫並完成兌換 {jc}。{tx}",
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
    redemptionPending: "JC 赎回已预留，但链上交割尚未确认。额度保留并会自动重试，请勿重复申请。{tx}",
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
    redemptionSuccess: "JCの換金が完了しました：{jc}を{usdt}に交換しました。{tx}",
    redemptionPending: "JC換金を受け付け、額を予約しました。オンチェーン決済は未確認で、自動再試行されます。重複申請しないでください。{tx}",
  },
  ko: {
    purchaseSuccess: "{usdt}를 금고로 전송하고 {jc} 교환을 완료했습니다. {tx}",
    purchasePending: "USDT는 온체인에서 확인됐지만 JC 정산／입금은 처리 중입니다. 예약 금액은 유지되며 자동 재시도됩니다. 중복 구매하지 마세요. {tx}",
    purchaseUnconfirmed: "USDT 전송 여부를 확인할 수 없습니다. 예약 금액은 유지됩니다. 지갑 내역을 확인하고 고객 지원에 문의하세요. {error}",
    redemptionSuccess: "JC 환매 완료: {jc}를 {usdt}로 교환했습니다. {tx}",
    redemptionPending: "JC 환매가 예약됐지만 온체인 정산은 아직 확인되지 않았습니다. 예약 금액은 유지되며 자동 재시도됩니다. 중복 신청하지 마세요. {tx}",
  },
  th: {
    purchaseSuccess: "โอน {usdt} เข้าคลังและแลกเป็น {jc} สำเร็จแล้ว {tx}",
    purchasePending: "USDT อยู่บนเชนแล้ว แต่การชำระ／บันทึก JC ยังดำเนินการอยู่ ระบบจะเก็บยอดสำรองและลองใหม่อัตโนมัติ โปรดอย่าซื้อซ้ำ {tx}",
    purchaseUnconfirmed: "ยังยืนยันไม่ได้ว่าส่ง USDT แล้วหรือไม่ ระบบยังเก็บยอดสำรองไว้ โปรดตรวจสอบประวัติกระเป๋าและติดต่อฝ่ายช่วยเหลือ {error}",
    redemptionSuccess: "แลกคืน JC สำเร็จ: {jc} แลกเป็น {usdt} {tx}",
    redemptionPending: "สำรองคำขอแลกคืน JC แล้ว แต่ยังไม่ยืนยันการชำระบนเชน ระบบจะลองใหม่อัตโนมัติ โปรดอย่าส่งคำขอซ้ำ {tx}",
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
    purchaseUnconfirmed: "Не удалось подтвердить отправку USDT. Резерв сохранён. Проверьте операции кошелька и обратитесь в поддержку. {error}",
    redemptionSuccess: "Обмен JC подтверждён: {jc} на {usdt}. {tx}",
    redemptionPending: "Заявка на обмен JC зарезервирована, но расчёт в блокчейне ещё не подтверждён. Резерв сохранён, система повторит попытку. Не отправляйте заявку повторно. {tx}",
  },
  ar: {
    purchaseSuccess: "تم تحويل {usdt} إلى الخزينة وإضافة {jc}. {tx}",
    purchasePending: "تم تأكيد USDT على السلسلة، لكن تسوية／تسجيل JC ما زالت قيد المعالجة. سيبقى المبلغ محجوزًا وستتم إعادة المحاولة تلقائيًا. لا تكرر الشراء. {tx}",
    purchaseUnconfirmed: "تعذر تأكيد إرسال USDT. سيبقى الحجز قائمًا. تحقق من نشاط المحفظة وتواصل مع الدعم. {error}",
    redemptionSuccess: "تم تأكيد استرداد JC: استبدال {jc} مقابل {usdt}. {tx}",
    redemptionPending: "تم حجز طلب استرداد JC، لكن التسوية على السلسلة لم تتأكد بعد. سيبقى الحجز قائمًا وستتم إعادة المحاولة تلقائيًا. لا تكرر الطلب. {tx}",
  },
  hi: {
    purchaseSuccess: "{usdt} ट्रेज़री में भेजे गए और {jc} जमा किए गए। {tx}",
    purchasePending: "USDT ऑन-चेन पुष्टि हो गया है, लेकिन JC सेटलमेंट／लेजर प्रविष्टि अभी जारी है। आरक्षण सुरक्षित है और अपने आप फिर प्रयास होगा। खरीद दोबारा न करें। {tx}",
    purchaseUnconfirmed: "यह पुष्टि नहीं हो सकी कि USDT भेजा गया या नहीं। आरक्षण सुरक्षित है। वॉलेट गतिविधि जाँचें और सहायता से संपर्क करें। {error}",
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

export const localizedUiText = (language: Lang, korean: string, fallback: string) =>
  walletStatusUiCopy[language]?.[korean] ?? walletExtraUiCopy[language]?.[korean] ?? walletUiCopy[language]?.[korean] ?? localizedUiCopy[language]?.[korean] ?? (language === "ko" ? korean : fallback);
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
    "주문장",
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
    "تم التحقق من KYC",
    "إيداع",
    "سحب",
    "المقتنيات",
    "المعاملات الأخيرة",
    "محاكاة على السلسلة",
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
  bids: "買單",
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
  noSubscriptions: "目前沒有可顯示的非二級市場標的。",
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
    backMarket: "市場に戻る",
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
    noSubscriptions: "現在表示できる申込対象資産はありません。",
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
    confirmSubscription: "청약 확정",
  },
};
const pageExtra: Partial<Record<Lang, Record<string, string>>> = {
  th: {
    announcement: "สินทรัพย์ของแพลตฟอร์มกำหนดราคาเป็น JC ตามรายการ และจะระบุว่าธุรกรรมบนเชนเสร็จสมบูรณ์หลังได้รับการยืนยันเท่านั้น",
    more: "สินทรัพย์เพิ่มเติม", valuation: "มูลค่าประเมินสินทรัพย์", expectedApy: "APY ที่คาดหวัง", verification: "การตรวจสอบสินทรัพย์", fullAddress: "ที่อยู่เต็ม", propertyHistory: "ประวัติอสังหาริมทรัพย์", nearbyPricing: "ราคาอสังหาริมทรัพย์ใกล้เคียง", advantages: "จุดเด่นการลงทุน",
    all: "ทั้งหมด", rising: "ปรับขึ้น", falling: "ปรับลง", owned: "จำนวนหน่วยที่ถือ", totalAssets: "มูลค่าสินทรัพย์รวม", status: "สถานะ", confirmed: "ยืนยันแล้ว", subscribeEyebrow: "ตลาดแรก", subscribeTitle: "จองซื้อ", subscribing: "เปิดรับจอง", soldOut: "ขายหมดแล้ว", ended: "สิ้นสุดแล้ว", subscriptionUnitPrice: "ราคาต่อหน่วย", subscribeNow: "จองซื้อเลย", unavailableSubscribe: "ขณะนี้ไม่เปิดให้จองซื้อ", noSubscriptions: "ไม่มีสินทรัพย์ที่เปิดให้จองซื้อในขณะนี้", availableBalance: "ยอดคงเหลือที่ใช้ได้", subscriptionUnits: "จำนวนหน่วยที่จอง", subscriptionTotal: "ยอดจองรวม", confirmSubscription: "ยืนยันการจอง", agentCenter: "ศูนย์ตัวแทน", dateRange: "ช่วงวันที่",
  },
  vi: {
    announcement: "Tài sản trên nền tảng được định giá bằng JC theo từng sản phẩm; giao dịch on-chain chỉ được đánh dấu hoàn tất sau khi xác nhận.",
    more: "Thêm tài sản", valuation: "Giá trị định giá", expectedApy: "APY dự kiến", verification: "Xác minh tài sản", fullAddress: "Địa chỉ đầy đủ", propertyHistory: "Lịch sử bất động sản", nearbyPricing: "Giá tham khảo lân cận", advantages: "Ưu điểm đầu tư",
    all: "Tất cả", rising: "Tăng", falling: "Giảm", owned: "Số lượng đang nắm giữ", totalAssets: "Tổng giá trị tài sản", status: "Trạng thái", confirmed: "Đã xác nhận", subscribeEyebrow: "Thị trường sơ cấp", subscribeTitle: "Đăng ký mua", subscribing: "Đang mở bán", soldOut: "Đã bán hết", ended: "Đã kết thúc", subscriptionUnitPrice: "Giá đăng ký mỗi đơn vị", subscribeNow: "Đăng ký ngay", unavailableSubscribe: "Hiện không thể đăng ký mua", noSubscriptions: "Hiện không có tài sản sơ cấp để hiển thị.", availableBalance: "Số dư khả dụng", subscriptionUnits: "Số đơn vị đăng ký", subscriptionTotal: "Tổng giá trị đăng ký", confirmSubscription: "Xác nhận đăng ký", agentCenter: "Trung tâm đại lý", dateRange: "Khoảng thời gian",
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
    more: "Mais ativos", valuation: "Valor de avaliação", expectedApy: "APY esperado", verification: "Verificação do ativo", fullAddress: "Endereço completo", propertyHistory: "Histórico do imóvel", nearbyPricing: "Preços da região", advantages: "Vantagens do investimento",
    all: "Todos", rising: "Em alta", falling: "Em baixa", owned: "Unidades detidas", totalAssets: "Valor total dos ativos", status: "Estado", confirmed: "Confirmado", subscribeEyebrow: "Mercado primário", subscribeTitle: "Subscrição", subscribing: "Subscrição aberta", soldOut: "Esgotado", ended: "Terminado", subscriptionUnitPrice: "Preço por unidade", subscribeNow: "Subscrever agora", unavailableSubscribe: "Subscrição indisponível", noSubscriptions: "Não existem ativos disponíveis para subscrição neste momento.", availableBalance: "Saldo disponível", subscriptionUnits: "Unidades da subscrição", subscriptionTotal: "Total da subscrição", confirmSubscription: "Confirmar subscrição", agentCenter: "Centro de agentes", dateRange: "Período",
  },
  ru: {
    announcement: "Активы платформы оцениваются в JC согласно каждому предложению; транзакция в блокчейне считается завершённой только после подтверждения.",
    more: "Другие активы", valuation: "Оценочная стоимость", expectedApy: "Ожидаемая APY", verification: "Проверка актива", fullAddress: "Полный адрес", propertyHistory: "История объекта", nearbyPricing: "Цены поблизости", advantages: "Преимущества инвестиций",
    all: "Все", rising: "Рост", falling: "Снижение", owned: "Количество во владении", totalAssets: "Общая стоимость активов", status: "Статус", confirmed: "Подтверждено", subscribeEyebrow: "Первичный рынок", subscribeTitle: "Подписка", subscribing: "Подписка открыта", soldOut: "Распродано", ended: "Завершено", subscriptionUnitPrice: "Цена за единицу", subscribeNow: "Подписаться", unavailableSubscribe: "Подписка сейчас недоступна", noSubscriptions: "Сейчас нет активов, доступных для подписки.", availableBalance: "Доступный баланс", subscriptionUnits: "Количество единиц", subscriptionTotal: "Сумма подписки", confirmSubscription: "Подтвердить подписку", agentCenter: "Центр агентов", dateRange: "Период",
  },
  ar: {
    announcement: "تُسعّر أصول المنصة بعملة JC وفقًا لكل طرح؛ ولا تُعدّ المعاملة على السلسلة مكتملة إلا بعد تأكيدها.",
    more: "المزيد من الأصول", valuation: "القيمة التقديرية", expectedApy: "العائد السنوي المتوقع", verification: "التحقق من الأصل", fullAddress: "العنوان الكامل", propertyHistory: "سجل العقار", nearbyPricing: "أسعار المنطقة", advantages: "مزايا الاستثمار",
    all: "الكل", rising: "ارتفاع", falling: "انخفاض", owned: "الوحدات المملوكة", totalAssets: "إجمالي قيمة الأصول", status: "الحالة", confirmed: "تم التأكيد", subscribeEyebrow: "السوق الأولية", subscribeTitle: "الاكتتاب", subscribing: "الاكتتاب متاح", soldOut: "نفدت الكمية", ended: "انتهى", subscriptionUnitPrice: "سعر الوحدة", subscribeNow: "اكتتب الآن", unavailableSubscribe: "الاكتتاب غير متاح حاليًا", noSubscriptions: "لا توجد أصول متاحة للاكتتاب حاليًا.", availableBalance: "الرصيد المتاح", subscriptionUnits: "وحدات الاكتتاب", subscriptionTotal: "إجمالي الاكتتاب", confirmSubscription: "تأكيد الاكتتاب", agentCenter: "مركز الوكلاء", dateRange: "النطاق الزمني",
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
    "新規上場通知",
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
    "총 자산 가치",
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
    "تنبيهات الإدراج الجديد",
    "تلقي إشعارات الحساب والأصول",
    "مستثمر",
    "إجمالي قيمة الأصول",
    "رسوم الشبكة",
    "الحالة",
    "مؤكد",
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
    "पूरे इंटरफ़ेस की भाषा बदलें",
    "पहचान सत्यापन",
    "सत्यापन तिथि",
    "स्तर",
    "मूल्य सूचनाएँ",
    "लाभांश सूचनाएँ",
    "नई लिस्टिंग सूचनाएँ",
    "खाता और एसेट सूचनाएँ प्राप्त करें",
    "निवेशक",
    "कुल एसेट म���ल्य",
    "नेटवर्क शुल्क",
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
    "ロンドン・カナリーワーフ オフィス",
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
    "टोक्यो शिबुया वाणिज्यिक भवन",
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
