// 真實鏈上 E2E 測試（Base Sepolia）：驗證「Safe Allowance Module 發放 JC/AE」
// 這條路徑本身，包含正常 recipient 與惡意（未授權）recipient 兩種情境。
//
// 前提：Safe 擁有人已經在 Safe{Wallet} 對 Allowance Module 執行過
// enableModule + addDelegate + setAllowance（JC/AE），見
// scripts/generate-safe-setup-batch.mjs 產生的批次。若尚未設定，這支腳本
// 會在第一步就明確失敗並印出原因，不會用假資料冒充成功。
//
// 執行方式：
//   node --env-file=.env.development.local scripts/e2e-allowance-test.mjs
//
// 這支腳本直接呼叫 api/_onchain.ts 的 payoutViaAllowance（跟後端 relayer.ts
// 的 mint-jc / subscribe(isAe) action 內部呼叫的是同一個函式），因此驗證的
// 是「Allowance Module 發放」這一段鏈上邏輯本身是否真的能把 Safe 金庫的錢轉
// 給任意收款地址、鏈上額度限制是否真的有效——這正是使用者要求驗證的核心。
//
// 註記（誠實範圍聲明）：這支腳本不會透過瀏覽器模擬「使用者用 Privy 連接錢包
// →在 SubscribePage 建立訂單→完成付款」的完整 UI 流程（那需要瀏覽器自動化+
// 真實使用者登入態，超出本次腳本範圍）。它模擬的是這條 UI 流程最終一定會
// 呼叫到的同一段後端程式碼路徑：一筆「已標記為 PAID/pending 的帳本列」→呼叫
// payoutViaAllowance→鏈上轉帳。recipient 只會是「後端程式碼決定要傳入的地址」
// ——在真實 relayer.ts 中，這個地址永遠是從 profiles.wallet_address 讀出來
// 的；這支腳本為了同時測試「惡意 recipient」情境，會刻意示範直接呼叫
// payoutViaAllowance 傳入一個跟任何使用者都無關的地址，用來證明合約本身並不
// 會阻止這件事——這正是需要被誠實揭露的鏈上殘餘風險。

import { createPublicClient, http, formatUnits, parseUnits } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const RPC_URL = "https://sepolia.base.org";
const SAFE_VAULT = "0xe886e67fd9CFe66fdb0A1F47cEf0001548a078cf";
const JC_TOKEN = "0xa85e0664701fBec23596bFE88eB26d4efd1C7723";

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });

