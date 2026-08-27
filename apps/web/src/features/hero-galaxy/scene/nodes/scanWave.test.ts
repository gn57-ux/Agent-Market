import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createScanWave } from "./scanWave.js";

describe("createScanWave", () => {
  it("keeps a constant ring thickness as it expands (does not scale the band width)", () => {
    // Codex review finding: uniformly scaling a fixed-width RingGeometry
    // also scaled its thickness, so the "thin scanning band" ballooned as
    // it expanded. The geometry is now rebuilt per update with a fixed
    // band width — verify outer minus inner radius stays constant across a
    // range of progress values.
    const wave = createScanWave();
    const thicknessesAtProgress: number[] = [];

    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      wave.update(progress, 3.2);
      const geometry = wave.mesh.geometry as THREE.RingGeometry;
      const params = geometry.parameters as { innerRadius: number; outerRadius: number };
      thicknessesAtProgress.push(params.outerRadius - params.innerRadius);
    }

    const [expectedThickness] = thicknessesAtProgress;
    if (expectedThickness === undefined) {
      throw new Error("expected at least one recorded thickness");
    }
    for (const thickness of thicknessesAtProgress) {
      expect(thickness).toBeCloseTo(expectedThickness, 5);
    }
  });

  it("grows the inner radius toward ringRadius as progress increases", () => {
    const wave = createScanWave();
    wave.update(0, 3.2);
    const at0 = (wave.mesh.geometry as THREE.RingGeometry).parameters.innerRadius;
    wave.update(1, 3.2);
    const at1 = (wave.mesh.geometry as THREE.RingGeometry).parameters.innerRadius;
    expect(at1).toBeGreaterThan(at0);
  });

  it("disposes the previous geometry on each update (no leaked BufferGeometry per frame)", () => {
    const wave = createScanWave();
    wave.update(0, 3.2);
    const firstGeometry = wave.mesh.geometry;
    const disposeSpy = vi.spyOn(firstGeometry, "dispose");
    wave.update(0.5, 3.2);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(wave.mesh.geometry).not.toBe(firstGeometry);
  });
});
