import * as THREE from "three";
import { HERO_GALAXY_PALETTE } from "../palette.js";

/**
 * The STAKE_LOCKED-phase staking ring: an Orange ring centered on the
 * accepted candidate's Agent node, representing "预算 6% 的履约质押已经锁定"
 * (PRD §10.1 narrative stage 4). The 6% figure itself is not rendered as a
 * literal metric anywhere (per F-308/AC-306, this animation must not read as
 * a live dashboard) — it only informed how the ring is sized relative to the
 * Agent node it encircles (`BASE_RING_RADIUS` sits just outside the node's
 * own radius, evoking "a band locked around the accepted Agent" rather than
 * a generic decoration).
 *
 * Follows `scanWave.ts`'s pattern: geometry is rebuilt (not `mesh.scale`d)
 * on every `update()` call, keeping a fixed `RING_THICKNESS` band regardless
 * of the ring's radius — `scanWave.ts`'s Codex-review fix documented why
 * uniform scaling of a fixed-width RingGeometry is wrong (it scales
 * thickness right along with radius); this module never repeats that.
 */
export interface StakingRingHandle {
  mesh: THREE.Mesh;
  /**
   * @param pulseProgress A continuous [0, 1) sawtooth (the caller derives it
   *   from accumulated *active* elapsed time, not the raw RAF timestamp —
   *   same rationale as `taskCore.update`'s `activeElapsedMs`: driving this
   *   from wall-clock time would jump the pulse on `resume()` after a
   *   `pause()`). Drives a slow, low-amplitude "breathing" radius — no
   *   bloom, no rapid flashing, per the NFR.
   * @param centerPosition World position (the accepted Agent node's fixed
   *   ring position) to center the staking ring on.
   */
  update(pulseProgress: number, centerPosition: { x: number; y: number; z: number }): void;
}

const RING_SEGMENTS = 32;
const RING_THICKNESS = 0.035;
/** Sits just outside the Agent node's own sphere radius (0.18, agentNodes.ts). */
const BASE_RING_RADIUS = 0.26;
/** Amplitude of the slow "breathing" radius swing. Small — reads as alive, not animated decoration. */
const PULSE_RADIUS_AMPLITUDE = 0.04;
const MIN_RING_RADIUS = 0.05;
/**
 * Fixed opacity applied on every `update()` call. Codex review (P1): the
 * material was constructed with `opacity: 0` and nothing ever changed it
 * afterward, so the ring stayed fully transparent for the entire
 * STAKE_LOCKED/EXECUTING/RESULT_RETURNED span even with `mesh.visible =
 * true` — the staking stage was silently invisible under normal execution.
 * A fixed (not pulse-linked) opacity keeps the "breathing" effect purely in
 * the radius, per the NFR against rapid flashing/bloom.
 */
const RING_OPACITY = 0.85;

export function createStakingRing(): StakingRingHandle {
  let geometry = new THREE.RingGeometry(
    BASE_RING_RADIUS,
    BASE_RING_RADIUS + RING_THICKNESS,
    RING_SEGMENTS,
  );
  const material = new THREE.MeshBasicMaterial({
    color: HERO_GALAXY_PALETTE.stakingOrange,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.visible = false;

  function update(
    pulseProgress: number,
    centerPosition: { x: number; y: number; z: number },
  ): void {
    mesh.position.set(centerPosition.x, centerPosition.y, centerPosition.z);
    material.opacity = RING_OPACITY;

    const clamped = Math.min(Math.max(pulseProgress, 0), 1);
    const innerRadius = Math.max(
      BASE_RING_RADIUS + PULSE_RADIUS_AMPLITUDE * Math.sin(clamped * Math.PI * 2),
      MIN_RING_RADIUS,
    );

    const previousGeometry = geometry;
    geometry = new THREE.RingGeometry(innerRadius, innerRadius + RING_THICKNESS, RING_SEGMENTS);
    mesh.geometry = geometry;
    previousGeometry.dispose();
  }

  return { mesh, update };
}
