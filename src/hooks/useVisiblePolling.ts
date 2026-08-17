import { useEffect, useRef } from "react";

export function useVisiblePolling(
  callback: () => void | Promise<void>,
  intervalMs = 1_000,
  runImmediately = true,
) {
  const callbackRef = useRef(callback);
  const runningRef = useRef(false);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    let timer: number | undefined;

    const run = async () => {
      if (document.visibilityState !== "visible" || runningRef.current) return;
      runningRef.current = true;
      try {
        await callbackRef.current();
      } finally {
        runningRef.current = false;
      }
    };

    const start = (immediate: boolean) => {
      if (timer !== undefined) window.clearInterval(timer);
      if (immediate) void run();
      timer = window.setInterval(() => void run(), intervalMs);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") start(true);
      else if (timer !== undefined) window.clearInterval(timer);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    if (document.visibilityState === "visible") start(runImmediately);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [intervalMs, runImmediately]);
}
