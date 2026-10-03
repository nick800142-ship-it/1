import { Copy, CheckCircle2, Wallet, ChevronDown, ArrowUpFromLine, AlertTriangle, X, ArrowLeftRight, Clock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { currentMarketPrice, formatJC, formatUSDT, interfaceText, useLanguage, usePlatform } from "@/platform";
import type { Transaction } from "@/platform";
import { supabase } from "@/lib/supabase";
import { AE_TOKEN_CANONICAL_ID } from "@/lib/aeToken";
import { fetchOnChainUsdtBalance, fetchOnChainUsdtTransfers, useSendUsdt, useSendUsdtToVault } from "@/lib/onchainUsdt";
import { isTransactionHistoryVisible } from "@/lib/transactionHistory";
import { reconcilePendingSettlements, useOnchainSettlement } from "@/lib/onchainSettlement";
import { useOnChainBalancesByKey } from "@/lib/onchainContracts";
import { CONTRACT_ADDRESSES } from "@/lib/contracts";

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
  const { balance, holdings, transactions, commissionTransactions, assets, loading, walletAddress, jcBalance, jcBuyPrice, jcRedeemPrice, refresh } = usePlatform();
  const [copied, setCopied] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [expandedAssetId, setExpandedAssetId] = useState<string | null>(null);
  const [preset, setPreset] = useState<DatePreset>("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  // 近期交易的類型選擇：交易紀錄（一般認購/二級/金庫兌換）或分潤紀錄（已入帳的推廣分潤）。
  const [txKind, setTxKind] = useState<"trade" | "commission">("trade");
  const {
    data: onChainUsdtTransfers = [],
    error: onChainUsdtHistoryError,
  } = useSWR(
    walletAddress ? `usdt-transfer-history:${walletAddress.toLowerCase()}` : null,
    () => fetchOnChainUsdtTransfers(walletAddress),
    { refreshInterval: 15_000, revalidateOnFocus: true },
  );
  const onChainUsdtTransactions = useMemo<Transaction[]>(
    () =>
      onChainUsdtTransfers.map((transfer) => ({
        id: transfer.id,
        type: transfer.direction === "incoming" ? "deposit" : "withdraw",
        asset: `${language.startsWith("zh") ? (transfer.direction === "incoming" ? "鏈上 USDT 轉入" : "鏈上 USDT 轉出") : (transfer.direction === "incoming" ? "On-chain USDT received" : "On-chain USDT sent")}${transfer.counterparty ? ` · ${transfer.counterparty.slice(0, 8)}…${transfer.counterparty.slice(-4)}` : ""}`,
        gross: transfer.amount,
        fee: 0,
        net: transfer.direction === "incoming" ? transfer.amount : -transfer.amount,
        currency: "usdt",
        date: transfer.createdAt,
        createdAt: transfer.createdAt,
        hash: transfer.hash,
        status: "confirmed",
      })),
    [language, onChainUsdtTransfers],
  );
  const localizedAssetFor = (id: string) =>
    localizedAssets.find((asset) => asset.id === id);
  const transactionTypeLabel = {
    buy: t("buy"),
    sell: t("sell"),
    deposit: t("deposit"),
    withdraw: t("withdraw"),
    dividend: tr("dividend"),
    fee: language.startsWith("zh") ? "手續費" : "Fee",
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
  // 持倉份額改以「鏈上實際 balanceOf」即時顯示，與後台「持有資產（即時鏈上）」一致。
  // 這樣可涵蓋站內帳本看不到的變動（例如管理員直接從 Safe 金庫把份額轉進用戶錢包），
  // 避免前台錢包顯示的份額低於鏈上真實持有量。AE 為單一標準 ERC-20，RWA Factory
  // 模式下每個標的各有一顆專屬份額代幣（asset.tokenAddress）。
  const onChainEntries = useMemo(() => {
    const seen = new Map<string, string>();
    for (const holding of visibleHoldings) {
      const asset = assetFor(holding.assetId);
      if (!asset) continue;
      if (asset.isAeToken) {
        seen.set(AE_TOKEN_GROUP_ID, CONTRACT_ADDRESSES.aeToken);
      } else if (asset.tokenAddress) {
        seen.set(asset.id, asset.tokenAddress);
      }
    }
    return Array.from(seen.entries()).map(([key, tokenAddress]) => ({ key, tokenAddress }));
  }, [visibleHoldings, assets]);
  const { balances: onChainBalances } = useOnChainBalancesByKey(onChainEntries, walletAddress);
  const aggregatedHoldings = useMemo(() => {
    const map = new Map<string, { assetId: string; tokens: number; value: number; unitPrice: number }>();
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
        existing.unitPrice = unitValue;
      } else {
        map.set(key, { assetId: key, tokens: holding.tokens, value, unitPrice: unitValue });
      }
    }
    // 以鏈上實際持有份額覆蓋帳本推算的份額，並用該群組單價重算市值。只有查得到
    // 鏈上餘額（AE 或已部署專屬代幣的 RWA 標的）的群組才覆蓋，其餘維持帳本值。
    for (const entry of map.values()) {
      const onChain = onChainBalances[entry.assetId];
      if (onChain != null) {
        entry.tokens = onChain;
        entry.value = onChain * entry.unitPrice;
      }
    }
    return Array.from(map.values());
  }, [visibleHoldings, assets, aeMarketPrice, onChainBalances]);
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
    const source =
      txKind === "commission"
        ? commissionTransactions
        : [...transactions, ...onChainUsdtTransactions];
    return source.filter((transaction) => {
      const date = new Date(transaction.createdAt);
      return (
        isTransactionHistoryVisible(transaction.createdAt) &&
        (!start || date >= start) &&
        (!end || date <= end)
      );
    });
  }, [transactions, commissionTransactions, onChainUsdtTransactions, txKind, preset, startDate, endDate]);
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
              買入 {formatUSDT(jcBuyPrice)} · 回收 {formatUSDT(jcRedeemPrice)} / JC
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
                                colSpan={7}
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
          <div>
            <h2 className="text-xl font-bold">{t("recent")}</h2>
            {onChainUsdtHistoryError && (
              <p role="status" className="mt-2 text-xs text-amber-300">
                {language.startsWith("zh")
                  ? "暫時無法載入鏈上 USDT 轉帳紀錄，稍後會自動重試。"
                  : "On-chain USDT history is temporarily unavailable and will retry."}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
            <label className="grid gap-1 text-xs text-slate-400">
              {language.startsWith("zh") ? "類型" : "Type"}
              <select
                value={txKind}
                onChange={(event) =>
                  setTxKind(event.target.value as "trade" | "commission")
                }
                className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              >
                <option value="trade">
                  {language.startsWith("zh") ? "交易紀錄" : "Transactions"}
                </option>
                <option value="commission">
                  {language.startsWith("zh") ? "分潤紀錄" : "Commissions"}
                </option>
              </select>
            </label>
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
<td className="p-4 text-slate-400">
                    {new Intl.DateTimeFormat(language, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(tx.createdAt))}
                  </td>
                  <td className="p-4 font-mono text-xs text-slate-500">
                    {tx.hash.startsWith("0x") && tx.hash.length === 66 ? (
                      <a
                        href={`https://sepolia.basescan.org/tx/${tx.hash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sky-300 hover:underline"
                        aria-label={language.startsWith("zh") ? "在 BaseScan 查看鏈上交易" : "View on-chain transaction on BaseScan"}
                      >
                        {tx.hash.slice(0, 12)}…
                      </a>
                    ) : (
                      `${tx.hash.slice(0, 12)}…`
                    )}
                  </td>
                </tr>
              ))}
              {filteredTransactions.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-slate-500">
                    {language.startsWith("zh")
                      ? txKind === "commission"
                        ? "此區間沒有分潤紀錄"
                        : "此區間沒有交易紀錄"
                      : txKind === "commission"
                        ? "No commissions in this date range"
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
          jcBuyPrice={jcBuyPrice}
          jcRedeemPrice={jcRedeemPrice}
          walletAddress={walletAddress}
          onClose={() => setVaultOpen(false)}
          onDone={refresh}
        />
      )}
    </div>
  );
}

// JC 金庫買入與回收採用各自獨立的管理員設定價格。
function VaultModal({
  usdtBalance,
  jcBalance,
  jcBuyPrice,
  jcRedeemPrice,
  walletAddress,
  onClose,
  onDone,
}: {
  usdtBalance: number;
  jcBalance: number;
  jcBuyPrice: number;
  jcRedeemPrice: number;
  walletAddress: string | null;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [direction, setDirection] = useState<"buy" | "redeem">("buy");
  const [jcAmount, setJcAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<"idle" | "transferring" | "recording">("idle");
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [redemptionOrders, setRedemptionOrders] = useState<RedemptionOrder[]>([]);
  const { sendToVault } = useSendUsdtToVault();
  const { mintJcOnchain, settleRedemption } = useOnchainSettlement();
  const numericJc = Number(jcAmount);
  const buying = direction === "buy";
  const activePrice = buying ? jcBuyPrice : jcRedeemPrice;
  const usdtValue = Number.isFinite(numericJc) ? numericJc * activePrice : 0;
  const valid =
    jcAmount.trim() !== "" &&
    Number.isFinite(numericJc) &&
    numericJc > 0 &&
    (buying ? usdtValue <= usdtBalance : numericJc <= jcBalance);

  const loadOrders = async () => {
    const { data } = await supabase
      .from("redemption_orders")
      .select("id,jc_amount,usdt_amount,status,tx_hash,created_at")
      .order("created_at", { ascending: false })
      .limit(5);
    setRedemptionOrders((data ?? []) as RedemptionOrder[]);
  };
  useEffect(() => {
    void loadOrders();
    // 每次打開金庫都補跑一次：把之前因為前端呼叫失敗（例如 session/網路暫時性問
    // 題）而卡住、站內已扣款但鏈上還沒真的收到幣的購買/認購/成交，靜默重試補發。
    void reconcilePendingSettlements().then((result) => {
      if (result.fixed > 0) void onDone();
    });
  }, []);

  const submitBuy = async () => {
    // 重新讀取一次最新鏈上 USDT 餘額做最終判斷，避免輪詢間隔造成誤放行。
    const freshBalance = await fetchOnChainUsdtBalance(walletAddress);
    if (usdtValue > freshBalance) {
      setNotice({ text: "USDT 餘額不足", ok: false });
      return;
    }
    setStep("transferring");
    let txHash: `0x${string}`;
    try {
      txHash = await sendToVault(usdtValue);
    } catch (err) {
      setNotice({
        text: err instanceof Error ? `轉帳失敗：${err.message}` : "轉帳失敗，請稍後再試",
        ok: false,
      });
      setStep("idle");
      return;
    }
    setStep("recording");
    const requestKey = crypto.randomUUID();
    const { error } = await supabase.rpc("vault_buy_jc_onchain", {
      jc_amount: numericJc,
      tx_hash: txHash,
      request_key: requestKey,
    });
    if (error) {
      setStep("idle");
      const map: Record<string, string> = {
        "jc price unavailable": "JC 買入單價暫時無法取得",
        "tx hash already used": "此交易已被使用，請重新操作",
      };
      setNotice({
        text: `${map[error.message] ?? "記帳失敗，請稍後再試"}（轉帳已上鏈：${txHash}）`,
        ok: false,
      });
      return;
    }
    // 站內兌換已成功；再請 relayer（合約 owner）把等量 JC 真的 mint 到使用者錢包。
    // 失敗不影響已成功的兌換，只在訊息附註鏈上狀態。
    let onchainNote = "";
    try {
      const res = await mintJcOnchain(requestKey);
      const mintTx = typeof res.tx_hash === "string" ? res.tx_hash : null;
      onchainNote = mintTx ? `（鏈上已發幣 Tx: ${mintTx.slice(0, 10)}…）` : "（鏈上發幣處理中）";
    } catch (mintError) {
      onchainNote = `（鏈上發幣未完成：${mintError instanceof Error ? mintError.message : "稍後可重試"}）`;
    }
    setStep("idle");
    setNotice({ text: `已轉帳 ${formatUSDT(usdtValue)} 到金庫，兌換 ${formatJC(numericJc)}${onchainNote}`, ok: true });
    setJcAmount("");
    await onDone();
  };

  const submitRedeem = async () => {
    const { data, error } = await supabase.rpc("request_jc_redemption", {
      jc_amount: numericJc,
      request_key: crypto.randomUUID(),
    });
    if (error) {
      const map: Record<string, string> = {
        "insufficient jc": "JC 餘額不足",
        "jc redemption price unavailable": "JC 回收單價暫時無法取得",
        "no wallet bound": "尚未綁定錢包地址",
      };
      setNotice({ text: map[error.message] ?? "申請失敗，請稍後再試", ok: false });
      return;
    }
    const orderId = typeof (data as { order_id?: string } | null)?.order_id === "string" ? (data as { order_id: string }).order_id : null;
    // 站內已扣款、訂單已建立；立刻請 relayer 收回鏈上 JC 並直接撥 USDT 給使用者，
    // 不等管理員手動審核。失敗不影響已成立的訂單，cron sweep／後台會自動補發。
    let onchainNote = "，鏈上撥款處理中";
    if (orderId) {
      try {
        const res = await settleRedemption(orderId);
        const tx = typeof (res as { tx_hash?: string } | null)?.tx_hash === "string" ? (res as { tx_hash: string }).tx_hash : null;
        onchainNote = tx ? `，已鏈上撥款（Tx: ${tx.slice(0, 10)}…）` : "，鏈上撥款處理中";
      } catch (settleError) {
        onchainNote = `，鏈上撥款未完成：${settleError instanceof Error ? settleError.message : "稍後將自動補發"}`;
      }
    }
    setNotice({
      text: `已送出贖回申請：${formatJC(numericJc)} 換 ${formatUSDT(usdtValue)}${onchainNote}`,
      ok: true,
    });
    setJcAmount("");
    await loadOrders();
    await onDone();
  };

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setNotice(null);
    if (buying) {
      await submitBuy();
    } else {
      await submitRedeem();
    }
    setBusy(false);
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
        <div className="mt-4 rounded-2xl border border-slate-700 bg-slate-950/60 p-4 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-400">{buying ? "買入單價" : "回收單價"}</span>
            <span className="text-right font-bold text-slate-100">1 JC = {formatUSDT(activePrice)}</span>
          </div>
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
                setJcAmount(String(buying ? Math.floor((usdtBalance / (jcBuyPrice || 1)) * 1e6) / 1e6 : jcBalance))
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
        {redemptionOrders.length > 0 && (
          <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/40 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-400">
              <Clock className="h-3.5 w-3.5" /> 我的贖回申請
            </p>
            <ul className="space-y-1.5 text-xs">
              {redemptionOrders.map((order) => (
                <li key={order.id} className="flex items-center justify-between text-slate-300">
                  <span>
                    {formatJC(order.jc_amount)} → {formatUSDT(order.usdt_amount)}
                  </span>
                  <span
                    className={
                      order.status === "completed"
                        ? "text-emerald-400"
                        : order.status === "rejected"
                          ? "text-red-400"
                          : "text-amber-300"
                    }
                  >
                    {order.status === "completed"
                      ? "已撥款"
                      : order.status === "rejected"
                        ? "已退回 JC"
                        : "等待審核"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
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
            {busy
              ? step === "transferring"
                ? "轉帳至金庫中…"
                : step === "recording"
                  ? "記帳中…"
                  : "處理中…"
              : "確認兌換"}
          </button>
        </div>
      </div>
    </div>
  );
}

type RedemptionOrder = {
  id: string;
  jc_amount: number;
  usdt_amount: number;
  status: "pending" | "completed" | "rejected";
  tx_hash: string | null;
  created_at: string;
};

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
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // USDT 在使用者自己的內嵌錢包（自我保管），提領＝使用者自己簽名把 USDT 直接
  // 轉出到指定地址，無需任何審核或平台代簽。
  const { sendUsdt, sending } = useSendUsdt();
  const numericAmount = Number(amount);
  const amountValid =
    amount.trim() !== "" &&
    Number.isFinite(numericAmount) &&
    numericAmount > 0 &&
    numericAmount <= available;
  const canSubmit = address.trim().length > 0 && amountValid && !sending;
  const submitWithdraw = async () => {
    if (!canSubmit) return;
    setError(null);
    try {
      const hash = await sendUsdt(address.trim(), numericAmount);
      setTxHash(hash);
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "提領失敗，請稍後再試");
    }
  };
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
            <p className="text-lg font-bold text-slate-100">提領完成</p>
            <p className="text-sm text-slate-400">
              您的 USDT 已在 BASE 鏈上直接轉出至指定地址，通常數秒內即可到帳。
            </p>
            {txHash && (
              <a
                href={`https://sepolia.basescan.org/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="max-w-full truncate rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 font-mono text-xs text-sky-300 hover:border-sky-500"
              >
                {txHash}
              </a>
            )}
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
                請選擇 BASE 鏈上接收 USDT 的錢包！此操作由您自行發起，如選錯錢包，平台不負責任！
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
            {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={onClose}
                disabled={sending}
                className="flex-1 rounded-xl border border-slate-700 px-4 py-3 font-bold text-slate-300 hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!canSubmit}
                onClick={submitWithdraw}
                className="flex-1 rounded-xl bg-sky-500 px-4 py-3 font-bold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {sending ? "轉出中…" : "確認提領"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
