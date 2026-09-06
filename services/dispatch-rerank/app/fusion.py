"""Feature 19, T-1911 (design.md 决策 2): the deterministic five-signal
fusion node — same input, same output, no LLM involved. Given the same
`CandidateSignals`, always produces the same fused score.

The default weights are the SAME numbers as `services/dispatch/internal/
scoring/scoring.go`'s `v02weights`/`ScoreV2` (completionRate 0.30 /
qualityFeedback 0.30 / communication 0.15 / disputeSignal 0.20 /
historicalScale 0.05, F-1311's user-confirmed "v0.2" weights) — this is
deliberately the SAME formula Go already computes and forwards as each
candidate's `v0Score`, not an independently-invented one; it exists here,
in Python, so a future trained `ranking_policy_version` (T-1905) can
override these weights without needing any change to Go's own compiled
constants or to this pipeline's structure. Until a trained policy exists,
this node's output is expected to numerically match the `v0Score` Go
already sent (same formula, same inputs), which is the correct "cold
start" baseline (F-1922).

Missing-signal handling mirrors Go's `ScoreV2` exactly: a `None` signal is
excluded from BOTH the weighted sum and the weight-sum denominator (never
replaced by 0 or any prior) — the final score is the weighted average of
only the PRESENT signals, reweighted so their own weights sum to 1. All
five signals missing returns `0.0` (Go's `NoHistoricalSample` case).

N4 real finding (P1, round 2, T-1907): `FusionWeights`' own request-level
validation (`models.py`) only guarantees the five weights sum to a
positive value OVERALL — it cannot know, at validation time, WHICH of a
given candidate's five signals will turn out to be `None` for a given
`/rerank` call. A real `ReputationSignalsDigest` genuinely allows any
single signal to be missing (F-1309) — a real, well-formed policy that
weights communication only (a real, legitimate strategy this contract
must be able to express) combined with a real candidate that simply has
no communication history yet would otherwise leave `present` holding only
zero-weighted signals, making `weight_sum` zero again despite the
request-level check having passed. Falling back to `0.0` here — the SAME
value already used for "no signals at all" — is the correct generalization
of that existing fallback, not a new special case: "none of this
candidate's present signals carry any real weight under this policy" is
exactly as uninformative as "this candidate has no signals at all."
"""

from .models import CandidateSignals

DEFAULT_WEIGHTS: dict[str, float] = {
    "completion_rate": 0.30,
    "quality_feedback": 0.30,
    "communication": 0.15,
    "dispute_signal": 0.20,
    "historical_scale": 0.05,
}


def fuse_signals(
    signals: CandidateSignals | None,
    weights: dict[str, float] = DEFAULT_WEIGHTS,
) -> float:
    if signals is None:
        return 0.0

    present: list[tuple[float, float]] = []
    for field_name, weight in weights.items():
        value = getattr(signals, field_name)
        if value is not None:
            present.append((value, weight))

    if not present:
        return 0.0

    weighted_sum = sum(value * weight for value, weight in present)
    weight_sum = sum(weight for _, weight in present)
    if weight_sum <= 0:
        return 0.0
    return round(weighted_sum / weight_sum, 6)
