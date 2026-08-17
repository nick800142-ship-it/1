import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportMonitorEventInBackground } from "@/lib/monitoring";

type Props = { children: ReactNode };
type State = { failed: boolean };

export class GlobalErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportMonitorEventInBackground({
      type: "global_error",
      source: "react_error_boundary",
      message: error.message || "Unknown React rendering error",
      metadata: { componentStack: info.componentStack?.slice(0, 2000) },
    });
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
          <section className="flex max-w-md flex-col gap-4 text-center">
            <h1 className="text-balance text-2xl font-bold">系統暫時無法顯示</h1>
            <p className="text-pretty leading-relaxed text-muted-foreground">故障已自動回報，請重新整理頁面後再試。</p>
            <button type="button" className="rounded-xl bg-primary px-5 py-3 font-semibold text-primary-foreground" onClick={() => window.location.reload()}>
              重新整理
            </button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
