import useSWR from "swr";
import { supabase } from "@/lib/supabase";

export type P2PFees = {
  /** 成交手續費，單位 bps（100 = 1%）。 */
  feeBps: number;
  /** 賣方一次性掛單費（JC）。 */
  listingFee: number;
};

export const LEGACY_P2P_FEES: P2PFees = { feeBps: 100, listingFee: 1 };

async function fetchP2PFees(): Promise<P2PFees> {
  const { data, error } = await supabase
    .from("platform_config")
    .select("p2p_fee_bps,p2p_listing_fee")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return {
    feeBps: Number(data?.p2p_fee_bps ?? LEGACY_P2P_FEES.feeBps),
    listingFee: Number(data?.p2p_listing_fee ?? LEGACY_P2P_FEES.listingFee),
  };
}

/** 目前新掛單適用的費率；既有掛單的費率以該掛單的 fee_bps 快照為準。 */
export function useP2PFees() {
  const { data, mutate } = useSWR<P2PFees>("p2p-fees", fetchP2PFees, { refreshInterval: 60_000 });
  return { fees: data ?? LEGACY_P2P_FEES, loaded: Boolean(data), mutate };
}

export function formatFeePercent(feeBps: number): string {
  return `${(feeBps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

export function tradeFeeFor(gross: number, feeBps: number): number {
  return Number((gross * feeBps / 10_000).toFixed(6));
}
