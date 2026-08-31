import type { Pool } from "pg";
import type { Queryable } from "../../db/pool.js";
import { computeCredentialRef } from "./credential.js";

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
  /** Feature 12 (agent-task-fields-credentials): always `"v1"` in this
   * stage — see 0013_add_agent_task_credentials.sql's `CHECK`. */
  protocolVersion: string;
  /** Feature 12: a reference string only (`env://VAR_NAME`), never the
   * real credential value — see credential.ts (T-1202) for the one place
   * that resolves this to an actual secret. `null` = not configured yet. */
  credentialRef: string | null;
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
  protocol_version: string;
  credential_ref: string | null;
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
    protocolVersion: row.protocol_version,
    credentialRef: row.credential_ref,
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
  /** Decimal text, never a JS `number` — see schema.ts's REFERENCE_PRICE_SCHEMA
   * doc comment for why: a NUMERIC column round-trips losslessly only if
   * this stays a string end-to-end. */
  referencePrice?: string;
  skillTags: string[];
  /** Omitted uses the migration's own `DEFAULT 'v1'`. */
  protocolVersion?: string;
  /** T-1300: `true` computes and sets the canonical `credentialRef` for
   * this Agent's own id (a same-transaction UPDATE after the INSERT, since
   * the real id doesn't exist before then); omitted/`false` leaves it
   * unconfigured. Never a free-text string — see credential.ts's
   * `computeCredentialRef` doc comment for why. */
  credentialEnabled?: boolean;
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
          payout_address, pricing_model, reference_price, protocol_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, owner_address, name, description, category, author_bio, invocation_url,
                 payout_address, pricing_model, reference_price, status, completed_task_count,
                 success_count, overdue_count, quality_score, created_at, updated_at,
                 protocol_version, credential_ref`,
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
        // Explicit "v1" (matching the migration's own DEFAULT) rather than
        // omitting the column when unset — Zod only ever accepts the
        // literal "v1" anyway (schema.ts's PROTOCOL_VERSION_SCHEMA), so
        // there is no other value this could resolve to.
        input.protocolVersion ?? "v1",
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("insertAgent: INSERT ... RETURNING produced no row");
    }

    // T-1300: credential_ref can only ever be the canonical value derived
    // from this row's own real id (the migration's own CHECK enforces the
    // same binding) — that id doesn't exist until the INSERT above returns
    // it, so "enable credential" is necessarily a second statement in this
    // same transaction, never a value passed into the INSERT itself.
    if (input.credentialEnabled) {
      row.credential_ref = computeCredentialRef(row.id);
      await client.query(`UPDATE agents SET credential_ref = $2 WHERE id = $1`, [
        row.id,
        row.credential_ref,
      ]);
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
  status?: AgentStatus;
  page: number;
  pageSize: number;
}

export interface ListAgentsResult {
  items: AgentRow[];
  total: number;
}

interface AgentListQueryRow extends AgentQueryRow {
  skill_tags: string[];
}

/**
 * F-502: paginated/filtered Agent listing. `total_count` comes from a
 * `count(*) OVER()` window — computed after the `GROUP BY`/`WHERE`
 * filtering and before `LIMIT`/`OFFSET` — but only for the rows the query
 * actually returns (Codex review, T-503 round 1, P2): a `page` beyond the
 * last populated page returns zero rows, and a `count(*) OVER()` computed
 * from zero rows is itself 0, silently misreporting a nonzero true total.
 * The total is therefore counted in a separate query using the same
 * filters, independent of the page/offset applied to the items query.
 * `skillTag` filters via an `EXISTS` subquery rather than joining on it
 * directly, so the separate `LEFT JOIN agent_skills` used to collect each
 * agent's full tag list isn't narrowed down to only the matching tag.
 *
 * Ordered by `created_at DESC, id DESC` (Codex review, T-503 round 1, P2):
 * ordering by `created_at` alone is not deterministic when two agents share
 * the same timestamp (achievable at this table's timestamp resolution under
 * concurrent inserts), which can duplicate or skip rows across separate
 * page requests under `LIMIT`/`OFFSET`. `id` is a `gen_random_uuid()`
 * primary key, unique by construction, so appending it as a tie-breaker
 * makes the ordering — and therefore the pagination — deterministic.
 *
 * `status` filters to exactly `ACTIVE` or `INACTIVE` when provided
 * (AC-505: "停用的 Agent 通过 GET /agents 可被状态筛选排除" — Codex review, T-504
 * round 1, P1: this filter didn't exist at all until this fix); omitted,
 * the listing is unfiltered by status, matching this endpoint's original
 * T-503 behavior.
 */
export async function listAgents(
  pool: Queryable,
  filter: ListAgentsFilter,
): Promise<ListAgentsResult> {
  const offset = (filter.page - 1) * filter.pageSize;
  const filterParams = [filter.category ?? null, filter.skillTag ?? null, filter.status ?? null];
  const filterWhere = `
    WHERE ($1::text IS NULL OR a.category = $1)
      AND (
        $2::text IS NULL
        OR EXISTS (
          SELECT 1 FROM agent_skills s2 WHERE s2.agent_id = a.id AND s2.skill_tag = $2
        )
      )
      AND ($3::text IS NULL OR a.status = $3)
  `;

  const [itemsResult, countResult] = await Promise.all([
    pool.query<AgentListQueryRow>(
      `SELECT a.id, a.owner_address, a.name, a.description, a.category, a.author_bio,
              a.invocation_url, a.payout_address, a.pricing_model, a.reference_price,
              a.status, a.completed_task_count, a.success_count, a.overdue_count,
              a.quality_score, a.created_at, a.updated_at, a.protocol_version, a.credential_ref,
              COALESCE(
                array_agg(s.skill_tag) FILTER (WHERE s.skill_tag IS NOT NULL),
                '{}'
              ) AS skill_tags
       FROM agents a
       LEFT JOIN agent_skills s ON s.agent_id = a.id
       ${filterWhere}
       GROUP BY a.id
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $4 OFFSET $5`,
      [...filterParams, filter.pageSize, offset],
    ),
    pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM agents a ${filterWhere}`,
      filterParams,
    ),
  ]);

  const items = itemsResult.rows.map((row) => toAgentRow(row, row.skill_tags));
  const total = Number(countResult.rows[0]?.total ?? "0");
  return { items, total };
}

