import type { ChainConfig } from "@agent-market/domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCreatePage } from "./TaskCreatePage.js";
import * as tasksApi from "./api.js";
import * as recommendationsApi from "../recommendations/api.js";
import { ApiError, type FundingIntent, type TaskRecord } from "./api.js";

const ADDRESS = "0x1234567890123456789012345678901234567890" as const;
const CHAIN_CONFIG: ChainConfig = {
  chainId: 31337,
  name: "Local Hardhat",
  isTestnet: true,
  addresses: {
    taskEscrow: `0x${"2".repeat(40)}` as const,
    ydToken: `0x${"1".repeat(40)}` as const,
    ydFaucet: `0x${"3".repeat(40)}` as const,
  },
};

const writeContract = vi.fn();
const waitForTransactionReceipt = vi.fn();
// Mutable so a single test (the faucet-claim-refreshes-balance regression
// below) can start it insufficient and flip it after a simulated claim;
// every other test just gets the always-sufficient default.
let mockYdBalance = 10n ** 30n;
const FAUCET_CLAIM_AMOUNT = 100n * 10n ** 18n;
// TaskCreatePage's own step-3/4 informational reads (stake rate, review
// window) — never awaited by these tests, so an unresolved promise is fine
// for those. Task B's balance precheck (FundingStep) DOES need its
// `balanceOf` read to resolve, or the "开始锁定预算" button never becomes
// enabled. `FaucetClaimButton`'s own reads (claimAmount/cooldownPeriod/
// lastClaimedAt) are routed here too, since it shares the same
// `useWallet().getPublicClient()` mock boundary.
const readContract = vi.fn().mockImplementation(({ functionName }: { functionName: string }) => {
  if (functionName === "balanceOf") return Promise.resolve(mockYdBalance);
  if (functionName === "claimAmount") return Promise.resolve(FAUCET_CLAIM_AMOUNT);
  if (functionName === "cooldownPeriod") return Promise.resolve(0n);
  if (functionName === "lastClaimedAt") return Promise.resolve(0n);
  return new Promise(() => undefined);
});

// Mocked at the `useWallet()` boundary rather than driving a real injected
// provider (window.ethereum) through viem's real transport: the capsule
// explicitly allows "mock wallet client" tests for this orchestration logic
// — what's under test here is TaskCreatePage's own sequencing of the two
// `useTransactionFlow` calls, not viem's/MetaMask's wire protocol (that's
// WalletProvider.test.tsx's job, unchanged by this Task).
vi.mock("../wallet/WalletProvider.js", () => ({
  useWallet: () => ({
    connection: {
      status: "connected",
      address: ADDRESS,
      chainId: CHAIN_CONFIG.chainId,
      ydBalance: { status: "ready", amount: 0n, decimals: 18, formatted: "0" },
    },
    address: ADDRESS,
    chainId: CHAIN_CONFIG.chainId,
    chainConfig: CHAIN_CONFIG,
    isCorrectNetwork: true,
    errorMessage: undefined,
    connect: vi.fn(),
    disconnect: vi.fn(),
    switchNetwork: vi.fn(),
    identityGeneration: 1,
    getIdentityGeneration: () => 1,
    signMessage: vi.fn(),
    getWalletClient: () => ({ writeContract }),
    getPublicClient: () => ({ waitForTransactionReceipt, readContract }),
    refreshBalance: vi.fn(),
  }),
}));

let mockSessionStatus: "signed_out" | "signing_in" | "signed_in" | "error" = "signed_in";

