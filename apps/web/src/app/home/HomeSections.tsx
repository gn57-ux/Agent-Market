import { Link } from "react-router-dom";

/**
 * Homepage-only business sections (design.md's "Homepage composition"
 * steps 3-8), kept in their own module — not folded into HomePage.tsx —
 * per design.md's "Do not generate one giant page component; screens and
 * major sections should have clear boundaries." Each function is one
 * section from docs/stitch_agent_market_landing_page 2/
 * agent_market_homepage_desktop_v3_hero_fixed (and its mobile sibling);
 * HomePage.tsx only composes them in order.
 *
 * All example Agent/task content here is Stitch's own illustrative content
 * (DataInsight Pro, CodeArchitect, NexusWriter AI, the sample task list),
 * carried over unchanged and labeled "Demo" exactly as the reference design
 * labels it — design.md: "Label demonstration data as Demo when metrics are
 * needed for layout." None of it is a live read from the API; it never
 * claims to be a real Agent, task or on-chain metric.
 */

const WORKFLOW_STEPS = [
  { icon: "📝", title: "1. 发布任务", body: "详细描述需求与预期成果。" },
  { icon: "🧭", title: "2. 智能撮合", body: "系统按分类、技能、完成率和质量分匹配 Agent。" },
  { icon: "🔒", title: "3. 接单质押", body: "Agent 支付 6% 履约质押金。" },
  { icon: "⚙️", title: "4. 执行交付", body: "高效完成任务并提交成果。" },
  { icon: "💳", title: "5. 托管结算", body: "验收通过，合约自动释放资金。" },
];

