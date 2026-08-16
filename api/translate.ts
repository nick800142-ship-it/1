import { generateText, Output } from "ai";
import { z } from "zod";

const languageCodes = ["zh-CN", "en", "ja", "ko", "th", "vi", "id", "ms", "es", "fr", "de", "pt", "ru", "ar", "hi"] as const;
const languageNames: Record<(typeof languageCodes)[number], string> = {
  "zh-CN": "Simplified Chinese", en: "English", ja: "Japanese", ko: "Korean", th: "Thai", vi: "Vietnamese", id: "Indonesian", ms: "Malay", es: "Spanish", fr: "French", de: "German", pt: "Portuguese", ru: "Russian", ar: "Arabic", hi: "Hindi",
};
const bodySchema = z.object({
  kind: z.enum(["asset", "announcement"]),
  fields: z.record(z.enum(["name", "location", "information", "title", "content"]), z.string().max(5000)),
});
const translatedFieldsSchema = z.object({
  name: z.string().optional(),
  location: z.string().optional(),
  information: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
});
const translationSchema = z.object({
  translations: z.object(
    Object.fromEntries(
      languageCodes.map((code) => [code, translatedFieldsSchema]),
    ) as Record<(typeof languageCodes)[number], typeof translatedFieldsSchema>,
  ),
});

export const config = { maxDuration: 60 };

type NodeRequest = { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown };
type NodeResponse = { status: (code: number) => NodeResponse; json: (body: unknown) => void; setHeader: (name: string, value: string) => void };

export default async function handler(req: NodeRequest, res: NodeResponse) {
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
    body: "{}",
  });
  if (!adminResponse.ok || (await adminResponse.json()) !== true) return res.status(403).json({ error: "Forbidden" });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data.fields).length === 0) return res.status(400).json({ error: "Invalid content" });
  const requiredFields = parsed.data.kind === "asset" ? ["name", "location", "information"] : ["title", "content"];
  if (!requiredFields.every((field) => typeof parsed.data.fields[field] === "string")) return res.status(400).json({ error: "Missing fields" });
  try {
    const { output } = await generateText({
      model: "google/gemini-2.5-flash",
      output: Output.object({ schema: translationSchema }),
      prompt: `Translate the following Traditional Chinese ${parsed.data.kind} content into every target language. Return exactly all target language codes and exactly the original field keys. Preserve numbers, currency, property/project names, codes, URLs, paragraph breaks, and punctuation meaning. Do not add commentary.\nTargets: ${languageCodes.map((code) => `${code}=${languageNames[code]}`).join(", ")}\nContent: ${JSON.stringify(parsed.data.fields)}`,
    });
    if (
      !languageCodes.every(
        (code) =>
          output.translations[code] &&
          requiredFields.every(
            (field) =>
              typeof output.translations[code][field] === "string" &&
              output.translations[code][field]?.trim() &&
              !output.translations[code][field]?.includes("�"),
          ),
      )
    )
      throw new Error("Incomplete translation output");
    return res.status(200).json({ translations: { "zh-TW": parsed.data.fields, ...output.translations } });
  } catch (error) {
    console.error("Translation generation failed", error instanceof Error ? error.message : "unknown error");
    return res.status(502).json({ error: "自動翻譯失敗，請稍後再試" });
  }
}
