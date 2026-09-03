# ADR-0002: 采用 Privy 登录 + embedded wallet 作为身份提供方之一

- 状态：已采纳
- 日期：2026-09-01
- 相关 Feature/Task：Feature 16（identity-agent-review-funds-dashboard）/ T-1610

> **编号说明**：本仓库另有一条独立分支（Feature 15，`feature/15-cocos-personal-office`）也在使用 `docs/adr/0002-*.md`，两者基于同一个 `main` 基线（`c56b45e`）各自独立开发，尚未合并。若 Feature 15 先合并到 `main`，本 ADR 在合并时需要重新编号为 `0003`（内容不变，仅文件名与本文档内部引用的编号）。这不是本 ADR 决策内容的一部分，只是记录一个已知的、真实存在的编号冲突风险，避免合并时被误当作新问题重新调查。

## 问题

Feature 16（requirements.md F-1601/F-1611，用户 2026-08-31/2026-09-01 两次定稿指令）要求：把现有硬编码的 MetaMask/SIWE 登录流程收敛到一个可插拔的 `IdentityProvider` 接口后面（T-1600 已完成，见 `apps/api/src/modules/auth/identity-provider.ts`），并新增 Privy 作为第二个身份提供方实现，**范围包含 embedded wallet**（不只是"Privy 作登录 UI，签名仍由用户自己的外部钱包完成"这一更保守的模式）。

这个决定的真实后果是：私钥的托管责任从"完全由用户自己的浏览器扩展钱包（MetaMask）保管，项目从不接触"变成"由 Privy 的基础设施保管（本项目自己的数据库/日志/前端状态/代码仓库任何时候都不持有明文私钥，这是用户已确认的硬约束，见 requirements.md"已确认决定"）"。这是一个真实改变了资金安全信任边界的决定，必须先有 ADR、威胁模型、恢复方案、密钥管理方案（本 Feature 的 T-1610，AC-1608 明确要求四份文档齐备并经用户批准才能进入 T-1601 编码）。

## 已知事实与约束（真实核查，非假设）

**Privy embedded wallet 的真实架构**（核查自 Privy 官方文档 `docs.privy.io/security/wallet-infrastructure/architecture` 与官方博客，2026-09-01 抓取）：

- 私钥用 CSPRNG 生成 128 位熵，转换为 BIP-39 助记词，再 HD 派生。私钥**只在签名操作期间、且只在 TEE（AWS Nitro Enclave）内部**短暂以完整形式存在；其余任何时候都以加密分片形式分散存储。
- 当前（较新）架构是 **2-of-2 Shamir 分片**：enclave share（被 TEE 自身密钥加密，只能在 TEE 内解密）+ auth share（Privy 加密存储，只有持有有效认证凭据才能取出）。两者单独都不提供任何密钥信息。
- 签名流程：后端带认证凭据+授权签名发起请求 → Privy 验证凭据并把 auth share 转发进 TEE → TEE 核对授权签名 → 两个 share 只在 TEE 内临时合并重建私钥、内存中完成签名 → 私钥立即丢弃，调用方只拿到签名结果。**本项目后端任何时候都拿不到私钥、auth share 或 enclave share 本身。**
- Privy 官方文档同时存在一套较早的表述，即"设备份额（用户浏览器）+ Privy 份额（TEE）+ 恢复份额（用户设置）"三份中任意两份可重建密钥，恢复流程（新设备/丢失设备）依赖密码/passkey/MFA 找回这些份额。**两套表述（2-of-2 enclave+auth vs 3-of-3 device+auth+recovery）在公开资料中并存，本 ADR 如实记录这个不确定性，不假装已经消解**——T-1601 实际集成 SDK 时必须以当时 Privy 官方文档和实际 SDK 行为为准重新核实一次，不能直接照抄本 ADR 调研时的理解。
- 已知的、Privy 自己公开承认的失败模式：TEE（AWS Nitro Enclave）完整性是整个模型的信任根，enclave 被攻破则密钥隔离失效；后端 API 凭据（bearer token/secret）一旦泄露，攻击者可以用 auth share 请求签名；attestation（远程认证）校验被绕过是灾难性的；签名期间私钥短暂明文存在于 TEE 内存，理论上存在内存转储攻击面。

**本项目已有约束**（不因采用 Privy 而改变）：

- `sessionAddress` 仍是全系统唯一的业务身份锚点（design.md 决策 1）；`agents`/`tasks`/`dispatch`/`deliverables`/`disputes`/`ratings` 等既有模块只依赖"拿到一个已验证的小写地址字符串"，不感知具体是哪个身份提供方签发的。
- 现有 SIWE/MetaMask 路径必须继续可用、长期并存，不是"迁移完成即废弃"（requirements.md v1.1 用户定稿）。
- 数据库/日志/前端状态/代码仓库任何时候不得保存或输出明文私钥——这条对 Privy embedded wallet 而言意味着：本项目后端**永远不主动请求、缓存或记录** Privy 返回的任何 share/token 内容，只消费 Privy 验证后返回的已验证地址（复用 T-1600 已建立的 `IdentityVerificationResult { address: string }` 投影边界）。

