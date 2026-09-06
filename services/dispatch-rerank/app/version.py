"""Feature 19, T-1910/F-1917. `rerank_service_version` names THIS service's
own code/prompt/LangGraph-graph version — bumped whenever this service's
behavior changes, independent of `ranking_policy_version` (F-1922, the
learned fusion-weight/policy version registered in `ctr_models`, T-1905).
A plain literal (not derived from git SHA/build metadata) at skeleton
stage — matches this Task's own scope; a real release-versioning scheme is
this service's own concern to add later, not invented speculatively here.
"""

SERVICE_VERSION = "0.1.0-skeleton"
