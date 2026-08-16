import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient } from "@supabase/supabase-js";
import webPush from "web-push";

type PushBody = { announcementId?: string; title?: string; body?: string };
type SubscriptionRow = { endpoint: string; p256dh: string; auth: string };

function json(response: ServerResponse, status: number, payload: unknown) {
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
  const subject = process.env.VAPID_SUBJECT;
  if (!supabaseUrl || !serviceKey || !privateKey || !subject) {
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
    .select("agency_role")
    .eq("id", authData.user.id)
    .single();
  if (!["admin", "管理員"].includes(profile?.agency_role ?? "")) {
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
  if (!input.announcementId || !title || !body) {
    return json(response, 400, { error: "Announcement id, title and body are required" });
  }

  const { data: announcement } = await admin
    .from("platform_announcements")
    .select("id")
    .eq("id", input.announcementId)
    .single();
  if (!announcement) return json(response, 404, { error: "Announcement not found" });

  webPush.setVapidDetails(subject, process.env.VITE_VAPID_PUBLIC_KEY ?? "", privateKey);
  const { data: subscriptions, error: subscriptionsError } = await admin
    .from("push_subscriptions")
    .select("endpoint,p256dh,auth");
  if (subscriptionsError) return json(response, 500, { error: "Unable to load subscriptions" });

  const payload = JSON.stringify({
    announcementId: input.announcementId,
    title,
    body,
    icon: "/pwa-192x192.png",
    badge: "/pwa-192x192.png",
    tag: `announcement-${input.announcementId}`,
    url: "/?page=home",
  });
  const staleEndpoints: string[] = [];
  let sent = 0;
  let failed = 0;
  await Promise.all((subscriptions as SubscriptionRow[]).map(async (subscription) => {
    try {
      await webPush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      }, payload, { TTL: 3600, urgency: "high" });
      sent += 1;
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) staleEndpoints.push(subscription.endpoint);
      failed += 1;
    }
  }));

  if (staleEndpoints.length) {
    await admin.from("push_subscriptions").delete().in("endpoint", staleEndpoints);
  }
  await admin
    .from("platform_announcements")
    .update({ background_push: true })
    .eq("id", input.announcementId);

  return json(response, 200, { sent, failed, removed: staleEndpoints.length });
}
