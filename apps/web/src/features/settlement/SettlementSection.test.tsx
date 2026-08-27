import type { ChainConfig } from "@agent-market/domain";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettlementSection } from "./SettlementSection.js";
import * as tasksApi from "../tasks/api.js";
import type { TaskRecord } from "../tasks/api.js";
import * as deliverablesApi from "../deliverables/api.js";
import { ApiError as DeliverablesApiError } from "../deliverables/api.js";
import * as ratingsApi from "../ratings/api.js";
import { ApiError as RatingsApiError } from "../ratings/api.js";

const REQUESTER_ADDRESS = "0x1234567890123456789012345678901234567890" as const;
const AGENT_ADDRESS = "0x9999999999999999999999999999999999999999" as const;

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
    status: "ACCEPTED",
    fundingTxHash: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    acceptedAgentAddress: AGENT_ADDRESS,
    acceptedAt: "2026-01-02T00:00:00.000Z",
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

describe("SettlementSection — ACCEPTED", () => {
  it("shows the delivery deadline and no claim button before it has passed, even for the requester", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(
      taskFixture({ status: "ACCEPTED", deliveryDeadline: "2099-01-01T00:00:00.000Z" }),
    );
    render(<SettlementSection taskId="task-1" />);
    expect(await screen.findByText("尚未到交付截止时间，暂不可申领超时退款。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "取回预算和质押" })).toBeNull();
  });

  it("does not show the claim button to a non-requester even after the deadline has passed", async () => {
    mockSession = { status: "signed_in", address: AGENT_ADDRESS };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(
      taskFixture({ status: "ACCEPTED", deliveryDeadline: "2000-01-01T00:00:00.000Z" }),
    );
    render(<SettlementSection taskId="task-1" />);
    expect(await screen.findByText("等待 Agent 交付成果。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "取回预算和质押" })).toBeNull();
  });

  it("shows the claim button to the requester once the deadline has passed, disabled on a wallet/requester mismatch", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    mockWalletAddress = AGENT_ADDRESS; // connected wallet != requester
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(
      taskFixture({ status: "ACCEPTED", deliveryDeadline: "2000-01-01T00:00:00.000Z" }),
    );
    render(<SettlementSection taskId="task-1" />);
    const button = await screen.findByRole("button", { name: "取回预算和质押" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(await screen.findByText(/当前连接的钱包地址与需求方不匹配/)).toBeTruthy();
  });

  it("submits claimDeliveryTimeout and shows the success message once confirmed", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    mockWalletAddress = REQUESTER_ADDRESS;
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(
      taskFixture({ status: "ACCEPTED", deliveryDeadline: "2000-01-01T00:00:00.000Z" }),
    );
    const txHash = `0x${"a".repeat(64)}` as const;
    writeContract.mockResolvedValue(txHash);
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    vi.spyOn(tasksApi, "submitSettlementVerification").mockResolvedValue({
      status: "REFUNDED",
      confirmations: 1,
    });

    render(<SettlementSection taskId="task-1" />);
    const button = await screen.findByRole("button", { name: "取回预算和质押" });
    fireEvent.click(button);

    expect(await screen.findByText("已成功取回预算和质押。")).toBeTruthy();
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "claimDeliveryTimeout" }),
    );
  });

  // Codex review (T-1004 round 1, P1): a `failed`/`rpcRecoveryPending`
  // flow used to leave the button permanently disabled with no way to
  // recover. These two tests prove the retry control actually appears and
  // works for both recoverable states.
  it("offers a retry button after a failed signature, and re-broadcasts on click", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    mockWalletAddress = REQUESTER_ADDRESS;
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(
      taskFixture({ status: "ACCEPTED", deliveryDeadline: "2000-01-01T00:00:00.000Z" }),
    );
    writeContract.mockRejectedValueOnce(new Error("user rejected the request"));
    render(<SettlementSection taskId="task-1" />);
    const startButton = await screen.findByRole("button", { name: "取回预算和质押" });
    fireEvent.click(startButton);

    const retryButton = await screen.findByRole("button", { name: "重试" });
    expect(retryButton.hasAttribute("disabled")).toBe(false);

    const txHash = `0x${"a".repeat(64)}` as const;
    writeContract.mockResolvedValueOnce(txHash);
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    vi.spyOn(tasksApi, "submitSettlementVerification").mockResolvedValue({
      status: "REFUNDED",
      confirmations: 1,
    });
    fireEvent.click(retryButton);

    expect(await screen.findByText("已成功取回预算和质押。")).toBeTruthy();
  });

  it("offers a retry button after a transient verification failure (rpcRecoveryPending), enabled even without a wallet/network gate re-check", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    mockWalletAddress = REQUESTER_ADDRESS;
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(
      taskFixture({ status: "ACCEPTED", deliveryDeadline: "2000-01-01T00:00:00.000Z" }),
    );
    const txHash = `0x${"a".repeat(64)}` as const;
    writeContract.mockResolvedValue(txHash);
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    vi.spyOn(tasksApi, "submitSettlementVerification").mockRejectedValueOnce(
      new Error("network error"),
    );

    render(<SettlementSection taskId="task-1" />);
    const startButton = await screen.findByRole("button", { name: "取回预算和质押" });
    fireEvent.click(startButton);

    const retryButton = await screen.findByRole("button", { name: "重试" });
    expect(retryButton.hasAttribute("disabled")).toBe(false);

    vi.spyOn(tasksApi, "submitSettlementVerification").mockResolvedValue({
      status: "REFUNDED",
      confirmations: 1,
    });
    fireEvent.click(retryButton);

    expect(await screen.findByText("已成功取回预算和质押。")).toBeTruthy();
  });

  // Codex review (T-1004 round 2, P1): a genuinely reverted receipt used
  // to leave "重试" stuck re-polling the same dead hash forever (retry()
  // on rpcRecoveryPending never re-signs). This proves retry now
  // re-broadcasts a FRESH transaction for a known-reverted hash instead.
  it("re-broadcasts a fresh transaction on retry after a definitive on-chain revert, rather than re-polling the dead hash", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    mockWalletAddress = REQUESTER_ADDRESS;
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(
      taskFixture({ status: "ACCEPTED", deliveryDeadline: "2000-01-01T00:00:00.000Z" }),
    );
    const revertedHash = `0x${"c".repeat(64)}` as const;
    writeContract.mockResolvedValueOnce(revertedHash);
    waitForTransactionReceipt.mockResolvedValueOnce({ status: "reverted" });

    render(<SettlementSection taskId="task-1" />);
    const startButton = await screen.findByRole("button", { name: "取回预算和质押" });
    fireEvent.click(startButton);

    const retryButton = await screen.findByRole("button", { name: "重试" });

    const freshHash = `0x${"d".repeat(64)}` as const;
    writeContract.mockResolvedValueOnce(freshHash);
    waitForTransactionReceipt.mockResolvedValueOnce({ status: "success" });
    vi.spyOn(tasksApi, "submitSettlementVerification").mockResolvedValue({
      status: "REFUNDED",
      confirmations: 1,
    });
    fireEvent.click(retryButton);

    expect(await screen.findByText("已成功取回预算和质押。")).toBeTruthy();
    // A fresh broadcast happened (writeContract called a second time) —
    // proving retry() did NOT just re-poll `revertedHash`.
    expect(writeContract).toHaveBeenCalledTimes(2);
  });
});

