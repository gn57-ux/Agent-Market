import type { ErrorCode } from "@agent-market/domain";
import type { CookieSerializeOptions } from "@fastify/cookie";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { completeLogin } from "./completeLogin.js";
import type { IdentityProvider } from "./identity-provider.js";
import { nonceRequestSchema, verifyRequestSchema } from "./schema.js";
import { revokeSession } from "./session.service.js";
import { formatZodError } from "../../shared/zod-error.js";

// Exported (F-1601/T-1601): privy-routes.ts's /auth/verify/privy reuses
// this cookie name and the two helpers below verbatim rather than
// reimplementing them — decision 2 requires its set-cookie logic to be
// identical to /auth/verify's, not a parallel copy that could drift. The
// four existing route handlers below are otherwise byte-for-byte
// unchanged (AC-1601 non-regression).
export const SESSION_COOKIE_NAME = "session_token";

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
export function cookieShouldBeSecure(): boolean {
  return process.env.COOKIE_INSECURE_LOCAL_DEV !== "1";
}

/** `path` must match between `setCookie` and `clearCookie` for the browser
 * to actually recognize them as the same cookie — shared here so
 * `/auth/logout` can't drift from `/auth/verify`'s own setCookie call. */
export function sessionCookiePath(): Pick<CookieSerializeOptions, "path"> {
  return { path: "/" };
}

// Typed against @agent-market/domain's ErrorCode (the PRD §11.4 single
// source of truth for domain error codes) so a rename/removal there fails
// this file to typecheck rather than silently drifting. Basic request-shape
// validation failures (missing/malformed fields) are a plain 400 with the
// Zod issue text, not one of these codes — malformed input isn't a domain
// error, and PRD §11.4's table doesn't define a generic one for it.
export const WALLET_SIGNATURE_INVALID: ErrorCode = "WALLET_SIGNATURE_INVALID";

/**
 * Registers the full F-404/F-405 auth route surface: `/auth/nonce`,
 * `/auth/verify` (login), and `/auth/logout` (session revocation). The
 * session-validating middleware other Features (5-10) attach to their own
 * protected routes is registered separately — see
 * `session.middleware.ts`'s `registerSessionMiddleware`.
 */
export function registerAuthRoutes(
  app: FastifyInstance,
  pool: Pool,
  provider: IdentityProvider,
): void {
  app.post("/auth/nonce", async (request, reply) => {
    const parsed = nonceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(parsed.error) } });
    }

    const issued = await provider.beginAuth(pool, parsed.data.address);
    return reply.send({
      nonce: issued.nonce,
      issuedAt: issued.issuedAt.toISOString(),
      expiresAt: issued.expiresAt.toISOString(),
    });
  });

  // F-1601 (T-1600): this specific route stays SIWE-shaped — `verifyRequestSchema`
  // below still requires `address`+`signature`+`nonce`, and always builds
  // `proof` as `{ signature }`. That's a real, honest limit of the
  // adapter boundary, not an oversight: `completeLogin`'s own dependency
  // on `IdentityProvider` (not `SiweIdentityProvider` directly) is what
  // makes F-1603's rollback possible (swap the composition root's default
  // provider), but a wire-compatible provider swap on THIS SAME route
  // only works for providers that also speak nonce+signature. Privy's real
  // flow (T-1601) verifies an already-issued access token, not a
  // nonce/signature challenge-response, and reviewing code (N4, real
  // finding) correctly caught an earlier version of this comment
  // overclaiming that this handler "no longer knows or cares" about the
  // proof shape — it does, deliberately, until T-1601 decides whether
  // Privy gets its own route or this one grows a provider-selected
  // request schema. Not solved here: no real second provider shape exists
  // yet to design a generic contract against (T-1610's ADR/threat-model
  // docs must land before T-1601 can even start).
  app.post("/auth/verify", async (request, reply) => {
    const parsed = verifyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(parsed.error) } });
    }
    const { address, signature, nonce } = parsed.data;

    // completeLogin verifies the proof (via `provider`), records the
    // login, and issues the session all in one transaction. Every `!ok`
    // branch below maps to the SAME WALLET_SIGNATURE_INVALID code Feature
    // 4's existing tests already assert on (AC-1601) — the `reason` only
    // changes the human-readable message, never the contract.
    const result = await completeLogin(pool, provider, address, nonce, { signature });
    if (!result.ok) {
      const message =
        result.reason === "not_found"
          ? "nonce 不存在、已被使用或已过期。"
          : result.reason === "already_consumed"
            ? "nonce 已被使用。"
            : result.reason === "expired"
              ? "nonce 已过期。"
              : "签名与预期消息不匹配。";
      return reply.status(401).send({ error: { code: WALLET_SIGNATURE_INVALID, message } });
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

  // Task E manual verification: a page refresh wiped the frontend's
  // in-memory "signed in" state even though the httpOnly session cookie was
  // still valid server-side, forcing a re-signature for no real reason.
  // Reuses `app.requireSession` (the same preHandler every protected route
  // in Feature 5-10 already attaches) instead of duplicating "is this cookie
  // valid" here — a 401 with the existing message is already exactly right
  // for "no session (or it's expired/revoked)", so there is nothing left for
  // this handler to do beyond echoing back the address requireSession
  // already resolved.
  app.get("/auth/session", { preHandler: app.requireSession }, async (request, reply) => {
    return reply.send({ address: request.address });
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
