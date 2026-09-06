"""Feature 19 (ctr-online-learning), T-1910/T-1911.

`services/dispatch-rerank/` — an independent Python deployment unit
(design.md 决策 5), not in the pnpm workspace, never called by Go
(F-1914/F-1915: Node is the only real caller). `/rerank` is internal-only
(not exposed to the frontend); `/openapi.json` is FastAPI's own built-in
schema endpoint, the single source of truth Node's generated types
(`apps/api`'s `generate-rerank-types` script) are built from — see
`scripts/export_openapi.py` for how that schema gets frozen into a
committed file.

T-1911's real pipeline (`pipeline.py`: deterministic fusion → qwen3:8b →
validation, with a fallback to the fusion-only order on any failure)
ALWAYS produces a valid full permutation of the input candidates by
construction (`ranking.validate_full_permutation` runs inside the pipeline
itself for the LLM path, and the fusion-only fallback path is trivially a
permutation) — so, unlike T-1910's own skeleton, this handler no longer
needs its own separate validate-then-500 branch; that check still exists,
just one layer down, inside `pipeline.py`.
"""

import logging

from fastapi import FastAPI, Request

from .models import RerankRequest, RerankResponse
from .pipeline import run_rerank_pipeline
from .version import SERVICE_VERSION

app = FastAPI(title="dispatch-rerank", version=SERVICE_VERSION)
logger = logging.getLogger("dispatch_rerank")
# Uvicorn only configures its OWN loggers ("uvicorn", "uvicorn.access", ...)
# at INFO with their own handlers — an application logger like this one
# has neither by default, so a bare `setLevel` alone still falls through to
# Python's WARNING-only "handler of last resort" and every trace_id line
# would be silently dropped. A plain StreamHandler to stdout matches Go's
# own `log.Printf`-to-stdout convention (services/dispatch/cmd/server) —
# no new logging framework for one line.
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s:%(name)s:%(message)s"))
    logger.addHandler(_handler)
logger.setLevel(logging.INFO)


@app.post("/rerank", response_model=RerankResponse)
def rerank(request: RerankRequest, http_request: Request) -> RerankResponse:
    # F-1919 (Feature 19, T-1912): the Python leg of the same cross-process
    # trace Node originates for one `/match` call (`rerank-client.ts` sends
    # this as `x-trace-id`, mirroring the header Go already reads and logs
    # in `handleMatch`). Logged only, never used for any routing/business
    # decision — a missing header (e.g. a direct/manual call to this
    # service) is not an error, just an untraced request.
    trace_id = http_request.headers.get("x-trace-id")
    if trace_id:
        logger.info("trace_id=%s POST /rerank", trace_id)

    result = run_rerank_pipeline(
        request.task_description, request.candidates, request.ranking_policy
    )

    return RerankResponse(
        ranked_agent_ids=result["ranked_agent_ids"],
        rationales=[
            {"agentId": agent_id, "reason": result["reasons"].get(agent_id, "")}
            for agent_id in result["ranked_agent_ids"]
        ],
        rerank_service_version=SERVICE_VERSION,
        # T-1907 (用户 2026-09-06 决策): read off the PIPELINE's own final
        # state, never directly off `request.ranking_policy` — see
        # `run_rerank_pipeline`'s doc comment for why that's the only way
        # to guarantee this value always matches what `fusion_node`
        # actually used, not merely what the caller asked for.
        ranking_policy_version=result["ranking_policy_version"],
        llm_adopted=result["llm_adopted"],
    )
