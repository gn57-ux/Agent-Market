import type { Queryable } from "../../db/pool.js";
import { readOfficeRepositorySnapshot, type OfficeTaskRow } from "./repository.js";
import type { OfficeFundsReader } from "./funds-reader.js";
import { officeSnapshotSchema, type OfficeSnapshot, type OfficeTaskSummary } from "./schema.js";

function taskSummary(task: OfficeTaskRow): OfficeTaskSummary {
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    budget: task.budget,
    deliveryDeadline: task.deliveryDeadline.toISOString(),
  };
}

export async function buildOfficeSnapshot(
  client: Queryable,
  fundsReader: OfficeFundsReader,
  address: `0x${string}`,
  now: Date = new Date(),
): Promise<OfficeSnapshot> {
  const data = await readOfficeRepositorySnapshot(client, address);
  const funds = await fundsReader.read(address, data.published, data.accepted);
  const completed = data.accepted.filter((task) => task.status === "RELEASED");
  const deliveryDesk = data.accepted.filter((task) =>
    ["ACCEPTED", "SUBMITTED", "DISPUTED"].includes(task.status),
  );
  const completedTaskCount = data.agents.reduce((sum, agent) => sum + agent.completedTaskCount, 0);
  const overdueCount = data.agents.reduce((sum, agent) => sum + agent.overdueCount, 0);
  const scoredAgents = data.agents.filter((agent) => agent.qualityScore !== null);
  const qualityScore =
    scoredAgents.length === 0
      ? null
      : scoredAgents.reduce((sum, agent) => sum + (agent.qualityScore ?? 0), 0) /
        scoredAgents.length;
  return officeSnapshotSchema.parse({
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    viewer: { address },
    agents: data.agents.map((agent) => ({
      agentId: agent.id,
      name: agent.name,
      category: agent.category,
      skillTags: agent.skillTags,
      status: agent.status,
      completionRate:
        agent.completedTaskCount === 0 ? null : agent.successCount / agent.completedTaskCount,
      qualityScore: agent.qualityScore,
    })),
    taskBoard: {
      published: data.published.map(taskSummary),
      accepted: data.accepted.map(taskSummary),
    },
    funds,
    deliveryDesk: deliveryDesk.map((task) => ({
      ...taskSummary(task),
      submittedAt: task.submittedAt?.toISOString() ?? null,
      reviewDeadline: task.reviewDeadline?.toISOString() ?? null,
      disputeStatus: task.disputeStatus,
    })),
    achievements: {
      completedTaskCount,
      averageRating: data.averageRating,
      qualityScore,
      overdueCount,
      recentCompletedTasks: completed.slice(0, 5).map(taskSummary),
    },
  });
}
