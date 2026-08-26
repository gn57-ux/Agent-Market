import { describe, expect, it } from "vitest";
import { isAuthorizedForDeliverableAccess } from "./access-guard.js";

const REQUESTER = "0x1111111111111111111111111111111111111111";
const AGENT = "0x2222222222222222222222222222222222222222";
const STRANGER = "0x3333333333333333333333333333333333333333";

describe("isAuthorizedForDeliverableAccess", () => {
  it("authorizes the requester", () => {
    expect(
      isAuthorizedForDeliverableAccess(
        { requesterAddress: REQUESTER, acceptedAgentAddress: AGENT },
        REQUESTER,
      ),
    ).toBe(true);
  });

  it("authorizes the accepted Agent", () => {
    expect(
      isAuthorizedForDeliverableAccess(
        { requesterAddress: REQUESTER, acceptedAgentAddress: AGENT },
        AGENT,
      ),
    ).toBe(true);
  });

  it("rejects a stranger", () => {
    expect(
      isAuthorizedForDeliverableAccess(
        { requesterAddress: REQUESTER, acceptedAgentAddress: AGENT },
        STRANGER,
      ),
    ).toBe(false);
  });

  it("rejects anyone when the task has no accepted Agent yet", () => {
    expect(
      isAuthorizedForDeliverableAccess(
        { requesterAddress: REQUESTER, acceptedAgentAddress: null },
        STRANGER,
      ),
    ).toBe(false);
  });

  it("is case-insensitive on both sides", () => {
    expect(
      isAuthorizedForDeliverableAccess(
        { requesterAddress: REQUESTER.toUpperCase(), acceptedAgentAddress: AGENT },
        REQUESTER,
      ),
    ).toBe(true);
    expect(
      isAuthorizedForDeliverableAccess(
        { requesterAddress: REQUESTER, acceptedAgentAddress: AGENT },
        AGENT.toUpperCase(),
      ),
    ).toBe(true);
  });
});
