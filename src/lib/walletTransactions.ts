import type { Transaction } from "@/platform";
import type { SubscriptionReservation } from "@/lib/onchainSettlement";
import { isUserTransactionEntry } from "@/lib/transactionHistory";

export type WalletLedgerRow = {
  id: string;
  entry_type: string;
  amount: number | string;
  asset_id?: string | null;
  quantity?: number | string | null;
  metadata?: Record<string, unknown> | null;
  idempotency_key?: string | null;
  created_at: string;
};

export type WalletPlacementRow = {
  id: string;
  name: string;
  translations?: unknown;
  is_ae_token?: boolean | null;
};

export type WalletCommissionLogRow = {
  id: string;
  asset_id: string | null;
  bonus_type?: string | null;
};

export type WalletSettlementRow = {
  ref_key: string;
  status: string;
  tx_hash?: string | null;
  error?: string | null;
};

export type WalletTownRow = {
  id: string;
  kind: "bomb" | "ae";
  house: number;
  amount: number;
  net: number;
  tx_hash: string | null;
  status: "confirmed" | "pending";
  created_at: string;
};

export type WalletStaticAsset = { id: string; name: string; isAeToken?: boolean };

export type WalletTransactionInput = {
  jcLedger: WalletLedgerRow[];
  assetLedger: WalletLedgerRow[];
  townRows: WalletTownRow[];
  commissionLogs: WalletCommissionLogRow[];
  placements: WalletPlacementRow[];
  settlements: WalletSettlementRow[];
  reservations?: SubscriptionReservation[];
  staticAssets: Map<string, WalletStaticAsset>;
  language: string;
  localize: (korean: string, chinese: string) => string;
};

export type WalletTransactions = {
  transactions: Transaction[];
  commissionTransactions: Transaction[];
};

export function buildSubscriptionReservationTransactions(
  reservations: SubscriptionReservation[],
  assets: Map<string, WalletStaticAsset>,
  language: string,
  localize: (korean: string, chinese: string) => string,
  excludedRequestKeys: ReadonlySet<string> = new Set(),
): Transaction[] {
  return reservations
    .filter((row) => (row.status === "pending" || row.status === "released") && !excludedRequestKeys.has(row.request_key))
    .map((row) => {
      const quantityValue = Number(row.quantity);
      const reservationAmountValue = Number(row.jc_amount);
      const quantity = Number.isFinite(quantityValue) && quantityValue > 0 ? quantityValue : undefined;
      const reservationAmount = Number.isFinite(reservationAmountValue) && reservationAmountValue > 0
        ? reservationAmountValue
        : 0;
      const asset = row.asset_id ? assets.get(row.asset_id) : undefined;
      const status = row.status === "released" ? "released" : "pending";
      return {
        id: `reservation:${row.request_key}`,
        type: "buy",
        entryType: "subscription_reservation",
        assetId: row.asset_id ?? undefined,
        isAeAsset: asset?.isAeToken === true,
        asset: asset?.isAeToken ? "AE" : asset?.name ?? row.asset_id ?? localize("예약 자산", "認購標的"),
        quantity,
        gross: reservationAmount,
        reservationAmount,
        fee: 0,
        net: 0,
        currency: "jc",
        date: new Date(row.created_at).toLocaleString(language || undefined),
        createdAt: row.created_at,
        hash: row.request_key,
        status,
        statusReason: status === "released"
          ? localize("예약이 해제되어 청약이 완료되지 않았습니다. JC가 차감되거나 지분이 지급되지 않았습니다.", "預留已釋放，認購未完成；未扣 JC、未發放份額。")
          : localize("청약 수량과 JC가 예약되어 있습니다. 정산이 완료되면 차감 및 지급됩니다.", "份額與 JC 已預留，待交割完成後才正式扣款及發放。"),
      } satisfies Transaction;
    });
}

const jcTypeMap: Record<string, Transaction["type"]> = {
  private_purchase: "buy",
  secondary_buy: "buy",
  secondary_sell: "sell",
  p2p_buy: "buy",
  p2p_sell: "sell",
  p2p_listing_fee: "fee",
  commission_payout: "dividend",
  refund: "refund",
  vault_buy: "deposit",
  admin_payout: "deposit",
  vault_redeem: "withdraw",
  redemption_pending: "withdraw",
  redemption_refund: "deposit",
  town_bomb: "fee",
};

// vault_buy_jc is only an internal mirror of the USDT transfer; the actual
// on-chain transfer is listed separately with its real tx hash.
const usdtTypeMap: Record<string, Transaction["type"]> = {
  sandbox_deposit: "deposit",
  vault_redeem_jc: "deposit",
};

const byNewest = (a: Transaction, b: Transaction) =>
  a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;

/**
 * The single source of truth for a user's transaction history. The user wallet
 * and the admin user-detail view both call this with the same raw rows, so they
 * can never drift apart when a new transaction source is added.
 */
