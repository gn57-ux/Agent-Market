import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { completeLogin } from "./completeLogin.js";
import type { IdentityProvider } from "./identity-provider.js";
import { privyVerifyRequestSchema } from "./schema.js";
import {
  SESSION_COOKIE_NAME,
  WALLET_SIGNATURE_INVALID,
  cookieShouldBeSecure,
  sessionCookiePath,
} from "./routes.js";
import { formatZodError } from "../../shared/zod-error.js";

/**
 * F-1601 (T-1601, design decision 1) — `POST /auth/verify/privy`, a
 * standalone route separate from `registerAuthRoutes`'s `/auth/verify`
 * (routes.ts). Rejected alternative (方案 B, not built): folding this into
 * `/auth/verify` behind a provider-discriminated request schema. That
 * would force the single handler to branch on proof shape
 * (`nonce+signature` vs an opaque `accessToken`) internally — reproducing,
 * one layer up, exactly the "if (provider === 'privy')" pattern the
 * `IdentityProvider` adapter boundary (T-1600, identity-provider.ts) exists
 * to avoid. A second route keeps each handler thin and provider-specific,
 * while both still funnel through the same `completeLogin`/`IdentityProvider`
 * contract — and through the exact same cookie-setting logic (imported from
 * routes.ts, not reimplemented) and the same `WALLET_SIGNATURE_INVALID`
 * failure shape, so a client cannot tell from the response alone which
 * provider it authenticated against.
 */
export function registerPrivyAuthRoutes(
  app: FastifyInstance,
  pool: Pool,
  provider: IdentityProvider,
): void {
  app.post("/auth/verify/privy", async (request, reply) => {
    const parsed = privyVerifyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { message: formatZodError(parsed.error) } });
    }
    const { address, accessToken } = parsed.data;

    // completeLogin's `nonce` parameter is SIWE-specific plumbing (it gets
    // passed straight through to `provider.completeAuth` as
    // `input.nonce`, which `PrivyIdentityProvider.completeAuth` never
    // reads — its own proof validation only looks at `input.proof`). An
    // empty string here is not a real challenge value; it's the honest
    // "this provider has no nonce" placeholder, consistent with
    // `PrivyIdentityProvider.beginAuth` never being called on this route
    // either (see that function's own doc comment).
    const result = await completeLogin(pool, provider, address, "", { accessToken });
    if (!result.ok) {
      const message =
        result.reason === "not_found"
          ? "登录令牌不存在或已失效。"
          : result.reason === "already_consumed"
            ? "登录令牌已被使用。"
            : result.reason === "expired"
              ? "登录令牌已过期。"
              : "登录令牌无效或与声明地址不匹配。";
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
}
