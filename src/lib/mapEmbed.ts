const GOOGLE_HOST = /^(www\.|maps\.)?google\.[a-z.]+$/i;
const SHORT_LINK_HOSTS = new Set(["maps.app.goo.gl", "goo.gl"]);

export type MapParseResult =
  | { kind: "map"; url: string }
  | { kind: "short" }
  | { kind: "none" };

function buildEmbedUrl(query: string, zoom?: string) {
  const params = new URLSearchParams({ q: query, hl: "zh-TW", output: "embed" });
  if (zoom) params.set("z", zoom);
  return `https://www.google.com/maps?${params.toString()}`;
}

function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment.replace(/\+/g, " "));
  } catch {
    return segment.replace(/\+/g, " ");
  }
}

export function isMapEmbedUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (!GOOGLE_HOST.test(url.hostname) || !url.pathname.startsWith("/maps")) return false;
    return url.pathname.startsWith("/maps/embed") || url.searchParams.get("output") === "embed";
  } catch {
    return false;
  }
}

export function parseMapInput(input: string): MapParseResult {
  let raw = input.trim();
  const iframeSrc = raw.match(/<iframe[^>]*\ssrc=["']([^"']+)["']/i);
  if (iframeSrc) raw = iframeSrc[1].replace(/&amp;/g, "&");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "none" };
  }
  if (url.protocol !== "https:") return { kind: "none" };

  if (SHORT_LINK_HOSTS.has(url.hostname)) return { kind: "short" };
  if (!GOOGLE_HOST.test(url.hostname) || !url.pathname.startsWith("/maps")) return { kind: "none" };

  if (isMapEmbedUrl(url.toString())) return { kind: "map", url: url.toString() };

  const zoom = url.pathname.match(/@-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?,(\d+(?:\.\d+)?)z/)?.[1];
  const coordinates = url.pathname.match(/@(-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?)/)?.[1];
  const placeName = url.pathname.match(/^\/maps\/(?:place|search)\/([^/@]+)/)?.[1];
  const queryParam = url.searchParams.get("q") ?? url.searchParams.get("query") ?? url.searchParams.get("destination");

  const query = queryParam ?? (placeName ? decodeSegment(placeName) : coordinates);
  if (!query) return { kind: "none" };
  return { kind: "map", url: buildEmbedUrl(query, zoom) };
}
