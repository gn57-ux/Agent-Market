"""Feature 19, T-1911. The real LangGraph pipeline `/rerank` (`main.py`)
calls: `fusion_node` (deterministic, `fusion.py`) → `llm_node` (qwen3:8b via
Ollama, `llm_client.py`) → the four hard checks (design.md 决策 2 v1.3):
structural validation (`LlmRerankOutput`, inside `llm_client.py`),
candidate-ID whitelist / duplicate / missing-candidate detection
(`ranking.validate_full_permutation`, reused verbatim from T-1910 — the
SAME function both this pipeline and T-1910's own skeleton call, so there
is exactly one place "what counts as a valid ranking" is defined).

Any failure at ANY of those checks, or an LLM call timeout, falls back to
the deterministic fusion-only order — never the raw, unvalidated LLM
output, and never a crash. This IS the "narrow adapter" boundary design.md
requires: the LLM can reorder within the confirmed candidate set and
explain its choices, but can never invent, drop, or duplicate a candidate,
and a failure here degrades gracefully rather than propagating.
"""

from typing import TypedDict

from langgraph.graph import END, StateGraph

from .fusion import DEFAULT_WEIGHTS, fuse_signals
from .llm_client import LlmCallError, call_rerank_llm
from .models import CandidateSnapshot, RankingPolicy
from .ranking import InvalidRankingError, validate_full_permutation, validate_reasons


class RerankPipelineState(TypedDict):
    task_description: str
    candidates: list[CandidateSnapshot]
    # T-1907 (用户 2026-09-06 决策): the weights actually used for THIS
    # call's fusion node, and the version identifier that genuinely
    # corresponds to them — set together, once, by `run_rerank_pipeline`
    # before the graph runs (see that function's own doc comment), and
    # never modified afterward. Keeping them in lockstep in the state
    # itself (rather than deriving `ranking_policy_version` separately in
    # `main.py` after the fact) is what makes "the reported version always
    # matches what was truly computed" structurally true rather than a
    # convention two separate pieces of code have to independently honor.
    fusion_weights: dict[str, float]
    ranking_policy_version: str | None
    fused_scores: dict[str, float]
    fusion_ordered_ids: list[str]
    ranked_agent_ids: list[str]
    reasons: dict[str, str]
    llm_adopted: bool


def fusion_node(state: RerankPipelineState) -> RerankPipelineState:
    # N4 real finding (P1, round 1): `signals` is optional (a `v0.1`
    # request, or any candidate Node didn't attach reputation signals to,
    # never carries it) — `fuse_signals(None)` correctly returns `0.0` for
    # THAT function's own contract, but blindly using it here as every
    # signals-less candidate's fused score collapsed them all to a tied
    # 0.0 regardless of their REAL, already-computed `v0Score` (Go's own
    # `Score`/`ScoreV2`), making the "deterministic fusion" stage silently
    # ignore the one real ranking signal available for exactly the
    # candidates that need it most. `c.v0_score` is the correct fallback:
    # it already IS this candidate's deterministic score whenever
    # `signals` isn't present, computed by Go using the same
    # "deterministic, reproducible" property this node itself requires.
    #
    # T-1907 (用户 2026-09-06 决策): `fuse_signals` now receives
    # `state["fusion_weights"]` — the REAL weights this call was actually
    # set up to use — instead of silently defaulting to `fuse_signals`'s
    # own module-level `DEFAULT_WEIGHTS` every time. A signals-less
    # candidate still falls back to its own `v0_score` regardless of which
    # weights are active, for the same reason as before: there is nothing
    # for ANY weight vector to fuse without real signal values.
    fused_scores = {
        c.agent_id: (
            fuse_signals(c.signals, state["fusion_weights"])
            if c.signals is not None
            else c.v0_score
        )
        for c in state["candidates"]
    }
    fusion_ordered_ids = sorted(
        (c.agent_id for c in state["candidates"]),
        key=lambda agent_id: fused_scores[agent_id],
        reverse=True,
    )
    return {**state, "fused_scores": fused_scores, "fusion_ordered_ids": fusion_ordered_ids}


