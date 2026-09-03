import type { Pool } from "pg";
import type { Queryable } from "../../db/pool.js";
import { computeCredentialRef } from "./credential.js";

export type AgentStatus = "ACTIVE" | "INACTIVE";
/** F-1605/F-1607 (Feature 16, T-1603/T-1604) — mirrors
 * 0019_add_agent_review_status.sql's CHECK exactly. Orthogonal to
 * `AgentStatus` above (design.md 决策 3): `status` is the owner's own
 * market-visibility on/off switch, `review_status` is the platform's
 * review lifecycle. */
export type AgentReviewStatus = "DRAFT" | "PENDING_REVIEW" | "ACTIVE" | "REJECTED" | "SUSPENDED";
/** F-1604 (T-1604) — mirrors 0019's CHECK exactly. The ONLY field
 * F-1604's review-routing logic reads (service.ts's `createAgent`) —
 * never inferred from `referencePrice` (design.md 决策 5). */
export type AgentPricingType = "FREE" | "PER_TASK" | "SUBSCRIPTION" | "HOURLY";

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
  reviewStatus: AgentReviewStatus;
  pricingType: AgentPricingType;
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
  review_status: AgentReviewStatus;
  pricing_type: AgentPricingType;
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
    reviewStatus: row.review_status,
    pricingType: row.pricing_type,
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
  /** F-1604 (T-1604) — required, computed by service.ts's `createAgent`
   * into `reviewStatus` below (never optional/inferred at this layer). */
  pricingType: AgentPricingType;
  /** F-1604 — the review-routing decision service.ts already made
   * (`pricingType === 'FREE' ? 'ACTIVE' : 'PENDING_REVIEW'`) — this layer
   * writes whatever it's given, it does not re-derive the business rule
   * (single ownership of that rule stays in service.ts). */
  reviewStatus: AgentReviewStatus;
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
          payout_address, pricing_model, reference_price, protocol_version,
          pricing_type, review_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, owner_address, name, description, category, author_bio, invocation_url,
                 payout_address, pricing_model, reference_price, status, review_status,
                 pricing_type, completed_task_count, success_count, overdue_count, quality_score,
                 created_at, updated_at, protocol_version, credential_ref`,
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
        input.pricingType,
        input.reviewStatus,
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
  /** F-1604 (T-1604) — when provided, filters to exactly this
   * `review_status`. Parameterized here (not hardcoded in this function)
   * so this stays the one generic listing primitive both the public
   * market listing (service.ts's `listAgentsForMarket`, always passes
   * `'ACTIVE'`) and a future admin review-queue query (T-1605) can share,
   * rather than each needing its own separate SQL. */
  reviewStatus?: AgentReviewStatus;
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
  const filterParams = [
    filter.category ?? null,
    filter.skillTag ?? null,
    filter.status ?? null,
    filter.reviewStatus ?? null,
  ];
  const filterWhere = `
    WHERE ($1::text IS NULL OR a.category = $1)
      AND (
        $2::text IS NULL
        OR EXISTS (
          SELECT 1 FROM agent_skills s2 WHERE s2.agent_id = a.id AND s2.skill_tag = $2
        )
      )
      AND ($3::text IS NULL OR a.status = $3)
      AND ($4::text IS NULL OR a.review_status = $4)
  `;

  const [itemsResult, countResult] = await Promise.all([
    pool.query<AgentListQueryRow>(
      `SELECT a.id, a.owner_address, a.name, a.description, a.category, a.author_bio,
              a.invocation_url, a.payout_address, a.pricing_model, a.reference_price,
              a.status, a.review_status, a.pricing_type, a.completed_task_count,
              a.success_count, a.overdue_count, a.quality_score, a.created_at, a.updated_at,
              a.protocol_version, a.credential_ref,
              COALESCE(
                array_agg(s.skill_tag) FILTER (WHERE s.skill_tag IS NOT NULL),
                '{}'
              ) AS skill_tags
       FROM agents a
       LEFT JOIN agent_skills s ON s.agent_id = a.id
       ${filterWhere}
       GROUP BY a.id
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $5 OFFSET $6`,
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
            a.status, a.review_status, a.pricing_type, a.completed_task_count,
            a.success_count, a.overdue_count, a.quality_score, a.created_at, a.updated_at,
            a.protocol_version, a.credential_ref,
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

/** F-1607 (Feature 16) — a review-status transition to record. `reason`
 * is required here (not optional) even though the DB column allows NULL:
 * every CALLER of this function is a real, specific transition (pricing-
 * type FREE-boundary crossing today; admin approve/reject/suspend/appeal
 * in later Tasks) that always has a concrete reason to state, so this
 * type-level requirement is what actually prevents an unexplained audit
 * row from being written by accident — an application-layer guarantee
 * the DB's own nullable column can't provide on its own. */
export interface AgentReviewTransition {
  toReviewStatus: AgentReviewStatus;
  actorAddress: string;
  reason: string;
}

/** The Agent's `pricing_type`/`review_status` as read under
 * `setAgentPricingType`'s row lock — the ONLY state a transition decision
 * may legally be based on (see that function's doc comment for why). */
export interface CurrentAgentPricingReview {
  pricingType: AgentPricingType;
  reviewStatus: AgentReviewStatus;
}

/**
 * F-1604/F-1607 (Feature 16, T-1604) — updates `pricing_type`, and
 * whatever `decide` returns given the row's CURRENT (freshly-locked)
 * state, also updates `review_status` and writes one
 * `agent_review_audit_logs` row — all in one transaction (a partial write
 * would corrupt F-1607's audit guarantee).
 *
 * N4 round-1 real finding (P1, race condition): the previous version
 * computed the FREE-boundary transition in service.ts BEFORE this
 * function's own `SELECT ... FOR UPDATE`, from a pre-transaction
 * snapshot. Two concurrent pricing-type changes on the same Agent could
 * both decide from the SAME stale state, and whichever committed second
 * would silently discard the first's review-status change while still
 * applying its own pricing_type write — producing a paid Agent that
 * never actually went through review. Fixed by inverting control: this
 * function does the `SELECT ... FOR UPDATE` FIRST, then calls `decide`
 * with the state it just read (guaranteed fresh — the lock excludes any
 * concurrent writer from having committed a change this read wouldn't
 * see), and only then writes. `decide` is intentionally NOT this
 * function's job to write (design ownership: the FREE-boundary business
 * rule stays in service.ts, only forced to run at the correct point in
 * time by this function's control flow) — it may return `null` for "no
 * review-status change" (e.g. a non-crossing pricing edit, or the
 * REJECTED/SUSPENDED guard below).
 */
export async function setAgentPricingType(
  pool: Pool,
  agentId: string,
  pricingType: AgentPricingType,
  decide: (current: CurrentAgentPricingReview) => AgentReviewTransition | null,
): Promise<AgentRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const current = await client.query<{
      pricing_type: AgentPricingType;
      review_status: AgentReviewStatus;
    }>(`SELECT pricing_type, review_status FROM agents WHERE id = $1 FOR UPDATE`, [agentId]);
    const row = current.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }

    const transition = decide({ pricingType: row.pricing_type, reviewStatus: row.review_status });

    if (transition) {
      await client.query(
        `UPDATE agents SET pricing_type = $2, review_status = $3, updated_at = now() WHERE id = $1`,
        [agentId, pricingType, transition.toReviewStatus],
      );
      await client.query(
        `INSERT INTO agent_review_audit_logs (agent_id, actor_address, from_status, to_status, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          agentId,
          transition.actorAddress,
          row.review_status,
          transition.toReviewStatus,
          transition.reason,
        ],
      );
    } else {
      await client.query(`UPDATE agents SET pricing_type = $2, updated_at = now() WHERE id = $1`, [
        agentId,
        pricingType,
      ]);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return getAgentById(pool, agentId);
}

