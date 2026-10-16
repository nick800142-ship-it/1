import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import solc from "solc";
import ganache from "ganache";
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = process.cwd();
const escrowPath = path.join(root, "contracts/P2PEscrow.sol");
const mockTokenSource = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract MockEscrowERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    constructor(string memory name_, uint8 decimals_) { name = name_; symbol = name_; decimals = decimals_; }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { _move(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }
    function _move(address from, address to, uint256 amount) private {
        require(to != address(0) && balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}`;

const input = {
  language: "Solidity",
  sources: {
    "contracts/P2PEscrow.sol": { content: fs.readFileSync(escrowPath, "utf8") },
    "contracts/MockEscrowERC20.sol": { content: mockTokenSource },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: "shanghai",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};
function resolveImport(importPath) {
  const resolved = path.join(root, "node_modules", importPath);
  return fs.existsSync(resolved)
    ? { contents: fs.readFileSync(resolved, "utf8") }
    : { error: `Import not found: ${importPath}` };
}
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: resolveImport }));
const diagnostics = output.errors ?? [];
for (const diagnostic of diagnostics) {
  if (diagnostic.severity === "error") console.error(diagnostic.formattedMessage);
}
assert.equal(diagnostics.some((diagnostic) => diagnostic.severity === "error"), false, "Solidity compilation must succeed");

const escrowArtifact = output.contracts["contracts/P2PEscrow.sol"].P2PEscrow;
const tokenArtifact = output.contracts["contracts/MockEscrowERC20.sol"].MockEscrowERC20;
const chain = defineChain({
  id: 84532,
  name: "Local Base Sepolia test chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } },
});
const provider = ganache.provider({
  logging: { quiet: true },
  chain: { chainId: chain.id },
  wallet: { totalAccounts: 4, defaultBalance: 1_000 },
});

async function main() {
  const accounts = Object.values(provider.getInitialAccounts()).map(({ secretKey }) =>
    privateKeyToAccount(secretKey.startsWith("0x") ? secretKey : `0x${secretKey}`),
  );
  const transport = custom(provider);
  const publicClient = createPublicClient({ chain, transport });
  const wallets = accounts.map((account) => createWalletClient({ account, chain, transport }));
  const [owner, seller, buyerOne, buyerTwo] = wallets;
  const [ownerAccount, sellerAccount, buyerOneAccount, buyerTwoAccount] = accounts;
  const wad = 10n ** 18n;

  async function deploy(wallet, artifact, args = []) {
    const hash = await wallet.deployContract({
      abi: artifact.abi,
      bytecode: `0x${artifact.evm.bytecode.object}`,
      args,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", "deployment must succeed");
    assert.ok(receipt.contractAddress, "deployment must return a contract address");
    return receipt.contractAddress;
  }
  async function write(wallet, address, abi, functionName, args = []) {
    const hash = await wallet.writeContract({ address, abi, functionName, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", `${String(functionName)} transaction must succeed`);
    return receipt;
  }
  async function read(address, abi, functionName, args = []) {
    return publicClient.readContract({ address, abi, functionName, args });
  }
  async function rejects(action, message) {
    await assert.rejects(action, message);
  }

  const rwa = await deploy(owner, tokenArtifact, ["RWA share", 18]);
  const ae = await deploy(owner, tokenArtifact, ["AE", 18]);
  const jc = await deploy(owner, tokenArtifact, ["JC", 18]);
  const sixDecimal = await deploy(owner, tokenArtifact, ["Wrong precision", 6]);
  const escrow = await deploy(owner, escrowArtifact, [ownerAccount.address, ae]);
  for (const [token, recipient, amount] of [
    [rwa, sellerAccount.address, 20n * wad],
    [ae, sellerAccount.address, 10n * wad],
    [jc, sellerAccount.address, 100n * wad],
    [jc, buyerOneAccount.address, 100n * wad],
    [jc, buyerTwoAccount.address, 100n * wad],
  ]) {
    await write(owner, token, tokenArtifact.abi, "mint", [recipient, amount]);
  }

  await rejects(
    publicClient.simulateContract({
      account: sellerAccount,
      address: escrow,
      abi: escrowArtifact.abi,
      functionName: "createOrder",
      args: ["0x" + "11".repeat(32), true, rwa, jc, 2n * wad, wad / 2n],
    }),
    /InvalidAmount|revert/i,
  );
  await rejects(
    publicClient.simulateContract({
      account: sellerAccount,
      address: escrow,
      abi: escrowArtifact.abi,
      functionName: "createOrder",
      args: ["0x" + "12".repeat(32), true, sixDecimal, jc, 2n * wad, wad],
    }),
    /InvalidTokenDecimals|revert/i,
  );

  const fractionalAeQuantity = parseUnits("2.123456", 18);
  await write(seller, ae, tokenArtifact.abi, "approve", [escrow, fractionalAeQuantity]);
  await write(seller, jc, tokenArtifact.abi, "approve", [escrow, wad]);
  await write(seller, escrow, escrowArtifact.abi, "createOrder", [
    "0x" + "13".repeat(32), true, ae, jc, 2n * wad, fractionalAeQuantity,
  ]);
  await write(seller, escrow, escrowArtifact.abi, "cancelOrder", [1n]);
  assert.equal(await read(escrow, escrowArtifact.abi, "totalLocked", [ae]), 0n, "AE fractional order can be cancelled and released");
  await rejects(
    publicClient.simulateContract({
      account: sellerAccount,
      address: escrow,
      abi: escrowArtifact.abi,
      functionName: "createOrder",
      args: ["0x" + "14".repeat(32), true, ae, jc, 2n * wad, fractionalAeQuantity + 1n],
    }),
    /InvalidAmount|revert/i,
  );

  const sellQuantity = 5n * wad;
  await write(seller, rwa, tokenArtifact.abi, "approve", [escrow, sellQuantity]);
  await write(seller, jc, tokenArtifact.abi, "approve", [escrow, wad]);
  await write(seller, escrow, escrowArtifact.abi, "createOrder", [
    "0x" + "21".repeat(32), true, rwa, jc, 10n * wad, sellQuantity,
  ]);
  const sellOrderId = 2n;
  assert.equal(await read(escrow, escrowArtifact.abi, "totalLocked", [rwa]), sellQuantity);
  assert.equal(await read(jc, tokenArtifact.abi, "balanceOf", [ownerAccount.address]), 2n * wad, "both listing fees go directly to fee recipient");
  const duplicateOrder = await publicClient.simulateContract({
    account: sellerAccount,
    address: escrow,
    abi: escrowArtifact.abi,
    functionName: "createOrder",
    args: ["0x" + "21".repeat(32), true, rwa, jc, 10n * wad, sellQuantity],
  });
  assert.equal(duplicateOrder.result, sellOrderId, "retrying a client order id returns the original order");
  await rejects(
    publicClient.simulateContract({
      account: sellerAccount,
      address: escrow,
      abi: escrowArtifact.abi,
      functionName: "fillOrder",
      args: [sellOrderId, wad, "0x" + "31".repeat(32)],
    }),
    /CannotFillOwnOrder|revert/i,
  );

  const firstFillKey = "0x" + "32".repeat(32);
  await write(buyerOne, jc, tokenArtifact.abi, "approve", [escrow, 20n * wad]);
  await write(buyerTwo, jc, tokenArtifact.abi, "approve", [escrow, 10n * wad]);
  await write(buyerOne, escrow, escrowArtifact.abi, "fillOrder", [sellOrderId, 2n * wad, firstFillKey]);
  await write(buyerTwo, escrow, escrowArtifact.abi, "fillOrder", [sellOrderId, wad, "0x" + "33".repeat(32)]);
  assert.equal(await read(escrow, escrowArtifact.abi, "totalLocked", [rwa]), 2n * wad, "multiple buyers can partially fill the same sell order");
  assert.equal(await read(jc, tokenArtifact.abi, "balanceOf", [ownerAccount.address]), 23n * wad / 10n, "two sell listing fees plus each 1% fill fee reach fee recipient");
  const buyerBeforeDuplicate = await read(rwa, tokenArtifact.abi, "balanceOf", [buyerOneAccount.address]);
  const duplicate = await publicClient.simulateContract({
    account: buyerTwoAccount,
    address: escrow,
    abi: escrowArtifact.abi,
    functionName: "fillOrder",
    args: [sellOrderId, wad, firstFillKey],
  });
  assert.equal(duplicate.result[1], true, "reused fill key is recognized as a duplicate");
  assert.equal(await read(rwa, tokenArtifact.abi, "balanceOf", [buyerOneAccount.address]), buyerBeforeDuplicate, "duplicate fill does not move assets");

  await write(seller, escrow, escrowArtifact.abi, "cancelOrder", [sellOrderId]);
  assert.equal(await read(escrow, escrowArtifact.abi, "totalLocked", [rwa]), 0n, "cancel releases only the unsold remainder");
  assert.equal(await read(rwa, tokenArtifact.abi, "balanceOf", [sellerAccount.address]), 17n * wad, "seller receives only the unfilled remainder back");

  const buyGross = 20n * wad;
  await write(buyerOne, jc, tokenArtifact.abi, "approve", [escrow, buyGross]);
  await write(buyerOne, escrow, escrowArtifact.abi, "createOrder", [
    "0x" + "41".repeat(32), false, rwa, jc, 5n * wad, 4n * wad,
  ]);
  assert.equal(await read(escrow, escrowArtifact.abi, "totalLocked", [jc]), buyGross, "buy order locks the quoted currency");
  await write(seller, rwa, tokenArtifact.abi, "approve", [escrow, 2n * wad]);
  await write(seller, escrow, escrowArtifact.abi, "fillOrder", [3n, 2n * wad, "0x" + "42".repeat(32)]);
  assert.equal(await read(escrow, escrowArtifact.abi, "totalLocked", [jc]), 10n * wad, "partial buy fill keeps only unmatched quote locked");
  await write(buyerOne, escrow, escrowArtifact.abi, "cancelOrder", [3n]);
  assert.equal(await read(escrow, escrowArtifact.abi, "totalLocked", [jc]), 0n, "buy cancellation refunds remaining quote");
  assert.equal(await read(jc, tokenArtifact.abi, "balanceOf", [buyerOneAccount.address]), 70n * wad, "buyer pays completed gross and receives unfilled escrow back");

  await write(seller, rwa, tokenArtifact.abi, "approve", [escrow, wad]);
  await write(seller, jc, tokenArtifact.abi, "approve", [escrow, wad]);
  await write(seller, escrow, escrowArtifact.abi, "createOrder", [
    "0x" + "51".repeat(32), true, rwa, jc, 2n * wad, wad,
  ]);
  await write(buyerTwo, jc, tokenArtifact.abi, "approve", [escrow, 2n * wad]);
  await write(buyerTwo, escrow, escrowArtifact.abi, "fillOrder", [4n, wad, "0x" + "52".repeat(32)]);
  await rejects(
    publicClient.simulateContract({
      account: sellerAccount,
      address: escrow,
      abi: escrowArtifact.abi,
      functionName: "cancelOrder",
      args: [4n],
    }),
    /InvalidOrder|revert/i,
  );

  const autoSellId = 5n;
  const lowBidId = 6n;
  const highBidId = 7n;
  await write(seller, rwa, tokenArtifact.abi, "approve", [escrow, 2n * wad]);
  await write(seller, jc, tokenArtifact.abi, "approve", [escrow, wad]);
  await write(seller, escrow, escrowArtifact.abi, "createOrder", [
    "0x" + "61".repeat(32), true, rwa, jc, 8n * wad, 2n * wad,
  ]);
  await write(buyerOne, jc, tokenArtifact.abi, "approve", [escrow, 34n * wad]);
  await write(buyerOne, escrow, escrowArtifact.abi, "createOrder", [
    "0x" + "62".repeat(32), false, rwa, jc, 7n * wad, 2n * wad,
  ]);
  const buyerTwoBeforeAutoOrder = await read(jc, tokenArtifact.abi, "balanceOf", [buyerTwoAccount.address]);
  await write(buyerTwo, jc, tokenArtifact.abi, "approve", [escrow, 20n * wad]);
  await write(buyerTwo, escrow, escrowArtifact.abi, "createOrder", [
    "0x" + "63".repeat(32), false, rwa, jc, 10n * wad, 2n * wad,
  ]);
  const sellerBeforeAutoMatch = await read(jc, tokenArtifact.abi, "balanceOf", [sellerAccount.address]);
  const buyerTwoSharesBeforeAutoMatch = await read(rwa, tokenArtifact.abi, "balanceOf", [buyerTwoAccount.address]);
  await rejects(
    publicClient.simulateContract({
      account: ownerAccount,
      address: escrow,
      abi: escrowArtifact.abi,
      functionName: "matchEscrowOrders",
      args: [lowBidId, autoSellId, 2n * wad, "0x" + "64".repeat(32)],
    }),
    /InvalidOrder|revert/i,
  );
  await rejects(
    publicClient.simulateContract({
      account: sellerAccount,
      address: escrow,
      abi: escrowArtifact.abi,
      functionName: "matchEscrowOrders",
      args: [highBidId, autoSellId, 2n * wad, "0x" + "65".repeat(32)],
    }),
    /OwnableUnauthorizedAccount|revert/i,
  );
  await write(owner, escrow, escrowArtifact.abi, "matchEscrowOrders", [
    highBidId, autoSellId, 2n * wad, "0x" + "66".repeat(32),
  ]);
  assert.equal(await read(rwa, tokenArtifact.abi, "balanceOf", [buyerTwoAccount.address]), buyerTwoSharesBeforeAutoMatch + 2n * wad, "maker receives escrowed shares without another user signature");
  assert.equal(await read(jc, tokenArtifact.abi, "balanceOf", [sellerAccount.address]), sellerBeforeAutoMatch + 16n * wad * 99n / 100n, "the older resting sell order sets the execution price");
  assert.equal(await read(jc, tokenArtifact.abi, "balanceOf", [buyerTwoAccount.address]), buyerTwoBeforeAutoOrder - 16n * wad, "buyer pays the resting ask and receives the 4 JC limit-price spread");
  assert.equal(await read(escrow, escrowArtifact.abi, "totalLocked", [rwa]), 0n, "matched sell shares are released from escrow");
  assert.equal(await read(escrow, escrowArtifact.abi, "totalLocked", [jc]), 14n * wad, "only the unmatched low bid remains escrowed");
  const duplicateAutoMatch = await publicClient.simulateContract({
    account: ownerAccount,
    address: escrow,
    abi: escrowArtifact.abi,
    functionName: "matchEscrowOrders",
    args: [highBidId, autoSellId, 2n * wad, "0x" + "66".repeat(32)],
  });
  assert.equal(duplicateAutoMatch.result[1], true, "automatic match retries are idempotent");
  await write(buyerOne, escrow, escrowArtifact.abi, "cancelOrder", [lowBidId]);
  assert.equal(await read(escrow, escrowArtifact.abi, "totalLocked", [jc]), 0n, "cancelling the non-crossing bid returns all remaining JC");

  const selfSellId = 8n;
  const selfBuyId = 9n;
  await write(seller, rwa, tokenArtifact.abi, "approve", [escrow, wad]);
  await write(seller, jc, tokenArtifact.abi, "approve", [escrow, 11n * wad]);
  await write(seller, escrow, escrowArtifact.abi, "createOrder", [
    "0x" + "67".repeat(32), true, rwa, jc, 5n * wad, wad,
  ]);
  await write(seller, escrow, escrowArtifact.abi, "createOrder", [
    "0x" + "68".repeat(32), false, rwa, jc, 6n * wad, wad,
  ]);
  await rejects(
    publicClient.simulateContract({
      account: ownerAccount,
      address: escrow,
      abi: escrowArtifact.abi,
      functionName: "matchEscrowOrders",
      args: [selfBuyId, selfSellId, wad, "0x" + "69".repeat(32)],
    }),
    /CannotFillOwnOrder|revert/i,
  );
  await write(seller, escrow, escrowArtifact.abi, "cancelOrder", [selfSellId]);
  await write(seller, escrow, escrowArtifact.abi, "cancelOrder", [selfBuyId]);

  // Adjustable fees: owner-only, capped, and snapshotted per order.
  assert.equal(await read(escrow, escrowArtifact.abi, "feeBps"), 100n, "default trade fee is 1%");
  assert.equal(await read(escrow, escrowArtifact.abi, "listingFee"), wad, "default listing fee is 1 JC");
  await rejects(
    publicClient.simulateContract({
      account: sellerAccount, address: escrow, abi: escrowArtifact.abi,
      functionName: "setFees", args: [200n, 2n * wad],
    }),
    /OwnableUnauthorizedAccount|revert/i,
  );
  await rejects(
    publicClient.simulateContract({
      account: ownerAccount, address: escrow, abi: escrowArtifact.abi,
      functionName: "setFees", args: [501n, wad],
    }),
    /FeeAboveMaximum|revert/i,
  );
  await rejects(
    publicClient.simulateContract({
      account: ownerAccount, address: escrow, abi: escrowArtifact.abi,
      functionName: "setFees", args: [100n, 10n * wad + 1n],
    }),
    /FeeAboveMaximum|revert/i,
  );
  await rejects(
    publicClient.simulateContract({
      account: sellerAccount, address: escrow, abi: escrowArtifact.abi,
      functionName: "setFeeRecipient", args: [sellerAccount.address],
    }),
    /OwnableUnauthorizedAccount|revert/i,
  );

  const oldRateSellId = 10n;
  await write(seller, rwa, tokenArtifact.abi, "approve", [escrow, wad]);
  await write(seller, jc, tokenArtifact.abi, "approve", [escrow, wad]);
  await write(seller, escrow, escrowArtifact.abi, "createOrder", [
    "0x" + "71".repeat(32), true, rwa, jc, 10n * wad, wad,
  ]);

  const newRecipient = buyerTwoAccount.address;
  await write(owner, escrow, escrowArtifact.abi, "setFees", [250n, 2n * wad]);
  await write(owner, escrow, escrowArtifact.abi, "setFeeRecipient", [newRecipient]);
  assert.equal(await read(escrow, escrowArtifact.abi, "feeRecipient"), newRecipient, "owner can change the fee recipient");

  const newRateSellId = 11n;
  const recipientBeforeListing = await read(jc, tokenArtifact.abi, "balanceOf", [newRecipient]);
  await write(seller, rwa, tokenArtifact.abi, "approve", [escrow, wad]);
  await write(seller, jc, tokenArtifact.abi, "approve", [escrow, 2n * wad]);
  await write(seller, escrow, escrowArtifact.abi, "createOrder", [
    "0x" + "72".repeat(32), true, rwa, jc, 10n * wad, wad,
  ]);
  assert.equal(await read(jc, tokenArtifact.abi, "balanceOf", [newRecipient]), recipientBeforeListing + 2n * wad, "new listing fee goes to the new recipient");

  await write(buyerOne, jc, tokenArtifact.abi, "approve", [escrow, 20n * wad]);
  const sellerBeforeOldRate = await read(jc, tokenArtifact.abi, "balanceOf", [sellerAccount.address]);
  await write(buyerOne, escrow, escrowArtifact.abi, "fillOrder", [oldRateSellId, wad, "0x" + "73".repeat(32)]);
  assert.equal(await read(jc, tokenArtifact.abi, "balanceOf", [sellerAccount.address]), sellerBeforeOldRate + 10n * wad * 99n / 100n, "orders placed before a fee change keep the 1% rate");
  const sellerBeforeNewRate = await read(jc, tokenArtifact.abi, "balanceOf", [sellerAccount.address]);
  await write(buyerOne, escrow, escrowArtifact.abi, "fillOrder", [newRateSellId, wad, "0x" + "74".repeat(32)]);
  assert.equal(await read(jc, tokenArtifact.abi, "balanceOf", [sellerAccount.address]), sellerBeforeNewRate + 10n * wad * 9750n / 10000n, "orders placed after a fee change use the new 2.5% rate");

  await write(owner, escrow, escrowArtifact.abi, "setFees", [0n, 0n]);
  await write(seller, rwa, tokenArtifact.abi, "approve", [escrow, wad]);
  await write(seller, escrow, escrowArtifact.abi, "createOrder", [
    "0x" + "75".repeat(32), true, rwa, jc, 10n * wad, wad,
  ]);

  // forceCancel: owner-only, refunds only the original maker.
  const forceBuyId = 13n;
  const forceSellId = 14n;
  await write(buyerOne, jc, tokenArtifact.abi, "approve", [escrow, 30n * wad]);
  await write(buyerOne, escrow, escrowArtifact.abi, "createOrder", [
    "0x" + "81".repeat(32), false, rwa, jc, 10n * wad, 3n * wad,
  ]);
  await rejects(
    publicClient.simulateContract({
      account: sellerAccount, address: escrow, abi: escrowArtifact.abi,
      functionName: "forceCancel", args: [forceBuyId],
    }),
    /OwnableUnauthorizedAccount|revert/i,
  );
  const ownerJcBeforeForce = await read(jc, tokenArtifact.abi, "balanceOf", [ownerAccount.address]);
  const buyerJcBeforeForce = await read(jc, tokenArtifact.abi, "balanceOf", [buyerOneAccount.address]);
  await write(owner, escrow, escrowArtifact.abi, "forceCancel", [forceBuyId]);
  assert.equal(await read(jc, tokenArtifact.abi, "balanceOf", [buyerOneAccount.address]), buyerJcBeforeForce + 30n * wad, "forceCancel refunds the buy maker's locked JC");
  assert.equal(await read(jc, tokenArtifact.abi, "balanceOf", [ownerAccount.address]), ownerJcBeforeForce, "owner receives nothing from forceCancel");
  await rejects(
    publicClient.simulateContract({
      account: ownerAccount, address: escrow, abi: escrowArtifact.abi,
      functionName: "forceCancel", args: [forceBuyId],
    }),
    /InvalidOrder|revert/i,
  );

  await write(seller, rwa, tokenArtifact.abi, "approve", [escrow, 2n * wad]);
  await write(seller, escrow, escrowArtifact.abi, "createOrder", [
    "0x" + "82".repeat(32), true, rwa, jc, 10n * wad, 2n * wad,
  ]);
  const sellerRwaBeforeForce = await read(rwa, tokenArtifact.abi, "balanceOf", [sellerAccount.address]);
  await write(owner, escrow, escrowArtifact.abi, "pause", []);
  await write(owner, escrow, escrowArtifact.abi, "forceCancel", [forceSellId]);
  await write(owner, escrow, escrowArtifact.abi, "unpause", []);
  assert.equal(await read(rwa, tokenArtifact.abi, "balanceOf", [sellerAccount.address]), sellerRwaBeforeForce + 2n * wad, "forceCancel returns locked shares to the sell maker, even while paused");

  console.log("P2PEscrow behavior checks passed: token precision, legacy manual fills, automatic crossing, resting-price settlement, quote refunds, owner-only matching, self-trade rejection, idempotency, adjustable capped fees with per-order snapshots, and owner forceCancel refunding only the maker.");
}

try {
  await main();
} finally {
  await provider.disconnect();
}
