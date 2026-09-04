import { describe, expect, it } from "vitest";
import { validateTopology, type TopologyNodeInput } from "./topology.js";

function node(
  key: string,
  dependsOn: string[] = [],
  role: TopologyNodeInput["role"] = "SERIAL",
): TopologyNodeInput {
  return { key, role, dependsOn };
}

describe("validateTopology", () => {
  it("accepts a single node with no dependencies", () => {
    expect(validateTopology([node("a")])).toEqual({ ok: true });
  });

  it("accepts a serial chain (AC-1701's three-node scenario)", () => {
    const nodes = [node("a"), node("b", ["a"]), node("c", ["b"])];
    expect(validateTopology(nodes)).toEqual({ ok: true });
  });

  it("accepts two parallel nodes feeding a shared aggregate node (AC-1702's scenario)", () => {
    const nodes = [
      node("a", [], "PARALLEL"),
      node("b", [], "PARALLEL"),
      node("c", ["a", "b"], "AGGREGATE"),
    ];
    expect(validateTopology(nodes)).toEqual({ ok: true });
  });

  it("rejects a duplicate node key", () => {
    const result = validateTopology([node("a"), node("a")]);
    expect(result).toMatchObject({ ok: false, reason: "DUPLICATE_KEY" });
  });

  it("rejects a dependency on a node key that doesn't exist in the submission", () => {
    const result = validateTopology([node("a", ["ghost"])]);
    expect(result).toMatchObject({ ok: false, reason: "DANGLING_DEPENDENCY" });
  });

  it("rejects a two-node cycle (a depends on b, b depends on a)", () => {
    const result = validateTopology([node("a", ["b"]), node("b", ["a"])]);
    expect(result).toMatchObject({ ok: false, reason: "CYCLE" });
  });

  it("rejects a self-loop (a node depending on itself)", () => {
    const result = validateTopology([node("a", ["a"])]);
    expect(result).toMatchObject({ ok: false, reason: "CYCLE" });
  });

  it("rejects a longer cycle buried among otherwise-valid nodes", () => {
    const nodes = [node("entry"), node("a", ["entry", "c"]), node("b", ["a"]), node("c", ["b"])];
    const result = validateTopology(nodes);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("CYCLE");
  });

  it("rejects an AGGREGATE node declared with zero preconditions", () => {
    const result = validateTopology([node("a", [], "AGGREGATE")]);
    expect(result).toMatchObject({ ok: false, reason: "AGGREGATE_WITHOUT_PRECONDITION" });
  });

  it("accepts an AGGREGATE node with exactly one precondition (not required to have 2+)", () => {
    const nodes = [node("a"), node("b", ["a"], "AGGREGATE")];
    expect(validateTopology(nodes)).toEqual({ ok: true });
  });

  it("accepts an empty node list (caller decides whether zero nodes is itself an error, not this function)", () => {
    expect(validateTopology([])).toEqual({ ok: true });
  });
});
