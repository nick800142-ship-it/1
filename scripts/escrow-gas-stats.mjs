// 唯讀：統計二級市場託管合約相關交易的 Gas，區分「熱錢包直接付」與「用戶錢包付（由平台預先補貼的 ETH）」。
// 用法：node scripts/escrow-gas-stats.mjs
const API = "https://base-sepolia.blockscout.com/api/v2";
const ESCROW = "0xBfb3456226cA1e46Cf2BDB3b2d42619a2B7B8Db0".toLowerCase();
const HOT = "0xbc75d3b4F409D3032f71A02C3a1546DCb3301bb3".toLowerCase();
const TOKENS = {
  JC: "0xE035d5A79664843089F9Ee9F8dA2980cfB5eE4D9".toLowerCase(),
  AE: "0x62452c4fd6950D2B5BaE251F39f082900D43B37f".toLowerCase(),
};

async function getJson(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(`fetch failed: ${url}`);
}

async function allTxs(address) {
  const out = [];
  let params = "";
  for (;;) {
    const page = await getJson(`${API}/addresses/${address}/transactions${params ? `?${params}` : ""}`);
    out.push(...page.items);
    if (!page.next_page_params) break;
    params = new URLSearchParams(page.next_page_params).toString();
  }
  return out;
}

const fee = (tx) => Number(tx.fee?.value ?? 0) / 1e18;

const escrowTxs = await allTxs(ESCROW);
const byMethod = {};
let hotFee = 0, userFee = 0, hotCount = 0, userCount = 0;
const users = new Set();
for (const tx of escrowTxs) {
  if (tx.to?.hash?.toLowerCase() !== ESCROW) continue;
  const from = tx.from.hash.toLowerCase();
  const method = tx.method || "unknown";
  const isHot = from === HOT;
  const key = `${isHot ? "hot" : "user"}:${method}`;
  byMethod[key] ??= { count: 0, fee: 0 };
  byMethod[key].count++;
  byMethod[key].fee += fee(tx);
  if (isHot) { hotFee += fee(tx); hotCount++; } else { userFee += fee(tx); userCount++; users.add(from); }
}

// 用戶為了託管而對 JC/AE/RWA 做的 approve（spender = 託管合約）也算進二級市場 Gas。
let approveFee = 0, approveCount = 0;
for (const user of users) {
  const txs = await allTxs(user);
  for (const tx of txs) {
    if (tx.from.hash.toLowerCase() !== user) continue;
    // Blockscout 常常解不出 approve 名稱，改以函式選擇器 0x095ea7b3 與 calldata 內的 spender 判斷。
    const input = (tx.raw_input || "").toLowerCase();
    if (!input.startsWith("0x095ea7b3")) continue;
    const spender = `0x${input.slice(34, 74)}`;
    if (spender !== ESCROW) continue;
    approveFee += fee(tx);
    approveCount++;
  }
}

console.log(JSON.stringify({
  escrowContractTxs: escrowTxs.length,
  hotWallet: { count: hotCount, feeEth: hotFee },
  userWallets: { users: users.size, count: userCount, feeEth: userFee },
  userApprovesToEscrow: { count: approveCount, feeEth: approveFee },
  byMethod,
  tokens: TOKENS,
}, null, 2));
