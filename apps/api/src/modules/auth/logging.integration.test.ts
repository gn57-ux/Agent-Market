import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "../../db/test-support.js";
import { buildSignInMessage } from "./signInMessage.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL.
//
// AC-405 ("审查日志确认无签名原文、无私钥、无 JWT 明文长期留存", T-406): this makes
// that review an automated, permanent check instead of a one-time manual
// read — it captures the REAL pino output Fastify's default request/
// response logging produces for a live /auth/verify + /auth/logout round
// trip, and asserts the signature, nonce, and session token never appear
// in it. Confirmed empirically before writing this test (see T-406's
// commit message) that Fastify's default `req`/`res` serializers only
// include method/url/hostname/remoteAddress/remotePort/statusCode — never
// the request body or response body — so this is expected to pass;
// asserting it here means a future change to logging config (e.g.
// something that starts logging request bodies for debugging) gets
// caught, not silently reintroduced.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

runIfOptedIn(
  "request logging never contains signatures, nonces, or session tokens (AC-405)",
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireTestDatabaseUrl() });
      await runMigrations(pool, migrationsDir);
    });

    afterAll(async () => {
      await pool.query(
        "DROP TABLE IF EXISTS sessions, auth_nonces, users, schema_migrations CASCADE",
      );
      await pool.end();
    });

    it("keeps the signature, nonce, and session token out of a full login+logout round trip's logs", async () => {
      const captured: Buffer[] = [];
      const captureStream = new PassThrough();
      captureStream.on("data", (chunk: Buffer) => captured.push(chunk));

      const app = buildApp({ pool, logger: { stream: captureStream, level: "trace" } });

      const account = privateKeyToAccount(generatePrivateKey());

      const nonceResponse = await app.inject({
        method: "POST",
        url: "/auth/nonce",
        payload: { address: account.address },
      });
      const { nonce, issuedAt, expiresAt } = nonceResponse.json();

      const message = buildSignInMessage({
        domain: "localhost",
        address: account.address,
        nonce,
        issuedAt: new Date(issuedAt),
        expiresAt: new Date(expiresAt),
      });
      const signature = await account.signMessage({ message });

      const verifyResponse = await app.inject({
        method: "POST",
        url: "/auth/verify",
        payload: { address: account.address, signature, nonce },
      });
      const { sessionToken } = verifyResponse.json();

      await app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: { cookie: `session_token=${sessionToken}` },
      });

      await app.close();
      const logText = Buffer.concat(captured).toString("utf8");

      expect(logText.length).toBeGreaterThan(0); // sanity: something was actually captured
      expect(logText).not.toContain(signature);
      expect(logText).not.toContain(nonce);
      expect(logText).not.toContain(sessionToken);
    });
  },
);
