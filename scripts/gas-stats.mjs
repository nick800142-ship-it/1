// 唯讀：從 Blockscout 列出 ADMIN 熱錢包的所有交易，統計平台代付的 Gas 與補貼給用戶的 ETH。
// 用法：node scripts/gas-stats.mjs
const ADMIN = "0xbc75d3b4F409D3032f71A02C3a1546DCb3301bb3".toLowerCase();
const base = `https://base-sepolia.blockscout.com/api/v2/addresses/${ADMIN}/transactions`;
const txs = [];
let params = "";
for (let attempt = 0, page = 0; page < 300 && attempt < 20; ) {
  const res = await fetch(base + (params ? `?${params}` : ""));
  if (!res.ok) { attempt++; await new Promise((r) => setTimeout(r, 2000)); continue; }
  const json = await res.json();
  txs.push(...json.items);
  page++;
  if (!json.next_page_params) break;
  params = new URLSearchParams(
    Object.entries(json.next_page_params).map(([k, v]) => [k, String(v)]),
  ).toString();
}
const wei = (v) => BigInt(v ?? "0");
const eth = (v) => Number(v) / 1e18;
let feeWei = 0n, sentTx = 0, failed = 0, sponsorWei = 0n, sponsorCount = 0, contractEthOut = 0n, ethIn = 0n;
const sponsored = new Set();
const byMethod = {};
let first = null, last = null;
for (const tx of txs) {
  const from = tx.from?.hash?.toLowerCase();
  const to = tx.to?.hash?.toLowerCase();
  if (from === ADMIN) {
    sentTx++;
    feeWei += wei(tx.fee?.value);
    if (tx.status !== "ok") failed++;
    const plainEth = !tx.raw_input || tx.raw_input === "0x";
    const method = tx.method || (plainEth ? "ETH 轉帳" : "unknown");
    byMethod[method] ??= { count: 0, fee: 0n };
    byMethod[method].count++;
    byMethod[method].fee += wei(tx.fee?.value);
    if (plainEth && wei(tx.value) > 0n && tx.status === "ok") {
      if (tx.to?.is_contract) contractEthOut += wei(tx.value);
      else { sponsorWei += wei(tx.value); sponsorCount++; sponsored.add(to); }
    }
    if (!first || tx.timestamp < first) first = tx.timestamp;
    if (!last || tx.timestamp > last) last = tx.timestamp;
  } else if (to === ADMIN && tx.status === "ok") {
    ethIn += wei(tx.value);
  }
}
console.log(JSON.stringify({
  fetched: txs.length, sentTx, failed, first, last,
  adminGasFeeEth: eth(feeWei),
  sponsorEth: eth(sponsorWei), sponsorCount, sponsoredWallets: sponsored.size,
  contractEthOut: eth(contractEthOut), ethReceived: eth(ethIn),
  byMethod: Object.fromEntries(
    Object.entries(byMethod)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([k, v]) => [k, { count: v.count, feeEth: eth(v.fee) }]),
  ),
}, null, 2));
