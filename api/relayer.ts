// 後端 relayer：以單一 ADMIN_PRIVATE_KEY 熱錢包代發所有需要合約 owner 身分、
// 或直接動用熱錢包自身餘額才能送出的鏈上結算交易。
//
// 為什麼需要它：JC/AE 發放（ADMIN 熱錢包直接 transfer 自己的餘額，庫存由人工
// 從 Safe 金庫轉帳補貨）、一級認購 executeSubscription 需要 ADMIN 權限，交由後端
// relayer 代發。二級市場的掛單/取消仍由使用者簽署並先鎖入 P2PEscrow；
// 後端只會撮合雙方已鎖定的訂單，不會從使用者錢包另外扣取資產。
//
// 安全模型：
//  1. 只接受帶有有效 Supabase session token 的請求（getUser 驗證）。
//  2. 金額與對手方一律從既有 RPC 寫下的 jc_ledger 紀錄推導，絕不信任前端傳來的數字。
//  3. onchain_settlements 以 ref_key 做冪等，避免重複發幣 / 重複結算。
//  4. wire-contracts 僅限管理員（profiles.agency_role）。
import type { IncomingMessage, ServerResponse } from "node:http";
import { withEscrowMatchLock, withSettlementRecoveryLock } from "./_relayerLock.js";
import {
  indexReservationsByRequestKey,
  isReservationBackedLedgerRow,
  isReservationBackedLegacySettlement,
  requestKeyForLedgerRow,
} from "./_settlementRecovery.js";
import { nextEscrowMatch, type MatchableEscrowOrder } from "./_escrowMatching.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { formatUnits, getAddress, keccak256, parseEventLogs, parseUnits, toBytes, type Address } from "viem";
import { sendTelegramMessage, sendUserTelegramNotification, notifyTelegramPreferenceGroup, recordSystemError } from "./_telegram.js";
import {
  alertSettlementFailure,
  alertSettlementRecovery,
  describeSettlementForUser,
  hadPriorSettlementFailure,
  notifyUserSettlementCompleted,
  wasOpsAlerted,
  type SettlementFailureInput,
} from "./_tradeAlerts.js";
import { maybeMonitorHotWalletInventory } from "./_hot-wallet-monitor.js";
import {
  createRwaFactoryToken,
  getCurrentRwaFactoryToken,
  findRecentAssetTransfer,
  getAdminTransactionStatus,
  waitForAdminTransaction,
  type OnAdminTransactionSubmitted,
  ensureRelayerGas,
  executeAeSubscription,
  executeSubscription,
  getHotWalletShareBalance,
  getWalletShareBalance,
  sponsorUserGas,
  getVaultStatus,
  getAdminWalletStatus,
  mintAe,
  mintJc,
  mintTokenSupply,
  burnVaultInventory,
  pullJcFromUser,
  adminSendJc,
  inspectAdminJcPayoutsTo,
  adminSendUsdt,
  collectJcToVault,
  RELAYER_ADDRESSES,
  loadActiveSafeVault,
  sendAdminAssetPayout,
  sendAdminAssetReclaim,
  getLegacyAssetChainState,
  getAdminAssetReclaimReceiptStatus,
  waitForAdminAssetPayout,
  waitForAdminAssetReclaim,
  sendJcToVault,
  relayerAddress,
  wireRwaContracts,
  adminReclaimAe,
  getAeChainBalance,
  getJcChainBalance,
  reclaimRwaShare,
  P2P_ESCROW_ABI,
  P2P_ESCROW_ADDRESS,
  P2P_ESCROW_KNOWN_ADDRESSES,
  isKnownP2PEscrow,
  getP2PEscrowFees,
  setP2PEscrowFees,
  p2pEscrowAddress,
  getP2PEscrowReceipt,
  getP2PEscrowLocked,
  matchP2PEscrowOrders,
  verifyVaultUsdtDeposit,
  sendAdminRawCall,
} from "./_onchain";
import { IS_MAINNET, withStablecoinSymbol } from "./_network";
import {
  cancelSafeProposal,
  createSafeProposal,
  executeSafeProposal,
  handOwnershipToSafe,
  buildSafeMigrationPlan,
  buildAcceptOwnershipCalls,
  listSafeProposals,
  refreshSafeProposal,
  resyncSafeProposal,
  safeCalls,
  safeGovernanceStatus,
  signSafeProposal,
  type SafeCall,
} from "./_safe.js";

async function json(response: ServerResponse, status: number, rawPayload: unknown) {
  const payload = withStablecoinSymbol(rawPayload);
  const body = payload && typeof payload === "object" ? payload as { error?: unknown; status?: unknown; failed?: unknown; ok?: unknown; lockedBalances?: unknown; results?: unknown } : {};
  const failedItems = Array.isArray(body.failed) ? body.failed : [];
  const lockedBalanceErrors = Array.isArray(body.lockedBalances)
    ? body.lockedBalances.filter((item) => item && typeof item === "object" && "error" in item && Boolean((item as { error?: unknown }).error))
    : [];
  const resultErrors = body.results && typeof body.results === "object"
    ? Object.entries(body.results).filter(([key, value]) => /error$/i.test(key) && Boolean(value))
    : [];
  const shouldAlert = status >= 500 || (status === 422 && body.status === "failed") || body.status === "failed" || body.ok === false || failedItems.length > 0 || lockedBalanceErrors.length > 0 || resultErrors.length > 0;
  const alreadyDetailed = typeof body.error === "string" && wasOpsAlerted(body.error);
  if (shouldAlert && !alreadyDetailed) {
    const details = body.error ?? (failedItems.length ? JSON.stringify(failedItems).slice(0, 800) : lockedBalanceErrors.length ? JSON.stringify(lockedBalanceErrors).slice(0, 800) : resultErrors.length ? JSON.stringify(resultErrors).slice(0, 800) : `HTTP ${status}`);
    await recordSystemError("api/relayer", String(details), { status })
      .catch((error) => console.error("[telegram] Relayer error alert failed", error instanceof Error ? error.message : "unknown error"));
  }
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
    oldPrice?: number;
    newPrice?: number;
    assetName?: string;
    assetKey?: string;
    expectedAmount?: string;
    txHash?: string;
    eventId?: string;
  };
}

// 管理權限與代理身分分離：舊帳號沿用 agency_role，雙重身分帳號用 role。
const ADMIN_ROLES = new Set(["管理員", "admin", "super_admin"]);
const isAdminProfile = (profile: { agency_role?: string | null; role?: string | null }) =>
  ADMIN_ROLES.has(String(profile.agency_role ?? "")) ||
  ["admin", "super_admin"].includes(String(profile.role ?? ""));

let maintenanceCache: { at: number; enabled: boolean; reason: string | null } | null = null;

// 緊急停用開關：環境變數或後台資料庫任一開啟即生效；資料庫狀態快取 5 秒，讀取失敗時以環境變數為準。
async function readMaintenanceState(admin: ReturnType<typeof createClient>) {
  if (process.env.PLATFORM_MAINTENANCE_MODE === "true") {
    return { enabled: true, reason: "環境變數強制維護模式" };
  }
  if (maintenanceCache && Date.now() - maintenanceCache.at < 5_000) return maintenanceCache;
  try {
    const { data } = await admin.rpc("get_maintenance_state");
    const state = (data ?? {}) as { enabled?: boolean; reason?: string | null };
    maintenanceCache = { at: Date.now(), enabled: state.enabled === true, reason: state.reason ?? null };
  } catch {
    maintenanceCache = { at: Date.now(), enabled: false, reason: null };
  }
  return maintenanceCache;
}

async function auditAdminAction(
  admin: ReturnType<typeof createClient>,
  caller: { id: string; email?: string | null },
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown>,
) {
  try {
    await admin.from("admin_audit_logs").insert({
      admin_id: caller.id,
      admin_email: caller.email ?? "",
      action,
      target_type: targetType,
      target_id: targetId,
      details,
    });
  } catch (error) {
    console.error("[relayer] audit log failed", errMsg(error));
  }
}

function toAddress(value: unknown, label: string): Address {
  if (typeof value !== "string") throw new Error(`${label} 未綁定鏈上錢包`);
  try {
    return getAddress(value.trim());
  } catch {
    throw new Error(`${label} 錢包地址格式錯誤`);
  }
}

type EscrowEventName = "OrderCreated" | "OrderFilled" | "AutoOrderMatched" | "OrderCancelled";
type DecodedEscrowEvent = { address: Address; eventName: string; args: Record<string, unknown> };

type EscrowCaller = {
  id: string;
  wallet_address: string | null;
  agency_role?: string | null;
  role?: string | null;
};

function isCurrentEscrow(address: string): boolean {
  return address.toLowerCase() === p2pEscrowAddress().toLowerCase();
}

async function decodeEscrowEvent(
  txHashInput: string,
  eventName: EscrowEventName | EscrowEventName[],
  options: { allowLegacyCreate?: boolean } = {},
) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHashInput)) throw new Error("交易雜湊格式錯誤");
  const txHash = txHashInput.toLowerCase() as `0x${string}`;
  const receipt = await getP2PEscrowReceipt(txHash);
  if (receipt.status !== "success") throw new Error("鏈上交易尚未成功確認");
  const names = Array.isArray(eventName) ? eventName : [eventName];
  // 新掛單只能建立在目前合約；成交、撮合與取消則允許舊合約，讓既有掛單照常運作到清空。
  // 管理員補同步「換約前就已上鏈」的舊掛單時也允許舊合約，否則幣卡在舊託管、帳本卻沒有這張單。
  const creatingOrder = names.includes("OrderCreated") && !options.allowLegacyCreate;
  const logs = receipt.logs.filter((log) =>
    creatingOrder ? log.address.toLowerCase() === p2pEscrowAddress().toLowerCase() : isKnownP2PEscrow(log.address),
  );
  const decoded = parseEventLogs({ abi: P2P_ESCROW_ABI, logs, strict: true }) as unknown as DecodedEscrowEvent[];
  const event = decoded.find((entry) => names.includes(entry.eventName as EscrowEventName));
  if (!event) throw new Error(`交易收據中找不到 ${eventName} 託管事件`);
  return { txHash, escrow: getAddress(event.address), args: event.args };
}

async function saveEscrowEvent(
  admin: SupabaseClient,
  txHash: string,
  eventType: "order_created" | "order_filled" | "order_cancelled",
  userId: string | null,
  eventData: Record<string, unknown>,
): Promise<boolean> {
  const existing = await admin.from("p2p_escrow_events")
    .select("event_type,user_id,event_data,status")
    .eq("tx_hash", txHash)
    .maybeSingle();
  if (existing.error) throw new Error(`託管事件讀取失敗：${existing.error.message}`);
  if (existing.data) {
    if (existing.data.event_type !== eventType) throw new Error("交易雜湊已用於不同類型的託管事件");
    if (existing.data.status === "finalized") return true;
    const update = await admin.from("p2p_escrow_events").update({
      user_id: userId,
      event_data: eventData,
      status: "pending",
      error: null,
      updated_at: new Date().toISOString(),
    }).eq("tx_hash", txHash);
    if (update.error) throw new Error(`託管事件保存失敗：${update.error.message}`);
    return false;
  }
  const insert = await admin.from("p2p_escrow_events").insert({
    tx_hash: txHash,
    event_type: eventType,
    user_id: userId,
    event_data: eventData,
    status: "pending",
  });
  if (insert.error) {
    const raced = await admin.from("p2p_escrow_events").select("event_type,status").eq("tx_hash", txHash).maybeSingle();
    if (raced.data?.event_type === eventType) return raced.data.status === "finalized";
    throw new Error(`託管事件保存失敗：${insert.error.message}`);
  }
  return false;
}

async function finishEscrowEvent(admin: SupabaseClient, txHash: string, error?: string) {
  const update = await admin.from("p2p_escrow_events").update({
    status: error ? "failed" : "finalized",
    error: error ?? null,
    updated_at: new Date().toISOString(),
  }).eq("tx_hash", txHash);
  if (update.error) throw new Error(`託管事件狀態更新失敗：${update.error.message}`);
}

async function profileForWallet(admin: SupabaseClient, wallet: Address) {
  const { data, error } = await admin.from("profiles")
    .select("id,wallet_address")
    .ilike("wallet_address", wallet)
    .maybeSingle();
  if (error || !data) throw new Error("鏈上錢包尚未綁定唯一平台帳號");
  return data as { id: string; wallet_address: string };
}

async function loadOpenEscrowOrders(admin: SupabaseClient, assetId: string, escrow: Address): Promise<MatchableEscrowOrder[]> {
  const rows: MatchableEscrowOrder[] = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await admin.from("p2p_orders")
      .select("id,user_id,side,price,remaining_quantity,escrow_locked_currency,escrow_chain_order_id,escrow_contract_address,escrow_token_address,escrow_currency_address")
      .eq("asset_id", assetId)
      .eq("escrow_mode", "escrow")
      .eq("escrow_contract_address", escrow.toLowerCase())
      .in("status", ["open", "partially_filled"])
      .order("created_at", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`自動撮合讀取掛單失敗：${error.message}`);
    rows.push(...((data ?? []) as MatchableEscrowOrder[]));
    if (!data || data.length < pageSize) return rows;
  }
}

async function retryPendingEscrowFillsForAsset(admin: SupabaseClient, assetToken: string) {
  const { data, error } = await admin.from("p2p_escrow_events")
    .select("tx_hash,event_data")
    .eq("event_type", "order_filled")
    .in("status", ["pending", "failed"])
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw new Error(`自動撮合重試清單讀取失敗：${error.message}`);
  const pending = (data ?? []).filter((event) =>
    String((event.event_data as Record<string, unknown> | null)?.assetToken ?? "").toLowerCase() === assetToken.toLowerCase(),
  );
  for (const event of pending) await processEscrowFill(admin, event.tx_hash, null);
}

async function runAutomaticEscrowMatching(
  admin: SupabaseClient,
  assetId: string,
  assetToken: string,
  currencyToken: string,
  triggerTxHash: string,
) {
  await retryPendingEscrowFillsForAsset(admin, assetToken);
  // 鏈上只能撮合同一份合約內的兩張單，因此新舊合約各自撮合，不會互相影響。
  const escrows = P2P_ESCROW_KNOWN_ADDRESSES;
  const maxMatches = 2;
  let matchedCount = 0;
  while (matchedCount < maxMatches) {
    let candidate: ReturnType<typeof nextEscrowMatch> = null;
    let candidateEscrow: Address | null = null;
    for (const escrow of escrows) {
      candidate = nextEscrowMatch(await loadOpenEscrowOrders(admin, assetId, escrow), assetToken, currencyToken);
      if (candidate) {
        candidateEscrow = escrow;
        break;
      }
    }
    if (!candidate || !candidateEscrow) return { matchedCount, remainingCrossedOrders: false };
    const buyChainId = BigInt(candidate.buy.escrow_chain_order_id);
    const sellChainId = BigInt(candidate.sell.escrow_chain_order_id);
    const legacy = candidateEscrow.toLowerCase() !== p2pEscrowAddress().toLowerCase();
    const fillKey = keccak256(toBytes(`${legacy ? `${candidateEscrow.toLowerCase()}:` : ""}${triggerTxHash}:${buyChainId}:${sellChainId}`));
    const fillTxHash = await matchP2PEscrowOrders({
      buyOrderId: buyChainId,
      sellOrderId: sellChainId,
      quantity: candidate.quantity,
      fillKey,
      escrow: candidateEscrow,
    });
    await processEscrowFill(admin, fillTxHash, null);
    matchedCount += 1;
  }
  for (const escrow of escrows) {
    if (nextEscrowMatch(await loadOpenEscrowOrders(admin, assetId, escrow), assetToken, currencyToken)) {
      return { matchedCount, remainingCrossedOrders: true };
    }
  }
  return { matchedCount, remainingCrossedOrders: false };
}

async function processEscrowOrderCreated(
  admin: SupabaseClient,
  txHashInput: string,
  caller: EscrowCaller | null,
  options: { allowLegacyCreate?: boolean } = {},
): Promise<Record<string, unknown>> {
  const { txHash, escrow, args } = await decodeEscrowEvent(txHashInput, "OrderCreated", options);
  const maker = toAddress(args.maker, "掛單者");
  const profile = await profileForWallet(admin, maker);
  if (caller && caller.id !== profile.id) throw new Error("只能同步自己錢包建立的託管掛單");
  const eventData = {
    txHash,
    escrowContract: escrow.toLowerCase(),
    orderId: String(args.orderId),
    clientOrderId: String(args.clientOrderId).toLowerCase(),
    maker,
    isSell: Boolean(args.isSell),
    assetToken: toAddress(args.assetToken, "標的代幣").toLowerCase(),
    currencyToken: toAddress(args.currencyToken, "計價代幣").toLowerCase(),
    price: String(args.price),
    quantity: String(args.quantity),
    listingFee: String(args.listingFee),
    feeBps: args.feeBps == null ? "100" : String(args.feeBps),
  };
  const priorEvent = await admin.from("p2p_escrow_events")
    .select("status,error")
    .eq("tx_hash", txHash)
    .maybeSingle();
  if (priorEvent.error) throw new Error(`託管事件讀取失敗：${priorEvent.error.message}`);
  const wasFailed = priorEvent.data?.status === "failed";
  const previousFailure = priorEvent.data?.error ?? "託管掛單同步曾失敗";
  const alreadyFinalized = await saveEscrowEvent(admin, txHash, "order_created", profile.id, eventData);

  try {
    const reservation = await admin.from("p2p_escrow_order_reservations")
      .select("request_key,user_id,asset_id,side,status")
      .eq("client_order_id", eventData.clientOrderId)
      .maybeSingle();
    const reservationData = reservation.data;
    if (reservation.error || !reservationData || reservationData.user_id !== profile.id) {
      throw new Error("找不到此鏈上掛單對應的資料庫預留；請由管理員檢查這筆交易");
    }
    const placement = await admin.from("private_placements")
      .select("id,is_ae_token,token_address")
      .eq("id", reservationData.asset_id)
      .maybeSingle();
    if (placement.error || !placement.data) throw new Error("找不到此掛單對應的標的");
    const expectedAsset = placement.data.is_ae_token
      ? RELAYER_ADDRESSES.aeToken
      : toFactoryTokenAddress(placement.data.token_address);
    if (!expectedAsset || expectedAsset.toLowerCase() !== eventData.assetToken) throw new Error("掛單標的代幣與平台標的設定不一致");
    if (eventData.currencyToken !== RELAYER_ADDRESSES.jcToken.toLowerCase()) throw new Error("此平台掛單只接受 JC 計價");
    const { data, error } = await admin.rpc("confirm_p2p_escrow_order", { p_user_id: profile.id, p_event: eventData });
    if (error) throw new Error(error.message);
    const matching = await withEscrowMatchLock(() => runAutomaticEscrowMatching(
      admin,
      reservationData.asset_id,
      eventData.assetToken,
      eventData.currencyToken,
      txHash,
    ));
    if (matching.remainingCrossedOrders) {
      throw new Error(`本次已自動撮合 ${matching.matchedCount} 筆；尚有合格掛單待處理，請重新整理或重試同步`);
    }
    await finishEscrowEvent(admin, txHash);
    if (wasFailed) {
      await alertSettlementRecovery(admin, {
        refKey: `escrow_order:${txHash}`,
        txHash,
        previousFailure,
        userId: profile.id,
      });
      await notifyUserSettlementCompleted(admin, {
        refKey: `escrow_order:${txHash}`,
        userId: profile.id,
        description: eventData.isSell ? "二級市場掛賣單" : "二級市場掛買單",
        txHash,
      });
    }
    return { status: "confirmed", idempotent: alreadyFinalized, tx_hash: txHash, order: data, matching };
  } catch (error) {
    const message = error instanceof Error ? error.message : "託管掛單資料同步失敗";
    await finishEscrowEvent(admin, txHash, message);
    const listedQuantity = Number(eventData.quantity) / 1e18;
    await alertSettlementFailure(admin, {
      kind: eventData.isSell ? "二級市場掛賣單" : "二級市場掛買單",
      refKey: `escrow_order:${txHash}`,
      stage: "鏈上託管掛單同步到訂單簿／自動撮合",
      error: message,
      userId: profile.id,
      userRole: "掛單者",
      assetToken: eventData.assetToken,
      assetName: eventData.assetToken === RELAYER_ADDRESSES.aeToken.toLowerCase() ? "AE" : null,
      deliverable: eventData.isSell ? "託管標的份額" : "託管 JC",
      quantity: listedQuantity,
      jcAmount: listedQuantity * (Number(eventData.price) / 1e18),
      txHash,
      remedy: "鏈上掛單已成立；可在後台重試同步此交易雜湊",
    });
    throw new Error(`${message}；交易已上鏈，可由管理員重試同步（${txHash}）`);
  }
}