def _fallback_to_fusion_order(state: RerankPipelineState, reason: str) -> RerankPipelineState:
    return {
        **state,
        "ranked_agent_ids": state["fusion_ordered_ids"],
        "reasons": {agent_id: reason for agent_id in state["fusion_ordered_ids"]},
        "llm_adopted": False,
    }


def llm_node(state: RerankPipelineState) -> RerankPipelineState:
    if not state["candidates"]:
        # No real ranking decision to make or explain — and no reason to
        # spend a real LLM call on an empty candidate set.
        return {**state, "ranked_agent_ids": [], "reasons": {}, "llm_adopted": False}

    candidate_ids = [c.agent_id for c in state["candidates"]]
    ranked_by_fusion = [
        (agent_id, state["fused_scores"][agent_id]) for agent_id in state["fusion_ordered_ids"]
    ]

    try:
        llm_output = call_rerank_llm(state["task_description"], ranked_by_fusion)
    except LlmCallError as error:
        return _fallback_to_fusion_order(state, f"回退到确定性融合顺序（LLM 调用/结构校验失败：{error}）")

    try:
        validate_full_permutation(candidate_ids, llm_output.ranked_agent_ids)
        # N4 real finding (P2, round 2): a valid ranking with an empty or
        # partial `reasons` dict must ALSO be rejected — design.md requires
        # a real explanation per candidate, not just a valid order.
        validate_reasons(candidate_ids, llm_output.reasons)
    except InvalidRankingError as error:
        return _fallback_to_fusion_order(state, f"回退到确定性融合顺序（候选集合/理由校验失败：{error}）")

    return {
        **state,
        "ranked_agent_ids": llm_output.ranked_agent_ids,
        "reasons": llm_output.reasons,
        "llm_adopted": True,
    }


def build_graph():
    graph = StateGraph(RerankPipelineState)
    graph.add_node("fusion", fusion_node)
    graph.add_node("llm", llm_node)
    graph.set_entry_point("fusion")
    graph.add_edge("fusion", "llm")
    graph.add_edge("llm", END)
    return graph.compile()


_compiled_graph = build_graph()


def run_rerank_pipeline(
    task_description: str,
    candidates: list[CandidateSnapshot],
    ranking_policy: RankingPolicy | None = None,
) -> RerankPipelineState:
    """T-1907 (用户 2026-09-06 决策): decides ONCE, before the graph ever
    runs, which weights this call will actually use and what version
    string (if any) truly corresponds to them — `ranking_policy is None`
    (no real `ctr_models` row exists yet, or Node chose not to send one)
    is the ONLY way `fusion_weights`/`ranking_policy_version` fall back to
    `DEFAULT_WEIGHTS`/`None`; a caller that DOES send a `RankingPolicy`
    gets exactly those weights used and exactly that version echoed back
    — this function never invents, substitutes, or silently ignores a
    supplied policy. `main.py`'s handler reads `ranking_policy_version`
    back off the FINAL state (not off the original request) specifically
    so the response can never claim a version was used if this function
    itself didn't actually set `fusion_weights` from it.
    """
    fusion_weights = (
        ranking_policy.weights.model_dump() if ranking_policy is not None else DEFAULT_WEIGHTS
    )
    ranking_policy_version = ranking_policy.version if ranking_policy is not None else None

    initial_state: RerankPipelineState = {
        "task_description": task_description,
        "candidates": candidates,
        "fusion_weights": fusion_weights,
        "ranking_policy_version": ranking_policy_version,
        "fused_scores": {},
        "fusion_ordered_ids": [],
        "ranked_agent_ids": [],
        "reasons": {},
        "llm_adopted": False,
    }
    return _compiled_graph.invoke(initial_state)
