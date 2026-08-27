import { StrictMode } from "react";
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

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("React root element #root is missing");

createRoot(rootElement).render(
  <StrictMode>
    <GlobalErrorBoundary>
      <App />
    </GlobalErrorBoundary>
  </StrictMode>,
);
