import { useCallback, useEffect, useRef, useState } from "react";
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
import { interfaceText, LANGUAGES, localizedUiText, useLanguage, useTheme, type ColorMode } from "@/platform";
import { Modal } from "@/components/Modal";
import { useUserPreferences } from "@/contexts/UserPreferences";
import { supabase } from "@/lib/supabase";
import { reportMonitorEventInBackground } from "@/lib/monitoring";
import { TelegramAccountSettings } from "@/components/TelegramAccountSettings";

export function SettingsPage({ sessionUser, focusTarget }: { sessionUser: User; focusTarget?: "nickname" | "agencyRelationship" | "telegramNotifications" | null }) {
  const { logout: privyLogout } = usePrivy();
  const nicknameInputRef = useRef<HTMLInputElement>(null);
  const agencyRelationshipRef = useRef<HTMLDivElement>(null);
  const telegramNotificationsRef = useRef<HTMLDivElement>(null);
  const customPromoCodeInputRef = useRef<HTMLInputElement>(null);
  const { t, tr, language } = useLanguage();
  const translate = (ko: string, zh: string) => localizedUiText(language, ko, zh);
  const roleLabel = (role: string) => {
    const levelByRole: Record<string, string> = {
      "一般用戶": "創世紀L0",
      "總代理": "創世紀L0",
      "代理": "創世紀L1",
      "一代代理": "創世紀L1",
      "二代代理": "創世紀L2",
    };
    const label = levelByRole[role] ?? role;
    return localizedUiText(language, label, label);
  };
  const {
    saveStatus,
    setLanguagePreference,
    setThemePreference,
    setAccentPreference,
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
  useEffect(() => {
    if (!focusTarget) return;
    const frame = window.requestAnimationFrame(() => {
      if (focusTarget === "nickname") {
        nicknameInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        nicknameInputRef.current?.focus({ preventScroll: true });
      } else if (focusTarget === "telegramNotifications") {
        telegramNotificationsRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        agencyRelationshipRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        customPromoCodeInputRef.current?.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusTarget]);
  const [langOpen, setLangOpen] = useState(false);
  const [kycOpen, setKycOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
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
  const [customCode, setCustomCode] = useState("");
  const [uplineCode, setUplineCode] = useState("");
  const [specialCode, setSpecialCode] = useState("");
  const [savingRelationship, setSavingRelationship] = useState(false);
  const [agencyOpen, setAgencyOpen] = useState(false);
  const [applicationRole, setApplicationRole] = useState<"代理" | "總代理">("代理");
  const applicationRoleLabel = (_role: "代理" | "總代理") => localizedUiText(language, "창세기 L0 (자신)", "創世紀L0");
  const [applicationSending, setApplicationSending] = useState(false);
  const [agencySuccessRole, setAgencySuccessRole] = useState<"代理" | "總代理" | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(
    null,
  );
  const loadAgency = useCallback(async () => {
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
  }, [user.email, user.id]);
  useEffect(() => {
    void loadAgency();
  }, [loadAgency]);
  const saveNickname = async () => {
    const value = nickname.trim();
    if (!value) {
      setMessage({ text: translate("닉네임을 입력해 주세요.", "暱稱不可為空白"), ok: false });
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
  const saveRelationshipCodes = async () => {
    const upline = uplineCode.trim().toUpperCase();
    const special = specialCode.trim().toUpperCase();
    if (!upline && !special) {
      setMessage({ text: "請輸入上線推廣碼或指定代碼", ok: false });
      return;
    }
    if (upline && upline === "RWMT88888") {
      setMessage({ text: "RWMT88888 是指定代碼，不能填在上線推廣碼欄位", ok: false });
      return;
    }
    if (special && special !== "RWMT88888") {
      setMessage({ text: "指定代碼目前僅支援 RWMT88888", ok: false });
      return;
    }
    setSavingRelationship(true);
    const errors: string[] = [];
    if (upline) {
      const { error } = await supabase.rpc("bind_referral_code", { promo: upline });
      if (error) errors.push("上線推廣碼綁定失敗");
    }
    if (special) {
      const { error } = await supabase.rpc("activate_special_promo_code", { promo: special });
      if (error) errors.push("指定代碼啟用失敗，請稍後再試");
    }
    setSavingRelationship(false);
    setMessage({ text: errors.length ? "設定未完成，請稍後再試" : "推薦關係與指定代碼已更新", ok: errors.length === 0 });
    if (!errors.length) {
      setUplineCode("");
      setSpecialCode("");
      await loadAgency();
    }
  };
  const saveCode = async () => {
    const normalizedCode = customCode.trim().toUpperCase();
    if (profile?.promo_code?.toUpperCase() === "RWMT88888") {
      setMessage({
        text: "RWMT88888 為系統指定推廣碼，不能更新。",
        ok: false,
      });
      return;
    }
    if (!/^[A-Z0-9]{9}$/.test(normalizedCode)) {
      setMessage({ text: translate("추천 코드는 영문 또는 숫자 9자리이며 중복될 수 없습니다.", "推廣碼需為 9 位英數字，且不得與他人重複"), ok: false });
      return;
    }
    const { error } = await supabase.rpc("set_own_promo_code", {
      new_code: normalizedCode,
    });
    const duplicateCode = error?.code === "23505" || error?.message.toLowerCase().includes("promo code already used");
    setMessage({
      text: duplicateCode
        ? "此推廣碼已被他人使用，請更換後再試"
        : error
          ? "推廣碼更新失敗，請稍後再試"
          : "自訂推廣碼已更新",
      ok: !error,
    });
    if (!error) {
      setCustomCode("");
      await loadAgency();
    }
  };
  const apply = async () => {
    if (applicationSending) return;
    const role = applicationRole;
    const email = user.email?.trim() || "未提供聯絡方式";
    const profileName = nickname.trim();
    const emailName = user.email?.split("@")[0]?.trim();
    const applicantName = profileName.length >= 2
      ? profileName
      : emailName && emailName.length >= 2
        ? emailName
        : "平台會員";
    setApplicationSending(true);
    try {
      const { error } = await supabase.rpc("submit_agency_application", {
        p_role: role,
        p_name: applicantName,
        p_contact: email,
        p_region: "未提供",
        p_reason: `使用者申請成為${role}`,
        p_master_code: null,
      });
      if (error) {
        setMessage({
          text: error.message.includes("application pending")
            ? "您已有一筆代理申請正在審核中"
            : "申請未送出，請稍後再試或聯絡客服",
          ok: false,
        });
        return;
      }
      reportMonitorEventInBackground({
        type: "agency_application",
        applicationType: role === "總代理" ? "總代理" : "一般代理",
        name: applicantName,
        contact: email,
        notes: role === "代理" ? "尚未指派總代理" : "總代理申請",
      });
      setAgencyOpen(false);
      setAgencySuccessRole(role);
      await loadAgency();
    } catch {
      setMessage({ text: "申請未送出，請稍後再試或聯絡客服", ok: false });
    } finally {
      setApplicationSending(false);
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
                ref={nicknameInputRef}
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
        <div ref={agencyRelationshipRef} className="flex flex-col gap-4 p-5">
        <Info label={interfaceText(language, "currentRole")} value="創世紀L0" />
        {application && (
          <Info
            label={localizedUiText(language, "최근 신청", "最近申請")}
            value={`${roleLabel(application.requested_role)} · ${application.status === "pending" ? localizedUiText(language, "심사 중", "審核中") : application.status === "approved" ? localizedUiText(language, "승인됨", "已核准") : localizedUiText(language, "거절됨", "已拒絕")}`}
          />
        )}
          {true ? (
            <>
              <div className="grid gap-4 rounded-2xl border border-slate-700 bg-slate-950/40 p-4">
                <div>
                  <label htmlFor="upline-promo-code" className="mb-2 block text-sm font-semibold text-slate-200">上線推廣碼</label>
                  <input id="upline-promo-code" value={uplineCode} onChange={(event) => setUplineCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="輸入上級的推廣碼" maxLength={9} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 font-mono uppercase" />
                  <p className="mt-2 text-xs text-slate-400">用來綁定上級，建立你的直屬推薦關係。</p>
                </div>
                <div>
                  <label htmlFor="special-promo-code" className="mb-2 block text-sm font-semibold text-slate-200">指定代碼</label>
                  <input id="special-promo-code" value={specialCode} onChange={(event) => setSpecialCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="輸入指定代碼" maxLength={9} className="w-full rounded-xl border border-amber-500/40 bg-slate-950 px-4 py-3 font-mono uppercase" />
                </div>
                <button type="button" onClick={() => void saveRelationshipCodes()} disabled={savingRelationship} className="rounded-xl bg-amber-400 px-5 py-3 font-bold text-slate-950 disabled:opacity-50">{savingRelationship ? "儲存中…" : "儲存推薦設定"}</button>
              </div>
              <Info label={localizedUiText(language, "내 추천 코드", "我的推廣碼")} value={profile?.promo_code ?? "—"} />
              <div className="flex flex-col gap-2 sm:flex-row">
  <input
  ref={customPromoCodeInputRef}
  aria-label={localizedUiText(language, "사용자 지정 추천 코드", "自訂推廣碼")}
  disabled={profile?.promo_code?.toUpperCase() === "RWMT88888"}
  value={customCode}
                  maxLength={9}
                  onChange={(event) =>
                    setCustomCode(
                      event.target.value
                        .toUpperCase()
                        .replace(/[^A-Z0-9]/g, ""),
                    )
                  }
                  placeholder={localizedUiText(language, "영문 또는 숫자 9자리, 중복 불가", "9 位英數字，不得與他人重複")}
                  aria-describedby="custom-promo-code-hint"
                  className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 font-mono uppercase"
                />
                <button
                  onClick={() => void saveCode()}
                  className="flex items-center justify-center gap-2 rounded-xl border border-amber-500/30 px-5 py-3 font-bold text-amber-300"
                >
                  <KeyRound className="size-4" />
                  {localizedUiText(language, "추천 코드 업데이트", "更新推廣碼")}
                </button>
              </div>
              <p id="custom-promo-code-hint" className="text-xs text-slate-400">
                {profile?.promo_code?.toUpperCase() === "RWMT88888"
    ? "RWMT88888 為系統指定推廣碼，綁定後不可自行更新。"
    : localizedUiText(language, "추천 코드는 영문 또는 숫자 9자리이며 다른 사용자와 중복될 수 없습니다.", "推廣碼需為 9 位英數字，且不得與他人重複。")}
              </p>
            </>
          ) : (
            <>
              <p className="rounded-xl border border-slate-700 bg-slate-950/60 p-3 text-sm text-slate-400">
                {localizedUiText(language, "하위 실적이 있어야 자기 투자 3% 보너스가 잠금 해제됩니다. 2차 시장에서 본인 매매는 보상 대상이 아니며, 상위 2단계는 각각 13/10000 및 7/10000을 받습니다.", "需具備下線業績方可解鎖自身 3% 認購返利；二級市場自己買賣無反饋，上兩級分別為 13/10000 與 7/10000。")}
              </p>
              <div className="overflow-x-auto rounded-xl border border-slate-700">
                <table className="min-w-[560px] w-full text-left text-xs">
                  <thead className="bg-slate-800/70 text-slate-300"><tr><th className="p-3">{localizedUiText(language, "투자 단계", "投資層級")}</th><th className="p-3">{localizedUiText(language, "자기 3%", "自己 3%")}</th><th className="p-3">{localizedUiText(language, "직속 상위 2%", "直屬上級 2%")}</th><th className="p-3">{localizedUiText(language, "상위 1%", "上上級 1%")}</th><th className="p-3">{localizedUiText(language, "플랫폼 총액", "平台總發出")}</th></tr></thead>
                  <tbody className="divide-y divide-slate-800">{[
                    ["創世紀L1", "300 JC", "0", "0", "300 JC"], ["創世紀L2", "300 JC", "200 JC", "0", "500 JC"], ["創世紀L3", "300 JC", "200 JC", "100 JC", "600 JC"], ["創世紀L4", "300 JC", "200 JC", "100 JC", "600 JC"], ["創世紀L5", "300 JC", "200 JC", "100 JC", "600 JC"], ["創世紀L6", "300 JC", "200 JC", "100 JC", "600 JC"],
                  ].map((row) => <tr key={row[0]} className="text-slate-200">{row.map((cell) => <td key={cell} className="p-3">{cell}</td>)}</tr>)}</tbody>
                </table>
              </div>
              <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                {localizedUiText(language, "您已自動成為創世紀L0，可直接使用推廣碼發展下級。", "您已自動成為創世紀 L0，可直接使用推廣碼發展下級。")}
              </p>
            </>
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
      <div ref={telegramNotificationsRef}>
        <Group icon={<Bell />} title={tr("notifications")}>
          <TelegramAccountSettings userId={user.id} language={language} />
        </Group>
      </div>
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
        <Modal open title={translate("에이전트 신청 유형 선택", "選擇代理申請類型")} onClose={() => setAgencyOpen(false)}>
          <fieldset className="grid gap-3">
            <legend className="mb-1 text-sm text-slate-400">{localizedUiText(language, "신청할 창세기 등급을 선택하세요", "請選擇創世紀層級")}</legend>
            {(["代理", "總代理"] as const).map((role) => (
              <label
                key={role}
                className={`flex cursor-pointer items-center gap-3 rounded-xl border p-4 transition ${applicationRole === role ? "border-amber-400 bg-amber-400/10 text-amber-100" : "border-slate-700 text-slate-300 hover:bg-slate-800"}`}
              >
                <input
                  type="radio"
                  name="agency-application-role"
                  value={role}
                  checked={applicationRole === role}
                  onChange={() => setApplicationRole(role)}
                  className="accent-amber-400"
                />
                <span className="font-semibold">{applicationRoleLabel(role)}</span>
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            onClick={() => void apply()}
            disabled={applicationSending}
            className="mt-4 w-full rounded-xl bg-amber-400 p-3 font-bold text-slate-950 disabled:cursor-wait disabled:opacity-50"
          >
            {applicationSending ? translate("제출 중…", "送出中…") : translate("신청 제출", "送出申請")}
          </button>
        </Modal>
      )}
      {agencySuccessRole && (
        <Modal
          open
          title={localizedUiText(language, "신청이 제출되었습니다", "申請已送出")}
          onClose={() => setAgencySuccessRole(null)}
        >
          <div className="grid gap-4 text-sm leading-6 text-slate-200">
            <p>
              {localizedUiText(language, `귀하의 ${applicationRoleLabel(agencySuccessRole)} 신청이 제출되었습니다. 승인 후 Genesis 팀에 합류할 수 있습니다.`, `您的${applicationRoleLabel(agencySuccessRole)}申請已成功送出。審核通過後，歡迎加入 Genesis 團隊。`)}
            </p>
            <p>
              {localizedUiText(language, "승인 후 보너스가 즉시 반영됩니다. 에이전트 센터에서 추천 정보를 확인하고, 설정의 에이전트 및 추천 관계에서 코드를 변경할 수 있습니다.", "審核通過成為團隊成員後，分潤即時到帳。請至代理中心查看推廣資訊；如需更換推廣碼，請至設定「代理與推廣關係」內更新。") }
            </p>
  <button
  type="button"
  onClick={() => void saveCode()}
  disabled={profile?.promo_code?.toUpperCase() === "RWMT88888"}
  className="flex items-center justify-center gap-2 rounded-xl border border-amber-500/30 px-5 py-3 font-bold text-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
  >
              知道了
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
