import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { HexAddress } from "@agent-market/domain";
import { formatAmount } from "@agent-market/domain";
import { useWallet } from "../wallet/WalletProvider.js";
import { useSession } from "../session/SessionProvider.js";
import { SignInButton } from "../session/SignInButton.js";
import { TaskCard } from "../../shared/components/TaskCard.js";
import { ApiError, listTasks, type TaskRecord } from "./api.js";
import { toTaskStatus } from "./MyPublishedTasksPage.js";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; items: TaskRecord[]; total: number; page: number; pageSize: number }
  | { status: "error"; message: string };

/**
 * F-806/AC-805: "我的接单" — tasks the CURRENTLY SIGNED-IN wallet has been
 * accepted for, fetched via `GET /tasks?acceptedBy=<自己地址>` (T-805). Uses
 * `session.address`, never `wallet.address` — same lesson as
 * `MyPublishedTasksPage.tsx` (human review, T-606 round 3, see that file's
 * own extensive doc comment): the server only trusts the AUTHENTICATED
 * session address, and `wallet.address` can lag/lead it right after an
 * account switch, before the user has re-signed-in. `wallet.address` is
 * used here ONLY to decide whether to show the "connect a wallet" prompt.
 *
 * Deliberately scoped to the "已接单" state only, per the T-805 task
 * capsule's pre-approved simplification: a "候选邀请" (pending, not-yet-
 * accepted invitation) aggregate view would need a query design.md does not
 * define (`recommendation_candidates` is keyed by `agentId`, scattered
 * across every OPEN task, with no existing "tasks I'm a candidate for by
 * wallet address" query) — building one here would be a new backend
 * decision, out of this Task's scope. Candidate invitations remain visible
 * on each task's own detail page (`AcceptanceSection`/`CandidateSection`).
 */
export function MyAcceptedTasksPage() {
  const wallet = useWallet();
  const session = useSession();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // Same pagination-tracking reasoning as MyPublishedTasksPage.tsx: `GET
  // /tasks` caps `pageSize` to 20 (schema.ts) — an agent with more than 20
  // accepted tasks would silently lose everything past page 1 without this.
  const [page, setPage] = useState(1);

  const walletConnected = wallet.address !== undefined;
  const signedIn = session.status === "signed_in";
  const sessionAddress = session.address;

  // Resets pagination whenever the AUTHENTICATED identity changes — same
  // reasoning as MyPublishedTasksPage.tsx (Codex review, T-607 round 2, P2).
  useEffect(() => {
    setPage(1);
  }, [sessionAddress]);

  useEffect(() => {
    if (!signedIn || !sessionAddress) {
      return;
    }
    let ignore = false;
    setState({ status: "loading" });
    listTasks({ acceptedBy: sessionAddress, page })
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
          message: error instanceof ApiError ? error.message : "加载我的接单列表失败。",
        });
      });
    return () => {
      ignore = true;
    };
  }, [signedIn, sessionAddress, page]);

  return (
    <section className="mx-auto max-w-content px-gutter-mobile pb-section-mobile pt-10 md:px-gutter-desktop md:pb-section-desktop md:pt-16">
      <header className="mb-10 max-w-reading">
        <h1 className="text-display-mobile text-ink-primary md:text-display">我的接单</h1>
        <p className="mt-3 text-lead text-ink-secondary">
          查看你已接单的全部任务。候选邀请（尚未接单）请前往具体任务详情页查看。
        </p>
      </header>

      {!walletConnected ? (
        <p role="alert" className="text-body text-ink-secondary">
          请先连接 MetaMask 钱包，才能查看你的接单记录。
        </p>
      ) : !signedIn || !sessionAddress ? (
        <div role="alert" className="flex flex-col items-start gap-3">
          <p className="text-body text-ink-secondary">请先登录以查看你的接单记录。</p>
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
                <p className="py-16 text-center text-body text-ink-secondary">你还没有接过任务。</p>
              ) : (
                <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                  {state.items.map((task) => (
                    <Link key={task.taskId} to={`/tasks/${task.taskId}`}>
                      <TaskCard
                        taskId={task.taskId}
                        title={task.title}
                        budgetDisplay={`${formatAmount(BigInt(task.budget))} YD`}
                        status={toTaskStatus(task, task.acceptedAgentAddress as HexAddress | null)}
                      />
                    </Link>
                  ))}
                </div>
              )}
              {state.total > 0 && (
                // Keyed on `total`, not `items.length` — same lesson as
                // MyPublishedTasksPage.tsx (Codex review, T-608 round 1, P2).
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
