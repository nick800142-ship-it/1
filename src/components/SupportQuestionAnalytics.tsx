import { useState } from "react";
import { ArrowLeft, ArrowRight, Bell, Search } from "lucide-react";
import { Modal } from "@/components/Modal";
import { supabase } from "@/lib/supabase";

type SupportSubcategory = { name: string; count: number; percentage: number };
type SupportCategory = {
  name: string;
  count: number;
  percentage: number;
  subcategories: SupportSubcategory[];
};
type SupportReport = { total: number; categories: SupportCategory[] };

const categoryNames = [
  "認購／購買流程",
  "二級市場／掛單成交",
  "AE／RWA 資產與標的",
  "錢包／JC／USDT",
  "設定／登入／帳號",
  "代理／分潤／獎金",
  "費率／價格／手續費",
  "網站操作／錯誤",
  "其他",
] as const;

function taipeiDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function initialDateRange() {
  const { year, month, day } = taipeiDateParts();
  return { start: `${year}-${month}-01`, end: `${year}-${month}-${day}` };
}

function percent(value: number) {
  return `${Number(value).toFixed(1)}%`;
}

export function SupportQuestionAnalytics() {
  const initialRange = initialDateRange();
  const [isOpen, setIsOpen] = useState(false);
  const [startDate, setStartDate] = useState(initialRange.start);
  const [endDate, setEndDate] = useState(initialRange.end);
  const [report, setReport] = useState<SupportReport | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadReport = async (start = startDate, end = endDate) => {
    if (!start || !end || start > end) {
      setError("請選擇正確的起訖日期。");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) throw new Error("登入狀態已失效，請重新登入。");
      const response = await fetch("/api/admin-support-question-analytics", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ startDate: start, endDate: end }),
      });
      const result = await response.json() as SupportReport & { error?: string };
      if (!response.ok) throw new Error(result.error || "客服數據載入失敗，請稍後再試。");
      setReport(result);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "客服數據載入失敗，請稍後再試。");
    } finally {
      setLoading(false);
    }
  };

  const openReport = () => {
    setSelectedCategory(null);
    setIsOpen(true);
    void loadReport();
  };

  const categories = report?.categories ?? categoryNames.map((name) => ({
    name,
    count: 0,
    percentage: 0,
    subcategories: [],
  }));
  const selected = categories.find((category) => category.name === selectedCategory);

  return (
    <>
      <section aria-label="客服數據收集" className="self-start w-fit">
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls="support-question-content"
          aria-label={report ? `客服數據收集，期間共 ${report.total} 題` : "客服數據收集"}
          onClick={openReport}
          className="relative inline-flex size-10 items-center justify-center rounded-full text-sky-300 transition hover:bg-sky-300/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
        >
          <Bell aria-hidden="true" className="size-6" />
          {report && report.total > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white">
              {report.total > 99 ? "99+" : report.total}
            </span>
          )}
        </button>
      </section>

      <Modal
        open={isOpen}
        onClose={() => {
          setIsOpen(false);
          setSelectedCategory(null);
        }}
        title="客服數據收集"
        closeLabel="關閉客服數據收集"
        wide
        centered
      >
        <div id="support-question-content" className="max-h-[68dvh] overflow-y-auto pr-1">
          <div className="flex flex-col gap-4">
          {selected ? (
            <>
              <button
                type="button"
                onClick={() => setSelectedCategory(null)}
                className="inline-flex w-fit items-center gap-2 rounded-lg px-2 py-2 text-sm font-medium text-sky-200 transition hover:bg-sky-300/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
              >
                <ArrowLeft aria-hidden="true" className="size-4" />
                返回問題大方向
              </button>
              <div className="rounded-2xl border border-slate-700 bg-slate-800/60 p-4">
                <div className="flex flex-wrap items-end justify-between gap-2">
                  <div>
                    <p className="text-xs text-slate-400">問題大方向</p>
                    <h3 className="mt-1 text-lg font-bold text-amber-100">{selected.name}</h3>
                  </div>
                  <p className="text-sm text-slate-300">{selected.count} 題 <span className="text-sky-200">· 佔全部 {percent(selected.percentage)}</span></p>
                </div>
                {selected.count > 0 ? (
                  <ul className="mt-4 flex flex-col gap-2">
                    {selected.subcategories.map((subcategory) => (
                      <li key={subcategory.name} className="rounded-xl border border-slate-700/80 bg-slate-950/60 p-3">
                        <div className="flex items-center justify-between gap-3 text-sm">
                          <span className="min-w-0 font-medium text-slate-100">{subcategory.name}</span>
                          <span className="shrink-0 text-slate-300">{subcategory.count} 題 · {percent(subcategory.percentage)}</span>
                        </div>
                        <div
                          className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-700"
                          role="progressbar"
                          aria-label={`${subcategory.name}佔此分類比例`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={subcategory.percentage}
                        >
                          <div className="h-full rounded-full bg-sky-400" style={{ width: `${Math.min(100, Math.max(0, subcategory.percentage))}%` }} />
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-4 rounded-xl border border-dashed border-slate-700 px-4 py-6 text-center text-sm text-slate-400">此期間沒有此分類的提問。</p>
                )}
                <p className="mt-3 text-xs text-slate-500">細項比例以「{selected.name}」分類內的提問數計算。</p>
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-3 rounded-2xl border border-slate-700 bg-slate-800/50 p-4 sm:flex-row sm:items-end">
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-semibold text-slate-400">
                  開始日期
                  <input type="date" value={startDate} max={endDate || undefined} onChange={(event) => setStartDate(event.target.value)} className="min-h-10 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100" />
                </label>
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-semibold text-slate-400">
                  結束日期
                  <input type="date" value={endDate} min={startDate || undefined} onChange={(event) => setEndDate(event.target.value)} className="min-h-10 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100" />
                </label>
                <button
                  type="button"
                  onClick={() => void loadReport()}
                  disabled={loading || !startDate || !endDate || startDate > endDate}
                  className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-sky-400 px-4 text-sm font-bold text-slate-950 transition hover:bg-sky-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Search aria-hidden="true" className="size-4" />
                  {loading ? "查詢中…" : "查詢"}
                </button>
              </div>
              <p className="text-xs text-slate-500">統計時間以台灣時間為準。大方向佔比以期間內全部提問數計算。</p>
              {error && <p role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</p>}
              {loading ? (
                <p role="status" className="rounded-xl border border-slate-700 bg-slate-800/40 px-4 py-8 text-center text-sm text-slate-300">正在整理客服數據…</p>
              ) : report ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-800/60 px-4 py-3">
                    <span className="text-sm text-slate-300">期間提問總數</span>
                    <strong className="text-xl text-amber-200">{report.total.toLocaleString("zh-TW")} 題</strong>
                  </div>
                  {report.total > 0 ? (
                    <ul className="flex max-h-[48dvh] flex-col gap-2 overflow-y-auto pr-1">
                      {categories.map((category) => (
                        <li key={category.name}>
                          <button
                            type="button"
                            onClick={() => setSelectedCategory(category.name)}
                            className="group w-full rounded-xl border border-slate-700 bg-slate-800/60 p-4 text-left transition hover:border-sky-400/60 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                          >
                            <span className="flex items-center justify-between gap-3">
                              <span className="min-w-0">
                                <span className="block font-semibold text-amber-100">{category.name}</span>
                                <span className="mt-1 block text-sm text-slate-300">{category.count} 題 <span className="text-sky-200">· {percent(category.percentage)}</span></span>
                                <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-slate-700" aria-hidden="true">
                                  <span className="block h-full rounded-full bg-sky-400" style={{ width: `${Math.min(100, Math.max(0, category.percentage))}%` }} />
                                </span>
                              </span>
                              <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-sky-300 transition-transform group-hover:translate-x-0.5" />
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="rounded-xl border border-dashed border-slate-700 px-4 py-8 text-center text-sm text-slate-400">此期間沒有客服提問紀錄。</p>
                  )}
                  <p className="text-xs leading-5 text-slate-500">只保存問題分類與細項，不保存或顯示提問原文；既有歷史紀錄會標示為「未分類」。</p>
                </>
              ) : null}
            </>
          )}
          </div>
        </div>
      </Modal>
    </>
  );
}

