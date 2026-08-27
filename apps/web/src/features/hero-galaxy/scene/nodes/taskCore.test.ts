import { describe, expect, it } from "vitest";
import type * as THREE from "three";
import { createTaskCore } from "./taskCore.js";
import { HERO_GALAXY_PALETTE } from "../palette.js";

describe("createTaskCore — T-303 setColor", () => {
  it("starts Cyber Blue", () => {
    const core = createTaskCore();
    const material = core.mesh.material as THREE.MeshBasicMaterial;
    expect(material.color.getHex()).toBe(HERO_GALAXY_PALETTE.cyberBlue);
  });

  it("setColor changes the wireframe color without affecting update()'s pulse/rotation", () => {
    const core = createTaskCore();
    core.setColor(HERO_GALAXY_PALETTE.settlementGreen);
    const material = core.mesh.material as THREE.MeshBasicMaterial;
    expect(material.color.getHex()).toBe(HERO_GALAXY_PALETTE.settlementGreen);

    core.update(1000);
    // update() must not reset the color back.
    expect(material.color.getHex()).toBe(HERO_GALAXY_PALETTE.settlementGreen);
  });
});
