import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import {
  ArrowRight,
  Building2,
  MapPin,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { currentMarketPrice, formatApy, formatUSDT, interfaceText, useLanguage, usePlatform, type Asset } from "@/platform";
import { Modal, Notice } from "@/components/Modal";
import { AnnouncementFeed } from "@/components/AnnouncementFeed";
import { ClickableAssetImage } from "@/components/AssetImageGallery";
import { AssetDetails } from "@/components/AssetDetails";
import { FormattedNumberInput } from "@/components/FormattedNumberInput";
import { TradeDetailsDialog, type TradeDetails } from "@/components/TradeDetailsDialog";
import { supabase } from "@/lib/supabase";
import { AE_TOKEN_CANONICAL_ID } from "@/lib/aeToken";
import { useOnchainSettlement } from "@/lib/onchainSettlement";

export function HomePage({ user }: { user: User }) {
  const { t, tr, language, assets: localizedAssets } = useLanguage();
  const { jcBalance, trade, assets: platformAssets, featuredAssetId } = usePlatform();
  const { settleSubscription } = useOnchainSettlement();
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const localize = (asset: Asset) => {
    const localized = localizedAssets.find((item) => item.id === asset.id);
    const translation = asset.translations?.[language] ?? asset.translations?.["zh-TW"];
    return {
      ...(localized ?? asset),
      ...asset,
      name: translation?.name?.trim() || localized?.name || asset.name,
      location: translation?.location?.trim() || localized?.location || asset.location,
      information: translation?.information?.trim() || asset.information,
      address: asset.address,
    };
  };
  // AE 獎勵是獨立的 placement 列，只有在「開啟中」（啟用、未凍結、仍有可購額度）
  // 才視為進行中的獎勵活動；未開啟時不在首頁更多項目露出「AE 代幣獎勵」。
  const isEnabledBonus = (asset: Asset) =>
    asset.isActive !== false && asset.available > 0 && !asset.releaseFrozenAt;
  // AE 代幣雖有 market_started_at，但平台將其視為「認購標的」（在認購頁以固定單價
  // 購買），而非二級市場產品。因此「二級市場產品」= 有 market_started_at 且非 AE。
  // 判定與認購頁一致（該頁以 !marketStartedAt || isAeToken 視為認購標的）。
  const isSecondaryMarket = (asset: Asset) => Boolean(asset.marketStartedAt) && !asset.isAeToken;
  // 首頁精選與更多項目涵蓋全部上架標的：
  // - 二級市場產品（已設定 marketStartedAt）：與二級市場頁一致，只要未下架即顯示，
  //   即使停止募集（is_active=false）仍可交易，故不受 is_active 過濾；但未開啟的
  //   AE 獎勵回合不露出。
  // - 認購產品（無 marketStartedAt）：僅顯示啟用中的標的。
  const visibleAssets = platformAssets
    .filter((asset) =>
      asset.marketStartedAt
        ? asset.aeTokenKind !== "bonus" || isEnabledBonus(asset)
        : asset.isActive !== false,
    )
    .map(localize);
  // AE 日常與獎勵回合為不同 placement，但後端持倉/掛單已收斂到 canonical id，
  // 交易時視為同一標的，因此首頁也只顯示單一 AE 卡片（以 canonical 為準）。
  const aeAssets = visibleAssets.filter((asset) => asset.isAeToken);
  const canonicalAeToken =
    aeAssets.find((asset) => asset.id === AE_TOKEN_CANONICAL_ID) ?? aeAssets[0] ?? null;
  const allAssets = [
    ...visibleAssets.filter((asset) => !asset.isAeToken),
    ...(canonicalAeToken ? [canonicalAeToken] : []),
  ];
  // 仍在募集期、未售罄的私募標的，供精選區在未指定精選時作為 fallback。
  const openPrivateAssets = allAssets.filter(
    (asset) =>
      !asset.marketStartedAt &&
      asset.available > 0 &&
      now <= new Date(asset.endsAt).getTime(),
  );
  const [nickname, setNickname] = useState(user.email?.split("@")[0] || "會員");
  const [selected, setSelected] = useState<Asset | null>(null);
  const [buying, setBuying] = useState<Asset | null>(null);
  const [qty, setQty] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [confirming, setConfirming] = useState<TradeDetails | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 各標的累計成交量（JC）：私募認購 + 二級買入，供「更多項目」依熱度排序。
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  useEffect(() => {
    setSelected((current) => current ? allAssets.find((asset) => asset.id === current.id) ?? null : null);
    setBuying((current) => current ? allAssets.find((asset) => asset.id === current.id) ?? null : null);
  }, [platformAssets]);
  useEffect(() => {
    let active = true;
    void supabase.rpc("get_asset_volumes").then(({ data }) => {
      if (!active || !Array.isArray(data)) return;
      const map: Record<string, number> = {};
      for (const row of data as { asset_id: string; volume_jc: number }[]) {
        map[row.asset_id] = Number(row.volume_jc) || 0;
      }
      setVolumes(map);
    });
    return () => {
      active = false;
    };
  }, [platformAssets]);
  useEffect(() => {
    let active = true;
    void supabase
      .from("profiles")
      .select("nickname")
      .eq("id", user.id)
      .single()
      .then(({ data }) => {
        if (active && data?.nickname?.trim()) setNickname(data.nickname.trim());
      });
    return () => {
      active = false;
    };
  }, [user.id]);
  const featured =
    allAssets.find((asset) => asset.id === featuredAssetId) ??
    openPrivateAssets[0] ??
    allAssets[0];
  // 更多項目：新建標的（7 天內）優先排在最前（越新越前），其餘依累計成交量
  // 由高到低（左至右）排序，可水平滑動，最多顯示 6 個。
  const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  const createdMs = (asset: Asset) => (asset.createdAt ? new Date(asset.createdAt).getTime() : 0);
  const isNewAsset = (asset: Asset) => now > 0 && createdMs(asset) > 0 && now - createdMs(asset) < NEW_WINDOW_MS;
  const otherAssets = allAssets
    .filter((asset) => asset.id !== featured?.id)
    .slice()
    .sort((a, b) => {
      const aNew = isNewAsset(a);
      const bNew = isNewAsset(b);
      if (aNew !== bNew) return aNew ? -1 : 1;
      if (aNew && bNew) return createdMs(b) - createdMs(a);
      return (volumes[b.id] ?? 0) - (volumes[a.id] ?? 0);
    })
    .slice(0, 6);
  const ended = (asset: Asset) => now > new Date(asset.endsAt).getTime();
  // 全站一律以 JC 計價顯示。fmt 保留兩位小數格式，單位為 JC。
  const currency = "JC";
  const fmt = (n: number) =>
    `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  // 第一階段：整理交易明細供用戶確認（標的物名稱、份額、手續費、合計金額、Gas）。
  const review = () => {
    if (!buying || (!isSecondaryMarket(buying) && ended(buying))) return;
    if (isSecondaryMarket(buying)) {
      const assetId = buying.id;
      setBuying(null);
      window.dispatchEvent(
        new CustomEvent("navigate-to-market", { detail: { assetId } }),
      );
      return;
    }
    const units = Number(qty);
    if (!Number.isSafeInteger(units) || units <= 0) {
      setMsg({ text: "請輸入有效的整數份額", ok: false });
      return;
    }
    const gross = units * buying.price;
    setConfirming({
      assetName: buying.name,
      quantity: units,
      fee: `0 JC（私募認購免手續費）`,
      total: fmt(gross),
      note: `標的物本金 ${fmt(gross)}。認購當下即扣 JC、入份額、發分潤，鏈上 Gas 由平台��付。`,
    });
  };

  // 第二階段：明細確認後才實際送出私募認購。
  const execute = async () => {
    if (!buying || submitting) return;
    setSubmitting(true);
    try {
      const r = await trade(buying.id, "private_buy", Number(qty));
      let message = r.message;
      if (r.ok && r.onchain && r.requestKey) {
        // 站內認購已成功；再做真實鏈上結算（approve JC → relayer executeSubscription）。
        // 失敗不回退站內結果，只附註鏈上狀態。
        try {
          const res = await settleSubscription(r.requestKey, r.onchain.isAe, buying.tokenAddress);
          const txHash = typeof res.tx_hash === "string" ? res.tx_hash : null;
          message += txHash ? `（鏈上結算成功，Tx: ${txHash.slice(0, 10)}…）` : "（鏈上結算已在處理中）";
        } catch (onChainError) {
          message += `（鏈上結算未完成：${onChainError instanceof Error ? onChainError.message : "請稍後於鏈上重試"}）`;
        }
      }
      setMsg({ text: message, ok: r.ok });
      if (r.ok) setQty("");
      setConfirming(null);
    } finally {
      setSubmitting(false);
    }
  };
  if (!featured)
    return <p className="text-sm text-slate-400">目前沒有上架的標的</p>;
  return (
    <div className="flex flex-col gap-8">
      <p className="hidden text-2xl font-bold tracking-tight text-white lg:block">
        {interfaceText(language, "welcome", { name: nickname })}
      </p>
      <AnnouncementFeed fallback={tr("announcement")} />
      <header>
        <p className="hidden text-xs font-bold uppercase tracking-[.22em] text-amber-400 lg:block">
          RWMT
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-white">
          {t("featured")}
        </h1>
        <p className="mt-2 text-sm text-slate-400">{t("subtitle")}</p>
      </header>
      <article className="overflow-hidden rounded-3xl border border-slate-700 bg-slate-900">
        <div className="relative h-72 overflow-hidden sm:h-80">
          <ClickableAssetImage images={featured.images?.length ? featured.images : [featured.image]} assetName={featured.name} className="h-72 w-full object-cover sm:h-80" />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/20 to-transparent" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 p-6">
            <span className="rounded-full bg-amber-400 px-3 py-1 text-xs font-bold text-slate-950">
              {t("featured")}
            </span>
            <h2 className="mt-3 text-2xl font-bold text-white sm:text-3xl">
              {featured.name}
            </h2>
            <p className="mt-1 flex items-center gap-1 text-sm text-slate-300">
              <MapPin className="h-4 w-4" />
              {featured.location}
            </p>
          </div>
        </div>
        <div className="p-6">
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric
              icon={<Building2 />}
              label={tr("valuation")}
              value={formatUSDT(featured.valuation)}
            />
            <Metric
              icon={<TrendingUp />}
              label={tr("expectedApy")}
              value={formatApy(featured.apy)}
            />
            <Metric
              icon={<ShieldCheck />}
              label={tr("verification")}
              value="Chainlink PoR"
            />
          </div>
          {isSecondaryMarket(featured) ? (
            <div className="mt-6 flex items-center justify-between rounded-2xl border border-slate-800 p-4 text-sm">
              <span className="text-slate-400">二級市場即時漲跌</span>
              <strong className={featured.change >= 0 ? "text-emerald-400" : "text-rose-400"}>
                {featured.change >= 0 ? "↑" : "↓"} {Math.abs(featured.change).toFixed(2)}%
              </strong>
            </div>
          ) : featured.isAeToken ? null : (
            <SupplyProgress asset={featured} />
          )}
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
            <button
              onClick={() => setSelected(featured)}
              className="rounded-xl border border-slate-700 px-5 py-3 text-sm font-semibold hover:bg-slate-800"
            >
              {t("details")}
            </button>
            <button
              disabled={!isSecondaryMarket(featured) && ended(featured)}
              onClick={() => {
                setBuying(featured);
                setQty("");
                setMsg(null);
              }}
              className="flex items-center justify-center gap-2 rounded-xl bg-amber-400 px-5 py-3 text-sm font-bold text-slate-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {isSecondaryMarket(featured)
                ? "進入二級市場買入"
                : ended(featured)
                  ? "已結束"
                  : "購買份額"}{" "}
              {(isSecondaryMarket(featured) || !ended(featured)) && (
                <ArrowRight className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </article>
      <section>
        <h2 className="mb-4 text-xl font-bold">{tr("more")}</h2>
        <div className="-mx-4 flex snap-x snap-mandatory gap-5 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
          {otherAssets.map((a) => {
            const isSecondary = isSecondaryMarket(a);
            const price = isSecondary ? currentMarketPrice(a) : a.price;
            return (
              <article
                key={a.id}
                className="w-64 shrink-0 snap-start overflow-hidden rounded-2xl border border-slate-800 bg-slate-900"
              >
                <div className="relative">
                  <ClickableAssetImage images={a.images?.length ? a.images : [a.image]} assetName={a.name} className="h-40 w-full object-cover" />
                  <span
                    className={`absolute left-3 top-3 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                      isSecondary
                        ? "bg-sky-400 text-slate-950"
                        : "bg-amber-400 text-slate-950"
                    }`}
                  >
                    {isSecondary ? "二級市場" : "認購中"}
                  </span>
                </div>
                <div className="p-4">
                  <h3 className="font-bold">{a.name}</h3>
                  <p className="mt-1 text-xs text-slate-400">{a.location}</p>
                  <div className="mt-4 flex justify-between text-sm">
                    <span>
                      {fmt(price)} / {t("units")}
                    </span>
                    <span className="font-semibold text-emerald-400">
                      APY {formatApy(a.apy)}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-slate-400">
                    成交量 {fmt(volumes[a.id] ?? 0)}
                  </p>
                  {!isSecondary && !a.isAeToken && <SupplyProgress asset={a} compact />}
                  <button
                    onClick={() => setSelected(a)}
                    className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-slate-800 py-2.5 text-sm font-semibold hover:bg-amber-400 hover:text-slate-950"
                  >
                    {t("details")}
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={t("assetDetails")}
        wide
      >
        {selected && (
          <AssetDetails
            asset={selected}
            action={
              <button
                onClick={() => {
                  setBuying(selected);
                  setSelected(null);
                  setQty("");
                  setMsg(null);
                }}
                className="w-full rounded-xl bg-amber-400 py-3 font-bold text-slate-950"
              >
                {isSecondaryMarket(selected) ? "進入二級市場買入" : "購買份額"}
              </button>
            }
          />
        )}
      </Modal>
      <Modal
        open={!!buying}
        onClose={() => setBuying(null)}
        title={`${t("buy")} · ${buying?.name ?? ""}`}
      >
        {buying && (
          <div className="flex flex-col gap-4">
            <div className="rounded-xl bg-slate-800 p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-400">{t("balance")}</span>
                <strong>{fmt(jcBalance)}</strong>
              </div>
              <div className="mt-2 flex justify-between">
                <span className="text-slate-400">{t("unitPrice")}</span>
                <strong>{fmt(buying.price)}</strong>
              </div>
            </div>
            <label className="text-sm font-medium">
              {t("units")}
              <FormattedNumberInput
                value={qty}
                onValueChange={setQty}
                inputMode="numeric"
                maxDecimals={0}
                min="1"
                className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3"
              />
            </label>
            <div className="flex justify-between text-sm">
              <span>{t("gross")}</span>
              <strong>{fmt((Number(qty) || 0) * buying.price)}</strong>
            </div>
            <p className="text-xs text-slate-500">
              {isSecondaryMarket(buying)
                ? "二級市場交易將依目前單價執行"
                : buying.isAeToken
                  ? "AE 代幣依固定單價認購，可購額度依釋放進度"
                  : `私募結束時間：${new Date(buying.endsAt).toLocaleString()}`} ·{" "}
              {isSecondaryMarket(buying)
                ? `買入平台手續費：0 ${currency}`
                : `認購以 JC 扣款，免手續費`}
            </p>
            {msg && (
              <Notice message={msg.text} tone={msg.ok ? "success" : "error"} />
            )}
            <button
              disabled={!isSecondaryMarket(buying) && ended(buying)}
              onClick={review}
              className="rounded-xl bg-amber-400 py-3 font-bold text-slate-950 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {!isSecondaryMarket(buying) && ended(buying) ? "已結束" : t("confirm")}
            </button>
          </div>
        )}
      </Modal>
      <TradeDetailsDialog
        open={!!confirming}
        onClose={() => setConfirming(null)}
        title="交易明細"
        details={confirming}
        confirmLabel="確認購買"
        submitting={submitting}
        onConfirm={() => void execute()}
      />
    </div>
  );
}
function SupplyProgress({ asset, compact = false }: { asset: Asset; compact?: boolean }) {
  const progress = asset.total > 0 ? Math.min(100, Math.max(0, ((asset.total - asset.available) / asset.total) * 100)) : 0;
  return (
    <div className={compact ? "mt-4" : "mt-6 rounded-2xl border border-slate-800 p-4"}>
      <div className="flex flex-wrap justify-between gap-2 text-xs text-slate-400">
        {!asset.isAeToken && (
          <>
            <span>總發行量 {asset.total.toLocaleString()}</span>
            <span>剩餘發行量 {asset.available.toLocaleString()}</span>
          </>
        )}
        <b className="text-amber-300">私募進度 {progress.toFixed(1)}%</b>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800" role="progressbar" aria-label="私募進度" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-amber-400" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}
function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl bg-slate-800/60 p-4">
      <span className="text-amber-300">{icon}</span>
      <p className="mt-3 text-xs text-slate-400">{label}</p>
      <p className="mt-1 font-bold">{value}</p>
    </div>
  );
}
