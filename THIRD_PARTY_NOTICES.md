# 第三方资源清单

记录本项目引入的第三方代码库、组件库、图标库、Three.js 资源和其他公开资源的来源、许可证、版本和用途。引入任何新的第三方资源（尤其是 UI 组件库、图标、Three.js addon/shader/纹理/模型）前，先在此追加一行，并确认许可证允许课程/项目展示、修改与分发。

同类能力只保留一个主要来源，避免组件库叠加（PRD §10.1 公开组件与资源复用原则）。

## 记录字段

每条记录包含：**名称** / 版本 / 许可证 / 用途 / 来源。

## 运行时依赖

| 名称      | 版本     | 许可证 | 用途                                                              | 来源                               |
| --------- | -------- | ------ | ----------------------------------------------------------------- | ---------------------------------- |
| React     | ^18.3.1  | MIT    | 前端 UI 框架（`apps/web`）                                        | https://github.com/facebook/react  |
| React DOM | ^18.3.1  | MIT    | React 浏览器渲染                                                  | https://github.com/facebook/react  |
| viem      | ^2.19.0  | MIT    | 前端钱包/链交互（`apps/web`）                                     | https://github.com/wevm/viem       |
| Fastify   | ^4.28.1  | MIT    | 后端 HTTP 框架（`apps/api`）                                      | https://github.com/fastify/fastify |
| Zod       | ^3.23.8  | MIT    | 后端/前端运行时校验                                               | https://github.com/colinhacks/zod  |
| three     | ^0.185.1 | MIT    | 首页 Hero 三维动画渲染引擎（Feature 3 `hero-galaxy`，`apps/web`） | https://github.com/mrdoob/three.js |

## 开发/构建依赖

| 名称                             | 版本      | 许可证     | 用途                                            | 来源                                                   |
| -------------------------------- | --------- | ---------- | ----------------------------------------------- | ------------------------------------------------------ |
| Vite                             | ^5.4.0    | MIT        | 前端构建工具（`apps/web`）                      | https://github.com/vitejs/vite                         |
| @vitejs/plugin-react             | ^4.3.1    | MIT        | Vite 的 React 插件                              | https://github.com/vitejs/vite-plugin-react            |
| TypeScript                       | ^5.5.4    | Apache-2.0 | 类型检查与编译                                  | https://github.com/microsoft/TypeScript                |
| tsx                              | ^4.16.2   | MIT        | 后端本地开发运行时（`apps/api` dev）            | https://github.com/privatenumber/tsx                   |
| Hardhat                          | ^2.22.6   | MIT        | 合约编译/测试/部署（`contracts`）               | https://github.com/NomicFoundation/hardhat             |
| @nomicfoundation/hardhat-toolbox | ^5.0.0    | MIT        | Hardhat 常用插件集合（ethers、chai matcher 等） | https://github.com/NomicFoundation/hardhat             |
| ESLint                           | ^9        | MIT        | 代码静态检查（根目录）                          | https://github.com/eslint/eslint                       |
| @eslint/js                       | ^9        | MIT        | ESLint 官方推荐规则集                           | https://github.com/eslint/eslint                       |
| typescript-eslint                | ^8        | MIT        | TypeScript 的 ESLint 规则集                     | https://github.com/typescript-eslint/typescript-eslint |
| globals                          | ^15       | MIT        | ESLint 配置用的全局变量定义                     | https://github.com/sindresorhus/globals                |
| Prettier                         | ^3        | MIT        | 代码格式化                                      | https://github.com/prettier/prettier                   |
| @types/node                      | ^20.14.10 | MIT        | Node.js 类型定义（`apps/api`）                  | https://github.com/DefinitelyTyped/DefinitelyTyped     |
| @types/react                     | ^18.3.3   | MIT        | React 类型定义（`apps/web`）                    | https://github.com/DefinitelyTyped/DefinitelyTyped     |
| @types/react-dom                 | ^18.3.0   | MIT        | React DOM 类型定义（`apps/web`）                | https://github.com/DefinitelyTyped/DefinitelyTyped     |
| @types/three                     | ^0.185.4  | MIT        | three 类型定义（`apps/web`）                    | https://github.com/DefinitelyTyped/DefinitelyTyped     |

## Go 依赖（`services/dispatch`）

目前仅使用 Go 标准库（`net/http`、`encoding/json` 等），无第三方 Go 模块。

## UI 组件库 / 图标 / Three.js 资源

Feature 3（首页 Hero，`apps/web/src/features/hero-galaxy/`）已完整落地（T-301–T-305）：核查确认场景（任务核心、Agent 节点网络、连线、扫描波、质押环、结算粒子）完全基于 `three` 核心包的程序化 `Geometry`/`Material`（`BoxGeometry`/`SphereGeometry`/`RingGeometry`/`LineBasicMaterial` 等内置类型）构建，未引入任何 Three.js addon/examples（如 `OrbitControls`、`GLTFLoader`、`EffectComposer`）、外部 shader、纹理贴图或 3D 模型文件；`StaticFallback.tsx` 静态降级构图同样为纯 CSS/DOM，未引入图标库。除运行时依赖表中已记录的 `three` 与开发/构建依赖表中已记录的 `@types/three` 外，本 Feature 无其他第三方资源需要记录（核查方式：审查 `hero-galaxy` 全部源文件的 import 语句与资源加载调用，确认无 addon/贴图/模型/图标库引用）。

Feature 6（任务市场/详情等页面）落地时，若引入公开组件库、图标库或额外 Three.js 资源，在此补充具体条目，并确认许可证允许本项目的课程展示与修改分发用途。
