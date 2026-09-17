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
  executeRwaTrade,
  executeSubscription,
  mintJc,
  relayerAddress,
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
  return JSON.parse(raw || "{}") as { action?: string; requestKey?: string };
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

    const requestKey = body.requestKey;
    if (!requestKey || requestKey.length < 8) {
      return json(response, 400, { error: "缺少有效的 requestKey" });
    }

    // ---- 發放 JC（金庫買 JC 後，owner mintReward 到使用者錢包）----
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
      const amount = Number(ledgerRow.amount);
      if (!(amount > 0)) return json(response, 422, { error: "JC 數量無效" });
      const wallet = toAddress(callerProfile.wallet_address, "您的帳號");

      const claim = await claimSettlement(admin, {
        action: "mint_jc",
        ref_key: `mint_jc:${ledgerRow.id}`,
        user_id: caller.id,
        amount,
        payload: { requestKey, wallet },
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
      const placement = await admin
        .from("private_placements")
        .select("id,is_ae_token")
        .eq("id", ledgerRow.asset_id)
        .maybeSingle();
      if (placement.data?.is_ae_token) {
        return json(response, 409, { error: "AE 代幣尚未部署鏈上合約，維持沙盒帳本結算" });
      }
      const units = Number(ledgerRow.quantity);
      const gross = Number((ledgerRow.metadata as { gross?: number } | null)?.gross ?? Math.abs(Number(ledgerRow.amount)));
      if (!(units > 0) || !(gross > 0)) return json(response, 422, { error: "認購數量或金額無效" });
      const wallet = toAddress(callerProfile.wallet_address, "您的帳號");

      const claim = await claimSettlement(admin, {
        action: "subscribe",
        ref_key: `subscribe:${ledgerRow.id}`,
        user_id: caller.id,
        asset_id: ledgerRow.asset_id,
        amount: units,
        payment: gross,
        payload: { requestKey, wallet },
      });
      if ("done" in claim) return json(response, 200, { ...claim.done, idempotent: true });
      try {
        const txHash = await executeSubscription(wallet, units, gross);
        await finish(admin, claim.id, { status: "confirmed", tx_hash: txHash });
        return json(response, 200, { status: "confirmed", tx_hash: txHash, units, payment: gross });
      } catch (e) {
        await finish(admin, claim.id, { status: "failed", error: errMsg(e) });
        return json(response, 502, { error: `鏈上認購結算失敗：${errMsg(e)}` });
      }
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
      const meta = (buyRow.metadata as { gross?: number; counterparty_id?: string } | null) ?? {};
      const buyerId = buyRow.user_id as string;
      const sellerId = meta.counterparty_id;
      if (!sellerId) return json(response, 422, { error: "成交紀錄缺少對手方" });
      if (caller.id !== buyerId && caller.id !== sellerId) {
        return json(response, 403, { error: "只有成交雙方可觸發結算" });
      }
      const placement = await admin
        .from("private_placements")
        .select("id,is_ae_token")
        .eq("id", buyRow.asset_id)
        .maybeSingle();
      if (placement.data?.is_ae_token) {
        return json(response, 409, { error: "AE 代幣尚未部署鏈上合約，維持沙盒帳本結算" });
      }
      const units = Number(buyRow.quantity);
      const gross = Number(meta.gross);
      if (!(units > 0) || !(gross > 0)) return json(response, 422, { error: "成交數量或金額無效" });

      const parties = await admin
        .from("profiles")
        .select("id,wallet_address")
        .in("id", [buyerId, sellerId]);
      const buyerWallet = toAddress(parties.data?.find((p) => p.id === buyerId)?.wallet_address, "買方");
      const sellerWallet = toAddress(parties.data?.find((p) => p.id === sellerId)?.wallet_address, "賣方");

      const claim = await claimSettlement(admin, {
        action: "trade",
        ref_key: `trade:${buyRow.id}`,
        user_id: buyerId,
        counterparty_id: sellerId,
        asset_id: buyRow.asset_id,
        amount: units,
        payment: gross,
        payload: { requestKey, buyerWallet, sellerWallet },
      });
      if ("done" in claim) return json(response, 200, { ...claim.done, idempotent: true });
      try {
        const txHash = await executeRwaTrade(sellerWallet, buyerWallet, units, gross);
        await finish(admin, claim.id, { status: "confirmed", tx_hash: txHash });
        return json(response, 200, { status: "confirmed", tx_hash: txHash, units, payment: gross });
      } catch (e) {
        await finish(admin, claim.id, { status: "failed", error: errMsg(e) });
        return json(response, 502, { error: `鏈上成交結算失敗：${errMsg(e)}` });
      }
    }

    return json(response, 400, { error: `未知的 action: ${action}` });
  } catch (e) {
    return json(response, 500, { error: errMsg(e) });
  }
}

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "shortMessage" in e && typeof (e as { shortMessage: unknown }).shortMessage === "string") {
    return (e as { shortMessage: string }).shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}
