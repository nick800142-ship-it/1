// api/_onchain.ts 的安全性 mock 測試——不碰真實鏈上網路，只驗證我方程式碼在
// 各種輸入下的行為是否符合預期。這些測試**不能**證明「鏈上交易真的會成功」，
// 只能證明「我方程式碼組出的呼叫參數、擋下的條件是對的」；真正的鏈上端到端
// 驗證（含真實 tx hash）是另一份手動整合測試，見 v0_plans/bold-outline.md
// 第 7.2 節與交付報告，不能用這份 mock 測試取代。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readContractMock = vi.fn();
const writeContractMock = vi.fn();
const getBalanceMock = vi.fn();
const getTransactionCountMock = vi.fn();
const waitForTransactionReceiptMock = vi.fn();

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    createPublicClient: () => ({
      readContract: readContractMock,
      getBalance: getBalanceMock,
      getTransactionCount: getTransactionCountMock,
      waitForTransactionReceipt: waitForTransactionReceiptMock,
    }),
    createWalletClient: () => ({
      writeContract: writeContractMock,
    }),
  };
});

// nonce 鎖在測試環境沒有 Postgres 連線，直接讓 fn() 立即執行即可，不影響本測試
// 想驗證的行為（呼叫參數是否正確、擋下條件是否生效）。
vi.mock("../_relayerLock", () => ({
  withRelayerNonceLock: (fn: () => unknown) => fn(),
  withDelegateNonceLock: (fn: () => unknown) => fn(),
}));

const OWNER_KEY = `0x${"11".repeat(32)}`;
const DELEGATE_KEY = `0x${"22".repeat(32)}`;

beforeEach(() => {
  vi.resetModules();
  readContractMock.mockReset();
  writeContractMock.mockReset();
  getBalanceMock.mockReset();
  getTransactionCountMock.mockReset();
  waitForTransactionReceiptMock.mockReset();
  process.env.RELAYER_PRIVATE_KEY = OWNER_KEY;
  process.env.DELEGATE_PRIVATE_KEY = DELEGATE_KEY;
});

afterEach(() => {
  delete process.env.RELAYER_PRIVATE_KEY;
  delete process.env.DELEGATE_PRIVATE_KEY;
});

async function loadOnchain() {
  return await import("../_onchain");
}

// getTokenAllowance 回傳 [amount, spent, resetTimeMin, lastResetMin, nonce]（皆為 wei 單位的 bigint）。
function mockAllowance(amount: bigint, spent: bigint, nonce: bigint) {
  readContractMock.mockImplementation(async (args: { functionName: string }) => {
    if (args.functionName === "getTokenAllowance") return [amount, spent, 1440n, 0n, nonce];
    if (args.functionName === "decimals") return 18;
    if (args.functionName === "balanceOf") return 0n;
    return undefined;
  });
}

describe("delegateAddress / DELEGATE_PRIVATE_KEY 格式驗證", () => {
  it("私鑰格式錯誤時，明確拋出中文錯誤而不是靜默失敗", async () => {
    process.env.DELEGATE_PRIVATE_KEY = "not-a-valid-key";
    const onchain = await loadOnchain();
    expect(() => onchain.delegateAddress()).toThrow(/DELEGATE_PRIVATE_KEY 格式錯誤/);
  });

  it("delegateAddress 只回傳位址，不會意外洩漏私鑰字串", async () => {
    const onchain = await loadOnchain();
    const address = onchain.delegateAddress();
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(address).not.toContain(DELEGATE_KEY.slice(2));
  });

  it("delegate 位址與 relayer(owner) 位址必須不同——這是低權限 delegate 架構的前提", async () => {
    const onchain = await loadOnchain();
    expect(onchain.delegateAddress().toLowerCase()).not.toBe(onchain.relayerAddress().toLowerCase());
  });
});

describe("ensureAllowanceCanCover：額度檢查必須在送出鏈上交易之前擋下", () => {
  it("nonce=0（Safe 從未 setAllowance）時，丟出指示 Safe 擁有人操作步驟的錯誤", async () => {
    mockAllowance(0n, 0n, 0n);
    const onchain = await loadOnchain();
    await expect(onchain.ensureAllowanceCanCover("jcToken", 1n)).rejects.toThrow(
      /尚未在 Allowance Module 對 delegate.*設定/,
    );
  });

  it("剩餘額度不足時擋下，且不會呼叫 writeContract（未送出任何交易）", async () => {
    mockAllowance(100n, 100n, 1n); // amount=100, spent=100 → remaining=0
    const onchain = await loadOnchain();
    await expect(onchain.ensureAllowanceCanCover("jcToken", 1n)).rejects.toThrow(/額度不足/);
    expect(writeContractMock).not.toHaveBeenCalled();
  });

  it("剩餘額度足夠時通過檢查", async () => {
    mockAllowance(1000n, 100n, 1n); // remaining = 900
    const onchain = await loadOnchain();
    await expect(onchain.ensureAllowanceCanCover("jcToken", 500n)).resolves.toBeUndefined();
  });
});

