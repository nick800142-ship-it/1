import { supabase } from "@/lib/supabase";

export type PushPermissionState = "unsupported" | NotificationPermission;

const publicVapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

function decodeVapidKey(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}

export function getPushPermission(): PushPermissionState {
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

export async function registerPushSubscription(requestPermission = true) {
  if (getPushPermission() === "unsupported") {
    return { ok: false, permission: "unsupported" as const, message: "此瀏覽器不支援系統推播通知。" };
  }
  if (!publicVapidKey) {
    return { ok: false, permission: Notification.permission, message: "推播服務尚未完成設定。" };
  }

  let permission = Notification.permission;
  if (permission === "default" && requestPermission) {
    try {
      permission = await Notification.requestPermission();
    } catch {
      return {
        ok: false,
        permission,
        message: "瀏覽器需要您在設定頁點擊開關後，才能啟用通知。",
      };
    }
  }
  if (permission !== "granted") {
    return {
      ok: false,
      permission,
      message: permission === "denied"
        ? "通知權限已被瀏覽器封鎖，請從網址列的網站設定手動允許通知。"
        : "請點擊啟用通知並允許瀏覽器權限。",
    };
  }

  let subscription: PushSubscription;
  try {
    const registration = await navigator.serviceWorker.register("/push-sw.js");
    await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    subscription = existing ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeVapidKey(publicVapidKey),
    });
  } catch {
    return {
      ok: false,
      permission,
      message: "無法啟用背景推播。iPhone／iPad 請先將網站加入主畫面後重試。",
    };
  }
  const json = subscription.toJSON();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    return { ok: false, permission, message: "無法建立推播訂閱，請重新登入後再試。" };
  }
  const { error } = await supabase.from("push_subscriptions").upsert({
    user_id: user.id,
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    user_agent: navigator.userAgent,
    updated_at: new Date().toISOString(),
  }, { onConflict: "endpoint" });
  return error
    ? { ok: false, permission, message: "推播訂閱儲存失敗，請稍後再試。" }
    : { ok: true, permission, message: "系統推播與提示音已開啟。" };
}

export async function disablePushSubscription() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    await supabase.from("push_subscriptions").delete().eq("endpoint", subscription.endpoint);
    await subscription.unsubscribe();
  } catch {
    // A stale or unavailable service worker should not break notification settings.
  }
}

export function playNotificationSound() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(1320, context.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.2);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.21);
    oscillator.addEventListener("ended", () => void context.close());
  } catch {
    // Autoplay restrictions may block audio until the user interacts with the page.
  }
}

export function showSystemNotification(title: string, body: string) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, icon: "/pwa-192x192.png", tag: `announcement-${title}` });
  } catch {
    // Some mobile browsers only allow notifications through the service worker.
  }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
