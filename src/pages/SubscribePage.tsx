import { useEffect, useState } from "react";
import { Clock3, MapPin } from "lucide-react";
import { formatApy, formatUSDT, interfaceText, useLanguage, usePlatform, type Asset } from "@/platform";
import { Modal, Notice } from "@/components/Modal";
import { SearchSuggest } from "@/components/SearchSuggest";
import { ClickableAssetImage } from "@/components/AssetImageGallery";
import { AssetDetails } from "@/components/AssetDetails";

function PlacementProgress({ asset }: { asset: Asset }) {
  const progress = asset.total > 0 ? Math.min(100, Math.max(0, ((asset.total - asset.available) / asset.total) * 100)) : 0;
  return (
    <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
      <div className="grid grid-cols-2 gap-2 text-xs">
        <span className="text-slate-500">總發行量 <b className="block text-slate-200">{asset.total.toLocaleString()}</b></span>
        <span className="text-right text-slate-500">剩餘發行量 <b className="block text-slate-200">{asset.available.toLocaleString()}</b></span>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs"><span className="text-slate-500">私募進度</span><b className="text-amber-300">{progress.toFixed(1)}%</b></div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800" role="progressbar" aria-label="私募進度" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><div className="h-full rounded-full bg-amber-400" style={{ width: `${progress}%` }} /></div>
    </div>
  );
}

