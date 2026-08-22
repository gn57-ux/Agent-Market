import { createBrowserRouter } from "react-router-dom";
import { RootLayout } from "./RootLayout.js";
import { HomePage } from "./HomePage.js";
import { AgentMarketPage } from "../features/agents/AgentMarketPage.js";
import { AgentCreatePage } from "../features/agents/AgentCreatePage.js";
import { AgentDetailPage } from "../features/agents/AgentDetailPage.js";
import { AgentEditPage } from "../features/agents/AgentEditPage.js";

/**
 * The single route table for apps/web (Feature 5 kickoff instruction:
 * "路由知识集中在一个模块；...后续 Feature 6–10 在同一路由表中小步增加路由，不重复创建
 * Router，也不提前实现没有消费方的嵌套布局或懒加载抽象"). One flat array — no
 * plugin system, no dynamic route registry. Feature 6-10 add their own
 * entries here as their pages land; nothing about this structure should
 * need to change for that.
 */
export const router = createBrowserRouter([
  {
    path: "/",
    element: <RootLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "agents", element: <AgentMarketPage /> },
      { path: "agents/new", element: <AgentCreatePage /> },
      { path: "agents/:agentId", element: <AgentDetailPage /> },
      { path: "agents/:agentId/edit", element: <AgentEditPage /> },
    ],
  },
]);
