import * as THREE from "three";
import { HERO_GALAXY_PALETTE } from "../palette.js";

/**
 * The MATCHING-phase "scanning wave": an expanding ring, centered on the
 * task core, that sweeps outward toward the Agent node ring (PRD §10.1
 * narrative stage 2: "智能扫描：扫描波经过外围 Agent 节点"). Driven purely
 * by an externally-supplied `progress` in [0, 1] (the caller derives this
 * from the phase clock's time-within-MATCHING) — this module has no timer
 * of its own.
 *
 * Opacity follows a sin(π·progress) curve: zero at the start and end of the
 * sweep, peaking at the midpoint. That reads as a soft pulse of light
 * traveling outward rather than a hard-edged flash, per the NFR forbidding
 * high-intensity bloom / rapid flashing.
 */
export interface ScanWaveHandle {
  mesh: THREE.Mesh;
  /**
   * @param progress Sweep progress in [0, 1]; values outside that range are
   *   clamped. 0 = wave at the task core, 1 = wave has passed the outer
   *   node ring.
   * @param ringRadius Radius the wave should sweep out to (matches the
   *   Agent node ring's radius, so the wave "arrives" at the nodes).
   */
  update(progress: number, ringRadius: number): void;
}

const SCAN_WAVE_SEGMENTS = 48;
const SCAN_WAVE_THICKNESS = 0.03;
const MIN_SCAN_WAVE_RADIUS = 0.05;
/** Peak opacity at progress=0.5 — kept low/soft, no bloom. */
const PEAK_OPACITY = 0.35;

export function createScanWave(): ScanWaveHandle {
  // The initial geometry is a placeholder immediately replaced by the first
  // `update()` call — `mesh.geometry` is rebuilt on every update (see below)
  // rather than resized via `mesh.scale`, so this starting radius doesn't
  // matter beyond being valid.
  let geometry = new THREE.RingGeometry(
    MIN_SCAN_WAVE_RADIUS,
    MIN_SCAN_WAVE_RADIUS + SCAN_WAVE_THICKNESS,
    SCAN_WAVE_SEGMENTS,
  );
  const material = new THREE.MeshBasicMaterial({
    color: HERO_GALAXY_PALETTE.cyberBlue,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.visible = false;

  function update(progress: number, ringRadius: number): void {
    const clamped = Math.min(Math.max(progress, 0), 1);
    const innerRadius = MIN_SCAN_WAVE_RADIUS + clamped * Math.max(ringRadius, MIN_SCAN_WAVE_RADIUS);

    // Rebuild the ring geometry with a fixed `SCAN_WAVE_THICKNESS` band at
    // the new radius, instead of uniformly scaling a fixed-width ring
    // (which scaled the band's thickness right along with its radius — at
    // progress 0.5 the "thin scanning band" ballooned to nearly the size of
    // the swept area). The old geometry is disposed to avoid leaking one
    // BufferGeometry per frame over the animation's repeating loop.
    const previousGeometry = geometry;
    geometry = new THREE.RingGeometry(
      innerRadius,
      innerRadius + SCAN_WAVE_THICKNESS,
      SCAN_WAVE_SEGMENTS,
    );
    mesh.geometry = geometry;
    previousGeometry.dispose();

    material.opacity = PEAK_OPACITY * Math.sin(Math.PI * clamped);
  }

  return { mesh, update };
}
