import useSWR from "swr";
import { getAddress, type Address } from "viem";
import { CONTRACT_ADDRESSES } from "@/lib/contracts";
import { supabase } from "@/lib/supabase";

/** 目前生效的 Safe 存在 platform_config.active_safe_address，更換 Safe 提案執行後自動切換。 */
export async function fetchActiveSafeAddress(): Promise<Address> {
  const { data, error } = await supabase
    .from("platform_config")
    .select("active_safe_address")
    .limit(1)
    .maybeSingle();
  if (error || !data?.active_safe_address) return CONTRACT_ADDRESSES.safeVault;
  try {
    return getAddress(data.active_safe_address);
  } catch {
    return CONTRACT_ADDRESSES.safeVault;
  }
}

export function useActiveSafeAddress(): Address {
  const { data } = useSWR<Address>("active-safe-address", fetchActiveSafeAddress, { refreshInterval: 60_000 });
  return data ?? CONTRACT_ADDRESSES.safeVault;
}
