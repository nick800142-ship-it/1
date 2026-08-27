"use client";

import { Modal } from "@/components/Modal";

export type TradeDetails = {
  /** 標的物名稱 */
  assetName: string;
  /** 份額 */
  quantity: number;
  /** 手續費（已格式化文字） */
  fee: string;
  /** 合計金額（已格式化文字） */
  total: string;
  /** Gas（已格式化文字） */
  gas: string;
  /** 額外說明 */
  note?: string;
};

/**
 * 交易明細確認視窗。首頁購買份額、認購頁確認認購、二級市場掛單皆共用，
 * 一律顯示標的物名稱、份額、手續費、合計金額與 Gas。
 */
export function TradeDetailsDialog({
  open,
  onClose,
  title,
  details,
  confirmLabel,
  submitting = false,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  details: TradeDetails | null;
  confirmLabel: string;
  submitting?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open && !!details} onClose={onClose} title={title}>
      {details && (
        <div className="flex flex-col gap-5">
          <dl className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-950 p-4 text-sm">
            <Row label="標的物名稱" value={details.assetName} />
            <Row label="份額" value={`${details.quantity.toLocaleString()} 份`} />
            <Row label="手續費" value={details.fee} />
            <Row label="合計金額" value={details.total} strong />
            <Row label="Gas" value={details.gas} />
          </dl>
          {details.note && (
            <p className="text-xs leading-relaxed text-slate-500">
              {details.note}
            </p>
          )}
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 flex-1 rounded-xl border border-slate-700 py-3 font-semibold text-slate-300 hover:bg-slate-800"
            >
              取消
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={onConfirm}
              className="min-h-11 flex-1 rounded-xl bg-amber-400 py-3 font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "處理中…" : confirmLabel}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Row({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-800/60 pb-3 last:border-0 last:pb-0">
      <dt className="text-slate-400">{label}</dt>
      <dd
        className={`text-right break-words ${strong ? "text-base font-bold text-amber-300" : "font-semibold text-slate-100"}`}
      >
        {value}
      </dd>
    </div>
  );
}
