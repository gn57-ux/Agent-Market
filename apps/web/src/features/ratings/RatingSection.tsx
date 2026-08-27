import { useEffect, useState } from "react";
import { ApiError, getRating, submitRating, type RatingRecord } from "./api.js";

export interface RatingSectionProps {
  taskId: string;
  isRequester: boolean;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; rating: RatingRecord | null }
  | { status: "error"; message: string };

type SubmitState =
  { status: "idle" } | { status: "submitting" } | { status: "error"; message: string };

const SCORES = [1, 2, 3, 4, 5] as const;

/**
 * T-1006: mounted by `SettlementSection` whenever a task is settled
 * (`RELEASED`/`REFUNDED` — design.md's own decision: "RatingSection 渲染在
 * SettlementSection 内部...由 SettlementSection 决定是否展示", i.e.
 * SettlementSection only decides WHETHER to mount this, not the "already
 * rated?" detail, matching the same shallow-parent/deep-child split
 * `DisputeSection` already uses). Decides internally whether to show:
 * nothing (non-requester, not yet rated — submitting is the requester's
 * own action, F-1005), the 1-5 submission form (requester, not yet
 * rated), or a read-only "已评分" display (ANY viewer, once rated — a
 * score is not sensitive; `GET /tasks/:taskId/ratings` is a public read,
 * same reasoning `agents.quality_score` being publicly exposed already
 * establishes).
 */
export function RatingSection({ taskId, isRequester }: RatingSectionProps) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [submitState, setSubmitState] = useState<SubmitState>({ status: "idle" });

  function reload() {
    let ignore = false;
    setState({ status: "loading" });
    getRating(taskId)
      .then((rating) => {
        if (!ignore) setState({ status: "ready", rating });
      })
      .catch((error: unknown) => {
        if (ignore) return;
        if (error instanceof ApiError && error.status === 404) {
          setState({ status: "ready", rating: null });
          return;
        }
        setState({
          status: "error",
          message: error instanceof ApiError ? error.message : "加载评分信息失败。",
        });
      });
    return () => {
      ignore = true;
    };
  }

  useEffect(reload, [taskId]);

  async function handleSubmit(score: (typeof SCORES)[number]) {
    setSubmitState({ status: "submitting" });
    try {
      await submitRating(taskId, score);
      setSubmitState({ status: "idle" });
      reload();
    } catch (error) {
      setSubmitState({
        status: "error",
        message: error instanceof ApiError ? error.message : "提交评分失败，请重试。",
      });
    }
  }

  if (state.status === "loading") return null;

  if (state.status === "error") {
    return (
      <p role="alert" className="mt-4 text-caption text-warning">
        {state.message}
      </p>
    );
  }

  if (state.rating) {
    return <p className="mt-4 text-caption text-ink-primary">已评分：{state.rating.score} / 5</p>;
  }

  if (!isRequester) return null;

  return (
    <div className="mt-4 flex flex-col gap-2">
      <p className="text-caption text-ink-secondary">为本次合作评分：</p>
      <div className="flex gap-2">
        {SCORES.map((score) => (
          <button
            key={score}
            type="button"
            disabled={submitState.status === "submitting"}
            onClick={() => void handleSubmit(score)}
            className="rounded-control border border-divider-light px-3 py-1.5 text-caption font-medium text-action-blue hover:bg-canvas-warm disabled:cursor-not-allowed disabled:opacity-50"
          >
            {score}
          </button>
        ))}
      </div>
      {submitState.status === "error" && (
        <p role="alert" className="text-caption text-warning">
          {submitState.message}
        </p>
      )}
    </div>
  );
}