/** F-502/F-508: single Agent detail lookup, `null` if no such id exists. */
export async function getAgentById(pool: Queryable, agentId: string): Promise<AgentRow | null> {
  const { rows } = await pool.query<AgentQueryRow & { skill_tags: string[] }>(
    `SELECT a.id, a.owner_address, a.name, a.description, a.category, a.author_bio,
            a.invocation_url, a.payout_address, a.pricing_model, a.reference_price,
            a.status, a.completed_task_count, a.success_count, a.overdue_count,
            a.quality_score, a.created_at, a.updated_at, a.protocol_version, a.credential_ref,
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

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  category?: string;
  /** `undefined` = don't change; `null` = clear (see schema.ts's
   * updateAgentSchema doc comment for why this distinction exists). */
  authorBio?: string | null;
  invocationUrl?: string | null;
  payoutAddress?: string;
  pricingModel?: string | null;
  /** Decimal text, never a JS `number` — see InsertAgentInput's field of
   * the same name and schema.ts's REFERENCE_PRICE_SCHEMA doc comment. */
  referencePrice?: string | null;
  skillTags?: string[];
  /** Not nullable — see schema.ts's updateAgentSchema doc comment: there is
   * no "unset" state to clear protocol_version back to. */
  protocolVersion?: string;
  /** T-1300: `undefined` = don't change; `true` = enable (compute+set);
   * `false` = disable (clear to `NULL`). See InsertAgentInput's field of
   * the same name. */
  credentialEnabled?: boolean;
}

/**
 * F-503: partial update. Only keys actually present in `patch` are
 * touched — `Partial<CreateAgentInput>` (design.md's PATCH contract) means
 * "change these fields," not "reset everything to these values with
 * omitted ones cleared." `skillTags`, when provided, replaces the full set
 * (delete-then-reinsert in the same transaction as the column update) since
 * there's no meaningful "partial" skill-tag edit at this table shape.
 * Returns `null` if `agentId` doesn't exist — service.ts turns that into a
 * 404 rather than this layer deciding the HTTP status.
 */
export async function updateAgent(
  pool: Pool,
  agentId: string,
  patch: UpdateAgentInput,
): Promise<AgentRow | null> {
  const client = await pool.connect();
  let found: boolean;
  try {
    await client.query("BEGIN");

    // T-1300: credential_ref is never taken as a value directly — `true`
    // computes the one canonical value this agentId can ever have, `false`
    // clears it, `undefined` leaves the column untouched (falls out of the
    // `!== undefined` filter below like every other field here).
    const credentialRefValue =
      patch.credentialEnabled === undefined
        ? undefined
        : patch.credentialEnabled
          ? computeCredentialRef(agentId)
          : null;

    const fieldMap: Record<string, unknown> = {
      name: patch.name,
      description: patch.description,
      category: patch.category,
      author_bio: patch.authorBio,
      invocation_url: patch.invocationUrl,
      payout_address: patch.payoutAddress,
      pricing_model: patch.pricingModel,
      reference_price: patch.referencePrice,
      protocol_version: patch.protocolVersion,
      credential_ref: credentialRefValue,
    };
    const entries = Object.entries(fieldMap).filter(([, value]) => value !== undefined);

    if (entries.length > 0) {
      const setClauses = entries.map(([column], index) => `${column} = $${index + 2}`);
      const values = entries.map(([, value]) => value);
      const result = await client.query(
        `UPDATE agents SET ${setClauses.join(", ")}, updated_at = now() WHERE id = $1`,
        [agentId, ...values],
      );
      found = (result.rowCount ?? 0) > 0;
    } else {
      // No plain-column changes requested (e.g. only skillTags changing) —
      // still confirm the agent exists before touching agent_skills, so a
      // patch targeting a nonexistent id doesn't silently create orphan
      // skill rows with no owning agent.
      const exists = await client.query(`SELECT 1 FROM agents WHERE id = $1`, [agentId]);
      found = (exists.rowCount ?? 0) > 0;
    }

    if (found && patch.skillTags !== undefined) {
      await client.query(`DELETE FROM agent_skills WHERE agent_id = $1`, [agentId]);
      for (const skillTag of patch.skillTags) {
        await client.query(`INSERT INTO agent_skills (agent_id, skill_tag) VALUES ($1, $2)`, [
          agentId,
          skillTag,
        ]);
      }
    }

    if (found) {
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return found ? getAgentById(pool, agentId) : null;
}

/**
 * F-504: sets `status` directly (`ACTIVE`/`INACTIVE`) — the activate/
 * deactivate endpoints' only state change. Returns `null` if `agentId`
 * doesn't exist.
 */
export async function setAgentStatus(
  pool: Queryable,
  agentId: string,
  status: AgentStatus,
): Promise<AgentRow | null> {
  const result = await pool.query(
    `UPDATE agents SET status = $2, updated_at = now() WHERE id = $1`,
    [agentId, status],
  );
  if ((result.rowCount ?? 0) === 0) {
    return null;
  }
  return getAgentById(pool, agentId);
}
