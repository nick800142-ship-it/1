import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import {
  ArrowRight,
  Building2,
  MapPin,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { formatApy, formatUSDT, interfaceText, useLanguage, usePlatform, type Asset } from "@/platform";
import { Modal, Notice } from "@/components/Modal";
import { AnnouncementFeed } from "@/components/AnnouncementFeed";
import { ClickableAssetImage } from "@/components/AssetImageGallery";
import { AssetDetails } from "@/components/AssetDetails";
import { FormattedNumberInput } from "@/components/FormattedNumberInput";
import { supabase } from "@/lib/supabase";

export function HomePage({ user }: { user: User }) {
  const { t, tr, language, assets: localizedAssets } = useLanguage();
  const { balance, trade, assets: platformAssets, featuredAssetId } = usePlatform();
  const assets = platformAssets
    .filter(
      (asset) =>
        !asset.marketStartedAt &&
        asset.isActive !== false &&
        asset.available > 0 &&
        Date.now() <= new Date(asset.endsAt).getTime(),
    )
    .map((asset) => {
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
    });
  const [nickname, setNickname] = useState(user.email?.split("@")[0] || "會員");
  const [selected, setSelected] = useState<Asset | null>(null);
  const [buying, setBuying] = useState<Asset | null>(null);
  const [qty, setQty] = useState("1000");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  useEffect(() => {
    setSelected((current) => current ? assets.find((asset) => asset.id === current.id) ?? null : null);
    setBuying((current) => current ? assets.find((asset) => asset.id === current.id) ?? null : null);
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
    assets.find((asset) => asset.id === featuredAssetId) ??
    assets.find(
      (asset) =>
        !asset.marketStartedAt &&
        Date.now() <= new Date(asset.endsAt).getTime(),
    ) ??
    assets[0];
  const otherAssets = assets.filter((asset) => asset.id !== featured?.id);
  const ended = (asset: Asset) => Date.now() > new Date(asset.endsAt).getTime();
  const execute = async () => {
    if (!buying || (!buying.marketStartedAt && ended(buying))) return;
    const r = await trade(
      buying.id,
      buying.marketStartedAt ? "buy" : "private_buy",
      Number(qty),
    );
    setMsg({ text: r.message, ok: r.ok });
    if (r.ok) setQty("1000");
  };
  if (!featured)
    return <p className="text-sm text-slate-400">目前沒有進行中的私募標的</p>;
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
          {featured.marketStartedAt ? (
            <div className="mt-6 flex items-center justify-between rounded-2xl border border-slate-800 p-4 text-sm">
              <span className="text-slate-400">二級市場即時漲跌</span>
              <strong className={featured.change >= 0 ? "text-emerald-400" : "text-rose-400"}>
                {featured.change >= 0 ? "↑" : "↓"} {Math.abs(featured.change).toFixed(2)}%
              </strong>
            </div>
          ) : (
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
              disabled={!featured.marketStartedAt && ended(featured)}
              onClick={() => {
                setBuying(featured);
                setMsg(null);
              }}
              className="flex items-center justify-center gap-2 rounded-xl bg-amber-400 px-5 py-3 text-sm font-bold text-slate-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {featured.marketStartedAt
                ? "進入二級市場買入"
                : ended(featured)
                  ? "已結束"
                  : "購買份額"}{" "}
              {(featured.marketStartedAt || !ended(featured)) && (
                <ArrowRight className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </article>
      <section>
        <h2 className="mb-4 text-xl font-bold">{tr("more")}</h2>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {otherAssets.map((a) => (
            <article
              key={a.id}
              className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900"
            >
              <ClickableAssetImage images={a.images?.length ? a.images : [a.image]} assetName={a.name} className="h-40 w-full object-cover" />
              <div className="p-4">
                <h3 className="font-bold">{a.name}</h3>
                <p className="mt-1 text-xs text-slate-400">{a.location}</p>
                <div className="mt-4 flex justify-between text-sm">
                  <span>
                    {formatUSDT(a.price)} / {t("units")}
                  </span>
                  <span className="font-semibold text-emerald-400">
                    APY {formatApy(a.apy)}
                  </span>
                </div>
                {!a.marketStartedAt && <SupplyProgress asset={a} compact />}
                <button
                  onClick={() => setSelected(a)}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-slate-800 py-2.5 text-sm font-semibold hover:bg-amber-400 hover:text-slate-950"
                >
                  {t("details")}
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </article>
          ))}
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
                  setMsg(null);
                }}
                className="w-full rounded-xl bg-amber-400 py-3 font-bold text-slate-950"
              >
                {t("buy")} USDT
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
                <strong>{formatUSDT(balance)}</strong>
              </div>
              <div className="mt-2 flex justify-between">
                <span className="text-slate-400">{t("unitPrice")}</span>
                <strong>{formatUSDT(buying.price)}</strong>
              </div>
            </div>
            <label className="text-sm font-medium">
              {t("units")}
              <FormattedNumberInput
                value={qty}
                onValueChange={setQty}
                inputMode="numeric"
                min="1"
                className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3"
              />
            </label>
            <div className="flex justify-between text-sm">
              <span>{t("gross")}</span>
              <strong>{formatUSDT((Number(qty) || 0) * buying.price)}</strong>
            </div>
            <p className="text-xs text-slate-500">
              {buying.marketStartedAt
                ? "二級市場交易將依目前單價執行"
                : `私募結束時間：${new Date(buying.endsAt).toLocaleString()}`} ·{" "}
              {tr("buyFee")}
            </p>
            {msg && (
              <Notice message={msg.text} tone={msg.ok ? "success" : "error"} />
            )}
            <button
              disabled={!buying.marketStartedAt && ended(buying)}
              onClick={() => void execute()}
              className="rounded-xl bg-amber-400 py-3 font-bold text-slate-950 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {!buying.marketStartedAt && ended(buying) ? "已結束" : t("confirm")}
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
}
function SupplyProgress({ asset, compact = false }: { asset: Asset; compact?: boolean }) {
  const progress = asset.total > 0 ? Math.min(100, Math.max(0, ((asset.total - asset.available) / asset.total) * 100)) : 0;
  return (
    <div className={compact ? "mt-4" : "mt-6 rounded-2xl border border-slate-800 p-4"}>
      <div className="flex flex-wrap justify-between gap-2 text-xs text-slate-400">
        <span>總發行量 {asset.total.toLocaleString()}</span>
        <span>剩餘發行量 {asset.available.toLocaleString()}</span>
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
