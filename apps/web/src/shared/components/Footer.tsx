const FOOTER_LINKS = ["Privacy", "Terms", "Docs", "Support"];

/** Restrained warm-gray footer (design.md's homepage composition step 7:
 * "a restrained warm-gray footer"; docs/stitch_agent_market_landing_page 2's
 * homepage export's bottom block), reused across every page via
 * app/RootLayout.tsx. The homepage-only CTA heading/button that visually
 * precedes this in the Stitch export is a separate `HomeCta` section on
 * HomePage itself, not folded into this shared component — every other
 * route renders straight into this Footer with no CTA above it, so the
 * CTA copy has no business meaning here. */
export function Footer() {
  return (
    <footer className="mt-auto border-t border-divider-light bg-canvas-warm py-section-mobile md:py-section-desktop">
      <div className="mx-auto flex max-w-content flex-col items-center gap-4 px-gutter-mobile text-center md:px-gutter-desktop">
        <strong className="text-title text-ink-primary">Agent Market</strong>
        {/* Codex review (N4, P2): these were real `<a href="#">` anchors —
            since Privacy/Terms/Docs/Support have no real destination page
            yet, an actual clickable link that silently no-ops (or jumps to
            the page top) misrepresents itself as navigation. Non-interactive
            text keeps the same visual row without promising a destination
            that doesn't exist; swap back to real `<Link>`s once those pages
            are built. */}
        <div className="flex flex-wrap justify-center gap-6" aria-hidden="true">
          {FOOTER_LINKS.map((label) => (
            <span key={label} className="text-caption text-ink-secondary">
              {label}
            </span>
          ))}
        </div>
        <small className="text-caption text-ink-secondary">
          © 2026 Agent Market. All rights reserved.
        </small>
      </div>
    </footer>
  );
}
