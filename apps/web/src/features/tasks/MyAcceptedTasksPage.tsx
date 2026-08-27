import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { HexAddress } from "@agent-market/domain";
import { formatAmount } from "@agent-market/domain";
import { useWallet } from "../wallet/WalletProvider.js";
import { useSession } from "../session/SessionProvider.js";
import { SignInButton } from "../session/SignInButton.js";
import { TaskCard } from "../../shared/components/TaskCard.js";
import {
  ApiError,
  listCandidateInvitations,
  listTasks,
  type CandidateInvitation,
  type TaskRecord,
} from "./api.js";
import { toTaskStatus } from "./MyPublishedTasksPage.js";

/**
 * F-806/AC-805: "我的接单" — must show BOTH the candidate-invitation state
 * (recommended but not yet accepted) AND the already-accepted state, for
 * the currently SIGNED-IN wallet. `MyAcceptedTasksPage`'s own docstring
 * used to say the candidate-invitation state was deliberately left out as
 * a pre-approved simplification (T-805) — that reasoning was WRONG (human
 * N6 BLOCK, T-808 fix): F-806's requirement text always said "候选邀请与已
 * 接单两态", and the simplification was never actually authorized in
 * design.md, just assumed. This page now fetches both states from the
 * server on every mount (`GET /tasks?acceptedBy=` for ACCEPTED, `GET
 * /tasks/agents/candidate-invitations` for INVITED) and keeps neither in
 * any client-only/local state — a refresh always reflects exactly what the
 * server currently reports (AC-805's "页面刷新后状态一致").
 *
 * Uses `session.address`, never `wallet.address`, for both queries — same
 * lesson as `MyPublishedTasksPage.tsx` (human review, T-606 round 3): the
 * server only trusts the AUTHENTICATED session (via cookie, for the
 * candidate-invitations endpoint; via explicit `acceptedBy` query param,
 * for the accepted-tasks endpoint), and `wallet.address` can lag/lead it
 * right after an account switch. `wallet.address` is used here ONLY to
 * decide whether to show the "connect a wallet" prompt.
 */

/**
 * Discriminated union distinguishing the two states a "我的接单" list item
 * can be in — deliberately NOT a boolean flag (e.g. `isAccepted: boolean`)
 * per this project's CLAUDE.md 原则 8 (尽可能让非法状态无法表示): a boolean
 * can't express "this item additionally carries `rank`/`slotType`" vs.
 * "this item carries the full `TaskRecord`" without an unsafe cast
 * somewhere, whereas the `kind` tag lets every render branch below
 * exhaustively narrow to the exact fields that state actually has.
 */
type MyAcceptanceItem =
  | {
      kind: "INVITED";
      taskId: string;
      /** T-808 round 1, P2 (Codex): kept — the same wallet can own two
       * different recommended Agents on the same task
       * (`getCandidateInvitationsForSession`'s own per-`agentId` join), so
       * `taskId` alone cannot identify one invitation. Dropping this
       * previously collapsed two real, independent invitations into one
       * indistinguishable rendered item with a duplicate React key. */
      agentId: string;
      category: string;
      title: string;
      budget: string;
      deliveryDeadline: string;
      rank: number;
      slotType: string;
    }
  | { kind: "ACCEPTED"; task: TaskRecord };

function toInvitedItem(invitation: CandidateInvitation): MyAcceptanceItem {
  return {
    kind: "INVITED",
    taskId: invitation.taskId,
    agentId: invitation.agentId,
    category: invitation.category,
    title: invitation.title,
    budget: invitation.budget,
    deliveryDeadline: invitation.deliveryDeadline,
    rank: invitation.rank,
    slotType: invitation.slotType,
  };
}

function toAcceptedItem(task: TaskRecord): MyAcceptanceItem {
  return { kind: "ACCEPTED", task };
}

type SectionState<T> =
  | { status: "loading" }
  | { status: "ready"; items: T[]; total: number; page: number; pageSize: number }
  | { status: "error"; message: string };

