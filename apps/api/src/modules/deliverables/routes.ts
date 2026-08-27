import type { ErrorCode } from "@agent-market/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import multipart from "@fastify/multipart";
import { getTaskById } from "../tasks/repository.js";
import { isAuthorizedForDeliverableAccess } from "./access-guard.js";
import { computeFileDigest, computeUrlDigest } from "./digest.js";
import {
  checkSubmissionAllowed,
  DeliverableSubmissionNotAllowedError,
  getLatestDeliverableForTask,
  insertDeliverableIfSubmissionAllowed,
} from "./repository.js";
import { submitDeliverableUrlSchema, taskIdParamSchema } from "./schema.js";
import {
  ALLOWED_MIME_TYPES,
  DeliverableFileTooLargeError,
  DeliverableFileTypeNotAllowedError,
  MAX_FILE_SIZE_BYTES,
  deleteFile,
  readFile,
  saveFile,
} from "./storage.local.js";

/**
 * `@fastify/multipart` does not export its `RequestFileTooLargeError`
 * class from its public API — `createError`'s stable, documented contract
 * is the `.code` string it stamps onto every instance
 * (`FST_REQ_FILE_TOO_LARGE`), so that is what this checks rather than an
 * `instanceof` against an unavailable class reference.
 */
function isFileTooLargeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE"
  );
}

// Same pattern as tasks/routes.ts's own TASK_STATE_CONFLICT constant —
// typed against @agent-market/domain's ErrorCode so a rename/removal in
// error-codes.ts fails this file to typecheck instead of silently
// drifting from a hardcoded string literal.
const TASK_STATE_CONFLICT: ErrorCode = "TASK_STATE_CONFLICT";

/** Same pattern as tasks/routes.ts's own `requireSessionAddress` — reads
 * `request.address` (populated by `app.requireSession`) without a
 * non-null assertion. Deliberately re-declared per module rather than
 * shared/exported, matching this codebase's established convention for
 * this exact helper (see tasks/routes.ts's doc comment on its own copy). */
function requireSessionAddress(request: FastifyRequest, reply: FastifyReply): string | undefined {
  if (!request.address) {
    reply
      .status(401)
      .send({ error: { message: "未检测到会话，请先通过 POST /auth/verify 登录。" } });
    return undefined;
  }
  return request.address;
}

/**
 * Best-effort orphaned-file cleanup — deliberately swallows (after logging)
 * any error `deleteFile` itself throws, rather than letting it propagate.
 * Human review (T-902 round 1 P2 follow-up): the previous version called
 * `deleteFile` directly, unguarded, at each call site — if the filesystem
 * delete itself failed (permissions, disk error, a genuinely already-gone
 * file racing some other cleanup), THAT exception would replace whatever
 * response the caller was already in the middle of sending: a real
 * database error meant to become a 500 could be masked by a cleanup
 * exception instead, and a 409 already written to `reply` by
 * `persistOrReject` could be short-circuited by an unrelated cleanup
 * failure. Every call site below awaits this instead of `deleteFile`
 * directly specifically so cleanup can never change what the client
 * ultimately sees.
 */
async function cleanupOrphanedFile(app: FastifyInstance, filePath: string): Promise<void> {
  try {
    await deleteFile(filePath);
  } catch (cleanupError) {
    app.log.error(
      { err: cleanupError, filePath },
      "Failed to clean up an orphaned deliverable file after a failed persistence attempt",
    );
  }
}

/**
 * `POST /tasks/:taskId/deliverables`, `GET /tasks/:taskId/deliverables/latest`,
 * `GET /tasks/:taskId/deliverables/latest/file` (design.md's interface
 * contract). T-902 implements the POST route (file + URL input, digest
 * generation, persistence, F-906 authorization) — the GET routes are
 * T-904/T-907's own scope, registered by later Tasks extending this same
 * file (established incremental-registration convention, e.g.
 * dispatch/routes.ts across T-701/T-702/T-806/T-808).
 *
 * F-906's authorization is enforced TWICE, deliberately: once here (fast
 * path, using the `getTaskById` read already needed for the 404 check) so
 * an obviously-invalid request never even reaches file upload work, and
 * once more inside `insertDeliverableIfSubmissionAllowed`'s
 * `SELECT ... FOR UPDATE`-locked recheck (repository.ts) right before the
 * actual INSERT — the only one of the two that is authoritative (N4 round
 * 2 P1, Codex: the fast check alone left a TOCTOU window between reading
 * the task and finishing a — potentially slow — file upload).
 */
