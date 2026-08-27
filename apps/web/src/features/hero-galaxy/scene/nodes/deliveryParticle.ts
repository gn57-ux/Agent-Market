import * as THREE from "three";
import { HERO_GALAXY_PALETTE } from "../palette.js";

/**
 * The EXECUTING / RESULT_RETURNED delivery visual (PRD §10.1 narrative
 * stage 5: "任务数据沿连线流向 Agent，成果粒子或成果摘要沿通道返回任务核
 * 心"). A single small particle traveling along the accepted candidate's
 * connection line — capped at one instance (NFR: capped particle counts, no
 * bloom) rather than a particle system.
 *
 * Color is caller-driven rather than fixed, because the two phases that use
 * this module carry different visual-semantic meaning per the PRD §10.1
 * color table:
 * - EXECUTING (task data flowing OUT to the Agent): Cyber Blue — "任务意图、
 *   平台路由".
 * - RESULT_RETURNED (result flowing BACK to the task core): Emerald Green —
 *   the color table lists green for BOTH "成果返回" and "验证成功和资金结
 *   算", so the return trip already reads as trending toward settlement here;
 *   SETTLED then completes that transformation on the task core itself
 *   (`taskCore.setColor`). This progressive green hand-off (particle turns
 *   green on the way back, then the core turns green once settlement is
 *   final) reads more legibly to a visual reviewer than only switching
 *   colors at the very last phase.
 */
export interface DeliveryParticleHandle {
  mesh: THREE.Mesh;
  /**
   * @param t Progress along the line in [0, 1]; values outside are clamped.
   * @param from World position the particle travels from.
   * @param to World position the particle travels to.
   * @param color Hex color for this leg of the trip (see module doc).
   */
  update(
    t: number,
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
    color: number,
  ): void;
}

const PARTICLE_RADIUS = 0.06;
const PARTICLE_SEGMENTS = 12;

export function createDeliveryParticle(): DeliveryParticleHandle {
  const geometry = new THREE.SphereGeometry(PARTICLE_RADIUS, PARTICLE_SEGMENTS, PARTICLE_SEGMENTS);
  const material = new THREE.MeshBasicMaterial({
    color: HERO_GALAXY_PALETTE.cyberBlue,
    transparent: true,
    opacity: 0.9,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.visible = false;

  function update(
    t: number,
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
    color: number,
  ): void {
    const clamped = Math.min(Math.max(t, 0), 1);
    mesh.position.set(
      from.x + (to.x - from.x) * clamped,
      from.y + (to.y - from.y) * clamped,
      from.z + (to.z - from.z) * clamped,
    );
    material.color.setHex(color);
  }

  return { mesh, update };
}
