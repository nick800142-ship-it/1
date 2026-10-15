import type { Transaction } from "@/platform";
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
  staticAssets: Map<string, WalletStaticAsset>;
  language: string;
  localize: (korean: string, chinese: string) => string;
};

export type WalletTransactions = {
  transactions: Transaction[];
  commissionTransactions: Transaction[];
};

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
    placements.map((row) => {
      const translated = (
        row.translations as Record<string, { name?: string }> | null | undefined
      )?.[language]?.name;
      return [row.id, translated?.trim() || row.name] as const;
    }),
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
    return settlements.find(
      (settlement) =>
        (requestKey && settlement.ref_key.includes(requestKey)) ||
        settlement.ref_key.endsWith(`:${row.id}`),
    );
  };

  const transactionStatusFor = (row: WalletLedgerRow): Transaction["status"] => {
    const settlement = settlementForLedger(row);
    const requiresSettlement =
      row.entry_type === "private_purchase" ||
      row.entry_type === "vault_buy" ||
      row.entry_type === "p2p_buy" ||
      row.entry_type === "p2p_sell" ||
      row.entry_type === "secondary_buy" ||
      row.entry_type === "secondary_sell";
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
      Number.isFinite(parsedQuantity) && parsedQuantity > 0 ? Math.abs(parsedQuantity) : undefined;
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
  const townTx = townRows
    .filter((row) => row.kind === "ae")
    .map(
      (row): Transaction => ({
        id: row.id,
        type: "deposit",
        entryType: "town_ae",
        asset: "AE",
        quantity: row.amount,
        gross: row.amount,
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
    transactions: [...jcTx, ...usdtTx, ...townTx].sort(byNewest),
    commissionTransactions,
  };
}
