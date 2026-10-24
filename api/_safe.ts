import type { SupabaseClient } from "@supabase/supabase-js";
import {
  concatHex,
  encodeFunctionData,
  encodePacked,
  formatUnits,
  getAddress,
  hashTypedData,
  parseAbi,
  parseEventLogs,
  parseUnits,
  recoverTypedDataAddress,
  size,
  type Address,
  type Hex,
} from "viem";
import {
  P2P_ESCROW_ABI,
  RELAYER_ADDRESSES,
  RELAYER_CHAIN,
  getP2PEscrowFees,
  p2pEscrowAddress,
  publicClient,
  relaySafeExecTransaction,
  setActiveSafeVault,
} from "./_onchain";
import { IS_MAINNET } from "./_network";
import { sendTelegramMessage } from "./_telegram.js";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
// Safe 官方 MultiSendCallOnly v1.4.1（Base Sepolia 已部署）；只允許 call、不允許 delegatecall 到任意合約。
const MULTISEND_CALL_ONLY = getAddress("0x9641d764fc13c8B624c04430C7356C1C7C8102e2");

const safeAbi = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)",
  "function addOwnerWithThreshold(address owner,uint256 _threshold)",
  "event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)",
  "event ExecutionFailure(bytes32 indexed txHash, uint256 payment)",
]);
const tokenAdminAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function owner() view returns (address)",
  "function mint(address to,uint256 amount)",
  "function burnVaultInventory(uint256 amount)",
  "function adminReclaim(address from,address to,uint256 amount)",
]);
// 主網 JC/AE（contracts/mainnet/PlatformToken.sol）：mint 只能鑄給 Safe 自己，銷毀＝Safe 燒自己的餘額。
const mainnetTokenAbi = parseAbi(["function mint(uint256 amount)", "function burn(uint256 amount)"]);
const factoryAdminAbi = parseAbi([
  "function owner() view returns (address)",
  "function createRWAToken(string placementId,string name_,string symbol_,uint8 decimals_,uint256 totalSupply_) returns (address)",
  "function tokenByPlacement(string) view returns (address)",
  "function reclaimShares(address token,address holder) returns (uint256)",
  "function burnVaultInventory(address token,uint256 amount)",
]);
const multiSendAbi = parseAbi(["function multiSend(bytes transactions) payable"]);

export type SafeCall = { to: Address; data: Hex; value?: bigint };
export type SafeProposalKind =
  | "mint"
  | "burn"
  | "p2p_fees"
  | "create_rwa_token"
  | "rwa_reclaim"
  | "ae_reclaim"
  | "add_owners"
  | "migrate_safe"
  | "accept_ownership";

export const SAFE_KIND_LABEL: Record<SafeProposalKind, string> = {
  migrate_safe: "更換 Safe 地址",
  accept_ownership: "新 Safe 接受管理權",
  mint: "增發代幣",
  burn: "銷毀 Safe 庫存",
  p2p_fees: "調整二級市場費率",
  create_rwa_token: "建立 RWA 代幣",
  rwa_reclaim: "RWA 下架收回份額",
  ae_reclaim: "AE 歸零收回",
  add_owners: "新增 Safe 簽署人",
};

type ProposalRow = {
  id: string;
  kind: SafeProposalKind;
  params: Record<string, unknown>;
  summary: string;
  safe_address: string;
  chain_id: number;
  to_address: string;
  value: string;
  data: string;
  operation: number;
  safe_nonce: number;
  safe_tx_hash: string;
  signatures: Record<string, string>;
  status: "pending" | "executing" | "executed" | "failed" | "stale" | "cancelled";
  exec_tx_hash: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  executed_at: string | null;
};

export function safeAddress(): Address {
  return getAddress(RELAYER_ADDRESSES.safeVault);
}

async function readSafe(override?: string) {
  const safe = override ? getAddress(override) : safeAddress();
  const client = publicClient();
  const [owners, threshold, nonce] = await Promise.all([
    client.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }),
    client.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" }),
    client.readContract({ address: safe, abi: safeAbi, functionName: "nonce" }),
  ]);
  return { safe, owners: owners.map((o) => getAddress(o)), threshold: Number(threshold), nonce };
}

function encodeMultiSend(calls: SafeCall[]): Hex {
  const packed = concatHex(
    calls.map((call) =>
      encodePacked(
        ["uint8", "address", "uint256", "uint256", "bytes"],
        [0, getAddress(call.to), call.value ?? 0n, BigInt(size(call.data)), call.data],
      ),
    ),
  );
  return encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [packed] });
}

