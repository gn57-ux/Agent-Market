import { describe, expect, it } from "vitest";
import { isAttributedEvent, DEFAULT_ATTRIBUTION_WINDOW_MS } from "./attribution.js";

const TASK_A = "11111111-1111-1111-1111-111111111111";
const TASK_B = "22222222-2222-2222-2222-222222222222";
const AGENT_A = "33333333-3333-3333-3333-333333333333";
const AGENT_B = "44444444-4444-4444-4444-444444444444";
const RUN_A = "55555555-5555-5555-5555-555555555555";
const RUN_B = "66666666-6666-6666-6666-666666666666";

const exposure = (overrides: Partial<Parameters<typeof isAttributedEvent>[0]> = {}) => ({
  eventType: "EXPOSURE",
  taskId: TASK_A,
  agentId: AGENT_A,
  runId: RUN_A,
  occurredAt: new Date("2026-09-01T00:00:00.000Z"),
  ...overrides,
});

describe("isAttributedEvent (T-1902, F-1903/F-1904)", () => {
  it("F-1903: attributes a later ACCEPT (server-originated, no runId needed) within the window for the same task+agent", () => {
    const candidate = {
      eventType: "ACCEPT",
      taskId: TASK_A,
      agentId: AGENT_A,
      runId: null,
      occurredAt: new Date("2026-09-02T00:00:00.000Z"),
    };
    expect(isAttributedEvent(exposure(), candidate)).toBe(true);
  });

  it("F-1903: does not attribute an event at or before the exposure's own timestamp", () => {
    const sameInstant = {
      eventType: "ACCEPT",
      taskId: TASK_A,
      agentId: AGENT_A,
      runId: null,
      occurredAt: exposure().occurredAt,
    };
    expect(isAttributedEvent(exposure(), sameInstant)).toBe(false);

    const earlier = { ...sameInstant, occurredAt: new Date("2026-08-31T23:59:59.999Z") };
    expect(isAttributedEvent(exposure(), earlier)).toBe(false);
  });

  it("F-1903: does not attribute an event outside the window", () => {
    const justOutside = {
      eventType: "ACCEPT",
      taskId: TASK_A,
      agentId: AGENT_A,
      runId: null,
      occurredAt: new Date(exposure().occurredAt.getTime() + DEFAULT_ATTRIBUTION_WINDOW_MS + 1),
    };
    expect(isAttributedEvent(exposure(), justOutside)).toBe(false);

    const justInside = {
      ...justOutside,
      occurredAt: new Date(exposure().occurredAt.getTime() + DEFAULT_ATTRIBUTION_WINDOW_MS),
    };
    expect(isAttributedEvent(exposure(), justInside)).toBe(true);
  });

  it("does not attribute an event for a different task", () => {
    const candidate = {
      eventType: "ACCEPT",
      taskId: TASK_B,
      agentId: AGENT_A,
      runId: null,
      occurredAt: new Date("2026-09-02T00:00:00.000Z"),
    };
    expect(isAttributedEvent(exposure(), candidate)).toBe(false);
  });

  it("does not attribute an event for a different agent when both sides carry one", () => {
    const candidate = {
      eventType: "ACCEPT",
      taskId: TASK_A,
      agentId: AGENT_B,
      runId: null,
      occurredAt: new Date("2026-09-02T00:00:00.000Z"),
    };
    expect(isAttributedEvent(exposure(), candidate)).toBe(false);
  });

  it("N4 P1 fix: an agent-less REFUND (e.g. pre-acceptance cancellation) does NOT match every candidate's exposure for the task", () => {
    const candidate = {
      eventType: "REFUND",
      taskId: TASK_A,
      agentId: null,
      runId: null,
      occurredAt: new Date("2026-09-02T00:00:00.000Z"),
    };
    expect(isAttributedEvent(exposure(), candidate)).toBe(false);
  });

  it("N4 P1 fix: a runId-less VIEW does not attribute when the exposure itself carries a real runId (cannot verify it was actually shown this recommendation)", () => {
    const candidate = {
      eventType: "VIEW",
      taskId: TASK_A,
      agentId: null,
      runId: null,
      occurredAt: new Date("2026-09-02T00:00:00.000Z"),
    };
    expect(isAttributedEvent(exposure(), candidate)).toBe(false);
  });

  it("attributes an agent-less, runId-less VIEW when the exposure ITSELF has no runId to verify against", () => {
    const candidate = {
      eventType: "VIEW",
      taskId: TASK_A,
      agentId: null,
      runId: null,
      occurredAt: new Date("2026-09-02T00:00:00.000Z"),
    };
    expect(isAttributedEvent(exposure({ runId: null }), candidate)).toBe(true);
  });

  it("N4 P1 fix: a CLICK from a stranger who never received this runId does NOT attribute, even with matching task/agent/window (closes cross-user contamination)", () => {
    const strangersClick = {
      eventType: "CLICK",
      taskId: TASK_A,
      agentId: AGENT_A,
      runId: null,
      occurredAt: new Date("2026-09-01T00:05:00.000Z"),
    };
    expect(isAttributedEvent(exposure(), strangersClick)).toBe(false);
  });

  it("a CLICK carrying the real runId it was actually shown in DOES attribute", () => {
    const realClick = {
      eventType: "CLICK",
      taskId: TASK_A,
      agentId: AGENT_A,
      runId: RUN_A,
      occurredAt: new Date("2026-09-01T00:05:00.000Z"),
    };
    expect(isAttributedEvent(exposure(), realClick)).toBe(true);
  });

  it("N4 P2 fix: a CLICK carrying a DIFFERENT run's runId does not attribute to an earlier run's exposure, even for the same task+agent within window", () => {
    const otherRunClick = {
      eventType: "CLICK",
      taskId: TASK_A,
      agentId: AGENT_A,
      runId: RUN_B,
      occurredAt: new Date("2026-09-02T00:00:00.000Z"),
    };
    expect(isAttributedEvent(exposure(), otherRunClick)).toBe(false);
  });

  it("a server-originated ACCEPT still attributes even though it never carries a runId", () => {
    const serverAccept = {
      eventType: "ACCEPT",
      taskId: TASK_A,
      agentId: AGENT_A,
      runId: null,
      occurredAt: new Date("2026-09-02T00:00:00.000Z"),
    };
    expect(isAttributedEvent(exposure(), serverAccept)).toBe(true);
  });
});
