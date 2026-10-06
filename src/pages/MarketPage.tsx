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
  useLanguage,
  usePlatform,
  type Asset,
} from "@/platform";
import { Modal, Notice } from "@/components/Modal";
import { SearchSuggest } from "@/components/SearchSuggest";
import { MarketCandlestickChart } from "@/components/MarketCandlestickChart";
import { ClickableAssetImage } from "@/components/AssetImageGallery";
import { AssetDetails } from "@/components/AssetDetails";
import { FormattedNumberInput } from "@/components/FormattedNumberInput";
import { TradeDetailsDialog, type TradeDetails } from "@/components/TradeDetailsDialog";
import { useVisiblePolling } from "@/hooks/useVisiblePolling";
import { supabase } from "@/lib/supabase";
import { callRelayer, useOnchainSettlement, syncHoldingFromChain } from "@/lib/onchainSettlement";
import { AE_TOKEN_CANONICAL_ID } from "@/lib/aeToken";
import { CONTRACT_ADDRESSES, P2P_ESCROW_ADDRESS } from "@/lib/contracts";
import { keccak256, toBytes } from "viem";

const TREASURY = CONTRACT_ADDRESSES.safeVault;

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
  escrow_mode?: "legacy" | "escrow";
};

type Settlement = {
  role: "buyer" | "seller";
  gross: number;
  total?: number;
  platform_fee?: number;
  net?: number;
  quantity: number;
};

const errorText: Record<string, string> = {
  "not authenticated": "登入狀態已失效，請重新登入",
  "invalid quantity": "請輸入有效的整數份額",
  "invalid price": "單價無效，請輸入正確金額後重新送出",
  "opposite side order exists": "同一標的不可雙向掛單，請先取消或等待另一方向掛單成交",
  "insufficient shares": "可掛出份額不足，無法掛賣單",
  "insufficient listing fee": "可用 JC 不足以支付 1 JC 掛單手續費，請先在錢包金庫購買 JC",
  "minimum trade 2 jc": "每次成交金額最低為 2 JC",
  "secondary market unavailable": "此標的尚未開放二級市場",
  "order unavailable": "掛單已取消或已成交完畢",
  "cannot fill own order": "不能成交自己的掛單",
  "insufficient order quantity": "掛單剩餘份額不足",
  "buyer insufficient balance": "買方 JC 餘額不足",
  "seller insufficient holdings": "賣方持有份額不足",
  "jc price unavailable": "JC 單價暫時無法取得，請稍後再試",
  "trade too small": "成交金額不足以支付賣方費用",
};

