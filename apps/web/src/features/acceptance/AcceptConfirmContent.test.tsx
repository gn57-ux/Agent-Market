import { StrictMode } from "react";
import type { ChainConfig } from "@agent-market/domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { AcceptConfirmContent } from "./AcceptConfirmContent.js";
import * as acceptanceApi from "./api.js";
import { ApiError, type AcceptancePermitRecord } from "./api.js";
import * as tasksApi from "../tasks/api.js";
import type { TaskRecord } from "../tasks/api.js";
import { TASK_ESCROW_ACCEPT_TASK_ABI } from "../tasks/abi.js";

const ADDRESS = "0x1234567890123456789012345678901234567890" as const;
const CHAIN_CONFIG: ChainConfig = {
  chainId: 31337,
  name: "Local Hardhat",
  addresses: {
    taskEscrow: `0x${"2".repeat(40)}` as const,
    ydToken: `0x${"1".repeat(40)}` as const,
    ydFaucet: `0x${"3".repeat(40)}` as const,
  },
};

const writeContract = vi.fn();
const waitForTransactionReceipt = vi.fn();
const readContract = vi.fn();
// Mutable outside the mocked module so individual tests (e.g. the wallet
// switch regression below) can bump it and observe the component re-read
// balance/allowance — mirrors AcceptanceSection.test.tsx's own
// `getPublicClientImpl` mutable-closure convention for the same wallet mock
// boundary.
let identityGeneration = 1;

// Same boundary TaskCreatePage.test.tsx mocks at — this Task's own
// orchestration logic is what's under test, not viem's/MetaMask's wire
// protocol.
vi.mock("../wallet/WalletProvider.js", () => ({
  useWallet: () => ({
    connection: { status: "connected", address: ADDRESS, chainId: CHAIN_CONFIG.chainId },
    address: ADDRESS,
    chainId: CHAIN_CONFIG.chainId,
    chainConfig: CHAIN_CONFIG,
    isCorrectNetwork: true,
    errorMessage: undefined,
    connect: vi.fn(),
    disconnect: vi.fn(),
    switchNetwork: vi.fn(),
    identityGeneration,
    getIdentityGeneration: () => identityGeneration,
    signMessage: vi.fn(),
    getWalletClient: () => ({ writeContract }),
    getPublicClient: () => ({ waitForTransactionReceipt, readContract }),
  }),
}));

/** Default T-807 balance/allowance fixture used by every test that doesn't
 * care about the balance/allowance check itself (i.e. every regression test
 * ported forward from before T-807): balance comfortably covers a 100n
 * stake, allowance stays 0 so those tests keep exercising the existing
 * approve→acceptTask two-step flow unchanged. Tests that DO care about the
 * check override `readContract`'s implementation themselves. */
function mockSufficientBalanceInsufficientAllowance() {
  readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
    functionName === "balanceOf" ? 1000n : 0n,
  );
}

function mockBalanceAllowance(balance: bigint, allowance: bigint) {
  readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
    functionName === "balanceOf" ? balance : allowance,
  );
}

const FUTURE_EXPIRY = Math.floor(Date.now() / 1000) + 3600;

function permitFixture(overrides: Partial<AcceptancePermitRecord> = {}): AcceptancePermitRecord {
  return {
    agentId: "agent-1",
    taskId: "task-1",
    agentWalletAddress: ADDRESS,
    nonce: "123456789",
    expiry: FUTURE_EXPIRY,
    chainId: CHAIN_CONFIG.chainId,
    verifyingContract: CHAIN_CONFIG.addresses.taskEscrow,
    signature: `0x${"a".repeat(130)}` as const,
    ...overrides,
  };
}

