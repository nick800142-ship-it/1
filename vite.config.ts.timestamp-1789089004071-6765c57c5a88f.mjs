var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// api/privy-session.ts
var privy_session_exports = {};
__export(privy_session_exports, {
  default: () => handler
});
import { createClient } from "file:///vercel/share/v0-project/node_modules/@supabase/supabase-js/dist/main/index.js";
import { createRemoteJWKSet, jwtVerify } from "file:///vercel/share/v0-project/node_modules/jose/dist/webapi/index.js";
function json(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}
async function readBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 32768) throw new Error("Payload too large");
  }
  return JSON.parse(raw || "{}");
}
async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return json(response, 405, { error: "Method not allowed" });
  }
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceKey || !appId || !jwks) {
    return json(response, 503, { error: "Privy session bridge is not configured" });
  }
  let identityToken;
  let accessToken;
  let clientEmail;
  let clientWallet;
  try {
    const body = await readBody(request);
    identityToken = body.identityToken;
    accessToken = body.accessToken;
    clientEmail = body.email;
    clientWallet = body.walletAddress;
  } catch {
    return json(response, 400, { error: "Invalid request body" });
  }
  if (!identityToken && !accessToken) {
    return json(response, 400, { error: "identityToken or accessToken required" });
  }
  let privyId = "";
  let email = null;
  let verifiedWallet = null;
  if (identityToken) {
    try {
      const { payload } = await jwtVerify(identityToken, jwks, {
        issuer: "privy.io",
        audience: appId
      });
      privyId = String(payload.sub ?? "");
      const rawLinked = payload.linked_accounts;
      const linked = typeof rawLinked === "string" ? JSON.parse(rawLinked) : [];
      const emailAccount = linked.find((account) => account.type === "email" && account.address);
      const googleAccount = linked.find((account) => account.type === "google_oauth" && account.email);
      email = (emailAccount?.address ?? googleAccount?.email ?? null)?.toLowerCase() ?? null;
      const embeddedWallet = linked.find(
        (account) => account.type === "wallet" && (account.wallet_client === "privy" || account.wallet_client_type === "privy") && isAddress(account.address)
      );
      if (embeddedWallet?.address) verifiedWallet = embeddedWallet.address;
    } catch {
      identityToken = void 0;
    }
  }
  if (!privyId && accessToken) {
    try {
      const { payload } = await jwtVerify(accessToken, jwks, {
        issuer: "privy.io",
        audience: appId
      });
      privyId = String(payload.sub ?? "");
    } catch {
      return json(response, 401, { error: "Invalid Privy token" });
    }
    if (!email && isEmail(clientEmail)) email = clientEmail.toLowerCase();
  }
  if (!privyId) return json(response, 401, { error: "Invalid Privy token" });
  if (!email) return json(response, 422, { error: "Privy account has no email to link" });
  const walletAddress = verifiedWallet ?? (isAddress(clientWallet) ? clientWallet : null);
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  let userId = null;
  const { data: existingProfile } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
  userId = existingProfile?.id ?? null;
  if (!userId) {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { privy_id: privyId }
    });
    if (created?.user) {
      userId = created.user.id;
    } else if (createError) {
      for (let page = 1; page <= 20 && !userId; page += 1) {
        const { data: list, error: listError } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        if (listError) break;
        const match = list.users.find((candidate) => candidate.email?.toLowerCase() === email);
        if (match) userId = match.id;
        if (list.users.length < 200) break;
      }
    }
  }
  if (!userId) return json(response, 500, { error: "Unable to resolve platform account" });
  const profilePayload = {
    id: userId,
    email,
    privy_id: privyId,
    updated_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (walletAddress) profilePayload.wallet_address = walletAddress;
  try {
    const { error: upsertError } = await admin.from("profiles").upsert(profilePayload, { onConflict: "id" });
    if (upsertError) {
      console.error("[v0] privy-session profile sync failed:", upsertError.message);
    }
  } catch (syncError) {
    console.error("[v0] privy-session profile sync threw:", syncError);
  }
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email
  });
  const tokenHash = linkData?.properties?.hashed_token;
  if (linkError || !tokenHash) {
    return json(response, 500, { error: "Unable to issue session" });
  }
  return json(response, 200, { tokenHash, email, walletAddress });
}
var isEmail, isAddress, appId, jwks;
var init_privy_session = __esm({
  "api/privy-session.ts"() {
    isEmail = (value) => typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    isAddress = (value) => typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
    appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "cmtory3qt01gc0dl83bbj4pcw";
    jwks = appId ? createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`)) : null;
  }
});

// api/translate.ts
var translate_exports = {};
__export(translate_exports, {
  config: () => config,
  default: () => handler2
});
import { generateText, Output } from "file:///vercel/share/v0-project/node_modules/ai/dist/index.js";
import { z } from "file:///vercel/share/v0-project/node_modules/zod/index.js";
async function handler2(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  if (!authorization.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: "Translation service unavailable" });
  const adminResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/is_current_user_admin`, {
    method: "POST",
    headers: { apikey: supabaseKey, Authorization: authorization, "Content-Type": "application/json" },
    body: "{}"
  });
  if (!adminResponse.ok || await adminResponse.json() !== true) return res.status(403).json({ error: "Forbidden" });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data.fields).length === 0) return res.status(400).json({ error: "Invalid content" });
  const requiredFields = parsed.data.kind === "asset" ? ["name", "location", "information"] : ["title", "content"];
  if (!requiredFields.every((field) => typeof parsed.data.fields[field] === "string")) return res.status(400).json({ error: "Missing fields" });
  const models = ["google/gemini-3.5-flash", "google/gemini-2.5-flash"];
  let lastError = "unknown error";
  for (const model of models) {
    try {
      const { output } = await generateText({
        model,
        output: Output.object({ schema: translationSchema }),
        prompt: `Translate the following Traditional Chinese ${parsed.data.kind} content into every target language. Return exactly all target language codes and exactly the original field keys. Every value whose source is non-empty must be a non-empty string; preserve an empty source value as an empty string. Preserve numbers, currency, property/project names, codes, URLs, paragraph breaks, and punctuation meaning. Do not add commentary.
Targets: ${languageCodes.map((code) => `${code}=${languageNames[code]}`).join(", ")}
Content: ${JSON.stringify(parsed.data.fields)}`
      });
      const complete = languageCodes.every(
        (code) => output.translations[code] && requiredFields.every((field) => {
          const sourceValue = parsed.data.fields[field]?.trim() ?? "";
          const value = output.translations[code][field];
          return typeof value === "string" && (!sourceValue || Boolean(value.trim())) && !value.includes("\uFFFD");
        })
      );
      if (!complete) throw new Error("Incomplete translation output");
      return res.status(200).json({ translations: { "zh-TW": parsed.data.fields, ...output.translations } });
    } catch (error) {
      lastError = error instanceof Error ? error.message : "unknown error";
    }
  }
  console.error("Translation generation failed after retry", lastError);
  return res.status(502).json({ error: "\u81EA\u52D5\u7FFB\u8B6F\u5931\u6557\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66" });
}
var languageCodes, languageNames, bodySchema, translatedFieldsSchema, translationSchema, config;
var init_translate = __esm({
  "api/translate.ts"() {
    languageCodes = ["zh-CN", "en", "ja", "ko", "th", "vi", "id", "ms", "es", "fr", "de", "pt", "ru", "ar", "hi"];
    languageNames = {
      "zh-CN": "Simplified Chinese",
      en: "English",
      ja: "Japanese",
      ko: "Korean",
      th: "Thai",
      vi: "Vietnamese",
      id: "Indonesian",
      ms: "Malay",
      es: "Spanish",
      fr: "French",
      de: "German",
      pt: "Portuguese",
      ru: "Russian",
      ar: "Arabic",
      hi: "Hindi"
    };
    bodySchema = z.object({
      kind: z.enum(["asset", "announcement"]),
      fields: z.record(z.enum(["name", "location", "information", "title", "content"]), z.string().max(5e3))
    });
    translatedFieldsSchema = z.object({
      name: z.string().optional(),
      location: z.string().optional(),
      information: z.string().optional(),
      title: z.string().optional(),
      content: z.string().optional()
    });
    translationSchema = z.object({
      translations: z.object(
        Object.fromEntries(
          languageCodes.map((code) => [code, translatedFieldsSchema])
        )
      )
    });
    config = { maxDuration: 60 };
  }
});

