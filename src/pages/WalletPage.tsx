import { Copy, CheckCircle2, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { formatUSDT, useLanguage, usePlatform } from "@/platform";

const ADDRESS = "0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

type DatePreset = "all" | "week" | "month" | "year" | "custom";

export function WalletPage() {
  const { t, tr, language, assets: localizedAssets } = useLanguage();
  const { balance, holdings, transactions, assets, loading } = usePlatform();
  const [copied, setCopied] = useState(false);
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
  const holdingsValue = holdings.reduce(
    (sum, holding) =>
      sum + holding.tokens * (assetFor(holding.assetId)?.price ?? 0),
    0,
  );
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
          <p className="text-xs text-slate-500">
            測試 USDT 僅能由管理員後台發放
          </p>
        </div>
      </section>
      <section>
        <h2 className="mb-4 text-xl font-bold">{t("holdings")}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {holdings
            .filter((h) => h.tokens > 0)
            .map((h) => {
              const asset = assetFor(h.assetId);
              return (
                <article
                  key={h.assetId}
                  className="rounded-2xl border border-slate-800 bg-slate-900 p-5"
                >
                  <p className="font-bold">
                    {localizedAssetFor(h.assetId)?.name ??
                      asset?.name ??
                      h.assetId}
                  </p>
                  <p className="mt-2 text-sm text-slate-400">
                    {h.tokens.toLocaleString()} {t("units")}
                  </p>
                  <p className="mt-3 text-lg font-bold text-amber-300">
                    {formatUSDT(h.tokens * (asset?.price ?? 0))}
                  </p>
                </article>
              );
            })}
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
                <th className="p-4">類型</th>
                <th className="p-4">資產</th>
                <th className="p-4">金額</th>
                <th className="p-4">手續費</th>
                <th className="p-4">時間</th>
                <th className="p-4">流水 ID</th>
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
