import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { HexAddress, TaskStatus } from "@agent-market/domain";
import { formatAmount } from "@agent-market/domain";
import { useWallet } from "../wallet/WalletProvider.js";
import { useSession } from "../session/SessionProvider.js";
import { SignInButton } from "../session/SignInButton.js";
import { TaskCard } from "../../shared/components/TaskCard.js";
import { ApiError, listTasks, type TaskRecord } from "./api.js";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; items: TaskRecord[]; total: number; page: number; pageSize: number }
  | { status: "error"; message: string };

/**
 * `GET /tasks`'s response (`toTaskDraftJson`, apps/api's routes.ts) still
 * does not carry every extra field `@agent-market/domain`'s `TaskStatus`
 * union requires for `SUBMITTED` (`submittedAt`/`reviewDeadline`) — those
 * live in Feature 9's own tables, not yet joined into this list response.
 * `ACCEPTED`/`DISPUTED`'s `agent` field WAS this placeholder too, until
 * T-805 extended `GET /tasks` to serialize `acceptedAgentAddress` (see
 * `toTaskStatus` below, which now takes that field as real input instead of
 * always substituting this constant for it). Neither `StatusBadge` nor
 * `TaskCard` reads `submittedAt`/`reviewDeadline` today — both switch on
 * `status.kind` only — so this placeholder still satisfies `TaskStatus`'s
 * type contract there without rendering anything fabricated.
 */
const STATUS_FIELD_NOT_YET_EXPOSED: HexAddress = "0x0000000000000000000000000000000000000000";

/**
 * Exported for reuse by `TaskMarketPage` (T-607) and `MyAcceptedTasksPage`
 * (T-805): every page rendering `TaskRecord.status` through the same
 * `TaskCard`/`StatusBadge` contract must share this one implementation — a
 * second, independently-written copy could silently drift (e.g. a status
 * added here but not there) with no compiler check to catch it.
 *
 * `acceptedAgentAddress` is a separate parameter (not folded into the `Pick`
 * below) so call sites are forced to pass whatever `GET /tasks` actually
 * returned for it — `record.acceptedAgentAddress ?? STATUS_FIELD_NOT_YET_EXPOSED`
 * only falls back to the placeholder for a task that is genuinely not yet
 * accepted (or a caller that hasn't been updated to request the field),
 * never silently drops a real value.
 */
export function toTaskStatus(
  record: Pick<TaskRecord, "status" | "updatedAt">,
  acceptedAgentAddress: HexAddress | null,
): TaskStatus {
  switch (record.status) {
    case "DRAFT":
      return { kind: "DRAFT" };
    case "AWAITING_FUNDING":
      return { kind: "AWAITING_FUNDING" };
    case "OPEN":
      return { kind: "OPEN" };
    case "ACCEPTED":
      return { kind: "ACCEPTED", agent: acceptedAgentAddress ?? STATUS_FIELD_NOT_YET_EXPOSED };
    case "SUBMITTED":
      return {
        kind: "SUBMITTED",
        agent: acceptedAgentAddress ?? STATUS_FIELD_NOT_YET_EXPOSED,
        submittedAt: record.updatedAt,
        reviewDeadline: record.updatedAt,
      };
    case "DISPUTED":
      return { kind: "DISPUTED", agent: acceptedAgentAddress ?? STATUS_FIELD_NOT_YET_EXPOSED };
    case "RELEASED":
      return { kind: "RELEASED" };
    case "REFUNDED":
      return { kind: "REFUNDED" };
    case "CANCELLED":
      return { kind: "CANCELLED" };
  }
}

/**
 * AC-606: "我的发布" — the requester's own tasks across every lifecycle
 * status (draft/待确认/开放/…), fetched via `GET /tasks?requester=<自己地址>`
 * (T-605). The `requester` filter MUST come from `session.address`, never
 * `wallet.address` (human review, T-606 round 3): the server only includes
 * DRAFT/AWAITING_FUNDING tasks when the AUTHENTICATED session address
 * matches `requester` exactly (`listTasksForMarket`'s doc comment,
 * service.ts) — `wallet.address` is whatever MetaMask currently reports and
 * can differ from (or briefly lag/lead) the address a session was actually
 * established for (e.g. right after an account switch, before the user has
 * re-signed-in). Querying with `wallet.address` in that window would either
 * ask the server about a DIFFERENT address than the one this page's caller
 * believes is "me", or — since `requester` not matching the session address
 * makes it a public-only query — silently show just the published (OPEN+)
 * subset while this page still claimed "全部任务". `wallet.address` is used
 * ONLY to decide whether to show the "connect a wallet" prompt below;
 * `session.address` is the sole source of the authenticated identity this
 * page queries with.
 */
