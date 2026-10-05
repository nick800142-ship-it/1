import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const projectRoot = process.cwd();
const sourcePath = path.join(projectRoot, "contracts/P2PEscrow.sol");
const input = {
  language: "Solidity",
  sources: {
    "contracts/P2PEscrow.sol": { content: fs.readFileSync(sourcePath, "utf8") },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

function resolveImport(importPath) {
  const resolved = path.join(projectRoot, "node_modules", importPath);
  return fs.existsSync(resolved)
    ? { contents: fs.readFileSync(resolved, "utf8") }
    : { error: `Import not found: ${importPath}` };
}

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: resolveImport }));
const diagnostics = output.errors ?? [];
for (const diagnostic of diagnostics) {
  const write = diagnostic.severity === "error" ? console.error : console.warn;
  write(diagnostic.formattedMessage);
}
if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) process.exit(1);

const contract = output.contracts?.["contracts/P2PEscrow.sol"]?.P2PEscrow;
if (!contract?.evm.bytecode.object || contract.evm.bytecode.object.length === 0) {
  throw new Error("P2PEscrow did not produce deployable bytecode");
}
const required = new Set(["createOrder", "fillOrder", "cancelOrder", "totalLocked"]);
const compiled = new Set(contract.abi.filter((item) => item.type === "function").map((item) => item.name));
for (const method of required) {
  if (!compiled.has(method)) throw new Error(`Compiled escrow is missing ${method}`);
}
console.log(`P2PEscrow compiled successfully (${contract.evm.bytecode.object.length / 2} byte bytecode).`);
