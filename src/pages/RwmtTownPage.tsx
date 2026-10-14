import { useEffect, useMemo, useState } from "react";
import { Building2, Car, CloudSun, House, LampCeiling, Mountain, Store, TreePine, Waves, X } from "lucide-react";
import { supabase } from "@/lib/supabase";

type Theme = "modern" | "cyber" | "medieval" | "steam";
type Config = { theme: Theme; night: boolean; house_count: number; house_gap: number };
type Challenge = { a: number; b: number; operator: "+" | "×"; answer: number; reward: string };
const defaults: Config = { theme: "modern", night: true, house_count: 48, house_gap: 3.2 };
const themes: Record<Theme, { sky: string; ground: string; road: string; house: string; roof: string; accent: string }> = {
  modern: { sky: "#8db5c7", ground: "#6f9b63", road: "#a89b82", house: "#efe1c5", roof: "#9b5f49", accent: "#256b72" },
  cyber: { sky: "#17152e", ground: "#252445", road: "#3b3850", house: "#6656a6", roof: "#ef74b5", accent: "#58d8df" },
  medieval: { sky: "#413c49", ground: "#6d765f", road: "#9a8466", house: "#b7a486", roof: "#67483b", accent: "#e4bd63" },
  steam: { sky: "#42372d", ground: "#796146", road: "#665045", house: "#b97d45", roof: "#51382c", accent: "#ef9a4d" },
};

function challengeFor(index: number): Challenge {
  const a = 17 + ((index * 29) % 83);
  const b = 8 + ((index * 17) % 61);
  const operator = index % 3 === 0 ? "×" : "+";
  return { a, b, operator, answer: operator === "×" ? a * b : a + b, reward: index % 5 === 0 ? "AE 探索線索" : "城鎮積分" };
}

function HouseCard({ index, theme, onOpen }: { index: number; theme: typeof themes.modern; onOpen: () => void }) {
  return <button type="button" onClick={onOpen} className="group relative flex min-h-32 w-32 shrink-0 flex-col items-center justify-end rounded-xl border border-black/15 bg-black/10 pb-3 shadow-md transition hover:-translate-y-1 hover:bg-white/15 hover:shadow-xl" aria-label={`進入第 ${index + 1} 棟房屋`}>
    <div className="relative h-16 w-20 rounded-sm shadow-lg" style={{ backgroundColor: theme.house }}>
      <div className="absolute -top-7 left-1/2 -translate-x-1/2 border-x-[42px] border-b-[29px] border-x-transparent" style={{ borderBottomColor: theme.roof }} />
      <div className="absolute bottom-0 left-1/2 h-8 w-4 -translate-x-1/2 rounded-t bg-black/45" />
      <div className="absolute bottom-3 left-3 h-3 w-3 rounded-sm bg-amber-200 shadow-[0_0_8px_#fde68a]" /><div className="absolute bottom-3 right-3 h-3 w-3 rounded-sm bg-amber-200 shadow-[0_0_8px_#fde68a]" />
    </div><span className="relative z-10 mt-2 text-xs font-bold text-white drop-shadow">#{index + 1} · 進入探索</span>
  </button>;
}

function Landmark({ icon: Icon, label, className = "" }: { icon: typeof Store; label: string; className?: string }) {
  return <div className={`flex min-h-28 min-w-36 flex-col items-center justify-center rounded-2xl border border-white/20 bg-black/20 p-4 text-white shadow-inner ${className}`}><Icon className="size-8 text-amber-200" /><span className="mt-2 text-xs font-black tracking-wide">{label}</span></div>;
}

