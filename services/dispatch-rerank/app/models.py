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

from pydantic import BaseModel, Field, model_validator

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


class FusionWeights(BaseModel):
    """Mirrors `apps/api`'s `FusionWeights` (`ctr-training/fusion-weights.ts`)
    field-for-field — the same five coefficients `fusion.py`'s
    `fuse_signals` already uses, just supplied by the caller instead of
    this service's own `DEFAULT_WEIGHTS` constant. This service has no
    database connection of its own (F-1914/F-1915's own architectural
    boundary) — Node is the only side that knows which `ranking_policy_
    version` is currently active, so it must supply the actual weight
    values, not just an opaque id this service would have no way to
    resolve."""

    completion_rate: float = Field(alias="completionRate", ge=0)
    quality_feedback: float = Field(alias="qualityFeedback", ge=0)
    communication: float = Field(alias="communication", ge=0)
    dispute_signal: float = Field(alias="disputeSignal", ge=0)
    historical_scale: float = Field(alias="historicalScale", ge=0)

    # `allow_inf_nan=False`: `inf`/`nan` both satisfy `ge=0`'s own check
    # (`nan >= 0` is even `False` in IEEE 754, but pydantic's `ge`
    # constraint still lets `nan` through since the comparison itself
    # never raises) yet would make `fuse_signals`' weighted average
    # meaningless or `nan`-poison every candidate's fused score.
    model_config = {"populate_by_name": True, "allow_inf_nan": False}

    @model_validator(mode="after")
    def _weights_must_be_usable_by_fuse_signals(self) -> "FusionWeights":
        # N4 real finding (P2, round 1, T-1907): `fuse_signals` divides by
        # the sum of whichever weights correspond to a candidate's PRESENT
        # signals. `ge=0` above already rules out negative weights
        # canceling each other out to zero; this rules out the remaining
        # way every real candidate (one with all five signals present,
        # the only shape a real `ReputationSignalsDigest` ever produces —
        # `CandidateSignals` has no all-None real-world caller) would hit
        # a `ZeroDivisionError`: all five weights being exactly zero. A
        # real `ranking_policy_version` genuinely committing to "ignore
        # every signal" is not a policy this fusion formula can express at
        # all — CLAUDE.md 原则 8, applied the same way `RankingPolicy`
        # itself already is above.
        total = (
            self.completion_rate
            + self.quality_feedback
            + self.communication
            + self.dispute_signal
            + self.historical_scale
        )
        if total <= 0:
            raise ValueError("fusion weights must sum to a positive value")
        return self


class RankingPolicy(BaseModel):
    """T-1907 real finding (round 3, 用户 2026-09-06 决策): a single,
    atomic object rather than two independent optional fields
    (`rankingPolicyVersion`/`fusionWeights` sent separately) — CLAUDE.md
    原则 8 ("尽可能让非法状态无法表示"): `version` naming a real
    `ctr_models.id` while `weights` is missing (or vice versa) is not a
    real, meaningful state this contract should be able to express at
    all. A request with a `RankingPolicy` genuinely commits to "use THESE
    weights, under THIS version id"; omitting the whole object is the only
    way to ask for the always-safe default (Go's fixed `v0.2` weights,
    `ranking_policy_version: null` in the response — today's existing
    honest behavior, unchanged).

    `version` deliberately has no format constraint here (Node's
    `ctr_models.id` is a UUID today, but this service has no reason to
    know or enforce that shape — it only ever echoes back verbatim
    whatever string Node sent, once it has confirmed the accompanying
    weights were real enough to actually use for this computation).
    """

    version: str
    weights: FusionWeights


class RerankRequest(BaseModel):
    candidates: list[CandidateSnapshot]
    task_description: str = Field(alias="taskDescription")
    stage: RerankStage
    ranking_policy: RankingPolicy | None = Field(default=None, alias="rankingPolicy")

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
