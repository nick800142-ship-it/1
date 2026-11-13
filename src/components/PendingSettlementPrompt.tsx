"use client";

import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Loader2 } from "lucide-react";
import { Modal } from "@/components/Modal";
import { TransactionCompletionDialog } from "@/components/TradeDetailsDialog";
import { localizedUiText, useLanguage, usePlatform } from "@/platform";
import {
  cancelPendingSubscription,
  fetchSubscriptionReservations,
  useOnchainSettlement,
  type SubscriptionReservation,
} from "@/lib/onchainSettlement";

type Completed = { assetName: string; quantity: number; paymentJc: number; txHash: string | null };

function isRejectedWalletRequest(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return Number(code) === 4001 || code === "ACTION_REJECTED";
}

function resultTxHash(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  const hash = record.txHash ?? record.tx_hash;
  return typeof hash === "string" && hash.startsWith("0x") ? hash : null;
}

/**
 * 偵測到需要買方補簽的認購預留時，直接蓋住整個頁面詢問：完成交割（補授權後立即發放）或取消（釋出份額）。
 * 只有這兩個選擇能關閉視窗，份額在買方決定前一直保留。
 */
export function PendingSettlementPrompt({ userId }: { userId: string }) {
  const { language } = useLanguage();
  const { assets, refresh } = usePlatform();
  const { completePendingSubscription } = useOnchainSettlement();
  const { mutate } = useSWRConfig();
  const [handledKeys, setHandledKeys] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<"complete" | "cancel" | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [completed, setCompleted] = useState<Completed | null>(null);

  const { data: reservations = [] } = useSWR(
    ["pending-settlement-prompt", userId],
    () => fetchSubscriptionReservations(),
    { refreshInterval: 60_000, revalidateOnFocus: true },
  );

  const current: SubscriptionReservation | undefined = reservations.find(
    (row) => row.status === "pending" && row.needs_buyer_action && !handledKeys.has(row.request_key),
  );

  const asset = current ? assets.find((item) => item.id === current.asset_id) : undefined;
  const assetName = asset?.name ?? current?.asset_id ?? "";
  const isAe = Boolean((asset as { isAeToken?: boolean } | undefined)?.isAeToken) || assetName === "AE";
  const quantity = Number(current?.quantity ?? 0);
  const paymentJc = Number(current?.jc_amount ?? 0);
  const unit = isAe ? "AE" : localizedUiText(language, "단위", "份");

  const finish = (requestKey: string) => {
    setHandledKeys((prev) => new Set(prev).add(requestKey));
    setBusy(null);
    setConfirmingCancel(false);
    setError(null);
    void mutate((key) => Array.isArray(key) && (key[0] === "subscription-reservations" || key[0] === "pending-settlement-prompt"));
    void refresh();
  };

  const complete = async () => {
    if (!current) return;
    const requestKey = current.request_key;
    setBusy("complete");
    setError(null);
    try {
      const result = await completePendingSubscription(requestKey);
      const status = (result as { status?: string } | null)?.status;
      const failure = (result as { error?: unknown } | null)?.error;
      if (status !== "confirmed" && typeof failure === "string" && failure) {
        setBusy(null);
        setError(localizedUiText(language, `정산이 아직 완료되지 않았습니다: ${failure}`, `交割尚未完成：${failure}。份額仍為您保留，可再按一次「完成交割」或選擇取消。`));
        return;
      }
      if (status === "confirmed") {
        setCompleted({ assetName, quantity, paymentJc, txHash: resultTxHash(result) });
        setNotice(null);
      } else {
        setNotice(localizedUiText(language, "승인이 완료되었습니다. 시스템이 정산을 이어서 처리합니다.", "授權完成，系統正在完成交割，份額發放後會顯示在錢包。"));
      }
      finish(requestKey);
    } catch (err) {
      setBusy(null);
      setError(
        isRejectedWalletRequest(err)
          ? localizedUiText(language, "지갑 서명이 취소되었습니다. 자산은 계속 보관됩니다.", "您取消了錢包簽署，份額仍為您保留，請再按一次「完成交割」。")
          : err instanceof Error ? err.message : localizedUiText(language, "정산에 실패했습니다.", "交割未完成，份額仍為您保留，請稍後再試。"),
      );
    }
  };

  const cancel = async () => {
    if (!current) return;
    const requestKey = current.request_key;
    setBusy("cancel");
    setError(null);
    try {
      await cancelPendingSubscription(requestKey);
      setNotice(localizedUiText(language, "주문이 취소되어 수량이 해제되었습니다. JC는 차감되지 않았습니다.", "已取消這筆訂單並釋出份額，您的 JC 沒有被扣款。"));
      finish(requestKey);
    } catch (err) {
      setBusy(null);
      setError(err instanceof Error ? err.message : localizedUiText(language, "취소에 실패했습니다.", "取消失敗，請稍後再試。"));
    }
  };

  if (completed) {
    return (
      <TransactionCompletionDialog
        open
        onClose={() => setCompleted(null)}
        assetName={completed.assetName}
        quantity={completed.quantity}
        paymentJc={completed.paymentJc}
        txHash={completed.txHash}
      />
    );
  }

  if (!current) {
    return notice ? (
      <Modal open centered onClose={() => setNotice(null)} title={localizedUiText(language, "알림", "通知")}>
        <div className="flex flex-col gap-5">
          <p className="text-sm leading-relaxed text-slate-300">{notice}</p>
          <button type="button" onClick={() => setNotice(null)} className="min-h-11 w-full rounded-xl bg-amber-400 py-3 font-bold text-slate-950">
            {localizedUiText(language, "확인", "知道了")}
          </button>
        </div>
      </Modal>
    ) : null;
  }

  return (
    <Modal open dismissible={false} onClose={() => {}} title={localizedUiText(language, "정산 대기 주문", "待完成交割的訂單")}>
      <div className="flex flex-col gap-5">
        <div className="text-center">
          <div className="mx-auto flex size-14 items-center justify-center rounded-full border border-amber-400/30 bg-amber-400/10 text-2xl font-bold text-amber-300" aria-hidden="true">!</div>
          <h3 className="mt-3 text-xl font-bold text-white">
            {confirmingCancel
              ? localizedUiText(language, "이 주문을 취소하시겠습니까?", "確定要取消這筆訂單嗎？")
              : localizedUiText(language, "이 주문의 정산을 완료하시겠습니까?", "是否完成這筆訂單的交割？")}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-slate-400">
            {confirmingCancel
              ? localizedUiText(language, "취소하면 보관된 수량이 해제되어 다른 사용자가 청약할 수 있습니다. JC는 차감되지 않습니다.", "取消後為您保留的份額會釋出給其他人認購，您的 JC 不會被扣款。")
              : localizedUiText(language, "이 수량은 고객님을 위해 보관 중입니다. 지갑에서 승인하면 즉시 JC를 결제하고 자산을 발행합니다.", "這些份額正為您保留。在錢包授權後，系統會立即收取 JC 並發放份額給您。")}
          </p>
        </div>

        <dl className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/70 [&>div+div]:border-t [&>div+div]:border-slate-800">
          <Row label={localizedUiText(language, "거래 유형", "交易類型")} value={localizedUiText(language, "사모 청약", "私募認購")} />
          <Row label={localizedUiText(language, "자산", "標的")} value={assetName} />
          <Row label={localizedUiText(language, "결제", "支付")} value={`${paymentJc.toLocaleString()} JC`} strong />
          <Row label={localizedUiText(language, "받을 자산", "收到標的")} value={`${quantity.toLocaleString()} ${unit}`} strong />
          <Row label="Gas" value={localizedUiText(language, "플랫폼 대납", "平台代付")} />
          <Row label={localizedUiText(language, "주문 시간", "下單時間")} value={new Date(current.created_at).toLocaleString()} />
        </dl>

        {error && (
          <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs leading-relaxed text-red-300">
            {error}
          </p>
        )}

        {confirmingCancel ? (
          <div className="flex flex-col-reverse gap-3 sm:flex-row">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => setConfirmingCancel(false)}
              className="min-h-11 flex-1 rounded-xl border border-slate-700 py-3 font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              {localizedUiText(language, "돌아가기", "返回")}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void cancel()}
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 py-3 font-bold text-red-300 hover:bg-red-500/20 disabled:opacity-50"
            >
              {busy === "cancel" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {localizedUiText(language, "취소하고 수량 해제", "確定取消並釋出份額")}
            </button>
          </div>
        ) : (
          <div className="flex flex-col-reverse gap-3 sm:flex-row">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => { setError(null); setConfirmingCancel(true); }}
              className="min-h-11 flex-1 rounded-xl border border-slate-700 py-3 font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              {localizedUiText(language, "취소", "取消")}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void complete()}
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-amber-400 py-3 font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === "complete" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {busy === "complete"
                ? localizedUiText(language, "정산 중…", "交割中…")
                : localizedUiText(language, "정산 완료", "完成交割")}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="grid grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] items-center gap-4 px-4 py-3.5 sm:px-5">
      <dt className="min-w-0 text-sm font-medium leading-6 text-slate-400">{label}</dt>
      <dd className={`min-w-0 text-right leading-6 break-words [overflow-wrap:anywhere] ${strong ? "text-base font-bold text-amber-300" : "font-semibold text-slate-100"}`}>
        {value}
      </dd>
    </div>
  );
}