async function processEscrowFill(
  admin: SupabaseClient,
  txHashInput: string,
  caller: EscrowCaller | null,
): Promise<Record<string, unknown>> {
  const { txHash, escrow, args } = await decodeEscrowEvent(txHashInput, ["OrderFilled", "AutoOrderMatched"]);
  const buyer = toAddress(args.buyer, "買方");
  const seller = toAddress(args.seller, "賣方");
  const [buyerProfile, sellerProfile] = await Promise.all([
    profileForWallet(admin, buyer),
    profileForWallet(admin, seller),
  ]);
  if (buyerProfile.id === sellerProfile.id) throw new Error("無效的自我成交事件");
  if (caller && caller.id !== buyerProfile.id && caller.id !== sellerProfile.id) throw new Error("只能同步自己參與的成交");
  const eventData = {
    txHash,
    escrowContract: escrow.toLowerCase(),
    fillKey: String(args.fillKey).toLowerCase(),
    orderId: String(args.orderId),
    counterOrderId: String(args.counterOrderId ?? 0n),
    buyer,
    seller,
    assetToken: toAddress(args.assetToken, "標的代幣").toLowerCase(),
    currencyToken: toAddress(args.currencyToken, "計價代幣").toLowerCase(),
    quantity: String(args.quantity),
    price: String(args.price),
    gross: String(args.gross),
    fee: String(args.fee),
    currencyReleased: String(args.currencyReleased),
  };
  const priorEvent = await admin.from("p2p_escrow_events")
    .select("status,error")
    .eq("tx_hash", txHash)
    .maybeSingle();
  if (priorEvent.error) throw new Error(`託管事件讀取失敗：${priorEvent.error.message}`);
  const wasFailed = priorEvent.data?.status === "failed";
  const previousFailure = priorEvent.data?.error ?? "託管成交同步曾失敗";
  const alreadyFinalized = await saveEscrowEvent(admin, txHash, "order_filled", buyerProfile.id, eventData);
  if (alreadyFinalized) return { status: "confirmed", idempotent: true, tx_hash: txHash };
  try {
    const isAutoMatch = eventData.counterOrderId !== "0";
    const { data, error } = await admin.rpc(
      isAutoMatch ? "finalize_p2p_escrow_auto_match" : "finalize_p2p_escrow_fill",
      { p_event: eventData },
    );
    if (error) throw new Error(error.message);

    const { data: order, error: orderError } = await admin.from("p2p_orders")
      .select("id,user_id,asset_id,status,remaining_quantity,original_quantity")
      .eq("escrow_chain_order_id", eventData.orderId)
      .eq("escrow_contract_address", eventData.escrowContract)
      .maybeSingle();
    if (orderError || !order) throw new Error(orderError?.message ?? "成交掛單資料不存在");
    const counterOrderId = String(eventData.counterOrderId);
    let counterOrder: typeof order | null = null;
    if (counterOrderId !== "0") {
      const result = await admin.from("p2p_orders")
        .select("id,user_id,asset_id,status,remaining_quantity,original_quantity")
        .eq("escrow_chain_order_id", counterOrderId)
        .eq("escrow_contract_address", eventData.escrowContract)
        .maybeSingle();
      if (result.error || !result.data) throw new Error(result.error?.message ?? "自動撮合的對手掛單不存在");
      counterOrder = result.data;
    }
    const { data: placement, error: placementError } = await admin.from("private_placements")
      .select("name,is_ae_token,change,last_traded_price")
      .eq("id", order.asset_id)
      .maybeSingle();
    if (placementError) throw new Error(placementError.message);

    const quantity = Number(eventData.quantity) / 1e18;
    const price = Number(eventData.price) / 1e18;
    const gross = Number(eventData.gross) / 1e18;
    const quantityText = quantity.toLocaleString("zh-TW", { maximumFractionDigits: 6 });
    const grossText = gross.toLocaleString("zh-TW", { maximumFractionDigits: 6 });
    const priceText = price.toLocaleString("zh-TW", { maximumFractionDigits: 6 });
    const assetName = placement?.is_ae_token ? "AE" : placement?.name || "平台標的";
    const partialEvent = `p2p-fill:${eventData.fillKey}`;
    const notifications = await Promise.allSettled([
      sendUserTelegramNotification(admin, {
        userId: buyerProfile.id,
        category: "order_partial_fill",
        eventKey: partialEvent,
        title: "二級市場成交進度",
        body: `你買入 ${assetName} ${quantityText} 份，成交單價 ${priceText} JC，成交金額 ${grossText} JC。成交雜湊：${txHash}`,
      }),
      sendUserTelegramNotification(admin, {
        userId: sellerProfile.id,
        category: "order_partial_fill",
        eventKey: partialEvent,
        title: "二級市場成交進度",
        body: `你賣出 ${assetName} ${quantityText} 份，成交單價 ${priceText} JC，成交金額 ${grossText} JC。成交雜湊：${txHash}`,
      }),
      ...[order, ...(counterOrder ? [counterOrder] : [])]
        .filter((matchedOrder) => matchedOrder.status === "filled")
        .map((matchedOrder) => sendUserTelegramNotification(admin, {
          userId: matchedOrder.user_id,
          category: "order_completed",
          eventKey: `p2p-order-completed:${matchedOrder.id}`,
          title: "二級市場掛單已完成",
          body: `你的 ${assetName} ${matchedOrder.original_quantity} 份掛單已全部成交。本批成交 ${quantityText} 份，成交金額 ${grossText} JC。成交雜湊：${txHash}`,
        })),
      ...(Math.abs(Number(placement?.change ?? 0)) > 10 ? [notifyTelegramPreferenceGroup(
        admin,
        "market_alert",
        `market-alert:${txHash}`,
        `${assetName} 市場價格變動提醒`,
        `最新成交價 ${Number(placement?.last_traded_price ?? price).toLocaleString("zh-TW", { maximumFractionDigits: 6 })} JC，較前次成交變動 ${Number(placement?.change).toLocaleString("zh-TW", { maximumFractionDigits: 4 })}%。`,
      )] : []),
    ]);
    const notificationFailures = notifications.filter((result) => result.status === "rejected");
    if (notificationFailures.length) {
      console.error("[v0] Telegram fill notification failed", notificationFailures.length, txHash);
    }
    await finishEscrowEvent(admin, txHash);
    if (wasFailed) {
      await alertSettlementRecovery(admin, {
        refKey: `escrow_fill:${eventData.fillKey}`,
        txHash,
        previousFailure,
        userId: buyerProfile.id,
      });
      const fillDescription = `二級市場成交：${assetName} ${quantityText} 份`;
      for (const userId of new Set([buyerProfile.id, sellerProfile.id])) {
        await notifyUserSettlementCompleted(admin, {
          refKey: `escrow_fill:${eventData.fillKey}`,
          userId,
          description: fillDescription,
          txHash,
        });
      }
    }
    return { status: "confirmed", tx_hash: txHash, fill: data };
  } catch (error) {
    const message = error instanceof Error ? error.message : "成交帳本同步失敗";
    await finishEscrowEvent(admin, txHash, message);
    await alertSettlementFailure(admin, {
      kind: eventData.counterOrderId !== "0" ? "二級市場自動撮合成交" : "二級市場成交",
      refKey: `escrow_fill:${eventData.fillKey}`,
      stage: "成交交割同步到帳本與持倉",
      error: message,
      userId: buyerProfile.id,
      userRole: "買方",
      counterpartyId: sellerProfile.id,
      counterpartyRole: "賣方",
      assetToken: eventData.assetToken,
      assetName: eventData.assetToken === RELAYER_ADDRESSES.aeToken.toLowerCase() ? "AE" : null,
      deliverable: "標的份額 ↔ JC",
      quantity: Number(eventData.quantity) / 1e18,
      jcAmount: Number(eventData.gross) / 1e18,
      txHash,
      remedy: "鏈上已成交，站內帳本未同步；可在後台重試同步此交易雜湊",
    });
    throw new Error(`${message}；交易已上鏈，可由管理員重試同步（${txHash}）`);
  }
}

