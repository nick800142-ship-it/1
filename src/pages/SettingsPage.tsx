import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { usePrivy } from "@privy-io/react-auth";
import {
  Bell,
  Check,
  ChevronRight,
  Globe,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  Palette,
  ShieldCheck,
  Sun,
  UserPlus,
  UserRound,
} from "lucide-react";
import { interfaceText, LANGUAGES, useLanguage, useTheme, type ColorMode } from "@/platform";
import { Modal } from "@/components/Modal";
import { useUserPreferences } from "@/contexts/UserPreferences";
import { supabase } from "@/lib/supabase";
import { reportMonitorEventInBackground } from "@/lib/monitoring";
import {
  getPushPermission,
  type PushPermissionState,
} from "@/lib/pushNotifications";

export function SettingsPage({ sessionUser }: { sessionUser: User }) {
  const { logout: privyLogout } = usePrivy();
  const { t, tr, language } = useLanguage();
  const {
    preferences,
    saveStatus,
    setLanguagePreference,
    setThemePreference,
    setAccentPreference,
    setPushPreference,
    setAlertPreference,
  } = useUserPreferences();
  const [user, setUser] = useState<User>(sessionUser);
  useEffect(() => {
    let active = true;
    void supabase.auth.getUser().then(({ data }) => {
      if (active && data.user) setUser(data.user);
    });
    return () => {
      active = false;
    };
  }, []);
  const { mode, hue, saturation, lightness } = useTheme();
  const [langOpen, setLangOpen] = useState(false);
  const [kycOpen, setKycOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const alerts = {
    price: preferences.price_alerts_enabled,
    dividend: preferences.dividend_alerts_enabled,
    listings: preferences.listings_alerts_enabled,
  };
  const [pushPermission, setPushPermission] = useState<PushPermissionState>(() => getPushPermission());
  const pushEnabled = preferences.browser_push_enabled && pushPermission !== "denied" && pushPermission !== "unsupported";
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMessage, setPushMessage] = useState("");
  const togglePush = async () => {
    if (pushBusy) return;
    setPushBusy(true);
    if (pushEnabled) {
      await setPushPreference(false);
      setPushMessage("此裝置已停止接收背景推播。此偏好會在下次開啟時保留。");
    } else {
      const enabled = await setPushPreference(true);
      const permission = getPushPermission();
      setPushPermission(permission);
      setPushMessage(enabled ? "此裝置已啟用背景推播。" : "尚未取得瀏覽器通知權限，請依提示允許通知。");
    }
    setPushBusy(false);
  };
  const [profile, setProfile] = useState<{
    agency_role: string;
    promo_code: string | null;
    referrer_id: string | null;
    nickname: string | null;
  } | null>(null);
  const [application, setApplication] = useState<{
    status: string;
    requested_role: string;
    rejection_reason: string | null;
  } | null>(null);
  const [nickname, setNickname] = useState("");
  const [savingNickname, setSavingNickname] = useState(false);
  const [bindingCode, setBindingCode] = useState("");
  const [customCode, setCustomCode] = useState("");
  const [agencyOpen, setAgencyOpen] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(
    null,
  );
  const [form, setForm] = useState({
    role: "代理",
    name: "",
    contact: "",
    region: "",
    reason: "",
    masterCode: "",
  });
  const loadAgency = async () => {
    const [p, a] = await Promise.all([
      supabase
        .from("profiles")
        .select("agency_role,promo_code,referrer_id,nickname")
        .eq("id", user.id)
        .single(),
      supabase
        .from("agency_applications")
        .select("status,requested_role,rejection_reason")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    setProfile(p.data);
    setNickname(
      p.data?.nickname?.trim() || user.email?.split("@")[0] || "會員",
    );
    setApplication(a.data);
  };
  useEffect(() => {
    void loadAgency();
  }, [user.id]);
  const saveNickname = async () => {
    const value = nickname.trim();
    if (!value) {
      setMessage({ text: "暱稱不可為空白", ok: false });
      return;
    }
    setSavingNickname(true);
    const { error } = await supabase
      .from("profiles")
      .update({ nickname: value })
      .eq("id", user.id);
    setSavingNickname(false);
    const duplicateNickname = error?.code === "23505";
    setMessage({
      text: duplicateNickname
        ? "此暱稱已被使用，請換一個暱稱"
        : error
          ? "暱稱更新失敗，請稍後再試"
          : "暱稱已成功更新",
      ok: !error,
    });
    if (!error)
      setProfile((current) =>
        current ? { ...current, nickname: value } : current,
      );
  };
  const bindCode = async () => {
    const { error } = await supabase.rpc("bind_referral_code", {
      promo: bindingCode,
    });
    setMessage({
      text: error
        ? "推廣碼無效、已綁定或不可綁定自己"
        : "推廣碼已綁定；如需更正請聯絡 Admin",
      ok: !error,
    });
    if (!error) {
      setBindingCode("");
      await loadAgency();
    }
  };
  const saveCode = async () => {
    const { error } = await supabase.rpc("set_own_promo_code", {
      new_code: customCode.toUpperCase(),
    });
    setMessage({
      text: error ? "推廣碼需為 9 位英數字且不可重複" : "自訂推廣碼已更新",
      ok: !error,
    });
    if (!error) {
      setCustomCode("");
      await loadAgency();
    }
  };
  const apply = async () => {
    const { error } = await supabase.rpc("submit_agency_application", {
      p_role: form.role,
      p_name: form.name,
      p_contact: form.contact,
      p_region: form.region,
      p_reason: form.reason,
      p_master_code: form.role === "代理" ? form.masterCode : null,
    });
    setMessage({
      text: error
        ? "申請未送出，請檢查欄位、上線碼或待審核狀態"
        : "代理申請已送出",
      ok: !error,
    });
    if (!error) {
      reportMonitorEventInBackground({
        type: "agency_application",
        applicationType: form.role === "總代理" ? "總代理" : "一般代理",
        name: form.name,
        contact: form.contact,
        notes: [form.region && `地區：${form.region}`, form.reason].filter(Boolean).join("；") || "無",
      });
      setAgencyOpen(false);
      await loadAgency();
    }
  };
  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    const timeout = new Promise<void>((resolve) =>
      window.setTimeout(resolve, 1500),
    );
    try {
      // Must clear BOTH Supabase and Privy sessions. Supabase alone leaves
      // Privy still authenticated, so the login screen immediately shows
      // the same account as "已成功登入" instead of letting the user pick
      // a different Google/Email account to switch to.
      await Promise.race([
        Promise.all([
          supabase.auth.signOut({ scope: "local" }),
          privyLogout().catch((error) => {
            console.error("[v0] Privy logout failed:", error);
          }),
        ]).then(() => undefined),
        timeout,
      ]);
    } finally {
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index);
        if (key?.startsWith("sb-") && key.endsWith("-auth-token"))
          localStorage.removeItem(key);
      }
      sessionStorage.clear();
      window.location.href = "/";
    }
  };
  const zh = language === "zh-TW" || language === "zh-CN";
  const appearance = interfaceText(language, "appearance");
  const themeLabel = interfaceText(language, "displayMode");
  const colorLabel = interfaceText(language, "accentColor");
  const modeOptions: { value: ColorMode; label: string; icon: typeof Sun }[] = [
    { value: "light", label: zh ? "淺色" : "Light", icon: Sun },
    { value: "dark", label: zh ? "深色" : "Dark", icon: Moon },
    { value: "system", label: zh ? "跟隨系統" : "System", icon: Monitor },
  ];
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">{t("settings")}</h1>
          <p className="mt-2 text-sm text-slate-400">{t("accountSecurity")}</p>
        </div>
        <p
          role="status"
          className={`rounded-full border px-3 py-1 text-xs font-medium ${saveStatus === "error" ? "border-red-500/30 bg-red-500/10 text-red-300" : "border-slate-700 bg-slate-900 text-slate-400"}`}
        >
          {saveStatus === "saving" ? "設定儲存中…" : saveStatus === "error" ? "雲端同步失敗，已保留於此裝置" : saveStatus === "saved" ? "設定已儲存" : "設定會自動儲存"}
        </p>
      </header>
      <Group
        icon={<UserRound />}
        title={interfaceText(language, "accountInformation")}
      >
        <div className="flex flex-col gap-4 p-5">
          <Info label={interfaceText(language, "email")} value={user.email ?? "—"} />
          <Info label={interfaceText(language, "userId")} value={user.id} />
          <label className="flex flex-col gap-2 text-sm text-slate-400">
            <span>{interfaceText(language, "nickname")}</span>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                aria-label={interfaceText(language, "nickname")}
                value={nickname}
                maxLength={40}
                onChange={(event) => setNickname(event.target.value)}
                placeholder={user.email?.split("@")[0] || "會員"}
                className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none transition focus:border-amber-400"
              />
              <button
                type="button"
                onClick={() => void saveNickname()}
                disabled={savingNickname || !nickname.trim()}
                className="rounded-xl bg-amber-400 px-5 py-3 font-bold text-slate-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {savingNickname
                  ? interfaceText(language, "saving")
                  : interfaceText(language, "saveChanges")}
              </button>
            </div>
          </label>
        </div>
      </Group>
      {message && (
        <div
          className={`rounded-xl border p-4 text-sm ${message.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200"}`}
        >
          {message.text}
        </div>
      )}
      <Group icon={<UserPlus />} title={interfaceText(language, "agencyRelationship")}>
        <div className="flex flex-col gap-4 p-5">
          <Info label={interfaceText(language, "currentRole")} value={profile?.agency_role ?? "一般用戶"} />
          {application && (
            <Info
              label="最近申請"
              value={`${application.requested_role} · ${application.status === "pending" ? "審核中" : application.status === "approved" ? "已核准" : "已拒絕"}`}
            />
          )}{" "}
          {!profile?.referrer_id && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                aria-label="上線推廣碼"
                value={bindingCode}
                maxLength={9}
                onChange={(event) =>
                  setBindingCode(event.target.value.toUpperCase())
                }
                placeholder="輸入 9 碼推廣碼"
                className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 font-mono uppercase"
              />
              <button
                onClick={() => void bindCode()}
                className="rounded-xl bg-amber-400 px-5 py-3 font-bold text-slate-950"
              >
                首次綁定
              </button>
            </div>
          )}
          {["代理", "一代代理", "二代代理", "總代理"].includes(
            profile?.agency_role ?? "",
          ) ? (
            <>
              <Info label="我的推廣碼" value={profile?.promo_code ?? "—"} />
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  aria-label="自訂推廣碼"
                  value={customCode}
                  maxLength={9}
                  onChange={(event) =>
                    setCustomCode(
                      event.target.value
                        .toUpperCase()
                        .replace(/[^A-Z0-9]/g, ""),
                    )
                  }
                  placeholder="9 位英數字"
                  className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 font-mono uppercase"
                />
                <button
                  onClick={() => void saveCode()}
                  className="flex items-center justify-center gap-2 rounded-xl border border-amber-500/30 px-5 py-3 font-bold text-amber-300"
                >
                  <KeyRound className="size-4" />
                  更新推廣碼
                </button>
              </div>
            </>
          ) : (
            <button
              onClick={() => setAgencyOpen(true)}
              disabled={application?.status === "pending"}
              className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 font-bold text-amber-300 disabled:opacity-50"
            >
              {application?.status === "pending"
                ? "申請審核中"
                : interfaceText(language, "applyAgency")}
            </button>
          )}
        </div>
      </Group>
      <button
        onClick={() => setKycOpen(true)}
        className="flex w-full items-center gap-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-5 text-left hover:bg-emerald-500/15"
      >
        <span className="rounded-xl bg-emerald-500/15 p-3 text-emerald-400">
          <ShieldCheck className="h-7 w-7" />
        </span>
        <div className="flex-1">
          <p className="text-xs uppercase tracking-wider text-emerald-400">
            {tr("identity")}
          </p>
          <h2 className="mt-1 text-lg font-bold text-white">
            {t("kycPassed")}
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            {tr("level")} 2 · {tr("verifiedDate")} 2026-07-18
          </p>
        </div>
        <ChevronRight className="h-5 w-5 text-slate-400" />
      </button>
      <Group icon={<Palette />} title={appearance}>
        <div className="flex flex-col gap-4 p-5">
          <div>
            <p className="font-medium">{themeLabel}</p>
            <p className="mt-1 text-xs text-slate-500">
              {zh
                ? "立即套用到整個網站"
                : "Applied instantly across the website"}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {modeOptions.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                onClick={() => setThemePreference(value)}
                aria-pressed={mode === value}
                className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-3 text-sm font-medium transition ${mode === value ? "border-amber-400 bg-amber-400/10 text-amber-300" : "border-slate-700 text-slate-400 hover:bg-slate-800"}`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-4 p-5">
          <div>
            <p className="font-medium">{colorLabel}</p>
            <p className="mt-1 text-xs text-slate-500">
              {zh
                ? "選擇按鈕、連結與焦點的顏色"
                : "Choose the color for buttons, links, and focus states"}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-[8rem_1fr] sm:items-center">
            <div
              className="aspect-square rounded-full border border-slate-700 shadow-inner"
              style={{
                background: `hsl(${hue} ${saturation}% ${lightness}%)`,
              }}
              aria-hidden="true"
            />
            <div className="grid gap-4">
              {([
                { key: "hue", label: zh ? "色相" : "Hue", value: hue, min: 0, max: 360 },
                {
                  key: "saturation",
                  label: zh ? "飽和度" : "Saturation",
                  value: saturation,
                  min: 20,
                  max: 100,
                },
                {
                  key: "lightness",
                  label: zh ? "明度" : "Lightness",
                  value: lightness,
                  min: 30,
                  max: 75,
                },
              ] as const).map((control) => (
                <label
                  key={control.key}
                  className="grid gap-2 text-sm text-slate-400"
                >
                  <span className="flex justify-between gap-4">
                    {control.label}
                    <b className="text-slate-100">
                      {control.value}
                      {control.max === 360 ? "°" : "%"}
                    </b>
                  </span>
                  <input
                    type="range"
                    min={control.min}
                    max={control.max}
                    value={control.value}
                    aria-label={control.label}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (!Number.isFinite(value)) return;
                      setAccentPreference(
                        control.key === "hue" ? value : hue,
                        control.key === "saturation" ? value : saturation,
                        control.key === "lightness" ? value : lightness,
                      );
                    }}
                    className="w-full accent-[var(--accent)]"
                  />
                </label>
              ))}
            </div>
          </div>
        </div>
      </Group>
      <Group icon={<Globe />} title={tr("preferences")}>
        <button
          onClick={() => setLangOpen(true)}
          className="flex w-full items-center justify-between p-5 text-left hover:bg-slate-800/40"
        >
          <div>
            <p className="font-medium">{t("language")}</p>
            <p className="mt-1 text-xs text-slate-500">
              {tr("changeLanguage")}
            </p>
          </div>
          <span className="flex items-center gap-2 text-sm text-amber-300">
            {LANGUAGES.find((x) => x[0] === language)?.[1]}
            <ChevronRight className="h-4 w-4" />
          </span>
        </button>
      </Group>
      <Group icon={<Bell />} title={tr("notifications")}>
        <div className="border-b border-slate-800 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="font-medium">瀏覽器系統推播</p>
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${pushEnabled ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-800 text-slate-400"}`}>
                  {pushPermission === "default" && pushEnabled ? "預設開啟" : pushEnabled ? "已開啟" : "未開啟"}
                </span>
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                預設開啟。即使關閉分頁，重要公告仍可顯示系統橫幅；收到通知時會播放短提示音。
              </p>
              {pushPermission === "denied" && (
                <p role="alert" className="mt-2 text-xs leading-5 text-rose-300">
                  通知已被瀏覽器封鎖，請點擊網址列旁的網站設定並將「通知」改為允許。
                </p>
              )}
              {pushPermission === "unsupported" && (
                <p role="alert" className="mt-2 text-xs leading-5 text-amber-300">
                  此瀏覽器不支援背景推播。iPhone／iPad 請先將網站加入主畫面，再由主畫面開啟。
                </p>
              )}
              {pushMessage && <p role="status" className="mt-2 text-xs leading-5 text-slate-300">{pushMessage}</p>}
            </div>
            <button
              type="button"
              role="switch"
              aria-label="瀏覽器系統推播"
              aria-checked={pushEnabled}
              onClick={() => void togglePush()}
              disabled={pushBusy || pushPermission === "unsupported"}
              className={`relative h-7 w-12 shrink-0 rounded-full transition ${pushEnabled ? "bg-amber-400" : "bg-slate-700"} disabled:cursor-not-allowed disabled:opacity-50`}
            >
              <span className={`absolute top-1 size-5 rounded-full bg-white transition ${pushEnabled ? "left-6" : "left-1"}`} />
            </button>
          </div>
        </div>
        {Object.entries(alerts).map(([k, v]) => (
          <div key={k} className="flex items-center justify-between p-5">
            <div>
              <p className="font-medium">{tr(k)}</p>
              <p className="mt-1 text-xs text-slate-500">
                {tr("receiveAlerts")}
              </p>
            </div>
            <button
              aria-label={tr(k)}
              role="switch"
              aria-checked={v}
              onClick={() => setAlertPreference(k as keyof typeof alerts, !v)}
              className={`relative h-6 w-11 rounded-full ${v ? "bg-amber-400" : "bg-slate-700"}`}
            >
              <span
                className={`absolute top-1 h-4 w-4 rounded-full bg-white transition ${v ? "left-6" : "left-1"}`}
              />
            </button>
          </div>
        ))}
      </Group>
      <button
        type="button"
        onClick={handleSignOut}
        disabled={signingOut}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 font-semibold text-red-300 transition hover:bg-red-500/20 disabled:cursor-wait disabled:opacity-60"
      >
        <LogOut className="size-5" />
        {signingOut
          ? interfaceText(language, "signingOut")
          : interfaceText(language, "signOut")}
      </button>
      {agencyOpen && (
        <Modal open title="代理身份申請" onClose={() => setAgencyOpen(false)}>
          <div className="grid gap-3">
            <label className="text-sm text-slate-400">
              申請類型
              <select
                value={form.role}
                onChange={(e) =>
                  setForm((v) => ({ ...v, role: e.target.value }))
                }
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-slate-100"
              >
                <option>代理</option>
                <option>總代理</option>
              </select>
            </label>
            {form.role === "代理" && (
              <Field
                label="總代理推廣碼"
                value={form.masterCode}
                onChange={(masterCode) =>
                  setForm((v) => ({
                    ...v,
                    masterCode: masterCode.toUpperCase(),
                  }))
                }
              />
            )}
            <Field
              label="聯絡姓名"
              value={form.name}
              onChange={(name) => setForm((v) => ({ ...v, name }))}
            />
            <Field
              label="電話／通訊方式"
              value={form.contact}
              onChange={(contact) => setForm((v) => ({ ...v, contact }))}
            />
            <Field
              label="地區"
              value={form.region}
              onChange={(region) => setForm((v) => ({ ...v, region }))}
            />
            <label className="text-sm text-slate-400">
              申請理由
              <textarea
                value={form.reason}
                onChange={(e) =>
                  setForm((v) => ({ ...v, reason: e.target.value }))
                }
                rows={4}
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-slate-100"
              />
            </label>
            <button
              onClick={() => void apply()}
              className="rounded-xl bg-amber-400 p-3 font-bold text-slate-950"
            >
              送出審核
            </button>
          </div>
        </Modal>
      )}
      {langOpen && (
        <Modal open title={t("language")} onClose={() => setLangOpen(false)}>
          <div className="grid gap-2 sm:grid-cols-2">
            {LANGUAGES.map(([code, label]) => (
              <button
                key={code}
                onClick={() => {
                  setLanguagePreference(code);
                  setLangOpen(false);
                }}
                className={`flex items-center justify-between rounded-xl border p-3 text-left ${language === code ? "border-amber-400 bg-amber-400/10" : "border-slate-700 hover:bg-slate-800"}`}
              >
                {label}
                {language === code && (
                  <Check className="h-4 w-4 text-amber-300" />
                )}
              </button>
            ))}
          </div>
        </Modal>
      )}
      {kycOpen && (
        <Modal open title={tr("identity")} onClose={() => setKycOpen(false)}>
          <div className="flex flex-col gap-4">
            <Info label={tr("status")} value={t("kycPassed")} />
            <Info label={tr("level")} value={`2 · ${tr("investor")}`} />
            <Info label={tr("verifiedDate")} value="2026-07-18" />
            <Info label="Reference" value="KYC-89204-AU" />
          </div>
        </Modal>
      )}
    </div>
  );
}
function Group({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
      <header className="flex items-center gap-2 border-b border-slate-800 p-4 text-amber-300">
        {icon}
        <h2 className="font-bold text-white">{title}</h2>
      </header>
      <div className="divide-y divide-slate-800">{children}</div>
    </section>
  );
}
function Info({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex min-w-0 flex-col gap-1 border-b border-slate-800 pb-3 text-sm sm:flex-row sm:justify-between sm:gap-4">
      <span className="shrink-0 text-slate-400">{label}</span>
      <b className="min-w-0 break-words sm:text-right">{value}</b>
    </p>
  );
}
function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-sm text-slate-400">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-slate-100"
      />
    </label>
  );
}
