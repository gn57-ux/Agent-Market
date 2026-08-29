import type { ChainConfig } from "@agent-market/domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubmissionSection } from "./SubmissionSection.js";
import * as deliverablesApi from "./api.js";
import { ApiError as DeliverablesApiError } from "./api.js";
import { apiBaseUrl } from "../../shared/api/client.js";
import * as tasksApi from "../tasks/api.js";
import type { TaskRecord } from "../tasks/api.js";

const AGENT_ADDRESS = "0x9999999999999999999999999999999999999999" as const;
const REQUESTER_ADDRESS = "0x1234567890123456789012345678901234567890" as const;

let mockSession: {
  status: "signed_out" | "signed_in";
  address: string | undefined;
} = { status: "signed_in", address: AGENT_ADDRESS };

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
let mockWalletAddress: string | undefined = AGENT_ADDRESS;

vi.mock("../wallet/WalletProvider.js", () => ({
  useWallet: () => ({
    connection: { status: "connected", address: mockWalletAddress, chainId: CHAIN_CONFIG.chainId },
    address: mockWalletAddress,
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

const NOT_SUBMITTED_YET = new DeliverablesApiError(404, "该任务尚无成果提交记录。");

beforeEach(() => {
  mockSession = { status: "signed_in", address: AGENT_ADDRESS };
  mockWalletAddress = AGENT_ADDRESS;
  writeContract.mockReset();
  waitForTransactionReceipt.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SubmissionSection", () => {
  it("shows the read-only view (no upload form) for the requester, even while ACCEPTED", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
    vi.spyOn(deliverablesApi, "getLatestDeliverable").mockRejectedValue(NOT_SUBMITTED_YET);

    render(<SubmissionSection taskId="task-1" />);

    expect(await screen.findByText("成果提交")).toBeTruthy();
    expect(await screen.findByText("该任务尚无成果提交记录。")).toBeTruthy();
    expect(screen.queryByText("计算成果哈希")).toBeNull();
  });

  it("shows the read-only view for the accepted Agent once the task has reached SUBMITTED", async () => {
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "SUBMITTED" }));
    vi.spyOn(deliverablesApi, "getLatestDeliverable").mockResolvedValue({
      deliverableId: "d-1",
      resultHash: `0x${"a".repeat(64)}`,
      fileMeta: { mimeType: "application/pdf", sizeBytes: 1024 },
      submittedAt: "2026-01-03T00:00:00.000Z",
      reviewDeadline: "2026-01-10T00:00:00.000Z",
    });

    render(<SubmissionSection taskId="task-1" />);

    expect(await screen.findByText(`0x${"a".repeat(64)}`)).toBeTruthy();
    expect(screen.getByText(/application\/pdf/)).toBeTruthy();
    expect(screen.queryByText("计算成果哈希")).toBeNull();
  });

  it("shows the upload form for the accepted Agent while the task is still ACCEPTED", async () => {
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
    vi.spyOn(deliverablesApi, "getLatestDeliverable").mockRejectedValue(NOT_SUBMITTED_YET);

    render(<SubmissionSection taskId="task-1" />);

    expect(await screen.findByText("计算成果哈希")).toBeTruthy();
    // The submit button only appears once a hash has actually been
    // computed — proves the flow doesn't let a wallet transaction start
    // before F-903's preview step happened.
    expect(screen.queryByRole("button", { name: "提交成果" })).toBeNull();
  });

  it("computes the hash via the backend (F-901), previews it verbatim (F-903), then drives submitResult end to end", async () => {
    const onSubmitted = vi.fn();
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
    vi.spyOn(deliverablesApi, "getLatestDeliverable").mockRejectedValue(NOT_SUBMITTED_YET);
    const resultHash = `0x${"b".repeat(64)}` as const;
    const uploadSpy = vi.spyOn(deliverablesApi, "uploadDeliverableFile").mockResolvedValue({
      deliverableId: "d-2",
      resultHash,
      storedAt: "2026-01-03T00:00:00.000Z",
    });
    const txHash = `0x${"c".repeat(64)}` as const;
    writeContract.mockResolvedValue(txHash);
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    const verifySpy = vi
      .spyOn(deliverablesApi, "submitResultVerification")
      .mockResolvedValue({ status: "SUBMITTED", confirmations: 1 });

    render(<SubmissionSection taskId="task-1" onSubmitted={onSubmitted} />);

    const file = new File(["hello"], "result.txt", { type: "text/plain" });
    const input = await screen.findByLabelText("上传成果文件");
    fireEvent.change(input, { target: { files: [file] } });

    const computeButton = await screen.findByRole("button", { name: "计算成果哈希" });
    fireEvent.click(computeButton);

    // F-903: the exact backend-returned hash, never recomputed client-side.
    await screen.findByText(resultHash);
    expect(uploadSpy).toHaveBeenCalledWith("task-1", file);

    const submitButton = await screen.findByRole("button", { name: "提交成果" });
    await waitFor(() => expect(submitButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(submitButton);

    await waitFor(() => expect(screen.getByText("成果已提交上链。")).toBeTruthy());
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: CHAIN_CONFIG.addresses.taskEscrow,
        functionName: "submitResult",
        args: [expect.any(String), resultHash],
      }),
    );
    expect(verifySpy).toHaveBeenCalledWith("task-1", txHash);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it("warns and disables submission when the connected wallet doesn't match the accepted Agent's address", async () => {
    mockWalletAddress = "0x1111111111111111111111111111111111111111";
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
    vi.spyOn(deliverablesApi, "getLatestDeliverable").mockRejectedValue(NOT_SUBMITTED_YET);
    vi.spyOn(deliverablesApi, "uploadDeliverableFile").mockResolvedValue({
      deliverableId: "d-3",
      resultHash: `0x${"d".repeat(64)}`,
      storedAt: "2026-01-03T00:00:00.000Z",
    });

    render(<SubmissionSection taskId="task-1" />);

    const file = new File(["hello"], "result.txt", { type: "text/plain" });
    const input = await screen.findByLabelText("上传成果文件");
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(await screen.findByRole("button", { name: "计算成果哈希" }));

    const submitButton = await screen.findByRole("button", { name: "提交成果" });
    expect(await screen.findByText(/当前连接的钱包地址与接单 Agent 不匹配/)).toBeTruthy();
    expect(submitButton.hasAttribute("disabled")).toBe(true);
    expect(writeContract).not.toHaveBeenCalled();
  });

  // N4 round 1 P2 (Codex): a stale, still-in-flight `uploadDeliverableFile`
  // response must not resurrect as `persisted` once the user has already
  // switched away to the URL input mode — that would let a PREVIOUSLY
  // selected file's hash get submitted for what now looks like a URL
  // submission, or vice versa. Uses a manually-controlled promise to force
  // the exact interleaving: persist starts, mode switches before it
  // resolves, THEN it resolves.
  it("ignores a stale in-flight file-upload response once the input mode has already switched to URL", async () => {
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
    vi.spyOn(deliverablesApi, "getLatestDeliverable").mockRejectedValue(NOT_SUBMITTED_YET);
    const staleHash = `0x${"e".repeat(64)}` as const;
    let resolveUpload: ((result: deliverablesApi.DeliverableSubmissionResult) => void) | undefined;
    vi.spyOn(deliverablesApi, "uploadDeliverableFile").mockReturnValue(
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );

    render(<SubmissionSection taskId="task-1" />);

    const file = new File(["hello"], "result.txt", { type: "text/plain" });
    const input = await screen.findByLabelText("上传成果文件");
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(await screen.findByRole("button", { name: "计算成果哈希" }));
    await screen.findByText("保存中…");

    // Abandon the in-flight file upload by switching to URL mode BEFORE it
    // resolves — this must invalidate the pending request.
    fireEvent.click(screen.getByRole("radio", { name: "填写成果 URL" }));

    resolveUpload?.({
      deliverableId: "d-stale",
      resultHash: staleHash,
      storedAt: "2026-01-03T00:00:00.000Z",
    });

    // Give the resolved (but now-stale) promise a chance to run its .then
    // handler — it must be a no-op, never showing the stale hash.
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());
    expect(screen.queryByText(staleHash)).toBeNull();
    expect(screen.queryByText("提交成果")).toBeNull();
  });

  // N4 round 2 P1 (Codex): a `failed` retry re-broadcasts (re-runs
  // `buildSubmitResultTx`) — if the wallet account switched to a mismatched
  // one AFTER the first attempt failed (for an unrelated reason), retry
  // must not be allowed to sign/broadcast under that wrong account.
  it("disables 重试提交 and does not re-broadcast once the wallet no longer matches the accepted Agent after a failed attempt", async () => {
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
    vi.spyOn(deliverablesApi, "getLatestDeliverable").mockRejectedValue(NOT_SUBMITTED_YET);
    vi.spyOn(deliverablesApi, "uploadDeliverableFile").mockResolvedValue({
      deliverableId: "d-4",
      resultHash: `0x${"1".repeat(64)}`,
      storedAt: "2026-01-03T00:00:00.000Z",
    });
    writeContract.mockRejectedValueOnce(new Error("user rejected the request"));

    const { rerender } = render(<SubmissionSection taskId="task-1" />);

    const file = new File(["hello"], "result.txt", { type: "text/plain" });
    const input = await screen.findByLabelText("上传成果文件");
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(await screen.findByRole("button", { name: "计算成果哈希" }));
    const submitButton = await screen.findByRole("button", { name: "提交成果" });
    await waitFor(() => expect(submitButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(submitButton);

    const retryButton = await screen.findByRole("button", { name: "重试提交" });
    // Wallet still matches at this point — the first failure was unrelated
    // (a rejected signature), so retry should currently be allowed.
    expect(retryButton.hasAttribute("disabled")).toBe(false);

    // The wallet account switches to one that no longer matches the
    // accepted Agent's address — re-render to reflect the new `useWallet()`
    // value, same as a real MetaMask account-switch event would.
    mockWalletAddress = "0x1111111111111111111111111111111111111111";
    rerender(<SubmissionSection taskId="task-1" />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "重试提交" }).hasAttribute("disabled")).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "重试提交" }));
    // Still only the one (rejected) call from the first attempt — the
    // blocked retry must never have reached `writeContract` again.
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  // N4 round 2 P2 (Codex): "重新选择" must not be clickable while a
  // transaction is genuinely in flight (here: `rpcRecoveryPending`, an
  // already-broadcast tx whose confirmation failed) — clicking it would
  // wipe `persistState` back to `idle`, hiding the only remaining way to
  // `retry()` that broadcast transaction.
  it("disables 重新选择 while the submit transaction is rpcRecoveryPending", async () => {
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
    vi.spyOn(deliverablesApi, "getLatestDeliverable").mockRejectedValue(NOT_SUBMITTED_YET);
    vi.spyOn(deliverablesApi, "uploadDeliverableFile").mockResolvedValue({
      deliverableId: "d-5",
      resultHash: `0x${"2".repeat(64)}`,
      storedAt: "2026-01-03T00:00:00.000Z",
    });
    writeContract.mockResolvedValue(`0x${"3".repeat(64)}`);
    // Broadcast succeeds, but confirmation itself fails — this is exactly
    // how `useTransactionFlow` reaches `rpcRecoveryPending`.
    waitForTransactionReceipt.mockRejectedValue(new Error("RPC timed out"));

    render(<SubmissionSection taskId="task-1" />);

    const file = new File(["hello"], "result.txt", { type: "text/plain" });
    const input = await screen.findByLabelText("上传成果文件");
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(await screen.findByRole("button", { name: "计算成果哈希" }));
    const submitButton = await screen.findByRole("button", { name: "提交成果" });
    await waitFor(() => expect(submitButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(submitButton);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "重新选择" }).hasAttribute("disabled")).toBe(true),
    );
    // The retry control for the already-broadcast transaction must still
    // be visible — proving `persistState` was never wiped out from under it.
    expect(screen.getByRole("button", { name: "重试提交" })).toBeTruthy();
  });

  // Human N4 follow-up (round 3, pure human review — round cap already
  // exhausted): round 2's fix only gated the "重新选择" BUTTON, leaving the
  // two input-mode radios — which call the exact same `resetPersistState`
  // via their own `onChange` — as a live bypass. This proves the radios
  // themselves are now blocked while `rpcRecoveryPending`: mode must not
  // switch, the staged hash and the transaction status/retry control must
  // all survive the click untouched.
  it("does not switch input mode or clear the staged result when a radio is clicked while rpcRecoveryPending (round 3 bypass fix)", async () => {
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
    vi.spyOn(deliverablesApi, "getLatestDeliverable").mockRejectedValue(NOT_SUBMITTED_YET);
    const resultHash = `0x${"4".repeat(64)}` as const;
    vi.spyOn(deliverablesApi, "uploadDeliverableFile").mockResolvedValue({
      deliverableId: "d-6",
      resultHash,
      storedAt: "2026-01-03T00:00:00.000Z",
    });
    writeContract.mockResolvedValue(`0x${"5".repeat(64)}`);
    waitForTransactionReceipt.mockRejectedValue(new Error("RPC timed out"));

    render(<SubmissionSection taskId="task-1" />);

    const file = new File(["hello"], "result.txt", { type: "text/plain" });
    const input = await screen.findByLabelText("上传成果文件");
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(await screen.findByRole("button", { name: "计算成果哈希" }));
    const submitButton = await screen.findByRole("button", { name: "提交成果" });
    await waitFor(() => expect(submitButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(submitButton);
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "上传文件" }).hasAttribute("disabled")).toBe(true),
    );

    const urlRadio = screen.getByRole("radio", { name: "填写成果 URL" });
    fireEvent.click(urlRadio);

    // Mode never actually switched — no URL textbox appeared, and the file
    // radio is still the checked one.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect((screen.getByRole("radio", { name: "上传文件" }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((urlRadio as HTMLInputElement).checked).toBe(false);
    // The staged hash and the recoverable transaction's own controls must
    // all have survived the click untouched.
    expect(screen.getByText(resultHash)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试提交" })).toBeTruthy();
  });

  // Requirement #5: `failed` (nothing broadcast yet — the signature/
  // broadcast itself never succeeded) must still allow resetting via a
  // radio click, unlike `rpcRecoveryPending` above.
  it("still allows switching input mode via a radio click while failed (nothing broadcast yet)", async () => {
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture());
    vi.spyOn(deliverablesApi, "getLatestDeliverable").mockRejectedValue(NOT_SUBMITTED_YET);
    vi.spyOn(deliverablesApi, "uploadDeliverableFile").mockResolvedValue({
      deliverableId: "d-7",
      resultHash: `0x${"6".repeat(64)}`,
      storedAt: "2026-01-03T00:00:00.000Z",
    });
    writeContract.mockRejectedValueOnce(new Error("user rejected the request"));

    render(<SubmissionSection taskId="task-1" />);

    const file = new File(["hello"], "result.txt", { type: "text/plain" });
    const input = await screen.findByLabelText("上传成果文件");
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(await screen.findByRole("button", { name: "计算成果哈希" }));
    const submitButton = await screen.findByRole("button", { name: "提交成果" });
    await waitFor(() => expect(submitButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(submitButton);
    await screen.findByRole("button", { name: "重试提交" }); // confirms `failed` was reached

    const fileRadio = screen.getByRole("radio", { name: "上传文件" });
    expect(fileRadio.hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: "填写成果 URL" }));

    // Mode genuinely switched this time — the URL textbox is now showing,
    // and the previously-staged hash/submit view is gone (back to a fresh
    // "计算成果哈希" step for the newly-selected mode).
    expect(await screen.findByRole("textbox")).toBeTruthy();
    expect(screen.queryByText("重试提交")).toBeNull();
  });

  // N6 Feature QA finding (AC-905): "需求方...能通过受权限保护的下载接口获取
  // 文件内容" — the read-only view previously showed only metadata, with no
  // actual way to reach `GET .../latest/file`. This proves the requester
  // sees a real link to it.
  it("shows a download link to GET .../latest/file for the requester (AC-905)", async () => {
    mockSession = { status: "signed_in", address: REQUESTER_ADDRESS };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "SUBMITTED" }));
    vi.spyOn(deliverablesApi, "getLatestDeliverable").mockResolvedValue({
      deliverableId: "d-8",
      resultHash: `0x${"7".repeat(64)}`,
      fileMeta: { mimeType: "text/plain", sizeBytes: 5 },
      submittedAt: "2026-01-03T00:00:00.000Z",
      reviewDeadline: "2026-01-10T00:00:00.000Z",
    });

    render(<SubmissionSection taskId="task-1" />);

    const link = await screen.findByRole("link", { name: "下载成果文件" });
    expect(link.getAttribute("href")).toBe(`${apiBaseUrl()}/tasks/task-1/deliverables/latest/file`);
  });

  it("shows the same download link for the accepted Agent once SUBMITTED", async () => {
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "SUBMITTED" }));
    vi.spyOn(deliverablesApi, "getLatestDeliverable").mockResolvedValue({
      deliverableId: "d-9",
      resultHash: `0x${"8".repeat(64)}`,
      fileMeta: { mimeType: "text/plain", sizeBytes: 5 },
      submittedAt: "2026-01-03T00:00:00.000Z",
      reviewDeadline: "2026-01-10T00:00:00.000Z",
    });

    render(<SubmissionSection taskId="task-1" />);

    expect(await screen.findByRole("link", { name: "下载成果文件" })).toBeTruthy();
  });

  it("does not show the download link to a signed-out visitor (F-908: link visibility mirrors access)", async () => {
    mockSession = { status: "signed_out", address: undefined };
    vi.spyOn(tasksApi, "getTask").mockResolvedValue(taskFixture({ status: "SUBMITTED" }));
    vi.spyOn(deliverablesApi, "getLatestDeliverable").mockResolvedValue({
      deliverableId: "d-10",
      resultHash: `0x${"9".repeat(64)}`,
      fileMeta: { mimeType: "text/plain", sizeBytes: 5 },
      submittedAt: "2026-01-03T00:00:00.000Z",
      reviewDeadline: "2026-01-10T00:00:00.000Z",
    });

    render(<SubmissionSection taskId="task-1" />);

    await screen.findByText(`0x${"9".repeat(64)}`);
    expect(screen.queryByRole("link", { name: "下载成果文件" })).toBeNull();
  });
});
