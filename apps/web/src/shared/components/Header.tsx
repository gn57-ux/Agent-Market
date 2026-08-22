import type { ReactNode } from "react";

export interface HeaderProps {
  children?: ReactNode;
}

/**
 * Global navigation shell. Per design.md's `navigation` component rule
 * ("translucent light or dark surface matching the current section; 48-52px
 * height") and docs/stitch_agent_market_landing_page 2's task-market/task-
 * detail reference exports (both use this exact fixed+blur+divider
 * treatment) — wordmark left, a flexible slot (nav links, wallet status,
 * session controls) right. Content wrapping (max width, gutter) mirrors
 * design.md's `layout` tokens and matches how <main> is wrapped in
 * app/RootLayout.tsx, so the header and page content align.
 */
export function Header({ children }: HeaderProps) {
  return (
    <header className="fixed top-0 z-50 w-full border-b border-divider-light bg-surface-light/80 backdrop-blur-md">
      <div className="mx-auto flex h-[52px] max-w-content items-center justify-between px-gutter-mobile md:px-gutter-desktop">
        <strong className="text-title tracking-tight text-ink-primary">Agent Market</strong>
        <nav className="flex flex-wrap items-center gap-4 text-caption">{children}</nav>
      </div>
    </header>
  );
}
