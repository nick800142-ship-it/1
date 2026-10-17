import fs from "node:fs"
import path from "node:path"
import solc from "solc"
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  fallback,
  formatEther,
  getAddress,
  http,
  type Address,
} from "viem"
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts"
import { baseSepolia } from "viem/chains"
import { withAdminNonceLock } from "../api/_relayerLock.ts"

const root = process.cwd()
const sourcePath = path.join(root, "contracts/P2PEscrow.sol")
const aeToken = getAddress("0x62452c4fd6950D2B5BaE251F39f082900D43B37f")
const safeVault = getAddress("0xe886e67fd9CFe66fdb0A1F47cEf0001548a078cf")
const source = fs.readFileSync(sourcePath, "utf8")
const compilerInput = {
  language: "Solidity",
  sources: { "contracts/P2PEscrow.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: "shanghai",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
}

function resolveImport(importPath: string) {
  const importedPath = path.join(root, "node_modules", importPath)
  return fs.existsSync(importedPath)
    ? { contents: fs.readFileSync(importedPath, "utf8") }
    : { error: `Import not found: ${importPath}` }
}

const compiled = JSON.parse(solc.compile(JSON.stringify(compilerInput), { import: resolveImport }))
const diagnostics = compiled.errors ?? []
for (const diagnostic of diagnostics) {
  const output = diagnostic.severity === "error" ? console.error : console.warn
  output(diagnostic.formattedMessage)
}
if (diagnostics.some((diagnostic: { severity: string }) => diagnostic.severity === "error")) {
  throw new Error("P2PEscrow Solidity compilation failed")
}

const artifact = compiled.contracts?.["contracts/P2PEscrow.sol"]?.P2PEscrow
if (!artifact?.evm?.bytecode?.object) throw new Error("P2PEscrow bytecode was not generated")
const bytecode = `0x${artifact.evm.bytecode.object}` as `0x${string}`
const key = (process.env.ADMIN_PRIVATE_KEY ?? "").trim()
if (!key) throw new Error("ADMIN_PRIVATE_KEY is not configured")
const account = /^0x[0-9a-fA-F]{64}$/.test(key)
  ? privateKeyToAccount(key as `0x${string}`)
  : /^[0-9a-fA-F]{64}$/.test(key)
    ? privateKeyToAccount(`0x${key}`)
    : mnemonicToAccount(key)
const rpcUrls = [process.env.BASE_SEPOLIA_RPC_URL, "https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"]
  .filter((url): url is string => Boolean(url))
const transport = fallback(rpcUrls.map((url) => http(url)))
const publicClient = createPublicClient({ chain: baseSepolia, transport })
const walletClient = createWalletClient({ account, chain: baseSepolia, transport })
const [chainId, balance, tokenCode, aeDecimals] = await Promise.all([
  publicClient.getChainId(),
  publicClient.getBalance({ address: account.address }),
  publicClient.getCode({ address: aeToken }),
  publicClient.readContract({
    address: aeToken,
    abi: [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }],
    functionName: "decimals",
  }),
])
if (chainId !== baseSepolia.id) throw new Error(`Refusing deployment on chain ${chainId}; expected Base Sepolia (${baseSepolia.id})`)
if (!tokenCode || tokenCode === "0x" || aeDecimals !== 18) throw new Error("Configured AE token is missing or does not use 18 decimals")

// owner = Safe 多簽（費率／收款／operator／解除暫停需 Ledger 簽核）；operator = 熱錢包（日常撮合、退單、緊急暫停）。
const args = [safeVault, aeToken, safeVault, account.address] as const
const deployData = encodeDeployData({ abi: artifact.abi, bytecode, args })
const [estimatedGas, gasPrice] = await Promise.all([
  publicClient.estimateGas({ account: account.address, data: deployData }),
  publicClient.getGasPrice(),
])
const costWithBuffer = (estimatedGas * gasPrice * 120n) / 100n
if (balance < costWithBuffer) throw new Error("ADMIN wallet does not have enough Base Sepolia ETH for deployment plus gas buffer")

console.log(JSON.stringify({
  chain: "Base Sepolia",
  chainId,
  deployer: account.address,
  feeRecipient: safeVault,
  aeToken,
  aeTokenDecimals: aeDecimals,
  bytecodeBytes: artifact.evm.bytecode.object.length / 2,
  estimatedGas: estimatedGas.toString(),
  estimatedCostEth: formatEther(estimatedGas * gasPrice),
  gasBufferCostEth: formatEther(costWithBuffer),
  deployRequested: process.argv.includes("--deploy"),
}))

if (!process.argv.includes("--deploy")) {
  console.log("Preflight only. Pass --deploy to broadcast the deployment transaction.")
  process.exit(0)
}

const hash = await withAdminNonceLock(async () => {
  const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" })
  return walletClient.deployContract({
    account,
    abi: artifact.abi,
    bytecode,
    args,
    nonce,
  })
})
console.log(`Deployment transaction submitted: ${hash}`)
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 })
if (receipt.status !== "success" || !receipt.contractAddress) {
  throw new Error(`P2PEscrow deployment failed: ${receipt.status}`)
}
const address = getAddress(receipt.contractAddress) as Address
const deployedCode = await publicClient.getCode({ address })
if (!deployedCode || deployedCode === "0x") throw new Error("Deployment receipt succeeded but no contract code is present")
const [owner, operator, feeRecipient, deployedAeToken] = await Promise.all([
  publicClient.readContract({ address, abi: artifact.abi, functionName: "owner" }),
  publicClient.readContract({ address, abi: artifact.abi, functionName: "operator" }),
  publicClient.readContract({ address, abi: artifact.abi, functionName: "feeRecipient" }),
  publicClient.readContract({ address, abi: artifact.abi, functionName: "aeToken" }),
])
if (owner.toLowerCase() !== safeVault.toLowerCase() || operator.toLowerCase() !== account.address.toLowerCase() || feeRecipient.toLowerCase() !== safeVault.toLowerCase() || deployedAeToken.toLowerCase() !== aeToken.toLowerCase()) {
  throw new Error("Deployed contract verification mismatch; do not enable market routing")
}
console.log(JSON.stringify({
  deployedAddress: address,
  transactionHash: hash,
  blockNumber: receipt.blockNumber.toString(),
  gasUsed: receipt.gasUsed.toString(),
  owner,
  operator,
  feeRecipient,
  aeToken: deployedAeToken,
  verified: true,
}))
