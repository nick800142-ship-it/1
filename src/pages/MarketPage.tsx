"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  CircleDollarSign,
  MapPin,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import {
  currentMarketPrice,
  formatJC,
  interfaceText,
  localizedUiText,
  useLanguage,
  usePlatform,
  type Asset,
  type Lang,
} from "@/platform";
import { useTranslation } from "@/i18n";
import { Modal, Notice } from "@/components/Modal";
import { SearchSuggest } from "@/components/SearchSuggest";
import { MarketCandlestickChart } from "@/components/MarketCandlestickChart";
import { ClickableAssetImage } from "@/components/AssetImageGallery";
import { AssetDetails } from "@/components/AssetDetails";
import { FormattedNumberInput } from "@/components/FormattedNumberInput";
import { TradeDetailsDialog, TransactionCompletionDialog, type TradeDetails } from "@/components/TradeDetailsDialog";
import { useVisiblePolling } from "@/hooks/useVisiblePolling";
import { supabase } from "@/lib/supabase";
import { reportMonitorEventInBackground } from "@/lib/monitoring";
import { callRelayer, useOnchainSettlement, syncHoldingFromChain, syncJcBalanceFromChain } from "@/lib/onchainSettlement";
import { AE_TOKEN_CANONICAL_ID } from "@/lib/aeToken";
import { CONTRACT_ADDRESSES, P2P_ESCROW_ADDRESS, isKnownP2PEscrow } from "@/lib/contracts";
import { formatFeePercent, tradeFeeFor, useP2PFees } from "@/lib/p2pFees";
import { getCurrentRwaFactoryToken } from "@/lib/onchainContracts";
import { useActiveSafeAddress } from "@/lib/activeSafe";
import { keccak256, toBytes, type Address } from "viem";
import { explorerTxUrl } from "@/lib/network";


function submittedTransactionHash(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("transactionHash" in error)) return null;
  const hash = (error as { transactionHash?: unknown }).transactionHash;
  return typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash) ? hash : null;
}

function transactionReverted(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "reverted" in error && (error as { reverted?: unknown }).reverted === true);
}

type P2POrder = {
  id: string;
  asset_id: string;
  side: "buy" | "sell";
  price: number;
  original_quantity: number;
  remaining_quantity: number;
  status: "open" | "partially_filled" | "filled" | "cancelled";
  created_at: string;
  updated_at?: string;
  is_mine?: boolean;
  escrow_chain_order_id?: string | number | null;
  escrow_contract_address?: string | null;
  escrow_mode?: "legacy" | "escrow";
  fee_bps?: number | null;
  listing_fee?: number | null;
};

type Settlement = {
  role: "buyer" | "seller";
  gross: number;
  total?: number;
  platform_fee?: number;
  net?: number;
  quantity: number;
};

const errorText: Record<string, { ko: string; zh: string }> = {
  "not authenticated": { ko: "로그인 상태가 만료되었습니다. 다시 로그인해 주세요.", zh: "登入狀態已失效，請重新登入" },
  "invalid quantity": { ko: "유효한 정수 수량을 입력해 주세요.", zh: "請輸入有效的整數份額" },
  "invalid price": { ko: "유효한 가격을 입력한 후 다시 제출해 주세요.", zh: "單價無效，請輸入正確金額後重新送出" },
  "opposite side order exists": { ko: "같은 자산에 매수·매도 주문을 동시에 등록할 수 없습니다. 기존 주문을 취소하거나 체결될 때까지 기다려 주세요.", zh: "同一標的不可雙向掛單，請先取消或等待另一方向掛單成交" },
  "insufficient shares": { ko: "매도 주문에 등록할 수 있는 수량이 부족합니다.", zh: "可掛出份額不足，無法掛賣單" },
  "insufficient listing fee": { ko: "주문 등록 수수료가 부족합니다. 지갑 금고에서 JC를 구매해 주세요.", zh: "可用 JC 不足以支付掛單手續費，請先在錢包金庫購買 JC" },
  "minimum trade 2 jc": { ko: "최소 거래 금액은 2 JC입니다.", zh: "每次成交金額最低為 2 JC" },
  "secondary market unavailable": { ko: "이 자산은 아직 2차 시장에서 거래할 수 없습니다.", zh: "此標的尚未開放二級市場" },
  "order unavailable": { ko: "주문이 취소되었거나 이미 모두 체결되었습니다.", zh: "掛單已取消或已成交完畢" },
  "cannot fill own order": { ko: "본인의 주문은 체결할 수 없습니다.", zh: "不能成交自己的掛單" },
  "insufficient order quantity": { ko: "주문에 남은 수량이 부족합니다.", zh: "掛單剩餘份額不足" },
  "buyer insufficient balance": { ko: "매수자의 JC 잔액이 부족합니다.", zh: "買方 JC 餘額不足" },
  "seller insufficient holdings": { ko: "매도자의 보유 수량이 부족합니다.", zh: "賣方持有份額不足" },
  "jc price unavailable": { ko: "현재 JC 가격을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.", zh: "JC 單價暫時無法取得，請稍後再試" },
  "trade too small": { ko: "거래 금액이 판매자 수수료보다 적습니다.", zh: "成交金額不足以支付賣方費用" },
};

function localizedMarketError(language: Lang, message: string) {
  const translation = errorText[message];
  return translation
    ? localizedUiText(language, translation.ko, translation.zh)
    : message;
}

