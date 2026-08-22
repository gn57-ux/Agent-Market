import type { ErrorCode } from "@agent-market/domain";
import type { CookieSerializeOptions } from "@fastify/cookie";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { completeLogin } from "./completeLogin.js";
import { getActiveNonce, issueNonce } from "./nonce.store.js";
import { nonceRequestSchema, verifyRequestSchema } from "./schema.js";
import { buildSignInMessage, verifySignInSignature } from "./signInMessage.js";
import { revokeSession } from "./session.service.js";

const SESSION_COOKIE_NAME = "session_token";

/** Domain field embedded in the sign-in message (F-404, design.md). Not
 * secret, just an anti-phishing binding (the same purpose EIP-4361's
 * `domain` field serves) — a signature produced for a different domain's
 * challenge won't match this one's reconstructed message. No dedicated
 * `.env.example` default beyond "localhost" is meaningful before a real
 * deployment domain exists; revisit when this ships behind a real host. */
function authDomain(): string {
  return process.env.AUTH_DOMAIN ?? "localhost";
}

/**
 * Whether the session cookie should carry `Secure`. Codex review (T-404
 * round 2, P1): gating this on `NODE_ENV === "production"` was fragile —
 * nothing in this project's `start` script or `.env.example` actually sets
 * `NODE_ENV`, so a real deployment run the normal way would silently ship
 * an insecure cookie. Inverted to fail safe: `Secure` is ON by default,
 * and only OFF when `COOKIE_INSECURE_LOCAL_DEV=1` is explicitly set — which
 * is what local dev's own `.env.example` sets, since `pnpm dev` runs the
 * API over plain HTTP (where a `Secure` cookie would never be sent back at
 * all; this is not a relaxation, there's no transit to protect locally). A
 * misconfigured/unconfigured real deployment now defaults to secure rather
 * than to insecure.
 */
function cookieShouldBeSecure(): boolean {
  return process.env.COOKIE_INSECURE_LOCAL_DEV !== "1";
}

/** `path` must match between `setCookie` and `clearCookie` for the browser
 * to actually recognize them as the same cookie — shared here so
 * `/auth/logout` can't drift from `/auth/verify`'s own setCookie call. */
function sessionCookiePath(): Pick<CookieSerializeOptions, "path"> {
  return { path: "/" };
}

// Typed against @agent-market/domain's ErrorCode (the PRD §11.4 single
// source of truth for domain error codes) so a rename/removal there fails
// this file to typecheck rather than silently drifting. Basic request-shape
// validation failures (missing/malformed fields) are a plain 400 with the
// Zod issue text, not one of these codes — malformed input isn't a domain
// error, and PRD §11.4's table doesn't define a generic one for it.
const WALLET_SIGNATURE_INVALID: ErrorCode = "WALLET_SIGNATURE_INVALID";

/**
 * Registers the full F-404/F-405 auth route surface: `/auth/nonce`,
 * `/auth/verify` (login), and `/auth/logout` (session revocation). The
 * session-validating middleware other Features (5-10) attach to their own
 * protected routes is registered separately — see
 * `session.middleware.ts`'s `registerSessionMiddleware`.
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

    // Atomic one-time-use enforcement + session issuance: a concurrent
    // /auth/verify for the same nonce could have consumed it between the
    // lookup above and here (e.g. two requests racing with the same
    // replayed valid signature) — completeLogin's UPDATE ... WHERE
    // consumed = false is what actually guarantees only one of them wins.
    // Consuming the nonce, recording the login, and issuing the session all
    // happen in one transaction (Codex review, T-404 round 2, P2), so a
    // failure issuing the session doesn't leave the nonce burned with no
    // session to show for it.
    const result = await completeLogin(pool, address, nonce);
    if (!result.ok) {
      return reply.status(401).send({
        error: { code: WALLET_SIGNATURE_INVALID, message: "Nonce was already used." },
      });
    }
    const session = result.session;

    reply.setCookie(SESSION_COOKIE_NAME, session.token, {
      httpOnly: true,
      secure: cookieShouldBeSecure(),
      sameSite: "lax",
      ...sessionCookiePath(),
      expires: session.expiresAt,
    });
    return reply.send({ sessionToken: session.token, address: session.address });
  });

  app.post("/auth/logout", async (request, reply) => {
    // Idempotent by design (see revokeSession's doc comment): logging out
    // with no cookie, an already-expired cookie, or an already-revoked one
    // all end at the same place — "this session cannot be used again" is
    // already true, so there's nothing to branch on or fail here.
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (token) {
      await revokeSession(pool, token);
    }
    reply.clearCookie(SESSION_COOKIE_NAME, sessionCookiePath());
    return reply.send({ ok: true });
  });
}
