import { useEffect } from "react";

const VERSION_CHECK_INTERVAL_MS = 2_000;
const VERSION_ENDPOINT = "/api/app-version";

export function useAutoVersionReload() {
  useEffect(() => {
    if (import.meta.env.DEV) return;

    let requestInFlight = false;
    let reloadStarted = false;

    const checkForNewVersion = async () => {
      if (requestInFlight || reloadStarted) return;
      requestInFlight = true;

      try {
        const response = await fetch(VERSION_ENDPOINT, {
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return;

        const payload: unknown = await response.json();
        if (
          typeof payload !== "object" ||
          payload === null ||
          !("version" in payload) ||
          typeof payload.version !== "string" ||
          payload.version.length === 0
        ) {
          return;
        }

        if (payload.version !== __APP_VERSION__) {
          reloadStarted = true;
          window.location.reload();
        }
      } catch {
        // Retry on the next poll if the network or version endpoint is unavailable.
      } finally {
        requestInFlight = false;
      }
    };

    void checkForNewVersion();
    const interval = window.setInterval(
      () => void checkForNewVersion(),
      VERSION_CHECK_INTERVAL_MS,
    );

    return () => window.clearInterval(interval);
  }, []);
}
