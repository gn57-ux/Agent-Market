import { useEffect, useState } from "react";

/** Tracks whether a CSS media query currently matches. jsdom (the test
 * environment) has no real layout engine, so tests mock window.matchMedia
 * directly rather than resizing anything. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mediaQueryList = window.matchMedia(query);
    const handleChange = () => setMatches(mediaQueryList.matches);

    handleChange();
    mediaQueryList.addEventListener("change", handleChange);
    return () => mediaQueryList.removeEventListener("change", handleChange);
  }, [query]);

  return matches;
}
