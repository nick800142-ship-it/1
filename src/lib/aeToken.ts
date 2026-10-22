import { useEffect, useState } from "react";
import type { Asset } from "@/platform";

/**
 * AE token daily rounds and bonus rounds live as separate
 * private_placements rows (each with its own release schedule), but they
 * are the same underlying asset to users. Holdings and secondary-market
 * orders are collapsed onto this id server-side (execute_private_purchase),
 * so any UI that shows the merged "AE 代幣" position/market must key off
 * this id rather than whichever round a user actually bought into.
 */
export const AE_TOKEN_CANONICAL_ID = "ae-token-daily";

/**
 * AE 暫停期間：所有 AE 輪次都已停用（admin 歸零後 is_active=false）。
 * 認購頁、首頁、二級市場不顯示 AE；錢包仍保留持倉（錢包直接讀 assets）。
 */
export function isAeClosed(assets: readonly Asset[]): boolean {
  return !assets.some((asset) => asset.isAeToken && asset.isActive !== false);
}

export type AeTokenRelease = {
  /** Total units released so far, capped at total supply. */
  releasedSoFar: number;
  /** Units already sold (total - available). */
  purchasedSoFar: number;
  /** Units currently purchasable (released but not yet sold). Never negative. */
  purchasableNow: number;
  /** Timestamp (ms epoch) of the next release batch, or null if fully released. */
  nextReleaseAt: number | null;
  /** Seconds until the next release batch, or null if fully released. */
  secondsToNextRelease: number | null;
};

/**
 * Mirrors the release-rate math enforced server-side in
 * execute_private_purchase (see the AE token release migration). This is a
 * *display-only* helper — the database is the authoritative source of truth
 * for what can actually be purchased, since it derives elapsed time from
 * clock_timestamp() rather than trusting the client's clock.
 */
export function computeAeTokenRelease(asset: Asset, now: number = Date.now()): AeTokenRelease {
  const total = asset.total;
  const interval = asset.releaseIntervalSeconds;
  const amountPerInterval = asset.releaseAmountPerInterval;
  const startedAt = asset.releaseStartedAt ? new Date(asset.releaseStartedAt).getTime() : null;

  if (!interval || interval <= 0 || !amountPerInterval || amountPerInterval <= 0 || !startedAt) {
    return {
      releasedSoFar: 0,
      purchasedSoFar: total - asset.available,
      purchasableNow: 0,
      nextReleaseAt: null,
      secondsToNextRelease: null,
    };
  }

  // Ended round: mirrors execute_private_purchase — once frozen, no more
  // drip is coming, so all remaining inventory is unlocked for clearing
  // immediately rather than staying gated by a clock that stopped ticking.
  if (asset.releaseFrozenAt) {
    const purchasedSoFar = total - asset.available;
    return {
      releasedSoFar: total,
      purchasedSoFar,
      purchasableNow: asset.available,
      nextReleaseAt: null,
      secondsToNextRelease: null,
    };
  }

  const elapsedSeconds = Math.max(0, (now - startedAt) / 1000);
  const elapsedIntervals = Math.floor(elapsedSeconds / interval);
  const releasedSoFar = Math.min(total, elapsedIntervals * amountPerInterval);
  const purchasedSoFar = total - asset.available;
  const purchasableNow = Math.max(0, releasedSoFar - purchasedSoFar);

  const fullyReleased = releasedSoFar >= total;
  const nextReleaseAt = fullyReleased ? null : startedAt + (elapsedIntervals + 1) * interval * 1000;
  const secondsToNextRelease = nextReleaseAt === null ? null : Math.max(0, Math.ceil((nextReleaseAt - now) / 1000));

  return { releasedSoFar, purchasedSoFar, purchasableNow, nextReleaseAt, secondsToNextRelease };
}

/**
 * Ticks every second so AE token cards can show a live countdown / released
 * amount without the user needing to refresh the page.
 */
export function useAeTokenRelease(asset: Asset | null | undefined): AeTokenRelease | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!asset?.isAeToken) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [asset?.isAeToken, asset?.id]);

  if (!asset?.isAeToken) return null;
  return computeAeTokenRelease(asset, now);
}

export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
