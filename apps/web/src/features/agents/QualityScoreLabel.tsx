/**
 * Single place that decides how a `null` qualityScore renders (F-506's
 * risk note in tasks.md: every display path must handle `null` explicitly
 * — rendering it as the literal string "null" or as 0 stars would
 * misrepresent "no real rating yet" as an actual low/zero rating). Both
 * pages that show a quality score (AgentMarketPage's cards, AgentDetailPage)
 * go through this instead of each re-deciding the null case.
 */
export function QualityScoreLabel({ score }: { score: number | null }) {
  if (score === null) {
    return <span>暂无评分</span>;
  }
  return <span>质量分：{score.toFixed(2)}</span>;
}