describe("SettlementSection — SUBMITTED", () => {
  function mockSubmitted(reviewDeadline: string) {
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "SUBMITTED" }));
    vi.spyOn(deliverablesApi, "getLatestDeliverable").mockResolvedValue({
      deliverableId: "d-1",
      resultHash: `0x${"b".repeat(64)}` as const,
      submittedAt: "2026-01-01T00:00:00.000Z",
      reviewDeadline,
      resultUrl: "https://example.com/result",
    });
  }

  it("shows the approve button to the requester at any time before the review deadline", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    mockSubmitted("2099-01-01T00:00:00.000Z");
    render(<SettlementSection taskId="task-1" />);
    expect(await screen.findByRole("button", { name: "验收并放款" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "放款给 Agent" })).toBeNull();
  });

  it("does not show the approve button to a non-requester", async () => {
    mockSession = { status: "signed_in", address: AGENT_ADDRESS };
    mockSubmitted("2099-01-01T00:00:00.000Z");
    render(<SettlementSection taskId="task-1" />);
    await screen.findByText("等待需求方验收，或等待验收窗口到期。");
    expect(screen.queryByRole("button", { name: "验收并放款" })).toBeNull();
  });

  it("shows the permissionless finalize button to any SIGNED-IN wallet once the review deadline has passed — not gated on requester identity", async () => {
    // Signed in as the Agent (not the requester) — proves the button is
    // NOT gated on requester identity, only on being signed in at all
    // (T-1004 round 1 P1 fix: the on-chain call is permissionless, but
    // `POST /tasks/:taskId/settlement-verifications` still requires a
    // session, so a signed-OUT wallet must not see this as enabled).
    mockSession = { status: "signed_in", address: AGENT_ADDRESS };
    mockWalletAddress = AGENT_ADDRESS;
    mockSubmitted("2000-01-01T00:00:00.000Z");
    render(<SettlementSection taskId="task-1" />);
    const button = await screen.findByRole("button", { name: "放款给 Agent" });
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("disables the finalize button and warns when signed out, even after the review deadline has passed (T-1004 round 1 P1 fix: backend verification requires a session)", async () => {
    mockSession = { status: "signed_out", address: undefined };
    mockWalletAddress = AGENT_ADDRESS;
    mockSubmitted("2000-01-01T00:00:00.000Z");
    render(<SettlementSection taskId="task-1" />);
    const button = await screen.findByRole("button", { name: "放款给 Agent" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(await screen.findByText(/请先登录/)).toBeTruthy();
  });

  it("still shows the approve button to the requester even after the review deadline has passed (both paths valid until one settles)", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    mockWalletAddress = REQUESTER_ADDRESS;
    mockSubmitted("2000-01-01T00:00:00.000Z");
    render(<SettlementSection taskId="task-1" />);
    expect(await screen.findByRole("button", { name: "验收并放款" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "放款给 Agent" })).toBeTruthy();
  });

  it("falls back gracefully (finalize button absent, approve still available) when the deliverable fetch fails", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "SUBMITTED" }));
    vi.spyOn(deliverablesApi, "getLatestDeliverable").mockRejectedValue(
      new DeliverablesApiError(500, "服务器错误"),
    );
    render(<SettlementSection taskId="task-1" />);
    expect(await screen.findByRole("button", { name: "验收并放款" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "放款给 Agent" })).toBeNull();
  });

  // Codex review (T-1004 round 2, P2): approveResult and
  // finalizeReviewTimeout are mutually exclusive terminal transactions for
  // the same task — signing both would waste gas on a guaranteed revert.
  // Starting one must disable the other while it is in flight.
  it("disables the finalize button while the approve transaction is in flight, and vice versa", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    mockWalletAddress = REQUESTER_ADDRESS;
    mockSubmitted("2000-01-01T00:00:00.000Z");
    // A never-resolving writeContract keeps approveFlow parked in
    // `awaitingSignature` (never idle), so the finalize button's own
    // "other flow busy" gate stays observably engaged.
    let resolveWrite: (hash: `0x${string}`) => void = () => {};
    writeContract.mockImplementationOnce(
      () => new Promise<`0x${string}`>((resolve) => (resolveWrite = resolve)),
    );

    render(<SettlementSection taskId="task-1" />);
    const approveButton = await screen.findByRole("button", { name: "验收并放款" });
    const finalizeButton = await screen.findByRole("button", { name: "放款给 Agent" });
    expect(finalizeButton.hasAttribute("disabled")).toBe(false);

    fireEvent.click(approveButton);
    await waitFor(() => expect(finalizeButton.hasAttribute("disabled")).toBe(true));

    // Cleanup: let the pending promise resolve so it doesn't leak into the
    // next test.
    resolveWrite(`0x${"e".repeat(64)}` as const);
  });

  // Codex human review (T-1004 round 3, P2): round 2's mutex fix used a
  // blanket `flow.status.kind !== "idle"`, which over-blocked `failed` and
  // "known-reverted rpcRecoveryPending" — neither can ever still succeed,
  // so neither should block the other settlement action. These four tests
  // prove the corrected, centrally-defined rule (`flowBlocksOtherSettlementAction`).
  it("re-enables the finalize button after the approve signature is rejected (failed), and finalize actually succeeds", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    mockWalletAddress = REQUESTER_ADDRESS;
    mockSubmitted("2000-01-01T00:00:00.000Z");
    writeContract.mockRejectedValueOnce(new Error("user rejected the request"));

    render(<SettlementSection taskId="task-1" />);
    const approveButton = await screen.findByRole("button", { name: "验收并放款" });
    const finalizeButton = await screen.findByRole("button", { name: "放款给 Agent" });
    fireEvent.click(approveButton);

    // approveFlow is now `failed` — finalize must be usable again.
    await waitFor(() => expect(finalizeButton.hasAttribute("disabled")).toBe(false));

    const txHash = `0x${"f".repeat(64)}` as const;
    writeContract.mockResolvedValueOnce(txHash);
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    vi.spyOn(tasksApi, "submitSettlementVerification").mockResolvedValue({
      status: "RELEASED",
      confirmations: 1,
    });
    fireEvent.click(finalizeButton);

    expect(await screen.findByText("验收已完成，任务已结算。")).toBeTruthy();
  });

  it("re-enables the finalize button once the approve transaction is confirmed reverted on-chain", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    mockWalletAddress = REQUESTER_ADDRESS;
    mockSubmitted("2000-01-01T00:00:00.000Z");
    const revertedHash = `0x${"1".repeat(64)}` as const;
    writeContract.mockResolvedValueOnce(revertedHash);
    waitForTransactionReceipt.mockResolvedValueOnce({ status: "reverted" });

    render(<SettlementSection taskId="task-1" />);
    const approveButton = await screen.findByRole("button", { name: "验收并放款" });
    const finalizeButton = await screen.findByRole("button", { name: "放款给 Agent" });
    fireEvent.click(approveButton);

    // approveFlow is now `rpcRecoveryPending`, but the hash is KNOWN
    // reverted — finalize must not stay blocked on it.
    await waitFor(() => expect(finalizeButton.hasAttribute("disabled")).toBe(false));
  });

  it("keeps the finalize button disabled during an ORDINARY rpcRecoveryPending on approve (broadcast outcome still unknown)", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    mockWalletAddress = REQUESTER_ADDRESS;
    mockSubmitted("2000-01-01T00:00:00.000Z");
    const pendingHash = `0x${"2".repeat(64)}` as const;
    writeContract.mockResolvedValueOnce(pendingHash);
    // Receipt fetch itself fails (transient RPC issue) — NOT a reverted
    // receipt, so the broadcast transaction's real outcome is still
    // unknown and could yet succeed.
    waitForTransactionReceipt.mockRejectedValueOnce(new Error("RPC timeout"));

    render(<SettlementSection taskId="task-1" />);
    const approveButton = await screen.findByRole("button", { name: "验收并放款" });
    const finalizeButton = await screen.findByRole("button", { name: "放款给 Agent" });
    fireEvent.click(approveButton);

    await waitFor(() => expect(screen.getByRole("button", { name: "重试" })).toBeTruthy());
    expect(finalizeButton.hasAttribute("disabled")).toBe(true);
  });

  it("symmetrically disables the approve button while the finalize transaction is genuinely in flight", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    mockWalletAddress = REQUESTER_ADDRESS;
    mockSubmitted("2000-01-01T00:00:00.000Z");
    let resolveWrite: (hash: `0x${string}`) => void = () => {};
    writeContract.mockImplementationOnce(
      () => new Promise<`0x${string}`>((resolve) => (resolveWrite = resolve)),
    );

    render(<SettlementSection taskId="task-1" />);
    const approveButton = await screen.findByRole("button", { name: "验收并放款" });
    const finalizeButton = await screen.findByRole("button", { name: "放款给 Agent" });
    expect(approveButton.hasAttribute("disabled")).toBe(false);

    fireEvent.click(finalizeButton);
    await waitFor(() => expect(approveButton.hasAttribute("disabled")).toBe(true));

    resolveWrite(`0x${"3".repeat(64)}` as const);
  });
});

