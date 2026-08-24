import { Copy, CheckCircle2, Wallet, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { formatUSDT, interfaceText, useLanguage, usePlatform } from "@/platform";
import type { Transaction } from "@/platform";

const ADDRESS = "0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

type DatePreset = "all" | "week" | "month" | "year" | "custom";

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
  const { balance, holdings, transactions, assets, loading } = usePlatform();
  const [copied, setCopied] = useState(false);
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
  const visibleHoldings = useMemo(
    () =>
      holdings.filter((holding) => {
        const asset = assets.find((candidate) => candidate.id === holding.assetId);
        return holding.tokens > 0 && Boolean(asset) && asset?.isActive !== false;
      }),
    [assets, holdings],
  );
  // Merge any positions that share the same assetId into one card.
  const aggregatedHoldings = useMemo(() => {
    const map = new Map<string, { assetId: string; tokens: number }>();
    for (const holding of visibleHoldings) {
      const existing = map.get(holding.assetId);
      if (existing) existing.tokens += holding.tokens;
      else map.set(holding.assetId, { assetId: holding.assetId, tokens: holding.tokens });
    }
    return Array.from(map.values());
  }, [visibleHoldings]);
  const holdingsValue = aggregatedHoldings.reduce(
    (sum, holding) =>
      sum + holding.tokens * (assetFor(holding.assetId)?.price ?? 0),
    0,
  );
  const holdingGroups = useMemo(() => {
    const now = Date.now();
    const isSecondaryAsset = (assetId: string) => {
      const marketStartedAt = assets.find(
        (asset) => asset.id === assetId,
      )?.marketStartedAt;
      return Boolean(
        marketStartedAt && new Date(marketStartedAt).getTime() <= now,
      );
    };

    return [
      {
        id: "private",
        title: language.startsWith("zh") ? "私募中資產" : "Private placement assets",
        description: language.startsWith("zh")
          ? "仍處於私募認購階段的持倉"
          : "Holdings still in private placement",
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
        const list = map.get(tx.assetId as string) ?? [];
        list.push(tx);
        map.set(tx.assetId as string, list);
      });
    return map;
  }, [transactions]);
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
    await navigator.clipboard.writeText(ADDRESS);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-3xl font-bold">{t("wallet")}</h1>
        <p className="mt-2 text-sm text-slate-400">
          Sandbox USDT · 流水帳精準計算
        </p>
      </header>
      <section className="rounded-3xl border border-slate-700 bg-slate-900 p-6 sm:p-8">
        <p className="flex items-center gap-2 text-sm text-slate-400">
          <Wallet className="h-4 w-4" />
          {tr("totalAssets")}
        </p>
        <p className="mt-2 text-4xl font-bold">
          {loading ? "—" : formatUSDT(balance + holdingsValue)}
        </p>
        <p className="mt-2 text-sm text-slate-400">
          {t("balance")}: {formatUSDT(balance)} · 持倉市值：
          {formatUSDT(holdingsValue)}
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button
            aria-label={tr("copyAddress")}
            onClick={copy}
            className="flex items-center gap-2 rounded-xl bg-slate-800 px-4 py-3 font-mono text-xs"
          >
            {ADDRESS.slice(0, 12)}...{ADDRESS.slice(-8)}
            {copied ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
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
            const asset = assetFor(h.assetId);
            const name =
              localizedAssetFor(h.assetId)?.name ?? asset?.name ?? h.assetId;
            const avg = avgBuyPriceFor(h.assetId);
            const expanded = expandedAssetId === h.assetId;
            const trades = (tradesByAsset.get(h.assetId) ?? [])
              .slice()
              .reverse();
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
                      {avg == null ? "—" : formatUSDT(avg)}
                    </p>
                    <p className="mt-3 text-lg font-bold text-amber-300">
                      {formatUSDT(h.tokens * (asset?.price ?? 0))}
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
                        value={avg == null ? "—" : formatUSDT(avg)}
                      />
                      <Stat
                        label={
                          language.startsWith("zh") ? "目前市值" : "Market value"
                        }
                        value={formatUSDT(h.tokens * (asset?.price ?? 0))}
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
                            const unit =
                              tx.quantity && tx.quantity > 0
                                ? tx.gross / tx.quantity
                                : null;
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
                                  {unit == null ? "—" : formatUSDT(unit)}
                                </td>
                                <td
                                  className={`p-3 font-semibold ${
                                    tx.net >= 0
                                      ? "text-emerald-400"
                                      : "text-red-400"
                                  }`}
                                >
                                  {tx.net >= 0 ? "+" : ""}
                                  {formatUSDT(tx.net)}
                                </td>
                                <td className="p-3 text-slate-400">
                                  {formatUSDT(tx.fee)}
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
                  <td
                    className={`p-4 font-semibold ${tx.net >= 0 ? "text-emerald-400" : "text-red-400"}`}
                  >
                    {tx.net >= 0 ? "+" : ""}
                    {formatUSDT(tx.net)}
                  </td>
<td className="p-4 text-slate-400">{formatUSDT(tx.fee)}</td>
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
    </div>
  );
}
