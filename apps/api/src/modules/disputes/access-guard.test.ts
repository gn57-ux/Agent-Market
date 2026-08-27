import { describe, expect, it } from "vitest";
import { resolveDisputeAccessLevel } from "./access-guard.js";

const REQUESTER_ADDRESS = "0x1111111111111111111111111111111111111a";
const AGENT_ADDRESS = "0x2222222222222222222222222222222222222b";
const ARBITRATOR_ADDRESS = "0x3333333333333333333333333333333333333c";
const UNRELATED_ADDRESS = "0x4444444444444444444444444444444444444d";

function buildIsArbitrator(
  hasRole: boolean,
  called: { called: boolean; account?: string },
): (account: string) => Promise<boolean> {
  return async (account) => {
    called.called = true;
    called.account = account;
    return hasRole;
  };
}

describe("resolveDisputeAccessLevel", () => {
  it("returns public for an anonymous caller (null sessionAddress), without ever calling isArbitrator (avoids constructing an RPC client/chain config for viewers who never need it)", async () => {
    const called = { called: false };
    const level = await resolveDisputeAccessLevel({
      sessionAddress: null,
      requesterAddress: REQUESTER_ADDRESS,
      acceptedAgentAddress: AGENT_ADDRESS,
      isArbitrator: buildIsArbitrator(false, called),
    });
    expect(level).toBe("public");
    expect(called.called).toBe(false);
  });

  it("returns full for the task's requester, without calling isArbitrator", async () => {
    const called = { called: false };
    const level = await resolveDisputeAccessLevel({
      sessionAddress: REQUESTER_ADDRESS,
      requesterAddress: REQUESTER_ADDRESS,
      acceptedAgentAddress: AGENT_ADDRESS,
      isArbitrator: buildIsArbitrator(false, called),
    });
    expect(level).toBe("full");
    expect(called.called).toBe(false);
  });

  it("returns full for the task's accepted Agent, without calling isArbitrator", async () => {
    const called = { called: false };
    const level = await resolveDisputeAccessLevel({
      sessionAddress: AGENT_ADDRESS,
      requesterAddress: REQUESTER_ADDRESS,
      acceptedAgentAddress: AGENT_ADDRESS,
      isArbitrator: buildIsArbitrator(false, called),
    });
    expect(level).toBe("full");
    expect(called.called).toBe(false);
  });

  it("is case-insensitive when matching the requester/agent address", async () => {
    const called = { called: false };
    const level = await resolveDisputeAccessLevel({
      sessionAddress: REQUESTER_ADDRESS.toUpperCase(),
      requesterAddress: REQUESTER_ADDRESS,
      acceptedAgentAddress: AGENT_ADDRESS,
      isArbitrator: buildIsArbitrator(false, called),
    });
    expect(level).toBe("full");
  });

  it("returns full for a session address isArbitrator confirms holds ARBITRATOR_ROLE — never trusts a self-claimed identity by skipping the check", async () => {
    const called: { called: boolean; account?: string } = { called: false };
    const level = await resolveDisputeAccessLevel({
      sessionAddress: ARBITRATOR_ADDRESS,
      requesterAddress: REQUESTER_ADDRESS,
      acceptedAgentAddress: AGENT_ADDRESS,
      isArbitrator: buildIsArbitrator(true, called),
    });
    expect(level).toBe("full");
    expect(called.called).toBe(true);
    expect(called.account).toBe(ARBITRATOR_ADDRESS);
  });

  it("returns public for a logged-in but unrelated caller isArbitrator rejects", async () => {
    const called: { called: boolean; account?: string } = { called: false };
    const level = await resolveDisputeAccessLevel({
      sessionAddress: UNRELATED_ADDRESS,
      requesterAddress: REQUESTER_ADDRESS,
      acceptedAgentAddress: AGENT_ADDRESS,
      isArbitrator: buildIsArbitrator(false, called),
    });
    expect(level).toBe("public");
    expect(called.called).toBe(true);
    expect(called.account).toBe(UNRELATED_ADDRESS);
  });

  it("returns public when the task has no accepted Agent yet and the caller is unrelated", async () => {
    const called = { called: false };
    const level = await resolveDisputeAccessLevel({
      sessionAddress: UNRELATED_ADDRESS,
      requesterAddress: REQUESTER_ADDRESS,
      acceptedAgentAddress: null,
      isArbitrator: buildIsArbitrator(false, called),
    });
    expect(level).toBe("public");
  });

  it("fails CLOSED to public when isArbitrator throws for an unrelated logged-in caller — never 500s, never grants full (T-1002 human-review fix round 2, P2)", async () => {
    const thrown = new Error("RPC unreachable");
    const level = await resolveDisputeAccessLevel({
      sessionAddress: UNRELATED_ADDRESS,
      requesterAddress: REQUESTER_ADDRESS,
      acceptedAgentAddress: AGENT_ADDRESS,
      isArbitrator: async () => {
        throw thrown;
      },
    });
    expect(level).toBe("public");
  });

  it("fails CLOSED to public when isArbitrator throws even for the real arbitrator's address — an unproven claim is never granted full access", async () => {
    const level = await resolveDisputeAccessLevel({
      sessionAddress: ARBITRATOR_ADDRESS,
      requesterAddress: REQUESTER_ADDRESS,
      acceptedAgentAddress: AGENT_ADDRESS,
      isArbitrator: async () => {
        throw new Error("chain config missing");
      },
    });
    expect(level).toBe("public");
  });

  it("calls onArbitratorCheckError with the underlying error, but the error itself never becomes the return value or a thrown exception", async () => {
    const thrown = new Error("RPC timeout");
    const observed: unknown[] = [];
    const level = await resolveDisputeAccessLevel({
      sessionAddress: UNRELATED_ADDRESS,
      requesterAddress: REQUESTER_ADDRESS,
      acceptedAgentAddress: AGENT_ADDRESS,
      isArbitrator: async () => {
        throw thrown;
      },
      onArbitratorCheckError: (error) => observed.push(error),
    });
    expect(level).toBe("public");
    expect(observed).toEqual([thrown]);
  });

  it("does not call onArbitratorCheckError when isArbitrator resolves normally (even to false)", async () => {
    const observed: unknown[] = [];
    const level = await resolveDisputeAccessLevel({
      sessionAddress: UNRELATED_ADDRESS,
      requesterAddress: REQUESTER_ADDRESS,
      acceptedAgentAddress: AGENT_ADDRESS,
      isArbitrator: async () => false,
      onArbitratorCheckError: (error) => observed.push(error),
    });
    expect(level).toBe("public");
    expect(observed).toEqual([]);
  });

  it("resolveDisputeAccessLevel resolves (does not reject) even when onArbitratorCheckError itself is omitted and isArbitrator throws", async () => {
    await expect(
      resolveDisputeAccessLevel({
        sessionAddress: UNRELATED_ADDRESS,
        requesterAddress: REQUESTER_ADDRESS,
        acceptedAgentAddress: AGENT_ADDRESS,
        isArbitrator: async () => {
          throw new Error("no observer attached");
        },
      }),
    ).resolves.toBe("public");
  });
});
