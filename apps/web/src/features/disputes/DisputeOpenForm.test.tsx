import type { ChainConfig } from "@agent-market/domain";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisputeOpenForm } from "./DisputeOpenForm.js";
import * as disputesApi from "./api.js";
import { ApiError } from "./api.js";

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

vi.mock("../wallet/WalletProvider.js", () => ({
  useWallet: () => ({
    connection: {
      status: "connected",
      address: "0x1111111111111111111111111111111111111111",
      chainId: CHAIN_CONFIG.chainId,
    },
    address: "0x1111111111111111111111111111111111111111",
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

const EVIDENCE_HASH = `0x${"7".repeat(64)}` as const;

async function saveDisputeInfo() {
  const reasonInput = await screen.findByLabelText("争议原因");
  const evidenceInput = screen.getByLabelText("证据说明");
  fireEvent.change(reasonInput, { target: { value: "交付成果不符合要求" } });
  fireEvent.change(evidenceInput, { target: { value: "详细说明" } });
  fireEvent.click(screen.getByRole("button", { name: "保存争议信息" }));
  expect(await screen.findByText(EVIDENCE_HASH)).toBeTruthy();
}

beforeEach(() => {
  writeContract.mockReset();
  waitForTransactionReceipt.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Codex review (T-1005 follow-up, P2, human-reviewed): the original
// "重新填写" button reset the form back to editable after a successful
// save, but `POST /tasks/:taskId/disputes` is one-shot (a unique partial
// index rejects a second OPEN dispute for the same task with 409) — the
// button always led to a guaranteed-to-fail resubmission. The human
// decision (option B) was to make a saved submission immutable and remove
// the reset control entirely, rather than build an update endpoint.
describe("DisputeOpenForm — immutable-after-save (T-1005 follow-up)", () => {
  it("does not offer a '重新填写' control once saved", async () => {
    vi.spyOn(disputesApi, "submitDispute").mockResolvedValue({
      disputeId: "dispute-1",
      evidenceHash: EVIDENCE_HASH,
    });
    render(<DisputeOpenForm taskId="task-1" onOpened={vi.fn()} />);
    await saveDisputeInfo();

    expect(screen.queryByRole("button", { name: "重新填写" })).toBeNull();
    expect(screen.getByText("争议信息已保存，证据内容不可修改，请核对后提交上链。")).toBeTruthy();
  });

  it("makes it impossible to call submitDispute a second time from the saved state", async () => {
    const submitSpy = vi.spyOn(disputesApi, "submitDispute").mockResolvedValue({
      disputeId: "dispute-1",
      evidenceHash: EVIDENCE_HASH,
    });
    render(<DisputeOpenForm taskId="task-1" onOpened={vi.fn()} />);
    await saveDisputeInfo();

    // No "保存争议信息" button, no reason/evidence fields, and no reset
    // control exist anywhere in the saved view — there is no UI path left
    // that could invoke `submitDispute` again.
    expect(screen.queryByRole("button", { name: "保存争议信息" })).toBeNull();
    expect(screen.queryByLabelText("争议原因")).toBeNull();
    expect(screen.queryByLabelText("证据说明")).toBeNull();
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it("still shows the evidence hash and lets the user proceed to sign and broadcast openDispute", async () => {
    vi.spyOn(disputesApi, "submitDispute").mockResolvedValue({
      disputeId: "dispute-1",
      evidenceHash: EVIDENCE_HASH,
    });
    const txHash = `0x${"a".repeat(64)}` as const;
    writeContract.mockResolvedValue(txHash);
    waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    vi.spyOn(disputesApi, "submitDisputeOpenVerification").mockResolvedValue({
      status: "DISPUTED",
      confirmations: 1,
    });
    const onOpened = vi.fn();

    render(<DisputeOpenForm taskId="task-1" onOpened={onOpened} />);
    await saveDisputeInfo();

    fireEvent.click(screen.getByRole("button", { name: "提交争议" }));

    expect(await screen.findByText("争议已成功提交上链。")).toBeTruthy();
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "openDispute",
        args: [expect.anything(), EVIDENCE_HASH],
      }),
    );
    expect(onOpened).toHaveBeenCalled();
  });

  it("keeps the fields editable and resubmittable when the save itself fails", async () => {
    vi.spyOn(disputesApi, "submitDispute")
      .mockRejectedValueOnce(new ApiError(500, "服务器错误"))
      .mockResolvedValueOnce({ disputeId: "dispute-1", evidenceHash: EVIDENCE_HASH });

    render(<DisputeOpenForm taskId="task-1" onOpened={vi.fn()} />);
    const reasonInput = await screen.findByLabelText("争议原因");
    const evidenceInput = screen.getByLabelText("证据说明");
    fireEvent.change(reasonInput, { target: { value: "交付成果不符合要求" } });
    fireEvent.change(evidenceInput, { target: { value: "详细说明" } });
    fireEvent.click(screen.getByRole("button", { name: "保存争议信息" }));

    expect(await screen.findByText("服务器错误")).toBeTruthy();
    // Fields are still editable and the save button still works.
    expect((reasonInput as HTMLInputElement).value).toBe("交付成果不符合要求");
    fireEvent.click(screen.getByRole("button", { name: "保存争议信息" }));

    expect(await screen.findByText(EVIDENCE_HASH)).toBeTruthy();
  });
});
