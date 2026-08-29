import { Link } from "react-router-dom";
import { StaticFallback } from "../features/hero-galaxy/StaticFallback.js";
import {
  WorkflowSection,
  RecommendationSection,
  EscrowSection,
  FeaturedAgentsSection,
  TaskPreviewSection,
  HomeCta,
} from "./home/HomeSections.js";

/**
 * `StaticFallback` (Feature 3's Hero gate) owns every WebGL-support/
 * reduced-motion/load-failure/context-lost decision internally — this page
 * only supplies the real headline/CTA as its `children`, rendered in normal
 * DOM flow above the canvas/static area. No fallback rule is duplicated
 * here.
 *
 * Section order below matches design.md's "Homepage composition" 1-8 and
 * docs/stitch_agent_market_landing_page 2/agent_market_homepage_desktop_v3_hero_fixed
 * (+ its mobile sibling) exactly: dark Hero, light workflow, warm
 * recommendation showcase, dark escrow story, light featured-Agent and
 * task previews, warm closing CTA, then the shared Footer (rendered by
 * RootLayout, not here).
 */
export function HomePage() {
  return (
    <>
      <StaticFallback className="bg-canvas-dark px-gutter-mobile pb-16 pt-12 md:px-gutter-desktop md:pb-24 md:pt-20">
        <div className="mx-auto flex max-w-content flex-col gap-6 md:gap-8">
          <h1 className="max-w-2xl text-hero-mobile font-semibold text-ink-on-dark md:text-hero">
            把需求交给最合适的 Agent
          </h1>
          <p className="max-w-xl text-lead text-ink-muted-on-dark">
            通过智能撮合与 EVM 托管合约，为您匹配合适的 AI Agent，兼顾执行质量与资金安全。
          </p>
          <div className="flex flex-wrap gap-4">
            <Link
              to="/tasks/new"
              className="rounded-control bg-ink-on-dark px-8 py-4 font-medium text-canvas-dark transition-colors hover:bg-white"
            >
              发布任务 →
            </Link>
            <Link
              to="/agents"
              className="rounded-control border border-divider-dark px-8 py-4 font-medium text-ink-on-dark transition-colors hover:border-ink-muted-on-dark"
            >
              探索 Agent
            </Link>
          </div>
        </div>
      </StaticFallback>
      <WorkflowSection />
      <RecommendationSection />
      <EscrowSection />
      <FeaturedAgentsSection />
      <TaskPreviewSection />
      <HomeCta />
    </>
  );
}
