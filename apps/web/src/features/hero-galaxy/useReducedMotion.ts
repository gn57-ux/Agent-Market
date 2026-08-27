import { useEffect, useState } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function readPrefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * Tracks the `prefers-reduced-motion` OS/browser setting live (F-306). A
 * visitor can toggle this setting while the page stays open, so the
 * static-vs-dynamic choice must follow the change without a reload — unlike
 * `useWebglSupport`, this needs a `change` listener, not just a one-time
 * read.
 */
export function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(readPrefersReducedMotion);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mediaQueryList = window.matchMedia(REDUCED_MOTION_QUERY);
    const handleChange = () => setReducedMotion(mediaQueryList.matches);
    mediaQueryList.addEventListener("change", handleChange);
    return () => mediaQueryList.removeEventListener("change", handleChange);
  }, []);

  return reducedMotion;
}
