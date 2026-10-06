import type { SupabaseClient } from "@supabase/supabase-js";
import { getHotWalletShareBalance, getVaultStatus } from "./_onchain.js";
import { getAdminClient, recordSystemError, sendTelegramMessage } from "./_telegram.js";

const AE_THRESHOLD = 500;
const RWA_THRESHOLD = 500;
const JC_THRESHOLD = 10_000;
const STATE_KEY = "hot_wallet_inventory_alerts";

type InventoryState = { alerts?: Record<string, boolean> };
type Placement = { id: string; name: string; token_address: string };

const quantity = (value: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("鏈上餘額不是有效數字");
  return parsed;
};

export async function monitorHotWalletInventory(admin: SupabaseClient = getAdminClient()) {
  const [jc, ae, placementsResult, previousResult] = await Promise.all([
    getVaultStatus("jcToken"),
    getVaultStatus("aeToken"),
    admin
      .from("private_placements")
      .select("id,name,token_address")
      .eq("is_active", true)
      .eq("is_delisted", false)
      .eq("is_ae_token", false)
      .not("token_address", "is", null)
      .neq("token_address", "0x0000000000000000000000000000000000000000"),
    admin.from("system_monitor_state").select("value").eq("key", STATE_KEY).maybeSingle(),
  ]);

  if (placementsResult.error) throw new Error(`讀取 RWA 標的清單失敗：${placementsResult.error.message}`);
  if (previousResult.error) throw new Error(`讀取熱錢包告警狀態失敗：${previousResult.error.message}`);

  const placements = (placementsResult.data ?? []) as Placement[];
  const rwaBalances: Array<{ id: string; name: string; balance: number }> = [];
  for (let offset = 0; offset < placements.length; offset += 10) {
    const batch = placements.slice(offset, offset + 10);
    const results = await Promise.all(batch.map(async (placement) => ({
      id: placement.id,
      name: placement.name,
      balance: quantity((await getHotWalletShareBalance(placement.token_address)).balanceFormatted),
    })));
    rwaBalances.push(...results);
  }

  const currentAlerts: Record<string, boolean> = {
    jc: quantity(jc.balanceFormatted) < JC_THRESHOLD,
    ae: quantity(ae.balanceFormatted) < AE_THRESHOLD,
  };
  for (const placement of rwaBalances) {
    currentAlerts[`rwa:${placement.id}`] = placement.balance < RWA_THRESHOLD;
  }

  const previous = (previousResult.data?.value ?? {}) as InventoryState;
  const previousAlerts = previous.alerts ?? {};
  const notifications: string[] = [];

  if (currentAlerts.jc && previousAlerts.jc !== true) {
    notifications.push(`JC 熱錢包餘額低於 ${JC_THRESHOLD.toLocaleString("zh-TW")}：目前 ${quantity(jc.balanceFormatted).toLocaleString("zh-TW", { maximumFractionDigits: 6 })} JC`);
  }
  if (currentAlerts.ae && previousAlerts.ae !== true) {
    notifications.push(`AE 熱錢包餘額低於 ${AE_THRESHOLD}：目前 ${quantity(ae.balanceFormatted).toLocaleString("zh-TW", { maximumFractionDigits: 6 })} AE`);
  }
  for (const placement of rwaBalances) {
    if (currentAlerts[`rwa:${placement.id}`] && previousAlerts[`rwa:${placement.id}`] !== true) {
      notifications.push(`RWA「${placement.name}」熱錢包份額低於 ${RWA_THRESHOLD}：目前 ${placement.balance.toLocaleString("zh-TW", { maximumFractionDigits: 6 })} 份`);
    }
  }

  if (notifications.length) {
    let message = "熱錢包庫存低額提醒";
    for (const notification of notifications) {
      if (message.length + notification.length + 1 > 3500) {
        await sendTelegramMessage(message);
        message = "熱錢包庫存低額提醒（續）";
      }
      message += `\n${notification}`;
    }
    await sendTelegramMessage(message);
  }

  const { error: stateError } = await admin.from("system_monitor_state").upsert({
    key: STATE_KEY,
    value: { alerts: currentAlerts, checked_at: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  });
  if (stateError) throw new Error(`保存熱錢包告警狀態失敗：${stateError.message}`);

  return {
    checked: 2 + rwaBalances.length,
    alerts: notifications.length,
    jc: jc.balanceFormatted,
    ae: ae.balanceFormatted,
    rwa: rwaBalances.length,
  };
}

export async function maybeMonitorHotWalletInventory(admin: SupabaseClient) {
  try {
    const { data, error } = await admin.rpc("claim_sweep_slot", {
      p_key: "hot-wallet-inventory",
      p_min_interval_seconds: 900,
    });
    if (error || data !== true) return { skipped: true };
    return await monitorHotWalletInventory(admin);
  } catch (error) {
    await recordSystemError(
      "hot_wallet_inventory_monitor",
      error instanceof Error ? error.message : String(error),
    ).catch((notificationError) => {
      console.error("[telegram] Hot-wallet monitor alert failed", notificationError instanceof Error ? notificationError.message : "unknown error");
    });
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
