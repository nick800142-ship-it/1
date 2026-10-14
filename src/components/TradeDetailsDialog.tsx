"use client";

import { Modal } from "@/components/Modal";
import { localizedUiText, useLanguage } from "@/platform";

export type TradeDetails = {
  /** 標的物名稱 */
  assetName: string;
  /** 份額 */
  quantity: number;
  /** 手續費（已格式化文字） */
  fee: string;
  /** 合計金額（已格式化文字） */
  total: string;
  /** 額外說明 */
  note?: string;
};

/**
 * 交易明細確認視窗。首頁購買份額、認購頁確認認購、二級市場掛單皆共用，
 * 顯示標的物名稱、份額、手續費與合計金額。Gas 由平台熱錢包實際代付，
 * 不再向使用者收取或顯示。
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
  const { language } = useLanguage();
  return (
    <Modal open={open && !!details} onClose={onClose} title={localizedUiText(language, title === "交易明細" ? "거래 상세 정보" : title, title)}>
      {details && (
        <div className="flex flex-col gap-5">
          <dl className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-950 p-4 text-sm">
            <Row label={localizedUiText(language, "자산명", "標的物名稱")} value={details.assetName} />
            <Row label={localizedUiText(language, "수량", "份額")} value={`${details.quantity.toLocaleString()} ${localizedUiText(language, "단위", "份")}`} />
            <Row label={localizedUiText(language, "수수료", "手續費")} value={details.fee} />
            <Row label={localizedUiText(language, "총액", "合計金額")} value={details.total} strong />
          </dl>
          {details.note && (
            <p className="text-xs leading-relaxed text-slate-500">
              {details.note}
            </p>
          )}
          {/* 手機上主要動作排在上方，避免被底部導覽列或安全區裁切。 */}
          <div className="flex flex-col-reverse gap-3 sm:flex-row">
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 flex-1 rounded-xl border border-slate-700 py-3 font-semibold text-slate-300 hover:bg-slate-800"
            >
              {localizedUiText(language, "취소", "取消")}
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={onConfirm}
              className="min-h-11 flex-1 rounded-xl bg-amber-400 py-3 font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? localizedUiText(language, "처리 중…", "處理中…") : localizedUiText(language, confirmLabel === "確認購買" ? "구매 확인" : confirmLabel === "確認認購" ? "청약 확인" : confirmLabel, confirmLabel)}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function TransactionCompletionDialog({
  open,
  onClose,
  assetName,
  quantity,
  paymentJc,
  feeJc = 0,
  txHash,
  type = "私募認購",
}: {
  open: boolean;
  onClose: () => void;
  assetName: string;
  quantity: number;
  paymentJc: number;
  feeJc?: number;
  txHash: string | null;
  type?: string;
}) {
  const { language } = useLanguage();
  return (
    <Modal open={open} onClose={onClose} title={localizedUiText(language, "거래 완료", "交易完成")}>
      <div className="space-y-5">
        <div className="text-center">
          <div className="mx-auto flex size-14 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-400/10 text-emerald-300">✓</div>
          <h3 className="mt-3 text-xl font-bold text-white">{localizedUiText(language, "鏈上交易已確認", "鏈上交易已確認")}</h3>
          <p className="mt-1 text-sm text-slate-400">{localizedUiText(language, "以下為本次實際完成的交易明細", "以下為本次實際完成的交易明細")}</p>
        </div>
        <dl className="divide-y divide-slate-800 overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/70">
          <Row label={localizedUiText(language, "交易類型", "交易類型")} value={type} />
          <Row label={localizedUiText(language, "標的", "標的")} value={assetName} />
          <Row label={localizedUiText(language, "支付", "支付")} value={`${paymentJc.toLocaleString()} JC`} strong />
          {feeJc > 0 && <Row label={localizedUiText(language, "手續費", "手續費")} value={`${feeJc.toLocaleString()} JC`} />}
          <Row label={localizedUiText(language, "收到標的", "收到標的")} value={`${quantity.toLocaleString()} ${assetName === "AE" ? "AE" : localizedUiText(language, "份", "份")}`} strong />
          <Row label="Gas" value={localizedUiText(language, "平台代付", "平台代付")} />
        </dl>
        <p className="rounded-xl border border-emerald-400/20 bg-emerald-400/5 px-4 py-3 text-xs leading-relaxed text-slate-300">{localizedUiText(language, "鏈上交割與正式帳本均已確認，這筆交易已完成。", "鏈上交割與正式帳本均已確認，這筆交易已完成。")}</p>
        {txHash && <a href={`https://sepolia.basescan.org/tx/${txHash}`} target="_blank" rel="noreferrer" className="block rounded-xl border border-slate-700 px-4 py-3 text-center text-sm font-semibold text-slate-200 hover:bg-slate-800">{localizedUiText(language, "查看鏈上交易", "查看鏈上交易")}</a>}
        <button type="button" onClick={onClose} className="min-h-11 w-full rounded-xl bg-amber-400 py-3 font-bold text-slate-950">{localizedUiText(language, "完成", "完成")}</button>
      </div>
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
