// Local, offline test of the Base mainnet contracts. Runs a ganache chain with chainId 8453,
// installs the standard CREATE2 deployment proxy, impersonates the real mainnet Safe and hot
// wallet addresses, deploys the frozen init code and checks every permission rule.
//   node scripts/mainnet/test-contracts.mjs
import assert from "node:assert/strict";
import ganache from "ganache";
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeErrorResult,
  defineChain,
  encodeFunctionData,
  encodePacked,
  getContractAddress,
  zeroAddress,
} from "viem";
import { buildMainnet, MAINNET } from "./build-contracts.mjs";

const build = buildMainnet();
const wad = 10n ** 18n;
const chain = defineChain({
  id: 8453,
  name: "Local Base mainnet fork-less test chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } },
});
const user1 = "0x1111111111111111111111111111111111111111";
const user2 = "0x2222222222222222222222222222222222222222";
const stranger = "0x3333333333333333333333333333333333333333";
const newSafe = "0x4444444444444444444444444444444444444444";
const provider = ganache.provider({
  logging: { quiet: true },
  chain: { chainId: 8453, hardfork: "shanghai" },
  wallet: { unlockedAccounts: [MAINNET.safe, MAINNET.hotWallet, user1, user2, stranger, newSafe] },
});
const transport = custom(provider);
const pub = createPublicClient({ chain, transport });
const wallet = (account) => createWalletClient({ account, chain, transport });

// Standard deterministic deployment proxy runtime (same bytecode as on Base mainnet).
const CREATE2_RUNTIME =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}
async function send(from, address, abi, functionName, args = []) {
  // Ganache under-estimates gas for calls that deploy a child contract, so use a fixed limit.
  const hash = await wallet(from).writeContract({ address, abi, functionName, args, gas: 5_000_000n });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `${functionName} must succeed`);
  return receipt;
}
const allErrors = Object.values(build.abis).flat().filter((item) => item.type === "error");
async function reverts(from, address, abi, functionName, args, expected) {
  const data = encodeFunctionData({ abi, functionName, args });
  let revertData;
  try {
    await provider.request({ method: "eth_call", params: [{ from, to: address, data }, "latest"] });
  } catch (error) {
    revertData = error?.data?.result ?? error?.data ?? error?.result;
  }
  assert.ok(typeof revertData === "string", `${functionName} from ${from} must revert`);
  if (!expected) return;
  let name = "unknown";
  try {
    name = decodeErrorResult({ abi: allErrors, data: revertData }).errorName;
  } catch {
    name = `raw:${revertData.slice(0, 10)}`;
  }
  assert.equal(name, expected, `${functionName} from ${from} must revert with ${expected}`);
}
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

