import type { ErrorCode } from "@agent-market/domain";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { getActiveNonce, consumeNonce, issueNonce } from "./nonce.store.js";
import { nonceRequestSchema, verifyRequestSchema } from "./schema.js";
import { buildSignInMessage, verifySignInSignature } from "./signInMessage.js";
import { issueSession } from "./session.service.js";
import { recordLogin } from "./users.store.js";

/** Domain field embedded in the sign-in message (F-404, design.md). Not
 * secret, just an anti-phishing binding (the same purpose EIP-4361's
 * `domain` field serves) — a signature produced for a different domain's
 * challenge won't match this one's reconstructed message. No dedicated
 * `.env.example` default beyond "localhost" is meaningful before a real
 * deployment domain exists; revisit when this ships behind a real host. */
function authDomain(): string {
  return process.env.AUTH_DOMAIN ?? "localhost";
}

// Typed against @agent-market/domain's ErrorCode (the PRD §11.4 single
// source of truth for domain error codes) so a rename/removal there fails
// this file to typecheck rather than silently drifting. Basic request-shape
// validation failures (missing/malformed fields) are a plain 400 with the
// Zod issue text, not one of these codes — malformed input isn't a domain
// error, and PRD §11.4's table doesn't define a generic one for it.
const WALLET_SIGNATURE_INVALID: ErrorCode = "WALLET_SIGNATURE_INVALID";

/**
 * Registers F-404's two login-flow routes. `/auth/logout` + the
 * session-validating middleware other Features will use is T-405's scope,
 * not this Task's — see session.service.ts's doc comment for why issuing a
 * session doesn't require having built revocation/verification yet.
 */
export function registerAuthRoutes(app: FastifyInstance, pool: Pool): void {
  app.post("/auth/nonce", async (request, reply) => {
    const parsed = nonceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: parsed.error.message } });
    }

    const issued = await issueNonce(pool, parsed.data.address);
    return reply.send({
      nonce: issued.nonce,
      issuedAt: issued.issuedAt.toISOString(),
      expiresAt: issued.expiresAt.toISOString(),
    });
  });

  app.post("/auth/verify", async (request, reply) => {
    const parsed = verifyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: parsed.error.message } });
    }
    const { address, signature, nonce } = parsed.data;

    // Must look up (not consume) first: verifying the signature has to
    // happen before the nonce is burned, so an invalid-signature attempt
    // doesn't cost a legitimate client its one chance to retry (see
    // getActiveNonce's doc comment).
    const active = await getActiveNonce(pool, address, nonce);
    if (!active) {
      return reply.status(401).send({
        error: {
          code: WALLET_SIGNATURE_INVALID,
          message: "Nonce not found, already used, or expired.",
        },
      });
    }

    const message = buildSignInMessage({
      domain: authDomain(),
      address,
      nonce,
      issuedAt: active.issuedAt,
      expiresAt: active.expiresAt,
    });
    const validSignature = await verifySignInSignature({ address, message, signature });
    if (!validSignature) {
      return reply.status(401).send({
        error: {
          code: WALLET_SIGNATURE_INVALID,
          message: "Signature does not match the expected message.",
        },
      });
    }

    // Atomic one-time-use enforcement: a concurrent /auth/verify for the
    // same nonce could have consumed it between the lookup above and here
    // (e.g. two requests racing with the same replayed valid signature);
    // consumeNonce's UPDATE ... WHERE consumed = false is what actually
    // guarantees only one of them wins.
    const consumed = await consumeNonce(pool, address, nonce);
    if (!consumed.ok) {
      return reply.status(401).send({
        error: { code: WALLET_SIGNATURE_INVALID, message: "Nonce was already used." },
      });
    }

    await recordLogin(pool, address);
    const session = await issueSession(pool, address);

    reply.setCookie("session_token", session.token, {
      httpOnly: true,
      // Codex review (T-404 P2): without `secure`, a bearer-token cookie
      // could still be sent over a plain HTTP request to the same host
      // even when the deployment is normally HTTPS (a downgrade/legacy
      // request), leaking it in transit. `NODE_ENV` gates this rather than
      // hardcoding `true` because local dev (`pnpm dev`) runs the API over
      // plain HTTP, where a `secure` cookie would never be sent back at
      // all — this is not a security relaxation, `secure` protects the
      // cookie in transit and local dev has no such transit to protect.
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: session.expiresAt,
    });
    return reply.send({ sessionToken: session.token, address: session.address });
  });
}
