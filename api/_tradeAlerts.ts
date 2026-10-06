import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendTelegramMessage } from "./_telegram.js";

export const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const RECENT_FAILURE_LIMIT = 5;
const SUPPRESS_WINDOW_MS = 60_000;

// 已經發過「詳細交割失敗」告警的錯誤訊息；relayer 的 json() 會用它略過同一錯誤的
// 籠統「系統錯誤通知」，避免同一筆失敗在群組裡出現兩則。
const recentlyAlerted = new Map<string, number>();

export function markOpsAlerted(message: string) {
  if (message) recentlyAlerted.set(message.slice(0, 500), Date.now());
}

export function wasOpsAlerted(text: string) {
  const now = Date.now();
  for (const [message, at] of recentlyAlerted) {
    if (now - at > SUPPRESS_WINDOW_MS) recentlyAlerted.delete(message);
    else if (text.includes(message)) return true;
  }
  return false;
}

const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

const taipeiTime = () => new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });

export const formatAmount = (value: number) =>
  value.toLocaleString("zh-TW", { maximumFractionDigits: 6 });

type ProfileSummary = { email: string | null; wallet_address: string | null };

async function loadProfiles(admin: SupabaseClient, ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const map = new Map<string, ProfileSummary>();
  if (!unique.length) return map;
  const { data } = await admin.from("profiles").select("id,email,wallet_address").in("id", unique);
  for (const row of data ?? []) {
    map.set(row.id as string, { email: row.email as string | null, wallet_address: row.wallet_address as string | null });
  }
  return map;
}

export function describeUser(profile: ProfileSummary | undefined, userId: string) {
  const name = profile?.email || `用戶 ${userId.slice(0, 8)}`;
  return profile?.wallet_address ? `${name}（錢包 ${profile.wallet_address}）` : `${name}（未綁定錢包）`;
}

async function resolveAssetName(admin: SupabaseClient, assetId?: string | null, assetToken?: string | null) {
  if (assetId) {
    const { data } = await admin.from("private_placements").select("name").eq("id", assetId).maybeSingle();
    return data?.name ? `${data.name}（${assetId}）` : assetId;
  }
  if (assetToken) {
    const { data } = await admin.from("private_placements").select("id,name").ilike("token_address", assetToken).maybeSingle();
    if (data) return `${data.name}（${data.id}）`;
    return `代幣 ${assetToken}`;
  }
  return null;
}

// 以 event_key 做冪等：同一個 key 只會成功通知一次；先前通知失敗的才會重送。
async function sendDedupedOpsAlert(
  admin: SupabaseClient,
  eventType: string,
  eventKey: string,
  text: string,
  metadata: Record<string, unknown>,
  severity: "critical" | "info" = "critical",
) {
  let eventId: string | null = null;
  const { data: inserted, error } = await admin.from("system_monitor_events").insert({
    event_type: eventType,
    event_key: eventKey.slice(0, 240),
    severity,
    message: text.slice(0, 1000),
    metadata: { ...metadata, notification_status: "pending" },
  }).select("id").maybeSingle();

  if (error?.code === "23505") {
    const { data: existing } = await admin.from("system_monitor_events")
      .select("id,metadata")
      .eq("event_key", eventKey.slice(0, 240))
      .maybeSingle();
    if (!existing || (existing.metadata as Record<string, unknown> | null)?.notification_status !== "failed") {
      return { sent: false, duplicate: true };
    }
    eventId = existing.id as string;
  } else if (error) {
    console.error("[alerts] monitor event insert failed", error.message);
  } else {
    eventId = inserted?.id ?? null;
  }

  try {
    await sendTelegramMessage(text);
    if (eventId) {
      await admin.from("system_monitor_events").update({ metadata: { ...metadata, notification_status: "sent" } }).eq("id", eventId);
    }
    return { sent: true, duplicate: false };
  } catch (sendError) {
    if (eventId) {
      await admin.from("system_monitor_events").update({ metadata: { ...metadata, notification_status: "failed" } }).eq("id", eventId);
    }
    throw sendError;
  }
}

