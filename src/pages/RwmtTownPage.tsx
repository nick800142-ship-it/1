import { lazy, Suspense, useMemo, useState } from "react";
import useSWR from "swr";
import { BookOpen, Bomb, Eye, House, Loader2, LocateFixed, Mountain, Trophy, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { buildTownLayout, TOWN_THEMES, type HouseLot, type TownTheme } from "@/components/town/townLayout";
import type { CameraFocus, CameraView, OpenedHouse } from "@/components/town/TownScene";

const TownScene = lazy(() => import("@/components/town/TownScene").then((m) => ({ default: m.TownScene })));

type Round = {
  id: number;
  round_no: number;
  theme: TownTheme;
  night: boolean;
  house_count: number;
  ae_total: number;
  ae_remaining: number;
  bomb_jc: number;
  status: "active" | "ended";
};
type TownState = { config: { house_gap?: number; theme?: TownTheme; night?: boolean; house_count?: number }; round: Round | null; opened: OpenedHouse[] };
type OpenResult = { result: OpenedHouse["result"]; jcPenalty: number; penaltyStatus: string; already: boolean };

const fetchState = async (): Promise<TownState> => {
  const { data, error } = await supabase.rpc("get_rwmt_town_state");
  if (error) throw error;
  return data as TownState;
};

const fetchChallenge = async ([, , house]: [string, number, number]): Promise<string> => {
  const { data, error } = await supabase.rpc("get_rwmt_town_challenge", { p_house: house });
  if (error) throw error;
  return (data as { question: string }).question;
};

function errorText(message: string) {
  if (message.includes("cooldown")) return "炸彈冷卻修復中，請 10 分鐘後再開門。";
  if (message.includes("no active round")) return "本輪淘金賽已結束，請等待管理員開啟新一輪。";
  if (message.includes("account frozen")) return "帳號目前無法參與遊戲，請聯繫客服。";
  if (message.includes("not authenticated")) return "請先登入後再開門。";
  return `開門失敗：${message}`;
}

export function RwmtTownPage() {
  const { data: state, mutate, isLoading } = useSWR("rwmt-town-state", fetchState, { refreshInterval: 15000 });
  const [selected, setSelected] = useState<HouseLot | null>(null);
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OpenResult | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [view, setView] = useState<CameraView>("aerial");
  const [focus, setFocus] = useState<CameraFocus>(null);
  const [recenter, setRecenter] = useState(0);

  const round = state?.round ?? null;
  const theme: TownTheme = round?.theme ?? state?.config.theme ?? "modern";
  const night = round?.night ?? state?.config.night ?? false;
  const houseCount = round?.house_count ?? state?.config.house_count ?? 10000;
  const gap = state?.config.house_gap ?? 3.2;
  const layout = useMemo(() => buildTownLayout(houseCount, gap), [houseCount, gap]);
  const opened = state?.opened ?? [];
  const active = round?.status === "active";
  const openedResult = selected ? opened.find((o) => o.house === selected.index) : undefined;

  const { data: question, error: questionError } = useSWR(
    selected && active && !openedResult ? ["rwmt-town-challenge", round!.id, selected.index] : null,
    fetchChallenge,
    { revalidateOnFocus: false },
  );

  const openHouse = (house: HouseLot) => {
    setSelected(house);
    setAnswer("");
    setError(null);
    setResult(null);
    setFocus({ x: house.x, z: house.z, facing: house.rot === 0 ? 1 : -1, key: Date.now() });
  };

  const close = () => {
    setSelected(null);
    setResult(null);
    setError(null);
  };

  const submit = async () => {
    if (!selected || submitting) return;
    const value = answer.trim();
    if (!/^-?\d+$/.test(value)) {
      setError("請輸入整數答案。");
      return;
    }
    setSubmitting(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc("rwmt_town_open_house", { p_house: selected.index, p_answer: Number(value) });
    setSubmitting(false);
    if (rpcError) {
      setError(errorText(rpcError.message));
      return;
    }
    const res = data as { correct: boolean; result?: OpenedHouse["result"]; jc_penalty?: number; penalty_status?: string; already?: boolean };
    if (!res.correct) {
      setError("答案不正確，門沒有打開。請再算一次。");
      return;
    }
    setResult({ result: res.result ?? "empty", jcPenalty: Number(res.jc_penalty ?? 0), penaltyStatus: res.penalty_status ?? "none", already: Boolean(res.already) });
    if (res.result === "ae" && !res.already && round) {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (token) {
        const payoutResponse = await fetch("/api/relayer", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "town-ae-payout", roundId: round.id, houseIndex: selected.index }),
        });
        if (!payoutResponse.ok) {
          const payload = await payoutResponse.json().catch(() => ({})) as { error?: string };
          setError(payload.error ?? "AE 發放失敗，請保留畫面並聯絡管理員重試。");
        }
      }
    }
    void mutate();
  };

  const palette = TOWN_THEMES[theme];
  const aeTotal = round?.ae_total ?? 0;
  const aeRemaining = round?.ae_remaining ?? 0;

  return (
    <section className="relative -mx-4 -mt-4 h-[calc(100dvh-8.5rem)] min-h-[520px] overflow-hidden border-y border-slate-800 bg-slate-950 sm:mx-0 sm:mt-0 sm:rounded-3xl sm:border lg:h-[calc(100dvh-5rem)]">
      <Suspense fallback={<SceneLoading />}>
        {isLoading && !state ? (
          <SceneLoading />
        ) : (
          <TownScene
            layout={layout}
            theme={theme}
            night={night}
            opened={opened}
            selected={selected?.index ?? null}
            view={view}
            focus={focus}
            recenter={recenter}
            onHouse={openHouse}
          />
        )}
      </Suspense>

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3 sm:p-4">
        <div className="pointer-events-auto w-40 rounded-xl border border-white/10 bg-slate-950/70 px-2.5 py-2 text-white shadow-lg backdrop-blur-md">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[9px] font-bold tracking-[0.18em] text-cyan-300">{round ? `ROUND ${round.round_no}` : "PREVIEW"}</p>
            <p className="truncate text-[10px] text-slate-400">{palette.name}</p>
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <Trophy className="size-4 shrink-0 text-amber-300" aria-hidden="true" />
            <p className="text-[11px] text-slate-300">剩餘 AE</p>
            <p className="ml-auto text-lg font-black leading-none text-amber-300">
              {aeRemaining}
              <span className="text-[11px] font-bold text-slate-400">/{aeTotal}</span>
            </p>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-800" role="progressbar" aria-valuemin={0} aria-valuemax={aeTotal} aria-valuenow={aeRemaining} aria-label="剩餘 AE">
            <div className="h-full rounded-full bg-amber-300 transition-all" style={{ width: `${aeTotal ? (aeRemaining / aeTotal) * 100 : 0}%` }} />
          </div>
          <p className="mt-1 text-[10px] text-slate-400">已解鎖 {opened.length} / {houseCount.toLocaleString()} 棟</p>
          {round && !active && <p className="mt-1 rounded bg-rose-500/15 px-1.5 py-1 text-[10px] font-bold text-rose-200">本輪已結束，等待新一輪</p>}
        </div>
        <div className="pointer-events-auto flex flex-col gap-2">
          <HudButton label="遊戲規則" onClick={() => setShowRules(true)}>
            <BookOpen className="size-5" />
          </HudButton>
          <HudButton label={view === "aerial" ? "切換街景視角" : "切換鳥瞰視角"} onClick={() => setView(view === "aerial" ? "street" : "aerial")}>
            {view === "aerial" ? <Eye className="size-5" /> : <Mountain className="size-5" />}
          </HudButton>
          <HudButton label="回到市中心" onClick={() => setRecenter((n) => n + 1)}>
            <LocateFixed className="size-5" />
          </HudButton>
        </div>
      </div>

      <p className="pointer-events-none absolute inset-x-0 bottom-3 mx-auto w-fit max-w-[92%] rounded-full bg-slate-950/70 px-4 py-2 text-center text-[11px] font-medium text-slate-200 backdrop-blur">
        拖曳移動 · 雙指旋轉／縮放 · 點擊任一房屋開門
      </p>

      {selected && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 p-3 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="town-room-title">
          <div className="w-full max-w-md rounded-3xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold tracking-widest text-cyan-300">HOUSE #{(selected.index + 1).toLocaleString()}</p>
                <h2 id="town-room-title" className="mt-1 text-xl font-black text-white">
                  {result && !result.already ? "開門結果" : openedResult || result ? "已解鎖" : "開門驗證"}
                </h2>
              </div>
              <button type="button" onClick={close} aria-label="關閉" className="rounded-full p-2 text-slate-400 hover:bg-slate-800 hover:text-white">
                <X className="size-5" />
              </button>
            </div>

            {result || openedResult ? (
              <ResultView
                result={result?.result ?? openedResult!.result}
                already={!result || result.already}
                jcPenalty={result?.jcPenalty ?? 0}
                penaltyStatus={result?.penaltyStatus ?? "none"}
                onClose={close}
              />
            ) : !active ? (
              <p className="mt-5 rounded-xl bg-slate-950 p-4 text-sm text-slate-300">本輪淘金賽已結束，請等待管理員開啟新一輪。</p>
            ) : (
              <>
                <p className="mt-4 text-sm text-slate-400">解出三位數雙重四則運算即可開門，答對後即時抽獎。</p>
                <div className="mt-3 rounded-2xl border border-slate-700 bg-slate-950 px-4 py-5 text-center">
                  {questionError ? (
                    <p className="text-sm text-rose-300">{errorText(String(questionError.message ?? questionError))}</p>
                  ) : question ? (
                    <p className="font-mono text-2xl font-black tracking-wide text-white sm:text-3xl">{question} = ?</p>
                  ) : (
                    <Loader2 className="mx-auto size-6 animate-spin text-slate-400" aria-label="載入題目中" />
                  )}
                </div>
                <input
                  autoFocus
                  inputMode="numeric"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value.replace(/[^\d-]/g, ""))}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === "Enter") void submit();
                  }}
                  placeholder="輸入答案"
                  aria-label="答案"
                  className="mt-3 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-center text-lg font-bold text-white outline-none focus:border-cyan-400"
                />
                {error && <p className="mt-3 rounded-xl bg-rose-500/10 p-3 text-center text-sm font-bold text-rose-200">{error}</p>}
                <button
                  type="button"
                  disabled={submitting || !question}
                  onClick={() => void submit()}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-400 px-4 py-3 font-black text-slate-950 disabled:opacity-50"
                >
                  {submitting && <Loader2 className="size-4 animate-spin" />}
                  {submitting ? "開門中…" : "確認開門"}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {showRules && <RulesDialog bombJc={round?.bomb_jc ?? 0.1} onClose={() => setShowRules(false)} />}
    </section>
  );
}

