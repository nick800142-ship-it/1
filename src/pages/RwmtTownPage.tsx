import { useEffect, useMemo, useState } from "react";
import { Bomb, Building2, House, Moon, Sparkles, Sun, TreePine, Trophy, X } from "lucide-react";
import { supabase } from "@/lib/supabase";

type Theme = "modern" | "cyber" | "medieval" | "steam";
type Config = { theme: Theme; night: boolean; house_count: number; house_gap: number };
const defaults: Config = { theme: "modern", night: true, house_count: 48, house_gap: 3.2 };
const themes: Record<Theme, { name: string; sky: string; ground: string; road: string; house: string; roof: string; accent: string }> = {
  modern: { name: "現代清新小鎮", sky: "#8db5c7", ground: "#6f9b63", road: "#a89b82", house: "#efe1c5", roof: "#9b5f49", accent: "#256b72" },
  cyber: { name: "賽博朋克霓虹城", sky: "#17152e", ground: "#252445", road: "#3b3850", house: "#6656a6", roof: "#ef74b5", accent: "#58d8df" },
  medieval: { name: "中古世紀石造村落", sky: "#413c49", ground: "#6d765f", road: "#9a8466", house: "#b7a486", roof: "#67483b", accent: "#e4bd63" },
  steam: { name: "蒸氣龐克工業風", sky: "#42372d", ground: "#796146", road: "#665045", house: "#b97d45", roof: "#51382c", accent: "#ef9a4d" },
};

function HouseMarker({ index, color, roof, onClick }: { index: number; color: string; roof: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={`探索第 ${index + 1} 棟房屋`} className="group relative flex min-h-24 min-w-28 flex-col items-center justify-end rounded-lg border border-black/10 bg-black/10 pb-2 shadow-md transition hover:-translate-y-1 hover:shadow-xl">
      <div className="relative h-12 w-16 rounded-sm shadow-sm" style={{ backgroundColor: color }}>
        <div className="absolute -top-5 left-1/2 -translate-x-1/2 border-x-[34px] border-b-[23px] border-x-transparent" style={{ borderBottomColor: roof }} />
        <div className="absolute bottom-0 left-1/2 h-6 w-3 -translate-x-1/2 rounded-t bg-black/45" />
        <div className="absolute bottom-2 left-2 h-2.5 w-2.5 rounded-sm bg-amber-200/80" />
        <div className="absolute bottom-2 right-2 h-2.5 w-2.5 rounded-sm bg-amber-200/80" />
      </div>
      <span className="relative z-10 mt-1 text-[10px] font-bold text-white/80 drop-shadow">#{index + 1}</span>
    </button>
  );
}

function ServiceBlock({ icon: Icon, label, accent }: { icon: typeof Building2; label: string; accent: string }) {
  return <div className="flex min-h-24 min-w-32 flex-col items-center justify-center rounded-xl border-2 border-dashed bg-black/10 p-3 text-center shadow-inner" style={{ borderColor: `${accent}99` }}><Icon className="size-7" style={{ color: accent }} /><span className="mt-1 text-xs font-black text-white drop-shadow">{label}</span></div>;
}

