# 第三方资源清单

记录本项目引入的第三方代码库、组件库、图标库、Three.js 资源和其他公开资源的来源、许可证、版本和用途。引入任何新的第三方资源（尤其是 UI 组件库、图标、Three.js addon/shader/纹理/模型）前，先在此追加一行，并确认许可证允许课程/项目展示、修改与分发。

同类能力只保留一个主要来源，避免组件库叠加（PRD §10.1 公开组件与资源复用原则）。

## 记录字段

每条记录包含：**名称** / 版本 / 许可证 / 用途 / 来源。

## 运行时依赖

| 名称 | 版本 | 许可证 | 用途 | 来源 |
|---|---|---|---|---|
| React | ^18.3.1 | MIT | 前端 UI 框架（`apps/web`） | https://github.com/facebook/react |
| React DOM | ^18.3.1 | MIT | React 浏览器渲染 | https://github.com/facebook/react |
| viem | ^2.19.0 | MIT | 前端钱包/链交互（`apps/web`） | https://github.com/wevm/viem |
| Fastify | ^4.28.1 | MIT | 后端 HTTP 框架（`apps/api`） | https://github.com/fastify/fastify |
| Zod | ^3.23.8 | MIT | 后端/前端运行时校验 | https://github.com/colinhacks/zod |

## 开发/构建依赖

| 名称 | 版本 | 许可证 | 用途 | 来源 |
|---|---|---|---|---|
| Vite | ^5.4.0 | MIT | 前端构建工具（`apps/web`） | https://github.com/vitejs/vite |
| @vitejs/plugin-react | ^4.3.1 | MIT | Vite 的 React 插件 | https://github.com/vitejs/vite-plugin-react |
| TypeScript | ^5.5.4 | Apache-2.0 | 类型检查与编译 | https://github.com/microsoft/TypeScript |
| tsx | ^4.16.2 | MIT | 后端本地开发运行时（`apps/api` dev） | https://github.com/privatenumber/tsx |
| Hardhat | ^2.22.6 | MIT | 合约编译/测试/部署（`contracts`） | https://github.com/NomicFoundation/hardhat |
| @nomicfoundation/hardhat-toolbox | ^5.0.0 | MIT | Hardhat 常用插件集合（ethers、chai matcher 等） | https://github.com/NomicFoundation/hardhat |
| ESLint | ^9 | MIT | 代码静态检查（根目录） | https://github.com/eslint/eslint |
| typescript-eslint | ^8 | MIT | TypeScript 的 ESLint 规则集 | https://github.com/typescript-eslint/typescript-eslint |
| Prettier | ^3 | MIT | 代码格式化 | https://github.com/prettier/prettier |

## Go 依赖（`services/dispatch`）

目前仅使用 Go 标准库（`net/http`、`encoding/json` 等），无第三方 Go 模块。

## UI 组件库 / 图标 / Three.js 资源

尚未引入。Feature 3（首页 Hero）、Feature 6（任务市场/详情等页面）落地时，在此补充实际选用的公开组件库、图标库和 Three.js addon/shader/纹理/模型的具体条目，并确认许可证允许本项目的课程展示与修改分发用途。
