// After a deploy, a tab opened earlier still references the old hashed chunks.
// Those files are gone, so the SPA fallback answers with index.html and the
// dynamic import fails ("'text/html' is not a valid JavaScript MIME type").
// Reloading once picks up the new build instead of reporting it as an outage.
const STALE_BUILD_RELOAD_KEY = "rwmt-stale-build-reload-at";

export function isStaleBuildError(value: unknown) {
  const text = String(value ?? "");
  return (
    text.includes("is not a valid JavaScript MIME type") ||
    text.includes("Failed to fetch dynamically imported module") ||
    text.includes("error loading dynamically imported module") ||
    text.includes("Importing a module script failed") ||
    text.includes("Unable to preload CSS")
  );
}

/** Reloads at most once per minute so a genuinely broken deploy cannot loop. */
export function reloadForNewBuild() {
  try {
    const last = Number(sessionStorage.getItem(STALE_BUILD_RELOAD_KEY) ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(STALE_BUILD_RELOAD_KEY, String(Date.now()));
  } catch {
    // Storage can be unavailable (private mode); reloading once is still safe.
  }
  window.location.reload();
  return true;
}
