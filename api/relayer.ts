// 後端 relayer：以「合約 owner」私鑰代發所有 onlyOwner 的鏈上結算交易。
//
// 為什麼需要它：JC/RWA 的 mint、一級認購 executeSubscription、二級市場
// executeTrade 都是 onlyOwner，瀏覽器端錢包無法呼叫；而二級市場撮合還需要
// 同時知道買賣雙方的錢包地址（前端刻意不回傳對手方身分）。因此改由後端用
// service_role 讀取 Supabase 帳本、在伺服器端推導金額與雙方地址後代發交易。
//
// 安全模型：
//  1. 只接受帶有有效 Supabase session token 的請求（getUser 驗證）。
//  2. 金額與對手方一律從既有 RPC 寫下的 jc_ledger 紀錄推導，絕不信任前端傳來的數字。
//  3. onchain_settlements 以 ref_key 做冪等，避免重複發幣 / 重複結算。
//  4. wire-contracts 僅限管理員（profiles.role）。
import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getAddress, type Address } from "viem";
import {
  ensureRelayerGas,
  executeAeTrade,
  executeRwaTrade,
  executeSubscription,
  mintAe,
  mintJc,
  pullJcToVault,
  relayerAddress,
  wireAeToken,
  wireRwaContracts,
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
  };
}

// 對齊站內既有的管理員判斷慣例（profiles.agency_role，見 AdminPage.tsx）。
const ADMIN_ROLES = new Set(["管理員", "admin"]);

function toAddress(value: unknown, label: string): Address {
  if (typeof value !== "string") throw new Error(`${label} 未綁定鏈上錢包`);
  try {
    return getAddress(value.trim());
  } catch {
    throw new Error(`${label} 錢包地址格式錯誤`);
  }
}

