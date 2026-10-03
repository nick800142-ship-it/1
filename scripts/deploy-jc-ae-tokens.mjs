// 編譯並部署新版 JCToken.sol / AEToken.sol 到 Base Sepolia。
// 用法: node --env-file-if-exists=/vercel/share/.env.project scripts/deploy-jc-ae-tokens.mjs
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
    // relative import within contracts/
    const full = path.join(CONTRACTS_DIR, importPath);
    return { contents: fs.readFileSync(full, "utf8") };
  } catch (e) {
    return { error: "File not found: " + importPath };
  }
}

function compile(fileName, contractName) {
  const input = {
    language: "Solidity",
    sources: {
      [fileName]: { content: readSource(fileName) },
    },
    settings: {
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
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

async function deployToken(fileName, contractName, args) {
  const { abi, bytecode } = compile(fileName, contractName);
  const account = ownerAccount();
  const transport = http("https://sepolia.base.org");
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport });
  const publicClient = createPublicClient({ chain: baseSepolia, transport });

  console.log(`Deploying ${contractName} from ${account.address} with args:`, args);
  const hash = await walletClient.deployContract({ abi, bytecode, args });
  console.log(`${contractName} deploy tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`${contractName} deployed at: ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

async function main() {
  const safeVault = "0xe886e67fd9CFe66fdb0A1F47cEf0001548a078cf";
  const jcSupply = parseUnits("1000000", 18);
  const aeSupply = parseUnits("24000000", 18);

  const jcAddress = await deployToken("JCToken.sol", "JCToken", [
    "JC Coin",
    "JC",
    18,
    safeVault,
    jcSupply,
  ]);

  const aeAddress = await deployToken("AEToken.sol", "AEToken", [
    "AE Token",
    "AE",
    18,
    safeVault,
    aeSupply,
  ]);

  console.log("\n=== DEPLOY RESULT ===");
  console.log("JC_TOKEN_ADDRESS=" + jcAddress);
  console.log("AE_TOKEN_ADDRESS=" + aeAddress);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
