import { useMemo, useState } from "react";
import {
  ArrowLeft,
  BarChart3,
  MapPin,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { formatUSDT, useLanguage, usePlatform, type Asset } from "@/platform";
import { Notice } from "@/components/Modal";
import { SearchSuggest } from "@/components/SearchSuggest";

export function MarketPage() {
  const { t, tr } = useLanguage();
  const { assets } = usePlatform();
  const [selected, setSelected] = useState<Asset | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "up" | "down">("all");
  const list = assets.filter(
    (a) => filter === "all" || (filter === "up" ? a.change >= 0 : a.change < 0),
  );
  return (
    <div className="flex flex-col gap-8">
      <header>
        <p className="text-xs font-bold uppercase tracking-[.22em] text-amber-400">
          Live order book
        </p>
        <h1 className="mt-2 text-3xl font-bold">{t("market")}</h1>
        <p className="mt-2 text-sm text-slate-400">{tr("liveMatching")}</p>
      </header>
      <SearchSuggest
        value={search}
        onChange={setSearch}
        placeholder="搜尋二級市場標的物"
        suggestions={assets.map((asset) => ({
          value: asset.name,
          label: asset.name,
          detail: asset.location,
        }))}
        onSelect={(value) => {
          const asset = assets.find((item) => item.name === value);
          if (asset) setSelected(asset);
        }}
      />
      <div className="flex gap-2">
        {(["all", "up", "down"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-lg px-4 py-2 text-sm ${filter === f ? "bg-amber-400 font-bold text-slate-950" : "bg-slate-900 text-slate-400"}`}
          >
            {f === "all"
              ? tr("all")
              : f === "up"
                ? tr("rising")
                : tr("falling")}
          </button>
        ))}
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        {list.map((a) => (
          <MarketCard key={a.id} asset={a} onOpen={() => setSelected(a)} />
        ))}
      </div>
      {selected && (
        <MarketDetail asset={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
function MarketCard({ asset, onOpen }: { asset: Asset; onOpen: () => void }) {
  const { t, tr } = useLanguage();
  const up = asset.change >= 0;
  return (
    <article className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
      <div
        className="h-40 bg-cover bg-center"
        style={{ backgroundImage: `url('${asset.image}')` }}
      />
      <div className="p-5">
        <h2 className="font-bold">{asset.name}</h2>
        <p className="mt-1 flex items-center gap-1 text-xs text-slate-400">
          <MapPin className="h-3 w-3" />
          {asset.location}
        </p>
        <div className="mt-5 flex items-end justify-between">
          <div>
            <p className="text-xs text-slate-500">{t("unitPrice")}</p>
            <p className="text-xl font-bold">{formatUSDT(asset.price)}</p>
          </div>
          <span
            className={`flex items-center gap-1 text-sm font-bold ${up ? "text-emerald-400" : "text-red-400"}`}
          >
            {up ? (
              <TrendingUp className="h-4 w-4" />
            ) : (
              <TrendingDown className="h-4 w-4" />
            )}
            {asset.change}%
          </span>
        </div>
        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-slate-800">
          <div
            className="h-full bg-amber-400"
            style={{ width: `${(asset.available / asset.total) * 100}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-slate-500">
          {tr("available")} {asset.available.toLocaleString()} /{" "}
          {asset.total.toLocaleString()}
        </p>
        <button
          onClick={onOpen}
          className="mt-4 w-full rounded-xl bg-slate-800 py-3 font-semibold hover:bg-amber-400 hover:text-slate-950"
        >
          {t("details")} / {t("buy")}
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
  const { t } = useLanguage();
  const { balance, holdings, transactions, trade } = usePlatform();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [qty, setQty] = useState("100");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [period, setPeriod] = useState("1D");
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(null);
  const owned = holdings.find((h) => h.assetId === asset.id)?.tokens ?? 0;
  const gross = (Number(qty) || 0) * asset.price;
  const fee = side === "sell" ? gross * 0.01 + 1 : 0;
  const net = side === "sell" ? gross - fee : gross;
  const ownTx = transactions.filter((x) => x.assetId === asset.id);
  const recentTrades = useMemo(() => {
    const range =
      period === "1H"
        ? 60 * 60 * 1000
        : period === "1D"
          ? 24 * 60 * 60 * 1000
          : 7 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - range;
    return ownTx
      .filter(
        (transaction) =>
          (transaction.type === "buy" || transaction.type === "sell") &&
          Boolean(transaction.quantity) &&
          new Date(transaction.createdAt).getTime() >= cutoff,
      )
      .slice(0, 24)
      .reverse()
      .map((transaction) => ({
        ...transaction,
        quantity: transaction.quantity ?? 0,
        price: transaction.quantity
          ? transaction.gross / transaction.quantity
          : 0,
      }));
  }, [ownTx, period]);
  const selectedTrade =
    recentTrades.find((transaction) => transaction.id === selectedTradeId) ??
    recentTrades[recentTrades.length - 1] ??
    null;
  const maxQuantity = Math.max(
    1,
    ...recentTrades.map((transaction) => transaction.quantity),
  );
  const orders = useMemo(
    () =>
      Array.from({ length: 6 }, (_, i) => ({
        ask: asset.price + (i + 1) * 0.01,
        bid: asset.price - (i + 1) * 0.01,
        qty: 320 + i * 137,
      })),
    [asset],
  );
  const submit = async () => {
    const r = await trade(asset.id, side, Number(qty));
    setMsg({ text: r.message, ok: r.ok });
  };
  return (
    <div className="fixed inset-0 z-40 max-w-full overflow-x-hidden overflow-y-auto bg-slate-950 lg:left-60">
      <div className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-8 sm:py-8">
        <button
          onClick={onClose}
          className="mb-5 flex items-center gap-2 text-sm text-slate-400 hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          返回市場
        </button>
        <div className="flex flex-col gap-6">
          <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-2xl font-bold">{asset.name}</h1>
              <p className="mt-1 text-sm text-slate-400">{asset.location}</p>
            </div>
            <div>
              <p className="text-3xl font-bold">{formatUSDT(asset.price)}</p>
              <p
                className={
                  asset.change >= 0 ? "text-emerald-400" : "text-red-400"
                }
              >
                {asset.change > 0 ? "+" : ""}
                {asset.change}% / 24h
              </p>
            </div>
          </header>
          <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
            <div className="flex flex-col gap-6">
              <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
                <div className="flex items-center justify-between">
                  <h2 className="flex items-center gap-2 font-bold">
                    <BarChart3 className="h-5 w-5 text-amber-400" />K 線圖
                  </h2>
                  <div className="flex gap-1">
                    {["1H", "1D", "1W"].map((p) => (
                      <button
                        onClick={() => setPeriod(p)}
                        key={p}
                        className={`rounded px-2 py-1 text-xs ${period === p ? "bg-amber-400 text-slate-950" : "bg-slate-800"}`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="mt-3 text-xs text-slate-400">
                  近期交易數量與成交價格，點選直條查看交易明細
                </p>
                {recentTrades.length > 0 ? (
                  <>
                    <div className="mt-5 flex h-56 items-end gap-1 border-b border-l border-slate-700 p-3">
                      {recentTrades.map((transaction) => {
                        const active = selectedTrade?.id === transaction.id;
                        return (
                          <button
                            type="button"
                            key={transaction.id}
                            onClick={() => setSelectedTradeId(transaction.id)}
                            aria-label={`${transaction.date}，${transaction.type === "buy" ? "買入" : "賣出"} ${transaction.quantity.toLocaleString()} 份，成交價 ${formatUSDT(transaction.price)}`}
                            aria-pressed={active}
                            className={`min-w-1 flex-1 rounded-t-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${transaction.type === "buy" ? "bg-emerald-500" : "bg-red-500"} ${active ? "opacity-100 ring-2 ring-amber-300" : "opacity-70 hover:opacity-100"}`}
                            style={{
                              height: `${Math.max(12, (transaction.quantity / maxQuantity) * 100)}%`,
                            }}
                            title={`${transaction.date}｜數量 ${transaction.quantity.toLocaleString()}｜價格 ${formatUSDT(transaction.price)}`}
                          />
                        );
                      })}
                    </div>
                    {selectedTrade && (
                      <div className="mt-4 grid gap-3 rounded-xl border border-slate-700 bg-slate-950 p-4 text-sm sm:grid-cols-3">
                        <div>
                          <p className="text-xs text-slate-500">交易時間</p>
                          <p className="mt-1 font-semibold text-slate-200">
                            {selectedTrade.date}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-slate-500">交易數量</p>
                          <p className="mt-1 font-semibold text-slate-200">
                            {selectedTrade.quantity.toLocaleString()} 份
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-slate-500">成交價格</p>
                          <p className="mt-1 font-semibold text-amber-300">
                            {formatUSDT(selectedTrade.price)}
                          </p>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="mt-5 flex h-56 items-center justify-center rounded-xl border border-dashed border-slate-700 text-sm text-slate-500">
                    此期間尚無交易紀錄
                  </div>
                )}
              </section>
              <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
                <h2 className="p-5 font-bold">{t("orderbook")}</h2>
                <div className="grid grid-cols-1 divide-y divide-slate-800 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                  <OrderSide
                    title="賣單 (USDT)"
                    rows={orders.map((o) => [o.ask, o.qty])}
                    ask
                  />
                  <OrderSide
                    title="買單 (USDT)"
                    rows={orders.map((o) => [o.bid, o.qty])}
                  />
                </div>
              </section>
            </div>
            <aside className="h-fit rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <div className="grid grid-cols-2 rounded-xl bg-slate-800 p-1">
                <button
                  onClick={() => {
                    setSide("buy");
                    setMsg(null);
                  }}
                  className={`rounded-lg py-2 font-bold ${side === "buy" ? "bg-emerald-500 text-slate-950" : ""}`}
                >
                  {t("buy")}
                </button>
                <button
                  onClick={() => {
                    setSide("sell");
                    setMsg(null);
                  }}
                  className={`rounded-lg py-2 font-bold ${side === "sell" ? "bg-red-500 text-white" : ""}`}
                >
                  {t("sell")}
                </button>
              </div>
              <div className="mt-5 flex flex-col gap-4">
                <p className="flex justify-between text-sm">
                  <span className="text-slate-400">{t("balance")}</span>
                  <strong>{formatUSDT(balance)}</strong>
                </p>
                <p className="flex justify-between text-sm">
                  <span className="text-slate-400">持有份額</span>
                  <strong>{owned.toLocaleString()}</strong>
                </p>
                <label className="text-sm">
                  {t("units")}
                  <input
                    type="number"
                    min="1"
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                    className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3"
                  />
                </label>
                <div className="rounded-xl bg-slate-950 p-4 text-sm">
                  <Line a={t("gross")} b={formatUSDT(gross)} />
                  <Line a={t("fee")} b={formatUSDT(fee)} />
                  <Line
                    a={side === "sell" ? t("net") : "實付金額"}
                    b={formatUSDT(net)}
                    bold
                  />
                </div>
                {side === "sell" && (
                  <p className="text-xs text-amber-300">
                    手續費 = 成交額 1% + 1 USDT
                  </p>
                )}
                {msg && (
                  <Notice
                    message={msg.text}
                    tone={msg.ok ? "success" : "error"}
                  />
                )}
                <button
                  onClick={submit}
                  className={`rounded-xl py-3 font-bold ${side === "buy" ? "bg-emerald-500 text-slate-950" : "bg-red-500 text-white"}`}
                >
                  {t("confirm")} · {side === "buy" ? t("buy") : t("sell")}
                </button>
              </div>
            </aside>
          </div>
          <section className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900">
            <h2 className="p-5 font-bold">{t("history")}</h2>
            <table className="min-w-[700px] w-full text-left text-sm">
              <thead className="bg-slate-800/50 text-slate-400">
                <tr>
                  <th className="p-3">時間</th>
                  <th>方向</th>
                  <th>{t("gross")}</th>
                  <th>{t("fee")}</th>
                  <th>{t("net")}</th>
                  <th>鏈上狀態</th>
                </tr>
              </thead>
              <tbody>
                {ownTx.map((x) => (
                  <tr key={x.id} className="border-t border-slate-800">
                    <td className="p-3">{x.date}</td>
                    <td>{x.type}</td>
                    <td>{formatUSDT(x.gross)}</td>
                    <td>{formatUSDT(x.fee)}</td>
                    <td>{formatUSDT(Math.abs(x.net))}</td>
                    <td className="text-emerald-400">Confirmed · {x.hash}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </div>
  );
}
function OrderSide({
  title,
  rows,
  ask = false,
}: {
  title: string;
  rows: number[][];
  ask?: boolean;
}) {
  return (
    <div>
      <p className="px-4 py-3 text-xs text-slate-500">{title}</p>
      {rows.map(([p, q]) => (
        <div key={p} className="flex justify-between px-4 py-2 text-xs">
          <span className={ask ? "text-red-400" : "text-emerald-400"}>
            {p.toFixed(2)}
          </span>
          <span>{q}</span>
        </div>
      ))}
    </div>
  );
}
function Line({
  a,
  b,
  bold = false,
}: {
  a: string;
  b: string;
  bold?: boolean;
}) {
  return (
    <p
      className={`flex justify-between py-1 ${bold ? "font-bold text-white" : "text-slate-400"}`}
    >
      <span>{a}</span>
      <span>{b}</span>
    </p>
  );
}