async function processEscrowCancel(
  admin: SupabaseClient,
  txHashInput: string,
  caller: EscrowCaller | null,
): Promise<Record<string, unknown>> {
  const { txHash, escrow, args } = await decodeEscrowEvent(txHashInput, "OrderCancelled");
  const maker = toAddress(args.maker, "掛單者");
  const profile = await profileForWallet(admin, maker);
  if (caller && caller.id !== profile.id) throw new Error("只能同步自己取消的託管掛單");
  const eventData = {
    txHash,
    escrowContract: escrow.toLowerCase(),
    orderId: String(args.orderId),
    maker,
    refundedAmount: String(args.refundedAmount),
  };
  const alreadyFinalized = await saveEscrowEvent(admin, txHash, "order_cancelled", profile.id, eventData);
  if (alreadyFinalized) return { status: "confirmed", idempotent: true, tx_hash: txHash };
  try {
    const { data, error } = await admin.rpc("finalize_p2p_escrow_cancel", { p_user_id: profile.id, p_event: eventData });
    if (error) throw new Error(error.message);
    await finishEscrowEvent(admin, txHash);
    return { status: "confirmed", tx_hash: txHash, order: data };
  } catch (error) {
    const message = error instanceof Error ? error.message : "取消帳本同步失敗";
    await finishEscrowEvent(admin, txHash, message);
    await alertSettlementFailure(admin, {
      kind: "二級市場取消掛單",
      refKey: `escrow_cancel:${txHash}`,
      stage: "取消退款同步到帳本",
      error: message,
      userId: profile.id,
      userRole: "掛單者",
      deliverable: "退回未成交託管資產",
      quantity: Number(eventData.refundedAmount) / 1e18,
      quantityUnit: "（退回數量）",
      txHash,
      remedy: "鏈上資產已退回，站內帳本未同步；可在後台重試同步此交易雜湊",
    });
    throw new Error(`${message}；鏈上資產已退回，可由管理員重試同步（${txHash}）`);
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
      // 今日 pending 派發可能已送出但尚未確認；先保留額度，避免回收掉今日派發資產。
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
    if (error) throw new Error(`讀取資產合約資料失敗：${error.message}`);
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
      label: isAe ? "AE" : placement?.name || assetId,
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

// 防呆防護：送出任何鏈上交易（發幣 / 認購結算 / 成交結算）真正送出之前，先確認
// ADMIN 熱錢包還有足夠 ETH 付礦工費。刻意放在建立 onchain_settlements pending
// 列之前檢查，失敗時不消耗那筆 ref_key，讓管理員儲值後可以直接重試。
async function guardRelayerGas(
  response: ServerResponse,
  admin?: SupabaseClient,
  failureContext?: Omit<SettlementFailureInput, "error">,
): Promise<boolean> {
  try {
    await ensureRelayerGas();
    return true;
  } catch (error) {
    const message = errMsg(error);
    if (admin && failureContext) {
      await alertSettlementFailure(admin, { ...failureContext, error: message });
    }
    await json(response, 503, {
      ...(failureContext ? { status: "pending" } : {}),
      error: message,
    });
    return false;
  }
}

// 已確認的結算不需要再檢查標的是否仍開放：標的事後被關閉（例如 AE 獎勵回合開啟時停用每日 AE）
// 不影響已完成的交割，否則重新同步舊單會誤發「交割失敗」告警。
async function findConfirmedSettlement(admin: SupabaseClient, refKey: string) {
  const { data } = await admin
    .from("onchain_settlements")
    .select("status,tx_hash")
    .eq("ref_key", refKey)
    .eq("status", "confirmed")
    .maybeSingle();
  return data ? { status: "confirmed", tx_hash: (data.tx_hash as string | null) ?? null } : null;
}

async function isSubscribeReservationConfirmed(admin: SupabaseClient, requestKey: string): Promise<boolean> {
  const { data, error } = await admin
    .from("settlement_reservations")
    .select("status")
    .eq("request_key", requestKey)
    .eq("action", "subscribe")
    .maybeSingle();
  if (error) return false;
  return data?.status === "confirmed";
}

async function guardPlacementStillSettleable(
  admin: SupabaseClient,
  response: ServerResponse,
  assetId: string,
  failureContext?: Omit<SettlementFailureInput, "error">,
): Promise<boolean> {
  const { data: placement } = await admin
    .from("private_placements")
    .select("id,is_active,is_delisted")
    .eq("id", assetId)
    .maybeSingle();
  const fail = async (status: number, message: string) => {
    if (failureContext) {
      await alertSettlementFailure(admin, { ...failureContext, assetId, error: message });
    }
    await json(response, status, { status: "pending", error: message });
    return false;
  };
  if (!placement) return fail(404, "找不到對應的認購標的");
  if (placement.is_delisted) return fail(409, "此標的已下架，鏈上結算已暫停，請聯繫管理員恢復標的或處理預留");
  if (placement.is_active === false) return fail(409, "此標的目前未開放認購，鏈上結算已暫停，請聯繫管理員恢復標的或處理預留");
  return true;
}

// 冪等：若同一 ref_key 已成功結算，直接回傳既有 tx；若仍 pending 視為進行中。
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
    .select("id,status,tx_hash,error,payload")
    .eq("ref_key", row.ref_key)
    .maybeSingle();
  if (existing.error) throw new Error(`查詢結算冪等紀錄失敗：${existing.error.message}`);
  if (existing.data) {
    if (existing.data.status === "failed") {
      const previousPayload = existing.data.payload && typeof existing.data.payload === "object"
        ? existing.data.payload as Record<string, unknown>
        : {};
      const claimed = await admin
        .from("onchain_settlements")
        .update({
          status: "pending",
          error: null,
          payload: { ...previousPayload, previousFailure: existing.data.error ?? "未提供錯誤原因" },
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.data.id)
        .eq("status", "failed")
        .select("id")
        .maybeSingle();
      if (claimed.error) throw new Error(`取得結算重試權失敗：${claimed.error.message}`);
      if (claimed.data) return { id: claimed.data.id };
      const latest = await admin
        .from("onchain_settlements")
        .select("status,tx_hash")
        .eq("id", existing.data.id)
        .maybeSingle();
      if (latest.error || !latest.data) {
        throw new Error(`確認結算重試狀態失敗：${latest.error?.message ?? "找不到結算紀錄"}`);
      }
      return { done: { status: latest.data.status, tx_hash: latest.data.tx_hash } };
    }
    return { done: { status: existing.data.status, tx_hash: existing.data.tx_hash } };
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
      .select("id,status,tx_hash,error,payload")
      .eq("ref_key", row.ref_key)
      .maybeSingle();
    if (retry.data) {
      if (retry.data.status === "failed") {
        const previousPayload = retry.data.payload && typeof retry.data.payload === "object"
          ? retry.data.payload as Record<string, unknown>
          : {};
        const claimed = await admin
          .from("onchain_settlements")
          .update({
            status: "pending",
            error: null,
            payload: { ...previousPayload, previousFailure: retry.data.error ?? "未提供錯誤原因" },
            updated_at: new Date().toISOString(),
          })
          .eq("id", retry.data.id)
          .eq("status", "failed")
          .select("id")
          .maybeSingle();
        if (claimed.error) throw new Error(`取得結算重試權失敗：${claimed.error.message}`);
        if (claimed.data) return { id: claimed.data.id };
      }
      const latest = await admin
        .from("onchain_settlements")
        .select("status,tx_hash")
        .eq("id", retry.data.id)
        .maybeSingle();
      if (latest.error || !latest.data) {
        throw new Error(`確認結果重試狀態失敗：${latest.error?.message ?? "找不到結算紀錄"}`);
      }
      return { done: { status: latest.data.status, tx_hash: latest.data.tx_hash } };
    }
    // 沒有既有列 ⇒ 這不是併發撞 unique，而是真正的寫入失敗（例如 CHECK 約束不允許
    // 插入 action）。以前這裡會謊報 pending「done」，導致結算靜默 no-op，卻回報成功。
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
  patch: { status: "confirmed" | "failed" | "pending"; tx_hash?: string; error?: string },
) {
  const before = await admin
    .from("onchain_settlements")
    .select("id,ref_key,user_id,payload,action,asset_id,amount")
    .eq("id", id)
    .maybeSingle();
  if (before.error || !before.data) {
    throw new Error(`讀取結算紀錄失敗：${before.error?.message ?? "找不到結算紀錄"}`);
  }
  const payload = before.data.payload && typeof before.data.payload === "object"
    ? before.data.payload as Record<string, unknown>
    : {};
  const previousFailure = typeof payload.previousFailure === "string" ? payload.previousFailure : null;
  const updateValues = {
    ...patch,
    ...(patch.status === "confirmed" ? { error: null } : {}),
    ...(patch.status === "confirmed" && previousFailure ? {
      payload: { ...payload, recoveredAt: new Date().toISOString() },
    } : {}),
    updated_at: new Date().toISOString(),
  };
  let updateQuery = admin.from("onchain_settlements").update(updateValues).eq("id", id);
  if (patch.status !== "confirmed") updateQuery = updateQuery.neq("status", "confirmed");
  const { data, error } = await updateQuery.select("id").maybeSingle();
  if (error || !data) {
    const { data: latest, error: latestError } = await admin
      .from("onchain_settlements")
      .select("status")
      .eq("id", id)
      .maybeSingle();
    if (!latestError && latest?.status === "confirmed") return;
    throw new Error(`更新結算狀態失敗：${error?.message ?? latestError?.message ?? "找不到結算紀錄"}`);
  }
  if (patch.status === "confirmed" && previousFailure) {
    await alertSettlementRecovery(admin, {
      refKey: before.data.ref_key,
      txHash: patch.tx_hash,
      previousFailure,
      userId: before.data.user_id,
    });
  }
  if (patch.status === "confirmed") {
    const refKey = before.data.ref_key as string;
    const wasDelayed = Boolean(previousFailure) || await hadPriorSettlementFailure(admin, refKey);
    if (wasDelayed) {
      const description = await describeSettlementForUser(admin, {
        action: before.data.action as string | null,
        assetId: before.data.asset_id as string | null,
        amount: before.data.amount == null ? null : Number(before.data.amount),
      }).catch(() => null);
      if (description) {
        await notifyUserSettlementCompleted(admin, {
          refKey,
          userId: before.data.user_id as string | null,
          description,
          txHash: patch.tx_hash,
        });
      }
    }
  }
}

// 讀取／合併 onchain_settlements.payload。多步鏈上結算（收 JC 進金庫、支付 net 給
// 賣方、發標的）把每一步的 tx hash 記進 payload，管理員「一鍵補發」重試時可跳過
// 已完成的步驟，避免重複扣款／重複轉帳。
async function readSettlementPayload(
  admin: SupabaseClient,
  id: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await admin
    .from("onchain_settlements")
    .select("payload")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) throw new Error(`讀取結算進度失敗：${error?.message ?? "找不到結算紀錄"}`);
  const payload = (data as { payload?: unknown } | null)?.payload;
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

async function mergeSettlementPayload(
  admin: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const current = await readSettlementPayload(admin, id);
  const { data, error } = await admin
    .from("onchain_settlements")
    .update({ payload: { ...current, ...patch }, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error || !data) {
    throw new Error(`保存鏈上交易進度失敗：${error?.message ?? "找不到結算紀錄"}`);
  }
}

async function runSettlementStep(
  admin: SupabaseClient,
  settlementId: string,
  payload: Record<string, unknown>,
  key: string,
  submit: (onSubmitted: OnAdminTransactionSubmitted) => Promise<string | null>,
): Promise<string | null> {
  const savedHash = typeof payload[key] === "string" ? payload[key] as `0x${string}` : null;
  if (savedHash) {
    let state = await getAdminTransactionStatus(savedHash);
    if (state === "confirmed") return savedHash;
    if (state !== "reverted") {
      try {
        await waitForAdminTransaction(savedHash);
        return savedHash;
      } catch (error) {
        state = await getAdminTransactionStatus(savedHash);
        if (state !== "reverted") {
          throw new Error(
            `鏈上交易 ${savedHash} 尚無法確認，系統已保留交易並停止重送以避免重複轉帳：${errMsg(error)}`,
          );
        }
      }
    }
    await mergeSettlementPayload(admin, settlementId, { [key]: null });
    payload[key] = null;
  }

  let submittedHash: `0x${string}` | null = null;
  const result = await submit(async (hash) => {
    await mergeSettlementPayload(admin, settlementId, { [key]: hash });
    payload[key] = hash;
    submittedHash = hash;
  });
  return result ?? submittedHash;
}

// 三個 owner-only 鏈上結算的核心邏輯抽成獨立函式，理由：管理員的「一鍵補發」
// 必須能對任何使用者的卡單紀錄重跑同一段結算流程，而不只是原始購買者本人。
// 這裡一律只以站內既有帳本列（ledgerRow）為準」重新推導金額與錢包，從不信任
// 呼叫端傳入的數字——不論是使用者本人觸發，還是管理員代為重試都一樣安全。
async function settleVaultJcReservationCore(
  admin: SupabaseClient,
  response: ServerResponse,
  reservation: {
    request_key: string;
    user_id: string;
    jc_amount: number;
    usdt_amount: number;
    wallet_address: string | null;
    source_tx_hash: string | null;
  },
): Promise<void> {
  const amount = Number(reservation.jc_amount);
  const usdtAmount = Number(reservation.usdt_amount);
  let wallet: Address;
  try {
    wallet = toAddress(reservation.wallet_address, "使用者帳號");
  } catch (error) {
    const message = errMsg(error);
    await alertSettlementFailure(admin, {
      kind: "金庫買 JC",
      refKey: `mint_jc:${reservation.request_key}`,
      stage: "使用者錢包地址驗證",
      error: message,
      userId: reservation.user_id,
      deliverable: "JC",
      jcAmount: amount,
      usdtAmount,
      txHash: reservation.source_tx_hash,
      remedy: "USDT 入金已驗證但 JC 尚未發放或正式入帳；請修正使用者綁定錢包後由系統重試。",
    });
    return json(response, 422, { status: "pending", error: message, request_key: reservation.request_key });
  }
  if (!(amount > 0) || !(usdtAmount > 0) || !reservation.source_tx_hash) {
    return json(response, 202, { status: "pending", error: "尚未收到可驗證的 USDT 入金交易", request_key: reservation.request_key });
  }
  const refKey = `mint_jc:${reservation.request_key}`;
  if (!(await guardRelayerGas(response, admin, {
    kind: "金庫買 JC",
    refKey,
    stage: "ADMIN 熱錢包 Gas 預檢",
    userId: reservation.user_id,
    deliverable: "JC",
    jcAmount: amount,
    usdtAmount,
    txHash: reservation.source_tx_hash,
    remedy: "USDT 入金已驗證，但 ADMIN 熱錢包 Gas 不足，JC 尚未發放且正式帳本未扣入；補足 Gas 後由系統自動重試。",
  }))) return;
  const claim = await claimSettlement(admin, {
    action: "mint_jc",
    ref_key: refKey,
    user_id: reservation.user_id,
    amount,
    payment: usdtAmount,
    payload: { wallet, sourceTx: reservation.source_tx_hash },
  });
  if ("done" in claim) {
    return json(response, claim.done.status === "confirmed" ? 200 : 202, {
      ...claim.done,
      request_key: reservation.request_key,
      idempotent: true,
    });
  }

  let payoutTx: string | null = null;
  try {
    await verifyVaultUsdtDeposit(reservation.source_tx_hash, wallet, usdtAmount);
    const payload = await readSettlementPayload(admin, claim.id);
    payoutTx = await runSettlementStep(admin, claim.id, payload, "mintTx", (onSubmitted) =>
      mintJc(wallet, amount, onSubmitted),
    );
    if (!payoutTx) throw new Error("JC 發放尚未確認，系統將安全重試");

    const { error } = await admin.rpc("finalize_vault_jc_purchase", {
      p_request_key: reservation.request_key,
      p_mint_tx: payoutTx,
    });
    if (error) throw new Error(`正式入帳同步失敗：${error.message}`);
    await finish(admin, claim.id, { status: "confirmed", tx_hash: payoutTx });
    return json(response, 200, {
      status: "confirmed",
      tx_hash: payoutTx,
      source_tx_hash: reservation.source_tx_hash,
      jc: amount,
      usdt: usdtAmount,
      request_key: reservation.request_key,
    });
  } catch (error) {
    const message = errMsg(error);
    await finish(admin, claim.id, { status: "failed", error: message }).catch(() => undefined);
    await alertSettlementFailure(admin, {
      kind: "金庫買 JC",
      refKey,
      stage: payoutTx ? "JC 已鏈上發放，正式帳本同步" : "驗證 USDT 入金並發放 JC",
      error: message,
      userId: reservation.user_id,
      deliverable: "JC",
      jcAmount: amount,
      usdtAmount,
      txHash: payoutTx ?? reservation.source_tx_hash,
      remedy: "交易額度已保留；系統會依已保存的交易雜湊重試，請勿再次買入。後台可檢視待處理交割。",
    });
    return json(response, 202, {
      status: "pending",
      request_key: reservation.request_key,
      tx_hash: payoutTx ?? reservation.source_tx_hash,
      error: message,
    });
  }
}

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
  if (!(await guardRelayerGas(response, admin, {
    kind: "金庫買 JC",
    refKey: `mint_jc:${ledgerRow.id}`,
    stage: "ADMIN 熱錢包 Gas 預檢",
    userId: ledgerRow.user_id,
    deliverable: "JC",
    jcAmount: amount,
    remedy: "JC 尚未發放；補足 ADMIN 熱錢包 Gas 後，管理員補發／自動重試即可完成。",
  }))) return;

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
    await alertSettlementFailure(admin, {
      kind: "金庫買 JC",
      refKey: `mint_jc:${ledgerRow.id}`,
      stage: "Safe 金庫發放 JC 給用戶",
      error: errMsg(e),
      userId: ledgerRow.user_id,
      deliverable: "JC",
      jcAmount: amount,
    });
    return json(response, 502, { error: `鏈上發幣失敗：${errMsg(e)}` });
  }
}

async function settleReservedSubscribeCore(
  admin: SupabaseClient,
  response: ServerResponse,
  reservation: {
    request_key: string;
    user_id: string;
    asset_id: string | null;
    quantity: number;
    jc_amount: number;
    wallet_address: string | null;
  },
): Promise<void> {
  const assetId = reservation.asset_id;
  const refKey = `subscribe:${reservation.request_key}`;
  const units = Number(reservation.quantity);
  const gross = Number(reservation.jc_amount);
  const kind = "一級認購";
  if (!assetId || !(units > 0) || !(gross > 0)) {
    const message = "認購預留資料不完整";
    await alertSettlementFailure(admin, {
      kind,
      refKey,
      stage: "認購預留資料驗證",
      error: message,
      userId: reservation.user_id,
      userRole: "買方",
      assetId,
      quantity: units,
      jcAmount: gross,
      remedy: "認購尚未正式扣帳或發放資產；請管理員檢查此筆預留資料並修復後重試。",
    });
    return json(response, 422, { status: "pending", error: message, request_key: reservation.request_key });
  }
  const { data: placement, error: placementError } = await admin
    .from("private_placements")
    .select("id,name,is_ae_token,token_address")
    .eq("id", assetId)
    .maybeSingle();
  if (placementError || !placement) {
    const message = placementError?.message ?? "找不到認購標的";
    await alertSettlementFailure(admin, {
      kind,
      refKey,
      stage: "讀取認購標的資料",
      error: message,
      userId: reservation.user_id,
      userRole: "買方",
      assetId,
      quantity: units,
      jcAmount: gross,
      remedy: "此筆認購目前仍是預留，尚未正式扣帳；請管理員修復標的資料後重新觸發結算。",
    });
    return json(response, 202, { status: "pending", error: message, request_key: reservation.request_key });
  }
  const isAe = Boolean(placement.is_ae_token);
  const factoryToken = isAe ? undefined : (await getCurrentRwaFactoryToken(assetId)) ?? undefined;
  const failureContext: Omit<SettlementFailureInput, "error"> = {
    kind: isAe ? "一級認購（AE）" : "一級認購（RWA）",
    refKey,
    stage: "認購結算前檢查",
    userId: reservation.user_id,
    userRole: "買方",
    assetId,
    assetName: isAe ? "AE" : `${placement.name}（${assetId}）`,
    deliverable: isAe ? "AE" : "RWA 份額",
    quantity: units,
    quantityUnit: isAe ? "AE" : "份",
    jcAmount: gross,
  };
  let wallet: Address;
  try {
    wallet = toAddress(reservation.wallet_address, "使用者帳號");
  } catch (error) {
    const message = errMsg(error);
    await alertSettlementFailure(admin, {
      ...failureContext,
      error: message,
      remedy: "使用者錢包地址無效，鏈上交割尚未執行且認���尚未正式入帳；請先修正綁定錢包後由管理員重試。",
    });
    return json(response, 422, { status: "pending", error: message, request_key: reservation.request_key });
  }
  const alreadyConfirmed = await findConfirmedSettlement(admin, refKey);
  if (alreadyConfirmed) {
    return json(response, 200, { ...alreadyConfirmed, idempotent: true, request_key: reservation.request_key });
  }
  if (!(await guardPlacementStillSettleable(admin, response, assetId, failureContext))) return;
  if (!isAe && !factoryToken) {
    const message = "RWA 專屬代幣尚未部署，認購預留等待管理員處理";
    await alertSettlementFailure(admin, {
      ...failureContext,
      stage: "RWA 專屬代幣檢查",
      error: message,
      remedy: "請管理員先建立並回填此標的的 RWA 專屬代幣，並把份額補入熱錢包，然後重試；此筆認購尚未正式扣帳或發放份額。",
    });
    return json(response, 202, { status: "pending", error: message, request_key: reservation.request_key });
  }
  if (!(await guardRelayerGas(response, admin, {
    ...failureContext,
    stage: "ADMIN 熱錢包 Gas 預檢",
    remedy: "認購金額與庫存仍僅為預留，尚未正式扣帳或發放標的；補足 ADMIN 熱錢包 Gas 後系統會自動重試。",
  }))) return;
  const claim = await claimSettlement(admin, {
    action: "subscribe",
    ref_key: refKey,
    user_id: reservation.user_id,
    asset_id: assetId,
    amount: units,
    payment: gross,
    payload: {
      wallet,
      isAe,
      factoryToken: factoryToken ?? null,
      reservation: true,
      jcCollectionMode: "direct_v1",
    },
  });
  if ("done" in claim) {
    return json(response, claim.done.status === "confirmed" ? 200 : 202, {
      ...claim.done,
      request_key: reservation.request_key,
      idempotent: true,
    });
  }

  let stage = "買方鏈上 JC 收款";
  let jcPullTx: string | null = null;
  let jcVaultTx: string | null = null;
  let assetTx: string | null = null;
  let payload: Record<string, unknown> = {};
  try {
    payload = await readSettlementPayload(admin, claim.id);
    // 新版 JC 是標準 ERC-20，認購本金應由買方直接 transferFrom 至 Safe，一筆交易即可。
    // 舊版兩跳流程只供已保存 jcPullTx 的卡單續跑，避免同一筆認購重複扣款。
    const hasLegacyPull = typeof payload.jcPullTx === "string";
    const useDirectCollection = payload.jcCollectionMode === "direct_v1" || !hasLegacyPull;
    if (useDirectCollection) {
      if (payload.jcCollectionMode !== "direct_v1") {
        await mergeSettlementPayload(admin, claim.id, { jcCollectionMode: "direct_v1" });
        payload.jcCollectionMode = "direct_v1";
      }
      stage = "買方鏈上 JC 收款（直接轉入 Safe）";
      jcVaultTx = await runSettlementStep(admin, claim.id, payload, "jcToVaultTx", (onSubmitted) =>
        collectJcToVault(wallet, gross, onSubmitted),
      );
      if (!jcVaultTx) throw new Error("認購 JC 尚未轉入 Safe，系統將安全重試");
      // finalize_private_purchase 仍要求兩個交易雜湊欄位；直接收款是一筆交易，兩欄共用同一個已確認的 hash。
      jcPullTx = jcVaultTx;
    } else {
      jcPullTx = await runSettlementStep(admin, claim.id, payload, "jcPullTx", (onSubmitted) =>
        pullJcFromUser(wallet, gross, onSubmitted),
      );
      if (!jcPullTx) throw new Error("舊版認購 JC 收款尚未確認，系統將安全重試");

      stage = "ADMIN 將 JC 轉入 Safe 金庫";
      jcVaultTx = await runSettlementStep(admin, claim.id, payload, "jcToVaultTx", (onSubmitted) =>
        sendJcToVault(gross, onSubmitted),
      );
      if (!jcVaultTx) throw new Error("認購 JC 尚未轉入 Safe，系統將安全重試");
    }

    stage = isAe ? "發放 AE 給買方" : "發放 RWA 份額給買方";
    assetTx = await runSettlementStep(admin, claim.id, payload, "assetTransferTx", (onSubmitted) =>
      isAe
        ? executeAeSubscription(wallet, units, onSubmitted)
        : executeSubscription(wallet, units, undefined, factoryToken, onSubmitted),
    );
    if (!assetTx) throw new Error("標的份額尚未發放，系統將安全重試");

    stage = "原子寫入正式帳本、持倉與庫存";
    const { data: finalized, error: finalizeError } = await admin.rpc("finalize_private_purchase", {
      p_request_key: reservation.request_key,
      p_jc_pull_tx: jcPullTx,
      p_jc_vault_tx: jcVaultTx,
      p_asset_tx: assetTx,
    });
    if (finalizeError) throw new Error(`正式入帳同步失敗：${finalizeError.message}`);
    await finish(admin, claim.id, { status: "confirmed", tx_hash: assetTx });
    const ledgerId = (finalized as { ledger_id?: string } | null)?.ledger_id;
    if (ledgerId) await settleCommissionsForSource(admin, ledgerId).catch(() => undefined);
    return json(response, 200, {
      status: "confirmed",
      request_key: reservation.request_key,
      tx_hash: assetTx,
      jc_pull_tx: jcPullTx,
      jc_vault_tx: jcVaultTx,
      quantity: units,
      payment: gross,
      ledger_id: ledgerId,
      entered_secondary_market: Boolean((finalized as { entered_secondary_market?: boolean } | null)?.entered_secondary_market),
    });
  } catch (error) {
    const message = errMsg(error);
    const latestPayload = await readSettlementPayload(admin, claim.id).catch(() => payload);
    const knownAssetTx = assetTx ?? (typeof latestPayload.assetTransferTx === "string" ? latestPayload.assetTransferTx : null);
    const confirmedSettlement = await findConfirmedSettlement(admin, refKey).catch(() => null);
    const reservationFinalized = await isSubscribeReservationConfirmed(admin, reservation.request_key);
    if (confirmedSettlement || reservationFinalized) {
      const confirmedTx = confirmedSettlement?.tx_hash ?? knownAssetTx;
      await finish(admin, claim.id, {
        status: "confirmed",
        ...(confirmedTx ? { tx_hash: confirmedTx } : {}),
      }).catch(() => undefined);
      return json(response, 200, {
        status: "confirmed",
        request_key: reservation.request_key,
        ...(confirmedTx ? { tx_hash: confirmedTx } : {}),
        idempotent: true,
      });
    }
    // 交割失敗是平台處理中的狀態，不是用戶失敗：保留預留與已提交的交易步驟，讓 sweep／管理員重試補發原標的。只有確認永久無法交割時，才走明確的取消與退款流程。
    await finish(admin, claim.id, { status: "pending", error: message }).catch(() => undefined);
    const persistedPayload = latestPayload;
    const persistedAssetTx = typeof persistedPayload.assetTransferTx === "string" ? persistedPayload.assetTransferTx : null;
    const persistedVaultTx = typeof persistedPayload.jcToVaultTx === "string" ? persistedPayload.jcToVaultTx : null;
    const persistedPullTx = typeof persistedPayload.jcPullTx === "string" ? persistedPayload.jcPullTx : null;
    const failureTxHash = assetTx ?? persistedAssetTx ?? jcVaultTx ?? persistedVaultTx ?? jcPullTx ?? persistedPullTx;
    await alertSettlementFailure(admin, {
      kind: isAe ? "一級認購（AE）" : "一級認購（RWA）",
      refKey,
      stage,
      error: message,
      userId: reservation.user_id,
      userRole: "買方",
      assetId,
      assetName: isAe ? "AE" : `${placement.name}（${assetId}）`,
      deliverable: isAe ? "AE" : "RWA 份額",
      quantity: units,
      quantityUnit: isAe ? "AE" : "份",
      jcAmount: gross,
      txHash: failureTxHash,
      remedy: "此筆認購仍保留 JC 預留與原訂單，系統會依已保存的交易雜湊自動重試並補發原標的；請勿重複認購。僅在確認永久無法交割後，才由管理員取消並退款。",
    });
    return json(response, 202, {
      status: "pending",
      request_key: reservation.request_key,
      tx_hash: failureTxHash,
      error: message,
    });
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
  const assetId = ledgerRow.asset_id;
  if (!assetId) return json(response, 422, { error: "認購紀錄缺少標的識別碼" });
  const placement = await admin
    .from("private_placements")
    .select("id,name,is_ae_token")
    .eq("id", assetId)
    .maybeSingle();
  const isAe = !!placement.data?.is_ae_token;
  const factoryToken = isAe
    ? undefined
    : (await getCurrentRwaFactoryToken(assetId)) ?? undefined;
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
  const alreadyConfirmed = await findConfirmedSettlement(admin, `subscribe:${ledgerRow.id}`);
  if (alreadyConfirmed) return json(response, 200, { ...alreadyConfirmed, idempotent: true });
  if (!(await guardPlacementStillSettleable(admin, response, String(ledgerRow.asset_id), {
    kind: isAe ? "一級認購（AE）" : "一級認購（RWA）",
    refKey: `subscribe:${ledgerRow.id}`,
    stage: "認購結算前標的狀態檢查",
    userId: ledgerRow.user_id,
    userRole: "買方",
    assetId,
    assetName: isAe ? "AE" : placement.data?.name ? `${placement.data.name}（${assetId}）` : assetId,
    deliverable: isAe ? "AE" : "RWA 份額",
    quantity: units,
    quantityUnit: isAe ? "AE" : "份",
    jcAmount: gross,
    remedy: "請管理員確認是否恢復此標的或處理該筆舊認購；未確認前不會再次回報發幣成功。",
  }))) return;
  if (!(await guardRelayerGas(response, admin, {
    kind: isAe ? "一級認購（AE）" : "一級認購（RWA）",
    refKey: `subscribe:${ledgerRow.id}`,
    stage: "ADMIN 熱錢包 Gas 預檢",
    userId: ledgerRow.user_id,
    userRole: "買方",
    assetId,
    assetName: isAe ? "AE" : placement.data?.name ? `${placement.data.name}（${assetId}）` : assetId,
    deliverable: isAe ? "AE" : "RWA 份額",
    quantity: units,
    quantityUnit: isAe ? "AE" : "份",
    jcAmount: gross,
    remedy: "認購待結算；補足 ADMIN 熱錢包 Gas ��，系統會自動重試鏈上交���。",
  }))) return;

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
  let stage = "讀取結算進度";
  try {
    const payload = await readSettlementPayload(admin, claim.id);
    const hasLegacyJcPull = typeof payload.jcPullTx === "string";
    if (hasLegacyJcPull) {
      stage = "向買方收取 JC（買方→ADMIN）";
      const pullTx = await runSettlementStep(admin, claim.id, payload, "jcPullTx", (onSubmitted) =>
        pullJcFromUser(wallet, gross, onSubmitted),
      );
      if (!pullTx) throw new Error("舊版認購 JC 收款尚未確認，系統將安全重試");

      if (typeof payload.assetTransferTx !== "string") {
        const assetToken = isAe ? RELAYER_ADDRESSES.aeToken : factoryToken;
        if (assetToken) {
          const recoveredTx = await findRecentAssetTransfer(
            assetToken,
            wallet,
            units,
            payload.jcPullTx as `0x${string}`,
            !isAe,
          );
          if (recoveredTx) {
            await mergeSettlementPayload(admin, claim.id, {
              assetTransferTx: recoveredTx,
              assetTransferRecovered: true,
            });
            payload.assetTransferTx = recoveredTx;
          }
        }
      }
    }

    stage = "認購 JC 轉入 Safe 金庫";
    const vaultTx = await runSettlementStep(admin, claim.id, payload, "jcToVaultTx", (onSubmitted) =>
      hasLegacyJcPull
        ? sendJcToVault(gross, onSubmitted)
        : collectJcToVault(wallet, gross, onSubmitted),
    );
    if (!vaultTx) throw new Error("認購 JC 尚未轉入 Safe，請稍後自動重試");

    stage = isAe ? "發放 AE 給買方" : "發放 RWA 份額給買方";
    const assetTx = await runSettlementStep(admin, claim.id, payload, "assetTransferTx", (onSubmitted) =>
      isAe
        ? executeAeSubscription(wallet, units, onSubmitted)
        : executeSubscription(wallet, units, undefined, factoryToken, onSubmitted),
    );
    if (!assetTx) throw new Error("標的份額尚未發放，請稍後自動重試");

    stage = "更新結算狀態";
    await finish(admin, claim.id, { status: "confirmed", tx_hash: assetTx });

    // 認購成交當下立即把此筆購買產生的推廣分潤上鏈發放（ADMIN 熱錢包→各上線受益
    // 人），best-effort：發不成的不影響本次認購結果，會由 cron / 後台補發撿回。
    await settleCommissionsForSource(admin, ledgerRow.id).catch(() => {});
    return json(response, 200, { status: "confirmed", tx_hash: assetTx, units, payment: gross });
  } catch (e) {
    const confirmed = await findConfirmedSettlement(admin, `subscribe:${ledgerRow.id}`).catch(() => null);
    if (confirmed) {
      return json(response, 200, { ...confirmed, idempotent: true });
    }
    // 舊版已扣帳認購也不能因平台交割暫時失敗而結束；保留 pending，交由補發流程完成原標的交割。
    // finish() 也會以條件更新確保其他請求已確認後不會被此錯誤降回 pending。
    await finish(admin, claim.id, { status: "pending", error: errMsg(e) });
    await alertSettlementFailure(admin, {
      kind: isAe ? "一級認購（AE��" : "一級認購（RWA）",
      refKey: `subscribe:${ledgerRow.id}`,
      stage,
      error: errMsg(e),
      userId: ledgerRow.user_id,
      userRole: "買方",
      assetId,
      assetName: isAe ? "AE" : placement.data?.name ? `${placement.data.name}（${assetId}）` : null,
      deliverable: isAe ? "AE" : "RWA 份額",
      quantity: units,
      quantityUnit: isAe ? "AE" : "份",
      jcAmount: gross,
    });
    return json(response, 502, { error: `鏈上認購結算失敗：${errMsg(e)}` });
  }
}

async function collectJcForManualSettlementRepair(admin: SupabaseClient, settlementId: string) {
  const { data: settlement, error: settlementError } = await admin
    .from("onchain_settlements")
    .select("id,action,ref_key,user_id,asset_id,payment,status,payload")
    .eq("id", settlementId)
    .maybeSingle();
  if (settlementError) throw new Error(`讀取人工補發紀錄失敗：${settlementError.message}`);
  if (!settlement || settlement.action !== "subscribe" || settlement.status !== "confirmed") {
    throw new Error("找不到已確認的一級認購人工補發紀錄");
  }

  const settlementPayload = settlement.payload && typeof settlement.payload === "object"
    ? settlement.payload as Record<string, unknown>
    : {};
  if (settlementPayload.manualRepair !== true || typeof settlementPayload.jcPullTx === "string") {
    throw new Error("此紀錄不符合人工補發漏收 JC 的安全條件");
  }

  const ledgerMatch = settlement.ref_key.match(/^subscribe:([0-9a-f-]{36})$/i);
  if (!ledgerMatch) throw new Error("結算紀錄沒有有效的認購帳本錨點");
  const { data: ledger, error: ledgerError } = await admin
    .from("jc_ledger")
    .select("id,user_id,asset_id,amount,metadata")
    .eq("id", ledgerMatch[1])
    .eq("entry_type", "private_purchase")
    .maybeSingle();
  if (ledgerError) throw new Error(`讀取認購帳本失敗：${ledgerError.message}`);
  if (!ledger || ledger.user_id !== settlement.user_id || ledger.asset_id !== settlement.asset_id) {
    throw new Error("帳本與人工補發紀錄不一致，已停止補收");
  }
  const gross = Number(
    (ledger.metadata as { gross?: number } | null)?.gross ?? Math.abs(Number(ledger.amount)),
  );
  if (!(gross > 0) || !Number.isFinite(gross) || Math.abs(gross - Number(settlement.payment)) > 0.000001) {
    throw new Error("帳本 JC 金額與人工補發紀錄不一致，已停止補收");
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("wallet_address")
    .eq("id", ledger.user_id)
    .maybeSingle();
  if (profileError) throw new Error(`讀取使用者錢包失敗：${profileError.message}`);
  const wallet = toAddress(profile?.wallet_address, "使用者帳號");
  const payload = await readSettlementPayload(admin, settlement.id);
  const txHash = await runSettlementStep(admin, settlement.id, payload, "jcToVaultTx", (onSubmitted) =>
    collectJcToVault(wallet, gross, onSubmitted),
  );
  if (!txHash) throw new Error("JC 尚未轉入 Safe，請稍後安全重試");
  return txHash;
}

// JC 贖回：使用者申請贖回（request_jc_redemption 已扣站內 JC 帳本、建立
// redemption_orders pending 訂單）後即時觸發鏈上撥款——(1) 把使用者鏈上 JC
// 實際收回 Safe 金庫（collectJcToVault），(2) ADMIN 熱錢包直接用自己的 USDT
// 餘額撥款給使用者（adminSendUsdt）。採「先收款、後撥款」的安全閘門：JC 收回
// 失敗（例如使用者鏈上 JC 不足或未授權——站內可用 JC 可能包含尚未上鏈的分潤
// JC）就先擋下，尚未撥出任何 USDT，避免平台白白撥款卻收不回對應的 JC。成功
// 後直接把 redemption_orders 標記為 completed，不再需要管理員手動貼 tx hash。
async function settleReservedRedemptionCore(
  admin: SupabaseClient,
  response: ServerResponse,
  order: { id: string; user_id: string; wallet_address: string; jc_amount: number; usdt_amount: number; idempotency_key: string },
): Promise<void> {
  const wallet = toAddress(order.wallet_address, "使用者帳號");
  const jcAmount = Number(order.jc_amount);
  const usdtAmount = Number(order.usdt_amount);
  if (!(jcAmount > 0) || !(usdtAmount > 0)) return json(response, 422, { status: "pending", error: "贖回金額無效" });
  const refKey = `redeem:${order.id}`;
  if (!(await guardRelayerGas(response, admin, {
    kind: "JC 贖回 USDT",
    refKey,
    stage: "ADMIN 熱錢包 Gas 預檢",
    userId: order.user_id,
    deliverable: "JC → USDT",
    jcAmount,
    usdtAmount,
    remedy: "贖回額度已保留；補足 ADMIN 熱錢包 Gas 後，系統會自動繼續鏈上 JC 回收與 USDT 撥款。",
  }))) return;
  const claim = await claimSettlement(admin, {
    action: "redeem",
    ref_key: refKey,
    user_id: order.user_id,
    amount: jcAmount,
    payment: usdtAmount,
    payload: { wallet, reservation: true, requestKey: order.idempotency_key },
  });
  if ("done" in claim) {
    return json(response, claim.done.status === "confirmed" ? 200 : 202, { ...claim.done, request_key: order.idempotency_key, idempotent: true });
  }

  let stage = "使用者 JC 收至 ADMIN";
  let jcPullTx: string | null = null;
  let jcVaultTx: string | null = null;
  let usdtTx: string | null = null;
  try {
    const payload = await readSettlementPayload(admin, claim.id);
    jcPullTx = await runSettlementStep(admin, claim.id, payload, "jcPullTx", (onSubmitted) =>
      pullJcFromUser(wallet, jcAmount, onSubmitted),
    );
    if (!jcPullTx) throw new Error("使用者 JC 尚未收至 ADMIN，系統將安全重試");

    stage = "ADMIN 將 JC 轉入 Safe 金庫";
    jcVaultTx = await runSettlementStep(admin, claim.id, payload, "jcToVaultTx", (onSubmitted) =>
      sendJcToVault(jcAmount, onSubmitted),
    );
    if (!jcVaultTx) throw new Error("贖回 JC 尚未轉入 Safe，系統將安全重試");

    stage = "ADMIN 熱錢包撥付 USDT 給用戶";
    usdtTx = await runSettlementStep(admin, claim.id, payload, "usdtTx", (onSubmitted) =>
      adminSendUsdt(wallet, usdtAmount, onSubmitted),
    );
    if (!usdtTx) throw new Error("USDT 轉款尚未確認，系統將安全重試");

    stage = "原子寫入贖回帳本與訂單狀態";
    const { error } = await admin.rpc("finalize_jc_redemption", {
      p_order_id: order.id,
      p_jc_collect_tx: jcVaultTx,
      p_usdt_tx: usdtTx,
    });
    if (error) throw new Error(`正式入帳同步失敗：${error.message}`);
    await finish(admin, claim.id, { status: "confirmed", tx_hash: usdtTx });
    return json(response, 200, {
      status: "confirmed",
      request_key: order.idempotency_key,
      tx_hash: usdtTx,
      jc_collect_tx: jcVaultTx,
      jc_pull_tx: jcPullTx,
      jc_amount: jcAmount,
      usdt_amount: usdtAmount,
    });
  } catch (error) {
    const message = errMsg(error);
    await finish(admin, claim.id, { status: "failed", error: message }).catch(() => undefined);
    await alertSettlementFailure(admin, {
      kind: "JC 贖回 USDT",
      refKey,
      stage,
      error: message,
      userId: order.user_id,
      deliverable: "JC → USDT",
      jcAmount,
      usdtAmount,
      txHash: usdtTx ?? jcVaultTx ?? jcPullTx,
      remedy: "贖回 JC 已預留；系統依已保存的鏈上步驟自動重試，請勿重複申請。若 USDT 已撥付，後續只會補正式帳本同步。",
    });
    return json(response, 202, {
      status: "pending",
      request_key: order.idempotency_key,
      tx_hash: usdtTx ?? jcVaultTx ?? jcPullTx,
      error: message,
    });
  }
}

async function settleRedemptionCore(
  admin: SupabaseClient,
  response: ServerResponse,
  order: { id: string; user_id: string; wallet_address: string; jc_amount: number; usdt_amount: number; jc_ledger_id?: string | null; idempotency_key?: string | null },
): Promise<void> {
  if (!order.jc_ledger_id && order.idempotency_key) {
    return settleReservedRedemptionCore(admin, response, {
      id: order.id,
      user_id: order.user_id,
      wallet_address: order.wallet_address,
      jc_amount: order.jc_amount,
      usdt_amount: order.usdt_amount,
      idempotency_key: order.idempotency_key,
    });
  }
  let wallet: Address;
  try {
    wallet = toAddress(order.wallet_address, "使用者帳號");
  } catch (e) {
    return json(response, 422, { error: errMsg(e) });
  }
  const jcAmount = Number(order.jc_amount);
  const usdtAmount = Number(order.usdt_amount);
  if (!(jcAmount > 0) || !(usdtAmount > 0)) return json(response, 422, { error: "贖回金額無效" });
  if (!(await guardRelayerGas(response, admin, {
    kind: "JC 贖回 USDT",
    refKey: `redeem:${order.id}`,
    stage: "ADMIN 熱錢包 Gas 預檢",
    userId: order.user_id,
    deliverable: "JC → USDT",
    jcAmount,
    usdtAmount,
    remedy: "贖回交割尚未完成；補足 ADMIN 熱錢包 Gas 後，系統將自動重試。",
  }))) return;

  const claim = await claimSettlement(admin, {
    action: "redeem",
    ref_key: `redeem:${order.id}`,
    user_id: order.user_id,
    amount: jcAmount,
    payment: usdtAmount,
    payload: { wallet },
  });
  if ("done" in claim) return json(response, 200, { ...claim.done, idempotent: true });
  let stage = "收回用戶 JC 至 Safe 金庫";
  try {
    const payload = await readSettlementPayload(admin, claim.id);
    // 步驟1（安全閘門，必須先確認）：把使用者鏈上 JC 實際收進 Safe 金庫。使用者
    // 鏈上 JC／授權不足時會在這裡丟錯擋下，此時尚未撥出任何 USDT。
    let jcCollectTx = typeof payload.jcCollectTx === "string" ? payload.jcCollectTx : null;
    if (!jcCollectTx) {
      jcCollectTx = await collectJcToVault(wallet, jcAmount);
      await mergeSettlementPayload(admin, claim.id, { jcCollectTx });
    }
    // 步驟2：JC 已確認收回金庫，ADMIN 熱錢包用自己的 USDT 餘額直接撥款給使用者。
    stage = "ADMIN 熱錢包撥付 USDT 給用戶";
    let usdtTx = typeof payload.usdtTx === "string" ? payload.usdtTx : null;
    if (!usdtTx) {
      usdtTx = await adminSendUsdt(wallet, usdtAmount);
      await mergeSettlementPayload(admin, claim.id, { usdtTx });
    }
    await finish(admin, claim.id, { status: "confirmed", tx_hash: usdtTx ?? undefined });
    await admin
      .from("redemption_orders")
      .update({
        status: "completed",
        tx_hash: usdtTx,
        admin_note: "系統自動撥款（鏈上即時結算）",
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id)
      .eq("status", "pending");
    return json(response, 200, {
      status: "confirmed",
      tx_hash: usdtTx,
      jc_collect_tx: jcCollectTx,
      jc_amount: jcAmount,
      usdt_amount: usdtAmount,
    });
  } catch (e) {
    await finish(admin, claim.id, { status: "failed", error: errMsg(e) });
    await alertSettlementFailure(admin, {
      kind: "JC 贖回 USDT",
      refKey: `redeem:${order.id}`,
      stage,
      error: errMsg(e),
      userId: order.user_id,
      deliverable: "JC → USDT",
      jcAmount,
      usdtAmount,
    });
    return json(response, 502, { error: `贖回鏈上撥款失敗：${errMsg(e)}` });
  }
}

// 推廣分潤（代理獎金）鏈上即時發放：由 ADMIN 熱錢包直接把 JC transfer 給受益人
// 錢包（ADMIN→受益人，JC 合約允許與 owner 相關的轉帳）。錨定單筆 commission_logs
// （paid_at 為 null），金額一律以該筆 commission_amount 為準，絕不信任前端。成功後
// 寫入 jc_ledger 的 commission_payout（讓站內可用 JC 立即反映到帳）並標記 paid_at；
// onchain_settlements 以 ref_key `commission:<log_id>` 冪等，避免重複發放。
async function getReferralDepth(
  admin: SupabaseClient,
  beneficiaryId: string,
  buyerId: string,
): Promise<number | null> {
  if (beneficiaryId === buyerId) return null;
  const { data: profiles, error } = await admin
    .from("profiles")
  .select("id,referrer_id,parent_id")
  .in("id", [beneficiaryId, buyerId]);
  if (error) throw new Error(`讀取分潤推薦關係失敗：${error.message}`);
  const byId = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
  let current = byId.get(buyerId)?.referrer_id ?? byId.get(buyerId)?.parent_id ?? null;
  for (let depth = 1; depth <= 2; depth += 1) {
    if (!current) return null;
    if (current === beneficiaryId) return depth;
    const { data: parent, error: parentError } = await admin
      .from("profiles")
      .select("id,referrer_id")
      .eq("id", current)
      .maybeSingle();
    if (parentError) throw new Error(`讀取分潤推薦鏈失敗：${parentError.message}`);
    current = parent?.referrer_id ?? parent?.parent_id ?? null;
  }
  return null;
}

async function settleCommissionCore(
  admin: SupabaseClient,
  response: ServerResponse,
  log: { id: string; user_id: string; amount: number; asset_id: string | null; buyer_id?: string | null; bonus_type?: string | null; transaction_type?: string | null },
): Promise<void> {
  const amount = Number(log.amount);
  if (log.bonus_type !== "self_rebate" && log.buyer_id) {
    const depth = await getReferralDepth(admin, log.user_id, log.buyer_id);
    if (depth !== 1 && depth !== 2) {
      return json(response, 409, { error: "此分潤不符合 L1/L2 推薦層級，已停止派發並保留稽核資料" });
    }
  }
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
  if (!(await guardRelayerGas(response, admin, {
    kind: "推廣分潤發放",
    refKey: `commission:${log.id}`,
    stage: "ADMIN 熱錢包 Gas 預檢",
    userId: log.user_id,
    assetId: log.asset_id,
    deliverable: "JC 分潤",
    jcAmount: amount,
    remedy: "此筆分潤尚未上鏈發放；補足 ADMIN 熱錢包 Gas 後，系統會自動重試並只在鏈上確認後正式入帳。",
  }))) return;
  const notifyCommission = async () => {
    const transactionLabel = log.transaction_type === "private" ? "認購" : log.transaction_type === "secondary" ? "二級市場賣出" : "平台交易";
    await sendUserTelegramNotification(admin, {
      userId: log.user_id,
      category: "commission",
      eventKey: `commission-payout:${log.id}`,
      title: "代理分潤已入帳",
      body: `${transactionLabel}分潤已發放 ${amount.toLocaleString("zh-TW", { maximumFractionDigits: 6 })} JC${log.asset_id ? `，標的編號 ${log.asset_id}` : ""}。`,
    }).catch((error) => console.error("[v0] Telegram commission notification failed", errMsg(error), log.id));
  };

  const claim = await claimSettlement(admin, {
    action: "commission",
    ref_key: `commission:${log.id}`,
    user_id: log.user_id,
    asset_id: log.asset_id,
    amount,
    payment: amount,
    payload: { wallet },
  });
  if ("done" in claim) {
    if (claim.done.status === "confirmed") await notifyCommission();
    return json(response, claim.done.status === "confirmed" ? 200 : 202, { ...claim.done, idempotent: true });
  }
  let payoutTx: string | null = null;
  try {
    const payload = await readSettlementPayload(admin, claim.id);
    payoutTx = await runSettlementStep(admin, claim.id, payload, "payoutTx", (onSubmitted) =>
      adminSendJc(wallet, amount, onSubmitted),
    );
    if (!payoutTx) throw new Error("分潤轉帳尚未確認，系統將安全重試");

    const { error } = await admin.rpc("finalize_commission_payout", {
      p_commission_id: log.id,
      p_tx_hash: payoutTx,
    });
    if (error) throw new Error(`分潤正式入帳同步失敗：${error.message}`);
    await finish(admin, claim.id, { status: "confirmed", tx_hash: payoutTx });
    await notifyCommission();
    return json(response, 200, { status: "confirmed", tx_hash: payoutTx, amount });
  } catch (e) {
    const message = errMsg(e);
    await finish(admin, claim.id, { status: "failed", error: message }).catch(() => undefined);
    await alertSettlementFailure(admin, {
      kind: "推廣分潤發放",
      refKey: `commission:${log.id}`,
      stage: payoutTx ? "分潤已鏈上轉帳，正式帳本同步" : "ADMIN 熱錢包發放分潤 JC",
      error: message,
      userId: log.user_id,
      userRole: "受益人",
      assetId: log.asset_id,
      deliverable: "分潤 JC",
      jcAmount: amount,
      txHash: payoutTx,
      remedy: "已保存分潤交易雜湊；系統會重試正式帳本同步，不會重複轉帳。",
    });
    return json(response, 202, { status: "pending", tx_hash: payoutTx, error: message });
  }
}


/** 一級認購結算確認後，best-effort 把該筆購買所產生的推廣分潤「即時」上鏈發放
 *（ADMIN→受益人）。失敗只吞掉不拋出——沒發成的會被每日 cron sweep 與後台一鍵
 * 補發撿回，確保最終必定到帳並上鏈。 */
async function settleCommissionsForSource(admin: SupabaseClient, sourceLedgerId: string): Promise<void> {
  const { data: logs, error } = await admin
    .from("commission_logs")
    .select("id,beneficiary_id,buyer_id,commission_amount,asset_id,bonus_type,transaction_type")
    .eq("source_ledger_id", sourceLedgerId)
    .is("paid_at", null);
  if (error) throw new Error(`讀取認購分潤失敗：${error.message}`);
  for (const log of logs ?? []) {
    if (!log.beneficiary_id) continue;
    const { response } = fakeResponse();
    try {
      await settleCommissionCore(admin, response, {
        id: log.id,
        user_id: log.beneficiary_id,
        buyer_id: log.buyer_id ?? null,
        bonus_type: log.bonus_type ?? null,
        amount: Number(log.commission_amount),
        asset_id: log.asset_id ?? null,
        transaction_type: log.transaction_type,
      });
    } catch (error) {
      await recordSystemError("commission_immediate_settlement", errMsg(error), { commission_id: log.id })
        .catch((notificationError) => console.error("[telegram] Commission settlement alert failed", notificationError instanceof Error ? notificationError.message : "unknown error"));
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
 * 沖正後 owed == paid、diff 歸零，重複點擊會重算為 0 並自動略過（天然冪等）。*/
async function reverseCommissionForBeneficiary(
  admin: SupabaseClient,
  beneficiaryId: string,
): Promise<ReversalResult> {
  // 「應派發」必須與 admin_commission_discrepancies RPC 完全相同：不篩 bonus_type
  // （舊的 personal 等類型一樣算），否則列表有差額、這裡卻重算成 0 而永遠沖不掉。
  const [owedResult, paidResult] = await Promise.all([
    admin
      .from("commission_logs")
      .select("commission_amount")
      .eq("beneficiary_id", beneficiaryId)
      .not("paid_at", "is", null),
    admin
      .from("jc_ledger")
      .select("amount,entry_type,metadata")
      .eq("user_id", beneficiaryId)
      .in("entry_type", ["commission_payout", "commission_reversal"]),
  ]);
  if (owedResult.error) throw new Error(`讀取應派發分潤失敗：${owedResult.error.message}`);
  if (paidResult.error) throw new Error(`讀取實際入帳失敗：${paidResult.error.message}`);
  const owed = (owedResult.data ?? []).reduce((sum, r) => sum + Number(r.commission_amount), 0);
  const paidRows = paidResult.data ?? [];
  const paid = paidRows.reduce((sum, r) => sum + Number(r.amount), 0);
  // 先前「多發」沖正只扣站內帳本、從未動鏈上；若之後發現扣錯，要先把這部分還給站內帳本，
  // 不能再上鏈補發一次（鏈上早就付過了）。
  const metaKind = (r: { metadata: unknown }) =>
    (r.metadata as { kind?: string } | null)?.kind;
  const overDeducted = paidRows
    .filter((r) => r.entry_type === "commission_reversal" && metaKind(r) === "over")
    .reduce((sum, r) => sum + -Number(r.amount), 0);
  const alreadyRestored = paidRows
    .filter((r) => r.entry_type === "commission_reversal" && metaKind(r) === "restore")
    .reduce((sum, r) => sum + Number(r.amount), 0);
  const restorable = Math.max(0, Math.round((overDeducted - alreadyRestored) * 1e6) / 1e6);
  const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
  const diff = round6(paid - owed);
  if (Math.abs(diff) <= 1e-6) {
    return { beneficiaryId, applied: false, direction: "none", amount: 0 };
  }
  if (diff < 0) {
    // 少發：補足 (owed - paid)，並實際上鏈把 JC 從 ADMIN 熱錢包補發給受益人。
    let shortfall = round6(owed - paid);
    const restoreAmount = Math.min(shortfall, restorable);
    if (restoreAmount > 1e-6) {
      const { error: restoreError } = await admin.from("jc_ledger").insert({
        user_id: beneficiaryId,
        entry_type: "commission_reversal",
        amount: restoreAmount,
        idempotency_key: `commission-reverse:${beneficiaryId}:restore:${Date.now()}`,
        metadata: { kind: "restore", reason: "還原先前錯誤的站內扣回（鏈上已實際派發，不重複上鏈）" },
      });
      if (restoreError) throw new Error(`還原站內扣款失敗：${restoreError.message}`);
      shortfall = round6(shortfall - restoreAmount);
      if (shortfall <= 1e-6) {
        return { beneficiaryId, applied: true, direction: "under", amount: restoreAmount };
      }
    }
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
  // 多發：以負向沖正校正站內帳本（不上鏈，鏈上��發的 JC 無法自動回收）。
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

/** 全站待派發分潤（commission_logs.paid_at 為 null）的即時上鏈補發由 cron 定期
 * 掃描、二級成交後即時觸發、以及後台一鍵派發共用。每筆冪等（onchain_settlements
 * ref_key `commission:<log_id>` + jc_ledger `commission-payout:<log_id>`），受益人
 * 尚未綁定錢包者會被跳過、留待其綁定後下次掃描補上。limit 控制單次處理筆數，避免
 * 單一請求跑太久（其餘留待下一輪 cron）。*/
export async function sweepPendingCommissions(
  admin: SupabaseClient,
  limit = 100,
  beneficiaryIds?: string[],
): Promise<{ scanned: number; settled: number; skipped: number }> {
  let query = admin
    .from("commission_logs")
.select("id,beneficiary_id,buyer_id,commission_amount,asset_id,transaction_type,bonus_type")
    .in("bonus_type", ["l1", "l2", "self_rebate"])
    .is("paid_at", null)
  .not("beneficiary_id", "is", null)
    .gt("commission_amount", 0);
  if (beneficiaryIds && beneficiaryIds.length > 0) {
    query = query.in("beneficiary_id", beneficiaryIds);
  }
  const { data: logs, error: queryError } = await query.order("created_at", { ascending: true }).limit(limit);
  if (queryError) throw new Error(`讀取待派發分潤失敗：${queryError.message}`);
  let settled = 0;
  let skipped = 0;
  const unexpectedFailures: string[] = [];
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
        buyer_id: log.buyer_id ?? null,
        bonus_type: log.bonus_type ?? null,
        amount: Number(log.commission_amount),
        asset_id: log.asset_id ?? null,
        transaction_type: log.transaction_type,
      });
      const { body } = read();
      if (body && typeof body === "object" && (body as { status?: unknown }).status === "confirmed") settled += 1;
      else skipped += 1;
    } catch (error) {
      skipped += 1;
      unexpectedFailures.push(errMsg(error));
    }
  }
  if (unexpectedFailures.length) {
    await recordSystemError("commission_settlement_sweep", unexpectedFailures.slice(0, 10).join(" | "), {
      failed_count: unexpectedFailures.length,
      scanned_count: logs?.length ?? 0,
    });
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

  let body: { action?: string; requestKey?: string; orderId?: string; placementId?: string; beneficiaryIds?: string[]; assetKey?: string; expectedAmount?: string; txHash?: string; eventId?: string; feeBps?: number | string; listingFee?: string };
  try {
    body = await readBody(request);
  } catch {
    return json(response, 400, { error: "Invalid request body" });
  }
  const action = body.action;
  if (!action) return json(response, 400, { error: "缺少 action" });
  const readOnlyActions = new Set(["settlement-status", "admin-vault-status", "admin-preflight", "admin-list-settlements", "admin-list-escrow-events", "admin-escrow-status", "admin-p2p-fees", "safe-status"]);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await loadActiveSafeVault(admin);

  const maintenance = await readMaintenanceState(admin);
  if (maintenance.enabled && !readOnlyActions.has(action)) {
    return json(response, 503, { error: "平台目前處於維護模式，新的資金操作暫停；既有待處理結算會繼續由背景流程補發。", code: "PLATFORM_MAINTENANCE" });
  }

  const { data: userData, error: userError } = await admin.auth.getUser(token);
  const caller = userData?.user;
  if (userError || !caller) return json(response, 401, { error: "登入憑證無效" });

  const { data: callerProfile } = await admin
    .from("profiles")
    .select("id,agency_role,role,wallet_address")
    .eq("id", caller.id)
    .maybeSingle();
  if (!callerProfile) return json(response, 403, { error: "找不到平台帳號" });

  if (action === "admin-preflight") {
    if (!isAdminProfile(callerProfile)) return json(response, 403, { error: "僅限管理員執行" });
    const settledValue = <T,>(result: PromiseSettledResult<T>) => (result.status === "fulfilled" ? result.value : null);
    const [jcVault, aeVault, hotWalletResult, pendingSettlements, pendingRedemptions] = await Promise.all([
      Promise.allSettled([getVaultStatus("jcToken")]).then(([result]) => result),
      Promise.allSettled([getVaultStatus("aeToken")]).then(([result]) => result),
      Promise.allSettled([getAdminWalletStatus()]).then(([result]) => result),
      admin.from("onchain_settlements").select("ref_key,status,error,updated_at").in("status", ["pending", "failed"]).order("updated_at", { ascending: false }).limit(50),
      admin.from("redemption_orders").select("id,status,jc_amount,usdt_amount,created_at").eq("status", "pending").order("created_at", { ascending: true }).limit(50),
    ]);
    const jcVaultStatus = settledValue(jcVault);
    const aeVaultStatus = settledValue(aeVault);
    const hotWallet = settledValue(hotWalletResult);
    const serializeVault = (status: typeof jcVaultStatus) =>
      status ? { token: status.token, tokenAddress: status.tokenAddress, balanceFormatted: status.balanceFormatted, low: status.low } : null;
    const vault = { jc: serializeVault(jcVaultStatus), ae: serializeVault(aeVaultStatus) };
    const checks = {
      supabase: true,
      adminPrivateKey: Boolean(process.env.ADMIN_PRIVATE_KEY),
      telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      contracts: Object.fromEntries(Object.entries(RELAYER_ADDRESSES).map(([key, value]) => [key, Boolean(value)])),
      vault,
      hotWallet,
      pendingSettlements: pendingSettlements.data ?? [],
      pendingRedemptions: pendingRedemptions.data ?? [],
      maintenanceMode: maintenance.enabled,
      maintenanceReason: maintenance.reason,
      cronSecret: Boolean(process.env.CRON_SECRET),
      telegramOps: Boolean(process.env.TELEGRAM_OPS_BOT_TOKEN && process.env.TELEGRAM_OPS_CHAT_ID),
    };
    const warnings = [
      !process.env.TELEGRAM_BOT_TOKEN ? "缺少 Telegram Bot 設定" : null,
      !(process.env.TELEGRAM_OPS_BOT_TOKEN && process.env.TELEGRAM_OPS_CHAT_ID) ? "缺少營運 Telegram 告警設定" : null,
      !process.env.CRON_SECRET ? "尚未設定 CRON_SECRET（自動補發排程未驗證來源）" : null,
      maintenance.enabled ? "平台目前處於維護模式（新資金操作已暫停）" : null,
      hotWallet?.gasLow ? "ADMIN 熱錢包 Gas 偏低" : null,
      !hotWallet || !jcVaultStatus || !aeVaultStatus ? "鏈上餘額讀取失敗（RPC 節點暫時無回應），請稍後重新整理" : null,
      (pendingSettlements.data?.length ?? 0) > 0 ? "存在待處理或失敗鏈上結算" : null,
      (pendingRedemptions.data?.length ?? 0) > 0 ? "存在待審核 USDT 贖回" : null,
    ].filter((item): item is string => Boolean(item));
    return json(response, 200, { ok: warnings.length === 0, checks, warnings, generatedAt: new Date().toISOString() });
  }

  if (action === "town-ae-payout") {
    const input = body as { roundId?: number; houseIndex?: number };
    const roundId = Number(input.roundId);
    const houseIndex = Number(input.houseIndex);
    if (!Number.isSafeInteger(roundId) || !Number.isSafeInteger(houseIndex) || houseIndex < 0) {
      return json(response, 400, { error: "小鎮派發參數無效" });
    }
    const { data: opened, error: openedError } = await admin
      .from("rwmt_town_opens")
      .select("id,user_id,round_id,house_index,result,prize_status,ae_tx_hash")
      .eq("round_id", roundId).eq("house_index", houseIndex).eq("user_id", caller.id).maybeSingle();
    if (openedError) return json(response, 500, { error: `小鎮中獎紀錄讀取失敗：${openedError.message}` });
    if (!opened || opened.result !== "ae") return json(response, 404, { error: "找不到本人 AE 中獎紀錄" });
    if (opened.prize_status === "paid") return json(response, 200, { status: "paid", duplicate: true });

    const wallet = callerProfile.wallet_address?.trim();
    if (!wallet) return json(response, 409, { error: "帳號尚未綁定鏈上錢包，AE 暫時無法發放" });
    try {
      const txHash = await mintAe(getAddress(wallet), 1);
      const { error: paidError } = await admin.from("rwmt_town_opens").update({ prize_status: "paid", ae_tx_hash: txHash, ae_paid_at: new Date().toISOString() }).eq("id", opened.id).eq("prize_status", "pending");
      if (paidError) throw paidError;
  const { data: round } = await admin.from("rwmt_town_rounds").select("round_no,ae_remaining").eq("id", roundId).maybeSingle();
  const foundTitle = "🚨 AE 找到了！";
  const foundBody = `第 ${round?.round_no ?? roundId} 輪・第 ${houseIndex + 1} 棟\n已由熱錢包發放 1 AE\n交易：${txHash}`;
  await notifyTelegramPreferenceGroup(admin, "admin_direct", `rwmt-town-ae-found:${opened.id}`, foundTitle, foundBody);
  await sendTelegramMessage(`${foundTitle}\n${foundBody}`);
  if (round?.ae_remaining === 0) {
    const completeTitle = "🚨 本輪 AE 已全部找完！";
    const completeBody = `第 ${round.round_no} 輪已完成，所有 AE 均已由熱錢包發放。`;
    await notifyTelegramPreferenceGroup(admin, "admin_direct", `rwmt-town-round-complete:${roundId}`, completeTitle, completeBody);
    await sendTelegramMessage(`${completeTitle}\n${completeBody}`);
  }
      return json(response, 200, { status: "paid", txHash });
    } catch (error) {
      return json(response, 502, { error: `AE 熱錢包發放失敗：${errMsg(error)}` });
    }
  }

  if (action === "town-round-notification") {
    if (!isAdminProfile(callerProfile)) return json(response, 403, { error: "僅限管理員執行" });
    const input = body as { roundNo?: number; aeTotal?: number; bombTotal?: number };
  const roundNo = Number(input.roundNo) || "?";
  const aeTotal = Number(input.aeTotal) || 0;
  const bombTotal = Number(input.bombTotal) || 0;
  const title = "🚨 RWMT 小鎮淘金賽新一輪開啟！";
  const body = `第 ${roundNo} 輪\nAE：${aeTotal} 顆\n炸彈：${bombTotal} 顆`;
  const delivery = await notifyTelegramPreferenceGroup(admin, "admin_direct", `rwmt-town-round-start:${roundNo}`, title, body);
  await sendTelegramMessage(`${title}\n${body}`);
  return json(response, 200, { sent: true, delivery });
  }

  // 寫入型 relayer 請求順手觸發一次機會式自動補發。唯讀回收清單不觸發額外鏈上寫入。
  if (action === "legacy-reclaim-list" || action === "legacy-reclaim") {
    return json(response, 410, { error: "舊資產查詢介面已停用" });
  }
  if (action === "wire-contracts") {
    return json(response, 410, { error: "此設定已停用，RWA 使用目前 Factory" });
  }
  if (action === "settlement-status") {
    let requestKey = typeof body.requestKey === "string" ? body.requestKey : null;
    let orderId = typeof body.orderId === "string" ? body.orderId : null;
    let reservation: {
      request_key: string;
      action: string;
      user_id: string;
      status: string;
      source_tx_hash: string | null;
      chain_payload: Record<string, unknown> | null;
    } | null = null;

    if (orderId) {
      const { data: order, error } = await admin
        .from("redemption_orders")
        .select("id,user_id,idempotency_key")
        .eq("id", orderId)
        .maybeSingle();
      if (error) return json(response, 500, { error: "暫時無法讀取贖回狀態" });
      if (!order || order.user_id !== caller.id) return json(response, 404, { error: "找不到本人贖回狀態" });
      requestKey = order.idempotency_key;
      orderId = order.id;
    }
    if (!requestKey) return json(response, 400, { error: "缺少 requestKey 或 orderId" });

    const { data: foundReservation, error: reservationError } = await admin
      .from("settlement_reservations")
      .select("request_key,action,user_id,status,source_tx_hash,chain_payload")
      .eq("request_key", requestKey)
      .maybeSingle();
    if (reservationError) return json(response, 500, { error: "暫時無法讀取交易預留狀態" });
    if (!foundReservation || foundReservation.user_id !== caller.id) {
      return json(response, 404, { error: "找不到本人交易預留狀態" });
    }
    reservation = foundReservation;
    const payload = reservation.chain_payload && typeof reservation.chain_payload === "object"
      ? reservation.chain_payload
      : {};
    const reservationOrderId = orderId ?? (typeof payload.order_id === "string" ? payload.order_id : null);
    const refKey = reservation.action === "vault_buy"
      ? `mint_jc:${requestKey}`
      : reservation.action === "subscribe"
        ? `subscribe:${requestKey}`
        : reservation.action === "redeem" && reservationOrderId
          ? `redeem:${reservationOrderId}`
          : null;
    const { data: settlement, error: settlementError } = refKey
      ? await admin.from("onchain_settlements")
          .select("status,tx_hash,error,payload")
          .eq("ref_key", refKey)
          .maybeSingle()
      : { data: null, error: null };
    if (settlementError) return json(response, 500, { error: "暫時無法讀取鏈上交割狀態" });

    const status = reservation.status === "confirmed" && settlement?.status === "confirmed"
      ? "confirmed"
      : reservation.status === "released"
        ? "released"
        : "pending";
    const settlementPayload = settlement?.payload && typeof settlement.payload === "object"
      ? settlement.payload as Record<string, unknown>
      : {};
    return json(response, 200, {
      status,
      request_key: requestKey,
      tx_hash: settlement?.tx_hash ?? settlementPayload.assetTransferTx ?? settlementPayload.mintTx ?? null,
      source_tx_hash: reservation.source_tx_hash,
      error: settlement?.error ?? null,
    });
  }
      const escrowActions = new Set([
        "register-escrow-order",
        "settle-escrow-fill",
        "register-escrow-cancel",
        "admin-escrow-status",
        "admin-retry-escrow-event",
        "admin-p2p-fees",
        "admin-set-p2p-fees",
      ]);
      if (!escrowActions.has(action)) await maybeOpportunisticSweep(admin);

      try {
        if (action === "register-escrow-order") {
          if (!body.txHash) return json(response, 400, { error: "缺少掛單交易雜湊" });
          const result = await processEscrowOrderCreated(admin, body.txHash, callerProfile);
          return json(response, 200, result);
        }
        if (action === "settle-escrow-fill") {
          if (!body.txHash) return json(response, 400, { error: "缺少成交交易雜湊" });
          const result = await processEscrowFill(admin, body.txHash, callerProfile);
          return json(response, 200, result);
        }
        if (action === "register-escrow-cancel") {
          if (!body.txHash) return json(response, 400, { error: "缺少取消交易雜湊" });
          const result = await processEscrowCancel(admin, body.txHash, callerProfile);
          return json(response, 200, result);
        }
        if (action === "admin-escrow-status") {
          if (!isAdminProfile(callerProfile)) return json(response, 403, { error: "僅限管理員執行" });
          const [ordersResult, legacyResult, eventsResult, auditResult] = await Promise.all([
            admin.from("p2p_orders")
              .select("id,asset_id,side,price,remaining_quantity,escrow_locked_currency,escrow_chain_order_id,escrow_contract_address,escrow_token_address,escrow_currency_address")
              .eq("escrow_mode", "escrow")
              .in("escrow_contract_address", P2P_ESCROW_KNOWN_ADDRESSES.map((address) => address.toLowerCase()))
              .in("status", ["open", "partially_filled"]),
            admin.from("p2p_orders").select("id", { count: "exact", head: true })
              .eq("escrow_mode", "legacy").in("status", ["open", "partially_filled"]),
            admin.from("p2p_escrow_events")
              .select("tx_hash,event_type,status,error,user_id,created_at")
              .in("status", ["pending", "failed"])
              .order("created_at", { ascending: false })
              .limit(50),
            admin.from("p2p_escrow_cutover_audit").select("order_id", { count: "exact", head: true }),
          ]);
          const error = ordersResult.error ?? legacyResult.error ?? eventsResult.error ?? auditResult.error;
          if (error) return json(response, 500, { error: `託管稽核資料讀取失敗：${error.message}` });
          const orders = ordersResult.data ?? [];
          const expected = new Map<string, { escrow: string; token: string; amount: number }>();
          for (const order of orders) {
            const token = order.side === "sell" ? order.escrow_token_address : order.escrow_currency_address;
            if (!token || !order.escrow_contract_address) continue;
            const amount = order.side === "sell"
              ? Number(order.remaining_quantity)
              : Number(order.escrow_locked_currency ?? Number(order.price) * Number(order.remaining_quantity));
            const key = `${order.escrow_contract_address.toLowerCase()}:${token.toLowerCase()}`;
            const entry = expected.get(key) ?? { escrow: order.escrow_contract_address.toLowerCase(), token: token.toLowerCase(), amount: 0 };
            entry.amount += amount;
            expected.set(key, entry);
          }
          const lockedBalances = await Promise.all([...expected.values()].map(async ({ escrow, token, amount: databaseAmount }) => {
            const address = toAddress(token, "託管代幣");
            const escrowAddress = toAddress(escrow, "託管合約");
            const legacy = escrowAddress.toLowerCase() !== p2pEscrowAddress().toLowerCase();
            try {
              const locked = await getP2PEscrowLocked(address, escrowAddress);
              return { token: address, escrow: escrowAddress, legacy, databaseAmount, chainAmount: Number(formatUnits(locked, 18)), error: null };
            } catch (error) {
              return { token: address, escrow: escrowAddress, legacy, databaseAmount, chainAmount: null, error: errMsg(error) };
            }
          }));
          return json(response, 200, {
            configured: Boolean(P2P_ESCROW_ADDRESS),
            activeEscrowOrders: orders.length,
            activeLegacyOrders: legacyResult.count ?? 0,
            pendingEvents: eventsResult.data?.length ?? 0,
            cancelledLegacyOrders: auditResult.count ?? 0,
            lockedBalances,
            events: eventsResult.data ?? [],
          });
        }
        if (action === "admin-retry-escrow-event") {
          if (!isAdminProfile(callerProfile)) return json(response, 403, { error: "僅限管理員執行" });
          const eventId = body.eventId?.trim();
          if (!eventId) return json(response, 400, { error: "缺少託管事件識別碼" });
          const { data: event, error } = await admin.from("p2p_escrow_events")
            .select("tx_hash,event_type,status")
            .eq("tx_hash", eventId)
            .maybeSingle();
          if (error || !event) return json(response, 404, { error: "找不到待修復的託管事件" });
          if (event.status === "finalized") return json(response, 200, { status: "finalized", idempotent: true });
          // 只有已記錄在 p2p_escrow_events 的舊掛單才走這裡，所以放寬到已知舊託管合約是安全的。
          const result = event.event_type === "order_created"
            ? await processEscrowOrderCreated(admin, event.tx_hash, null, { allowLegacyCreate: true })
            : event.event_type === "order_filled"
              ? await processEscrowFill(admin, event.tx_hash, null)
              : await processEscrowCancel(admin, event.tx_hash, null);
          return json(response, 200, result);
        }
        if (action === "admin-p2p-fees" || action === "admin-set-p2p-fees") {
          if (!isAdminProfile(callerProfile)) return json(response, 403, { error: "僅限管理員執行" });
          if (action === "admin-set-p2p-fees") {
            const feeBps = Number(body.feeBps);
            const listingFee = String(body.listingFee ?? "").trim();
            if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 500) {
              return json(response, 400, { error: "成交手續費需介於 0%～5%，最小單位 0.01%" });
            }
            if (!/^\d+(\.\d{1,6})?$/.test(listingFee) || Number(listingFee) > 10) {
              return json(response, 400, { error: "掛單費需介於 0～10 JC，最多 6 位小數" });
            }
            const proposal = await createSafeProposal(admin, {
              kind: "p2p_fees",
              params: { feeBps, listingFee },
              summary: `二級成交費 ${(feeBps / 100).toFixed(2)}%、掛單費 ${listingFee} JC`,
              calls: [safeCalls.p2pFees(feeBps, listingFee)],
              createdBy: caller.id,
            });
            return json(response, 200, { ok: true, proposal, pendingSafe: true });
          }
          const [chain, config, legacyOpen] = await Promise.all([
            getP2PEscrowFees(),
            admin.from("platform_config").select("p2p_fee_bps,p2p_listing_fee,p2p_fees_updated_at").limit(1).maybeSingle(),
            admin.from("p2p_orders").select("id", { count: "exact", head: true })
              .eq("escrow_mode", "escrow")
              .in("escrow_contract_address", P2P_ESCROW_KNOWN_ADDRESSES.filter((address) => !isCurrentEscrow(address)).map((address) => address.toLowerCase()))
              .in("status", ["open", "partially_filled"]),
          ]);
          if (config.error) return json(response, 500, { error: `費率設定讀取失敗：${config.error.message}` });
          return json(response, 200, {
            escrow: p2pEscrowAddress(),
            chain,
            config: config.data,
            inSync: Boolean(config.data) && Number(config.data?.p2p_fee_bps) === chain.feeBps
              && Math.abs(Number(config.data?.p2p_listing_fee) - chain.listingFee) < 1e-9,
            legacyOpenOrders: legacyOpen.count ?? 0,
          });
        }

    // ---- 一次性：把子合約位址寫進 RWA 母合約（僅限管理員）----
    if (action === "wire-contracts") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      if (IS_MAINNET) return json(response, 400, { error: "主網沒有 RWA 母合約，不需要初始化" });
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

  // ---- 管理員：價格調整通知。價格已由管理員 RPC 先完成寫入，這裡只負責冪等播報。----
  if (action === "admin-price-change-notification") {
    if (!isAdminProfile(callerProfile)) return json(response, 403, { error: "僅限管理員執行" });
    const placementId = body.placementId?.trim();
    const oldPrice = Number(body.oldPrice);
    const newPrice = Number(body.newPrice);
    if (!placementId || !Number.isFinite(oldPrice) || !Number.isFinite(newPrice) || oldPrice <= 0 || newPrice <= 0 || oldPrice === newPrice) {
      return json(response, 400, { error: "價格通知資料無效" });
    }
    const { data: placement, error: placementError } = await admin
      .from("private_placements")
      .select("id,name,price,is_ae_token,ae_token_kind")
      .eq("id", placementId)
      .maybeSingle();
    if (placementError) throw placementError;
    if (!placement || Math.abs(Number(placement.price) - newPrice) > 0.000001) {
      return json(response, 409, { error: "標的目前價格與通知價格不一致，未發送通知" });
    }
    if (placement.is_ae_token && placement.ae_token_kind === "bonus") {
      return json(response, 409, { error: "獎勵輪次不發送價格通知" });
    }
    const assetName = String(placement.name ?? body.assetName ?? placementId);
    const typeLabel = placement.is_ae_token ? "AE 認購" : "RWA 二級市場";
    const direction = newPrice > oldPrice ? "上調" : "下調";
    const eventKey = `price-change:${placementId}:${newPrice}`;
    const result = await notifyTelegramPreferenceGroup(
      admin,
      "market_alert",
      eventKey,
      `${typeLabel}價格${direction}`,
      `${assetName} 價格已由 ${oldPrice} JC 調整為 ${newPrice} JC。請以平台最新價格為準。`,
    );
    return json(response, 200, { ok: true, ...result });
  }

  // ---- AE 獎勵售罄後，只發一般日價格通知，不揭露獎勵狀態。----
  if (action === "bonus-sold-out-notification") {
    const placementId = body.placementId?.trim();
    if (!placementId) return json(response, 400, { error: "缺少標的" });
    const { data: placement, error } = await admin.from("private_placements").select("id,name,price,available,ae_token_kind,bonus_normal_price,release_frozen_at").eq("id", placementId).maybeSingle();
    if (error) throw error;
    if (!placement || placement.ae_token_kind !== "bonus" || Number(placement.available) !== 0 || Number(placement.bonus_normal_price) <= 0) {
      return json(response, 409, { error: "獎勵尚未售罄或平常日價格無效，未發送通知" });
    }
    // 已結束（清倉中）的回合在結束當下就已由資料庫套用平常日價格；售罄時不再覆蓋，避免蓋掉管理員之後的調價。
    if (placement.release_frozen_at) {
      return json(response, 200, { ok: true, skipped: "already_ended" });
    }
    const { error: dailyPriceError } = await admin.from("private_placements").update({ price: Number(placement.bonus_normal_price), updated_at: new Date().toISOString() }).eq("id", "ae-token-daily").eq("is_ae_token", true);
    if (dailyPriceError) throw dailyPriceError;
    const result = await notifyTelegramPreferenceGroup(admin, "market_alert", `bonus-normal-price:${placementId}:${placement.bonus_normal_price}`, "AE 平常日認購價格", `AE 平常日認購價格已調整為：${Number(placement.bonus_normal_price)} JC。請以平台最新價格為準。`);
    return json(response, 200, { ok: true, ...result });
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
        return json(response, 409, { error: "回收識別碼不一致，請聯繫客服" });
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
            .update({ status: "failed", error: "回收請求逾時、未送出鏈上交易，可安全重試", updated_at: new Date().toISOString() })
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
          } catch (error) {
            await recordSystemError("onchain_reclaim_receipt", errMsg(error), { tx_hash: settlement.tx_hash });
            return json(response, 202, { status: "pending", txHash: settlement.tx_hash, amount: String(settlement.amount ?? "0") });
          }
        }
      }

      const candidates = await readLegacyReclaimCandidates(admin, caller.id, wallet);
      const candidate = candidates.find((item) => item.assetKey === assetKey);
      if (!candidate || candidate.status !== "ready" || !candidate.tokenAddress || candidate.decimals == null) {
        return json(response, 409, { error: "目前沒有可回收的 JC 持倉，或鏈上餘額／今日保留額已變動，請重新整理" });
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
        return json(response, 503, { status: "pending", txHash, error: "交易已送出但回收紀錄尚未同步，請稍後重新整理並聯繫客服提供交易雜湊" });
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
      } catch (error) {
        await recordSystemError("onchain_reclaim_confirmation", errMsg(error), { tx_hash: txHash });
        return json(response, 202, { status: "pending", txHash, amount: candidate.amount });
      }
    }

    // ---- 回傳 ADMIN 熱錢包地址。僅需登入即可查詢，不含任何機密。----
    if (action === "relayer-address") {
      return json(response, 200, { address: relayerAddress() });
    }

    // ---- 認購前以鏈上熱錢包餘���檢查可發放庫存；RWA 同步原子收斂 DB 可售量，
    // 使後續既有認購 RPC 的列鎖能保護並發下單不超過已備貨數量。----
    if (action === "check-subscription-stock") {
      const input = body as { placementId?: string; quantity?: number };
      const placementId = input.placementId?.trim();
      const quantity = Number(input.quantity);
      if (!placementId || !Number.isSafeInteger(quantity) || quantity <= 0) {
        return json(response, 400, { error: "認購標的或份額數量無效" });
      }
      const { data: placement, error: placementError } = await admin
        .from("private_placements")
        .select("id,is_ae_token,is_active,is_delisted")
        .eq("id", placementId)
        .maybeSingle();
      if (placementError) throw new Error(`讀取認購標的失敗：${placementError.message}`);
      if (!placement || placement.is_delisted || placement.is_active === false) {
        return json(response, 409, { error: "此標的目前未開放認購，尚未扣除 JC" });
      }

      let balance: bigint;
      let decimals: number;
      let available: bigint | null = null;
      if (placement.is_ae_token) {
        const stock = await getVaultStatus("aeToken");
        balance = stock.balance;
        decimals = stock.decimals;
      } else {
        const tokenAddress = await getCurrentRwaFactoryToken(placement.id);
        if (!tokenAddress) {
          return json(response, 409, { error: "此 RWA 尚未建立專屬代幣，尚未扣除 JC" });
        }
        const stock = await getHotWalletShareBalance(tokenAddress);
        balance = parseUnits(stock.balanceFormatted, stock.decimals);
        decimals = stock.decimals;
        const { data: cappedAvailable, error: capError } = await admin.rpc(
          "admin_cap_rwa_placement_available",
          {
            p_placement_id: placement.id,
            p_chain_quantity: stock.balanceFormatted,
          },
        );
        if (capError) throw new Error(`同步 RWA 可售庫存失敗：${capError.message}`);
        available = parseUnits(String(cappedAvailable), decimals);
      }

      const required = parseUnits(String(quantity), decimals);
      if (balance < required) {
        return json(response, 409, {
          error: `熱錢包目前只有 ${formatUnits(balance, decimals)} 份，低於本次所需 ${quantity} 份；認購尚未扣除 JC。請聯繫管理員補足後再試。`,
        });
      }
      if (available !== null && available < required) {
        return json(response, 409, {
          error: `目前可認購庫存為 ${formatUnits(available, decimals)} 份，低於本次所需 ${quantity} 份；認購尚未扣除 JC。`,
        });
      }
      return json(response, 200, { available: formatUnits(balance, decimals) });
    }

    // ---- 管理員唯讀診斷：ADMIN 熱錢包目前持有的 JC/AE 庫存。純讀取，不做
    // 任何鏈上寫入，用來確認「是否需要人工從 Safe 金庫轉帳補貨」。----
    if (action === "admin-vault-status") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const [hotWallet, jc, ae] = await Promise.all([
        getAdminWalletStatus(),
        getVaultStatus("jcToken"),
        getVaultStatus("aeToken"),
      ]);
      const serialize = (s: Awaited<ReturnType<typeof getVaultStatus>>) => ({
        token: s.token,
        balance: s.balanceFormatted,
        low: s.low,
      });
      // RWA 標的：只列上架中（is_active 且未下架）、非 AE、且已部署專屬代幣的標的，
      // 逐一讀 ADMIN 熱錢包在該份額代幣的鏈上餘額。下架標的一律排除。
      const { data: rwaPlacements } = await admin
        .from("private_placements")
        .select("id,name,token_address")
        .eq("is_ae_token", false)
        .eq("is_active", true)
        .eq("is_delisted", false);
      const rwa = (
        await Promise.all(
          (rwaPlacements ?? []).map(async (placement) => {
            try {
              const tokenAddress = await getCurrentRwaFactoryToken(placement.id);
              if (!tokenAddress) return null;
              const s = await getHotWalletShareBalance(tokenAddress);
              return { name: String(placement.name ?? ""), balance: s.balanceFormatted, tokenAddress };
            } catch (error) {
              await recordSystemError("hot_wallet_rwa_balance", errMsg(error), { placement_id: placement.id })
                .catch((notificationError) => console.error("[telegram] RWA balance alert failed", notificationError instanceof Error ? notificationError.message : "unknown error"));
              return null;
            }
          }),
        )
      ).filter((x): x is { name: string; balance: string } => x != null);
      return json(response, 200, { hotWallet, jc: serialize(jc), ae: serialize(ae), rwa });
    }

    if (typeof action === "string" && action.startsWith("safe-")) {
      if (!isAdminProfile(callerProfile)) return json(response, 403, { error: "僅限管理員執行" });
      const input = body as { proposalId?: string; signature?: string; target?: string; owners?: string[]; threshold?: number };
      try {
        if (action === "safe-status") {
          const [status, proposals] = await Promise.all([safeGovernanceStatus(), listSafeProposals(admin)]);
          return json(response, 200, { ...status, proposals });
        }
        if (action === "safe-handoff") {
          const target = input.target === "jc" || input.target === "ae" || input.target === "rwaFactory" ? input.target : null;
          if (!target) return json(response, 400, { error: "target 必須是 jc、ae 或 rwaFactory" });
          const result = await handOwnershipToSafe(target, sendAdminRawCall);
          await sendTelegramMessage(`🔐 合約管理權已移交 Safe：${target}${result.txHash ? `\ntx：${result.txHash}` : "（原本即為 Safe）"}`).catch(() => undefined);
          return json(response, 200, result);
        }
        if (action === "safe-propose-accept") {
          const { safe, targets, calls } = await buildAcceptOwnershipCalls();
          const proposal = await createSafeProposal(admin, {
            kind: "accept_ownership",
            params: { targets: targets.map((target) => ({ key: target.key, label: target.label, address: target.address })) },
            summary: `新 Safe 接受管理權：${targets.map((target) => target.label).join("、")}`,
            calls,
            createdBy: caller.id,
            safe,
          });
          return json(response, 200, { proposal });
        }
        if (action === "safe-migrate-preview" || action === "safe-propose-migration") {
          const newSafe = String((body as { newSafe?: string }).newSafe ?? "").trim();
          if (!/^0x[0-9a-fA-F]{40}$/.test(newSafe)) return json(response, 400, { error: "請輸入有效的新 Safe 地址" });
          const { data: tokens } = await admin.from("private_placements").select("token_address").not("token_address", "is", null);
          const rwaTokens = (tokens ?? [])
            .map((row) => toFactoryTokenAddress(row.token_address))
            .filter((address): address is Address => Boolean(address));
          const plan = await buildSafeMigrationPlan(newSafe, [...new Set(rwaTokens.map((a) => a.toLowerCase()))].map((a) => getAddress(a)));
          const preview = {
            newSafe: plan.newSafe,
            newOwners: plan.newOwners,
            newThreshold: plan.newThreshold,
            steps: plan.steps,
            skipped: plan.skipped,
            needsAccept: plan.needsAccept,
          };
          if (action === "safe-migrate-preview") return json(response, 200, preview);
          if (plan.newThreshold < 2) {
            return json(response, 400, { error: "新 Safe 門檻至少要 2，避免單一 Ledger 遺失就失去全部權限" });
          }
          const proposal = await createSafeProposal(admin, {
            kind: "migrate_safe",
            params: preview,
            summary: `更換 Safe 為 ${plan.newSafe.slice(0, 6)}…${plan.newSafe.slice(-4)}（${plan.newThreshold}/${plan.newOwners.length}），共 ${plan.steps.length} 項`,
            calls: plan.calls,
            createdBy: caller.id,
          });
          return json(response, 200, { proposal, preview });
        }
        if (action === "safe-propose-owners") {
          const owners = Array.isArray(input.owners) ? input.owners : [];
          const threshold = Number(input.threshold);
          if (owners.length === 0) return json(response, 400, { error: "請輸入至少一個簽署人地址" });
          const status = await safeGovernanceStatus();
          const next = new Set(status.owners.map((o) => o.toLowerCase()));
          const additions: Address[] = [];
          for (const raw of owners) {
            const address = toAddress(raw, "簽署人");
            if (next.has(address.toLowerCase())) continue;
            next.add(address.toLowerCase());
            additions.push(address);
          }
          if (additions.length === 0) return json(response, 400, { error: "輸入的地址都已是簽署人" });
          if (!Number.isInteger(threshold) || threshold < 1 || threshold > next.size) {
            return json(response, 400, { error: `門檻需介於 1～${next.size}` });
          }
          const proposal = await createSafeProposal(admin, {
            kind: "add_owners",
            params: { additions, threshold },
            summary: `新增簽署人 ${additions.map((a) => `${a.slice(0, 6)}…${a.slice(-4)}`).join("、")}，門檻改為 ${threshold}/${next.size}`,
            calls: additions.map((address, index) => safeCalls.addOwner(address, index === additions.length - 1 ? threshold : 1)),
            createdBy: caller.id,
          });
          return json(response, 200, { proposal });
        }
        const proposalId = String(input.proposalId ?? "").trim();
        if (!/^[0-9a-f-]{36}$/i.test(proposalId)) return json(response, 400, { error: "提案編號無效" });
        if (action === "safe-sign") {
          if (!input.signature) return json(response, 400, { error: "缺少簽章" });
          return json(response, 200, { proposal: await signSafeProposal(admin, proposalId, input.signature) });
        }
        if (action === "safe-execute") return json(response, 200, { proposal: await executeSafeProposal(admin, proposalId) });
        if (action === "safe-refresh") return json(response, 200, { proposal: await refreshSafeProposal(admin, proposalId) });
        if (action === "safe-resync") return json(response, 200, { proposal: await resyncSafeProposal(admin, proposalId) });
        if (action === "safe-cancel") return json(response, 200, { proposal: await cancelSafeProposal(admin, proposalId) });
        return json(response, 400, { error: "未知的 Safe 動作" });
      } catch (e) {
        return json(response, 502, { error: errMsg(e) });
      }
    }

    // 管理員銷毀未售出的 Safe 金庫庫存；來源地址固定於合約，不接受任意 holder。
    if (action === "admin-burn-inventory") {
      if (!isAdminProfile(callerProfile)) return json(response, 403, { error: "僅限管理員執行" });
      const input = body as { token?: string; amount?: number; placementId?: string };
      const token = input.token === "jc" || input.token === "ae" || input.token === "rwa" ? input.token : null;
      if (!token) return json(response, 400, { error: "token 必須是 jc、ae 或 rwa" });
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount <= 0) return json(response, 400, { error: "銷毀數量必須是大於 0 的數字" });
      let tokenAddress: Address | undefined;
      try {
        if (token === "rwa") {
          if (!input.placementId) return json(response, 400, { error: "請選擇 RWA 標的" });
          const { data: placement, error: placementError } = await admin
            .from("private_placements")
            .select("id,is_ae_token")
            .eq("id", input.placementId)
            .eq("is_ae_token", false)
            .maybeSingle();
          if (placementError) throw new Error(`讀取 RWA 標的失敗：${placementError.message}`);
          if (!placement) return json(response, 404, { error: "找不到此 RWA 標的" });
          tokenAddress = (await getCurrentRwaFactoryToken(placement.id)) ?? undefined;
          if (!tokenAddress) return json(response, 404, { error: "此標的尚未在目前 Factory 建立代幣" });
        }
        const proposal = await createSafeProposal(admin, {
          kind: "burn",
          params: { token, amount, placementId: input.placementId ?? null },
          summary: `銷毀 Safe 金庫 ${amount} ${token.toUpperCase()}${token === "rwa" ? `（${input.placementId}）` : ""}`,
          calls: [await safeCalls.burn(token, amount, tokenAddress)],
          createdBy: caller.id,
        });
        return json(response, 200, { proposal, pendingSafe: true });
      } catch (e) {
        return json(response, 502, { error: errMsg(e) });
      }
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
      if (input.to && input.to.trim() && input.to.trim().toLowerCase() !== RELAYER_ADDRESSES.safeVault.toLowerCase()) {
        return json(response, 422, { error: "增發只能鑄給 Safe 金庫，再由 Safe 撥給熱錢包" });
      }
      try {
        const proposal = await createSafeProposal(admin, {
          kind: "mint",
          params: { token: input.token, amount },
          summary: `增發 ${amount} ${String(input.token).toUpperCase()} 至 Safe 金庫`,
          calls: [await safeCalls.mint(input.token as "jc" | "ae", amount)],
          createdBy: caller.id,
        });
        return json(response, 200, { proposal, pendingSafe: true });
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
      if (IS_MAINNET) return json(response, 400, { error: "主網 AE 合約沒有歸零收回功能" });
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
            .map((h) => {
              const profile = Array.isArray(h.profiles) ? h.profiles[0] : h.profiles;
              return profile?.wallet_address?.trim() ?? null;
            })
            .filter((w): w is string => !!w && /^0x[a-fA-F0-9]{40}$/.test(w)),
        ),
      );
      const calls: SafeCall[] = [];
      const failed: { wallet: string; error: string }[] = [];
      let total = 0;
      for (const w of wallets) {
        try {
          const wallet = getAddress(w);
          const balance = await getAeChainBalance(wallet);
          if (balance <= 0) continue;
          calls.push(await safeCalls.aeReclaim(wallet, balance));
          total += balance;
        } catch (e) {
          failed.push({ wallet: w, error: errMsg(e) });
        }
      }
      if (calls.length === 0) return json(response, 200, { reclaimed: [], failed, proposal: null });
      const proposal = await createSafeProposal(admin, {
        kind: "ae_reclaim",
        params: { holders: calls.length, total },
        summary: `AE 歸零：收回 ${calls.length} 個錢包共 ${total} AE 至 Safe`,
        calls,
        createdBy: caller.id,
      });
      return json(response, 200, { reclaimed: [], failed, proposal, pendingSafe: true });
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
        .select("id")
        .eq("id", placementId)
        .maybeSingle();
      if (pErr) throw new Error(`查詢標的失敗���${pErr.message}`);
      const tokenAddress = placement ? await getCurrentRwaFactoryToken(placement.id) : null;
      if (!tokenAddress) {
        return json(response, 200, { skipped: true, reason: "此標的在目前 Factory 無代幣" });
      }
      const { data: holders, error: holdErr } = await admin
        .from("holdings")
        .select("user_id, profiles!inner(wallet_address)")
        .eq("asset_id", placementId);
      if (holdErr) throw new Error(`查詢持有人失敗：${holdErr.message}`);
      const wallets = Array.from(
        new Set(
          (holders ?? [])
            .map((h) => {
              const profile = Array.isArray(h.profiles) ? h.profiles[0] : h.profiles;
              return profile?.wallet_address?.trim() ?? null;
            })
            .filter((w): w is string => !!w && /^0x[a-fA-F0-9]{40}$/.test(w)),
        ),
      );
      const calls: SafeCall[] = [];
      const failed: { wallet: string; error: string }[] = [];
      let total = 0;
      for (const w of wallets) {
        try {
          const wallet = getAddress(w);
          if (wallet.toLowerCase() === RELAYER_ADDRESSES.safeVault.toLowerCase()) continue;
          const { balance } = await getWalletShareBalance(tokenAddress, wallet);
          if (balance <= 0) continue;
          calls.push(safeCalls.rwaReclaim(getAddress(tokenAddress), wallet));
          total += balance;
        } catch (e) {
          failed.push({ wallet: w, error: errMsg(e) });
        }
      }
      if (calls.length === 0) return json(response, 200, { reclaimed: [], failed, proposal: null });
      const proposal = await createSafeProposal(admin, {
        kind: "rwa_reclaim",
        params: { placementId, holders: calls.length, total },
        summary: `RWA 下架收回（${placementId}）：${calls.length} 個錢包共 ${total} 份 → Safe`,
        calls,
        createdBy: caller.id,
      });
      return json(response, 200, { reclaimed: [], failed, proposal, pendingSafe: true });
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
      } catch (error) {
        await recordSystemError("admin_asset_payout_receipt", errMsg(error), { tx_hash: settlement.tx_hash });
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
          ? admin.from("private_placements").select("id,name,is_ae_token").in("id", placementIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (profilesResult.error || placementsResult.error) {
        return json(response, 500, { error: "派發紀錄關聯資料讀取失敗" });
      }
      const emailById = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile.email]));
      const placementById = new Map((placementsResult.data ?? []).map((placement) => [placement.id, placement.is_ae_token ? "AE" : placement.name]));
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
        assetLabel = "AE";
        ledgerAssetId = placement.id;
      } else if (assetType === "rwa") {
  const { data: placement } = await admin
    .from("private_placements")
    .select("id,name,is_ae_token")
    .eq("id", placementId)
    .maybeSingle();
  const rwaToken = placement && !placement.is_ae_token
    ? await getCurrentRwaFactoryToken(placement.id)
    : null;
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
        } catch (error) {
          await recordSystemError("admin_asset_payout_confirmation", errMsg(error), { tx_hash: settlement.tx_hash, asset_type: assetType });
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
        } catch (error) {
          await recordSystemError("admin_asset_payout_confirmation", errMsg(error), { tx_hash: txHash, asset_type: assetType });
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
        .select("id,name,token_name,token_symbol,token_decimals,total_supply,is_ae_token")
        .eq("id", placementId)
        .maybeSingle();
      if (!placement) return json(response, 404, { error: "找��到對應的標的" });
      if (placement.is_ae_token) return json(response, 422, { error: "AE 不使用 RWA Factory" });
      const existingAddr = await getCurrentRwaFactoryToken(placementId);
      if (existingAddr) {
        await admin.from("private_placements").update({ token_address: existingAddr }).eq("id", placementId);
        return json(response, 200, { tokenAddress: existingAddr, alreadyExisted: true });
      }
      const symbol = String(placement.token_symbol ?? "").trim();
      if (!symbol) return json(response, 422, { error: "請先在編輯器填寫並儲存「代幣符號（Token Symbol）」" });
      const name = String(placement.token_name ?? placement.name ?? "").trim();
      if (!name) return json(response, 422, { error: "請先在編輯器填寫並儲存「代幣名稱（Token Name）」" });
      const decimals = placement.token_decimals == null ? 18 : Number(placement.token_decimals);
      const totalSupply = Number(placement.total_supply);
      if (!(totalSupply > 0)) return json(response, 422, { error: "此標的的總供給量無效" });
      try {
        const proposal = await createSafeProposal(admin, {
          kind: "create_rwa_token",
          params: { placementId, name, symbol, decimals, totalSupply },
          summary: `建立 RWA 代幣 ${symbol}（${name}），${totalSupply} 份鑄給 Safe`,
          calls: [safeCalls.createRwaToken(placementId, name, symbol, decimals, totalSupply)],
          createdBy: caller.id,
        });
        return json(response, 200, { proposal, pendingSafe: true });
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
    const LEDGER_ANCHORED_ACTIONS = new Set(["mint-jc", "subscribe"]);
    const requestKey = body.requestKey;
    if (LEDGER_ANCHORED_ACTIONS.has(action) && (!requestKey || requestKey.length < 8)) {
      return json(response, 400, { error: "缺少有效的 requestKey" });
    }

    // ---- Gas 贊助：使用者簽 USDT 交易（金庫入金／提領）前，後端 ADMIN 幫「呼叫
    // ���本人」的錢包補一點 ETH 付 Gas，使全新錢包（ETH=0）也能自己簽名轉出自我保
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

    // ---- 持倉同步只接受 2026-10-04 11:57 後的現行合約。AE 使用目前 AE token，
    // RWA 使用目前 Factory 的 tokenByPlacement 結果，不使用資料庫殘留的舊 token_address。
    // holdings 會同步成錢包 balanceOf + 仍鎖在 escrow 的賣出數量，避免已鎖份額被
    // 重複扣除；鏈上可用額與收款錢包一律由後端從登入者 profile 推導。----
    if (action === "sync-jc-balance") {
      let wallet: Address;
      try {
        wallet = toAddress(callerProfile.wallet_address, "使用者帳號");
      } catch {
        return json(response, 400, { error: "找不到你的錢包地址，請重新登入" });
      }
      const chainBalance = await getJcChainBalance(wallet);
      const { data: reconciliation, error } = await admin.rpc("admin_sync_jc_chain_balance", {
        p_user_id: caller.id,
        p_wallet: wallet,
        p_chain_balance: chainBalance,
      });
      if (error) throw new Error(`同步新 JC 合約餘額失敗：${error.message}`);
      const result = reconciliation as { adjustment?: number; balance?: number } | null;
      return json(response, 200, {
        status: "confirmed",
        wallet,
        chainBalance: Number(chainBalance),
        adjustment: Number(result?.adjustment ?? 0),
      });
    }

    // 只使用新合約：AE 餘額讀取目前 AE ERC-20；RWA 必須由新 Factory 的
    // tokenByPlacement 找到代幣。持倉帳本同步成鏈上錢包餘額 + 目前 escrow 鎖定量，
    // 因此扣除掛單後的市場可用額會等於使用者當下可支配的鏈上份額。
    if (action === "sync-holding") {
      const placementId = (body as { placementId?: string }).placementId?.trim();
      if (!placementId) return json(response, 400, { error: "缺少 placementId" });

      const { data: placement, error: placementError } = await admin
        .from("private_placements")
        .select("id,is_ae_token")
        .eq("id", placementId)
        .maybeSingle();
      if (placementError) throw new Error(`查詢標的失敗：${placementError.message}`);
      if (!placement) return json(response, 404, { error: "找不到對應的標的" });

      let wallet: Address;
      try {
        wallet = toAddress(callerProfile.wallet_address, "使用者帳號");
      } catch {
        return json(response, 200, { synced: false, chainVerified: false, skipped: "no-wallet" });
      }

      const isAe = placement.is_ae_token === true;
      let assetIds = [placement.id];
      let onChain: number;
      if (isAe) {
        const { data: aePlacements, error: aePlacementsError } = await admin
          .from("private_placements")
          .select("id")
          .eq("is_ae_token", true);
        if (aePlacementsError) throw new Error(`查詢 AE 發行輪��失敗：${aePlacementsError.message}`);
        assetIds = [...new Set([placement.id, ...(aePlacements ?? []).map((row) => row.id as string)])];
        onChain = Math.floor((await getAeChainBalance(wallet)) * 1_000_000) / 1_000_000;
      } else {
        const tokenAddress = await getCurrentRwaFactoryToken(placement.id);
        if (!tokenAddress) {
          return json(response, 200, { synced: false, chainVerified: false, skipped: "no-current-token" });
        }
        const balance = await getWalletShareBalance(tokenAddress, wallet);
        onChain = Math.floor(balance.balance);
      }

      const [ordersResult, reservationsResult] = await Promise.all([
        admin
          .from("p2p_orders")
          .select("remaining_quantity")
          .eq("user_id", caller.id)
          .in("asset_id", assetIds)
          .eq("side", "sell")
          .in("status", ["open", "partially_filled"])
          .eq("escrow_mode", "escrow")
          .in("escrow_contract_address", P2P_ESCROW_KNOWN_ADDRESSES.map((address) => address.toLowerCase())),
        admin
          .from("p2p_escrow_order_reservations")
          .select("quantity")
          .eq("user_id", caller.id)
          .in("asset_id", assetIds)
          .eq("side", "sell")
          .eq("status", "pending"),
      ]);
      if (ordersResult.error) throw new Error(`查詢鎖定中的賣單失敗：${ordersResult.error.message}`);
      if (reservationsResult.error) throw new Error(`查詢待確認賣單失敗：${reservationsResult.error.message}`);

      const pendingReserved = (reservationsResult.data ?? []).reduce(
        (sum, row) => sum + Number(row.quantity ?? 0),
        0,
      );
      const lockedOrders = (ordersResult.data ?? []).reduce(
        (sum, row) => sum + Number(row.remaining_quantity ?? 0),
        0,
      );
      const locked = lockedOrders + pendingReserved;
      const total = isAe
        ? Math.floor((onChain + locked) * 1_000_000) / 1_000_000
        : Math.floor(onChain + locked);
      const available = isAe
        ? Math.floor(Math.max(onChain - pendingReserved, 0) * 1_000_000) / 1_000_000
        : Math.max(onChain - pendingReserved, 0);
      const targetAssetId = isAe && assetIds.includes("ae-token-daily") ? "ae-token-daily" : placement.id;
      const { data: holdingRow, error: holdingError } = await admin
        .from("holdings")
        .select("quantity")
        .eq("user_id", caller.id)
        .eq("asset_id", targetAssetId)
        .maybeSingle();
      if (holdingError) throw new Error(`讀取持倉帳本失敗：${holdingError.message}`);

      const ledgerQty = Number(holdingRow?.quantity ?? 0);
      const changed = Math.abs(total - ledgerQty) > 1e-9;
      if (changed && (total > 0 || holdingRow)) {
        const { error: upsertError } = await admin
          .from("holdings")
          .upsert(
            { user_id: caller.id, asset_id: targetAssetId, quantity: total, updated_at: new Date().toISOString() },
            { onConflict: "user_id,asset_id" },
          );
        if (upsertError) throw new Error(`同步新合約持有份額失敗：${upsertError.message}`);
      }

      return json(response, 200, {
        synced: changed,
        chainVerified: true,
        from: ledgerQty,
        to: total,
        onChain,
        locked,
        pendingReserved,
        available,
      });
    }

    if (action === "settle-vault-buy") {
      if (!requestKey || !body.txHash) return json(response, 400, { error: "缺少 requestKey 或 USDT 交易雜湊" });
      const { data: reservation, error: reservationError } = await admin
        .from("settlement_reservations")
        .select("request_key,user_id,jc_amount,usdt_amount,wallet_address,source_tx_hash,status")
        .eq("request_key", requestKey)
        .eq("action", "vault_buy")
        .maybeSingle();
      if (reservationError || !reservation || reservation.user_id !== caller.id) {
        return json(response, 404, { error: "找不到本人金庫買 JC 預留" });
      }
      if (reservation.status === "confirmed") return json(response, 200, { status: "confirmed", idempotent: true, request_key: requestKey });
      const wallet = toAddress(reservation.wallet_address, "使用者帳號");
      await verifyVaultUsdtDeposit(body.txHash, wallet, Number(reservation.usdt_amount));
      if (reservation.source_tx_hash && reservation.source_tx_hash.toLowerCase() !== body.txHash.toLowerCase()) {
        return json(response, 409, { error: "此預留已綁定另一筆 USDT 交易" });
      }
      if (!reservation.source_tx_hash) {
        const { error } = await admin.from("settlement_reservations")
          .update({ source_tx_hash: body.txHash.toLowerCase(), updated_at: new Date().toISOString() })
          .eq("request_key", requestKey)
          .eq("user_id", caller.id)
          .is("source_tx_hash", null);
        if (error) throw new Error(`保存 USDT 入金交易失敗：${error.message}`);
      }
      const { data: attached } = await admin.from("settlement_reservations")
        .select("request_key,user_id,jc_amount,usdt_amount,wallet_address,source_tx_hash,status")
        .eq("request_key", requestKey)
        .maybeSingle();
      if (!attached || !attached.source_tx_hash) throw new Error("USDT 入金交易尚未安全綁定到預留");
      return settleVaultJcReservationCore(admin, response, attached);
    }

    // ---- 舊版歷史金庫買 JC 結算仍可由已存在的正式帳本列補發。 ----
    if (action === "mint-jc") {
      const { data: reservation, error: reservationError } = await admin
        .from("settlement_reservations")
        .select("request_key,user_id,jc_amount,usdt_amount,wallet_address,source_tx_hash,status")
        .eq("request_key", requestKey)
        .eq("action", "vault_buy")
        .maybeSingle();
      if (reservationError) return json(response, 503, { error: "暫時無法讀取金庫買 JC 預留；未執行發幣，請安全重試。" });
      if (reservation) {
        if (reservation.user_id !== caller.id) return json(response, 404, { error: "找不到本人金庫買 JC 預留" });
        if (reservation.status === "confirmed") return json(response, 200, { status: "confirmed", idempotent: true, request_key: requestKey });
        if (reservation.status === "released") return json(response, 409, { status: "released", error: "此金庫買 JC 預留已釋放，不會再次發放 JC。" });
        return settleVaultJcReservationCore(admin, response, reservation);
      }
      const { data: ledgerRow, error: ledgerError } = await admin
        .from("jc_ledger")
        .select("id,user_id,amount,entry_type")
        .eq("idempotency_key", `${requestKey}:jc`)
        .eq("entry_type", "vault_buy")
        .maybeSingle();
      if (ledgerError) return json(response, 503, { error: "暫時無法讀取金庫買 JC 帳本；未執行發幣，請安全重試。" });
      if (!ledgerRow || ledgerRow.user_id !== caller.id) return json(response, 404, { error: "找不到對應的購買 JC 預留" });
      return settleMintJcCore(admin, response, ledgerRow);
    }

    if (action === "subscribe") {
      const { data: reservation, error: reservationError } = await admin
        .from("settlement_reservations")
        .select("request_key,user_id,asset_id,quantity,jc_amount,wallet_address,status")
        .eq("request_key", requestKey)
        .eq("action", "subscribe")
        .maybeSingle();
      if (reservationError) return json(response, 503, { error: "暫時無法讀取認購預留；未執行交割，請安全重試。" });
      if (reservation) {
        if (reservation.user_id !== caller.id) return json(response, 404, { error: "找不到本人認購預留" });
        if (reservation.status === "confirmed") return json(response, 200, { status: "confirmed", idempotent: true, request_key: requestKey });
        if (reservation.status === "released") return json(response, 409, { status: "released", error: "此認購預留已釋放，不會再次扣款或發放資產。" });
        return settleReservedSubscribeCore(admin, response, reservation);
      }
      const { data: ledgerRow, error: ledgerError } = await admin
        .from("jc_ledger")
        .select("id,user_id,asset_id,quantity,amount,metadata")
        .eq("idempotency_key", requestKey)
        .eq("entry_type", "private_purchase")
        .maybeSingle();
      if (ledgerError) return json(response, 503, { error: "暫時無法讀取舊版認購帳本；未執行重試，請安全重試。" });
      if (!ledgerRow || ledgerRow.user_id !== caller.id) return json(response, 404, { error: "找不到對應的認購紀錄" });
      return settleSubscribeCore(admin, response, ledgerRow);
    }

    // ---- JC 贖回：使用者申請贖回成功後立刻觸發（request_jc_redemption 已建立
    // pending 訂單），把使用者鏈上 JC 收回 Safe 金庫＋ADMIN 熱錢包直接撥 USDT
    // 給使用者。訂單本人或管理員皆可觸發（管理員用於重試卡單）。----
    if (action === "redeem-jc") {
      const orderId = (body as { orderId?: string }).orderId;
      if (!orderId) return json(response, 400, { error: "缺少 orderId" });
      const { data: order } = await admin
        .from("redemption_orders")
        .select("id,user_id,wallet_address,jc_amount,usdt_amount,status,jc_ledger_id,idempotency_key")
        .eq("id", orderId)
        .maybeSingle();
      if (!order) return json(response, 404, { error: "找不到贖回訂單" });
      if (order.user_id !== caller.id && !isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "只有本人或管理員可觸發此贖回結算" });
      }
      if (order.status !== "pending") {
        return json(response, 200, { status: order.status, idempotent: true });
      }
      return settleRedemptionCore(admin, response, order);
    }

    // ---- 管理員：列出需要人工關注的鏈上結算（失敗 / 卡在 pending 太久 / 站內
    // 已扣款但從未送出任何結算請求的「孤兒」記錄）。三種來源都可能發生：使用
    // 者付款後瀏覽器關掉、fetch 被中斷、relayer 當下 gas 不足或標的被下架擋下。
    // 這份清單同時也是 cron sweep（見 findAttentionCandidates）自動補發的資料來源
    // 這裡只是額外把使用者／標的名稱查出來供後台顯示用。----
    // ---- 管理員：一鍵把待派發分潤實際上鏈發放（ADMIN 熱錢包→受益人），可傳
    // beneficiaryIds 只派發指定人員，未傳則全平台派發。----
    if (action === "settle-commissions") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const ids = (body as { beneficiaryIds?: string[] }).beneficiaryIds;
      const filter = Array.isArray(ids) && ids.length > 0 ? ids : undefined;
      const summary = await sweepPendingCommissions(admin, 300, filter);
      await auditAdminAction(admin, caller, "commission.settle", "commission_logs", filter ? filter.join(",").slice(0, 200) : "all", {
        beneficiary_count: filter?.length ?? null,
        summary,
      });
      return json(response, 200, summary);
    }

    // ---- 管理員：卡在 pending 的單筆分潤，先唯讀核對鏈上確實沒有轉出，才安全重發。
    // 只有同時滿足：結算無 tx_hash／payoutTx、閒置逾 10 分鐘、ADMIN 無在途交易、
    // 鏈上查不到任何「ADMIN→受益人、金額相同、且不屬於其他分潤結算」的 JC 轉帳，
    // 才會把結算轉為 failed 並走既有的 settleCommissionCore（claim→轉帳→收據→入帳）。
    // 任何一步無法確證就停止並回報。dryRun=true 只核對、不付款。----
    if (action === "admin-verify-pay-commission") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const { commissionId, dryRun } = body as { commissionId?: string; dryRun?: boolean };
      if (!commissionId || !/^[0-9a-f-]{36}$/i.test(commissionId)) {
        return json(response, 400, { error: "缺少有效的分潤 ID" });
      }
      const { data: log, error: logError } = await admin
        .from("commission_logs")
        .select("id,beneficiary_id,buyer_id,commission_amount,asset_id,bonus_type,transaction_type,paid_at")
        .eq("id", commissionId)
        .maybeSingle();
      if (logError) return json(response, 500, { error: `讀取分潤紀錄失敗：${logError.message}` });
      if (!log || !log.beneficiary_id) return json(response, 404, { error: "找不到分潤紀錄" });
      if (log.paid_at) return json(response, 200, { status: "already_paid", paid_at: log.paid_at });

      const amount = Number(log.commission_amount);
      if (!(amount > 0)) return json(response, 422, { error: "分潤金額無效" });
      const { data: settlement, error: settlementError } = await admin
        .from("onchain_settlements")
        .select("id,status,tx_hash,payload,created_at,updated_at")
        .eq("ref_key", `commission:${log.id}`)
        .maybeSingle();
      if (settlementError) return json(response, 500, { error: `讀取結算紀錄失敗：${settlementError.message}` });
      if (!settlement) return json(response, 409, { error: "沒有對應的結算紀錄，請改用一般派發流程" });
      if (settlement.status !== "pending" && settlement.status !== "failed") {
        return json(response, 409, { error: `結算狀態為 ${settlement.status}，此入口只處理 pending／failed` });
      }
      const settlementPayload = settlement.payload && typeof settlement.payload === "object"
        ? settlement.payload as Record<string, unknown>
        : {};
      if (settlement.tx_hash || typeof settlementPayload.payoutTx === "string") {
        return json(response, 409, { error: "結算已有交易雜湊，請先核對該交易收據，不可重新發放" });
      }
      const idleMs = Date.now() - new Date(settlement.updated_at ?? settlement.created_at).getTime();
      if (idleMs < 10 * 60 * 1000) {
        return json(response, 409, { error: "此筆結算最近仍有更新，請稍後（至少 10 分鐘）再核對" });
      }
      const { data: beneficiary } = await admin
        .from("profiles")
        .select("wallet_address")
        .eq("id", log.beneficiary_id)
        .maybeSingle();
      let wallet: Address;
      try {
        wallet = toAddress(beneficiary?.wallet_address, "受益人帳號");
      } catch (e) {
        return json(response, 422, { error: errMsg(e) });
      }

      let inspection: Awaited<ReturnType<typeof inspectAdminJcPayoutsTo>>;
      try {
        inspection = await inspectAdminJcPayoutsTo(wallet, amount, new Date(settlement.created_at).getTime());
      } catch (e) {
        return json(response, 502, { error: `無法確證鏈上沒有轉出，已停止：${errMsg(e)}` });
      }
      if (inspection.latestNonce !== inspection.pendingNonce) {
        return json(response, 409, {
          error: "ADMIN 熱錢包仍有在途交易，已停止；請等交易確認後再核對",
          latest_nonce: inspection.latestNonce,
          pending_nonce: inspection.pendingNonce,
        });
      }
      const { data: otherSettlements, error: otherError } = await admin
        .from("onchain_settlements")
        .select("tx_hash,payload")
        .eq("action", "commission")
        .eq("user_id", log.beneficiary_id)
        .neq("id", settlement.id);
      if (otherError) return json(response, 500, { error: `讀取其他分潤結算失敗：${otherError.message}` });
      const attributed = new Set<string>();
      for (const row of otherSettlements ?? []) {
        if (typeof row.tx_hash === "string") attributed.add(row.tx_hash.toLowerCase());
        const rowPayload = row.payload as { payoutTx?: unknown } | null;
        if (rowPayload && typeof rowPayload.payoutTx === "string") attributed.add(rowPayload.payoutTx.toLowerCase());
      }
      const unexplained = inspection.matching.filter((entry) => !attributed.has(entry.hash.toLowerCase()));
      const report = {
        commission_id: log.id,
        wallet,
        amount,
        scanned_transfers: inspection.transfers.length,
        same_amount_transfers: inspection.matching.length,
        attributed_to_other_commissions: inspection.matching.length - unexplained.length,
        unexplained,
        nonce: inspection.latestNonce,
      };
      if (unexplained.length > 0) {
        return json(response, 409, {
          error: "鏈上找到金額相同、且不屬於其他分潤的轉帳，可能已經付過；已停止，請人工核對",
          report,
        });
      }
      if (dryRun) {
        return json(response, 200, { status: "verified_safe_to_pay", report });
      }

      return withSettlementRecoveryLock(settlement.id, async () => {
        const { data: reset, error: resetError } = await admin
          .from("onchain_settlements")
          .update({
            status: "failed",
            error: "管理員核對鏈上無對應轉帳後重新發放",
            payload: {
              ...settlementPayload,
              manualVerifiedAt: new Date().toISOString(),
              manualVerifiedBy: caller.id,
              manualVerification: report,
            },
            updated_at: new Date().toISOString(),
          })
          .eq("id", settlement.id)
          .eq("status", settlement.status)
          .is("tx_hash", null)
          .select("id")
          .maybeSingle();
        if (resetError) return json(response, 500, { error: `準備重發失敗：${resetError.message}` });
        if (!reset) return json(response, 409, { error: "結算狀態剛被其他流程更新，已停止，請重新整理後再核對" });
        await auditAdminAction(admin, caller, "commission.verify_pay", "commission_logs", log.id, report);
        const fake = fakeResponse();
        await settleCommissionCore(admin, fake.response, {
          id: log.id,
          user_id: log.beneficiary_id,
          buyer_id: log.buyer_id ?? null,
          bonus_type: log.bonus_type ?? null,
          amount,
          asset_id: log.asset_id ?? null,
          transaction_type: log.transaction_type,
        });
        const result = fake.read();
        return json(response, result.status, result.body);
      });
    }

    // ---- 管理員：一鍵沖正指定受益人的獎金派發錯誤（多發／少發校正）----
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
      await auditAdminAction(admin, caller, "commission.reverse", "profiles", ids.join(",").slice(0, 200), {
        reason: typeof (body as { reason?: string }).reason === "string" ? (body as { reason?: string }).reason!.slice(0, 300) : null,
        results,
      });
      return json(response, 200, { results });
    }

    if (action === "admin-list-settlements") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      await releaseUnpaidSubscribeReservations(admin).catch((error) =>
        recordSystemError("release_unpaid_subscribe", errMsg(error), {}),
      );
      const items = await findAttentionCandidates(admin);
      const { data: pendingReservationRows, error: pendingReservationError } = await admin
        .from("settlement_reservations")
        .select("request_key,action,user_id,asset_id,quantity,jc_amount,usdt_amount,source_tx_hash,status,created_at,updated_at")
        .eq("status", "pending")
        .lt("created_at", new Date(Date.now() - 30_000).toISOString())
        .order("created_at", { ascending: false })
        .limit(100);
      if (pendingReservationError) throw new Error(`讀取待處理交易預留失敗：${pendingReservationError.message}`);
      const pendingSubscribeSettlements = await loadSubscribeSettlements(
        admin,
        (pendingReservationRows ?? []).filter((row) => row.action === "subscribe").map((row) => row.request_key),
      );
      const pendingReservations = (pendingReservationRows ?? []).filter((row) =>
        row.action !== "subscribe" ||
        subscribeSettlementTouchedChain(pendingSubscribeSettlements.get(row.request_key)),
      );
      const existingAttentionKeys = new Set(items.map((item) => `${item.action}:${item.ledgerRowId}`));
      const reservationItems: AttentionItem[] = (pendingReservations ?? []).flatMap((row) => {
        const action: AttentionAction = row.action === "vault_buy" ? "mint_jc" : row.action;
        if (existingAttentionKeys.has(`${action}:${row.request_key}`)) return [];
        return [{
          id: null,
          action,
          ledgerRowId: row.request_key,
          userId: row.user_id,
          assetId: row.asset_id,
          amount: Number(row.jc_amount),
          payment: row.usdt_amount == null ? null : Number(row.usdt_amount),
          status: "reserved_pending",
          error: row.action === "vault_buy" && !row.source_tx_hash
            ? "USDT 付款交易尚未回報，請先核對鏈上錢包；不可直接發放 JC。"
            : "交易額度��預留，正式帳本尚未完成；請重試相同 request key。",
          txHash: row.source_tx_hash,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }];
      });
      const { data: manualSettlements, error: manualSettlementsError } = await admin
        .from("onchain_settlements")
        .select("id,ref_key,user_id,asset_id,amount,payment,tx_hash,payload,created_at,updated_at")
        .eq("action", "subscribe")
        .eq("status", "confirmed")
        .eq("payload->>manualRepair", "true")
        .order("created_at", { ascending: false })
        .limit(100);
      if (manualSettlementsError) throw new Error(`讀取人工補發紀錄失敗：${manualSettlementsError.message}`);

      const manualCandidates = (manualSettlements ?? []).flatMap((row) => {
        const payload = row.payload && typeof row.payload === "object"
          ? row.payload as Record<string, unknown>
          : {};
        const ledgerMatch = row.ref_key.match(/^subscribe:([0-9a-f-]{36})$/i);
        return payload.manualRepair === true &&
          typeof payload.jcToVaultTx !== "string" &&
          typeof payload.jcPullTx !== "string" &&
          ledgerMatch
          ? [{ row, ledgerId: ledgerMatch[1] }]
          : [];
      });
      const { data: manualLedgerRows, error: manualLedgerError } = manualCandidates.length
        ? await admin
            .from("jc_ledger")
            .select("id,user_id,asset_id,amount,metadata")
            .in("id", manualCandidates.map((candidate) => candidate.ledgerId))
            .eq("entry_type", "private_purchase")
        : { data: [], error: null };
      if (manualLedgerError) throw new Error(`讀取人工補發帳本失敗：${manualLedgerError.message}`);
      const manualLedgerById = new Map((manualLedgerRows ?? []).map((row) => [row.id, row]));
      const missingJcItems: AttentionItem[] = manualCandidates.flatMap(({ row, ledgerId }) => {
        const ledger = manualLedgerById.get(ledgerId);
        if (!ledger || ledger.user_id !== row.user_id || ledger.asset_id !== row.asset_id) return [];
        const gross = Number(
          (ledger.metadata as { gross?: number } | null)?.gross ?? Math.abs(Number(ledger.amount)),
        );
        if (!(gross > 0) || Math.abs(gross - Number(row.payment)) > 0.000001) return [];
        return [{
          id: row.id,
          action: "subscribe",
          ledgerRowId: ledgerId,
          userId: row.user_id,
          assetId: row.asset_id,
          amount: row.amount == null ? null : Number(row.amount),
          payment: gross,
          status: "jc_uncollected",
          error: "人工補發的份額交易已確認，但沒有 JC 入 Safe 的交易紀錄，補收前需先讓用戶錢包授權本筆 JC。",
          txHash: row.tx_hash,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }];
      });
      const allItems = [...items, ...missingJcItems, ...reservationItems];
      const userIds = [...new Set(allItems.map((i) => i.userId))];
      const assetIds = [...new Set(allItems.map((i) => i.assetId).filter(Boolean))] as string[];
      const [profilesResult, placementsResult] = await Promise.all([
        userIds.length
          ? admin.from("profiles").select("id,email,nickname,display_name").in("id", userIds)
          : Promise.resolve({ data: [] as { id: string; email: string | null; nickname: string | null; display_name: string | null }[] }),
        assetIds.length
          ? admin.from("private_placements").select("id,name,is_ae_token").in("id", assetIds)
          : Promise.resolve({ data: [] as { id: string; name: string | null }[] }),
      ]);
      const profileRows = (profilesResult.data ?? []) as {
        id: string;
        email: string | null;
        nickname: string | null;
        display_name: string | null;
      }[];
      const placementRows = (placementsResult.data ?? []) as { id: string; name: string | null; is_ae_token: boolean | null }[];
      const profileById = new Map(profileRows.map((profile) => [profile.id, profile]));
      const placementById = new Map(placementRows.map((placement) => [placement.id, placement]));

      const enriched = allItems
        .map((item) => {
          const profile = profileById.get(item.userId);
          const placement = item.assetId ? placementById.get(item.assetId) : null;
          return {
            ...item,
            userLabel: profile?.nickname || profile?.display_name || profile?.email || item.userId,
            assetName: placement?.is_ae_token ? "AE" : placement?.name ?? (item.assetId ? item.assetId : null),
          };
        })
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      const { data: stuckRows, error: stuckError } = await admin
        .from("onchain_settlements")
        .select("ref_key,user_id,asset_id,amount,status,error,created_at,updated_at")
        .eq("action", "commission")
        .in("status", ["pending", "failed"])
        .is("tx_hash", null)
        .lt("updated_at", new Date(Date.now() - 10 * 60 * 1000).toISOString())
        .order("created_at", { ascending: false })
        .limit(50);
      if (stuckError) throw new Error(`讀取卡住的分潤結算失敗：${stuckError.message}`);
      const stuckUserIds = [...new Set((stuckRows ?? []).map((row) => row.user_id as string))];
      const { data: stuckProfiles } = stuckUserIds.length
        ? await admin.from("profiles").select("id,email,nickname,display_name").in("id", stuckUserIds)
        : { data: [] as { id: string; email: string | null; nickname: string | null; display_name: string | null }[] };
      const stuckProfileById = new Map((stuckProfiles ?? []).map((profile) => [profile.id, profile]));
      const stuckCommissions = (stuckRows ?? []).map((row) => {
        const profile = stuckProfileById.get(row.user_id as string);
        return {
          commissionId: String(row.ref_key).replace(/^commission:/, ""),
          userLabel: profile?.nickname || profile?.display_name || profile?.email || row.user_id,
          amount: row.amount == null ? null : Number(row.amount),
          status: row.status,
          error: row.error,
          createdAt: row.created_at,
        };
      });

      return json(response, 200, { items: enriched, stuckCommissions });
    }

    if (action === "admin-collect-manual-settlement-jc") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const settlementId = (body as { settlementId?: string }).settlementId;
      if (!settlementId || !/^[0-9a-f-]{36}$/i.test(settlementId)) {
        return json(response, 400, { error: "缺少有效的人工補發結算 ID" });
      }
      if (!(await guardRelayerGas(response))) return;
      try {
        const txHash = await withSettlementRecoveryLock(settlementId, () =>
          collectJcForManualSettlementRepair(admin, settlementId),
        );
        return json(response, 200, { status: "confirmed", jc_to_vault_tx: txHash });
      } catch (error) {
        return json(response, 502, { error: `補收認購 JC 失敗：${errMsg(error)}` });
      }
    }

    // ---- 管理員：一鍵補發／重試單筆卡單的鏈上結算 ----
    if (action === "admin-retry-settlement") {
      if (!isAdminProfile(callerProfile)) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const payload = body as { settlementId?: string; ledgerAction?: string; ledgerRowId?: string };
      let settleAction: AttentionAction;
      let ledgerRowId: string;
      await auditAdminAction(admin, caller, "settlement.retry", "onchain_settlements", payload.settlementId ?? payload.ledgerRowId ?? "unknown", {
        ledger_action: payload.ledgerAction ?? null,
      });

      if (payload.settlementId) {
        const { data: settlement } = await admin
          .from("onchain_settlements")
          .select("id,action,ref_key,status,tx_hash,updated_at,created_at")
          .eq("id", payload.settlementId)
          .maybeSingle();
        if (!settlement) return json(response, 404, { error: "找不到結算紀錄" });
        if (settlement.action === "trade" || settlement.action === "list_fee") {
          return json(response, 410, { error: "舊二級市場結算紀錄僅保留歷史，不再提供 relayer 補發。" });
        }
        if (settlement.status === "confirmed") {
          return json(response, 200, { status: "confirmed", tx_hash: settlement.tx_hash, idempotent: true });
        }
        if (settlement.status === "cancelled") {
          return json(response, 200, { status: "cancelled", idempotent: true });
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
        (
          payload.ledgerAction === "mint_jc" ||
          payload.ledgerAction === "subscribe" ||
          payload.ledgerAction === "redeem")
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

type AttentionAction = "mint_jc" | "subscribe" | "redeem";
type AttentionItem = {
  id: string | null;
  action: AttentionAction;
  ledgerRowId: string;
  userId: string;
  assetId: string | null;
  amount: number | null;
  payment?: number | null;
  status: "orphan" | "failed" | "stale_pending" | "jc_uncollected" | "reserved_pending";
  error: string | null;
  txHash?: string | null;
  createdAt: string;
  updatedAt?: string;
};

/**
 * 找出所有「需要人工關注／需要自動補發」的鏈上結算
 *  1. orphan：站內已扣款（jc_ledger 有對應紀錄），但從未產生任何 onchain_settlements
 *     紀錄——通常是使用者付款成功那一刻瀏覽器就關掉、或呼叫 /api/relayer 的
 *     fetch 被中斷，導致「已扣款卻沒觸發任何鏈上發幣/結算請求」。
 *  2. failed：曾經嘗試過但失敗（gas 不足、鏈上 revert 等）。
 *  3. stale_pending：卡在 pending 超過 2 ��鐘（例如流程中途 serverless 逾時被中斷）。
 * 這份清單同時供後台「鏈上結算」頁籤顯示，以及 cron sweep 自動補發使用。
 */
async function findAttentionCandidates(admin: SupabaseClient): Promise<AttentionItem[]> {
  const STALE_MS = 2 * 60 * 1000;
  const staleBefore = new Date(Date.now() - STALE_MS).toISOString();

  // 贖回訂單幾乎一定是「使用者送出 request_jc_redemption 後，前端立刻呼叫
  // redeem-jc」兩段式流程，中間有正常的網路往返時間，故只把建立超過 30 秒、
  // 仍為 pending 的訂單當成「可能卡住」，避免誤判正在進行中的正常流程。
  const redeemOrphanBefore = new Date(Date.now() - 30 * 1000).toISOString();

  const [vaultRows, subRows, redeemRows, failedOrStale, confirmedRows] = await Promise.all([
    admin
      .from("jc_ledger")
      .select("id,user_id,amount,idempotency_key,created_at")
      .eq("entry_type", "vault_buy")
      .not("idempotency_key", "is", null)
      .order("created_at", { ascending: false })
      .limit(300),
    admin
      .from("jc_ledger")
      .select("id,user_id,asset_id,amount,idempotency_key,created_at")
      .eq("entry_type", "private_purchase")
      .not("idempotency_key", "is", null)
      .order("created_at", { ascending: false })
      .limit(300),
    // JC 贖回：redemption_orders 仍是 pending（表示使用者的 redeem-jc 呼叫從未
    // 成功觸發結算（例如送出後關閉瀏覽器），交給 cron sweep／管理員補發。
    admin
      .from("redemption_orders")
      .select("id,user_id,jc_amount,created_at")
      .eq("status", "pending")
      .lt("created_at", redeemOrphanBefore)
      .order("created_at", { ascending: false })
      .limit(300),
  admin
    .from("onchain_settlements")
    .select("id,action,ref_key,user_id,asset_id,amount,payment,status,error,tx_hash,payload,created_at,updated_at")
    .in("action", ["mint_jc", "subscribe", "redeem"])
    .or(`status.eq.failed,and(status.eq.pending,updated_at.lt.${staleBefore})`)
    .order("created_at", { ascending: false })
    .limit(200),
  admin
    .from("onchain_settlements")
    .select("ref_key")
    .in("action", ["mint_jc", "subscribe", "redeem"])
    .eq("status", "confirmed")
    .limit(1000),
  ]);
  const candidateQueryError = vaultRows.error ?? subRows.error ?? redeemRows.error ?? failedOrStale.error ?? confirmedRows.error;
  if (candidateQueryError) throw new Error(`讀取鏈上補發候選清單失敗：${candidateQueryError.message}`);
  const confirmedRefKeys = new Set(
    ((confirmedRows.data ?? []) as { ref_key: string }[]).map((row) => row.ref_key),
  );

  const subscriptionLedgerRows = (subRows.data ?? []) as {
    id: string;
    user_id: string;
    asset_id: string | null;
    amount: number;
    idempotency_key: string | null;
    created_at: string;
  }[];
  const vaultLedgerRows = (vaultRows.data ?? []) as {
    id: string;
    user_id: string;
    amount: number;
    idempotency_key: string | null;
    created_at: string;
  }[];
  const reservationRequestKeys = [...new Set([
    ...subscriptionLedgerRows.map((row) => requestKeyForLedgerRow(row, "subscribe")),
    ...vaultLedgerRows.map((row) => requestKeyForLedgerRow(row, "vault_buy")),
  ].filter((key): key is string => Boolean(key)))];
  const reservationRows: { request_key: string; action: string; status: string }[] = [];
  for (let offset = 0; offset < reservationRequestKeys.length; offset += 100) {
    const reservationQuery = await admin
      .from("settlement_reservations")
      .select("request_key,action,status")
      .in("action", ["subscribe", "vault_buy"])
      .in("request_key", reservationRequestKeys.slice(offset, offset + 100));
    if (reservationQuery.error) throw new Error(`讀取交易預留對照失敗：${reservationQuery.error.message}`);
    reservationRows.push(...((reservationQuery.data ?? []) as { request_key: string; action: string; status: string }[]));
  }
  const reservationsByRequestKey = indexReservationsByRequestKey(reservationRows);
  const subscriptionLedgerById = new Map(subscriptionLedgerRows.map((row) => [row.id, row]));
  const vaultLedgerById = new Map(vaultLedgerRows.map((row) => [row.id, row]));

  const ledgerByAction: Record<AttentionAction, { id: string; user_id: string; asset_id?: string | null; amount: number; created_at: string; idempotency_key?: string | null }[]> = {
    mint_jc: vaultLedgerRows as never,
    subscribe: subscriptionLedgerRows as never,
    redeem: ((redeemRows.data ?? []) as { id: string; user_id: string; jc_amount: number; created_at: string }[]).map(
      (r) => ({ id: r.id, user_id: r.user_id, asset_id: null, amount: Number(r.jc_amount), created_at: r.created_at }),
    ),
  };
  const candidateRefKeys = (Object.entries(ledgerByAction) as [AttentionAction, typeof ledgerByAction[AttentionAction]][])
    .flatMap(([act, rows]) => rows.map((r) => `${act}:${r.id}`));
  const existingSettlementRows: { ref_key: string }[] = [];
  for (let offset = 0; offset < candidateRefKeys.length; offset += 100) {
    const existingResult = await admin
      .from("onchain_settlements")
      .select("ref_key")
      .in("ref_key", candidateRefKeys.slice(offset, offset + 100));
    if (existingResult.error) throw new Error(`讀取補發冪等紀錄失敗：${existingResult.error.message}`);
    existingSettlementRows.push(...((existingResult.data ?? []) as { ref_key: string }[]));
  }
  const hasSettlement = new Set(existingSettlementRows.map((r) => r.ref_key));

  const orphans: AttentionItem[] = (Object.entries(ledgerByAction) as [AttentionAction, typeof ledgerByAction[AttentionAction]][])
    .flatMap(([act, rows]) =>
      rows
        .filter((r) =>
          !hasSettlement.has(`${act}:${r.id}`) &&
          !(act === "subscribe" && isReservationBackedLedgerRow(r, "subscribe", reservationsByRequestKey)) &&
          !(act === "mint_jc" && isReservationBackedLedgerRow(r, "vault_buy", reservationsByRequestKey))
        )
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

  const attentionNeeded: AttentionItem[] = (failedOrStale.data ?? [])
    .filter((row) => !confirmedRefKeys.has(row.ref_key))
    .filter((row) => !(
      (row.action === "subscribe" && isReservationBackedLegacySettlement(
        row.ref_key,
        "subscribe",
        subscriptionLedgerById,
        reservationsByRequestKey,
      )) ||
      (row.action === "mint_jc" && isReservationBackedLegacySettlement(
        row.ref_key,
        "vault_buy",
        vaultLedgerById,
        reservationsByRequestKey,
      ))
    ))
    .map((row) => ({
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

  // 預留制認購（ref_key = subscribe:<request_key>）若預留已釋放，或鏈上從未送出任何
  // 收款／發放交易，代表買方沒付 JC 也沒拿到份額，管理員補發無法完成，不列入清單。
  const failedRowByRef = new Map((failedOrStale.data ?? []).map((row) => [row.ref_key as string, row]));
  const subscribeKeys = [...new Set(
    attentionNeeded.filter((item) => item.action === "subscribe").map((item) => item.ledgerRowId),
  )];
  const subscribeReservationStatus = new Map<string, string>();
  for (let offset = 0; offset < subscribeKeys.length; offset += 100) {
    const { data, error } = await admin
      .from("settlement_reservations")
      .select("request_key,status")
      .eq("action", "subscribe")
      .in("request_key", subscribeKeys.slice(offset, offset + 100));
    if (error) throw new Error(`讀取認購預留狀態失敗：${error.message}`);
    for (const row of data ?? []) subscribeReservationStatus.set(row.request_key, row.status);
  }
  const actionableAttention = attentionNeeded.filter((item) => {
    if (item.action !== "subscribe") return true;
    const reservationStatus = subscribeReservationStatus.get(item.ledgerRowId);
    if (!reservationStatus) return true;
    if (reservationStatus !== "pending") return false;
    const row = failedRowByRef.get(`subscribe:${item.ledgerRowId}`);
    return subscribeSettlementTouchedChain(row as SubscribeSettlementProbe | undefined);
  });

  const combined = [...actionableAttention, ...orphans];

  // 已下架的認購標的不再顯示補發：`admin_deactivate_placement` 下架時已原路退回
  // 對應的 JC；若仍補發鏈上份額，會造成重複發放。
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
    const reservationColumns = "request_key,user_id,jc_amount,usdt_amount,wallet_address,source_tx_hash,status";
    const { data: initialReservation, error: reservationError } = await admin
      .from("settlement_reservations")
      .select(reservationColumns)
      .eq("request_key", ledgerRowId)
      .eq("action", "vault_buy")
      .maybeSingle();
    let reservation = initialReservation;
    if (reservationError) throw new Error(`讀取金庫買 JC 預留失敗：${reservationError.message}`);

    let ledgerRow: {
      id: string;
      user_id: string;
      amount: number;
      idempotency_key: string | null;
    } | null = null;
    if (!reservation) {
      const ledgerResult = await admin
        .from("jc_ledger")
        .select("id,user_id,amount,idempotency_key")
        .eq("id", ledgerRowId)
        .eq("entry_type", "vault_buy")
        .maybeSingle();
      if (ledgerResult.error) throw new Error(`讀取金庫買 JC 帳本錨點失敗：${ledgerResult.error.message}`);
      ledgerRow = ledgerResult.data;
      const requestKey = ledgerRow ? requestKeyForLedgerRow(ledgerRow, "vault_buy") : null;
      if (requestKey) {
        const mappedReservation = await admin
          .from("settlement_reservations")
          .select(reservationColumns)
          .eq("request_key", requestKey)
          .eq("action", "vault_buy")
          .maybeSingle();
        if (mappedReservation.error) throw new Error(`依 request key 讀取金庫買 JC 預留失敗：${mappedReservation.error.message}`);
        reservation = mappedReservation.data;
      }
    }

    if (reservation) {
      if (reservation.status === "confirmed") {
        const { data: settlement, error } = await admin
          .from("onchain_settlements")
          .select("tx_hash")
          .eq("ref_key", `mint_jc:${reservation.request_key}`)
          .eq("status", "confirmed")
          .maybeSingle();
        if (error) throw new Error(`讀取已完成金庫買 JC 交易雜湊失敗：${error.message}`);
        return json(response, 200, {
          status: "confirmed",
          idempotent: true,
          request_key: reservation.request_key,
          tx_hash: settlement?.tx_hash ?? null,
        });
      }
      if (reservation.status === "released") {
        return json(response, 409, {
          status: "released",
          request_key: reservation.request_key,
          error: "此金庫買 JC 預留已釋放，不會再次發放 JC。",
        });
      }
      return settleVaultJcReservationCore(admin, response, reservation);
    }

    if (!ledgerRow) return json(response, 404, { error: "找不到對應的購買 JC 紀錄" });
    return settleMintJcCore(admin, response, ledgerRow);
  }
  if (settleAction === "subscribe") {
    const reservationColumns = "request_key,user_id,asset_id,quantity,jc_amount,wallet_address,status";
    const { data: initialReservation, error: reservationError } = await admin
      .from("settlement_reservations")
      .select(reservationColumns)
      .eq("request_key", ledgerRowId)
      .eq("action", "subscribe")
      .maybeSingle();
    let reservation = initialReservation;
    if (reservationError) throw new Error(`讀取認購預留失敗：${reservationError.message}`);

    let ledgerRow: {
      id: string;
      user_id: string;
      asset_id: string | null;
      quantity: number;
      amount: number;
      metadata: unknown;
      idempotency_key: string | null;
    } | null = null;
    if (!reservation) {
      const ledgerResult = await admin
        .from("jc_ledger")
        .select("id,user_id,asset_id,quantity,amount,metadata,idempotency_key")
        .eq("id", ledgerRowId)
        .eq("entry_type", "private_purchase")
        .maybeSingle();
      if (ledgerResult.error) throw new Error(`讀取認購帳本錨點失敗：${ledgerResult.error.message}`);
      ledgerRow = ledgerResult.data;

      // Reservation finalization creates a private_purchase ledger row whose primary ID is
      // different from its request_key. Recovery is keyed by the ledger ID, so resolve the
      // request key before ever entering the legacy path that would collect JC a second time.
      if (ledgerRow?.idempotency_key) {
        const mappedReservation = await admin
          .from("settlement_reservations")
          .select(reservationColumns)
          .eq("request_key", ledgerRow.idempotency_key)
          .eq("action", "subscribe")
          .maybeSingle();
        if (mappedReservation.error) throw new Error(`依認購 request key 讀取預留失敗：${mappedReservation.error.message}`);
        reservation = mappedReservation.data;
      }
    }

    if (reservation) {
      if (reservation.status === "confirmed") {
        const { data: settlement, error } = await admin
          .from("onchain_settlements")
          .select("tx_hash,payload")
          .eq("ref_key", `subscribe:${reservation.request_key}`)
          .eq("status", "confirmed")
          .maybeSingle();
        if (error) throw new Error(`讀取已完成認購交易雜湊失敗：${error.message}`);
        const settlementPayload = settlement?.payload && typeof settlement.payload === "object"
          ? settlement.payload as Record<string, unknown>
          : {};
        return json(response, 200, {
          status: "confirmed",
          idempotent: true,
          request_key: reservation.request_key,
          tx_hash: settlement?.tx_hash ?? settlementPayload.assetTransferTx ?? null,
        });
      }
      if (reservation.status === "released") {
        return json(response, 409, {
          status: "released",
          request_key: reservation.request_key,
          error: "此認購預留已釋放，不會再次扣款或發放資產。",
        });
      }
      return settleReservedSubscribeCore(admin, response, reservation);
    }

    if (!ledgerRow) return json(response, 404, { error: "找不到對應的認購紀錄" });
    return settleSubscribeCore(admin, response, ledgerRow);
  }
  if (settleAction === "redeem") {
    const { data: reservation } = await admin
      .from("settlement_reservations")
      .select("request_key")
      .eq("request_key", ledgerRowId)
      .eq("action", "redeem")
      .maybeSingle();
    const { data: order } = await admin
      .from("redemption_orders")
      .select("id,user_id,wallet_address,jc_amount,usdt_amount,status,jc_ledger_id,idempotency_key")
      .eq(reservation ? "idempotency_key" : "id", ledgerRowId)
      .maybeSingle();
    if (!order) return json(response, 404, { error: "找不到對應的贖回訂單" });
    if (order.status !== "pending") {
      return json(response, 200, { status: order.status, idempotent: true });
    }
    return settleRedemptionCore(admin, response, order);
  }
  return json(response, 410, { error: "舊二級市場 relayer 結算已停用；請使用 P2PEscrow 託管成交紀錄。" });
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
  // limit 用於「機會式」掃描：每次只處理一小批，避免拖慢觸發它的使用者請求或
  // 撞到 serverless 逾時；每日 cron 呼叫時不帶 limit，一次掃完全部。
  const items = typeof limit === "number" ? allItems.slice(0, limit) : allItems;
  const stillFailing: { ledgerRowId: string; action: AttentionAction; error: string }[] = [];
  const unexpectedFailures: string[] = [];
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
      const message = errMsg(e);
      stillFailing.push({ ledgerRowId: item.ledgerRowId, action: item.action, error: message });
      unexpectedFailures.push(`${item.action}:${item.ledgerRowId}: ${message}`);
    }
  }
  if (unexpectedFailures.length) {
    await recordSystemError("onchain_settlement_sweep", unexpectedFailures.slice(0, 10).join(" | "), {
      failed_count: unexpectedFailures.length,
      attempted,
    });
  }
  return { attempted, fixed, stillFailing };
}

const SUBSCRIBE_CHAIN_STEP_KEYS = ["jcToVaultTx", "jcPullTx", "assetTransferTx"] as const;
const UNPAID_SUBSCRIBE_RELEASE_MS = 15 * 60 * 1000;
const SUBSCRIBE_IN_FLIGHT_MS = 10 * 60 * 1000;

type SubscribeSettlementProbe = { status: string; tx_hash: string | null; payload: unknown; updated_at: string };

/** True once any subscribe settlement transaction was broadcast. Step hashes are persisted
 * before broadcast completes, so an absent hash means no JC was collected and no shares sent. */
function subscribeSettlementTouchedChain(settlement: SubscribeSettlementProbe | null | undefined): boolean {
  if (!settlement) return false;
  if (settlement.status === "confirmed" || settlement.tx_hash) return true;
  const payload = settlement.payload && typeof settlement.payload === "object"
    ? settlement.payload as Record<string, unknown>
    : {};
  return SUBSCRIBE_CHAIN_STEP_KEYS.some((key) => typeof payload[key] === "string" && payload[key]);
}

async function loadSubscribeSettlements(
  admin: SupabaseClient,
  requestKeys: string[],
): Promise<Map<string, SubscribeSettlementProbe>> {
  const byRequestKey = new Map<string, SubscribeSettlementProbe>();
  for (let offset = 0; offset < requestKeys.length; offset += 100) {
    const refKeys = requestKeys.slice(offset, offset + 100).map((key) => `subscribe:${key}`);
    const { data, error } = await admin
      .from("onchain_settlements")
      .select("ref_key,status,tx_hash,payload,updated_at")
      .in("ref_key", refKeys);
    if (error) throw new Error(`讀取認購結算進度失敗：${error.message}`);
    for (const row of data ?? []) {
      byRequestKey.set(String(row.ref_key).slice("subscribe:".length), row as SubscribeSettlementProbe);
    }
  }
  return byRequestKey;
}

/**
 * 認購預留若買方始終沒有付款 JC、也沒有發放任何份額（鏈上從未送出任何結算交易），
 * 平台無法替買方簽授權，補發永遠不會成功；逾時後自動釋放預留，歸還買方 JC 額度與庫存。
 */
export async function releaseUnpaidSubscribeReservations(
  admin: SupabaseClient,
  limit = 100,
): Promise<{ released: string[] }> {
  const { data: reservations, error } = await admin
    .from("settlement_reservations")
    .select("request_key,user_id,jc_amount,created_at")
    .eq("action", "subscribe")
    .eq("status", "pending")
    .lt("created_at", new Date(Date.now() - UNPAID_SUBSCRIBE_RELEASE_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`讀取逾時認購預留失敗：${error.message}`);
  const rows = reservations ?? [];
  if (!rows.length) return { released: [] };

  const settlements = await loadSubscribeSettlements(admin, rows.map((row) => row.request_key));
  const released: string[] = [];
  for (const row of rows) {
    const settlement = settlements.get(row.request_key);
    if (subscribeSettlementTouchedChain(settlement)) continue;
    if (
      settlement?.status === "pending" &&
      Date.now() - new Date(settlement.updated_at).getTime() < SUBSCRIBE_IN_FLIGHT_MS
    ) continue;

    const now = new Date().toISOString();
    const { data: updated, error: releaseError } = await admin
      .from("settlement_reservations")
      .update({ status: "released", updated_at: now })
      .eq("request_key", row.request_key)
      .eq("action", "subscribe")
      .eq("status", "pending")
      .select("request_key");
    if (releaseError) throw new Error(`釋放未付款認購預留失敗：${releaseError.message}`);
    if (!updated?.length) continue;

    if (settlement) {
      await admin
        .from("onchain_settlements")
        .update({
          status: "failed",
          error: "買方未付款 JC、也未發放份額，認購預留已自動釋放（不需補發）",
          updated_at: now,
        })
        .eq("ref_key", `subscribe:${row.request_key}`)
        .neq("status", "confirmed");
    }
    released.push(row.request_key);
  }
  return { released };
}

export async function sweepPendingSettlementReservations(
  admin: SupabaseClient,
  limit = 100,
): Promise<{ scanned: number; confirmed: number; pending: number }> {
  await releaseUnpaidSubscribeReservations(admin).catch((error) =>
    recordSystemError("release_unpaid_subscribe", errMsg(error), {}),
  );
  const staleBefore = new Date(Date.now() - 60_000).toISOString();
  const { data: reservations, error } = await admin
    .from("settlement_reservations")
    .select("request_key,action,user_id,asset_id,quantity,jc_amount,usdt_amount,wallet_address,source_tx_hash,chain_payload,created_at,updated_at")
    .eq("status", "pending")
    .lt("created_at", staleBefore)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`讀取待處理交易預留失敗：${error.message}`);

  let confirmed = 0;
  let pending = 0;
  for (const reservation of reservations ?? []) {
    if (reservation.action === "vault_buy" && !reservation.source_tx_hash) {
      pending += 1;
      await alertSettlementFailure(admin, {
        kind: "金庫買 JC",
        refKey: `vault_buy:${reservation.request_key}`,
        stage: "等待 USDT 入金交易雜湊",
        error: "交易預留已建立，但目前沒有可驗證的 USDT Transfer 收據",
        userId: reservation.user_id,
        deliverable: "JC",
        jcAmount: Number(reservation.jc_amount),
        usdtAmount: Number(reservation.usdt_amount),
        remedy: "先確認使用者錢包是否已送出 USDT。沒有可驗證的鏈上交易雜湊時禁止發放 JC；確認未送出後可安全釋放此預留。",
      });
      continue;
    }

    const { response, read } = fakeResponse();
    try {
      if (reservation.action === "subscribe") {
        await settleReservedSubscribeCore(admin, response, reservation);
      } else if (reservation.action === "vault_buy") {
        await settleVaultJcReservationCore(admin, response, reservation);
      } else if (reservation.action === "redeem") {
        const { data: order, error: orderError } = await admin
          .from("redemption_orders")
          .select("id,user_id,wallet_address,jc_amount,usdt_amount,status,jc_ledger_id,idempotency_key")
          .eq("idempotency_key", reservation.request_key)
          .maybeSingle();
        if (orderError || !order) throw new Error(orderError?.message ?? "找不到 JC 贖回訂單");
        await settleRedemptionCore(admin, response, order);
      }
      const { body } = read();
      if (body && typeof body === "object" && (body as { status?: unknown }).status === "confirmed") confirmed += 1;
      else pending += 1;
    } catch (retryError) {
      pending += 1;
      await alertSettlementFailure(admin, {
        kind: reservation.action === "subscribe" ? "一級認購" : reservation.action === "redeem" ? "JC 贖回 USDT" : "金庫買 JC",
        refKey: `${reservation.action}:${reservation.request_key}`,
        stage: "自動重試待處理交割",
        error: errMsg(retryError),
        userId: reservation.user_id,
        assetId: reservation.asset_id,
        jcAmount: Number(reservation.jc_amount),
        usdtAmount: reservation.usdt_amount == null ? null : Number(reservation.usdt_amount),
        remedy: "系統將依已保存的 request key 與交易雜湊繼續重試；請勿建立重複交易。",
      });
    }
  }
  return { scanned: reservations?.length ?? 0, confirmed, pending };
}

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "shortMessage" in e && typeof (e as { shortMessage: unknown }).shortMessage === "string") {
    return (e as { shortMessage: string }).shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

// 機會式自動補發：Hobby 方案的 Vercel cron 最快只能每日一次，光靠 cron 無法讓
// 卡單與待派發分潤及時清掉。因此每當有 relayer 請求（認購 / 贖回 /
// 金庫買幣等平台活動）進來，就順手掃一小批——平台只要有人在用，就會在幾分鐘內自我修復，不需要人工
// 一直按「一鍵補發」。用 claim_sweep_slot 節流成全域最多每 ~90 秒一次，且整段
// best-effort，任何錯誤都吞掉，絕不影響觸發它的使用者本身的交易結果。
async function maybeOpportunisticSweep(admin: SupabaseClient): Promise<void> {
  try {
    const { data: claimed, error } = await admin.rpc("claim_sweep_slot", {
      p_key: "settle-sweep",
      p_min_interval_seconds: 90,
    });
    if (error || claimed !== true) return; // 沒搶到節流窗（或表尚未建立）→ 直接跳過
    // 每次只處理一小批，避免拖慢當前使用者請求或撞 serverless 逾時；剩下的由後續
    // 請求或每日 cron 接續處理。
  await sweepStuckSettlements(admin, 4).catch(async (error) => {
    await recordSystemError("opportunistic_settlement_sweep", errMsg(error)).catch(() => undefined);
  });
    await sweepPendingSettlementReservations(admin, 4).catch(async (error) => {
      await recordSystemError("opportunistic_reservation_sweep", errMsg(error)).catch(() => undefined);
    });
    await sweepPendingCommissions(admin, 8).catch(async (error) => {
      await recordSystemError("opportunistic_commission_sweep", errMsg(error)).catch(() => undefined);
    });
    await maybeMonitorHotWalletInventory(admin);
  } catch (error) {
    await recordSystemError("opportunistic_sweep", errMsg(error)).catch(() => undefined);
  }
}
