import type { IncomingMessage, ServerResponse } from "node:http";
import { answerCallbackQuery, isAuthorizedTelegramChat, performAutoRepair, sendTelegramMessage } from "./_telegram.js";

type TelegramUpdate = {
  callback_query?: { id?: string; data?: string; message?: { chat?: { id?: string | number } } };
  message?: { chat?: { id?: string | number }; text?: string };
};

function json(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

async function readBody(request: IncomingMessage) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 32_768) throw new Error("Payload too large");
  }
  return JSON.parse(raw || "{}") as TelegramUpdate;
}

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "POST") return json(response, 405, { error: "Method not allowed" });

  let update: TelegramUpdate;
  try {
    update = await readBody(request);
  } catch {
    return json(response, 400, { error: "Invalid update" });
  }

  const callback = update.callback_query;
  const chatId = callback?.message?.chat?.id ?? update.message?.chat?.id;
  if (!isAuthorizedTelegramChat(chatId)) return json(response, 403, { error: "Forbidden chat" });

  try {
    if (callback?.data === "repair_request") {
      if (callback.id) await answerCallbackQuery(callback.id, "維修功能已鎖定");
      await sendTelegramMessage("🔒 系統已鎖定，請輸入解鎖指令確認：<code>/repair 888666</code>", { parseMode: "HTML" });
      return json(response, 200, { ok: true });
    }

    if (callback?.data === "repair_decline") {
      if (callback.id) await answerCallbackQuery(callback.id, "已暫緩維修");
      await sendTelegramMessage("已暫緩自動維修，故障事件將保留待處理。");
      return json(response, 200, { ok: true });
    }

    const command = update.message?.text?.trim().match(/^\/repair(?:@\w+)?\s+(\S+)$/i);
    if (!command) return json(response, 200, { ok: true, ignored: true });

    const expectedPassword = process.env.TELEGRAM_REPAIR_PASSWORD ?? "888666";
    if (command[1] !== expectedPassword) {
      await sendTelegramMessage("❌ 密碼錯誤，拒絕執行維修作業。");
      return json(response, 200, { ok: true, repaired: false });
    }

    await sendTelegramMessage("✅ 密碼正確，已成功啟動自動維修！");
    await performAutoRepair();
    await sendTelegramMessage("✅ 維修已完成");
    return json(response, 200, { ok: true, repaired: true });
  } catch (error) {
    console.error("Telegram callback failed", error instanceof Error ? error.message : "unknown error");
    try { await sendTelegramMessage("維修程序執行失敗，請檢查系統紀錄。"); } catch { /* avoid recursive failure */ }
    return json(response, 500, { error: "Callback processing failed" });
  }
}
