import { useMemo } from "react";
import { LoaderCircle, LogOut, Wallet } from "lucide-react";
import { usePrivy } from "@privy-io/react-auth";

function shortenAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function PrivyLoginButton() {
  const { ready, authenticated, user, login, logout } = usePrivy();

  // 從已連結帳號中取出 Privy 自動生成的嵌入式錢包地址。
  const walletAddress = useMemo(() => {
    if (user?.wallet?.address) return user.wallet.address;
    const embedded = user?.linkedAccounts?.find(
      (account) =>
        account.type === "wallet" &&
        "walletClientType" in account &&
        account.walletClientType === "privy",
    );
    return embedded && "address" in embedded
      ? (embedded.address as string)
      : null;
  }, [user]);

  if (!ready) {
    return (
      <span className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-400">
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
        正在初始化錢包…
      </span>
    );
  }

  if (!authenticated) {
    return (
      <button
        type="button"
        onClick={login}
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-400 px-4 py-3 font-semibold text-slate-950 transition hover:bg-amber-300"
      >
        <Wallet aria-hidden="true" className="size-5" />
        登入 / 註冊
      </button>
    );
  }

  const email = user?.email?.address ?? user?.google?.email ?? null;

  return (
    <div className="flex w-full flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex flex-col gap-1 text-left">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Email
        </span>
        <span className="break-all text-sm font-semibold text-slate-100">
          {email ?? "未提供 Email"}
        </span>
      </div>
      <div className="flex flex-col gap-1 text-left">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Privy 錢包地址
        </span>
        <span
          className="break-all font-mono text-sm text-amber-300"
          title={walletAddress ?? undefined}
        >
          {walletAddress ? shortenAddress(walletAddress) : "錢包生成中…"}
        </span>
      </div>
      <button
        type="button"
        onClick={logout}
        className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
      >
        <LogOut aria-hidden="true" className="size-4" />
        登出
      </button>
    </div>
  );
}
