"""Feature 19, T-1911. A thin, real HTTP client for the local Ollama
`qwen3:8b` model — deliberately NOT going through LangChain's own model
abstraction: this pipeline's single LLM call needs nothing LangChain's
chat-model wrapper would add (memory, multi-provider swapping, tool
calling), and pulling in that dependency surface for one HTTP call would
be exactly the kind of unnecessary abstraction CLAUDE.md 原则 4 warns
against. `pipeline.py` uses LangGraph for the actual node/edge
orchestration (design.md's own architecture decision) — that is a
separate concern from which HTTP client makes the model call.
"""

import os

import httpx
from pydantic import BaseModel, ValidationError

OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3:8b")

# F-1901/design.md's own timeout-control requirement. A real local
# qwen3:8b call for a handful of candidates measured a few seconds in this
# environment; 30s gives real headroom without letting a stuck model call
# hang the whole `/rerank` request indefinitely.
DEFAULT_TIMEOUT_SECONDS = float(os.environ.get("OLLAMA_TIMEOUT_SECONDS", "30"))


class LlmRerankOutput(BaseModel):
    """Pydantic structural validation of qwen3:8b's raw output (design.md
    决策 2 v1.3's own hard requirement) — this is the FIRST check; the
    candidate-set integrity checks (`ranking.validate_full_permutation`)
    run separately, after this shape is confirmed."""

    ranked_agent_ids: list[str]
    reasons: dict[str, str]


class LlmCallError(Exception):
    """Raised for any failure in calling/parsing the LLM's response —
    network error, timeout, non-2xx status, or a response that fails
    Pydantic structural validation. `pipeline.py`'s caller treats ANY
    instance of this as a signal to fall back to the deterministic
    fusion-only order (design.md: "任一检查失败、或调用超时，一律不采纳该次
    LLM 输出")."""


def call_rerank_llm(
    task_description: str,
    ranked_candidates: list[tuple[str, float]],
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> LlmRerankOutput:
    """`ranked_candidates` is `[(agentId, fusedScore), ...]` already sorted
    by the deterministic fusion node (descending) — the LLM's job is a
    "重排微调" on top of that baseline, not building an order from
    scratch."""
    candidate_lines = "\n".join(
        f"- {agent_id}: fused_score={score}" for agent_id, score in ranked_candidates
    )
    prompt = (
        f"Task: {task_description}\n\n"
        f"Candidates (already sorted by a deterministic fusion score, "
        f"highest first):\n{candidate_lines}\n\n"
        "Considering the task description together with each candidate's "
        "fused_score, produce a final ranking of ALL the candidate agent "
        "IDs listed above (every one exactly once, no additions, no "
        "omissions) and a one-sentence reason for each."
    )

    try:
        response = httpx.post(
            f"{OLLAMA_BASE_URL}/api/chat",
            json={
                "model": OLLAMA_MODEL,
                "stream": False,
                "messages": [{"role": "user", "content": prompt}],
                "format": {
                    "type": "object",
                    "properties": {
                        "ranked_agent_ids": {"type": "array", "items": {"type": "string"}},
                        "reasons": {"type": "object"},
                    },
                    "required": ["ranked_agent_ids", "reasons"],
                },
            },
            timeout=timeout_seconds,
        )
        response.raise_for_status()
    except httpx.HTTPError as error:
        raise LlmCallError(f"Ollama call failed: {error}") from error

    # N4 real finding (P2, round 1): a syntactically valid but
    # unexpectedly-shaped JSON body (e.g. a bare `[]`, or `{"message":
    # null}`) makes the subscript chain below raise `TypeError`
    # (`NoneType`/`list` isn't subscriptable by a string key) rather than
    # `KeyError`/`ValueError` — uncaught, that escaped this function as a
    # raw `TypeError` instead of the `LlmCallError` every caller of this
    # function is written to catch, bypassing `pipeline.py`'s "any
    # structural failure falls back to the fusion order" contract and
    # surfacing as an unhandled 500 instead.
    try:
        content = response.json()["message"]["content"]
    except (KeyError, ValueError, TypeError) as error:
        raise LlmCallError(f"Ollama response missing expected message.content: {error}") from error

    try:
        return LlmRerankOutput.model_validate_json(content)
    except ValidationError as error:
        raise LlmCallError(f"qwen3:8b output failed structural validation: {error}") from error