function SceneLoading() {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-400">
      <Loader2 className="size-5 animate-spin" /> 正在建立 3D 小鎮…
    </div>
  );
}

function HudButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-11 items-center justify-center rounded-xl border border-white/10 bg-slate-950/75 text-white shadow-lg backdrop-blur-md transition hover:bg-slate-800"
    >
      {children}
    </button>
  );
}

function ResultView({
  result,
  already,
  jcPenalty,
  penaltyStatus,
  onClose,
}: {
  result: OpenedHouse["result"];
  already: boolean;
  jcPenalty: number;
  penaltyStatus: string;
  onClose: () => void;
}) {
  const config = {
    ae: { icon: Trophy, title: "恭喜挖到 AE！", text: "獎勵已記錄，將由平台發放到你的錢包。", tone: "text-amber-300", ring: "bg-amber-400/15 shadow-[0_0_60px_rgba(250,204,21,.45)]" },
    bomb: {
      icon: Bomb,
      title: "踩中炸彈！",
      text:
        penaltyStatus === "charged"
          ? `已扣除 ${jcPenalty} JC，這顆炸彈已消耗，不會重新佈置。`
          : penaltyStatus === "cooldown"
            ? "JC 餘額不足，進入 10 分鐘冷卻修復。"
            : "這顆炸彈已消耗，不會重新佈置。",
      tone: "text-rose-400",
      ring: "bg-rose-500/15 shadow-[0_0_60px_rgba(244,63,94,.45)] animate-pulse",
    },
    empty: { icon: House, title: "普通房屋", text: "這間房屋沒有寶藏，換一間繼續探索吧。", tone: "text-slate-200", ring: "bg-slate-700/40" },
  }[result];
  const Icon = config.icon;
  return (
    <div className="mt-5 text-center">
      <div className={`mx-auto flex size-24 items-center justify-center rounded-full ${config.ring}`}>
        <Icon className={`size-12 ${config.tone}`} aria-hidden="true" />
      </div>
      <p className={`mt-4 text-2xl font-black ${config.tone}`}>{config.title}</p>
      {already && (
        <p className="mx-auto mt-3 w-fit rounded-full bg-emerald-400/15 px-3 py-1 text-xs font-bold text-emerald-300">已解鎖・無需再次作答</p>
      )}
      <p className="mt-2 text-sm text-slate-300">{already ? "你已打開過這間房屋，以上為當時的開門結果。" : config.text}</p>
      <button type="button" onClick={onClose} className="mt-5 w-full rounded-xl bg-slate-800 px-4 py-3 font-bold text-white hover:bg-slate-700">
        繼續探索
      </button>
    </div>
  );
}

