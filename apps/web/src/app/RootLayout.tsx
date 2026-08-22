import { Link, NavLink, Outlet } from "react-router-dom";
import { Header, Footer } from "../shared/components/index.js";
import { WalletConnectionStatus } from "../features/wallet/WalletProvider.js";
import { SignInButton } from "../features/session/SignInButton.js";

const NAV_LINK_CLASSES = "text-ink-secondary transition-colors hover:text-action-blue";
const NAV_LINK_ACTIVE_CLASSES = "text-action-blue font-medium";

/** Shared chrome for every routed page — nav links, wallet status, session
 * login. router.tsx nests every page's route element inside this via
 * `<Outlet />`. No manual top offset on `<main>` (Codex review, T-505
 * round 1, P2): Header is `sticky`, not `fixed`, so it stays in normal
 * document flow and reserves exactly the space it actually renders at —
 * whether that's one line or several once the nav wraps. A fixed offset
 * here would only be correct for the one-line case and would start
 * overlapping content the moment the header grew taller than that. */
export function RootLayout() {
  return (
    <div className="flex min-h-screen flex-col">
      <Header>
        <NavLink
          to="/tasks"
          className={({ isActive }) =>
            isActive ? `${NAV_LINK_CLASSES} ${NAV_LINK_ACTIVE_CLASSES}` : NAV_LINK_CLASSES
          }
        >
          任务市场
        </NavLink>
        <NavLink
          to="/agents"
          className={({ isActive }) =>
            isActive ? `${NAV_LINK_CLASSES} ${NAV_LINK_ACTIVE_CLASSES}` : NAV_LINK_CLASSES
          }
        >
          Agent 市场
        </NavLink>
        <NavLink
          to="/tasks/new"
          className={({ isActive }) =>
            isActive ? `${NAV_LINK_CLASSES} ${NAV_LINK_ACTIVE_CLASSES}` : NAV_LINK_CLASSES
          }
        >
          发布任务
        </NavLink>
        <NavLink
          to="/tasks/mine"
          className={({ isActive }) =>
            isActive ? `${NAV_LINK_CLASSES} ${NAV_LINK_ACTIVE_CLASSES}` : NAV_LINK_CLASSES
          }
        >
          我的发布
        </NavLink>
        <Link to="/" className={NAV_LINK_CLASSES}>
          首页
        </Link>
        <WalletConnectionStatus />
        <SignInButton />
      </Header>
      <main className="flex-grow">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
