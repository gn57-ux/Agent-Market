import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { formatZodError } from "../../shared/zod-error.js";
import {
  addCommitteeMemberSchema,
  committeeMemberParamsSchema,
  disputeRecusalParamsSchema,
  recordRecusalSchema,
  replaceCommitteeMemberSchema,
} from "./schema.js";
import { addMember, listMembers, removeMember, replaceMember } from "./member-repository.js";
import { listRecusalsByDispute, recordRecusal } from "./recusal-repository.js";

/** Same per-module duplication convention every other admin-routes.ts in
 * this codebase documents (see risk-hold/admin-routes.ts). */
function requireSessionAddress(request: FastifyRequest, reply: FastifyReply): string | undefined {
  if (!request.address) {
    reply
      .status(401)
      .send({ error: { message: "未检测到会话，请先通过 POST /auth/verify 登录。" } });
    return undefined;
  }
  return request.address;
}

function serializeMember(member: Awaited<ReturnType<typeof listMembers>>[number]) {
  return {
    id: member.id,
    memberAddress: member.memberAddress,
    status: member.status,
    addedBy: member.addedBy,
    addedAt: member.addedAt.toISOString(),
    removedBy: member.removedBy,
    removedAt: member.removedAt?.toISOString() ?? null,
  };
}

/**
 * Feature 21 (arbitration-committee), T-2106 (F-2104; requirements.md
 * AC-2106). All three endpoints reuse `app.requireAdmin` verbatim
 * (Feature 16's own model) — this module never invents a parallel
 * permission check. `add`/`remove` both write through
 * `arbitration_committee_members` alone (F-2114: the table itself IS the
 * audit trail, `REMOVED` rows kept forever, never a separate log table).
 */
export function registerArbitrationCommitteeAdminRoutes(app: FastifyInstance, pool: Pool): void {
  app.get(
    "/admin/arbitration-committee/members",
    { preHandler: app.requireAdmin },
    async (_request, reply) => {
      const members = await listMembers(pool);
      return reply.status(200).send({ members: members.map(serializeMember) });
    },
  );

  app.post(
    "/admin/arbitration-committee/members",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const bodyParsed = addCommitteeMemberSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
      }
      const actorAddress = requireSessionAddress(request, reply);
      if (!actorAddress) return reply;

      const result = await addMember(pool, {
        memberAddress: bodyParsed.data.memberAddress,
        addedBy: actorAddress,
      });
      if (!result.ok || !result.member) {
        return reply.status(409).send({ error: { message: "该地址当前已是有效的委员会成员。" } });
      }
      return reply.status(201).send({ member: serializeMember(result.member) });
    },
  );

  app.post(
    "/admin/arbitration-committee/members/:memberAddress/remove",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const paramsParsed = committeeMemberParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const actorAddress = requireSessionAddress(request, reply);
      if (!actorAddress) return reply;

      const result = await removeMember(pool, {
        memberAddress: paramsParsed.data.memberAddress,
        removedBy: actorAddress,
      });
      if (!result.ok) {
        return reply.status(409).send({ error: { message: "该地址当前不是有效的委员会成员。" } });
      }
      return reply
        .status(200)
        .send({ memberAddress: paramsParsed.data.memberAddress.toLowerCase() });
    },
  );

  // N4 P1 fix (round 1): "替换" is a single atomic operation (remove the
  // old member + add the new one in ONE transaction), never two separate
  // client-issued calls — see `replaceMember`'s own doc comment.
  app.post(
    "/admin/arbitration-committee/members/:memberAddress/replace",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const paramsParsed = committeeMemberParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const bodyParsed = replaceCommitteeMemberSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
      }
      const actorAddress = requireSessionAddress(request, reply);
      if (!actorAddress) return reply;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await replaceMember(client, {
          oldMemberAddress: paramsParsed.data.memberAddress,
          newMemberAddress: bodyParsed.data.newMemberAddress,
          actorAddress,
        });
        if (!result.ok) {
          await client.query("ROLLBACK");
          const message =
            result.reason === "OLD_NOT_ACTIVE"
              ? "该地址当前不是有效的委员会成员，无法替换。"
              : "替代地址当前已是有效的委员会成员。";
          return reply.status(409).send({ error: { message } });
        }
        await client.query("COMMIT");
        return reply.status(200).send({ member: serializeMember(result.member) });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  // Feature 21, T-2107 (F-2106): recusal is a purely human-coordinated,
  // append-only declaration — Safe itself enforces nothing here (design.md
  // 已明确说明), so this endpoint's entire job is recording a real
  // decision that already happened off-chain, never gating anything on
  // chain.
  app.post(
    "/admin/disputes/:disputeId/recusals",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const paramsParsed = disputeRecusalParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const bodyParsed = recordRecusalSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(bodyParsed.error) } });
      }
      const actorAddress = requireSessionAddress(request, reply);
      if (!actorAddress) return reply;

      const result = await recordRecusal(pool, {
        disputeId: paramsParsed.data.disputeId,
        memberAddress: bodyParsed.data.memberAddress,
        reason: bodyParsed.data.reason,
        recordedBy: actorAddress,
      });
      if (!result.ok) {
        if (result.reason === "DISPUTE_NOT_FOUND") {
          return reply.status(404).send({ error: { message: "未找到该争议。" } });
        }
        if (result.reason === "MEMBER_NOT_ACTIVE") {
          return reply
            .status(400)
            .send({ error: { message: "该地址当前不是有效的委员会成员，无法声明回避。" } });
        }
        return reply.status(409).send({ error: { message: "该仲裁员在本争议中已声明过回避。" } });
      }
      return reply.status(201).send({
        recusal: {
          id: result.recusal.id,
          disputeId: result.recusal.disputeId,
          memberAddress: result.recusal.memberAddress,
          reason: result.recusal.reason,
          recordedBy: result.recusal.recordedBy,
          recordedAt: result.recusal.recordedAt.toISOString(),
        },
      });
    },
  );

  app.get(
    "/admin/disputes/:disputeId/recusals",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const paramsParsed = disputeRecusalParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: formatZodError(paramsParsed.error) } });
      }
      const recusals = await listRecusalsByDispute(pool, paramsParsed.data.disputeId);
      return reply.status(200).send({
        recusals: recusals.map((r) => ({
          id: r.id,
          disputeId: r.disputeId,
          memberAddress: r.memberAddress,
          reason: r.reason,
          recordedBy: r.recordedBy,
          recordedAt: r.recordedAt.toISOString(),
        })),
      });
    },
  );
}