## 方案比较

| 维度 | 方案 A：Privy 仅作登录 UI，签名仍由外部钱包完成（design.md v1.0 的保守默认） | 方案 B：Privy embedded wallet（用户 2026-08-31 定稿选择） |
|---|---|---|
| 接口复杂度 | 复用 T-1600 已有的 `IdentityProvider` 接口即可，`PrivyIdentityProvider` 只需把 Privy 返回的已验证地址投影成 `{address}` | 同样复用 `IdentityProvider` 接口（F-1602 的边界不变），但 `PrivyIdentityProvider` 内部需要额外处理 embedded wallet 的会话/密钥恢复相关调用（仍然只对外暴露地址，SDK 细节封装在实现内部，不改变接口契约） |
| 模块依赖 | 不引入新的信任依赖——私钥仍完全在用户自己的钱包软件里 | 引入对 Privy TEE 基础设施（AWS Nitro Enclave）、Privy 认证凭据管理的真实信任依赖——这是一个新的、真实的第三方信任边界 |
| 用户体验 | 用户仍需自行安装/管理浏览器扩展钱包，对无 Web3 经验的用户门槛高 | 免去用户自行管理钱包软件的门槛，登录即有可用钱包——这是用户选择方案 B 的核心动机（PRD §2.5 的产品目标） |
| 可测试性 | 契约测试无需模拟"私钥托管"这一维度 | 需要真实验证私钥不经由本项目任何公开 API/日志泄漏（AC-1602），测试面更大 |
| 回滚方式 | 不适用（本就不托管私钥） | 组合根切换回 `SiweIdentityProvider` 作为默认（F-1603 已有能力），embedded wallet 使用者需要走 Privy 自己的账户恢复/导出流程取回资产——回滚不会丢失用户资产，但用户体验上需要真实的迁移沟通，不是纯技术层面的无感切换 |

## 选择

方案 B（用户 2026-08-31 已定稿决策，本 ADR 记录理由与真实约束，不是重新做决策）。核心理由：产品目标是降低非 Web3 用户的登录门槛（PRD §2.5），这是方案 A 无法满足的；私钥托管责任转移到 Privy 的 TEE + 分片架构后，本项目自身的"不存明文私钥"硬约束依然可以满足（因为项目后端本就设计为永远不接触私钥/share 本身，只消费已验证地址），真实新增的风险是"信任 Privy 的 TEE 基础设施与认证机制"，这个风险在下述威胁模型文档中逐项列出并给出缓解措施。

## 失败条件

以下任一情况发生，应视为本决策需要重新评审（不是自动触发回滚，是触发一次真实的重新评估）：

- Privy 公开披露过一次 TEE 完整性或 auth share 存储层面的真实安全事件（不是理论漏洞，是真实发生的事件）。
- 本项目自己的抓包/日志审查（AC-1602）在生产环境发现过一次真实的 token/私钥泄漏，且根因不能归结为本项目自身实现错误（即 Privy 侧的边界确实不如文档承诺）。
- Privy 服务可用性/延迟长期（非单次故障）影响登录成功率，且没有合理的降级路径。

## 回滚方式

组合根（`app.ts`）把默认 `IdentityProvider` 从 `PrivyIdentityProvider` 切回 `SiweIdentityProvider`（T-1600 已验证这条切换路径的正确性——`completeLogin`/`session.service.ts`/其余全部业务模块只依赖接口返回的 `address`，不感知具体实现）。已通过 Privy embedded wallet 登录、且从未使用过外部钱包登录同一地址的用户，其资产仍在 Privy 托管的 embedded wallet 里——回滚本项目的登录方式不会让这些用户的资产"消失"或"被本项目接触到"，但这些用户需要通过 Privy 自己的账户导出/恢复流程把 embedded wallet 迁移到自己控制的钱包，才能继续使用本项目回滚后的纯 SIWE 登录路径。这是真实存在的用户侧成本，回滚决策时必须向受影响用户提前沟通，不是纯后端配置切换就能无感完成的。

## 参考资料

- [Security architecture - Privy Docs](https://docs.privy.io/security/wallet-infrastructure/architecture)（2026-09-01 抓取）
- [Privy Blog | How Privy embedded wallets work](https://privy.io/blog/how-privy-embedded-wallets-work)
- [Privy Blog | Powering programmable wallets with low-level key management](https://privy.io/blog/powering-programmable-wallets-with-low-level-key-management)
- [Privy Blog | Launching cloud-based wallet recovery](https://privy.io/blog/cloud-based-wallet-recovery-launch)
- [Wallet MFA - Privy Docs](https://docs.privy.io/guide/react/wallets/embedded/mfa/)
