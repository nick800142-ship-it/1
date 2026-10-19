// Compile the Base mainnet contracts, freeze their exact init code, and compute the
// CREATE2 addresses they will get when deployed through the standard deterministic
// deployment proxy. No keys are read and nothing is sent on chain.
//
//   node scripts/mainnet/build-contracts.mjs          -> writes contracts/mainnet/deployment.json
//   node scripts/mainnet/build-contracts.mjs --check  -> fails if the frozen file is out of date
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import solc from "solc";
import { encodeAbiParameters, encodePacked, getAddress, getContractAddress, keccak256, toHex } from "viem";

const root = process.cwd();
const outFile = path.join(root, "contracts/mainnet/deployment.json");

export const MAINNET = {
  chainId: 8453,
  safe: getAddress("0x75653E53DE9b7b390e803295DdB4Afc461b55A9b"),
  hotWallet: getAddress("0x9FB5c5315Dc4329BFd04c17AB099a2e01327377F"),
  // 買入／回收 JC 的穩定幣（Base 主網 Circle 原生 USDC）；合約不綁定，只是部署紀錄。
  stablecoin: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  create2Deployer: getAddress("0x4e59b44847b379578588920cA78FbF26c0B4956C"),
};

const SOLC_VERSION = "0.8.37";
const settings = {
  optimizer: { enabled: true, runs: 200 },
  viaIR: true,
  evmVersion: "shanghai",
  metadata: { bytecodeHash: "none" },
  outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
};

const files = ["PlatformToken.sol", "JCToken.sol", "AEToken.sol", "RWAFactory.sol", "P2PEscrow.sol"];

function compile() {
  assert.equal(solc.version().split("+")[0], SOLC_VERSION, `solc must be ${SOLC_VERSION} so the bytecode (and addresses) stay identical`);
  const sources = Object.fromEntries(
    files.map((file) => [`contracts/mainnet/${file}`, { content: fs.readFileSync(path.join(root, "contracts/mainnet", file), "utf8") }]),
  );
  const output = JSON.parse(
    solc.compile(JSON.stringify({ language: "Solidity", sources, settings }), {
      import: (importPath) => {
        const resolved = path.join(root, "node_modules", importPath);
        return fs.existsSync(resolved) ? { contents: fs.readFileSync(resolved, "utf8") } : { error: `Import not found: ${importPath}` };
      },
    }),
  );
  const errors = (output.errors ?? []).filter((d) => d.severity === "error");
  if (errors.length) throw new Error(errors.map((d) => d.formattedMessage).join("\n"));
  const get = (file, name) => {
    const artifact = output.contracts[`contracts/mainnet/${file}`][name];
    return { abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` };
  };
  return {
    JCToken: get("JCToken.sol", "JCToken"),
    AEToken: get("AEToken.sol", "AEToken"),
    RWAFactory: get("RWAFactory.sol", "RWAFactory"),
    P2PEscrow: get("P2PEscrow.sol", "P2PEscrow"),
    RWAShareToken: get("RWAFactory.sol", "RWAShareToken"),
  };
}

const salt = (label) => keccak256(toHex(`rwmt.mainnet.v1:${label}`));

function plan(artifacts) {
  const entries = [];
  const add = (name, label, types, args) => {
    const ctor = encodeAbiParameters(types.map((type) => ({ type })), args);
    const initCode = encodePacked(["bytes", "bytes"], [artifacts[name].bytecode, ctor]);
    const s = salt(label);
    const address = getContractAddress({ opcode: "CREATE2", from: MAINNET.create2Deployer, salt: s, bytecode: initCode });
    entries.push({ name, label, salt: s, constructorArgs: args, initCodeHash: keccak256(initCode), initCode, address });
    return address;
  };
  const jc = add("JCToken", "JC", ["address"], [MAINNET.safe]);
  const ae = add("AEToken", "AE", ["address"], [MAINNET.safe]);
  const factory = add("RWAFactory", "RWAFactory", ["address"], [MAINNET.safe]);
  // P2PEscrow(feeRecipient, aeToken, initialOwner, initialOperator)
  const escrow = add("P2PEscrow", "P2PEscrow", ["address", "address", "address", "address"], [MAINNET.safe, ae, MAINNET.safe, MAINNET.hotWallet]);
  return { entries, addresses: { jcToken: jc, aeToken: ae, rwaFactory: factory, p2pEscrow: escrow } };
}

export function buildMainnet() {
  const artifacts = compile();
  const { entries, addresses } = plan(artifacts);
  return {
    network: "base",
    chainId: MAINNET.chainId,
    solc: SOLC_VERSION,
    settings: { optimizer: settings.optimizer, viaIR: settings.viaIR, evmVersion: settings.evmVersion, bytecodeHash: "none" },
    create2Deployer: MAINNET.create2Deployer,
    safe: MAINNET.safe,
    hotWallet: MAINNET.hotWallet,
    stablecoin: MAINNET.stablecoin,
    addresses,
    contracts: entries,
    abis: Object.fromEntries(Object.entries(artifacts).map(([name, a]) => [name, a.abi])),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = buildMainnet();
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
    if (current !== text) {
      console.error("contracts/mainnet/deployment.json 已過期：合約原始碼或編譯設定改過，地址會改變。請重新執行 build 並同步網站設定。");
      process.exit(1);
    }
    console.log("deployment.json 與原始碼一致。");
  } else {
    fs.writeFileSync(outFile, text);
    console.log("已寫入 contracts/mainnet/deployment.json");
  }
  for (const [key, value] of Object.entries(result.addresses)) console.log(`${key}=${value}`);
}
