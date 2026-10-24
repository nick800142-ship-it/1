import { Copy, Check, CheckCircle2, Wallet, ChevronDown, ChevronUp, ArrowUpFromLine, AlertTriangle, X, ArrowLeftRight, Clock, ExternalLink, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { currentMarketPrice, formatJC, formatUnit, formatUSDT, interfaceText, localizedUiText, walletExchangeMessage, useLanguage, usePlatform } from "@/platform";
import type { Transaction } from "@/platform";
import { supabase } from "@/lib/supabase";
import { AE_TOKEN_CANONICAL_ID } from "@/lib/aeToken";
import { fetchOnChainUsdtBalance, fetchOnChainUsdtTransfers, useSendUsdt, useSendUsdtToVault } from "@/lib/onchainUsdt";
import { isTransactionHistoryVisible } from "@/lib/transactionHistory";
import { reconcilePendingSettlements, syncJcBalanceFromChain, useOnchainSettlement } from "@/lib/onchainSettlement";
import { useOnChainBalancesByKey } from "@/lib/onchainContracts";
import { CONTRACT_ADDRESSES } from "@/lib/contracts";
import { STABLECOIN_SYMBOL, explorerTxUrl } from "@/lib/network";

type DatePreset = "all" | "week" | "month" | "year" | "custom";

type WalletTransactionError = Error & {
  transactionHash?: string;
  reverted?: boolean;
  code?: number | string;
};

function transactionHashFromError(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const hash = (error as WalletTransactionError).transactionHash;
  return typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash) ? hash : null;
}

function isRejectedWalletRequest(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as WalletTransactionError;
  return Number(candidate.code) === 4001 || candidate.code === "ACTION_REJECTED";
}

