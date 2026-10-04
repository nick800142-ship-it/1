// 部署含持有人自燒 + Safe 庫存銷毀的新 JC、AE、RWA Factory 到 Base Sepolia。
// 必須明確加 --broadcast 才會送出不可逆的鏈上部署交易。
// 用法: node --env-file-if-exists=/vercel/share/.env.project scripts/deploy-jc-ae-tokens.mjs --broadcast
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

async function deployCompiled(contractName, artifact, args, account, walletClient, publicClient) {
  console.log(`Deploying ${contractName} from ${account.address} with args:`, args);
  const hash = await walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
  console.log(`${contractName} deploy tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${contractName} deployment failed: ${hash}`);
  console.log(`${contractName} deployed at: ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

async function main() {
  const safeVault = "0xe886e67fd9CFe66fdb0A1F47cEf0001548a078cf";
  const jcSupply = parseUnits("1000000", 18);
  const aeSupply = parseUnits("24000000", 18);
  const artifactSpecs = [
    ["JCToken.sol", "JCToken"],
    ["AEToken.sol", "AEToken"],
    ["RWAFactory.sol", "RWAFactory"],
  ];
  const artifacts = artifactSpecs.map(([fileName, contractName]) => compile(fileName, contractName));

  if (process.argv.includes("--check")) {
    console.log("JC、AE、RWA Factory 編譯成功；未讀取部署密鑰、未送出鏈上交易。");
    return;
  }
  if (!process.argv.includes("--broadcast")) {
    throw new Error("部署會建立不可升級的新合約並消耗 Base Sepolia ETH。先用 --check 檢查，確認部署後再明確傳入 --broadcast");
  }

  const account = ownerAccount();
  const deploySpecs = [
    ["JCToken.sol", "JCToken", ["JC Coin", "JC", 18, safeVault, jcSupply]],
    ["AEToken.sol", "AEToken", ["AE Token", "AE", 18, safeVault, aeSupply]],
    ["RWAFactory.sol", "RWAFactory", [safeVault, account.address]],
  ];
  const transport = http("https://sepolia.base.org");
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport });
  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const addresses = [];
  for (let index = 0; index < deploySpecs.length; index += 1) {
    const [, contractName, args] = deploySpecs[index];
    addresses.push(await deployCompiled(contractName, artifacts[index], args, account, walletClient, publicClient));
  }

  console.log("\n=== DEPLOY RESULT ===");
  console.log("JC_TOKEN_ADDRESS=" + addresses[0]);
  console.log("AE_TOKEN_ADDRESS=" + addresses[1]);
  console.log("RWA_FACTORY_ADDRESS=" + addresses[2]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
