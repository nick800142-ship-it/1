// 後端 relayer：以單一 ADMIN_PRIVATE_KEY 熱錢包代發所有需要合約 owner 身分、
// 或直接動用熱錢包自身餘額才能送出的鏈上結算交易。
//
// 為什麼需要它：JC/AE 發放（ADMIN 熱錢包直接 transfer 自己的餘額，庫存由人工
// 從 Safe 金庫轉帳補貨）、一級認購 executeSubscription、二級市場
// executeTrade 瀏覽器端錢包都無法直接呼叫；而二級市場撮合還需要同時知道買賣
// 雙方的錢包地址（前端刻意不回傳對手方身分）。因此改由後端用 service_role
// 讀取 Supabase 帳本、在伺服器端推導金額與雙方地址後代發交易。
//
// 安全模型：
//  1. 只接受帶有有效 Supabase session token 的請求（getUser 驗證）。
//  2. 金額與對手方一律從既有 RPC 寫下的 jc_ledger 紀錄推導，絕不信任前端傳來的數字。
//  3. onchain_settlements 以 ref_key 做冪等，避免重複發幣 / 重複結算。
//  4. wire-contracts 僅限管理員（profiles.agency_role）。
import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { formatUnits, getAddress, parseUnits, type Address } from "viem";
import {
  createRwaFactoryToken,
  ensureRelayerGas,
  executeAeSubscription,
  executeAeTrade,
  executeRwaTrade,
  executeSubscription,
  getHotWalletShareBalance,
  getWalletShareBalance,
  sponsorUserGas,
  getVaultStatus,
  mintJc,
  mintTokenSupply,
  pullJcFromUser,
  adminSendJc,
  RELAYER_ADDRESSES,
  sendAdminAssetPayout,
  sendAdminAssetReclaim,
  getLegacyAssetChainState,
  getAdminAssetReclaimReceiptStatus,
  waitForAdminAssetPayout,
  waitForAdminAssetReclaim,
  sendJcToVault,
  splitTradeFee,
  relayerAddress,
  wireRwaContracts,
  adminReclaimAe,
  getAeChainBalance,
  reclaimRwaShare,
} from "./_onchain";

function json(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

async function readBody(request: IncomingMessage) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 32_768) throw new Error("Payload too large");
  }
  return JSON.parse(raw || "{}") as {
    action?: string;
    requestKey?: string;
    settlementId?: string;
    ledgerAction?: string;
    ledgerRowId?: string;
    placementId?: string;
    assetKey?: string;
    expectedAmount?: string;
  };
}

// 管理權限與代理身分分離：舊帳號沿用 agency_role，雙重身分帳號用 role。
const ADMIN_ROLES = new Set(["管理員", "admin", "super_admin"]);
const isAdminProfile = (profile: { agency_role?: string | null; role?: string | null }) =>
  ADMIN_ROLES.has(String(profile.agency_role ?? "")) ||
  ["admin", "super_admin"].includes(String(profile.role ?? ""));

function toAddress(value: unknown, label: string): Address {
  if (typeof value !== "string") throw new Error(`${label} 未綁定鏈上錢包`);
  try {
    return getAddress(value.trim());
  } catch {
    throw new Error(`${label} 錢包地址格式錯誤`);
  }
}

// private_placements.token_address 是選填欄位（RWA Factory 遷移期間允許
// null）。格式錯誤或未填時回傳 undefined，讓呼叫端安全地退回舊合約路徑，
// 而不是讓整個結算因為一個選填欄位壞掉而失敗。
function toFactoryTokenAddress(value: unknown): Address | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const addr = getAddress(value.trim());
    // 零地址代表「尚未建立專屬代幣」（有時 DB 會存成 null 而非 null），
    // 一律視為未建立，避免把零地址當成有效代幣拿去結算或誤判「已建立」。
    if (addr === "0x0000000000000000000000000000000000000000") return undefined;
    return addr;
  } catch {
    return undefined;
  }
}

const LEGACY_RECLAIM_CUTOFF = "2026-10-04T00:00:00+08:00";
const LEGACY_RECLAIM_ENTRY_TYPES = ["private_purchase", "p2p_buy", "p2p_sell"] as const;
const LEDGER_SCALE = 18;
const AE_LEGACY_ASSET_KEY = "legacy-ae";

type LegacyReclaimCandidate = {
  assetKey: string;
  label: string;
  kind: "ae" | "rwa";
  tokenAddress: Address | null;
  decimals: number | null;
  legacyNet: string;
  todayReserved: string;
  chainBalance: string;
  reclaimed: string;
  amount: string;
  status: "ready" | "no-token" | "chain-error" | "pending" | "complete" | "no-balance";
  txHash: string | null;
};

function ledgerAmountUnits(value: unknown): bigint {
  return parseUnits(String(value ?? "0"), LEDGER_SCALE);
}

function ledgerUnitsToTokenUnits(value: bigint, decimals: number): bigint {
  if (decimals >= LEDGER_SCALE) return value * 10n ** BigInt(decimals - LEDGER_SCALE);
  return value / 10n ** BigInt(LEDGER_SCALE - decimals);
}

async function readLegacyReclaimCandidates(
  admin: SupabaseClient,
  userId: string,
  wallet: Address,
): Promise<LegacyReclaimCandidate[]> {
  const ledgerRows: Array<{ asset_id: string | null; quantity: string | number; created_at: string }> = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await admin
      .from("jc_ledger")
      .select("asset_id,quantity,created_at")
      .eq("user_id", userId)
      .in("entry_type", [...LEGACY_RECLAIM_ENTRY_TYPES])
      .not("asset_id", "is", null)
      .order("created_at", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`讀取歷史資產帳本失敗：${error.message}`);
    const page = (data ?? []) as Array<{ asset_id: string | null; quantity: string | number; created_at: string }>;
    ledgerRows.push(...page);
    if (page.length < pageSize) break;
  }

  const { data: payoutRows, error: payoutError } = await admin
    .from("onchain_settlements")
    .select("asset_id,amount,payload,created_at,status")
    .eq("action", "admin_payout")
    .in("status", ["confirmed", "pending"])
    .eq("user_id", userId);
  if (payoutError) throw new Error(`讀取今日資產發放紀錄失敗：${payoutError.message}`);

  const positionTotals = new Map<string, { legacy: bigint; today: bigint }>();
  const cutoff = new Date(LEGACY_RECLAIM_CUTOFF).getTime();
  for (const row of ledgerRows) {
    if (!row.asset_id) continue;
    const totals = positionTotals.get(row.asset_id) ?? { legacy: 0n, today: 0n };
    const amount = ledgerAmountUnits(row.quantity);
    if (new Date(row.created_at).getTime() < cutoff) totals.legacy += amount;
    else totals.today += amount;
    positionTotals.set(row.asset_id, totals);
  }
  for (const row of payoutRows ?? []) {
    if (!row.asset_id) continue;
    const payload = row.payload as Record<string, unknown>;
    if (payload.assetType !== "ae" && payload.assetType !== "rwa") continue;
    const totals = positionTotals.get(row.asset_id) ?? { legacy: 0n, today: 0n };
    const amount = ledgerAmountUnits(row.amount ?? payload.amount);
    if (new Date(row.created_at).getTime() < cutoff) {
      if (row.status === "confirmed") totals.legacy += amount;
    } else {
      // 今日 pending 派發可能已送出但尚未確認；先保留額度，避免回收掉今日��發資產。
      totals.today += amount;
    }
    positionTotals.set(row.asset_id, totals);
  }

  const placementIds = Array.from(positionTotals.keys());
  const placements: Array<{ id: string; name: string | null; token_address: string | null; is_ae_token: boolean | null }> = [];
  for (let offset = 0; offset < placementIds.length; offset += 100) {
    const { data, error } = await admin
      .from("private_placements")
      .select("id,name,token_address,is_ae_token")
      .in("id", placementIds.slice(offset, offset + 100));
    if (error) throw new Error(`讀取��產合約��料失敗：${error.message}`);
    placements.push(...((data ?? []) as typeof placements));
  }
  const placementById = new Map(placements.map((placement) => [placement.id, placement]));

  const grouped = new Map<string, {
    assetKey: string;
    label: string;
    kind: "ae" | "rwa";
    tokenAddress: Address | null;
    legacy: bigint;
    today: bigint;
  }>();
  for (const [assetId, totals] of positionTotals) {
    const placement = placementById.get(assetId);
    const isAe = placement?.is_ae_token === true;
    const tokenAddress = isAe
      ? RELAYER_ADDRESSES.aeToken
      : toFactoryTokenAddress(placement?.token_address) ?? null;
    const assetKey = isAe
      ? AE_LEGACY_ASSET_KEY
      : tokenAddress
        ? `legacy-rwa:${tokenAddress.toLowerCase()}`
        : `legacy-rwa-placement:${assetId}`;
    const current = grouped.get(assetKey) ?? {
      assetKey,
      label: isAe ? "AE 代幣" : placement?.name || assetId,
      kind: isAe ? "ae" : "rwa",
      tokenAddress,
      legacy: 0n,
      today: 0n,
    };
    current.legacy += totals.legacy;
    current.today += totals.today;
    grouped.set(assetKey, current);
  }

  const { data: settlementRows, error: settlementError } = await admin
    .from("onchain_settlements")
    .select("asset_id,amount,status,tx_hash")
    .eq("action", "ae_reclaim_legacy")
    .eq("user_id", userId);
  if (settlementError) throw new Error(`讀取回收紀錄失敗：${settlementError.message}`);
  const settlementsByAsset = new Map<string, Array<{ asset_id: string | null; amount: string | number | null; status: string; tx_hash: string | null }>>();
  for (const row of (settlementRows ?? []) as Array<{ asset_id: string | null; amount: string | number | null; status: string; tx_hash: string | null }>) {
    const key = String(row.asset_id ?? "");
    settlementsByAsset.set(key, [...(settlementsByAsset.get(key) ?? []), row]);
  }

  return Promise.all(Array.from(grouped.values()).map(async (group): Promise<LegacyReclaimCandidate | null> => {
    if (group.legacy <= 0n) return null;
    const settlements = settlementsByAsset.get(group.assetKey) ?? [];
    const confirmed = settlements.filter((row) => row.status === "confirmed");
    const pending = settlements.find((row) => row.status === "pending");
    const txHash = pending?.tx_hash ?? confirmed[confirmed.length - 1]?.tx_hash ?? null;
    if (!group.tokenAddress) {
      return {
        assetKey: group.assetKey, label: group.label, kind: group.kind, tokenAddress: null,
        decimals: null, legacyNet: formatUnits(group.legacy, LEDGER_SCALE), todayReserved: "0",
        chainBalance: "0", reclaimed: "0", amount: "0", status: "no-token", txHash,
      };
    }

    try {
      const chain = await getLegacyAssetChainState(group.tokenAddress, wallet);
      const decimals = chain.decimals;
      const oldUnits = ledgerUnitsToTokenUnits(group.legacy, decimals);
      const todayUnits = ledgerUnitsToTokenUnits(group.today > 0n ? group.today : 0n, decimals);
      const reclaimedUnits = confirmed.reduce((sum, row) => {
        if (!row.amount) return sum;
        try {
          return sum + parseUnits(String(row.amount), decimals);
        } catch {
          return sum;
        }
      }, 0n);
      const oldRemaining = oldUnits > reclaimedUnits ? oldUnits - reclaimedUnits : 0n;
      const balanceUnits = parseUnits(chain.balance, decimals);
      const availableUnits = balanceUnits > todayUnits ? balanceUnits - todayUnits : 0n;
      const reclaimUnits = oldRemaining < availableUnits ? oldRemaining : availableUnits;
      const status: LegacyReclaimCandidate["status"] = pending
        ? "pending"
        : oldRemaining === 0n && reclaimedUnits > 0n
          ? "complete"
          : reclaimUnits > 0n
            ? "ready"
            : "no-balance";
      return {
        assetKey: group.assetKey,
        label: group.label,
        kind: group.kind,
        tokenAddress: group.tokenAddress,
        decimals,
        legacyNet: formatUnits(oldUnits, decimals),
        todayReserved: formatUnits(todayUnits, decimals),
        chainBalance: chain.balance,
        reclaimed: formatUnits(reclaimedUnits, decimals),
        amount: status === "ready" ? formatUnits(reclaimUnits, decimals) : "0",
        status,
        txHash,
      };
    } catch {
      return {
        assetKey: group.assetKey, label: group.label, kind: group.kind, tokenAddress: group.tokenAddress,
        decimals: null, legacyNet: formatUnits(group.legacy, LEDGER_SCALE), todayReserved: "0",
        chainBalance: "0", reclaimed: "0", amount: "0", status: "chain-error", txHash,
      };
    }
  })).then((rows) => rows.filter((row): row is LegacyReclaimCandidate => row != null));
}