export function MyPublishedTasksPage() {
  const wallet = useWallet();
  const session = useSession();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // `GET /tasks` defaults/caps `pageSize` to 20 (schema.ts) — without
  // tracking and paging through it, a requester with more than 20 tasks
  // silently loses every task past the first page, despite this page
  // claiming to show "全部任务" (Codex review, T-607 round 1, P1).
  const [page, setPage] = useState(1);

  const walletConnected = wallet.address !== undefined;
  const signedIn = session.status === "signed_in";
  const sessionAddress = session.address;

  // Resets pagination whenever the AUTHENTICATED identity changes (Codex
  // review, T-607 round 2, P2): without this, a user who left off on page 2+
  // and then signs in as a different address would query that new address's
  // page 2 directly — if it has fewer tasks, the empty result hides the
  // pagination controls entirely, leaving no way back to page 1.
  useEffect(() => {
    setPage(1);
  }, [sessionAddress]);

  useEffect(() => {
    if (!signedIn || !sessionAddress) {
      return;
    }
    let ignore = false;
    setState({ status: "loading" });
    listTasks({ requester: sessionAddress, page })
      .then((result) => {
        if (ignore) return;
        setState({
          status: "ready",
          items: result.items,
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
        });
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setState({
          status: "error",
          message: error instanceof ApiError ? error.message : "加载我的发布列表失败。",
        });
      });
    return () => {
      ignore = true;
    };
  }, [signedIn, sessionAddress, page]);

  return (
    <section className="mx-auto max-w-content px-gutter-mobile pb-section-mobile pt-10 md:px-gutter-desktop md:pb-section-desktop md:pt-16">
      <header className="mb-10 flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
        <div className="max-w-reading">
          <h1 className="text-display-mobile text-ink-primary md:text-display">我的发布</h1>
          <p className="mt-3 text-lead text-ink-secondary">
            查看你发布的全部任务，包括草稿、待确认资金与已开放招募的任务。
          </p>
        </div>
        <Link
          to="/tasks/new"
          className="whitespace-nowrap rounded-control bg-action-blue px-6 py-3 text-body font-medium text-white transition-opacity hover:opacity-90"
        >
          发布新任务
        </Link>
      </header>

      {!walletConnected ? (
        <p role="alert" className="text-body text-ink-secondary">
          请先连接 MetaMask 钱包，才能查看你发布的任务。
        </p>
      ) : !signedIn || !sessionAddress ? (
        <div role="alert" className="flex flex-col items-start gap-3">
          <p className="text-body text-ink-secondary">
            请先登录以查看包含草稿在内的完整发布记录（未登录只能看到已开放招募等已发布状态）。
          </p>
          <SignInButton />
        </div>
      ) : (
        <>
          {state.status === "loading" && <p className="text-body text-ink-secondary">加载中…</p>}
          {state.status === "error" && (
            <p role="alert" className="text-body text-warning">
              {state.message}
            </p>
          )}
          {state.status === "ready" && (
            <>
              {state.items.length === 0 ? (
                <p className="py-16 text-center text-body text-ink-secondary">
                  你还没有发布过任务。
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                  {state.items.map((task) => (
                    <Link key={task.taskId} to={`/tasks/${task.taskId}`}>
                      <TaskCard
                        taskId={task.taskId}
                        title={task.title}
                        description={task.description}
                        category={task.category}
                        skillTags={task.skillTags}
                        deliveryDeadline={task.deliveryDeadline}
                        budgetDisplay={`${formatAmount(BigInt(task.budget))} YD`}
                        status={toTaskStatus(
                          task,
                          // `tasks.accepted_agent_address` is CHECK-constrained to
                          // `^0x[0-9a-f]{40}$` at the database layer
                          // (0006_add_dispatch_matching_fields.sql) — this cast
                          // trusts that constraint rather than re-validating the
                          // shape client-side, matching SessionProvider.tsx's and
                          // WalletProvider.tsx's identical trust-the-server casts.
                          task.acceptedAgentAddress as HexAddress | null,
                        )}
                      />
                    </Link>
                  ))}
                </div>
              )}
              {state.total > 0 && (
                // Keyed on `total`, not `items.length` (same lesson as
                // TaskMarketPage, Codex review, T-608 round 1, P2): a page
                // 2+ view can return an empty `items` array while `total`
                // stays nonzero, and hiding pagination then would strand the
                // viewer on a false empty state with no way back to page 1.
                <div className="mt-10 flex items-center justify-center gap-4 text-caption text-ink-secondary">
                  <button
                    type="button"
                    disabled={state.page <= 1}
                    onClick={() => setPage(page - 1)}
                    className="rounded-control border border-divider-light px-4 py-2 transition-colors hover:bg-canvas-warm disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    上一页
                  </button>
                  <span>
                    第 {state.page} 页 / 共 {state.total} 条
                  </span>
                  <button
                    type="button"
                    disabled={state.page * state.pageSize >= state.total}
                    onClick={() => setPage(page + 1)}
                    className="rounded-control border border-divider-light px-4 py-2 transition-colors hover:bg-canvas-warm disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    下一页
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
