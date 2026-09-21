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

// 瀏覽器對「跨來源」腳本（第三方 SDK/CDN 如 Privy、thirdweb，或瀏覽器擴充功能）
// 拋出的例外，基於安全考量會遮蔽所有細節，只回報字面上的 "Script error."，沒有
// 檔名/行號/堆疊，完全無法診斷，也沒有東西可「修復」。這類雜訊不該觸發 Telegram
// 故障告警。ResizeObserver loop 也是眾所皆知的良性警告，一併忽略。
function isNoiseError(message: unknown, filename: unknown) {
  const text = String(message ?? "").trim();
  const file = String(filename ?? "").trim();
  // 典型的跨來源遮蔽錯誤：訊息就是 "Script error."，且沒有任何檔名資訊。
  if (/^script error\.?$/i.test(text) && !file) return true;
  if (text.includes("ResizeObserver loop")) return true;
  return false;
}

window.addEventListener("error", (event) => {
  if (isExtensionError(event.filename) || isExtensionError(event.message)) return;
  if (isNoiseError(event.message, event.filename)) return;
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
  if (isNoiseError(reason, undefined)) return;
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
