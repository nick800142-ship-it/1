// 產生「Safe Owner 手動設定」用的 Safe Transaction Builder 批次 JSON。
//
// 這支腳本只做編碼（encodeFunctionData），不會送出任何交易、不需要任何私鑰。
// 產出的 JSON 可以直接匯入 https://app.safe.global 的 Transaction Builder App，
// 讓 Safe 擁有人（threshold=1，可自己一鍵簽署）連接錢包後一次性執行以下 4 筆操作：
//
//   1. enableModule(AllowanceModule)         —— 在 Safe 本體啟用 Allowance Module
//   2. addDelegate(delegate)                 —— 註冊 delegate 為 Allowance Module 的動用人
//   3. setAllowance(delegate, JC, 10000, 1440, 0)  —— JC 每日額度 10,000
//   4. setAllowance(delegate, AE, 10000, 1440, 0)  —— AE 每日額度 10,000
//
// 執行方式：
//   node --env-file=.env.development.local scripts/generate-safe-setup-batch.mjs
//
// 額度可用環境變數覆蓋：SAFE_SETUP_JC_DAILY_LIMIT / SAFE_SETUP_AE_DAILY_LIMIT
// （人類可讀單位，例如 "10000"）。

import { encodeFunctionData, getAddress, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { writeFileSync } from "node:fs";

const SAFE_VAULT = getAddress("0xe886e67fd9CFe66fdb0A1F47cEf0001548a078cf");
const ALLOWANCE_MODULE = getAddress("0xAA46724893dedD72658219405185Fb0Fc91e091C");
const JC_TOKEN = getAddress("0xa85e0664701fBec23596bFE88eB26d4efd1C7723");
const AE_TOKEN = getAddress("0x45C50E069F013B2b4Ae11a8F8F89C97d31e8D7cb");
const CHAIN_ID = 84532; // Base Sepolia

const rawKey = (process.env.DELEGATE_PRIVATE_KEY ?? "").trim();
if (!rawKey) {
  console.error("缺少 DELEGATE_PRIVATE_KEY，請用 --env-file 帶入 .env.development.local 執行");
  process.exit(1);
}
const delegateKey = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
const DELEGATE = privateKeyToAccount(delegateKey).address;

const JC_DAILY_LIMIT = process.env.SAFE_SETUP_JC_DAILY_LIMIT ?? "10000";
const AE_DAILY_LIMIT = process.env.SAFE_SETUP_AE_DAILY_LIMIT ?? "10000";

const safeAbi = [
  { inputs: [{ name: "module", type: "address" }], name: "enableModule", outputs: [], stateMutability: "nonpayable", type: "function" },
];
const allowanceModuleAbi = [
  { inputs: [{ name: "delegate", type: "address" }], name: "addDelegate", outputs: [], stateMutability: "nonpayable", type: "function" },
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
];

function setAllowanceData(token, humanAmount) {
  // JC/AE 皆為 18 decimals（見 memory / tokenDecimals 實際查詢結果）。
  const amountUnits = parseUnits(humanAmount, 18);
  return encodeFunctionData({
    abi: allowanceModuleAbi,
    functionName: "setAllowance",
    args: [DELEGATE, token, amountUnits, 1440, 0],
  });
}

const transactions = [
  {
    to: SAFE_VAULT,
    value: "0",
    data: encodeFunctionData({ abi: safeAbi, functionName: "enableModule", args: [ALLOWANCE_MODULE] }),
  },
  {
    to: ALLOWANCE_MODULE,
    value: "0",
    data: encodeFunctionData({ abi: allowanceModuleAbi, functionName: "addDelegate", args: [DELEGATE] }),
  },
  {
    to: ALLOWANCE_MODULE,
    value: "0",
    data: setAllowanceData(JC_TOKEN, JC_DAILY_LIMIT),
  },
  {
    to: ALLOWANCE_MODULE,
    value: "0",
    data: setAllowanceData(AE_TOKEN, AE_DAILY_LIMIT),
  },
];

const batch = {
  version: "1.0",
  chainId: String(CHAIN_ID),
  createdAt: Date.now(),
  meta: {
    name: "Allowance Module 初始化（enableModule + addDelegate + setAllowance JC/AE）",
    description:
      `啟用 Allowance Module、註冊 delegate（${DELEGATE}）、設定 JC 每日額度 ${JC_DAILY_LIMIT}、AE 每日額度 ${AE_DAILY_LIMIT}。`,
    txBuilderVersion: "1.16.5",
    createdFromSafeAddress: SAFE_VAULT,
    createdFromOwnerAddress: "",
  },
  transactions,
};

const outPath = new URL("./output/safe-allowance-setup-batch.json", import.meta.url);
writeFileSync(outPath, JSON.stringify(batch, null, 2));

console.log("== Safe Owner 手動設定批次已產生 ==");
console.log("輸出檔案:", outPath.pathname);
console.log("");
console.log("Safe 金庫:", SAFE_VAULT);
console.log("Allowance Module:", ALLOWANCE_MODULE);
console.log("delegate（本次要授權的動用人）:", DELEGATE);
console.log("JC 每日額度:", JC_DAILY_LIMIT, "JC Token:", JC_TOKEN);
console.log("AE 每日額度:", AE_DAILY_LIMIT, "AE Token:", AE_TOKEN);
console.log("");
console.log("下一步（需要 Safe 擁有人本人操作，threshold=1 可一鍵簽署）：");
console.log("  1. 開啟 https://app.safe.global/apps/open?safe=basesep:" + SAFE_VAULT + "&appUrl=https%3A%2F%2Fapps-portal.safe.global%2Ftx-builder");
console.log("     （若上面連結打不開，改用 Safe{Wallet} → 左側 Apps → 搜尋 Transaction Builder）");
console.log("  2. 連接 Safe 擁有人的錢包（owner 地址 0x2D523de4152efD2aa6d2135f6693B061EF73499a）");
console.log("  3. 在 Transaction Builder 畫面選擇「Upload batch」，上傳上面輸出的 JSON 檔案");
console.log("  4. 檢查畫面上列出的 4 筆交易內容與這裡印出的地址/金額一致");
console.log("  5. 點擊 Create Batch → Send Batch → 用 owner 錢包簽署並送出（threshold=1，這一步就會真正上鏈）");
console.log("  6. 交易確認後，回來執行 scripts/verify-allowance-module.mjs 確認狀態已從 registered=false 變成 true");
