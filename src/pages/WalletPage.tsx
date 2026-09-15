import { Copy, CheckCircle2, Wallet, ChevronDown, ArrowUpFromLine, AlertTriangle, X, ArrowLeftRight } from "lucide-react";
import { useMemo, useState } from "react";
import { currentMarketPrice, formatJC, formatUSDT, interfaceText, useLanguage, usePlatform } from "@/platform";
import type { Transaction } from "@/platform";
import { supabase } from "@/lib/supabase";
import { AE_TOKEN_CANONICAL_ID } from "@/lib/aeToken";
import { fetchOnChainUsdtBalance } from "@/lib/onchainUsdt";

type DatePreset = "all" | "week" | "month" | "year" | "custom";

// AE tokens run on two independent placement rows (daily issuance + bonus
// rounds) that can have different prices, but users should see one merged
// "AE 代幣" position instead of two separate cards for the same token.
const AE_TOKEN_GROUP_ID = "ae-token-group";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 font-semibold text-slate-100">{value}</p>
    </div>
  );
}

export function WalletPage() {
  const { t, tr, language, assets: localizedAssets } = useLanguage();
  const { balance, holdings, transactions, assets, loading, walletAddress, jcBalance, jcPrice, refresh } = usePlatform();
  const [copied, setCopied] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [expandedAssetId, setExpandedAssetId] = useState<string | null>(null);
  const [preset, setPreset] = useState<DatePreset>("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const localizedAssetFor = (id: string) =>
    localizedAssets.find((asset) => asset.id === id);
  const transactionTypeLabel = {
    buy: t("buy"),
    sell: t("sell"),
    deposit: t("deposit"),
    withdraw: t("withdraw"),
    dividend: tr("dividend"),
  } as const;
  const assetFor = (id: string) => assets.find((asset) => asset.id === id);
  // AE daily and bonus placements are the same token on one shared secondary
  // market, so the whole merged AE position must be valued at that market's
  // single current price (the canonical row's last matched trade), not a
  // per-placement blend of each round's own price.
  const aeMarketAsset = assetFor(AE_TOKEN_CANONICAL_ID) ?? assets.find((a) => a.isAeToken);
  const aeMarketPrice = aeMarketAsset ? currentMarketPrice(aeMarketAsset) : 0;
  const visibleHoldings = useMemo(
    () =>
      holdings.filter((holding) => {
        const asset = assets.find((candidate) => candidate.id === holding.assetId);
        return (
          holding.tokens > 0 &&
          Boolean(asset) &&
          (asset?.isActive !== false || Boolean(asset?.marketStartedAt))
        );
      }),
    [assets, holdings],
  );
  // Merge any positions that share the same assetId into one card. AE
  // tokens are additionally merged across their daily/bonus placement rows
  // into a single AE_TOKEN_GROUP_ID position, since users shouldn't need to
  // care which track a given unit came from. Value is summed per source row
  // (tokens x that row's own price) rather than recomputed after merging,
  // since daily and bonus rounds can have different prices.
  const groupKeyFor = (assetId: string) =>
    assetFor(assetId)?.isAeToken ? AE_TOKEN_GROUP_ID : assetId;
  const aggregatedHoldings = useMemo(() => {
    const map = new Map<string, { assetId: string; tokens: number; value: number }>();
    for (const holding of visibleHoldings) {
      const key = groupKeyFor(holding.assetId);
      const asset = assetFor(holding.assetId);
      // Value secondary-market holdings (AE token) at the latest matched
      // trade price, not the fixed subscription price, so wallet value
      // tracks what the position could actually be sold for right now. All
      // AE placements share one secondary market, so value every AE unit at
      // the single canonical market price rather than each round's own price.
      const unitValue = asset?.isAeToken
        ? aeMarketPrice
        : asset
          ? currentMarketPrice(asset)
          : 0;
      const value = holding.tokens * unitValue;
      const existing = map.get(key);
      if (existing) {
        existing.tokens += holding.tokens;
        existing.value += value;
      } else {
        map.set(key, { assetId: key, tokens: holding.tokens, value });
      }
    }
    return Array.from(map.values());
  }, [visibleHoldings, assets, aeMarketPrice]);
  const holdingsValue = aggregatedHoldings.reduce((sum, holding) => sum + holding.value, 0);
  const holdingGroups = useMemo(() => {
    const now = Date.now();
    const isSecondaryAsset = (assetId: string) => {
      // AE tokens open subscription and the secondary market at the same
      // time, so the merged group always belongs in the secondary section.
      if (assetId === AE_TOKEN_GROUP_ID) return true;
      const marketStartedAt = assets.find(
        (asset) => asset.id === assetId,
      )?.marketStartedAt;
      return Boolean(
        marketStartedAt && new Date(marketStartedAt).getTime() <= now,
      );
    };

    // Holdings split into two sections: positions still in the private
    // placement phase (subscribed, secondary market not open yet) and
    // positions that have settled into the secondary market. AE tokens always
    // count as secondary since they open subscription and trading together.
    return [
      {
        id: "private",
        title: language.startsWith("zh") ? "私募認購持倉" : "Private placement holdings",
        description: language.startsWith("zh")
          ? "已認購、尚未開放二級市場的持倉"
          : "Subscribed holdings not yet on the secondary market",
        holdings: aggregatedHoldings.filter(
          (holding) => !isSecondaryAsset(holding.assetId),
        ),
      },
      {
        id: "secondary",
        title: language.startsWith("zh") ? "二級市場資產" : "Secondary market assets",
        description: language.startsWith("zh")
          ? "已進入二級市場交易的持倉"
          : "Holdings available on the secondary market",
        holdings: aggregatedHoldings.filter((holding) =>
          isSecondaryAsset(holding.assetId),
        ),
      },
    ];
  }, [aggregatedHoldings, assets, language]);
  // Trades per asset (oldest -> newest) so we can compute a moving weighted average.
  const tradesByAsset = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    transactions
      .filter((tx) => tx.assetId && (tx.type === "buy" || tx.type === "sell"))
      .slice()
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      )
      .forEach((tx) => {
        const key = groupKeyFor(tx.assetId as string);
        const list = map.get(key) ?? [];
        list.push(tx);
        map.set(key, list);
      });
    return map;
  }, [transactions, assets]);
  // Moving weighted-average buy price: buys add to cost basis, sells reduce
  // shares at the current average without changing the per-unit average.
  const avgBuyPriceFor = (assetId: string) => {
    const trades = tradesByAsset.get(assetId) ?? [];
    let shares = 0;
    let costBasis = 0;
    for (const tx of trades) {
      const qty = tx.quantity ?? 0;
      if (qty <= 0) continue;
      if (tx.type === "buy") {
        costBasis += tx.gross;
        shares += qty;
      } else {
        const avg = shares > 0 ? costBasis / shares : 0;
        const soldShares = Math.min(qty, shares);
        costBasis -= avg * soldShares;
        shares -= soldShares;
      }
    }
    if (shares <= 0) return trades.length ? 0 : null;
    return costBasis / shares;
  };
  const filteredTransactions = useMemo(() => {
    const now = new Date();
    let start: Date | null = null;
    let end: Date | null = null;
    if (preset === "week") {
      start = new Date(now);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    } else if (preset === "month") {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (preset === "year") {
      start = new Date(now.getFullYear(), 0, 1);
    } else if (preset === "custom") {
      start = startDate ? new Date(`${startDate}T00:00:00`) : null;
      end = endDate ? new Date(`${endDate}T23:59:59.999`) : null;
    }
    return transactions.filter((transaction) => {
      const date = new Date(transaction.createdAt);
      return (!start || date >= start) && (!end || date <= end);
    });
  }, [transactions, preset, startDate, endDate]);
  const copy = async () => {
    if (!walletAddress) return;
    await navigator.clipboard.writeText(walletAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-3xl font-bold">{t("wallet")}</h1>
      </header>
      <section className="rounded-3xl border border-slate-700 bg-slate-900 p-6 sm:p-8">
        <p className="flex items-center gap-2 text-sm text-slate-400">
          <Wallet className="h-4 w-4" />
          {tr("totalAssets")}
        </p>
        <p className="mt-2 text-4xl font-bold">
          {loading ? "—" : formatJC(jcBalance + holdingsValue)}
        </p>
        <p className="mt-2 text-sm text-slate-400">
          持倉市值：{formatJC(holdingsValue)}
        </p>
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-700 bg-slate-950/60 p-4">
            <p className="text-xs text-slate-500">可用 JC</p>
            <p className="mt-1 text-xl font-bold text-amber-300">
              {loading ? "—" : formatJC(jcBalance)}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-700 bg-slate-950/60 p-4">
            <p className="flex items-center gap-1.5 text-xs text-slate-500">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </span>
              可用 USDT（鏈上餘額，自動更新）
            </p>
            <p className="mt-1 text-xl font-bold text-slate-100">
              {loading ? "—" : formatUSDT(balance)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setVaultOpen(true)}
            className="flex flex-col items-start rounded-2xl border border-sky-500/40 bg-sky-500/5 p-4 text-left transition hover:border-sky-400"
          >
            <p className="flex items-center gap-1 text-xs text-sky-300/90">
              <ArrowLeftRight className="h-3 w-3" />JC 金庫兌換
            </p>
            <p className="mt-1 text-sm font-semibold text-sky-200">
              USDT ↔ JC（1 JC = {formatUSDT(jcPrice)}）
            </p>
          </button>
        </div>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button
            aria-label={tr("copyAddress")}
            onClick={copy}
            disabled={!walletAddress}
            title={walletAddress ?? undefined}
            className="flex items-center gap-2 rounded-xl bg-slate-800 px-4 py-3 font-mono text-xs disabled:cursor-not-allowed disabled:opacity-70"
          >
            {walletAddress
              ? `${walletAddress.slice(0, 12)}...${walletAddress.slice(-8)}`
              : "錢包生成中…"}
            {walletAddress &&
              (copied ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              ) : (
                <Copy className="h-4 w-4" />
              ))}
          </button>
          <button
            type="button"
            onClick={() => setWithdrawOpen(true)}
            className="flex items-center justify-center gap-2 rounded-xl bg-sky-500 px-5 py-3 text-sm font-bold text-slate-950 transition hover:bg-sky-400"
          >
            <ArrowUpFromLine className="h-4 w-4" />
            提領資金
          </button>
        </div>
      </section>
      <section>
        <h2 className="mb-4 text-xl font-bold">{t("holdings")}</h2>
        <div className="flex flex-col gap-6">
          {holdingGroups.map((group) => (
            <section
              key={group.id}
              aria-labelledby={`holding-group-${group.id}`}
              className="flex flex-col gap-3"
            >
              <header className="flex items-end justify-between gap-4">
                <div>
                  <h3
                    id={`holding-group-${group.id}`}
                    className="font-semibold text-slate-100"
                  >
                    {group.title}
                  </h3>
                  <p className="mt-1 text-sm text-slate-500">
                    {group.description}
                  </p>
                </div>
                <span className="shrink-0 rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-semibold text-slate-300">
                  {group.holdings.length} {language.startsWith("zh") ? "項" : "assets"}
                </span>
              </header>
              {group.holdings.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 p-6 text-center text-sm text-slate-500">
                  {language.startsWith("zh")
                    ? `目前沒有${group.title}`
                    : `No ${group.title.toLowerCase()}`}
                </p>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
          {group.holdings.map((h) => {
            const asset = h.assetId === AE_TOKEN_GROUP_ID ? undefined : assetFor(h.assetId);
            const name =
              h.assetId === AE_TOKEN_GROUP_ID
                ? "AE 代幣"
                : localizedAssetFor(h.assetId)?.name ?? asset?.name ?? h.assetId;
            const avg = avgBuyPriceFor(h.assetId);
            const expanded = expandedAssetId === h.assetId;
            const trades = (tradesByAsset.get(h.assetId) ?? [])
              .slice()
              .reverse();
            // 全站以 JC 計價：持倉現價與市值皆為 JC（currentMarketPrice 回傳 JC 單價）。
            // 合併後的 AE 代幣以二級市場單一現價計算，而非各發行輪次的加權平均。
            const unitPrice =
              h.assetId === AE_TOKEN_GROUP_ID
                ? aeMarketPrice
                : asset
                  ? currentMarketPrice(asset)
                  : h.tokens > 0
                    ? h.value / h.tokens
                    : 0;
            const showAmount = (value: number) => formatJC(value);
            return (
              <article
                key={h.assetId}
                className={`overflow-hidden rounded-2xl border bg-slate-900 transition-colors ${
                  expanded ? "border-sky-500/60 sm:col-span-2" : "border-slate-800"
                }`}
              >
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() =>
                    setExpandedAssetId((current) =>
                      current === h.assetId ? null : h.assetId,
                    )
                  }
                  className="flex w-full items-start justify-between gap-4 p-5 text-left"
                >
                  <div className="min-w-0">
                    <p className="truncate font-bold">{name}</p>
                    <span className="mt-2 inline-flex rounded-md bg-slate-800 px-2 py-1 text-xs font-semibold text-sky-300">
                      {group.title}
                    </span>
                    <p className="mt-2 text-sm text-slate-400">
                      {language.startsWith("zh") ? "持有份額" : "Shares"}：
                      {h.tokens.toLocaleString("en-US")} {t("units")}
                    </p>
                    <p className="mt-1 text-sm text-slate-400">
                      {language.startsWith("zh") ? "平均買價" : "Avg. cost"}：
                      {avg == null ? "—" : showAmount(avg)}
                    </p>
                    <p className="mt-1 text-sm text-slate-400">
                      {language.startsWith("zh") ? "現價" : "Current price"}：
                      {showAmount(unitPrice)}
                    </p>
                    <p className="mt-3 text-lg font-bold text-amber-300">
                      {showAmount(h.value)}
                    </p>
                  </div>
                  <ChevronDown
                    className={`mt-1 h-5 w-5 shrink-0 text-slate-400 transition-transform ${
                      expanded ? "rotate-180" : ""
                    }`}
                  />
                </button>
                {expanded && (
                  <div className="border-t border-slate-800 bg-slate-950/40 p-5">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      <Stat
                        label={language.startsWith("zh") ? "持有份額" : "Shares"}
                        value={`${h.tokens.toLocaleString("en-US")} ${t("units")}`}
                      />
                      <Stat
                        label={
                          language.startsWith("zh") ? "平均買價" : "Avg. cost"
                        }
                        value={avg == null ? "—" : showAmount(avg)}
                      />
                      <Stat
                        label={
                          language.startsWith("zh") ? "現價" : "Current price"
                        }
                        value={showAmount(unitPrice)}
                      />
                      <Stat
                        label={
                          language.startsWith("zh") ? "目前市值" : "Market value"
                        }
                        value={showAmount(h.value)}
                      />
                    </div>
                    <h3 className="mt-5 text-sm font-semibold text-slate-300">
                      {language.startsWith("zh")
                        ? "交易紀錄"
                        : "Trade history"}
                    </h3>
                    <div className="mt-3 overflow-x-auto rounded-xl border border-slate-800">
                      <table className="w-full min-w-[520px] text-left text-sm">
                        <thead className="bg-slate-900 text-xs text-slate-500">
                          <tr>
                            <th className="p-3">
                              {interfaceText(language, "transactionType")}
                            </th>
                            <th className="p-3">
                              {language.startsWith("zh") ? "份額" : "Shares"}
                            </th>
                            <th className="p-3">
                              {language.startsWith("zh") ? "成交單價" : "Price"}
                            </th>
                            <th className="p-3">
                              {interfaceText(language, "amount")}
                            </th>
                            <th className="p-3">{t("fee")}</th>
                            <th className="p-3">Gas</th>
                            <th className="p-3">
                              {interfaceText(language, "time")}
                            </th>
                            <th className="p-3">
                              {interfaceText(language, "ledgerId")}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {trades.map((tx) => {
                            // Sell rows store quantity as negative (a
                            // holdings decrease), so this must compare the
                            // absolute value or every sell's unit price
                            // silently renders as "—".
                            const absQuantity = Math.abs(tx.quantity ?? 0);
                            const rowGross = tx.gross;
                            const netFlow = tx.net;
                            const unit =
                              absQuantity > 0 ? rowGross / absQuantity : null;
                            return (
                              <tr
                                key={tx.id}
                                className="border-t border-slate-800"
                              >
                                <td className="p-3">
                                  {transactionTypeLabel[tx.type]}
                                </td>
                                <td className="p-3 text-slate-300">
                                  {tx.quantity
                                    ? tx.quantity.toLocaleString("en-US")
                                    : "—"}
                                </td>
                                <td className="p-3 text-slate-300">
                                  {unit == null ? "—" : showAmount(unit)}
                                </td>
                                <td
                                  className={`p-3 font-semibold ${
                                    netFlow >= 0
                                      ? "text-emerald-400"
                                      : "text-red-400"
                                  }`}
                                >
                                  {netFlow >= 0 ? "+" : "-"}
                                  {showAmount(Math.abs(netFlow))}
                                </td>
                                <td className="p-3 text-slate-400">
                                  {formatJC(tx.fee)}
                                </td>
                                <td className="p-3 text-slate-400">
                                  {formatUSDT(tx.gas ?? 0)}
                                </td>
                                <td className="p-3 text-slate-400">
                                  {new Intl.DateTimeFormat(language, {
                                    dateStyle: "medium",
                                    timeStyle: "short",
                                  }).format(new Date(tx.createdAt))}
                                </td>
                                <td className="p-3 font-mono text-xs text-slate-500">
                                  {tx.hash.slice(0, 12)}…
                                </td>
                              </tr>
                            );
                          })}
                          {trades.length === 0 && (
                            <tr>
                              <td
                                colSpan={8}
                                className="p-6 text-center text-slate-500"
                              >
                                {language.startsWith("zh")
                                  ? "沒有此標的的交易紀錄"
                                  : "No trades for this asset"}
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
                </div>
              )}
            </section>
          ))}
        </div>
      </section>
      <section>
        <div className="mb-4 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <h2 className="text-xl font-bold">{t("recent")}</h2>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
            <label className="grid gap-1 text-xs text-slate-400">
              {tr("dateRange") === "dateRange" ? "Date range" : tr("dateRange")}
              <select
                value={preset}
                onChange={(event) =>
                  setPreset(event.target.value as DatePreset)
                }
                className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              >
                <option value="all">{tr("all")}</option>
                <option value="week">
                  {language.startsWith("zh") ? "本周" : "This week"}
                </option>
                <option value="month">
                  {language.startsWith("zh") ? "本月" : "This month"}
                </option>
                <option value="year">
                  {language.startsWith("zh") ? "今年" : "This year"}
                </option>
                <option value="custom">
                  {language.startsWith("zh") ? "自訂日期" : "Custom dates"}
                </option>
              </select>
            </label>
            {preset === "custom" && (
              <>
                <label className="grid gap-1 text-xs text-slate-400">
                  {language.startsWith("zh") ? "開始日期" : "Start date"}
                  <input
                    type="date"
                    value={startDate}
                    onChange={(event) => setStartDate(event.target.value)}
                    className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                  />
                </label>
                <label className="grid gap-1 text-xs text-slate-400">
                  {language.startsWith("zh") ? "結束日期" : "End date"}
                  <input
                    type="date"
                    value={endDate}
                    min={startDate || undefined}
                    onChange={(event) => setEndDate(event.target.value)}
                    className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                  />
                </label>
              </>
            )}
          </div>
        </div>
        <div className="overflow-x-auto rounded-2xl border border-slate-800">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="bg-slate-900 text-xs text-slate-500">
              <tr>
                <th className="p-4">{interfaceText(language, "transactionType")}</th>
                <th className="p-4">{interfaceText(language, "asset")}</th>
                <th className="p-4">{interfaceText(language, "amount")}</th>
<th className="p-4">{t("fee")}</th>
<th className="p-4">Gas</th>
<th className="p-4">{interfaceText(language, "time")}</th>
                <th className="p-4">{interfaceText(language, "ledgerId")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredTransactions.map((tx) => (
                <tr key={tx.id} className="border-t border-slate-800">
                  <td className="p-4">{transactionTypeLabel[tx.type]}</td>
                  <td className="p-4">
                    {(tx.assetId && localizedAssetFor(tx.assetId)?.name) ??
                      tx.asset}
                  </td>
                  {(() => {
                    // 全站以 JC 計價；僅入金與 JC↔USDT 金庫兌換以 USDT 顯示。
                    const flow = tx.net;
                    const positive = flow >= 0;
                    const fmt = tx.currency === "usdt" ? formatUSDT : formatJC;
                    return (
                      <td
                        className={`p-4 font-semibold ${positive ? "text-emerald-400" : "text-red-400"}`}
                      >
                        {positive ? "+" : "-"}
                        {fmt(Math.abs(flow))}
                      </td>
                    );
                  })()}
<td className="p-4 text-slate-400">{tx.currency === "usdt" ? formatUSDT(tx.fee) : formatJC(tx.fee)}</td>
<td className="p-4 text-slate-400">{formatUSDT(tx.gas ?? 0)}</td>
<td className="p-4 text-slate-400">
                    {new Intl.DateTimeFormat(language, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(tx.createdAt))}
                  </td>
                  <td className="p-4 font-mono text-xs text-slate-500">
                    {tx.hash.slice(0, 12)}…
                  </td>
                </tr>
              ))}
              {filteredTransactions.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-slate-500">
                    {language.startsWith("zh")
                      ? "此區間沒有交易紀錄"
                      : "No transactions in this date range"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      {withdrawOpen && (
          <WithdrawModal
            available={balance}
            onClose={() => setWithdrawOpen(false)}
          />
      )}
      {vaultOpen && (
        <VaultModal
          usdtBalance={balance}
          jcBalance={jcBalance}
          jcPrice={jcPrice}
          walletAddress={walletAddress}
          onClose={() => setVaultOpen(false)}
          onDone={refresh}
        />
      )}
    </div>
  );
}

// JC 金庫：以平台設定的 JC 單價，雙向兌換 USDT ↔ JC（買入 JC / 向平台回收 JC 換回
// USDT）。兌換率兩個方向相同，皆為 admin 設定的 jc_price。
function VaultModal({
  usdtBalance,
  jcBalance,
  jcPrice,
  walletAddress,
  onClose,
  onDone,
}: {
  usdtBalance: number;
  jcBalance: number;
  jcPrice: number;
  walletAddress: string | null;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [direction, setDirection] = useState<"buy" | "redeem">("buy");
  const [jcAmount, setJcAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const numericJc = Number(jcAmount);
  const usdtValue = Number.isFinite(numericJc) ? numericJc * jcPrice : 0;
  const buying = direction === "buy";
  const valid =
    jcAmount.trim() !== "" &&
    Number.isFinite(numericJc) &&
    numericJc > 0 &&
    (buying ? usdtValue <= usdtBalance : numericJc <= jcBalance);
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setNotice(null);
    // 買入 JC 前，重新讀取一次最新鏈上 USDT 餘額做最終判斷，避免輪詢間隔造成
    // 誤放行（例如剛好在兩次輪詢之間餘額被花掉）。
    if (buying) {
      const freshBalance = await fetchOnChainUsdtBalance(walletAddress);
      if (usdtValue > freshBalance) {
        setBusy(false);
        setNotice({ text: "USDT 餘額不足", ok: false });
        return;
      }
    }
    const { error } = await supabase.rpc("vault_exchange_jc", {
      direction,
      jc_amount: numericJc,
      request_key: crypto.randomUUID(),
    });
    setBusy(false);
    if (error) {
      const map: Record<string, string> = {
        "insufficient usdt": "USDT 餘額不足",
        "insufficient jc": "JC 餘額不足",
        "jc price unavailable": "JC 單價暫時無法取得",
      };
      setNotice({ text: map[error.message] ?? "兌換失敗，請稍後再試", ok: false });
      return;
    }
    setNotice({
      text: buying
        ? `已用 ${formatUSDT(usdtValue)} 兌換 ${formatJC(numericJc)}`
        : `已回收 ${formatJC(numericJc)} 兌換 ${formatUSDT(usdtValue)}`,
      ok: true,
    });
    setJcAmount("");
    await onDone();
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="vault-title"
    >
      <div className="w-full max-w-md rounded-t-3xl border border-slate-700 bg-slate-900 p-6 sm:rounded-3xl">
        <div className="flex items-center justify-between">
          <h2 id="vault-title" className="text-xl font-bold text-slate-100">
            JC 金庫兌換
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="關閉"
            className="rounded-full p-1 text-slate-400 hover:text-slate-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-2 rounded-2xl border border-slate-700 bg-slate-950/60 p-1">
          <button
            type="button"
            onClick={() => setDirection("buy")}
            className={`rounded-xl px-3 py-2 text-sm font-semibold transition ${
              buying ? "bg-sky-500 text-slate-950" : "text-slate-300"
            }`}
          >
            買入 JC（USDT→JC）
          </button>
          <button
            type="button"
            onClick={() => setDirection("redeem")}
            className={`rounded-xl px-3 py-2 text-sm font-semibold transition ${
              !buying ? "bg-sky-500 text-slate-950" : "text-slate-300"
            }`}
          >
            回收 JC（JC→USDT）
          </button>
        </div>
        <div className="mt-4 flex items-center justify-between rounded-2xl border border-slate-700 bg-slate-950/60 p-4 text-sm">
          <span className="text-slate-400">兌換率</span>
          <span className="font-bold text-slate-100">1 JC = {formatUSDT(jcPrice)}</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <p className="text-slate-500">可用 USDT</p>
            <p className="mt-1 font-semibold text-slate-100">{formatUSDT(usdtBalance)}</p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <p className="text-slate-500">可用 JC</p>
            <p className="mt-1 font-semibold text-amber-300">{formatJC(jcBalance)}</p>
          </div>
        </div>
        <label className="mt-5 block text-sm font-semibold text-slate-300">
          JC 數量
          <div className="mt-2 flex items-center gap-2">
            <input
              inputMode="decimal"
              value={jcAmount}
              onChange={(event) => setJcAmount(event.target.value)}
              placeholder="0"
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none focus:border-sky-500"
            />
            <button
              type="button"
              onClick={() =>
                setJcAmount(String(buying ? Math.floor((usdtBalance / (jcPrice || 1)) * 1e6) / 1e6 : jcBalance))
              }
              className="shrink-0 rounded-xl border border-slate-700 px-3 py-3 text-xs font-semibold text-slate-300 hover:border-sky-500"
            >
              全部
            </button>
          </div>
        </label>
        <p className="mt-2 text-sm text-slate-400">
          {buying ? "需支付" : "可換回"}：
          <b className="text-slate-100">{formatUSDT(usdtValue)}</b>
        </p>
        {jcAmount.trim() !== "" && !valid && (
          <p className="mt-2 text-xs text-red-400">
            {buying ? "USDT 餘額不足" : "JC 餘額不足"}
          </p>
        )}
        {notice && (
          <p className={`mt-3 text-sm ${notice.ok ? "text-emerald-400" : "text-red-400"}`}>
            {notice.text}
          </p>
        )}
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl border border-slate-700 px-4 py-3 font-bold text-slate-300 hover:border-slate-500"
          >
            關閉
          </button>
          <button
            type="button"
            disabled={!valid || busy}
            onClick={submit}
            className="flex-1 rounded-xl bg-sky-500 px-4 py-3 font-bold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "處理中…" : "確認兌換"}
          </button>
        </div>
      </div>
    </div>
  );
}

function WithdrawModal({
  available,
  onClose,
}: {
  available: number;
  onClose: () => void;
}) {
  // 提領地址預設留空，由用戶自行填寫欲轉入的 BASE 鏈 USDT 錢包地址。
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const numericAmount = Number(amount);
  const amountValid =
    amount.trim() !== "" &&
    Number.isFinite(numericAmount) &&
    numericAmount > 0 &&
    numericAmount <= available;
  const canSubmit = address.trim().length > 0 && amountValid;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="withdraw-title"
    >
      <div className="w-full max-w-md rounded-t-3xl border border-slate-700 bg-slate-900 p-6 sm:rounded-3xl">
        <div className="flex items-center justify-between">
          <h2 id="withdraw-title" className="text-xl font-bold text-slate-100">
            提領資金
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="關閉"
            className="rounded-full p-1 text-slate-400 hover:text-slate-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {submitted ? (
          <div className="mt-6 flex flex-col items-center gap-3 py-6 text-center">
            <CheckCircle2 className="h-12 w-12 text-emerald-400" />
            <p className="text-lg font-bold text-slate-100">提領申請已送出</p>
            <p className="text-sm text-slate-400">
              您的 USDT 提領申請已進入處理佇列，將於審核後由 BASE 鏈轉出。
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-2 w-full rounded-xl bg-sky-500 px-4 py-3 font-bold text-slate-950 hover:bg-sky-400"
            >
              完成
            </button>
          </div>
        ) : (
          <>
            <div className="mt-5 rounded-2xl border border-slate-700 bg-slate-950/60 p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-400">USDT 可用餘額</span>
                <span className="font-bold text-slate-100">{formatUSDT(available)}</span>
              </div>
            </div>

            <label className="mt-5 block text-sm font-semibold text-slate-300">
              提領地址（BASE 鏈 USDT）
              <input
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder="0x..."
                className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 font-mono text-sm text-slate-100 outline-none focus:border-sky-500"
              />
            </label>

            <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
              <p className="text-xs font-semibold leading-5 text-red-300">
                請選擇 BASE 鏈上接收 USDT 錢包！此操作為個人操作行為，如選擇錯誤錢包，平台不負一切責任！
              </p>
            </div>

            <label className="mt-5 block text-sm font-semibold text-slate-300">
              提領金額（USDT）
              <div className="mt-2 flex items-center gap-2">
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.00"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none focus:border-sky-500"
                />
                <button
                  type="button"
                  onClick={() => setAmount(String(available))}
                  className="shrink-0 rounded-xl border border-slate-700 px-3 py-3 text-xs font-semibold text-slate-300 hover:border-sky-500"
                >
                  全部
                </button>
              </div>
            </label>
            {amount.trim() !== "" && !amountValid && (
              <p className="mt-2 text-xs text-red-400">
                {numericAmount > available
                  ? "提領金額超過 USDT 可用餘額"
                  : "請輸入有效的提領金額"}
              </p>
            )}

            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-xl border border-slate-700 px-4 py-3 font-bold text-slate-300 hover:border-slate-500"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!canSubmit}
                onClick={() => setSubmitted(true)}
                className="flex-1 rounded-xl bg-sky-500 px-4 py-3 font-bold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                確認提領
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
