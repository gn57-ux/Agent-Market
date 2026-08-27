/**
 * The single normalization step between a requester's raw 1-5 rating and
 * `agents.quality_score`'s stored [0,1] scale (0004_create_agents.sql's
 * `CHECK (quality_score BETWEEN 0 AND 1)`, consumed directly by
 * services/dispatch's Go scoring engine as an already-normalized value).
 * `(mean - 1) / 4` maps 1→0.0 and 5→1.0 linearly; normalizing the mean is
 * mathematically identical to averaging each normalized score
 * individually, so there is exactly one place this formula lives.
 *
 * Returns `null` (never `0` or any other placeholder) for an empty input —
 * AC-1010's own explicit requirement: "0 分和'没有评分'在业务语义上完全不同"
 * (design.md). This is this module's ENTIRE responsibility — it does not
 * read or write `completedTaskCount`/`successCount`/`overdueCount`
 * (AC-1008), and it never substitutes Feature 7's versioned neutral prior
 * for a missing real score (F-1006).
 */
export function aggregateQualityScore(scores: readonly number[]): number | null {
  if (scores.length === 0) {
    return null;
  }
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  return (mean - 1) / 4;
}
