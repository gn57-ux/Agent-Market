from app.fusion import fuse_signals
from app.models import CandidateSignals


def test_fuse_signals_matches_the_hand_computed_weighted_average_of_all_five_present_signals():
    signals = CandidateSignals(
        completionRate=0.9,
        qualityFeedback=0.8,
        communication=0.7,
        disputeSignal=0.95,
        historicalScale=0.5,
    )
    # weights: 0.30/0.30/0.15/0.20/0.05 (mirrors Go's ScoreV2 exactly)
    expected = round(
        0.9 * 0.30 + 0.8 * 0.30 + 0.7 * 0.15 + 0.95 * 0.20 + 0.5 * 0.05,
        6,
    )
    assert fuse_signals(signals) == expected


def test_fuse_signals_renormalizes_over_only_the_present_signals():
    # Only completionRate (weight 0.30) and qualityFeedback (weight 0.30)
    # present — renormalized weighted average, not divided by the full
    # weight sum of 1.0.
    signals = CandidateSignals(completionRate=0.8, qualityFeedback=0.4)
    expected = round((0.8 * 0.30 + 0.4 * 0.30) / (0.30 + 0.30), 6)
    assert fuse_signals(signals) == expected


def test_fuse_signals_returns_zero_when_all_five_signals_are_missing():
    assert fuse_signals(CandidateSignals()) == 0.0


def test_fuse_signals_returns_zero_for_a_none_signals_object():
    assert fuse_signals(None) == 0.0


def test_fuse_signals_is_deterministic_across_repeated_calls():
    signals = CandidateSignals(completionRate=0.6, disputeSignal=0.7)
    first = fuse_signals(signals)
    second = fuse_signals(signals)
    assert first == second


def test_fuse_signals_returns_zero_instead_of_dividing_by_zero_when_a_real_policy_only_weights_a_signal_this_candidate_lacks():
    # N4 real finding (P1, round 2, T-1907): a real, legitimate policy that
    # weights ONLY communication (weight 1.0, everything else 0 — exactly
    # `COMMUNICATION_ONLY_WEIGHTS` used elsewhere in this codebase's own
    # release-gate tests) combined with a real candidate that genuinely has
    # no communication signal yet (F-1309 allows any single signal to be
    # missing) leaves `present` holding only zero-weighted signals — the
    # weight-sum denominator is 0 even though the REQUEST-level weights
    # summed to a positive value overall. Must return 0.0, never raise.
    communication_only_weights = {
        "completion_rate": 0.0,
        "quality_feedback": 0.0,
        "communication": 1.0,
        "dispute_signal": 0.0,
        "historical_scale": 0.0,
    }
    signals = CandidateSignals(completionRate=0.9, disputeSignal=0.8, historicalScale=0.5)
    assert fuse_signals(signals, communication_only_weights) == 0.0
