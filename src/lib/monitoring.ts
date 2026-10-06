import { supabase } from "@/lib/supabase";

type MonitorEvent =
  | { type: "global_error"; message: string; source: string; metadata?: Record<string, unknown> }
  | {
      type: "trade_result";
      success: boolean;
      message?: string;
      action?: string;
      assetId?: string;
      assetName?: string;
      quantity?: number;
      amount?: number;
    }
  | { type: "private_sale_complete"; placementId: string }
  | { type: "new_project"; placementId: string }
  | { type: "agency_application"; applicationType: string; name: string; contact: string; notes?: string };

export async function reportMonitorEvent(event: MonitorEvent) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return false;
  const response = await fetch("/api/telegram-monitor", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(event),
  });
  return response.ok;
}

export function reportMonitorEventInBackground(event: MonitorEvent) {
  void reportMonitorEvent(event).catch(() => undefined);
}
