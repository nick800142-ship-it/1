// 重新部署新版 AEToken.sol（新增 adminReclaim 強制收回功能）到 Base Sepolia。
// 用法: node --env-file-if-exists=/vercel/share/.env.project scripts/redeploy-ae-token.mjs
import fs from "node:fs";
import path from "node:path";
import solc from "solc";
import { createWalletClient, createPublicClient, http, parseUnits } from "viem";
import { privateKeyToAccount, mnemonicToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const ROOT = process.cwd();
const CONTRACTS_DIR = path.join(ROOT, "contracts");
const OZ_DIR = path.join(ROOT, "node_modules", "@openzeppelin", "contracts");

function readSource(relPath) {
  return fs.readFileSync(path.join(CONTRACTS_DIR, relPath), "utf8");
}

function findImport(importPath) {
  try {
    if (importPath.startsWith("@openzeppelin/contracts/")) {
      const rel = importPath.replace("@openzeppelin/contracts/", "");
      const full = path.join(OZ_DIR, rel);
      return { contents: fs.readFileSync(full, "utf8") };
    }
    const full = path.join(CONTRACTS_DIR, importPath);
    return { contents: fs.readFileSync(full, "utf8") };
  } catch (e) {
    return { error: "File not found: " + importPath };
  }
}

function compile(fileName, contractName) {
  const input = {
    language: "Solidity",
    sources: { [fileName]: { content: readSource(fileName) } },
    settings: {
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
      optimizer: { enabled: true, runs: 200 },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));
  if (output.errors) {
    const fatal = output.errors.filter((e) => e.severity === "error");
    if (fatal.length) {
      console.error(JSON.stringify(fatal, null, 2));
      throw new Error(`Compile failed for ${fileName}`);
    }
  }
  const artifact = output.contracts[fileName][contractName];
  return { abi: artifact.abi, bytecode: "0x" + artifact.evm.bytecode.object };
}

function ownerAccount() {
  const raw = (process.env.ADMIN_PRIVATE_KEY || "").trim();
  if (!raw) throw new Error("ADMIN_PRIVATE_KEY missing");
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return privateKeyToAccount(raw);
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length >= 12) return mnemonicToAccount(raw);
  const withPrefix = raw.startsWith("0x") ? raw : "0x" + raw;
  return privateKeyToAccount(withPrefix);
}

async function main() {
  const safeVault = "0xe886e67fd9CFe66fdb0A1F47cEf0001548a078cf";
  const aeSupply = parseUnits("24000000", 18);

  const { abi, bytecode } = compile("AEToken.sol", "AEToken");
  const account = ownerAccount();
  const transport = http("https://sepolia.base.org");
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport });
  const publicClient = createPublicClient({ chain: baseSepolia, transport });

  const args = ["AE Token", "AE", 18, safeVault, aeSupply];
  console.log(`Deploying AEToken from ${account.address} with args:`, args);
  const hash = await walletClient.deployContract({ abi, bytecode, args });
  console.log(`AEToken deploy tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("\n=== DEPLOY RESULT ===");
  console.log("AE_TOKEN_ADDRESS=" + receipt.contractAddress);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
