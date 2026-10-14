import { Canvas } from "@react-three/fiber";
import { Environment, OrbitControls } from "@react-three/drei";
import { useMemo, useState } from "react";
import { Badge, Bomb, Boxes, House, Moon, Settings2, Sparkles, Sun, Trophy, X } from "lucide-react";

type Theme = "modern" | "cyber" | "medieval" | "steam";
const themes: Record<Theme, { name: string; sky: string; ground: string; house: string; accent: string }> = {
  modern: { name: "現代清新小鎮", sky: "#081a2c", ground: "#17364b", house: "#d8c7ad", accent: "#5eead4" },
  cyber: { name: "賽博朋克霓虹城", sky: "#120623", ground: "#27103d", house: "#5b35a6", accent: "#f472b6" },
  medieval: { name: "中古世紀石造村落", sky: "#201a1b", ground: "#4a3933", house: "#927c64", accent: "#fbbf24" },
  steam: { name: "蒸氣龐克工業風", sky: "#201711", ground: "#483325", house: "#a46d3d", accent: "#fb923c" },
};

function Building({ position, color, onClick, index }: { position: [number, number, number]; color: string; onClick: () => void; index: number }) {
  return (
    <group position={position} onClick={(event) => { event.stopPropagation(); onClick(); }}>
      <mesh position={[0, 0.65, 0]} castShadow>
        <boxGeometry args={[1.45, 1.3, 1.25]} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      <mesh position={[0, 1.48, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
        <coneGeometry args={[1.15, 0.8, 4]} />
        <meshStandardMaterial color={index % 2 ? "#7f1d1d" : "#334155"} roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.5, 0.66]}>
        <planeGeometry args={[0.35, 0.58]} />
        <meshStandardMaterial color="#172033" emissive="#1d4ed8" emissiveIntensity={0.18} />
      </mesh>
    </group>
  );
}

function TownScene({ theme, onHouse }: { theme: (typeof themes)[Theme]; onHouse: (index: number) => void }) {
  const houses = useMemo(() => Array.from({ length: 18 }, (_, i) => {
    const row = Math.floor(i / 6);
    const col = i % 6;
    return { position: [(col - 2.5) * 2.2, 0, (row - 1) * 2.7] as [number, number, number], index: i };
  }), []);
  return (
    <Canvas shadows camera={{ position: [7, 8, 10], fov: 42 }} gl={{ antialias: true }}>
      <color attach="background" args={[theme.sky]} />
      <ambientLight intensity={0.7} />
      <directionalLight castShadow position={[5, 10, 4]} intensity={2} color={theme.accent} />
      <Environment preset="night" />
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[22, 18]} />
        <meshStandardMaterial color={theme.ground} roughness={0.95} />
      </mesh>
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[2, 18]} />
        <meshStandardMaterial color="#202b3a" />
      </mesh>
      <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[22, 1.8]} />
        <meshStandardMaterial color="#202b3a" />
      </mesh>
      {houses.map((house) => <Building key={house.index} position={house.position} color={theme.house} index={house.index} onClick={() => onHouse(house.index)} />)}
      <OrbitControls enablePan={false} minDistance={7} maxDistance={18} minPolarAngle={0.55} maxPolarAngle={1.35} />
    </Canvas>
  );
}