export function SubscribePage() {
  const { tr, language, assets: localizedAssets } = useLanguage();
  const { assets: platformAssets, balance, trade } = usePlatform();
  const assets = platformAssets.map((asset) => {
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
  const [selected, setSelected] = useState<Asset | null>(null);
  const [search, setSearch] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(
    null,
  );
  const placements = assets.filter((asset) => !asset.marketStartedAt);
  const active = (asset: Asset) =>
    !asset.marketStartedAt &&
    asset.isActive !== false &&
    Date.now() < new Date(asset.endsAt).getTime() &&
    asset.available > 0;
  useEffect(() => {
    setSelected((current) => {
      if (!current) return null;
      const next = assets.find((asset) => asset.id === current.id);
      return next ?? null;
    });
  }, [platformAssets]);

  const openPlacement = (asset: Asset) => {
    if (!active(asset)) return;
    setSelected(asset);
    setQuantity(String(Math.min(100, Math.max(1, Math.floor(asset.available)))));
    setNotice(null);
  };

  // The trade RPC authorizes by authenticated user, not agency role. Admins,
  // master agents, agents, and users therefore share this exact purchase flow.
  const submit = async () => {
    if (!selected || submitting) return;
    const latestAsset = platformAssets.find((asset) => asset.id === selected.id);
    const units = Number(quantity);
    if (!latestAsset || !active(latestAsset)) {
      setNotice({ text: "此認購項目已完售或目前不可認購", ok: false });
      return;
    }
    if (!Number.isSafeInteger(units) || units <= 0 || units > 1_000_000) {
      setNotice({ text: "請輸入 1 至 1,000,000 之間的整數份額", ok: false });
      return;
    }
    if (units > latestAsset.available) {
      setNotice({ text: `目前最多可認購 ${latestAsset.available.toLocaleString()} 份`, ok: false });
      return;
    }
    if (units * selected.price > balance) {
      setNotice({ text: "USDT 餘額不足", ok: false });
      return;
    }
    setSubmitting(true);
    try {
      const result = await trade(selected.id, "private_buy", units);
      setNotice({ text: result.message, ok: result.ok });
      if (result.ok && result.enteredSecondaryMarket) {
        const assetId = selected.id;
        setSelected(null);
        window.dispatchEvent(
          new CustomEvent("navigate-to-market", { detail: { assetId } }),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <header>
        <p className="text-xs font-bold uppercase tracking-[.22em] text-amber-400">
          {tr("subscribeEyebrow")}
        </p>
        <h1 className="mt-2 text-3xl font-bold">{tr("subscribeTitle")}</h1>
        <p className="mt-2 text-sm text-slate-400">
          {tr("subscribeDescription")}
        </p>
      </header>

      <SearchSuggest
        value={search}
        onChange={setSearch}
        placeholder={interfaceText(language, "searchSubscribe")}
        suggestions={placements.map((asset) => ({
          value: asset.name,
          label: asset.name,
          detail: asset.location,
        }))}
        onSelect={(value) => {
          const asset = placements.find((item) => item.name === value);
          if (asset) openPlacement(asset);
        }}
      />

      <div className="grid gap-5 sm:grid-cols-2">
        {placements.map((asset) => (
          <article
            key={asset.id}
            className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900"
          >
            <ClickableAssetImage images={asset.images?.length ? asset.images : [asset.image]} assetName={asset.name} className="h-44 w-full object-cover" />
            <div className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-bold">{asset.name}</h2>
                  <p className="mt-1 flex items-center gap-1 text-xs text-slate-400">
                    <MapPin className="size-3" />
                    {asset.location}
                  </p>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-bold ${active(asset) ? "bg-amber-400 text-slate-950" : "bg-slate-800 text-slate-400"}`}
                >
                  {active(asset)
                    ? tr("subscribing")
                    : asset.available <= 0
                      ? tr("soldOut")
                      : tr("ended")}
                </span>
              </div>
              <div className="mt-5 flex items-end justify-between">
                <div>
                  <p className="text-xs text-slate-500">
                    {tr("subscriptionUnitPrice")}
                  </p>
                  <p className="text-xl font-bold">{formatUSDT(asset.price)}</p>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-amber-300">APY {formatApy(asset.apy)}</p>
                  <p className="mt-1 flex items-center gap-1 text-xs text-slate-400">
                    <Clock3 className="size-3" />
                    {new Date(asset.endsAt).toLocaleDateString()}
                  </p>
                </div>
              </div>
              <PlacementProgress asset={asset} />
              <button
                disabled={!active(asset)}
                onClick={() => openPlacement(asset)}
                className="mt-5 w-full rounded-xl bg-amber-400 py-3 font-bold text-slate-950 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
              >
                {active(asset)
                  ? tr("subscribeNow")
                  : tr("unavailableSubscribe")}
              </button>
            </div>
          </article>
        ))}
      </div>

      {!placements.length && (
        <p className="rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center text-sm text-slate-400">
          {tr("noSubscriptions")}
        </p>
      )}

      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={`${tr("subscribeTitle")} · ${selected?.name ?? ""}`}
        wide
      >
        {selected && (
          <div className="flex flex-col gap-6">
            <AssetDetails asset={selected} />
            <section aria-label="認購資訊" className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-5">
              <h2 className="font-bold text-amber-300">認購資訊</h2>
              <PlacementProgress asset={selected} />
            <div className="rounded-xl bg-slate-800 p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-400">{tr("availableBalance")}</span>
                <b>{formatUSDT(balance)}</b>
              </div>
              <div className="mt-2 flex justify-between">
                <span className="text-slate-400">
                  {tr("subscriptionUnitPrice")}
                </span>
                <b>{formatUSDT(selected.price)}</b>
              </div>
            </div>
            <label className="text-sm">
              {tr("subscriptionUnits")}
              <input
                type="number"
                min="1"
                max={Math.max(0, Math.floor(selected.available))}
                step="1"
                inputMode="numeric"
                disabled={!active(selected)}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3"
              />
            </label>
            <div className="flex justify-between text-sm">
              <span>{tr("subscriptionTotal")}</span>
              <b>{formatUSDT((Number(quantity) || 0) * selected.price)}</b>
            </div>
            {notice && (
              <Notice
                message={notice.text}
                tone={notice.ok ? "success" : "error"}
              />
            )}
            <button
              disabled={submitting || !active(selected)}
              onClick={() => void submit()}
              className="rounded-xl bg-amber-400 py-3 font-bold text-slate-950 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {submitting ? "處理中…" : tr("confirmSubscription")}
            </button>
            </section>
          </div>
        )}
      </Modal>
    </div>
  );
}
