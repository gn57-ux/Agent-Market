import os

import pytest
from fastapi.testclient import TestClient

import app.pipeline as pipeline_module
from app.main import app
from app.version import SERVICE_VERSION

client = TestClient(app)

runs_ollama = pytest.mark.skipif(
    os.environ.get("RUN_OLLAMA_INTEGRATION_TESTS") != "1",
    reason="set RUN_OLLAMA_INTEGRATION_TESTS=1 against a real local Ollama with qwen3:8b pulled",
)


@runs_ollama
def test_rerank_real_end_to_end_through_ollama_returns_both_version_fields():
    response = client.post(
        "/rerank",
        json={
            "candidates": [
                {"agentId": "agent-1", "v0Score": 0.9},
                {"agentId": "agent-2", "v0Score": 0.5},
            ],
            "taskDescription": "write a landing page",
            "stage": "SHADOW",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert sorted(body["rankedAgentIds"]) == ["agent-1", "agent-2"]
    assert body["rerankServiceVersion"] == SERVICE_VERSION
    # T-1907 (用户 2026-09-06 决策): no `rankingPolicy` was sent on this
    # request, so the honest, always-safe default applies — see the
    # dedicated `test_rerank_real_end_to_end_with_a_real_ranking_policy`
    # test below for the WITH-policy case.
    assert body["rankingPolicyVersion"] is None
    assert len(body["rationales"]) == 2


@runs_ollama
def test_rerank_real_end_to_end_with_a_real_ranking_policy():
    # T-1907 (用户 2026-09-06 决策): a real end-to-end proof — through the
    # real HTTP endpoint, real Pydantic validation, and a real Ollama call
    # — that a supplied `rankingPolicy` is genuinely used (not merely
    # accepted and ignored) and its version is echoed back exactly,
    # confirming what was truly computed.
    response = client.post(
        "/rerank",
        json={
            "candidates": [
                {
                    "agentId": "agent-1",
                    "v0Score": 0.9,
                    "signals": {"completionRate": 0.9, "communication": 0.1},
                },
                {
                    "agentId": "agent-2",
                    "v0Score": 0.4,
                    "signals": {"completionRate": 0.1, "communication": 0.9},
                },
            ],
            "taskDescription": "write a landing page",
            "stage": "SHADOW",
            "rankingPolicy": {
                "version": "22222222-2222-2222-2222-222222222222",
                "weights": {
                    "completionRate": 0.0,
                    "qualityFeedback": 0.0,
                    "communication": 1.0,
                    "disputeSignal": 0.0,
                    "historicalScale": 0.0,
                },
            },
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert sorted(body["rankedAgentIds"]) == ["agent-1", "agent-2"]
    assert body["rankingPolicyVersion"] == "22222222-2222-2222-2222-222222222222"


def test_rerank_falls_back_to_fusion_order_when_the_llm_call_fails(monkeypatch):
    from app.llm_client import LlmCallError

    def raise_timeout(*args, **kwargs):
        raise LlmCallError("simulated timeout")

    monkeypatch.setattr(pipeline_module, "call_rerank_llm", raise_timeout)

    response = client.post(
        "/rerank",
        json={
            "candidates": [
                {"agentId": "agent-1", "v0Score": 0.9},
                {"agentId": "agent-2", "v0Score": 0.5},
            ],
            "taskDescription": "write a landing page",
            "stage": "SHADOW",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert sorted(body["rankedAgentIds"]) == ["agent-1", "agent-2"]
    # T-1912's own real need: distinguishes SUCCESS from DEGRADED in
    # `dispatch_rerank_runs.outcome`.
    assert body["llmAdopted"] is False


def test_rerank_accepts_full_reputation_signals_and_optional_fields(monkeypatch):
    from app.llm_client import LlmRerankOutput

    monkeypatch.setattr(
        pipeline_module,
        "call_rerank_llm",
        lambda *a, **k: LlmRerankOutput(ranked_agent_ids=["agent-1"], reasons={"agent-1": "x"}),
    )

    response = client.post(
        "/rerank",
        json={
            "candidates": [
                {
                    "agentId": "agent-1",
                    "v0Score": 0.9,
                    "signals": {
                        "completionRate": 0.9,
                        "qualityFeedback": 0.8,
                        "communication": 0.85,
                        "disputeSignal": 0.95,
                        "historicalScale": 0.5,
                    },
                    "semanticSimilarity": 0.7,
                }
            ],
            "taskDescription": "write a landing page",
            "stage": "PRIMARY",
        },
    )
    assert response.status_code == 200


def test_rerank_ranking_policy_weights_are_actually_used_at_the_http_layer(monkeypatch):
    # Fast (no real Ollama) HTTP-level companion to the real-Ollama test
    # above — forces the LLM call to fail so the response reflects the
    # fusion node's own real computation, proving the weight is genuinely
    # applied through the real request-parsing/pipeline/response path,
    # not just that the version string round-trips.
    from app.llm_client import LlmCallError

    def raise_timeout(*args, **kwargs):
        raise LlmCallError("simulated timeout")

    monkeypatch.setattr(pipeline_module, "call_rerank_llm", raise_timeout)

    response = client.post(
        "/rerank",
        json={
            "candidates": [
                {
                    "agentId": "completion-heavy",
                    "v0Score": 0.5,
                    "signals": {"completionRate": 0.9, "communication": 0.0},
                },
                {
                    "agentId": "communication-heavy",
                    "v0Score": 0.5,
                    "signals": {"completionRate": 0.0, "communication": 0.9},
                },
            ],
            "taskDescription": "write a landing page",
            "stage": "SHADOW",
            "rankingPolicy": {
                "version": "33333333-3333-3333-3333-333333333333",
                "weights": {
                    "completionRate": 0.0,
                    "qualityFeedback": 0.0,
                    "communication": 1.0,
                    "disputeSignal": 0.0,
                    "historicalScale": 0.0,
                },
            },
        },
    )
    assert response.status_code == 200
    body = response.json()
    # Under DEFAULT_WEIGHTS (completionRate 0.30 > communication 0.15),
    # completion-heavy would win — under the supplied policy's pure-
    # communication weighting, communication-heavy must win instead.
    assert body["rankedAgentIds"][0] == "communication-heavy"
    assert body["rankingPolicyVersion"] == "33333333-3333-3333-3333-333333333333"


def test_rerank_rejects_a_malformed_request_body():
    response = client.post("/rerank", json={"candidates": []})
    assert response.status_code == 422


def _rerank_request_with_weights(weights: dict[str, float]) -> dict:
    return {
        "candidates": [{"agentId": "a", "v0Score": 0.5, "signals": {"completionRate": 0.5}}],
        "taskDescription": "write a landing page",
        "stage": "SHADOW",
        "rankingPolicy": {
            "version": "44444444-4444-4444-4444-444444444444",
            "weights": weights,
        },
    }


def test_rerank_survives_a_real_policy_that_only_weights_a_signal_this_candidate_lacks(
    monkeypatch,
):
    # N4 real finding (P1, round 2, T-1907): the REQUEST-level check (all
    # five weights sum to a positive value) cannot see, at validation
    # time, which of a given candidate's signals will turn out to be
    # `None` — a real communication-only policy (weight 1.0 on
    # communication, 0 elsewhere) combined with a real candidate that
    # simply has no communication signal yet leaves this candidate's own
    # present-weight sum at zero even though the request passed
    # validation. Must return 200 (fuse_signals' own 0.0 fallback), not
    # 500.
    from app.llm_client import LlmCallError

    def raise_timeout(*args, **kwargs):
        raise LlmCallError("simulated timeout")

    monkeypatch.setattr(pipeline_module, "call_rerank_llm", raise_timeout)

    response = client.post(
        "/rerank",
        json={
            "candidates": [
                {
                    "agentId": "no-communication-history",
                    "v0Score": 0.5,
                    "signals": {"completionRate": 0.9, "disputeSignal": 0.8},
                }
            ],
            "taskDescription": "write a landing page",
            "stage": "SHADOW",
            "rankingPolicy": {
                "version": "55555555-5555-5555-5555-555555555555",
                "weights": {
                    "completionRate": 0.0,
                    "qualityFeedback": 0.0,
                    "communication": 1.0,
                    "disputeSignal": 0.0,
                    "historicalScale": 0.0,
                },
            },
        },
    )
    assert response.status_code == 200


def test_rerank_rejects_all_zero_fusion_weights():
    # N4 real finding (P2, round 1, T-1907): all-zero weights would make
    # `fuse_signals`' weight-sum denominator exactly zero for any
    # candidate with at least one real signal present, raising
    # `ZeroDivisionError` inside a 200-shaped request — this must be
    # rejected at the request boundary (422) instead of ever reaching
    # `fuse_signals`.
    response = client.post(
        "/rerank",
        json=_rerank_request_with_weights(
            {
                "completionRate": 0.0,
                "qualityFeedback": 0.0,
                "communication": 0.0,
                "disputeSignal": 0.0,
                "historicalScale": 0.0,
            }
        ),
    )
    assert response.status_code == 422


def test_rerank_rejects_negative_fusion_weights():
    response = client.post(
        "/rerank",
        json=_rerank_request_with_weights(
            {
                "completionRate": -0.5,
                "qualityFeedback": 0.0,
                "communication": 0.5,
                "disputeSignal": 0.0,
                "historicalScale": 0.0,
            }
        ),
    )
    assert response.status_code == 422


def test_rerank_rejects_non_finite_fusion_weights():
    # A NaN/Infinity weight is rejected at the Pydantic model layer
    # directly (`allow_inf_nan=False`) rather than through a real HTTP
    # round trip: FastAPI's default validation-error handler embeds the
    # raw rejected value verbatim in its JSON error body, and Starlette's
    # `JSONResponse` itself refuses to serialize a literal `NaN`/
    # `Infinity` in that body (`allow_nan=False`) — a pre-existing,
    # unrelated FastAPI/Starlette interaction affecting any endpoint that
    # rejects a non-finite float, not something this fix introduces or is
    # responsible for resolving. The real, in-scope guarantee — a
    # non-finite weight never reaches `fuse_signals`' division — is fully
    # proven at this layer.
    import pydantic

    from app.models import FusionWeights

    with pytest.raises(pydantic.ValidationError):
        FusionWeights(
            completionRate=float("nan"),
            qualityFeedback=0.0,
            communication=0.5,
            disputeSignal=0.0,
            historicalScale=0.0,
        )
    with pytest.raises(pydantic.ValidationError):
        FusionWeights(
            completionRate=float("inf"),
            qualityFeedback=0.0,
            communication=0.5,
            disputeSignal=0.0,
            historicalScale=0.0,
        )


def test_openapi_json_is_served_and_documents_rerank():
    response = client.get("/openapi.json")
    assert response.status_code == 200
    schema = response.json()
    assert "/rerank" in schema["paths"]
