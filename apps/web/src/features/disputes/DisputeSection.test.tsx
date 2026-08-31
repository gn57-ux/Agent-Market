import type { ChainConfig } from "@agent-market/domain";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisputeSection } from "./DisputeSection.js";
import * as tasksApi from "../tasks/api.js";
import type { TaskRecord } from "../tasks/api.js";
import * as disputesApi from "./api.js";

const REQUESTER_ADDRESS = "0x1234567890123456789012345678901234567890" as const;
const AGENT_ADDRESS = "0x9999999999999999999999999999999999999999" as const;
const ARBITRATOR_ADDRESS = "0x5555555555555555555555555555555555555555" as const;

let mockSession: {
  status: "signed_out" | "signed_in";
  address: string | undefined;
} = { status: "signed_out", address: undefined };

vi.mock("../session/SessionProvider.js", () => ({
  useSession: () => ({
    status: mockSession.status,
    address: mockSession.address,
    errorMessage: undefined,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

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
let mockWalletAddress: string | undefined = REQUESTER_ADDRESS;
let mockIsCorrectNetwork = true;

vi.mock("../wallet/WalletProvider.js", () => ({
  useWallet: () => ({
    connection: { status: "connected", address: mockWalletAddress, chainId: CHAIN_CONFIG.chainId },
    address: mockWalletAddress,
    chainId: CHAIN_CONFIG.chainId,
    chainConfig: CHAIN_CONFIG,
    isCorrectNetwork: mockIsCorrectNetwork,
    errorMessage: undefined,
    connect: vi.fn(),
    disconnect: vi.fn(),
    switchNetwork: vi.fn(),
    identityGeneration: 1,
    getIdentityGeneration: () => 1,
    signMessage: vi.fn(),
    getWalletClient: () => ({ writeContract }),
    getPublicClient: () => ({ waitForTransactionReceipt }),
  }),
}));

function taskFixture(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task-1",
    requesterAddress: REQUESTER_ADDRESS,
    category: "writing",
    title: "写一篇文章",
    description: "desc",
    budget: "1000000000000000000000",
    token: `0x${"1".repeat(40)}` as const,
    deliveryDeadline: "2033-01-01T00:00:00.000Z",
    skillTags: [],
    expertType: "AUTOMATION",
    status: "SUBMITTED",
    fundingTxHash: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    acceptedAgentAddress: AGENT_ADDRESS,
    acceptedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function disputeFixture(
  overrides: Partial<disputesApi.DisputeRecord> = {},
): disputesApi.DisputeRecord {
  return {
    disputeId: "dispute-1",
    status: "OPEN",
    reason: "交付成果不符合要求",
    resolution: null,
    resolvedAt: null,
    evidenceSummary: "详细证据说明",
    evidenceHash: `0x${"9".repeat(64)}` as const,
    ...overrides,
  };
}

beforeEach(() => {
  mockSession = { status: "signed_out", address: undefined };
  mockWalletAddress = REQUESTER_ADDRESS;
  mockIsCorrectNetwork = true;
  writeContract.mockReset();
  waitForTransactionReceipt.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DisputeSection — SUBMITTED", () => {
  it("shows the '发起争议' trigger to the requester when no dispute has been saved yet (404)", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "SUBMITTED" }));
    vi.spyOn(disputesApi, "getDispute").mockRejectedValue(
      new disputesApi.ApiError(404, "该任务尚无争议记录。"),
    );
    render(<DisputeSection taskId="task-1" />);
    expect(await screen.findByRole("button", { name: "发起争议" })).toBeTruthy();
  });

  it("renders nothing for a non-requester", async () => {
    mockSession = { status: "signed_in", address: AGENT_ADDRESS };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "SUBMITTED" }));
    vi.spyOn(disputesApi, "getDispute").mockRejectedValue(
      new disputesApi.ApiError(404, "该任务尚无争议记录。"),
    );
    const { container } = render(<DisputeSection taskId="task-1" />);
    await waitFor(() => expect(tasksApi.getTask).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("renders nothing when signed out (identity cannot be determined without a session)", async () => {
    mockSession = { status: "signed_out", address: undefined };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "SUBMITTED" }));
    vi.spyOn(disputesApi, "getDispute").mockRejectedValue(
      new disputesApi.ApiError(404, "该任务尚无争议记录。"),
    );
    const { container } = render(<DisputeSection taskId="task-1" />);
    await waitFor(() => expect(disputesApi.getDispute).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  // Codex review (T-1007 round 1, P2 — routed to T-1005's own lineage):
  // a non-404 failure fetching the dispute must surface as this
  // component's own error state, never be silently reinterpreted as "no
  // dispute yet".
  it("shows an error (not the blank trigger) when fetching the dispute fails with a non-404 error", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "SUBMITTED" }));
    vi.spyOn(disputesApi, "getDispute").mockRejectedValue(
      new disputesApi.ApiError(500, "服务器错误"),
    );
    render(<DisputeSection taskId="task-1" />);
    expect(await screen.findByText("服务器错误")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "发起争议" })).toBeNull();
  });

  it("opens the ActionSheet with DisputeOpenForm's fields when clicked, and completes the full submit-then-sign-then-verify flow", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    mockWalletAddress = REQUESTER_ADDRESS;
    vi.spyOn(tasksApi, "getTask").mockResolvedValueOnce(taskFixture({ status: "SUBMITTED" }));
    vi.spyOn(disputesApi, "getDispute").mockRejectedValueOnce(
      new disputesApi.ApiError(404, "该任务尚无争议记录。"),
    );
    const evidenceHash = `0x${"7".repeat(64)}` as const;
    vi.spyOn(disputesApi, "submitDispute").mockResolvedValue({
      disputeId: "dispute-1",
      evidenceHash,
    });

    render(<DisputeSection taskId="task-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "发起争议" }));

    const reasonInput = await screen.findByLabelText("争议原因");
    const evidenceInput = screen.getByLabelText("证据说明");
    fireEvent.change(reasonInput, { target: { value: "交付成果不符合要求" } });
    fireEvent.change(evidenceInput, { target: { value: "详细说明" } });

    fireEvent.click(screen.getByRole("button", { name: "保存争议信息" }));
    expect(await screen.findByText(evidenceHash)).toBeTruthy();

    const txHash = `0x${"a".repeat(64)}` as const;
    writeContract.mockResolvedValue(txHash);
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    vi.spyOn(disputesApi, "submitDisputeOpenVerification").mockResolvedValue({
      status: "DISPUTED",
      confirmations: 1,
    });
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "DISPUTED" }));
    vi.spyOn(disputesApi, "getDispute").mockResolvedValue(disputeFixture());

    fireEvent.click(screen.getByRole("button", { name: "提交争议" }));

    expect(await screen.findByText("争议已成功提交上链。")).toBeTruthy();
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "openDispute",
        args: [expect.anything(), evidenceHash],
      }),
    );
  });

  // Codex review (T-1007 round 1, P1 — routed to T-1005's own lineage):
  // a dispute saved off-chain (POST succeeded) but never broadcast
  // on-chain (the user closed the tab / refreshed before signing) must be
  // resumable from the SAME saved evidence hash, not silently discarded.
  describe("resuming a saved-but-not-yet-broadcast dispute", () => {
    const savedEvidenceHash = `0x${"e".repeat(64)}` as const;

    function mockResumableDispute() {
      mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
      mockWalletAddress = REQUESTER_ADDRESS;
      vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "SUBMITTED" }));
      vi.spyOn(disputesApi, "getDispute").mockResolvedValue(
        disputeFixture({ evidenceHash: savedEvidenceHash }),
      );
    }

    it("shows a '继续提交争议' trigger, and re-mounting resumes the SAME saved evidenceHash after a simulated refresh", async () => {
      mockResumableDispute();
      const submitSpy = vi.spyOn(disputesApi, "submitDispute");

      const { unmount } = render(<DisputeSection taskId="task-1" />);
      const resumeButton = await screen.findByRole("button", { name: "继续提交争议" });
      expect(screen.queryByRole("button", { name: "发起争议" })).toBeNull();
      fireEvent.click(resumeButton);
      expect(await screen.findByText(savedEvidenceHash)).toBeTruthy();

      // Simulate a page refresh: unmount and mount a fresh instance —
      // `getDispute` is called again (real behavior on remount), and the
      // SAME evidence hash comes back, not a blank form.
      unmount();
      render(<DisputeSection taskId="task-1" />);
      fireEvent.click(await screen.findByRole("button", { name: "继续提交争议" }));
      expect(await screen.findByText(savedEvidenceHash)).toBeTruthy();
      expect(screen.queryByLabelText("争议原因")).toBeNull();

      // Never re-invoked — resuming never calls submitDispute.
      expect(submitSpy).not.toHaveBeenCalled();
    });

    it("does not call submitDispute again when resuming and proceeding straight to signing", async () => {
      mockResumableDispute();
      const submitSpy = vi.spyOn(disputesApi, "submitDispute");
      const txHash = `0x${"b".repeat(64)}` as const;
      writeContract.mockResolvedValue(txHash);
      waitForTransactionReceipt.mockResolvedValue({ status: "success" });
      vi.spyOn(disputesApi, "submitDisputeOpenVerification").mockResolvedValue({
        status: "DISPUTED",
        confirmations: 1,
      });

      render(<DisputeSection taskId="task-1" />);
      fireEvent.click(await screen.findByRole("button", { name: "继续提交争议" }));
      await screen.findByText(savedEvidenceHash);
      expect(screen.queryByRole("button", { name: "保存争议信息" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "提交争议" }));
      expect(await screen.findByText("争议已成功提交上链。")).toBeTruthy();
      expect(submitSpy).not.toHaveBeenCalled();
    });

    it("completes the real writeContract -> receipt -> backend verification flow using the resumed evidenceHash", async () => {
      mockResumableDispute();
      const txHash = `0x${"c".repeat(64)}` as const;
      writeContract.mockResolvedValue(txHash);
      waitForTransactionReceipt.mockResolvedValue({ status: "success" });
      const verifySpy = vi
        .spyOn(disputesApi, "submitDisputeOpenVerification")
        .mockResolvedValue({ status: "DISPUTED", confirmations: 1 });

      render(<DisputeSection taskId="task-1" />);
      fireEvent.click(await screen.findByRole("button", { name: "继续提交争议" }));
      await screen.findByText(savedEvidenceHash);

      fireEvent.click(screen.getByRole("button", { name: "提交争议" }));

      expect(await screen.findByText("争议已成功提交上链。")).toBeTruthy();
      expect(writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "openDispute",
          args: [expect.anything(), savedEvidenceHash],
        }),
      );
      expect(waitForTransactionReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ hash: txHash }),
      );
      expect(verifySpy).toHaveBeenCalledWith("task-1", txHash);
    });
  });
});

