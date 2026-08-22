import type { ReactNode } from "react";

export interface HeaderProps {
  children?: ReactNode;
}

/**
 * Global navigation shell. Per design.md's `navigation` component rule
 * ("translucent light or dark surface matching the current section; 48-52px
 * height") and docs/stitch_agent_market_landing_page 2's task-market/task-
 * detail reference exports (both use this exact blur+divider treatment) —
 * wordmark left, a flexible slot (nav links, wallet status, session
 * controls) right.
 *
 * `sticky`, not `fixed` (Codex review, T-505 round 1, P2): a fixed header
 * is removed from document flow, so RootLayout's `<main>` had to guess its
 * height with a hardcoded `pt-[52px]` offset — correct only while the nav
 * fits on one line. Once the wallet/session status is showing (address,
 * network, balance, logout) or the viewport narrows, this row's content
 * wraps to 2-3 lines and the fixed header silently overlaps page content,
 * since nothing changes the offset to match. `sticky` keeps the "stays
 * visible while scrolling" behavior but stays in normal flow, so whatever
 * height it actually renders at (one line or several) is exactly how much
 * space it reserves — no manual offset to keep in sync, and no overlap
 * possible by construction. `min-h-[52px]` keeps the 48-52px baseline
 * design.md specifies for the common one-line case; content wrapping
 * beyond that is now a supported layout state, not a bug.
 */
export function Header({ children }: HeaderProps) {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-divider-light bg-surface-light/80 backdrop-blur-md">
      <div className="mx-auto flex min-h-[52px] max-w-content flex-wrap items-center justify-between gap-y-2 px-gutter-mobile py-2 md:px-gutter-desktop">
        <strong className="text-title tracking-tight text-ink-primary">Agent Market</strong>
        <nav className="flex flex-wrap items-center gap-4 text-caption">{children}</nav>
      </div>
    </header>
  );
}
