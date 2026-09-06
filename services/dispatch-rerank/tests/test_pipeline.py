import os

import pytest

import app.pipeline as pipeline_module
from app.llm_client import LlmCallError, LlmRerankOutput
from app.models import CandidateSignals, CandidateSnapshot
from app.pipeline import run_rerank_pipeline

# Real local Ollama + qwen3:8b calls — same "opt-in, needs a real external
# service this environment may not have" convention `apps/api`'s own
# RUN_DB_INTEGRATION_TESTS uses for real Postgres. GitHub Actions CI has no
# Ollama service (a multi-GB local model download is not something to
# provision per CI run), so these are gated off by default and verified
# manually against this environment's real running Ollama instance.
runs_ollama = pytest.mark.skipif(
    os.environ.get("RUN_OLLAMA_INTEGRATION_TESTS") != "1",
    reason="set RUN_OLLAMA_INTEGRATION_TESTS=1 against a real local Ollama with qwen3:8b pulled",
)


def make_candidate(agent_id: str, v0_score: float, **signal_kwargs) -> CandidateSnapshot:
    return CandidateSnapshot(
        agentId=agent_id,
        v0Score=v0_score,
        signals=CandidateSignals(**signal_kwargs) if signal_kwargs else None,
    )


@runs_ollama
def test_real_ollama_call_produces_a_valid_permutation_with_real_explanation_text():
    candidates = [
        make_candidate("agent-1", 0.9, completionRate=0.9, qualityFeedback=0.85),
        make_candidate("agent-2", 0.4, completionRate=0.3, qualityFeedback=0.4),
    ]
    result = run_rerank_pipeline("Write marketing copy for a new SaaS product landing page", candidates)

    assert sorted(result["ranked_agent_ids"]) == ["agent-1", "agent-2"]
    assert set(result["reasons"].keys()) == {"agent-1", "agent-2"}
    for reason in result["reasons"].values():
        assert isinstance(reason, str)
        assert len(reason) > 0


def test_n4_p1_fix_fusion_uses_v0_score_when_signals_are_entirely_absent():
    # No `signals` object at all (a v0.1-only candidate) — the fusion
    # stage must fall back to the already-computed `v0Score`, NOT collapse
    # every signals-less candidate to a tied 0.0.
    candidates = [
        make_candidate("agent-low", 0.2),
        make_candidate("agent-high", 0.8),
    ]
    result = pipeline_module.fusion_node(
        {
            "task_description": "x",
            "candidates": candidates,
            "fused_scores": {},
            "fusion_ordered_ids": [],
            "ranked_agent_ids": [],
            "reasons": {},
            "llm_adopted": False,
        }
    )
    assert result["fused_scores"] == {"agent-low": 0.2, "agent-high": 0.8}
    assert result["fusion_ordered_ids"] == ["agent-high", "agent-low"]


def test_fusion_only_stage_is_deterministic_and_reproducible_without_any_llm_call():
    candidates = [
        make_candidate("agent-1", 0.9, completionRate=0.9, qualityFeedback=0.8),
        make_candidate("agent-2", 0.4, completionRate=0.3, qualityFeedback=0.2),
    ]
    first = pipeline_module.fusion_node(
        {
            "task_description": "x",
            "candidates": candidates,
            "fused_scores": {},
            "fusion_ordered_ids": [],
            "ranked_agent_ids": [],
            "reasons": {},
            "llm_adopted": False,
        }
    )
    second = pipeline_module.fusion_node(
        {
            "task_description": "x",
            "candidates": candidates,
            "fused_scores": {},
            "fusion_ordered_ids": [],
            "ranked_agent_ids": [],
            "reasons": {},
            "llm_adopted": False,
        }
    )
    assert first["fusion_ordered_ids"] == second["fusion_ordered_ids"] == ["agent-1", "agent-2"]


def test_empty_candidate_list_short_circuits_without_calling_the_llm(monkeypatch):
    def fail_if_called(*args, **kwargs):
        raise AssertionError("call_rerank_llm must not be called for an empty candidate list")

    monkeypatch.setattr(pipeline_module, "call_rerank_llm", fail_if_called)

    result = run_rerank_pipeline("some task", [])
    assert result["ranked_agent_ids"] == []
    assert result["reasons"] == {}
    assert result["llm_adopted"] is False


# --- AC-1914: the four invalid-output scenarios, forced deterministically
# via monkeypatching (not dependent on ever actually provoking qwen3:8b
# into misbehaving) ---