export function RwmtTownPage({ isAdmin = false }: { isAdmin?: boolean }) {
  const [round, setRound] = useState(1);
  const [themeKey, setThemeKey] = useState<Theme>("modern");
  const [night, setNight] = useState(true);
  const [selectedHouse, setSelectedHouse] = useState<number | null>(null);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<"ae" | "bomb" | "empty" | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const current = themes[themeKey];
  const mathAnswer = 929 * 129;

  const openHouse = (index: number) => { setSelectedHouse(index); setAnswer(""); setResult(null); };
  const verify = () => {
    if (Number(answer) !== mathAnswer) return;
    const roll = selectedHouse === 2 ? "bomb" : selectedHouse === 7 ? "ae" : "empty";
    setResult(roll);
  };

  return (
    <section className="min-h-[calc(100vh-5rem)] overflow-hidden rounded-3xl border border-slate-800 bg-slate-950 shadow-2xl">
      <div className="relative h-[calc(100vh-6rem)] min-h-[620px]">
        <div className="absolute inset-0"><TownScene theme={current} onHouse={openHouse} /></div>
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-4 bg-gradient-to-b from-slate-950/90 to-transparent p-5 sm:p-8">
          <div><div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.28em]" style={{ color: current.accent }}><Sparkles className="size-4" /> RWMT 小鎮</div><h1 className="text-3xl font-black tracking-tight text-white sm:text-5xl">第 {round} 輪淘金賽</h1><p className="mt-2 max-w-md text-sm text-slate-300">{current.name} · 探索小鎮、解鎖房屋，尋找隱藏的 AE。</p></div>
          <div className="pointer-events-auto flex shrink-0 gap-2"><button type="button" aria-label="切換晝夜" onClick={() => setNight(!night)} className="rounded-full border border-white/15 bg-slate-950/60 p-3 text-slate-200 backdrop-blur hover:bg-white/10">{night ? <Moon className="size-5" /> : <Sun className="size-5" />}</button>{isAdmin && <button type="button" aria-label="開啟管理設定" onClick={() => setShowAdmin(true)} className="rounded-full border border-white/15 bg-slate-950/60 p-3 text-slate-200 backdrop-blur hover:bg-white/10"><Settings2 className="size-5" /></button>}</div>
        </div>
        <div className="absolute bottom-5 left-5 z-10 flex flex-wrap gap-2 sm:bottom-8 sm:left-8"><div className="rounded-2xl border border-white/10 bg-slate-950/75 px-4 py-3 backdrop-blur"><p className="text-[10px] uppercase tracking-widest text-slate-400">本輪剩餘 AE</p><p className="mt-1 text-2xl font-black text-white">4 <span className="text-sm font-medium text-slate-400">/ 5</span></p></div><button type="button" onClick={() => setShowRules(true)} className="flex items-center gap-2 rounded-2xl border border-white/10 bg-slate-950/75 px-4 py-3 text-sm font-bold text-white backdrop-blur hover:bg-slate-900"><Boxes className="size-4" /> 遊戲規則</button></div>
        <div className="absolute bottom-5 right-5 z-10 hidden rounded-2xl border border-white/10 bg-slate-950/75 px-4 py-3 text-right backdrop-blur sm:block"><p className="text-[10px] uppercase tracking-widest text-slate-400">房屋探索</p><p className="mt-1 text-lg font-bold text-white">18 / 10,000</p></div>
      </div>
      {selectedHouse !== null && <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"><div className="w-full max-w-md rounded-3xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"><div className="mb-5 flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-widest text-cyan-300">House #{selectedHouse + 1}</p><h2 className="mt-1 text-2xl font-black text-white">開門驗證</h2></div><button type="button" onClick={() => setSelectedHouse(null)} className="rounded-full p-2 text-slate-400 hover:bg-slate-800 hover:text-white"><X className="size-5" /></button></div>{result ? <div className="rounded-2xl border border-slate-700 bg-slate-950 p-6 text-center"><div className="mb-3 flex justify-center text-amber-300">{result === "ae" ? <Trophy className="size-14" /> : result === "bomb" ? <Bomb className="size-14" /> : <House className="size-14" />}</div><h3 className="text-xl font-black text-white">{result === "ae" ? "恭喜找到 AE！" : result === "bomb" ? "踩中炸彈陷阱" : "這是一間普通房屋"}</h3><p className="mt-2 text-sm text-slate-400">{result === "bomb" ? "扣除 0.1 JC，炸彈已消耗。" : result === "ae" ? "全平台剩餘 4 顆 AE。" : "下一間房屋或許有驚喜。"}</p><button type="button" onClick={() => setSelectedHouse(null)} className="mt-5 w-full rounded-xl bg-cyan-400 px-4 py-3 font-black text-slate-950">繼續探索</button></div> : <><div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/5 p-4"><p className="text-sm text-slate-300">請解答三位數雙重四則運算：</p><p className="mt-3 text-center text-2xl font-black text-cyan-200">(347 + 582) × 129 = ?</p></div><input autoFocus inputMode="numeric" value={answer} onChange={(event) => setAnswer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") verify(); }} placeholder="輸入答案" className="mt-4 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-center text-lg text-white outline-none focus:border-cyan-400" /><button type="button" onClick={verify} className="mt-4 w-full rounded-xl bg-cyan-400 px-4 py-3 font-black text-slate-950 hover:bg-cyan-300">驗證並開門</button></>
}</div></div>}
      {showRules && <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"><div className="w-full max-w-lg rounded-3xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"><div className="flex items-center justify-between"><h2 className="text-2xl font-black text-white">RWMT 小鎮規則</h2><button type="button" onClick={() => setShowRules(false)} className="rounded-full p-2 text-slate-400 hover:bg-slate-800"><X className="size-5" /></button></div><div className="mt-5 grid gap-3 text-sm text-slate-300"><p>1. 點擊房屋後，完成數學驗證即可開門。</p><p>2. AE 採全平台共享隨機抽取，抽完即止，不綁定固定房屋。</p><p>3. 炸彈會扣除 0.1 JC，觸發後不會重新佈置。</p><p>4. 每顆 AE 被找到時，Telegram 會自動廣播全網。</p><p>5. 請勿使用腳本或自動化工具，系統會保留探索紀錄。</p></div></div></div>}
      {showAdmin && <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"><div className="w-full max-w-lg rounded-3xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"><div className="flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-widest text-amber-300">Admin Panel</p><h2 className="mt-1 text-2xl font-black text-white">新一輪淘金賽設定</h2></div><button type="button" onClick={() => setShowAdmin(false)} className="rounded-full p-2 text-slate-400 hover:bg-slate-800"><X className="size-5" /></button></div><div className="mt-5 grid gap-4"><label className="grid gap-2 text-sm text-slate-300">視覺主題<select value={themeKey} onChange={(event) => setThemeKey(event.target.value as Theme)} className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white"><option value="modern">現代清新小鎮</option><option value="cyber">賽博朋克霓虹城</option><option value="medieval">中古世紀石造村落</option><option value="steam">蒸氣龐克工業風</option></select></label><div className="grid grid-cols-2 gap-3"><label className="grid gap-2 text-sm text-slate-300">炸彈扣除<input defaultValue="0.1 JC" className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white" /></label><label className="grid gap-2 text-sm text-slate-300">房屋數量<input defaultValue="10000" className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white" /></label></div><button type="button" onClick={() => { setRound((value) => value + 1); setSelectedHouse(null); setShowAdmin(false); }} className="mt-2 rounded-xl bg-amber-400 px-4 py-3 font-black text-slate-950 hover:bg-amber-300">開啟新一輪淘金賽</button></div></div></div>}
    </section>
  );
}

function formatAmount(value: number) { return new Intl.NumberFormat("zh-TW").format(value); }