describe("DisputeSection — DISPUTED, requester view", () => {
  it("shows the requester's own reason and a pending message while OPEN", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "DISPUTED" }));
    vi.spyOn(disputesApi, "getDispute").mockResolvedValue(disputeFixture({ status: "OPEN" }));
    render(<DisputeSection taskId="task-1" />);
    expect(await screen.findByText("交付成果不符合要求")).toBeTruthy();
    expect(await screen.findByText("仲裁处理中，请等待裁决结果。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "支持 Agent" })).toBeNull();
  });

  // Codex review (T-1005 round 1, P1): `resolveDispute` moves the task
  // straight from DISPUTED to RELEASED/REFUNDED — this is the REAL state
  // combination the outcome message must survive in, not a dispute stuck
  // at DISPUTED forever (that combination cannot actually persist).
  it("shows the resolution once the task has settled to RELEASED via a dispute", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "RELEASED" }));
    vi.spyOn(disputesApi, "getDispute").mockResolvedValue(
      disputeFixture({
        status: "RESOLVED",
        resolution: "SUPPORT_AGENT",
        resolvedAt: "2026-01-03T00:00:00.000Z",
      }),
    );
    render(<DisputeSection taskId="task-1" />);
    expect(await screen.findByText(/支持 Agent，预算和质押已放款给 Agent/)).toBeTruthy();
  });

  it("renders nothing for RELEASED/REFUNDED reached through ordinary settlement (no dispute ever opened)", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "RELEASED" }));
    vi.spyOn(disputesApi, "getDispute").mockRejectedValue(
      new disputesApi.ApiError(404, "该任务尚无争议记录。"),
    );
    const { container } = render(<DisputeSection taskId="task-1" />);
    await waitFor(() => expect(disputesApi.getDispute).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  // Codex review (T-1007 round 1, P2 — routed to T-1005's own lineage): a
  // non-404 failure must surface as an error, not be silently reinterpreted
  // as "never disputed" — a real 500 could be hiding a real (and possibly
  // still-relevant) arbitration outcome.
  it("shows an error (does not silently disappear) when fetching the dispute for a RELEASED task fails with a non-404 error", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "RELEASED" }));
    vi.spyOn(disputesApi, "getDispute").mockRejectedValue(
      new disputesApi.ApiError(500, "服务器错误"),
    );
    render(<DisputeSection taskId="task-1" />);
    expect(await screen.findByText("服务器错误")).toBeTruthy();
  });
});