export function registerDeliverablesRoutes(app: FastifyInstance, pool: Pool): void {
  void app.register(multipart, {
    limits: {
      // Defense-in-depth transport-layer cap, matching storage.local.ts's
      // own MAX_FILE_SIZE_BYTES — this stops an oversized upload from
      // being fully buffered into memory before that module's own check
      // ever runs; storage.local.ts's check remains the authoritative one
      // for the normal (non-truncated) case, since a length exactly at
      // this limit is legitimately valid.
      fileSize: MAX_FILE_SIZE_BYTES,
    },
  });

  app.post(
    "/tasks/:taskId/deliverables",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const paramsParsed = taskIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: paramsParsed.error.message } });
      }
      const sessionAddressOrUndefined = requireSessionAddress(request, reply);
      if (!sessionAddressOrUndefined) {
        return reply;
      }
      // Re-bound to a plain `string` const (not `string | undefined`) —
      // TypeScript's control-flow narrowing from the `if` check above does
      // not carry into the nested `persistOrReject` function declared
      // below, since a closure could in principle run after further
      // reassignment; a fresh, never-reassigned binding sidesteps that
      // without a non-null assertion.
      const sessionAddress: string = sessionAddressOrUndefined;

      const taskOrNull = await getTaskById(pool, paramsParsed.data.taskId);
      if (!taskOrNull) {
        return reply.status(404).send({ error: { message: "任务不存在。" } });
      }
      const task = taskOrNull;

      // Fast-path rejection only — see this function's own doc comment.
      // Not a non-null-assert-worthy guarantee for what follows: the
      // authoritative recheck happens inside the locked transaction below.
      const fastDenialReason = checkSubmissionAllowed(task, sessionAddress);
      if (fastDenialReason) {
        return reply
          .status(409)
          .send({ error: { code: TASK_STATE_CONFLICT, message: fastDenialReason } });
      }

      async function persistOrReject(input: {
        storageType: "LOCAL_FILE" | "URL";
        filePath: string | null;
        resultUrl: string | null;
        mimeType: string | null;
        sizeBytes: number | null;
        resultHash: string;
      }) {
        try {
          return await insertDeliverableIfSubmissionAllowed(
            pool,
            {
              taskId: task.id,
              agentAddress: sessionAddress,
              ...input,
            },
            sessionAddress,
          );
        } catch (error) {
          if (error instanceof DeliverableSubmissionNotAllowedError) {
            reply.status(409).send({ error: { code: TASK_STATE_CONFLICT, message: error.reason } });
            return undefined;
          }
          throw error;
        }
      }

      if (request.isMultipart()) {
        const file = await request.file();
        if (!file) {
          return reply.status(400).send({ error: { message: "未提供成果文件。" } });
        }
        if (!ALLOWED_MIME_TYPES.includes(file.mimetype as (typeof ALLOWED_MIME_TYPES)[number])) {
          return reply.status(400).send({
            error: { message: `不支持的文件类型：${file.mimetype}` },
          });
        }
        // N4 round 1 P2 (Codex): `@fastify/multipart` v8 defaults
        // `throwFileSizeLimit` to `true` — when the upload exceeds the
        // `fileSize` limit registered above, `toBuffer()` itself THROWS
        // (`FST_REQ_FILE_TOO_LARGE`) partway through reading the stream;
        // it never returns normally with `file.file.truncated` set. The
        // `if (file.file.truncated)` check that used to run AFTER
        // `toBuffer()` was therefore unreachable dead code — an oversized
        // upload escaped as an unhandled 500 instead of this route's
        // intended 400.
        let buffer: Buffer;
        try {
          buffer = await file.toBuffer();
        } catch (error) {
          if (isFileTooLargeError(error)) {
            return reply.status(400).send({
              error: { message: `文件超出大小限制（最大 ${MAX_FILE_SIZE_BYTES} 字节）。` },
            });
          }
          throw error;
        }

        let saved;
        try {
          saved = await saveFile({ buffer, mimeType: file.mimetype });
        } catch (error) {
          if (
            error instanceof DeliverableFileTypeNotAllowedError ||
            error instanceof DeliverableFileTooLargeError
          ) {
            return reply.status(400).send({ error: { message: error.message } });
          }
          throw error;
        }

        const resultHash = computeFileDigest(buffer);
        let deliverable;
        try {
          deliverable = await persistOrReject({
            storageType: "LOCAL_FILE",
            filePath: saved.filePath,
            resultUrl: null,
            mimeType: saved.mimeType,
            sizeBytes: saved.sizeBytes,
            resultHash,
          });
        } catch (error) {
          // N4 round 1 P2 (Codex): the file was already written to disk by
          // `saveFile` above — if persistence fails for any reason
          // (constraint violation, connection error, the locked recheck
          // rejecting the submission), that file would otherwise become a
          // permanently orphaned, unreferenced blob nothing ever points
          // back to. `cleanupOrphanedFile` (not a bare `deleteFile` call)
          // so a cleanup failure can never replace the real error about to
          // be rethrown here.
          await cleanupOrphanedFile(app, saved.filePath);
          throw error;
        }
        if (!deliverable) {
          // `persistOrReject` already sent the 409 reply — also clean up
          // the file for this rejection path, same reasoning as the catch
          // block above (a cleanup failure here must not turn the already-
          // decided 409 into anything else).
          await cleanupOrphanedFile(app, saved.filePath);
          return reply;
        }

        return reply.status(201).send({
          deliverableId: deliverable.id,
          resultHash: deliverable.resultHash,
          storedAt: deliverable.createdAt.toISOString(),
        });
      }

      const bodyParsed = submitDeliverableUrlSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: { message: bodyParsed.error.message } });
      }

      const resultHash = computeUrlDigest(bodyParsed.data.resultUrl);
      const deliverable = await persistOrReject({
        storageType: "URL",
        filePath: null,
        resultUrl: bodyParsed.data.resultUrl,
        mimeType: null,
        sizeBytes: null,
        resultHash,
      });
      if (!deliverable) {
        return reply;
      }

      return reply.status(201).send({
        deliverableId: deliverable.id,
        resultHash: deliverable.resultHash,
        storedAt: deliverable.createdAt.toISOString(),
      });
    },
  );

  // T-904: metadata-only read (no file content) — public, matching this
  // codebase's existing "GET /tasks/:taskId is a public read" convention
  // (tasks/routes.ts's own doc comment). F-908's access restriction
  // (requester/accepted-Agent only) is specifically about the FILE
  // CONTENT endpoint (T-907's `GET .../latest/file`), not this metadata
  // read — design.md's F-902 says "供需求方查看" as the intended audience,
  // not a stated access restriction, and nothing here (hash, mime type,
  // size, submission timestamps) is more sensitive than what
  // `tasks.acceptedAgentAddress` already exposes publicly.
  app.get("/tasks/:taskId/deliverables/latest", async (request, reply) => {
    const paramsParsed = taskIdParamSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      return reply.status(400).send({ error: { message: paramsParsed.error.message } });
    }

    const task = await getTaskById(pool, paramsParsed.data.taskId);
    if (!task) {
      return reply.status(404).send({ error: { message: "任务不存在。" } });
    }

    const deliverable = await getLatestDeliverableForTask(pool, task.id);
    if (!deliverable) {
      return reply.status(404).send({ error: { message: "该任务尚无成果提交记录。" } });
    }

    return reply.send({
      deliverableId: deliverable.id,
      resultHash: deliverable.resultHash,
      // design.md's interface contract: `fileMeta | resultUrl` — a
      // discriminated shape mirroring `storageType`, never both keys
      // present at once (matches `deliverables_payload_matches_storage_type`'s
      // own DB-level mutual exclusivity).
      ...(deliverable.storageType === "LOCAL_FILE"
        ? { fileMeta: { mimeType: deliverable.mimeType, sizeBytes: deliverable.sizeBytes } }
        : { resultUrl: deliverable.resultUrl }),
      // Both `null` until T-905's ResultSubmitted event-sync handler
      // writes them (this route reads whatever `tasks.submitted_at`/
      // `review_deadline` currently hold — a pure passthrough, T-904 does
      // not compute or wait for either).
      submittedAt: task.submittedAt ? task.submittedAt.toISOString() : null,
      reviewDeadline: task.reviewDeadline ? task.reviewDeadline.toISOString() : null,
    });
  });

  // T-907 (F-908): the actual file CONTENT — every check `GET .../latest`
  // above skips (session required, requester/accepted-Agent only) applies
  // here, via `access-guard.ts`'s single implementation.
  app.get(
    "/tasks/:taskId/deliverables/latest/file",
    { preHandler: app.requireSession },
    async (request, reply) => {
      const paramsParsed = taskIdParamSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({ error: { message: paramsParsed.error.message } });
      }
      const sessionAddress = requireSessionAddress(request, reply);
      if (!sessionAddress) {
        return reply;
      }

      const task = await getTaskById(pool, paramsParsed.data.taskId);
      if (!task) {
        return reply.status(404).send({ error: { message: "任务不存在。" } });
      }

      if (!isAuthorizedForDeliverableAccess(task, sessionAddress)) {
        return reply
          .status(403)
          .send({ error: { message: "只有本任务的需求方或接单 Agent 才能访问成果文件。" } });
      }

      const deliverable = await getLatestDeliverableForTask(pool, task.id);
      if (!deliverable) {
        return reply.status(404).send({ error: { message: "该任务尚无成果提交记录。" } });
      }

      // URL-type deliverables were never fetched/mirrored by this backend
      // (design.md: "一期不保证外部 URL 永久可用" — no proxy download for
      // this storage type) — redirect the already-authorized caller
      // straight to the original address, matching design.md's own
      // interface contract ("302 to resultUrl（若为 URL 类型）").
      if (deliverable.storageType === "URL") {
        if (!deliverable.resultUrl) {
          throw new Error(
            `deliverable ${deliverable.id} has storageType URL but no resultUrl (schema invariant violated)`,
          );
        }
        return reply.redirect(deliverable.resultUrl, 302);
      }

      if (!deliverable.filePath) {
        throw new Error(
          `deliverable ${deliverable.id} has storageType LOCAL_FILE but no filePath (schema invariant violated)`,
        );
      }
      const buffer = await readFile(deliverable.filePath);
      return reply.type(deliverable.mimeType ?? "application/octet-stream").send(buffer);
    },
  );
}
