import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../session/SessionProvider.js";
import { SignInButton } from "../session/SignInButton.js";
import { StatusChip } from "../../shared/components/index.js";
import { ApiError } from "../../shared/api/client.js";
import { getAdminDashboard, type AdminDashboard } from "./api.js";

type LoadState =
  | { status: "loading" }
  | { status: "forbidden" }
  | { status: "error"; message: string }
  | { status: "ready"; dashboard: AdminDashboard };

/**
 * Codex review (T-1609 round 1 P1, round 2 P2): `forAddress` records which
 * session `state` actually belongs to, tracked OUTSIDE the `LoadState`
 * union (not duplicated onto each variant) so every status — including
 * `forbidden`/`error`, not just `ready` — is covered by ONE check, not
 * three independently-maintained copies that could drift.
 *
 * `useEffect` runs AFTER React commits/paints a render — if an admin logs
 * out and a DIFFERENT address signs in while this page stays mounted,
 * there is a real (if brief) render pass where `session.status` has
 * already flipped to "signed_in" for the NEW address but `state` still
 * holds the PREVIOUS session's result (the effect hasn't fired yet to
 * reset it). Round 1's fix only tagged the `ready` case, so a `ready`→
 * different-address transition was closed, but `forbidden`/`error` were
 * still unguarded: a non-admin whose OWN request 403'd, immediately
 * followed (same tab) by a real admin signing in, would briefly see "您不是
 * 管理员" stale from the previous session — misleading, though not a data
 * leak the way `ready` was. The render guard below now applies uniformly
 * to every non-`loading` status.
 */
interface LoadStateEnvelope {
  forAddress: string | undefined;
  data: LoadState;
}

const REVIEW_STATUS_LABEL: Record<string, string> = {
  DRAFT: "草稿",
  PENDING_REVIEW: "待审核",
  ACTIVE: "已通过",
  REJECTED: "已拒绝",
  SUSPENDED: "已停用",
};

const PAGE_WRAP_CLASSES =
  "mx-auto max-w-content px-gutter-mobile pb-section-mobile pt-10 md:px-gutter-desktop md:pb-section-desktop md:pt-16";

/**
 * F-1609 (Feature 16, T-1609): the admin Dashboard front end —审核队列/
 * 争议事项列表/三类资金视图（此处展示平台视图，见 api.ts 的
 * PlatformFundsSummary 注释）/F-1610 运行指标，全部来自 T-1608b 的单一聚合端点
 * `GET /admin/dashboard`。
 *
 * NO client-side "is this address an admin" check exists anywhere in this
 * component — the ONLY authority is the server's response: a signed-in
 * non-admin gets a real 403 from `getAdminDashboard()`, rendered here as
 * the "forbidden" state. requirements.md's own non-functional requirement
 * ("管理员权限判定必须是显式、可审计的，不能是'知道某个 URL 就能访问'") is about
 * exactly this — a client-side guard here would be security theater (a
 * non-admin could still call the API directly), so this page doesn't
 * pretend to have that authority; it only renders what the server already
 * decided.
 */
