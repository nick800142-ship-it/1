import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { GlobalErrorBoundary } from "@/components/GlobalErrorBoundary";
import { reportMonitorEventInBackground } from "@/lib/monitoring";
import "./index.css";

window.addEventListener("error", (event) => {
  reportMonitorEventInBackground({
    type: "global_error",
    source: "window_error",
    message: event.message || "Unknown browser error",
    metadata: { filename: event.filename, line: event.lineno, column: event.colno },
  });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason ?? "Unknown promise rejection");
  reportMonitorEventInBackground({ type: "global_error", source: "unhandled_rejection", message: reason });
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GlobalErrorBoundary>
      <App />
    </GlobalErrorBoundary>
  </StrictMode>,
);
