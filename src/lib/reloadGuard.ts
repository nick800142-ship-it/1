let activeHolds = 0;

/** Keeps the auto-update reload from interrupting a login bridge, wallet signature, or settlement call. */
export async function withReloadHold<T>(task: () => Promise<T>): Promise<T> {
  activeHolds += 1;
  try {
    return await task();
  } finally {
    activeHolds = Math.max(0, activeHolds - 1);
  }
}

export function isReloadSafe(): boolean {
  if (activeHolds > 0) return false;
  if (typeof document === "undefined") return true;
  if (document.visibilityState === "hidden") return true;
  // An open modal (Privy login, buy sheet, wallet confirmation) means the user is mid-action.
  return !document.querySelector('[role="dialog"], [aria-modal="true"], #privy-modal-content');
}
