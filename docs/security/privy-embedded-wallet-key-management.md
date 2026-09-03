# Privy embedded wallet 密钥管理方案

- 相关 Feature/Task：Feature 16（identity-agent-review-funds-dashboard）/ T-1610
- 相关文档：`docs/adr/0002-privy-embedded-wallet.md`、`docs/security/privy-embedded-wallet-threat-model.md`、`docs/security/privy-embedded-wallet-recovery.md`
- 日期：2026-09-01
- 状态：已批准（用户 2026-09-01 批准，AC-1608 满足；批准时追加 3 项强制 T-1601 验证要求——令牌重放/撤销测试、伪造/篡改令牌拒绝测试、前端令牌存储与 CSP 核查，见 tasks.md T-1601 v1.2）

## 核心原则（不可协商，requirements.md 已确认决定）

**本项目的数据库、日志、前端状态、代码仓库任何时候不得保存或输出明文私钥。** 对 Privy embedded wallet 而言，这条原则的具体化是：本项目后端与前端都**不应该、也不需要**接触私钥本身或任何密钥分片（无论是 2-of-2 的 enclave/auth share 还是 3-of-3 的 device/auth/recovery share）——这不是需要额外实现的约束，而是 Privy 官方架构本身就保证"开发者永远拿不到私钥/share"（见 ADR-0002 的架构调研），本项目只需要**不主动破坏这个边界**（不缓存、不记录、不通过调试接口暴露）。

## 本项目侧唯一需要管理的密钥材料：Privy API 凭据

真实需要本项目负责管理的密钥材料，只有 Privy 分配给本项目的后端 API 凭据（app secret / verification key / webhook signing secret 等，具体名称以 T-1601 实现时 Privy 当前 SDK 文档为准）——这些凭据不是用户的私钥，而是"本项目后端有权代表本项目向 Privy 发起请求"的凭证，泄漏后果见威胁模型文档。

### 凭据管理规则

**N4 Codex 审查真实发现并已修正的错误（P2）**：本文档早期版本建议 Privy 凭据复用 `apps/api/src/modules/agents/credential.ts` 的 `env://` 引用格式——这是错的。核查该文件的真实实现后确认：`resolveCredential`/其 `env://AGENT_<32位十六进制UUID>` 格式是专门为**单个 Agent 的调用凭据**设计的（引用字符串里编码了具体 Agent 的 id，解析器只接受这一种模式，且其文档明确注明预期唯一调用方是 Agent 调用客户端），不是通用的平台级密钥引用机制，Privy 这种"整个平台共用一份"的凭据无法套进这个格式，若强行复用会在实现时直接解析失败。

- Privy 相关密钥（app secret / verification key / webhook signing secret 等，具体名称以 T-1601 实现时 Privy 当前 SDK 文档为准）作为**平台级环境变量**管理，与本项目已有的其他平台级密钥（`BACKEND_RPC_URL`、`ACCEPTANCE_PERMIT_SIGNER_KEY`、`DATABASE_URL` 等，均是 `apps/api` 直接 `process.env.X` 读取、`.env`/生产部署密钥管理系统提供值）同一模式，不引入新的引用间接层，也不误用 Agent 专属的凭据引用机制。
- 绝不硬编码在代码仓库的任何文件（包括测试文件、脚本、文档示例——文档中出现的任何"示例凭据"必须是明显不可用的占位符，不能是真实格式的字符串）。
- 绝不落库（`agents`/`users`/`sessions` 等业务表不存储 Privy 凭据，这些凭据是平台级配置，不是业务数据，不应该出现在业务数据库的任何表里）。
- 绝不出现在日志输出——`PrivyIdentityProvider` 实现时必须确认：任何调用 Privy SDK 失败时的错误日志，不得把请求头/凭据原样打印（这是真实容易犯的错误：很多 HTTP 客户端库的默认错误日志会包含完整请求头）。T-1601 完成后需要有真实的日志内容审查证据（复用 `logging.integration.test.ts` 的既有模式）。

## 密钥轮换

Privy API 凭据轮换的具体机制（是否支持多凭据并存、轮换是否需要停机）取决于 Privy 平台自身的能力，T-1601 实现时需要查阅当时 Privy 官方文档确认，本文档不假设具体轮换流程。**原则性要求**：轮换凭据不应导致已登录用户的会话失效（本项目自己签发的会话 token 与 Privy 凭据是两个独立的信任层——`sessionAddress` 一旦签发就由本项目自己的 `sessions` 表管理，不依赖 Privy 凭据持续有效才能验证已有会话），这条原则性要求需要在 T-1601 实现时验证成立，不能假设。

## 与 T-1600 已有接口边界的关系

`PrivyIdentityProvider`（T-1601 待实现）必须满足 T-1600 已建立的 `IdentityProvider` 接口契约——`completeAuth` 的返回值只能是 `IdentityVerificationResult { address: string }`，不能有第二个字段。这条边界本身就是防止 Privy SDK 内部对象（包括任何密钥相关的元数据）泄漏到本项目其余业务模块的第一道真实防线，T-1600 的 `siwe-identity-provider.integration.test.ts` 已经建立了"用 `Object.keys()` 断言返回对象只有一个字段"这种真实运行时验证模式，T-1601 实现 `PrivyIdentityProvider` 时应该复用同样的验证方法，不是另起一套。

## 范围边界（明确不做的事）

- 不实现本项目自己的密钥托管/加密存储机制——密钥托管完全是 Privy 的职责，本项目不重复造轮子，也不应该有能力这么做（前面的核心原则）。
- 不实现本项目自己的密钥轮换调度系统——如果未来 Privy 凭据轮换需要自动化，复用本项目已有的定时任务/Worker 基础设施（Feature 18 的范围），不在本 Feature 独立建设。
- 不假设 Privy SDK 的具体轮换/凭据管理 API 细节——这些细节属于第三方 API 的真实使用文档，T-1601 编码时必须对照当时的官方文档，本文档不代替这一步骤，也不应该被当作"已经调研清楚，可以直接照抄"的实现指南。