// vite.config.ts
import { defineConfig, loadEnv } from "file:///vercel/share/v0-project/node_modules/vite/dist/node/index.js";
import react from "file:///vercel/share/v0-project/node_modules/@vitejs/plugin-react/dist/index.mjs";
import { fileURLToPath, URL as URL2 } from "node:url";
var __vite_injected_original_import_meta_url = "file:///vercel/share/v0-project/vite.config.ts";
function privySessionApiPlugin() {
  return {
    name: "privy-session-api",
    configureServer(server) {
      server.middlewares.use("/api/privy-session", async (req, res) => {
        try {
          const { default: handler3 } = await Promise.resolve().then(() => (init_privy_session(), privy_session_exports));
          await handler3(req, res);
        } catch (error) {
          console.error("[v0] privy-session dev middleware error:", error);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Privy session bridge crashed in dev" }));
          }
        }
      });
    }
  };
}
function translationApiPlugin() {
  return {
    name: "translation-api",
    configureServer(server) {
      server.middlewares.use("/api/translate", async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const rawBody = Buffer.concat(chunks).toString("utf8");
        let body;
        try {
          body = rawBody ? JSON.parse(rawBody) : void 0;
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        const { default: handler3 } = await Promise.resolve().then(() => (init_translate(), translate_exports));
        const response = {
          status(code) {
            res.statusCode = code;
            return response;
          },
          json(value) {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(value));
          },
          setHeader(name, value) {
            res.setHeader(name, value);
          }
        };
        await handler3(
          {
            method: req.method,
            headers: req.headers,
            body
          },
          response
        );
      });
    }
  };
}
var vite_config_default = defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  Object.assign(process.env, env);
  return {
    plugins: [react(), privySessionApiPlugin(), translationApiPlugin()],
    define: {
      "process.env.NEXT_PUBLIC_SUPABASE_URL": JSON.stringify(env.NEXT_PUBLIC_SUPABASE_URL),
      "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": JSON.stringify(env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      "process.env.NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL": JSON.stringify(env.NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL),
      "process.env.NEXT_PUBLIC_PRIVY_APP_ID": JSON.stringify(env.NEXT_PUBLIC_PRIVY_APP_ID)
    },
    resolve: {
      alias: {
        "@": fileURLToPath(new URL2("./src", __vite_injected_original_import_meta_url))
      }
    },
    optimizeDeps: {
      exclude: ["lucide-react"]
    },
    server: {
      host: "0.0.0.0",
      hmr: {
        protocol: "wss",
        clientPort: 443
      }
    }
  };
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiYXBpL3ByaXZ5LXNlc3Npb24udHMiLCAiYXBpL3RyYW5zbGF0ZS50cyIsICJ2aXRlLmNvbmZpZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi92ZXJjZWwvc2hhcmUvdjAtcHJvamVjdC9hcGlcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi92ZXJjZWwvc2hhcmUvdjAtcHJvamVjdC9hcGkvcHJpdnktc2Vzc2lvbi50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vdmVyY2VsL3NoYXJlL3YwLXByb2plY3QvYXBpL3ByaXZ5LXNlc3Npb24udHNcIjtpbXBvcnQgdHlwZSB7IEluY29taW5nTWVzc2FnZSwgU2VydmVyUmVzcG9uc2UgfSBmcm9tIFwibm9kZTpodHRwXCI7XG5pbXBvcnQgeyBjcmVhdGVDbGllbnQgfSBmcm9tIFwiQHN1cGFiYXNlL3N1cGFiYXNlLWpzXCI7XG5pbXBvcnQgeyBjcmVhdGVSZW1vdGVKV0tTZXQsIGp3dFZlcmlmeSB9IGZyb20gXCJqb3NlXCI7XG5cbnR5cGUgTGlua2VkQWNjb3VudCA9IHtcbiAgdHlwZT86IHN0cmluZztcbiAgYWRkcmVzcz86IHN0cmluZztcbiAgZW1haWw/OiBzdHJpbmc7XG4gIHdhbGxldF9jbGllbnQ/OiBzdHJpbmc7XG4gIHdhbGxldF9jbGllbnRfdHlwZT86IHN0cmluZztcbiAgY2hhaW5fdHlwZT86IHN0cmluZztcbn07XG5cbmZ1bmN0aW9uIGpzb24ocmVzcG9uc2U6IFNlcnZlclJlc3BvbnNlLCBzdGF0dXM6IG51bWJlciwgcGF5bG9hZDogdW5rbm93bikge1xuICByZXNwb25zZS5zdGF0dXNDb2RlID0gc3RhdHVzO1xuICByZXNwb25zZS5zZXRIZWFkZXIoXCJDb250ZW50LVR5cGVcIiwgXCJhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04XCIpO1xuICByZXNwb25zZS5zZXRIZWFkZXIoXCJDYWNoZS1Db250cm9sXCIsIFwibm8tc3RvcmVcIik7XG4gIHJlc3BvbnNlLmVuZChKU09OLnN0cmluZ2lmeShwYXlsb2FkKSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlYWRCb2R5KHJlcXVlc3Q6IEluY29taW5nTWVzc2FnZSkge1xuICBsZXQgcmF3ID0gXCJcIjtcbiAgZm9yIGF3YWl0IChjb25zdCBjaHVuayBvZiByZXF1ZXN0KSB7XG4gICAgcmF3ICs9IGNodW5rO1xuICAgIGlmIChyYXcubGVuZ3RoID4gMzJfNzY4KSB0aHJvdyBuZXcgRXJyb3IoXCJQYXlsb2FkIHRvbyBsYXJnZVwiKTtcbiAgfVxuICByZXR1cm4gSlNPTi5wYXJzZShyYXcgfHwgXCJ7fVwiKSBhcyB7XG4gICAgaWRlbnRpdHlUb2tlbj86IHN0cmluZztcbiAgICBhY2Nlc3NUb2tlbj86IHN0cmluZztcbiAgICBlbWFpbD86IHN0cmluZztcbiAgICB3YWxsZXRBZGRyZXNzPzogc3RyaW5nO1xuICB9O1xufVxuXG5jb25zdCBpc0VtYWlsID0gKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgc3RyaW5nID0+XG4gIHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIiAmJiAvXlteXFxzQF0rQFteXFxzQF0rXFwuW15cXHNAXSskLy50ZXN0KHZhbHVlKTtcblxuY29uc3QgaXNBZGRyZXNzID0gKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgc3RyaW5nID0+XG4gIHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIiAmJiAvXjB4W2EtZkEtRjAtOV17NDB9JC8udGVzdCh2YWx1ZSk7XG5cbi8vIFByaXZ5IGlkZW50aXR5IHRva2VucyBhcmUgc2lnbmVkIHdpdGggdGhlIGFwcCdzIHB1YmxpYyBrZXksIHNvIHdlIGNhbiB2ZXJpZnlcbi8vIGVtYWlsICsgZW1iZWRkZWQgd2FsbGV0IGNsYWltcyB2aWEgdGhlIHB1YmxpYyBKV0tTIHdpdGhvdXQgYW55IGFwcCBzZWNyZXQuXG4vLyBGYWxscyBiYWNrIHRvIHRoZSBrbm93biBwcm9qZWN0IEFwcCBJRCB3aGVuIHRoZSBlbnYgdmFyIGlzbid0IG1pcnJvcmVkIGludG9cbi8vIHRoZSBsb2NhbCBkZXYgcHJvY2VzcyAoaXQgc3RpbGwgcmVhZHMgdGhlIGVudiB2YXIgZmlyc3QgaW4gcHJvZHVjdGlvbikuXG5jb25zdCBhcHBJZCA9IHByb2Nlc3MuZW52Lk5FWFRfUFVCTElDX1BSSVZZX0FQUF9JRCB8fCBcImNtdG9yeTNxdDAxZ2MwZGw4M2JiajRwY3dcIjtcbmNvbnN0IGp3a3MgPSBhcHBJZFxuICA/IGNyZWF0ZVJlbW90ZUpXS1NldChuZXcgVVJMKGBodHRwczovL2F1dGgucHJpdnkuaW8vYXBpL3YxL2FwcHMvJHthcHBJZH0vandrcy5qc29uYCkpXG4gIDogbnVsbDtcblxuZXhwb3J0IGRlZmF1bHQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlcihyZXF1ZXN0OiBJbmNvbWluZ01lc3NhZ2UsIHJlc3BvbnNlOiBTZXJ2ZXJSZXNwb25zZSkge1xuICBpZiAocmVxdWVzdC5tZXRob2QgIT09IFwiUE9TVFwiKSB7XG4gICAgcmVzcG9uc2Uuc2V0SGVhZGVyKFwiQWxsb3dcIiwgXCJQT1NUXCIpO1xuICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDUsIHsgZXJyb3I6IFwiTWV0aG9kIG5vdCBhbGxvd2VkXCIgfSk7XG4gIH1cblxuICBjb25zdCBzdXBhYmFzZVVybCA9IHByb2Nlc3MuZW52LlNVUEFCQVNFX1VSTDtcbiAgY29uc3Qgc2VydmljZUtleSA9IHByb2Nlc3MuZW52LlNVUEFCQVNFX1NFUlZJQ0VfUk9MRV9LRVkgPz8gcHJvY2Vzcy5lbnYuU1VQQUJBU0VfU0VDUkVUX0tFWTtcbiAgaWYgKCFzdXBhYmFzZVVybCB8fCAhc2VydmljZUtleSB8fCAhYXBwSWQgfHwgIWp3a3MpIHtcbiAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNTAzLCB7IGVycm9yOiBcIlByaXZ5IHNlc3Npb24gYnJpZGdlIGlzIG5vdCBjb25maWd1cmVkXCIgfSk7XG4gIH1cblxuICBsZXQgaWRlbnRpdHlUb2tlbjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBsZXQgYWNjZXNzVG9rZW46IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgbGV0IGNsaWVudEVtYWlsOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGxldCBjbGllbnRXYWxsZXQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgcmVhZEJvZHkocmVxdWVzdCk7XG4gICAgaWRlbnRpdHlUb2tlbiA9IGJvZHkuaWRlbnRpdHlUb2tlbjtcbiAgICBhY2Nlc3NUb2tlbiA9IGJvZHkuYWNjZXNzVG9rZW47XG4gICAgY2xpZW50RW1haWwgPSBib2R5LmVtYWlsO1xuICAgIGNsaWVudFdhbGxldCA9IGJvZHkud2FsbGV0QWRkcmVzcztcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMCwgeyBlcnJvcjogXCJJbnZhbGlkIHJlcXVlc3QgYm9keVwiIH0pO1xuICB9XG4gIGlmICghaWRlbnRpdHlUb2tlbiAmJiAhYWNjZXNzVG9rZW4pIHtcbiAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDAwLCB7IGVycm9yOiBcImlkZW50aXR5VG9rZW4gb3IgYWNjZXNzVG9rZW4gcmVxdWlyZWRcIiB9KTtcbiAgfVxuXG4gIC8vIDEuIEF1dGhlbnRpY2F0ZSB0aGUgcmVxdWVzdC4gUHJlZmVyIHRoZSBpZGVudGl0eSB0b2tlbiBcdTIwMTQgaXRzIHNpZ25lZFxuICAvLyAgICBjbGFpbXMgbGV0IHVzIHZlcmlmeSBlbWFpbCArIHdhbGxldCBzZXJ2ZXItc2lkZSB3aXRob3V0IHRydXN0aW5nIHRoZVxuICAvLyAgICBjbGllbnQuIElkZW50aXR5IHRva2VucyByZXF1aXJlIGEgUHJpdnkgRGFzaGJvYXJkIHRvZ2dsZSAoXCJSZXR1cm5cbiAgLy8gICAgdXNlciBkYXRhIGluIGFuIGlkZW50aXR5IHRva2VuXCIpLCBzbyBmYWxsIGJhY2sgdG8gdGhlIGFjY2VzcyB0b2tlblxuICAvLyAgICAoYWx3YXlzIGlzc3VlZCBmb3IgYW55IGF1dGhlbnRpY2F0ZWQgc2Vzc2lvbikgd2hlbiBpdCdzIHVuYXZhaWxhYmxlLlxuICAvLyAgICBUaGUgYWNjZXNzIHRva2VuIHN0aWxsIHByb3ZlcyBhIGdlbnVpbmUsIGN1cnJlbnQgUHJpdnkgc2Vzc2lvbiBmb3IgYVxuICAvLyAgICBzcGVjaWZpYyBESUQ7IHdlIGp1c3QgY2FuJ3QgcmVhZCBpdHMgbGlua2VkIGFjY291bnRzLCBzbyB3ZSB0cnVzdCB0aGVcbiAgLy8gICAgY2xpZW50LXN1cHBsaWVkIGVtYWlsL3dhbGxldCBpbiB0aGF0IHBhdGggaW5zdGVhZC5cbiAgbGV0IHByaXZ5SWQgPSBcIlwiO1xuICBsZXQgZW1haWw6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBsZXQgdmVyaWZpZWRXYWxsZXQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4gIGlmIChpZGVudGl0eVRva2VuKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgcGF5bG9hZCB9ID0gYXdhaXQgand0VmVyaWZ5KGlkZW50aXR5VG9rZW4sIGp3a3MsIHtcbiAgICAgICAgaXNzdWVyOiBcInByaXZ5LmlvXCIsXG4gICAgICAgIGF1ZGllbmNlOiBhcHBJZCxcbiAgICAgIH0pO1xuICAgICAgcHJpdnlJZCA9IFN0cmluZyhwYXlsb2FkLnN1YiA/PyBcIlwiKTtcbiAgICAgIGNvbnN0IHJhd0xpbmtlZCA9IHBheWxvYWQubGlua2VkX2FjY291bnRzO1xuICAgICAgY29uc3QgbGlua2VkOiBMaW5rZWRBY2NvdW50W10gPSB0eXBlb2YgcmF3TGlua2VkID09PSBcInN0cmluZ1wiID8gSlNPTi5wYXJzZShyYXdMaW5rZWQpIDogW107XG4gICAgICBjb25zdCBlbWFpbEFjY291bnQgPSBsaW5rZWQuZmluZCgoYWNjb3VudCkgPT4gYWNjb3VudC50eXBlID09PSBcImVtYWlsXCIgJiYgYWNjb3VudC5hZGRyZXNzKTtcbiAgICAgIGNvbnN0IGdvb2dsZUFjY291bnQgPSBsaW5rZWQuZmluZCgoYWNjb3VudCkgPT4gYWNjb3VudC50eXBlID09PSBcImdvb2dsZV9vYXV0aFwiICYmIGFjY291bnQuZW1haWwpO1xuICAgICAgZW1haWwgPSAoZW1haWxBY2NvdW50Py5hZGRyZXNzID8/IGdvb2dsZUFjY291bnQ/LmVtYWlsID8/IG51bGwpPy50b0xvd2VyQ2FzZSgpID8/IG51bGw7XG4gICAgICBjb25zdCBlbWJlZGRlZFdhbGxldCA9IGxpbmtlZC5maW5kKFxuICAgICAgICAoYWNjb3VudCkgPT5cbiAgICAgICAgICBhY2NvdW50LnR5cGUgPT09IFwid2FsbGV0XCIgJiZcbiAgICAgICAgICAoYWNjb3VudC53YWxsZXRfY2xpZW50ID09PSBcInByaXZ5XCIgfHwgYWNjb3VudC53YWxsZXRfY2xpZW50X3R5cGUgPT09IFwicHJpdnlcIikgJiZcbiAgICAgICAgICBpc0FkZHJlc3MoYWNjb3VudC5hZGRyZXNzKSxcbiAgICAgICk7XG4gICAgICBpZiAoZW1iZWRkZWRXYWxsZXQ/LmFkZHJlc3MpIHZlcmlmaWVkV2FsbGV0ID0gZW1iZWRkZWRXYWxsZXQuYWRkcmVzcztcbiAgICB9IGNhdGNoIHtcbiAgICAgIGlkZW50aXR5VG9rZW4gPSB1bmRlZmluZWQ7IC8vIGZhbGwgdGhyb3VnaCB0byB0aGUgYWNjZXNzLXRva2VuIHBhdGggYmVsb3dcbiAgICB9XG4gIH1cblxuICBpZiAoIXByaXZ5SWQgJiYgYWNjZXNzVG9rZW4pIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgeyBwYXlsb2FkIH0gPSBhd2FpdCBqd3RWZXJpZnkoYWNjZXNzVG9rZW4sIGp3a3MsIHtcbiAgICAgICAgaXNzdWVyOiBcInByaXZ5LmlvXCIsXG4gICAgICAgIGF1ZGllbmNlOiBhcHBJZCxcbiAgICAgIH0pO1xuICAgICAgcHJpdnlJZCA9IFN0cmluZyhwYXlsb2FkLnN1YiA/PyBcIlwiKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDEsIHsgZXJyb3I6IFwiSW52YWxpZCBQcml2eSB0b2tlblwiIH0pO1xuICAgIH1cbiAgICAvLyBObyBzaWduZWQgY2xhaW1zIHRvIHJlYWQgZnJvbSBhbiBhY2Nlc3MgdG9rZW4gXHUyMDE0IGFjY2VwdCB0aGUgY2xpZW50J3NcbiAgICAvLyByZXBvcnRlZCBlbWFpbC93YWxsZXQsIHNpbmNlIHJlYWNoaW5nIHRoaXMgcG9pbnQgYWxyZWFkeSByZXF1aXJlZCBhXG4gICAgLy8gdmFsaWQsIG5vbi1leHBpcmVkIFByaXZ5IHNlc3Npb24gdG9rZW4gZm9yIHRoaXMgYXBwLlxuICAgIGlmICghZW1haWwgJiYgaXNFbWFpbChjbGllbnRFbWFpbCkpIGVtYWlsID0gY2xpZW50RW1haWwudG9Mb3dlckNhc2UoKTtcbiAgfVxuXG4gIGlmICghcHJpdnlJZCkgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMSwgeyBlcnJvcjogXCJJbnZhbGlkIFByaXZ5IHRva2VuXCIgfSk7XG4gIGlmICghZW1haWwpIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MjIsIHsgZXJyb3I6IFwiUHJpdnkgYWNjb3VudCBoYXMgbm8gZW1haWwgdG8gbGlua1wiIH0pO1xuXG4gIC8vIE9ubHkgdHJ1c3QgdGhlIGNsaWVudC1zdXBwbGllZCB3YWxsZXQgd2hlbiBpdCBtYXRjaGVzIHRoZSB2ZXJpZmllZCBjbGFpbVxuICAvLyAoaWRlbnRpdHktdG9rZW4gcGF0aCkgb3IgcGFzc2VzIGJhc2ljIGFkZHJlc3MgdmFsaWRhdGlvbiAoZmFsbGJhY2sgcGF0aCkuXG4gIGNvbnN0IHdhbGxldEFkZHJlc3MgPVxuICAgIHZlcmlmaWVkV2FsbGV0ID8/IChpc0FkZHJlc3MoY2xpZW50V2FsbGV0KSA/IChjbGllbnRXYWxsZXQgYXMgc3RyaW5nKSA6IG51bGwpO1xuXG4gIGNvbnN0IGFkbWluID0gY3JlYXRlQ2xpZW50KHN1cGFiYXNlVXJsLCBzZXJ2aWNlS2V5LCB7XG4gICAgYXV0aDogeyBwZXJzaXN0U2Vzc2lvbjogZmFsc2UsIGF1dG9SZWZyZXNoVG9rZW46IGZhbHNlIH0sXG4gIH0pO1xuXG4gIC8vIDIuIFJlc29sdmUgKG9yIGNyZWF0ZSkgdGhlIFN1cGFiYXNlIGFjY291bnQgZm9yIHRoaXMgZW1haWwuXG4gIGxldCB1c2VySWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBjb25zdCB7IGRhdGE6IGV4aXN0aW5nUHJvZmlsZSB9ID0gYXdhaXQgYWRtaW5cbiAgICAuZnJvbShcInByb2ZpbGVzXCIpXG4gICAgLnNlbGVjdChcImlkXCIpXG4gICAgLmVxKFwiZW1haWxcIiwgZW1haWwpXG4gICAgLm1heWJlU2luZ2xlKCk7XG4gIHVzZXJJZCA9IGV4aXN0aW5nUHJvZmlsZT8uaWQgPz8gbnVsbDtcblxuICBpZiAoIXVzZXJJZCkge1xuICAgIGNvbnN0IHsgZGF0YTogY3JlYXRlZCwgZXJyb3I6IGNyZWF0ZUVycm9yIH0gPSBhd2FpdCBhZG1pbi5hdXRoLmFkbWluLmNyZWF0ZVVzZXIoe1xuICAgICAgZW1haWwsXG4gICAgICBlbWFpbF9jb25maXJtOiB0cnVlLFxuICAgICAgdXNlcl9tZXRhZGF0YTogeyBwcml2eV9pZDogcHJpdnlJZCB9LFxuICAgIH0pO1xuICAgIGlmIChjcmVhdGVkPy51c2VyKSB7XG4gICAgICB1c2VySWQgPSBjcmVhdGVkLnVzZXIuaWQ7XG4gICAgfSBlbHNlIGlmIChjcmVhdGVFcnJvcikge1xuICAgICAgLy8gVXNlciBtYXkgYWxyZWFkeSBleGlzdCBpbiBhdXRoIHdpdGhvdXQgYSBwcm9maWxlIHJvdzsgZmluZCB0aGVtIGJ5IHBhZ2luZy5cbiAgICAgIGZvciAobGV0IHBhZ2UgPSAxOyBwYWdlIDw9IDIwICYmICF1c2VySWQ7IHBhZ2UgKz0gMSkge1xuICAgICAgICBjb25zdCB7IGRhdGE6IGxpc3QsIGVycm9yOiBsaXN0RXJyb3IgfSA9IGF3YWl0IGFkbWluLmF1dGguYWRtaW4ubGlzdFVzZXJzKHsgcGFnZSwgcGVyUGFnZTogMjAwIH0pO1xuICAgICAgICBpZiAobGlzdEVycm9yKSBicmVhaztcbiAgICAgICAgY29uc3QgbWF0Y2ggPSBsaXN0LnVzZXJzLmZpbmQoKGNhbmRpZGF0ZSkgPT4gY2FuZGlkYXRlLmVtYWlsPy50b0xvd2VyQ2FzZSgpID09PSBlbWFpbCk7XG4gICAgICAgIGlmIChtYXRjaCkgdXNlcklkID0gbWF0Y2guaWQ7XG4gICAgICAgIGlmIChsaXN0LnVzZXJzLmxlbmd0aCA8IDIwMCkgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgaWYgKCF1c2VySWQpIHJldHVybiBqc29uKHJlc3BvbnNlLCA1MDAsIHsgZXJyb3I6IFwiVW5hYmxlIHRvIHJlc29sdmUgcGxhdGZvcm0gYWNjb3VudFwiIH0pO1xuXG4gIC8vIDMuIEJlc3QtZWZmb3J0IHN5bmMgb2YgdGhlIHJlYWwgUHJpdnkgd2FsbGV0ICsgUHJpdnkgaWQgb250byB0aGUgcHJvZmlsZS5cbiAgLy8gICAgQSBzeW5jIGZhaWx1cmUgbXVzdCBORVZFUiBibG9jayB0aGUgdXNlciBmcm9tIGVudGVyaW5nIHRoZSBwbGF0Zm9ybSxcbiAgLy8gICAgc28gd2UgdXBzZXJ0IChhdm9pZHMgZHVwbGljYXRlLWtleSBjcmFzaGVzKSBpbnNpZGUgdHJ5L2NhdGNoIGFuZCBvbmx5XG4gIC8vICAgIGxvZyBvbiBlcnJvciBiZWZvcmUgY29udGludWluZyB0byBpc3N1ZSB0aGUgc2Vzc2lvbi5cbiAgY29uc3QgcHJvZmlsZVBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIGlkOiB1c2VySWQsXG4gICAgZW1haWwsXG4gICAgcHJpdnlfaWQ6IHByaXZ5SWQsXG4gICAgdXBkYXRlZF9hdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICB9O1xuICBpZiAod2FsbGV0QWRkcmVzcykgcHJvZmlsZVBheWxvYWQud2FsbGV0X2FkZHJlc3MgPSB3YWxsZXRBZGRyZXNzO1xuICB0cnkge1xuICAgIGNvbnN0IHsgZXJyb3I6IHVwc2VydEVycm9yIH0gPSBhd2FpdCBhZG1pblxuICAgICAgLmZyb20oXCJwcm9maWxlc1wiKVxuICAgICAgLnVwc2VydChwcm9maWxlUGF5bG9hZCwgeyBvbkNvbmZsaWN0OiBcImlkXCIgfSk7XG4gICAgaWYgKHVwc2VydEVycm9yKSB7XG4gICAgICBjb25zb2xlLmVycm9yKFwiW3YwXSBwcml2eS1zZXNzaW9uIHByb2ZpbGUgc3luYyBmYWlsZWQ6XCIsIHVwc2VydEVycm9yLm1lc3NhZ2UpO1xuICAgIH1cbiAgfSBjYXRjaCAoc3luY0Vycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcihcIlt2MF0gcHJpdnktc2Vzc2lvbiBwcm9maWxlIHN5bmMgdGhyZXc6XCIsIHN5bmNFcnJvcik7XG4gIH1cblxuICAvLyA0LiBNaW50IGEgb25lLXRpbWUgdG9rZW4gdGhlIGJyb3dzZXIgY2FuIGV4Y2hhbmdlIGZvciBhIHJlYWwgU3VwYWJhc2Ugc2Vzc2lvbi5cbiAgY29uc3QgeyBkYXRhOiBsaW5rRGF0YSwgZXJyb3I6IGxpbmtFcnJvciB9ID0gYXdhaXQgYWRtaW4uYXV0aC5hZG1pbi5nZW5lcmF0ZUxpbmsoe1xuICAgIHR5cGU6IFwibWFnaWNsaW5rXCIsXG4gICAgZW1haWwsXG4gIH0pO1xuICBjb25zdCB0b2tlbkhhc2ggPSBsaW5rRGF0YT8ucHJvcGVydGllcz8uaGFzaGVkX3Rva2VuO1xuICBpZiAobGlua0Vycm9yIHx8ICF0b2tlbkhhc2gpIHtcbiAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNTAwLCB7IGVycm9yOiBcIlVuYWJsZSB0byBpc3N1ZSBzZXNzaW9uXCIgfSk7XG4gIH1cblxuICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IHRva2VuSGFzaCwgZW1haWwsIHdhbGxldEFkZHJlc3MgfSk7XG59XG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi92ZXJjZWwvc2hhcmUvdjAtcHJvamVjdC9hcGlcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi92ZXJjZWwvc2hhcmUvdjAtcHJvamVjdC9hcGkvdHJhbnNsYXRlLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy92ZXJjZWwvc2hhcmUvdjAtcHJvamVjdC9hcGkvdHJhbnNsYXRlLnRzXCI7aW1wb3J0IHsgZ2VuZXJhdGVUZXh0LCBPdXRwdXQgfSBmcm9tIFwiYWlcIjtcbmltcG9ydCB7IHogfSBmcm9tIFwiem9kXCI7XG5cbmNvbnN0IGxhbmd1YWdlQ29kZXMgPSBbXCJ6aC1DTlwiLCBcImVuXCIsIFwiamFcIiwgXCJrb1wiLCBcInRoXCIsIFwidmlcIiwgXCJpZFwiLCBcIm1zXCIsIFwiZXNcIiwgXCJmclwiLCBcImRlXCIsIFwicHRcIiwgXCJydVwiLCBcImFyXCIsIFwiaGlcIl0gYXMgY29uc3Q7XG5jb25zdCBsYW5ndWFnZU5hbWVzOiBSZWNvcmQ8KHR5cGVvZiBsYW5ndWFnZUNvZGVzKVtudW1iZXJdLCBzdHJpbmc+ID0ge1xuICBcInpoLUNOXCI6IFwiU2ltcGxpZmllZCBDaGluZXNlXCIsIGVuOiBcIkVuZ2xpc2hcIiwgamE6IFwiSmFwYW5lc2VcIiwga286IFwiS29yZWFuXCIsIHRoOiBcIlRoYWlcIiwgdmk6IFwiVmlldG5hbWVzZVwiLCBpZDogXCJJbmRvbmVzaWFuXCIsIG1zOiBcIk1hbGF5XCIsIGVzOiBcIlNwYW5pc2hcIiwgZnI6IFwiRnJlbmNoXCIsIGRlOiBcIkdlcm1hblwiLCBwdDogXCJQb3J0dWd1ZXNlXCIsIHJ1OiBcIlJ1c3NpYW5cIiwgYXI6IFwiQXJhYmljXCIsIGhpOiBcIkhpbmRpXCIsXG59O1xuY29uc3QgYm9keVNjaGVtYSA9IHoub2JqZWN0KHtcbiAga2luZDogei5lbnVtKFtcImFzc2V0XCIsIFwiYW5ub3VuY2VtZW50XCJdKSxcbiAgZmllbGRzOiB6LnJlY29yZCh6LmVudW0oW1wibmFtZVwiLCBcImxvY2F0aW9uXCIsIFwiaW5mb3JtYXRpb25cIiwgXCJ0aXRsZVwiLCBcImNvbnRlbnRcIl0pLCB6LnN0cmluZygpLm1heCg1MDAwKSksXG59KTtcbmNvbnN0IHRyYW5zbGF0ZWRGaWVsZHNTY2hlbWEgPSB6Lm9iamVjdCh7XG4gIG5hbWU6IHouc3RyaW5nKCkub3B0aW9uYWwoKSxcbiAgbG9jYXRpb246IHouc3RyaW5nKCkub3B0aW9uYWwoKSxcbiAgaW5mb3JtYXRpb246IHouc3RyaW5nKCkub3B0aW9uYWwoKSxcbiAgdGl0bGU6IHouc3RyaW5nKCkub3B0aW9uYWwoKSxcbiAgY29udGVudDogei5zdHJpbmcoKS5vcHRpb25hbCgpLFxufSk7XG5jb25zdCB0cmFuc2xhdGlvblNjaGVtYSA9IHoub2JqZWN0KHtcbiAgdHJhbnNsYXRpb25zOiB6Lm9iamVjdChcbiAgICBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgICBsYW5ndWFnZUNvZGVzLm1hcCgoY29kZSkgPT4gW2NvZGUsIHRyYW5zbGF0ZWRGaWVsZHNTY2hlbWFdKSxcbiAgICApIGFzIFJlY29yZDwodHlwZW9mIGxhbmd1YWdlQ29kZXMpW251bWJlcl0sIHR5cGVvZiB0cmFuc2xhdGVkRmllbGRzU2NoZW1hPixcbiAgKSxcbn0pO1xuXG5leHBvcnQgY29uc3QgY29uZmlnID0geyBtYXhEdXJhdGlvbjogNjAgfTtcblxudHlwZSBOb2RlUmVxdWVzdCA9IHsgbWV0aG9kPzogc3RyaW5nOyBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBzdHJpbmdbXSB8IHVuZGVmaW5lZD47IGJvZHk/OiB1bmtub3duIH07XG50eXBlIE5vZGVSZXNwb25zZSA9IHsgc3RhdHVzOiAoY29kZTogbnVtYmVyKSA9PiBOb2RlUmVzcG9uc2U7IGpzb246IChib2R5OiB1bmtub3duKSA9PiB2b2lkOyBzZXRIZWFkZXI6IChuYW1lOiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpID0+IHZvaWQgfTtcblxuZXhwb3J0IGRlZmF1bHQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlcihyZXE6IE5vZGVSZXF1ZXN0LCByZXM6IE5vZGVSZXNwb25zZSkge1xuICByZXMuc2V0SGVhZGVyKFwiQ2FjaGUtQ29udHJvbFwiLCBcIm5vLXN0b3JlXCIpO1xuICBpZiAocmVxLm1ldGhvZCAhPT0gXCJQT1NUXCIpIHJldHVybiByZXMuc3RhdHVzKDQwNSkuanNvbih7IGVycm9yOiBcIk1ldGhvZCBub3QgYWxsb3dlZFwiIH0pO1xuICBjb25zdCBhdXRob3JpemF0aW9uID0gdHlwZW9mIHJlcS5oZWFkZXJzLmF1dGhvcml6YXRpb24gPT09IFwic3RyaW5nXCIgPyByZXEuaGVhZGVycy5hdXRob3JpemF0aW9uIDogXCJcIjtcbiAgaWYgKCFhdXRob3JpemF0aW9uLnN0YXJ0c1dpdGgoXCJCZWFyZXIgXCIpKSByZXR1cm4gcmVzLnN0YXR1cyg0MDEpLmpzb24oeyBlcnJvcjogXCJVbmF1dGhvcml6ZWRcIiB9KTtcbiAgY29uc3Qgc3VwYWJhc2VVcmwgPSBwcm9jZXNzLmVudi5TVVBBQkFTRV9VUkwgPz8gcHJvY2Vzcy5lbnYuTkVYVF9QVUJMSUNfU1VQQUJBU0VfVVJMO1xuICBjb25zdCBzdXBhYmFzZUtleSA9IHByb2Nlc3MuZW52LlNVUEFCQVNFX0FOT05fS0VZID8/IHByb2Nlc3MuZW52Lk5FWFRfUFVCTElDX1NVUEFCQVNFX0FOT05fS0VZO1xuICBpZiAoIXN1cGFiYXNlVXJsIHx8ICFzdXBhYmFzZUtleSkgcmV0dXJuIHJlcy5zdGF0dXMoNTAwKS5qc29uKHsgZXJyb3I6IFwiVHJhbnNsYXRpb24gc2VydmljZSB1bmF2YWlsYWJsZVwiIH0pO1xuICBjb25zdCBhZG1pblJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYCR7c3VwYWJhc2VVcmx9L3Jlc3QvdjEvcnBjL2lzX2N1cnJlbnRfdXNlcl9hZG1pbmAsIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGhlYWRlcnM6IHsgYXBpa2V5OiBzdXBhYmFzZUtleSwgQXV0aG9yaXphdGlvbjogYXV0aG9yaXphdGlvbiwgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICBib2R5OiBcInt9XCIsXG4gIH0pO1xuICBpZiAoIWFkbWluUmVzcG9uc2Uub2sgfHwgKGF3YWl0IGFkbWluUmVzcG9uc2UuanNvbigpKSAhPT0gdHJ1ZSkgcmV0dXJuIHJlcy5zdGF0dXMoNDAzKS5qc29uKHsgZXJyb3I6IFwiRm9yYmlkZGVuXCIgfSk7XG4gIGNvbnN0IHBhcnNlZCA9IGJvZHlTY2hlbWEuc2FmZVBhcnNlKHJlcS5ib2R5KTtcbiAgaWYgKCFwYXJzZWQuc3VjY2VzcyB8fCBPYmplY3Qua2V5cyhwYXJzZWQuZGF0YS5maWVsZHMpLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHJlcy5zdGF0dXMoNDAwKS5qc29uKHsgZXJyb3I6IFwiSW52YWxpZCBjb250ZW50XCIgfSk7XG4gIGNvbnN0IHJlcXVpcmVkRmllbGRzID0gcGFyc2VkLmRhdGEua2luZCA9PT0gXCJhc3NldFwiID8gW1wibmFtZVwiLCBcImxvY2F0aW9uXCIsIFwiaW5mb3JtYXRpb25cIl0gOiBbXCJ0aXRsZVwiLCBcImNvbnRlbnRcIl07XG4gIGlmICghcmVxdWlyZWRGaWVsZHMuZXZlcnkoKGZpZWxkKSA9PiB0eXBlb2YgcGFyc2VkLmRhdGEuZmllbGRzW2ZpZWxkXSA9PT0gXCJzdHJpbmdcIikpIHJldHVybiByZXMuc3RhdHVzKDQwMCkuanNvbih7IGVycm9yOiBcIk1pc3NpbmcgZmllbGRzXCIgfSk7XG4gIGNvbnN0IG1vZGVscyA9IFtcImdvb2dsZS9nZW1pbmktMy41LWZsYXNoXCIsIFwiZ29vZ2xlL2dlbWluaS0yLjUtZmxhc2hcIl0gYXMgY29uc3Q7XG4gIGxldCBsYXN0RXJyb3IgPSBcInVua25vd24gZXJyb3JcIjtcbiAgZm9yIChjb25zdCBtb2RlbCBvZiBtb2RlbHMpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgeyBvdXRwdXQgfSA9IGF3YWl0IGdlbmVyYXRlVGV4dCh7XG4gICAgICAgIG1vZGVsLFxuICAgICAgICBvdXRwdXQ6IE91dHB1dC5vYmplY3QoeyBzY2hlbWE6IHRyYW5zbGF0aW9uU2NoZW1hIH0pLFxuICAgICAgICBwcm9tcHQ6IGBUcmFuc2xhdGUgdGhlIGZvbGxvd2luZyBUcmFkaXRpb25hbCBDaGluZXNlICR7cGFyc2VkLmRhdGEua2luZH0gY29udGVudCBpbnRvIGV2ZXJ5IHRhcmdldCBsYW5ndWFnZS4gUmV0dXJuIGV4YWN0bHkgYWxsIHRhcmdldCBsYW5ndWFnZSBjb2RlcyBhbmQgZXhhY3RseSB0aGUgb3JpZ2luYWwgZmllbGQga2V5cy4gRXZlcnkgdmFsdWUgd2hvc2Ugc291cmNlIGlzIG5vbi1lbXB0eSBtdXN0IGJlIGEgbm9uLWVtcHR5IHN0cmluZzsgcHJlc2VydmUgYW4gZW1wdHkgc291cmNlIHZhbHVlIGFzIGFuIGVtcHR5IHN0cmluZy4gUHJlc2VydmUgbnVtYmVycywgY3VycmVuY3ksIHByb3BlcnR5L3Byb2plY3QgbmFtZXMsIGNvZGVzLCBVUkxzLCBwYXJhZ3JhcGggYnJlYWtzLCBhbmQgcHVuY3R1YXRpb24gbWVhbmluZy4gRG8gbm90IGFkZCBjb21tZW50YXJ5LlxcblRhcmdldHM6ICR7bGFuZ3VhZ2VDb2Rlcy5tYXAoKGNvZGUpID0+IGAke2NvZGV9PSR7bGFuZ3VhZ2VOYW1lc1tjb2RlXX1gKS5qb2luKFwiLCBcIil9XFxuQ29udGVudDogJHtKU09OLnN0cmluZ2lmeShwYXJzZWQuZGF0YS5maWVsZHMpfWAsXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IGNvbXBsZXRlID0gbGFuZ3VhZ2VDb2Rlcy5ldmVyeShcbiAgICAgICAgKGNvZGUpID0+XG4gICAgICAgICAgb3V0cHV0LnRyYW5zbGF0aW9uc1tjb2RlXSAmJlxuICAgICAgICAgIHJlcXVpcmVkRmllbGRzLmV2ZXJ5KChmaWVsZCkgPT4ge1xuICAgICAgICAgICAgY29uc3Qgc291cmNlVmFsdWUgPSBwYXJzZWQuZGF0YS5maWVsZHNbZmllbGRdPy50cmltKCkgPz8gXCJcIjtcbiAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gb3V0cHV0LnRyYW5zbGF0aW9uc1tjb2RlXVtmaWVsZF07XG4gICAgICAgICAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiICYmICghc291cmNlVmFsdWUgfHwgQm9vbGVhbih2YWx1ZS50cmltKCkpKSAmJiAhdmFsdWUuaW5jbHVkZXMoXCJcdUZGRkRcIik7XG4gICAgICAgICAgfSksXG4gICAgICApO1xuICAgICAgaWYgKCFjb21wbGV0ZSkgdGhyb3cgbmV3IEVycm9yKFwiSW5jb21wbGV0ZSB0cmFuc2xhdGlvbiBvdXRwdXRcIik7XG4gICAgICByZXR1cm4gcmVzLnN0YXR1cygyMDApLmpzb24oeyB0cmFuc2xhdGlvbnM6IHsgXCJ6aC1UV1wiOiBwYXJzZWQuZGF0YS5maWVsZHMsIC4uLm91dHB1dC50cmFuc2xhdGlvbnMgfSB9KTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgbGFzdEVycm9yID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBcInVua25vd24gZXJyb3JcIjtcbiAgICB9XG4gIH1cbiAgY29uc29sZS5lcnJvcihcIlRyYW5zbGF0aW9uIGdlbmVyYXRpb24gZmFpbGVkIGFmdGVyIHJldHJ5XCIsIGxhc3RFcnJvcik7XG4gIHJldHVybiByZXMuc3RhdHVzKDUwMikuanNvbih7IGVycm9yOiBcIlx1ODFFQVx1NTJENVx1N0ZGQlx1OEI2Rlx1NTkzMVx1NjU1N1x1RkYwQ1x1OEFDQlx1N0EwRFx1NUY4Q1x1NTE4RFx1OEE2NlwiIH0pO1xufVxuIiwgImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvdmVyY2VsL3NoYXJlL3YwLXByb2plY3RcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi92ZXJjZWwvc2hhcmUvdjAtcHJvamVjdC92aXRlLmNvbmZpZy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vdmVyY2VsL3NoYXJlL3YwLXByb2plY3Qvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcsIGxvYWRFbnYgfSBmcm9tICd2aXRlJztcbmltcG9ydCByZWFjdCBmcm9tICdAdml0ZWpzL3BsdWdpbi1yZWFjdCc7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoLCBVUkwgfSBmcm9tICdub2RlOnVybCc7XG5pbXBvcnQgdHlwZSB7IFBsdWdpbiB9IGZyb20gJ3ZpdGUnO1xuXG5mdW5jdGlvbiBwcml2eVNlc3Npb25BcGlQbHVnaW4oKTogUGx1Z2luIHtcbiAgcmV0dXJuIHtcbiAgICBuYW1lOiAncHJpdnktc2Vzc2lvbi1hcGknLFxuICAgIGNvbmZpZ3VyZVNlcnZlcihzZXJ2ZXIpIHtcbiAgICAgIC8vIFRoZSBWZXJjZWwgc2VydmVybGVzcyBmdW5jdGlvbiBpbiBhcGkvcHJpdnktc2Vzc2lvbi50cyBpcyBub3QgZXhlY3V0ZWRcbiAgICAgIC8vIGJ5IGB2aXRlIGRldmAsIHNvIGJyaWRnZSBpdCBoZXJlIHVzaW5nIGl0cyBuYXRpdmUgKHJlcSwgcmVzKSBoYW5kbGVyLlxuICAgICAgc2VydmVyLm1pZGRsZXdhcmVzLnVzZSgnL2FwaS9wcml2eS1zZXNzaW9uJywgYXN5bmMgKHJlcSwgcmVzKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgeyBkZWZhdWx0OiBoYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoJy4vYXBpL3ByaXZ5LXNlc3Npb24nKTtcbiAgICAgICAgICBhd2FpdCBoYW5kbGVyKHJlcSwgcmVzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBjb25zb2xlLmVycm9yKCdbdjBdIHByaXZ5LXNlc3Npb24gZGV2IG1pZGRsZXdhcmUgZXJyb3I6JywgZXJyb3IpO1xuICAgICAgICAgIGlmICghcmVzLndyaXRhYmxlRW5kZWQpIHtcbiAgICAgICAgICAgIHJlcy5zdGF0dXNDb2RlID0gNTAwO1xuICAgICAgICAgICAgcmVzLnNldEhlYWRlcignQ29udGVudC1UeXBlJywgJ2FwcGxpY2F0aW9uL2pzb24nKTtcbiAgICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1ByaXZ5IHNlc3Npb24gYnJpZGdlIGNyYXNoZWQgaW4gZGV2JyB9KSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiB0cmFuc2xhdGlvbkFwaVBsdWdpbigpOiBQbHVnaW4ge1xuICByZXR1cm4ge1xuICAgIG5hbWU6ICd0cmFuc2xhdGlvbi1hcGknLFxuICAgIGNvbmZpZ3VyZVNlcnZlcihzZXJ2ZXIpIHtcbiAgICAgIHNlcnZlci5taWRkbGV3YXJlcy51c2UoJy9hcGkvdHJhbnNsYXRlJywgYXN5bmMgKHJlcSwgcmVzKSA9PiB7XG4gICAgICAgIGNvbnN0IGNodW5rczogQnVmZmVyW10gPSBbXTtcbiAgICAgICAgZm9yIGF3YWl0IChjb25zdCBjaHVuayBvZiByZXEpIGNodW5rcy5wdXNoKEJ1ZmZlci5mcm9tKGNodW5rKSk7XG4gICAgICAgIGNvbnN0IHJhd0JvZHkgPSBCdWZmZXIuY29uY2F0KGNodW5rcykudG9TdHJpbmcoJ3V0ZjgnKTtcbiAgICAgICAgbGV0IGJvZHk6IHVua25vd247XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYm9keSA9IHJhd0JvZHkgPyBKU09OLnBhcnNlKHJhd0JvZHkpIDogdW5kZWZpbmVkO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICByZXMuc3RhdHVzQ29kZSA9IDQwMDtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnZhbGlkIEpTT04nIH0pKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgeyBkZWZhdWx0OiBoYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoJy4vYXBpL3RyYW5zbGF0ZScpO1xuICAgICAgICBjb25zdCByZXNwb25zZSA9IHtcbiAgICAgICAgICBzdGF0dXMoY29kZTogbnVtYmVyKSB7XG4gICAgICAgICAgICByZXMuc3RhdHVzQ29kZSA9IGNvZGU7XG4gICAgICAgICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgICAgICAgfSxcbiAgICAgICAgICBqc29uKHZhbHVlOiB1bmtub3duKSB7XG4gICAgICAgICAgICByZXMuc2V0SGVhZGVyKCdDb250ZW50LVR5cGUnLCAnYXBwbGljYXRpb24vanNvbicpO1xuICAgICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xuICAgICAgICAgIH0sXG4gICAgICAgICAgc2V0SGVhZGVyKG5hbWU6IHN0cmluZywgdmFsdWU6IHN0cmluZykge1xuICAgICAgICAgICAgcmVzLnNldEhlYWRlcihuYW1lLCB2YWx1ZSk7XG4gICAgICAgICAgfSxcbiAgICAgICAgfTtcbiAgICAgICAgYXdhaXQgaGFuZGxlcihcbiAgICAgICAgICB7XG4gICAgICAgICAgICBtZXRob2Q6IHJlcS5tZXRob2QsXG4gICAgICAgICAgICBoZWFkZXJzOiByZXEuaGVhZGVycyxcbiAgICAgICAgICAgIGJvZHksXG4gICAgICAgICAgfSxcbiAgICAgICAgICByZXNwb25zZSxcbiAgICAgICAgKTtcbiAgICAgIH0pO1xuICAgIH0sXG4gIH07XG59XG5cbi8vIGh0dHBzOi8vdml0ZWpzLmRldi9jb25maWcvXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoKHsgbW9kZSB9KSA9PiB7XG4gIGNvbnN0IGVudiA9IGxvYWRFbnYobW9kZSwgcHJvY2Vzcy5jd2QoKSwgJycpO1xuICBPYmplY3QuYXNzaWduKHByb2Nlc3MuZW52LCBlbnYpO1xuICByZXR1cm4ge1xuICBwbHVnaW5zOiBbcmVhY3QoKSwgcHJpdnlTZXNzaW9uQXBpUGx1Z2luKCksIHRyYW5zbGF0aW9uQXBpUGx1Z2luKCldLFxuICBkZWZpbmU6IHtcbiAgICAncHJvY2Vzcy5lbnYuTkVYVF9QVUJMSUNfU1VQQUJBU0VfVVJMJzogSlNPTi5zdHJpbmdpZnkoZW52Lk5FWFRfUFVCTElDX1NVUEFCQVNFX1VSTCksXG4gICAgJ3Byb2Nlc3MuZW52Lk5FWFRfUFVCTElDX1NVUEFCQVNFX0FOT05fS0VZJzogSlNPTi5zdHJpbmdpZnkoZW52Lk5FWFRfUFVCTElDX1NVUEFCQVNFX0FOT05fS0VZKSxcbiAgICAncHJvY2Vzcy5lbnYuTkVYVF9QVUJMSUNfREVWX1NVUEFCQVNFX1JFRElSRUNUX1VSTCc6IEpTT04uc3RyaW5naWZ5KGVudi5ORVhUX1BVQkxJQ19ERVZfU1VQQUJBU0VfUkVESVJFQ1RfVVJMKSxcbiAgICAncHJvY2Vzcy5lbnYuTkVYVF9QVUJMSUNfUFJJVllfQVBQX0lEJzogSlNPTi5zdHJpbmdpZnkoZW52Lk5FWFRfUFVCTElDX1BSSVZZX0FQUF9JRCksXG4gIH0sXG4gIHJlc29sdmU6IHtcbiAgICBhbGlhczoge1xuICAgICAgJ0AnOiBmaWxlVVJMVG9QYXRoKG5ldyBVUkwoJy4vc3JjJywgaW1wb3J0Lm1ldGEudXJsKSksXG4gICAgfSxcbiAgfSxcbiAgb3B0aW1pemVEZXBzOiB7XG4gICAgZXhjbHVkZTogWydsdWNpZGUtcmVhY3QnXSxcbiAgfSxcbiAgc2VydmVyOiB7XG4gICAgaG9zdDogJzAuMC4wLjAnLFxuICAgIGhtcjoge1xuICAgICAgcHJvdG9jb2w6ICd3c3MnLFxuICAgICAgY2xpZW50UG9ydDogNDQzLFxuICAgIH0sXG4gIH0sXG59O1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7Ozs7Ozs7OztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQ0EsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxvQkFBb0IsaUJBQWlCO0FBVzlDLFNBQVMsS0FBSyxVQUEwQixRQUFnQixTQUFrQjtBQUN4RSxXQUFTLGFBQWE7QUFDdEIsV0FBUyxVQUFVLGdCQUFnQixpQ0FBaUM7QUFDcEUsV0FBUyxVQUFVLGlCQUFpQixVQUFVO0FBQzlDLFdBQVMsSUFBSSxLQUFLLFVBQVUsT0FBTyxDQUFDO0FBQ3RDO0FBRUEsZUFBZSxTQUFTLFNBQTBCO0FBQ2hELE1BQUksTUFBTTtBQUNWLG1CQUFpQixTQUFTLFNBQVM7QUFDakMsV0FBTztBQUNQLFFBQUksSUFBSSxTQUFTLE1BQVEsT0FBTSxJQUFJLE1BQU0sbUJBQW1CO0FBQUEsRUFDOUQ7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QUNOLHdDQUF3QyxLQUFLLFVBQVUsSUFBSSx3QkFBd0I7QUFBQSxNQUNuRiw2Q0FBNkMsS0FBSyxVQUFVLElBQUksNkJBQTZCO0FBQUEsTUFDN0YscURBQXFELEtBQUssVUFBVSxJQUFJLHFDQUFxQztBQUFBLE1BQzdHLHdDQUF3QyxLQUFLLFVBQVUsSUFBSSx3QkFBd0I7QUFBQSxJQUNyRjtBQUFBLElBQ0EsU0FBUztBQUFBLE1BQ1AsT0FBTztBQUFBLFFBQ0wsS0FBSyxjQUFjLElBQUlDLEtBQUksU0FBUyx3Q0FBZSxDQUFDO0FBQUEsTUFDdEQ7QUFBQSxJQUNGO0FBQUEsSUFDQSxjQUFjO0FBQUEsTUFDWixTQUFTLENBQUMsY0FBYztBQUFBLElBQzFCO0FBQUEsSUFDQSxRQUFRO0FBQUEsTUFDTixNQUFNO0FBQUEsTUFDTixLQUFLO0FBQUEsUUFDSCxVQUFVO0FBQUEsUUFDVixZQUFZO0FBQUEsTUFDZDtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0EsQ0FBQzsiLAogICJuYW1lcyI6IFsiaGFuZGxlciIsICJVUkwiLCAiaGFuZGxlciIsICJVUkwiXQp9Cg==
