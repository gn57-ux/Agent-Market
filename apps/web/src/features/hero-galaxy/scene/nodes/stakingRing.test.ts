import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createStakingRing } from "./stakingRing.js";

describe("createStakingRing", () => {
  it("keeps a constant ring thickness across a full pulse cycle (does not scale the band width)", () => {
    // Same class of bug scanWave.ts's Codex review caught: uniformly
    // scaling a fixed-width RingGeometry also scales its thickness. This
    // ring is rebuilt per update with a fixed band width instead.
    const ring = createStakingRing();
    const thicknesses: number[] = [];
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      ring.update(progress, { x: 1, y: 2, z: 0 });
      const geometry = ring.mesh.geometry as THREE.RingGeometry;
      const params = geometry.parameters as { innerRadius: number; outerRadius: number };
      thicknesses.push(params.outerRadius - params.innerRadius);
    }
    const [expected] = thicknesses;
    if (expected === undefined) {
      throw new Error("expected at least one recorded thickness");
    }
    for (const thickness of thicknesses) {
      expect(thickness).toBeCloseTo(expected, 5);
    }
  });

  it("centers the ring on the given position", () => {
    const ring = createStakingRing();
    ring.update(0.5, { x: 3, y: -2, z: 0 });
    expect(ring.mesh.position.x).toBeCloseTo(3, 10);
    expect(ring.mesh.position.y).toBeCloseTo(-2, 10);
    expect(ring.mesh.position.z).toBeCloseTo(0, 10);
  });

  it("disposes the previous geometry on each update (no leaked BufferGeometry per frame)", () => {
    const ring = createStakingRing();
    ring.update(0, { x: 0, y: 0, z: 0 });
    const firstGeometry = ring.mesh.geometry;
    const disposeSpy = vi.spyOn(firstGeometry, "dispose");
    ring.update(0.5, { x: 0, y: 0, z: 0 });
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(ring.mesh.geometry).not.toBe(firstGeometry);
  });

  it("starts hidden", () => {
    const ring = createStakingRing();
    expect(ring.mesh.visible).toBe(false);
  });

  it("update() makes the ring's material non-transparent-to-invisible (opacity > 0)", () => {
    // Codex review finding (P1): the material was constructed with
    // opacity: 0 and nothing ever changed it, so setting mesh.visible =
    // true during STAKE_LOCKED/EXECUTING/RESULT_RETURNED still rendered a
    // fully transparent (invisible) ring — the staking stage was silently
    // absent under normal execution.
    const ring = createStakingRing();
    const material = ring.mesh.material as THREE.MeshBasicMaterial;
    expect(material.opacity).toBe(0);

    ring.update(0.5, { x: 0, y: 0, z: 0 });
    expect(material.opacity).toBeGreaterThan(0);
  });
});
