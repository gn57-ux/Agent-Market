import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { WalletProvider } from "./features/wallet/WalletProvider.js";
import { SessionProvider } from "./features/session/SessionProvider.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root not found");
}

createRoot(container).render(
  <StrictMode>
    <WalletProvider>
      <SessionProvider>
        <App />
      </SessionProvider>
    </WalletProvider>
  </StrictMode>,
);