export function MarketPage() {
  const { t, tr, language, assets: localizedAssets } = useLanguage();
  const { assets: platformAssets } = usePlatform();
  const assets = platformAssets.map((asset) => {
    const localized = localizedAssets.find((item) => item.id === asset.id);
    const translation =
      asset.translations?.[language] ?? asset.translations?.["zh-TW"];
    return {
      ...(localized ?? asset),
      ...asset,
      name: translation?.name?.trim() || localized?.name || asset.name,
      location:
        translation?.location?.trim() || localized?.location || asset.location,
      information: translation?.information?.trim() || asset.information,
    };
  });
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
  const resolveAsset = (assetId: string) => {
    const asset = assets.find((item) => item.id === assetId);
    return asset?.isAeToken ? canonicalAeToken : asset;
  };
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
  }, [platformAssets]);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-amber-300">
          <Users className="size-4" />
          <p className="text-xs font-bold uppercase tracking-[.22em]">
            Human-to-human market
          </p>
        </div>
        <h1 className="text-3xl font-bold text-balance">{t("market")}</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-slate-400">
          同標的、同計價幣且跨錢包的掛單，買方出價達到賣價時會依價格與時間優先自動撮合；未成交部分仍由合約託管並留在訂單簿。賣方掛單一次性收取 1 JC（取消不退），成交另收 1% 費用，鏈上 Gas 由平台代付。
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
            {item === "all" ? tr("all") : item === "up" ? tr("rising") : tr("falling")}
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
          目前沒有符合條件的二級市場標的
        </div>
      )}
      {selectedAsset && (
        <MarketDetail asset={selectedAsset} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

function MarketCard({ asset, onOpen }: { asset: Asset; onOpen: () => void }) {
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
          <p className="mt-1 flex items-center gap-1 text-xs text-slate-400">
            <MapPin className="size-3" /> {asset.location}
          </p>
        </div>
        <div className="flex items-end justify-between">
          <div>
            <p className="text-xs text-slate-500">{hasTraded ? "現價（最新成交價）" : asset.isAeToken ? "認購原價" : "參考價格（JC）"}</p>
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
          進入市場 <ChevronRight className="size-4" />
        </button>
      </div>
    </article>
  );
}

function MarketDetail({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const {
    jcOnChainBalance,
    jcOnChainLoading,
    jcOnChainError,
    holdings,
    transactions,
    refresh: refreshPlatform,
  } = usePlatform();
  const { createEscrowOrder, fillEscrowOrder, cancelEscrowOrder } = useOnchainSettlement();
  // 全站二級市場以 JC 計價結算：���方付 JC、賣方收 JC，平台費以 JC 收取；鏈上 Gas 由平台代付。
  const [orders, setOrders] = useState<P2POrder[]>([]);
  const [myOrders, setMyOrders] = useState<P2POrder[]>([]);
  const [side, setSide] = useState<"buy" | "sell">("sell");
  // AE 代幣掛單價格由買賣雙方���行輸入，預設帶入最新成交價（尚無成交時退回認購原價）；
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
  const [orderToCancel, setOrderToCancel] = useState<P2POrder | null>(null);
  const [cancellingOrder, setCancellingOrder] = useState(false);
  const [pendingEscrowSync, setPendingEscrowSync] = useState<{
    kind: "order" | "fill" | "cancel";
    txHash: string;
    orderId?: string;
  } | null>(null);
  const owned = holdings.find((item) => item.assetId === asset.id)?.tokens ?? 0;
  // 二級市場份額精度：RWA（非 AE）必須整數；AE 允許小數（最多 6 位）。
  const quantityValid = (q: number) =>
    Number.isFinite(q) &&
    q > 0 &&
    q <= 1_000_000 &&
    (asset.isAeToken ? Math.round(q * 1e6) / 1e6 === q : Number.isInteger(q));
  const invalidQuantityText = asset.isAeToken
    ? "請輸入有效份額（AE 最多 6 位小數）"
    : "請輸入有效的整數份額";

  const refreshOrders = useCallback(async () => {
    const [{ data: book }, { data: mine }] = await Promise.all([
      supabase.rpc("get_p2p_order_book", { asset_key: asset.id }),
      supabase.rpc("get_my_p2p_orders"),
    ]);
    setOrders((book as P2POrder[] | null) ?? []);
    setMyOrders(
      ((mine as P2POrder[] | null) ?? []).filter(
        (order) => order.asset_id === asset.id,
      ),
    );
  }, [asset.id]);
  useVisiblePolling(refreshOrders, 2_000, true);

  // 進入標的詳情時，把「從 Safe 金庫直接鏈上轉入、繞過站內帳本」的份額同步回
  // holdings 帳本，讓掛賣單的「持有份額」與二級市場可交易額度反映錢包鏈上真實
  // 持有。僅對已部署專屬代幣的 RWA 標的有效（AE 由後端略過）。同步成功後刷新
  // 平台資料，讓下方的 owned 立即更新。
  useEffect(() => {
    if (asset.isAeToken || !asset.tokenAddress) return;
    let cancelled = false;
    (async () => {
      const result = await syncHoldingFromChain(asset.id);
      if (!cancelled && result.synced) await refreshPlatform();
    })();
    return () => {
      cancelled = true;
    };
    // 僅在標的切換時同步一次；refreshPlatform 刻意不列入依賴以避免每次 render 重跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.id, asset.isAeToken, asset.tokenAddress]);

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
        (order) => order.status === "open" || order.status === "partially_filled",
      ),
    [myOrders],
  );
  // 已完全成交的掛單改到「我的成交紀錄」呈現，已取消的掛單也不再需要追蹤，
  // 「我的掛單」只留下仍需追蹤的狀態（open / partially_filled）。
  const visibleOrders = useMemo(
    () =>
      myOrders.filter(
        (order) => order.status !== "filled" && order.status !== "cancelled",
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
  const sellableShares = Math.max(owned - reservedForSell, 0);
  const noSharesForSell = side === "sell" && sellableShares <= 0;
  const orderBlocked = hasOppositeOrder || noSharesForSell;
  const blockedReason = hasOppositeOrder
    ? `你���此標的已有未完成的${oppositeSide === "buy" ? "買" : "賣"}單，同一標的不可雙向掛單；請先取消或等待成��。`
    : noSharesForSell
      ? owned > 0
        ? "你的可用份額已全部掛在賣單中，沒有可�����掛出的份額。"
        : "你沒有持有此標的份額，無法掛賣單。"
      : "";

  // 掛單前先顯示交易明細：賣方掛單時收取一次性 1 JC，成交時另收成交額 1% 代管費；鏈上 Gas 由平台代付。
  const reviewOrder = () => {
    if (submitting) return;
    const parsedQuantity = Number(quantity);
    if (!Number.isFinite(price) || price <= 0) {
      setNotice({
        text: asset.isAeToken ? "請輸入有效的單價" : "平台參考價異常，暫時無法掛單",
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
        text: `可掛出份額不足，目前最多可掛 ${sellableShares.toLocaleString()} 份`,
        ok: false,
      });
      return;
    }
    if (gross < 2) {
      setNotice({
        text: "掛單總額最低為 2 JC",
        ok: false,
      });
      return;
    }
    const sell = side === "sell";
    setConfirmingOrder({
      assetName: asset.name,
      quantity: parsedQuantity,
      fee: sell
        ? "掛單時收取 1 JC；成交時另收成交金額的 1% 代管費"
        : `${formatJC(0)}（買方免手續費）`,
      total: formatJC(gross),
      note: `${sell ? "掛賣單" : "掛買單"} · 單價 ${formatJC(price)}${asset.isAeToken ? "（AE 代幣單價由您自訂）" : "（平台參考價，不可修改）"}。掛單確認後，賣單會鎖定份額、買單會鎖定 JC；賣單收取一次性 1 JC（取消不退），每筆成交另收 1% 費用。相反方向的合格掛單會依價格優先、時間優先自動撮合，成交價採較早掛出的限價；未成交部分繼續留在訂單簿。`,
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
      setNotice({ text: "鏈上交易已同步到掛單簿與帳本。", ok: true });
      await Promise.all([refreshOrders(), refreshPlatform()]);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "同步仍未完成，請稍後重試", ok: false });
    } finally {
      setSubmitting(false);
    }
  };

  const createOrder = async () => {
    if (submitting || pendingEscrowSync) return;
    const parsedQuantity = Number(quantity);
    if (!P2P_ESCROW_ADDRESS) {
      setNotice({ text: "二級市場託管合約尚未部署，暫時無法建立掛單。", ok: false });
      return;
    }
    if (
      !Number.isFinite(price) || price <= 0 || !quantityValid(parsedQuantity) ||
      gross < 2 || orderBlocked || (side === "sell" && parsedQuantity > sellableShares)
    ) {
      setConfirmingOrder(null);
      setNotice({ text: "掛單條件已變更，請重新確認", ok: false });
      return;
    }
    const assetToken = asset.isAeToken ? CONTRACT_ADDRESSES.aeToken : asset.tokenAddress;
    if (!assetToken) {
      setNotice({ text: "此 RWA 標的尚未部署專屬代幣，無法建立託管掛單。", ok: false });
      return;
    }

    setConfirmingOrder(null);
    setSubmitting(true);
    const requestKey = crypto.randomUUID();
    const clientOrderId = keccak256(toBytes(requestKey));
    let reserved = false;
    let txHash: string | null = null;
    try {
      const { error: reserveError } = await supabase.rpc("reserve_p2p_escrow_order", {
        p_asset_key: asset.id,
        p_side: side,
        p_price: price.toFixed(6),
        p_quantity: quantity,
        p_request_key: requestKey,
        p_client_order_id: clientOrderId,
      });
      if (reserveError) throw new Error(errorText[reserveError.message] ?? reserveError.message);
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
      setNotice({
        text: matchedCount > 0
          ? `掛單已建立並自動撮合 ${matchedCount} 筆；未成交部分仍保留於訂單簿。${side === "sell" ? "一次性 1 JC 掛單費已直接進入 Safe，取消不退。" : "未成交 JC 會在取消時退回。"}`
          : `掛單已建立，尚無可成交的相反掛單；未成交部分保留於訂單簿。${side === "sell" ? "一次性 1 JC 掛單費已直接進入 Safe，取消不退。" : "未成交 JC 會在取消時退回。"}`,
        ok: true,
      });
      await Promise.all([refreshOrders(), refreshPlatform()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "掛單流程未完成";
      const submittedHash = txHash ?? submittedTransactionHash(error);
      if (submittedHash && !transactionReverted(error)) {
        setPendingEscrowSync({ kind: "order", txHash: submittedHash });
        setNotice({ text: `鏈上掛單已提交，但資料同步尚未完成。${message}`, ok: false });
      } else {
        if (reserved) {
          const { error: releaseError } = await supabase.rpc("release_p2p_escrow_order_reservation", { p_request_key: requestKey });
          if (releaseError) {
            setNotice({ text: `${message}；JC／份額預留尚未釋回，請稍後重試或聯絡管理員。`, ok: false });
            return;
          }
        }
        setNotice({
          text: transactionReverted(error)
            ? `${message}；鏈上交易已回滾，平台預留已釋回。`
            : reserved
              ? `掛單未送上鏈；平台預留已釋回。${message}`
              : message,
          ok: false,
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const confirmCancelOrder = async () => {
    if (!orderToCancel || cancellingOrder || pendingEscrowSync) return;
    const order = orderToCancel;
    if (!order.escrow_chain_order_id) {
      setNotice({ text: "此掛單不是託管掛單；舊掛單已停用，請重新整理。", ok: false });
      return;
    }
    setCancellingOrder(true);
    try {
      const txHash = await cancelEscrowOrder(String(order.escrow_chain_order_id));
      setPendingEscrowSync({ kind: "cancel", txHash, orderId: order.id });
      await callRelayer("register-escrow-cancel", { txHash });
      setPendingEscrowSync(null);
      setNotice({
        text: order.side === "sell"
          ? "已取消掛單並取回未成交份額；一次性 1 JC 掛單費不退還。"
          : "已取消買單並取回未成交 JC。",
        ok: true,
      });
      setOrderToCancel(null);
      await refreshOrders();
    } catch (error) {
      const message = error instanceof Error ? error.message : "取消流程未完成，請稍後重試";
      const submittedHash = submittedTransactionHash(error);
      if (submittedHash && !transactionReverted(error)) {
        setPendingEscrowSync({ kind: "cancel", txHash: submittedHash, orderId: order.id });
        setNotice({ text: `取消交易已提交，收據或帳本同步尚未���成。${message}`, ok: false });
      } else {
        setNotice({ text: message, ok: false });
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
        text: asset.isAeToken ? "請輸入不超過剩餘份額的有效數量（最多 6 位小數）" : "請輸入不超過剩餘份額的整數",
        ok: false,
      });
      return;
    }
    if (fillGross < 2 || !selectedOrder.escrow_chain_order_id) {
      setNotice({ text: "此掛單尚未完成鏈上託管，請重新整理後再試。", ok: false });
      return;
    }
    const assetToken = asset.isAeToken ? CONTRACT_ADDRESSES.aeToken : asset.tokenAddress;
    if (!assetToken) {
      setNotice({ text: "此標的尚未建立專屬鏈上代幣，無法成交。", ok: false });
      return;
    }

    setSubmitting(true);
    const fillKey = crypto.randomUUID();
    const takerSide: "buy" | "sell" = selectedOrder.side === "sell" ? "buy" : "sell";
    let txHash: string | null = null;
    try {
      txHash = await fillEscrowOrder({
        orderId: String(selectedOrder.escrow_chain_order_id),
        orderSide: selectedOrder.side,
        assetToken,
        price: selectedOrder.price.toFixed(6),
        quantity: fillQuantity,
        fillKey,
      });
      setPendingEscrowSync({ kind: "fill", txHash, orderId: selectedOrder.id });
      const result = await callRelayer("settle-escrow-fill", { txHash });
      setPendingEscrowSync(null);
      const fee = Number((fillGross * 0.01).toFixed(6));
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
      setNotice({
        text: finalized
          ? `鏈上成交與正式帳本均已完成（Tx: ${txHash.slice(0, 10)}…）。`
          : `鏈上成交已完成，但正式帳本同步仍在處理中（Tx: ${txHash.slice(0, 10)}…）。請勿重複成交。`,
        ok: finalized,
      });
      await Promise.all([refreshOrders(), refreshPlatform()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "成交流程未完成";
      const submittedHash = txHash ?? submittedTransactionHash(error);
      if (submittedHash && !transactionReverted(error)) {
        setPendingEscrowSync({ kind: "fill", txHash: submittedHash, orderId: selectedOrder.id });
        setNotice({ text: `成交交易已提交，收據或帳本同步尚未完成。${message}`, ok: false });
        setSelectedOrder(null);
      } else {
        setNotice({ text: message, ok: false });
      }
    } finally {
      setSubmitting(false);
    }
  };




  const ownTransactions = transactions.filter((item) => item.assetId === asset.id);

  // z-[55] 蓋住 z-50 的手機底部導覽列，避免導覽列浮在���場詳情內容上方。
  return (
    <div className="fixed inset-0 z-[55] overflow-y-auto bg-slate-950 pb-[env(safe-area-inset-bottom)] lg:left-60">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-5 sm:px-8 sm:py-8">
        <button type="button" onClick={onClose} className="flex w-fit items-center gap-2 text-sm text-slate-400 hover:text-slate-100">
          <ArrowLeft className="size-4" /> 返回市場
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
                  ? "現價（最新成交價，二級市場價格由買賣雙方自訂）"
                  : "認購原價（尚無成交，二級市場價格由買賣雙方自訂）"
                : "平台參考價（JC 計價）"}
            </p>
            <p className="text-3xl font-bold">{formatJC(currentMarketPrice(asset))}</p>
          </div>
        </header>
        <AssetDetails asset={asset} />
        {notice && (
          <div className="flex flex-col gap-2">
            <Notice message={notice.text} tone={notice.ok ? "success" : "error"} />
            {pendingEscrowSync && (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-sm">
                <a
                  href={`https://sepolia.basescan.org/tx/${pendingEscrowSync.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-amber-200 underline underline-offset-4"
                >
                  檢視鏈上交易
                </a>
                <button
                  type="button"
                  onClick={() => void retryEscrowSync()}
                  disabled={submitting}
                  className="rounded-lg bg-amber-400 px-3 py-2 font-bold text-slate-950 disabled:opacity-50"
                >
                  {submitting ? "同步中…" : "重試資料同步"}
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
                  <h2 className="font-bold">掛單現況</h2>
                </div>
                <span className="rounded-full border border-emerald-400/30 px-3 py-1 text-xs text-emerald-300">鏈上託管</span>
              </div>
              <div className="grid sm:grid-cols-2 sm:divide-x sm:divide-slate-800">
                <OrderSide title="賣單" orders={asks} action="購買" onSelect={setSelectedOrder} />
                <OrderSide title="買單" orders={bids} action="出售" onSelect={setSelectedOrder} />
              </div>
            </section>
          </div>
          <aside className="h-fit rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <div className="grid grid-cols-2 rounded-xl bg-slate-800 p-1">
              {(["buy", "sell"] as const).map((item) => (
                <button key={item} type="button" onClick={() => setSide(item)} className={`rounded-lg py-2 font-bold ${side === item ? item === "buy" ? "bg-emerald-500 text-slate-950" : "bg-red-500 text-slate-950" : "text-slate-400"}`}>
                  掛{item === "buy" ? "買" : "賣"}單
                </button>
              ))}
            </div>
            <div className="mt-5 flex flex-col gap-4">
              <Line a="可用 JC" b={jcOnChainLoading ? "讀取中…" : jcOnChainError ? "讀取失敗" : formatJC(jcOnChainBalance)} />
              <Line a="持有份額" b={owned.toLocaleString()} />
              <div className="text-sm">
                <p>單價（JC）</p>
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
                    <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-400">固定價</span>
                  </div>
                )}
              </div>
              <label className="text-sm">掛單份額
                <FormattedNumberInput value={quantity} onValueChange={setQuantity} inputMode={asset.isAeToken ? "decimal" : "numeric"} maxDecimals={asset.isAeToken ? 6 : 0} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3" />
                {side === "sell" && (
                  <span className="mt-2 block text-xs text-slate-500">可掛出份額 {sellableShares.toLocaleString()} 份{reservedForSell > 0 ? `（已有 ${reservedForSell.toLocaleString()} 份掛在賣單中）` : ""}</span>
                )}
              </label>
              {orderBlocked && (
                <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-xs leading-relaxed text-amber-200">{blockedReason}</p>
              )}
              <div className="rounded-xl bg-slate-950 p-4 text-sm">
                <Line a="掛單總額" b={formatJC(gross)} bold />
                <p className="mt-2 text-xs leading-relaxed text-slate-500">
                  {side === "sell"
                    ? "確認後份額會直接鎖在鏈上託管合約；收取一次性 1 JC 掛單費（取消不退），成交再收 1%。"
                    : "確認後整筆 JC 會鎖在鏈上託管合約；未成交取消時退回剩餘 JC，成交時收取 1% 費用。"}
                </p>
              </div>
              <button type="button" disabled={submitting || orderBlocked || Boolean(pendingEscrowSync)} onClick={reviewOrder} className="min-h-11 rounded-xl bg-amber-400 py-3 font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50">
                {submitting ? "處理中…" : "掛單"}
              </button>
            </div>
          </aside>
        </div>
        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="font-bold">我的掛單</h2>
          <div className="mt-4 flex flex-col gap-3">
            {visibleOrders.map((order) => (
              <div key={order.id} className="flex flex-col gap-3 rounded-xl bg-slate-950 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm">
                  <b className={order.side === "buy" ? "text-emerald-300" : "text-red-300"}>{order.side === "buy" ? "買單" : "賣單"}</b>
                  <span className="ml-3 text-slate-400">{formatJC(order.price)} × {order.remaining_quantity.toLocaleString()} 份</span>
                  <p className="mt-1 text-xs text-slate-600">{order.status}</p>
                </div>
                {order.status !== "cancelled" && (
                  <button
                    type="button"
                    onClick={() => setOrderToCancel(order)}
                    className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-bold text-slate-300 hover:border-red-400 hover:text-red-300"
                  >
                    取消掛單
                  </button>
                )}
              </div>
            ))}
            {visibleOrders.length === 0 && <p className="py-6 text-center text-sm text-slate-500">尚未刊登任何掛單</p>}
          </div>
        </section>
        <section className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900">
          <h2 className="p-5 font-bold">我的成交紀錄</h2>
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="bg-slate-800/50 text-slate-400"><tr><th className="p-3">時間</th><th>方向</th><th>購買份額</th><th>成交額</th><th>平台費</th><th>淨額</th></tr></thead>
            <tbody>
              {ownTransactions.map((item) => (
                <tr key={item.id} className="border-t border-slate-800"><td className="p-3">{item.date}</td><td>{item.type === "buy" ? "買入" : "賣出"}</td><td>{Math.abs(item.quantity ?? 0).toLocaleString()} 份</td><td>{formatJC(item.gross)}</td><td>{formatJC(item.fee)}</td><td>{formatJC(Math.abs(item.net))}</td></tr>
              ))}
            </tbody>
          </table>
          {ownTransactions.length === 0 && <p className="p-8 text-center text-sm text-slate-500">尚無成交紀錄</p>}
        </section>
      </div>
      <Modal open={!!selectedOrder} onClose={() => setSelectedOrder(null)} title={selectedOrder?.side === "sell" ? "確認購買" : "確認出售"}>
        {selectedOrder && (
          <div className="flex flex-col gap-4">
            <div className="rounded-xl bg-slate-950 p-4 text-sm">
              <Line a="掛單價格" b={formatJC(selectedOrder.price)} />
              <Line a="剩餘份額" b={selectedOrder.remaining_quantity.toLocaleString()} />
            </div>
            <label className="text-sm">成交份額
                <FormattedNumberInput value={fillQuantity} onValueChange={setFillQuantity} inputMode={asset.isAeToken ? "decimal" : "numeric"} maxDecimals={asset.isAeToken ? 6 : 0} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3" />
            </label>
            <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm">
              <Line a={selectedOrder.side === "sell" ? "買方支付總額" : "成交本金"} b={formatJC(fillGross)} bold />
              {selectedOrder.side === "buy" ? (
                <div className="mt-3 border-t border-amber-400/10 pt-3 text-xs leading-relaxed text-slate-400">
                  您是賣方：成交後將收到 JC（上方金額扣除 1% 代管費），實際淨額會顯示於您的結算明細；鏈上 Gas 由平台代付。
                </div>
              ) : (
                <p className="mt-3 text-xs leading-relaxed text-slate-400">您是買方：以 JC 支付上方成交總額，不負擔賣方平台費。</p>
              )}
            </div>
            <button type="button" disabled={submitting || Boolean(pendingEscrowSync)} onClick={() => void fillOrder()} className="min-h-11 rounded-xl bg-amber-400 py-3 font-bold text-slate-950 disabled:opacity-50">確認成交</button>
          </div>
        )}
      </Modal>
      <TradeDetailsDialog
        open={!!confirmingOrder}
        onClose={() => setConfirmingOrder(null)}
        title="交易明細"
        details={confirmingOrder}
        confirmLabel="確認掛單"
        submitting={submitting}
        onConfirm={() => void createOrder()}
      />
      <Modal
        open={!!orderToCancel}
        onClose={() => {
          if (!cancellingOrder) setOrderToCancel(null);
        }}
        title="確認取消掛單"
      >
        <div className="flex flex-col gap-5">
          <p className="text-sm leading-6 text-slate-300">
            {orderToCancel?.side === "sell" ? (
              <>
                取消此掛賣單後，已收取的 <strong className="text-amber-200">1 JC</strong> 掛單手續費不予退還。確定要取消掛單嗎？
              </>
            ) : (
              "確定要取消此買單嗎？未成交部分鎖定的 JC 會由鏈上合約退回原錢包。"
            )}
          </p>
          <div className="flex flex-col-reverse gap-3 sm:flex-row">
            <button
              type="button"
              disabled={cancellingOrder}
              onClick={() => setOrderToCancel(null)}
              className="min-h-11 flex-1 rounded-xl border border-slate-700 py-3 font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              取��
            </button>
            <button
              type="button"
              disabled={cancellingOrder || Boolean(pendingEscrowSync)}
              onClick={() => void confirmCancelOrder()}
              className="min-h-11 flex-1 rounded-xl bg-amber-400 py-3 font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {cancellingOrder ? "處理中…" : "確認"}
            </button>
          </div>
        </div>
      </Modal>
      <Modal open={!!settlement} onClose={() => setSettlement(null)} title="成交結算完成">
        {settlement && <SettlementDetail settlement={settlement} />}
      </Modal>
    </div>
  );
}

function OrderSide({ title, orders, action, onSelect }: { title: string; orders: P2POrder[]; action: string; onSelect: (order: P2POrder) => void }) {
  return (
    <div className="min-w-0">
      <p className="border-b border-slate-800 px-4 py-3 text-xs font-bold text-slate-500">{title} · 價格 / 剩餘份額</p>
      <div className="max-h-80 overflow-y-auto">
        {orders.map((order) => (
          <button key={order.id} type="button" disabled={order.is_mine} onClick={() => onSelect(order)} className="flex w-full items-center justify-between gap-3 border-b border-slate-800/60 px-4 py-3 text-left text-xs hover:bg-slate-800/60 disabled:cursor-not-allowed disabled:opacity-40">
            <span className={order.side === "sell" ? "font-mono text-red-300" : "font-mono text-emerald-300"}>{Number(order.price).toFixed(4)}</span>
            <span className="text-slate-400">{Number(order.remaining_quantity).toLocaleString()}</span>
            <span className="font-bold text-amber-200">{order.is_mine ? "我的" : action}</span>
          </button>
        ))}
        {orders.length === 0 && <p className="px-4 py-8 text-center text-xs text-slate-600">目前沒有掛單</p>}
      </div>
    </div>
  );
}

function SettlementDetail({ settlement }: { settlement: Settlement }) {
  const seller = settlement.role === "seller";
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-4">
        <ShieldCheck className="size-6 text-emerald-300" />
        <div><b className="text-emerald-200">結算已寫入不可變帳本</b><p className="text-xs text-slate-400">{settlement.quantity.toLocaleString()} 份已完成移轉</p></div>
      </div>
      <div className="rounded-xl bg-slate-950 p-4 text-sm">
        <Line a="成交本金" b={formatJC(settlement.gross)} />
        {seller && <><Line a="成交代管費（1%）" b={`-${formatJC(settlement.platform_fee ?? 0)}`} /><Line a="賣方實收 JC" b={formatJC(settlement.net ?? 0)} bold /></>}
        {!seller && <Line a="買方支付總額" b={formatJC(settlement.total ?? settlement.gross)} bold />}
      </div>
      {seller && <div className="flex items-start gap-3 rounded-xl bg-slate-800 p-4 text-xs text-slate-400"><CircleDollarSign className="mt-0.5 size-4 shrink-0 text-amber-300" /><span>平台��已計入 Safe 金庫：<span className="break-all font-mono text-slate-300">{TREASURY}</span></span></div>}
    </div>
  );
}

function Line({ a, b, bold = false }: { a: string; b: string; bold?: boolean }) {
  return <p className={`flex justify-between gap-4 py-1 ${bold ? "font-bold text-slate-100" : "text-slate-400"}`}><span>{a}</span><span className="text-right">{b}</span></p>;
}