function taskRecordFixture(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task-1",
    requesterAddress: `0x${"9".repeat(40)}`,
    category: "dev",
    title: "t",
    description: "d",
    budget: "100",
    token: CHAIN_CONFIG.addresses.ydToken,
    deliveryDeadline: new Date().toISOString(),
    skillTags: [],
    status: "OPEN",
    fundingTxHash: `0x${"a".repeat(64)}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    acceptedAgentAddress: null,
    acceptedAt: null,
    ...overrides,
  };
}

/**
 * Builds a realistic viem revert error: the exact shape `writeContract`
 * throws when the wallet/RPC's pre-broadcast `eth_call` simulation decodes a
 * custom contract error (per T-804 capsule — a hand-rolled plain `Error`
 * would not exercise the actual `.walk()`/`ContractFunctionRevertedError`
 * decoding path `buildAcceptTaskTx` relies on).
 */
// `status` defaults to `1` (ACCEPTED, per contracts/src/TaskEscrow.sol's
// TaskStatus enum order) — pass a different value (e.g. `6` for CANCELLED)
// to build the "TaskNotOpen for an unrelated reason" regression fixture.
function taskNotOpenRevertError(status = 1): BaseError {
  const data = encodeErrorResult({
    abi: TASK_ESCROW_ACCEPT_TASK_ABI,
    errorName: "TaskNotOpen",
    args: [`0x${"0".repeat(64)}` as const, status],
  });
  const revertedError = new ContractFunctionRevertedError({
    abi: TASK_ESCROW_ACCEPT_TASK_ABI,
    data,
    functionName: "acceptTask",
  });
  // Mirrors viem's real `ContractFunctionExecutionError`: the decoded revert
  // sits on the `cause` chain of the error `writeContract` actually throws,
  // not as the top-level error itself.
  return new BaseError("execution reverted", {
    cause: revertedError,
    name: "ContractFunctionExecutionError",
  });
}

beforeEach(() => {
  writeContract.mockReset();
  waitForTransactionReceipt.mockReset();
  readContract.mockReset();
  identityGeneration = 1;
  mockSufficientBalanceInsufficientAllowance();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function reachReadyState(permit = permitFixture()) {
  vi.spyOn(acceptanceApi, "getAcceptancePermitForAgent").mockResolvedValue(permit);
  render(<AcceptConfirmContent taskId="task-1" agentId="agent-1" stake={100n} />);
  await screen.findByRole("button", { name: "开始质押接单" });
}

describe("AcceptConfirmContent", () => {
  it("shows an unavailable message and no confirm control when no permit is found (404)", async () => {
    vi.spyOn(acceptanceApi, "getAcceptancePermitForAgent").mockRejectedValue(
      new ApiError(404, "未找到可用的接单授权。"),
    );

    render(<AcceptConfirmContent taskId="task-1" agentId="agent-1" stake={100n} />);

    expect((await screen.findByRole("alert")).textContent).toContain("过期或不可用");
    expect(screen.queryByRole("button", { name: "开始质押接单" })).toBeNull();
  });

  it("shows an unavailable message when the fetched permit's expiry has already lapsed (AC-804)", async () => {
    vi.spyOn(acceptanceApi, "getAcceptancePermitForAgent").mockResolvedValue(
      permitFixture({ expiry: Math.floor(Date.now() / 1000) - 10 }),
    );

    render(<AcceptConfirmContent taskId="task-1" agentId="agent-1" stake={100n} />);

    expect((await screen.findByRole("alert")).textContent).toContain("过期或不可用");
    expect(screen.queryByRole("button", { name: "开始质押接单" })).toBeNull();
  });

  it("does not invoke acceptTask when approve does not confirm (AC-806)", async () => {
    await reachReadyState();
    writeContract.mockRejectedValueOnce(new Error("user rejected the request"));

    fireEvent.click(screen.getByRole("button", { name: "开始质押接单" }));

    await waitFor(() => expect(writeContract).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeContract.mock.calls[0]?.[0]).toMatchObject({ functionName: "approve" });
  });

  // Regression for Codex round 2 P2: a successful "重试授权" must continue on
  // to acceptTask, same as a first-attempt success — discarding
  // `approveFlow.retry()`'s result left the flow stuck (approve confirmed,
  // acceptTask never started, main button permanently disabled since
  // `canStart` requires approve to be `idle`).
  it("continues on to acceptTask after a successful 重试授权 (approve retry)", async () => {
    const permit = permitFixture();
    vi.spyOn(acceptanceApi, "getAcceptancePermitForAgent").mockResolvedValue(permit);
    writeContract
      .mockRejectedValueOnce(new Error("user rejected the request")) // first approve attempt fails
      .mockResolvedValueOnce(`0x${"1".repeat(64)}`) // retried approve succeeds
      .mockResolvedValueOnce(`0x${"2".repeat(64)}`); // acceptTask tx hash
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    vi.spyOn(acceptanceApi, "submitAcceptanceVerification").mockResolvedValue({
      status: "ACCEPTED",
      confirmations: 1,
    });
    const onAccepted = vi.fn();
    render(
      <AcceptConfirmContent
        taskId="task-1"
        agentId="agent-1"
        stake={100n}
        onAccepted={onAccepted}
      />,
    );
    await screen.findByRole("button", { name: "开始质押接单" });

    fireEvent.click(screen.getByRole("button", { name: "开始质押接单" }));
    await waitFor(() => expect(writeContract).toHaveBeenCalledTimes(1));
    const retryButton = await screen.findByRole("button", { name: "重试授权" });

    fireEvent.click(retryButton);

    await waitFor(() => expect(writeContract).toHaveBeenCalledTimes(3));
    expect(writeContract.mock.calls[2]?.[0]).toMatchObject({ functionName: "acceptTask" });
    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(await screen.findAllByText("接单成功。")).toHaveLength(1);
  });

  // Regression for Codex round 2 P2: a successful "重试接单" must call
  // `onAccepted`, same as a first-attempt success — the parent `ActionSheet`
  // relies on this callback to close, so a retry that confirms must not
  // silently skip it.
  it("calls onAccepted after a successful 重试接单 (acceptTask retry)", async () => {
    const permit = permitFixture();
    vi.spyOn(acceptanceApi, "getAcceptancePermitForAgent").mockResolvedValue(permit);
    writeContract
      .mockResolvedValueOnce(`0x${"1".repeat(64)}`) // approve tx hash
      .mockResolvedValueOnce(`0x${"2".repeat(64)}`) // acceptTask, first attempt
      .mockResolvedValueOnce(`0x${"3".repeat(64)}`); // acceptTask, retried attempt
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    vi.spyOn(acceptanceApi, "submitAcceptanceVerification")
      .mockRejectedValueOnce(new Error("network blip")) // first acceptTask verify: transient
      .mockResolvedValueOnce({ status: "ACCEPTED", confirmations: 1 }); // retried verify succeeds
    const onAccepted = vi.fn();
    render(
      <AcceptConfirmContent
        taskId="task-1"
        agentId="agent-1"
        stake={100n}
        onAccepted={onAccepted}
      />,
    );
    await screen.findByRole("button", { name: "开始质押接单" });

    fireEvent.click(screen.getByRole("button", { name: "开始质押接单" }));
    const retryButton = await screen.findByRole("button", { name: "重试接单" });
    expect(onAccepted).not.toHaveBeenCalled();

    fireEvent.click(retryButton);

    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(await screen.findAllByText("接单成功。")).toHaveLength(1);
  });

  it("invokes acceptTask only after approve confirms, and reports success", async () => {
    const permit = permitFixture();
    vi.spyOn(acceptanceApi, "getAcceptancePermitForAgent").mockResolvedValue(permit);

    writeContract
      .mockResolvedValueOnce(`0x${"1".repeat(64)}`) // approve tx hash
      .mockResolvedValueOnce(`0x${"2".repeat(64)}`); // acceptTask tx hash
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    vi.spyOn(acceptanceApi, "submitAcceptanceVerification").mockResolvedValue({
      status: "ACCEPTED",
      confirmations: 1,
    });
    const onAccepted = vi.fn();
    render(
      <AcceptConfirmContent
        taskId="task-1"
        agentId="agent-1"
        stake={100n}
        onAccepted={onAccepted}
      />,
    );
    await screen.findByRole("button", { name: "开始质押接单" });

    fireEvent.click(screen.getByRole("button", { name: "开始质押接单" }));

    await waitFor(() => expect(writeContract).toHaveBeenCalledTimes(2));
    expect(writeContract.mock.calls[0]?.[0]).toMatchObject({ functionName: "approve" });
    expect(writeContract.mock.calls[1]?.[0]).toMatchObject({
      functionName: "acceptTask",
      args: [
        expect.objectContaining({
          agent: permit.agentWalletAddress,
          nonce: BigInt(permit.nonce),
          expiry: BigInt(permit.expiry),
          chainId: BigInt(permit.chainId),
          verifyingContract: permit.verifyingContract,
        }),
        permit.signature,
      ],
    });
    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(await screen.findAllByText("接单成功。")).toHaveLength(1);
  });

  // Regression for Codex round 1 P1: the connected wallet must match the
  // permit's own agent wallet before any transaction is allowed — otherwise
  // `approve` would succeed for the wrong account and `acceptTask` would
  // then inevitably revert (`permit.agent == msg.sender`).
  it("disables the confirm button and shows a warning when the connected wallet doesn't match the permit's agent wallet", async () => {
    const mismatchedAddress = "0x9999999999999999999999999999999999999999" as const;
    await reachReadyState(permitFixture({ agentWalletAddress: mismatchedAddress }));

    const button = screen.getByRole("button", { name: "开始质押接单" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect((await screen.findByRole("alert")).textContent).toContain("与接单授权不匹配");

    fireEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writeContract).not.toHaveBeenCalled();
  });

  // Regression for Codex round 1 P2: expiry must be re-checked at the
  // moment the user actually starts the flow, not only once at fetch time —
  // a panel left open past `permit.expiry` must not let `approve` succeed
  // before the now-expired `acceptTask` inevitably reverts.
  it("re-checks expiry at click time: a permit that lapses while the panel is open blocks the start instead of running approve", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const soon = Math.floor(Date.now() / 1000) + 5;
      vi.spyOn(acceptanceApi, "getAcceptancePermitForAgent").mockResolvedValue(
        permitFixture({ expiry: soon }),
      );
      render(<AcceptConfirmContent taskId="task-1" agentId="agent-1" stake={100n} />);
      await vi.waitFor(() => screen.getByRole("button", { name: "开始质押接单" }));

      // Advance real+fake time past `expiry` without ever re-fetching the
      // permit — this is exactly the "panel left open" scenario.
      vi.advanceTimersByTime(10_000);

      fireEvent.click(screen.getByRole("button", { name: "开始质押接单" }));
      await vi.waitFor(() => {
        expect(screen.getByRole("alert").textContent).toContain("过期或不可用");
      });
      expect(writeContract).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression for Codex round 2 P2: `buildAcceptTaskTx` is called directly
  // by `acceptFlow.retry()`, bypassing `handleStartAccept`'s click-time
  // check entirely — a permit that lapses between the first (failed)
  // attempt and a retry must still block the retry from broadcasting.
  it("re-checks expiry immediately before broadcasting acceptTask on retry(), even after approve already succeeded once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const soon = Math.floor(Date.now() / 1000) + 5;
      vi.spyOn(acceptanceApi, "getAcceptancePermitForAgent").mockResolvedValue(
        permitFixture({ expiry: soon }),
      );
      writeContract
        .mockResolvedValueOnce(`0x${"1".repeat(64)}`) // approve succeeds
        .mockRejectedValueOnce(new Error("network blip")); // first acceptTask attempt fails
      waitForTransactionReceipt.mockResolvedValue({ status: "success" });

      render(<AcceptConfirmContent taskId="task-1" agentId="agent-1" stake={100n} />);
      await vi.waitFor(() => screen.getByRole("button", { name: "开始质押接单" }));

      fireEvent.click(screen.getByRole("button", { name: "开始质押接单" }));
      await vi.waitFor(() => screen.getByRole("button", { name: "重试接单" }));

      // Advance past `expiry` without ever re-fetching the permit, then
      // retry — this is exactly the path that bypasses handleStartAccept.
      vi.advanceTimersByTime(10_000);
      writeContract.mockClear();

      fireEvent.click(screen.getByRole("button", { name: "重试接单" }));
      await vi.waitFor(() => {
        expect(screen.getByRole("alert").textContent).toContain("过期");
      });
      expect(writeContract).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // T-804 / AC-803: 方案 A — the wallet's own pre-broadcast simulation
  // decodes the `TaskNotOpen` revert immediately, before ever broadcasting.
  it("shows the already-accepted message when writeContract rejects with a decoded TaskNotOpen revert", async () => {
    await reachReadyState();
    writeContract
      .mockResolvedValueOnce(`0x${"1".repeat(64)}`) // approve succeeds
      .mockRejectedValueOnce(taskNotOpenRevertError()); // acceptTask's pre-broadcast simulation reverts
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });

    fireEvent.click(screen.getByRole("button", { name: "开始质押接单" }));

    expect((await screen.findByRole("alert")).textContent).toContain("已被接单");
    // Not misclassified as a deterministic backend rejection — no retry
    // control should remain, and no unrelated ErrorCode-style message shown.
    expect(screen.queryByRole("button", { name: "重试接单" })).toBeNull();
  });

  // Regression for Codex round 1 P2: `TaskNotOpen` fires for EVERY non-OPEN
  // status, not only `ACCEPTED` — a decoded revert reporting `CANCELLED`
  // (status 6) must NOT be shown as "已被接单" (misleading: no other
  // candidate accepted anything).
  it("does not show the already-accepted message for a TaskNotOpen revert reporting a different status (e.g. CANCELLED)", async () => {
    await reachReadyState();
    writeContract
      .mockResolvedValueOnce(`0x${"1".repeat(64)}`) // approve succeeds
      .mockRejectedValueOnce(taskNotOpenRevertError(6)); // CANCELLED, not ACCEPTED
    waitForTransactionReceipt.mockResolvedValue({ status: "success" }); // approve's confirm

    fireEvent.click(screen.getByRole("button", { name: "开始质押接单" }));

    await waitFor(() =>
      expect(document.querySelector('[data-transaction-status="failed"]')).toBeTruthy(),
    );
    expect(screen.queryAllByRole("alert").some((el) => el.textContent?.includes("已被接单"))).toBe(
      false,
    );
  });

  // T-804 / AC-803: 方案 A 第二阶段 + 方案 B — the transaction is mined but
  // reverted (no decodable reason on the receipt alone), so the polling
  // fallback's `getTask` is what determines the task was accepted under a
  // different wallet address.
  it("shows the already-accepted message when the receipt reverts and polling observes a different accepted address", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await reachReadyState();
      writeContract
        .mockResolvedValueOnce(`0x${"1".repeat(64)}`) // approve tx hash
        .mockResolvedValueOnce(`0x${"2".repeat(64)}`); // acceptTask tx hash
      waitForTransactionReceipt
        .mockResolvedValueOnce({ status: "success" }) // approve's confirm
        .mockResolvedValueOnce({ status: "reverted" }); // acceptTask's confirm
      vi.spyOn(tasksApi, "getTask").mockResolvedValue(
        taskRecordFixture({
          status: "ACCEPTED",
          acceptedAgentAddress: "0x9999999999999999999999999999999999999999",
        }),
      );

      fireEvent.click(screen.getByRole("button", { name: "开始质押接单" }));

      await vi.waitFor(
        () => {
          expect(screen.getByRole("alert").textContent).toContain("已被接单");
        },
        { timeout: 8000 },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  // T-804: an unrelated failure (network error) during confirm must NOT be
  // misclassified as "already accepted" — polling runs as the fallback but
  // `getTask` never observes an ACCEPTED-by-someone-else task, so the
  // original generic failure (`rpcRecoveryPending`, same as any other
  // recoverable failure T-803 already handles) stays displayed instead of
  // being masked as "already accepted".
  it("keeps the generic failure display for an unrelated failure (network error), not misclassified as already-accepted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await reachReadyState();
      writeContract
        .mockResolvedValueOnce(`0x${"1".repeat(64)}`) // approve tx hash
        .mockResolvedValueOnce(`0x${"2".repeat(64)}`); // acceptTask tx hash
      waitForTransactionReceipt
        .mockResolvedValueOnce({ status: "success" }) // approve's confirm
        .mockRejectedValueOnce(new Error("network blip")); // acceptTask's confirm: transient network failure
      vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskRecordFixture({ status: "OPEN" }));

      fireEvent.click(screen.getByRole("button", { name: "开始质押接单" }));

      // `TransactionStatusView` only ever renders a fixed generic label for
      // `rpcRecoveryPending` (not the underlying `lastError` text) — same
      // as any other recoverable failure T-803 already covers, so that
      // fixed label plus the `data-transaction-status` attribute is what
      // this test checks for, not the raw "network blip" string.
      await vi.waitFor(
        () => {
          expect(
            document.querySelector('[data-transaction-status="rpcRecoveryPending"]'),
          ).toBeTruthy();
        },
        { timeout: 8000 },
      );
      expect(screen.queryByRole("alert")).toBeNull();
      // Still recoverable — a network blip should offer a retry, unlike the
      // already-accepted case.
      expect(screen.getByRole("button", { name: "重试接单" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  // T-804: polling must stop once the component unmounts — no lingering
  // `getTask` calls after that point (mirrors this file's `ignore`-flag
  // pattern, verified here via the `mountedRef` it maps to).
  it("stops calling getTask once the component unmounts mid-poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const permit = permitFixture();
      vi.spyOn(acceptanceApi, "getAcceptancePermitForAgent").mockResolvedValue(permit);
      writeContract
        .mockResolvedValueOnce(`0x${"1".repeat(64)}`)
        .mockResolvedValueOnce(`0x${"2".repeat(64)}`);
      waitForTransactionReceipt
        .mockResolvedValueOnce({ status: "success" })
        .mockResolvedValueOnce({ status: "reverted" });
      const getTaskSpy = vi
        .spyOn(tasksApi, "getTask")
        .mockResolvedValue(taskRecordFixture({ status: "OPEN" }));

      const { unmount } = render(
        <AcceptConfirmContent taskId="task-1" agentId="agent-1" stake={100n} />,
      );
      await vi.waitFor(() => screen.getByRole("button", { name: "开始质押接单" }));

      fireEvent.click(screen.getByRole("button", { name: "开始质押接单" }));
      await vi.waitFor(() => expect(writeContract).toHaveBeenCalledTimes(2));

      // Let the first poll attempt land, then unmount before any further
      // attempts would fire.
      await vi.waitFor(() => expect(getTaskSpy).toHaveBeenCalledTimes(1));
      unmount();
      const callsAtUnmount = getTaskSpy.mock.calls.length;

      // Advance well past the remaining poll window — if the cleanup didn't
      // take effect, more calls would show up here.
      await vi.advanceTimersByTimeAsync(6000);
      expect(getTaskSpy.mock.calls.length).toBe(callsAtUnmount);
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression for Codex round 1 P1: this app renders under React
  // `StrictMode` (main.tsx), which in development runs every effect's
  // setup→cleanup→setup cycle twice. Rendering under `<StrictMode>` here
  // reproduces that double-invoke — without re-setting `mountedRef.current
  // = true` on the second setup, the first cleanup's `false` would stick
  // permanently, silently disabling 方案 B's polling in the app's actual
  // normal dev runtime (a plain, non-StrictMode render — as every other
  // test in this file uses — could never have caught this).
  it("still polls and reports already-accepted under StrictMode's double effect invocation", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const permit = permitFixture();
      vi.spyOn(acceptanceApi, "getAcceptancePermitForAgent").mockResolvedValue(permit);
      writeContract
        .mockResolvedValueOnce(`0x${"1".repeat(64)}`)
        .mockResolvedValueOnce(`0x${"2".repeat(64)}`);
      waitForTransactionReceipt
        .mockResolvedValueOnce({ status: "success" })
        .mockResolvedValueOnce({ status: "reverted" });
      vi.spyOn(tasksApi, "getTask").mockResolvedValue(
        taskRecordFixture({
          status: "ACCEPTED",
          acceptedAgentAddress: "0x9999999999999999999999999999999999999999",
        }),
      );

      render(
        <StrictMode>
          <AcceptConfirmContent taskId="task-1" agentId="agent-1" stake={100n} />
        </StrictMode>,
      );
      await vi.waitFor(() => screen.getByRole("button", { name: "开始质押接单" }));

      fireEvent.click(screen.getByRole("button", { name: "开始质押接单" }));

      await vi.waitFor(
        () => {
          expect(screen.getByRole("alert").textContent).toContain("已被接单");
        },
        { timeout: 8000 },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  // T-807 (human N6 BLOCK fix): a real on-chain `balanceOf` read reporting
  // less than `stake` must block ALL transaction initiation — no clickable
  // confirm button rendered at all (same "unclickable state, not a button
  // that then immediately fails" pattern the permit-expiry handling above
  // already uses), plus a clear message.
  it("blocks with a clear message and renders no clickable confirm button when the real on-chain balance is below stake", async () => {
    mockBalanceAllowance(50n, 0n); // balance 50 < stake 100
    vi.spyOn(acceptanceApi, "getAcceptancePermitForAgent").mockResolvedValue(permitFixture());
    render(<AcceptConfirmContent taskId="task-1" agentId="agent-1" stake={100n} />);

    expect((await screen.findByRole("alert")).textContent).toContain("YD 余额不足");
    expect(screen.queryByRole("button", { name: "开始质押接单" })).toBeNull();
    expect(writeContract).not.toHaveBeenCalled();
  });

  // T-807: allowance already covering stake must skip `approve` entirely —
  // clicking confirm goes straight to `acceptTask`, exactly one
  // `writeContract` call, none of them `approve` (the capsule explicitly
  // forbids a no-op `approve(spender, 0)` "to keep both steps uniform").
  it("skips approve and calls acceptTask directly when the real on-chain allowance already covers stake", async () => {
    mockBalanceAllowance(1000n, 100n); // allowance 100 >= stake 100
    const permit = permitFixture();
    vi.spyOn(acceptanceApi, "getAcceptancePermitForAgent").mockResolvedValue(permit);
    writeContract.mockResolvedValueOnce(`0x${"2".repeat(64)}`); // acceptTask tx hash
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    vi.spyOn(acceptanceApi, "submitAcceptanceVerification").mockResolvedValue({
      status: "ACCEPTED",
      confirmations: 1,
    });
    const onAccepted = vi.fn();
    render(
      <AcceptConfirmContent
        taskId="task-1"
        agentId="agent-1"
        stake={100n}
        onAccepted={onAccepted}
      />,
    );
    await screen.findByRole("button", { name: "开始质押接单" });

    fireEvent.click(screen.getByRole("button", { name: "开始质押接单" }));

    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(writeContract.mock.calls[0]?.[0]).toMatchObject({ functionName: "acceptTask" });
  });

  // T-807 round 1, P1 regression (Codex review): a double-click during the
  // async balance/allowance read window (before either `useTransactionFlow`
  // leaves `idle`) must not start two concurrent accept sequences — exactly
  // one `readContract`-driven check should lead to exactly one
  // `writeContract` broadcast. `readContract` is made to resolve on a
  // controllable promise so the second click fires WHILE the first click's
  // balance/allowance read is still in flight, reproducing the exact race
  // window the finding described.
  it("ignores a second click fired while the first click's balance/allowance read is still in flight", async () => {
    // `readBalanceAllowance` calls `readContract` twice per invocation
    // (`Promise.all([balanceOf, allowance])) — buffer every pending
    // resolver so both can be settled together, rather than one
    // `resolveRead` variable being overwritten by the second call and
    // leaving the first `Promise.all` permanently unresolved.
    let pendingResolvers: Array<(value: bigint) => void> = [];
    function queueReads() {
      readContract.mockImplementation(
        () =>
          new Promise<bigint>((resolve) => {
            pendingResolvers.push(resolve);
          }),
      );
    }
    function resolvePendingReads(value: bigint) {
      const resolvers = pendingResolvers;
      pendingResolvers = [];
      resolvers.forEach((resolve) => resolve(value));
    }
    queueReads();
    const permit = permitFixture();
    vi.spyOn(acceptanceApi, "getAcceptancePermitForAgent").mockResolvedValue(permit);
    writeContract.mockResolvedValueOnce(`0x${"2".repeat(64)}`); // acceptTask tx hash
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    vi.spyOn(acceptanceApi, "submitAcceptanceVerification").mockResolvedValue({
      status: "ACCEPTED",
      confirmations: 1,
    });
    render(<AcceptConfirmContent taskId="task-1" agentId="agent-1" stake={100n} />);
    // Let the mount-time balance/allowance effect resolve first, with a
    // sufficient balance/allowance so a confirm button actually renders.
    await waitFor(() => expect(pendingResolvers).toHaveLength(2));
    resolvePendingReads(1000n);
    await screen.findByRole("button", { name: "开始质押接单" });

    // Fresh in-flight reads for the click-time re-read, then click twice
    // before that re-read settles.
    queueReads();
    const button = screen.getByRole("button", { name: "开始质押接单" });
    fireEvent.click(button);
    await waitFor(() => expect(pendingResolvers).toHaveLength(2));
    fireEvent.click(button); // fired while the first click's read is still pending
    resolvePendingReads(1000n); // settle balanceOf/allowance for the in-flight read(s)

    await waitFor(() => expect(writeContract).toHaveBeenCalledTimes(1));
    expect(writeContract.mock.calls[0]?.[0]).toMatchObject({ functionName: "acceptTask" });
    // No second read pair was ever queued by a re-entrant second call.
    expect(pendingResolvers).toHaveLength(0);
  });

  // T-807 regression: insufficient allowance must still run the existing
  // two-step approve→acceptTask flow unchanged.
  it("still runs the two-step approve→acceptTask flow when the real on-chain allowance is below stake", async () => {
    mockBalanceAllowance(1000n, 0n); // allowance 0 < stake 100
    const permit = permitFixture();
    vi.spyOn(acceptanceApi, "getAcceptancePermitForAgent").mockResolvedValue(permit);
    writeContract
      .mockResolvedValueOnce(`0x${"1".repeat(64)}`) // approve tx hash
      .mockResolvedValueOnce(`0x${"2".repeat(64)}`); // acceptTask tx hash
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    vi.spyOn(acceptanceApi, "submitAcceptanceVerification").mockResolvedValue({
      status: "ACCEPTED",
      confirmations: 1,
    });
    render(<AcceptConfirmContent taskId="task-1" agentId="agent-1" stake={100n} />);
    await screen.findByRole("button", { name: "开始质押接单" });

    fireEvent.click(screen.getByRole("button", { name: "开始质押接单" }));

    await waitFor(() => expect(writeContract).toHaveBeenCalledTimes(2));
    expect(writeContract.mock.calls[0]?.[0]).toMatchObject({ functionName: "approve" });
    expect(writeContract.mock.calls[1]?.[0]).toMatchObject({ functionName: "acceptTask" });
  });

  // T-807: the read-only balance/allowance call itself failing (RPC error)
  // must NOT be treated as "check passed" — no clickable confirm button, no
  // transaction ever initiated.
  it("keeps the confirm control unavailable when the real balance/allowance read itself fails (RPC error)", async () => {
    readContract.mockRejectedValue(new Error("RPC unavailable"));
    vi.spyOn(acceptanceApi, "getAcceptancePermitForAgent").mockResolvedValue(permitFixture());
    render(<AcceptConfirmContent taskId="task-1" agentId="agent-1" stake={100n} />);

    expect((await screen.findByRole("alert")).textContent).toContain("失败");
    expect(screen.queryByRole("button", { name: "开始质押接单" })).toBeNull();
    expect(writeContract).not.toHaveBeenCalled();
  });

  // T-807: balance/allowance must be re-read at the moment of clicking
  // confirm, not just trusted from whatever was read at mount — mirrors this
  // file's existing permit-expiry "re-check at click time" convention. Here,
  // allowance becomes sufficient between mount and click; the click-time
  // re-read must pick that up and skip approve, rather than acting on the
  // stale (insufficient) mounted-time reading.
  it("re-reads balance/allowance at click time, not just at mount", async () => {
    mockBalanceAllowance(1000n, 0n); // insufficient allowance at mount
    const permit = permitFixture();
    vi.spyOn(acceptanceApi, "getAcceptancePermitForAgent").mockResolvedValue(permit);
    render(<AcceptConfirmContent taskId="task-1" agentId="agent-1" stake={100n} />);
    await screen.findByRole("button", { name: "开始质押接单" });

    // Allowance becomes sufficient before the click — a real scenario e.g.
    // if the user separately approved the spender in MetaMask directly.
    mockBalanceAllowance(1000n, 100n);
    writeContract.mockResolvedValueOnce(`0x${"2".repeat(64)}`); // acceptTask tx hash
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    vi.spyOn(acceptanceApi, "submitAcceptanceVerification").mockResolvedValue({
      status: "ACCEPTED",
      confirmations: 1,
    });

    fireEvent.click(screen.getByRole("button", { name: "开始质押接单" }));

    await waitFor(() => expect(writeContract).toHaveBeenCalledTimes(1));
    expect(writeContract.mock.calls[0]?.[0]).toMatchObject({ functionName: "acceptTask" });
  });

  // T-807: a wallet switch (`identityGeneration` change, `useWallet()`'s own
  // exposed counter) must trigger a fresh balance/allowance read — a stale
  // reading from the PREVIOUS wallet must never gate the CURRENTLY connected
  // one's transaction.
  it("re-reads balance/allowance when the wallet's identityGeneration changes (wallet switch)", async () => {
    mockBalanceAllowance(1000n, 0n);
    const permit = permitFixture();
    vi.spyOn(acceptanceApi, "getAcceptancePermitForAgent").mockResolvedValue(permit);
    const { rerender } = render(
      <AcceptConfirmContent taskId="task-1" agentId="agent-1" stake={100n} />,
    );
    await screen.findByRole("button", { name: "开始质押接单" });
    const callsBeforeSwitch = readContract.mock.calls.length;

    identityGeneration = 2; // simulates the wallet switching account/network
    rerender(<AcceptConfirmContent taskId="task-1" agentId="agent-1" stake={100n} />);

    await waitFor(() => expect(readContract.mock.calls.length).toBeGreaterThan(callsBeforeSwitch));
  });
});
