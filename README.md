# Agent Market

AI Agent + Web3 任务协作平台：发布任务 → 锁定预算 → 智能撮合 → 接单质押 → 提交成果 → 验收/争议 → 托管结算 → 行为反馈（第一期）。见 [docs/PRD-Agent-Market.md](docs/PRD-Agent-Market.md)、[docs/PROJECT-PLAN-Agent-Market.md](docs/PROJECT-PLAN-Agent-Market.md)。

## 技术栈

- 前端：React + TypeScript + Vite + viem（`apps/web`）
- 后端：Fastify + Zod（`apps/api`）
- 撮合服务：Go（`services/dispatch`）
- 合约：Solidity + Hardhat（`contracts`）
- 业务数据库：PostgreSQL（尚未接入）

## 环境要求

- Node.js `^20.19.0 || ^22.13.0 || >=24`
- pnpm 9
- Go 1.22+

## 安装

```bash
pnpm install
cp .env.example .env   # 按需修改各模块变量，.env 已被 git 忽略
```

## 开发

```bash
# 前端（默认 http://localhost:5173）
pnpm --filter @agent-market/web dev

# 后端（默认 http://localhost:3001，/health 返回 { "status": "ok" }）
pnpm --filter @agent-market/api dev

# 撮合服务（默认 :8081，/healthz 返回 { "status": "ok" }）
cd services/dispatch && go run ./cmd/server
```

## 质量门禁

以下命令与 [.github/workflows/ci.yml](.github/workflows/ci.yml) 保持一致，是每次交付前的真实检查（不含任何占位/伪造步骤）：

```bash
# Node：Lint / 格式 / 类型检查 / 构建
pnpm run lint
pnpm run format:check
pnpm --filter @agent-market/api typecheck
pnpm --filter @agent-market/web typecheck
pnpm --filter @agent-market/web build
pnpm --filter @agent-market/api build

# Go：构建 / 静态检查 / 测试
cd services/dispatch
go build ./...
go vet ./...
go test ./...
cd ..

# 合约：编译 / 测试（Feature 2 落地前 src/ 为空，属于真实结果而非占位）
pnpm --filter @agent-market/contracts compile
pnpm --filter @agent-market/contracts test
```

## 关键目录

```text
apps/
  web/          # 前端
  api/          # 后端
services/
  dispatch/     # Go 撮合服务
contracts/       # Hardhat 合约（src/ 待 Feature 2 填充）
docs/             # PRD、实施计划、ADR、第三方资源清单
specs/             # Feature/Task 规格（/yd:prd 产出）
```

## 文档

- [docs/adr/](docs/adr/)：架构决策记录
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)：第三方资源清单
- [docs/DEFERRED-ENGINEERING.md](docs/DEFERRED-ENGINEERING.md)：主动延期的工程能力
