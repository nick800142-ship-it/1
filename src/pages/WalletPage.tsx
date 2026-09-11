import { Copy, CheckCircle2, Wallet, ChevronDown, ArrowUpFromLine, AlertTriangle, X, Lock } from "lucide-react";
import { useMemo, useState } from "react";
import { currentMarketPrice, formatAE, formatUSDT, interfaceText, rwaLiveView, useLanguage, usePlatform } from "@/platform";
import type { Transaction } from "@/platform";

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
  const { balance, holdings, transactions, assets, loading, walletAddress, availableAe, encumberedAe, rwaEscrows, aePrice } = usePlatform();
  const [copied, setCopied] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
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
      // tracks what the position could actually be sold for right now.
      const value = holding.tokens * (asset ? currentMarketPrice(asset) : 0);
      const existing = map.get(key);
      if (existing) {
        existing.tokens += holding.tokens;
        existing.value += value;
      } else {
        map.set(key, { assetId: key, tokens: holding.tokens, value });
      }
    }
    return Array.from(map.values());
  }, [visibleHoldings, assets]);
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

    // In-placement positions are escrows, not holdings, so the private section
    // is rendered separately from rwaEscrows. Any holding that exists here has
    // already settled into the secondary market.
    return [
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
  // Still-locked placement subscriptions, resolved to display names. These are
  // in-placement positions whose AE is escrowed but not yet a holding.
  // 每份圈存 / 圈存 AE 依「目前認購單價」（即時棘輪每份 AE）呈現，與認購頁一致；
  // 缺即時價時退回鎖定當下的 aeLocked/quantity。
  const escrowPositions = rwaEscrows.map((escrow) => {
    const asset = assetFor(escrow.assetId);
    const perShare = asset
      ? rwaLiveView(asset, aePrice).perShareAE
      : escrow.quantity > 0
        ? escrow.aeLocked / escrow.quantity
        : 0;
    return {
      ...escrow,
      name:
        localizedAssetFor(escrow.assetId)?.name ??
        asset?.name ??
        escrow.assetId,
      perShare,
      liveEscrowAe: perShare * escrow.quantity,
    };
  });
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
          {loading ? "—" : formatUSDT(balance + holdingsValue)}
        </p>
        <p className="mt-2 text-sm text-slate-400">
          持倉市值：{formatUSDT(holdingsValue)}
        </p>
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-700 bg-slate-950/60 p-4">
            <p className="text-xs text-slate-500">剩餘 USDT（可提領）</p>
            <p className="mt-1 text-xl font-bold text-slate-100">
              {loading ? "—" : formatUSDT(balance)}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-700 bg-slate-950/60 p-4">
            <p className="text-xs text-slate-500">可用 AE 餘額</p>
            <p className="mt-1 text-xl font-bold text-sky-300">
              {loading ? "—" : formatAE(availableAe)}
            </p>
          </div>
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
            <p className="flex items-center gap-1 text-xs text-amber-400/90">
              <Lock className="h-3 w-3" />圈存中 AE
            </p>
            <p className="mt-1 text-xl font-bold text-amber-300">
              {loading ? "—" : formatAE(encumberedAe)}
            </p>
          </div>
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
          <section
            aria-labelledby="holding-group-private"
            className="flex flex-col gap-3"
          >
            <header className="flex items-end justify-between gap-4">
              <div>
                <h3
                  id="holding-group-private"
                  className="font-semibold text-slate-100"
                >
                  {language.startsWith("zh")
                    ? "私募中資產"
                    : "Private placement assets"}
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  {language.startsWith("zh")
                    ? "仍處於私募認購階段的持倉（AE 已圈存，待標的進入二級市場後正式入帳）"
                    : "Holdings still in private placement (AE escrowed until the asset enters the secondary market)"}
                </p>
              </div>
              <span className="shrink-0 rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-semibold text-slate-300">
                {escrowPositions.length}{" "}
                {language.startsWith("zh") ? "項" : "assets"}
              </span>
            </header>
            {escrowPositions.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 p-6 text-center text-sm text-slate-500">
                {language.startsWith("zh")
                  ? "目前沒有私募中資產"
                  : "No private placement assets"}
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {escrowPositions.map((position) => {
                  const perShare = position.perShare;
                  return (
                    <article
                      key={position.assetId}
                      className="overflow-hidden rounded-2xl border border-amber-500/40 bg-slate-900"
                    >
                      <div className="p-5">
                        <p className="truncate font-bold">{position.name}</p>
                        <span className="mt-2 inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-1 text-xs font-semibold text-amber-300">
                          <Lock className="h-3 w-3" />
                          {language.startsWith("zh")
                            ? "私募認購中"
                            : "In placement"}
                        </span>
                        <p className="mt-2 text-sm text-slate-400">
                          {language.startsWith("zh") ? "持有份額" : "Shares"}：
                          {position.quantity.toLocaleString("en-US")}{" "}
                          {t("units")}
                        </p>
                        <p className="mt-1 text-sm text-slate-400">
                          {language.startsWith("zh")
                            ? "每份圈存"
                            : "Escrow / share"}
                          ：{formatAE(perShare)}
                        </p>
                        <p className="mt-3 text-lg font-bold text-amber-300">
                          {language.startsWith("zh") ? "圈存 AE" : "Escrowed AE"}{" "}
                          {formatAE(position.liveEscrowAe)}
                        </p>
                        <p className="mt-2 text-xs text-slate-500">
                          {language.startsWith("zh")
                            ? "標的進入二級市場後正式扣除 AE 並入帳份額"
                            : "AE is deducted and shares credited once the asset enters the secondary market"}
                        </p>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
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
            // AE 代幣持倉以 USDT 顯示（依二級市場價）；RWA 私募/二級持倉的 price
            // 欄位本身即為「每份 AE」，直接以 AE 顯示，不再除以 AE 現價（修正先前
            // 誤把每份 AE 當 USDT、再 /aePrice 造成的 0.01 縮放錯誤）。
            const isAeHolding = h.assetId === AE_TOKEN_GROUP_ID;
            const unitPrice = asset
              ? currentMarketPrice(asset)
              : h.tokens > 0
                ? h.value / h.tokens
                : 0;
            const showAmount = (value: number) =>
              isAeHolding ? formatUSDT(value) : formatAE(value);
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
                            // AE 計價（RWA 認購 / RWA 二級市場）：帳本 amount 反映 USDT 動向
                            // （認購為 0、二級賣方為 -手續費-Gas），實際 AE 金額記於
                            // metadata。買方讀 ae_paid、賣方讀 ae_received，統一存於
                            // aeAmount，並以買入=支出（負）、賣出=收入（正）呈現。
                            const aeSettled = tx.settlement === "ae";
                            const aeQty = tx.aeAmount ?? tx.aePaid ?? 0;
                            const rowGross = aeSettled ? aeQty : tx.gross;
                            const netFlow = aeSettled
                              ? (tx.type === "buy" ? -aeQty : aeQty)
                              : tx.net;
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
                                  {netFlow >= 0 ? "+" : ""}
                                  {isAeHolding
                                    ? formatUSDT(netFlow)
                                    : `${netFlow >= 0 ? "" : "-"}${showAmount(Math.abs(netFlow))}`}
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
                  {(() => {
                    // RWA（AE 計價）交易的金額以 AE 顯示：買入為支出（負 ae_paid）、
                    // 賣出為收入（正 ae_received），皆存於 aeAmount。其餘（AE 代幣、
                    // 提領、分潤等）維持 USDT 淨額。
                    const aeSettled = tx.settlement === "ae";
                    const aeQty = tx.aeAmount ?? tx.aePaid ?? 0;
                    const flow = aeSettled ? (tx.type === "buy" ? -aeQty : aeQty) : tx.net;
                    const positive = flow >= 0;
                    return (
                      <td
                        className={`p-4 font-semibold ${positive ? "text-emerald-400" : "text-red-400"}`}
                      >
                        {positive ? "+" : "-"}
                        {aeSettled ? formatAE(Math.abs(flow)) : formatUSDT(Math.abs(flow))}
                      </td>
                    );
                  })()}
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
      {withdrawOpen && (
        <WithdrawModal
          available={balance}
          walletAddress={walletAddress}
          onClose={() => setWithdrawOpen(false)}
        />
      )}
    </div>
  );
}

function WithdrawModal({
  available,
  walletAddress,
  onClose,
}: {
  available: number;
  walletAddress: string | null;
  onClose: () => void;
}) {
  const [address, setAddress] = useState(walletAddress ?? "");
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
