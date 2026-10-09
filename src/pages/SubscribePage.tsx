import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock3, Flame, MapPin } from "lucide-react";
import { formatApy, formatEndsAt, formatJC, interfaceText, localizedUiText, useLanguage, usePlatform, type Asset } from "@/platform";
import { Modal, Notice } from "@/components/Modal";
import { SearchSuggest } from "@/components/SearchSuggest";
import { ClickableAssetImage } from "@/components/AssetImageGallery";
import { AssetDetails } from "@/components/AssetDetails";
import { FormattedNumberInput } from "@/components/FormattedNumberInput";
import { TradeDetailsDialog, type TradeDetails } from "@/components/TradeDetailsDialog";
import { AE_TOKEN_CANONICAL_ID, computeAeTokenRelease } from "@/lib/aeToken";
import { AeTokenReleaseProgress } from "@/components/AeTokenReleaseProgress";
import { useOnchainSettlement } from "@/lib/onchainSettlement";
import { reportMonitorEventInBackground } from "@/lib/monitoring";

function PlacementProgress({ asset }: { asset: Asset }) {
  const { language } = useLanguage();
  const exactProgress = asset.total > 0
    ? Math.min(100, Math.max(0, ((asset.total - asset.available) / asset.total) * 100))
    : 0;
  // Keep the rounded label below 100% while any subscription inventory remains.
  const progress = asset.available > 0 ? Math.min(99.9, exactProgress) : exactProgress;
  return (
    <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
      <div className="grid grid-cols-2 gap-2 text-xs">
        <span className="text-slate-500">{localizedUiText(language, "총 발행량", "總發行量")} <b className="block text-slate-200">{asset.total.toLocaleString()}</b></span>
        <span className="text-right text-slate-500">{localizedUiText(language, "잔여 발행량", "剩餘發行量")} <b className="block text-slate-200">{asset.available.toLocaleString()}</b></span>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs"><span className="text-slate-500">{localizedUiText(language, "프라이빗 청약 진행률", "私募進度")}</span><b className="text-amber-300">{progress.toFixed(1)}%</b></div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800" role="progressbar" aria-label={localizedUiText(language, "프라이빗 청약 진행률", "私募進度")} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><div className="h-full rounded-full bg-amber-400" style={{ width: `${progress}%` }} /></div>
    </div>
  );
}

function SubscriptionProgress({ asset, aeRounds }: { asset: Asset; aeRounds: Asset[] }) {
  return asset.isAeToken ? <AeTokenReleaseProgress asset={asset} rounds={aeRounds} /> : <PlacementProgress asset={asset} />;
}

