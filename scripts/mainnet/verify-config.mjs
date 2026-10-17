// Checks that the frozen deployment, the frontend config and the backend config agree, and
// (read-only) that nothing has been deployed yet / the Safe is still as expected on Base mainnet.
//   node scripts/mainnet/verify-config.mjs [--offline]
import assert from "node:assert/strict";
import fs from "node:fs";
import { createPublicClient, fallback, getAddress, http, parseAbi } from "viem";
import { base } from "viem/chains";
import { buildMainnet } from "./build-contracts.mjs";

const deployment = JSON.parse(fs.readFileSync("contracts/mainnet/deployment.json", "utf8"));
const fresh = buildMainnet();
assert.deepEqual(fresh.addresses, deployment.addresses, "deployment.json 已過期，請重新執行 build-contracts.mjs");

const expected = {
  safe: deployment.safe,
  hotWallet: deployment.hotWallet,
  usdt: deployment.usdt,
  jcToken: deployment.addresses.jcToken,
  aeToken: deployment.addresses.aeToken,
  rwaFactory: deployment.addresses.rwaFactory,
  p2pEscrow: deployment.addresses.p2pEscrow,
};
for (const file of ["src/lib/mainnetConfig.ts", "api/_mainnetConfig.ts"]) {
  const text = fs.readFileSync(file, "utf8");
  for (const [key, value] of Object.entries(expected)) {
    const match = text.match(new RegExp(`\\b${key}: getAddress\\("(0x[0-9a-fA-F]{40})"\\)`));
    assert.ok(match, `${file} 缺少 ${key}`);
    assert.equal(getAddress(match[1]), getAddress(value), `${file} 的 ${key} 與 deployment.json 不一致`);
  }
}
console.log("設定一致：deployment.json、src/lib/mainnetConfig.ts、api/_mainnetConfig.ts");

if (!process.argv.includes("--offline")) {
  const client = createPublicClient({ chain: base, transport: fallback([http("https://mainnet.base.org"), http("https://base-rpc.publicnode.com")]) });
  assert.equal(await client.getChainId(), 8453);
  const deployerCode = await client.getCode({ address: deployment.create2Deployer });
  assert.ok(deployerCode && deployerCode.length > 2, "Base 主網缺少 CREATE2 部署器");
  for (const [key, address] of Object.entries(deployment.addresses)) {
    const code = await client.getCode({ address });
    console.log(`${key} ${address}: ${code && code.length > 2 ? "已部署" : "尚未部署"}`);
  }
  const safeAbi = parseAbi(["function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])"]);
  const threshold = await client.readContract({ address: deployment.safe, abi: safeAbi, functionName: "getThreshold" });
  const owners = await client.readContract({ address: deployment.safe, abi: safeAbi, functionName: "getOwners" });
  console.log(`Safe ${deployment.safe}: ${threshold}/${owners.length} — ${owners.join(", ")}`);
  const usdtDecimals = await client.readContract({ address: deployment.usdt, abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals" });
  assert.equal(usdtDecimals, 6, "主網 USDT 應為 6 decimals");
  const hotEth = await client.getBalance({ address: deployment.hotWallet });
  console.log(`熱錢包 ${deployment.hotWallet}: ${Number(hotEth) / 1e18} ETH`);
}
