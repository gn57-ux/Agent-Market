import type { Pool } from "pg";
import type { Queryable } from "../../db/pool.js";

export type AgentStatus = "ACTIVE" | "INACTIVE";

export interface AgentRow {
  id: string;
  ownerAddress: string;
  name: string;
  description: string;
  category: string;
  authorBio: string | null;
  invocationUrl: string | null;
  payoutAddress: string;
  pricingModel: string | null;
  referencePrice: string | null;
  status: AgentStatus;
  completedTaskCount: number;
  successCount: number;
  overdueCount: number;
  qualityScore: number | null;
  skillTags: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface AgentQueryRow {
  id: string;
  owner_address: string;
  name: string;
  description: string;
  category: string;
  author_bio: string | null;
  invocation_url: string | null;
  payout_address: string;
  pricing_model: string | null;
  reference_price: string | null;
  status: AgentStatus;
  completed_task_count: number;
  success_count: number;
  overdue_count: number;
  quality_score: number | null;
  created_at: Date;
  updated_at: Date;
}

function toAgentRow(row: AgentQueryRow, skillTags: string[]): AgentRow {
  return {
    id: row.id,
    ownerAddress: row.owner_address,
    name: row.name,
    description: row.description,
    category: row.category,
    authorBio: row.author_bio,
    invocationUrl: row.invocation_url,
    payoutAddress: row.payout_address,
    pricingModel: row.pricing_model,
    referencePrice: row.reference_price,
    status: row.status,
    completedTaskCount: row.completed_task_count,
    successCount: row.success_count,
    overdueCount: row.overdue_count,
    qualityScore: row.quality_score,
    skillTags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface InsertAgentInput {
  ownerAddress: string;
  name: string;
  description: string;
  category: string;
  authorBio?: string;
  invocationUrl?: string;
  payoutAddress: string;
  pricingModel?: string;
  referencePrice?: number;
  skillTags: string[];
}

/**
 * Inserts an `agents` row plus its `agent_skills` rows in one transaction —
 * a partial insert (agent created, some skill tags missing) would silently
 * corrupt F-501's "Agent 登记 + 技能标签" as a single unit. `quality_score` and
 * `completed_task_count` are never passed here: the migration's own
 * `DEFAULT`s (NULL and 0 respectively — see 0004_create_agents.sql) are the
 * single place that decides them (F-506), so this function can't drift from
 * that by, say, accidentally passing 0.5 as a "starter" quality score.
 */
export async function insertAgent(pool: Pool, input: InsertAgentInput): Promise<AgentRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<AgentQueryRow>(
      `INSERT INTO agents
         (owner_address, name, description, category, author_bio, invocation_url,
          payout_address, pricing_model, reference_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, owner_address, name, description, category, author_bio, invocation_url,
                 payout_address, pricing_model, reference_price, status, completed_task_count,
                 success_count, overdue_count, quality_score, created_at, updated_at`,
      [
        input.ownerAddress,
        input.name,
        input.description,
        input.category,
        input.authorBio ?? null,
        input.invocationUrl ?? null,
        input.payoutAddress,
        input.pricingModel ?? null,
        input.referencePrice ?? null,
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("insertAgent: INSERT ... RETURNING produced no row");
    }

    for (const skillTag of input.skillTags) {
      await client.query(`INSERT INTO agent_skills (agent_id, skill_tag) VALUES ($1, $2)`, [
        row.id,
        skillTag,
      ]);
    }

    await client.query("COMMIT");
    return toAgentRow(row, input.skillTags);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface ListAgentsFilter {
  category?: string;
  skillTag?: string;
  page: number;
  pageSize: number;
}

export interface ListAgentsResult {
  items: AgentRow[];
  total: number;
}

interface AgentListQueryRow extends AgentQueryRow {
  skill_tags: string[];
  total_count: string;
}

/**
 * F-502: paginated/filtered Agent listing. `total_count` comes from a
 * `count(*) OVER()` window — computed after the `GROUP BY`/`WHERE`
 * filtering and before `LIMIT`/`OFFSET`, so it's the true match count
 * across all pages, not just the page returned. `skillTag` filters via an
 * `EXISTS` subquery rather than joining on it directly, so the separate
 * `LEFT JOIN agent_skills` used to collect each agent's full tag list isn't
 * narrowed down to only the matching tag.
 */
export async function listAgents(
  pool: Queryable,
  filter: ListAgentsFilter,
): Promise<ListAgentsResult> {
  const offset = (filter.page - 1) * filter.pageSize;
  const { rows } = await pool.query<AgentListQueryRow>(
    `SELECT a.id, a.owner_address, a.name, a.description, a.category, a.author_bio,
            a.invocation_url, a.payout_address, a.pricing_model, a.reference_price,
            a.status, a.completed_task_count, a.success_count, a.overdue_count,
            a.quality_score, a.created_at, a.updated_at,
            COALESCE(
              array_agg(s.skill_tag) FILTER (WHERE s.skill_tag IS NOT NULL),
              '{}'
            ) AS skill_tags,
            count(*) OVER() AS total_count
     FROM agents a
     LEFT JOIN agent_skills s ON s.agent_id = a.id
     WHERE ($1::text IS NULL OR a.category = $1)
       AND (
         $2::text IS NULL
         OR EXISTS (
           SELECT 1 FROM agent_skills s2 WHERE s2.agent_id = a.id AND s2.skill_tag = $2
         )
       )
     GROUP BY a.id
     ORDER BY a.created_at DESC
     LIMIT $3 OFFSET $4`,
    [filter.category ?? null, filter.skillTag ?? null, filter.pageSize, offset],
  );

  const items = rows.map((row) => toAgentRow(row, row.skill_tags));
  const total = rows.length > 0 ? Number(rows[0]?.total_count) : 0;
  return { items, total };
}

/** F-502/F-508: single Agent detail lookup, `null` if no such id exists. */
export async function getAgentById(pool: Queryable, agentId: string): Promise<AgentRow | null> {
  const { rows } = await pool.query<AgentQueryRow & { skill_tags: string[] }>(
    `SELECT a.id, a.owner_address, a.name, a.description, a.category, a.author_bio,
            a.invocation_url, a.payout_address, a.pricing_model, a.reference_price,
            a.status, a.completed_task_count, a.success_count, a.overdue_count,
            a.quality_score, a.created_at, a.updated_at,
            COALESCE(
              array_agg(s.skill_tag) FILTER (WHERE s.skill_tag IS NOT NULL),
              '{}'
            ) AS skill_tags
     FROM agents a
     LEFT JOIN agent_skills s ON s.agent_id = a.id
     WHERE a.id = $1
     GROUP BY a.id`,
    [agentId],
  );
  const row = rows[0];
  return row ? toAgentRow(row, row.skill_tags) : null;
}
