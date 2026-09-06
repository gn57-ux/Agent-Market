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

from .fusion import fuse_signals
from .llm_client import LlmCallError, call_rerank_llm
from .models import CandidateSnapshot
from .ranking import InvalidRankingError, validate_full_permutation, validate_reasons


class RerankPipelineState(TypedDict):
    task_description: str
    candidates: list[CandidateSnapshot]
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
    fused_scores = {
        c.agent_id: fuse_signals(c.signals) if c.signals is not None else c.v0_score
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
    task_description: str, candidates: list[CandidateSnapshot]
) -> RerankPipelineState:
    initial_state: RerankPipelineState = {
        "task_description": task_description,
        "candidates": candidates,
        "fused_scores": {},
        "fusion_ordered_ids": [],
        "ranked_agent_ids": [],
        "reasons": {},
        "llm_adopted": False,
    }
    return _compiled_graph.invoke(initial_state)
