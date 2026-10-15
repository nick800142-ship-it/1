/* eslint-disable react-refresh/only-export-components */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { PrivyAuthProvider } from "@/providers/PrivyAuthProvider";
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

// Chromium fires `beforeinstallprompt` very early — often before React mounts —
// and only once. Stash it on window so the InstallGuide can offer a one-tap
// "add to home screen" button. A custom event lets a mounted component pick it
// up if it fires after mount.
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  (window as unknown as { __deferredInstallPrompt?: Event }).__deferredInstallPrompt = event;
  window.dispatchEvent(new Event("install-prompt-ready"));
});
window.addEventListener("appinstalled", () => {
  (window as unknown as { __deferredInstallPrompt?: Event }).__deferredInstallPrompt = undefined;
});

function ClientOnlyApp() {
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
      <PrivyAuthProvider>
        <ClientOnlyApp />
      </PrivyAuthProvider>
    </GlobalErrorBoundary>
  </StrictMode>,
);