def test_ac1914_llm_call_timeout_falls_back_to_fusion_order(monkeypatch):
    def raise_timeout(*args, **kwargs):
        raise LlmCallError("Ollama call failed: timed out")

    monkeypatch.setattr(pipeline_module, "call_rerank_llm", raise_timeout)

    candidates = [make_candidate("agent-1", 0.9), make_candidate("agent-2", 0.2)]
    result = run_rerank_pipeline("task", candidates)
    assert result["llm_adopted"] is False
    assert result["ranked_agent_ids"] == ["agent-1", "agent-2"]
    assert "回退到确定性融合顺序" in result["reasons"]["agent-1"]


def test_ac1914_structural_validation_failure_falls_back_to_fusion_order(monkeypatch):
    def raise_structural_failure(*args, **kwargs):
        raise LlmCallError("qwen3:8b output failed structural validation: missing field")

    monkeypatch.setattr(pipeline_module, "call_rerank_llm", raise_structural_failure)

    candidates = [make_candidate("agent-1", 0.9), make_candidate("agent-2", 0.2)]
    result = run_rerank_pipeline("task", candidates)
    assert result["llm_adopted"] is False


def test_ac1914_out_of_bounds_agent_id_falls_back_to_fusion_order(monkeypatch):
    def return_out_of_bounds(*args, **kwargs):
        return LlmRerankOutput(
            ranked_agent_ids=["agent-1", "agent-2", "agent-999-not-real"],
            reasons={"agent-1": "x", "agent-2": "y", "agent-999-not-real": "z"},
        )

    monkeypatch.setattr(pipeline_module, "call_rerank_llm", return_out_of_bounds)

    candidates = [make_candidate("agent-1", 0.9), make_candidate("agent-2", 0.2)]
    result = run_rerank_pipeline("task", candidates)
    assert result["llm_adopted"] is False
    assert result["ranked_agent_ids"] == ["agent-1", "agent-2"]


def test_ac1914_duplicate_agent_id_falls_back_to_fusion_order(monkeypatch):
    def return_duplicate(*args, **kwargs):
        return LlmRerankOutput(
            ranked_agent_ids=["agent-1", "agent-1"],
            reasons={"agent-1": "x"},
        )

    monkeypatch.setattr(pipeline_module, "call_rerank_llm", return_duplicate)

    candidates = [make_candidate("agent-1", 0.9), make_candidate("agent-2", 0.2)]
    result = run_rerank_pipeline("task", candidates)
    assert result["llm_adopted"] is False


def test_n4_p2_fix_empty_reasons_dict_falls_back_to_fusion_order_despite_a_valid_ranking(
    monkeypatch,
):
    def return_valid_ranking_no_reasons(*args, **kwargs):
        return LlmRerankOutput(ranked_agent_ids=["agent-2", "agent-1"], reasons={})

    monkeypatch.setattr(pipeline_module, "call_rerank_llm", return_valid_ranking_no_reasons)

    candidates = [make_candidate("agent-1", 0.9), make_candidate("agent-2", 0.2)]
    result = run_rerank_pipeline("task", candidates)
    assert result["llm_adopted"] is False
    assert result["ranked_agent_ids"] == ["agent-1", "agent-2"]


def test_n4_p2_fix_blank_reason_text_falls_back_to_fusion_order(monkeypatch):
    def return_blank_reason(*args, **kwargs):
        return LlmRerankOutput(
            ranked_agent_ids=["agent-1", "agent-2"],
            reasons={"agent-1": "a real reason", "agent-2": "   "},
        )

    monkeypatch.setattr(pipeline_module, "call_rerank_llm", return_blank_reason)

    candidates = [make_candidate("agent-1", 0.9), make_candidate("agent-2", 0.2)]
    result = run_rerank_pipeline("task", candidates)
    assert result["llm_adopted"] is False


def test_ac1914_missing_candidate_falls_back_to_fusion_order(monkeypatch):
    def return_missing_candidate(*args, **kwargs):
        return LlmRerankOutput(ranked_agent_ids=["agent-1"], reasons={"agent-1": "x"})

    monkeypatch.setattr(pipeline_module, "call_rerank_llm", return_missing_candidate)

    candidates = [make_candidate("agent-1", 0.9), make_candidate("agent-2", 0.2)]
    result = run_rerank_pipeline("task", candidates)
    assert result["llm_adopted"] is False
    assert result["ranked_agent_ids"] == ["agent-1", "agent-2"]