async function main() {
  for (const account of [MAINNET.safe, MAINNET.hotWallet, user1, user2, stranger, newSafe]) {
    await provider.request({ method: "evm_setAccountBalance", params: [account, "0x56BC75E2D63100000"] });
  }
  await provider.request({ method: "evm_setAccountCode", params: [MAINNET.create2Deployer, CREATE2_RUNTIME] });

  const { abis, addresses } = build;
  console.log("Deploy through CREATE2 proxy (simulating the Safe's deployment transactions)");
  for (const entry of build.contracts) {
    const hash = await wallet(MAINNET.hotWallet).sendTransaction({
      to: MAINNET.create2Deployer,
      data: encodePacked(["bytes32", "bytes"], [entry.salt, entry.initCode]),
      gas: 8_000_000n,
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", `${entry.name} deploy must succeed`);
    const code = await pub.getCode({ address: entry.address });
    assert.ok(code && code.length > 2, `${entry.name} must exist at predicted address ${entry.address}`);
    console.log(`  ok  ${entry.name} deployed at predicted ${entry.address} (gas ${receipt.gasUsed})`);
  }
  const { jcToken: jc, aeToken: ae, rwaFactory: factory, p2pEscrow: escrow } = addresses;
  const tokenAbi = abis.JCToken;

  console.log("JC / AE");
  for (const [label, token] of [["JC", jc], ["AE", ae]]) {
    await check(`${label}: owner is Safe, 18 decimals, zero supply`, async () => {
      assert.equal(await read(token, tokenAbi, "owner"), MAINNET.safe);
      assert.equal(await read(token, tokenAbi, "decimals"), 18);
      assert.equal(await read(token, tokenAbi, "totalSupply"), 0n);
      assert.equal(await read(token, tokenAbi, "symbol"), label);
    });
    await check(`${label}: Safe mint always lands in the Safe`, async () => {
      await send(MAINNET.safe, token, tokenAbi, "mint", [1000n * wad]);
      assert.equal(await read(token, tokenAbi, "balanceOf", [MAINNET.safe]), 1000n * wad);
    });
    await check(`${label}: hot wallet and users cannot mint`, async () => {
      await reverts(MAINNET.hotWallet, token, tokenAbi, "mint", [1n], "OwnableUnauthorizedAccount");
      await reverts(user1, token, tokenAbi, "mint", [1n], "OwnableUnauthorizedAccount");
    });
    await check(`${label}: free transfers between users (no restrictions)`, async () => {
      await send(MAINNET.safe, token, tokenAbi, "transfer", [MAINNET.hotWallet, 300n * wad]);
      await send(MAINNET.hotWallet, token, tokenAbi, "transfer", [user1, 100n * wad]);
      await send(user1, token, tokenAbi, "transfer", [user2, 40n * wad]);
      assert.equal(await read(token, tokenAbi, "balanceOf", [user2]), 40n * wad);
    });
    await check(`${label}: anyone burns only their own balance`, async () => {
      await send(MAINNET.safe, token, tokenAbi, "burn", [100n * wad]);
      assert.equal(await read(token, tokenAbi, "balanceOf", [MAINNET.safe]), 600n * wad);
      await send(user2, token, tokenAbi, "burn", [10n * wad]);
      assert.equal(await read(token, tokenAbi, "balanceOf", [user2]), 30n * wad);
      await reverts(user2, token, tokenAbi, "burn", [31n * wad], "ERC20InsufficientBalance");
      const names = abis.JCToken.filter((x) => x.type === "function").map((x) => x.name);
      for (const forbidden of ["burnFrom", "adminReclaim", "burnVaultInventory", "pause", "setVault"]) {
        assert.ok(!names.includes(forbidden), `${label} must not expose ${forbidden}`);
      }
    });
    await check(`${label}: ownership is two-step and cannot be renounced`, async () => {
      await reverts(MAINNET.safe, token, tokenAbi, "renounceOwnership", [], "RenounceDisabled");
      await send(MAINNET.safe, token, tokenAbi, "transferOwnership", [newSafe]);
      assert.equal(await read(token, tokenAbi, "owner"), MAINNET.safe, "owner unchanged until accepted");
      await reverts(stranger, token, tokenAbi, "acceptOwnership", [], "OwnableUnauthorizedAccount");
      await send(newSafe, token, tokenAbi, "acceptOwnership");
      assert.equal(await read(token, tokenAbi, "owner"), newSafe);
      await reverts(MAINNET.safe, token, tokenAbi, "mint", [1n], "OwnableUnauthorizedAccount");
      await send(newSafe, token, tokenAbi, "mint", [5n * wad]);
      assert.equal(await read(token, tokenAbi, "balanceOf", [newSafe]), 5n * wad);
      await send(newSafe, token, tokenAbi, "transferOwnership", [MAINNET.safe]);
      await send(MAINNET.safe, token, tokenAbi, "acceptOwnership");
    });
  }

  console.log("RWA Factory");
  const fAbi = abis.RWAFactory;
  const sAbi = abis.RWAShareToken;
  let share;
  await check("only Safe creates tokens; full supply goes to Safe", async () => {
    await reverts(MAINNET.hotWallet, factory, fAbi, "createRWAToken", ["p1", "A", "A", 18, 100n * wad], "OwnableUnauthorizedAccount");
    await send(MAINNET.safe, factory, fAbi, "createRWAToken", ["p1", "Asset One", "AS1", 18, 100n * wad]);
    share = await read(factory, fAbi, "tokenByPlacement", ["p1"]);
    assert.notEqual(share, zeroAddress);
    assert.equal(await read(share, sAbi, "balanceOf", [MAINNET.safe]), 100n * wad);
    assert.equal(await read(share, sAbi, "factory"), factory);
    await reverts(MAINNET.safe, factory, fAbi, "createRWAToken", ["p1", "B", "B", 18, 1n], "PlacementExists");
  });
  await check("shares move freely; nobody but the factory can force-move or burn", async () => {
    await send(MAINNET.safe, share, sAbi, "transfer", [user1, 10n * wad]);
    await reverts(user1, share, sAbi, "forceTransfer", [user1, user2, 1n], "OnlyFactory");
    await reverts(MAINNET.safe, share, sAbi, "factoryBurn", [MAINNET.safe, 1n], "OnlyFactory");
    await reverts(MAINNET.safe, share, sAbi, "setFactory", [user1], "OnlyFactory");
  });
  await check("reclaim only returns shares to the Safe", async () => {
    await reverts(MAINNET.hotWallet, factory, fAbi, "reclaimShares", [share, user1], "OwnableUnauthorizedAccount");
    await reverts(MAINNET.safe, factory, fAbi, "reclaimShares", [share, MAINNET.safe], "BadHolder");
    await send(MAINNET.safe, factory, fAbi, "reclaimShares", [share, user1]);
    assert.equal(await read(share, sAbi, "balanceOf", [user1]), 0n);
    assert.equal(await read(share, sAbi, "balanceOf", [MAINNET.safe]), 100n * wad);
  });
  await check("burn only touches the Safe's inventory", async () => {
    await send(MAINNET.safe, share, sAbi, "transfer", [user2, 5n * wad]);
    await send(MAINNET.safe, factory, fAbi, "burnVaultInventory", [share, 20n * wad]);
    assert.equal(await read(share, sAbi, "balanceOf", [MAINNET.safe]), 75n * wad);
    assert.equal(await read(share, sAbi, "balanceOf", [user2]), 5n * wad);
    assert.equal(await read(share, sAbi, "totalSupply"), 80n * wad);
  });
  await check("after a Safe change, minting and reclaim follow the new owner", async () => {
    await send(MAINNET.safe, factory, fAbi, "transferOwnership", [newSafe]);
    await send(newSafe, factory, fAbi, "acceptOwnership");
    await send(newSafe, factory, fAbi, "createRWAToken", ["p2", "Asset Two", "AS2", 18, 50n * wad]);
    const share2 = await read(factory, fAbi, "tokenByPlacement", ["p2"]);
    assert.equal(await read(share2, sAbi, "balanceOf", [newSafe]), 50n * wad);
    await send(newSafe, factory, fAbi, "reclaimShares", [share, user2]);
    assert.equal(await read(share, sAbi, "balanceOf", [newSafe]), 5n * wad);
    await reverts(newSafe, factory, fAbi, "renounceOwnership", [], "RenounceDisabled");
    await send(newSafe, factory, fAbi, "transferOwnership", [MAINNET.safe]);
    await send(MAINNET.safe, factory, fAbi, "acceptOwnership");
  });
  await check("share token management can move to a replacement factory", async () => {
    const entry = build.contracts.find((c) => c.name === "RWAFactory");
    const salt2 = `0x${"77".repeat(32)}`;
    await pub.waitForTransactionReceipt({
      hash: await wallet(MAINNET.safe).sendTransaction({
        to: MAINNET.create2Deployer,
        data: encodePacked(["bytes32", "bytes"], [salt2, entry.initCode]),
        gas: 8_000_000n,
      }),
    });
    const factory2 = getContractAddress({ opcode: "CREATE2", from: MAINNET.create2Deployer, salt: salt2, bytecode: entry.initCode });
    assert.equal(await read(factory2, fAbi, "owner"), MAINNET.safe);
    await reverts(MAINNET.safe, factory2, fAbi, "importToken", ["p1", share], "NotManagedHere");
    await reverts(MAINNET.hotWallet, factory, fAbi, "migrateToken", [share, factory2], "OwnableUnauthorizedAccount");
    await send(MAINNET.safe, factory, fAbi, "migrateToken", [share, factory2]);
    assert.equal(await read(share, sAbi, "factory"), factory2);
    await reverts(MAINNET.safe, factory, fAbi, "reclaimShares", [share, user1], "UnknownToken");
    await send(MAINNET.safe, factory2, fAbi, "importToken", ["p1", share]);
    await send(MAINNET.safe, share, sAbi, "transfer", [user1, 1n * wad]);
    await send(MAINNET.safe, factory2, fAbi, "reclaimShares", [share, user1]);
    assert.equal(await read(share, sAbi, "balanceOf", [user1]), 0n);
  });

  console.log("P2P Escrow");
  const eAbi = abis.P2PEscrow;
  await check("owner = Safe, operator = hot wallet, fees go to Safe, defaults 1% / 1 JC", async () => {
    assert.equal(await read(escrow, eAbi, "owner"), MAINNET.safe);
    assert.equal(await read(escrow, eAbi, "operator"), MAINNET.hotWallet);
    assert.equal(await read(escrow, eAbi, "feeRecipient"), MAINNET.safe);
    assert.equal(await read(escrow, eAbi, "aeToken"), ae);
    assert.equal(await read(escrow, eAbi, "feeBps"), 100n);
    assert.equal(await read(escrow, eAbi, "listingFee"), wad);
  });
  await check("hot wallet cannot change fees, recipient, operator or unpause", async () => {
    await reverts(MAINNET.hotWallet, escrow, eAbi, "setFees", [200n, wad], "OwnableUnauthorizedAccount");
    await reverts(MAINNET.hotWallet, escrow, eAbi, "setFeeRecipient", [user1], "OwnableUnauthorizedAccount");
    await reverts(MAINNET.hotWallet, escrow, eAbi, "setOperator", [user1], "OwnableUnauthorizedAccount");
    await send(MAINNET.hotWallet, escrow, eAbi, "pause");
    await reverts(MAINNET.hotWallet, escrow, eAbi, "unpause", [], "OwnableUnauthorizedAccount");
    await send(MAINNET.safe, escrow, eAbi, "unpause");
    await reverts(MAINNET.safe, escrow, eAbi, "renounceOwnership", [], "RenounceDisabled");
  });
  await check("sell order -> fill: seller nets 99%, 1% + 1 JC listing fee reach the Safe", async () => {
    await send(MAINNET.safe, jc, tokenAbi, "mint", [1000n * wad]);
    await send(MAINNET.safe, jc, tokenAbi, "transfer", [user1, 50n * wad]);
    await send(MAINNET.safe, jc, tokenAbi, "transfer", [user2, 500n * wad]);
    await send(MAINNET.safe, ae, tokenAbi, "transfer", [user1, 20n * wad]);
    const bal = async (token, who) => read(token, tokenAbi, "balanceOf", [who]);
    const safeBefore = await bal(jc, MAINNET.safe);
    const sellerJcBefore = await bal(jc, user1);
    const buyerAeBefore = await bal(ae, user2);
    await send(user1, ae, tokenAbi, "approve", [escrow, 20n * wad]);
    await send(user1, jc, tokenAbi, "approve", [escrow, wad]);
    await send(user1, escrow, eAbi, "createOrder", [`0x${"a1".repeat(32)}`, true, ae, jc, 10n * wad, 10n * wad]);
    await send(user2, jc, tokenAbi, "approve", [escrow, 100n * wad]);
    await send(user2, escrow, eAbi, "fillOrder", [1n, 10n * wad, `0x${"b1".repeat(32)}`]);
    assert.equal((await bal(ae, user2)) - buyerAeBefore, 10n * wad);
    assert.equal((await bal(jc, user1)) - sellerJcBefore, 99n * wad - wad, "seller gets 99 JC minus 1 JC listing fee");
    assert.equal((await bal(jc, MAINNET.safe)) - safeBefore, 2n * wad, "Safe gets 1 JC trade fee + 1 JC listing fee");
  });
  await check("operator force-cancel refunds only the maker", async () => {
    await send(user1, ae, tokenAbi, "approve", [escrow, 5n * wad]);
    await send(user1, jc, tokenAbi, "approve", [escrow, wad]);
    await send(user1, escrow, eAbi, "createOrder", [`0x${"a2".repeat(32)}`, true, ae, jc, 10n * wad, 5n * wad]);
    const before = await read(ae, tokenAbi, "balanceOf", [user1]);
    await reverts(stranger, escrow, eAbi, "forceCancel", [2n], "UnauthorizedOperator");
    await send(MAINNET.hotWallet, escrow, eAbi, "forceCancel", [2n]);
    assert.equal((await read(ae, tokenAbi, "balanceOf", [user1])) - before, 5n * wad);
  });
  await check("Safe can repoint fee recipient and hand ownership over in two steps", async () => {
    await send(MAINNET.safe, escrow, eAbi, "setFeeRecipient", [newSafe]);
    await send(MAINNET.safe, escrow, eAbi, "transferOwnership", [newSafe]);
    assert.equal(await read(escrow, eAbi, "pendingOwner"), newSafe);
    await send(newSafe, escrow, eAbi, "acceptOwnership");
    assert.equal(await read(escrow, eAbi, "owner"), newSafe);
    await send(newSafe, escrow, eAbi, "setFees", [50n, 0n]);
  });

  console.log(`\nAll ${passed} mainnet contract checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