export function MarketPage() {
  const { t, language, assets: localizedAssets } = useLanguage();
  const { t: translate } = useTranslation();
  const { fees: p2pFees } = useP2PFees();
  const { assets: platformAssets } = usePlatform();
  const assets = useMemo(
    () =>
      platformAssets.map((asset) => {
        const localized = localizedAssets.find((item) => item.id === asset.id);
        const translation =
          asset.translations?.[language] ?? asset.translations?.["zh-TW"];
        return {
          ...(localized ?? asset),
          ...asset,
          name: asset.isAeToken ? "AE" : asset.name,
          location: asset.location,
          address: asset.address,
          information: translation?.information?.trim() || asset.information,
          history: translation?.history?.length ? translation.history : localized?.history ?? asset.history,
          comparables: translation?.comparables?.length ? translation.comparables : localized?.comparables ?? asset.comparables,
          advantages: translation?.advantages?.length ? translation.advantages : localized?.advantages ?? asset.advantages,
        };
      }),
    [platformAssets, localizedAssets, language],
  );
  // Store only the id, not the Asset object: usePlatform() polls every
  // second, but a snapshot captured at click time never re-renders with
  // fresh data (e.g. lastTradedPrice), so the open detail view would stay
  // stuck on stale numbers forever while the market card next to it shows
  // the live price. Re-deriving from mergedAssets below keeps it live.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "up" | "down">("all");
  // AE token daily and bonus rounds are separate private_placements rows,
  // each with its own release schedule, but holdings/orders are collapsed
  // onto the canonical id server-side (execute_private_purchase) so they
  // trade as one asset. Collapse the rows the same way here so the market
  // shows a single AE token card instead of one per round.
  const aeTokenAssets = assets.filter((asset) => asset.isAeToken);
  const canonicalAeToken =
    aeTokenAssets.find((asset) => asset.id === AE_TOKEN_CANONICAL_ID) ?? aeTokenAssets[0] ?? null;
  const mergedAssets = [
    ...assets.filter((asset) => !asset.isAeToken),
    ...(canonicalAeToken ? [canonicalAeToken] : []),
  ];
  const resolveAsset = useCallback(
    (assetId: string) => {
      const asset = assets.find((item) => item.id === assetId);
      return asset?.isAeToken ? canonicalAeToken : asset;
    },
    [assets, canonicalAeToken],
  );
  const secondaryAssets = mergedAssets.filter((asset) => asset.marketStartedAt);
  const list = secondaryAssets.filter(
    (asset) =>
      asset.name.toLowerCase().includes(search.trim().toLowerCase()) &&
      (filter === "all" ||
        (filter === "up" ? asset.change >= 0 : asset.change < 0)),
  );
  const selectedAsset = selectedId
    ? mergedAssets.find((asset) => asset.id === selectedId) ?? null
    : null;

  useEffect(() => {
    const assetId = new URL(window.location.href).searchParams.get("asset");
    if (!assetId) return;
    const asset = resolveAsset(assetId);
    if (asset) setSelectedId(asset.id);
  }, [resolveAsset]);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-amber-300">
          <Users className="size-4" />
          <p className="text-xs font-bold uppercase tracking-[.22em]">
            {translate("market.h2h")}
          </p>
        </div>
        <h1 className="text-3xl font-bold text-balance">{t("market")}</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-slate-400">
          {translate("market.description", { listingFee: formatJC(p2pFees.listingFee), tradeFee: formatFeePercent(p2pFees.feeBps) })}
        </p>
      </header>
          <SearchSuggest
        value={search}
        onChange={setSearch}
        placeholder={interfaceText(language, "searchMarket")}
        suggestions={secondaryAssets.map((asset) => ({
          value: asset.name,
          label: asset.name,
          detail: asset.location,
        }))}
        onSelect={(value) => {
          const asset = mergedAssets.find((item) => item.name === value);
          if (asset) setSelectedId(asset.id);
        }}
      />
      <div className="flex gap-2">
        {(["all", "up", "down"] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setFilter(item)}
            className={`rounded-lg px-4 py-2 text-sm ${filter === item ? "bg-amber-400 font-bold text-slate-950" : "bg-slate-900 text-slate-400"}`}
          >
            {item === "all" ? localizedUiText(language, "전체", "全部") : item === "up" ? localizedUiText(language, "상승", "上漲") : localizedUiText(language, "하락", "下跌")}
          </button>
        ))}
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        {list.map((asset) => (
          <MarketCard
            key={asset.id}
            asset={asset}
            onOpen={() => setSelectedId(asset.id)}
          />
        ))}
      </div>
      {list.length === 0 && (
        <div className="rounded-2xl border border-dashed border-slate-700 p-10 text-center text-sm text-slate-500">
          {translate("market.noMatchingAssets")}
        </div>
      )}
      {selectedAsset && (
        <MarketDetail asset={selectedAsset} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

function MarketCard({
  asset,
  onOpen,
}: {
  asset: Asset;
  onOpen: () => void;
}) {
  const { language } = useLanguage();
  const { t: translate } = useTranslation();
  const up = asset.change >= 0;
  const hasTraded = asset.isAeToken && asset.lastTradedPrice != null;
  return (
    <article className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
      <ClickableAssetImage
        images={asset.images?.length ? asset.images : [asset.image]}
        assetName={asset.name}
        className="h-40 w-full object-cover"
      />
      <div className="flex flex-col gap-4 p-5">
        <div>
          <h2 className="font-bold">{asset.name}</h2>
          {!asset.isAeToken && (
            <p className="mt-1 flex items-center gap-1 text-xs text-slate-400">
              <MapPin className="size-3" /> {asset.location}
            </p>
          )}
        </div>
        <div className="flex items-end justify-between">
          <div>
            <p className="text-xs text-slate-500">{hasTraded ? localizedUiText(language, "현재가(최근 체결가)", "現價（最新成交價）") : asset.isAeToken ? localizedUiText(language, "청약 기준가", "認購原價") : localizedUiText(language, "참고 가격(JC)", "參考價格（JC）")}</p>
            <p className="text-xl font-bold">{formatJC(currentMarketPrice(asset))}</p>
          </div>
          <span
            className={`flex items-center gap-1 text-sm font-bold ${up ? "text-emerald-400" : "text-red-400"}`}
          >
            {up ? <TrendingUp className="size-4" /> : <TrendingDown className="size-4" />}
            {Math.abs(asset.change).toFixed(2)}%
          </span>
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full items-center justify-between rounded-xl bg-slate-800 px-4 py-3 font-semibold hover:bg-amber-400 hover:text-slate-950"
        >
          {translate("market.enterMarket")} <ChevronRight className="size-4" />
        </button>
      </div>
    </article>
  );
}

function MarketDetail({
  asset,
  onClose,
}: {
  asset: Asset;
  onClose: () => void;
}) {
  const { language } = useLanguage();
  const {
    jcOnChainBalance,
    jcOnChainLoading,
    jcOnChainError,
    holdings,
    transactions,
    refresh: refreshPlatform,
  } = usePlatform();
  const {
    createEscrowOrder,
    fillEscrowOrder,
  cancelEscrowOrder,
  ensureWalletReady,
  walletReady,
  } = useOnchainSettlement();
  const { fees } = useP2PFees();
  const listingFeeText = formatJC(fees.listingFee);
  const tradeFeeText = formatFeePercent(fees.feeBps);
  // 全站二級市場以 JC 計價結算：買方付 JC、賣方收 JC，平台費以 JC 收取；鏈上 Gas 由平台代付。
  const [orders, setOrders] = useState<P2POrder[]>([]);
  const [myOrders, setMyOrders] = useState<P2POrder[]>([]);
  const [side, setSide] = useState<"buy" | "sell">("sell");
  // AE掛單價格由買賣雙方自行輸入，預設帶入最新成交價（尚無成交時退回認購原價）；
  // 其他標的一律採用平台參考價，使用者不可自行修改。
  const [customPrice, setCustomPrice] = useState(() => String(currentMarketPrice(asset)));
  const price = asset.isAeToken ? Number(customPrice) || 0 : asset.price;
  const [quantity, setQuantity] = useState("");
  const [selectedOrder, setSelectedOrder] = useState<P2POrder | null>(null);
  const [fillQuantity, setFillQuantity] = useState("");
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmingOrder, setConfirmingOrder] = useState<TradeDetails | null>(null);
  const [completedTrade, setCompletedTrade] = useState<{ quantity: number; paymentJc: number; feeJc: number; txHash: string } | null>(null);
  const [orderToCancel, setOrderToCancel] = useState<P2POrder | null>(null);
  const [cancellingOrder, setCancellingOrder] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const [pendingEscrowSync, setPendingEscrowSync] = useState<{
    kind: "order" | "fill" | "cancel";
    txHash: string;
    orderId?: string;
  } | null>(null);
  const [chainHoldingState, setChainHoldingState] = useState<{
    assetId: string;
    verified: boolean;
    available?: number;
    error?: string;
  }>({ assetId: "", verified: false });
  const chainHoldingVerified = chainHoldingState.assetId === asset.id && chainHoldingState.verified;
  const chainHoldingError = chainHoldingState.assetId === asset.id ? chainHoldingState.error : undefined;
  const owned = holdings.find((item) => item.assetId === asset.id)?.tokens ?? 0;
  // 二級市場份額精度：RWA（非 AE）必須整數；AE 允許小數（最多 6 位）。
  const quantityValid = (q: number) =>
    Number.isFinite(q) &&
    q > 0 &&
    q <= 1_000_000 &&
    (asset.isAeToken ? Math.round(q * 1e6) / 1e6 === q : Number.isInteger(q));
  const invalidQuantityText = asset.isAeToken
    ? localizedUiText(language, "유효한 수량을 입력해 주세요(AE는 소수점 이하 최대 6자리).", "請輸入有效份額（AE 最多 6 位小數）")
    : localizedUiText(language, "유효한 정수 수량을 입력해 주세요.", "請輸入有效的整數份額");

  const refreshOrders = useCallback(async () => {
    const [{ data: book }, { data: mine }] = await Promise.all([
      // 新舊託管合約的掛單都顯示在同一個訂單簿；成交時會走該掛單所屬的合約。
      supabase.rpc("get_p2p_order_book", {
        asset_key: asset.id,
        p_escrow_contract_address: null,
      }),
      supabase.rpc("get_my_p2p_orders", {
        p_escrow_contract_address: null,
      }),
    ]);
    setOrders(((book as P2POrder[] | null) ?? []).filter((order) => isKnownP2PEscrow(order.escrow_contract_address)));
    setMyOrders(
      ((mine as P2POrder[] | null) ?? []).filter(
        (order) => order.asset_id === asset.id && isKnownP2PEscrow(order.escrow_contract_address),
      ),
    );
  }, [asset.id]);
  useVisiblePolling(refreshOrders, 2_000, true);

  // 持續讀取目前合約餘額；後端把仍鎖定 escrow 的賣單加回 holdings，讓取消掛單後
  // 的可用額等於錢包可支配份額。查詢失敗時不把舊帳本數字當成可信的可掛額。
  const syncChainHolding = useCallback(async () => {
    try {
      if (!asset.isAeToken && !(await getCurrentRwaFactoryToken(asset.id))) {
        setChainHoldingState({ assetId: asset.id, verified: false, error: localizedUiText(language, "이 자산은 현재 Factory 전용 토큰이 아직 배포되지 않았습니다.", "此標的尚未部署目前 Factory 專屬代幣。") });
        return;
      }
      const result = await syncHoldingFromChain(asset.id);
      if (result.synced) await refreshPlatform();
      setChainHoldingState({
        assetId: asset.id,
        verified: result.chainVerified,
        available: result.available,
        error: result.error ?? (result.chainVerified ? undefined : localizedUiText(language, "새 컨트랙트의 보유 수량을 확인할 수 없습니다.", "目前無法確認新合約持有份額。")),
      });
    } catch (error) {
      setChainHoldingState({
        assetId: asset.id,
        verified: false,
        error: error instanceof Error ? error.message : localizedUiText(language, "새 컨트랙트의 보유 수량을 확인할 수 없습니다.", "目前無法確認新合約持有份額。"),
      });
    }
  }, [asset.id, asset.isAeToken, refreshPlatform, language]);
  useVisiblePolling(syncChainHolding, 15_000, true);

  const asks = useMemo(
    () => orders.filter((order) => order.side === "sell"),
    [orders],
  );
  const bids = useMemo(
    () => orders.filter((order) => order.side === "buy"),
    [orders],
  );
  const gross = price * (Number(quantity) || 0);
  const fillGross = selectedOrder
    ? selectedOrder.price * (Number(fillQuantity) || 0)
    : 0;

  // 仍在掛單簿上的自有掛單（未成交或部分成交），用於單向掛單與份額額度判斷。
  const activeOrders = useMemo(
    () =>
      myOrders.filter(
        (order) =>
          (order.status === "open" || order.status === "partially_filled") &&
          isKnownP2PEscrow(order.escrow_contract_address),
      ),
    [myOrders],
  );
  // 已完全成交的掛單改到「我的成交紀錄」呈現，已取消的掛單也不再需要追蹤，
  // 「我的掛單」只留下仍需追蹤的狀態（open / partially_filled）。
  const visibleOrders = useMemo(
    () =>
      myOrders.filter(
        (order) =>
          order.status !== "filled" &&
          order.status !== "cancelled" &&
          isKnownP2PEscrow(order.escrow_contract_address),
      ),
    [myOrders],
  );
  const oppositeSide = side === "buy" ? "sell" : "buy";
  const hasOppositeOrder = activeOrders.some(
    (order) => order.side === oppositeSide,
  );
  // 已掛賣單佔用的份額不可重複掛出。
  const reservedForSell = activeOrders
    .filter((order) => order.side === "sell")
    .reduce((sum, order) => sum + order.remaining_quantity, 0);
  const sellableShares = chainHoldingVerified ? Math.max(chainHoldingState.available ?? 0, 0) : 0;
  const noSharesForSell = side === "sell" && sellableShares <= 0;
  const orderBlocked = hasOppositeOrder || noSharesForSell;
  const blockedReason = hasOppositeOrder
    ? localizedUiText(language, `이 자산에 미체결 ${oppositeSide === "buy" ? "매수" : "매도"} 주문이 있습니다. 같은 자산에 매수·매도 주문을 동시에 등록할 수 없으므로 기존 주문을 취소하거나 체결을 기다려 주세요.`, `你在此標的已有未完成的${oppositeSide === "buy" ? "買" : "賣"}單，同一標的不可雙向掛單；請先取消或等待成交。`)
    : noSharesForSell
      ? owned > 0
        ? localizedUiText(language, "사용 가능한 수량이 모두 매도 주문에 등록되어 추가로 등록할 수 없습니다.", "你的可用份額已全部掛在賣單中，沒有可再掛出的份額。")
        : localizedUiText(language, "보유 수량이 없어 매도 주문을 등록할 수 없습니다.", "你沒有持有此標的份額，無法掛賣單。")
      : "";

  // 掛單前先顯示交易明細：賣方掛單時收取一次性掛單費，成交時另收成交額比例代管費（費率由後台設定）；鏈上 Gas 由平台代付。
  const reviewOrder = () => {
    if (submitting) return;
    if (side === "sell" && !chainHoldingVerified) {
      setNotice({ text: chainHoldingError ?? localizedUiText(language, "컨트랙트 보유 수량을 확인하고 있습니다. 잠시 후 다시 시도해 주세요.", "正在核對目前合約持倉，請稍後再試。"), ok: false });
      void syncChainHolding();
      return;
    }
    const parsedQuantity = Number(quantity);
    if (!Number.isFinite(price) || price <= 0) {
      setNotice({
        text: asset.isAeToken ? localizedUiText(language, "유효한 가격을 입력해 주세요.", "請輸入有效的單價") : localizedUiText(language, "플랫폼 기준 가격에 문제가 있어 현재 주문을 등록할 수 없습니다.", "平台參考價異常，暫時無法掛單"),
        ok: false,
      });
      return;
    }
    if (orderBlocked) {
      setNotice({ text: blockedReason, ok: false });
      return;
    }
    if (!quantityValid(parsedQuantity)) {
      setNotice({ text: invalidQuantityText, ok: false });
      return;
    }
    if (side === "sell" && parsedQuantity > sellableShares) {
      setNotice({
        text: localizedUiText(language, `매도 주문 가능 수량이 부족합니다. 현재 최대 ${sellableShares.toLocaleString()}개까지 등록할 수 있습니다.`, `可掛出份額不足，目前最多可掛 ${sellableShares.toLocaleString()} 份`),
        ok: false,
      });
      return;
    }
    if (gross < 2) {
      setNotice({
        text: localizedUiText(language, "최소 주문 금액은 2 JC입니다.", "掛單總額最低為 2 JC"),
        ok: false,
      });
      return;
    }
    const sell = side === "sell";
    setConfirmingOrder({
      assetName: asset.name,
      quantity: parsedQuantity,
      fee: sell
        ? localizedUiText(language, `주문 등록 시 ${listingFeeText}가 부과되며, 체결 시 거래 금액의 ${tradeFeeText} 수수료가 추가됩니다.`, `掛單時收取 ${listingFeeText}；成交時另收成交金額的 ${tradeFeeText} 代管費`)
        : `${formatJC(0)}${localizedUiText(language, "(매수 수수료 없음)", "（買方免手續費）")}`,
      total: formatJC(gross),
      note: localizedUiText(language, `${sell ? "매도" : "매수"} 주문 · 단가 ${formatJC(price)}${asset.isAeToken ? "(AE 단가는 직접 설정)" : "(플랫폼 기준 가격, 수정 불가)"}. 주문 확인 후 매도 주문은 수량을, 매수 주문은 JC를 잠급니다. 매도 주문에는 ${listingFeeText}의 일회성 수수료(취소 시 환불되지 않음)가 부과되며, 체결 건마다 ${tradeFeeText} 수수료가 추가됩니다. 반대 방향의 주문은 가격·시간 우선순위로 자동 체결되며, 먼저 등록된 지정가가 체결 가격으로 적용됩니다. 資料資料체결 수량은 주문장에 남습니다.`, `${sell ? "掛賣單" : "掛買單"} · 單價 ${formatJC(price)}${asset.isAeToken ? "（AE單價由您自訂）" : "（平台參考價，不可修改）"}。掛單確認後，賣單會鎖定份額、買單會鎖定 JC；賣單收取一次性 ${listingFeeText}（取消不退），每筆成交另收 ${tradeFeeText} 費用。相反方向的合格掛單會依價格優先、時間優先自動撮合，成交價採較早掛出的限價；未成交部分繼續留在訂單簿。`),
    });
  };

  const retryEscrowSync = async () => {
    if (!pendingEscrowSync || submitting) return;
    setSubmitting(true);
    try {
      const action = pendingEscrowSync.kind === "order"
        ? "register-escrow-order"
        : pendingEscrowSync.kind === "fill"
          ? "settle-escrow-fill"
          : "register-escrow-cancel";
      await callRelayer(action, { txHash: pendingEscrowSync.txHash });
      setPendingEscrowSync(null);
      setNotice({ text: localizedUiText(language, "온체인 거래가 주문장과 원장에 동기화되었습니다.", "鏈上交易已同步到掛單簿與帳本。"), ok: true });
      await Promise.all([refreshOrders(), refreshPlatform()]);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : localizedUiText(language, "동기화가 아직 완료되지 않았습니다. 잠시 후 다시 시도해 주세요.", "同步仍未完成，請稍後重試"), ok: false });
    } finally {
      setSubmitting(false);
    }
  };

  const createOrder = async () => {
    if (submitting || pendingEscrowSync) return;
    const parsedQuantity = Number(quantity);
    if (!P2P_ESCROW_ADDRESS) {
      setNotice({ text: localizedUiText(language, "2차 시장 에스크로 컨트랙트가 아직 배포되지 않아 주문을 등록할 수 없습니다.", "二級市場託管合約尚未部署，暫時無法建立掛單。"), ok: false });
      return;
    }
    if (
      !Number.isFinite(price) || price <= 0 || !quantityValid(parsedQuantity) ||
      gross < 2 || orderBlocked
    ) {
      setConfirmingOrder(null);
      setNotice({ text: localizedUiText(language, "주문 조건이 변경되었습니다. 다시 확인해 주세요.", "掛單條件已變更，請重新確認"), ok: false });
      return;
    }
    setConfirmingOrder(null);
    setSubmitting(true);
    const requestKey = crypto.randomUUID();
    const clientOrderId = keccak256(toBytes(requestKey));
    let reserved = false;
    let txHash: string | null = null;
    let assetToken: Address | null = null;
    try {
      await ensureWalletReady();
      assetToken = asset.isAeToken ? CONTRACT_ADDRESSES.aeToken : await getCurrentRwaFactoryToken(asset.id);
      if (!assetToken) throw new Error(localizedUiText(language, "이 RWA 자산은 현재 Factory에 전용 토큰이 배포되지 않아 에스크로 주문을 등록할 수 없습니다.", "此 RWA 標的尚未在目前 Factory 部署專屬代幣，無法建立託管掛單。"));
      await syncJcBalanceFromChain();
      if (side === "sell") {
        const balanceSync = await syncHoldingFromChain(asset.id);
        if (!balanceSync.chainVerified) {
          throw new Error(
            balanceSync.error ?? localizedUiText(language, "새 컨트랙트의 보유 수량을 확인할 수 없습니다. 이전 컨트랙트 잔액을 사용하지 않도록 매도 주문 등록을 중단합니다.", "無法確認目前新合約的持有份額；為避免使用舊合約餘額，暫不建立賣單。"),
          );
        }
      }
      const { error: reserveError } = await supabase.rpc("reserve_p2p_escrow_order", {
        p_asset_key: asset.id,
        p_side: side,
        p_price: price.toFixed(6),
        p_quantity: quantity,
        p_request_key: requestKey,
        p_client_order_id: clientOrderId,
      });
      if (reserveError) throw new Error(localizedMarketError(language, reserveError.message));
      reserved = true;

      const chainOrder = await createEscrowOrder({
        side,
        assetToken,
        price: price.toFixed(6),
        quantity,
        requestKey,
      });
      txHash = chainOrder.txHash;
      setPendingEscrowSync({ kind: "order", txHash });
      const registration = await callRelayer("register-escrow-order", { txHash }) as {
        matching?: { matchedCount?: number };
      };
      setPendingEscrowSync(null);
      const matchedCount = Number(registration.matching?.matchedCount ?? 0);
      reportMonitorEventInBackground({ type: "trade_result", success: true });
      setNotice({
        text: localizedUiText(language, matchedCount > 0
          ? `주문이 등록되었고 ${matchedCount}건이 자동 체결되었습니다. 미체결 수량은 주문장에 남아 있습니다.${side === "sell" ? ` 일회성 ${listingFeeText} 주문 수수료는 Safe에 입금되었으며 환불되지 않습니다.` : " 미체결 JC는 주문 취소 시 반환됩니다."}`
          : `주문이 등록되었으며 체결 가능한 반대 주문이 없습니다. 미체결 수량은 주문장에 남아 있습니다.${side === "sell" ? ` 일회성 ${listingFeeText} 주문 수수료는 Safe에 입금되었으며 환불되지 않습니다.` : " 미체결 JC는 주문 취소 시 반환됩니다."}`, matchedCount > 0
          ? `掛單已建立並自動撮合 ${matchedCount} 筆；未成交部分仍保留於訂單簿。${side === "sell" ? `一次性 ${listingFeeText} 掛單費已直接進入 Safe，取消不退。` : "未成交 JC 會在取消時退回。"}`
          : `掛單已建立，尚無可成交的相反掛單；未成交部分保留於訂單簿。${side === "sell" ? `一次性 ${listingFeeText} 掛單費已直接進入 Safe，取消不退。` : "未成交 JC 會在取消時退回。"}`),
        ok: true,
      });
      await Promise.all([refreshOrders(), refreshPlatform()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : localizedUiText(language, "주문 등록이 완료되지 않았습니다.", "掛單流程未完成");
      const submittedHash = txHash ?? submittedTransactionHash(error);
      if (!submittedHash || transactionReverted(error)) {
        reportMonitorEventInBackground({
          type: "trade_result",
          success: false,
          message,
          action: side === "sell" ? "二級市場掛賣單" : "二級市場掛買單",
          assetId: asset.id,
          assetName: asset.name,
          quantity: parsedQuantity,
          amount: gross,
        });
      }
      if (submittedHash && !transactionReverted(error)) {
        setPendingEscrowSync({ kind: "order", txHash: submittedHash });
        setNotice({ text: localizedUiText(language, `온체인 주문이 제출되었지만 데이터 동기화가 아직 완료되지 않았습니다. ${message}`, `鏈上掛單已提交，但資料同步尚未完成。${message}`), ok: false });
      } else {
        if (reserved) {
          const { error: releaseError } = await supabase.rpc("release_p2p_escrow_order_reservation", { p_request_key: requestKey });
          if (releaseError) {
            setNotice({ text: localizedUiText(language, `${message} JC/수량 예약이 아직 해제되지 않았습니다. 잠시 후 다시 시도하거나 관리자에게 문의해 주세요.`, `${message}；JC／份額預留尚未釋回，請稍後重試或聯絡管理員。`), ok: false });
            return;
          }
        }
        setNotice({
          text: transactionReverted(error)
            ? localizedUiText(language, `${message} 온체인 거래가 롤백되어 플랫폼 예약이 해제되었습니다.`, `${message}；鏈上交易已回滾，平台預留已釋回。`)
            : reserved
              ? localizedUiText(language, `주문이 온체인에 제출되지 않았으며 플랫폼 예약이 해제되었습니다. ${message}`, `掛單未送上鏈；平台預留已釋回。${message}`)
              : message,
          ok: false,
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const confirmCancelOrder = async () => {
    if (!orderToCancel || cancellingOrder) return;
    const order = orderToCancel;
    setCancelError("");
    if (pendingEscrowSync && pendingEscrowSync.kind !== "cancel") {
      setCancelError(localizedUiText(language, "이전 온체인 거래가 아직 동기화 중입니다. 먼저 화면 상단의 '동기화 재시도'를 완료한 후 취소해 주세요.", "上一筆鏈上交易仍在同步中，請先按頁面上方的「重試同步」完成後再取消。"));
      return;
    }
    if (pendingEscrowSync?.kind === "cancel") {
      setCancellingOrder(true);
      try {
        await callRelayer("register-escrow-cancel", { txHash: pendingEscrowSync.txHash });
        setPendingEscrowSync(null);
        setNotice({ text: localizedUiText(language, "주문을 취소하고 원장에 동기화했습니다.", "已取消掛單並同步帳本。"), ok: true });
        setOrderToCancel(null);
        await Promise.all([refreshOrders(), refreshPlatform()]);
      } catch (error) {
        setCancelError(error instanceof Error ? error.message : localizedUiText(language, "동기화가 아직 완료되지 않았습니다. 잠시 후 다시 시도해 주세요.", "同步仍未完成，請稍後重試"));
      } finally {
        setCancellingOrder(false);
      }
      return;
    }
    if (!order.escrow_chain_order_id || !order.escrow_contract_address) {
      setNotice({ text: localizedUiText(language, "주문에 온체인 컨트랙트 정보가 없어 안전하게 취소할 수 없습니다. 새로고침하거나 관리자에게 문의해 주세요.", "掛單缺少鏈上合約資訊，無法安全取消；請重新整理或聯絡管理員。"), ok: false });
      return;
    }
    setCancellingOrder(true);
    try {
      const txHash = await cancelEscrowOrder(
        String(order.escrow_chain_order_id),
        order.escrow_contract_address,
      );
      setPendingEscrowSync({ kind: "cancel", txHash, orderId: order.id });
      await callRelayer("register-escrow-cancel", { txHash });
      setPendingEscrowSync(null);
      reportMonitorEventInBackground({ type: "trade_result", success: true });
      setNotice({
        text: order.side === "sell"
          ? localizedUiText(language, `매도 주문을 취소하고 미체결 수량을 돌려받았습니다. 일회성 ${formatJC(Number(order.listing_fee ?? 1))} 주문 수수료는 환불되지 않습니다.`, `已取消掛單並取回未成交份額；一次性 ${formatJC(Number(order.listing_fee ?? 1))} 掛單費不退還。`)
          : localizedUiText(language, "매수 주문을 취소하고 미체결 JC를 돌려받았습니다.", "已取消買單並取回未成交 JC。"),
        ok: true,
      });
      setOrderToCancel(null);
      await Promise.all([refreshOrders(), refreshPlatform()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : localizedUiText(language, "취소가 완료되지 않았습니다. 잠시 후 다시 시도해 주세요.", "取消流程未完成，請稍後重試");
      const submittedHash = submittedTransactionHash(error);
      if (!submittedHash || transactionReverted(error)) {
        reportMonitorEventInBackground({
          type: "trade_result",
          success: false,
          message,
          action: "二級市場取消掛單",
          assetId: asset.id,
          assetName: asset.name,
          quantity: order.remaining_quantity,
          amount: order.price * order.remaining_quantity,
        });
      }
      if (submittedHash && !transactionReverted(error)) {
        setPendingEscrowSync({ kind: "cancel", txHash: submittedHash, orderId: order.id });
        setCancelError(localizedUiText(language, `취소 거래가 제출되었지만 원장 동기화가 완료되지 않았습니다. '확인'을 다시 눌러 동기화를 재시도해 주세요. ${message}`, `取消交易已提交，帳本同步尚未完成，請再按一次「確認」重試同步。${message}`));
      } else {
        setCancelError(message);
      }
    } finally {
      setCancellingOrder(false);
    }
  };

  const fillOrder = async () => {
    if (!selectedOrder || submitting || pendingEscrowSync) return;
    const units = Number(fillQuantity);
    if (!quantityValid(units) || units > selectedOrder.remaining_quantity) {
      setNotice({
        text: asset.isAeToken ? localizedUiText(language, "잔여 수량 이하의 유효한 수량을 입력해 주세요(소수점 이하 최대 6자리).", "請輸入不超過剩餘份額的有效數量（最多 6 位小數）") : localizedUiText(language, "잔여 수량 이하의 정수를 입력해 주세요.", "請輸入不超過剩餘份額的整數"),
        ok: false,
      });
      return;
    }
    if (fillGross < 2 || !selectedOrder.escrow_chain_order_id) {
      setNotice({ text: localizedUiText(language, "이 주문의 온체인 에스크로가 아직 완료되지 않았습니다. 새로고침한 후 다시 시도해 주세요.", "此掛單尚未完成鏈上託管，請重新整理後再試。"), ok: false });
      return;
    }
    setSubmitting(true);
    const fillKey = crypto.randomUUID();
    const takerSide: "buy" | "sell" = selectedOrder.side === "sell" ? "buy" : "sell";
    let txHash: string | null = null;
    try {
      await syncJcBalanceFromChain();
      const assetToken = asset.isAeToken ? CONTRACT_ADDRESSES.aeToken : await getCurrentRwaFactoryToken(asset.id);
      if (!assetToken) throw new Error(localizedUiText(language, "이 자산은 현재 Factory에 전용 토큰이 배포되지 않아 체결할 수 없습니다.", "此標的尚未在目前 Factory 部署專屬代幣，無法成交。"));
      txHash = await fillEscrowOrder({
        orderId: String(selectedOrder.escrow_chain_order_id),
        orderSide: selectedOrder.side,
        assetToken,
        price: selectedOrder.price.toFixed(6),
        quantity: fillQuantity,
        fillKey,
        escrowContractAddress: selectedOrder.escrow_contract_address,
      });
      setPendingEscrowSync({ kind: "fill", txHash, orderId: selectedOrder.id });
      const result = await callRelayer("settle-escrow-fill", { txHash });
      setPendingEscrowSync(null);
      const fee = tradeFeeFor(fillGross, Number(selectedOrder.fee_bps ?? 100));
      setSettlement({
        role: takerSide === "buy" ? "buyer" : "seller",
        gross: fillGross,
        total: fillGross,
        platform_fee: fee,
        net: fillGross - fee,
        quantity: units,
      });
      setSelectedOrder(null);
      const finalized = result.status === "confirmed";
      if (finalized) {
        reportMonitorEventInBackground({ type: "trade_result", success: true });
        setCompletedTrade({ quantity: units, paymentJc: fillGross, feeJc: fee, txHash });
      }
      setNotice({
        text: finalized
          ? localizedUiText(language, `온체인 체결과 공식 원장 반영이 모두 완료되었습니다(Tx: ${txHash.slice(0, 10)}…).`, `鏈上成交與正式帳本均已完成（Tx: ${txHash.slice(0, 10)}…）。`)
          : localizedUiText(language, `온체인 체결은 완료되었지만 공식 원장 동기화가 진행 중입니다(Tx: ${txHash.slice(0, 10)}…). 중복 체결하지 마세요.`, `鏈上成交已完成，但正式帳本同步仍在處理中（Tx: ${txHash.slice(0, 10)}…）。請勿重複成交。`),
        ok: finalized,
      });
      await Promise.all([refreshOrders(), refreshPlatform()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : localizedUiText(language, "체결이 완료되지 않았습니다.", "成交流程未完成");
      const submittedHash = txHash ?? submittedTransactionHash(error);
      if (!submittedHash || transactionReverted(error)) {
        reportMonitorEventInBackground({
          type: "trade_result",
          success: false,
          message,
          action: "二級市場成交",
          assetId: asset.id,
          assetName: asset.name,
          quantity: units,
          amount: fillGross,
        });
      }
      if (submittedHash && !transactionReverted(error)) {
        setPendingEscrowSync({ kind: "fill", txHash: submittedHash, orderId: selectedOrder.id });
        setNotice({ text: localizedUiText(language, `체결 거래가 제출되었지만 영수증 또는 원장 동기화가 아직 완료되지 않았습니다. ${message}`, `成交交易已提交，收據或帳本同步尚未完成。${message}`), ok: false });
        setSelectedOrder(null);
      } else {
        setNotice({ text: message, ok: false });
      }
    } finally {
      setSubmitting(false);
    }
  };




  const ownTransactions = transactions.filter((item) => item.assetId === asset.id);

  // z-[55] 蓋住 z-50 的手機底部導覽列，避免導覽列浮在市場詳情內容上方。
  return (
    <div className="fixed inset-0 z-[55] overflow-y-auto bg-slate-950 pb-[env(safe-area-inset-bottom)] lg:left-60">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-5 sm:px-8 sm:py-8">
        <button type="button" onClick={onClose} className="flex w-fit items-center gap-2 text-sm text-slate-400 hover:text-slate-100">
          <ArrowLeft className="size-4" /> {localizedUiText(language, "시장으로 돌아가기", "返回市場")}
        </button>
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[.2em] text-amber-300">P2P order book</p>
            <h1 className="mt-2 text-2xl font-bold text-balance">{asset.name}</h1>
            <p className="mt-1 text-sm text-slate-400">{asset.location}</p>
          </div>
          <div className="sm:text-right">
            <p className="text-xs text-slate-500">
              {asset.isAeToken
                ? asset.lastTradedPrice != null
                  ? localizedUiText(language, "현재가(최근 체결가)", "現價（最新成交價）")
                  : localizedUiText(language, "청약 기준가(체결 내역 없음)", "認購原價（尚無成交）")
                : localizedUiText(language, "플랫폼 기준 가격(JC 기준)", "平台參考價（JC 計價）")}
            </p>
            <p className="text-3xl font-bold">{formatJC(currentMarketPrice(asset))}</p>
          </div>
        </header>
        <AssetDetails asset={asset} hideRemainingIssuance={!asset.isAeToken} />
        {notice && (
          <div className="flex flex-col gap-2">
            <Notice message={notice.text} tone={notice.ok ? "success" : "error"} />
            {pendingEscrowSync && (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-sm">
                <a
                  href={explorerTxUrl(pendingEscrowSync.txHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-amber-200 underline underline-offset-4"
                >
                  {localizedUiText(language, "온체인 거래 보기", "檢視鏈上交易")}
                </a>
                <button
                  type="button"
                  onClick={() => void retryEscrowSync()}
                  disabled={submitting}
                  className="rounded-lg bg-amber-400 px-3 py-2 font-bold text-slate-950 disabled:opacity-50"
                >
                  {submitting ? localizedUiText(language, "동기화 중…", "同步中…") : localizedUiText(language, "데이터 동기화 재시도", "重試網站帳本同步")}
                </button>
              </div>
            )}
          </div>
        )}
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <div className="flex flex-col gap-6">
            <MarketCandlestickChart asset={asset} />
            <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
              <div className="flex items-center justify-between border-b border-slate-800 p-5">
                <div>
                  <h2 className="font-bold">{localizedUiText(language, "주문 현황", "掛單現況")}</h2>
                </div>
                <span className="rounded-full border border-emerald-400/30 px-3 py-1 text-xs text-emerald-300">{localizedUiText(language, "온체인 에스크로", "鏈上託管")}</span>
              </div>
              <div className="grid sm:grid-cols-2 sm:divide-x sm:divide-slate-800">
                <OrderSide language={language} title={localizedUiText(language, "매도 주문", "賣單")} orders={asks} action={localizedUiText(language, "구매", "購買")} onSelect={setSelectedOrder} />
                <OrderSide language={language} title={localizedUiText(language, "매수 주문", "買單")} orders={bids} action={localizedUiText(language, "판매", "出售")} onSelect={setSelectedOrder} />
              </div>
            </section>
          </div>
          <aside className="h-fit rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <div className="grid grid-cols-2 rounded-xl bg-slate-800 p-1">
              {(["buy", "sell"] as const).map((item) => (
                <button key={item} type="button" onClick={() => setSide(item)} className={`rounded-lg py-2 font-bold ${side === item ? item === "buy" ? "bg-emerald-500 text-slate-950" : "bg-red-500 text-slate-950" : "text-slate-400"}`}>
                  {localizedUiText(language, item === "buy" ? "매수 주문" : "매도 주문", `掛${item === "buy" ? "買" : "賣"}單`)}
                </button>
              ))}
            </div>
            <div className="mt-5 flex flex-col gap-4">
              <Line a={localizedUiText(language, "사용 가능 JC", "可用 JC")} b={jcOnChainLoading ? localizedUiText(language, "불러오는 중…", "讀取中…") : jcOnChainError ? localizedUiText(language, "불러오기 실패", "讀取失敗") : formatJC(jcOnChainBalance)} />
              <Line a={localizedUiText(language, "보유 수량", "持有份額")} b={chainHoldingVerified ? owned.toLocaleString() : "—"} />
              <div className="text-sm">
                <p>{localizedUiText(language, "단가(JC)", "單價（JC）")}</p>
                {asset.isAeToken ? (
                  <FormattedNumberInput
                    value={customPrice}
                    onValueChange={setCustomPrice}
                    inputMode="decimal"
                    maxDecimals={6}
                    className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3"
                  />
                ) : (
                  <div className="mt-2 flex min-h-11 items-center justify-between rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
                    <span className="font-bold text-slate-100">{formatJC(price)}</span>
                    <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-400">{localizedUiText(language, "고정 가격", "固定價")}</span>
                  </div>
                )}
              </div>
              <label className="text-sm">{localizedUiText(language, "주문 수량", "掛單份額")}
                <FormattedNumberInput value={quantity} onValueChange={setQuantity} inputMode={asset.isAeToken ? "decimal" : "numeric"} maxDecimals={asset.isAeToken ? 6 : 0} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3" />
                {side === "sell" && (
                  <span role="status" className={`mt-2 block text-xs ${chainHoldingVerified ? "text-slate-500" : "text-amber-300"}`}>
                    {chainHoldingVerified
                      ? language === "th"
                        ? `จำนวนที่ขายได้ ${sellableShares.toLocaleString()} หน่วย${reservedForSell > 0 ? ` (มี ${reservedForSell.toLocaleString()} หน่วยอยู่ในคำสั่งขายแล้ว)` : ""}`
                        : localizedUiText(language, `매도 가능 수량 ${sellableShares.toLocaleString()}개${reservedForSell > 0 ? ` (이미 ${reservedForSell.toLocaleString()}개가 매도 주문에 등록됨)` : ""}`, `可掛出份額 ${sellableShares.toLocaleString()} 份${reservedForSell > 0 ? `（已有 ${reservedForSell.toLocaleString()} 份掛在賣單中）` : ""}`)
                      : chainHoldingError ?? localizedUiText(language, "온체인 보유 수량을 확인하는 중…", "正在核對目前鏈上份額…")}
                  </span>
                )}
              </label>
              {orderBlocked && (
                <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-xs leading-relaxed text-amber-200">{blockedReason}</p>
              )}
              <div className="rounded-xl bg-slate-950 p-4 text-sm">
                <Line a={localizedUiText(language, "주문 총액", "掛單總額")} b={formatJC(gross)} bold />
                <p className="mt-2 text-xs leading-relaxed text-slate-500">
                  {side === "sell"
                    ? localizedUiText(language, `확인 후 수량이 온체인 에스크로 컨트랙트에 잠깁니다. 일회성 ${listingFeeText} 주문 수수료(취소 시 환불되지 않음)가 부과되며, 체결 시 ${tradeFeeText} 수수료가 추가됩니다.`, `確認後份額會直接鎖在鏈上託管合約；收取一次性 ${listingFeeText} 掛單費（取消不退），成交再收 ${tradeFeeText}。`)
                    : localizedUiText(language, `확인 후 JC 전액이 온체인 에스크로 컨트랙트에 잠깁니다. 미체결 주문을 취소하면 남은 JC가 반환되며, 체결 시 ${tradeFeeText} 수수료가 부과됩니다.`, `確認後整筆 JC 會鎖在鏈上託管合約；未成交取消時退回剩餘 JC，成交時收取 ${tradeFeeText} 費用。`)}
                </p>
              </div>
              <button type="button" disabled={submitting || orderBlocked || Boolean(pendingEscrowSync) || (side === "sell" && !chainHoldingVerified)} onClick={reviewOrder} className="min-h-11 rounded-xl bg-amber-400 py-3 font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50">
                {submitting ? localizedUiText(language, "처리 중…", "處理中…") : localizedUiText(language, "주문 등록", "掛單")}
              </button>
            </div>
          </aside>
        </div>
        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="font-bold">{localizedUiText(language, "내 주문", "我的掛單")}</h2>
          <div className="mt-4 flex flex-col gap-3">
            {visibleOrders.map((order) => (
              <div key={order.id} className="flex flex-col gap-3 rounded-xl bg-slate-950 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm">
                  <b className={order.side === "buy" ? "text-emerald-300" : "text-red-300"}>{order.side === "buy" ? localizedUiText(language, "매수 주문", "買單") : localizedUiText(language, "매도 주문", "賣單")}</b>
                  <span className="ml-3 text-slate-400">{formatJC(order.price)} × {order.remaining_quantity.toLocaleString()} 份</span>
                  <p className="mt-1 text-xs text-slate-600">{localizedUiText(language, order.status === "open" ? "진행 중" : order.status === "partially_filled" ? "일부 체결" : order.status === "filled" ? "체결 완료" : "취소됨", order.status === "open" ? "進行中" : order.status === "partially_filled" ? "部分成交" : order.status === "filled" ? "已成交" : "已取消")}</p>
                </div>
                {order.status !== "cancelled" && (
                  <button
                    type="button"
                    onClick={() => {
            setCancelError("");
            setOrderToCancel(order);
                    }}
                    className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-bold text-slate-300 hover:border-red-400 hover:text-red-300"
                  >
                    {localizedUiText(language, "주문 취소", "取消掛單")}
                  </button>
                )}
              </div>
            ))}
            {visibleOrders.length === 0 && <p className="py-6 text-center text-sm text-slate-500">{localizedUiText(language, "등록된 주문이 없습니다.", "尚未刊登任何掛單")}</p>}
          </div>
        </section>
        <section className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900">
          <h2 className="p-5 font-bold">{localizedUiText(language, "내 체결 내역", "我的成交紀錄")}</h2>
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="bg-slate-800/50 text-slate-400"><tr><th className="p-3">{localizedUiText(language, "시간", "時間")}</th><th>{localizedUiText(language, "방향", "方向")}</th><th>{localizedUiText(language, "체결 수량", "購買份額")}</th><th>{localizedUiText(language, "거래 금액", "成交額")}</th><th>{localizedUiText(language, "플랫폼 수수료", "平台費")}</th><th>{localizedUiText(language, "정산 금액", "淨額")}</th></tr></thead>
            <tbody>
              {ownTransactions.map((item) => (
                <tr key={item.id} className="border-t border-slate-800"><td className="p-3">{item.date}</td><td>{item.type === "buy" ? localizedUiText(language, "매수", "買入") : localizedUiText(language, "매도", "賣出")}</td><td>{Math.abs(item.quantity ?? 0).toLocaleString()} {localizedUiText(language, "개", "份")}</td><td>{formatJC(item.gross)}</td><td>{formatJC(item.fee)}</td><td>{formatJC(Math.abs(item.net))}</td></tr>
              ))}
            </tbody>
          </table>
          {ownTransactions.length === 0 && <p className="p-8 text-center text-sm text-slate-500">{localizedUiText(language, "체결 내역이 없습니다.", "尚無成交紀錄")}</p>}
        </section>
      </div>
      <Modal open={!!selectedOrder} onClose={() => setSelectedOrder(null)} title={selectedOrder?.side === "sell" ? localizedUiText(language, "매수 확인", "確認購買") : localizedUiText(language, "매도 확인", "確認出售")}>
        {selectedOrder && (
          <div className="flex flex-col gap-4">
            <div className="rounded-xl bg-slate-950 p-4 text-sm">
              <Line a={localizedUiText(language, "주문 가격", "掛單價格")} b={formatJC(selectedOrder.price)} />
              <Line a={localizedUiText(language, "잔여 수량", "剩餘份額")} b={selectedOrder.remaining_quantity.toLocaleString()} />
            </div>
            <label className="text-sm">{localizedUiText(language, "체결 수량", "成交份額")}
                <FormattedNumberInput value={fillQuantity} onValueChange={setFillQuantity} inputMode={asset.isAeToken ? "decimal" : "numeric"} maxDecimals={asset.isAeToken ? 6 : 0} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3" />
            </label>
            <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm">
              <Line a={selectedOrder.side === "sell" ? localizedUiText(language, "매수자 결제 총액", "買方支付總額") : localizedUiText(language, "체결 원금", "成交本金")} b={formatJC(fillGross)} bold />
              {selectedOrder.side === "buy" ? (
                <div className="mt-3 border-t border-amber-400/10 pt-3 text-xs leading-relaxed text-slate-400">
                  {localizedUiText(language, `판매자입니다. 체결 후 JC를 받으며(위 금액에서 ${formatFeePercent(Number(selectedOrder.fee_bps ?? 100))} 에스크로 수수료 차감), 실제 정산 금액은 정산 내역에 표시됩니다. 온체인 가스비는 플랫폼이 부담합니다.`, `您是賣方：成交後會收到 JC（上方金額扣除 ${formatFeePercent(Number(selectedOrder.fee_bps ?? 100))} 代管費），實際淨額會顯示在您的結算明細；鏈上 Gas 由平台代付。`)}
                </div>
              ) : (
                <p className="mt-3 text-sm font-medium leading-relaxed text-slate-950">{localizedUiText(language, "매수자입니다. 위의 체결 총액을 JC로 결제하며 판매자 플랫폼 수수료는 부담하지 않습니다.", "您是買方：以 JC 支付上方成交總額，不負擔賣方平台費。")}</p>
              )}
            </div>
            <button type="button" disabled={submitting || Boolean(pendingEscrowSync)} onClick={() => void fillOrder()} className="min-h-11 rounded-xl bg-amber-400 py-3 font-bold text-slate-950 disabled:bg-amber-300 disabled:text-slate-950 disabled:opacity-100">{localizedUiText(language, "체결 확인", "確認成交")}</button>
          </div>
        )}
      </Modal>
      <TransactionCompletionDialog
        open={!!completedTrade}
        onClose={() => setCompletedTrade(null)}
        assetName={asset.name}
        quantity={completedTrade?.quantity ?? 0}
        paymentJc={completedTrade?.paymentJc ?? 0}
        feeJc={completedTrade?.feeJc ?? 0}
        txHash={completedTrade?.txHash ?? null}
        type={localizedUiText(language, "이차 거래", "二級市場成交")}
      />
      <TradeDetailsDialog
        open={!!confirmingOrder}
        onClose={() => setConfirmingOrder(null)}
        title={localizedUiText(language, "거래 세부 정보", "交易明細")}
        details={confirmingOrder}
        confirmLabel={localizedUiText(language, "주문 등록 확인", "確認掛單")}
        submitting={submitting}
        onConfirm={() => void createOrder()}
      />
      <Modal
        open={!!orderToCancel}
        onClose={() => {
          if (!cancellingOrder) setOrderToCancel(null);
        }}
        title={localizedUiText(language, "주문 취소 확인", "確認取消掛單")}
      >
        <div className="flex flex-col gap-5">
          <p className="text-sm leading-6 text-slate-300">
            {orderToCancel?.side === "sell" ? (
              <>
                {localizedUiText(language, "이 매도 주문을 취소해도 이미 부과된 ", "取消此掛賣單後，已收取的 ")}<strong className="text-amber-200">{formatJC(Number(orderToCancel?.listing_fee ?? 1))}</strong>{localizedUiText(language, " 주문 수수료는 환불되지 않습니다. 주문을 취소하시겠습니까?", " 掛單手續費不予退還。確定要取消掛單嗎？")}
              </>
            ) : (
              localizedUiText(language, "이 매수 주문을 취소하시겠습니까? 미체결 수량에 잠긴 JC는 온체인 컨트랙트를 통해 원래 지갑으로 반환됩니다.", "確定要取消此買單嗎？未成交部分鎖定的 JC 會由鏈上合約退回原錢包。")
            )}
          </p>
          {!walletReady && pendingEscrowSync?.kind !== "cancel" && (
            <p role="status" className="rounded-xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm leading-6 text-amber-100">
              {localizedUiText(language, "서명 준비가 완료되지 않아 취소 거래가 제출되지 않았습니다. 플랫폼 로그인 페이지로 돌아가 로그인한 후 다시 시도해 주세요.", "簽名狀態尚未就緒，取消交易尚未送出。請返回平台登入頁完成登入後再重試。")}
            </p>
          )}
          {cancelError && (
            <p role="alert" className="rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm leading-6 text-red-200">
              {cancelError}
            </p>
          )}
          <div className="flex flex-col-reverse gap-3 sm:flex-row">
            <button
              type="button"
              disabled={cancellingOrder}
              onClick={() => setOrderToCancel(null)}
              className="min-h-11 flex-1 rounded-xl border border-slate-700 py-3 font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              {localizedUiText(language, "닫기", "取消")}
            </button>
            <button
              type="button"
              disabled={
                cancellingOrder ||
                (!walletReady && pendingEscrowSync?.kind !== "cancel")
              }
              onClick={() => void confirmCancelOrder()}
              className="min-h-11 flex-1 rounded-xl bg-amber-400 py-3 font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {cancellingOrder ? localizedUiText(language, "처리 중…", "處理中…") : localizedUiText(language, "확인", "確認")}
            </button>
          </div>
        </div>
      </Modal>
      <Modal open={!!settlement} onClose={() => setSettlement(null)} title={localizedUiText(language, "체결 정산 완료", "成交結算完成")}>
        {settlement && <SettlementDetail settlement={settlement} language={language} />}
      </Modal>
    </div>
  );
}

function OrderSide({ title, orders, action, onSelect, language }: { title: string; orders: P2POrder[]; action: string; onSelect: (order: P2POrder) => void; language: Lang }) {
  return (
    <div className="min-w-0">
      <p className="border-b border-slate-800 px-4 py-3 text-xs font-bold text-slate-500">{title} · {localizedUiText(language, "가격 / 잔여 수량", "價格 / 剩餘份額")}</p>
      <div className="max-h-80 overflow-y-auto">
        {orders.map((order) => (
          <button key={order.id} type="button" disabled={order.is_mine} onClick={() => onSelect(order)} className="flex w-full items-center justify-between gap-3 border-b border-slate-800/60 px-4 py-3 text-left text-xs hover:bg-slate-800/60 disabled:cursor-not-allowed disabled:opacity-40">
            <span className={order.side === "sell" ? "font-mono text-red-300" : "font-mono text-emerald-300"}>{Number(order.price).toFixed(4)}</span>
            <span className="text-slate-400">{Number(order.remaining_quantity).toLocaleString()}</span>
            <span className="font-bold text-amber-200">{order.is_mine ? localizedUiText(language, "내 주문", "我的") : action}</span>
          </button>
        ))}
        {orders.length === 0 && <p className="px-4 py-8 text-center text-xs text-slate-600">{localizedUiText(language, "등록된 주문이 없습니다.", "目前沒有掛單")}</p>}
      </div>
    </div>
  );
}

function SettlementDetail({ settlement, language }: { settlement: Settlement; language: Lang }) {
  const seller = settlement.role === "seller";
  const treasury = useActiveSafeAddress();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-4">
        <ShieldCheck className="size-6 text-emerald-300" />
        <div><b className="text-emerald-200">{localizedUiText(language, "정산이 불변 원장에 기록되었습니다.", "結算已寫入不可變帳本")}</b><p className="text-xs text-slate-400">{settlement.quantity.toLocaleString()} {localizedUiText(language, "개 이전 완료", "份已完成移轉")}</p></div>
      </div>
      <div className="rounded-xl bg-slate-950 p-4 text-sm">
        <Line a={localizedUiText(language, "체결 원금", "成交本金")} b={formatJC(settlement.gross)} />
        {seller && <><Line a={localizedUiText(language, "체결 에스크로 수수료", "成交代管費")} b={`-${formatJC(settlement.platform_fee ?? 0)}`} /><Line a={localizedUiText(language, "판매자 수령 JC", "賣方實收 JC")} b={formatJC(settlement.net ?? 0)} bold /></>}
        {!seller && <Line a={localizedUiText(language, "매수자 결제 총액", "買方支付總額")} b={formatJC(settlement.total ?? settlement.gross)} bold />}
      </div>
      {seller && <div className="flex items-start gap-3 rounded-xl bg-slate-800 p-4 text-xs text-slate-400"><CircleDollarSign className="mt-0.5 size-4 shrink-0 text-amber-300" /><span>{localizedUiText(language, "플랫폼 수수료가 Safe 금고에 반영되었습니다:", "平台費已計入 Safe 金庫：")} <span className="break-all font-mono text-slate-300">{treasury}</span></span></div>}
    </div>
  );
}

function Line({ a, b, bold = false }: { a: string; b: string; bold?: boolean }) {
  return <p className={`flex justify-between gap-4 py-1 ${bold ? "font-bold text-slate-100" : "text-slate-400"}`}><span>{a}</span><span className="text-right">{b}</span></p>;
}
