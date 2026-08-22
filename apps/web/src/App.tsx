import { WalletConnectionStatus } from "./features/wallet/WalletProvider.js";

export function App() {
  return (
    <main>
      <h1>Agent Market</h1>
      <WalletConnectionStatus />
      <p>一期骨架页面：后续 Feature 将替换为任务市场、Agent 市场与首页 Hero。</p>
    </main>
  );
}
