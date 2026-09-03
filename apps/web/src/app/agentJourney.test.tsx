import type { ChainConfig } from "@agent-market/domain";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletProvider } from "../features/wallet/WalletProvider.js";
import { SessionProvider } from "../features/session/SessionProvider.js";
import { router } from "./router.js";
import * as agentsApi from "../features/agents/api.js";
import type { Agent, CreateAgentInput, UpdateAgentInput } from "../features/agents/api.js";
import { ApiError } from "../shared/api/client.js";

/**
 * AC-501's specified verification method is a real browser walkthrough
 * (specs/05-agent-registration/tasks.md T-505). This environment has no
 * browser automation tool (checked: no Playwright/Puppeteer/screenshot
 * tool is available) — a live click-through by a human is still the only
 * way to fully satisfy that verification method.
 *
 * This test is the most rigorous automated substitute available: it
 * exercises the REAL router (app/router.tsx, the same object main.tsx
 * mounts), the REAL page components, and REAL DOM events (fireEvent) end
 * to end across every page a walkthrough would visit — sign in, create
 * three differently-categorized Agents, see them in the market list and
 * their own detail pages, confirm qualityScore=null renders "暂无评分" (not
 * a number), edit a field, deactivate with the ConfirmAction two-click
 * confirmation, and confirm a status=ACTIVE-filtered list excludes it. Only
 * the network layer (fetch for /auth/*, and features/agents/api.ts for
 * /agents/*) is faked — everything above that is the real app.
 *
 * What this test CANNOT prove: actual visual layout/responsive rendering,
 * real MetaMask interaction, or anything that only a rendered browser
 * viewport and a human eye can confirm.
 */

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

let store: Map<string, Agent>;
let nextId: number;

// T-1300: mirrors apps/api's credential.ts `computeCredentialRef` (a
// deterministic function of the Agent's own id) closely enough for this
// fake backend's contract purposes — not byte-identical to the real
// implementation, but same shape/determinism, which is all this journey
// test's own assertions ever depend on.
function fakeComputeCredentialRef(agentId: string): string {
  return `env://AGENT_${agentId.replace(/-/g, "").toUpperCase()}`;
}

function makeAgentRow(id: string, input: CreateAgentInput): Agent {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    agentId: id,
    ownerAddress: ADDRESS.toLowerCase(),
    name: input.name,
    description: input.description,
    category: input.category,
    skillTags: input.skillTags,
    authorBio: input.authorBio ?? null,
    invocationUrl: input.invocationUrl ?? null,
    payoutAddress: input.payoutAddress,
    pricingModel: input.pricingModel ?? null,
    pricingType: input.pricingType,
    referencePrice: input.referencePrice ?? null,
    status: "ACTIVE",
    reviewStatus: input.pricingType === "FREE" ? "ACTIVE" : "PENDING_REVIEW",
    completedTaskCount: 0,
    successCount: 0,
    overdueCount: 0,
    qualityScore: null,
    createdAt: now,
    updatedAt: now,
    protocolVersion: input.protocolVersion ?? "v1",
    credentialRef: input.credentialEnabled ? fakeComputeCredentialRef(id) : null,
  };
}

function applyPatch(agent: Agent, patch: UpdateAgentInput): Agent {
  const next: Agent = { ...agent };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.category !== undefined) next.category = patch.category;
  if (patch.skillTags !== undefined) next.skillTags = patch.skillTags;
  if (patch.authorBio !== undefined) next.authorBio = patch.authorBio;
  if (patch.invocationUrl !== undefined) next.invocationUrl = patch.invocationUrl;
  if (patch.payoutAddress !== undefined) next.payoutAddress = patch.payoutAddress;
  if (patch.pricingModel !== undefined) next.pricingModel = patch.pricingModel;
  if (patch.referencePrice !== undefined) next.referencePrice = patch.referencePrice;
  if (patch.credentialEnabled !== undefined) {
    next.credentialRef = patch.credentialEnabled ? fakeComputeCredentialRef(agent.agentId) : null;
  }
  return next;
}

