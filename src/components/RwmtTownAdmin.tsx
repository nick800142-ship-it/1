import { useEffect, useState } from "react";
import { Notice } from "@/components/Modal";
import { supabase } from "@/lib/supabase";

type Theme = "modern" | "cyber" | "medieval" | "steam";
type Config = { theme: Theme; night: boolean; house_count: number; house_gap: number };
type RoundInfo = { round_no: number; ae_total: number; ae_remaining: number; status: "active" | "ended"; theme: Theme; house_count: number; bomb_jc: number };

const defaults: Config = { theme: "modern", night: false, house_count: 10000, house_gap: 3.2 };
const themeOptions: { value: Theme; label: string }[] = [
  { value: "modern", label: "現代清新小鎮" },
  { value: "cyber", label: "賽博朋克霓虹城" },
  { value: "medieval", label: "中古世紀石造村落" },
  { value: "steam", label: "蒸氣龐克工業風" },
];
const inputClass = "rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-white";

export function RwmtTownAdmin() {
  const [config, setConfig] = useState<Config>(defaults);
  const [round, setRound] = useState<RoundInfo | null>(null);
  const [aeTotal, setAeTotal] = useState(5);
  const [bombTotal, setBombTotal] = useState(300);
  const [bombJc, setBombJc] = useState(0.1);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);

  const load = async () => {
    const { data, error } = await supabase.rpc("get_rwmt_town_state");
    if (error) {
      setNotice({ text: `讀取失敗：${error.message}`, ok: false });
      return;
    }
    const state = data as { config: Partial<Config>; round: RoundInfo | null };
    setConfig({ ...defaults, ...state.config });
    setRound(state.round);
    if (state.round) setBombJc(Number(state.round.bomb_jc));
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    setSaving(true);
    setNotice(null);
    const { data, error } = await supabase.rpc("admin_set_rwmt_town_config", { p_config: config });
    setSaving(false);
    if (error) {
      setNotice({ text: `儲存失敗：${error.message}`, ok: false });
      return;
    }
    setConfig({ ...defaults, ...data });
    setNotice({ text: "房屋間距已儲存，前台重新整理後生效。", ok: true });
  };

  const active = round?.status === "active";

  const startRound = async () => {
    const force = active;
    if (force && !window.confirm(`第 ${round?.round_no} 輪還有 ${round?.ae_remaining} 顆 AE 未被找到，確定要強制結束並開啟新一輪嗎？`)) return;
    setStarting(true);
    setNotice(null);
    const { data, error } = await supabase.rpc("admin_start_rwmt_town_round", {
      p_theme: config.theme,
      p_night: config.night,
      p_house_count: config.house_count,
      p_ae_total: aeTotal,
      p_bomb_total: bombTotal,
      p_bomb_jc: bombJc,
      p_force: force,
    });
    setStarting(false);
    if (error) {
      setNotice({ text: `開啟失敗：${error.message}`, ok: false });
      return;
    }
    setNotice({ text: `第 ${(data as { round_no: number }).round_no} 輪淘金賽已開啟。`, ok: true });
    void load();
  };

  return (
    <section className="rounded-2xl border border-cyan-400/30 bg-slate-900 p-5">
      <h2 className="text-xl font-bold text-slate-100">RWMT 小鎮淘金賽</h2>
      <p className="mt-1 text-sm text-slate-400">每輪的主題、晝夜、房屋、AE 與炸彈在開啟新一輪時設定。</p>
      {notice && <div className="mt-4"><Notice message={notice.text} tone={notice.ok ? "success" : "error"} /></div>}

      {round && (
        <div className="mt-4 grid grid-cols-2 gap-3 rounded-xl border border-slate-800 bg-slate-950 p-4 text-sm sm:grid-cols-4">
          <div><p className="text-xs text-slate-500">目前輪次</p><p className="font-bold text-white">第 {round.round_no} 輪</p></div>
          <div><p className="text-xs text-slate-500">狀態</p><p className={`font-bold ${active ? "text-emerald-300" : "text-slate-300"}`}>{active ? "進行中" : "已結束"}</p></div>
          <div><p className="text-xs text-slate-500">剩餘 AE</p><p className="font-bold text-amber-300">{round.ae_remaining} / {round.ae_total}</p></div>
          <div><p className="text-xs text-slate-500">房屋</p><p className="font-bold text-white">{round.house_count.toLocaleString()} 棟</p></div>
        </div>
      )}

      <h3 className="mt-6 text-sm font-bold text-slate-200">新一輪設定</h3>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <label className="grid gap-2 text-sm text-slate-300">
          視覺主題
          <select value={config.theme} onChange={(e) => setConfig({ ...config, theme: e.target.value as Theme })} className={inputClass}>
            {themeOptions.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        <label className="grid gap-2 text-sm text-slate-300">
          場景時段
          <select value={config.night ? "night" : "day"} onChange={(e) => setConfig({ ...config, night: e.target.value === "night" })} className={inputClass}>
            <option value="day">白天</option>
            <option value="night">夜間</option>
          </select>
        </label>
        <label className="grid gap-2 text-sm text-slate-300">
          總房子數量 <span className="text-xs text-slate-500">18 至 10,000 棟</span>
          <input type="number" min="18" max="10000" value={config.house_count} onChange={(e) => setConfig({ ...config, house_count: Number(e.target.value) })} className={inputClass} />
        </label>
        <label className="grid gap-2 text-sm text-slate-300">
          AE 總數量 <span className="text-xs text-slate-500">全平台共享，抽完即止</span>
          <input type="number" min="1" value={aeTotal} onChange={(e) => setAeTotal(Number(e.target.value))} className={inputClass} />
        </label>
        <label className="grid gap-2 text-sm text-slate-300">
          炸彈數量 <span className="text-xs text-slate-500">觸發後不重新佈置</span>
          <input type="number" min="0" value={bombTotal} onChange={(e) => setBombTotal(Number(e.target.value))} className={inputClass} />
        </label>
        <label className="grid gap-2 text-sm text-slate-300">
          炸彈扣除金額（JC）
          <input type="number" min="0" step="0.1" value={bombJc} onChange={(e) => setBombJc(Number(e.target.value))} className={inputClass} />
        </label>
      </div>
      <button type="button" disabled={starting} onClick={() => void startRound()} className="mt-5 w-full rounded-xl bg-amber-400 px-5 py-3 font-black text-slate-950 disabled:cursor-not-allowed disabled:opacity-50">
        {starting ? "開啟中…" : active ? "強制結束本輪並開啟新一輪淘金賽" : "開啟新一輪淘金賽"}
      </button>

      <div className="mt-6 border-t border-slate-800 pt-5">
        <label className="grid gap-2 text-sm text-slate-300 md:max-w-xs">
          房屋間距 <span className="text-xs text-slate-500">2.2 至 6，影響街區寬度</span>
          <input type="number" min="2.2" max="6" step="0.1" value={config.house_gap} onChange={(e) => setConfig({ ...config, house_gap: Number(e.target.value) })} className={inputClass} />
        </label>
        <button type="button" disabled={saving} onClick={() => void save()} className="mt-3 rounded-xl bg-cyan-400 px-5 py-3 font-black text-slate-950 disabled:cursor-not-allowed disabled:opacity-50">
          {saving ? "儲存中…" : "儲存房屋間距"}
        </button>
      </div>
    </section>
  );
}

export default RwmtTownAdmin;
