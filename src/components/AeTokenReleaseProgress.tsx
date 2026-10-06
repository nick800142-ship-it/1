import { formatCountdown, useAeTokenRelease } from "@/lib/aeToken";
import type { Asset } from "@/platform";

type AeTokenReleaseProgressProps = {
  asset: Asset;
  rounds: Asset[];
  compact?: boolean;
  useCurrentRound?: boolean;
};

export function AeTokenReleaseProgress({
  asset,
  rounds,
  compact = false,
  useCurrentRound = false,
}: AeTokenReleaseProgressProps) {
  const dailyAsset = rounds.find((round) => round.aeTokenKind === "daily");
  const activeBonus = rounds.find(
    (round) => round.aeTokenKind === "bonus" && round.isActive !== false && round.available > 0 && !round.releaseFrozenAt,
  );
  const clearingBonus = rounds.find(
    (round) => round.aeTokenKind === "bonus" && round.releaseFrozenAt && round.available > 0,
  );
  const releaseAsset = useCurrentRound
    ? activeBonus ?? clearingBonus ?? dailyAsset ?? asset
    : asset;
  const release = useAeTokenRelease(releaseAsset);
  const dailyRelease = useAeTokenRelease(dailyAsset);
  if (!release) return null;

  const totalIssued = rounds.reduce(
    (sum, round) => sum + Math.max(0, round.total),
    0,
  );
  const progress =
    release.releasedSoFar > 0
      ? Math.min(
          100,
          Math.max(0, (release.purchasedSoFar / release.releasedSoFar) * 100),
        )
      : 0;
  const shownProgress = releaseAsset.available > 0 ? Math.min(99.9, progress) : progress;
  const showDailyCountdown =
    releaseAsset.aeTokenKind === "bonus" &&
    !releaseAsset.releaseFrozenAt &&
    release.secondsToNextRelease === null &&
    dailyRelease?.secondsToNextRelease != null;
  const containerClass = compact
    ? "mt-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3"
    : "mt-4 rounded-xl border border-slate-800 bg-slate-950/50 p-3";

  return (
    <div className={containerClass}>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <span className="text-slate-500">
          總已發行份額（平常日＋獎勵）
          <b className="block text-amber-300">{totalIssued.toLocaleString()}</b>
        </span>
        <span className="text-right text-slate-500">
          本輪已釋出
          <b className="block text-amber-300">{release.releasedSoFar.toLocaleString()}</b>
        </span>
        <span className="text-slate-500">
          目前可認購
          <b className="block text-amber-300">{release.purchasableNow.toLocaleString()}</b>
        </span>
      </div>
      {release.secondsToNextRelease !== null && (
        <p className="mt-2 text-xs text-slate-500">
          下次釋出倒數{" "}
          <b className="text-slate-200">{formatCountdown(release.secondsToNextRelease)}</b>
        </p>
      )}
      {showDailyCountdown && (
        <p className="mt-2 text-xs text-slate-500">
          平常日下次釋出倒數{" "}
          <b className="text-slate-200">
            {formatCountdown(dailyRelease!.secondsToNextRelease!)}
          </b>
        </p>
      )}
      <div className="mt-3 flex items-center justify-between text-xs">
        <span className="text-slate-500">認購進度</span>
        <b className="text-amber-300">{shownProgress.toFixed(1)}%</b>
      </div>
      <div
        className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800"
        role="progressbar"
        aria-label="認購進度"
        aria-valuenow={shownProgress}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-amber-400"
          style={{ width: `${shownProgress}%` }}
        />
      </div>
    </div>
  );
}

