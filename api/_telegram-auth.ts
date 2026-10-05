import type { IncomingMessage } from "node:http";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getAdminClient } from "./_telegram.js";

export type TelegramAuthenticatedRequest = {
  admin: SupabaseClient;
  user: User;
  profile: { agency_role: string | null; role: string | null } | null;
};

export async function authenticateTelegramRequest(request: IncomingMessage): Promise<TelegramAuthenticatedRequest | null> {
  const authorization = request.headers.authorization;
  const token = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!token?.startsWith("Bearer ")) return null;
  const admin = getAdminClient();
  const { data, error } = await admin.auth.getUser(token.slice(7));
  if (error || !data.user) return null;
  const { data: profile } = await admin
    .from("profiles")
    .select("agency_role,role")
    .eq("id", data.user.id)
    .maybeSingle();
  return { admin, user: data.user, profile };
}

export function isTelegramAdmin(profile: TelegramAuthenticatedRequest["profile"]) {
  return Boolean(
    ["admin", "super_admin", "管理員"].includes(profile?.agency_role ?? "") ||
    ["admin", "super_admin"].includes(profile?.role ?? ""),
  );
}

export function readJsonBody<T>(request: IncomingMessage, maximumBytes = 16_384): Promise<T> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk: Buffer | string) => {
      raw += chunk.toString();
      if (raw.length > maximumBytes) reject(new Error("Payload too large"));
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}") as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

export function jsonResponse(response: import("node:http").ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

export const TELEGRAM_BOT_LABEL = "RWMT Telegram";
void TELEGRAM_BOT_LABEL;