export function safeTypedData(row: Pick<ProposalRow, "safe_address" | "chain_id" | "to_address" | "value" | "data" | "operation" | "safe_nonce">) {
  return {
    domain: { chainId: row.chain_id, verifyingContract: getAddress(row.safe_address) },
    types: {
      SafeTx: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
        { name: "operation", type: "uint8" },
        { name: "safeTxGas", type: "uint256" },
        { name: "baseGas", type: "uint256" },
        { name: "gasPrice", type: "uint256" },
        { name: "gasToken", type: "address" },
        { name: "refundReceiver", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "SafeTx" as const,
    message: {
      to: getAddress(row.to_address),
      value: BigInt(row.value),
      data: row.data as Hex,
      operation: row.operation,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ZERO,
      refundReceiver: ZERO,
      nonce: BigInt(row.safe_nonce),
    },
  };
}

/** 前端（Ledger）簽 eth_signTypedData_v4 需要的 JSON；bigint 轉字串。 */
function typedDataForWallet(row: ProposalRow) {
  const typed = safeTypedData(row);
  return {
    domain: typed.domain,
    types: {
      EIP712Domain: [
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...typed.types,
    },
    primaryType: typed.primaryType,
    message: {
      ...typed.message,
      value: typed.message.value.toString(),
      safeTxGas: "0",
      baseGas: "0",
      gasPrice: "0",
      nonce: typed.message.nonce.toString(),
    },
  };
}

  export async function publicProposal(row: ProposalRow) {
  const { owners, threshold, nonce } = await readSafe(row.safe_address).catch(() => ({ owners: [] as Address[], threshold: 0, nonce: -1n }));
  let status = row.status;
  // Safe emits ExecutionFailure for the outer transaction even when an older
  // retry later succeeds. Reconcile owner proposals from the authoritative
  // on-chain owner list so the UI never keeps showing a false failure.
  if (row.kind === "add_owners" && row.status === "failed" && nonce > BigInt(row.safe_nonce)) {
    const additions = Array.isArray(row.params.additions) ? row.params.additions.map(String) : [];
    const allPresent = additions.length > 0 && additions.every((address) =>
      owners.some((owner) => owner.toLowerCase() === address.toLowerCase()),
    );
    if (allPresent) status = "executed";
  }
  return {
  id: row.id,
  kind: row.kind,
  kindLabel: SAFE_KIND_LABEL[row.kind] ?? row.kind,
  summary: row.summary,
  status,
    safeNonce: row.safe_nonce,
    safeTxHash: row.safe_tx_hash,
    signers: Object.keys(row.signatures ?? {}),
    owners,
    threshold,
    currentNonce: nonce >= 0n ? Number(nonce) : null,
    execTxHash: row.exec_tx_hash,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    executedAt: row.executed_at,
    typedData: row.status === "pending" ? typedDataForWallet(row) : null,
  };
}

async function notify(text: string) {
  try {
    await sendTelegramMessage(text);
  } catch {
    // 營運通知失敗不影響簽核本身。
  }
}

/** 把已被鏈上 nonce 超越的待簽提案標成作廢，避免簽到一筆永遠無法執行的交易。 */
async function expireStale(admin: SupabaseClient, chainNonce: bigint, safe: string = safeAddress()) {
  await admin
    .from("safe_proposals")
    .update({ status: "stale", error: "Safe nonce 已被其他交易使用，此提案作廢，請重新建立", updated_at: new Date().toISOString() })
    .eq("safe_address", safe.toLowerCase())
    .eq("status", "pending")
    .lt("safe_nonce", Number(chainNonce));
}

export async function createSafeProposal(
  admin: SupabaseClient,
  input: { kind: SafeProposalKind; params: Record<string, unknown>; summary: string; calls: SafeCall[]; createdBy: string; safe?: Address },
) {
  if (input.calls.length === 0) throw new Error("沒有需要送出的鏈上動作");
  const { safe, nonce } = await readSafe(input.safe);
  for (const call of input.calls) {
    try {
      await publicClient().call({ account: safe, to: getAddress(call.to), data: call.data, value: call.value ?? 0n });
    } catch (e) {
      const reason = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e);
      throw new Error(`以 Safe 身分模擬失敗，提案未建立：${reason.slice(0, 240)}（若合約管理權尚未移交 Safe，請先到「Safe 簽核」完成移交）`);
    }
  }
  await expireStale(admin, nonce, safe);

  const { data: active } = await admin
    .from("safe_proposals")
    .select("id,summary")
    .eq("safe_address", safe.toLowerCase())
    .in("status", ["pending", "executing"])
    .limit(1)
    .maybeSingle();
  if (active) {
    throw new Error(`已有一筆待簽提案（${active.summary}），請先完成簽署或取消後再建立新提案`);
  }

  const single = input.calls.length === 1;
  const to = single ? getAddress(input.calls[0].to) : MULTISEND_CALL_ONLY;
  const data = single ? input.calls[0].data : encodeMultiSend(input.calls);
  const value = single ? input.calls[0].value ?? 0n : 0n;
  const operation = single ? 0 : 1;

  const chainHash = await publicClient().readContract({
    address: safe,
    abi: safeAbi,
    functionName: "getTransactionHash",
    args: [to, value, data, operation, 0n, 0n, 0n, ZERO, ZERO, nonce],
  });
  const row = {
    kind: input.kind,
    params: input.params,
    summary: input.summary,
    safe_address: safe.toLowerCase(),
    chain_id: RELAYER_CHAIN.id,
    to_address: to.toLowerCase(),
    value: value.toString(),
    data,
    operation,
    safe_nonce: Number(nonce),
    safe_tx_hash: chainHash,
    created_by: input.createdBy,
  };
  const localHash = hashTypedData(safeTypedData(row));
  if (localHash.toLowerCase() !== chainHash.toLowerCase()) {
    throw new Error("Safe 交易雜湊比對不一致，已停止建立提案");
  }
  const { data: inserted, error } = await admin.from("safe_proposals").insert(row).select("*").single();
  if (error) {
    if (error.code === "23505") throw new Error("已有一筆待簽提案佔用目前 Safe nonce，請先完成或取消");
    throw new Error(`建立提案失敗：${error.message}`);
  }
  await notify(`🔐 新的 Safe 待簽提案\n動作：${SAFE_KIND_LABEL[input.kind]}\n內容：${input.summary}\nSafe nonce：${Number(nonce)}\n請簽署人到後台「Safe 簽核」用 Ledger 簽署。`);
  return publicProposal(inserted as ProposalRow);
}

async function loadProposal(admin: SupabaseClient, id: string): Promise<ProposalRow> {
  const { data, error } = await admin.from("safe_proposals").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`讀取提案失敗：${error.message}`);
  if (!data) throw new Error("找不到此提案");
  return data as ProposalRow;
}

function normalizeSignature(signature: string): Hex {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("簽章格式錯誤");
  const v = parseInt(signature.slice(130), 16);
  if (v === 0 || v === 1) return `${signature.slice(0, 130)}${(v + 27).toString(16)}` as Hex;
  if (v === 27 || v === 28) return signature as Hex;
  throw new Error("簽章 v 值不支援，請使用 EIP-712 簽署（eth_signTypedData_v4）");
}

export async function signSafeProposal(admin: SupabaseClient, id: string, signatureInput: string) {
  const row = await loadProposal(admin, id);
  if (row.status !== "pending") throw new Error("此提案已不在待簽狀態");
  const { owners, threshold, nonce } = await readSafe(row.safe_address);
  if (BigInt(row.safe_nonce) < nonce) {
    await expireStale(admin, nonce, row.safe_address);
    throw new Error("Safe nonce 已被使用，此提案作廢，請重新建立");
  }
  const signature = normalizeSignature(signatureInput);
  const signer = getAddress(await recoverTypedDataAddress({ ...safeTypedData(row), signature }));
  if (!owners.includes(signer)) {
    throw new Error(`簽署地址 ${signer} 不是此 Safe 的簽署人，請確認 Ledger 連線的帳號`);
  }
  const signatures = { ...(row.signatures ?? {}), [signer.toLowerCase()]: signature };
  const { data: updated, error } = await admin
    .from("safe_proposals")
    .update({ signatures, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending")
    .select("*")
    .single();
  if (error || !updated) throw new Error("寫入簽章失敗，請重新整理後再試");

  const validCount = Object.keys(signatures).filter((addr) => owners.some((o) => o.toLowerCase() === addr)).length;
  if (validCount >= threshold && BigInt(row.safe_nonce) === nonce) {
    return executeSafeProposal(admin, id);
  }
  return publicProposal(updated as ProposalRow);
}

export async function executeSafeProposal(admin: SupabaseClient, id: string) {
  const row = await loadProposal(admin, id);
  if (row.status === "executing" && row.exec_tx_hash) return refreshSafeProposal(admin, id);
  if (row.status !== "pending") throw new Error("此提案不在可執行狀態");
  const { owners, threshold, nonce } = await readSafe(row.safe_address);
  if (BigInt(row.safe_nonce) !== nonce) throw new Error("Safe nonce 不符，此提案無法執行");

  const valid = Object.entries(row.signatures ?? {})
    .filter(([addr]) => owners.some((o) => o.toLowerCase() === addr))
    .sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1));
  if (valid.length < threshold) throw new Error(`簽章不足（${valid.length}/${threshold}）`);
  const packed = concatHex(valid.slice(0, threshold).map(([, sig]) => sig as Hex));

  const { data: claimed } = await admin
    .from("safe_proposals")
    .update({ status: "executing", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (!claimed) return publicProposal(await loadProposal(admin, id));

  let hash: Hex;
  try {
    hash = await relaySafeExecTransaction({
      safe: getAddress(row.safe_address),
      to: getAddress(row.to_address),
      value: BigInt(row.value),
      data: row.data as Hex,
      operation: row.operation as 0 | 1,
      signatures: packed,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await admin.from("safe_proposals").update({ status: "pending", error: `送出失敗：${message.slice(0, 400)}`, updated_at: new Date().toISOString() }).eq("id", id);
    await notify(`⚠️ Safe 提案送出失敗\n動作：${SAFE_KIND_LABEL[row.kind]}\n內容：${row.summary}\n原因：${message.slice(0, 300)}\n簽章已保留，可在後台重新執行。`);
    throw new Error(`Safe 交易送出失敗：${message}`);
  }
  await admin.from("safe_proposals").update({ exec_tx_hash: hash, error: null, updated_at: new Date().toISOString() }).eq("id", id);
  return refreshSafeProposal(admin, id);
}

/** 查詢執行交易收據；確認後套用站內後續動作（寫入費率、回填代幣地址等）。 */
export async function refreshSafeProposal(admin: SupabaseClient, id: string) {
  const row = await loadProposal(admin, id);
  const canRecheck = row.status === "executing" || (row.status === "failed" && row.error === "Safe 交易執行失敗（reverted）");
  if (!canRecheck || !row.exec_tx_hash) return publicProposal(row);
  let receipt;
  try {
    receipt = await publicClient().waitForTransactionReceipt({ hash: row.exec_tx_hash as Hex, timeout: 40_000 });
  } catch {
    return publicProposal(row);
  }
  const events = parseEventLogs({ abi: safeAbi, logs: receipt.logs, eventName: ["ExecutionSuccess", "ExecutionFailure"] });
  const ok = receipt.status === "success" && events.some((event) => event.eventName === "ExecutionSuccess");
  if (!ok) {
    if (row.status === "failed") return publicProposal(row);
    const { data } = await admin
      .from("safe_proposals")
      .update({ status: "failed", error: "Safe 交易執行失敗（reverted）", updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("*")
      .single();
    await notify(`❌ Safe 提案執行失敗\n動作：${SAFE_KIND_LABEL[row.kind]}\n內容：${row.summary}\ntx：${row.exec_tx_hash}\n請檢查後重新建立提案。`);
    return publicProposal(data as ProposalRow);
  }

  let result: Record<string, unknown> = { txHash: row.exec_tx_hash };
  let followUpError: string | null = null;
  try {
    result = { ...result, ...(await applyFollowUp(admin, row)) };
  } catch (e) {
    followUpError = `鏈上已執行，但站內同步失敗：${e instanceof Error ? e.message : String(e)}`;
  }
  const { data } = await admin
    .from("safe_proposals")
    .update({
      status: "executed",
      result,
      error: followUpError,
      executed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("*")
    .single();
  await notify(
    followUpError
      ? `⚠️ Safe 提案已上鏈但站內同步失敗\n動作：${SAFE_KIND_LABEL[row.kind]}\n內容：${row.summary}\ntx：${row.exec_tx_hash}\n${followUpError}\n請到後台按「重新同步」。`
      : `✅ Safe 提案已執行\n動作：${SAFE_KIND_LABEL[row.kind]}\n內容：${row.summary}\ntx：${row.exec_tx_hash}`,
  );
  return publicProposal(data as ProposalRow);
}

async function applyFollowUp(admin: SupabaseClient, row: ProposalRow): Promise<Record<string, unknown>> {
  if (row.kind === "migrate_safe") {
    const newSafe = getAddress(String(row.params.newSafe ?? ""));
    const { error } = await admin.rpc("service_set_active_safe", { p_address: newSafe, p_admin_id: row.created_by });
    if (error) throw new Error(error.message);
    setActiveSafeVault(newSafe);
    const pending = await pendingOwnershipFor(newSafe);
    return { activeSafe: newSafe, awaitingAccept: pending.map((target) => target.label) };
  }
  if (row.kind === "accept_ownership") {
    const pending = await pendingOwnershipFor(getAddress(row.safe_address));
    return { stillAwaitingAccept: pending.map((target) => target.label) };
  }
  if (row.kind === "p2p_fees") {
    const chain = await getP2PEscrowFees();
    const { error } = await admin.rpc("service_set_p2p_fees", {
      p_fee_bps: chain.feeBps,
      p_listing_fee: chain.listingFee,
      p_admin_id: row.created_by,
    });
    if (error) throw new Error(error.message);
    return { feeBps: chain.feeBps, listingFee: chain.listingFee };
  }
  if (row.kind === "create_rwa_token") {
    const placementId = String(row.params.placementId ?? "");
    const token = await publicClient().readContract({
      address: RELAYER_ADDRESSES.rwaFactory,
      abi: factoryAdminAbi,
      functionName: "tokenByPlacement",
      args: [placementId],
    });
    if (!token || token === ZERO) throw new Error("鏈上暫時讀不到新代幣地址，請稍後按重新同步");
    const { error } = await admin.from("private_placements").update({ token_address: getAddress(token) }).eq("id", placementId);
    if (error) throw new Error(error.message);
    return { tokenAddress: getAddress(token), placementId };
  }
  return {};
}

/** 已執行但站內同步失敗時重跑後續動作。 */
export async function resyncSafeProposal(admin: SupabaseClient, id: string) {
  const row = await loadProposal(admin, id);
  if (row.status === "executing") return refreshSafeProposal(admin, id);
  if (row.status !== "executed") throw new Error("只有已執行的提案可以重新同步");
  const result = { ...(row.result ?? {}), ...(await applyFollowUp(admin, row)) };
  const { data } = await admin
    .from("safe_proposals")
    .update({ result, error: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  return publicProposal(data as ProposalRow);
}

export async function cancelSafeProposal(admin: SupabaseClient, id: string) {
  const { data, error } = await admin
    .from("safe_proposals")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`取消失敗：${error.message}`);
  if (!data) throw new Error("此提案已不在待簽狀態，無法取消");
  return publicProposal(data as ProposalRow);
}

export async function listSafeProposals(admin: SupabaseClient) {
  const { nonce } = await readSafe();
  await expireStale(admin, nonce);
  // 也列出舊 Safe 的提案，讓更換 Safe 之後仍看得到過往紀錄與其執行結果。
  const { data, error } = await admin
    .from("safe_proposals")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) throw new Error(`讀取提案失敗：${error.message}`);
  // Older builds misparsed Safe's indexed ExecutionSuccess event and marked
  // successful executions as failed; recheck those receipts once here.
  const rows = await Promise.all(
    (data ?? []).map(async (row) => {
      const proposal = row as ProposalRow;
      if (proposal.status === "failed" && proposal.exec_tx_hash && proposal.error === "Safe 交易執行失敗（reverted）") {
        try {
          return await refreshSafeProposal(admin, proposal.id);
        } catch {
          return publicProposal(proposal);
        }
      }
      return publicProposal(proposal);
    }),
  );
  return rows;
}

/** Safe 與各合約管理權狀態，給後台顯示「哪些權限已交給 Safe」。 */
export async function safeGovernanceStatus() {
  const { safe, owners, threshold, nonce } = await readSafe();
  const client = publicClient();
  const readOwner = async (address: Address) => {
    try {
      return getAddress(await client.readContract({ address, abi: tokenAdminAbi, functionName: "owner" }));
    } catch {
      return null;
    }
  };
  const targets = [
    { key: "jc", label: "JC 代幣", address: getAddress(RELAYER_ADDRESSES.jcToken) },
    { key: "ae", label: "AE 代幣", address: getAddress(RELAYER_ADDRESSES.aeToken) },
    { key: "rwaFactory", label: "RWA Factory", address: getAddress(RELAYER_ADDRESSES.rwaFactory) },
    { key: "p2pEscrow", label: "二級託管", address: p2pEscrowAddress() },
  ];
  const contracts = await Promise.all(
    targets.map(async (target) => {
      const owner = await readOwner(target.address);
      return { ...target, owner, ownedBySafe: owner?.toLowerCase() === safe.toLowerCase() };
    }),
  );
  const awaitingAccept = (await pendingOwnershipFor(safe)).map((target) => ({ key: target.key, label: target.label, address: target.address }));
  return { safe, owners, threshold, nonce: Number(nonce), chainId: RELAYER_CHAIN.id, contracts, awaitingAccept };
}

const pendingOwnerAbi = parseAbi([
  "function pendingOwner() view returns (address)",
  "function acceptOwnership()",
]);

function governedTargets() {
  return [
    { key: "jc", label: "JC 代幣", address: getAddress(RELAYER_ADDRESSES.jcToken) },
    { key: "ae", label: "AE 代幣", address: getAddress(RELAYER_ADDRESSES.aeToken) },
    { key: "rwaFactory", label: "RWA Factory", address: getAddress(RELAYER_ADDRESSES.rwaFactory) },
    { key: "p2pEscrow", label: "二級託管", address: p2pEscrowAddress() },
  ];
}

/** 已把管理權移交給此 Safe、但還在等它簽「接受」的 Ownable2Step 合約。 */
export async function pendingOwnershipFor(safe: Address) {
  const client = publicClient();
  const results = await Promise.all(
    governedTargets().map(async (target) => {
      try {
        const pending = await client.readContract({ address: target.address, abi: pendingOwnerAbi, functionName: "pendingOwner" });
        return getAddress(pending) === safe ? target : null;
      } catch {
        // 合約不支援兩步移交（單步移交，已直接生效）
        return null;
      }
    }),
  );
  return results.filter((target): target is NonNullable<typeof target> => target !== null);
}

/** 由目前生效的 Safe 對所有「等待接受」的合約一次執行 acceptOwnership。 */
export async function buildAcceptOwnershipCalls() {
  const safe = safeAddress();
  const pending = await pendingOwnershipFor(safe);
  if (pending.length === 0) throw new Error("目前沒有等待新 Safe 接受的合約管理權");
  return {
    safe,
    targets: pending,
    calls: pending.map((target) => ({
      to: target.address,
      data: encodeFunctionData({ abi: pendingOwnerAbi, functionName: "acceptOwnership" }),
    })) as SafeCall[],
  };
}

async function tokenDecimals(address: Address) {
  return Number(await publicClient().readContract({ address, abi: tokenAdminAbi, functionName: "decimals" }));
}

export const safeCalls = {
  async mint(token: "jc" | "ae", amount: number): Promise<SafeCall> {
    const address = getAddress(token === "jc" ? RELAYER_ADDRESSES.jcToken : RELAYER_ADDRESSES.aeToken);
    const decimals = await tokenDecimals(address);
    const units = parseUnits(amount.toFixed(decimals), decimals);
    return {
      to: address,
      data: IS_MAINNET
        ? encodeFunctionData({ abi: mainnetTokenAbi, functionName: "mint", args: [units] })
        : encodeFunctionData({ abi: tokenAdminAbi, functionName: "mint", args: [safeAddress(), units] }),
    };
  },
  async burn(token: "jc" | "ae" | "rwa", amount: number, rwaToken?: Address): Promise<SafeCall> {
    if (token === "rwa") {
      if (!rwaToken) throw new Error("RWA 必須指定標的代幣");
      const decimals = await tokenDecimals(rwaToken);
      return {
        to: getAddress(RELAYER_ADDRESSES.rwaFactory),
        data: encodeFunctionData({ abi: factoryAdminAbi, functionName: "burnVaultInventory", args: [rwaToken, parseUnits(amount.toFixed(decimals), decimals)] }),
      };
    }
    const address = getAddress(token === "jc" ? RELAYER_ADDRESSES.jcToken : RELAYER_ADDRESSES.aeToken);
    const decimals = await tokenDecimals(address);
    const units = parseUnits(amount.toFixed(decimals), decimals);
    const vaultBalance = await publicClient().readContract({
      address,
      abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
      functionName: "balanceOf",
      args: [safeAddress()],
    });
    if (vaultBalance < units) throw new Error(`Safe 金庫 ${token.toUpperCase()} 庫存不足（目前 ${formatUnits(vaultBalance, decimals)}）`);
    return {
      to: address,
      data: IS_MAINNET
        ? encodeFunctionData({ abi: mainnetTokenAbi, functionName: "burn", args: [units] })
        : encodeFunctionData({ abi: tokenAdminAbi, functionName: "burnVaultInventory", args: [units] }),
    };
  },
  p2pFees(feeBps: number, listingFee: string): SafeCall {
    return {
      to: p2pEscrowAddress(),
      data: encodeFunctionData({ abi: P2P_ESCROW_ABI, functionName: "setFees", args: [BigInt(feeBps), parseUnits(listingFee, 18)] }),
    };
  },
  createRwaToken(placementId: string, name: string, symbol: string, decimals: number, totalSupply: number): SafeCall {
    return {
      to: getAddress(RELAYER_ADDRESSES.rwaFactory),
      data: encodeFunctionData({
        abi: factoryAdminAbi,
        functionName: "createRWAToken",
        args: [placementId, name, symbol, decimals, parseUnits(String(totalSupply), decimals)],
      }),
    };
  },
  rwaReclaim(token: Address, holder: Address): SafeCall {
    return {
      to: getAddress(RELAYER_ADDRESSES.rwaFactory),
      data: encodeFunctionData({ abi: factoryAdminAbi, functionName: "reclaimShares", args: [token, holder] }),
    };
  },
  async aeReclaim(holder: Address, amount: number): Promise<SafeCall> {
    if (IS_MAINNET) throw new Error("主網 AE 合約沒有歸零收回功能");
    const address = getAddress(RELAYER_ADDRESSES.aeToken);
    const decimals = await tokenDecimals(address);
    return {
      to: address,
      data: encodeFunctionData({ abi: tokenAdminAbi, functionName: "adminReclaim", args: [holder, safeAddress(), parseUnits(amount.toFixed(decimals), decimals)] }),
    };
  },
  addOwner(owner: Address, threshold: number): SafeCall {
    return {
      to: safeAddress(),
      data: encodeFunctionData({ abi: safeAbi, functionName: "addOwnerWithThreshold", args: [owner, BigInt(threshold)] }),
    };
  },
};

const ownableAbi = parseAbi(["function owner() view returns (address)", "function transferOwnership(address newOwner)"]);
const migrationAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to,uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function feeRecipient() view returns (address)",
  "function setFeeRecipient(address newRecipient)",
  "function pendingOwner() view returns (address)",
]);

export type SafeMigrationPlan = {
  newSafe: Address;
  newOwners: Address[];
  newThreshold: number;
  calls: SafeCall[];
  steps: string[];
  skipped: string[];
  /** 主網 Ownable2Step 合約：新 Safe 需再執行 acceptOwnership 才生效。 */
  needsAccept: string[];
};

/**
 * 產生「把目前 Safe 的權限與資產全部移到新 Safe」的提案內容。
 * 順序：先搬資產 → 改收款地址 → 最後才移交管理權，確保中途失敗時舊 Safe 仍握有權限。
 * 只移交目前確實由舊 Safe 管理的合約；尚未移交給 Safe 的合約會列在 skipped。
 */
export async function buildSafeMigrationPlan(newSafeInput: string, rwaTokens: Address[]): Promise<SafeMigrationPlan> {
  const client = publicClient();
  const current = safeAddress();
  const newSafe = getAddress(newSafeInput);
  if (newSafe === current) throw new Error("新 Safe 地址與目前 Safe 相同");
  const code = await client.getCode({ address: newSafe });
  if (!code || code === "0x") throw new Error("新地址不是合約，請確認已在同一條鏈上建立 Safe");
  let newOwners: Address[];
  let newThreshold: number;
  try {
    const [owners, threshold] = await Promise.all([
      client.readContract({ address: newSafe, abi: safeAbi, functionName: "getOwners" }),
      client.readContract({ address: newSafe, abi: safeAbi, functionName: "getThreshold" }),
    ]);
    newOwners = owners.map((o) => getAddress(o));
    newThreshold = Number(threshold);
  } catch {
    throw new Error("新地址讀不到 Safe 簽署人與門檻，請確認它是 Safe 多簽錢包");
  }
  if (newOwners.length === 0 || newThreshold < 1) throw new Error("新 Safe 沒有有效的簽署人或門檻");

  const calls: SafeCall[] = [];
  const steps: string[] = [];
  const skipped: string[] = [];
  const needsAccept: string[] = [];

  const assets: { label: string; address: Address }[] = [
    { label: "USDT", address: getAddress(RELAYER_ADDRESSES.usdt) },
    { label: "JC", address: getAddress(RELAYER_ADDRESSES.jcToken) },
    { label: "AE", address: getAddress(RELAYER_ADDRESSES.aeToken) },
    ...rwaTokens.map((address) => ({ label: `RWA ${address.slice(0, 6)}…${address.slice(-4)}`, address: getAddress(address) })),
  ];
  for (const asset of assets) {
    const [balance, decimals] = await Promise.all([
      client.readContract({ address: asset.address, abi: migrationAbi, functionName: "balanceOf", args: [current] }),
      client.readContract({ address: asset.address, abi: migrationAbi, functionName: "decimals" }).catch(() => 18),
    ]);
    if (balance === 0n) continue;
    calls.push({ to: asset.address, data: encodeFunctionData({ abi: migrationAbi, functionName: "transfer", args: [newSafe, balance] }) });
    steps.push(`轉移 ${formatUnits(balance, Number(decimals))} ${asset.label} 到新 Safe`);
  }

  const escrow = p2pEscrowAddress();
  const owned: { label: string; address: Address }[] = [
    { label: "二級託管", address: escrow },
    { label: "JC 代幣", address: getAddress(RELAYER_ADDRESSES.jcToken) },
    { label: "AE 代幣", address: getAddress(RELAYER_ADDRESSES.aeToken) },
    { label: "RWA Factory", address: getAddress(RELAYER_ADDRESSES.rwaFactory) },
  ];
  const escrowOwner = getAddress(await client.readContract({ address: escrow, abi: ownableAbi, functionName: "owner" }));
  if (escrowOwner === current) {
    const recipient = getAddress(await client.readContract({ address: escrow, abi: migrationAbi, functionName: "feeRecipient" }));
    if (recipient === current) {
      calls.push({ to: escrow, data: encodeFunctionData({ abi: migrationAbi, functionName: "setFeeRecipient", args: [newSafe] }) });
      steps.push("二級託管手續費收款地址改為新 Safe");
    }
  }
  for (const target of owned) {
    const owner = getAddress(await client.readContract({ address: target.address, abi: ownableAbi, functionName: "owner" }));
    if (owner !== current) {
      skipped.push(`${target.label}（目前管理者 ${owner.slice(0, 6)}…${owner.slice(-4)}，不是 Safe）`);
      continue;
    }
    calls.push({ to: target.address, data: encodeFunctionData({ abi: ownableAbi, functionName: "transferOwnership", args: [newSafe] }) });
    const twoStep = await client
      .readContract({ address: target.address, abi: migrationAbi, functionName: "pendingOwner" })
      .then(() => true)
      .catch(() => false);
    if (twoStep) needsAccept.push(target.label);
    steps.push(`${target.label} 管理權移交新 Safe${twoStep ? "（需新 Safe 接受）" : ""}`);
  }
  if (calls.length === 0) throw new Error("目前 Safe 沒有可移轉的資產或管理權");
  return { newSafe, newOwners, newThreshold, calls, steps, skipped, needsAccept };
}

/** 熱錢包把自己目前持有的合約管理權一次性移交給 Safe（移交後熱錢包即無法再鑄造/銷毀/建立代幣）。 */
export async function handOwnershipToSafe(target: "jc" | "ae" | "rwaFactory", send: (address: Address, data: Hex) => Promise<Hex>) {
  const address = getAddress(
    target === "jc" ? RELAYER_ADDRESSES.jcToken : target === "ae" ? RELAYER_ADDRESSES.aeToken : RELAYER_ADDRESSES.rwaFactory,
  );
  const owner = getAddress(await publicClient().readContract({ address, abi: ownableAbi, functionName: "owner" }));
  if (owner === safeAddress()) return { alreadySafe: true, txHash: null };
  const data = encodeFunctionData({ abi: ownableAbi, functionName: "transferOwnership", args: [safeAddress()] });
  const txHash = await send(address, data);
  return { alreadySafe: false, txHash };
}