beforeEach(async () => {
  // `router` is a module-level singleton (imported once, shared by every
  // test in this file) — without resetting its location explicitly, a
  // test would start wherever the PREVIOUS test's navigation left off.
  await router.navigate("/");

  store = new Map();
  nextId = 1;

  vi.spyOn(agentsApi, "createAgent").mockImplementation(async (input) => {
    const id = `agent-${nextId++}`;
    store.set(id, makeAgentRow(id, input));
    const row = store.get(id);
    if (!row) throw new Error("unreachable");
    return {
      agentId: row.agentId,
      status: row.status,
      reviewStatus: row.reviewStatus,
      pricingType: row.pricingType,
      createdAt: row.createdAt,
      completedTaskCount: row.completedTaskCount,
      qualityScore: row.qualityScore,
    };
  });

  vi.spyOn(agentsApi, "listAgents").mockImplementation(async (params = {}) => {
    let items = [...store.values()];
    const { category, skillTag, status } = params;
    if (category) items = items.filter((a) => a.category === category);
    if (skillTag) items = items.filter((a) => a.skillTags.includes(skillTag));
    if (status) items = items.filter((a) => a.status === status);
    return { items, total: items.length, page: 1, pageSize: 20 };
  });

  vi.spyOn(agentsApi, "getAgent").mockImplementation(async (agentId) => {
    const row = store.get(agentId);
    if (!row) throw new ApiError(404, "未找到该 Agent。");
    return row;
  });

  vi.spyOn(agentsApi, "updateAgent").mockImplementation(async (agentId, patch) => {
    const row = store.get(agentId);
    if (!row) throw new ApiError(404, "未找到该 Agent。");
    const updated = applyPatch(row, patch);
    store.set(agentId, updated);
    return updated;
  });

  // activateAgent/deactivateAgent are deliberately NOT mocked at the api.ts
  // level (Codex/browser-walkthrough regression, T-505 P1): the real bug —
  // apiFetch always sending Content-Type: application/json even for a
  // bodyless POST, which apps/api's Fastify rejects as a 400 before the
  // route handler ever runs — lives inside apiFetch itself. Mocking
  // agentsApi.activateAgent/deactivateAgent directly (as every other
  // agentsApi function here still is) would bypass apiFetch entirely and
  // could never have caught this. Letting the real functions run means the
  // fetch mock below has to replicate Fastify's real behavior for these
  // two routes, not just return canned data.
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
    vi.fn(async (url: string, init?: RequestInit) => {
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

      const activateMatch = /\/agents\/([^/]+)\/(activate|deactivate)$/.exec(url);
      if (activateMatch) {
        // Replicates real Fastify's actual behavior (T-505 P1 root cause):
        // a request whose Content-Type says application/json but carries no
        // body is rejected as invalid JSON before the route handler runs.
        // apiFetch must NOT be sending this header for a bodyless request —
        // if it regresses, this branch fires and the test fails exactly
        // like the real browser bug did.
        const contentType = new Headers(init?.headers).get("content-type");
        if (contentType?.toLowerCase().includes("application/json")) {
          return new Response(
            JSON.stringify({
              error: {
                message: "Body cannot be empty when content-type is set to 'application/json'",
              },
            }),
            { status: 400 },
          );
        }
        const [, agentId, action] = activateMatch;
        const row = agentId ? store.get(agentId) : undefined;
        if (!row) {
          return new Response(JSON.stringify({ error: { message: "未找到该 Agent。" } }), {
            status: 404,
          });
        }
        const updated = {
          ...row,
          status: action === "activate" ? ("ACTIVE" as const) : ("INACTIVE" as const),
        };
        store.set(row.agentId, updated);
        return new Response(JSON.stringify(updated), { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
});

/** Clicks the nav bar's "Agent 市场" link specifically. HomePage also has
 * its own body-text link with the same accessible name, so a plain
 * `getByRole` would be ambiguous on "/" — scoping to the `<header>`
 * (implicit ARIA role "banner") picks the nav copy unambiguously on every
 * page, including ones that have no duplicate at all. */
function goToAgentMarket() {
  const header = within(screen.getByRole("banner"));
  fireEvent.click(header.getByRole("link", { name: "Agent 市场" }));
}

afterEach(() => {
  delete window.ethereum;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderApp() {
  return render(
    <WalletProvider chainConfig={CHAIN_CONFIG}>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </WalletProvider>,
  );
}

async function connectAndSignIn() {
  // Header.tsx renders `walletControls` twice by design (an always-visible
  // mobile row alongside the desktop-inline row it CSS-hides below `md`;
  // see Header.tsx's own doc comment) — every wallet/session control this
  // helper interacts with therefore has two real DOM instances under jsdom
  // (which doesn't evaluate the `md:hidden`/`hidden md:flex` media-query
  // classes deciding which one a real browser would actually show).
  // Clicking/asserting on the first of each pair is enough: both instances
  // read the same WalletProvider/SessionProvider context and fire the same
  // handlers, so acting through either one drives the same real state.
  const [connectButton] = screen.getAllByRole("button", { name: "连接钱包" });
  fireEvent.click(connectButton as HTMLElement);
  await screen.findAllByTitle(ADDRESS);
  const [signInButton] = screen.getAllByRole("button", { name: "登录（签名验证钱包身份）" });
  fireEvent.click(signInButton as HTMLElement);
  await screen.findAllByText(/已登录/);
}

async function createAgentViaForm(fields: {
  name: string;
  description: string;
  category: string;
  skillTags: string;
  payoutAddress: string;
}) {
  fireEvent.click(screen.getByRole("link", { name: "发布 Agent" }));
  await screen.findByLabelText("名称");

  fireEvent.change(screen.getByLabelText("名称"), { target: { value: fields.name } });
  fireEvent.change(screen.getByLabelText("介绍"), { target: { value: fields.description } });
  fireEvent.change(screen.getByLabelText("分类"), { target: { value: fields.category } });
  fireEvent.change(screen.getByLabelText("技能标签（逗号分隔）"), {
    target: { value: fields.skillTags },
  });
  fireEvent.change(screen.getByLabelText("收款地址"), {
    target: { value: fields.payoutAddress },
  });
  fireEvent.change(screen.getByLabelText("计费类型"), { target: { value: "FREE" } });
  fireEvent.click(screen.getByRole("button", { name: "发布" }));

  // Successful creation navigates to /agents/:agentId — wait for the detail
  // page's h1 (the Agent name) to confirm navigation actually completed.
  await screen.findByRole("heading", { level: 1, name: fields.name });
}

describe("Agent registration journey (AC-501 automated substitute — see file header)", () => {
  it("signs in, creates three differently-categorized Agents, and finds them in the market list and their own detail pages", async () => {
    renderApp();
    await connectAndSignIn();
    goToAgentMarket();
    await screen.findByText("暂无符合条件的 Agent。");

    await createAgentViaForm({
      name: "Copy Polisher",
      description: "Polishes marketing copy.",
      category: "writing",
      skillTags: "copywriting, editing",
      payoutAddress: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3",
    });
    // AC-502: a freshly created Agent's detail page must show "暂无评分", never
    // a number, for its null qualityScore.
    expect(screen.getByText("暂无评分")).toBeTruthy();

    goToAgentMarket();
    await screen.findByText("Copy Polisher");

    await createAgentViaForm({
      name: "Bug Triager",
      description: "Triages incoming bug reports.",
      category: "engineering",
      skillTags: "debugging, triage",
      payoutAddress: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3",
    });

    goToAgentMarket();
    await screen.findByText("Bug Triager");

    await createAgentViaForm({
      name: "Data Cleaner",
      description: "Cleans and normalizes datasets.",
      category: "data",
      skillTags: "etl",
      payoutAddress: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3",
    });

    goToAgentMarket();

    // All three, from three different categories, visible in the list.
    expect(await screen.findByText("Copy Polisher")).toBeTruthy();
    expect(screen.getByText("Bug Triager")).toBeTruthy();
    expect(screen.getByText("Data Cleaner")).toBeTruthy();
    expect(store.size).toBe(3);
    expect(new Set([...store.values()].map((a) => a.category)).size).toBe(3);

    // Each is independently reachable via its own detail page. The whole
    // card is one Link (AgentMarketPage.tsx restyle: click anywhere on the
    // card, not just the name), so its accessible name is the full card
    // content — matched here as a substring, not the exact old
    // name-only-link text.
    fireEvent.click(screen.getByRole("link", { name: /Data Cleaner/ }));
    await screen.findByRole("heading", { level: 1, name: "Data Cleaner" });
    expect(screen.getByText("etl")).toBeTruthy();
  });

  it("edits an Agent's field, deactivates it via the two-click confirmation, and confirms it's excluded from the ACTIVE-filtered market list", async () => {
    renderApp();
    await connectAndSignIn();
    goToAgentMarket();
    await screen.findByText("暂无符合条件的 Agent。");
    await createAgentViaForm({
      name: "Original Name",
      description: "Original description.",
      category: "writing",
      skillTags: "copywriting",
      payoutAddress: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3",
    });

    // Edit: rename via the owner-only edit link.
    fireEvent.click(screen.getByRole("link", { name: "编辑" }));
    await screen.findByLabelText("名称");
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Renamed Agent" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("heading", { level: 1, name: "Renamed Agent" });

    // Deactivate: ConfirmAction requires two explicit clicks.
    const deactivateButton = screen.getByRole("button", { name: "停用" });
    fireEvent.click(deactivateButton);
    fireEvent.click(screen.getByRole("button", { name: "确认停用？" }));
    await waitFor(() => expect(screen.getByText("已停用")).toBeTruthy());

    // Market list defaults to status=ACTIVE (AgentMarketPage always passes
    // status: "ACTIVE") — the deactivated Agent must not appear.
    goToAgentMarket();
    await waitFor(() => expect(screen.getByText("暂无符合条件的 Agent。")).toBeTruthy());
    expect(screen.queryByText("Renamed Agent")).toBeNull();

    // The underlying store still has it, just filtered out of the ACTIVE
    // view — proving this is a real filter, not data loss.
    const stored = [...store.values()][0];
    expect(stored?.status).toBe("INACTIVE");
    expect(stored?.name).toBe("Renamed Agent");

    // Real browser walkthrough, T-505 P1 (reachability): a deactivated
    // Agent must be findable again through normal navigation, not just
    // browser back/forward or a hand-typed URL. The "已停用" filter is that
    // path — reaching the detail page from here and reactivating is the
    // only supported way back to ACTIVE.
    fireEvent.click(screen.getByRole("button", { name: "已停用" }));
    // Whole-card Link (see the earlier registration test's identical note).
    fireEvent.click(await screen.findByRole("link", { name: /Renamed Agent/ }));
    await screen.findByRole("heading", { level: 1, name: "Renamed Agent" });
    expect(screen.getByText("已停用")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "启用" }));
    fireEvent.click(screen.getByRole("button", { name: "确认启用？" }));
    await waitFor(() => expect(screen.getByText("启用中")).toBeTruthy());
    expect(store.get(stored?.agentId ?? "")?.status).toBe("ACTIVE");

    // Reactivated: gone from "已停用", back in the default ACTIVE view.
    goToAgentMarket();
    fireEvent.click(screen.getByRole("button", { name: "已停用" }));
    await waitFor(() => expect(screen.getByText("暂无符合条件的 Agent。")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "启用中" }));
    expect(await screen.findByText("Renamed Agent")).toBeTruthy();
  });

  it("a non-owner session sees no edit/deactivate controls on someone else's Agent detail page", async () => {
    // Seed an Agent owned by a DIFFERENT address than the one that will log in.
    const otherOwnersAgent = {
      ...makeAgentRow("agent-other", {
        name: "Someone Else's Agent",
        description: "d",
        category: "writing",
        skillTags: [],
        payoutAddress: "0x9999999999999999999999999999999999999999",
        pricingType: "FREE",
      }),
      ownerAddress: "0x9999999999999999999999999999999999999999",
    };
    store.set("agent-other", otherOwnersAgent);

    renderApp();
    await connectAndSignIn();

    goToAgentMarket();
    // Whole-card Link (see the earlier registration test's identical note).
    fireEvent.click(await screen.findByRole("link", { name: /Someone Else's Agent/ }));

    await screen.findByRole("heading", { level: 1, name: "Someone Else's Agent" });
    expect(screen.queryByRole("link", { name: "编辑" })).toBeNull();
    expect(screen.queryByRole("button", { name: "停用" })).toBeNull();
  });
});
