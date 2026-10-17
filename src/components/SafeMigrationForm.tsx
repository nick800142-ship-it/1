import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { callRelayer } from "@/lib/onchainSettlement";

type MigrationPreview = {
  newSafe: string;
  newOwners: string[];
  newThreshold: number;
  steps: string[];
  skipped: string[];
  needsAccept: string[];
};

type RunTask = (id: string, task: () => Promise<unknown>, success: string) => Promise<void>;

export function SafeMigrationForm({ busy, run }: { busy: boolean; run: RunTask }) {
  const [newSafe, setNewSafe] = useState("");
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    setError(null);
    setPreview(null);
    try {
      setPreview((await callRelayer("safe-migrate-preview", { newSafe: newSafe.trim() })) as unknown as MigrationPreview);
    } catch (e) {
      setError(e instanceof Error ? e.message : "檢查失敗");
    } finally {
      setChecking(false);
    }
  };

  const propose = () => {
    if (!preview) return;
    if (!window.confirm(`確定建立「更換 Safe 為 ${preview.newSafe}」提案？執行後舊 Safe 的資產與管理權會全部移到新 Safe，無法由舊 Safe 撤回。`)) return;
    void run(
      "migrate",
      async () => {
        await callRelayer("safe-propose-migration", { newSafe: preview.newSafe });
        setPreview(null);
        setNewSafe("");
      },
      "已建立「更換 Safe」提案，請用目前簽署人的 Ledger 簽署。",
    );
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
      <h4 className="flex items-center gap-2 text-sm font-bold text-red-200">
        <AlertTriangle className="size-4" aria-hidden="true" />
        更換 Safe 地址
      </h4>
      <p className="text-xs leading-relaxed text-slate-400">
        輸入已在同一條鏈上建立好的新 Safe。系統會先檢查並列出所有動作，確認後建立提案，由目前 Safe 的簽署人用 Ledger 簽署：先搬資產、改手續費收款地址，最後才移交合約管理權。新 Safe 門檻至少需 2。
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <input
          value={newSafe}
          onChange={(event) => {
            setNewSafe(event.target.value);
            setPreview(null);
          }}
          placeholder="新 Safe 地址 0x…"
          aria-label="新 Safe 地址"
          className="min-h-10 min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 font-mono text-xs text-slate-200"
        />
        <button
          type="button"
          disabled={busy || checking || !/^0x[0-9a-fA-F]{40}$/.test(newSafe.trim())}
          onClick={() => void check()}
          className="min-h-10 rounded-lg border border-slate-600 px-4 text-sm text-slate-200 disabled:opacity-50"
        >
          {checking ? "檢查中…" : "檢查"}
        </button>
      </div>
      {error && <p className="text-sm text-red-300">{error}</p>}
      {preview && (
        <div className="flex flex-col gap-3 rounded-lg bg-slate-950 p-3 text-xs">
          <p className="text-slate-300">
            新 Safe 簽署人 {preview.newOwners.length} 位，門檻 {preview.newThreshold}/{preview.newOwners.length}
          </p>
          <div className="flex flex-col gap-1">
            <p className="font-bold text-slate-200">將執行（依序）</p>
            <ol className="list-decimal space-y-1 pl-5 text-slate-300">
              {preview.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
          {preview.skipped.length > 0 && (
            <div className="flex flex-col gap-1 text-amber-200">
              <p className="font-bold">不會移交（目前不由 Safe 管理）</p>
              <ul className="list-disc space-y-1 pl-5">
                {preview.skipped.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {preview.needsAccept.length > 0 && (
            <p className="text-sky-200">
              執行後，還需以新 Safe 對 {preview.needsAccept.join("、")} 執行「接受管理權」才生效。
            </p>
          )}
          {preview.newThreshold < 2 ? (
            <p className="text-red-300">新 Safe 門檻只有 1，請先把門檻調到至少 2 再更換。</p>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={propose}
              className="min-h-10 self-start rounded-lg bg-red-400 px-4 text-sm font-bold text-slate-950 disabled:opacity-50"
            >
              建立更換提案
            </button>
          )}
        </div>
      )}
    </div>
  );
}
