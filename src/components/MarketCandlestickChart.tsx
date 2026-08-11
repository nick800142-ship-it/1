import { useEffect, useMemo, useState } from "react";
import type { Asset } from "@/platform";
import { formatUSDT } from "@/platform";

type Period = "1H" | "1D" | "1W";
type Candle = {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const PERIODS: Record<Period, { count: number; step: number }> = {
  "1H": { count: 24, step: 5 * 60 * 1000 },
  "1D": { count: 24, step: 60 * 60 * 1000 },
  "1W": { count: 28, step: 6 * 60 * 60 * 1000 },
};

function hashSeed(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number) {
  let state = seed || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function createCandles(asset: Asset, period: Period): Candle[] {
  const { count, step } = PERIODS[period];
  const random = seededRandom(hashSeed(`${asset.id}-${period}`));
  const end = new Date();
  end.setSeconds(0, 0);
  const targetOpen = asset.price / (1 + asset.change / 100);
  let previous = Math.max(0.01, targetOpen);
  const candles: Candle[] = [];

  for (let index = 0; index < count; index += 1) {
    const progress = (index + 1) / count;
    const guidedPrice = targetOpen + (asset.price - targetOpen) * progress;
    const volatility =
      period === "1H" ? 0.0025 : period === "1D" ? 0.006 : 0.012;
    const open = previous;
    const close = Math.max(
      0.01,
      index === count - 1
        ? asset.price
        : guidedPrice * (1 + (random() - 0.5) * volatility),
    );
    const wick = Math.max(open, close) * volatility * (0.35 + random());
    const high = Math.max(open, close) + wick;
    const low = Math.max(
      0.01,
      Math.min(open, close) - wick * (0.6 + random() * 0.5),
    );
    const baseVolume = Math.max(
      80,
      asset.total * (period === "1H" ? 0.004 : 0.008),
    );
    const volume = Math.round(baseVolume * (0.55 + random() * 1.25));
    candles.push({
      time: new Date(end.getTime() - (count - 1 - index) * step),
      open,
      high,
      low,
      close,
      volume,
    });
    previous = close;
  }
  return candles;
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
  const candles = useMemo(() => createCandles(asset, period), [asset, period]);
  const [selectedIndex, setSelectedIndex] = useState(candles.length - 1);
  useEffect(() => setSelectedIndex(candles.length - 1), [candles]);

  const selected = candles[selectedIndex] ?? candles[candles.length - 1];
  const high = Math.max(...candles.map((candle) => candle.high));
  const low = Math.min(...candles.map((candle) => candle.low));
  const volume = candles.reduce((sum, candle) => sum + candle.volume, 0);
  const maxVolume = Math.max(...candles.map((candle) => candle.volume));
  const priceRange = Math.max(high - low, asset.price * 0.01);
  const chartTop = 18;
  const chartHeight = 164;
  const volumeTop = 212;
  const volumeHeight = 54;
  const width = 760;
  const plotWidth = 650;
  const xStep = plotWidth / candles.length;
  const priceY = (price: number) =>
    chartTop + ((high - price) / priceRange) * chartHeight;
  const selectedChange =
    ((selected.close - selected.open) / selected.open) * 100;
  const priceTicks = Array.from(
    { length: 5 },
    (_, index) => high - (priceRange * index) / 4,
  );
  const timeTickIndexes = [
    0,
    Math.floor((candles.length - 1) / 3),
    Math.floor(((candles.length - 1) * 2) / 3),
    candles.length - 1,
  ];

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-bold">市場走勢</h2>
            <span className="rounded bg-amber-400/15 px-2 py-1 text-xs font-semibold text-amber-300">
              模擬行情
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            OHLC K 線與成交量，僅供介面預覽，非真實成交資料
          </p>
        </div>
        <div className="flex gap-1" aria-label="K 線週期">
          {(Object.keys(PERIODS) as Period[]).map((item) => (
            <button
              type="button"
              onClick={() => setPeriod(item)}
              key={item}
              aria-pressed={period === item}
              className={`rounded px-3 py-1.5 text-xs font-semibold ${period === item ? "bg-amber-400 text-slate-950" : "bg-slate-800 text-slate-300"}`}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Metric label="最新價" value={formatUSDT(asset.price)} />
        <Metric
          label="24h 漲跌"
          value={`${asset.change > 0 ? "+" : ""}${asset.change.toFixed(2)}%`}
          tone={asset.change >= 0 ? "up" : "down"}
        />
        <Metric label="區間高點" value={formatUSDT(high)} />
        <Metric label="區間低點" value={formatUSDT(low)} />
        <Metric label="區間成交量" value={`${volume.toLocaleString()} 份`} />
      </div>

      <div className="mt-5 overflow-x-auto pb-2">
        <div className="min-w-[700px]">
          <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
            <span>價格（USDT／份）</span>
            <span>綠：上漲　紅：下跌　下方：成交量（份）</span>
          </div>
          <svg
            viewBox={`0 0 ${width} 300`}
            className="h-auto w-full"
            role="img"
            aria-label={`${asset.name} ${period} 模擬 K 線圖`}
          >
            {priceTicks.map((tick, index) => {
              const y = chartTop + (chartHeight * index) / 4;
              return (
                <g key={tick}>
                  <line
                    x1="0"
                    y1={y}
                    x2={plotWidth}
                    y2={y}
                    stroke="currentColor"
                    className="text-slate-800"
                    strokeDasharray="3 4"
                  />
                  <text
                    x={plotWidth + 12}
                    y={y + 4}
                    className="fill-slate-500 text-[11px]"
                  >
                    {tick.toFixed(3)}
                  </text>
                </g>
              );
            })}
            {candles.map((candle, index) => {
              const x = index * xStep + xStep / 2;
              const up = candle.close >= candle.open;
              const bodyTop = priceY(Math.max(candle.open, candle.close));
              const bodyHeight = Math.max(
                2,
                Math.abs(priceY(candle.open) - priceY(candle.close)),
              );
              const barWidth = Math.max(4, xStep * 0.55);
              const selectedCandle = index === selectedIndex;
              return (
                <g
                  key={candle.time.toISOString()}
                  role="button"
                  tabIndex={0}
                  aria-label={`${timeLabel(candle.time, period)}，開盤 ${candle.open.toFixed(3)}，最高 ${candle.high.toFixed(3)}，最低 ${candle.low.toFixed(3)}，收盤 ${candle.close.toFixed(3)} USDT，成交量 ${candle.volume} 份`}
                  onClick={() => setSelectedIndex(index)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedIndex(index);
                    }
                  }}
                  className="cursor-pointer outline-none"
                >
                  {selectedCandle && (
                    <rect
                      x={index * xStep}
                      y="8"
                      width={xStep}
                      height="264"
                      className="fill-amber-400/10"
                    />
                  )}
                  <line
                    x1={x}
                    y1={priceY(candle.high)}
                    x2={x}
                    y2={priceY(candle.low)}
                    className={up ? "stroke-emerald-400" : "stroke-red-400"}
                  />
                  <rect
                    x={x - barWidth / 2}
                    y={bodyTop}
                    width={barWidth}
                    height={bodyHeight}
                    rx="1"
                    className={up ? "fill-emerald-400" : "fill-red-400"}
                  />
                  <rect
                    x={x - barWidth / 2}
                    y={
                      volumeTop +
                      volumeHeight -
                      (candle.volume / maxVolume) * volumeHeight
                    }
                    width={barWidth}
                    height={(candle.volume / maxVolume) * volumeHeight}
                    rx="1"
                    className={up ? "fill-emerald-400/60" : "fill-red-400/60"}
                  />
                </g>
              );
            })}
            <line
              x1="0"
              y1="195"
              x2={plotWidth}
              y2="195"
              stroke="currentColor"
              className="text-slate-700"
            />
            <text
              x={plotWidth + 12}
              y={volumeTop + 4}
              className="fill-slate-500 text-[10px]"
            >
              {maxVolume.toLocaleString()}
            </text>
            <text
              x={plotWidth + 12}
              y={volumeTop + volumeHeight}
              className="fill-slate-500 text-[10px]"
            >
              0
            </text>
            {timeTickIndexes.map((index) => {
              const x = index * xStep + xStep / 2;
              return (
                <text
                  key={index}
                  x={x}
                  y="290"
                  textAnchor={
                    index === 0
                      ? "start"
                      : index === candles.length - 1
                        ? "end"
                        : "middle"
                  }
                  className="fill-slate-500 text-[10px]"
                >
                  {timeLabel(candles[index].time, period)}
                </text>
              );
            })}
            <text
              x={plotWidth / 2}
              y="299"
              textAnchor="middle"
              className="fill-slate-400 text-[10px]"
            >
              時間
            </text>
          </svg>
        </div>
      </div>

      <div className="mt-3 grid gap-3 rounded-xl border border-slate-700 bg-slate-950 p-4 text-sm sm:grid-cols-4">
        <Detail
          label="時間"
          value={selected.time.toLocaleString("zh-TW", { hour12: false })}
        />
        <Detail
          label="開盤／收盤"
          value={`${selected.open.toFixed(3)} / ${selected.close.toFixed(3)}`}
        />
        <Detail
          label="最高／最低"
          value={`${selected.high.toFixed(3)} / ${selected.low.toFixed(3)}`}
        />
        <Detail
          label="漲跌／成交量"
          value={`${selectedChange >= 0 ? "+" : ""}${selectedChange.toFixed(2)}% / ${selected.volume.toLocaleString()} 份`}
          tone={selectedChange >= 0 ? "up" : "down"}
        />
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
}) {
  return (
    <div className="rounded-xl bg-slate-950 p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p
        className={`mt-1 text-sm font-bold ${tone === "up" ? "text-emerald-400" : tone === "down" ? "text-red-400" : "text-slate-100"}`}
      >
        {value}
      </p>
    </div>
  );
}

function Detail({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
}) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p
        className={`mt-1 font-semibold ${tone === "up" ? "text-emerald-400" : tone === "down" ? "text-red-400" : "text-slate-200"}`}
      >
        {value}
      </p>
    </div>
  );
}
