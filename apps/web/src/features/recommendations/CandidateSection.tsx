import { useEffect, useState } from "react";
import { StatusChip } from "../../shared/components/StatusChip.js";
import { ApiError, getRecommendations, type RecommendationCandidate } from "./api.js";

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
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let ignore = false;
    setState({ status: "loading" });
    getRecommendations(taskId)
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
  }, [taskId]);

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
        <ul className="space-y-4">
          {candidates.map((candidate) => (
            <li
              key={candidate.agentId}
              className={`rounded-control border p-4 ${
                candidate.slotType === "EXPLORATION"
                  ? "border-dashed border-divider-light"
                  : "border-divider-light"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <StatusChip
                  label={slotLabel(candidate.slotType)}
                  tone={toneFor(candidate.slotType)}
                />
                <span className="text-caption text-ink-secondary">
                  #{candidate.rank} · {shortAgentId(candidate.agentId)}
                </span>
                <span className="text-caption text-ink-secondary">
                  评分 {candidate.score.toFixed(2)}
                </span>
              </div>
              {candidate.reasons.length > 0 ? (
                <ul className="mt-2 list-inside list-disc text-caption text-ink-secondary">
                  {candidate.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
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
