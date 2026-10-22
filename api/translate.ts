import { z } from "zod";

type AiModule = typeof import("ai");
let aiModulePromise: Promise<AiModule> | undefined;
const loadAiModule = () => (aiModulePromise ??= import("ai"));
import { recordSystemError } from "./_telegram.js";

const languageCodes = ["zh-TW", "zh-CN", "en", "ja", "ko", "th", "vi", "id", "ms", "es", "fr", "de", "pt", "ru", "ar", "hi"] as const;
const languageNames: Record<(typeof languageCodes)[number], string> = {
  "zh-TW": "Traditional Chinese", "zh-CN": "Simplified Chinese", en: "English", ja: "Japanese", ko: "Korean", th: "Thai", vi: "Vietnamese", id: "Indonesian", ms: "Malay", es: "Spanish", fr: "French", de: "German", pt: "Portuguese", ru: "Russian", ar: "Arabic", hi: "Hindi",
};
const bodySchema = z.object({
  kind: z.enum(["asset", "announcement"]),
  fields: z.record(
    z.string(),
    z.union([z.string().max(5000), z.array(z.string().max(2000)).max(20)]),
  ),
}).superRefine((value, context) => {
  const allowedFields = new Set(["name", "location", "information", "title", "content", "history", "comparables", "advantages"]);
  for (const field of Object.keys(value.fields)) {
    if (!allowedFields.has(field)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["fields", field], message: "Unsupported field" });
    }
  }
});
const translatedFieldsSchema = z.object({
  name: z.string().optional(),
  location: z.string().optional(),
  information: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  history: z.array(z.string()).optional(),
  comparables: z.array(z.string()).optional(),
  advantages: z.array(z.string()).optional(),
});
const translationSchema = z.object({
  translations: z.object(
    Object.fromEntries(
      languageCodes.map((code) => [code, translatedFieldsSchema]),
    ) as Record<(typeof languageCodes)[number], typeof translatedFieldsSchema>,
  ),
});

export const config = { maxDuration: 120 };

type NodeRequest = { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown };
type NodeResponse = { status: (code: number) => NodeResponse; json: (body: unknown) => void; setHeader: (name: string, value: string) => void };

export default async function handler(req: NodeRequest, res: NodeResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  if (!authorization.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  const environment = (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env ?? {};
  const supabaseUrl = environment.SUPABASE_URL ?? environment.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = environment.SUPABASE_ANON_KEY ?? environment.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    await recordSystemError("api/translate", "Translation service is not configured");
    return res.status(500).json({ error: "Translation service unavailable" });
  }
  const adminResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/is_current_user_admin`, {
    method: "POST",
    headers: { apikey: supabaseKey, Authorization: authorization, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!adminResponse.ok || (await adminResponse.json()) !== true) return res.status(403).json({ error: "Forbidden" });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data.fields).length === 0) return res.status(400).json({ error: "Invalid content" });
  const requiredFields =
    parsed.data.kind === "asset"
      ? ["name", "location", "information", "history", "comparables", "advantages"]
      : ["title", "content"];
  const arrayFields = new Set(["history", "comparables", "advantages"]);
  if (
    !requiredFields.every((field) => {
      const value = parsed.data.fields[field];
      return arrayFields.has(field) ? Array.isArray(value) : typeof value === "string";
    })
  ) {
    return res.status(400).json({ error: "Missing fields" });
  }
  const models = ["google/gemini-2.5-flash", "google/gemini-3.5-flash"] as const;
  let lastError = "unknown error";
  for (const model of models) {
    try {
      const { generateText, Output } = await loadAiModule();
      const generated = await generateText({
        model,
        output: Output.object({ schema: translationSchema }),
        prompt: `Translate the following ${parsed.data.kind} content into every target language. The source text may be written in ANY language (for example Traditional Chinese, English, Japanese); detect it automatically. For the target language that matches the source language, return the source text verbatim without rewording. Return exactly all target language codes and exactly the original field keys. For string fields, preserve an empty source as an empty string and translate every non-empty source. For list fields, preserve list length and order, translating each item; preserve an empty list as an empty list. Preserve numbers, currency, property/project names, codes, URLs, paragraph breaks, blank lines, line breaks, list markers, indentation, and punctuation meaning exactly. Do not merge paragraphs, reflow lines, remove blank lines, or add commentary.\nTargets: ${languageCodes.map((code) => `${code}=${languageNames[code]}`).join(", ")}\nContent: ${JSON.stringify(parsed.data.fields)}`,
      });
      const output = translationSchema.parse(generated.output);
      const normalizedTranslations = Object.fromEntries(
        languageCodes.map((code) => {
          const generatedFields = output.translations[code];
          const normalizedFields = Object.fromEntries(
            Object.entries(parsed.data.fields).map(([field, sourceValue]) => {
              const generatedValue = generatedFields[field as keyof typeof generatedFields];
              if (typeof sourceValue === "string") {
                return [field, sourceValue.trim() ? generatedValue ?? "" : ""];
              }

              const generatedItems = Array.isArray(generatedValue) ? generatedValue : [];
              if (generatedItems.length !== sourceValue.length) {
                return [
                  field,
                  sourceValue.every((item) => !item.trim()) ? [...sourceValue] : [],
                ];
              }
              return [
                field,
                sourceValue.map((item, index) =>
                  item.trim() ? generatedItems[index] : item,
                ),
              ];
            }),
          );
          return [code, normalizedFields];
        }),
      ) as Record<(typeof languageCodes)[number], Record<string, string | string[]>>;
      const complete = languageCodes.every((code) =>
        requiredFields.every((field) => {
          const sourceValue = parsed.data.fields[field];
          const value = normalizedTranslations[code][field];
          if (Array.isArray(sourceValue)) {
            return (
              Array.isArray(value) &&
              value.length === sourceValue.length &&
              value.every((item) => !item.includes("\ufffd")) &&
              sourceValue.every((item, index) => !item.trim() || Boolean(value[index]?.trim()))
            );
          }
          const sourceText = typeof sourceValue === "string" ? sourceValue.trim() : "";
          return typeof value === "string" && (!sourceText || Boolean(value.trim())) && !value.includes("\ufffd");
        }),
      );
      if (!complete) throw new Error("Incomplete translation output");
      return res.status(200).json({ translations: normalizedTranslations });
    } catch (error) {
      lastError = error instanceof Error ? error.message : "unknown error";
    }
  }
  console.error("[v0] Translation generation failed after retry", lastError);
  await recordSystemError("api/translate", lastError);
  return res.status(502).json({
    error: `自動翻譯未能完成全部語言，資料尚未儲存：${lastError}`,
  });
}
