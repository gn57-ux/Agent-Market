/**
 * F-2006/T-2005: 刷分检测 (SCORE_MANIPULATION) — a pure, DB-free function
 * over already-fetched candidate rows. Deliberately takes no `Pool`/
 * `Queryable` and imports nothing from any other module (design.md's own
 * "反作弊检测模块不允许 import 任何会写入 agents/tasks/链上交易的模块"
 * boundary, made structural: this file has no way to write ANY business
 * state even by accident, since it never touches a database connection at
 * all — the SAME "fetch raw facts via SQL, decide via a pure function"
 * split this codebase already uses for `rule-scorer.ts` (T-2001) and Go's
 * `eligibility.Filter`).
 *
 * Design comparison (CLAUDE.md 原则 3): (A) embed the detection rule
 * directly in a single aggregating SQL query — chosen against, since a
 * sliding-window-over-distinct-requesters algorithm is real, non-trivial
 * logic that's far easier to unit-test with plain fixture arrays than to
 * verify via a hand-rolled window-function SQL query, and per-detector
 * threshold tuning (this is a heuristic risk signal, not a determinstic
 * rule — F-2010) shouldn't require touching SQL. (B, chosen) repository.ts
 * fetches raw rating+requester-age rows; this function decides. Matches
 * this module's own architectural mandate (design.md 决策 1): detection is
 * a read-only analysis bypass, never fused with the write path.
 */

export interface RatingCandidate {
  ratingId: string;
  agentId: string;
  requesterAddress: string;
  score: number;
  ratedAt: Date;
  requesterCreatedAt: Date;
}

export interface ScoreManipulationEvidence {
  windowStart: string;
  windowEnd: string;
  ratingIds: string[];
  requesterAddresses: string[];
}

export interface ScoreManipulationSignal {
  agentId: string;
  evidence: ScoreManipulationEvidence;
}

export interface ScoreManipulationDetectionConfig {
  /** "高分" — `ratings.score` is a 1-5 SMALLINT (0012_create_ratings.sql);
   * 5 is the literal maximum, the least-arguable reading of "高分". */
  highScoreThreshold: number;
  /** "新注册" — the requester's account age (rating time minus
   * `users.created_at`) at the moment of rating, in days. A LOW-STAKES,
   * documented heuristic constant (unlike T-2009's admission-gate
   * threshold): this module never changes business state itself (decision
   * 1) — a false positive here only ever creates one more `risk_signals`
   * row an admin reviews and can dismiss (F-2010), so no Q-2001-style
   * external decision is required before choosing a reasonable default. */
  newAccountMaxAgeDays: number;
  /** "短时间内" — the sliding window width, in hours, within which
   * qualifying ratings must cluster. */
  suspiciousWindowHours: number;
  /** "大量" — minimum count of DISTINCT requester addresses (not raw
   * rating count) within the window before a signal is raised. Distinct
   * addresses, not just rating rows, because F-2006's own wording
   * ("来自新注册...账号") describes a pattern across MULTIPLE accounts —
   * one requester rating the same Agent several times (across different
   * tasks; `ratings.task_id` is UNIQUE so it can't rate the same task
   * twice) is a different, weaker signal this detector deliberately does
   * not treat as equivalent to several distinct new accounts colluding. */
  suspiciousRequesterCountThreshold: number;
}

export const DEFAULT_SCORE_MANIPULATION_CONFIG: ScoreManipulationDetectionConfig = {
  highScoreThreshold: 5,
  newAccountMaxAgeDays: 3,
  suspiciousWindowHours: 24,
  suspiciousRequesterCountThreshold: 3,
};

/**
 * Returns at most one signal per Agent per call — a single qualifying
 * window is sufficient evidence for one `risk_signals` row; the governance
 * flow (T-2008) is what an admin uses to investigate the full pattern, not
 * this function enumerating every overlapping window.
 */
