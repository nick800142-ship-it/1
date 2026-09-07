import { useEffect, useState } from "react";
import { Clock3, Flame, MapPin } from "lucide-react";
import { formatApy, formatEndsAt, formatUSDT, interfaceText, useLanguage, usePlatform, type Asset } from "@/platform";
import { Modal, Notice } from "@/components/Modal";
import { SearchSuggest } from "@/components/SearchSuggest";
import { ClickableAssetImage } from "@/components/AssetImageGallery";
import { AssetDetails } from "@/components/AssetDetails";
import { FormattedNumberInput } from "@/components/FormattedNumberInput";
import { TradeDetailsDialog, type TradeDetails } from "@/components/TradeDetailsDialog";
import { AE_TOKEN_CANONICAL_ID, computeAeTokenRelease, formatCountdown, useAeTokenRelease } from "@/lib/aeToken";

function AeTokenReleaseProgress({ asset }: { asset: Asset }) {
  const release = useAeTokenRelease(asset);
  if (!release) return null;
  const exactProgress = asset.total > 0
    ? Math.min(100, Math.max(0, (release.purchasedSoFar / asset.total) * 100))
    : 0;
  const progress = asset.available > 0 ? Math.min(99.9, exactProgress) : exactProgress;
  return (
    <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
      <div className="grid grid-cols-2 gap-2 text-xs">
        <span className="text-slate-500">總發行量 <b className="block text-slate-200">{asset.total.toLocaleString()}</b></span>
        <span className="text-right text-slate-500">剩餘發行量 <b className="block text-slate-200">{asset.available.toLocaleString()}</b></span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <span className="text-slate-500">本輪已釋出 <b className="block text-amber-300">{release.releasedSoFar.toLocaleString()}</b></span>
        <span className="text-right text-slate-500">目前可認購 <b className="block text-amber-300">{release.purchasableNow.toLocaleString()}</b></span>
      </div>
      {release.secondsToNextRelease !== null && (
        <p className="mt-2 text-xs text-slate-500">
          下次釋出倒數 <b className="text-slate-200">{formatCountdown(release.secondsToNextRelease)}</b>
        </p>
      )}
      <div className="mt-3 flex items-center justify-between text-xs"><span className="text-slate-500">認購進度</span><b className="text-amber-300">{progress.toFixed(1)}%</b></div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800" role="progressbar" aria-label="認購進度" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><div className="h-full rounded-full bg-amber-400" style={{ width: `${progress}%` }} /></div>
    </div>
  );
}