export function SubscribePage() {
  const { tr, language, assets: localizedAssets } = useLanguage();
  const {
    assets: platformAssets,
    jcOnChainBalance,
    jcOnChainLoading,
    jcOnChainError,
    trade,
  } = usePlatform();
  // 認購 RPC 只建立 JC 與庫存預留；只有鏈上收款、資產交割與正式帳本同步全數確認後，
  // 才會向使用者回報成功。任何未確認狀態都保留預留並由後端安全重試。
  const { settleSubscription, ensureJcSpendable } = useOnchainSettlement();
  const assets = useMemo(
    () =>
      platformAssets.map((asset) => {
        const localized = localizedAssets.find((item) => item.id === asset.id);
        const translation = asset.translations?.[language] ?? asset.translations?.["zh-TW"];
        return {
          ...(localized ?? asset),
          ...asset,
          name: asset.isAeToken ? "AE" : translation?.name?.trim() || localized?.name || asset.name,
          location: translation?.location?.trim() || localized?.location || asset.location,
          information: translation?.information?.trim() || asset.information,
          history: translation?.history?.length ? translation.history : localized?.history ?? asset.history,
          comparables: translation?.comparables?.length ? translation.comparables : localized?.comparables ?? asset.comparables,
          advantages: translation?.advantages?.length ? translation.advantages : localized?.advantages ?? asset.advantages,
          address: asset.address,
        };
      }),
    [platformAssets, localizedAssets, language],
  );
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
  // schedule), but to users they are the exact same asset — "AE" — so
  // exactly one AE token card is ever shown here, never one per round.
  // Priority mirrors the admin AE token panel: an actively-releasing bonus
  // round takes over the subscription slot first (badge shown); once it
  // freezes but still has leftover inventory, that leftover keeps selling
  // under the same merged card (no badge, nothing new is being released);
  // otherwise the daily round is shown. Fully sold-out or superseded past
  // bonus rounds are never surfaced as their own cards.
  const aeTokenRows = assets.filter((asset) => asset.isAeToken);
  const aeIssuanceRounds = aeTokenRows;
  const dailyAeToken = aeTokenRows.find((asset) => asset.aeTokenKind === "daily") ?? null;
  const bonusAeTokens = aeTokenRows.filter((asset) => asset.aeTokenKind === "bonus");
  const activeBonusAeToken =
    bonusAeTokens.find((asset) => asset.isActive !== false && asset.available > 0 && !asset.releaseFrozenAt) ?? null;
  const clearingBonusAeToken =
    bonusAeTokens.find((asset) => asset.releaseFrozenAt && asset.available > 0) ?? null;
  const rawFeaturedAeToken = activeBonusAeToken ?? clearingBonusAeToken ?? dailyAeToken;
  // A bonus round's underlying row keeps its own name/location/images
  // ("AE獎勵") for admin bookkeeping, but the merged card must always
  // read as the same "AE" the user already knows — the flame badge is
  // the only visual cue that a reward round is behind the current price.
  const toDisplayAsset = useCallback(
    (asset: Asset): Asset =>
      asset.isAeToken && dailyAeToken && asset.id !== dailyAeToken.id
        ? { ...asset, name: dailyAeToken.name, location: dailyAeToken.location, images: dailyAeToken.images, image: dailyAeToken.image }
        : asset,
    [dailyAeToken],
  );
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
  }, [assets, toDisplayAsset]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const requestedAssetId = url.searchParams.get("asset");
    if (!requestedAssetId) return;
    const requestedAsset = assets.find((asset) => asset.id === requestedAssetId);
    if (!requestedAsset) return;
    if (active(requestedAsset)) {
      setSelected(toDisplayAsset(requestedAsset));
      setQuantity("");
      setNotice(null);
    }
    url.searchParams.delete("asset");
    window.history.replaceState(null, "", url);
  }, [assets, toDisplayAsset]);

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
      setNotice({ text: localizedUiText(language, "유효한 정수 수량을 입력해 주세요.", "請輸入有效的整數份額"), ok: false });
      return;
    }
    const gross = units * selected.price;
    setConfirming({
      assetName: selected.name,
      quantity: units,
      fee: `0 JC（${localizedUiText(language, "프라이빗 청약 수수료 없음", "私募認購免手續費")}）`,
      total: formatJC(gross),
  note: localizedUiText(language, `납부할 원금은 ${formatJC(gross)}입니다. JC와 재고를 먼저 예약하며, 온체인 결제와 지분 이전이 확인된 후에만 정식으로 차감되고 커미션이 반영됩니다.`, `需支付的本金 ${formatJC(gross)}。系統會先保留 JC 與庫存，待鏈上收款及份額交割確認後，才正式扣帳並入帳分潤。`),
    });
  };

  const submit = async () => {
    if (!selected || submitting) return;
    setConfirming(null);
    const latestAsset = platformAssets.find((asset) => asset.id === selected.id);
    const units = Number(quantity);
    if (!latestAsset || !active(latestAsset)) {
      setNotice({ text: localizedUiText(language, "이 청약 상품은 매진되었거나 현재 청약할 수 없습니다.", "此認購項目已完售或目前不可認購"), ok: false });
      return;
    }
    if (!Number.isSafeInteger(units) || units <= 0 || units > 1_000_000) {
      setNotice({ text: "請輸入 1 至 1,000,000 之間的整數份額", ok: false });
      return;
    }
    const cap = purchasableUnits(latestAsset);
    if (units > cap) {
      setNotice({ text: localizedUiText(language, `현재 최대 ${cap.toLocaleString()}개까지 청약할 수 있습니다.`, `目前最多可認購 ${cap.toLocaleString()} 份`), ok: false });
      return;
    }
    setSubmitting(true);
    try {
      // 扣站內帳本前先做鏈上 JC 門檻檢查：錢包鏈上 JC 不足或未授權 ADMIN 就擋下
      // （分潤 JC 未上鏈，需先在金庫購買足額 JC），避免站內已扣款、鏈上收不到 JC。
      try {
        await ensureJcSpendable(units * selected.price);
      } catch (gateError) {
        const message = gateError instanceof Error ? gateError.message : "鏈上 JC 檢查未通過";
        reportMonitorEventInBackground({
          type: "trade_result",
          success: false,
          message,
          action: "一級認購鏈上錢包檢查",
          assetId: selected.id,
          assetName: selected.name,
          quantity: units,
          amount: units * selected.price,
        });
        setNotice({ text: message, ok: false });
        setSubmitting(false);
        return;
      }
      const result = await trade(selected.id, "private_buy", units);
      let completed = false;
      let message = result.message;
      if (result.ok && result.requestKey) {
        try {
          const res = await settleSubscription(result.requestKey);
          const txHash = typeof res.tx_hash === "string" ? res.tx_hash : null;
          completed = res.status === "confirmed";
          message = completed
  ? `${localizedUiText(language, "청약 완료", "認購完成")}（${localizedUiText(language, "온체인 결제와 공식 원장이 모두 확인되었습니다", "鏈上交割與正式帳本均已確認")}${txHash ? `，Tx: ${txHash.slice(0, 10)}…` : ""}）`
  : localizedUiText(language, "청약 예약이 생성되었지만 온체인 결제와 공식 원장 반영이 아직 확인되지 않았습니다. 한도가 보류되며 자동 재시도됩니다. 중복 청약하지 마세요.", "認購預留已建立，但鏈上交割與正式帳本尚未確認。額度已保留，系統會自動重試，請勿重複認購。");
        } catch (onChainError) {
          message = `認購預留已建立，但鏈上交割尚未確認。額度已保留，系統會自動重試，請勿重複認購。${onChainError instanceof Error ? ` ${onChainError.message}` : ""}`;
        }
      } else if (result.ok) {
        message = "認購預留已建立，但尚未取得結算追蹤編號，因此不能確認成功。額度已保留，請勿重複認購；系統會自動重試。";
      }
      if (completed) {
        reportMonitorEventInBackground({ type: "trade_result", success: true });
        if (result.enteredSecondaryMarket) {
          reportMonitorEventInBackground({ type: "private_sale_complete", placementId: selected.id });
        }
      }
      setNotice({ text: message, ok: completed });
      if (result.ok && !completed) setSelected(null);
      if (completed && result.enteredSecondaryMarket) {
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
                  {localizedUiText(language, "보너스 청약 진행 중", "獎勵開放中")}
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
                  <p className="text-xl font-bold">
                    {formatJC(asset.price)}
                  </p>
                </div>
                <div className="text-right">
                  {!asset.isAeToken && (
                    <p className="font-semibold text-amber-300">APY {formatApy(asset.apy)}</p>
                  )}
                  <p className="mt-1 flex items-center gap-1 text-xs text-slate-400">
                    <Clock3 className="size-3" />
                    {formatEndsAt(asset.endsAt, (date) => date.toLocaleDateString())}
                  </p>
                </div>
              </div>
              <SubscriptionProgress asset={asset} aeRounds={aeIssuanceRounds} />
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
        <section aria-label={localizedUiText(language, "청약 정보", "認購資訊")} className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-5">
          <h2 className="font-bold text-amber-300">{localizedUiText(language, "청약 정보", "認購資訊")}</h2>
              <SubscriptionProgress asset={selected} aeRounds={aeIssuanceRounds} />
            <div className="rounded-xl bg-slate-800 p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-400">{localizedUiText(language, "사용 가능 JC", "可用 JC")}</span>
                <b>{jcOnChainLoading ? "讀取中…" : jcOnChainError ? "讀取失敗" : formatJC(jcOnChainBalance)}</b>
              </div>
              <div className="mt-2 flex justify-between">
                <span className="text-slate-400">
                  {tr("subscriptionUnitPrice")}
                </span>
                <b>{formatJC(selected.price)}</b>
              </div>
            </div>
            <label className="text-sm">
              {tr("subscriptionUnits")}
              <FormattedNumberInput
                min="1"
                max={Math.max(0, Math.floor(selectedCap))}
                inputMode="numeric"
                maxDecimals={0}
                disabled={!active(selected) || noQuotaYet}
                value={quantity}
                onValueChange={setQuantity}
                className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3"
              />
            </label>
            {noQuotaYet && (
              <Notice
                message={localizedUiText(language, "이번 라운드에는 청약 가능 수량이 없습니다. 다음 공개를 기다려 주세요.", "本輪目前尚無可認購配額，請等待下一次釋出")}
                tone="error"
              />
            )}
            <div className="fixed-dark-surface rounded-xl p-4 text-sm">
              <div className="flex justify-between text-slate-400">
                <span>{localizedUiText(language, "자산 원금", "標的物本金")}</span>
                <b className="text-slate-100">{formatJC((Number(quantity) || 0) * selected.price)}</b>
              </div>
              <div className="mt-3 flex justify-between border-t border-amber-400/10 pt-3 font-bold">
                <span>{localizedUiText(language, "총 청약 원금", "認購本金總額")}</span>
                <span>{formatJC((Number(quantity) || 0) * selected.price)}</span>
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
