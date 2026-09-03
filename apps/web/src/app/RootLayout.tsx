import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { Header, Footer } from "../shared/components/index.js";
import { WalletConnectionStatus } from "../features/wallet/WalletProvider.js";
import { SignInButton } from "../features/session/SignInButton.js";

const NAV_LINK_CLASSES = "text-ink-secondary transition-colors hover:text-action-blue";
const NAV_LINK_ACTIVE_CLASSES = "text-action-blue font-medium";
const NAV_LINK_CLASSES_DARK =
  "text-ink-muted-on-dark transition-colors hover:text-action-blue-on-dark";
const NAV_LINK_ACTIVE_CLASSES_DARK = "text-action-blue-on-dark font-medium";

/** Shared chrome for every routed page — nav links, wallet status, session
 * login. router.tsx nests every page's route element inside this via
 * `<Outlet />`. No manual top offset on `<main>` (Codex review, T-505
 * round 1, P2): Header is `sticky`, not `fixed`, so it stays in normal
 * document flow and reserves exactly the space it actually renders at —
 * whether that's one line or several once the nav wraps. A fixed offset
 * here would only be correct for the one-line case and would start
 * overlapping content the moment the header grew taller than that.
 *
 * Header variant: only the homepage opens on design.md's immersive black
 * Hero canvas; every other route is entirely on the light canvas (design.md
 * §"Light and dark allocation": "Never place long forms, dense tables or
 * routine wallet flows on black"). `useLocation` keyed off the index route
 * is simpler than threading a variant prop through every page component for
 * a chrome-only decision RootLayout already owns.
 *
 * `navLinks`/`walletControls` passed as two separate props (not one
 * `children` blob) — Header.tsx collapses `navLinks` behind a mobile
 * hamburger toggle and keeps `walletControls` inline on every viewport
 * (design.md's mobile-homepage guidance: "导航折叠，连接钱包入口始终可找到"); only
 * Header can make that per-viewport split correctly, so RootLayout hands it
 * the two groups pre-separated instead of one opaque node.
 */
export function RootLayout() {
  const { pathname } = useLocation();
  const isHome = pathname === "/";
  const linkClasses = isHome ? NAV_LINK_CLASSES_DARK : NAV_LINK_CLASSES;
  const activeLinkClasses = isHome ? NAV_LINK_ACTIVE_CLASSES_DARK : NAV_LINK_ACTIVE_CLASSES;
  return (
    <div className="flex min-h-screen flex-col">
      <Header
        variant={isHome ? "dark" : "light"}
        navLinks={
          <>
            <NavLink
              to="/tasks"
              className={({ isActive }) =>
                isActive ? `${linkClasses} ${activeLinkClasses}` : linkClasses
              }
            >
              任务市场
            </NavLink>
            <NavLink
              to="/agents"
              className={({ isActive }) =>
                isActive ? `${linkClasses} ${activeLinkClasses}` : linkClasses
              }
            >
              Agent 市场
            </NavLink>
            <NavLink
              to="/tasks/new"
              className={({ isActive }) =>
                isActive ? `${linkClasses} ${activeLinkClasses}` : linkClasses
              }
            >
              发布任务
            </NavLink>
            <NavLink
              to="/tasks/mine"
              className={({ isActive }) =>
                isActive ? `${linkClasses} ${activeLinkClasses}` : linkClasses
              }
            >
              我的发布
            </NavLink>
            <NavLink
              to="/tasks/accepted"
              className={({ isActive }) =>
                isActive ? `${linkClasses} ${activeLinkClasses}` : linkClasses
              }
            >
              我的接单
            </NavLink>
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                isActive ? `${linkClasses} ${activeLinkClasses}` : linkClasses
              }
            >
              管理
            </NavLink>
            <Link to="/" className={linkClasses}>
              首页
            </Link>
            <NavLink
              to="/office"
              className={({ isActive }) =>
                isActive ? `${linkClasses} ${activeLinkClasses}` : linkClasses
              }
            >
              虚拟工作室
            </NavLink>
          </>
        }
        walletControls={
          // WalletConnectionStatus/SignInButton/WalletButton accept the same
          // `light`/`dark` variant Header itself already uses (Task E
          // review: a flat `bg-surface-light` capsule on the homepage's dark
          // Hero directly contradicted design.md's own `navigation` rule —
          // "translucent light OR DARK surface matching the current
          // section" — reading as a mismatched white sticker rather than
          // part of the same surface). The dark capsule mirrors
          // HomeSections.tsx's own established raised-panel-on-dark-canvas
          // treatment (`border-divider-dark bg-surface-dark-raised`) plus
          // the translucency + blur `Header` already applies to itself, so
          // the capsule reads as one coordinated frosted-glass surface
          // rather than either a flat block or the header's own background
          // showing straight through.
          <div
            className={
              isHome
                ? "flex flex-wrap items-center gap-3 rounded-control border border-divider-dark bg-surface-dark-raised/90 px-3 py-1 backdrop-blur-md"
                : "flex flex-wrap items-center gap-3"
            }
          >
            <WalletConnectionStatus variant={isHome ? "dark" : "light"} />
            <SignInButton variant={isHome ? "dark" : "light"} />
          </div>
        }
      />
      <main className="flex-grow">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
