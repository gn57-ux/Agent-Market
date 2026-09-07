-- Feature 22 (ai-customer-service), T-2200 — knowledge base data model
-- (specs/22-ai-customer-service/design.md's "数据模型" / "决策 2" sections).
--
-- Modeled on 0015_create_vector_recall_scoring.sql's `agent_embeddings`
-- (provider/model/dimension/embedding_version columns, `dimension = 1024`
-- CHECK). `vector(1024)`/`dimension = 1024` matches 0017's already-applied
-- localization to Ollama's `bge-m3:latest` (design.md's decision 2: reuse
-- the same pgvector + Ollama embedding infrastructure Feature 13 already
-- verified) — do NOT use 1536, that was the superseded OpenAI dimension.
--
-- Deliberately NO ivfflat (or any approximate) index on `embedding`,
-- unlike `agent_embeddings`. `kb_articles` is searched by cosine
-- similarity across the whole table (RAG retrieval, F-2203), but
-- design.md's own 决策 2 already establishes the real reasoning for why
-- this table's scale never justifies new infrastructure ("知识库文章数量级
-- 远小于 Agent/任务数据量") — the same reasoning rules out ivfflat here, not
-- just a dedicated search engine. ivfflat is an APPROXIMATE index whose
-- k-means clustering is trained from whatever rows exist at
-- `CREATE INDEX` time; built here (as `agent_embeddings_ivfflat_idx` is)
-- against an empty just-created table, its clusters are degenerate and
-- later real queries against a few dozen real rows come back with a
-- silently WRONG top match at `probes=1` (verified directly against a
-- real seeded local Postgres: with the index present, a query for "验收
-- 窗口是多久" nondeterministically returned an unrelated article as the
-- top result; dropping the index and falling back to an exact
-- sequential scan `ORDER BY embedding <=> ...` always returned the
-- correct one). At kb_articles's real row count (dozens of FAQ/rule
-- entries, not agent/task volume), an exact sequential scan costs
-- microseconds — there is no real performance problem an approximate
-- index would be trading correctness for. F-2207 (citations must be
-- accurate, never a plausible-looking wrong one) makes retrieval
-- correctness a hard requirement here, not a tunable tradeoff.
--
-- `embedding` is nullable at the schema level only to describe the
-- instant between an INSERT and that same transaction's embedding call —
-- it is NOT meant to describe a real, long-lived "unembedded article"
-- state. F-2203 (RAG retrieval) can only ever find an article that has a
-- real vector, so this Feature's production write path (T-2200's own
-- seed-kb-articles.ts, and any future authoring path) must always
-- populate `embedding` before/within the same write that makes an article
-- content-complete — never insert a row and leave `embedding` NULL as an
-- accepted steady state. A NULL row is effectively invisible to search,
-- which is the correct failure mode for a row still mid-write, not a
-- feature.
--
-- `title` is UNIQUE: kb-repository.ts's `upsertKbArticleByTitle` uses it
-- as the natural key for seed-kb-articles.ts's idempotent re-runs (a
-- generated UUID can't serve as a stable key across runs of a script that
-- doesn't persist IDs anywhere else; `title` is the one human-authored
-- field guaranteed to identify "the same FAQ/rule entry" across edits to
-- its `content`).
CREATE TABLE kb_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  embedding vector(1024),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimension INTEGER NOT NULL CHECK (dimension = 1024),
  embedding_version TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