export type SettlementFailureInput = {
  kind: string;
  refKey: string;
  stage: string;
  error: string;
  userId?: string | null;
  userRole?: string;
  counterpartyId?: string | null;
  counterpartyRole?: string;
  assetId?: string | null;
  assetToken?: string | null;
  assetName?: string | null;
  deliverable?: string;
  quantity?: number | null;
  quantityUnit?: string;
  jcAmount?: number | null;
  usdtAmount?: number | null;
  txHash?: string | null;
  remedy?: string;
};

export async function alertSettlementFailure(admin: SupabaseClient, input: SettlementFailureInput) {
  const error = String(input.error || "未知錯誤").slice(0, 600);
  markOpsAlerted(error);
  try {
    const profiles = await loadProfiles(admin, [input.userId, input.counterpartyId]);
    const assetLabel = input.assetName ?? (await resolveAssetName(admin, input.assetId, input.assetToken));
    const lines = [
      "交割失敗通知",
      `類型：${input.kind}`,
      `失敗階段：${input.stage}`,
    ];
    if (input.userId) lines.push(`${input.userRole ?? "用戶"}：${describeUser(profiles.get(input.userId), input.userId)}`);
    if (input.counterpartyId) {
      lines.push(`${input.counterpartyRole ?? "對手方"}：${describeUser(profiles.get(input.counterpartyId), input.counterpartyId)}`);
    }
    if (input.deliverable) lines.push(`交割項目：${input.deliverable}`);
    if (assetLabel) lines.push(`標的：${assetLabel}`);
    if (input.quantity != null && Number.isFinite(input.quantity)) {
      lines.push(`數量：${formatAmount(input.quantity)} ${input.quantityUnit ?? "份"}`);
    }
    if (input.jcAmount != null && Number.isFinite(input.jcAmount)) lines.push(`金額：${formatAmount(input.jcAmount)} JC`);
    if (input.usdtAmount != null && Number.isFinite(input.usdtAmount)) lines.push(`USDT：${formatAmount(input.usdtAmount)} USDT`);
    lines.push(`錯誤原因：${error}`);
    lines.push(`結算編號：${input.refKey}`);
    if (input.txHash) lines.push(`交易雜湊：${input.txHash}`);
    lines.push(`時間：${taipeiTime()}`);
    lines.push(`處理方式：${input.remedy ?? "後台「鏈上結算與贖回審核」可一鍵補發；系統也會自動重試"}`);

    return await sendDedupedOpsAlert(
      admin,
      "settlement_failure",
      `settlement_failed:${input.refKey}:${fingerprint(`${input.stage}:${error}`)}`,
      lines.join("\n"),
      {
        kind: input.kind,
        ref_key: input.refKey,
        stage: input.stage,
        user_id: input.userId ?? null,
        counterparty_id: input.counterpartyId ?? null,
        asset_id: input.assetId ?? null,
        quantity: input.quantity ?? null,
        jc_amount: input.jcAmount ?? null,
        tx_hash: input.txHash ?? null,
      },
    );
  } catch (alertError) {
    console.error("[alerts] settlement failure alert failed", alertError instanceof Error ? alertError.message : alertError);
    return { sent: false, error: true };
  }
}

export async function alertSettlementRecovery(
  admin: SupabaseClient,
  input: { refKey: string; txHash?: string | null; previousFailure: string; userId?: string | null },
) {
  try {
    const profiles = await loadProfiles(admin, [input.userId]);
    const lines = [
      "交割恢復通知",
      `結算編號：${input.refKey}`,
      ...(input.userId ? [`用戶：${describeUser(profiles.get(input.userId), input.userId)}`] : []),
      `先前錯誤：${String(input.previousFailure).slice(0, 400)}`,
      ...(input.txHash ? [`確認交易：${input.txHash}`] : []),
      `時間：${taipeiTime()}`,
      "處理結果：已完成鏈上確認與正式帳本同步。",
    ];
    const failureKey = fingerprint(input.previousFailure);
    return await sendDedupedOpsAlert(
      admin,
      "settlement_recovered",
      `settlement_recovered:${input.refKey}:${failureKey}`,
      lines.join("\n"),
      {
        ref_key: input.refKey,
        user_id: input.userId ?? null,
        tx_hash: input.txHash ?? null,
      },
      "info",
    );
  } catch (error) {
    console.error("[alerts] settlement recovery alert failed", error instanceof Error ? error.message : error);
    return { sent: false, error: true };
  }
}

