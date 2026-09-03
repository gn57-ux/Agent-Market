# Phase 3 个人虚拟工作室手工验收

本文只记录人工操作步骤和预期结果。Cocos 是只读展示层；所有任务、钱包、结算和合约操作仍由现有 React/API/合约模块负责。

## 1. Cocos 编辑器基线

1. 用 Cocos Creator 3.8.8 打开 `apps/office-cocos`。
2. 等待资源导入完成，确认 Console 没有 Error。
3. 打开 `assets/scene.scene`，确认唯一启动场景是 `scene.scene`。
4. 浏览器预览地址追加 `?mock=1`。

预期：显示六个功能区域和黄色角色；WASD、方向键可移动；角色不能穿过功能区域；靠近区域后底部显示摘要；Enter/Space 发出导航请求。

## 2. 空状态

浏览器预览地址追加 `?mock=empty`。

预期：房间仍可移动；Agent 工位显示 `0 agents / No agents yet`；任务看板、交付台和成就墙均显示 0；资金区显示 YD 0。空状态不得抛异常，也不得生成虚假任务或 Agent。

## 3. Web Desktop 构建

1. Platform 选择 `Web Desktop`。
2. Start Scene 选择 `db://assets/scene.scene`。
3. Included Scenes 只勾选 `scene`，不要勾选未使用的 `Office.scene`。
4. Build Path 使用项目内 `build/web-desktop`。
5. 点击 Build；完成后点击 Run。

预期：构建成功且浏览器真实加载房间，不是空白页；Console 无 Error。

## 4. React 嵌入

将最新的 Cocos Web Desktop 构建内容同步到 `apps/web/public/office-cocos` 后启动现有 React 应用。

- `/office?mock=1`：有数据演示。
- `/office?mock=empty`：空状态演示。
- `/office`：请求真实 `GET /office/snapshot`。

预期：页面标题、普通工作台入口和 Cocos iframe 同时存在；iframe 加载失败超过 12 秒后显示 React 回退面板；点击“打开普通工作台”始终能绕过 Cocos 展示层。

## 5. 真实 API 与失败场景

在隔离环境配置已有数据库、会话和链只读参数后验证 `/office`：

1. 已登录：只发起一个 `GET /office/snapshot` 聚合请求。
2. 未登录：API 返回 401，Cocos 底部显示 `UNAUTHORIZED`。
3. API 停止或网络断开：底部显示 `NETWORK`，房间仍可移动。
4. 链 RPC 不可用：业务快照仍返回，资金区显示 unavailable，不把未知余额显示成 0。
5. 返回结构不合法：底部显示 `INVALID_RESPONSE`。

## 6. 导航闭环

依次靠近六个区域并按 Enter：

- Agent 工位：有 Agent 时进入详情；为空时进入 Agent 市场。
- 任务看板：有发布任务时进入任务详情；为空时进入任务市场。
- 托管资金区：进入我的工作台，不在 Cocos 内签名。
- 交付工作台：有执行任务时进入任务详情；为空时进入我的工作台。
- 成就墙：进入我的工作台。
- Web 出口：返回普通 Web 首页。

预期：导航由同源 `postMessage` 进入 React 路由；Cocos 不直接拼接业务 URL，不执行链上交易。

## 7. 记录

保存以下证据：编辑器无错误截图、预览有数据截图、空状态截图、Web 构建成功截图、React 嵌入截图、API 失败截图。另记录 Cocos 构建目录大小、首屏加载时间、桌面 Chrome 版本和已知限制。
