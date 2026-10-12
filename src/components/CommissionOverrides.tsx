"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCcw, UserRoundCog } from "lucide-react";
import { Notice } from "@/components/Modal";
import { SearchSuggest } from "@/components/SearchSuggest";
import { useVisiblePolling } from "@/hooks/useVisiblePolling";
import { supabase } from "@/lib/supabase";
import { getGenesisRoleLabel } from "@/lib/roleLabels";

type Person = {
  user_id: string;
  email: string;
  display_name: string | null;
  agency_role: string;
  self_private_rate: number | null;
  l1_private_rate: number | null;
  l2_private_rate: number | null;
  secondary_rate: number | null;
  self_secondary_rate: number | null;
  l1_secondary_rate: number | null;
  l2_secondary_rate: number | null;
  default_private_rate: number;
  default_secondary_rate: number;
};
type Draft = { selfRate: string; l1Rate: string; l2Rate: string; selfSecondaryRate: string; l1SecondaryRate: string; l2SecondaryRate: string };

const percent = (value: number | null | undefined) => Number(value ?? 0) * 100;

export function CommissionOverrides({
  assetMode,
}: {
  assetMode: "ae_coin" | "rwa";
}) {
  const [people, setPeople] = useState<Person[]>([]);
  const [bonusTotals, setBonusTotals] = useState<Record<string, number>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("全部");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(
    null,
  );

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data, error }, { data: commissionRows }] = await Promise.all([
      supabase.rpc("admin_list_commission_people", {
        asset_mode_text: assetMode,
      }),
      supabase
        .from("commission_logs")
        .select("beneficiary_id,commission_amount"),
    ]);
    setLoading(false);
    if (error) {
      setNotice({
        text: "無法載入推廣人員分潤資料，請重新整理後再試",
        ok: false,
      });
      return;
    }
    const rows = (data ?? []) as Person[];
    setPeople(rows);
    setBonusTotals(
      (
        (commissionRows ?? []) as Array<{
          beneficiary_id: string;
          commission_amount: number;
        }>
      ).reduce<Record<string, number>>((totals, commission) => {
        totals[commission.beneficiary_id] =
          (totals[commission.beneficiary_id] ?? 0) +
          Number(commission.commission_amount);
        return totals;
      }, {}),
    );
    setDrafts(
      Object.fromEntries(
        rows.map((person) => [
          person.user_id,
          {
selfRate: person.self_private_rate === null ? "" : String(percent(person.self_private_rate)),
          l1Rate: person.l1_private_rate === null ? "" : String(percent(person.l1_private_rate)),
          l2Rate: person.l2_private_rate === null ? "" : String(percent(person.l2_private_rate)),
          selfSecondaryRate: person.self_secondary_rate === null ? "0" : String(percent(person.self_secondary_rate)),
          l1SecondaryRate: person.l1_secondary_rate === null ? "0.13" : String(percent(person.l1_secondary_rate)),
          l2SecondaryRate: person.l2_secondary_rate === null ? "0.07" : String(percent(person.l2_secondary_rate)),
          },
        ]),
      ),
    );
  }, [assetMode]);

  useEffect(() => {
    void load();
  }, [load]);

  const syncNames = useCallback(async () => {
    const { data, error } = await supabase.rpc("admin_list_commission_people", {
      asset_mode_text: assetMode,
    });
    if (error) return;
    const latest = new Map(
      ((data ?? []) as Person[]).map((person) => [person.user_id, person]),
    );
    setPeople((current) =>
      current.map((person) => latest.get(person.user_id) ?? person),
    );
  }, [assetMode]);
  // Keep displayed nicknames current without replacing unsaved commission drafts.
  useVisiblePolling(syncNames, 1_000, false);

  const shown = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    const matches = people.filter(
      (person) =>
        (role === "全部" || person.agency_role === role) &&
        (!keyword ||
          [person.email, person.display_name, person.agency_role].some(
            (value) =>
              String(value ?? "")
                .toLocaleLowerCase()
                .includes(keyword),
          )),
    );
    if (role !== "全部" || keyword) return matches;
    return [...matches]
      .sort(
        (a, b) =>
          (bonusTotals[b.user_id] ?? 0) - (bonusTotals[a.user_id] ?? 0) ||
          a.email.localeCompare(b.email),
      )
      .slice(0, 2);
  }, [bonusTotals, people, query, role]);

  const changeDraft = (userId: string, field: keyof Draft, value: string) => {
    setDrafts((current) => ({
      ...current,
      [userId]: { ...current[userId], [field]: value },
    }));
  };

  const save = async (person: Person) => {
    const draft = drafts[person.user_id];
    const parseRate = (value: string | undefined) => value?.trim() === "" ? null : Number(value);
    const selfRate = parseRate(draft?.selfRate);
    const l1Rate = parseRate(draft?.l1Rate);
    const l2Rate = parseRate(draft?.l2Rate);
    const secondaryRate = Number(draft?.l1SecondaryRate);
    const selfSecondaryRate = Number(draft?.selfSecondaryRate);
    const l1SecondaryRate = Number(draft?.l1SecondaryRate);
    const l2SecondaryRate = Number(draft?.l2SecondaryRate);
    const privateRates = [selfRate, l1Rate, l2Rate];
    if (
      privateRates.some((value) => value !== null && (!Number.isFinite(value) || value < 0 || value > 100)) ||
      [selfSecondaryRate, l1SecondaryRate, l2SecondaryRate].some((value) => !Number.isFinite(value) || value < 0 || value > 100)
    ) {
      setNotice({ text: "個別比例需介於 0% 至 100%", ok: false });
      return;
    }
    setBusyId(person.user_id);
    const { error } = await supabase.rpc("admin_update_user_commission", {
      target_user_id: person.user_id,
      new_self_private_rate: selfRate === null ? null : selfRate / 100,
      new_l1_private_rate: l1Rate === null ? null : l1Rate / 100,
      new_l2_private_rate: l2Rate === null ? null : l2Rate / 100,
      new_secondary_rate: secondaryRate / 100,
      new_self_secondary_rate: selfSecondaryRate / 100,
      new_l1_secondary_rate: l1SecondaryRate / 100,
      new_l2_secondary_rate: l2SecondaryRate / 100,
      asset_mode_text: assetMode,
    });
    setBusyId(null);
    setNotice({
      text: error
        ? "個別分潤更新失敗"
        : `${person.display_name || person.email} 的後續新交易將套用個別分潤比例`,
      ok: !error,
    });
    if (!error) await load();
  };

  const restore = async (person: Person) => {
    if (
      !window.confirm(
        `確定讓 ${person.display_name || person.email} 恢復使用「${getGenesisRoleLabel(person.agency_role)}」統一比例？`,
      )
    )
      return;
    setBusyId(person.user_id);
    const { error } = await supabase.rpc("admin_update_user_commission", {
      target_user_id: person.user_id,
      new_self_private_rate: null,
      new_l1_private_rate: null,
      new_l2_private_rate: null,
      new_secondary_rate: null,
      new_self_secondary_rate: null,
      new_l1_secondary_rate: null,
      new_l2_secondary_rate: null,
      asset_mode_text: assetMode,
    });
    setBusyId(null);
    setNotice({
      text: error ? "恢復統一比例失敗" : "已恢復使用角色統一比例",
      ok: !error,
    });
    if (!error) await load();
  };

  const editor = (person: Person, mobile = false) => {
    const overridden =
      person.self_private_rate !== null || person.l1_private_rate !== null ||
      person.l2_private_rate !== null || person.secondary_rate !== null ||
      person.self_secondary_rate !== null || person.l1_secondary_rate !== null ||
      person.l2_secondary_rate !== null;
    const inputClass =
      "w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-base sm:p-2 sm:text-sm";
    return (
      <>
        <div
          className={
            mobile ? "grid grid-cols-1 gap-3 sm:grid-cols-2" : "contents"
          }
        >
          <label className={mobile ? "text-xs font-medium text-slate-400" : ""}>
            {mobile && <span className="mb-1 block">L0 本人認購回饋 %</span>}
            <input aria-label={`${person.email} L0 本人認購回饋百分比`} type="number" inputMode="decimal" min="0" max="100" step="0.01" value={drafts[person.user_id]?.selfRate ?? ""} placeholder="自動 3" onChange={(event) => changeDraft(person.user_id, "selfRate", event.target.value)} className={inputClass} />
          </label>
          <label className={mobile ? "text-xs font-medium text-slate-400" : ""}>
            {mobile && <span className="mb-1 block">L1 認購分潤 %</span>}
            <input aria-label={`${person.email} L1 認購分潤百分比`} type="number" inputMode="decimal" min="0" max="100" step="0.01" value={drafts[person.user_id]?.l1Rate ?? ""} placeholder="自動" onChange={(event) => changeDraft(person.user_id, "l1Rate", event.target.value)} className={inputClass} />
          </label>
          <label className={mobile ? "text-xs font-medium text-slate-400" : ""}>
            {mobile && <span className="mb-1 block">L2 認購分潤 %</span>}
            <input aria-label={`${person.email} L2 認購分潤百分比`} type="number" inputMode="decimal" min="0" max="100" step="0.01" value={drafts[person.user_id]?.l2Rate ?? ""} placeholder="自動" onChange={(event) => changeDraft(person.user_id, "l2Rate", event.target.value)} className={inputClass} />
          </label>
          <label className={mobile ? "text-xs font-medium text-slate-400" : ""}>
            {mobile && <span className="mb-1 block">L0 二級分潤 %</span>}
            <input aria-label={`${person.email} L0 二級分潤百分比`} type="number" min="0" max="100" step="0.001" value={drafts[person.user_id]?.selfSecondaryRate ?? "0"} onChange={(event) => changeDraft(person.user_id, "selfSecondaryRate", event.target.value)} className={inputClass} />
          </label>
          <label className={mobile ? "text-xs font-medium text-slate-400" : ""}>
            {mobile && <span className="mb-1 block">L1 二級分潤 %</span>}
            <input aria-label={`${person.email} L1 二級分潤百分比`} type="number" min="0" max="100" step="0.001" value={drafts[person.user_id]?.l1SecondaryRate ?? "0.13"} onChange={(event) => changeDraft(person.user_id, "l1SecondaryRate", event.target.value)} className={inputClass} />
          </label>
          <label className={mobile ? "text-xs font-medium text-slate-400" : ""}>
            {mobile && <span className="mb-1 block">L2 二級分潤 %</span>}
            <input aria-label={`${person.email} L2 二級分潤百分比`} type="number" min="0" max="100" step="0.001" value={drafts[person.user_id]?.l2SecondaryRate ?? "0.07"} onChange={(event) => changeDraft(person.user_id, "l2SecondaryRate", event.target.value)} className={inputClass} />
          </label>
        </div>
        <span
          className={`w-fit rounded-full px-2.5 py-1 text-xs ${overridden ? "bg-amber-500/10 text-amber-300" : "bg-slate-800 text-slate-400"}`}
        >
          {overridden ? "個別覆蓋" : "統一比例"}
        </span>
        <div className="grid grid-cols-1 gap-2 sm:flex">
          <button
            disabled={busyId === person.user_id}
            onClick={() => void save(person)}
            className="rounded-lg bg-amber-400 px-3 py-3 text-xs font-bold text-slate-950 disabled:opacity-50 sm:py-2"
          >
            {busyId === person.user_id ? "處理中…" : "儲存個別值"}
          </button>
          <button
            disabled={!overridden || busyId === person.user_id}
            onClick={() => void restore(person)}
            className="flex items-center justify-center gap-1 rounded-lg border border-slate-700 px-3 py-3 text-xs font-semibold disabled:opacity-40 sm:py-2"
          >
            <RotateCcw className="size-3" aria-hidden="true" />
            恢復統一
          </button>
        </div>
      </>
    );
  };

  return (
    <section className="min-w-0 rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-5">
      <div className="flex items-center gap-3">
        <UserRoundCog
          className="size-5 shrink-0 text-amber-300"
          aria-hidden="true"
        />
        <div>
          <h3 className="font-bold">個別推廣人員分潤</h3>
          <p className="text-xs leading-relaxed text-slate-500">
            未設定個別私募比例時，認購分潤依買方深度自動計算：L1 認購給上層 L0 3%；L2 認購給上層 L1 2%、再給 L0 1%。L0 本人認購回饋為 3%。設定個別比例後，僅後續新交易優先採用個別值；清空私募欄位即可恢復自動規則。
          </p>
        </div>
      </div>
      {notice && (
        <div className="mt-4">
          <Notice
            message={notice.text}
            tone={notice.ok ? "success" : "error"}
          />
        </div>
      )}
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <SearchSuggest
          className="min-w-0 flex-1"
          value={query}
          onChange={setQuery}
          placeholder="搜尋暱稱或 Email"
          suggestions={people.map((person) => ({
            value: person.display_name || person.email,
            label: person.display_name || person.email,
            detail: `${getGenesisRoleLabel(person.agency_role)} · ${person.email}`,
          }))}
        />
        <select
          aria-label="推廣人員角色篩選"
          value={role}
          onChange={(event) => setRole(event.target.value)}
          className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-base sm:w-auto sm:text-sm"
        >
          <option>全部</option>
          <option value="總代理">L1 會員</option>
          <option>L2 會員</option>
        </select>
      </div>
      <p className="mt-3 text-xs text-slate-500" aria-live="polite">
        {loading
          ? "正在載入推廣人員…"
          : role === "全部" && !query.trim()
            ? `全部模式顯示獎金最高 ${shown.length} 位推廣人員`
            : `共找到 ${shown.length} 位推廣人員`}
      </p>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {shown.map((person) => (
          <article
            key={person.user_id}
            className="flex min-w-0 flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-4 sm:p-5"
          >
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <b className="block break-words text-sm text-slate-200">
                  {person.display_name || "未設定姓名"}
                </b>
                <p className="mt-1 break-all text-xs text-slate-500">
                  {person.email}
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs text-amber-300">
                {getGenesisRoleLabel(person.agency_role)}
              </span>
            </div>
            <div className="border-t border-slate-800 pt-4">
              {editor(person, true)}
            </div>
          </article>
        ))}
      </div>
      {!loading && !shown.length && (
        <p className="py-8 text-center text-sm text-slate-500">
          找不到符合條件的推廣人員，請清除關鍵字或切換角色。
        </p>
      )}
    </section>
  );
}