describe("payoutViaAllowance（mintJc/mintAe 共用實作）：呼叫參數必須符合白名單模型", () => {
  beforeEach(() => {
    getBalanceMock.mockResolvedValue(10n ** 18n); // 給足 gas，不被 ensureDelegateGas 擋下
    getTransactionCountMock.mockResolvedValue(0);
    waitForTransactionReceiptMock.mockResolvedValue({ status: "success" });
    writeContractMock.mockResolvedValue("0xsettlementtxhash");
  });

  it("mintJc 額度足夠時，會呼叫 executeAllowanceTransfer 並傳入正確的 token/safe/delegate/空簽名", async () => {
    mockAllowance(1_000_000_000_000_000_000_000n, 0n, 1n); // 1000 JC 額度
    const onchain = await loadOnchain();
    const to = "0x000000000000000000000000000000000000dEaD";
    const txHash = await onchain.mintJc(to as `0x${string}`, 10);

    expect(txHash).toBe("0xsettlementtxhash");
    expect(writeContractMock).toHaveBeenCalledTimes(1);
    const call = writeContractMock.mock.calls[0][0];
    expect(call.functionName).toBe("executeAllowanceTransfer");
    // args = [safe, token, to, amount, paymentToken, payment, delegate, signature]
    const [safe, token, recipient, amount, paymentToken, payment, delegate, signature] = call.args;
    expect(token.toLowerCase()).toBe(onchain.RELAYER_ADDRESSES.jcToken.toLowerCase());
    expect(safe.toLowerCase()).toBe(onchain.RELAYER_ADDRESSES.safeVault.toLowerCase());
    expect(recipient.toLowerCase()).toBe(to.toLowerCase());
    expect(amount).toBe(10n * 10n ** 18n);
    expect(paymentToken).toBe("0x0000000000000000000000000000000000000000");
    expect(payment).toBe(0n);
    // 關鍵：delegate 參數必須是「送出這筆交易的錢包自己」，且 signature 為空——
    // 這樣合約才會用 msg.sender 當簽署人（見 AllowanceModule.recoverSignature），
    // 不需要額外做 EIP-712 簽名。
    expect(delegate.toLowerCase()).toBe(onchain.delegateAddress().toLowerCase());
    expect(signature).toBe("0x");
  });

  it("mintAe 走同一條路徑，token 白名單換成 AE 代幣位址", async () => {
    mockAllowance(1_000_000_000_000_000_000_000n, 0n, 1n);
    const onchain = await loadOnchain();
    await onchain.mintAe("0x000000000000000000000000000000000000dEaD" as `0x${string}`, 5);
    const call = writeContractMock.mock.calls[0][0];
    expect(call.args[1].toLowerCase()).toBe(onchain.RELAYER_ADDRESSES.aeToken.toLowerCase());
  });

  it("delegate 錢包 ETH 不足時，在呼叫 writeContract 之前就擋下（避免半途卡單）", async () => {
    getBalanceMock.mockResolvedValue(0n);
    mockAllowance(1_000_000_000_000_000_000_000n, 0n, 1n);
    const onchain = await loadOnchain();
    await expect(
      onchain.mintJc("0x000000000000000000000000000000000000dEaD" as `0x${string}`, 10),
    ).rejects.toThrow(/ETH 餘額過低/);
    expect(writeContractMock).not.toHaveBeenCalled();
  });

  it("【已知風險的程式碼層級證據】payoutViaAllowance 對 recipient 沒有做任何白名單/格式以外的檢查——" +
    "只要額度足夠，傳入任意地址都會被接受並送出交易。這不是本測試要驗證的『安全性』，而是刻意" +
    "留下的證據：recipient 的安全性完全依賴呼叫端（relayer.ts）只從 profiles.wallet_address 取值，" +
    "而不是本函式或 Allowance Module 合約本身提供任何保護。", async () => {
    mockAllowance(1_000_000_000_000_000_000_000n, 0n, 1n);
    const onchain = await loadOnchain();
    const arbitraryUnrelatedAddress = "0x1234567890123456789012345678901234567890";
    await expect(
      onchain.mintJc(arbitraryUnrelatedAddress as `0x${string}`, 1),
    ).resolves.toBe("0xsettlementtxhash");
    const call = writeContractMock.mock.calls[0][0];
    expect(call.args[2].toLowerCase()).toBe(arbitraryUnrelatedAddress.toLowerCase());
  });
});

describe("getAllowanceStatus：回傳值必須正確標示是否已註冊", () => {
  it("nonce=0 時 registered 為 false", async () => {
    mockAllowance(0n, 0n, 0n);
    const onchain = await loadOnchain();
    const status = await onchain.getAllowanceStatus("jcToken");
    expect(status.registered).toBe(false);
    expect(status.remaining).toBe(0n);
  });

  it("nonce>0 時 registered 為 true 且 remaining = amount - spent", async () => {
    mockAllowance(500n, 200n, 3n);
    const onchain = await loadOnchain();
    const status = await onchain.getAllowanceStatus("jcToken");
    expect(status.registered).toBe(true);
    expect(status.remaining).toBe(300n);
  });
});
