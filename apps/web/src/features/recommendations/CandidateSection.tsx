import { useEffect, useState } from "react";
import { StatusChip } from "../../shared/components/StatusChip.js";
import { useSession } from "../session/SessionProvider.js";
import { getTask } from "../tasks/api.js";
import { ApiError, getRecommendations, requestMatch, type RecommendationCandidate } from "./api.js";

export interface CandidateSectionProps {
  taskId: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; candidates: RecommendationCandidate[] }
  | { status: "error"; message: string };

const SECTION_CLASSES = "mt-8 rounded-card border border-divider-light bg-surface-light p-6 md:p-8";

/** `agentId` is a UUID with no display name in this response shape
 * (design.md's fixed `GET /tasks/:taskId/recommendations` contract) —
 * shown truncated rather than fetching each candidate's Agent profile,
 * which would be a second network call this section's minimal `{ taskId }`
 * props (design.md) don't call for. */
function shortAgentId(agentId: string): string {
  return agentId.length > 8 ? `${agentId.slice(0, 8)}…` : agentId;
}

function slotLabel(slotType: RecommendationCandidate["slotType"]): string {
  return slotType === "TOP_SCORE" ? "高分候选" : "新人探索位";
}

/**
 * PRD's visual-semantics chart (§ Hero 动画 "视觉语义") assigns Amethyst
 * Purple to high-score candidates and a dashed/low-contrast purple to the
 * exploration slot — but that palette is the Three.js hero animation's own
 * vocabulary; `apps/web/tailwind.config.*`'s actual design tokens (this
 * project's real, transcribed-1:1 "唯一视觉规范", see that file's own header
 * comment) define no purple at all, and inventing one here would add a
 * color the design system doesn't have (Codex review, T-707 round 1, P2).
 * `success` (green) is reserved elsewhere in this codebase for settlement
 * outcomes (`StatusBadge`'s `RELEASED` tone) — reusing it for EXPLORATION
 * would collide with that existing meaning, which was the finding's actual
 * complaint. `neutral` plus a dashed border is the PRD's own explicitly
 * offered alternative to purple ("差异化虚线") that stays inside the real
 * token set: no new color, still visually distinct from TOP_SCORE's solid
 * `info` (blue) card.
 */
function toneFor(slotType: RecommendationCandidate["slotType"]): "info" | "neutral" {
  return slotType === "TOP_SCORE" ? "info" : "neutral";
}

/**
 * Owns the OPEN section only — fetches its own recommendations rather than
 * having `TaskDetailSections` pass them down (same per-section-fetches-its-
 * own-data convention as `FundingSection`, T-707 capsule).
 *
 * Does NOT render an "接单" action or fetch/display acceptance permits —
 * accepting a task is Feature 8's scope (PRD §8.4/§9.4: the first candidate
 * to submit a valid permit + 6% stake becomes the task's Agent); this
 * section only displays what `POST /tasks/:taskId/match` already computed
 * and `GET /tasks/:taskId/recommendations` returns.
 */
export function CandidateSection({ taskId }: CandidateSectionProps) {
  const session = useSession();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let ignore = false;
    setState({ status: "loading" });
    const prepareRecommendations = async () => {
      if (session.status === "signed_in" && session.address) {
        const task = await getTask(taskId);
        if (task.requesterAddress === session.address) {
          await requestMatch(taskId);
        }
      }
      return getRecommendations(taskId);
    };

    prepareRecommendations()
      .then((result) => {
        if (!ignore) setState({ status: "ready", candidates: result.recommendations });
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setState({
          status: "error",
          message: error instanceof ApiError ? error.message : "加载推荐候选失败。",
        });
      });
    return () => {
      ignore = true;
    };
  }, [taskId, session.status, session.address]);

  if (state.status === "loading") {
    return (
      <div className={SECTION_CLASSES}>
        <p className="text-body text-ink-secondary">加载中…</p>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className={SECTION_CLASSES}>
        <p role="alert" className="text-body text-warning">
          {state.message}
        </p>
      </div>
    );
  }

  const { candidates } = state;

  return (
    <div className={SECTION_CLASSES}>
      <h2 className="mb-4 text-[20px] font-semibold text-ink-primary">推荐候选</h2>
      {candidates.length === 0 ? (
        // AC-706: no candidates → this exact message, never a fabricated or
        // placeholder Agent entry.
        <p className="text-body text-ink-secondary">暂无合适 Agent</p>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-3">
          {candidates.map((candidate) => (
            <li
              key={candidate.agentId}
              className={`flex min-w-0 flex-col rounded-[24px] border bg-white p-5 shadow-[0_12px_32px_rgba(17,24,39,0.05)] transition-transform duration-200 hover:-translate-y-0.5 ${
                candidate.slotType === "EXPLORATION"
                  ? "border-dashed border-divider-light"
                  : "border-divider-light"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink-primary text-caption font-semibold text-white">
                    #{candidate.rank}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-body font-semibold text-ink-primary">候选 Agent</p>
                    <p className="truncate text-caption text-ink-secondary">
                      {shortAgentId(candidate.agentId)}
                    </p>
                  </div>
                </div>
                <span className="shrink-0 rounded-full bg-surface-subtle px-3 py-1 text-caption font-medium text-ink-primary">
                  评分 {candidate.score.toFixed(2)}
                </span>
              </div>
              <div className="mt-4">
                <StatusChip
                  label={slotLabel(candidate.slotType)}
                  tone={toneFor(candidate.slotType)}
                />
              </div>
              {candidate.reasons.length > 0 ? (
                <ul className="mt-4 space-y-2 border-t border-divider-light pt-4 text-caption text-ink-secondary">
                  {candidate.reasons.map((reason) => (
                    <li key={reason} className="flex gap-2">
                      <span
                        aria-hidden="true"
                        className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-action-blue"
                      />
                      <span>{reason}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
