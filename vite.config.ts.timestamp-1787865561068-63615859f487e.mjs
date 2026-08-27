var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// api/translate.ts
var translate_exports = {};
__export(translate_exports, {
  config: () => config,
  default: () => handler
});
import { generateText, Output } from "file:///vercel/share/v0-project/node_modules/ai/dist/index.js";
import { z } from "file:///vercel/share/v0-project/node_modules/zod/index.js";
async function handler(req, res) {
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
import { fileURLToPath, URL } from "node:url";
var __vite_injected_original_import_meta_url = "file:///vercel/share/v0-project/vite.config.ts";
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
        const { default: handler2 } = await Promise.resolve().then(() => (init_translate(), translate_exports));
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
        await handler2(
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
    plugins: [react(), translationApiPlugin()],
    define: {
      "process.env.NEXT_PUBLIC_SUPABASE_URL": JSON.stringify(env.NEXT_PUBLIC_SUPABASE_URL),
      "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": JSON.stringify(env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      "process.env.NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL": JSON.stringify(env.NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL)
    },
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", __vite_injected_original_import_meta_url))
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiYXBpL3RyYW5zbGF0ZS50cyIsICJ2aXRlLmNvbmZpZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi92ZXJjZWwvc2hhcmUvdjAtcHJvamVjdC9hcGlcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi92ZXJjZWwvc2hhcmUvdjAtcHJvamVjdC9hcGkvdHJhbnNsYXRlLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy92ZXJjZWwvc2hhcmUvdjAtcHJvamVjdC9hcGkvdHJhbnNsYXRlLnRzXCI7aW1wb3J0IHsgZ2VuZXJhdGVUZXh0LCBPdXRwdXQgfSBmcm9tIFwiYWlcIjtcbmltcG9ydCB7IHogfSBmcm9tIFwiem9kXCI7XG5cbmNvbnN0IGxhbmd1YWdlQ29kZXMgPSBbXCJ6aC1DTlwiLCBcImVuXCIsIFwiamFcIiwgXCJrb1wiLCBcInRoXCIsIFwidmlcIiwgXCJpZFwiLCBcIm1zXCIsIFwiZXNcIiwgXCJmclwiLCBcImRlXCIsIFwicHRcIiwgXCJydVwiLCBcImFyXCIsIFwiaGlcIl0gYXMgY29uc3Q7XG5jb25zdCBsYW5ndWFnZU5hbWVzOiBSZWNvcmQ8KHR5cGVvZiBsYW5ndWFnZUNvZGVzKVtudW1iZXJdLCBzdHJpbmc+ID0ge1xuICBcInpoLUNOXCI6IFwiU2ltcGxpZmllZCBDaGluZXNlXCIsIGVuOiBcIkVuZ2xpc2hcIiwgamE6IFwiSmFwYW5lc2VcIiwga286IFwiS29yZWFuXCIsIHRoOiBcIlRoYWlcIiwgdmk6IFwiVmlldG5hbWVzZVwiLCBpZDogXCJJbmRvbmVzaWFuXCIsIG1zOiBcIk1hbGF5XCIsIGVzOiBcIlNwYW5pc2hcIiwgZnI6IFwiRnJlbmNoXCIsIGRlOiBcIkdlcm1hblwiLCBwdDogXCJQb3J0dWd1ZXNlXCIsIHJ1OiBcIlJ1c3NpYW5cIiwgYXI6IFwiQXJhYmljXCIsIGhpOiBcIkhpbmRpXCIsXG59O1xuY29uc3QgYm9keVNjaGVtYSA9IHoub2JqZWN0KHtcbiAga2luZDogei5lbnVtKFtcImFzc2V0XCIsIFwiYW5ub3VuY2VtZW50XCJdKSxcbiAgZmllbGRzOiB6LnJlY29yZCh6LmVudW0oW1wibmFtZVwiLCBcImxvY2F0aW9uXCIsIFwiaW5mb3JtYXRpb25cIiwgXCJ0aXRsZVwiLCBcImNvbnRlbnRcIl0pLCB6LnN0cmluZygpLm1heCg1MDAwKSksXG59KTtcbmNvbnN0IHRyYW5zbGF0ZWRGaWVsZHNTY2hlbWEgPSB6Lm9iamVjdCh7XG4gIG5hbWU6IHouc3RyaW5nKCkub3B0aW9uYWwoKSxcbiAgbG9jYXRpb246IHouc3RyaW5nKCkub3B0aW9uYWwoKSxcbiAgaW5mb3JtYXRpb246IHouc3RyaW5nKCkub3B0aW9uYWwoKSxcbiAgdGl0bGU6IHouc3RyaW5nKCkub3B0aW9uYWwoKSxcbiAgY29udGVudDogei5zdHJpbmcoKS5vcHRpb25hbCgpLFxufSk7XG5jb25zdCB0cmFuc2xhdGlvblNjaGVtYSA9IHoub2JqZWN0KHtcbiAgdHJhbnNsYXRpb25zOiB6Lm9iamVjdChcbiAgICBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgICBsYW5ndWFnZUNvZGVzLm1hcCgoY29kZSkgPT4gW2NvZGUsIHRyYW5zbGF0ZWRGaWVsZHNTY2hlbWFdKSxcbiAgICApIGFzIFJlY29yZDwodHlwZW9mIGxhbmd1YWdlQ29kZXMpW251bWJlcl0sIHR5cGVvZiB0cmFuc2xhdGVkRmllbGRzU2NoZW1hPixcbiAgKSxcbn0pO1xuXG5leHBvcnQgY29uc3QgY29uZmlnID0geyBtYXhEdXJhdGlvbjogNjAgfTtcblxudHlwZSBOb2RlUmVxdWVzdCA9IHsgbWV0aG9kPzogc3RyaW5nOyBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBzdHJpbmdbXSB8IHVuZGVmaW5lZD47IGJvZHk/OiB1bmtub3duIH07XG50eXBlIE5vZGVSZXNwb25zZSA9IHsgc3RhdHVzOiAoY29kZTogbnVtYmVyKSA9PiBOb2RlUmVzcG9uc2U7IGpzb246IChib2R5OiB1bmtub3duKSA9PiB2b2lkOyBzZXRIZWFkZXI6IChuYW1lOiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpID0+IHZvaWQgfTtcblxuZXhwb3J0IGRlZmF1bHQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlcihyZXE6IE5vZGVSZXF1ZXN0LCByZXM6IE5vZGVSZXNwb25zZSkge1xuICByZXMuc2V0SGVhZGVyKFwiQ2FjaGUtQ29udHJvbFwiLCBcIm5vLXN0b3JlXCIpO1xuICBpZiAocmVxLm1ldGhvZCAhPT0gXCJQT1NUXCIpIHJldHVybiByZXMuc3RhdHVzKDQwNSkuanNvbih7IGVycm9yOiBcIk1ldGhvZCBub3QgYWxsb3dlZFwiIH0pO1xuICBjb25zdCBhdXRob3JpemF0aW9uID0gdHlwZW9mIHJlcS5oZWFkZXJzLmF1dGhvcml6YXRpb24gPT09IFwic3RyaW5nXCIgPyByZXEuaGVhZGVycy5hdXRob3JpemF0aW9uIDogXCJcIjtcbiAgaWYgKCFhdXRob3JpemF0aW9uLnN0YXJ0c1dpdGgoXCJCZWFyZXIgXCIpKSByZXR1cm4gcmVzLnN0YXR1cyg0MDEpLmpzb24oeyBlcnJvcjogXCJVbmF1dGhvcml6ZWRcIiB9KTtcbiAgY29uc3Qgc3VwYWJhc2VVcmwgPSBwcm9jZXNzLmVudi5TVVBBQkFTRV9VUkwgPz8gcHJvY2Vzcy5lbnYuTkVYVF9QVUJMSUNfU1VQQUJBU0VfVVJMO1xuICBjb25zdCBzdXBhYmFzZUtleSA9IHByb2Nlc3MuZW52LlNVUEFCQVNFX0FOT05fS0VZID8/IHByb2Nlc3MuZW52Lk5FWFRfUFVCTElDX1NVUEFCQVNFX0FOT05fS0VZO1xuICBpZiAoIXN1cGFiYXNlVXJsIHx8ICFzdXBhYmFzZUtleSkgcmV0dXJuIHJlcy5zdGF0dXMoNTAwKS5qc29uKHsgZXJyb3I6IFwiVHJhbnNsYXRpb24gc2VydmljZSB1bmF2YWlsYWJsZVwiIH0pO1xuICBjb25zdCBhZG1pblJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYCR7c3VwYWJhc2VVcmx9L3Jlc3QvdjEvcnBjL2lzX2N1cnJlbnRfdXNlcl9hZG1pbmAsIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGhlYWRlcnM6IHsgYXBpa2V5OiBzdXBhYmFzZUtleSwgQXV0aG9yaXphdGlvbjogYXV0aG9yaXphdGlvbiwgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICBib2R5OiBcInt9XCIsXG4gIH0pO1xuICBpZiAoIWFkbWluUmVzcG9uc2Uub2sgfHwgKGF3YWl0IGFkbWluUmVzcG9uc2UuanNvbigpKSAhPT0gdHJ1ZSkgcmV0dXJuIHJlcy5zdGF0dXMoNDAzKS5qc29uKHsgZXJyb3I6IFwiRm9yYmlkZGVuXCIgfSk7XG4gIGNvbnN0IHBhcnNlZCA9IGJvZHlTY2hlbWEuc2FmZVBhcnNlKHJlcS5ib2R5KTtcbiAgaWYgKCFwYXJzZWQuc3VjY2VzcyB8fCBPYmplY3Qua2V5cyhwYXJzZWQuZGF0YS5maWVsZHMpLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHJlcy5zdGF0dXMoNDAwKS5qc29uKHsgZXJyb3I6IFwiSW52YWxpZCBjb250ZW50XCIgfSk7XG4gIGNvbnN0IHJlcXVpcmVkRmllbGRzID0gcGFyc2VkLmRhdGEua2luZCA9PT0gXCJhc3NldFwiID8gW1wibmFtZVwiLCBcImxvY2F0aW9uXCIsIFwiaW5mb3JtYXRpb25cIl0gOiBbXCJ0aXRsZVwiLCBcImNvbnRlbnRcIl07XG4gIGlmICghcmVxdWlyZWRGaWVsZHMuZXZlcnkoKGZpZWxkKSA9PiB0eXBlb2YgcGFyc2VkLmRhdGEuZmllbGRzW2ZpZWxkXSA9PT0gXCJzdHJpbmdcIikpIHJldHVybiByZXMuc3RhdHVzKDQwMCkuanNvbih7IGVycm9yOiBcIk1pc3NpbmcgZmllbGRzXCIgfSk7XG4gIGNvbnN0IG1vZGVscyA9IFtcImdvb2dsZS9nZW1pbmktMy41LWZsYXNoXCIsIFwiZ29vZ2xlL2dlbWluaS0yLjUtZmxhc2hcIl0gYXMgY29uc3Q7XG4gIGxldCBsYXN0RXJyb3IgPSBcInVua25vd24gZXJyb3JcIjtcbiAgZm9yIChjb25zdCBtb2RlbCBvZiBtb2RlbHMpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgeyBvdXRwdXQgfSA9IGF3YWl0IGdlbmVyYXRlVGV4dCh7XG4gICAgICAgIG1vZGVsLFxuICAgICAgICBvdXRwdXQ6IE91dHB1dC5vYmplY3QoeyBzY2hlbWE6IHRyYW5zbGF0aW9uU2NoZW1hIH0pLFxuICAgICAgICBwcm9tcHQ6IGBUcmFuc2xhdGUgdGhlIGZvbGxvd2luZyBUcmFkaXRpb25hbCBDaGluZXNlICR7cGFyc2VkLmRhdGEua2luZH0gY29udGVudCBpbnRvIGV2ZXJ5IHRhcmdldCBsYW5ndWFnZS4gUmV0dXJuIGV4YWN0bHkgYWxsIHRhcmdldCBsYW5ndWFnZSBjb2RlcyBhbmQgZXhhY3RseSB0aGUgb3JpZ2luYWwgZmllbGQga2V5cy4gRXZlcnkgdmFsdWUgd2hvc2Ugc291cmNlIGlzIG5vbi1lbXB0eSBtdXN0IGJlIGEgbm9uLWVtcHR5IHN0cmluZzsgcHJlc2VydmUgYW4gZW1wdHkgc291cmNlIHZhbHVlIGFzIGFuIGVtcHR5IHN0cmluZy4gUHJlc2VydmUgbnVtYmVycywgY3VycmVuY3ksIHByb3BlcnR5L3Byb2plY3QgbmFtZXMsIGNvZGVzLCBVUkxzLCBwYXJhZ3JhcGggYnJlYWtzLCBhbmQgcHVuY3R1YXRpb24gbWVhbmluZy4gRG8gbm90IGFkZCBjb21tZW50YXJ5LlxcblRhcmdldHM6ICR7bGFuZ3VhZ2VDb2Rlcy5tYXAoKGNvZGUpID0+IGAke2NvZGV9PSR7bGFuZ3VhZ2VOYW1lc1tjb2RlXX1gKS5qb2luKFwiLCBcIil9XFxuQ29udGVudDogJHtKU09OLnN0cmluZ2lmeShwYXJzZWQuZGF0YS5maWVsZHMpfWAsXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IGNvbXBsZXRlID0gbGFuZ3VhZ2VDb2Rlcy5ldmVyeShcbiAgICAgICAgKGNvZGUpID0+XG4gICAgICAgICAgb3V0cHV0LnRyYW5zbGF0aW9uc1tjb2RlXSAmJlxuICAgICAgICAgIHJlcXVpcmVkRmllbGRzLmV2ZXJ5KChmaWVsZCkgPT4ge1xuICAgICAgICAgICAgY29uc3Qgc291cmNlVmFsdWUgPSBwYXJzZWQuZGF0YS5maWVsZHNbZmllbGRdPy50cmltKCkgPz8gXCJcIjtcbiAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gb3V0cHV0LnRyYW5zbGF0aW9uc1tjb2RlXVtmaWVsZF07XG4gICAgICAgICAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiICYmICghc291cmNlVmFsdWUgfHwgQm9vbGVhbih2YWx1ZS50cmltKCkpKSAmJiAhdmFsdWUuaW5jbHVkZXMoXCJcdUZGRkRcIik7XG4gICAgICAgICAgfSksXG4gICAgICApO1xuICAgICAgaWYgKCFjb21wbGV0ZSkgdGhyb3cgbmV3IEVycm9yKFwiSW5jb21wbGV0ZSB0cmFuc2xhdGlvbiBvdXRwdXRcIik7XG4gICAgICByZXR1cm4gcmVzLnN0YXR1cygyMDApLmpzb24oeyB0cmFuc2xhdGlvbnM6IHsgXCJ6aC1UV1wiOiBwYXJzZWQuZGF0YS5maWVsZHMsIC4uLm91dHB1dC50cmFuc2xhdGlvbnMgfSB9KTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgbGFzdEVycm9yID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBcInVua25vd24gZXJyb3JcIjtcbiAgICB9XG4gIH1cbiAgY29uc29sZS5lcnJvcihcIlRyYW5zbGF0aW9uIGdlbmVyYXRpb24gZmFpbGVkIGFmdGVyIHJldHJ5XCIsIGxhc3RFcnJvcik7XG4gIHJldHVybiByZXMuc3RhdHVzKDUwMikuanNvbih7IGVycm9yOiBcIlx1ODFFQVx1NTJENVx1N0ZGQlx1OEI2Rlx1NTkzMVx1NjU1N1x1RkYwQ1x1OEFDQlx1N0EwRFx1NUY4Q1x1NTE4RFx1OEE2NlwiIH0pO1xufVxuIiwgImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvdmVyY2VsL3NoYXJlL3YwLXByb2plY3RcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi92ZXJjZWwvc2hhcmUvdjAtcHJvamVjdC92aXRlLmNvbmZpZy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vdmVyY2VsL3NoYXJlL3YwLXByb2plY3Qvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcsIGxvYWRFbnYgfSBmcm9tICd2aXRlJztcbmltcG9ydCByZWFjdCBmcm9tICdAdml0ZWpzL3BsdWdpbi1yZWFjdCc7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoLCBVUkwgfSBmcm9tICdub2RlOnVybCc7XG5pbXBvcnQgdHlwZSB7IFBsdWdpbiB9IGZyb20gJ3ZpdGUnO1xuXG5mdW5jdGlvbiB0cmFuc2xhdGlvbkFwaVBsdWdpbigpOiBQbHVnaW4ge1xuICByZXR1cm4ge1xuICAgIG5hbWU6ICd0cmFuc2xhdGlvbi1hcGknLFxuICAgIGNvbmZpZ3VyZVNlcnZlcihzZXJ2ZXIpIHtcbiAgICAgIHNlcnZlci5taWRkbGV3YXJlcy51c2UoJy9hcGkvdHJhbnNsYXRlJywgYXN5bmMgKHJlcSwgcmVzKSA9PiB7XG4gICAgICAgIGNvbnN0IGNodW5rczogQnVmZmVyW10gPSBbXTtcbiAgICAgICAgZm9yIGF3YWl0IChjb25zdCBjaHVuayBvZiByZXEpIGNodW5rcy5wdXNoKEJ1ZmZlci5mcm9tKGNodW5rKSk7XG4gICAgICAgIGNvbnN0IHJhd0JvZHkgPSBCdWZmZXIuY29uY2F0KGNodW5rcykudG9TdHJpbmcoJ3V0ZjgnKTtcbiAgICAgICAgbGV0IGJvZHk6IHVua25vd247XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYm9keSA9IHJhd0JvZHkgPyBKU09OLnBhcnNlKHJhd0JvZHkpIDogdW5kZWZpbmVkO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICByZXMuc3RhdHVzQ29kZSA9IDQwMDtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnZhbGlkIEpTT04nIH0pKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgeyBkZWZhdWx0OiBoYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoJy4vYXBpL3RyYW5zbGF0ZScpO1xuICAgICAgICBjb25zdCByZXNwb25zZSA9IHtcbiAgICAgICAgICBzdGF0dXMoY29kZTogbnVtYmVyKSB7XG4gICAgICAgICAgICByZXMuc3RhdHVzQ29kZSA9IGNvZGU7XG4gICAgICAgICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgICAgICAgfSxcbiAgICAgICAgICBqc29uKHZhbHVlOiB1bmtub3duKSB7XG4gICAgICAgICAgICByZXMuc2V0SGVhZGVyKCdDb250ZW50LVR5cGUnLCAnYXBwbGljYXRpb24vanNvbicpO1xuICAgICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xuICAgICAgICAgIH0sXG4gICAgICAgICAgc2V0SGVhZGVyKG5hbWU6IHN0cmluZywgdmFsdWU6IHN0cmluZykge1xuICAgICAgICAgICAgcmVzLnNldEhlYWRlcihuYW1lLCB2YWx1ZSk7XG4gICAgICAgICAgfSxcbiAgICAgICAgfTtcbiAgICAgICAgYXdhaXQgaGFuZGxlcihcbiAgICAgICAgICB7XG4gICAgICAgICAgICBtZXRob2Q6IHJlcS5tZXRob2QsXG4gICAgICAgICAgICBoZWFkZXJzOiByZXEuaGVhZGVycyxcbiAgICAgICAgICAgIGJvZHksXG4gICAgICAgICAgfSxcbiAgICAgICAgICByZXNwb25zZSxcbiAgICAgICAgKTtcbiAgICAgIH0pO1xuICAgIH0sXG4gIH07XG59XG5cbi8vIGh0dHBzOi8vdml0ZWpzLmRldi9jb25maWcvXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoKHsgbW9kZSB9KSA9PiB7XG4gIGNvbnN0IGVudiA9IGxvYWRFbnYobW9kZSwgcHJvY2Vzcy5jd2QoKSwgJycpO1xuICBPYmplY3QuYXNzaWduKHByb2Nlc3MuZW52LCBlbnYpO1xuICByZXR1cm4ge1xuICBwbHVnaW5zOiBbcmVhY3QoKSwgdHJhbnNsYXRpb25BcGlQbHVnaW4oKV0sXG4gIGRlZmluZToge1xuICAgICdwcm9jZXNzLmVudi5ORVhUX1BVQkxJQ19TVVBBQkFTRV9VUkwnOiBKU09OLnN0cmluZ2lmeShlbnYuTkVYVF9QVUJMSUNfU1VQQUJBU0VfVVJMKSxcbiAgICAncHJvY2Vzcy5lbnYuTkVYVF9QVUJMSUNfU1VQQUJBU0VfQU5PTl9LRVknOiBKU09OLnN0cmluZ2lmeShlbnYuTkVYVF9QVUJMSUNfU1VQQUJBU0VfQU5PTl9LRVkpLFxuICAgICdwcm9jZXNzLmVudi5ORVhUX1BVQkxJQ19ERVZfU1VQQUJBU0VfUkVESVJFQ1RfVVJMJzogSlNPTi5zdHJpbmdpZnkoZW52Lk5FWFRfUFVCTElDX0RFVl9TVVBBQkFTRV9SRURJUkVDVF9VUkwpLFxuICB9LFxuICByZXNvbHZlOiB7XG4gICAgYWxpYXM6IHtcbiAgICAgICdAJzogZmlsZVVSTFRvUGF0aChuZXcgVVJMKCcuL3NyYycsIGltcG9ydC5tZXRhLnVybCkpLFxuICAgIH0sXG4gIH0sXG4gIG9wdGltaXplRGVwczoge1xuICAgIGV4Y2x1ZGU6IFsnbHVjaWRlLXJlYWN0J10sXG4gIH0sXG4gIHNlcnZlcjoge1xuICAgIGhvc3Q6ICcwLjAuMC4wJyxcbiAgICBobXI6IHtcbiAgICAgIHByb3RvY29sOiAnd3NzJyxcbiAgICAgIGNsaWVudFBvcnQ6IDQ0MyxcbiAgICB9LFxuICB9LFxufTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjs7Ozs7Ozs7Ozs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQWtRLFNBQVMsY0FBYyxjQUFjO0FBQ3ZTLFNBQVMsU0FBUztBQThCbEIsZUFBTyxRQUErQixLQUFrQixLQUFtQjtBQUN6RSxNQUFJLFVBQVUsaUJBQWlCLFVBQVU7QUFDekMsTUFBSSxJQUFJLFdBQVcsT0FBUSxRQUFPLElBQUksT0FBTyxHQUFHLEVBQUUsS0FBSyxFQUFF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
