import type { Queryable } from "../../db/pool.js";
import type { AgentStatus } from "../agents/repository.js";
import type { TaskStatusValue } from "../tasks/repository.js";

export interface OfficeAgentRow {
  id: string;
  name: string;
  category: string;
  skillTags: string[];
  status: AgentStatus;
  completedTaskCount: number;
  successCount: number;
  overdueCount: number;
  qualityScore: number | null;
}

export interface OfficeTaskRow {
  id: string;
  title: string;
  status: TaskStatusValue;
  budget: string;
  deliveryDeadline: Date;
  submittedAt: Date | null;
  reviewDeadline: Date | null;
  disputeStatus: "NONE" | "OPEN" | "RESOLVED";
}

interface AgentQueryRow {
  id: string;
  name: string;
  category: string;
  status: AgentStatus;
  completed_task_count: number;
  success_count: number;
  overdue_count: number;
  quality_score: number | null;
  skill_tags: string[];
}

interface TaskQueryRow {
  id: string;
  title: string;
  status: TaskStatusValue;
  budget: string;
  delivery_deadline: Date;
  submitted_at: Date | null;
  review_deadline: Date | null;
  dispute_status: "NONE" | "OPEN" | "RESOLVED";
}

export interface OfficeRepositorySnapshot {
  agents: OfficeAgentRow[];
  published: OfficeTaskRow[];
  accepted: OfficeTaskRow[];
  averageRating: number | null;
}

function toTask(row: TaskQueryRow): OfficeTaskRow {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    budget: row.budget,
    deliveryDeadline: row.delivery_deadline,
    submittedAt: row.submitted_at,
    reviewDeadline: row.review_deadline,
    disputeStatus: row.dispute_status,
  };
}

async function readTasks(
  client: Queryable,
  column: "requester_address" | "accepted_agent_address",
  address: string,
): Promise<OfficeTaskRow[]> {
  const { rows } = await client.query<TaskQueryRow>(
    `SELECT t.id, t.title, t.status, t.budget, t.delivery_deadline, t.submitted_at, t.review_deadline,
       CASE WHEN d.status = 'OPEN' THEN 'OPEN' WHEN d.status = 'RESOLVED' THEN 'RESOLVED' ELSE 'NONE' END AS dispute_status
     FROM tasks t LEFT JOIN LATERAL (
       SELECT status FROM disputes WHERE task_id = t.id ORDER BY created_at DESC LIMIT 1
     ) d ON true
     WHERE t.${column} = $1 ORDER BY t.updated_at DESC, t.id DESC`,
    [address],
  );
  return rows.map(toTask);
}

export async function readOfficeRepositorySnapshot(
  client: Queryable,
  address: string,
): Promise<OfficeRepositorySnapshot> {
  const [agentResult, published, accepted, ratingResult] = await Promise.all([
    client.query<AgentQueryRow>(
      `SELECT a.id, a.name, a.category, a.status, a.completed_task_count, a.success_count,
              a.overdue_count, a.quality_score,
              COALESCE(array_agg(s.skill_tag) FILTER (WHERE s.skill_tag IS NOT NULL), '{}') AS skill_tags
       FROM agents a LEFT JOIN agent_skills s ON s.agent_id = a.id
       WHERE a.owner_address = $1 GROUP BY a.id ORDER BY a.created_at DESC, a.id DESC`,
      [address],
    ),
    readTasks(client, "requester_address", address),
    readTasks(client, "accepted_agent_address", address),
    client.query<{ average_rating: number | null }>(
      `SELECT avg(r.score)::float8 AS average_rating FROM ratings r
       JOIN tasks t ON t.id = r.task_id JOIN agents a ON a.id = t.accepted_agent_id
       WHERE a.owner_address = $1`,
      [address],
    ),
  ]);
  return {
    agents: agentResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      skillTags: row.skill_tags,
      status: row.status,
      completedTaskCount: row.completed_task_count,
      successCount: row.success_count,
      overdueCount: row.overdue_count,
      qualityScore: row.quality_score,
    })),
    published,
    accepted,
    averageRating: ratingResult.rows[0]?.average_rating ?? null,
  };
}
