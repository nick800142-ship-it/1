// 唯讀：統計 ADMIN 熱錢包「送出並付 Gas」的交易中實際搬動的代幣數量（依幣種加總）。
// 用法：node scripts/gas-sponsored-volume.mjs
const ADMIN = "0xbc75d3b4F409D3032f71A02C3a1546DCb3301bb3".toLowerCase();
const api = "https://base-sepolia.blockscout.com/api/v2";

async function fetchAll(url) {
  const items = [];
  let params = "";
  for (let attempt = 0; attempt < 30; ) {
    const res = await fetch(url + (params ? `${url.includes("?") ? "&" : "?"}${params}` : ""));
    if (!res.ok) { attempt++; await new Promise((r) => setTimeout(r, 2000)); continue; }
    const json = await res.json();
    items.push(...json.items);
    if (!json.next_page_params) break;
    params = new URLSearchParams(
      Object.entries(json.next_page_params).map(([k, v]) => [k, String(v)]),
    ).toString();
  }
  return items;
}

const adminTxs = new Set(
  (await fetchAll(`${api}/addresses/${ADMIN}/transactions`))
    .filter((tx) => tx.from?.hash?.toLowerCase() === ADMIN && tx.status === "ok")
    .map((tx) => tx.hash.toLowerCase()),
);

// 熱錢包送出的交易，轉帳一定牽涉熱錢包本身或經由熱錢包授權（transferFrom），
// 所以用熱錢包的代幣轉帳清單即可涵蓋，再以 tx hash 限定為熱錢包自己送出的交易。
const transfers = await fetchAll(`${api}/addresses/${ADMIN}/token-transfers`);
const byToken = {};
const seen = new Set();
for (const t of transfers) {
  const hash = t.transaction_hash?.toLowerCase();
  if (!adminTxs.has(hash)) continue;
  const key = `${hash}:${t.log_index}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const sym = t.token?.symbol || t.token?.address_hash;
  const decimals = Number(t.total?.decimals ?? t.token?.decimals ?? 18);
  const value = Number(BigInt(t.total?.value ?? "0")) / 10 ** decimals;
  const fromAdmin = t.from?.hash?.toLowerCase() === ADMIN;
  const toAdmin = t.to?.hash?.toLowerCase() === ADMIN;
  byToken[sym] ??= { address: t.token?.address_hash, transfers: 0, total: 0, outFromAdmin: 0, intoAdmin: 0, passThrough: 0 };
  const row = byToken[sym];
  row.transfers++;
  row.total += value;
  if (fromAdmin) row.outFromAdmin += value;
  else if (toAdmin) row.intoAdmin += value;
  else row.passThrough += value;
}
console.log(JSON.stringify({ adminTxCount: adminTxs.size, tokenTransfersFetched: transfers.length, byToken }, null, 2));