export function detectScoreManipulation(
  candidates: readonly RatingCandidate[],
  config: ScoreManipulationDetectionConfig = DEFAULT_SCORE_MANIPULATION_CONFIG,
): ScoreManipulationSignal[] {
  const newAccountMaxAgeMs = config.newAccountMaxAgeDays * 24 * 60 * 60 * 1000;
  const windowMs = config.suspiciousWindowHours * 60 * 60 * 1000;

  const qualifying = candidates.filter((c) => {
    if (c.score < config.highScoreThreshold) return false;
    const accountAgeAtRatingMs = c.ratedAt.getTime() - c.requesterCreatedAt.getTime();
    return accountAgeAtRatingMs >= 0 && accountAgeAtRatingMs <= newAccountMaxAgeMs;
  });

  const byAgent = new Map<string, RatingCandidate[]>();
  for (const c of qualifying) {
    const existing = byAgent.get(c.agentId);
    if (existing) {
      existing.push(c);
    } else {
      byAgent.set(c.agentId, [c]);
    }
  }

  const signals: ScoreManipulationSignal[] = [];
  for (const [agentId, ratings] of byAgent) {
    const sorted = [...ratings].sort((a, b) => a.ratedAt.getTime() - b.ratedAt.getTime());

    let left = 0;
    for (let right = 0; right < sorted.length; right++) {
      const rightRating = sorted[right];
      if (!rightRating) continue;
      let leftRating = sorted[left];
      while (
        leftRating &&
        rightRating.ratedAt.getTime() - leftRating.ratedAt.getTime() > windowMs
      ) {
        left++;
        leftRating = sorted[left];
      }
      if (!leftRating) continue;

      const windowSlice = sorted.slice(left, right + 1);
      const distinctRequesters = [...new Set(windowSlice.map((r) => r.requesterAddress))];
      if (distinctRequesters.length >= config.suspiciousRequesterCountThreshold) {
        signals.push({
          agentId,
          evidence: {
            windowStart: leftRating.ratedAt.toISOString(),
            windowEnd: rightRating.ratedAt.toISOString(),
            ratingIds: windowSlice.map((r) => r.ratingId),
            requesterAddresses: distinctRequesters,
          },
        });
        break;
      }
    }
  }
  return signals;
}

/**
 * F-2007/T-2006: 虚假交付检测 (FAKE_DELIVERY) — same pure, DB-free
 * architecture as `detectScoreManipulation` above. Unlike that detector,
 * this one needs NO tunable sensitivity threshold at all: the signal is
 * "the exact same delivered content (`deliverables.result_hash`) was
 * submitted for two or more DIFFERENT tasks by the same Agent" — an exact,
 * deterministic fact (a real hash collision across unrelated tasks is
 * astronomically unlikely to be innocent reuse of identical work product),
 * not a statistical heuristic requiring a guessed cutoff. `minDuplicateTaskCount`
 * exists only so a test/future caller can loosen it, not because 2 is
 * itself an arbitrary business decision the way T-2009's score threshold
 * was — requirements.md's own F-2007 framing ("这类检测本身准确率有限，
 * 属于风险信号") already accepts this as a heuristic-strength signal, and
 * design.md 决策 1 means a false positive here only ever creates one
 * `risk_signals` row an admin reviews, never a real consequence by itself.
 */
export interface DeliveryHashRecord {
  deliverableId: string;
  taskId: string;
  agentId: string;
  resultHash: string;
}

/** One qualifying "same content reused across tasks" cluster. */
export interface FakeDeliveryDuplicateGroup {
  resultHash: string;
  taskIds: string[];
  deliverableIds: string[];
}

/**
 * N4 real finding (P2, round 1): `risk_signals_one_open_per_agent_and_type`
 * allows at most ONE open signal per (signalType, subjectAgentId) — the
 * original version of this function returned one signal per (agentId,
 * resultHash) cluster, so an Agent reusing TWO OR MORE distinct hashes
 * only ever got its FIRST cluster inserted; the rest were silently
 * `skipped` by `insertRiskSignal`'s own dedup, forever (re-runs keep
 * re-discovering the same already-open first cluster in the same order,
 * never reaching the others even after that first signal is dismissed).
 * Fixed by aggregating every qualifying cluster for an Agent into ONE
 * signal's evidence — this function's own output granularity now matches
 * the database's uniqueness grain exactly, so nothing is ever silently
 * lost.
 */
export interface FakeDeliveryEvidence {
  duplicateGroups: FakeDeliveryDuplicateGroup[];
}

export interface FakeDeliverySignal {
  agentId: string;
  evidence: FakeDeliveryEvidence;
}

export interface FakeDeliveryDetectionConfig {
  minDuplicateTaskCount: number;
}

export const DEFAULT_FAKE_DELIVERY_CONFIG: FakeDeliveryDetectionConfig = {
  minDuplicateTaskCount: 2,
};

