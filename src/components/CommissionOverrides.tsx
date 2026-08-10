"use client";

import { useEffect, useMemo, useState } from "react";
import { RotateCcw, Search, UserRoundCog } from "lucide-react";
import { Notice } from "@/components/Modal";
import { supabase } from "@/lib/supabase";

type Person = {
  user_id: string;
  email: string;
  display_name: string | null;
  agency_role: string;
  private_rate: number | null;
  secondary_rate: number | null;
  default_private_rate: number;
  default_secondary_rate: number;
};

type Draft = { privateRate: string; secondaryRate: string };
const percent = (value: number | null | undefined) => Number(value ?? 0) * 100;

export function CommissionOverrides() {
  const [people, setPeople] = useState<Person[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("全部");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(
    null,
  );

  const load = async () => {
    const { data, error } = await supabase.rpc("admin_list_commission_people");
    if (error) {
      setNotice({ text: "無法載入推廣人員分潤資料", ok: false });
      return;
    }
    const rows = (data ?? []) as Person[];
    setPeople(rows);
    setDrafts(
      Object.fromEntries(
        rows.map((person) => [
          person.user_id,
          {
            privateRate: String(
              percent(person.private_rate ?? person.default_private_rate),
            ),
            secondaryRate: String(
              percent(person.secondary_rate ?? person.default_secondary_rate),
            ),
          },
        ]),
      ),
    );
  };

  useEffect(() => {
    void load();
  }, []);

  const shown = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return people.filter(
      (person) =>
        (role === "全部" || person.agency_role === role) &&
        (!keyword ||
          [person.email, person.display_name, person.agency_role].some(
            (value) =>
              String(value ?? "")
                .toLowerCase()
                .includes(keyword),
          )),
    );
  }, [people, query, role]);

  const save = async (person: Person) => {
    const draft = drafts[person.user_id];
    const privateRate = Number(draft?.privateRate);
    const secondaryRate = Number(draft?.secondaryRate);
    if (
      ![privateRate, secondaryRate].every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 100,
      )
    ) {
      setNotice({ text: "個別比例需介於 0% 至 100%", ok: false });
      return;
    }
    setBusyId(person.user_id);
    const { error } = await supabase.rpc("admin_update_user_commission", {
      target_user_id: person.user_id,
      new_private_rate: privateRate / 100,
      new_secondary_rate: secondaryRate / 100,
    });
    setBusyId(null);
    setNotice({
      text: error
        ? "個別分潤更新失敗"
        : `${person.display_name || person.email} 已改用個別分潤比例`,
      ok: !error,
    });
    if (!error) await load();
  };

  const restore = async (person: Person) => {
    if (
      !window.confirm(
        `確定讓 ${person.display_name || person.email} 恢復使用「${person.agency_role}」統一比例？`,
      )
    )
      return;
    setBusyId(person.user_id);
    const { error } = await supabase.rpc("admin_update_user_commission", {
      target_user_id: person.user_id,
      new_private_rate: null,
      new_secondary_rate: null,
    });
    setBusyId(null);
    setNotice({
      text: error ? "恢復統一比例失敗" : "已恢復使用角色統一比例",
      ok: !error,
    });
    if (!error) await load();
  };

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex items-center gap-3">
        <UserRoundCog className="size-5 text-amber-300" aria-hidden="true" />
        <div>
          <h3 className="font-bold">個別推廣人員分潤</h3>
          <p className="text-xs text-slate-500">
            個別比例會覆蓋角色統一值；可隨時恢復統一比例。
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
        <label className="relative flex-1">
          <span className="sr-only">搜尋推廣人員</span>
          <Search
            className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500"
            aria-hidden="true"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜尋姓名、Email 或角色"
            className="w-full rounded-xl border border-slate-700 bg-slate-950 py-3 pl-10 pr-3 text-sm"
          />
        </label>
        <select
          aria-label="推廣人員角色篩選"
          value={role}
          onChange={(event) => setRole(event.target.value)}
          className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm"
        >
          <option>全部</option>
          <option>總代理</option>
          <option>代理</option>
        </select>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="text-slate-500">
              <th className="p-3">推廣人員</th>
              <th>角色</th>
              <th>私募百分比</th>
              <th>二級市場百分比</th>
              <th>套用方式</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((person) => {
              const overridden =
                person.private_rate !== null || person.secondary_rate !== null;
              return (
                <tr key={person.user_id} className="border-t border-slate-800">
                  <td className="p-3">
                    <b className="text-slate-200">
                      {person.display_name || "未設定姓名"}
                    </b>
                    <span className="block text-xs text-slate-500">
                      {person.email}
                    </span>
                  </td>
                  <td>{person.agency_role}</td>
                  <td>
                    <input
                      aria-label={`${person.email} 私募百分比`}
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={drafts[person.user_id]?.privateRate ?? ""}
                      onChange={(event) =>
                        setDrafts((value) => ({
                          ...value,
                          [person.user_id]: {
                            ...value[person.user_id],
                            privateRate: event.target.value,
                          },
                        }))
                      }
                      className="w-28 rounded-lg border border-slate-700 bg-slate-950 p-2"
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`${person.email} 二級市場百分比`}
                      type="number"
                      min="0"
                      max="100"
                      step="0.001"
                      value={drafts[person.user_id]?.secondaryRate ?? ""}
                      onChange={(event) =>
                        setDrafts((value) => ({
                          ...value,
                          [person.user_id]: {
                            ...value[person.user_id],
                            secondaryRate: event.target.value,
                          },
                        }))
                      }
                      className="w-28 rounded-lg border border-slate-700 bg-slate-950 p-2"
                    />
                  </td>
                  <td>
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${overridden ? "bg-amber-400/10 text-amber-300" : "bg-slate-800 text-slate-400"}`}
                    >
                      {overridden ? "個別覆蓋" : "統一比例"}
                    </span>
                  </td>
                  <td>
                    <div className="flex gap-2">
                      <button
                        disabled={busyId === person.user_id}
                        onClick={() => void save(person)}
                        className="rounded-lg bg-amber-400 px-3 py-2 text-xs font-bold text-slate-950 disabled:opacity-50"
                      >
                        儲存個別值
                      </button>
                      <button
                        disabled={!overridden || busyId === person.user_id}
                        onClick={() => void restore(person)}
                        className="flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold disabled:opacity-40"
                      >
                        <RotateCcw className="size-3" />
                        恢復統一
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!shown.length && (
          <p className="py-8 text-center text-sm text-slate-500">
            找不到符合條件的推廣人員
          </p>
        )}
      </div>
    </section>
  );
}
