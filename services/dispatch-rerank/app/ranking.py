"""Feature 19, T-1910 (validation) / T-1911 (real ranking pipeline).

`validate_full_permutation` is the ONE place `/rerank`'s hard output
contract is enforced (design.md's own interface contract: "每个候选 ID 必须
是输入候选集合的子集...校验发生在 Python 服务内部") — `pipeline.py`'s real
LangGraph pipeline (T-1911) calls this SAME function on the LLM's output,
so the four invalid-output scenarios AC-1914 requires (越界 ID/重复/缺失/
结构校验失败) are guarded against in exactly one place, not re-implemented
per ranking strategy.
"""


class InvalidRankingError(ValueError):
    """Raised by `validate_full_permutation` — the caller (`pipeline.py`'s
    `llm_node`) is responsible for treating this as a signal to fall back
    to the deterministic fusion-only order, never a silently-wrong
    candidate list."""


def validate_full_permutation(candidate_ids: list[str], ranked_ids: list[str]) -> None:
    if len(ranked_ids) != len(set(ranked_ids)):
        raise InvalidRankingError("ranked_agent_ids contains a duplicate agentId")

    candidate_set = set(candidate_ids)
    ranked_set = set(ranked_ids)

    out_of_bounds = ranked_set - candidate_set
    if out_of_bounds:
        raise InvalidRankingError(
            f"ranked_agent_ids contains agentId(s) not in the input candidate set: {sorted(out_of_bounds)}"
        )

    missing = candidate_set - ranked_set
    if missing:
        raise InvalidRankingError(
            f"ranked_agent_ids is missing candidate agentId(s): {sorted(missing)}"
        )


def validate_reasons(candidate_ids: list[str], reasons: dict[str, str]) -> None:
    """N4 real finding (P2, round 2): `validate_full_permutation` alone
    only confirms the RANKING is a real permutation of the candidate set —
    it says nothing about `reasons`, design.md's own separate requirement
    ("每个候选的选择理由"). An LLM response with a complete, valid ranking
    but an empty or partial `reasons` dict (a real, plausible malformed
    output — the model followed the ranking instruction but skipped the
    per-candidate explanation) previously passed straight through as
    `llm_adopted=True`, silently degrading design.md's own response
    contract instead of triggering the fallback every other invalid-output
    scenario already triggers.
    """
    candidate_set = set(candidate_ids)
    reason_keys = set(reasons.keys())

    missing = candidate_set - reason_keys
    if missing:
        raise InvalidRankingError(f"reasons is missing candidate agentId(s): {sorted(missing)}")

    empty = {agent_id for agent_id in candidate_ids if not reasons.get(agent_id, "").strip()}
    if empty:
        raise InvalidRankingError(f"reasons has empty/blank text for agentId(s): {sorted(empty)}")