async function reconcileLegacyReclaimReceipts(admin: SupabaseClient, userId: string): Promise<void> {
  const { data, error } = await admin
    .from("onchain_settlements")
    .select("id,tx_hash,updated_at")
    .eq("action", "ae_reclaim_legacy")
    .eq("user_id", userId)
    .eq("status", "pending")
    .limit(200);
  if (error) throw new Error(`同步回收交易狀態失敗：${error.message}`);

  const staleBefore = Date.now() - 5 * 60_000;
  await Promise.all((data ?? []).map(async (row) => {
    let nextStatus: "confirmed" | "failed" | "pending" = "pending";
    let statusError: string | null = null;
    if (row.tx_hash) {
      nextStatus = await getAdminAssetReclaimReceiptStatus(row.tx_hash as `0x${string}`);
      if (nextStatus === "failed") statusError = "鏈上回收交易已 revert";
    } else if (new Date(row.updated_at).getTime() < staleBefore) {
      nextStatus = "failed";
      statusError = "回收請求逾時且未送出鏈上交易，可安全重試";
    }
    if (nextStatus === "pending") return;
    const { error: updateError } = await admin
      .from("onchain_settlements")
      .update({ status: nextStatus, error: statusError, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("user_id", userId)
      .eq("status", "pending");
    if (updateError) throw new Error(`更新回收交易狀態失敗：${updateError.message}`);
  }));
}

// 防呆防護：在任何鏈上交易（發幣 / 認購結算 / 成交結算）真正送出之前，先確認
// ADMIN 熱錢包還有足夠 ETH 付礦工費。刻意放在建立 onchain_settlements pending
// 列之前檢查，失敗時不消耗那筆 ref_key，讓管理員儲值後可以直接重試。
async function guardRelayerGas(response: ServerResponse): Promise<boolean> {
  try {
    await ensureRelayerGas();
    return true;
  } catch (e) {
    json(response, 503, { error: errMsg(e) });
    return false;
  }
}

// 防呆防護：認購結算是「站內帳本先扣款、鏈上發幣/結算隨後跟進」的鏡像流程，
// 中間可能有延遲或重試。這裡在真正呼叫智慧合約之前，重新讀一次認購標的目前
// 的狀態——如果標的在使用者下單之後被管理員下架或關閉，就先擋下鏈上結算，
// 而不是照樣把 JC 轉進金庫、把 AE/RWA 發給買方。
async function guardPlacementStillSettleable(
  admin: SupabaseClient,
  response: ServerResponse,
  assetId: string,
): Promise<boolean> {
  const { data: placement } = await admin
    .from("private_placements")
    .select("id,is_active,is_delisted")
    .eq("id", assetId)
    .maybeSingle();
  if (!placement) {
    json(response, 404, { error: "找不到對應的認購標的" });
    return false;
  }
  if (placement.is_delisted) {
    json(response, 409, { error: "此標���已下架，鏈上結算已暫停，請聯繫客服處理" });
    return false;
  }
  if (placement.is_active === false) {
    json(response, 409, { error: "此標的目前未開放認購，鏈上結算已暫停，請聯繫客服處理" });
    return false;
  }
  return true;
}

// ���等：若同一 ref_key 已成功結算，直接回傳既有 tx；若仍 pending 視為進行中。
// 回傳 null 代表本次取得結算權，呼叫端應繼續執行鏈上交易。
async function claimSettlement(
  admin: SupabaseClient,
  row: {
    action: string;
    ref_key: string;
    user_id: string;
    counterparty_id?: string | null;
    asset_id?: string | null;
    amount?: number | null;
    payment?: number | null;
    payload: Record<string, unknown>;
  },
): Promise<{ done: { status: string; tx_hash: string | null } } | { id: string } > {
  const existing = await admin
    .from("onchain_settlements")
    .select("id,status,tx_hash")
    .eq("ref_key", row.ref_key)
    .maybeSingle();
  if (existing.data) {
    if (existing.data.status === "confirmed") {
      return { done: { status: "confirmed", tx_hash: existing.data.tx_hash } };
    }
    if (existing.data.status === "pending") {
      return { done: { status: "pending", tx_hash: existing.data.tx_hash } };
    }
    // failed → allow retry by reusing the same row id
    return { id: existing.data.id };
  }
  const inserted = await admin
    .from("onchain_settlements")
    .insert({ ...row, status: "pending" })
    .select("id")
    .single();
  if (inserted.error || !inserted.data) {
    // 併發插入時會撞 unique(ref_key)，重讀一次交給既有那筆處理。
    const retry = await admin
      .from("onchain_settlements")
      .select("id,status,tx_hash")
      .eq("ref_key", row.ref_key)
      .maybeSingle();
    if (retry.data) {
      if (retry.data.status === "confirmed") return { done: { status: "confirmed", tx_hash: retry.data.tx_hash } };
      if (retry.data.status === "pending") return { done: { status: "pending", tx_hash: retry.data.tx_hash } };
      return { id: retry.data.id }; // failed → 重用同一列重試
    }
    // 沒有既有列 ⇒ 這不是併發撞 unique，而是真正的寫入失敗（例如 CHECK 約束不允許
    // 此 action）。以前這裡會謊報 pending「done」，導致結算靜默 no-op��卻回報成功。
    // 現在改為拋出真實錯誤，讓上層標記 failed 並顯示原因，絕不假裝成功。
    throw new Error(
      `無法建立結算紀錄（action=${row.action}）：${inserted.error?.message ?? "未知錯誤"}`,
    );
  }
  return { id: inserted.data.id };
}

async function finish(
  admin: SupabaseClient,
  id: string,
  patch: { status: "confirmed" | "failed"; tx_hash?: string; error?: string },
) {
  await admin
    .from("onchain_settlements")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
}

// 讀取／合併 onchain_settlements.payload。多步鏈���結算（收 JC 進金庫、��� net 給
// 賣方、發標的）把每一步的 tx hash 記進 payload，管理員「一鍵補發」重試時可跳過
// 已完成的步驟，避免重複扣款／重複轉帳。
async function readSettlementPayload(
  admin: SupabaseClient,
  id: string,
): Promise<Record<string, unknown>> {
  const { data } = await admin
    .from("onchain_settlements")
    .select("payload")
    .eq("id", id)
    .maybeSingle();
  const payload = (data as { payload?: unknown } | null)?.payload;
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

async function mergeSettlementPayload(
  admin: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const current = await readSettlementPayload(admin, id);
  await admin
    .from("onchain_settlements")
    .update({ payload: { ...current, ...patch }, updated_at: new Date().toISOString() })
    .eq("id", id);
}

// 三個 owner-only 鏈上結算的核心邏輯抽成獨立函式，理由：管理員的「一鍵補發」
// 必須能對任何使用者的卡單紀錄重跑同一段結算流程，而不只是原始購買者本人。
// 這裡一律「以站內既有帳本列（ledgerRow）為準」重新推導金額與錢包，從不信任
// 呼叫端傳入的數字——不論是使用者本人觸發，還是管理員代為重試都一樣安全。
async function settleMintJcCore(
  admin: SupabaseClient,
  response: ServerResponse,
  ledgerRow: { id: string; user_id: string; amount: number },
): Promise<void> {
  const { data: ownerProfile } = await admin
    .from("profiles")
    .select("wallet_address")
    .eq("id", ledgerRow.user_id)
    .maybeSingle();
  let wallet: Address;
  try {
    wallet = toAddress(ownerProfile?.wallet_address, "使用者帳號");
  } catch (e) {
    return json(response, 422, { error: errMsg(e) });
  }
  const amount = Number(ledgerRow.amount);
  if (!(amount > 0)) return json(response, 422, { error: "JC 數量無效" });
  if (!(await guardRelayerGas(response))) return;

  const claim = await claimSettlement(admin, {
    action: "mint_jc",
    ref_key: `mint_jc:${ledgerRow.id}`,
    user_id: ledgerRow.user_id,
    amount,
    payload: { wallet },
  });
  if ("done" in claim) return json(response, 200, { ...claim.done, idempotent: true });
  try {
    const txHash = await mintJc(wallet, amount);
    await finish(admin, claim.id, { status: "confirmed", tx_hash: txHash });
    return json(response, 200, { status: "confirmed", tx_hash: txHash, amount });
  } catch (e) {
    await finish(admin, claim.id, { status: "failed", error: errMsg(e) });
    return json(response, 502, { error: `鏈上發幣失敗：${errMsg(e)}` });
  }
}

async function settleSubscribeCore(
  admin: SupabaseClient,
  response: ServerResponse,
  ledgerRow: {
    id: string;
    user_id: string;
    asset_id: string | null;
    quantity: number;
    amount: number;
    metadata: unknown;
  },
): Promise<void> {
  const placement = await admin
    .from("private_placements")
    .select("id,is_ae_token,token_address")
    .eq("id", ledgerRow.asset_id)
    .maybeSingle();
  const isAe = !!placement.data?.is_ae_token;
  // RWA（非 AE）標的若已在 RWA Factory 建立專屬代幣（token_address 已回填），
  // 走 Factory.subscribe()；AE 一律沿用既有的 aePrimarySale，不受影響。
  const factoryToken = isAe ? undefined : toFactoryTokenAddress(placement.data?.token_address);
  const units = Number(ledgerRow.quantity);
  const gross = Number(
    (ledgerRow.metadata as { gross?: number } | null)?.gross ?? Math.abs(Number(ledgerRow.amount)),
  );
  if (!(units > 0) || !(gross > 0)) return json(response, 422, { error: "認購數量或金額無效" });
  const { data: ownerProfile } = await admin
    .from("profiles")
    .select("wallet_address")
    .eq("id", ledgerRow.user_id)
    .maybeSingle();
  let wallet: Address;
  try {
    wallet = toAddress(ownerProfile?.wallet_address, "使用者帳號");
  } catch (e) {
    return json(response, 422, { error: errMsg(e) });
  }
  if (!(await guardPlacementStillSettleable(admin, response, String(ledgerRow.asset_id)))) return;
  if (!(await guardRelayerGas(response))) return;

  const claim = await claimSettlement(admin, {
    action: "subscribe",
    ref_key: `subscribe:${ledgerRow.id}`,
    user_id: ledgerRow.user_id,
    asset_id: ledgerRow.asset_id,
    amount: units,
    payment: gross,
    payload: { wallet, isAe, factoryToken: factoryToken ?? null },
  });
  if ("done" in claim) return json(response, 200, { ...claim.done, idempotent: true });
  try {
    const payload = await readSettlementPayload(admin, claim.id);
    // 步驟1：把認購本金 JC 從買方錢包實際收進 Safe 金庫（買方→ADMIN→Safe 兩跳，
    // 因 JC 合約禁止買方直接轉給金庫）。先收款：買方鏈上 JC／授權不足時會在這裡丟
    // 錯擋下，且此時尚未發出任何標的。每一跳的 tx 記進 payload，重試可跳過已完成的。
    if (!payload.jcPullTx) {
      const pullTx = await pullJcFromUser(wallet, gross);
      await mergeSettlementPayload(admin, claim.id, { jcPullTx: pullTx });
      payload.jcPullTx = pullTx;
    }
    if (!payload.jcToVaultTx) {
      const vaultTx = await sendJcToVault(gross);
      await mergeSettlementPayload(admin, claim.id, { jcToVaultTx: vaultTx });
      payload.jcToVaultTx = vaultTx;
    }
    // 步驟2：把標的發給買方（RWA 專屬份額 / AE，由 ADMIN 熱錢包直接 transfer）。
    const txHash = isAe
      ? await executeAeSubscription(wallet, units)
      : await executeSubscription(wallet, units, undefined, factoryToken);
    await finish(admin, claim.id, { status: "confirmed", tx_hash: txHash });
    // 認購成交當下即時把此筆購買產生的推廣分潤上鏈發放（ADMIN 熱錢包→各上線受益
    // 人），best-effort：發不成的不影響本次認購結果，會由 cron / 後台補發撿回。
    await settleCommissionsForSource(admin, ledgerRow.id).catch(() => {});
    return json(response, 200, { status: "confirmed", tx_hash: txHash, units, payment: gross });
  } catch (e) {
    await finish(admin, claim.id, { status: "failed", error: errMsg(e) });
    return json(response, 502, { error: `鏈上認購結算失敗：${errMsg(e)}` });
  }
}

async function settleTradeCore(
  admin: SupabaseClient,
  response: ServerResponse,
  buyRow: { id: string; user_id: string; asset_id: string | null; quantity: number; metadata: unknown },
): Promise<void> {
  const meta = (buyRow.metadata as { gross?: number; counterparty_id?: string } | null) ?? {};
  const buyerId = buyRow.user_id;
  const sellerId = meta.counterparty_id;
  if (!sellerId) return json(response, 422, { error: "成交紀錄缺少對手方" });
  const placement = await admin
    .from("private_placements")
    .select("id,is_ae_token,token_address")
    .eq("id", buyRow.asset_id)
    .maybeSingle();
  const isAe = !!placement.data?.is_ae_token;
  const factoryToken = isAe ? undefined : toFactoryTokenAddress(placement.data?.token_address);
  const units = Number(buyRow.quantity);
  const gross = Number(meta.gross);
  if (!(units > 0) || !(gross > 0)) return json(response, 422, { error: "成交�������量或金額無效" });

  const parties = await admin.from("profiles").select("id,wallet_address").in("id", [buyerId, sellerId]);
  let buyerWallet: Address;
  let sellerWallet: Address;
  try {
    buyerWallet = toAddress(parties.data?.find((p) => p.id === buyerId)?.wallet_address, "買方");
    sellerWallet = toAddress(parties.data?.find((p) => p.id === sellerId)?.wallet_address, "���方");
  } catch (e) {
    return json(response, 422, { error: errMsg(e) });
  }
  if (!(await guardRelayerGas(response))) return;

  const claim = await claimSettlement(admin, {
    action: "trade",
    ref_key: `trade:${buyRow.id}`,
    user_id: buyerId,
    counterparty_id: sellerId,
    asset_id: buyRow.asset_id,
    amount: units,
    payment: gross,
    payload: { buyerWallet, sellerWallet, isAe, factoryToken: factoryToken ?? null },
  });
  if ("done" in claim) return json(response, 200, { ...claim.done, idempotent: true });
  // 二級成交的 JC 收付走「買方→ADMIN→賣方／Safe」兩跳（JC 合約禁止買方直接轉給
  // 賣方或金庫）：先把買方 gross JC 拉進 ADMIN，再由 ADMIN 把 net 轉給賣方、fee
  // 轉進 Safe 金庫，最後才把標的份額由賣方交割給買方。先������、後交割：買方鏈上
  // JC／授權不足時在收款步驟就擋下，尚未交割任何份額。每步 tx 記進 payload，重試
  // 跳過已完成步驟，避免重複扣款／轉帳。
  try {
    const payload = await readSettlementPayload(admin, claim.id);
    const { net, fee } = splitTradeFee(gross);
    if (!payload.jcPullTx) {
      const pullTx = await pullJcFromUser(buyerWallet, gross);
      await mergeSettlementPayload(admin, claim.id, { jcPullTx: pullTx });
      payload.jcPullTx = pullTx;
    }
    if (!payload.jcToSellerTx) {
      const sellerTx = await adminSendJc(sellerWallet, net);
      await mergeSettlementPayload(admin, claim.id, { jcToSellerTx: sellerTx });
      payload.jcToSellerTx = sellerTx;
    }
    if (!payload.jcToVaultTx) {
      const vaultTx = await sendJcToVault(fee);
      await mergeSettlementPayload(admin, claim.id, { jcToVaultTx: vaultTx });
      payload.jcToVaultTx = vaultTx;
    }
    const txHash = isAe
      ? await executeAeTrade(sellerWallet, buyerWallet, units)
      : await executeRwaTrade(sellerWallet, buyerWallet, units, factoryToken);
    await finish(admin, claim.id, { status: "confirmed", tx_hash: txHash });
    // 二級成交當下即時把賣方端產生的推廣分潤上鏈發放，best-effort。二級分潤錨定在
    // 賣方 p2p_sell 帳本列，較難從買方列精準反推，改以有限筆數的待派發分潤掃描即時
    // 補上（同時會順帶清理少量其他待派發分潤）；發不成的由 cron / 後台補發撿回。
    await sweepPendingCommissions(admin, 20).catch(() => {});
    return json(response, 200, { status: "confirmed", tx_hash: txHash, units, payment: gross });
  } catch (e) {
    await finish(admin, claim.id, { status: "failed", error: errMsg(e) });
    return json(response, 502, { error: `鏈上成交結算失敗：${errMsg(e)}` });
  }
}

// 掛賣單一次性手續費的鏈上結算：把固定 1 JC 從賣方錢包收進 Safe 金庫（賣方→ADMIN
// →Safe 兩跳）。金額固定 1 JC（自帳本列的 amount 絕對值推導，不信任前端）。每一跳
// 的 tx 記進 payload，重試跳過已完成步驟，避免重複收取。
async function settleListFeeCore(
  admin: SupabaseClient,
  response: ServerResponse,
  feeRow: { id: string; user_id: string; amount: number },
): Promise<void> {
  const fee = Math.abs(Number(feeRow.amount));
  if (!(fee > 0)) return json(response, 422, { error: "掛單手續費金額無效" });
  const { data: ownerProfile } = await admin
    .from("profiles")
    .select("wallet_address")
    .eq("id", feeRow.user_id)
    .maybeSingle();
  let wallet: Address;
  try {
    wallet = toAddress(ownerProfile?.wallet_address, "使用者帳號");
  } catch (e) {
    return json(response, 422, { error: errMsg(e) });
  }
  if (!(await guardRelayerGas(response))) return;

  const claim = await claimSettlement(admin, {
    action: "list_fee",
    ref_key: `list_fee:${feeRow.id}`,
    user_id: feeRow.user_id,
    amount: fee,
    payment: fee,
    payload: { wallet },
  });
  if ("done" in claim) return json(response, 200, { ...claim.done, idempotent: true });
  try {
    const payload = await readSettlementPayload(admin, claim.id);
    if (!payload.jcPullTx) {
      const pullTx = await pullJcFromUser(wallet, fee);
      await mergeSettlementPayload(admin, claim.id, { jcPullTx: pullTx });
      payload.jcPullTx = pullTx;
    }
    let vaultTx = typeof payload.jcToVaultTx === "string" ? payload.jcToVaultTx : null;
    if (!vaultTx) {
      vaultTx = await sendJcToVault(fee);
      await mergeSettlementPayload(admin, claim.id, { jcToVaultTx: vaultTx });
    }
    await finish(admin, claim.id, { status: "confirmed", tx_hash: vaultTx ?? undefined });
    return json(response, 200, { status: "confirmed", tx_hash: vaultTx, payment: fee });
  } catch (e) {
    await finish(admin, claim.id, { status: "failed", error: errMsg(e) });
    return json(response, 502, { error: `掛單手續費鏈上結算失敗：${errMsg(e)}` });
  }
}

// 推廣分潤（代理獎金）鏈上即時發放：由 ADMIN 熱錢包直接把 JC transfer 給受益人
// 錢包（ADMIN→受益人，JC 合約允許與 owner 相關的轉帳）。錨定單筆 commission_logs
// （paid_at 為 null）���金額一律以該��� commission_amount 為準，絕不信任前端。成功後
// 寫入 jc_ledger 的 commission_payout（讓站內可用 JC 立即反映到帳）並標記 paid_at；
// onchain_settlements 以 ref_key `commission:<log_id>` 冪等，避免重複發放。
async function settleCommissionCore(
  admin: SupabaseClient,
  response: ServerResponse,
  log: { id: string; user_id: string; amount: number; asset_id: string | null },
): Promise<void> {
  const amount = Number(log.amount);
  if (!(amount > 0)) return json(response, 422, { error: "分潤金額無效" });
  const { data: beneficiary } = await admin
    .from("profiles")
    .select("wallet_address")
    .eq("id", log.user_id)
    .maybeSingle();
  let wallet: Address;
  try {
    wallet = toAddress(beneficiary?.wallet_address, "受益人帳號");
  } catch (e) {
    // 受益人尚未綁定鏈上錢包時，先擋下（等他登入綁定錢包後由 cron/後台自動補發）。
    return json(response, 422, { error: errMsg(e) });
  }
  if (!(await guardRelayerGas(response))) return;

  const claim = await claimSettlement(admin, {
    action: "commission",
    ref_key: `commission:${log.id}`,
    user_id: log.user_id,
    asset_id: log.asset_id,
    amount,
    payment: amount,
    payload: { wallet },
  });
  if ("done" in claim) return json(response, 200, { ...claim.done, idempotent: true });
  try {
    const payload = await readSettlementPayload(admin, claim.id);
    let payoutTx = typeof payload.payoutTx === "string" ? payload.payoutTx : null;
    if (!payoutTx) {
      // ADMIN 熱錢包用自身 JC 餘額直接 transfer 給受益人（單跳，合約允許 owner→任意）。
      payoutTx = await adminSendJc(wallet, amount);
      await mergeSettlementPayload(admin, claim.id, { payoutTx });
    }
    // 記入站內帳本（讓可用 JC 立即反映）＋標記 commission_logs 已派發，皆冪等。
    // idempotency_key 沿用 admin_pay_pending_commissions 的 `commission-payout:<log_id>`，
    // 讓「即時上鏈發放」與舊的「管理員批次派發」互相冪等，不會重複入帳。
    await admin.from("jc_ledger").upsert(
      {
        user_id: log.user_id,
        entry_type: "commission_payout",
        amount,
        asset_id: log.asset_id,
        idempotency_key: `commission-payout:${log.id}`,
        metadata: { commission_log_id: log.id, onchain: true, tx: payoutTx },
      },
      { onConflict: "idempotency_key", ignoreDuplicates: true },
    );
    await admin
      .from("commission_logs")
      .update({ paid_at: new Date().toISOString() })
      .eq("id", log.id)
      .is("paid_at", null);
    await finish(admin, claim.id, { status: "confirmed", tx_hash: payoutTx ?? undefined });
    return json(response, 200, { status: "confirmed", tx_hash: payoutTx, amount });
  } catch (e) {
    await finish(admin, claim.id, { status: "failed", error: errMsg(e) });
    return json(response, 502, { error: `分潤鏈上發放失敗：${errMsg(e)}` });
  }
}

/** 一級認購結算確認後，best-effort 把���筆購買所產生的推廣分潤「即時」上鏈發放
 *（ADMIN→受益人）。失敗只吞掉不拋出——沒發成的會被每日 cron sweep 與後台一鍵
 * 補發撿回，確保最終必定到帳並上鏈。 */
async function settleCommissionsForSource(admin: SupabaseClient, sourceLedgerId: string): Promise<void> {
  const { data: logs } = await admin
    .from("commission_logs")
    .select("id,beneficiary_id,commission_amount,asset_id")
    .eq("source_ledger_id", sourceLedgerId)
    .is("paid_at", null);
  for (const log of logs ?? []) {
    if (!log.beneficiary_id) continue;
    const { response } = fakeResponse();
    try {
      await settleCommissionCore(admin, response, {
        id: log.id,
        user_id: log.beneficiary_id,
        amount: Number(log.commission_amount),
        asset_id: log.asset_id ?? null,
      });
    } catch {
      /* 交給 cron / 後台補發 */
    }
  }
}

type ReversalResult = {
  beneficiaryId: string;
  applied: boolean;
  direction: "over" | "under" | "none";
  amount: number;
  tx?: string;
  error?: string;
};

/** 單一受益人的獎金派發「沖正」（校正差額）：比對「應派發」（commission_logs.paid_at
 * 不為 null 的應發總和）與「實際已發放」（jc_ledger 的 commission_payout ＋
 * commission_reversal 總和），金額一律伺服器端重算，絕不信任前端傳入的數字。
 *   少發 → 補足差額，並由 ADMIN 熱錢包實際上鏈把 JC 補發給受益人。
 *   多發 → 以負向 commission_reversal 校正站內帳本（鏈上已多發的 JC 無法自動回收，
 *          因 JC 合約禁止從使用者錢包強制轉出，僅校正站內可用餘額）。
 * 沖正後 owed == paid、diff 歸零，重複點擊會重算為 0 而自動略過（天然冪等）。*/
async function reverseCommissionForBeneficiary(
  admin: SupabaseClient,
  beneficiaryId: string,
): Promise<ReversalResult> {
  const [owedResult, paidResult] = await Promise.all([
    admin
      .from("commission_logs")
      .select("commission_amount")
      .eq("beneficiary_id", beneficiaryId)
      .not("paid_at", "is", null),
    admin
      .from("jc_ledger")
      .select("amount")
      .eq("user_id", beneficiaryId)
      .in("entry_type", ["commission_payout", "commission_reversal"]),
  ]);
  const owed = (owedResult.data ?? []).reduce((sum, r) => sum + Number(r.commission_amount), 0);
  const paid = (paidResult.data ?? []).reduce((sum, r) => sum + Number(r.amount), 0);
  const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
  const diff = round6(paid - owed);
  if (Math.abs(diff) <= 1e-6) {
    return { beneficiaryId, applied: false, direction: "none", amount: 0 };
  }
  if (diff < 0) {
    // 少發：補足 (owed - paid)，並實��上鏈把 JC 從 ADMIN 熱錢包補發給受益人。
    const shortfall = round6(owed - paid);
    const { data: prof } = await admin
      .from("profiles")
      .select("wallet_address")
      .eq("id", beneficiaryId)
      .maybeSingle();
    let wallet: Address;
    try {
      wallet = toAddress(prof?.wallet_address, "受益人帳號");
    } catch (e) {
      return { beneficiaryId, applied: false, direction: "under", amount: shortfall, error: errMsg(e) };
    }
    const tx = await adminSendJc(wallet, shortfall);
    if (!tx) throw new Error("分潤補發額度為 0，未送出鏈上交易");
    await admin.from("jc_ledger").insert({
      user_id: beneficiaryId,
      entry_type: "commission_reversal",
      amount: shortfall,
      idempotency_key: `commission-reverse:${beneficiaryId}:${Date.now()}`,
      metadata: { kind: "under", reason: "沖正補發少發分潤", tx },
    });
    await admin.from("onchain_settlements").insert({
      action: "commission_reverse",
      ref_key: `commission_reverse:${beneficiaryId}:${Date.now()}`,
      user_id: beneficiaryId,
      amount: shortfall,
      status: "confirmed",
      tx_hash: tx,
    });
    return { beneficiaryId, applied: true, direction: "under", amount: shortfall, tx };
  }
  // 多發：以負向沖正校正站內帳本（不上鏈，鏈上多發的 JC 無法自動回收）。
  const excess = round6(paid - owed);
  await admin.from("jc_ledger").insert({
    user_id: beneficiaryId,
    entry_type: "commission_reversal",
    amount: -excess,
    idempotency_key: `commission-reverse:${beneficiaryId}:${Date.now()}`,
    metadata: { kind: "over", reason: "沖正扣回多發分潤（僅校正站內帳本）" },
  });
  await admin.from("onchain_settlements").insert({
    action: "commission_reverse",
    ref_key: `commission_reverse:${beneficiaryId}:${Date.now()}`,
    user_id: beneficiaryId,
    amount: -excess,
    status: "confirmed",
  });
  return { beneficiaryId, applied: true, direction: "over", amount: excess };
}

/** 全站待派發分潤（commission_logs.paid_at 為 null）的即時上鏈補發：由 cron 定期
 * 掃描、二級成交後即時觸發、以及後台一鍵派發共用。每筆冪等（onchain_settlements
 * ref_key `commission:<log_id>` + jc_ledger `commission-payout:<log_id>`），受益人
 * 尚未綁定錢包者會被跳過、留待其��定後下次掃描補上。limit 控制單次處理筆數，避免
 * 單一請求跑太久（其餘留待下一輪 cron）。*/
export async function sweepPendingCommissions(
  admin: SupabaseClient,
  limit = 100,
  beneficiaryIds?: string[],
): Promise<{ scanned: number; settled: number; skipped: number }> {
  let query = admin
    .from("commission_logs")
    .select("id,beneficiary_id,commission_amount,asset_id")
    .is("paid_at", null)
    .not("beneficiary_id", "is", null)
    .gt("commission_amount", 0);
  if (beneficiaryIds && beneficiaryIds.length > 0) {
    query = query.in("beneficiary_id", beneficiaryIds);
  }
  const { data: logs } = await query.order("created_at", { ascending: true }).limit(limit);
  let settled = 0;
  let skipped = 0;
  for (const log of logs ?? []) {
    if (!log.beneficiary_id) {
      skipped += 1;
      continue;
    }
    const { response, read } = fakeResponse();
    try {
      await settleCommissionCore(admin, response, {
        id: log.id,
        user_id: log.beneficiary_id,
        amount: Number(log.commission_amount),
        asset_id: log.asset_id ?? null,
      });
      const { status } = read();
      if (status >= 200 && status < 300) settled += 1;
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { scanned: logs?.length ?? 0, settled, skipped };
}

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return json(response, 405, { error: "Method not allowed" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceKey) {
    return json(response, 503, { error: "Relayer 尚未設定 Supabase 連線" });
  }
  if (!process.env.ADMIN_PRIVATE_KEY) {
    return json(response, 503, { error: "Relayer 尚未設定 ADMIN_PRIVATE_KEY（後端熱錢包私鑰）" });
  }

  const authHeader = request.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return json(response, 401, { error: "缺少登入憑證" });

  let body: { action?: string; requestKey?: string; placementId?: string; beneficiaryIds?: string[]; assetKey?: string; expectedAmount?: string };
  try {
    body = await readBody(request);
  } catch {
    return json(response, 400, { error: "Invalid request body" });
  }
  const action = body.action;
  if (!action) return json(response, 400, { error: "缺少 action" });

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await admin.auth.getUser(token);
  const caller = userData?.user;
  if (userError || !caller) return json(response, 401, { error: "登入憑證無效" });

  const { data: callerProfile } = await admin
    .from("profiles")
    .select("id,agency_role,role,wallet_address")
    .eq("id", caller.id)
    .maybeSingle();
  if (!callerProfile) return json(response, 403, { error: "找不到平台帳號" });

  // 寫入型 relayer 請求順手觸發一次機會式自動補發。唯讀回收清單不觸發額外鏈上寫入。
  if (action !== "legacy-reclaim-list") await maybeOpportunisticSweep(admin);

  try {
    // ---- 一次性：把子合約位址寫進 RWA 母合約（僅限管理員）----
    if (action === "wire-contracts") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const results = await wireRwaContracts();
      // 只把「真正的鏈上交易雜湊」寫進 tx_hash 欄位，"already-set"/"failed"/"unknown"
      // 這些狀態字串不是雜湊，不應塞進該欄位。
      const realHash =
        [results.subscription, results.market].find(
          (value) => typeof value === "string" && value.startsWith("0x"),
        ) ?? null;
      await admin.from("onchain_settlements").insert({
        action: "wire_contracts",
        ref_key: `wire_contracts:${Date.now()}`,
        user_id: caller.id,
        status: "confirmed",
        tx_hash: realHash,
        payload: results,
      });
      // marketError 存在時 ok=false，讓前端顯示「一級成功、二級因合約缺陷失敗」。
      return json(response, 200, { ok: !results.marketError, results, relayer: relayerAddress() });
    }

    // ---- 管理員：只查詢所選代理的收款錢包，避免在瀏覽器載入所有用戶地址。----
    if (action === "admin-agent-wallet") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const recipientId = (body as { recipientId?: string }).recipientId?.trim();
      if (!recipientId) return json(response, 400, { error: "請先選擇代理" });
      const { data: recipient } = await admin
        .from("profiles")
        .select("id,agency_role,wallet_address")
        .eq("id", recipientId)
        .maybeSingle();
      if (!recipient || !String(recipient.agency_role ?? "").includes("代理")) {
        return json(response, 404, { error: "找不到有效的代理帳號" });
      }
      try {
        return json(response, 200, { wallet: toAddress(recipient.wallet_address, "代理帳號") });
      } catch (e) {
        return json(response, 422, { error: errMsg(e) });
      }
    }

    // ---- 使用者查詢／回收自己的舊 AE、RWA：數量由本人歷史帳本、今日保留額與鏈上餘額重算。----
    if (action === "legacy-reclaim-list" || action === "legacy-reclaim") {
      let wallet: Address;
      try {
        wallet = toAddress(callerProfile.wallet_address, "使用者帳號");
      } catch (e) {
        return json(response, 422, { error: errMsg(e) });
      }

      if (action === "legacy-reclaim-list") {
        await reconcileLegacyReclaimReceipts(admin, caller.id);
        const candidates = await readLegacyReclaimCandidates(admin, caller.id, wallet);
        return json(response, 200, { cutoff: LEGACY_RECLAIM_CUTOFF, candidates });
      }

      const assetKey = body.assetKey?.trim();
      const expectedAmount = body.expectedAmount?.trim();
      const validAssetKey = assetKey && /^(?:legacy-ae|legacy-rwa:0x[a-f0-9]{40}|legacy-rwa-placement:[A-Za-z0-9_-]{1,120})$/.test(assetKey);
      if (!validAssetKey || !expectedAmount || expectedAmount.length > 80 || !/^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/.test(expectedAmount)) {
        return json(response, 400, { error: "回收資產或數量格式錯誤，請重新整理後再試" });
      }
      const refKey = `legacy_asset_reclaim:${caller.id}:${assetKey}`;
      const { data: existingSettlement, error: settlementReadError } = await admin
        .from("onchain_settlements")
        .select("id,action,status,tx_hash,user_id,asset_id,amount,payload,updated_at")
        .eq("ref_key", refKey)
        .maybeSingle();
      let settlement = existingSettlement;
      if (settlementReadError) throw new Error(`讀取回收狀態失敗：${settlementReadError.message}`);

      if (settlement && (settlement.action !== "ae_reclaim_legacy" || settlement.user_id !== caller.id || settlement.asset_id !== assetKey)) {
        return json(response, 409, { error: "回收識別碼資料不一致，請聯繫客服" });
      }
      if (settlement?.status === "confirmed") {
        return json(response, 200, { status: "confirmed", txHash: settlement.tx_hash, amount: String(settlement.amount ?? "0") });
      }
      if (settlement?.status === "pending") {
        if (!settlement.tx_hash) {
          const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
          if (new Date(settlement.updated_at).getTime() >= Date.parse(staleBefore)) {
            return json(response, 409, { status: "pending", error: "此資產已有回收請求處理中，請稍後重新整理" });
          }
          const { data: staleClaim, error } = await admin
            .from("onchain_settlements")
            .update({ status: "failed", error: "回收請求逾時且未送出鏈上交易，可安全重試", updated_at: new Date().toISOString() })
            .eq("id", settlement.id)
            .eq("status", "pending")
            .is("tx_hash", null)
            .lt("updated_at", staleBefore)
            .select("id")
            .maybeSingle();
          if (error) throw new Error(`恢復過期回收請求失敗：${error.message}`);
          if (!staleClaim) return json(response, 409, { status: "pending", error: "此資產已有回收請求處理中，請稍後重新整理" });
          settlement.status = "failed";
        } else {
          try {
          const confirmed = await waitForAdminAssetReclaim(settlement.tx_hash as `0x${string}`);
          if (confirmed) {
            const { error } = await admin.from("onchain_settlements").update({ status: "confirmed", error: null, updated_at: new Date().toISOString() }).eq("id", settlement.id);
            if (error) throw new Error(`已上鏈但更新回收狀態失敗：${error.message}`);
            return json(response, 200, { status: "confirmed", txHash: settlement.tx_hash, amount: String(settlement.amount ?? "0") });
          }
          const { error } = await admin.from("onchain_settlements").update({ status: "failed", error: "鏈上回收交易已 revert", updated_at: new Date().toISOString() }).eq("id", settlement.id);
          if (error) throw new Error(`更新失敗回收狀態失敗：${error.message}`);
          settlement.status = "failed";
          } catch {
            return json(response, 202, { status: "pending", txHash: settlement.tx_hash, amount: String(settlement.amount ?? "0") });
          }
        }
      }

      const candidates = await readLegacyReclaimCandidates(admin, caller.id, wallet);
      const candidate = candidates.find((item) => item.assetKey === assetKey);
      if (!candidate || candidate.status !== "ready" || !candidate.tokenAddress || candidate.decimals == null) {
        return json(response, 409, { error: "目前沒有可回收的舊持倉，或鏈上餘額／今日保留額已變動，請重新整理" });
      }
      let requestedUnits: bigint;
      let candidateUnits: bigint;
      try {
        requestedUnits = parseUnits(expectedAmount, candidate.decimals);
        candidateUnits = parseUnits(candidate.amount, candidate.decimals);
      } catch {
        return json(response, 400, { error: "回收數量超出代幣精度，請重新整理後再試" });
      }
      if (requestedUnits <= 0n || requestedUnits !== candidateUnits) {
        return json(response, 409, { error: "回收額度已變動，請重新整理並重新授權精確額度" });
      }

      const payload = {
        assetKey,
        assetType: candidate.kind,
        tokenAddress: candidate.tokenAddress,
        wallet,
        amount: candidate.amount,
        todayCutoff: LEGACY_RECLAIM_CUTOFF,
      };
      if (settlement?.status === "failed") {
        const { data: claimed, error } = await admin
          .from("onchain_settlements")
          .update({ status: "pending", tx_hash: null, error: null, amount: candidate.amount, payload, updated_at: new Date().toISOString() })
          .eq("id", settlement.id)
          .eq("status", "failed")
          .select("id,action,status,tx_hash,user_id,asset_id,amount,payload,updated_at")
          .maybeSingle();
        if (error) throw new Error(`重新建立回收請求失敗：${error.message}`);
        if (!claimed) return json(response, 409, { status: "pending", error: "此資產已有回收請求處理中，請稍後重新整理" });
        settlement = claimed;
      } else if (!settlement) {
        const { data: inserted, error } = await admin
          .from("onchain_settlements")
          .insert({
            action: "ae_reclaim_legacy",
            ref_key: refKey,
            user_id: caller.id,
            asset_id: assetKey,
            amount: candidate.amount,
            status: "pending",
            payload,
          })
          .select("id,action,status,tx_hash,user_id,asset_id,amount,payload,updated_at")
          .single();
        if (error) {
          if (error.code === "23505") return json(response, 409, { status: "pending", error: "此資產已有回收請求處理中，請稍後重新整理" });
          throw new Error(`建立回收紀錄失敗：${error.message}`);
        }
        settlement = inserted;
      }
      if (!settlement?.id) {
        return json(response, 500, { error: "回收紀錄未成功鎖定，請稍後重試" });
      }

      let txHash: `0x${string}`;
      try {
        txHash = await sendAdminAssetReclaim({
          tokenAddress: candidate.tokenAddress,
          owner: wallet,
          amount: candidate.amount,
          label: candidate.label,
        });
      } catch (e) {
        await admin.from("onchain_settlements").update({ status: "failed", error: errMsg(e), updated_at: new Date().toISOString() }).eq("id", settlement.id);
        return json(response, 422, { status: "failed", error: errMsg(e) });
      }

      const { error: hashError } = await admin
        .from("onchain_settlements")
        .update({ tx_hash: txHash, updated_at: new Date().toISOString() })
        .eq("id", settlement.id);
      if (hashError) {
        return json(response, 503, { status: "pending", txHash, error: "交易已送出，回收紀錄尚未同步，請稍後重新整理並聯繫客服提供交易雜湊" });
      }
      try {
        const confirmed = await waitForAdminAssetReclaim(txHash);
        const status = confirmed ? "confirmed" : "failed";
        const { error } = await admin
          .from("onchain_settlements")
          .update({ status, error: confirmed ? null : "鏈上回收交易已 revert", updated_at: new Date().toISOString() })
          .eq("id", settlement.id);
        if (error) throw new Error(`更新回收狀態失敗：${error.message}`);
        return json(response, confirmed ? 200 : 422, {
          status,
          txHash,
          amount: candidate.amount,
          error: confirmed ? undefined : "鏈上回收交易失敗，請確認錢包授權後重試",
        });
      } catch {
        return json(response, 202, { status: "pending", txHash, amount: candidate.amount });
      }
    }

    // ---- 回傳 ADMIN 熱錢包地址。僅需登入即可查詢，不含任何機密。----
    if (action === "relayer-address") {
      return json(response, 200, { address: relayerAddress() });
    }

    // ---- 管理員唯讀診斷：ADMIN 熱錢包目前持有的 JC/AE 庫存。純讀取，不做
    // 任何鏈上寫入，用來確認「是否需要人工從 Safe 金庫轉帳補貨」。----
    if (action === "admin-vault-status") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const [jc, ae] = await Promise.all([getVaultStatus("jcToken"), getVaultStatus("aeToken")]);
      const serialize = (s: Awaited<ReturnType<typeof getVaultStatus>>) => ({
        token: s.token,
        tokenAddress: s.tokenAddress,
        balance: s.balanceFormatted,
        low: s.low,
      });
      // RWA 標的：只列上架中（is_active 且未下架）、非 AE、且已部署專屬代幣的標的，
      // 逐一讀 ADMIN 熱錢包在該份額代幣的鏈上餘額。下架標的一律排除。
      const { data: rwaPlacements } = await admin
        .from("private_placements")
        .select("id,name,token_address,is_ae_token,is_active,is_delisted")
        .eq("is_ae_token", false)
        .eq("is_active", true)
        .eq("is_delisted", false);
      const rwa = (
        await Promise.all(
          (rwaPlacements ?? [])
            .filter((p) => toFactoryTokenAddress(p.token_address))
            .map(async (p) => {
              try {
                const s = await getHotWalletShareBalance(p.token_address as string);
                return { name: String(p.name ?? ""), tokenAddress: s.tokenAddress, balance: s.balanceFormatted };
              } catch {
                return null;
              }
            }),
        )
      ).filter((x): x is { name: string; tokenAddress: Address; balance: string } => x != null);
      return json(response, 200, { admin: relayerAddress(), jc: serialize(jc), ae: serialize(ae), rwa });
    }

    // ---- 管理員：在新版 JC/AE 合約上增發供給量給指定地址（預設 Safe 金庫）。
    // 這是真的呼叫合約 mint，會增加代幣總供給量，與單純搬動熱錢包餘額不同，
    // 故獨立成一個高風險 action，僅限管理員、且金額必須為正數。----
    if (action === "admin-mint") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const input = body as { token?: string; amount?: number; to?: string };
      const token = input.token === "jc" ? "jcToken" : input.token === "ae" ? "aeToken" : null;
      if (!token) return json(response, 400, { error: "token 必須是 jc 或 ae" });
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return json(response, 400, { error: "增發數量必須是大於 0 的數字" });
      }
      let to: Address;
      try {
        to = input.to && input.to.trim() ? toAddress(input.to.trim(), "增發目標地址") : getAddress(RELAYER_ADDRESSES.safeVault);
      } catch (e) {
        return json(response, 422, { error: errMsg(e) });
      }
      try {
        const txHash = await mintTokenSupply(token, to, amount);
        return json(response, 200, { txHash, token: input.token, to, amount });
      } catch (e) {
        return json(response, 502, { error: errMsg(e) });
      }
    }

    // ---- 管理員：「AE 歸零」前的鏈上強制收回。掃描所有持有 AE 標的的使用者
    // 錢包，用 AEToken 的 owner-only adminReclaim 把其鏈上真實 AE 餘額收回
    // Safe 金庫（不受 allowance 限制，一定能收回）。必須在呼叫
    // admin_reset_ae_token（會清空 holdings）之前執行，否則抓不到持有人清單。----
    if (action === "admin-ae-reclaim") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const { data: aePlacements, error: aeErr } = await admin
        .from("private_placements")
        .select("id")
        .eq("is_ae_token", true);
      if (aeErr) throw new Error(`查詢 AE 標的失敗：${aeErr.message}`);
      const aeIds = (aePlacements ?? []).map((p) => p.id as string);
      if (aeIds.length === 0) return json(response, 200, { reclaimed: [], failed: [] });
      const { data: holders, error: holdErr } = await admin
        .from("holdings")
        .select("user_id, profiles!inner(wallet_address)")
        .in("asset_id", aeIds);
      if (holdErr) throw new Error(`查詢持有人失敗：${holdErr.message}`);
      const wallets = Array.from(
        new Set(
          (holders ?? [])
            .map((h: any) => (h.profiles?.wallet_address as string | null)?.trim())
            .filter((w): w is string => !!w && /^0x[a-fA-F0-9]{40}$/.test(w)),
        ),
      );
      const reclaimed: { wallet: string; amount: number; txHash: string }[] = [];
      const failed: { wallet: string; error: string }[] = [];
      for (const w of wallets) {
        try {
          const wallet = getAddress(w);
          const balance = await getAeChainBalance(wallet);
          if (balance <= 0) continue;
          const txHash = await adminReclaimAe(wallet, balance);
          if (txHash) reclaimed.push({ wallet: w, amount: balance, txHash });
        } catch (e) {
          failed.push({ wallet: w, error: errMsg(e) });
        }
      }
      return json(response, 200, { reclaimed, failed });
    }

    // ---- 管理員：「RWA 下架」前的鏈上強制收回（best-effort）。掃描該標的所有
    // 持有人錢包，嘗試用其對 ADMIN 的既有授權 transferFrom 把份額收回 Safe 金庫。
    // RWA 份額代幣沒有像 JC/AE 新合約那樣的 owner-only adminReclaim，若該使用者
    // 從未對 ADMIN approve 過會失敗，失敗的列入 failed 供管理員知悉（不影響下架
    // 本身繼續執行——站內 JC 已原路退款、holdings 會被 admin_deactivate_placement
    // 清空）。必須在呼叫 admin_deactivate_placement 之前執行，否則抓不到持有人。----
    if (action === "admin-rwa-reclaim") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const placementId = String((body as { placementId?: string }).placementId ?? "").trim();
      if (!placementId) return json(response, 400, { error: "缺少 placementId" });
      const { data: placement, error: pErr } = await admin
        .from("private_placements")
        .select("id, token_address")
        .eq("id", placementId)
        .maybeSingle();
      if (pErr) throw new Error(`查詢標的失敗：${pErr.message}`);
      const tokenAddress = toFactoryTokenAddress(placement?.token_address ?? null);
      if (!tokenAddress) {
        return json(response, 200, { skipped: true, reason: "此標的尚未部署鏈上專屬代幣，無需鏈上收回" });
      }
      const { data: holders, error: holdErr } = await admin
        .from("holdings")
        .select("user_id, profiles!inner(wallet_address)")
        .eq("asset_id", placementId);
      if (holdErr) throw new Error(`查詢持有人失敗：${holdErr.message}`);
      const wallets = Array.from(
        new Set(
          (holders ?? [])
            .map((h: any) => (h.profiles?.wallet_address as string | null)?.trim())
            .filter((w): w is string => !!w && /^0x[a-fA-F0-9]{40}$/.test(w)),
        ),
      );
      const reclaimed: { wallet: string; amount: number; txHash: string }[] = [];
      const failed: { wallet: string; error: string }[] = [];
      for (const w of wallets) {
        try {
          const wallet = getAddress(w);
          const { balance } = await getWalletShareBalance(tokenAddress, wallet);
          if (balance <= 0) continue;
          const txHash = await reclaimRwaShare(getAddress(tokenAddress), wallet, balance);
          if (txHash) reclaimed.push({ wallet: w, amount: balance, txHash });
        } catch (e) {
          failed.push({ wallet: w, error: errMsg(e) });
        }
      }
      return json(response, 200, { reclaimed, failed });
    }

    // ---- 管理員：重新查詢個別派發交易收據，並在確認後同步網站帳本。----
    if (action === "admin-asset-payout-check") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const requestKey = (body as { requestKey?: string }).requestKey?.trim();
      if (!requestKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey)) {
        return json(response, 400, { error: "派發識別碼無效" });
      }
      const refKey = `admin_payout:${requestKey}`;
      const { data: settlement, error } = await admin
        .from("onchain_settlements")
        .select("id,action,status,tx_hash,payload")
        .eq("ref_key", refKey)
        .maybeSingle();
      if (error || !settlement || settlement.action !== "admin_payout") {
        return json(response, 404, { error: "找不到個別派發紀錄" });
      }
      const applyPayout = async (txHash: string) => {
        const { error: ledgerError } = await admin.rpc("admin_apply_asset_payout", { p_ref_key: refKey });
        if (ledgerError) {
          return json(response, 500, {
            error: `鏈上已確認，但網站帳本同步失敗；請再次查詢以重試同步。${ledgerError.message}`,
            status: "confirmed",
            tx_hash: txHash,
          });
        }
        return json(response, 200, { status: "confirmed", tx_hash: txHash });
      };
      if (settlement.status === "confirmed" && settlement.tx_hash) return applyPayout(settlement.tx_hash);
      if (settlement.status === "failed") {
        return json(response, 200, { status: "failed", tx_hash: settlement.tx_hash });
      }
      if (!settlement.tx_hash) {
        return json(response, 202, { status: "pending", tx_hash: null, message: "尚未取得鏈上交易雜湊" });
      }
      try {
        const txHash = settlement.tx_hash as `0x${string}`;
        const confirmed = await waitForAdminAssetPayout(txHash);
        if (!confirmed) {
          await finish(admin, settlement.id, { status: "failed", tx_hash: txHash, error: "鏈上交易 reverted" });
          return json(response, 200, { status: "failed", tx_hash: txHash });
        }
        await finish(admin, settlement.id, { status: "confirmed", tx_hash: txHash });
        return applyPayout(txHash);
      } catch {
        return json(response, 202, { status: "pending", tx_hash: settlement.tx_hash });
      }
    }

    // ---- 管理員：個別派發歷史。透過 service-role API 讀取，避免將結算表開放給一般使用者。----
    if (action === "admin-asset-payout-history") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const { data: rows, error } = await admin
        .from("onchain_settlements")
        .select("id,ref_key,user_id,asset_id,amount,tx_hash,status,error,payload,created_at,updated_at")
        .eq("action", "admin_payout")
        .order("created_at", { ascending: false })
        .limit(30);
      if (error) return json(response, 500, { error: `派發紀錄讀取失敗：${error.message}` });
      const userIds = [...new Set((rows ?? []).map((row) => row.user_id).filter((id): id is string => Boolean(id)))];
      const placementIds = [...new Set((rows ?? []).map((row) => row.asset_id).filter((id): id is string => Boolean(id)))];
      const [profilesResult, placementsResult] = await Promise.all([
        userIds.length
          ? admin.from("profiles").select("id,email").in("id", userIds)
          : Promise.resolve({ data: [], error: null }),
        placementIds.length
          ? admin.from("private_placements").select("id,name").in("id", placementIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (profilesResult.error || placementsResult.error) {
        return json(response, 500, { error: "派發紀錄關聯資料讀取失敗" });
      }
      const emailById = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile.email]));
      const placementById = new Map((placementsResult.data ?? []).map((placement) => [placement.id, placement.name]));
      return json(response, 200, {
        payouts: (rows ?? []).map((row, index) => {
          const payload = row.payload as Record<string, unknown>;
          const assetType = String(payload.assetType ?? "");
          const placementId = payload.placementId ? String(payload.placementId) : null;
          const amount = String(payload.amount ?? row.amount ?? "0");
          const supersededBy = (rows ?? []).slice(0, index).find((newerRow) => {
            const newerPayload = newerRow.payload as Record<string, unknown>;
            return newerRow.status === "confirmed" && Boolean(newerRow.tx_hash) &&
              newerRow.user_id === row.user_id && newerRow.asset_id === row.asset_id &&
              newerPayload.assetType === assetType && String(newerPayload.amount ?? newerRow.amount ?? "0") === amount &&
              (newerPayload.placementId ? String(newerPayload.placementId) : null) === placementId;
          });
          return {
            id: row.id,
            requestKey: row.ref_key.replace(/^admin_payout:/, ""),
            recipientId: row.user_id,
            recipientEmail: row.user_id ? emailById.get(row.user_id) ?? null : null,
            assetType,
            placementId,
            placementName: row.asset_id ? placementById.get(row.asset_id) ?? null : null,
            amount,
            status: row.status,
            txHash: row.tx_hash,
            error: row.error,
            accounted: payload.accounted === true,
            superseded: Boolean(supersededBy),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };
        }).slice(0, 5),
      });
    }

    // ---- 管理員：個別代理資產派發。收款人與合約位址只由伺服器端資料推導；
    // 每筆請求用 requestKey 冪等，並在確認鏈上成功後才同步網站 JC／AE／RWA 帳本。----
    if (action === "admin-asset-payout") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const input = body as {
        recipientId?: string;
        assetType?: string;
        amount?: string;
        placementId?: string;
        requestKey?: string;
      };
      const recipientId = input.recipientId?.trim();
      const assetType = input.assetType;
      const amount = input.amount?.trim();
      const placementId = input.placementId?.trim() || null;
      const requestKey = input.requestKey?.trim();
      if (!recipientId || !amount || !requestKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey)) {
        return json(response, 400, { error: "派發資料不完整，請重新操作" });
      }
      if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(amount) || !(Number(amount) > 0) || Number(amount) > 1_000_000_000_000) {
        return json(response, 400, { error: "數量須大於 0，且最多輸入 6 位小數" });
      }
      if (!["jc", "ae", "rwa", "usdt"].includes(String(assetType))) {
        return json(response, 400, { error: "不支援的派發資產" });
      }
      if (assetType === "rwa" && !/^\d+$/.test(amount)) {
        return json(response, 400, { error: "RWA 份額派發僅支援整數" });
      }
      if ((assetType === "rwa" || assetType === "ae") !== Boolean(placementId)) {
        return json(response, 400, { error: "請選擇要記入網站持倉的標的" });
      }

      const { data: recipient } = await admin
        .from("profiles")
        .select("id,email,agency_role,wallet_address")
        .eq("id", recipientId)
        .maybeSingle();
      if (!recipient || !String(recipient.agency_role ?? "").includes("代理")) {
        return json(response, 404, { error: "找不到有效的代理帳號" });
      }
      let wallet: Address;
      try {
        wallet = toAddress(recipient.wallet_address, "代理帳號");
      } catch (e) {
        return json(response, 422, { error: errMsg(e) });
      }

      let tokenAddress: Address;
      let assetLabel: string;
      let ledgerAssetId: string | null = null;
      if (assetType === "jc") {
        tokenAddress = RELAYER_ADDRESSES.jcToken;
        assetLabel = "JC";
      } else if (assetType === "ae") {
        const { data: placement } = await admin
          .from("private_placements")
          .select("id,name,is_ae_token")
          .eq("id", placementId)
          .maybeSingle();
        if (!placement?.is_ae_token) return json(response, 422, { error: "所選網站標的不是 AE 標的" });
        tokenAddress = RELAYER_ADDRESSES.aeToken;
        assetLabel = `AE（${placement.name}）`;
        ledgerAssetId = placement.id;
      } else if (assetType === "rwa") {
        const { data: placement } = await admin
          .from("private_placements")
          .select("id,name,is_ae_token,token_address")
          .eq("id", placementId)
          .maybeSingle();
        const rwaToken = toFactoryTokenAddress(placement?.token_address);
        if (!placement || placement.is_ae_token || !rwaToken) {
          return json(response, 422, { error: "所選 RWA 標的尚未部署有效的專屬代幣" });
        }
        tokenAddress = rwaToken;
        assetLabel = `RWA（${placement.name}）`;
        ledgerAssetId = placement.id;
      } else {
        tokenAddress = RELAYER_ADDRESSES.usdt;
        assetLabel = "USDT";
      }

      const refKey = `admin_payout:${requestKey}`;
      const payload = { assetType, amount, wallet, tokenAddress, placementId };
      let { data: settlement } = await admin
        .from("onchain_settlements")
        .select("id,action,status,tx_hash,user_id,asset_id,payload")
        .eq("ref_key", refKey)
        .maybeSingle();
      let isNewSettlement = false;
      if (settlement) {
        const saved = settlement.payload as Record<string, unknown>;
        if (
          settlement.action !== "admin_payout" || settlement.user_id !== recipientId ||
          settlement.asset_id !== ledgerAssetId || saved.assetType !== assetType ||
          saved.amount !== amount || saved.placementId !== placementId ||
          saved.wallet !== wallet || saved.tokenAddress !== tokenAddress
        ) {
          return json(response, 409, { error: "此派發識別碼已用於其他資料，請重新操作" });
        }
      } else {
        const inserted = await admin
          .from("onchain_settlements")
          .insert({
            action: "admin_payout",
            ref_key: refKey,
            user_id: recipientId,
            counterparty_id: caller.id,
            asset_id: ledgerAssetId,
            amount: Number(amount),
            status: "pending",
            payload,
          })
          .select("id,action,status,tx_hash,user_id,asset_id,payload")
          .single();
        settlement = inserted.data;
        if (inserted.error || !settlement) {
          const raced = await admin
            .from("onchain_settlements")
            .select("id,action,status,tx_hash,user_id,asset_id,payload")
            .eq("ref_key", refKey)
            .maybeSingle();
          if (!raced.data) {
            return json(response, 500, { error: `無法建立派發稽核紀錄：${inserted.error?.message ?? "未知資料庫錯誤"}` });
          }
          settlement = raced.data;
          const saved = settlement.payload as Record<string, unknown>;
          if (
            settlement.action !== "admin_payout" || settlement.user_id !== recipientId ||
            settlement.asset_id !== ledgerAssetId || saved.amount !== amount ||
            saved.wallet !== wallet || saved.assetType !== assetType ||
            saved.placementId !== placementId || saved.tokenAddress !== tokenAddress
          ) {
            return json(response, 409, { error: "此派發識別碼已用於其他資料，請重新操作" });
          }
        } else {
          isNewSettlement = true;
        }
      }

      const applyPayoutToWebsite = async (txHash: string) => {
        const { error } = await admin.rpc("admin_apply_asset_payout", { p_ref_key: refKey });
        if (error) {
          return json(response, 500, {
            error: `鏈上已成功轉帳（${txHash}），但網站帳本同步失敗；請使用同一筆派發重試同步。${error.message}`,
            status: "confirmed",
            tx_hash: txHash,
            requestKey,
          });
        }
        return json(response, 200, { status: "confirmed", tx_hash: txHash, assetType, amount, wallet, requestKey });
      };

      if (settlement.status === "confirmed" && settlement.tx_hash) {
        return applyPayoutToWebsite(settlement.tx_hash);
      }
      if (settlement.status === "pending" && settlement.tx_hash) {
        try {
          const confirmed = await waitForAdminAssetPayout(settlement.tx_hash as `0x${string}`);
          if (confirmed) {
            await finish(admin, settlement.id, { status: "confirmed", tx_hash: settlement.tx_hash });
            return applyPayoutToWebsite(settlement.tx_hash);
          }
          await finish(admin, settlement.id, { status: "failed", tx_hash: settlement.tx_hash, error: "鏈上交易 reverted" });
          settlement.status = "failed";
        } catch {
          return json(response, 202, { status: "pending", tx_hash: settlement.tx_hash, assetType, amount, wallet, requestKey });
        }
      } else if (settlement.status === "pending" && !isNewSettlement) {
        return json(response, 202, { status: "pending", assetType, amount, wallet, requestKey });
      }

      if (!(await guardRelayerGas(response))) return;
      let txHash: `0x${string}`;
      try {
        txHash = await sendAdminAssetPayout({ tokenAddress, recipient: wallet, amount, label: assetLabel });
      } catch (e) {
        await finish(admin, settlement.id, { status: "failed", error: errMsg(e) });
        return json(response, 502, { error: `熱錢包派發失敗：${errMsg(e)}` });
      }
      const savedTx = await admin
        .from("onchain_settlements")
        .update({ status: "pending", tx_hash: txHash, error: null, updated_at: new Date().toISOString() })
        .eq("id", settlement.id);
      if (savedTx.error) {
        return json(response, 500, { error: `交易已送出但無法儲存交易雜湊：${txHash}`, tx_hash: txHash, status: "pending", requestKey });
      }
      try {
        const confirmed = await waitForAdminAssetPayout(txHash);
        if (!confirmed) {
          await finish(admin, settlement.id, { status: "failed", tx_hash: txHash, error: "鏈上交易 reverted" });
          return json(response, 502, { error: `鏈上轉帳失敗：${txHash}`, tx_hash: txHash, status: "failed" });
        }
      } catch {
        return json(response, 202, { status: "pending", tx_hash: txHash, assetType, amount, wallet, requestKey });
      }
      await finish(admin, settlement.id, { status: "confirmed", tx_hash: txHash });
      return applyPayoutToWebsite(txHash);
    }

    // ---- 管理員：在 RWA Factory 為此標的部署專屬份額代幣（僅限尚未有
    // token_address 的標的），成功後直接把回傳地址寫回 private_placements，
    // 前端不需要另外呼叫一次 admin_set_placement_token_address。----
    if (action === "admin-create-rwa-token") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const placementId = (body as { placementId?: string }).placementId;
      if (!placementId) return json(response, 400, { error: "缺少 placementId" });
      const { data: placement } = await admin
        .from("private_placements")
        .select("id,name,token_name,token_symbol,token_decimals,token_address,total_supply,is_ae_token")
        .eq("id", placementId)
        .maybeSingle();
      if (!placement) return json(response, 404, { error: "找不到對應的標的" });
      if (placement.is_ae_token) return json(response, 422, { error: "AE 代幣不使用 RWA Factory" });
      // 只有在 DB 已存「有效非零地址」時才視為已建立；若為 null / 空字串 / 零地址，
      // 一律往下走 createRwaFactoryToken（其內部會用 tokenByPlacement 找出鏈上是否
      // 已有專屬代幣，若有就回填正確地址、自我修復先前存成零地址的紀錄）。
      const existingAddr = toFactoryTokenAddress(placement.token_address);
      if (existingAddr) {
        return json(response, 200, { tokenAddress: existingAddr, alreadyExisted: true });
      }
      const symbol = String(placement.token_symbol ?? "").trim();
      if (!symbol) return json(response, 422, { error: "請先在編輯器填寫並儲存「代幣符號（Token Symbol）」" });
      const name = String(placement.token_name ?? placement.name ?? "").trim();
      if (!name) return json(response, 422, { error: "請先在編輯器填寫並儲存「代幣名稱（Token Name）」" });
      const decimals = placement.token_decimals == null ? 18 : Number(placement.token_decimals);
      const totalSupply = Number(placement.total_supply);
      if (!(totalSupply > 0)) return json(response, 422, { error: "此標的的總供給量無效" });
      if (!(await guardRelayerGas(response))) return;
      try {
        const result = await createRwaFactoryToken(placementId, name, symbol, decimals, totalSupply);
        await admin.from("private_placements").update({ token_address: result.tokenAddress }).eq("id", placementId);
        await admin.from("onchain_settlements").insert({
          action: "create_rwa_token",
          ref_key: `create_rwa_token:${placementId}`,
          user_id: caller.id,
          asset_id: placementId,
          status: "confirmed",
          tx_hash: result.txHash.startsWith("0x") ? result.txHash : null,
          payload: { tokenAddress: result.tokenAddress, alreadyExisted: result.alreadyExisted },
        });
        return json(response, 200, { tokenAddress: result.tokenAddress, txHash: result.txHash, alreadyExisted: result.alreadyExisted });
      } catch (e) {
        return json(response, 502, { error: `建立 RWA 代幣失敗：${errMsg(e)}` });
      }
    }

    // requestKey 只是 mint-jc / subscribe / trade 這三個「站內帳本先扣款、鏈上
    // 結算靠 idempotency_key 錨回原始帳本列」的操作需要的參數。管理員清單／
    // 補發（admin-list-settlements、admin-retry-settlement）以及後面的一次性
    // wiring 動作都不帶 requestKey，過去這道檢查寫在所有分支共用的地方，導致
    // 這兩個管理員 action 永遠在還沒進到自己的判斷前就被擋成 400，前端只能看
    // 到籠統的「relayer admin-list-settlements 失敗」。改成只在真的需要
    // requestKey 的三個 action 才要求它。
    const LEDGER_ANCHORED_ACTIONS = new Set(["mint-jc", "subscribe", "trade", "list-fee"]);
    const requestKey = body.requestKey;
    if (LEDGER_ANCHORED_ACTIONS.has(action) && (!requestKey || requestKey.length < 8)) {
      return json(response, 400, { error: "缺少有效的 requestKey" });
    }

    // ---- Gas 贊助：使用者簽 USDT 交易（金庫入金／提領）前，後端 ADMIN 幫「呼叫
    // 者本人」的錢包補一點 ETH 付 Gas，使全新錢包（ETH=0）也能自己簽名轉出自我保
    // 管的 USDT。收款地址一律伺服器端從 profiles.wallet_address 推導，不信任前端。----
    if (action === "sponsor-gas") {
      let wallet: Address;
      try {
        wallet = toAddress(callerProfile.wallet_address, "使用者帳號");
      } catch {
        return json(response, 400, { error: "找不到你的錢包地址，請重新登入" });
      }
      try {
        const result = await sponsorUserGas(wallet);
        return json(response, 200, result);
      } catch (e) {
        return json(response, 502, { error: errMsg(e) });
      }
    }

    // ---- 把「使用者從 Safe 金庫直接鏈上轉入、繞過站內帳本」的 RWA 份額反映回
    // holdings 帳本。二級市場的可交易額度以 holdings 為準，但 Safe→錢包的鏈上
    // 轉帳不會經過站內任何 RPC，因此 holdings 不會更新。這裡由後端讀「呼叫者本
    // 人」錢包的鏈上真實餘額（絕不信任前端數字），若鏈上餘額 > 帳本持有，就把
    // 差額補進 holdings（只加不減：帳本高於鏈上時多半是認購已入帳、鏈上發放仍
    // 在補跑，不能因此把已入帳份額抹掉）。僅適用已部署專屬代幣的 RWA 標的；
    // AE 代幣的 holdings 跨多輪 round 拆分，語意不明確，一律略過。----
    if (action === "sync-holding") {
      const placementId = (body as { placementId?: string }).placementId;
      if (!placementId) return json(response, 400, { error: "缺少 placementId" });
      const { data: placement } = await admin
        .from("private_placements")
        .select("id,token_address,is_ae_token,is_delisted")
        .eq("id", placementId)
        .maybeSingle();
      if (!placement) return json(response, 404, { error: "找不到對應的標的" });
      if (placement.is_ae_token) return json(response, 200, { synced: false, skipped: "ae" });
      const tokenAddress = toFactoryTokenAddress(placement.token_address);
      if (!tokenAddress) return json(response, 200, { synced: false, skipped: "no-token" });
      let wallet: Address;
      try {
        wallet = toAddress(callerProfile.wallet_address, "使用者帳號");
      } catch {
        return json(response, 200, { synced: false, skipped: "no-wallet" });
      }
      let onChain = 0;
      try {
        const bal = await getWalletShareBalance(tokenAddress, wallet);
        // RWA 份額不可有小數點：向下取整，避免因代幣 decimals 造成的微小尾差。
        onChain = Math.floor(bal.balance);
      } catch (e) {
        return json(response, 200, { synced: false, skipped: "read-failed", detail: errMsg(e) });
      }
      const { data: holdingRow } = await admin
        .from("holdings")
        .select("quantity")
        .eq("user_id", caller.id)
        .eq("asset_id", placementId)
        .maybeSingle();
      const ledgerQty = Number(holdingRow?.quantity ?? 0);
      if (onChain > ledgerQty + 1e-9) {
        const { error: upsertErr } = await admin
          .from("holdings")
          .upsert(
            { user_id: caller.id, asset_id: placementId, quantity: onChain, updated_at: new Date().toISOString() },
            { onConflict: "user_id,asset_id" },
          );
        if (upsertErr) return json(response, 500, { error: "同步持有份額失敗，請稍後再試" });
        return json(response, 200, { synced: true, from: ledgerQty, to: onChain, onChain });
      }
      return json(response, 200, { synced: false, ledgerQty, onChain });
    }

    // ---- 發放 JC（金庫買 JC 後，owner 從 Safe 金庫 transferFrom 到使用者錢包，
    // 金庫餘額真實減少；action 名稱沿用 mint-jc 是為了不動前端呼叫端）----
    if (action === "mint-jc") {
      const { data: ledgerRow } = await admin
        .from("jc_ledger")
        .select("id,user_id,amount,entry_type")
        .eq("idempotency_key", `${requestKey}:jc`)
        .eq("entry_type", "vault_buy")
        .maybeSingle();
      if (!ledgerRow || ledgerRow.user_id !== caller.id) {
        return json(response, 404, { error: "找不到對應的購買 JC 紀錄" });
      }
      return settleMintJcCore(admin, response, ledgerRow);
    }

    // ---- 一級認購結算（buyer 先 approve JC → owner executeSubscription）----
    if (action === "subscribe") {
      const { data: ledgerRow } = await admin
        .from("jc_ledger")
        .select("id,user_id,asset_id,quantity,amount,metadata")
        .eq("idempotency_key", requestKey)
        .eq("entry_type", "private_purchase")
        .maybeSingle();
      if (!ledgerRow || ledgerRow.user_id !== caller.id) {
        return json(response, 404, { error: "找不到對應的認購紀錄" });
      }
      return settleSubscribeCore(admin, response, ledgerRow);
    }

    // ---- 二級市場成交結算（seller approve RWA + buyer approve JC → owner executeTrade）----
    if (action === "trade") {
      // 以 fill_p2p_order 寫下的買方帳本列為錨點：內含 order_id、對手方(賣方) id、
      // 數量與 gross，全部在伺服器端讀取，不信任前端傳入的金額或對手方。
      const { data: buyRow } = await admin
        .from("jc_ledger")
        .select("id,user_id,asset_id,quantity,metadata")
        .eq("idempotency_key", `${requestKey}:buyer`)
        .eq("entry_type", "p2p_buy")
        .maybeSingle();
      if (!buyRow) return json(response, 404, { error: "找不到對應的成交紀錄" });
      const meta = (buyRow.metadata as { counterparty_id?: string } | null) ?? {};
      const buyerId = buyRow.user_id as string;
      const sellerId = meta.counterparty_id;
      if (caller.id !== buyerId && caller.id !== sellerId) {
        return json(response, 403, { error: "只有���交雙方可觸發結算" });
      }
      return settleTradeCore(admin, response, buyRow);
    }

    // ---- 掛賣單一次性手續費：把 1 JC 從賣方錢包實際收進 Safe 金庫（賣方→ADMIN→
    // Safe 兩跳，因 JC 合約禁止使用者直接轉給金庫）。以 create_p2p_order 寫下的
    // p2p_listing_fee 帳本列為錨點，金額與賣方一律伺服器端讀取，不信任前端。----
    if (action === "list-fee") {
      const { data: feeRow } = await admin
        .from("jc_ledger")
        .select("id,user_id,amount,entry_type")
        .eq("idempotency_key", `${requestKey}:listfee`)
        .eq("entry_type", "p2p_listing_fee")
        .maybeSingle();
      if (!feeRow || feeRow.user_id !== caller.id) {
        return json(response, 404, { error: "找不到對應���掛單手續費紀錄" });
      }
      return settleListFeeCore(admin, response, feeRow);
    }

    // ---- 管理員：列出需要人工關注的鏈上結算（失敗 / 卡在 pending 太久 / 站內
    // 已扣款但從未送出任何結算請求的「孤兒」紀���）。三種來源都可能發生：使用
    // 者付款後瀏覽器關掉、fetch 被中斷、relayer 當下 gas 不足或標的被下架擋下。
    // 這份清單同時也是 cron sweep（見 findAttentionCandidates）自動補發的資料源，
    // 這裡只是額外把使用者/標的名稱查出來供後台顯示用。----
    // ---- 管理員：一鍵把待派發分潤實際上鏈發��（ADMIN 熱錢包→受益人）���可傳
    // beneficiaryIds 只派發指定人員，未傳則全平台派發。----
    if (action === "settle-commissions") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const ids = (body as { beneficiaryIds?: string[] }).beneficiaryIds;
      const filter = Array.isArray(ids) && ids.length > 0 ? ids : undefined;
      const summary = await sweepPendingCommissions(admin, 300, filter);
      return json(response, 200, summary);
    }

    // ---- 管���員：一鍵沖正指定受益人的獎金派發錯誤（多發／少發校正）----
    if (action === "commission-reverse") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const ids = (body as { beneficiaryIds?: string[] }).beneficiaryIds;
      if (!Array.isArray(ids) || ids.length === 0) {
        return json(response, 400, { error: "缺少要沖正的受益人" });
      }
      const results: ReversalResult[] = [];
      for (const id of ids) {
        try {
          results.push(await reverseCommissionForBeneficiary(admin, id));
        } catch (e) {
          results.push({ beneficiaryId: id, applied: false, direction: "none", amount: 0, error: errMsg(e) });
        }
      }
      return json(response, 200, { results });
    }

    if (action === "admin-list-settlements") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const items = await findAttentionCandidates(admin);
      const userIds = [...new Set(items.map((i) => i.userId).filter(Boolean))] as string[];
      const assetIds = [...new Set(items.map((i) => i.assetId).filter(Boolean))] as string[];
      const [profilesResult, placementsResult] = await Promise.all([
        userIds.length
          ? admin.from("profiles").select("id,email,nickname,display_name").in("id", userIds)
          : Promise.resolve({ data: [] as { id: string; email: string | null; nickname: string | null; display_name: string | null }[] }),
        assetIds.length
          ? admin.from("private_placements").select("id,name").in("id", assetIds)
          : Promise.resolve({ data: [] as { id: string; name: string | null }[] }),
      ]);
      const profileById = new Map((profilesResult.data ?? []).map((p) => [p.id, p]));
      const assetNameById = new Map((placementsResult.data ?? []).map((a) => [a.id, a.name]));

      const enriched = items
        .map((item) => {
          const profile = profileById.get(item.userId);
          return {
            ...item,
            userLabel: profile?.nickname || profile?.display_name || profile?.email || item.userId,
            assetName: item.assetId ? assetNameById.get(item.assetId) ?? item.assetId : null,
          };
        })
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      return json(response, 200, { items: enriched });
    }

    // ---- 管理員：一鍵補發／重試單筆卡單的鏈上結算 ----
    if (action === "admin-retry-settlement") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const payload = body as { settlementId?: string; ledgerAction?: string; ledgerRowId?: string };
      let settleAction: AttentionAction;
      let ledgerRowId: string;

      if (payload.settlementId) {
        const { data: settlement } = await admin
          .from("onchain_settlements")
          .select("id,action,ref_key,status,tx_hash,updated_at,created_at")
          .eq("id", payload.settlementId)
          .maybeSingle();
        if (!settlement) return json(response, 404, { error: "找不到結算紀錄" });
        if (settlement.status === "confirmed") {
          return json(response, 200, { status: "confirmed", tx_hash: settlement.tx_hash, idempotent: true });
        }
        if (settlement.status === "pending") {
          const ageMs = Date.now() - new Date(settlement.updated_at ?? settlement.created_at).getTime();
          if (ageMs < 2 * 60 * 1000) {
            return json(response, 409, { error: "此筆結算仍在處理中，請稍候再試" });
          }
          // 卡在 pending 太久（例如流程中途進程中斷），管理員可強制判定失敗後重試。
          await admin
            .from("onchain_settlements")
            .update({ status: "failed", error: "管理員判定逾時卡單，已轉為失敗以便重試", updated_at: new Date().toISOString() })
            .eq("id", settlement.id);
        }
        settleAction = settlement.action as AttentionAction;
        ledgerRowId = settlement.ref_key.slice(settleAction.length + 1);
      } else if (
        payload.ledgerRowId &&
        (payload.ledgerAction === "mint_jc" ||
          payload.ledgerAction === "subscribe" ||
          payload.ledgerAction === "trade" ||
          payload.ledgerAction === "list_fee")
      ) {
        settleAction = payload.ledgerAction;
        ledgerRowId = payload.ledgerRowId;
      } else {
        return json(response, 400, { error: "缺少 settlementId 或 ledgerAction+ledgerRowId" });
      }

      return retrySettlementByAction(admin, response, settleAction, ledgerRowId);
    }

    return json(response, 400, { error: `未知的 action: ${action}` });
  } catch (e) {
    return json(response, 500, { error: errMsg(e) });
  }
}

