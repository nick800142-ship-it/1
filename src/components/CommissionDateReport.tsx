import { Download, RotateCcw } from "lucide-react";

export type CommissionReportTotals = {
  privateAmount: number;
  secondaryAmount: number;
  totalAmount: number;
  count: number;
};

export function isWithinDateRange(
  createdAt: string,
  startDate: string,
  endDate: string,
) {
  const timestamp = new Date(createdAt).getTime();
  if (!Number.isFinite(timestamp)) return false;
  const start = startDate
    ? new Date(`${startDate}T00:00:00`).getTime()
    : -Infinity;
  const end = endDate
    ? new Date(`${endDate}T23:59:59.999`).getTime()
    : Infinity;
  return timestamp >= start && timestamp <= end;
}

export function downloadCsv(
  filename: string,
  headers: string[],
  rows: unknown[][],
) {
  const escape = (value: unknown) =>
    `"${String(value ?? "")
      .split('"')
      .join('""')}"`;
  const body = [headers, ...rows]
    .map((row) => row.map(escape).join(","))
    .join("\r\n");
  const blob = new Blob([`\ufeff${body}`], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${filename}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// 分潤彙總一律以 AE 顯示（傳入的數值已為 AE，見 AdminPage 以凍結 AE 快照彙總）。
const amount = (value: number) =>
  `${value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  })} AE`;

export function CommissionDateReport({
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  totals,
  onExport,
}: {
  startDate: string;
  endDate: string;
  onStartDateChange: (value: string) => void;
  onEndDateChange: (value: string) => void;
  totals: CommissionReportTotals;
  onExport: () => void;
}) {
  const invalid = Boolean(startDate && endDate && startDate > endDate);
  const applyPreset = (preset: "week" | "month" | "year") => {
    const today = new Date();
    const start = new Date(today);
    if (preset === "week") {
      const day = today.getDay() || 7;
      start.setDate(today.getDate() - day + 1);
    } else if (preset === "month") {
      start.setDate(1);
    } else {
      start.setMonth(0, 1);
    }
    const formatDate = (date: Date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    };
    onStartDateChange(formatDate(start));
    onEndDateChange(formatDate(today));
  };
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-400">
              快速區間
              <select
                aria-label="快速選擇日期區間"
                defaultValue=""
                onChange={(event) => {
                  const value = event.target.value as "week" | "month" | "year";
                  if (value) applyPreset(value);
                }}
                className="min-h-10 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-200"
              >
                <option value="" disabled>
                  選擇區間
                </option>
                <option value="week">本周</option>
                <option value="month">本月</option>
                <option value="year">今年</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-400">
              開始日期
              <input
                type="date"
                value={startDate}
                onChange={(event) => onStartDateChange(event.target.value)}
                className="min-h-10 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-200"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-400">
              結束日期
              <input
                type="date"
                value={endDate}
                onChange={(event) => onEndDateChange(event.target.value)}
                className="min-h-10 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-200"
              />
            </label>
            <button
              type="button"
              onClick={() => {
                onStartDateChange("");
                onEndDateChange("");
              }}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-700 px-3 text-xs font-semibold text-slate-300 hover:text-amber-200"
            >
              <RotateCcw className="size-4" />
              清除日期
            </button>
          </div>
          <button
            type="button"
            onClick={onExport}
            disabled={invalid}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-amber-400 px-4 text-sm font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="size-4" />
            匯出區間 CSV
          </button>
        </div>
        {invalid && (
          <p role="alert" className="text-sm text-red-300">
            開始日期不可晚於結束日期。
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <ReportMetric label="私募分潤" value={amount(totals.privateAmount)} />
          <ReportMetric
            label="二級分潤"
            value={amount(totals.secondaryAmount)}
          />
          <ReportMetric
            label={`分潤總計 · ${totals.count} 筆`}
            value={amount(totals.totalAmount)}
            emphasis
          />
        </div>
      </div>
    </section>
  );
}

function ReportMetric({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <b
        className={`mt-1 block break-words text-sm ${emphasis ? "text-amber-200" : "text-slate-200"}`}
      >
        {value}
      </b>
    </div>
  );
}
