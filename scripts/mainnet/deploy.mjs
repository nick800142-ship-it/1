// Deploy the four Base mainnet contracts through the CREATE2 deployment proxy using the frozen
// init code in contracts/mainnet/deployment.json. Anyone can send these transactions; ownership
// is fixed in the constructor (Safe), so the sender gains no permissions. Default is a dry run.
//
//   node scripts/mainnet/deploy.mjs                          -> dry run: prints status and gas estimates
//   node --env-file-if-exists=/vercel/share/.env.project scripts/mainnet/deploy.mjs --broadcast
//        (signs with MAINNET_DEPLOYER_PRIVATE_KEY; requires Base mainnet ETH)
import assert from "node:assert/strict";
import fs from "node:fs";
import { createPublicClient, createWalletClient, encodePacked, fallback, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { buildMainnet } from "./build-contracts.mjs";

const deployment = JSON.parse(fs.readFileSync("contracts/mainnet/deployment.json", "utf8"));
assert.deepEqual(buildMainnet().addresses, deployment.addresses, "deployment.json 已過期，請先重新 build 並同步設定");
const transport = fallback([http("https://mainnet.base.org"), http("https://base-rpc.publicnode.com")]);
const pub = createPublicClient({ chain: base, transport });
assert.equal(await pub.getChainId(), 8453, "必須連到 Base 主網");

const broadcast = process.argv.includes("--broadcast");
let wallet;
if (broadcast) {
  const key = (process.env.MAINNET_DEPLOYER_PRIVATE_KEY ?? "").trim();
  assert.match(key, /^0x[0-9a-fA-F]{64}$/, "需設定 MAINNET_DEPLOYER_PRIVATE_KEY（0x + 64 hex）");
  wallet = createWalletClient({ account: privateKeyToAccount(key), chain: base, transport });
  const balance = await pub.getBalance({ address: wallet.account.address });
  console.log(`部署者 ${wallet.account.address}，ETH ${formatEther(balance)}`);
}

for (const entry of deployment.contracts) {
  const code = await pub.getCode({ address: entry.address });
  if (code && code.length > 2) {
    console.log(`${entry.name} 已在 ${entry.address}，略過`);
    continue;
  }
  const data = encodePacked(["bytes32", "bytes"], [entry.salt, entry.initCode]);
  const gas = await pub.estimateGas({ account: deployment.hotWallet, to: deployment.create2Deployer, data });
  console.log(`${entry.name} -> ${entry.address}，預估 gas ${gas}`);
  if (!broadcast) continue;
  const hash = await wallet.sendTransaction({ to: deployment.create2Deployer, data, gas: (gas * 12n) / 10n });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `${entry.name} 部署失敗 ${hash}`);
  let deployed;
  // Public RPC nodes can lag a few seconds behind the receipt.
  for (let attempt = 0; attempt < 10; attempt++) {
    deployed = await pub.getCode({ address: entry.address, blockNumber: receipt.blockNumber });
    if (deployed && deployed.length > 2) break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  assert.ok(deployed && deployed.length > 2, `${entry.name} 未出現在預期地址`);
  console.log(`  已部署 tx ${hash}`);
}
if (!broadcast) console.log("\n乾跑完成，未送出任何交易。確認後加 --broadcast。");