function PlacementProgress({ asset }: { asset: Asset }) {
  const exactProgress = asset.total > 0
    ? Math.min(100, Math.max(0, ((asset.total - asset.available) / asset.total) * 100))
    : 0;
  // Keep the rounded label below 100% while any subscription inventory remains.
  const progress = asset.available > 0 ? Math.min(99.9, exactProgress) : exactProgress;
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

function SubscriptionProgress({ asset }: { asset: Asset }) {
  return asset.isAeToken ? <AeTokenReleaseProgress asset={asset} /> : <PlacementProgress asset={asset} />;
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
  const [confirming, setConfirming] = useState<TradeDetails | null>(null);
  // AE token daily rounds and every bonus round ever issued are separate
  // private_placements rows under the hood (each with its own release
  // schedule), but to users they are the exact same asset — "AE 代幣" — so
  // exactly one AE token card is ever shown here, never one per round.
  // Priority mirrors the admin AE token panel: an actively-releasing bonus
  // round takes over the subscription slot first (badge shown); once it
  // freezes but still has leftover inventory, that leftover keeps selling
  // under the same merged card (no badge, nothing new is being released);
  // otherwise the daily round is shown. Fully sold-out or superseded past
  // bonus rounds are never surfaced as their own cards.
  const aeTokenRows = assets.filter((asset) => asset.isAeToken);
  const dailyAeToken = aeTokenRows.find((asset) => asset.aeTokenKind === "daily") ?? null;
  const bonusAeTokens = aeTokenRows.filter((asset) => asset.aeTokenKind === "bonus");
  const activeBonusAeToken =
    bonusAeTokens.find((asset) => asset.isActive !== false && asset.available > 0 && !asset.releaseFrozenAt) ?? null;
  const clearingBonusAeToken =
    bonusAeTokens.find((asset) => asset.releaseFrozenAt && asset.available > 0) ?? null;
  const rawFeaturedAeToken = activeBonusAeToken ?? clearingBonusAeToken ?? dailyAeToken;
  // A bonus round's underlying row keeps its own name/location/images
  // ("AE 代幣獎勵") for admin bookkeeping, but the merged card must always
  // read as the same "AE 代幣" the user already knows — the flame badge is
  // the only visual cue that a reward round is behind the current price.
  const toDisplayAsset = (asset: Asset): Asset =>
    asset.isAeToken && dailyAeToken && asset.id !== dailyAeToken.id
      ? { ...asset, name: dailyAeToken.name, location: dailyAeToken.location, images: dailyAeToken.images, image: dailyAeToken.image }
      : asset;
  const featuredAeToken = rawFeaturedAeToken ? toDisplayAsset(rawFeaturedAeToken) : null;
  const placements = assets
    .filter((asset) => !asset.marketStartedAt || asset.isAeToken)
    .filter((asset) => !asset.isAeToken || asset.id === rawFeaturedAeToken?.id)
    .map((asset) => (asset.isAeToken && featuredAeToken ? featuredAeToken : asset));
  // The database is authoritative for placement availability. Using the
  // visitor's device clock here can incorrectly mark a valid placement as
  // ended before the server has rejected it.
  const active = (asset: Asset) =>
    (!asset.marketStartedAt || asset.isAeToken) &&
    asset.isActive !== false &&
    asset.available > 0;
  // AE token rounds additionally cap purchases to whatever the timed
  // release schedule has unlocked so far (see lib/aeToken.ts). Non-AE
  // placements are only limited by remaining inventory.
  const purchasableUnits = (asset: Asset) =>
    asset.isAeToken
      ? Math.min(asset.available, computeAeTokenRelease(asset).purchasableNow)
      : asset.available;
  useEffect(() => {
    setSelected((current) => {
      if (!current) return null;
      const next = assets.find((asset) => asset.id === current.id);
      return next ? toDisplayAsset(next) : null;
    });
  }, [platformAssets]);

  const openPlacement = (asset: Asset) => {
    if (!active(asset)) return;
    setSelected(asset);
    setQuantity(String(Math.min(100, Math.max(1, Math.floor(purchasableUnits(asset))))));
    setNotice(null);
  };

  // The trade RPC authorizes by authenticated user, not agency role. Admins,
  // master agents, agents, and users therefore share this exact purchase flow.
  // 送出前先彙整交易明細供用戶確認。
  const review = () => {
    if (!selected || submitting) return;
    const units = Number(quantity);
    if (!Number.isSafeInteger(units) || units <= 0) {
      setNotice({ text: "請輸入有效的整數份額", ok: false });
      return;
    }
    const gross = units * selected.price;
    setConfirming({
      assetName: selected.name,
      quantity: units,
      fee: `${formatUSDT(0)}（私募認購免手續費）`,
      total: `${formatUSDT(gross * 1.0001)}–${formatUSDT(gross * 1.0002)}`,
      gas: `${formatUSDT(gross * 0.0001)}–${formatUSDT(gross * 0.0002)}`,
      note: `標的物本金 ${formatUSDT(gross)}，模擬 Gas 為成交額 0.01%–0.02%，最終金額以鏈上結算為準。`,
    });
  };

  const submit = async () => {
    if (!selected || submitting) return;
    setConfirming(null);
    const latestAsset = platformAssets.find((asset) => asset.id === selected.id);
    const units = Number(quantity);
    if (!latestAsset || !active(latestAsset)) {
      setNotice({ text: "此認���項目已完售或目前不可認購", ok: false });
      return;
    }
    if (!Number.isSafeInteger(units) || units <= 0 || units > 1_000_000) {
      setNotice({ text: "請輸入 1 至 1,000,000 之間的整數份額", ok: false });
      return;
    }
    const cap = purchasableUnits(latestAsset);
    if (units > cap) {
      setNotice({ text: `目前最多可認購 ${cap.toLocaleString()} 份`, ok: false });
      return;
    }
    if (units * selected.price * 1.0002 > balance) {
      setNotice({ text: "USDT 餘額不足（需包含最高 0.02% 模擬 Gas）", ok: false });
      return;
    }
    setSubmitting(true);
    try {
      const result = await trade(selected.id, "private_buy", units);
      setNotice({ text: result.message, ok: result.ok });
      if (result.ok && result.enteredSecondaryMarket) {
        // The market page shows one merged AE token card at the canonical
        // id (holdings/orders are collapsed there server-side), regardless
        // of which round was actually purchased.
        const assetId = selected.isAeToken ? AE_TOKEN_CANONICAL_ID : selected.id;
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
            className={`overflow-hidden rounded-2xl border bg-slate-900 ${
              activeBonusAeToken?.id === asset.id ? "border-amber-400/60 shadow-[0_0_28px_-6px_rgba(251,191,36,0.55)]" : "border-slate-800"
            }`}
          >
            <div className="relative">
              <ClickableAssetImage images={asset.images?.length ? asset.images : [asset.image]} assetName={asset.name} className="h-44 w-full object-cover" />
              {activeBonusAeToken?.id === asset.id && (
                <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 px-3 py-1.5 text-xs font-bold text-white shadow-lg">
                  <Flame className="size-3.5 animate-pulse" />
                  獎勵開啟中
                  <span className="absolute inset-0 -z-10 animate-pulse rounded-full bg-orange-500/60 blur-md" />
                </div>
              )}
            </div>
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
                    {formatEndsAt(asset.endsAt, (date) => date.toLocaleDateString())}
                  </p>
                </div>
              </div>
              <SubscriptionProgress asset={asset} />
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
        {selected && (() => {
          const selectedCap = purchasableUnits(selected);
          const noQuotaYet = selected.isAeToken && selectedCap <= 0 && selected.available > 0;
          return (
          <div className="flex flex-col gap-6">
            <AssetDetails asset={selected} />
            <section aria-label="認購資訊" className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-5">
              <h2 className="font-bold text-amber-300">認購資訊</h2>
              <SubscriptionProgress asset={selected} />
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
              <FormattedNumberInput
                min="1"
                max={Math.max(0, Math.floor(selectedCap))}
                inputMode="numeric"
                disabled={!active(selected) || noQuotaYet}
                value={quantity}
                onValueChange={setQuantity}
                className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3"
              />
            </label>
            {noQuotaYet && (
              <Notice
                message="本輪目前尚無可認購配額，請等待下一次釋出"
                tone="error"
              />
            )}
            <div className="fixed-dark-surface rounded-xl p-4 text-sm">
              <div className="flex justify-between text-slate-400">
                <span>標的物本金</span>
                <b className="text-slate-100">{formatUSDT((Number(quantity) || 0) * selected.price)}</b>
              </div>
              <div className="mt-2 flex justify-between text-slate-400">
                <span>模擬 Gas（0.01%–0.02%）</span>
                <b className="text-slate-100">
                  {formatUSDT((Number(quantity) || 0) * selected.price * 0.0001)}–{formatUSDT((Number(quantity) || 0) * selected.price * 0.0002)}
                </b>
              </div>
              <div className="mt-3 flex justify-between border-t border-amber-400/10 pt-3 font-bold">
                <span>預估支付總額</span>
                <span>{formatUSDT((Number(quantity) || 0) * selected.price * 1.0001)}–{formatUSDT((Number(quantity) || 0) * selected.price * 1.0002)}</span>
              </div>
            </div>
            {notice && (
              <Notice
                message={notice.text}
                tone={notice.ok ? "success" : "error"}
              />
            )}
            <button
              disabled={submitting || !active(selected) || noQuotaYet}
              onClick={review}
              className="fixed-dark-action rounded-xl py-3 font-bold disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "處理中…" : tr("confirmSubscription")}
            </button>
            </section>
          </div>
          );
        })()}
      </Modal>
      <TradeDetailsDialog
        open={!!confirming}
        onClose={() => setConfirming(null)}
        title="交易明細"
        details={confirming}
        confirmLabel={tr("confirmSubscription")}
        submitting={submitting}
        onConfirm={() => void submit()}
      />
    </div>
  );
}
