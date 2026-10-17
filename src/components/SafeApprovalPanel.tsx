import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { useConnectWallet, useWallets } from "@privy-io/react-auth";
import { CheckCircle2, KeyRound, Loader2, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { callRelayer } from "@/lib/onchainSettlement";
import { CHAIN_ID } from "@/lib/contracts";

type Proposal = {
  id: string;
  kind: string;
  kindLabel: string;
  summary: string;
  status: "pending" | "executing" | "executed" | "failed" | "stale" | "cancelled";
  safeNonce: number;
  safeTxHash: string;
  signers: string[];
  owners: string[];
  threshold: number;
  currentNonce: number | null;
  execTxHash: string | null;
  error: string | null;
  createdAt: string;
  executedAt: string | null;
  typedData: Record<string, unknown> | null;
};

type SafeStatus = {
  safe: string;
  owners: string[];
  threshold: number;
  nonce: number;
  contracts: { key: string; label: string; address: string; owner: string | null; ownedBySafe: boolean }[];
  proposals: Proposal[];
};

const STATUS_LABEL: Record<Proposal["status"], { text: string; tone: string }> = {
  pending: { text: "待簽署", tone: "bg-amber-400/15 text-amber-300" },
  executing: { text: "上鏈中", tone: "bg-cyan-400/15 text-cyan-300" },
  executed: { text: "已執行", tone: "bg-emerald-400/15 text-emerald-300" },
  failed: { text: "執行失敗", tone: "bg-red-500/15 text-red-300" },
  stale: { text: "已作廢", tone: "bg-slate-700 text-slate-300" },
  cancelled: { text: "已取消", tone: "bg-slate-700 text-slate-300" },
};

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const explorer = (hash: string) => `https://sepolia.basescan.org/tx/${hash}`;

export function SafeApprovalPanel() {
  const { data, error, isLoading, mutate } = useSWR<SafeStatus>(
    "safe-status",
    async () => (await callRelayer("safe-status")) as unknown as SafeStatus,
    { refreshInterval: 15_000 },
  );
  const { wallets } = useWallets();
  const { connectWallet } = useConnectWallet();
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    setIsMobile(window.matchMedia("(max-width: 767px)").matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent));
  }, []);

  const connectLedger = () => {
    // QR is desktop-only. On mobile, WalletConnect hands off to Ledger Live
    // through its mobile deep-link flow instead of waiting for a QR scan.
    connectWallet({
      walletList: [isMobile ? "wallet_connect" : "wallet_connect_qr"],
      walletChainType: "ethereum-only",
    });
  };
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [ownerInput, setOwnerInput] = useState("");
  const [thresholdInput, setThresholdInput] = useState("2");

  useEffect(() => {
    const onUpdate = () => void mutate();
    window.addEventListener("safe-proposals-updated", onUpdate);
    return () => window.removeEventListener("safe-proposals-updated", onUpdate);
  }, [mutate]);

  const signerWallet = useMemo(() => {
    const owners = new Set((data?.owners ?? []).map((o) => o.toLowerCase()));
    const external = wallets.filter((w) => w.walletClientType !== "privy");
    return external.find((w) => owners.has(w.address.toLowerCase())) ?? external[0] ?? null;
  }, [wallets, data?.owners]);
  const signerIsOwner = Boolean(
    signerWallet && data?.owners.some((o) => o.toLowerCase() === signerWallet.address.toLowerCase()),
  );

  const run = async (id: string, task: () => Promise<unknown>, success: string) => {
    setBusyId(id);
    setMessage(null);
    try {
      await task();
      setMessage({ text: success, ok: true });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : "操作失敗", ok: false });
    } finally {
      setBusyId(null);
      await mutate();
    }
  };

  const sign = (proposal: Proposal) =>
    run(proposal.id, async () => {
      if (!signerWallet) throw new Error("請先連接 Ledger 錢包");
      if (!signerIsOwner) throw new Error(`目前連接的 ${short(signerWallet.address)} 不是 Safe 簽署人`);
      if (!proposal.typedData) throw new Error("此提案已不可簽署");
      await signerWallet.switchChain(CHAIN_ID);
      const provider = await signerWallet.getEthereumProvider();
      const signature = (await provider.request({
        method: "eth_signTypedData_v4",
        params: [signerWallet.address, JSON.stringify(proposal.typedData)],
      })) as string;
      const result = (await callRelayer("safe-sign", { proposalId: proposal.id, signature })) as { proposal: Proposal };
      if (result.proposal.status === "executed") return;
      if (result.proposal.status === "executing") return;
    }, "簽署已送出；達到門檻時會自動由熱錢包代付 Gas 上鏈。");

  const proposeOwners = () =>
    run("owners", async () => {
      const owners = ownerInput.split(/[\s,，]+/).map((v) => v.trim()).filter(Boolean);
      await callRelayer("safe-propose-owners", { owners, threshold: Number(thresholdInput) });
      setOwnerInput("");
    }, "已建立「新增簽署人」提案，請用目前簽署人的 Ledger 簽署。");

  return (
    <section aria-labelledby="safe-approval-title" className="flex flex-col gap-4 rounded-2xl border border-amber-400/30 bg-slate-900 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 id="safe-approval-title" className="flex items-center gap-2 font-bold text-slate-100">
            <ShieldCheck className="size-5 text-amber-300" aria-hidden="true" />
            Safe 簽核（Ledger）
          </h3>
          <p className="text-xs leading-relaxed text-slate-400">
            鑄造、銷毀、建立／收回 RWA、AE 歸零收回、二級費率都會先建立提案，簽署人用 Ledger 簽滿門檻後由熱錢包代付 Gas 執行；熱錢包本身沒有這些權限。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void mutate()}
          className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-700 px-3 text-sm text-slate-300 hover:text-slate-100"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          重新整理
        </button>
      </div>

      {isLoading && <p className="text-sm text-slate-400">讀取 Safe 狀態中…</p>}
      {error && <p role="alert" className="text-sm text-red-300">{error instanceof Error ? error.message : "Safe 狀態讀取失敗"}</p>}
      {message && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm ${message.ok ? "bg-emerald-400/10 text-emerald-300" : "bg-red-500/10 text-red-300"}`}>
          {message.text}
        </p>
      )}

      {data && (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="flex flex-col gap-2 rounded-xl bg-slate-950 p-4 text-sm">
              <p className="text-xs text-slate-500">Safe 金庫</p>
              <p className="break-all font-mono text-xs text-slate-200">{data.safe}</p>
              <p className="text-slate-300">
                門檻 <span className="font-bold text-amber-300">{data.threshold}/{data.owners.length}</span>・nonce {data.nonce}
              </p>
              <ul className="flex flex-col gap-1">
                {data.owners.map((owner) => (
                  <li key={owner} className="font-mono text-xs text-slate-400">{owner}</li>
                ))}
              </ul>
            </div>
            <div className="flex flex-col gap-2 rounded-xl bg-slate-950 p-4 text-sm">
              <p className="text-xs text-slate-500">合約管理權</p>
              <ul className="flex flex-col gap-2">
                {data.contracts.map((contract) => (
                  <li key={contract.key} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-slate-300">{contract.label}</span>
                    {contract.ownedBySafe ? (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-300">
                        <CheckCircle2 className="size-4" aria-hidden="true" />
                        Safe
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <span className="text-xs text-amber-300">{contract.owner ? short(contract.owner) : "未知"}</span>
                        {contract.key !== "p2pEscrow" && (
                          <button
                            type="button"
                            disabled={busyId !== null}
                            onClick={() => {
                              if (!window.confirm(`把 ${contract.label} 的管理權移交給 Safe？移交後熱錢包無法再直接鑄造／銷毀／建立代幣，且無法由熱錢包撤回。`)) return;
                              void run(`handoff-${contract.key}`, () => callRelayer("safe-handoff", { target: contract.key }), `${contract.label} 管理權已移交 Safe。`);
                            }}
                            className="min-h-9 rounded-lg bg-amber-400 px-3 text-xs font-bold text-slate-950 disabled:opacity-50"
                          >
                            {busyId === `handoff-${contract.key}` ? "移交中…" : "移交 Safe"}
                          </button>
                        )}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 p-4">
            <div className="flex flex-col gap-1 text-sm">
              <p className="flex items-center gap-2 text-slate-200">
                <KeyRound className="size-4 text-amber-300" aria-hidden="true" />
                簽署錢包
              </p>
              {signerWallet ? (
                <p className={`font-mono text-xs ${signerIsOwner ? "text-emerald-300" : "text-red-300"}`}>
                  {signerWallet.address}{signerIsOwner ? "（簽署人）" : "（不是 Safe 簽署人）"}
                </p>
              ) : (
                <p className="text-xs text-slate-400">尚未連接。請用 MetaMask／Rabby 連 Ledger，或 Ledger Live 透過 WalletConnect 連線。</p>
              )}
            </div>
            <button
              type="button"
              onClick={connectLedger}
              className="min-h-10 rounded-lg border border-amber-400/60 px-4 text-sm font-bold text-amber-300 hover:bg-amber-400/10"
            >
              {signerWallet ? "切換錢包" : "連接 Ledger"}
            </button>
          </div>

          <div className="flex flex-col gap-3">
            <h4 className="text-sm font-bold text-slate-200">提案</h4>
            {data.proposals.length === 0 && <p className="text-sm text-slate-500">目前沒有提案。</p>}
            {data.proposals.map((proposal) => {
              const status = STATUS_LABEL[proposal.status];
              const busy = busyId === proposal.id;
              const alreadySigned = Boolean(signerWallet && proposal.signers.includes(signerWallet.address.toLowerCase()));
              return (
                <article key={proposal.id} className="flex flex-col gap-3 rounded-xl bg-slate-950 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex flex-col gap-1">
                      <p className="text-xs text-slate-500">{proposal.kindLabel}・nonce {proposal.safeNonce}・{new Date(proposal.createdAt).toLocaleString("zh-TW")}</p>
                      <p className="text-sm text-slate-100">{proposal.summary}</p>
                    </div>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${status.tone}`}>{status.text}</span>
                  </div>
                  <p className="text-xs text-slate-400">
                    簽章 {proposal.signers.length}/{proposal.threshold}
                    {proposal.signers.length > 0 && `：${proposal.signers.map(short).join("、")}`}
                  </p>
                  {proposal.error && <p className="text-xs text-red-300">{proposal.error}</p>}
                  {proposal.execTxHash && (
                    <a href={explorer(proposal.execTxHash)} target="_blank" rel="noreferrer" className="break-all font-mono text-xs text-cyan-300 underline">
                      {proposal.execTxHash}
                    </a>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {proposal.status === "pending" && (
                      <>
                        <button
                          type="button"
                          disabled={busyId !== null || alreadySigned || !signerIsOwner}
                          onClick={() => void sign(proposal)}
                          className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-amber-400 px-4 text-sm font-bold text-slate-950 disabled:opacity-50"
                        >
                          {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                          {alreadySigned ? "已簽署" : "用 Ledger 簽署"}
                        </button>
                        {proposal.signers.length >= proposal.threshold && (
                          <button
                            type="button"
                            disabled={busyId !== null}
                            onClick={() => void run(proposal.id, () => callRelayer("safe-execute", { proposalId: proposal.id }), "已送出執行。")}
                            className="min-h-10 rounded-lg border border-emerald-400/60 px-4 text-sm text-emerald-300 disabled:opacity-50"
                          >
                            重新執行
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busyId !== null}
                          onClick={() => {
                            if (!window.confirm("取消這筆提案？已收集的簽章會作廢。")) return;
                            void run(proposal.id, () => callRelayer("safe-cancel", { proposalId: proposal.id }), "提案已取消。");
                          }}
                          className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-slate-700 px-3 text-sm text-slate-300 disabled:opacity-50"
                        >
                          <XCircle className="size-4" aria-hidden="true" />
                          取消
                        </button>
                      </>
                    )}
                    {proposal.status === "executing" && (
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => void run(proposal.id, () => callRelayer("safe-refresh", { proposalId: proposal.id }), "已更新上鏈狀態。")}
                        className="min-h-10 rounded-lg border border-cyan-400/60 px-4 text-sm text-cyan-300 disabled:opacity-50"
                      >
                        查詢上鏈結果
                      </button>
                    )}
                    {proposal.status === "executed" && proposal.error && (
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => void run(proposal.id, () => callRelayer("safe-resync", { proposalId: proposal.id }), "站內��重新同步。")}
                        className="min-h-10 rounded-lg border border-amber-400/60 px-4 text-sm text-amber-300 disabled:opacity-50"
                      >
                        重新同步
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>

          <div className="flex flex-col gap-3 rounded-xl border border-slate-800 p-4">
            <h4 className="text-sm font-bold text-slate-200">新增簽署人／調整門檻</h4>
            <p className="text-xs text-slate-400">輸入新簽署人地址（可多個，以逗號或換行分隔）與新門檻，會建立一筆需現有簽署人 Ledger 簽署的提案。</p>
            <textarea
              value={ownerInput}
              onChange={(event) => setOwnerInput(event.target.value)}
              rows={2}
              placeholder="0x…, 0x…"
              aria-label="新簽署人地址"
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-200"
            />
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs text-slate-400">
                新門檻
                <input
                  type="number"
                  min={1}
                  value={thresholdInput}
                  onChange={(event) => setThresholdInput(event.target.value)}
                  className="min-h-10 w-24 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-200"
                />
              </label>
              <button
                type="button"
                disabled={busyId !== null || !ownerInput.trim()}
                onClick={() => void proposeOwners()}
                className="min-h-10 rounded-lg bg-slate-100 px-4 text-sm font-bold text-slate-950 disabled:opacity-50"
              >
                {busyId === "owners" ? "建立中…" : "建立提案"}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