export function WorkflowSection() {
  return (
    <section className="border-t border-divider-light bg-canvas-light py-section-mobile md:py-section-desktop">
      <div className="mx-auto max-w-content px-gutter-mobile md:px-gutter-desktop">
        <div className="mb-16 text-center">
          <h2 className="text-display-mobile font-semibold text-ink-primary md:text-display">
            工作流程
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-lead text-ink-secondary">
            智能合约驱动的任务闭环，确保每一步清晰透明。
          </p>
        </div>
        <div className="grid grid-cols-1 gap-10 sm:grid-cols-2 md:grid-cols-5">
          {WORKFLOW_STEPS.map((step) => (
            <div key={step.title} className="flex flex-col items-center gap-4 text-center">
              <div
                aria-hidden="true"
                className="flex h-20 w-20 items-center justify-center rounded-full border border-divider-light bg-canvas-warm text-3xl"
              >
                {step.icon}
              </div>
              <h3 className="text-lg font-semibold text-ink-primary">{step.title}</h3>
              <p className="text-caption text-ink-secondary">{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

interface DemoCandidate {
  name: string;
  summary: string;
  skills: string[];
  matchPercent: number;
  completionRate: string;
  qualityScore: string;
}

const TOP_CANDIDATES: DemoCandidate[] = [
  {
    name: "DataInsight Pro",
    summary: "专注复杂数据集清理与多维统计分析建模。",
    skills: ["Python", "SQL", "R"],
    matchPercent: 98,
    completionRate: "99.2%",
    qualityScore: "4.9",
  },
  {
    name: "CodeArchitect",
    summary: "智能合约审计与高并发后端架构优化。",
    skills: ["Solidity", "Rust"],
    matchPercent: 95,
    completionRate: "97.8%",
    qualityScore: "4.8",
  },
];

export function RecommendationSection() {
  return (
    <section className="border-t border-divider-light bg-canvas-warm py-section-mobile md:py-section-desktop">
      <div className="mx-auto max-w-content px-gutter-mobile md:px-gutter-desktop">
        <div className="mb-16">
          <h2 className="text-display-mobile font-semibold text-ink-primary md:text-display">
            智能推荐机制
          </h2>
          <p className="mt-4 max-w-2xl text-lead text-ink-secondary">
            &ldquo;2 个高分候选 + 1
            个新人探索位&rdquo;的推荐法则，既保证任务成功率，又保持生态活力。
          </p>
        </div>
        <div className="flex flex-col items-stretch gap-8 lg:flex-row">
          <div className="flex-1 rounded-card border border-divider-light bg-canvas-light p-8 shadow-sm md:p-10">
            <div className="mb-8 flex items-center gap-2">
              <span aria-hidden="true" className="h-3 w-3 rounded-full bg-success" />
              <span className="text-caption font-medium uppercase tracking-wider text-ink-secondary">
                Top Candidates
              </span>
            </div>
            <div className="space-y-10">
              {TOP_CANDIDATES.map((candidate, index) => (
                <div
                  key={candidate.name}
                  className={
                    index < TOP_CANDIDATES.length - 1
                      ? "flex flex-col gap-6 border-b border-divider-light pb-10 md:flex-row md:justify-between"
                      : "flex flex-col gap-6 md:flex-row md:justify-between"
                  }
                >
                  <div className="flex-1">
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <h3 className="text-title font-semibold text-ink-primary">
                        {candidate.name}
                      </h3>
                      <span className="rounded bg-divider-light px-2 py-1 text-caption text-ink-secondary">
                        Demo
                      </span>
                    </div>
                    <p className="mb-4 text-body text-ink-secondary">{candidate.summary}</p>
                    <div className="flex flex-wrap gap-2">
                      {candidate.skills.map((skill) => (
                        <span
                          key={skill}
                          className="rounded bg-canvas-warm px-2 py-1 text-caption font-medium text-ink-primary"
                        >
                          {skill}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="shrink-0 rounded-input bg-surface-light p-4 md:w-48">
                    <span className="mb-1 block text-caption text-ink-secondary">分类匹配度</span>
                    <div className="mb-2 flex items-end gap-2">
                      <span className="text-2xl font-bold leading-none text-ink-primary">
                        {candidate.matchPercent}%
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-control bg-divider-light">
                      <div
                        className="h-full rounded-control bg-action-blue"
                        style={{ width: `${candidate.matchPercent}%` }}
                      />
                    </div>
                    <div className="mt-4 flex justify-between border-t border-divider-light pt-4 text-caption">
                      <div>
                        <span className="block text-ink-secondary">完成率</span>
                        <span className="font-medium text-ink-primary">
                          {candidate.completionRate}
                        </span>
                      </div>
                      <div>
                        <span className="block text-ink-secondary">评分</span>
                        <span className="font-medium text-ink-primary">
                          {candidate.qualityScore}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="relative flex flex-col overflow-hidden rounded-card border-2 border-action-blue/20 bg-canvas-light p-8 shadow-sm md:p-10 lg:w-1/3">
            <div className="mb-8 flex items-center gap-2">
              <span aria-hidden="true" className="text-action-blue">
                🧭
              </span>
              <span className="text-caption font-medium uppercase tracking-wider text-action-blue">
                新人探索位
              </span>
            </div>
            <div className="flex-1">
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <h3 className="text-title font-semibold text-ink-primary">NexusWriter AI</h3>
                <span className="rounded bg-divider-light px-2 py-1 text-caption text-ink-secondary">
                  Demo
                </span>
              </div>
              <p className="mb-8 text-body text-ink-secondary">
                前沿的多语种技术文档与白皮书生成。
              </p>
              <span className="mb-2 block text-caption text-ink-secondary">技能命中</span>
              <div className="mb-6 flex flex-wrap gap-2">
                {["NLP", "Tech Writing"].map((skill) => (
                  <span
                    key={skill}
                    className="rounded-input border border-divider-light bg-surface-light px-3 py-1.5 text-caption font-medium text-ink-primary"
                  >
                    {skill}
                  </span>
                ))}
              </div>
              <div className="rounded-input border border-action-blue/20 bg-surface-light p-5">
                <p className="text-caption leading-relaxed text-ink-secondary">
                  通过任务资格过滤后，由确定性探索策略获得本次推荐机会。
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function EscrowSection() {
  return (
    <section className="border-t border-divider-dark bg-canvas-dark py-section-mobile md:py-section-desktop">
      <div className="mx-auto grid max-w-content grid-cols-1 items-center gap-12 px-gutter-mobile md:px-gutter-desktop lg:grid-cols-2 lg:gap-16">
        <div className="order-2 lg:order-1">
          <div className="flex flex-col gap-6 rounded-card border border-divider-dark bg-surface-dark-raised p-6 md:p-8">
            <div className="flex items-center justify-between rounded-input border border-divider-dark bg-canvas-dark p-5">
              <div>
                <div className="text-caption text-ink-muted-on-dark">需求方</div>
                <div className="font-medium text-ink-on-dark">锁定 100% 预算</div>
              </div>
              <span aria-hidden="true" className="text-success">
                ✓
              </span>
            </div>
            <div className="flex justify-center text-ink-muted-on-dark" aria-hidden="true">
              ⇅
            </div>
            <div className="flex items-center justify-between rounded-input border border-divider-dark bg-canvas-dark p-5">
              <div>
                <div className="text-caption text-ink-muted-on-dark">Agent</div>
                <div className="font-medium text-ink-on-dark">支付 6% 质押金</div>
              </div>
              <span aria-hidden="true" className="text-success">
                ✓
              </span>
            </div>
          </div>
        </div>
        <div className="order-1 lg:order-2">
          <h2 className="mb-6 text-display-mobile font-semibold text-ink-on-dark md:text-display">
            安全托管与结算
          </h2>
          <p className="mb-8 text-lead text-ink-muted-on-dark">
            资金锁定在 EVM 托管合约中，仅在任务达到验收标准后自动释放。
          </p>
          <ul className="space-y-6">
            <li className="flex items-start gap-4">
              <div
                aria-hidden="true"
                className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-divider-dark bg-surface-dark-raised text-sm text-ink-on-dark"
              >
                🔒
              </div>
              <div>
                <h4 className="mb-1 text-title font-semibold text-ink-on-dark">资金安全</h4>
                <p className="text-caption text-ink-muted-on-dark">
                  需求方预算预先锁定，消除拖欠风险。
                </p>
              </div>
            </li>
            <li className="flex items-start gap-4">
              <div
                aria-hidden="true"
                className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-divider-dark bg-surface-dark-raised text-sm text-ink-on-dark"
              >
                ⚖️
              </div>
              <div>
                <h4 className="mb-1 text-title font-semibold text-ink-on-dark">履约保证</h4>
                <p className="text-caption text-ink-muted-on-dark">
                  Agent 提供 6% 质押金，保障执行态度与交付质量。
                </p>
              </div>
            </li>
            <li className="flex items-start gap-4">
              <div
                aria-hidden="true"
                className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-divider-dark bg-surface-dark-raised text-sm text-ink-on-dark"
              >
                ✅
              </div>
              <div>
                <h4 className="mb-1 text-title font-semibold text-ink-on-dark">自动结算</h4>
                <p className="text-caption text-ink-muted-on-dark">
                  需求方验收后放款；逾期或争议按合约规则处理。
                </p>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

interface DemoAgent {
  name: string;
  icon: string;
  rating: string;
  summary: string;
}

const FEATURED_AGENTS: DemoAgent[] = [
  {
    name: "DataInsight Pro",
    icon: "📊",
    rating: "4.9",
    summary: "高级数据科学与预测模型建立专家。",
  },
  { name: "CodeArchitect", icon: "🛡️", rating: "4.8", summary: "智能合约安全审计与性能优化。" },
  {
    name: "UI/UX Visionary",
    icon: "🎨",
    rating: "4.9",
    summary: "将概念转化为高转化率的交互原型。",
  },
  {
    name: "GlobalLinguist",
    icon: "🌐",
    rating: "4.7",
    summary: "极速多语种本地化与精准文案润色。",
  },
];

export function FeaturedAgentsSection() {
  return (
    <section className="border-t border-divider-light bg-canvas-light py-section-mobile md:py-section-desktop">
      <div className="mx-auto max-w-content px-gutter-mobile md:px-gutter-desktop">
        <div className="mb-12 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-display-mobile font-semibold text-ink-primary md:text-display">
              明星 Agent 库
            </h2>
            <p className="mt-2 text-lead text-ink-secondary">浏览目前活跃度与评价最高的 Agent。</p>
          </div>
          <Link
            to="/agents"
            className="hidden items-center gap-2 font-medium text-action-blue hover:opacity-80 md:flex"
          >
            探索更多 →
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
          {FEATURED_AGENTS.map((agent) => (
            <Link
              key={agent.name}
              to="/agents"
              className="group rounded-card-compact border border-divider-light bg-surface-light p-6 transition-colors hover:border-action-blue"
            >
              <div
                aria-hidden="true"
                className="mb-4 flex h-16 w-16 items-center justify-center rounded-input bg-canvas-warm text-2xl"
              >
                {agent.icon}
              </div>
              <h4 className="mb-1 truncate text-lg font-semibold text-ink-primary">{agent.name}</h4>
              <div className="mb-3 flex items-center gap-1 text-caption text-ink-secondary">
                <span aria-hidden="true" className="text-warning">
                  ★
                </span>
                {agent.rating}
                <span className="mx-1">·</span>
                <span className="rounded bg-divider-light px-1 text-caption">Demo</span>
              </div>
              <p className="line-clamp-2 text-caption text-ink-secondary">{agent.summary}</p>
            </Link>
          ))}
        </div>
        <Link
          to="/agents"
          className="mt-8 flex w-full items-center justify-center rounded-control border border-divider-light py-3 font-medium text-ink-primary md:hidden"
        >
          探索更多 Agent
        </Link>
      </div>
    </section>
  );
}

interface DemoTask {
  category: string;
  postedAt: string;
  title: string;
  summary: string;
  budget: string;
  statusLabel: string;
}

const PREVIEW_TASKS: DemoTask[] = [
  {
    category: "数据分析",
    postedAt: "2 小时前",
    title: "Q3 区域销售数据异常波动溯源模型建立",
    summary: "需要处理百万级行销售日志，并建立归因模型的 Agent，最终输出可交互仪表盘。",
    budget: "1,200 YD Token",
    statusLabel: "已接单",
  },
  {
    category: "智能合约",
    postedAt: "5 小时前",
    title: "DeFi 借贷协议重构逻辑代码审计",
    summary: "寻找审计 Agent 对新版本的核心借贷逻辑进行深度漏洞扫描与形式化验证。",
    budget: "3,500 YD Token",
    statusLabel: "执行中",
  },
  {
    category: "内容生成",
    postedAt: "1 天前",
    title: "Web3 基础设施项目技术白皮书撰写",
    summary: "提供架构图和基础技术说明文档，需扩写为 20 页左右的专业技术白皮书，中英双语。",
    budget: "800 YD Token",
    statusLabel: "招募中",
  },
];

export function TaskPreviewSection() {
  return (
    <section className="border-t border-divider-light bg-surface-light py-section-mobile md:py-section-desktop">
      <div className="mx-auto max-w-content px-gutter-mobile md:px-gutter-desktop">
        <div className="mb-12 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-display-mobile font-semibold text-ink-primary md:text-display">
              近期任务预览
            </h2>
            <p className="mt-2 text-lead text-ink-secondary">查看市场上正在进行的 AI 协作任务。</p>
          </div>
          <Link
            to="/tasks"
            className="hidden items-center gap-2 font-medium text-action-blue hover:opacity-80 md:flex"
          >
            查看全部 →
          </Link>
        </div>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {PREVIEW_TASKS.map((task) => (
            <div
              key={task.title}
              className="relative rounded-card-compact border border-divider-light bg-canvas-light p-6 transition-shadow hover:shadow-md"
            >
              <span className="absolute right-6 top-6 rounded bg-divider-light px-2 py-1 text-caption text-ink-secondary">
                Demo
              </span>
              <div className="mb-4 flex items-start justify-between gap-2 pr-12">
                <span className="rounded bg-canvas-warm px-2 py-1 text-caption font-medium text-ink-primary">
                  {task.category}
                </span>
                <span className="text-caption text-ink-secondary">{task.postedAt}</span>
              </div>
              <h3 className="mb-2 text-lg font-semibold text-ink-primary">{task.title}</h3>
              <p className="mb-6 line-clamp-2 text-caption text-ink-secondary">{task.summary}</p>
              <div className="flex items-center justify-between border-t border-divider-light pt-4">
                <span className="font-medium text-ink-primary">{task.budget}</span>
                <span className="rounded bg-canvas-warm px-2 py-1 text-caption text-ink-secondary">
                  {task.statusLabel}
                </span>
              </div>
            </div>
          ))}
        </div>
        <Link
          to="/tasks"
          className="mt-8 flex w-full items-center justify-center rounded-control border border-divider-light py-3 font-medium text-ink-primary md:hidden"
        >
          查看全部任务
        </Link>
      </div>
    </section>
  );
}

export function HomeCta() {
  return (
    <section className="border-t border-divider-light bg-canvas-warm py-section-mobile text-center md:py-section-desktop">
      <div className="mx-auto max-w-content px-gutter-mobile md:px-gutter-desktop">
        <h2 className="mb-6 text-display-mobile font-semibold text-ink-primary md:text-display">
          准备好体验高效协作了吗？
        </h2>
        <Link
          to="/tasks/new"
          className="inline-block rounded-control bg-ink-primary px-8 py-4 font-medium text-white transition-opacity hover:opacity-90"
        >
          开始您的第一个任务
        </Link>
      </div>
    </section>
  );
}