export function MyAcceptedTasksPage() {
  const wallet = useWallet();
  const session = useSession();
  const [acceptedState, setAcceptedState] = useState<SectionState<TaskRecord>>({
    status: "loading",
  });
  const [invitedState, setInvitedState] = useState<SectionState<CandidateInvitation>>({
    status: "loading",
  });
  // Same pagination-tracking reasoning as MyPublishedTasksPage.tsx: `GET
  // /tasks` caps `pageSize` to 20 (schema.ts) — an agent with more than 20
  // accepted tasks would silently lose everything past page 1 without this.
  const [page, setPage] = useState(1);
  // T-808 round 1, P2 (Codex): "at most 3 candidate slots per TASK" does
  // not bound how many DIFFERENT tasks a wallet holds a live invitation
  // for — a wallet recommended across more than 20 tasks would silently
  // lose every invitation past page 1 without its own pagination state,
  // independent of the accepted-tasks `page` above.
  const [invitedPage, setInvitedPage] = useState(1);

  const walletConnected = wallet.address !== undefined;
  const signedIn = session.status === "signed_in";
  const sessionAddress = session.address;

  // Resets pagination whenever the AUTHENTICATED identity changes — same
  // reasoning as MyPublishedTasksPage.tsx (Codex review, T-607 round 2, P2).
  useEffect(() => {
    setPage(1);
    setInvitedPage(1);
  }, [sessionAddress]);

  useEffect(() => {
    if (!signedIn || !sessionAddress) {
      return;
    }
    let ignore = false;
    setAcceptedState({ status: "loading" });
    listTasks({ acceptedBy: sessionAddress, page })
      .then((result) => {
        if (ignore) return;
        setAcceptedState({
          status: "ready",
          items: result.items,
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
        });
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setAcceptedState({
          status: "error",
          message: error instanceof ApiError ? error.message : "加载我的接单列表失败。",
        });
      });
    return () => {
      ignore = true;
    };
  }, [signedIn, sessionAddress, page]);

  // Independent fetch, independent load state — a failure/slow response on
  // one section must not block or hide the other (both are real,
  // independently-sourced server data, not a single combined call).
  useEffect(() => {
    if (!signedIn || !sessionAddress) {
      return;
    }
    let ignore = false;
    setInvitedState({ status: "loading" });
    listCandidateInvitations({ page: invitedPage, pageSize: 20 })
      .then((result) => {
        if (ignore) return;
        setInvitedState({
          status: "ready",
          items: result.items,
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
        });
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setInvitedState({
          status: "error",
          message: error instanceof ApiError ? error.message : "加载候选邀请列表失败。",
        });
      });
    return () => {
      ignore = true;
    };
    // Re-fetches on every `sessionAddress` or `invitedPage` change (an
    // account switch, since this endpoint is session-scoped server-side and
    // takes no explicit address param, or a page navigation) — same
    // "AUTHENTICATED identity" trigger as the accepted-tasks fetch above.
  }, [signedIn, sessionAddress, invitedPage]);

  const invitedItems: MyAcceptanceItem[] =
    invitedState.status === "ready" ? invitedState.items.map(toInvitedItem) : [];
  const acceptedItems: MyAcceptanceItem[] =
    acceptedState.status === "ready" ? acceptedState.items.map(toAcceptedItem) : [];

  return (
    <section className="mx-auto max-w-content px-gutter-mobile pb-section-mobile pt-10 md:px-gutter-desktop md:pb-section-desktop md:pt-16">
      <header className="mb-10 max-w-reading">
        <h1 className="text-display-mobile text-ink-primary md:text-display">我的接单</h1>
        <p className="mt-3 text-lead text-ink-secondary">
          查看你收到的候选邀请与已接单的全部任务。
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
        <div className="flex flex-col gap-12">
          <section aria-labelledby="candidate-invitations-heading">
            <h2 id="candidate-invitations-heading" className="mb-4 text-heading text-ink-primary">
              候选邀请
            </h2>
            {invitedState.status === "loading" && (
              <p className="text-body text-ink-secondary">加载中…</p>
            )}
            {invitedState.status === "error" && (
              <p role="alert" className="text-body text-warning">
                {invitedState.message}
              </p>
            )}
            {invitedState.status === "ready" && (
              <>
                {invitedItems.length === 0 ? (
                  <p className="py-8 text-center text-body text-ink-secondary">
                    你还没有收到候选邀请。
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                    {invitedItems.map((item) =>
                      item.kind === "INVITED" ? (
                        // T-808 round 1, P2 (Codex): composite key — `taskId`
                        // alone collides when the same wallet owns two
                        // recommended Agents on one task (see this item
                        // type's own `agentId` field doc comment above).
                        <Link key={`${item.taskId}-${item.agentId}`} to={`/tasks/${item.taskId}`}>
                          <article
                            data-task-id={item.taskId}
                            data-agent-id={item.agentId}
                            data-invitation-kind="INVITED"
                            className="rounded-control border border-divider-light p-4"
                          >
                            <h3 className="text-body font-medium text-ink-primary">{item.title}</h3>
                            <p className="mt-1 text-caption text-ink-secondary">
                              {formatAmount(BigInt(item.budget))} YD · 第 {item.rank} 名候选（
                              {item.slotType}）
                            </p>
                          </article>
                        </Link>
                      ) : null,
                    )}
                  </div>
                )}
                {invitedState.total > 0 && (
                  // Same "keyed on total, not items.length" convention as
                  // the accepted-tasks section below (T-608 round 1, P2) —
                  // independent pagination state (`invitedPage`), since this
                  // section's total is unrelated to the accepted section's.
                  <div className="mt-10 flex items-center justify-center gap-4 text-caption text-ink-secondary">
                    <button
                      type="button"
                      disabled={invitedState.page <= 1}
                      onClick={() => setInvitedPage(invitedPage - 1)}
                      className="rounded-control border border-divider-light px-4 py-2 transition-colors hover:bg-canvas-warm disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      上一页
                    </button>
                    <span>
                      第 {invitedState.page} 页 / 共 {invitedState.total} 条
                    </span>
                    <button
                      type="button"
                      disabled={invitedState.page * invitedState.pageSize >= invitedState.total}
                      onClick={() => setInvitedPage(invitedPage + 1)}
                      className="rounded-control border border-divider-light px-4 py-2 transition-colors hover:bg-canvas-warm disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      下一页
                    </button>
                  </div>
                )}
              </>
            )}
          </section>

          <section aria-labelledby="accepted-tasks-heading">
            <h2 id="accepted-tasks-heading" className="mb-4 text-heading text-ink-primary">
              已接单
            </h2>
            {acceptedState.status === "loading" && (
              <p className="text-body text-ink-secondary">加载中…</p>
            )}
            {acceptedState.status === "error" && (
              <p role="alert" className="text-body text-warning">
                {acceptedState.message}
              </p>
            )}
            {acceptedState.status === "ready" && (
              <>
                {acceptedItems.length === 0 ? (
                  <p className="py-16 text-center text-body text-ink-secondary">
                    你还没有接过任务。
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                    {acceptedItems.map((item) =>
                      item.kind === "ACCEPTED" ? (
                        <Link key={item.task.taskId} to={`/tasks/${item.task.taskId}`}>
                          <TaskCard
                            taskId={item.task.taskId}
                            title={item.task.title}
                            budgetDisplay={`${formatAmount(BigInt(item.task.budget))} YD`}
                            status={toTaskStatus(
                              item.task,
                              item.task.acceptedAgentAddress as HexAddress | null,
                            )}
                          />
                        </Link>
                      ) : null,
                    )}
                  </div>
                )}
                {acceptedState.total > 0 && (
                  // Keyed on `total`, not `items.length` — same lesson as
                  // MyPublishedTasksPage.tsx (Codex review, T-608 round 1, P2).
                  <div className="mt-10 flex items-center justify-center gap-4 text-caption text-ink-secondary">
                    <button
                      type="button"
                      disabled={acceptedState.page <= 1}
                      onClick={() => setPage(page - 1)}
                      className="rounded-control border border-divider-light px-4 py-2 transition-colors hover:bg-canvas-warm disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      上一页
                    </button>
                    <span>
                      第 {acceptedState.page} 页 / 共 {acceptedState.total} 条
                    </span>
                    <button
                      type="button"
                      disabled={acceptedState.page * acceptedState.pageSize >= acceptedState.total}
                      onClick={() => setPage(page + 1)}
                      className="rounded-control border border-divider-light px-4 py-2 transition-colors hover:bg-canvas-warm disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      下一页
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
