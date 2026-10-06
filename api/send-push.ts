import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient } from "@supabase/supabase-js";
import webPush from "web-push";
import { recordSystemError } from "./_telegram.js";

type PushBody = { title?: string; body?: string };
type SubscriptionRow = { user_id: string; endpoint: string; p256dh: string; auth: string };
type PushFailure = { endpoint: string; statusCode: number | null; message: string };

async function json(response: ServerResponse, status: number, payload: unknown) {
  if (status >= 500) {
    const body = payload && typeof payload === "object" ? payload as { error?: unknown } : {};
    await recordSystemError("api/send_push", String(body.error ?? `HTTP ${status}`), { status })
      .catch((error) => console.error("[telegram] Push API error alert failed", error instanceof Error ? error.message : "unknown error"));
  }
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

async function readBody(request: IncomingMessage) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 16_384) throw new Error("Payload too large");
  }
  return JSON.parse(raw || "{}") as PushBody;
}

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return json(response, 405, { error: "Method not allowed" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const publicKey = process.env.VITE_VAPID_PUBLIC_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!supabaseUrl || !serviceKey || !privateKey || !publicKey || !subject) {
    return json(response, 503, { error: "Push service is not configured" });
  }

  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return json(response, 401, { error: "Authentication required" });

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return json(response, 401, { error: "Invalid session" });

  const { data: profile } = await admin
    .from("profiles")
    .select("agency_role,role")
    .eq("id", authData.user.id)
    .single();
  if (
    !["admin", "super_admin", "管理員"].includes(profile?.agency_role ?? "") &&
    !["admin", "super_admin"].includes(profile?.role ?? "")
  ) {
    return json(response, 403, { error: "Admin access required" });
  }

  let input: PushBody;
  try {
    input = await readBody(request);
  } catch {
    return json(response, 400, { error: "Invalid request body" });
  }
  const title = input.title?.trim().slice(0, 120);
  const body = input.body?.trim().slice(0, 500);
  if (!title || !body) {
    return json(response, 400, { error: "Push title and body are required" });
  }

  webPush.setVapidDetails(subject, publicKey, privateKey);
  const { data: subscriptions, error: subscriptionsError } = await admin
    .from("push_subscriptions")
    .select("user_id,endpoint,p256dh,auth");
  if (subscriptionsError) return json(response, 500, { error: "Unable to load subscriptions" });

  const pushId = crypto.randomUUID();
  const payload = JSON.stringify({
    pushId,
    title,
    body,
    icon: "/pwa-192x192.png",
    badge: "/pwa-192x192.png",
    tag: `background-push-${pushId}`,
    url: "/?page=home",
  });
  const targetCount = subscriptions?.length ?? 0;
  const subscriberCount = new Set((subscriptions as SubscriptionRow[]).map((item) => item.user_id)).size;
  const staleEndpoints: string[] = [];
  const failures: PushFailure[] = [];
  let sent = 0;
  await Promise.all((subscriptions as SubscriptionRow[]).map(async (subscription) => {
    try {
      await webPush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      }, payload, { TTL: 3600, urgency: "high" });
      sent += 1;
    } catch (error) {
      const pushError = error as { statusCode?: number; message?: string };
      const statusCode = pushError.statusCode ?? null;
      if (statusCode === 404 || statusCode === 410) staleEndpoints.push(subscription.endpoint);
      failures.push({
        endpoint: subscription.endpoint,
        statusCode,
        message: pushError.message ?? "Unknown push service error",
      });
    }
  }));
  const failed = failures.length;
  if (failed > 0) {
    await recordSystemError("web_push_delivery", `${failed} of ${targetCount} push deliveries failed`, { failed, target_count: targetCount })
      .catch((error) => console.error("[telegram] Push delivery alert failed", error instanceof Error ? error.message : "unknown error"));
  }

  let removed = 0;
  if (staleEndpoints.length) {
    const { error: deleteError } = await admin
      .from("push_subscriptions")
      .delete()
      .in("endpoint", staleEndpoints);
    if (!deleteError) removed = staleEndpoints.length;
  }

  const { data: log, error: logError } = await admin.from("background_push_logs").insert({
    title,
    body,
    sent_count: sent,
    failed_count: failed,
    removed_count: removed,
    target_count: targetCount,
    subscriber_count: subscriberCount,
    sent_by: authData.user.id,
  }).select("id,title,body,sent_count,failed_count,removed_count,target_count,subscriber_count,created_at").single();
  if (logError) {
    console.error("[v0] Failed to save background push log:", logError.message);
    return json(response, 500, {
      error: "Push delivered but the delivery record could not be saved",
      subscriberCount,
      targetCount,
      sent,
      failed,
      removed,
    });
  }

  return json(response, 200, {
    targetCount,
    sent,
    failed,
    removed,
    log,
    failureSummary: failures.slice(0, 3).map((failure) => ({
      statusCode: failure.statusCode,
      message: failure.message,
    })),
  });
}
