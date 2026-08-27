import * as THREE from "three";
import { HERO_GALAXY_PALETTE } from "../palette.js";

/**
 * The central task core: Cyber Blue, reads as the task's identity and
 * (per PRD §10.1) loosely evokes an "Escrow Reactor" since it also
 * represents the escrowed funds. Rendered as a wireframe icosahedron so the
 * "reactor" reads as a structured, verifiable object rather than a solid
 * blob — and so a subtle pulse/rotation suggests activity without any
 * bloom/emissive glow (PRD explicitly forbids 高强度 Bloom 或持续快速闪烁).
 */
export interface TaskCoreHandle {
  mesh: THREE.Mesh;
  /**
   * Advances the pulse/rotation as a pure function of total elapsed
   * animation time (ms) — not accumulated per-frame deltas — so repeated
   * calls with the same `elapsedMs` are idempotent and the motion never
   * drifts from dropped/duplicated frames.
   */
  update(elapsedMs: number): void;
  /**
   * Changes the wireframe color without touching the pulse/rotation state
   * (T-303, narrative stage 6 "链上结算": the task core "转化为可验证区
   * 块"，颜色变为绿色）. Cheap — a `THREE.Color#setHex` on the existing
   * material, no allocation/material swap — so callers may call it every
   * frame during SETTLED without churn, the same way `agentNodes.setState`
   * re-asserts color every call.
   */
  setColor(color: number): void;
}

const TASK_CORE_RADIUS = 0.6;
/** Scale swing around 1.0. Small enough to read as "breathing", not flashing. */
const PULSE_AMPLITUDE = 0.06;
/** Full pulse cycle duration — slow and ambient, per the anti-flicker NFR. */
const PULSE_PERIOD_MS = 4000;
/** Ambient rotation speed, radians/ms. */
const ROTATION_SPEED_RAD_PER_MS = 0.00015;

export function createTaskCore(): TaskCoreHandle {
  const geometry = new THREE.IcosahedronGeometry(TASK_CORE_RADIUS, 1);
  const material = new THREE.MeshBasicMaterial({
    color: HERO_GALAXY_PALETTE.cyberBlue,
    wireframe: true,
    transparent: true,
    opacity: 0.9,
  });
  const mesh = new THREE.Mesh(geometry, material);
  // Hidden until INTENT_CREATED ("意图进入：中央出现任务核心", PRD §10.1
  // stage 1); IDLE holds an empty/dormant network with no task core yet.
  // Visibility (not opacity) is the on/off switch T-302 uses; `opacity`
  // stays fixed so it remains available for T-303/T-305 to animate a real
  // fade transition without this module needing to change.
  mesh.visible = false;

  function update(elapsedMs: number): void {
    const pulse = 1 + PULSE_AMPLITUDE * Math.sin((elapsedMs / PULSE_PERIOD_MS) * Math.PI * 2);
    mesh.scale.setScalar(pulse);
    mesh.rotation.y = elapsedMs * ROTATION_SPEED_RAD_PER_MS;
    mesh.rotation.x = elapsedMs * ROTATION_SPEED_RAD_PER_MS * 0.5;
  }

  function setColor(color: number): void {
    material.color.setHex(color);
  }

  return { mesh, update, setColor };
}