// 防呆防護：在任何 owner-only 鏈上交易（發幣 / 認購結算 / 成交結算）真正送出
// 之前，先確認 relayer 錢包還有足夠 ETH 付礦工費。刻意放在建立 onchain_settlements
// pending 列之前檢查，失敗時不消耗那筆 ref_key，讓管理員儲值後可以直接重試。
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
    json(response, 409, { error: "此標的已下架，鏈上結算已暫停，請聯繫客服處理" });
    return false;
  }
  if (placement.is_active === false) {
    json(response, 409, { error: "此標的目前未開放認購，鏈上結算已暫停，請聯繫客服處理" });
    return false;
  }
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
    if (retry.data?.status === "confirmed") return { done: { status: "confirmed", tx_hash: retry.data.tx_hash } };
    return { done: { status: "pending", tx_hash: retry.data?.tx_hash ?? null } };
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
    .select("id,is_ae_token")
    .eq("id", ledgerRow.asset_id)
    .maybeSingle();
  const isAe = !!placement.data?.is_ae_token;
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
    payload: { wallet, isAe },
  });
  if ("done" in claim) return json(response, 200, { ...claim.done, idempotent: true });
  try {
    if (isAe) {
      // AE 一級認購兩步：先把 buyer 的 JC transferFrom 到金庫，再 mint AE 給 buyer。
      // 用 payload.pullTx 記錄第一步是否完成，失敗重試（包含管理員補發）都不會重複扣 JC。
      const { data: srow } = await admin
        .from("onchain_settlements")
        .select("payload")
        .eq("id", claim.id)
        .maybeSingle();
      let pullTx = (srow?.payload as { pullTx?: string } | null)?.pullTx;
      if (!pullTx) {
        pullTx = await pullJcToVault(wallet, gross);
        await admin
          .from("onchain_settlements")
          .update({ payload: { wallet, isAe, pullTx }, updated_at: new Date().toISOString() })
          .eq("id", claim.id);
      }
      const mintTx = await mintAe(wallet, units);
      await finish(admin, claim.id, { status: "confirmed", tx_hash: mintTx });
      return json(response, 200, { status: "confirmed", tx_hash: mintTx, pullTx, units, payment: gross });
    }
    const txHash = await executeSubscription(wallet, units, gross);
    await finish(admin, claim.id, { status: "confirmed", tx_hash: txHash });
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
    .select("id,is_ae_token")
    .eq("id", buyRow.asset_id)
    .maybeSingle();
  const isAe = !!placement.data?.is_ae_token;
  const units = Number(buyRow.quantity);
  const gross = Number(meta.gross);
  if (!(units > 0) || !(gross > 0)) return json(response, 422, { error: "成交數量或金額無效" });

  const parties = await admin.from("profiles").select("id,wallet_address").in("id", [buyerId, sellerId]);
  let buyerWallet: Address;
  let sellerWallet: Address;
  try {
    buyerWallet = toAddress(parties.data?.find((p) => p.id === buyerId)?.wallet_address, "買方");
    sellerWallet = toAddress(parties.data?.find((p) => p.id === sellerId)?.wallet_address, "賣方");
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
    payload: { buyerWallet, sellerWallet, isAe },
  });
  if ("done" in claim) return json(response, 200, { ...claim.done, idempotent: true });
  try {
    const txHash = isAe
      ? await executeAeTrade(sellerWallet, buyerWallet, units, gross)
      : await executeRwaTrade(sellerWallet, buyerWallet, units, gross);
    await finish(admin, claim.id, { status: "confirmed", tx_hash: txHash });
    return json(response, 200, { status: "confirmed", tx_hash: txHash, units, payment: gross });
  } catch (e) {
    await finish(admin, claim.id, { status: "failed", error: errMsg(e) });
    return json(response, 502, { error: `鏈上成交結算失敗：${errMsg(e)}` });
  }
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
  if (!process.env.RELAYER_PRIVATE_KEY) {
    return json(response, 503, { error: "Relayer 尚未設定 RELAYER_PRIVATE_KEY（合約 owner 私鑰）" });
  }

  const authHeader = request.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return json(response, 401, { error: "缺少登入憑證" });

  let body: { action?: string; requestKey?: string };
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
    .select("id,agency_role,wallet_address")
    .eq("id", caller.id)
    .maybeSingle();
  if (!callerProfile) return json(response, 403, { error: "找不到平台帳號" });

  try {
    // ---- 一次性：把子合約位址寫進 RWA 母合約（僅限管理員）----
    if (action === "wire-contracts") {
      if (!ADMIN_ROLES.has(String(callerProfile.agency_role))) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const results = await wireRwaContracts();
      await admin.from("onchain_settlements").insert({
        action: "wire_contracts",
        ref_key: `wire_contracts:${Date.now()}`,
        user_id: caller.id,
        status: "confirmed",
        tx_hash: results.subscription !== "already-set" ? results.subscription : results.market,
        payload: results,
      });
      return json(response, 200, { ok: true, results, relayer: relayerAddress() });
    }

    // ---- 一次性：把 AE 代幣的授權市場指到新 AE 二級市場合約（僅限管理員）----
    if (action === "wire-ae-token") {
      if (!ADMIN_ROLES.has(String(callerProfile.agency_role))) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const results = await wireAeToken();
      await admin.from("onchain_settlements").insert({
        action: "wire_contracts",
        ref_key: `wire_ae_token:${Date.now()}`,
        user_id: caller.id,
        status: "confirmed",
        tx_hash: results.market !== "already-set" ? results.market : null,
        payload: results,
      });
      return json(response, 200, { ok: true, results, relayer: relayerAddress() });
    }

    // ---- 回傳 relayer（合約 owner）錢包地址 ----
    // AE 一級認購採兩步（relayer transferFrom buyer 的 JC），buyer 需 approve JC
    // 給這個地址，因此前端需要能查到它。僅需登入即可查詢，不含任何機密。
    if (action === "relayer-address") {
      return json(response, 200, { address: relayerAddress() });
    }

    const requestKey = body.requestKey;
    if (!requestKey || requestKey.length < 8) {
      return json(response, 400, { error: "缺少有效的 requestKey" });
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
        return json(response, 403, { error: "只有成交雙方可觸發結算" });
      }
      return settleTradeCore(admin, response, buyRow);
    }

    // ---- 管理員：列出需要人工關注的鏈上結算（失敗 / 卡在 pending 太久 / 站內
    // 已扣款但從未送出任何結算請求的「孤兒」紀錄）。三種來源都可能發生：使用
    // 者付款後瀏覽器關掉、fetch 被中斷、relayer 當下 gas 不足或標的被下架擋下。
    // 這份清單同時也是 cron sweep（見 findAttentionCandidates）自動補發的資料源，
    // 這裡只是額外把使用者/標的名稱查出來供後台顯示用。----
    if (action === "admin-list-settlements") {
      if (!ADMIN_ROLES.has(String(callerProfile.agency_role))) {
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
      if (!ADMIN_ROLES.has(String(callerProfile.agency_role))) {
        return json(response, 403, { error: "僅限管理員執行" });
      }
      const payload = body as { settlementId?: string; ledgerAction?: string; ledgerRowId?: string };
      let settleAction: "mint_jc" | "subscribe" | "trade";
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
        settleAction = settlement.action as "mint_jc" | "subscribe" | "trade";
        ledgerRowId = settlement.ref_key.slice(settleAction.length + 1);
      } else if (
        payload.ledgerRowId &&
        (payload.ledgerAction === "mint_jc" || payload.ledgerAction === "subscribe" || payload.ledgerAction === "trade")
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

type AttentionAction = "mint_jc" | "subscribe" | "trade";
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

  const [vaultRows, subRows, tradeRows, failedOrStale] = await Promise.all([
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
    admin
      .from("onchain_settlements")
      .select("id,action,ref_key,user_id,counterparty_id,asset_id,amount,payment,status,error,tx_hash,created_at,updated_at")
      .in("action", ["mint_jc", "subscribe", "trade"])
      .or(`status.eq.failed,and(status.eq.pending,updated_at.lt.${staleBefore})`)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const ledgerByAction: Record<AttentionAction, { id: string; user_id: string; asset_id?: string | null; amount: number; created_at: string }[]> = {
    mint_jc: (vaultRows.data ?? []) as never,
    subscribe: (subRows.data ?? []) as never,
    trade: (tradeRows.data ?? []) as never,
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

  return [...attentionNeeded, ...orphans];
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
): Promise<{ attempted: number; fixed: number; stillFailing: { ledgerRowId: string; action: AttentionAction; error: string }[] }> {
  const items = await findAttentionCandidates(admin);
  const stillFailing: { ledgerRowId: string; action: AttentionAction; error: string }[] = [];
  let attempted = 0;
  let fixed = 0;
  for (const item of items) {
    if (item.status === "stale_pending") {
      const ageMs = Date.now() - new Date(item.updatedAt ?? item.createdAt).getTime();
      if (ageMs < 2 * 60 * 1000) continue;
      await admin
        .from("onchain_settlements")
        .update({ status: "failed", error: "cron sweep 判定逾時卡���，已轉為失敗以便重試", updated_at: new Date().toISOString() })
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
        const message = (body && typeof body === "object" && "error" in body && String((body as { error: unknown }).error)) || `HTTP ${status}`;
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
