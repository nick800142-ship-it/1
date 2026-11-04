import useSWR from "swr";
import { computeAeTokenRelease } from "@/lib/aeToken";
import { callRelayer } from "@/lib/onchainSettlement";
import type { Asset } from "@/platform";

type ReservedByAsset = Record<string, number>;

async function fetchReservedByAsset(): Promise<ReservedByAsset> {
  const response = await callRelayer("subscription-capacity");
  const raw = response.reservedByAsset;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("認購庫存資料格式錯誤");
  }

  return Object.fromEntries(
    Object.entries(raw).map(([assetId, quantity]) => [assetId, Number(quantity) || 0]),
  );
}

export function useSubscriptionCapacity() {
  const { data, error, isLoading, mutate } = useSWR(
    "subscription-capacity",
    fetchReservedByAsset,
    {
      refreshInterval: 5_000,
      revalidateOnFocus: true,
      dedupingInterval: 2_000,
    },
  );

  return {
    reservedByAsset: data ?? {},
    isReady: data !== undefined && !error,
    isLoading,
    error,
    refresh: mutate,
  };
}

export function getSubscriptionCapacity(asset: Asset, reservedByAsset: ReservedByAsset): number {
  const reserved = Math.max(0, Number(reservedByAsset[asset.id]) || 0);
  const inventoryRemaining = Math.max(0, asset.available - reserved);
  if (!asset.isAeToken) return inventoryRemaining;

  const releasedRemaining = Math.max(0, computeAeTokenRelease(asset).purchasableNow - reserved);
  return Math.min(inventoryRemaining, releasedRemaining);
}