describe("SettlementSection — RELEASED/REFUNDED", () => {
  it("shows the RELEASED outcome message", async () => {
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "RELEASED" }));
    vi.spyOn(ratingsApi, "getRating").mockRejectedValue(
      new RatingsApiError(404, "该任务尚无评分记录。"),
    );
    render(<SettlementSection taskId="task-1" />);
    expect(await screen.findByText("任务已结算：预算与质押已支付给 Agent。")).toBeTruthy();
  });

  it("shows the REFUNDED outcome message", async () => {
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "REFUNDED" }));
    vi.spyOn(ratingsApi, "getRating").mockRejectedValue(
      new RatingsApiError(404, "该任务尚无评分记录。"),
    );
    render(<SettlementSection taskId="task-1" />);
    expect(await screen.findByText("任务已结算：预算与质押已退还给需求方。")).toBeTruthy();
  });

  // T-1006: RatingSection now mounts alongside the outcome message.
  it("mounts RatingSection alongside the outcome message, showing the submission form to the requester when unrated", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "RELEASED" }));
    vi.spyOn(ratingsApi, "getRating").mockRejectedValue(
      new RatingsApiError(404, "该任务尚无评分记录。"),
    );
    render(<SettlementSection taskId="task-1" />);
    expect(await screen.findByRole("button", { name: "5" })).toBeTruthy();
  });
});

describe("SettlementSection — network gate", () => {
  it("disables the claim button and warns when the wallet is on the wrong network", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    mockWalletAddress = REQUESTER_ADDRESS;
    mockIsCorrectNetwork = false;
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(
      taskFixture({ status: "ACCEPTED", deliveryDeadline: "2000-01-01T00:00:00.000Z" }),
    );
    render(<SettlementSection taskId="task-1" />);
    const button = await screen.findByRole("button", { name: "取回预算和质押" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(await screen.findByText(/当前网络不正确/)).toBeTruthy();
  });
});
