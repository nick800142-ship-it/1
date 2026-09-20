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
import { useOnchainSettlement } from "@/lib/onchainSettlement";
import { AE_TOKEN_CANONICAL_ID } from "@/lib/aeToken";
import { CONTRACT_ADDRESSES } from "@/lib/contracts";

const TREASURY = CONTRACT_ADDRESSES.safeVault;

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
          真人用戶自行掛單、指定成交。掛單與取消完全鏈下，不扣款、不產生 Gas。
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
  const { jcBalance, holdings, transactions, refresh: refreshPlatform } = usePlatform();
  const { approveForOrder, settleTrade } = useOnchainSettlement();
  // 全站二級市場以 JC 計價結算：買方付 JC、賣方收 JC，平台費以 JC 收取；鏈上 Gas 由平台代付。
  const [orders, setOrders] = useState<P2POrder[]>([]);
  const [myOrders, setMyOrders] = useState<P2POrder[]>([]);
  const [side, setSide] = useState<"buy" | "sell">("sell");
  // AE 代幣掛單價格由買賣雙方自行輸入，預設帶入最新成交價（尚無成交時退回認購原價）；
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
  const owned = holdings.find((item) => item.assetId === asset.id)?.tokens ?? 0;

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
    ? `你在此標的已有未完成的${oppositeSide === "buy" ? "買" : "賣"}單，同一標的不可雙向掛單；請先取消或等待成交。`
    : noSharesForSell
      ? owned > 0
        ? "你的可用份額已全部掛在賣單中，沒有可再掛出的份額。"
        : "你沒有持有此標的份額，無法掛賣單。"
      : "";

  // 掛單前先顯示交易明細，賣方需負擔平台費（成交額 1%＋1 JC）；鏈上 Gas 由平台代付。
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
    if (!Number.isSafeInteger(parsedQuantity) || parsedQuantity <= 0) {
      setNotice({ text: "請輸入有效的整數份額", ok: false });
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
        ? `成交時 ${formatJC(gross * 0.01 + 1)}（成交額 1%＋1 JC）`
        : `${formatJC(0)}（買方免手續費）`,
      total: formatJC(gross),
      note: `${sell ? "掛賣單" : "掛買單"} · 單價 ${formatJC(price)}${asset.isAeToken ? "（AE 代幣單價由您自訂）" : "（平台參考價，不可修改）"}。買方付 JC、賣方收 JC；平台費以 JC 結算，鏈上 Gas 由平台代付。掛單階段不鎖定資金或份額、不扣款；上述費用於實際成交時才收取。`,
    });
  };

  const createOrder = async () => {
    if (submitting) return;
    const parsedQuantity = Number(quantity);
    // 明細視窗開啟期間表單與掛單簿仍可能變動，送出前再次驗���。
    if (
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isSafeInteger(parsedQuantity) ||
      parsedQuantity <= 0 ||
      gross < 2 ||
      orderBlocked ||
      (side === "sell" && parsedQuantity > sellableShares)
    ) {
      setConfirmingOrder(null);
      setNotice({ text: "掛單條件已變��，請重新確認", ok: false });
      return;
    }
    setConfirmingOrder(null);
    setSubmitting(true);
    // 掛單前先做鏈上預先授權：賣單授權二級市場動用標的代幣（RWA / AE）、買單
    // 授權動用 JC，讓日後被成交時 relayer 的 executeTrade 能 transferFrom 這一側。
    // 盡力而為，失敗不阻擋掛單（成交時會再嘗試補授權）。
    try {
      await approveForOrder(side, asset.isAeToken);
    } catch {
      /* 授權失敗不阻擋站內掛單；成交時會再嘗試補授權 */
    }
    const { data, error } = await supabase.rpc("create_p2p_order", {
      asset_key: asset.id,
      order_side: side,
      order_price: price,
      order_quantity: parsedQuantity,
      request_key: crypto.randomUUID(),
    });
    setSubmitting(false);
    const result = data as { matched_quantity?: number; remaining_quantity?: number } | null;
    const matchedQuantity = Number(result?.matched_quantity ?? 0);
    setNotice({
      text: error
        ? errorText[error.message] ?? "掛單失敗，請稍後再試"
        : matchedQuantity > 0
          ? `已自動撮合 ${matchedQuantity.toLocaleString()} 份${Number(result?.remaining_quantity ?? 0) > 0 ? "，剩餘份額已掛單" : ""}`
          : "掛單成功；掛單不扣款、不產生 Gas",
      ok: !error,
    });
    if (!error) await Promise.all([refreshOrders(), refreshPlatform()]);
  };

  const cancelOrder = async (id: string) => {
    const { error } = await supabase.rpc("cancel_p2p_order", { order_key: id });
    setNotice({ text: error ? errorText[error.message] ?? "取消失敗" : "已取消掛單，未產生任何費用", ok: !error });
    if (!error) await refreshOrders();
  };

  const fillOrder = async () => {
    if (!selectedOrder || submitting) return;
    const units = Number(fillQuantity);
    if (!Number.isSafeInteger(units) || units <= 0 || units > selectedOrder.remaining_quantity) {
      setNotice({ text: "請輸入不超過剩餘份額的整數", ok: false });
      return;
    }
    if (fillGross < 2) {
      setNotice({
        text: "每次成交金額最低為 2 JC",
        ok: false,
      });
      return;
    }
    setSubmitting(true);
    const fillRequestKey = crypto.randomUUID();
    // taker 在這筆成交中的角色：填賣單 → taker 是買方；填買單 → taker 是賣方。
    const takerSide: "buy" | "sell" = selectedOrder.side === "sell" ? "buy" : "sell";
    const { data, error } = await supabase.rpc("fill_p2p_order", {
      order_key: selectedOrder.id,
      fill_quantity: units,
      request_key: fillRequestKey,
    });
    setSubmitting(false);
    if (error) {
      setNotice({ text: errorText[error.message] ?? "成交失敗，請稍後再試", ok: false });
      return;
    }
    setSettlement(data as Settlement);
    setSelectedOrder(null);
    // 站內成交已完成；再由 relayer（合約 owner）代發 executeTrade 做真實鏈上結算：
    // taker 先補上自己這側授權，relayer 於伺服器端讀出買賣雙方地址與金額後撮合
    // （RWA 走 RWA 市場、AE 走 AE 市場）。失敗不回退站內結果，只附註鏈上狀態。
    let tradeNote = "";
    try {
      const res = await settleTrade(fillRequestKey, takerSide, asset.isAeToken);
      const txHash = typeof res.tx_hash === "string" ? res.tx_hash : null;
      tradeNote = txHash ? `（鏈上結算 Tx: ${txHash.slice(0, 10)}…）` : "（鏈上結算處理中）";
    } catch (tradeError) {
      tradeNote = `（鏈上結算未完成：${tradeError instanceof Error ? tradeError.message : "稍後可重試"}）`;
    }
    setNotice({ text: `真人 P2P 成交完成${tradeNote}`, ok: true });
    await Promise.all([refreshOrders(), refreshPlatform()]);
  };

  const ownTransactions = transactions.filter((item) => item.assetId === asset.id);

  // z-[55] 蓋住 z-50 的手機底部導覽列，避免導覽列浮在市場詳情內容上方。
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
        {notice && <Notice message={notice.text} tone={notice.ok ? "success" : "error"} />}
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <div className="flex flex-col gap-6">
            <MarketCandlestickChart asset={asset} />
            <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
              <div className="flex items-center justify-between border-b border-slate-800 p-5">
                <div>
                  <h2 className="font-bold">掛單現況</h2>
                </div>
                <span className="rounded-full border border-emerald-400/30 px-3 py-1 text-xs text-emerald-300">鏈下掛單</span>
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
              <Line a="JC 餘額" b={formatJC(jcBalance)} />
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
                <FormattedNumberInput value={quantity} onValueChange={setQuantity} inputMode="numeric" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3" />
                {side === "sell" && (
                  <span className="mt-2 block text-xs text-slate-500">可掛出份額 {sellableShares.toLocaleString()} 份{reservedForSell > 0 ? `（已有 ${reservedForSell.toLocaleString()} 份掛在賣單中）` : ""}</span>
                )}
              </label>
              {orderBlocked && (
                <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-xs leading-relaxed text-amber-200">{blockedReason}</p>
              )}
              <div className="rounded-xl bg-slate-950 p-4 text-sm">
                <Line a="掛單總額" b={formatJC(gross)} bold />
                <p className="mt-2 text-xs leading-relaxed text-slate-500">此步不鎖定資金或份額、不扣款；實際成交時才驗證資產。平台費以 JC 收取，鏈上 Gas 由平台代付。</p>
              </div>
              <button type="button" disabled={submitting || orderBlocked} onClick={reviewOrder} className="min-h-11 rounded-xl bg-amber-400 py-3 font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50">
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
                  <button type="button" onClick={() => void cancelOrder(order.id)} className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-bold text-slate-300 hover:border-red-400 hover:text-red-300">取消掛單</button>
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
              <FormattedNumberInput value={fillQuantity} onValueChange={setFillQuantity} inputMode="numeric" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3" />
            </label>
            <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm">
              <Line a={selectedOrder.side === "sell" ? "買方支付總額" : "成交本金"} b={formatJC(fillGross)} bold />
              {selectedOrder.side === "buy" ? (
                <div className="mt-3 border-t border-amber-400/10 pt-3 text-xs leading-relaxed text-slate-400">
                  您是賣方：成交後將收到 JC（上方金額扣除平台費 1%＋1 JC），實際淨額會顯示於您的結算明細；鏈上 Gas 由平台代付。
                </div>
              ) : (
                <p className="mt-3 text-xs leading-relaxed text-slate-400">您是買方：以 JC 支付上方成交總額，不負擔賣方平台費。</p>
              )}
            </div>
            <button type="button" disabled={submitting} onClick={() => void fillOrder()} className="min-h-11 rounded-xl bg-amber-400 py-3 font-bold text-slate-950 disabled:opacity-50">確認成交</button>
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
        {seller && <><Line a="平台費（1%＋1 JC）" b={`-${formatJC(settlement.platform_fee ?? 0)}`} /><Line a="賣方實收 JC" b={formatJC(settlement.net ?? 0)} bold /></>}
        {!seller && <Line a="買方支付總額" b={formatJC(settlement.total ?? settlement.gross)} bold />}
      </div>
      {seller && <div className="flex items-start gap-3 rounded-xl bg-slate-800 p-4 text-xs text-slate-400"><CircleDollarSign className="mt-0.5 size-4 shrink-0 text-amber-300" /><span>平台費已計入 Safe 金庫：<span className="break-all font-mono text-slate-300">{TREASURY}</span></span></div>}
    </div>
  );
}

function Line({ a, b, bold = false }: { a: string; b: string; bold?: boolean }) {
  return <p className={`flex justify-between gap-4 py-1 ${bold ? "font-bold text-slate-100" : "text-slate-400"}`}><span>{a}</span><span className="text-right">{b}</span></p>;
}