export function detectFakeDelivery(
  records: readonly DeliveryHashRecord[],
  config: FakeDeliveryDetectionConfig = DEFAULT_FAKE_DELIVERY_CONFIG,
): FakeDeliverySignal[] {
  const byAgentAndHash = new Map<string, DeliveryHashRecord[]>();
  for (const record of records) {
    const key = `${record.agentId}::${record.resultHash}`;
    const existing = byAgentAndHash.get(key);
    if (existing) {
      existing.push(record);
    } else {
      byAgentAndHash.set(key, [record]);
    }
  }

  const groupsByAgent = new Map<string, FakeDeliveryDuplicateGroup[]>();
  for (const group of byAgentAndHash.values()) {
    const first = group[0];
    if (!first) continue;
    const distinctTaskIds = [...new Set(group.map((r) => r.taskId))];
    if (distinctTaskIds.length < config.minDuplicateTaskCount) continue;

    const duplicateGroup: FakeDeliveryDuplicateGroup = {
      resultHash: first.resultHash,
      taskIds: distinctTaskIds,
      deliverableIds: group.map((r) => r.deliverableId),
    };
    const existing = groupsByAgent.get(first.agentId);
    if (existing) {
      existing.push(duplicateGroup);
    } else {
      groupsByAgent.set(first.agentId, [duplicateGroup]);
    }
  }

  return [...groupsByAgent.entries()].map(([agentId, duplicateGroups]) => ({
    agentId,
    evidence: { duplicateGroups },
  }));
}

/**
 * F-2008/T-2006: 串谋检测 (COLLUSION) — "同一批账号反复互相接单/互相高分
 * 评价". Unlike F-2006's SCORE_MANIPULATION (MANY distinct new accounts
 * boosting one Agent), this pattern is the opposite shape: the SAME
 * (requester, Agent) pair transacting and rating highly over and over — a
 * real repeat-customer relationship is legitimate and common, so this is a
 * genuinely heuristic concentration signal (F-2007/F-2008's own "准确率
 * 有限" framing applies here too), unlike `detectFakeDelivery`'s exact-hash
 * check above. No time window (unlike F-2006's "短时间内") — F-2008's own
 * wording describes a standing pattern across a relationship's whole
 * history, not a short burst.
 */
export interface CollusionCandidate {
  taskId: string;
  requesterAddress: string;
  agentId: string;
  score: number;
}

/** One qualifying suspicious (requester, Agent) pairing. */
export interface CollusionSuspiciousPair {
  requesterAddress: string;
  taskIds: string[];
}

/**
 * N4 real finding (P2, round 1, same class as `detectFakeDelivery`'s own
 * fix): `risk_signals_one_open_per_agent_and_type` allows only ONE open
 * signal per Agent — returning one signal per (requester, Agent) pair
 * meant an Agent colluding with TWO OR MORE distinct requesters only ever
 * got its first pair's evidence inserted, permanently starving the
 * others. Fixed the identical way: aggregate every qualifying pair for an
 * Agent into ONE signal.
 */
export interface CollusionEvidence {
  suspiciousPairs: CollusionSuspiciousPair[];
}

export interface CollusionSignal {
  agentId: string;
  evidence: CollusionEvidence;
}

export interface CollusionDetectionConfig {
  /** "高分" — same literal-maximum reading as `detectScoreManipulation`'s
   * own `highScoreThreshold`. */
  highScoreThreshold: number;
  /** "反复" — minimum count of DISTINCT tasks the same (requester, Agent)
   * pair must complete, all at/above `highScoreThreshold`, before this is
   * treated as a concentration worth an admin's attention. A documented,
   * low-stakes heuristic constant for the same F-2010 reason
   * `detectScoreManipulation`'s thresholds are. */
  minHighScoreTaskCount: number;
}

export const DEFAULT_COLLUSION_CONFIG: CollusionDetectionConfig = {
  highScoreThreshold: 5,
  minHighScoreTaskCount: 5,
};

export function detectCollusion(
  candidates: readonly CollusionCandidate[],
  config: CollusionDetectionConfig = DEFAULT_COLLUSION_CONFIG,
): CollusionSignal[] {
  const byPair = new Map<string, CollusionCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.score < config.highScoreThreshold) continue;
    const key = `${candidate.requesterAddress}::${candidate.agentId}`;
    const existing = byPair.get(key);
    if (existing) {
      existing.push(candidate);
    } else {
      byPair.set(key, [candidate]);
    }
  }

  const pairsByAgent = new Map<string, CollusionSuspiciousPair[]>();
  for (const group of byPair.values()) {
    const first = group[0];
    if (!first) continue;
    const distinctTaskIds = [...new Set(group.map((c) => c.taskId))];
    if (distinctTaskIds.length < config.minHighScoreTaskCount) continue;

    const pair: CollusionSuspiciousPair = {
      requesterAddress: first.requesterAddress,
      taskIds: distinctTaskIds,
    };
    const existing = pairsByAgent.get(first.agentId);
    if (existing) {
      existing.push(pair);
    } else {
      pairsByAgent.set(first.agentId, [pair]);
    }
  }

  return [...pairsByAgent.entries()].map(([agentId, suspiciousPairs]) => ({
    agentId,
    evidence: { suspiciousPairs },
  }));
}
