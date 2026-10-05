import { useState } from "react";
import useSWR from "swr";
import { Link2, RefreshCw, Send, Unlink } from "lucide-react";
import { supabase } from "@/lib/supabase";

type PreferenceKey =
  | "market_alerts_enabled"
  | "commission_updates_enabled"
  | "order_partial_fills_enabled"
  | "order_completed_enabled";

type TelegramAccount = {
  linked: boolean;
  telegramUsername: string | null;
  linkedAt: string | null;
  botUsername: string | null;
  preferences: Record<PreferenceKey, boolean>;
};

type TelegramLinkResponse = { linkUrl: string; expiresAt: string };

const preferenceOptions: { key: PreferenceKey; zh: string; en: string }[] = [
  { key: "market_alerts_enabled", zh: "市場與價格通知", en: "Market and price alerts" },
  { key: "commission_updates_enabled", zh: "收益分配通知", en: "Commission updates" },
  { key: "order_partial_fills_enabled", zh: "二級市場部分成交", en: "Partial order fills" },
  { key: "order_completed_enabled", zh: "掛單完成通知", en: "Order completed" },
];

async function telegramRequest<T>(body?: Record<string, unknown>): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("登入狀態已失效，請重新登入。");
  const response = await fetch("/api/telegram-account", {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(result.error || "Telegram 設定暫時無法處理，請稍後再試。");
  return result;
}

export function TelegramAccountSettings({ userId, language }: { userId: string; language: string }) {
  const zh = language === "zh-TW" || language === "zh-CN";
  const { data, error, isLoading, mutate } = useSWR<TelegramAccount>(
    userId ? `telegram-account:${userId}` : null,
    () => telegramRequest<TelegramAccount>(),
    { revalidateOnFocus: true, shouldRetryOnError: false },
  );
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [linkExpiresAt, setLinkExpiresAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savingPreference, setSavingPreference] = useState<PreferenceKey | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);

  const createLink = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await telegramRequest<TelegramLinkResponse>({ action: "create_link" });
      setLinkUrl(result.linkUrl);
      setLinkExpiresAt(result.expiresAt);
      setConfirmUnlink(false);
    } catch (requestError) {
      setNotice({ text: requestError instanceof Error ? requestError.message : "Telegram 綁定連結建立失敗。", error: true });
    } finally {
      setBusy(false);
    }
  };

  const refreshLink = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const latest = await mutate();
      if (latest?.linked) {
        setLinkUrl(null);
        setLinkExpiresAt(null);
        setConfirmUnlink(false);
        setNotice({ text: zh ? "Telegram 已成功連結。" : "Telegram is connected." });
      } else {
        setNotice({ text: zh ? "尚未偵測到完成綁定，請在 Telegram 按下 Start 後再試。" : "Connection is not complete yet. Tap Start in Telegram, then check again.", error: true });
      }
    } catch {
      setNotice({ text: zh ? "狀態更新失敗，請稍後重試。" : "Could not refresh the connection status.", error: true });
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await telegramRequest({ action: "unlink" });
      await mutate();
      setLinkUrl(null);
      setLinkExpiresAt(null);
      setConfirmUnlink(false);
      setNotice({ text: zh ? "Telegram 已解除連結。" : "Telegram has been disconnected." });
    } catch (requestError) {
      setNotice({ text: requestError instanceof Error ? requestError.message : "Telegram 解除連結失敗。", error: true });
    } finally {
      setBusy(false);
    }
  };

  const togglePreference = async (key: PreferenceKey) => {
    if (!data?.linked || savingPreference) return;
    setSavingPreference(key);
    setNotice(null);
    try {
      await telegramRequest({ action: "preferences", preferences: { [key]: !data.preferences[key] } });
      await mutate();
    } catch (requestError) {
      setNotice({ text: requestError instanceof Error ? requestError.message : "通知設定儲存失敗。", error: true });
    } finally {
      setSavingPreference(null);
    }
  };

  return (
    <div className="border-b border-slate-800 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="rounded-xl bg-sky-500/10 p-2.5 text-sky-300" aria-hidden="true">
            <Send className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium">Telegram 通知</h3>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${data?.linked ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-800 text-slate-400"}`}>
                {isLoading ? (zh ? "載入中" : "Loading") : error ? (zh ? "無法讀取" : "Unavailable") : data?.linked ? (zh ? "已連結" : "Connected") : (zh ? "未連結" : "Not connected")}
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              {data?.linked
                ? data.telegramUsername ? `@${data.telegramUsername}` : (zh ? "已連結 Telegram 私人帳號" : "A Telegram account is connected")
                : (zh ? "連結 Telegram 後，可在 Telegram 接收帳戶與資產通知。" : "Connect Telegram to receive account and asset alerts there.")}
            </p>
            {data?.linkedAt && <p className="mt-1 text-xs text-slate-500">{zh ? "連結時間：" : "Connected: "}{new Date(data.linkedAt).toLocaleString(language)}</p>}
            {error && <p role="alert" className="mt-2 text-xs text-rose-300">{zh ? "無法讀取 Telegram 設定，請重新整理或稍後再試。" : "Could not load Telegram settings. Please retry."}</p>}
            {!isLoading && !error && !data?.botUsername && <p role="status" className="mt-2 text-xs text-amber-300">{zh ? "Telegram Bot 尚未完成設定，目前無法建立連結。" : "The Telegram bot is not configured, so a link cannot be created yet."}</p>}
          </div>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <button
            type="button"
            onClick={() => void createLink()}
            disabled={busy || isLoading || Boolean(error) || !data?.botUsername}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-sky-400/30 bg-sky-500/10 px-4 py-2.5 text-sm font-semibold text-sky-200 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
          >
            <Link2 className="size-4" />
            {busy ? (zh ? "處理中…" : "Working…") : data?.linked ? (zh ? "更換 Telegram" : "Change Telegram") : (zh ? "連結 Telegram" : "Connect Telegram")}
          </button>
          {data?.linked && !confirmUnlink && (
            <button
              type="button"
              onClick={() => setConfirmUnlink(true)}
              disabled={busy}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 px-4 py-2.5 text-sm text-slate-300 transition hover:bg-slate-800 disabled:opacity-50"
            >
              <Unlink className="size-4" />
              {zh ? "解除連結" : "Disconnect"}
            </button>
          )}
        </div>
      </div>

      {linkUrl && (
        <div className="mt-4 rounded-xl border border-sky-400/20 bg-sky-500/5 p-4">
          <p className="text-sm font-medium text-slate-200">
            {zh ? "請使用要綁定的 Telegram 帳號開啟連結，並在 Bot 對話中按下 Start。" : "Open this link with the Telegram account you want to connect, then tap Start in the bot chat."}
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-400">
            {zh ? "完成驗證後，新帳號會取代目前連結；若該 Telegram 已屬於其他平台帳號，原帳號也會解除連結。連結 10 分鐘後失效。" : "After verification, this replaces the current connection. If this Telegram account belongs to another platform account, that connection will also be removed. Link expires in 10 minutes."}
            {linkExpiresAt ? ` ${zh ? "到期時間：" : "Expires: "}${new Date(linkExpiresAt).toLocaleTimeString(language)}` : ""}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={linkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-sky-400 px-4 py-2 text-sm font-bold text-slate-950 transition hover:bg-sky-300"
            >
              <Send className="size-4" />
              {zh ? "開啟 Telegram 完成綁定" : "Open Telegram to connect"}
            </a>
            <button
              type="button"
              onClick={() => void refreshLink()}
              disabled={busy}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              <RefreshCw className="size-4" />
              {zh ? "我已完成，檢查狀態" : "I finished, check status"}
            </button>
          </div>
        </div>
      )}

      {confirmUnlink && (
        <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
          <p className="text-sm text-amber-100">{zh ? "解除後，這個平台帳號將不再透過 Telegram 接收通知；之後仍可重新連結。" : "Disconnecting stops Telegram notifications for this platform account. You can reconnect later."}</p>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => void unlink()} disabled={busy} className="rounded-lg bg-rose-500/15 px-4 py-2 text-sm font-semibold text-rose-200 hover:bg-rose-500/25 disabled:opacity-50">{zh ? "確認解除" : "Confirm disconnect"}</button>
            <button type="button" onClick={() => setConfirmUnlink(false)} disabled={busy} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50">{zh ? "取消" : "Cancel"}</button>
          </div>
        </div>
      )}

      {data?.linked && (
        <div className="mt-5 border-t border-slate-800 pt-4">
          <p className="text-sm font-medium">{zh ? "Telegram 通知類型" : "Telegram notification types"}</p>
          <p className="mt-1 text-xs text-slate-500">{zh ? "各項通知可獨立開關，變更會立即儲存。" : "Control each notification independently. Changes save immediately."}</p>
          <div className="mt-2 divide-y divide-slate-800/80">
            {preferenceOptions.map(({ key, zh: labelZh, en: labelEn }) => (
              <div key={key} className="flex items-center justify-between gap-4 py-3">
                <span className="text-sm text-slate-300">{zh ? labelZh : labelEn}</span>
                <button
                  type="button"
                  role="switch"
                  aria-label={zh ? labelZh : labelEn}
                  aria-checked={data.preferences[key]}
                  disabled={savingPreference !== null}
                  onClick={() => void togglePreference(key)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${data.preferences[key] ? "bg-sky-400" : "bg-slate-700"} disabled:cursor-wait disabled:opacity-60`}
                >
                  <span className={`absolute top-1 size-4 rounded-full bg-white transition ${data.preferences[key] ? "left-6" : "left-1"}`} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {notice && <p role="status" className={`mt-3 rounded-lg border px-3 py-2 text-sm ${notice.error ? "border-rose-500/20 bg-rose-500/5 text-rose-200" : "border-emerald-500/20 bg-emerald-500/5 text-emerald-200"}`}>{notice.text}</p>}
    </div>
  );
}

export default TelegramAccountSettings;
