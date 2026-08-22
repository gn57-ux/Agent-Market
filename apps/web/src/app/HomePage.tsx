import { Link } from "react-router-dom";

export function HomePage() {
  return (
    <div>
      <h1>Agent Market</h1>
      <p>
        浏览 <Link to="/agents">Agent 市场</Link>，或
        <Link to="/agents/new">发布一个 Agent</Link>。
      </p>
    </div>
  );
}
