import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { GlobalErrorBoundary } from "@/components/GlobalErrorBoundary";
import { reportMonitorEventInBackground } from "@/lib/monitoring";
import "./index.css";

const extensionProtocols = [
  "chrome-extension://",
  "moz-extension://",
  "safari-web-extension://",
  "edge-extension://",
];

function isExtensionError(value: unknown) {
  const text = String(value ?? "");
  return extensionProtocols.some((protocol) => text.includes(protocol)) ||
    text.includes("translate_http");
}

window.addEventListener("error", (event) => {
  if (isExtensionError(event.filename) || isExtensionError(event.message)) return;
  reportMonitorEventInBackground({
    type: "global_error",
    source: "window_error",
    message: event.message || "Unknown browser error",
    metadata: { filename: event.filename, line: event.lineno, column: event.colno },
  });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason ?? "Unknown promise rejection");
  if (isExtensionError(reason) || isExtensionError(event.reason?.stack)) return;
  reportMonitorEventInBackground({ type: "global_error", source: "unhandled_rejection", message: reason });
});

function ClientOnlyApp() {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // The initial tree is deterministic and contains no user, URL, storage,
  // clock, locale, or extension-mutated content.
  if (!isMounted) {
    return (
      <main
        className="min-h-dvh bg-slate-950"
        aria-label="RWMT 載入中"
        aria-busy="true"
      />
    );
  }

  return <App />;
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("React root element #root is missing");

// Vite serves an empty root. Clearing unexpected pre-mount nodes prevents a
// translation extension from becoming part of React's managed tree.
rootElement.replaceChildren();

createRoot(rootElement).render(
  <StrictMode>
    <GlobalErrorBoundary>
      <ClientOnlyApp />
    </GlobalErrorBoundary>
  </StrictMode>,
);