describe("DisputeSection — DISPUTED, arbitration view", () => {
  function mockDisputedArbitration() {
    mockSession = { status: "signed_in", address: ARBITRATOR_ADDRESS };
    mockWalletAddress = ARBITRATOR_ADDRESS;
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "DISPUTED" }));
    vi.spyOn(disputesApi, "getDispute").mockResolvedValue(disputeFixture());
  }

  it("shows the evidence and both resolve buttons to a non-requester signed-in viewer", async () => {
    mockDisputedArbitration();
    render(<DisputeSection taskId="task-1" />);
    expect(await screen.findByText("详细证据说明")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "支持 Agent" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "支持需求方" })).toBeTruthy();
  });

  it("requires a second confirm click before firing resolveDispute(true)", async () => {
    const onTaskChanged = vi.fn();
    mockDisputedArbitration();
    const txHash = `0x${"b".repeat(64)}` as const;
    writeContract.mockResolvedValue(txHash);
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    vi.spyOn(disputesApi, "submitDisputeResolveVerification").mockResolvedValue({
      status: "RELEASED",
      confirmations: 1,
    });

    render(<DisputeSection taskId="task-1" onTaskChanged={onTaskChanged} />);
    fireEvent.click(await screen.findByRole("button", { name: "支持 Agent" }));
    expect(writeContract).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: "确认支持 Agent？" }));
    await waitFor(() =>
      expect(writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "resolveDispute",
          args: [expect.anything(), true],
        }),
      ),
    );
    expect(await screen.findByText("仲裁已裁决：支持 Agent。")).toBeTruthy();
    expect(onTaskChanged).toHaveBeenCalledTimes(1);
  });

  // Mirrors T-1004's own mutual-exclusion regression suite: resolveDispute
  // is a one-shot, mutually exclusive terminal call, so starting one
  // resolve action must block the other while genuinely in flight, but
  // must NOT block it after a failed signature or a confirmed revert (both
  // of which can never succeed).
  it("disables the '支持需求方' button while '支持 Agent' is genuinely in flight", async () => {
    mockDisputedArbitration();
    let resolveWrite: (hash: `0x${string}`) => void = () => {};
    writeContract.mockImplementationOnce(
      () => new Promise<`0x${string}`>((resolve) => (resolveWrite = resolve)),
    );

    render(<DisputeSection taskId="task-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "支持 Agent" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认支持 Agent？" }));

    const supportRequesterButton = await screen.findByRole("button", { name: "支持需求方" });
    await waitFor(() => expect(supportRequesterButton.hasAttribute("disabled")).toBe(true));

    resolveWrite(`0x${"c".repeat(64)}` as const);
  });

  it("re-enables the '支持需求方' button after '支持 Agent' fails to sign", async () => {
    mockDisputedArbitration();
    writeContract.mockRejectedValueOnce(new Error("user rejected the request"));

    render(<DisputeSection taskId="task-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "支持 Agent" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认支持 Agent？" }));

    const supportRequesterButton = await screen.findByRole("button", { name: "支持需求方" });
    await waitFor(() => expect(supportRequesterButton.hasAttribute("disabled")).toBe(false));
  });

  it("re-enables the '支持需求方' button once '支持 Agent' is confirmed reverted on-chain", async () => {
    mockDisputedArbitration();
    const revertedHash = `0x${"d".repeat(64)}` as const;
    writeContract.mockResolvedValueOnce(revertedHash);
    waitForTransactionReceipt.mockResolvedValueOnce({ status: "reverted" });

    render(<DisputeSection taskId="task-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "支持 Agent" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认支持 Agent？" }));

    const supportRequesterButton = await screen.findByRole("button", { name: "支持需求方" });
    await waitFor(() => expect(supportRequesterButton.hasAttribute("disabled")).toBe(false));
  });

  it("keeps '支持需求方' disabled during an ORDINARY rpcRecoveryPending on '支持 Agent' (outcome still unknown)", async () => {
    mockDisputedArbitration();
    const pendingHash = `0x${"e".repeat(64)}` as const;
    writeContract.mockResolvedValueOnce(pendingHash);
    waitForTransactionReceipt.mockRejectedValueOnce(new Error("RPC timeout"));

    render(<DisputeSection taskId="task-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "支持 Agent" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认支持 Agent？" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "重试" })).toBeTruthy());
    const supportRequesterButton = screen.getByRole("button", { name: "支持需求方" });
    expect(supportRequesterButton.hasAttribute("disabled")).toBe(true);
  });

  it("does not show resolve buttons once RESOLVED", async () => {
    mockDisputedArbitration();
    vi.spyOn(disputesApi, "getDispute").mockResolvedValue(
      disputeFixture({
        status: "RESOLVED",
        resolution: "SUPPORT_REQUESTER",
        resolvedAt: "2026-01-03T00:00:00.000Z",
      }),
    );
    render(<DisputeSection taskId="task-1" />);
    expect(await screen.findByText("仲裁已裁决：支持需求方。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "支持 Agent" })).toBeNull();
  });

  // Codex review (T-1005 round 1, P1): the REAL persisted state once
  // `resolveDispute` confirms is task.status RELEASED/REFUNDED, not a
  // dispute stuck at DISPUTED forever — the arbitration outcome must
  // survive that transition too, still with no resolve buttons.
  it("shows the outcome and no resolve buttons once the task has settled to REFUNDED via a dispute", async () => {
    mockSession = { status: "signed_in", address: ARBITRATOR_ADDRESS };
    mockWalletAddress = ARBITRATOR_ADDRESS;
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "REFUNDED" }));
    vi.spyOn(disputesApi, "getDispute").mockResolvedValue(
      disputeFixture({
        status: "RESOLVED",
        resolution: "SUPPORT_REQUESTER",
        resolvedAt: "2026-01-03T00:00:00.000Z",
      }),
    );
    render(<DisputeSection taskId="task-1" />);
    expect(await screen.findByText("仲裁已裁决：支持需求方。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "支持 Agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "支持需求方" })).toBeNull();
  });
});
