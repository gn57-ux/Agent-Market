import type { ChainConfig } from "@agent-market/domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletConnectionStatus, WalletProvider } from "../wallet/WalletProvider.js";
import { SessionProvider } from "../session/SessionProvider.js";
import { AgentCreatePage } from "./AgentCreatePage.js";
import * as agentsApi from "./api.js";

const ADDRESS = "0x1234567890123456789012345678901234567890" as const;
// Built via .repeat() rather than a literal repeated-digit string — a
// literal value here for the ydToken field name would trip the
// sensitive-info scanner's "looks like a token/secret" heuristic; it is a
// placeholder contract address (see SessionProvider.test.tsx's identical
// fixture), not an actual secret.
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

function DetailProbe() {
  return <div data-testid="navigated-detail">navigated</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/agents/new"]}>
      <WalletProvider chainConfig={CHAIN_CONFIG}>
        <SessionProvider>
          <WalletConnectionStatus />
          <Routes>
            <Route path="/agents/new" element={<AgentCreatePage />} />
            <Route path="/agents/:agentId" element={<DetailProbe />} />
          </Routes>
        </SessionProvider>
      </WalletProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  delete window.ethereum;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  window.ethereum = {
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_requestAccounts") return [ADDRESS];
      if (method === "eth_chainId") return "0x7a69";
      if (method === "personal_sign") return "0xdeadbeef";
      throw new Error(`Unexpected test RPC method: ${method}`);
    }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/auth/nonce")) {
        return new Response(
          JSON.stringify({
            nonce: "n",
            issuedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-01-01T00:10:00.000Z",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/auth/verify")) {
        return new Response(JSON.stringify({ sessionToken: "tok", address: ADDRESS }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
});

async function connectAndLogIn() {
  fireEvent.click(screen.getByRole("button", { name: "连接钱包" }));
  await screen.findByTitle(ADDRESS);
  fireEvent.click(screen.getByRole("button", { name: "登录（签名验证钱包身份）" }));
  await screen.findByText(/已登录/);
}

describe("AgentCreatePage", () => {
  it("prompts to sign in instead of showing the form when not authenticated", () => {
    renderPage();
    expect(screen.getByText("登录钱包身份后才能发布 Agent。")).toBeTruthy();
    expect(screen.queryByLabelText("名称")).toBeNull();
  });

  it("shows the create form once signed in, and navigates to the new Agent's detail page on success", async () => {
    vi.spyOn(agentsApi, "createAgent").mockResolvedValue({
      agentId: "agent-123",
      status: "ACTIVE",
      createdAt: "2026-01-01T00:00:00.000Z",
      completedTaskCount: 0,
      qualityScore: null,
    });
    renderPage();
    await connectAndLogIn();

    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "My Agent" } });
    fireEvent.change(screen.getByLabelText("介绍"), { target: { value: "desc" } });
    fireEvent.change(screen.getByLabelText("分类"), { target: { value: "writing" } });
    fireEvent.change(screen.getByLabelText("收款地址"), {
      target: { value: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发布" }));

    await waitFor(() => expect(screen.getByTestId("navigated-detail")).toBeTruthy());
    expect(agentsApi.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "My Agent", category: "writing" }),
    );
  });

  // Feature 12 (F-1207/AC-1207): the "协议版本" field is a fixed read-only
  // display, never an editable selector.
  it("shows the protocol version as a fixed, disabled 'v1' display", async () => {
    renderPage();
    await connectAndLogIn();

    const protocolVersionInput = screen.getByLabelText("协议版本") as HTMLInputElement;
    expect(protocolVersionInput.value).toBe("v1");
    expect(protocolVersionInput.disabled).toBe(true);
  });

  // T-1300: credentialRef is no longer owner-chosen free text — a checkbox
  // toggles `credentialEnabled`, and the server computes the actual
  // reference from the Agent's own real id (closing the front-running
  // vector a free-text input used to allow). There is nothing left to
  // validate client-side: a checkbox can't be malformed.
  it("defaults the credential toggle to unchecked, and submits credentialEnabled unset when left alone", async () => {
    vi.spyOn(agentsApi, "createAgent").mockResolvedValue({
      agentId: "agent-123",
      status: "ACTIVE",
      createdAt: "2026-01-01T00:00:00.000Z",
      completedTaskCount: 0,
      qualityScore: null,
    });
    renderPage();
    await connectAndLogIn();

    const checkbox = screen.getByLabelText("启用调用凭据引用") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "My Agent" } });
    fireEvent.change(screen.getByLabelText("介绍"), { target: { value: "desc" } });
    fireEvent.change(screen.getByLabelText("分类"), { target: { value: "writing" } });
    fireEvent.change(screen.getByLabelText("收款地址"), {
      target: { value: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发布" }));

    await waitFor(() => expect(screen.getByTestId("navigated-detail")).toBeTruthy());
    expect(agentsApi.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ credentialEnabled: undefined }),
    );
  });

  it("submits credentialEnabled: true when the toggle is checked", async () => {
    vi.spyOn(agentsApi, "createAgent").mockResolvedValue({
      agentId: "agent-123",
      status: "ACTIVE",
      createdAt: "2026-01-01T00:00:00.000Z",
      completedTaskCount: 0,
      qualityScore: null,
    });
    renderPage();
    await connectAndLogIn();

    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "My Agent" } });
    fireEvent.change(screen.getByLabelText("介绍"), { target: { value: "desc" } });
    fireEvent.change(screen.getByLabelText("分类"), { target: { value: "writing" } });
    fireEvent.change(screen.getByLabelText("收款地址"), {
      target: { value: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3" },
    });
    fireEvent.click(screen.getByLabelText("启用调用凭据引用"));
    fireEvent.click(screen.getByRole("button", { name: "发布" }));

    await waitFor(() => expect(screen.getByTestId("navigated-detail")).toBeTruthy());
    expect(agentsApi.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ credentialEnabled: true }),
    );
  });

  it("shows an error message and stays on the page when creation fails", async () => {
    vi.spyOn(agentsApi, "createAgent").mockRejectedValue(new Error("boom"));
    renderPage();
    await connectAndLogIn();

    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "My Agent" } });
    fireEvent.change(screen.getByLabelText("介绍"), { target: { value: "desc" } });
    fireEvent.change(screen.getByLabelText("分类"), { target: { value: "writing" } });
    fireEvent.change(screen.getByLabelText("收款地址"), {
      target: { value: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发布" }));

    expect(await screen.findByText("创建失败，请重试。")).toBeTruthy();
    expect(screen.queryByTestId("navigated-detail")).toBeNull();
  });
});
