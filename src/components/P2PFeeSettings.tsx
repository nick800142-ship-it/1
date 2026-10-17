import { useState } from "react";
import useSWR from "swr";
import { callRelayer } from "@/lib/onchainSettlement";

type FeeStatus = {
  escrow: string;
  chain: { feeBps: number; listingFee: number };
  config: { p2p_fee_bps: number; p2p_listing_fee: number; p2p_fees_updated_at: string | null } | null;
  inSync: boolean;
  legacyOpenOrders: number;
};

const fetchStatus = () => callRelayer("admin-p2p-fees") as Promise<FeeStatus>;

export function P2PFeeSettings() {
  const { data, error, isLoading, mutate } = useSWR<FeeStatus>("admin-p2p-fees", fetchStatus);
  const [feePercent, setFeePercent] = useState("");
  const [listingFee, setListingFee] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const currentPercent = data ? data.chain.feeBps / 100 : null;
  const nextPercent = feePercent.trim() === "" ? currentPercent : Number(feePercent);
  const nextListing = listingFee.trim() === "" ? data?.chain.listingFee ?? null : Number(listingFee);
  const nextBps = nextPercent == null ? null : Math.round(nextPercent * 100);
  const percentValid = nextPercent != null && Number.isFinite(nextPercent) && nextPercent >= 0 && nextPercent <= 5
    && Math.abs(nextPercent * 100 - Math.round(nextPercent * 100)) < 1e-9;
  const listingValid = nextListing != null && Number.isFinite(nextListing) && nextListing >= 0 && nextListing <= 10
    && /^\d+(\.\d{1,6})?$/.test(String(listingFee.trim() || nextListing));
  const changed = Boolean(data) && (nextBps !== data?.chain.feeBps || nextListing !== data?.chain.listingFee);

  const save = async () => {
    if (!percentValid || !listingValid || nextBps == null || nextListing == null || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      await callRelayer("admin-set-p2p-fees", {
        feeBps: nextBps,
        listingFee: listingFee.trim() || String(nextListing),
      });
      setMessage({ text: "已建立 Safe 提案。請到「Safe 簽核」用 Ledger 簽署，執行後費率才會生效（只套用到之後的新掛單）。", ok: true });
      setFeePercent("");
      setListingFee("");
      setConfirming(false);
      await mutate();
    } catch (saveError) {
      setMessage({ text: saveError instanceof Error ? saveError.message : "費率更新失敗", ok: false });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="p2p-fee-title" className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex flex-col gap-1">
        <h3 id="p2p-fee-title" className="font-bold text-slate-100">二級市場費率</h3>
        <p className="text-xs leading-relaxed text-slate-400">
          調整後只影響之後的新掛單；已掛出的單一律沿用掛出當下的費率（舊合約掛單固定 1% / 1 JC）。
        </p>
      </div>

      {isLoading && <p className="mt-4 text-sm text-slate-400">讀取鏈上費率中…</p>}
      {error && <p role="alert" className="mt-4 text-sm text-red-300">{error instanceof Error ? error.message : "費率讀取失敗"}</p>}

      {data && (
        <div className="mt-4 flex flex-col gap-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div className="rounded-xl bg-slate-950 p-3">
              <dt className="text-xs text-slate-500">成交手續費（目前）</dt>
              <dd className="mt-1 font-bold text-slate-100">{currentPercent}%</dd>
            </div>
            <div className="rounded-xl bg-slate-950 p-3">
              <dt className="text-xs text-slate-500">掛賣單費（目前）</dt>
              <dd className="mt-1 font-bold text-slate-100">{data.chain.listingFee} JC</dd>
            </div>
            <div className="rounded-xl bg-slate-950 p-3">
              <dt className="text-xs text-slate-500">舊合約未完成掛單</dt>
              <dd className="mt-1 font-bold text-slate-100">{data.legacyOpenOrders} 筆（照常運作）</dd>
            </div>
          </dl>
          {!data.inSync && (
            <p role="status" className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-200">
              鏈上費率與後台紀錄不一致，請重新儲存一次以同步。
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-2 text-sm text-slate-300">
              新成交手續費（%）
              <input
                type="text"
                inputMode="decimal"
                value={feePercent}
                onChange={(event) => { setFeePercent(event.target.value); setConfirming(false); }}
                placeholder={String(currentPercent)}
                aria-invalid={!percentValid}
                className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100"
              />
              <span className="text-xs text-slate-500">0%～5%，最小單位 0.01%</span>
            </label>
            <label className="flex flex-col gap-2 text-sm text-slate-300">
              新掛賣單費（JC）
              <input
                type="text"
                inputMode="decimal"
                value={listingFee}
                onChange={(event) => { setListingFee(event.target.value); setConfirming(false); }}
                placeholder={String(data.chain.listingFee)}
                aria-invalid={!listingValid}
                className="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100"
              />
              <span className="text-xs text-slate-500">0～10 JC，最多 6 位小數；取消掛單不退</span>
            </label>
          </div>

          {message && (
            <p role={message.ok ? "status" : "alert"} className={`rounded-xl p-3 text-sm ${message.ok ? "bg-emerald-400/10 text-emerald-200" : "bg-red-400/10 text-red-200"}`}>
              {message.text}
            </p>
          )}

          {confirming ? (
            <div className="flex flex-col gap-3 rounded-xl border border-amber-400/30 bg-amber-400/5 p-4 text-sm text-amber-100">
              <p>確認將新掛單費率改為：成交 {nextPercent}%、掛賣單 {nextListing} JC？此操作會送出一筆鏈上交易。</p>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button type="button" disabled={saving} onClick={() => setConfirming(false)} className="rounded-xl border border-slate-700 px-4 py-2 font-bold text-slate-300 disabled:opacity-50">
                  取消
                </button>
                <button type="button" disabled={saving} onClick={() => void save()} className="rounded-xl bg-amber-400 px-4 py-2 font-bold text-slate-950 disabled:cursor-wait disabled:opacity-60">
                  {saving ? "上鏈中…" : "確認更新"}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={!changed || !percentValid || !listingValid}
              onClick={() => setConfirming(true)}
              className="self-start rounded-xl bg-amber-400 px-5 py-3 font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {changed && (!percentValid || !listingValid) ? "數值不在允許範圍" : "儲存費率"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
