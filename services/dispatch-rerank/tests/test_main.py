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
    # T-1910/T-1911: no registered ranking_policy_version yet.
    assert body["rankingPolicyVersion"] is None
    assert len(body["rationales"]) == 2


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


def test_rerank_rejects_a_malformed_request_body():
    response = client.post("/rerank", json={"candidates": []})
    assert response.status_code == 422


def test_openapi_json_is_served_and_documents_rerank():
    response = client.get("/openapi.json")
    assert response.status_code == 200
    schema = response.json()
    assert "/rerank" in schema["paths"]
