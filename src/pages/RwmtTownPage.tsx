import { useEffect, useMemo, useState } from "react";
import { Bomb, House, Moon, Sparkles, Sun, Trophy, X } from "lucide-react";
import { supabase } from "@/lib/supabase";

type Theme = "modern" | "cyber" | "medieval" | "steam";
type Config = { theme: Theme; night: boolean; house_count: number; house_gap: number };
const defaults: Config = { theme: "modern", night: true, house_count: 48, house_gap: 3.2 };
const themes: Record<Theme, { name: string; sky: string; ground: string; house: string; roof: string; accent: string }> = {
  modern: { name: "現代清新小鎮", sky: "#081a2c", ground: "#17364b", house: "#d8c7ad", roof: "#334155", accent: "#5eead4" },
  cyber: { name: "賽博朋克霓虹城", sky: "#120623", ground: "#27103d", house: "#6d4bc0", roof: "#f472b6", accent: "#f472b6" },
  medieval: { name: "中古世紀石造村落", sky: "#201a1b", ground: "#4a3933", house: "#927c64", roof: "#5b4638", accent: "#fbbf24" },
  steam: { name: "蒸氣龐克工業風", sky: "#201711", ground: "#483325", house: "#a46d3d", roof: "#6b4428", accent: "#fb923c" },
};

function HouseCard({ index, color, roof, onClick }: { index: number; color: string; roof: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="group relative flex h-32 w-36 shrink-0 flex-col items-center justify-end rounded-2xl border border-white/10 bg-white/[0.04] pb-3 transition hover:-translate-y-2 hover:border-white/30" aria-label={`探索第 ${index + 1} 棟房屋`}>
    <div className="absolute top-4 h-14 w-20 rounded-md shadow-lg" style={{ backgroundColor: color }}><div className="absolute -top-6 left-1/2 -translate-x-1/2 border-x-[42px] border-b-[28px] border-x-transparent" style={{ borderBottomColor: roof }} /><div className="absolute bottom-0 left-1/2 h-7 w-4 -translate-x-1/2 rounded-t bg-slate-950/80" /><div className="absolute bottom-2 left-2 h-3 w-3 rounded-sm bg-cyan-200/70" /></div>
    <span className="relative z-10 text-xs font-bold text-white/70">房屋 #{index + 1}</span>
  </button>;
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
  return <section className="min-h-[calc(100vh-5rem)] overflow-hidden rounded-3xl border border-slate-800 shadow-2xl" style={{ backgroundColor: theme.sky }}>
    <div className="relative min-h-[calc(100vh-6rem)] p-5 sm:p-8" style={{ background: `linear-gradient(180deg, ${theme.sky} 0%, ${theme.sky} 38%, ${theme.ground} 100%)` }}>
      <header className="relative z-10 flex items-start justify-between gap-4"><div><div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.28em]" style={{ color: theme.accent }}><Sparkles className="size-4" /> RWMT 小鎮</div><h1 className="mt-2 text-3xl font-black text-white sm:text-5xl">探索小鎮</h1><p className="mt-2 text-sm text-slate-300">{theme.name} · 共 {config.house_count} 棟房屋</p></div><div className="flex gap-2"><div className="rounded-full border border-white/15 bg-black/20 p-3 text-slate-200" aria-label={config.night ? "夜間" : "白天"}>{config.night ? <Moon className="size-5" /> : <Sun className="size-5" />}</div></div></header>
      <div className="relative z-10 mt-8 grid justify-items-center gap-4 sm:grid-cols-2 lg:grid-cols-4" style={{ columnGap: `${Math.max(config.house_gap, 2.2)}rem`, rowGap: "2.5rem" }}>{houses.map((index) => <HouseCard key={index} index={index} color={theme.house} roof={theme.roof} onClick={() => open(index)} />)}</div>
      <div className="relative z-10 mt-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/25 p-4 text-sm text-slate-300"><span>目前設定：{config.night ? "夜間" : "白天"} · {config.house_count} 棟房屋</span><button type="button" onClick={() => setRules(true)} className="rounded-xl border border-white/15 px-4 py-2 font-bold text-white hover:bg-white/10">遊戲規則</button></div>
    </div>
    {selected !== null && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><div className="w-full max-w-md rounded-3xl border border-slate-700 bg-slate-900 p-6"><div className="flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-widest text-cyan-300">House #{selected + 1}</p><h2 className="mt-1 text-2xl font-black text-white">開門驗證</h2></div><button type="button" onClick={() => setSelected(null)} aria-label="關閉" className="rounded-full p-2 text-slate-400 hover:bg-slate-800"><X className="size-5" /></button></div>{result ? <div className="mt-5 rounded-2xl bg-slate-950 p-6 text-center"><div className="flex justify-center text-amber-300">{result === "ae" ? <Trophy className="size-14" /> : result === "bomb" ? <Bomb className="size-14" /> : <House className="size-14" />}</div><h3 className="mt-3 text-xl font-black text-white">{result === "ae" ? "恭喜找到 AE！" : result === "bomb" ? "踩中炸彈陷阱" : "這是一間普通房屋"}</h3><button type="button" onClick={() => setSelected(null)} className="mt-5 w-full rounded-xl bg-cyan-400 px-4 py-3 font-black text-slate-950">繼續探索</button></div> : <><p className="mt-5 text-sm text-slate-300">請解答：(347 + 582) × 129 = ?</p><input autoFocus value={answer} onChange={(event) => setAnswer(event.target.value)} onKeyDown={(event) => { if (!event.nativeEvent.isComposing && event.key !== "Enter") return; if (event.key === "Enter") verify(); }} placeholder="輸入答案" className="mt-4 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-center text-lg text-white" /><button type="button" onClick={verify} className="mt-4 w-full rounded-xl bg-cyan-400 px-4 py-3 font-black text-slate-950">驗證開門</button></>}</div></div>}
    {rules && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><div className="w-full max-w-lg rounded-3xl border border-slate-700 bg-slate-900 p-6"><div className="flex items-center justify-between"><h2 className="text-2xl font-black text-white">RWMT 小鎮規則</h2><button type="button" onClick={() => setRules(false)} aria-label="關閉" className="p-2 text-slate-400"><X className="size-5" /></button></div><div className="mt-5 grid gap-3 text-sm text-slate-300"><p>1. 點擊房屋後完成數學驗證即可探索。</p><p>2. AE 採全平台共享抽取，抽完即止。</p><p>3. 炸彈觸發後不會重新佈置。</p></div></div></div>}
  </section>;
}
export default RwmtTownPage;