const erc20Abi = [
  { inputs: [{ name: "a", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
];

async function jcBalance(address) {
  const bal = await publicClient.readContract({ address: JC_TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [address] });
  return formatUnits(bal, 18);
}

function explorerUrl(hash) {
  return `https://sepolia.basescan.org/tx/${hash}`;
}

// 測試用的兩個一次性收款地址：
//  - normalRecipient：模擬「正常、被系統認可的使用者收款地址」
//  - unauthorizedRecipient：模擬「未經站內 profiles 授權、與任何使用者無關的地址」
//    用來驗證 Allowance Module 本身是否會阻止轉給它（預期：不會阻止）。
const normalRecipientKey = generatePrivateKey();
const normalRecipient = privateKeyToAccount(normalRecipientKey).address;
const unauthorizedRecipientKey = generatePrivateKey();
const unauthorizedRecipient = privateKeyToAccount(unauthorizedRecipientKey).address;

async function run() {
  const { payoutViaAllowance, getAllowanceStatus, delegateAddress, ensureAllowanceCanCover } = await import(
    "../api/_onchain.ts"
  );

  console.log("== Safe Allowance Module 真實鏈上 E2E 測試（Base Sepolia）==");
  console.log("Safe 金庫:", SAFE_VAULT);
  console.log("JC Token:", JC_TOKEN);
  console.log("delegate:", delegateAddress());
  console.log("正常測試 recipient（一次性產生）:", normalRecipient);
  console.log("未授權測試 recipient（一次性產生）:", unauthorizedRecipient);
  console.log("");

  console.log("-- 步驟 1：確認 Allowance Module 額度已設定且足夠 --");
  const statusBefore = await getAllowanceStatus("jcToken");
  console.log(JSON.stringify({ ...statusBefore, amount: statusBefore.amount.toString(), spent: statusBefore.spent.toString(), remaining: statusBefore.remaining.toString(), resetTimeMin: statusBefore.resetTimeMin.toString(), lastResetMin: statusBefore.lastResetMin.toString(), nonce: statusBefore.nonce.toString() }, null, 2));
  if (!statusBefore.registered) {
    console.error("\n!! 尚未設定：Safe 擁有人還沒完成 addDelegate + setAllowance。無法繼續真實測試。");
    console.error("!! 請先執行 scripts/generate-safe-setup-batch.mjs 產生的批次，並在 Safe{Wallet} 完成簽署。");
    process.exit(1);
  }
  const testAmount = 5; // 5 JC，測試用小額
  await ensureAllowanceCanCover("jcToken", parseUnits(String(testAmount), 18));
  console.log(`額度足夠，本次測試發放 ${testAmount} JC\n`);

  console.log("-- 步驟 2：正常 recipient 測試（模擬付款訂單 PAID 後的 JC 發放）--");
  const safeBalBefore = await jcBalance(SAFE_VAULT);
  const userBalBefore = await jcBalance(normalRecipient);
  console.log(`Safe 金庫 JC 餘額（發放前）: ${safeBalBefore}`);
  console.log(`使用者錢包 JC 餘額（發放前）: ${userBalBefore}`);

  const normalTx = await payoutViaAllowance("jcToken", normalRecipient, testAmount);
  console.log(`\n真實交易已送出並確認，tx hash: ${normalTx}`);
  console.log(`區塊瀏覽器: ${explorerUrl(normalTx)}`);

  const safeBalAfter = await jcBalance(SAFE_VAULT);
  const userBalAfter = await jcBalance(normalRecipient);
  console.log(`Safe 金庫 JC 餘額（發放後）: ${safeBalAfter}`);
  console.log(`使用者錢包 JC 餘額（發放後）: ${userBalAfter}`);
  const normalOk = Number(userBalAfter) - Number(userBalBefore) === testAmount && Number(safeBalBefore) - Number(safeBalAfter) === testAmount;
  console.log(normalOk ? "✓ 正常發放流程驗證成功：Safe 餘額減少、User 錢包餘額增加，金額吻合\n" : "!! 餘額變化與預期不符，請人工檢查\n");

  console.log("-- 步驟 3：惡意（未授權）recipient 測試 --");
  console.log("直接呼叫 payoutViaAllowance，recipient 換成一個跟任何站內使用者 profiles.wallet_address 都無關的地址。");
  console.log("預期結果：仍然會成功上鏈——用來實證 Allowance Module 對 `to` 沒有鏈上白名單，這是已知風險，不是本次測試的 bug。");
  const unauthorizedBalBefore = await jcBalance(unauthorizedRecipient);
  const unauthorizedTx = await payoutViaAllowance("jcToken", unauthorizedRecipient, testAmount);
  console.log(`\n真實交易已送出並確認，tx hash: ${unauthorizedTx}`);
  console.log(`區塊瀏覽器: ${explorerUrl(unauthorizedTx)}`);
  const unauthorizedBalAfter = await jcBalance(unauthorizedRecipient);
  console.log(`未授權地址 JC 餘額：發放前 ${unauthorizedBalBefore} → 發放後 ${unauthorizedBalAfter}`);
  const unauthorizedSucceeded = Number(unauthorizedBalAfter) - Number(unauthorizedBalBefore) === testAmount;
  console.log(
    unauthorizedSucceeded
      ? "確認：Allowance Module 鏈上層級並未阻止轉給未授權地址——風險真實存在，需持續依賴後端 profiles.wallet_address 限制，不能只依賴鏈上模組\n"
      : "非預期：這筆竟然失敗了，需要人工重新檢查（不代表風險已解決，可能是其他原因如額度不足）\n",
  );

  console.log("-- 步驟 4：額度不足時應該擋下（不送出交易）--");
  const status2 = await getAllowanceStatus("jcToken");
  const overLimit = status2.remaining + parseUnits("1", 18);
  try {
    await ensureAllowanceCanCover("jcToken", overLimit);
    console.log("!! 警告：超過剩餘額度卻沒有被擋下，這不符合預期");
  } catch (e) {
    console.log(`✓ 超過剩餘額度時 ensureAllowanceCanCover 正確擋下（未送出任何鏈上交易）: ${e.message}\n`);
  }

  console.log("== 測試總結 ==");
  console.log(`正常發放 tx: ${normalTx}`);
  console.log(`惡意 recipient tx: ${unauthorizedTx}`);
  console.log(`recipient（正常）: ${normalRecipient}`);
  console.log(`recipient（未授權）: ${unauthorizedRecipient}`);
  console.log(`發放數量：各 ${testAmount} JC`);
}

run().catch((e) => {
  console.error("\n測試中止，錯誤:", e.message ?? e);
  process.exit(1);
});