function wasTransactionReverted(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as WalletTransactionError).reverted);
}

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
  const {
    balance,
    holdings,
    transactions,
    commissionTransactions,
    assets,
    loading,
    walletAddress,
    jcOnChainBalance,
    jcOnChainLoading,
    jcOnChainError,
    jcBuyPrice,
    jcRedeemPrice,
    refresh,
  } = usePlatform();
  const [copied, setCopied] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [expandedAssetId, setExpandedAssetId] = useState<string | null>(null);
  const [showAllTransactions, setShowAllTransactions] = useState(false);
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
        asset: `${localizedUiText(language, transfer.direction === "incoming" ? "온체인 USDT 받음" : "온체인 USDT 보냄", transfer.direction === "incoming" ? "鏈上 USDT 轉入" : "鏈上 USDT 轉出")}${transfer.counterparty ? ` · ${transfer.counterparty.slice(0, 8)}…${transfer.counterparty.slice(-4)}` : ""}`,
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
  const localizedAssetFor = useCallback(
    (id: string) => localizedAssets.find((asset) => asset.id === id),
    [localizedAssets],
  );
  const vaultPriceCopy: Record<string, { title: string; buy: string; redeem: string }> = {
    "zh-TW": { title: "兌換 JC", buy: "買入單價", redeem: "回收單價" },
    "zh-CN": { title: "兑换 JC", buy: "买入单价", redeem: "回收单价" },
    en: { title: "Exchange JC", buy: "Purchase price", redeem: "Redemption price" },
    ja: { title: "JCを交換", buy: "購入価格", redeem: "換金価格" },
    ko: { title: "JC 금고 교환", buy: "구매 단가", redeem: "상환 단가" },
    th: { title: "แลกเปลี่ยน JC", buy: "ราคาซื้อ", redeem: "ราคาแลกคืน" },
    vi: { title: "Đổi JC tại kho", buy: "Giá mua", redeem: "Giá quy đổi" },
    id: { title: "Tukar JC", buy: "Harga beli", redeem: "Harga penukaran" },
    ms: { title: "Tukar JC", buy: "Harga beli", redeem: "Harga penebusan" },
    es: { title: "Intercambiar JC", buy: "Precio de compra", redeem: "Precio de canje" },
    fr: { title: "Échanger des JC", buy: "Prix d’achat", redeem: "Prix de rachat" },
    de: { title: "JC tauschen", buy: "Kaufpreis", redeem: "Rücknahmepreis" },
    pt: { title: "Trocar JC", buy: "Preço de compra", redeem: "Preço de resgate" },
    ru: { title: "Обмен JC", buy: "Цена покупки", redeem: "Цена выкупа" },
    ar: { title: "تبادل JC", buy: "سعر الشراء", redeem: "سعر الاسترداد" },
    hi: { title: "JC एक्सचेंज", buy: "खरीद मूल्य", redeem: "रिडेम्पशन मूल्य" },
  };
  const vaultPrice = vaultPriceCopy[language] ?? vaultPriceCopy.en;
  const transactionTypeLabel = {
    buy: t("buy"),
    sell: t("sell"),
    deposit: t("deposit"),
    withdraw: t("withdraw"),
    dividend: tr("dividend"),
    fee: localizedUiText(language, "수수료", "手續費"),
    refund: localizedUiText(language, "환불", "退款"),
  } as const;
  const assetFor = useCallback(
    (id: string) => assets.find((asset) => asset.id === id),
    [assets],
  );
  // AE daily and bonus placements are the same token on one shared secondary
  // market, so the whole merged AE position must be valued at that market's
  // single current price (the canonical row's last matched trade), not a
  // per-placement blend of each round's own price.
  const aeMarketAsset = useMemo(
    () => assetFor(AE_TOKEN_CANONICAL_ID) ?? assets.find((asset) => asset.isAeToken),
    [assetFor, assets],
  );
  const aeMarketPrice = aeMarketAsset ? currentMarketPrice(aeMarketAsset) : 0;
  // Merge any positions that share the same assetId into one card. AE
  // tokens are additionally merged across their daily/bonus placement rows
  // into a single AE_TOKEN_GROUP_ID position, since users shouldn't need to
  // care which track a given unit came from. Value is summed per source row
  // (tokens x that row's own price) rather than recomputed after merging,
  // since daily and bonus rounds can have different prices.
  const groupKeyFor = useCallback(
    (assetId: string) => assetFor(assetId)?.isAeToken ? AE_TOKEN_GROUP_ID : assetId,
    [assetFor],
  );
  // AE/RWA 持倉以目前新合約的 balanceOf 為準，而非只查已存在 holdings 列的標的，
  // 因此熱錢包直接轉入但尚無站內 holdings 列時也會顯示。JC 在上方獨立顯示目前合約餘額；
  // RWA tokenAddress 已由現行 Factory 的 tokenByPlacement 驗證，舊 Factory 合約不會進入此表。
  const onChainEntries = useMemo(() => {
    const seen = new Map<string, string>();
    for (const asset of assets) {
      if (asset.isAeToken) {
        seen.set(AE_TOKEN_GROUP_ID, CONTRACT_ADDRESSES.aeToken);
      } else {
        seen.set(asset.id, asset.id);
      }
    }
    return Array.from(seen.entries()).map(([key, placementId]) =>
      key === AE_TOKEN_GROUP_ID
        ? { key, tokenAddress: CONTRACT_ADDRESSES.aeToken }
        : { key, placementId },
    );
  }, [assets]);
  const {
    balances: onChainBalances,
    loading: onChainHoldingsLoading,
    error: onChainHoldingsError,
  } = useOnChainBalancesByKey(onChainEntries, walletAddress);
  const visibleHoldings = useMemo(
    () =>
      holdings.filter((holding) => {
        const asset = assets.find((candidate) => candidate.id === holding.assetId);
        return (
          holding.tokens > 0 &&
          Boolean(asset) &&
          // RWA only counts after the current Factory returns a live token balance.
          (asset?.isAeToken || Object.prototype.hasOwnProperty.call(onChainBalances, asset?.id ?? "")) &&
          (asset?.isActive !== false || Boolean(asset?.marketStartedAt))
        );
      }),
    [assets, holdings, onChainBalances],
  );
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
    // 以新合約 balanceOf 覆蓋帳本推算份額；對尚無 holdings 列但已收到熱錢包轉帳的
    // 標的建立純展示項目。AE 使用單一新 AE 合約，RWA 只使用目前 Factory 驗證地址。
    for (const entry of map.values()) {
      const onChain = onChainBalances[entry.assetId];
      if (onChain != null) {
        entry.tokens = onChain;
        entry.value = onChain * entry.unitPrice;
      }
    }
    for (const [assetId, onChain] of Object.entries(onChainBalances)) {
      if (onChain <= 0 || map.has(assetId)) continue;
      const asset = assetId === AE_TOKEN_GROUP_ID ? aeMarketAsset : assetFor(assetId);
      if (!asset && assetId !== AE_TOKEN_GROUP_ID) continue;
      const unitPrice = assetId === AE_TOKEN_GROUP_ID
        ? aeMarketPrice
        : asset
          ? currentMarketPrice(asset)
          : 0;
      map.set(assetId, {
        assetId,
        tokens: onChain,
        value: onChain * unitPrice,
        unitPrice,
      });
    }
    return Array.from(map.values());
  }, [visibleHoldings, aeMarketPrice, aeMarketAsset, onChainBalances, assetFor, groupKeyFor]);
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
        title: language === "ko" ? "프라이빗 청약 보유 자산" : language.startsWith("zh") ? "私募認購持倉" : "Private placement holdings",
        description: language === "ko"
          ? "청약이 완료되었지만 2차 시장이 아직 열리지 않은 자산"
          : language.startsWith("zh")
            ? "已認購、尚未開放二級市場的持倉"
            : "Subscribed holdings not yet on the secondary market",
        holdings: aggregatedHoldings.filter(
          (holding) => !isSecondaryAsset(holding.assetId),
        ),
      },
      {
        id: "secondary",
        title: language === "ko" ? "2차 시장 자산" : language.startsWith("zh") ? "二級市場資產" : "Secondary market assets",
        description: language === "ko"
          ? "2차 시장에서 거래할 수 있는 보유 자산"
          : language.startsWith("zh")
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
  }, [transactions, groupKeyFor]);
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
          {loading || jcOnChainLoading || jcOnChainError || onChainHoldingsLoading || onChainHoldingsError
            ? "—"
            : formatJC(jcOnChainBalance + holdingsValue)}
        </p>
        <p className="mt-2 text-sm text-slate-400">
          {localizedUiText(language, "보유 자산 평가액:", "持倉市值：")} {onChainHoldingsLoading || onChainHoldingsError ? "—" : formatJC(holdingsValue)}
        </p>
        {(jcOnChainError || onChainHoldingsError) && (
          <p role="status" className="mt-2 text-xs text-amber-300">
            {localizedUiText(language, "온체인 잔액을 일시적으로 불러올 수 없습니다. 총액은 0으로 표시되지 않습니다.", "鏈上餘額暫時無法讀取，總額不會以 0 代替。")}
          </p>
        )}
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-700 bg-slate-950/60 p-4">
            <p className="text-xs text-slate-500">{localizedUiText(language, "사용 가능 JC", "可用 JC")}</p>
            <p className="mt-1 text-xl font-bold text-amber-300">
              {jcOnChainLoading
                ? "讀取中…"
                : jcOnChainError
                  ? "讀取失敗"
                  : formatJC(jcOnChainBalance)}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-700 bg-slate-950/60 p-4">
            <p className="flex items-center gap-1.5 text-xs text-slate-500">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </span>
              {localizedUiText(language, "사용 가능 USDT (온체인 잔액, 자동 업데이트)", "可用 USDT（鏈上餘額，自動更新）")}
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
              <ArrowLeftRight className="h-3 w-3" />{vaultPrice.title}
            </p>
            <p className="mt-1 text-sm font-semibold text-sky-200">
              {vaultPrice.buy} {formatUSDT(jcBuyPrice)} · {vaultPrice.redeem} {formatUSDT(jcRedeemPrice)} / JC
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
              : localizedUiText(language, "지갑 생성 중…", "錢包生成中…")}
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
            {localizedUiText(language, "자금 출금", "提領資金")}
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
                  {language === "ko" ? `${group.holdings.length}개 자산` : `${group.holdings.length} ${language.startsWith("zh") ? "項" : "assets"}`}
                </span>
              </header>
              {group.holdings.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 p-6 text-center text-sm text-slate-500">
                  {language === "ko"
                    ? `${group.title}이 없습니다.`
                    : language.startsWith("zh")
                      ? `目前沒有${group.title}`
                      : `No ${group.title.toLowerCase()}`}
                </p>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
          {group.holdings.map((h) => {
            const asset = h.assetId === AE_TOKEN_GROUP_ID ? undefined : assetFor(h.assetId);
            const name =
              h.assetId === AE_TOKEN_GROUP_ID
                ? "AE"
                : asset?.name ?? localizedAssetFor(h.assetId)?.name ?? h.assetId;
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
            const costBasis = avg != null && avg > 0 ? avg * h.tokens : null;
            const returnPercent =
              costBasis != null && costBasis > 0 && unitPrice > 0
                ? ((h.value - costBasis) / costBasis) * 100
                : null;
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
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <p className="min-w-0 truncate font-bold">{name}</p>
                      {group.id === "secondary" && (
                        <span
                          aria-label={
                            returnPercent == null
                              ? language.startsWith("zh")
                                ? "買入成本資料不足，無法計算漲跌幅"
                                : "Purchase cost data unavailable"
                              : `${language.startsWith("zh") ? "相對買入成本漲跌" : "Change vs. purchase cost"}: ${returnPercent >= 0 ? "+" : ""}${returnPercent.toFixed(2)}%`
                          }
                          title={
                            language.startsWith("zh")
                              ? "依累計買入成本計算"
                              : "Based on cumulative purchase cost"
                          }
                          className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums ${
                            returnPercent == null
                              ? "border-slate-700 bg-slate-800 text-slate-400"
                              : returnPercent >= 0
                                ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
                                : "border-red-400/20 bg-red-400/10 text-red-300"
                          }`}
                        >
                          {returnPercent == null
                            ? "—"
                            : `${returnPercent >= 0 ? "+" : ""}${returnPercent.toFixed(2)}%`}
                        </span>
                      )}
                    </div>
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
                      {localizedUiText(language, "거래 내역", "交易紀錄")}
                    </h3>
                    <div className="mt-3 overflow-x-auto rounded-xl border border-slate-800">
                      <table className="w-full min-w-[520px] text-left text-sm">
                        <thead className="bg-slate-900 text-xs text-slate-500">
                          <tr>
                            <th className="p-3">
                              {interfaceText(language, "transactionType")}
                            </th>
                            <th className="p-3">
                              {localizedUiText(language, "보유 지분", "份額")}
                            </th>
                            <th className="p-3">
                              {localizedUiText(language, "거래 단가", "成交單價")}
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
                                  {tx.currency === "ae"
                                    ? formatUnit(Math.abs(netFlow), "ae")
                                    : showAmount(Math.abs(netFlow))}
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
                                {localizedUiText(language, "이 자산의 거래 내역이 없습니다", "沒有此標的的交易紀錄")}
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
                  ? `暫時無法載入鏈上 ${STABLECOIN_SYMBOL} 轉帳紀錄，稍後會自動重試。`
                  : `On-chain ${STABLECOIN_SYMBOL} history is temporarily unavailable and will retry.`}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
            <label className="grid gap-1 text-xs text-slate-400">
              {interfaceText(language, "transactionType")}
              <select
                value={txKind}
                onChange={(event) =>
                  setTxKind(event.target.value as "trade" | "commission")
                }
                className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              >
                <option value="trade">
                  {localizedUiText(language, "거래", "交易紀錄")}
                </option>
                <option value="commission">
                  {localizedUiText(language, "분배 내역", "分潤紀錄")}
                </option>
              </select>
            </label>
            <label className="grid gap-1 text-xs text-slate-400">
              {tr("dateRange") === "dateRange" ? localizedUiText(language, "날짜 범위", "日期範圍") : tr("dateRange")}
              <select
                value={preset}
                onChange={(event) =>
                  setPreset(event.target.value as DatePreset)
                }
                className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              >
                <option value="all">{tr("all")}</option>
                <option value="week">
                  {localizedUiText(language, "이번 주", "本週")}
                </option>
                <option value="month">
                  {localizedUiText(language, "이번 달", "本月")}
                </option>
                <option value="year">
                  {localizedUiText(language, "올해", "今年")}
                </option>
                <option value="custom">
                  {localizedUiText(language, "직접 날짜", "自訂日期")}
                </option>
              </select>
            </label>
            {preset === "custom" && (
              <>
                <label className="grid gap-1 text-xs text-slate-400">
                  {localizedUiText(language, "시작 날짜", "開始日期")}
                  <input
                    type="date"
                    value={startDate}
                    onChange={(event) => setStartDate(event.target.value)}
                    className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                  />
                </label>
                <label className="grid gap-1 text-xs text-slate-400">
                  {localizedUiText(language, "종료 날짜", "結束日期")}
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
        {(() => {
          const recentTransactions = showAllTransactions
            ? filteredTransactions
            : filteredTransactions.slice(0, 10);
          const hasHiddenTransactions = filteredTransactions.length > 10;

          return (
            <>
              <div className="overflow-x-auto rounded-2xl border border-slate-800">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead className="bg-slate-900 text-xs text-slate-500">
              <tr>
                <th className="whitespace-nowrap p-4">{interfaceText(language, "time")}</th>
                <th className="whitespace-nowrap p-4">{interfaceText(language, "transactionType")}</th>
                <th className="whitespace-nowrap p-4">{interfaceText(language, "asset")}</th>
                <th className="whitespace-nowrap p-4">{interfaceText(language, "unitPrice")}</th>
                <th className="whitespace-nowrap p-4">{interfaceText(language, "quantity")}</th>
                <th className="whitespace-nowrap p-4">{interfaceText(language, "amount")}</th>
                <th className="whitespace-nowrap p-4">{t("fee")}</th>
                <th className="whitespace-nowrap p-4">{language.startsWith("zh") ? "狀態" : "Status"}</th>
                <th className="whitespace-nowrap p-4">{interfaceText(language, "ledgerId")}</th>
              </tr>
            </thead>
            <tbody>
              {recentTransactions.map((tx) => {
                // 單價與手續費以支付幣別計價（AE 獎勵的單價為 0 JC），金額欄則顯示實際入帳的資產單位。
                const formatCurrency = tx.currency === "usdt" ? formatUSDT : formatJC;
                const formatAmount = (value: number) => formatUnit(value, tx.currency ?? "jc");
                const unitPrice =
                  tx.quantity && tx.quantity > 0 ? tx.gross / tx.quantity : null;
                const positive = tx.net >= 0;
                return (
                  <tr key={tx.id} className="border-t border-slate-800">
                    <td className="whitespace-nowrap p-4 text-slate-400">
                      {new Intl.DateTimeFormat(language, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(tx.createdAt))}
                    </td>
                    <td className="whitespace-nowrap p-4">
                      {tx.entryType === "town_ae"
                        ? `${localizedUiText(language, "마을에서 찾은 AE", "小鎮找到 AE")}${
                            tx.status === "confirmed"
                              ? localizedUiText(language, " (지급 완료)", "（已發放）")
                              : localizedUiText(language, " (지급 대기)", "（待發放）")
                          }`
                        : tx.entryType === "town_bomb"
                          ? localizedUiText(language, "RWMT 폭탄 벌금", "RWMT 炸彈罰款")
                          : transactionTypeLabel[tx.type]}
                    </td>
                    <td className="whitespace-nowrap p-4">
                      {tx.asset || (tx.assetId && localizedAssetFor(tx.assetId)?.name)}
                    </td>
                    <td className="whitespace-nowrap p-4 text-slate-300">
                      {unitPrice == null ? "—" : formatCurrency(unitPrice)}
                    </td>
                    <td className="whitespace-nowrap p-4 text-slate-300">
                      {tx.quantity == null
                        ? "—"
                        : tx.quantity.toLocaleString(language, { maximumFractionDigits: 6 })}
                    </td>
                    <td className={`whitespace-nowrap p-4 font-semibold ${positive ? "text-emerald-400" : "text-red-400"}`}>
                      {positive ? "+" : "-"}{formatAmount(Math.abs(tx.net))}
                    </td>
                    <td className="whitespace-nowrap p-4 text-slate-400">{formatCurrency(tx.fee)}</td>
                    <td className="whitespace-nowrap p-4">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                        tx.status === "confirmed" ? "bg-emerald-400/10 text-emerald-300" :
                        tx.status === "pending" ? "bg-amber-400/10 text-amber-200" :
                        tx.status === "refunded" ? "bg-sky-400/10 text-sky-200" :
                        "bg-red-400/10 text-red-300"
                      }`}>
                        {tx.status === "confirmed" ? (language.startsWith("zh") ? "已完成" : "Confirmed") :
                         tx.status === "pending" ? (language.startsWith("zh") ? "處理中" : "Processing") :
                         tx.status === "refunded" ? (language.startsWith("zh") ? "已退款" : "Refunded") :
                         tx.status === "cancelled" ? (language.startsWith("zh") ? "已取消" : "Cancelled") :
                         (language.startsWith("zh") ? "失敗，待處理" : "Failed")}
                      </span>
                      {tx.statusReason && tx.status !== "confirmed" && (
                        <p className="mt-1 max-w-48 truncate text-[10px] text-slate-500" title={tx.statusReason}>
                          {tx.statusReason}
                        </p>
                      )}
                    </td>
                    <td className="whitespace-nowrap p-4 font-mono text-xs text-slate-500" title={tx.hash}>
                      {tx.hash.startsWith("0x") && tx.hash.length === 66 ? (
                        <a
                          href={explorerTxUrl(tx.hash)}
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
                );
              })}
              {filteredTransactions.length === 0 && (
                <tr>
                  <td colSpan={9} className="p-8 text-center text-slate-500">
                    {localizedUiText(
                      language,
                      txKind === "commission"
                        ? "이 기간에 분배 기록이 없습니다"
                        : "이 기간에 거래 기록이 없습니다",
                      txKind === "commission"
                        ? "此區間沒有分潤紀錄"
                        : "此區間沒有交易紀錄",
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
              </div>
              {hasHiddenTransactions && (
                <button
                  type="button"
                  onClick={() => setShowAllTransactions((expanded) => !expanded)}
                  className="mx-auto mt-3 flex items-center gap-2 rounded-full px-4 py-2 text-sm text-slate-400 transition hover:bg-slate-900 hover:text-slate-100"
                  aria-expanded={showAllTransactions}
                  aria-label={showAllTransactions
                    ? (language.startsWith("zh") ? "收合較早的交易紀錄" : "Collapse older transactions")
                    : (language.startsWith("zh") ? "展開較早的交易紀錄" : "Show older transactions")}
                >
                  {showAllTransactions ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  {showAllTransactions
                    ? (language.startsWith("zh") ? "收合較早紀錄" : "Show fewer")
                    : (language.startsWith("zh") ? `查看更多（${filteredTransactions.length - 10}）` : `Show more (${filteredTransactions.length - 10})`)}
                </button>
              )}
            </>
          );
        })()}
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
          jcOnChainBalance={jcOnChainBalance}
          jcOnChainLoading={jcOnChainLoading}
          jcOnChainError={jcOnChainError}
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
  jcOnChainBalance,
  jcOnChainLoading,
  jcOnChainError,
  jcBuyPrice,
  jcRedeemPrice,
  walletAddress,
  onClose,
  onDone,
}: {
  usdtBalance: number;
  jcOnChainBalance: number;
  jcOnChainLoading: boolean;
  jcOnChainError: boolean;
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
  const [notice, setNotice] = useState<ExchangeNoticeState | null>(null);
  const [redemptionOrders, setRedemptionOrders] = useState<RedemptionOrder[]>([]);
  const { language } = useLanguage();
  const { sendToVault } = useSendUsdtToVault();
  const { settleVaultPurchase, settleRedemption, ensureJcSpendable } = useOnchainSettlement();
  const numericJc = Number(jcAmount);
  const buying = direction === "buy";
  const activePrice = buying ? jcBuyPrice : jcRedeemPrice;
  const usdtValue = Number.isFinite(numericJc) ? numericJc * activePrice : 0;
  const valid =
    jcAmount.trim() !== "" &&
    Number.isFinite(numericJc) &&
    numericJc > 0 &&
    (buying
      ? usdtValue <= usdtBalance
      : !jcOnChainLoading && !jcOnChainError && numericJc <= jcOnChainBalance);

  const loadOrders = useCallback(async () => {
    const { data } = await supabase
      .from("redemption_orders")
      .select("id,jc_amount,usdt_amount,status,tx_hash,created_at")
      .order("created_at", { ascending: false })
      .limit(5);
    setRedemptionOrders((data ?? []) as RedemptionOrder[]);
  }, []);
  useEffect(() => {
    void loadOrders();
    // 每次打開金庫都補跑一次：續跑因 session／網路暫時問題而卡住的預留；在鏈上
    // 結算與正式帳本同步確認前，JC 與庫存都只是保留額度，不會顯示交易完成。
    void reconcilePendingSettlements().then((result) => {
      if (result.fixed > 0) void onDone();
    });
  }, [loadOrders, onDone]);

  useEffect(() => {
    if (!redemptionOrders.some((order) => order.status === "pending")) return;
    const interval = window.setInterval(() => {
      void loadOrders();
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [loadOrders, redemptionOrders]);

  const submitBuy = async () => {
    const freshBalance = await fetchOnChainUsdtBalance(walletAddress);
    if (usdtValue > freshBalance) {
      setNotice({
        tone: "error",
        title: localizedUiText(language, "잔액 부족", "餘額不足"),
        text: localizedUiText(
          language,
          `${STABLECOIN_SYMBOL} 잔액이 부족합니다. Base 체인 ${STABLECOIN_SYMBOL}를 지갑에 입금한 후 다시 시도하세요.`,
          `錢包內的 ${STABLECOIN_SYMBOL} 不足以支付本次購買，請先轉入 Base 鏈 ${STABLECOIN_SYMBOL} 後再試。`,
        ),
      });
      return;
    }

    const requestKey = crypto.randomUUID();
    const { data: reservationData, error: reservationError } = await supabase.rpc("reserve_vault_jc_purchase", {
      jc_amount: numericJc,
      request_key: requestKey,
    });
    const reservedUsdt = Number((reservationData as { usdt?: number } | null)?.usdt);
    if (reservationError || !(reservedUsdt > 0)) {
      setNotice({
        tone: "error",
        title: localizedUiText(language, "주문을 만들 수 없습니다", "暫時無法下單"),
        text: reservationError?.message ?? localizedUiText(
          language,
          `구매 예약을 만들지 못했습니다. ${STABLECOIN_SYMBOL}는 차감되지 않았습니다.`,
          `無法建立購買預留，${STABLECOIN_SYMBOL} 尚未扣款，請稍後再試。`,
        ),
      });
      return;
    }

    setStep("transferring");
    let txHash: `0x${string}` | null = null;
    try {
      txHash = await sendToVault(reservedUsdt);
    } catch (error) {
      const submittedHash = transactionHashFromError(error);
      if (submittedHash && !wasTransactionReverted(error)) {
        txHash = submittedHash as `0x${string}`;
      } else if (wasTransactionReverted(error) || isRejectedWalletRequest(error)) {
        const { error: releaseError } = await supabase.rpc("release_unsubmitted_vault_jc_purchase", { request_key: requestKey });
        setNotice(
          releaseError
            ? {
                tone: "pending",
                title: localizedUiText(language, "전송 미완료", "轉帳未完成"),
                text: `${STABLECOIN_SYMBOL} 轉帳未完成，額度暫時無法釋放，系統會自動處理，請勿重複購買。（${releaseError.message}）`,
              }
            : {
                tone: "error",
                title: localizedUiText(language, "구매가 취소되었습니다", "本次購買已取消"),
                text: isRejectedWalletRequest(error)
                  ? localizedUiText(language, "서명을 취소했습니다. 자금은 차감되지 않았습니다.", "您已取消簽署，資金未扣款。")
                  : localizedUiText(
                      language,
                      `${STABLECOIN_SYMBOL} 전송이 실패하여 자금이 이동하지 않았습니다.`,
                      `${STABLECOIN_SYMBOL} 轉帳失敗，資金未轉出，不會扣款。`,
                    ),
              },
        );
        setStep("idle");
        return;
      } else {
        setNotice({
          tone: "pending",
          title: localizedUiText(language, "온체인 확인 대기", "等待鏈上確認"),
          text: walletExchangeMessage(language, "purchaseUnconfirmed", {
            error: error instanceof Error ? `（${error.message}）` : "",
          }),
        });
        setStep("idle");
        return;
      }
    }

    if (!txHash) throw new Error(`${STABLECOIN_SYMBOL} 交易未回傳雜湊，預留仍保留`);
    const { error: attachError } = await supabase.rpc("vault_buy_jc_onchain", {
      jc_amount: numericJc,
      tx_hash: txHash,
      request_key: requestKey,
    });
    if (attachError) {
      setNotice({
        tone: "pending",
        title: localizedUiText(language, "거래 동기화 중", "交易同步中"),
        text: `${STABLECOIN_SYMBOL} 已轉出，正在同步這筆交易。額度已為您保留，請勿重複購買；如長時間未完成請聯繫客服。（${attachError.message}）`,
        txHash,
      });
      setJcAmount("");
      setStep("idle");
      await onDone();
      return;
    }

    setStep("recording");
    let completed = false;
    let deliveryTx: string = txHash;
    let failureDetail = "";
    try {
      const result = await settleVaultPurchase(requestKey, txHash);
      completed = result.status === "confirmed";
      if (completed && typeof result.tx_hash === "string") deliveryTx = result.tx_hash;
    } catch (error) {
      failureDetail = error instanceof Error ? `（${error.message}）` : "";
    }
    setStep("idle");
    setNotice(
      completed
        ? {
            tone: "success",
            title: localizedUiText(language, "구매 완료", "購買成功"),
            text: walletExchangeMessage(language, "purchaseSuccess", {
              usdt: formatUSDT(reservedUsdt),
              jc: formatJC(numericJc),
              tx: "",
            }),
            txHash: deliveryTx,
          }
        : {
            tone: "pending",
            title: localizedUiText(language, "JC 지급 중", "JC 發放中"),
            text: walletExchangeMessage(language, "purchasePending", { tx: failureDetail }),
            txHash,
          },
    );
    setJcAmount("");
    await onDone();
  };

  const submitRedeem = async () => {
    setStep("transferring");
    try {
      await ensureJcSpendable(numericJc);
      await syncJcBalanceFromChain();
    } catch (approvalError) {
      setStep("idle");
      setNotice({
        tone: "error",
        title: localizedUiText(language, "회수할 수 없습니다", "暫時無法回收"),
        text: approvalError instanceof Error
          ? approvalError.message
          : localizedUiText(language, "JC 온체인 확인이 완료되지 않았습니다.", "JC 鏈上核對未完成，本次回收未送出。"),
      });
      return;
    }
    const requestKey = crypto.randomUUID();
    const { data, error } = await supabase.rpc("request_jc_redemption", {
      jc_amount: numericJc,
      request_key: requestKey,
    });
    if (error) {
      const map: Record<string, string> = {
        "insufficient jc": localizedUiText(language, "JC 잔액이 부족합니다.", "JC 餘額不足，請調整回收數量。"),
        "jc redemption price unavailable": localizedUiText(language, "회수 단가를 일시적으로 불러올 수 없습니다.", "回收單價暫時無法取得，請稍後再試。"),
        "no wallet bound": localizedUiText(language, "연결된 지갑이 없습니다.", "尚未綁定錢包地址，請重新登入後再試。"),
      };
      setStep("idle");
      setNotice({
        tone: "error",
        title: localizedUiText(language, "회수할 수 없습니다", "暫時無法回收"),
        text: map[error.message] ?? localizedUiText(language, "요청에 실패했습니다. 잠시 후 다시 시도하세요.", "申請失敗，請稍後再試。"),
      });
      return;
    }
    const orderId = typeof (data as { order_id?: string } | null)?.order_id === "string" ? (data as { order_id: string }).order_id : null;
    setStep("recording");
    let completed = false;
    let payoutTx: string | null = null;
    let failureDetail = "";
    if (orderId) {
      try {
        const result = await settleRedemption(orderId);
        payoutTx = typeof result.tx_hash === "string" ? result.tx_hash : null;
        completed = result.status === "confirmed";
      } catch (settleError) {
        failureDetail = settleError instanceof Error ? `（${settleError.message}）` : "";
      }
    }
    setStep("idle");
    setNotice(
      completed
        ? {
            tone: "success",
            title: localizedUiText(language, "회수 완료", "回收成功"),
            text: walletExchangeMessage(language, "redemptionSuccess", {
              jc: formatJC(numericJc),
              usdt: formatUSDT(usdtValue),
              tx: "",
            }),
            txHash: payoutTx,
          }
        : {
            tone: "pending",
            title: localizedUiText(language, "지급 처리 중", "撥款處理中"),
            text: walletExchangeMessage(language, "redemptionPending", { tx: failureDetail }),
            txHash: payoutTx,
          },
    );
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
{localizedUiText(language, "JC 금고 교환", "兌換JC")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={localizedUiText(language, "닫기", "關閉")}
            className="rounded-full p-1 text-slate-400 hover:text-slate-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-2 rounded-2xl border border-slate-700 bg-slate-950/60 p-1" role="tablist">
          {(["buy", "redeem"] as const).map((option) => {
            const active = direction === option;
            return (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={active}
                disabled={busy}
                onClick={() => {
                  setDirection(option);
                  setNotice(null);
                }}
                className={`flex flex-col items-center rounded-xl px-3 py-2 transition disabled:cursor-not-allowed ${
                  active ? "bg-sky-500 text-slate-950" : "text-slate-300 hover:text-slate-100"
                }`}
              >
                <span className="text-sm font-bold">
                  {option === "buy"
                    ? localizedUiText(language, "JC 구매", "購買 JC")
                    : localizedUiText(language, "JC 회수", "回收 JC")}
                </span>
                <span className={`text-[11px] font-medium ${active ? "text-slate-900/70" : "text-slate-500"}`}>
                  {option === "buy" ? `${STABLECOIN_SYMBOL} → JC` : `JC → ${STABLECOIN_SYMBOL}`}
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-4 rounded-2xl border border-slate-700 bg-slate-950/60 p-4 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-400">{localizedUiText(language, buying ? "구매 단가" : "회수 단가", buying ? "購買單價" : "回收單價")}</span>
            <span className="text-right font-bold text-slate-100">1 JC = {formatUSDT(activePrice)}</span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            {buying
              ? localizedUiText(
                  language,
                  `Base 체인 ${STABLECOIN_SYMBOL}로 결제하면 JC가 바로 지갑에 입금됩니다.`,
                  `以 Base 鏈 ${STABLECOIN_SYMBOL} 支付，JC 會直接存入您的錢包。`,
                )
              : localizedUiText(
                  language,
                  `JC를 회수하면 ${STABLECOIN_SYMBOL}가 자동으로 지갑에 지급됩니다.`,
                  `回收 JC 後，${STABLECOIN_SYMBOL} 會自動撥入您的錢包。`,
                )}
          </p>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <p className="text-slate-500">{localizedUiText(language, "사용 가능 USDT", "可用 USDT")}</p>
            <p className="mt-1 font-semibold text-slate-100">{formatUSDT(usdtBalance)}</p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <p className="text-slate-500">{localizedUiText(language, "사용 가능 JC", "可用 JC")}</p>
            <p className="mt-1 font-semibold text-sky-300">
              {jcOnChainLoading
                ? localizedUiText(language, "잔액을 읽는 중…", "讀取中…")
                : jcOnChainError
                  ? localizedUiText(language, "잔액을 읽지 못했습니다", "讀取失敗")
                  : formatJC(jcOnChainBalance)}
            </p>
          </div>
        </div>
        <label className="mt-5 block text-sm font-semibold text-slate-300">
          {localizedUiText(language, "JC 수량", "JC 數量")}
          <div className="mt-2 flex items-center gap-2">
            <input
              inputMode="decimal"
              value={jcAmount}
              onChange={(event) => {
                setJcAmount(event.target.value);
                if (notice && !busy) setNotice(null);
              }}
              disabled={busy}
              placeholder="0"
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none focus:border-sky-500"
            />
            <button
              type="button"
              onClick={() =>
                setJcAmount(String(buying ? Math.floor((usdtBalance / (jcBuyPrice || 1)) * 1e6) / 1e6 : jcOnChainBalance))
              }
              className="shrink-0 rounded-xl border border-slate-700 px-3 py-3 text-xs font-semibold text-slate-300 hover:border-sky-500"
            >
              {localizedUiText(language, "전체", "全部")}
            </button>
          </div>
        </label>
        <p className="mt-2 text-sm text-slate-400">
          {localizedUiText(language, buying ? "지불할 금액" : "예상 수령액", buying ? "需支付" : "預計可收到")}：
          <b className="text-slate-100">{formatUSDT(usdtValue)}</b>
        </p>
        {jcAmount.trim() !== "" && !valid && !busy && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-red-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {localizedUiText(language, buying ? "USDT 잔액 부족" : "JC 잔액 부족", buying ? "USDT 餘額不足" : "JC 餘額不足")}
          </p>
        )}
        {busy && step !== "idle" && (
          <ExchangeProgress
            active={step === "transferring" ? 0 : 1}
            steps={
              buying
                ? [
                    localizedUiText(language, `${STABLECOIN_SYMBOL} 결제`, `支付 ${STABLECOIN_SYMBOL}`),
                    localizedUiText(language, "JC 지급", "發放 JC"),
                  ]
                : [
                    localizedUiText(language, "JC 회수", "收回 JC"),
                    localizedUiText(language, `${STABLECOIN_SYMBOL} 지급`, `撥付 ${STABLECOIN_SYMBOL}`),
                  ]
            }
            hint={localizedUiText(language, "창을 닫지 말고 잠시 기다려 주세요.", "請稍候，處理完成前請勿關閉視窗。")}
          />
        )}
        {notice && !busy && (
          <ExchangeNotice notice={notice} linkLabel={localizedUiText(language, "BaseScan에서 거래 보기", "在 BaseScan 查看交易")} />
        )}
        {redemptionOrders.length > 0 && (
          <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/40 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-400">
              <Clock className="h-3.5 w-3.5" /> {localizedUiText(language, "나의 회수 기록", "我的回收紀錄")}
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
                      ? localizedUiText(language, "지급 완료", "已撥款")
                      : order.status === "rejected"
                        ? localizedUiText(language, "JC 반환 완료", "已退回 JC")
                        : localizedUiText(language, "지급 처리 중", "撥款處理中")}
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
            {localizedUiText(language, "닫기", "關閉")}
          </button>
          <button
            type="button"
            disabled={!valid || busy}
            onClick={submit}
            className="flex-1 rounded-xl bg-sky-500 px-4 py-3 font-bold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy
              ? localizedUiText(language, "처리 중…", "處理中…")
              : buying
                ? localizedUiText(language, "구매 확인", "確認購買")
                : localizedUiText(language, "회수 확인", "確認回收")}
          </button>
        </div>
      </div>
    </div>
  );
}

type ExchangeNoticeState = {
  tone: "success" | "pending" | "error";
  title: string;
  text: string;
  txHash?: string | null;
};

const EXCHANGE_NOTICE_STYLES = {
  success: { Icon: CheckCircle2, box: "border-emerald-500/40 bg-emerald-500/10", icon: "text-emerald-400", title: "text-emerald-200" },
  pending: { Icon: Clock, box: "border-amber-500/40 bg-amber-500/10", icon: "text-amber-300", title: "text-amber-100" },
  error: { Icon: AlertTriangle, box: "border-red-500/40 bg-red-500/10", icon: "text-red-400", title: "text-red-200" },
} as const;

function ExchangeNotice({ notice, linkLabel }: { notice: ExchangeNoticeState; linkLabel: string }) {
  const style = EXCHANGE_NOTICE_STYLES[notice.tone];
  const { Icon } = style;
  return (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      className={`mt-4 flex gap-3 rounded-2xl border p-4 ${style.box}`}
    >
      <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${style.icon}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-bold ${style.title}`}>{notice.title}</p>
        <p className="mt-1 break-words text-sm leading-relaxed text-slate-300">{notice.text}</p>
        {notice.txHash && (
          <a
            href={explorerTxUrl(notice.txHash)}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-sky-300 hover:text-sky-200"
          >
            {linkLabel}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        )}
      </div>
    </div>
  );
}

function ExchangeProgress({ steps, active, hint }: { steps: [string, string]; active: 0 | 1; hint: string }) {
  return (
    <div className="mt-4 rounded-2xl border border-sky-500/30 bg-sky-500/5 p-4" role="status" aria-live="polite">
      <ol className="flex items-center gap-2">
        {steps.map((label, index) => {
          const done = index < active;
          const current = index === active;
          return (
            <li key={label} className="flex flex-1 items-center gap-2">
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                  done ? "bg-emerald-500 text-slate-950" : current ? "bg-sky-500 text-slate-950" : "bg-slate-800 text-slate-500"
                }`}
              >
                {done ? (
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                ) : current ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  index + 1
                )}
              </span>
              <span className={`text-xs ${current ? "font-semibold text-slate-100" : done ? "text-emerald-300" : "text-slate-500"}`}>
                {label}
              </span>
              {index === 0 && <span className="h-px flex-1 bg-slate-700" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-xs text-slate-400">{hint}</p>
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
              您的 {STABLECOIN_SYMBOL} 已在 BASE 鏈上直接轉出至指定地址，通常數秒內即可到帳。
            </p>
            {txHash && (
              <a
                href={explorerTxUrl(txHash)}
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
                <span className="text-slate-400">{STABLECOIN_SYMBOL} 可用餘額</span>
                <span className="font-bold text-slate-100">{formatUSDT(available)}</span>
              </div>
            </div>

            <label className="mt-5 block text-sm font-semibold text-slate-300">
              提領地址（BASE 鏈 {STABLECOIN_SYMBOL}）
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
                請選擇 BASE 鏈上接收 {STABLECOIN_SYMBOL} 的錢包！此操作由您自行執行，如選錯錢包，平台概不負責！
              </p>
            </div>

            <label className="mt-5 block text-sm font-semibold text-slate-300">
              提領金額（{STABLECOIN_SYMBOL}）
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
                  ? `提領金額超過 ${STABLECOIN_SYMBOL} 可用餘額`
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