export type TradeFailureContext = {
  message?: string;
  action?: string;
  assetId?: string;
  assetName?: string;
  quantity?: number;
  amount?: number;
};

type FailureEntry = TradeFailureContext & { at: string };
type UserFailureState = { count: number; streak_started_at: string | null; recent: FailureEntry[] };

const cleanText = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
const cleanNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1e15 ? value : undefined;

export function sanitizeTradeFailureContext(raw: Record<string, unknown>): TradeFailureContext {
  return {
    message: cleanText(raw.message, 500),
    action: cleanText(raw.action, 40),
    assetId: cleanText(raw.assetId, 80),
    assetName: cleanText(raw.assetName, 80),
    quantity: cleanNumber(raw.quantity),
    amount: cleanNumber(raw.amount),
  };
}

export function formatFailureEntry(entry: FailureEntry, index: number) {
  const time = new Date(entry.at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  const parts = [`${index + 1}. ${time}`, entry.action ?? "交易"];
  if (entry.assetName || entry.assetId) parts.push(entry.assetName ?? entry.assetId!);
  if (entry.quantity != null) parts.push(`${formatAmount(entry.quantity)} 份`);
  if (entry.amount != null) parts.push(`${formatAmount(entry.amount)} JC`);
  return `${parts.join("｜")}\n   錯誤：${entry.message ?? "未提供錯誤訊息"}`;
}

// 每位用戶各自累計連續失敗；成功一次即歸零。每累積到 3 的倍數才告警一次，
// 避免同一用戶持續失敗時每一次都洗版。
export async function recordUserTradeResult(
  admin: SupabaseClient,
  userId: string,
  success: boolean,
  context: TradeFailureContext = {},
) {
  const key = `trade_failures:user:${userId}`;
  const { data } = await admin.from("system_monitor_state").select("value").eq("key", key).maybeSingle();
  const previous = (data?.value ?? null) as UserFailureState | null;
  const now = new Date().toISOString();

  if (success) {
    if (previous && previous.count > 0) {
      await admin.from("system_monitor_state").upsert({
        key,
        value: { count: 0, streak_started_at: null, recent: [] },
        updated_at: now,
      });
    }
    return { count: 0, alerted: false };
  }

  const count = (previous?.count ?? 0) + 1;
  const streakStartedAt = previous?.count ? previous.streak_started_at ?? now : now;
  const recent = [...(previous?.recent ?? []), { ...context, at: now }].slice(-RECENT_FAILURE_LIMIT);
  const { error: stateError } = await admin.from("system_monitor_state").upsert({
    key,
    value: { count, streak_started_at: streakStartedAt, recent },
    updated_at: now,
  });
  if (stateError) throw stateError;

  if (count % CONSECUTIVE_FAILURE_THRESHOLD !== 0) return { count, alerted: false };

  const profiles = await loadProfiles(admin, [userId]);
  const lastFailures = recent.slice(-CONSECUTIVE_FAILURE_THRESHOLD);
  const text = [
    "用戶連續交易失敗通知",
    `用戶：${describeUser(profiles.get(userId), userId)}`,
    `連續失敗：${count} 次（自 ${new Date(streakStartedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })} 起）`,
    "最近失敗紀錄：",
    ...lastFailures.map(formatFailureEntry),
    `時間：${taipeiTime()}`,
    "建議：到後台用戶詳細紀錄確認該用戶餘額、授權與標的狀態",
  ].join("\n");

  const result = await sendDedupedOpsAlert(
    admin,
    "user_trade_failures",
    `user_trade_failures:${userId}:${streakStartedAt}:${count}`,
    text,
    { user_id: userId, consecutive_failure_count: count },
  );
  return { count, alerted: result.sent };
}
