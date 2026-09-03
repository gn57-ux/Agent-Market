import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { WalletProvider } from "./features/wallet/WalletProvider.js";
import { SessionProvider } from "./features/session/SessionProvider.js";
import { PrivyAppProvider } from "./features/session/privy/PrivyAppProvider.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root not found");
}

createRoot(container).render(
  <StrictMode>
    <WalletProvider>
      {/* Must wrap SessionProvider: SessionProvider.loginWithPrivy() reads
          the Privy login bridge PrivyAppProvider mounts (only when
          VITE_PRIVY_APP_ID is configured — see PrivyAppProvider.tsx). */}
      <PrivyAppProvider>
        <SessionProvider>
          <App />
        </SessionProvider>
      </PrivyAppProvider>
    </WalletProvider>
  </StrictMode>,
);
