import { describe, expect, it } from "vitest";
import type * as THREE from "three";
import { createAgentNodeNetwork } from "./agentNodes.js";
import { HERO_GALAXY_PALETTE } from "../palette.js";

describe("createAgentNodeNetwork — T-303 candidate/staking/settlement states", () => {
  it("topScore is Amethyst Purple, full opacity, enlarged relative to eligible", () => {
    const network = createAgentNodeNetwork(4, 2);
    network.setState(0, "eligible");
    const eligibleScale = network.nodes[0]?.scale.x;

    network.setState(0, "topScore");
    const node = network.nodes[0];
    if (!node) {
      throw new Error("expected a node at index 0");
    }
    const material = node.material as THREE.MeshBasicMaterial;
    expect(material.color.getHex()).toBe(HERO_GALAXY_PALETTE.amethystPurple);
    expect(material.opacity).toBe(1);
    expect(node.scale.x).toBeGreaterThan(eligibleScale ?? 1);
  });

  it("exploration uses explorationPurple, distinct from topScore's amethystPurple", () => {
    const network = createAgentNodeNetwork(4, 2);
    network.setState(1, "exploration");
    const node = network.nodes[1];
    if (!node) {
      throw new Error("expected a node at index 1");
    }
    const material = node.material as THREE.MeshBasicMaterial;
    expect(material.color.getHex()).toBe(HERO_GALAXY_PALETTE.explorationPurple);
    expect(material.color.getHex()).not.toBe(HERO_GALAXY_PALETTE.amethystPurple);
  });

  it("accepted uses stakingOrange", () => {
    const network = createAgentNodeNetwork(4, 2);
    network.setState(2, "accepted");
    const node = network.nodes[2];
    if (!node) {
      throw new Error("expected a node at index 2");
    }
    const material = node.material as THREE.MeshBasicMaterial;
    expect(material.color.getHex()).toBe(HERO_GALAXY_PALETTE.stakingOrange);
  });

  it("settled uses settlementGreen", () => {
    const network = createAgentNodeNetwork(4, 2);
    network.setState(3, "settled");
    const node = network.nodes[3];
    if (!node) {
      throw new Error("expected a node at index 3");
    }
    const material = node.material as THREE.MeshBasicMaterial;
    expect(material.color.getHex()).toBe(HERO_GALAXY_PALETTE.settlementGreen);
  });

  it("switching back to idle/eligible/disqualified still resets scale to 1 (additive, does not break T-302 states)", () => {
    const network = createAgentNodeNetwork(4, 2);
    network.setState(0, "topScore");
    network.setState(0, "eligible");
    const node = network.nodes[0];
    if (!node) {
      throw new Error("expected a node at index 0");
    }
    expect(node.scale.x).toBeCloseTo(1, 10);
  });
});