function RulesDialog({ bombJc, onClose }: { bombJc: number; onClose: () => void }) {
  const rules = [
    "點擊 3D 小鎮中任一房屋即可開門，每位玩家每間房屋只能開一次。",
    "開門前需解出「三位數雙重四則運算」（例：(347 + 582) × 129），每棟房屋題目都不同。",
    "答對後即時隨機抽獎，房屋不綁定固定獎勵，無法事先排查或報牌。",
    "全平台共享本輪 AE 數量，被抽中即時扣減，抽完即本輪結束。",
    `抽中炸彈扣除 ${bombJc} JC；JC 不足時進入 10 分鐘冷卻修復。炸彈觸發後即消耗，不會重新佈置。`,
    "每一輪由管理員設定主題、房屋數量、AE 與炸彈，主題每輪都不同。",
  ];
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 p-3 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="town-rules-title">
      <div className="max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-3xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 id="town-rules-title" className="text-xl font-black text-white">遊戲規則</h2>
          <button type="button" onClick={onClose} aria-label="關閉" className="rounded-full p-2 text-slate-400 hover:bg-slate-800 hover:text-white">
            <X className="size-5" />
          </button>
        </div>
        <ol className="mt-4 flex flex-col gap-3">
          {rules.map((rule, i) => (
            <li key={i} className="flex gap-3 text-sm leading-relaxed text-slate-300">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-cyan-400/15 text-xs font-black text-cyan-300">{i + 1}</span>
              {rule}
            </li>
          ))}
        </ol>
        <button type="button" onClick={onClose} className="mt-5 w-full rounded-xl bg-cyan-400 px-4 py-3 font-black text-slate-950">
          開始探索
        </button>
      </div>
    </div>
  );
}

export default RwmtTownPage;