export function AdminDashboardPage() {
  const session = useSession();
  const [envelope, setEnvelope] = useState<LoadStateEnvelope>({
    forAddress: undefined,
    data: { status: "loading" },
  });

  useEffect(() => {
    if (session.status !== "signed_in") {
      return;
    }
    // Captured once per effect run — the address THIS run is fetching
    // for, independent of whatever `session.address` reads as by the time
    // the request resolves (a later effect run's own `ignore` flag already
    // supersedes this one if the session changes again mid-flight).
    const forAddress = session.address;
    let ignore = false;
    setEnvelope({ forAddress, data: { status: "loading" } });
    getAdminDashboard()
      .then((dashboard) => {
        if (ignore) return;
        setEnvelope({ forAddress, data: { status: "ready", dashboard } });
      })
      .catch((error: unknown) => {
        if (ignore) return;
        if (error instanceof ApiError && error.status === 403) {
          setEnvelope({ forAddress, data: { status: "forbidden" } });
          return;
        }
        setEnvelope({
          forAddress,
          data: {
            status: "error",
            message: error instanceof ApiError ? error.message : "加载管理 Dashboard 失败。",
          },
        });
      });
    return () => {
      ignore = true;
    };
  }, [session.status, session.address]);

  if (session.status !== "signed_in") {
    return (
      <section className={PAGE_WRAP_CLASSES}>
        <h1 className="mb-3 text-display-mobile text-ink-primary md:text-display">
          管理 Dashboard
        </h1>
        <p className="mb-6 text-body text-ink-secondary">登录钱包身份后才能访问管理 Dashboard。</p>
        <SignInButton />
      </section>
    );
  }

  // Codex review (T-1609 round 1 P1, round 2 P2): a `state` whose
  // `forAddress` doesn't match the CURRENT session address belongs to a
  // previous session and must be treated as still loading, never painted —
  // for EVERY status (`ready`/`forbidden`/`error`), not only `ready`.
  const isStaleForCurrentSession = envelope.forAddress !== session.address;
  const state: LoadState = isStaleForCurrentSession ? { status: "loading" } : envelope.data;

  if (state.status === "loading") {
    return (
      <section className={PAGE_WRAP_CLASSES}>
        <p className="text-body text-ink-secondary">加载中…</p>
      </section>
    );
  }

  if (state.status === "forbidden") {
    return (
      <section className={PAGE_WRAP_CLASSES}>
        <p role="alert" className="text-body text-warning">
          该操作仅限管理员执行，您当前登录的地址不是管理员。
        </p>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className={PAGE_WRAP_CLASSES}>
        <p role="alert" className="text-body text-warning">
          {state.message}
        </p>
      </section>
    );
  }

  const { dashboard } = state;

  return (
    <section className={PAGE_WRAP_CLASSES}>
      <h1 className="mb-3 text-display-mobile text-ink-primary md:text-display">管理 Dashboard</h1>
      <p className="mb-10 text-lead text-ink-secondary">
        近 {dashboard.metrics.windowDays} 天运行概览、审核队列与资金视图。
      </p>

      <div className="mb-10 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <SummaryCard label="已发布任务数" value={dashboard.publishedTaskCount} />
        <SummaryCard label="已发布 Agent 数" value={dashboard.publishedAgentCount} />
        <SummaryCard label="待审核队列" value={dashboard.metrics.pendingReviewCount} />
        <SummaryCard label="未解决争议" value={dashboard.openDisputes.length} />
      </div>

      <SectionHeading>近 {dashboard.metrics.windowDays} 天运行指标</SectionHeading>
      <div className="mb-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard label="任务发布数" value={dashboard.metrics.tasksPublishedInWindow} />
        <SummaryCard label="任务完成数" value={dashboard.metrics.tasksCompletedInWindow} />
        <SummaryCard label="争议数量" value={dashboard.metrics.disputesInWindow} />
      </div>

      <SectionHeading>平台资金视图</SectionHeading>
      <div className="mb-10 grid grid-cols-1 gap-4 sm:grid-cols-4">
        <SummaryCard label="托管资金总量" value={dashboard.platformFunds.totalEscrowed} />
        <SummaryCard label="已放款总量" value={dashboard.platformFunds.totalReleased} />
        <SummaryCard label="已退款总量" value={dashboard.platformFunds.totalRefunded} />
        <SummaryCard label="当前活跃锁定" value={dashboard.platformFunds.activeLocked} />
      </div>

      <SectionHeading>待审核 Agent（{dashboard.reviewQueue.total}）</SectionHeading>
      {dashboard.reviewQueue.items.length === 0 ? (
        <p className="mb-10 text-body text-ink-secondary">当前没有待审核的 Agent。</p>
      ) : (
        <ul className="mb-10 divide-y divide-divider-light rounded-card border border-divider-light">
          {dashboard.reviewQueue.items.map((agent) => (
            <li key={agent.agentId} className="flex items-center justify-between gap-4 p-4">
              <div>
                <Link
                  to={`/agents/${agent.agentId}`}
                  className="font-medium text-ink-primary hover:text-action-blue"
                >
                  {agent.name}
                </Link>
                <p className="text-caption text-ink-secondary">
                  {agent.category} · {agent.ownerAddress}
                </p>
              </div>
              <StatusChip
                label={REVIEW_STATUS_LABEL[agent.reviewStatus] ?? agent.reviewStatus}
                tone="warning"
              />
            </li>
          ))}
        </ul>
      )}

      <SectionHeading>未解决争议</SectionHeading>
      {dashboard.openDisputes.length === 0 ? (
        <p className="text-body text-ink-secondary">当前没有未解决的争议。</p>
      ) : (
        <ul className="divide-y divide-divider-light rounded-card border border-divider-light">
          {dashboard.openDisputes.map((dispute) => (
            <li key={dispute.disputeId} className="flex items-center justify-between gap-4 p-4">
              <div>
                <Link
                  to={`/tasks/${dispute.taskId}`}
                  className="font-medium text-ink-primary hover:text-action-blue"
                >
                  {dispute.reason}
                </Link>
                <p className="text-caption text-ink-secondary">{dispute.requesterAddress}</p>
              </div>
              <StatusChip label="争议中" tone="warning" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SummaryCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-card border border-divider-light bg-surface-light p-4">
      <div className="mb-1 text-caption text-ink-secondary">{label}</div>
      <div className="text-[24px] font-semibold text-ink-primary">{value}</div>
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="mb-4 text-title font-semibold text-ink-primary">{children}</h2>;
}
