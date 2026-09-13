import { useCallback, useEffect, useMemo, useState } from "react";
import type { Asset } from "@/platform";
import { formatJC } from "@/platform";
import { supabase } from "@/lib/supabase";
import { useVisiblePolling } from "@/hooks/useVisiblePolling";

type Period = "1H" | "1D" | "1W";
type Snapshot = { id: string; price: number; recorded_at: string };
type TradeVolume = { quantity: number; recorded_at: string };
type Candle = {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const PERIODS: Record<Period, { range: number; bucket: number }> = {
  "1H": { range: 60 * 60 * 1000, bucket: 5 * 60 * 1000 },
  "1D": { range: 24 * 60 * 60 * 1000, bucket: 60 * 60 * 1000 },
  "1W": { range: 7 * 24 * 60 * 60 * 1000, bucket: 6 * 60 * 60 * 1000 },
};

function bucketByTime<T extends { recorded_at: string }>(
  rows: T[],
  period: Period,
): Map<number, T[]> {
  const { range, bucket } = PERIODS[period];
  const cutoff = Date.now() - range;
  const buckets = new Map<number, T[]>();
  rows
    .filter((row) => new Date(row.recorded_at).getTime() >= cutoff)
    .forEach((row) => {
      const timestamp = new Date(row.recorded_at).getTime();
      const key = Math.floor(timestamp / bucket) * bucket;
      buckets.set(key, [...(buckets.get(key) ?? []), row]);
    });
  return buckets;
}

function aggregateCandles(
  rows: Snapshot[],
  volumes: TradeVolume[],
  period: Period,
): Candle[] {
  const priceBuckets = bucketByTime(rows, period);
  const volumeBuckets = bucketByTime(volumes, period);

  return [...priceBuckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([time, items]) => {
      const prices = items.map((item) => Number(item.price));
      const volume = (volumeBuckets.get(time) ?? []).reduce(
        (sum, item) => sum + Number(item.quantity),
        0,
      );
      return {
        time: new Date(time),
        open: prices[0],
        high: Math.max(...prices),
        low: Math.min(...prices),
        close: prices[prices.length - 1],
        volume,
      };
    });
}

function timeLabel(date: Date, period: Period) {
  return new Intl.DateTimeFormat("zh-TW", {
    month: period === "1W" ? "numeric" : undefined,
    day: period === "1W" ? "numeric" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function MarketCandlestickChart({ asset }: { asset: Asset }) {
  const [period, setPeriod] = useState<Period>("1D");
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [volumes, setVolumes] = useState<TradeVolume[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    const [snapshotResult, volumeResult] = await Promise.all([
      supabase.rpc("get_market_price_snapshots", { asset_key: asset.id }),
      supabase.rpc("get_market_trade_volumes", { asset_key: asset.id }),
    ]);
    if (!snapshotResult.error) setSnapshots((snapshotResult.data ?? []) as Snapshot[]);
    if (!volumeResult.error) setVolumes((volumeResult.data ?? []) as TradeVolume[]);
    setLoading(false);
  }, [asset.id]);
  useVisiblePolling(load, 2_000, true);

  const candles = useMemo(
    () => aggregateCandles(snapshots, volumes, period),
    [snapshots, volumes, period],
  );
  const [selectedIndex, setSelectedIndex] = useState(-1);
  useEffect(() => setSelectedIndex(candles.length - 1), [candles]);

  const selected = candles[selectedIndex] ?? candles[candles.length - 1];
  const high = candles.length ? Math.max(...candles.map((candle) => candle.high)) : 0;
  const low = candles.length ? Math.min(...candles.map((candle) => candle.low)) : 0;
  const latest = candles[candles.length - 1]?.close ?? 0;
  const first = candles[0]?.open ?? 0;
  const change = first > 0 ? ((latest - first) / first) * 100 : 0;
  const recordCount = useMemo(() => {
    const cutoff = Date.now() - PERIODS[period].range;
    return snapshots.filter((row) => new Date(row.recorded_at).getTime() >= cutoff).length;
  }, [snapshots, period]);
  const priceRange = candles.length ? Math.max(high - low, high * 0.01, 0.01) : 1;
  const chartTop = 18;
  const chartHeight = 164;
  const width = 760;
  const plotWidth = 650;
  const xStep = candles.length ? plotWidth / candles.length : plotWidth;
  const priceY = (price: number) => chartTop + ((high - price) / priceRange) * chartHeight;
  // 選到最新一根蠟燭時，直接採用與市場卡片相同的權威漲跌幅（asset.change，
  // 由後端依「這筆真實成交價 vs 前一筆真實成交價」計算），確保兩處數字一致；
  // 選到歷史蠟燭時則與前一根蠟燭的收盤價比較，避免同一根蠟燭內開盤／收盤
  // 因時間分桶造成的誤導性數字。
  const isLatestCandle = selectedIndex === candles.length - 1;
  const previousCandle = selectedIndex > 0 ? candles[selectedIndex - 1] : undefined;
  const selectedChange = isLatestCandle
    ? asset.change
    : previousCandle && previousCandle.close
      ? ((selected.close - previousCandle.close) / previousCandle.close) * 100
      : selected?.open
        ? ((selected.close - selected.open) / selected.open) * 100
        : 0;
  const priceTicks = candles.length
    ? Array.from({ length: 5 }, (_, index) => high - (priceRange * index) / 4)
    : [];
  const timeTickIndexes = candles.length
    ? [...new Set([0, Math.floor((candles.length - 1) / 3), Math.floor(((candles.length - 1) * 2) / 3), candles.length - 1])]
    : [];

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-bold">市場走勢</h2>
            <span className="rounded bg-emerald-400/10 px-2 py-1 text-xs font-semibold text-emerald-300">正式紀錄</span>
          </div>
        </div>
        <div className="flex gap-1" aria-label="K 線週期">
          {(Object.keys(PERIODS) as Period[]).map((item) => (
            <button type="button" onClick={() => setPeriod(item)} key={item} aria-pressed={period === item} className={`rounded px-3 py-1.5 text-xs font-semibold ${period === item ? "bg-slate-100 text-slate-950" : "bg-slate-800 text-slate-300"}`}>
              {item}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Metric label="最新紀錄價" value={candles.length ? formatJC(latest) : "—"} />
        <Metric label="區間漲跌" value={candles.length ? `${change > 0 ? "+" : ""}${change.toFixed(2)}%` : "—"} tone={candles.length ? (change >= 0 ? "up" : "down") : undefined} />
        <Metric label="區間高點" value={candles.length ? formatJC(high) : "—"} />
        <Metric label="區間低點" value={candles.length ? formatJC(low) : "—"} />
        <Metric label="區間紀錄數" value={`${recordCount} 筆`} />
      </div>

      {loading ? (
        <div className="mt-5 flex h-72 items-center justify-center rounded-xl border border-slate-800 bg-slate-950 text-sm text-slate-500">正在讀取價格紀錄…</div>
      ) : candles.length === 0 ? (
        <div className="mt-5 flex h-72 flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-950 px-6 text-center">
          <p className="font-semibold text-slate-200">K 線已歸零</p>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-500">目前沒有此週期的正式價格紀錄。後台下一次修改並儲存標的價格後，第一筆 K 線才會出現。</p>
        </div>
      ) : (
        <>
          <div className="mt-5 overflow-x-auto pb-2">
            <div className="min-w-[700px]">
              <div className="mb-2 flex items-center justify-between text-xs text-slate-500"><span>價格（JC／份）</span><span>綠：上漲　紅：下跌</span></div>
              <svg viewBox={`0 0 ${width} 230`} className="h-auto w-full" role="img" aria-label={`${asset.name} ${period} 正式價格 K 線圖`}>
                {priceTicks.map((tick, index) => {
                  const y = chartTop + (chartHeight * index) / 4;
                  return <g key={`${tick}-${index}`}><line x1="0" y1={y} x2={plotWidth} y2={y} stroke="currentColor" className="text-slate-800" strokeDasharray="3 4" /><text x={plotWidth + 12} y={y + 4} className="fill-slate-500 text-[11px]">{tick.toFixed(3)}</text></g>;
                })}
                {candles.map((candle, index) => {
                  const x = index * xStep + xStep / 2;
                  const up = candle.close >= candle.open;
                  const bodyTop = priceY(Math.max(candle.open, candle.close));
                  const bodyHeight = Math.max(2, Math.abs(priceY(candle.open) - priceY(candle.close)));
                  const barWidth = Math.max(4, Math.min(26, xStep * 0.55));
                  return (
                    <g key={candle.time.toISOString()} role="button" tabIndex={0} aria-label={`${timeLabel(candle.time, period)}，開盤 ${candle.open.toFixed(3)}，最高 ${candle.high.toFixed(3)}，最低 ${candle.low.toFixed(3)}，收盤 ${candle.close.toFixed(3)} JC`} onClick={() => setSelectedIndex(index)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedIndex(index); } }} className="cursor-pointer outline-none">
                      {index === selectedIndex && <rect x={index * xStep} y="8" width={xStep} height="190" className="fill-slate-100/5" />}
                      <line x1={x} y1={priceY(candle.high)} x2={x} y2={priceY(candle.low)} className={up ? "stroke-emerald-400" : "stroke-red-400"} />
                      <rect x={x - barWidth / 2} y={bodyTop} width={barWidth} height={bodyHeight} rx="1" className={up ? "fill-emerald-400" : "fill-red-400"} />
                    </g>
                  );
                })}
                {timeTickIndexes.map((index) => {
                  const x = index * xStep + xStep / 2;
                  return <text key={index} x={x} y="218" textAnchor={index === 0 ? "start" : index === candles.length - 1 ? "end" : "middle"} className="fill-slate-500 text-[10px]">{timeLabel(candles[index].time, period)}</text>;
                })}
              </svg>
            </div>
          </div>
          {selected && (
            <div className="mt-3 grid gap-3 rounded-xl border border-slate-700 bg-slate-950 p-4 text-sm sm:grid-cols-4">
              <Detail label="時間" value={selected.time.toLocaleString("zh-TW", { hour12: false })} />
              <Detail label="開盤／收盤" value={`${selected.open.toFixed(3)} / ${selected.close.toFixed(3)}`} />
              <Detail label="最高／最低" value={`${selected.high.toFixed(3)} / ${selected.low.toFixed(3)}`} />
              <Detail label="漲跌／成交量" value={`${selectedChange >= 0 ? "+" : ""}${selectedChange.toFixed(2)}% / ${selected.volume.toLocaleString("zh-TW")} 份`} tone={selectedChange >= 0 ? "up" : "down"} />
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return <div className="rounded-xl bg-slate-950 p-3"><p className="text-xs text-slate-500">{label}</p><p className={`mt-1 text-sm font-bold ${tone === "up" ? "text-emerald-400" : tone === "down" ? "text-red-400" : "text-slate-100"}`}>{value}</p></div>;
}

function Detail({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return <div><p className="text-xs text-slate-500">{label}</p><p className={`mt-1 font-semibold ${tone === "up" ? "text-emerald-400" : tone === "down" ? "text-red-400" : "text-slate-200"}`}>{value}</p></div>;
}