vi.mock("../session/SessionProvider.js", () => ({
  useSession: () => ({
    status: mockSessionStatus,
    address: mockSessionStatus === "signed_in" ? ADDRESS : undefined,
    errorMessage: undefined,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

const INTENT: FundingIntent = {
  contractAddress: CHAIN_CONFIG.addresses.taskEscrow,
  token: CHAIN_CONFIG.addresses.ydToken,
  budget: "1000000000000000000",
  deliveryDeadline: 2_000_000_000,
  taskIdOnChain: `0x${"a".repeat(64)}` as const,
};

function taskFixture(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task-1",
    requesterAddress: ADDRESS,
    category: "writing",
    title: "Test task",
    description: "A task description",
    budget: "1000000000000000000",
    token: CHAIN_CONFIG.addresses.ydToken,
    deliveryDeadline: "2033-01-01T00:00:00.000Z",
    skillTags: [],
    status: "DRAFT",
    fundingTxHash: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    acceptedAgentAddress: null,
    acceptedAt: null,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/tasks/new"]}>
      <Routes>
        <Route path="/tasks/new" element={<TaskCreatePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderPageResuming(taskId: string) {
  return render(
    <MemoryRouter initialEntries={[`/tasks/new?taskId=${taskId}`]}>
      <Routes>
        <Route path="/tasks/new" element={<TaskCreatePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

// Walks the real 4-step wizard exactly as a visitor would (fill step 1 ->
// "下一步" -> skip the optional step 2 -> fill step 3 -> "下一步" -> check
// the step-4 confirmation box) rather than reaching into hidden-step DOM,
// since each step's fields genuinely don't exist in the DOM until its own
// step is active (TaskCreatePage.tsx's wizard renders one step at a time).
function fillForm() {
  fireEvent.change(screen.getByLabelText("标题"), { target: { value: "Test task" } });
  fireEvent.change(screen.getByLabelText("分类"), { target: { value: "writing" } });
  fireEvent.change(screen.getByLabelText("描述"), { target: { value: "A task description" } });
  fireEvent.click(screen.getByRole("button", { name: "下一步：匹配要求" }));

  fireEvent.click(screen.getByRole("button", { name: "下一步：预算与期限" }));

  fireEvent.change(screen.getByLabelText("预算（YD，十进制）"), { target: { value: "12.5" } });
  fireEvent.change(screen.getByLabelText("交付截止时间"), {
    target: { value: "2033-01-01T00:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "下一步：确认并托管" }));

  fireEvent.click(
    screen.getByText(
      "我确认以上任务信息无误，并理解发布任务需要进行两笔链上交易（授权代币、锁定预算）。",
    ),
  );
}

async function createDraftAndReachFundingStep() {
  vi.spyOn(tasksApi, "createDraft").mockResolvedValue({ taskId: "task-1", status: "DRAFT" });
  vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
  vi.spyOn(tasksApi, "createFundingIntent").mockResolvedValue(INTENT);

  renderPage();
  fillForm();
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));

  await screen.findByRole("button", { name: "发起资金锁定" });
  fireEvent.click(screen.getByRole("button", { name: "发起资金锁定" }));
  fireEvent.click(await screen.findByRole("button", { name: "确认锁定预算？" }));

  await screen.findByRole("button", { name: /开始锁定预算/ });
}

beforeEach(() => {
  writeContract.mockReset();
  waitForTransactionReceipt.mockReset();
  mockYdBalance = 10n ** 30n;
  // `vi.restoreAllMocks()` in `afterEach` below also restores plain
  // `vi.fn()` mocks (not just `vi.spyOn` ones) to a no-arg, no-return-value
  // implementation — re-arm this one every test, or the second test onward
  // sees `readContract()` return `undefined` instead of a pending Promise
  // (or, for `balanceOf`, `undefined` instead of a resolved balance).
  readContract.mockReset();
  readContract.mockImplementation(({ functionName }: { functionName: string }) => {
    if (functionName === "balanceOf") return Promise.resolve(mockYdBalance);
    if (functionName === "claimAmount") return Promise.resolve(FAUCET_CLAIM_AMOUNT);
    if (functionName === "cooldownPeriod") return Promise.resolve(0n);
    if (functionName === "lastClaimedAt") return Promise.resolve(0n);
    return new Promise(() => undefined);
  });
});

afterEach(() => {
  mockSessionStatus = "signed_in";
  vi.restoreAllMocks();
});

describe("TaskCreatePage", () => {
  it("converts the decimal budget through parseAmount before submitting the draft", async () => {
    const createDraftSpy = vi
      .spyOn(tasksApi, "createDraft")
      .mockResolvedValue({ taskId: "task-1", status: "DRAFT" });
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());

    renderPage();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));

    await screen.findByRole("button", { name: "发起资金锁定" });

    // "12.5" YD at 18 decimals must become the exact minimal-unit integer
    // string, not a JS-number-rounded or hand-concatenated approximation.
    expect(createDraftSpy).toHaveBeenCalledWith(
      expect.objectContaining({ budget: "12500000000000000000" }),
      expect.any(String),
    );
  });

  it("does not invoke the createTask transaction when approve does not confirm", async () => {
    await createDraftAndReachFundingStep();

    // The approve `writeContract` call rejects (e.g. the user declined the
    // signature) — buildTx throwing makes useTransactionFlow's `start()`
    // resolve to `{ outcome: "failed" }` without ever calling `confirm`/`verify`.
    writeContract.mockRejectedValueOnce(new Error("user rejected the request"));

    fireEvent.click(screen.getByRole("button", { name: /开始锁定预算/ }));

    await waitFor(() => expect(writeContract).toHaveBeenCalledTimes(1));
    // Give any (incorrect) follow-up call a chance to happen before asserting.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeContract.mock.calls[0]?.[0]).toMatchObject({ functionName: "approve" });
  });

  it("invokes createTask only after approve confirms", async () => {
    await createDraftAndReachFundingStep();

    writeContract
      .mockResolvedValueOnce(`0x${"1".repeat(64)}`) // approve tx hash
      .mockResolvedValueOnce(`0x${"2".repeat(64)}`); // createTask tx hash
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    vi.spyOn(tasksApi, "submitFundingVerification").mockResolvedValue({
      status: "OPEN",
      confirmations: 1,
    });
    const requestMatchSpy = vi.spyOn(recommendationsApi, "requestMatch").mockResolvedValue({
      taskId: "task-1",
      algorithmVersion: "v0.1",
      recommendationCount: 1,
    });

    fireEvent.click(screen.getByRole("button", { name: /开始锁定预算/ }));

    await waitFor(() => expect(writeContract).toHaveBeenCalledTimes(2));
    expect(writeContract.mock.calls[0]?.[0]).toMatchObject({ functionName: "approve" });
    expect(writeContract.mock.calls[1]?.[0]).toMatchObject({ functionName: "createTask" });
    expect(await screen.findByText("预算已锁定，任务已开放招募。")).toBeTruthy();
    expect(requestMatchSpy).toHaveBeenCalledWith("task-1");
  });

  it("keeps successful funding confirmed when best-effort matching is temporarily unavailable", async () => {
    await createDraftAndReachFundingStep();
    writeContract
      .mockResolvedValueOnce(`0x${"1".repeat(64)}`)
      .mockResolvedValueOnce(`0x${"2".repeat(64)}`);
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    vi.spyOn(tasksApi, "submitFundingVerification").mockResolvedValue({
      status: "OPEN",
      confirmations: 1,
    });
    vi.spyOn(recommendationsApi, "requestMatch").mockRejectedValue(new Error("dispatch down"));

    fireEvent.click(screen.getByRole("button", { name: /开始锁定预算/ }));

    expect(await screen.findByText("预算已锁定，任务已开放招募。")).toBeTruthy();
  });

  it("re-resumes ?taskId= once the session transitions to signed_in, instead of leaving the user stuck on a blank form (Codex round 2 P1)", async () => {
    mockSessionStatus = "signed_out";
    const getTaskSpy = vi
      .spyOn(tasksApi, "getTask")
      .mockRejectedValueOnce(new ApiError(404, "未找到该任务。"));

    const { rerender } = renderPageResuming("task-1");
    // Signed out: the page's own top-level guard hides all page content
    // behind a sign-in prompt, regardless of resume state.
    await screen.findByText("登录钱包身份后才能发布任务。");

    // The user signs in (e.g. clicks SignInButton); the mocked session
    // value flips, and getTask now succeeds because the session cookie was
    // valid server-side all along.
    getTaskSpy.mockResolvedValueOnce(taskFixture());
    mockSessionStatus = "signed_in";
    rerender(
      <MemoryRouter initialEntries={["/tasks/new?taskId=task-1"]}>
        <Routes>
          <Route path="/tasks/new" element={<TaskCreatePage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole("button", { name: "发起资金锁定" });
    expect(getTaskSpy).toHaveBeenCalledTimes(2);
  });

  it("does not offer a rebroadcast retry for a deterministic backend rejection of an already-sent createTask transaction (Codex round 2 P2)", async () => {
    await createDraftAndReachFundingStep();

    writeContract
      .mockResolvedValueOnce(`0x${"1".repeat(64)}`)
      .mockResolvedValueOnce(`0x${"2".repeat(64)}`);
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    vi.spyOn(tasksApi, "submitFundingVerification").mockRejectedValue(
      new ApiError(400, "事件不匹配", "FUNDING_EVENT_MISMATCH"),
    );

    fireEvent.click(screen.getByRole("button", { name: /开始锁定预算/ }));

    await screen.findByText(/该交易已被后端复核明确拒绝/);
    expect(screen.queryByRole("button", { name: "重试锁定" })).toBeNull();
  });

  it("does NOT classify an ApiError with an unrecognized code as a deterministic rejection — stays recoverable instead (human review, T-606 round 3)", async () => {
    // NOTE on what this test does and doesn't isolate: `fundingFailedDeterministically`
    // (the render-layer gate a few lines below verifyCreateTask) already
    // independently re-validates with its own `isErrorCode` check, so this
    // observable behavior (the retry button appearing) would pass even with
    // verifyCreateTask's own `isErrorCode` guard reverted to the old
    // `error.code as ErrorCode` cast — confirmed by fault injection. Both
    // guards are intentional defense-in-depth (the fix removes an unsafe
    // type assertion at the data layer in addition to the pre-existing
    // render-layer check), so this test documents and locks in the correct
    // END-TO-END behavior, even though it cannot fault-injection-isolate
    // verifyCreateTask's guard specifically from the render-layer one.
    await createDraftAndReachFundingStep();

    writeContract
      .mockResolvedValueOnce(`0x${"1".repeat(64)}`)
      .mockResolvedValueOnce(`0x${"2".repeat(64)}`);
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    // A code string the server sent that isn't one of the fixed domain
    // ErrorCode values (e.g. a future/unrecognized backend error) — must
    // NOT be trusted as `error.code as ErrorCode` previously would have.
    vi.spyOn(tasksApi, "submitFundingVerification").mockRejectedValue(
      new ApiError(400, "未知错误", "SOME_FUTURE_UNRECOGNIZED_CODE"),
    );

    fireEvent.click(screen.getByRole("button", { name: /开始锁定预算/ }));

    // Falls through to the rethrow path — useTransactionFlow's documented
    // behavior for a thrown verify() is rpcRecoveryPending, which IS
    // recoverable, so "重试锁定" must still appear and the deterministic-
    // rejection message must NOT.
    await screen.findByRole("button", { name: "重试锁定" });
    expect(screen.queryByText(/该交易已被后端复核明确拒绝/)).toBeNull();
  });

  it("resuming ?taskId= for an already-OPEN task does not re-request a funding intent (Codex round 1 P2)", async () => {
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "OPEN" }));
    const createFundingIntentSpy = vi.spyOn(tasksApi, "createFundingIntent");

    renderPageResuming("task-1");

    await screen.findByText(/该任务的资金锁定已完成/);
    expect(createFundingIntentSpy).not.toHaveBeenCalled();
  });

  it("reuses the same Idempotency-Key across a failed-then-retried draft submission (Codex round 1 P2)", async () => {
    const createDraftSpy = vi
      .spyOn(tasksApi, "createDraft")
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce({ taskId: "task-1", status: "DRAFT" });
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());

    renderPage();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("创建草稿失败，请重试。");

    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByRole("button", { name: "发起资金锁定" });

    expect(createDraftSpy).toHaveBeenCalledTimes(2);
    const firstKey = createDraftSpy.mock.calls[0]?.[1];
    const secondKey = createDraftSpy.mock.calls[1]?.[1];
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);
  });

  it("treats a pending funding-verifications response as recoverable, not failed", async () => {
    await createDraftAndReachFundingStep();

    writeContract
      .mockResolvedValueOnce(`0x${"1".repeat(64)}`)
      .mockResolvedValueOnce(`0x${"2".repeat(64)}`);
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    vi.spyOn(tasksApi, "submitFundingVerification").mockResolvedValue({
      error: { code: "RPC_TEMPORARILY_UNAVAILABLE", message: "请稍后重试" },
    });

    fireEvent.click(screen.getByRole("button", { name: /开始锁定预算/ }));

    await screen.findByRole("button", { name: "重试锁定" });
    const statuses = screen.getAllByText("网络暂时不可用，可点击重试");
    expect(statuses.length).toBeGreaterThan(0);
    expect(screen.queryByText(/失败：/)).toBeNull();
  });

  // Task C (N4 finding): step 3 previously only checked "非空", so a "0"
  // budget or a past deadline could advance past this gate and only fail
  // once the backend rejected it.
  it("blocks advancing past step 3 when the budget is 0, and shows an inline warning", () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "Test task" } });
    fireEvent.change(screen.getByLabelText("分类"), { target: { value: "writing" } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "A task description" } });
    fireEvent.click(screen.getByRole("button", { name: "下一步：匹配要求" }));
    fireEvent.click(screen.getByRole("button", { name: "下一步：预算与期限" }));

    fireEvent.change(screen.getByLabelText("预算（YD，十进制）"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("交付截止时间"), {
      target: { value: "2033-01-01T00:00" },
    });

    expect(screen.getByText("预算必须大于 0。")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "下一步：确认并托管" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("blocks advancing past step 3 when the deadline is in the past, and shows an inline warning", () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "Test task" } });
    fireEvent.change(screen.getByLabelText("分类"), { target: { value: "writing" } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "A task description" } });
    fireEvent.click(screen.getByRole("button", { name: "下一步：匹配要求" }));
    fireEvent.click(screen.getByRole("button", { name: "下一步：预算与期限" }));

    fireEvent.change(screen.getByLabelText("预算（YD，十进制）"), { target: { value: "12.5" } });
    fireEvent.change(screen.getByLabelText("交付截止时间"), {
      target: { value: "2000-01-01T00:00" },
    });

    expect(screen.getByText("交付截止时间必须晚于当前时间。")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "下一步：确认并托管" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("sets a `min` attribute on the deadline input so the native date picker cannot even offer a past time", () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "Test task" } });
    fireEvent.change(screen.getByLabelText("分类"), { target: { value: "writing" } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "A task description" } });
    fireEvent.click(screen.getByRole("button", { name: "下一步：匹配要求" }));
    fireEvent.click(screen.getByRole("button", { name: "下一步：预算与期限" }));

    const deadlineInput = screen.getByLabelText("交付截止时间") as HTMLInputElement;
    expect(deadlineInput.min).not.toBe("");
    // Must be "now, formatted the same way" — not a stale hardcoded value —
    // parseable back into a Date within a generous tolerance of the actual
    // current time.
    expect(Math.abs(new Date(deadlineInput.min).getTime() - Date.now())).toBeLessThan(120_000);
  });

  it("does not render a page-level SignInButton — session status is shown exactly once, by RootLayout's Header, not duplicated per-page (Task D)", () => {
    renderPage();
    // TaskCreatePage used to render its own <SignInButton /> in the page
    // header in addition to the one RootLayout already supplies via
    // Header's walletControls slot — a real, on-screen duplicate. This page
    // renders in isolation from RootLayout in this test file, so if
    // SignInButton's "已登录：<address>"/"登出" markup shows up here at all,
    // it can only be from a page-level copy that shouldn't exist anymore.
    expect(screen.queryByText(/已登录：/)).toBeNull();
    expect(screen.queryByRole("button", { name: "登出" })).toBeNull();
  });

  it("blocks 开始锁定预算 when the wallet's YD balance is below the task budget, and shows a faucet claim entry (Task B)", async () => {
    mockYdBalance = 5n * 10n ** 17n; // 0.5 YD — below INTENT.budget's 1 YD
    vi.spyOn(tasksApi, "createDraft").mockResolvedValue({ taskId: "task-1", status: "DRAFT" });
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
    vi.spyOn(tasksApi, "createFundingIntent").mockResolvedValue(INTENT);

    renderPage();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByRole("button", { name: "发起资金锁定" });
    fireEvent.click(screen.getByRole("button", { name: "发起资金锁定" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认锁定预算？" }));

    await screen.findByText("YD 余额不足，无法锁定预算。");
    expect(screen.queryByRole("button", { name: /开始锁定预算/ })).toBeNull();
    expect(await screen.findByRole("button", { name: /领取测试 YD/ })).toBeTruthy();
  });

  it("re-reads the funding-step balance after a successful faucet claim, without a page refresh (N4 review P2 regression)", async () => {
    mockYdBalance = 5n * 10n ** 17n; // 0.5 YD — below INTENT.budget's 1 YD
    vi.spyOn(tasksApi, "createDraft").mockResolvedValue({ taskId: "task-1", status: "DRAFT" });
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
    vi.spyOn(tasksApi, "createFundingIntent").mockResolvedValue(INTENT);

    renderPage();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByRole("button", { name: "发起资金锁定" });
    fireEvent.click(screen.getByRole("button", { name: "发起资金锁定" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认锁定预算？" }));

    await screen.findByText("YD 余额不足，无法锁定预算。");

    // Simulate a successful faucet claim: writeContract/waitForTransactionReceipt
    // resolve, and the wallet's real balance is now above the budget.
    writeContract.mockResolvedValue(`0x${"b".repeat(64)}`);
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    mockYdBalance = 2n * 10n ** 18n; // 2 YD — now above the 1 YD budget

    fireEvent.click(await screen.findByRole("button", { name: /领取测试 YD/ }));

    // Without this fix, FundingStep's own `balanceState` effect never
    // re-ran after the claim and the page stayed stuck showing "余额不足"
    // until a full refresh — this must now resolve on its own.
    await screen.findByRole("button", { name: /开始锁定预算/ });
    expect(screen.queryByText("YD 余额不足，无法锁定预算。")).toBeNull();
  });
});