export function buildWalletTransactions(input: WalletTransactionInput): WalletTransactions {
  const {
    jcLedger,
    assetLedger,
    townRows,
    commissionLogs,
    placements,
    settlements,
    reservations = [],
    staticAssets,
    language,
    localize,
  } = input;

  const ledgerById = new Map<string, WalletLedgerRow>(
    [...assetLedger, ...jcLedger].map((row) => [row.id, row]),
  );
  const commissionById = new Map(commissionLogs.map((row) => [row.id, row]));
  const commissionAssetById = new Map(commissionLogs.map((row) => [row.id, row.asset_id]));
  const placementNameById = new Map(
    placements.map((row) => [row.id, row.name] as const),
  );
  const aePlacementIds = new Set(placements.filter((row) => row.is_ae_token).map((row) => row.id));

  const resolveAssetId = (row: WalletLedgerRow) => {
    if (row.asset_id) return row.asset_id;
    const meta = row.metadata ?? {};
    const commissionLogId = meta.commission_log_id;
    if (typeof commissionLogId === "string") {
      const fromPayout = commissionAssetById.get(commissionLogId);
      if (fromPayout) return fromPayout;
    }
    const sourceLedgerId = meta.source_ledger_id;
    if (typeof sourceLedgerId === "string") {
      const fromPending = ledgerById.get(sourceLedgerId)?.asset_id;
      if (fromPending) return fromPending;
    }
    return row.asset_id ?? undefined;
  };

  const settlementByRef = new Map(settlements.map((row) => [row.ref_key, row] as const));
  const settlementForLedger = (row: WalletLedgerRow) => {
    const action =
      row.entry_type === "private_purchase"
        ? "subscribe"
        : row.entry_type === "vault_buy"
          ? "mint_jc"
          : row.entry_type.startsWith("p2p_") || row.entry_type.startsWith("secondary_")
            ? "trade"
            : null;
    const requestKey =
      typeof row.idempotency_key === "string" && row.idempotency_key.length > 0
        ? row.idempotency_key
        : typeof row.metadata?.request_key === "string"
          ? row.metadata.request_key
          : null;
    if (action) {
      const direct = settlementByRef.get(`${action}:${row.id}`);
      if (direct) return direct;
    }
    // 帳本冪等鍵常帶後綴（`<uuid>:jc`、`<uuid>:match:0:buyer`），結算 ref_key 只用開頭的請求 ID
    const leadingUuid = requestKey?.split(":")[0];
    const baseRequestKey =
      leadingUuid && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leadingUuid)
        ? leadingUuid
        : null;
    return settlements.find(
      (settlement) =>
        (requestKey && settlement.ref_key.includes(requestKey)) ||
        (baseRequestKey && settlement.ref_key.includes(baseRequestKey)) ||
        settlement.ref_key.endsWith(`:${row.id}`),
    );
  };

  // 鏈上託管成交由合約直接交割，帳本只在鏈上確認後才寫入並附 tx_hash，不會有 onchain_settlements 列
  const isConfirmedEscrowFill = (row: WalletLedgerRow) =>
    row.metadata?.escrow === true &&
    typeof row.metadata?.tx_hash === "string" &&
    row.metadata.tx_hash.length > 0;

  const transactionStatusFor = (row: WalletLedgerRow): Transaction["status"] => {
    const settlement = settlementForLedger(row);
    const requiresSettlement =
      row.entry_type === "private_purchase" ||
      row.entry_type === "vault_buy" ||
      row.entry_type === "p2p_buy" ||
      row.entry_type === "p2p_sell" ||
      row.entry_type === "secondary_buy" ||
      row.entry_type === "secondary_sell";
    if (!settlement && isConfirmedEscrowFill(row)) return "confirmed";
    if (!settlement && requiresSettlement && row.idempotency_key) return "pending";
    if (!settlement) return "confirmed";
    if (settlement.status === "failed") return "failed";
    if (settlement.status === "cancelled") return "cancelled";
    if (settlement.status === "pending") return "pending";
    return "confirmed";
  };

  const buildTx = (
    row: WalletLedgerRow,
    currency: "jc" | "usdt",
    type: Transaction["type"],
  ): Transaction => {
    const meta = row.metadata ?? {};
    const resolvedAssetId = resolveAssetId(row);
    const isAeAsset =
      Boolean(resolvedAssetId) &&
      (aePlacementIds.has(resolvedAssetId!) ||
        staticAssets.get(resolvedAssetId!)?.isAeToken === true);
    const resolvedName = isAeAsset
      ? "AE"
      : (resolvedAssetId ? placementNameById.get(resolvedAssetId) : undefined) ??
        (resolvedAssetId ? staticAssets.get(resolvedAssetId)?.name : undefined);
    const fallbackName =
      row.entry_type === "sandbox_deposit"
        ? localize("샌드박스 USDT", "測試 USDT")
        : row.entry_type === "p2p_listing_fee"
          ? localize("挂单手续费", "掛單手續費")
          : row.entry_type === "town_bomb"
            ? localize("RWMT 炸彈罰款", "RWMT 炸彈罰款")
            : row.entry_type === "refund"
              ? localize("청약 환불", "認購退款")
              : row.entry_type === "admin_payout"
                ? localize("관리자 입금", "管理員入帳")
                : row.entry_type.startsWith("vault") || row.entry_type.startsWith("redemption")
                  ? localize("JC 금고 교환", "兌換JC")
                  : localize("추천 커미션", "代理分潤");
    const rawQuantity = row.quantity ?? meta.quantity ?? meta.fill_quantity ?? meta.match_quantity;
    const parsedQuantity = Number(rawQuantity);
    const quantity =
      Number.isFinite(parsedQuantity) && parsedQuantity !== 0 ? Math.abs(parsedQuantity) : undefined;
    const rawGross = Number(meta.gross);
    const gross =
      Number.isFinite(rawGross) && rawGross > 0 ? rawGross : Math.abs(Number(row.amount));
    const rawFee = Number(meta.fee);
    const fee =
      meta.fee != null && Number.isFinite(rawFee)
        ? Math.abs(rawFee)
        : row.entry_type === "p2p_listing_fee"
          ? Math.abs(Number(row.amount))
          : 0;
    const settlement = settlementForLedger(row);
    const status = transactionStatusFor(row);
    return {
      id: row.id,
      type,
      entryType: row.entry_type,
      requestKey:
        typeof row.idempotency_key === "string"
          ? row.idempotency_key
          : typeof meta.request_key === "string"
            ? meta.request_key
            : undefined,
      assetId: resolvedAssetId ?? undefined,
      isAeAsset,
      asset: resolvedName ?? fallbackName,
      quantity,
      gross,
      fee,
      gas: Number(meta.gas ?? 0),
      net: Number(row.amount),
      currency,
      date: new Date(row.created_at).toLocaleString(language || undefined),
      createdAt: row.created_at,
      hash: row.id,
      status,
      statusReason:
        settlement?.error ??
        (status === "pending" ? "鏈上結算紀錄尚未確認，請等待後台補發或重試" : null),
    };
  };

  const jcTx = jcLedger
    // 分潤紀錄另列；個人交易只顯示共用的交易 entry types。
    .filter((row) => isUserTransactionEntry(row.entry_type))
    .map((row) => buildTx(row, "jc", jcTypeMap[row.entry_type] ?? "dividend"));
  const usdtTx = assetLedger
    .filter((row) => usdtTypeMap[row.entry_type])
    .map((row) => buildTx(row, "usdt", usdtTypeMap[row.entry_type]));
  // 炸彈罰款已在 jc_ledger 以 town_bomb 記帳，這裡只補只存在於小鎮表的 AE 獎勵，避免炸彈重複出現。
  const reservationAssets = new Map(staticAssets);
  for (const placement of placements) {
    reservationAssets.set(placement.id, {
      id: placement.id,
      name: placement.is_ae_token ? "AE" : placement.name,
      isAeToken: placement.is_ae_token === true,
    });
  }
  const representedSubscriptionKeys = new Set(
    jcLedger
      .filter((row) => row.entry_type === "private_purchase")
      .flatMap((row) => [row.idempotency_key, row.metadata?.request_key])
      .filter((key): key is string => typeof key === "string"),
  );
  const reservationTx = buildSubscriptionReservationTransactions(
    reservations.filter((row) => !representedSubscriptionKeys.has(row.request_key)),
    reservationAssets,
    language,
    localize,
  );
  const townTx = townRows
    .filter((row) => row.kind === "ae")
    .map(
      (row): Transaction => ({
        id: row.id,
        type: "deposit",
        entryType: "town_ae",
        asset: "AE",
  quantity: row.amount,
  // 小鎮 AE 是免費獎勵，沒有支付任何 JC，單價為 0。
  gross: 0,
        fee: 0,
        net: row.net,
        currency: "ae",
        date: new Date(row.created_at).toLocaleString(language || undefined),
        createdAt: row.created_at,
        hash: row.tx_hash ?? row.id,
        status: row.status,
      }),
    );

  // 分潤紀錄：只收「已入帳且屬於 L1/L2」的推廣分潤——commission_payout（實際派發）與
  // commission_reversal（沖正校正，可正可負）。尚未派發的 commission_pending 屬內部應計。
  const commissionTransactions = jcLedger
    .filter((row) => {
      if (row.entry_type !== "commission_payout" && row.entry_type !== "commission_reversal") {
        return false;
      }
      const commissionLogId = row.metadata?.commission_log_id;
      if (typeof commissionLogId !== "string") return false;
      return Boolean(commissionById.get(commissionLogId));
    })
    .map((row) => buildTx(row, "jc", "dividend"))
    .sort(byNewest);

  return {
    transactions: [...jcTx, ...usdtTx, ...townTx, ...reservationTx].sort(byNewest),
    commissionTransactions,
  };
}
