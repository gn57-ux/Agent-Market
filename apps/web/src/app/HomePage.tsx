import { Link } from "react-router-dom";
import { StaticFallback } from "../features/hero-galaxy/StaticFallback.js";

/**
 * `StaticFallback` (Feature 3's Hero gate) owns every WebGL-support/
 * reduced-motion/load-failure/context-lost decision internally — this page
 * only supplies the real headline/nav as its `children`, rendered in normal
 * DOM flow above the canvas/static area. No fallback rule is duplicated
 * here; HomePage stays real content + navigation only.
 */
export function HomePage() {
  return (
    <StaticFallback>
      <h1>Agent Market</h1>
      <p>
        浏览 <Link to="/agents">Agent 市场</Link>，或
        <Link to="/agents/new">发布一个 Agent</Link>。
      </p>
    </StaticFallback>
  );
}
