// 唯讀鏈上驗證腳本：不花費任何真實 gas，不需要私鑰簽署任何交易。
//
// 用途：在 Safe 擁有人完成手動設定（addDelegate + setAllowance）之前，先確認
//   1. Allowance Module 合約確實部署在預期位址，且 NAME()/VERSION() 正確；
//   2. delegate 目前對 JC/AE 的額度狀態（設定前應該是「尚未註冊」）；
//   3. 用 simulateContract 模擬「delegate 自己呼叫 setAllowance」——結構性
//      必定失敗（因為 setAllowance 的 msg.sender 必須是 Safe 本人，不可能是
//      delegate），留下一份可重複執行的證據，證明 delegate 私鑰無法自己
//      提高額度或新增自己為 delegate。
//
// 執行方式（讀取 DELEGATE_PRIVATE_KEY 只是為了算出 delegate 地址做查詢，
// 不會用它簽署任何東西）：
//   node --env-file-if-exists=.env.development.local scripts/verify-allowance-module.mjs
import { createPublicClient, http, getAddress } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const ALLOWANCE_MODULE = getAddress(
  process.env.ALLOWANCE_MODULE_ADDRESS || "0xAA46724893dedD72658219405185Fb0Fc91e091C",
);
const SAFE_VAULT = getAddress(process.env.NEXT_PUBLIC_SAFE_VAULT_ADDRESS || "0xe886e67fd9CFe66fdb0A1F47cEf0001548a078cf");
const JC_TOKEN = getAddress(process.env.NEXT_PUBLIC_JC_TOKEN_ADDRESS || "0xa85e0664701fBec23596bFE88eB26d4efd1C7723");
const AE_TOKEN = getAddress("0x45C50E069F013B2b4Ae11a8F8F89C97d31e8D7cb");

const abi = [
  { inputs: [], name: "NAME", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "VERSION", outputs: [{ type: "string" }], stateMutability: "view", type: "function" },
  {
    inputs: [
      { name: "safe", type: "address" },
      { name: "delegate", type: "address" },
      { name: "token", type: "address" },
    ],
    name: "getTokenAllowance",
    outputs: [{ type: "uint256[5]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "delegate", type: "address" },
      { name: "token", type: "address" },
      { name: "allowanceAmount", type: "uint96" },
      { name: "resetTimeMin", type: "uint16" },
      { name: "resetBaseMin", type: "uint32" },
    ],
    name: "setAllowance",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ name: "delegate", type: "address" }],
    name: "addDelegate",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];

function delegateAddress() {
  const raw = (process.env.DELEGATE_PRIVATE_KEY ?? "").trim();
  if (!raw) return null;
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  try {
    return privateKeyToAccount(key).address;
  } catch {
    return null;
  }
}

async function main() {
  const client = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });

  console.log("== 1. 確認 Allowance Module 合約身分 ==");
  const [name, version] = await Promise.all([
    client.readContract({ address: ALLOWANCE_MODULE, abi, functionName: "NAME" }),
    client.readContract({ address: ALLOWANCE_MODULE, abi, functionName: "VERSION" }),
  ]);
  console.log(`  地址: ${ALLOWANCE_MODULE}`);
  console.log(`  NAME(): ${name}`);
  console.log(`  VERSION(): ${version}`);
  if (name !== "Allowance Module") {
    console.error("  !! 警告：NAME() 不是 'Allowance Module'，這個地址可能不是預期的合約，請立即停止並人工檢查");
    process.exitCode = 1;
    return;
  }

  const delegate = delegateAddress();
  if (!delegate) {
    console.log("\n(未設定 DELEGATE_PRIVATE_KEY，略過額度狀態查詢與模擬測試)");
    return;
  }
  console.log(`\n  delegate 地址: ${delegate}`);
  console.log(`  Safe 金庫地址: ${SAFE_VAULT}`);

  console.log("\n== 2. 目前額度狀態（JC / AE） ==");
  for (const [label, token] of [["JC", JC_TOKEN], ["AE", AE_TOKEN]]) {
    const [amount, spent, resetTimeMin, lastResetMin, nonce] = await client.readContract({
      address: ALLOWANCE_MODULE,
      abi,
      functionName: "getTokenAllowance",
      args: [SAFE_VAULT, delegate, token],
    });
    const registered = nonce > 0n;
    console.log(
      `  ${label}（${token}）: registered=${registered} amount=${amount} spent=${spent} ` +
        `resetTimeMin=${resetTimeMin} lastResetMin=${lastResetMin} nonce=${nonce}`,
    );
  }

  console.log("\n== 3. 模擬 delegate 嘗試自己呼叫 setAllowance（預期必定失敗）==");
  console.log(
    "  （這裡刻意不模擬 delegate 自己呼叫 addDelegate——合約設計上 addDelegate/setAllowance 都沒有" +
      "獨立的 access-control modifier，是用 msg.sender 本身當作要操作的『safe』鍵值，所以任何 EOA" +
      "呼叫 addDelegate 都會「成功」，但只會寫進 delegates[該 EOA 自己][...] 這個跟真正 Safe 金庫" +
      "完全無關的雜湊格；只有當 msg.sender 真的是 Safe 金庫本身（透過 Safe 交易執行）時，寫入的才是" +
      "delegates[SAFE_VAULT][...] 這個真正有效的欄位。因此 delegate 自己呼叫 addDelegate 不構成任何" +
      "風險，模擬也理所當然會顯示『成功』——這正是下面 setAllowance 模擬所驗證的關鍵：即使" +
      "delegate 想把自己寫進 SAFE_VAULT 的額度表、或想提高額度，也一定會被擋下。）",
  );
  try {
    await client.simulateContract({
      address: ALLOWANCE_MODULE,
      abi,
      functionName: "setAllowance",
      args: [delegate, JC_TOKEN, 999999999999999999999n, 1440, 0],
      account: delegate,
    });
    console.log("  !! 警告：delegate 自己呼叫 setAllowance 竟然模擬成功，這不符合預期，請立即人工檢查合約邏輯");
  } catch (error) {
    console.log(
      `  ✓ delegate 自己呼叫 setAllowance 提高額度 → 結構性 revert（符合預期，因為 msg.sender=delegate` +
        ` 時要操作的是 delegates[delegate][...]，而該欄位下 delegate 本人不是「已註冊的 delegate」，` +
        `不滿足 setAllowance 的 require）: ${String(error?.shortMessage ?? error?.message ?? error).slice(0, 200)}`,
    );
  }

  console.log(
    "\n注意：以上只是唯讀 / 模擬驗證，不代表 executeAllowanceTransfer 的端到端金流已驗證。" +
      "真實的『付款訂單 → PAID → JC 發放 → User 收到 JC』與惡意 recipient 測試，" +
      "需要 Safe 擁有人先完成 addDelegate + setAllowance 手動設定後，才能執行真實鏈上交易驗證。",
  );
}

main().catch((error) => {
  console.error("驗證腳本執行失敗:", error);
  process.exitCode = 1;
});