type AttentionAction = "mint_jc" | "subscribe" | "trade" | "list_fee";
type AttentionItem = {
  id: string | null;
  action: AttentionAction;
  ledgerRowId: string;
  userId: string;
  assetId: string | null;
  amount: number | null;
  payment?: number | null;
  status: "orphan" | "failed" | "stale_pending";
  error: string | null;
  txHash?: string | null;
  createdAt: string;
  updatedAt?: string;
};

/**
 * 找出所有「需要人工關注／需要自動補發」的鏈上結算：
 *  1. orphan：站內已扣款（jc_ledger 有對應紀錄），但從未產生任何 onchain_settlements
 *     紀錄——通常是使用者付款成功那一刻瀏覽器就關掉、或呼叫 /api/relayer 的
 *     fetch 被中斷，導致「已扣款卻沒觸發任何鏈上發幣/結算請求」。
 *  2. failed：曾經嘗試過但失敗（gas 不足、鏈上 revert 等）。
 *  3. stale_pending：卡在 pending 超過 2 分鐘（例如流程中途 serverless 逾時被中斷）。
 * 這份清單同時供後台「鏈上結算」頁籤顯示，以及 cron sweep 自動補發使用。
 */
async function findAttentionCandidates(admin: SupabaseClient): Promise<AttentionItem[]> {
  const STALE_MS = 2 * 60 * 1000;
  const staleBefore = new Date(Date.now() - STALE_MS).toISOString();

  const [vaultRows, subRows, tradeRows, listFeeRows, failedOrStale] = await Promise.all([
    admin
      .from("jc_ledger")
      .select("id,user_id,amount,created_at")
      .eq("entry_type", "vault_buy")
      .not("idempotency_key", "is", null)
      .order("created_at", { ascending: false })
      .limit(300),
    admin
      .from("jc_ledger")
      .select("id,user_id,asset_id,amount,created_at")
      .eq("entry_type", "private_purchase")
      .not("idempotency_key", "is", null)
      .order("created_at", { ascending: false })
      .limit(300),
    admin
      .from("jc_ledger")
      .select("id,user_id,asset_id,amount,created_at")
      .eq("entry_type", "p2p_buy")
      .not("idempotency_key", "is", null)
      .order("created_at", { ascending: false })
      .limit(300),
    // 掛賣單一次性手續費（1 JC）：站內已扣，但鏈上要走 賣方→ADMIN→Safe 兩跳才真的
    // 進金庫。若前端 best-effort 補發當下失敗／沒送出，這裡把它當 orphan 撈出來，
    // 交給 cron sweep／管理員一鍵補發，確保這 1 JC 最終真的上鏈進 Safe。
    admin
      .from("jc_ledger")
      .select("id,user_id,amount,created_at")
      .eq("entry_type", "p2p_listing_fee")
      .not("idempotency_key", "is", null)
      .order("created_at", { ascending: false })
      .limit(300),
    admin
      .from("onchain_settlements")
      .select("id,action,ref_key,user_id,counterparty_id,asset_id,amount,payment,status,error,tx_hash,created_at,updated_at")
      .in("action", ["mint_jc", "subscribe", "trade", "list_fee"])
      .or(`status.eq.failed,and(status.eq.pending,updated_at.lt.${staleBefore})`)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const ledgerByAction: Record<AttentionAction, { id: string; user_id: string; asset_id?: string | null; amount: number; created_at: string }[]> = {
    mint_jc: (vaultRows.data ?? []) as never,
    subscribe: (subRows.data ?? []) as never,
    trade: (tradeRows.data ?? []) as never,
    list_fee: (listFeeRows.data ?? []) as never,
  };
  const candidateRefKeys = (Object.entries(ledgerByAction) as [AttentionAction, typeof ledgerByAction[AttentionAction]][])
    .flatMap(([act, rows]) => rows.map((r) => `${act}:${r.id}`));
  const { data: existingSettlements } = candidateRefKeys.length
    ? await admin.from("onchain_settlements").select("ref_key").in("ref_key", candidateRefKeys)
    : { data: [] as { ref_key: string }[] };
  const hasSettlement = new Set((existingSettlements ?? []).map((r) => r.ref_key));

  const orphans: AttentionItem[] = (Object.entries(ledgerByAction) as [AttentionAction, typeof ledgerByAction[AttentionAction]][])
    .flatMap(([act, rows]) =>
      rows
        .filter((r) => !hasSettlement.has(`${act}:${r.id}`))
        .map((r) => ({
          id: null,
          action: act,
          ledgerRowId: r.id,
          userId: r.user_id,
          assetId: r.asset_id ?? null,
          amount: Number(r.amount),
          status: "orphan" as const,
          error: "使用者已扣款，但從未收到任何鏈上結算請求（可能是瀏覽器關閉或網路中斷）",
          createdAt: r.created_at,
        })),
    );

  const attentionNeeded: AttentionItem[] = (failedOrStale.data ?? []).map((row) => ({
    id: row.id,
    action: row.action as AttentionAction,
    ledgerRowId: row.ref_key.slice(String(row.action).length + 1),
    userId: row.user_id,
    assetId: row.asset_id ?? null,
    amount: row.amount == null ? null : Number(row.amount),
    payment: row.payment == null ? null : Number(row.payment),
    status: row.status === "failed" ? ("failed" as const) : ("stale_pending" as const),
    error: row.error ?? null,
    txHash: row.tx_hash ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  const combined = [...attentionNeeded, ...orphans];

  // 已下架的標的不再顯示補發：`admin_deactivate_placement` 下架時已原路退回
  // 對應的 JC（見 commission/清帳規則），若還讓管理員補發鏈上結算，會在標的
  // 已退款的情況下又把份額發給買方，造成重複發放。因此凡是 subscribe/trade
  // 且對應標的 is_delisted 或 is_active=false 的卡單，一律從清單濾除。
  const assetIdsToCheck = [
    ...new Set(combined.filter((i) => i.assetId && i.action !== "mint_jc").map((i) => i.assetId as string)),
  ];
  if (assetIdsToCheck.length) {
    const { data: placementFlags } = await admin
      .from("private_placements")
      .select("id,is_delisted,is_active")
      .in("id", assetIdsToCheck);
    const inactiveAssetIds = new Set(
      (placementFlags ?? []).filter((p) => p.is_delisted || p.is_active === false).map((p) => p.id),
    );
    if (inactiveAssetIds.size) {
      return combined.filter((i) => !(i.assetId && inactiveAssetIds.has(i.assetId)));
    }
  }

  return combined;
}

/** 建一個假的 ServerResponse：讓 settle*Core 系列函式可以在沒有真實 HTTP 請求
 * 的情境下重複使用（例如 cron sweep），呼叫端事後從 `read()` 取得寫入的內容。 */
function fakeResponse(): { response: ServerResponse; read: () => { status: number; body: unknown } } {
  let body: unknown = null;
  const stub = {
    statusCode: 0,
    setHeader() {
      /* no-op */
    },
    end(data?: string) {
      body = data ? JSON.parse(data) : null;
    },
  };
  return {
    response: stub as unknown as ServerResponse,
    read: () => ({ status: stub.statusCode, body }),
  };
}

/** 依 action + ledgerRowId 找回對應的帳本錨點，重新觸發鏈上結算（含防重複的
 * ref_key 冪等檢查）。管理員手動補發與 cron 自動 sweep 都走這裡，行為完全一致。 */
async function retrySettlementByAction(
  admin: SupabaseClient,
  response: ServerResponse,
  settleAction: AttentionAction,
  ledgerRowId: string,
) {
  if (settleAction === "mint_jc") {
    const { data: ledgerRow } = await admin
      .from("jc_ledger")
      .select("id,user_id,amount")
      .eq("id", ledgerRowId)
      .eq("entry_type", "vault_buy")
      .maybeSingle();
    if (!ledgerRow) return json(response, 404, { error: "找不到對應的購買 JC 紀錄" });
    return settleMintJcCore(admin, response, ledgerRow);
  }
  if (settleAction === "subscribe") {
    const { data: ledgerRow } = await admin
      .from("jc_ledger")
      .select("id,user_id,asset_id,quantity,amount,metadata")
      .eq("id", ledgerRowId)
      .eq("entry_type", "private_purchase")
      .maybeSingle();
    if (!ledgerRow) return json(response, 404, { error: "找不到對應的認購紀錄" });
    return settleSubscribeCore(admin, response, ledgerRow);
  }
  if (settleAction === "list_fee") {
    const { data: feeRow } = await admin
      .from("jc_ledger")
      .select("id,user_id,amount")
      .eq("id", ledgerRowId)
      .eq("entry_type", "p2p_listing_fee")
      .maybeSingle();
    if (!feeRow) return json(response, 404, { error: "找不到對應的掛單手續費紀錄" });
    return settleListFeeCore(admin, response, feeRow);
  }
  const { data: buyRow } = await admin
    .from("jc_ledger")
    .select("id,user_id,asset_id,quantity,metadata")
    .eq("id", ledgerRowId)
    .eq("entry_type", "p2p_buy")
    .maybeSingle();
  if (!buyRow) return json(response, 404, { error: "找不到對應的成交紀錄" });
  return settleTradeCore(admin, response, buyRow);
}

/**
 * 系統自動掃描並補發所有卡單（不需要任何人工點擊）：由 Vercel Cron 定期呼叫
 * （見 api/cron/settle-sweep.ts），對 findAttentionCandidates 找到的每一筆
 * orphan / failed / stale_pending 紀錄呼叫 retrySettlementByAction 重試一次。
 * 卡在 pending 未逾 2 分鐘的先跳過（可能真的還在處理中），避免與正在進行的
 * 交易搶跑；失敗只記錄，不中斷其他項目的補發。
 */
export async function sweepStuckSettlements(
  admin: SupabaseClient,
  limit?: number,
): Promise<{ attempted: number; fixed: number; stillFailing: { ledgerRowId: string; action: AttentionAction; error: string }[] }> {
  const allItems = await findAttentionCandidates(admin);
  // limit 用於「機會式」掃描：每次只處理一小批，避免拖慢觸發它��使用者請求或
  // 撞到 serverless 逾時；每日 cron 呼叫時不帶 limit，一次掃完全部。
  const items = typeof limit === "number" ? allItems.slice(0, limit) : allItems;
  const stillFailing: { ledgerRowId: string; action: AttentionAction; error: string }[] = [];
  let attempted = 0;
  let fixed = 0;
  for (const item of items) {
    if (item.status === "stale_pending") {
      const ageMs = Date.now() - new Date(item.updatedAt ?? item.createdAt).getTime();
      if (ageMs < 2 * 60 * 1000) continue;
      await admin
        .from("onchain_settlements")
        .update({ status: "failed", error: "cron sweep 判定逾時卡單，已轉為失敗以便重試", updated_at: new Date().toISOString() })
        .eq("id", item.id as string);
    }
    attempted += 1;
    const { response, read } = fakeResponse();
    try {
      await retrySettlementByAction(admin, response, item.action, item.ledgerRowId);
      const { status, body } = read();
      if (status >= 200 && status < 300) {
        fixed += 1;
      } else {
        const errorValue = body && typeof body === "object" && "error" in body
          ? (body as { error?: unknown }).error
          : undefined;
        const message = typeof errorValue === "string" && errorValue ? errorValue : `HTTP ${status}`;
        stillFailing.push({ ledgerRowId: item.ledgerRowId, action: item.action, error: message });
      }
    } catch (e) {
      stillFailing.push({ ledgerRowId: item.ledgerRowId, action: item.action, error: errMsg(e) });
    }
  }
  return { attempted, fixed, stillFailing };
}

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "shortMessage" in e && typeof (e as { shortMessage: unknown }).shortMessage === "string") {
    return (e as { shortMessage: string }).shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

// 機會式自動補發：Hobby 方案的 Vercel cron 最快只能每日一次，光靠 cron 無法讓
// 卡單與待派發分潤及時清掉。因此每當有 relayer 請求（認購 / 二級 / 掛單 /
// 金庫買幣 等平台活動）進來，就順手掃一小批——而這些活動正好也是產生新分潤 /
// 手續費卡單的時機，所以平台只要有人在用，就會在幾分鐘內自我修復，不需要人工
// 一直按「一鍵補發」。用 claim_sweep_slot 節流成全域最多每 ~90 秒一次，且整段
// best-effort：任何錯誤都吞掉，絕不影響觸發它的使用者本身的交易結果。
async function maybeOpportunisticSweep(admin: SupabaseClient): Promise<void> {
  try {
    const { data: claimed, error } = await admin.rpc("claim_sweep_slot", {
      p_key: "settle-sweep",
      p_min_interval_seconds: 90,
    });
    if (error || claimed !== true) return; // 沒搶到節流窗（或表尚未建立）→ 直接跳過
    // 每次只處理一小批，避免拖慢當前使用者請求或撞 serverless 逾時；剩下的由後續
    // 請求或每日 cron 接續處理。
    await sweepStuckSettlements(admin, 4).catch(() => {});
    await sweepPendingCommissions(admin, 8).catch(() => {});
  } catch {
    // 靜默：���會式掃描永遠不該影響主流程。
  }
}
