import { Link, NavLink, Outlet } from "react-router-dom";
import { Header, Footer } from "../shared/components/index.js";
import { WalletConnectionStatus } from "../features/wallet/WalletProvider.js";
import { SignInButton } from "../features/session/SignInButton.js";

const NAV_LINK_CLASSES = "text-ink-secondary transition-colors hover:text-action-blue";
const NAV_LINK_ACTIVE_CLASSES = "text-action-blue font-medium";

/** Shared chrome for every routed page — nav links, wallet status, session
 * login. router.tsx nests every page's route element inside this via
 * `<Outlet />`. `pt-[52px]` on `<main>` clears the fixed-height Header
 * (design.md's navigation token: "48-52px height"); each page's own
 * top-level section supplies its own breathing room below that. */
export function RootLayout() {
  return (
    <div className="flex min-h-screen flex-col">
      <Header>
        <NavLink
          to="/agents"
          className={({ isActive }) =>
            isActive ? `${NAV_LINK_CLASSES} ${NAV_LINK_ACTIVE_CLASSES}` : NAV_LINK_CLASSES
          }
        >
          Agent 市场
        </NavLink>
        <Link to="/" className={NAV_LINK_CLASSES}>
          首页
        </Link>
        <WalletConnectionStatus />
        <SignInButton />
      </Header>
      <main className="flex-grow pt-[52px]">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