export function RwmtTownPage() {
  const [config, setConfig] = useState<Config>(defaults);
  const [selected, setSelected] = useState<number | null>(null);
  const [answer, setAnswer] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const theme = themes[config.theme];
  const houses = useMemo(() => Array.from({ length: config.house_count }, (_, index) => index), [config.house_count]);
  const challenge = selected === null ? null : challengeFor(selected);
  useEffect(() => { void supabase.from("platform_config").select("rwmt_town_config").maybeSingle().then(({ data }) => { if (data?.rwmt_town_config) setConfig({ ...defaults, ...data.rwmt_town_config }); }); }, []);
  const openHouse = (index: number) => { setSelected(index); setAnswer(""); setMessage(null); };
  const verify = () => { if (!challenge) return; setMessage(Number(answer) === challenge.answer ? `回答正確，獲得${challenge.reward}。` : "答案不正確，再看看房間裡的線索。"); };
  const mapWidth = Math.max(920, 820 + Math.ceil(config.house_count / 12) * 170);
  const gap = Math.max(2.2, config.house_gap);

  return <section className="min-h-[calc(100vh-5rem)] overflow-hidden rounded-3xl border border-slate-800 shadow-2xl" style={{ backgroundColor: theme.sky }}>
    <div className="relative min-h-[calc(100vh-6rem)] overflow-hidden p-4 sm:p-8" style={{ background: `linear-gradient(180deg, ${theme.sky} 0%, ${theme.ground} 42%, ${theme.ground} 100%)` }}>
      <div className="pointer-events-none absolute inset-x-0 top-24 flex justify-between px-4 text-white/20"><Mountain className="size-40" /><Mountain className="mt-10 size-28" /><Mountain className="size-52" /></div>
      <header className="relative z-10 mx-auto flex max-w-6xl items-start justify-between rounded-2xl bg-black/20 p-5 backdrop-blur-sm"><div><p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.28em]" style={{ color: theme.accent }}><CloudSun className="size-4" /> RWMT 小鎮</p><h1 className="mt-2 text-3xl font-black text-white sm:text-5xl">走進一座真正的城鎮</h1><p className="mt-2 max-w-2xl text-sm text-white/75">沿著街道逛逛，進入每一間房屋，解開不同的數學問題。房屋增加時，城鎮會沿著新街區自然擴展。</p></div><div className="rounded-full border border-white/20 bg-black/20 p-3 text-white"><Waves className="size-5" /></div></header>

      <div className="relative z-10 mx-auto mt-5 overflow-x-auto rounded-3xl border-8 border-black/20 bg-[#557c4e] p-3 shadow-2xl sm:p-6"><div className="relative mx-auto overflow-hidden rounded-2xl p-5" style={{ width: mapWidth, minHeight: 920, backgroundColor: `${theme.ground}e6` }}>
        <div className="absolute inset-y-0 left-[42%] w-24 bg-[#8796a0]/30" /><div className="absolute left-0 right-0 top-[42%] h-24 bg-[#8796a0]/30" /><div className="absolute right-0 top-0 h-full w-40 bg-[#4e9fb0]/70"><Waves className="absolute left-8 top-20 size-24 text-white/30" /><Waves className="absolute bottom-36 right-4 size-20 text-white/20" /></div>
        <div className="relative grid grid-cols-[180px_1fr_180px] gap-6"><div className="flex flex-col gap-6"><Landmark icon={Mountain} label="北方山區" /><Landmark icon={TreePine} label="森林步道" /></div><div className="flex flex-col gap-8"><div className="flex items-center justify-center gap-4 rounded-xl border-y-8 border-dashed border-[#e2d3a5]/70 bg-[#a89b82] py-3 text-xs font-black tracking-[0.3em] text-[#5c5141]"><LampCeiling className="size-5" /> RWMT AVENUE <span className="rounded bg-white/70 px-2 py-1">主幹道</span><LampCeiling className="size-5" /></div><div className="grid grid-cols-2 gap-x-8 gap-y-12" style={{ padding: `${gap}rem` }}>{houses.map((index) => <div key={index} className="relative flex justify-center"><LampCeiling className="absolute -left-5 top-4 size-5 text-amber-200" /><HouseCard index={index} theme={theme} onOpen={() => openHouse(index)} /></div>)}</div><div className="grid grid-cols-4 gap-4 rounded-2xl bg-[#a89b82] p-4"><Landmark icon={Building2} label="市政廳" /><Landmark icon={Store} label="商業街" /><Landmark icon={Car} label="車站廣場" /><Landmark icon={TreePine} label="中央公園" /></div></div><div className="flex flex-col gap-6"><Landmark icon={Store} label="海港商店街" /><Landmark icon={Waves} label="海邊碼頭" /></div></div>
        <div className="absolute bottom-8 left-1/2 flex -translate-x-1/2 items-center gap-4 rounded-xl border-y-8 border-dashed border-[#e2d3a5]/70 bg-[#a89b82] px-12 py-3 text-xs font-black tracking-[0.3em] text-[#5c5141]"><LampCeiling className="size-5" /> RIVER ROAD 河畔路 <LampCeiling className="size-5" /></div>
      </div></div>
      <div className="relative z-10 mx-auto mt-5 flex max-w-6xl flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/15 bg-black/25 p-4 text-sm text-white/75"><span>城鎮目前有 {config.house_count} 棟房屋，地圖會隨新房屋增加而延伸街區</span><span className="flex items-center gap-2"><House className="size-4" />點擊房屋即可進入</span></div>
    </div>
    {selected !== null && challenge && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><div className="w-full max-w-md rounded-3xl border border-slate-700 bg-slate-900 p-6"><div className="flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-widest text-cyan-300">住宅街 · House #{selected + 1}</p><h2 className="mt-1 text-2xl font-black text-white">房間探索</h2></div><button type="button" onClick={() => setSelected(null)} aria-label="關閉" className="rounded-full p-2 text-slate-400 hover:bg-slate-800"><X className="size-5" /></button></div><p className="mt-5 text-sm text-slate-300">這間房間的門牌線索是：{challenge.a} {challenge.operator} {challenge.b} = ?</p><input autoFocus value={answer} onChange={(event) => setAnswer(event.target.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === "Enter") verify(); }} placeholder="輸入答案" className="mt-4 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-center text-lg text-white" /><button type="button" onClick={verify} className="mt-4 w-full rounded-xl bg-cyan-400 px-4 py-3 font-black text-slate-950">確認探索</button>{message && <p className="mt-4 rounded-xl bg-slate-950 p-4 text-center text-sm font-bold text-amber-200">{message}</p>}</div></div>}
  </section>;
}
export default RwmtTownPage;