export function RwmtTownPage() {
  const [config, setConfig] = useState<Config>(defaults);
  const [selected, setSelected] = useState<number | null>(null);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<"ae" | "bomb" | "empty" | null>(null);
  const [rules, setRules] = useState(false);
  const theme = themes[config.theme];

  useEffect(() => { void supabase.from("platform_config").select("rwmt_town_config").maybeSingle().then(({ data }) => { if (data?.rwmt_town_config) setConfig({ ...defaults, ...data.rwmt_town_config }); }); }, []);
  const houses = useMemo(() => Array.from({ length: config.house_count }, (_, index) => index), [config.house_count]);
  const open = (index: number) => { setSelected(index); setAnswer(""); setResult(null); };
  const verify = () => { if (Number(answer) !== (347 + 582) * 129) return; setResult(selected === 2 ? "bomb" : selected === 7 ? "ae" : "empty"); };
  const columns = Math.max(3, Math.min(6, Math.round(9 / Math.max(config.house_gap, 2.2))));
  const districtSize = Math.ceil(houses.length / 4);

  return <section className="min-h-[calc(100vh-5rem)] overflow-hidden rounded-3xl border border-slate-800 shadow-2xl" style={{ backgroundColor: theme.sky }}>
    <div className="relative min-h-[calc(100vh-6rem)] p-4 sm:p-8" style={{ background: `linear-gradient(180deg, ${theme.sky} 0%, ${theme.ground} 42%, ${theme.ground} 100%)` }}>
      <header className="relative z-10 mx-auto flex max-w-6xl items-start justify-between gap-4 rounded-2xl bg-black/15 p-4 backdrop-blur-sm"><div><div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.28em]" style={{ color: theme.accent }}><Sparkles className="size-4" /> RWMT 小鎮</div><h1 className="mt-2 text-3xl font-black text-white sm:text-5xl">一座正在生活的城鎮</h1><p className="mt-2 text-sm text-white/75">{theme.name} · 住宅區、商業街、中央公園與公共設施</p></div><div className="rounded-full border border-white/20 bg-black/20 p-3 text-white" aria-label={config.night ? "夜間" : "白天"}>{config.night ? <Moon className="size-5" /> : <Sun className="size-5" />}</div></header>

      <div className="relative z-10 mx-auto mt-5 max-w-6xl overflow-x-auto rounded-3xl border-8 border-black/15 bg-[#557c4e] p-3 shadow-2xl sm:p-6">
        <div className="min-w-[760px] rounded-2xl p-4" style={{ backgroundColor: `${theme.ground}cc` }}>
          <div className="mb-4 flex items-center justify-center gap-4 rounded-xl border-y-8 border-dashed border-[#d8c99e]/60 bg-[#a89b82] py-3 text-xs font-black tracking-[0.3em] text-[#5c5141]">RWMT AVENUE <span className="rounded bg-white/70 px-2 py-1">主幹道</span></div>
          <div className="grid grid-cols-2 gap-8">
            {[0, 1, 2, 3].map((district) => {
              const start = district * districtSize;
              const districtHouses = houses.slice(start, start + districtSize);
              return <div key={district} className="rounded-2xl border-4 border-[#54744b]/50 bg-[#739961]/70 p-4 shadow-inner"><div className="mb-3 flex items-center justify-between border-b border-white/20 pb-2"><span className="text-xs font-black uppercase tracking-widest text-white/90">{district < 2 ? "住宅街" : "河畔住宅區"} {district + 1}</span><span className="text-[10px] text-white/60">街區 {String.fromCharCode(65 + district)}</span></div><div className="grid justify-items-center gap-4" style={{ gridTemplateColumns: `repeat(${columns}, minmax(7rem, 1fr))`, gap: `${Math.max(config.house_gap, 2.2) / 2}rem` }}>{districtHouses.map((index) => <HouseMarker key={index} index={index} color={theme.house} roof={theme.roof} onClick={() => open(index)} />)}</div></div>;
            })}
          </div>
          <div className="my-8 grid grid-cols-4 gap-4 rounded-2xl bg-[#a89b82] p-4 shadow-inner"><ServiceBlock icon={Building2} label="市政廳" accent={theme.accent} /><ServiceBlock icon={TreePine} label="中央公園" accent={theme.accent} /><ServiceBlock icon={Building2} label="商業街" accent={theme.accent} /><ServiceBlock icon={House} label="車站廣場" accent={theme.accent} /></div>
          <div className="flex items-center justify-center gap-4 rounded-xl border-y-8 border-dashed border-[#d8c99e]/60 bg-[#a89b82] py-3 text-xs font-black tracking-[0.3em] text-[#5c5141]">RIVER ROAD <span className="rounded bg-white/70 px-2 py-1">河畔路</span></div>
        </div>
      </div>

      <div className="relative z-10 mx-auto mt-5 flex max-w-6xl flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/15 bg-black/25 p-4 text-sm text-white/75"><span>城鎮目前有 {config.house_count} 棟房屋，分布於四個住宅街區</span><button type="button" onClick={() => setRules(true)} className="rounded-xl border border-white/20 px-4 py-2 font-bold text-white hover:bg-white/10">遊戲規則</button></div>
    </div>
    {selected !== null && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><div className="w-full max-w-md rounded-3xl border border-slate-700 bg-slate-900 p-6"><div className="flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-widest text-cyan-300">住宅街 · House #{selected + 1}</p><h2 className="mt-1 text-2xl font-black text-white">開門驗證</h2></div><button type="button" onClick={() => setSelected(null)} aria-label="關閉" className="rounded-full p-2 text-slate-400 hover:bg-slate-800"><X className="size-5" /></button></div>{result ? <div className="mt-5 rounded-2xl bg-slate-950 p-6 text-center"><div className="flex justify-center text-amber-300">{result === "ae" ? <Trophy className="size-14" /> : result === "bomb" ? <Bomb className="size-14" /> : <House className="size-14" />}</div><h3 className="mt-3 text-xl font-black text-white">{result === "ae" ? "恭喜找到 AE！" : result === "bomb" ? "踩中炸彈陷阱" : "這是一間普通房屋"}</h3><button type="button" onClick={() => setSelected(null)} className="mt-5 w-full rounded-xl bg-cyan-400 px-4 py-3 font-black text-slate-950">繼續探索</button></div> : <><p className="mt-5 text-sm text-slate-300">請解答：(347 + 582) × 129 = ?</p><input autoFocus value={answer} onChange={(event) => setAnswer(event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === "Enter") verify(); }} placeholder="輸入答案" className="mt-4 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-center text-lg text-white" /><button type="button" onClick={verify} className="mt-4 w-full rounded-xl bg-cyan-400 px-4 py-3 font-black text-slate-950">驗證開門</button></>}</div></div>}
    {rules && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><div className="w-full max-w-lg rounded-3xl border border-slate-700 bg-slate-900 p-6"><div className="flex items-center justify-between"><h2 className="text-2xl font-black text-white">RWMT 小鎮規則</h2><button type="button" onClick={() => setRules(false)} aria-label="關閉" className="p-2 text-slate-400"><X className="size-5" /></button></div><div className="mt-5 grid gap-3 text-sm text-slate-300"><p>1. 點擊住宅後完成數學驗證即可探索。</p><p>2. AE 採全平台共享抽取，抽完即止。</p><p>3. 炸彈觸發後不會重新佈置。</p></div></div></div>}
  </section>;
}
export default RwmtTownPage;
