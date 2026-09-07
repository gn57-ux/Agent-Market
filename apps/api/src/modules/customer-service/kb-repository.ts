import type { Queryable } from "../../db/pool.js";

// Feature 22 (ai-customer-service), T-2200. This is the ONE module that
// knows `kb_articles`' columns (CLAUDE.md 原则 6: 设计知识只能有一个归属) —
// seed-kb-articles.ts and every future customer-service Task (T-2202's RAG
// generation, T-2204's citation lookups) must go through the functions
// here, never query the table directly.

export interface KbArticleRow {
  id: string;
  title: string;
  content: string;
  provider: string;
  model: string;
  dimension: number;
  embeddingVersion: string;
  updatedAt: Date;
}

export interface KbArticleMatch extends KbArticleRow {
  /** Cosine similarity (`1 - cosine distance`) against the query vector —
   * same `1 - (embedding <=> $1::vector)` convention already used by
   * `dispatch/repository.ts`'s agent/task candidate scoring, reused
   * verbatim rather than inventing a different distance operator. Higher
   * is more similar; 1.0 is an exact match. */
  similarity: number;
}

/** pgvector's textual input format for a `vector(N)` column — the same
 * bracketed, comma-separated literal `embed-on-save.ts`'s own
 * `toVectorLiteral` produces (no `pgvector` npm binding in this repo, see
 * that module's identical comment). Duplicated here (not imported) because
 * embed-on-save.ts's copy is a private, unexported helper — this is a
 * one-line format with no other logic worth sharing. */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

interface KbArticleDbRow {
  id: string;
  title: string;
  content: string;
  provider: string;
  model: string;
  dimension: number;
  embedding_version: string;
  updated_at: Date;
}

function toKbArticleRow(row: KbArticleDbRow): KbArticleRow {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    provider: row.provider,
    model: row.model,
    dimension: row.dimension,
    embeddingVersion: row.embedding_version,
    updatedAt: row.updated_at,
  };
}

/**
 * F-2203 (RAG 检索): cosine-similarity search over every embedded
 * `kb_articles` row, most similar first. Rows with a NULL `embedding`
 * (see 0043's migration comment — should never be a long-lived state in
 * production, but a defensive `WHERE embedding IS NOT NULL` keeps a
 * mid-write row from ever being returned as a false match) are excluded.
 *
 * N4 real finding (round 1, T-2200): callers MUST pass the CURRENT
 * `embedding_version` (from the same `OllamaEmbeddingProvider.
 * resolveVersionIdentity()`/`computeEmbeddingVersion` the query vector
 * itself was produced with) and this function filters to ONLY rows
 * sharing that exact version. `bge-m3:latest`'s weights can change under
 * the same tag after a local `ollama pull` (the digest half of
 * `embedding_version` is exactly what distinguishes that — see
 * embed-on-save.ts's own doc comment), and `seed-kb-articles.ts` upserts
 * one article at a time, so a model update or a failure partway through
 * a re-seed can leave rows from two different, geometrically unrelated
 * vector spaces coexisting in this table. Comparing a fresh query vector
 * against a stale row from an old vector space via `<=>` is meaningless
 * cosine-distance arithmetic — it can silently rank a wrong article
 * first (F-1302's own established rule: "不同模型的向量空间不可混用"),
 * directly threatening F-2207's citation-accuracy requirement. Without
 * this filter, `WHERE embedding IS NOT NULL` alone would still let one
 * or more stale rows leak into the ranking.
 */
export async function searchKbArticles(
  pool: Queryable,
  queryEmbedding: number[],
  embeddingVersion: string,
  limit = 5,
): Promise<KbArticleMatch[]> {
  const { rows } = await pool.query<KbArticleDbRow & { similarity: number }>(
    `SELECT id, title, content, provider, model, dimension, embedding_version, updated_at,
            1 - (embedding <=> $1::vector) AS similarity
     FROM kb_articles
     WHERE embedding IS NOT NULL AND embedding_version = $3
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [toVectorLiteral(queryEmbedding), limit, embeddingVersion],
  );
  return rows.map((row) => ({ ...toKbArticleRow(row), similarity: row.similarity }));
}

/**
 * Needed by T-2202's citation feature (F-2207: an assistant answer must be
 * able to resolve the specific `kb_articles` row(s) it cited back to their
 * full content/title for display).
 */
export async function getKbArticleById(pool: Queryable, id: string): Promise<KbArticleRow | null> {
  const { rows } = await pool.query<KbArticleDbRow>(
    `SELECT id, title, content, provider, model, dimension, embedding_version, updated_at
     FROM kb_articles
     WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? toKbArticleRow(row) : null;
}

/**
 * T-2200's own seed/backfill upsert path — kept here (not duplicated in
 * seed-kb-articles.ts) since inserting a `kb_articles` row is exactly the
 * kind of column-shape knowledge this module exists to own. Upserts by
 * `title` (see seed-kb-articles.ts's header comment for why `title` is the
 * chosen natural key), so re-running the seed script with edited content
 * updates the existing row in place instead of duplicating it.
 */
export async function upsertKbArticleByTitle(
  pool: Queryable,
  article: {
    title: string;
    content: string;
    embedding: number[];
    provider: string;
    model: string;
    dimension: number;
    embeddingVersion: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO kb_articles (title, content, embedding, provider, model, dimension, embedding_version, updated_at)
     VALUES ($1, $2, $3::vector, $4, $5, $6, $7, now())
     ON CONFLICT (title) DO UPDATE SET
       content = EXCLUDED.content,
       embedding = EXCLUDED.embedding,
       provider = EXCLUDED.provider,
       model = EXCLUDED.model,
       dimension = EXCLUDED.dimension,
       embedding_version = EXCLUDED.embedding_version,
       updated_at = now()`,
    [
      article.title,
      article.content,
      toVectorLiteral(article.embedding),
      article.provider,
      article.model,
      article.dimension,
      article.embeddingVersion,
    ],
  );
}
