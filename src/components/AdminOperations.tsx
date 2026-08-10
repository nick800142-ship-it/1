import { useEffect, useMemo, useState } from "react";
import { Bell, CheckCircle2, Coins, Send } from "lucide-react";
import { Notice } from "@/components/Modal";
import { CommissionOverrides } from "@/components/CommissionOverrides";
import { supabase } from "@/lib/supabase";

type Announcement = {
  id: string;
  title: string;
  content: string;
  is_active: boolean;
  created_at: string;
};
type Setting = {
  agency_role: string;
  private_rate: number;
  secondary_rate: number;
  updated_at: string;
};
type Profile = { id: string; email: string; agency_role: string };
type Commission = {
  id: string;
  beneficiary_id: string;
  commission_amount: number;
  paid_at: string | null;
};
type Batch = {
  id: string;
  scope: string;
  role_filter: string | null;
  recipient_count: number;
  total_amount: number;
  created_at: string;
};
const money = (value: number) =>
  `${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;

export function AdminOperations() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [settings, setSettings] = useState<Setting[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [commissions, setCommissions] = useState<Commission[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const [a, s, p, c, b] = await Promise.all([
      supabase
        .from("platform_announcements")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase.from("commission_settings").select("*"),
      supabase
        .from("profiles")
        .select("id,email,agency_role")
        .in("agency_role", ["總代理", "代理"]),
      supabase
        .from("commission_logs")
        .select("id,beneficiary_id,commission_amount,paid_at")
        .order("created_at", { ascending: false }),
      supabase
        .from("commission_payout_batches")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(10),
    ]);
    setAnnouncements((a.data ?? []) as Announcement[]);
    setSettings((s.data ?? []) as Setting[]);
    setProfiles((p.data ?? []) as Profile[]);
    setCommissions((c.data ?? []) as Commission[]);
    setBatches((b.data ?? []) as Batch[]);
  };
  useEffect(() => {
    void load();
  }, []);
  const pending = useMemo(
    () =>
      profiles.map((profile) => ({
        ...profile,
        amount: commissions
          .filter((c) => c.beneficiary_id === profile.id && !c.paid_at)
          .reduce((sum, c) => sum + Number(c.commission_amount), 0),
        lastPaid:
          commissions.find((c) => c.beneficiary_id === profile.id && c.paid_at)
            ?.paid_at ?? null,
      })),
    [profiles, commissions],
  );
  const publish = async () => {
    if (!title.trim() || !content.trim()) {
      setNotice({ text: "請填寫公告標題與內容", ok: false });
      return;
    }
    setBusy(true);
    const { error } = await supabase.rpc("admin_publish_announcement", {
      title_text: title,
      content_text: content,
    });
    setBusy(false);
    setNotice({
      text: error ? "公告發布失敗" : "公告已發布到首頁與代理後台",
      ok: !error,
    });
    if (!error) {
      setTitle("");
      setContent("");
      await load();
    }
  };
  const toggle = async (item: Announcement) => {
    const { error } = await supabase.rpc("admin_set_announcement_active", {
      announcement_id: item.id,
      active: !item.is_active,
    });
    setNotice({
      text: error
        ? "公告狀態更新失敗"
        : item.is_active
          ? "公告已下架"
          : "公告已重新上架",
      ok: !error,
    });
    if (!error) await load();
  };
  const setRates = async (role: string) => {
    const privatePercent = Number(
      (document.getElementById(`private-${role}`) as HTMLInputElement).value,
    );
    const secondaryPercent = Number(
      (document.getElementById(`secondary-${role}`) as HTMLInputElement).value,
    );
    if (
      ![privatePercent, secondaryPercent].every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 100,
      )
    ) {
      setNotice({ text: "比例需介於 0% 至 100%", ok: false });
      return;
    }
    const { error } = await supabase.rpc("admin_update_commission_rates", {
      role_text: role,
      private_percent: privatePercent,
      secondary_percent: secondaryPercent,
    });
    setNotice({
      text: error ? "分潤比例更新失敗" : `${role}私募與二級市場分潤已即時更新`,
      ok: !error,
    });
    if (!error) await load();
  };
  const payout = async (role?: string, ids?: string[]) => {
    if (
      !window.confirm(
        "確定派發目前符合條件的待領獎金？此操作會立即入帳並留下日誌。",
      )
    )
      return;
    setBusy(true);
    const { data, error } = await supabase.rpc(
      "admin_pay_pending_commissions",
      { role_text: role ?? null, recipient_ids: ids ?? null },
    );
    setBusy(false);
    const batch = data as Batch | null;
    setNotice({
      text: error
        ? "獎金派發失敗"
        : `派發完成：${batch?.recipient_count ?? 0} 人，共 ${money(batch?.total_amount ?? 0)}`,
      ok: !error,
    });
    if (!error) {
      setSelected([]);
      await load();
    }
  };
  return (
    <div className="flex flex-col gap-8">
      {notice && (
        <Notice message={notice.text} tone={notice.ok ? "success" : "error"} />
      )}
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-center gap-3">
          <Bell className="size-5 text-amber-300" />
          <div>
            <h3 className="font-bold">平台公告</h3>
            <p className="text-xs text-slate-500">
              發布後立即顯示於首頁與代理營運中心。
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            placeholder="公告標題"
            className="rounded-xl border border-slate-700 bg-slate-950 p-3"
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={2000}
            rows={4}
            placeholder="公告內容"
            className="rounded-xl border border-slate-700 bg-slate-950 p-3"
          />
          <button
            disabled={busy}
            onClick={() => void publish()}
            className="flex items-center justify-center gap-2 rounded-xl bg-amber-400 px-5 py-3 font-bold text-slate-950 disabled:opacity-50"
          >
            <Send className="size-4" />
            發布公告
          </button>
        </div>
        <div className="mt-5 flex flex-col gap-2">
          {announcements.map((item) => (
            <article
              key={item.id}
              className="flex flex-col gap-3 rounded-xl border border-slate-800 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <b>{item.title}</b>
                <p className="mt-1 text-sm text-slate-400">{item.content}</p>
                <time className="text-xs text-slate-600">
                  {new Date(item.created_at).toLocaleString()}
                </time>
              </div>
              <button
                onClick={() => void toggle(item)}
                className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold"
              >
                {item.is_active ? "下架" : "重新上架"}
              </button>
            </article>
          ))}
        </div>
      </section>
      <CommissionOverrides />
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-center gap-3">
          <Coins className="size-5 text-amber-300" />
          <div>
            <h3 className="font-bold">分潤設定與一鍵派發</h3>
            <p className="text-xs text-slate-500">
              比例修改會即時套用後續獎金；已產生的待領金額不回溯重算。
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {["總代理", "代理"].map((role) => {
            const setting = settings.find((s) => s.agency_role === role);
            const privateValue =
              (setting?.private_rate ?? (role === "總代理" ? 0.02 : 0.01)) *
              100;
            const secondaryValue =
              (setting?.secondary_rate ??
                (role === "總代理" ? 0.0013 : 0.0007)) * 100;
            return (
              <div key={role} className="rounded-xl bg-slate-950 p-4 text-sm">
                <b>{role}分潤</b>
                <div className="mt-3 grid gap-3">
                  <label>
                    私募百分比
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      defaultValue={privateValue}
                      id={`private-${role}`}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 p-2"
                    />
                  </label>
                  <label>
                    二級市場百分比
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.001"
                      defaultValue={secondaryValue}
                      id={`secondary-${role}`}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 p-2"
                    />
                  </label>
                  <p className="text-xs text-slate-500">
                    目前：私募 {privateValue}% · 二級市場 {secondaryValue}%
                  </p>
                  <button
                    onClick={() => void setRates(role)}
                    className="rounded-lg bg-amber-400 px-4 py-2 font-bold text-slate-950"
                  >
                    儲存兩項比例
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <button
            disabled={busy}
            onClick={() => void payout()}
            className="rounded-xl bg-amber-400 p-3 font-bold text-slate-950"
          >
            全平台派發
          </button>
          <button
            disabled={busy}
            onClick={() => void payout("總代理")}
            className="rounded-xl border border-amber-500/40 p-3 font-semibold text-amber-200"
          >
            派發總代理
          </button>
          <button
            disabled={busy}
            onClick={() => void payout("代理")}
            className="rounded-xl border border-amber-500/40 p-3 font-semibold text-amber-200"
          >
            派發代理
          </button>
        </div>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="text-slate-500">
                <th className="p-3">選取</th>
                <th>用戶</th>
                <th>角色</th>
                <th>待領獎金</th>
                <th>發放狀態</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((row) => (
                <tr key={row.id} className="border-t border-slate-800">
                  <td className="p-3">
                    <input
                      aria-label={`選取 ${row.email}`}
                      type="checkbox"
                      checked={selected.includes(row.id)}
                      onChange={(e) =>
                        setSelected((v) =>
                          e.target.checked
                            ? [...v, row.id]
                            : v.filter((id) => id !== row.id),
                        )
                      }
                    />
                  </td>
                  <td>{row.email}</td>
                  <td>{row.agency_role}</td>
                  <td className="text-amber-200">{money(row.amount)}</td>
                  <td>
                    {row.amount > 0
                      ? "待發放"
                      : row.lastPaid
                        ? `已發放 · 上次 ${new Date(row.lastPaid).toLocaleString()}`
                        : "尚無獎金"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          disabled={busy || selected.length === 0}
          onClick={() => void payout(undefined, selected)}
          className="mt-4 w-full rounded-xl border border-amber-500/40 p-3 font-bold text-amber-200 disabled:opacity-40"
        >
          派發已選取人員（{selected.length}）
        </button>
        <div className="mt-6">
          <h4 className="font-semibold">最近派發日誌</h4>
          <div className="mt-3 flex flex-col gap-2">
            {batches.map((batch) => (
              <div
                key={batch.id}
                className="flex flex-col justify-between gap-1 rounded-xl bg-slate-950 p-3 text-sm sm:flex-row"
              >
                <span>
                  <CheckCircle2 className="mr-2 inline size-4 text-emerald-400" />
                  {batch.scope === "all"
                    ? "全平台"
                    : batch.scope === "role"
                      ? batch.role_filter
                      : "指定人員"}{" "}
                  · {batch.recipient_count} 人 · {money(batch.total_amount)}
                </span>
                <time className="text-xs text-slate-500">
                  {new Date(batch.created_at).toLocaleString()}
                </time>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
