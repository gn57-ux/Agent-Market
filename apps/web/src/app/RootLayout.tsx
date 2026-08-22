import { Link, Outlet } from "react-router-dom";
import { Header, Footer } from "../shared/components/index.js";
import { WalletConnectionStatus } from "../features/wallet/WalletProvider.js";
import { SignInButton } from "../features/session/SignInButton.js";

/** Shared chrome for every routed page — nav links, wallet status, session
 * login. router.tsx nests every page's route element inside this via
 * `<Outlet />`. */
export function RootLayout() {
  return (
    <>
      <Header>
        <Link to="/">首页</Link> <Link to="/agents">Agent 市场</Link>
        <WalletConnectionStatus />
        <SignInButton />
      </Header>
      <main>
        <Outlet />
      </main>
      <Footer />
    </>
  );
}
