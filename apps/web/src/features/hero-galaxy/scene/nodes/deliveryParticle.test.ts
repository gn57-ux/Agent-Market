import { describe, expect, it } from "vitest";
import { HERO_GALAXY_PALETTE } from "../palette.js";
import { createDeliveryParticle } from "./deliveryParticle.js";

describe("createDeliveryParticle", () => {
  it("starts hidden", () => {
    const particle = createDeliveryParticle();
    expect(particle.mesh.visible).toBe(false);
  });

  it("interpolates position linearly between from and to as t goes 0 -> 1", () => {
    const particle = createDeliveryParticle();
    const from = { x: 0, y: 0, z: 0 };
    const to = { x: 10, y: 0, z: 0 };

    particle.update(0, from, to, HERO_GALAXY_PALETTE.cyberBlue);
    expect(particle.mesh.position.x).toBeCloseTo(0, 10);

    particle.update(0.5, from, to, HERO_GALAXY_PALETTE.cyberBlue);
    expect(particle.mesh.position.x).toBeCloseTo(5, 10);

    particle.update(1, from, to, HERO_GALAXY_PALETTE.cyberBlue);
    expect(particle.mesh.position.x).toBeCloseTo(10, 10);
  });

  it("clamps t outside [0, 1]", () => {
    const particle = createDeliveryParticle();
    const from = { x: 0, y: 0, z: 0 };
    const to = { x: 10, y: 0, z: 0 };

    particle.update(-5, from, to, HERO_GALAXY_PALETTE.cyberBlue);
    expect(particle.mesh.position.x).toBeCloseTo(0, 10);

    particle.update(5, from, to, HERO_GALAXY_PALETTE.cyberBlue);
    expect(particle.mesh.position.x).toBeCloseTo(10, 10);
  });

  it("applies the caller-supplied color for each leg of the trip", () => {
    const particle = createDeliveryParticle();
    const material = particle.mesh.material as import("three").MeshBasicMaterial;

    particle.update(0.5, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, HERO_GALAXY_PALETTE.cyberBlue);
    expect(material.color.getHex()).toBe(HERO_GALAXY_PALETTE.cyberBlue);

    particle.update(
      0.5,
      { x: 1, y: 1, z: 0 },
      { x: 0, y: 0, z: 0 },
      HERO_GALAXY_PALETTE.settlementGreen,
    );
    expect(material.color.getHex()).toBe(HERO_GALAXY_PALETTE.settlementGreen);
  });
});
