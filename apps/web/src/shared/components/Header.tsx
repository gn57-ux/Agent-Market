import { useState, type ReactNode } from "react";

export interface HeaderProps {
  /** Page-navigation links (任务市场/Agent 市场/发布任务/我的发布/首页) — visible
   * inline on desktop, collapsed behind the hamburger toggle on mobile. */
  navLinks?: ReactNode;
  /** Wallet/session controls — per design.md's mobile-Hero guidance
   * ("连接钱包入口始终可找到"), these stay in the header bar itself on every
   * viewport and are never folded into the collapsible mobile menu. */
  walletControls?: ReactNode;
  /**
   * design.md's `navigation` rule: "translucent light or dark surface
   * matching the current section". Every business page (task market, task
   * detail, forms, ...) sits entirely on the light canvas, so "light" stays
   * the default. Only the homepage opens on the immersive black Hero
   * (docs/stitch_agent_market_landing_page 2/agent_market_homepage_desktop_v3_hero_fixed)
   * and passes "dark" explicitly.
   */
  variant?: "light" | "dark";
}

/**
 * Global navigation shell. Per design.md's `navigation` component rule
 * ("translucent light or dark surface matching the current section; 48-52px
 * height") and docs/stitch_agent_market_landing_page 2's task-market/task-
 * detail reference exports (both use this exact blur+divider treatment) —
 * wordmark left, nav links + wallet controls right.
 *
 * `sticky`, not `fixed` (Codex review, T-505 round 1, P2): a fixed header
 * is removed from document flow, so RootLayout's `<main>` had to guess its
 * height with a hardcoded `pt-[52px]` offset — correct only while the nav
 * fits on one line. `sticky` keeps the "stays visible while scrolling"
 * behavior but stays in normal flow, so whatever height it actually renders
 * at is exactly how much space it reserves.
 *
 * Mobile collapse (design.md's homepage-mobile guidance: "导航折叠，连接钱包入口
 * 始终可找到"; docs/stitch_agent_market_landing_page 2's mobile references'
 * hamburger icon): below `lg`, `navLinks` moves into a toggled dropdown
 * panel instead of wrapping onto a second/third header line — `walletControls`
 * stays inline in the header bar on every viewport, never behind the
 * toggle. Two separate slots (not one `children` blob, Codex review T-505
 * round 2 follow-up) because "which content collapses" is a decision only
 * this component can make correctly per viewport; a single opaque
 * `children` node gives it no way to separate the two.
 *
 * Cutoff is `lg` (1024px), not `md` (768px) (Task D fix): the real content
 * both slots carry — 6 nav links plus `walletControls`' wallet address/
 * network name/YD balance text/sign-in button — easily exceeds one line's
 * width at `md` and wraps/overlaps the wordmark on common desktop/tablet
 * widths between 768–1024px, which is exactly the reported bug. `lg` gives
 * that content room to stay on one line; below it, the existing hamburger
 * collapse already handles narrow widths correctly.
 *
 * The inner row uses `min-h-[52px]`, not a fixed `h-[52px]` (Task E manual
 * verification): `walletControls` (RootLayout's capsule around
 * `WalletConnectionStatus` + `SignInButton`) is itself `flex-wrap` and can
 * legitimately need two lines even at `lg`+ once a real wallet is BOTH
 * connected AND signed in (address + network + YD balance + "已登录：0x…" +
 * a logout button is a lot of text) — a fixed height clipped that second
 * line's content to overflow past the header's bottom edge and visually
 * float on top of whatever comes after it (the hero section, most
 * visibly). `min-h` lets the row grow when that happens, matching this
 * component's own `sticky`-not-`fixed` design (see the comment on the
 * `<header>` element below) — the header already stays in normal document
 * flow specifically so it reserves exactly the space it actually renders
 * at, whether that space is one line or two.
 */
export function Header({ navLinks, walletControls, variant = "light" }: HeaderProps) {
  const isDark = variant === "dark";
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header
      className={
        isDark
          ? "sticky top-0 z-50 w-full border-b border-divider-dark bg-canvas-dark/80 backdrop-blur-md"
          : "sticky top-0 z-50 w-full border-b border-divider-light bg-surface-light/80 backdrop-blur-md"
      }
    >
      <div className="mx-auto flex min-h-[52px] max-w-content items-center justify-between px-gutter-mobile py-2 md:px-gutter-desktop">
        <strong
          className={
            isDark
              ? "text-title tracking-tight text-ink-on-dark"
              : "text-title tracking-tight text-ink-primary"
          }
        >
          Agent Market
        </strong>

        <nav
          className={
            isDark
              ? "hidden items-center gap-4 text-caption text-ink-on-dark lg:flex"
              : "hidden items-center gap-4 text-caption lg:flex"
          }
        >
          {navLinks}
        </nav>

        <div className="flex items-center gap-3">
          <div
            className={
              isDark
                ? "hidden items-center gap-3 text-caption text-ink-on-dark lg:flex"
                : "hidden items-center gap-3 text-caption lg:flex"
            }
          >
            {walletControls}
          </div>
          {/* Always visible below `lg` per design.md ("连接钱包入口始终可找到") —
              duplicated from the desktop slot above rather than shared via
              CSS display toggles on one instance, since WalletProvider's
              live subscriptions are cheap to have mounted twice but a
              single instance couldn't be positioned in both the inline
              desktop row AND the mobile bar at once. */}
          <div className="flex items-center gap-2 text-caption lg:hidden">{walletControls}</div>
          {navLinks && (
            <button
              type="button"
              onClick={() => setMobileMenuOpen((open) => !open)}
              aria-expanded={mobileMenuOpen}
              aria-controls="header-mobile-nav"
              aria-label={mobileMenuOpen ? "关闭导航菜单" : "打开导航菜单"}
              className={
                isDark
                  ? "flex h-8 w-8 items-center justify-center rounded-control border border-divider-dark text-ink-on-dark lg:hidden"
                  : "flex h-8 w-8 items-center justify-center rounded-control border border-divider-light text-ink-primary lg:hidden"
              }
            >
              <span aria-hidden="true">{mobileMenuOpen ? "✕" : "☰"}</span>
            </button>
          )}
        </div>
      </div>

      {navLinks && mobileMenuOpen && (
        <nav
          id="header-mobile-nav"
          className={
            isDark
              ? "flex flex-col gap-1 border-t border-divider-dark bg-canvas-dark px-gutter-mobile py-3 text-caption text-ink-on-dark lg:hidden"
              : "flex flex-col gap-1 border-t border-divider-light bg-surface-light px-gutter-mobile py-3 text-caption lg:hidden"
          }
          onClick={() => setMobileMenuOpen(false)}
        >
          {navLinks}
        </nav>
      )}
    </header>
  );
}