export type SetReviewStatusResult =
  | { ok: true; agent: AgentRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_transition" };

/**
 * F-1605/F-1606 (Feature 16, T-1605) — the admin review-lifecycle sibling
 * of `setAgentPricingType` above: lock the row, hand its freshly-read
 * `review_status` to `decide`, then write `review_status` + one
 * `agent_review_audit_logs` row atomically. Same "lock-then-decide-then-
 * write" control-flow inversion for the same reason (a pre-transaction
 * snapshot would let two concurrent transitions both decide from stale
 * state).
 *
 * Deliberately a SEPARATE function from `setAgentPricingType`, not a
 * shared helper both call (design comparison, per project rule requiring
 * one for a new piece of shared-state-mutation logic): `setAgentPricingType`
 * unconditionally writes `pricing_type` and OPTIONALLY writes
 * `review_status` alongside it (a `null` decide result is a valid
 * "pricing changed, no review-status change" outcome); this function
 * writes ONLY `review_status`, and a `null` decide result means the
 * requested transition is illegal and the whole call must fail — those
 * are different success/failure shapes for what "decide returned null"
 * means, and forcing them through one shared signature would either lose
 * that distinction or need an extra discriminant parameter to recover it.
 * The ~15 lines of duplicated lock/write/audit-insert control flow is
 * cheaper than a shared abstraction whose contract would itself need
 * comments to explain which meaning applies to which caller (CLAUDE.md 原
 * 则 4: 降低复杂性优先于减少代码行数).
 */
export async function setAgentReviewStatus(
  pool: Pool,
  agentId: string,
  decide: (current: { reviewStatus: AgentReviewStatus }) => AgentReviewTransition | null,
): Promise<SetReviewStatusResult> {
  const client = await pool.connect();
  let agent: AgentRow;
  try {
    await client.query("BEGIN");

    const current = await client.query<{ review_status: AgentReviewStatus }>(
      `SELECT review_status FROM agents WHERE id = $1 FOR UPDATE`,
      [agentId],
    );
    const row = current.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }

    const transition = decide({ reviewStatus: row.review_status });
    if (!transition) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "invalid_transition" };
    }

    await client.query(`UPDATE agents SET review_status = $2, updated_at = now() WHERE id = $1`, [
      agentId,
      transition.toReviewStatus,
    ]);
    await client.query(
      `INSERT INTO agent_review_audit_logs (agent_id, actor_address, from_status, to_status, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        agentId,
        transition.actorAddress,
        row.review_status,
        transition.toReviewStatus,
        transition.reason,
      ],
    );

    // Codex review (T-1605 round 2 P2): captured HERE, via `client`, while
    // this transaction still holds the row lock — not after COMMIT
    // releases it. A re-query against `pool` after commit (the previous
    // version of this function, and `setAgentPricingType` above, both had
    // this gap) could race a LATER concurrent transition that commits in
    // the window between this COMMIT and that re-query, silently returning
    // a state this specific call never produced (e.g. an approve request
    // reporting `SUSPENDED` because a concurrent suspend landed a moment
    // later — the approve genuinely wrote `ACTIVE`, but its own response
    // would lie about what it did).
    const refetched = await getAgentById(client, agentId);
    if (!refetched) {
      throw new Error("setAgentReviewStatus: agent vanished mid-transaction after its own update");
    }
    agent = refetched;

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { ok: true, agent };
}
