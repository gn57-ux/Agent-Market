"""Feature 19 (ctr-online-learning), T-1910.

design.md's own interface contract for `POST /rerank`, expressed as
Pydantic models — this is the ONE place these field names/types are
defined (CLAUDE.md 原则 6). `apps/api` (the only real caller — Go never
calls this service, F-1914/F-1915) consumes this contract exclusively
through the generated OpenAPI schema (`GET /openapi.json`), never by
hand-copying these field names into a separate Node type — see
`scripts/export_openapi.py` and the repo-root `apps/api`'s
`generate-rerank-types` script for the generation pipeline this schema
feeds (design.md 决策 4).
"""

from typing import Literal

from pydantic import BaseModel, Field

RerankStage = Literal["SHADOW", "GRADUAL", "PRIMARY"]


class CandidateSignals(BaseModel):
    """Mirrors `apps/api`'s `ReputationSignalsInput` (the flat wire shape,
    not the full digest with sampleSize — Go's own wire contract already
    established this flattened shape, and Python receives the same one).
    Every field is `None` when that signal is genuinely missing (F-1309) —
    never a fabricated 0."""

    completion_rate: float | None = Field(default=None, alias="completionRate")
    quality_feedback: float | None = Field(default=None, alias="qualityFeedback")
    communication: float | None = Field(default=None, alias="communication")
    dispute_signal: float | None = Field(default=None, alias="disputeSignal")
    historical_scale: float | None = Field(default=None, alias="historicalScale")

    model_config = {"populate_by_name": True}


class CandidateSnapshot(BaseModel):
    agent_id: str = Field(alias="agentId")
    v0_score: float = Field(alias="v0Score")
    signals: CandidateSignals | None = None
    semantic_similarity: float | None = Field(default=None, alias="semanticSimilarity")

    model_config = {"populate_by_name": True}


class RerankRequest(BaseModel):
    candidates: list[CandidateSnapshot]
    task_description: str = Field(alias="taskDescription")
    stage: RerankStage

    model_config = {"populate_by_name": True}


class CandidateRationale(BaseModel):
    agent_id: str = Field(alias="agentId")
    reason: str

    model_config = {"populate_by_name": True}


class RerankResponse(BaseModel):
    """`rerank_service_version`/`ranking_policy_version` are two
    INDEPENDENT fields (F-1922) — never merged into one version string.
    `ranking_policy_version` is nullable: this skeleton (T-1910/T-1911)
    runs with no registered `ctr_models` row yet, matching design.md's own
    note that an early-stage reranker can run with "未版本化的
    prompt/权重"."""

    ranked_agent_ids: list[str] = Field(alias="rankedAgentIds")
    rationales: list[CandidateRationale]
    rerank_service_version: str = Field(alias="rerankServiceVersion")
    ranking_policy_version: str | None = Field(default=None, alias="rankingPolicyVersion")
    # T-1912's own real need: `dispatch_rerank_runs.outcome` (design.md's
    # schema) has a DEGRADED value distinct from SUCCESS specifically for
    # "the call succeeded, but this service internally fell back to the
    # deterministic fusion order rather than adopting a real qwen3:8b
    # ranking" (`pipeline.py`'s own `llm_adopted` state) — without this
    # field, Node's caller has no way to tell those two real outcomes
    # apart from a plain 200 response, and would have to guess from
    # rationale text (fragile, not a real contract).
    llm_adopted: bool = Field(alias="llmAdopted")

    model_config = {"populate_by_name": True}
