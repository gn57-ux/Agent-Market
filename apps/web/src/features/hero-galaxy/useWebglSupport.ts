import { useState } from "react";

/**
 * Feature-detects WebGL availability via a throwaway canvas, without ever
 * constructing the real `THREE.WebGLRenderer` or importing the scene chunk
 * (F-305: "WebGL 不可用...时自动切换静态背景"). Safe to call before deciding
 * whether the dynamic `import()` that pulls in Three.js is worth issuing at
 * all.
 */
export function isWebglSupported(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * React hook wrapping `isWebglSupported()`. Computed once (lazily) per
 * component instance — support does not change over a page's lifetime, so
 * there is no listener to wire up (contrast `useReducedMotion`, which does
 * need one).
 */
export function useWebglSupport(): boolean {
  const [supported] = useState(isWebglSupported);
  return supported;
}
