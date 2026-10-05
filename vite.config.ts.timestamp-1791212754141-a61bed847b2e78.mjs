var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// api/privy-session.ts
var privy_session_exports = {};
__export(privy_session_exports, {
  default: () => handler
});
import { createClient } from "file:///vercel/share/v0-project/node_modules/.pnpm/@supabase+supabase-js@2.117.2/node_modules/@supabase/supabase-js/dist/index.mjs";
function json(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}
async function readBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 32768) throw new Error("Payload too large");
  }
  return JSON.parse(raw || "{}");
}
async function getJwks() {
  if (!appId) return null;
  if (!jwksCache) {
    const { createRemoteJWKSet } = await loadJose();
    jwksCache = createRemoteJWKSet(
      new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`)
    );
  }
  return jwksCache;
}
async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return json(response, 405, { error: "Method not allowed" });
  }
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  const jwks = await getJwks();
  if (!supabaseUrl || !serviceKey || !appId || !jwks) {
    return json(response, 503, { error: "Privy session bridge is not configured" });
  }
  const { jwtVerify } = await loadJose();
  let identityToken;
  let accessToken;
  let clientEmail;
  let clientWallet;
  try {
    const body = await readBody(request);
    identityToken = body.identityToken;
    accessToken = body.accessToken;
    clientEmail = body.email;
    clientWallet = body.walletAddress;
  } catch {
    return json(response, 400, { error: "Invalid request body" });
  }
  if (!identityToken && !accessToken) {
    return json(response, 400, { error: "identityToken or accessToken required" });
  }
  let privyId = "";
  let email = null;
  let verifiedWallet = null;
  if (identityToken) {
    try {
      const { payload } = await jwtVerify(identityToken, jwks, {
        issuer: "privy.io",
        audience: appId
      });
      privyId = String(payload.sub ?? "");
      const rawLinked = payload.linked_accounts;
      const linked = typeof rawLinked === "string" ? JSON.parse(rawLinked) : [];
      const emailAccount = linked.find((account) => account.type === "email" && account.address);
      const googleAccount = linked.find((account) => account.type === "google_oauth" && account.email);
      email = (emailAccount?.address ?? googleAccount?.email ?? null)?.toLowerCase() ?? null;
      const embeddedWallet = linked.find(
        (account) => account.type === "wallet" && (account.wallet_client === "privy" || account.wallet_client_type === "privy") && isAddress(account.address)
      );
      if (embeddedWallet?.address) verifiedWallet = embeddedWallet.address;
    } catch {
      identityToken = void 0;
    }
  }
  if (!privyId && accessToken) {
    try {
      const { payload } = await jwtVerify(accessToken, jwks, {
        issuer: "privy.io",
        audience: appId
      });
      privyId = String(payload.sub ?? "");
    } catch {
      return json(response, 401, { error: "Invalid Privy token" });
    }
  }
  if (!privyId) return json(response, 401, { error: "Invalid Privy token" });
  if (!email && isEmail(clientEmail)) email = clientEmail.toLowerCase();
  if (!email) return json(response, 422, { error: "Privy account has no email to link" });
  const walletAddress = verifiedWallet ?? (isAddress(clientWallet) ? clientWallet : null);
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  let userId = null;
  const { data: existingProfile } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
  userId = existingProfile?.id ?? null;
  if (!userId) {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { privy_id: privyId }
    });
    if (created?.user) {
      userId = created.user.id;
    } else if (createError) {
      for (let page = 1; page <= 20 && !userId; page += 1) {
        const { data: list, error: listError } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        if (listError) break;
        const match = list.users.find((candidate) => candidate.email?.toLowerCase() === email);
        if (match) userId = match.id;
        if (list.users.length < 200) break;
      }
    }
  }
  if (!userId) return json(response, 500, { error: "Unable to resolve platform account" });
  const profilePayload = {
    id: userId,
    email,
    privy_id: privyId,
    updated_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (walletAddress) profilePayload.wallet_address = walletAddress;
  try {
    const { error: upsertError } = await admin.from("profiles").upsert(profilePayload, { onConflict: "id" });
    if (upsertError) {
      console.error("[v0] privy-session profile sync failed:", upsertError.message);
    }
  } catch (syncError) {
    console.error("[v0] privy-session profile sync threw:", syncError);
  }
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email
  });
  const tokenHash = linkData?.properties?.hashed_token;
  if (linkError || !tokenHash) {
    return json(response, 500, { error: "Unable to issue session" });
  }
  return json(response, 200, { tokenHash, email, walletAddress });
}
var josePromise, loadJose, isEmail, isAddress, appId, jwksCache;
var init_privy_session = __esm({
  "api/privy-session.ts"() {
    josePromise = null;
    loadJose = () => josePromise ??= import("file:///vercel/share/v0-project/node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/webapi/index.js");
    isEmail = (value) => typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    isAddress = (value) => typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
    appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "cmtory3qt01gc0dl83bbj4pcw";
    jwksCache = null;
  }
});

// api/_relayerLock.ts
import { Client } from "file:///vercel/share/v0-project/node_modules/.pnpm/pg@8.23.1/node_modules/pg/esm/index.mjs";
function connectionString() {
  const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!url) throw new Error("\u7F3A\u5C11 POSTGRES_URL_NON_POOLING / POSTGRES_URL\uFF0C\u7121\u6CD5\u53D6\u5F97 nonce \u9396");
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("sslmode");
    return parsed.toString();
  } catch {
    return url;
  }
}
async function withAdvisoryLock(lockKey, fn) {
  const client = new Client({
    connectionString: connectionString(),
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [lockKey]);
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {
    });
    throw error;
  } finally {
    await client.end().catch(() => {
    });
  }
}
async function withAdminNonceLock(fn) {
  return withAdvisoryLock(ADMIN_LOCK_KEY, fn);
}
var ADMIN_LOCK_KEY;
var init_relayerLock = __esm({
  "api/_relayerLock.ts"() {
    ADMIN_LOCK_KEY = 913224501;
  }
});

// api/_onchain.ts
import {
  createPublicClient,
  createWalletClient,
  fallback,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseAbiItem,
  parseEther,
  parseUnits
} from "file:///vercel/share/v0-project/node_modules/.pnpm/viem@2.57.3_bufferutil@4.0.7_typescript@5.9.3_utf-8-validate@6.0.3_zod@4.6.5/node_modules/viem/_esm/index.js";
import { mnemonicToAccount, privateKeyToAccount } from "file:///vercel/share/v0-project/node_modules/.pnpm/viem@2.57.3_bufferutil@4.0.7_typescript@5.9.3_utf-8-validate@6.0.3_zod@4.6.5/node_modules/viem/_esm/accounts/index.js";
import { baseSepolia } from "file:///vercel/share/v0-project/node_modules/.pnpm/viem@2.57.3_bufferutil@4.0.7_typescript@5.9.3_utf-8-validate@6.0.3_zod@4.6.5/node_modules/viem/_esm/chains/index.js";
function normalizeOrThrow(envValue, fallback2, label) {
  try {
    return getAddress((envValue ?? fallback2).trim());
  } catch {
    throw new Error(`${label} \u5730\u5740\u683C\u5F0F\u932F\u8AA4`);
  }
}
async function assertCurrentFactoryToken(token) {
  const isFactoryToken = await publicClient().readContract({
    address: RELAYER_ADDRESSES.rwaFactory,
    abi: rwaFactoryAbi,
    functionName: "isFactoryToken",
    args: [getAddress(token)]
  });
  if (!isFactoryToken) throw new Error("\u6B64 RWA \u4EE3\u5E63\u4E0D\u5C6C\u65BC\u76EE\u524D Factory\uFF0C\u5DF2\u505C\u6B62\u8B80\u53D6\u8207\u8655\u7406");
}
async function getCurrentRwaFactoryToken(placementId) {
  const value = await publicClient().readContract({
    address: RELAYER_ADDRESSES.rwaFactory,
    abi: rwaFactoryAbi,
    functionName: "tokenByPlacement",
    args: [placementId.trim()]
  });
  if (!value || value === "0x0000000000000000000000000000000000000000") return null;
  const token = getAddress(value);
  await assertCurrentFactoryToken(token);
  return token;
}
async function shareTokenDecimals(token) {
  await assertCurrentFactoryToken(token);
  const cached = shareTokenDecimalsCache.get(token);
  if (cached != null) return cached;
  let value = 18;
  try {
    value = Number(await publicClient().readContract({ address: token, abi: shareTokenAbi, functionName: "decimals" }));
  } catch {
    value = 18;
  }
  shareTokenDecimalsCache.set(token, value);
  return value;
}
async function createRwaFactoryToken(placementId, name, symbol, decimals, totalSupply) {
  await ensureRelayerGas();
  const existing = await publicClient().readContract({
    address: RELAYER_ADDRESSES.rwaFactory,
    abi: rwaFactoryAbi,
    functionName: "tokenByPlacement",
    args: [placementId]
  });
  if (existing && existing !== "0x0000000000000000000000000000000000000000") {
    return { tokenAddress: getAddress(existing), txHash: "already-exists", alreadyExisted: true };
  }
  const totalSupplyUnits = parseUnits(String(totalSupply), decimals);
  const hash = await sendAdminTx(
    (nonce) => adminWalletClient().writeContract({
      address: RELAYER_ADDRESSES.rwaFactory,
      abi: rwaFactoryAbi,
      functionName: "createRWAToken",
      args: [placementId, name, symbol, decimals, totalSupplyUnits],
      chain: RELAYER_CHAIN,
      nonce
    })
  );
  await waitAndReturn(hash);
  const tokenAddress = await publicClient().readContract({
    address: RELAYER_ADDRESSES.rwaFactory,
    abi: rwaFactoryAbi,
    functionName: "tokenByPlacement",
    args: [placementId]
  });
  if (!tokenAddress || tokenAddress === "0x0000000000000000000000000000000000000000") {
    throw new Error("\u4EE3\u5E63\u5DF2\u4E0A\u93C8\u4F46\u66AB\u6642\u8B80\u4E0D\u5230\u5730\u5740\uFF08RPC \u5C1A\u672A\u540C\u6B65\uFF09\uFF0C\u8ACB\u65BC\u6578\u79D2\u5F8C\u7528\u540C\u4E00\u9846\u6309\u9215\u91CD\u8A66\uFF0C\u7CFB\u7D71\u6703\u81EA\u52D5\u4FEE\uFFFD\uFFFD\uFFFD\u4E26\u56DE\u586B\u5730\u5740");
  }
  return { tokenAddress: getAddress(tokenAddress), txHash: hash, alreadyExisted: false };
}
function publicClient() {
  if (!cachedPublic) {
    cachedPublic = createPublicClient({ chain: RELAYER_CHAIN, transport: rpcTransport });
  }
  return cachedPublic;
}
function p2pEscrowAddress() {
  if (!P2P_ESCROW_ADDRESS) throw new Error("P2PEscrow \u5C1A\u672A\u90E8\u7F72\u6216\u5C1A\u672A\u8A2D\u5B9A\u5408\u7D04\u5730\u5740");
  return P2P_ESCROW_ADDRESS;
}
async function getP2PEscrowLocked(token) {
  return publicClient().readContract({
    address: p2pEscrowAddress(),
    abi: P2P_ESCROW_ABI,
    functionName: "totalLocked",
    args: [token]
  });
}
async function getP2PEscrowReceipt(hash) {
  return publicClient().getTransactionReceipt({ hash });
}
function adminAccount() {
  const raw = (process.env.ADMIN_PRIVATE_KEY ?? "").trim();
  if (!raw) throw new Error("ADMIN_PRIVATE_KEY \u672A\u8A2D\u5B9A");
  const looksMnemonic = /\s/.test(raw) && !raw.startsWith("0x");
  if (looksMnemonic) {
    const words = raw.split(/\s+/).length;
    if (![12, 15, 18, 21, 24].includes(words)) {
      throw new Error("ADMIN_PRIVATE_KEY \u7591\u4F3C\u52A9\u8A18\u8A5E\u4F46\u55AE\u5B57\u6578\u4E0D\u6B63\u78BA");
    }
    return mnemonicToAccount(raw);
  }
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("ADMIN_PRIVATE_KEY \u683C\u5F0F\u932F\u8AA4\uFF08\u9700\u70BA 0x + 64 hex \u79C1\u9470\uFF0C\u6216 BIP-39 \u52A9\u8A18\u8A5E\uFF09");
  }
  return privateKeyToAccount(key);
}
function adminWalletClient() {
  return createWalletClient({ account: adminAccount(), chain: RELAYER_CHAIN, transport: rpcTransport });
}
function relayerAddress() {
  return adminAccount().address;
}
async function relayerEthBalance() {
  return publicClient().getBalance({ address: relayerAddress() });
}
async function ensureRelayerGas() {
  const balance = await relayerEthBalance();
  if (balance < MIN_RELAYER_ETH_WEI) {
    throw new Error(
      `ADMIN \u71B1\u9322\u5305 Base Sepolia ETH \u9918\u984D\u904E\u4F4E\uFF08${formatEther(balance)} ETH\uFF09\uFF0C\u8ACB\u7BA1\u7406\u54E1\u5148\u5132\u503C\u6E2C\u8A66\u7DB2 ETH \u5F8C\u518D\u91CD\u8A66`
    );
  }
}
async function sponsorUserGas(userWallet) {
  const wallet = getAddress(String(userWallet).trim());
  const current = await publicClient().getBalance({ address: wallet });
  if (current >= SPONSOR_MIN_WEI) {
    return { sponsored: false, balanceWei: current.toString() };
  }
  await ensureRelayerGas();
  const topUp = SPONSOR_TARGET_WEI - current;
  const hash = await sendAdminTx(
    (nonce) => adminWalletClient().sendTransaction({
      to: wallet,
      value: topUp,
      chain: RELAYER_CHAIN,
      nonce
    })
  );
  await waitAndReturn(hash);
  const after = await publicClient().getBalance({ address: wallet });
  return { sponsored: true, balanceWei: after.toString(), txHash: hash };
}
async function tokenDecimals(token) {
  const address = RELAYER_ADDRESSES[token];
  const cached = decimalsCache.get(address);
  if (cached != null) return cached;
  const abi = token === "jcToken" ? jcAbi : token === "aeToken" ? aeAbi : rwaAbi;
  let value = 18;
  try {
    value = Number(await publicClient().readContract({ address, abi, functionName: "decimals" }));
  } catch {
    value = 18;
  }
  decimalsCache.set(address, value);
  return value;
}
async function waitAndReturn(hash) {
  const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 45e3 });
  if (receipt.status !== "success") throw new Error(`\u93C8\u4E0A\u4EA4\u6613\u5931\u6557\uFF08reverted\uFF09: ${hash}`);
  return hash;
}
async function getAdminTransactionStatus(hash) {
  try {
    const receipt = await publicClient().getTransactionReceipt({ hash });
    return receipt.status === "success" ? "confirmed" : "reverted";
  } catch {
    try {
      const transaction = await publicClient().getTransaction({ hash });
      return transaction ? "pending" : "unknown";
    } catch {
      return "unknown";
    }
  }
}
async function waitForAdminTransaction(hash) {
  return waitAndReturn(hash);
}
async function sendAdminTx(build) {
  return withAdminNonceLock(async () => {
    const nonce = await publicClient().getTransactionCount({
      address: relayerAddress(),
      blockTag: "pending"
    });
    return build(nonce);
  });
}
async function ensureHotWalletCanCover(token, amountUnits) {
  const tokenAddress = RELAYER_ADDRESSES[token];
  const abi = token === "jcToken" ? jcAbi : aeAbi;
  const balance = await publicClient().readContract({
    address: tokenAddress,
    abi,
    functionName: "balanceOf",
    args: [relayerAddress()]
  });
  const label = token === "jcToken" ? "JC" : "AE";
  if (balance < amountUnits) {
    throw new Error(`ADMIN \u71B1\u9322\u5305 ${label} \u5EAB\u5B58\u4E0D\u8DB3\uFF0C\u8ACB\u7BA1\u7406\u54E1\u5148\u5F9E Safe \u91D1\u5EAB\u8F49\u4E00\u6279 ${label} \u5230\u71B1\u9322\u5305\u88DC\u8CA8\u5F8C\u518D\u91CD\u8A66`);
  }
}
async function transferFromHotWallet(token, to, amount, onSubmitted) {
  await ensureRelayerGas();
  const decimals = await tokenDecimals(token);
  const amountUnits = parseUnits(amount.toFixed(decimals), decimals);
  await ensureHotWalletCanCover(token, amountUnits);
  const abi = token === "jcToken" ? jcAbi : aeAbi;
  const hash = await sendAdminTx(
    (nonce) => adminWalletClient().writeContract({
      address: RELAYER_ADDRESSES[token],
      abi,
      functionName: "transfer",
      args: [getAddress(to), amountUnits],
      chain: RELAYER_CHAIN,
      nonce
    })
  );
  await onSubmitted?.(hash);
  return waitAndReturn(hash);
}
async function mintJc(to, amount) {
  return transferFromHotWallet("jcToken", to, amount);
}
async function adminReclaimAe(from, amount, to = RELAYER_ADDRESSES.safeVault) {
  if (amount <= 0) return null;
  await ensureRelayerGas();
  const decimals = await tokenDecimals("aeToken");
  const amountUnits = parseUnits(amount.toFixed(decimals), decimals);
  const hash = await sendAdminTx(
    (nonce) => adminWalletClient().writeContract({
      address: RELAYER_ADDRESSES.aeToken,
      abi: aeAbi,
      functionName: "adminReclaim",
      args: [getAddress(from), getAddress(to), amountUnits],
      chain: RELAYER_CHAIN,
      nonce
    })
  );
  return waitAndReturn(hash);
}
async function getAeChainBalance(wallet) {
  const [raw, decimals] = await Promise.all([
    publicClient().readContract({ address: RELAYER_ADDRESSES.aeToken, abi: aeAbi, functionName: "balanceOf", args: [wallet] }),
    tokenDecimals("aeToken")
  ]);
  return Number(formatUnits(raw, decimals));
}
async function mintTokenSupply(token, to, amount) {
  await ensureRelayerGas();
  const decimals = await tokenDecimals(token);
  const amountUnits = parseUnits(amount.toFixed(decimals), decimals);
  const hash = await sendAdminTx(
    (nonce) => adminWalletClient().writeContract({
      address: RELAYER_ADDRESSES[token],
      abi: mintableAbi,
      functionName: "mint",
      args: [getAddress(to), amountUnits],
      chain: RELAYER_CHAIN,
      nonce
    })
  );
  return waitAndReturn(hash);
}
async function burnVaultInventory(token, amount, rwaTokenAddress) {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("\u92B7\u6BC0\u6578\u91CF\u5FC5\u9808\u5927\u65BC 0");
  await ensureRelayerGas();
  if (token === "rwa") {
    if (!rwaTokenAddress) throw new Error("RWA \u5FC5\u9808\u6307\u5B9A Factory \u5EFA\u7ACB\u7684\u6A19\u7684\u4EE3\u5E63\u5730\u5740");
    const rwaToken = getAddress(rwaTokenAddress);
    const factoryAddress = RELAYER_ADDRESSES.rwaFactory;
    const isFactoryToken = await publicClient().readContract({ address: factoryAddress, abi: rwaFactoryAbi, functionName: "isFactoryToken", args: [rwaToken] });
    if (!isFactoryToken) throw new Error("\u8A72\u5730\u5740\u4E0D\u662F\u76EE\u524D RWA Factory \u5EFA\u7ACB\u7684\u6A19\u7684\u4EE3\u5E63");
    const vaultAddress2 = await publicClient().readContract({ address: factoryAddress, abi: rwaFactoryAbi, functionName: "safeVault" });
    const decimals2 = await shareTokenDecimals(rwaToken);
    const amountUnits2 = parseUnits(amount.toFixed(decimals2), decimals2);
    const balance2 = await publicClient().readContract({ address: rwaToken, abi: shareTokenAbi, functionName: "balanceOf", args: [vaultAddress2] });
    if (balance2 < amountUnits2) throw new Error("Safe \u91D1\u5EAB\u7684\u8A72 RWA \u5EAB\u5B58\u4E0D\u8DB3\uFF0C\u672A\u9001\u51FA\u92B7\u6BC0\u4EA4\u6613");
    await publicClient().simulateContract({ account: relayerAddress(), address: factoryAddress, abi: rwaFactoryAbi, functionName: "burnVaultInventory", args: [rwaToken, amountUnits2] });
    const hash2 = await sendAdminTx(
      (nonce) => adminWalletClient().writeContract({ address: factoryAddress, abi: rwaFactoryAbi, functionName: "burnVaultInventory", args: [rwaToken, amountUnits2], chain: RELAYER_CHAIN, nonce })
    );
    return waitAndReturn(hash2);
  }
  const tokenKey = token === "jc" ? "jcToken" : "aeToken";
  const contractAddress = RELAYER_ADDRESSES[tokenKey];
  const vaultAddress = RELAYER_ADDRESSES.safeVault;
  const decimals = await tokenDecimals(tokenKey);
  const amountUnits = parseUnits(amount.toFixed(decimals), decimals);
  const balance = await publicClient().readContract({ address: contractAddress, abi: erc20MinimalAbi, functionName: "balanceOf", args: [vaultAddress] });
  if (balance < amountUnits) throw new Error(`Safe \u91D1\u5EAB\u7684 ${token.toUpperCase()} \u5EAB\uFFFD\uFFFD\uFFFD\u4E0D\u8DB3\uFF0C\u672A\u9001\u51FA\u92B7\u6BC0\u4EA4\u6613`);
  await publicClient().simulateContract({ account: relayerAddress(), address: contractAddress, abi: mintableAbi, functionName: "burnVaultInventory", args: [amountUnits] });
  const hash = await sendAdminTx(
    (nonce) => adminWalletClient().writeContract({ address: contractAddress, abi: mintableAbi, functionName: "burnVaultInventory", args: [amountUnits], chain: RELAYER_CHAIN, nonce })
  );
  return waitAndReturn(hash);
}
async function sendAdminAssetPayout(input) {
  await ensureRelayerGas();
  const token = getAddress(input.tokenAddress);
  const decimals = Number(await publicClient().readContract({
    address: token,
    abi: erc20MinimalAbi,
    functionName: "decimals"
  }));
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`${input.label} \u5408\u7D04\u56DE\u50B3\u4E86\u7121\u6548\u7684\u5C0F\u6578\u4F4D\u6578`);
  }
  let amountUnits;
  try {
    amountUnits = parseUnits(input.amount, decimals);
  } catch {
    throw new Error(`${input.label} \u6578\u91CF\u8D85\u51FA\u4EE3\u5E63\u652F\u63F4\u7684\u5C0F\u6578\u4F4D\u6578`);
  }
  if (amountUnits <= 0n) throw new Error("\u6D3E\u767C\u6578\u91CF\u5FC5\u9808\u5927\u65BC 0");
  const balance = await publicClient().readContract({
    address: token,
    abi: erc20MinimalAbi,
    functionName: "balanceOf",
    args: [relayerAddress()]
  });
  if (balance < amountUnits) {
    throw new Error(`ADMIN \u71B1\u9322\u5305 ${input.label} \u5EAB\u5B58\u4E0D\u8DB3\uFF0C\u8ACB\u5148\u88DC\u8CA8\u5F8C\u518D\u6D3E\u767C`);
  }
  return sendAdminTx(
    (nonce) => adminWalletClient().writeContract({
      address: token,
      abi: erc20MinimalAbi,
      functionName: "transfer",
      args: [getAddress(input.recipient), amountUnits],
      chain: RELAYER_CHAIN,
      nonce
    })
  );
}
async function waitForAdminAssetPayout(hash) {
  const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 2e4 });
  return receipt.status === "success";
}
async function getLegacyAssetChainState(tokenAddress, owner) {
  const token = getAddress(tokenAddress);
  const decimals = Number(
    await publicClient().readContract({
      address: token,
      abi: erc20MinimalAbi,
      functionName: "decimals"
    })
  );
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("\u8CC7\u7522\u4EE3\u5E63\u5408\u7D04\u56DE\u50B3\u4E86\u7121\u6548\u7684\u5C0F\u6578\u4F4D\u6578");
  }
  const [balance, allowance] = await Promise.all([
    publicClient().readContract({
      address: token,
      abi: erc20MinimalAbi,
      functionName: "balanceOf",
      args: [getAddress(owner)]
    }),
    publicClient().readContract({
      address: token,
      abi: erc20MinimalAbi,
      functionName: "allowance",
      args: [getAddress(owner), relayerAddress()]
    })
  ]);
  return {
    decimals,
    balance: formatUnits(balance, decimals),
    allowance: formatUnits(allowance, decimals)
  };
}
async function sendAdminAssetReclaim(input) {
  await ensureRelayerGas();
  const token = getAddress(input.tokenAddress);
  const owner = getAddress(input.owner);
  const decimals = Number(
    await publicClient().readContract({
      address: token,
      abi: erc20MinimalAbi,
      functionName: "decimals"
    })
  );
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`${input.label} \u5408\u7D04\u56DE\u50B3\u4E86\u7121\u6548\u7684\u5C0F\u6578\u4F4D\u6578`);
  }
  let amountUnits;
  try {
    amountUnits = parseUnits(input.amount, decimals);
  } catch {
    throw new Error(`${input.label} \u6578\u91CF\u8D85\u51FA\u4EE3\u5E63\u652F\u63F4\u7684\u5C0F\u6578\u4F4D\u6578`);
  }
  if (amountUnits <= 0n) throw new Error("\u56DE\u6536\u6578\u91CF\u5FC5\u9808\u5927\u65BC 0");
  const [allowance, balance] = await Promise.all([
    publicClient().readContract({
      address: token,
      abi: erc20MinimalAbi,
      functionName: "allowance",
      args: [owner, relayerAddress()]
    }),
    publicClient().readContract({
      address: token,
      abi: erc20MinimalAbi,
      functionName: "balanceOf",
      args: [owner]
    })
  ]);
  if (allowance < amountUnits) {
    throw new Error(`${input.label} \u5C1A\u672A\u6388\u6B0A\u6216\u6388\u6B0A\u984D\u5EA6\u4E0D\u8DB3\uFF0C\u8ACB\u5148\u5728\u9322\u5305\u7C3D\u7F72\u7CBE\u78BA\u984D\u5EA6\u6388\u6B0A`);
  }
  if (balance < amountUnits) {
    throw new Error(`${input.label} \u93C8\u4E0A\u9918\u984D\u5DF2\u8B8A\u52D5\uFF0C\u8ACB\u91CD\u65B0\u6574\u7406\u5F8C\u78BA\u8A8D\u53EF\u56DE\u6536\u6578\u91CF`);
  }
  return sendAdminTx(
    (nonce) => adminWalletClient().writeContract({
      address: token,
      abi: erc20MinimalAbi,
      functionName: "transferFrom",
      args: [owner, relayerAddress(), amountUnits],
      chain: RELAYER_CHAIN,
      nonce
    })
  );
}
async function waitForAdminAssetReclaim(hash) {
  const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 2e4 });
  return receipt.status === "success";
}
async function getAdminAssetReclaimReceiptStatus(hash) {
  try {
    const receipt = await publicClient().getTransactionReceipt({ hash });
    return receipt.status === "success" ? "confirmed" : "failed";
  } catch {
    return "pending";
  }
}
async function pullJcFromUser(from, jcAmount, onSubmitted) {
  const decimals = await tokenDecimals("jcToken");
  return transferFromViaAdmin({
    token: RELAYER_ADDRESSES.jcToken,
    from,
    to: relayerAddress(),
    amountUnits: parseUnits(jcAmount.toFixed(decimals), decimals),
    noAllowanceMsg: "\u5C1A\u672A\u6388\u6B0A\u5E73\u53F0\u52D5\u7528\u60A8\u7684 JC\uFF08\u6216\u6388\u6B0A\u984D\u5EA6\u4E0D\u8DB3\uFF09\uFF0C\u7121\u6CD5\u5B8C\u6210\u93C8\u4E0A JC \u6536\u6B3E\u3002\u8ACB\u5728 App \u5167\u91CD\u65B0\u64CD\u4F5C\u4EE5\u5B8C\u6210\u4E00\u6B21\u6027 JC \u6388\u6B0A\u5F8C\u518D\u8A66\u3002",
    lowBalanceMsg: "\u60A8\u7684\u93C8\u4E0A JC \u9918\u984D\u4E0D\u8DB3\u4EE5\u652F\u4ED8\u672C\u7B46\u91D1\u984D\u3002\u6CE8\u610F\uFF1A\u5206\u6F64 JC \u50C5\u8A18\u5728\u7AD9\u5167\u5E33\u672C\u3001\u5C1A\u672A\u4E0A\u93C8\uFF0C\u9700\u5148\u5728\u9322\u5305\u91D1\u5EAB\u7528 USDT \u8CFC\u8CB7\u8DB3\u984D JC \u624D\u80FD\u8A8D\u8CFC\u6216\u4EA4\u6613\u3002",
    onSubmitted
  });
}
async function adminSendJc(to, jcAmount, onSubmitted) {
  if (!(jcAmount > 0)) return null;
  await ensureRelayerGas();
  const decimals = await tokenDecimals("jcToken");
  const amountUnits = parseUnits(jcAmount.toFixed(decimals), decimals);
  await ensureHotWalletCanCover("jcToken", amountUnits);
  const hash = await sendAdminTx(
    (nonce) => adminWalletClient().writeContract({
      address: RELAYER_ADDRESSES.jcToken,
      abi: jcAbi,
      functionName: "transfer",
      args: [getAddress(to), amountUnits],
      chain: RELAYER_CHAIN,
      nonce
    })
  );
  await onSubmitted?.(hash);
  return waitAndReturn(hash);
}
async function sendJcToVault(jcAmount, onSubmitted) {
  return adminSendJc(RELAYER_ADDRESSES.safeVault, jcAmount, onSubmitted);
}
async function usdtDecimals() {
  if (usdtDecimalsCache.value != null) return usdtDecimalsCache.value;
  let value = 6;
  try {
    value = Number(
      await publicClient().readContract({ address: RELAYER_ADDRESSES.usdt, abi: erc20MinimalAbi, functionName: "decimals" })
    );
  } catch {
    value = 6;
  }
  usdtDecimalsCache.value = value;
  return value;
}
async function adminSendUsdt(to, usdtAmount) {
  if (!(usdtAmount > 0)) return null;
  await ensureRelayerGas();
  const decimals = await usdtDecimals();
  const amountUnits = parseUnits(usdtAmount.toFixed(decimals), decimals);
  const balance = await publicClient().readContract({
    address: RELAYER_ADDRESSES.usdt,
    abi: erc20MinimalAbi,
    functionName: "balanceOf",
    args: [relayerAddress()]
  });
  if (balance < amountUnits) {
    throw new Error(
      `ADMIN \u71B1\u9322\u5305 USDT \u9918\u984D\u4E0D\u8DB3\uFF08\u76EE\u524D ${formatUnits(balance, decimals)} USDT\uFF0C\u9700\u8981 ${formatUnits(amountUnits, decimals)} USDT\uFF09\uFF0C\u8ACB\u7BA1\u7406\u54E1\u5F9E Safe \u91D1\u5EAB\u8F49\u5165 USDT \u88DC\u8CA8`
    );
  }
  const hash = await sendAdminTx(
    (nonce) => adminWalletClient().writeContract({
      address: RELAYER_ADDRESSES.usdt,
      abi: erc20MinimalAbi,
      functionName: "transfer",
      args: [getAddress(to), amountUnits],
      chain: RELAYER_CHAIN,
      nonce
    })
  );
  return waitAndReturn(hash);
}
async function collectJcToVault(from, jcAmount, onSubmitted) {
  return collectJc(from, RELAYER_ADDRESSES.safeVault, jcAmount, {
    noAllowanceMsg: "\u8CB7\u65B9\u5C1A\u672A\u6388\u6B0A\u5E73\u53F0\u52D5\u7528\u5176 JC\uFF08\u6216\u6388\u6B0A\u984D\u5EA6\u4E0D\u8DB3\uFF09\uFF0C\u7121\u6CD5\u628A\u8A8D\u8CFC JC \u6536\u9032\u91D1\u5EAB\u3002\u8ACB\u8CB7\u65B9\u5728 App \u5167\u91CD\u65B0\u9001\u51FA\u4E00\u6B21\u8A8D\u8CFC\u4EE5\u5B8C\u6210\u4E00\u6B21\u6027 JC \u6388\u6B0A\u5F8C\u518D\u91CD\u8A66\u3002",
    lowBalanceMsg: "\u8CB7\u65B9 JC \u93C8\u4E0A\u9918\u984D\u4E0D\u8DB3\uFF0C\u7121\u6CD5\uFFFD\uFFFD\uFFFD\u8A8D\u8CFC JC \u6536\u9032 Safe \u91D1\u5EAB\u3002"
  }, onSubmitted);
}
async function collectJc(from, to, jcAmount, msgs, onSubmitted) {
  if (!(jcAmount > 0)) return null;
  const decimals = await tokenDecimals("jcToken");
  return transferFromViaAdmin({
    token: RELAYER_ADDRESSES.jcToken,
    from,
    to,
    amountUnits: parseUnits(jcAmount.toFixed(decimals), decimals),
    noAllowanceMsg: msgs?.noAllowanceMsg ?? "\u8CB7\u65B9\u5C1A\u672A\u6388\u6B0A\u5E73\u53F0\u52D5\u7528\u5176 JC\uFF08\u6216\u6388\u6B0A\u984D\u5EA6\u4E0D\u8DB3\uFF09\uFF0C\u7121\u6CD5\u5B8C\u6210\u93C8\u4E0A JC \u6536\u4ED8\u3002\u8ACB\u8CB7\u65B9\u5728 App \u5167\u91CD\u65B0\u64CD\u4F5C\u4EE5\u5B8C\u6210\u4E00\u6B21\u6027 JC \u6388\u6B0A\u5F8C\u518D\u8A66\u3002",
    lowBalanceMsg: msgs?.lowBalanceMsg ?? "\u8CB7\u65B9 JC \u93C8\u4E0A\u9918\u984D\u4E0D\u8DB3\uFF0C\u7121\u6CD5\u5B8C\u6210\u93C8\u4E0A JC \u6536\u4ED8\u3002",
    onSubmitted
  });
}
async function transferFromViaAdmin(params) {
  const { token, from, to, amountUnits, noAllowanceMsg, lowBalanceMsg, onSubmitted } = params;
  await ensureRelayerGas();
  const owner = getAddress(from);
  const spender = relayerAddress();
  const [allowance, balance] = await Promise.all([
    publicClient().readContract({ address: token, abi: erc20MinimalAbi, functionName: "allowance", args: [owner, spender] }),
    publicClient().readContract({ address: token, abi: erc20MinimalAbi, functionName: "balanceOf", args: [owner] })
  ]);
  if (allowance < amountUnits) throw new Error(noAllowanceMsg);
  if (balance < amountUnits) throw new Error(lowBalanceMsg);
  const hash = await sendAdminTx(
    (nonce) => adminWalletClient().writeContract({
      address: token,
      abi: erc20MinimalAbi,
      functionName: "transferFrom",
      args: [owner, getAddress(to), amountUnits],
      chain: RELAYER_CHAIN,
      nonce
    })
  );
  await onSubmitted?.(hash);
  return waitAndReturn(hash);
}
async function transferShareFromHotWallet(token, to, amount, onSubmitted) {
  await ensureRelayerGas();
  const decimals = await shareTokenDecimals(token);
  const amountUnits = parseUnits(String(amount), decimals);
  const balance = await publicClient().readContract({
    address: token,
    abi: shareTokenAbi,
    functionName: "balanceOf",
    args: [relayerAddress()]
  });
  if (balance < amountUnits) {
    throw new Error(
      `ADMIN \u71B1\u9322\u5305\u6B64 RWA \u4EFD\u984D\uFF08\u4EE3\u5E63 ${token}\uFF09\u5EAB\u5B58\u4E0D\u8DB3\uFF0C\u8ACB\u7BA1\u7406\u54E1\u5148\u5F9E Safe \u91D1\u5EAB\u628A\u4EFD\u984D\u8F49\u5165\u71B1\u9322\u5305\uFF08${relayerAddress()}\uFF09\u5F8C\u91CD\u8A66`
    );
  }
  const hash = await sendAdminTx(
    (nonce) => adminWalletClient().writeContract({
      address: token,
      abi: shareTokenAbi,
      functionName: "transfer",
      args: [getAddress(to), amountUnits],
      chain: RELAYER_CHAIN,
      nonce
    })
  );
  await onSubmitted?.(hash);
  return waitAndReturn(hash);
}
async function executeSubscription(buyer, rwaUnits, _paymentJc, factoryToken, onSubmitted) {
  if (!factoryToken) {
    throw new Error(
      "\u6B64 RWA \u6A19\u7684\u5C1A\u672A\u5728 RWA Factory \u5EFA\u7ACB\u5C08\u5C6C\u4EE3\u5E63\uFF0C\u7121\u6CD5\u93C8\u4E0A\u767C\u653E\u4EFD\u984D\u3002\u8ACB\u5148\u5728\u5F8C\u53F0\u6A19\u7684\u7DE8\u8F2F\u5668\u300C\u4E00\u9375\u5EFA\u7ACB RWA \u4EE3\u5E63\u300D\u4E26\u56DE\u586B\u4EE3\u5E63\u5730\u5740\uFF0C\u518D\u628A\u4EFD\u984D\u5F9E Safe \u91D1\u5EAB\u8F49\u5165 ADMIN \u71B1\u9322\u5305\u5F8C\u91CD\u8A66\u3002"
    );
  }
  return transferShareFromHotWallet(factoryToken, buyer, rwaUnits, onSubmitted);
}
async function findRecentAssetTransfer(token, buyer, amount, afterHash, isShareToken) {
  const reference = await publicClient().getTransactionReceipt({ hash: afterHash });
  const decimals = isShareToken ? await shareTokenDecimals(token) : await tokenDecimals("aeToken");
  const amountUnits = parseUnits(String(amount), decimals);
  const logs = await publicClient().getLogs({
    address: token,
    event: erc20TransferEvent,
    args: { from: relayerAddress(), to: getAddress(buyer) },
    fromBlock: reference.blockNumber,
    toBlock: "latest"
  });
  const matches = logs.filter((log) => {
    if (log.args.value !== amountUnits || log.blockNumber == null) return false;
    if (log.blockNumber > reference.blockNumber) return true;
    return log.transactionIndex != null && log.transactionIndex > reference.transactionIndex;
  });
  if (matches.length > 1) {
    throw new Error("\u627E\u5230\u591A\u7B46\u7B26\u5408\u7684\u820A\u7248\u6A19\u7684\u8F49\u5E33\uFFFD\uFFFD\u70BA\u907F\u514D\u91CD\u8907\u767C\u653E\uFF0C\u7CFB\u7D71\u66AB\u505C\u81EA\u52D5\u91CD\u9001\u4E26\u4FDD\u7559\u5F85\u78BA\u8A8D\u7D00\u9304");
  }
  return matches[0]?.transactionHash ?? null;
}
async function executeAeSubscription(buyer, aeUnits, onSubmitted) {
  return transferFromHotWallet("aeToken", buyer, aeUnits, onSubmitted);
}
async function readAddressGetter(functionName) {
  try {
    const value = await publicClient().readContract({
      address: RELAYER_ADDRESSES.rwaMaster,
      abi: rwaAbi,
      functionName
    });
    return getAddress(value);
  } catch {
    return null;
  }
}
async function wireRwaContracts() {
  await ensureRelayerGas();
  const results = { subscription: "unknown", market: "unknown" };
  const currentSub = await readAddressGetter("subscriptionContract");
  if (currentSub && currentSub === RELAYER_ADDRESSES.rwaPrimarySale) {
    results.subscription = "already-set";
  } else {
    const hash = await sendAdminTx(
      (nonce) => adminWalletClient().writeContract({
        address: RELAYER_ADDRESSES.rwaMaster,
        abi: rwaAbi,
        functionName: "setSubscriptionContract",
        args: [RELAYER_ADDRESSES.rwaPrimarySale],
        chain: RELAYER_CHAIN,
        nonce
      })
    );
    results.subscription = await waitAndReturn(hash);
  }
  const currentMarket = await readAddressGetter("marketContract");
  if (currentMarket && currentMarket === RELAYER_ADDRESSES.rwaSecondaryMarket) {
    results.market = "already-set";
    return results;
  }
  try {
    await publicClient().simulateContract({
      account: relayerAddress(),
      address: RELAYER_ADDRESSES.rwaMaster,
      abi: rwaAbi,
      functionName: "setMarketContract",
      args: [RELAYER_ADDRESSES.rwaSecondaryMarket]
    });
    const hash = await sendAdminTx(
      (nonce) => adminWalletClient().writeContract({
        address: RELAYER_ADDRESSES.rwaMaster,
        abi: rwaAbi,
        functionName: "setMarketContract",
        args: [RELAYER_ADDRESSES.rwaSecondaryMarket],
        chain: RELAYER_CHAIN,
        nonce
      })
    );
    results.market = await waitAndReturn(hash);
  } catch {
    results.market = "failed";
    results.marketError = "\u5DF2\u90E8\u7F72\u7684 RWA \u9444\u9020\u5DE5\u5EE0\u5408\u7D04 setMarketContract() \u5728\u93C8\u4E0A\u88AB\u7121\u689D\u4EF6\u62D2\u7D55\uFF08\u5C0D\u4EFB\u4F55\u4F4D\u5740\u90FD revert\uFF0CmarketContract() getter \u4E5F revert\uFF09\uFF0C\u7814\u5224\u70BA\u8A72\u5408\u7D04\u672C\u8EAB\u7684\u7F3A\u9677\uFF0C\u9700\u91CD\u65B0\u90E8\u7F72\u4E00\u9846\u80FD\u6B63\u5E38\u8A2D\u5B9A\u4E8C\u7D1A\u5E02\u5834\u7684\u9444\u9020\u5DE5\u5EE0\u5408\u7D04\u624D\u80FD\u4FEE\u5FA9\u2014\u2014\u6B64\u554F\u984C\u7121\u6CD5\u7531\u5F8C\u7AEF\u7A0B\u5F0F\u4FEE\u6B63\u3002RWA \u4E00\u7D1A\u8A8D\u8CFC\u5DF2\u8A2D\u5B9A\u5B8C\u6210\uFF0C\u4E0D\u53D7\u5F71\u97FF\u3002";
  }
  return results;
}
async function getHotWalletShareBalance(tokenAddress) {
  const token = getAddress(tokenAddress.trim());
  const decimals = await shareTokenDecimals(token);
  const balance = await publicClient().readContract({
    address: token,
    abi: shareTokenAbi,
    functionName: "balanceOf",
    args: [relayerAddress()]
  });
  return { tokenAddress: token, decimals, balanceFormatted: formatUnits(balance, decimals) };
}
async function getWalletShareBalance(tokenAddress, walletAddress) {
  const token = getAddress(tokenAddress.trim());
  const wallet = getAddress(walletAddress.trim());
  const decimals = await shareTokenDecimals(token);
  const balance = await publicClient().readContract({
    address: token,
    abi: shareTokenAbi,
    functionName: "balanceOf",
    args: [wallet]
  });
  const balanceFormatted = formatUnits(balance, decimals);
  return { tokenAddress: token, decimals, balance: Number(balanceFormatted), balanceFormatted };
}
async function reclaimRwaShare(tokenAddress, from, amount, to = RELAYER_ADDRESSES.safeVault) {
  if (amount <= 0) return null;
  try {
    await publicClient().simulateContract({
      account: relayerAddress(),
      address: RELAYER_ADDRESSES.rwaFactory,
      abi: rwaFactoryAbi,
      functionName: "reclaimShares",
      args: [tokenAddress, from]
    });
    const hash = await sendAdminTx(
      (nonce) => adminWalletClient().writeContract({
        address: RELAYER_ADDRESSES.rwaFactory,
        abi: rwaFactoryAbi,
        functionName: "reclaimShares",
        args: [tokenAddress, from],
        chain: RELAYER_CHAIN,
        nonce
      })
    );
    const receipt = await publicClient().waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("reclaimShares reverted");
    return hash;
  } catch {
  }
  const decimals = await shareTokenDecimals(tokenAddress);
  return transferFromViaAdmin({
    token: tokenAddress,
    from,
    to,
    amountUnits: parseUnits(amount.toFixed(decimals), decimals),
    noAllowanceMsg: "\u8A72\u4F7F\u7528\u8005\u5C1A\u672A\u6388\u6B0A\u5E73\u53F0\u52D5\uFFFD\uFFFD\uFFFD\u5176 RWA \u4EFD\u984D\uFF08\u6216\u6388\u6B0A\u984D\u5EA6\u4E0D\u8DB3\uFF09\uFF0C\u7121\u6CD5\u5F37\u5236\u6536\u56DE\uFF0C\u9700\u4EBA\u5DE5\u8655\u7406\u3002",
    lowBalanceMsg: "\u8A72\u4F7F\u7528\u8005\u93C8\u4E0A RWA \u4EFD\u984D\u9918\u984D\u4E0D\u8DB3\uFF0C\u7121\u6CD5\u6536\u56DE\u3002"
  });
}
async function getVaultStatus(token) {
  const tokenAddress = RELAYER_ADDRESSES[token];
  const abi = token === "jcToken" ? jcAbi : aeAbi;
  const decimals = await tokenDecimals(token);
  const balance = await publicClient().readContract({
    address: tokenAddress,
    abi,
    functionName: "balanceOf",
    args: [relayerAddress()]
  });
  return {
    token,
    tokenAddress,
    decimals,
    balance,
    balanceFormatted: formatUnits(balance, decimals),
    low: balance < parseUnits(String(LOW_HOT_WALLET_BALANCE_UNITS), decimals)
  };
}
var P2P_ESCROW_ADDRESS, P2P_ESCROW_ABI, RELAYER_CHAIN, RPC_URL, RPC_FALLBACK_URL, rpcTransport, RELAYER_ADDRESSES, erc20MinimalAbi, jcAbi, aeAbi, rwaAbi, rwaFactoryAbi, shareTokenAbi, shareTokenDecimalsCache, erc20TransferEvent, cachedPublic, MIN_RELAYER_ETH_WEI, SPONSOR_MIN_WEI, SPONSOR_TARGET_WEI, decimalsCache, mintableAbi, usdtDecimalsCache, LOW_HOT_WALLET_BALANCE_UNITS;
var init_onchain = __esm({
  "api/_onchain.ts"() {
    init_relayerLock();
    P2P_ESCROW_ADDRESS = normalizeOrThrow(
      void 0,
      "0xa9041563E103fb9Dd6cD15859a1dAB465c2c7c28",
      "P2P \u8A17\u7BA1\u5408\u7D04"
    );
    P2P_ESCROW_ABI = [
      {
        type: "function",
        name: "createOrder",
        stateMutability: "nonpayable",
        inputs: [
          { name: "clientOrderId", type: "bytes32" },
          { name: "isSell", type: "bool" },
          { name: "assetToken", type: "address" },
          { name: "currencyToken", type: "address" },
          { name: "price", type: "uint256" },
          { name: "quantity", type: "uint256" }
        ],
        outputs: [{ name: "orderId", type: "uint256" }]
      },
      {
        type: "function",
        name: "fillOrder",
        stateMutability: "nonpayable",
        inputs: [
          { name: "orderId", type: "uint256" },
          { name: "quantity", type: "uint256" },
          { name: "fillKey", type: "bytes32" }
        ],
        outputs: [
          {
            name: "result",
            type: "tuple",
            components: [
              { name: "orderId", type: "uint256" },
              { name: "buyer", type: "address" },
              { name: "seller", type: "address" },
              { name: "quantity", type: "uint256" },
              { name: "gross", type: "uint256" },
              { name: "fee", type: "uint256" }
            ]
          },
          { name: "duplicate", type: "bool" }
        ]
      },
      {
        type: "function",
        name: "cancelOrder",
        stateMutability: "nonpayable",
        inputs: [{ name: "orderId", type: "uint256" }],
        outputs: [{ name: "refundedAmount", type: "uint256" }]
      },
      {
        type: "function",
        name: "totalLocked",
        stateMutability: "view",
        inputs: [{ name: "token", type: "address" }],
        outputs: [{ name: "amount", type: "uint256" }]
      },
      {
        type: "event",
        name: "OrderCreated",
        anonymous: false,
        inputs: [
          { indexed: true, name: "orderId", type: "uint256" },
          { indexed: true, name: "clientOrderId", type: "bytes32" },
          { indexed: true, name: "maker", type: "address" },
          { indexed: false, name: "isSell", type: "bool" },
          { indexed: false, name: "assetToken", type: "address" },
          { indexed: false, name: "currencyToken", type: "address" },
          { indexed: false, name: "price", type: "uint256" },
          { indexed: false, name: "quantity", type: "uint256" },
          { indexed: false, name: "listingFee", type: "uint256" }
        ]
      },
      {
        type: "event",
        name: "OrderFilled",
        anonymous: false,
        inputs: [
          { indexed: true, name: "fillKey", type: "bytes32" },
          { indexed: true, name: "orderId", type: "uint256" },
          { indexed: true, name: "buyer", type: "address" },
          { indexed: false, name: "seller", type: "address" },
          { indexed: false, name: "assetToken", type: "address" },
          { indexed: false, name: "currencyToken", type: "address" },
          { indexed: false, name: "quantity", type: "uint256" },
          { indexed: false, name: "price", type: "uint256" },
          { indexed: false, name: "gross", type: "uint256" },
          { indexed: false, name: "fee", type: "uint256" },
          { indexed: false, name: "currencyReleased", type: "uint256" }
        ]
      },
      {
        type: "event",
        name: "OrderCancelled",
        anonymous: false,
        inputs: [
          { indexed: true, name: "orderId", type: "uint256" },
          { indexed: true, name: "maker", type: "address" },
          { indexed: false, name: "refundedAmount", type: "uint256" }
        ]
      }
    ];
    RELAYER_CHAIN = baseSepolia;
    RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
    RPC_FALLBACK_URL = "https://base-sepolia-rpc.publicnode.com";
    rpcTransport = fallback([http(RPC_URL), http(RPC_FALLBACK_URL)]);
    RELAYER_ADDRESSES = {
      rwaMaster: normalizeOrThrow(void 0, "0x79F1C6aDFCcD916cde668D88a6dda3918e5d6835", "RWA \u9444\u9020\u5DE5\u5EE0\u5408\u7D04"),
      rwaPrimarySale: normalizeOrThrow(void 0, "0x1BF9Bfd5cFF90A3307ce4AaD0098A1AAEaBEaed0", "RWA \u4E00\u7D1A\u8A8D\u8CFC\u5408\u7D04"),
      rwaSecondaryMarket: normalizeOrThrow(void 0, "0x9617b751445b8DF7f1c57f10b12065700c7a6117", "RWA \u4E8C\u7D1A\u5E02\u5834\u5408\u7D04"),
      // 2026-10-04 重新部署（contracts/JCToken.sol）：移除舊合約的 P2P 轉帳限制，
      // owner 保留 mint 權限可再增發。同步 src/lib/contracts.ts。
      jcToken: normalizeOrThrow(void 0, "0xE035d5A79664843089F9Ee9F8dA2980cfB5eE4D9", "JC \u7D50\u7B97\u4EE3\u5E63\u5408\u7D04"),
      // 手續費 / 認購 JC 的收款金庫。JC/AE 發放給使用者已改為 ADMIN 熱錢包直接
      // transfer，不再從這裡 transferFrom；這個地址僅保留供人工補貨轉帳時參考，
      // 程式碼中不會再讀取或動用這個地��的資產。
      safeVault: normalizeOrThrow(void 0, "0xe886e67fd9CFe66fdb0A1F47cEf0001548a078cf", "Safe \u91D1\u5EAB"),
      usdt: normalizeOrThrow(void 0, "0x1d6E0eC7ef658758A5b3Dc518422E302A5436B85", "USDT \u6E2C\u8A66\u4EE3\u5E63"),
      // 2026-10-04 重新部署（contracts/AEToken.sol）：移除舊合約的「AE P2P 轉帳限制」，
      // 二級市場可直接 transferFrom(賣方→買方) 一次交割；owner 保留 mint 權限。
      // 同步 src/lib/contracts.ts。
      aeToken: normalizeOrThrow(void 0, "0x62452c4fd6950D2B5BaE251F39f082900D43B37f", "AE \u4EE3\u5E63\u5408\u7D04"),
      aePrimarySale: normalizeOrThrow(void 0, "0x006a585f0B4aDF0663Dc2175A82D6BabbDc5e3A4", "AE \u4E00\u7D1A\u8A8D\u8CFC\u5408\u7D04"),
      aeSecondaryMarket: normalizeOrThrow(
        void 0,
        "0x835D61FF69743B0f5F39223ba45F5062A7A5E5c9",
        "AE \u4E8C\u7D1A\u5E02\u5834\u5408\u7D04"
      ),
      // 2026-10-04 新部署的 RWA Factory，負責建立標的代幣與管理 Safe 未售庫存。
      rwaFactory: normalizeOrThrow(void 0, "0xD453454118BA8b76e68C16f6Bc965349794EdF9A", "RWA Factory \u5408\u7D04")
    };
    erc20MinimalAbi = [
      {
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" }
        ],
        name: "transfer",
        outputs: [{ type: "bool" }],
        stateMutability: "nonpayable",
        type: "function"
      },
      { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
      { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
      { inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], name: "allowance", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
      { inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], name: "approve", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
      {
        inputs: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" }
        ],
        name: "transferFrom",
        outputs: [{ type: "bool" }],
        stateMutability: "nonpayable",
        type: "function"
      }
    ];
    jcAbi = erc20MinimalAbi;
    aeAbi = [
      ...erc20MinimalAbi,
      {
        inputs: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" }
        ],
        name: "adminReclaim",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function"
      }
    ];
    rwaAbi = [
      { inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], name: "mint", outputs: [], stateMutability: "nonpayable", type: "function" },
      { inputs: [{ name: "m", type: "address" }], name: "setMarketContract", outputs: [], stateMutability: "nonpayable", type: "function" },
      { inputs: [{ name: "s", type: "address" }], name: "setSubscriptionContract", outputs: [], stateMutability: "nonpayable", type: "function" },
      { inputs: [], name: "marketContract", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
      { inputs: [], name: "subscriptionContract", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
      { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
      { inputs: [], name: "owner", outputs: [{ type: "address" }], stateMutability: "view", type: "function" }
    ];
    rwaFactoryAbi = [
      {
        inputs: [
          { name: "token", type: "address" },
          { name: "holder", type: "address" }
        ],
        name: "reclaimShares",
        outputs: [{ name: "amount", type: "uint256" }],
        stateMutability: "nonpayable",
        type: "function"
      },
      {
        inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
        name: "burnVaultInventory",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function"
      },
      { inputs: [{ name: "token", type: "address" }], name: "isFactoryToken", outputs: [{ type: "bool" }], stateMutability: "view", type: "function" },
      { inputs: [], name: "safeVault", outputs: [{ type: "address" }], stateMutability: "view", type: "function" },
      {
        inputs: [
          { name: "placementId", type: "string" },
          { name: "name_", type: "string" },
          { name: "symbol_", type: "string" },
          { name: "decimals_", type: "uint8" },
          { name: "totalSupply_", type: "uint256" }
        ],
        name: "createRWAToken",
        outputs: [{ name: "token", type: "address" }],
        stateMutability: "nonpayable",
        type: "function"
      },
      {
        inputs: [
          { name: "token", type: "address" },
          { name: "currency", type: "address" },
          { name: "buyer", type: "address" },
          { name: "shareAmount", type: "uint256" },
          { name: "payment", type: "uint256" }
        ],
        name: "subscribe",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function"
      },
      {
        inputs: [
          { name: "token", type: "address" },
          { name: "currency", type: "address" },
          { name: "seller", type: "address" },
          { name: "buyer", type: "address" },
          { name: "shareAmount", type: "uint256" },
          { name: "paymentToSeller", type: "uint256" },
          { name: "feeAmount", type: "uint256" }
        ],
        name: "trade",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function"
      },
      { inputs: [{ name: "", type: "string" }], name: "tokenByPlacement", outputs: [{ type: "address" }], stateMutability: "view", type: "function" }
    ];
    shareTokenAbi = [
      { inputs: [], name: "decimals", outputs: [{ type: "uint8" }], stateMutability: "view", type: "function" },
      { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
      { inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], name: "allowance", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
      { inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], name: "approve", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" },
      { inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], name: "transfer", outputs: [{ type: "bool" }], stateMutability: "nonpayable", type: "function" }
    ];
    shareTokenDecimalsCache = /* @__PURE__ */ new Map();
    erc20TransferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
    cachedPublic = null;
    MIN_RELAYER_ETH_WEI = parseEther("0.0015");
    SPONSOR_MIN_WEI = parseEther("0.00005");
    SPONSOR_TARGET_WEI = parseEther("0.0003");
    decimalsCache = /* @__PURE__ */ new Map();
    mintableAbi = [
      {
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" }
        ],
        name: "mint",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function"
      },
      {
        inputs: [{ name: "amount", type: "uint256" }],
        name: "burnVaultInventory",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function"
      }
    ];
    usdtDecimalsCache = { value: null };
    LOW_HOT_WALLET_BALANCE_UNITS = 100;
  }
});

// api/relayer.ts
var relayer_exports = {};
__export(relayer_exports, {
  default: () => handler2,
  sweepPendingCommissions: () => sweepPendingCommissions,
  sweepStuckSettlements: () => sweepStuckSettlements
});
import { createClient as createClient2 } from "file:///vercel/share/v0-project/node_modules/.pnpm/@supabase+supabase-js@2.117.2/node_modules/@supabase/supabase-js/dist/index.mjs";
import { formatUnits as formatUnits2, getAddress as getAddress2, parseEventLogs, parseUnits as parseUnits2 } from "file:///vercel/share/v0-project/node_modules/.pnpm/viem@2.57.3_bufferutil@4.0.7_typescript@5.9.3_utf-8-validate@6.0.3_zod@4.6.5/node_modules/viem/_esm/index.js";
function json2(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}
async function readBody2(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 32768) throw new Error("Payload too large");
  }
  return JSON.parse(raw || "{}");
}
function toAddress(value, label) {
  if (typeof value !== "string") throw new Error(`${label} \u672A\u7D81\u5B9A\u93C8\u4E0A\u9322\u5305`);
  try {
    return getAddress2(value.trim());
  } catch {
    throw new Error(`${label} \u9322\u5305\u5730\u5740\u683C\u5F0F\u932F\u8AA4`);
  }
}
async function decodeEscrowEvent(txHashInput, eventName) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHashInput)) throw new Error("\u4EA4\u6613\u96DC\u6E4A\u683C\u5F0F\u932F\u8AA4");
  const txHash = txHashInput.toLowerCase();
  const escrow = p2pEscrowAddress();
  const receipt = await getP2PEscrowReceipt(txHash);
  if (receipt.status !== "success") throw new Error("\u93C8\u4E0A\u4EA4\u6613\u5C1A\u672A\u6210\u529F\u78BA\u8A8D");
  const logs = receipt.logs.filter((log) => log.address.toLowerCase() === escrow.toLowerCase());
  const decoded = parseEventLogs({ abi: P2P_ESCROW_ABI, logs, strict: true });
  const event = decoded.find((entry) => entry.eventName === eventName);
  if (!event) throw new Error(`\u4EA4\u6613\u6536\u64DA\u4E2D\u627E\u4E0D\u5230 ${eventName} \u8A17\u7BA1\u4E8B\u4EF6`);
  return { txHash, escrow, args: event.args };
}
async function saveEscrowEvent(admin, txHash, eventType, userId, eventData) {
  const existing = await admin.from("p2p_escrow_events").select("event_type,user_id,event_data,status").eq("tx_hash", txHash).maybeSingle();
  if (existing.error) throw new Error(`\u8A17\u7BA1\u4E8B\u4EF6\u8B80\u53D6\u5931\u6557\uFF1A${existing.error.message}`);
  if (existing.data) {
    if (existing.data.event_type !== eventType) throw new Error("\u4EA4\u6613\u96DC\u6E4A\u5DF2\u7528\u65BC\u4E0D\u540C\u985E\u578B\u7684\u8A17\u7BA1\u4E8B\u4EF6");
    if (existing.data.status === "finalized") return true;
    const update = await admin.from("p2p_escrow_events").update({
      user_id: userId,
      event_data: eventData,
      status: "pending",
      error: null,
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    }).eq("tx_hash", txHash);
    if (update.error) throw new Error(`\u8A17\u7BA1\u4E8B\u4EF6\u4FDD\u5B58\u5931\u6557\uFF1A${update.error.message}`);
    return false;
  }
  const insert = await admin.from("p2p_escrow_events").insert({
    tx_hash: txHash,
    event_type: eventType,
    user_id: userId,
    event_data: eventData,
    status: "pending"
  });
  if (insert.error) {
    const raced = await admin.from("p2p_escrow_events").select("event_type,status").eq("tx_hash", txHash).maybeSingle();
    if (raced.data?.event_type === eventType) return raced.data.status === "finalized";
    throw new Error(`\u8A17\u7BA1\u4E8B\u4EF6\u4FDD\u5B58\u5931\u6557\uFF1A${insert.error.message}`);
  }
  return false;
}
async function finishEscrowEvent(admin, txHash, error) {
  const update = await admin.from("p2p_escrow_events").update({
    status: error ? "failed" : "finalized",
    error: error ?? null,
    updated_at: (/* @__PURE__ */ new Date()).toISOString()
  }).eq("tx_hash", txHash);
  if (update.error) throw new Error(`\u8A17\u7BA1\u4E8B\u4EF6\u72C0\u614B\u66F4\u65B0\u5931\u6557\uFF1A${update.error.message}`);
}
async function profileForWallet(admin, wallet) {
  const { data, error } = await admin.from("profiles").select("id,wallet_address").ilike("wallet_address", wallet).maybeSingle();
  if (error || !data) throw new Error("\u93C8\u4E0A\u9322\u5305\u5C1A\u672A\u7D81\u5B9A\u552F\u4E00\u5E73\u53F0\u5E33\u865F");
  return data;
}
async function processEscrowOrderCreated(admin, txHashInput, caller) {
  const { txHash, args } = await decodeEscrowEvent(txHashInput, "OrderCreated");
  const maker = toAddress(args.maker, "\u639B\u55AE\u8005");
  const profile = await profileForWallet(admin, maker);
  if (caller && caller.id !== profile.id) throw new Error("\u53EA\u80FD\u540C\u6B65\u81EA\u5DF1\u9322\u5305\u5EFA\u7ACB\u7684\u8A17\u7BA1\u639B\u55AE");
  const eventData = {
    txHash,
    orderId: String(args.orderId),
    clientOrderId: String(args.clientOrderId).toLowerCase(),
    maker,
    isSell: Boolean(args.isSell),
    assetToken: toAddress(args.assetToken, "\u6A19\u7684\u4EE3\u5E63").toLowerCase(),
    currencyToken: toAddress(args.currencyToken, "\u8A08\u50F9\u4EE3\u5E63").toLowerCase(),
    price: String(args.price),
    quantity: String(args.quantity),
    listingFee: String(args.listingFee)
  };
  const alreadyFinalized = await saveEscrowEvent(admin, txHash, "order_created", profile.id, eventData);
  if (alreadyFinalized) return { status: "confirmed", idempotent: true, tx_hash: txHash };
  try {
    const reservation = await admin.from("p2p_escrow_order_reservations").select("request_key,user_id,asset_id,side,status").eq("client_order_id", eventData.clientOrderId).maybeSingle();
    if (reservation.error || !reservation.data || reservation.data.user_id !== profile.id) {
      throw new Error("\u627E\u4E0D\u5230\u6B64\u93C8\u4E0A\u639B\u55AE\u5C0D\u61C9\u7684\u8CC7\u6599\u5EAB\u9810\u7559\uFF1B\u8ACB\u7531\u7BA1\u7406\u54E1\u6AA2\u67E5\u9019\u7B46\u4EA4\u6613");
    }
    const placement = await admin.from("private_placements").select("id,is_ae_token,token_address").eq("id", reservation.data.asset_id).maybeSingle();
    if (placement.error || !placement.data) throw new Error("\u627E\u4E0D\u5230\u6B64\u639B\u55AE\u5C0D\u61C9\u7684\u6A19\u7684");
    const expectedAsset = placement.data.is_ae_token ? RELAYER_ADDRESSES.aeToken : toFactoryTokenAddress(placement.data.token_address);
    if (!expectedAsset || expectedAsset.toLowerCase() !== eventData.assetToken) throw new Error("\u639B\u55AE\u6A19\u7684\u4EE3\u5E63\u8207\u5E73\u53F0\u6A19\u7684\u8A2D\u5B9A\u4E0D\u4E00\u81F4");
    if (eventData.currencyToken !== RELAYER_ADDRESSES.jcToken.toLowerCase()) throw new Error("\u6B64\u5E73\u53F0\u639B\u55AE\u53EA\u63A5\u53D7 JC \u8A08\u50F9");
    const { data, error } = await admin.rpc("confirm_p2p_escrow_order", { p_user_id: profile.id, p_event: eventData });
    if (error) throw new Error(error.message);
    await finishEscrowEvent(admin, txHash);
    return { status: "confirmed", tx_hash: txHash, order: data };
  } catch (error) {
    const message = error instanceof Error ? error.message : "\u8A17\u7BA1\u639B\u55AE\u8CC7\u6599\u540C\u6B65\u5931\u6557";
    await finishEscrowEvent(admin, txHash, message);
    throw new Error(`${message}\uFF1B\u4EA4\u6613\u5DF2\u4E0A\u93C8\uFF0C\u53EF\u7531\u7BA1\u7406\u54E1\u91CD\u8A66\u540C\u6B65\uFF08${txHash}\uFF09`);
  }
}
async function processEscrowFill(admin, txHashInput, caller) {
  const { txHash, args } = await decodeEscrowEvent(txHashInput, "OrderFilled");
  const buyer = toAddress(args.buyer, "\u8CB7\u65B9");
  const seller = toAddress(args.seller, "\u8CE3\u65B9");
  const [buyerProfile, sellerProfile] = await Promise.all([
    profileForWallet(admin, buyer),
    profileForWallet(admin, seller)
  ]);
  if (buyerProfile.id === sellerProfile.id) throw new Error("\u7121\u6548\u7684\u81EA\u6211\u6210\u4EA4\u4E8B\u4EF6");
  if (caller && caller.id !== buyerProfile.id && caller.id !== sellerProfile.id) throw new Error("\u53EA\u80FD\u540C\u6B65\u81EA\u5DF1\u53C3\u8207\u7684\u6210\u4EA4");
  const eventData = {
    txHash,
    fillKey: String(args.fillKey).toLowerCase(),
    orderId: String(args.orderId),
    buyer,
    seller,
    assetToken: toAddress(args.assetToken, "\u6A19\u7684\u4EE3\u5E63").toLowerCase(),
    currencyToken: toAddress(args.currencyToken, "\u8A08\u50F9\u4EE3\u5E63").toLowerCase(),
    quantity: String(args.quantity),
    price: String(args.price),
    gross: String(args.gross),
    fee: String(args.fee),
    currencyReleased: String(args.currencyReleased)
  };
  const alreadyFinalized = await saveEscrowEvent(admin, txHash, "order_filled", buyerProfile.id, eventData);
  if (alreadyFinalized) return { status: "confirmed", idempotent: true, tx_hash: txHash };
  try {
    const { data, error } = await admin.rpc("finalize_p2p_escrow_fill", { p_event: eventData });
    if (error) throw new Error(error.message);
    await finishEscrowEvent(admin, txHash);
    return { status: "confirmed", tx_hash: txHash, fill: data };
  } catch (error) {
    const message = error instanceof Error ? error.message : "\u6210\u4EA4\u5E33\u672C\u540C\u6B65\u5931\u6557";
    await finishEscrowEvent(admin, txHash, message);
    throw new Error(`${message}\uFF1B\u4EA4\u6613\u5DF2\u4E0A\u93C8\uFF0C\u53EF\u7531\u7BA1\u7406\u54E1\u91CD\u8A66\u540C\u6B65\uFF08${txHash}\uFF09`);
  }
}
async function processEscrowCancel(admin, txHashInput, caller) {
  const { txHash, args } = await decodeEscrowEvent(txHashInput, "OrderCancelled");
  const maker = toAddress(args.maker, "\u639B\u55AE\u8005");
  const profile = await profileForWallet(admin, maker);
  if (caller && caller.id !== profile.id) throw new Error("\u53EA\u80FD\u540C\u6B65\u81EA\u5DF1\u53D6\u6D88\u7684\u8A17\u7BA1\u639B\u55AE");
  const eventData = {
    txHash,
    orderId: String(args.orderId),
    maker,
    refundedAmount: String(args.refundedAmount)
  };
  const alreadyFinalized = await saveEscrowEvent(admin, txHash, "order_cancelled", profile.id, eventData);
  if (alreadyFinalized) return { status: "confirmed", idempotent: true, tx_hash: txHash };
  try {
    const { data, error } = await admin.rpc("finalize_p2p_escrow_cancel", { p_user_id: profile.id, p_event: eventData });
    if (error) throw new Error(error.message);
    await finishEscrowEvent(admin, txHash);
    return { status: "confirmed", tx_hash: txHash, order: data };
  } catch (error) {
    const message = error instanceof Error ? error.message : "\u53D6\u6D88\u5E33\u672C\u540C\u6B65\u5931\u6557";
    await finishEscrowEvent(admin, txHash, message);
    throw new Error(`${message}\uFF1B\u93C8\u4E0A\u8CC7\u7522\u5DF2\u9000\u56DE\uFF0C\u53EF\u7531\u7BA1\u7406\u54E1\u91CD\u8A66\u540C\u6B65\uFF08${txHash}\uFF09`);
  }
}
function toFactoryTokenAddress(value) {
  if (typeof value !== "string" || !value.trim()) return void 0;
  try {
    const addr = getAddress2(value.trim());
    if (addr === "0x0000000000000000000000000000000000000000") return void 0;
    return addr;
  } catch {
    return void 0;
  }
}
function ledgerAmountUnits(value) {
  return parseUnits2(String(value ?? "0"), LEDGER_SCALE);
}
function ledgerUnitsToTokenUnits(value, decimals) {
  if (decimals >= LEDGER_SCALE) return value * 10n ** BigInt(decimals - LEDGER_SCALE);
  return value / 10n ** BigInt(LEDGER_SCALE - decimals);
}
async function readLegacyReclaimCandidates(admin, userId, wallet) {
  const ledgerRows = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await admin.from("jc_ledger").select("asset_id,quantity,created_at").eq("user_id", userId).in("entry_type", [...LEGACY_RECLAIM_ENTRY_TYPES]).not("asset_id", "is", null).order("created_at", { ascending: true }).range(offset, offset + pageSize - 1);
    if (error) throw new Error(`\u8B80\u53D6\u6B77\u53F2\u8CC7\u7522\u5E33\u672C\u5931\u6557\uFF1A${error.message}`);
    const page = data ?? [];
    ledgerRows.push(...page);
    if (page.length < pageSize) break;
  }
  const { data: payoutRows, error: payoutError } = await admin.from("onchain_settlements").select("asset_id,amount,payload,created_at,status").eq("action", "admin_payout").in("status", ["confirmed", "pending"]).eq("user_id", userId);
  if (payoutError) throw new Error(`\u8B80\u53D6\u4ECA\u65E5\u8CC7\u7522\u767C\u653E\u7D00\u9304\u5931\u6557\uFF1A${payoutError.message}`);
  const positionTotals = /* @__PURE__ */ new Map();
  const cutoff = new Date(LEGACY_RECLAIM_CUTOFF).getTime();
  for (const row of ledgerRows) {
    if (!row.asset_id) continue;
    const totals = positionTotals.get(row.asset_id) ?? { legacy: 0n, today: 0n };
    const amount = ledgerAmountUnits(row.quantity);
    if (new Date(row.created_at).getTime() < cutoff) totals.legacy += amount;
    else totals.today += amount;
    positionTotals.set(row.asset_id, totals);
  }
  for (const row of payoutRows ?? []) {
    if (!row.asset_id) continue;
    const payload = row.payload;
    if (payload.assetType !== "ae" && payload.assetType !== "rwa") continue;
    const totals = positionTotals.get(row.asset_id) ?? { legacy: 0n, today: 0n };
    const amount = ledgerAmountUnits(row.amount ?? payload.amount);
    if (new Date(row.created_at).getTime() < cutoff) {
      if (row.status === "confirmed") totals.legacy += amount;
    } else {
      totals.today += amount;
    }
    positionTotals.set(row.asset_id, totals);
  }
  const placementIds = Array.from(positionTotals.keys());
  const placements = [];
  for (let offset = 0; offset < placementIds.length; offset += 100) {
    const { data, error } = await admin.from("private_placements").select("id,name,token_address,is_ae_token").in("id", placementIds.slice(offset, offset + 100));
    if (error) throw new Error(`\u8B80\u53D6\u8CC7\u7522\u5408\u7D04\u8CC7\u6599\u5931\u6557\uFF1A${error.message}`);
    placements.push(...data ?? []);
  }
  const placementById = new Map(placements.map((placement) => [placement.id, placement]));
  const grouped = /* @__PURE__ */ new Map();
  for (const [assetId, totals] of positionTotals) {
    const placement = placementById.get(assetId);
    const isAe = placement?.is_ae_token === true;
    const tokenAddress = isAe ? RELAYER_ADDRESSES.aeToken : toFactoryTokenAddress(placement?.token_address) ?? null;
    const assetKey = isAe ? AE_LEGACY_ASSET_KEY : tokenAddress ? `legacy-rwa:${tokenAddress.toLowerCase()}` : `legacy-rwa-placement:${assetId}`;
    const current = grouped.get(assetKey) ?? {
      assetKey,
      label: isAe ? "AE \u4EE3\u5E63" : placement?.name || assetId,
      kind: isAe ? "ae" : "rwa",
      tokenAddress,
      legacy: 0n,
      today: 0n
    };
    current.legacy += totals.legacy;
    current.today += totals.today;
    grouped.set(assetKey, current);
  }
  const { data: settlementRows, error: settlementError } = await admin.from("onchain_settlements").select("asset_id,amount,status,tx_hash").eq("action", "ae_reclaim_legacy").eq("user_id", userId);
  if (settlementError) throw new Error(`\u8B80\u53D6\u56DE\u6536\u7D00\u9304\u5931\u6557\uFF1A${settlementError.message}`);
  const settlementsByAsset = /* @__PURE__ */ new Map();
  for (const row of settlementRows ?? []) {
    const key = String(row.asset_id ?? "");
    settlementsByAsset.set(key, [...settlementsByAsset.get(key) ?? [], row]);
  }
  return Promise.all(Array.from(grouped.values()).map(async (group) => {
    if (group.legacy <= 0n) return null;
    const settlements = settlementsByAsset.get(group.assetKey) ?? [];
    const confirmed = settlements.filter((row) => row.status === "confirmed");
    const pending = settlements.find((row) => row.status === "pending");
    const txHash = pending?.tx_hash ?? confirmed[confirmed.length - 1]?.tx_hash ?? null;
    if (!group.tokenAddress) {
      return {
        assetKey: group.assetKey,
        label: group.label,
        kind: group.kind,
        tokenAddress: null,
        decimals: null,
        legacyNet: formatUnits2(group.legacy, LEDGER_SCALE),
        todayReserved: "0",
        chainBalance: "0",
        reclaimed: "0",
        amount: "0",
        status: "no-token",
        txHash
      };
    }
    try {
      const chain = await getLegacyAssetChainState(group.tokenAddress, wallet);
      const decimals = chain.decimals;
      const oldUnits = ledgerUnitsToTokenUnits(group.legacy, decimals);
      const todayUnits = ledgerUnitsToTokenUnits(group.today > 0n ? group.today : 0n, decimals);
      const reclaimedUnits = confirmed.reduce((sum, row) => {
        if (!row.amount) return sum;
        try {
          return sum + parseUnits2(String(row.amount), decimals);
        } catch {
          return sum;
        }
      }, 0n);
      const oldRemaining = oldUnits > reclaimedUnits ? oldUnits - reclaimedUnits : 0n;
      const balanceUnits = parseUnits2(chain.balance, decimals);
      const availableUnits = balanceUnits > todayUnits ? balanceUnits - todayUnits : 0n;
      const reclaimUnits = oldRemaining < availableUnits ? oldRemaining : availableUnits;
      const status = pending ? "pending" : oldRemaining === 0n && reclaimedUnits > 0n ? "complete" : reclaimUnits > 0n ? "ready" : "no-balance";
      return {
        assetKey: group.assetKey,
        label: group.label,
        kind: group.kind,
        tokenAddress: group.tokenAddress,
        decimals,
        legacyNet: formatUnits2(oldUnits, decimals),
        todayReserved: formatUnits2(todayUnits, decimals),
        chainBalance: chain.balance,
        reclaimed: formatUnits2(reclaimedUnits, decimals),
        amount: status === "ready" ? formatUnits2(reclaimUnits, decimals) : "0",
        status,
        txHash
      };
    } catch {
      return {
        assetKey: group.assetKey,
        label: group.label,
        kind: group.kind,
        tokenAddress: group.tokenAddress,
        decimals: null,
        legacyNet: formatUnits2(group.legacy, LEDGER_SCALE),
        todayReserved: "0",
        chainBalance: "0",
        reclaimed: "0",
        amount: "0",
        status: "chain-error",
        txHash
      };
    }
  })).then((rows) => rows.filter((row) => row != null));
}
async function reconcileLegacyReclaimReceipts(admin, userId) {
  const { data, error } = await admin.from("onchain_settlements").select("id,tx_hash,updated_at").eq("action", "ae_reclaim_legacy").eq("user_id", userId).eq("status", "pending").limit(200);
  if (error) throw new Error(`\u540C\u6B65\u56DE\u6536\u4EA4\u6613\u72C0\u614B\u5931\u6557\uFF1A${error.message}`);
  const staleBefore = Date.now() - 5 * 6e4;
  await Promise.all((data ?? []).map(async (row) => {
    let nextStatus = "pending";
    let statusError = null;
    if (row.tx_hash) {
      nextStatus = await getAdminAssetReclaimReceiptStatus(row.tx_hash);
      if (nextStatus === "failed") statusError = "\u93C8\u4E0A\u56DE\u6536\u4EA4\u6613\u5DF2 revert";
    } else if (new Date(row.updated_at).getTime() < staleBefore) {
      nextStatus = "failed";
      statusError = "\u56DE\u6536\u8ACB\u6C42\u903E\u6642\u4E14\u672A\u9001\u51FA\u93C8\u4E0A\u4EA4\u6613\uFF0C\u53EF\u5B89\u5168\u91CD\u8A66";
    }
    if (nextStatus === "pending") return;
    const { error: updateError } = await admin.from("onchain_settlements").update({ status: nextStatus, error: statusError, updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", row.id).eq("user_id", userId).eq("status", "pending");
    if (updateError) throw new Error(`\u66F4\u65B0\u56DE\u6536\u4EA4\u6613\u72C0\u614B\u5931\u6557\uFF1A${updateError.message}`);
  }));
}
async function guardRelayerGas(response) {
  try {
    await ensureRelayerGas();
    return true;
  } catch (e) {
    json2(response, 503, { error: errMsg(e) });
    return false;
  }
}
async function guardPlacementStillSettleable(admin, response, assetId) {
  const { data: placement } = await admin.from("private_placements").select("id,is_active,is_delisted").eq("id", assetId).maybeSingle();
  if (!placement) {
    json2(response, 404, { error: "\u627E\u4E0D\u5230\u5C0D\u61C9\u7684\u8A8D\u8CFC\u6A19\u7684" });
    return false;
  }
  if (placement.is_delisted) {
    json2(response, 409, { error: "\u6B64\u6A19\u7684\u5DF2\u4E0B\u67B6\uFF0C\u93C8\u4E0A\u7D50\u7B97\u5DF2\u66AB\u505C\uFF0C\uFFFD\uFFFD\u806F\u7E6B\u5BA2\u670D\u8655\u7406" });
    return false;
  }
  if (placement.is_active === false) {
    json2(response, 409, { error: "\u6B64\u6A19\u7684\u76EE\u524D\u672A\u958B\u653E\u8A8D\u8CFC\uFF0C\u93C8\u4E0A\u7D50\u7B97\u5DF2\u66AB\u505C\uFF0C\u8ACB\u806F\u7E6B\u5BA2\u670D\u8655\u7406" });
    return false;
  }
  return true;
}
async function claimSettlement(admin, row) {
  const existing = await admin.from("onchain_settlements").select("id,status,tx_hash").eq("ref_key", row.ref_key).maybeSingle();
  if (existing.error) throw new Error(`\u67E5\u8A62\u7D50\u7B97\u51AA\u7B49\u7D00\u9304\u5931\u6557\uFF1A${existing.error.message}`);
  if (existing.data) {
    if (existing.data.status === "failed") {
      const claimed = await admin.from("onchain_settlements").update({ status: "pending", error: null, updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", existing.data.id).eq("status", "failed").select("id").maybeSingle();
      if (claimed.error) throw new Error(`\u53D6\u5F97\u7D50\u7B97\u91CD\u8A66\u6B0A\u5931\u6557\uFF1A${claimed.error.message}`);
      if (claimed.data) return { id: claimed.data.id };
      const latest = await admin.from("onchain_settlements").select("status,tx_hash").eq("id", existing.data.id).maybeSingle();
      if (latest.error || !latest.data) {
        throw new Error(`\u78BA\u8A8D\u7D50\u7B97\u91CD\u8A66\u72C0\u614B\u5931\u6557\uFF1A${latest.error?.message ?? "\u627E\u4E0D\u5230\u7D50\u7B97\u7D00\u9304"}`);
      }
      return { done: { status: latest.data.status, tx_hash: latest.data.tx_hash } };
    }
    return { done: { status: existing.data.status, tx_hash: existing.data.tx_hash } };
  }
  const inserted = await admin.from("onchain_settlements").insert({ ...row, status: "pending" }).select("id").single();
  if (inserted.error || !inserted.data) {
    const retry = await admin.from("onchain_settlements").select("id,status,tx_hash").eq("ref_key", row.ref_key).maybeSingle();
    if (retry.data) {
      if (retry.data.status === "failed") {
        const claimed = await admin.from("onchain_settlements").update({ status: "pending", error: null, updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", retry.data.id).eq("status", "failed").select("id").maybeSingle();
        if (claimed.error) throw new Error(`\u53D6\u5F97\u7D50\u7B97\u91CD\u8A66\u6B0A\u5931\u6557\uFF1A${claimed.error.message}`);
        if (claimed.data) return { id: claimed.data.id };
      }
      const latest = await admin.from("onchain_settlements").select("status,tx_hash").eq("id", retry.data.id).maybeSingle();
      if (latest.error || !latest.data) {
        throw new Error(`\u78BA\u8A8D\u7D50\u7B97\u91CD\u8A66\u72C0\u614B\u5931\u6557\uFF1A${latest.error?.message ?? "\u627E\u4E0D\u5230\u7D50\u7B97\u7D00\u9304"}`);
      }
      return { done: { status: latest.data.status, tx_hash: latest.data.tx_hash } };
    }
    throw new Error(
      `\u7121\u6CD5\u5EFA\u7ACB\u7D50\u7B97\u7D00\u9304\uFF08action=${row.action}\uFF09\uFF1A${inserted.error?.message ?? "\u672A\u77E5\u932F\u8AA4"}`
    );
  }
  return { id: inserted.data.id };
}
async function finish(admin, id, patch) {
  const { data, error } = await admin.from("onchain_settlements").update({
    ...patch,
    ...patch.status === "confirmed" ? { error: null } : {},
    updated_at: (/* @__PURE__ */ new Date()).toISOString()
  }).eq("id", id).select("id").maybeSingle();
  if (error || !data) {
    throw new Error(`\u66F4\u65B0\u7D50\u7B97\u72C0\u614B\u5931\u6557\uFF1A${error?.message ?? "\u627E\u4E0D\u5230\u7D50\u7B97\u7D00\u9304"}`);
  }
}
async function readSettlementPayload(admin, id) {
  const { data, error } = await admin.from("onchain_settlements").select("payload").eq("id", id).maybeSingle();
  if (error || !data) throw new Error(`\u8B80\u53D6\u7D50\u7B97\u9032\u5EA6\u5931\u6557\uFF1A${error?.message ?? "\u627E\u4E0D\u5230\u7D50\u7B97\u7D00\u9304"}`);
  const payload = data?.payload;
  return payload && typeof payload === "object" ? payload : {};
}
async function mergeSettlementPayload(admin, id, patch) {
  const current = await readSettlementPayload(admin, id);
  const { data, error } = await admin.from("onchain_settlements").update({ payload: { ...current, ...patch }, updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", id).select("id").maybeSingle();
  if (error || !data) {
    throw new Error(`\u4FDD\u5B58\u93C8\u4E0A\u4EA4\u6613\u9032\u5EA6\u5931\u6557\uFF1A${error?.message ?? "\u627E\u4E0D\u5230\u7D50\u7B97\u7D00\u9304"}`);
  }
}
async function runSettlementStep(admin, settlementId, payload, key, submit) {
  const savedHash = typeof payload[key] === "string" ? payload[key] : null;
  if (savedHash) {
    let state = await getAdminTransactionStatus(savedHash);
    if (state === "confirmed") return savedHash;
    if (state !== "reverted") {
      try {
        await waitForAdminTransaction(savedHash);
        return savedHash;
      } catch (error) {
        state = await getAdminTransactionStatus(savedHash);
        if (state !== "reverted") {
          throw new Error(
            `\u93C8\u4E0A\u4EA4\u6613 ${savedHash} \u5C1A\u7121\u6CD5\u78BA\u8A8D\uFF0C\u7CFB\u7D71\u5DF2\u4FDD\u7559\u4EA4\u6613\u4E26\u505C\u6B62\u91CD\u9001\u4EE5\u907F\u514D\u91CD\u8907\u8F49\u5E33\uFF1A${errMsg(error)}`
          );
        }
      }
    }
    await mergeSettlementPayload(admin, settlementId, { [key]: null });
    payload[key] = null;
  }
  let submittedHash = null;
  const result = await submit(async (hash) => {
    await mergeSettlementPayload(admin, settlementId, { [key]: hash });
    payload[key] = hash;
    submittedHash = hash;
  });
  return result ?? submittedHash;
}
async function settleMintJcCore(admin, response, ledgerRow) {
  const { data: ownerProfile } = await admin.from("profiles").select("wallet_address").eq("id", ledgerRow.user_id).maybeSingle();
  let wallet;
  try {
    wallet = toAddress(ownerProfile?.wallet_address, "\u4F7F\u7528\u8005\u5E33\u865F");
  } catch (e) {
    return json2(response, 422, { error: errMsg(e) });
  }
  const amount = Number(ledgerRow.amount);
  if (!(amount > 0)) return json2(response, 422, { error: "JC \u6578\u91CF\u7121\u6548" });
  if (!await guardRelayerGas(response)) return;
  const claim = await claimSettlement(admin, {
    action: "mint_jc",
    ref_key: `mint_jc:${ledgerRow.id}`,
    user_id: ledgerRow.user_id,
    amount,
    payload: { wallet }
  });
  if ("done" in claim) return json2(response, 200, { ...claim.done, idempotent: true });
  try {
    const txHash = await mintJc(wallet, amount);
    await finish(admin, claim.id, { status: "confirmed", tx_hash: txHash });
    return json2(response, 200, { status: "confirmed", tx_hash: txHash, amount });
  } catch (e) {
    await finish(admin, claim.id, { status: "failed", error: errMsg(e) });
    return json2(response, 502, { error: `\u93C8\u4E0A\u767C\u5E63\u5931\u6557\uFF1A${errMsg(e)}` });
  }
}
async function settleSubscribeCore(admin, response, ledgerRow) {
  const placement = await admin.from("private_placements").select("id,is_ae_token").eq("id", ledgerRow.asset_id).maybeSingle();
  const isAe = !!placement.data?.is_ae_token;
  const factoryToken = isAe ? void 0 : await getCurrentRwaFactoryToken(ledgerRow.asset_id) ?? void 0;
  const units = Number(ledgerRow.quantity);
  const gross = Number(
    ledgerRow.metadata?.gross ?? Math.abs(Number(ledgerRow.amount))
  );
  if (!(units > 0) || !(gross > 0)) return json2(response, 422, { error: "\u8A8D\u8CFC\u6578\u91CF\u6216\u91D1\u984D\u7121\u6548" });
  const { data: ownerProfile } = await admin.from("profiles").select("wallet_address").eq("id", ledgerRow.user_id).maybeSingle();
  let wallet;
  try {
    wallet = toAddress(ownerProfile?.wallet_address, "\u4F7F\u7528\u8005\u5E33\u865F");
  } catch (e) {
    return json2(response, 422, { error: errMsg(e) });
  }
  if (!await guardPlacementStillSettleable(admin, response, String(ledgerRow.asset_id))) return;
  if (!await guardRelayerGas(response)) return;
  const claim = await claimSettlement(admin, {
    action: "subscribe",
    ref_key: `subscribe:${ledgerRow.id}`,
    user_id: ledgerRow.user_id,
    asset_id: ledgerRow.asset_id,
    amount: units,
    payment: gross,
    payload: { wallet, isAe, factoryToken: factoryToken ?? null }
  });
  if ("done" in claim) return json2(response, 200, { ...claim.done, idempotent: true });
  try {
    const payload = await readSettlementPayload(admin, claim.id);
    const hasLegacyJcPull = typeof payload.jcPullTx === "string";
    if (hasLegacyJcPull) {
      const pullTx = await runSettlementStep(
        admin,
        claim.id,
        payload,
        "jcPullTx",
        (onSubmitted) => pullJcFromUser(wallet, gross, onSubmitted)
      );
      if (!pullTx) throw new Error("\u820A\u7248\u8A8D\u8CFC JC \u6536\u6B3E\u5C1A\u672A\u78BA\u8A8D\uFF0C\u7CFB\u7D71\u5C07\u5B89\u5168\u91CD\u8A66");
      if (typeof payload.assetTransferTx !== "string") {
        const assetToken = isAe ? RELAYER_ADDRESSES.aeToken : factoryToken;
        if (assetToken) {
          const recoveredTx = await findRecentAssetTransfer(
            assetToken,
            wallet,
            units,
            payload.jcPullTx,
            !isAe
          );
          if (recoveredTx) {
            await mergeSettlementPayload(admin, claim.id, {
              assetTransferTx: recoveredTx,
              assetTransferRecovered: true
            });
            payload.assetTransferTx = recoveredTx;
          }
        }
      }
    }
    const vaultTx = await runSettlementStep(
      admin,
      claim.id,
      payload,
      "jcToVaultTx",
      (onSubmitted) => hasLegacyJcPull ? sendJcToVault(gross, onSubmitted) : collectJcToVault(wallet, gross, onSubmitted)
    );
    if (!vaultTx) throw new Error("\u8A8D\u8CFC JC \u5C1A\u672A\u8F49\u5165 Safe\uFF0C\u8ACB\u7A0D\u5F8C\u81EA\u52D5\u91CD\u8A66");
    const assetTx = await runSettlementStep(
      admin,
      claim.id,
      payload,
      "assetTransferTx",
      (onSubmitted) => isAe ? executeAeSubscription(wallet, units, onSubmitted) : executeSubscription(wallet, units, void 0, factoryToken, onSubmitted)
    );
    if (!assetTx) throw new Error("\u6A19\u7684\u4EFD\u984D\u5C1A\u672A\u767C\u653E\uFF0C\u8ACB\u7A0D\u5F8C\u81EA\u52D5\u91CD\u8A66");
    await finish(admin, claim.id, { status: "confirmed", tx_hash: assetTx });
    await settleCommissionsForSource(admin, ledgerRow.id).catch(() => {
    });
    return json2(response, 200, { status: "confirmed", tx_hash: assetTx, units, payment: gross });
  } catch (e) {
    await finish(admin, claim.id, { status: "failed", error: errMsg(e) });
    return json2(response, 502, { error: `\u93C8\u4E0A\u8A8D\u8CFC\u7D50\u7B97\u5931\u6557\uFF1A${errMsg(e)}` });
  }
}
async function settleRedemptionCore(admin, response, order) {
  let wallet;
  try {
    wallet = toAddress(order.wallet_address, "\u4F7F\u7528\u8005\u5E33\u865F");
  } catch (e) {
    return json2(response, 422, { error: errMsg(e) });
  }
  const jcAmount = Number(order.jc_amount);
  const usdtAmount = Number(order.usdt_amount);
  if (!(jcAmount > 0) || !(usdtAmount > 0)) return json2(response, 422, { error: "\u8D16\u56DE\u91D1\u984D\u7121\u6548" });
  if (!await guardRelayerGas(response)) return;
  const claim = await claimSettlement(admin, {
    action: "redeem",
    ref_key: `redeem:${order.id}`,
    user_id: order.user_id,
    amount: jcAmount,
    payment: usdtAmount,
    payload: { wallet }
  });
  if ("done" in claim) return json2(response, 200, { ...claim.done, idempotent: true });
  try {
    const payload = await readSettlementPayload(admin, claim.id);
    let jcCollectTx = typeof payload.jcCollectTx === "string" ? payload.jcCollectTx : null;
    if (!jcCollectTx) {
      jcCollectTx = await collectJcToVault(wallet, jcAmount);
      await mergeSettlementPayload(admin, claim.id, { jcCollectTx });
    }
    let usdtTx = typeof payload.usdtTx === "string" ? payload.usdtTx : null;
    if (!usdtTx) {
      usdtTx = await adminSendUsdt(wallet, usdtAmount);
      await mergeSettlementPayload(admin, claim.id, { usdtTx });
    }
    await finish(admin, claim.id, { status: "confirmed", tx_hash: usdtTx ?? void 0 });
    await admin.from("redemption_orders").update({
      status: "completed",
      tx_hash: usdtTx,
      admin_note: "\u7CFB\u7D71\u81EA\u52D5\u64A5\u6B3E\uFF08\u93C8\u4E0A\u5373\u6642\u7D50\u7B97\uFF09",
      resolved_at: (/* @__PURE__ */ new Date()).toISOString(),
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    }).eq("id", order.id).eq("status", "pending");
    return json2(response, 200, {
      status: "confirmed",
      tx_hash: usdtTx,
      jc_collect_tx: jcCollectTx,
      jc_amount: jcAmount,
      usdt_amount: usdtAmount
    });
  } catch (e) {
    await finish(admin, claim.id, { status: "failed", error: errMsg(e) });
    return json2(response, 502, { error: `\u8D16\u56DE\u93C8\u4E0A\u64A5\u6B3E\u5931\u6557\uFF1A${errMsg(e)}` });
  }
}
async function settleCommissionCore(admin, response, log) {
  const amount = Number(log.amount);
  if (!(amount > 0)) return json2(response, 422, { error: "\u5206\u6F64\u91D1\u984D\u7121\u6548" });
  const { data: beneficiary } = await admin.from("profiles").select("wallet_address").eq("id", log.user_id).maybeSingle();
  let wallet;
  try {
    wallet = toAddress(beneficiary?.wallet_address, "\u53D7\u76CA\u4EBA\u5E33\u865F");
  } catch (e) {
    return json2(response, 422, { error: errMsg(e) });
  }
  if (!await guardRelayerGas(response)) return;
  const claim = await claimSettlement(admin, {
    action: "commission",
    ref_key: `commission:${log.id}`,
    user_id: log.user_id,
    asset_id: log.asset_id,
    amount,
    payment: amount,
    payload: { wallet }
  });
  if ("done" in claim) return json2(response, 200, { ...claim.done, idempotent: true });
  try {
    const payload = await readSettlementPayload(admin, claim.id);
    let payoutTx = typeof payload.payoutTx === "string" ? payload.payoutTx : null;
    if (!payoutTx) {
      payoutTx = await adminSendJc(wallet, amount);
      await mergeSettlementPayload(admin, claim.id, { payoutTx });
    }
    await admin.from("jc_ledger").upsert(
      {
        user_id: log.user_id,
        entry_type: "commission_payout",
        amount,
        asset_id: log.asset_id,
        idempotency_key: `commission-payout:${log.id}`,
        metadata: { commission_log_id: log.id, onchain: true, tx: payoutTx }
      },
      { onConflict: "idempotency_key", ignoreDuplicates: true }
    );
    await admin.from("commission_logs").update({ paid_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", log.id).is("paid_at", null);
    await finish(admin, claim.id, { status: "confirmed", tx_hash: payoutTx ?? void 0 });
    return json2(response, 200, { status: "confirmed", tx_hash: payoutTx, amount });
  } catch (e) {
    await finish(admin, claim.id, { status: "failed", error: errMsg(e) });
    return json2(response, 502, { error: `\u5206\u6F64\u93C8\u4E0A\u767C\u653E\u5931\u6557\uFF1A${errMsg(e)}` });
  }
}
async function settleCommissionsForSource(admin, sourceLedgerId) {
  const { data: logs } = await admin.from("commission_logs").select("id,beneficiary_id,commission_amount,asset_id").eq("source_ledger_id", sourceLedgerId).is("paid_at", null);
  for (const log of logs ?? []) {
    if (!log.beneficiary_id) continue;
    const { response } = fakeResponse();
    try {
      await settleCommissionCore(admin, response, {
        id: log.id,
        user_id: log.beneficiary_id,
        amount: Number(log.commission_amount),
        asset_id: log.asset_id ?? null
      });
    } catch {
    }
  }
}
async function reverseCommissionForBeneficiary(admin, beneficiaryId) {
  const [owedResult, paidResult] = await Promise.all([
    admin.from("commission_logs").select("commission_amount").eq("beneficiary_id", beneficiaryId).not("paid_at", "is", null),
    admin.from("jc_ledger").select("amount").eq("user_id", beneficiaryId).in("entry_type", ["commission_payout", "commission_reversal"])
  ]);
  const owed = (owedResult.data ?? []).reduce((sum, r) => sum + Number(r.commission_amount), 0);
  const paid = (paidResult.data ?? []).reduce((sum, r) => sum + Number(r.amount), 0);
  const round6 = (n) => Math.round(n * 1e6) / 1e6;
  const diff = round6(paid - owed);
  if (Math.abs(diff) <= 1e-6) {
    return { beneficiaryId, applied: false, direction: "none", amount: 0 };
  }
  if (diff < 0) {
    const shortfall = round6(owed - paid);
    const { data: prof } = await admin.from("profiles").select("wallet_address").eq("id", beneficiaryId).maybeSingle();
    let wallet;
    try {
      wallet = toAddress(prof?.wallet_address, "\u53D7\u76CA\u4EBA\u5E33\u865F");
    } catch (e) {
      return { beneficiaryId, applied: false, direction: "under", amount: shortfall, error: errMsg(e) };
    }
    const tx = await adminSendJc(wallet, shortfall);
    if (!tx) throw new Error("\u5206\u6F64\u88DC\u767C\u984D\u5EA6\u70BA 0\uFF0C\u672A\u9001\u51FA\u93C8\u4E0A\u4EA4\u6613");
    await admin.from("jc_ledger").insert({
      user_id: beneficiaryId,
      entry_type: "commission_reversal",
      amount: shortfall,
      idempotency_key: `commission-reverse:${beneficiaryId}:${Date.now()}`,
      metadata: { kind: "under", reason: "\u6C96\u6B63\u88DC\u767C\u5C11\u767C\u5206\u6F64", tx }
    });
    await admin.from("onchain_settlements").insert({
      action: "commission_reverse",
      ref_key: `commission_reverse:${beneficiaryId}:${Date.now()}`,
      user_id: beneficiaryId,
      amount: shortfall,
      status: "confirmed",
      tx_hash: tx
    });
    return { beneficiaryId, applied: true, direction: "under", amount: shortfall, tx };
  }
  const excess = round6(paid - owed);
  await admin.from("jc_ledger").insert({
    user_id: beneficiaryId,
    entry_type: "commission_reversal",
    amount: -excess,
    idempotency_key: `commission-reverse:${beneficiaryId}:${Date.now()}`,
    metadata: { kind: "over", reason: "\u6C96\u6B63\u6263\u56DE\u591A\u767C\u5206\u6F64\uFF08\u50C5\u6821\u6B63\u7AD9\u5167\u5E33\u672C\uFF09" }
  });
  await admin.from("onchain_settlements").insert({
    action: "commission_reverse",
    ref_key: `commission_reverse:${beneficiaryId}:${Date.now()}`,
    user_id: beneficiaryId,
    amount: -excess,
    status: "confirmed"
  });
  return { beneficiaryId, applied: true, direction: "over", amount: excess };
}
async function sweepPendingCommissions(admin, limit = 100, beneficiaryIds) {
  let query = admin.from("commission_logs").select("id,beneficiary_id,commission_amount,asset_id").is("paid_at", null).not("beneficiary_id", "is", null).gt("commission_amount", 0);
  if (beneficiaryIds && beneficiaryIds.length > 0) {
    query = query.in("beneficiary_id", beneficiaryIds);
  }
  const { data: logs } = await query.order("created_at", { ascending: true }).limit(limit);
  let settled = 0;
  let skipped = 0;
  for (const log of logs ?? []) {
    if (!log.beneficiary_id) {
      skipped += 1;
      continue;
    }
    const { response, read } = fakeResponse();
    try {
      await settleCommissionCore(admin, response, {
        id: log.id,
        user_id: log.beneficiary_id,
        amount: Number(log.commission_amount),
        asset_id: log.asset_id ?? null
      });
      const { status } = read();
      if (status >= 200 && status < 300) settled += 1;
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { scanned: logs?.length ?? 0, settled, skipped };
}
async function handler2(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return json2(response, 405, { error: "Method not allowed" });
  }
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceKey) {
    return json2(response, 503, { error: "Relayer \u5C1A\u672A\u8A2D\u5B9A Supabase \u9023\u7DDA" });
  }
  if (!process.env.ADMIN_PRIVATE_KEY) {
    return json2(response, 503, { error: "Relayer \u5C1A\u672A\u8A2D\u5B9A ADMIN_PRIVATE_KEY\uFF08\u5F8C\u7AEF\u71B1\u9322\u5305\u79C1\u9470\uFF09" });
  }
  const authHeader = request.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return json2(response, 401, { error: "\u7F3A\u5C11\u767B\u5165\u6191\u8B49" });
  let body;
  try {
    body = await readBody2(request);
  } catch {
    return json2(response, 400, { error: "Invalid request body" });
  }
  const action = body.action;
  if (!action) return json2(response, 400, { error: "\u7F3A\u5C11 action" });
  const admin = createClient2(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  const caller = userData?.user;
  if (userError || !caller) return json2(response, 401, { error: "\u767B\u5165\u6191\u8B49\u7121\u6548" });
  const { data: callerProfile } = await admin.from("profiles").select("id,agency_role,role,wallet_address").eq("id", caller.id).maybeSingle();
  if (!callerProfile) return json2(response, 403, { error: "\u627E\u4E0D\u5230\u5E73\u53F0\u5E33\u865F" });
  if (action === "legacy-reclaim-list" || action === "legacy-reclaim") {
    return json2(response, 410, { error: "\u820A\u8CC7\u7522\u67E5\u8A62\u8207\u56DE\u6536\u5DF2\u505C\u7528" });
  }
  if (action === "wire-contracts") {
    return json2(response, 410, { error: "\u6B64\u8A2D\u5B9A\u5DF2\u505C\u7528\uFF0CRWA \u4F7F\u7528\u76EE\u524D Factory" });
  }
  const escrowActions = /* @__PURE__ */ new Set([
    "register-escrow-order",
    "settle-escrow-fill",
    "register-escrow-cancel",
    "admin-escrow-status",
    "admin-retry-escrow-event"
  ]);
  if (!escrowActions.has(action)) await maybeOpportunisticSweep(admin);
  try {
    if (action === "register-escrow-order") {
      if (!body.txHash) return json2(response, 400, { error: "\u7F3A\u5C11\u639B\u55AE\u4EA4\u6613\u96DC\u6E4A" });
      const result = await processEscrowOrderCreated(admin, body.txHash, callerProfile);
      return json2(response, 200, result);
    }
    if (action === "settle-escrow-fill") {
      if (!body.txHash) return json2(response, 400, { error: "\u7F3A\u5C11\u6210\u4EA4\u4EA4\u6613\u96DC\u6E4A" });
      const result = await processEscrowFill(admin, body.txHash, callerProfile);
      return json2(response, 200, result);
    }
    if (action === "register-escrow-cancel") {
      if (!body.txHash) return json2(response, 400, { error: "\u7F3A\u5C11\u53D6\u6D88\u4EA4\u6613\u96DC\u6E4A" });
      const result = await processEscrowCancel(admin, body.txHash, callerProfile);
      return json2(response, 200, result);
    }
    if (action === "admin-escrow-status") {
      if (!isAdminProfile(callerProfile)) return json2(response, 403, { error: "\u50C5\u9650\u7BA1\u7406\u54E1\u57F7\u884C" });
      const [ordersResult, legacyResult, eventsResult, auditResult] = await Promise.all([
        admin.from("p2p_orders").select("id,asset_id,side,price,remaining_quantity,escrow_chain_order_id,escrow_token_address,escrow_currency_address").eq("escrow_mode", "escrow").in("status", ["open", "partially_filled"]),
        admin.from("p2p_orders").select("id", { count: "exact", head: true }).eq("escrow_mode", "legacy").in("status", ["open", "partially_filled"]),
        admin.from("p2p_escrow_events").select("tx_hash,event_type,status,error,user_id,created_at").in("status", ["pending", "failed"]).order("created_at", { ascending: false }).limit(50),
        admin.from("p2p_escrow_cutover_audit").select("order_id", { count: "exact", head: true })
      ]);
      const error = ordersResult.error ?? legacyResult.error ?? eventsResult.error ?? auditResult.error;
      if (error) return json2(response, 500, { error: `\u8A17\u7BA1\u7A3D\u6838\u8CC7\u6599\u8B80\u53D6\u5931\u6557\uFF1A${error.message}` });
      const orders = ordersResult.data ?? [];
      const expected = /* @__PURE__ */ new Map();
      for (const order of orders) {
        const token2 = order.side === "sell" ? order.escrow_token_address : order.escrow_currency_address;
        if (!token2) continue;
        const amount = order.side === "sell" ? Number(order.remaining_quantity) : Number(order.price) * Number(order.remaining_quantity);
        expected.set(token2.toLowerCase(), (expected.get(token2.toLowerCase()) ?? 0) + amount);
      }
      const lockedBalances = P2P_ESCROW_ADDRESS ? await Promise.all([...expected.entries()].map(async ([token2, databaseAmount]) => {
        const address = toAddress(token2, "\u8A17\u7BA1\u4EE3\u5E63");
        try {
          const locked = await getP2PEscrowLocked(address);
          return { token: address, databaseAmount, chainAmount: Number(formatUnits2(locked, 18)), error: null };
        } catch (error2) {
          return { token: address, databaseAmount, chainAmount: null, error: errMsg(error2) };
        }
      })) : [];
      return json2(response, 200, {
        configured: Boolean(P2P_ESCROW_ADDRESS),
        activeEscrowOrders: orders.length,
        activeLegacyOrders: legacyResult.count ?? 0,
        pendingEvents: eventsResult.data?.length ?? 0,
        cancelledLegacyOrders: auditResult.count ?? 0,
        lockedBalances,
        events: eventsResult.data ?? []
      });
    }
    if (action === "admin-retry-escrow-event") {
      if (!isAdminProfile(callerProfile)) return json2(response, 403, { error: "\u50C5\u9650\u7BA1\u7406\u54E1\u57F7\u884C" });
      const eventId = body.eventId?.trim();
      if (!eventId) return json2(response, 400, { error: "\u7F3A\u5C11\u8A17\u7BA1\u4E8B\u4EF6\u8B58\u5225\u78BC" });
      const { data: event, error } = await admin.from("p2p_escrow_events").select("tx_hash,event_type,status").eq("tx_hash", eventId).maybeSingle();
      if (error || !event) return json2(response, 404, { error: "\u627E\u4E0D\u5230\u5F85\u4FEE\u5FA9\u7684\u8A17\u7BA1\u4E8B\u4EF6" });
      if (event.status === "finalized") return json2(response, 200, { status: "finalized", idempotent: true });
      const result = event.event_type === "order_created" ? await processEscrowOrderCreated(admin, event.tx_hash, null) : event.event_type === "order_filled" ? await processEscrowFill(admin, event.tx_hash, null) : await processEscrowCancel(admin, event.tx_hash, null);
      return json2(response, 200, result);
    }
    if (action === "wire-contracts") {
      if (!isAdminProfile(callerProfile)) {
        return json2(response, 403, { error: "\u50C5\u9650\u7BA1\u7406\u54E1\u57F7\u884C" });
      }
      const results = await wireRwaContracts();
      const realHash = [results.subscription, results.market].find(
        (value) => typeof value === "string" && value.startsWith("0x")
      ) ?? null;
      await admin.from("onchain_settlements").insert({
        action: "wire_contracts",
        ref_key: `wire_contracts:${Date.now()}`,
        user_id: caller.id,
        status: "confirmed",
        tx_hash: realHash,
        payload: results
      });
      return json2(response, 200, { ok: !results.marketError, results, relayer: relayerAddress() });
    }
    if (action === "admin-agent-wallet") {
      if (!isAdminProfile(callerProfile)) {
        return json2(response, 403, { error: "\u50C5\u9650\u7BA1\u7406\u54E1\u57F7\u884C" });
      }
      const recipientId = body.recipientId?.trim();
      if (!recipientId) return json2(response, 400, { error: "\u8ACB\u5148\u9078\u64C7\u4EE3\u7406" });
      const { data: recipient } = await admin.from("profiles").select("id,agency_role,wallet_address").eq("id", recipientId).maybeSingle();
      if (!recipient || !String(recipient.agency_role ?? "").includes("\u4EE3\u7406")) {
        return json2(response, 404, { error: "\u627E\u4E0D\u5230\u6709\u6548\u7684\u4EE3\u7406\u5E33\u865F" });
      }
      try {
        return json2(response, 200, { wallet: toAddress(recipient.wallet_address, "\u4EE3\u7406\u5E33\u865F") });
      } catch (e) {
        return json2(response, 422, { error: errMsg(e) });
      }
    }
    if (action === "legacy-reclaim-list" || action === "legacy-reclaim") {
      let wallet;
      try {
        wallet = toAddress(callerProfile.wallet_address, "\u4F7F\u7528\u8005\u5E33\u865F");
      } catch (e) {
        return json2(response, 422, { error: errMsg(e) });
      }
      if (action === "legacy-reclaim-list") {
        await reconcileLegacyReclaimReceipts(admin, caller.id);
        const candidates2 = await readLegacyReclaimCandidates(admin, caller.id, wallet);
        return json2(response, 200, { cutoff: LEGACY_RECLAIM_CUTOFF, candidates: candidates2 });
      }
      const assetKey = body.assetKey?.trim();
      const expectedAmount = body.expectedAmount?.trim();
      const validAssetKey = assetKey && /^(?:legacy-ae|legacy-rwa:0x[a-f0-9]{40}|legacy-rwa-placement:[A-Za-z0-9_-]{1,120})$/.test(assetKey);
      if (!validAssetKey || !expectedAmount || expectedAmount.length > 80 || !/^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/.test(expectedAmount)) {
        return json2(response, 400, { error: "\u56DE\u6536\u8CC7\u7522\u6216\u6578\u91CF\u683C\u5F0F\u932F\u8AA4\uFF0C\u8ACB\u91CD\u65B0\u6574\u7406\u5F8C\u518D\u8A66" });
      }
      const refKey = `legacy_asset_reclaim:${caller.id}:${assetKey}`;
      const { data: existingSettlement, error: settlementReadError } = await admin.from("onchain_settlements").select("id,action,status,tx_hash,user_id,asset_id,amount,payload,updated_at").eq("ref_key", refKey).maybeSingle();
      let settlement = existingSettlement;
      if (settlementReadError) throw new Error(`\u8B80\u53D6\u56DE\u6536\u72C0\u614B\u5931\u6557\uFF1A${settlementReadError.message}`);
      if (settlement && (settlement.action !== "ae_reclaim_legacy" || settlement.user_id !== caller.id || settlement.asset_id !== assetKey)) {
        return json2(response, 409, { error: "\u56DE\u6536\u8B58\u5225\u78BC\u8CC7\u6599\u4E0D\u4E00\u81F4\uFF0C\u8ACB\u806F\u7E6B\u5BA2\u670D" });
      }
      if (settlement?.status === "confirmed") {
        return json2(response, 200, { status: "confirmed", txHash: settlement.tx_hash, amount: String(settlement.amount ?? "0") });
      }
      if (settlement?.status === "pending") {
        if (!settlement.tx_hash) {
          const staleBefore = new Date(Date.now() - 5 * 6e4).toISOString();
          if (new Date(settlement.updated_at).getTime() >= Date.parse(staleBefore)) {
            return json2(response, 409, { status: "pending", error: "\u6B64\u8CC7\u7522\u5DF2\u6709\u56DE\u6536\u8ACB\u6C42\u8655\u7406\u4E2D\uFF0C\u8ACB\u7A0D\u5F8C\u91CD\u65B0\u6574\u7406" });
          }
          const { data: staleClaim, error } = await admin.from("onchain_settlements").update({ status: "failed", error: "\u56DE\u6536\u8ACB\u6C42\u903E\u6642\u4E14\u672A\u9001\u51FA\u93C8\u4E0A\u4EA4\u6613\uFF0C\u53EF\u5B89\u5168\u91CD\u8A66", updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", settlement.id).eq("status", "pending").is("tx_hash", null).lt("updated_at", staleBefore).select("id").maybeSingle();
          if (error) throw new Error(`\u6062\u5FA9\u904E\u671F\u56DE\u6536\u8ACB\u6C42\u5931\u6557\uFF1A${error.message}`);
          if (!staleClaim) return json2(response, 409, { status: "pending", error: "\u6B64\u8CC7\u7522\u5DF2\u6709\u56DE\u6536\u8ACB\u6C42\u8655\u7406\u4E2D\uFF0C\u8ACB\u7A0D\u5F8C\u91CD\u65B0\u6574\u7406" });
          settlement.status = "failed";
        } else {
          try {
            const confirmed = await waitForAdminAssetReclaim(settlement.tx_hash);
            if (confirmed) {
              const { error: error2 } = await admin.from("onchain_settlements").update({ status: "confirmed", error: null, updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", settlement.id);
              if (error2) throw new Error(`\u5DF2\u4E0A\u93C8\u4F46\u66F4\u65B0\u56DE\u6536\u72C0\u614B\u5931\u6557\uFF1A${error2.message}`);
              return json2(response, 200, { status: "confirmed", txHash: settlement.tx_hash, amount: String(settlement.amount ?? "0") });
            }
            const { error } = await admin.from("onchain_settlements").update({ status: "failed", error: "\u93C8\u4E0A\u56DE\u6536\u4EA4\u6613\u5DF2 revert", updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", settlement.id);
            if (error) throw new Error(`\u66F4\u65B0\u5931\u6557\u56DE\u6536\u72C0\u614B\u5931\u6557\uFF1A${error.message}`);
            settlement.status = "failed";
          } catch {
            return json2(response, 202, { status: "pending", txHash: settlement.tx_hash, amount: String(settlement.amount ?? "0") });
          }
        }
      }
      const candidates = await readLegacyReclaimCandidates(admin, caller.id, wallet);
      const candidate = candidates.find((item) => item.assetKey === assetKey);
      if (!candidate || candidate.status !== "ready" || !candidate.tokenAddress || candidate.decimals == null) {
        return json2(response, 409, { error: "\u76EE\u524D\u6C92\u6709\u53EF\u56DE\u6536\u7684\u820A\u6301\u5009\uFF0C\u6216\u93C8\u4E0A\u9918\u984D\uFF0F\u4ECA\u65E5\u4FDD\u7559\u984D\u5DF2\u8B8A\u52D5\uFF0C\u8ACB\u91CD\u65B0\u6574\u7406" });
      }
      let requestedUnits;
      let candidateUnits;
      try {
        requestedUnits = parseUnits2(expectedAmount, candidate.decimals);
        candidateUnits = parseUnits2(candidate.amount, candidate.decimals);
      } catch {
        return json2(response, 400, { error: "\u56DE\u6536\u6578\u91CF\u8D85\u51FA\u4EE3\u5E63\u7CBE\u5EA6\uFF0C\u8ACB\u91CD\u65B0\u6574\u7406\u5F8C\u518D\u8A66" });
      }
      if (requestedUnits <= 0n || requestedUnits !== candidateUnits) {
        return json2(response, 409, { error: "\u56DE\u6536\u984D\u5EA6\u5DF2\u8B8A\u52D5\uFF0C\u8ACB\u91CD\u65B0\u6574\u7406\u4E26\u91CD\u65B0\u6388\u6B0A\u7CBE\u78BA\u984D\u5EA6" });
      }
      const payload = {
        assetKey,
        assetType: candidate.kind,
        tokenAddress: candidate.tokenAddress,
        wallet,
        amount: candidate.amount,
        todayCutoff: LEGACY_RECLAIM_CUTOFF
      };
      if (settlement?.status === "failed") {
        const { data: claimed, error } = await admin.from("onchain_settlements").update({ status: "pending", tx_hash: null, error: null, amount: candidate.amount, payload, updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", settlement.id).eq("status", "failed").select("id,action,status,tx_hash,user_id,asset_id,amount,payload,updated_at").maybeSingle();
        if (error) throw new Error(`\u91CD\u65B0\u5EFA\u7ACB\u56DE\u6536\u8ACB\u6C42\u5931\u6557\uFF1A${error.message}`);
        if (!claimed) return json2(response, 409, { status: "pending", error: "\u6B64\u8CC7\u7522\u5DF2\u6709\u56DE\u6536\u8ACB\u6C42\u8655\u7406\u4E2D\uFF0C\u8ACB\u7A0D\u5F8C\u91CD\u65B0\u6574\u7406" });
        settlement = claimed;
      } else if (!settlement) {
        const { data: inserted, error } = await admin.from("onchain_settlements").insert({
          action: "ae_reclaim_legacy",
          ref_key: refKey,
          user_id: caller.id,
          asset_id: assetKey,
          amount: candidate.amount,
          status: "pending",
          payload
        }).select("id,action,status,tx_hash,user_id,asset_id,amount,payload,updated_at").single();
        if (error) {
          if (error.code === "23505") return json2(response, 409, { status: "pending", error: "\u6B64\u8CC7\u7522\u5DF2\u6709\u56DE\u6536\u8ACB\u6C42\u8655\u7406\u4E2D\uFF0C\u8ACB\u7A0D\u5F8C\u91CD\u65B0\u6574\u7406" });
          throw new Error(`\u5EFA\u7ACB\u56DE\u6536\u7D00\u9304\u5931\u6557\uFF1A${error.message}`);
        }
        settlement = inserted;
      }
      if (!settlement?.id) {
        return json2(response, 500, { error: "\u56DE\u6536\u7D00\u9304\u672A\u6210\u529F\u9396\u5B9A\uFF0C\u8ACB\u7A0D\u5F8C\u91CD\u8A66" });
      }
      let txHash;
      try {
        txHash = await sendAdminAssetReclaim({
          tokenAddress: candidate.tokenAddress,
          owner: wallet,
          amount: candidate.amount,
          label: candidate.label
        });
      } catch (e) {
        await admin.from("onchain_settlements").update({ status: "failed", error: errMsg(e), updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", settlement.id);
        return json2(response, 422, { status: "failed", error: errMsg(e) });
      }
      const { error: hashError } = await admin.from("onchain_settlements").update({ tx_hash: txHash, updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", settlement.id);
      if (hashError) {
        return json2(response, 503, { status: "pending", txHash, error: "\u4EA4\u6613\u5DF2\u9001\u51FA\uFF0C\u56DE\u6536\u7D00\u9304\u5C1A\u672A\u540C\u6B65\uFF0C\u8ACB\u7A0D\u5F8C\u91CD\u65B0\u6574\u7406\u4E26\u806F\u7E6B\u5BA2\u670D\u63D0\u4F9B\u4EA4\u6613\u96DC\u6E4A" });
      }
      try {
        const confirmed = await waitForAdminAssetReclaim(txHash);
        const status = confirmed ? "confirmed" : "failed";
        const { error } = await admin.from("onchain_settlements").update({ status, error: confirmed ? null : "\u93C8\u4E0A\u56DE\u6536\u4EA4\u6613\u5DF2 revert", updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", settlement.id);
        if (error) throw new Error(`\u66F4\u65B0\u56DE\u6536\u72C0\u614B\u5931\u6557\uFF1A${error.message}`);
        return json2(response, confirmed ? 200 : 422, {
          status,
          txHash,
          amount: candidate.amount,
          error: confirmed ? void 0 : "\u93C8\u4E0A\u56DE\u6536\u4EA4\u6613\u5931\u6557\uFF0C\u8ACB\u78BA\u8A8D\u9322\u5305\u6388\u6B0A\u5F8C\u91CD\u8A66"
        });
      } catch {
        return json2(response, 202, { status: "pending", txHash, amount: candidate.amount });
      }
    }
    if (action === "relayer-address") {
      return json2(response, 200, { address: relayerAddress() });
    }
    if (action === "admin-vault-status") {
      if (!isAdminProfile(callerProfile)) {
        return json2(response, 403, { error: "\u50C5\u9650\u7BA1\u7406\u54E1\u57F7\u884C" });
      }
      const [jc, ae] = await Promise.all([getVaultStatus("jcToken"), getVaultStatus("aeToken")]);
      const serialize = (s) => ({
        token: s.token,
        balance: s.balanceFormatted,
        low: s.low
      });
      const { data: rwaPlacements } = await admin.from("private_placements").select("id,name").eq("is_ae_token", false).eq("is_active", true).eq("is_delisted", false);
      const rwa = (await Promise.all(
        (rwaPlacements ?? []).map(async (placement) => {
          try {
            const tokenAddress = await getCurrentRwaFactoryToken(placement.id);
            if (!tokenAddress) return null;
            const s = await getHotWalletShareBalance(tokenAddress);
            return { name: String(placement.name ?? ""), balance: s.balanceFormatted };
          } catch {
            return null;
          }
        })
      )).filter((x) => x != null);
      return json2(response, 200, { jc: serialize(jc), ae: serialize(ae), rwa });
    }
    if (action === "admin-burn-inventory") {
      if (!isAdminProfile(callerProfile)) return json2(response, 403, { error: "\u50C5\u9650\u7BA1\u7406\u54E1\u57F7\u884C" });
      const input = body;
      const token2 = input.token === "jc" || input.token === "ae" || input.token === "rwa" ? input.token : null;
      if (!token2) return json2(response, 400, { error: "token \u5FC5\u9808\u662F jc\u3001ae \u6216 rwa" });
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount <= 0) return json2(response, 400, { error: "\u92B7\u6BC0\u6578\u91CF\u5FC5\u9808\u662F\u5927\u65BC 0 \u7684\u6578\u5B57" });
      let tokenAddress;
      try {
        if (token2 === "rwa") {
          if (!input.placementId) return json2(response, 400, { error: "\u8ACB\u9078\u64C7 RWA \u6A19\u7684" });
          const { data: placement, error: placementError } = await admin.from("private_placements").select("id,is_ae_token").eq("id", input.placementId).eq("is_ae_token", false).maybeSingle();
          if (placementError) throw new Error(`\u8B80\u53D6 RWA \u6A19\u7684\u5931\u6557\uFF1A${placementError.message}`);
          if (!placement) return json2(response, 404, { error: "\u627E\u4E0D\u5230\u6B64 RWA \u6A19\u7684" });
          tokenAddress = await getCurrentRwaFactoryToken(placement.id) ?? void 0;
          if (!tokenAddress) return json2(response, 404, { error: "\u6B64\u6A19\u7684\u5C1A\u672A\u5728\u76EE\u524D Factory \u5EFA\u7ACB\u4EE3\u5E63" });
        }
        const txHash = await burnVaultInventory(token2, amount, tokenAddress);
        return json2(response, 200, { txHash, token: token2, amount });
      } catch (e) {
        return json2(response, 502, { error: errMsg(e) });
      }
    }
    if (action === "admin-mint") {
      if (!isAdminProfile(callerProfile)) {
        return json2(response, 403, { error: "\u50C5\u9650\u7BA1\u7406\u54E1\u57F7\u884C" });
      }
      const input = body;
      const token2 = input.token === "jc" ? "jcToken" : input.token === "ae" ? "aeToken" : null;
      if (!token2) return json2(response, 400, { error: "token \u5FC5\u9808\u662F jc \u6216 ae" });
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return json2(response, 400, { error: "\u589E\u767C\u6578\u91CF\u5FC5\u9808\u662F\u5927\u65BC 0 \u7684\u6578\u5B57" });
      }
      let to;
      try {
        to = input.to && input.to.trim() ? toAddress(input.to.trim(), "\u589E\u767C\u76EE\u6A19\u5730\u5740") : getAddress2(RELAYER_ADDRESSES.safeVault);
      } catch (e) {
        return json2(response, 422, { error: errMsg(e) });
      }
      try {
        const txHash = await mintTokenSupply(token2, to, amount);
        return json2(response, 200, { txHash, token: input.token, to, amount });
      } catch (e) {
        return json2(response, 502, { error: errMsg(e) });
      }
    }
    if (action === "admin-ae-reclaim") {
      if (!isAdminProfile(callerProfile)) {
        return json2(response, 403, { error: "\u50C5\u9650\u7BA1\u7406\u54E1\u57F7\u884C" });
      }
      const { data: aePlacements, error: aeErr } = await admin.from("private_placements").select("id").eq("is_ae_token", true);
      if (aeErr) throw new Error(`\u67E5\u8A62 AE \u6A19\u7684\u5931\u6557\uFF1A${aeErr.message}`);
      const aeIds = (aePlacements ?? []).map((p) => p.id);
      if (aeIds.length === 0) return json2(response, 200, { reclaimed: [], failed: [] });
      const { data: holders, error: holdErr } = await admin.from("holdings").select("user_id, profiles!inner(wallet_address)").in("asset_id", aeIds);
      if (holdErr) throw new Error(`\u67E5\u8A62\u6301\u6709\u4EBA\u5931\u6557\uFF1A${holdErr.message}`);
      const wallets = Array.from(
        new Set(
          (holders ?? []).map((h) => h.profiles?.wallet_address?.trim() ?? null).filter((w) => !!w && /^0x[a-fA-F0-9]{40}$/.test(w))
        )
      );
      const reclaimed = [];
      const failed = [];
      for (const w of wallets) {
        try {
          const wallet = getAddress2(w);
          const balance = await getAeChainBalance(wallet);
          if (balance <= 0) continue;
          const txHash = await adminReclaimAe(wallet, balance);
          if (txHash) reclaimed.push({ wallet: w, amount: balance, txHash });
        } catch (e) {
          failed.push({ wallet: w, error: errMsg(e) });
        }
      }
      return json2(response, 200, { reclaimed, failed });
    }
    if (action === "admin-rwa-reclaim") {
      if (!isAdminProfile(callerProfile)) {
        return json2(response, 403, { error: "\u50C5\u9650\u7BA1\u7406\u54E1\u57F7\u884C" });
      }
      const placementId = String(body.placementId ?? "").trim();
      if (!placementId) return json2(response, 400, { error: "\u7F3A\u5C11 placementId" });
      const { data: placement, error: pErr } = await admin.from("private_placements").select("id").eq("id", placementId).maybeSingle();
      if (pErr) throw new Error(`\u67E5\u8A62\u6A19\uFFFD\uFFFD\u5931\u6557\uFF1A${pErr.message}`);
      const tokenAddress = placement ? await getCurrentRwaFactoryToken(placement.id) : null;
      if (!tokenAddress) {
        return json2(response, 200, { skipped: true, reason: "\u6B64\u6A19\u7684\u5728\u76EE\u524D Factory \u7121\u4EE3\u5E63" });
      }
      const { data: holders, error: holdErr } = await admin.from("holdings").select("user_id, profiles!inner(wallet_address)").eq("asset_id", placementId);
      if (holdErr) throw new Error(`\u67E5\u8A62\u6301\u6709\u4EBA\u5931\u6557\uFF1A${holdErr.message}`);
      const wallets = Array.from(
        new Set(
          (holders ?? []).map((h) => h.profiles?.wallet_address?.trim() ?? null).filter((w) => !!w && /^0x[a-fA-F0-9]{40}$/.test(w))
        )
      );
      const reclaimed = [];
      const failed = [];
      for (const w of wallets) {
        try {
          const wallet = getAddress2(w);
          const { balance } = await getWalletShareBalance(tokenAddress, wallet);
          if (balance <= 0) continue;
          const txHash = await reclaimRwaShare(getAddress2(tokenAddress), wallet, balance);
          if (txHash) reclaimed.push({ wallet: w, amount: balance, txHash });
        } catch (e) {
          failed.push({ wallet: w, error: errMsg(e) });
        }
      }
      return json2(response, 200, { reclaimed, failed });
    }
    if (action === "admin-asset-payout-check") {
      if (!isAdminProfile(callerProfile)) {
        return json2(response, 403, { error: "\u50C5\u9650\u7BA1\u7406\u54E1\u57F7\u884C" });
      }
      const requestKey2 = body.requestKey?.trim();
      if (!requestKey2 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey2)) {
        return json2(response, 400, { error: "\u6D3E\u767C\u8B58\u5225\u78BC\u7121\u6548" });
      }
      const refKey = `admin_payout:${requestKey2}`;
      const { data: settlement, error } = await admin.from("onchain_settlements").select("id,action,status,tx_hash,payload").eq("ref_key", refKey).maybeSingle();
      if (error || !settlement || settlement.action !== "admin_payout") {
        return json2(response, 404, { error: "\u627E\u4E0D\u5230\u500B\u5225\u6D3E\u767C\u7D00\u9304" });
      }
      const applyPayout = async (txHash) => {
        const { error: ledgerError } = await admin.rpc("admin_apply_asset_payout", { p_ref_key: refKey });
        if (ledgerError) {
          return json2(response, 500, {
            error: `\u93C8\u4E0A\uFFFD\uFFFD\u78BA\u8A8D\uFF0C\u4F46\u7DB2\u7AD9\u5E33\u672C\u540C\u6B65\u5931\u6557\uFF1B\u8ACB\u518D\u6B21\u67E5\u8A62\u4EE5\u91CD\u8A66\u540C\u6B65\u3002${ledgerError.message}`,
            status: "confirmed",
            tx_hash: txHash
          });
        }
        return json2(response, 200, { status: "confirmed", tx_hash: txHash });
      };
      if (settlement.status === "confirmed" && settlement.tx_hash) return applyPayout(settlement.tx_hash);
      if (settlement.status === "failed") {
        return json2(response, 200, { status: "failed", tx_hash: settlement.tx_hash });
      }
      if (!settlement.tx_hash) {
        return json2(response, 202, { status: "pending", tx_hash: null, message: "\u5C1A\u672A\u53D6\u5F97\u93C8\u4E0A\u4EA4\u6613\u96DC\u6E4A" });
      }
      try {
        const txHash = settlement.tx_hash;
        const confirmed = await waitForAdminAssetPayout(txHash);
        if (!confirmed) {
          await finish(admin, settlement.id, { status: "failed", tx_hash: txHash, error: "\u93C8\u4E0A\u4EA4\u6613 reverted" });
          return json2(response, 200, { status: "failed", tx_hash: txHash });
        }
        await finish(admin, settlement.id, { status: "confirmed", tx_hash: txHash });
        return applyPayout(txHash);
      } catch {
        return json2(response, 202, { status: "pending", tx_hash: settlement.tx_hash });
      }
    }
    if (action === "admin-asset-payout-history") {
      if (!isAdminProfile(callerProfile)) {
        return json2(response, 403, { error: "\u50C5\u9650\u7BA1\u7406\u54E1\u57F7\u884C" });
      }
      const { data: rows, error } = await admin.from("onchain_settlements").select("id,ref_key,user_id,asset_id,amount,tx_hash,status,error,payload,created_at,updated_at").eq("action", "admin_payout").order("created_at", { ascending: false }).limit(30);
      if (error) return json2(response, 500, { error: `\u6D3E\u767C\u7D00\u9304\u8B80\u53D6\u5931\u6557\uFF1A${error.message}` });
      const userIds = [...new Set((rows ?? []).map((row) => row.user_id).filter((id) => Boolean(id)))];
      const placementIds = [...new Set((rows ?? []).map((row) => row.asset_id).filter((id) => Boolean(id)))];
      const [profilesResult, placementsResult] = await Promise.all([
        userIds.length ? admin.from("profiles").select("id,email").in("id", userIds) : Promise.resolve({ data: [], error: null }),
        placementIds.length ? admin.from("private_placements").select("id,name").in("id", placementIds) : Promise.resolve({ data: [], error: null })
      ]);
      if (profilesResult.error || placementsResult.error) {
        return json2(response, 500, { error: "\u6D3E\u767C\u7D00\u9304\u95DC\u806F\u8CC7\u6599\u8B80\u53D6\u5931\u6557" });
      }
      const emailById = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile.email]));
      const placementById = new Map((placementsResult.data ?? []).map((placement) => [placement.id, placement.name]));
      return json2(response, 200, {
        payouts: (rows ?? []).map((row, index) => {
          const payload = row.payload;
          const assetType = String(payload.assetType ?? "");
          const placementId = payload.placementId ? String(payload.placementId) : null;
          const amount = String(payload.amount ?? row.amount ?? "0");
          const supersededBy = (rows ?? []).slice(0, index).find((newerRow) => {
            const newerPayload = newerRow.payload;
            return newerRow.status === "confirmed" && Boolean(newerRow.tx_hash) && newerRow.user_id === row.user_id && newerRow.asset_id === row.asset_id && newerPayload.assetType === assetType && String(newerPayload.amount ?? newerRow.amount ?? "0") === amount && (newerPayload.placementId ? String(newerPayload.placementId) : null) === placementId;
          });
          return {
            id: row.id,
            requestKey: row.ref_key.replace(/^admin_payout:/, ""),
            recipientId: row.user_id,
            recipientEmail: row.user_id ? emailById.get(row.user_id) ?? null : null,
            assetType,
            placementId,
            placementName: row.asset_id ? placementById.get(row.asset_id) ?? null : null,
            amount,
            status: row.status,
            txHash: row.tx_hash,
            error: row.error,
            accounted: payload.accounted === true,
            superseded: Boolean(supersededBy),
            createdAt: row.created_at,
            updatedAt: row.updated_at
          };
        }).slice(0, 5)
      });
    }
    if (action === "admin-asset-payout") {
      if (!isAdminProfile(callerProfile)) {
        return json2(response, 403, { error: "\u50C5\u9650\u7BA1\u7406\u54E1\u57F7\u884C" });
      }
      const input = body;
      const recipientId = input.recipientId?.trim();
      const assetType = input.assetType;
      const amount = input.amount?.trim();
      const placementId = input.placementId?.trim() || null;
      const requestKey2 = input.requestKey?.trim();
      if (!recipientId || !amount || !requestKey2 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey2)) {
        return json2(response, 400, { error: "\u6D3E\u767C\u8CC7\u6599\u4E0D\u5B8C\u6574\uFF0C\u8ACB\u91CD\u65B0\u64CD\u4F5C" });
      }
      if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(amount) || !(Number(amount) > 0) || Number(amount) > 1e12) {
        return json2(response, 400, { error: "\u6578\u91CF\u9808\u5927\uFFFD\uFFFD 0\uFF0C\u4E14\u6700\u591A\u8F38\u5165 6 \u4F4D\u5C0F\u6578" });
      }
      if (!["jc", "ae", "rwa", "usdt"].includes(String(assetType))) {
        return json2(response, 400, { error: "\u4E0D\u652F\u63F4\u7684\u6D3E\u767C\u8CC7\u7522" });
      }
      if (assetType === "rwa" && !/^\d+$/.test(amount)) {
        return json2(response, 400, { error: "RWA \u4EFD\u984D\u6D3E\u767C\u50C5\u652F\u63F4\u6574\u6578" });
      }
      if ((assetType === "rwa" || assetType === "ae") !== Boolean(placementId)) {
        return json2(response, 400, { error: "\u8ACB\u9078\u64C7\u8981\u8A18\u5165\u7DB2\u7AD9\u6301\u5009\u7684\u6A19\u7684" });
      }
      const { data: recipient } = await admin.from("profiles").select("id,email,agency_role,wallet_address").eq("id", recipientId).maybeSingle();
      if (!recipient || !String(recipient.agency_role ?? "").includes("\u4EE3\u7406")) {
        return json2(response, 404, { error: "\u627E\u4E0D\u5230\u6709\u6548\u7684\u4EE3\u7406\u5E33\u865F" });
      }
      let wallet;
      try {
        wallet = toAddress(recipient.wallet_address, "\u4EE3\u7406\u5E33\u865F");
      } catch (e) {
        return json2(response, 422, { error: errMsg(e) });
      }
      let tokenAddress;
      let assetLabel;
      let ledgerAssetId = null;
      if (assetType === "jc") {
        tokenAddress = RELAYER_ADDRESSES.jcToken;
        assetLabel = "JC";
      } else if (assetType === "ae") {
        const { data: placement } = await admin.from("private_placements").select("id,name,is_ae_token").eq("id", placementId).maybeSingle();
        if (!placement?.is_ae_token) return json2(response, 422, { error: "\u6240\u9078\u7DB2\u7AD9\u6A19\u7684\u4E0D\u662F AE \u6A19\u7684" });
        tokenAddress = RELAYER_ADDRESSES.aeToken;
        assetLabel = `AE\uFF08${placement.name}\uFF09`;
        ledgerAssetId = placement.id;
      } else if (assetType === "rwa") {
        const { data: placement } = await admin.from("private_placements").select("id,name,is_ae_token").eq("id", placementId).maybeSingle();
        const rwaToken = placement && !placement.is_ae_token ? await getCurrentRwaFactoryToken(placement.id) : null;
        if (!placement || placement.is_ae_token || !rwaToken) {
          return json2(response, 422, { error: "\u6240\u9078 RWA \u6A19\u7684\u5C1A\u672A\u90E8\u7F72\u6709\u6548\u7684\u5C08\u5C6C\u4EE3\u5E63" });
        }
        tokenAddress = rwaToken;
        assetLabel = `RWA\uFF08${placement.name}\uFF09`;
        ledgerAssetId = placement.id;
      } else {
        tokenAddress = RELAYER_ADDRESSES.usdt;
        assetLabel = "USDT";
      }
      const refKey = `admin_payout:${requestKey2}`;
      const payload = { assetType, amount, wallet, tokenAddress, placementId };
      let { data: settlement } = await admin.from("onchain_settlements").select("id,action,status,tx_hash,user_id,asset_id,payload").eq("ref_key", refKey).maybeSingle();
      let isNewSettlement = false;
      if (settlement) {
        const saved = settlement.payload;
        if (settlement.action !== "admin_payout" || settlement.user_id !== recipientId || settlement.asset_id !== ledgerAssetId || saved.assetType !== assetType || saved.amount !== amount || saved.placementId !== placementId || saved.wallet !== wallet || saved.tokenAddress !== tokenAddress) {
          return json2(response, 409, { error: "\u6B64\u6D3E\u767C\u8B58\u5225\u78BC\u5DF2\u7528\u65BC\u5176\u4ED6\u8CC7\u6599\uFF0C\u8ACB\u91CD\u65B0\u64CD\u4F5C" });
        }
      } else {
        const inserted = await admin.from("onchain_settlements").insert({
          action: "admin_payout",
          ref_key: refKey,
          user_id: recipientId,
          counterparty_id: caller.id,
          asset_id: ledgerAssetId,
          amount: Number(amount),
          status: "pending",
          payload
        }).select("id,action,status,tx_hash,user_id,asset_id,payload").single();
        settlement = inserted.data;
        if (inserted.error || !settlement) {
          const raced = await admin.from("onchain_settlements").select("id,action,status,tx_hash,user_id,asset_id,payload").eq("ref_key", refKey).maybeSingle();
          if (!raced.data) {
            return json2(response, 500, { error: `\u7121\u6CD5\u5EFA\u7ACB\u6D3E\u767C\u7A3D\u6838\u7D00\u9304\uFF1A${inserted.error?.message ?? "\u672A\u77E5\u8CC7\u6599\u5EAB\u932F\u8AA4"}` });
          }
          settlement = raced.data;
          const saved = settlement.payload;
          if (settlement.action !== "admin_payout" || settlement.user_id !== recipientId || settlement.asset_id !== ledgerAssetId || saved.amount !== amount || saved.wallet !== wallet || saved.assetType !== assetType || saved.placementId !== placementId || saved.tokenAddress !== tokenAddress) {
            return json2(response, 409, { error: "\u6B64\u6D3E\u767C\u8B58\u5225\u78BC\u5DF2\u7528\u65BC\u5176\u4ED6\u8CC7\u6599\uFF0C\u8ACB\u91CD\u65B0\u64CD\u4F5C" });
          }
        } else {
          isNewSettlement = true;
        }
      }
      const applyPayoutToWebsite = async (txHash2) => {
        const { error } = await admin.rpc("admin_apply_asset_payout", { p_ref_key: refKey });
        if (error) {
          return json2(response, 500, {
            error: `\u93C8\u4E0A\u5DF2\u6210\u529F\u8F49\u5E33\uFF08${txHash2}\uFF09\uFF0C\u4F46\u7DB2\u7AD9\u5E33\u672C\u540C\u6B65\u5931\u6557\uFF1B\u8ACB\u4F7F\u7528\u540C\u4E00\u7B46\u6D3E\u767C\u91CD\u8A66\u540C\u6B65\u3002${error.message}`,
            status: "confirmed",
            tx_hash: txHash2,
            requestKey: requestKey2
          });
        }
        return json2(response, 200, { status: "confirmed", tx_hash: txHash2, assetType, amount, wallet, requestKey: requestKey2 });
      };
      if (settlement.status === "confirmed" && settlement.tx_hash) {
        return applyPayoutToWebsite(settlement.tx_hash);
      }
      if (settlement.status === "pending" && settlement.tx_hash) {
        try {
          const confirmed = await waitForAdminAssetPayout(settlement.tx_hash);
          if (confirmed) {
            await finish(admin, settlement.id, { status: "confirmed", tx_hash: settlement.tx_hash });
            return applyPayoutToWebsite(settlement.tx_hash);
          }
          await finish(admin, settlement.id, { status: "failed", tx_hash: settlement.tx_hash, error: "\u93C8\u4E0A\u4EA4\u6613 reverted" });
          settlement.status = "failed";
        } catch {
          return json2(response, 202, { status: "pending", tx_hash: settlement.tx_hash, assetType, amount, wallet, requestKey: requestKey2 });
        }
      } else if (settlement.status === "pending" && !isNewSettlement) {
        return json2(response, 202, { status: "pending", assetType, amount, wallet, requestKey: requestKey2 });
      }
      if (!await guardRelayerGas(response)) return;
      let txHash;
      try {
        txHash = await sendAdminAssetPayout({ tokenAddress, recipient: wallet, amount, label: assetLabel });
      } catch (e) {
        await finish(admin, settlement.id, { status: "failed", error: errMsg(e) });
        return json2(response, 502, { error: `\u71B1\u9322\u5305\u6D3E\u767C\u5931\u6557\uFF1A${errMsg(e)}` });
      }
      const savedTx = await admin.from("onchain_settlements").update({ status: "pending", tx_hash: txHash, error: null, updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", settlement.id);
      if (savedTx.error) {
        return json2(response, 500, { error: `\u4EA4\u6613\u5DF2\u9001\u51FA\u4F46\u7121\u6CD5\u5132\u5B58\u4EA4\u6613\u96DC\u6E4A\uFF1A${txHash}`, tx_hash: txHash, status: "pending", requestKey: requestKey2 });
      }
      try {
        const confirmed = await waitForAdminAssetPayout(txHash);
        if (!confirmed) {
          await finish(admin, settlement.id, { status: "failed", tx_hash: txHash, error: "\u93C8\u4E0A\u4EA4\u6613 reverted" });
          return json2(response, 502, { error: `\u93C8\u4E0A\u8F49\u5E33\u5931\u6557\uFF1A${txHash}`, tx_hash: txHash, status: "failed" });
        }
      } catch {
        return json2(response, 202, { status: "pending", tx_hash: txHash, assetType, amount, wallet, requestKey: requestKey2 });
      }
      await finish(admin, settlement.id, { status: "confirmed", tx_hash: txHash });
      return applyPayoutToWebsite(txHash);
    }
    if (action === "admin-create-rwa-token") {
      if (!isAdminProfile(callerProfile)) {
        return json2(response, 403, { error: "\u50C5\u9650\u7BA1\u7406\u54E1\u57F7\u884C" });
      }
      const placementId = body.placementId;
      if (!placementId) return json2(response, 400, { error: "\u7F3A\u5C11 placementId" });
      const { data: placement } = await admin.from("private_placements").select("id,name,token_name,token_symbol,token_decimals,total_supply,is_ae_token").eq("id", placementId).maybeSingle();
      if (!placement) return json2(response, 404, { error: "\u627E\u4E0D\u5230\u5C0D\u61C9\u7684\u6A19\u7684" });
      if (placement.is_ae_token) return json2(response, 422, { error: "AE \u4EE3\u5E63\u4E0D\u4F7F\u7528 RWA Factory" });
      const existingAddr = await getCurrentRwaFactoryToken(placementId);
      if (existingAddr) {
        await admin.from("private_placements").update({ token_address: existingAddr }).eq("id", placementId);
        return json2(response, 200, { tokenAddress: existingAddr, alreadyExisted: true });
      }
      const symbol = String(placement.token_symbol ?? "").trim();
      if (!symbol) return json2(response, 422, { error: "\u8ACB\u5148\u5728\u7DE8\u8F2F\u5668\u586B\u5BEB\u4E26\u5132\u5B58\u300C\u4EE3\u5E63\u7B26\u865F\uFF08Token Symbol\uFF09\u300D" });
      const name = String(placement.token_name ?? placement.name ?? "").trim();
      if (!name) return json2(response, 422, { error: "\u8ACB\u5148\u5728\u7DE8\u8F2F\u5668\u586B\u5BEB\u4E26\u5132\u5B58\u300C\u4EE3\u5E63\u540D\u7A31\uFF08Token Name\uFF09\u300D" });
      const decimals = placement.token_decimals == null ? 18 : Number(placement.token_decimals);
      const totalSupply = Number(placement.total_supply);
      if (!(totalSupply > 0)) return json2(response, 422, { error: "\u6B64\u6A19\u7684\u7684\u7E3D\u4F9B\u7D66\u91CF\u7121\u6548" });
      if (!await guardRelayerGas(response)) return;
      try {
        const result = await createRwaFactoryToken(placementId, name, symbol, decimals, totalSupply);
        await admin.from("private_placements").update({ token_address: result.tokenAddress }).eq("id", placementId);
        await admin.from("onchain_settlements").insert({
          action: "create_rwa_token",
          ref_key: `create_rwa_token:${placementId}`,
          user_id: caller.id,
          asset_id: placementId,
          status: "confirmed",
          tx_hash: result.txHash.startsWith("0x") ? result.txHash : null,
          payload: { tokenAddress: result.tokenAddress, alreadyExisted: result.alreadyExisted }
        });
        return json2(response, 200, { tokenAddress: result.tokenAddress, txHash: result.txHash, alreadyExisted: result.alreadyExisted });
      } catch (e) {
        return json2(response, 502, { error: `\u5EFA\u7ACB RWA \u4EE3\u5E63\u5931\u6557\uFF1A${errMsg(e)}` });
      }
    }
    const LEDGER_ANCHORED_ACTIONS = /* @__PURE__ */ new Set(["mint-jc", "subscribe"]);
    const requestKey = body.requestKey;
    if (LEDGER_ANCHORED_ACTIONS.has(action) && (!requestKey || requestKey.length < 8)) {
      return json2(response, 400, { error: "\u7F3A\u5C11\u6709\u6548\u7684 requestKey" });
    }
    if (action === "sponsor-gas") {
      let wallet;
      try {
        wallet = toAddress(callerProfile.wallet_address, "\u4F7F\u7528\u8005\u5E33\u865F");
      } catch {
        return json2(response, 400, { error: "\u627E\u4E0D\u5230\u4F60\u7684\u9322\u5305\u5730\u5740\uFF0C\u8ACB\u91CD\u65B0\u767B\u5165" });
      }
      try {
        const result = await sponsorUserGas(wallet);
        return json2(response, 200, result);
      } catch (e) {
        return json2(response, 502, { error: errMsg(e) });
      }
    }
    if (action === "sync-holding") {
      const placementId = body.placementId;
      if (!placementId) return json2(response, 400, { error: "\u7F3A\u5C11 placementId" });
      const { data: placement } = await admin.from("private_placements").select("id,token_address,is_ae_token,is_delisted").eq("id", placementId).maybeSingle();
      if (!placement) return json2(response, 404, { error: "\u627E\u4E0D\u5230\u5C0D\u61C9\u7684\u6A19\u7684" });
      if (placement.is_ae_token) return json2(response, 200, { synced: false, skipped: "ae" });
      const tokenAddress = await getCurrentRwaFactoryToken(placement.id);
      if (!tokenAddress) return json2(response, 200, { synced: false, skipped: "no-current-token" });
      let wallet;
      try {
        wallet = toAddress(callerProfile.wallet_address, "\u4F7F\u7528\u8005\u5E33\u865F");
      } catch {
        return json2(response, 200, { synced: false, skipped: "no-wallet" });
      }
      let onChain = 0;
      try {
        const bal = await getWalletShareBalance(tokenAddress, wallet);
        onChain = Math.floor(bal.balance);
      } catch (e) {
        return json2(response, 200, { synced: false, skipped: "read-failed", detail: errMsg(e) });
      }
      const { data: holdingRow } = await admin.from("holdings").select("quantity").eq("user_id", caller.id).eq("asset_id", placementId).maybeSingle();
      const ledgerQty = Number(holdingRow?.quantity ?? 0);
      if (onChain > ledgerQty + 1e-9) {
        const { error: upsertErr } = await admin.from("holdings").upsert(
          { user_id: caller.id, asset_id: placementId, quantity: onChain, updated_at: (/* @__PURE__ */ new Date()).toISOString() },
          { onConflict: "user_id,asset_id" }
        );
        if (upsertErr) return json2(response, 500, { error: "\u540C\u6B65\u6301\u6709\u4EFD\u984D\u5931\u6557\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66" });
        return json2(response, 200, { synced: true, from: ledgerQty, to: onChain, onChain });
      }
      return json2(response, 200, { synced: false, ledgerQty, onChain });
    }
    if (action === "mint-jc") {
      const { data: ledgerRow } = await admin.from("jc_ledger").select("id,user_id,amount,entry_type").eq("idempotency_key", `${requestKey}:jc`).eq("entry_type", "vault_buy").maybeSingle();
      if (!ledgerRow || ledgerRow.user_id !== caller.id) {
        return json2(response, 404, { error: "\u627E\u4E0D\u5230\u5C0D\u61C9\u7684\u8CFC\u8CB7 JC \u7D00\u9304" });
      }
      return settleMintJcCore(admin, response, ledgerRow);
    }
    if (action === "subscribe") {
      const { data: ledgerRow } = await admin.from("jc_ledger").select("id,user_id,asset_id,quantity,amount,metadata").eq("idempotency_key", requestKey).eq("entry_type", "private_purchase").maybeSingle();
      if (!ledgerRow || ledgerRow.user_id !== caller.id) {
        return json2(response, 404, { error: "\u627E\u4E0D\u5230\u5C0D\u61C9\u7684\u8A8D\u8CFC\u7D00\u9304" });
      }
      return settleSubscribeCore(admin, response, ledgerRow);
    }
    if (action === "redeem-jc") {
      const orderId = body.orderId;
      if (!orderId) return json2(response, 400, { error: "\u7F3A\u5C11 orderId" });
      const { data: order } = await admin.from("redemption_orders").select("id,user_id,wallet_address,jc_amount,usdt_amount,status").eq("id", orderId).maybeSingle();
      if (!order) return json2(response, 404, { error: "\u627E\u4E0D\u5230\u8D16\u56DE\u8A02\u55AE" });
      if (order.user_id !== caller.id && !isAdminProfile(callerProfile)) {
        return json2(response, 403, { error: "\u53EA\u6709\u672C\u4EBA\u6216\u7BA1\u7406\u54E1\u53EF\u89F8\u767C\u6B64\u8D16\u56DE\u7D50\u7B97" });
      }
      if (order.status !== "pending") {
        return json2(response, 200, { status: order.status, idempotent: true });
      }
      return settleRedemptionCore(admin, response, order);
    }
    if (action === "settle-commissions") {
      if (!isAdminProfile(callerProfile)) {
        return json2(response, 403, { error: "\u50C5\u9650\u7BA1\u7406\u54E1\u57F7\u884C" });
      }
      const ids = body.beneficiaryIds;
      const filter = Array.isArray(ids) && ids.length > 0 ? ids : void 0;
      const summary = await sweepPendingCommissions(admin, 300, filter);
      return json2(response, 200, summary);
    }
    if (action === "commission-reverse") {
      if (!isAdminProfile(callerProfile)) {
        return json2(response, 403, { error: "\u50C5\u9650\u7BA1\u7406\u54E1\u57F7\u884C" });
      }
      const ids = body.beneficiaryIds;
      if (!Array.isArray(ids) || ids.length === 0) {
        return json2(response, 400, { error: "\u7F3A\u5C11\u8981\u6C96\u6B63\u7684\u53D7\u76CA\u4EBA" });
      }
      const results = [];
      for (const id of ids) {
        try {
          results.push(await reverseCommissionForBeneficiary(admin, id));
        } catch (e) {
          results.push({ beneficiaryId: id, applied: false, direction: "none", amount: 0, error: errMsg(e) });
        }
      }
      return json2(response, 200, { results });
    }
    if (action === "admin-list-settlements") {
      if (!isAdminProfile(callerProfile)) {
        return json2(response, 403, { error: "\u50C5\u9650\u7BA1\u7406\u54E1\u57F7\u884C" });
      }
      const items = await findAttentionCandidates(admin);
      const userIds = [...new Set(items.map((i) => i.userId))];
      const assetIds = [...new Set(items.map((i) => i.assetId).filter(Boolean))];
      const [profilesResult, placementsResult] = await Promise.all([
        userIds.length ? admin.from("profiles").select("id,email,nickname,display_name").in("id", userIds) : Promise.resolve({ data: [] }),
        assetIds.length ? admin.from("private_placements").select("id,name").in("id", assetIds) : Promise.resolve({ data: [] })
      ]);
      const profileById = new Map((profilesResult.data ?? []).map((p) => [p.id, p]));
      const placementById = new Map((placementsResult.data ?? []).map((a) => [a.id, a]));
      const enriched = items.map((item) => {
        const profile = profileById.get(item.userId);
        const placement = item.assetId ? placementById.get(item.assetId) : null;
        return {
          ...item,
          userLabel: profile?.nickname || profile?.display_name || profile?.email || item.userId,
          assetName: placement?.name ?? (item.assetId ? item.assetId : null)
        };
      }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return json2(response, 200, { items: enriched });
    }
    if (action === "admin-retry-settlement") {
      if (!isAdminProfile(callerProfile)) {
        return json2(response, 403, { error: "\u50C5\u9650\u7BA1\u7406\u54E1\u57F7\u884C" });
      }
      const payload = body;
      let settleAction;
      let ledgerRowId;
      if (payload.settlementId) {
        const { data: settlement } = await admin.from("onchain_settlements").select("id,action,ref_key,status,tx_hash,updated_at,created_at").eq("id", payload.settlementId).maybeSingle();
        if (!settlement) return json2(response, 404, { error: "\u627E\u4E0D\u5230\u7D50\u7B97\u7D00\u9304" });
        if (settlement.action === "trade" || settlement.action === "list_fee") {
          return json2(response, 410, { error: "\u820A\u4E8C\u7D1A\u5E02\u5834\u7D50\u7B97\u7D00\u9304\u50C5\u4FDD\u7559\u6B77\u53F2\uFF0C\u4E0D\u518D\u63D0\u4F9B relayer \u88DC\u767C\u3002" });
        }
        if (settlement.status === "confirmed") {
          return json2(response, 200, { status: "confirmed", tx_hash: settlement.tx_hash, idempotent: true });
        }
        if (settlement.status === "cancelled") {
          return json2(response, 200, { status: "cancelled", idempotent: true });
        }
        if (settlement.status === "pending") {
          const ageMs = Date.now() - new Date(settlement.updated_at ?? settlement.created_at).getTime();
          if (ageMs < 2 * 60 * 1e3) {
            return json2(response, 409, { error: "\u6B64\u7B46\u7D50\u7B97\u4ECD\u5728\u8655\u7406\u4E2D\uFF0C\u8ACB\u7A0D\u5019\u518D\u8A66" });
          }
          await admin.from("onchain_settlements").update({ status: "failed", error: "\u7BA1\u7406\u54E1\u5224\u5B9A\u903E\u6642\u5361\u55AE\uFF0C\u5DF2\u8F49\u70BA\u5931\u6557\u4EE5\u4FBF\u91CD\u8A66", updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", settlement.id);
        }
        settleAction = settlement.action;
        ledgerRowId = settlement.ref_key.slice(settleAction.length + 1);
      } else if (payload.ledgerRowId && (payload.ledgerAction === "mint_jc" || payload.ledgerAction === "subscribe" || payload.ledgerAction === "redeem")) {
        settleAction = payload.ledgerAction;
        ledgerRowId = payload.ledgerRowId;
      } else {
        return json2(response, 400, { error: "\u7F3A\u5C11 settlementId \u6216 ledgerAction+ledgerRowId" });
      }
      return retrySettlementByAction(admin, response, settleAction, ledgerRowId);
    }
    return json2(response, 400, { error: `\u672A\u77E5\u7684 action: ${action}` });
  } catch (e) {
    return json2(response, 500, { error: errMsg(e) });
  }
}
async function findAttentionCandidates(admin) {
  const STALE_MS = 2 * 60 * 1e3;
  const staleBefore = new Date(Date.now() - STALE_MS).toISOString();
  const redeemOrphanBefore = new Date(Date.now() - 30 * 1e3).toISOString();
  const [vaultRows, subRows, redeemRows, failedOrStale] = await Promise.all([
    admin.from("jc_ledger").select("id,user_id,amount,created_at").eq("entry_type", "vault_buy").not("idempotency_key", "is", null).order("created_at", { ascending: false }).limit(300),
    admin.from("jc_ledger").select("id,user_id,asset_id,amount,created_at").eq("entry_type", "private_purchase").not("idempotency_key", "is", null).order("created_at", { ascending: false }).limit(300),
    // JC 贖回：redemption_orders 仍是 pending（表示使用者的 redeem-jc 呼叫從未
    // 成功觸發結算，例如送出後關閉瀏覽器），交給 cron sweep／管理員補發。
    admin.from("redemption_orders").select("id,user_id,jc_amount,created_at").eq("status", "pending").lt("created_at", redeemOrphanBefore).order("created_at", { ascending: false }).limit(300),
    admin.from("onchain_settlements").select("id,action,ref_key,user_id,asset_id,amount,payment,status,error,tx_hash,created_at,updated_at").in("action", ["mint_jc", "subscribe", "redeem"]).or(`status.eq.failed,and(status.eq.pending,updated_at.lt.${staleBefore})`).order("created_at", { ascending: false }).limit(200)
  ]);
  const ledgerByAction = {
    mint_jc: vaultRows.data ?? [],
    subscribe: subRows.data ?? [],
    redeem: (redeemRows.data ?? []).map(
      (r) => ({ id: r.id, user_id: r.user_id, asset_id: null, amount: Number(r.jc_amount), created_at: r.created_at })
    )
  };
  const candidateRefKeys = Object.entries(ledgerByAction).flatMap(([act, rows]) => rows.map((r) => `${act}:${r.id}`));
  const { data: existingSettlements } = candidateRefKeys.length ? await admin.from("onchain_settlements").select("ref_key").in("ref_key", candidateRefKeys) : { data: [] };
  const hasSettlement = new Set((existingSettlements ?? []).map((r) => r.ref_key));
  const orphans = Object.entries(ledgerByAction).flatMap(
    ([act, rows]) => rows.filter((r) => !hasSettlement.has(`${act}:${r.id}`)).map((r) => ({
      id: null,
      action: act,
      ledgerRowId: r.id,
      userId: r.user_id,
      assetId: r.asset_id ?? null,
      amount: Number(r.amount),
      status: "orphan",
      error: "\u4F7F\u7528\u8005\u5DF2\u6263\u6B3E\uFF0C\u4F46\u5F9E\u672A\u6536\u5230\u4EFB\u4F55\u93C8\u4E0A\u7D50\u7B97\u8ACB\u6C42\uFF08\u53EF\u80FD\u662F\u700F\u89BD\u5668\u95DC\u9589\u6216\u7DB2\u8DEF\u4E2D\u65B7\uFF09",
      createdAt: r.created_at
    }))
  );
  const attentionNeeded = (failedOrStale.data ?? []).map((row) => ({
    id: row.id,
    action: row.action,
    ledgerRowId: row.ref_key.slice(String(row.action).length + 1),
    userId: row.user_id,
    assetId: row.asset_id ?? null,
    amount: row.amount == null ? null : Number(row.amount),
    payment: row.payment == null ? null : Number(row.payment),
    status: row.status === "failed" ? "failed" : "stale_pending",
    error: row.error ?? null,
    txHash: row.tx_hash ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
  const combined = [...attentionNeeded, ...orphans];
  const assetIdsToCheck = [
    ...new Set(combined.filter((i) => i.assetId && i.action !== "mint_jc").map((i) => i.assetId))
  ];
  if (assetIdsToCheck.length) {
    const { data: placementFlags } = await admin.from("private_placements").select("id,is_delisted,is_active").in("id", assetIdsToCheck);
    const inactiveAssetIds = new Set(
      (placementFlags ?? []).filter((p) => p.is_delisted || p.is_active === false).map((p) => p.id)
    );
    if (inactiveAssetIds.size) {
      return combined.filter((i) => !(i.assetId && inactiveAssetIds.has(i.assetId)));
    }
  }
  return combined;
}
function fakeResponse() {
  let body = null;
  const stub = {
    statusCode: 0,
    setHeader() {
    },
    end(data) {
      body = data ? JSON.parse(data) : null;
    }
  };
  return {
    response: stub,
    read: () => ({ status: stub.statusCode, body })
  };
}
async function retrySettlementByAction(admin, response, settleAction, ledgerRowId) {
  if (settleAction === "mint_jc") {
    const { data: ledgerRow } = await admin.from("jc_ledger").select("id,user_id,amount").eq("id", ledgerRowId).eq("entry_type", "vault_buy").maybeSingle();
    if (!ledgerRow) return json2(response, 404, { error: "\u627E\u4E0D\u5230\u5C0D\u61C9\u7684\u8CFC\u8CB7 JC \u7D00\u9304" });
    return settleMintJcCore(admin, response, ledgerRow);
  }
  if (settleAction === "subscribe") {
    const { data: ledgerRow } = await admin.from("jc_ledger").select("id,user_id,asset_id,quantity,amount,metadata").eq("id", ledgerRowId).eq("entry_type", "private_purchase").maybeSingle();
    if (!ledgerRow) return json2(response, 404, { error: "\u627E\u4E0D\u5230\u5C0D\u61C9\u7684\u8A8D\u8CFC\u7D00\u9304" });
    return settleSubscribeCore(admin, response, ledgerRow);
  }
  if (settleAction === "redeem") {
    const { data: order } = await admin.from("redemption_orders").select("id,user_id,wallet_address,jc_amount,usdt_amount,status").eq("id", ledgerRowId).maybeSingle();
    if (!order) return json2(response, 404, { error: "\u627E\u4E0D\u5230\u5C0D\u61C9\u7684\u8D16\u56DE\u8A02\u55AE" });
    if (order.status !== "pending") {
      return json2(response, 200, { status: order.status, idempotent: true });
    }
    return settleRedemptionCore(admin, response, order);
  }
  return json2(response, 410, { error: "\u820A\u4E8C\u7D1A\u5E02\u5834 relayer \u7D50\u7B97\u5DF2\u505C\u7528\uFF1B\u8ACB\u4F7F\u7528 P2PEscrow \u8A17\u7BA1\u6210\u4EA4\u7D00\u9304\u3002" });
}
async function sweepStuckSettlements(admin, limit) {
  const allItems = await findAttentionCandidates(admin);
  const items = typeof limit === "number" ? allItems.slice(0, limit) : allItems;
  const stillFailing = [];
  let attempted = 0;
  let fixed = 0;
  for (const item of items) {
    if (item.status === "stale_pending") {
      const ageMs = Date.now() - new Date(item.updatedAt ?? item.createdAt).getTime();
      if (ageMs < 2 * 60 * 1e3) continue;
      await admin.from("onchain_settlements").update({ status: "failed", error: "cron sweep \u5224\u5B9A\u903E\u6642\u5361\u55AE\uFF0C\u5DF2\u8F49\u70BA\u5931\u6557\u4EE5\u4FBF\u91CD\u8A66", updated_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", item.id);
    }
    attempted += 1;
    const { response, read } = fakeResponse();
    try {
      await retrySettlementByAction(admin, response, item.action, item.ledgerRowId);
      const { status, body } = read();
      if (status >= 200 && status < 300) {
        fixed += 1;
      } else {
        const errorValue = body && typeof body === "object" && "error" in body ? body.error : void 0;
        const message = typeof errorValue === "string" && errorValue ? errorValue : `HTTP ${status}`;
        stillFailing.push({ ledgerRowId: item.ledgerRowId, action: item.action, error: message });
      }
    } catch (e) {
      stillFailing.push({ ledgerRowId: item.ledgerRowId, action: item.action, error: errMsg(e) });
    }
  }
  return { attempted, fixed, stillFailing };
}
function errMsg(e) {
  if (e && typeof e === "object" && "shortMessage" in e && typeof e.shortMessage === "string") {
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}
async function maybeOpportunisticSweep(admin) {
  try {
    const { data: claimed, error } = await admin.rpc("claim_sweep_slot", {
      p_key: "settle-sweep",
      p_min_interval_seconds: 90
    });
    if (error || claimed !== true) return;
    await sweepStuckSettlements(admin, 4).catch(() => {
    });
    await sweepPendingCommissions(admin, 8).catch(() => {
    });
  } catch {
  }
}
var ADMIN_ROLES, isAdminProfile, LEGACY_RECLAIM_CUTOFF, LEGACY_RECLAIM_ENTRY_TYPES, LEDGER_SCALE, AE_LEGACY_ASSET_KEY;
var init_relayer = __esm({
  "api/relayer.ts"() {
    init_onchain();
    ADMIN_ROLES = /* @__PURE__ */ new Set(["\u7BA1\u7406\u54E1", "admin", "super_admin"]);
    isAdminProfile = (profile) => ADMIN_ROLES.has(String(profile.agency_role ?? "")) || ["admin", "super_admin"].includes(String(profile.role ?? ""));
    LEGACY_RECLAIM_CUTOFF = "2026-10-04T00:00:00+08:00";
    LEGACY_RECLAIM_ENTRY_TYPES = ["private_purchase", "p2p_buy", "p2p_sell"];
    LEDGER_SCALE = 18;
    AE_LEGACY_ASSET_KEY = "legacy-ae";
  }
});

// api/translate.ts
var translate_exports = {};
__export(translate_exports, {
  config: () => config,
  default: () => handler3
});
import { generateText, Output } from "file:///vercel/share/v0-project/node_modules/.pnpm/ai@7.0.127_zod@4.6.5/node_modules/ai/dist/index.js";
import { z } from "file:///vercel/share/v0-project/node_modules/.pnpm/zod@4.6.5/node_modules/zod/index.js";
async function handler3(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  if (!authorization.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: "Translation service unavailable" });
  const adminResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/is_current_user_admin`, {
    method: "POST",
    headers: { apikey: supabaseKey, Authorization: authorization, "Content-Type": "application/json" },
    body: "{}"
  });
  if (!adminResponse.ok || await adminResponse.json() !== true) return res.status(403).json({ error: "Forbidden" });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data.fields).length === 0) return res.status(400).json({ error: "Invalid content" });
  const requiredFields = parsed.data.kind === "asset" ? ["name", "location", "information"] : ["title", "content"];
  if (!requiredFields.every((field) => typeof parsed.data.fields[field] === "string")) return res.status(400).json({ error: "Missing fields" });
  const models = ["google/gemini-3.5-flash", "google/gemini-2.5-flash"];
  let lastError = "unknown error";
  for (const model of models) {
    try {
      const { output } = await generateText({
        model,
        output: Output.object({ schema: translationSchema }),
        prompt: `Translate the following Traditional Chinese ${parsed.data.kind} content into every target language. Return exactly all target language codes and exactly the original field keys. Every value whose source is non-empty must be a non-empty string; preserve an empty source value as an empty string. Preserve numbers, currency, property/project names, codes, URLs, paragraph breaks, and punctuation meaning. Do not add commentary.
Targets: ${languageCodes.map((code) => `${code}=${languageNames[code]}`).join(", ")}
Content: ${JSON.stringify(parsed.data.fields)}`
      });
      const complete = languageCodes.every(
        (code) => output.translations[code] && requiredFields.every((field) => {
          const sourceValue = parsed.data.fields[field]?.trim() ?? "";
          const value = output.translations[code][field];
          return typeof value === "string" && (!sourceValue || Boolean(value.trim())) && !value.includes("\uFFFD");
        })
      );
      if (!complete) throw new Error("Incomplete translation output");
      return res.status(200).json({ translations: { "zh-TW": parsed.data.fields, ...output.translations } });
    } catch (error) {
      lastError = error instanceof Error ? error.message : "unknown error";
    }
  }
  console.error("Translation generation failed after retry", lastError);
  return res.status(502).json({ error: "\u81EA\u52D5\u7FFB\u8B6F\u5931\u6557\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66" });
}
var languageCodes, languageNames, bodySchema, translatedFieldsSchema, translationSchema, config;
var init_translate = __esm({
  "api/translate.ts"() {
    languageCodes = ["zh-CN", "en", "ja", "ko", "th", "vi", "id", "ms", "es", "fr", "de", "pt", "ru", "ar", "hi"];
    languageNames = {
      "zh-CN": "Simplified Chinese",
      en: "English",
      ja: "Japanese",
      ko: "Korean",
      th: "Thai",
      vi: "Vietnamese",
      id: "Indonesian",
      ms: "Malay",
      es: "Spanish",
      fr: "French",
      de: "German",
      pt: "Portuguese",
      ru: "Russian",
      ar: "Arabic",
      hi: "Hindi"
    };
    bodySchema = z.object({
      kind: z.enum(["asset", "announcement"]),
      fields: z.record(z.enum(["name", "location", "information", "title", "content"]), z.string().max(5e3))
    });
    translatedFieldsSchema = z.object({
      name: z.string().optional(),
      location: z.string().optional(),
      information: z.string().optional(),
      title: z.string().optional(),
      content: z.string().optional()
    });
    translationSchema = z.object({
      translations: z.object(
        Object.fromEntries(
          languageCodes.map((code) => [code, translatedFieldsSchema])
        )
      )
    });
    config = { maxDuration: 60 };
  }
});

// vite.config.ts
import { defineConfig, loadEnv } from "file:///vercel/share/v0-project/node_modules/.pnpm/vite@5.4.21_@types+node@26.6.2/node_modules/vite/dist/node/index.js";
import react from "file:///vercel/share/v0-project/node_modules/.pnpm/@vitejs+plugin-react@4.7.0_vite@5.4.21_@types+node@26.6.2_/node_modules/@vitejs/plugin-react/dist/index.js";
import { fileURLToPath, URL as URL2 } from "node:url";
var __vite_injected_original_import_meta_url = "file:///vercel/share/v0-project/vite.config.ts";
function privySessionApiPlugin() {
  return {
    name: "privy-session-api",
    configureServer(server) {
      server.middlewares.use("/api/privy-session", async (req, res) => {
        try {
          const { default: handler4 } = await Promise.resolve().then(() => (init_privy_session(), privy_session_exports));
          await handler4(req, res);
        } catch (error) {
          console.error("[v0] privy-session dev middleware error:", error);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Privy session bridge crashed in dev" }));
          }
        }
      });
    }
  };
}
function relayerApiPlugin() {
  return {
    name: "relayer-api",
    configureServer(server) {
      server.middlewares.use("/api/relayer", async (req, res) => {
        try {
          const { default: handler4 } = await Promise.resolve().then(() => (init_relayer(), relayer_exports));
          await handler4(req, res);
        } catch (error) {
          console.error("[v0] relayer dev middleware error:", error);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Relayer bridge crashed in dev" }));
          }
        }
      });
    }
  };
}
function appVersionPlugin(appVersion) {
  return {
    name: "app-version",
    configurePreviewServer(server) {
      server.middlewares.use("/api/app-version", (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET, HEAD");
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.end(JSON.stringify({ version: appVersion }));
      });
    }
  };
}
function translationApiPlugin() {
  return {
    name: "translation-api",
    configureServer(server) {
      server.middlewares.use("/api/translate", async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const rawBody = Buffer.concat(chunks).toString("utf8");
        let body;
        try {
          body = rawBody ? JSON.parse(rawBody) : void 0;
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        const { default: handler4 } = await Promise.resolve().then(() => (init_translate(), translate_exports));
        const response = {
          status(code) {
            res.statusCode = code;
            return response;
          },
          json(value) {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(value));
          },
          setHeader(name, value) {
            res.setHeader(name, value);
          }
        };
        await handler4(
          {
            method: req.method,
            headers: req.headers,
            body
          },
          response
        );
      });
    }
  };
}
var vite_config_default = defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  Object.assign(process.env, env);
  const appVersion = env.VERCEL_DEPLOYMENT_ID || env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || "local";
  return {
    plugins: [react(), privySessionApiPlugin(), relayerApiPlugin(), translationApiPlugin(), appVersionPlugin(appVersion)],
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      "process.env.NEXT_PUBLIC_SUPABASE_URL": JSON.stringify(env.NEXT_PUBLIC_SUPABASE_URL),
      "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": JSON.stringify(env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      "process.env.NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL": JSON.stringify(env.NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL),
      "process.env.NEXT_PUBLIC_PRIVY_APP_ID": JSON.stringify(env.NEXT_PUBLIC_PRIVY_APP_ID)
    },
    resolve: {
      alias: {
        "@": fileURLToPath(new URL2("./src", __vite_injected_original_import_meta_url))
      }
    },
    optimizeDeps: {
      exclude: ["lucide-react"]
    },
    server: {
      host: "0.0.0.0",
      hmr: {
        protocol: "wss",
        clientPort: 443
      }
    }
  };
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiYXBpL3ByaXZ5LXNlc3Npb24udHMiLCAiYXBpL19yZWxheWVyTG9jay50cyIsICJhcGkvX29uY2hhaW4udHMiLCAiYXBpL3JlbGF5ZXIudHMiLCAiYXBpL3RyYW5zbGF0ZS50cyIsICJ2aXRlLmNvbmZpZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi92ZXJjZWwvc2hhcmUvdjAtcHJvamVjdC9hcGlcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi92ZXJjZWwvc2hhcmUvdjAtcHJvamVjdC9hcGkvcHJpdnktc2Vzc2lvbi50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vdmVyY2VsL3NoYXJlL3YwLXByb2plY3QvYXBpL3ByaXZ5LXNlc3Npb24udHNcIjtpbXBvcnQgdHlwZSB7IEluY29taW5nTWVzc2FnZSwgU2VydmVyUmVzcG9uc2UgfSBmcm9tIFwibm9kZTpodHRwXCI7XG5pbXBvcnQgeyBjcmVhdGVDbGllbnQgfSBmcm9tIFwiQHN1cGFiYXNlL3N1cGFiYXNlLWpzXCI7XG5cbi8vIGBqb3NlYCBpcyBFU00tb25seS4gQSBzdGF0aWMgYGltcG9ydCAuLi4gZnJvbSBcImpvc2VcImAgY29tcGlsZXMgdG9cbi8vIGByZXF1aXJlKFwiam9zZVwiKWAgaW4gdGhlIENvbW1vbkpTIHNlcnZlcmxlc3MgYnVuZGxlIHRoYXQgQHZlcmNlbC9ub2RlIGVtaXRzLFxuLy8gd2hpY2ggdGhyb3dzIEVSUl9SRVFVSVJFX0VTTSBhdCBjb2xkIHN0YXJ0IGFuZCBtYWtlcyBldmVyeSAvYXBpL3ByaXZ5LXNlc3Npb25cbi8vIGNhbGwgcmV0dXJuIEhUVFAgNTAwIFx1MjAxNCBzaWxlbnRseSBicmVha2luZyBuZXctdXNlciBzaWdudXAgaW4gcHJvZHVjdGlvbiB3aGlsZVxuLy8gd29ya2luZyBmaW5lIHVuZGVyIFZpdGUncyBFU00gZGV2IHNlcnZlci4gTG9hZCBpdCBsYXppbHkgdmlhIGR5bmFtaWNcbi8vIGltcG9ydCgpLCB3aGljaCB3b3JrcyBpbiBib3RoIENKUyBhbmQgRVNNIG91dHB1dC5cbnR5cGUgSm9zZU1vZHVsZSA9IHR5cGVvZiBpbXBvcnQoXCJqb3NlXCIpO1xubGV0IGpvc2VQcm9taXNlOiBQcm9taXNlPEpvc2VNb2R1bGU+IHwgbnVsbCA9IG51bGw7XG5jb25zdCBsb2FkSm9zZSA9ICgpID0+IChqb3NlUHJvbWlzZSA/Pz0gaW1wb3J0KFwiam9zZVwiKSk7XG5cbnR5cGUgTGlua2VkQWNjb3VudCA9IHtcbiAgdHlwZT86IHN0cmluZztcbiAgYWRkcmVzcz86IHN0cmluZztcbiAgZW1haWw/OiBzdHJpbmc7XG4gIHdhbGxldF9jbGllbnQ/OiBzdHJpbmc7XG4gIHdhbGxldF9jbGllbnRfdHlwZT86IHN0cmluZztcbiAgY2hhaW5fdHlwZT86IHN0cmluZztcbn07XG5cbmZ1bmN0aW9uIGpzb24ocmVzcG9uc2U6IFNlcnZlclJlc3BvbnNlLCBzdGF0dXM6IG51bWJlciwgcGF5bG9hZDogdW5rbm93bikge1xuICByZXNwb25zZS5zdGF0dXNDb2RlID0gc3RhdHVzO1xuICByZXNwb25zZS5zZXRIZWFkZXIoXCJDb250ZW50LVR5cGVcIiwgXCJhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04XCIpO1xuICByZXNwb25zZS5zZXRIZWFkZXIoXCJDYWNoZS1Db250cm9sXCIsIFwibm8tc3RvcmVcIik7XG4gIHJlc3BvbnNlLmVuZChKU09OLnN0cmluZ2lmeShwYXlsb2FkKSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlYWRCb2R5KHJlcXVlc3Q6IEluY29taW5nTWVzc2FnZSkge1xuICBsZXQgcmF3ID0gXCJcIjtcbiAgZm9yIGF3YWl0IChjb25zdCBjaHVuayBvZiByZXF1ZXN0KSB7XG4gICAgcmF3ICs9IGNodW5rO1xuICAgIGlmIChyYXcubGVuZ3RoID4gMzJfNzY4KSB0aHJvdyBuZXcgRXJyb3IoXCJQYXlsb2FkIHRvbyBsYXJnZVwiKTtcbiAgfVxuICByZXR1cm4gSlNPTi5wYXJzZShyYXcgfHwgXCJ7fVwiKSBhcyB7XG4gICAgaWRlbnRpdHlUb2tlbj86IHN0cmluZztcbiAgICBhY2Nlc3NUb2tlbj86IHN0cmluZztcbiAgICBlbWFpbD86IHN0cmluZztcbiAgICB3YWxsZXRBZGRyZXNzPzogc3RyaW5nO1xuICB9O1xufVxuXG5jb25zdCBpc0VtYWlsID0gKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgc3RyaW5nID0+XG4gIHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIiAmJiAvXlteXFxzQF0rQFteXFxzQF0rXFwuW15cXHNAXSskLy50ZXN0KHZhbHVlKTtcblxuY29uc3QgaXNBZGRyZXNzID0gKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgc3RyaW5nID0+XG4gIHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIiAmJiAvXjB4W2EtZkEtRjAtOV17NDB9JC8udGVzdCh2YWx1ZSk7XG5cbi8vIFByaXZ5IGlkZW50aXR5IHRva2VucyBhcmUgc2lnbmVkIHdpdGggdGhlIGFwcCdzIHB1YmxpYyBrZXksIHNvIHdlIGNhbiB2ZXJpZnlcbi8vIGVtYWlsICsgZW1iZWRkZWQgd2FsbGV0IGNsYWltcyB2aWEgdGhlIHB1YmxpYyBKV0tTIHdpdGhvdXQgYW55IGFwcCBzZWNyZXQuXG4vLyBGYWxscyBiYWNrIHRvIHRoZSBrbm93biBwcm9qZWN0IEFwcCBJRCB3aGVuIHRoZSBlbnYgdmFyIGlzbid0IG1pcnJvcmVkIGludG9cbi8vIHRoZSBsb2NhbCBkZXYgcHJvY2VzcyAoaXQgc3RpbGwgcmVhZHMgdGhlIGVudiB2YXIgZmlyc3QgaW4gcHJvZHVjdGlvbikuXG5jb25zdCBhcHBJZCA9IHByb2Nlc3MuZW52Lk5FWFRfUFVCTElDX1BSSVZZX0FQUF9JRCB8fCBcImNtdG9yeTNxdDAxZ2MwZGw4M2JiajRwY3dcIjtcbmxldCBqd2tzQ2FjaGU6IFJldHVyblR5cGU8Sm9zZU1vZHVsZVtcImNyZWF0ZVJlbW90ZUpXS1NldFwiXT4gfCBudWxsID0gbnVsbDtcbmFzeW5jIGZ1bmN0aW9uIGdldEp3a3MoKSB7XG4gIGlmICghYXBwSWQpIHJldHVybiBudWxsO1xuICBpZiAoIWp3a3NDYWNoZSkge1xuICAgIGNvbnN0IHsgY3JlYXRlUmVtb3RlSldLU2V0IH0gPSBhd2FpdCBsb2FkSm9zZSgpO1xuICAgIGp3a3NDYWNoZSA9IGNyZWF0ZVJlbW90ZUpXS1NldChcbiAgICAgIG5ldyBVUkwoYGh0dHBzOi8vYXV0aC5wcml2eS5pby9hcGkvdjEvYXBwcy8ke2FwcElkfS9qd2tzLmpzb25gKSxcbiAgICApO1xuICB9XG4gIHJldHVybiBqd2tzQ2FjaGU7XG59XG5cbmV4cG9ydCBkZWZhdWx0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZXIocmVxdWVzdDogSW5jb21pbmdNZXNzYWdlLCByZXNwb25zZTogU2VydmVyUmVzcG9uc2UpIHtcbiAgaWYgKHJlcXVlc3QubWV0aG9kICE9PSBcIlBPU1RcIikge1xuICAgIHJlc3BvbnNlLnNldEhlYWRlcihcIkFsbG93XCIsIFwiUE9TVFwiKTtcbiAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDA1LCB7IGVycm9yOiBcIk1ldGhvZCBub3QgYWxsb3dlZFwiIH0pO1xuICB9XG5cbiAgY29uc3Qgc3VwYWJhc2VVcmwgPSBwcm9jZXNzLmVudi5TVVBBQkFTRV9VUkw7XG4gIGNvbnN0IHNlcnZpY2VLZXkgPSBwcm9jZXNzLmVudi5TVVBBQkFTRV9TRVJWSUNFX1JPTEVfS0VZID8/IHByb2Nlc3MuZW52LlNVUEFCQVNFX1NFQ1JFVF9LRVk7XG4gIGNvbnN0IGp3a3MgPSBhd2FpdCBnZXRKd2tzKCk7XG4gIGlmICghc3VwYWJhc2VVcmwgfHwgIXNlcnZpY2VLZXkgfHwgIWFwcElkIHx8ICFqd2tzKSB7XG4gICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDUwMywgeyBlcnJvcjogXCJQcml2eSBzZXNzaW9uIGJyaWRnZSBpcyBub3QgY29uZmlndXJlZFwiIH0pO1xuICB9XG4gIGNvbnN0IHsgand0VmVyaWZ5IH0gPSBhd2FpdCBsb2FkSm9zZSgpO1xuXG4gIGxldCBpZGVudGl0eVRva2VuOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGxldCBhY2Nlc3NUb2tlbjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBsZXQgY2xpZW50RW1haWw6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgbGV0IGNsaWVudFdhbGxldDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIGNvbnN0IGJvZHkgPSBhd2FpdCByZWFkQm9keShyZXF1ZXN0KTtcbiAgICBpZGVudGl0eVRva2VuID0gYm9keS5pZGVudGl0eVRva2VuO1xuICAgIGFjY2Vzc1Rva2VuID0gYm9keS5hY2Nlc3NUb2tlbjtcbiAgICBjbGllbnRFbWFpbCA9IGJvZHkuZW1haWw7XG4gICAgY2xpZW50V2FsbGV0ID0gYm9keS53YWxsZXRBZGRyZXNzO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDAwLCB7IGVycm9yOiBcIkludmFsaWQgcmVxdWVzdCBib2R5XCIgfSk7XG4gIH1cbiAgaWYgKCFpZGVudGl0eVRva2VuICYmICFhY2Nlc3NUb2tlbikge1xuICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDAsIHsgZXJyb3I6IFwiaWRlbnRpdHlUb2tlbiBvciBhY2Nlc3NUb2tlbiByZXF1aXJlZFwiIH0pO1xuICB9XG5cbiAgLy8gMS4gQXV0aGVudGljYXRlIHRoZSByZXF1ZXN0LiBQcmVmZXIgdGhlIGlkZW50aXR5IHRva2VuIFx1MjAxNCBpdHMgc2lnbmVkXG4gIC8vICAgIGNsYWltcyBsZXQgdXMgdmVyaWZ5IGVtYWlsICsgd2FsbGV0IHNlcnZlci1zaWRlIHdpdGhvdXQgdHJ1c3RpbmcgdGhlXG4gIC8vICAgIGNsaWVudC4gSWRlbnRpdHkgdG9rZW5zIHJlcXVpcmUgYSBQcml2eSBEYXNoYm9hcmQgdG9nZ2xlIChcIlJldHVyblxuICAvLyAgICB1c2VyIGRhdGEgaW4gYW4gaWRlbnRpdHkgdG9rZW5cIiksIHNvIGZhbGwgYmFjayB0byB0aGUgYWNjZXNzIHRva2VuXG4gIC8vICAgIChhbHdheXMgaXNzdWVkIGZvciBhbnkgYXV0aGVudGljYXRlZCBzZXNzaW9uKSB3aGVuIGl0J3MgdW5hdmFpbGFibGUuXG4gIC8vICAgIFRoZSBhY2Nlc3MgdG9rZW4gc3RpbGwgcHJvdmVzIGEgZ2VudWluZSwgY3VycmVudCBQcml2eSBzZXNzaW9uIGZvciBhXG4gIC8vICAgIHNwZWNpZmljIERJRDsgd2UganVzdCBjYW4ndCByZWFkIGl0cyBsaW5rZWQgYWNjb3VudHMsIHNvIHdlIHRydXN0IHRoZVxuICAvLyAgICBjbGllbnQtc3VwcGxpZWQgZW1haWwvd2FsbGV0IGluIHRoYXQgcGF0aCBpbnN0ZWFkLlxuICBsZXQgcHJpdnlJZCA9IFwiXCI7XG4gIGxldCBlbWFpbDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGxldCB2ZXJpZmllZFdhbGxldDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbiAgaWYgKGlkZW50aXR5VG9rZW4pIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgeyBwYXlsb2FkIH0gPSBhd2FpdCBqd3RWZXJpZnkoaWRlbnRpdHlUb2tlbiwgandrcywge1xuICAgICAgICBpc3N1ZXI6IFwicHJpdnkuaW9cIixcbiAgICAgICAgYXVkaWVuY2U6IGFwcElkLFxuICAgICAgfSk7XG4gICAgICBwcml2eUlkID0gU3RyaW5nKHBheWxvYWQuc3ViID8/IFwiXCIpO1xuICAgICAgY29uc3QgcmF3TGlua2VkID0gcGF5bG9hZC5saW5rZWRfYWNjb3VudHM7XG4gICAgICBjb25zdCBsaW5rZWQ6IExpbmtlZEFjY291bnRbXSA9IHR5cGVvZiByYXdMaW5rZWQgPT09IFwic3RyaW5nXCIgPyBKU09OLnBhcnNlKHJhd0xpbmtlZCkgOiBbXTtcbiAgICAgIGNvbnN0IGVtYWlsQWNjb3VudCA9IGxpbmtlZC5maW5kKChhY2NvdW50KSA9PiBhY2NvdW50LnR5cGUgPT09IFwiZW1haWxcIiAmJiBhY2NvdW50LmFkZHJlc3MpO1xuICAgICAgY29uc3QgZ29vZ2xlQWNjb3VudCA9IGxpbmtlZC5maW5kKChhY2NvdW50KSA9PiBhY2NvdW50LnR5cGUgPT09IFwiZ29vZ2xlX29hdXRoXCIgJiYgYWNjb3VudC5lbWFpbCk7XG4gICAgICBlbWFpbCA9IChlbWFpbEFjY291bnQ/LmFkZHJlc3MgPz8gZ29vZ2xlQWNjb3VudD8uZW1haWwgPz8gbnVsbCk/LnRvTG93ZXJDYXNlKCkgPz8gbnVsbDtcbiAgICAgIGNvbnN0IGVtYmVkZGVkV2FsbGV0ID0gbGlua2VkLmZpbmQoXG4gICAgICAgIChhY2NvdW50KSA9PlxuICAgICAgICAgIGFjY291bnQudHlwZSA9PT0gXCJ3YWxsZXRcIiAmJlxuICAgICAgICAgIChhY2NvdW50LndhbGxldF9jbGllbnQgPT09IFwicHJpdnlcIiB8fCBhY2NvdW50LndhbGxldF9jbGllbnRfdHlwZSA9PT0gXCJwcml2eVwiKSAmJlxuICAgICAgICAgIGlzQWRkcmVzcyhhY2NvdW50LmFkZHJlc3MpLFxuICAgICAgKTtcbiAgICAgIGlmIChlbWJlZGRlZFdhbGxldD8uYWRkcmVzcykgdmVyaWZpZWRXYWxsZXQgPSBlbWJlZGRlZFdhbGxldC5hZGRyZXNzO1xuICAgIH0gY2F0Y2gge1xuICAgICAgaWRlbnRpdHlUb2tlbiA9IHVuZGVmaW5lZDsgLy8gZmFsbCB0aHJvdWdoIHRvIHRoZSBhY2Nlc3MtdG9rZW4gcGF0aCBiZWxvd1xuICAgIH1cbiAgfVxuXG4gIGlmICghcHJpdnlJZCAmJiBhY2Nlc3NUb2tlbikge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IHBheWxvYWQgfSA9IGF3YWl0IGp3dFZlcmlmeShhY2Nlc3NUb2tlbiwgandrcywge1xuICAgICAgICBpc3N1ZXI6IFwicHJpdnkuaW9cIixcbiAgICAgICAgYXVkaWVuY2U6IGFwcElkLFxuICAgICAgfSk7XG4gICAgICBwcml2eUlkID0gU3RyaW5nKHBheWxvYWQuc3ViID8/IFwiXCIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMSwgeyBlcnJvcjogXCJJbnZhbGlkIFByaXZ5IHRva2VuXCIgfSk7XG4gICAgfVxuICB9XG5cbiAgaWYgKCFwcml2eUlkKSByZXR1cm4ganNvbihyZXNwb25zZSwgNDAxLCB7IGVycm9yOiBcIkludmFsaWQgUHJpdnkgdG9rZW5cIiB9KTtcblxuICAvLyBDbGllbnQtc3VwcGxpZWQgZW1haWwgZmFsbGJhY2suIFRoaXMgbXVzdCBhcHBseSB3aGVuZXZlciB3ZSBzdGlsbCBkb24ndFxuICAvLyBoYXZlIGFuIGVtYWlsIFx1MjAxNCBOT1Qgb25seSBpbiB0aGUgYWNjZXNzLXRva2VuIGJyYW5jaC4gUHJpdnkgaWRlbnRpdHlcbiAgLy8gdG9rZW5zIGZyZXF1ZW50bHkgb21pdCB0aGUgZW1haWwgaW4gdGhlaXIgYGxpbmtlZF9hY2NvdW50c2AgY2xhaW1cbiAgLy8gKGVzcGVjaWFsbHkgR29vZ2xlIGxvZ2lucyksIHdoaWNoIHByZXZpb3VzbHkgc2V0IGBwcml2eUlkYCBidXQgbGVmdFxuICAvLyBgZW1haWxgIG51bGwsIHNraXBwZWQgdGhpcyBmYWxsYmFjayAoaXQgd2FzIG5lc3RlZCBpbiB0aGUgYWNjZXNzLXRva2VuXG4gIC8vIGJsb2NrKSwgYW5kIDQyMidkIFx1MjAxNCBibG9ja2luZyBmaXJzdC10aW1lIGxvZ2luIGV2ZW4gdGhvdWdoIHRoZSBjbGllbnRcbiAgLy8gY2xlYXJseSBrbm93cyB0aGUgZW1haWwuIFJlYWNoaW5nIGhlcmUgYWxyZWFkeSByZXF1aXJlZCBhXG4gIC8vIGNyeXB0b2dyYXBoaWNhbGx5IHZlcmlmaWVkIFByaXZ5IHRva2VuIGZvciB0aGlzIGFwcCwgc28gdHJ1c3RpbmcgdGhlXG4gIC8vIGNsaWVudCdzIGVtYWlsIGhlcmUgbWF0Y2hlcyB0aGUgZXhpc3RpbmcgYWNjZXNzLXRva2VuIHRydXN0IG1vZGVsLlxuICBpZiAoIWVtYWlsICYmIGlzRW1haWwoY2xpZW50RW1haWwpKSBlbWFpbCA9IGNsaWVudEVtYWlsLnRvTG93ZXJDYXNlKCk7XG5cbiAgaWYgKCFlbWFpbCkgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQyMiwgeyBlcnJvcjogXCJQcml2eSBhY2NvdW50IGhhcyBubyBlbWFpbCB0byBsaW5rXCIgfSk7XG5cbiAgLy8gT25seSB0cnVzdCB0aGUgY2xpZW50LXN1cHBsaWVkIHdhbGxldCB3aGVuIGl0IG1hdGNoZXMgdGhlIHZlcmlmaWVkIGNsYWltXG4gIC8vIChpZGVudGl0eS10b2tlbiBwYXRoKSBvciBwYXNzZXMgYmFzaWMgYWRkcmVzcyB2YWxpZGF0aW9uIChmYWxsYmFjayBwYXRoKS5cbiAgY29uc3Qgd2FsbGV0QWRkcmVzcyA9XG4gICAgdmVyaWZpZWRXYWxsZXQgPz8gKGlzQWRkcmVzcyhjbGllbnRXYWxsZXQpID8gKGNsaWVudFdhbGxldCBhcyBzdHJpbmcpIDogbnVsbCk7XG5cbiAgY29uc3QgYWRtaW4gPSBjcmVhdGVDbGllbnQoc3VwYWJhc2VVcmwsIHNlcnZpY2VLZXksIHtcbiAgICBhdXRoOiB7IHBlcnNpc3RTZXNzaW9uOiBmYWxzZSwgYXV0b1JlZnJlc2hUb2tlbjogZmFsc2UgfSxcbiAgfSk7XG5cbiAgLy8gMi4gUmVzb2x2ZSAob3IgY3JlYXRlKSB0aGUgU3VwYWJhc2UgYWNjb3VudCBmb3IgdGhpcyBlbWFpbC5cbiAgbGV0IHVzZXJJZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHsgZGF0YTogZXhpc3RpbmdQcm9maWxlIH0gPSBhd2FpdCBhZG1pblxuICAgIC5mcm9tKFwicHJvZmlsZXNcIilcbiAgICAuc2VsZWN0KFwiaWRcIilcbiAgICAuZXEoXCJlbWFpbFwiLCBlbWFpbClcbiAgICAubWF5YmVTaW5nbGUoKTtcbiAgdXNlcklkID0gZXhpc3RpbmdQcm9maWxlPy5pZCA/PyBudWxsO1xuXG4gIGlmICghdXNlcklkKSB7XG4gICAgY29uc3QgeyBkYXRhOiBjcmVhdGVkLCBlcnJvcjogY3JlYXRlRXJyb3IgfSA9IGF3YWl0IGFkbWluLmF1dGguYWRtaW4uY3JlYXRlVXNlcih7XG4gICAgICBlbWFpbCxcbiAgICAgIGVtYWlsX2NvbmZpcm06IHRydWUsXG4gICAgICB1c2VyX21ldGFkYXRhOiB7IHByaXZ5X2lkOiBwcml2eUlkIH0sXG4gICAgfSk7XG4gICAgaWYgKGNyZWF0ZWQ/LnVzZXIpIHtcbiAgICAgIHVzZXJJZCA9IGNyZWF0ZWQudXNlci5pZDtcbiAgICB9IGVsc2UgaWYgKGNyZWF0ZUVycm9yKSB7XG4gICAgICAvLyBVc2VyIG1heSBhbHJlYWR5IGV4aXN0IGluIGF1dGggd2l0aG91dCBhIHByb2ZpbGUgcm93OyBmaW5kIHRoZW0gYnkgcGFnaW5nLlxuICAgICAgZm9yIChsZXQgcGFnZSA9IDE7IHBhZ2UgPD0gMjAgJiYgIXVzZXJJZDsgcGFnZSArPSAxKSB7XG4gICAgICAgIGNvbnN0IHsgZGF0YTogbGlzdCwgZXJyb3I6IGxpc3RFcnJvciB9ID0gYXdhaXQgYWRtaW4uYXV0aC5hZG1pbi5saXN0VXNlcnMoeyBwYWdlLCBwZXJQYWdlOiAyMDAgfSk7XG4gICAgICAgIGlmIChsaXN0RXJyb3IpIGJyZWFrO1xuICAgICAgICBjb25zdCBtYXRjaCA9IGxpc3QudXNlcnMuZmluZCgoY2FuZGlkYXRlKSA9PiBjYW5kaWRhdGUuZW1haWw/LnRvTG93ZXJDYXNlKCkgPT09IGVtYWlsKTtcbiAgICAgICAgaWYgKG1hdGNoKSB1c2VySWQgPSBtYXRjaC5pZDtcbiAgICAgICAgaWYgKGxpc3QudXNlcnMubGVuZ3RoIDwgMjAwKSBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBpZiAoIXVzZXJJZCkgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDUwMCwgeyBlcnJvcjogXCJVbmFibGUgdG8gcmVzb2x2ZSBwbGF0Zm9ybSBhY2NvdW50XCIgfSk7XG5cbiAgLy8gMy4gQmVzdC1lZmZvcnQgc3luYyBvZiB0aGUgcmVhbCBQcml2eSB3YWxsZXQgKyBQcml2eSBpZCBvbnRvIHRoZSBwcm9maWxlLlxuICAvLyAgICBBIHN5bmMgZmFpbHVyZSBtdXN0IE5FVkVSIGJsb2NrIHRoZSB1c2VyIGZyb20gZW50ZXJpbmcgdGhlIHBsYXRmb3JtLFxuICAvLyAgICBzbyB3ZSB1cHNlcnQgKGF2b2lkcyBkdXBsaWNhdGUta2V5IGNyYXNoZXMpIGluc2lkZSB0cnkvY2F0Y2ggYW5kIG9ubHlcbiAgLy8gICAgbG9nIG9uIGVycm9yIGJlZm9yZSBjb250aW51aW5nIHRvIGlzc3VlIHRoZSBzZXNzaW9uLlxuICBjb25zdCBwcm9maWxlUGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgaWQ6IHVzZXJJZCxcbiAgICBlbWFpbCxcbiAgICBwcml2eV9pZDogcHJpdnlJZCxcbiAgICB1cGRhdGVkX2F0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gIH07XG4gIGlmICh3YWxsZXRBZGRyZXNzKSBwcm9maWxlUGF5bG9hZC53YWxsZXRfYWRkcmVzcyA9IHdhbGxldEFkZHJlc3M7XG4gIHRyeSB7XG4gICAgY29uc3QgeyBlcnJvcjogdXBzZXJ0RXJyb3IgfSA9IGF3YWl0IGFkbWluXG4gICAgICAuZnJvbShcInByb2ZpbGVzXCIpXG4gICAgICAudXBzZXJ0KHByb2ZpbGVQYXlsb2FkLCB7IG9uQ29uZmxpY3Q6IFwiaWRcIiB9KTtcbiAgICBpZiAodXBzZXJ0RXJyb3IpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJbdjBdIHByaXZ5LXNlc3Npb24gcHJvZmlsZSBzeW5jIGZhaWxlZDpcIiwgdXBzZXJ0RXJyb3IubWVzc2FnZSk7XG4gICAgfVxuICB9IGNhdGNoIChzeW5jRXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW3YwXSBwcml2eS1zZXNzaW9uIHByb2ZpbGUgc3luYyB0aHJldzpcIiwgc3luY0Vycm9yKTtcbiAgfVxuXG4gIC8vIDQuIE1pbnQgYSBvbmUtdGltZSB0b2tlbiB0aGUgYnJvd3NlciBjYW4gZXhjaGFuZ2UgZm9yIGEgcmVhbCBTdXBhYmFzZSBzZXNzaW9uLlxuICBjb25zdCB7IGRhdGE6IGxpbmtEYXRhLCBlcnJvcjogbGlua0Vycm9yIH0gPSBhd2FpdCBhZG1pbi5hdXRoLmFkbWluLmdlbmVyYXRlTGluayh7XG4gICAgdHlwZTogXCJtYWdpY2xpbmtcIixcbiAgICBlbWFpbCxcbiAgfSk7XG4gIGNvbnN0IHRva2VuSGFzaCA9IGxpbmtEYXRhPy5wcm9wZXJ0aWVzPy5oYXNoZWRfdG9rZW47XG4gIGlmIChsaW5rRXJyb3IgfHwgIXRva2VuSGFzaCkge1xuICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA1MDAsIHsgZXJyb3I6IFwiVW5hYmxlIHRvIGlzc3VlIHNlc3Npb25cIiB9KTtcbiAgfVxuXG4gIHJldHVybiBqc29uKHJlc3BvbnNlLCAyMDAsIHsgdG9rZW5IYXNoLCBlbWFpbCwgd2FsbGV0QWRkcmVzcyB9KTtcbn1cbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL3ZlcmNlbC9zaGFyZS92MC1wcm9qZWN0L2FwaVwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL3ZlcmNlbC9zaGFyZS92MC1wcm9qZWN0L2FwaS9fcmVsYXllckxvY2sudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL3ZlcmNlbC9zaGFyZS92MC1wcm9qZWN0L2FwaS9fcmVsYXllckxvY2sudHNcIjsvLyBBRE1JTiBcdTcxQjFcdTkzMjJcdTUzMDVcdTY2MkZcdTMwMENcdTU1QUVcdTRFMDAgRU9BXHUzMDBEXHVGRjBDXHU5M0M4XHU0RTBBXHU2QkNGXHU3QjQ2XHU0RUE0XHU2NjEzXHU3Njg0IG5vbmNlIFx1NUZDNVx1OTgwOFx1NTZCNFx1NjgzQ1x1OTA1RVx1NTg5RVx1NEUxNFx1NEUwRFx1NTNFRlx1OTFDRFx1ODkwN1x1MzAwMlxuLy9cbi8vIFx1NzcxRlx1NkI2M1x1NUMwRVx1ODFGNFx1MzAwQ21pbnQtamMgXHU1OTMxXHU2NTU3XHUzMDBEXHU3Njg0XHU5NkIxXHU4NUNGIGJ1ZyBcdTU3MjhcdTkwMTlcdTg4RTFcdUZGMUFWZXJjZWwgc2VydmVybGVzcyBmdW5jdGlvbiBcdTZCQ0ZcdTZCMjFcdTU0N0NcdTUzRUJcbi8vIFx1OTBGRFx1NjYyRlx1NzM2OFx1N0FDQlx1NzY4NFx1NTdGN1x1ODg0Q1x1NzRCMFx1NTg4M1x1RkYwQ1x1NUY3Q1x1NkI2NFx1NUI4Q1x1NTE2OFx1NkM5Mlx1NjcwOVx1NTE3MVx1NEVBQlx1OEExOFx1NjFCNlx1OUFENFx1MzAwMlx1NzU3Nlx1NTE2OVx1NEY0RFx1NEY3Rlx1NzUyOFx1ODAwNVx1NUU3RVx1NEU0RVx1NTQwQ1x1NjY0Mlx1NTIwNlx1NTIyNVx1ODlGOFx1NzY3Q1xuLy8gXHU5MUQxXHU1RUFCXHU4Q0I3IEpDIC8gXHU4QThEXHU4Q0ZDIC8gXHU2MjEwXHU0RUE0XHVGRjA4XHU3NTFBXHU4MUYzXHU1M0VBXHU2NjJGXHU1NDBDXHU0RTAwXHU0RjdGXHU3NTI4XHU4MDA1XHU5MDIzXHU3RThDXHU5RURFXHU1MTY5XHU2QjIxXHUzMDAxXHU2MjE2XHU0RjdGXHU3NTI4XHU4MDA1XHU4MUVBXHU1REYxXHU5MUNEXHU4QTY2XHU3NThBXHU1MkEwXG4vLyBcdTRFMEFcdTgwQ0NcdTY2NkZcdTgxRUFcdTUyRDVcdTg4RENcdTc2N0NcdUZGMDlcdUZGMENcdTVDMzFcdTY3MDNcdTY3MDlcdTUxNjlcdTUwMEJcdTczNjhcdTdBQ0JcdTc2ODQgTm9kZSBwcm9jZXNzIFx1NTQwQ1x1NjY0Mlx1NTQ3Q1x1NTNFQlxuLy8gYGV0aF9nZXRUcmFuc2FjdGlvbkNvdW50YCBcdTUzRDZcdTVGOTcgbm9uY2VcdTMwMDFcdTVFN0VcdTRFNEVcdTU0MENcdTY2NDJcdTkwMDFcdTUxRkFcdTRFQTRcdTY2MTNcdTIwMTRcdTIwMTR2aWVtIFx1NTE2N1x1OTBFOFx1NkM5Mlx1NjcwOVx1OERFOFxuLy8gcHJvY2VzcyBcdTc2ODRcdTkzOTZcdUZGMENcdTUxNjlcdTkwOEFcdTVGODhcdTUzRUZcdTgwRkRcdTYyRkZcdTUyMzBcdTMwMENcdTU0MENcdTRFMDBcdTUwMEJcdTMwMERub25jZVx1RkYwQ1x1NUMwRVx1ODFGNFx1NTE3Nlx1NEUyRFx1NEUwMFx1N0I0Nlx1NTcyOFx1OTNDOFx1NEUwQVx1ODhBQlx1NjJEMlx1N0Q1NVxuLy8gXHVGRjA4bm9uY2UgdG9vIGxvdyAvIGFscmVhZHkga25vd24gLyByZXBsYWNlbWVudCB0cmFuc2FjdGlvbiB1bmRlcnByaWNlZFx1RkYwOVx1RkYwQ1xuLy8gXHU0RjdGXHU3NTI4XHU4MDA1XHU3QUVGXHU1QzMxXHU2NzAzXHU3NzBCXHU1MjMwXHUzMDBDcmVsYXllciBtaW50LWpjIFx1NTkzMVx1NjU1N1x1MzAwRFx1RkYwQ1x1ODAwQ1x1NEUxNFx1NjYyRlx1OTU5M1x1NkI0N1x1NjAyN1x1MzAwMVx1OTZFM1x1NEVFNVx1OTFDRFx1NzNGRVx1NzY4NFx1NTkzMVx1NjU1N1x1MzAwMlxuLy9cbi8vIFx1NEZFRVx1NkNENVx1RkYxQVx1NzUyOCBQb3N0Z3JlcyBcdTc2ODQgc2Vzc2lvbiBcdTdEMUEgYWR2aXNvcnkgbG9jayBcdTYyOEFcdTMwMENcdTUzRDZcdTVGOTcgbm9uY2UgXHUyMTkyIFx1OTAwMVx1NTFGQVx1NEVBNFx1NjYxM1x1MzAwRFx1OTAxOVx1NkJCNVxuLy8gXHU5NURDXHU5Mzc1XHU1MzQwXHU5NTkzXHVGRjBDXHU1NzI4XHU2MjQwXHU2NzA5IHNlcnZlcmxlc3MgXHU1N0Y3XHU4ODRDXHU3NEIwXHU1ODgzXHU0RTRCXHU5NTkzXHU1RjM3XHU1MjM2XHU1RThGXHU1MjE3XHU1MzE2XHUzMDAyXHU0RTRCXHU2MjQwXHU0RUU1XHU5MDc4IFBvc3RncmVzIFx1ODAwQ1x1NEUwRFx1NjYyRlxuLy8gcHJvY2VzcyBcdThBMThcdTYxQjZcdTlBRDRcdTUxNjdcdTc2ODRcdTkzOTZcdUZGMENcdTZCNjNcdTY2MkZcdTU2RTBcdTcwQkEgUG9zdGdyZXMgXHU2NjJGXHU5MDE5XHU1MDBCXHU3Q0ZCXHU3RDcxXHU4OEUxXHU1NTJGXHU0RTAwXHU1NzI4XHU1OTFBXHU1MDBCIHNlcnZlcmxlc3Ncbi8vIFx1NTdGN1x1ODg0Q1x1NzRCMFx1NTg4M1x1NEU0Qlx1OTU5M1x1NzcxRlx1NkI2M1x1NTE3MVx1NEVBQlx1NzJDMFx1NjE0Qlx1NzY4NFx1NTczMFx1NjVCOVx1MzAwMlx1NjJGRlx1NTIzMFx1OTM5Nlx1NEU0Qlx1NUY4Q1x1NTNFQVx1OTcwMFx1ODk4MVx1NTNENiBub25jZVx1MzAwMVx1OTAwMVx1NTFGQVx1NEVBNFx1NjYxM1x1RkYwOFx1NEUwRFx1NzUyOFx1N0I0OVxuLy8gXHU0RTBBXHU5M0M4XHU3OEJBXHU4QThEXHVGRjA5XHVGRjBDXHU0RTAwXHU5MDAxXHU1MUZBXHU1QzMxXHU5OUFDXHU0RTBBXHU5MUNCXHU2NTNFXHU5Mzk2XHUyMDE0XHUyMDE0XHU1NkUwXHU3MEJBXHU3NTc2XHU0RTAwXHU3QjQ2XHU0RUE0XHU2NjEzXHUzMDBDXHU5MDAxXHU1MUZBXHUzMDBEXHVGRjA4XHU5MDMyXHU1MTY1IG1lbXBvb2xcdUZGMDlcdTRFNEJcdTVGOENcdUZGMENcbi8vIGJsb2NrVGFnIFwicGVuZGluZ1wiIFx1NzY4NFx1NEUwQlx1NEUwMFx1NkIyMVx1NjdFNVx1OEE2Mlx1NUMzMVx1NjcwM1x1NkI2M1x1NzhCQVx1NTNDRFx1NjYyMFx1OTA1RVx1NTg5RVx1NUY4Q1x1NzY4NCBub25jZVx1RkYwQ1x1NEUwRFx1OTcwMFx1ODk4MVx1N0I0OVx1NUI4M1x1ODhBQlxuLy8gXHU2MzE2XHU1MTY1XHU1MzQwXHU1ODRBXHU2MjREXHU4MEZEXHU4QjkzXHU0RTBCXHU0RTAwXHU3QjQ2XHU0RUE0XHU2NjEzXHU2MzkyXHU0RTBBXHU2QjYzXHU3OEJBXHU3Njg0IG5vbmNlXHUzMDAyXHU5MDE5XHU4QjkzXHU0RUE0XHU2NjEzXHU0RUNEXHU1M0VGXHU0RUU1XHU0RTI2XHU4ODRDXHU3QjQ5XHU1Rjg1XHU2NTM2XHU2NERBXHU3OEJBXHU4QThEXHVGRjBDXG4vLyBcdTUzRUFcdTY3MDlcdTMwMENcdTZDN0FcdTVCOUEgbm9uY2VcdUZGMEJcdTkwMDFcdTUxRkFcdTMwMERcdTkwMTlcdTRFMDBcdTVDMEZcdTZCQjVcdTc3MUZcdTZCNjNcdTk3MDBcdTg5ODFcdTVFOEZcdTUyMTdcdTUzMTZcdTMwMDJcbi8vXG4vLyAyMDI2LTA5LTE5XHVGRjFBXHU2N0I2XHU2OUNCXHU3QzIxXHU1MzE2XHU3MEJBXHU1NUFFXHU0RTAwIEFETUlOX1BSSVZBVEVfS0VZIFx1NzFCMVx1OTMyMlx1NTMwNVx1RkYwOFx1NTNENlx1NEVFM1x1NTE0OFx1NTI0RFx1NzY4NFxuLy8gcmVsYXllcihvd25lcikgKyBkZWxlZ2F0ZSBcdTk2RDlcdTkzMjJcdTUzMDVcdTUyMDZcdTVERTVcdUZGMDlcdUZGMENcdTU2RTBcdTZCNjRcdTUzRUFcdTk3MDBcdTg5ODFcdTRFMDBcdTUwMEIgbG9jayBrZXlcdTMwMDJcbmltcG9ydCB7IENsaWVudCB9IGZyb20gXCJwZ1wiO1xuXG5jb25zdCBBRE1JTl9MT0NLX0tFWSA9IDkxM18yMjRfNTAxOyAvLyBcdTRFRkJcdTYxMEZcdTU2RkFcdTVCOUFcdTY1NzRcdTY1NzhcdUZGMENcdTUwQzVcdTRGNUNcdTcwQkEgYWR2aXNvcnkgbG9jayBcdTc2ODQga2V5XHVGRjBDXHU4MjA3XHU1MTc2XHU0RUQ2XHU3NTI4XHU5MDE0XHU3Njg0IGxvY2sgXHU1MzQwXHU5Njk0XHUzMDAyXG5cbmZ1bmN0aW9uIGNvbm5lY3Rpb25TdHJpbmcoKTogc3RyaW5nIHtcbiAgY29uc3QgdXJsID0gcHJvY2Vzcy5lbnYuUE9TVEdSRVNfVVJMX05PTl9QT09MSU5HIHx8IHByb2Nlc3MuZW52LlBPU1RHUkVTX1VSTDtcbiAgaWYgKCF1cmwpIHRocm93IG5ldyBFcnJvcihcIlx1N0YzQVx1NUMxMSBQT1NUR1JFU19VUkxfTk9OX1BPT0xJTkcgLyBQT1NUR1JFU19VUkxcdUZGMENcdTcxMjFcdTZDRDVcdTUzRDZcdTVGOTcgbm9uY2UgXHU5Mzk2XCIpO1xuICAvLyBcdTc5RkJcdTk2NjRcdTkwMjNcdTdEREFcdTVCNTdcdTRFMzJcdTg4RTFcdTc2ODQgc3NsbW9kZSBcdTUzQzNcdTY1NzhcdUZGMUFTdXBhYmFzZSBcdTdENjZcdTc2ODQgVVJMIFx1NUUzNlx1NEU4NiBzc2xtb2RlPXJlcXVpcmVcdUZGMENcdTgwMENcbiAgLy8gXHU2NUIwXHU3MjQ4IHBnIFx1NjcwM1x1NjI4QSByZXF1aXJlIFx1NzU3Nlx1NjIxMCB2ZXJpZnktZnVsbFx1RkYwOFx1NUYzN1x1NTIzNlx1OUE1N1x1OEI0OVx1NjE5MVx1OEI0OVx1OTNDOFx1RkYwOVx1RkYwQ1x1NTk4Mlx1NkI2NFx1NEUwMFx1NEY4Nlx1NTM3M1x1NEY3Rlx1NjIxMVx1NTAxMVx1NTcyOFxuICAvLyBDbGllbnQgXHU5MDc4XHU5ODA1XHU1MEIzXHU0RTg2IHNzbC5yZWplY3RVbmF1dGhvcml6ZWQ9ZmFsc2UgXHU0RTVGXHU2NzAzXHU4OEFCXHU1QjU3XHU0RTMyXHU1MTY3XHU3Njg0IHNzbG1vZGUgXHU4NENCXHU5MDRFXHVGRjBDXG4gIC8vIFx1NEVDRFx1NzEzNlx1NEUxRlx1MzAwQ3NlbGYtc2lnbmVkIGNlcnRpZmljYXRlIGluIGNlcnRpZmljYXRlIGNoYWluXHUzMDBEXHUzMDAyXHU2MjhBIHNzbG1vZGUgXHU2MkZGXHU2Mzg5XHU1RjhDXHVGRjBDXG4gIC8vIENsaWVudCBcdTkwNzhcdTk4MDVcdTg4RTFcdTc2ODQgc3NsIFx1NzI2OVx1NEVGNlx1NjI0RFx1NjcwM1x1NzUxRlx1NjU0OFx1MzAwMlxuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IG5ldyBVUkwodXJsKTtcbiAgICBwYXJzZWQuc2VhcmNoUGFyYW1zLmRlbGV0ZShcInNzbG1vZGVcIik7XG4gICAgcmV0dXJuIHBhcnNlZC50b1N0cmluZygpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBVUkwgXHU4OUUzXHU2NzkwXHU1OTMxXHU2NTU3XHVGRjA4XHU2OTc1XHU1QzExXHU2NTc4XHU5NzVFXHU2QTE5XHU2RTk2XHU2ODNDXHU1RjBGXHVGRjA5XHU1QzMxXHU5MDAwXHU1NkRFXHU1MzlGXHU1QjU3XHU0RTMyXHVGRjBDXHU4MUYzXHU1QzExXHU0RTBEXHU1RjcxXHU5N0ZGXHU5MDIzXHU3RERBXHU2NzJDXHU4RUFCXHUzMDAyXG4gICAgcmV0dXJuIHVybDtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiB3aXRoQWR2aXNvcnlMb2NrPFQ+KGxvY2tLZXk6IG51bWJlciwgZm46ICgpID0+IFByb21pc2U8VD4pOiBQcm9taXNlPFQ+IHtcbiAgLy8gc3NsLnJlamVjdFVuYXV0aG9yaXplZD1mYWxzZVx1RkYxQVN1cGFiYXNlIFx1NzY4NCBQb3N0Z3JlcyBcdTc2RjRcdTkwMjNcdUZGMDhQT1NUR1JFU19VUkxfTk9OX1BPT0xJTkdcdUZGMDlcbiAgLy8gXHU0RjdGXHU3NTI4XHU3Njg0XHU2NjJGIFN1cGFiYXNlIFx1ODFFQVx1N0MzRFx1NzY4NFx1NjE5MVx1OEI0OVx1OTNDOFx1RkYwQ05vZGUgXHU5ODEwXHU4QTJEIENBIFx1NkUwNVx1NTVBRVx1NEUyNlx1NEUwRFx1NEZFMVx1NEVGQlx1NUI4M1x1RkYwQ1x1NzZGNFx1NjNBNVx1OTAyM1x1N0REQVx1NjcwM1x1NEUxRlxuICAvL1x1MzAwQ3NlbGYtc2lnbmVkIGNlcnRpZmljYXRlIGluIGNlcnRpZmljYXRlIGNoYWluXHUzMDBEXHU4MDBDXHU0RTJEXHU2NUI3XHUyMDE0XHUyMDE0XHU5MDE5XHU2QjYzXHU2NjJGXHU5MUQxXHU1RUFCXHU4Q0I3IEpDXHVGRjBGXHU4QThEXHU4Q0ZDXHVGRjBGXG4gIC8vIFx1NjIxMFx1NEVBNFx1NTcyOFx1OTNDOFx1NEUwQVx1N0Q1MFx1N0I5N1x1NTI0RFx1RkYwQ1x1NjVCQ1x1NTNENlx1NUY5NyBub25jZSBcdTkzOTZcdTkwMTlcdTRFMDBcdTZCNjVcdTVDMzFcdTU5MzFcdTY1NTdcdTc2ODRcdTY4MzlcdTU2RTBcdTMwMDJcdTkwMTlcdTY4OURcdTkwMjNcdTdEREFcdTUzRUFcdTc1MjhcdTRGODZcdTUzRDZcbiAgLy8gYWR2aXNvcnkgbG9ja1x1RkYwOFx1NEUwRFx1NjQyQ1x1NzlGQlx1NEVGQlx1NEY1NVx1OENDN1x1NzUyMlx1MzAwMVx1NEUwRFx1NTQyQlx1NkE1Rlx1NUJDNlx1NjdFNVx1OEE2Mlx1RkYwOVx1RkYwQ1x1NEUxNFx1OTAyM1x1N0REQVx1NzZFRVx1NkExOVx1NUMzMVx1NjYyRlx1NjIxMVx1NTAxMVx1ODFFQVx1NURGMVx1NUMwOFx1Njg0OFx1NzY4NFxuICAvLyBTdXBhYmFzZVx1RkYwQ1x1OTVEQ1x1OTU4OVx1NjE5MVx1OEI0OVx1OTNDOFx1OUE1N1x1OEI0OVx1NjYyRlx1OTAxOVx1NTAwQiBzYW5kYm94IFx1NzRCMFx1NTg4M1x1NEUwQlx1NzY4NFx1NkExOVx1NkU5Nlx1NEUxNFx1NUI4OVx1NTE2OFx1NzY4NFx1NEY1Q1x1NkNENVx1MzAwMlxuICBjb25zdCBjbGllbnQgPSBuZXcgQ2xpZW50KHtcbiAgICBjb25uZWN0aW9uU3RyaW5nOiBjb25uZWN0aW9uU3RyaW5nKCksXG4gICAgc3NsOiB7IHJlamVjdFVuYXV0aG9yaXplZDogZmFsc2UgfSxcbiAgfSk7XG4gIGF3YWl0IGNsaWVudC5jb25uZWN0KCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgY2xpZW50LnF1ZXJ5KFwiQkVHSU5cIik7XG4gICAgLy8gcGdfYWR2aXNvcnlfeGFjdF9sb2NrIFx1NjcwM1x1NEUwMFx1NzZGNFx1OTYzQlx1NTg1RVx1NzZGNFx1NTIzMFx1NTNENlx1NUY5N1x1OTM5Nlx1NzBCQVx1NkI2Mlx1RkYxQlx1OTM5Nlx1NzY4NFx1NzUxRlx1NTQ3RFx1OTAzMVx1NjcxRlx1N0Q4MVx1NUI5QVx1OTAxOVx1NTAwQlxuICAgIC8vIHRyYW5zYWN0aW9uXHVGRjBDQ09NTUlUL1JPTExCQUNLIFx1NjY0Mlx1ODFFQVx1NTJENVx1OTFDQlx1NjUzRVx1RkYwQ1x1NEUwRFx1OTcwMFx1ODk4MVx1NTNFNlx1NTkxNlx1NTQ3Q1x1NTNFQiB1bmxvY2tcdTMwMDJcbiAgICBhd2FpdCBjbGllbnQucXVlcnkoXCJTRUxFQ1QgcGdfYWR2aXNvcnlfeGFjdF9sb2NrKCQxKVwiLCBbbG9ja0tleV0pO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGZuKCk7XG4gICAgYXdhaXQgY2xpZW50LnF1ZXJ5KFwiQ09NTUlUXCIpO1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgYXdhaXQgY2xpZW50LnF1ZXJ5KFwiUk9MTEJBQ0tcIikuY2F0Y2goKCkgPT4ge30pO1xuICAgIHRocm93IGVycm9yO1xuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IGNsaWVudC5lbmQoKS5jYXRjaCgoKSA9PiB7fSk7XG4gIH1cbn1cblxuLyoqXG4gKiBcdTUzRDZcdTVGOTdcdTUxNjhcdTU3REYgQURNSU4gXHU3MUIxXHU5MzIyXHU1MzA1IG5vbmNlIFx1OTM5Nlx1RkYwOFx1OERFOFx1NjI0MFx1NjcwOSBzZXJ2ZXJsZXNzIFx1NTdGN1x1ODg0Q1x1NzRCMFx1NTg4M1x1RkYwOVx1RkYwQ1x1NTcyOFx1OTM5Nlx1NTE2N1x1NTdGN1x1ODg0Q1xuICogYGZuYFx1RkYwOFx1OTAxQVx1NUUzOFx1NjYyRlx1MzAwQ1x1NjdFNVx1OEE2MiBwZW5kaW5nIG5vbmNlIFx1MjE5MiBcdTdENDRcdTU5N0RcdTRFQTRcdTY2MTMgXHUyMTkyIFx1NTQ3Q1x1NTNFQlxuICogc2VuZFRyYW5zYWN0aW9uL3dyaXRlQ29udHJhY3QgXHU2MkZGXHU1MjMwIHR4IGhhc2hcdTMwMERcdUZGMDlcdUZGMENcdTYyRkZcdTUyMzBcdTdENTBcdTY3OUNcdTVGOENcdTdBQ0JcdTUyM0JcdTkxQ0JcdTY1M0VcdTkzOTZcdTUxOERcdTU2REVcdTUwQjNcdTIwMTRcdTIwMTRcbiAqIFx1NEUwRFx1NTcyOFx1OTM5Nlx1NTE2N1x1N0I0OVx1NUY4NVx1NEUwQVx1OTNDOFx1NzhCQVx1OEE4RFx1RkYwQ1x1NzhCQVx1NEZERFx1NTVBRVx1NEUwMFx1NEVBNFx1NjYxM1x1NzY4NFx1NzhCQVx1OEE4RFx1NUVGNlx1OTA3Mlx1NEUwRFx1NjcwM1x1NjJENlx1NEY0Rlx1NUY4Q1x1OTc2Mlx1NjI0MFx1NjcwOVx1NjM5Mlx1OTY4QVx1NEUyRFx1NzY4NFx1NTE3Nlx1NEVENlxuICogXHU0RjdGXHU3NTI4XHU4MDA1XHU2NENEXHU0RjVDXHUzMDAyXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB3aXRoQWRtaW5Ob25jZUxvY2s8VD4oZm46ICgpID0+IFByb21pc2U8VD4pOiBQcm9taXNlPFQ+IHtcbiAgcmV0dXJuIHdpdGhBZHZpc29yeUxvY2soQURNSU5fTE9DS19LRVksIGZuKTtcbn1cbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL3ZlcmNlbC9zaGFyZS92MC1wcm9qZWN0L2FwaVwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL3ZlcmNlbC9zaGFyZS92MC1wcm9qZWN0L2FwaS9fb25jaGFpbi50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vdmVyY2VsL3NoYXJlL3YwLXByb2plY3QvYXBpL19vbmNoYWluLnRzXCI7Ly8gXHU1RjhDXHU3QUVGIHJlbGF5ZXIgXHU3Njg0XHU5M0M4XHU0RTBBXHU1REU1XHU1MTc3XHU2QTIxXHU3RDQ0XHVGRjA4VmVyY2VsIHNlcnZlcmxlc3MgLyBOb2RlIHJ1bnRpbWVcdUZGMDlcdTMwMDJcbi8vXG4vLyBcdTkwMTlcdTg4RTFcdTYzMDFcdTY3MDlcdTU1MkZcdTRFMDBcdTRFMDBcdTYyOEFcdTVGOENcdTdBRUZcdTcxQjFcdTkzMjJcdTUzMDVcdTc5QzFcdTk0NzBcdUZGMDhBRE1JTl9QUklWQVRFX0tFWVx1RkYwOVx1RkYwQ1x1NEVFM1x1NzY3Q1x1NjI0MFx1NjcwOVx1OTcwMFx1ODk4MVx1MzAwQ1x1NTQwOFx1N0QwNFxuLy8gb3duZXJcdTMwMERcdTYyMTZcdTMwMENTYWZlIFx1NURGMlx1NjgzOFx1NTFDNlx1NzY4NFx1NTJENVx1NzUyOFx1ODAwNVx1MzAwRFx1OEVBQlx1NTIwNlx1NjI0RFx1ODBGRFx1OTAwMVx1NTFGQVx1NzY4NFx1OTNDOFx1NEUwQVx1NEVBNFx1NjYxM1x1RkYxQVJXQS9BRSBcdTRFMDBcdTdEMUFcdThBOERcdThDRkNcdTMwMDFcbi8vIFx1NEU4Q1x1N0QxQVx1NUUwMlx1NTgzNFx1NjRBRVx1NTQwOFx1MzAwMVx1NEVFNVx1NTNDQVx1NjI4QVx1NUI1MFx1NTQwOFx1N0QwNFx1NEY0RFx1NTc0MFx1NUJFQlx1OTAzMlx1NkJDRFx1NTQwOFx1N0QwNFx1NzY4NFx1NEUwMFx1NkIyMVx1NjAyN1x1NTIxRFx1NTlDQlx1NTMxNlx1MzAwMlx1NzlDMVx1OTQ3MFx1NTNFQVx1NUI1OFx1NTcyOFx1NUY4Q1x1N0FFRlxuLy8gXHU3NEIwXHU1ODgzXHU4QjhBXHU2NTc4XHVGRjBDXHU2QzM4XHU5MDYwXHU0RTBEXHU2NzAzXHU1NkRFXHU1MEIzXHU3RDY2XHU1MjREXHU3QUVGXHUzMDAyXG4vL1xuLy8gMjAyNi0wOS0xOVx1RkYxQVx1NTE2OFx1OTc2Mlx1NjNEQlx1NjIxMFx1NEY3Rlx1NzUyOFx1ODAwNVx1NjNEMFx1NEY5Qlx1NzY4NFx1NjVCMFx1NEUwMFx1NjI3OVx1NTQwOFx1N0QwNFx1OTBFOFx1N0Y3Mlx1RkYwOFx1NTM5Rlx1NTczMFx1NTc0MFx1ODIwN1x1NTE3NiBvd25lciBcdTc5QzFcdTk0NzBcbi8vIDB4N2VhMlx1MjAyNjZjZDMgXHU1REYyXHU1NzI4XHU1QzBEXHU4QTcxXHU4QTE4XHU5MzA0XHU0RTJEXHU2NjBFXHU2NTg3XHU2NkREXHU1MTQ5XHVGRjBDXHU4OTk2XHU3MEJBXHU1REYyXHU2RDI5XHU2RjBGXHVGRjBDXHU0RTBEXHU1MThEXHU0RkUxXHU0RUZCXHUzMDAxXHU0RTBEXHU1MThEXHU0RjdGXHU3NTI4XHVGRjA5XHUzMDAyXG4vLyBcdTY3QjZcdTY5Q0JcdTU0MENcdTY2NDJcdTdDMjFcdTUzMTZcdTcwQkFcdTU1QUVcdTRFMDBcdTcxQjFcdTkzMjJcdTUzMDVcdUZGMUFcbi8vICAtIFx1NzlGQlx1OTY2NFx1NTE0OFx1NTI0RFx1NzY4NCBSRUxBWUVSX1BSSVZBVEVfS0VZXHVGRjA4XHU1NDA4XHU3RDA0IG93bmVyXHVGRjA5XHVGRjBGREVMRUdBVEVfUFJJVkFURV9LRVlcbi8vICAgIFx1RkYwOFNhZmUgQWxsb3dhbmNlIE1vZHVsZSBcdTc2ODRcdTk4NERcdTVFQTZcdTUyRDVcdTc1MjhcdTgwMDVcdUZGMDlcdTk2RDlcdTkzMjJcdTUzMDVcdTUyMDZcdTVERTVcdUZGMENcdTdENzFcdTRFMDBcdTY1MzlcdTYyMTBcdTRFMDBcdTYyOEFcbi8vICAgIEFETUlOX1BSSVZBVEVfS0VZXHVGRjBDXHU1NDBDXHU2NjQyXHU2NEMxXHU2NzA5XHU1MTY5XHU4MDA1XHU3Njg0XHU2QjBBXHU5NjUwXHU4MjA3XHU4MDc3XHU4Q0FDXHUzMDAyXG4vLyAgLSBKQy9BRSBcdTc2N0NcdTY1M0VcdTdENjZcdTRGN0ZcdTc1MjhcdTgwMDVcdTY1MzlcdTcwQkFcdTMwMENcdTcxREZcdTkwNEJcdTcxQjFcdTkzMjJcdTUzMDVcdTc2RjRcdTYzQTVcdThGNDlcdTVFMzNcdTMwMERcdTZBMjFcdTU3OEJcdUZGMDhcdTRGN0ZcdTc1MjhcdTgwMDVcdTY2MEVcdTc4QkFcdTYzMDdcdTVCOUFcdUZGMDlcdUZGMUFcbi8vICAgIFNhZmUgXHU5MUQxXHU1RUFCXHU3Njg0IEpDL0FFIFx1NzUzMVx1NEVCQVx1NURFNVx1NjI0Qlx1NTJENVx1OEY0OVx1NUUzM1x1MzAwQ1x1ODhEQ1x1OENBOFx1MzAwRFx1NTIzMCBBRE1JTiBcdTcxQjFcdTkzMjJcdTUzMDVcdUZGMENcdTRFNEJcdTVGOENcdTYyNDBcdTY3MDlcbi8vICAgIFx1NUMwRFx1NEY3Rlx1NzUyOFx1ODAwNVx1NzY4NFx1NzY3Q1x1NjUzRVx1OTBGRFx1NjYyRiBBRE1JTiBcdTc1MjhcdTZBMTlcdTZFOTYgRVJDLTIwIHRyYW5zZmVyKHRvLCBhbW91bnQpIFx1NUY5RVx1ODFFQVx1NURGMVxuLy8gICAgXHU3Njg0XHU5OTE4XHU5ODREXHU3NkY0XHU2M0E1XHU4RjQ5XHU1MUZBXHUyMDE0XHUyMDE0KipcdTRFMERcdTRGN0ZcdTc1MjggYXBwcm92ZS9hbGxvd2FuY2UvdHJhbnNmZXJGcm9tXHVGRjBDXHU0RTVGXHU0RTBEXHU0RjdGXHU3NTI4XG4vLyAgICBTYWZlIEFsbG93YW5jZSBNb2R1bGUqKlx1RkYwQ1x1NkM5Mlx1NjcwOVx1NEVGQlx1NEY1NVx1OTg0RFx1NTkxNlx1NjM4OFx1NkIwQVx1NkI2NVx1OUE1Rlx1MzAwMlxuLy8gIC0gKipcdTVERjJcdTc3RTVcdTk4QThcdTk2QUFcdUZGMDhcdTRGN0ZcdTc1MjhcdTgwMDVcdTVERjJcdTc3RTVcdTYwQzVcdTRFMjZcdTkwNzhcdTY0QzdcdTYzQTVcdTUzRDdcdUZGMDkqKlx1RkYxQUFETUlOIFx1NzFCMVx1OTMyMlx1NTMwNVx1NjcyQ1x1OEVBQlx1NjMwMVx1NjcwOVx1OTZBOFx1NjY0Mlx1NTNFRlx1OEY0OVx1NTFGQVxuLy8gICAgXHU3Njg0IEpDL0FFIFx1NUVBQlx1NUI1OFx1RkYwOFx1ODhEQ1x1OENBOFx1NUY4Q1x1NzU1OVx1NTcyOFx1NzFCMVx1OTMyMlx1NTMwNVx1ODhFMVx1RkYwOVx1RkYwQ1x1NzlDMVx1OTQ3MFx1NEUwMFx1NjVFNlx1NkQyOVx1NkYwRlx1RkYwQ1x1NjUzQlx1NjRDQVx1ODAwNVx1NTNFRlx1OEY0OVx1NTFGQVx1NzFCMVx1OTMyMlx1NTMwNVxuLy8gICAgXHU3NTc2XHU0RTBCXHU2MzAxXHU2NzA5XHU3Njg0XHU1MTY4XHU5MEU4XHU1RUFCXHU1QjU4XHVGRjA4XHU5OEE4XHU5NkFBXHU0RTBBXHU5NjUwXHVGRjFEXHU3MUIxXHU5MzIyXHU1MzA1XHU5OTE4XHU5ODREXHVGRjBDXHU4MDBDXHU5NzVFXHU2NTc0XHU1MDBCIFNhZmUgXHU5MUQxXHU1RUFCXHVGRjA5XHUzMDAyXHU1MkQ5XHU1RkM1XG4vLyAgICBcdTUzRUFcdTYyOEFcdTkwMTlcdTYyOEFcdTc5QzFcdTk0NzBcdTY1M0VcdTU3MjhcdTVGOENcdTdBRUZcdTc0QjBcdTU4ODNcdThCOEFcdTY1NzhcdUZGMENcdTdENTVcdTRFMERcdTVCRUJcdTkwMzJcdTRFRkJcdTRGNTVcdTUyNERcdTdBRUZcdTdBMEJcdTVGMEZcdTc4QkNcdTMwMDFcdTUxNDNcdTRFRjZcdTYyMTZcbi8vICAgIC5lbnYubG9jYWxcdUZGMUJcdTRFMjZcdTVFRkFcdThCNzBcdTUzRUFcdTc1NTlcdTVGQzVcdTg5ODFcdTc2ODRcdTcxREZcdTkwNEJcdTVFQUJcdTVCNThcdTU3MjhcdTcxQjFcdTkzMjJcdTUzMDVcdUZGMENcdTUxNzZcdTk5MThcdTc1NTlcdTU3MjggU2FmZSBcdTkxRDFcdTVFQUJcdTMwMDJcbi8vICAtIFJXQSBcdTRFMDBcdTdEMUFcdThBOERcdThDRkMgLyBcdTRFOENcdTdEMUFcdTVFMDJcdTU4MzRcdTZDQkZcdTc1MjhcdTY1RTJcdTY3MDlcdTU0MDhcdTdEMDRcdTRFQ0JcdTk3NjJcdUZGMDhleGVjdXRlU3Vic2NyaXB0aW9uIC9cbi8vICAgIGV4ZWN1dGVUcmFkZVx1RkYwOVx1RkYwQ1x1OTAxOVx1NjI3OVx1NEUwRFx1NTNEN1x1NUY3MVx1OTdGRlx1MjAxNFx1MjAxNEpDL0FFIFx1NzY4NFx1NzU3MFx1NTJENVx1NTNFQVx1NUY3MVx1OTdGRlx1MzAwQ1x1NzY3Q1x1NjUzRVx1N0Q2Nlx1NEY3Rlx1NzUyOFx1ODAwNVx1MzAwRFx1OTAxOVxuLy8gICAgXHU0RTAwXHU2QjY1XHVGRjFCQUUgXHU3M0ZFXHU1NzI4XHU0RTVGXHU2NzA5XHU1QzA4XHU1QzZDXHU0RTAwXHU3RDFBXHU4QThEXHU4Q0ZDXHU1NDA4XHU3RDA0XHVGRjA4YWVQcmltYXJ5U2FsZVx1RkYwOVx1RkYwQ1x1NEUwRFx1NTE4RFx1OTcwMFx1ODk4MVxuLy8gICAgXHUzMDBDcHVsbEpjVG9WYXVsdCBcdTUxNjlcdTZCNjVcdTZFNEFcdTUxRkFcdThBOERcdThDRkNcdTMwMERcdTc2ODRcdTgyMEFcdTYyNEJcdTZDRDVcdTMwMDJcbmltcG9ydCB7XG4gIGNyZWF0ZVB1YmxpY0NsaWVudCxcbiAgY3JlYXRlV2FsbGV0Q2xpZW50LFxuICBmYWxsYmFjayxcbiAgZm9ybWF0RXRoZXIsXG4gIGZvcm1hdFVuaXRzLFxuICBnZXRBZGRyZXNzLFxuICBodHRwLFxuICBwYXJzZUFiaUl0ZW0sXG4gIHBhcnNlRXRoZXIsXG4gIHBhcnNlVW5pdHMsXG4gIHR5cGUgQWRkcmVzcyxcbiAgdHlwZSBQdWJsaWNDbGllbnQsXG59IGZyb20gXCJ2aWVtXCI7XG5pbXBvcnQgeyBtbmVtb25pY1RvQWNjb3VudCwgcHJpdmF0ZUtleVRvQWNjb3VudCB9IGZyb20gXCJ2aWVtL2FjY291bnRzXCI7XG5pbXBvcnQgeyBiYXNlU2Vwb2xpYSB9IGZyb20gXCJ2aWVtL2NoYWluc1wiO1xuaW1wb3J0IHsgd2l0aEFkbWluTm9uY2VMb2NrIH0gZnJvbSBcIi4vX3JlbGF5ZXJMb2NrXCI7XG4vLyBLZWVwIHNlcnZlcmxlc3MgY29udHJhY3QgY29uZmlnIGluIHRoZSBBUEkgYnVuZGxlOyBpbXBvcnRpbmcgdGhlIGZyb250ZW5kXG4vLyBjb250cmFjdHMgbW9kdWxlIG1ha2VzIFZlcmNlbCdzIENvbW1vbkpTIHJlbGF5ZXIgcmVxdWlyZSBhbiBFU00gZmlsZSBhdCBydW50aW1lLlxuZXhwb3J0IGNvbnN0IFAyUF9FU0NST1dfQUREUkVTUzogQWRkcmVzcyA9IG5vcm1hbGl6ZU9yVGhyb3coXG4gIHVuZGVmaW5lZCxcbiAgXCIweGE5MDQxNTYzRTEwM2ZiOURkNmNEMTU4NTlhMWRBQjQ2NWMyYzdjMjhcIixcbiAgXCJQMlAgXHU4QTE3XHU3QkExXHU1NDA4XHU3RDA0XCIsXG4pO1xuXG5leHBvcnQgY29uc3QgUDJQX0VTQ1JPV19BQkkgPSBbXG4gIHtcbiAgICB0eXBlOiBcImZ1bmN0aW9uXCIsXG4gICAgbmFtZTogXCJjcmVhdGVPcmRlclwiLFxuICAgIHN0YXRlTXV0YWJpbGl0eTogXCJub25wYXlhYmxlXCIsXG4gICAgaW5wdXRzOiBbXG4gICAgICB7IG5hbWU6IFwiY2xpZW50T3JkZXJJZFwiLCB0eXBlOiBcImJ5dGVzMzJcIiB9LFxuICAgICAgeyBuYW1lOiBcImlzU2VsbFwiLCB0eXBlOiBcImJvb2xcIiB9LFxuICAgICAgeyBuYW1lOiBcImFzc2V0VG9rZW5cIiwgdHlwZTogXCJhZGRyZXNzXCIgfSxcbiAgICAgIHsgbmFtZTogXCJjdXJyZW5jeVRva2VuXCIsIHR5cGU6IFwiYWRkcmVzc1wiIH0sXG4gICAgICB7IG5hbWU6IFwicHJpY2VcIiwgdHlwZTogXCJ1aW50MjU2XCIgfSxcbiAgICAgIHsgbmFtZTogXCJxdWFudGl0eVwiLCB0eXBlOiBcInVpbnQyNTZcIiB9LFxuICAgIF0sXG4gICAgb3V0cHV0czogW3sgbmFtZTogXCJvcmRlcklkXCIsIHR5cGU6IFwidWludDI1NlwiIH1dLFxuICB9LFxuICB7XG4gICAgdHlwZTogXCJmdW5jdGlvblwiLFxuICAgIG5hbWU6IFwiZmlsbE9yZGVyXCIsXG4gICAgc3RhdGVNdXRhYmlsaXR5OiBcIm5vbnBheWFibGVcIixcbiAgICBpbnB1dHM6IFtcbiAgICAgIHsgbmFtZTogXCJvcmRlcklkXCIsIHR5cGU6IFwidWludDI1NlwiIH0sXG4gICAgICB7IG5hbWU6IFwicXVhbnRpdHlcIiwgdHlwZTogXCJ1aW50MjU2XCIgfSxcbiAgICAgIHsgbmFtZTogXCJmaWxsS2V5XCIsIHR5cGU6IFwiYnl0ZXMzMlwiIH0sXG4gICAgXSxcbiAgICBvdXRwdXRzOiBbXG4gICAgICB7XG4gICAgICAgIG5hbWU6IFwicmVzdWx0XCIsXG4gICAgICAgIHR5cGU6IFwidHVwbGVcIixcbiAgICAgICAgY29tcG9uZW50czogW1xuICAgICAgICAgIHsgbmFtZTogXCJvcmRlcklkXCIsIHR5cGU6IFwidWludDI1NlwiIH0sXG4gICAgICAgICAgeyBuYW1lOiBcImJ1eWVyXCIsIHR5cGU6IFwiYWRkcmVzc1wiIH0sXG4gICAgICAgICAgeyBuYW1lOiBcInNlbGxlclwiLCB0eXBlOiBcImFkZHJlc3NcIiB9LFxuICAgICAgICAgIHsgbmFtZTogXCJxdWFudGl0eVwiLCB0eXBlOiBcInVpbnQyNTZcIiB9LFxuICAgICAgICAgIHsgbmFtZTogXCJncm9zc1wiLCB0eXBlOiBcInVpbnQyNTZcIiB9LFxuICAgICAgICAgIHsgbmFtZTogXCJmZWVcIiwgdHlwZTogXCJ1aW50MjU2XCIgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgICB7IG5hbWU6IFwiZHVwbGljYXRlXCIsIHR5cGU6IFwiYm9vbFwiIH0sXG4gICAgXSxcbiAgfSxcbiAge1xuICAgIHR5cGU6IFwiZnVuY3Rpb25cIixcbiAgICBuYW1lOiBcImNhbmNlbE9yZGVyXCIsXG4gICAgc3RhdGVNdXRhYmlsaXR5OiBcIm5vbnBheWFibGVcIixcbiAgICBpbnB1dHM6IFt7IG5hbWU6IFwib3JkZXJJZFwiLCB0eXBlOiBcInVpbnQyNTZcIiB9XSxcbiAgICBvdXRwdXRzOiBbeyBuYW1lOiBcInJlZnVuZGVkQW1vdW50XCIsIHR5cGU6IFwidWludDI1NlwiIH1dLFxuICB9LFxuICB7XG4gICAgdHlwZTogXCJmdW5jdGlvblwiLFxuICAgIG5hbWU6IFwidG90YWxMb2NrZWRcIixcbiAgICBzdGF0ZU11dGFiaWxpdHk6IFwidmlld1wiLFxuICAgIGlucHV0czogW3sgbmFtZTogXCJ0b2tlblwiLCB0eXBlOiBcImFkZHJlc3NcIiB9XSxcbiAgICBvdXRwdXRzOiBbeyBuYW1lOiBcImFtb3VudFwiLCB0eXBlOiBcInVpbnQyNTZcIiB9XSxcbiAgfSxcbiAge1xuICAgIHR5cGU6IFwiZXZlbnRcIixcbiAgICBuYW1lOiBcIk9yZGVyQ3JlYXRlZFwiLFxuICAgIGFub255bW91czogZmFsc2UsXG4gICAgaW5wdXRzOiBbXG4gICAgICB7IGluZGV4ZWQ6IHRydWUsIG5hbWU6IFwib3JkZXJJZFwiLCB0eXBlOiBcInVpbnQyNTZcIiB9LFxuICAgICAgeyBpbmRleGVkOiB0cnVlLCBuYW1lOiBcImNsaWVudE9yZGVySWRcIiwgdHlwZTogXCJieXRlczMyXCIgfSxcbiAgICAgIHsgaW5kZXhlZDogdHJ1ZSwgbmFtZTogXCJtYWtlclwiLCB0eXBlOiBcImFkZHJlc3NcIiB9LFxuICAgICAgeyBpbmRleGVkOiBmYWxzZSwgbmFtZTogXCJpc1NlbGxcIiwgdHlwZTogXCJib29sXCIgfSxcbiAgICAgIHsgaW5kZXhlZDogZmFsc2UsIG5hbWU6IFwiYXNzZXRUb2tlblwiLCB0eXBlOiBcImFkZHJlc3NcIiB9LFxuICAgICAgeyBpbmRleGVkOiBmYWxzZSwgbmFtZTogXCJjdXJyZW5jeVRva2VuXCIsIHR5cGU6IFwiYWRkcmVzc1wiIH0sXG4gICAgICB7IGluZGV4ZWQ6IGZhbHNlLCBuYW1lOiBcInByaWNlXCIsIHR5cGU6IFwidWludDI1NlwiIH0sXG4gICAgICB7IGluZGV4ZWQ6IGZhbHNlLCBuYW1lOiBcInF1YW50aXR5XCIsIHR5cGU6IFwidWludDI1NlwiIH0sXG4gICAgICB7IGluZGV4ZWQ6IGZhbHNlLCBuYW1lOiBcImxpc3RpbmdGZWVcIiwgdHlwZTogXCJ1aW50MjU2XCIgfSxcbiAgICBdLFxuICB9LFxuICB7XG4gICAgdHlwZTogXCJldmVudFwiLFxuICAgIG5hbWU6IFwiT3JkZXJGaWxsZWRcIixcbiAgICBhbm9ueW1vdXM6IGZhbHNlLFxuICAgIGlucHV0czogW1xuICAgICAgeyBpbmRleGVkOiB0cnVlLCBuYW1lOiBcImZpbGxLZXlcIiwgdHlwZTogXCJieXRlczMyXCIgfSxcbiAgICAgIHsgaW5kZXhlZDogdHJ1ZSwgbmFtZTogXCJvcmRlcklkXCIsIHR5cGU6IFwidWludDI1NlwiIH0sXG4gICAgICB7IGluZGV4ZWQ6IHRydWUsIG5hbWU6IFwiYnV5ZXJcIiwgdHlwZTogXCJhZGRyZXNzXCIgfSxcbiAgICAgIHsgaW5kZXhlZDogZmFsc2UsIG5hbWU6IFwic2VsbGVyXCIsIHR5cGU6IFwiYWRkcmVzc1wiIH0sXG4gICAgICB7IGluZGV4ZWQ6IGZhbHNlLCBuYW1lOiBcImFzc2V0VG9rZW5cIiwgdHlwZTogXCJhZGRyZXNzXCIgfSxcbiAgICAgIHsgaW5kZXhlZDogZmFsc2UsIG5hbWU6IFwiY3VycmVuY3lUb2tlblwiLCB0eXBlOiBcImFkZHJlc3NcIiB9LFxuICAgICAgeyBpbmRleGVkOiBmYWxzZSwgbmFtZTogXCJxdWFudGl0eVwiLCB0eXBlOiBcInVpbnQyNTZcIiB9LFxuICAgICAgeyBpbmRleGVkOiBmYWxzZSwgbmFtZTogXCJwcmljZVwiLCB0eXBlOiBcInVpbnQyNTZcIiB9LFxuICAgICAgeyBpbmRleGVkOiBmYWxzZSwgbmFtZTogXCJncm9zc1wiLCB0eXBlOiBcInVpbnQyNTZcIiB9LFxuICAgICAgeyBpbmRleGVkOiBmYWxzZSwgbmFtZTogXCJmZWVcIiwgdHlwZTogXCJ1aW50MjU2XCIgfSxcbiAgICAgIHsgaW5kZXhlZDogZmFsc2UsIG5hbWU6IFwiY3VycmVuY3lSZWxlYXNlZFwiLCB0eXBlOiBcInVpbnQyNTZcIiB9LFxuICAgIF0sXG4gIH0sXG4gIHtcbiAgICB0eXBlOiBcImV2ZW50XCIsXG4gICAgbmFtZTogXCJPcmRlckNhbmNlbGxlZFwiLFxuICAgIGFub255bW91czogZmFsc2UsXG4gICAgaW5wdXRzOiBbXG4gICAgICB7IGluZGV4ZWQ6IHRydWUsIG5hbWU6IFwib3JkZXJJZFwiLCB0eXBlOiBcInVpbnQyNTZcIiB9LFxuICAgICAgeyBpbmRleGVkOiB0cnVlLCBuYW1lOiBcIm1ha2VyXCIsIHR5cGU6IFwiYWRkcmVzc1wiIH0sXG4gICAgICB7IGluZGV4ZWQ6IGZhbHNlLCBuYW1lOiBcInJlZnVuZGVkQW1vdW50XCIsIHR5cGU6IFwidWludDI1NlwiIH0sXG4gICAgXSxcbiAgfSxcbl0gYXMgY29uc3Q7XG5cbmV4cG9ydCBjb25zdCBSRUxBWUVSX0NIQUlOID0gYmFzZVNlcG9saWE7XG5jb25zdCBSUENfVVJMID0gcHJvY2Vzcy5lbnYuQkFTRV9TRVBPTElBX1JQQ19VUkwgfHwgXCJodHRwczovL3NlcG9saWEuYmFzZS5vcmdcIjtcbmNvbnN0IFJQQ19GQUxMQkFDS19VUkwgPSBcImh0dHBzOi8vYmFzZS1zZXBvbGlhLXJwYy5wdWJsaWNub2RlLmNvbVwiO1xuY29uc3QgcnBjVHJhbnNwb3J0ID0gZmFsbGJhY2soW2h0dHAoUlBDX1VSTCksIGh0dHAoUlBDX0ZBTExCQUNLX1VSTCldKTtcblxuLy8gXHU1NDA4XHU3RDA0XHU1NzMwXHU1NzQwXHU0RTAwXHU1RjhCXHU0RUU1XHU0RTBCXHU2NUI5XHU3ODZDXHU3REU4XHU3OEJDXHU3Njg0XHUzMDBDXHU2NUIwXHU5MEU4XHU3RjcyXHUzMDBEXHU0RjREXHU1NzQwXHU3MEJBXHU1NTJGXHU0RTAwXHU3NzFGXHU3NkY4XHU0Rjg2XHU2RTkwXHVGRjBDKipcdTUyM0JcdTYxMEZcdTRFMERcdTUxOERcdThCODBcdTUzRDZcbi8vIE5FWFRfUFVCTElDXypfQUREUkVTUyBcdTc0QjBcdTU4ODNcdThCOEFcdTY1NzgqKlx1RkYxQVx1NUMwOFx1Njg0OFx1NzRCMFx1NTg4M1x1OEI4QVx1NjU3OFx1ODhFMVx1OTBBM1x1NjI3OSBORVhUX1BVQkxJQ18qX0FERFJFU1Ncbi8vIFx1NEVDRFx1NzU1OVx1ODQ1N1x1NEUwQVx1NEUwMFx1NjI3OVx1RkYwOFx1ODIwQVx1RkYwOVx1OTBFOFx1N0Y3Mlx1NzY4NFx1NEY0RFx1NTc0MFx1RkYwQ1x1NUY4Q1x1N0FFRiBzZXJ2ZXJsZXNzIFx1OEI4MFx1NUY5N1x1NTIzMFx1RkYwQ1x1NEUwMFx1NjVFNlx1ODhBQlx1OEI4MFx1NTIzMCByZWxheWVyIFx1NUMzMVxuLy8gXHU2NzAzXHU2MjhBIEpDL1x1OEE4RFx1OENGQy9cdTYyMTBcdTRFQTRcdTdENTBcdTdCOTdcdTkwMDFcdTUyMzBcdTgyMEFcdTU0MDhcdTdEMDRcdTRFMEFcdUZGMDhcdTRGOEJcdUZGMUFKQyBcdTgyMEFcdTU0MDhcdTdEMDQgMHhhODVlMDY2NFx1MjAyNlx1RkYwOVx1MzAwMlx1ODk4MVx1NjNEQlx1NTQwOFx1N0QwNFx1NjY0MlxuLy8gXHU3NkY0XHU2M0E1XHU2NTM5XHU0RTBCXHU5NzYyXHU5MDE5XHU1RTdFXHU4ODRDXHU1MzczXHU1M0VGXHVGRjBDXHU0RTI2XHU1NDBDXHU2QjY1IHNyYy9saWIvY29udHJhY3RzLnRzXHUzMDAyXG5leHBvcnQgY29uc3QgUkVMQVlFUl9BRERSRVNTRVMgPSB7XG4gIHJ3YU1hc3Rlcjogbm9ybWFsaXplT3JUaHJvdyh1bmRlZmluZWQsIFwiMHg3OUYxQzZhREZDY0Q5MTZjZGU2NjhEODhhNmRkYTM5MThlNWQ2ODM1XCIsIFwiUldBIFx1OTQ0NFx1OTAyMFx1NURFNVx1NUVFMFx1NTQwOFx1N0QwNFwiKSxcbiAgcndhUHJpbWFyeVNhbGU6IG5vcm1hbGl6ZU9yVGhyb3codW5kZWZpbmVkLCBcIjB4MUJGOUJmZDVjRkY5MEEzMzA3Y2U0QWFEMDA5OEExQUFFYUJFYWVkMFwiLCBcIlJXQSBcdTRFMDBcdTdEMUFcdThBOERcdThDRkNcdTU0MDhcdTdEMDRcIiksXG4gIHJ3YVNlY29uZGFyeU1hcmtldDogbm9ybWFsaXplT3JUaHJvdyh1bmRlZmluZWQsIFwiMHg5NjE3Yjc1MTQ0NWI4REY3ZjFjNTdmMTBiMTIwNjU3MDBjN2E2MTE3XCIsIFwiUldBIFx1NEU4Q1x1N0QxQVx1NUUwMlx1NTgzNFx1NTQwOFx1N0QwNFwiKSxcbiAgLy8gMjAyNi0xMC0wNCBcdTkxQ0RcdTY1QjBcdTkwRThcdTdGNzJcdUZGMDhjb250cmFjdHMvSkNUb2tlbi5zb2xcdUZGMDlcdUZGMUFcdTc5RkJcdTk2NjRcdTgyMEFcdTU0MDhcdTdEMDRcdTc2ODQgUDJQIFx1OEY0OVx1NUUzM1x1OTY1MFx1NTIzNlx1RkYwQ1xuICAvLyBvd25lciBcdTRGRERcdTc1NTkgbWludCBcdTZCMEFcdTk2NTBcdTUzRUZcdTUxOERcdTU4OUVcdTc2N0NcdTMwMDJcdTU0MENcdTZCNjUgc3JjL2xpYi9jb250cmFjdHMudHNcdTMwMDJcbiAgamNUb2tlbjogbm9ybWFsaXplT3JUaHJvdyh1bmRlZmluZWQsIFwiMHhFMDM1ZDVBNzk2NjQ4NDMwODlGOUVlOUY4ZEEyOTgwY2ZCNWVFNEQ5XCIsIFwiSkMgXHU3RDUwXHU3Qjk3XHU0RUUzXHU1RTYzXHU1NDA4XHU3RDA0XCIpLFxuICAvLyBcdTYyNEJcdTdFOENcdThDQkIgLyBcdThBOERcdThDRkMgSkMgXHU3Njg0XHU2NTM2XHU2QjNFXHU5MUQxXHU1RUFCXHUzMDAySkMvQUUgXHU3NjdDXHU2NTNFXHU3RDY2XHU0RjdGXHU3NTI4XHU4MDA1XHU1REYyXHU2NTM5XHU3MEJBIEFETUlOIFx1NzFCMVx1OTMyMlx1NTMwNVx1NzZGNFx1NjNBNVxuICAvLyB0cmFuc2Zlclx1RkYwQ1x1NEUwRFx1NTE4RFx1NUY5RVx1OTAxOVx1ODhFMSB0cmFuc2ZlckZyb21cdUZGMUJcdTkwMTlcdTUwMEJcdTU3MzBcdTU3NDBcdTUwQzVcdTRGRERcdTc1NTlcdTRGOUJcdTRFQkFcdTVERTVcdTg4RENcdThDQThcdThGNDlcdTVFMzNcdTY2NDJcdTUzQzNcdTgwMDNcdUZGMENcbiAgLy8gXHU3QTBCXHU1RjBGXHU3OEJDXHU0RTJEXHU0RTBEXHU2NzAzXHU1MThEXHU4QjgwXHU1M0Q2XHU2MjE2XHU1MkQ1XHU3NTI4XHU5MDE5XHU1MDBCXHU1NzMwXHVGRkZEXHVGRkZEXHU3Njg0XHU4Q0M3XHU3NTIyXHUzMDAyXG4gIHNhZmVWYXVsdDogbm9ybWFsaXplT3JUaHJvdyh1bmRlZmluZWQsIFwiMHhlODg2ZTY3ZmQ5Q0ZlNjZmZGIwQTFGNDdjRWYwMDAxNTQ4YTA3OGNmXCIsIFwiU2FmZSBcdTkxRDFcdTVFQUJcIiksXG4gIHVzZHQ6IG5vcm1hbGl6ZU9yVGhyb3codW5kZWZpbmVkLCBcIjB4MWQ2RTBlQzdlZjY1ODc1OEE1YjNEYzUxODQyMkUzMDJBNTQzNkI4NVwiLCBcIlVTRFQgXHU2RTJDXHU4QTY2XHU0RUUzXHU1RTYzXCIpLFxuICAvLyAyMDI2LTEwLTA0IFx1OTFDRFx1NjVCMFx1OTBFOFx1N0Y3Mlx1RkYwOGNvbnRyYWN0cy9BRVRva2VuLnNvbFx1RkYwOVx1RkYxQVx1NzlGQlx1OTY2NFx1ODIwQVx1NTQwOFx1N0QwNFx1NzY4NFx1MzAwQ0FFIFAyUCBcdThGNDlcdTVFMzNcdTk2NTBcdTUyMzZcdTMwMERcdUZGMENcbiAgLy8gXHU0RThDXHU3RDFBXHU1RTAyXHU1ODM0XHU1M0VGXHU3NkY0XHU2M0E1IHRyYW5zZmVyRnJvbShcdThDRTNcdTY1QjlcdTIxOTJcdThDQjdcdTY1QjkpIFx1NEUwMFx1NkIyMVx1NEVBNFx1NTI3Mlx1RkYxQm93bmVyIFx1NEZERFx1NzU1OSBtaW50IFx1NkIwQVx1OTY1MFx1MzAwMlxuICAvLyBcdTU0MENcdTZCNjUgc3JjL2xpYi9jb250cmFjdHMudHNcdTMwMDJcbiAgYWVUb2tlbjogbm9ybWFsaXplT3JUaHJvdyh1bmRlZmluZWQsIFwiMHg2MjQ1MmM0ZmQ2OTUwRDJCNUJhRTI1MUYzOWYwODI5MDBENDNCMzdmXCIsIFwiQUUgXHU0RUUzXHU1RTYzXHU1NDA4XHU3RDA0XCIpLFxuICBhZVByaW1hcnlTYWxlOiBub3JtYWxpemVPclRocm93KHVuZGVmaW5lZCwgXCIweDAwNmE1ODVmMEI0YURGMDY2M0RjMjE3NUE4MkQ2QmFiYkRjNWUzQTRcIiwgXCJBRSBcdTRFMDBcdTdEMUFcdThBOERcdThDRkNcdTU0MDhcdTdEMDRcIiksXG4gIGFlU2Vjb25kYXJ5TWFya2V0OiBub3JtYWxpemVPclRocm93KFxuICAgIHVuZGVmaW5lZCxcbiAgICBcIjB4ODM1RDYxRkY2OTc0M0IwZjVGMzkyMjNiYTQ1RjUwNjJBN0E1RTVjOVwiLFxuICAgIFwiQUUgXHU0RThDXHU3RDFBXHU1RTAyXHU1ODM0XHU1NDA4XHU3RDA0XCIsXG4gICksXG4gIC8vIDIwMjYtMTAtMDQgXHU2NUIwXHU5MEU4XHU3RjcyXHU3Njg0IFJXQSBGYWN0b3J5XHVGRjBDXHU4Q0EwXHU4Q0FDXHU1RUZBXHU3QUNCXHU2QTE5XHU3Njg0XHU0RUUzXHU1RTYzXHU4MjA3XHU3QkExXHU3NDA2IFNhZmUgXHU2NzJBXHU1NTJFXHU1RUFCXHU1QjU4XHUzMDAyXG4gIHJ3YUZhY3Rvcnk6IG5vcm1hbGl6ZU9yVGhyb3codW5kZWZpbmVkLCBcIjB4RDQ1MzQ1NDExOEJBOGI3NmU2OEMxNmY2QmM5NjUzNDk3OTRFZEY5QVwiLCBcIlJXQSBGYWN0b3J5IFx1NTQwOFx1N0QwNFwiKSxcbn0gYXMgY29uc3Q7XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZU9yVGhyb3coZW52VmFsdWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2s6IHN0cmluZywgbGFiZWw6IHN0cmluZyk6IEFkZHJlc3Mge1xuICB0cnkge1xuICAgIHJldHVybiBnZXRBZGRyZXNzKChlbnZWYWx1ZSA/PyBmYWxsYmFjaykudHJpbSgpKTtcbiAgfSBjYXRjaCB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGAke2xhYmVsfSBcdTU3MzBcdTU3NDBcdTY4M0NcdTVGMEZcdTkzMkZcdThBQTRgKTtcbiAgfVxufVxuXG4vLyBKQy9BRSBcdTkwRkRcdTY2MkZcdTZBMTlcdTZFOTYgRVJDLTIwXHVGRjA4XHU2NUIwXHU5MEU4XHU3RjcyXHVGRjBDXHU3MTIxIG1pbnQgLyBtYXJrZXQgLyBzYWZlVmF1bHQgXHU3QjQ5XHU4MUVBXHU4QTAyXHU1MUZEXHU1RjBGXHVGRjA5XHUzMDAyXG4vLyBcdTc2N0NcdTY1M0VcdTdENjZcdTRGN0ZcdTc1MjhcdTgwMDVcdTRFMDBcdTVGOEJcdTc1MzEgQURNSU4gXHU3MUIxXHU5MzIyXHU1MzA1XHU3NkY0XHU2M0E1IHRyYW5zZmVyKHRvLCBhbW91bnQpXHVGRjA4XHU1MkQ1XHU3NTI4XHU4MUVBXHU1REYxXHU3Njg0XHU5OTE4XHU5ODREXHVGRjBDXG4vLyBcdTRFMERcdTdEOTNcdTkwNEUgYXBwcm92ZS9hbGxvd2FuY2VcdUZGMDlcdUZGMENcdTU2RTBcdTZCNjRcdTUzRUFcdTY1M0VcdTY3MkNcdTZBMjFcdTdENDRcdTVCRTZcdTk2OUJcdTY3MDNcdTU0N0NcdTUzRUJcdTUyMzBcdTc2ODRcdTUxRkRcdTVGMEZcdUZGMUF0cmFuc2Zlclx1MzAwMVxuLy8gYmFsYW5jZU9mXHVGRjA4XHU3NjdDXHU2NTNFXHU1MjREXHU3Njg0XHU1RUFCXHU1QjU4XHU5ODEwXHU2QUEyXHU2N0U1XHVGRjA5XHUzMDAxZGVjaW1hbHNcdTMwMDJcbmNvbnN0IGVyYzIwTWluaW1hbEFiaSA9IFtcbiAge1xuICAgIGlucHV0czogW1xuICAgICAgeyBuYW1lOiBcInRvXCIsIHR5cGU6IFwiYWRkcmVzc1wiIH0sXG4gICAgICB7IG5hbWU6IFwiYW1vdW50XCIsIHR5cGU6IFwidWludDI1NlwiIH0sXG4gICAgXSxcbiAgICBuYW1lOiBcInRyYW5zZmVyXCIsXG4gICAgb3V0cHV0czogW3sgdHlwZTogXCJib29sXCIgfV0sXG4gICAgc3RhdGVNdXRhYmlsaXR5OiBcIm5vbnBheWFibGVcIixcbiAgICB0eXBlOiBcImZ1bmN0aW9uXCIsXG4gIH0sXG4gIHsgaW5wdXRzOiBbeyBuYW1lOiBcImFjY291bnRcIiwgdHlwZTogXCJhZGRyZXNzXCIgfV0sIG5hbWU6IFwiYmFsYW5jZU9mXCIsIG91dHB1dHM6IFt7IHR5cGU6IFwidWludDI1NlwiIH1dLCBzdGF0ZU11dGFiaWxpdHk6IFwidmlld1wiLCB0eXBlOiBcImZ1bmN0aW9uXCIgfSxcbiAgeyBpbnB1dHM6IFtdLCBuYW1lOiBcImRlY2ltYWxzXCIsIG91dHB1dHM6IFt7IHR5cGU6IFwidWludDhcIiB9XSwgc3RhdGVNdXRhYmlsaXR5OiBcInZpZXdcIiwgdHlwZTogXCJmdW5jdGlvblwiIH0sXG4gIHsgaW5wdXRzOiBbeyBuYW1lOiBcIm93bmVyXCIsIHR5cGU6IFwiYWRkcmVzc1wiIH0sIHsgbmFtZTogXCJzcGVuZGVyXCIsIHR5cGU6IFwiYWRkcmVzc1wiIH1dLCBuYW1lOiBcImFsbG93YW5jZVwiLCBvdXRwdXRzOiBbeyB0eXBlOiBcInVpbnQyNTZcIiB9XSwgc3RhdGVNdXRhYmlsaXR5OiBcInZpZXdcIiwgdHlwZTogXCJmdW5jdGlvblwiIH0sXG4gIHsgaW5wdXRzOiBbeyBuYW1lOiBcInNwZW5kZXJcIiwgdHlwZTogXCJhZGRyZXNzXCIgfSwgeyBuYW1lOiBcInZhbHVlXCIsIHR5cGU6IFwidWludDI1NlwiIH1dLCBuYW1lOiBcImFwcHJvdmVcIiwgb3V0cHV0czogW3sgdHlwZTogXCJib29sXCIgfV0sIHN0YXRlTXV0YWJpbGl0eTogXCJub25wYXlhYmxlXCIsIHR5cGU6IFwiZnVuY3Rpb25cIiB9LFxuICB7XG4gICAgaW5wdXRzOiBbXG4gICAgICB7IG5hbWU6IFwiZnJvbVwiLCB0eXBlOiBcImFkZHJlc3NcIiB9LFxuICAgICAgeyBuYW1lOiBcInRvXCIsIHR5cGU6IFwiYWRkcmVzc1wiIH0sXG4gICAgICB7IG5hbWU6IFwiYW1vdW50XCIsIHR5cGU6IFwidWludDI1NlwiIH0sXG4gICAgXSxcbiAgICBuYW1lOiBcInRyYW5zZmVyRnJvbVwiLFxuICAgIG91dHB1dHM6IFt7IHR5cGU6IFwiYm9vbFwiIH1dLFxuICAgIHN0YXRlTXV0YWJpbGl0eTogXCJub25wYXlhYmxlXCIsXG4gICAgdHlwZTogXCJmdW5jdGlvblwiLFxuICB9LFxuXSBhcyBjb25zdDtcbmNvbnN0IGpjQWJpID0gZXJjMjBNaW5pbWFsQWJpO1xuLy8gQUUgXHU0RUUzXHU1RTYzXHVGRjA4MjAyNi0xMC0wNCBcdTRFOENcdTZCMjFcdTkxQ0RcdTY1QjBcdTkwRThcdTdGNzJcdUZGMDlcdTk4NERcdTU5MTZcdTU5MUFcdTRFODYgb3duZXItb25seSBcdTc2ODQgYWRtaW5SZWNsYWltKGZyb20sdG8sYW1vdW50KVx1RkYxQVxuLy8gXHU0RTBEXHU1M0Q3IGFsbG93YW5jZSBcdTk2NTBcdTUyMzZcdTc2ODRcdTVGMzdcdTUyMzZcdTY1MzZcdTU2REVcdUZGMENcdTc1MjhcdTY1QkNcdTMwMENBRSBcdTZCNzhcdTk2RjZcdTMwMERcdTYyOEFcdTRGN0ZcdTc1MjhcdTgwMDVcdTYzMDFcdTY3MDlcdTc2ODQgQUUgXHU1RjM3XHU1MjM2XHU2NTM2XHU1NkRFXHU5MUQxXHU1RUFCXHVGRjBDXG4vLyBcdTUzNzNcdTRGN0ZcdThBNzJcdTRGN0ZcdTc1MjhcdTgwMDVcdTVGOUVcdTY3MkFcdTVDMEQgQURNSU4gXHU1MDVBXHU5MDRFIGFwcHJvdmUgXHU0RTVGXHU4MEZEXHU2NTM2XHU1NkRFXHUzMDAyXG5jb25zdCBhZUFiaSA9IFtcbiAgLi4uZXJjMjBNaW5pbWFsQWJpLFxuICB7XG4gICAgaW5wdXRzOiBbXG4gICAgICB7IG5hbWU6IFwiZnJvbVwiLCB0eXBlOiBcImFkZHJlc3NcIiB9LFxuICAgICAgeyBuYW1lOiBcInRvXCIsIHR5cGU6IFwiYWRkcmVzc1wiIH0sXG4gICAgICB7IG5hbWU6IFwiYW1vdW50XCIsIHR5cGU6IFwidWludDI1NlwiIH0sXG4gICAgXSxcbiAgICBuYW1lOiBcImFkbWluUmVjbGFpbVwiLFxuICAgIG91dHB1dHM6IFtdLFxuICAgIHN0YXRlTXV0YWJpbGl0eTogXCJub25wYXlhYmxlXCIsXG4gICAgdHlwZTogXCJmdW5jdGlvblwiLFxuICB9LFxuXSBhcyBjb25zdDtcblxuY29uc3QgcndhQWJpID0gW1xuICB7IGlucHV0czogW3sgbmFtZTogXCJ0b1wiLCB0eXBlOiBcImFkZHJlc3NcIiB9LCB7IG5hbWU6IFwiYW1vdW50XCIsIHR5cGU6IFwidWludDI1NlwiIH1dLCBuYW1lOiBcIm1pbnRcIiwgb3V0cHV0czogW10sIHN0YXRlTXV0YWJpbGl0eTogXCJub25wYXlhYmxlXCIsIHR5cGU6IFwiZnVuY3Rpb25cIiB9LFxuICB7IGlucHV0czogW3sgbmFtZTogXCJtXCIsIHR5cGU6IFwiYWRkcmVzc1wiIH1dLCBuYW1lOiBcInNldE1hcmtldENvbnRyYWN0XCIsIG91dHB1dHM6IFtdLCBzdGF0ZU11dGFiaWxpdHk6IFwibm9ucGF5YWJsZVwiLCB0eXBlOiBcImZ1bmN0aW9uXCIgfSxcbiAgeyBpbnB1dHM6IFt7IG5hbWU6IFwic1wiLCB0eXBlOiBcImFkZHJlc3NcIiB9XSwgbmFtZTogXCJzZXRTdWJzY3JpcHRpb25Db250cmFjdFwiLCBvdXRwdXRzOiBbXSwgc3RhdGVNdXRhYmlsaXR5OiBcIm5vbnBheWFibGVcIiwgdHlwZTogXCJmdW5jdGlvblwiIH0sXG4gIHsgaW5wdXRzOiBbXSwgbmFtZTogXCJtYXJrZXRDb250cmFjdFwiLCBvdXRwdXRzOiBbeyB0eXBlOiBcImFkZHJlc3NcIiB9XSwgc3RhdGVNdXRhYmlsaXR5OiBcInZpZXdcIiwgdHlwZTogXCJmdW5jdGlvblwiIH0sXG4gIHsgaW5wdXRzOiBbXSwgbmFtZTogXCJzdWJzY3JpcHRpb25Db250cmFjdFwiLCBvdXRwdXRzOiBbeyB0eXBlOiBcImFkZHJlc3NcIiB9XSwgc3RhdGVNdXRhYmlsaXR5OiBcInZpZXdcIiwgdHlwZTogXCJmdW5jdGlvblwiIH0sXG4gIHsgaW5wdXRzOiBbXSwgbmFtZTogXCJkZWNpbWFsc1wiLCBvdXRwdXRzOiBbeyB0eXBlOiBcInVpbnQ4XCIgfV0sIHN0YXRlTXV0YWJpbGl0eTogXCJ2aWV3XCIsIHR5cGU6IFwiZnVuY3Rpb25cIiB9LFxuICB7IGlucHV0czogW10sIG5hbWU6IFwib3duZXJcIiwgb3V0cHV0czogW3sgdHlwZTogXCJhZGRyZXNzXCIgfV0sIHN0YXRlTXV0YWJpbGl0eTogXCJ2aWV3XCIsIHR5cGU6IFwiZnVuY3Rpb25cIiB9LFxuXSBhcyBjb25zdDtcblxuLy8gUldBIEZhY3RvcnkgXHU3NTI4XHU2NUJDXHU1RUZBXHU3QUNCXHU0RUZEXHU5ODREXHU0RUUzXHU1RTYzXHUzMDAxXHU2N0U1XHU4QTYyXHU3NkVFXHU1MjREXHU0RUUzXHU1RTYzXHUzMDAxXHU3OEJBXHU4QThEXHU0RUUzXHU1RTYzXHU2Qjc4XHU1QzZDXHU0RTI2XHU3QkExXHU3NDA2IFNhZmUgXHU1RUFCXHU1QjU4XHUzMDAyXG5cbmNvbnN0IHJ3YUZhY3RvcnlBYmkgPSBbXG4gIHtcbiAgICBpbnB1dHM6IFtcbiAgICAgIHsgbmFtZTogXCJ0b2tlblwiLCB0eXBlOiBcImFkZHJlc3NcIiB9LFxuICAgICAgeyBuYW1lOiBcImhvbGRlclwiLCB0eXBlOiBcImFkZHJlc3NcIiB9LFxuICAgIF0sXG4gICAgbmFtZTogXCJyZWNsYWltU2hhcmVzXCIsXG4gICAgb3V0cHV0czogW3sgbmFtZTogXCJhbW91bnRcIiwgdHlwZTogXCJ1aW50MjU2XCIgfV0sXG4gICAgc3RhdGVNdXRhYmlsaXR5OiBcIm5vbnBheWFibGVcIixcbiAgICB0eXBlOiBcImZ1bmN0aW9uXCIsXG4gIH0sXG4gIHtcbiAgICBpbnB1dHM6IFt7IG5hbWU6IFwidG9rZW5cIiwgdHlwZTogXCJhZGRyZXNzXCIgfSwgeyBuYW1lOiBcImFtb3VudFwiLCB0eXBlOiBcInVpbnQyNTZcIiB9XSxcbiAgICBuYW1lOiBcImJ1cm5WYXVsdEludmVudG9yeVwiLFxuICAgIG91dHB1dHM6IFtdLFxuICAgIHN0YXRlTXV0YWJpbGl0eTogXCJub25wYXlhYmxlXCIsXG4gICAgdHlwZTogXCJmdW5jdGlvblwiLFxuICB9LFxuICB7IGlucHV0czogW3sgbmFtZTogXCJ0b2tlblwiLCB0eXBlOiBcImFkZHJlc3NcIiB9XSwgbmFtZTogXCJpc0ZhY3RvcnlUb2tlblwiLCBvdXRwdXRzOiBbeyB0eXBlOiBcImJvb2xcIiB9XSwgc3RhdGVNdXRhYmlsaXR5OiBcInZpZXdcIiwgdHlwZTogXCJmdW5jdGlvblwiIH0sXG4gIHsgaW5wdXRzOiBbXSwgbmFtZTogXCJzYWZlVmF1bHRcIiwgb3V0cHV0czogW3sgdHlwZTogXCJhZGRyZXNzXCIgfV0sIHN0YXRlTXV0YWJpbGl0eTogXCJ2aWV3XCIsIHR5cGU6IFwiZnVuY3Rpb25cIiB9LFxuICB7XG4gICAgaW5wdXRzOiBbXG4gICAgICB7IG5hbWU6IFwicGxhY2VtZW50SWRcIiwgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgeyBuYW1lOiBcIm5hbWVfXCIsIHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgIHsgbmFtZTogXCJzeW1ib2xfXCIsIHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgIHsgbmFtZTogXCJkZWNpbWFsc19cIiwgdHlwZTogXCJ1aW50OFwiIH0sXG4gICAgICB7IG5hbWU6IFwidG90YWxTdXBwbHlfXCIsIHR5cGU6IFwidWludDI1NlwiIH0sXG4gICAgXSxcbiAgICBuYW1lOiBcImNyZWF0ZVJXQVRva2VuXCIsXG4gICAgb3V0cHV0czogW3sgbmFtZTogXCJ0b2tlblwiLCB0eXBlOiBcImFkZHJlc3NcIiB9XSxcbiAgICBzdGF0ZU11dGFiaWxpdHk6IFwibm9ucGF5YWJsZVwiLFxuICAgIHR5cGU6IFwiZnVuY3Rpb25cIixcbiAgfSxcbiAge1xuICAgIGlucHV0czogW1xuICAgICAgeyBuYW1lOiBcInRva2VuXCIsIHR5cGU6IFwiYWRkcmVzc1wiIH0sXG4gICAgICB7IG5hbWU6IFwiY3VycmVuY3lcIiwgdHlwZTogXCJhZGRyZXNzXCIgfSxcbiAgICAgIHsgbmFtZTogXCJidXllclwiLCB0eXBlOiBcImFkZHJlc3NcIiB9LFxuICAgICAgeyBuYW1lOiBcInNoYXJlQW1vdW50XCIsIHR5cGU6IFwidWludDI1NlwiIH0sXG4gICAgICB7IG5hbWU6IFwicGF5bWVudFwiLCB0eXBlOiBcInVpbnQyNTZcIiB9LFxuICAgIF0sXG4gICAgbmFtZTogXCJzdWJzY3JpYmVcIixcbiAgICBvdXRwdXRzOiBbXSxcbiAgICBzdGF0ZU11dGFiaWxpdHk6IFwibm9ucGF5YWJsZVwiLFxuICAgIHR5cGU6IFwiZnVuY3Rpb25cIixcbiAgfSxcbiAge1xuICAgIGlucHV0czogW1xuICAgICAgeyBuYW1lOiBcInRva2VuXCIsIHR5cGU6IFwiYWRkcmVzc1wiIH0sXG4gICAgICB7IG5hbWU6IFwiY3VycmVuY3lcIiwgdHlwZTogXCJhZGRyZXNzXCIgfSxcbiAgICAgIHsgbmFtZTogXCJzZWxsZXJcIiwgdHlwZTogXCJhZGRyZXNzXCIgfSxcbiAgICAgIHsgbmFtZTogXCJidXllclwiLCB0eXBlOiBcImFkZHJlc3NcIiB9LFxuICAgICAgeyBuYW1lOiBcInNoYXJlQW1vdW50XCIsIHR5cGU6IFwidWludDI1NlwiIH0sXG4gICAgICB7IG5hbWU6IFwicGF5bWVudFRvU2VsbGVyXCIsIHR5cGU6IFwidWludDI1NlwiIH0sXG4gICAgICB7IG5hbWU6IFwiZmVlQW1vdW50XCIsIHR5cGU6IFwidWludDI1NlwiIH0sXG4gICAgXSxcbiAgICBuYW1lOiBcInRyYWRlXCIsXG4gICAgb3V0cHV0czogW10sXG4gICAgc3RhdGVNdXRhYmlsaXR5OiBcIm5vbnBheWFibGVcIixcbiAgICB0eXBlOiBcImZ1bmN0aW9uXCIsXG4gIH0sXG4gIHsgaW5wdXRzOiBbeyBuYW1lOiBcIlwiLCB0eXBlOiBcInN0cmluZ1wiIH1dLCBuYW1lOiBcInRva2VuQnlQbGFjZW1lbnRcIiwgb3V0cHV0czogW3sgdHlwZTogXCJhZGRyZXNzXCIgfV0sIHN0YXRlTXV0YWJpbGl0eTogXCJ2aWV3XCIsIHR5cGU6IFwiZnVuY3Rpb25cIiB9LFxuXSBhcyBjb25zdDtcblxuLy8gXHU2QkNGXHU1MDBCXHU2QTE5XHU3Njg0XHU0RTAwXHU5ODQ2XHU1QzA4XHU1QzZDXHU0RUZEXHU5ODREXHU0RUUzXHU1RTYzXHVGRjFCXHU1NzMwXHU1NzQwXHU3NTMxXHU3NkVFXHU1MjREIEZhY3RvcnkgXHU3Njg0IHRva2VuQnlQbGFjZW1lbnQgXHU2N0U1XHU1Rjk3XHVGRjBDXG4vLyBcdTRFMERcdTRGN0ZcdTc1MjhcdThDQzdcdTY1OTlcdTVFQUJcdTUxNjdcdTUzRUZcdTgwRkRcdTZCOThcdTc1NTlcdTc2ODRcdTgyMEFcdTRFRTNcdTVFNjNcdTU3MzBcdTU3NDBcdTMwMDJcbmNvbnN0IHNoYXJlVG9rZW5BYmkgPSBbXG4gIHsgaW5wdXRzOiBbXSwgbmFtZTogXCJkZWNpbWFsc1wiLCBvdXRwdXRzOiBbeyB0eXBlOiBcInVpbnQ4XCIgfV0sIHN0YXRlTXV0YWJpbGl0eTogXCJ2aWV3XCIsIHR5cGU6IFwiZnVuY3Rpb25cIiB9LFxuICB7IGlucHV0czogW3sgbmFtZTogXCJhY2NvdW50XCIsIHR5cGU6IFwiYWRkcmVzc1wiIH1dLCBuYW1lOiBcImJhbGFuY2VPZlwiLCBvdXRwdXRzOiBbeyB0eXBlOiBcInVpbnQyNTZcIiB9XSwgc3RhdGVNdXRhYmlsaXR5OiBcInZpZXdcIiwgdHlwZTogXCJmdW5jdGlvblwiIH0sXG4gIHsgaW5wdXRzOiBbeyBuYW1lOiBcIm93bmVyXCIsIHR5cGU6IFwiYWRkcmVzc1wiIH0sIHsgbmFtZTogXCJzcGVuZGVyXCIsIHR5cGU6IFwiYWRkcmVzc1wiIH1dLCBuYW1lOiBcImFsbG93YW5jZVwiLCBvdXRwdXRzOiBbeyB0eXBlOiBcInVpbnQyNTZcIiB9XSwgc3RhdGVNdXRhYmlsaXR5OiBcInZpZXdcIiwgdHlwZTogXCJmdW5jdGlvblwiIH0sXG4gIHsgaW5wdXRzOiBbeyBuYW1lOiBcInNwZW5kZXJcIiwgdHlwZTogXCJhZGRyZXNzXCIgfSwgeyBuYW1lOiBcInZhbHVlXCIsIHR5cGU6IFwidWludDI1NlwiIH1dLCBuYW1lOiBcImFwcHJvdmVcIiwgb3V0cHV0czogW3sgdHlwZTogXCJib29sXCIgfV0sIHN0YXRlTXV0YWJpbGl0eTogXCJub25wYXlhYmxlXCIsIHR5cGU6IFwiZnVuY3Rpb25cIiB9LFxuICB7IGlucHV0czogW3sgbmFtZTogXCJ0b1wiLCB0eXBlOiBcImFkZHJlc3NcIiB9LCB7IG5hbWU6IFwidmFsdWVcIiwgdHlwZTogXCJ1aW50MjU2XCIgfV0sIG5hbWU6IFwidHJhbnNmZXJcIiwgb3V0cHV0czogW3sgdHlwZTogXCJib29sXCIgfV0sIHN0YXRlTXV0YWJpbGl0eTogXCJub25wYXlhYmxlXCIsIHR5cGU6IFwiZnVuY3Rpb25cIiB9LFxuXSBhcyBjb25zdDtcblxuY29uc3Qgc2hhcmVUb2tlbkRlY2ltYWxzQ2FjaGUgPSBuZXcgTWFwPEFkZHJlc3MsIG51bWJlcj4oKTtcbmNvbnN0IGVyYzIwVHJhbnNmZXJFdmVudCA9IHBhcnNlQWJpSXRlbShcImV2ZW50IFRyYW5zZmVyKGFkZHJlc3MgaW5kZXhlZCBmcm9tLCBhZGRyZXNzIGluZGV4ZWQgdG8sIHVpbnQyNTYgdmFsdWUpXCIpO1xuXG5hc3luYyBmdW5jdGlvbiBhc3NlcnRDdXJyZW50RmFjdG9yeVRva2VuKHRva2VuOiBBZGRyZXNzKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGlzRmFjdG9yeVRva2VuID0gYXdhaXQgcHVibGljQ2xpZW50KCkucmVhZENvbnRyYWN0KHtcbiAgICBhZGRyZXNzOiBSRUxBWUVSX0FERFJFU1NFUy5yd2FGYWN0b3J5LFxuICAgIGFiaTogcndhRmFjdG9yeUFiaSxcbiAgICBmdW5jdGlvbk5hbWU6IFwiaXNGYWN0b3J5VG9rZW5cIixcbiAgICBhcmdzOiBbZ2V0QWRkcmVzcyh0b2tlbildLFxuICB9KTtcbiAgaWYgKCFpc0ZhY3RvcnlUb2tlbikgdGhyb3cgbmV3IEVycm9yKFwiXHU2QjY0IFJXQSBcdTRFRTNcdTVFNjNcdTRFMERcdTVDNkNcdTY1QkNcdTc2RUVcdTUyNEQgRmFjdG9yeVx1RkYwQ1x1NURGMlx1NTA1Q1x1NkI2Mlx1OEI4MFx1NTNENlx1ODIwN1x1ODY1NVx1NzQwNlwiKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldEN1cnJlbnRSd2FGYWN0b3J5VG9rZW4ocGxhY2VtZW50SWQ6IHN0cmluZyk6IFByb21pc2U8QWRkcmVzcyB8IG51bGw+IHtcbiAgY29uc3QgdmFsdWUgPSAoYXdhaXQgcHVibGljQ2xpZW50KCkucmVhZENvbnRyYWN0KHtcbiAgICBhZGRyZXNzOiBSRUxBWUVSX0FERFJFU1NFUy5yd2FGYWN0b3J5LFxuICAgIGFiaTogcndhRmFjdG9yeUFiaSxcbiAgICBmdW5jdGlvbk5hbWU6IFwidG9rZW5CeVBsYWNlbWVudFwiLFxuICAgIGFyZ3M6IFtwbGFjZW1lbnRJZC50cmltKCldLFxuICB9KSkgYXMgQWRkcmVzcztcbiAgaWYgKCF2YWx1ZSB8fCB2YWx1ZSA9PT0gXCIweDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDBcIikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHRva2VuID0gZ2V0QWRkcmVzcyh2YWx1ZSk7XG4gIGF3YWl0IGFzc2VydEN1cnJlbnRGYWN0b3J5VG9rZW4odG9rZW4pO1xuICByZXR1cm4gdG9rZW47XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHNoYXJlVG9rZW5EZWNpbWFscyh0b2tlbjogQWRkcmVzcyk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGF3YWl0IGFzc2VydEN1cnJlbnRGYWN0b3J5VG9rZW4odG9rZW4pO1xuICBjb25zdCBjYWNoZWQgPSBzaGFyZVRva2VuRGVjaW1hbHNDYWNoZS5nZXQodG9rZW4pO1xuICBpZiAoY2FjaGVkICE9IG51bGwpIHJldHVybiBjYWNoZWQ7XG4gIGxldCB2YWx1ZSA9IDE4O1xuICB0cnkge1xuICAgIHZhbHVlID0gTnVtYmVyKGF3YWl0IHB1YmxpY0NsaWVudCgpLnJlYWRDb250cmFjdCh7IGFkZHJlc3M6IHRva2VuLCBhYmk6IHNoYXJlVG9rZW5BYmksIGZ1bmN0aW9uTmFtZTogXCJkZWNpbWFsc1wiIH0pKTtcbiAgfSBjYXRjaCB7XG4gICAgdmFsdWUgPSAxODtcbiAgfVxuICBzaGFyZVRva2VuRGVjaW1hbHNDYWNoZS5zZXQodG9rZW4sIHZhbHVlKTtcbiAgcmV0dXJuIHZhbHVlO1xufVxuXG4vKipcbiAqIFx1NzBCQVx1NEUwMFx1NTAwQlx1NzlDMVx1NTJERlx1NkExOVx1NzY4NFx1OTBFOFx1N0Y3Mlx1NUMwOFx1NUM2QyBSV0EgXHU0RUZEXHU5ODREXHU0RUUzXHU1RTYzXHVGRjA4UldBIEZhY3RvcnkgY3JlYXRlUldBVG9rZW5cdUZGMDlcdUZGMENcdTYyOEFcdTUxNjhcdTk4NERcbiAqIFx1NEVGRFx1OTg0RFx1NEUwMFx1NkIyMVx1OTQ0NFx1N0Q2NiBTYWZlIFx1OTFEMVx1NUVBQlx1MzAwMlx1ODJFNVx1OEE3MiBwbGFjZW1lbnRJZCBcdTVERjJcdTVFRkFcdTdBQ0JcdTkwNEVcdTRFRTNcdTVFNjNcdUZGMDh0b2tlbkJ5UGxhY2VtZW50IFx1OTc1RVxuICogXHU5NkY2XHU1NzMwXHU1NzQwXHVGRjA5XHVGRjBDXHU3NkY0XHU2M0E1XHU1NkRFXHU1MEIzXHU2NUUyXHU2NzA5XHU1NzMwXHU1NzQwXHVGRjBDXHU0RTBEXHU5MUNEXHU4OTA3XHU1RUZBXHU3QUNCXHVGRjA4RmFjdG9yeSBcdTU0MDhcdTdEMDRcdTY3MkNcdThFQUJcdTRFNUZcdTY3MDNcdTY0Q0JcdUZGMENcdTkwMTlcdTg4RTFcdTUxNDhcdThCODBcbiAqIFx1NEUwMFx1NkIyMVx1OTA3Rlx1NTE0RFx1NkQ2QVx1OENCQlx1NEUwMFx1N0I0Nlx1NkNFOFx1NUI5QVx1NTkzMVx1NjU1N1x1NzY4NFx1NEVBNFx1NjYxM1x1RkYwOVx1MzAwMlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY3JlYXRlUndhRmFjdG9yeVRva2VuKFxuICBwbGFjZW1lbnRJZDogc3RyaW5nLFxuICBuYW1lOiBzdHJpbmcsXG4gIHN5bWJvbDogc3RyaW5nLFxuICBkZWNpbWFsczogbnVtYmVyLFxuICB0b3RhbFN1cHBseTogbnVtYmVyLFxuKTogUHJvbWlzZTx7IHRva2VuQWRkcmVzczogQWRkcmVzczsgdHhIYXNoOiBzdHJpbmc7IGFscmVhZHlFeGlzdGVkOiBib29sZWFuIH0+IHtcbiAgYXdhaXQgZW5zdXJlUmVsYXllckdhcygpO1xuICBjb25zdCBleGlzdGluZyA9IChhd2FpdCBwdWJsaWNDbGllbnQoKS5yZWFkQ29udHJhY3Qoe1xuICAgIGFkZHJlc3M6IFJFTEFZRVJfQUREUkVTU0VTLnJ3YUZhY3RvcnksXG4gICAgYWJpOiByd2FGYWN0b3J5QWJpLFxuICAgIGZ1bmN0aW9uTmFtZTogXCJ0b2tlbkJ5UGxhY2VtZW50XCIsXG4gICAgYXJnczogW3BsYWNlbWVudElkXSxcbiAgfSkpIGFzIEFkZHJlc3M7XG4gIGlmIChleGlzdGluZyAmJiBleGlzdGluZyAhPT0gXCIweDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDBcIikge1xuICAgIHJldHVybiB7IHRva2VuQWRkcmVzczogZ2V0QWRkcmVzcyhleGlzdGluZyksIHR4SGFzaDogXCJhbHJlYWR5LWV4aXN0c1wiLCBhbHJlYWR5RXhpc3RlZDogdHJ1ZSB9O1xuICB9XG4gIGNvbnN0IHRvdGFsU3VwcGx5VW5pdHMgPSBwYXJzZVVuaXRzKFN0cmluZyh0b3RhbFN1cHBseSksIGRlY2ltYWxzKTtcbiAgY29uc3QgaGFzaCA9IGF3YWl0IHNlbmRBZG1pblR4KChub25jZSkgPT5cbiAgICBhZG1pbldhbGxldENsaWVudCgpLndyaXRlQ29udHJhY3Qoe1xuICAgICAgYWRkcmVzczogUkVMQVlFUl9BRERSRVNTRVMucndhRmFjdG9yeSxcbiAgICAgIGFiaTogcndhRmFjdG9yeUFiaSxcbiAgICAgIGZ1bmN0aW9uTmFtZTogXCJjcmVhdGVSV0FUb2tlblwiLFxuICAgICAgYXJnczogW3BsYWNlbWVudElkLCBuYW1lLCBzeW1ib2wsIGRlY2ltYWxzLCB0b3RhbFN1cHBseVVuaXRzXSxcbiAgICAgIGNoYWluOiBSRUxBWUVSX0NIQUlOLFxuICAgICAgbm9uY2UsXG4gICAgfSksXG4gICk7XG4gIGF3YWl0IHdhaXRBbmRSZXR1cm4oaGFzaCk7XG4gIGNvbnN0IHRva2VuQWRkcmVzcyA9IChhd2FpdCBwdWJsaWNDbGllbnQoKS5yZWFkQ29udHJhY3Qoe1xuICAgIGFkZHJlc3M6IFJFTEFZRVJfQUREUkVTU0VTLnJ3YUZhY3RvcnksXG4gICAgYWJpOiByd2FGYWN0b3J5QWJpLFxuICAgIGZ1bmN0aW9uTmFtZTogXCJ0b2tlbkJ5UGxhY2VtZW50XCIsXG4gICAgYXJnczogW3BsYWNlbWVudElkXSxcbiAgfSkpIGFzIEFkZHJlc3M7XG4gIC8vIFx1Njk3NVx1NUMxMVx1NjU3OFx1NjBDNVx1NkNDMVx1NEUwQlx1RkYwOFJQQyBcdTVDMUFcdTY3MkFcdTU0MENcdTZCNjVcdTUyNUJcdTRFMEFcdTkzQzhcdTc2ODRcdTcyQzBcdTYxNEJcdUZGMDlcdTkwMTlcdTg4RTFcdTUzRUZcdTgwRkRcdThCODBcdTUyMzBcdTk2RjZcdTU3MzBcdTU3NDBcdTMwMDJcdTdENTVcdTRFMERcdTU2REVcdTUwQjNcdTk2RjZcdTU3MzBcdTU3NDBcbiAgLy8gXHU4QjkzXHU0RTBBXHU1QzY0XHU1QjU4XHU5MDMyIERCXHVGRjBDXHU1NDI2XHU1MjQ3XHU0RTRCXHU1RjhDXHU2NzAzXHU4OEFCXHU4QUE0XHU1MjI0XHU3MEJBXHUzMDBDXHU1REYyXHU1RUZBXHU3QUNCXHUzMDBEXHU4MDBDXHU1MzYxXHU2QjdCXHUzMDAyXHU2QjY0XHU2NjQyXHU3NkY0XHU2M0E1XHU0RTFGXHU5MzJGXHVGRjBDXHU3QkExXHU3NDA2XHU1NEUxXHU3NTI4XG4gIC8vIFx1RkZGRFx1RkZGRFx1NEUwMFx1OTg0Nlx1NjMwOVx1OTIxNVx1OTFDRFx1OEE2Nlx1NTM3M1x1NTNFRlx1MjAxNFx1MjAxNFx1NUM0Nlx1NjY0MiB0b2tlbkJ5UGxhY2VtZW50IFx1NjcwM1x1NTZERVx1NTBCM1x1NkI2M1x1NzhCQVx1NTczMFx1NTc0MFx1NEUyNlx1ODFFQVx1NTJENVx1NTZERVx1NTg2Qlx1MzAwMlxuICBpZiAoIXRva2VuQWRkcmVzcyB8fCB0b2tlbkFkZHJlc3MgPT09IFwiMHgwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJcdTRFRTNcdTVFNjNcdTVERjJcdTRFMEFcdTkzQzhcdTRGNDZcdTY2QUJcdTY2NDJcdThCODBcdTRFMERcdTUyMzBcdTU3MzBcdTU3NDBcdUZGMDhSUEMgXHU1QzFBXHU2NzJBXHU1NDBDXHU2QjY1XHVGRjA5XHVGRjBDXHU4QUNCXHU2NUJDXHU2NTc4XHU3OUQyXHU1RjhDXHU3NTI4XHU1NDBDXHU0RTAwXHU5ODQ2XHU2MzA5XHU5MjE1XHU5MUNEXHU4QTY2XHVGRjBDXHU3Q0ZCXHU3RDcxXHU2NzAzXHU4MUVBXHU1MkQ1XHU0RkVFXHVGRkZEXHVGRkZEXHVGRkZEXHU0RTI2XHU1NkRFXHU1ODZCXHU1NzMwXHU1NzQwXCIpO1xuICB9XG4gIHJldHVybiB7IHRva2VuQWRkcmVzczogZ2V0QWRkcmVzcyh0b2tlbkFkZHJlc3MpLCB0eEhhc2g6IGhhc2gsIGFscmVhZHlFeGlzdGVkOiBmYWxzZSB9O1xufVxuXG5sZXQgY2FjaGVkUHVibGljOiBQdWJsaWNDbGllbnQgfCBudWxsID0gbnVsbDtcbmV4cG9ydCBmdW5jdGlvbiBwdWJsaWNDbGllbnQoKTogUHVibGljQ2xpZW50IHtcbiAgaWYgKCFjYWNoZWRQdWJsaWMpIHtcbiAgICBjYWNoZWRQdWJsaWMgPSBjcmVhdGVQdWJsaWNDbGllbnQoeyBjaGFpbjogUkVMQVlFUl9DSEFJTiwgdHJhbnNwb3J0OiBycGNUcmFuc3BvcnQgfSkgYXMgUHVibGljQ2xpZW50O1xuICB9XG4gIHJldHVybiBjYWNoZWRQdWJsaWM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwMnBFc2Nyb3dBZGRyZXNzKCk6IEFkZHJlc3Mge1xuICBpZiAoIVAyUF9FU0NST1dfQUREUkVTUykgdGhyb3cgbmV3IEVycm9yKFwiUDJQRXNjcm93IFx1NUMxQVx1NjcyQVx1OTBFOFx1N0Y3Mlx1NjIxNlx1NUMxQVx1NjcyQVx1OEEyRFx1NUI5QVx1NTQwOFx1N0QwNFx1NTczMFx1NTc0MFwiKTtcbiAgcmV0dXJuIFAyUF9FU0NST1dfQUREUkVTUztcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldFAyUEVzY3Jvd0xvY2tlZCh0b2tlbjogQWRkcmVzcyk6IFByb21pc2U8YmlnaW50PiB7XG4gIHJldHVybiBwdWJsaWNDbGllbnQoKS5yZWFkQ29udHJhY3Qoe1xuICAgIGFkZHJlc3M6IHAycEVzY3Jvd0FkZHJlc3MoKSxcbiAgICBhYmk6IFAyUF9FU0NST1dfQUJJLFxuICAgIGZ1bmN0aW9uTmFtZTogXCJ0b3RhbExvY2tlZFwiLFxuICAgIGFyZ3M6IFt0b2tlbl0sXG4gIH0pO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0UDJQRXNjcm93UmVjZWlwdChoYXNoOiBgMHgke3N0cmluZ31gKSB7XG4gIHJldHVybiBwdWJsaWNDbGllbnQoKS5nZXRUcmFuc2FjdGlvblJlY2VpcHQoeyBoYXNoIH0pO1xufVxuXG5mdW5jdGlvbiBhZG1pbkFjY291bnQoKSB7XG4gIGNvbnN0IHJhdyA9IChwcm9jZXNzLmVudi5BRE1JTl9QUklWQVRFX0tFWSA/PyBcIlwiKS50cmltKCk7XG4gIGlmICghcmF3KSB0aHJvdyBuZXcgRXJyb3IoXCJBRE1JTl9QUklWQVRFX0tFWSBcdTY3MkFcdThBMkRcdTVCOUFcIik7XG4gIC8vIFx1NjUyRlx1NjNGNFx1NTE2OVx1N0EyRVx1NjgzQ1x1NUYwRlx1RkYxQVxuICAvLyAgMS4gXHU1MzlGXHU1OUNCXHU3OUMxXHU5NDcwXHVGRjA4MHggKyA2NCBoZXhcdUZGMENcdTYyMTZcdTRFMERcdTU0MkIgMHggXHU3Njg0IDY0IGhleFx1RkYwOVxuICAvLyAgMi4gQklQLTM5IFx1NTJBOVx1OEExOFx1OEE1RVx1RkYwOFx1NEVFNVx1N0E3QVx1NzY3RFx1NTIwNlx1OTY5NFx1NzY4NCAxMiAvIDE1IC8gMTggLyAyMSAvIDI0IFx1NTAwQlx1NTVBRVx1NUI1N1x1RkYwOVx1RkYwQ1x1NEY3Rlx1NzUyOFx1OTgxMFx1OEEyRFxuICAvLyAgICAgXHU4ODREXHU3NTFGXHU4REVGXHU1RjkxXHVGRjA4aW5kZXggMFx1RkYwOVx1MzAwMlxuICBjb25zdCBsb29rc01uZW1vbmljID0gL1xccy8udGVzdChyYXcpICYmICFyYXcuc3RhcnRzV2l0aChcIjB4XCIpO1xuICBpZiAobG9va3NNbmVtb25pYykge1xuICAgIGNvbnN0IHdvcmRzID0gcmF3LnNwbGl0KC9cXHMrLykubGVuZ3RoO1xuICAgIGlmICghWzEyLCAxNSwgMTgsIDIxLCAyNF0uaW5jbHVkZXMod29yZHMpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBRE1JTl9QUklWQVRFX0tFWSBcdTc1OTFcdTRGM0NcdTUyQTlcdThBMThcdThBNUVcdTRGNDZcdTU1QUVcdTVCNTdcdTY1NzhcdTRFMERcdTZCNjNcdTc4QkFcIik7XG4gICAgfVxuICAgIHJldHVybiBtbmVtb25pY1RvQWNjb3VudChyYXcpO1xuICB9XG4gIGNvbnN0IGtleSA9IChyYXcuc3RhcnRzV2l0aChcIjB4XCIpID8gcmF3IDogYDB4JHtyYXd9YCkgYXMgYDB4JHtzdHJpbmd9YDtcbiAgaWYgKCEvXjB4WzAtOWEtZkEtRl17NjR9JC8udGVzdChrZXkpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQURNSU5fUFJJVkFURV9LRVkgXHU2ODNDXHU1RjBGXHU5MzJGXHU4QUE0XHVGRjA4XHU5NzAwXHU3MEJBIDB4ICsgNjQgaGV4IFx1NzlDMVx1OTQ3MFx1RkYwQ1x1NjIxNiBCSVAtMzkgXHU1MkE5XHU4QTE4XHU4QTVFXHVGRjA5XCIpO1xuICB9XG4gIHJldHVybiBwcml2YXRlS2V5VG9BY2NvdW50KGtleSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhZG1pbldhbGxldENsaWVudCgpIHtcbiAgcmV0dXJuIGNyZWF0ZVdhbGxldENsaWVudCh7IGFjY291bnQ6IGFkbWluQWNjb3VudCgpLCBjaGFpbjogUkVMQVlFUl9DSEFJTiwgdHJhbnNwb3J0OiBycGNUcmFuc3BvcnQgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWxheWVyQWRkcmVzcygpOiBBZGRyZXNzIHtcbiAgcmV0dXJuIGFkbWluQWNjb3VudCgpLmFkZHJlc3M7XG59XG5cbi8qKiBBRE1JTiBcdTcxQjFcdTkzMjJcdTUzMDVcdTc2RUVcdTUyNERcdTc2ODQgQmFzZSBTZXBvbGlhIEVUSCBcdTk5MThcdTk4NERcdUZGMDhcdTc1MjhcdTRGODZcdTRFRDhcdTYyNDBcdTY3MDlcdTkzQzhcdTRFMEFcdTRFQTRcdTY2MTNcdTc2ODRcdTc5MjZcdTVERTVcdThDQkJcdUZGMDlcdTMwMDIgKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWxheWVyRXRoQmFsYW5jZSgpOiBQcm9taXNlPGJpZ2ludD4ge1xuICByZXR1cm4gcHVibGljQ2xpZW50KCkuZ2V0QmFsYW5jZSh7IGFkZHJlc3M6IHJlbGF5ZXJBZGRyZXNzKCkgfSk7XG59XG5cbi8vIFx1NkJDRlx1N0I0NiB3cml0ZUNvbnRyYWN0IFx1NTcyOCBCYXNlIFNlcG9saWEgXHU0RTBBXHU4MkIxXHU4Q0JCXHU3Njg0IGdhcyBcdTVGODhcdTVDMEZcdUZGMENcdTRGNDZcdThBOERcdThDRkMvXHU2MjEwXHU0RUE0XHU1RTM4XHU1RTM4XHU5NzAwXHU4OTgxXHU5MDIzXHU3RThDXG4vLyBcdTUxNjlcdTdCNDZcdTRFQTRcdTY2MTNcdTMwMDJcdTkwMTlcdTg4RTFcdTRGRERcdTc1NTlcdTdEMDRcdTUzRUZcdTg5ODZcdTg0Q0IgNSBcdTdCNDZcdTRFMDBcdTgyMkNcdTRFQTRcdTY2MTNcdTc2ODRcdTk5MThcdTg4RDVcdUZGMENcdTk5MThcdTk4NERcdTRGNEVcdTY1QkNcdTZCNjRcdTUwM0NcdTVDMzFcdTUxNDhcdTY0Q0JcdTRFMEJcdUZGMENcdTkwN0ZcdTUxNERcbi8vIFx1NEVBNFx1NjYxM1x1NTM2MVx1NTcyOFx1MzAwQ1x1OTAwMVx1NTFGQVx1NEY0Nlx1NkM5Mlx1OTMyMlx1NEVEOCBnYXNcdTMwMERcdTc2ODRcdTUzNEFcdTkwMTRcdTcyQzBcdTYxNEJcdUZGMENcdThCOTNcdTRGN0ZcdTc1MjhcdTgwMDVcdTc2ODQgSkMvVVNEVCBcdTVERjJcdTdEOTNcdTg4QUJcdTYyNjNcdTZCM0VcdTUzN0JcdTYyRkZcbi8vIFx1NEUwRFx1NTIzMFx1NUMwRFx1NjFDOVx1NzY4NFx1OTNDOFx1NEUwQVx1N0Q1MFx1N0I5N1x1MzAwMlxuY29uc3QgTUlOX1JFTEFZRVJfRVRIX1dFSSA9IHBhcnNlRXRoZXIoXCIwLjAwMTVcIik7XG5cbi8qKlxuICogXHU5MDAxXHU1MUZBXHU0RUZCXHU0RjU1XHU5M0M4XHU0RTBBXHU0RUE0XHU2NjEzXHU1MjREXHU3Njg0XHU5NjMyXHU1NDQ2XHU2QUEyXHU2N0U1XHVGRjFBQURNSU4gXHU3MUIxXHU5MzIyXHU1MzA1IEVUSCBcdTU5MkFcdTVDMTFcdTY3MDNcdTVDMEVcdTgxRjRcdTRFQTRcdTY2MTNcdTUzNjFcdTRGNEZcdTc1MUFcdTgxRjNcdTVCOENcdTUxNjhcbiAqIFx1OTAwMVx1NEUwRFx1NTFGQVx1NTNCQlx1MzAwMlx1OTAxOVx1ODhFMVx1NTE0OFx1OEI4MFx1OTNDOFx1NEUwQVx1OTkxOFx1OTg0RFx1NjRDQlx1NEUwQlx1RkYwQ1x1NTZERVx1NTgzMVx1NkUwNVx1Njk1QVx1NzY4NFx1NEUyRFx1NjU4N1x1OTMyRlx1OEFBNFx1RkYwQ1x1ODAwQ1x1NEUwRFx1NjYyRlx1OEI5M1x1NEY3Rlx1NzUyOFx1ODAwNVx1NTM2MVx1NTcyOFx1NEUwMFxuICogXHU1MDBCXHU3NzBCXHU0RTBEXHU2MUMyXHU3Njg0XHU1RTk1XHU1QzY0IFJQQyBcdTkzMkZcdThBQTRcdUZGMENcdTYyMTZcdThCOTNcdTUxNjdcdTkwRThcdTVFMzNcdTY3MkNcdTVERjJcdTdEOTNcdTYyNjNcdTZCM0VcdTUzN0JcdTZDMzhcdTkwNjBcdTdCNDlcdTRFMERcdTUyMzBcdTkzQzhcdTRFMEFcdTdENTBcdTdCOTdcdTMwMDJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGVuc3VyZVJlbGF5ZXJHYXMoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGJhbGFuY2UgPSBhd2FpdCByZWxheWVyRXRoQmFsYW5jZSgpO1xuICBpZiAoYmFsYW5jZSA8IE1JTl9SRUxBWUVSX0VUSF9XRUkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQURNSU4gXHU3MUIxXHU5MzIyXHU1MzA1IEJhc2UgU2Vwb2xpYSBFVEggXHU5OTE4XHU5ODREXHU5MDRFXHU0RjRFXHVGRjA4JHtmb3JtYXRFdGhlcihiYWxhbmNlKX0gRVRIXHVGRjA5XHVGRjBDXHU4QUNCXHU3QkExXHU3NDA2XHU1NEUxXHU1MTQ4XHU1MTMyXHU1MDNDXHU2RTJDXHU4QTY2XHU3REIyIEVUSCBcdTVGOENcdTUxOERcdTkxQ0RcdThBNjZgLFxuICAgICk7XG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBcdTRGN0ZcdTc1MjhcdTgwMDVcdTkzMjJcdTUzMDUgR2FzIFx1OEQwQVx1NTJBOVx1RkYwOFx1NUU3M1x1NTNGMFx1NEVFM1x1NEVEOFx1RkYwOVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vL1xuLy8gVVNEVCBcdTVCNThcdTU3MjhcdTRGN0ZcdTc1MjhcdTgwMDVcdTMwMENcdTgxRUFcdTVERjFcdTc2ODRcdTMwMERcdTUxNjdcdTVENENcdTkzMjJcdTUzMDVcdUZGMDhcdTgxRUFcdTYyMTFcdTRGRERcdTdCQTFcdUZGMDlcdTMwMDJcdTkxRDFcdTVFQUJcdTUxNjVcdTkxRDFcdUZGMDhcdThDQjcgSkNcdUZGMDlcdTgyMDdcdTYzRDBcdTk4MThcdTkwRkRcdTk3MDBcdTg5ODFcbi8vIFx1NEY3Rlx1NzUyOFx1ODAwNVx1NjcyQ1x1NEVCQVx1N0MzRFx1NTQwRFx1NjI4QVx1ODFFQVx1NURGMVx1NzY4NCBVU0RUIFx1OEY0OVx1NTFGQVx1MjAxNFx1MjAxNFx1OTAxOVx1NjYyRlx1ODFFQVx1NjIxMVx1NEZERFx1N0JBMVx1OENDN1x1NzUyMlx1NzY4NFx1NkI2M1x1NzhCQVx1NTA1QVx1NkNENVx1RkYwOFx1NUMyNFx1NTE3Nlx1NjNEMFx1OTgxOFx1NTIzMFx1NEVGQlxuLy8gXHU2MTBGXHU1NzMwXHU1NzQwXHVGRjBDXHU3RDU1XHU0RTBEXHU4QTcyXHU3NTMxXHU1RjhDXHU3QUVGXHU0RUUzXHU3QzNEXHVGRjA5XHUzMDAyXHU0RjQ2XHU3QzNEXHU1NDBEXHU5MDAxXHU0RUE0XHU2NjEzXHU5NzAwXHU4OTgxIEJhc2UgU2Vwb2xpYSBFVEggXHU0RUQ4IEdhc1x1RkYwQ1x1NTE2OFx1NjVCMFx1OTMyMlxuLy8gXHU1MzA1IEVUSD0wIFx1NjY0Mlx1OTAyM1x1NEVBNFx1NjYxM1x1OTBGRFx1NUVGQVx1N0FDQlx1NEUwRFx1NTFGQVx1NEY4Nlx1RkYwOFx1MzAwQ2luc3VmZmljaWVudCBmdW5kcyBmb3IgZ2FzXHUzMDBEXHVGRjA5XHUzMDAyXG4vL1xuLy8gXHU2NzJDXHU3QUQ5XHU3Njg0IFVTRFQgXHU2RTJDXHU4QTY2XHU0RUUzXHU1RTYzXHU0RTBEXHU2NTJGXHU2M0Y0IEVJUC0yNjEyIHBlcm1pdFx1RkYwOFx1NURGMlx1OTNDOFx1NEUwQVx1OUE1N1x1OEI0OSBET01BSU5fU0VQQVJBVE9SL25vbmNlc1xuLy8gXHU5MEZEIHJldmVydFx1RkYwOVx1RkYwQ1x1NTZFMFx1NkI2NFx1NzEyMVx1NkNENVx1NzUyOFx1MzAwQ1x1N0MzRFx1NEUwMFx1NkIyMVx1NzEyMSBHYXMgXHU3Njg0IHBlcm1pdCBcdThCOTMgQURNSU4gXHU0RUUzXHU4RjQ5XHUzMDBEXHU3Njg0XHU2NUI5XHU1RjBGXHVGRjFCXHU0RTVGXHU0RTBEXHU4MEZEXG4vLyBcdTc1MjhcdTMwMENhcHByb3ZlIFx1NEUwMFx1NkIyMVx1NTE4RFx1NzUzMSBBRE1JTiB0cmFuc2ZlckZyb21cdTMwMERcdUZGMENcdTU2RTBcdTcwQkFcdTkwQTNcdTUwMEIgYXBwcm92ZSBcdTY3MkNcdThFQUJcdTVDMzFcdTY2MkZcdTRFMDBcdTdCNDZcdTk3MDBcdTg5ODFcbi8vIEdhcyBcdTc2ODRcdTRFQTRcdTY2MTNcdUZGMENcdTRFMDBcdTZBMjNcdTY3MDNcdTg4QUIgRVRIPTAgXHU2NENCXHU0RjRGXHUzMDAyXG4vL1xuLy8gXHU2MjQwXHU0RUU1XHU2M0ExXHUzMDBDR2FzIFx1OEQwQVx1NTJBOVx1MzAwRFx1RkYxQVx1NEY3Rlx1NzUyOFx1ODAwNVx1N0MzRCBVU0RUIFx1NEVBNFx1NjYxM1x1NTI0RFx1RkYwQ1x1NUY4Q1x1N0FFRiBBRE1JTiBcdTcxQjFcdTkzMjJcdTUzMDVcdTUxNDhcdTVFNkJcdTRGN0ZcdTc1MjhcdTgwMDVcdTkzMjJcdTUzMDVcdTg4RENcbi8vIFx1NEUwMFx1OUVERVx1OUVERSBFVEhcdUZGMDhcdTUzRUFcdTU5MjBcdTRFRDggR2FzXHVGRjA5XHVGRjBDXHU0RjdGXHU3NTI4XHU4MDA1XHU1MThEXHU3NTI4XHU4MUVBXHU1REYxXHU3Njg0XHU5MzIyXHU1MzA1XHU3QzNEXHU1NDBEXHUzMDAyRVRIIFx1NjIxMFx1NjcyQ1x1NzUzMVx1NUU3M1x1NTNGMFx1NjI3Rlx1NjRENFx1RkYwQ1x1NjUzNlxuLy8gXHU2QjNFXHU1NzMwXHU1NzQwXHU0RTAwXHU1RjhCXHU2NjJGXHUzMDBDXHU1NDdDXHU1M0VCXHU4MDA1XHU2NzJDXHU0RUJBXHUzMDBEXHU3Njg0XHU5MzIyXHU1MzA1XHVGRjA4XHU0RjNBXHU2NzBEXHU1NjY4XHU3QUVGXHU1RjlFIHByb2ZpbGVzLndhbGxldF9hZGRyZXNzIFx1NjNBOFx1NUMwRVx1RkYwQ1x1NEUwRFxuLy8gXHU0RkUxXHU0RUZCXHU1MjREXHU3QUVGXHVGRjA5XHVGRjBDXHU5MUQxXHU5ODREXHU2OTc1XHU1QzBGXHVGRjA4XHU2QkNGXHU3QjQ2IFVTRFQgdHJhbnNmZXIgXHU3RDA0IDAuMDAwMDAwNCBFVEhcdUZGMDlcdTMwMDJcbmNvbnN0IFNQT05TT1JfTUlOX1dFSSA9IHBhcnNlRXRoZXIoXCIwLjAwMDA1XCIpOyAvLyBcdTRGNEVcdTY1QkNcdTZCNjRcdTk5MThcdTk4NERcdTYyNERcdThEMEFcdTUyQTlcbmNvbnN0IFNQT05TT1JfVEFSR0VUX1dFSSA9IHBhcnNlRXRoZXIoXCIwLjAwMDNcIik7IC8vIFx1OEQwQVx1NTJBOVx1NUY4Q1x1ODhEQ1x1NTIzMFx1NkI2NFx1OTkxOFx1OTg0RFx1RkYwOFx1NTNFRlx1ODk4Nlx1ODRDQlx1NjU3OFx1NzY3RVx1N0I0Nlx1NEVBNFx1NjYxM1x1RkYwOVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3BvbnNvclVzZXJHYXMoXG4gIHVzZXJXYWxsZXQ6IEFkZHJlc3MsXG4pOiBQcm9taXNlPHsgc3BvbnNvcmVkOiBib29sZWFuOyBiYWxhbmNlV2VpOiBzdHJpbmc7IHR4SGFzaD86IHN0cmluZyB9PiB7XG4gIGNvbnN0IHdhbGxldCA9IGdldEFkZHJlc3MoU3RyaW5nKHVzZXJXYWxsZXQpLnRyaW0oKSk7XG4gIGNvbnN0IGN1cnJlbnQgPSBhd2FpdCBwdWJsaWNDbGllbnQoKS5nZXRCYWxhbmNlKHsgYWRkcmVzczogd2FsbGV0IH0pO1xuICBpZiAoY3VycmVudCA+PSBTUE9OU09SX01JTl9XRUkpIHtcbiAgICByZXR1cm4geyBzcG9uc29yZWQ6IGZhbHNlLCBiYWxhbmNlV2VpOiBjdXJyZW50LnRvU3RyaW5nKCkgfTtcbiAgfVxuICAvLyBBRE1JTiBcdTcxQjFcdTkzMjJcdTUzMDVcdTY3MkNcdThFQUJcdTg5ODFcdTY3MDlcdThEQjNcdTU5MjAgRVRIIFx1NEVEOFx1MzAwQ1x1OTAxOVx1N0I0Nlx1ODhEQ1x1NTJBOVx1OEY0OVx1NUUzM1x1MzAwRFx1NzY4NCBHYXMgXHU4MjA3XHU4RjQ5XHU1MUZBXHU3Njg0IHZhbHVlXHUzMDAyXG4gIGF3YWl0IGVuc3VyZVJlbGF5ZXJHYXMoKTtcbiAgY29uc3QgdG9wVXAgPSBTUE9OU09SX1RBUkdFVF9XRUkgLSBjdXJyZW50O1xuICBjb25zdCBoYXNoID0gYXdhaXQgc2VuZEFkbWluVHgoKG5vbmNlKSA9PlxuICAgIGFkbWluV2FsbGV0Q2xpZW50KCkuc2VuZFRyYW5zYWN0aW9uKHtcbiAgICAgIHRvOiB3YWxsZXQsXG4gICAgICB2YWx1ZTogdG9wVXAsXG4gICAgICBjaGFpbjogUkVMQVlFUl9DSEFJTixcbiAgICAgIG5vbmNlLFxuICAgIH0pLFxuICApO1xuICBhd2FpdCB3YWl0QW5kUmV0dXJuKGhhc2gpO1xuICBjb25zdCBhZnRlciA9IGF3YWl0IHB1YmxpY0NsaWVudCgpLmdldEJhbGFuY2UoeyBhZGRyZXNzOiB3YWxsZXQgfSk7XG4gIHJldHVybiB7IHNwb25zb3JlZDogdHJ1ZSwgYmFsYW5jZVdlaTogYWZ0ZXIudG9TdHJpbmcoKSwgdHhIYXNoOiBoYXNoIH07XG59XG5cbmNvbnN0IGRlY2ltYWxzQ2FjaGUgPSBuZXcgTWFwPEFkZHJlc3MsIG51bWJlcj4oKTtcbmFzeW5jIGZ1bmN0aW9uIHRva2VuRGVjaW1hbHModG9rZW46IFwiamNUb2tlblwiIHwgXCJyd2FNYXN0ZXJcIiB8IFwiYWVUb2tlblwiKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgYWRkcmVzcyA9IFJFTEFZRVJfQUREUkVTU0VTW3Rva2VuXTtcbiAgY29uc3QgY2FjaGVkID0gZGVjaW1hbHNDYWNoZS5nZXQoYWRkcmVzcyk7XG4gIGlmIChjYWNoZWQgIT0gbnVsbCkgcmV0dXJuIGNhY2hlZDtcbiAgY29uc3QgYWJpID0gdG9rZW4gPT09IFwiamNUb2tlblwiID8gamNBYmkgOiB0b2tlbiA9PT0gXCJhZVRva2VuXCIgPyBhZUFiaSA6IHJ3YUFiaTtcbiAgbGV0IHZhbHVlID0gMTg7XG4gIHRyeSB7XG4gICAgdmFsdWUgPSBOdW1iZXIoYXdhaXQgcHVibGljQ2xpZW50KCkucmVhZENvbnRyYWN0KHsgYWRkcmVzcywgYWJpLCBmdW5jdGlvbk5hbWU6IFwiZGVjaW1hbHNcIiB9KSk7XG4gIH0gY2F0Y2gge1xuICAgIHZhbHVlID0gMTg7XG4gIH1cbiAgZGVjaW1hbHNDYWNoZS5zZXQoYWRkcmVzcywgdmFsdWUpO1xuICByZXR1cm4gdmFsdWU7XG59XG5cbi8vIFZlcmNlbCBmdW5jdGlvbiBtYXhEdXJhdGlvbiBcdThBMkQgNjAgXHU3OUQyXHVGRjA4XHU4OThCIHZlcmNlbC5qc29uXHVGRjA5XHVGRjBDXHU5MDE5XHU4OEUxXHU3NTU5XHU0RTAwXHU0RTlCXHU5OTE4XHU4OEQ1XHU3RDY2XHU1MUZEXHU1RjBGXG4vLyBcdTUxNzZcdTk5MThcdTkwOEZcdThGMkZcdUZGMDhcdThCODAgU3VwYWJhc2VcdTMwMDFcdTdDM0RcdTU0MERcdTkwMDFcdTUxRkFcdUZGMDlcdUZGMENcdTkwM0VcdTY2NDJcdTVDMzFcdTRFMERcdTdFN0NcdTdFOENcdTdCNDlcdTVGODVcdTY1MzZcdTY0REFcdUZGMENcdThCOTNcdTUyNERcdTdBRUZcdTY1MzlcdTc1MjhcdTRFQTRcdTY2MTNcdTk2RENcdTZFNEFcbi8vIFx1ODFFQVx1ODg0Q1x1NjdFNVx1OEE2Mlx1NjcwMFx1N0Q0Mlx1NzJDMFx1NjE0Qlx1RkYwQ1x1OTA3Rlx1NTE0RFx1NjU3NFx1NTAwQlx1OEFDQlx1NkM0Mlx1ODhBQlx1NUU3M1x1NTNGMFx1NUYzN1x1NTIzNlx1NEUyRFx1NjVCN1x1NjIxMCA1MDRcdTMwMDJcbmFzeW5jIGZ1bmN0aW9uIHdhaXRBbmRSZXR1cm4oaGFzaDogYDB4JHtzdHJpbmd9YCkge1xuICBjb25zdCByZWNlaXB0ID0gYXdhaXQgcHVibGljQ2xpZW50KCkud2FpdEZvclRyYW5zYWN0aW9uUmVjZWlwdCh7IGhhc2gsIHRpbWVvdXQ6IDQ1XzAwMCB9KTtcbiAgaWYgKHJlY2VpcHQuc3RhdHVzICE9PSBcInN1Y2Nlc3NcIikgdGhyb3cgbmV3IEVycm9yKGBcdTkzQzhcdTRFMEFcdTRFQTRcdTY2MTNcdTU5MzFcdTY1NTdcdUZGMDhyZXZlcnRlZFx1RkYwOTogJHtoYXNofWApO1xuICByZXR1cm4gaGFzaDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldEFkbWluVHJhbnNhY3Rpb25TdGF0dXMoXG4gIGhhc2g6IGAweCR7c3RyaW5nfWAsXG4pOiBQcm9taXNlPFwiY29uZmlybWVkXCIgfCBcInJldmVydGVkXCIgfCBcInBlbmRpbmdcIiB8IFwidW5rbm93blwiPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVjZWlwdCA9IGF3YWl0IHB1YmxpY0NsaWVudCgpLmdldFRyYW5zYWN0aW9uUmVjZWlwdCh7IGhhc2ggfSk7XG4gICAgcmV0dXJuIHJlY2VpcHQuc3RhdHVzID09PSBcInN1Y2Nlc3NcIiA/IFwiY29uZmlybWVkXCIgOiBcInJldmVydGVkXCI7XG4gIH0gY2F0Y2gge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB0cmFuc2FjdGlvbiA9IGF3YWl0IHB1YmxpY0NsaWVudCgpLmdldFRyYW5zYWN0aW9uKHsgaGFzaCB9KTtcbiAgICAgIHJldHVybiB0cmFuc2FjdGlvbiA/IFwicGVuZGluZ1wiIDogXCJ1bmtub3duXCI7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gXCJ1bmtub3duXCI7XG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB3YWl0Rm9yQWRtaW5UcmFuc2FjdGlvbihoYXNoOiBgMHgke3N0cmluZ31gKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgcmV0dXJuIHdhaXRBbmRSZXR1cm4oaGFzaCk7XG59XG5cbmV4cG9ydCB0eXBlIE9uQWRtaW5UcmFuc2FjdGlvblN1Ym1pdHRlZCA9IChoYXNoOiBgMHgke3N0cmluZ31gKSA9PiBQcm9taXNlPHZvaWQ+O1xuXG4vKipcbiAqIFx1NjI0MFx1NjcwOSBBRE1JTiBcdTkzQzhcdTRFMEFcdTRFQTRcdTY2MTNcdTc2ODRcdTU1MkZcdTRFMDBcdTkwMDFcdTUxRkFcdTUxNjVcdTUzRTNcdUZGMUFcdTU3Mjggbm9uY2UgXHU5Mzk2XHU1MTY3XHU2N0U1XHU4QTYyXHU3NTc2XHU1MjREIHBlbmRpbmcgbm9uY2VcdTMwMDFcbiAqIFx1N0Q0NFx1NTk3RFx1NEVBNFx1NjYxM1x1NEUyNlx1OTAwMVx1NTFGQVx1RkYwOFx1NEUwRFx1N0I0OVx1NUY4NVx1NEUwQVx1OTNDOFx1NzhCQVx1OEE4RFx1RkYwOVx1RkYwQ1x1NEUwMFx1NjJGRlx1NTIzMCB0eCBoYXNoIFx1NUMzMVx1N0FDQlx1NTIzQlx1OTFDQlx1NjUzRVx1OTM5Nlx1MzAwMlx1OTAxOVx1NjYyRlx1NEZFRVx1NjM4OVxuICogXHUzMDBDXHU1NDBDXHU2NjQyXHU2NzA5XHU1MTY5XHU3QjQ2XHU0RUE0XHU2NjEzXHU1NzI4XHU4REQxXHU1QzMxXHU1M0VGXHU4MEZEIG5vbmNlIFx1ODg1RFx1N0E4MVx1MzAwRFx1NTU0Rlx1OTg0Q1x1NzY4NFx1OTVEQ1x1OTM3NVx1MjAxNFx1MjAxNFx1NjI0MFx1NjcwOVx1NzY3Q1x1NjUzRS9cdTdENTBcdTdCOTdcdTUxRkRcdTVGMEZcdTkwRkRcbiAqIFx1RkZGRFx1RkZGRFx1OTgwOFx1OTAwRlx1OTA0RVx1OTAxOVx1ODhFMVx1OTAwMVx1NTFGQVx1NEVBNFx1NjYxM1x1RkYwQ1x1NEUwRFx1NTNFRlx1NEVFNVx1NTE4RFx1NTQwNFx1ODFFQVx1NzZGNFx1NjNBNVx1NTQ3Q1x1NTNFQiB3cml0ZUNvbnRyYWN0XHUzMDAyXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNlbmRBZG1pblR4KGJ1aWxkOiAobm9uY2U6IG51bWJlcikgPT4gUHJvbWlzZTxgMHgke3N0cmluZ31gPik6IFByb21pc2U8YDB4JHtzdHJpbmd9YD4ge1xuICByZXR1cm4gd2l0aEFkbWluTm9uY2VMb2NrKGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBub25jZSA9IGF3YWl0IHB1YmxpY0NsaWVudCgpLmdldFRyYW5zYWN0aW9uQ291bnQoe1xuICAgICAgYWRkcmVzczogcmVsYXllckFkZHJlc3MoKSxcbiAgICAgIGJsb2NrVGFnOiBcInBlbmRpbmdcIixcbiAgICB9KTtcbiAgICByZXR1cm4gYnVpbGQobm9uY2UpO1xuICB9KTtcbn1cblxuLyoqXG4gKiBcdTkwMDFcdTUxRkFcdTMwMENBRE1JTiBcdTcxQjFcdTkzMjJcdTUzMDVcdTc2RjRcdTYzQTVcdThGNDlcdTVFMzNcdTc2N0NcdTY1M0VcdTdENjZcdTRGN0ZcdTc1MjhcdTgwMDVcdTMwMERcdTRFNEJcdTUyNERcdTc2ODRcdTk4MTBcdTZBQTJcdTY3RTVcdUZGMUFcdTcxQjFcdTkzMjJcdTUzMDVcdTgxRUFcdTVERjFcdTc2ODRcdTk5MThcdTk4NERcbiAqIFx1ODJFNVx1NEUwRFx1OERCM1x1RkYwQ1x1NEVFM1x1ODg2OFx1OTcwMFx1ODk4MVx1NEVCQVx1NURFNVx1NUY5RSBTYWZlIFx1OTFEMVx1NUVBQlx1NTE4RFx1OEY0OVx1NEUwMFx1NjI3OSBKQy9BRSBcdTkwNEVcdTRGODZcdTg4RENcdThDQThcdTMwMDJcbiAqIGFtb3VudFVuaXRzIFx1NURGMlx1NjYyRlx1NEVFM1x1NUU2M1x1NjcwMFx1NUMwRlx1NTVBRVx1NEY0RFx1RkYwOHdlaVx1RkYwOVx1MzAwMlxuICovXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVIb3RXYWxsZXRDYW5Db3Zlcih0b2tlbjogXCJqY1Rva2VuXCIgfCBcImFlVG9rZW5cIiwgYW1vdW50VW5pdHM6IGJpZ2ludCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0b2tlbkFkZHJlc3MgPSBSRUxBWUVSX0FERFJFU1NFU1t0b2tlbl07XG4gIGNvbnN0IGFiaSA9IHRva2VuID09PSBcImpjVG9rZW5cIiA/IGpjQWJpIDogYWVBYmk7XG4gIGNvbnN0IGJhbGFuY2UgPSAoYXdhaXQgcHVibGljQ2xpZW50KCkucmVhZENvbnRyYWN0KHtcbiAgICBhZGRyZXNzOiB0b2tlbkFkZHJlc3MsXG4gICAgYWJpLFxuICAgIGZ1bmN0aW9uTmFtZTogXCJiYWxhbmNlT2ZcIixcbiAgICBhcmdzOiBbcmVsYXllckFkZHJlc3MoKV0sXG4gIH0pKSBhcyBiaWdpbnQ7XG4gIGNvbnN0IGxhYmVsID0gdG9rZW4gPT09IFwiamNUb2tlblwiID8gXCJKQ1wiIDogXCJBRVwiO1xuICBpZiAoYmFsYW5jZSA8IGFtb3VudFVuaXRzKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBRE1JTiBcdTcxQjFcdTkzMjJcdTUzMDUgJHtsYWJlbH0gXHU1RUFCXHU1QjU4XHU0RTBEXHU4REIzXHVGRjBDXHU4QUNCXHU3QkExXHU3NDA2XHU1NEUxXHU1MTQ4XHU1RjlFIFNhZmUgXHU5MUQxXHU1RUFCXHU4RjQ5XHU0RTAwXHU2Mjc5ICR7bGFiZWx9IFx1NTIzMFx1NzFCMVx1OTMyMlx1NTMwNVx1ODhEQ1x1OENBOFx1NUY4Q1x1NTE4RFx1OTFDRFx1OEE2NmApO1xuICB9XG59XG5cbi8qKlxuICogXHU3NjdDXHU2NTNFIEpDL0FFIFx1N0Q2Nlx1NjMwN1x1NUI5QVx1OTMyMlx1NTMwNVx1RkYxQUFETUlOIFx1NzFCMVx1OTMyMlx1NTMwNVx1NzZGNFx1NjNBNVx1NzUyOFx1NkExOVx1NkU5NiBFUkMtMjAgdHJhbnNmZXIgXHU1MkQ1XHU3NTI4XHU4MUVBXHU1REYxXHU3Njg0XG4gKiBcdTk5MThcdTk4NERcdThGNDlcdTdENjZcdTRGN0ZcdTc1MjhcdTgwMDVcdUZGMENcdTRFMERcdTdEOTNcdTkwNEUgYXBwcm92ZS9hbGxvd2FuY2UvdHJhbnNmZXJGcm9tXHUzMDAyXHU1RUFCXHU1QjU4XHU3NTMxXHU0RUJBXHU1REU1XHU1RjlFIFNhZmVcbiAqIFx1OTFEMVx1NUVBQlx1NjI0Qlx1NTJENVx1OEY0OVx1NUUzM1x1ODhEQ1x1OENBOFx1NTIzMFx1NzFCMVx1OTMyMlx1NTMwNVx1MzAwMmFtb3VudCBcdTcwQkFcdTRFQkFcdTk4NUVcdTUzRUZcdThCODBcdTU1QUVcdTRGNERcdTMwMDJcbiAqL1xuYXN5bmMgZnVuY3Rpb24gdHJhbnNmZXJGcm9tSG90V2FsbGV0KFxuICB0b2tlbjogXCJqY1Rva2VuXCIgfCBcImFlVG9rZW5cIixcbiAgdG86IEFkZHJlc3MsXG4gIGFtb3VudDogbnVtYmVyLFxuICBvblN1Ym1pdHRlZD86IE9uQWRtaW5UcmFuc2FjdGlvblN1Ym1pdHRlZCxcbikge1xuICBhd2FpdCBlbnN1cmVSZWxheWVyR2FzKCk7XG4gIGNvbnN0IGRlY2ltYWxzID0gYXdhaXQgdG9rZW5EZWNpbWFscyh0b2tlbik7XG4gIGNvbnN0IGFtb3VudFVuaXRzID0gcGFyc2VVbml0cyhhbW91bnQudG9GaXhlZChkZWNpbWFscyksIGRlY2ltYWxzKTtcbiAgYXdhaXQgZW5zdXJlSG90V2FsbGV0Q2FuQ292ZXIodG9rZW4sIGFtb3VudFVuaXRzKTtcbiAgY29uc3QgYWJpID0gdG9rZW4gPT09IFwiamNUb2tlblwiID8gamNBYmkgOiBhZUFiaTtcbiAgY29uc3QgaGFzaCA9IGF3YWl0IHNlbmRBZG1pblR4KChub25jZSkgPT5cbiAgICBhZG1pbldhbGxldENsaWVudCgpLndyaXRlQ29udHJhY3Qoe1xuICAgICAgYWRkcmVzczogUkVMQVlFUl9BRERSRVNTRVNbdG9rZW5dLFxuICAgICAgYWJpLFxuICAgICAgZnVuY3Rpb25OYW1lOiBcInRyYW5zZmVyXCIsXG4gICAgICBhcmdzOiBbZ2V0QWRkcmVzcyh0byksIGFtb3VudFVuaXRzXSxcbiAgICAgIGNoYWluOiBSRUxBWUVSX0NIQUlOLFxuICAgICAgbm9uY2UsXG4gICAgfSksXG4gICk7XG4gIGF3YWl0IG9uU3VibWl0dGVkPy4oaGFzaCk7XG4gIHJldHVybiB3YWl0QW5kUmV0dXJuKGhhc2gpO1xufVxuXG4vKiogXHU3NjdDXHU2NTNFIEpDIFx1N0Q2Nlx1NjMwN1x1NUI5QVx1OTMyMlx1NTMwNVx1RkYwOFx1ODk4QiB0cmFuc2ZlckZyb21Ib3RXYWxsZXRcdUZGMDlcdTMwMDIgKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtaW50SmModG86IEFkZHJlc3MsIGFtb3VudDogbnVtYmVyKSB7XG4gIHJldHVybiB0cmFuc2ZlckZyb21Ib3RXYWxsZXQoXCJqY1Rva2VuXCIsIHRvLCBhbW91bnQpO1xufVxuXG4vKiogXHU3NjdDXHU2NTNFIEFFIFx1N0Q2Nlx1NjMwN1x1NUI5QVx1OTMyMlx1NTMwNVx1RkYwOFx1ODk4QiB0cmFuc2ZlckZyb21Ib3RXYWxsZXRcdUZGMDlcdTMwMDIgKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtaW50QWUodG86IEFkZHJlc3MsIGFtb3VudDogbnVtYmVyKSB7XG4gIHJldHVybiB0cmFuc2ZlckZyb21Ib3RXYWxsZXQoXCJhZVRva2VuXCIsIHRvLCBhbW91bnQpO1xufVxuXG4vKipcbiAqIFx1MzAwQ0FFIFx1NkI3OFx1OTZGNlx1MzAwRFx1NUMwOFx1NzUyOFx1RkYxQVx1NzUyOCBBRVRva2VuIFx1NzY4NCBvd25lci1vbmx5IGFkbWluUmVjbGFpbSBcdTYyOEFcdTY3RDBcdTkzMjJcdTUzMDVcdTYzMDFcdTY3MDlcdTc2ODQgQUVcbiAqIFx1NUYzN1x1NTIzNlx1NjUzNlx1NTZERVx1OTFEMVx1NUVBQlx1RkYwOFNhZmVcdUZGMDlcdUZGMENcdTRFMERcdTUzRDcgYWxsb3dhbmNlIFx1OTY1MFx1NTIzNlx1RkYwQ1x1NzhCQVx1NEZERFx1NTM3M1x1NEY3Rlx1OEE3Mlx1NEY3Rlx1NzUyOFx1ODAwNVx1NUY5RVx1NjcyQVx1NUMwRCBBRE1JTlxuICogYXBwcm92ZSBcdTkwNEVcdTRFNUZcdTgwRkRcdTY1MzZcdTU2REVcdTMwMDJhbW91bnQ8PTAgXHU2NjQyXHU3NkY0XHU2M0E1XHU1NkRFIG51bGxcdUZGMDhcdTRFMERcdTkwMDFcdTUxRkFcdTRFQTRcdTY2MTNcdUZGMDlcdTMwMDJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFkbWluUmVjbGFpbUFlKGZyb206IEFkZHJlc3MsIGFtb3VudDogbnVtYmVyLCB0bzogQWRkcmVzcyA9IFJFTEFZRVJfQUREUkVTU0VTLnNhZmVWYXVsdCkge1xuICBpZiAoYW1vdW50IDw9IDApIHJldHVybiBudWxsO1xuICBhd2FpdCBlbnN1cmVSZWxheWVyR2FzKCk7XG4gIGNvbnN0IGRlY2ltYWxzID0gYXdhaXQgdG9rZW5EZWNpbWFscyhcImFlVG9rZW5cIik7XG4gIGNvbnN0IGFtb3VudFVuaXRzID0gcGFyc2VVbml0cyhhbW91bnQudG9GaXhlZChkZWNpbWFscyksIGRlY2ltYWxzKTtcbiAgY29uc3QgaGFzaCA9IGF3YWl0IHNlbmRBZG1pblR4KChub25jZSkgPT5cbiAgICBhZG1pbldhbGxldENsaWVudCgpLndyaXRlQ29udHJhY3Qoe1xuICAgICAgYWRkcmVzczogUkVMQVlFUl9BRERSRVNTRVMuYWVUb2tlbixcbiAgICAgIGFiaTogYWVBYmksXG4gICAgICBmdW5jdGlvbk5hbWU6IFwiYWRtaW5SZWNsYWltXCIsXG4gICAgICBhcmdzOiBbZ2V0QWRkcmVzcyhmcm9tKSwgZ2V0QWRkcmVzcyh0byksIGFtb3VudFVuaXRzXSxcbiAgICAgIGNoYWluOiBSRUxBWUVSX0NIQUlOLFxuICAgICAgbm9uY2UsXG4gICAgfSksXG4gICk7XG4gIHJldHVybiB3YWl0QW5kUmV0dXJuKGhhc2gpO1xufVxuXG4vKiogXHU4QjgwXHU1M0Q2XHU2N0QwXHU5MzIyXHU1MzA1XHU3NkVFXHU1MjREXHU5M0M4XHU0RTBBIEFFIFx1OTkxOFx1OTg0RFx1RkYwOGRlY2ltYWxzIFx1NURGMlx1OTA4NFx1NTM5Rlx1NzBCQVx1NEUwMFx1ODIyQ1x1NTVBRVx1NEY0RFx1NzY4NCBudW1iZXJcdUZGMDlcdTMwMDIgKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRBZUNoYWluQmFsYW5jZSh3YWxsZXQ6IEFkZHJlc3MpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBbcmF3LCBkZWNpbWFsc10gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgcHVibGljQ2xpZW50KCkucmVhZENvbnRyYWN0KHsgYWRkcmVzczogUkVMQVlFUl9BRERSRVNTRVMuYWVUb2tlbiwgYWJpOiBhZUFiaSwgZnVuY3Rpb25OYW1lOiBcImJhbGFuY2VPZlwiLCBhcmdzOiBbd2FsbGV0XSB9KSxcbiAgICB0b2tlbkRlY2ltYWxzKFwiYWVUb2tlblwiKSxcbiAgXSk7XG4gIHJldHVybiBOdW1iZXIoZm9ybWF0VW5pdHMocmF3IGFzIGJpZ2ludCwgZGVjaW1hbHMpKTtcbn1cblxuY29uc3QgbWludGFibGVBYmkgPSBbXG4gIHtcbiAgICBpbnB1dHM6IFtcbiAgICAgIHsgbmFtZTogXCJ0b1wiLCB0eXBlOiBcImFkZHJlc3NcIiB9LFxuICAgICAgeyBuYW1lOiBcImFtb3VudFwiLCB0eXBlOiBcInVpbnQyNTZcIiB9LFxuICAgIF0sXG4gICAgbmFtZTogXCJtaW50XCIsXG4gICAgb3V0cHV0czogW10sXG4gICAgc3RhdGVNdXRhYmlsaXR5OiBcIm5vbnBheWFibGVcIixcbiAgICB0eXBlOiBcImZ1bmN0aW9uXCIsXG4gIH0sXG4gIHtcbiAgICBpbnB1dHM6IFt7IG5hbWU6IFwiYW1vdW50XCIsIHR5cGU6IFwidWludDI1NlwiIH1dLFxuICAgIG5hbWU6IFwiYnVyblZhdWx0SW52ZW50b3J5XCIsXG4gICAgb3V0cHV0czogW10sXG4gICAgc3RhdGVNdXRhYmlsaXR5OiBcIm5vbnBheWFibGVcIixcbiAgICB0eXBlOiBcImZ1bmN0aW9uXCIsXG4gIH0sXG5dIGFzIGNvbnN0O1xuXG4vKipcbiAqIFx1N0JBMVx1NzQwNlx1NTRFMVx1NUMwOFx1NzUyOFx1RkYxQVx1NTcyOCBKQy9BRSBcdTRFRTNcdTVFNjNcdTU0MDhcdTdEMDRcdTRFMEFcdTU0N0NcdTUzRUIgb3duZXIgXHU3Njg0IGBtaW50YFx1RkYwQ1x1NTg5RVx1NzY3Q1x1NEY5Qlx1N0Q2Nlx1OTFDRlx1N0Q2Nlx1NEVGQlx1NjEwRlx1NTczMFx1NTc0MFxuICogXHVGRjA4XHU5MDFBXHU1RTM4XHU2NjJGIFNhZmUgXHU5MUQxXHU1RUFCXHVGRjA5XHUzMDAyXHU5MDE5XHU2NzAzXHU3NzFGXHU3Njg0XHU1ODlFXHU1MkEwXHU0RUUzXHU1RTYzXHU3RTNEXHU0RjlCXHU3RDY2XHU5MUNGXHVGRjBDXHU4MjA3IHRyYW5zZmVyRnJvbUhvdFdhbGxldFxuICogXHVGRjA4XHU1M0VBXHU2NjJGXHU2NDJDXHU1MkQ1XHU3MUIxXHU5MzIyXHU1MzA1XHU2NUUyXHU2NzA5XHU5OTE4XHU5ODREXHVGRjA5XHU0RTBEXHU1NDBDXHVGRjBDXHU2NTQ1XHU3MzY4XHU3QUNCXHU2MjEwXHU1M0U2XHU0RTAwXHU1MDBCXHU1MUZEXHU1RjBGXHUzMDAxXHU3NTMxXHU3MzY4XHU3QUNCIGFjdGlvbiBcdTYyOEFcdTk1RENcdTMwMDJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1pbnRUb2tlblN1cHBseSh0b2tlbjogXCJqY1Rva2VuXCIgfCBcImFlVG9rZW5cIiwgdG86IEFkZHJlc3MsIGFtb3VudDogbnVtYmVyKSB7XG4gIGF3YWl0IGVuc3VyZVJlbGF5ZXJHYXMoKTtcbiAgY29uc3QgZGVjaW1hbHMgPSBhd2FpdCB0b2tlbkRlY2ltYWxzKHRva2VuKTtcbiAgY29uc3QgYW1vdW50VW5pdHMgPSBwYXJzZVVuaXRzKGFtb3VudC50b0ZpeGVkKGRlY2ltYWxzKSwgZGVjaW1hbHMpO1xuICBjb25zdCBoYXNoID0gYXdhaXQgc2VuZEFkbWluVHgoKG5vbmNlKSA9PlxuICAgIGFkbWluV2FsbGV0Q2xpZW50KCkud3JpdGVDb250cmFjdCh7XG4gICAgICBhZGRyZXNzOiBSRUxBWUVSX0FERFJFU1NFU1t0b2tlbl0sXG4gICAgICBhYmk6IG1pbnRhYmxlQWJpLFxuICAgICAgZnVuY3Rpb25OYW1lOiBcIm1pbnRcIixcbiAgICAgIGFyZ3M6IFtnZXRBZGRyZXNzKHRvKSwgYW1vdW50VW5pdHNdLFxuICAgICAgY2hhaW46IFJFTEFZRVJfQ0hBSU4sXG4gICAgICBub25jZSxcbiAgICB9KSxcbiAgKTtcbiAgcmV0dXJuIHdhaXRBbmRSZXR1cm4oaGFzaCk7XG59XG5cbi8qKiBcdTdCQTFcdTc0MDZcdTU0RTFcdTUzRUFcdTgwRkRcdTkyQjdcdTZCQzAgU2FmZSBcdTkxRDFcdTVFQUJcdTVFQUJcdTVCNThcdUZGMUJcdTdENTVcdTRFMERcdTYzQTVcdTUzRDdcdTRFRkJcdTYxMEZcdTYzMDFcdTY3MDlcdTRFQkFcdTU3MzBcdTU3NDBcdTRGNUNcdTcwQkFcdTkyQjdcdTZCQzBcdTRGODZcdTZFOTBcdTMwMDIgKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidXJuVmF1bHRJbnZlbnRvcnkodG9rZW46IFwiamNcIiB8IFwiYWVcIiB8IFwicndhXCIsIGFtb3VudDogbnVtYmVyLCByd2FUb2tlbkFkZHJlc3M/OiBBZGRyZXNzKSB7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKGFtb3VudCkgfHwgYW1vdW50IDw9IDApIHRocm93IG5ldyBFcnJvcihcIlx1OTJCN1x1NkJDMFx1NjU3OFx1OTFDRlx1NUZDNVx1OTgwOFx1NTkyN1x1NjVCQyAwXCIpO1xuICBhd2FpdCBlbnN1cmVSZWxheWVyR2FzKCk7XG5cbiAgaWYgKHRva2VuID09PSBcInJ3YVwiKSB7XG4gICAgaWYgKCFyd2FUb2tlbkFkZHJlc3MpIHRocm93IG5ldyBFcnJvcihcIlJXQSBcdTVGQzVcdTk4MDhcdTYzMDdcdTVCOUEgRmFjdG9yeSBcdTVFRkFcdTdBQ0JcdTc2ODRcdTZBMTlcdTc2ODRcdTRFRTNcdTVFNjNcdTU3MzBcdTU3NDBcIik7XG4gICAgY29uc3QgcndhVG9rZW4gPSBnZXRBZGRyZXNzKHJ3YVRva2VuQWRkcmVzcyk7XG4gICAgY29uc3QgZmFjdG9yeUFkZHJlc3MgPSBSRUxBWUVSX0FERFJFU1NFUy5yd2FGYWN0b3J5O1xuICAgIGNvbnN0IGlzRmFjdG9yeVRva2VuID0gYXdhaXQgcHVibGljQ2xpZW50KCkucmVhZENvbnRyYWN0KHsgYWRkcmVzczogZmFjdG9yeUFkZHJlc3MsIGFiaTogcndhRmFjdG9yeUFiaSwgZnVuY3Rpb25OYW1lOiBcImlzRmFjdG9yeVRva2VuXCIsIGFyZ3M6IFtyd2FUb2tlbl0gfSk7XG4gICAgaWYgKCFpc0ZhY3RvcnlUb2tlbikgdGhyb3cgbmV3IEVycm9yKFwiXHU4QTcyXHU1NzMwXHU1NzQwXHU0RTBEXHU2NjJGXHU3NkVFXHU1MjREIFJXQSBGYWN0b3J5IFx1NUVGQVx1N0FDQlx1NzY4NFx1NkExOVx1NzY4NFx1NEVFM1x1NUU2M1wiKTtcbiAgICBjb25zdCB2YXVsdEFkZHJlc3MgPSBhd2FpdCBwdWJsaWNDbGllbnQoKS5yZWFkQ29udHJhY3QoeyBhZGRyZXNzOiBmYWN0b3J5QWRkcmVzcywgYWJpOiByd2FGYWN0b3J5QWJpLCBmdW5jdGlvbk5hbWU6IFwic2FmZVZhdWx0XCIgfSk7XG4gICAgY29uc3QgZGVjaW1hbHMgPSBhd2FpdCBzaGFyZVRva2VuRGVjaW1hbHMocndhVG9rZW4pO1xuICAgIGNvbnN0IGFtb3VudFVuaXRzID0gcGFyc2VVbml0cyhhbW91bnQudG9GaXhlZChkZWNpbWFscyksIGRlY2ltYWxzKTtcbiAgICBjb25zdCBiYWxhbmNlID0gYXdhaXQgcHVibGljQ2xpZW50KCkucmVhZENvbnRyYWN0KHsgYWRkcmVzczogcndhVG9rZW4sIGFiaTogc2hhcmVUb2tlbkFiaSwgZnVuY3Rpb25OYW1lOiBcImJhbGFuY2VPZlwiLCBhcmdzOiBbdmF1bHRBZGRyZXNzXSB9KTtcbiAgICBpZiAoYmFsYW5jZSA8IGFtb3VudFVuaXRzKSB0aHJvdyBuZXcgRXJyb3IoXCJTYWZlIFx1OTFEMVx1NUVBQlx1NzY4NFx1OEE3MiBSV0EgXHU1RUFCXHU1QjU4XHU0RTBEXHU4REIzXHVGRjBDXHU2NzJBXHU5MDAxXHU1MUZBXHU5MkI3XHU2QkMwXHU0RUE0XHU2NjEzXCIpO1xuICAgIGF3YWl0IHB1YmxpY0NsaWVudCgpLnNpbXVsYXRlQ29udHJhY3QoeyBhY2NvdW50OiByZWxheWVyQWRkcmVzcygpLCBhZGRyZXNzOiBmYWN0b3J5QWRkcmVzcywgYWJpOiByd2FGYWN0b3J5QWJpLCBmdW5jdGlvbk5hbWU6IFwiYnVyblZhdWx0SW52ZW50b3J5XCIsIGFyZ3M6IFtyd2FUb2tlbiwgYW1vdW50VW5pdHNdIH0pO1xuICAgIGNvbnN0IGhhc2ggPSBhd2FpdCBzZW5kQWRtaW5UeCgobm9uY2UpID0+XG4gICAgICBhZG1pbldhbGxldENsaWVudCgpLndyaXRlQ29udHJhY3QoeyBhZGRyZXNzOiBmYWN0b3J5QWRkcmVzcywgYWJpOiByd2FGYWN0b3J5QWJpLCBmdW5jdGlvbk5hbWU6IFwiYnVyblZhdWx0SW52ZW50b3J5XCIsIGFyZ3M6IFtyd2FUb2tlbiwgYW1vdW50VW5pdHNdLCBjaGFpbjogUkVMQVlFUl9DSEFJTiwgbm9uY2UgfSksXG4gICAgKTtcbiAgICByZXR1cm4gd2FpdEFuZFJldHVybihoYXNoKTtcbiAgfVxuXG4gIGNvbnN0IHRva2VuS2V5ID0gdG9rZW4gPT09IFwiamNcIiA/IFwiamNUb2tlblwiIDogXCJhZVRva2VuXCI7XG4gIGNvbnN0IGNvbnRyYWN0QWRkcmVzcyA9IFJFTEFZRVJfQUREUkVTU0VTW3Rva2VuS2V5XTtcbiAgY29uc3QgdmF1bHRBZGRyZXNzID0gUkVMQVlFUl9BRERSRVNTRVMuc2FmZVZhdWx0O1xuICBjb25zdCBkZWNpbWFscyA9IGF3YWl0IHRva2VuRGVjaW1hbHModG9rZW5LZXkpO1xuICBjb25zdCBhbW91bnRVbml0cyA9IHBhcnNlVW5pdHMoYW1vdW50LnRvRml4ZWQoZGVjaW1hbHMpLCBkZWNpbWFscyk7XG4gIGNvbnN0IGJhbGFuY2UgPSBhd2FpdCBwdWJsaWNDbGllbnQoKS5yZWFkQ29udHJhY3QoeyBhZGRyZXNzOiBjb250cmFjdEFkZHJlc3MsIGFiaTogZXJjMjBNaW5pbWFsQWJpLCBmdW5jdGlvbk5hbWU6IFwiYmFsYW5jZU9mXCIsIGFyZ3M6IFt2YXVsdEFkZHJlc3NdIH0pO1xuICBpZiAoYmFsYW5jZSA8IGFtb3VudFVuaXRzKSB0aHJvdyBuZXcgRXJyb3IoYFNhZmUgXHU5MUQxXHU1RUFCXHU3Njg0ICR7dG9rZW4udG9VcHBlckNhc2UoKX0gXHU1RUFCXHVGRkZEXHVGRkZEXHVGRkZEXHU0RTBEXHU4REIzXHVGRjBDXHU2NzJBXHU5MDAxXHU1MUZBXHU5MkI3XHU2QkMwXHU0RUE0XHU2NjEzYCk7XG4gIGF3YWl0IHB1YmxpY0NsaWVudCgpLnNpbXVsYXRlQ29udHJhY3QoeyBhY2NvdW50OiByZWxheWVyQWRkcmVzcygpLCBhZGRyZXNzOiBjb250cmFjdEFkZHJlc3MsIGFiaTogbWludGFibGVBYmksIGZ1bmN0aW9uTmFtZTogXCJidXJuVmF1bHRJbnZlbnRvcnlcIiwgYXJnczogW2Ftb3VudFVuaXRzXSB9KTtcbiAgY29uc3QgaGFzaCA9IGF3YWl0IHNlbmRBZG1pblR4KChub25jZSkgPT5cbiAgICBhZG1pbldhbGxldENsaWVudCgpLndyaXRlQ29udHJhY3QoeyBhZGRyZXNzOiBjb250cmFjdEFkZHJlc3MsIGFiaTogbWludGFibGVBYmksIGZ1bmN0aW9uTmFtZTogXCJidXJuVmF1bHRJbnZlbnRvcnlcIiwgYXJnczogW2Ftb3VudFVuaXRzXSwgY2hhaW46IFJFTEFZRVJfQ0hBSU4sIG5vbmNlIH0pLFxuICApO1xuICByZXR1cm4gd2FpdEFuZFJldHVybihoYXNoKTtcbn1cblxuLyoqXG4gKiBcdTc1MzEgQURNSU4gXHU3MUIxXHU5MzIyXHU1MzA1XHU2MjhBXHU2MzA3XHU1QjlBIEVSQy0yMCBcdThGNDlcdTUyMzBcdTVERjJcdTc1MzFcdTRGM0FcdTY3MERcdTU2NjhcdTlBNTdcdThCNDlcdTc2ODRcdTdEQjJcdTdBRDlcdTkzMjJcdTUzMDVcdTMwMDJcbiAqIFx1NTQwOFx1N0QwNFx1NTczMFx1NTc0MFx1NUZDNVx1OTgwOFx1NzUzMSBBUEkgXHU1RjlFXHU1NkZBXHVGRkZEXHVGRkZEXHU3NjdEXHU1NDBEXHU1NUFFXHU2MjE2IHBsYWNlbWVudHMudG9rZW5fYWRkcmVzcyBcdTYzQThcdTVDMEVcdUZGMUJcdTRFMERcdTYzQTVcdTUzRDdcdTRGN0ZcdTc1MjhcdTgwMDVcdTRFRkJcdTYxMEZcdTU0MDhcdTdEMDRcdTU3MzBcdTU3NDBcdTMwMDJcbiAqIFx1NTZERVx1NTBCM1x1NEVBNFx1NjYxM1x1OTZEQ1x1NkU0QVx1NEY0Nlx1NEUwRFx1N0I0OVx1NUY4NVx1NjUzNlx1NjREQVx1RkYwQ1x1OEI5MyBBUEkgXHU4MEZEXHU1MTQ4XHU0RkREXHU1QjU4XHU5NkRDXHU2RTRBXHVGRjBDXHU5MDdGXHU1MTREXHU5MDNFXHU2NjQyXHU1RjhDXHU5MUNEXHU4OTA3XHU3NjdDXHU5MDAxXHUzMDAyXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZW5kQWRtaW5Bc3NldFBheW91dChpbnB1dDoge1xuICB0b2tlbkFkZHJlc3M6IHN0cmluZztcbiAgcmVjaXBpZW50OiBBZGRyZXNzO1xuICBhbW91bnQ6IHN0cmluZztcbiAgbGFiZWw6IHN0cmluZztcbn0pOiBQcm9taXNlPGAweCR7c3RyaW5nfWA+IHtcbiAgYXdhaXQgZW5zdXJlUmVsYXllckdhcygpO1xuICBjb25zdCB0b2tlbiA9IGdldEFkZHJlc3MoaW5wdXQudG9rZW5BZGRyZXNzKTtcbiAgY29uc3QgZGVjaW1hbHMgPSBOdW1iZXIoYXdhaXQgcHVibGljQ2xpZW50KCkucmVhZENvbnRyYWN0KHtcbiAgICBhZGRyZXNzOiB0b2tlbixcbiAgICBhYmk6IGVyYzIwTWluaW1hbEFiaSxcbiAgICBmdW5jdGlvbk5hbWU6IFwiZGVjaW1hbHNcIixcbiAgfSkpO1xuICBpZiAoIU51bWJlci5pc0ludGVnZXIoZGVjaW1hbHMpIHx8IGRlY2ltYWxzIDwgMCB8fCBkZWNpbWFscyA+IDM2KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGAke2lucHV0LmxhYmVsfSBcdTU0MDhcdTdEMDRcdTU2REVcdTUwQjNcdTRFODZcdTcxMjFcdTY1NDhcdTc2ODRcdTVDMEZcdTY1NzhcdTRGNERcdTY1NzhgKTtcbiAgfVxuXG4gIGxldCBhbW91bnRVbml0czogYmlnaW50O1xuICB0cnkge1xuICAgIGFtb3VudFVuaXRzID0gcGFyc2VVbml0cyhpbnB1dC5hbW91bnQsIGRlY2ltYWxzKTtcbiAgfSBjYXRjaCB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGAke2lucHV0LmxhYmVsfSBcdTY1NzhcdTkxQ0ZcdThEODVcdTUxRkFcdTRFRTNcdTVFNjNcdTY1MkZcdTYzRjRcdTc2ODRcdTVDMEZcdTY1NzhcdTRGNERcdTY1NzhgKTtcbiAgfVxuICBpZiAoYW1vdW50VW5pdHMgPD0gMG4pIHRocm93IG5ldyBFcnJvcihcIlx1NkQzRVx1NzY3Q1x1NjU3OFx1OTFDRlx1NUZDNVx1OTgwOFx1NTkyN1x1NjVCQyAwXCIpO1xuXG4gIGNvbnN0IGJhbGFuY2UgPSAoYXdhaXQgcHVibGljQ2xpZW50KCkucmVhZENvbnRyYWN0KHtcbiAgICBhZGRyZXNzOiB0b2tlbixcbiAgICBhYmk6IGVyYzIwTWluaW1hbEFiaSxcbiAgICBmdW5jdGlvbk5hbWU6IFwiYmFsYW5jZU9mXCIsXG4gICAgYXJnczogW3JlbGF5ZXJBZGRyZXNzKCldLFxuICB9KSkgYXMgYmlnaW50O1xuICBpZiAoYmFsYW5jZSA8IGFtb3VudFVuaXRzKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBRE1JTiBcdTcxQjFcdTkzMjJcdTUzMDUgJHtpbnB1dC5sYWJlbH0gXHU1RUFCXHU1QjU4XHU0RTBEXHU4REIzXHVGRjBDXHU4QUNCXHU1MTQ4XHU4OERDXHU4Q0E4XHU1RjhDXHU1MThEXHU2RDNFXHU3NjdDYCk7XG4gIH1cblxuICByZXR1cm4gc2VuZEFkbWluVHgoKG5vbmNlKSA9PlxuICAgIGFkbWluV2FsbGV0Q2xpZW50KCkud3JpdGVDb250cmFjdCh7XG4gICAgICBhZGRyZXNzOiB0b2tlbixcbiAgICAgIGFiaTogZXJjMjBNaW5pbWFsQWJpLFxuICAgICAgZnVuY3Rpb25OYW1lOiBcInRyYW5zZmVyXCIsXG4gICAgICBhcmdzOiBbZ2V0QWRkcmVzcyhpbnB1dC5yZWNpcGllbnQpLCBhbW91bnRVbml0c10sXG4gICAgICBjaGFpbjogUkVMQVlFUl9DSEFJTixcbiAgICAgIG5vbmNlLFxuICAgIH0pLFxuICApO1xufVxuXG4vKiogXHU3QjQ5XHU1Rjg1XHU1REYyXHU0RkREXHU1QjU4XHU5NkRDXHU2RTRBXHU3Njg0XHU4RjQ5XHU1RTMzXHU2NTM2XHU2NERBXHVGRjFCXHU4RDg1XHU2NjQyXHU2NzAzXHU0RTFGXHU1MUZBXHU5MzJGXHU4QUE0XHVGRjBDXHU1NDdDXHU1M0VCXHU3QUVGXHU0RkREXHU3NTU5IHBlbmRpbmcgXHU5NjMyXHU2QjYyXHU5MUNEXHU4OTA3XHU2RDNFXHU3NjdDXHUzMDAyICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gd2FpdEZvckFkbWluQXNzZXRQYXlvdXQoaGFzaDogYDB4JHtzdHJpbmd9YCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCByZWNlaXB0ID0gYXdhaXQgcHVibGljQ2xpZW50KCkud2FpdEZvclRyYW5zYWN0aW9uUmVjZWlwdCh7IGhhc2gsIHRpbWVvdXQ6IDIwXzAwMCB9KTtcbiAgcmV0dXJuIHJlY2VpcHQuc3RhdHVzID09PSBcInN1Y2Nlc3NcIjtcbn1cblxuLyoqIFx1NjdFNVx1OEE2Mlx1N0Q5M1x1NEYzQVx1NjcwRFx1NTY2OFx1OUE1N1x1OEI0OVx1NzY4NFx1NEVFM1x1NUU2M1x1NTczMFx1NTc0MFx1NTNDQVx1NjMwN1x1NUI5QVx1NEY3Rlx1NzUyOFx1ODAwNVx1OTMyMlx1NTMwNVx1NzY4NFx1OTNDOFx1NEUwQVx1OTkxOFx1OTg0RFx1ODIwNyBBRE1JTiBhbGxvd2FuY2VcdTMwMDIgKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRMZWdhY3lBc3NldENoYWluU3RhdGUodG9rZW5BZGRyZXNzOiBzdHJpbmcsIG93bmVyOiBBZGRyZXNzKSB7XG4gIGNvbnN0IHRva2VuID0gZ2V0QWRkcmVzcyh0b2tlbkFkZHJlc3MpO1xuICBjb25zdCBkZWNpbWFscyA9IE51bWJlcihcbiAgICBhd2FpdCBwdWJsaWNDbGllbnQoKS5yZWFkQ29udHJhY3Qoe1xuICAgICAgYWRkcmVzczogdG9rZW4sXG4gICAgICBhYmk6IGVyYzIwTWluaW1hbEFiaSxcbiAgICAgIGZ1bmN0aW9uTmFtZTogXCJkZWNpbWFsc1wiLFxuICAgIH0pLFxuICApO1xuICBpZiAoIU51bWJlci5pc0ludGVnZXIoZGVjaW1hbHMpIHx8IGRlY2ltYWxzIDwgMCB8fCBkZWNpbWFscyA+IDM2KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiXHU4Q0M3XHU3NTIyXHU0RUUzXHU1RTYzXHU1NDA4XHU3RDA0XHU1NkRFXHU1MEIzXHU0RTg2XHU3MTIxXHU2NTQ4XHU3Njg0XHU1QzBGXHU2NTc4XHU0RjREXHU2NTc4XCIpO1xuICB9XG4gIGNvbnN0IFtiYWxhbmNlLCBhbGxvd2FuY2VdID0gKGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICBwdWJsaWNDbGllbnQoKS5yZWFkQ29udHJhY3Qoe1xuICAgICAgYWRkcmVzczogdG9rZW4sXG4gICAgICBhYmk6IGVyYzIwTWluaW1hbEFiaSxcbiAgICAgIGZ1bmN0aW9uTmFtZTogXCJiYWxhbmNlT2ZcIixcbiAgICAgIGFyZ3M6IFtnZXRBZGRyZXNzKG93bmVyKV0sXG4gICAgfSksXG4gICAgcHVibGljQ2xpZW50KCkucmVhZENvbnRyYWN0KHtcbiAgICAgIGFkZHJlc3M6IHRva2VuLFxuICAgICAgYWJpOiBlcmMyME1pbmltYWxBYmksXG4gICAgICBmdW5jdGlvbk5hbWU6IFwiYWxsb3dhbmNlXCIsXG4gICAgICBhcmdzOiBbZ2V0QWRkcmVzcyhvd25lciksIHJlbGF5ZXJBZGRyZXNzKCldLFxuICAgIH0pLFxuICBdKSkgYXMgW2JpZ2ludCwgYmlnaW50XTtcbiAgcmV0dXJuIHtcbiAgICBkZWNpbWFscyxcbiAgICBiYWxhbmNlOiBmb3JtYXRVbml0cyhiYWxhbmNlLCBkZWNpbWFscyksXG4gICAgYWxsb3dhbmNlOiBmb3JtYXRVbml0cyhhbGxvd2FuY2UsIGRlY2ltYWxzKSxcbiAgfTtcbn1cblxuLyoqXG4gKiBcdTRGN0ZcdTc1MjhcdTgwMDVcdTY3MkNcdTRFQkFcdTUxNDhcdTdDM0RcdTdGNzJcdTdDQkVcdTc4QkFcdTk4NERcdTVFQTYgYXBwcm92ZSBcdTVGOENcdUZGMENBRE1JTiBcdTUzRUFcdTYyOEFcdTY4MzhcdTUxQzZcdTc2ODRcdTgyMEFcdThDQzdcdTc1MjJcdTY1NzhcdTkxQ0ZcdThGNDlcdTUxNjVcdTcxQjFcdTkzMjJcdTUzMDVcdTMwMDJcbiAqIHRva2VuQWRkcmVzcyBcdTVGQzVcdTk4MDhcdTc1MzEgQVBJIFx1NUY5RSBBRSBcdTU2RkFcdTVCOUFcdTU3MzBcdTU3NDBcdTYyMTZcdTc5QzFcdTUyREZcdTZBMTlcdTc2ODRcdThDQzdcdTY1OTlcdTYzQThcdTVDMEVcdUZGMENcdTRFMERcdTUzRUZcdTYzQTFcdTc1MjhcdTUyNERcdTdBRUZcdTUwQjNcdTUwM0NcdTMwMDJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNlbmRBZG1pbkFzc2V0UmVjbGFpbShpbnB1dDoge1xuICB0b2tlbkFkZHJlc3M6IHN0cmluZztcbiAgb3duZXI6IEFkZHJlc3M7XG4gIGFtb3VudDogc3RyaW5nO1xuICBsYWJlbDogc3RyaW5nO1xufSk6IFByb21pc2U8YDB4JHtzdHJpbmd9YD4ge1xuICBhd2FpdCBlbnN1cmVSZWxheWVyR2FzKCk7XG4gIGNvbnN0IHRva2VuID0gZ2V0QWRkcmVzcyhpbnB1dC50b2tlbkFkZHJlc3MpO1xuICBjb25zdCBvd25lciA9IGdldEFkZHJlc3MoaW5wdXQub3duZXIpO1xuICBjb25zdCBkZWNpbWFscyA9IE51bWJlcihcbiAgICBhd2FpdCBwdWJsaWNDbGllbnQoKS5yZWFkQ29udHJhY3Qoe1xuICAgICAgYWRkcmVzczogdG9rZW4sXG4gICAgICBhYmk6IGVyYzIwTWluaW1hbEFiaSxcbiAgICAgIGZ1bmN0aW9uTmFtZTogXCJkZWNpbWFsc1wiLFxuICAgIH0pLFxuICApO1xuICBpZiAoIU51bWJlci5pc0ludGVnZXIoZGVjaW1hbHMpIHx8IGRlY2ltYWxzIDwgMCB8fCBkZWNpbWFscyA+IDM2KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGAke2lucHV0LmxhYmVsfSBcdTU0MDhcdTdEMDRcdTU2REVcdTUwQjNcdTRFODZcdTcxMjFcdTY1NDhcdTc2ODRcdTVDMEZcdTY1NzhcdTRGNERcdTY1NzhgKTtcbiAgfVxuICBsZXQgYW1vdW50VW5pdHM6IGJpZ2ludDtcbiAgdHJ5IHtcbiAgICBhbW91bnRVbml0cyA9IHBhcnNlVW5pdHMoaW5wdXQuYW1vdW50LCBkZWNpbWFscyk7XG4gIH0gY2F0Y2gge1xuICAgIHRocm93IG5ldyBFcnJvcihgJHtpbnB1dC5sYWJlbH0gXHU2NTc4XHU5MUNGXHU4RDg1XHU1MUZBXHU0RUUzXHU1RTYzXHU2NTJGXHU2M0Y0XHU3Njg0XHU1QzBGXHU2NTc4XHU0RjREXHU2NTc4YCk7XG4gIH1cbiAgaWYgKGFtb3VudFVuaXRzIDw9IDBuKSB0aHJvdyBuZXcgRXJyb3IoXCJcdTU2REVcdTY1MzZcdTY1NzhcdTkxQ0ZcdTVGQzVcdTk4MDhcdTU5MjdcdTY1QkMgMFwiKTtcblxuICBjb25zdCBbYWxsb3dhbmNlLCBiYWxhbmNlXSA9IChhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgcHVibGljQ2xpZW50KCkucmVhZENvbnRyYWN0KHtcbiAgICAgIGFkZHJlc3M6IHRva2VuLFxuICAgICAgYWJpOiBlcmMyME1pbmltYWxBYmksXG4gICAgICBmdW5jdGlvbk5hbWU6IFwiYWxsb3dhbmNlXCIsXG4gICAgICBhcmdzOiBbb3duZXIsIHJlbGF5ZXJBZGRyZXNzKCldLFxuICAgIH0pLFxuICAgIHB1YmxpY0NsaWVudCgpLnJlYWRDb250cmFjdCh7XG4gICAgICBhZGRyZXNzOiB0b2tlbixcbiAgICAgIGFiaTogZXJjMjBNaW5pbWFsQWJpLFxuICAgICAgZnVuY3Rpb25OYW1lOiBcImJhbGFuY2VPZlwiLFxuICAgICAgYXJnczogW293bmVyXSxcbiAgICB9KSxcbiAgXSkpIGFzIFtiaWdpbnQsIGJpZ2ludF07XG4gIGlmIChhbGxvd2FuY2UgPCBhbW91bnRVbml0cykge1xuICAgIHRocm93IG5ldyBFcnJvcihgJHtpbnB1dC5sYWJlbH0gXHU1QzFBXHU2NzJBXHU2Mzg4XHU2QjBBXHU2MjE2XHU2Mzg4XHU2QjBBXHU5ODREXHU1RUE2XHU0RTBEXHU4REIzXHVGRjBDXHU4QUNCXHU1MTQ4XHU1NzI4XHU5MzIyXHU1MzA1XHU3QzNEXHU3RjcyXHU3Q0JFXHU3OEJBXHU5ODREXHU1RUE2XHU2Mzg4XHU2QjBBYCk7XG4gIH1cbiAgaWYgKGJhbGFuY2UgPCBhbW91bnRVbml0cykge1xuICAgIHRocm93IG5ldyBFcnJvcihgJHtpbnB1dC5sYWJlbH0gXHU5M0M4XHU0RTBBXHU5OTE4XHU5ODREXHU1REYyXHU4QjhBXHU1MkQ1XHVGRjBDXHU4QUNCXHU5MUNEXHU2NUIwXHU2NTc0XHU3NDA2XHU1RjhDXHU3OEJBXHU4QThEXHU1M0VGXHU1NkRFXHU2NTM2XHU2NTc4XHU5MUNGYCk7XG4gIH1cblxuICByZXR1cm4gc2VuZEFkbWluVHgoKG5vbmNlKSA9PlxuICAgIGFkbWluV2FsbGV0Q2xpZW50KCkud3JpdGVDb250cmFjdCh7XG4gICAgICBhZGRyZXNzOiB0b2tlbixcbiAgICAgIGFiaTogZXJjMjBNaW5pbWFsQWJpLFxuICAgICAgZnVuY3Rpb25OYW1lOiBcInRyYW5zZmVyRnJvbVwiLFxuICAgICAgYXJnczogW293bmVyLCByZWxheWVyQWRkcmVzcygpLCBhbW91bnRVbml0c10sXG4gICAgICBjaGFpbjogUkVMQVlFUl9DSEFJTixcbiAgICAgIG5vbmNlLFxuICAgIH0pLFxuICApO1xufVxuXG4vKiogXHU3QjQ5XHU1Rjg1XHU1REYyXHU0RkREXHU1QjU4XHU3Njg0XHU4MjBBXHU4Q0M3XHU3NTIyXHU1NkRFXHU2NTM2XHU0RUE0XHU2NjEzXHU2NTM2XHU2NERBXHVGRjFCXHU4RDg1XHU2NjQyXHU2NjQyXHU0RkREXHU3NTU5IHBlbmRpbmcgXHU1M0NBIHR4IGhhc2ggXHU0RUU1XHU5MDdGXHU1MTREXHU5MUNEXHU4OTA3XHU4RjQ5XHU1MUZBXHUzMDAyICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gd2FpdEZvckFkbWluQXNzZXRSZWNsYWltKGhhc2g6IGAweCR7c3RyaW5nfWApOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3QgcmVjZWlwdCA9IGF3YWl0IHB1YmxpY0NsaWVudCgpLndhaXRGb3JUcmFuc2FjdGlvblJlY2VpcHQoeyBoYXNoLCB0aW1lb3V0OiAyMF8wMDAgfSk7XG4gIHJldHVybiByZWNlaXB0LnN0YXR1cyA9PT0gXCJzdWNjZXNzXCI7XG59XG5cbi8qKiBcdTk3NUVcdTk2M0JcdTU4NUVcdTU3MzBcdTZBQTJcdTY3RTVcdTVERjJcdTRGRERcdTVCNThcdTRFQTRcdTY2MTNcdTY2MkZcdTU0MjZcdTVCOENcdTYyMTBcdUZGMUJSUEMgXHU2N0U1XHU0RTBEXHU1MjMwXHU2NTM2XHU2NERBXHU2NjQyXHU0RkREXHU3NTU5IHBlbmRpbmdcdUZGMENcdTRFMERcdTkxQ0RcdTkwMDFcdTRFQTRcdTY2MTNcdTMwMDIgKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRBZG1pbkFzc2V0UmVjbGFpbVJlY2VpcHRTdGF0dXMoXG4gIGhhc2g6IGAweCR7c3RyaW5nfWAsXG4pOiBQcm9taXNlPFwiY29uZmlybWVkXCIgfCBcImZhaWxlZFwiIHwgXCJwZW5kaW5nXCI+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCByZWNlaXB0ID0gYXdhaXQgcHVibGljQ2xpZW50KCkuZ2V0VHJhbnNhY3Rpb25SZWNlaXB0KHsgaGFzaCB9KTtcbiAgICByZXR1cm4gcmVjZWlwdC5zdGF0dXMgPT09IFwic3VjY2Vzc1wiID8gXCJjb25maXJtZWRcIiA6IFwiZmFpbGVkXCI7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBcInBlbmRpbmdcIjtcbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEpDIFx1NjUzNlx1NkIzRVx1ODIwN1x1NTIwNlx1NkQ0MVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vL1xuLy8gMjAyNi0xMC0wNCBcdTY1QjAgSkMgXHU1NDA4XHU3RDA0XHU1REYyXHU3OUZCXHU5NjY0XHU4MjBBXHU3MjQ4IFAyUCBcdThGNDlcdTVFMzNcdTk2NTBcdTUyMzZcdUZGMENcdTdCMjZcdTU0MDhcdTZBMTlcdTZFOTYgRVJDLTIwXHUzMDAyXHU2NUIwXHU4QThEXHU4Q0ZDXHU3NkY0XHU2M0E1XHU3NTMxXG4vLyBBRE1JTiBcdTYxOTFcdThDQjdcdTY1QjlcdTY3MkNcdTdCNDZcdTdDQkVcdTc4QkEgYXBwcm92ZVx1RkYwQ1x1NTVBRVx1N0I0NiB0cmFuc2ZlckZyb20oXHU4Q0I3XHU2NUI5IFx1MjE5MiBTYWZlKVx1RkYxQlx1ODIwQVx1NzI0OFx1NTE2OVx1OERGMyBoZWxwZXJcbi8vIHB1bGxKY0Zyb21Vc2VyL2FkbWluU2VuZEpjIFx1NEZERFx1NzU1OVx1N0Q2Nlx1NkI3N1x1NTNGMlx1N0Q1MFx1N0I5N1x1N0U4Q1x1OEREMVx1NTNDQVx1NEU4Q1x1N0QxQVx1NUUwMlx1NTgzNFx1NTIwNlx1NkQ0MVx1RkYwQ1x1OTA3Rlx1NTE0RFx1OTFDRFx1NjI2M1x1OENCN1x1NjVCOSBKQ1x1MzAwMlxuXG5cbi8qKlxuICogXHU1MTY5XHU4REYzXHU2NTM2XHU2QjNFXHU3Njg0XHU3QjJDXHU0RTAwXHU4REYzXHVGRjFBXHU2MjhBIEpDIFx1NUY5RVx1NEY3Rlx1NzUyOFx1ODAwNVx1OTMyMlx1NTMwNVx1NjJDOVx1OTAzMiBBRE1JTiBcdTcxQjFcdTkzMjJcdTUzMDVcdUZGMDh0cmFuc2ZlckZyb20oZnJvbVx1MjE5MkFETUlOKVx1RkYwOVx1MzAwMlxuICogXHU5MDAxXHU1MUZBXHU1MjREXHU5ODEwXHU2QUEyIGZyb20gXHU1QzBEIEFETUlOIFx1NzY4NFx1NjM4OFx1NkIwQVx1ODIwNyBKQyBcdTk5MThcdTk4NERcdUZGMENcdTRFRkJcdTRFMDBcdTRFMERcdThEQjNcdTRFMUZcdTUxRkFcdTZFMDVcdTY5NUFcdTRFMkRcdTY1ODdcdTkzMkZcdThBQTRcdUZGMDhcdTRGOUJcdTRFMEFcdTVDNjRcdTY0REFcdTRFRTVcbiAqIFx1NjRDQlx1NEUwQlx1NEVBNFx1NjYxM1x1RkYwOVx1MjAxNFx1MjAxNFx1NzI3OVx1NTIyNVx1NjNEMFx1OTE5Mlx1NTIwNlx1NkY2NCBKQyBcdTVDMUFcdTY3MkFcdTRFMEFcdTkzQzhcdUZGMENcdTk3MDBcdTUxNDhcdTU3MjhcdTkxRDFcdTVFQUJcdThDRkNcdThDQjdcdThEQjNcdTk4NEQgSkNcdTMwMDJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHB1bGxKY0Zyb21Vc2VyKFxuICBmcm9tOiBBZGRyZXNzLFxuICBqY0Ftb3VudDogbnVtYmVyLFxuICBvblN1Ym1pdHRlZD86IE9uQWRtaW5UcmFuc2FjdGlvblN1Ym1pdHRlZCxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IGRlY2ltYWxzID0gYXdhaXQgdG9rZW5EZWNpbWFscyhcImpjVG9rZW5cIik7XG4gIHJldHVybiB0cmFuc2ZlckZyb21WaWFBZG1pbih7XG4gICAgdG9rZW46IFJFTEFZRVJfQUREUkVTU0VTLmpjVG9rZW4sXG4gICAgZnJvbSxcbiAgICB0bzogcmVsYXllckFkZHJlc3MoKSxcbiAgICBhbW91bnRVbml0czogcGFyc2VVbml0cyhqY0Ftb3VudC50b0ZpeGVkKGRlY2ltYWxzKSwgZGVjaW1hbHMpLFxuICAgIG5vQWxsb3dhbmNlTXNnOlxuICAgICAgXCJcdTVDMUFcdTY3MkFcdTYzODhcdTZCMEFcdTVFNzNcdTUzRjBcdTUyRDVcdTc1MjhcdTYwQThcdTc2ODQgSkNcdUZGMDhcdTYyMTZcdTYzODhcdTZCMEFcdTk4NERcdTVFQTZcdTRFMERcdThEQjNcdUZGMDlcdUZGMENcdTcxMjFcdTZDRDVcdTVCOENcdTYyMTBcdTkzQzhcdTRFMEEgSkMgXHU2NTM2XHU2QjNFXHUzMDAyXHU4QUNCXHU1NzI4IEFwcCBcdTUxNjdcdTkxQ0RcdTY1QjBcdTY0Q0RcdTRGNUNcdTRFRTVcdTVCOENcdTYyMTBcdTRFMDBcdTZCMjFcdTYwMjcgSkMgXHU2Mzg4XHU2QjBBXHU1RjhDXHU1MThEXHU4QTY2XHUzMDAyXCIsXG4gICAgbG93QmFsYW5jZU1zZzpcbiAgICAgIFwiXHU2MEE4XHU3Njg0XHU5M0M4XHU0RTBBIEpDIFx1OTkxOFx1OTg0RFx1NEUwRFx1OERCM1x1NEVFNVx1NjUyRlx1NEVEOFx1NjcyQ1x1N0I0Nlx1OTFEMVx1OTg0RFx1MzAwMlx1NkNFOFx1NjEwRlx1RkYxQVx1NTIwNlx1NkY2NCBKQyBcdTUwQzVcdThBMThcdTU3MjhcdTdBRDlcdTUxNjdcdTVFMzNcdTY3MkNcdTMwMDFcdTVDMUFcdTY3MkFcdTRFMEFcdTkzQzhcdUZGMENcdTk3MDBcdTUxNDhcdTU3MjhcdTkzMjJcdTUzMDVcdTkxRDFcdTVFQUJcdTc1MjggVVNEVCBcdThDRkNcdThDQjdcdThEQjNcdTk4NEQgSkMgXHU2MjREXHU4MEZEXHU4QThEXHU4Q0ZDXHU2MjE2XHU0RUE0XHU2NjEzXHUzMDAyXCIsXG4gICAgb25TdWJtaXR0ZWQsXG4gIH0pO1xufVxuXG5cbi8qKlxuICogXHU1MTY5XHU4REYzXHU2NTM2XHU2QjNFXHU3Njg0XHU3QjJDXHU0RThDXHU4REYzXHVGRjFBQURNSU4gXHU3MUIxXHU5MzIyXHU1MzA1XHU3NTI4XHU4MUVBXHU1REYxXHU3Njg0IEpDIFx1OTkxOFx1OTg0RCB0cmFuc2ZlciBcdTdENjYgYHRvYFx1RkYwOFNhZmUgXHU5MUQxXHU1RUFCXHU2MjE2XG4gKiBcdThDRTNcdTY1QjlcdUZGMDlcdTMwMDJcdTU2RTBcdTgyMDcgb3duZXIgXHU3NkY4XHU5NURDXHVGRjBDSkMgXHU1NDA4XHU3RDA0XHU1MTQxXHU4QTMxXHUzMDAyYW1vdW50PD0wIFx1NTZERVx1NTBCMyBudWxsXHVGRjA4XHU3MTIxXHU5NzAwXHU4RjQ5XHU1RTMzXHVGRjA5XHUzMDAyXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhZG1pblNlbmRKYyhcbiAgdG86IEFkZHJlc3MsXG4gIGpjQW1vdW50OiBudW1iZXIsXG4gIG9uU3VibWl0dGVkPzogT25BZG1pblRyYW5zYWN0aW9uU3VibWl0dGVkLFxuKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGlmICghKGpjQW1vdW50ID4gMCkpIHJldHVybiBudWxsO1xuICBhd2FpdCBlbnN1cmVSZWxheWVyR2FzKCk7XG4gIGNvbnN0IGRlY2ltYWxzID0gYXdhaXQgdG9rZW5EZWNpbWFscyhcImpjVG9rZW5cIik7XG4gIGNvbnN0IGFtb3VudFVuaXRzID0gcGFyc2VVbml0cyhqY0Ftb3VudC50b0ZpeGVkKGRlY2ltYWxzKSwgZGVjaW1hbHMpO1xuICBhd2FpdCBlbnN1cmVIb3RXYWxsZXRDYW5Db3ZlcihcImpjVG9rZW5cIiwgYW1vdW50VW5pdHMpO1xuICBjb25zdCBoYXNoID0gYXdhaXQgc2VuZEFkbWluVHgoKG5vbmNlKSA9PlxuICAgIGFkbWluV2FsbGV0Q2xpZW50KCkud3JpdGVDb250cmFjdCh7XG4gICAgICBhZGRyZXNzOiBSRUxBWUVSX0FERFJFU1NFUy5qY1Rva2VuLFxuICAgICAgYWJpOiBqY0FiaSxcbiAgICAgIGZ1bmN0aW9uTmFtZTogXCJ0cmFuc2ZlclwiLFxuICAgICAgYXJnczogW2dldEFkZHJlc3ModG8pLCBhbW91bnRVbml0c10sXG4gICAgICBjaGFpbjogUkVMQVlFUl9DSEFJTixcbiAgICAgIG5vbmNlLFxuICAgIH0pLFxuICApO1xuICBhd2FpdCBvblN1Ym1pdHRlZD8uKGhhc2gpO1xuICByZXR1cm4gd2FpdEFuZFJldHVybihoYXNoKTtcbn1cblxuLyoqIFx1NTE2OVx1OERGM1x1NjUzNlx1NkIzRVx1NzY4NFx1N0IyQ1x1NEU4Q1x1OERGM1x1RkYwOFx1NjUzNlx1OTAzMiBTYWZlIFx1OTFEMVx1NUVBQlx1RkYwOVx1RkYxQUFETUlOIFx1MjE5MiBTYWZlIFx1OTFEMVx1NUVBQlx1MzAwMiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNlbmRKY1RvVmF1bHQoXG4gIGpjQW1vdW50OiBudW1iZXIsXG4gIG9uU3VibWl0dGVkPzogT25BZG1pblRyYW5zYWN0aW9uU3VibWl0dGVkLFxuKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIHJldHVybiBhZG1pblNlbmRKYyhSRUxBWUVSX0FERFJFU1NFUy5zYWZlVmF1bHQsIGpjQW1vdW50LCBvblN1Ym1pdHRlZCk7XG59XG5cblxuICBjb25zdCB1c2R0RGVjaW1hbHNDYWNoZTogeyB2YWx1ZTogbnVtYmVyIHwgbnVsbCB9ID0geyB2YWx1ZTogbnVsbCB9O1xuICBhc3luYyBmdW5jdGlvbiB1c2R0RGVjaW1hbHMoKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgaWYgKHVzZHREZWNpbWFsc0NhY2hlLnZhbHVlICE9IG51bGwpIHJldHVybiB1c2R0RGVjaW1hbHNDYWNoZS52YWx1ZTtcbiAgbGV0IHZhbHVlID0gNjtcbiAgdHJ5IHtcbiAgdmFsdWUgPSBOdW1iZXIoXG4gIGF3YWl0IHB1YmxpY0NsaWVudCgpLnJlYWRDb250cmFjdCh7IGFkZHJlc3M6IFJFTEFZRVJfQUREUkVTU0VTLnVzZHQsIGFiaTogZXJjMjBNaW5pbWFsQWJpLCBmdW5jdGlvbk5hbWU6IFwiZGVjaW1hbHNcIiB9KSxcbiAgKTtcbiAgfSBjYXRjaCB7XG4gIHZhbHVlID0gNjtcbiAgfVxuICB1c2R0RGVjaW1hbHNDYWNoZS52YWx1ZSA9IHZhbHVlO1xuICByZXR1cm4gdmFsdWU7XG4gIH1cblxuICAvKipcbiAgKiBKQyBcdThEMTZcdTU2REVcdTY0QTVcdTZCM0VcdUZGMUFBRE1JTiBcdTcxQjFcdTkzMjJcdTUzMDVcdTc2RjRcdTYzQTVcdTc1MjhcdTgxRUFcdTVERjFcdTc2ODQgVVNEVCBcdTk5MThcdTk4NEQgdHJhbnNmZXIgXHU3RDY2XHU0RjdGXHU3NTI4XHU4MDA1XHUzMDAyXHU4MjA3XG4gICogY29sbGVjdEpjVG9WYXVsdFx1RkYwOFx1NjI4QVx1NEY3Rlx1NzUyOFx1ODAwNVx1OTNDOFx1NEUwQSBKQyBcdTY1MzZcdTU2REUgU2FmZVx1RkYwOVx1NjYyRlx1NTQwNFx1ODFFQVx1NzM2OFx1N0FDQlx1NzY4NFx1NTE2OVx1N0I0Nlx1NEVBNFx1NjYxM1x1RkYwQ1x1NEU5Mlx1NEUwRFxuICAqIFx1NEY5RFx1OENGNFx1NUY3Q1x1NkI2NFx1NzY4NFx1NjIxMFx1NjU1N1x1RkYwQ1x1NTQ3Q1x1NTNFQlx1N0FFRlx1ODFFQVx1ODg0Q1x1NkM3QVx1NUI5QVx1NTdGN1x1ODg0Q1x1OTgwNlx1NUU4Rlx1ODIwN1x1NjYyRlx1NTQyNlx1NEU5Mlx1NzBCQVx1NTI0RFx1NjNEMFx1MzAwMmFtb3VudDw9MCBcdTU2REVcdTUwQjNcbiAgKiBudWxsXHVGRjA4XHU3MTIxXHU5NzAwXHU2NEE1XHU2QjNFXHVGRjA5XHUzMDAyXHU5MDAxXHU1MUZBXHU1MjREXHU5ODEwXHU2QUEyXHU3MUIxXHU5MzIyXHU1MzA1IFVTRFQgXHU5OTE4XHU5ODREXHVGRjBDXHU0RTBEXHU4REIzXHU1QzMxXHU0RTFGXHU1MUZBXHU2RTA1XHU2OTVBXHU0RTJEXHU2NTg3XHU5MzJGXHU4QUE0XHVGRjBDXG4gICogXHU2M0QwXHU3OTNBXHU3QkExXHU3NDA2XHU1NEUxXHU1RjlFIFNhZmUgXHU5MUQxXHU1RUFCXHU4RjQ5XHU1MTY1IFVTRFQgXHU4OERDXHU4Q0E4XHVGRjBDXHU4MDBDXHU0RTBEXHU2NjJGXHU5MDAxXHU1MUZBXHU2Q0U4XHU1QjlBXHU1OTMxXHU2NTU3XHU3Njg0XHU0RUE0XHU2NjEzXHUzMDAyXG4gICovXG4gIGV4cG9ydCBhc3luYyBmdW5jdGlvbiBhZG1pblNlbmRVc2R0KHRvOiBBZGRyZXNzLCB1c2R0QW1vdW50OiBudW1iZXIpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgaWYgKCEodXNkdEFtb3VudCA+IDApKSByZXR1cm4gbnVsbDtcbiAgYXdhaXQgZW5zdXJlUmVsYXllckdhcygpO1xuICBjb25zdCBkZWNpbWFscyA9IGF3YWl0IHVzZHREZWNpbWFscygpO1xuICBjb25zdCBhbW91bnRVbml0cyA9IHBhcnNlVW5pdHModXNkdEFtb3VudC50b0ZpeGVkKGRlY2ltYWxzKSwgZGVjaW1hbHMpO1xuICBjb25zdCBiYWxhbmNlID0gKGF3YWl0IHB1YmxpY0NsaWVudCgpLnJlYWRDb250cmFjdCh7XG4gIGFkZHJlc3M6IFJFTEFZRVJfQUREUkVTU0VTLnVzZHQsXG4gIGFiaTogZXJjMjBNaW5pbWFsQWJpLFxuICBmdW5jdGlvbk5hbWU6IFwiYmFsYW5jZU9mXCIsXG4gIGFyZ3M6IFtyZWxheWVyQWRkcmVzcygpXSxcbiAgfSkpIGFzIGJpZ2ludDtcbiAgaWYgKGJhbGFuY2UgPCBhbW91bnRVbml0cykge1xuICB0aHJvdyBuZXcgRXJyb3IoXG4gIGBBRE1JTiBcdTcxQjFcdTkzMjJcdTUzMDUgVVNEVCBcdTk5MThcdTk4NERcdTRFMERcdThEQjNcdUZGMDhcdTc2RUVcdTUyNEQgJHtmb3JtYXRVbml0cyhiYWxhbmNlLCBkZWNpbWFscyl9IFVTRFRcdUZGMENcdTk3MDBcdTg5ODEgJHtmb3JtYXRVbml0cyhhbW91bnRVbml0cywgZGVjaW1hbHMpfSBVU0RUXHVGRjA5XHVGRjBDXHU4QUNCXHU3QkExXHU3NDA2XHU1NEUxXHU1RjlFIFNhZmUgXHU5MUQxXHU1RUFCXHU4RjQ5XHU1MTY1IFVTRFQgXHU4OERDXHU4Q0E4YCxcbiAgKTtcbiAgfVxuICBjb25zdCBoYXNoID0gYXdhaXQgc2VuZEFkbWluVHgoKG5vbmNlKSA9PlxuICBhZG1pbldhbGxldENsaWVudCgpLndyaXRlQ29udHJhY3Qoe1xuICBhZGRyZXNzOiBSRUxBWUVSX0FERFJFU1NFUy51c2R0LFxuICBhYmk6IGVyYzIwTWluaW1hbEFiaSxcbiAgZnVuY3Rpb25OYW1lOiBcInRyYW5zZmVyXCIsXG4gIGFyZ3M6IFtnZXRBZGRyZXNzKHRvKSwgYW1vdW50VW5pdHNdLFxuICBjaGFpbjogUkVMQVlFUl9DSEFJTixcbiAgbm9uY2UsXG4gIH0pLFxuICApO1xuICByZXR1cm4gd2FpdEFuZFJldHVybihoYXNoKTtcbiAgfVxuXG4vKipcbiAqIFx1NjI4QSBKQyBcdTVGOUVcdThDQjdcdTY1QjlcdTkzMjJcdTUzMDVcdTVCRTZcdTk2OUJcdTY1MzZcdTkwMzIgU2FmZSBcdTkxRDFcdTVFQUJcdTMwMDJcbiAqXG4gKiBcdTc1MjhcdTkwMTRcdUZGMUFcdTRFMDBcdTdEMUFcdThBOERcdThDRkNcdTY3MkNcdTkxRDEgSkNcdUZGMDhcdThDQjdcdTY1QjlcdTRFRDhcdTZCM0VcdUZGMDlcdTc2RjRcdTYzQTVcdTU2REVcdTUyMzAgU2FmZSBcdTkxRDFcdTVFQUJcdTMwMDJcdTY1QjBcdThBOERcdThDRkNcdTYzQTFcdTU1QUVcdTdCNDZcdTdDQkVcdTc4QkFcdTYzODhcdTZCMEFcdUZGMUFcbiAqIFx1OENCN1x1NjVCOVx1NTcyOCBBcHAgXHU1MTY3IGFwcHJvdmUgQURNSU4gXHU2NzJDXHU3QjQ2XHU5MUQxXHU5ODREXHVGRjBDXHU1MThEXHU3NTMxIEFETUlOIFx1NTdGN1x1ODg0Q1xuICogYHRyYW5zZmVyRnJvbShcdThDQjdcdTY1QjkgXHUyMTkyIFNhZmUsIGFtb3VudClgXHUzMDAyXHU5MDE5XHU2QTIzXHU4MUVBXHU1MkQ1XHU4OERDXHU3NjdDXHU2NjQyXHU0RTBEXHU5NzAwXHU4OTgxXHU4Q0I3XHU2NUI5XHU1MThEXHU2QjIxXHU3QzNEXHU1NDBEXHVGRjBDXHU1MjREXHU2M0QwXHU2NjJGXG4gKiBcdTUyMURcdTZCMjFcdThBOERcdThDRkNcdTUyNERcdTVERjJcdTVCOENcdTYyMTBcdThBNzJcdTdCNDYgYXBwcm92ZSBcdTRFMTRcdTkzQzhcdTRFMEEgSkMgXHU5OTE4XHU5ODREXHU4REIzXHU1OTIwXHUzMDAyXG4gKlxuICogXHU5MDAxXHU1MUZBXHU1MjREXHU5ODEwXHU2QUEyXHU4Q0I3XHU2NUI5XHU1QzBEIEFETUlOIFx1NzY4NFx1NjM4OFx1NkIwQVx1OTg0RFx1NUVBNlx1ODIwNyBKQyBcdTk5MThcdTk4NERcdUZGMENcdTRFRkJcdTRFMDBcdTRFMERcdThEQjNcdTVDMzFcdTRFMUZcdTUxRkFcdTZFMDVcdTY5NUFcdTRFMkRcdTY1ODdcdTkzMkZcdThBQTRcdTgwMENcbiAqIFx1NEUwRFx1OTAwMVx1NTFGQVx1NkNFOFx1NUI5QSByZXZlcnQgXHU3Njg0XHU0RUE0XHU2NjEzXHUzMDAyYW1vdW50PD0wIFx1NjY0Mlx1NTZERVx1NTBCMyBudWxsXHVGRjA4XHU3MTIxXHU5NzAwXHU2NTM2XHU2QjNFXHVGRjA5XHUzMDAyXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjb2xsZWN0SmNUb1ZhdWx0KFxuICBmcm9tOiBBZGRyZXNzLFxuICBqY0Ftb3VudDogbnVtYmVyLFxuICBvblN1Ym1pdHRlZD86IE9uQWRtaW5UcmFuc2FjdGlvblN1Ym1pdHRlZCxcbik6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICByZXR1cm4gY29sbGVjdEpjKGZyb20sIFJFTEFZRVJfQUREUkVTU0VTLnNhZmVWYXVsdCwgamNBbW91bnQsIHtcbiAgICBub0FsbG93YW5jZU1zZzpcbiAgICAgIFwiXHU4Q0I3XHU2NUI5XHU1QzFBXHU2NzJBXHU2Mzg4XHU2QjBBXHU1RTczXHU1M0YwXHU1MkQ1XHU3NTI4XHU1MTc2IEpDXHVGRjA4XHU2MjE2XHU2Mzg4XHU2QjBBXHU5ODREXHU1RUE2XHU0RTBEXHU4REIzXHVGRjA5XHVGRjBDXHU3MTIxXHU2Q0Q1XHU2MjhBXHU4QThEXHU4Q0ZDIEpDIFx1NjUzNlx1OTAzMlx1OTFEMVx1NUVBQlx1MzAwMlx1OEFDQlx1OENCN1x1NjVCOVx1NTcyOCBBcHAgXHU1MTY3XHU5MUNEXHU2NUIwXHU5MDAxXHU1MUZBXHU0RTAwXHU2QjIxXHU4QThEXHU4Q0ZDXHU0RUU1XHU1QjhDXHU2MjEwXHU0RTAwXHU2QjIxXHU2MDI3IEpDIFx1NjM4OFx1NkIwQVx1NUY4Q1x1NTE4RFx1OTFDRFx1OEE2Nlx1MzAwMlwiLFxuICAgIGxvd0JhbGFuY2VNc2c6IFwiXHU4Q0I3XHU2NUI5IEpDIFx1OTNDOFx1NEUwQVx1OTkxOFx1OTg0RFx1NEUwRFx1OERCM1x1RkYwQ1x1NzEyMVx1NkNENVx1RkZGRFx1RkZGRFx1RkZGRFx1OEE4RFx1OENGQyBKQyBcdTY1MzZcdTkwMzIgU2FmZSBcdTkxRDFcdTVFQUJcdTMwMDJcIixcbiAgfSwgb25TdWJtaXR0ZWQpO1xufVxuXG4vKipcbiAqIFx1OTAxQVx1NzUyOFx1MzAwQ0FETUlOIFx1NjE5MVx1OENCN1x1NjVCOVx1NEUwMFx1NkIyMVx1NjAyN1x1NjM4OFx1NkIwQVx1RkYwQ1x1NjI4QSBKQyBcdTVGOUUgYGZyb21gIFx1OEY0OVx1NTIzMCBgdG9gXHUzMDBEXHUzMDAyXG4gKlxuICogXHU0RThDXHU3RDFBXHU1RTAyXHU1ODM0XHU2MjEwXHU0RUE0XHU0RTVGXHU3NTI4XHU2QjY0XHU2QTIxXHU1NzhCXHU2MjhBIEpDIFx1NTIwNlx1NkQ0MVx1RkYxQVx1OENCN1x1NjVCOVx1NEVEOFx1NzY4NCBncm9zcyBKQyBcdTYyQzZcdTYyMTAgbmV0XHUyMTkyXHU4Q0UzXHU2NUI5XHUzMDAxZmVlXHUyMTkyU2FmZVxuICogXHU5MUQxXHU1RUFCXHU1MTY5XHU3QjQ2IHRyYW5zZmVyRnJvbVx1RkYwOFx1OTBGRFx1NTJENVx1NzUyOFx1OENCN1x1NjVCOVx1NUMwRCBBRE1JTiBcdTc2ODRcdTYzODhcdUZGRkRcdUZGRkRcdUZGMDlcdTMwMDJcdTgyMDdcdThBOERcdThDRkNcdTUxNzFcdTc1MjhcdTU0MENcdTRFMDBcdTU5NTdcdTMwMENcdThDQjdcdTY1QjlcbiAqIFx1NEUwMFx1NkIyMVx1NjAyN1x1NjM4OFx1NkIwQSBBRE1JTlx1MzAwMXJlbGF5ZXIgXHU0RUUzXHU2NTM2XHUzMDBEXHU2QTVGXHU1MjM2XHVGRjBDXHU1NkUwXHU2QjY0XHU3QkExXHU3NDA2XHU1NEUxXHU0RTAwXHU5Mzc1XHU4OERDXHU3NjdDXHU0RTVGXHU4MEZEXHU0RUUzXHU2NTM2XHVGRjA4XHU0RTBEXHU5NzAwXHU4Q0I3XHU2NUI5XG4gKiBcdTc1NzZcdTRFMEJcdTU3MjhcdTdEREFcdTdDM0RcdTU0MERcdUZGMDlcdTMwMDJcdTkwMDFcdTUxRkFcdTUyNERcdTk4MTBcdTZBQTJcdThDQjdcdTY1QjlcdTVDMEQgQURNSU4gXHU3Njg0XHU2Mzg4XHU2QjBBXHU4MjA3IEpDIFx1OTkxOFx1OTg0RFx1RkYwQ1x1NEVGQlx1NEUwMFx1NEUwRFx1OERCM1x1NEUxRlx1NkUwNVx1Njk1QVx1NEUyRFx1NjU4N1xuICogXHU5MzJGXHU4QUE0XHU4MDBDXHU0RTBEXHU5MDAxXHU1MUZBXHU2Q0U4XHU1QjlBIHJldmVydCBcdTc2ODRcdTRFQTRcdTY2MTNcdTMwMDJhbW91bnQ8PTAgXHU1NkRFXHU1MEIzIG51bGxcdUZGMDhcdTcxMjFcdTk3MDBcdThGNDlcdTVFMzNcdUZGMDlcdTMwMDJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNvbGxlY3RKYyhcbiAgZnJvbTogQWRkcmVzcyxcbiAgdG86IEFkZHJlc3MsXG4gIGpjQW1vdW50OiBudW1iZXIsXG4gIG1zZ3M/OiB7IG5vQWxsb3dhbmNlTXNnPzogc3RyaW5nOyBsb3dCYWxhbmNlTXNnPzogc3RyaW5nIH0sXG4gIG9uU3VibWl0dGVkPzogT25BZG1pblRyYW5zYWN0aW9uU3VibWl0dGVkLFxuKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGlmICghKGpjQW1vdW50ID4gMCkpIHJldHVybiBudWxsO1xuICBjb25zdCBkZWNpbWFscyA9IGF3YWl0IHRva2VuRGVjaW1hbHMoXCJqY1Rva2VuXCIpO1xuICByZXR1cm4gdHJhbnNmZXJGcm9tVmlhQWRtaW4oe1xuICAgIHRva2VuOiBSRUxBWUVSX0FERFJFU1NFUy5qY1Rva2VuLFxuICAgIGZyb20sXG4gICAgdG8sXG4gICAgYW1vdW50VW5pdHM6IHBhcnNlVW5pdHMoamNBbW91bnQudG9GaXhlZChkZWNpbWFscyksIGRlY2ltYWxzKSxcbiAgICBub0FsbG93YW5jZU1zZzpcbiAgICAgIG1zZ3M/Lm5vQWxsb3dhbmNlTXNnID8/XG4gICAgICBcIlx1OENCN1x1NjVCOVx1NUMxQVx1NjcyQVx1NjM4OFx1NkIwQVx1NUU3M1x1NTNGMFx1NTJENVx1NzUyOFx1NTE3NiBKQ1x1RkYwOFx1NjIxNlx1NjM4OFx1NkIwQVx1OTg0RFx1NUVBNlx1NEUwRFx1OERCM1x1RkYwOVx1RkYwQ1x1NzEyMVx1NkNENVx1NUI4Q1x1NjIxMFx1OTNDOFx1NEUwQSBKQyBcdTY1MzZcdTRFRDhcdTMwMDJcdThBQ0JcdThDQjdcdTY1QjlcdTU3MjggQXBwIFx1NTE2N1x1OTFDRFx1NjVCMFx1NjRDRFx1NEY1Q1x1NEVFNVx1NUI4Q1x1NjIxMFx1NEUwMFx1NkIyMVx1NjAyNyBKQyBcdTYzODhcdTZCMEFcdTVGOENcdTUxOERcdThBNjZcdTMwMDJcIixcbiAgICBsb3dCYWxhbmNlTXNnOiBtc2dzPy5sb3dCYWxhbmNlTXNnID8/IFwiXHU4Q0I3XHU2NUI5IEpDIFx1OTNDOFx1NEUwQVx1OTkxOFx1OTg0RFx1NEUwRFx1OERCM1x1RkYwQ1x1NzEyMVx1NkNENVx1NUI4Q1x1NjIxMFx1OTNDOFx1NEUwQSBKQyBcdTY1MzZcdTRFRDhcdTMwMDJcIixcbiAgICBvblN1Ym1pdHRlZCxcbiAgfSk7XG59XG5cbi8qKlxuICogXHUzMDBDQURNSU4gXHU2MTkxIGBmcm9tYCBcdTc2ODRcdTRFMDBcdTZCMjFcdTYwMjdcdTYzODhcdTZCMEFcdUZGMENcdTc1MjggdHJhbnNmZXJGcm9tIFx1NjI4QSBgdG9rZW5gIFx1NUY5RSBgZnJvbWAgXHU4RjQ5XHU1MjMwXG4gKiBgdG9gXHUzMDBEXHU3Njg0XHU1MTcxXHU3NTI4XHU1RTk1XHU1QzY0XHUzMDAyXHU2MjQwXHU2NzA5IEFETUlOIFx1NEVFM1x1NEY3Rlx1NzUyOFx1ODAwNVx1NTdGN1x1ODg0Q1x1NzY4NCBFUkMtMjAgdHJhbnNmZXJGcm9tIFx1OTBGRFx1N0Q5M1x1NkI2NFx1OTAwMVx1NTFGQVx1RkYwQ1xuICogXHU3RDcxXHU0RTAwXHU5ODEwXHU2QUEyIGFsbG93YW5jZS9iYWxhbmNlIFx1NEUyNlx1NkNCRlx1NzUyOCBzZW5kQWRtaW5UeCBcdTc2ODQgbm9uY2UgXHU5Mzk2XHUzMDAyYW1vdW50VW5pdHMgXHU3MEJBXHU0RUUzXHU1RTYzXHU2NzAwXHU1QzBGXHU1NUFFXHU0RjREXHUzMDAyXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHRyYW5zZmVyRnJvbVZpYUFkbWluKHBhcmFtczoge1xuICB0b2tlbjogQWRkcmVzcztcbiAgZnJvbTogQWRkcmVzcztcbiAgdG86IEFkZHJlc3M7XG4gIGFtb3VudFVuaXRzOiBiaWdpbnQ7XG4gIG5vQWxsb3dhbmNlTXNnOiBzdHJpbmc7XG4gIGxvd0JhbGFuY2VNc2c6IHN0cmluZztcbiAgb25TdWJtaXR0ZWQ/OiBPbkFkbWluVHJhbnNhY3Rpb25TdWJtaXR0ZWQ7XG59KTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgeyB0b2tlbiwgZnJvbSwgdG8sIGFtb3VudFVuaXRzLCBub0FsbG93YW5jZU1zZywgbG93QmFsYW5jZU1zZywgb25TdWJtaXR0ZWQgfSA9IHBhcmFtcztcbiAgYXdhaXQgZW5zdXJlUmVsYXllckdhcygpO1xuICBjb25zdCBvd25lciA9IGdldEFkZHJlc3MoZnJvbSk7XG4gIGNvbnN0IHNwZW5kZXIgPSByZWxheWVyQWRkcmVzcygpO1xuICBjb25zdCBbYWxsb3dhbmNlLCBiYWxhbmNlXSA9IChhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgcHVibGljQ2xpZW50KCkucmVhZENvbnRyYWN0KHsgYWRkcmVzczogdG9rZW4sIGFiaTogZXJjMjBNaW5pbWFsQWJpLCBmdW5jdGlvbk5hbWU6IFwiYWxsb3dhbmNlXCIsIGFyZ3M6IFtvd25lciwgc3BlbmRlcl0gfSksXG4gICAgcHVibGljQ2xpZW50KCkucmVhZENvbnRyYWN0KHsgYWRkcmVzczogdG9rZW4sIGFiaTogZXJjMjBNaW5pbWFsQWJpLCBmdW5jdGlvbk5hbWU6IFwiYmFsYW5jZU9mXCIsIGFyZ3M6IFtvd25lcl0gfSksXG4gIF0pKSBhcyBbYmlnaW50LCBiaWdpbnRdO1xuICBpZiAoYWxsb3dhbmNlIDwgYW1vdW50VW5pdHMpIHRocm93IG5ldyBFcnJvcihub0FsbG93YW5jZU1zZyk7XG4gIGlmIChiYWxhbmNlIDwgYW1vdW50VW5pdHMpIHRocm93IG5ldyBFcnJvcihsb3dCYWxhbmNlTXNnKTtcbiAgY29uc3QgaGFzaCA9IGF3YWl0IHNlbmRBZG1pblR4KChub25jZSkgPT5cbiAgICBhZG1pbldhbGxldENsaWVudCgpLndyaXRlQ29udHJhY3Qoe1xuICAgICAgYWRkcmVzczogdG9rZW4sXG4gICAgICBhYmk6IGVyYzIwTWluaW1hbEFiaSxcbiAgICAgIGZ1bmN0aW9uTmFtZTogXCJ0cmFuc2ZlckZyb21cIixcbiAgICAgIGFyZ3M6IFtvd25lciwgZ2V0QWRkcmVzcyh0byksIGFtb3VudFVuaXRzXSxcbiAgICAgIGNoYWluOiBSRUxBWUVSX0NIQUlOLFxuICAgICAgbm9uY2UsXG4gICAgfSksXG4gICk7XG4gIGF3YWl0IG9uU3VibWl0dGVkPy4oaGFzaCk7XG4gIHJldHVybiB3YWl0QW5kUmV0dXJuKGhhc2gpO1xufVxuXG4vKipcbiAqIFx1NzY3Q1x1NjUzRSBSV0EgXHU0RUZEXHU5ODREXHU3RDY2XHU2MzA3XHU1QjlBXHU5MzIyXHU1MzA1XHVGRjFBQURNSU4gXHU3MUIxXHU5MzIyXHU1MzA1XHU3NkY0XHU2M0E1XHU3NTI4XHU2QTE5XHU2RTk2IEVSQy0yMCB0cmFuc2ZlciBcdTUyRDVcdTc1MjhcdTgxRUFcdTVERjFcbiAqIFx1NjMwMVx1NjcwOVx1NzY4NFx1OEE3Mlx1NkExOVx1NzY4NFx1NUMwOFx1RkZGRFx1RkZGRFx1NEVFM1x1NUU2M1x1OTkxOFx1OTg0RFx1OEY0OVx1N0Q2Nlx1OENCN1x1NjVCOVx1RkYwQ1x1NEUxNFx1NEUwRFx1N0Q5M1x1OTA0RSBhcHByb3ZlL2FsbG93YW5jZS90cmFuc2ZlckZyb21cdUZGMENcbiAqIFx1NEU1Rlx1NEUwRFx1NTcyOFx1OTNDOFx1NEUwQVx1NTQxMVx1OENCN1x1NjVCOVx1NjUzNiBKQ1x1MzAwMlx1NUVBQlx1NUI1OFx1NzUzMVx1NEVCQVx1NURFNVx1NUY5RSBTYWZlIFx1OTFEMVx1NUVBQlx1RkYwOFx1NUVGQVx1N0FDQlx1NEVFM1x1NUU2M1x1NjY0Mlx1NTE2OFx1OTg0RFx1OTQ0NFx1NTE2NVx1RkYwOVx1OEY0OVx1NEUwMFx1NjI3OVxuICogXHU1MjMwIEFETUlOIFx1NzFCMVx1OTMyMlx1NTMwNVx1ODhEQ1x1OENBOFx1MzAwMmFtb3VudCBcdTcwQkFcdTRFQkFcdTk4NUVcdTUzRUZcdThCODBcdTU1QUVcdTRGNERcdUZGMDhcdTRFRkRcdTY1NzhcdUZGMDlcdTMwMDJcbiAqL1xuYXN5bmMgZnVuY3Rpb24gdHJhbnNmZXJTaGFyZUZyb21Ib3RXYWxsZXQoXG4gIHRva2VuOiBBZGRyZXNzLFxuICB0bzogQWRkcmVzcyxcbiAgYW1vdW50OiBudW1iZXIsXG4gIG9uU3VibWl0dGVkPzogT25BZG1pblRyYW5zYWN0aW9uU3VibWl0dGVkLFxuKSB7XG4gIGF3YWl0IGVuc3VyZVJlbGF5ZXJHYXMoKTtcbiAgY29uc3QgZGVjaW1hbHMgPSBhd2FpdCBzaGFyZVRva2VuRGVjaW1hbHModG9rZW4pO1xuICBjb25zdCBhbW91bnRVbml0cyA9IHBhcnNlVW5pdHMoU3RyaW5nKGFtb3VudCksIGRlY2ltYWxzKTtcbiAgY29uc3QgYmFsYW5jZSA9IChhd2FpdCBwdWJsaWNDbGllbnQoKS5yZWFkQ29udHJhY3Qoe1xuICAgIGFkZHJlc3M6IHRva2VuLFxuICAgIGFiaTogc2hhcmVUb2tlbkFiaSxcbiAgICBmdW5jdGlvbk5hbWU6IFwiYmFsYW5jZU9mXCIsXG4gICAgYXJnczogW3JlbGF5ZXJBZGRyZXNzKCldLFxuICB9KSkgYXMgYmlnaW50O1xuICBpZiAoYmFsYW5jZSA8IGFtb3VudFVuaXRzKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFETUlOIFx1NzFCMVx1OTMyMlx1NTMwNVx1NkI2NCBSV0EgXHU0RUZEXHU5ODREXHVGRjA4XHU0RUUzXHU1RTYzICR7dG9rZW59XHVGRjA5XHU1RUFCXHU1QjU4XHU0RTBEXHU4REIzXHVGRjBDXHU4QUNCXHU3QkExXHU3NDA2XHU1NEUxXHU1MTQ4XHU1RjlFIFNhZmUgXHU5MUQxXHU1RUFCXHU2MjhBXHU0RUZEXHU5ODREXHU4RjQ5XHU1MTY1XHU3MUIxXHU5MzIyXHU1MzA1XHVGRjA4JHtyZWxheWVyQWRkcmVzcygpfVx1RkYwOVx1NUY4Q1x1OTFDRFx1OEE2NmAsXG4gICAgKTtcbiAgfVxuICBjb25zdCBoYXNoID0gYXdhaXQgc2VuZEFkbWluVHgoKG5vbmNlKSA9PlxuICAgIGFkbWluV2FsbGV0Q2xpZW50KCkud3JpdGVDb250cmFjdCh7XG4gICAgICBhZGRyZXNzOiB0b2tlbixcbiAgICAgIGFiaTogc2hhcmVUb2tlbkFiaSxcbiAgICAgIGZ1bmN0aW9uTmFtZTogXCJ0cmFuc2ZlclwiLFxuICAgICAgYXJnczogW2dldEFkZHJlc3ModG8pLCBhbW91bnRVbml0c10sXG4gICAgICBjaGFpbjogUkVMQVlFUl9DSEFJTixcbiAgICAgIG5vbmNlLFxuICAgIH0pLFxuICApO1xuICBhd2FpdCBvblN1Ym1pdHRlZD8uKGhhc2gpO1xuICByZXR1cm4gd2FpdEFuZFJldHVybihoYXNoKTtcbn1cblxuLyoqXG4gKiBSV0EgXHU0RTAwXHU3RDFBXHU4QThEXHU4Q0ZDXHU3RDUwXHU3Qjk3XHVGRjA4MjAyNi0wOS0yMCBcdTY1MzlcdTcwQkFcdTMwMENcdTUzRUFcdTc2N0NcdTRFRkRcdTk4NERcdTMwMERcdUZGMENcdTZCRDRcdTcxNjcgQUVcdUZGMDlcdTMwMDJcbiAqXG4gKiBcdTgwQ0NcdTY2NkZcdUZGMUFSV0EgRmFjdG9yeSBcdTc2ODQgc3Vic2NyaWJlKCkgXHU2NjJGXHUzMDBDXHU1MzlGXHU1QjUwXHU5NkQ5XHU1MkQ1XHU0RjVDXHUzMDBEXHUyMDE0XHUyMDE0XHU5NjY0XHU0RTg2XHU1RjlFIEFETUlOIFx1NzFCMVx1OTMyMlx1NTMwNVxuICogXHU2NEE1XHU0RUZEXHU5ODREXHU3RDY2XHU4Q0I3XHU2NUI5XHVGRjBDXHU5MDg0XHU2NzAzIGBKQy50cmFuc2ZlckZyb20oYnV5ZXIsIFx1MjAyNilgIFx1NTcyOFx1OTNDOFx1NEUwQVx1NTQxMVx1OENCN1x1NjVCOVx1NjUzNiBKQ1x1RkYwQ1x1OTcwMFx1ODk4MVx1OENCN1x1NjVCOVxuICogXHU2NzJDXHU0RUJBXHU0RThCXHU1MTQ4XHU1QzBEIEZhY3RvcnkgXHU3QzNEIGFwcHJvdmVcdTMwMDJcdTkwMTlcdTkwMjBcdTYyMTBcdTdCQTFcdTc0MDZcdTU0RTFcdTRFRTNcdThDQjdcdTY1QjlcdTRFMDBcdTkzNzVcdTg4RENcdTc2N0NcdTY2NDJcdTcxMjFcdTZDRDVcdTRFRTNcdTdDM0QgSkNcbiAqIGFwcHJvdmVcdUZGMDhcdThDQjdcdTY1QjlcdTVDMEQgRmFjdG9yeSBcdTc2ODQgSkMgYWxsb3dhbmNlIFx1NzBCQSAwXHVGRjA5XHVGRjBDXHU5M0M4XHU0RTBBXHU1RkM1XHU3MTM2IHJldmVydFx1RkYwQ1x1NEY0Nlx1N0FEOVx1NTE2N1xuICogamNfbGVkZ2VyIFx1NjVFOVx1NURGMlx1NjI2M1x1OTA0RSBKQ1x1RkYwQ1x1NTE2OVx1OTA4QVx1NEUwRFx1NEUwMFx1ODFGNFx1MzAwMlxuICpcbiAqIFx1NEY5RFx1NEY3Rlx1NzUyOFx1ODAwNVx1NkM3QVx1NUI5QVx1NjUzOVx1NzBCQVx1MzAwQ1x1NTNFQVx1NzY3Q1x1NEVGRFx1OTg0RFx1MzAwRFx1RkYxQVx1N0FEOVx1NTE2N1x1NUUzM1x1NjcyQ1x1NURGMlx1NUI4Q1x1NjIxMCBKQyBcdTYyNjNcdTZCM0VcdTMwMDFcdTkzQzhcdTRFMEEgSkMgXHU5OTE4XHU5ODREXHU0RTVGXHU1REYyXHU0RTBEXHU1QzBEXG4gKiBcdTRGN0ZcdTc1MjhcdTgwMDVcdTk4NkZcdTc5M0FcdUZGMENcdTU2RTBcdTZCNjRcdTkzQzhcdTRFMEFcdTkwMTlcdTRFMDBcdTZCNjVcdTUzRUFcdTk3MDBcdTc1MzEgQURNSU4gXHU3MUIxXHU5MzIyXHU1MzA1IHRyYW5zZmVyIFx1OEE3Mlx1NkExOVx1NzY4NFx1NUMwOFx1NUM2Q1x1NEVFM1x1NUU2M1x1NEVGRFx1OTg0RFxuICogXHU3RDY2XHU4Q0I3XHU2NUI5XHU1MzczXHU1M0VGXHVGRjBDXHU0RTBEXHU1MThEXHU1NDExXHU4Q0I3XHU2NUI5XHU2NTM2IEpDXHUzMDAyXHU5MDE5XHU2QTIzXHU4OERDXHU3NjdDXHU0RTAwXHU1QjlBXHU2MjEwXHU1MjlGXHVGRjBDXHU0RTE0XHU0RTBEXHU1M0Q3XHU4Q0I3XHU2NUI5IEpDIFx1NEY4Nlx1NkU5MFx1ODIwNyBhcHByb3ZlXG4gKiBcdTcyQzBcdTYxNEJcdTVGNzFcdTk3RkZcdTMwMDJwYXltZW50SmMgXHU1MEM1XHU0RkREXHU3NTU5XHU3RDY2XHU1NDdDXHU1M0VCXHU3QUVGXHU3NkY4XHU1QkI5XHVGRjBDXHU5M0M4XHU0RTBBXHU0RTBEXHU1MThEXHU0RjdGXHU3NTI4XHUzMDAyXG4gKlxuICogYGZhY3RvcnlUb2tlbmBcdUZGMDg9IHByaXZhdGVfcGxhY2VtZW50cy50b2tlbl9hZGRyZXNzXHVGRjA5XHU1RkM1XHU5ODA4XHU2NzA5XHU1MDNDXHVGRjFBXHU1MzczXHU4QTcyXHU2QTE5XHU3Njg0XHU5ODA4XHU1MTQ4XHU1NzI4XG4gKiBSV0EgRmFjdG9yeSBcdTVFRkFcdTdBQ0JcdTkwNEVcdTVDMDhcdTVDNkNcdTRFRTNcdTVFNjNcdTMwMDFcdTRFMjZcdTYyOEFcdTRFRkRcdTk4NERcdTVGOUUgU2FmZSBcdTkxRDFcdTVFQUJcdThGNDlcdTUxNjUgQURNSU4gXHU3MUIxXHU5MzIyXHU1MzA1XHUzMDAyXHU1QzFBXHU2NzJBXHU1RUZBXHU3QUNCXG4gKiBcdTRFRTNcdTVFNjNcdTc2ODRcdTZBMTlcdTc2ODRcdTcxMjFcdTRFRkRcdTk4NERcdTUzRUZcdTc2N0NcdUZGMENcdTc2RjRcdTYzQTVcdTRFMUZcdTUxRkFcdTZFMDVcdTY5NUFcdTkzMkZcdThBQTRcdUZGMENcdTgwMENcdTk3NUVcdTU0N0NcdTUzRUJcdTVERjJcdTUwNUNcdTc1MjhcdTc2ODRcdTgyMEEgcndhUHJpbWFyeVNhbGVcdTMwMDJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVTdWJzY3JpcHRpb24oXG4gIGJ1eWVyOiBBZGRyZXNzLFxuICByd2FVbml0czogbnVtYmVyLFxuICBfcGF5bWVudEpjPzogbnVtYmVyLFxuICBmYWN0b3J5VG9rZW4/OiBBZGRyZXNzLFxuICBvblN1Ym1pdHRlZD86IE9uQWRtaW5UcmFuc2FjdGlvblN1Ym1pdHRlZCxcbikge1xuICBpZiAoIWZhY3RvcnlUb2tlbikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiXHU2QjY0IFJXQSBcdTZBMTlcdTc2ODRcdTVDMUFcdTY3MkFcdTU3MjggUldBIEZhY3RvcnkgXHU1RUZBXHU3QUNCXHU1QzA4XHU1QzZDXHU0RUUzXHU1RTYzXHVGRjBDXHU3MTIxXHU2Q0Q1XHU5M0M4XHU0RTBBXHU3NjdDXHU2NTNFXHU0RUZEXHU5ODREXHUzMDAyXHU4QUNCXHU1MTQ4XHU1NzI4XHU1RjhDXHU1M0YwXHU2QTE5XHU3Njg0XHU3REU4XHU4RjJGXHU1NjY4XHUzMDBDXHU0RTAwXHU5Mzc1XHU1RUZBXHU3QUNCIFJXQSBcdTRFRTNcdTVFNjNcdTMwMERcdTRFMjZcdTU2REVcdTU4NkJcdTRFRTNcdTVFNjNcdTU3MzBcdTU3NDBcdUZGMENcdTUxOERcdTYyOEFcdTRFRkRcdTk4NERcdTVGOUUgU2FmZSBcdTkxRDFcdTVFQUJcdThGNDlcdTUxNjUgQURNSU4gXHU3MUIxXHU5MzIyXHU1MzA1XHU1RjhDXHU5MUNEXHU4QTY2XHUzMDAyXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gdHJhbnNmZXJTaGFyZUZyb21Ib3RXYWxsZXQoZmFjdG9yeVRva2VuLCBidXllciwgcndhVW5pdHMsIG9uU3VibWl0dGVkKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZpbmRSZWNlbnRBc3NldFRyYW5zZmVyKFxuICB0b2tlbjogQWRkcmVzcyxcbiAgYnV5ZXI6IEFkZHJlc3MsXG4gIGFtb3VudDogbnVtYmVyLFxuICBhZnRlckhhc2g6IGAweCR7c3RyaW5nfWAsXG4gIGlzU2hhcmVUb2tlbjogYm9vbGVhbixcbik6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBjb25zdCByZWZlcmVuY2UgPSBhd2FpdCBwdWJsaWNDbGllbnQoKS5nZXRUcmFuc2FjdGlvblJlY2VpcHQoeyBoYXNoOiBhZnRlckhhc2ggfSk7XG4gIGNvbnN0IGRlY2ltYWxzID0gaXNTaGFyZVRva2VuID8gYXdhaXQgc2hhcmVUb2tlbkRlY2ltYWxzKHRva2VuKSA6IGF3YWl0IHRva2VuRGVjaW1hbHMoXCJhZVRva2VuXCIpO1xuICBjb25zdCBhbW91bnRVbml0cyA9IHBhcnNlVW5pdHMoU3RyaW5nKGFtb3VudCksIGRlY2ltYWxzKTtcbiAgY29uc3QgbG9ncyA9IGF3YWl0IHB1YmxpY0NsaWVudCgpLmdldExvZ3Moe1xuICAgIGFkZHJlc3M6IHRva2VuLFxuICAgIGV2ZW50OiBlcmMyMFRyYW5zZmVyRXZlbnQsXG4gICAgYXJnczogeyBmcm9tOiByZWxheWVyQWRkcmVzcygpLCB0bzogZ2V0QWRkcmVzcyhidXllcikgfSxcbiAgICBmcm9tQmxvY2s6IHJlZmVyZW5jZS5ibG9ja051bWJlcixcbiAgICB0b0Jsb2NrOiBcImxhdGVzdFwiLFxuICB9KTtcbiAgY29uc3QgbWF0Y2hlcyA9IGxvZ3MuZmlsdGVyKChsb2cpID0+IHtcbiAgICBpZiAobG9nLmFyZ3MudmFsdWUgIT09IGFtb3VudFVuaXRzIHx8IGxvZy5ibG9ja051bWJlciA9PSBudWxsKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGxvZy5ibG9ja051bWJlciA+IHJlZmVyZW5jZS5ibG9ja051bWJlcikgcmV0dXJuIHRydWU7XG4gICAgcmV0dXJuIGxvZy50cmFuc2FjdGlvbkluZGV4ICE9IG51bGwgJiYgbG9nLnRyYW5zYWN0aW9uSW5kZXggPiByZWZlcmVuY2UudHJhbnNhY3Rpb25JbmRleDtcbiAgfSk7XG4gIGlmIChtYXRjaGVzLmxlbmd0aCA+IDEpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJcdTYyN0VcdTUyMzBcdTU5MUFcdTdCNDZcdTdCMjZcdTU0MDhcdTc2ODRcdTgyMEFcdTcyNDhcdTZBMTlcdTc2ODRcdThGNDlcdTVFMzNcdUZGRkRcdUZGRkRcdTcwQkFcdTkwN0ZcdTUxNERcdTkxQ0RcdTg5MDdcdTc2N0NcdTY1M0VcdUZGMENcdTdDRkJcdTdENzFcdTY2QUJcdTUwNUNcdTgxRUFcdTUyRDVcdTkxQ0RcdTkwMDFcdTRFMjZcdTRGRERcdTc1NTlcdTVGODVcdTc4QkFcdThBOERcdTdEMDBcdTkzMDRcIik7XG4gIH1cbiAgcmV0dXJuIG1hdGNoZXNbMF0/LnRyYW5zYWN0aW9uSGFzaCA/PyBudWxsO1xufVxuXG4vKipcbiAqIEFFIFx1NEUwMFx1N0QxQVx1OEE4RFx1OENGQ1x1N0Q1MFx1N0I5N1x1RkYwODIwMjYtMDktMjAgXHU2NTM5XHU3MEJBXHUzMDBDXHU1M0VBXHU3NjdDIEFFXHUzMDBEXHVGRjA5XHUzMDAyXG4gKlxuICogXHU4MENDXHU2NjZGXHVGRjFBYGFlUHJpbWFyeVNhbGVgIFx1NTQwOFx1N0QwNFx1NzY4NCBleGVjdXRlU3Vic2NyaXB0aW9uKCkgXHU2NzAzXHUzMDBDXHU1NDBDXHU2NjQyXHUzMDBEXHU1NzI4XHU5M0M4XHU0RTBBXHU1NDExXHU4Q0I3XHU2NUI5XG4gKiBcdTY1MzYgSkNcdUZGMDhgSkMudHJhbnNmZXJGcm9tKGJ1eWVyLCBcdTIwMjYpYFx1RkYwQ1x1OTcwMFx1OENCN1x1NjVCOVx1NjcyQ1x1NEVCQVx1NEU4Qlx1NTE0OFx1N0MzRFx1N0Y3MiBhcHByb3ZlXHVGRjA5XHVGRjBCXHU1RjlFIG93bmVyXG4gKiAoQURNSU4pIFx1NjRBNSBBRSBcdTdENjZcdThDQjdcdTY1QjlcdTMwMDJcdTkwMTlcdTkwMjBcdTYyMTBcdTUxNjlcdTUwMEJcdTU1NEZcdTk4NENcdUZGMUEoMSkgXHU3QkExXHU3NDA2XHU1NEUxXHU0RUUzXHU4Q0I3XHU2NUI5XHU4OERDXHU3NjdDXHU2NjQyXHU3MTIxXHU2Q0Q1XHU0RUUzXHU3QzNEIEpDXG4gKiBhcHByb3ZlXHVGRjFCKDIpIFx1NjNEQlx1OTA0RVx1NTQwOFx1N0QwNFx1NEY0RFx1NTc0MFx1NUY4Q1x1OENCN1x1NjVCOVx1NUMwRFx1NjVCMFx1NTQwOFx1N0QwNFx1NzY4NCBKQyBhbGxvd2FuY2UgXHU3MEJBIDBcdUZGMENcdTVDMEVcdTgxRjRcdTkzQzhcdTRFMEFcdTVGQzVcdTcxMzZcbiAqIHJldmVydFx1RkYwQ1x1NEY0Nlx1N0FEOVx1NTE2NyBqY19sZWRnZXIgXHU2NUU5XHU1REYyXHU2MjYzXHU5MDRFIEpDXHUzMDAyXG4gKlxuICogXHU0RjlEXHU0RjdGXHU3NTI4XHU4MDA1XHU2QzdBXHU1QjlBXHVGRjFBXHU3QUQ5XHU1MTY3XHU1RTMzXHU2NzJDXHU1REYyXHU1QjhDXHU2MjEwIEpDIFx1NjI2M1x1NkIzRVx1RkYwQ1x1OTNDOFx1NEUwQSBKQyBcdTk5MThcdTk4NERcdTRFNUZcdTVERjJcdTRFMERcdTVDMERcdTRGN0ZcdTc1MjhcdTgwMDVcdTk4NkZcdTc5M0FcdUZGMENcdTU2RTBcdTZCNjRcbiAqIFx1OTNDOFx1NEUwQVx1OTAxOVx1NEUwMFx1NkI2NVx1MzAwQ1x1NTNFQVx1NzY3QyBBRVx1MzAwRFx1NTM3M1x1NTNFRlx1MjAxNFx1MjAxNFx1NzZGNFx1NjNBNVx1NzUzMSBBRE1JTiBcdTcxQjFcdTkzMjJcdTUzMDUgdHJhbnNmZXIgQUUgXHU3RDY2XHU4Q0I3XHU2NUI5XHVGRjBDXHU0RTBEXHU1MThEXHU1NDExXG4gKiBcdThDQjdcdTY1QjlcdTY1MzYgSkNcdTMwMDJcdTkwMTlcdTZBMjNcdTg4RENcdTc2N0NcdTRFMDBcdTVCOUFcdTYyMTBcdTUyOUZcdUZGMENcdTRFMTRcdTRFMERcdTUzRDdcdThDQjdcdTY1QjkgSkMgXHU0Rjg2XHU2RTkwXHVGRjA4XHU5MUQxXHU1RUFCL1x1NEU4Q1x1N0QxQS9cdTUyMDZcdTZGNjRcdUZGMDlcdTgyMDcgYXBwcm92ZVxuICogXHU3MkMwXHU2MTRCXHU1RjcxXHU5N0ZGXHUzMDAycGF5bWVudEpjIFx1NTBDNVx1NEZERFx1NzU1OVx1N0Q2Nlx1NTQ3Q1x1NTNFQlx1N0FFRlx1NzZGOFx1NUJCOVx1RkYwQ1x1OTNDOFx1NEUwQVx1NEUwRFx1NTE4RFx1NEY3Rlx1NzUyOFx1MzAwMlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZUFlU3Vic2NyaXB0aW9uKFxuICBidXllcjogQWRkcmVzcyxcbiAgYWVVbml0czogbnVtYmVyLFxuICBvblN1Ym1pdHRlZD86IE9uQWRtaW5UcmFuc2FjdGlvblN1Ym1pdHRlZCxcbikge1xuICByZXR1cm4gdHJhbnNmZXJGcm9tSG90V2FsbGV0KFwiYWVUb2tlblwiLCBidXllciwgYWVVbml0cywgb25TdWJtaXR0ZWQpO1xufVxuXG4vKiogd2lyZVJ3YUNvbnRyYWN0cyBcdTc2ODRcdTU2REVcdTUwQjNcdTU3OEJcdTUyMjVcdUZGMUFcdTZCQ0ZcdTUwMEJcdTVCNTBcdTU0MDhcdTdEMDRcdTU0MDRcdTgxRUFcdTU2REVcdTU4MzFcdTcyQzBcdTYxNEJcdUZGMENcdTRFRkJcdTRFMDBcdTk4MDVcdTU5MzFcdTY1NTdcdTkwRkRcdTRFMERcdTVGNzFcdTk3RkZcdTUzRTZcdTRFMDBcdTk4MDVcdTMwMDIgKi9cbmV4cG9ydCB0eXBlIFdpcmVSZXN1bHQgPSB7XG4gIHN1YnNjcmlwdGlvbjogc3RyaW5nOyAvLyB0eCBoYXNoIHwgXCJhbHJlYWR5LXNldFwiXG4gIG1hcmtldDogc3RyaW5nOyAvLyB0eCBoYXNoIHwgXCJhbHJlYWR5LXNldFwiIHwgXCJmYWlsZWRcIlxuICBtYXJrZXRFcnJvcj86IHN0cmluZzsgLy8gbWFya2V0IFx1OEEyRFx1NUI5QVx1NTkzMVx1NjU1N1x1NjY0Mlx1NzY4NFx1NEVCQVx1OTg1RVx1NTNFRlx1OEI4MFx1NTM5Rlx1NTZFMFxufTtcblxuLyoqIFx1OEI4MFx1NTNENlx1NkJDRFx1NTQwOFx1N0QwNFx1NEUwQVx1NjdEMFx1NTAwQiBhZGRyZXNzIGdldHRlclx1RkYxQlx1ODJFNVx1OEE3MiBnZXR0ZXIgXHU1NzI4XHU5M0M4XHU0RTBBIHJldmVydFx1RkYwOFx1ODIwQVx1NzI0OFx1NURFNVx1NUVFMFx1NTQwOFx1N0QwNFx1NzY4NFxuICogbWFya2V0Q29udHJhY3QoKSBcdTVDMzFcdTY3MDMgcmV2ZXJ0XHVGRjA5XHVGRjBDXHU1NkRFXHU1MEIzIG51bGwgXHU3NTc2XHU0RjVDXHUzMDBDXHU2NzJBXHU3N0U1XHVGRjBGXHU2NzJBXHU4QTJEXHU1QjlBXHUzMDBEXHVGRjBDXHU3RDU1XHU0RTBEXHU4QjkzXHU0RTAwXHU1MDBCXHU1OERFXHU2Mzg5XHU3Njg0XG4gKiBnZXR0ZXIgXHU0RTJEXHU2NUI3XHU2NTc0XHU1MDBCXHU1MjFEXHU1OUNCXHU1MzE2XHU2RDQxXHU3QTBCXHUzMDAyICovXG5hc3luYyBmdW5jdGlvbiByZWFkQWRkcmVzc0dldHRlcihmdW5jdGlvbk5hbWU6IFwibWFya2V0Q29udHJhY3RcIiB8IFwic3Vic2NyaXB0aW9uQ29udHJhY3RcIik6IFByb21pc2U8QWRkcmVzcyB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCB2YWx1ZSA9IGF3YWl0IHB1YmxpY0NsaWVudCgpLnJlYWRDb250cmFjdCh7XG4gICAgICBhZGRyZXNzOiBSRUxBWUVSX0FERFJFU1NFUy5yd2FNYXN0ZXIsXG4gICAgICBhYmk6IHJ3YUFiaSxcbiAgICAgIGZ1bmN0aW9uTmFtZSxcbiAgICB9KTtcbiAgICByZXR1cm4gZ2V0QWRkcmVzcyh2YWx1ZSBhcyBBZGRyZXNzKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLyoqXG4gKiBcdTRFMDBcdTZCMjFcdTYwMjdcdTYyOEFcdTVCNTBcdTU0MDhcdTdEMDRcdTRGNERcdTU3NDBcdTVCRUJcdTkwMzIgUldBIFx1OTQ0NFx1OTAyMFx1NURFNVx1NUVFMFx1NTQwOFx1N0QwNFx1RkYwQ1x1OEI5M1x1NEUwMFx1N0QxQVx1OEE4RFx1OENGQyAvIFx1NEU4Q1x1N0QxQVx1NUUwMlx1NTgzNFx1NTQwOFx1N0QwNFx1NjcwOVx1NkIwQVx1NzlGQlx1NTJENSBSV0FcdTMwMDJcbiAqXG4gKiBcdTkxQ0RcdTg5ODFcdUZGMUFcdTVCRTZcdTZFMkNcdTc2RUVcdTUyNERcdTkwRThcdTdGNzJcdTc2ODRcdTkwMTlcdTk4NDZcdTk0NDRcdTkwMjBcdTVERTVcdTVFRTBcdTU0MDhcdTdEMDRcdUZGMENgc2V0TWFya2V0Q29udHJhY3QoLi4uKWAgXHU1QzBEXHUzMDBDXHU0RUZCXHU0RjU1XHUzMDBEXHU1M0MzXHU2NTc4XG4gKiBcdUZGMDhcdTU0MkIgYWRkcmVzcygwKVx1MzAwMVx1NEU4Q1x1N0QxQVx1NUUwMlx1NTgzNFx1NEY0RFx1NTc0MFx1MzAwMVx1NzUxQVx1ODFGM1x1NURFNVx1NUVFMFx1ODFFQVx1NURGMVx1RkYwOVx1OTBGRFx1NjcwM1x1NzEyMVx1Njg5RFx1NEVGNiByZXZlcnRcdUZGMENcdTRFMTRcbiAqIGBtYXJrZXRDb250cmFjdCgpYCBnZXR0ZXIgXHU0RTVGIHJldmVydFx1MjAxNFx1MjAxNFx1OTAxOVx1NjYyRlx1OEE3Mlx1NTQwOFx1N0QwNCBieXRlY29kZSBcdTUxNjdcdTc2ODRcdTY1RTJcdTY3MDlcdTdGM0FcdTk2NzdcdUZGMENcdTVGOENcdTdBRUZcbiAqIFx1NzEyMVx1NkNENVx1NzUyOFx1N0EwQlx1NUYwRlx1NEZFRVx1NkI2M1x1RkYwOFx1NTNFQVx1ODBGRFx1OTFDRFx1NjVCMFx1OTBFOFx1N0Y3Mlx1NEUwMFx1OTg0Nlx1NTNFRlx1NkI2M1x1NUUzOFx1OEEyRFx1NUI5QVx1NEU4Q1x1N0QxQVx1NUUwMlx1NTgzNFx1NzY4NFx1NURFNVx1NUVFMFx1NTQwOFx1N0QwNFx1RkYwOVx1MzAwMlx1NzZGOFx1NUMwRFx1NTczMFxuICogYHNldFN1YnNjcmlwdGlvbkNvbnRyYWN0KC4uLilgIFx1NkI2M1x1NUUzOFx1NTNFRlx1NzUyOFx1MzAwMlx1NTZFMFx1NkI2NFx1OTAxOVx1ODhFMVx1NjUzOVx1NjIxMFx1RkYxQVxuICogICAxLiBcdTU0MDRcdTk4MDVcdTczNjhcdTdBQ0JcdTg2NTVcdTc0MDZcdUZGMENcdTRFMDBcdTdEMUFcdThBOERcdThDRkNcdTUxNDhcdThBMkRcdTVCOUFcdTU5N0RcdUZGMDhcdThCOTNcdTRFMDBcdTdEMUFcdThBOERcdThDRkNcdTZENDFcdTdBMEJcdTUzRUZcdTkwNEJcdTRGNUNcdUZGMDlcdUZGMUJcbiAqICAgMi4gXHU0RThDXHU3RDFBXHU1RTAyXHU1ODM0XHU4QTJEXHU1QjlBXHU1MjREXHU1MTQ4XHU3NTI4IGV0aF9jYWxsIFx1NkEyMVx1NjRFQ1x1RkYwQ1x1NkEyMVx1NjRFQ1x1NUMzMSByZXZlcnQgXHU2NjQyXHUzMDBDXHU0RTBEXHU5MDAxXHU1MUZBXHUzMDBEXHU0RUE0XHU2NjEzXHVGRjA4XHU3NzAxXHU0RTBCXG4gKiAgICAgIFx1NkNFOFx1NUI5QVx1NTkzMVx1NjU1N1x1NzY4NCBnYXNcdTMwMDFcdTRFNUZcdTRFMERcdTY3MDNcdTU3MjhcdTkzQzhcdTRFMEFcdTc1NTlcdTRFMEJcdTRFMDBcdTdCNDZcdTRFRTRcdTRFQkFcdTU2RjBcdTYwRDFcdTc2ODRcdTU5MzFcdTY1NTdcdTRFQTRcdTY2MTNcdUZGMDlcdUZGMENcdTY1MzlcdTU2REVcdTU4MzFcdTZFMDVcdTY5NUFcdTUzOUZcdTU2RTBcdUZGMUJcbiAqICAgMy4gXHU1NkRFXHU1MEIzXHU2QkNGXHU5ODA1XHU3MkMwXHU2MTRCXHVGRjBDXHU4QjkzXHU1MjREXHU3QUVGXHU5ODZGXHU3OTNBXHUzMDBDXHU0RTAwXHU3RDFBXHU1REYyXHU4QTJEXHU1QjlBXHUzMDAxXHU0RThDXHU3RDFBXHU1NkUwXHU1NDA4XHU3RDA0XHU3RjNBXHU5Njc3XHU1OTMxXHU2NTU3XHUzMDBEXHU3Njg0XHU5MEU4XHU1MjA2XHU2MjEwXHU1MjlGXHU3RDUwXHU2NzlDXHVGRjBDXG4gKiAgICAgIFx1ODAwQ1x1NEUwRFx1NjYyRlx1NjU3NFx1OTg0Nlx1NjMwOVx1OTIxNVx1NEUxRlx1NEUwMFx1NTAwQlx1NzcwQlx1NEUwRFx1NjFDMlx1NzY4NCBcIm1hcmtldENvbnRyYWN0IHJldmVydGVkXCJcdTMwMDJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdpcmVSd2FDb250cmFjdHMoKTogUHJvbWlzZTxXaXJlUmVzdWx0PiB7XG4gIGF3YWl0IGVuc3VyZVJlbGF5ZXJHYXMoKTtcbiAgY29uc3QgcmVzdWx0czogV2lyZVJlc3VsdCA9IHsgc3Vic2NyaXB0aW9uOiBcInVua25vd25cIiwgbWFya2V0OiBcInVua25vd25cIiB9O1xuXG4gIC8vIC0tLS0gXHU0RTAwXHU3RDFBXHU4QThEXHU4Q0ZDXHU1NDA4XHU3RDA0XHVGRjA4XHU2QjYzXHU1RTM4XHU1M0VGXHU4QTJEXHU1QjlBXHVGRjA5LS0tLVxuICBjb25zdCBjdXJyZW50U3ViID0gYXdhaXQgcmVhZEFkZHJlc3NHZXR0ZXIoXCJzdWJzY3JpcHRpb25Db250cmFjdFwiKTtcbiAgaWYgKGN1cnJlbnRTdWIgJiYgY3VycmVudFN1YiA9PT0gUkVMQVlFUl9BRERSRVNTRVMucndhUHJpbWFyeVNhbGUpIHtcbiAgICByZXN1bHRzLnN1YnNjcmlwdGlvbiA9IFwiYWxyZWFkeS1zZXRcIjtcbiAgfSBlbHNlIHtcbiAgICBjb25zdCBoYXNoID0gYXdhaXQgc2VuZEFkbWluVHgoKG5vbmNlKSA9PlxuICAgICAgYWRtaW5XYWxsZXRDbGllbnQoKS53cml0ZUNvbnRyYWN0KHtcbiAgICAgICAgYWRkcmVzczogUkVMQVlFUl9BRERSRVNTRVMucndhTWFzdGVyLFxuICAgICAgICBhYmk6IHJ3YUFiaSxcbiAgICAgICAgZnVuY3Rpb25OYW1lOiBcInNldFN1YnNjcmlwdGlvbkNvbnRyYWN0XCIsXG4gICAgICAgIGFyZ3M6IFtSRUxBWUVSX0FERFJFU1NFUy5yd2FQcmltYXJ5U2FsZV0sXG4gICAgICAgIGNoYWluOiBSRUxBWUVSX0NIQUlOLFxuICAgICAgICBub25jZSxcbiAgICAgIH0pLFxuICAgICk7XG4gICAgcmVzdWx0cy5zdWJzY3JpcHRpb24gPSBhd2FpdCB3YWl0QW5kUmV0dXJuKGhhc2gpO1xuICB9XG5cbiAgLy8gLS0tLSBcdTRFOENcdTdEMUFcdTVFMDJcdTU4MzRcdTU0MDhcdTdEMDQgLS0tLVxuICBjb25zdCBjdXJyZW50TWFya2V0ID0gYXdhaXQgcmVhZEFkZHJlc3NHZXR0ZXIoXCJtYXJrZXRDb250cmFjdFwiKTtcbiAgaWYgKGN1cnJlbnRNYXJrZXQgJiYgY3VycmVudE1hcmtldCA9PT0gUkVMQVlFUl9BRERSRVNTRVMucndhU2Vjb25kYXJ5TWFya2V0KSB7XG4gICAgcmVzdWx0cy5tYXJrZXQgPSBcImFscmVhZHktc2V0XCI7XG4gICAgcmV0dXJuIHJlc3VsdHM7XG4gIH1cbiAgdHJ5IHtcbiAgICAvLyBcdTkwMDFcdTUxRkFcdTUyNERcdTUxNDhcdTZBMjFcdTY0RUNcdUZGMUJcdTZBMjFcdTY0RUMgcmV2ZXJ0IFx1NEVFM1x1ODg2OFx1OTAxOVx1N0I0Nlx1NEVBNFx1NjYxM1x1NEUwQVx1OTNDOFx1NEU1Rlx1NUZDNVx1NzEzNiByZXZlcnRcdUZGMENcdTc2RjRcdTYzQTVcdTRFMERcdTkwMDFcdTUxRkFcdTMwMDJcbiAgICBhd2FpdCBwdWJsaWNDbGllbnQoKS5zaW11bGF0ZUNvbnRyYWN0KHtcbiAgICAgIGFjY291bnQ6IHJlbGF5ZXJBZGRyZXNzKCksXG4gICAgICBhZGRyZXNzOiBSRUxBWUVSX0FERFJFU1NFUy5yd2FNYXN0ZXIsXG4gICAgICBhYmk6IHJ3YUFiaSxcbiAgICAgIGZ1bmN0aW9uTmFtZTogXCJzZXRNYXJrZXRDb250cmFjdFwiLFxuICAgICAgYXJnczogW1JFTEFZRVJfQUREUkVTU0VTLnJ3YVNlY29uZGFyeU1hcmtldF0sXG4gICAgfSk7XG4gICAgY29uc3QgaGFzaCA9IGF3YWl0IHNlbmRBZG1pblR4KChub25jZSkgPT5cbiAgICAgIGFkbWluV2FsbGV0Q2xpZW50KCkud3JpdGVDb250cmFjdCh7XG4gICAgICAgIGFkZHJlc3M6IFJFTEFZRVJfQUREUkVTU0VTLnJ3YU1hc3RlcixcbiAgICAgICAgYWJpOiByd2FBYmksXG4gICAgICAgIGZ1bmN0aW9uTmFtZTogXCJzZXRNYXJrZXRDb250cmFjdFwiLFxuICAgICAgICBhcmdzOiBbUkVMQVlFUl9BRERSRVNTRVMucndhU2Vjb25kYXJ5TWFya2V0XSxcbiAgICAgICAgY2hhaW46IFJFTEFZRVJfQ0hBSU4sXG4gICAgICAgIG5vbmNlLFxuICAgICAgfSksXG4gICAgKTtcbiAgICByZXN1bHRzLm1hcmtldCA9IGF3YWl0IHdhaXRBbmRSZXR1cm4oaGFzaCk7XG4gIH0gY2F0Y2gge1xuICAgIHJlc3VsdHMubWFya2V0ID0gXCJmYWlsZWRcIjtcbiAgICByZXN1bHRzLm1hcmtldEVycm9yID1cbiAgICAgIFwiXHU1REYyXHU5MEU4XHU3RjcyXHU3Njg0IFJXQSBcdTk0NDRcdTkwMjBcdTVERTVcdTVFRTBcdTU0MDhcdTdEMDQgc2V0TWFya2V0Q29udHJhY3QoKSBcdTU3MjhcdTkzQzhcdTRFMEFcdTg4QUJcdTcxMjFcdTY4OURcdTRFRjZcdTYyRDJcdTdENTVcdUZGMDhcdTVDMERcdTRFRkJcdTRGNTVcdTRGNERcdTU3NDBcdTkwRkQgcmV2ZXJ0XHVGRjBDbWFya2V0Q29udHJhY3QoKSBnZXR0ZXIgXHU0RTVGIHJldmVydFx1RkYwOVx1RkYwQ1x1NzgxNFx1NTIyNFx1NzBCQVx1OEE3Mlx1NTQwOFx1N0QwNFx1NjcyQ1x1OEVBQlx1NzY4NFx1N0YzQVx1OTY3N1x1RkYwQ1x1OTcwMFx1OTFDRFx1NjVCMFx1OTBFOFx1N0Y3Mlx1NEUwMFx1OTg0Nlx1ODBGRFx1NkI2M1x1NUUzOFx1OEEyRFx1NUI5QVx1NEU4Q1x1N0QxQVx1NUUwMlx1NTgzNFx1NzY4NFx1OTQ0NFx1OTAyMFx1NURFNVx1NUVFMFx1NTQwOFx1N0QwNFx1NjI0RFx1ODBGRFx1NEZFRVx1NUZBOVx1MjAxNFx1MjAxNFx1NkI2NFx1NTU0Rlx1OTg0Q1x1NzEyMVx1NkNENVx1NzUzMVx1NUY4Q1x1N0FFRlx1N0EwQlx1NUYwRlx1NEZFRVx1NkI2M1x1MzAwMlJXQSBcdTRFMDBcdTdEMUFcdThBOERcdThDRkNcdTVERjJcdThBMkRcdTVCOUFcdTVCOENcdTYyMTBcdUZGMENcdTRFMERcdTUzRDdcdTVGNzFcdTk3RkZcdTMwMDJcIjtcbiAgfVxuICByZXR1cm4gcmVzdWx0cztcbn1cblxuLy8gXHU3MUIxXHU5MzIyXHU1MzA1XHU1RUFCXHU1QjU4XHU0RjRFXHU2NUJDXHU2QjY0XHU1MDNDXHU4OTk2XHU3MEJBXHUzMDBDXHU4QTcyXHU4OERDXHU4Q0E4XHU0RTg2XHUzMDBEXHVGRjBDXHU0RjlCIEFkbWluUGFnZSBcdTk4NkZcdTc5M0FcdTYzRDBcdTkxOTJcdUZGMDhcdTUwQzVcdTRGOUJcdTk4NkZcdTc5M0FcdTc1MjhcdTc2ODRcbi8vIFx1OTU4MFx1NkFCQlx1RkYwQ1x1NEUwRFx1NUY3MVx1OTdGRlx1NUJFNlx1OTY5Qlx1ODBGRFx1NTQyNlx1OEY0OVx1NUUzM1x1MjAxNFx1MjAxNFx1NUJFNlx1OTY5Qlx1NkFBMlx1NjdFNVx1NEUwMFx1NUY4Qlx1NzcwQlx1NzU3Nlx1NEUwQiBiYWxhbmNlT2YgXHU2NjJGXHU1NDI2XHU1OTIwXHU5MDE5XHU0RTAwXHU3QjQ2XHVGRjA5XHUzMDAyXG5jb25zdCBMT1dfSE9UX1dBTExFVF9CQUxBTkNFX1VOSVRTID0gMTAwO1xuXG4vKipcbiAqIFx1NTUyRlx1OEI4MFx1OEEzQVx1NjVCN1x1RkYxQVx1NTZERVx1NTgzMSBBRE1JTiBcdTcxQjFcdTkzMjJcdTUzMDVcdTc2RUVcdTUyNERcdTYzMDFcdTY3MDlcdTc2ODQgSkMvQUUgXHU1RUFCXHU1QjU4XHVGRjBDXHU0RjlCIEFkbWluUGFnZSBcdTk4NkZcdTc5M0FcdTMwMENcdTY2MkZcdTU0MjZcbiAqIFx1OTcwMFx1ODk4MVx1NEVCQVx1NURFNVx1NUY5RSBTYWZlIFx1OTFEMVx1NUVBQlx1OEY0OVx1NUUzM1x1ODhEQ1x1OENBOFx1MzAwRFx1MzAwMlx1N0QxNFx1OEI4MFx1NTNENlx1RkYwQ1x1NEUwRFx1NTA1QVx1NEVGQlx1NEY1NVx1OTNDOFx1NEUwQVx1NUJFQlx1NTE2NVx1MzAwMlxuICovXG4vLyBcdThCODAgQURNSU4gXHU3MUIxXHU5MzIyXHU1MzA1XHU1NzI4XHU2N0QwXHU5ODQ2IFJXQSBcdTVDMDhcdTVDNkNcdTRFRkRcdTk4NERcdTRFRTNcdTVFNjNcdTc2ODRcdTkzQzhcdTRFMEFcdTk5MThcdTk4NERcdUZGMDhcdTU1MkZcdThCODBcdThBM0FcdTY1QjdcdTc1MjhcdUZGMDlcdTMwMDJcbi8vIFx1NTczMFx1NTc0MFx1NjYyRlx1NTJENVx1NjE0Qlx1NzY4NFx1RkYwOFx1NUI1OFx1NjVCQyBwcml2YXRlX3BsYWNlbWVudHMudG9rZW5fYWRkcmVzc1x1RkYwOVx1RkYwQ1x1NjU0NVx1NEUwRFx1OEQ3MCBSRUxBWUVSX0FERFJFU1NFU1x1MzAwMlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldEhvdFdhbGxldFNoYXJlQmFsYW5jZSh0b2tlbkFkZHJlc3M6IHN0cmluZyk6IFByb21pc2U8e1xuICB0b2tlbkFkZHJlc3M6IEFkZHJlc3M7XG4gIGRlY2ltYWxzOiBudW1iZXI7XG4gIGJhbGFuY2VGb3JtYXR0ZWQ6IHN0cmluZztcbn0+IHtcbiAgY29uc3QgdG9rZW4gPSBnZXRBZGRyZXNzKHRva2VuQWRkcmVzcy50cmltKCkpO1xuICBjb25zdCBkZWNpbWFscyA9IGF3YWl0IHNoYXJlVG9rZW5EZWNpbWFscyh0b2tlbik7XG4gIGNvbnN0IGJhbGFuY2UgPSAoYXdhaXQgcHVibGljQ2xpZW50KCkucmVhZENvbnRyYWN0KHtcbiAgICBhZGRyZXNzOiB0b2tlbixcbiAgICBhYmk6IHNoYXJlVG9rZW5BYmksXG4gICAgZnVuY3Rpb25OYW1lOiBcImJhbGFuY2VPZlwiLFxuICAgIGFyZ3M6IFtyZWxheWVyQWRkcmVzcygpXSxcbiAgfSkpIGFzIGJpZ2ludDtcbiAgcmV0dXJuIHsgdG9rZW5BZGRyZXNzOiB0b2tlbiwgZGVjaW1hbHMsIGJhbGFuY2VGb3JtYXR0ZWQ6IGZvcm1hdFVuaXRzKGJhbGFuY2UsIGRlY2ltYWxzKSB9O1xufVxuXG4vLyBcdThCODBcdTMwMENcdTRFRkJcdTRFMDBcdTRGN0ZcdTc1MjhcdTgwMDVcdTkzMjJcdTUzMDVcdTMwMERcdTU3MjhcdTY3RDBcdTk4NDYgUldBIFx1NUMwOFx1NUM2Q1x1NEVGRFx1OTg0RFx1NEVFM1x1NUU2M1x1NzY4NFx1OTNDOFx1NEUwQVx1NzcxRlx1NUJFNlx1OTkxOFx1OTg0RFx1RkYwOFx1NTUyRlx1OEI4MFx1RkYwOVx1MzAwMlxuLy8gXHU3NTI4XHU2NUJDXHU2MjhBXHUzMDBDXHU0RjdGXHU3NTI4XHU4MDA1XHU1RjlFIFNhZmUgXHU5MUQxXHU1RUFCXHU3NkY0XHU2M0E1XHU5M0M4XHU0RTBBXHU4RjQ5XHU1MTY1XHUzMDAxXHU3RTVFXHU5MDRFXHU3QUQ5XHU1MTY3XHU1RTMzXHU2NzJDXHUzMDBEXHU3Njg0XHU0RUZEXHU5ODREXHVGRjBDXHU1M0NEXHU2NjIwXHU1NkRFXG4vLyBob2xkaW5ncyBcdTVFMzNcdTY3MkNcdUZGMDhcdTg5OEIgcmVsYXllci50cyBcdTc2ODQgc3luYy1ob2xkaW5nIGFjdGlvblx1RkYwOVx1MzAwMlx1NTZERVx1NTBCM1x1NjU3NFx1NjU3OFx1NEVGRFx1OTg0RFx1NUI1N1x1NEUzMlx1RkYwRlx1NjU3OFx1NTAzQ1x1MzAwMlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldFdhbGxldFNoYXJlQmFsYW5jZShcbiAgdG9rZW5BZGRyZXNzOiBzdHJpbmcsXG4gIHdhbGxldEFkZHJlc3M6IHN0cmluZyxcbik6IFByb21pc2U8eyB0b2tlbkFkZHJlc3M6IEFkZHJlc3M7IGRlY2ltYWxzOiBudW1iZXI7IGJhbGFuY2U6IG51bWJlcjsgYmFsYW5jZUZvcm1hdHRlZDogc3RyaW5nIH0+IHtcbiAgY29uc3QgdG9rZW4gPSBnZXRBZGRyZXNzKHRva2VuQWRkcmVzcy50cmltKCkpO1xuICBjb25zdCB3YWxsZXQgPSBnZXRBZGRyZXNzKHdhbGxldEFkZHJlc3MudHJpbSgpKTtcbiAgY29uc3QgZGVjaW1hbHMgPSBhd2FpdCBzaGFyZVRva2VuRGVjaW1hbHModG9rZW4pO1xuICBjb25zdCBiYWxhbmNlID0gKGF3YWl0IHB1YmxpY0NsaWVudCgpLnJlYWRDb250cmFjdCh7XG4gICAgYWRkcmVzczogdG9rZW4sXG4gICAgYWJpOiBzaGFyZVRva2VuQWJpLFxuICAgIGZ1bmN0aW9uTmFtZTogXCJiYWxhbmNlT2ZcIixcbiAgICBhcmdzOiBbd2FsbGV0XSxcbiAgfSkpIGFzIGJpZ2ludDtcbiAgY29uc3QgYmFsYW5jZUZvcm1hdHRlZCA9IGZvcm1hdFVuaXRzKGJhbGFuY2UsIGRlY2ltYWxzKTtcbiAgcmV0dXJuIHsgdG9rZW5BZGRyZXNzOiB0b2tlbiwgZGVjaW1hbHMsIGJhbGFuY2U6IE51bWJlcihiYWxhbmNlRm9ybWF0dGVkKSwgYmFsYW5jZUZvcm1hdHRlZCB9O1xufVxuXG4vKipcbiAqIFx1MzAwQ1JXQSBcdTRFMEJcdUZGRkRcdUZGRkRcdTMwMERcdTVDMDhcdTc1MjhcdUZGMUFcdTU2MTdcdThBNjZcdTYyOEFcdTY3RDBcdTkzMjJcdTUzMDVcdTYzMDFcdTY3MDlcdTc2ODQgUldBIFx1NUMwOFx1NUM2Q1x1NEVGRFx1OTg0RFx1NEVFM1x1NUU2M1x1NjUzNlx1NTZERVx1OTFEMVx1NUVBQlx1RkYwOFNhZmVcdUZGMDlcdTMwMDJcbiAqIFJXQSBcdTRFRkRcdTk4NERcdTRFRTNcdTVFNjNcdUZGMDhSV0FGYWN0b3J5IFx1OTQ0NFx1OTAyMFx1RkYwOVx1NkM5Mlx1NjcwOVx1NTBDRiBKQy9BRSBcdTY1QjBcdTU0MDhcdTdEMDRcdTkwQTNcdTZBMjMgb3duZXItb25seSBcdTc2ODRcbiAqIGFkbWluUmVjbGFpbVx1RkYwQ1x1NTNFQVx1ODBGRFx1NzUyOFx1NEUwMFx1ODIyQyB0cmFuc2ZlckZyb21cdTIwMTRcdTIwMTRcdTgyRTVcdThBNzJcdTRGN0ZcdTc1MjhcdTgwMDVcdTVGOUVcdTY3MkFcdUZGRkRcdUZGRkRcdUZGRkQgQURNSU4gYXBwcm92ZVxuICogXHU5MDRFXHVGRjA4XHU0RjhCXHU1OTgyXHU1RjlFXHU2NzJBXHU1NzI4XHU0RThDXHU3RDFBXHU1RTAyXHU1ODM0XHU2MzlCXHU5MDRFXHU4Q0UzXHU1NUFFXHVGRjA5XHVGRjBDXHU2QjY0XHU1NDdDXHU1M0VCXHU2NzAzXHU0RTFGXHU1MUZBXHU2RTA1XHU2OTVBXHU0RTJEXHU2NTg3XHU5MzJGXHU4QUE0XHVGRjBDXHU3NTMxXHU1NDdDXHU1M0VCXHU3QUVGXG4gKiBcdTYzNTVcdTYzNDlcdTRFMjZcdTUyMTdcdTcwQkFcdTMwMENcdTk3MDBcdTRFQkFcdTVERTVcdTg2NTVcdTc0MDZcdTMwMERcdUZGMENcdTRFMERcdTVGNzFcdTk3RkZcdTRFMEJcdTY3QjZcdTY3MkNcdThFQUJcdUZGMDhcdTdBRDlcdTUxNjcgSkMgXHU1REYyXHU1MzlGXHU4REVGXHU5MDAwXHU2QjNFXHUzMDAxaG9sZGluZ3NcbiAqIFx1NURGMlx1NkUwNVx1N0E3QVx1RkYwOVx1MzAwMmFtb3VudDw9MCBcdTY2NDJcdTc2RjRcdTYzQTVcdTU2REUgbnVsbFx1RkYwOFx1NEUwRFx1OTAwMVx1NTFGQVx1NEVBNFx1NjYxM1x1RkYwOVx1MzAwMlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVjbGFpbVJ3YVNoYXJlKFxuICB0b2tlbkFkZHJlc3M6IEFkZHJlc3MsXG4gIGZyb206IEFkZHJlc3MsXG4gIGFtb3VudDogbnVtYmVyLFxuICB0bzogQWRkcmVzcyA9IFJFTEFZRVJfQUREUkVTU0VTLnNhZmVWYXVsdCxcbik6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBpZiAoYW1vdW50IDw9IDApIHJldHVybiBudWxsO1xuICAvLyBcdTY1QjBcdTcyNDggRmFjdG9yeSBcdTRFRTNcdTVFNjNcdTY1MkZcdTYzRjQgcmVjbGFpbVNoYXJlc1x1RkYwOFx1NEUwRFx1OTcwMFx1NjMwMVx1NjcwOVx1NEVCQVx1NjM4OFx1NkIwQVx1RkYwOVx1RkYxQlx1NTE0OFx1NkEyMVx1NjRFQ1x1RkYwQ1x1NTNFRlx1ODg0Q1x1NUMzMVx1NzZGNFx1NjNBNVx1NUYzN1x1NTIzNlx1NjUzNlx1NTZERVx1MzAwMlxuICB0cnkge1xuICAgIGF3YWl0IHB1YmxpY0NsaWVudCgpLnNpbXVsYXRlQ29udHJhY3Qoe1xuICAgICAgYWNjb3VudDogcmVsYXllckFkZHJlc3MoKSxcbiAgICAgIGFkZHJlc3M6IFJFTEFZRVJfQUREUkVTU0VTLnJ3YUZhY3RvcnksXG4gICAgICBhYmk6IHJ3YUZhY3RvcnlBYmksXG4gICAgICBmdW5jdGlvbk5hbWU6IFwicmVjbGFpbVNoYXJlc1wiLFxuICAgICAgYXJnczogW3Rva2VuQWRkcmVzcywgZnJvbV0sXG4gICAgfSk7XG4gICAgY29uc3QgaGFzaCA9IGF3YWl0IHNlbmRBZG1pblR4KChub25jZSkgPT5cbiAgICAgIGFkbWluV2FsbGV0Q2xpZW50KCkud3JpdGVDb250cmFjdCh7XG4gICAgICAgIGFkZHJlc3M6IFJFTEFZRVJfQUREUkVTU0VTLnJ3YUZhY3RvcnksXG4gICAgICAgIGFiaTogcndhRmFjdG9yeUFiaSxcbiAgICAgICAgZnVuY3Rpb25OYW1lOiBcInJlY2xhaW1TaGFyZXNcIixcbiAgICAgICAgYXJnczogW3Rva2VuQWRkcmVzcywgZnJvbV0sXG4gICAgICAgIGNoYWluOiBSRUxBWUVSX0NIQUlOLFxuICAgICAgICBub25jZSxcbiAgICAgIH0pLFxuICAgICk7XG4gICAgY29uc3QgcmVjZWlwdCA9IGF3YWl0IHB1YmxpY0NsaWVudCgpLndhaXRGb3JUcmFuc2FjdGlvblJlY2VpcHQoeyBoYXNoIH0pO1xuICAgIGlmIChyZWNlaXB0LnN0YXR1cyAhPT0gXCJzdWNjZXNzXCIpIHRocm93IG5ldyBFcnJvcihcInJlY2xhaW1TaGFyZXMgcmV2ZXJ0ZWRcIik7XG4gICAgcmV0dXJuIGhhc2g7XG4gIH0gY2F0Y2gge1xuICAgIC8vIFx1ODIwQVx1NEVFM1x1NUU2M1x1NEUwRFx1NjUyRlx1NjNGNFx1NUYzN1x1NTIzNlx1NTZERVx1NjUzNlx1RkYwQ1x1OTAwMFx1NTZERVx1MzAwQ1x1NjMwMVx1NjcwOVx1NEVCQVx1NURGMlx1NjM4OFx1NkIwQVx1MzAwRFx1NzY4NCB0cmFuc2ZlckZyb21cdTMwMDJcbiAgfVxuICBjb25zdCBkZWNpbWFscyA9IGF3YWl0IHNoYXJlVG9rZW5EZWNpbWFscyh0b2tlbkFkZHJlc3MpO1xuICByZXR1cm4gdHJhbnNmZXJGcm9tVmlhQWRtaW4oe1xuICAgIHRva2VuOiB0b2tlbkFkZHJlc3MsXG4gICAgZnJvbSxcbiAgICB0byxcbiAgICBhbW91bnRVbml0czogcGFyc2VVbml0cyhhbW91bnQudG9GaXhlZChkZWNpbWFscyksIGRlY2ltYWxzKSxcbiAgICBub0FsbG93YW5jZU1zZzogXCJcdThBNzJcdTRGN0ZcdTc1MjhcdTgwMDVcdTVDMUFcdTY3MkFcdTYzODhcdTZCMEFcdTVFNzNcdTUzRjBcdTUyRDVcdUZGRkRcdUZGRkRcdUZGRkRcdTUxNzYgUldBIFx1NEVGRFx1OTg0RFx1RkYwOFx1NjIxNlx1NjM4OFx1NkIwQVx1OTg0RFx1NUVBNlx1NEUwRFx1OERCM1x1RkYwOVx1RkYwQ1x1NzEyMVx1NkNENVx1NUYzN1x1NTIzNlx1NjUzNlx1NTZERVx1RkYwQ1x1OTcwMFx1NEVCQVx1NURFNVx1ODY1NVx1NzQwNlx1MzAwMlwiLFxuICAgIGxvd0JhbGFuY2VNc2c6IFwiXHU4QTcyXHU0RjdGXHU3NTI4XHU4MDA1XHU5M0M4XHU0RTBBIFJXQSBcdTRFRkRcdTk4NERcdTk5MThcdTk4NERcdTRFMERcdThEQjNcdUZGMENcdTcxMjFcdTZDRDVcdTY1MzZcdTU2REVcdTMwMDJcIixcbiAgfSk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRWYXVsdFN0YXR1cyh0b2tlbjogXCJqY1Rva2VuXCIgfCBcImFlVG9rZW5cIikge1xuICBjb25zdCB0b2tlbkFkZHJlc3MgPSBSRUxBWUVSX0FERFJFU1NFU1t0b2tlbl07XG4gIGNvbnN0IGFiaSA9IHRva2VuID09PSBcImpjVG9rZW5cIiA/IGpjQWJpIDogYWVBYmk7XG4gIGNvbnN0IGRlY2ltYWxzID0gYXdhaXQgdG9rZW5EZWNpbWFscyh0b2tlbik7XG4gIGNvbnN0IGJhbGFuY2UgPSAoYXdhaXQgcHVibGljQ2xpZW50KCkucmVhZENvbnRyYWN0KHtcbiAgICBhZGRyZXNzOiB0b2tlbkFkZHJlc3MsXG4gICAgYWJpLFxuICAgIGZ1bmN0aW9uTmFtZTogXCJiYWxhbmNlT2ZcIixcbiAgICBhcmdzOiBbcmVsYXllckFkZHJlc3MoKV0sXG4gIH0pKSBhcyBiaWdpbnQ7XG4gIHJldHVybiB7XG4gICAgdG9rZW4sXG4gICAgdG9rZW5BZGRyZXNzLFxuICAgIGRlY2ltYWxzLFxuICAgIGJhbGFuY2UsXG4gICAgYmFsYW5jZUZvcm1hdHRlZDogZm9ybWF0VW5pdHMoYmFsYW5jZSwgZGVjaW1hbHMpLFxuICAgIGxvdzogYmFsYW5jZSA8IHBhcnNlVW5pdHMoU3RyaW5nKExPV19IT1RfV0FMTEVUX0JBTEFOQ0VfVU5JVFMpLCBkZWNpbWFscyksXG4gIH07XG59XG4iLCAiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi92ZXJjZWwvc2hhcmUvdjAtcHJvamVjdC9hcGlcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi92ZXJjZWwvc2hhcmUvdjAtcHJvamVjdC9hcGkvcmVsYXllci50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vdmVyY2VsL3NoYXJlL3YwLXByb2plY3QvYXBpL3JlbGF5ZXIudHNcIjsvLyBcdTVGOENcdTdBRUYgcmVsYXllclx1RkYxQVx1NEVFNVx1NTVBRVx1NEUwMCBBRE1JTl9QUklWQVRFX0tFWSBcdTcxQjFcdTkzMjJcdTUzMDVcdTRFRTNcdTc2N0NcdTYyNDBcdTY3MDlcdTk3MDBcdTg5ODFcdTU0MDhcdTdEMDQgb3duZXIgXHU4RUFCXHU1MjA2XHUzMDAxXG4vLyBcdTYyMTZcdTc2RjRcdTYzQTVcdTUyRDVcdTc1MjhcdTcxQjFcdTkzMjJcdTUzMDVcdTgxRUFcdThFQUJcdTk5MThcdTk4NERcdTYyNERcdTgwRkRcdTkwMDFcdTUxRkFcdTc2ODRcdTkzQzhcdTRFMEFcdTdENTBcdTdCOTdcdTRFQTRcdTY2MTNcdTMwMDJcbi8vXG4vLyBcdTcwQkFcdTRFQzBcdTlFQkNcdTk3MDBcdTg5ODFcdTVCODNcdUZGMUFKQy9BRSBcdTc2N0NcdTY1M0VcdUZGMDhBRE1JTiBcdTcxQjFcdTkzMjJcdTUzMDVcdTc2RjRcdTYzQTUgdHJhbnNmZXIgXHU4MUVBXHU1REYxXHU3Njg0XHU5OTE4XHU5ODREXHVGRjBDXHU1RUFCXHU1QjU4XHU3NTMxXHU0RUJBXHU1REU1XG4vLyBcdTVGOUUgU2FmZSBcdTkxRDFcdTVFQUJcdThGNDlcdTVFMzNcdTg4RENcdThDQThcdUZGMDlcdTMwMDFcdTRFMDBcdTdEMUFcdThBOERcdThDRkMgZXhlY3V0ZVN1YnNjcmlwdGlvbiBcdTk3MDBcdTg5ODEgQURNSU4gXHU2QjBBXHU5NjUwXHVGRjBDXHU0RUE0XHU3NTMxXHU1RjhDXHU3QUVGXG4vLyByZWxheWVyIFx1NEVFM1x1NzY3Q1x1MzAwMlx1NEU4Q1x1N0QxQVx1NUUwMlx1NTgzNFx1NTI0N1x1NzUzMVx1NEY3Rlx1NzUyOFx1ODAwNVx1NzZGNFx1NjNBNVx1N0MzRFx1N0Y3MiBQMlBFc2Nyb3cgXHU3Njg0XHU2MzlCXHU1NUFFL1x1NjIxMFx1NEVBNC9cdTUzRDZcdTZEODhcdTRFQTRcdTY2MTNcdUZGMUJcbi8vIFx1NUY4Q1x1N0FFRlx1NTNFQVx1OUE1N1x1OEI0OVx1OTNDOFx1NEUwQVx1NEU4Qlx1NEVGNlx1NEUyNlx1NTQwQ1x1NkI2NVx1OENDN1x1NjU5OVx1NUVBQlx1RkYwQ1x1NEUwRFx1NEVFM1x1NjZGRlx1NEY3Rlx1NzUyOFx1ODAwNVx1NzlGQlx1NTJENVx1OEExN1x1N0JBMVx1OENDN1x1NzUyMlx1MzAwMlxuLy9cbi8vIFx1NUI4OVx1NTE2OFx1NkEyMVx1NTc4Qlx1RkYxQVxuLy8gIDEuIFx1NTNFQVx1NjNBNVx1NTNEN1x1NUUzNlx1NjcwOVx1NjcwOVx1NjU0OCBTdXBhYmFzZSBzZXNzaW9uIHRva2VuIFx1NzY4NFx1OEFDQlx1NkM0Mlx1RkYwOGdldFVzZXIgXHU5QTU3XHU4QjQ5XHVGRjA5XHUzMDAyXG4vLyAgMi4gXHU5MUQxXHU5ODREXHU4MjA3XHU1QzBEXHU2MjRCXHU2NUI5XHU0RTAwXHU1RjhCXHU1RjlFXHU2NUUyXHU2NzA5IFJQQyBcdTVCRUJcdTRFMEJcdTc2ODQgamNfbGVkZ2VyIFx1N0QwMFx1OTMwNFx1NjNBOFx1NUMwRVx1RkYwQ1x1N0Q1NVx1NEUwRFx1NEZFMVx1NEVGQlx1NTI0RFx1N0FFRlx1NTBCM1x1NEY4Nlx1NzY4NFx1NjU3OFx1NUI1N1x1MzAwMlxuLy8gIDMuIG9uY2hhaW5fc2V0dGxlbWVudHMgXHU0RUU1IHJlZl9rZXkgXHU1MDVBXHU1MUFBXHU3QjQ5XHVGRjBDXHU5MDdGXHU1MTREXHU5MUNEXHU4OTA3XHU3NjdDXHU1RTYzIC8gXHU5MUNEXHU4OTA3XHU3RDUwXHU3Qjk3XHUzMDAyXG4vLyAgNC4gd2lyZS1jb250cmFjdHMgXHU1MEM1XHU5NjUwXHU3QkExXHU3NDA2XHU1NEUxXHVGRjA4cHJvZmlsZXMuYWdlbmN5X3JvbGVcdUZGMDlcdTMwMDJcbmltcG9ydCB0eXBlIHsgSW5jb21pbmdNZXNzYWdlLCBTZXJ2ZXJSZXNwb25zZSB9IGZyb20gXCJub2RlOmh0dHBcIjtcbmltcG9ydCB7IGNyZWF0ZUNsaWVudCwgdHlwZSBTdXBhYmFzZUNsaWVudCB9IGZyb20gXCJAc3VwYWJhc2Uvc3VwYWJhc2UtanNcIjtcbmltcG9ydCB7IGZvcm1hdFVuaXRzLCBnZXRBZGRyZXNzLCBwYXJzZUV2ZW50TG9ncywgcGFyc2VVbml0cywgdHlwZSBBZGRyZXNzIH0gZnJvbSBcInZpZW1cIjtcbmltcG9ydCB7XG4gIGNyZWF0ZVJ3YUZhY3RvcnlUb2tlbixcbiAgZ2V0Q3VycmVudFJ3YUZhY3RvcnlUb2tlbixcbiAgZmluZFJlY2VudEFzc2V0VHJhbnNmZXIsXG4gIGdldEFkbWluVHJhbnNhY3Rpb25TdGF0dXMsXG4gIHdhaXRGb3JBZG1pblRyYW5zYWN0aW9uLFxuICB0eXBlIE9uQWRtaW5UcmFuc2FjdGlvblN1Ym1pdHRlZCxcbiAgZW5zdXJlUmVsYXllckdhcyxcbiAgZXhlY3V0ZUFlU3Vic2NyaXB0aW9uLFxuICBleGVjdXRlU3Vic2NyaXB0aW9uLFxuICBnZXRIb3RXYWxsZXRTaGFyZUJhbGFuY2UsXG4gIGdldFdhbGxldFNoYXJlQmFsYW5jZSxcbiAgc3BvbnNvclVzZXJHYXMsXG4gIGdldFZhdWx0U3RhdHVzLFxuICBtaW50SmMsXG4gIG1pbnRUb2tlblN1cHBseSxcbiAgYnVyblZhdWx0SW52ZW50b3J5LFxuICBwdWxsSmNGcm9tVXNlcixcbiAgYWRtaW5TZW5kSmMsXG4gIGFkbWluU2VuZFVzZHQsXG4gIGNvbGxlY3RKY1RvVmF1bHQsXG4gIFJFTEFZRVJfQUREUkVTU0VTLFxuICBzZW5kQWRtaW5Bc3NldFBheW91dCxcbiAgc2VuZEFkbWluQXNzZXRSZWNsYWltLFxuICBnZXRMZWdhY3lBc3NldENoYWluU3RhdGUsXG4gIGdldEFkbWluQXNzZXRSZWNsYWltUmVjZWlwdFN0YXR1cyxcbiAgd2FpdEZvckFkbWluQXNzZXRQYXlvdXQsXG4gIHdhaXRGb3JBZG1pbkFzc2V0UmVjbGFpbSxcbiAgc2VuZEpjVG9WYXVsdCxcbiAgcmVsYXllckFkZHJlc3MsXG4gIHdpcmVSd2FDb250cmFjdHMsXG4gIGFkbWluUmVjbGFpbUFlLFxuICBnZXRBZUNoYWluQmFsYW5jZSxcbiAgcmVjbGFpbVJ3YVNoYXJlLFxuICBQMlBfRVNDUk9XX0FCSSxcbiAgUDJQX0VTQ1JPV19BRERSRVNTLFxuICBwMnBFc2Nyb3dBZGRyZXNzLFxuICBnZXRQMlBFc2Nyb3dSZWNlaXB0LFxuICBnZXRQMlBFc2Nyb3dMb2NrZWQsXG59IGZyb20gXCIuL19vbmNoYWluXCI7XG5cbmZ1bmN0aW9uIGpzb24ocmVzcG9uc2U6IFNlcnZlclJlc3BvbnNlLCBzdGF0dXM6IG51bWJlciwgcGF5bG9hZDogdW5rbm93bikge1xuICByZXNwb25zZS5zdGF0dXNDb2RlID0gc3RhdHVzO1xuICByZXNwb25zZS5zZXRIZWFkZXIoXCJDb250ZW50LVR5cGVcIiwgXCJhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04XCIpO1xuICByZXNwb25zZS5zZXRIZWFkZXIoXCJDYWNoZS1Db250cm9sXCIsIFwibm8tc3RvcmVcIik7XG4gIHJlc3BvbnNlLmVuZChKU09OLnN0cmluZ2lmeShwYXlsb2FkKSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlYWRCb2R5KHJlcXVlc3Q6IEluY29taW5nTWVzc2FnZSkge1xuICBsZXQgcmF3ID0gXCJcIjtcbiAgZm9yIGF3YWl0IChjb25zdCBjaHVuayBvZiByZXF1ZXN0KSB7XG4gICAgcmF3ICs9IGNodW5rO1xuICAgIGlmIChyYXcubGVuZ3RoID4gMzJfNzY4KSB0aHJvdyBuZXcgRXJyb3IoXCJQYXlsb2FkIHRvbyBsYXJnZVwiKTtcbiAgfVxuICByZXR1cm4gSlNPTi5wYXJzZShyYXcgfHwgXCJ7fVwiKSBhcyB7XG4gICAgYWN0aW9uPzogc3RyaW5nO1xuICAgIHJlcXVlc3RLZXk/OiBzdHJpbmc7XG4gICAgc2V0dGxlbWVudElkPzogc3RyaW5nO1xuICAgIGxlZGdlckFjdGlvbj86IHN0cmluZztcbiAgICBsZWRnZXJSb3dJZD86IHN0cmluZztcbiAgICBwbGFjZW1lbnRJZD86IHN0cmluZztcbiAgICBhc3NldEtleT86IHN0cmluZztcbiAgICBleHBlY3RlZEFtb3VudD86IHN0cmluZztcbiAgICB0eEhhc2g/OiBzdHJpbmc7XG4gICAgZXZlbnRJZD86IHN0cmluZztcbiAgfTtcbn1cblxuLy8gXHU3QkExXHU3NDA2XHU2QjBBXHU5NjUwXHU4MjA3XHU0RUUzXHU3NDA2XHU4RUFCXHU1MjA2XHU1MjA2XHU5NkUyXHVGRjFBXHU4MjBBXHU1RTMzXHU4NjVGXHU2Q0JGXHU3NTI4IGFnZW5jeV9yb2xlXHVGRjBDXHU5NkQ5XHU5MUNEXHU4RUFCXHU1MjA2XHU1RTMzXHU4NjVGXHU3NTI4IHJvbGVcdTMwMDJcbmNvbnN0IEFETUlOX1JPTEVTID0gbmV3IFNldChbXCJcdTdCQTFcdTc0MDZcdTU0RTFcIiwgXCJhZG1pblwiLCBcInN1cGVyX2FkbWluXCJdKTtcbmNvbnN0IGlzQWRtaW5Qcm9maWxlID0gKHByb2ZpbGU6IHsgYWdlbmN5X3JvbGU/OiBzdHJpbmcgfCBudWxsOyByb2xlPzogc3RyaW5nIHwgbnVsbCB9KSA9PlxuICBBRE1JTl9ST0xFUy5oYXMoU3RyaW5nKHByb2ZpbGUuYWdlbmN5X3JvbGUgPz8gXCJcIikpIHx8XG4gIFtcImFkbWluXCIsIFwic3VwZXJfYWRtaW5cIl0uaW5jbHVkZXMoU3RyaW5nKHByb2ZpbGUucm9sZSA/PyBcIlwiKSk7XG5cbmZ1bmN0aW9uIHRvQWRkcmVzcyh2YWx1ZTogdW5rbm93biwgbGFiZWw6IHN0cmluZyk6IEFkZHJlc3Mge1xuICBpZiAodHlwZW9mIHZhbHVlICE9PSBcInN0cmluZ1wiKSB0aHJvdyBuZXcgRXJyb3IoYCR7bGFiZWx9IFx1NjcyQVx1N0Q4MVx1NUI5QVx1OTNDOFx1NEUwQVx1OTMyMlx1NTMwNWApO1xuICB0cnkge1xuICAgIHJldHVybiBnZXRBZGRyZXNzKHZhbHVlLnRyaW0oKSk7XG4gIH0gY2F0Y2gge1xuICAgIHRocm93IG5ldyBFcnJvcihgJHtsYWJlbH0gXHU5MzIyXHU1MzA1XHU1NzMwXHU1NzQwXHU2ODNDXHU1RjBGXHU5MzJGXHU4QUE0YCk7XG4gIH1cbn1cblxudHlwZSBFc2Nyb3dFdmVudE5hbWUgPSBcIk9yZGVyQ3JlYXRlZFwiIHwgXCJPcmRlckZpbGxlZFwiIHwgXCJPcmRlckNhbmNlbGxlZFwiO1xudHlwZSBEZWNvZGVkRXNjcm93RXZlbnQgPSB7IGV2ZW50TmFtZTogc3RyaW5nOyBhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB9O1xuXG50eXBlIEVzY3Jvd0NhbGxlciA9IHtcbiAgaWQ6IHN0cmluZztcbiAgd2FsbGV0X2FkZHJlc3M6IHN0cmluZyB8IG51bGw7XG4gIGFnZW5jeV9yb2xlPzogc3RyaW5nIHwgbnVsbDtcbiAgcm9sZT86IHN0cmluZyB8IG51bGw7XG59O1xuXG5hc3luYyBmdW5jdGlvbiBkZWNvZGVFc2Nyb3dFdmVudCh0eEhhc2hJbnB1dDogc3RyaW5nLCBldmVudE5hbWU6IEVzY3Jvd0V2ZW50TmFtZSkge1xuICBpZiAoIS9eMHhbMC05YS1mQS1GXXs2NH0kLy50ZXN0KHR4SGFzaElucHV0KSkgdGhyb3cgbmV3IEVycm9yKFwiXHU0RUE0XHU2NjEzXHU5NkRDXHU2RTRBXHU2ODNDXHU1RjBGXHU5MzJGXHU4QUE0XCIpO1xuICBjb25zdCB0eEhhc2ggPSB0eEhhc2hJbnB1dC50b0xvd2VyQ2FzZSgpIGFzIGAweCR7c3RyaW5nfWA7XG4gIGNvbnN0IGVzY3JvdyA9IHAycEVzY3Jvd0FkZHJlc3MoKTtcbiAgY29uc3QgcmVjZWlwdCA9IGF3YWl0IGdldFAyUEVzY3Jvd1JlY2VpcHQodHhIYXNoKTtcbiAgaWYgKHJlY2VpcHQuc3RhdHVzICE9PSBcInN1Y2Nlc3NcIikgdGhyb3cgbmV3IEVycm9yKFwiXHU5M0M4XHU0RTBBXHU0RUE0XHU2NjEzXHU1QzFBXHU2NzJBXHU2MjEwXHU1MjlGXHU3OEJBXHU4QThEXCIpO1xuICBjb25zdCBsb2dzID0gcmVjZWlwdC5sb2dzLmZpbHRlcigobG9nKSA9PiBsb2cuYWRkcmVzcy50b0xvd2VyQ2FzZSgpID09PSBlc2Nyb3cudG9Mb3dlckNhc2UoKSk7XG4gIGNvbnN0IGRlY29kZWQgPSBwYXJzZUV2ZW50TG9ncyh7IGFiaTogUDJQX0VTQ1JPV19BQkksIGxvZ3MsIHN0cmljdDogdHJ1ZSB9KSBhcyB1bmtub3duIGFzIERlY29kZWRFc2Nyb3dFdmVudFtdO1xuICBjb25zdCBldmVudCA9IGRlY29kZWQuZmluZCgoZW50cnkpID0+IGVudHJ5LmV2ZW50TmFtZSA9PT0gZXZlbnROYW1lKTtcbiAgaWYgKCFldmVudCkgdGhyb3cgbmV3IEVycm9yKGBcdTRFQTRcdTY2MTNcdTY1MzZcdTY0REFcdTRFMkRcdTYyN0VcdTRFMERcdTUyMzAgJHtldmVudE5hbWV9IFx1OEExN1x1N0JBMVx1NEU4Qlx1NEVGNmApO1xuICByZXR1cm4geyB0eEhhc2gsIGVzY3JvdywgYXJnczogZXZlbnQuYXJncyB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBzYXZlRXNjcm93RXZlbnQoXG4gIGFkbWluOiBTdXBhYmFzZUNsaWVudCxcbiAgdHhIYXNoOiBzdHJpbmcsXG4gIGV2ZW50VHlwZTogXCJvcmRlcl9jcmVhdGVkXCIgfCBcIm9yZGVyX2ZpbGxlZFwiIHwgXCJvcmRlcl9jYW5jZWxsZWRcIixcbiAgdXNlcklkOiBzdHJpbmcgfCBudWxsLFxuICBldmVudERhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgYWRtaW4uZnJvbShcInAycF9lc2Nyb3dfZXZlbnRzXCIpXG4gICAgLnNlbGVjdChcImV2ZW50X3R5cGUsdXNlcl9pZCxldmVudF9kYXRhLHN0YXR1c1wiKVxuICAgIC5lcShcInR4X2hhc2hcIiwgdHhIYXNoKVxuICAgIC5tYXliZVNpbmdsZSgpO1xuICBpZiAoZXhpc3RpbmcuZXJyb3IpIHRocm93IG5ldyBFcnJvcihgXHU4QTE3XHU3QkExXHU0RThCXHU0RUY2XHU4QjgwXHU1M0Q2XHU1OTMxXHU2NTU3XHVGRjFBJHtleGlzdGluZy5lcnJvci5tZXNzYWdlfWApO1xuICBpZiAoZXhpc3RpbmcuZGF0YSkge1xuICAgIGlmIChleGlzdGluZy5kYXRhLmV2ZW50X3R5cGUgIT09IGV2ZW50VHlwZSkgdGhyb3cgbmV3IEVycm9yKFwiXHU0RUE0XHU2NjEzXHU5NkRDXHU2RTRBXHU1REYyXHU3NTI4XHU2NUJDXHU0RTBEXHU1NDBDXHU5ODVFXHU1NzhCXHU3Njg0XHU4QTE3XHU3QkExXHU0RThCXHU0RUY2XCIpO1xuICAgIGlmIChleGlzdGluZy5kYXRhLnN0YXR1cyA9PT0gXCJmaW5hbGl6ZWRcIikgcmV0dXJuIHRydWU7XG4gICAgY29uc3QgdXBkYXRlID0gYXdhaXQgYWRtaW4uZnJvbShcInAycF9lc2Nyb3dfZXZlbnRzXCIpLnVwZGF0ZSh7XG4gICAgICB1c2VyX2lkOiB1c2VySWQsXG4gICAgICBldmVudF9kYXRhOiBldmVudERhdGEsXG4gICAgICBzdGF0dXM6IFwicGVuZGluZ1wiLFxuICAgICAgZXJyb3I6IG51bGwsXG4gICAgICB1cGRhdGVkX2F0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgfSkuZXEoXCJ0eF9oYXNoXCIsIHR4SGFzaCk7XG4gICAgaWYgKHVwZGF0ZS5lcnJvcikgdGhyb3cgbmV3IEVycm9yKGBcdThBMTdcdTdCQTFcdTRFOEJcdTRFRjZcdTRGRERcdTVCNThcdTU5MzFcdTY1NTdcdUZGMUEke3VwZGF0ZS5lcnJvci5tZXNzYWdlfWApO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBjb25zdCBpbnNlcnQgPSBhd2FpdCBhZG1pbi5mcm9tKFwicDJwX2VzY3Jvd19ldmVudHNcIikuaW5zZXJ0KHtcbiAgICB0eF9oYXNoOiB0eEhhc2gsXG4gICAgZXZlbnRfdHlwZTogZXZlbnRUeXBlLFxuICAgIHVzZXJfaWQ6IHVzZXJJZCxcbiAgICBldmVudF9kYXRhOiBldmVudERhdGEsXG4gICAgc3RhdHVzOiBcInBlbmRpbmdcIixcbiAgfSk7XG4gIGlmIChpbnNlcnQuZXJyb3IpIHtcbiAgICBjb25zdCByYWNlZCA9IGF3YWl0IGFkbWluLmZyb20oXCJwMnBfZXNjcm93X2V2ZW50c1wiKS5zZWxlY3QoXCJldmVudF90eXBlLHN0YXR1c1wiKS5lcShcInR4X2hhc2hcIiwgdHhIYXNoKS5tYXliZVNpbmdsZSgpO1xuICAgIGlmIChyYWNlZC5kYXRhPy5ldmVudF90eXBlID09PSBldmVudFR5cGUpIHJldHVybiByYWNlZC5kYXRhLnN0YXR1cyA9PT0gXCJmaW5hbGl6ZWRcIjtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFx1OEExN1x1N0JBMVx1NEU4Qlx1NEVGNlx1NEZERFx1NUI1OFx1NTkzMVx1NjU1N1x1RkYxQSR7aW5zZXJ0LmVycm9yLm1lc3NhZ2V9YCk7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG5hc3luYyBmdW5jdGlvbiBmaW5pc2hFc2Nyb3dFdmVudChhZG1pbjogU3VwYWJhc2VDbGllbnQsIHR4SGFzaDogc3RyaW5nLCBlcnJvcj86IHN0cmluZykge1xuICBjb25zdCB1cGRhdGUgPSBhd2FpdCBhZG1pbi5mcm9tKFwicDJwX2VzY3Jvd19ldmVudHNcIikudXBkYXRlKHtcbiAgICBzdGF0dXM6IGVycm9yID8gXCJmYWlsZWRcIiA6IFwiZmluYWxpemVkXCIsXG4gICAgZXJyb3I6IGVycm9yID8/IG51bGwsXG4gICAgdXBkYXRlZF9hdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICB9KS5lcShcInR4X2hhc2hcIiwgdHhIYXNoKTtcbiAgaWYgKHVwZGF0ZS5lcnJvcikgdGhyb3cgbmV3IEVycm9yKGBcdThBMTdcdTdCQTFcdTRFOEJcdTRFRjZcdTcyQzBcdTYxNEJcdTY2RjRcdTY1QjBcdTU5MzFcdTY1NTdcdUZGMUEke3VwZGF0ZS5lcnJvci5tZXNzYWdlfWApO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwcm9maWxlRm9yV2FsbGV0KGFkbWluOiBTdXBhYmFzZUNsaWVudCwgd2FsbGV0OiBBZGRyZXNzKSB7XG4gIGNvbnN0IHsgZGF0YSwgZXJyb3IgfSA9IGF3YWl0IGFkbWluLmZyb20oXCJwcm9maWxlc1wiKVxuICAgIC5zZWxlY3QoXCJpZCx3YWxsZXRfYWRkcmVzc1wiKVxuICAgIC5pbGlrZShcIndhbGxldF9hZGRyZXNzXCIsIHdhbGxldClcbiAgICAubWF5YmVTaW5nbGUoKTtcbiAgaWYgKGVycm9yIHx8ICFkYXRhKSB0aHJvdyBuZXcgRXJyb3IoXCJcdTkzQzhcdTRFMEFcdTkzMjJcdTUzMDVcdTVDMUFcdTY3MkFcdTdEODFcdTVCOUFcdTU1MkZcdTRFMDBcdTVFNzNcdTUzRjBcdTVFMzNcdTg2NUZcIik7XG4gIHJldHVybiBkYXRhIGFzIHsgaWQ6IHN0cmluZzsgd2FsbGV0X2FkZHJlc3M6IHN0cmluZyB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBwcm9jZXNzRXNjcm93T3JkZXJDcmVhdGVkKFxuICBhZG1pbjogU3VwYWJhc2VDbGllbnQsXG4gIHR4SGFzaElucHV0OiBzdHJpbmcsXG4gIGNhbGxlcjogRXNjcm93Q2FsbGVyIHwgbnVsbCxcbik6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgY29uc3QgeyB0eEhhc2gsIGFyZ3MgfSA9IGF3YWl0IGRlY29kZUVzY3Jvd0V2ZW50KHR4SGFzaElucHV0LCBcIk9yZGVyQ3JlYXRlZFwiKTtcbiAgY29uc3QgbWFrZXIgPSB0b0FkZHJlc3MoYXJncy5tYWtlciwgXCJcdTYzOUJcdTU1QUVcdTgwMDVcIik7XG4gIGNvbnN0IHByb2ZpbGUgPSBhd2FpdCBwcm9maWxlRm9yV2FsbGV0KGFkbWluLCBtYWtlcik7XG4gIGlmIChjYWxsZXIgJiYgY2FsbGVyLmlkICE9PSBwcm9maWxlLmlkKSB0aHJvdyBuZXcgRXJyb3IoXCJcdTUzRUFcdTgwRkRcdTU0MENcdTZCNjVcdTgxRUFcdTVERjFcdTkzMjJcdTUzMDVcdTVFRkFcdTdBQ0JcdTc2ODRcdThBMTdcdTdCQTFcdTYzOUJcdTU1QUVcIik7XG4gIGNvbnN0IGV2ZW50RGF0YSA9IHtcbiAgICB0eEhhc2gsXG4gICAgb3JkZXJJZDogU3RyaW5nKGFyZ3Mub3JkZXJJZCksXG4gICAgY2xpZW50T3JkZXJJZDogU3RyaW5nKGFyZ3MuY2xpZW50T3JkZXJJZCkudG9Mb3dlckNhc2UoKSxcbiAgICBtYWtlcixcbiAgICBpc1NlbGw6IEJvb2xlYW4oYXJncy5pc1NlbGwpLFxuICAgIGFzc2V0VG9rZW46IHRvQWRkcmVzcyhhcmdzLmFzc2V0VG9rZW4sIFwiXHU2QTE5XHU3Njg0XHU0RUUzXHU1RTYzXCIpLnRvTG93ZXJDYXNlKCksXG4gICAgY3VycmVuY3lUb2tlbjogdG9BZGRyZXNzKGFyZ3MuY3VycmVuY3lUb2tlbiwgXCJcdThBMDhcdTUwRjlcdTRFRTNcdTVFNjNcIikudG9Mb3dlckNhc2UoKSxcbiAgICBwcmljZTogU3RyaW5nKGFyZ3MucHJpY2UpLFxuICAgIHF1YW50aXR5OiBTdHJpbmcoYXJncy5xdWFudGl0eSksXG4gICAgbGlzdGluZ0ZlZTogU3RyaW5nKGFyZ3MubGlzdGluZ0ZlZSksXG4gIH07XG4gIGNvbnN0IGFscmVhZHlGaW5hbGl6ZWQgPSBhd2FpdCBzYXZlRXNjcm93RXZlbnQoYWRtaW4sIHR4SGFzaCwgXCJvcmRlcl9jcmVhdGVkXCIsIHByb2ZpbGUuaWQsIGV2ZW50RGF0YSk7XG4gIGlmIChhbHJlYWR5RmluYWxpemVkKSByZXR1cm4geyBzdGF0dXM6IFwiY29uZmlybWVkXCIsIGlkZW1wb3RlbnQ6IHRydWUsIHR4X2hhc2g6IHR4SGFzaCB9O1xuXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzZXJ2YXRpb24gPSBhd2FpdCBhZG1pbi5mcm9tKFwicDJwX2VzY3Jvd19vcmRlcl9yZXNlcnZhdGlvbnNcIilcbiAgICAgIC5zZWxlY3QoXCJyZXF1ZXN0X2tleSx1c2VyX2lkLGFzc2V0X2lkLHNpZGUsc3RhdHVzXCIpXG4gICAgICAuZXEoXCJjbGllbnRfb3JkZXJfaWRcIiwgZXZlbnREYXRhLmNsaWVudE9yZGVySWQpXG4gICAgICAubWF5YmVTaW5nbGUoKTtcbiAgICBpZiAocmVzZXJ2YXRpb24uZXJyb3IgfHwgIXJlc2VydmF0aW9uLmRhdGEgfHwgcmVzZXJ2YXRpb24uZGF0YS51c2VyX2lkICE9PSBwcm9maWxlLmlkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJcdTYyN0VcdTRFMERcdTUyMzBcdTZCNjRcdTkzQzhcdTRFMEFcdTYzOUJcdTU1QUVcdTVDMERcdTYxQzlcdTc2ODRcdThDQzdcdTY1OTlcdTVFQUJcdTk4MTBcdTc1NTlcdUZGMUJcdThBQ0JcdTc1MzFcdTdCQTFcdTc0MDZcdTU0RTFcdTZBQTJcdTY3RTVcdTkwMTlcdTdCNDZcdTRFQTRcdTY2MTNcIik7XG4gICAgfVxuICAgIGNvbnN0IHBsYWNlbWVudCA9IGF3YWl0IGFkbWluLmZyb20oXCJwcml2YXRlX3BsYWNlbWVudHNcIilcbiAgICAgIC5zZWxlY3QoXCJpZCxpc19hZV90b2tlbix0b2tlbl9hZGRyZXNzXCIpXG4gICAgICAuZXEoXCJpZFwiLCByZXNlcnZhdGlvbi5kYXRhLmFzc2V0X2lkKVxuICAgICAgLm1heWJlU2luZ2xlKCk7XG4gICAgaWYgKHBsYWNlbWVudC5lcnJvciB8fCAhcGxhY2VtZW50LmRhdGEpIHRocm93IG5ldyBFcnJvcihcIlx1NjI3RVx1NEUwRFx1NTIzMFx1NkI2NFx1NjM5Qlx1NTVBRVx1NUMwRFx1NjFDOVx1NzY4NFx1NkExOVx1NzY4NFwiKTtcbiAgICBjb25zdCBleHBlY3RlZEFzc2V0ID0gcGxhY2VtZW50LmRhdGEuaXNfYWVfdG9rZW5cbiAgICAgID8gUkVMQVlFUl9BRERSRVNTRVMuYWVUb2tlblxuICAgICAgOiB0b0ZhY3RvcnlUb2tlbkFkZHJlc3MocGxhY2VtZW50LmRhdGEudG9rZW5fYWRkcmVzcyk7XG4gICAgaWYgKCFleHBlY3RlZEFzc2V0IHx8IGV4cGVjdGVkQXNzZXQudG9Mb3dlckNhc2UoKSAhPT0gZXZlbnREYXRhLmFzc2V0VG9rZW4pIHRocm93IG5ldyBFcnJvcihcIlx1NjM5Qlx1NTVBRVx1NkExOVx1NzY4NFx1NEVFM1x1NUU2M1x1ODIwN1x1NUU3M1x1NTNGMFx1NkExOVx1NzY4NFx1OEEyRFx1NUI5QVx1NEUwRFx1NEUwMFx1ODFGNFwiKTtcbiAgICBpZiAoZXZlbnREYXRhLmN1cnJlbmN5VG9rZW4gIT09IFJFTEFZRVJfQUREUkVTU0VTLmpjVG9rZW4udG9Mb3dlckNhc2UoKSkgdGhyb3cgbmV3IEVycm9yKFwiXHU2QjY0XHU1RTczXHU1M0YwXHU2MzlCXHU1NUFFXHU1M0VBXHU2M0E1XHU1M0Q3IEpDIFx1OEEwOFx1NTBGOVwiKTtcbiAgICBjb25zdCB7IGRhdGEsIGVycm9yIH0gPSBhd2FpdCBhZG1pbi5ycGMoXCJjb25maXJtX3AycF9lc2Nyb3dfb3JkZXJcIiwgeyBwX3VzZXJfaWQ6IHByb2ZpbGUuaWQsIHBfZXZlbnQ6IGV2ZW50RGF0YSB9KTtcbiAgICBpZiAoZXJyb3IpIHRocm93IG5ldyBFcnJvcihlcnJvci5tZXNzYWdlKTtcbiAgICBhd2FpdCBmaW5pc2hFc2Nyb3dFdmVudChhZG1pbiwgdHhIYXNoKTtcbiAgICByZXR1cm4geyBzdGF0dXM6IFwiY29uZmlybWVkXCIsIHR4X2hhc2g6IHR4SGFzaCwgb3JkZXI6IGRhdGEgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zdCBtZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBcIlx1OEExN1x1N0JBMVx1NjM5Qlx1NTVBRVx1OENDN1x1NjU5OVx1NTQwQ1x1NkI2NVx1NTkzMVx1NjU1N1wiO1xuICAgIGF3YWl0IGZpbmlzaEVzY3Jvd0V2ZW50KGFkbWluLCB0eEhhc2gsIG1lc3NhZ2UpO1xuICAgIHRocm93IG5ldyBFcnJvcihgJHttZXNzYWdlfVx1RkYxQlx1NEVBNFx1NjYxM1x1NURGMlx1NEUwQVx1OTNDOFx1RkYwQ1x1NTNFRlx1NzUzMVx1N0JBMVx1NzQwNlx1NTRFMVx1OTFDRFx1OEE2Nlx1NTQwQ1x1NkI2NVx1RkYwOCR7dHhIYXNofVx1RkYwOWApO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHByb2Nlc3NFc2Nyb3dGaWxsKFxuICBhZG1pbjogU3VwYWJhc2VDbGllbnQsXG4gIHR4SGFzaElucHV0OiBzdHJpbmcsXG4gIGNhbGxlcjogRXNjcm93Q2FsbGVyIHwgbnVsbCxcbik6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgY29uc3QgeyB0eEhhc2gsIGFyZ3MgfSA9IGF3YWl0IGRlY29kZUVzY3Jvd0V2ZW50KHR4SGFzaElucHV0LCBcIk9yZGVyRmlsbGVkXCIpO1xuICBjb25zdCBidXllciA9IHRvQWRkcmVzcyhhcmdzLmJ1eWVyLCBcIlx1OENCN1x1NjVCOVwiKTtcbiAgY29uc3Qgc2VsbGVyID0gdG9BZGRyZXNzKGFyZ3Muc2VsbGVyLCBcIlx1OENFM1x1NjVCOVwiKTtcbiAgY29uc3QgW2J1eWVyUHJvZmlsZSwgc2VsbGVyUHJvZmlsZV0gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgcHJvZmlsZUZvcldhbGxldChhZG1pbiwgYnV5ZXIpLFxuICAgIHByb2ZpbGVGb3JXYWxsZXQoYWRtaW4sIHNlbGxlciksXG4gIF0pO1xuICBpZiAoYnV5ZXJQcm9maWxlLmlkID09PSBzZWxsZXJQcm9maWxlLmlkKSB0aHJvdyBuZXcgRXJyb3IoXCJcdTcxMjFcdTY1NDhcdTc2ODRcdTgxRUFcdTYyMTFcdTYyMTBcdTRFQTRcdTRFOEJcdTRFRjZcIik7XG4gIGlmIChjYWxsZXIgJiYgY2FsbGVyLmlkICE9PSBidXllclByb2ZpbGUuaWQgJiYgY2FsbGVyLmlkICE9PSBzZWxsZXJQcm9maWxlLmlkKSB0aHJvdyBuZXcgRXJyb3IoXCJcdTUzRUFcdTgwRkRcdTU0MENcdTZCNjVcdTgxRUFcdTVERjFcdTUzQzNcdTgyMDdcdTc2ODRcdTYyMTBcdTRFQTRcIik7XG4gIGNvbnN0IGV2ZW50RGF0YSA9IHtcbiAgICB0eEhhc2gsXG4gICAgZmlsbEtleTogU3RyaW5nKGFyZ3MuZmlsbEtleSkudG9Mb3dlckNhc2UoKSxcbiAgICBvcmRlcklkOiBTdHJpbmcoYXJncy5vcmRlcklkKSxcbiAgICBidXllcixcbiAgICBzZWxsZXIsXG4gICAgYXNzZXRUb2tlbjogdG9BZGRyZXNzKGFyZ3MuYXNzZXRUb2tlbiwgXCJcdTZBMTlcdTc2ODRcdTRFRTNcdTVFNjNcIikudG9Mb3dlckNhc2UoKSxcbiAgICBjdXJyZW5jeVRva2VuOiB0b0FkZHJlc3MoYXJncy5jdXJyZW5jeVRva2VuLCBcIlx1OEEwOFx1NTBGOVx1NEVFM1x1NUU2M1wiKS50b0xvd2VyQ2FzZSgpLFxuICAgIHF1YW50aXR5OiBTdHJpbmcoYXJncy5xdWFudGl0eSksXG4gICAgcHJpY2U6IFN0cmluZyhhcmdzLnByaWNlKSxcbiAgICBncm9zczogU3RyaW5nKGFyZ3MuZ3Jvc3MpLFxuICAgIGZlZTogU3RyaW5nKGFyZ3MuZmVlKSxcbiAgICBjdXJyZW5jeVJlbGVhc2VkOiBTdHJpbmcoYXJncy5jdXJyZW5jeVJlbGVhc2VkKSxcbiAgfTtcbiAgY29uc3QgYWxyZWFkeUZpbmFsaXplZCA9IGF3YWl0IHNhdmVFc2Nyb3dFdmVudChhZG1pbiwgdHhIYXNoLCBcIm9yZGVyX2ZpbGxlZFwiLCBidXllclByb2ZpbGUuaWQsIGV2ZW50RGF0YSk7XG4gIGlmIChhbHJlYWR5RmluYWxpemVkKSByZXR1cm4geyBzdGF0dXM6IFwiY29uZmlybWVkXCIsIGlkZW1wb3RlbnQ6IHRydWUsIHR4X2hhc2g6IHR4SGFzaCB9O1xuICB0cnkge1xuICAgIGNvbnN0IHsgZGF0YSwgZXJyb3IgfSA9IGF3YWl0IGFkbWluLnJwYyhcImZpbmFsaXplX3AycF9lc2Nyb3dfZmlsbFwiLCB7IHBfZXZlbnQ6IGV2ZW50RGF0YSB9KTtcbiAgICBpZiAoZXJyb3IpIHRocm93IG5ldyBFcnJvcihlcnJvci5tZXNzYWdlKTtcbiAgICBhd2FpdCBmaW5pc2hFc2Nyb3dFdmVudChhZG1pbiwgdHhIYXNoKTtcbiAgICByZXR1cm4geyBzdGF0dXM6IFwiY29uZmlybWVkXCIsIHR4X2hhc2g6IHR4SGFzaCwgZmlsbDogZGF0YSB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFwiXHU2MjEwXHU0RUE0XHU1RTMzXHU2NzJDXHU1NDBDXHU2QjY1XHU1OTMxXHU2NTU3XCI7XG4gICAgYXdhaXQgZmluaXNoRXNjcm93RXZlbnQoYWRtaW4sIHR4SGFzaCwgbWVzc2FnZSk7XG4gICAgdGhyb3cgbmV3IEVycm9yKGAke21lc3NhZ2V9XHVGRjFCXHU0RUE0XHU2NjEzXHU1REYyXHU0RTBBXHU5M0M4XHVGRjBDXHU1M0VGXHU3NTMxXHU3QkExXHU3NDA2XHU1NEUxXHU5MUNEXHU4QTY2XHU1NDBDXHU2QjY1XHVGRjA4JHt0eEhhc2h9XHVGRjA5YCk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gcHJvY2Vzc0VzY3Jvd0NhbmNlbChcbiAgYWRtaW46IFN1cGFiYXNlQ2xpZW50LFxuICB0eEhhc2hJbnB1dDogc3RyaW5nLFxuICBjYWxsZXI6IEVzY3Jvd0NhbGxlciB8IG51bGwsXG4pOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gIGNvbnN0IHsgdHhIYXNoLCBhcmdzIH0gPSBhd2FpdCBkZWNvZGVFc2Nyb3dFdmVudCh0eEhhc2hJbnB1dCwgXCJPcmRlckNhbmNlbGxlZFwiKTtcbiAgY29uc3QgbWFrZXIgPSB0b0FkZHJlc3MoYXJncy5tYWtlciwgXCJcdTYzOUJcdTU1QUVcdTgwMDVcIik7XG4gIGNvbnN0IHByb2ZpbGUgPSBhd2FpdCBwcm9maWxlRm9yV2FsbGV0KGFkbWluLCBtYWtlcik7XG4gIGlmIChjYWxsZXIgJiYgY2FsbGVyLmlkICE9PSBwcm9maWxlLmlkKSB0aHJvdyBuZXcgRXJyb3IoXCJcdTUzRUFcdTgwRkRcdTU0MENcdTZCNjVcdTgxRUFcdTVERjFcdTUzRDZcdTZEODhcdTc2ODRcdThBMTdcdTdCQTFcdTYzOUJcdTU1QUVcIik7XG4gIGNvbnN0IGV2ZW50RGF0YSA9IHtcbiAgICB0eEhhc2gsXG4gICAgb3JkZXJJZDogU3RyaW5nKGFyZ3Mub3JkZXJJZCksXG4gICAgbWFrZXIsXG4gICAgcmVmdW5kZWRBbW91bnQ6IFN0cmluZyhhcmdzLnJlZnVuZGVkQW1vdW50KSxcbiAgfTtcbiAgY29uc3QgYWxyZWFkeUZpbmFsaXplZCA9IGF3YWl0IHNhdmVFc2Nyb3dFdmVudChhZG1pbiwgdHhIYXNoLCBcIm9yZGVyX2NhbmNlbGxlZFwiLCBwcm9maWxlLmlkLCBldmVudERhdGEpO1xuICBpZiAoYWxyZWFkeUZpbmFsaXplZCkgcmV0dXJuIHsgc3RhdHVzOiBcImNvbmZpcm1lZFwiLCBpZGVtcG90ZW50OiB0cnVlLCB0eF9oYXNoOiB0eEhhc2ggfTtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IGRhdGEsIGVycm9yIH0gPSBhd2FpdCBhZG1pbi5ycGMoXCJmaW5hbGl6ZV9wMnBfZXNjcm93X2NhbmNlbFwiLCB7IHBfdXNlcl9pZDogcHJvZmlsZS5pZCwgcF9ldmVudDogZXZlbnREYXRhIH0pO1xuICAgIGlmIChlcnJvcikgdGhyb3cgbmV3IEVycm9yKGVycm9yLm1lc3NhZ2UpO1xuICAgIGF3YWl0IGZpbmlzaEVzY3Jvd0V2ZW50KGFkbWluLCB0eEhhc2gpO1xuICAgIHJldHVybiB7IHN0YXR1czogXCJjb25maXJtZWRcIiwgdHhfaGFzaDogdHhIYXNoLCBvcmRlcjogZGF0YSB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFwiXHU1M0Q2XHU2RDg4XHU1RTMzXHU2NzJDXHU1NDBDXHU2QjY1XHU1OTMxXHU2NTU3XCI7XG4gICAgYXdhaXQgZmluaXNoRXNjcm93RXZlbnQoYWRtaW4sIHR4SGFzaCwgbWVzc2FnZSk7XG4gICAgdGhyb3cgbmV3IEVycm9yKGAke21lc3NhZ2V9XHVGRjFCXHU5M0M4XHU0RTBBXHU4Q0M3XHU3NTIyXHU1REYyXHU5MDAwXHU1NkRFXHVGRjBDXHU1M0VGXHU3NTMxXHU3QkExXHU3NDA2XHU1NEUxXHU5MUNEXHU4QTY2XHU1NDBDXHU2QjY1XHVGRjA4JHt0eEhhc2h9XHVGRjA5YCk7XG4gIH1cbn1cblxuLy8gcHJpdmF0ZV9wbGFjZW1lbnRzLnRva2VuX2FkZHJlc3MgXHU2NjJGXHU5MDc4XHU1ODZCXHU2QjA0XHU0RjREXHVGRjA4UldBIEZhY3RvcnkgXHU5MDc3XHU3OUZCXHU2NzFGXHU5NTkzXHU1MTQxXHU4QTMxXG4vLyBudWxsXHVGRjA5XHUzMDAyXHU2ODNDXHU1RjBGXHU5MzJGXHU4QUE0XHU2MjE2XHU2NzJBXHU1ODZCXHU2NjQyXHU1NkRFXHU1MEIzIHVuZGVmaW5lZFx1RkYwQ1x1OEI5M1x1NTQ3Q1x1NTNFQlx1N0FFRlx1NUI4OVx1NTE2OFx1NTczMFx1OTAwMFx1NTZERVx1ODIwQVx1NTQwOFx1N0QwNFx1OERFRlx1NUY5MVx1RkYwQ1xuLy8gXHU4MDBDXHU0RTBEXHU2NjJGXHU4QjkzXHU2NTc0XHU1MDBCXHU3RDUwXHU3Qjk3XHU1NkUwXHU3MEJBXHU0RTAwXHU1MDBCXHU5MDc4XHU1ODZCXHU2QjA0XHU0RjREXHU1OERFXHU2Mzg5XHU4MDBDXHU1OTMxXHU2NTU3XHUzMDAyXG5mdW5jdGlvbiB0b0ZhY3RvcnlUb2tlbkFkZHJlc3ModmFsdWU6IHVua25vd24pOiBBZGRyZXNzIHwgdW5kZWZpbmVkIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIiB8fCAhdmFsdWUudHJpbSgpKSByZXR1cm4gdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIGNvbnN0IGFkZHIgPSBnZXRBZGRyZXNzKHZhbHVlLnRyaW0oKSk7XG4gICAgLy8gXHU5NkY2XHU1NzMwXHU1NzQwXHU0RUUzXHU4ODY4XHUzMDBDXHU1QzFBXHU2NzJBXHU1RUZBXHU3QUNCXHU1QzA4XHU1QzZDXHU0RUUzXHU1RTYzXHUzMDBEXHVGRjA4XHU2NzA5XHU2NjQyIERCIFx1NjcwM1x1NUI1OFx1NjIxMCBudWxsIFx1ODAwQ1x1OTc1RSBudWxsXHVGRjA5XHVGRjBDXG4gICAgLy8gXHU0RTAwXHU1RjhCXHU4OTk2XHU3MEJBXHU2NzJBXHU1RUZBXHU3QUNCXHVGRjBDXHU5MDdGXHU1MTREXHU2MjhBXHU5NkY2XHU1NzMwXHU1NzQwXHU3NTc2XHU2MjEwXHU2NzA5XHU2NTQ4XHU0RUUzXHU1RTYzXHU2MkZGXHU1M0JCXHU3RDUwXHU3Qjk3XHU2MjE2XHU4QUE0XHU1MjI0XHUzMDBDXHU1REYyXHU1RUZBXHU3QUNCXHUzMDBEXHUzMDAyXG4gICAgaWYgKGFkZHIgPT09IFwiMHgwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwXCIpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgcmV0dXJuIGFkZHI7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbn1cblxuY29uc3QgTEVHQUNZX1JFQ0xBSU1fQ1VUT0ZGID0gXCIyMDI2LTEwLTA0VDAwOjAwOjAwKzA4OjAwXCI7XG5jb25zdCBMRUdBQ1lfUkVDTEFJTV9FTlRSWV9UWVBFUyA9IFtcInByaXZhdGVfcHVyY2hhc2VcIiwgXCJwMnBfYnV5XCIsIFwicDJwX3NlbGxcIl0gYXMgY29uc3Q7XG5jb25zdCBMRURHRVJfU0NBTEUgPSAxODtcbmNvbnN0IEFFX0xFR0FDWV9BU1NFVF9LRVkgPSBcImxlZ2FjeS1hZVwiO1xuXG50eXBlIExlZ2FjeVJlY2xhaW1DYW5kaWRhdGUgPSB7XG4gIGFzc2V0S2V5OiBzdHJpbmc7XG4gIGxhYmVsOiBzdHJpbmc7XG4gIGtpbmQ6IFwiYWVcIiB8IFwicndhXCI7XG4gIHRva2VuQWRkcmVzczogQWRkcmVzcyB8IG51bGw7XG4gIGRlY2ltYWxzOiBudW1iZXIgfCBudWxsO1xuICBsZWdhY3lOZXQ6IHN0cmluZztcbiAgdG9kYXlSZXNlcnZlZDogc3RyaW5nO1xuICBjaGFpbkJhbGFuY2U6IHN0cmluZztcbiAgcmVjbGFpbWVkOiBzdHJpbmc7XG4gIGFtb3VudDogc3RyaW5nO1xuICBzdGF0dXM6IFwicmVhZHlcIiB8IFwibm8tdG9rZW5cIiB8IFwiY2hhaW4tZXJyb3JcIiB8IFwicGVuZGluZ1wiIHwgXCJjb21wbGV0ZVwiIHwgXCJuby1iYWxhbmNlXCI7XG4gIHR4SGFzaDogc3RyaW5nIHwgbnVsbDtcbn07XG5cbmZ1bmN0aW9uIGxlZGdlckFtb3VudFVuaXRzKHZhbHVlOiB1bmtub3duKTogYmlnaW50IHtcbiAgcmV0dXJuIHBhcnNlVW5pdHMoU3RyaW5nKHZhbHVlID8/IFwiMFwiKSwgTEVER0VSX1NDQUxFKTtcbn1cblxuZnVuY3Rpb24gbGVkZ2VyVW5pdHNUb1Rva2VuVW5pdHModmFsdWU6IGJpZ2ludCwgZGVjaW1hbHM6IG51bWJlcik6IGJpZ2ludCB7XG4gIGlmIChkZWNpbWFscyA+PSBMRURHRVJfU0NBTEUpIHJldHVybiB2YWx1ZSAqIDEwbiAqKiBCaWdJbnQoZGVjaW1hbHMgLSBMRURHRVJfU0NBTEUpO1xuICByZXR1cm4gdmFsdWUgLyAxMG4gKiogQmlnSW50KExFREdFUl9TQ0FMRSAtIGRlY2ltYWxzKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVhZExlZ2FjeVJlY2xhaW1DYW5kaWRhdGVzKFxuICBhZG1pbjogU3VwYWJhc2VDbGllbnQsXG4gIHVzZXJJZDogc3RyaW5nLFxuICB3YWxsZXQ6IEFkZHJlc3MsXG4pOiBQcm9taXNlPExlZ2FjeVJlY2xhaW1DYW5kaWRhdGVbXT4ge1xuICBjb25zdCBsZWRnZXJSb3dzOiBBcnJheTx7IGFzc2V0X2lkOiBzdHJpbmcgfCBudWxsOyBxdWFudGl0eTogc3RyaW5nIHwgbnVtYmVyOyBjcmVhdGVkX2F0OiBzdHJpbmcgfT4gPSBbXTtcbiAgY29uc3QgcGFnZVNpemUgPSA1MDA7XG4gIGZvciAobGV0IG9mZnNldCA9IDA7IDsgb2Zmc2V0ICs9IHBhZ2VTaXplKSB7XG4gICAgY29uc3QgeyBkYXRhLCBlcnJvciB9ID0gYXdhaXQgYWRtaW5cbiAgICAgIC5mcm9tKFwiamNfbGVkZ2VyXCIpXG4gICAgICAuc2VsZWN0KFwiYXNzZXRfaWQscXVhbnRpdHksY3JlYXRlZF9hdFwiKVxuICAgICAgLmVxKFwidXNlcl9pZFwiLCB1c2VySWQpXG4gICAgICAuaW4oXCJlbnRyeV90eXBlXCIsIFsuLi5MRUdBQ1lfUkVDTEFJTV9FTlRSWV9UWVBFU10pXG4gICAgICAubm90KFwiYXNzZXRfaWRcIiwgXCJpc1wiLCBudWxsKVxuICAgICAgLm9yZGVyKFwiY3JlYXRlZF9hdFwiLCB7IGFzY2VuZGluZzogdHJ1ZSB9KVxuICAgICAgLnJhbmdlKG9mZnNldCwgb2Zmc2V0ICsgcGFnZVNpemUgLSAxKTtcbiAgICBpZiAoZXJyb3IpIHRocm93IG5ldyBFcnJvcihgXHU4QjgwXHU1M0Q2XHU2Qjc3XHU1M0YyXHU4Q0M3XHU3NTIyXHU1RTMzXHU2NzJDXHU1OTMxXHU2NTU3XHVGRjFBJHtlcnJvci5tZXNzYWdlfWApO1xuICAgIGNvbnN0IHBhZ2UgPSAoZGF0YSA/PyBbXSkgYXMgQXJyYXk8eyBhc3NldF9pZDogc3RyaW5nIHwgbnVsbDsgcXVhbnRpdHk6IHN0cmluZyB8IG51bWJlcjsgY3JlYXRlZF9hdDogc3RyaW5nIH0+O1xuICAgIGxlZGdlclJvd3MucHVzaCguLi5wYWdlKTtcbiAgICBpZiAocGFnZS5sZW5ndGggPCBwYWdlU2l6ZSkgYnJlYWs7XG4gIH1cblxuICBjb25zdCB7IGRhdGE6IHBheW91dFJvd3MsIGVycm9yOiBwYXlvdXRFcnJvciB9ID0gYXdhaXQgYWRtaW5cbiAgICAuZnJvbShcIm9uY2hhaW5fc2V0dGxlbWVudHNcIilcbiAgICAuc2VsZWN0KFwiYXNzZXRfaWQsYW1vdW50LHBheWxvYWQsY3JlYXRlZF9hdCxzdGF0dXNcIilcbiAgICAuZXEoXCJhY3Rpb25cIiwgXCJhZG1pbl9wYXlvdXRcIilcbiAgICAuaW4oXCJzdGF0dXNcIiwgW1wiY29uZmlybWVkXCIsIFwicGVuZGluZ1wiXSlcbiAgICAuZXEoXCJ1c2VyX2lkXCIsIHVzZXJJZCk7XG4gIGlmIChwYXlvdXRFcnJvcikgdGhyb3cgbmV3IEVycm9yKGBcdThCODBcdTUzRDZcdTRFQ0FcdTY1RTVcdThDQzdcdTc1MjJcdTc2N0NcdTY1M0VcdTdEMDBcdTkzMDRcdTU5MzFcdTY1NTdcdUZGMUEke3BheW91dEVycm9yLm1lc3NhZ2V9YCk7XG5cbiAgY29uc3QgcG9zaXRpb25Ub3RhbHMgPSBuZXcgTWFwPHN0cmluZywgeyBsZWdhY3k6IGJpZ2ludDsgdG9kYXk6IGJpZ2ludCB9PigpO1xuICBjb25zdCBjdXRvZmYgPSBuZXcgRGF0ZShMRUdBQ1lfUkVDTEFJTV9DVVRPRkYpLmdldFRpbWUoKTtcbiAgZm9yIChjb25zdCByb3cgb2YgbGVkZ2VyUm93cykge1xuICAgIGlmICghcm93LmFzc2V0X2lkKSBjb250aW51ZTtcbiAgICBjb25zdCB0b3RhbHMgPSBwb3NpdGlvblRvdGFscy5nZXQocm93LmFzc2V0X2lkKSA/PyB7IGxlZ2FjeTogMG4sIHRvZGF5OiAwbiB9O1xuICAgIGNvbnN0IGFtb3VudCA9IGxlZGdlckFtb3VudFVuaXRzKHJvdy5xdWFudGl0eSk7XG4gICAgaWYgKG5ldyBEYXRlKHJvdy5jcmVhdGVkX2F0KS5nZXRUaW1lKCkgPCBjdXRvZmYpIHRvdGFscy5sZWdhY3kgKz0gYW1vdW50O1xuICAgIGVsc2UgdG90YWxzLnRvZGF5ICs9IGFtb3VudDtcbiAgICBwb3NpdGlvblRvdGFscy5zZXQocm93LmFzc2V0X2lkLCB0b3RhbHMpO1xuICB9XG4gIGZvciAoY29uc3Qgcm93IG9mIHBheW91dFJvd3MgPz8gW10pIHtcbiAgICBpZiAoIXJvdy5hc3NldF9pZCkgY29udGludWU7XG4gICAgY29uc3QgcGF5bG9hZCA9IHJvdy5wYXlsb2FkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGlmIChwYXlsb2FkLmFzc2V0VHlwZSAhPT0gXCJhZVwiICYmIHBheWxvYWQuYXNzZXRUeXBlICE9PSBcInJ3YVwiKSBjb250aW51ZTtcbiAgICBjb25zdCB0b3RhbHMgPSBwb3NpdGlvblRvdGFscy5nZXQocm93LmFzc2V0X2lkKSA/PyB7IGxlZ2FjeTogMG4sIHRvZGF5OiAwbiB9O1xuICAgIGNvbnN0IGFtb3VudCA9IGxlZGdlckFtb3VudFVuaXRzKHJvdy5hbW91bnQgPz8gcGF5bG9hZC5hbW91bnQpO1xuICAgIGlmIChuZXcgRGF0ZShyb3cuY3JlYXRlZF9hdCkuZ2V0VGltZSgpIDwgY3V0b2ZmKSB7XG4gICAgICBpZiAocm93LnN0YXR1cyA9PT0gXCJjb25maXJtZWRcIikgdG90YWxzLmxlZ2FjeSArPSBhbW91bnQ7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIFx1NEVDQVx1NjVFNSBwZW5kaW5nIFx1NkQzRVx1NzY3Q1x1NTNFRlx1ODBGRFx1NURGMlx1OTAwMVx1NTFGQVx1NEY0Nlx1NUMxQVx1NjcyQVx1NzhCQVx1OEE4RFx1RkYxQlx1NTE0OFx1NEZERFx1NzU1OVx1OTg0RFx1NUVBNlx1RkYwQ1x1OTA3Rlx1NTE0RFx1NTZERVx1NjUzNlx1NjM4OVx1NEVDQVx1NjVFNVx1NkQzRVx1NzY3Q1x1OENDN1x1NzUyMlx1MzAwMlxuICAgICAgdG90YWxzLnRvZGF5ICs9IGFtb3VudDtcbiAgICB9XG4gICAgcG9zaXRpb25Ub3RhbHMuc2V0KHJvdy5hc3NldF9pZCwgdG90YWxzKTtcbiAgfVxuXG4gIGNvbnN0IHBsYWNlbWVudElkcyA9IEFycmF5LmZyb20ocG9zaXRpb25Ub3RhbHMua2V5cygpKTtcbiAgY29uc3QgcGxhY2VtZW50czogQXJyYXk8eyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmcgfCBudWxsOyB0b2tlbl9hZGRyZXNzOiBzdHJpbmcgfCBudWxsOyBpc19hZV90b2tlbjogYm9vbGVhbiB8IG51bGwgfT4gPSBbXTtcbiAgZm9yIChsZXQgb2Zmc2V0ID0gMDsgb2Zmc2V0IDwgcGxhY2VtZW50SWRzLmxlbmd0aDsgb2Zmc2V0ICs9IDEwMCkge1xuICAgIGNvbnN0IHsgZGF0YSwgZXJyb3IgfSA9IGF3YWl0IGFkbWluXG4gICAgICAuZnJvbShcInByaXZhdGVfcGxhY2VtZW50c1wiKVxuICAgICAgLnNlbGVjdChcImlkLG5hbWUsdG9rZW5fYWRkcmVzcyxpc19hZV90b2tlblwiKVxuICAgICAgLmluKFwiaWRcIiwgcGxhY2VtZW50SWRzLnNsaWNlKG9mZnNldCwgb2Zmc2V0ICsgMTAwKSk7XG4gICAgaWYgKGVycm9yKSB0aHJvdyBuZXcgRXJyb3IoYFx1OEI4MFx1NTNENlx1OENDN1x1NzUyMlx1NTQwOFx1N0QwNFx1OENDN1x1NjU5OVx1NTkzMVx1NjU1N1x1RkYxQSR7ZXJyb3IubWVzc2FnZX1gKTtcbiAgICBwbGFjZW1lbnRzLnB1c2goLi4uKChkYXRhID8/IFtdKSBhcyB0eXBlb2YgcGxhY2VtZW50cykpO1xuICB9XG4gIGNvbnN0IHBsYWNlbWVudEJ5SWQgPSBuZXcgTWFwKHBsYWNlbWVudHMubWFwKChwbGFjZW1lbnQpID0+IFtwbGFjZW1lbnQuaWQsIHBsYWNlbWVudF0pKTtcblxuICBjb25zdCBncm91cGVkID0gbmV3IE1hcDxzdHJpbmcsIHtcbiAgICBhc3NldEtleTogc3RyaW5nO1xuICAgIGxhYmVsOiBzdHJpbmc7XG4gICAga2luZDogXCJhZVwiIHwgXCJyd2FcIjtcbiAgICB0b2tlbkFkZHJlc3M6IEFkZHJlc3MgfCBudWxsO1xuICAgIGxlZ2FjeTogYmlnaW50O1xuICAgIHRvZGF5OiBiaWdpbnQ7XG4gIH0+KCk7XG4gIGZvciAoY29uc3QgW2Fzc2V0SWQsIHRvdGFsc10gb2YgcG9zaXRpb25Ub3RhbHMpIHtcbiAgICBjb25zdCBwbGFjZW1lbnQgPSBwbGFjZW1lbnRCeUlkLmdldChhc3NldElkKTtcbiAgICBjb25zdCBpc0FlID0gcGxhY2VtZW50Py5pc19hZV90b2tlbiA9PT0gdHJ1ZTtcbiAgICBjb25zdCB0b2tlbkFkZHJlc3MgPSBpc0FlXG4gICAgICA/IFJFTEFZRVJfQUREUkVTU0VTLmFlVG9rZW5cbiAgICAgIDogdG9GYWN0b3J5VG9rZW5BZGRyZXNzKHBsYWNlbWVudD8udG9rZW5fYWRkcmVzcykgPz8gbnVsbDtcbiAgICBjb25zdCBhc3NldEtleSA9IGlzQWVcbiAgICAgID8gQUVfTEVHQUNZX0FTU0VUX0tFWVxuICAgICAgOiB0b2tlbkFkZHJlc3NcbiAgICAgICAgPyBgbGVnYWN5LXJ3YToke3Rva2VuQWRkcmVzcy50b0xvd2VyQ2FzZSgpfWBcbiAgICAgICAgOiBgbGVnYWN5LXJ3YS1wbGFjZW1lbnQ6JHthc3NldElkfWA7XG4gICAgY29uc3QgY3VycmVudCA9IGdyb3VwZWQuZ2V0KGFzc2V0S2V5KSA/PyB7XG4gICAgICBhc3NldEtleSxcbiAgICAgIGxhYmVsOiBpc0FlID8gXCJBRSBcdTRFRTNcdTVFNjNcIiA6IHBsYWNlbWVudD8ubmFtZSB8fCBhc3NldElkLFxuICAgICAga2luZDogaXNBZSA/IFwiYWVcIiA6IFwicndhXCIsXG4gICAgICB0b2tlbkFkZHJlc3MsXG4gICAgICBsZWdhY3k6IDBuLFxuICAgICAgdG9kYXk6IDBuLFxuICAgIH07XG4gICAgY3VycmVudC5sZWdhY3kgKz0gdG90YWxzLmxlZ2FjeTtcbiAgICBjdXJyZW50LnRvZGF5ICs9IHRvdGFscy50b2RheTtcbiAgICBncm91cGVkLnNldChhc3NldEtleSwgY3VycmVudCk7XG4gIH1cblxuICBjb25zdCB7IGRhdGE6IHNldHRsZW1lbnRSb3dzLCBlcnJvcjogc2V0dGxlbWVudEVycm9yIH0gPSBhd2FpdCBhZG1pblxuICAgIC5mcm9tKFwib25jaGFpbl9zZXR0bGVtZW50c1wiKVxuICAgIC5zZWxlY3QoXCJhc3NldF9pZCxhbW91bnQsc3RhdHVzLHR4X2hhc2hcIilcbiAgICAuZXEoXCJhY3Rpb25cIiwgXCJhZV9yZWNsYWltX2xlZ2FjeVwiKVxuICAgIC5lcShcInVzZXJfaWRcIiwgdXNlcklkKTtcbiAgaWYgKHNldHRsZW1lbnRFcnJvcikgdGhyb3cgbmV3IEVycm9yKGBcdThCODBcdTUzRDZcdTU2REVcdTY1MzZcdTdEMDBcdTkzMDRcdTU5MzFcdTY1NTdcdUZGMUEke3NldHRsZW1lbnRFcnJvci5tZXNzYWdlfWApO1xuICBjb25zdCBzZXR0bGVtZW50c0J5QXNzZXQgPSBuZXcgTWFwPHN0cmluZywgQXJyYXk8eyBhc3NldF9pZDogc3RyaW5nIHwgbnVsbDsgYW1vdW50OiBzdHJpbmcgfCBudW1iZXIgfCBudWxsOyBzdGF0dXM6IHN0cmluZzsgdHhfaGFzaDogc3RyaW5nIHwgbnVsbCB9Pj4oKTtcbiAgZm9yIChjb25zdCByb3cgb2YgKHNldHRsZW1lbnRSb3dzID8/IFtdKSBhcyBBcnJheTx7IGFzc2V0X2lkOiBzdHJpbmcgfCBudWxsOyBhbW91bnQ6IHN0cmluZyB8IG51bWJlciB8IG51bGw7IHN0YXR1czogc3RyaW5nOyB0eF9oYXNoOiBzdHJpbmcgfCBudWxsIH0+KSB7XG4gICAgY29uc3Qga2V5ID0gU3RyaW5nKHJvdy5hc3NldF9pZCA/PyBcIlwiKTtcbiAgICBzZXR0bGVtZW50c0J5QXNzZXQuc2V0KGtleSwgWy4uLihzZXR0bGVtZW50c0J5QXNzZXQuZ2V0KGtleSkgPz8gW10pLCByb3ddKTtcbiAgfVxuXG4gIHJldHVybiBQcm9taXNlLmFsbChBcnJheS5mcm9tKGdyb3VwZWQudmFsdWVzKCkpLm1hcChhc3luYyAoZ3JvdXApOiBQcm9taXNlPExlZ2FjeVJlY2xhaW1DYW5kaWRhdGUgfCBudWxsPiA9PiB7XG4gICAgaWYgKGdyb3VwLmxlZ2FjeSA8PSAwbikgcmV0dXJuIG51bGw7XG4gICAgY29uc3Qgc2V0dGxlbWVudHMgPSBzZXR0bGVtZW50c0J5QXNzZXQuZ2V0KGdyb3VwLmFzc2V0S2V5KSA/PyBbXTtcbiAgICBjb25zdCBjb25maXJtZWQgPSBzZXR0bGVtZW50cy5maWx0ZXIoKHJvdykgPT4gcm93LnN0YXR1cyA9PT0gXCJjb25maXJtZWRcIik7XG4gICAgY29uc3QgcGVuZGluZyA9IHNldHRsZW1lbnRzLmZpbmQoKHJvdykgPT4gcm93LnN0YXR1cyA9PT0gXCJwZW5kaW5nXCIpO1xuICAgIGNvbnN0IHR4SGFzaCA9IHBlbmRpbmc/LnR4X2hhc2ggPz8gY29uZmlybWVkW2NvbmZpcm1lZC5sZW5ndGggLSAxXT8udHhfaGFzaCA/PyBudWxsO1xuICAgIGlmICghZ3JvdXAudG9rZW5BZGRyZXNzKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhc3NldEtleTogZ3JvdXAuYXNzZXRLZXksIGxhYmVsOiBncm91cC5sYWJlbCwga2luZDogZ3JvdXAua2luZCwgdG9rZW5BZGRyZXNzOiBudWxsLFxuICAgICAgICBkZWNpbWFsczogbnVsbCwgbGVnYWN5TmV0OiBmb3JtYXRVbml0cyhncm91cC5sZWdhY3ksIExFREdFUl9TQ0FMRSksIHRvZGF5UmVzZXJ2ZWQ6IFwiMFwiLFxuICAgICAgICBjaGFpbkJhbGFuY2U6IFwiMFwiLCByZWNsYWltZWQ6IFwiMFwiLCBhbW91bnQ6IFwiMFwiLCBzdGF0dXM6IFwibm8tdG9rZW5cIiwgdHhIYXNoLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgY2hhaW4gPSBhd2FpdCBnZXRMZWdhY3lBc3NldENoYWluU3RhdGUoZ3JvdXAudG9rZW5BZGRyZXNzLCB3YWxsZXQpO1xuICAgICAgY29uc3QgZGVjaW1hbHMgPSBjaGFpbi5kZWNpbWFscztcbiAgICAgIGNvbnN0IG9sZFVuaXRzID0gbGVkZ2VyVW5pdHNUb1Rva2VuVW5pdHMoZ3JvdXAubGVnYWN5LCBkZWNpbWFscyk7XG4gICAgICBjb25zdCB0b2RheVVuaXRzID0gbGVkZ2VyVW5pdHNUb1Rva2VuVW5pdHMoZ3JvdXAudG9kYXkgPiAwbiA/IGdyb3VwLnRvZGF5IDogMG4sIGRlY2ltYWxzKTtcbiAgICAgIGNvbnN0IHJlY2xhaW1lZFVuaXRzID0gY29uZmlybWVkLnJlZHVjZSgoc3VtLCByb3cpID0+IHtcbiAgICAgICAgaWYgKCFyb3cuYW1vdW50KSByZXR1cm4gc3VtO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJldHVybiBzdW0gKyBwYXJzZVVuaXRzKFN0cmluZyhyb3cuYW1vdW50KSwgZGVjaW1hbHMpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICByZXR1cm4gc3VtO1xuICAgICAgICB9XG4gICAgICB9LCAwbik7XG4gICAgICBjb25zdCBvbGRSZW1haW5pbmcgPSBvbGRVbml0cyA+IHJlY2xhaW1lZFVuaXRzID8gb2xkVW5pdHMgLSByZWNsYWltZWRVbml0cyA6IDBuO1xuICAgICAgY29uc3QgYmFsYW5jZVVuaXRzID0gcGFyc2VVbml0cyhjaGFpbi5iYWxhbmNlLCBkZWNpbWFscyk7XG4gICAgICBjb25zdCBhdmFpbGFibGVVbml0cyA9IGJhbGFuY2VVbml0cyA+IHRvZGF5VW5pdHMgPyBiYWxhbmNlVW5pdHMgLSB0b2RheVVuaXRzIDogMG47XG4gICAgICBjb25zdCByZWNsYWltVW5pdHMgPSBvbGRSZW1haW5pbmcgPCBhdmFpbGFibGVVbml0cyA/IG9sZFJlbWFpbmluZyA6IGF2YWlsYWJsZVVuaXRzO1xuICAgICAgY29uc3Qgc3RhdHVzOiBMZWdhY3lSZWNsYWltQ2FuZGlkYXRlW1wic3RhdHVzXCJdID0gcGVuZGluZ1xuICAgICAgICA/IFwicGVuZGluZ1wiXG4gICAgICAgIDogb2xkUmVtYWluaW5nID09PSAwbiAmJiByZWNsYWltZWRVbml0cyA+IDBuXG4gICAgICAgICAgPyBcImNvbXBsZXRlXCJcbiAgICAgICAgICA6IHJlY2xhaW1Vbml0cyA+IDBuXG4gICAgICAgICAgICA/IFwicmVhZHlcIlxuICAgICAgICAgICAgOiBcIm5vLWJhbGFuY2VcIjtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFzc2V0S2V5OiBncm91cC5hc3NldEtleSxcbiAgICAgICAgbGFiZWw6IGdyb3VwLmxhYmVsLFxuICAgICAgICBraW5kOiBncm91cC5raW5kLFxuICAgICAgICB0b2tlbkFkZHJlc3M6IGdyb3VwLnRva2VuQWRkcmVzcyxcbiAgICAgICAgZGVjaW1hbHMsXG4gICAgICAgIGxlZ2FjeU5ldDogZm9ybWF0VW5pdHMob2xkVW5pdHMsIGRlY2ltYWxzKSxcbiAgICAgICAgdG9kYXlSZXNlcnZlZDogZm9ybWF0VW5pdHModG9kYXlVbml0cywgZGVjaW1hbHMpLFxuICAgICAgICBjaGFpbkJhbGFuY2U6IGNoYWluLmJhbGFuY2UsXG4gICAgICAgIHJlY2xhaW1lZDogZm9ybWF0VW5pdHMocmVjbGFpbWVkVW5pdHMsIGRlY2ltYWxzKSxcbiAgICAgICAgYW1vdW50OiBzdGF0dXMgPT09IFwicmVhZHlcIiA/IGZvcm1hdFVuaXRzKHJlY2xhaW1Vbml0cywgZGVjaW1hbHMpIDogXCIwXCIsXG4gICAgICAgIHN0YXR1cyxcbiAgICAgICAgdHhIYXNoLFxuICAgICAgfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFzc2V0S2V5OiBncm91cC5hc3NldEtleSwgbGFiZWw6IGdyb3VwLmxhYmVsLCBraW5kOiBncm91cC5raW5kLCB0b2tlbkFkZHJlc3M6IGdyb3VwLnRva2VuQWRkcmVzcyxcbiAgICAgICAgZGVjaW1hbHM6IG51bGwsIGxlZ2FjeU5ldDogZm9ybWF0VW5pdHMoZ3JvdXAubGVnYWN5LCBMRURHRVJfU0NBTEUpLCB0b2RheVJlc2VydmVkOiBcIjBcIixcbiAgICAgICAgY2hhaW5CYWxhbmNlOiBcIjBcIiwgcmVjbGFpbWVkOiBcIjBcIiwgYW1vdW50OiBcIjBcIiwgc3RhdHVzOiBcImNoYWluLWVycm9yXCIsIHR4SGFzaCxcbiAgICAgIH07XG4gICAgfVxuICB9KSkudGhlbigocm93cykgPT4gcm93cy5maWx0ZXIoKHJvdyk6IHJvdyBpcyBMZWdhY3lSZWNsYWltQ2FuZGlkYXRlID0+IHJvdyAhPSBudWxsKSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlY29uY2lsZUxlZ2FjeVJlY2xhaW1SZWNlaXB0cyhhZG1pbjogU3VwYWJhc2VDbGllbnQsIHVzZXJJZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHsgZGF0YSwgZXJyb3IgfSA9IGF3YWl0IGFkbWluXG4gICAgLmZyb20oXCJvbmNoYWluX3NldHRsZW1lbnRzXCIpXG4gICAgLnNlbGVjdChcImlkLHR4X2hhc2gsdXBkYXRlZF9hdFwiKVxuICAgIC5lcShcImFjdGlvblwiLCBcImFlX3JlY2xhaW1fbGVnYWN5XCIpXG4gICAgLmVxKFwidXNlcl9pZFwiLCB1c2VySWQpXG4gICAgLmVxKFwic3RhdHVzXCIsIFwicGVuZGluZ1wiKVxuICAgIC5saW1pdCgyMDApO1xuICBpZiAoZXJyb3IpIHRocm93IG5ldyBFcnJvcihgXHU1NDBDXHU2QjY1XHU1NkRFXHU2NTM2XHU0RUE0XHU2NjEzXHU3MkMwXHU2MTRCXHU1OTMxXHU2NTU3XHVGRjFBJHtlcnJvci5tZXNzYWdlfWApO1xuXG4gIGNvbnN0IHN0YWxlQmVmb3JlID0gRGF0ZS5ub3coKSAtIDUgKiA2MF8wMDA7XG4gIGF3YWl0IFByb21pc2UuYWxsKChkYXRhID8/IFtdKS5tYXAoYXN5bmMgKHJvdykgPT4ge1xuICAgIGxldCBuZXh0U3RhdHVzOiBcImNvbmZpcm1lZFwiIHwgXCJmYWlsZWRcIiB8IFwicGVuZGluZ1wiID0gXCJwZW5kaW5nXCI7XG4gICAgbGV0IHN0YXR1c0Vycm9yOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBpZiAocm93LnR4X2hhc2gpIHtcbiAgICAgIG5leHRTdGF0dXMgPSBhd2FpdCBnZXRBZG1pbkFzc2V0UmVjbGFpbVJlY2VpcHRTdGF0dXMocm93LnR4X2hhc2ggYXMgYDB4JHtzdHJpbmd9YCk7XG4gICAgICBpZiAobmV4dFN0YXR1cyA9PT0gXCJmYWlsZWRcIikgc3RhdHVzRXJyb3IgPSBcIlx1OTNDOFx1NEUwQVx1NTZERVx1NjUzNlx1NEVBNFx1NjYxM1x1NURGMiByZXZlcnRcIjtcbiAgICB9IGVsc2UgaWYgKG5ldyBEYXRlKHJvdy51cGRhdGVkX2F0KS5nZXRUaW1lKCkgPCBzdGFsZUJlZm9yZSkge1xuICAgICAgbmV4dFN0YXR1cyA9IFwiZmFpbGVkXCI7XG4gICAgICBzdGF0dXNFcnJvciA9IFwiXHU1NkRFXHU2NTM2XHU4QUNCXHU2QzQyXHU5MDNFXHU2NjQyXHU0RTE0XHU2NzJBXHU5MDAxXHU1MUZBXHU5M0M4XHU0RTBBXHU0RUE0XHU2NjEzXHVGRjBDXHU1M0VGXHU1Qjg5XHU1MTY4XHU5MUNEXHU4QTY2XCI7XG4gICAgfVxuICAgIGlmIChuZXh0U3RhdHVzID09PSBcInBlbmRpbmdcIikgcmV0dXJuO1xuICAgIGNvbnN0IHsgZXJyb3I6IHVwZGF0ZUVycm9yIH0gPSBhd2FpdCBhZG1pblxuICAgICAgLmZyb20oXCJvbmNoYWluX3NldHRsZW1lbnRzXCIpXG4gICAgICAudXBkYXRlKHsgc3RhdHVzOiBuZXh0U3RhdHVzLCBlcnJvcjogc3RhdHVzRXJyb3IsIHVwZGF0ZWRfYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9KVxuICAgICAgLmVxKFwiaWRcIiwgcm93LmlkKVxuICAgICAgLmVxKFwidXNlcl9pZFwiLCB1c2VySWQpXG4gICAgICAuZXEoXCJzdGF0dXNcIiwgXCJwZW5kaW5nXCIpO1xuICAgIGlmICh1cGRhdGVFcnJvcikgdGhyb3cgbmV3IEVycm9yKGBcdTY2RjRcdTY1QjBcdTU2REVcdTY1MzZcdTRFQTRcdTY2MTNcdTcyQzBcdTYxNEJcdTU5MzFcdTY1NTdcdUZGMUEke3VwZGF0ZUVycm9yLm1lc3NhZ2V9YCk7XG4gIH0pKTtcbn1cblxuLy8gXHU5NjMyXHU1NDQ2XHU5NjMyXHU4Qjc3XHVGRjFBXHU1NzI4XHU0RUZCXHU0RjU1XHU5M0M4XHU0RTBBXHU0RUE0XHU2NjEzXHVGRjA4XHU3NjdDXHU1RTYzIC8gXHU4QThEXHU4Q0ZDXHU3RDUwXHU3Qjk3IC8gXHU2MjEwXHU0RUE0XHU3RDUwXHU3Qjk3XHVGRjA5XHU3NzFGXHU2QjYzXHU5MDAxXHU1MUZBXHU0RTRCXHU1MjREXHVGRjBDXHU1MTQ4XHU3OEJBXHU4QThEXG4vLyBBRE1JTiBcdTcxQjFcdTkzMjJcdTUzMDVcdTkwODRcdTY3MDlcdThEQjNcdTU5MjAgRVRIIFx1NEVEOFx1NzkyNlx1NURFNVx1OENCQlx1MzAwMlx1NTIzQlx1NjEwRlx1NjUzRVx1NTcyOFx1NUVGQVx1N0FDQiBvbmNoYWluX3NldHRsZW1lbnRzIHBlbmRpbmdcbi8vIFx1NTIxN1x1NEU0Qlx1NTI0RFx1NkFBMlx1NjdFNVx1RkYwQ1x1NTkzMVx1NjU1N1x1NjY0Mlx1NEUwRFx1NkQ4OFx1ODAxN1x1OTBBM1x1N0I0NiByZWZfa2V5XHVGRjBDXHU4QjkzXHU3QkExXHU3NDA2XHU1NEUxXHU1MTMyXHU1MDNDXHU1RjhDXHU1M0VGXHU0RUU1XHU3NkY0XHU2M0E1XHU5MUNEXHU4QTY2XHUzMDAyXG5hc3luYyBmdW5jdGlvbiBndWFyZFJlbGF5ZXJHYXMocmVzcG9uc2U6IFNlcnZlclJlc3BvbnNlKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHRyeSB7XG4gICAgYXdhaXQgZW5zdXJlUmVsYXllckdhcygpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIChlKSB7XG4gICAganNvbihyZXNwb25zZSwgNTAzLCB7IGVycm9yOiBlcnJNc2coZSkgfSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8vIFx1OTYzMlx1NTQ0Nlx1OTYzMlx1OEI3N1x1RkYxQVx1OEE4RFx1OENGQ1x1N0Q1MFx1N0I5N1x1NjYyRlx1MzAwQ1x1N0FEOVx1NTE2N1x1NUUzM1x1NjcyQ1x1NTE0OFx1NjI2M1x1NkIzRVx1MzAwMVx1OTNDOFx1NEUwQVx1NzY3Q1x1NUU2My9cdTdENTBcdTdCOTdcdTk2QThcdTVGOENcdThEREZcdTkwMzJcdTMwMERcdTc2ODRcdTkzRTFcdTUwQ0ZcdTZENDFcdTdBMEJcdUZGMENcbi8vIFx1NEUyRFx1OTU5M1x1NTNFRlx1ODBGRFx1NjcwOVx1NUVGNlx1OTA3Mlx1NjIxNlx1OTFDRFx1OEE2Nlx1MzAwMlx1OTAxOVx1ODhFMVx1NTcyOFx1NzcxRlx1NkI2M1x1NTQ3Q1x1NTNFQlx1NjY3QVx1NjE2N1x1NTQwOFx1N0QwNFx1NEU0Qlx1NTI0RFx1RkYwQ1x1OTFDRFx1NjVCMFx1OEI4MFx1NEUwMFx1NkIyMVx1OEE4RFx1OENGQ1x1NkExOVx1NzY4NFx1NzZFRVx1NTI0RFxuLy8gXHU3Njg0XHU3MkMwXHU2MTRCXHUyMDE0XHUyMDE0XHU1OTgyXHU2NzlDXHU2QTE5XHU3Njg0XHU1NzI4XHU0RjdGXHU3NTI4XHU4MDA1XHU0RTBCXHU1NUFFXHU0RTRCXHU1RjhDXHU4OEFCXHU3QkExXHU3NDA2XHU1NEUxXHU0RTBCXHU2N0I2XHU2MjE2XHU5NURDXHU5NTg5XHVGRjBDXHU1QzMxXHU1MTQ4XHU2NENCXHU0RTBCXHU5M0M4XHU0RTBBXHU3RDUwXHU3Qjk3XHVGRjBDXG4vLyBcdTgwMENcdTRFMERcdTY2MkZcdTcxNjdcdTZBMjNcdTYyOEEgSkMgXHU4RjQ5XHU5MDMyXHU5MUQxXHU1RUFCXHUzMDAxXHU2MjhBIEFFL1JXQSBcdTc2N0NcdTdENjZcdThDQjdcdTY1QjlcdTMwMDJcbmFzeW5jIGZ1bmN0aW9uIGd1YXJkUGxhY2VtZW50U3RpbGxTZXR0bGVhYmxlKFxuICBhZG1pbjogU3VwYWJhc2VDbGllbnQsXG4gIHJlc3BvbnNlOiBTZXJ2ZXJSZXNwb25zZSxcbiAgYXNzZXRJZDogc3RyaW5nLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IHsgZGF0YTogcGxhY2VtZW50IH0gPSBhd2FpdCBhZG1pblxuICAgIC5mcm9tKFwicHJpdmF0ZV9wbGFjZW1lbnRzXCIpXG4gICAgLnNlbGVjdChcImlkLGlzX2FjdGl2ZSxpc19kZWxpc3RlZFwiKVxuICAgIC5lcShcImlkXCIsIGFzc2V0SWQpXG4gICAgLm1heWJlU2luZ2xlKCk7XG4gIGlmICghcGxhY2VtZW50KSB7XG4gICAganNvbihyZXNwb25zZSwgNDA0LCB7IGVycm9yOiBcIlx1NjI3RVx1NEUwRFx1NTIzMFx1NUMwRFx1NjFDOVx1NzY4NFx1OEE4RFx1OENGQ1x1NkExOVx1NzY4NFwiIH0pO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBpZiAocGxhY2VtZW50LmlzX2RlbGlzdGVkKSB7XG4gICAganNvbihyZXNwb25zZSwgNDA5LCB7IGVycm9yOiBcIlx1NkI2NFx1NkExOVx1NzY4NFx1NURGMlx1NEUwQlx1NjdCNlx1RkYwQ1x1OTNDOFx1NEUwQVx1N0Q1MFx1N0I5N1x1NURGMlx1NjZBQlx1NTA1Q1x1RkYwQ1x1RkZGRFx1RkZGRFx1ODA2Rlx1N0U2Qlx1NUJBMlx1NjcwRFx1ODY1NVx1NzQwNlwiIH0pO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBpZiAocGxhY2VtZW50LmlzX2FjdGl2ZSA9PT0gZmFsc2UpIHtcbiAgICBqc29uKHJlc3BvbnNlLCA0MDksIHsgZXJyb3I6IFwiXHU2QjY0XHU2QTE5XHU3Njg0XHU3NkVFXHU1MjREXHU2NzJBXHU5NThCXHU2NTNFXHU4QThEXHU4Q0ZDXHVGRjBDXHU5M0M4XHU0RTBBXHU3RDUwXHU3Qjk3XHU1REYyXHU2NkFCXHU1MDVDXHVGRjBDXHU4QUNCXHU4MDZGXHU3RTZCXHU1QkEyXHU2NzBEXHU4NjU1XHU3NDA2XCIgfSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyBcdTUxQUFcdTdCNDlcdUZGMUFcdTgyRTVcdTU0MENcdTRFMDAgcmVmX2tleSBcdTVERjJcdTYyMTBcdTUyOUZcdTdENTBcdTdCOTdcdUZGMENcdTc2RjRcdTYzQTVcdTU2REVcdTUwQjNcdTY1RTJcdTY3MDkgdHhcdUZGMUJcdTgyRTVcdTRFQ0QgcGVuZGluZyBcdTg5OTZcdTcwQkFcdTkwMzJcdTg4NENcdTRFMkRcdTMwMDJcbi8vIFx1NTZERVx1NTBCMyBudWxsIFx1NEVFM1x1ODg2OFx1NjcyQ1x1NkIyMVx1NTNENlx1NUY5N1x1N0Q1MFx1N0I5N1x1NkIwQVx1RkYwQ1x1NTQ3Q1x1NTNFQlx1N0FFRlx1NjFDOVx1N0U3Q1x1N0U4Q1x1NTdGN1x1ODg0Q1x1OTNDOFx1NEUwQVx1NEVBNFx1NjYxM1x1MzAwMlxuYXN5bmMgZnVuY3Rpb24gY2xhaW1TZXR0bGVtZW50KFxuICBhZG1pbjogU3VwYWJhc2VDbGllbnQsXG4gIHJvdzoge1xuICAgIGFjdGlvbjogc3RyaW5nO1xuICAgIHJlZl9rZXk6IHN0cmluZztcbiAgICB1c2VyX2lkOiBzdHJpbmc7XG4gICAgY291bnRlcnBhcnR5X2lkPzogc3RyaW5nIHwgbnVsbDtcbiAgICBhc3NldF9pZD86IHN0cmluZyB8IG51bGw7XG4gICAgYW1vdW50PzogbnVtYmVyIHwgbnVsbDtcbiAgICBwYXltZW50PzogbnVtYmVyIHwgbnVsbDtcbiAgICBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgfSxcbik6IFByb21pc2U8eyBkb25lOiB7IHN0YXR1czogc3RyaW5nOyB0eF9oYXNoOiBzdHJpbmcgfCBudWxsIH0gfSB8IHsgaWQ6IHN0cmluZyB9ID4ge1xuICBjb25zdCBleGlzdGluZyA9IGF3YWl0IGFkbWluXG4gICAgLmZyb20oXCJvbmNoYWluX3NldHRsZW1lbnRzXCIpXG4gICAgLnNlbGVjdChcImlkLHN0YXR1cyx0eF9oYXNoXCIpXG4gICAgLmVxKFwicmVmX2tleVwiLCByb3cucmVmX2tleSlcbiAgICAubWF5YmVTaW5nbGUoKTtcbiAgaWYgKGV4aXN0aW5nLmVycm9yKSB0aHJvdyBuZXcgRXJyb3IoYFx1NjdFNVx1OEE2Mlx1N0Q1MFx1N0I5N1x1NTFBQVx1N0I0OVx1N0QwMFx1OTMwNFx1NTkzMVx1NjU1N1x1RkYxQSR7ZXhpc3RpbmcuZXJyb3IubWVzc2FnZX1gKTtcbiAgaWYgKGV4aXN0aW5nLmRhdGEpIHtcbiAgICBpZiAoZXhpc3RpbmcuZGF0YS5zdGF0dXMgPT09IFwiZmFpbGVkXCIpIHtcbiAgICAgIGNvbnN0IGNsYWltZWQgPSBhd2FpdCBhZG1pblxuICAgICAgICAuZnJvbShcIm9uY2hhaW5fc2V0dGxlbWVudHNcIilcbiAgICAgICAgLnVwZGF0ZSh7IHN0YXR1czogXCJwZW5kaW5nXCIsIGVycm9yOiBudWxsLCB1cGRhdGVkX2F0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkgfSlcbiAgICAgICAgLmVxKFwiaWRcIiwgZXhpc3RpbmcuZGF0YS5pZClcbiAgICAgICAgLmVxKFwic3RhdHVzXCIsIFwiZmFpbGVkXCIpXG4gICAgICAgIC5zZWxlY3QoXCJpZFwiKVxuICAgICAgICAubWF5YmVTaW5nbGUoKTtcbiAgICAgIGlmIChjbGFpbWVkLmVycm9yKSB0aHJvdyBuZXcgRXJyb3IoYFx1NTNENlx1NUY5N1x1N0Q1MFx1N0I5N1x1OTFDRFx1OEE2Nlx1NkIwQVx1NTkzMVx1NjU1N1x1RkYxQSR7Y2xhaW1lZC5lcnJvci5tZXNzYWdlfWApO1xuICAgICAgaWYgKGNsYWltZWQuZGF0YSkgcmV0dXJuIHsgaWQ6IGNsYWltZWQuZGF0YS5pZCB9O1xuICAgICAgY29uc3QgbGF0ZXN0ID0gYXdhaXQgYWRtaW5cbiAgICAgICAgLmZyb20oXCJvbmNoYWluX3NldHRsZW1lbnRzXCIpXG4gICAgICAgIC5zZWxlY3QoXCJzdGF0dXMsdHhfaGFzaFwiKVxuICAgICAgICAuZXEoXCJpZFwiLCBleGlzdGluZy5kYXRhLmlkKVxuICAgICAgICAubWF5YmVTaW5nbGUoKTtcbiAgICAgIGlmIChsYXRlc3QuZXJyb3IgfHwgIWxhdGVzdC5kYXRhKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgXHU3OEJBXHU4QThEXHU3RDUwXHU3Qjk3XHU5MUNEXHU4QTY2XHU3MkMwXHU2MTRCXHU1OTMxXHU2NTU3XHVGRjFBJHtsYXRlc3QuZXJyb3I/Lm1lc3NhZ2UgPz8gXCJcdTYyN0VcdTRFMERcdTUyMzBcdTdENTBcdTdCOTdcdTdEMDBcdTkzMDRcIn1gKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7IGRvbmU6IHsgc3RhdHVzOiBsYXRlc3QuZGF0YS5zdGF0dXMsIHR4X2hhc2g6IGxhdGVzdC5kYXRhLnR4X2hhc2ggfSB9O1xuICAgIH1cbiAgICByZXR1cm4geyBkb25lOiB7IHN0YXR1czogZXhpc3RpbmcuZGF0YS5zdGF0dXMsIHR4X2hhc2g6IGV4aXN0aW5nLmRhdGEudHhfaGFzaCB9IH07XG4gIH1cbiAgY29uc3QgaW5zZXJ0ZWQgPSBhd2FpdCBhZG1pblxuICAgIC5mcm9tKFwib25jaGFpbl9zZXR0bGVtZW50c1wiKVxuICAgIC5pbnNlcnQoeyAuLi5yb3csIHN0YXR1czogXCJwZW5kaW5nXCIgfSlcbiAgICAuc2VsZWN0KFwiaWRcIilcbiAgICAuc2luZ2xlKCk7XG4gIGlmIChpbnNlcnRlZC5lcnJvciB8fCAhaW5zZXJ0ZWQuZGF0YSkge1xuICAgIC8vIFx1NEY3NVx1NzY3Q1x1NjNEMlx1NTE2NVx1NjY0Mlx1NjcwM1x1NjQ5RSB1bmlxdWUocmVmX2tleSlcdUZGMENcdTkxQ0RcdThCODBcdTRFMDBcdTZCMjFcdTRFQTRcdTdENjZcdTY1RTJcdTY3MDlcdTkwQTNcdTdCNDZcdTg2NTVcdTc0MDZcdTMwMDJcbiAgICBjb25zdCByZXRyeSA9IGF3YWl0IGFkbWluXG4gICAgICAuZnJvbShcIm9uY2hhaW5fc2V0dGxlbWVudHNcIilcbiAgICAgIC5zZWxlY3QoXCJpZCxzdGF0dXMsdHhfaGFzaFwiKVxuICAgICAgLmVxKFwicmVmX2tleVwiLCByb3cucmVmX2tleSlcbiAgICAgIC5tYXliZVNpbmdsZSgpO1xuICAgIGlmIChyZXRyeS5kYXRhKSB7XG4gICAgICBpZiAocmV0cnkuZGF0YS5zdGF0dXMgPT09IFwiZmFpbGVkXCIpIHtcbiAgICAgICAgY29uc3QgY2xhaW1lZCA9IGF3YWl0IGFkbWluXG4gICAgICAgICAgLmZyb20oXCJvbmNoYWluX3NldHRsZW1lbnRzXCIpXG4gICAgICAgICAgLnVwZGF0ZSh7IHN0YXR1czogXCJwZW5kaW5nXCIsIGVycm9yOiBudWxsLCB1cGRhdGVkX2F0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkgfSlcbiAgICAgICAgICAuZXEoXCJpZFwiLCByZXRyeS5kYXRhLmlkKVxuICAgICAgICAgIC5lcShcInN0YXR1c1wiLCBcImZhaWxlZFwiKVxuICAgICAgICAgIC5zZWxlY3QoXCJpZFwiKVxuICAgICAgICAgIC5tYXliZVNpbmdsZSgpO1xuICAgICAgICBpZiAoY2xhaW1lZC5lcnJvcikgdGhyb3cgbmV3IEVycm9yKGBcdTUzRDZcdTVGOTdcdTdENTBcdTdCOTdcdTkxQ0RcdThBNjZcdTZCMEFcdTU5MzFcdTY1NTdcdUZGMUEke2NsYWltZWQuZXJyb3IubWVzc2FnZX1gKTtcbiAgICAgICAgaWYgKGNsYWltZWQuZGF0YSkgcmV0dXJuIHsgaWQ6IGNsYWltZWQuZGF0YS5pZCB9O1xuICAgICAgfVxuICAgICAgY29uc3QgbGF0ZXN0ID0gYXdhaXQgYWRtaW5cbiAgICAgICAgLmZyb20oXCJvbmNoYWluX3NldHRsZW1lbnRzXCIpXG4gICAgICAgIC5zZWxlY3QoXCJzdGF0dXMsdHhfaGFzaFwiKVxuICAgICAgICAuZXEoXCJpZFwiLCByZXRyeS5kYXRhLmlkKVxuICAgICAgICAubWF5YmVTaW5nbGUoKTtcbiAgICAgIGlmIChsYXRlc3QuZXJyb3IgfHwgIWxhdGVzdC5kYXRhKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgXHU3OEJBXHU4QThEXHU3RDUwXHU3Qjk3XHU5MUNEXHU4QTY2XHU3MkMwXHU2MTRCXHU1OTMxXHU2NTU3XHVGRjFBJHtsYXRlc3QuZXJyb3I/Lm1lc3NhZ2UgPz8gXCJcdTYyN0VcdTRFMERcdTUyMzBcdTdENTBcdTdCOTdcdTdEMDBcdTkzMDRcIn1gKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7IGRvbmU6IHsgc3RhdHVzOiBsYXRlc3QuZGF0YS5zdGF0dXMsIHR4X2hhc2g6IGxhdGVzdC5kYXRhLnR4X2hhc2ggfSB9O1xuICAgIH1cbiAgICAvLyBcdTZDOTJcdTY3MDlcdTY1RTJcdTY3MDlcdTUyMTcgXHUyMUQyIFx1OTAxOVx1NEUwRFx1NjYyRlx1NEY3NVx1NzY3Q1x1NjQ5RSB1bmlxdWVcdUZGMENcdTgwMENcdTY2MkZcdTc3MUZcdTZCNjNcdTc2ODRcdTVCRUJcdTUxNjVcdTU5MzFcdTY1NTdcdUZGMDhcdTRGOEJcdTU5ODIgQ0hFQ0sgXHU3RDA0XHU2NzVGXHU0RTBEXHU1MTQxXHU4QTMxXG4gICAgLy8gXHU2QjY0IGFjdGlvblx1RkYwOVx1MzAwMlx1NEVFNVx1NTI0RFx1OTAxOVx1ODhFMVx1NjcwM1x1OEIwQVx1NTgzMSBwZW5kaW5nXHUzMDBDZG9uZVx1MzAwRFx1RkYwQ1x1NUMwRVx1ODFGNFx1N0Q1MFx1N0I5N1x1OTc1Q1x1OUVEOCBuby1vcFx1RkYwQ1x1NTM3Qlx1NTZERVx1NTgzMVx1NjIxMFx1NTI5Rlx1MzAwMlxuICAgIC8vIFx1NzNGRVx1NTcyOFx1NjUzOVx1NzBCQVx1NjJDQlx1NTFGQVx1NzcxRlx1NUJFNlx1OTMyRlx1OEFBNFx1RkYwQ1x1OEI5M1x1NEUwQVx1NUM2NFx1NkExOVx1OEExOCBmYWlsZWQgXHU0RTI2XHU5ODZGXHU3OTNBXHU1MzlGXHU1NkUwXHVGRjBDXHU3RDU1XHU0RTBEXHU1MDQ3XHU4OEREXHU2MjEwXHU1MjlGXHUzMDAyXG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYFx1NzEyMVx1NkNENVx1NUVGQVx1N0FDQlx1N0Q1MFx1N0I5N1x1N0QwMFx1OTMwNFx1RkYwOGFjdGlvbj0ke3Jvdy5hY3Rpb259XHVGRjA5XHVGRjFBJHtpbnNlcnRlZC5lcnJvcj8ubWVzc2FnZSA/PyBcIlx1NjcyQVx1NzdFNVx1OTMyRlx1OEFBNFwifWAsXG4gICAgKTtcbiAgfVxuICByZXR1cm4geyBpZDogaW5zZXJ0ZWQuZGF0YS5pZCB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBmaW5pc2goXG4gIGFkbWluOiBTdXBhYmFzZUNsaWVudCxcbiAgaWQ6IHN0cmluZyxcbiAgcGF0Y2g6IHsgc3RhdHVzOiBcImNvbmZpcm1lZFwiIHwgXCJmYWlsZWRcIjsgdHhfaGFzaD86IHN0cmluZzsgZXJyb3I/OiBzdHJpbmcgfSxcbikge1xuICBjb25zdCB7IGRhdGEsIGVycm9yIH0gPSBhd2FpdCBhZG1pblxuICAgIC5mcm9tKFwib25jaGFpbl9zZXR0bGVtZW50c1wiKVxuICAgIC51cGRhdGUoe1xuICAgICAgLi4ucGF0Y2gsXG4gICAgICAuLi4ocGF0Y2guc3RhdHVzID09PSBcImNvbmZpcm1lZFwiID8geyBlcnJvcjogbnVsbCB9IDoge30pLFxuICAgICAgdXBkYXRlZF9hdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIH0pXG4gICAgLmVxKFwiaWRcIiwgaWQpXG4gICAgLnNlbGVjdChcImlkXCIpXG4gICAgLm1heWJlU2luZ2xlKCk7XG4gIGlmIChlcnJvciB8fCAhZGF0YSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgXHU2NkY0XHU2NUIwXHU3RDUwXHU3Qjk3XHU3MkMwXHU2MTRCXHU1OTMxXHU2NTU3XHVGRjFBJHtlcnJvcj8ubWVzc2FnZSA/PyBcIlx1NjI3RVx1NEUwRFx1NTIzMFx1N0Q1MFx1N0I5N1x1N0QwMFx1OTMwNFwifWApO1xuICB9XG59XG5cbi8vIFx1OEI4MFx1NTNENlx1RkYwRlx1NTQwOFx1NEY3NSBvbmNoYWluX3NldHRsZW1lbnRzLnBheWxvYWRcdTMwMDJcdTU5MUFcdTZCNjVcdTkzQzhcdTRFMEFcdTdENTBcdTdCOTdcdUZGMDhcdTY1MzYgSkMgXHU5MDMyXHU5MUQxXHU1RUFCXHUzMDAxXHU2NTJGXHU0RUQ4IG5ldCBcdTdENjZcbi8vIFx1OENFM1x1NjVCOVx1MzAwMVx1NzY3Q1x1NkExOVx1NzY4NFx1RkYwOVx1NjI4QVx1NkJDRlx1NEUwMFx1NkI2NVx1NzY4NCB0eCBoYXNoIFx1OEExOFx1OTAzMiBwYXlsb2FkXHVGRjBDXHU3QkExXHU3NDA2XHU1NEUxXHUzMDBDXHU0RTAwXHU5Mzc1XHU4OERDXHU3NjdDXHUzMDBEXHU5MUNEXHU4QTY2XHU2NjQyXHU1M0VGXHU4REYzXHU5MDRFXG4vLyBcdTVERjJcdTVCOENcdTYyMTBcdTc2ODRcdTZCNjVcdTlBNUZcdUZGMENcdTkwN0ZcdTUxNERcdTkxQ0RcdTg5MDdcdTYyNjNcdTZCM0VcdUZGMEZcdTkxQ0RcdTg5MDdcdThGNDlcdTVFMzNcdTMwMDJcbmFzeW5jIGZ1bmN0aW9uIHJlYWRTZXR0bGVtZW50UGF5bG9hZChcbiAgYWRtaW46IFN1cGFiYXNlQ2xpZW50LFxuICBpZDogc3RyaW5nLFxuKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICBjb25zdCB7IGRhdGEsIGVycm9yIH0gPSBhd2FpdCBhZG1pblxuICAgIC5mcm9tKFwib25jaGFpbl9zZXR0bGVtZW50c1wiKVxuICAgIC5zZWxlY3QoXCJwYXlsb2FkXCIpXG4gICAgLmVxKFwiaWRcIiwgaWQpXG4gICAgLm1heWJlU2luZ2xlKCk7XG4gIGlmIChlcnJvciB8fCAhZGF0YSkgdGhyb3cgbmV3IEVycm9yKGBcdThCODBcdTUzRDZcdTdENTBcdTdCOTdcdTkwMzJcdTVFQTZcdTU5MzFcdTY1NTdcdUZGMUEke2Vycm9yPy5tZXNzYWdlID8/IFwiXHU2MjdFXHU0RTBEXHU1MjMwXHU3RDUwXHU3Qjk3XHU3RDAwXHU5MzA0XCJ9YCk7XG4gIGNvbnN0IHBheWxvYWQgPSAoZGF0YSBhcyB7IHBheWxvYWQ/OiB1bmtub3duIH0gfCBudWxsKT8ucGF5bG9hZDtcbiAgcmV0dXJuIHBheWxvYWQgJiYgdHlwZW9mIHBheWxvYWQgPT09IFwib2JqZWN0XCIgPyAocGF5bG9hZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgOiB7fTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbWVyZ2VTZXR0bGVtZW50UGF5bG9hZChcbiAgYWRtaW46IFN1cGFiYXNlQ2xpZW50LFxuICBpZDogc3RyaW5nLFxuICBwYXRjaDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgY3VycmVudCA9IGF3YWl0IHJlYWRTZXR0bGVtZW50UGF5bG9hZChhZG1pbiwgaWQpO1xuICBjb25zdCB7IGRhdGEsIGVycm9yIH0gPSBhd2FpdCBhZG1pblxuICAgIC5mcm9tKFwib25jaGFpbl9zZXR0bGVtZW50c1wiKVxuICAgIC51cGRhdGUoeyBwYXlsb2FkOiB7IC4uLmN1cnJlbnQsIC4uLnBhdGNoIH0sIHVwZGF0ZWRfYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9KVxuICAgIC5lcShcImlkXCIsIGlkKVxuICAgIC5zZWxlY3QoXCJpZFwiKVxuICAgIC5tYXliZVNpbmdsZSgpO1xuICBpZiAoZXJyb3IgfHwgIWRhdGEpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFx1NEZERFx1NUI1OFx1OTNDOFx1NEUwQVx1NEVBNFx1NjYxM1x1OTAzMlx1NUVBNlx1NTkzMVx1NjU1N1x1RkYxQSR7ZXJyb3I/Lm1lc3NhZ2UgPz8gXCJcdTYyN0VcdTRFMERcdTUyMzBcdTdENTBcdTdCOTdcdTdEMDBcdTkzMDRcIn1gKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBydW5TZXR0bGVtZW50U3RlcChcbiAgYWRtaW46IFN1cGFiYXNlQ2xpZW50LFxuICBzZXR0bGVtZW50SWQ6IHN0cmluZyxcbiAgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gIGtleTogc3RyaW5nLFxuICBzdWJtaXQ6IChvblN1Ym1pdHRlZDogT25BZG1pblRyYW5zYWN0aW9uU3VibWl0dGVkKSA9PiBQcm9taXNlPHN0cmluZyB8IG51bGw+LFxuKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGNvbnN0IHNhdmVkSGFzaCA9IHR5cGVvZiBwYXlsb2FkW2tleV0gPT09IFwic3RyaW5nXCIgPyBwYXlsb2FkW2tleV0gYXMgYDB4JHtzdHJpbmd9YCA6IG51bGw7XG4gIGlmIChzYXZlZEhhc2gpIHtcbiAgICBsZXQgc3RhdGUgPSBhd2FpdCBnZXRBZG1pblRyYW5zYWN0aW9uU3RhdHVzKHNhdmVkSGFzaCk7XG4gICAgaWYgKHN0YXRlID09PSBcImNvbmZpcm1lZFwiKSByZXR1cm4gc2F2ZWRIYXNoO1xuICAgIGlmIChzdGF0ZSAhPT0gXCJyZXZlcnRlZFwiKSB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCB3YWl0Rm9yQWRtaW5UcmFuc2FjdGlvbihzYXZlZEhhc2gpO1xuICAgICAgICByZXR1cm4gc2F2ZWRIYXNoO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgc3RhdGUgPSBhd2FpdCBnZXRBZG1pblRyYW5zYWN0aW9uU3RhdHVzKHNhdmVkSGFzaCk7XG4gICAgICAgIGlmIChzdGF0ZSAhPT0gXCJyZXZlcnRlZFwiKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgYFx1OTNDOFx1NEUwQVx1NEVBNFx1NjYxMyAke3NhdmVkSGFzaH0gXHU1QzFBXHU3MTIxXHU2Q0Q1XHU3OEJBXHU4QThEXHVGRjBDXHU3Q0ZCXHU3RDcxXHU1REYyXHU0RkREXHU3NTU5XHU0RUE0XHU2NjEzXHU0RTI2XHU1MDVDXHU2QjYyXHU5MUNEXHU5MDAxXHU0RUU1XHU5MDdGXHU1MTREXHU5MUNEXHU4OTA3XHU4RjQ5XHU1RTMzXHVGRjFBJHtlcnJNc2coZXJyb3IpfWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICBhd2FpdCBtZXJnZVNldHRsZW1lbnRQYXlsb2FkKGFkbWluLCBzZXR0bGVtZW50SWQsIHsgW2tleV06IG51bGwgfSk7XG4gICAgcGF5bG9hZFtrZXldID0gbnVsbDtcbiAgfVxuXG4gIGxldCBzdWJtaXR0ZWRIYXNoOiBgMHgke3N0cmluZ31gIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHN1Ym1pdChhc3luYyAoaGFzaCkgPT4ge1xuICAgIGF3YWl0IG1lcmdlU2V0dGxlbWVudFBheWxvYWQoYWRtaW4sIHNldHRsZW1lbnRJZCwgeyBba2V5XTogaGFzaCB9KTtcbiAgICBwYXlsb2FkW2tleV0gPSBoYXNoO1xuICAgIHN1Ym1pdHRlZEhhc2ggPSBoYXNoO1xuICB9KTtcbiAgcmV0dXJuIHJlc3VsdCA/PyBzdWJtaXR0ZWRIYXNoO1xufVxuXG4vLyBcdTRFMDlcdTUwMEIgb3duZXItb25seSBcdTkzQzhcdTRFMEFcdTdENTBcdTdCOTdcdTc2ODRcdTY4MzhcdTVGQzNcdTkwOEZcdThGMkZcdTYyQkRcdTYyMTBcdTczNjhcdTdBQ0JcdTUxRkRcdTVGMEZcdUZGMENcdTc0MDZcdTc1MzFcdUZGMUFcdTdCQTFcdTc0MDZcdTU0RTFcdTc2ODRcdTMwMENcdTRFMDBcdTkzNzVcdTg4RENcdTc2N0NcdTMwMERcbi8vIFx1NUZDNVx1OTgwOFx1ODBGRFx1NUMwRFx1NEVGQlx1NEY1NVx1NEY3Rlx1NzUyOFx1ODAwNVx1NzY4NFx1NTM2MVx1NTVBRVx1N0QwMFx1OTMwNFx1OTFDRFx1OEREMVx1NTQwQ1x1NEUwMFx1NkJCNVx1N0Q1MFx1N0I5N1x1NkQ0MVx1N0EwQlx1RkYwQ1x1ODAwQ1x1NEUwRFx1NTNFQVx1NjYyRlx1NTM5Rlx1NTlDQlx1OENGQ1x1OENCN1x1ODAwNVx1NjcyQ1x1NEVCQVx1MzAwMlxuLy8gXHU5MDE5XHU4OEUxXHU0RTAwXHU1RjhCXHUzMDBDXHU0RUU1XHU3QUQ5XHU1MTY3XHU2NUUyXHU2NzA5XHU1RTMzXHU2NzJDXHU1MjE3XHVGRjA4bGVkZ2VyUm93XHVGRjA5XHU3MEJBXHU2RTk2XHUzMDBEXHU5MUNEXHU2NUIwXHU2M0E4XHU1QzBFXHU5MUQxXHU5ODREXHU4MjA3XHU5MzIyXHU1MzA1XHVGRjBDXHU1RjlFXHU0RTBEXHU0RkUxXHU0RUZCXG4vLyBcdTU0N0NcdTUzRUJcdTdBRUZcdTUwQjNcdTUxNjVcdTc2ODRcdTY1NzhcdTVCNTdcdTIwMTRcdTIwMTRcdTRFMERcdThBRDZcdTY2MkZcdTRGN0ZcdTc1MjhcdTgwMDVcdTY3MkNcdTRFQkFcdTg5RjhcdTc2N0NcdUZGMENcdTkwODRcdTY2MkZcdTdCQTFcdTc0MDZcdTU0RTFcdTRFRTNcdTcwQkFcdTkxQ0RcdThBNjZcdTkwRkRcdTRFMDBcdTZBMjNcdTVCODlcdTUxNjhcdTMwMDJcbmFzeW5jIGZ1bmN0aW9uIHNldHRsZU1pbnRKY0NvcmUoXG4gIGFkbWluOiBTdXBhYmFzZUNsaWVudCxcbiAgcmVzcG9uc2U6IFNlcnZlclJlc3BvbnNlLFxuICBsZWRnZXJSb3c6IHsgaWQ6IHN0cmluZzsgdXNlcl9pZDogc3RyaW5nOyBhbW91bnQ6IG51bWJlciB9LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHsgZGF0YTogb3duZXJQcm9maWxlIH0gPSBhd2FpdCBhZG1pblxuICAgIC5mcm9tKFwicHJvZmlsZXNcIilcbiAgICAuc2VsZWN0KFwid2FsbGV0X2FkZHJlc3NcIilcbiAgICAuZXEoXCJpZFwiLCBsZWRnZXJSb3cudXNlcl9pZClcbiAgICAubWF5YmVTaW5nbGUoKTtcbiAgbGV0IHdhbGxldDogQWRkcmVzcztcbiAgdHJ5IHtcbiAgICB3YWxsZXQgPSB0b0FkZHJlc3Mob3duZXJQcm9maWxlPy53YWxsZXRfYWRkcmVzcywgXCJcdTRGN0ZcdTc1MjhcdTgwMDVcdTVFMzNcdTg2NUZcIik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDIyLCB7IGVycm9yOiBlcnJNc2coZSkgfSk7XG4gIH1cbiAgY29uc3QgYW1vdW50ID0gTnVtYmVyKGxlZGdlclJvdy5hbW91bnQpO1xuICBpZiAoIShhbW91bnQgPiAwKSkgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQyMiwgeyBlcnJvcjogXCJKQyBcdTY1NzhcdTkxQ0ZcdTcxMjFcdTY1NDhcIiB9KTtcbiAgaWYgKCEoYXdhaXQgZ3VhcmRSZWxheWVyR2FzKHJlc3BvbnNlKSkpIHJldHVybjtcblxuICBjb25zdCBjbGFpbSA9IGF3YWl0IGNsYWltU2V0dGxlbWVudChhZG1pbiwge1xuICAgIGFjdGlvbjogXCJtaW50X2pjXCIsXG4gICAgcmVmX2tleTogYG1pbnRfamM6JHtsZWRnZXJSb3cuaWR9YCxcbiAgICB1c2VyX2lkOiBsZWRnZXJSb3cudXNlcl9pZCxcbiAgICBhbW91bnQsXG4gICAgcGF5bG9hZDogeyB3YWxsZXQgfSxcbiAgfSk7XG4gIGlmIChcImRvbmVcIiBpbiBjbGFpbSkgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDIwMCwgeyAuLi5jbGFpbS5kb25lLCBpZGVtcG90ZW50OiB0cnVlIH0pO1xuICB0cnkge1xuICAgIGNvbnN0IHR4SGFzaCA9IGF3YWl0IG1pbnRKYyh3YWxsZXQsIGFtb3VudCk7XG4gICAgYXdhaXQgZmluaXNoKGFkbWluLCBjbGFpbS5pZCwgeyBzdGF0dXM6IFwiY29uZmlybWVkXCIsIHR4X2hhc2g6IHR4SGFzaCB9KTtcbiAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IHN0YXR1czogXCJjb25maXJtZWRcIiwgdHhfaGFzaDogdHhIYXNoLCBhbW91bnQgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBhd2FpdCBmaW5pc2goYWRtaW4sIGNsYWltLmlkLCB7IHN0YXR1czogXCJmYWlsZWRcIiwgZXJyb3I6IGVyck1zZyhlKSB9KTtcbiAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNTAyLCB7IGVycm9yOiBgXHU5M0M4XHU0RTBBXHU3NjdDXHU1RTYzXHU1OTMxXHU2NTU3XHVGRjFBJHtlcnJNc2coZSl9YCB9KTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBzZXR0bGVTdWJzY3JpYmVDb3JlKFxuICBhZG1pbjogU3VwYWJhc2VDbGllbnQsXG4gIHJlc3BvbnNlOiBTZXJ2ZXJSZXNwb25zZSxcbiAgbGVkZ2VyUm93OiB7XG4gICAgaWQ6IHN0cmluZztcbiAgICB1c2VyX2lkOiBzdHJpbmc7XG4gICAgYXNzZXRfaWQ6IHN0cmluZyB8IG51bGw7XG4gICAgcXVhbnRpdHk6IG51bWJlcjtcbiAgICBhbW91bnQ6IG51bWJlcjtcbiAgICBtZXRhZGF0YTogdW5rbm93bjtcbiAgfSxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBwbGFjZW1lbnQgPSBhd2FpdCBhZG1pblxuICAgIC5mcm9tKFwicHJpdmF0ZV9wbGFjZW1lbnRzXCIpXG4gICAgLnNlbGVjdChcImlkLGlzX2FlX3Rva2VuXCIpXG4gICAgLmVxKFwiaWRcIiwgbGVkZ2VyUm93LmFzc2V0X2lkKVxuICAgIC5tYXliZVNpbmdsZSgpO1xuICBjb25zdCBpc0FlID0gISFwbGFjZW1lbnQuZGF0YT8uaXNfYWVfdG9rZW47XG4gIGNvbnN0IGZhY3RvcnlUb2tlbiA9IGlzQWVcbiAgICA/IHVuZGVmaW5lZFxuICAgIDogKGF3YWl0IGdldEN1cnJlbnRSd2FGYWN0b3J5VG9rZW4obGVkZ2VyUm93LmFzc2V0X2lkKSkgPz8gdW5kZWZpbmVkO1xuICBjb25zdCB1bml0cyA9IE51bWJlcihsZWRnZXJSb3cucXVhbnRpdHkpO1xuICBjb25zdCBncm9zcyA9IE51bWJlcihcbiAgICAobGVkZ2VyUm93Lm1ldGFkYXRhIGFzIHsgZ3Jvc3M/OiBudW1iZXIgfSB8IG51bGwpPy5ncm9zcyA/PyBNYXRoLmFicyhOdW1iZXIobGVkZ2VyUm93LmFtb3VudCkpLFxuICApO1xuICBpZiAoISh1bml0cyA+IDApIHx8ICEoZ3Jvc3MgPiAwKSkgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQyMiwgeyBlcnJvcjogXCJcdThBOERcdThDRkNcdTY1NzhcdTkxQ0ZcdTYyMTZcdTkxRDFcdTk4NERcdTcxMjFcdTY1NDhcIiB9KTtcbiAgY29uc3QgeyBkYXRhOiBvd25lclByb2ZpbGUgfSA9IGF3YWl0IGFkbWluXG4gICAgLmZyb20oXCJwcm9maWxlc1wiKVxuICAgIC5zZWxlY3QoXCJ3YWxsZXRfYWRkcmVzc1wiKVxuICAgIC5lcShcImlkXCIsIGxlZGdlclJvdy51c2VyX2lkKVxuICAgIC5tYXliZVNpbmdsZSgpO1xuICBsZXQgd2FsbGV0OiBBZGRyZXNzO1xuICB0cnkge1xuICAgIHdhbGxldCA9IHRvQWRkcmVzcyhvd25lclByb2ZpbGU/LndhbGxldF9hZGRyZXNzLCBcIlx1NEY3Rlx1NzUyOFx1ODAwNVx1NUUzM1x1ODY1RlwiKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MjIsIHsgZXJyb3I6IGVyck1zZyhlKSB9KTtcbiAgfVxuICBpZiAoIShhd2FpdCBndWFyZFBsYWNlbWVudFN0aWxsU2V0dGxlYWJsZShhZG1pbiwgcmVzcG9uc2UsIFN0cmluZyhsZWRnZXJSb3cuYXNzZXRfaWQpKSkpIHJldHVybjtcbiAgaWYgKCEoYXdhaXQgZ3VhcmRSZWxheWVyR2FzKHJlc3BvbnNlKSkpIHJldHVybjtcblxuICBjb25zdCBjbGFpbSA9IGF3YWl0IGNsYWltU2V0dGxlbWVudChhZG1pbiwge1xuICAgIGFjdGlvbjogXCJzdWJzY3JpYmVcIixcbiAgICByZWZfa2V5OiBgc3Vic2NyaWJlOiR7bGVkZ2VyUm93LmlkfWAsXG4gICAgdXNlcl9pZDogbGVkZ2VyUm93LnVzZXJfaWQsXG4gICAgYXNzZXRfaWQ6IGxlZGdlclJvdy5hc3NldF9pZCxcbiAgICBhbW91bnQ6IHVuaXRzLFxuICAgIHBheW1lbnQ6IGdyb3NzLFxuICAgIHBheWxvYWQ6IHsgd2FsbGV0LCBpc0FlLCBmYWN0b3J5VG9rZW46IGZhY3RvcnlUb2tlbiA/PyBudWxsIH0sXG4gIH0pO1xuICBpZiAoXCJkb25lXCIgaW4gY2xhaW0pIHJldHVybiBqc29uKHJlc3BvbnNlLCAyMDAsIHsgLi4uY2xhaW0uZG9uZSwgaWRlbXBvdGVudDogdHJ1ZSB9KTtcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXlsb2FkID0gYXdhaXQgcmVhZFNldHRsZW1lbnRQYXlsb2FkKGFkbWluLCBjbGFpbS5pZCk7XG4gICAgY29uc3QgaGFzTGVnYWN5SmNQdWxsID0gdHlwZW9mIHBheWxvYWQuamNQdWxsVHggPT09IFwic3RyaW5nXCI7XG4gICAgaWYgKGhhc0xlZ2FjeUpjUHVsbCkge1xuICAgICAgY29uc3QgcHVsbFR4ID0gYXdhaXQgcnVuU2V0dGxlbWVudFN0ZXAoYWRtaW4sIGNsYWltLmlkLCBwYXlsb2FkLCBcImpjUHVsbFR4XCIsIChvblN1Ym1pdHRlZCkgPT5cbiAgICAgICAgcHVsbEpjRnJvbVVzZXIod2FsbGV0LCBncm9zcywgb25TdWJtaXR0ZWQpLFxuICAgICAgKTtcbiAgICAgIGlmICghcHVsbFR4KSB0aHJvdyBuZXcgRXJyb3IoXCJcdTgyMEFcdTcyNDhcdThBOERcdThDRkMgSkMgXHU2NTM2XHU2QjNFXHU1QzFBXHU2NzJBXHU3OEJBXHU4QThEXHVGRjBDXHU3Q0ZCXHU3RDcxXHU1QzA3XHU1Qjg5XHU1MTY4XHU5MUNEXHU4QTY2XCIpO1xuXG4gICAgICBpZiAodHlwZW9mIHBheWxvYWQuYXNzZXRUcmFuc2ZlclR4ICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIGNvbnN0IGFzc2V0VG9rZW4gPSBpc0FlID8gUkVMQVlFUl9BRERSRVNTRVMuYWVUb2tlbiA6IGZhY3RvcnlUb2tlbjtcbiAgICAgICAgaWYgKGFzc2V0VG9rZW4pIHtcbiAgICAgICAgICBjb25zdCByZWNvdmVyZWRUeCA9IGF3YWl0IGZpbmRSZWNlbnRBc3NldFRyYW5zZmVyKFxuICAgICAgICAgICAgYXNzZXRUb2tlbixcbiAgICAgICAgICAgIHdhbGxldCxcbiAgICAgICAgICAgIHVuaXRzLFxuICAgICAgICAgICAgcGF5bG9hZC5qY1B1bGxUeCBhcyBgMHgke3N0cmluZ31gLFxuICAgICAgICAgICAgIWlzQWUsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBpZiAocmVjb3ZlcmVkVHgpIHtcbiAgICAgICAgICAgIGF3YWl0IG1lcmdlU2V0dGxlbWVudFBheWxvYWQoYWRtaW4sIGNsYWltLmlkLCB7XG4gICAgICAgICAgICAgIGFzc2V0VHJhbnNmZXJUeDogcmVjb3ZlcmVkVHgsXG4gICAgICAgICAgICAgIGFzc2V0VHJhbnNmZXJSZWNvdmVyZWQ6IHRydWUsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHBheWxvYWQuYXNzZXRUcmFuc2ZlclR4ID0gcmVjb3ZlcmVkVHg7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgdmF1bHRUeCA9IGF3YWl0IHJ1blNldHRsZW1lbnRTdGVwKGFkbWluLCBjbGFpbS5pZCwgcGF5bG9hZCwgXCJqY1RvVmF1bHRUeFwiLCAob25TdWJtaXR0ZWQpID0+XG4gICAgICBoYXNMZWdhY3lKY1B1bGxcbiAgICAgICAgPyBzZW5kSmNUb1ZhdWx0KGdyb3NzLCBvblN1Ym1pdHRlZClcbiAgICAgICAgOiBjb2xsZWN0SmNUb1ZhdWx0KHdhbGxldCwgZ3Jvc3MsIG9uU3VibWl0dGVkKSxcbiAgICApO1xuICAgIGlmICghdmF1bHRUeCkgdGhyb3cgbmV3IEVycm9yKFwiXHU4QThEXHU4Q0ZDIEpDIFx1NUMxQVx1NjcyQVx1OEY0OVx1NTE2NSBTYWZlXHVGRjBDXHU4QUNCXHU3QTBEXHU1RjhDXHU4MUVBXHU1MkQ1XHU5MUNEXHU4QTY2XCIpO1xuXG4gICAgY29uc3QgYXNzZXRUeCA9IGF3YWl0IHJ1blNldHRsZW1lbnRTdGVwKGFkbWluLCBjbGFpbS5pZCwgcGF5bG9hZCwgXCJhc3NldFRyYW5zZmVyVHhcIiwgKG9uU3VibWl0dGVkKSA9PlxuICAgICAgaXNBZVxuICAgICAgICA/IGV4ZWN1dGVBZVN1YnNjcmlwdGlvbih3YWxsZXQsIHVuaXRzLCBvblN1Ym1pdHRlZClcbiAgICAgICAgOiBleGVjdXRlU3Vic2NyaXB0aW9uKHdhbGxldCwgdW5pdHMsIHVuZGVmaW5lZCwgZmFjdG9yeVRva2VuLCBvblN1Ym1pdHRlZCksXG4gICAgKTtcbiAgICBpZiAoIWFzc2V0VHgpIHRocm93IG5ldyBFcnJvcihcIlx1NkExOVx1NzY4NFx1NEVGRFx1OTg0RFx1NUMxQVx1NjcyQVx1NzY3Q1x1NjUzRVx1RkYwQ1x1OEFDQlx1N0EwRFx1NUY4Q1x1ODFFQVx1NTJENVx1OTFDRFx1OEE2NlwiKTtcblxuICAgIGF3YWl0IGZpbmlzaChhZG1pbiwgY2xhaW0uaWQsIHsgc3RhdHVzOiBcImNvbmZpcm1lZFwiLCB0eF9oYXNoOiBhc3NldFR4IH0pO1xuXG4gICAgLy8gXHU4QThEXHU4Q0ZDXHU2MjEwXHU0RUE0XHU3NTc2XHU0RTBCXHU1MzczXHU2NjQyXHU2MjhBXHU2QjY0XHU3QjQ2XHU4Q0ZDXHU4Q0I3XHU3NTIyXHU3NTFGXHU3Njg0XHU2M0E4XHU1RUUzXHU1MjA2XHU2RjY0XHU0RTBBXHU5M0M4XHU3NjdDXHU2NTNFXHVGRjA4QURNSU4gXHU3MUIxXHU5MzIyXHU1MzA1XHUyMTkyXHU1NDA0XHU0RTBBXHU3RERBXHU1M0Q3XHU3NkNBXG4gICAgLy8gXHU0RUJBXHVGRjA5XHVGRjBDYmVzdC1lZmZvcnRcdUZGMUFcdTc2N0NcdTRFMERcdTYyMTBcdTc2ODRcdTRFMERcdTVGNzFcdTk3RkZcdTY3MkNcdTZCMjFcdThBOERcdThDRkNcdTdENTBcdTY3OUNcdUZGMENcdTY3MDNcdTc1MzEgY3JvbiAvIFx1NUY4Q1x1NTNGMFx1ODhEQ1x1NzY3Q1x1NjRCRlx1NTZERVx1MzAwMlxuICAgIGF3YWl0IHNldHRsZUNvbW1pc3Npb25zRm9yU291cmNlKGFkbWluLCBsZWRnZXJSb3cuaWQpLmNhdGNoKCgpID0+IHt9KTtcbiAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IHN0YXR1czogXCJjb25maXJtZWRcIiwgdHhfaGFzaDogYXNzZXRUeCwgdW5pdHMsIHBheW1lbnQ6IGdyb3NzIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgYXdhaXQgZmluaXNoKGFkbWluLCBjbGFpbS5pZCwgeyBzdGF0dXM6IFwiZmFpbGVkXCIsIGVycm9yOiBlcnJNc2coZSkgfSk7XG4gICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDUwMiwgeyBlcnJvcjogYFx1OTNDOFx1NEUwQVx1OEE4RFx1OENGQ1x1N0Q1MFx1N0I5N1x1NTkzMVx1NjU1N1x1RkYxQSR7ZXJyTXNnKGUpfWAgfSk7XG4gIH1cbn1cblxuLy8gSkMgXHU4RDE2XHU1NkRFXHVGRjFBXHU0RjdGXHU3NTI4XHU4MDA1XHU3NTMzXHU4QUNCXHU4RDE2XHU1NkRFXHVGRjA4cmVxdWVzdF9qY19yZWRlbXB0aW9uIFx1NURGMlx1NjI2M1x1N0FEOVx1NTE2NyBKQyBcdTVFMzNcdTY3MkNcdTMwMDFcdTVFRkFcdTdBQ0Jcbi8vIHJlZGVtcHRpb25fb3JkZXJzIHBlbmRpbmcgXHU4QTAyXHU1NUFFXHVGRjA5XHU1RjhDXHU1MzczXHU2NjQyXHU4OUY4XHU3NjdDXHU5M0M4XHU0RTBBXHU2NEE1XHU2QjNFXHUyMDE0XHUyMDE0KDEpIFx1NjI4QVx1NEY3Rlx1NzUyOFx1ODAwNVx1OTNDOFx1NEUwQSBKQ1xuLy8gXHU1QkU2XHU5NjlCXHU2NTM2XHU1NkRFIFNhZmUgXHU5MUQxXHU1RUFCXHVGRjA4Y29sbGVjdEpjVG9WYXVsdFx1RkYwOVx1RkYwQygyKSBBRE1JTiBcdTcxQjFcdTkzMjJcdTUzMDVcdTc2RjRcdTYzQTVcdTc1MjhcdTgxRUFcdTVERjFcdTc2ODQgVVNEVFxuLy8gXHU5OTE4XHU5ODREXHU2NEE1XHU2QjNFXHU3RDY2XHU0RjdGXHU3NTI4XHU4MDA1XHVGRjA4YWRtaW5TZW5kVXNkdFx1RkYwOVx1MzAwMlx1NjNBMVx1MzAwQ1x1NTE0OFx1NjUzNlx1NkIzRVx1MzAwMVx1NUY4Q1x1NjRBNVx1NkIzRVx1MzAwRFx1NzY4NFx1NUI4OVx1NTE2OFx1OTU5OFx1OTU4MFx1RkYxQUpDIFx1NjUzNlx1NTZERVxuLy8gXHU1OTMxXHU2NTU3XHVGRjA4XHU0RjhCXHU1OTgyXHU0RjdGXHU3NTI4XHU4MDA1XHU5M0M4XHU0RTBBIEpDIFx1NEUwRFx1OERCM1x1NjIxNlx1NjcyQVx1NjM4OFx1NkIwQVx1MjAxNFx1MjAxNFx1N0FEOVx1NTE2N1x1NTNFRlx1NzUyOCBKQyBcdTUzRUZcdTgwRkRcdTUzMDVcdTU0MkJcdTVDMUFcdTY3MkFcdTRFMEFcdTkzQzhcdTc2ODRcdTUyMDZcdTZGNjRcbi8vIEpDXHVGRjA5XHU1QzMxXHU1MTQ4XHU2NENCXHU0RTBCXHVGRjBDXHU1QzFBXHU2NzJBXHU2NEE1XHU1MUZBXHU0RUZCXHU0RjU1IFVTRFRcdUZGMENcdTkwN0ZcdTUxNERcdTVFNzNcdTUzRjBcdTc2N0RcdTc2N0RcdTY0QTVcdTZCM0VcdTUzN0JcdTY1MzZcdTRFMERcdTU2REVcdTVDMERcdTYxQzlcdTc2ODQgSkNcdTMwMDJcdTYyMTBcdTUyOUZcbi8vIFx1NUY4Q1x1NzZGNFx1NjNBNVx1NjI4QSByZWRlbXB0aW9uX29yZGVycyBcdTZBMTlcdThBMThcdTcwQkEgY29tcGxldGVkXHVGRjBDXHU0RTBEXHU1MThEXHU5NzAwXHU4OTgxXHU3QkExXHU3NDA2XHU1NEUxXHU2MjRCXHU1MkQ1XHU4Q0JDIHR4IGhhc2hcdTMwMDJcbmFzeW5jIGZ1bmN0aW9uIHNldHRsZVJlZGVtcHRpb25Db3JlKFxuICBhZG1pbjogU3VwYWJhc2VDbGllbnQsXG4gIHJlc3BvbnNlOiBTZXJ2ZXJSZXNwb25zZSxcbiAgb3JkZXI6IHsgaWQ6IHN0cmluZzsgdXNlcl9pZDogc3RyaW5nOyB3YWxsZXRfYWRkcmVzczogc3RyaW5nOyBqY19hbW91bnQ6IG51bWJlcjsgdXNkdF9hbW91bnQ6IG51bWJlciB9LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGxldCB3YWxsZXQ6IEFkZHJlc3M7XG4gIHRyeSB7XG4gICAgd2FsbGV0ID0gdG9BZGRyZXNzKG9yZGVyLndhbGxldF9hZGRyZXNzLCBcIlx1NEY3Rlx1NzUyOFx1ODAwNVx1NUUzM1x1ODY1RlwiKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MjIsIHsgZXJyb3I6IGVyck1zZyhlKSB9KTtcbiAgfVxuICBjb25zdCBqY0Ftb3VudCA9IE51bWJlcihvcmRlci5qY19hbW91bnQpO1xuICBjb25zdCB1c2R0QW1vdW50ID0gTnVtYmVyKG9yZGVyLnVzZHRfYW1vdW50KTtcbiAgaWYgKCEoamNBbW91bnQgPiAwKSB8fCAhKHVzZHRBbW91bnQgPiAwKSkgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQyMiwgeyBlcnJvcjogXCJcdThEMTZcdTU2REVcdTkxRDFcdTk4NERcdTcxMjFcdTY1NDhcIiB9KTtcbiAgaWYgKCEoYXdhaXQgZ3VhcmRSZWxheWVyR2FzKHJlc3BvbnNlKSkpIHJldHVybjtcblxuICBjb25zdCBjbGFpbSA9IGF3YWl0IGNsYWltU2V0dGxlbWVudChhZG1pbiwge1xuICAgIGFjdGlvbjogXCJyZWRlZW1cIixcbiAgICByZWZfa2V5OiBgcmVkZWVtOiR7b3JkZXIuaWR9YCxcbiAgICB1c2VyX2lkOiBvcmRlci51c2VyX2lkLFxuICAgIGFtb3VudDogamNBbW91bnQsXG4gICAgcGF5bWVudDogdXNkdEFtb3VudCxcbiAgICBwYXlsb2FkOiB7IHdhbGxldCB9LFxuICB9KTtcbiAgaWYgKFwiZG9uZVwiIGluIGNsYWltKSByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IC4uLmNsYWltLmRvbmUsIGlkZW1wb3RlbnQ6IHRydWUgfSk7XG4gIHRyeSB7XG4gICAgY29uc3QgcGF5bG9hZCA9IGF3YWl0IHJlYWRTZXR0bGVtZW50UGF5bG9hZChhZG1pbiwgY2xhaW0uaWQpO1xuICAgIC8vIFx1NkI2NVx1OUE1RjFcdUZGMDhcdTVCODlcdTUxNjhcdTk1OThcdTk1ODBcdUZGMENcdTVGQzVcdTk4MDhcdTUxNDhcdTc4QkFcdThBOERcdUZGMDlcdUZGMUFcdTYyOEFcdTRGN0ZcdTc1MjhcdTgwMDVcdTkzQzhcdTRFMEEgSkMgXHU1QkU2XHU5NjlCXHU2NTM2XHU5MDMyIFNhZmUgXHU5MUQxXHU1RUFCXHUzMDAyXHU0RjdGXHU3NTI4XHU4MDA1XG4gICAgLy8gXHU5M0M4XHU0RTBBIEpDXHVGRjBGXHU2Mzg4XHU2QjBBXHU0RTBEXHU4REIzXHU2NjQyXHU2NzAzXHU1NzI4XHU5MDE5XHU4OEUxXHU0RTFGXHU5MzJGXHU2NENCXHU0RTBCXHVGRjBDXHU2QjY0XHU2NjQyXHU1QzFBXHU2NzJBXHU2NEE1XHU1MUZBXHU0RUZCXHU0RjU1IFVTRFRcdTMwMDJcbiAgICBsZXQgamNDb2xsZWN0VHggPSB0eXBlb2YgcGF5bG9hZC5qY0NvbGxlY3RUeCA9PT0gXCJzdHJpbmdcIiA/IHBheWxvYWQuamNDb2xsZWN0VHggOiBudWxsO1xuICAgIGlmICghamNDb2xsZWN0VHgpIHtcbiAgICAgIGpjQ29sbGVjdFR4ID0gYXdhaXQgY29sbGVjdEpjVG9WYXVsdCh3YWxsZXQsIGpjQW1vdW50KTtcbiAgICAgIGF3YWl0IG1lcmdlU2V0dGxlbWVudFBheWxvYWQoYWRtaW4sIGNsYWltLmlkLCB7IGpjQ29sbGVjdFR4IH0pO1xuICAgIH1cbiAgICAvLyBcdTZCNjVcdTlBNUYyXHVGRjFBSkMgXHU1REYyXHU3OEJBXHU4QThEXHU2NTM2XHU1NkRFXHU5MUQxXHU1RUFCXHVGRjBDQURNSU4gXHU3MUIxXHU5MzIyXHU1MzA1XHU3NTI4XHU4MUVBXHU1REYxXHU3Njg0IFVTRFQgXHU5OTE4XHU5ODREXHU3NkY0XHU2M0E1XHU2NEE1XHU2QjNFXHU3RDY2XHU0RjdGXHU3NTI4XHU4MDA1XHUzMDAyXG4gICAgbGV0IHVzZHRUeCA9IHR5cGVvZiBwYXlsb2FkLnVzZHRUeCA9PT0gXCJzdHJpbmdcIiA/IHBheWxvYWQudXNkdFR4IDogbnVsbDtcbiAgICBpZiAoIXVzZHRUeCkge1xuICAgICAgdXNkdFR4ID0gYXdhaXQgYWRtaW5TZW5kVXNkdCh3YWxsZXQsIHVzZHRBbW91bnQpO1xuICAgICAgYXdhaXQgbWVyZ2VTZXR0bGVtZW50UGF5bG9hZChhZG1pbiwgY2xhaW0uaWQsIHsgdXNkdFR4IH0pO1xuICAgIH1cbiAgICBhd2FpdCBmaW5pc2goYWRtaW4sIGNsYWltLmlkLCB7IHN0YXR1czogXCJjb25maXJtZWRcIiwgdHhfaGFzaDogdXNkdFR4ID8/IHVuZGVmaW5lZCB9KTtcbiAgICBhd2FpdCBhZG1pblxuICAgICAgLmZyb20oXCJyZWRlbXB0aW9uX29yZGVyc1wiKVxuICAgICAgLnVwZGF0ZSh7XG4gICAgICAgIHN0YXR1czogXCJjb21wbGV0ZWRcIixcbiAgICAgICAgdHhfaGFzaDogdXNkdFR4LFxuICAgICAgICBhZG1pbl9ub3RlOiBcIlx1N0NGQlx1N0Q3MVx1ODFFQVx1NTJENVx1NjRBNVx1NkIzRVx1RkYwOFx1OTNDOFx1NEUwQVx1NTM3M1x1NjY0Mlx1N0Q1MFx1N0I5N1x1RkYwOVwiLFxuICAgICAgICByZXNvbHZlZF9hdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICB1cGRhdGVkX2F0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICB9KVxuICAgICAgLmVxKFwiaWRcIiwgb3JkZXIuaWQpXG4gICAgICAuZXEoXCJzdGF0dXNcIiwgXCJwZW5kaW5nXCIpO1xuICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCAyMDAsIHtcbiAgICAgIHN0YXR1czogXCJjb25maXJtZWRcIixcbiAgICAgIHR4X2hhc2g6IHVzZHRUeCxcbiAgICAgIGpjX2NvbGxlY3RfdHg6IGpjQ29sbGVjdFR4LFxuICAgICAgamNfYW1vdW50OiBqY0Ftb3VudCxcbiAgICAgIHVzZHRfYW1vdW50OiB1c2R0QW1vdW50LFxuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgYXdhaXQgZmluaXNoKGFkbWluLCBjbGFpbS5pZCwgeyBzdGF0dXM6IFwiZmFpbGVkXCIsIGVycm9yOiBlcnJNc2coZSkgfSk7XG4gICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDUwMiwgeyBlcnJvcjogYFx1OEQxNlx1NTZERVx1OTNDOFx1NEUwQVx1NjRBNVx1NkIzRVx1NTkzMVx1NjU1N1x1RkYxQSR7ZXJyTXNnKGUpfWAgfSk7XG4gIH1cbn1cblxuLy8gXHU2M0E4XHU1RUUzXHU1MjA2XHU2RjY0XHVGRjA4XHU0RUUzXHU3NDA2XHU3MzRFXHU5MUQxXHVGRjA5XHU5M0M4XHU0RTBBXHU1MzczXHU2NjQyXHU3NjdDXHU2NTNFXHVGRjFBXHU3NTMxIEFETUlOIFx1NzFCMVx1OTMyMlx1NTMwNVx1NzZGNFx1NjNBNVx1NjI4QSBKQyB0cmFuc2ZlciBcdTdENjZcdTUzRDdcdTc2Q0FcdTRFQkFcbi8vIFx1OTMyMlx1NTMwNVx1RkYwOEFETUlOXHUyMTkyXHU1M0Q3XHU3NkNBXHU0RUJBXHVGRjBDSkMgXHU1NDA4XHU3RDA0XHU1MTQxXHU4QTMxXHU4MjA3IG93bmVyIFx1NzZGOFx1OTVEQ1x1NzY4NFx1OEY0OVx1NUUzM1x1RkYwOVx1MzAwMlx1OTMyOFx1NUI5QVx1NTVBRVx1N0I0NiBjb21taXNzaW9uX2xvZ3Ncbi8vIFx1RkYwOHBhaWRfYXQgXHU3MEJBIG51bGxcdUZGMDlcdUZGMENcdTkxRDFcdTk4NERcdTRFMDBcdTVGOEJcdTRFRTVcdThBNzJcdTdCNDYgY29tbWlzc2lvbl9hbW91bnQgXHU3MEJBXHU2RTk2XHVGRjBDXHU3RDU1XHU0RTBEXHU0RkUxXHU0RUZCXHU1MjREXHU3QUVGXHUzMDAyXHU2MjEwXHU1MjlGXHU1RjhDXG4vLyBcdTVCRUJcdTUxNjUgamNfbGVkZ2VyIFx1NzY4NCBjb21taXNzaW9uX3BheW91dFx1RkYwOFx1OEI5M1x1RkZGRFx1RkZGRFx1RkZGRFx1NTE2N1x1NTNFRlx1NzUyOCBKQyBcdTdBQ0JcdTUzNzNcdTUzQ0RcdTY2MjBcdTUyMzBcdTVFMzNcdUZGMDlcdTRFMjZcdTZBMTlcdThBMTggcGFpZF9hdFx1RkYxQlxuLy8gb25jaGFpbl9zZXR0bGVtZW50cyBcdTRFRTUgcmVmX2tleSBgY29tbWlzc2lvbjo8bG9nX2lkPmAgXHU1MUFBXHU3QjQ5XHVGRjBDXHU5MDdGXHU1MTREXHU5MUNEXHU4OTA3XHU3NjdDXHU2NTNFXHUzMDAyXG5hc3luYyBmdW5jdGlvbiBzZXR0bGVDb21taXNzaW9uQ29yZShcbiAgYWRtaW46IFN1cGFiYXNlQ2xpZW50LFxuICByZXNwb25zZTogU2VydmVyUmVzcG9uc2UsXG4gIGxvZzogeyBpZDogc3RyaW5nOyB1c2VyX2lkOiBzdHJpbmc7IGFtb3VudDogbnVtYmVyOyBhc3NldF9pZDogc3RyaW5nIHwgbnVsbCB9LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGFtb3VudCA9IE51bWJlcihsb2cuYW1vdW50KTtcbiAgaWYgKCEoYW1vdW50ID4gMCkpIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MjIsIHsgZXJyb3I6IFwiXHU1MjA2XHU2RjY0XHU5MUQxXHU5ODREXHU3MTIxXHU2NTQ4XCIgfSk7XG4gIGNvbnN0IHsgZGF0YTogYmVuZWZpY2lhcnkgfSA9IGF3YWl0IGFkbWluXG4gICAgLmZyb20oXCJwcm9maWxlc1wiKVxuICAgIC5zZWxlY3QoXCJ3YWxsZXRfYWRkcmVzc1wiKVxuICAgIC5lcShcImlkXCIsIGxvZy51c2VyX2lkKVxuICAgIC5tYXliZVNpbmdsZSgpO1xuICBsZXQgd2FsbGV0OiBBZGRyZXNzO1xuICB0cnkge1xuICAgIHdhbGxldCA9IHRvQWRkcmVzcyhiZW5lZmljaWFyeT8ud2FsbGV0X2FkZHJlc3MsIFwiXHU1M0Q3XHU3NkNBXHU0RUJBXHU1RTMzXHU4NjVGXCIpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgLy8gXHU1M0Q3XHU3NkNBXHU0RUJBXHU1QzFBXHU2NzJBXHU3RDgxXHU1QjlBXHU5M0M4XHU0RTBBXHU5MzIyXHU1MzA1XHU2NjQyXHVGRjBDXHU1MTQ4XHU2NENCXHU0RTBCXHVGRjA4XHU3QjQ5XHU0RUQ2XHU3NjdCXHU1MTY1XHU3RDgxXHU1QjlBXHU5MzIyXHU1MzA1XHU1RjhDXHU3NTMxIGNyb24vXHU1RjhDXHU1M0YwXHU4MUVBXHU1MkQ1XHU4OERDXHU3NjdDXHVGRjA5XHUzMDAyXG4gICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQyMiwgeyBlcnJvcjogZXJyTXNnKGUpIH0pO1xuICB9XG4gIGlmICghKGF3YWl0IGd1YXJkUmVsYXllckdhcyhyZXNwb25zZSkpKSByZXR1cm47XG5cbiAgY29uc3QgY2xhaW0gPSBhd2FpdCBjbGFpbVNldHRsZW1lbnQoYWRtaW4sIHtcbiAgICBhY3Rpb246IFwiY29tbWlzc2lvblwiLFxuICAgIHJlZl9rZXk6IGBjb21taXNzaW9uOiR7bG9nLmlkfWAsXG4gICAgdXNlcl9pZDogbG9nLnVzZXJfaWQsXG4gICAgYXNzZXRfaWQ6IGxvZy5hc3NldF9pZCxcbiAgICBhbW91bnQsXG4gICAgcGF5bWVudDogYW1vdW50LFxuICAgIHBheWxvYWQ6IHsgd2FsbGV0IH0sXG4gIH0pO1xuICBpZiAoXCJkb25lXCIgaW4gY2xhaW0pIHJldHVybiBqc29uKHJlc3BvbnNlLCAyMDAsIHsgLi4uY2xhaW0uZG9uZSwgaWRlbXBvdGVudDogdHJ1ZSB9KTtcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXlsb2FkID0gYXdhaXQgcmVhZFNldHRsZW1lbnRQYXlsb2FkKGFkbWluLCBjbGFpbS5pZCk7XG4gICAgbGV0IHBheW91dFR4ID0gdHlwZW9mIHBheWxvYWQucGF5b3V0VHggPT09IFwic3RyaW5nXCIgPyBwYXlsb2FkLnBheW91dFR4IDogbnVsbDtcbiAgICBpZiAoIXBheW91dFR4KSB7XG4gICAgICAvLyBBRE1JTiBcdTcxQjFcdTkzMjJcdTUzMDVcdTc1MjhcdTgxRUFcdThFQUIgSkMgXHU5OTE4XHU5ODREXHU3NkY0XHU2M0E1IHRyYW5zZmVyIFx1N0Q2Nlx1NTNEN1x1NzZDQVx1NEVCQVx1RkYwOFx1NTVBRVx1OERGM1x1RkYwQ1x1NTQwOFx1N0QwNFx1NTE0MVx1OEEzMSBvd25lclx1MjE5Mlx1NEVGQlx1NjEwRlx1RkYwOVx1MzAwMlxuICAgICAgcGF5b3V0VHggPSBhd2FpdCBhZG1pblNlbmRKYyh3YWxsZXQsIGFtb3VudCk7XG4gICAgICBhd2FpdCBtZXJnZVNldHRsZW1lbnRQYXlsb2FkKGFkbWluLCBjbGFpbS5pZCwgeyBwYXlvdXRUeCB9KTtcbiAgICB9XG4gICAgLy8gXHU4QTE4XHU1MTY1XHU3QUQ5XHU1MTY3XHU1RTMzXHU2NzJDXHVGRjA4XHU4QjkzXHU1M0VGXHU3NTI4IEpDIFx1N0FDQlx1NTM3M1x1NTNDRFx1NjYyMFx1RkYwOVx1RkYwQlx1NkExOVx1OEExOCBjb21taXNzaW9uX2xvZ3MgXHU1REYyXHU2RDNFXHU3NjdDXHVGRjBDXHU3Njg2XHU1MUFBXHU3QjQ5XHUzMDAyXG4gICAgLy8gaWRlbXBvdGVuY3lfa2V5IFx1NkNCRlx1NzUyOCBhZG1pbl9wYXlfcGVuZGluZ19jb21taXNzaW9ucyBcdTc2ODQgYGNvbW1pc3Npb24tcGF5b3V0Ojxsb2dfaWQ+YFx1RkYwQ1xuICAgIC8vIFx1OEI5M1x1MzAwQ1x1NTM3M1x1NjY0Mlx1NEUwQVx1OTNDOFx1NzY3Q1x1NjUzRVx1MzAwRFx1ODIwN1x1ODIwQVx1NzY4NFx1MzAwQ1x1N0JBMVx1NzQwNlx1NTRFMVx1NjI3OVx1NkIyMVx1NkQzRVx1NzY3Q1x1MzAwRFx1NEU5Mlx1NzZGOFx1NTFBQVx1N0I0OVx1RkYwQ1x1NEUwRFx1NjcwM1x1OTFDRFx1ODkwN1x1NTE2NVx1NUUzM1x1MzAwMlxuICAgIGF3YWl0IGFkbWluLmZyb20oXCJqY19sZWRnZXJcIikudXBzZXJ0KFxuICAgICAge1xuICAgICAgICB1c2VyX2lkOiBsb2cudXNlcl9pZCxcbiAgICAgICAgZW50cnlfdHlwZTogXCJjb21taXNzaW9uX3BheW91dFwiLFxuICAgICAgICBhbW91bnQsXG4gICAgICAgIGFzc2V0X2lkOiBsb2cuYXNzZXRfaWQsXG4gICAgICAgIGlkZW1wb3RlbmN5X2tleTogYGNvbW1pc3Npb24tcGF5b3V0OiR7bG9nLmlkfWAsXG4gICAgICAgIG1ldGFkYXRhOiB7IGNvbW1pc3Npb25fbG9nX2lkOiBsb2cuaWQsIG9uY2hhaW46IHRydWUsIHR4OiBwYXlvdXRUeCB9LFxuICAgICAgfSxcbiAgICAgIHsgb25Db25mbGljdDogXCJpZGVtcG90ZW5jeV9rZXlcIiwgaWdub3JlRHVwbGljYXRlczogdHJ1ZSB9LFxuICAgICk7XG4gICAgYXdhaXQgYWRtaW5cbiAgICAgIC5mcm9tKFwiY29tbWlzc2lvbl9sb2dzXCIpXG4gICAgICAudXBkYXRlKHsgcGFpZF9hdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH0pXG4gICAgICAuZXEoXCJpZFwiLCBsb2cuaWQpXG4gICAgICAuaXMoXCJwYWlkX2F0XCIsIG51bGwpO1xuICAgIGF3YWl0IGZpbmlzaChhZG1pbiwgY2xhaW0uaWQsIHsgc3RhdHVzOiBcImNvbmZpcm1lZFwiLCB0eF9oYXNoOiBwYXlvdXRUeCA/PyB1bmRlZmluZWQgfSk7XG4gICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDIwMCwgeyBzdGF0dXM6IFwiY29uZmlybWVkXCIsIHR4X2hhc2g6IHBheW91dFR4LCBhbW91bnQgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBhd2FpdCBmaW5pc2goYWRtaW4sIGNsYWltLmlkLCB7IHN0YXR1czogXCJmYWlsZWRcIiwgZXJyb3I6IGVyck1zZyhlKSB9KTtcbiAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNTAyLCB7IGVycm9yOiBgXHU1MjA2XHU2RjY0XHU5M0M4XHU0RTBBXHU3NjdDXHU2NTNFXHU1OTMxXHU2NTU3XHVGRjFBJHtlcnJNc2coZSl9YCB9KTtcbiAgfVxufVxuXG4vKiogXHU0RTAwXHU3RDFBXHU4QThEXHU4Q0ZDXHU3RDUwXHU3Qjk3XHU3OEJBXHU4QThEXHU1RjhDXHVGRjBDYmVzdC1lZmZvcnQgXHU2MjhBXHU4QTcyXHU3QjQ2XHU4Q0ZDXHU4Q0I3XHU2MjQwXHU3NTIyXHU3NTFGXHU3Njg0XHU2M0E4XHU1RUUzXHU1MjA2XHU2RjY0XHUzMDBDXHU1MzczXHU2NjQyXHUzMDBEXHU0RTBBXHU5M0M4XHU3NjdDXHU2NTNFXG4gKlx1RkYwOEFETUlOXHUyMTkyXHU1M0Q3XHU3NkNBXHU0RUJBXHVGRjA5XHUzMDAyXHU1OTMxXHU2NTU3XHU1M0VBXHU1NDFFXHU2Mzg5XHU0RTBEXHU2MkNCXHU1MUZBXHUyMDE0XHUyMDE0XHU2QzkyXHU3NjdDXHU2MjEwXHU3Njg0XHU2NzAzXHU4OEFCXHU2QkNGXHU2NUU1IGNyb24gc3dlZXAgXHU4MjA3XHU1RjhDXHU1M0YwXHU0RTAwXHU5Mzc1XG4gKiBcdTg4RENcdTc2N0NcdTY0QkZcdTU2REVcdUZGMENcdTc4QkFcdTRGRERcdTY3MDBcdTdENDJcdTVGQzVcdTVCOUFcdTUyMzBcdTVFMzNcdTRFMjZcdTRFMEFcdTkzQzhcdTMwMDIgKi9cbmFzeW5jIGZ1bmN0aW9uIHNldHRsZUNvbW1pc3Npb25zRm9yU291cmNlKGFkbWluOiBTdXBhYmFzZUNsaWVudCwgc291cmNlTGVkZ2VySWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB7IGRhdGE6IGxvZ3MgfSA9IGF3YWl0IGFkbWluXG4gICAgLmZyb20oXCJjb21taXNzaW9uX2xvZ3NcIilcbiAgICAuc2VsZWN0KFwiaWQsYmVuZWZpY2lhcnlfaWQsY29tbWlzc2lvbl9hbW91bnQsYXNzZXRfaWRcIilcbiAgICAuZXEoXCJzb3VyY2VfbGVkZ2VyX2lkXCIsIHNvdXJjZUxlZGdlcklkKVxuICAgIC5pcyhcInBhaWRfYXRcIiwgbnVsbCk7XG4gIGZvciAoY29uc3QgbG9nIG9mIGxvZ3MgPz8gW10pIHtcbiAgICBpZiAoIWxvZy5iZW5lZmljaWFyeV9pZCkgY29udGludWU7XG4gICAgY29uc3QgeyByZXNwb25zZSB9ID0gZmFrZVJlc3BvbnNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHNldHRsZUNvbW1pc3Npb25Db3JlKGFkbWluLCByZXNwb25zZSwge1xuICAgICAgICBpZDogbG9nLmlkLFxuICAgICAgICB1c2VyX2lkOiBsb2cuYmVuZWZpY2lhcnlfaWQsXG4gICAgICAgIGFtb3VudDogTnVtYmVyKGxvZy5jb21taXNzaW9uX2Ftb3VudCksXG4gICAgICAgIGFzc2V0X2lkOiBsb2cuYXNzZXRfaWQgPz8gbnVsbCxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogXHU0RUE0XHU3RDY2IGNyb24gLyBcdTVGOENcdTUzRjBcdTg4RENcdTc2N0MgKi9cbiAgICB9XG4gIH1cbn1cblxudHlwZSBSZXZlcnNhbFJlc3VsdCA9IHtcbiAgYmVuZWZpY2lhcnlJZDogc3RyaW5nO1xuICBhcHBsaWVkOiBib29sZWFuO1xuICBkaXJlY3Rpb246IFwib3ZlclwiIHwgXCJ1bmRlclwiIHwgXCJub25lXCI7XG4gIGFtb3VudDogbnVtYmVyO1xuICB0eD86IHN0cmluZztcbiAgZXJyb3I/OiBzdHJpbmc7XG59O1xuXG4vKiogXHU1NUFFXHU0RTAwXHU1M0Q3XHU3NkNBXHU0RUJBXHU3Njg0XHU3MzRFXHU5MUQxXHU2RDNFXHU3NjdDXHUzMDBDXHU2Qzk2XHU2QjYzXHUzMDBEXHVGRjA4XHU2ODIxXHU2QjYzXHU1REVFXHU5ODREXHVGRjA5XHVGRjFBXHU2QkQ0XHU1QzBEXHUzMDBDXHU2MUM5XHU2RDNFXHU3NjdDXHUzMDBEXHVGRjA4Y29tbWlzc2lvbl9sb2dzLnBhaWRfYXRcbiAqIFx1NEUwRFx1NzBCQSBudWxsIFx1NzY4NFx1NjFDOVx1NzY3Q1x1N0UzRFx1NTQ4Q1x1RkYwOVx1ODIwN1x1MzAwQ1x1NUJFNlx1OTY5Qlx1NURGMlx1NzY3Q1x1NjUzRVx1MzAwRFx1RkYwOGpjX2xlZGdlciBcdTc2ODQgY29tbWlzc2lvbl9wYXlvdXQgXHVGRjBCXG4gKiBjb21taXNzaW9uX3JldmVyc2FsIFx1N0UzRFx1NTQ4Q1x1RkYwOVx1RkYwQ1x1OTFEMVx1OTg0RFx1NEUwMFx1NUY4Qlx1NEYzQVx1NjcwRFx1NTY2OFx1N0FFRlx1OTFDRFx1N0I5N1x1RkYwQ1x1N0Q1NVx1NEUwRFx1NEZFMVx1NEVGQlx1NTI0RFx1N0FFRlx1NTBCM1x1NTE2NVx1NzY4NFx1NjU3OFx1NUI1N1x1MzAwMlxuICogICBcdTVDMTFcdTc2N0MgXHUyMTkyIFx1ODhEQ1x1OERCM1x1NURFRVx1OTg0RFx1RkYwQ1x1NEUyNlx1NzUzMSBBRE1JTiBcdTcxQjFcdTkzMjJcdTUzMDVcdTVCRTZcdTk2OUJcdTRFMEFcdTkzQzhcdTYyOEEgSkMgXHU4OERDXHU3NjdDXHU3RDY2XHU1M0Q3XHU3NkNBXHU0RUJBXHUzMDAyXG4gKiAgIFx1NTkxQVx1NzY3QyBcdTIxOTIgXHU0RUU1XHU4Q0EwXHU1NDExIGNvbW1pc3Npb25fcmV2ZXJzYWwgXHU2ODIxXHU2QjYzXHU3QUQ5XHU1MTY3XHU1RTMzXHU2NzJDXHVGRjA4XHU5M0M4XHU0RTBBXHU1REYyXHU1OTFBXHU3NjdDXHU3Njg0IEpDIFx1NzEyMVx1NkNENVx1ODFFQVx1NTJENVx1NTZERVx1NjUzNlx1RkYwQ1xuICogICAgICAgICAgXHU1NkUwIEpDIFx1NTQwOFx1N0QwNFx1Nzk4MVx1NkI2Mlx1NUY5RVx1NEY3Rlx1NzUyOFx1ODAwNVx1OTMyMlx1NTMwNVx1NUYzN1x1NTIzNlx1OEY0OVx1NTFGQVx1RkYwQ1x1NTBDNVx1NjgyMVx1NkI2M1x1N0FEOVx1NTE2N1x1NTNFRlx1NzUyOFx1OTkxOFx1OTg0RFx1RkYwOVx1MzAwMlxuICogXHU2Qzk2XHU2QjYzXHU1RjhDIG93ZWQgPT0gcGFpZFx1MzAwMWRpZmYgXHU2Qjc4XHU5NkY2XHVGRjBDXHU5MUNEXHU4OTA3XHU5RURFXHU2NENBXHU2NzAzXHU5MUNEXHU3Qjk3XHU3MEJBIDAgXHU4MDBDXHU4MUVBXHU1MkQ1XHU3NTY1XHU5MDRFXHVGRjA4XHU1OTI5XHU3MTM2XHU1MUFBXHU3QjQ5XHVGRjA5XHUzMDAyKi9cbmFzeW5jIGZ1bmN0aW9uIHJldmVyc2VDb21taXNzaW9uRm9yQmVuZWZpY2lhcnkoXG4gIGFkbWluOiBTdXBhYmFzZUNsaWVudCxcbiAgYmVuZWZpY2lhcnlJZDogc3RyaW5nLFxuKTogUHJvbWlzZTxSZXZlcnNhbFJlc3VsdD4ge1xuICBjb25zdCBbb3dlZFJlc3VsdCwgcGFpZFJlc3VsdF0gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgYWRtaW5cbiAgICAgIC5mcm9tKFwiY29tbWlzc2lvbl9sb2dzXCIpXG4gICAgICAuc2VsZWN0KFwiY29tbWlzc2lvbl9hbW91bnRcIilcbiAgICAgIC5lcShcImJlbmVmaWNpYXJ5X2lkXCIsIGJlbmVmaWNpYXJ5SWQpXG4gICAgICAubm90KFwicGFpZF9hdFwiLCBcImlzXCIsIG51bGwpLFxuICAgIGFkbWluXG4gICAgICAuZnJvbShcImpjX2xlZGdlclwiKVxuICAgICAgLnNlbGVjdChcImFtb3VudFwiKVxuICAgICAgLmVxKFwidXNlcl9pZFwiLCBiZW5lZmljaWFyeUlkKVxuICAgICAgLmluKFwiZW50cnlfdHlwZVwiLCBbXCJjb21taXNzaW9uX3BheW91dFwiLCBcImNvbW1pc3Npb25fcmV2ZXJzYWxcIl0pLFxuICBdKTtcbiAgY29uc3Qgb3dlZCA9IChvd2VkUmVzdWx0LmRhdGEgPz8gW10pLnJlZHVjZSgoc3VtLCByKSA9PiBzdW0gKyBOdW1iZXIoci5jb21taXNzaW9uX2Ftb3VudCksIDApO1xuICBjb25zdCBwYWlkID0gKHBhaWRSZXN1bHQuZGF0YSA/PyBbXSkucmVkdWNlKChzdW0sIHIpID0+IHN1bSArIE51bWJlcihyLmFtb3VudCksIDApO1xuICBjb25zdCByb3VuZDYgPSAobjogbnVtYmVyKSA9PiBNYXRoLnJvdW5kKG4gKiAxZTYpIC8gMWU2O1xuICBjb25zdCBkaWZmID0gcm91bmQ2KHBhaWQgLSBvd2VkKTtcbiAgaWYgKE1hdGguYWJzKGRpZmYpIDw9IDFlLTYpIHtcbiAgICByZXR1cm4geyBiZW5lZmljaWFyeUlkLCBhcHBsaWVkOiBmYWxzZSwgZGlyZWN0aW9uOiBcIm5vbmVcIiwgYW1vdW50OiAwIH07XG4gIH1cbiAgaWYgKGRpZmYgPCAwKSB7XG4gICAgLy8gXHU1QzExXHU3NjdDXHVGRjFBXHU4OERDXHU4REIzIChvd2VkIC0gcGFpZClcdUZGMENcdTRFMjZcdTVCRTZcdTk2OUJcdTRFMEFcdTkzQzhcdTYyOEEgSkMgXHU1RjlFIEFETUlOIFx1NzFCMVx1OTMyMlx1NTMwNVx1ODhEQ1x1NzY3Q1x1N0Q2Nlx1NTNEN1x1NzZDQVx1NEVCQVx1MzAwMlxuICAgIGNvbnN0IHNob3J0ZmFsbCA9IHJvdW5kNihvd2VkIC0gcGFpZCk7XG4gICAgY29uc3QgeyBkYXRhOiBwcm9mIH0gPSBhd2FpdCBhZG1pblxuICAgICAgLmZyb20oXCJwcm9maWxlc1wiKVxuICAgICAgLnNlbGVjdChcIndhbGxldF9hZGRyZXNzXCIpXG4gICAgICAuZXEoXCJpZFwiLCBiZW5lZmljaWFyeUlkKVxuICAgICAgLm1heWJlU2luZ2xlKCk7XG4gICAgbGV0IHdhbGxldDogQWRkcmVzcztcbiAgICB0cnkge1xuICAgICAgd2FsbGV0ID0gdG9BZGRyZXNzKHByb2Y/LndhbGxldF9hZGRyZXNzLCBcIlx1NTNEN1x1NzZDQVx1NEVCQVx1NUUzM1x1ODY1RlwiKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICByZXR1cm4geyBiZW5lZmljaWFyeUlkLCBhcHBsaWVkOiBmYWxzZSwgZGlyZWN0aW9uOiBcInVuZGVyXCIsIGFtb3VudDogc2hvcnRmYWxsLCBlcnJvcjogZXJyTXNnKGUpIH07XG4gICAgfVxuICAgIGNvbnN0IHR4ID0gYXdhaXQgYWRtaW5TZW5kSmMod2FsbGV0LCBzaG9ydGZhbGwpO1xuICAgIGlmICghdHgpIHRocm93IG5ldyBFcnJvcihcIlx1NTIwNlx1NkY2NFx1ODhEQ1x1NzY3Q1x1OTg0RFx1NUVBNlx1NzBCQSAwXHVGRjBDXHU2NzJBXHU5MDAxXHU1MUZBXHU5M0M4XHU0RTBBXHU0RUE0XHU2NjEzXCIpO1xuICAgIGF3YWl0IGFkbWluLmZyb20oXCJqY19sZWRnZXJcIikuaW5zZXJ0KHtcbiAgICAgIHVzZXJfaWQ6IGJlbmVmaWNpYXJ5SWQsXG4gICAgICBlbnRyeV90eXBlOiBcImNvbW1pc3Npb25fcmV2ZXJzYWxcIixcbiAgICAgIGFtb3VudDogc2hvcnRmYWxsLFxuICAgICAgaWRlbXBvdGVuY3lfa2V5OiBgY29tbWlzc2lvbi1yZXZlcnNlOiR7YmVuZWZpY2lhcnlJZH06JHtEYXRlLm5vdygpfWAsXG4gICAgICBtZXRhZGF0YTogeyBraW5kOiBcInVuZGVyXCIsIHJlYXNvbjogXCJcdTZDOTZcdTZCNjNcdTg4RENcdTc2N0NcdTVDMTFcdTc2N0NcdTUyMDZcdTZGNjRcIiwgdHggfSxcbiAgICB9KTtcbiAgICBhd2FpdCBhZG1pbi5mcm9tKFwib25jaGFpbl9zZXR0bGVtZW50c1wiKS5pbnNlcnQoe1xuICAgICAgYWN0aW9uOiBcImNvbW1pc3Npb25fcmV2ZXJzZVwiLFxuICAgICAgcmVmX2tleTogYGNvbW1pc3Npb25fcmV2ZXJzZToke2JlbmVmaWNpYXJ5SWR9OiR7RGF0ZS5ub3coKX1gLFxuICAgICAgdXNlcl9pZDogYmVuZWZpY2lhcnlJZCxcbiAgICAgIGFtb3VudDogc2hvcnRmYWxsLFxuICAgICAgc3RhdHVzOiBcImNvbmZpcm1lZFwiLFxuICAgICAgdHhfaGFzaDogdHgsXG4gICAgfSk7XG4gICAgcmV0dXJuIHsgYmVuZWZpY2lhcnlJZCwgYXBwbGllZDogdHJ1ZSwgZGlyZWN0aW9uOiBcInVuZGVyXCIsIGFtb3VudDogc2hvcnRmYWxsLCB0eCB9O1xuICB9XG4gIC8vIFx1NTkxQVx1NzY3Q1x1RkYxQVx1NEVFNVx1OENBMFx1NTQxMVx1NkM5Nlx1NkI2M1x1NjgyMVx1NkI2M1x1N0FEOVx1NTE2N1x1NUUzM1x1NjcyQ1x1RkYwOFx1NEUwRFx1NEUwQVx1OTNDOFx1RkYwQ1x1OTNDOFx1NEUwQVx1NTkxQVx1NzY3Q1x1NzY4NCBKQyBcdTcxMjFcdTZDRDVcdTgxRUFcdTUyRDVcdTU2REVcdTY1MzZcdUZGMDlcdTMwMDJcbiAgY29uc3QgZXhjZXNzID0gcm91bmQ2KHBhaWQgLSBvd2VkKTtcbiAgYXdhaXQgYWRtaW4uZnJvbShcImpjX2xlZGdlclwiKS5pbnNlcnQoe1xuICAgIHVzZXJfaWQ6IGJlbmVmaWNpYXJ5SWQsXG4gICAgZW50cnlfdHlwZTogXCJjb21taXNzaW9uX3JldmVyc2FsXCIsXG4gICAgYW1vdW50OiAtZXhjZXNzLFxuICAgIGlkZW1wb3RlbmN5X2tleTogYGNvbW1pc3Npb24tcmV2ZXJzZToke2JlbmVmaWNpYXJ5SWR9OiR7RGF0ZS5ub3coKX1gLFxuICAgIG1ldGFkYXRhOiB7IGtpbmQ6IFwib3ZlclwiLCByZWFzb246IFwiXHU2Qzk2XHU2QjYzXHU2MjYzXHU1NkRFXHU1OTFBXHU3NjdDXHU1MjA2XHU2RjY0XHVGRjA4XHU1MEM1XHU2ODIxXHU2QjYzXHU3QUQ5XHU1MTY3XHU1RTMzXHU2NzJDXHVGRjA5XCIgfSxcbiAgfSk7XG4gIGF3YWl0IGFkbWluLmZyb20oXCJvbmNoYWluX3NldHRsZW1lbnRzXCIpLmluc2VydCh7XG4gICAgYWN0aW9uOiBcImNvbW1pc3Npb25fcmV2ZXJzZVwiLFxuICAgIHJlZl9rZXk6IGBjb21taXNzaW9uX3JldmVyc2U6JHtiZW5lZmljaWFyeUlkfToke0RhdGUubm93KCl9YCxcbiAgICB1c2VyX2lkOiBiZW5lZmljaWFyeUlkLFxuICAgIGFtb3VudDogLWV4Y2VzcyxcbiAgICBzdGF0dXM6IFwiY29uZmlybWVkXCIsXG4gIH0pO1xuICByZXR1cm4geyBiZW5lZmljaWFyeUlkLCBhcHBsaWVkOiB0cnVlLCBkaXJlY3Rpb246IFwib3ZlclwiLCBhbW91bnQ6IGV4Y2VzcyB9O1xufVxuXG4vKiogXHU1MTY4XHU3QUQ5XHU1Rjg1XHU2RDNFXHU3NjdDXHU1MjA2XHU2RjY0XHVGRjA4Y29tbWlzc2lvbl9sb2dzLnBhaWRfYXQgXHU3MEJBIG51bGxcdUZGMDlcdTc2ODRcdTUzNzNcdTY2NDJcdTRFMEFcdTkzQzhcdTg4RENcdTc2N0NcdTc1MzEgY3JvbiBcdTVCOUFcdTY3MUZcbiAqIFx1NjM4M1x1NjNDRlx1MzAwMVx1NEU4Q1x1N0QxQVx1NjIxMFx1NEVBNFx1NUY4Q1x1NTM3M1x1NjY0Mlx1ODlGOFx1NzY3Q1x1MzAwMVx1NEVFNVx1NTNDQVx1NUY4Q1x1NTNGMFx1NEUwMFx1OTM3NVx1NkQzRVx1NzY3Q1x1NTE3MVx1NzUyOFx1MzAwMlx1NkJDRlx1N0I0Nlx1NTFBQVx1N0I0OVx1RkYwOG9uY2hhaW5fc2V0dGxlbWVudHNcbiAqIHJlZl9rZXkgYGNvbW1pc3Npb246PGxvZ19pZD5gICsgamNfbGVkZ2VyIGBjb21taXNzaW9uLXBheW91dDo8bG9nX2lkPmBcdUZGMDlcdUZGMENcdTUzRDdcdTc2Q0FcdTRFQkFcbiAqIFx1NUMxQVx1NjcyQVx1N0Q4MVx1NUI5QVx1OTMyMlx1NTMwNVx1ODAwNVx1NjcwM1x1ODhBQlx1OERGM1x1OTA0RVx1MzAwMVx1NzU1OVx1NUY4NVx1NTE3Nlx1N0Q4MVx1NUI5QVx1NUY4Q1x1NEUwQlx1NkIyMVx1NjM4M1x1NjNDRlx1ODhEQ1x1NEUwQVx1MzAwMmxpbWl0IFx1NjNBN1x1NTIzNlx1NTVBRVx1NkIyMVx1ODY1NVx1NzQwNlx1N0I0Nlx1NjU3OFx1RkYwQ1x1OTA3Rlx1NTE0RFxuICogXHU1NUFFXHU0RTAwXHU4QUNCXHU2QzQyXHU4REQxXHU1OTJBXHU0RTQ1XHVGRjA4XHU1MTc2XHU5OTE4XHU3NTU5XHU1Rjg1XHU0RTBCXHU0RTAwXHU4RjJBIGNyb25cdUZGMDlcdTMwMDIqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN3ZWVwUGVuZGluZ0NvbW1pc3Npb25zKFxuICBhZG1pbjogU3VwYWJhc2VDbGllbnQsXG4gIGxpbWl0ID0gMTAwLFxuICBiZW5lZmljaWFyeUlkcz86IHN0cmluZ1tdLFxuKTogUHJvbWlzZTx7IHNjYW5uZWQ6IG51bWJlcjsgc2V0dGxlZDogbnVtYmVyOyBza2lwcGVkOiBudW1iZXIgfT4ge1xuICBsZXQgcXVlcnkgPSBhZG1pblxuICAgIC5mcm9tKFwiY29tbWlzc2lvbl9sb2dzXCIpXG4gICAgLnNlbGVjdChcImlkLGJlbmVmaWNpYXJ5X2lkLGNvbW1pc3Npb25fYW1vdW50LGFzc2V0X2lkXCIpXG4gICAgLmlzKFwicGFpZF9hdFwiLCBudWxsKVxuICAgIC5ub3QoXCJiZW5lZmljaWFyeV9pZFwiLCBcImlzXCIsIG51bGwpXG4gICAgLmd0KFwiY29tbWlzc2lvbl9hbW91bnRcIiwgMCk7XG4gIGlmIChiZW5lZmljaWFyeUlkcyAmJiBiZW5lZmljaWFyeUlkcy5sZW5ndGggPiAwKSB7XG4gICAgcXVlcnkgPSBxdWVyeS5pbihcImJlbmVmaWNpYXJ5X2lkXCIsIGJlbmVmaWNpYXJ5SWRzKTtcbiAgfVxuICBjb25zdCB7IGRhdGE6IGxvZ3MgfSA9IGF3YWl0IHF1ZXJ5Lm9yZGVyKFwiY3JlYXRlZF9hdFwiLCB7IGFzY2VuZGluZzogdHJ1ZSB9KS5saW1pdChsaW1pdCk7XG4gIGxldCBzZXR0bGVkID0gMDtcbiAgbGV0IHNraXBwZWQgPSAwO1xuICBmb3IgKGNvbnN0IGxvZyBvZiBsb2dzID8/IFtdKSB7XG4gICAgaWYgKCFsb2cuYmVuZWZpY2lhcnlfaWQpIHtcbiAgICAgIHNraXBwZWQgKz0gMTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCB7IHJlc3BvbnNlLCByZWFkIH0gPSBmYWtlUmVzcG9uc2UoKTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgc2V0dGxlQ29tbWlzc2lvbkNvcmUoYWRtaW4sIHJlc3BvbnNlLCB7XG4gICAgICAgIGlkOiBsb2cuaWQsXG4gICAgICAgIHVzZXJfaWQ6IGxvZy5iZW5lZmljaWFyeV9pZCxcbiAgICAgICAgYW1vdW50OiBOdW1iZXIobG9nLmNvbW1pc3Npb25fYW1vdW50KSxcbiAgICAgICAgYXNzZXRfaWQ6IGxvZy5hc3NldF9pZCA/PyBudWxsLFxuICAgICAgfSk7XG4gICAgICBjb25zdCB7IHN0YXR1cyB9ID0gcmVhZCgpO1xuICAgICAgaWYgKHN0YXR1cyA+PSAyMDAgJiYgc3RhdHVzIDwgMzAwKSBzZXR0bGVkICs9IDE7XG4gICAgICBlbHNlIHNraXBwZWQgKz0gMTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHNraXBwZWQgKz0gMTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHsgc2Nhbm5lZDogbG9ncz8ubGVuZ3RoID8/IDAsIHNldHRsZWQsIHNraXBwZWQgfTtcbn1cblxuZXhwb3J0IGRlZmF1bHQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlcihyZXF1ZXN0OiBJbmNvbWluZ01lc3NhZ2UsIHJlc3BvbnNlOiBTZXJ2ZXJSZXNwb25zZSkge1xuICBpZiAocmVxdWVzdC5tZXRob2QgIT09IFwiUE9TVFwiKSB7XG4gICAgcmVzcG9uc2Uuc2V0SGVhZGVyKFwiQWxsb3dcIiwgXCJQT1NUXCIpO1xuICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDUsIHsgZXJyb3I6IFwiTWV0aG9kIG5vdCBhbGxvd2VkXCIgfSk7XG4gIH1cblxuICBjb25zdCBzdXBhYmFzZVVybCA9IHByb2Nlc3MuZW52LlNVUEFCQVNFX1VSTDtcbiAgY29uc3Qgc2VydmljZUtleSA9IHByb2Nlc3MuZW52LlNVUEFCQVNFX1NFUlZJQ0VfUk9MRV9LRVkgPz8gcHJvY2Vzcy5lbnYuU1VQQUJBU0VfU0VDUkVUX0tFWTtcbiAgaWYgKCFzdXBhYmFzZVVybCB8fCAhc2VydmljZUtleSkge1xuICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA1MDMsIHsgZXJyb3I6IFwiUmVsYXllciBcdTVDMUFcdTY3MkFcdThBMkRcdTVCOUEgU3VwYWJhc2UgXHU5MDIzXHU3RERBXCIgfSk7XG4gIH1cbiAgaWYgKCFwcm9jZXNzLmVudi5BRE1JTl9QUklWQVRFX0tFWSkge1xuICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA1MDMsIHsgZXJyb3I6IFwiUmVsYXllciBcdTVDMUFcdTY3MkFcdThBMkRcdTVCOUEgQURNSU5fUFJJVkFURV9LRVlcdUZGMDhcdTVGOENcdTdBRUZcdTcxQjFcdTkzMjJcdTUzMDVcdTc5QzFcdTk0NzBcdUZGMDlcIiB9KTtcbiAgfVxuXG4gIGNvbnN0IGF1dGhIZWFkZXIgPSByZXF1ZXN0LmhlYWRlcnMuYXV0aG9yaXphdGlvbiB8fCBcIlwiO1xuICBjb25zdCB0b2tlbiA9IGF1dGhIZWFkZXIuc3RhcnRzV2l0aChcIkJlYXJlciBcIikgPyBhdXRoSGVhZGVyLnNsaWNlKDcpIDogXCJcIjtcbiAgaWYgKCF0b2tlbikgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMSwgeyBlcnJvcjogXCJcdTdGM0FcdTVDMTFcdTc2N0JcdTUxNjVcdTYxOTFcdThCNDlcIiB9KTtcblxuICBsZXQgYm9keTogeyBhY3Rpb24/OiBzdHJpbmc7IHJlcXVlc3RLZXk/OiBzdHJpbmc7IHBsYWNlbWVudElkPzogc3RyaW5nOyBiZW5lZmljaWFyeUlkcz86IHN0cmluZ1tdOyBhc3NldEtleT86IHN0cmluZzsgZXhwZWN0ZWRBbW91bnQ/OiBzdHJpbmc7IHR4SGFzaD86IHN0cmluZzsgZXZlbnRJZD86IHN0cmluZyB9O1xuICB0cnkge1xuICAgIGJvZHkgPSBhd2FpdCByZWFkQm9keShyZXF1ZXN0KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMCwgeyBlcnJvcjogXCJJbnZhbGlkIHJlcXVlc3QgYm9keVwiIH0pO1xuICB9XG4gIGNvbnN0IGFjdGlvbiA9IGJvZHkuYWN0aW9uO1xuICBpZiAoIWFjdGlvbikgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMCwgeyBlcnJvcjogXCJcdTdGM0FcdTVDMTEgYWN0aW9uXCIgfSk7XG5cbiAgY29uc3QgYWRtaW4gPSBjcmVhdGVDbGllbnQoc3VwYWJhc2VVcmwsIHNlcnZpY2VLZXksIHtcbiAgICBhdXRoOiB7IHBlcnNpc3RTZXNzaW9uOiBmYWxzZSwgYXV0b1JlZnJlc2hUb2tlbjogZmFsc2UgfSxcbiAgfSk7XG5cbiAgY29uc3QgeyBkYXRhOiB1c2VyRGF0YSwgZXJyb3I6IHVzZXJFcnJvciB9ID0gYXdhaXQgYWRtaW4uYXV0aC5nZXRVc2VyKHRva2VuKTtcbiAgY29uc3QgY2FsbGVyID0gdXNlckRhdGE/LnVzZXI7XG4gIGlmICh1c2VyRXJyb3IgfHwgIWNhbGxlcikgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMSwgeyBlcnJvcjogXCJcdTc2N0JcdTUxNjVcdTYxOTFcdThCNDlcdTcxMjFcdTY1NDhcIiB9KTtcblxuICBjb25zdCB7IGRhdGE6IGNhbGxlclByb2ZpbGUgfSA9IGF3YWl0IGFkbWluXG4gICAgLmZyb20oXCJwcm9maWxlc1wiKVxuICAgIC5zZWxlY3QoXCJpZCxhZ2VuY3lfcm9sZSxyb2xlLHdhbGxldF9hZGRyZXNzXCIpXG4gICAgLmVxKFwiaWRcIiwgY2FsbGVyLmlkKVxuICAgIC5tYXliZVNpbmdsZSgpO1xuICBpZiAoIWNhbGxlclByb2ZpbGUpIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDMsIHsgZXJyb3I6IFwiXHU2MjdFXHU0RTBEXHU1MjMwXHU1RTczXHU1M0YwXHU1RTMzXHU4NjVGXCIgfSk7XG5cbiAgLy8gXHU1QkVCXHU1MTY1XHU1NzhCIHJlbGF5ZXIgXHU4QUNCXHU2QzQyXHU5ODA2XHU2MjRCXHU4OUY4XHU3NjdDXHU0RTAwXHU2QjIxXHU2QTVGXHU2NzAzXHU1RjBGXHU4MUVBXHU1MkQ1XHU4OERDXHU3NjdDXHUzMDAyXHU1NTJGXHU4QjgwXHU1NkRFXHU2NTM2XHU2RTA1XHU1NUFFXHU0RTBEXHU4OUY4XHU3NjdDXHU5ODREXHU1OTE2XHU5M0M4XHU0RTBBXHU1QkVCXHU1MTY1XHUzMDAyXG4gIGlmIChhY3Rpb24gPT09IFwibGVnYWN5LXJlY2xhaW0tbGlzdFwiIHx8IGFjdGlvbiA9PT0gXCJsZWdhY3ktcmVjbGFpbVwiKSB7XG4gICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQxMCwgeyBlcnJvcjogXCJcdTgyMEFcdThDQzdcdTc1MjJcdTY3RTVcdThBNjJcdTgyMDdcdTU2REVcdTY1MzZcdTVERjJcdTUwNUNcdTc1MjhcIiB9KTtcbiAgfVxuICBpZiAoYWN0aW9uID09PSBcIndpcmUtY29udHJhY3RzXCIpIHtcbiAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDEwLCB7IGVycm9yOiBcIlx1NkI2NFx1OEEyRFx1NUI5QVx1NURGMlx1NTA1Q1x1NzUyOFx1RkYwQ1JXQSBcdTRGN0ZcdTc1MjhcdTc2RUVcdTUyNEQgRmFjdG9yeVwiIH0pO1xuICB9XG4gICAgICBjb25zdCBlc2Nyb3dBY3Rpb25zID0gbmV3IFNldChbXG4gICAgICAgIFwicmVnaXN0ZXItZXNjcm93LW9yZGVyXCIsXG4gICAgICAgIFwic2V0dGxlLWVzY3Jvdy1maWxsXCIsXG4gICAgICAgIFwicmVnaXN0ZXItZXNjcm93LWNhbmNlbFwiLFxuICAgICAgICBcImFkbWluLWVzY3Jvdy1zdGF0dXNcIixcbiAgICAgICAgXCJhZG1pbi1yZXRyeS1lc2Nyb3ctZXZlbnRcIixcbiAgICAgIF0pO1xuICAgICAgaWYgKCFlc2Nyb3dBY3Rpb25zLmhhcyhhY3Rpb24pKSBhd2FpdCBtYXliZU9wcG9ydHVuaXN0aWNTd2VlcChhZG1pbik7XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGlmIChhY3Rpb24gPT09IFwicmVnaXN0ZXItZXNjcm93LW9yZGVyXCIpIHtcbiAgICAgICAgICBpZiAoIWJvZHkudHhIYXNoKSByZXR1cm4ganNvbihyZXNwb25zZSwgNDAwLCB7IGVycm9yOiBcIlx1N0YzQVx1NUMxMVx1NjM5Qlx1NTVBRVx1NEVBNFx1NjYxM1x1OTZEQ1x1NkU0QVwiIH0pO1xuICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHByb2Nlc3NFc2Nyb3dPcmRlckNyZWF0ZWQoYWRtaW4sIGJvZHkudHhIYXNoLCBjYWxsZXJQcm9maWxlKTtcbiAgICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCByZXN1bHQpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChhY3Rpb24gPT09IFwic2V0dGxlLWVzY3Jvdy1maWxsXCIpIHtcbiAgICAgICAgICBpZiAoIWJvZHkudHhIYXNoKSByZXR1cm4ganNvbihyZXNwb25zZSwgNDAwLCB7IGVycm9yOiBcIlx1N0YzQVx1NUMxMVx1NjIxMFx1NEVBNFx1NEVBNFx1NjYxM1x1OTZEQ1x1NkU0QVwiIH0pO1xuICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHByb2Nlc3NFc2Nyb3dGaWxsKGFkbWluLCBib2R5LnR4SGFzaCwgY2FsbGVyUHJvZmlsZSk7XG4gICAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDIwMCwgcmVzdWx0KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoYWN0aW9uID09PSBcInJlZ2lzdGVyLWVzY3Jvdy1jYW5jZWxcIikge1xuICAgICAgICAgIGlmICghYm9keS50eEhhc2gpIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDAsIHsgZXJyb3I6IFwiXHU3RjNBXHU1QzExXHU1M0Q2XHU2RDg4XHU0RUE0XHU2NjEzXHU5NkRDXHU2RTRBXCIgfSk7XG4gICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcHJvY2Vzc0VzY3Jvd0NhbmNlbChhZG1pbiwgYm9keS50eEhhc2gsIGNhbGxlclByb2ZpbGUpO1xuICAgICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCAyMDAsIHJlc3VsdCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGFjdGlvbiA9PT0gXCJhZG1pbi1lc2Nyb3ctc3RhdHVzXCIpIHtcbiAgICAgICAgICBpZiAoIWlzQWRtaW5Qcm9maWxlKGNhbGxlclByb2ZpbGUpKSByZXR1cm4ganNvbihyZXNwb25zZSwgNDAzLCB7IGVycm9yOiBcIlx1NTBDNVx1OTY1MFx1N0JBMVx1NzQwNlx1NTRFMVx1NTdGN1x1ODg0Q1wiIH0pO1xuICAgICAgICAgIGNvbnN0IFtvcmRlcnNSZXN1bHQsIGxlZ2FjeVJlc3VsdCwgZXZlbnRzUmVzdWx0LCBhdWRpdFJlc3VsdF0gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICAgICAgICBhZG1pbi5mcm9tKFwicDJwX29yZGVyc1wiKVxuICAgICAgICAgICAgICAuc2VsZWN0KFwiaWQsYXNzZXRfaWQsc2lkZSxwcmljZSxyZW1haW5pbmdfcXVhbnRpdHksZXNjcm93X2NoYWluX29yZGVyX2lkLGVzY3Jvd190b2tlbl9hZGRyZXNzLGVzY3Jvd19jdXJyZW5jeV9hZGRyZXNzXCIpXG4gICAgICAgICAgICAgIC5lcShcImVzY3Jvd19tb2RlXCIsIFwiZXNjcm93XCIpXG4gICAgICAgICAgICAgIC5pbihcInN0YXR1c1wiLCBbXCJvcGVuXCIsIFwicGFydGlhbGx5X2ZpbGxlZFwiXSksXG4gICAgICAgICAgICBhZG1pbi5mcm9tKFwicDJwX29yZGVyc1wiKS5zZWxlY3QoXCJpZFwiLCB7IGNvdW50OiBcImV4YWN0XCIsIGhlYWQ6IHRydWUgfSlcbiAgICAgICAgICAgICAgLmVxKFwiZXNjcm93X21vZGVcIiwgXCJsZWdhY3lcIikuaW4oXCJzdGF0dXNcIiwgW1wib3BlblwiLCBcInBhcnRpYWxseV9maWxsZWRcIl0pLFxuICAgICAgICAgICAgYWRtaW4uZnJvbShcInAycF9lc2Nyb3dfZXZlbnRzXCIpXG4gICAgICAgICAgICAgIC5zZWxlY3QoXCJ0eF9oYXNoLGV2ZW50X3R5cGUsc3RhdHVzLGVycm9yLHVzZXJfaWQsY3JlYXRlZF9hdFwiKVxuICAgICAgICAgICAgICAuaW4oXCJzdGF0dXNcIiwgW1wicGVuZGluZ1wiLCBcImZhaWxlZFwiXSlcbiAgICAgICAgICAgICAgLm9yZGVyKFwiY3JlYXRlZF9hdFwiLCB7IGFzY2VuZGluZzogZmFsc2UgfSlcbiAgICAgICAgICAgICAgLmxpbWl0KDUwKSxcbiAgICAgICAgICAgIGFkbWluLmZyb20oXCJwMnBfZXNjcm93X2N1dG92ZXJfYXVkaXRcIikuc2VsZWN0KFwib3JkZXJfaWRcIiwgeyBjb3VudDogXCJleGFjdFwiLCBoZWFkOiB0cnVlIH0pLFxuICAgICAgICAgIF0pO1xuICAgICAgICAgIGNvbnN0IGVycm9yID0gb3JkZXJzUmVzdWx0LmVycm9yID8/IGxlZ2FjeVJlc3VsdC5lcnJvciA/PyBldmVudHNSZXN1bHQuZXJyb3IgPz8gYXVkaXRSZXN1bHQuZXJyb3I7XG4gICAgICAgICAgaWYgKGVycm9yKSByZXR1cm4ganNvbihyZXNwb25zZSwgNTAwLCB7IGVycm9yOiBgXHU4QTE3XHU3QkExXHU3QTNEXHU2ODM4XHU4Q0M3XHU2NTk5XHU4QjgwXHU1M0Q2XHU1OTMxXHU2NTU3XHVGRjFBJHtlcnJvci5tZXNzYWdlfWAgfSk7XG4gICAgICAgICAgY29uc3Qgb3JkZXJzID0gb3JkZXJzUmVzdWx0LmRhdGEgPz8gW107XG4gICAgICAgICAgY29uc3QgZXhwZWN0ZWQgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICAgICAgICAgIGZvciAoY29uc3Qgb3JkZXIgb2Ygb3JkZXJzKSB7XG4gICAgICAgICAgICBjb25zdCB0b2tlbiA9IG9yZGVyLnNpZGUgPT09IFwic2VsbFwiID8gb3JkZXIuZXNjcm93X3Rva2VuX2FkZHJlc3MgOiBvcmRlci5lc2Nyb3dfY3VycmVuY3lfYWRkcmVzcztcbiAgICAgICAgICAgIGlmICghdG9rZW4pIGNvbnRpbnVlO1xuICAgICAgICAgICAgY29uc3QgYW1vdW50ID0gb3JkZXIuc2lkZSA9PT0gXCJzZWxsXCJcbiAgICAgICAgICAgICAgPyBOdW1iZXIob3JkZXIucmVtYWluaW5nX3F1YW50aXR5KVxuICAgICAgICAgICAgICA6IE51bWJlcihvcmRlci5wcmljZSkgKiBOdW1iZXIob3JkZXIucmVtYWluaW5nX3F1YW50aXR5KTtcbiAgICAgICAgICAgIGV4cGVjdGVkLnNldCh0b2tlbi50b0xvd2VyQ2FzZSgpLCAoZXhwZWN0ZWQuZ2V0KHRva2VuLnRvTG93ZXJDYXNlKCkpID8/IDApICsgYW1vdW50KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgbG9ja2VkQmFsYW5jZXMgPSBQMlBfRVNDUk9XX0FERFJFU1NcbiAgICAgICAgICAgID8gYXdhaXQgUHJvbWlzZS5hbGwoWy4uLmV4cGVjdGVkLmVudHJpZXMoKV0ubWFwKGFzeW5jIChbdG9rZW4sIGRhdGFiYXNlQW1vdW50XSkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IGFkZHJlc3MgPSB0b0FkZHJlc3ModG9rZW4sIFwiXHU4QTE3XHU3QkExXHU0RUUzXHU1RTYzXCIpO1xuICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICBjb25zdCBsb2NrZWQgPSBhd2FpdCBnZXRQMlBFc2Nyb3dMb2NrZWQoYWRkcmVzcyk7XG4gICAgICAgICAgICAgICAgICByZXR1cm4geyB0b2tlbjogYWRkcmVzcywgZGF0YWJhc2VBbW91bnQsIGNoYWluQW1vdW50OiBOdW1iZXIoZm9ybWF0VW5pdHMobG9ja2VkLCAxOCkpLCBlcnJvcjogbnVsbCB9O1xuICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4geyB0b2tlbjogYWRkcmVzcywgZGF0YWJhc2VBbW91bnQsIGNoYWluQW1vdW50OiBudWxsLCBlcnJvcjogZXJyTXNnKGVycm9yKSB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSkpXG4gICAgICAgICAgICA6IFtdO1xuICAgICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCAyMDAsIHtcbiAgICAgICAgICAgIGNvbmZpZ3VyZWQ6IEJvb2xlYW4oUDJQX0VTQ1JPV19BRERSRVNTKSxcbiAgICAgICAgICAgIGFjdGl2ZUVzY3Jvd09yZGVyczogb3JkZXJzLmxlbmd0aCxcbiAgICAgICAgICAgIGFjdGl2ZUxlZ2FjeU9yZGVyczogbGVnYWN5UmVzdWx0LmNvdW50ID8/IDAsXG4gICAgICAgICAgICBwZW5kaW5nRXZlbnRzOiBldmVudHNSZXN1bHQuZGF0YT8ubGVuZ3RoID8/IDAsXG4gICAgICAgICAgICBjYW5jZWxsZWRMZWdhY3lPcmRlcnM6IGF1ZGl0UmVzdWx0LmNvdW50ID8/IDAsXG4gICAgICAgICAgICBsb2NrZWRCYWxhbmNlcyxcbiAgICAgICAgICAgIGV2ZW50czogZXZlbnRzUmVzdWx0LmRhdGEgPz8gW10sXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGFjdGlvbiA9PT0gXCJhZG1pbi1yZXRyeS1lc2Nyb3ctZXZlbnRcIikge1xuICAgICAgICAgIGlmICghaXNBZG1pblByb2ZpbGUoY2FsbGVyUHJvZmlsZSkpIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDMsIHsgZXJyb3I6IFwiXHU1MEM1XHU5NjUwXHU3QkExXHU3NDA2XHU1NEUxXHU1N0Y3XHU4ODRDXCIgfSk7XG4gICAgICAgICAgY29uc3QgZXZlbnRJZCA9IGJvZHkuZXZlbnRJZD8udHJpbSgpO1xuICAgICAgICAgIGlmICghZXZlbnRJZCkgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMCwgeyBlcnJvcjogXCJcdTdGM0FcdTVDMTFcdThBMTdcdTdCQTFcdTRFOEJcdTRFRjZcdThCNThcdTUyMjVcdTc4QkNcIiB9KTtcbiAgICAgICAgICBjb25zdCB7IGRhdGE6IGV2ZW50LCBlcnJvciB9ID0gYXdhaXQgYWRtaW4uZnJvbShcInAycF9lc2Nyb3dfZXZlbnRzXCIpXG4gICAgICAgICAgICAuc2VsZWN0KFwidHhfaGFzaCxldmVudF90eXBlLHN0YXR1c1wiKVxuICAgICAgICAgICAgLmVxKFwidHhfaGFzaFwiLCBldmVudElkKVxuICAgICAgICAgICAgLm1heWJlU2luZ2xlKCk7XG4gICAgICAgICAgaWYgKGVycm9yIHx8ICFldmVudCkgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwNCwgeyBlcnJvcjogXCJcdTYyN0VcdTRFMERcdTUyMzBcdTVGODVcdTRGRUVcdTVGQTlcdTc2ODRcdThBMTdcdTdCQTFcdTRFOEJcdTRFRjZcIiB9KTtcbiAgICAgICAgICBpZiAoZXZlbnQuc3RhdHVzID09PSBcImZpbmFsaXplZFwiKSByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IHN0YXR1czogXCJmaW5hbGl6ZWRcIiwgaWRlbXBvdGVudDogdHJ1ZSB9KTtcbiAgICAgICAgICBjb25zdCByZXN1bHQgPSBldmVudC5ldmVudF90eXBlID09PSBcIm9yZGVyX2NyZWF0ZWRcIlxuICAgICAgICAgICAgPyBhd2FpdCBwcm9jZXNzRXNjcm93T3JkZXJDcmVhdGVkKGFkbWluLCBldmVudC50eF9oYXNoLCBudWxsKVxuICAgICAgICAgICAgOiBldmVudC5ldmVudF90eXBlID09PSBcIm9yZGVyX2ZpbGxlZFwiXG4gICAgICAgICAgICAgID8gYXdhaXQgcHJvY2Vzc0VzY3Jvd0ZpbGwoYWRtaW4sIGV2ZW50LnR4X2hhc2gsIG51bGwpXG4gICAgICAgICAgICAgIDogYXdhaXQgcHJvY2Vzc0VzY3Jvd0NhbmNlbChhZG1pbiwgZXZlbnQudHhfaGFzaCwgbnVsbCk7XG4gICAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDIwMCwgcmVzdWx0KTtcbiAgICAgICAgfVxuXG4gICAgLy8gLS0tLSBcdTRFMDBcdTZCMjFcdTYwMjdcdUZGMUFcdTYyOEFcdTVCNTBcdTU0MDhcdTdEMDRcdTRGNERcdTU3NDBcdTVCRUJcdTkwMzIgUldBIFx1NkJDRFx1NTQwOFx1N0QwNFx1RkYwOFx1NTBDNVx1OTY1MFx1N0JBMVx1NzQwNlx1NTRFMVx1RkYwOS0tLS1cbiAgICBpZiAoYWN0aW9uID09PSBcIndpcmUtY29udHJhY3RzXCIpIHtcbiAgICAgIGlmICghaXNBZG1pblByb2ZpbGUoY2FsbGVyUHJvZmlsZSkpIHtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMywgeyBlcnJvcjogXCJcdTUwQzVcdTk2NTBcdTdCQTFcdTc0MDZcdTU0RTFcdTU3RjdcdTg4NENcIiB9KTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCB3aXJlUndhQ29udHJhY3RzKCk7XG4gICAgICAvLyBcdTUzRUFcdTYyOEFcdTMwMENcdTc3MUZcdTZCNjNcdTc2ODRcdTkzQzhcdTRFMEFcdTRFQTRcdTY2MTNcdTk2RENcdTZFNEFcdTMwMERcdTVCRUJcdTkwMzIgdHhfaGFzaCBcdTZCMDRcdTRGNERcdUZGMENcImFscmVhZHktc2V0XCIvXCJmYWlsZWRcIi9cInVua25vd25cIlxuICAgICAgLy8gXHU5MDE5XHU0RTlCXHU3MkMwXHU2MTRCXHU1QjU3XHU0RTMyXHU0RTBEXHU2NjJGXHU5NkRDXHU2RTRBXHVGRjBDXHU0RTBEXHU2MUM5XHU1ODVFXHU5MDMyXHU4QTcyXHU2QjA0XHU0RjREXHUzMDAyXG4gICAgICBjb25zdCByZWFsSGFzaCA9XG4gICAgICAgIFtyZXN1bHRzLnN1YnNjcmlwdGlvbiwgcmVzdWx0cy5tYXJrZXRdLmZpbmQoXG4gICAgICAgICAgKHZhbHVlKSA9PiB0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIgJiYgdmFsdWUuc3RhcnRzV2l0aChcIjB4XCIpLFxuICAgICAgICApID8/IG51bGw7XG4gICAgICBhd2FpdCBhZG1pbi5mcm9tKFwib25jaGFpbl9zZXR0bGVtZW50c1wiKS5pbnNlcnQoe1xuICAgICAgICBhY3Rpb246IFwid2lyZV9jb250cmFjdHNcIixcbiAgICAgICAgcmVmX2tleTogYHdpcmVfY29udHJhY3RzOiR7RGF0ZS5ub3coKX1gLFxuICAgICAgICB1c2VyX2lkOiBjYWxsZXIuaWQsXG4gICAgICAgIHN0YXR1czogXCJjb25maXJtZWRcIixcbiAgICAgICAgdHhfaGFzaDogcmVhbEhhc2gsXG4gICAgICAgIHBheWxvYWQ6IHJlc3VsdHMsXG4gICAgICB9KTtcbiAgICAgIC8vIG1hcmtldEVycm9yIFx1NUI1OFx1NTcyOFx1NjY0MiBvaz1mYWxzZVx1RkYwQ1x1OEI5M1x1NTI0RFx1N0FFRlx1OTg2Rlx1NzkzQVx1MzAwQ1x1NEUwMFx1N0QxQVx1NjIxMFx1NTI5Rlx1MzAwMVx1NEU4Q1x1N0QxQVx1NTZFMFx1NTQwOFx1N0QwNFx1N0YzQVx1OTY3N1x1NTkzMVx1NjU1N1x1MzAwRFx1MzAwMlxuICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDIwMCwgeyBvazogIXJlc3VsdHMubWFya2V0RXJyb3IsIHJlc3VsdHMsIHJlbGF5ZXI6IHJlbGF5ZXJBZGRyZXNzKCkgfSk7XG4gICAgfVxuXG4gICAgLy8gLS0tLSBcdTdCQTFcdTc0MDZcdTU0RTFcdUZGMUFcdTUzRUFcdTY3RTVcdThBNjJcdTYyNDBcdTkwNzhcdTRFRTNcdTc0MDZcdTc2ODRcdTY1MzZcdTZCM0VcdTkzMjJcdTUzMDVcdUZGMENcdTkwN0ZcdTUxNERcdTU3MjhcdTcwMEZcdTg5QkRcdTU2NjhcdThGMDlcdTUxNjVcdTYyNDBcdTY3MDlcdTc1MjhcdTYyMzZcdTU3MzBcdTU3NDBcdTMwMDItLS0tXG4gICAgaWYgKGFjdGlvbiA9PT0gXCJhZG1pbi1hZ2VudC13YWxsZXRcIikge1xuICAgICAgaWYgKCFpc0FkbWluUHJvZmlsZShjYWxsZXJQcm9maWxlKSkge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDAzLCB7IGVycm9yOiBcIlx1NTBDNVx1OTY1MFx1N0JBMVx1NzQwNlx1NTRFMVx1NTdGN1x1ODg0Q1wiIH0pO1xuICAgICAgfVxuICAgICAgY29uc3QgcmVjaXBpZW50SWQgPSAoYm9keSBhcyB7IHJlY2lwaWVudElkPzogc3RyaW5nIH0pLnJlY2lwaWVudElkPy50cmltKCk7XG4gICAgICBpZiAoIXJlY2lwaWVudElkKSByZXR1cm4ganNvbihyZXNwb25zZSwgNDAwLCB7IGVycm9yOiBcIlx1OEFDQlx1NTE0OFx1OTA3OFx1NjRDN1x1NEVFM1x1NzQwNlwiIH0pO1xuICAgICAgY29uc3QgeyBkYXRhOiByZWNpcGllbnQgfSA9IGF3YWl0IGFkbWluXG4gICAgICAgIC5mcm9tKFwicHJvZmlsZXNcIilcbiAgICAgICAgLnNlbGVjdChcImlkLGFnZW5jeV9yb2xlLHdhbGxldF9hZGRyZXNzXCIpXG4gICAgICAgIC5lcShcImlkXCIsIHJlY2lwaWVudElkKVxuICAgICAgICAubWF5YmVTaW5nbGUoKTtcbiAgICAgIGlmICghcmVjaXBpZW50IHx8ICFTdHJpbmcocmVjaXBpZW50LmFnZW5jeV9yb2xlID8/IFwiXCIpLmluY2x1ZGVzKFwiXHU0RUUzXHU3NDA2XCIpKSB7XG4gICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDQsIHsgZXJyb3I6IFwiXHU2MjdFXHU0RTBEXHU1MjMwXHU2NzA5XHU2NTQ4XHU3Njg0XHU0RUUzXHU3NDA2XHU1RTMzXHU4NjVGXCIgfSk7XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IHdhbGxldDogdG9BZGRyZXNzKHJlY2lwaWVudC53YWxsZXRfYWRkcmVzcywgXCJcdTRFRTNcdTc0MDZcdTVFMzNcdTg2NUZcIikgfSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MjIsIHsgZXJyb3I6IGVyck1zZyhlKSB9KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyAtLS0tIFx1NEY3Rlx1NzUyOFx1ODAwNVx1NjdFNVx1OEE2Mlx1RkYwRlx1NTZERVx1NjUzNlx1ODFFQVx1NURGMVx1NzY4NFx1ODIwQSBBRVx1MzAwMVJXQVx1RkYxQVx1NjU3OFx1OTFDRlx1NzUzMVx1NjcyQ1x1NEVCQVx1NkI3N1x1NTNGMlx1NUUzM1x1NjcyQ1x1MzAwMVx1NEVDQVx1NjVFNVx1NEZERFx1NzU1OVx1OTg0RFx1ODIwN1x1OTNDOFx1NEUwQVx1OTkxOFx1OTg0RFx1OTFDRFx1N0I5N1x1MzAwMi0tLS1cbiAgICBpZiAoYWN0aW9uID09PSBcImxlZ2FjeS1yZWNsYWltLWxpc3RcIiB8fCBhY3Rpb24gPT09IFwibGVnYWN5LXJlY2xhaW1cIikge1xuICAgICAgbGV0IHdhbGxldDogQWRkcmVzcztcbiAgICAgIHRyeSB7XG4gICAgICAgIHdhbGxldCA9IHRvQWRkcmVzcyhjYWxsZXJQcm9maWxlLndhbGxldF9hZGRyZXNzLCBcIlx1NEY3Rlx1NzUyOFx1ODAwNVx1NUUzM1x1ODY1RlwiKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQyMiwgeyBlcnJvcjogZXJyTXNnKGUpIH0pO1xuICAgICAgfVxuXG4gICAgICBpZiAoYWN0aW9uID09PSBcImxlZ2FjeS1yZWNsYWltLWxpc3RcIikge1xuICAgICAgICBhd2FpdCByZWNvbmNpbGVMZWdhY3lSZWNsYWltUmVjZWlwdHMoYWRtaW4sIGNhbGxlci5pZCk7XG4gICAgICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSBhd2FpdCByZWFkTGVnYWN5UmVjbGFpbUNhbmRpZGF0ZXMoYWRtaW4sIGNhbGxlci5pZCwgd2FsbGV0KTtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDIwMCwgeyBjdXRvZmY6IExFR0FDWV9SRUNMQUlNX0NVVE9GRiwgY2FuZGlkYXRlcyB9KTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgYXNzZXRLZXkgPSBib2R5LmFzc2V0S2V5Py50cmltKCk7XG4gICAgICBjb25zdCBleHBlY3RlZEFtb3VudCA9IGJvZHkuZXhwZWN0ZWRBbW91bnQ/LnRyaW0oKTtcbiAgICAgIGNvbnN0IHZhbGlkQXNzZXRLZXkgPSBhc3NldEtleSAmJiAvXig/OmxlZ2FjeS1hZXxsZWdhY3ktcndhOjB4W2EtZjAtOV17NDB9fGxlZ2FjeS1yd2EtcGxhY2VtZW50OltBLVphLXowLTlfLV17MSwxMjB9KSQvLnRlc3QoYXNzZXRLZXkpO1xuICAgICAgaWYgKCF2YWxpZEFzc2V0S2V5IHx8ICFleHBlY3RlZEFtb3VudCB8fCBleHBlY3RlZEFtb3VudC5sZW5ndGggPiA4MCB8fCAhL14oPzowfFsxLTldXFxkKikoPzpcXC5cXGR7MSwzNn0pPyQvLnRlc3QoZXhwZWN0ZWRBbW91bnQpKSB7XG4gICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDAsIHsgZXJyb3I6IFwiXHU1NkRFXHU2NTM2XHU4Q0M3XHU3NTIyXHU2MjE2XHU2NTc4XHU5MUNGXHU2ODNDXHU1RjBGXHU5MzJGXHU4QUE0XHVGRjBDXHU4QUNCXHU5MUNEXHU2NUIwXHU2NTc0XHU3NDA2XHU1RjhDXHU1MThEXHU4QTY2XCIgfSk7XG4gICAgICB9XG4gICAgICBjb25zdCByZWZLZXkgPSBgbGVnYWN5X2Fzc2V0X3JlY2xhaW06JHtjYWxsZXIuaWR9OiR7YXNzZXRLZXl9YDtcbiAgICAgIGNvbnN0IHsgZGF0YTogZXhpc3RpbmdTZXR0bGVtZW50LCBlcnJvcjogc2V0dGxlbWVudFJlYWRFcnJvciB9ID0gYXdhaXQgYWRtaW5cbiAgICAgICAgLmZyb20oXCJvbmNoYWluX3NldHRsZW1lbnRzXCIpXG4gICAgICAgIC5zZWxlY3QoXCJpZCxhY3Rpb24sc3RhdHVzLHR4X2hhc2gsdXNlcl9pZCxhc3NldF9pZCxhbW91bnQscGF5bG9hZCx1cGRhdGVkX2F0XCIpXG4gICAgICAgIC5lcShcInJlZl9rZXlcIiwgcmVmS2V5KVxuICAgICAgICAubWF5YmVTaW5nbGUoKTtcbiAgICAgIGxldCBzZXR0bGVtZW50ID0gZXhpc3RpbmdTZXR0bGVtZW50O1xuICAgICAgaWYgKHNldHRsZW1lbnRSZWFkRXJyb3IpIHRocm93IG5ldyBFcnJvcihgXHU4QjgwXHU1M0Q2XHU1NkRFXHU2NTM2XHU3MkMwXHU2MTRCXHU1OTMxXHU2NTU3XHVGRjFBJHtzZXR0bGVtZW50UmVhZEVycm9yLm1lc3NhZ2V9YCk7XG5cbiAgICAgIGlmIChzZXR0bGVtZW50ICYmIChzZXR0bGVtZW50LmFjdGlvbiAhPT0gXCJhZV9yZWNsYWltX2xlZ2FjeVwiIHx8IHNldHRsZW1lbnQudXNlcl9pZCAhPT0gY2FsbGVyLmlkIHx8IHNldHRsZW1lbnQuYXNzZXRfaWQgIT09IGFzc2V0S2V5KSkge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDA5LCB7IGVycm9yOiBcIlx1NTZERVx1NjUzNlx1OEI1OFx1NTIyNVx1NzhCQ1x1OENDN1x1NjU5OVx1NEUwRFx1NEUwMFx1ODFGNFx1RkYwQ1x1OEFDQlx1ODA2Rlx1N0U2Qlx1NUJBMlx1NjcwRFwiIH0pO1xuICAgICAgfVxuICAgICAgaWYgKHNldHRsZW1lbnQ/LnN0YXR1cyA9PT0gXCJjb25maXJtZWRcIikge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IHN0YXR1czogXCJjb25maXJtZWRcIiwgdHhIYXNoOiBzZXR0bGVtZW50LnR4X2hhc2gsIGFtb3VudDogU3RyaW5nKHNldHRsZW1lbnQuYW1vdW50ID8/IFwiMFwiKSB9KTtcbiAgICAgIH1cbiAgICAgIGlmIChzZXR0bGVtZW50Py5zdGF0dXMgPT09IFwicGVuZGluZ1wiKSB7XG4gICAgICAgIGlmICghc2V0dGxlbWVudC50eF9oYXNoKSB7XG4gICAgICAgICAgY29uc3Qgc3RhbGVCZWZvcmUgPSBuZXcgRGF0ZShEYXRlLm5vdygpIC0gNSAqIDYwXzAwMCkudG9JU09TdHJpbmcoKTtcbiAgICAgICAgICBpZiAobmV3IERhdGUoc2V0dGxlbWVudC51cGRhdGVkX2F0KS5nZXRUaW1lKCkgPj0gRGF0ZS5wYXJzZShzdGFsZUJlZm9yZSkpIHtcbiAgICAgICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDksIHsgc3RhdHVzOiBcInBlbmRpbmdcIiwgZXJyb3I6IFwiXHU2QjY0XHU4Q0M3XHU3NTIyXHU1REYyXHU2NzA5XHU1NkRFXHU2NTM2XHU4QUNCXHU2QzQyXHU4NjU1XHU3NDA2XHU0RTJEXHVGRjBDXHU4QUNCXHU3QTBEXHU1RjhDXHU5MUNEXHU2NUIwXHU2NTc0XHU3NDA2XCIgfSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IHsgZGF0YTogc3RhbGVDbGFpbSwgZXJyb3IgfSA9IGF3YWl0IGFkbWluXG4gICAgICAgICAgICAuZnJvbShcIm9uY2hhaW5fc2V0dGxlbWVudHNcIilcbiAgICAgICAgICAgIC51cGRhdGUoeyBzdGF0dXM6IFwiZmFpbGVkXCIsIGVycm9yOiBcIlx1NTZERVx1NjUzNlx1OEFDQlx1NkM0Mlx1OTAzRVx1NjY0Mlx1NEUxNFx1NjcyQVx1OTAwMVx1NTFGQVx1OTNDOFx1NEUwQVx1NEVBNFx1NjYxM1x1RkYwQ1x1NTNFRlx1NUI4OVx1NTE2OFx1OTFDRFx1OEE2NlwiLCB1cGRhdGVkX2F0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkgfSlcbiAgICAgICAgICAgIC5lcShcImlkXCIsIHNldHRsZW1lbnQuaWQpXG4gICAgICAgICAgICAuZXEoXCJzdGF0dXNcIiwgXCJwZW5kaW5nXCIpXG4gICAgICAgICAgICAuaXMoXCJ0eF9oYXNoXCIsIG51bGwpXG4gICAgICAgICAgICAubHQoXCJ1cGRhdGVkX2F0XCIsIHN0YWxlQmVmb3JlKVxuICAgICAgICAgICAgLnNlbGVjdChcImlkXCIpXG4gICAgICAgICAgICAubWF5YmVTaW5nbGUoKTtcbiAgICAgICAgICBpZiAoZXJyb3IpIHRocm93IG5ldyBFcnJvcihgXHU2MDYyXHU1RkE5XHU5MDRFXHU2NzFGXHU1NkRFXHU2NTM2XHU4QUNCXHU2QzQyXHU1OTMxXHU2NTU3XHVGRjFBJHtlcnJvci5tZXNzYWdlfWApO1xuICAgICAgICAgIGlmICghc3RhbGVDbGFpbSkgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwOSwgeyBzdGF0dXM6IFwicGVuZGluZ1wiLCBlcnJvcjogXCJcdTZCNjRcdThDQzdcdTc1MjJcdTVERjJcdTY3MDlcdTU2REVcdTY1MzZcdThBQ0JcdTZDNDJcdTg2NTVcdTc0MDZcdTRFMkRcdUZGMENcdThBQ0JcdTdBMERcdTVGOENcdTkxQ0RcdTY1QjBcdTY1NzRcdTc0MDZcIiB9KTtcbiAgICAgICAgICBzZXR0bGVtZW50LnN0YXR1cyA9IFwiZmFpbGVkXCI7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBjb25maXJtZWQgPSBhd2FpdCB3YWl0Rm9yQWRtaW5Bc3NldFJlY2xhaW0oc2V0dGxlbWVudC50eF9oYXNoIGFzIGAweCR7c3RyaW5nfWApO1xuICAgICAgICAgIGlmIChjb25maXJtZWQpIHtcbiAgICAgICAgICAgIGNvbnN0IHsgZXJyb3IgfSA9IGF3YWl0IGFkbWluLmZyb20oXCJvbmNoYWluX3NldHRsZW1lbnRzXCIpLnVwZGF0ZSh7IHN0YXR1czogXCJjb25maXJtZWRcIiwgZXJyb3I6IG51bGwsIHVwZGF0ZWRfYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9KS5lcShcImlkXCIsIHNldHRsZW1lbnQuaWQpO1xuICAgICAgICAgICAgaWYgKGVycm9yKSB0aHJvdyBuZXcgRXJyb3IoYFx1NURGMlx1NEUwQVx1OTNDOFx1NEY0Nlx1NjZGNFx1NjVCMFx1NTZERVx1NjUzNlx1NzJDMFx1NjE0Qlx1NTkzMVx1NjU1N1x1RkYxQSR7ZXJyb3IubWVzc2FnZX1gKTtcbiAgICAgICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCAyMDAsIHsgc3RhdHVzOiBcImNvbmZpcm1lZFwiLCB0eEhhc2g6IHNldHRsZW1lbnQudHhfaGFzaCwgYW1vdW50OiBTdHJpbmcoc2V0dGxlbWVudC5hbW91bnQgPz8gXCIwXCIpIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCB7IGVycm9yIH0gPSBhd2FpdCBhZG1pbi5mcm9tKFwib25jaGFpbl9zZXR0bGVtZW50c1wiKS51cGRhdGUoeyBzdGF0dXM6IFwiZmFpbGVkXCIsIGVycm9yOiBcIlx1OTNDOFx1NEUwQVx1NTZERVx1NjUzNlx1NEVBNFx1NjYxM1x1NURGMiByZXZlcnRcIiwgdXBkYXRlZF9hdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH0pLmVxKFwiaWRcIiwgc2V0dGxlbWVudC5pZCk7XG4gICAgICAgICAgaWYgKGVycm9yKSB0aHJvdyBuZXcgRXJyb3IoYFx1NjZGNFx1NjVCMFx1NTkzMVx1NjU1N1x1NTZERVx1NjUzNlx1NzJDMFx1NjE0Qlx1NTkzMVx1NjU1N1x1RkYxQSR7ZXJyb3IubWVzc2FnZX1gKTtcbiAgICAgICAgICBzZXR0bGVtZW50LnN0YXR1cyA9IFwiZmFpbGVkXCI7XG4gICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAyLCB7IHN0YXR1czogXCJwZW5kaW5nXCIsIHR4SGFzaDogc2V0dGxlbWVudC50eF9oYXNoLCBhbW91bnQ6IFN0cmluZyhzZXR0bGVtZW50LmFtb3VudCA/PyBcIjBcIikgfSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGNhbmRpZGF0ZXMgPSBhd2FpdCByZWFkTGVnYWN5UmVjbGFpbUNhbmRpZGF0ZXMoYWRtaW4sIGNhbGxlci5pZCwgd2FsbGV0KTtcbiAgICAgIGNvbnN0IGNhbmRpZGF0ZSA9IGNhbmRpZGF0ZXMuZmluZCgoaXRlbSkgPT4gaXRlbS5hc3NldEtleSA9PT0gYXNzZXRLZXkpO1xuICAgICAgaWYgKCFjYW5kaWRhdGUgfHwgY2FuZGlkYXRlLnN0YXR1cyAhPT0gXCJyZWFkeVwiIHx8ICFjYW5kaWRhdGUudG9rZW5BZGRyZXNzIHx8IGNhbmRpZGF0ZS5kZWNpbWFscyA9PSBudWxsKSB7XG4gICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDksIHsgZXJyb3I6IFwiXHU3NkVFXHU1MjREXHU2QzkyXHU2NzA5XHU1M0VGXHU1NkRFXHU2NTM2XHU3Njg0XHU4MjBBXHU2MzAxXHU1MDA5XHVGRjBDXHU2MjE2XHU5M0M4XHU0RTBBXHU5OTE4XHU5ODREXHVGRjBGXHU0RUNBXHU2NUU1XHU0RkREXHU3NTU5XHU5ODREXHU1REYyXHU4QjhBXHU1MkQ1XHVGRjBDXHU4QUNCXHU5MUNEXHU2NUIwXHU2NTc0XHU3NDA2XCIgfSk7XG4gICAgICB9XG4gICAgICBsZXQgcmVxdWVzdGVkVW5pdHM6IGJpZ2ludDtcbiAgICAgIGxldCBjYW5kaWRhdGVVbml0czogYmlnaW50O1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVxdWVzdGVkVW5pdHMgPSBwYXJzZVVuaXRzKGV4cGVjdGVkQW1vdW50LCBjYW5kaWRhdGUuZGVjaW1hbHMpO1xuICAgICAgICBjYW5kaWRhdGVVbml0cyA9IHBhcnNlVW5pdHMoY2FuZGlkYXRlLmFtb3VudCwgY2FuZGlkYXRlLmRlY2ltYWxzKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDAwLCB7IGVycm9yOiBcIlx1NTZERVx1NjUzNlx1NjU3OFx1OTFDRlx1OEQ4NVx1NTFGQVx1NEVFM1x1NUU2M1x1N0NCRVx1NUVBNlx1RkYwQ1x1OEFDQlx1OTFDRFx1NjVCMFx1NjU3NFx1NzQwNlx1NUY4Q1x1NTE4RFx1OEE2NlwiIH0pO1xuICAgICAgfVxuICAgICAgaWYgKHJlcXVlc3RlZFVuaXRzIDw9IDBuIHx8IHJlcXVlc3RlZFVuaXRzICE9PSBjYW5kaWRhdGVVbml0cykge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDA5LCB7IGVycm9yOiBcIlx1NTZERVx1NjUzNlx1OTg0RFx1NUVBNlx1NURGMlx1OEI4QVx1NTJENVx1RkYwQ1x1OEFDQlx1OTFDRFx1NjVCMFx1NjU3NFx1NzQwNlx1NEUyNlx1OTFDRFx1NjVCMFx1NjM4OFx1NkIwQVx1N0NCRVx1NzhCQVx1OTg0RFx1NUVBNlwiIH0pO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBwYXlsb2FkID0ge1xuICAgICAgICBhc3NldEtleSxcbiAgICAgICAgYXNzZXRUeXBlOiBjYW5kaWRhdGUua2luZCxcbiAgICAgICAgdG9rZW5BZGRyZXNzOiBjYW5kaWRhdGUudG9rZW5BZGRyZXNzLFxuICAgICAgICB3YWxsZXQsXG4gICAgICAgIGFtb3VudDogY2FuZGlkYXRlLmFtb3VudCxcbiAgICAgICAgdG9kYXlDdXRvZmY6IExFR0FDWV9SRUNMQUlNX0NVVE9GRixcbiAgICAgIH07XG4gICAgICBpZiAoc2V0dGxlbWVudD8uc3RhdHVzID09PSBcImZhaWxlZFwiKSB7XG4gICAgICAgIGNvbnN0IHsgZGF0YTogY2xhaW1lZCwgZXJyb3IgfSA9IGF3YWl0IGFkbWluXG4gICAgICAgICAgLmZyb20oXCJvbmNoYWluX3NldHRsZW1lbnRzXCIpXG4gICAgICAgICAgLnVwZGF0ZSh7IHN0YXR1czogXCJwZW5kaW5nXCIsIHR4X2hhc2g6IG51bGwsIGVycm9yOiBudWxsLCBhbW91bnQ6IGNhbmRpZGF0ZS5hbW91bnQsIHBheWxvYWQsIHVwZGF0ZWRfYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9KVxuICAgICAgICAgIC5lcShcImlkXCIsIHNldHRsZW1lbnQuaWQpXG4gICAgICAgICAgLmVxKFwic3RhdHVzXCIsIFwiZmFpbGVkXCIpXG4gICAgICAgICAgLnNlbGVjdChcImlkLGFjdGlvbixzdGF0dXMsdHhfaGFzaCx1c2VyX2lkLGFzc2V0X2lkLGFtb3VudCxwYXlsb2FkLHVwZGF0ZWRfYXRcIilcbiAgICAgICAgICAubWF5YmVTaW5nbGUoKTtcbiAgICAgICAgaWYgKGVycm9yKSB0aHJvdyBuZXcgRXJyb3IoYFx1OTFDRFx1NjVCMFx1NUVGQVx1N0FDQlx1NTZERVx1NjUzNlx1OEFDQlx1NkM0Mlx1NTkzMVx1NjU1N1x1RkYxQSR7ZXJyb3IubWVzc2FnZX1gKTtcbiAgICAgICAgaWYgKCFjbGFpbWVkKSByZXR1cm4ganNvbihyZXNwb25zZSwgNDA5LCB7IHN0YXR1czogXCJwZW5kaW5nXCIsIGVycm9yOiBcIlx1NkI2NFx1OENDN1x1NzUyMlx1NURGMlx1NjcwOVx1NTZERVx1NjUzNlx1OEFDQlx1NkM0Mlx1ODY1NVx1NzQwNlx1NEUyRFx1RkYwQ1x1OEFDQlx1N0EwRFx1NUY4Q1x1OTFDRFx1NjVCMFx1NjU3NFx1NzQwNlwiIH0pO1xuICAgICAgICBzZXR0bGVtZW50ID0gY2xhaW1lZDtcbiAgICAgIH0gZWxzZSBpZiAoIXNldHRsZW1lbnQpIHtcbiAgICAgICAgY29uc3QgeyBkYXRhOiBpbnNlcnRlZCwgZXJyb3IgfSA9IGF3YWl0IGFkbWluXG4gICAgICAgICAgLmZyb20oXCJvbmNoYWluX3NldHRsZW1lbnRzXCIpXG4gICAgICAgICAgLmluc2VydCh7XG4gICAgICAgICAgICBhY3Rpb246IFwiYWVfcmVjbGFpbV9sZWdhY3lcIixcbiAgICAgICAgICAgIHJlZl9rZXk6IHJlZktleSxcbiAgICAgICAgICAgIHVzZXJfaWQ6IGNhbGxlci5pZCxcbiAgICAgICAgICAgIGFzc2V0X2lkOiBhc3NldEtleSxcbiAgICAgICAgICAgIGFtb3VudDogY2FuZGlkYXRlLmFtb3VudCxcbiAgICAgICAgICAgIHN0YXR1czogXCJwZW5kaW5nXCIsXG4gICAgICAgICAgICBwYXlsb2FkLFxuICAgICAgICAgIH0pXG4gICAgICAgICAgLnNlbGVjdChcImlkLGFjdGlvbixzdGF0dXMsdHhfaGFzaCx1c2VyX2lkLGFzc2V0X2lkLGFtb3VudCxwYXlsb2FkLHVwZGF0ZWRfYXRcIilcbiAgICAgICAgICAuc2luZ2xlKCk7XG4gICAgICAgIGlmIChlcnJvcikge1xuICAgICAgICAgIGlmIChlcnJvci5jb2RlID09PSBcIjIzNTA1XCIpIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDksIHsgc3RhdHVzOiBcInBlbmRpbmdcIiwgZXJyb3I6IFwiXHU2QjY0XHU4Q0M3XHU3NTIyXHU1REYyXHU2NzA5XHU1NkRFXHU2NTM2XHU4QUNCXHU2QzQyXHU4NjU1XHU3NDA2XHU0RTJEXHVGRjBDXHU4QUNCXHU3QTBEXHU1RjhDXHU5MUNEXHU2NUIwXHU2NTc0XHU3NDA2XCIgfSk7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBcdTVFRkFcdTdBQ0JcdTU2REVcdTY1MzZcdTdEMDBcdTkzMDRcdTU5MzFcdTY1NTdcdUZGMUEke2Vycm9yLm1lc3NhZ2V9YCk7XG4gICAgICAgIH1cbiAgICAgICAgc2V0dGxlbWVudCA9IGluc2VydGVkO1xuICAgICAgfVxuICAgICAgaWYgKCFzZXR0bGVtZW50Py5pZCkge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNTAwLCB7IGVycm9yOiBcIlx1NTZERVx1NjUzNlx1N0QwMFx1OTMwNFx1NjcyQVx1NjIxMFx1NTI5Rlx1OTM5Nlx1NUI5QVx1RkYwQ1x1OEFDQlx1N0EwRFx1NUY4Q1x1OTFDRFx1OEE2NlwiIH0pO1xuICAgICAgfVxuXG4gICAgICBsZXQgdHhIYXNoOiBgMHgke3N0cmluZ31gO1xuICAgICAgdHJ5IHtcbiAgICAgICAgdHhIYXNoID0gYXdhaXQgc2VuZEFkbWluQXNzZXRSZWNsYWltKHtcbiAgICAgICAgICB0b2tlbkFkZHJlc3M6IGNhbmRpZGF0ZS50b2tlbkFkZHJlc3MsXG4gICAgICAgICAgb3duZXI6IHdhbGxldCxcbiAgICAgICAgICBhbW91bnQ6IGNhbmRpZGF0ZS5hbW91bnQsXG4gICAgICAgICAgbGFiZWw6IGNhbmRpZGF0ZS5sYWJlbCxcbiAgICAgICAgfSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGF3YWl0IGFkbWluLmZyb20oXCJvbmNoYWluX3NldHRsZW1lbnRzXCIpLnVwZGF0ZSh7IHN0YXR1czogXCJmYWlsZWRcIiwgZXJyb3I6IGVyck1zZyhlKSwgdXBkYXRlZF9hdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH0pLmVxKFwiaWRcIiwgc2V0dGxlbWVudC5pZCk7XG4gICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MjIsIHsgc3RhdHVzOiBcImZhaWxlZFwiLCBlcnJvcjogZXJyTXNnKGUpIH0pO1xuICAgICAgfVxuXG4gICAgICBjb25zdCB7IGVycm9yOiBoYXNoRXJyb3IgfSA9IGF3YWl0IGFkbWluXG4gICAgICAgIC5mcm9tKFwib25jaGFpbl9zZXR0bGVtZW50c1wiKVxuICAgICAgICAudXBkYXRlKHsgdHhfaGFzaDogdHhIYXNoLCB1cGRhdGVkX2F0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkgfSlcbiAgICAgICAgLmVxKFwiaWRcIiwgc2V0dGxlbWVudC5pZCk7XG4gICAgICBpZiAoaGFzaEVycm9yKSB7XG4gICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA1MDMsIHsgc3RhdHVzOiBcInBlbmRpbmdcIiwgdHhIYXNoLCBlcnJvcjogXCJcdTRFQTRcdTY2MTNcdTVERjJcdTkwMDFcdTUxRkFcdUZGMENcdTU2REVcdTY1MzZcdTdEMDBcdTkzMDRcdTVDMUFcdTY3MkFcdTU0MENcdTZCNjVcdUZGMENcdThBQ0JcdTdBMERcdTVGOENcdTkxQ0RcdTY1QjBcdTY1NzRcdTc0MDZcdTRFMjZcdTgwNkZcdTdFNkJcdTVCQTJcdTY3MERcdTYzRDBcdTRGOUJcdTRFQTRcdTY2MTNcdTk2RENcdTZFNEFcIiB9KTtcbiAgICAgIH1cbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGNvbmZpcm1lZCA9IGF3YWl0IHdhaXRGb3JBZG1pbkFzc2V0UmVjbGFpbSh0eEhhc2gpO1xuICAgICAgICBjb25zdCBzdGF0dXMgPSBjb25maXJtZWQgPyBcImNvbmZpcm1lZFwiIDogXCJmYWlsZWRcIjtcbiAgICAgICAgY29uc3QgeyBlcnJvciB9ID0gYXdhaXQgYWRtaW5cbiAgICAgICAgICAuZnJvbShcIm9uY2hhaW5fc2V0dGxlbWVudHNcIilcbiAgICAgICAgICAudXBkYXRlKHsgc3RhdHVzLCBlcnJvcjogY29uZmlybWVkID8gbnVsbCA6IFwiXHU5M0M4XHU0RTBBXHU1NkRFXHU2NTM2XHU0RUE0XHU2NjEzXHU1REYyIHJldmVydFwiLCB1cGRhdGVkX2F0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkgfSlcbiAgICAgICAgICAuZXEoXCJpZFwiLCBzZXR0bGVtZW50LmlkKTtcbiAgICAgICAgaWYgKGVycm9yKSB0aHJvdyBuZXcgRXJyb3IoYFx1NjZGNFx1NjVCMFx1NTZERVx1NjUzNlx1NzJDMFx1NjE0Qlx1NTkzMVx1NjU1N1x1RkYxQSR7ZXJyb3IubWVzc2FnZX1gKTtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIGNvbmZpcm1lZCA/IDIwMCA6IDQyMiwge1xuICAgICAgICAgIHN0YXR1cyxcbiAgICAgICAgICB0eEhhc2gsXG4gICAgICAgICAgYW1vdW50OiBjYW5kaWRhdGUuYW1vdW50LFxuICAgICAgICAgIGVycm9yOiBjb25maXJtZWQgPyB1bmRlZmluZWQgOiBcIlx1OTNDOFx1NEUwQVx1NTZERVx1NjUzNlx1NEVBNFx1NjYxM1x1NTkzMVx1NjU1N1x1RkYwQ1x1OEFDQlx1NzhCQVx1OEE4RFx1OTMyMlx1NTMwNVx1NjM4OFx1NkIwQVx1NUY4Q1x1OTFDRFx1OEE2NlwiLFxuICAgICAgICB9KTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAyLCB7IHN0YXR1czogXCJwZW5kaW5nXCIsIHR4SGFzaCwgYW1vdW50OiBjYW5kaWRhdGUuYW1vdW50IH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIC0tLS0gXHU1NkRFXHU1MEIzIEFETUlOIFx1NzFCMVx1OTMyMlx1NTMwNVx1NTczMFx1NTc0MFx1MzAwMlx1NTBDNVx1OTcwMFx1NzY3Qlx1NTE2NVx1NTM3M1x1NTNFRlx1NjdFNVx1OEE2Mlx1RkYwQ1x1NEUwRFx1NTQyQlx1NEVGQlx1NEY1NVx1NkE1Rlx1NUJDNlx1MzAwMi0tLS1cbiAgICBpZiAoYWN0aW9uID09PSBcInJlbGF5ZXItYWRkcmVzc1wiKSB7XG4gICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IGFkZHJlc3M6IHJlbGF5ZXJBZGRyZXNzKCkgfSk7XG4gICAgfVxuXG4gICAgLy8gLS0tLSBcdTdCQTFcdTc0MDZcdTU0RTFcdTU1MkZcdThCODBcdThBM0FcdTY1QjdcdUZGMUFBRE1JTiBcdTcxQjFcdTkzMjJcdTUzMDVcdTc2RUVcdTUyNERcdTYzMDFcdTY3MDlcdTc2ODQgSkMvQUUgXHU1RUFCXHU1QjU4XHUzMDAyXHU3RDE0XHU4QjgwXHU1M0Q2XHVGRjBDXHU0RTBEXHU1MDVBXG4gICAgLy8gXHU0RUZCXHU0RjU1XHU5M0M4XHU0RTBBXHU1QkVCXHU1MTY1XHVGRjBDXHU3NTI4XHU0Rjg2XHU3OEJBXHU4QThEXHUzMDBDXHU2NjJGXHU1NDI2XHU5NzAwXHU4OTgxXHU0RUJBXHU1REU1XHU1RjlFIFNhZmUgXHU5MUQxXHU1RUFCXHU4RjQ5XHU1RTMzXHU4OERDXHU4Q0E4XHUzMDBEXHUzMDAyLS0tLVxuICAgIGlmIChhY3Rpb24gPT09IFwiYWRtaW4tdmF1bHQtc3RhdHVzXCIpIHtcbiAgICAgIGlmICghaXNBZG1pblByb2ZpbGUoY2FsbGVyUHJvZmlsZSkpIHtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMywgeyBlcnJvcjogXCJcdTUwQzVcdTk2NTBcdTdCQTFcdTc0MDZcdTU0RTFcdTU3RjdcdTg4NENcIiB9KTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IFtqYywgYWVdID0gYXdhaXQgUHJvbWlzZS5hbGwoW2dldFZhdWx0U3RhdHVzKFwiamNUb2tlblwiKSwgZ2V0VmF1bHRTdGF0dXMoXCJhZVRva2VuXCIpXSk7XG4gICAgICBjb25zdCBzZXJpYWxpemUgPSAoczogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiBnZXRWYXVsdFN0YXR1cz4+KSA9PiAoe1xuICAgICAgICB0b2tlbjogcy50b2tlbixcbiAgICAgICAgYmFsYW5jZTogcy5iYWxhbmNlRm9ybWF0dGVkLFxuICAgICAgICBsb3c6IHMubG93LFxuICAgICAgfSk7XG4gICAgICAvLyBSV0EgXHU2QTE5XHU3Njg0XHVGRjFBXHU1M0VBXHU1MjE3XHU0RTBBXHVGRkZEXHVGRkZEXHVGRkZEXHU0RTJEXHVGRjA4aXNfYWN0aXZlIFx1NEUxNFx1NjcyQVx1NEUwQlx1NjdCNlx1RkYwOVx1MzAwMVx1OTc1RSBBRVx1MzAwMVx1NEUxNFx1NURGMlx1OTBFOFx1N0Y3Mlx1NUMwOFx1NUM2Q1x1NEVFM1x1NUU2M1x1NzY4NFx1NkExOVx1NzY4NFx1RkYwQ1xuICAgICAgLy8gXHU5MDEwXHU0RTAwXHU4QjgwIEFETUlOIFx1NzFCMVx1OTMyMlx1NTMwNVx1NTcyOFx1OEE3Mlx1NEVGRFx1OTg0RFx1NEVFM1x1NUU2M1x1NzY4NFx1OTNDOFx1NEUwQVx1OTkxOFx1OTg0RFx1MzAwMlx1NEUwQlx1NjdCNlx1NkExOVx1NzY4NFx1NEUwMFx1NUY4Qlx1NjM5Mlx1OTY2NFx1MzAwMlxuICAgICAgY29uc3QgeyBkYXRhOiByd2FQbGFjZW1lbnRzIH0gPSBhd2FpdCBhZG1pblxuICAgICAgICAuZnJvbShcInByaXZhdGVfcGxhY2VtZW50c1wiKVxuICAgICAgICAuc2VsZWN0KFwiaWQsbmFtZVwiKVxuICAgICAgICAuZXEoXCJpc19hZV90b2tlblwiLCBmYWxzZSlcbiAgICAgICAgLmVxKFwiaXNfYWN0aXZlXCIsIHRydWUpXG4gICAgICAgIC5lcShcImlzX2RlbGlzdGVkXCIsIGZhbHNlKTtcbiAgICAgIGNvbnN0IHJ3YSA9IChcbiAgICAgICAgYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgICAgICAgKHJ3YVBsYWNlbWVudHMgPz8gW10pLm1hcChhc3luYyAocGxhY2VtZW50KSA9PiB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBjb25zdCB0b2tlbkFkZHJlc3MgPSBhd2FpdCBnZXRDdXJyZW50UndhRmFjdG9yeVRva2VuKHBsYWNlbWVudC5pZCk7XG4gICAgICAgICAgICAgIGlmICghdG9rZW5BZGRyZXNzKSByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgICAgY29uc3QgcyA9IGF3YWl0IGdldEhvdFdhbGxldFNoYXJlQmFsYW5jZSh0b2tlbkFkZHJlc3MpO1xuICAgICAgICAgICAgICByZXR1cm4geyBuYW1lOiBTdHJpbmcocGxhY2VtZW50Lm5hbWUgPz8gXCJcIiksIGJhbGFuY2U6IHMuYmFsYW5jZUZvcm1hdHRlZCB9O1xuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pLFxuICAgICAgICApXG4gICAgICApLmZpbHRlcigoeCk6IHggaXMgeyBuYW1lOiBzdHJpbmc7IGJhbGFuY2U6IHN0cmluZyB9ID0+IHggIT0gbnVsbCk7XG4gICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IGpjOiBzZXJpYWxpemUoamMpLCBhZTogc2VyaWFsaXplKGFlKSwgcndhIH0pO1xuICAgIH1cblxuICAvLyBcdTdCQTFcdTc0MDZcdTU0RTFcdTkyQjdcdTZCQzBcdTY3MkFcdTU1MkVcdTUxRkFcdTc2ODQgU2FmZSBcdTkxRDFcdTVFQUJcdTVFQUJcdTVCNThcdUZGMUJcdTRGODZcdTZFOTBcdTU3MzBcdTU3NDBcdTU2RkFcdTVCOUFcdTY1QkNcdTU0MDhcdTdEMDRcdUZGMENcdTRFMERcdTYzQTVcdTUzRDdcdTRFRkJcdTYxMEYgaG9sZGVyXHUzMDAyXG4gIGlmIChhY3Rpb24gPT09IFwiYWRtaW4tYnVybi1pbnZlbnRvcnlcIikge1xuICAgIGlmICghaXNBZG1pblByb2ZpbGUoY2FsbGVyUHJvZmlsZSkpIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDMsIHsgZXJyb3I6IFwiXHU1MEM1XHU5NjUwXHU3QkExXHU3NDA2XHU1NEUxXHU1N0Y3XHU4ODRDXCIgfSk7XG4gICAgY29uc3QgaW5wdXQgPSBib2R5IGFzIHsgdG9rZW4/OiBzdHJpbmc7IGFtb3VudD86IG51bWJlcjsgcGxhY2VtZW50SWQ/OiBzdHJpbmcgfTtcbiAgICBjb25zdCB0b2tlbiA9IGlucHV0LnRva2VuID09PSBcImpjXCIgfHwgaW5wdXQudG9rZW4gPT09IFwiYWVcIiB8fCBpbnB1dC50b2tlbiA9PT0gXCJyd2FcIiA/IGlucHV0LnRva2VuIDogbnVsbDtcbiAgICBpZiAoIXRva2VuKSByZXR1cm4ganNvbihyZXNwb25zZSwgNDAwLCB7IGVycm9yOiBcInRva2VuIFx1NUZDNVx1OTgwOFx1NjYyRiBqY1x1MzAwMWFlIFx1NjIxNiByd2FcIiB9KTtcbiAgICBjb25zdCBhbW91bnQgPSBOdW1iZXIoaW5wdXQuYW1vdW50KTtcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShhbW91bnQpIHx8IGFtb3VudCA8PSAwKSByZXR1cm4ganNvbihyZXNwb25zZSwgNDAwLCB7IGVycm9yOiBcIlx1OTJCN1x1NkJDMFx1NjU3OFx1OTFDRlx1NUZDNVx1OTgwOFx1NjYyRlx1NTkyN1x1NjVCQyAwIFx1NzY4NFx1NjU3OFx1NUI1N1wiIH0pO1xuICAgIGxldCB0b2tlbkFkZHJlc3M6IEFkZHJlc3MgfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgIGlmICh0b2tlbiA9PT0gXCJyd2FcIikge1xuICAgICAgICBpZiAoIWlucHV0LnBsYWNlbWVudElkKSByZXR1cm4ganNvbihyZXNwb25zZSwgNDAwLCB7IGVycm9yOiBcIlx1OEFDQlx1OTA3OFx1NjRDNyBSV0EgXHU2QTE5XHU3Njg0XCIgfSk7XG4gICAgICAgIGNvbnN0IHsgZGF0YTogcGxhY2VtZW50LCBlcnJvcjogcGxhY2VtZW50RXJyb3IgfSA9IGF3YWl0IGFkbWluXG4gICAgICAgICAgLmZyb20oXCJwcml2YXRlX3BsYWNlbWVudHNcIilcbiAgICAgICAgICAuc2VsZWN0KFwiaWQsaXNfYWVfdG9rZW5cIilcbiAgICAgICAgICAuZXEoXCJpZFwiLCBpbnB1dC5wbGFjZW1lbnRJZClcbiAgICAgICAgICAuZXEoXCJpc19hZV90b2tlblwiLCBmYWxzZSlcbiAgICAgICAgICAubWF5YmVTaW5nbGUoKTtcbiAgICAgICAgaWYgKHBsYWNlbWVudEVycm9yKSB0aHJvdyBuZXcgRXJyb3IoYFx1OEI4MFx1NTNENiBSV0EgXHU2QTE5XHU3Njg0XHU1OTMxXHU2NTU3XHVGRjFBJHtwbGFjZW1lbnRFcnJvci5tZXNzYWdlfWApO1xuICAgICAgICBpZiAoIXBsYWNlbWVudCkgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwNCwgeyBlcnJvcjogXCJcdTYyN0VcdTRFMERcdTUyMzBcdTZCNjQgUldBIFx1NkExOVx1NzY4NFwiIH0pO1xuICAgICAgICB0b2tlbkFkZHJlc3MgPSAoYXdhaXQgZ2V0Q3VycmVudFJ3YUZhY3RvcnlUb2tlbihwbGFjZW1lbnQuaWQpKSA/PyB1bmRlZmluZWQ7XG4gICAgICAgIGlmICghdG9rZW5BZGRyZXNzKSByZXR1cm4ganNvbihyZXNwb25zZSwgNDA0LCB7IGVycm9yOiBcIlx1NkI2NFx1NkExOVx1NzY4NFx1NUMxQVx1NjcyQVx1NTcyOFx1NzZFRVx1NTI0RCBGYWN0b3J5IFx1NUVGQVx1N0FDQlx1NEVFM1x1NUU2M1wiIH0pO1xuICAgICAgfVxuICAgICAgY29uc3QgdHhIYXNoID0gYXdhaXQgYnVyblZhdWx0SW52ZW50b3J5KHRva2VuLCBhbW91bnQsIHRva2VuQWRkcmVzcyk7XG4gICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IHR4SGFzaCwgdG9rZW4sIGFtb3VudCB9KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNTAyLCB7IGVycm9yOiBlcnJNc2coZSkgfSk7XG4gICAgfVxuICB9XG5cbiAgLy8gLS0tLSBcdTdCQTFcdTc0MDZcdTU0RTFcdUZGMUFcdTU3MjhcdTY1QjBcdTcyNDggSkMvQUUgXHU1NDA4XHU3RDA0XHU0RTBBXHU1ODlFXHU3NjdDXHU0RjlCXHU3RDY2XHU5MUNGXHU3RDY2XHU2MzA3XHU1QjlBXHU1NzMwXHU1NzQwXHVGRjA4XHU5ODEwXHU4QTJEIFNhZmUgXHU5MUQxXHU1RUFCXHVGRjA5XHUzMDAyXG4gIC8vIFx1OTAxOVx1NjYyRlx1NzcxRlx1NzY4NFx1NTQ3Q1x1NTNFQlx1NTQwOFx1N0QwNCBtaW50XHVGRjBDXHU2NzAzXHU1ODlFXHU1MkEwXHU0RUUzXHU1RTYzXHU3RTNEXHU0RjlCXHU3RDY2XHU5MUNGXHVGRjBDXHU4MjA3XHU1NUFFXHU3RDE0XHU2NDJDXHU1MkQ1XHU3MUIxXHU5MzIyXHU1MzA1XHU5OTE4XHU5ODREXHU0RTBEXHU1NDBDXHVGRjBDXG4gIC8vIFx1NjU0NVx1NzM2OFx1N0FDQlx1NjIxMFx1NEUwMFx1NTAwQlx1OUFEOFx1OThBOFx1OTZBQSBhY3Rpb25cdUZGMENcdTUwQzVcdTk2NTBcdTdCQTFcdTc0MDZcdTU0RTFcdTMwMDFcdTRFMTRcdTkxRDFcdTk4NERcdTVGQzVcdTk4MDhcdTcwQkFcdTZCNjNcdTY1NzhcdTMwMDItLS0tXG4gICAgaWYgKGFjdGlvbiA9PT0gXCJhZG1pbi1taW50XCIpIHtcbiAgICAgIGlmICghaXNBZG1pblByb2ZpbGUoY2FsbGVyUHJvZmlsZSkpIHtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMywgeyBlcnJvcjogXCJcdTUwQzVcdTk2NTBcdTdCQTFcdTc0MDZcdTU0RTFcdTU3RjdcdTg4NENcIiB9KTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGlucHV0ID0gYm9keSBhcyB7IHRva2VuPzogc3RyaW5nOyBhbW91bnQ/OiBudW1iZXI7IHRvPzogc3RyaW5nIH07XG4gICAgICBjb25zdCB0b2tlbiA9IGlucHV0LnRva2VuID09PSBcImpjXCIgPyBcImpjVG9rZW5cIiA6IGlucHV0LnRva2VuID09PSBcImFlXCIgPyBcImFlVG9rZW5cIiA6IG51bGw7XG4gICAgICBpZiAoIXRva2VuKSByZXR1cm4ganNvbihyZXNwb25zZSwgNDAwLCB7IGVycm9yOiBcInRva2VuIFx1NUZDNVx1OTgwOFx1NjYyRiBqYyBcdTYyMTYgYWVcIiB9KTtcbiAgICAgIGNvbnN0IGFtb3VudCA9IE51bWJlcihpbnB1dC5hbW91bnQpO1xuICAgICAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoYW1vdW50KSB8fCBhbW91bnQgPD0gMCkge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDAwLCB7IGVycm9yOiBcIlx1NTg5RVx1NzY3Q1x1NjU3OFx1OTFDRlx1NUZDNVx1OTgwOFx1NjYyRlx1NTkyN1x1NjVCQyAwIFx1NzY4NFx1NjU3OFx1NUI1N1wiIH0pO1xuICAgICAgfVxuICAgICAgbGV0IHRvOiBBZGRyZXNzO1xuICAgICAgdHJ5IHtcbiAgICAgICAgdG8gPSBpbnB1dC50byAmJiBpbnB1dC50by50cmltKCkgPyB0b0FkZHJlc3MoaW5wdXQudG8udHJpbSgpLCBcIlx1NTg5RVx1NzY3Q1x1NzZFRVx1NkExOVx1NTczMFx1NTc0MFwiKSA6IGdldEFkZHJlc3MoUkVMQVlFUl9BRERSRVNTRVMuc2FmZVZhdWx0KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQyMiwgeyBlcnJvcjogZXJyTXNnKGUpIH0pO1xuICAgICAgfVxuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdHhIYXNoID0gYXdhaXQgbWludFRva2VuU3VwcGx5KHRva2VuLCB0bywgYW1vdW50KTtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDIwMCwgeyB0eEhhc2gsIHRva2VuOiBpbnB1dC50b2tlbiwgdG8sIGFtb3VudCB9KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDUwMiwgeyBlcnJvcjogZXJyTXNnKGUpIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIC0tLS0gXHU3QkExXHU3NDA2XHU1NEUxXHVGRjFBXHUzMDBDQUUgXHU2Qjc4XHU5NkY2XHUzMDBEXHU1MjREXHU3Njg0XHU5M0M4XHU0RTBBXHU1RjM3XHU1MjM2XHU2NTM2XHU1NkRFXHUzMDAyXHU2MzgzXHU2M0NGXHU2MjQwXHU2NzA5XHU2MzAxXHU2NzA5IEFFIFx1NkExOVx1NzY4NFx1NzY4NFx1NEY3Rlx1NzUyOFx1ODAwNVxuICAgIC8vIFx1OTMyMlx1NTMwNVx1RkYwQ1x1NzUyOCBBRVRva2VuIFx1NzY4NCBvd25lci1vbmx5IGFkbWluUmVjbGFpbSBcdTYyOEFcdTUxNzZcdTkzQzhcdTRFMEFcdTc3MUZcdTVCRTYgQUUgXHU5OTE4XHU5ODREXHU2NTM2XHU1NkRFXG4gICAgLy8gU2FmZSBcdTkxRDFcdTVFQUJcdUZGMDhcdTRFMERcdTUzRDcgYWxsb3dhbmNlIFx1OTY1MFx1NTIzNlx1RkYwQ1x1NEUwMFx1NUI5QVx1ODBGRFx1NjUzNlx1NTZERVx1RkYwOVx1MzAwMlx1NUZDNVx1OTgwOFx1NTcyOFx1NTQ3Q1x1NTNFQlxuICAgIC8vIGFkbWluX3Jlc2V0X2FlX3Rva2VuXHVGRjA4XHU2NzAzXHU2RTA1XHU3QTdBIGhvbGRpbmdzXHVGRjA5XHU0RTRCXHU1MjREXHU1N0Y3XHU4ODRDXHVGRjBDXHU1NDI2XHU1MjQ3XHU2MjkzXHU0RTBEXHU1MjMwXHU2MzAxXHU2NzA5XHU0RUJBXHU2RTA1XHU1NUFFXHUzMDAyLS0tLVxuICAgIGlmIChhY3Rpb24gPT09IFwiYWRtaW4tYWUtcmVjbGFpbVwiKSB7XG4gICAgICBpZiAoIWlzQWRtaW5Qcm9maWxlKGNhbGxlclByb2ZpbGUpKSB7XG4gICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDMsIHsgZXJyb3I6IFwiXHU1MEM1XHU5NjUwXHU3QkExXHU3NDA2XHU1NEUxXHU1N0Y3XHU4ODRDXCIgfSk7XG4gICAgICB9XG4gICAgICBjb25zdCB7IGRhdGE6IGFlUGxhY2VtZW50cywgZXJyb3I6IGFlRXJyIH0gPSBhd2FpdCBhZG1pblxuICAgICAgICAuZnJvbShcInByaXZhdGVfcGxhY2VtZW50c1wiKVxuICAgICAgICAuc2VsZWN0KFwiaWRcIilcbiAgICAgICAgLmVxKFwiaXNfYWVfdG9rZW5cIiwgdHJ1ZSk7XG4gICAgICBpZiAoYWVFcnIpIHRocm93IG5ldyBFcnJvcihgXHU2N0U1XHU4QTYyIEFFIFx1NkExOVx1NzY4NFx1NTkzMVx1NjU1N1x1RkYxQSR7YWVFcnIubWVzc2FnZX1gKTtcbiAgICAgIGNvbnN0IGFlSWRzID0gKGFlUGxhY2VtZW50cyA/PyBbXSkubWFwKChwKSA9PiBwLmlkIGFzIHN0cmluZyk7XG4gICAgICBpZiAoYWVJZHMubGVuZ3RoID09PSAwKSByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IHJlY2xhaW1lZDogW10sIGZhaWxlZDogW10gfSk7XG4gICAgICBjb25zdCB7IGRhdGE6IGhvbGRlcnMsIGVycm9yOiBob2xkRXJyIH0gPSBhd2FpdCBhZG1pblxuICAgICAgICAuZnJvbShcImhvbGRpbmdzXCIpXG4gICAgICAgIC5zZWxlY3QoXCJ1c2VyX2lkLCBwcm9maWxlcyFpbm5lcih3YWxsZXRfYWRkcmVzcylcIilcbiAgICAgICAgLmluKFwiYXNzZXRfaWRcIiwgYWVJZHMpO1xuICAgICAgaWYgKGhvbGRFcnIpIHRocm93IG5ldyBFcnJvcihgXHU2N0U1XHU4QTYyXHU2MzAxXHU2NzA5XHU0RUJBXHU1OTMxXHU2NTU3XHVGRjFBJHtob2xkRXJyLm1lc3NhZ2V9YCk7XG4gICAgICBjb25zdCB3YWxsZXRzID0gQXJyYXkuZnJvbShcbiAgICAgICAgbmV3IFNldChcbiAgICAgICAgICAoaG9sZGVycyA/PyBbXSlcbiAgICAgICAgICAgIC5tYXAoKGg6IHsgcHJvZmlsZXM/OiB7IHdhbGxldF9hZGRyZXNzPzogc3RyaW5nIHwgbnVsbCB9IHwgbnVsbCB9KSA9PiBoLnByb2ZpbGVzPy53YWxsZXRfYWRkcmVzcz8udHJpbSgpID8/IG51bGwpXG4gICAgICAgICAgICAuZmlsdGVyKCh3KTogdyBpcyBzdHJpbmcgPT4gISF3ICYmIC9eMHhbYS1mQS1GMC05XXs0MH0kLy50ZXN0KHcpKSxcbiAgICAgICAgKSxcbiAgICAgICk7XG4gICAgICBjb25zdCByZWNsYWltZWQ6IHsgd2FsbGV0OiBzdHJpbmc7IGFtb3VudDogbnVtYmVyOyB0eEhhc2g6IHN0cmluZyB9W10gPSBbXTtcbiAgICAgIGNvbnN0IGZhaWxlZDogeyB3YWxsZXQ6IHN0cmluZzsgZXJyb3I6IHN0cmluZyB9W10gPSBbXTtcbiAgICAgIGZvciAoY29uc3QgdyBvZiB3YWxsZXRzKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3Qgd2FsbGV0ID0gZ2V0QWRkcmVzcyh3KTtcbiAgICAgICAgICBjb25zdCBiYWxhbmNlID0gYXdhaXQgZ2V0QWVDaGFpbkJhbGFuY2Uod2FsbGV0KTtcbiAgICAgICAgICBpZiAoYmFsYW5jZSA8PSAwKSBjb250aW51ZTtcbiAgICAgICAgICBjb25zdCB0eEhhc2ggPSBhd2FpdCBhZG1pblJlY2xhaW1BZSh3YWxsZXQsIGJhbGFuY2UpO1xuICAgICAgICAgIGlmICh0eEhhc2gpIHJlY2xhaW1lZC5wdXNoKHsgd2FsbGV0OiB3LCBhbW91bnQ6IGJhbGFuY2UsIHR4SGFzaCB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIGZhaWxlZC5wdXNoKHsgd2FsbGV0OiB3LCBlcnJvcjogZXJyTXNnKGUpIH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IHJlY2xhaW1lZCwgZmFpbGVkIH0pO1xuICAgIH1cblxuICAgIC8vIC0tLS0gXHU3QkExXHU3NDA2XHU1NEUxXHVGRjFBXHUzMDBDUldBIFx1NEUwQlx1NjdCNlx1MzAwRFx1NTI0RFx1NzY4NFx1OTNDOFx1NEUwQVx1NUYzN1x1NTIzNlx1NjUzNlx1NTZERVx1RkYwOGJlc3QtZWZmb3J0XHVGRjA5XHUzMDAyXHU2MzgzXHU2M0NGXHU4QTcyXHU2QTE5XHU3Njg0XHU2MjQwXHU2NzA5XG4gICAgLy8gXHU2MzAxXHU2NzA5XHU0RUJBXHU5MzIyXHU1MzA1XHVGRjBDXHU1NjE3XHU4QTY2XHU3NTI4XHU1MTc2XHU1QzBEIEFETUlOIFx1NzY4NFx1NjVFMlx1NjcwOVx1NjM4OFx1NkIwQSB0cmFuc2ZlckZyb20gXHU2MjhBXHU0RUZEXHU5ODREXHU2NTM2XHU1NkRFIFNhZmUgXHU5MUQxXHU1RUFCXHUzMDAyXG4gICAgLy8gUldBIFx1NEVGRFx1OTg0RFx1NEVFM1x1NUU2M1x1NkM5Mlx1NjcwOVx1NTBDRiBKQy9BRSBcdTY1QjBcdTU0MDhcdTdEMDRcdTkwQTNcdTZBMjNcdTc2ODQgb3duZXItb25seSBhZG1pblJlY2xhaW1cdUZGMENcdTgyRTVcdThBNzJcdTRGN0ZcdTc1MjhcdTgwMDVcbiAgICAvLyBcdTVGOUVcdTY3MkFcdTVDMEQgQURNSU4gYXBwcm92ZSBcdTkwNEVcdTY3MDNcdTU5MzFcdTY1NTdcdUZGMENcdTU5MzFcdTY1NTdcdTc2ODRcdTUyMTdcdTUxNjUgZmFpbGVkIFx1NEY5Qlx1N0JBMVx1NzQwNlx1NTRFMVx1NzdFNVx1NjA4OVx1RkYwOFx1NEUwRFx1NUY3MVx1OTdGRlx1NEUwQlx1NjdCNlxuICAgIC8vIFx1NjcyQ1x1OEVBQlx1N0U3Q1x1N0U4Q1x1NTdGN1x1ODg0Q1x1MjAxNFx1MjAxNFx1N0FEOVx1NTE2NyBKQyBcdTVERjJcdTUzOUZcdThERUZcdTkwMDBcdTZCM0VcdTMwMDFob2xkaW5ncyBcdTY3MDNcdTg4QUIgYWRtaW5fZGVhY3RpdmF0ZV9wbGFjZW1lbnRcbiAgICAvLyBcdTZFMDVcdTdBN0FcdUZGMDlcdTMwMDJcdTVGQzVcdTk4MDhcdTU3MjhcdTU0N0NcdTUzRUIgYWRtaW5fZGVhY3RpdmF0ZV9wbGFjZW1lbnQgXHU0RTRCXHU1MjREXHU1N0Y3XHU4ODRDXHVGRjBDXHU1NDI2XHU1MjQ3XHU2MjkzXHU0RTBEXHU1MjMwXHU2MzAxXHU2NzA5XHU0RUJBXHUzMDAyLS0tLVxuICAgIGlmIChhY3Rpb24gPT09IFwiYWRtaW4tcndhLXJlY2xhaW1cIikge1xuICAgICAgaWYgKCFpc0FkbWluUHJvZmlsZShjYWxsZXJQcm9maWxlKSkge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDAzLCB7IGVycm9yOiBcIlx1NTBDNVx1OTY1MFx1N0JBMVx1NzQwNlx1NTRFMVx1NTdGN1x1ODg0Q1wiIH0pO1xuICAgICAgfVxuICAgICAgY29uc3QgcGxhY2VtZW50SWQgPSBTdHJpbmcoKGJvZHkgYXMgeyBwbGFjZW1lbnRJZD86IHN0cmluZyB9KS5wbGFjZW1lbnRJZCA/PyBcIlwiKS50cmltKCk7XG4gICAgICBpZiAoIXBsYWNlbWVudElkKSByZXR1cm4ganNvbihyZXNwb25zZSwgNDAwLCB7IGVycm9yOiBcIlx1N0YzQVx1NUMxMSBwbGFjZW1lbnRJZFwiIH0pO1xuICAgICAgY29uc3QgeyBkYXRhOiBwbGFjZW1lbnQsIGVycm9yOiBwRXJyIH0gPSBhd2FpdCBhZG1pblxuICAgICAgICAuZnJvbShcInByaXZhdGVfcGxhY2VtZW50c1wiKVxuICAgICAgICAuc2VsZWN0KFwiaWRcIilcbiAgICAgICAgLmVxKFwiaWRcIiwgcGxhY2VtZW50SWQpXG4gICAgICAgIC5tYXliZVNpbmdsZSgpO1xuICAgICAgaWYgKHBFcnIpIHRocm93IG5ldyBFcnJvcihgXHU2N0U1XHU4QTYyXHU2QTE5XHVGRkZEXHVGRkZEXHU1OTMxXHU2NTU3XHVGRjFBJHtwRXJyLm1lc3NhZ2V9YCk7XG4gICAgICBjb25zdCB0b2tlbkFkZHJlc3MgPSBwbGFjZW1lbnQgPyBhd2FpdCBnZXRDdXJyZW50UndhRmFjdG9yeVRva2VuKHBsYWNlbWVudC5pZCkgOiBudWxsO1xuICAgICAgaWYgKCF0b2tlbkFkZHJlc3MpIHtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDIwMCwgeyBza2lwcGVkOiB0cnVlLCByZWFzb246IFwiXHU2QjY0XHU2QTE5XHU3Njg0XHU1NzI4XHU3NkVFXHU1MjREIEZhY3RvcnkgXHU3MTIxXHU0RUUzXHU1RTYzXCIgfSk7XG4gICAgICB9XG4gICAgICBjb25zdCB7IGRhdGE6IGhvbGRlcnMsIGVycm9yOiBob2xkRXJyIH0gPSBhd2FpdCBhZG1pblxuICAgICAgICAuZnJvbShcImhvbGRpbmdzXCIpXG4gICAgICAgIC5zZWxlY3QoXCJ1c2VyX2lkLCBwcm9maWxlcyFpbm5lcih3YWxsZXRfYWRkcmVzcylcIilcbiAgICAgICAgLmVxKFwiYXNzZXRfaWRcIiwgcGxhY2VtZW50SWQpO1xuICAgICAgaWYgKGhvbGRFcnIpIHRocm93IG5ldyBFcnJvcihgXHU2N0U1XHU4QTYyXHU2MzAxXHU2NzA5XHU0RUJBXHU1OTMxXHU2NTU3XHVGRjFBJHtob2xkRXJyLm1lc3NhZ2V9YCk7XG4gICAgICBjb25zdCB3YWxsZXRzID0gQXJyYXkuZnJvbShcbiAgICAgICAgbmV3IFNldChcbiAgICAgICAgICAoaG9sZGVycyA/PyBbXSlcbiAgICAgICAgICAgIC5tYXAoKGg6IHsgcHJvZmlsZXM/OiB7IHdhbGxldF9hZGRyZXNzPzogc3RyaW5nIHwgbnVsbCB9IHwgbnVsbCB9KSA9PiBoLnByb2ZpbGVzPy53YWxsZXRfYWRkcmVzcz8udHJpbSgpID8/IG51bGwpXG4gICAgICAgICAgICAuZmlsdGVyKCh3KTogdyBpcyBzdHJpbmcgPT4gISF3ICYmIC9eMHhbYS1mQS1GMC05XXs0MH0kLy50ZXN0KHcpKSxcbiAgICAgICAgKSxcbiAgICAgICk7XG4gICAgICBjb25zdCByZWNsYWltZWQ6IHsgd2FsbGV0OiBzdHJpbmc7IGFtb3VudDogbnVtYmVyOyB0eEhhc2g6IHN0cmluZyB9W10gPSBbXTtcbiAgICAgIGNvbnN0IGZhaWxlZDogeyB3YWxsZXQ6IHN0cmluZzsgZXJyb3I6IHN0cmluZyB9W10gPSBbXTtcbiAgICAgIGZvciAoY29uc3QgdyBvZiB3YWxsZXRzKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3Qgd2FsbGV0ID0gZ2V0QWRkcmVzcyh3KTtcbiAgICAgICAgICBjb25zdCB7IGJhbGFuY2UgfSA9IGF3YWl0IGdldFdhbGxldFNoYXJlQmFsYW5jZSh0b2tlbkFkZHJlc3MsIHdhbGxldCk7XG4gICAgICAgICAgaWYgKGJhbGFuY2UgPD0gMCkgY29udGludWU7XG4gICAgICAgICAgY29uc3QgdHhIYXNoID0gYXdhaXQgcmVjbGFpbVJ3YVNoYXJlKGdldEFkZHJlc3ModG9rZW5BZGRyZXNzKSwgd2FsbGV0LCBiYWxhbmNlKTtcbiAgICAgICAgICBpZiAodHhIYXNoKSByZWNsYWltZWQucHVzaCh7IHdhbGxldDogdywgYW1vdW50OiBiYWxhbmNlLCB0eEhhc2ggfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBmYWlsZWQucHVzaCh7IHdhbGxldDogdywgZXJyb3I6IGVyck1zZyhlKSB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDIwMCwgeyByZWNsYWltZWQsIGZhaWxlZCB9KTtcbiAgICB9XG5cbiAgICAvLyAtLS0tIFx1N0JBMVx1NzQwNlx1NTRFMVx1RkYxQVx1OTFDRFx1NjVCMFx1NjdFNVx1OEE2Mlx1NTAwQlx1NTIyNVx1NkQzRVx1NzY3Q1x1NEVBNFx1NjYxM1x1NjUzNlx1NjREQVx1RkYwQ1x1NEUyNlx1NTcyOFx1NzhCQVx1OEE4RFx1NUY4Q1x1NTQwQ1x1NkI2NVx1N0RCMlx1N0FEOVx1NUUzM1x1NjcyQ1x1MzAwMi0tLS1cbiAgICBpZiAoYWN0aW9uID09PSBcImFkbWluLWFzc2V0LXBheW91dC1jaGVja1wiKSB7XG4gICAgICBpZiAoIWlzQWRtaW5Qcm9maWxlKGNhbGxlclByb2ZpbGUpKSB7XG4gICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDMsIHsgZXJyb3I6IFwiXHU1MEM1XHU5NjUwXHU3QkExXHU3NDA2XHU1NEUxXHU1N0Y3XHU4ODRDXCIgfSk7XG4gICAgICB9XG4gICAgICBjb25zdCByZXF1ZXN0S2V5ID0gKGJvZHkgYXMgeyByZXF1ZXN0S2V5Pzogc3RyaW5nIH0pLnJlcXVlc3RLZXk/LnRyaW0oKTtcbiAgICAgIGlmICghcmVxdWVzdEtleSB8fCAhL15bMC05YS1mXXs4fS1bMC05YS1mXXs0fS00WzAtOWEtZl17M30tWzg5YWJdWzAtOWEtZl17M30tWzAtOWEtZl17MTJ9JC9pLnRlc3QocmVxdWVzdEtleSkpIHtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMCwgeyBlcnJvcjogXCJcdTZEM0VcdTc2N0NcdThCNThcdTUyMjVcdTc4QkNcdTcxMjFcdTY1NDhcIiB9KTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlZktleSA9IGBhZG1pbl9wYXlvdXQ6JHtyZXF1ZXN0S2V5fWA7XG4gICAgICBjb25zdCB7IGRhdGE6IHNldHRsZW1lbnQsIGVycm9yIH0gPSBhd2FpdCBhZG1pblxuICAgICAgICAuZnJvbShcIm9uY2hhaW5fc2V0dGxlbWVudHNcIilcbiAgICAgICAgLnNlbGVjdChcImlkLGFjdGlvbixzdGF0dXMsdHhfaGFzaCxwYXlsb2FkXCIpXG4gICAgICAgIC5lcShcInJlZl9rZXlcIiwgcmVmS2V5KVxuICAgICAgICAubWF5YmVTaW5nbGUoKTtcbiAgICAgIGlmIChlcnJvciB8fCAhc2V0dGxlbWVudCB8fCBzZXR0bGVtZW50LmFjdGlvbiAhPT0gXCJhZG1pbl9wYXlvdXRcIikge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDA0LCB7IGVycm9yOiBcIlx1NjI3RVx1NEUwRFx1NTIzMFx1NTAwQlx1NTIyNVx1NkQzRVx1NzY3Q1x1N0QwMFx1OTMwNFwiIH0pO1xuICAgICAgfVxuICAgICAgY29uc3QgYXBwbHlQYXlvdXQgPSBhc3luYyAodHhIYXNoOiBzdHJpbmcpID0+IHtcbiAgICAgICAgY29uc3QgeyBlcnJvcjogbGVkZ2VyRXJyb3IgfSA9IGF3YWl0IGFkbWluLnJwYyhcImFkbWluX2FwcGx5X2Fzc2V0X3BheW91dFwiLCB7IHBfcmVmX2tleTogcmVmS2V5IH0pO1xuICAgICAgICBpZiAobGVkZ2VyRXJyb3IpIHtcbiAgICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNTAwLCB7XG4gICAgICAgICAgICBlcnJvcjogYFx1OTNDOFx1NEUwQVx1RkZGRFx1RkZGRFx1NzhCQVx1OEE4RFx1RkYwQ1x1NEY0Nlx1N0RCMlx1N0FEOVx1NUUzM1x1NjcyQ1x1NTQwQ1x1NkI2NVx1NTkzMVx1NjU1N1x1RkYxQlx1OEFDQlx1NTE4RFx1NkIyMVx1NjdFNVx1OEE2Mlx1NEVFNVx1OTFDRFx1OEE2Nlx1NTQwQ1x1NkI2NVx1MzAwMiR7bGVkZ2VyRXJyb3IubWVzc2FnZX1gLFxuICAgICAgICAgICAgc3RhdHVzOiBcImNvbmZpcm1lZFwiLFxuICAgICAgICAgICAgdHhfaGFzaDogdHhIYXNoLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCAyMDAsIHsgc3RhdHVzOiBcImNvbmZpcm1lZFwiLCB0eF9oYXNoOiB0eEhhc2ggfSk7XG4gICAgICB9O1xuICAgICAgaWYgKHNldHRsZW1lbnQuc3RhdHVzID09PSBcImNvbmZpcm1lZFwiICYmIHNldHRsZW1lbnQudHhfaGFzaCkgcmV0dXJuIGFwcGx5UGF5b3V0KHNldHRsZW1lbnQudHhfaGFzaCk7XG4gICAgICBpZiAoc2V0dGxlbWVudC5zdGF0dXMgPT09IFwiZmFpbGVkXCIpIHtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDIwMCwgeyBzdGF0dXM6IFwiZmFpbGVkXCIsIHR4X2hhc2g6IHNldHRsZW1lbnQudHhfaGFzaCB9KTtcbiAgICAgIH1cbiAgICAgIGlmICghc2V0dGxlbWVudC50eF9oYXNoKSB7XG4gICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCAyMDIsIHsgc3RhdHVzOiBcInBlbmRpbmdcIiwgdHhfaGFzaDogbnVsbCwgbWVzc2FnZTogXCJcdTVDMUFcdTY3MkFcdTUzRDZcdTVGOTdcdTkzQzhcdTRFMEFcdTRFQTRcdTY2MTNcdTk2RENcdTZFNEFcIiB9KTtcbiAgICAgIH1cbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHR4SGFzaCA9IHNldHRsZW1lbnQudHhfaGFzaCBhcyBgMHgke3N0cmluZ31gO1xuICAgICAgICBjb25zdCBjb25maXJtZWQgPSBhd2FpdCB3YWl0Rm9yQWRtaW5Bc3NldFBheW91dCh0eEhhc2gpO1xuICAgICAgICBpZiAoIWNvbmZpcm1lZCkge1xuICAgICAgICAgIGF3YWl0IGZpbmlzaChhZG1pbiwgc2V0dGxlbWVudC5pZCwgeyBzdGF0dXM6IFwiZmFpbGVkXCIsIHR4X2hhc2g6IHR4SGFzaCwgZXJyb3I6IFwiXHU5M0M4XHU0RTBBXHU0RUE0XHU2NjEzIHJldmVydGVkXCIgfSk7XG4gICAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDIwMCwgeyBzdGF0dXM6IFwiZmFpbGVkXCIsIHR4X2hhc2g6IHR4SGFzaCB9KTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBmaW5pc2goYWRtaW4sIHNldHRsZW1lbnQuaWQsIHsgc3RhdHVzOiBcImNvbmZpcm1lZFwiLCB0eF9oYXNoOiB0eEhhc2ggfSk7XG4gICAgICAgIHJldHVybiBhcHBseVBheW91dCh0eEhhc2gpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCAyMDIsIHsgc3RhdHVzOiBcInBlbmRpbmdcIiwgdHhfaGFzaDogc2V0dGxlbWVudC50eF9oYXNoIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIC0tLS0gXHU3QkExXHU3NDA2XHU1NEUxXHVGRjFBXHU1MDBCXHU1MjI1XHU2RDNFXHU3NjdDXHU2Qjc3XHU1M0YyXHUzMDAyXHU5MDBGXHU5MDRFIHNlcnZpY2Utcm9sZSBBUEkgXHU4QjgwXHU1M0Q2XHVGRjBDXHU5MDdGXHU1MTREXHU1QzA3XHU3RDUwXHU3Qjk3XHU4ODY4XHU5NThCXHU2NTNFXHU3RDY2XHU0RTAwXHU4MjJDXHU0RjdGXHU3NTI4XHU4MDA1XHUzMDAyLS0tLVxuICAgIGlmIChhY3Rpb24gPT09IFwiYWRtaW4tYXNzZXQtcGF5b3V0LWhpc3RvcnlcIikge1xuICAgICAgaWYgKCFpc0FkbWluUHJvZmlsZShjYWxsZXJQcm9maWxlKSkge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDAzLCB7IGVycm9yOiBcIlx1NTBDNVx1OTY1MFx1N0JBMVx1NzQwNlx1NTRFMVx1NTdGN1x1ODg0Q1wiIH0pO1xuICAgICAgfVxuICAgICAgY29uc3QgeyBkYXRhOiByb3dzLCBlcnJvciB9ID0gYXdhaXQgYWRtaW5cbiAgICAgICAgLmZyb20oXCJvbmNoYWluX3NldHRsZW1lbnRzXCIpXG4gICAgICAgIC5zZWxlY3QoXCJpZCxyZWZfa2V5LHVzZXJfaWQsYXNzZXRfaWQsYW1vdW50LHR4X2hhc2gsc3RhdHVzLGVycm9yLHBheWxvYWQsY3JlYXRlZF9hdCx1cGRhdGVkX2F0XCIpXG4gICAgICAgIC5lcShcImFjdGlvblwiLCBcImFkbWluX3BheW91dFwiKVxuICAgICAgICAub3JkZXIoXCJjcmVhdGVkX2F0XCIsIHsgYXNjZW5kaW5nOiBmYWxzZSB9KVxuICAgICAgICAubGltaXQoMzApO1xuICAgICAgaWYgKGVycm9yKSByZXR1cm4ganNvbihyZXNwb25zZSwgNTAwLCB7IGVycm9yOiBgXHU2RDNFXHU3NjdDXHU3RDAwXHU5MzA0XHU4QjgwXHU1M0Q2XHU1OTMxXHU2NTU3XHVGRjFBJHtlcnJvci5tZXNzYWdlfWAgfSk7XG4gICAgICBjb25zdCB1c2VySWRzID0gWy4uLm5ldyBTZXQoKHJvd3MgPz8gW10pLm1hcCgocm93KSA9PiByb3cudXNlcl9pZCkuZmlsdGVyKChpZCk6IGlkIGlzIHN0cmluZyA9PiBCb29sZWFuKGlkKSkpXTtcbiAgICAgIGNvbnN0IHBsYWNlbWVudElkcyA9IFsuLi5uZXcgU2V0KChyb3dzID8/IFtdKS5tYXAoKHJvdykgPT4gcm93LmFzc2V0X2lkKS5maWx0ZXIoKGlkKTogaWQgaXMgc3RyaW5nID0+IEJvb2xlYW4oaWQpKSldO1xuICAgICAgY29uc3QgW3Byb2ZpbGVzUmVzdWx0LCBwbGFjZW1lbnRzUmVzdWx0XSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgICAgdXNlcklkcy5sZW5ndGhcbiAgICAgICAgICA/IGFkbWluLmZyb20oXCJwcm9maWxlc1wiKS5zZWxlY3QoXCJpZCxlbWFpbFwiKS5pbihcImlkXCIsIHVzZXJJZHMpXG4gICAgICAgICAgOiBQcm9taXNlLnJlc29sdmUoeyBkYXRhOiBbXSwgZXJyb3I6IG51bGwgfSksXG4gICAgICAgIHBsYWNlbWVudElkcy5sZW5ndGhcbiAgICAgICAgICA/IGFkbWluLmZyb20oXCJwcml2YXRlX3BsYWNlbWVudHNcIikuc2VsZWN0KFwiaWQsbmFtZVwiKS5pbihcImlkXCIsIHBsYWNlbWVudElkcylcbiAgICAgICAgICA6IFByb21pc2UucmVzb2x2ZSh7IGRhdGE6IFtdLCBlcnJvcjogbnVsbCB9KSxcbiAgICAgIF0pO1xuICAgICAgaWYgKHByb2ZpbGVzUmVzdWx0LmVycm9yIHx8IHBsYWNlbWVudHNSZXN1bHQuZXJyb3IpIHtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDUwMCwgeyBlcnJvcjogXCJcdTZEM0VcdTc2N0NcdTdEMDBcdTkzMDRcdTk1RENcdTgwNkZcdThDQzdcdTY1OTlcdThCODBcdTUzRDZcdTU5MzFcdTY1NTdcIiB9KTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGVtYWlsQnlJZCA9IG5ldyBNYXAoKHByb2ZpbGVzUmVzdWx0LmRhdGEgPz8gW10pLm1hcCgocHJvZmlsZSkgPT4gW3Byb2ZpbGUuaWQsIHByb2ZpbGUuZW1haWxdKSk7XG4gICAgICBjb25zdCBwbGFjZW1lbnRCeUlkID0gbmV3IE1hcCgocGxhY2VtZW50c1Jlc3VsdC5kYXRhID8/IFtdKS5tYXAoKHBsYWNlbWVudCkgPT4gW3BsYWNlbWVudC5pZCwgcGxhY2VtZW50Lm5hbWVdKSk7XG4gICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7XG4gICAgICAgIHBheW91dHM6IChyb3dzID8/IFtdKS5tYXAoKHJvdywgaW5kZXgpID0+IHtcbiAgICAgICAgICBjb25zdCBwYXlsb2FkID0gcm93LnBheWxvYWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgICAgY29uc3QgYXNzZXRUeXBlID0gU3RyaW5nKHBheWxvYWQuYXNzZXRUeXBlID8/IFwiXCIpO1xuICAgICAgICAgIGNvbnN0IHBsYWNlbWVudElkID0gcGF5bG9hZC5wbGFjZW1lbnRJZCA/IFN0cmluZyhwYXlsb2FkLnBsYWNlbWVudElkKSA6IG51bGw7XG4gICAgICAgICAgY29uc3QgYW1vdW50ID0gU3RyaW5nKHBheWxvYWQuYW1vdW50ID8/IHJvdy5hbW91bnQgPz8gXCIwXCIpO1xuICAgICAgICAgIGNvbnN0IHN1cGVyc2VkZWRCeSA9IChyb3dzID8/IFtdKS5zbGljZSgwLCBpbmRleCkuZmluZCgobmV3ZXJSb3cpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IG5ld2VyUGF5bG9hZCA9IG5ld2VyUm93LnBheWxvYWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgICAgICByZXR1cm4gbmV3ZXJSb3cuc3RhdHVzID09PSBcImNvbmZpcm1lZFwiICYmIEJvb2xlYW4obmV3ZXJSb3cudHhfaGFzaCkgJiZcbiAgICAgICAgICAgICAgbmV3ZXJSb3cudXNlcl9pZCA9PT0gcm93LnVzZXJfaWQgJiYgbmV3ZXJSb3cuYXNzZXRfaWQgPT09IHJvdy5hc3NldF9pZCAmJlxuICAgICAgICAgICAgICBuZXdlclBheWxvYWQuYXNzZXRUeXBlID09PSBhc3NldFR5cGUgJiYgU3RyaW5nKG5ld2VyUGF5bG9hZC5hbW91bnQgPz8gbmV3ZXJSb3cuYW1vdW50ID8/IFwiMFwiKSA9PT0gYW1vdW50ICYmXG4gICAgICAgICAgICAgIChuZXdlclBheWxvYWQucGxhY2VtZW50SWQgPyBTdHJpbmcobmV3ZXJQYXlsb2FkLnBsYWNlbWVudElkKSA6IG51bGwpID09PSBwbGFjZW1lbnRJZDtcbiAgICAgICAgICB9KTtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgaWQ6IHJvdy5pZCxcbiAgICAgICAgICAgIHJlcXVlc3RLZXk6IHJvdy5yZWZfa2V5LnJlcGxhY2UoL15hZG1pbl9wYXlvdXQ6LywgXCJcIiksXG4gICAgICAgICAgICByZWNpcGllbnRJZDogcm93LnVzZXJfaWQsXG4gICAgICAgICAgICByZWNpcGllbnRFbWFpbDogcm93LnVzZXJfaWQgPyBlbWFpbEJ5SWQuZ2V0KHJvdy51c2VyX2lkKSA/PyBudWxsIDogbnVsbCxcbiAgICAgICAgICAgIGFzc2V0VHlwZSxcbiAgICAgICAgICAgIHBsYWNlbWVudElkLFxuICAgICAgICAgICAgcGxhY2VtZW50TmFtZTogcm93LmFzc2V0X2lkID8gcGxhY2VtZW50QnlJZC5nZXQocm93LmFzc2V0X2lkKSA/PyBudWxsIDogbnVsbCxcbiAgICAgICAgICAgIGFtb3VudCxcbiAgICAgICAgICAgIHN0YXR1czogcm93LnN0YXR1cyxcbiAgICAgICAgICAgIHR4SGFzaDogcm93LnR4X2hhc2gsXG4gICAgICAgICAgICBlcnJvcjogcm93LmVycm9yLFxuICAgICAgICAgICAgYWNjb3VudGVkOiBwYXlsb2FkLmFjY291bnRlZCA9PT0gdHJ1ZSxcbiAgICAgICAgICAgIHN1cGVyc2VkZWQ6IEJvb2xlYW4oc3VwZXJzZWRlZEJ5KSxcbiAgICAgICAgICAgIGNyZWF0ZWRBdDogcm93LmNyZWF0ZWRfYXQsXG4gICAgICAgICAgICB1cGRhdGVkQXQ6IHJvdy51cGRhdGVkX2F0LFxuICAgICAgICAgIH07XG4gICAgICAgIH0pLnNsaWNlKDAsIDUpLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gLS0tLSBcdTdCQTFcdTc0MDZcdTU0RTFcdUZGMUFcdTUwMEJcdTUyMjVcdTRFRTNcdTc0MDZcdThDQzdcdTc1MjJcdTZEM0VcdTc2N0NcdTMwMDJcdTY1MzZcdTZCM0VcdTRFQkFcdTgyMDdcdTU0MDhcdTdEMDRcdTRGNERcdTU3NDBcdTUzRUFcdTc1MzFcdTRGM0FcdTY3MERcdTU2NjhcdTdBRUZcdThDQzdcdTY1OTlcdTYzQThcdTVDMEVcdUZGMUJcbiAgICAvLyBcdTZCQ0ZcdTdCNDZcdThBQ0JcdTZDNDJcdTc1MjggcmVxdWVzdEtleSBcdTUxQUFcdTdCNDlcdUZGMENcdTRFMjZcdTU3MjhcdTc4QkFcdThBOERcdTkzQzhcdTRFMEFcdTYyMTBcdTUyOUZcdTVGOENcdTYyNERcdTU0MENcdTZCNjVcdTdEQjJcdTdBRDkgSkNcdUZGMEZBRVx1RkYwRlJXQSBcdTVFMzNcdTY3MkNcdTMwMDItLS0tXG4gICAgaWYgKGFjdGlvbiA9PT0gXCJhZG1pbi1hc3NldC1wYXlvdXRcIikge1xuICAgICAgaWYgKCFpc0FkbWluUHJvZmlsZShjYWxsZXJQcm9maWxlKSkge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDAzLCB7IGVycm9yOiBcIlx1NTBDNVx1OTY1MFx1N0JBMVx1NzQwNlx1NTRFMVx1NTdGN1x1ODg0Q1wiIH0pO1xuICAgICAgfVxuICAgICAgY29uc3QgaW5wdXQgPSBib2R5IGFzIHtcbiAgICAgICAgcmVjaXBpZW50SWQ/OiBzdHJpbmc7XG4gICAgICAgIGFzc2V0VHlwZT86IHN0cmluZztcbiAgICAgICAgYW1vdW50Pzogc3RyaW5nO1xuICAgICAgICBwbGFjZW1lbnRJZD86IHN0cmluZztcbiAgICAgICAgcmVxdWVzdEtleT86IHN0cmluZztcbiAgICAgIH07XG4gICAgICBjb25zdCByZWNpcGllbnRJZCA9IGlucHV0LnJlY2lwaWVudElkPy50cmltKCk7XG4gICAgICBjb25zdCBhc3NldFR5cGUgPSBpbnB1dC5hc3NldFR5cGU7XG4gICAgICBjb25zdCBhbW91bnQgPSBpbnB1dC5hbW91bnQ/LnRyaW0oKTtcbiAgICAgIGNvbnN0IHBsYWNlbWVudElkID0gaW5wdXQucGxhY2VtZW50SWQ/LnRyaW0oKSB8fCBudWxsO1xuICAgICAgY29uc3QgcmVxdWVzdEtleSA9IGlucHV0LnJlcXVlc3RLZXk/LnRyaW0oKTtcbiAgICAgIGlmICghcmVjaXBpZW50SWQgfHwgIWFtb3VudCB8fCAhcmVxdWVzdEtleSB8fCAhL15bMC05YS1mXXs4fS1bMC05YS1mXXs0fS00WzAtOWEtZl17M30tWzg5YWJdWzAtOWEtZl17M30tWzAtOWEtZl17MTJ9JC9pLnRlc3QocmVxdWVzdEtleSkpIHtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMCwgeyBlcnJvcjogXCJcdTZEM0VcdTc2N0NcdThDQzdcdTY1OTlcdTRFMERcdTVCOENcdTY1NzRcdUZGMENcdThBQ0JcdTkxQ0RcdTY1QjBcdTY0Q0RcdTRGNUNcIiB9KTtcbiAgICAgIH1cbiAgICAgIGlmICghL14oPzowfFsxLTldXFxkKikoPzpcXC5cXGR7MSw2fSk/JC8udGVzdChhbW91bnQpIHx8ICEoTnVtYmVyKGFtb3VudCkgPiAwKSB8fCBOdW1iZXIoYW1vdW50KSA+IDFfMDAwXzAwMF8wMDBfMDAwKSB7XG4gICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDAsIHsgZXJyb3I6IFwiXHU2NTc4XHU5MUNGXHU5ODA4XHU1OTI3XHVGRkZEXHVGRkZEIDBcdUZGMENcdTRFMTRcdTY3MDBcdTU5MUFcdThGMzhcdTUxNjUgNiBcdTRGNERcdTVDMEZcdTY1NzhcIiB9KTtcbiAgICAgIH1cbiAgICAgIGlmICghW1wiamNcIiwgXCJhZVwiLCBcInJ3YVwiLCBcInVzZHRcIl0uaW5jbHVkZXMoU3RyaW5nKGFzc2V0VHlwZSkpKSB7XG4gICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDAsIHsgZXJyb3I6IFwiXHU0RTBEXHU2NTJGXHU2M0Y0XHU3Njg0XHU2RDNFXHU3NjdDXHU4Q0M3XHU3NTIyXCIgfSk7XG4gICAgICB9XG4gICAgICBpZiAoYXNzZXRUeXBlID09PSBcInJ3YVwiICYmICEvXlxcZCskLy50ZXN0KGFtb3VudCkpIHtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMCwgeyBlcnJvcjogXCJSV0EgXHU0RUZEXHU5ODREXHU2RDNFXHU3NjdDXHU1MEM1XHU2NTJGXHU2M0Y0XHU2NTc0XHU2NTc4XCIgfSk7XG4gICAgICB9XG4gICAgICBpZiAoKGFzc2V0VHlwZSA9PT0gXCJyd2FcIiB8fCBhc3NldFR5cGUgPT09IFwiYWVcIikgIT09IEJvb2xlYW4ocGxhY2VtZW50SWQpKSB7XG4gICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDAsIHsgZXJyb3I6IFwiXHU4QUNCXHU5MDc4XHU2NEM3XHU4OTgxXHU4QTE4XHU1MTY1XHU3REIyXHU3QUQ5XHU2MzAxXHU1MDA5XHU3Njg0XHU2QTE5XHU3Njg0XCIgfSk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHsgZGF0YTogcmVjaXBpZW50IH0gPSBhd2FpdCBhZG1pblxuICAgICAgICAuZnJvbShcInByb2ZpbGVzXCIpXG4gICAgICAgIC5zZWxlY3QoXCJpZCxlbWFpbCxhZ2VuY3lfcm9sZSx3YWxsZXRfYWRkcmVzc1wiKVxuICAgICAgICAuZXEoXCJpZFwiLCByZWNpcGllbnRJZClcbiAgICAgICAgLm1heWJlU2luZ2xlKCk7XG4gICAgICBpZiAoIXJlY2lwaWVudCB8fCAhU3RyaW5nKHJlY2lwaWVudC5hZ2VuY3lfcm9sZSA/PyBcIlwiKS5pbmNsdWRlcyhcIlx1NEVFM1x1NzQwNlwiKSkge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDA0LCB7IGVycm9yOiBcIlx1NjI3RVx1NEUwRFx1NTIzMFx1NjcwOVx1NjU0OFx1NzY4NFx1NEVFM1x1NzQwNlx1NUUzM1x1ODY1RlwiIH0pO1xuICAgICAgfVxuICAgICAgbGV0IHdhbGxldDogQWRkcmVzcztcbiAgICAgIHRyeSB7XG4gICAgICAgIHdhbGxldCA9IHRvQWRkcmVzcyhyZWNpcGllbnQud2FsbGV0X2FkZHJlc3MsIFwiXHU0RUUzXHU3NDA2XHU1RTMzXHU4NjVGXCIpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDIyLCB7IGVycm9yOiBlcnJNc2coZSkgfSk7XG4gICAgICB9XG5cbiAgICAgIGxldCB0b2tlbkFkZHJlc3M6IEFkZHJlc3M7XG4gICAgICBsZXQgYXNzZXRMYWJlbDogc3RyaW5nO1xuICAgICAgbGV0IGxlZGdlckFzc2V0SWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgICAgaWYgKGFzc2V0VHlwZSA9PT0gXCJqY1wiKSB7XG4gICAgICAgIHRva2VuQWRkcmVzcyA9IFJFTEFZRVJfQUREUkVTU0VTLmpjVG9rZW47XG4gICAgICAgIGFzc2V0TGFiZWwgPSBcIkpDXCI7XG4gICAgICB9IGVsc2UgaWYgKGFzc2V0VHlwZSA9PT0gXCJhZVwiKSB7XG4gICAgICAgIGNvbnN0IHsgZGF0YTogcGxhY2VtZW50IH0gPSBhd2FpdCBhZG1pblxuICAgICAgICAgIC5mcm9tKFwicHJpdmF0ZV9wbGFjZW1lbnRzXCIpXG4gICAgICAgICAgLnNlbGVjdChcImlkLG5hbWUsaXNfYWVfdG9rZW5cIilcbiAgICAgICAgICAuZXEoXCJpZFwiLCBwbGFjZW1lbnRJZClcbiAgICAgICAgICAubWF5YmVTaW5nbGUoKTtcbiAgICAgICAgaWYgKCFwbGFjZW1lbnQ/LmlzX2FlX3Rva2VuKSByZXR1cm4ganNvbihyZXNwb25zZSwgNDIyLCB7IGVycm9yOiBcIlx1NjI0MFx1OTA3OFx1N0RCMlx1N0FEOVx1NkExOVx1NzY4NFx1NEUwRFx1NjYyRiBBRSBcdTZBMTlcdTc2ODRcIiB9KTtcbiAgICAgICAgdG9rZW5BZGRyZXNzID0gUkVMQVlFUl9BRERSRVNTRVMuYWVUb2tlbjtcbiAgICAgICAgYXNzZXRMYWJlbCA9IGBBRVx1RkYwOCR7cGxhY2VtZW50Lm5hbWV9XHVGRjA5YDtcbiAgICAgICAgbGVkZ2VyQXNzZXRJZCA9IHBsYWNlbWVudC5pZDtcbiAgICAgIH0gZWxzZSBpZiAoYXNzZXRUeXBlID09PSBcInJ3YVwiKSB7XG4gIGNvbnN0IHsgZGF0YTogcGxhY2VtZW50IH0gPSBhd2FpdCBhZG1pblxuICAgIC5mcm9tKFwicHJpdmF0ZV9wbGFjZW1lbnRzXCIpXG4gICAgLnNlbGVjdChcImlkLG5hbWUsaXNfYWVfdG9rZW5cIilcbiAgICAuZXEoXCJpZFwiLCBwbGFjZW1lbnRJZClcbiAgICAubWF5YmVTaW5nbGUoKTtcbiAgY29uc3QgcndhVG9rZW4gPSBwbGFjZW1lbnQgJiYgIXBsYWNlbWVudC5pc19hZV90b2tlblxuICAgID8gYXdhaXQgZ2V0Q3VycmVudFJ3YUZhY3RvcnlUb2tlbihwbGFjZW1lbnQuaWQpXG4gICAgOiBudWxsO1xuICBpZiAoIXBsYWNlbWVudCB8fCBwbGFjZW1lbnQuaXNfYWVfdG9rZW4gfHwgIXJ3YVRva2VuKSB7XG4gICAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQyMiwgeyBlcnJvcjogXCJcdTYyNDBcdTkwNzggUldBIFx1NkExOVx1NzY4NFx1NUMxQVx1NjcyQVx1OTBFOFx1N0Y3Mlx1NjcwOVx1NjU0OFx1NzY4NFx1NUMwOFx1NUM2Q1x1NEVFM1x1NUU2M1wiIH0pO1xuICAgICAgICB9XG4gICAgICAgIHRva2VuQWRkcmVzcyA9IHJ3YVRva2VuO1xuICAgICAgICBhc3NldExhYmVsID0gYFJXQVx1RkYwOCR7cGxhY2VtZW50Lm5hbWV9XHVGRjA5YDtcbiAgICAgICAgbGVkZ2VyQXNzZXRJZCA9IHBsYWNlbWVudC5pZDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRva2VuQWRkcmVzcyA9IFJFTEFZRVJfQUREUkVTU0VTLnVzZHQ7XG4gICAgICAgIGFzc2V0TGFiZWwgPSBcIlVTRFRcIjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcmVmS2V5ID0gYGFkbWluX3BheW91dDoke3JlcXVlc3RLZXl9YDtcbiAgICAgIGNvbnN0IHBheWxvYWQgPSB7IGFzc2V0VHlwZSwgYW1vdW50LCB3YWxsZXQsIHRva2VuQWRkcmVzcywgcGxhY2VtZW50SWQgfTtcbiAgICAgIGxldCB7IGRhdGE6IHNldHRsZW1lbnQgfSA9IGF3YWl0IGFkbWluXG4gICAgICAgIC5mcm9tKFwib25jaGFpbl9zZXR0bGVtZW50c1wiKVxuICAgICAgICAuc2VsZWN0KFwiaWQsYWN0aW9uLHN0YXR1cyx0eF9oYXNoLHVzZXJfaWQsYXNzZXRfaWQscGF5bG9hZFwiKVxuICAgICAgICAuZXEoXCJyZWZfa2V5XCIsIHJlZktleSlcbiAgICAgICAgLm1heWJlU2luZ2xlKCk7XG4gICAgICBsZXQgaXNOZXdTZXR0bGVtZW50ID0gZmFsc2U7XG4gICAgICBpZiAoc2V0dGxlbWVudCkge1xuICAgICAgICBjb25zdCBzYXZlZCA9IHNldHRsZW1lbnQucGF5bG9hZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHNldHRsZW1lbnQuYWN0aW9uICE9PSBcImFkbWluX3BheW91dFwiIHx8IHNldHRsZW1lbnQudXNlcl9pZCAhPT0gcmVjaXBpZW50SWQgfHxcbiAgICAgICAgICBzZXR0bGVtZW50LmFzc2V0X2lkICE9PSBsZWRnZXJBc3NldElkIHx8IHNhdmVkLmFzc2V0VHlwZSAhPT0gYXNzZXRUeXBlIHx8XG4gICAgICAgICAgc2F2ZWQuYW1vdW50ICE9PSBhbW91bnQgfHwgc2F2ZWQucGxhY2VtZW50SWQgIT09IHBsYWNlbWVudElkIHx8XG4gICAgICAgICAgc2F2ZWQud2FsbGV0ICE9PSB3YWxsZXQgfHwgc2F2ZWQudG9rZW5BZGRyZXNzICE9PSB0b2tlbkFkZHJlc3NcbiAgICAgICAgKSB7XG4gICAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwOSwgeyBlcnJvcjogXCJcdTZCNjRcdTZEM0VcdTc2N0NcdThCNThcdTUyMjVcdTc4QkNcdTVERjJcdTc1MjhcdTY1QkNcdTUxNzZcdTRFRDZcdThDQzdcdTY1OTlcdUZGMENcdThBQ0JcdTkxQ0RcdTY1QjBcdTY0Q0RcdTRGNUNcIiB9KTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgaW5zZXJ0ZWQgPSBhd2FpdCBhZG1pblxuICAgICAgICAgIC5mcm9tKFwib25jaGFpbl9zZXR0bGVtZW50c1wiKVxuICAgICAgICAgIC5pbnNlcnQoe1xuICAgICAgICAgICAgYWN0aW9uOiBcImFkbWluX3BheW91dFwiLFxuICAgICAgICAgICAgcmVmX2tleTogcmVmS2V5LFxuICAgICAgICAgICAgdXNlcl9pZDogcmVjaXBpZW50SWQsXG4gICAgICAgICAgICBjb3VudGVycGFydHlfaWQ6IGNhbGxlci5pZCxcbiAgICAgICAgICAgIGFzc2V0X2lkOiBsZWRnZXJBc3NldElkLFxuICAgICAgICAgICAgYW1vdW50OiBOdW1iZXIoYW1vdW50KSxcbiAgICAgICAgICAgIHN0YXR1czogXCJwZW5kaW5nXCIsXG4gICAgICAgICAgICBwYXlsb2FkLFxuICAgICAgICAgIH0pXG4gICAgICAgICAgLnNlbGVjdChcImlkLGFjdGlvbixzdGF0dXMsdHhfaGFzaCx1c2VyX2lkLGFzc2V0X2lkLHBheWxvYWRcIilcbiAgICAgICAgICAuc2luZ2xlKCk7XG4gICAgICAgIHNldHRsZW1lbnQgPSBpbnNlcnRlZC5kYXRhO1xuICAgICAgICBpZiAoaW5zZXJ0ZWQuZXJyb3IgfHwgIXNldHRsZW1lbnQpIHtcbiAgICAgICAgICBjb25zdCByYWNlZCA9IGF3YWl0IGFkbWluXG4gICAgICAgICAgICAuZnJvbShcIm9uY2hhaW5fc2V0dGxlbWVudHNcIilcbiAgICAgICAgICAgIC5zZWxlY3QoXCJpZCxhY3Rpb24sc3RhdHVzLHR4X2hhc2gsdXNlcl9pZCxhc3NldF9pZCxwYXlsb2FkXCIpXG4gICAgICAgICAgICAuZXEoXCJyZWZfa2V5XCIsIHJlZktleSlcbiAgICAgICAgICAgIC5tYXliZVNpbmdsZSgpO1xuICAgICAgICAgIGlmICghcmFjZWQuZGF0YSkge1xuICAgICAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDUwMCwgeyBlcnJvcjogYFx1NzEyMVx1NkNENVx1NUVGQVx1N0FDQlx1NkQzRVx1NzY3Q1x1N0EzRFx1NjgzOFx1N0QwMFx1OTMwNFx1RkYxQSR7aW5zZXJ0ZWQuZXJyb3I/Lm1lc3NhZ2UgPz8gXCJcdTY3MkFcdTc3RTVcdThDQzdcdTY1OTlcdTVFQUJcdTkzMkZcdThBQTRcIn1gIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgICBzZXR0bGVtZW50ID0gcmFjZWQuZGF0YTtcbiAgICAgICAgICBjb25zdCBzYXZlZCA9IHNldHRsZW1lbnQucGF5bG9hZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgICBpZiAoXG4gICAgICAgICAgICBzZXR0bGVtZW50LmFjdGlvbiAhPT0gXCJhZG1pbl9wYXlvdXRcIiB8fCBzZXR0bGVtZW50LnVzZXJfaWQgIT09IHJlY2lwaWVudElkIHx8XG4gICAgICAgICAgICBzZXR0bGVtZW50LmFzc2V0X2lkICE9PSBsZWRnZXJBc3NldElkIHx8IHNhdmVkLmFtb3VudCAhPT0gYW1vdW50IHx8XG4gICAgICAgICAgICBzYXZlZC53YWxsZXQgIT09IHdhbGxldCB8fCBzYXZlZC5hc3NldFR5cGUgIT09IGFzc2V0VHlwZSB8fFxuICAgICAgICAgICAgc2F2ZWQucGxhY2VtZW50SWQgIT09IHBsYWNlbWVudElkIHx8IHNhdmVkLnRva2VuQWRkcmVzcyAhPT0gdG9rZW5BZGRyZXNzXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDA5LCB7IGVycm9yOiBcIlx1NkI2NFx1NkQzRVx1NzY3Q1x1OEI1OFx1NTIyNVx1NzhCQ1x1NURGMlx1NzUyOFx1NjVCQ1x1NTE3Nlx1NEVENlx1OENDN1x1NjU5OVx1RkYwQ1x1OEFDQlx1OTFDRFx1NjVCMFx1NjRDRFx1NEY1Q1wiIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBpc05ld1NldHRsZW1lbnQgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGFwcGx5UGF5b3V0VG9XZWJzaXRlID0gYXN5bmMgKHR4SGFzaDogc3RyaW5nKSA9PiB7XG4gICAgICAgIGNvbnN0IHsgZXJyb3IgfSA9IGF3YWl0IGFkbWluLnJwYyhcImFkbWluX2FwcGx5X2Fzc2V0X3BheW91dFwiLCB7IHBfcmVmX2tleTogcmVmS2V5IH0pO1xuICAgICAgICBpZiAoZXJyb3IpIHtcbiAgICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNTAwLCB7XG4gICAgICAgICAgICBlcnJvcjogYFx1OTNDOFx1NEUwQVx1NURGMlx1NjIxMFx1NTI5Rlx1OEY0OVx1NUUzM1x1RkYwOCR7dHhIYXNofVx1RkYwOVx1RkYwQ1x1NEY0Nlx1N0RCMlx1N0FEOVx1NUUzM1x1NjcyQ1x1NTQwQ1x1NkI2NVx1NTkzMVx1NjU1N1x1RkYxQlx1OEFDQlx1NEY3Rlx1NzUyOFx1NTQwQ1x1NEUwMFx1N0I0Nlx1NkQzRVx1NzY3Q1x1OTFDRFx1OEE2Nlx1NTQwQ1x1NkI2NVx1MzAwMiR7ZXJyb3IubWVzc2FnZX1gLFxuICAgICAgICAgICAgc3RhdHVzOiBcImNvbmZpcm1lZFwiLFxuICAgICAgICAgICAgdHhfaGFzaDogdHhIYXNoLFxuICAgICAgICAgICAgcmVxdWVzdEtleSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IHN0YXR1czogXCJjb25maXJtZWRcIiwgdHhfaGFzaDogdHhIYXNoLCBhc3NldFR5cGUsIGFtb3VudCwgd2FsbGV0LCByZXF1ZXN0S2V5IH0pO1xuICAgICAgfTtcblxuICAgICAgaWYgKHNldHRsZW1lbnQuc3RhdHVzID09PSBcImNvbmZpcm1lZFwiICYmIHNldHRsZW1lbnQudHhfaGFzaCkge1xuICAgICAgICByZXR1cm4gYXBwbHlQYXlvdXRUb1dlYnNpdGUoc2V0dGxlbWVudC50eF9oYXNoKTtcbiAgICAgIH1cbiAgICAgIGlmIChzZXR0bGVtZW50LnN0YXR1cyA9PT0gXCJwZW5kaW5nXCIgJiYgc2V0dGxlbWVudC50eF9oYXNoKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgY29uZmlybWVkID0gYXdhaXQgd2FpdEZvckFkbWluQXNzZXRQYXlvdXQoc2V0dGxlbWVudC50eF9oYXNoIGFzIGAweCR7c3RyaW5nfWApO1xuICAgICAgICAgIGlmIChjb25maXJtZWQpIHtcbiAgICAgICAgICAgIGF3YWl0IGZpbmlzaChhZG1pbiwgc2V0dGxlbWVudC5pZCwgeyBzdGF0dXM6IFwiY29uZmlybWVkXCIsIHR4X2hhc2g6IHNldHRsZW1lbnQudHhfaGFzaCB9KTtcbiAgICAgICAgICAgIHJldHVybiBhcHBseVBheW91dFRvV2Vic2l0ZShzZXR0bGVtZW50LnR4X2hhc2gpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBhd2FpdCBmaW5pc2goYWRtaW4sIHNldHRsZW1lbnQuaWQsIHsgc3RhdHVzOiBcImZhaWxlZFwiLCB0eF9oYXNoOiBzZXR0bGVtZW50LnR4X2hhc2gsIGVycm9yOiBcIlx1OTNDOFx1NEUwQVx1NEVBNFx1NjYxMyByZXZlcnRlZFwiIH0pO1xuICAgICAgICAgIHNldHRsZW1lbnQuc3RhdHVzID0gXCJmYWlsZWRcIjtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDIwMiwgeyBzdGF0dXM6IFwicGVuZGluZ1wiLCB0eF9oYXNoOiBzZXR0bGVtZW50LnR4X2hhc2gsIGFzc2V0VHlwZSwgYW1vdW50LCB3YWxsZXQsIHJlcXVlc3RLZXkgfSk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoc2V0dGxlbWVudC5zdGF0dXMgPT09IFwicGVuZGluZ1wiICYmICFpc05ld1NldHRsZW1lbnQpIHtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDIwMiwgeyBzdGF0dXM6IFwicGVuZGluZ1wiLCBhc3NldFR5cGUsIGFtb3VudCwgd2FsbGV0LCByZXF1ZXN0S2V5IH0pO1xuICAgICAgfVxuXG4gICAgICBpZiAoIShhd2FpdCBndWFyZFJlbGF5ZXJHYXMocmVzcG9uc2UpKSkgcmV0dXJuO1xuICAgICAgbGV0IHR4SGFzaDogYDB4JHtzdHJpbmd9YDtcbiAgICAgIHRyeSB7XG4gICAgICAgIHR4SGFzaCA9IGF3YWl0IHNlbmRBZG1pbkFzc2V0UGF5b3V0KHsgdG9rZW5BZGRyZXNzLCByZWNpcGllbnQ6IHdhbGxldCwgYW1vdW50LCBsYWJlbDogYXNzZXRMYWJlbCB9KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgYXdhaXQgZmluaXNoKGFkbWluLCBzZXR0bGVtZW50LmlkLCB7IHN0YXR1czogXCJmYWlsZWRcIiwgZXJyb3I6IGVyck1zZyhlKSB9KTtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDUwMiwgeyBlcnJvcjogYFx1NzFCMVx1OTMyMlx1NTMwNVx1NkQzRVx1NzY3Q1x1NTkzMVx1NjU1N1x1RkYxQSR7ZXJyTXNnKGUpfWAgfSk7XG4gICAgICB9XG4gICAgICBjb25zdCBzYXZlZFR4ID0gYXdhaXQgYWRtaW5cbiAgICAgICAgLmZyb20oXCJvbmNoYWluX3NldHRsZW1lbnRzXCIpXG4gICAgICAgIC51cGRhdGUoeyBzdGF0dXM6IFwicGVuZGluZ1wiLCB0eF9oYXNoOiB0eEhhc2gsIGVycm9yOiBudWxsLCB1cGRhdGVkX2F0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkgfSlcbiAgICAgICAgLmVxKFwiaWRcIiwgc2V0dGxlbWVudC5pZCk7XG4gICAgICBpZiAoc2F2ZWRUeC5lcnJvcikge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNTAwLCB7IGVycm9yOiBgXHU0RUE0XHU2NjEzXHU1REYyXHU5MDAxXHU1MUZBXHU0RjQ2XHU3MTIxXHU2Q0Q1XHU1MTMyXHU1QjU4XHU0RUE0XHU2NjEzXHU5NkRDXHU2RTRBXHVGRjFBJHt0eEhhc2h9YCwgdHhfaGFzaDogdHhIYXNoLCBzdGF0dXM6IFwicGVuZGluZ1wiLCByZXF1ZXN0S2V5IH0pO1xuICAgICAgfVxuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgY29uZmlybWVkID0gYXdhaXQgd2FpdEZvckFkbWluQXNzZXRQYXlvdXQodHhIYXNoKTtcbiAgICAgICAgaWYgKCFjb25maXJtZWQpIHtcbiAgICAgICAgICBhd2FpdCBmaW5pc2goYWRtaW4sIHNldHRsZW1lbnQuaWQsIHsgc3RhdHVzOiBcImZhaWxlZFwiLCB0eF9oYXNoOiB0eEhhc2gsIGVycm9yOiBcIlx1OTNDOFx1NEUwQVx1NEVBNFx1NjYxMyByZXZlcnRlZFwiIH0pO1xuICAgICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA1MDIsIHsgZXJyb3I6IGBcdTkzQzhcdTRFMEFcdThGNDlcdTVFMzNcdTU5MzFcdTY1NTdcdUZGMUEke3R4SGFzaH1gLCB0eF9oYXNoOiB0eEhhc2gsIHN0YXR1czogXCJmYWlsZWRcIiB9KTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCAyMDIsIHsgc3RhdHVzOiBcInBlbmRpbmdcIiwgdHhfaGFzaDogdHhIYXNoLCBhc3NldFR5cGUsIGFtb3VudCwgd2FsbGV0LCByZXF1ZXN0S2V5IH0pO1xuICAgICAgfVxuICAgICAgYXdhaXQgZmluaXNoKGFkbWluLCBzZXR0bGVtZW50LmlkLCB7IHN0YXR1czogXCJjb25maXJtZWRcIiwgdHhfaGFzaDogdHhIYXNoIH0pO1xuICAgICAgcmV0dXJuIGFwcGx5UGF5b3V0VG9XZWJzaXRlKHR4SGFzaCk7XG4gICAgfVxuXG4gICAgLy8gLS0tLSBcdTdCQTFcdTc0MDZcdTU0RTFcdUZGMUFcdTU3MjggUldBIEZhY3RvcnkgXHU3MEJBXHU2QjY0XHU2QTE5XHU3Njg0XHU5MEU4XHU3RjcyXHU1QzA4XHU1QzZDXHU0RUZEXHU5ODREXHU0RUUzXHU1RTYzXHVGRjA4XHU1MEM1XHU5NjUwXHU1QzFBXHU2NzJBXHU2NzA5XG4gICAgLy8gdG9rZW5fYWRkcmVzcyBcdTc2ODRcdTZBMTlcdTc2ODRcdUZGMDlcdUZGMENcdTYyMTBcdTUyOUZcdTVGOENcdTc2RjRcdTYzQTVcdTYyOEFcdTU2REVcdTUwQjNcdTU3MzBcdTU3NDBcdTVCRUJcdTU2REUgcHJpdmF0ZV9wbGFjZW1lbnRzXHVGRjBDXG4gICAgLy8gXHU1MjREXHU3QUVGXHU0RTBEXHU5NzAwXHU4OTgxXHU1M0U2XHU1OTE2XHU1NDdDXHU1M0VCXHU0RTAwXHU2QjIxIGFkbWluX3NldF9wbGFjZW1lbnRfdG9rZW5fYWRkcmVzc1x1MzAwMi0tLS1cbiAgICBpZiAoYWN0aW9uID09PSBcImFkbWluLWNyZWF0ZS1yd2EtdG9rZW5cIikge1xuICAgICAgaWYgKCFpc0FkbWluUHJvZmlsZShjYWxsZXJQcm9maWxlKSkge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDAzLCB7IGVycm9yOiBcIlx1NTBDNVx1OTY1MFx1N0JBMVx1NzQwNlx1NTRFMVx1NTdGN1x1ODg0Q1wiIH0pO1xuICAgICAgfVxuICAgICAgY29uc3QgcGxhY2VtZW50SWQgPSAoYm9keSBhcyB7IHBsYWNlbWVudElkPzogc3RyaW5nIH0pLnBsYWNlbWVudElkO1xuICAgICAgaWYgKCFwbGFjZW1lbnRJZCkgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMCwgeyBlcnJvcjogXCJcdTdGM0FcdTVDMTEgcGxhY2VtZW50SWRcIiB9KTtcbiAgICAgIGNvbnN0IHsgZGF0YTogcGxhY2VtZW50IH0gPSBhd2FpdCBhZG1pblxuICAgICAgICAuZnJvbShcInByaXZhdGVfcGxhY2VtZW50c1wiKVxuICAgICAgICAuc2VsZWN0KFwiaWQsbmFtZSx0b2tlbl9uYW1lLHRva2VuX3N5bWJvbCx0b2tlbl9kZWNpbWFscyx0b3RhbF9zdXBwbHksaXNfYWVfdG9rZW5cIilcbiAgICAgICAgLmVxKFwiaWRcIiwgcGxhY2VtZW50SWQpXG4gICAgICAgIC5tYXliZVNpbmdsZSgpO1xuICAgICAgaWYgKCFwbGFjZW1lbnQpIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDQsIHsgZXJyb3I6IFwiXHU2MjdFXHU0RTBEXHU1MjMwXHU1QzBEXHU2MUM5XHU3Njg0XHU2QTE5XHU3Njg0XCIgfSk7XG4gICAgICBpZiAocGxhY2VtZW50LmlzX2FlX3Rva2VuKSByZXR1cm4ganNvbihyZXNwb25zZSwgNDIyLCB7IGVycm9yOiBcIkFFIFx1NEVFM1x1NUU2M1x1NEUwRFx1NEY3Rlx1NzUyOCBSV0EgRmFjdG9yeVwiIH0pO1xuICAgICAgY29uc3QgZXhpc3RpbmdBZGRyID0gYXdhaXQgZ2V0Q3VycmVudFJ3YUZhY3RvcnlUb2tlbihwbGFjZW1lbnRJZCk7XG4gICAgICBpZiAoZXhpc3RpbmdBZGRyKSB7XG4gICAgICAgIGF3YWl0IGFkbWluLmZyb20oXCJwcml2YXRlX3BsYWNlbWVudHNcIikudXBkYXRlKHsgdG9rZW5fYWRkcmVzczogZXhpc3RpbmdBZGRyIH0pLmVxKFwiaWRcIiwgcGxhY2VtZW50SWQpO1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IHRva2VuQWRkcmVzczogZXhpc3RpbmdBZGRyLCBhbHJlYWR5RXhpc3RlZDogdHJ1ZSB9KTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHN5bWJvbCA9IFN0cmluZyhwbGFjZW1lbnQudG9rZW5fc3ltYm9sID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgIGlmICghc3ltYm9sKSByZXR1cm4ganNvbihyZXNwb25zZSwgNDIyLCB7IGVycm9yOiBcIlx1OEFDQlx1NTE0OFx1NTcyOFx1N0RFOFx1OEYyRlx1NTY2OFx1NTg2Qlx1NUJFQlx1NEUyNlx1NTEzMlx1NUI1OFx1MzAwQ1x1NEVFM1x1NUU2M1x1N0IyNlx1ODY1Rlx1RkYwOFRva2VuIFN5bWJvbFx1RkYwOVx1MzAwRFwiIH0pO1xuICAgICAgY29uc3QgbmFtZSA9IFN0cmluZyhwbGFjZW1lbnQudG9rZW5fbmFtZSA/PyBwbGFjZW1lbnQubmFtZSA/PyBcIlwiKS50cmltKCk7XG4gICAgICBpZiAoIW5hbWUpIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MjIsIHsgZXJyb3I6IFwiXHU4QUNCXHU1MTQ4XHU1NzI4XHU3REU4XHU4RjJGXHU1NjY4XHU1ODZCXHU1QkVCXHU0RTI2XHU1MTMyXHU1QjU4XHUzMDBDXHU0RUUzXHU1RTYzXHU1NDBEXHU3QTMxXHVGRjA4VG9rZW4gTmFtZVx1RkYwOVx1MzAwRFwiIH0pO1xuICAgICAgY29uc3QgZGVjaW1hbHMgPSBwbGFjZW1lbnQudG9rZW5fZGVjaW1hbHMgPT0gbnVsbCA/IDE4IDogTnVtYmVyKHBsYWNlbWVudC50b2tlbl9kZWNpbWFscyk7XG4gICAgICBjb25zdCB0b3RhbFN1cHBseSA9IE51bWJlcihwbGFjZW1lbnQudG90YWxfc3VwcGx5KTtcbiAgICAgIGlmICghKHRvdGFsU3VwcGx5ID4gMCkpIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MjIsIHsgZXJyb3I6IFwiXHU2QjY0XHU2QTE5XHU3Njg0XHU3Njg0XHU3RTNEXHU0RjlCXHU3RDY2XHU5MUNGXHU3MTIxXHU2NTQ4XCIgfSk7XG4gICAgICBpZiAoIShhd2FpdCBndWFyZFJlbGF5ZXJHYXMocmVzcG9uc2UpKSkgcmV0dXJuO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY3JlYXRlUndhRmFjdG9yeVRva2VuKHBsYWNlbWVudElkLCBuYW1lLCBzeW1ib2wsIGRlY2ltYWxzLCB0b3RhbFN1cHBseSk7XG4gICAgICAgIGF3YWl0IGFkbWluLmZyb20oXCJwcml2YXRlX3BsYWNlbWVudHNcIikudXBkYXRlKHsgdG9rZW5fYWRkcmVzczogcmVzdWx0LnRva2VuQWRkcmVzcyB9KS5lcShcImlkXCIsIHBsYWNlbWVudElkKTtcbiAgICAgICAgYXdhaXQgYWRtaW4uZnJvbShcIm9uY2hhaW5fc2V0dGxlbWVudHNcIikuaW5zZXJ0KHtcbiAgICAgICAgICBhY3Rpb246IFwiY3JlYXRlX3J3YV90b2tlblwiLFxuICAgICAgICAgIHJlZl9rZXk6IGBjcmVhdGVfcndhX3Rva2VuOiR7cGxhY2VtZW50SWR9YCxcbiAgICAgICAgICB1c2VyX2lkOiBjYWxsZXIuaWQsXG4gICAgICAgICAgYXNzZXRfaWQ6IHBsYWNlbWVudElkLFxuICAgICAgICAgIHN0YXR1czogXCJjb25maXJtZWRcIixcbiAgICAgICAgICB0eF9oYXNoOiByZXN1bHQudHhIYXNoLnN0YXJ0c1dpdGgoXCIweFwiKSA/IHJlc3VsdC50eEhhc2ggOiBudWxsLFxuICAgICAgICAgIHBheWxvYWQ6IHsgdG9rZW5BZGRyZXNzOiByZXN1bHQudG9rZW5BZGRyZXNzLCBhbHJlYWR5RXhpc3RlZDogcmVzdWx0LmFscmVhZHlFeGlzdGVkIH0sXG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IHRva2VuQWRkcmVzczogcmVzdWx0LnRva2VuQWRkcmVzcywgdHhIYXNoOiByZXN1bHQudHhIYXNoLCBhbHJlYWR5RXhpc3RlZDogcmVzdWx0LmFscmVhZHlFeGlzdGVkIH0pO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNTAyLCB7IGVycm9yOiBgXHU1RUZBXHU3QUNCIFJXQSBcdTRFRTNcdTVFNjNcdTU5MzFcdTY1NTdcdUZGMUEke2Vyck1zZyhlKX1gIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIHJlcXVlc3RLZXkgXHU1M0VBXHU2NjJGIG1pbnQtamMgLyBzdWJzY3JpYmUgLyB0cmFkZSBcdTkwMTlcdTRFMDlcdTUwMEJcdTMwMENcdTdBRDlcdTUxNjdcdTVFMzNcdTY3MkNcdTUxNDhcdTYyNjNcdTZCM0VcdTMwMDFcdTkzQzhcdTRFMEFcbiAgICAvLyBcdTdENTBcdTdCOTdcdTk3NjAgaWRlbXBvdGVuY3lfa2V5IFx1OTMyOFx1NTZERVx1NTM5Rlx1NTlDQlx1NUUzM1x1NjcyQ1x1NTIxN1x1MzAwRFx1NzY4NFx1NjRDRFx1NEY1Q1x1OTcwMFx1ODk4MVx1NzY4NFx1NTNDM1x1NjU3OFx1MzAwMlx1N0JBMVx1NzQwNlx1NTRFMVx1NkUwNVx1NTVBRVx1RkYwRlxuICAgIC8vIFx1ODhEQ1x1NzY3Q1x1RkYwOGFkbWluLWxpc3Qtc2V0dGxlbWVudHNcdTMwMDFhZG1pbi1yZXRyeS1zZXR0bGVtZW50XHVGRjA5XHU0RUU1XHU1M0NBXHU1RjhDXHU5NzYyXHU3Njg0XHU0RTAwXHU2QjIxXHU2MDI3XG4gICAgLy8gd2lyaW5nIFx1NTJENVx1NEY1Q1x1OTBGRFx1NEUwRFx1NUUzNiByZXF1ZXN0S2V5XHVGRjBDXHU5MDRFXHU1M0JCXHU5MDE5XHU5MDUzXHU2QUEyXHU2N0U1XHU1QkVCXHU1NzI4XHU2MjQwXHU2NzA5XHU1MjA2XHU2NTJGXHU1MTcxXHU3NTI4XHU3Njg0XHU1NzMwXHU2NUI5XHVGRjBDXHU1QzBFXHU4MUY0XG4gICAgLy8gXHU5MDE5XHU1MTY5XHU1MDBCXHU3QkExXHU3NDA2XHU1NEUxIGFjdGlvbiBcdTZDMzhcdTkwNjBcdTU3MjhcdTkwODRcdTZDOTJcdTkwMzJcdTUyMzBcdTgxRUFcdTVERjFcdTc2ODRcdTUyMjRcdTY1QjdcdTUyNERcdTVDMzFcdTg4QUJcdTY0Q0JcdTYyMTAgNDAwXHVGRjBDXHU1MjREXHU3QUVGXHU1M0VBXHU4MEZEXHU3NzBCXG4gICAgLy8gXHU1MjMwXHU3QzYwXHU3RDcxXHU3Njg0XHUzMDBDcmVsYXllciBhZG1pbi1saXN0LXNldHRsZW1lbnRzIFx1NTkzMVx1NjU1N1x1MzAwRFx1MzAwMlx1NjUzOVx1NjIxMFx1NTNFQVx1NTcyOFx1NzcxRlx1NzY4NFx1OTcwMFx1ODk4MVxuICAgIC8vIHJlcXVlc3RLZXkgXHU3Njg0XHU0RTA5XHU1MDBCIGFjdGlvbiBcdTYyNERcdTg5ODFcdTZDNDJcdTVCODNcdTMwMDJcbiAgICBjb25zdCBMRURHRVJfQU5DSE9SRURfQUNUSU9OUyA9IG5ldyBTZXQoW1wibWludC1qY1wiLCBcInN1YnNjcmliZVwiXSk7XG4gICAgY29uc3QgcmVxdWVzdEtleSA9IGJvZHkucmVxdWVzdEtleTtcbiAgICBpZiAoTEVER0VSX0FOQ0hPUkVEX0FDVElPTlMuaGFzKGFjdGlvbikgJiYgKCFyZXF1ZXN0S2V5IHx8IHJlcXVlc3RLZXkubGVuZ3RoIDwgOCkpIHtcbiAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDAsIHsgZXJyb3I6IFwiXHU3RjNBXHU1QzExXHU2NzA5XHU2NTQ4XHU3Njg0IHJlcXVlc3RLZXlcIiB9KTtcbiAgICB9XG5cbiAgICAvLyAtLS0tIEdhcyBcdThEMEFcdTUyQTlcdUZGMUFcdTRGN0ZcdTc1MjhcdTgwMDVcdTdDM0QgVVNEVCBcdTRFQTRcdTY2MTNcdUZGMDhcdTkxRDFcdTVFQUJcdTUxNjVcdTkxRDFcdUZGMEZcdTYzRDBcdTk4MThcdUZGMDlcdTUyNERcdUZGMENcdTVGOENcdTdBRUYgQURNSU4gXHU1RTZCXHUzMDBDXHU1NDdDXHU1M0VCXG4gICAgLy8gXHU4MDA1XHU2NzJDXHU0RUJBXHUzMDBEXHU3Njg0XHU5MzIyXHU1MzA1XHU4OERDXHU0RTAwXHU5RURFIEVUSCBcdTRFRDggR2FzXHVGRjBDXHU0RjdGXHU1MTY4XHU2NUIwXHU5MzIyXHU1MzA1XHVGRjA4RVRIPTBcdUZGMDlcdTRFNUZcdTgwRkRcdTgxRUFcdTVERjFcdTdDM0RcdTU0MERcdThGNDlcdTUxRkFcdTgxRUFcdTYyMTFcdTRGRERcbiAgICAvLyBcdTdCQTFcdTc2ODQgVVNEVFx1MzAwMlx1NjUzNlx1NkIzRVx1NTczMFx1NTc0MFx1NEUwMFx1NUY4Qlx1NEYzQVx1NjcwRFx1NTY2OFx1N0FFRlx1NUY5RSBwcm9maWxlcy53YWxsZXRfYWRkcmVzcyBcdTYzQThcdTVDMEVcdUZGMENcdTRFMERcdTRGRTFcdTRFRkJcdTUyNERcdTdBRUZcdTMwMDItLS0tXG4gICAgaWYgKGFjdGlvbiA9PT0gXCJzcG9uc29yLWdhc1wiKSB7XG4gICAgICBsZXQgd2FsbGV0OiBBZGRyZXNzO1xuICAgICAgdHJ5IHtcbiAgICAgICAgd2FsbGV0ID0gdG9BZGRyZXNzKGNhbGxlclByb2ZpbGUud2FsbGV0X2FkZHJlc3MsIFwiXHU0RjdGXHU3NTI4XHU4MDA1XHU1RTMzXHU4NjVGXCIpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDAsIHsgZXJyb3I6IFwiXHU2MjdFXHU0RTBEXHU1MjMwXHU0RjYwXHU3Njg0XHU5MzIyXHU1MzA1XHU1NzMwXHU1NzQwXHVGRjBDXHU4QUNCXHU5MUNEXHU2NUIwXHU3NjdCXHU1MTY1XCIgfSk7XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBzcG9uc29yVXNlckdhcyh3YWxsZXQpO1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCByZXN1bHQpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNTAyLCB7IGVycm9yOiBlcnJNc2coZSkgfSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gLS0tLSBcdTYyOEFcdTMwMENcdTRGN0ZcdTc1MjhcdTgwMDVcdTVGOUUgU2FmZSBcdTkxRDFcdTVFQUJcdTc2RjRcdTYzQTVcdTkzQzhcdTRFMEFcdThGNDlcdTUxNjVcdTMwMDFcdTdFNUVcdTkwNEVcdTdBRDlcdTUxNjdcdTVFMzNcdTY3MkNcdTMwMERcdTc2ODQgUldBIFx1NEVGRFx1OTg0RFx1NTNDRFx1NjYyMFx1NTZERVxuICAgIC8vIGhvbGRpbmdzIFx1NUUzM1x1NjcyQ1x1MzAwMlx1NEU4Q1x1N0QxQVx1NUUwMlx1NTgzNFx1NzY4NFx1NTNFRlx1NEVBNFx1NjYxM1x1OTg0RFx1NUVBNlx1NEVFNSBob2xkaW5ncyBcdTcwQkFcdTZFOTZcdUZGMENcdTRGNDYgU2FmZVx1MjE5Mlx1OTMyMlx1NTMwNVx1NzY4NFx1OTNDOFx1NEUwQVxuICAgIC8vIFx1OEY0OVx1NUUzM1x1NEUwRFx1NjcwM1x1N0Q5M1x1OTA0RVx1N0FEOVx1NTE2N1x1NEVGQlx1NEY1NSBSUENcdUZGMENcdTU2RTBcdTZCNjQgaG9sZGluZ3MgXHU0RTBEXHU2NzAzXHU2NkY0XHU2NUIwXHUzMDAyXHU5MDE5XHU4OEUxXHU3NTMxXHU1RjhDXHU3QUVGXHU4QjgwXHUzMDBDXHU1NDdDXHU1M0VCXHU4MDA1XHU2NzJDXG4gICAgLy8gXHU0RUJBXHUzMDBEXHU5MzIyXHU1MzA1XHU3Njg0XHU5M0M4XHU0RTBBXHU3NzFGXHU1QkU2XHU5OTE4XHU5ODREXHVGRjA4XHU3RDU1XHU0RTBEXHU0RkUxXHU0RUZCXHU1MjREXHU3QUVGXHU2NTc4XHU1QjU3XHVGRjA5XHVGRjBDXHU4MkU1XHU5M0M4XHU0RTBBXHU5OTE4XHU5ODREID4gXHU1RTMzXHU2NzJDXHU2MzAxXHU2NzA5XHVGRjBDXHU1QzMxXHU2MjhBXG4gICAgLy8gXHU1REVFXHU5ODREXHU4OERDXHU5MDMyIGhvbGRpbmdzXHVGRjA4XHU1M0VBXHU1MkEwXHU0RTBEXHU2RTFCXHVGRjFBXHU1RTMzXHU2NzJDXHU5QUQ4XHU2NUJDXHU5M0M4XHU0RTBBXHU2NjQyXHU1OTFBXHU1MzRBXHU2NjJGXHU4QThEXHU4Q0ZDXHU1REYyXHU1MTY1XHU1RTMzXHUzMDAxXHU5M0M4XHU0RTBBXHU3NjdDXHU2NTNFXHU0RUNEXG4gICAgLy8gXHU1NzI4XHU4OERDXHU4REQxXHVGRjBDXHU0RTBEXHU4MEZEXHU1NkUwXHU2QjY0XHU2MjhBXHU1REYyXHU1MTY1XHU1RTMzXHU0RUZEXHU5ODREXHU2MkI5XHU2Mzg5XHVGRjA5XHUzMDAyXHU1MEM1XHU5MDY5XHU3NTI4XHU1REYyXHU5MEU4XHU3RjcyXHU1QzA4XHU1QzZDXHU0RUUzXHU1RTYzXHU3Njg0IFJXQSBcdTZBMTlcdTc2ODRcdUZGMUJcbiAgICAvLyBBRSBcdTRFRTNcdTVFNjNcdTc2ODQgaG9sZGluZ3MgXHU4REU4XHU1OTFBXHU4RjJBIHJvdW5kIFx1NjJDNlx1NTIwNlx1RkYwQ1x1OEE5RVx1NjEwRlx1NEUwRFx1NjYwRVx1NzhCQVx1RkYwQ1x1NEUwMFx1NUY4Qlx1NzU2NVx1OTA0RVx1MzAwMi0tLS1cbiAgICBpZiAoYWN0aW9uID09PSBcInN5bmMtaG9sZGluZ1wiKSB7XG4gICAgICBjb25zdCBwbGFjZW1lbnRJZCA9IChib2R5IGFzIHsgcGxhY2VtZW50SWQ/OiBzdHJpbmcgfSkucGxhY2VtZW50SWQ7XG4gICAgICBpZiAoIXBsYWNlbWVudElkKSByZXR1cm4ganNvbihyZXNwb25zZSwgNDAwLCB7IGVycm9yOiBcIlx1N0YzQVx1NUMxMSBwbGFjZW1lbnRJZFwiIH0pO1xuICAgICAgY29uc3QgeyBkYXRhOiBwbGFjZW1lbnQgfSA9IGF3YWl0IGFkbWluXG4gICAgICAgIC5mcm9tKFwicHJpdmF0ZV9wbGFjZW1lbnRzXCIpXG4gICAgICAgIC5zZWxlY3QoXCJpZCx0b2tlbl9hZGRyZXNzLGlzX2FlX3Rva2VuLGlzX2RlbGlzdGVkXCIpXG4gICAgICAgIC5lcShcImlkXCIsIHBsYWNlbWVudElkKVxuICAgICAgICAubWF5YmVTaW5nbGUoKTtcbiAgICAgIGlmICghcGxhY2VtZW50KSByZXR1cm4ganNvbihyZXNwb25zZSwgNDA0LCB7IGVycm9yOiBcIlx1NjI3RVx1NEUwRFx1NTIzMFx1NUMwRFx1NjFDOVx1NzY4NFx1NkExOVx1NzY4NFwiIH0pO1xuICAgICAgaWYgKHBsYWNlbWVudC5pc19hZV90b2tlbikgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDIwMCwgeyBzeW5jZWQ6IGZhbHNlLCBza2lwcGVkOiBcImFlXCIgfSk7XG4gICAgY29uc3QgdG9rZW5BZGRyZXNzID0gYXdhaXQgZ2V0Q3VycmVudFJ3YUZhY3RvcnlUb2tlbihwbGFjZW1lbnQuaWQpO1xuICAgIGlmICghdG9rZW5BZGRyZXNzKSByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IHN5bmNlZDogZmFsc2UsIHNraXBwZWQ6IFwibm8tY3VycmVudC10b2tlblwiIH0pO1xuICAgICAgbGV0IHdhbGxldDogQWRkcmVzcztcbiAgICAgIHRyeSB7XG4gICAgICAgIHdhbGxldCA9IHRvQWRkcmVzcyhjYWxsZXJQcm9maWxlLndhbGxldF9hZGRyZXNzLCBcIlx1NEY3Rlx1NzUyOFx1ODAwNVx1NUUzM1x1ODY1RlwiKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IHN5bmNlZDogZmFsc2UsIHNraXBwZWQ6IFwibm8td2FsbGV0XCIgfSk7XG4gICAgICB9XG4gICAgICBsZXQgb25DaGFpbiA9IDA7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBiYWwgPSBhd2FpdCBnZXRXYWxsZXRTaGFyZUJhbGFuY2UodG9rZW5BZGRyZXNzLCB3YWxsZXQpO1xuICAgICAgICAvLyBSV0EgXHU0RUZEXHU5ODREXHU0RTBEXHU1M0VGXHU2NzA5XHU1QzBGXHU2NTc4XHU5RURFXHVGRjFBXHU1NDExXHU0RTBCXHU1M0Q2XHU2NTc0XHVGRjBDXHU5MDdGXHU1MTREXHU1NkUwXHU0RUUzXHU1RTYzIGRlY2ltYWxzIFx1OTAyMFx1NjIxMFx1NzY4NFx1NUZBRVx1NUMwRlx1NUMzRVx1NURFRVx1MzAwMlxuICAgICAgICBvbkNoYWluID0gTWF0aC5mbG9vcihiYWwuYmFsYW5jZSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCAyMDAsIHsgc3luY2VkOiBmYWxzZSwgc2tpcHBlZDogXCJyZWFkLWZhaWxlZFwiLCBkZXRhaWw6IGVyck1zZyhlKSB9KTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHsgZGF0YTogaG9sZGluZ1JvdyB9ID0gYXdhaXQgYWRtaW5cbiAgICAgICAgLmZyb20oXCJob2xkaW5nc1wiKVxuICAgICAgICAuc2VsZWN0KFwicXVhbnRpdHlcIilcbiAgICAgICAgLmVxKFwidXNlcl9pZFwiLCBjYWxsZXIuaWQpXG4gICAgICAgIC5lcShcImFzc2V0X2lkXCIsIHBsYWNlbWVudElkKVxuICAgICAgICAubWF5YmVTaW5nbGUoKTtcbiAgICAgIGNvbnN0IGxlZGdlclF0eSA9IE51bWJlcihob2xkaW5nUm93Py5xdWFudGl0eSA/PyAwKTtcbiAgICAgIGlmIChvbkNoYWluID4gbGVkZ2VyUXR5ICsgMWUtOSkge1xuICAgICAgICBjb25zdCB7IGVycm9yOiB1cHNlcnRFcnIgfSA9IGF3YWl0IGFkbWluXG4gICAgICAgICAgLmZyb20oXCJob2xkaW5nc1wiKVxuICAgICAgICAgIC51cHNlcnQoXG4gICAgICAgICAgICB7IHVzZXJfaWQ6IGNhbGxlci5pZCwgYXNzZXRfaWQ6IHBsYWNlbWVudElkLCBxdWFudGl0eTogb25DaGFpbiwgdXBkYXRlZF9hdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH0sXG4gICAgICAgICAgICB7IG9uQ29uZmxpY3Q6IFwidXNlcl9pZCxhc3NldF9pZFwiIH0sXG4gICAgICAgICAgKTtcbiAgICAgICAgaWYgKHVwc2VydEVycikgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDUwMCwgeyBlcnJvcjogXCJcdTU0MENcdTZCNjVcdTYzMDFcdTY3MDlcdTRFRkRcdTk4NERcdTU5MzFcdTY1NTdcdUZGMENcdThBQ0JcdTdBMERcdTVGOENcdTUxOERcdThBNjZcIiB9KTtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDIwMCwgeyBzeW5jZWQ6IHRydWUsIGZyb206IGxlZGdlclF0eSwgdG86IG9uQ2hhaW4sIG9uQ2hhaW4gfSk7XG4gICAgICB9XG4gICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IHN5bmNlZDogZmFsc2UsIGxlZGdlclF0eSwgb25DaGFpbiB9KTtcbiAgICB9XG5cbiAgICAvLyAtLS0tIFx1NzY3Q1x1NjUzRSBKQ1x1RkYwOFx1OTFEMVx1NUVBQlx1OENCNyBKQyBcdTVGOENcdUZGMENvd25lciBcdTVGOUUgU2FmZSBcdTkxRDFcdTVFQUIgdHJhbnNmZXJGcm9tIFx1NTIzMFx1NEY3Rlx1NzUyOFx1ODAwNVx1OTMyMlx1NTMwNVx1RkYwQ1xuICAgIC8vIFx1OTFEMVx1NUVBQlx1OTkxOFx1OTg0RFx1NzcxRlx1NUJFNlx1NkUxQlx1NUMxMVx1RkYxQmFjdGlvbiBcdTU0MERcdTdBMzFcdTZDQkZcdTc1MjggbWludC1qYyBcdTY2MkZcdTcwQkFcdTRFODZcdTRFMERcdTUyRDVcdTUyNERcdTdBRUZcdTU0N0NcdTUzRUJcdTdBRUZcdUZGMDktLS0tXG4gICAgaWYgKGFjdGlvbiA9PT0gXCJtaW50LWpjXCIpIHtcbiAgICAgIGNvbnN0IHsgZGF0YTogbGVkZ2VyUm93IH0gPSBhd2FpdCBhZG1pblxuICAgICAgICAuZnJvbShcImpjX2xlZGdlclwiKVxuICAgICAgICAuc2VsZWN0KFwiaWQsdXNlcl9pZCxhbW91bnQsZW50cnlfdHlwZVwiKVxuICAgICAgICAuZXEoXCJpZGVtcG90ZW5jeV9rZXlcIiwgYCR7cmVxdWVzdEtleX06amNgKVxuICAgICAgICAuZXEoXCJlbnRyeV90eXBlXCIsIFwidmF1bHRfYnV5XCIpXG4gICAgICAgIC5tYXliZVNpbmdsZSgpO1xuICAgICAgaWYgKCFsZWRnZXJSb3cgfHwgbGVkZ2VyUm93LnVzZXJfaWQgIT09IGNhbGxlci5pZCkge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDA0LCB7IGVycm9yOiBcIlx1NjI3RVx1NEUwRFx1NTIzMFx1NUMwRFx1NjFDOVx1NzY4NFx1OENGQ1x1OENCNyBKQyBcdTdEMDBcdTkzMDRcIiB9KTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBzZXR0bGVNaW50SmNDb3JlKGFkbWluLCByZXNwb25zZSwgbGVkZ2VyUm93KTtcbiAgICB9XG5cbiAgICAvLyAtLS0tIFx1NEUwMFx1N0QxQVx1OEE4RFx1OENGQ1x1N0Q1MFx1N0I5N1x1RkYwOGJ1eWVyIFx1NTE0OCBhcHByb3ZlIEpDIFx1MjE5MiBvd25lciBleGVjdXRlU3Vic2NyaXB0aW9uXHVGRjA5LS0tLVxuICAgIGlmIChhY3Rpb24gPT09IFwic3Vic2NyaWJlXCIpIHtcbiAgICAgIGNvbnN0IHsgZGF0YTogbGVkZ2VyUm93IH0gPSBhd2FpdCBhZG1pblxuICAgICAgICAuZnJvbShcImpjX2xlZGdlclwiKVxuICAgICAgICAuc2VsZWN0KFwiaWQsdXNlcl9pZCxhc3NldF9pZCxxdWFudGl0eSxhbW91bnQsbWV0YWRhdGFcIilcbiAgICAgICAgLmVxKFwiaWRlbXBvdGVuY3lfa2V5XCIsIHJlcXVlc3RLZXkpXG4gICAgICAgIC5lcShcImVudHJ5X3R5cGVcIiwgXCJwcml2YXRlX3B1cmNoYXNlXCIpXG4gICAgICAgIC5tYXliZVNpbmdsZSgpO1xuICAgICAgaWYgKCFsZWRnZXJSb3cgfHwgbGVkZ2VyUm93LnVzZXJfaWQgIT09IGNhbGxlci5pZCkge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDA0LCB7IGVycm9yOiBcIlx1NjI3RVx1NEUwRFx1NTIzMFx1NUMwRFx1NjFDOVx1NzY4NFx1OEE4RFx1OENGQ1x1N0QwMFx1OTMwNFwiIH0pO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHNldHRsZVN1YnNjcmliZUNvcmUoYWRtaW4sIHJlc3BvbnNlLCBsZWRnZXJSb3cpO1xuICAgIH1cblxuICAgIC8vIC0tLS0gSkMgXHU4RDE2XHU1NkRFXHVGRjFBXHU0RjdGXHU3NTI4XHU4MDA1XHU3NTMzXHU4QUNCXHU4RDE2XHU1NkRFXHU2MjEwXHU1MjlGXHU1RjhDXHU3QUNCXHU1MjNCXHU4OUY4XHU3NjdDXHVGRjA4cmVxdWVzdF9qY19yZWRlbXB0aW9uIFx1NURGMlx1NUVGQVx1N0FDQlxuICAgIC8vIHBlbmRpbmcgXHU4QTAyXHU1NUFFXHVGRjA5XHVGRjBDXHU2MjhBXHU0RjdGXHU3NTI4XHU4MDA1XHU5M0M4XHU0RTBBIEpDIFx1NjUzNlx1NTZERSBTYWZlIFx1OTFEMVx1NUVBQlx1RkYwQkFETUlOIFx1NzFCMVx1OTMyMlx1NTMwNVx1NzZGNFx1NjNBNVx1NjRBNSBVU0RUXG4gICAgLy8gXHU3RDY2XHU0RjdGXHU3NTI4XHU4MDA1XHUzMDAyXHU4QTAyXHU1NUFFXHU2NzJDXHU0RUJBXHU2MjE2XHU3QkExXHU3NDA2XHU1NEUxXHU3Njg2XHU1M0VGXHU4OUY4XHU3NjdDXHVGRjA4XHU3QkExXHU3NDA2XHU1NEUxXHU3NTI4XHU2NUJDXHU5MUNEXHU4QTY2XHU1MzYxXHU1NUFFXHVGRjA5XHUzMDAyLS0tLVxuICAgIGlmIChhY3Rpb24gPT09IFwicmVkZWVtLWpjXCIpIHtcbiAgICAgIGNvbnN0IG9yZGVySWQgPSAoYm9keSBhcyB7IG9yZGVySWQ/OiBzdHJpbmcgfSkub3JkZXJJZDtcbiAgICAgIGlmICghb3JkZXJJZCkgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMCwgeyBlcnJvcjogXCJcdTdGM0FcdTVDMTEgb3JkZXJJZFwiIH0pO1xuICAgICAgY29uc3QgeyBkYXRhOiBvcmRlciB9ID0gYXdhaXQgYWRtaW5cbiAgICAgICAgLmZyb20oXCJyZWRlbXB0aW9uX29yZGVyc1wiKVxuICAgICAgICAuc2VsZWN0KFwiaWQsdXNlcl9pZCx3YWxsZXRfYWRkcmVzcyxqY19hbW91bnQsdXNkdF9hbW91bnQsc3RhdHVzXCIpXG4gICAgICAgIC5lcShcImlkXCIsIG9yZGVySWQpXG4gICAgICAgIC5tYXliZVNpbmdsZSgpO1xuICAgICAgaWYgKCFvcmRlcikgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwNCwgeyBlcnJvcjogXCJcdTYyN0VcdTRFMERcdTUyMzBcdThEMTZcdTU2REVcdThBMDJcdTU1QUVcIiB9KTtcbiAgICAgIGlmIChvcmRlci51c2VyX2lkICE9PSBjYWxsZXIuaWQgJiYgIWlzQWRtaW5Qcm9maWxlKGNhbGxlclByb2ZpbGUpKSB7XG4gICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDMsIHsgZXJyb3I6IFwiXHU1M0VBXHU2NzA5XHU2NzJDXHU0RUJBXHU2MjE2XHU3QkExXHU3NDA2XHU1NEUxXHU1M0VGXHU4OUY4XHU3NjdDXHU2QjY0XHU4RDE2XHU1NkRFXHU3RDUwXHU3Qjk3XCIgfSk7XG4gICAgICB9XG4gICAgICBpZiAob3JkZXIuc3RhdHVzICE9PSBcInBlbmRpbmdcIikge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IHN0YXR1czogb3JkZXIuc3RhdHVzLCBpZGVtcG90ZW50OiB0cnVlIH0pO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHNldHRsZVJlZGVtcHRpb25Db3JlKGFkbWluLCByZXNwb25zZSwgb3JkZXIpO1xuICAgIH1cblxuICAgIC8vIC0tLS0gXHU3QkExXHU3NDA2XHU1NEUxXHVGRjFBXHU1MjE3XHU1MUZBXHU5NzAwXHU4OTgxXHU0RUJBXHU1REU1XHU5NURDXHU2Q0U4XHU3Njg0XHU5M0M4XHU0RTBBXHU3RDUwXHU3Qjk3XHVGRjA4XHU1OTMxXHU2NTU3IC8gXHU1MzYxXHU1NzI4IHBlbmRpbmcgXHU1OTJBXHU0RTQ1IC8gXHU3QUQ5XHU1MTY3XG4gICAgLy8gXHU1REYyXHU2MjYzXHU2QjNFXHU0RjQ2XHU1RjlFXHU2NzJBXHU5MDAxXHU1MUZBXHU0RUZCXHU0RjU1XHU3RDUwXHU3Qjk3XHU4QUNCXHU2QzQyXHU3Njg0XHUzMDBDXHU1QjY0XHU1MTUyXHUzMDBEXHU4QTE4XHU5MzA0XHVGRjA5XHUzMDAyXHU0RTA5XHU3QTJFXHU0Rjg2XHU2RTkwXHU5MEZEXHU1M0VGXHU4MEZEXHU3NjdDXHU3NTFGXHVGRjFBXHU0RjdGXHU3NTI4XG4gICAgLy8gXHU4MDA1XHU0RUQ4XHU2QjNFXHU1RjhDXHU3MDBGXHU4OUJEXHU1NjY4XHU5NURDXHU2Mzg5XHUzMDAxZmV0Y2ggXHU4OEFCXHU0RTJEXHU2NUI3XHUzMDAxcmVsYXllciBcdTc1NzZcdTRFMEIgZ2FzIFx1NEUwRFx1OERCM1x1NjIxNlx1NkExOVx1NzY4NFx1ODhBQlx1NEUwQlx1NjdCNlx1NjRDQlx1NEUwQlx1MzAwMlxuICAgIC8vIFx1OTAxOVx1NEVGRFx1NkUwNVx1NTVBRVx1NTQwQ1x1NjY0Mlx1NEU1Rlx1NjYyRiBjcm9uIHN3ZWVwXHVGRjA4XHU4OThCIGZpbmRBdHRlbnRpb25DYW5kaWRhdGVzXHVGRjA5XHU4MUVBXHU1MkQ1XHU4OERDXHU3NjdDXHU3Njg0XHU4Q0M3XHU2NTk5XHU0Rjg2XHU2RTkwXG4gICAgLy8gXHU5MDE5XHU4OEUxXHU1M0VBXHU2NjJGXHU5ODREXHU1OTE2XHU2MjhBXHU0RjdGXHU3NTI4XHU4MDA1XHVGRjBGXHU2QTE5XHU3Njg0XHU1NDBEXHU3QTMxXHU2N0U1XHU1MUZBXHU0Rjg2XHU0RjlCXHU1RjhDXHU1M0YwXHU5ODZGXHU3OTNBXHU3NTI4XHUzMDAyLS0tLVxuICAgIC8vIC0tLS0gXHU3QkExXHU3NDA2XHU1NEUxXHVGRjFBXHU0RTAwXHU5Mzc1XHU2MjhBXHU1Rjg1XHU2RDNFXHU3NjdDXHU1MjA2XHU2RjY0XHU1QkU2XHU5NjlCXHU0RTBBXHU5M0M4XHU3NjdDXHU2NTNFXHVGRjA4QURNSU4gXHU3MUIxXHU5MzIyXHU1MzA1XHUyMTkyXHU1M0Q3XHU3NkNBXHU0RUJBXHVGRjA5XHVGRjBDXHU1M0VGXHU1MEIzXG4gICAgLy8gYmVuZWZpY2lhcnlJZHMgXHU1M0VBXHU2RDNFXHU3NjdDXHU2MzA3XHU1QjlBXHU0RUJBXHU1NEUxXHVGRjBDXHU2NzJBXHU1MEIzXHU1MjQ3XHU1MTY4XHU1RTczXHU1M0YwXHU2RDNFXHU3NjdDXHUzMDAyLS0tLVxuICAgIGlmIChhY3Rpb24gPT09IFwic2V0dGxlLWNvbW1pc3Npb25zXCIpIHtcbiAgICAgIGlmICghaXNBZG1pblByb2ZpbGUoY2FsbGVyUHJvZmlsZSkpIHtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMywgeyBlcnJvcjogXCJcdTUwQzVcdTk2NTBcdTdCQTFcdTc0MDZcdTU0RTFcdTU3RjdcdTg4NENcIiB9KTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGlkcyA9IChib2R5IGFzIHsgYmVuZWZpY2lhcnlJZHM/OiBzdHJpbmdbXSB9KS5iZW5lZmljaWFyeUlkcztcbiAgICAgIGNvbnN0IGZpbHRlciA9IEFycmF5LmlzQXJyYXkoaWRzKSAmJiBpZHMubGVuZ3RoID4gMCA/IGlkcyA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IHN1bW1hcnkgPSBhd2FpdCBzd2VlcFBlbmRpbmdDb21taXNzaW9ucyhhZG1pbiwgMzAwLCBmaWx0ZXIpO1xuICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDIwMCwgc3VtbWFyeSk7XG4gICAgfVxuXG4gICAgLy8gLS0tLSBcdTdCQTFcdTc0MDZcdTU0RTFcdUZGMUFcdTRFMDBcdTkzNzVcdTZDOTZcdTZCNjNcdTYzMDdcdTVCOUFcdTUzRDdcdTc2Q0FcdTRFQkFcdTc2ODRcdTczNEVcdTkxRDFcdTZEM0VcdTc2N0NcdTkzMkZcdThBQTRcdUZGMDhcdTU5MUFcdTc2N0NcdUZGMEZcdTVDMTFcdTc2N0NcdTY4MjFcdTZCNjNcdUZGMDktLS0tXG4gICAgaWYgKGFjdGlvbiA9PT0gXCJjb21taXNzaW9uLXJldmVyc2VcIikge1xuICAgICAgaWYgKCFpc0FkbWluUHJvZmlsZShjYWxsZXJQcm9maWxlKSkge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDAzLCB7IGVycm9yOiBcIlx1NTBDNVx1OTY1MFx1N0JBMVx1NzQwNlx1NTRFMVx1NTdGN1x1ODg0Q1wiIH0pO1xuICAgICAgfVxuICAgICAgY29uc3QgaWRzID0gKGJvZHkgYXMgeyBiZW5lZmljaWFyeUlkcz86IHN0cmluZ1tdIH0pLmJlbmVmaWNpYXJ5SWRzO1xuICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGlkcykgfHwgaWRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNDAwLCB7IGVycm9yOiBcIlx1N0YzQVx1NUMxMVx1ODk4MVx1NkM5Nlx1NkI2M1x1NzY4NFx1NTNEN1x1NzZDQVx1NEVCQVwiIH0pO1xuICAgICAgfVxuICAgICAgY29uc3QgcmVzdWx0czogUmV2ZXJzYWxSZXN1bHRbXSA9IFtdO1xuICAgICAgZm9yIChjb25zdCBpZCBvZiBpZHMpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXN1bHRzLnB1c2goYXdhaXQgcmV2ZXJzZUNvbW1pc3Npb25Gb3JCZW5lZmljaWFyeShhZG1pbiwgaWQpKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHJlc3VsdHMucHVzaCh7IGJlbmVmaWNpYXJ5SWQ6IGlkLCBhcHBsaWVkOiBmYWxzZSwgZGlyZWN0aW9uOiBcIm5vbmVcIiwgYW1vdW50OiAwLCBlcnJvcjogZXJyTXNnKGUpIH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IHJlc3VsdHMgfSk7XG4gICAgfVxuXG4gICAgaWYgKGFjdGlvbiA9PT0gXCJhZG1pbi1saXN0LXNldHRsZW1lbnRzXCIpIHtcbiAgICAgIGlmICghaXNBZG1pblByb2ZpbGUoY2FsbGVyUHJvZmlsZSkpIHtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMywgeyBlcnJvcjogXCJcdTUwQzVcdTk2NTBcdTdCQTFcdTc0MDZcdTU0RTFcdTU3RjdcdTg4NENcIiB9KTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGl0ZW1zID0gYXdhaXQgZmluZEF0dGVudGlvbkNhbmRpZGF0ZXMoYWRtaW4pO1xuICAgICAgY29uc3QgdXNlcklkcyA9IFsuLi5uZXcgU2V0KGl0ZW1zLm1hcCgoaSkgPT4gaS51c2VySWQpKV07XG4gICAgICBjb25zdCBhc3NldElkcyA9IFsuLi5uZXcgU2V0KGl0ZW1zLm1hcCgoaSkgPT4gaS5hc3NldElkKS5maWx0ZXIoQm9vbGVhbikpXSBhcyBzdHJpbmdbXTtcbiAgICAgIGNvbnN0IFtwcm9maWxlc1Jlc3VsdCwgcGxhY2VtZW50c1Jlc3VsdF0gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICAgIHVzZXJJZHMubGVuZ3RoXG4gICAgICAgICAgPyBhZG1pbi5mcm9tKFwicHJvZmlsZXNcIikuc2VsZWN0KFwiaWQsZW1haWwsbmlja25hbWUsZGlzcGxheV9uYW1lXCIpLmluKFwiaWRcIiwgdXNlcklkcylcbiAgICAgICAgICA6IFByb21pc2UucmVzb2x2ZSh7IGRhdGE6IFtdIGFzIHsgaWQ6IHN0cmluZzsgZW1haWw6IHN0cmluZyB8IG51bGw7IG5pY2tuYW1lOiBzdHJpbmcgfCBudWxsOyBkaXNwbGF5X25hbWU6IHN0cmluZyB8IG51bGwgfVtdIH0pLFxuICAgICAgICBhc3NldElkcy5sZW5ndGhcbiAgICAgICAgICA/IGFkbWluLmZyb20oXCJwcml2YXRlX3BsYWNlbWVudHNcIikuc2VsZWN0KFwiaWQsbmFtZVwiKS5pbihcImlkXCIsIGFzc2V0SWRzKVxuICAgICAgICAgIDogUHJvbWlzZS5yZXNvbHZlKHsgZGF0YTogW10gYXMgeyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmcgfCBudWxsIH1bXSB9KSxcbiAgICAgIF0pO1xuICAgICAgY29uc3QgcHJvZmlsZUJ5SWQgPSBuZXcgTWFwKChwcm9maWxlc1Jlc3VsdC5kYXRhID8/IFtdKS5tYXAoKHApID0+IFtwLmlkLCBwXSkpO1xuICAgICAgY29uc3QgcGxhY2VtZW50QnlJZCA9IG5ldyBNYXAoKHBsYWNlbWVudHNSZXN1bHQuZGF0YSA/PyBbXSkubWFwKChhKSA9PiBbYS5pZCwgYV0pKTtcblxuICAgICAgY29uc3QgZW5yaWNoZWQgPSBpdGVtc1xuICAgICAgICAubWFwKChpdGVtKSA9PiB7XG4gICAgICAgICAgY29uc3QgcHJvZmlsZSA9IHByb2ZpbGVCeUlkLmdldChpdGVtLnVzZXJJZCk7XG4gICAgICAgICAgY29uc3QgcGxhY2VtZW50ID0gaXRlbS5hc3NldElkID8gcGxhY2VtZW50QnlJZC5nZXQoaXRlbS5hc3NldElkKSA6IG51bGw7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIC4uLml0ZW0sXG4gICAgICAgICAgICB1c2VyTGFiZWw6IHByb2ZpbGU/Lm5pY2tuYW1lIHx8IHByb2ZpbGU/LmRpc3BsYXlfbmFtZSB8fCBwcm9maWxlPy5lbWFpbCB8fCBpdGVtLnVzZXJJZCxcbiAgICAgICAgICAgIGFzc2V0TmFtZTogcGxhY2VtZW50Py5uYW1lID8/IChpdGVtLmFzc2V0SWQgPyBpdGVtLmFzc2V0SWQgOiBudWxsKSxcbiAgICAgICAgICB9O1xuICAgICAgICB9KVxuICAgICAgICAuc29ydCgoYSwgYikgPT4gbmV3IERhdGUoYi5jcmVhdGVkQXQpLmdldFRpbWUoKSAtIG5ldyBEYXRlKGEuY3JlYXRlZEF0KS5nZXRUaW1lKCkpO1xuXG4gICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IGl0ZW1zOiBlbnJpY2hlZCB9KTtcbiAgICB9XG5cbiAgICAvLyAtLS0tIFx1N0JBMVx1NzQwNlx1NTRFMVx1RkYxQVx1NEUwMFx1OTM3NVx1ODhEQ1x1NzY3Q1x1RkYwRlx1OTFDRFx1OEE2Nlx1NTVBRVx1N0I0Nlx1NTM2MVx1NTVBRVx1NzY4NFx1OTNDOFx1NEUwQVx1N0Q1MFx1N0I5NyAtLS0tXG4gICAgaWYgKGFjdGlvbiA9PT0gXCJhZG1pbi1yZXRyeS1zZXR0bGVtZW50XCIpIHtcbiAgICAgIGlmICghaXNBZG1pblByb2ZpbGUoY2FsbGVyUHJvZmlsZSkpIHtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMywgeyBlcnJvcjogXCJcdTUwQzVcdTk2NTBcdTdCQTFcdTc0MDZcdTU0RTFcdTU3RjdcdTg4NENcIiB9KTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBheWxvYWQgPSBib2R5IGFzIHsgc2V0dGxlbWVudElkPzogc3RyaW5nOyBsZWRnZXJBY3Rpb24/OiBzdHJpbmc7IGxlZGdlclJvd0lkPzogc3RyaW5nIH07XG4gICAgICBsZXQgc2V0dGxlQWN0aW9uOiBBdHRlbnRpb25BY3Rpb247XG4gICAgICBsZXQgbGVkZ2VyUm93SWQ6IHN0cmluZztcblxuICAgICAgaWYgKHBheWxvYWQuc2V0dGxlbWVudElkKSB7XG4gICAgICAgIGNvbnN0IHsgZGF0YTogc2V0dGxlbWVudCB9ID0gYXdhaXQgYWRtaW5cbiAgICAgICAgICAuZnJvbShcIm9uY2hhaW5fc2V0dGxlbWVudHNcIilcbiAgICAgICAgICAuc2VsZWN0KFwiaWQsYWN0aW9uLHJlZl9rZXksc3RhdHVzLHR4X2hhc2gsdXBkYXRlZF9hdCxjcmVhdGVkX2F0XCIpXG4gICAgICAgICAgLmVxKFwiaWRcIiwgcGF5bG9hZC5zZXR0bGVtZW50SWQpXG4gICAgICAgICAgLm1heWJlU2luZ2xlKCk7XG4gICAgICAgIGlmICghc2V0dGxlbWVudCkgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwNCwgeyBlcnJvcjogXCJcdTYyN0VcdTRFMERcdTUyMzBcdTdENTBcdTdCOTdcdTdEMDBcdTkzMDRcIiB9KTtcbiAgICAgICAgaWYgKHNldHRsZW1lbnQuYWN0aW9uID09PSBcInRyYWRlXCIgfHwgc2V0dGxlbWVudC5hY3Rpb24gPT09IFwibGlzdF9mZWVcIikge1xuICAgICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MTAsIHsgZXJyb3I6IFwiXHU4MjBBXHU0RThDXHU3RDFBXHU1RTAyXHU1ODM0XHU3RDUwXHU3Qjk3XHU3RDAwXHU5MzA0XHU1MEM1XHU0RkREXHU3NTU5XHU2Qjc3XHU1M0YyXHVGRjBDXHU0RTBEXHU1MThEXHU2M0QwXHU0RjlCIHJlbGF5ZXIgXHU4OERDXHU3NjdDXHUzMDAyXCIgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHNldHRsZW1lbnQuc3RhdHVzID09PSBcImNvbmZpcm1lZFwiKSB7XG4gICAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDIwMCwgeyBzdGF0dXM6IFwiY29uZmlybWVkXCIsIHR4X2hhc2g6IHNldHRsZW1lbnQudHhfaGFzaCwgaWRlbXBvdGVudDogdHJ1ZSB9KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc2V0dGxlbWVudC5zdGF0dXMgPT09IFwiY2FuY2VsbGVkXCIpIHtcbiAgICAgICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IHN0YXR1czogXCJjYW5jZWxsZWRcIiwgaWRlbXBvdGVudDogdHJ1ZSB9KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc2V0dGxlbWVudC5zdGF0dXMgPT09IFwicGVuZGluZ1wiKSB7XG4gICAgICAgICAgY29uc3QgYWdlTXMgPSBEYXRlLm5vdygpIC0gbmV3IERhdGUoc2V0dGxlbWVudC51cGRhdGVkX2F0ID8/IHNldHRsZW1lbnQuY3JlYXRlZF9hdCkuZ2V0VGltZSgpO1xuICAgICAgICAgIGlmIChhZ2VNcyA8IDIgKiA2MCAqIDEwMDApIHtcbiAgICAgICAgICAgIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDksIHsgZXJyb3I6IFwiXHU2QjY0XHU3QjQ2XHU3RDUwXHU3Qjk3XHU0RUNEXHU1NzI4XHU4NjU1XHU3NDA2XHU0RTJEXHVGRjBDXHU4QUNCXHU3QTBEXHU1MDE5XHU1MThEXHU4QTY2XCIgfSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIFx1NTM2MVx1NTcyOCBwZW5kaW5nIFx1NTkyQVx1NEU0NVx1RkYwOFx1NEY4Qlx1NTk4Mlx1NkQ0MVx1N0EwQlx1NEUyRFx1OTAxNFx1OTAzMlx1N0EwQlx1NEUyRFx1NjVCN1x1RkYwOVx1RkYwQ1x1N0JBMVx1NzQwNlx1NTRFMVx1NTNFRlx1NUYzN1x1NTIzNlx1NTIyNFx1NUI5QVx1NTkzMVx1NjU1N1x1NUY4Q1x1OTFDRFx1OEE2Nlx1MzAwMlxuICAgICAgICAgIGF3YWl0IGFkbWluXG4gICAgICAgICAgICAuZnJvbShcIm9uY2hhaW5fc2V0dGxlbWVudHNcIilcbiAgICAgICAgICAgIC51cGRhdGUoeyBzdGF0dXM6IFwiZmFpbGVkXCIsIGVycm9yOiBcIlx1N0JBMVx1NzQwNlx1NTRFMVx1NTIyNFx1NUI5QVx1OTAzRVx1NjY0Mlx1NTM2MVx1NTVBRVx1RkYwQ1x1NURGMlx1OEY0OVx1NzBCQVx1NTkzMVx1NjU1N1x1NEVFNVx1NEZCRlx1OTFDRFx1OEE2NlwiLCB1cGRhdGVkX2F0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkgfSlcbiAgICAgICAgICAgIC5lcShcImlkXCIsIHNldHRsZW1lbnQuaWQpO1xuICAgICAgICB9XG4gICAgICAgIHNldHRsZUFjdGlvbiA9IHNldHRsZW1lbnQuYWN0aW9uIGFzIEF0dGVudGlvbkFjdGlvbjtcbiAgICAgICAgbGVkZ2VyUm93SWQgPSBzZXR0bGVtZW50LnJlZl9rZXkuc2xpY2Uoc2V0dGxlQWN0aW9uLmxlbmd0aCArIDEpO1xuICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgcGF5bG9hZC5sZWRnZXJSb3dJZCAmJlxuICAgICAgICAoXG4gICAgICAgICAgcGF5bG9hZC5sZWRnZXJBY3Rpb24gPT09IFwibWludF9qY1wiIHx8XG4gICAgICAgICAgcGF5bG9hZC5sZWRnZXJBY3Rpb24gPT09IFwic3Vic2NyaWJlXCIgfHxcbiAgICAgICAgICBwYXlsb2FkLmxlZGdlckFjdGlvbiA9PT0gXCJyZWRlZW1cIilcbiAgICAgICkge1xuICAgICAgICBzZXR0bGVBY3Rpb24gPSBwYXlsb2FkLmxlZGdlckFjdGlvbjtcbiAgICAgICAgbGVkZ2VyUm93SWQgPSBwYXlsb2FkLmxlZGdlclJvd0lkO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMCwgeyBlcnJvcjogXCJcdTdGM0FcdTVDMTEgc2V0dGxlbWVudElkIFx1NjIxNiBsZWRnZXJBY3Rpb24rbGVkZ2VyUm93SWRcIiB9KTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHJldHJ5U2V0dGxlbWVudEJ5QWN0aW9uKGFkbWluLCByZXNwb25zZSwgc2V0dGxlQWN0aW9uLCBsZWRnZXJSb3dJZCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQwMCwgeyBlcnJvcjogYFx1NjcyQVx1NzdFNVx1NzY4NCBhY3Rpb246ICR7YWN0aW9ufWAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICByZXR1cm4ganNvbihyZXNwb25zZSwgNTAwLCB7IGVycm9yOiBlcnJNc2coZSkgfSk7XG4gIH1cbn1cblxudHlwZSBBdHRlbnRpb25BY3Rpb24gPSBcIm1pbnRfamNcIiB8IFwic3Vic2NyaWJlXCIgfCBcInJlZGVlbVwiO1xudHlwZSBBdHRlbnRpb25JdGVtID0ge1xuICBpZDogc3RyaW5nIHwgbnVsbDtcbiAgYWN0aW9uOiBBdHRlbnRpb25BY3Rpb247XG4gIGxlZGdlclJvd0lkOiBzdHJpbmc7XG4gIHVzZXJJZDogc3RyaW5nO1xuICBhc3NldElkOiBzdHJpbmcgfCBudWxsO1xuICBhbW91bnQ6IG51bWJlciB8IG51bGw7XG4gIHBheW1lbnQ/OiBudW1iZXIgfCBudWxsO1xuICBzdGF0dXM6IFwib3JwaGFuXCIgfCBcImZhaWxlZFwiIHwgXCJzdGFsZV9wZW5kaW5nXCI7XG4gIGVycm9yOiBzdHJpbmcgfCBudWxsO1xuICB0eEhhc2g/OiBzdHJpbmcgfCBudWxsO1xuICBjcmVhdGVkQXQ6IHN0cmluZztcbiAgdXBkYXRlZEF0Pzogc3RyaW5nO1xufTtcblxuLyoqXG4gKiBcdTYyN0VcdTUxRkFcdTYyNDBcdTY3MDlcdTMwMENcdTk3MDBcdTg5ODFcdTRFQkFcdTVERTVcdTk1RENcdTZDRThcdUZGMEZcdTk3MDBcdTg5ODFcdTgxRUFcdTUyRDVcdTg4RENcdTc2N0NcdTMwMERcdTc2ODRcdTkzQzhcdTRFMEFcdTdENTBcdTdCOTdcdUZGRkRcdUZGRkRcbiAqICAxLiBvcnBoYW5cdUZGMUFcdTdBRDlcdTUxNjdcdTVERjJcdTYyNjNcdTZCM0VcdUZGMDhqY19sZWRnZXIgXHU2NzA5XHU1QzBEXHU2MUM5XHU3RDAwXHU5MzA0XHVGRjA5XHVGRjBDXHU0RjQ2XHU1RjlFXHU2NzJBXHU3NTIyXHU3NTFGXHU0RUZCXHU0RjU1IG9uY2hhaW5fc2V0dGxlbWVudHNcbiAqICAgICBcdTdEMDBcdTkzMDRcdTIwMTRcdTIwMTRcdTkwMUFcdTVFMzhcdTY2MkZcdTRGN0ZcdTc1MjhcdTgwMDVcdTRFRDhcdTZCM0VcdTYyMTBcdTUyOUZcdTkwQTNcdTRFMDBcdTUyM0JcdTcwMEZcdTg5QkRcdTU2NjhcdTVDMzFcdTk1RENcdTYzODlcdTMwMDFcdTYyMTZcdTU0N0NcdTUzRUIgL2FwaS9yZWxheWVyIFx1NzY4NFxuICogICAgIGZldGNoIFx1ODhBQlx1NEUyRFx1NjVCN1x1RkYwQ1x1NUMwRVx1ODFGNFx1MzAwQ1x1NURGMlx1NjI2M1x1NkIzRVx1NTM3Qlx1NkM5Mlx1ODlGOFx1NzY3Q1x1NEVGQlx1NEY1NVx1OTNDOFx1NEUwQVx1NzY3Q1x1NUU2My9cdTdENTBcdTdCOTdcdThBQ0JcdTZDNDJcdTMwMERcdTMwMDJcbiAqICAyLiBmYWlsZWRcdUZGMUFcdTY2RkVcdTdEOTNcdTU2MTdcdThBNjZcdTkwNEVcdTRGNDZcdTU5MzFcdTY1NTdcdUZGMDhnYXMgXHU0RTBEXHU4REIzXHUzMDAxXHU5M0M4XHU0RTBBIHJldmVydCBcdTdCNDlcdUZGMDlcdTMwMDJcbiAqICAzLiBzdGFsZV9wZW5kaW5nXHVGRjFBXHU1MzYxXHU1NzI4IHBlbmRpbmcgXHU4RDg1XHU5MDRFIDIgXHU1MjA2XHU5NDE4XHVGRjA4XHU0RjhCXHU1OTgyXHU2RDQxXHU3QTBCXHU0RTJEXHU5MDE0IHNlcnZlcmxlc3MgXHU5MDNFXHU2NjQyXHU4OEFCXHU0RTJEXHU2NUI3XHVGRjA5XHUzMDAyXG4gKiBcdTkwMTlcdTRFRkRcdTZFMDVcdTU1QUVcdTU0MENcdTY2NDJcdTRGOUJcdTVGOENcdTUzRjBcdTMwMENcdTkzQzhcdTRFMEFcdTdENTBcdTdCOTdcdTMwMERcdTk4MDFcdTdDNjRcdTk4NkZcdTc5M0FcdUZGMENcdTRFRTVcdTUzQ0EgY3JvbiBzd2VlcCBcdTgxRUFcdTUyRDVcdTg4RENcdTc2N0NcdTRGN0ZcdTc1MjhcdTMwMDJcbiAqL1xuYXN5bmMgZnVuY3Rpb24gZmluZEF0dGVudGlvbkNhbmRpZGF0ZXMoYWRtaW46IFN1cGFiYXNlQ2xpZW50KTogUHJvbWlzZTxBdHRlbnRpb25JdGVtW10+IHtcbiAgY29uc3QgU1RBTEVfTVMgPSAyICogNjAgKiAxMDAwO1xuICBjb25zdCBzdGFsZUJlZm9yZSA9IG5ldyBEYXRlKERhdGUubm93KCkgLSBTVEFMRV9NUykudG9JU09TdHJpbmcoKTtcblxuICAvLyBcdThEMTZcdTU2REVcdThBMDJcdTU1QUVcdTVFN0VcdTRFNEVcdTRFMDBcdTVCOUFcdTY2MkZcdTMwMENcdTRGN0ZcdTc1MjhcdTgwMDVcdTkwMDFcdTUxRkEgcmVxdWVzdF9qY19yZWRlbXB0aW9uIFx1NUY4Q1x1RkYwQ1x1NTI0RFx1N0FFRlx1N0FDQlx1NTIzQlx1NTQ3Q1x1NTNFQlxuICAvLyByZWRlZW0tamNcdTMwMERcdTUxNjlcdTZCQjVcdTVGMEZcdTZENDFcdTdBMEJcdUZGMENcdTRFMkRcdTk1OTNcdTY3MDlcdTZCNjNcdTVFMzhcdTc2ODRcdTdEQjJcdThERUZcdTVGODBcdThGRDRcdTY2NDJcdTk1OTNcdUZGMENcdTY1NDVcdTUzRUFcdTYyOEFcdTVFRkFcdTdBQ0JcdThEODVcdTkwNEUgMzAgXHU3OUQyXHUzMDAxXG4gIC8vIFx1NEVDRFx1NjYyRiBwZW5kaW5nIFx1NzY4NFx1OEEwMlx1NTVBRVx1NzU3Nlx1NjIxMFx1MzAwQ1x1NTNFRlx1ODBGRFx1NTM2MVx1NEY0Rlx1MzAwRFx1RkYwQ1x1OTA3Rlx1NTE0RFx1OEFBNFx1NTIyNFx1NkI2M1x1NTcyOFx1OTAzMlx1ODg0Q1x1NEUyRFx1NzY4NFx1NkI2M1x1NUUzOFx1NkQ0MVx1N0EwQlx1MzAwMlxuICBjb25zdCByZWRlZW1PcnBoYW5CZWZvcmUgPSBuZXcgRGF0ZShEYXRlLm5vdygpIC0gMzAgKiAxMDAwKS50b0lTT1N0cmluZygpO1xuXG4gIGNvbnN0IFt2YXVsdFJvd3MsIHN1YlJvd3MsIHJlZGVlbVJvd3MsIGZhaWxlZE9yU3RhbGVdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgIGFkbWluXG4gICAgICAuZnJvbShcImpjX2xlZGdlclwiKVxuICAgICAgLnNlbGVjdChcImlkLHVzZXJfaWQsYW1vdW50LGNyZWF0ZWRfYXRcIilcbiAgICAgIC5lcShcImVudHJ5X3R5cGVcIiwgXCJ2YXVsdF9idXlcIilcbiAgICAgIC5ub3QoXCJpZGVtcG90ZW5jeV9rZXlcIiwgXCJpc1wiLCBudWxsKVxuICAgICAgLm9yZGVyKFwiY3JlYXRlZF9hdFwiLCB7IGFzY2VuZGluZzogZmFsc2UgfSlcbiAgICAgIC5saW1pdCgzMDApLFxuICAgIGFkbWluXG4gICAgICAuZnJvbShcImpjX2xlZGdlclwiKVxuICAgICAgLnNlbGVjdChcImlkLHVzZXJfaWQsYXNzZXRfaWQsYW1vdW50LGNyZWF0ZWRfYXRcIilcbiAgICAgIC5lcShcImVudHJ5X3R5cGVcIiwgXCJwcml2YXRlX3B1cmNoYXNlXCIpXG4gICAgICAubm90KFwiaWRlbXBvdGVuY3lfa2V5XCIsIFwiaXNcIiwgbnVsbClcbiAgICAgIC5vcmRlcihcImNyZWF0ZWRfYXRcIiwgeyBhc2NlbmRpbmc6IGZhbHNlIH0pXG4gICAgICAubGltaXQoMzAwKSxcbiAgICAvLyBKQyBcdThEMTZcdTU2REVcdUZGMUFyZWRlbXB0aW9uX29yZGVycyBcdTRFQ0RcdTY2MkYgcGVuZGluZ1x1RkYwOFx1ODg2OFx1NzkzQVx1NEY3Rlx1NzUyOFx1ODAwNVx1NzY4NCByZWRlZW0tamMgXHU1NDdDXHU1M0VCXHU1RjlFXHU2NzJBXG4gICAgLy8gXHU2MjEwXHU1MjlGXHU4OUY4XHU3NjdDXHU3RDUwXHU3Qjk3XHVGRjBDXHU0RjhCXHU1OTgyXHU5MDAxXHU1MUZBXHU1RjhDXHU5NURDXHU5NTg5XHU3MDBGXHU4OUJEXHU1NjY4XHVGRjA5XHVGRjBDXHU0RUE0XHU3RDY2IGNyb24gc3dlZXBcdUZGMEZcdTdCQTFcdTc0MDZcdTU0RTFcdTg4RENcdTc2N0NcdTMwMDJcbiAgICBhZG1pblxuICAgICAgLmZyb20oXCJyZWRlbXB0aW9uX29yZGVyc1wiKVxuICAgICAgLnNlbGVjdChcImlkLHVzZXJfaWQsamNfYW1vdW50LGNyZWF0ZWRfYXRcIilcbiAgICAgIC5lcShcInN0YXR1c1wiLCBcInBlbmRpbmdcIilcbiAgICAgIC5sdChcImNyZWF0ZWRfYXRcIiwgcmVkZWVtT3JwaGFuQmVmb3JlKVxuICAgICAgLm9yZGVyKFwiY3JlYXRlZF9hdFwiLCB7IGFzY2VuZGluZzogZmFsc2UgfSlcbiAgICAgIC5saW1pdCgzMDApLFxuICAgIGFkbWluXG4gICAgICAuZnJvbShcIm9uY2hhaW5fc2V0dGxlbWVudHNcIilcbiAgICAgIC5zZWxlY3QoXCJpZCxhY3Rpb24scmVmX2tleSx1c2VyX2lkLGFzc2V0X2lkLGFtb3VudCxwYXltZW50LHN0YXR1cyxlcnJvcix0eF9oYXNoLGNyZWF0ZWRfYXQsdXBkYXRlZF9hdFwiKVxuICAgICAgLmluKFwiYWN0aW9uXCIsIFtcIm1pbnRfamNcIiwgXCJzdWJzY3JpYmVcIiwgXCJyZWRlZW1cIl0pXG4gICAgICAub3IoYHN0YXR1cy5lcS5mYWlsZWQsYW5kKHN0YXR1cy5lcS5wZW5kaW5nLHVwZGF0ZWRfYXQubHQuJHtzdGFsZUJlZm9yZX0pYClcbiAgICAgIC5vcmRlcihcImNyZWF0ZWRfYXRcIiwgeyBhc2NlbmRpbmc6IGZhbHNlIH0pXG4gICAgICAubGltaXQoMjAwKSxcbiAgXSk7XG5cbiAgY29uc3QgbGVkZ2VyQnlBY3Rpb246IFJlY29yZDxBdHRlbnRpb25BY3Rpb24sIHsgaWQ6IHN0cmluZzsgdXNlcl9pZDogc3RyaW5nOyBhc3NldF9pZD86IHN0cmluZyB8IG51bGw7IGFtb3VudDogbnVtYmVyOyBjcmVhdGVkX2F0OiBzdHJpbmcgfVtdPiA9IHtcbiAgICBtaW50X2pjOiAodmF1bHRSb3dzLmRhdGEgPz8gW10pIGFzIG5ldmVyLFxuICAgIHN1YnNjcmliZTogKHN1YlJvd3MuZGF0YSA/PyBbXSkgYXMgbmV2ZXIsXG4gICAgcmVkZWVtOiAoKHJlZGVlbVJvd3MuZGF0YSA/PyBbXSkgYXMgeyBpZDogc3RyaW5nOyB1c2VyX2lkOiBzdHJpbmc7IGpjX2Ftb3VudDogbnVtYmVyOyBjcmVhdGVkX2F0OiBzdHJpbmcgfVtdKS5tYXAoXG4gICAgICAocikgPT4gKHsgaWQ6IHIuaWQsIHVzZXJfaWQ6IHIudXNlcl9pZCwgYXNzZXRfaWQ6IG51bGwsIGFtb3VudDogTnVtYmVyKHIuamNfYW1vdW50KSwgY3JlYXRlZF9hdDogci5jcmVhdGVkX2F0IH0pLFxuICAgICksXG4gIH07XG4gIGNvbnN0IGNhbmRpZGF0ZVJlZktleXMgPSAoT2JqZWN0LmVudHJpZXMobGVkZ2VyQnlBY3Rpb24pIGFzIFtBdHRlbnRpb25BY3Rpb24sIHR5cGVvZiBsZWRnZXJCeUFjdGlvbltBdHRlbnRpb25BY3Rpb25dXVtdKVxuICAgIC5mbGF0TWFwKChbYWN0LCByb3dzXSkgPT4gcm93cy5tYXAoKHIpID0+IGAke2FjdH06JHtyLmlkfWApKTtcbiAgY29uc3QgeyBkYXRhOiBleGlzdGluZ1NldHRsZW1lbnRzIH0gPSBjYW5kaWRhdGVSZWZLZXlzLmxlbmd0aFxuICAgID8gYXdhaXQgYWRtaW4uZnJvbShcIm9uY2hhaW5fc2V0dGxlbWVudHNcIikuc2VsZWN0KFwicmVmX2tleVwiKS5pbihcInJlZl9rZXlcIiwgY2FuZGlkYXRlUmVmS2V5cylcbiAgICA6IHsgZGF0YTogW10gYXMgeyByZWZfa2V5OiBzdHJpbmcgfVtdIH07XG4gIGNvbnN0IGhhc1NldHRsZW1lbnQgPSBuZXcgU2V0KChleGlzdGluZ1NldHRsZW1lbnRzID8/IFtdKS5tYXAoKHIpID0+IHIucmVmX2tleSkpO1xuXG4gIGNvbnN0IG9ycGhhbnM6IEF0dGVudGlvbkl0ZW1bXSA9IChPYmplY3QuZW50cmllcyhsZWRnZXJCeUFjdGlvbikgYXMgW0F0dGVudGlvbkFjdGlvbiwgdHlwZW9mIGxlZGdlckJ5QWN0aW9uW0F0dGVudGlvbkFjdGlvbl1dW10pXG4gICAgLmZsYXRNYXAoKFthY3QsIHJvd3NdKSA9PlxuICAgICAgcm93c1xuICAgICAgICAuZmlsdGVyKChyKSA9PiAhaGFzU2V0dGxlbWVudC5oYXMoYCR7YWN0fToke3IuaWR9YCkpXG4gICAgICAgIC5tYXAoKHIpID0+ICh7XG4gICAgICAgICAgaWQ6IG51bGwsXG4gICAgICAgICAgYWN0aW9uOiBhY3QsXG4gICAgICAgICAgbGVkZ2VyUm93SWQ6IHIuaWQsXG4gICAgICAgICAgdXNlcklkOiByLnVzZXJfaWQsXG4gICAgICAgICAgYXNzZXRJZDogci5hc3NldF9pZCA/PyBudWxsLFxuICAgICAgICAgIGFtb3VudDogTnVtYmVyKHIuYW1vdW50KSxcbiAgICAgICAgICBzdGF0dXM6IFwib3JwaGFuXCIgYXMgY29uc3QsXG4gICAgICAgICAgZXJyb3I6IFwiXHU0RjdGXHU3NTI4XHU4MDA1XHU1REYyXHU2MjYzXHU2QjNFXHVGRjBDXHU0RjQ2XHU1RjlFXHU2NzJBXHU2NTM2XHU1MjMwXHU0RUZCXHU0RjU1XHU5M0M4XHU0RTBBXHU3RDUwXHU3Qjk3XHU4QUNCXHU2QzQyXHVGRjA4XHU1M0VGXHU4MEZEXHU2NjJGXHU3MDBGXHU4OUJEXHU1NjY4XHU5NURDXHU5NTg5XHU2MjE2XHU3REIyXHU4REVGXHU0RTJEXHU2NUI3XHVGRjA5XCIsXG4gICAgICAgICAgY3JlYXRlZEF0OiByLmNyZWF0ZWRfYXQsXG4gICAgICAgIH0pKSxcbiAgICApO1xuXG4gIGNvbnN0IGF0dGVudGlvbk5lZWRlZDogQXR0ZW50aW9uSXRlbVtdID0gKGZhaWxlZE9yU3RhbGUuZGF0YSA/PyBbXSkubWFwKChyb3cpID0+ICh7XG4gICAgaWQ6IHJvdy5pZCxcbiAgICBhY3Rpb246IHJvdy5hY3Rpb24gYXMgQXR0ZW50aW9uQWN0aW9uLFxuICAgIGxlZGdlclJvd0lkOiByb3cucmVmX2tleS5zbGljZShTdHJpbmcocm93LmFjdGlvbikubGVuZ3RoICsgMSksXG4gICAgdXNlcklkOiByb3cudXNlcl9pZCxcbiAgICBhc3NldElkOiByb3cuYXNzZXRfaWQgPz8gbnVsbCxcbiAgICBhbW91bnQ6IHJvdy5hbW91bnQgPT0gbnVsbCA/IG51bGwgOiBOdW1iZXIocm93LmFtb3VudCksXG4gICAgcGF5bWVudDogcm93LnBheW1lbnQgPT0gbnVsbCA/IG51bGwgOiBOdW1iZXIocm93LnBheW1lbnQpLFxuICAgIHN0YXR1czogcm93LnN0YXR1cyA9PT0gXCJmYWlsZWRcIiA/IChcImZhaWxlZFwiIGFzIGNvbnN0KSA6IChcInN0YWxlX3BlbmRpbmdcIiBhcyBjb25zdCksXG4gICAgZXJyb3I6IHJvdy5lcnJvciA/PyBudWxsLFxuICAgIHR4SGFzaDogcm93LnR4X2hhc2ggPz8gbnVsbCxcbiAgICBjcmVhdGVkQXQ6IHJvdy5jcmVhdGVkX2F0LFxuICAgIHVwZGF0ZWRBdDogcm93LnVwZGF0ZWRfYXQsXG4gIH0pKTtcblxuICBjb25zdCBjb21iaW5lZCA9IFsuLi5hdHRlbnRpb25OZWVkZWQsIC4uLm9ycGhhbnNdO1xuXG4gIC8vIFx1NURGMlx1NEUwQlx1NjdCNlx1NzY4NFx1OEE4RFx1OENGQ1x1NkExOVx1NzY4NFx1NEUwRFx1NTE4RFx1OTg2Rlx1NzkzQVx1ODhEQ1x1NzY3Q1x1RkYxQWBhZG1pbl9kZWFjdGl2YXRlX3BsYWNlbWVudGAgXHU0RTBCXHU2N0I2XHU2NjQyXHU1REYyXHU1MzlGXHU4REVGXHU5MDAwXHU1NkRFXG4gIC8vIFx1NUMwRFx1NjFDOVx1NzY4NCBKQ1x1RkYxQlx1ODJFNVx1NEVDRFx1ODhEQ1x1NzY3Q1x1OTNDOFx1NEUwQVx1NEVGRFx1OTg0RFx1RkYwQ1x1NjcwM1x1OTAyMFx1NjIxMFx1OTFDRFx1ODkwN1x1NzY3Q1x1NjUzRVx1MzAwMlxuICBjb25zdCBhc3NldElkc1RvQ2hlY2sgPSBbXG4gICAgLi4ubmV3IFNldChjb21iaW5lZC5maWx0ZXIoKGkpID0+IGkuYXNzZXRJZCAmJiBpLmFjdGlvbiAhPT0gXCJtaW50X2pjXCIpLm1hcCgoaSkgPT4gaS5hc3NldElkIGFzIHN0cmluZykpLFxuICBdO1xuICBpZiAoYXNzZXRJZHNUb0NoZWNrLmxlbmd0aCkge1xuICAgIGNvbnN0IHsgZGF0YTogcGxhY2VtZW50RmxhZ3MgfSA9IGF3YWl0IGFkbWluXG4gICAgICAuZnJvbShcInByaXZhdGVfcGxhY2VtZW50c1wiKVxuICAgICAgLnNlbGVjdChcImlkLGlzX2RlbGlzdGVkLGlzX2FjdGl2ZVwiKVxuICAgICAgLmluKFwiaWRcIiwgYXNzZXRJZHNUb0NoZWNrKTtcbiAgICBjb25zdCBpbmFjdGl2ZUFzc2V0SWRzID0gbmV3IFNldChcbiAgICAgIChwbGFjZW1lbnRGbGFncyA/PyBbXSkuZmlsdGVyKChwKSA9PiBwLmlzX2RlbGlzdGVkIHx8IHAuaXNfYWN0aXZlID09PSBmYWxzZSkubWFwKChwKSA9PiBwLmlkKSxcbiAgICApO1xuICAgIGlmIChpbmFjdGl2ZUFzc2V0SWRzLnNpemUpIHtcbiAgICAgIHJldHVybiBjb21iaW5lZC5maWx0ZXIoKGkpID0+ICEoaS5hc3NldElkICYmIGluYWN0aXZlQXNzZXRJZHMuaGFzKGkuYXNzZXRJZCkpKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gY29tYmluZWQ7XG59XG5cbi8qKiBcdTVFRkFcdTRFMDBcdTUwMEJcdTUwNDdcdTc2ODQgU2VydmVyUmVzcG9uc2VcdUZGMUFcdThCOTMgc2V0dGxlKkNvcmUgXHU3Q0ZCXHU1MjE3XHU1MUZEXHU1RjBGXHU1M0VGXHU0RUU1XHU1NzI4XHU2QzkyXHU2NzA5XHU3NzFGXHU1QkU2IEhUVFAgXHU4QUNCXHU2QzQyXG4gKiBcdTc2ODRcdTYwQzVcdTU4ODNcdTRFMEJcdTkxQ0RcdTg5MDdcdTRGN0ZcdTc1MjhcdUZGMDhcdTRGOEJcdTU5ODIgY3JvbiBzd2VlcFx1RkYwOVx1RkYwQ1x1NTQ3Q1x1NTNFQlx1N0FFRlx1NEU4Qlx1NUY4Q1x1NUY5RSBgcmVhZCgpYCBcdTUzRDZcdTVGOTdcdTVCRUJcdTUxNjVcdTc2ODRcdTUxNjdcdTVCQjlcdTMwMDIgKi9cbmZ1bmN0aW9uIGZha2VSZXNwb25zZSgpOiB7IHJlc3BvbnNlOiBTZXJ2ZXJSZXNwb25zZTsgcmVhZDogKCkgPT4geyBzdGF0dXM6IG51bWJlcjsgYm9keTogdW5rbm93biB9IH0ge1xuICBsZXQgYm9keTogdW5rbm93biA9IG51bGw7XG4gIGNvbnN0IHN0dWIgPSB7XG4gICAgc3RhdHVzQ29kZTogMCxcbiAgICBzZXRIZWFkZXIoKSB7XG4gICAgICAvKiBuby1vcCAqL1xuICAgIH0sXG4gICAgZW5kKGRhdGE/OiBzdHJpbmcpIHtcbiAgICAgIGJvZHkgPSBkYXRhID8gSlNPTi5wYXJzZShkYXRhKSA6IG51bGw7XG4gICAgfSxcbiAgfTtcbiAgcmV0dXJuIHtcbiAgICByZXNwb25zZTogc3R1YiBhcyB1bmtub3duIGFzIFNlcnZlclJlc3BvbnNlLFxuICAgIHJlYWQ6ICgpID0+ICh7IHN0YXR1czogc3R1Yi5zdGF0dXNDb2RlLCBib2R5IH0pLFxuICB9O1xufVxuXG4vKiogXHU0RjlEIGFjdGlvbiArIGxlZGdlclJvd0lkIFx1NjI3RVx1NTZERVx1NUMwRFx1NjFDOVx1NzY4NFx1NUUzM1x1NjcyQ1x1OTMyOFx1OUVERVx1RkYwQ1x1OTFDRFx1NjVCMFx1ODlGOFx1NzY3Q1x1OTNDOFx1NEUwQVx1N0Q1MFx1N0I5N1x1RkYwOFx1NTQyQlx1OTYzMlx1OTFDRFx1ODkwN1x1NzY4NFxuICogcmVmX2tleSBcdTUxQUFcdTdCNDlcdTZBQTJcdTY3RTVcdUZGMDlcdTMwMDJcdTdCQTFcdTc0MDZcdTU0RTFcdTYyNEJcdTUyRDVcdTg4RENcdTc2N0NcdTgyMDcgY3JvbiBcdTgxRUFcdTUyRDUgc3dlZXAgXHU5MEZEXHU4RDcwXHU5MDE5XHU4OEUxXHVGRjBDXHU4ODRDXHU3MEJBXHU1QjhDXHU1MTY4XHU0RTAwXHU4MUY0XHUzMDAyICovXG5hc3luYyBmdW5jdGlvbiByZXRyeVNldHRsZW1lbnRCeUFjdGlvbihcbiAgYWRtaW46IFN1cGFiYXNlQ2xpZW50LFxuICByZXNwb25zZTogU2VydmVyUmVzcG9uc2UsXG4gIHNldHRsZUFjdGlvbjogQXR0ZW50aW9uQWN0aW9uLFxuICBsZWRnZXJSb3dJZDogc3RyaW5nLFxuKSB7XG4gIGlmIChzZXR0bGVBY3Rpb24gPT09IFwibWludF9qY1wiKSB7XG4gICAgY29uc3QgeyBkYXRhOiBsZWRnZXJSb3cgfSA9IGF3YWl0IGFkbWluXG4gICAgICAuZnJvbShcImpjX2xlZGdlclwiKVxuICAgICAgLnNlbGVjdChcImlkLHVzZXJfaWQsYW1vdW50XCIpXG4gICAgICAuZXEoXCJpZFwiLCBsZWRnZXJSb3dJZClcbiAgICAgIC5lcShcImVudHJ5X3R5cGVcIiwgXCJ2YXVsdF9idXlcIilcbiAgICAgIC5tYXliZVNpbmdsZSgpO1xuICAgIGlmICghbGVkZ2VyUm93KSByZXR1cm4ganNvbihyZXNwb25zZSwgNDA0LCB7IGVycm9yOiBcIlx1NjI3RVx1NEUwRFx1NTIzMFx1NUMwRFx1NjFDOVx1NzY4NFx1OENGQ1x1OENCNyBKQyBcdTdEMDBcdTkzMDRcIiB9KTtcbiAgICByZXR1cm4gc2V0dGxlTWludEpjQ29yZShhZG1pbiwgcmVzcG9uc2UsIGxlZGdlclJvdyk7XG4gIH1cbiAgaWYgKHNldHRsZUFjdGlvbiA9PT0gXCJzdWJzY3JpYmVcIikge1xuICAgIGNvbnN0IHsgZGF0YTogbGVkZ2VyUm93IH0gPSBhd2FpdCBhZG1pblxuICAgICAgLmZyb20oXCJqY19sZWRnZXJcIilcbiAgICAgIC5zZWxlY3QoXCJpZCx1c2VyX2lkLGFzc2V0X2lkLHF1YW50aXR5LGFtb3VudCxtZXRhZGF0YVwiKVxuICAgICAgLmVxKFwiaWRcIiwgbGVkZ2VyUm93SWQpXG4gICAgICAuZXEoXCJlbnRyeV90eXBlXCIsIFwicHJpdmF0ZV9wdXJjaGFzZVwiKVxuICAgICAgLm1heWJlU2luZ2xlKCk7XG4gICAgaWYgKCFsZWRnZXJSb3cpIHJldHVybiBqc29uKHJlc3BvbnNlLCA0MDQsIHsgZXJyb3I6IFwiXHU2MjdFXHU0RTBEXHU1MjMwXHU1QzBEXHU2MUM5XHU3Njg0XHU4QThEXHU4Q0ZDXHU3RDAwXHU5MzA0XCIgfSk7XG4gICAgcmV0dXJuIHNldHRsZVN1YnNjcmliZUNvcmUoYWRtaW4sIHJlc3BvbnNlLCBsZWRnZXJSb3cpO1xuICB9XG4gIGlmIChzZXR0bGVBY3Rpb24gPT09IFwicmVkZWVtXCIpIHtcbiAgICBjb25zdCB7IGRhdGE6IG9yZGVyIH0gPSBhd2FpdCBhZG1pblxuICAgICAgLmZyb20oXCJyZWRlbXB0aW9uX29yZGVyc1wiKVxuICAgICAgLnNlbGVjdChcImlkLHVzZXJfaWQsd2FsbGV0X2FkZHJlc3MsamNfYW1vdW50LHVzZHRfYW1vdW50LHN0YXR1c1wiKVxuICAgICAgLmVxKFwiaWRcIiwgbGVkZ2VyUm93SWQpXG4gICAgICAubWF5YmVTaW5nbGUoKTtcbiAgICBpZiAoIW9yZGVyKSByZXR1cm4ganNvbihyZXNwb25zZSwgNDA0LCB7IGVycm9yOiBcIlx1NjI3RVx1NEUwRFx1NTIzMFx1NUMwRFx1NjFDOVx1NzY4NFx1OEQxNlx1NTZERVx1OEEwMlx1NTVBRVwiIH0pO1xuICAgIGlmIChvcmRlci5zdGF0dXMgIT09IFwicGVuZGluZ1wiKSB7XG4gICAgICByZXR1cm4ganNvbihyZXNwb25zZSwgMjAwLCB7IHN0YXR1czogb3JkZXIuc3RhdHVzLCBpZGVtcG90ZW50OiB0cnVlIH0pO1xuICAgIH1cbiAgICByZXR1cm4gc2V0dGxlUmVkZW1wdGlvbkNvcmUoYWRtaW4sIHJlc3BvbnNlLCBvcmRlcik7XG4gIH1cbiAgcmV0dXJuIGpzb24ocmVzcG9uc2UsIDQxMCwgeyBlcnJvcjogXCJcdTgyMEFcdTRFOENcdTdEMUFcdTVFMDJcdTU4MzQgcmVsYXllciBcdTdENTBcdTdCOTdcdTVERjJcdTUwNUNcdTc1MjhcdUZGMUJcdThBQ0JcdTRGN0ZcdTc1MjggUDJQRXNjcm93IFx1OEExN1x1N0JBMVx1NjIxMFx1NEVBNFx1N0QwMFx1OTMwNFx1MzAwMlwiIH0pO1xufVxuXG4vKipcbiAqIFx1N0NGQlx1N0Q3MVx1ODFFQVx1NTJENVx1NjM4M1x1NjNDRlx1NEUyNlx1ODhEQ1x1NzY3Q1x1NjI0MFx1NjcwOVx1NTM2MVx1NTVBRVx1RkYwOFx1NEUwRFx1OTcwMFx1ODk4MVx1NEVGQlx1NEY1NVx1NEVCQVx1NURFNVx1OUVERVx1NjRDQVx1RkYwOVx1RkYxQVx1NzUzMSBWZXJjZWwgQ3JvbiBcdTVCOUFcdTY3MUZcdTU0N0NcdTUzRUJcbiAqIFx1RkYwOFx1ODk4QiBhcGkvY3Jvbi9zZXR0bGUtc3dlZXAudHNcdUZGMDlcdUZGMENcdTVDMEQgZmluZEF0dGVudGlvbkNhbmRpZGF0ZXMgXHU2MjdFXHU1MjMwXHU3Njg0XHU2QkNGXHU0RTAwXHU3QjQ2XG4gKiBvcnBoYW4gLyBmYWlsZWQgLyBzdGFsZV9wZW5kaW5nIFx1N0QwMFx1OTMwNFx1NTQ3Q1x1NTNFQiByZXRyeVNldHRsZW1lbnRCeUFjdGlvbiBcdTkxQ0RcdThBNjZcdTRFMDBcdTZCMjFcdTMwMDJcbiAqIFx1NTM2MVx1NTcyOCBwZW5kaW5nIFx1NjcyQVx1OTAzRSAyIFx1NTIwNlx1OTQxOFx1NzY4NFx1NTE0OFx1OERGM1x1OTA0RVx1RkYwOFx1NTNFRlx1ODBGRFx1NzcxRlx1NzY4NFx1OTA4NFx1NTcyOFx1ODY1NVx1NzQwNlx1NEUyRFx1RkYwOVx1RkYwQ1x1OTA3Rlx1NTE0RFx1ODIwN1x1NkI2M1x1NTcyOFx1OTAzMlx1ODg0Q1x1NzY4NFxuICogXHU0RUE0XHU2NjEzXHU2NDM2XHU4REQxXHVGRjFCXHU1OTMxXHU2NTU3XHU1M0VBXHU4QTE4XHU5MzA0XHVGRjBDXHU0RTBEXHU0RTJEXHU2NUI3XHU1MTc2XHU0RUQ2XHU5ODA1XHU3NkVFXHU3Njg0XHU4OERDXHU3NjdDXHUzMDAyXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzd2VlcFN0dWNrU2V0dGxlbWVudHMoXG4gIGFkbWluOiBTdXBhYmFzZUNsaWVudCxcbiAgbGltaXQ/OiBudW1iZXIsXG4pOiBQcm9taXNlPHsgYXR0ZW1wdGVkOiBudW1iZXI7IGZpeGVkOiBudW1iZXI7IHN0aWxsRmFpbGluZzogeyBsZWRnZXJSb3dJZDogc3RyaW5nOyBhY3Rpb246IEF0dGVudGlvbkFjdGlvbjsgZXJyb3I6IHN0cmluZyB9W10gfT4ge1xuICBjb25zdCBhbGxJdGVtcyA9IGF3YWl0IGZpbmRBdHRlbnRpb25DYW5kaWRhdGVzKGFkbWluKTtcbiAgLy8gbGltaXQgXHU3NTI4XHU2NUJDXHUzMDBDXHU2QTVGXHU2NzAzXHU1RjBGXHUzMDBEXHU2MzgzXHU2M0NGXHVGRjFBXHU2QkNGXHU2QjIxXHU1M0VBXHU4NjU1XHU3NDA2XHU0RTAwXHU1QzBGXHU2Mjc5XHVGRjBDXHU5MDdGXHU1MTREXHU2MkQ2XHU2MTYyXHU4OUY4XHU3NjdDXHU1QjgzXHU3Njg0XHU0RjdGXHU3NTI4XHU4MDA1XHU4QUNCXHU2QzQyXHU2MjE2XG4gIC8vIFx1NjQ5RVx1NTIzMCBzZXJ2ZXJsZXNzIFx1OTAzRVx1NjY0Mlx1RkYxQlx1NkJDRlx1NjVFNSBjcm9uIFx1NTQ3Q1x1NTNFQlx1NjY0Mlx1NEUwRFx1NUUzNiBsaW1pdFx1RkYwQ1x1NEUwMFx1NkIyMVx1NjM4M1x1NUI4Q1x1NTE2OFx1OTBFOFx1MzAwMlxuICBjb25zdCBpdGVtcyA9IHR5cGVvZiBsaW1pdCA9PT0gXCJudW1iZXJcIiA/IGFsbEl0ZW1zLnNsaWNlKDAsIGxpbWl0KSA6IGFsbEl0ZW1zO1xuICBjb25zdCBzdGlsbEZhaWxpbmc6IHsgbGVkZ2VyUm93SWQ6IHN0cmluZzsgYWN0aW9uOiBBdHRlbnRpb25BY3Rpb247IGVycm9yOiBzdHJpbmcgfVtdID0gW107XG4gIGxldCBhdHRlbXB0ZWQgPSAwO1xuICBsZXQgZml4ZWQgPSAwO1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcbiAgICBpZiAoaXRlbS5zdGF0dXMgPT09IFwic3RhbGVfcGVuZGluZ1wiKSB7XG4gICAgICBjb25zdCBhZ2VNcyA9IERhdGUubm93KCkgLSBuZXcgRGF0ZShpdGVtLnVwZGF0ZWRBdCA/PyBpdGVtLmNyZWF0ZWRBdCkuZ2V0VGltZSgpO1xuICAgICAgaWYgKGFnZU1zIDwgMiAqIDYwICogMTAwMCkgY29udGludWU7XG4gICAgICBhd2FpdCBhZG1pblxuICAgICAgICAuZnJvbShcIm9uY2hhaW5fc2V0dGxlbWVudHNcIilcbiAgICAgICAgLnVwZGF0ZSh7IHN0YXR1czogXCJmYWlsZWRcIiwgZXJyb3I6IFwiY3JvbiBzd2VlcCBcdTUyMjRcdTVCOUFcdTkwM0VcdTY2NDJcdTUzNjFcdTU1QUVcdUZGMENcdTVERjJcdThGNDlcdTcwQkFcdTU5MzFcdTY1NTdcdTRFRTVcdTRGQkZcdTkxQ0RcdThBNjZcIiwgdXBkYXRlZF9hdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH0pXG4gICAgICAgIC5lcShcImlkXCIsIGl0ZW0uaWQgYXMgc3RyaW5nKTtcbiAgICB9XG4gICAgYXR0ZW1wdGVkICs9IDE7XG4gICAgY29uc3QgeyByZXNwb25zZSwgcmVhZCB9ID0gZmFrZVJlc3BvbnNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHJldHJ5U2V0dGxlbWVudEJ5QWN0aW9uKGFkbWluLCByZXNwb25zZSwgaXRlbS5hY3Rpb24sIGl0ZW0ubGVkZ2VyUm93SWQpO1xuICAgICAgY29uc3QgeyBzdGF0dXMsIGJvZHkgfSA9IHJlYWQoKTtcbiAgICAgIGlmIChzdGF0dXMgPj0gMjAwICYmIHN0YXR1cyA8IDMwMCkge1xuICAgICAgICBmaXhlZCArPSAxO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgZXJyb3JWYWx1ZSA9IGJvZHkgJiYgdHlwZW9mIGJvZHkgPT09IFwib2JqZWN0XCIgJiYgXCJlcnJvclwiIGluIGJvZHlcbiAgICAgICAgICA/IChib2R5IGFzIHsgZXJyb3I/OiB1bmtub3duIH0pLmVycm9yXG4gICAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSB0eXBlb2YgZXJyb3JWYWx1ZSA9PT0gXCJzdHJpbmdcIiAmJiBlcnJvclZhbHVlID8gZXJyb3JWYWx1ZSA6IGBIVFRQICR7c3RhdHVzfWA7XG4gICAgICAgIHN0aWxsRmFpbGluZy5wdXNoKHsgbGVkZ2VyUm93SWQ6IGl0ZW0ubGVkZ2VyUm93SWQsIGFjdGlvbjogaXRlbS5hY3Rpb24sIGVycm9yOiBtZXNzYWdlIH0pO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHN0aWxsRmFpbGluZy5wdXNoKHsgbGVkZ2VyUm93SWQ6IGl0ZW0ubGVkZ2VyUm93SWQsIGFjdGlvbjogaXRlbS5hY3Rpb24sIGVycm9yOiBlcnJNc2coZSkgfSk7XG4gICAgfVxuICB9XG4gIHJldHVybiB7IGF0dGVtcHRlZCwgZml4ZWQsIHN0aWxsRmFpbGluZyB9O1xufVxuXG5mdW5jdGlvbiBlcnJNc2coZTogdW5rbm93bik6IHN0cmluZyB7XG4gIGlmIChlICYmIHR5cGVvZiBlID09PSBcIm9iamVjdFwiICYmIFwic2hvcnRNZXNzYWdlXCIgaW4gZSAmJiB0eXBlb2YgKGUgYXMgeyBzaG9ydE1lc3NhZ2U6IHVua25vd24gfSkuc2hvcnRNZXNzYWdlID09PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIChlIGFzIHsgc2hvcnRNZXNzYWdlOiBzdHJpbmcgfSkuc2hvcnRNZXNzYWdlO1xuICB9XG4gIHJldHVybiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSk7XG59XG5cbi8vIFx1NkE1Rlx1NjcwM1x1NUYwRlx1ODFFQVx1NTJENVx1ODhEQ1x1NzY3Q1x1RkYxQUhvYmJ5IFx1NjVCOVx1Njg0OFx1NzY4NCBWZXJjZWwgY3JvbiBcdTY3MDBcdTVGRUJcdTUzRUFcdTgwRkRcdTZCQ0ZcdTY1RTVcdTRFMDBcdTZCMjFcdUZGMENcdTUxNDlcdTk3NjAgY3JvbiBcdTcxMjFcdTZDRDVcdThCOTNcbi8vIFx1NTM2MVx1NTVBRVx1ODIwN1x1NUY4NVx1NkQzRVx1NzY3Q1x1NTIwNlx1NkY2NFx1NTNDQVx1NjY0Mlx1NkUwNVx1NjM4OVx1MzAwMlx1NTZFMFx1NkI2NFx1NkJDRlx1NzU3Nlx1NjcwOSByZWxheWVyIFx1OEFDQlx1NkM0Mlx1RkYwOFx1OEE4RFx1OENGQyAvIFx1OEQxNlx1NTZERSAvXG4vLyBcdTkxRDFcdTVFQUJcdThDQjdcdTVFNjNcdTdCNDlcdTVFNzNcdTUzRjBcdTZEM0JcdTUyRDVcdUZGMDlcdTkwMzJcdTRGODZcdUZGMENcdTVDMzFcdTk4MDZcdTYyNEJcdTYzODNcdTRFMDBcdTVDMEZcdTYyNzlcdTIwMTRcdTIwMTRcdTVFNzNcdTUzRjBcdTUzRUFcdTg5ODFcdTY3MDlcdTRFQkFcdTU3MjhcdTc1MjhcdUZGMENcdTVDMzFcdTY3MDNcdTU3MjhcdTVFN0VcdTUyMDZcdTk0MThcdTUxNjdcdTgxRUFcdTYyMTFcdTRGRUVcdTVGQTlcdUZGMENcdTRFMERcdTk3MDBcdTg5ODFcdTRFQkFcdTVERTVcbi8vIFx1NEUwMFx1NzZGNFx1NjMwOVx1MzAwQ1x1NEUwMFx1OTM3NVx1ODhEQ1x1NzY3Q1x1MzAwRFx1MzAwMlx1NzUyOCBjbGFpbV9zd2VlcF9zbG90IFx1N0JDMFx1NkQ0MVx1NjIxMFx1NTE2OFx1NTdERlx1NjcwMFx1NTkxQVx1NkJDRiB+OTAgXHU3OUQyXHU0RTAwXHU2QjIxXHVGRjBDXHVGRkZEXHVGRkZEXHVGRkZEXHU2NTc0XHU2QkI1XG4vLyBiZXN0LWVmZm9ydFx1RkZGRFx1RkZGRFx1NEVGQlx1NEY1NVx1OTMyRlx1OEFBNFx1OTBGRFx1NTQxRVx1NjM4OVx1RkYwQ1x1N0Q1NVx1NEUwRFx1NUY3MVx1OTdGRlx1ODlGOFx1NzY3Q1x1NUI4M1x1NzY4NFx1NEY3Rlx1NzUyOFx1ODAwNVx1NjcyQ1x1OEVBQlx1NzY4NFx1NEVBNFx1NjYxM1x1N0Q1MFx1Njc5Q1x1MzAwMlxuYXN5bmMgZnVuY3Rpb24gbWF5YmVPcHBvcnR1bmlzdGljU3dlZXAoYWRtaW46IFN1cGFiYXNlQ2xpZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgeyBkYXRhOiBjbGFpbWVkLCBlcnJvciB9ID0gYXdhaXQgYWRtaW4ucnBjKFwiY2xhaW1fc3dlZXBfc2xvdFwiLCB7XG4gICAgICBwX2tleTogXCJzZXR0bGUtc3dlZXBcIixcbiAgICAgIHBfbWluX2ludGVydmFsX3NlY29uZHM6IDkwLFxuICAgIH0pO1xuICAgIGlmIChlcnJvciB8fCBjbGFpbWVkICE9PSB0cnVlKSByZXR1cm47IC8vIFx1NkM5Mlx1NjQzNlx1NTIzMFx1N0JDMFx1NkQ0MVx1N0E5N1x1RkYwOFx1NjIxNlx1ODg2OFx1NUMxQVx1NjcyQVx1NUVGQVx1N0FDQlx1RkYwOVx1MjE5MiBcdTc2RjRcdTYzQTVcdThERjNcdTkwNEVcbiAgICAvLyBcdTZCQ0ZcdTZCMjFcdTUzRUFcdTg2NTVcdTc0MDZcdTRFMDBcdTVDMEZcdTYyNzlcdUZGMENcdTkwN0ZcdTUxNERcdTYyRDZcdTYxNjJcdTc1NzZcdTUyNERcdTRGN0ZcdTc1MjhcdTgwMDVcdThBQ0JcdTZDNDJcdTYyMTZcdTY0OUUgc2VydmVybGVzcyBcdTkwM0VcdTY2NDJcdUZGMUJcdTUyNjlcdTRFMEJcdTc2ODRcdTc1MzFcdTVGOENcdTdFOENcbiAgICAvLyBcdThBQ0JcdTZDNDJcdTYyMTZcdTZCQ0ZcdTY1RTUgY3JvbiBcdTYzQTVcdTdFOENcdTg2NTVcdTc0MDZcdTMwMDJcbiAgICBhd2FpdCBzd2VlcFN0dWNrU2V0dGxlbWVudHMoYWRtaW4sIDQpLmNhdGNoKCgpID0+IHt9KTtcbiAgICBhd2FpdCBzd2VlcFBlbmRpbmdDb21taXNzaW9ucyhhZG1pbiwgOCkuY2F0Y2goKCkgPT4ge30pO1xuICB9IGNhdGNoIHtcbiAgICAvLyBcdTk3NUNcdTlFRDhcdUZGMUFcdTZBNUZcdTY3MDNcdTVGMEZcdTYzODNcdTYzQ0ZcdTZDMzhcdTkwNjBcdTRFMERcdThBNzJcdTVGNzFcdTk3RkZcdTRFM0JcdTZENDFcdTdBMEJcdTMwMDJcbiAgfVxufVxuIiwgImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvdmVyY2VsL3NoYXJlL3YwLXByb2plY3QvYXBpXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvdmVyY2VsL3NoYXJlL3YwLXByb2plY3QvYXBpL3RyYW5zbGF0ZS50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vdmVyY2VsL3NoYXJlL3YwLXByb2plY3QvYXBpL3RyYW5zbGF0ZS50c1wiO2ltcG9ydCB7IGdlbmVyYXRlVGV4dCwgT3V0cHV0IH0gZnJvbSBcImFpXCI7XG5pbXBvcnQgeyB6IH0gZnJvbSBcInpvZFwiO1xuXG5jb25zdCBsYW5ndWFnZUNvZGVzID0gW1wiemgtQ05cIiwgXCJlblwiLCBcImphXCIsIFwia29cIiwgXCJ0aFwiLCBcInZpXCIsIFwiaWRcIiwgXCJtc1wiLCBcImVzXCIsIFwiZnJcIiwgXCJkZVwiLCBcInB0XCIsIFwicnVcIiwgXCJhclwiLCBcImhpXCJdIGFzIGNvbnN0O1xuY29uc3QgbGFuZ3VhZ2VOYW1lczogUmVjb3JkPCh0eXBlb2YgbGFuZ3VhZ2VDb2RlcylbbnVtYmVyXSwgc3RyaW5nPiA9IHtcbiAgXCJ6aC1DTlwiOiBcIlNpbXBsaWZpZWQgQ2hpbmVzZVwiLCBlbjogXCJFbmdsaXNoXCIsIGphOiBcIkphcGFuZXNlXCIsIGtvOiBcIktvcmVhblwiLCB0aDogXCJUaGFpXCIsIHZpOiBcIlZpZXRuYW1lc2VcIiwgaWQ6IFwiSW5kb25lc2lhblwiLCBtczogXCJNYWxheVwiLCBlczogXCJTcGFuaXNoXCIsIGZyOiBcIkZyZW5jaFwiLCBkZTogXCJHZXJtYW5cIiwgcHQ6IFwiUG9ydHVndWVzZVwiLCBydTogXCJSdXNzaWFuXCIsIGFyOiBcIkFyYWJpY1wiLCBoaTogXCJIaW5kaVwiLFxufTtcbmNvbnN0IGJvZHlTY2hlbWEgPSB6Lm9iamVjdCh7XG4gIGtpbmQ6IHouZW51bShbXCJhc3NldFwiLCBcImFubm91bmNlbWVudFwiXSksXG4gIGZpZWxkczogei5yZWNvcmQoei5lbnVtKFtcIm5hbWVcIiwgXCJsb2NhdGlvblwiLCBcImluZm9ybWF0aW9uXCIsIFwidGl0bGVcIiwgXCJjb250ZW50XCJdKSwgei5zdHJpbmcoKS5tYXgoNTAwMCkpLFxufSk7XG5jb25zdCB0cmFuc2xhdGVkRmllbGRzU2NoZW1hID0gei5vYmplY3Qoe1xuICBuYW1lOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG4gIGxvY2F0aW9uOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG4gIGluZm9ybWF0aW9uOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG4gIHRpdGxlOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG4gIGNvbnRlbnQ6IHouc3RyaW5nKCkub3B0aW9uYWwoKSxcbn0pO1xuY29uc3QgdHJhbnNsYXRpb25TY2hlbWEgPSB6Lm9iamVjdCh7XG4gIHRyYW5zbGF0aW9uczogei5vYmplY3QoXG4gICAgT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgbGFuZ3VhZ2VDb2Rlcy5tYXAoKGNvZGUpID0+IFtjb2RlLCB0cmFuc2xhdGVkRmllbGRzU2NoZW1hXSksXG4gICAgKSBhcyBSZWNvcmQ8KHR5cGVvZiBsYW5ndWFnZUNvZGVzKVtudW1iZXJdLCB0eXBlb2YgdHJhbnNsYXRlZEZpZWxkc1NjaGVtYT4sXG4gICksXG59KTtcblxuZXhwb3J0IGNvbnN0IGNvbmZpZyA9IHsgbWF4RHVyYXRpb246IDYwIH07XG5cbnR5cGUgTm9kZVJlcXVlc3QgPSB7IG1ldGhvZD86IHN0cmluZzsgaGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgc3RyaW5nW10gfCB1bmRlZmluZWQ+OyBib2R5PzogdW5rbm93biB9O1xudHlwZSBOb2RlUmVzcG9uc2UgPSB7IHN0YXR1czogKGNvZGU6IG51bWJlcikgPT4gTm9kZVJlc3BvbnNlOyBqc29uOiAoYm9keTogdW5rbm93bikgPT4gdm9pZDsgc2V0SGVhZGVyOiAobmFtZTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKSA9PiB2b2lkIH07XG5cbmV4cG9ydCBkZWZhdWx0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZXIocmVxOiBOb2RlUmVxdWVzdCwgcmVzOiBOb2RlUmVzcG9uc2UpIHtcbiAgcmVzLnNldEhlYWRlcihcIkNhY2hlLUNvbnRyb2xcIiwgXCJuby1zdG9yZVwiKTtcbiAgaWYgKHJlcS5tZXRob2QgIT09IFwiUE9TVFwiKSByZXR1cm4gcmVzLnN0YXR1cyg0MDUpLmpzb24oeyBlcnJvcjogXCJNZXRob2Qgbm90IGFsbG93ZWRcIiB9KTtcbiAgY29uc3QgYXV0aG9yaXphdGlvbiA9IHR5cGVvZiByZXEuaGVhZGVycy5hdXRob3JpemF0aW9uID09PSBcInN0cmluZ1wiID8gcmVxLmhlYWRlcnMuYXV0aG9yaXphdGlvbiA6IFwiXCI7XG4gIGlmICghYXV0aG9yaXphdGlvbi5zdGFydHNXaXRoKFwiQmVhcmVyIFwiKSkgcmV0dXJuIHJlcy5zdGF0dXMoNDAxKS5qc29uKHsgZXJyb3I6IFwiVW5hdXRob3JpemVkXCIgfSk7XG4gIGNvbnN0IHN1cGFiYXNlVXJsID0gcHJvY2Vzcy5lbnYuU1VQQUJBU0VfVVJMID8/IHByb2Nlc3MuZW52Lk5FWFRfUFVCTElDX1NVUEFCQVNFX1VSTDtcbiAgY29uc3Qgc3VwYWJhc2VLZXkgPSBwcm9jZXNzLmVudi5TVVBBQkFTRV9BTk9OX0tFWSA/PyBwcm9jZXNzLmVudi5ORVhUX1BVQkxJQ19TVVBBQkFTRV9BTk9OX0tFWTtcbiAgaWYgKCFzdXBhYmFzZVVybCB8fCAhc3VwYWJhc2VLZXkpIHJldHVybiByZXMuc3RhdHVzKDUwMCkuanNvbih7IGVycm9yOiBcIlRyYW5zbGF0aW9uIHNlcnZpY2UgdW5hdmFpbGFibGVcIiB9KTtcbiAgY29uc3QgYWRtaW5SZXNwb25zZSA9IGF3YWl0IGZldGNoKGAke3N1cGFiYXNlVXJsfS9yZXN0L3YxL3JwYy9pc19jdXJyZW50X3VzZXJfYWRtaW5gLCB7XG4gICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICBoZWFkZXJzOiB7IGFwaWtleTogc3VwYWJhc2VLZXksIEF1dGhvcml6YXRpb246IGF1dGhvcml6YXRpb24sIFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgYm9keTogXCJ7fVwiLFxuICB9KTtcbiAgaWYgKCFhZG1pblJlc3BvbnNlLm9rIHx8IChhd2FpdCBhZG1pblJlc3BvbnNlLmpzb24oKSkgIT09IHRydWUpIHJldHVybiByZXMuc3RhdHVzKDQwMykuanNvbih7IGVycm9yOiBcIkZvcmJpZGRlblwiIH0pO1xuICBjb25zdCBwYXJzZWQgPSBib2R5U2NoZW1hLnNhZmVQYXJzZShyZXEuYm9keSk7XG4gIGlmICghcGFyc2VkLnN1Y2Nlc3MgfHwgT2JqZWN0LmtleXMocGFyc2VkLmRhdGEuZmllbGRzKS5sZW5ndGggPT09IDApIHJldHVybiByZXMuc3RhdHVzKDQwMCkuanNvbih7IGVycm9yOiBcIkludmFsaWQgY29udGVudFwiIH0pO1xuICBjb25zdCByZXF1aXJlZEZpZWxkcyA9IHBhcnNlZC5kYXRhLmtpbmQgPT09IFwiYXNzZXRcIiA/IFtcIm5hbWVcIiwgXCJsb2NhdGlvblwiLCBcImluZm9ybWF0aW9uXCJdIDogW1widGl0bGVcIiwgXCJjb250ZW50XCJdO1xuICBpZiAoIXJlcXVpcmVkRmllbGRzLmV2ZXJ5KChmaWVsZCkgPT4gdHlwZW9mIHBhcnNlZC5kYXRhLmZpZWxkc1tmaWVsZF0gPT09IFwic3RyaW5nXCIpKSByZXR1cm4gcmVzLnN0YXR1cyg0MDApLmpzb24oeyBlcnJvcjogXCJNaXNzaW5nIGZpZWxkc1wiIH0pO1xuICBjb25zdCBtb2RlbHMgPSBbXCJnb29nbGUvZ2VtaW5pLTMuNS1mbGFzaFwiLCBcImdvb2dsZS9nZW1pbmktMi41LWZsYXNoXCJdIGFzIGNvbnN0O1xuICBsZXQgbGFzdEVycm9yID0gXCJ1bmtub3duIGVycm9yXCI7XG4gIGZvciAoY29uc3QgbW9kZWwgb2YgbW9kZWxzKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgb3V0cHV0IH0gPSBhd2FpdCBnZW5lcmF0ZVRleHQoe1xuICAgICAgICBtb2RlbCxcbiAgICAgICAgb3V0cHV0OiBPdXRwdXQub2JqZWN0KHsgc2NoZW1hOiB0cmFuc2xhdGlvblNjaGVtYSB9KSxcbiAgICAgICAgcHJvbXB0OiBgVHJhbnNsYXRlIHRoZSBmb2xsb3dpbmcgVHJhZGl0aW9uYWwgQ2hpbmVzZSAke3BhcnNlZC5kYXRhLmtpbmR9IGNvbnRlbnQgaW50byBldmVyeSB0YXJnZXQgbGFuZ3VhZ2UuIFJldHVybiBleGFjdGx5IGFsbCB0YXJnZXQgbGFuZ3VhZ2UgY29kZXMgYW5kIGV4YWN0bHkgdGhlIG9yaWdpbmFsIGZpZWxkIGtleXMuIEV2ZXJ5IHZhbHVlIHdob3NlIHNvdXJjZSBpcyBub24tZW1wdHkgbXVzdCBiZSBhIG5vbi1lbXB0eSBzdHJpbmc7IHByZXNlcnZlIGFuIGVtcHR5IHNvdXJjZSB2YWx1ZSBhcyBhbiBlbXB0eSBzdHJpbmcuIFByZXNlcnZlIG51bWJlcnMsIGN1cnJlbmN5LCBwcm9wZXJ0eS9wcm9qZWN0IG5hbWVzLCBjb2RlcywgVVJMcywgcGFyYWdyYXBoIGJyZWFrcywgYW5kIHB1bmN0dWF0aW9uIG1lYW5pbmcuIERvIG5vdCBhZGQgY29tbWVudGFyeS5cXG5UYXJnZXRzOiAke2xhbmd1YWdlQ29kZXMubWFwKChjb2RlKSA9PiBgJHtjb2RlfT0ke2xhbmd1YWdlTmFtZXNbY29kZV19YCkuam9pbihcIiwgXCIpfVxcbkNvbnRlbnQ6ICR7SlNPTi5zdHJpbmdpZnkocGFyc2VkLmRhdGEuZmllbGRzKX1gLFxuICAgICAgfSk7XG4gICAgICBjb25zdCBjb21wbGV0ZSA9IGxhbmd1YWdlQ29kZXMuZXZlcnkoXG4gICAgICAgIChjb2RlKSA9PlxuICAgICAgICAgIG91dHB1dC50cmFuc2xhdGlvbnNbY29kZV0gJiZcbiAgICAgICAgICByZXF1aXJlZEZpZWxkcy5ldmVyeSgoZmllbGQpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHNvdXJjZVZhbHVlID0gcGFyc2VkLmRhdGEuZmllbGRzW2ZpZWxkXT8udHJpbSgpID8/IFwiXCI7XG4gICAgICAgICAgICBjb25zdCB2YWx1ZSA9IG91dHB1dC50cmFuc2xhdGlvbnNbY29kZV1bZmllbGRdO1xuICAgICAgICAgICAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIiAmJiAoIXNvdXJjZVZhbHVlIHx8IEJvb2xlYW4odmFsdWUudHJpbSgpKSkgJiYgIXZhbHVlLmluY2x1ZGVzKFwiXHVGRkZEXCIpO1xuICAgICAgICAgIH0pLFxuICAgICAgKTtcbiAgICAgIGlmICghY29tcGxldGUpIHRocm93IG5ldyBFcnJvcihcIkluY29tcGxldGUgdHJhbnNsYXRpb24gb3V0cHV0XCIpO1xuICAgICAgcmV0dXJuIHJlcy5zdGF0dXMoMjAwKS5qc29uKHsgdHJhbnNsYXRpb25zOiB7IFwiemgtVFdcIjogcGFyc2VkLmRhdGEuZmllbGRzLCAuLi5vdXRwdXQudHJhbnNsYXRpb25zIH0gfSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGxhc3RFcnJvciA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogXCJ1bmtub3duIGVycm9yXCI7XG4gICAgfVxuICB9XG4gIGNvbnNvbGUuZXJyb3IoXCJUcmFuc2xhdGlvbiBnZW5lcmF0aW9uIGZhaWxlZCBhZnRlciByZXRyeVwiLCBsYXN0RXJyb3IpO1xuICByZXR1cm4gcmVzLnN0YXR1cyg1MDIpLmpzb24oeyBlcnJvcjogXCJcdTgxRUFcdTUyRDVcdTdGRkJcdThCNkZcdTU5MzFcdTY1NTdcdUZGMENcdThBQ0JcdTdBMERcdTVGOENcdTUxOERcdThBNjZcIiB9KTtcbn1cbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL3ZlcmNlbC9zaGFyZS92MC1wcm9qZWN0XCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvdmVyY2VsL3NoYXJlL3YwLXByb2plY3Qvdml0ZS5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL3ZlcmNlbC9zaGFyZS92MC1wcm9qZWN0L3ZpdGUuY29uZmlnLnRzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnLCBsb2FkRW52IH0gZnJvbSAndml0ZSc7XG5pbXBvcnQgcmVhY3QgZnJvbSAnQHZpdGVqcy9wbHVnaW4tcmVhY3QnO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCwgVVJMIH0gZnJvbSAnbm9kZTp1cmwnO1xuaW1wb3J0IHR5cGUgeyBQbHVnaW4gfSBmcm9tICd2aXRlJztcblxuZnVuY3Rpb24gcHJpdnlTZXNzaW9uQXBpUGx1Z2luKCk6IFBsdWdpbiB7XG4gIHJldHVybiB7XG4gICAgbmFtZTogJ3ByaXZ5LXNlc3Npb24tYXBpJyxcbiAgICBjb25maWd1cmVTZXJ2ZXIoc2VydmVyKSB7XG4gICAgICAvLyBUaGUgVmVyY2VsIHNlcnZlcmxlc3MgZnVuY3Rpb24gaW4gYXBpL3ByaXZ5LXNlc3Npb24udHMgaXMgbm90IGV4ZWN1dGVkXG4gICAgICAvLyBieSBgdml0ZSBkZXZgLCBzbyBicmlkZ2UgaXQgaGVyZSB1c2luZyBpdHMgbmF0aXZlIChyZXEsIHJlcykgaGFuZGxlci5cbiAgICAgIHNlcnZlci5taWRkbGV3YXJlcy51c2UoJy9hcGkvcHJpdnktc2Vzc2lvbicsIGFzeW5jIChyZXEsIHJlcykgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHsgZGVmYXVsdDogaGFuZGxlciB9ID0gYXdhaXQgaW1wb3J0KCcuL2FwaS9wcml2eS1zZXNzaW9uJyk7XG4gICAgICAgICAgYXdhaXQgaGFuZGxlcihyZXEsIHJlcyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgY29uc29sZS5lcnJvcignW3YwXSBwcml2eS1zZXNzaW9uIGRldiBtaWRkbGV3YXJlIGVycm9yOicsIGVycm9yKTtcbiAgICAgICAgICBpZiAoIXJlcy53cml0YWJsZUVuZGVkKSB7XG4gICAgICAgICAgICByZXMuc3RhdHVzQ29kZSA9IDUwMDtcbiAgICAgICAgICAgIHJlcy5zZXRIZWFkZXIoJ0NvbnRlbnQtVHlwZScsICdhcHBsaWNhdGlvbi9qc29uJyk7XG4gICAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdQcml2eSBzZXNzaW9uIGJyaWRnZSBjcmFzaGVkIGluIGRldicgfSkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVsYXllckFwaVBsdWdpbigpOiBQbHVnaW4ge1xuICByZXR1cm4ge1xuICAgIG5hbWU6ICdyZWxheWVyLWFwaScsXG4gICAgY29uZmlndXJlU2VydmVyKHNlcnZlcikge1xuICAgICAgLy8gVGhlIFZlcmNlbCBzZXJ2ZXJsZXNzIGZ1bmN0aW9uIGluIGFwaS9yZWxheWVyLnRzIGlzIG5vdCBleGVjdXRlZCBieVxuICAgICAgLy8gYHZpdGUgZGV2YCwgc28gYnJpZGdlIGl0IGhlcmUgdXNpbmcgaXRzIG5hdGl2ZSAocmVxLCByZXMpIGhhbmRsZXIgXHUyMDE0XG4gICAgICAvLyBzYW1lIHBhdHRlcm4gYXMgcHJpdnktc2Vzc2lvbiBhYm92ZS4gV2l0aG91dCB0aGlzLCBQT1NUIC9hcGkvcmVsYXllclxuICAgICAgLy8gZmFsbHMgdGhyb3VnaCB0byB0aGUgU1BBIGFuZCB0aGUgZnJvbnRlbmQgb25seSBzZWVzIGEgZ2VuZXJpY1xuICAgICAgLy8gXCJyZWxheWVyIC4uLiBcdTU5MzFcdTY1NTdcIiB3aXRoIG5vIHJlYWwgZXJyb3IgZGV0YWlsLlxuICAgICAgc2VydmVyLm1pZGRsZXdhcmVzLnVzZSgnL2FwaS9yZWxheWVyJywgYXN5bmMgKHJlcSwgcmVzKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgeyBkZWZhdWx0OiBoYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoJy4vYXBpL3JlbGF5ZXInKTtcbiAgICAgICAgICBhd2FpdCBoYW5kbGVyKHJlcSwgcmVzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBjb25zb2xlLmVycm9yKCdbdjBdIHJlbGF5ZXIgZGV2IG1pZGRsZXdhcmUgZXJyb3I6JywgZXJyb3IpO1xuICAgICAgICAgIGlmICghcmVzLndyaXRhYmxlRW5kZWQpIHtcbiAgICAgICAgICAgIHJlcy5zdGF0dXNDb2RlID0gNTAwO1xuICAgICAgICAgICAgcmVzLnNldEhlYWRlcignQ29udGVudC1UeXBlJywgJ2FwcGxpY2F0aW9uL2pzb24nKTtcbiAgICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiAnUmVsYXllciBicmlkZ2UgY3Jhc2hlZCBpbiBkZXYnIH0pKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIGFwcFZlcnNpb25QbHVnaW4oYXBwVmVyc2lvbjogc3RyaW5nKTogUGx1Z2luIHtcbiAgcmV0dXJuIHtcbiAgICBuYW1lOiAnYXBwLXZlcnNpb24nLFxuICAgIGNvbmZpZ3VyZVByZXZpZXdTZXJ2ZXIoc2VydmVyKSB7XG4gICAgICBzZXJ2ZXIubWlkZGxld2FyZXMudXNlKCcvYXBpL2FwcC12ZXJzaW9uJywgKHJlcSwgcmVzKSA9PiB7XG4gICAgICAgIGlmIChyZXEubWV0aG9kICE9PSAnR0VUJyAmJiByZXEubWV0aG9kICE9PSAnSEVBRCcpIHtcbiAgICAgICAgICByZXMuc3RhdHVzQ29kZSA9IDQwNTtcbiAgICAgICAgICByZXMuc2V0SGVhZGVyKCdBbGxvdycsICdHRVQsIEhFQUQnKTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdNZXRob2Qgbm90IGFsbG93ZWQnIH0pKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICByZXMuc3RhdHVzQ29kZSA9IDIwMDtcbiAgICAgICAgcmVzLnNldEhlYWRlcignQ29udGVudC1UeXBlJywgJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnKTtcbiAgICAgICAgcmVzLnNldEhlYWRlcignQ2FjaGUtQ29udHJvbCcsICduby1zdG9yZSwgbm8tY2FjaGUsIG11c3QtcmV2YWxpZGF0ZSwgcHJveHktcmV2YWxpZGF0ZScpO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgdmVyc2lvbjogYXBwVmVyc2lvbiB9KSk7XG4gICAgICB9KTtcbiAgICB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiB0cmFuc2xhdGlvbkFwaVBsdWdpbigpOiBQbHVnaW4ge1xuICByZXR1cm4ge1xuICAgIG5hbWU6ICd0cmFuc2xhdGlvbi1hcGknLFxuICAgIGNvbmZpZ3VyZVNlcnZlcihzZXJ2ZXIpIHtcbiAgICAgIHNlcnZlci5taWRkbGV3YXJlcy51c2UoJy9hcGkvdHJhbnNsYXRlJywgYXN5bmMgKHJlcSwgcmVzKSA9PiB7XG4gICAgICAgIGNvbnN0IGNodW5rczogQnVmZmVyW10gPSBbXTtcbiAgICAgICAgZm9yIGF3YWl0IChjb25zdCBjaHVuayBvZiByZXEpIGNodW5rcy5wdXNoKEJ1ZmZlci5mcm9tKGNodW5rKSk7XG4gICAgICAgIGNvbnN0IHJhd0JvZHkgPSBCdWZmZXIuY29uY2F0KGNodW5rcykudG9TdHJpbmcoJ3V0ZjgnKTtcbiAgICAgICAgbGV0IGJvZHk6IHVua25vd247XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYm9keSA9IHJhd0JvZHkgPyBKU09OLnBhcnNlKHJhd0JvZHkpIDogdW5kZWZpbmVkO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICByZXMuc3RhdHVzQ29kZSA9IDQwMDtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnZhbGlkIEpTT04nIH0pKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgeyBkZWZhdWx0OiBoYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoJy4vYXBpL3RyYW5zbGF0ZScpO1xuICAgICAgICBjb25zdCByZXNwb25zZSA9IHtcbiAgICAgICAgICBzdGF0dXMoY29kZTogbnVtYmVyKSB7XG4gICAgICAgICAgICByZXMuc3RhdHVzQ29kZSA9IGNvZGU7XG4gICAgICAgICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgICAgICAgfSxcbiAgICAgICAgICBqc29uKHZhbHVlOiB1bmtub3duKSB7XG4gICAgICAgICAgICByZXMuc2V0SGVhZGVyKCdDb250ZW50LVR5cGUnLCAnYXBwbGljYXRpb24vanNvbicpO1xuICAgICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xuICAgICAgICAgIH0sXG4gICAgICAgICAgc2V0SGVhZGVyKG5hbWU6IHN0cmluZywgdmFsdWU6IHN0cmluZykge1xuICAgICAgICAgICAgcmVzLnNldEhlYWRlcihuYW1lLCB2YWx1ZSk7XG4gICAgICAgICAgfSxcbiAgICAgICAgfTtcbiAgICAgICAgYXdhaXQgaGFuZGxlcihcbiAgICAgICAgICB7XG4gICAgICAgICAgICBtZXRob2Q6IHJlcS5tZXRob2QsXG4gICAgICAgICAgICBoZWFkZXJzOiByZXEuaGVhZGVycyxcbiAgICAgICAgICAgIGJvZHksXG4gICAgICAgICAgfSxcbiAgICAgICAgICByZXNwb25zZSxcbiAgICAgICAgKTtcbiAgICAgIH0pO1xuICAgIH0sXG4gIH07XG59XG5cbi8vIGh0dHBzOi8vdml0ZWpzLmRldi9jb25maWcvXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoKHsgbW9kZSB9KSA9PiB7XG4gIGNvbnN0IGVudiA9IGxvYWRFbnYobW9kZSwgcHJvY2Vzcy5jd2QoKSwgJycpO1xuICBPYmplY3QuYXNzaWduKHByb2Nlc3MuZW52LCBlbnYpO1xuICBjb25zdCBhcHBWZXJzaW9uID0gZW52LlZFUkNFTF9ERVBMT1lNRU5UX0lEIHx8IGVudi5WRVJDRUxfR0lUX0NPTU1JVF9TSEEgfHwgcHJvY2Vzcy5lbnYuVkVSQ0VMX0RFUExPWU1FTlRfSUQgfHwgcHJvY2Vzcy5lbnYuVkVSQ0VMX0dJVF9DT01NSVRfU0hBIHx8ICdsb2NhbCc7XG4gIHJldHVybiB7XG4gIHBsdWdpbnM6IFtyZWFjdCgpLCBwcml2eVNlc3Npb25BcGlQbHVnaW4oKSwgcmVsYXllckFwaVBsdWdpbigpLCB0cmFuc2xhdGlvbkFwaVBsdWdpbigpLCBhcHBWZXJzaW9uUGx1Z2luKGFwcFZlcnNpb24pXSxcbiAgZGVmaW5lOiB7XG4gICAgX19BUFBfVkVSU0lPTl9fOiBKU09OLnN0cmluZ2lmeShhcHBWZXJzaW9uKSxcbiAgICAncHJvY2Vzcy5lbnYuTkVYVF9QVUJMSUNfU1VQQUJBU0VfVVJMJzogSlNPTi5zdHJpbmdpZnkoZW52Lk5FWFRfUFVCTElDX1NVUEFCQVNFX1VSTCksXG4gICAgJ3Byb2Nlc3MuZW52Lk5FWFRfUFVCTElDX1NVUEFCQVNFX0FOT05fS0VZJzogSlNPTi5zdHJpbmdpZnkoZW52Lk5FWFRfUFVCTElDX1NVUEFCQVNFX0FOT05fS0VZKSxcbiAgICAncHJvY2Vzcy5lbnYuTkVYVF9QVUJMSUNfREVWX1NVUEFCQVNFX1JFRElSRUNUX1VSTCc6IEpTT04uc3RyaW5naWZ5KGVudi5ORVhUX1BVQkxJQ19ERVZfU1VQQUJBU0VfUkVESVJFQ1RfVVJMKSxcbiAgICAncHJvY2Vzcy5lbnYuTkVYVF9QVUJMSUNfUFJJVllfQVBQX0lEJzogSlNPTi5zdHJpbmdpZnkoZW52Lk5FWFRfUFVCTElDX1BSSVZZX0FQUF9JRCksXG4gIH0sXG4gIHJlc29sdmU6IHtcbiAgICBhbGlhczoge1xuICAgICAgJ0AnOiBmaWxlVVJMVG9QYXRoKG5ldyBVUkwoJy4vc3JjJywgaW1wb3J0Lm1ldGEudXJsKSksXG4gICAgfSxcbiAgfSxcbiAgb3B0aW1pemVEZXBzOiB7XG4gICAgZXhjbHVkZTogWydsdWNpZGUtcmVhY3QnXSxcbiAgfSxcbiAgc2VydmVyOiB7XG4gICAgaG9zdDogJzAuMC4wLjAnLFxuICAgIGhtcjoge1xuICAgICAgcHJvdG9jb2w6ICd3c3MnLFxuICAgICAgY2xpZW50UG9ydDogNDQzLFxuICAgIH0sXG4gIH0sXG59O1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7Ozs7Ozs7OztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQ0EsU0FBUyxvQkFBb0I7QUFxQjdCLFNBQVMsS0FBSyxVQUEwQixRQUFnQixTQUFrQjtBQUN4RSxXQUFTLGFBQWE7QUFDdEIsV0FBUyxVQUFVLGdCQUFnQixpQ0FBaUM7QUFDcEUsV0FBUyxVQUFVLGlCQUFpQixVQUFVO0FBQzlDLFdBQVMsSUFBSSxLQUFLLFVBQVUsT0FBTyxDQUFDO0FBQ3RDO0FBRUEsZUFBZSxTQUFTLFNBQTBCO0FBQ2hELE1BQUksTUFBTTtBQUNWLG1CQUFpQixTQUFTLFNBQVM7QUFDakMsV0FBTztBQUNQLFFBQUksSUFBSSxTQUFTLE1BQVEsT0FBTSxJQUFJLE1BQU0sbUJBQW1CO0FBQUEsRUFDOUQ7QUFDQSxTQUFPLEtBQUssTUFBTSxPQUFPLElBQUk7QUFNL0I7QUFjQSxlQUFlLFVBQVU7QUFDdkIsTUFBSSxDQUFDLE1BQU8sUUFBTztBQUNuQixNQUFJLENBQUMsV0FBVztBQUNkLFVBQU0sRUFBRSxtQkFBbUIsSUFBSSxNQUFNLFNBQVM7QUFDOUMsZ0JBQVk7QUFBQSxNQUNWLElBQUksSUFBSSxxQ0FBcUMsS0FBSyxZQUFZO0FBQUEsSUFDaEU7QUFBQSxFQUNGO0FBQ0EsU0FBTztBQUNUO0FBRUEsZUFBTyxRQUErQixTQUEwQixVQUEwQjtBQUN4RixNQUFJLFFBQVEsV0FBVyxRQUFRO0FBQzdCLGFBQVMsVUFBVSxTQUFTLE1BQU07QUFDbEMsV0FBTyxLQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8scUJBQXFCLENBQUM7QUFBQSxFQUM1RDtBQUVBLFFBQU0sY0FBYyxRQUFRLElBQUk7QUFDaEMsUUFBTSxhQUFhLFFBQVEsSUFBSSw2QkFBNkIsUUFBUSxJQUFJO0FBQ3hFLFFBQU0sT0FBTyxNQUFNLFFBQVE7QUFDM0IsTUFBSSxDQUFDLGVBQWUsQ0FBQyxjQUFjLENBQUMsU0FBUyxDQUFDLE1BQU07QUFDbEQsV0FBTyxLQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8seUNBQXlDLENBQUM7QUFBQSxFQUNoRjtBQUNBLFFBQU0sRUFBRSxVQUFVLElBQUksTUFBTSxTQUFTO0FBRXJDLE1BQUk7QUFDSixNQUFJO0FBQ0osTUFBSTtBQUNKLE1BQUk7QUFDSixNQUFJO0FBQ0YsVUFBTSxPQUFPLE1BQU0sU0FBUyxPQUFPO0FBQ25DLG9CQUFnQixLQUFLO0FBQ3JCLGtCQUFjLEtBQUs7QUFDbkIsa0JBQWMsS0FBSztBQUNuQixtQkFBZSxLQUFLO0FBQUEsRUFDdEIsUUFBUTtBQUNOLFdBQU8sS0FBSyxVQUFVLEtBQUssRUFBRSxPQUFPLHVCQUF1QixDQUFDO0FBQUEsRUFDOUQ7QUFDQSxNQUFJLENBQUMsaUJBQWlCLENBQUMsYUFBYTtBQUNsQyxXQUFPLEtBQUssVUFBVSxLQUFLLEVBQUUsT0FBTyx3Q0FBd0MsQ0FBQztBQUFBLEVBQy9FO0FBVUEsTUFBSSxVQUFVO0FBQ2QsTUFBSSxRQUF1QjtBQUMzQixNQUFJLGlCQUFnQztBQUVwQyxNQUFJLGVBQWU7QUFDakIsUUFBSTtBQUNGLFlBQU0sRUFBRSxRQUFRLElBQUksTUFBTSxVQUFVLGVBQWUsTUFBTTtBQUFBLFFBQ3ZELFFBQVE7QUFBQSxRQUNSLFVBQVU7QUFBQSxNQUNaLENBQUM7QUFDRCxnQkFBVSxPQUFPLFFBQVEsT0FBTyxFQUFFO0FBQ2xDLFlBQU0sWUFBWSxRQUFRO0FBQzFCLFlBQU0sU0FBMEIsT0FBTyxjQUFjLFdBQVcsS0FBSyxNQUFNLFNBQVMsSUFBSSxDQUFDO0FBQ3pGLFlBQU0sZUFBZSxPQUFPLEtBQUssQ0FBQyxZQUFZLFFBQVEsU0FBUyxXQUFXLFFBQVEsT0FBTztBQUN6RixZQUFNLGdCQUFnQixPQUFPLEtBQUssQ0FBQyxZQUFZLFFBQVEsU0FBUyxrQkFBa0IsUUFBUSxLQUFLO0FBQy9GLGVBQVMsY0FBYyxXQUFXLGVBQWUsU0FBUyxPQUFPLFlBQVksS0FBSztBQUNsRixZQUFNLGlCQUFpQixPQUFPO0FBQUEsUUFDNUIsQ0FBQyxZQUNDLFFBQVEsU0FBUyxhQUNoQixRQUFRLGtCQUFrQixXQUFXLFFBQVEsdUJBQXVCLFlBQ3JFLFVBQVUsUUFBUSxPQUFPO0FBQUEsTUFDN0I7QUFDQSxVQUFJLGdCQUFnQixRQUFTLGtCQUFpQixlQUFlO0FBQUEsSUFDL0QsUUFBUTtBQUNOLHNCQUFnQjtBQUFBLElBQ2xCO0FBQUEsRUFDRjtBQUVBLE1BQUksQ0FBQyxXQUFXLGFBQWE7QUFDM0IsUUFBSTtBQUNGLFlBQU0sRUFBRSxRQUFRLElBQUksTUFBTSxVQUFVLGFBQWEsTUFBTTtBQUFBLFFBQ3JELFFBQVE7QUFBQSxRQUNSLFVBQVU7QUFBQSxNQUNaLENBQUM7QUFDRCxnQkFBVSxPQUFPLFFBQVEsT0FBTyxFQUFFO0FBQUEsSUFDcEMsUUFBUTtBQUNOLGFBQU8sS0FBSyxVQUFVLEtBQUssRUFBRSxPQUFPLHNCQUFzQixDQUFDO0FBQUEsSUFDN0Q7QUFBQSxFQUNGO0FBRUEsTUFBSSxDQUFDLFFBQVMsUUFBTyxLQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sc0JBQXNCLENBQUM7QUFXekUsTUFBSSxDQUFDLFNBQVMsUUFBUSxXQUFXLEVBQUcsU0FBUSxZQUFZLFlBQVk7QUFFcEUsTUFBSSxDQUFDLE1BQU8sUUFBTyxLQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8scUNBQXFDLENBQUM7QUFJdEYsUUFBTSxnQkFDSixtQkFBbUIsVUFBVSxZQUFZLElBQUssZUFBMEI7QUFFMUUsUUFBTSxRQUFRLGFBQWEsYUFBYSxZQUFZO0FBQUEsSUFDbEQsTUFBTSxFQUFFLGdCQUFnQixPQUFPLGtCQUFrQixNQUFNO0FBQUEsRUFDekQsQ0FBQztBQUdELE1BQUksU0FBd0I7QUFDNUIsUUFBTSxFQUFFLE1BQU0sZ0JBQWdCLElBQUksTUFBTSxNQUNyQyxLQUFLLFVBQVUsRUFDZixPQUFPLElBQUksRUFDWCxHQUFHLFNBQVMsS0FBSyxFQUNqQixZQUFZO0FBQ2YsV0FBUyxpQkFBaUIsTUFBTTtBQUVoQyxNQUFJLENBQUMsUUFBUTtBQUNYLFVBQU0sRUFBRSxNQUFNLFNBQVMsT0FBTyxZQUFZLElBQUksTUFBTSxNQUFNLEtBQUssTUFBTSxXQUFXO0FBQUEsTUFDOUU7QUFBQSxNQUNBLGVBQWU7QUFBQSxNQUNmLGVBQWUsRUFBRSxVQUFVLFFBQVE7QUFBQSxJQUNyQyxDQUFDO0FBQ0QsUUFBSSxTQUFTLE1BQU07QUFDakIsZUFBUyxRQUFRLEtBQUs7QUFBQSxJQUN4QixXQUFXLGFBQWE7QUFFdEIsZUFBUyxPQUFPLEdBQUcsUUFBUSxNQUFNLENBQUMsUUFBUSxRQUFRLEdBQUc7QUFDbkQsY0FBTSxFQUFFLE1BQU0sTUFBTSxPQUFPLFVBQVUsSUFBSSxNQUFNLE1BQU0sS0FBSyxNQUFNLFVBQVUsRUFBRSxNQUFNLFNBQVMsSUFBSSxDQUFDO0FBQ2hHLFlBQUksVUFBVztBQUNmLGNBQU0sUUFBUSxLQUFLLE1BQU0sS0FBSyxDQUFDLGNBQWMsVUFBVSxPQUFPLFlBQVksTUFBTSxLQUFLO0FBQ3JGLFlBQUksTUFBTyxVQUFTLE1BQU07QUFDMUIsWUFBSSxLQUFLLE1BQU0sU0FBUyxJQUFLO0FBQUEsTUFDL0I7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLE1BQUksQ0FBQyxPQUFRLFFBQU8sS0FBSyxVQUFVLEtBQUssRUFBRSxPQUFPLHFDQUFxQyxDQUFDO0FBTXZGLFFBQU0saUJBQTBDO0FBQUEsSUFDOUMsSUFBSTtBQUFBLElBQ0o7QUFBQSxJQUNBLFVBQVU7QUFBQSxJQUNWLGFBQVksb0JBQUksS0FBSyxHQUFFLFlBQVk7QUFBQSxFQUNyQztBQUNBLE1BQUksY0FBZSxnQkFBZSxpQkFBaUI7QUFDbkQsTUFBSTtBQUNGLFVBQU0sRUFBRSxPQUFPLFlBQVksSUFBSSxNQUFNLE1BQ2xDLEtBQUssVUFBVSxFQUNmLE9BQU8sZ0JBQWdCLEVBQUUsWUFBWSxLQUFLLENBQUM7QUFDOUMsUUFBSSxhQUFhO0FBQ2YsY0FBUSxNQUFNLDJDQUEyQyxZQUFZLE9BQU87QUFBQSxJQUM5RTtBQUFBLEVBQ0YsU0FBUyxXQUFXO0FBQ2xCLFlBQVEsTUFBTSwwQ0FBMEMsU0FBUztBQUFBLEVBQ25FO0FBR0EsUUFBTSxFQUFFLE1BQU0sVUFBVSxPQUFPLFVBQVUsSUFBSSxNQUFNLE1BQU0sS0FBSyxNQUFNLGFBQWE7QUFBQSxJQUMvRSxNQUFNO0FBQUEsSUFDTjtBQUFBLEVBQ0YsQ0FBQztBQUNELFFBQU0sWUFBWSxVQUFVLFlBQVk7QUFDeEMsTUFBSSxhQUFhLENBQUMsV0FBVztBQUMzQixXQUFPLEtBQUssVUFBVSxLQUFLLEVBQUUsT0FBTywwQkFBMEIsQ0FBQztBQUFBLEVBQ2pFO0FBRUEsU0FBTyxLQUFLLFVBQVUsS0FBSyxFQUFFLFdBQVcsT0FBTyxjQUFjLENBQUM7QUFDaEU7QUF6T0EsSUFVSSxhQUNFLFVBZ0NBLFNBR0EsV0FPQSxPQUNGO0FBdERKO0FBQUE7QUFVQSxJQUFJLGNBQTBDO0FBQzlDLElBQU0sV0FBVyxNQUFPLGdCQUFnQixPQUFPLHVHQUFNO0FBZ0NyRCxJQUFNLFVBQVUsQ0FBQyxVQUNmLE9BQU8sVUFBVSxZQUFZLDZCQUE2QixLQUFLLEtBQUs7QUFFdEUsSUFBTSxZQUFZLENBQUMsVUFDakIsT0FBTyxVQUFVLFlBQVksc0JBQXNCLEtBQUssS0FBSztBQU0vRCxJQUFNLFFBQVEsUUFBUSxJQUFJLDRCQUE0QjtBQUN0RCxJQUFJLFlBQWlFO0FBQUE7QUFBQTs7O0FDaENyRSxTQUFTLGNBQWM7QUFJdkIsU0FBUyxtQkFBMkI7QUFDbEMsUUFBTSxNQUFNLFFBQVEsSUFBSSw0QkFBNEIsUUFBUSxJQUFJO0FBQ2hFLE1BQUksQ0FBQyxJQUFLLE9BQU0sSUFBSSxNQUFNLGlHQUF5RDtBQU1uRixNQUFJO0FBQ0YsVUFBTSxTQUFTLElBQUksSUFBSSxHQUFHO0FBQzFCLFdBQU8sYUFBYSxPQUFPLFNBQVM7QUFDcEMsV0FBTyxPQUFPLFNBQVM7QUFBQSxFQUN6QixRQUFRO0FBRU4sV0FBTztBQUFBLEVBQ1Q7QUFDRjtBQUVBLGVBQWUsaUJBQW9CLFNBQWlCLElBQWtDO0FBT3BGLFFBQU0sU0FBUyxJQUFJLE9BQU87QUFBQSxJQUN4QixrQkFBa0IsaUJBQWlCO0FBQUEsSUFDbkMsS0FBSyxFQUFFLG9CQUFvQixNQUFNO0FBQUEsRUFDbkMsQ0FBQztBQUNELFFBQU0sT0FBTyxRQUFRO0FBQ3JCLE1BQUk7QUFDRixVQUFNLE9BQU8sTUFBTSxPQUFPO0FBRzFCLFVBQU0sT0FBTyxNQUFNLG9DQUFvQyxDQUFDLE9BQU8sQ0FBQztBQUNoRSxVQUFNLFNBQVMsTUFBTSxHQUFHO0FBQ3hCLFVBQU0sT0FBTyxNQUFNLFFBQVE7QUFDM0IsV0FBTztBQUFBLEVBQ1QsU0FBUyxPQUFPO0FBQ2QsVUFBTSxPQUFPLE1BQU0sVUFBVSxFQUFFLE1BQU0sTUFBTTtBQUFBLElBQUMsQ0FBQztBQUM3QyxVQUFNO0FBQUEsRUFDUixVQUFFO0FBQ0EsVUFBTSxPQUFPLElBQUksRUFBRSxNQUFNLE1BQU07QUFBQSxJQUFDLENBQUM7QUFBQSxFQUNuQztBQUNGO0FBU0EsZUFBc0IsbUJBQXNCLElBQWtDO0FBQzVFLFNBQU8saUJBQWlCLGdCQUFnQixFQUFFO0FBQzVDO0FBakZBLElBd0JNO0FBeEJOO0FBQUE7QUF3QkEsSUFBTSxpQkFBaUI7QUFBQTtBQUFBOzs7QUNHdkI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FHSztBQUNQLFNBQVMsbUJBQW1CLDJCQUEyQjtBQUN2RCxTQUFTLG1CQUFtQjtBQWtKNUIsU0FBUyxpQkFBaUIsVUFBOEJBLFdBQWtCLE9BQXdCO0FBQ2hHLE1BQUk7QUFDRixXQUFPLFlBQVksWUFBWUEsV0FBVSxLQUFLLENBQUM7QUFBQSxFQUNqRCxRQUFRO0FBQ04sVUFBTSxJQUFJLE1BQU0sR0FBRyxLQUFLLHVDQUFTO0FBQUEsRUFDbkM7QUFDRjtBQTZJQSxlQUFlLDBCQUEwQixPQUErQjtBQUN0RSxRQUFNLGlCQUFpQixNQUFNLGFBQWEsRUFBRSxhQUFhO0FBQUEsSUFDdkQsU0FBUyxrQkFBa0I7QUFBQSxJQUMzQixLQUFLO0FBQUEsSUFDTCxjQUFjO0FBQUEsSUFDZCxNQUFNLENBQUMsV0FBVyxLQUFLLENBQUM7QUFBQSxFQUMxQixDQUFDO0FBQ0QsTUFBSSxDQUFDLGVBQWdCLE9BQU0sSUFBSSxNQUFNLHFIQUFnQztBQUN2RTtBQUVBLGVBQXNCLDBCQUEwQixhQUE4QztBQUM1RixRQUFNLFFBQVMsTUFBTSxhQUFhLEVBQUUsYUFBYTtBQUFBLElBQy9DLFNBQVMsa0JBQWtCO0FBQUEsSUFDM0IsS0FBSztBQUFBLElBQ0wsY0FBYztBQUFBLElBQ2QsTUFBTSxDQUFDLFlBQVksS0FBSyxDQUFDO0FBQUEsRUFDM0IsQ0FBQztBQUNELE1BQUksQ0FBQyxTQUFTLFVBQVUsNkNBQThDLFFBQU87QUFDN0UsUUFBTSxRQUFRLFdBQVcsS0FBSztBQUM5QixRQUFNLDBCQUEwQixLQUFLO0FBQ3JDLFNBQU87QUFDVDtBQUVBLGVBQWUsbUJBQW1CLE9BQWlDO0FBQ2pFLFFBQU0sMEJBQTBCLEtBQUs7QUFDckMsUUFBTSxTQUFTLHdCQUF3QixJQUFJLEtBQUs7QUFDaEQsTUFBSSxVQUFVLEtBQU0sUUFBTztBQUMzQixNQUFJLFFBQVE7QUFDWixNQUFJO0FBQ0YsWUFBUSxPQUFPLE1BQU0sYUFBYSxFQUFFLGFBQWEsRUFBRSxTQUFTLE9BQU8sS0FBSyxlQUFlLGNBQWMsV0FBVyxDQUFDLENBQUM7QUFBQSxFQUNwSCxRQUFRO0FBQ04sWUFBUTtBQUFBLEVBQ1Y7QUFDQSwwQkFBd0IsSUFBSSxPQUFPLEtBQUs7QUFDeEMsU0FBTztBQUNUO0FBUUEsZUFBc0Isc0JBQ3BCLGFBQ0EsTUFDQSxRQUNBLFVBQ0EsYUFDNkU7QUFDN0UsUUFBTSxpQkFBaUI7QUFDdkIsUUFBTSxXQUFZLE1BQU0sYUFBYSxFQUFFLGFBQWE7QUFBQSxJQUNsRCxTQUFTLGtCQUFrQjtBQUFBLElBQzNCLEtBQUs7QUFBQSxJQUNMLGNBQWM7QUFBQSxJQUNkLE1BQU0sQ0FBQyxXQUFXO0FBQUEsRUFDcEIsQ0FBQztBQUNELE1BQUksWUFBWSxhQUFhLDhDQUE4QztBQUN6RSxXQUFPLEVBQUUsY0FBYyxXQUFXLFFBQVEsR0FBRyxRQUFRLGtCQUFrQixnQkFBZ0IsS0FBSztBQUFBLEVBQzlGO0FBQ0EsUUFBTSxtQkFBbUIsV0FBVyxPQUFPLFdBQVcsR0FBRyxRQUFRO0FBQ2pFLFFBQU0sT0FBTyxNQUFNO0FBQUEsSUFBWSxDQUFDLFVBQzlCLGtCQUFrQixFQUFFLGNBQWM7QUFBQSxNQUNoQyxTQUFTLGtCQUFrQjtBQUFBLE1BQzNCLEtBQUs7QUFBQSxNQUNMLGNBQWM7QUFBQSxNQUNkLE1BQU0sQ0FBQyxhQUFhLE1BQU0sUUFBUSxVQUFVLGdCQUFnQjtBQUFBLE1BQzVELE9BQU87QUFBQSxNQUNQO0FBQUEsSUFDRixDQUFDO0FBQUEsRUFDSDtBQUNBLFFBQU0sY0FBYyxJQUFJO0FBQ3hCLFFBQU0sZUFBZ0IsTUFBTSxhQUFhLEVBQUUsYUFBYTtBQUFBLElBQ3RELFNBQVMsa0JBQWtCO0FBQUEsSUFDM0IsS0FBSztBQUFBLElBQ0wsY0FBYztBQUFBLElBQ2QsTUFBTSxDQUFDLFdBQVc7QUFBQSxFQUNwQixDQUFDO0FBSUQsTUFBSSxDQUFDLGdCQUFnQixpQkFBaUIsOENBQThDO0FBQ2xGLFVBQU0sSUFBSSxNQUFNLHNTQUFzRDtBQUFBLEVBQ3hFO0FBQ0EsU0FBTyxFQUFFLGNBQWMsV0FBVyxZQUFZLEdBQUcsUUFBUSxNQUFNLGdCQUFnQixNQUFNO0FBQ3ZGO0FBR08sU0FBUyxlQUE2QjtBQUMzQyxNQUFJLENBQUMsY0FBYztBQUNqQixtQkFBZSxtQkFBbUIsRUFBRSxPQUFPLGVBQWUsV0FBVyxhQUFhLENBQUM7QUFBQSxFQUNyRjtBQUNBLFNBQU87QUFDVDtBQUVPLFNBQVMsbUJBQTRCO0FBQzFDLE1BQUksQ0FBQyxtQkFBb0IsT0FBTSxJQUFJLE1BQU0sMEZBQXlCO0FBQ2xFLFNBQU87QUFDVDtBQUVBLGVBQXNCLG1CQUFtQixPQUFpQztBQUN4RSxTQUFPLGFBQWEsRUFBRSxhQUFhO0FBQUEsSUFDakMsU0FBUyxpQkFBaUI7QUFBQSxJQUMxQixLQUFLO0FBQUEsSUFDTCxjQUFjO0FBQUEsSUFDZCxNQUFNLENBQUMsS0FBSztBQUFBLEVBQ2QsQ0FBQztBQUNIO0FBRUEsZUFBc0Isb0JBQW9CLE1BQXFCO0FBQzdELFNBQU8sYUFBYSxFQUFFLHNCQUFzQixFQUFFLEtBQUssQ0FBQztBQUN0RDtBQUVBLFNBQVMsZUFBZTtBQUN0QixRQUFNLE9BQU8sUUFBUSxJQUFJLHFCQUFxQixJQUFJLEtBQUs7QUFDdkQsTUFBSSxDQUFDLElBQUssT0FBTSxJQUFJLE1BQU0sc0NBQXVCO0FBS2pELFFBQU0sZ0JBQWdCLEtBQUssS0FBSyxHQUFHLEtBQUssQ0FBQyxJQUFJLFdBQVcsSUFBSTtBQUM1RCxNQUFJLGVBQWU7QUFDakIsVUFBTSxRQUFRLElBQUksTUFBTSxLQUFLLEVBQUU7QUFDL0IsUUFBSSxDQUFDLENBQUMsSUFBSSxJQUFJLElBQUksSUFBSSxFQUFFLEVBQUUsU0FBUyxLQUFLLEdBQUc7QUFDekMsWUFBTSxJQUFJLE1BQU0sNEZBQWdDO0FBQUEsSUFDbEQ7QUFDQSxXQUFPLGtCQUFrQixHQUFHO0FBQUEsRUFDOUI7QUFDQSxRQUFNLE1BQU8sSUFBSSxXQUFXLElBQUksSUFBSSxNQUFNLEtBQUssR0FBRztBQUNsRCxNQUFJLENBQUMsc0JBQXNCLEtBQUssR0FBRyxHQUFHO0FBQ3BDLFVBQU0sSUFBSSxNQUFNLG1JQUF3RDtBQUFBLEVBQzFFO0FBQ0EsU0FBTyxvQkFBb0IsR0FBRztBQUNoQztBQUVPLFNBQVMsb0JBQW9CO0FBQ2xDLFNBQU8sbUJBQW1CLEVBQUUsU0FBUyxhQUFhLEdBQUcsT0FBTyxlQUFlLFdBQVcsYUFBYSxDQUFDO0FBQ3RHO0FBRU8sU0FBUyxpQkFBMEI7QUFDeEMsU0FBTyxhQUFhLEVBQUU7QUFDeEI7QUFHQSxlQUFzQixvQkFBcUM7QUFDekQsU0FBTyxhQUFhLEVBQUUsV0FBVyxFQUFFLFNBQVMsZUFBZSxFQUFFLENBQUM7QUFDaEU7QUFhQSxlQUFzQixtQkFBa0M7QUFDdEQsUUFBTSxVQUFVLE1BQU0sa0JBQWtCO0FBQ3hDLE1BQUksVUFBVSxxQkFBcUI7QUFDakMsVUFBTSxJQUFJO0FBQUEsTUFDUiwyRUFBbUMsWUFBWSxPQUFPLENBQUM7QUFBQSxJQUN6RDtBQUFBLEVBQ0Y7QUFDRjtBQXVCQSxlQUFzQixlQUNwQixZQUNzRTtBQUN0RSxRQUFNLFNBQVMsV0FBVyxPQUFPLFVBQVUsRUFBRSxLQUFLLENBQUM7QUFDbkQsUUFBTSxVQUFVLE1BQU0sYUFBYSxFQUFFLFdBQVcsRUFBRSxTQUFTLE9BQU8sQ0FBQztBQUNuRSxNQUFJLFdBQVcsaUJBQWlCO0FBQzlCLFdBQU8sRUFBRSxXQUFXLE9BQU8sWUFBWSxRQUFRLFNBQVMsRUFBRTtBQUFBLEVBQzVEO0FBRUEsUUFBTSxpQkFBaUI7QUFDdkIsUUFBTSxRQUFRLHFCQUFxQjtBQUNuQyxRQUFNLE9BQU8sTUFBTTtBQUFBLElBQVksQ0FBQyxVQUM5QixrQkFBa0IsRUFBRSxnQkFBZ0I7QUFBQSxNQUNsQyxJQUFJO0FBQUEsTUFDSixPQUFPO0FBQUEsTUFDUCxPQUFPO0FBQUEsTUFDUDtBQUFBLElBQ0YsQ0FBQztBQUFBLEVBQ0g7QUFDQSxRQUFNLGNBQWMsSUFBSTtBQUN4QixRQUFNLFFBQVEsTUFBTSxhQUFhLEVBQUUsV0FBVyxFQUFFLFNBQVMsT0FBTyxDQUFDO0FBQ2pFLFNBQU8sRUFBRSxXQUFXLE1BQU0sWUFBWSxNQUFNLFNBQVMsR0FBRyxRQUFRLEtBQUs7QUFDdkU7QUFHQSxlQUFlLGNBQWMsT0FBNkQ7QUFDeEYsUUFBTSxVQUFVLGtCQUFrQixLQUFLO0FBQ3ZDLFFBQU0sU0FBUyxjQUFjLElBQUksT0FBTztBQUN4QyxNQUFJLFVBQVUsS0FBTSxRQUFPO0FBQzNCLFFBQU0sTUFBTSxVQUFVLFlBQVksUUFBUSxVQUFVLFlBQVksUUFBUTtBQUN4RSxNQUFJLFFBQVE7QUFDWixNQUFJO0FBQ0YsWUFBUSxPQUFPLE1BQU0sYUFBYSxFQUFFLGFBQWEsRUFBRSxTQUFTLEtBQUssY0FBYyxXQUFXLENBQUMsQ0FBQztBQUFBLEVBQzlGLFFBQVE7QUFDTixZQUFRO0FBQUEsRUFDVjtBQUNBLGdCQUFjLElBQUksU0FBUyxLQUFLO0FBQ2hDLFNBQU87QUFDVDtBQUtBLGVBQWUsY0FBYyxNQUFxQjtBQUNoRCxRQUFNLFVBQVUsTUFBTSxhQUFhLEVBQUUsMEJBQTBCLEVBQUUsTUFBTSxTQUFTLEtBQU8sQ0FBQztBQUN4RixNQUFJLFFBQVEsV0FBVyxVQUFXLE9BQU0sSUFBSSxNQUFNLDZEQUFxQixJQUFJLEVBQUU7QUFDN0UsU0FBTztBQUNUO0FBRUEsZUFBc0IsMEJBQ3BCLE1BQzJEO0FBQzNELE1BQUk7QUFDRixVQUFNLFVBQVUsTUFBTSxhQUFhLEVBQUUsc0JBQXNCLEVBQUUsS0FBSyxDQUFDO0FBQ25FLFdBQU8sUUFBUSxXQUFXLFlBQVksY0FBYztBQUFBLEVBQ3RELFFBQVE7QUFDTixRQUFJO0FBQ0YsWUFBTSxjQUFjLE1BQU0sYUFBYSxFQUFFLGVBQWUsRUFBRSxLQUFLLENBQUM7QUFDaEUsYUFBTyxjQUFjLFlBQVk7QUFBQSxJQUNuQyxRQUFRO0FBQ04sYUFBTztBQUFBLElBQ1Q7QUFBQSxFQUNGO0FBQ0Y7QUFFQSxlQUFzQix3QkFBd0IsTUFBc0M7QUFDbEYsU0FBTyxjQUFjLElBQUk7QUFDM0I7QUFVQSxlQUFlLFlBQVksT0FBMEU7QUFDbkcsU0FBTyxtQkFBbUIsWUFBWTtBQUNwQyxVQUFNLFFBQVEsTUFBTSxhQUFhLEVBQUUsb0JBQW9CO0FBQUEsTUFDckQsU0FBUyxlQUFlO0FBQUEsTUFDeEIsVUFBVTtBQUFBLElBQ1osQ0FBQztBQUNELFdBQU8sTUFBTSxLQUFLO0FBQUEsRUFDcEIsQ0FBQztBQUNIO0FBT0EsZUFBZSx3QkFBd0IsT0FBOEIsYUFBb0M7QUFDdkcsUUFBTSxlQUFlLGtCQUFrQixLQUFLO0FBQzVDLFFBQU0sTUFBTSxVQUFVLFlBQVksUUFBUTtBQUMxQyxRQUFNLFVBQVcsTUFBTSxhQUFhLEVBQUUsYUFBYTtBQUFBLElBQ2pELFNBQVM7QUFBQSxJQUNUO0FBQUEsSUFDQSxjQUFjO0FBQUEsSUFDZCxNQUFNLENBQUMsZUFBZSxDQUFDO0FBQUEsRUFDekIsQ0FBQztBQUNELFFBQU0sUUFBUSxVQUFVLFlBQVksT0FBTztBQUMzQyxNQUFJLFVBQVUsYUFBYTtBQUN6QixVQUFNLElBQUksTUFBTSw0QkFBYSxLQUFLLDJHQUEyQixLQUFLLCtEQUFhO0FBQUEsRUFDakY7QUFDRjtBQU9BLGVBQWUsc0JBQ2IsT0FDQSxJQUNBLFFBQ0EsYUFDQTtBQUNBLFFBQU0saUJBQWlCO0FBQ3ZCLFFBQU0sV0FBVyxNQUFNLGNBQWMsS0FBSztBQUMxQyxRQUFNLGNBQWMsV0FBVyxPQUFPLFFBQVEsUUFBUSxHQUFHLFFBQVE7QUFDakUsUUFBTSx3QkFBd0IsT0FBTyxXQUFXO0FBQ2hELFFBQU0sTUFBTSxVQUFVLFlBQVksUUFBUTtBQUMxQyxRQUFNLE9BQU8sTUFBTTtBQUFBLElBQVksQ0FBQyxVQUM5QixrQkFBa0IsRUFBRSxjQUFjO0FBQUEsTUFDaEMsU0FBUyxrQkFBa0IsS0FBSztBQUFBLE1BQ2hDO0FBQUEsTUFDQSxjQUFjO0FBQUEsTUFDZCxNQUFNLENBQUMsV0FBVyxFQUFFLEdBQUcsV0FBVztBQUFBLE1BQ2xDLE9BQU87QUFBQSxNQUNQO0FBQUEsSUFDRixDQUFDO0FBQUEsRUFDSDtBQUNBLFFBQU0sY0FBYyxJQUFJO0FBQ3hCLFNBQU8sY0FBYyxJQUFJO0FBQzNCO0FBR0EsZUFBc0IsT0FBTyxJQUFhLFFBQWdCO0FBQ3hELFNBQU8sc0JBQXNCLFdBQVcsSUFBSSxNQUFNO0FBQ3BEO0FBWUEsZUFBc0IsZUFBZSxNQUFlLFFBQWdCLEtBQWMsa0JBQWtCLFdBQVc7QUFDN0csTUFBSSxVQUFVLEVBQUcsUUFBTztBQUN4QixRQUFNLGlCQUFpQjtBQUN2QixRQUFNLFdBQVcsTUFBTSxjQUFjLFNBQVM7QUFDOUMsUUFBTSxjQUFjLFdBQVcsT0FBTyxRQUFRLFFBQVEsR0FBRyxRQUFRO0FBQ2pFLFFBQU0sT0FBTyxNQUFNO0FBQUEsSUFBWSxDQUFDLFVBQzlCLGtCQUFrQixFQUFFLGNBQWM7QUFBQSxNQUNoQyxTQUFTLGtCQUFrQjtBQUFBLE1BQzNCLEtBQUs7QUFBQSxNQUNMLGNBQWM7QUFBQSxNQUNkLE1BQU0sQ0FBQyxXQUFXLElBQUksR0FBRyxXQUFXLEVBQUUsR0FBRyxXQUFXO0FBQUEsTUFDcEQsT0FBTztBQUFBLE1BQ1A7QUFBQSxJQUNGLENBQUM7QUFBQSxFQUNIO0FBQ0EsU0FBTyxjQUFjLElBQUk7QUFDM0I7QUFHQSxlQUFzQixrQkFBa0IsUUFBa0M7QUFDeEUsUUFBTSxDQUFDLEtBQUssUUFBUSxJQUFJLE1BQU0sUUFBUSxJQUFJO0FBQUEsSUFDeEMsYUFBYSxFQUFFLGFBQWEsRUFBRSxTQUFTLGtCQUFrQixTQUFTLEtBQUssT0FBTyxjQUFjLGFBQWEsTUFBTSxDQUFDLE1BQU0sRUFBRSxDQUFDO0FBQUEsSUFDekgsY0FBYyxTQUFTO0FBQUEsRUFDekIsQ0FBQztBQUNELFNBQU8sT0FBTyxZQUFZLEtBQWUsUUFBUSxDQUFDO0FBQ3BEO0FBMkJBLGVBQXNCLGdCQUFnQixPQUE4QixJQUFhLFFBQWdCO0FBQy9GLFFBQU0saUJBQWlCO0FBQ3ZCLFFBQU0sV0FBVyxNQUFNLGNBQWMsS0FBSztBQUMxQyxRQUFNLGNBQWMsV0FBVyxPQUFPLFFBQVEsUUFBUSxHQUFHLFFBQVE7QUFDakUsUUFBTSxPQUFPLE1BQU07QUFBQSxJQUFZLENBQUMsVUFDOUIsa0JBQWtCLEVBQUUsY0FBYztBQUFBLE1BQ2hDLFNBQVMsa0JBQWtCLEtBQUs7QUFBQSxNQUNoQyxLQUFLO0FBQUEsTUFDTCxjQUFjO0FBQUEsTUFDZCxNQUFNLENBQUMsV0FBVyxFQUFFLEdBQUcsV0FBVztBQUFBLE1BQ2xDLE9BQU87QUFBQSxNQUNQO0FBQUEsSUFDRixDQUFDO0FBQUEsRUFDSDtBQUNBLFNBQU8sY0FBYyxJQUFJO0FBQzNCO0FBR0EsZUFBc0IsbUJBQW1CLE9BQTRCLFFBQWdCLGlCQUEyQjtBQUM5RyxNQUFJLENBQUMsT0FBTyxTQUFTLE1BQU0sS0FBSyxVQUFVLEVBQUcsT0FBTSxJQUFJLE1BQU0sb0RBQVk7QUFDekUsUUFBTSxpQkFBaUI7QUFFdkIsTUFBSSxVQUFVLE9BQU87QUFDbkIsUUFBSSxDQUFDLGdCQUFpQixPQUFNLElBQUksTUFBTSw2RkFBNEI7QUFDbEUsVUFBTSxXQUFXLFdBQVcsZUFBZTtBQUMzQyxVQUFNLGlCQUFpQixrQkFBa0I7QUFDekMsVUFBTSxpQkFBaUIsTUFBTSxhQUFhLEVBQUUsYUFBYSxFQUFFLFNBQVMsZ0JBQWdCLEtBQUssZUFBZSxjQUFjLGtCQUFrQixNQUFNLENBQUMsUUFBUSxFQUFFLENBQUM7QUFDMUosUUFBSSxDQUFDLGVBQWdCLE9BQU0sSUFBSSxNQUFNLG1HQUE2QjtBQUNsRSxVQUFNQyxnQkFBZSxNQUFNLGFBQWEsRUFBRSxhQUFhLEVBQUUsU0FBUyxnQkFBZ0IsS0FBSyxlQUFlLGNBQWMsWUFBWSxDQUFDO0FBQ2pJLFVBQU1DLFlBQVcsTUFBTSxtQkFBbUIsUUFBUTtBQUNsRCxVQUFNQyxlQUFjLFdBQVcsT0FBTyxRQUFRRCxTQUFRLEdBQUdBLFNBQVE7QUFDakUsVUFBTUUsV0FBVSxNQUFNLGFBQWEsRUFBRSxhQUFhLEVBQUUsU0FBUyxVQUFVLEtBQUssZUFBZSxjQUFjLGFBQWEsTUFBTSxDQUFDSCxhQUFZLEVBQUUsQ0FBQztBQUM1SSxRQUFJRyxXQUFVRCxhQUFhLE9BQU0sSUFBSSxNQUFNLDRHQUE0QjtBQUN2RSxVQUFNLGFBQWEsRUFBRSxpQkFBaUIsRUFBRSxTQUFTLGVBQWUsR0FBRyxTQUFTLGdCQUFnQixLQUFLLGVBQWUsY0FBYyxzQkFBc0IsTUFBTSxDQUFDLFVBQVVBLFlBQVcsRUFBRSxDQUFDO0FBQ25MLFVBQU1FLFFBQU8sTUFBTTtBQUFBLE1BQVksQ0FBQyxVQUM5QixrQkFBa0IsRUFBRSxjQUFjLEVBQUUsU0FBUyxnQkFBZ0IsS0FBSyxlQUFlLGNBQWMsc0JBQXNCLE1BQU0sQ0FBQyxVQUFVRixZQUFXLEdBQUcsT0FBTyxlQUFlLE1BQU0sQ0FBQztBQUFBLElBQ25MO0FBQ0EsV0FBTyxjQUFjRSxLQUFJO0FBQUEsRUFDM0I7QUFFQSxRQUFNLFdBQVcsVUFBVSxPQUFPLFlBQVk7QUFDOUMsUUFBTSxrQkFBa0Isa0JBQWtCLFFBQVE7QUFDbEQsUUFBTSxlQUFlLGtCQUFrQjtBQUN2QyxRQUFNLFdBQVcsTUFBTSxjQUFjLFFBQVE7QUFDN0MsUUFBTSxjQUFjLFdBQVcsT0FBTyxRQUFRLFFBQVEsR0FBRyxRQUFRO0FBQ2pFLFFBQU0sVUFBVSxNQUFNLGFBQWEsRUFBRSxhQUFhLEVBQUUsU0FBUyxpQkFBaUIsS0FBSyxpQkFBaUIsY0FBYyxhQUFhLE1BQU0sQ0FBQyxZQUFZLEVBQUUsQ0FBQztBQUNySixNQUFJLFVBQVUsWUFBYSxPQUFNLElBQUksTUFBTSwyQkFBWSxNQUFNLFlBQVksQ0FBQyx1RkFBaUI7QUFDM0YsUUFBTSxhQUFhLEVBQUUsaUJBQWlCLEVBQUUsU0FBUyxlQUFlLEdBQUcsU0FBUyxpQkFBaUIsS0FBSyxhQUFhLGNBQWMsc0JBQXNCLE1BQU0sQ0FBQyxXQUFXLEVBQUUsQ0FBQztBQUN4SyxRQUFNLE9BQU8sTUFBTTtBQUFBLElBQVksQ0FBQyxVQUM5QixrQkFBa0IsRUFBRSxjQUFjLEVBQUUsU0FBUyxpQkFBaUIsS0FBSyxhQUFhLGNBQWMsc0JBQXNCLE1BQU0sQ0FBQyxXQUFXLEdBQUcsT0FBTyxlQUFlLE1BQU0sQ0FBQztBQUFBLEVBQ3hLO0FBQ0EsU0FBTyxjQUFjLElBQUk7QUFDM0I7QUFPQSxlQUFzQixxQkFBcUIsT0FLaEI7QUFDekIsUUFBTSxpQkFBaUI7QUFDdkIsUUFBTSxRQUFRLFdBQVcsTUFBTSxZQUFZO0FBQzNDLFFBQU0sV0FBVyxPQUFPLE1BQU0sYUFBYSxFQUFFLGFBQWE7QUFBQSxJQUN4RCxTQUFTO0FBQUEsSUFDVCxLQUFLO0FBQUEsSUFDTCxjQUFjO0FBQUEsRUFDaEIsQ0FBQyxDQUFDO0FBQ0YsTUFBSSxDQUFDLE9BQU8sVUFBVSxRQUFRLEtBQUssV0FBVyxLQUFLLFdBQVcsSUFBSTtBQUNoRSxVQUFNLElBQUksTUFBTSxHQUFHLE1BQU0sS0FBSywyRUFBZTtBQUFBLEVBQy9DO0FBRUEsTUFBSTtBQUNKLE1BQUk7QUFDRixrQkFBYyxXQUFXLE1BQU0sUUFBUSxRQUFRO0FBQUEsRUFDakQsUUFBUTtBQUNOLFVBQU0sSUFBSSxNQUFNLEdBQUcsTUFBTSxLQUFLLGlGQUFnQjtBQUFBLEVBQ2hEO0FBQ0EsTUFBSSxlQUFlLEdBQUksT0FBTSxJQUFJLE1BQU0sb0RBQVk7QUFFbkQsUUFBTSxVQUFXLE1BQU0sYUFBYSxFQUFFLGFBQWE7QUFBQSxJQUNqRCxTQUFTO0FBQUEsSUFDVCxLQUFLO0FBQUEsSUFDTCxjQUFjO0FBQUEsSUFDZCxNQUFNLENBQUMsZUFBZSxDQUFDO0FBQUEsRUFDekIsQ0FBQztBQUNELE1BQUksVUFBVSxhQUFhO0FBQ3pCLFVBQU0sSUFBSSxNQUFNLDRCQUFhLE1BQU0sS0FBSyxpRkFBZ0I7QUFBQSxFQUMxRDtBQUVBLFNBQU87QUFBQSxJQUFZLENBQUMsVUFDbEIsa0JBQWtCLEVBQUUsY0FBYztBQUFBLE1BQ2hDLFNBQVM7QUFBQSxNQUNULEtBQUs7QUFBQSxNQUNMLGNBQWM7QUFBQSxNQUNkLE1BQU0sQ0FBQyxXQUFXLE1BQU0sU0FBUyxHQUFHLFdBQVc7QUFBQSxNQUMvQyxPQUFPO0FBQUEsTUFDUDtBQUFBLElBQ0YsQ0FBQztBQUFBLEVBQ0g7QUFDRjtBQUdBLGVBQXNCLHdCQUF3QixNQUF1QztBQUNuRixRQUFNLFVBQVUsTUFBTSxhQUFhLEVBQUUsMEJBQTBCLEVBQUUsTUFBTSxTQUFTLElBQU8sQ0FBQztBQUN4RixTQUFPLFFBQVEsV0FBVztBQUM1QjtBQUdBLGVBQXNCLHlCQUF5QixjQUFzQixPQUFnQjtBQUNuRixRQUFNLFFBQVEsV0FBVyxZQUFZO0FBQ3JDLFFBQU0sV0FBVztBQUFBLElBQ2YsTUFBTSxhQUFhLEVBQUUsYUFBYTtBQUFBLE1BQ2hDLFNBQVM7QUFBQSxNQUNULEtBQUs7QUFBQSxNQUNMLGNBQWM7QUFBQSxJQUNoQixDQUFDO0FBQUEsRUFDSDtBQUNBLE1BQUksQ0FBQyxPQUFPLFVBQVUsUUFBUSxLQUFLLFdBQVcsS0FBSyxXQUFXLElBQUk7QUFDaEUsVUFBTSxJQUFJLE1BQU0sa0dBQWtCO0FBQUEsRUFDcEM7QUFDQSxRQUFNLENBQUMsU0FBUyxTQUFTLElBQUssTUFBTSxRQUFRLElBQUk7QUFBQSxJQUM5QyxhQUFhLEVBQUUsYUFBYTtBQUFBLE1BQzFCLFNBQVM7QUFBQSxNQUNULEtBQUs7QUFBQSxNQUNMLGNBQWM7QUFBQSxNQUNkLE1BQU0sQ0FBQyxXQUFXLEtBQUssQ0FBQztBQUFBLElBQzFCLENBQUM7QUFBQSxJQUNELGFBQWEsRUFBRSxhQUFhO0FBQUEsTUFDMUIsU0FBUztBQUFBLE1BQ1QsS0FBSztBQUFBLE1BQ0wsY0FBYztBQUFBLE1BQ2QsTUFBTSxDQUFDLFdBQVcsS0FBSyxHQUFHLGVBQWUsQ0FBQztBQUFBLElBQzVDLENBQUM7QUFBQSxFQUNILENBQUM7QUFDRCxTQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0EsU0FBUyxZQUFZLFNBQVMsUUFBUTtBQUFBLElBQ3RDLFdBQVcsWUFBWSxXQUFXLFFBQVE7QUFBQSxFQUM1QztBQUNGO0FBTUEsZUFBc0Isc0JBQXNCLE9BS2pCO0FBQ3pCLFFBQU0saUJBQWlCO0FBQ3ZCLFFBQU0sUUFBUSxXQUFXLE1BQU0sWUFBWTtBQUMzQyxRQUFNLFFBQVEsV0FBVyxNQUFNLEtBQUs7QUFDcEMsUUFBTSxXQUFXO0FBQUEsSUFDZixNQUFNLGFBQWEsRUFBRSxhQUFhO0FBQUEsTUFDaEMsU0FBUztBQUFBLE1BQ1QsS0FBSztBQUFBLE1BQ0wsY0FBYztBQUFBLElBQ2hCLENBQUM7QUFBQSxFQUNIO0FBQ0EsTUFBSSxDQUFDLE9BQU8sVUFBVSxRQUFRLEtBQUssV0FBVyxLQUFLLFdBQVcsSUFBSTtBQUNoRSxVQUFNLElBQUksTUFBTSxHQUFHLE1BQU0sS0FBSywyRUFBZTtBQUFBLEVBQy9DO0FBQ0EsTUFBSTtBQUNKLE1BQUk7QUFDRixrQkFBYyxXQUFXLE1BQU0sUUFBUSxRQUFRO0FBQUEsRUFDakQsUUFBUTtBQUNOLFVBQU0sSUFBSSxNQUFNLEdBQUcsTUFBTSxLQUFLLGlGQUFnQjtBQUFBLEVBQ2hEO0FBQ0EsTUFBSSxlQUFlLEdBQUksT0FBTSxJQUFJLE1BQU0sb0RBQVk7QUFFbkQsUUFBTSxDQUFDLFdBQVcsT0FBTyxJQUFLLE1BQU0sUUFBUSxJQUFJO0FBQUEsSUFDOUMsYUFBYSxFQUFFLGFBQWE7QUFBQSxNQUMxQixTQUFTO0FBQUEsTUFDVCxLQUFLO0FBQUEsTUFDTCxjQUFjO0FBQUEsTUFDZCxNQUFNLENBQUMsT0FBTyxlQUFlLENBQUM7QUFBQSxJQUNoQyxDQUFDO0FBQUEsSUFDRCxhQUFhLEVBQUUsYUFBYTtBQUFBLE1BQzFCLFNBQVM7QUFBQSxNQUNULEtBQUs7QUFBQSxNQUNMLGNBQWM7QUFBQSxNQUNkLE1BQU0sQ0FBQyxLQUFLO0FBQUEsSUFDZCxDQUFDO0FBQUEsRUFDSCxDQUFDO0FBQ0QsTUFBSSxZQUFZLGFBQWE7QUFDM0IsVUFBTSxJQUFJLE1BQU0sR0FBRyxNQUFNLEtBQUsseUpBQTRCO0FBQUEsRUFDNUQ7QUFDQSxNQUFJLFVBQVUsYUFBYTtBQUN6QixVQUFNLElBQUksTUFBTSxHQUFHLE1BQU0sS0FBSyxpSUFBd0I7QUFBQSxFQUN4RDtBQUVBLFNBQU87QUFBQSxJQUFZLENBQUMsVUFDbEIsa0JBQWtCLEVBQUUsY0FBYztBQUFBLE1BQ2hDLFNBQVM7QUFBQSxNQUNULEtBQUs7QUFBQSxNQUNMLGNBQWM7QUFBQSxNQUNkLE1BQU0sQ0FBQyxPQUFPLGVBQWUsR0FBRyxXQUFXO0FBQUEsTUFDM0MsT0FBTztBQUFBLE1BQ1A7QUFBQSxJQUNGLENBQUM7QUFBQSxFQUNIO0FBQ0Y7QUFHQSxlQUFzQix5QkFBeUIsTUFBdUM7QUFDcEYsUUFBTSxVQUFVLE1BQU0sYUFBYSxFQUFFLDBCQUEwQixFQUFFLE1BQU0sU0FBUyxJQUFPLENBQUM7QUFDeEYsU0FBTyxRQUFRLFdBQVc7QUFDNUI7QUFHQSxlQUFzQixrQ0FDcEIsTUFDNkM7QUFDN0MsTUFBSTtBQUNGLFVBQU0sVUFBVSxNQUFNLGFBQWEsRUFBRSxzQkFBc0IsRUFBRSxLQUFLLENBQUM7QUFDbkUsV0FBTyxRQUFRLFdBQVcsWUFBWSxjQUFjO0FBQUEsRUFDdEQsUUFBUTtBQUNOLFdBQU87QUFBQSxFQUNUO0FBQ0Y7QUFnQkEsZUFBc0IsZUFDcEIsTUFDQSxVQUNBLGFBQ2lCO0FBQ2pCLFFBQU0sV0FBVyxNQUFNLGNBQWMsU0FBUztBQUM5QyxTQUFPLHFCQUFxQjtBQUFBLElBQzFCLE9BQU8sa0JBQWtCO0FBQUEsSUFDekI7QUFBQSxJQUNBLElBQUksZUFBZTtBQUFBLElBQ25CLGFBQWEsV0FBVyxTQUFTLFFBQVEsUUFBUSxHQUFHLFFBQVE7QUFBQSxJQUM1RCxnQkFDRTtBQUFBLElBQ0YsZUFDRTtBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFDSDtBQU9BLGVBQXNCLFlBQ3BCLElBQ0EsVUFDQSxhQUN3QjtBQUN4QixNQUFJLEVBQUUsV0FBVyxHQUFJLFFBQU87QUFDNUIsUUFBTSxpQkFBaUI7QUFDdkIsUUFBTSxXQUFXLE1BQU0sY0FBYyxTQUFTO0FBQzlDLFFBQU0sY0FBYyxXQUFXLFNBQVMsUUFBUSxRQUFRLEdBQUcsUUFBUTtBQUNuRSxRQUFNLHdCQUF3QixXQUFXLFdBQVc7QUFDcEQsUUFBTSxPQUFPLE1BQU07QUFBQSxJQUFZLENBQUMsVUFDOUIsa0JBQWtCLEVBQUUsY0FBYztBQUFBLE1BQ2hDLFNBQVMsa0JBQWtCO0FBQUEsTUFDM0IsS0FBSztBQUFBLE1BQ0wsY0FBYztBQUFBLE1BQ2QsTUFBTSxDQUFDLFdBQVcsRUFBRSxHQUFHLFdBQVc7QUFBQSxNQUNsQyxPQUFPO0FBQUEsTUFDUDtBQUFBLElBQ0YsQ0FBQztBQUFBLEVBQ0g7QUFDQSxRQUFNLGNBQWMsSUFBSTtBQUN4QixTQUFPLGNBQWMsSUFBSTtBQUMzQjtBQUdBLGVBQXNCLGNBQ3BCLFVBQ0EsYUFDd0I7QUFDeEIsU0FBTyxZQUFZLGtCQUFrQixXQUFXLFVBQVUsV0FBVztBQUN2RTtBQUlFLGVBQWUsZUFBZ0M7QUFDL0MsTUFBSSxrQkFBa0IsU0FBUyxLQUFNLFFBQU8sa0JBQWtCO0FBQzlELE1BQUksUUFBUTtBQUNaLE1BQUk7QUFDSixZQUFRO0FBQUEsTUFDUixNQUFNLGFBQWEsRUFBRSxhQUFhLEVBQUUsU0FBUyxrQkFBa0IsTUFBTSxLQUFLLGlCQUFpQixjQUFjLFdBQVcsQ0FBQztBQUFBLElBQ3JIO0FBQUEsRUFDQSxRQUFRO0FBQ1IsWUFBUTtBQUFBLEVBQ1I7QUFDQSxvQkFBa0IsUUFBUTtBQUMxQixTQUFPO0FBQ1A7QUFTQSxlQUFzQixjQUFjLElBQWEsWUFBNEM7QUFDN0YsTUFBSSxFQUFFLGFBQWEsR0FBSSxRQUFPO0FBQzlCLFFBQU0saUJBQWlCO0FBQ3ZCLFFBQU0sV0FBVyxNQUFNLGFBQWE7QUFDcEMsUUFBTSxjQUFjLFdBQVcsV0FBVyxRQUFRLFFBQVEsR0FBRyxRQUFRO0FBQ3JFLFFBQU0sVUFBVyxNQUFNLGFBQWEsRUFBRSxhQUFhO0FBQUEsSUFDbkQsU0FBUyxrQkFBa0I7QUFBQSxJQUMzQixLQUFLO0FBQUEsSUFDTCxjQUFjO0FBQUEsSUFDZCxNQUFNLENBQUMsZUFBZSxDQUFDO0FBQUEsRUFDdkIsQ0FBQztBQUNELE1BQUksVUFBVSxhQUFhO0FBQzNCLFVBQU0sSUFBSTtBQUFBLE1BQ1YsNEVBQTBCLFlBQVksU0FBUyxRQUFRLENBQUMsMkJBQVksWUFBWSxhQUFhLFFBQVEsQ0FBQztBQUFBLElBQ3RHO0FBQUEsRUFDQTtBQUNBLFFBQU0sT0FBTyxNQUFNO0FBQUEsSUFBWSxDQUFDLFVBQ2hDLGtCQUFrQixFQUFFLGNBQWM7QUFBQSxNQUNsQyxTQUFTLGtCQUFrQjtBQUFBLE1BQzNCLEtBQUs7QUFBQSxNQUNMLGNBQWM7QUFBQSxNQUNkLE1BQU0sQ0FBQyxXQUFXLEVBQUUsR0FBRyxXQUFXO0FBQUEsTUFDbEMsT0FBTztBQUFBLE1BQ1A7QUFBQSxJQUNBLENBQUM7QUFBQSxFQUNEO0FBQ0EsU0FBTyxjQUFjLElBQUk7QUFDekI7QUFhRixlQUFzQixpQkFDcEIsTUFDQSxVQUNBLGFBQ3dCO0FBQ3hCLFNBQU8sVUFBVSxNQUFNLGtCQUFrQixXQUFXLFVBQVU7QUFBQSxJQUM1RCxnQkFDRTtBQUFBLElBQ0YsZUFBZTtBQUFBLEVBQ2pCLEdBQUcsV0FBVztBQUNoQjtBQVdBLGVBQXNCLFVBQ3BCLE1BQ0EsSUFDQSxVQUNBLE1BQ0EsYUFDd0I7QUFDeEIsTUFBSSxFQUFFLFdBQVcsR0FBSSxRQUFPO0FBQzVCLFFBQU0sV0FBVyxNQUFNLGNBQWMsU0FBUztBQUM5QyxTQUFPLHFCQUFxQjtBQUFBLElBQzFCLE9BQU8sa0JBQWtCO0FBQUEsSUFDekI7QUFBQSxJQUNBO0FBQUEsSUFDQSxhQUFhLFdBQVcsU0FBUyxRQUFRLFFBQVEsR0FBRyxRQUFRO0FBQUEsSUFDNUQsZ0JBQ0UsTUFBTSxrQkFDTjtBQUFBLElBQ0YsZUFBZSxNQUFNLGlCQUFpQjtBQUFBLElBQ3RDO0FBQUEsRUFDRixDQUFDO0FBQ0g7QUFPQSxlQUFlLHFCQUFxQixRQVFoQjtBQUNsQixRQUFNLEVBQUUsT0FBTyxNQUFNLElBQUksYUFBYSxnQkFBZ0IsZUFBZSxZQUFZLElBQUk7QUFDckYsUUFBTSxpQkFBaUI7QUFDdkIsUUFBTSxRQUFRLFdBQVcsSUFBSTtBQUM3QixRQUFNLFVBQVUsZUFBZTtBQUMvQixRQUFNLENBQUMsV0FBVyxPQUFPLElBQUssTUFBTSxRQUFRLElBQUk7QUFBQSxJQUM5QyxhQUFhLEVBQUUsYUFBYSxFQUFFLFNBQVMsT0FBTyxLQUFLLGlCQUFpQixjQUFjLGFBQWEsTUFBTSxDQUFDLE9BQU8sT0FBTyxFQUFFLENBQUM7QUFBQSxJQUN2SCxhQUFhLEVBQUUsYUFBYSxFQUFFLFNBQVMsT0FBTyxLQUFLLGlCQUFpQixjQUFjLGFBQWEsTUFBTSxDQUFDLEtBQUssRUFBRSxDQUFDO0FBQUEsRUFDaEgsQ0FBQztBQUNELE1BQUksWUFBWSxZQUFhLE9BQU0sSUFBSSxNQUFNLGNBQWM7QUFDM0QsTUFBSSxVQUFVLFlBQWEsT0FBTSxJQUFJLE1BQU0sYUFBYTtBQUN4RCxRQUFNLE9BQU8sTUFBTTtBQUFBLElBQVksQ0FBQyxVQUM5QixrQkFBa0IsRUFBRSxjQUFjO0FBQUEsTUFDaEMsU0FBUztBQUFBLE1BQ1QsS0FBSztBQUFBLE1BQ0wsY0FBYztBQUFBLE1BQ2QsTUFBTSxDQUFDLE9BQU8sV0FBVyxFQUFFLEdBQUcsV0FBVztBQUFBLE1BQ3pDLE9BQU87QUFBQSxNQUNQO0FBQUEsSUFDRixDQUFDO0FBQUEsRUFDSDtBQUNBLFFBQU0sY0FBYyxJQUFJO0FBQ3hCLFNBQU8sY0FBYyxJQUFJO0FBQzNCO0FBUUEsZUFBZSwyQkFDYixPQUNBLElBQ0EsUUFDQSxhQUNBO0FBQ0EsUUFBTSxpQkFBaUI7QUFDdkIsUUFBTSxXQUFXLE1BQU0sbUJBQW1CLEtBQUs7QUFDL0MsUUFBTSxjQUFjLFdBQVcsT0FBTyxNQUFNLEdBQUcsUUFBUTtBQUN2RCxRQUFNLFVBQVcsTUFBTSxhQUFhLEVBQUUsYUFBYTtBQUFBLElBQ2pELFNBQVM7QUFBQSxJQUNULEtBQUs7QUFBQSxJQUNMLGNBQWM7QUFBQSxJQUNkLE1BQU0sQ0FBQyxlQUFlLENBQUM7QUFBQSxFQUN6QixDQUFDO0FBQ0QsTUFBSSxVQUFVLGFBQWE7QUFDekIsVUFBTSxJQUFJO0FBQUEsTUFDUixxRUFBd0IsS0FBSyxtSkFBZ0MsZUFBZSxDQUFDO0FBQUEsSUFDL0U7QUFBQSxFQUNGO0FBQ0EsUUFBTSxPQUFPLE1BQU07QUFBQSxJQUFZLENBQUMsVUFDOUIsa0JBQWtCLEVBQUUsY0FBYztBQUFBLE1BQ2hDLFNBQVM7QUFBQSxNQUNULEtBQUs7QUFBQSxNQUNMLGNBQWM7QUFBQSxNQUNkLE1BQU0sQ0FBQyxXQUFXLEVBQUUsR0FBRyxXQUFXO0FBQUEsTUFDbEMsT0FBTztBQUFBLE1BQ1A7QUFBQSxJQUNGLENBQUM7QUFBQSxFQUNIO0FBQ0EsUUFBTSxjQUFjLElBQUk7QUFDeEIsU0FBTyxjQUFjLElBQUk7QUFDM0I7QUFvQkEsZUFBc0Isb0JBQ3BCLE9BQ0EsVUFDQSxZQUNBLGNBQ0EsYUFDQTtBQUNBLE1BQUksQ0FBQyxjQUFjO0FBQ2pCLFVBQU0sSUFBSTtBQUFBLE1BQ1I7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNBLFNBQU8sMkJBQTJCLGNBQWMsT0FBTyxVQUFVLFdBQVc7QUFDOUU7QUFFQSxlQUFzQix3QkFDcEIsT0FDQSxPQUNBLFFBQ0EsV0FDQSxjQUN3QjtBQUN4QixRQUFNLFlBQVksTUFBTSxhQUFhLEVBQUUsc0JBQXNCLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFDaEYsUUFBTSxXQUFXLGVBQWUsTUFBTSxtQkFBbUIsS0FBSyxJQUFJLE1BQU0sY0FBYyxTQUFTO0FBQy9GLFFBQU0sY0FBYyxXQUFXLE9BQU8sTUFBTSxHQUFHLFFBQVE7QUFDdkQsUUFBTSxPQUFPLE1BQU0sYUFBYSxFQUFFLFFBQVE7QUFBQSxJQUN4QyxTQUFTO0FBQUEsSUFDVCxPQUFPO0FBQUEsSUFDUCxNQUFNLEVBQUUsTUFBTSxlQUFlLEdBQUcsSUFBSSxXQUFXLEtBQUssRUFBRTtBQUFBLElBQ3RELFdBQVcsVUFBVTtBQUFBLElBQ3JCLFNBQVM7QUFBQSxFQUNYLENBQUM7QUFDRCxRQUFNLFVBQVUsS0FBSyxPQUFPLENBQUMsUUFBUTtBQUNuQyxRQUFJLElBQUksS0FBSyxVQUFVLGVBQWUsSUFBSSxlQUFlLEtBQU0sUUFBTztBQUN0RSxRQUFJLElBQUksY0FBYyxVQUFVLFlBQWEsUUFBTztBQUNwRCxXQUFPLElBQUksb0JBQW9CLFFBQVEsSUFBSSxtQkFBbUIsVUFBVTtBQUFBLEVBQzFFLENBQUM7QUFDRCxNQUFJLFFBQVEsU0FBUyxHQUFHO0FBQ3RCLFVBQU0sSUFBSSxNQUFNLDRPQUF5QztBQUFBLEVBQzNEO0FBQ0EsU0FBTyxRQUFRLENBQUMsR0FBRyxtQkFBbUI7QUFDeEM7QUFnQkEsZUFBc0Isc0JBQ3BCLE9BQ0EsU0FDQSxhQUNBO0FBQ0EsU0FBTyxzQkFBc0IsV0FBVyxPQUFPLFNBQVMsV0FBVztBQUNyRTtBQVlBLGVBQWUsa0JBQWtCLGNBQWtGO0FBQ2pILE1BQUk7QUFDRixVQUFNLFFBQVEsTUFBTSxhQUFhLEVBQUUsYUFBYTtBQUFBLE1BQzlDLFNBQVMsa0JBQWtCO0FBQUEsTUFDM0IsS0FBSztBQUFBLE1BQ0w7QUFBQSxJQUNGLENBQUM7QUFDRCxXQUFPLFdBQVcsS0FBZ0I7QUFBQSxFQUNwQyxRQUFRO0FBQ04sV0FBTztBQUFBLEVBQ1Q7QUFDRjtBQWdCQSxlQUFzQixtQkFBd0M7QUFDNUQsUUFBTSxpQkFBaUI7QUFDdkIsUUFBTSxVQUFzQixFQUFFLGNBQWMsV0FBVyxRQUFRLFVBQVU7QUFHekUsUUFBTSxhQUFhLE1BQU0sa0JBQWtCLHNCQUFzQjtBQUNqRSxNQUFJLGNBQWMsZUFBZSxrQkFBa0IsZ0JBQWdCO0FBQ2pFLFlBQVEsZUFBZTtBQUFBLEVBQ3pCLE9BQU87QUFDTCxVQUFNLE9BQU8sTUFBTTtBQUFBLE1BQVksQ0FBQyxVQUM5QixrQkFBa0IsRUFBRSxjQUFjO0FBQUEsUUFDaEMsU0FBUyxrQkFBa0I7QUFBQSxRQUMzQixLQUFLO0FBQUEsUUFDTCxjQUFjO0FBQUEsUUFDZCxNQUFNLENBQUMsa0JBQWtCLGNBQWM7QUFBQSxRQUN2QyxPQUFPO0FBQUEsUUFDUDtBQUFBLE1BQ0YsQ0FBQztBQUFBLElBQ0g7QUFDQSxZQUFRLGVBQWUsTUFBTSxjQUFjLElBQUk7QUFBQSxFQUNqRDtBQUdBLFFBQU0sZ0JBQWdCLE1BQU0sa0JBQWtCLGdCQUFnQjtBQUM5RCxNQUFJLGlCQUFpQixrQkFBa0Isa0JBQWtCLG9CQUFvQjtBQUMzRSxZQUFRLFNBQVM7QUFDakIsV0FBTztBQUFBLEVBQ1Q7QUFDQSxNQUFJO0FBRUYsVUFBTSxhQUFhLEVBQUUsaUJBQWlCO0FBQUEsTUFDcEMsU0FBUyxlQUFlO0FBQUEsTUFDeEIsU0FBUyxrQkFBa0I7QUFBQSxNQUMzQixLQUFLO0FBQUEsTUFDTCxjQUFjO0FBQUEsTUFDZCxNQUFNLENBQUMsa0JBQWtCLGtCQUFrQjtBQUFBLElBQzdDLENBQUM7QUFDRCxVQUFNLE9BQU8sTUFBTTtBQUFBLE1BQVksQ0FBQyxVQUM5QixrQkFBa0IsRUFBRSxjQUFjO0FBQUEsUUFDaEMsU0FBUyxrQkFBa0I7QUFBQSxRQUMzQixLQUFLO0FBQUEsUUFDTCxjQUFjO0FBQUEsUUFDZCxNQUFNLENBQUMsa0JBQWtCLGtCQUFrQjtBQUFBLFFBQzNDLE9BQU87QUFBQSxRQUNQO0FBQUEsTUFDRixDQUFDO0FBQUEsSUFDSDtBQUNBLFlBQVEsU0FBUyxNQUFNLGNBQWMsSUFBSTtBQUFBLEVBQzNDLFFBQVE7QUFDTixZQUFRLFNBQVM7QUFDakIsWUFBUSxjQUNOO0FBQUEsRUFDSjtBQUNBLFNBQU87QUFDVDtBQVlBLGVBQXNCLHlCQUF5QixjQUk1QztBQUNELFFBQU0sUUFBUSxXQUFXLGFBQWEsS0FBSyxDQUFDO0FBQzVDLFFBQU0sV0FBVyxNQUFNLG1CQUFtQixLQUFLO0FBQy9DLFFBQU0sVUFBVyxNQUFNLGFBQWEsRUFBRSxhQUFhO0FBQUEsSUFDakQsU0FBUztBQUFBLElBQ1QsS0FBSztBQUFBLElBQ0wsY0FBYztBQUFBLElBQ2QsTUFBTSxDQUFDLGVBQWUsQ0FBQztBQUFBLEVBQ3pCLENBQUM7QUFDRCxTQUFPLEVBQUUsY0FBYyxPQUFPLFVBQVUsa0JBQWtCLFlBQVksU0FBUyxRQUFRLEVBQUU7QUFDM0Y7QUFLQSxlQUFzQixzQkFDcEIsY0FDQSxlQUNpRztBQUNqRyxRQUFNLFFBQVEsV0FBVyxhQUFhLEtBQUssQ0FBQztBQUM1QyxRQUFNLFNBQVMsV0FBVyxjQUFjLEtBQUssQ0FBQztBQUM5QyxRQUFNLFdBQVcsTUFBTSxtQkFBbUIsS0FBSztBQUMvQyxRQUFNLFVBQVcsTUFBTSxhQUFhLEVBQUUsYUFBYTtBQUFBLElBQ2pELFNBQVM7QUFBQSxJQUNULEtBQUs7QUFBQSxJQUNMLGNBQWM7QUFBQSxJQUNkLE1BQU0sQ0FBQyxNQUFNO0FBQUEsRUFDZixDQUFDO0FBQ0QsUUFBTSxtQkFBbUIsWUFBWSxTQUFTLFFBQVE7QUFDdEQsU0FBTyxFQUFFLGNBQWMsT0FBTyxVQUFVLFNBQVMsT0FBTyxnQkFBZ0IsR0FBRyxpQkFBaUI7QUFDOUY7QUFVQSxlQUFzQixnQkFDcEIsY0FDQSxNQUNBLFFBQ0EsS0FBYyxrQkFBa0IsV0FDUjtBQUN4QixNQUFJLFVBQVUsRUFBRyxRQUFPO0FBRXhCLE1BQUk7QUFDRixVQUFNLGFBQWEsRUFBRSxpQkFBaUI7QUFBQSxNQUNwQyxTQUFTLGVBQWU7QUFBQSxNQUN4QixTQUFTLGtCQUFrQjtBQUFBLE1BQzNCLEtBQUs7QUFBQSxNQUNMLGNBQWM7QUFBQSxNQUNkLE1BQU0sQ0FBQyxjQUFjLElBQUk7QUFBQSxJQUMzQixDQUFDO0FBQ0QsVUFBTSxPQUFPLE1BQU07QUFBQSxNQUFZLENBQUMsVUFDOUIsa0JBQWtCLEVBQUUsY0FBYztBQUFBLFFBQ2hDLFNBQVMsa0JBQWtCO0FBQUEsUUFDM0IsS0FBSztBQUFBLFFBQ0wsY0FBYztBQUFBLFFBQ2QsTUFBTSxDQUFDLGNBQWMsSUFBSTtBQUFBLFFBQ3pCLE9BQU87QUFBQSxRQUNQO0FBQUEsTUFDRixDQUFDO0FBQUEsSUFDSDtBQUNBLFVBQU0sVUFBVSxNQUFNLGFBQWEsRUFBRSwwQkFBMEIsRUFBRSxLQUFLLENBQUM7QUFDdkUsUUFBSSxRQUFRLFdBQVcsVUFBVyxPQUFNLElBQUksTUFBTSx3QkFBd0I7QUFDMUUsV0FBTztBQUFBLEVBQ1QsUUFBUTtBQUFBLEVBRVI7QUFDQSxRQUFNLFdBQVcsTUFBTSxtQkFBbUIsWUFBWTtBQUN0RCxTQUFPLHFCQUFxQjtBQUFBLElBQzFCLE9BQU87QUFBQSxJQUNQO0FBQUEsSUFDQTtBQUFBLElBQ0EsYUFBYSxXQUFXLE9BQU8sUUFBUSxRQUFRLEdBQUcsUUFBUTtBQUFBLElBQzFELGdCQUFnQjtBQUFBLElBQ2hCLGVBQWU7QUFBQSxFQUNqQixDQUFDO0FBQ0g7QUFFQSxlQUFzQixlQUFlLE9BQThCO0FBQ2pFLFFBQU0sZUFBZSxrQkFBa0IsS0FBSztBQUM1QyxRQUFNLE1BQU0sVUFBVSxZQUFZLFFBQVE7QUFDMUMsUUFBTSxXQUFXLE1BQU0sY0FBYyxLQUFLO0FBQzFDLFFBQU0sVUFBVyxNQUFNLGFBQWEsRUFBRSxhQUFhO0FBQUEsSUFDakQsU0FBUztBQUFBLElBQ1Q7QUFBQSxJQUNBLGNBQWM7QUFBQSxJQUNkLE1BQU0sQ0FBQyxlQUFlLENBQUM7QUFBQSxFQUN6QixDQUFDO0FBQ0QsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLGtCQUFrQixZQUFZLFNBQVMsUUFBUTtBQUFBLElBQy9DLEtBQUssVUFBVSxXQUFXLE9BQU8sNEJBQTRCLEdBQUcsUUFBUTtBQUFBLEVBQzFFO0FBQ0Y7QUE3OUNBLElBOENhLG9CQU1BLGdCQW9HQSxlQUNQLFNBQ0Esa0JBQ0EsY0FPTyxtQkFzQ1AsaUJBMkJBLE9BSUEsT0FlQSxRQVlBLGVBa0VBLGVBUUEseUJBQ0Esb0JBeUZGLGNBaUVFLHFCQWtDQSxpQkFDQSxvQkEwQkEsZUEySkEsYUFvVUUsbUJBeVdGO0FBNTJDTjtBQUFBO0FBMkNBO0FBR08sSUFBTSxxQkFBOEI7QUFBQSxNQUN6QztBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUVPLElBQU0saUJBQWlCO0FBQUEsTUFDNUI7QUFBQSxRQUNFLE1BQU07QUFBQSxRQUNOLE1BQU07QUFBQSxRQUNOLGlCQUFpQjtBQUFBLFFBQ2pCLFFBQVE7QUFBQSxVQUNOLEVBQUUsTUFBTSxpQkFBaUIsTUFBTSxVQUFVO0FBQUEsVUFDekMsRUFBRSxNQUFNLFVBQVUsTUFBTSxPQUFPO0FBQUEsVUFDL0IsRUFBRSxNQUFNLGNBQWMsTUFBTSxVQUFVO0FBQUEsVUFDdEMsRUFBRSxNQUFNLGlCQUFpQixNQUFNLFVBQVU7QUFBQSxVQUN6QyxFQUFFLE1BQU0sU0FBUyxNQUFNLFVBQVU7QUFBQSxVQUNqQyxFQUFFLE1BQU0sWUFBWSxNQUFNLFVBQVU7QUFBQSxRQUN0QztBQUFBLFFBQ0EsU0FBUyxDQUFDLEVBQUUsTUFBTSxXQUFXLE1BQU0sVUFBVSxDQUFDO0FBQUEsTUFDaEQ7QUFBQSxNQUNBO0FBQUEsUUFDRSxNQUFNO0FBQUEsUUFDTixNQUFNO0FBQUEsUUFDTixpQkFBaUI7QUFBQSxRQUNqQixRQUFRO0FBQUEsVUFDTixFQUFFLE1BQU0sV0FBVyxNQUFNLFVBQVU7QUFBQSxVQUNuQyxFQUFFLE1BQU0sWUFBWSxNQUFNLFVBQVU7QUFBQSxVQUNwQyxFQUFFLE1BQU0sV0FBVyxNQUFNLFVBQVU7QUFBQSxRQUNyQztBQUFBLFFBQ0EsU0FBUztBQUFBLFVBQ1A7QUFBQSxZQUNFLE1BQU07QUFBQSxZQUNOLE1BQU07QUFBQSxZQUNOLFlBQVk7QUFBQSxjQUNWLEVBQUUsTUFBTSxXQUFXLE1BQU0sVUFBVTtBQUFBLGNBQ25DLEVBQUUsTUFBTSxTQUFTLE1BQU0sVUFBVTtBQUFBLGNBQ2pDLEVBQUUsTUFBTSxVQUFVLE1BQU0sVUFBVTtBQUFBLGNBQ2xDLEVBQUUsTUFBTSxZQUFZLE1BQU0sVUFBVTtBQUFBLGNBQ3BDLEVBQUUsTUFBTSxTQUFTLE1BQU0sVUFBVTtBQUFBLGNBQ2pDLEVBQUUsTUFBTSxPQUFPLE1BQU0sVUFBVTtBQUFBLFlBQ2pDO0FBQUEsVUFDRjtBQUFBLFVBQ0EsRUFBRSxNQUFNLGFBQWEsTUFBTSxPQUFPO0FBQUEsUUFDcEM7QUFBQSxNQUNGO0FBQUEsTUFDQTtBQUFBLFFBQ0UsTUFBTTtBQUFBLFFBQ04sTUFBTTtBQUFBLFFBQ04saUJBQWlCO0FBQUEsUUFDakIsUUFBUSxDQUFDLEVBQUUsTUFBTSxXQUFXLE1BQU0sVUFBVSxDQUFDO0FBQUEsUUFDN0MsU0FBUyxDQUFDLEVBQUUsTUFBTSxrQkFBa0IsTUFBTSxVQUFVLENBQUM7QUFBQSxNQUN2RDtBQUFBLE1BQ0E7QUFBQSxRQUNFLE1BQU07QUFBQSxRQUNOLE1BQU07QUFBQSxRQUNOLGlCQUFpQjtBQUFBLFFBQ2pCLFFBQVEsQ0FBQyxFQUFFLE1BQU0sU0FBUyxNQUFNLFVBQVUsQ0FBQztBQUFBLFFBQzNDLFNBQVMsQ0FBQyxFQUFFLE1BQU0sVUFBVSxNQUFNLFVBQVUsQ0FBQztBQUFBLE1BQy9DO0FBQUEsTUFDQTtBQUFBLFFBQ0UsTUFBTTtBQUFBLFFBQ04sTUFBTTtBQUFBLFFBQ04sV0FBVztBQUFBLFFBQ1gsUUFBUTtBQUFBLFVBQ04sRUFBRSxTQUFTLE1BQU0sTUFBTSxXQUFXLE1BQU0sVUFBVTtBQUFBLFVBQ2xELEVBQUUsU0FBUyxNQUFNLE1BQU0saUJBQWlCLE1BQU0sVUFBVTtBQUFBLFVBQ3hELEVBQUUsU0FBUyxNQUFNLE1BQU0sU0FBUyxNQUFNLFVBQVU7QUFBQSxVQUNoRCxFQUFFLFNBQVMsT0FBTyxNQUFNLFVBQVUsTUFBTSxPQUFPO0FBQUEsVUFDL0MsRUFBRSxTQUFTLE9BQU8sTUFBTSxjQUFjLE1BQU0sVUFBVTtBQUFBLFVBQ3RELEVBQUUsU0FBUyxPQUFPLE1BQU0saUJBQWlCLE1BQU0sVUFBVTtBQUFBLFVBQ3pELEVBQUUsU0FBUyxPQUFPLE1BQU0sU0FBUyxNQUFNLFVBQVU7QUFBQSxVQUNqRCxFQUFFLFNBQVMsT0FBTyxNQUFNLFlBQVksTUFBTSxVQUFVO0FBQUEsVUFDcEQsRUFBRSxTQUFTLE9BQU8sTUFBTSxjQUFjLE1BQU0sVUFBVTtBQUFBLFFBQ3hEO0FBQUEsTUFDRjtBQUFBLE1BQ0E7QUFBQSxRQUNFLE1BQU07QUFBQSxRQUNOLE1BQU07QUFBQSxRQUNOLFdBQVc7QUFBQSxRQUNYLFFBQVE7QUFBQSxVQUNOLEVBQUUsU0FBUyxNQUFNLE1BQU0sV0FBVyxNQUFNLFVBQVU7QUFBQSxVQUNsRCxFQUFFLFNBQVMsTUFBTSxNQUFNLFdBQVcsTUFBTSxVQUFVO0FBQUEsVUFDbEQsRUFBRSxTQUFTLE1BQU0sTUFBTSxTQUFTLE1BQU0sVUFBVTtBQUFBLFVBQ2hELEVBQUUsU0FBUyxPQUFPLE1BQU0sVUFBVSxNQUFNLFVBQVU7QUFBQSxVQUNsRCxFQUFFLFNBQVMsT0FBTyxNQUFNLGNBQWMsTUFBTSxVQUFVO0FBQUEsVUFDdEQsRUFBRSxTQUFTLE9BQU8sTUFBTSxpQkFBaUIsTUFBTSxVQUFVO0FBQUEsVUFDekQsRUFBRSxTQUFTLE9BQU8sTUFBTSxZQUFZLE1BQU0sVUFBVTtBQUFBLFVBQ3BELEVBQUUsU0FBUyxPQUFPLE1BQU0sU0FBUyxNQUFNLFVBQVU7QUFBQSxVQUNqRCxFQUFFLFNBQVMsT0FBTyxNQUFNLFNBQVMsTUFBTSxVQUFVO0FBQUEsVUFDakQsRUFBRSxTQUFTLE9BQU8sTUFBTSxPQUFPLE1BQU0sVUFBVTtBQUFBLFVBQy9DLEVBQUUsU0FBUyxPQUFPLE1BQU0sb0JBQW9CLE1BQU0sVUFBVTtBQUFBLFFBQzlEO0FBQUEsTUFDRjtBQUFBLE1BQ0E7QUFBQSxRQUNFLE1BQU07QUFBQSxRQUNOLE1BQU07QUFBQSxRQUNOLFdBQVc7QUFBQSxRQUNYLFFBQVE7QUFBQSxVQUNOLEVBQUUsU0FBUyxNQUFNLE1BQU0sV0FBVyxNQUFNLFVBQVU7QUFBQSxVQUNsRCxFQUFFLFNBQVMsTUFBTSxNQUFNLFNBQVMsTUFBTSxVQUFVO0FBQUEsVUFDaEQsRUFBRSxTQUFTLE9BQU8sTUFBTSxrQkFBa0IsTUFBTSxVQUFVO0FBQUEsUUFDNUQ7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUVPLElBQU0sZ0JBQWdCO0FBQzdCLElBQU0sVUFBVSxRQUFRLElBQUksd0JBQXdCO0FBQ3BELElBQU0sbUJBQW1CO0FBQ3pCLElBQU0sZUFBZSxTQUFTLENBQUMsS0FBSyxPQUFPLEdBQUcsS0FBSyxnQkFBZ0IsQ0FBQyxDQUFDO0FBTzlELElBQU0sb0JBQW9CO0FBQUEsTUFDL0IsV0FBVyxpQkFBaUIsUUFBVyw4Q0FBOEMsMENBQVk7QUFBQSxNQUNqRyxnQkFBZ0IsaUJBQWlCLFFBQVcsOENBQThDLDBDQUFZO0FBQUEsTUFDdEcsb0JBQW9CLGlCQUFpQixRQUFXLDhDQUE4QywwQ0FBWTtBQUFBO0FBQUE7QUFBQSxNQUcxRyxTQUFTLGlCQUFpQixRQUFXLDhDQUE4Qyx5Q0FBVztBQUFBO0FBQUE7QUFBQTtBQUFBLE1BSTlGLFdBQVcsaUJBQWlCLFFBQVcsOENBQThDLG1CQUFTO0FBQUEsTUFDOUYsTUFBTSxpQkFBaUIsUUFBVyw4Q0FBOEMsK0JBQVc7QUFBQTtBQUFBO0FBQUE7QUFBQSxNQUkzRixTQUFTLGlCQUFpQixRQUFXLDhDQUE4Qyw2QkFBUztBQUFBLE1BQzVGLGVBQWUsaUJBQWlCLFFBQVcsOENBQThDLHlDQUFXO0FBQUEsTUFDcEcsbUJBQW1CO0FBQUEsUUFDakI7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0Y7QUFBQTtBQUFBLE1BRUEsWUFBWSxpQkFBaUIsUUFBVyw4Q0FBOEMsMEJBQWdCO0FBQUEsSUFDeEc7QUFjQSxJQUFNLGtCQUFrQjtBQUFBLE1BQ3RCO0FBQUEsUUFDRSxRQUFRO0FBQUEsVUFDTixFQUFFLE1BQU0sTUFBTSxNQUFNLFVBQVU7QUFBQSxVQUM5QixFQUFFLE1BQU0sVUFBVSxNQUFNLFVBQVU7QUFBQSxRQUNwQztBQUFBLFFBQ0EsTUFBTTtBQUFBLFFBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxPQUFPLENBQUM7QUFBQSxRQUMxQixpQkFBaUI7QUFBQSxRQUNqQixNQUFNO0FBQUEsTUFDUjtBQUFBLE1BQ0EsRUFBRSxRQUFRLENBQUMsRUFBRSxNQUFNLFdBQVcsTUFBTSxVQUFVLENBQUMsR0FBRyxNQUFNLGFBQWEsU0FBUyxDQUFDLEVBQUUsTUFBTSxVQUFVLENBQUMsR0FBRyxpQkFBaUIsUUFBUSxNQUFNLFdBQVc7QUFBQSxNQUMvSSxFQUFFLFFBQVEsQ0FBQyxHQUFHLE1BQU0sWUFBWSxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsQ0FBQyxHQUFHLGlCQUFpQixRQUFRLE1BQU0sV0FBVztBQUFBLE1BQ3hHLEVBQUUsUUFBUSxDQUFDLEVBQUUsTUFBTSxTQUFTLE1BQU0sVUFBVSxHQUFHLEVBQUUsTUFBTSxXQUFXLE1BQU0sVUFBVSxDQUFDLEdBQUcsTUFBTSxhQUFhLFNBQVMsQ0FBQyxFQUFFLE1BQU0sVUFBVSxDQUFDLEdBQUcsaUJBQWlCLFFBQVEsTUFBTSxXQUFXO0FBQUEsTUFDbkwsRUFBRSxRQUFRLENBQUMsRUFBRSxNQUFNLFdBQVcsTUFBTSxVQUFVLEdBQUcsRUFBRSxNQUFNLFNBQVMsTUFBTSxVQUFVLENBQUMsR0FBRyxNQUFNLFdBQVcsU0FBUyxDQUFDLEVBQUUsTUFBTSxPQUFPLENBQUMsR0FBRyxpQkFBaUIsY0FBYyxNQUFNLFdBQVc7QUFBQSxNQUNwTDtBQUFBLFFBQ0UsUUFBUTtBQUFBLFVBQ04sRUFBRSxNQUFNLFFBQVEsTUFBTSxVQUFVO0FBQUEsVUFDaEMsRUFBRSxNQUFNLE1BQU0sTUFBTSxVQUFVO0FBQUEsVUFDOUIsRUFBRSxNQUFNLFVBQVUsTUFBTSxVQUFVO0FBQUEsUUFDcEM7QUFBQSxRQUNBLE1BQU07QUFBQSxRQUNOLFNBQVMsQ0FBQyxFQUFFLE1BQU0sT0FBTyxDQUFDO0FBQUEsUUFDMUIsaUJBQWlCO0FBQUEsUUFDakIsTUFBTTtBQUFBLE1BQ1I7QUFBQSxJQUNGO0FBQ0EsSUFBTSxRQUFRO0FBSWQsSUFBTSxRQUFRO0FBQUEsTUFDWixHQUFHO0FBQUEsTUFDSDtBQUFBLFFBQ0UsUUFBUTtBQUFBLFVBQ04sRUFBRSxNQUFNLFFBQVEsTUFBTSxVQUFVO0FBQUEsVUFDaEMsRUFBRSxNQUFNLE1BQU0sTUFBTSxVQUFVO0FBQUEsVUFDOUIsRUFBRSxNQUFNLFVBQVUsTUFBTSxVQUFVO0FBQUEsUUFDcEM7QUFBQSxRQUNBLE1BQU07QUFBQSxRQUNOLFNBQVMsQ0FBQztBQUFBLFFBQ1YsaUJBQWlCO0FBQUEsUUFDakIsTUFBTTtBQUFBLE1BQ1I7QUFBQSxJQUNGO0FBRUEsSUFBTSxTQUFTO0FBQUEsTUFDYixFQUFFLFFBQVEsQ0FBQyxFQUFFLE1BQU0sTUFBTSxNQUFNLFVBQVUsR0FBRyxFQUFFLE1BQU0sVUFBVSxNQUFNLFVBQVUsQ0FBQyxHQUFHLE1BQU0sUUFBUSxTQUFTLENBQUMsR0FBRyxpQkFBaUIsY0FBYyxNQUFNLFdBQVc7QUFBQSxNQUM3SixFQUFFLFFBQVEsQ0FBQyxFQUFFLE1BQU0sS0FBSyxNQUFNLFVBQVUsQ0FBQyxHQUFHLE1BQU0scUJBQXFCLFNBQVMsQ0FBQyxHQUFHLGlCQUFpQixjQUFjLE1BQU0sV0FBVztBQUFBLE1BQ3BJLEVBQUUsUUFBUSxDQUFDLEVBQUUsTUFBTSxLQUFLLE1BQU0sVUFBVSxDQUFDLEdBQUcsTUFBTSwyQkFBMkIsU0FBUyxDQUFDLEdBQUcsaUJBQWlCLGNBQWMsTUFBTSxXQUFXO0FBQUEsTUFDMUksRUFBRSxRQUFRLENBQUMsR0FBRyxNQUFNLGtCQUFrQixTQUFTLENBQUMsRUFBRSxNQUFNLFVBQVUsQ0FBQyxHQUFHLGlCQUFpQixRQUFRLE1BQU0sV0FBVztBQUFBLE1BQ2hILEVBQUUsUUFBUSxDQUFDLEdBQUcsTUFBTSx3QkFBd0IsU0FBUyxDQUFDLEVBQUUsTUFBTSxVQUFVLENBQUMsR0FBRyxpQkFBaUIsUUFBUSxNQUFNLFdBQVc7QUFBQSxNQUN0SCxFQUFFLFFBQVEsQ0FBQyxHQUFHLE1BQU0sWUFBWSxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsQ0FBQyxHQUFHLGlCQUFpQixRQUFRLE1BQU0sV0FBVztBQUFBLE1BQ3hHLEVBQUUsUUFBUSxDQUFDLEdBQUcsTUFBTSxTQUFTLFNBQVMsQ0FBQyxFQUFFLE1BQU0sVUFBVSxDQUFDLEdBQUcsaUJBQWlCLFFBQVEsTUFBTSxXQUFXO0FBQUEsSUFDekc7QUFJQSxJQUFNLGdCQUFnQjtBQUFBLE1BQ3BCO0FBQUEsUUFDRSxRQUFRO0FBQUEsVUFDTixFQUFFLE1BQU0sU0FBUyxNQUFNLFVBQVU7QUFBQSxVQUNqQyxFQUFFLE1BQU0sVUFBVSxNQUFNLFVBQVU7QUFBQSxRQUNwQztBQUFBLFFBQ0EsTUFBTTtBQUFBLFFBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxVQUFVLE1BQU0sVUFBVSxDQUFDO0FBQUEsUUFDN0MsaUJBQWlCO0FBQUEsUUFDakIsTUFBTTtBQUFBLE1BQ1I7QUFBQSxNQUNBO0FBQUEsUUFDRSxRQUFRLENBQUMsRUFBRSxNQUFNLFNBQVMsTUFBTSxVQUFVLEdBQUcsRUFBRSxNQUFNLFVBQVUsTUFBTSxVQUFVLENBQUM7QUFBQSxRQUNoRixNQUFNO0FBQUEsUUFDTixTQUFTLENBQUM7QUFBQSxRQUNWLGlCQUFpQjtBQUFBLFFBQ2pCLE1BQU07QUFBQSxNQUNSO0FBQUEsTUFDQSxFQUFFLFFBQVEsQ0FBQyxFQUFFLE1BQU0sU0FBUyxNQUFNLFVBQVUsQ0FBQyxHQUFHLE1BQU0sa0JBQWtCLFNBQVMsQ0FBQyxFQUFFLE1BQU0sT0FBTyxDQUFDLEdBQUcsaUJBQWlCLFFBQVEsTUFBTSxXQUFXO0FBQUEsTUFDL0ksRUFBRSxRQUFRLENBQUMsR0FBRyxNQUFNLGFBQWEsU0FBUyxDQUFDLEVBQUUsTUFBTSxVQUFVLENBQUMsR0FBRyxpQkFBaUIsUUFBUSxNQUFNLFdBQVc7QUFBQSxNQUMzRztBQUFBLFFBQ0UsUUFBUTtBQUFBLFVBQ04sRUFBRSxNQUFNLGVBQWUsTUFBTSxTQUFTO0FBQUEsVUFDdEMsRUFBRSxNQUFNLFNBQVMsTUFBTSxTQUFTO0FBQUEsVUFDaEMsRUFBRSxNQUFNLFdBQVcsTUFBTSxTQUFTO0FBQUEsVUFDbEMsRUFBRSxNQUFNLGFBQWEsTUFBTSxRQUFRO0FBQUEsVUFDbkMsRUFBRSxNQUFNLGdCQUFnQixNQUFNLFVBQVU7QUFBQSxRQUMxQztBQUFBLFFBQ0EsTUFBTTtBQUFBLFFBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxTQUFTLE1BQU0sVUFBVSxDQUFDO0FBQUEsUUFDNUMsaUJBQWlCO0FBQUEsUUFDakIsTUFBTTtBQUFBLE1BQ1I7QUFBQSxNQUNBO0FBQUEsUUFDRSxRQUFRO0FBQUEsVUFDTixFQUFFLE1BQU0sU0FBUyxNQUFNLFVBQVU7QUFBQSxVQUNqQyxFQUFFLE1BQU0sWUFBWSxNQUFNLFVBQVU7QUFBQSxVQUNwQyxFQUFFLE1BQU0sU0FBUyxNQUFNLFVBQVU7QUFBQSxVQUNqQyxFQUFFLE1BQU0sZUFBZSxNQUFNLFVBQVU7QUFBQSxVQUN2QyxFQUFFLE1BQU0sV0FBVyxNQUFNLFVBQVU7QUFBQSxRQUNyQztBQUFBLFFBQ0EsTUFBTTtBQUFBLFFBQ04sU0FBUyxDQUFDO0FBQUEsUUFDVixpQkFBaUI7QUFBQSxRQUNqQixNQUFNO0FBQUEsTUFDUjtBQUFBLE1BQ0E7QUFBQSxRQUNFLFFBQVE7QUFBQSxVQUNOLEVBQUUsTUFBTSxTQUFTLE1BQU0sVUFBVTtBQUFBLFVBQ2pDLEVBQUUsTUFBTSxZQUFZLE1BQU0sVUFBVTtBQUFBLFVBQ3BDLEVBQUUsTUFBTSxVQUFVLE1BQU0sVUFBVTtBQUFBLFVBQ2xDLEVBQUUsTUFBTSxTQUFTLE1BQU0sVUFBVTtBQUFBLFVBQ2pDLEVBQUUsTUFBTSxlQUFlLE1BQU0sVUFBVTtBQUFBLFVBQ3ZDLEVBQUUsTUFBTSxtQkFBbUIsTUFBTSxVQUFVO0FBQUEsVUFDM0MsRUFBRSxNQUFNLGFBQWEsTUFBTSxVQUFVO0FBQUEsUUFDdkM7QUFBQSxRQUNBLE1BQU07QUFBQSxRQUNOLFNBQVMsQ0FBQztBQUFBLFFBQ1YsaUJBQWlCO0FBQUEsUUFDakIsTUFBTTtBQUFBLE1BQ1I7QUFBQSxNQUNBLEVBQUUsUUFBUSxDQUFDLEVBQUUsTUFBTSxJQUFJLE1BQU0sU0FBUyxDQUFDLEdBQUcsTUFBTSxvQkFBb0IsU0FBUyxDQUFDLEVBQUUsTUFBTSxVQUFVLENBQUMsR0FBRyxpQkFBaUIsUUFBUSxNQUFNLFdBQVc7QUFBQSxJQUNoSjtBQUlBLElBQU0sZ0JBQWdCO0FBQUEsTUFDcEIsRUFBRSxRQUFRLENBQUMsR0FBRyxNQUFNLFlBQVksU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLENBQUMsR0FBRyxpQkFBaUIsUUFBUSxNQUFNLFdBQVc7QUFBQSxNQUN4RyxFQUFFLFFBQVEsQ0FBQyxFQUFFLE1BQU0sV0FBVyxNQUFNLFVBQVUsQ0FBQyxHQUFHLE1BQU0sYUFBYSxTQUFTLENBQUMsRUFBRSxNQUFNLFVBQVUsQ0FBQyxHQUFHLGlCQUFpQixRQUFRLE1BQU0sV0FBVztBQUFBLE1BQy9JLEVBQUUsUUFBUSxDQUFDLEVBQUUsTUFBTSxTQUFTLE1BQU0sVUFBVSxHQUFHLEVBQUUsTUFBTSxXQUFXLE1BQU0sVUFBVSxDQUFDLEdBQUcsTUFBTSxhQUFhLFNBQVMsQ0FBQyxFQUFFLE1BQU0sVUFBVSxDQUFDLEdBQUcsaUJBQWlCLFFBQVEsTUFBTSxXQUFXO0FBQUEsTUFDbkwsRUFBRSxRQUFRLENBQUMsRUFBRSxNQUFNLFdBQVcsTUFBTSxVQUFVLEdBQUcsRUFBRSxNQUFNLFNBQVMsTUFBTSxVQUFVLENBQUMsR0FBRyxNQUFNLFdBQVcsU0FBUyxDQUFDLEVBQUUsTUFBTSxPQUFPLENBQUMsR0FBRyxpQkFBaUIsY0FBYyxNQUFNLFdBQVc7QUFBQSxNQUNwTCxFQUFFLFFBQVEsQ0FBQyxFQUFFLE1BQU0sTUFBTSxNQUFNLFVBQVUsR0FBRyxFQUFFLE1BQU0sU0FBUyxNQUFNLFVBQVUsQ0FBQyxHQUFHLE1BQU0sWUFBWSxTQUFTLENBQUMsRUFBRSxNQUFNLE9BQU8sQ0FBQyxHQUFHLGlCQUFpQixjQUFjLE1BQU0sV0FBVztBQUFBLElBQ2xMO0FBRUEsSUFBTSwwQkFBMEIsb0JBQUksSUFBcUI7QUFDekQsSUFBTSxxQkFBcUIsYUFBYSx5RUFBeUU7QUF5RmpILElBQUksZUFBb0M7QUFpRXhDLElBQU0sc0JBQXNCLFdBQVcsUUFBUTtBQWtDL0MsSUFBTSxrQkFBa0IsV0FBVyxTQUFTO0FBQzVDLElBQU0scUJBQXFCLFdBQVcsUUFBUTtBQTBCOUMsSUFBTSxnQkFBZ0Isb0JBQUksSUFBcUI7QUEySi9DLElBQU0sY0FBYztBQUFBLE1BQ2xCO0FBQUEsUUFDRSxRQUFRO0FBQUEsVUFDTixFQUFFLE1BQU0sTUFBTSxNQUFNLFVBQVU7QUFBQSxVQUM5QixFQUFFLE1BQU0sVUFBVSxNQUFNLFVBQVU7QUFBQSxRQUNwQztBQUFBLFFBQ0EsTUFBTTtBQUFBLFFBQ04sU0FBUyxDQUFDO0FBQUEsUUFDVixpQkFBaUI7QUFBQSxRQUNqQixNQUFNO0FBQUEsTUFDUjtBQUFBLE1BQ0E7QUFBQSxRQUNFLFFBQVEsQ0FBQyxFQUFFLE1BQU0sVUFBVSxNQUFNLFVBQVUsQ0FBQztBQUFBLFFBQzVDLE1BQU07QUFBQSxRQUNOLFNBQVMsQ0FBQztBQUFBLFFBQ1YsaUJBQWlCO0FBQUEsUUFDakIsTUFBTTtBQUFBLE1BQ1I7QUFBQSxJQUNGO0FBa1RFLElBQU0sb0JBQThDLEVBQUUsT0FBTyxLQUFLO0FBeVdwRSxJQUFNLCtCQUErQjtBQUFBO0FBQUE7OztBQzUyQ3JDO0FBQUE7QUFBQSxpQkFBQUM7QUFBQSxFQUFBO0FBQUE7QUFBQTtBQWNBLFNBQVMsZ0JBQUFDLHFCQUF5QztBQUNsRCxTQUFTLGVBQUFDLGNBQWEsY0FBQUMsYUFBWSxnQkFBZ0IsY0FBQUMsbUJBQWdDO0FBMENsRixTQUFTQyxNQUFLLFVBQTBCLFFBQWdCLFNBQWtCO0FBQ3hFLFdBQVMsYUFBYTtBQUN0QixXQUFTLFVBQVUsZ0JBQWdCLGlDQUFpQztBQUNwRSxXQUFTLFVBQVUsaUJBQWlCLFVBQVU7QUFDOUMsV0FBUyxJQUFJLEtBQUssVUFBVSxPQUFPLENBQUM7QUFDdEM7QUFFQSxlQUFlQyxVQUFTLFNBQTBCO0FBQ2hELE1BQUksTUFBTTtBQUNWLG1CQUFpQixTQUFTLFNBQVM7QUFDakMsV0FBTztBQUNQLFFBQUksSUFBSSxTQUFTLE1BQVEsT0FBTSxJQUFJLE1BQU0sbUJBQW1CO0FBQUEsRUFDOUQ7QUFDQSxTQUFPLEtBQUssTUFBTSxPQUFPLElBQUk7QUFZL0I7QUFRQSxTQUFTLFVBQVUsT0FBZ0IsT0FBd0I7QUFDekQsTUFBSSxPQUFPLFVBQVUsU0FBVSxPQUFNLElBQUksTUFBTSxHQUFHLEtBQUssNkNBQVU7QUFDakUsTUFBSTtBQUNGLFdBQU9ILFlBQVcsTUFBTSxLQUFLLENBQUM7QUFBQSxFQUNoQyxRQUFRO0FBQ04sVUFBTSxJQUFJLE1BQU0sR0FBRyxLQUFLLG1EQUFXO0FBQUEsRUFDckM7QUFDRjtBQVlBLGVBQWUsa0JBQWtCLGFBQXFCLFdBQTRCO0FBQ2hGLE1BQUksQ0FBQyxzQkFBc0IsS0FBSyxXQUFXLEVBQUcsT0FBTSxJQUFJLE1BQU0sa0RBQVU7QUFDeEUsUUFBTSxTQUFTLFlBQVksWUFBWTtBQUN2QyxRQUFNLFNBQVMsaUJBQWlCO0FBQ2hDLFFBQU0sVUFBVSxNQUFNLG9CQUFvQixNQUFNO0FBQ2hELE1BQUksUUFBUSxXQUFXLFVBQVcsT0FBTSxJQUFJLE1BQU0sOERBQVk7QUFDOUQsUUFBTSxPQUFPLFFBQVEsS0FBSyxPQUFPLENBQUMsUUFBUSxJQUFJLFFBQVEsWUFBWSxNQUFNLE9BQU8sWUFBWSxDQUFDO0FBQzVGLFFBQU0sVUFBVSxlQUFlLEVBQUUsS0FBSyxnQkFBZ0IsTUFBTSxRQUFRLEtBQUssQ0FBQztBQUMxRSxRQUFNLFFBQVEsUUFBUSxLQUFLLENBQUMsVUFBVSxNQUFNLGNBQWMsU0FBUztBQUNuRSxNQUFJLENBQUMsTUFBTyxPQUFNLElBQUksTUFBTSxvREFBWSxTQUFTLDJCQUFPO0FBQ3hELFNBQU8sRUFBRSxRQUFRLFFBQVEsTUFBTSxNQUFNLEtBQUs7QUFDNUM7QUFFQSxlQUFlLGdCQUNiLE9BQ0EsUUFDQSxXQUNBLFFBQ0EsV0FDa0I7QUFDbEIsUUFBTSxXQUFXLE1BQU0sTUFBTSxLQUFLLG1CQUFtQixFQUNsRCxPQUFPLHNDQUFzQyxFQUM3QyxHQUFHLFdBQVcsTUFBTSxFQUNwQixZQUFZO0FBQ2YsTUFBSSxTQUFTLE1BQU8sT0FBTSxJQUFJLE1BQU0seURBQVksU0FBUyxNQUFNLE9BQU8sRUFBRTtBQUN4RSxNQUFJLFNBQVMsTUFBTTtBQUNqQixRQUFJLFNBQVMsS0FBSyxlQUFlLFVBQVcsT0FBTSxJQUFJLE1BQU0sa0dBQWtCO0FBQzlFLFFBQUksU0FBUyxLQUFLLFdBQVcsWUFBYSxRQUFPO0FBQ2pELFVBQU0sU0FBUyxNQUFNLE1BQU0sS0FBSyxtQkFBbUIsRUFBRSxPQUFPO0FBQUEsTUFDMUQsU0FBUztBQUFBLE1BQ1QsWUFBWTtBQUFBLE1BQ1osUUFBUTtBQUFBLE1BQ1IsT0FBTztBQUFBLE1BQ1AsYUFBWSxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUFBLElBQ3JDLENBQUMsRUFBRSxHQUFHLFdBQVcsTUFBTTtBQUN2QixRQUFJLE9BQU8sTUFBTyxPQUFNLElBQUksTUFBTSx5REFBWSxPQUFPLE1BQU0sT0FBTyxFQUFFO0FBQ3BFLFdBQU87QUFBQSxFQUNUO0FBQ0EsUUFBTSxTQUFTLE1BQU0sTUFBTSxLQUFLLG1CQUFtQixFQUFFLE9BQU87QUFBQSxJQUMxRCxTQUFTO0FBQUEsSUFDVCxZQUFZO0FBQUEsSUFDWixTQUFTO0FBQUEsSUFDVCxZQUFZO0FBQUEsSUFDWixRQUFRO0FBQUEsRUFDVixDQUFDO0FBQ0QsTUFBSSxPQUFPLE9BQU87QUFDaEIsVUFBTSxRQUFRLE1BQU0sTUFBTSxLQUFLLG1CQUFtQixFQUFFLE9BQU8sbUJBQW1CLEVBQUUsR0FBRyxXQUFXLE1BQU0sRUFBRSxZQUFZO0FBQ2xILFFBQUksTUFBTSxNQUFNLGVBQWUsVUFBVyxRQUFPLE1BQU0sS0FBSyxXQUFXO0FBQ3ZFLFVBQU0sSUFBSSxNQUFNLHlEQUFZLE9BQU8sTUFBTSxPQUFPLEVBQUU7QUFBQSxFQUNwRDtBQUNBLFNBQU87QUFDVDtBQUVBLGVBQWUsa0JBQWtCLE9BQXVCLFFBQWdCLE9BQWdCO0FBQ3RGLFFBQU0sU0FBUyxNQUFNLE1BQU0sS0FBSyxtQkFBbUIsRUFBRSxPQUFPO0FBQUEsSUFDMUQsUUFBUSxRQUFRLFdBQVc7QUFBQSxJQUMzQixPQUFPLFNBQVM7QUFBQSxJQUNoQixhQUFZLG9CQUFJLEtBQUssR0FBRSxZQUFZO0FBQUEsRUFDckMsQ0FBQyxFQUFFLEdBQUcsV0FBVyxNQUFNO0FBQ3ZCLE1BQUksT0FBTyxNQUFPLE9BQU0sSUFBSSxNQUFNLHFFQUFjLE9BQU8sTUFBTSxPQUFPLEVBQUU7QUFDeEU7QUFFQSxlQUFlLGlCQUFpQixPQUF1QixRQUFpQjtBQUN0RSxRQUFNLEVBQUUsTUFBTSxNQUFNLElBQUksTUFBTSxNQUFNLEtBQUssVUFBVSxFQUNoRCxPQUFPLG1CQUFtQixFQUMxQixNQUFNLGtCQUFrQixNQUFNLEVBQzlCLFlBQVk7QUFDZixNQUFJLFNBQVMsQ0FBQyxLQUFNLE9BQU0sSUFBSSxNQUFNLHNGQUFnQjtBQUNwRCxTQUFPO0FBQ1Q7QUFFQSxlQUFlLDBCQUNiLE9BQ0EsYUFDQSxRQUNrQztBQUNsQyxRQUFNLEVBQUUsUUFBUSxLQUFLLElBQUksTUFBTSxrQkFBa0IsYUFBYSxjQUFjO0FBQzVFLFFBQU0sUUFBUSxVQUFVLEtBQUssT0FBTyxvQkFBSztBQUN6QyxRQUFNLFVBQVUsTUFBTSxpQkFBaUIsT0FBTyxLQUFLO0FBQ25ELE1BQUksVUFBVSxPQUFPLE9BQU8sUUFBUSxHQUFJLE9BQU0sSUFBSSxNQUFNLDRGQUFpQjtBQUN6RSxRQUFNLFlBQVk7QUFBQSxJQUNoQjtBQUFBLElBQ0EsU0FBUyxPQUFPLEtBQUssT0FBTztBQUFBLElBQzVCLGVBQWUsT0FBTyxLQUFLLGFBQWEsRUFBRSxZQUFZO0FBQUEsSUFDdEQ7QUFBQSxJQUNBLFFBQVEsUUFBUSxLQUFLLE1BQU07QUFBQSxJQUMzQixZQUFZLFVBQVUsS0FBSyxZQUFZLDBCQUFNLEVBQUUsWUFBWTtBQUFBLElBQzNELGVBQWUsVUFBVSxLQUFLLGVBQWUsMEJBQU0sRUFBRSxZQUFZO0FBQUEsSUFDakUsT0FBTyxPQUFPLEtBQUssS0FBSztBQUFBLElBQ3hCLFVBQVUsT0FBTyxLQUFLLFFBQVE7QUFBQSxJQUM5QixZQUFZLE9BQU8sS0FBSyxVQUFVO0FBQUEsRUFDcEM7QUFDQSxRQUFNLG1CQUFtQixNQUFNLGdCQUFnQixPQUFPLFFBQVEsaUJBQWlCLFFBQVEsSUFBSSxTQUFTO0FBQ3BHLE1BQUksaUJBQWtCLFFBQU8sRUFBRSxRQUFRLGFBQWEsWUFBWSxNQUFNLFNBQVMsT0FBTztBQUV0RixNQUFJO0FBQ0YsVUFBTSxjQUFjLE1BQU0sTUFBTSxLQUFLLCtCQUErQixFQUNqRSxPQUFPLDBDQUEwQyxFQUNqRCxHQUFHLG1CQUFtQixVQUFVLGFBQWEsRUFDN0MsWUFBWTtBQUNmLFFBQUksWUFBWSxTQUFTLENBQUMsWUFBWSxRQUFRLFlBQVksS0FBSyxZQUFZLFFBQVEsSUFBSTtBQUNyRixZQUFNLElBQUksTUFBTSwwS0FBOEI7QUFBQSxJQUNoRDtBQUNBLFVBQU0sWUFBWSxNQUFNLE1BQU0sS0FBSyxvQkFBb0IsRUFDcEQsT0FBTyw4QkFBOEIsRUFDckMsR0FBRyxNQUFNLFlBQVksS0FBSyxRQUFRLEVBQ2xDLFlBQVk7QUFDZixRQUFJLFVBQVUsU0FBUyxDQUFDLFVBQVUsS0FBTSxPQUFNLElBQUksTUFBTSxvRUFBYTtBQUNyRSxVQUFNLGdCQUFnQixVQUFVLEtBQUssY0FDakMsa0JBQWtCLFVBQ2xCLHNCQUFzQixVQUFVLEtBQUssYUFBYTtBQUN0RCxRQUFJLENBQUMsaUJBQWlCLGNBQWMsWUFBWSxNQUFNLFVBQVUsV0FBWSxPQUFNLElBQUksTUFBTSxrR0FBa0I7QUFDOUcsUUFBSSxVQUFVLGtCQUFrQixrQkFBa0IsUUFBUSxZQUFZLEVBQUcsT0FBTSxJQUFJLE1BQU0sa0VBQWdCO0FBQ3pHLFVBQU0sRUFBRSxNQUFNLE1BQU0sSUFBSSxNQUFNLE1BQU0sSUFBSSw0QkFBNEIsRUFBRSxXQUFXLFFBQVEsSUFBSSxTQUFTLFVBQVUsQ0FBQztBQUNqSCxRQUFJLE1BQU8sT0FBTSxJQUFJLE1BQU0sTUFBTSxPQUFPO0FBQ3hDLFVBQU0sa0JBQWtCLE9BQU8sTUFBTTtBQUNyQyxXQUFPLEVBQUUsUUFBUSxhQUFhLFNBQVMsUUFBUSxPQUFPLEtBQUs7QUFBQSxFQUM3RCxTQUFTLE9BQU87QUFDZCxVQUFNLFVBQVUsaUJBQWlCLFFBQVEsTUFBTSxVQUFVO0FBQ3pELFVBQU0sa0JBQWtCLE9BQU8sUUFBUSxPQUFPO0FBQzlDLFVBQU0sSUFBSSxNQUFNLEdBQUcsT0FBTyx5R0FBb0IsTUFBTSxRQUFHO0FBQUEsRUFDekQ7QUFDRjtBQUVBLGVBQWUsa0JBQ2IsT0FDQSxhQUNBLFFBQ2tDO0FBQ2xDLFFBQU0sRUFBRSxRQUFRLEtBQUssSUFBSSxNQUFNLGtCQUFrQixhQUFhLGFBQWE7QUFDM0UsUUFBTSxRQUFRLFVBQVUsS0FBSyxPQUFPLGNBQUk7QUFDeEMsUUFBTSxTQUFTLFVBQVUsS0FBSyxRQUFRLGNBQUk7QUFDMUMsUUFBTSxDQUFDLGNBQWMsYUFBYSxJQUFJLE1BQU0sUUFBUSxJQUFJO0FBQUEsSUFDdEQsaUJBQWlCLE9BQU8sS0FBSztBQUFBLElBQzdCLGlCQUFpQixPQUFPLE1BQU07QUFBQSxFQUNoQyxDQUFDO0FBQ0QsTUFBSSxhQUFhLE9BQU8sY0FBYyxHQUFJLE9BQU0sSUFBSSxNQUFNLHdEQUFXO0FBQ3JFLE1BQUksVUFBVSxPQUFPLE9BQU8sYUFBYSxNQUFNLE9BQU8sT0FBTyxjQUFjLEdBQUksT0FBTSxJQUFJLE1BQU0sb0VBQWE7QUFDNUcsUUFBTSxZQUFZO0FBQUEsSUFDaEI7QUFBQSxJQUNBLFNBQVMsT0FBTyxLQUFLLE9BQU8sRUFBRSxZQUFZO0FBQUEsSUFDMUMsU0FBUyxPQUFPLEtBQUssT0FBTztBQUFBLElBQzVCO0FBQUEsSUFDQTtBQUFBLElBQ0EsWUFBWSxVQUFVLEtBQUssWUFBWSwwQkFBTSxFQUFFLFlBQVk7QUFBQSxJQUMzRCxlQUFlLFVBQVUsS0FBSyxlQUFlLDBCQUFNLEVBQUUsWUFBWTtBQUFBLElBQ2pFLFVBQVUsT0FBTyxLQUFLLFFBQVE7QUFBQSxJQUM5QixPQUFPLE9BQU8sS0FBSyxLQUFLO0FBQUEsSUFDeEIsT0FBTyxPQUFPLEtBQUssS0FBSztBQUFBLElBQ3hCLEtBQUssT0FBTyxLQUFLLEdBQUc7QUFBQSxJQUNwQixrQkFBa0IsT0FBTyxLQUFLLGdCQUFnQjtBQUFBLEVBQ2hEO0FBQ0EsUUFBTSxtQkFBbUIsTUFBTSxnQkFBZ0IsT0FBTyxRQUFRLGdCQUFnQixhQUFhLElBQUksU0FBUztBQUN4RyxNQUFJLGlCQUFrQixRQUFPLEVBQUUsUUFBUSxhQUFhLFlBQVksTUFBTSxTQUFTLE9BQU87QUFDdEYsTUFBSTtBQUNGLFVBQU0sRUFBRSxNQUFNLE1BQU0sSUFBSSxNQUFNLE1BQU0sSUFBSSw0QkFBNEIsRUFBRSxTQUFTLFVBQVUsQ0FBQztBQUMxRixRQUFJLE1BQU8sT0FBTSxJQUFJLE1BQU0sTUFBTSxPQUFPO0FBQ3hDLFVBQU0sa0JBQWtCLE9BQU8sTUFBTTtBQUNyQyxXQUFPLEVBQUUsUUFBUSxhQUFhLFNBQVMsUUFBUSxNQUFNLEtBQUs7QUFBQSxFQUM1RCxTQUFTLE9BQU87QUFDZCxVQUFNLFVBQVUsaUJBQWlCLFFBQVEsTUFBTSxVQUFVO0FBQ3pELFVBQU0sa0JBQWtCLE9BQU8sUUFBUSxPQUFPO0FBQzlDLFVBQU0sSUFBSSxNQUFNLEdBQUcsT0FBTyx5R0FBb0IsTUFBTSxRQUFHO0FBQUEsRUFDekQ7QUFDRjtBQUVBLGVBQWUsb0JBQ2IsT0FDQSxhQUNBLFFBQ2tDO0FBQ2xDLFFBQU0sRUFBRSxRQUFRLEtBQUssSUFBSSxNQUFNLGtCQUFrQixhQUFhLGdCQUFnQjtBQUM5RSxRQUFNLFFBQVEsVUFBVSxLQUFLLE9BQU8sb0JBQUs7QUFDekMsUUFBTSxVQUFVLE1BQU0saUJBQWlCLE9BQU8sS0FBSztBQUNuRCxNQUFJLFVBQVUsT0FBTyxPQUFPLFFBQVEsR0FBSSxPQUFNLElBQUksTUFBTSxnRkFBZTtBQUN2RSxRQUFNLFlBQVk7QUFBQSxJQUNoQjtBQUFBLElBQ0EsU0FBUyxPQUFPLEtBQUssT0FBTztBQUFBLElBQzVCO0FBQUEsSUFDQSxnQkFBZ0IsT0FBTyxLQUFLLGNBQWM7QUFBQSxFQUM1QztBQUNBLFFBQU0sbUJBQW1CLE1BQU0sZ0JBQWdCLE9BQU8sUUFBUSxtQkFBbUIsUUFBUSxJQUFJLFNBQVM7QUFDdEcsTUFBSSxpQkFBa0IsUUFBTyxFQUFFLFFBQVEsYUFBYSxZQUFZLE1BQU0sU0FBUyxPQUFPO0FBQ3RGLE1BQUk7QUFDRixVQUFNLEVBQUUsTUFBTSxNQUFNLElBQUksTUFBTSxNQUFNLElBQUksOEJBQThCLEVBQUUsV0FBVyxRQUFRLElBQUksU0FBUyxVQUFVLENBQUM7QUFDbkgsUUFBSSxNQUFPLE9BQU0sSUFBSSxNQUFNLE1BQU0sT0FBTztBQUN4QyxVQUFNLGtCQUFrQixPQUFPLE1BQU07QUFDckMsV0FBTyxFQUFFLFFBQVEsYUFBYSxTQUFTLFFBQVEsT0FBTyxLQUFLO0FBQUEsRUFDN0QsU0FBUyxPQUFPO0FBQ2QsVUFBTSxVQUFVLGlCQUFpQixRQUFRLE1BQU0sVUFBVTtBQUN6RCxVQUFNLGtCQUFrQixPQUFPLFFBQVEsT0FBTztBQUM5QyxVQUFNLElBQUksTUFBTSxHQUFHLE9BQU8scUhBQXNCLE1BQU0sUUFBRztBQUFBLEVBQzNEO0FBQ0Y7QUFLQSxTQUFTLHNCQUFzQixPQUFxQztBQUNsRSxNQUFJLE9BQU8sVUFBVSxZQUFZLENBQUMsTUFBTSxLQUFLLEVBQUcsUUFBTztBQUN2RCxNQUFJO0FBQ0YsVUFBTSxPQUFPQSxZQUFXLE1BQU0sS0FBSyxDQUFDO0FBR3BDLFFBQUksU0FBUyw2Q0FBOEMsUUFBTztBQUNsRSxXQUFPO0FBQUEsRUFDVCxRQUFRO0FBQ04sV0FBTztBQUFBLEVBQ1Q7QUFDRjtBQXNCQSxTQUFTLGtCQUFrQixPQUF3QjtBQUNqRCxTQUFPQyxZQUFXLE9BQU8sU0FBUyxHQUFHLEdBQUcsWUFBWTtBQUN0RDtBQUVBLFNBQVMsd0JBQXdCLE9BQWUsVUFBMEI7QUFDeEUsTUFBSSxZQUFZLGFBQWMsUUFBTyxRQUFRLE9BQU8sT0FBTyxXQUFXLFlBQVk7QUFDbEYsU0FBTyxRQUFRLE9BQU8sT0FBTyxlQUFlLFFBQVE7QUFDdEQ7QUFFQSxlQUFlLDRCQUNiLE9BQ0EsUUFDQSxRQUNtQztBQUNuQyxRQUFNLGFBQWdHLENBQUM7QUFDdkcsUUFBTSxXQUFXO0FBQ2pCLFdBQVMsU0FBUyxLQUFLLFVBQVUsVUFBVTtBQUN6QyxVQUFNLEVBQUUsTUFBTSxNQUFNLElBQUksTUFBTSxNQUMzQixLQUFLLFdBQVcsRUFDaEIsT0FBTyw4QkFBOEIsRUFDckMsR0FBRyxXQUFXLE1BQU0sRUFDcEIsR0FBRyxjQUFjLENBQUMsR0FBRywwQkFBMEIsQ0FBQyxFQUNoRCxJQUFJLFlBQVksTUFBTSxJQUFJLEVBQzFCLE1BQU0sY0FBYyxFQUFFLFdBQVcsS0FBSyxDQUFDLEVBQ3ZDLE1BQU0sUUFBUSxTQUFTLFdBQVcsQ0FBQztBQUN0QyxRQUFJLE1BQU8sT0FBTSxJQUFJLE1BQU0scUVBQWMsTUFBTSxPQUFPLEVBQUU7QUFDeEQsVUFBTSxPQUFRLFFBQVEsQ0FBQztBQUN2QixlQUFXLEtBQUssR0FBRyxJQUFJO0FBQ3ZCLFFBQUksS0FBSyxTQUFTLFNBQVU7QUFBQSxFQUM5QjtBQUVBLFFBQU0sRUFBRSxNQUFNLFlBQVksT0FBTyxZQUFZLElBQUksTUFBTSxNQUNwRCxLQUFLLHFCQUFxQixFQUMxQixPQUFPLDJDQUEyQyxFQUNsRCxHQUFHLFVBQVUsY0FBYyxFQUMzQixHQUFHLFVBQVUsQ0FBQyxhQUFhLFNBQVMsQ0FBQyxFQUNyQyxHQUFHLFdBQVcsTUFBTTtBQUN2QixNQUFJLFlBQWEsT0FBTSxJQUFJLE1BQU0saUZBQWdCLFlBQVksT0FBTyxFQUFFO0FBRXRFLFFBQU0saUJBQWlCLG9CQUFJLElBQStDO0FBQzFFLFFBQU0sU0FBUyxJQUFJLEtBQUsscUJBQXFCLEVBQUUsUUFBUTtBQUN2RCxhQUFXLE9BQU8sWUFBWTtBQUM1QixRQUFJLENBQUMsSUFBSSxTQUFVO0FBQ25CLFVBQU0sU0FBUyxlQUFlLElBQUksSUFBSSxRQUFRLEtBQUssRUFBRSxRQUFRLElBQUksT0FBTyxHQUFHO0FBQzNFLFVBQU0sU0FBUyxrQkFBa0IsSUFBSSxRQUFRO0FBQzdDLFFBQUksSUFBSSxLQUFLLElBQUksVUFBVSxFQUFFLFFBQVEsSUFBSSxPQUFRLFFBQU8sVUFBVTtBQUFBLFFBQzdELFFBQU8sU0FBUztBQUNyQixtQkFBZSxJQUFJLElBQUksVUFBVSxNQUFNO0FBQUEsRUFDekM7QUFDQSxhQUFXLE9BQU8sY0FBYyxDQUFDLEdBQUc7QUFDbEMsUUFBSSxDQUFDLElBQUksU0FBVTtBQUNuQixVQUFNLFVBQVUsSUFBSTtBQUNwQixRQUFJLFFBQVEsY0FBYyxRQUFRLFFBQVEsY0FBYyxNQUFPO0FBQy9ELFVBQU0sU0FBUyxlQUFlLElBQUksSUFBSSxRQUFRLEtBQUssRUFBRSxRQUFRLElBQUksT0FBTyxHQUFHO0FBQzNFLFVBQU0sU0FBUyxrQkFBa0IsSUFBSSxVQUFVLFFBQVEsTUFBTTtBQUM3RCxRQUFJLElBQUksS0FBSyxJQUFJLFVBQVUsRUFBRSxRQUFRLElBQUksUUFBUTtBQUMvQyxVQUFJLElBQUksV0FBVyxZQUFhLFFBQU8sVUFBVTtBQUFBLElBQ25ELE9BQU87QUFFTCxhQUFPLFNBQVM7QUFBQSxJQUNsQjtBQUNBLG1CQUFlLElBQUksSUFBSSxVQUFVLE1BQU07QUFBQSxFQUN6QztBQUVBLFFBQU0sZUFBZSxNQUFNLEtBQUssZUFBZSxLQUFLLENBQUM7QUFDckQsUUFBTSxhQUFvSCxDQUFDO0FBQzNILFdBQVMsU0FBUyxHQUFHLFNBQVMsYUFBYSxRQUFRLFVBQVUsS0FBSztBQUNoRSxVQUFNLEVBQUUsTUFBTSxNQUFNLElBQUksTUFBTSxNQUMzQixLQUFLLG9CQUFvQixFQUN6QixPQUFPLG1DQUFtQyxFQUMxQyxHQUFHLE1BQU0sYUFBYSxNQUFNLFFBQVEsU0FBUyxHQUFHLENBQUM7QUFDcEQsUUFBSSxNQUFPLE9BQU0sSUFBSSxNQUFNLHFFQUFjLE1BQU0sT0FBTyxFQUFFO0FBQ3hELGVBQVcsS0FBSyxHQUFLLFFBQVEsQ0FBQyxDQUF3QjtBQUFBLEVBQ3hEO0FBQ0EsUUFBTSxnQkFBZ0IsSUFBSSxJQUFJLFdBQVcsSUFBSSxDQUFDLGNBQWMsQ0FBQyxVQUFVLElBQUksU0FBUyxDQUFDLENBQUM7QUFFdEYsUUFBTSxVQUFVLG9CQUFJLElBT2pCO0FBQ0gsYUFBVyxDQUFDLFNBQVMsTUFBTSxLQUFLLGdCQUFnQjtBQUM5QyxVQUFNLFlBQVksY0FBYyxJQUFJLE9BQU87QUFDM0MsVUFBTSxPQUFPLFdBQVcsZ0JBQWdCO0FBQ3hDLFVBQU0sZUFBZSxPQUNqQixrQkFBa0IsVUFDbEIsc0JBQXNCLFdBQVcsYUFBYSxLQUFLO0FBQ3ZELFVBQU0sV0FBVyxPQUNiLHNCQUNBLGVBQ0UsY0FBYyxhQUFhLFlBQVksQ0FBQyxLQUN4Qyx3QkFBd0IsT0FBTztBQUNyQyxVQUFNLFVBQVUsUUFBUSxJQUFJLFFBQVEsS0FBSztBQUFBLE1BQ3ZDO0FBQUEsTUFDQSxPQUFPLE9BQU8sb0JBQVUsV0FBVyxRQUFRO0FBQUEsTUFDM0MsTUFBTSxPQUFPLE9BQU87QUFBQSxNQUNwQjtBQUFBLE1BQ0EsUUFBUTtBQUFBLE1BQ1IsT0FBTztBQUFBLElBQ1Q7QUFDQSxZQUFRLFVBQVUsT0FBTztBQUN6QixZQUFRLFNBQVMsT0FBTztBQUN4QixZQUFRLElBQUksVUFBVSxPQUFPO0FBQUEsRUFDL0I7QUFFQSxRQUFNLEVBQUUsTUFBTSxnQkFBZ0IsT0FBTyxnQkFBZ0IsSUFBSSxNQUFNLE1BQzVELEtBQUsscUJBQXFCLEVBQzFCLE9BQU8sZ0NBQWdDLEVBQ3ZDLEdBQUcsVUFBVSxtQkFBbUIsRUFDaEMsR0FBRyxXQUFXLE1BQU07QUFDdkIsTUFBSSxnQkFBaUIsT0FBTSxJQUFJLE1BQU0seURBQVksZ0JBQWdCLE9BQU8sRUFBRTtBQUMxRSxRQUFNLHFCQUFxQixvQkFBSSxJQUF3SDtBQUN2SixhQUFXLE9BQVEsa0JBQWtCLENBQUMsR0FBa0g7QUFDdEosVUFBTSxNQUFNLE9BQU8sSUFBSSxZQUFZLEVBQUU7QUFDckMsdUJBQW1CLElBQUksS0FBSyxDQUFDLEdBQUksbUJBQW1CLElBQUksR0FBRyxLQUFLLENBQUMsR0FBSSxHQUFHLENBQUM7QUFBQSxFQUMzRTtBQUVBLFNBQU8sUUFBUSxJQUFJLE1BQU0sS0FBSyxRQUFRLE9BQU8sQ0FBQyxFQUFFLElBQUksT0FBTyxVQUFrRDtBQUMzRyxRQUFJLE1BQU0sVUFBVSxHQUFJLFFBQU87QUFDL0IsVUFBTSxjQUFjLG1CQUFtQixJQUFJLE1BQU0sUUFBUSxLQUFLLENBQUM7QUFDL0QsVUFBTSxZQUFZLFlBQVksT0FBTyxDQUFDLFFBQVEsSUFBSSxXQUFXLFdBQVc7QUFDeEUsVUFBTSxVQUFVLFlBQVksS0FBSyxDQUFDLFFBQVEsSUFBSSxXQUFXLFNBQVM7QUFDbEUsVUFBTSxTQUFTLFNBQVMsV0FBVyxVQUFVLFVBQVUsU0FBUyxDQUFDLEdBQUcsV0FBVztBQUMvRSxRQUFJLENBQUMsTUFBTSxjQUFjO0FBQ3ZCLGFBQU87QUFBQSxRQUNMLFVBQVUsTUFBTTtBQUFBLFFBQVUsT0FBTyxNQUFNO0FBQUEsUUFBTyxNQUFNLE1BQU07QUFBQSxRQUFNLGNBQWM7QUFBQSxRQUM5RSxVQUFVO0FBQUEsUUFBTSxXQUFXRixhQUFZLE1BQU0sUUFBUSxZQUFZO0FBQUEsUUFBRyxlQUFlO0FBQUEsUUFDbkYsY0FBYztBQUFBLFFBQUssV0FBVztBQUFBLFFBQUssUUFBUTtBQUFBLFFBQUssUUFBUTtBQUFBLFFBQVk7QUFBQSxNQUN0RTtBQUFBLElBQ0Y7QUFFQSxRQUFJO0FBQ0YsWUFBTSxRQUFRLE1BQU0seUJBQXlCLE1BQU0sY0FBYyxNQUFNO0FBQ3ZFLFlBQU0sV0FBVyxNQUFNO0FBQ3ZCLFlBQU0sV0FBVyx3QkFBd0IsTUFBTSxRQUFRLFFBQVE7QUFDL0QsWUFBTSxhQUFhLHdCQUF3QixNQUFNLFFBQVEsS0FBSyxNQUFNLFFBQVEsSUFBSSxRQUFRO0FBQ3hGLFlBQU0saUJBQWlCLFVBQVUsT0FBTyxDQUFDLEtBQUssUUFBUTtBQUNwRCxZQUFJLENBQUMsSUFBSSxPQUFRLFFBQU87QUFDeEIsWUFBSTtBQUNGLGlCQUFPLE1BQU1FLFlBQVcsT0FBTyxJQUFJLE1BQU0sR0FBRyxRQUFRO0FBQUEsUUFDdEQsUUFBUTtBQUNOLGlCQUFPO0FBQUEsUUFDVDtBQUFBLE1BQ0YsR0FBRyxFQUFFO0FBQ0wsWUFBTSxlQUFlLFdBQVcsaUJBQWlCLFdBQVcsaUJBQWlCO0FBQzdFLFlBQU0sZUFBZUEsWUFBVyxNQUFNLFNBQVMsUUFBUTtBQUN2RCxZQUFNLGlCQUFpQixlQUFlLGFBQWEsZUFBZSxhQUFhO0FBQy9FLFlBQU0sZUFBZSxlQUFlLGlCQUFpQixlQUFlO0FBQ3BFLFlBQU0sU0FBMkMsVUFDN0MsWUFDQSxpQkFBaUIsTUFBTSxpQkFBaUIsS0FDdEMsYUFDQSxlQUFlLEtBQ2IsVUFDQTtBQUNSLGFBQU87QUFBQSxRQUNMLFVBQVUsTUFBTTtBQUFBLFFBQ2hCLE9BQU8sTUFBTTtBQUFBLFFBQ2IsTUFBTSxNQUFNO0FBQUEsUUFDWixjQUFjLE1BQU07QUFBQSxRQUNwQjtBQUFBLFFBQ0EsV0FBV0YsYUFBWSxVQUFVLFFBQVE7QUFBQSxRQUN6QyxlQUFlQSxhQUFZLFlBQVksUUFBUTtBQUFBLFFBQy9DLGNBQWMsTUFBTTtBQUFBLFFBQ3BCLFdBQVdBLGFBQVksZ0JBQWdCLFFBQVE7QUFBQSxRQUMvQyxRQUFRLFdBQVcsVUFBVUEsYUFBWSxjQUFjLFFBQVEsSUFBSTtBQUFBLFFBQ25FO0FBQUEsUUFDQTtBQUFBLE1BQ0Y7QUFBQSxJQUNGLFFBQVE7QUFDTixhQUFPO0FBQUEsUUFDTCxVQUFVLE1BQU07QUFBQSxRQUFVLE9BQU8sTUFBTTtBQUFBLFFBQU8sTUFBTSxNQUFNO0FBQUEsUUFBTSxjQUFjLE1BQU07QUFBQSxRQUNwRixVQUFVO0FBQUEsUUFBTSxXQUFXQSxhQUFZLE1BQU0sUUFBUSxZQUFZO0FBQUEsUUFBRyxlQUFlO0FBQUEsUUFDbkYsY0FBYztBQUFBLFFBQUssV0FBVztBQUFBLFFBQUssUUFBUTtBQUFBLFFBQUssUUFBUTtBQUFBLFFBQWU7QUFBQSxNQUN6RTtBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxTQUFTLEtBQUssT0FBTyxDQUFDLFFBQXVDLE9BQU8sSUFBSSxDQUFDO0FBQ3JGO0FBRUEsZUFBZSwrQkFBK0IsT0FBdUIsUUFBK0I7QUFDbEcsUUFBTSxFQUFFLE1BQU0sTUFBTSxJQUFJLE1BQU0sTUFDM0IsS0FBSyxxQkFBcUIsRUFDMUIsT0FBTyx1QkFBdUIsRUFDOUIsR0FBRyxVQUFVLG1CQUFtQixFQUNoQyxHQUFHLFdBQVcsTUFBTSxFQUNwQixHQUFHLFVBQVUsU0FBUyxFQUN0QixNQUFNLEdBQUc7QUFDWixNQUFJLE1BQU8sT0FBTSxJQUFJLE1BQU0scUVBQWMsTUFBTSxPQUFPLEVBQUU7QUFFeEQsUUFBTSxjQUFjLEtBQUssSUFBSSxJQUFJLElBQUk7QUFDckMsUUFBTSxRQUFRLEtBQUssUUFBUSxDQUFDLEdBQUcsSUFBSSxPQUFPLFFBQVE7QUFDaEQsUUFBSSxhQUFpRDtBQUNyRCxRQUFJLGNBQTZCO0FBQ2pDLFFBQUksSUFBSSxTQUFTO0FBQ2YsbUJBQWEsTUFBTSxrQ0FBa0MsSUFBSSxPQUF3QjtBQUNqRixVQUFJLGVBQWUsU0FBVSxlQUFjO0FBQUEsSUFDN0MsV0FBVyxJQUFJLEtBQUssSUFBSSxVQUFVLEVBQUUsUUFBUSxJQUFJLGFBQWE7QUFDM0QsbUJBQWE7QUFDYixvQkFBYztBQUFBLElBQ2hCO0FBQ0EsUUFBSSxlQUFlLFVBQVc7QUFDOUIsVUFBTSxFQUFFLE9BQU8sWUFBWSxJQUFJLE1BQU0sTUFDbEMsS0FBSyxxQkFBcUIsRUFDMUIsT0FBTyxFQUFFLFFBQVEsWUFBWSxPQUFPLGFBQWEsYUFBWSxvQkFBSSxLQUFLLEdBQUUsWUFBWSxFQUFFLENBQUMsRUFDdkYsR0FBRyxNQUFNLElBQUksRUFBRSxFQUNmLEdBQUcsV0FBVyxNQUFNLEVBQ3BCLEdBQUcsVUFBVSxTQUFTO0FBQ3pCLFFBQUksWUFBYSxPQUFNLElBQUksTUFBTSxxRUFBYyxZQUFZLE9BQU8sRUFBRTtBQUFBLEVBQ3RFLENBQUMsQ0FBQztBQUNKO0FBS0EsZUFBZSxnQkFBZ0IsVUFBNEM7QUFDekUsTUFBSTtBQUNGLFVBQU0saUJBQWlCO0FBQ3ZCLFdBQU87QUFBQSxFQUNULFNBQVMsR0FBRztBQUNWLElBQUFHLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyxPQUFPLENBQUMsRUFBRSxDQUFDO0FBQ3hDLFdBQU87QUFBQSxFQUNUO0FBQ0Y7QUFNQSxlQUFlLDhCQUNiLE9BQ0EsVUFDQSxTQUNrQjtBQUNsQixRQUFNLEVBQUUsTUFBTSxVQUFVLElBQUksTUFBTSxNQUMvQixLQUFLLG9CQUFvQixFQUN6QixPQUFPLDBCQUEwQixFQUNqQyxHQUFHLE1BQU0sT0FBTyxFQUNoQixZQUFZO0FBQ2YsTUFBSSxDQUFDLFdBQVc7QUFDZCxJQUFBQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sK0RBQWEsQ0FBQztBQUMzQyxXQUFPO0FBQUEsRUFDVDtBQUNBLE1BQUksVUFBVSxhQUFhO0FBQ3pCLElBQUFBLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyw2SUFBMEIsQ0FBQztBQUN4RCxXQUFPO0FBQUEsRUFDVDtBQUNBLE1BQUksVUFBVSxjQUFjLE9BQU87QUFDakMsSUFBQUEsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLCtKQUE2QixDQUFDO0FBQzNELFdBQU87QUFBQSxFQUNUO0FBQ0EsU0FBTztBQUNUO0FBSUEsZUFBZSxnQkFDYixPQUNBLEtBVWlGO0FBQ2pGLFFBQU0sV0FBVyxNQUFNLE1BQ3BCLEtBQUsscUJBQXFCLEVBQzFCLE9BQU8sbUJBQW1CLEVBQzFCLEdBQUcsV0FBVyxJQUFJLE9BQU8sRUFDekIsWUFBWTtBQUNmLE1BQUksU0FBUyxNQUFPLE9BQU0sSUFBSSxNQUFNLHFFQUFjLFNBQVMsTUFBTSxPQUFPLEVBQUU7QUFDMUUsTUFBSSxTQUFTLE1BQU07QUFDakIsUUFBSSxTQUFTLEtBQUssV0FBVyxVQUFVO0FBQ3JDLFlBQU0sVUFBVSxNQUFNLE1BQ25CLEtBQUsscUJBQXFCLEVBQzFCLE9BQU8sRUFBRSxRQUFRLFdBQVcsT0FBTyxNQUFNLGFBQVksb0JBQUksS0FBSyxHQUFFLFlBQVksRUFBRSxDQUFDLEVBQy9FLEdBQUcsTUFBTSxTQUFTLEtBQUssRUFBRSxFQUN6QixHQUFHLFVBQVUsUUFBUSxFQUNyQixPQUFPLElBQUksRUFDWCxZQUFZO0FBQ2YsVUFBSSxRQUFRLE1BQU8sT0FBTSxJQUFJLE1BQU0sK0RBQWEsUUFBUSxNQUFNLE9BQU8sRUFBRTtBQUN2RSxVQUFJLFFBQVEsS0FBTSxRQUFPLEVBQUUsSUFBSSxRQUFRLEtBQUssR0FBRztBQUMvQyxZQUFNLFNBQVMsTUFBTSxNQUNsQixLQUFLLHFCQUFxQixFQUMxQixPQUFPLGdCQUFnQixFQUN2QixHQUFHLE1BQU0sU0FBUyxLQUFLLEVBQUUsRUFDekIsWUFBWTtBQUNmLFVBQUksT0FBTyxTQUFTLENBQUMsT0FBTyxNQUFNO0FBQ2hDLGNBQU0sSUFBSSxNQUFNLHFFQUFjLE9BQU8sT0FBTyxXQUFXLDRDQUFTLEVBQUU7QUFBQSxNQUNwRTtBQUNBLGFBQU8sRUFBRSxNQUFNLEVBQUUsUUFBUSxPQUFPLEtBQUssUUFBUSxTQUFTLE9BQU8sS0FBSyxRQUFRLEVBQUU7QUFBQSxJQUM5RTtBQUNBLFdBQU8sRUFBRSxNQUFNLEVBQUUsUUFBUSxTQUFTLEtBQUssUUFBUSxTQUFTLFNBQVMsS0FBSyxRQUFRLEVBQUU7QUFBQSxFQUNsRjtBQUNBLFFBQU0sV0FBVyxNQUFNLE1BQ3BCLEtBQUsscUJBQXFCLEVBQzFCLE9BQU8sRUFBRSxHQUFHLEtBQUssUUFBUSxVQUFVLENBQUMsRUFDcEMsT0FBTyxJQUFJLEVBQ1gsT0FBTztBQUNWLE1BQUksU0FBUyxTQUFTLENBQUMsU0FBUyxNQUFNO0FBRXBDLFVBQU0sUUFBUSxNQUFNLE1BQ2pCLEtBQUsscUJBQXFCLEVBQzFCLE9BQU8sbUJBQW1CLEVBQzFCLEdBQUcsV0FBVyxJQUFJLE9BQU8sRUFDekIsWUFBWTtBQUNmLFFBQUksTUFBTSxNQUFNO0FBQ2QsVUFBSSxNQUFNLEtBQUssV0FBVyxVQUFVO0FBQ2xDLGNBQU0sVUFBVSxNQUFNLE1BQ25CLEtBQUsscUJBQXFCLEVBQzFCLE9BQU8sRUFBRSxRQUFRLFdBQVcsT0FBTyxNQUFNLGFBQVksb0JBQUksS0FBSyxHQUFFLFlBQVksRUFBRSxDQUFDLEVBQy9FLEdBQUcsTUFBTSxNQUFNLEtBQUssRUFBRSxFQUN0QixHQUFHLFVBQVUsUUFBUSxFQUNyQixPQUFPLElBQUksRUFDWCxZQUFZO0FBQ2YsWUFBSSxRQUFRLE1BQU8sT0FBTSxJQUFJLE1BQU0sK0RBQWEsUUFBUSxNQUFNLE9BQU8sRUFBRTtBQUN2RSxZQUFJLFFBQVEsS0FBTSxRQUFPLEVBQUUsSUFBSSxRQUFRLEtBQUssR0FBRztBQUFBLE1BQ2pEO0FBQ0EsWUFBTSxTQUFTLE1BQU0sTUFDbEIsS0FBSyxxQkFBcUIsRUFDMUIsT0FBTyxnQkFBZ0IsRUFDdkIsR0FBRyxNQUFNLE1BQU0sS0FBSyxFQUFFLEVBQ3RCLFlBQVk7QUFDZixVQUFJLE9BQU8sU0FBUyxDQUFDLE9BQU8sTUFBTTtBQUNoQyxjQUFNLElBQUksTUFBTSxxRUFBYyxPQUFPLE9BQU8sV0FBVyw0Q0FBUyxFQUFFO0FBQUEsTUFDcEU7QUFDQSxhQUFPLEVBQUUsTUFBTSxFQUFFLFFBQVEsT0FBTyxLQUFLLFFBQVEsU0FBUyxPQUFPLEtBQUssUUFBUSxFQUFFO0FBQUEsSUFDOUU7QUFJQSxVQUFNLElBQUk7QUFBQSxNQUNSLGdFQUFtQixJQUFJLE1BQU0sZUFBSyxTQUFTLE9BQU8sV0FBVywwQkFBTTtBQUFBLElBQ3JFO0FBQUEsRUFDRjtBQUNBLFNBQU8sRUFBRSxJQUFJLFNBQVMsS0FBSyxHQUFHO0FBQ2hDO0FBRUEsZUFBZSxPQUNiLE9BQ0EsSUFDQSxPQUNBO0FBQ0EsUUFBTSxFQUFFLE1BQU0sTUFBTSxJQUFJLE1BQU0sTUFDM0IsS0FBSyxxQkFBcUIsRUFDMUIsT0FBTztBQUFBLElBQ04sR0FBRztBQUFBLElBQ0gsR0FBSSxNQUFNLFdBQVcsY0FBYyxFQUFFLE9BQU8sS0FBSyxJQUFJLENBQUM7QUFBQSxJQUN0RCxhQUFZLG9CQUFJLEtBQUssR0FBRSxZQUFZO0FBQUEsRUFDckMsQ0FBQyxFQUNBLEdBQUcsTUFBTSxFQUFFLEVBQ1gsT0FBTyxJQUFJLEVBQ1gsWUFBWTtBQUNmLE1BQUksU0FBUyxDQUFDLE1BQU07QUFDbEIsVUFBTSxJQUFJLE1BQU0seURBQVksT0FBTyxXQUFXLDRDQUFTLEVBQUU7QUFBQSxFQUMzRDtBQUNGO0FBS0EsZUFBZSxzQkFDYixPQUNBLElBQ2tDO0FBQ2xDLFFBQU0sRUFBRSxNQUFNLE1BQU0sSUFBSSxNQUFNLE1BQzNCLEtBQUsscUJBQXFCLEVBQzFCLE9BQU8sU0FBUyxFQUNoQixHQUFHLE1BQU0sRUFBRSxFQUNYLFlBQVk7QUFDZixNQUFJLFNBQVMsQ0FBQyxLQUFNLE9BQU0sSUFBSSxNQUFNLHlEQUFZLE9BQU8sV0FBVyw0Q0FBUyxFQUFFO0FBQzdFLFFBQU0sVUFBVyxNQUF1QztBQUN4RCxTQUFPLFdBQVcsT0FBTyxZQUFZLFdBQVksVUFBc0MsQ0FBQztBQUMxRjtBQUVBLGVBQWUsdUJBQ2IsT0FDQSxJQUNBLE9BQ2U7QUFDZixRQUFNLFVBQVUsTUFBTSxzQkFBc0IsT0FBTyxFQUFFO0FBQ3JELFFBQU0sRUFBRSxNQUFNLE1BQU0sSUFBSSxNQUFNLE1BQzNCLEtBQUsscUJBQXFCLEVBQzFCLE9BQU8sRUFBRSxTQUFTLEVBQUUsR0FBRyxTQUFTLEdBQUcsTUFBTSxHQUFHLGFBQVksb0JBQUksS0FBSyxHQUFFLFlBQVksRUFBRSxDQUFDLEVBQ2xGLEdBQUcsTUFBTSxFQUFFLEVBQ1gsT0FBTyxJQUFJLEVBQ1gsWUFBWTtBQUNmLE1BQUksU0FBUyxDQUFDLE1BQU07QUFDbEIsVUFBTSxJQUFJLE1BQU0scUVBQWMsT0FBTyxXQUFXLDRDQUFTLEVBQUU7QUFBQSxFQUM3RDtBQUNGO0FBRUEsZUFBZSxrQkFDYixPQUNBLGNBQ0EsU0FDQSxLQUNBLFFBQ3dCO0FBQ3hCLFFBQU0sWUFBWSxPQUFPLFFBQVEsR0FBRyxNQUFNLFdBQVcsUUFBUSxHQUFHLElBQXFCO0FBQ3JGLE1BQUksV0FBVztBQUNiLFFBQUksUUFBUSxNQUFNLDBCQUEwQixTQUFTO0FBQ3JELFFBQUksVUFBVSxZQUFhLFFBQU87QUFDbEMsUUFBSSxVQUFVLFlBQVk7QUFDeEIsVUFBSTtBQUNGLGNBQU0sd0JBQXdCLFNBQVM7QUFDdkMsZUFBTztBQUFBLE1BQ1QsU0FBUyxPQUFPO0FBQ2QsZ0JBQVEsTUFBTSwwQkFBMEIsU0FBUztBQUNqRCxZQUFJLFVBQVUsWUFBWTtBQUN4QixnQkFBTSxJQUFJO0FBQUEsWUFDUiw0QkFBUSxTQUFTLGdLQUE4QixPQUFPLEtBQUssQ0FBQztBQUFBLFVBQzlEO0FBQUEsUUFDRjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQ0EsVUFBTSx1QkFBdUIsT0FBTyxjQUFjLEVBQUUsQ0FBQyxHQUFHLEdBQUcsS0FBSyxDQUFDO0FBQ2pFLFlBQVEsR0FBRyxJQUFJO0FBQUEsRUFDakI7QUFFQSxNQUFJLGdCQUFzQztBQUMxQyxRQUFNLFNBQVMsTUFBTSxPQUFPLE9BQU8sU0FBUztBQUMxQyxVQUFNLHVCQUF1QixPQUFPLGNBQWMsRUFBRSxDQUFDLEdBQUcsR0FBRyxLQUFLLENBQUM7QUFDakUsWUFBUSxHQUFHLElBQUk7QUFDZixvQkFBZ0I7QUFBQSxFQUNsQixDQUFDO0FBQ0QsU0FBTyxVQUFVO0FBQ25CO0FBTUEsZUFBZSxpQkFDYixPQUNBLFVBQ0EsV0FDZTtBQUNmLFFBQU0sRUFBRSxNQUFNLGFBQWEsSUFBSSxNQUFNLE1BQ2xDLEtBQUssVUFBVSxFQUNmLE9BQU8sZ0JBQWdCLEVBQ3ZCLEdBQUcsTUFBTSxVQUFVLE9BQU8sRUFDMUIsWUFBWTtBQUNmLE1BQUk7QUFDSixNQUFJO0FBQ0YsYUFBUyxVQUFVLGNBQWMsZ0JBQWdCLGdDQUFPO0FBQUEsRUFDMUQsU0FBUyxHQUFHO0FBQ1YsV0FBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLE9BQU8sQ0FBQyxFQUFFLENBQUM7QUFBQSxFQUNqRDtBQUNBLFFBQU0sU0FBUyxPQUFPLFVBQVUsTUFBTTtBQUN0QyxNQUFJLEVBQUUsU0FBUyxHQUFJLFFBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyw4QkFBVSxDQUFDO0FBQ2xFLE1BQUksQ0FBRSxNQUFNLGdCQUFnQixRQUFRLEVBQUk7QUFFeEMsUUFBTSxRQUFRLE1BQU0sZ0JBQWdCLE9BQU87QUFBQSxJQUN6QyxRQUFRO0FBQUEsSUFDUixTQUFTLFdBQVcsVUFBVSxFQUFFO0FBQUEsSUFDaEMsU0FBUyxVQUFVO0FBQUEsSUFDbkI7QUFBQSxJQUNBLFNBQVMsRUFBRSxPQUFPO0FBQUEsRUFDcEIsQ0FBQztBQUNELE1BQUksVUFBVSxNQUFPLFFBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsR0FBRyxNQUFNLE1BQU0sWUFBWSxLQUFLLENBQUM7QUFDbkYsTUFBSTtBQUNGLFVBQU0sU0FBUyxNQUFNLE9BQU8sUUFBUSxNQUFNO0FBQzFDLFVBQU0sT0FBTyxPQUFPLE1BQU0sSUFBSSxFQUFFLFFBQVEsYUFBYSxTQUFTLE9BQU8sQ0FBQztBQUN0RSxXQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLFFBQVEsYUFBYSxTQUFTLFFBQVEsT0FBTyxDQUFDO0FBQUEsRUFDN0UsU0FBUyxHQUFHO0FBQ1YsVUFBTSxPQUFPLE9BQU8sTUFBTSxJQUFJLEVBQUUsUUFBUSxVQUFVLE9BQU8sT0FBTyxDQUFDLEVBQUUsQ0FBQztBQUNwRSxXQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sNkNBQVUsT0FBTyxDQUFDLENBQUMsR0FBRyxDQUFDO0FBQUEsRUFDN0Q7QUFDRjtBQUVBLGVBQWUsb0JBQ2IsT0FDQSxVQUNBLFdBUWU7QUFDZixRQUFNLFlBQVksTUFBTSxNQUNyQixLQUFLLG9CQUFvQixFQUN6QixPQUFPLGdCQUFnQixFQUN2QixHQUFHLE1BQU0sVUFBVSxRQUFRLEVBQzNCLFlBQVk7QUFDZixRQUFNLE9BQU8sQ0FBQyxDQUFDLFVBQVUsTUFBTTtBQUMvQixRQUFNLGVBQWUsT0FDakIsU0FDQyxNQUFNLDBCQUEwQixVQUFVLFFBQVEsS0FBTTtBQUM3RCxRQUFNLFFBQVEsT0FBTyxVQUFVLFFBQVE7QUFDdkMsUUFBTSxRQUFRO0FBQUEsSUFDWCxVQUFVLFVBQXdDLFNBQVMsS0FBSyxJQUFJLE9BQU8sVUFBVSxNQUFNLENBQUM7QUFBQSxFQUMvRjtBQUNBLE1BQUksRUFBRSxRQUFRLE1BQU0sRUFBRSxRQUFRLEdBQUksUUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLHlEQUFZLENBQUM7QUFDbkYsUUFBTSxFQUFFLE1BQU0sYUFBYSxJQUFJLE1BQU0sTUFDbEMsS0FBSyxVQUFVLEVBQ2YsT0FBTyxnQkFBZ0IsRUFDdkIsR0FBRyxNQUFNLFVBQVUsT0FBTyxFQUMxQixZQUFZO0FBQ2YsTUFBSTtBQUNKLE1BQUk7QUFDRixhQUFTLFVBQVUsY0FBYyxnQkFBZ0IsZ0NBQU87QUFBQSxFQUMxRCxTQUFTLEdBQUc7QUFDVixXQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sT0FBTyxDQUFDLEVBQUUsQ0FBQztBQUFBLEVBQ2pEO0FBQ0EsTUFBSSxDQUFFLE1BQU0sOEJBQThCLE9BQU8sVUFBVSxPQUFPLFVBQVUsUUFBUSxDQUFDLEVBQUk7QUFDekYsTUFBSSxDQUFFLE1BQU0sZ0JBQWdCLFFBQVEsRUFBSTtBQUV4QyxRQUFNLFFBQVEsTUFBTSxnQkFBZ0IsT0FBTztBQUFBLElBQ3pDLFFBQVE7QUFBQSxJQUNSLFNBQVMsYUFBYSxVQUFVLEVBQUU7QUFBQSxJQUNsQyxTQUFTLFVBQVU7QUFBQSxJQUNuQixVQUFVLFVBQVU7QUFBQSxJQUNwQixRQUFRO0FBQUEsSUFDUixTQUFTO0FBQUEsSUFDVCxTQUFTLEVBQUUsUUFBUSxNQUFNLGNBQWMsZ0JBQWdCLEtBQUs7QUFBQSxFQUM5RCxDQUFDO0FBQ0QsTUFBSSxVQUFVLE1BQU8sUUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxHQUFHLE1BQU0sTUFBTSxZQUFZLEtBQUssQ0FBQztBQUNuRixNQUFJO0FBQ0YsVUFBTSxVQUFVLE1BQU0sc0JBQXNCLE9BQU8sTUFBTSxFQUFFO0FBQzNELFVBQU0sa0JBQWtCLE9BQU8sUUFBUSxhQUFhO0FBQ3BELFFBQUksaUJBQWlCO0FBQ25CLFlBQU0sU0FBUyxNQUFNO0FBQUEsUUFBa0I7QUFBQSxRQUFPLE1BQU07QUFBQSxRQUFJO0FBQUEsUUFBUztBQUFBLFFBQVksQ0FBQyxnQkFDNUUsZUFBZSxRQUFRLE9BQU8sV0FBVztBQUFBLE1BQzNDO0FBQ0EsVUFBSSxDQUFDLE9BQVEsT0FBTSxJQUFJLE1BQU0sa0hBQXdCO0FBRXJELFVBQUksT0FBTyxRQUFRLG9CQUFvQixVQUFVO0FBQy9DLGNBQU0sYUFBYSxPQUFPLGtCQUFrQixVQUFVO0FBQ3RELFlBQUksWUFBWTtBQUNkLGdCQUFNLGNBQWMsTUFBTTtBQUFBLFlBQ3hCO0FBQUEsWUFDQTtBQUFBLFlBQ0E7QUFBQSxZQUNBLFFBQVE7QUFBQSxZQUNSLENBQUM7QUFBQSxVQUNIO0FBQ0EsY0FBSSxhQUFhO0FBQ2Ysa0JBQU0sdUJBQXVCLE9BQU8sTUFBTSxJQUFJO0FBQUEsY0FDNUMsaUJBQWlCO0FBQUEsY0FDakIsd0JBQXdCO0FBQUEsWUFDMUIsQ0FBQztBQUNELG9CQUFRLGtCQUFrQjtBQUFBLFVBQzVCO0FBQUEsUUFDRjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBRUEsVUFBTSxVQUFVLE1BQU07QUFBQSxNQUFrQjtBQUFBLE1BQU8sTUFBTTtBQUFBLE1BQUk7QUFBQSxNQUFTO0FBQUEsTUFBZSxDQUFDLGdCQUNoRixrQkFDSSxjQUFjLE9BQU8sV0FBVyxJQUNoQyxpQkFBaUIsUUFBUSxPQUFPLFdBQVc7QUFBQSxJQUNqRDtBQUNBLFFBQUksQ0FBQyxRQUFTLE9BQU0sSUFBSSxNQUFNLCtGQUF5QjtBQUV2RCxVQUFNLFVBQVUsTUFBTTtBQUFBLE1BQWtCO0FBQUEsTUFBTyxNQUFNO0FBQUEsTUFBSTtBQUFBLE1BQVM7QUFBQSxNQUFtQixDQUFDLGdCQUNwRixPQUNJLHNCQUFzQixRQUFRLE9BQU8sV0FBVyxJQUNoRCxvQkFBb0IsUUFBUSxPQUFPLFFBQVcsY0FBYyxXQUFXO0FBQUEsSUFDN0U7QUFDQSxRQUFJLENBQUMsUUFBUyxPQUFNLElBQUksTUFBTSxrR0FBa0I7QUFFaEQsVUFBTSxPQUFPLE9BQU8sTUFBTSxJQUFJLEVBQUUsUUFBUSxhQUFhLFNBQVMsUUFBUSxDQUFDO0FBSXZFLFVBQU0sMkJBQTJCLE9BQU8sVUFBVSxFQUFFLEVBQUUsTUFBTSxNQUFNO0FBQUEsSUFBQyxDQUFDO0FBQ3BFLFdBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsUUFBUSxhQUFhLFNBQVMsU0FBUyxPQUFPLFNBQVMsTUFBTSxDQUFDO0FBQUEsRUFDN0YsU0FBUyxHQUFHO0FBQ1YsVUFBTSxPQUFPLE9BQU8sTUFBTSxJQUFJLEVBQUUsUUFBUSxVQUFVLE9BQU8sT0FBTyxDQUFDLEVBQUUsQ0FBQztBQUNwRSxXQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8seURBQVksT0FBTyxDQUFDLENBQUMsR0FBRyxDQUFDO0FBQUEsRUFDL0Q7QUFDRjtBQVNBLGVBQWUscUJBQ2IsT0FDQSxVQUNBLE9BQ2U7QUFDZixNQUFJO0FBQ0osTUFBSTtBQUNGLGFBQVMsVUFBVSxNQUFNLGdCQUFnQixnQ0FBTztBQUFBLEVBQ2xELFNBQVMsR0FBRztBQUNWLFdBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyxPQUFPLENBQUMsRUFBRSxDQUFDO0FBQUEsRUFDakQ7QUFDQSxRQUFNLFdBQVcsT0FBTyxNQUFNLFNBQVM7QUFDdkMsUUFBTSxhQUFhLE9BQU8sTUFBTSxXQUFXO0FBQzNDLE1BQUksRUFBRSxXQUFXLE1BQU0sRUFBRSxhQUFhLEdBQUksUUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLHVDQUFTLENBQUM7QUFDeEYsTUFBSSxDQUFFLE1BQU0sZ0JBQWdCLFFBQVEsRUFBSTtBQUV4QyxRQUFNLFFBQVEsTUFBTSxnQkFBZ0IsT0FBTztBQUFBLElBQ3pDLFFBQVE7QUFBQSxJQUNSLFNBQVMsVUFBVSxNQUFNLEVBQUU7QUFBQSxJQUMzQixTQUFTLE1BQU07QUFBQSxJQUNmLFFBQVE7QUFBQSxJQUNSLFNBQVM7QUFBQSxJQUNULFNBQVMsRUFBRSxPQUFPO0FBQUEsRUFDcEIsQ0FBQztBQUNELE1BQUksVUFBVSxNQUFPLFFBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsR0FBRyxNQUFNLE1BQU0sWUFBWSxLQUFLLENBQUM7QUFDbkYsTUFBSTtBQUNGLFVBQU0sVUFBVSxNQUFNLHNCQUFzQixPQUFPLE1BQU0sRUFBRTtBQUczRCxRQUFJLGNBQWMsT0FBTyxRQUFRLGdCQUFnQixXQUFXLFFBQVEsY0FBYztBQUNsRixRQUFJLENBQUMsYUFBYTtBQUNoQixvQkFBYyxNQUFNLGlCQUFpQixRQUFRLFFBQVE7QUFDckQsWUFBTSx1QkFBdUIsT0FBTyxNQUFNLElBQUksRUFBRSxZQUFZLENBQUM7QUFBQSxJQUMvRDtBQUVBLFFBQUksU0FBUyxPQUFPLFFBQVEsV0FBVyxXQUFXLFFBQVEsU0FBUztBQUNuRSxRQUFJLENBQUMsUUFBUTtBQUNYLGVBQVMsTUFBTSxjQUFjLFFBQVEsVUFBVTtBQUMvQyxZQUFNLHVCQUF1QixPQUFPLE1BQU0sSUFBSSxFQUFFLE9BQU8sQ0FBQztBQUFBLElBQzFEO0FBQ0EsVUFBTSxPQUFPLE9BQU8sTUFBTSxJQUFJLEVBQUUsUUFBUSxhQUFhLFNBQVMsVUFBVSxPQUFVLENBQUM7QUFDbkYsVUFBTSxNQUNILEtBQUssbUJBQW1CLEVBQ3hCLE9BQU87QUFBQSxNQUNOLFFBQVE7QUFBQSxNQUNSLFNBQVM7QUFBQSxNQUNULFlBQVk7QUFBQSxNQUNaLGNBQWEsb0JBQUksS0FBSyxHQUFFLFlBQVk7QUFBQSxNQUNwQyxhQUFZLG9CQUFJLEtBQUssR0FBRSxZQUFZO0FBQUEsSUFDckMsQ0FBQyxFQUNBLEdBQUcsTUFBTSxNQUFNLEVBQUUsRUFDakIsR0FBRyxVQUFVLFNBQVM7QUFDekIsV0FBT0EsTUFBSyxVQUFVLEtBQUs7QUFBQSxNQUN6QixRQUFRO0FBQUEsTUFDUixTQUFTO0FBQUEsTUFDVCxlQUFlO0FBQUEsTUFDZixXQUFXO0FBQUEsTUFDWCxhQUFhO0FBQUEsSUFDZixDQUFDO0FBQUEsRUFDSCxTQUFTLEdBQUc7QUFDVixVQUFNLE9BQU8sT0FBTyxNQUFNLElBQUksRUFBRSxRQUFRLFVBQVUsT0FBTyxPQUFPLENBQUMsRUFBRSxDQUFDO0FBQ3BFLFdBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyx5REFBWSxPQUFPLENBQUMsQ0FBQyxHQUFHLENBQUM7QUFBQSxFQUMvRDtBQUNGO0FBT0EsZUFBZSxxQkFDYixPQUNBLFVBQ0EsS0FDZTtBQUNmLFFBQU0sU0FBUyxPQUFPLElBQUksTUFBTTtBQUNoQyxNQUFJLEVBQUUsU0FBUyxHQUFJLFFBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyx1Q0FBUyxDQUFDO0FBQ2pFLFFBQU0sRUFBRSxNQUFNLFlBQVksSUFBSSxNQUFNLE1BQ2pDLEtBQUssVUFBVSxFQUNmLE9BQU8sZ0JBQWdCLEVBQ3ZCLEdBQUcsTUFBTSxJQUFJLE9BQU8sRUFDcEIsWUFBWTtBQUNmLE1BQUk7QUFDSixNQUFJO0FBQ0YsYUFBUyxVQUFVLGFBQWEsZ0JBQWdCLGdDQUFPO0FBQUEsRUFDekQsU0FBUyxHQUFHO0FBRVYsV0FBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLE9BQU8sQ0FBQyxFQUFFLENBQUM7QUFBQSxFQUNqRDtBQUNBLE1BQUksQ0FBRSxNQUFNLGdCQUFnQixRQUFRLEVBQUk7QUFFeEMsUUFBTSxRQUFRLE1BQU0sZ0JBQWdCLE9BQU87QUFBQSxJQUN6QyxRQUFRO0FBQUEsSUFDUixTQUFTLGNBQWMsSUFBSSxFQUFFO0FBQUEsSUFDN0IsU0FBUyxJQUFJO0FBQUEsSUFDYixVQUFVLElBQUk7QUFBQSxJQUNkO0FBQUEsSUFDQSxTQUFTO0FBQUEsSUFDVCxTQUFTLEVBQUUsT0FBTztBQUFBLEVBQ3BCLENBQUM7QUFDRCxNQUFJLFVBQVUsTUFBTyxRQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLEdBQUcsTUFBTSxNQUFNLFlBQVksS0FBSyxDQUFDO0FBQ25GLE1BQUk7QUFDRixVQUFNLFVBQVUsTUFBTSxzQkFBc0IsT0FBTyxNQUFNLEVBQUU7QUFDM0QsUUFBSSxXQUFXLE9BQU8sUUFBUSxhQUFhLFdBQVcsUUFBUSxXQUFXO0FBQ3pFLFFBQUksQ0FBQyxVQUFVO0FBRWIsaUJBQVcsTUFBTSxZQUFZLFFBQVEsTUFBTTtBQUMzQyxZQUFNLHVCQUF1QixPQUFPLE1BQU0sSUFBSSxFQUFFLFNBQVMsQ0FBQztBQUFBLElBQzVEO0FBSUEsVUFBTSxNQUFNLEtBQUssV0FBVyxFQUFFO0FBQUEsTUFDNUI7QUFBQSxRQUNFLFNBQVMsSUFBSTtBQUFBLFFBQ2IsWUFBWTtBQUFBLFFBQ1o7QUFBQSxRQUNBLFVBQVUsSUFBSTtBQUFBLFFBQ2QsaUJBQWlCLHFCQUFxQixJQUFJLEVBQUU7QUFBQSxRQUM1QyxVQUFVLEVBQUUsbUJBQW1CLElBQUksSUFBSSxTQUFTLE1BQU0sSUFBSSxTQUFTO0FBQUEsTUFDckU7QUFBQSxNQUNBLEVBQUUsWUFBWSxtQkFBbUIsa0JBQWtCLEtBQUs7QUFBQSxJQUMxRDtBQUNBLFVBQU0sTUFDSCxLQUFLLGlCQUFpQixFQUN0QixPQUFPLEVBQUUsVUFBUyxvQkFBSSxLQUFLLEdBQUUsWUFBWSxFQUFFLENBQUMsRUFDNUMsR0FBRyxNQUFNLElBQUksRUFBRSxFQUNmLEdBQUcsV0FBVyxJQUFJO0FBQ3JCLFVBQU0sT0FBTyxPQUFPLE1BQU0sSUFBSSxFQUFFLFFBQVEsYUFBYSxTQUFTLFlBQVksT0FBVSxDQUFDO0FBQ3JGLFdBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsUUFBUSxhQUFhLFNBQVMsVUFBVSxPQUFPLENBQUM7QUFBQSxFQUMvRSxTQUFTLEdBQUc7QUFDVixVQUFNLE9BQU8sT0FBTyxNQUFNLElBQUksRUFBRSxRQUFRLFVBQVUsT0FBTyxPQUFPLENBQUMsRUFBRSxDQUFDO0FBQ3BFLFdBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyx5REFBWSxPQUFPLENBQUMsQ0FBQyxHQUFHLENBQUM7QUFBQSxFQUMvRDtBQUNGO0FBS0EsZUFBZSwyQkFBMkIsT0FBdUIsZ0JBQXVDO0FBQ3RHLFFBQU0sRUFBRSxNQUFNLEtBQUssSUFBSSxNQUFNLE1BQzFCLEtBQUssaUJBQWlCLEVBQ3RCLE9BQU8sOENBQThDLEVBQ3JELEdBQUcsb0JBQW9CLGNBQWMsRUFDckMsR0FBRyxXQUFXLElBQUk7QUFDckIsYUFBVyxPQUFPLFFBQVEsQ0FBQyxHQUFHO0FBQzVCLFFBQUksQ0FBQyxJQUFJLGVBQWdCO0FBQ3pCLFVBQU0sRUFBRSxTQUFTLElBQUksYUFBYTtBQUNsQyxRQUFJO0FBQ0YsWUFBTSxxQkFBcUIsT0FBTyxVQUFVO0FBQUEsUUFDMUMsSUFBSSxJQUFJO0FBQUEsUUFDUixTQUFTLElBQUk7QUFBQSxRQUNiLFFBQVEsT0FBTyxJQUFJLGlCQUFpQjtBQUFBLFFBQ3BDLFVBQVUsSUFBSSxZQUFZO0FBQUEsTUFDNUIsQ0FBQztBQUFBLElBQ0gsUUFBUTtBQUFBLElBRVI7QUFBQSxFQUNGO0FBQ0Y7QUFrQkEsZUFBZSxnQ0FDYixPQUNBLGVBQ3lCO0FBQ3pCLFFBQU0sQ0FBQyxZQUFZLFVBQVUsSUFBSSxNQUFNLFFBQVEsSUFBSTtBQUFBLElBQ2pELE1BQ0csS0FBSyxpQkFBaUIsRUFDdEIsT0FBTyxtQkFBbUIsRUFDMUIsR0FBRyxrQkFBa0IsYUFBYSxFQUNsQyxJQUFJLFdBQVcsTUFBTSxJQUFJO0FBQUEsSUFDNUIsTUFDRyxLQUFLLFdBQVcsRUFDaEIsT0FBTyxRQUFRLEVBQ2YsR0FBRyxXQUFXLGFBQWEsRUFDM0IsR0FBRyxjQUFjLENBQUMscUJBQXFCLHFCQUFxQixDQUFDO0FBQUEsRUFDbEUsQ0FBQztBQUNELFFBQU0sUUFBUSxXQUFXLFFBQVEsQ0FBQyxHQUFHLE9BQU8sQ0FBQyxLQUFLLE1BQU0sTUFBTSxPQUFPLEVBQUUsaUJBQWlCLEdBQUcsQ0FBQztBQUM1RixRQUFNLFFBQVEsV0FBVyxRQUFRLENBQUMsR0FBRyxPQUFPLENBQUMsS0FBSyxNQUFNLE1BQU0sT0FBTyxFQUFFLE1BQU0sR0FBRyxDQUFDO0FBQ2pGLFFBQU0sU0FBUyxDQUFDLE1BQWMsS0FBSyxNQUFNLElBQUksR0FBRyxJQUFJO0FBQ3BELFFBQU0sT0FBTyxPQUFPLE9BQU8sSUFBSTtBQUMvQixNQUFJLEtBQUssSUFBSSxJQUFJLEtBQUssTUFBTTtBQUMxQixXQUFPLEVBQUUsZUFBZSxTQUFTLE9BQU8sV0FBVyxRQUFRLFFBQVEsRUFBRTtBQUFBLEVBQ3ZFO0FBQ0EsTUFBSSxPQUFPLEdBQUc7QUFFWixVQUFNLFlBQVksT0FBTyxPQUFPLElBQUk7QUFDcEMsVUFBTSxFQUFFLE1BQU0sS0FBSyxJQUFJLE1BQU0sTUFDMUIsS0FBSyxVQUFVLEVBQ2YsT0FBTyxnQkFBZ0IsRUFDdkIsR0FBRyxNQUFNLGFBQWEsRUFDdEIsWUFBWTtBQUNmLFFBQUk7QUFDSixRQUFJO0FBQ0YsZUFBUyxVQUFVLE1BQU0sZ0JBQWdCLGdDQUFPO0FBQUEsSUFDbEQsU0FBUyxHQUFHO0FBQ1YsYUFBTyxFQUFFLGVBQWUsU0FBUyxPQUFPLFdBQVcsU0FBUyxRQUFRLFdBQVcsT0FBTyxPQUFPLENBQUMsRUFBRTtBQUFBLElBQ2xHO0FBQ0EsVUFBTSxLQUFLLE1BQU0sWUFBWSxRQUFRLFNBQVM7QUFDOUMsUUFBSSxDQUFDLEdBQUksT0FBTSxJQUFJLE1BQU0sOEZBQW1CO0FBQzVDLFVBQU0sTUFBTSxLQUFLLFdBQVcsRUFBRSxPQUFPO0FBQUEsTUFDbkMsU0FBUztBQUFBLE1BQ1QsWUFBWTtBQUFBLE1BQ1osUUFBUTtBQUFBLE1BQ1IsaUJBQWlCLHNCQUFzQixhQUFhLElBQUksS0FBSyxJQUFJLENBQUM7QUFBQSxNQUNsRSxVQUFVLEVBQUUsTUFBTSxTQUFTLFFBQVEsb0RBQVksR0FBRztBQUFBLElBQ3BELENBQUM7QUFDRCxVQUFNLE1BQU0sS0FBSyxxQkFBcUIsRUFBRSxPQUFPO0FBQUEsTUFDN0MsUUFBUTtBQUFBLE1BQ1IsU0FBUyxzQkFBc0IsYUFBYSxJQUFJLEtBQUssSUFBSSxDQUFDO0FBQUEsTUFDMUQsU0FBUztBQUFBLE1BQ1QsUUFBUTtBQUFBLE1BQ1IsUUFBUTtBQUFBLE1BQ1IsU0FBUztBQUFBLElBQ1gsQ0FBQztBQUNELFdBQU8sRUFBRSxlQUFlLFNBQVMsTUFBTSxXQUFXLFNBQVMsUUFBUSxXQUFXLEdBQUc7QUFBQSxFQUNuRjtBQUVBLFFBQU0sU0FBUyxPQUFPLE9BQU8sSUFBSTtBQUNqQyxRQUFNLE1BQU0sS0FBSyxXQUFXLEVBQUUsT0FBTztBQUFBLElBQ25DLFNBQVM7QUFBQSxJQUNULFlBQVk7QUFBQSxJQUNaLFFBQVEsQ0FBQztBQUFBLElBQ1QsaUJBQWlCLHNCQUFzQixhQUFhLElBQUksS0FBSyxJQUFJLENBQUM7QUFBQSxJQUNsRSxVQUFVLEVBQUUsTUFBTSxRQUFRLFFBQVEseUdBQW9CO0FBQUEsRUFDeEQsQ0FBQztBQUNELFFBQU0sTUFBTSxLQUFLLHFCQUFxQixFQUFFLE9BQU87QUFBQSxJQUM3QyxRQUFRO0FBQUEsSUFDUixTQUFTLHNCQUFzQixhQUFhLElBQUksS0FBSyxJQUFJLENBQUM7QUFBQSxJQUMxRCxTQUFTO0FBQUEsSUFDVCxRQUFRLENBQUM7QUFBQSxJQUNULFFBQVE7QUFBQSxFQUNWLENBQUM7QUFDRCxTQUFPLEVBQUUsZUFBZSxTQUFTLE1BQU0sV0FBVyxRQUFRLFFBQVEsT0FBTztBQUMzRTtBQU9BLGVBQXNCLHdCQUNwQixPQUNBLFFBQVEsS0FDUixnQkFDZ0U7QUFDaEUsTUFBSSxRQUFRLE1BQ1QsS0FBSyxpQkFBaUIsRUFDdEIsT0FBTyw4Q0FBOEMsRUFDckQsR0FBRyxXQUFXLElBQUksRUFDbEIsSUFBSSxrQkFBa0IsTUFBTSxJQUFJLEVBQ2hDLEdBQUcscUJBQXFCLENBQUM7QUFDNUIsTUFBSSxrQkFBa0IsZUFBZSxTQUFTLEdBQUc7QUFDL0MsWUFBUSxNQUFNLEdBQUcsa0JBQWtCLGNBQWM7QUFBQSxFQUNuRDtBQUNBLFFBQU0sRUFBRSxNQUFNLEtBQUssSUFBSSxNQUFNLE1BQU0sTUFBTSxjQUFjLEVBQUUsV0FBVyxLQUFLLENBQUMsRUFBRSxNQUFNLEtBQUs7QUFDdkYsTUFBSSxVQUFVO0FBQ2QsTUFBSSxVQUFVO0FBQ2QsYUFBVyxPQUFPLFFBQVEsQ0FBQyxHQUFHO0FBQzVCLFFBQUksQ0FBQyxJQUFJLGdCQUFnQjtBQUN2QixpQkFBVztBQUNYO0FBQUEsSUFDRjtBQUNBLFVBQU0sRUFBRSxVQUFVLEtBQUssSUFBSSxhQUFhO0FBQ3hDLFFBQUk7QUFDRixZQUFNLHFCQUFxQixPQUFPLFVBQVU7QUFBQSxRQUMxQyxJQUFJLElBQUk7QUFBQSxRQUNSLFNBQVMsSUFBSTtBQUFBLFFBQ2IsUUFBUSxPQUFPLElBQUksaUJBQWlCO0FBQUEsUUFDcEMsVUFBVSxJQUFJLFlBQVk7QUFBQSxNQUM1QixDQUFDO0FBQ0QsWUFBTSxFQUFFLE9BQU8sSUFBSSxLQUFLO0FBQ3hCLFVBQUksVUFBVSxPQUFPLFNBQVMsSUFBSyxZQUFXO0FBQUEsVUFDekMsWUFBVztBQUFBLElBQ2xCLFFBQVE7QUFDTixpQkFBVztBQUFBLElBQ2I7QUFBQSxFQUNGO0FBQ0EsU0FBTyxFQUFFLFNBQVMsTUFBTSxVQUFVLEdBQUcsU0FBUyxRQUFRO0FBQ3hEO0FBRUEsZUFBT0wsU0FBK0IsU0FBMEIsVUFBMEI7QUFDeEYsTUFBSSxRQUFRLFdBQVcsUUFBUTtBQUM3QixhQUFTLFVBQVUsU0FBUyxNQUFNO0FBQ2xDLFdBQU9LLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyxxQkFBcUIsQ0FBQztBQUFBLEVBQzVEO0FBRUEsUUFBTSxjQUFjLFFBQVEsSUFBSTtBQUNoQyxRQUFNLGFBQWEsUUFBUSxJQUFJLDZCQUE2QixRQUFRLElBQUk7QUFDeEUsTUFBSSxDQUFDLGVBQWUsQ0FBQyxZQUFZO0FBQy9CLFdBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyx5REFBMkIsQ0FBQztBQUFBLEVBQ2xFO0FBQ0EsTUFBSSxDQUFDLFFBQVEsSUFBSSxtQkFBbUI7QUFDbEMsV0FBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLDJHQUEwQyxDQUFDO0FBQUEsRUFDakY7QUFFQSxRQUFNLGFBQWEsUUFBUSxRQUFRLGlCQUFpQjtBQUNwRCxRQUFNLFFBQVEsV0FBVyxXQUFXLFNBQVMsSUFBSSxXQUFXLE1BQU0sQ0FBQyxJQUFJO0FBQ3ZFLE1BQUksQ0FBQyxNQUFPLFFBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyx1Q0FBUyxDQUFDO0FBRTFELE1BQUk7QUFDSixNQUFJO0FBQ0YsV0FBTyxNQUFNQyxVQUFTLE9BQU87QUFBQSxFQUMvQixRQUFRO0FBQ04sV0FBT0QsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLHVCQUF1QixDQUFDO0FBQUEsRUFDOUQ7QUFDQSxRQUFNLFNBQVMsS0FBSztBQUNwQixNQUFJLENBQUMsT0FBUSxRQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sc0JBQVksQ0FBQztBQUU5RCxRQUFNLFFBQVFKLGNBQWEsYUFBYSxZQUFZO0FBQUEsSUFDbEQsTUFBTSxFQUFFLGdCQUFnQixPQUFPLGtCQUFrQixNQUFNO0FBQUEsRUFDekQsQ0FBQztBQUVELFFBQU0sRUFBRSxNQUFNLFVBQVUsT0FBTyxVQUFVLElBQUksTUFBTSxNQUFNLEtBQUssUUFBUSxLQUFLO0FBQzNFLFFBQU0sU0FBUyxVQUFVO0FBQ3pCLE1BQUksYUFBYSxDQUFDLE9BQVEsUUFBT0ksTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLHVDQUFTLENBQUM7QUFFeEUsUUFBTSxFQUFFLE1BQU0sY0FBYyxJQUFJLE1BQU0sTUFDbkMsS0FBSyxVQUFVLEVBQ2YsT0FBTyxvQ0FBb0MsRUFDM0MsR0FBRyxNQUFNLE9BQU8sRUFBRSxFQUNsQixZQUFZO0FBQ2YsTUFBSSxDQUFDLGNBQWUsUUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLDZDQUFVLENBQUM7QUFHbkUsTUFBSSxXQUFXLHlCQUF5QixXQUFXLGtCQUFrQjtBQUNuRSxXQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8scUVBQWMsQ0FBQztBQUFBLEVBQ3JEO0FBQ0EsTUFBSSxXQUFXLGtCQUFrQjtBQUMvQixXQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8saUZBQTBCLENBQUM7QUFBQSxFQUNqRTtBQUNJLFFBQU0sZ0JBQWdCLG9CQUFJLElBQUk7QUFBQSxJQUM1QjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGLENBQUM7QUFDRCxNQUFJLENBQUMsY0FBYyxJQUFJLE1BQU0sRUFBRyxPQUFNLHdCQUF3QixLQUFLO0FBRW5FLE1BQUk7QUFDRixRQUFJLFdBQVcseUJBQXlCO0FBQ3RDLFVBQUksQ0FBQyxLQUFLLE9BQVEsUUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLG1EQUFXLENBQUM7QUFDbEUsWUFBTSxTQUFTLE1BQU0sMEJBQTBCLE9BQU8sS0FBSyxRQUFRLGFBQWE7QUFDaEYsYUFBT0EsTUFBSyxVQUFVLEtBQUssTUFBTTtBQUFBLElBQ25DO0FBQ0EsUUFBSSxXQUFXLHNCQUFzQjtBQUNuQyxVQUFJLENBQUMsS0FBSyxPQUFRLFFBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyxtREFBVyxDQUFDO0FBQ2xFLFlBQU0sU0FBUyxNQUFNLGtCQUFrQixPQUFPLEtBQUssUUFBUSxhQUFhO0FBQ3hFLGFBQU9BLE1BQUssVUFBVSxLQUFLLE1BQU07QUFBQSxJQUNuQztBQUNBLFFBQUksV0FBVywwQkFBMEI7QUFDdkMsVUFBSSxDQUFDLEtBQUssT0FBUSxRQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sbURBQVcsQ0FBQztBQUNsRSxZQUFNLFNBQVMsTUFBTSxvQkFBb0IsT0FBTyxLQUFLLFFBQVEsYUFBYTtBQUMxRSxhQUFPQSxNQUFLLFVBQVUsS0FBSyxNQUFNO0FBQUEsSUFDbkM7QUFDQSxRQUFJLFdBQVcsdUJBQXVCO0FBQ3BDLFVBQUksQ0FBQyxlQUFlLGFBQWEsRUFBRyxRQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sNkNBQVUsQ0FBQztBQUNuRixZQUFNLENBQUMsY0FBYyxjQUFjLGNBQWMsV0FBVyxJQUFJLE1BQU0sUUFBUSxJQUFJO0FBQUEsUUFDaEYsTUFBTSxLQUFLLFlBQVksRUFDcEIsT0FBTyw4R0FBOEcsRUFDckgsR0FBRyxlQUFlLFFBQVEsRUFDMUIsR0FBRyxVQUFVLENBQUMsUUFBUSxrQkFBa0IsQ0FBQztBQUFBLFFBQzVDLE1BQU0sS0FBSyxZQUFZLEVBQUUsT0FBTyxNQUFNLEVBQUUsT0FBTyxTQUFTLE1BQU0sS0FBSyxDQUFDLEVBQ2pFLEdBQUcsZUFBZSxRQUFRLEVBQUUsR0FBRyxVQUFVLENBQUMsUUFBUSxrQkFBa0IsQ0FBQztBQUFBLFFBQ3hFLE1BQU0sS0FBSyxtQkFBbUIsRUFDM0IsT0FBTyxvREFBb0QsRUFDM0QsR0FBRyxVQUFVLENBQUMsV0FBVyxRQUFRLENBQUMsRUFDbEMsTUFBTSxjQUFjLEVBQUUsV0FBVyxNQUFNLENBQUMsRUFDeEMsTUFBTSxFQUFFO0FBQUEsUUFDWCxNQUFNLEtBQUssMEJBQTBCLEVBQUUsT0FBTyxZQUFZLEVBQUUsT0FBTyxTQUFTLE1BQU0sS0FBSyxDQUFDO0FBQUEsTUFDMUYsQ0FBQztBQUNELFlBQU0sUUFBUSxhQUFhLFNBQVMsYUFBYSxTQUFTLGFBQWEsU0FBUyxZQUFZO0FBQzVGLFVBQUksTUFBTyxRQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8scUVBQWMsTUFBTSxPQUFPLEdBQUcsQ0FBQztBQUM5RSxZQUFNLFNBQVMsYUFBYSxRQUFRLENBQUM7QUFDckMsWUFBTSxXQUFXLG9CQUFJLElBQW9CO0FBQ3pDLGlCQUFXLFNBQVMsUUFBUTtBQUMxQixjQUFNRSxTQUFRLE1BQU0sU0FBUyxTQUFTLE1BQU0sdUJBQXVCLE1BQU07QUFDekUsWUFBSSxDQUFDQSxPQUFPO0FBQ1osY0FBTSxTQUFTLE1BQU0sU0FBUyxTQUMxQixPQUFPLE1BQU0sa0JBQWtCLElBQy9CLE9BQU8sTUFBTSxLQUFLLElBQUksT0FBTyxNQUFNLGtCQUFrQjtBQUN6RCxpQkFBUyxJQUFJQSxPQUFNLFlBQVksSUFBSSxTQUFTLElBQUlBLE9BQU0sWUFBWSxDQUFDLEtBQUssS0FBSyxNQUFNO0FBQUEsTUFDckY7QUFDQSxZQUFNLGlCQUFpQixxQkFDbkIsTUFBTSxRQUFRLElBQUksQ0FBQyxHQUFHLFNBQVMsUUFBUSxDQUFDLEVBQUUsSUFBSSxPQUFPLENBQUNBLFFBQU8sY0FBYyxNQUFNO0FBQy9FLGNBQU0sVUFBVSxVQUFVQSxRQUFPLDBCQUFNO0FBQ3ZDLFlBQUk7QUFDRixnQkFBTSxTQUFTLE1BQU0sbUJBQW1CLE9BQU87QUFDL0MsaUJBQU8sRUFBRSxPQUFPLFNBQVMsZ0JBQWdCLGFBQWEsT0FBT0wsYUFBWSxRQUFRLEVBQUUsQ0FBQyxHQUFHLE9BQU8sS0FBSztBQUFBLFFBQ3JHLFNBQVNNLFFBQU87QUFDZCxpQkFBTyxFQUFFLE9BQU8sU0FBUyxnQkFBZ0IsYUFBYSxNQUFNLE9BQU8sT0FBT0EsTUFBSyxFQUFFO0FBQUEsUUFDbkY7QUFBQSxNQUNGLENBQUMsQ0FBQyxJQUNGLENBQUM7QUFDTCxhQUFPSCxNQUFLLFVBQVUsS0FBSztBQUFBLFFBQ3pCLFlBQVksUUFBUSxrQkFBa0I7QUFBQSxRQUN0QyxvQkFBb0IsT0FBTztBQUFBLFFBQzNCLG9CQUFvQixhQUFhLFNBQVM7QUFBQSxRQUMxQyxlQUFlLGFBQWEsTUFBTSxVQUFVO0FBQUEsUUFDNUMsdUJBQXVCLFlBQVksU0FBUztBQUFBLFFBQzVDO0FBQUEsUUFDQSxRQUFRLGFBQWEsUUFBUSxDQUFDO0FBQUEsTUFDaEMsQ0FBQztBQUFBLElBQ0g7QUFDQSxRQUFJLFdBQVcsNEJBQTRCO0FBQ3pDLFVBQUksQ0FBQyxlQUFlLGFBQWEsRUFBRyxRQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sNkNBQVUsQ0FBQztBQUNuRixZQUFNLFVBQVUsS0FBSyxTQUFTLEtBQUs7QUFDbkMsVUFBSSxDQUFDLFFBQVMsUUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLHlEQUFZLENBQUM7QUFDL0QsWUFBTSxFQUFFLE1BQU0sT0FBTyxNQUFNLElBQUksTUFBTSxNQUFNLEtBQUssbUJBQW1CLEVBQ2hFLE9BQU8sMkJBQTJCLEVBQ2xDLEdBQUcsV0FBVyxPQUFPLEVBQ3JCLFlBQVk7QUFDZixVQUFJLFNBQVMsQ0FBQyxNQUFPLFFBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyxxRUFBYyxDQUFDO0FBQ3hFLFVBQUksTUFBTSxXQUFXLFlBQWEsUUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxRQUFRLGFBQWEsWUFBWSxLQUFLLENBQUM7QUFDdEcsWUFBTSxTQUFTLE1BQU0sZUFBZSxrQkFDaEMsTUFBTSwwQkFBMEIsT0FBTyxNQUFNLFNBQVMsSUFBSSxJQUMxRCxNQUFNLGVBQWUsaUJBQ25CLE1BQU0sa0JBQWtCLE9BQU8sTUFBTSxTQUFTLElBQUksSUFDbEQsTUFBTSxvQkFBb0IsT0FBTyxNQUFNLFNBQVMsSUFBSTtBQUMxRCxhQUFPQSxNQUFLLFVBQVUsS0FBSyxNQUFNO0FBQUEsSUFDbkM7QUFHSixRQUFJLFdBQVcsa0JBQWtCO0FBQy9CLFVBQUksQ0FBQyxlQUFlLGFBQWEsR0FBRztBQUNsQyxlQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sNkNBQVUsQ0FBQztBQUFBLE1BQ2pEO0FBQ0EsWUFBTSxVQUFVLE1BQU0saUJBQWlCO0FBR3ZDLFlBQU0sV0FDSixDQUFDLFFBQVEsY0FBYyxRQUFRLE1BQU0sRUFBRTtBQUFBLFFBQ3JDLENBQUMsVUFBVSxPQUFPLFVBQVUsWUFBWSxNQUFNLFdBQVcsSUFBSTtBQUFBLE1BQy9ELEtBQUs7QUFDUCxZQUFNLE1BQU0sS0FBSyxxQkFBcUIsRUFBRSxPQUFPO0FBQUEsUUFDN0MsUUFBUTtBQUFBLFFBQ1IsU0FBUyxrQkFBa0IsS0FBSyxJQUFJLENBQUM7QUFBQSxRQUNyQyxTQUFTLE9BQU87QUFBQSxRQUNoQixRQUFRO0FBQUEsUUFDUixTQUFTO0FBQUEsUUFDVCxTQUFTO0FBQUEsTUFDWCxDQUFDO0FBRUQsYUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxJQUFJLENBQUMsUUFBUSxhQUFhLFNBQVMsU0FBUyxlQUFlLEVBQUUsQ0FBQztBQUFBLElBQzdGO0FBR0EsUUFBSSxXQUFXLHNCQUFzQjtBQUNuQyxVQUFJLENBQUMsZUFBZSxhQUFhLEdBQUc7QUFDbEMsZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLDZDQUFVLENBQUM7QUFBQSxNQUNqRDtBQUNBLFlBQU0sY0FBZSxLQUFrQyxhQUFhLEtBQUs7QUFDekUsVUFBSSxDQUFDLFlBQWEsUUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLHVDQUFTLENBQUM7QUFDaEUsWUFBTSxFQUFFLE1BQU0sVUFBVSxJQUFJLE1BQU0sTUFDL0IsS0FBSyxVQUFVLEVBQ2YsT0FBTywrQkFBK0IsRUFDdEMsR0FBRyxNQUFNLFdBQVcsRUFDcEIsWUFBWTtBQUNmLFVBQUksQ0FBQyxhQUFhLENBQUMsT0FBTyxVQUFVLGVBQWUsRUFBRSxFQUFFLFNBQVMsY0FBSSxHQUFHO0FBQ3JFLGVBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTywrREFBYSxDQUFDO0FBQUEsTUFDcEQ7QUFDQSxVQUFJO0FBQ0YsZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxRQUFRLFVBQVUsVUFBVSxnQkFBZ0IsMEJBQU0sRUFBRSxDQUFDO0FBQUEsTUFDcEYsU0FBUyxHQUFHO0FBQ1YsZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLE9BQU8sQ0FBQyxFQUFFLENBQUM7QUFBQSxNQUNqRDtBQUFBLElBQ0Y7QUFHQSxRQUFJLFdBQVcseUJBQXlCLFdBQVcsa0JBQWtCO0FBQ25FLFVBQUk7QUFDSixVQUFJO0FBQ0YsaUJBQVMsVUFBVSxjQUFjLGdCQUFnQixnQ0FBTztBQUFBLE1BQzFELFNBQVMsR0FBRztBQUNWLGVBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyxPQUFPLENBQUMsRUFBRSxDQUFDO0FBQUEsTUFDakQ7QUFFQSxVQUFJLFdBQVcsdUJBQXVCO0FBQ3BDLGNBQU0sK0JBQStCLE9BQU8sT0FBTyxFQUFFO0FBQ3JELGNBQU1JLGNBQWEsTUFBTSw0QkFBNEIsT0FBTyxPQUFPLElBQUksTUFBTTtBQUM3RSxlQUFPSixNQUFLLFVBQVUsS0FBSyxFQUFFLFFBQVEsdUJBQXVCLFlBQUFJLFlBQVcsQ0FBQztBQUFBLE1BQzFFO0FBRUEsWUFBTSxXQUFXLEtBQUssVUFBVSxLQUFLO0FBQ3JDLFlBQU0saUJBQWlCLEtBQUssZ0JBQWdCLEtBQUs7QUFDakQsWUFBTSxnQkFBZ0IsWUFBWSxzRkFBc0YsS0FBSyxRQUFRO0FBQ3JJLFVBQUksQ0FBQyxpQkFBaUIsQ0FBQyxrQkFBa0IsZUFBZSxTQUFTLE1BQU0sQ0FBQyxrQ0FBa0MsS0FBSyxjQUFjLEdBQUc7QUFDOUgsZUFBT0osTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLDJIQUF1QixDQUFDO0FBQUEsTUFDOUQ7QUFDQSxZQUFNLFNBQVMsd0JBQXdCLE9BQU8sRUFBRSxJQUFJLFFBQVE7QUFDNUQsWUFBTSxFQUFFLE1BQU0sb0JBQW9CLE9BQU8sb0JBQW9CLElBQUksTUFBTSxNQUNwRSxLQUFLLHFCQUFxQixFQUMxQixPQUFPLHFFQUFxRSxFQUM1RSxHQUFHLFdBQVcsTUFBTSxFQUNwQixZQUFZO0FBQ2YsVUFBSSxhQUFhO0FBQ2pCLFVBQUksb0JBQXFCLE9BQU0sSUFBSSxNQUFNLHlEQUFZLG9CQUFvQixPQUFPLEVBQUU7QUFFbEYsVUFBSSxlQUFlLFdBQVcsV0FBVyx1QkFBdUIsV0FBVyxZQUFZLE9BQU8sTUFBTSxXQUFXLGFBQWEsV0FBVztBQUNySSxlQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sbUdBQW1CLENBQUM7QUFBQSxNQUMxRDtBQUNBLFVBQUksWUFBWSxXQUFXLGFBQWE7QUFDdEMsZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxRQUFRLGFBQWEsUUFBUSxXQUFXLFNBQVMsUUFBUSxPQUFPLFdBQVcsVUFBVSxHQUFHLEVBQUUsQ0FBQztBQUFBLE1BQzFIO0FBQ0EsVUFBSSxZQUFZLFdBQVcsV0FBVztBQUNwQyxZQUFJLENBQUMsV0FBVyxTQUFTO0FBQ3ZCLGdCQUFNLGNBQWMsSUFBSSxLQUFLLEtBQUssSUFBSSxJQUFJLElBQUksR0FBTSxFQUFFLFlBQVk7QUFDbEUsY0FBSSxJQUFJLEtBQUssV0FBVyxVQUFVLEVBQUUsUUFBUSxLQUFLLEtBQUssTUFBTSxXQUFXLEdBQUc7QUFDeEUsbUJBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsUUFBUSxXQUFXLE9BQU8sMkhBQXVCLENBQUM7QUFBQSxVQUNqRjtBQUNBLGdCQUFNLEVBQUUsTUFBTSxZQUFZLE1BQU0sSUFBSSxNQUFNLE1BQ3ZDLEtBQUsscUJBQXFCLEVBQzFCLE9BQU8sRUFBRSxRQUFRLFVBQVUsT0FBTyw0SEFBd0IsYUFBWSxvQkFBSSxLQUFLLEdBQUUsWUFBWSxFQUFFLENBQUMsRUFDaEcsR0FBRyxNQUFNLFdBQVcsRUFBRSxFQUN0QixHQUFHLFVBQVUsU0FBUyxFQUN0QixHQUFHLFdBQVcsSUFBSSxFQUNsQixHQUFHLGNBQWMsV0FBVyxFQUM1QixPQUFPLElBQUksRUFDWCxZQUFZO0FBQ2YsY0FBSSxNQUFPLE9BQU0sSUFBSSxNQUFNLHFFQUFjLE1BQU0sT0FBTyxFQUFFO0FBQ3hELGNBQUksQ0FBQyxXQUFZLFFBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsUUFBUSxXQUFXLE9BQU8sMkhBQXVCLENBQUM7QUFDaEcscUJBQVcsU0FBUztBQUFBLFFBQ3RCLE9BQU87QUFDTCxjQUFJO0FBQ0osa0JBQU0sWUFBWSxNQUFNLHlCQUF5QixXQUFXLE9BQXdCO0FBQ3BGLGdCQUFJLFdBQVc7QUFDYixvQkFBTSxFQUFFLE9BQUFHLE9BQU0sSUFBSSxNQUFNLE1BQU0sS0FBSyxxQkFBcUIsRUFBRSxPQUFPLEVBQUUsUUFBUSxhQUFhLE9BQU8sTUFBTSxhQUFZLG9CQUFJLEtBQUssR0FBRSxZQUFZLEVBQUUsQ0FBQyxFQUFFLEdBQUcsTUFBTSxXQUFXLEVBQUU7QUFDbkssa0JBQUlBLE9BQU8sT0FBTSxJQUFJLE1BQU0saUZBQWdCQSxPQUFNLE9BQU8sRUFBRTtBQUMxRCxxQkFBT0gsTUFBSyxVQUFVLEtBQUssRUFBRSxRQUFRLGFBQWEsUUFBUSxXQUFXLFNBQVMsUUFBUSxPQUFPLFdBQVcsVUFBVSxHQUFHLEVBQUUsQ0FBQztBQUFBLFlBQzFIO0FBQ0Esa0JBQU0sRUFBRSxNQUFNLElBQUksTUFBTSxNQUFNLEtBQUsscUJBQXFCLEVBQUUsT0FBTyxFQUFFLFFBQVEsVUFBVSxPQUFPLHFEQUFrQixhQUFZLG9CQUFJLEtBQUssR0FBRSxZQUFZLEVBQUUsQ0FBQyxFQUFFLEdBQUcsTUFBTSxXQUFXLEVBQUU7QUFDNUssZ0JBQUksTUFBTyxPQUFNLElBQUksTUFBTSxxRUFBYyxNQUFNLE9BQU8sRUFBRTtBQUN4RCx1QkFBVyxTQUFTO0FBQUEsVUFDcEIsUUFBUTtBQUNOLG1CQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLFFBQVEsV0FBVyxRQUFRLFdBQVcsU0FBUyxRQUFRLE9BQU8sV0FBVyxVQUFVLEdBQUcsRUFBRSxDQUFDO0FBQUEsVUFDeEg7QUFBQSxRQUNGO0FBQUEsTUFDRjtBQUVBLFlBQU0sYUFBYSxNQUFNLDRCQUE0QixPQUFPLE9BQU8sSUFBSSxNQUFNO0FBQzdFLFlBQU0sWUFBWSxXQUFXLEtBQUssQ0FBQyxTQUFTLEtBQUssYUFBYSxRQUFRO0FBQ3RFLFVBQUksQ0FBQyxhQUFhLFVBQVUsV0FBVyxXQUFXLENBQUMsVUFBVSxnQkFBZ0IsVUFBVSxZQUFZLE1BQU07QUFDdkcsZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLG1NQUFtQyxDQUFDO0FBQUEsTUFDMUU7QUFDQSxVQUFJO0FBQ0osVUFBSTtBQUNKLFVBQUk7QUFDRix5QkFBaUJELFlBQVcsZ0JBQWdCLFVBQVUsUUFBUTtBQUM5RCx5QkFBaUJBLFlBQVcsVUFBVSxRQUFRLFVBQVUsUUFBUTtBQUFBLE1BQ2xFLFFBQVE7QUFDTixlQUFPQyxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8scUhBQXNCLENBQUM7QUFBQSxNQUM3RDtBQUNBLFVBQUksa0JBQWtCLE1BQU0sbUJBQW1CLGdCQUFnQjtBQUM3RCxlQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sdUlBQXlCLENBQUM7QUFBQSxNQUNoRTtBQUVBLFlBQU0sVUFBVTtBQUFBLFFBQ2Q7QUFBQSxRQUNBLFdBQVcsVUFBVTtBQUFBLFFBQ3JCLGNBQWMsVUFBVTtBQUFBLFFBQ3hCO0FBQUEsUUFDQSxRQUFRLFVBQVU7QUFBQSxRQUNsQixhQUFhO0FBQUEsTUFDZjtBQUNBLFVBQUksWUFBWSxXQUFXLFVBQVU7QUFDbkMsY0FBTSxFQUFFLE1BQU0sU0FBUyxNQUFNLElBQUksTUFBTSxNQUNwQyxLQUFLLHFCQUFxQixFQUMxQixPQUFPLEVBQUUsUUFBUSxXQUFXLFNBQVMsTUFBTSxPQUFPLE1BQU0sUUFBUSxVQUFVLFFBQVEsU0FBUyxhQUFZLG9CQUFJLEtBQUssR0FBRSxZQUFZLEVBQUUsQ0FBQyxFQUNqSSxHQUFHLE1BQU0sV0FBVyxFQUFFLEVBQ3RCLEdBQUcsVUFBVSxRQUFRLEVBQ3JCLE9BQU8scUVBQXFFLEVBQzVFLFlBQVk7QUFDZixZQUFJLE1BQU8sT0FBTSxJQUFJLE1BQU0scUVBQWMsTUFBTSxPQUFPLEVBQUU7QUFDeEQsWUFBSSxDQUFDLFFBQVMsUUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxRQUFRLFdBQVcsT0FBTywySEFBdUIsQ0FBQztBQUM3RixxQkFBYTtBQUFBLE1BQ2YsV0FBVyxDQUFDLFlBQVk7QUFDdEIsY0FBTSxFQUFFLE1BQU0sVUFBVSxNQUFNLElBQUksTUFBTSxNQUNyQyxLQUFLLHFCQUFxQixFQUMxQixPQUFPO0FBQUEsVUFDTixRQUFRO0FBQUEsVUFDUixTQUFTO0FBQUEsVUFDVCxTQUFTLE9BQU87QUFBQSxVQUNoQixVQUFVO0FBQUEsVUFDVixRQUFRLFVBQVU7QUFBQSxVQUNsQixRQUFRO0FBQUEsVUFDUjtBQUFBLFFBQ0YsQ0FBQyxFQUNBLE9BQU8scUVBQXFFLEVBQzVFLE9BQU87QUFDVixZQUFJLE9BQU87QUFDVCxjQUFJLE1BQU0sU0FBUyxRQUFTLFFBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsUUFBUSxXQUFXLE9BQU8sMkhBQXVCLENBQUM7QUFDM0csZ0JBQU0sSUFBSSxNQUFNLHlEQUFZLE1BQU0sT0FBTyxFQUFFO0FBQUEsUUFDN0M7QUFDQSxxQkFBYTtBQUFBLE1BQ2Y7QUFDQSxVQUFJLENBQUMsWUFBWSxJQUFJO0FBQ25CLGVBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyw2RkFBa0IsQ0FBQztBQUFBLE1BQ3pEO0FBRUEsVUFBSTtBQUNKLFVBQUk7QUFDRixpQkFBUyxNQUFNLHNCQUFzQjtBQUFBLFVBQ25DLGNBQWMsVUFBVTtBQUFBLFVBQ3hCLE9BQU87QUFBQSxVQUNQLFFBQVEsVUFBVTtBQUFBLFVBQ2xCLE9BQU8sVUFBVTtBQUFBLFFBQ25CLENBQUM7QUFBQSxNQUNILFNBQVMsR0FBRztBQUNWLGNBQU0sTUFBTSxLQUFLLHFCQUFxQixFQUFFLE9BQU8sRUFBRSxRQUFRLFVBQVUsT0FBTyxPQUFPLENBQUMsR0FBRyxhQUFZLG9CQUFJLEtBQUssR0FBRSxZQUFZLEVBQUUsQ0FBQyxFQUFFLEdBQUcsTUFBTSxXQUFXLEVBQUU7QUFDbkosZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxRQUFRLFVBQVUsT0FBTyxPQUFPLENBQUMsRUFBRSxDQUFDO0FBQUEsTUFDbkU7QUFFQSxZQUFNLEVBQUUsT0FBTyxVQUFVLElBQUksTUFBTSxNQUNoQyxLQUFLLHFCQUFxQixFQUMxQixPQUFPLEVBQUUsU0FBUyxRQUFRLGFBQVksb0JBQUksS0FBSyxHQUFFLFlBQVksRUFBRSxDQUFDLEVBQ2hFLEdBQUcsTUFBTSxXQUFXLEVBQUU7QUFDekIsVUFBSSxXQUFXO0FBQ2IsZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxRQUFRLFdBQVcsUUFBUSxPQUFPLHlNQUFvQyxDQUFDO0FBQUEsTUFDdEc7QUFDQSxVQUFJO0FBQ0YsY0FBTSxZQUFZLE1BQU0seUJBQXlCLE1BQU07QUFDdkQsY0FBTSxTQUFTLFlBQVksY0FBYztBQUN6QyxjQUFNLEVBQUUsTUFBTSxJQUFJLE1BQU0sTUFDckIsS0FBSyxxQkFBcUIsRUFDMUIsT0FBTyxFQUFFLFFBQVEsT0FBTyxZQUFZLE9BQU8scURBQWtCLGFBQVksb0JBQUksS0FBSyxHQUFFLFlBQVksRUFBRSxDQUFDLEVBQ25HLEdBQUcsTUFBTSxXQUFXLEVBQUU7QUFDekIsWUFBSSxNQUFPLE9BQU0sSUFBSSxNQUFNLHlEQUFZLE1BQU0sT0FBTyxFQUFFO0FBQ3RELGVBQU9BLE1BQUssVUFBVSxZQUFZLE1BQU0sS0FBSztBQUFBLFVBQzNDO0FBQUEsVUFDQTtBQUFBLFVBQ0EsUUFBUSxVQUFVO0FBQUEsVUFDbEIsT0FBTyxZQUFZLFNBQVk7QUFBQSxRQUNqQyxDQUFDO0FBQUEsTUFDSCxRQUFRO0FBQ04sZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxRQUFRLFdBQVcsUUFBUSxRQUFRLFVBQVUsT0FBTyxDQUFDO0FBQUEsTUFDcEY7QUFBQSxJQUNGO0FBR0EsUUFBSSxXQUFXLG1CQUFtQjtBQUNoQyxhQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLFNBQVMsZUFBZSxFQUFFLENBQUM7QUFBQSxJQUMxRDtBQUlBLFFBQUksV0FBVyxzQkFBc0I7QUFDbkMsVUFBSSxDQUFDLGVBQWUsYUFBYSxHQUFHO0FBQ2xDLGVBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyw2Q0FBVSxDQUFDO0FBQUEsTUFDakQ7QUFDQSxZQUFNLENBQUMsSUFBSSxFQUFFLElBQUksTUFBTSxRQUFRLElBQUksQ0FBQyxlQUFlLFNBQVMsR0FBRyxlQUFlLFNBQVMsQ0FBQyxDQUFDO0FBQ3pGLFlBQU0sWUFBWSxDQUFDLE9BQW1EO0FBQUEsUUFDcEUsT0FBTyxFQUFFO0FBQUEsUUFDVCxTQUFTLEVBQUU7QUFBQSxRQUNYLEtBQUssRUFBRTtBQUFBLE1BQ1Q7QUFHQSxZQUFNLEVBQUUsTUFBTSxjQUFjLElBQUksTUFBTSxNQUNuQyxLQUFLLG9CQUFvQixFQUN6QixPQUFPLFNBQVMsRUFDaEIsR0FBRyxlQUFlLEtBQUssRUFDdkIsR0FBRyxhQUFhLElBQUksRUFDcEIsR0FBRyxlQUFlLEtBQUs7QUFDMUIsWUFBTSxPQUNKLE1BQU0sUUFBUTtBQUFBLFNBQ1gsaUJBQWlCLENBQUMsR0FBRyxJQUFJLE9BQU8sY0FBYztBQUM3QyxjQUFJO0FBQ0Ysa0JBQU0sZUFBZSxNQUFNLDBCQUEwQixVQUFVLEVBQUU7QUFDakUsZ0JBQUksQ0FBQyxhQUFjLFFBQU87QUFDMUIsa0JBQU0sSUFBSSxNQUFNLHlCQUF5QixZQUFZO0FBQ3JELG1CQUFPLEVBQUUsTUFBTSxPQUFPLFVBQVUsUUFBUSxFQUFFLEdBQUcsU0FBUyxFQUFFLGlCQUFpQjtBQUFBLFVBQzNFLFFBQVE7QUFDTixtQkFBTztBQUFBLFVBQ1Q7QUFBQSxRQUNGLENBQUM7QUFBQSxNQUNILEdBQ0EsT0FBTyxDQUFDLE1BQThDLEtBQUssSUFBSTtBQUNqRSxhQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLElBQUksVUFBVSxFQUFFLEdBQUcsSUFBSSxVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUM7QUFBQSxJQUMxRTtBQUdGLFFBQUksV0FBVyx3QkFBd0I7QUFDckMsVUFBSSxDQUFDLGVBQWUsYUFBYSxFQUFHLFFBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyw2Q0FBVSxDQUFDO0FBQ25GLFlBQU0sUUFBUTtBQUNkLFlBQU1FLFNBQVEsTUFBTSxVQUFVLFFBQVEsTUFBTSxVQUFVLFFBQVEsTUFBTSxVQUFVLFFBQVEsTUFBTSxRQUFRO0FBQ3BHLFVBQUksQ0FBQ0EsT0FBTyxRQUFPRixNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8saURBQXdCLENBQUM7QUFDekUsWUFBTSxTQUFTLE9BQU8sTUFBTSxNQUFNO0FBQ2xDLFVBQUksQ0FBQyxPQUFPLFNBQVMsTUFBTSxLQUFLLFVBQVUsRUFBRyxRQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sOEVBQWtCLENBQUM7QUFDcEcsVUFBSTtBQUNKLFVBQUk7QUFDRixZQUFJRSxXQUFVLE9BQU87QUFDbkIsY0FBSSxDQUFDLE1BQU0sWUFBYSxRQUFPRixNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sc0NBQWEsQ0FBQztBQUMxRSxnQkFBTSxFQUFFLE1BQU0sV0FBVyxPQUFPLGVBQWUsSUFBSSxNQUFNLE1BQ3RELEtBQUssb0JBQW9CLEVBQ3pCLE9BQU8sZ0JBQWdCLEVBQ3ZCLEdBQUcsTUFBTSxNQUFNLFdBQVcsRUFDMUIsR0FBRyxlQUFlLEtBQUssRUFDdkIsWUFBWTtBQUNmLGNBQUksZUFBZ0IsT0FBTSxJQUFJLE1BQU0sa0RBQWUsZUFBZSxPQUFPLEVBQUU7QUFDM0UsY0FBSSxDQUFDLFVBQVcsUUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLDRDQUFjLENBQUM7QUFDbkUseUJBQWdCLE1BQU0sMEJBQTBCLFVBQVUsRUFBRSxLQUFNO0FBQ2xFLGNBQUksQ0FBQyxhQUFjLFFBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyxvRkFBd0IsQ0FBQztBQUFBLFFBQ2xGO0FBQ0EsY0FBTSxTQUFTLE1BQU0sbUJBQW1CRSxRQUFPLFFBQVEsWUFBWTtBQUNuRSxlQUFPRixNQUFLLFVBQVUsS0FBSyxFQUFFLFFBQVEsT0FBQUUsUUFBTyxPQUFPLENBQUM7QUFBQSxNQUN0RCxTQUFTLEdBQUc7QUFDVixlQUFPRixNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sT0FBTyxDQUFDLEVBQUUsQ0FBQztBQUFBLE1BQ2pEO0FBQUEsSUFDRjtBQUtFLFFBQUksV0FBVyxjQUFjO0FBQzNCLFVBQUksQ0FBQyxlQUFlLGFBQWEsR0FBRztBQUNsQyxlQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sNkNBQVUsQ0FBQztBQUFBLE1BQ2pEO0FBQ0EsWUFBTSxRQUFRO0FBQ2QsWUFBTUUsU0FBUSxNQUFNLFVBQVUsT0FBTyxZQUFZLE1BQU0sVUFBVSxPQUFPLFlBQVk7QUFDcEYsVUFBSSxDQUFDQSxPQUFPLFFBQU9GLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyx3Q0FBb0IsQ0FBQztBQUNyRSxZQUFNLFNBQVMsT0FBTyxNQUFNLE1BQU07QUFDbEMsVUFBSSxDQUFDLE9BQU8sU0FBUyxNQUFNLEtBQUssVUFBVSxHQUFHO0FBQzNDLGVBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyw4RUFBa0IsQ0FBQztBQUFBLE1BQ3pEO0FBQ0EsVUFBSTtBQUNKLFVBQUk7QUFDRixhQUFLLE1BQU0sTUFBTSxNQUFNLEdBQUcsS0FBSyxJQUFJLFVBQVUsTUFBTSxHQUFHLEtBQUssR0FBRyxzQ0FBUSxJQUFJRixZQUFXLGtCQUFrQixTQUFTO0FBQUEsTUFDbEgsU0FBUyxHQUFHO0FBQ1YsZUFBT0UsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLE9BQU8sQ0FBQyxFQUFFLENBQUM7QUFBQSxNQUNqRDtBQUNBLFVBQUk7QUFDRixjQUFNLFNBQVMsTUFBTSxnQkFBZ0JFLFFBQU8sSUFBSSxNQUFNO0FBQ3RELGVBQU9GLE1BQUssVUFBVSxLQUFLLEVBQUUsUUFBUSxPQUFPLE1BQU0sT0FBTyxJQUFJLE9BQU8sQ0FBQztBQUFBLE1BQ3ZFLFNBQVMsR0FBRztBQUNWLGVBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyxPQUFPLENBQUMsRUFBRSxDQUFDO0FBQUEsTUFDakQ7QUFBQSxJQUNGO0FBTUEsUUFBSSxXQUFXLG9CQUFvQjtBQUNqQyxVQUFJLENBQUMsZUFBZSxhQUFhLEdBQUc7QUFDbEMsZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLDZDQUFVLENBQUM7QUFBQSxNQUNqRDtBQUNBLFlBQU0sRUFBRSxNQUFNLGNBQWMsT0FBTyxNQUFNLElBQUksTUFBTSxNQUNoRCxLQUFLLG9CQUFvQixFQUN6QixPQUFPLElBQUksRUFDWCxHQUFHLGVBQWUsSUFBSTtBQUN6QixVQUFJLE1BQU8sT0FBTSxJQUFJLE1BQU0saURBQWMsTUFBTSxPQUFPLEVBQUU7QUFDeEQsWUFBTSxTQUFTLGdCQUFnQixDQUFDLEdBQUcsSUFBSSxDQUFDLE1BQU0sRUFBRSxFQUFZO0FBQzVELFVBQUksTUFBTSxXQUFXLEVBQUcsUUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxXQUFXLENBQUMsR0FBRyxRQUFRLENBQUMsRUFBRSxDQUFDO0FBQ2hGLFlBQU0sRUFBRSxNQUFNLFNBQVMsT0FBTyxRQUFRLElBQUksTUFBTSxNQUM3QyxLQUFLLFVBQVUsRUFDZixPQUFPLHlDQUF5QyxFQUNoRCxHQUFHLFlBQVksS0FBSztBQUN2QixVQUFJLFFBQVMsT0FBTSxJQUFJLE1BQU0sbURBQVcsUUFBUSxPQUFPLEVBQUU7QUFDekQsWUFBTSxVQUFVLE1BQU07QUFBQSxRQUNwQixJQUFJO0FBQUEsV0FDRCxXQUFXLENBQUMsR0FDVixJQUFJLENBQUMsTUFBZ0UsRUFBRSxVQUFVLGdCQUFnQixLQUFLLEtBQUssSUFBSSxFQUMvRyxPQUFPLENBQUMsTUFBbUIsQ0FBQyxDQUFDLEtBQUssc0JBQXNCLEtBQUssQ0FBQyxDQUFDO0FBQUEsUUFDcEU7QUFBQSxNQUNGO0FBQ0EsWUFBTSxZQUFrRSxDQUFDO0FBQ3pFLFlBQU0sU0FBOEMsQ0FBQztBQUNyRCxpQkFBVyxLQUFLLFNBQVM7QUFDdkIsWUFBSTtBQUNGLGdCQUFNLFNBQVNGLFlBQVcsQ0FBQztBQUMzQixnQkFBTSxVQUFVLE1BQU0sa0JBQWtCLE1BQU07QUFDOUMsY0FBSSxXQUFXLEVBQUc7QUFDbEIsZ0JBQU0sU0FBUyxNQUFNLGVBQWUsUUFBUSxPQUFPO0FBQ25ELGNBQUksT0FBUSxXQUFVLEtBQUssRUFBRSxRQUFRLEdBQUcsUUFBUSxTQUFTLE9BQU8sQ0FBQztBQUFBLFFBQ25FLFNBQVMsR0FBRztBQUNWLGlCQUFPLEtBQUssRUFBRSxRQUFRLEdBQUcsT0FBTyxPQUFPLENBQUMsRUFBRSxDQUFDO0FBQUEsUUFDN0M7QUFBQSxNQUNGO0FBQ0EsYUFBT0UsTUFBSyxVQUFVLEtBQUssRUFBRSxXQUFXLE9BQU8sQ0FBQztBQUFBLElBQ2xEO0FBUUEsUUFBSSxXQUFXLHFCQUFxQjtBQUNsQyxVQUFJLENBQUMsZUFBZSxhQUFhLEdBQUc7QUFDbEMsZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLDZDQUFVLENBQUM7QUFBQSxNQUNqRDtBQUNBLFlBQU0sY0FBYyxPQUFRLEtBQWtDLGVBQWUsRUFBRSxFQUFFLEtBQUs7QUFDdEYsVUFBSSxDQUFDLFlBQWEsUUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLDJCQUFpQixDQUFDO0FBQ3hFLFlBQU0sRUFBRSxNQUFNLFdBQVcsT0FBTyxLQUFLLElBQUksTUFBTSxNQUM1QyxLQUFLLG9CQUFvQixFQUN6QixPQUFPLElBQUksRUFDWCxHQUFHLE1BQU0sV0FBVyxFQUNwQixZQUFZO0FBQ2YsVUFBSSxLQUFNLE9BQU0sSUFBSSxNQUFNLG1EQUFXLEtBQUssT0FBTyxFQUFFO0FBQ25ELFlBQU0sZUFBZSxZQUFZLE1BQU0sMEJBQTBCLFVBQVUsRUFBRSxJQUFJO0FBQ2pGLFVBQUksQ0FBQyxjQUFjO0FBQ2pCLGVBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsU0FBUyxNQUFNLFFBQVEsa0VBQXFCLENBQUM7QUFBQSxNQUM1RTtBQUNBLFlBQU0sRUFBRSxNQUFNLFNBQVMsT0FBTyxRQUFRLElBQUksTUFBTSxNQUM3QyxLQUFLLFVBQVUsRUFDZixPQUFPLHlDQUF5QyxFQUNoRCxHQUFHLFlBQVksV0FBVztBQUM3QixVQUFJLFFBQVMsT0FBTSxJQUFJLE1BQU0sbURBQVcsUUFBUSxPQUFPLEVBQUU7QUFDekQsWUFBTSxVQUFVLE1BQU07QUFBQSxRQUNwQixJQUFJO0FBQUEsV0FDRCxXQUFXLENBQUMsR0FDVixJQUFJLENBQUMsTUFBZ0UsRUFBRSxVQUFVLGdCQUFnQixLQUFLLEtBQUssSUFBSSxFQUMvRyxPQUFPLENBQUMsTUFBbUIsQ0FBQyxDQUFDLEtBQUssc0JBQXNCLEtBQUssQ0FBQyxDQUFDO0FBQUEsUUFDcEU7QUFBQSxNQUNGO0FBQ0EsWUFBTSxZQUFrRSxDQUFDO0FBQ3pFLFlBQU0sU0FBOEMsQ0FBQztBQUNyRCxpQkFBVyxLQUFLLFNBQVM7QUFDdkIsWUFBSTtBQUNGLGdCQUFNLFNBQVNGLFlBQVcsQ0FBQztBQUMzQixnQkFBTSxFQUFFLFFBQVEsSUFBSSxNQUFNLHNCQUFzQixjQUFjLE1BQU07QUFDcEUsY0FBSSxXQUFXLEVBQUc7QUFDbEIsZ0JBQU0sU0FBUyxNQUFNLGdCQUFnQkEsWUFBVyxZQUFZLEdBQUcsUUFBUSxPQUFPO0FBQzlFLGNBQUksT0FBUSxXQUFVLEtBQUssRUFBRSxRQUFRLEdBQUcsUUFBUSxTQUFTLE9BQU8sQ0FBQztBQUFBLFFBQ25FLFNBQVMsR0FBRztBQUNWLGlCQUFPLEtBQUssRUFBRSxRQUFRLEdBQUcsT0FBTyxPQUFPLENBQUMsRUFBRSxDQUFDO0FBQUEsUUFDN0M7QUFBQSxNQUNGO0FBQ0EsYUFBT0UsTUFBSyxVQUFVLEtBQUssRUFBRSxXQUFXLE9BQU8sQ0FBQztBQUFBLElBQ2xEO0FBR0EsUUFBSSxXQUFXLDRCQUE0QjtBQUN6QyxVQUFJLENBQUMsZUFBZSxhQUFhLEdBQUc7QUFDbEMsZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLDZDQUFVLENBQUM7QUFBQSxNQUNqRDtBQUNBLFlBQU1LLGNBQWMsS0FBaUMsWUFBWSxLQUFLO0FBQ3RFLFVBQUksQ0FBQ0EsZUFBYyxDQUFDLHlFQUF5RSxLQUFLQSxXQUFVLEdBQUc7QUFDN0csZUFBT0wsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLDZDQUFVLENBQUM7QUFBQSxNQUNqRDtBQUNBLFlBQU0sU0FBUyxnQkFBZ0JLLFdBQVU7QUFDekMsWUFBTSxFQUFFLE1BQU0sWUFBWSxNQUFNLElBQUksTUFBTSxNQUN2QyxLQUFLLHFCQUFxQixFQUMxQixPQUFPLGtDQUFrQyxFQUN6QyxHQUFHLFdBQVcsTUFBTSxFQUNwQixZQUFZO0FBQ2YsVUFBSSxTQUFTLENBQUMsY0FBYyxXQUFXLFdBQVcsZ0JBQWdCO0FBQ2hFLGVBQU9MLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyx5REFBWSxDQUFDO0FBQUEsTUFDbkQ7QUFDQSxZQUFNLGNBQWMsT0FBTyxXQUFtQjtBQUM1QyxjQUFNLEVBQUUsT0FBTyxZQUFZLElBQUksTUFBTSxNQUFNLElBQUksNEJBQTRCLEVBQUUsV0FBVyxPQUFPLENBQUM7QUFDaEcsWUFBSSxhQUFhO0FBQ2YsaUJBQU9BLE1BQUssVUFBVSxLQUFLO0FBQUEsWUFDekIsT0FBTywyS0FBK0IsWUFBWSxPQUFPO0FBQUEsWUFDekQsUUFBUTtBQUFBLFlBQ1IsU0FBUztBQUFBLFVBQ1gsQ0FBQztBQUFBLFFBQ0g7QUFDQSxlQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLFFBQVEsYUFBYSxTQUFTLE9BQU8sQ0FBQztBQUFBLE1BQ3JFO0FBQ0EsVUFBSSxXQUFXLFdBQVcsZUFBZSxXQUFXLFFBQVMsUUFBTyxZQUFZLFdBQVcsT0FBTztBQUNsRyxVQUFJLFdBQVcsV0FBVyxVQUFVO0FBQ2xDLGVBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsUUFBUSxVQUFVLFNBQVMsV0FBVyxRQUFRLENBQUM7QUFBQSxNQUM5RTtBQUNBLFVBQUksQ0FBQyxXQUFXLFNBQVM7QUFDdkIsZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxRQUFRLFdBQVcsU0FBUyxNQUFNLFNBQVMsK0RBQWEsQ0FBQztBQUFBLE1BQ3hGO0FBQ0EsVUFBSTtBQUNGLGNBQU0sU0FBUyxXQUFXO0FBQzFCLGNBQU0sWUFBWSxNQUFNLHdCQUF3QixNQUFNO0FBQ3RELFlBQUksQ0FBQyxXQUFXO0FBQ2QsZ0JBQU0sT0FBTyxPQUFPLFdBQVcsSUFBSSxFQUFFLFFBQVEsVUFBVSxTQUFTLFFBQVEsT0FBTyxvQ0FBZ0IsQ0FBQztBQUNoRyxpQkFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxRQUFRLFVBQVUsU0FBUyxPQUFPLENBQUM7QUFBQSxRQUNsRTtBQUNBLGNBQU0sT0FBTyxPQUFPLFdBQVcsSUFBSSxFQUFFLFFBQVEsYUFBYSxTQUFTLE9BQU8sQ0FBQztBQUMzRSxlQUFPLFlBQVksTUFBTTtBQUFBLE1BQzNCLFFBQVE7QUFDTixlQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLFFBQVEsV0FBVyxTQUFTLFdBQVcsUUFBUSxDQUFDO0FBQUEsTUFDL0U7QUFBQSxJQUNGO0FBR0EsUUFBSSxXQUFXLDhCQUE4QjtBQUMzQyxVQUFJLENBQUMsZUFBZSxhQUFhLEdBQUc7QUFDbEMsZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLDZDQUFVLENBQUM7QUFBQSxNQUNqRDtBQUNBLFlBQU0sRUFBRSxNQUFNLE1BQU0sTUFBTSxJQUFJLE1BQU0sTUFDakMsS0FBSyxxQkFBcUIsRUFDMUIsT0FBTyx1RkFBdUYsRUFDOUYsR0FBRyxVQUFVLGNBQWMsRUFDM0IsTUFBTSxjQUFjLEVBQUUsV0FBVyxNQUFNLENBQUMsRUFDeEMsTUFBTSxFQUFFO0FBQ1gsVUFBSSxNQUFPLFFBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyx5REFBWSxNQUFNLE9BQU8sR0FBRyxDQUFDO0FBQzVFLFlBQU0sVUFBVSxDQUFDLEdBQUcsSUFBSSxLQUFLLFFBQVEsQ0FBQyxHQUFHLElBQUksQ0FBQyxRQUFRLElBQUksT0FBTyxFQUFFLE9BQU8sQ0FBQyxPQUFxQixRQUFRLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFDN0csWUFBTSxlQUFlLENBQUMsR0FBRyxJQUFJLEtBQUssUUFBUSxDQUFDLEdBQUcsSUFBSSxDQUFDLFFBQVEsSUFBSSxRQUFRLEVBQUUsT0FBTyxDQUFDLE9BQXFCLFFBQVEsRUFBRSxDQUFDLENBQUMsQ0FBQztBQUNuSCxZQUFNLENBQUMsZ0JBQWdCLGdCQUFnQixJQUFJLE1BQU0sUUFBUSxJQUFJO0FBQUEsUUFDM0QsUUFBUSxTQUNKLE1BQU0sS0FBSyxVQUFVLEVBQUUsT0FBTyxVQUFVLEVBQUUsR0FBRyxNQUFNLE9BQU8sSUFDMUQsUUFBUSxRQUFRLEVBQUUsTUFBTSxDQUFDLEdBQUcsT0FBTyxLQUFLLENBQUM7QUFBQSxRQUM3QyxhQUFhLFNBQ1QsTUFBTSxLQUFLLG9CQUFvQixFQUFFLE9BQU8sU0FBUyxFQUFFLEdBQUcsTUFBTSxZQUFZLElBQ3hFLFFBQVEsUUFBUSxFQUFFLE1BQU0sQ0FBQyxHQUFHLE9BQU8sS0FBSyxDQUFDO0FBQUEsTUFDL0MsQ0FBQztBQUNELFVBQUksZUFBZSxTQUFTLGlCQUFpQixPQUFPO0FBQ2xELGVBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTywyRUFBZSxDQUFDO0FBQUEsTUFDdEQ7QUFDQSxZQUFNLFlBQVksSUFBSSxLQUFLLGVBQWUsUUFBUSxDQUFDLEdBQUcsSUFBSSxDQUFDLFlBQVksQ0FBQyxRQUFRLElBQUksUUFBUSxLQUFLLENBQUMsQ0FBQztBQUNuRyxZQUFNLGdCQUFnQixJQUFJLEtBQUssaUJBQWlCLFFBQVEsQ0FBQyxHQUFHLElBQUksQ0FBQyxjQUFjLENBQUMsVUFBVSxJQUFJLFVBQVUsSUFBSSxDQUFDLENBQUM7QUFDOUcsYUFBT0EsTUFBSyxVQUFVLEtBQUs7QUFBQSxRQUN6QixVQUFVLFFBQVEsQ0FBQyxHQUFHLElBQUksQ0FBQyxLQUFLLFVBQVU7QUFDeEMsZ0JBQU0sVUFBVSxJQUFJO0FBQ3BCLGdCQUFNLFlBQVksT0FBTyxRQUFRLGFBQWEsRUFBRTtBQUNoRCxnQkFBTSxjQUFjLFFBQVEsY0FBYyxPQUFPLFFBQVEsV0FBVyxJQUFJO0FBQ3hFLGdCQUFNLFNBQVMsT0FBTyxRQUFRLFVBQVUsSUFBSSxVQUFVLEdBQUc7QUFDekQsZ0JBQU0sZ0JBQWdCLFFBQVEsQ0FBQyxHQUFHLE1BQU0sR0FBRyxLQUFLLEVBQUUsS0FBSyxDQUFDLGFBQWE7QUFDbkUsa0JBQU0sZUFBZSxTQUFTO0FBQzlCLG1CQUFPLFNBQVMsV0FBVyxlQUFlLFFBQVEsU0FBUyxPQUFPLEtBQ2hFLFNBQVMsWUFBWSxJQUFJLFdBQVcsU0FBUyxhQUFhLElBQUksWUFDOUQsYUFBYSxjQUFjLGFBQWEsT0FBTyxhQUFhLFVBQVUsU0FBUyxVQUFVLEdBQUcsTUFBTSxXQUNqRyxhQUFhLGNBQWMsT0FBTyxhQUFhLFdBQVcsSUFBSSxVQUFVO0FBQUEsVUFDN0UsQ0FBQztBQUNELGlCQUFPO0FBQUEsWUFDTCxJQUFJLElBQUk7QUFBQSxZQUNSLFlBQVksSUFBSSxRQUFRLFFBQVEsa0JBQWtCLEVBQUU7QUFBQSxZQUNwRCxhQUFhLElBQUk7QUFBQSxZQUNqQixnQkFBZ0IsSUFBSSxVQUFVLFVBQVUsSUFBSSxJQUFJLE9BQU8sS0FBSyxPQUFPO0FBQUEsWUFDbkU7QUFBQSxZQUNBO0FBQUEsWUFDQSxlQUFlLElBQUksV0FBVyxjQUFjLElBQUksSUFBSSxRQUFRLEtBQUssT0FBTztBQUFBLFlBQ3hFO0FBQUEsWUFDQSxRQUFRLElBQUk7QUFBQSxZQUNaLFFBQVEsSUFBSTtBQUFBLFlBQ1osT0FBTyxJQUFJO0FBQUEsWUFDWCxXQUFXLFFBQVEsY0FBYztBQUFBLFlBQ2pDLFlBQVksUUFBUSxZQUFZO0FBQUEsWUFDaEMsV0FBVyxJQUFJO0FBQUEsWUFDZixXQUFXLElBQUk7QUFBQSxVQUNqQjtBQUFBLFFBQ0YsQ0FBQyxFQUFFLE1BQU0sR0FBRyxDQUFDO0FBQUEsTUFDZixDQUFDO0FBQUEsSUFDSDtBQUlBLFFBQUksV0FBVyxzQkFBc0I7QUFDbkMsVUFBSSxDQUFDLGVBQWUsYUFBYSxHQUFHO0FBQ2xDLGVBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyw2Q0FBVSxDQUFDO0FBQUEsTUFDakQ7QUFDQSxZQUFNLFFBQVE7QUFPZCxZQUFNLGNBQWMsTUFBTSxhQUFhLEtBQUs7QUFDNUMsWUFBTSxZQUFZLE1BQU07QUFDeEIsWUFBTSxTQUFTLE1BQU0sUUFBUSxLQUFLO0FBQ2xDLFlBQU0sY0FBYyxNQUFNLGFBQWEsS0FBSyxLQUFLO0FBQ2pELFlBQU1LLGNBQWEsTUFBTSxZQUFZLEtBQUs7QUFDMUMsVUFBSSxDQUFDLGVBQWUsQ0FBQyxVQUFVLENBQUNBLGVBQWMsQ0FBQyx5RUFBeUUsS0FBS0EsV0FBVSxHQUFHO0FBQ3hJLGVBQU9MLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyxpRkFBZ0IsQ0FBQztBQUFBLE1BQ3ZEO0FBQ0EsVUFBSSxDQUFDLGlDQUFpQyxLQUFLLE1BQU0sS0FBSyxFQUFFLE9BQU8sTUFBTSxJQUFJLE1BQU0sT0FBTyxNQUFNLElBQUksTUFBbUI7QUFDakgsZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLGtHQUF1QixDQUFDO0FBQUEsTUFDOUQ7QUFDQSxVQUFJLENBQUMsQ0FBQyxNQUFNLE1BQU0sT0FBTyxNQUFNLEVBQUUsU0FBUyxPQUFPLFNBQVMsQ0FBQyxHQUFHO0FBQzVELGVBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyxtREFBVyxDQUFDO0FBQUEsTUFDbEQ7QUFDQSxVQUFJLGNBQWMsU0FBUyxDQUFDLFFBQVEsS0FBSyxNQUFNLEdBQUc7QUFDaEQsZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLDZEQUFnQixDQUFDO0FBQUEsTUFDdkQ7QUFDQSxXQUFLLGNBQWMsU0FBUyxjQUFjLFVBQVUsUUFBUSxXQUFXLEdBQUc7QUFDeEUsZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLGlGQUFnQixDQUFDO0FBQUEsTUFDdkQ7QUFFQSxZQUFNLEVBQUUsTUFBTSxVQUFVLElBQUksTUFBTSxNQUMvQixLQUFLLFVBQVUsRUFDZixPQUFPLHFDQUFxQyxFQUM1QyxHQUFHLE1BQU0sV0FBVyxFQUNwQixZQUFZO0FBQ2YsVUFBSSxDQUFDLGFBQWEsQ0FBQyxPQUFPLFVBQVUsZUFBZSxFQUFFLEVBQUUsU0FBUyxjQUFJLEdBQUc7QUFDckUsZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLCtEQUFhLENBQUM7QUFBQSxNQUNwRDtBQUNBLFVBQUk7QUFDSixVQUFJO0FBQ0YsaUJBQVMsVUFBVSxVQUFVLGdCQUFnQiwwQkFBTTtBQUFBLE1BQ3JELFNBQVMsR0FBRztBQUNWLGVBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyxPQUFPLENBQUMsRUFBRSxDQUFDO0FBQUEsTUFDakQ7QUFFQSxVQUFJO0FBQ0osVUFBSTtBQUNKLFVBQUksZ0JBQStCO0FBQ25DLFVBQUksY0FBYyxNQUFNO0FBQ3RCLHVCQUFlLGtCQUFrQjtBQUNqQyxxQkFBYTtBQUFBLE1BQ2YsV0FBVyxjQUFjLE1BQU07QUFDN0IsY0FBTSxFQUFFLE1BQU0sVUFBVSxJQUFJLE1BQU0sTUFDL0IsS0FBSyxvQkFBb0IsRUFDekIsT0FBTyxxQkFBcUIsRUFDNUIsR0FBRyxNQUFNLFdBQVcsRUFDcEIsWUFBWTtBQUNmLFlBQUksQ0FBQyxXQUFXLFlBQWEsUUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLG1FQUFpQixDQUFDO0FBQ25GLHVCQUFlLGtCQUFrQjtBQUNqQyxxQkFBYSxXQUFNLFVBQVUsSUFBSTtBQUNqQyx3QkFBZ0IsVUFBVTtBQUFBLE1BQzVCLFdBQVcsY0FBYyxPQUFPO0FBQ3BDLGNBQU0sRUFBRSxNQUFNLFVBQVUsSUFBSSxNQUFNLE1BQy9CLEtBQUssb0JBQW9CLEVBQ3pCLE9BQU8scUJBQXFCLEVBQzVCLEdBQUcsTUFBTSxXQUFXLEVBQ3BCLFlBQVk7QUFDZixjQUFNLFdBQVcsYUFBYSxDQUFDLFVBQVUsY0FDckMsTUFBTSwwQkFBMEIsVUFBVSxFQUFFLElBQzVDO0FBQ0osWUFBSSxDQUFDLGFBQWEsVUFBVSxlQUFlLENBQUMsVUFBVTtBQUM5QyxpQkFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLGtHQUF1QixDQUFDO0FBQUEsUUFDOUQ7QUFDQSx1QkFBZTtBQUNmLHFCQUFhLFlBQU8sVUFBVSxJQUFJO0FBQ2xDLHdCQUFnQixVQUFVO0FBQUEsTUFDNUIsT0FBTztBQUNMLHVCQUFlLGtCQUFrQjtBQUNqQyxxQkFBYTtBQUFBLE1BQ2Y7QUFFQSxZQUFNLFNBQVMsZ0JBQWdCSyxXQUFVO0FBQ3pDLFlBQU0sVUFBVSxFQUFFLFdBQVcsUUFBUSxRQUFRLGNBQWMsWUFBWTtBQUN2RSxVQUFJLEVBQUUsTUFBTSxXQUFXLElBQUksTUFBTSxNQUM5QixLQUFLLHFCQUFxQixFQUMxQixPQUFPLG1EQUFtRCxFQUMxRCxHQUFHLFdBQVcsTUFBTSxFQUNwQixZQUFZO0FBQ2YsVUFBSSxrQkFBa0I7QUFDdEIsVUFBSSxZQUFZO0FBQ2QsY0FBTSxRQUFRLFdBQVc7QUFDekIsWUFDRSxXQUFXLFdBQVcsa0JBQWtCLFdBQVcsWUFBWSxlQUMvRCxXQUFXLGFBQWEsaUJBQWlCLE1BQU0sY0FBYyxhQUM3RCxNQUFNLFdBQVcsVUFBVSxNQUFNLGdCQUFnQixlQUNqRCxNQUFNLFdBQVcsVUFBVSxNQUFNLGlCQUFpQixjQUNsRDtBQUNBLGlCQUFPTCxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8scUhBQXNCLENBQUM7QUFBQSxRQUM3RDtBQUFBLE1BQ0YsT0FBTztBQUNMLGNBQU0sV0FBVyxNQUFNLE1BQ3BCLEtBQUsscUJBQXFCLEVBQzFCLE9BQU87QUFBQSxVQUNOLFFBQVE7QUFBQSxVQUNSLFNBQVM7QUFBQSxVQUNULFNBQVM7QUFBQSxVQUNULGlCQUFpQixPQUFPO0FBQUEsVUFDeEIsVUFBVTtBQUFBLFVBQ1YsUUFBUSxPQUFPLE1BQU07QUFBQSxVQUNyQixRQUFRO0FBQUEsVUFDUjtBQUFBLFFBQ0YsQ0FBQyxFQUNBLE9BQU8sbURBQW1ELEVBQzFELE9BQU87QUFDVixxQkFBYSxTQUFTO0FBQ3RCLFlBQUksU0FBUyxTQUFTLENBQUMsWUFBWTtBQUNqQyxnQkFBTSxRQUFRLE1BQU0sTUFDakIsS0FBSyxxQkFBcUIsRUFDMUIsT0FBTyxtREFBbUQsRUFDMUQsR0FBRyxXQUFXLE1BQU0sRUFDcEIsWUFBWTtBQUNmLGNBQUksQ0FBQyxNQUFNLE1BQU07QUFDZixtQkFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLHFFQUFjLFNBQVMsT0FBTyxXQUFXLDRDQUFTLEdBQUcsQ0FBQztBQUFBLFVBQzVGO0FBQ0EsdUJBQWEsTUFBTTtBQUNuQixnQkFBTSxRQUFRLFdBQVc7QUFDekIsY0FDRSxXQUFXLFdBQVcsa0JBQWtCLFdBQVcsWUFBWSxlQUMvRCxXQUFXLGFBQWEsaUJBQWlCLE1BQU0sV0FBVyxVQUMxRCxNQUFNLFdBQVcsVUFBVSxNQUFNLGNBQWMsYUFDL0MsTUFBTSxnQkFBZ0IsZUFBZSxNQUFNLGlCQUFpQixjQUM1RDtBQUNBLG1CQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8scUhBQXNCLENBQUM7QUFBQSxVQUM3RDtBQUFBLFFBQ0YsT0FBTztBQUNMLDRCQUFrQjtBQUFBLFFBQ3BCO0FBQUEsTUFDRjtBQUVBLFlBQU0sdUJBQXVCLE9BQU9NLFlBQW1CO0FBQ3JELGNBQU0sRUFBRSxNQUFNLElBQUksTUFBTSxNQUFNLElBQUksNEJBQTRCLEVBQUUsV0FBVyxPQUFPLENBQUM7QUFDbkYsWUFBSSxPQUFPO0FBQ1QsaUJBQU9OLE1BQUssVUFBVSxLQUFLO0FBQUEsWUFDekIsT0FBTyxtREFBV00sT0FBTSx5SkFBNEIsTUFBTSxPQUFPO0FBQUEsWUFDakUsUUFBUTtBQUFBLFlBQ1IsU0FBU0E7QUFBQSxZQUNULFlBQUFEO0FBQUEsVUFDRixDQUFDO0FBQUEsUUFDSDtBQUNBLGVBQU9MLE1BQUssVUFBVSxLQUFLLEVBQUUsUUFBUSxhQUFhLFNBQVNNLFNBQVEsV0FBVyxRQUFRLFFBQVEsWUFBQUQsWUFBVyxDQUFDO0FBQUEsTUFDNUc7QUFFQSxVQUFJLFdBQVcsV0FBVyxlQUFlLFdBQVcsU0FBUztBQUMzRCxlQUFPLHFCQUFxQixXQUFXLE9BQU87QUFBQSxNQUNoRDtBQUNBLFVBQUksV0FBVyxXQUFXLGFBQWEsV0FBVyxTQUFTO0FBQ3pELFlBQUk7QUFDRixnQkFBTSxZQUFZLE1BQU0sd0JBQXdCLFdBQVcsT0FBd0I7QUFDbkYsY0FBSSxXQUFXO0FBQ2Isa0JBQU0sT0FBTyxPQUFPLFdBQVcsSUFBSSxFQUFFLFFBQVEsYUFBYSxTQUFTLFdBQVcsUUFBUSxDQUFDO0FBQ3ZGLG1CQUFPLHFCQUFxQixXQUFXLE9BQU87QUFBQSxVQUNoRDtBQUNBLGdCQUFNLE9BQU8sT0FBTyxXQUFXLElBQUksRUFBRSxRQUFRLFVBQVUsU0FBUyxXQUFXLFNBQVMsT0FBTyxvQ0FBZ0IsQ0FBQztBQUM1RyxxQkFBVyxTQUFTO0FBQUEsUUFDdEIsUUFBUTtBQUNOLGlCQUFPTCxNQUFLLFVBQVUsS0FBSyxFQUFFLFFBQVEsV0FBVyxTQUFTLFdBQVcsU0FBUyxXQUFXLFFBQVEsUUFBUSxZQUFBSyxZQUFXLENBQUM7QUFBQSxRQUN0SDtBQUFBLE1BQ0YsV0FBVyxXQUFXLFdBQVcsYUFBYSxDQUFDLGlCQUFpQjtBQUM5RCxlQUFPTCxNQUFLLFVBQVUsS0FBSyxFQUFFLFFBQVEsV0FBVyxXQUFXLFFBQVEsUUFBUSxZQUFBSyxZQUFXLENBQUM7QUFBQSxNQUN6RjtBQUVBLFVBQUksQ0FBRSxNQUFNLGdCQUFnQixRQUFRLEVBQUk7QUFDeEMsVUFBSTtBQUNKLFVBQUk7QUFDRixpQkFBUyxNQUFNLHFCQUFxQixFQUFFLGNBQWMsV0FBVyxRQUFRLFFBQVEsT0FBTyxXQUFXLENBQUM7QUFBQSxNQUNwRyxTQUFTLEdBQUc7QUFDVixjQUFNLE9BQU8sT0FBTyxXQUFXLElBQUksRUFBRSxRQUFRLFVBQVUsT0FBTyxPQUFPLENBQUMsRUFBRSxDQUFDO0FBQ3pFLGVBQU9MLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyxtREFBVyxPQUFPLENBQUMsQ0FBQyxHQUFHLENBQUM7QUFBQSxNQUM5RDtBQUNBLFlBQU0sVUFBVSxNQUFNLE1BQ25CLEtBQUsscUJBQXFCLEVBQzFCLE9BQU8sRUFBRSxRQUFRLFdBQVcsU0FBUyxRQUFRLE9BQU8sTUFBTSxhQUFZLG9CQUFJLEtBQUssR0FBRSxZQUFZLEVBQUUsQ0FBQyxFQUNoRyxHQUFHLE1BQU0sV0FBVyxFQUFFO0FBQ3pCLFVBQUksUUFBUSxPQUFPO0FBQ2pCLGVBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyw2RkFBa0IsTUFBTSxJQUFJLFNBQVMsUUFBUSxRQUFRLFdBQVcsWUFBQUssWUFBVyxDQUFDO0FBQUEsTUFDbEg7QUFDQSxVQUFJO0FBQ0YsY0FBTSxZQUFZLE1BQU0sd0JBQXdCLE1BQU07QUFDdEQsWUFBSSxDQUFDLFdBQVc7QUFDZCxnQkFBTSxPQUFPLE9BQU8sV0FBVyxJQUFJLEVBQUUsUUFBUSxVQUFVLFNBQVMsUUFBUSxPQUFPLG9DQUFnQixDQUFDO0FBQ2hHLGlCQUFPTCxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sNkNBQVUsTUFBTSxJQUFJLFNBQVMsUUFBUSxRQUFRLFNBQVMsQ0FBQztBQUFBLFFBQzdGO0FBQUEsTUFDRixRQUFRO0FBQ04sZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxRQUFRLFdBQVcsU0FBUyxRQUFRLFdBQVcsUUFBUSxRQUFRLFlBQUFLLFlBQVcsQ0FBQztBQUFBLE1BQzFHO0FBQ0EsWUFBTSxPQUFPLE9BQU8sV0FBVyxJQUFJLEVBQUUsUUFBUSxhQUFhLFNBQVMsT0FBTyxDQUFDO0FBQzNFLGFBQU8scUJBQXFCLE1BQU07QUFBQSxJQUNwQztBQUtBLFFBQUksV0FBVywwQkFBMEI7QUFDdkMsVUFBSSxDQUFDLGVBQWUsYUFBYSxHQUFHO0FBQ2xDLGVBQU9MLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyw2Q0FBVSxDQUFDO0FBQUEsTUFDakQ7QUFDQSxZQUFNLGNBQWUsS0FBa0M7QUFDdkQsVUFBSSxDQUFDLFlBQWEsUUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLDJCQUFpQixDQUFDO0FBQ3hFLFlBQU0sRUFBRSxNQUFNLFVBQVUsSUFBSSxNQUFNLE1BQy9CLEtBQUssb0JBQW9CLEVBQ3pCLE9BQU8seUVBQXlFLEVBQ2hGLEdBQUcsTUFBTSxXQUFXLEVBQ3BCLFlBQVk7QUFDZixVQUFJLENBQUMsVUFBVyxRQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sbURBQVcsQ0FBQztBQUNoRSxVQUFJLFVBQVUsWUFBYSxRQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sZ0RBQXVCLENBQUM7QUFDdkYsWUFBTSxlQUFlLE1BQU0sMEJBQTBCLFdBQVc7QUFDaEUsVUFBSSxjQUFjO0FBQ2hCLGNBQU0sTUFBTSxLQUFLLG9CQUFvQixFQUFFLE9BQU8sRUFBRSxlQUFlLGFBQWEsQ0FBQyxFQUFFLEdBQUcsTUFBTSxXQUFXO0FBQ25HLGVBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsY0FBYyxjQUFjLGdCQUFnQixLQUFLLENBQUM7QUFBQSxNQUNqRjtBQUNBLFlBQU0sU0FBUyxPQUFPLFVBQVUsZ0JBQWdCLEVBQUUsRUFBRSxLQUFLO0FBQ3pELFVBQUksQ0FBQyxPQUFRLFFBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyxpSUFBa0MsQ0FBQztBQUNwRixZQUFNLE9BQU8sT0FBTyxVQUFVLGNBQWMsVUFBVSxRQUFRLEVBQUUsRUFBRSxLQUFLO0FBQ3ZFLFVBQUksQ0FBQyxLQUFNLFFBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTywrSEFBZ0MsQ0FBQztBQUNoRixZQUFNLFdBQVcsVUFBVSxrQkFBa0IsT0FBTyxLQUFLLE9BQU8sVUFBVSxjQUFjO0FBQ3hGLFlBQU0sY0FBYyxPQUFPLFVBQVUsWUFBWTtBQUNqRCxVQUFJLEVBQUUsY0FBYyxHQUFJLFFBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTywrREFBYSxDQUFDO0FBQzFFLFVBQUksQ0FBRSxNQUFNLGdCQUFnQixRQUFRLEVBQUk7QUFDeEMsVUFBSTtBQUNGLGNBQU0sU0FBUyxNQUFNLHNCQUFzQixhQUFhLE1BQU0sUUFBUSxVQUFVLFdBQVc7QUFDM0YsY0FBTSxNQUFNLEtBQUssb0JBQW9CLEVBQUUsT0FBTyxFQUFFLGVBQWUsT0FBTyxhQUFhLENBQUMsRUFBRSxHQUFHLE1BQU0sV0FBVztBQUMxRyxjQUFNLE1BQU0sS0FBSyxxQkFBcUIsRUFBRSxPQUFPO0FBQUEsVUFDN0MsUUFBUTtBQUFBLFVBQ1IsU0FBUyxvQkFBb0IsV0FBVztBQUFBLFVBQ3hDLFNBQVMsT0FBTztBQUFBLFVBQ2hCLFVBQVU7QUFBQSxVQUNWLFFBQVE7QUFBQSxVQUNSLFNBQVMsT0FBTyxPQUFPLFdBQVcsSUFBSSxJQUFJLE9BQU8sU0FBUztBQUFBLFVBQzFELFNBQVMsRUFBRSxjQUFjLE9BQU8sY0FBYyxnQkFBZ0IsT0FBTyxlQUFlO0FBQUEsUUFDdEYsQ0FBQztBQUNELGVBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsY0FBYyxPQUFPLGNBQWMsUUFBUSxPQUFPLFFBQVEsZ0JBQWdCLE9BQU8sZUFBZSxDQUFDO0FBQUEsTUFDaEksU0FBUyxHQUFHO0FBQ1YsZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLGtEQUFlLE9BQU8sQ0FBQyxDQUFDLEdBQUcsQ0FBQztBQUFBLE1BQ2xFO0FBQUEsSUFDRjtBQVNBLFVBQU0sMEJBQTBCLG9CQUFJLElBQUksQ0FBQyxXQUFXLFdBQVcsQ0FBQztBQUNoRSxVQUFNLGFBQWEsS0FBSztBQUN4QixRQUFJLHdCQUF3QixJQUFJLE1BQU0sTUFBTSxDQUFDLGNBQWMsV0FBVyxTQUFTLElBQUk7QUFDakYsYUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLDRDQUFtQixDQUFDO0FBQUEsSUFDMUQ7QUFLQSxRQUFJLFdBQVcsZUFBZTtBQUM1QixVQUFJO0FBQ0osVUFBSTtBQUNGLGlCQUFTLFVBQVUsY0FBYyxnQkFBZ0IsZ0NBQU87QUFBQSxNQUMxRCxRQUFRO0FBQ04sZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLDZGQUFrQixDQUFDO0FBQUEsTUFDekQ7QUFDQSxVQUFJO0FBQ0YsY0FBTSxTQUFTLE1BQU0sZUFBZSxNQUFNO0FBQzFDLGVBQU9BLE1BQUssVUFBVSxLQUFLLE1BQU07QUFBQSxNQUNuQyxTQUFTLEdBQUc7QUFDVixlQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sT0FBTyxDQUFDLEVBQUUsQ0FBQztBQUFBLE1BQ2pEO0FBQUEsSUFDRjtBQVNBLFFBQUksV0FBVyxnQkFBZ0I7QUFDN0IsWUFBTSxjQUFlLEtBQWtDO0FBQ3ZELFVBQUksQ0FBQyxZQUFhLFFBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTywyQkFBaUIsQ0FBQztBQUN4RSxZQUFNLEVBQUUsTUFBTSxVQUFVLElBQUksTUFBTSxNQUMvQixLQUFLLG9CQUFvQixFQUN6QixPQUFPLDBDQUEwQyxFQUNqRCxHQUFHLE1BQU0sV0FBVyxFQUNwQixZQUFZO0FBQ2YsVUFBSSxDQUFDLFVBQVcsUUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLG1EQUFXLENBQUM7QUFDaEUsVUFBSSxVQUFVLFlBQWEsUUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxRQUFRLE9BQU8sU0FBUyxLQUFLLENBQUM7QUFDeEYsWUFBTSxlQUFlLE1BQU0sMEJBQTBCLFVBQVUsRUFBRTtBQUNqRSxVQUFJLENBQUMsYUFBYyxRQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLFFBQVEsT0FBTyxTQUFTLG1CQUFtQixDQUFDO0FBQzFGLFVBQUk7QUFDSixVQUFJO0FBQ0YsaUJBQVMsVUFBVSxjQUFjLGdCQUFnQixnQ0FBTztBQUFBLE1BQzFELFFBQVE7QUFDTixlQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLFFBQVEsT0FBTyxTQUFTLFlBQVksQ0FBQztBQUFBLE1BQ3BFO0FBQ0EsVUFBSSxVQUFVO0FBQ2QsVUFBSTtBQUNGLGNBQU0sTUFBTSxNQUFNLHNCQUFzQixjQUFjLE1BQU07QUFFNUQsa0JBQVUsS0FBSyxNQUFNLElBQUksT0FBTztBQUFBLE1BQ2xDLFNBQVMsR0FBRztBQUNWLGVBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsUUFBUSxPQUFPLFNBQVMsZUFBZSxRQUFRLE9BQU8sQ0FBQyxFQUFFLENBQUM7QUFBQSxNQUN6RjtBQUNBLFlBQU0sRUFBRSxNQUFNLFdBQVcsSUFBSSxNQUFNLE1BQ2hDLEtBQUssVUFBVSxFQUNmLE9BQU8sVUFBVSxFQUNqQixHQUFHLFdBQVcsT0FBTyxFQUFFLEVBQ3ZCLEdBQUcsWUFBWSxXQUFXLEVBQzFCLFlBQVk7QUFDZixZQUFNLFlBQVksT0FBTyxZQUFZLFlBQVksQ0FBQztBQUNsRCxVQUFJLFVBQVUsWUFBWSxNQUFNO0FBQzlCLGNBQU0sRUFBRSxPQUFPLFVBQVUsSUFBSSxNQUFNLE1BQ2hDLEtBQUssVUFBVSxFQUNmO0FBQUEsVUFDQyxFQUFFLFNBQVMsT0FBTyxJQUFJLFVBQVUsYUFBYSxVQUFVLFNBQVMsYUFBWSxvQkFBSSxLQUFLLEdBQUUsWUFBWSxFQUFFO0FBQUEsVUFDckcsRUFBRSxZQUFZLG1CQUFtQjtBQUFBLFFBQ25DO0FBQ0YsWUFBSSxVQUFXLFFBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyx1RkFBaUIsQ0FBQztBQUNyRSxlQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLFFBQVEsTUFBTSxNQUFNLFdBQVcsSUFBSSxTQUFTLFFBQVEsQ0FBQztBQUFBLE1BQ3BGO0FBQ0EsYUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxRQUFRLE9BQU8sV0FBVyxRQUFRLENBQUM7QUFBQSxJQUNsRTtBQUlBLFFBQUksV0FBVyxXQUFXO0FBQ3hCLFlBQU0sRUFBRSxNQUFNLFVBQVUsSUFBSSxNQUFNLE1BQy9CLEtBQUssV0FBVyxFQUNoQixPQUFPLDhCQUE4QixFQUNyQyxHQUFHLG1CQUFtQixHQUFHLFVBQVUsS0FBSyxFQUN4QyxHQUFHLGNBQWMsV0FBVyxFQUM1QixZQUFZO0FBQ2YsVUFBSSxDQUFDLGFBQWEsVUFBVSxZQUFZLE9BQU8sSUFBSTtBQUNqRCxlQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sbUVBQWlCLENBQUM7QUFBQSxNQUN4RDtBQUNBLGFBQU8saUJBQWlCLE9BQU8sVUFBVSxTQUFTO0FBQUEsSUFDcEQ7QUFHQSxRQUFJLFdBQVcsYUFBYTtBQUMxQixZQUFNLEVBQUUsTUFBTSxVQUFVLElBQUksTUFBTSxNQUMvQixLQUFLLFdBQVcsRUFDaEIsT0FBTyw4Q0FBOEMsRUFDckQsR0FBRyxtQkFBbUIsVUFBVSxFQUNoQyxHQUFHLGNBQWMsa0JBQWtCLEVBQ25DLFlBQVk7QUFDZixVQUFJLENBQUMsYUFBYSxVQUFVLFlBQVksT0FBTyxJQUFJO0FBQ2pELGVBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTywrREFBYSxDQUFDO0FBQUEsTUFDcEQ7QUFDQSxhQUFPLG9CQUFvQixPQUFPLFVBQVUsU0FBUztBQUFBLElBQ3ZEO0FBS0EsUUFBSSxXQUFXLGFBQWE7QUFDMUIsWUFBTSxVQUFXLEtBQThCO0FBQy9DLFVBQUksQ0FBQyxRQUFTLFFBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyx1QkFBYSxDQUFDO0FBQ2hFLFlBQU0sRUFBRSxNQUFNLE1BQU0sSUFBSSxNQUFNLE1BQzNCLEtBQUssbUJBQW1CLEVBQ3hCLE9BQU8sd0RBQXdELEVBQy9ELEdBQUcsTUFBTSxPQUFPLEVBQ2hCLFlBQVk7QUFDZixVQUFJLENBQUMsTUFBTyxRQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sNkNBQVUsQ0FBQztBQUMzRCxVQUFJLE1BQU0sWUFBWSxPQUFPLE1BQU0sQ0FBQyxlQUFlLGFBQWEsR0FBRztBQUNqRSxlQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sbUdBQW1CLENBQUM7QUFBQSxNQUMxRDtBQUNBLFVBQUksTUFBTSxXQUFXLFdBQVc7QUFDOUIsZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxRQUFRLE1BQU0sUUFBUSxZQUFZLEtBQUssQ0FBQztBQUFBLE1BQ3ZFO0FBQ0EsYUFBTyxxQkFBcUIsT0FBTyxVQUFVLEtBQUs7QUFBQSxJQUNwRDtBQVNBLFFBQUksV0FBVyxzQkFBc0I7QUFDbkMsVUFBSSxDQUFDLGVBQWUsYUFBYSxHQUFHO0FBQ2xDLGVBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyw2Q0FBVSxDQUFDO0FBQUEsTUFDakQ7QUFDQSxZQUFNLE1BQU8sS0FBdUM7QUFDcEQsWUFBTSxTQUFTLE1BQU0sUUFBUSxHQUFHLEtBQUssSUFBSSxTQUFTLElBQUksTUFBTTtBQUM1RCxZQUFNLFVBQVUsTUFBTSx3QkFBd0IsT0FBTyxLQUFLLE1BQU07QUFDaEUsYUFBT0EsTUFBSyxVQUFVLEtBQUssT0FBTztBQUFBLElBQ3BDO0FBR0EsUUFBSSxXQUFXLHNCQUFzQjtBQUNuQyxVQUFJLENBQUMsZUFBZSxhQUFhLEdBQUc7QUFDbEMsZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLDZDQUFVLENBQUM7QUFBQSxNQUNqRDtBQUNBLFlBQU0sTUFBTyxLQUF1QztBQUNwRCxVQUFJLENBQUMsTUFBTSxRQUFRLEdBQUcsS0FBSyxJQUFJLFdBQVcsR0FBRztBQUMzQyxlQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8seURBQVksQ0FBQztBQUFBLE1BQ25EO0FBQ0EsWUFBTSxVQUE0QixDQUFDO0FBQ25DLGlCQUFXLE1BQU0sS0FBSztBQUNwQixZQUFJO0FBQ0Ysa0JBQVEsS0FBSyxNQUFNLGdDQUFnQyxPQUFPLEVBQUUsQ0FBQztBQUFBLFFBQy9ELFNBQVMsR0FBRztBQUNWLGtCQUFRLEtBQUssRUFBRSxlQUFlLElBQUksU0FBUyxPQUFPLFdBQVcsUUFBUSxRQUFRLEdBQUcsT0FBTyxPQUFPLENBQUMsRUFBRSxDQUFDO0FBQUEsUUFDcEc7QUFBQSxNQUNGO0FBQ0EsYUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxRQUFRLENBQUM7QUFBQSxJQUN4QztBQUVBLFFBQUksV0FBVywwQkFBMEI7QUFDdkMsVUFBSSxDQUFDLGVBQWUsYUFBYSxHQUFHO0FBQ2xDLGVBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyw2Q0FBVSxDQUFDO0FBQUEsTUFDakQ7QUFDQSxZQUFNLFFBQVEsTUFBTSx3QkFBd0IsS0FBSztBQUNqRCxZQUFNLFVBQVUsQ0FBQyxHQUFHLElBQUksSUFBSSxNQUFNLElBQUksQ0FBQyxNQUFNLEVBQUUsTUFBTSxDQUFDLENBQUM7QUFDdkQsWUFBTSxXQUFXLENBQUMsR0FBRyxJQUFJLElBQUksTUFBTSxJQUFJLENBQUMsTUFBTSxFQUFFLE9BQU8sRUFBRSxPQUFPLE9BQU8sQ0FBQyxDQUFDO0FBQ3pFLFlBQU0sQ0FBQyxnQkFBZ0IsZ0JBQWdCLElBQUksTUFBTSxRQUFRLElBQUk7QUFBQSxRQUMzRCxRQUFRLFNBQ0osTUFBTSxLQUFLLFVBQVUsRUFBRSxPQUFPLGdDQUFnQyxFQUFFLEdBQUcsTUFBTSxPQUFPLElBQ2hGLFFBQVEsUUFBUSxFQUFFLE1BQU0sQ0FBQyxFQUFrRyxDQUFDO0FBQUEsUUFDaEksU0FBUyxTQUNMLE1BQU0sS0FBSyxvQkFBb0IsRUFBRSxPQUFPLFNBQVMsRUFBRSxHQUFHLE1BQU0sUUFBUSxJQUNwRSxRQUFRLFFBQVEsRUFBRSxNQUFNLENBQUMsRUFBMkMsQ0FBQztBQUFBLE1BQzNFLENBQUM7QUFDRCxZQUFNLGNBQWMsSUFBSSxLQUFLLGVBQWUsUUFBUSxDQUFDLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDLENBQUM7QUFDN0UsWUFBTSxnQkFBZ0IsSUFBSSxLQUFLLGlCQUFpQixRQUFRLENBQUMsR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQztBQUVqRixZQUFNLFdBQVcsTUFDZCxJQUFJLENBQUMsU0FBUztBQUNiLGNBQU0sVUFBVSxZQUFZLElBQUksS0FBSyxNQUFNO0FBQzNDLGNBQU0sWUFBWSxLQUFLLFVBQVUsY0FBYyxJQUFJLEtBQUssT0FBTyxJQUFJO0FBQ25FLGVBQU87QUFBQSxVQUNMLEdBQUc7QUFBQSxVQUNILFdBQVcsU0FBUyxZQUFZLFNBQVMsZ0JBQWdCLFNBQVMsU0FBUyxLQUFLO0FBQUEsVUFDaEYsV0FBVyxXQUFXLFNBQVMsS0FBSyxVQUFVLEtBQUssVUFBVTtBQUFBLFFBQy9EO0FBQUEsTUFDRixDQUFDLEVBQ0EsS0FBSyxDQUFDLEdBQUcsTUFBTSxJQUFJLEtBQUssRUFBRSxTQUFTLEVBQUUsUUFBUSxJQUFJLElBQUksS0FBSyxFQUFFLFNBQVMsRUFBRSxRQUFRLENBQUM7QUFFbkYsYUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLFNBQVMsQ0FBQztBQUFBLElBQ2hEO0FBR0EsUUFBSSxXQUFXLDBCQUEwQjtBQUN2QyxVQUFJLENBQUMsZUFBZSxhQUFhLEdBQUc7QUFDbEMsZUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLDZDQUFVLENBQUM7QUFBQSxNQUNqRDtBQUNBLFlBQU0sVUFBVTtBQUNoQixVQUFJO0FBQ0osVUFBSTtBQUVKLFVBQUksUUFBUSxjQUFjO0FBQ3hCLGNBQU0sRUFBRSxNQUFNLFdBQVcsSUFBSSxNQUFNLE1BQ2hDLEtBQUsscUJBQXFCLEVBQzFCLE9BQU8sd0RBQXdELEVBQy9ELEdBQUcsTUFBTSxRQUFRLFlBQVksRUFDN0IsWUFBWTtBQUNmLFlBQUksQ0FBQyxXQUFZLFFBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyw2Q0FBVSxDQUFDO0FBQ2hFLFlBQUksV0FBVyxXQUFXLFdBQVcsV0FBVyxXQUFXLFlBQVk7QUFDckUsaUJBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyxnSkFBa0MsQ0FBQztBQUFBLFFBQ3pFO0FBQ0EsWUFBSSxXQUFXLFdBQVcsYUFBYTtBQUNyQyxpQkFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxRQUFRLGFBQWEsU0FBUyxXQUFXLFNBQVMsWUFBWSxLQUFLLENBQUM7QUFBQSxRQUNuRztBQUNBLFlBQUksV0FBVyxXQUFXLGFBQWE7QUFDckMsaUJBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsUUFBUSxhQUFhLFlBQVksS0FBSyxDQUFDO0FBQUEsUUFDdEU7QUFDQSxZQUFJLFdBQVcsV0FBVyxXQUFXO0FBQ25DLGdCQUFNLFFBQVEsS0FBSyxJQUFJLElBQUksSUFBSSxLQUFLLFdBQVcsY0FBYyxXQUFXLFVBQVUsRUFBRSxRQUFRO0FBQzVGLGNBQUksUUFBUSxJQUFJLEtBQUssS0FBTTtBQUN6QixtQkFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLDZGQUFrQixDQUFDO0FBQUEsVUFDekQ7QUFFQSxnQkFBTSxNQUNILEtBQUsscUJBQXFCLEVBQzFCLE9BQU8sRUFBRSxRQUFRLFVBQVUsT0FBTyxzSEFBdUIsYUFBWSxvQkFBSSxLQUFLLEdBQUUsWUFBWSxFQUFFLENBQUMsRUFDL0YsR0FBRyxNQUFNLFdBQVcsRUFBRTtBQUFBLFFBQzNCO0FBQ0EsdUJBQWUsV0FBVztBQUMxQixzQkFBYyxXQUFXLFFBQVEsTUFBTSxhQUFhLFNBQVMsQ0FBQztBQUFBLE1BQ2hFLFdBQ0UsUUFBUSxnQkFFTixRQUFRLGlCQUFpQixhQUN6QixRQUFRLGlCQUFpQixlQUN6QixRQUFRLGlCQUFpQixXQUMzQjtBQUNBLHVCQUFlLFFBQVE7QUFDdkIsc0JBQWMsUUFBUTtBQUFBLE1BQ3hCLE9BQU87QUFDTCxlQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sNERBQTZDLENBQUM7QUFBQSxNQUNwRjtBQUVBLGFBQU8sd0JBQXdCLE9BQU8sVUFBVSxjQUFjLFdBQVc7QUFBQSxJQUMzRTtBQUVBLFdBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyw4QkFBZSxNQUFNLEdBQUcsQ0FBQztBQUFBLEVBQy9ELFNBQVMsR0FBRztBQUNWLFdBQU9BLE1BQUssVUFBVSxLQUFLLEVBQUUsT0FBTyxPQUFPLENBQUMsRUFBRSxDQUFDO0FBQUEsRUFDakQ7QUFDRjtBQTJCQSxlQUFlLHdCQUF3QixPQUFpRDtBQUN0RixRQUFNLFdBQVcsSUFBSSxLQUFLO0FBQzFCLFFBQU0sY0FBYyxJQUFJLEtBQUssS0FBSyxJQUFJLElBQUksUUFBUSxFQUFFLFlBQVk7QUFLaEUsUUFBTSxxQkFBcUIsSUFBSSxLQUFLLEtBQUssSUFBSSxJQUFJLEtBQUssR0FBSSxFQUFFLFlBQVk7QUFFeEUsUUFBTSxDQUFDLFdBQVcsU0FBUyxZQUFZLGFBQWEsSUFBSSxNQUFNLFFBQVEsSUFBSTtBQUFBLElBQ3hFLE1BQ0csS0FBSyxXQUFXLEVBQ2hCLE9BQU8sOEJBQThCLEVBQ3JDLEdBQUcsY0FBYyxXQUFXLEVBQzVCLElBQUksbUJBQW1CLE1BQU0sSUFBSSxFQUNqQyxNQUFNLGNBQWMsRUFBRSxXQUFXLE1BQU0sQ0FBQyxFQUN4QyxNQUFNLEdBQUc7QUFBQSxJQUNaLE1BQ0csS0FBSyxXQUFXLEVBQ2hCLE9BQU8sdUNBQXVDLEVBQzlDLEdBQUcsY0FBYyxrQkFBa0IsRUFDbkMsSUFBSSxtQkFBbUIsTUFBTSxJQUFJLEVBQ2pDLE1BQU0sY0FBYyxFQUFFLFdBQVcsTUFBTSxDQUFDLEVBQ3hDLE1BQU0sR0FBRztBQUFBO0FBQUE7QUFBQSxJQUdaLE1BQ0csS0FBSyxtQkFBbUIsRUFDeEIsT0FBTyxpQ0FBaUMsRUFDeEMsR0FBRyxVQUFVLFNBQVMsRUFDdEIsR0FBRyxjQUFjLGtCQUFrQixFQUNuQyxNQUFNLGNBQWMsRUFBRSxXQUFXLE1BQU0sQ0FBQyxFQUN4QyxNQUFNLEdBQUc7QUFBQSxJQUNaLE1BQ0csS0FBSyxxQkFBcUIsRUFDMUIsT0FBTyw4RkFBOEYsRUFDckcsR0FBRyxVQUFVLENBQUMsV0FBVyxhQUFhLFFBQVEsQ0FBQyxFQUMvQyxHQUFHLHdEQUF3RCxXQUFXLEdBQUcsRUFDekUsTUFBTSxjQUFjLEVBQUUsV0FBVyxNQUFNLENBQUMsRUFDeEMsTUFBTSxHQUFHO0FBQUEsRUFDZCxDQUFDO0FBRUQsUUFBTSxpQkFBMkk7QUFBQSxJQUMvSSxTQUFVLFVBQVUsUUFBUSxDQUFDO0FBQUEsSUFDN0IsV0FBWSxRQUFRLFFBQVEsQ0FBQztBQUFBLElBQzdCLFNBQVUsV0FBVyxRQUFRLENBQUMsR0FBZ0Y7QUFBQSxNQUM1RyxDQUFDLE9BQU8sRUFBRSxJQUFJLEVBQUUsSUFBSSxTQUFTLEVBQUUsU0FBUyxVQUFVLE1BQU0sUUFBUSxPQUFPLEVBQUUsU0FBUyxHQUFHLFlBQVksRUFBRSxXQUFXO0FBQUEsSUFDaEg7QUFBQSxFQUNGO0FBQ0EsUUFBTSxtQkFBb0IsT0FBTyxRQUFRLGNBQWMsRUFDcEQsUUFBUSxDQUFDLENBQUMsS0FBSyxJQUFJLE1BQU0sS0FBSyxJQUFJLENBQUMsTUFBTSxHQUFHLEdBQUcsSUFBSSxFQUFFLEVBQUUsRUFBRSxDQUFDO0FBQzdELFFBQU0sRUFBRSxNQUFNLG9CQUFvQixJQUFJLGlCQUFpQixTQUNuRCxNQUFNLE1BQU0sS0FBSyxxQkFBcUIsRUFBRSxPQUFPLFNBQVMsRUFBRSxHQUFHLFdBQVcsZ0JBQWdCLElBQ3hGLEVBQUUsTUFBTSxDQUFDLEVBQTJCO0FBQ3hDLFFBQU0sZ0JBQWdCLElBQUksS0FBSyx1QkFBdUIsQ0FBQyxHQUFHLElBQUksQ0FBQyxNQUFNLEVBQUUsT0FBTyxDQUFDO0FBRS9FLFFBQU0sVUFBNEIsT0FBTyxRQUFRLGNBQWMsRUFDNUQ7QUFBQSxJQUFRLENBQUMsQ0FBQyxLQUFLLElBQUksTUFDbEIsS0FDRyxPQUFPLENBQUMsTUFBTSxDQUFDLGNBQWMsSUFBSSxHQUFHLEdBQUcsSUFBSSxFQUFFLEVBQUUsRUFBRSxDQUFDLEVBQ2xELElBQUksQ0FBQyxPQUFPO0FBQUEsTUFDWCxJQUFJO0FBQUEsTUFDSixRQUFRO0FBQUEsTUFDUixhQUFhLEVBQUU7QUFBQSxNQUNmLFFBQVEsRUFBRTtBQUFBLE1BQ1YsU0FBUyxFQUFFLFlBQVk7QUFBQSxNQUN2QixRQUFRLE9BQU8sRUFBRSxNQUFNO0FBQUEsTUFDdkIsUUFBUTtBQUFBLE1BQ1IsT0FBTztBQUFBLE1BQ1AsV0FBVyxFQUFFO0FBQUEsSUFDZixFQUFFO0FBQUEsRUFDTjtBQUVGLFFBQU0sbUJBQW9DLGNBQWMsUUFBUSxDQUFDLEdBQUcsSUFBSSxDQUFDLFNBQVM7QUFBQSxJQUNoRixJQUFJLElBQUk7QUFBQSxJQUNSLFFBQVEsSUFBSTtBQUFBLElBQ1osYUFBYSxJQUFJLFFBQVEsTUFBTSxPQUFPLElBQUksTUFBTSxFQUFFLFNBQVMsQ0FBQztBQUFBLElBQzVELFFBQVEsSUFBSTtBQUFBLElBQ1osU0FBUyxJQUFJLFlBQVk7QUFBQSxJQUN6QixRQUFRLElBQUksVUFBVSxPQUFPLE9BQU8sT0FBTyxJQUFJLE1BQU07QUFBQSxJQUNyRCxTQUFTLElBQUksV0FBVyxPQUFPLE9BQU8sT0FBTyxJQUFJLE9BQU87QUFBQSxJQUN4RCxRQUFRLElBQUksV0FBVyxXQUFZLFdBQXNCO0FBQUEsSUFDekQsT0FBTyxJQUFJLFNBQVM7QUFBQSxJQUNwQixRQUFRLElBQUksV0FBVztBQUFBLElBQ3ZCLFdBQVcsSUFBSTtBQUFBLElBQ2YsV0FBVyxJQUFJO0FBQUEsRUFDakIsRUFBRTtBQUVGLFFBQU0sV0FBVyxDQUFDLEdBQUcsaUJBQWlCLEdBQUcsT0FBTztBQUloRCxRQUFNLGtCQUFrQjtBQUFBLElBQ3RCLEdBQUcsSUFBSSxJQUFJLFNBQVMsT0FBTyxDQUFDLE1BQU0sRUFBRSxXQUFXLEVBQUUsV0FBVyxTQUFTLEVBQUUsSUFBSSxDQUFDLE1BQU0sRUFBRSxPQUFpQixDQUFDO0FBQUEsRUFDeEc7QUFDQSxNQUFJLGdCQUFnQixRQUFRO0FBQzFCLFVBQU0sRUFBRSxNQUFNLGVBQWUsSUFBSSxNQUFNLE1BQ3BDLEtBQUssb0JBQW9CLEVBQ3pCLE9BQU8sMEJBQTBCLEVBQ2pDLEdBQUcsTUFBTSxlQUFlO0FBQzNCLFVBQU0sbUJBQW1CLElBQUk7QUFBQSxPQUMxQixrQkFBa0IsQ0FBQyxHQUFHLE9BQU8sQ0FBQyxNQUFNLEVBQUUsZUFBZSxFQUFFLGNBQWMsS0FBSyxFQUFFLElBQUksQ0FBQyxNQUFNLEVBQUUsRUFBRTtBQUFBLElBQzlGO0FBQ0EsUUFBSSxpQkFBaUIsTUFBTTtBQUN6QixhQUFPLFNBQVMsT0FBTyxDQUFDLE1BQU0sRUFBRSxFQUFFLFdBQVcsaUJBQWlCLElBQUksRUFBRSxPQUFPLEVBQUU7QUFBQSxJQUMvRTtBQUFBLEVBQ0Y7QUFFQSxTQUFPO0FBQ1Q7QUFJQSxTQUFTLGVBQTRGO0FBQ25HLE1BQUksT0FBZ0I7QUFDcEIsUUFBTSxPQUFPO0FBQUEsSUFDWCxZQUFZO0FBQUEsSUFDWixZQUFZO0FBQUEsSUFFWjtBQUFBLElBQ0EsSUFBSSxNQUFlO0FBQ2pCLGFBQU8sT0FBTyxLQUFLLE1BQU0sSUFBSSxJQUFJO0FBQUEsSUFDbkM7QUFBQSxFQUNGO0FBQ0EsU0FBTztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsTUFBTSxPQUFPLEVBQUUsUUFBUSxLQUFLLFlBQVksS0FBSztBQUFBLEVBQy9DO0FBQ0Y7QUFJQSxlQUFlLHdCQUNiLE9BQ0EsVUFDQSxjQUNBLGFBQ0E7QUFDQSxNQUFJLGlCQUFpQixXQUFXO0FBQzlCLFVBQU0sRUFBRSxNQUFNLFVBQVUsSUFBSSxNQUFNLE1BQy9CLEtBQUssV0FBVyxFQUNoQixPQUFPLG1CQUFtQixFQUMxQixHQUFHLE1BQU0sV0FBVyxFQUNwQixHQUFHLGNBQWMsV0FBVyxFQUM1QixZQUFZO0FBQ2YsUUFBSSxDQUFDLFVBQVcsUUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLG1FQUFpQixDQUFDO0FBQ3RFLFdBQU8saUJBQWlCLE9BQU8sVUFBVSxTQUFTO0FBQUEsRUFDcEQ7QUFDQSxNQUFJLGlCQUFpQixhQUFhO0FBQ2hDLFVBQU0sRUFBRSxNQUFNLFVBQVUsSUFBSSxNQUFNLE1BQy9CLEtBQUssV0FBVyxFQUNoQixPQUFPLDhDQUE4QyxFQUNyRCxHQUFHLE1BQU0sV0FBVyxFQUNwQixHQUFHLGNBQWMsa0JBQWtCLEVBQ25DLFlBQVk7QUFDZixRQUFJLENBQUMsVUFBVyxRQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLE9BQU8sK0RBQWEsQ0FBQztBQUNsRSxXQUFPLG9CQUFvQixPQUFPLFVBQVUsU0FBUztBQUFBLEVBQ3ZEO0FBQ0EsTUFBSSxpQkFBaUIsVUFBVTtBQUM3QixVQUFNLEVBQUUsTUFBTSxNQUFNLElBQUksTUFBTSxNQUMzQixLQUFLLG1CQUFtQixFQUN4QixPQUFPLHdEQUF3RCxFQUMvRCxHQUFHLE1BQU0sV0FBVyxFQUNwQixZQUFZO0FBQ2YsUUFBSSxDQUFDLE1BQU8sUUFBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLCtEQUFhLENBQUM7QUFDOUQsUUFBSSxNQUFNLFdBQVcsV0FBVztBQUM5QixhQUFPQSxNQUFLLFVBQVUsS0FBSyxFQUFFLFFBQVEsTUFBTSxRQUFRLFlBQVksS0FBSyxDQUFDO0FBQUEsSUFDdkU7QUFDQSxXQUFPLHFCQUFxQixPQUFPLFVBQVUsS0FBSztBQUFBLEVBQ3BEO0FBQ0EsU0FBT0EsTUFBSyxVQUFVLEtBQUssRUFBRSxPQUFPLHFKQUE0QyxDQUFDO0FBQ25GO0FBU0EsZUFBc0Isc0JBQ3BCLE9BQ0EsT0FDZ0k7QUFDaEksUUFBTSxXQUFXLE1BQU0sd0JBQXdCLEtBQUs7QUFHcEQsUUFBTSxRQUFRLE9BQU8sVUFBVSxXQUFXLFNBQVMsTUFBTSxHQUFHLEtBQUssSUFBSTtBQUNyRSxRQUFNLGVBQWtGLENBQUM7QUFDekYsTUFBSSxZQUFZO0FBQ2hCLE1BQUksUUFBUTtBQUNaLGFBQVcsUUFBUSxPQUFPO0FBQ3hCLFFBQUksS0FBSyxXQUFXLGlCQUFpQjtBQUNuQyxZQUFNLFFBQVEsS0FBSyxJQUFJLElBQUksSUFBSSxLQUFLLEtBQUssYUFBYSxLQUFLLFNBQVMsRUFBRSxRQUFRO0FBQzlFLFVBQUksUUFBUSxJQUFJLEtBQUssSUFBTTtBQUMzQixZQUFNLE1BQ0gsS0FBSyxxQkFBcUIsRUFDMUIsT0FBTyxFQUFFLFFBQVEsVUFBVSxPQUFPLCtHQUErQixhQUFZLG9CQUFJLEtBQUssR0FBRSxZQUFZLEVBQUUsQ0FBQyxFQUN2RyxHQUFHLE1BQU0sS0FBSyxFQUFZO0FBQUEsSUFDL0I7QUFDQSxpQkFBYTtBQUNiLFVBQU0sRUFBRSxVQUFVLEtBQUssSUFBSSxhQUFhO0FBQ3hDLFFBQUk7QUFDRixZQUFNLHdCQUF3QixPQUFPLFVBQVUsS0FBSyxRQUFRLEtBQUssV0FBVztBQUM1RSxZQUFNLEVBQUUsUUFBUSxLQUFLLElBQUksS0FBSztBQUM5QixVQUFJLFVBQVUsT0FBTyxTQUFTLEtBQUs7QUFDakMsaUJBQVM7QUFBQSxNQUNYLE9BQU87QUFDTCxjQUFNLGFBQWEsUUFBUSxPQUFPLFNBQVMsWUFBWSxXQUFXLE9BQzdELEtBQTZCLFFBQzlCO0FBQ0osY0FBTSxVQUFVLE9BQU8sZUFBZSxZQUFZLGFBQWEsYUFBYSxRQUFRLE1BQU07QUFDMUYscUJBQWEsS0FBSyxFQUFFLGFBQWEsS0FBSyxhQUFhLFFBQVEsS0FBSyxRQUFRLE9BQU8sUUFBUSxDQUFDO0FBQUEsTUFDMUY7QUFBQSxJQUNGLFNBQVMsR0FBRztBQUNWLG1CQUFhLEtBQUssRUFBRSxhQUFhLEtBQUssYUFBYSxRQUFRLEtBQUssUUFBUSxPQUFPLE9BQU8sQ0FBQyxFQUFFLENBQUM7QUFBQSxJQUM1RjtBQUFBLEVBQ0Y7QUFDQSxTQUFPLEVBQUUsV0FBVyxPQUFPLGFBQWE7QUFDMUM7QUFFQSxTQUFTLE9BQU8sR0FBb0I7QUFDbEMsTUFBSSxLQUFLLE9BQU8sTUFBTSxZQUFZLGtCQUFrQixLQUFLLE9BQVEsRUFBZ0MsaUJBQWlCLFVBQVU7QUFDMUgsV0FBUSxFQUErQjtBQUFBLEVBQ3pDO0FBQ0EsU0FBTyxhQUFhLFFBQVEsRUFBRSxVQUFVLE9BQU8sQ0FBQztBQUNsRDtBQU9BLGVBQWUsd0JBQXdCLE9BQXNDO0FBQzNFLE1BQUk7QUFDRixVQUFNLEVBQUUsTUFBTSxTQUFTLE1BQU0sSUFBSSxNQUFNLE1BQU0sSUFBSSxvQkFBb0I7QUFBQSxNQUNuRSxPQUFPO0FBQUEsTUFDUCx3QkFBd0I7QUFBQSxJQUMxQixDQUFDO0FBQ0QsUUFBSSxTQUFTLFlBQVksS0FBTTtBQUcvQixVQUFNLHNCQUFzQixPQUFPLENBQUMsRUFBRSxNQUFNLE1BQU07QUFBQSxJQUFDLENBQUM7QUFDcEQsVUFBTSx3QkFBd0IsT0FBTyxDQUFDLEVBQUUsTUFBTSxNQUFNO0FBQUEsSUFBQyxDQUFDO0FBQUEsRUFDeEQsUUFBUTtBQUFBLEVBRVI7QUFDRjtBQW5uRkEsSUFxRk0sYUFDQSxnQkEwT0EsdUJBQ0EsNEJBQ0EsY0FDQTtBQW5VTjtBQUFBO0FBZ0JBO0FBcUVBLElBQU0sY0FBYyxvQkFBSSxJQUFJLENBQUMsc0JBQU8sU0FBUyxhQUFhLENBQUM7QUFDM0QsSUFBTSxpQkFBaUIsQ0FBQyxZQUN0QixZQUFZLElBQUksT0FBTyxRQUFRLGVBQWUsRUFBRSxDQUFDLEtBQ2pELENBQUMsU0FBUyxhQUFhLEVBQUUsU0FBUyxPQUFPLFFBQVEsUUFBUSxFQUFFLENBQUM7QUF3TzlELElBQU0sd0JBQXdCO0FBQzlCLElBQU0sNkJBQTZCLENBQUMsb0JBQW9CLFdBQVcsVUFBVTtBQUM3RSxJQUFNLGVBQWU7QUFDckIsSUFBTSxzQkFBc0I7QUFBQTtBQUFBOzs7QUNuVTVCO0FBQUE7QUFBQTtBQUFBLGlCQUFBTztBQUFBO0FBQWtRLFNBQVMsY0FBYyxjQUFjO0FBQ3ZTLFNBQVMsU0FBUztBQThCbEIsZUFBT0EsU0FBK0IsS0FBa0IsS0FBbUI7QUFDekUsTUFBSSxVQUFVLGlCQUFpQixVQUFVO0FBQ3pDLE1BQUksSUFBSSxXQUFXLE9BQVEsUUFBTyxJQUFJLE9BQU8sR0FBRyxFQUFFLEtBQUssRUFBRSxPQUFPLHFCQUFxQixDQUFDO0FBQ3RGLFFBQU0sZ0JBQWdCLE9BQU8sSUFBSSxRQUFRLGtCQUFrQixXQUFXLElBQUksUUFBUSxnQkFBZ0I7QUFDbEcsTUFBSSxDQUFDLGNBQWMsV0FBVyxTQUFTLEVBQUcsUUFBTyxJQUFJLE9BQU8sR0FBRyxFQUFFLEtBQUssRUFBRSxPQUFPLGVBQWUsQ0FBQztBQUMvRixRQUFNLGNBQWMsUUFBUSxJQUFJLGdCQUFnQixRQUFRLElBQUk7QUFDNUQsUUFBTSxjQUFjLFFBQVEsSUFBSSxxQkFBcUIsUUFBUSxJQUFJO0FBQ2pFLE1BQUksQ0FBQyxlQUFlLENBQUMsWUFBYSxRQUFPLElBQUksT0FBTyxHQUFHLEVBQUUsS0FBSyxFQUFFLE9BQU8sa0NBQWtDLENBQUM7QUFDMUcsUUFBTSxnQkFBZ0IsTUFBTSxNQUFNLEdBQUcsV0FBVyxzQ0FBc0M7QUFBQSxJQUNwRixRQUFRO0FBQUEsSUFDUixTQUFTLEVBQUUsUUFBUSxhQUFhLGVBQWUsZUFBZSxnQkFBZ0IsbUJBQW1CO0FBQUEsSUFDakcsTUFBTTtBQUFBLEVBQ1IsQ0FBQztBQUNELE1BQUksQ0FBQyxjQUFjLE1BQU8sTUFBTSxjQUFjLEtBQUssTUFBTyxLQUFNLFFBQU8sSUFBSSxPQUFPLEdBQUcsRUFBRSxLQUFLLEVBQUUsT0FBTyxZQUFZLENBQUM7QUFDbEgsUUFBTSxTQUFTLFdBQVcsVUFBVSxJQUFJLElBQUk7QUFDNUMsTUFBSSxDQUFDLE9BQU8sV0FBVyxPQUFPLEtBQUssT0FBTyxLQUFLLE1BQU0sRUFBRSxXQUFXLEVBQUcsUUFBTyxJQUFJLE9BQU8sR0FBRyxFQUFFLEtBQUssRUFBRSxPQUFPLGtCQUFrQixDQUFDO0FBQzdILFFBQU0saUJBQWlCLE9BQU8sS0FBSyxTQUFTLFVBQVUsQ0FBQyxRQUFRLFlBQVksYUFBYSxJQUFJLENBQUMsU0FBUyxTQUFTO0FBQy9HLE1BQUksQ0FBQyxlQUFlLE1BQU0sQ0FBQyxVQUFVLE9BQU8sT0FBTyxLQUFLLE9BQU8sS0FBSyxNQUFNLFFBQVEsRUFBRyxRQUFPLElBQUksT0FBTyxHQUFHLEVBQUUsS0FBSyxFQUFFLE9BQU8saUJBQWlCLENBQUM7QUFDNUksUUFBTSxTQUFTLENBQUMsMkJBQTJCLHlCQUF5QjtBQUNwRSxNQUFJLFlBQVk7QUFDaEIsYUFBVyxTQUFTLFFBQVE7QUFDMUIsUUFBSTtBQUNGLFlBQU0sRUFBRSxPQUFPLElBQUksTUFBTSxhQUFhO0FBQUEsUUFDcEM7QUFBQSxRQUNBLFFBQVEsT0FBTyxPQUFPLEVBQUUsUUFBUSxrQkFBa0IsQ0FBQztBQUFBLFFBQ25ELFFBQVEsK0NBQStDLE9BQU8sS0FBSyxJQUFJO0FBQUEsV0FBd1gsY0FBYyxJQUFJLENBQUMsU0FBUyxHQUFHLElBQUksSUFBSSxjQUFjLElBQUksQ0FBQyxFQUFFLEVBQUUsS0FBSyxJQUFJLENBQUM7QUFBQSxXQUFjLEtBQUssVUFBVSxPQUFPLEtBQUssTUFBTSxDQUFDO0FBQUEsTUFDempCLENBQUM7QUFDRCxZQUFNLFdBQVcsY0FBYztBQUFBLFFBQzdCLENBQUMsU0FDQyxPQUFPLGFBQWEsSUFBSSxLQUN4QixlQUFlLE1BQU0sQ0FBQyxVQUFVO0FBQzlCLGdCQUFNLGNBQWMsT0FBTyxLQUFLLE9BQU8sS0FBSyxHQUFHLEtBQUssS0FBSztBQUN6RCxnQkFBTSxRQUFRLE9BQU8sYUFBYSxJQUFJLEVBQUUsS0FBSztBQUM3QyxpQkFBTyxPQUFPLFVBQVUsYUFBYSxDQUFDLGVBQWUsUUFBUSxNQUFNLEtBQUssQ0FBQyxNQUFNLENBQUMsTUFBTSxTQUFTLFFBQUc7QUFBQSxRQUNwRyxDQUFDO0FBQUEsTUFDTDtBQUNBLFVBQUksQ0FBQyxTQUFVLE9BQU0sSUFBSSxNQUFNLCtCQUErQjtBQUM5RCxhQUFPLElBQUksT0FBTyxHQUFHLEVBQUUsS0FBSyxFQUFFLGNBQWMsRUFBRSxTQUFTLE9BQU8sS0FBSyxRQUFRLEdBQUcsT0FBTyxhQUFhLEVBQUUsQ0FBQztBQUFBLElBQ3ZHLFNBQVMsT0FBTztBQUNkLGtCQUFZLGlCQUFpQixRQUFRLE1BQU0sVUFBVTtBQUFBLElBQ3ZEO0FBQUEsRUFDRjtBQUNBLFVBQVEsTUFBTSw2Q0FBNkMsU0FBUztBQUNwRSxTQUFPLElBQUksT0FBTyxHQUFHLEVBQUUsS0FBSyxFQUFFLE9BQU8sMkVBQWUsQ0FBQztBQUN2RDtBQTNFQSxJQUdNLGVBQ0EsZUFHQSxZQUlBLHdCQU9BLG1CQVFPO0FBMUJiO0FBQUE7QUFHQSxJQUFNLGdCQUFnQixDQUFDLFNBQVMsTUFBTSxNQUFNLE1BQU0sTUFBTSxNQUFNLE1BQU0sTUFBTSxNQUFNLE1BQU0sTUFBTSxNQUFNLE1BQU0sTUFBTSxJQUFJO0FBQ2xILElBQU0sZ0JBQWdFO0FBQUEsTUFDcEUsU0FBUztBQUFBLE1BQXNCLElBQUk7QUFBQSxNQUFXLElBQUk7QUFBQSxNQUFZLElBQUk7QUFBQSxNQUFVLElBQUk7QUFBQSxNQUFRLElBQUk7QUFBQSxNQUFjLElBQUk7QUFBQSxNQUFjLElBQUk7QUFBQSxNQUFTLElBQUk7QUFBQSxNQUFXLElBQUk7QUFBQSxNQUFVLElBQUk7QUFBQSxNQUFVLElBQUk7QUFBQSxNQUFjLElBQUk7QUFBQSxNQUFXLElBQUk7QUFBQSxNQUFVLElBQUk7QUFBQSxJQUN6TztBQUNBLElBQU0sYUFBYSxFQUFFLE9BQU87QUFBQSxNQUMxQixNQUFNLEVBQUUsS0FBSyxDQUFDLFNBQVMsY0FBYyxDQUFDO0FBQUEsTUFDdEMsUUFBUSxFQUFFLE9BQU8sRUFBRSxLQUFLLENBQUMsUUFBUSxZQUFZLGVBQWUsU0FBUyxTQUFTLENBQUMsR0FBRyxFQUFFLE9BQU8sRUFBRSxJQUFJLEdBQUksQ0FBQztBQUFBLElBQ3hHLENBQUM7QUFDRCxJQUFNLHlCQUF5QixFQUFFLE9BQU87QUFBQSxNQUN0QyxNQUFNLEVBQUUsT0FBTyxFQUFFLFNBQVM7QUFBQSxNQUMxQixVQUFVLEVBQUUsT0FBTyxFQUFFLFNBQVM7QUFBQSxNQUM5QixhQUFhLEVBQUUsT0FBTyxFQUFFLFNBQVM7QUFBQSxNQUNqQyxPQUFPLEVBQUUsT0FBTyxFQUFFLFNBQVM7QUFBQSxNQUMzQixTQUFTLEVBQUUsT0FBTyxFQUFFLFNBQVM7QUFBQSxJQUMvQixDQUFDO0FBQ0QsSUFBTSxvQkFBb0IsRUFBRSxPQUFPO0FBQUEsTUFDakMsY0FBYyxFQUFFO0FBQUEsUUFDZCxPQUFPO0FBQUEsVUFDTCxjQUFjLElBQUksQ0FBQyxTQUFTLENBQUMsTUFBTSxzQkFBc0IsQ0FBQztBQUFBLFFBQzVEO0FBQUEsTUFDRjtBQUFBLElBQ0YsQ0FBQztBQUVNLElBQU0sU0FBUyxFQUFFLGFBQWEsR0FBRztBQUFBO0FBQUE7OztBQzFCa04sU0FBUyxjQUFjLGVBQWU7QUFDaFMsT0FBTyxXQUFXO0FBQ2xCLFNBQVMsZUFBZSxPQUFBQyxZQUFXO0FBRnFILElBQU0sMkNBQTJDO0FBS3pNLFNBQVMsd0JBQWdDO0FBQ3ZDLFNBQU87QUFBQSxJQUNMLE1BQU07QUFBQSxJQUNOLGdCQUFnQixRQUFRO0FBR3RCLGFBQU8sWUFBWSxJQUFJLHNCQUFzQixPQUFPLEtBQUssUUFBUTtBQUMvRCxZQUFJO0FBQ0YsZ0JBQU0sRUFBRSxTQUFTQyxTQUFRLElBQUksTUFBTTtBQUNuQyxnQkFBTUEsU0FBUSxLQUFLLEdBQUc7QUFBQSxRQUN4QixTQUFTLE9BQU87QUFDZCxrQkFBUSxNQUFNLDRDQUE0QyxLQUFLO0FBQy9ELGNBQUksQ0FBQyxJQUFJLGVBQWU7QUFDdEIsZ0JBQUksYUFBYTtBQUNqQixnQkFBSSxVQUFVLGdCQUFnQixrQkFBa0I7QUFDaEQsZ0JBQUksSUFBSSxLQUFLLFVBQVUsRUFBRSxPQUFPLHNDQUFzQyxDQUFDLENBQUM7QUFBQSxVQUMxRTtBQUFBLFFBQ0Y7QUFBQSxNQUNGLENBQUM7QUFBQSxJQUNIO0FBQUEsRUFDRjtBQUNGO0FBRUEsU0FBUyxtQkFBMkI7QUFDbEMsU0FBTztBQUFBLElBQ0wsTUFBTTtBQUFBLElBQ04sZ0JBQWdCLFFBQVE7QUFNdEIsYUFBTyxZQUFZLElBQUksZ0JBQWdCLE9BQU8sS0FBSyxRQUFRO0FBQ3pELFlBQUk7QUFDRixnQkFBTSxFQUFFLFNBQVNBLFNBQVEsSUFBSSxNQUFNO0FBQ25DLGdCQUFNQSxTQUFRLEtBQUssR0FBRztBQUFBLFFBQ3hCLFNBQVMsT0FBTztBQUNkLGtCQUFRLE1BQU0sc0NBQXNDLEtBQUs7QUFDekQsY0FBSSxDQUFDLElBQUksZUFBZTtBQUN0QixnQkFBSSxhQUFhO0FBQ2pCLGdCQUFJLFVBQVUsZ0JBQWdCLGtCQUFrQjtBQUNoRCxnQkFBSSxJQUFJLEtBQUssVUFBVSxFQUFFLE9BQU8saUJBQWlCLFFBQVEsTUFBTSxVQUFVLGdDQUFnQyxDQUFDLENBQUM7QUFBQSxVQUM3RztBQUFBLFFBQ0Y7QUFBQSxNQUNGLENBQUM7QUFBQSxJQUNIO0FBQUEsRUFDRjtBQUNGO0FBRUEsU0FBUyxpQkFBaUIsWUFBNEI7QUFDcEQsU0FBTztBQUFBLElBQ0wsTUFBTTtBQUFBLElBQ04sdUJBQXVCLFFBQVE7QUFDN0IsYUFBTyxZQUFZLElBQUksb0JBQW9CLENBQUMsS0FBSyxRQUFRO0FBQ3ZELFlBQUksSUFBSSxXQUFXLFNBQVMsSUFBSSxXQUFXLFFBQVE7QUFDakQsY0FBSSxhQUFhO0FBQ2pCLGNBQUksVUFBVSxTQUFTLFdBQVc7QUFDbEMsY0FBSSxJQUFJLEtBQUssVUFBVSxFQUFFLE9BQU8scUJBQXFCLENBQUMsQ0FBQztBQUN2RDtBQUFBLFFBQ0Y7QUFFQSxZQUFJLGFBQWE7QUFDakIsWUFBSSxVQUFVLGdCQUFnQixpQ0FBaUM7QUFDL0QsWUFBSSxVQUFVLGlCQUFpQix1REFBdUQ7QUFDdEYsWUFBSSxJQUFJLEtBQUssVUFBVSxFQUFFLFNBQVMsV0FBVyxDQUFDLENBQUM7QUFBQSxNQUNqRCxDQUFDO0FBQUEsSUFDSDtBQUFBLEVBQ0Y7QUFDRjtBQUVBLFNBQVMsdUJBQStCO0FBQ3RDLFNBQU87QUFBQSxJQUNMLE1BQU07QUFBQSxJQUNOLGdCQUFnQixRQUFRO0FBQ3RCLGFBQU8sWUFBWSxJQUFJLGtCQUFrQixPQUFPLEtBQUssUUFBUTtBQUMzRCxjQUFNLFNBQW1CLENBQUM7QUFDMUIseUJBQWlCLFNBQVMsSUFBSyxRQUFPLEtBQUssT0FBTyxLQUFLLEtBQUssQ0FBQztBQUM3RCxjQUFNLFVBQVUsT0FBTyxPQUFPLE1BQU0sRUFBRSxTQUFTLE1BQU07QUFDckQsWUFBSTtBQUNKLFlBQUk7QUFDRixpQkFBTyxVQUFVLEtBQUssTUFBTSxPQUFPLElBQUk7QUFBQSxRQUN6QyxRQUFRO0FBQ04sY0FBSSxhQUFhO0FBQ2pCLGNBQUksSUFBSSxLQUFLLFVBQVUsRUFBRSxPQUFPLGVBQWUsQ0FBQyxDQUFDO0FBQ2pEO0FBQUEsUUFDRjtBQUNBLGNBQU0sRUFBRSxTQUFTQSxTQUFRLElBQUksTUFBTTtBQUNuQyxjQUFNLFdBQVc7QUFBQSxVQUNmLE9BQU8sTUFBYztBQUNuQixnQkFBSSxhQUFhO0FBQ2pCLG1CQUFPO0FBQUEsVUFDVDtBQUFBLFVBQ0EsS0FBSyxPQUFnQjtBQUNuQixnQkFBSSxVQUFVLGdCQUFnQixrQkFBa0I7QUFDaEQsZ0JBQUksSUFBSSxLQUFLLFVBQVUsS0FBSyxDQUFDO0FBQUEsVUFDL0I7QUFBQSxVQUNBLFVBQVUsTUFBYyxPQUFlO0FBQ3JDLGdCQUFJLFVBQVUsTUFBTSxLQUFLO0FBQUEsVUFDM0I7QUFBQSxRQUNGO0FBQ0EsY0FBTUE7QUFBQSxVQUNKO0FBQUEsWUFDRSxRQUFRLElBQUk7QUFBQSxZQUNaLFNBQVMsSUFBSTtBQUFBLFlBQ2I7QUFBQSxVQUNGO0FBQUEsVUFDQTtBQUFBLFFBQ0Y7QUFBQSxNQUNGLENBQUM7QUFBQSxJQUNIO0FBQUEsRUFDRjtBQUNGO0FBR0EsSUFBTyxzQkFBUSxhQUFhLENBQUMsRUFBRSxLQUFLLE1BQU07QUFDeEMsUUFBTSxNQUFNLFFBQVEsTUFBTSxRQUFRLElBQUksR0FBRyxFQUFFO0FBQzNDLFNBQU8sT0FBTyxRQUFRLEtBQUssR0FBRztBQUM5QixRQUFNLGFBQWEsSUFBSSx3QkFBd0IsSUFBSSx5QkFBeUIsUUFBUSxJQUFJLHdCQUF3QixRQUFRLElBQUkseUJBQXlCO0FBQ3JKLFNBQU87QUFBQSxJQUNQLFNBQVMsQ0FBQyxNQUFNLEdBQUcsc0JBQXNCLEdBQUcsaUJBQWlCLEdBQUcscUJBQXFCLEdBQUcsaUJBQWlCLFVBQVUsQ0FBQztBQUFBLElBQ3BILFFBQVE7QUFBQSxNQUNOLGlCQUFpQixLQUFLLFVBQVUsVUFBVTtBQUFBLE1BQzFDLHdDQUF3QyxLQUFLLFVBQVUsSUFBSSx3QkFBd0I7QUFBQSxNQUNuRiw2Q0FBNkMsS0FBSyxVQUFVLElBQUksNkJBQTZCO0FBQUEsTUFDN0YscURBQXFELEtBQUssVUFBVSxJQUFJLHFDQUFxQztBQUFBLE1BQzdHLHdDQUF3QyxLQUFLLFVBQVUsSUFBSSx3QkFBd0I7QUFBQSxJQUNyRjtBQUFBLElBQ0EsU0FBUztBQUFBLE1BQ1AsT0FBTztBQUFBLFFBQ0wsS0FBSyxjQUFjLElBQUlDLEtBQUksU0FBUyx3Q0FBZSxDQUFDO0FBQUEsTUFDdEQ7QUFBQSxJQUNGO0FBQUEsSUFDQSxjQUFjO0FBQUEsTUFDWixTQUFTLENBQUMsY0FBYztBQUFBLElBQzFCO0FBQUEsSUFDQSxRQUFRO0FBQUEsTUFDTixNQUFNO0FBQUEsTUFDTixLQUFLO0FBQUEsUUFDSCxVQUFVO0FBQUEsUUFDVixZQUFZO0FBQUEsTUFDZDtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0EsQ0FBQzsiLAogICJuYW1lcyI6IFsiZmFsbGJhY2siLCAidmF1bHRBZGRyZXNzIiwgImRlY2ltYWxzIiwgImFtb3VudFVuaXRzIiwgImJhbGFuY2UiLCAiaGFzaCIsICJoYW5kbGVyIiwgImNyZWF0ZUNsaWVudCIsICJmb3JtYXRVbml0cyIsICJnZXRBZGRyZXNzIiwgInBhcnNlVW5pdHMiLCAianNvbiIsICJyZWFkQm9keSIsICJ0b2tlbiIsICJlcnJvciIsICJjYW5kaWRhdGVzIiwgInJlcXVlc3RLZXkiLCAidHhIYXNoIiwgImhhbmRsZXIiLCAiVVJMIiwgImhhbmRsZXIiLCAiVVJMIl0KfQo=
