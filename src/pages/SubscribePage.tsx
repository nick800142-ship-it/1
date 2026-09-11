import { useEffect, useState } from "react";
import { Clock3, Flame, MapPin } from "lucide-react";
import { formatApy, formatEndsAt, formatUSDT, interfaceText, isRwaAeSettled, rwaAePerShare, rwaLiveView, useLanguage, usePlatform, type Asset } from "@/platform";
import { Modal, Notice } from "@/components/Modal";
import { SearchSuggest } from "@/components/SearchSuggest";
import { ClickableAssetImage } from "@/components/AssetImageGallery";
import { AssetDetails } from "@/components/AssetDetails";
import { FormattedNumberInput } from "@/components/FormattedNumberInput";
import { TradeDetailsDialog, type TradeDetails } from "@/components/TradeDetailsDialog";
import { AE_TOKEN_CANONICAL_ID, computeAeTokenRelease, formatCountdown, useAeTokenRelease } from "@/lib/aeToken";

function AeTokenReleaseProgress({ asset, dailyAsset }: { asset: Asset; dailyAsset?: Asset | null }) {
  const release = useAeTokenRelease(asset);
  // Once a bonus round's own timed release schedule has fully run out
  // (every unit it was ever going to drip has been released) but leftover
  // inventory is still up for sale, the bonus card has nothing left to
  // count down to. The daily round keeps releasing in the background the
  // whole time, so surface its countdown here too instead of leaving the
  // card looking stalled.
  const dailyRelease = useAeTokenRelease(dailyAsset ?? null);
  if (!release) return null;
  // Total supply is 100 billion units, so purchased/total rounds down to
  // 0.0% forever and the bar always reads empty. Measure against what this
  // round has actually released so far instead — that is the pool users are
  // really drawing down when they buy.
  const exactProgress = release.releasedSoFar > 0
    ? Math.min(100, Math.max(0, (release.purchasedSoFar / release.releasedSoFar) * 100))
    : 0;
  const progress = asset.available > 0 ? Math.min(99.9, exactProgress) : exactProgress;
  const showDailyCountdown =
    asset.aeTokenKind === "bonus" &&
    !asset.releaseFrozenAt &&
    release.secondsToNextRelease === null &&
    !!dailyAsset &&
    dailyRelease?.secondsToNextRelease != null;
  return (
    <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
      <div className="grid grid-cols-2 gap-2 text-xs">
        <span className="text-slate-500">本輪已釋出 <b className="block text-amber-300">{release.releasedSoFar.toLocaleString()}</b></span>
        <span className="text-right text-slate-500">目前可認購 <b className="block text-amber-300">{release.purchasableNow.toLocaleString()}</b></span>
      </div>
      {release.secondsToNextRelease !== null && (
        <p className="mt-2 text-xs text-slate-500">
          下次釋出倒數 <b className="text-slate-200">{formatCountdown(release.secondsToNextRelease)}</b>
        </p>
      )}
      {showDailyCountdown && (
        <p className="mt-2 text-xs text-slate-500">
          平常日下次釋出倒數 <b className="text-slate-200">{formatCountdown(dailyRelease!.secondsToNextRelease!)}</b>
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

function SubscriptionProgress({ asset, dailyAsset }: { asset: Asset; dailyAsset?: Asset | null }) {
  return asset.isAeToken ? <AeTokenReleaseProgress asset={asset} dailyAsset={dailyAsset} /> : <PlacementProgress asset={asset} />;
}

const formatAe = (value: number) =>
  `${value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 })} AE`;

export function SubscribePage() {
  const { tr, language, assets: localizedAssets } = useLanguage();
  const { assets: platformAssets, balance, availableAe, aePrice, trade } = usePlatform();
  const assets = platformAssets.map((asset) => {
    const localized = localizedAssets.find((item) => item.id === asset.id);
    const translation = asset.translations?.[language] ?? asset.translations?.["zh-TW"];
    const merged = {
      ...(localized ?? asset),
      ...asset,
      name: translation?.name?.trim() || localized?.name || asset.name,
      location: translation?.location?.trim() || localized?.location || asset.location,
      information: translation?.information?.trim() || asset.information,
      address: asset.address,
    };
    // 依二級市場 AE 現價即時投影棘輪後的每份 AE / 總份額 / 剩餘份額，
    // 讓卡片、認購彈窗、圈存試算與扣款一致（購買時後端會以同一現價再套用棘輪）。
    const view = rwaLiveView(merged, aePrice);
    return { ...merged, aePerShare: view.perShareAE, total: view.total, available: view.available };
  });
  const [selected, setSelected] = useState<Asset | null>(null);
  const [search, setSearch] = useState("");
  const [quantity, setQuantity] = useState("");
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
    setQuantity("");
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
    if (isRwaAeSettled(selected)) {
      // RWA priced in AE uses the encumbrance model: the required AE is frozen
      // (moved to 圈存中 AE), a USDT gas fee is charged now, and the AE is only
      // deducted / shares credited once the placement enters the secondary market.
      const aePay = units * (rwaAePerShare(selected));
      const gasUsdt = aePay * aePrice * 0.0001;
      const gasText = `${gasUsdt.toLocaleString(undefined, { maximumFractionDigits: 6 })} USDT`;
      setConfirming({
        assetName: selected.name,
        quantity: units,
        fee: `0 AE（私募認購免手續費）`,
        total: `${formatAe(aePay)}（圈存）`,
        gas: gasText,
        note: `認購後將圈存 ${formatAe(aePay)}（凍結於「圈存中 AE」，尚未扣除），另收 Gas ≈ ${gasText}（依 AE 現價折算，以 USDT 扣、付區塊鏈）。標的進入二級市場後才正式扣除 AE 並記入份額；若標的下架則全額退回可用 AE。`,
      });
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
      setNotice({ text: "此認購項目已完售或目前不可認購", ok: false });
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
    if (isRwaAeSettled(selected)) {
      const aeNeeded = units * (rwaAePerShare(selected));
      if (aeNeeded > availableAe) {
        setNotice({ text: "可用 AE 不足，無法完成本次圈存認購", ok: false });
        return;
      }
    } else if (units * selected.price * 1.0002 > balance) {
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
                    {isRwaAeSettled(asset) ? "每份需支付" : tr("subscriptionUnitPrice")}
                  </p>
                  <p className="text-xl font-bold">
                    {isRwaAeSettled(asset)
                      ? formatAe(rwaAePerShare(asset))
                      : formatUSDT(asset.price)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-amber-300">APY {formatApy(asset.apy)}</p>
                  <p className="mt-1 flex items-center gap-1 text-xs text-slate-400">
                    <Clock3 className="size-3" />
                    {formatEndsAt(asset.endsAt, (date) => date.toLocaleDateString())}
                  </p>
                </div>
              </div>
              <SubscriptionProgress asset={asset} dailyAsset={dailyAeToken} />
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
              <SubscriptionProgress asset={selected} dailyAsset={dailyAeToken} />
            <div className="rounded-xl bg-slate-800 p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-400">
                  {isRwaAeSettled(selected) ? "可用 AE" : tr("availableBalance")}
                </span>
                <b>{isRwaAeSettled(selected) ? formatAe(availableAe) : formatUSDT(balance)}</b>
              </div>
              <div className="mt-2 flex justify-between">
                <span className="text-slate-400">
                  {isRwaAeSettled(selected) ? "每份需支付" : tr("subscriptionUnitPrice")}
                </span>
                <b>
                  {isRwaAeSettled(selected)
                    ? formatAe(rwaAePerShare(selected))
                    : formatUSDT(selected.price)}
                </b>
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
            {isRwaAeSettled(selected) ? (
              <div className="fixed-dark-surface rounded-xl p-4 text-sm">
                <div className="flex justify-between text-slate-400">
                  <span>每份需支付 AE</span>
                  <b className="text-slate-100">{formatAe(rwaAePerShare(selected))}</b>
                </div>
                <div className="mt-2 flex justify-between text-slate-400">
                  <span>Gas（USDT，依 AE 現價折算）</span>
                  <b className="text-slate-100">
                    {((Number(quantity) || 0) * (rwaAePerShare(selected)) * aePrice * 0.0001).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDT
                  </b>
                </div>
                <div className="mt-3 flex justify-between border-t border-amber-400/10 pt-3 font-bold">
                  <span>圈存 AE 總額</span>
                  <span>{formatAe((Number(quantity) || 0) * (rwaAePerShare(selected)))}</span>
                </div>
                <p className="mt-3 text-xs text-slate-500">
                  確認後將把所需 AE 圈存（凍結於「圈存中 AE」，尚未扣除），另以 USDT 收取 0.01% Gas。標的進入二級市場後才正式扣除 AE 並記入 RWA 份額；下架則全額退回可用 AE。每份所需 AE 依 AE 二級市場現價動態調整（AE 上漲時每份 AE 減少；AE 下跌時每份 AE 不變、總份額增加）。
                </p>
              </div>
            ) : (
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
            )}
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
