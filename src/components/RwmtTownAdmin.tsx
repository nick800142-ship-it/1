import { useEffect, useState } from "react";
import { Notice } from "@/components/Modal";
import { supabase } from "@/lib/supabase";

type Theme = "modern" | "cyber" | "medieval" | "steam";
type Config = { theme: Theme; night: boolean; house_count: number; house_gap: number };

const defaults: Config = { theme: "modern", night: true, house_count: 10000, house_gap: 3.2 };

export function RwmtTownAdmin() {
  const [config, setConfig] = useState<Config>(defaults);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void supabase
      .from("platform_config")
      .select("rwmt_town_config")
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          setNotice({ text: `讀取失敗：${error.message}`, ok: false });
          return;
        }
        if (data?.rwmt_town_config) {
          setConfig({ ...defaults, ...data.rwmt_town_config });
        }
      });
  }, []);

  const save = async () => {
    setSaving(true);
    setNotice(null);
    const { data, error } = await supabase.rpc("admin_set_rwmt_town_config", {
      p_config: config,
    });
    setSaving(false);
    if (error) {
      setNotice({ text: `儲存失敗：${error.message}`, ok: false });
      return;
    }
    setConfig({ ...defaults, ...data });
    setNotice({ text: "RWMT 小鎮設定已儲存，前台重新整理後生效。", ok: true });
  };

  return (
    <section className="rounded-2xl border border-cyan-400/30 bg-slate-900 p-5">
      <h2 className="text-xl font-bold text-slate-100">RWMT 小鎮設定</h2>
      <p className="mt-1 text-sm text-slate-400">主題、晝夜、房屋數量與間距由後台統一控制，前台不再提供設定按鈕。</p>
      {notice && <div className="mt-4"><Notice message={notice.text} tone={notice.ok ? "success" : "error"} /></div>}
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <label className="grid gap-2 text-sm text-slate-300">
          視覺主題
          <select value={config.theme} onChange={(event) => setConfig({ ...config, theme: event.target.value as Theme })} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-white">
            <option value="modern">現代清新小鎮</option><option value="cyber">賽博朋克霓虹城</option><option value="medieval">中古世紀石造村落</option><option value="steam">蒸氣龐克工業風</option>
          </select>
        </label>
        <label className="grid gap-2 text-sm text-slate-300">
          場景時段
          <select value={config.night ? "night" : "day"} onChange={(event) => setConfig({ ...config, night: event.target.value === "night" })} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-white"><option value="night">夜間</option><option value="day">白天</option></select>
        </label>
        <label className="grid gap-2 text-sm text-slate-300">
          房屋數量 <span className="text-xs text-slate-500">18 至 10,000 棟</span>
          <input type="number" min="18" max="10000" value={config.house_count} onChange={(event) => setConfig({ ...config, house_count: Number(event.target.value) })} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-white" />
        </label>
        <label className="grid gap-2 text-sm text-slate-300">
          房屋間距 <span className="text-xs text-slate-500">2.2 至 6 rem</span>
          <input type="number" min="2.2" max="6" step="0.1" value={config.house_gap} onChange={(event) => setConfig({ ...config, house_gap: Number(event.target.value) })} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-white" />
        </label>
      </div>
      <button type="button" disabled={saving} onClick={() => void save()} className="mt-5 rounded-xl bg-cyan-400 px-5 py-3 font-black text-slate-950 disabled:cursor-not-allowed disabled:opacity-50">{saving ? "儲存中…" : "儲存小鎮設定"}</button>
    </section>
  );
}

export default RwmtTownAdmin;
