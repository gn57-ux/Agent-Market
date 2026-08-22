import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildApp } from "../../app.js";
import { runMigrations } from "../../db/migrate.js";
import { requireTestDatabaseUrl } from "../../db/test-support.js";
import { buildSignInMessage } from "./signInMessage.js";

// See db/migrate.integration.test.ts's header comment: skipped unless a
// human opts in with RUN_DB_INTEGRATION_TESTS=1 against a confirmed-safe
// TEST_DATABASE_URL. This suite proves AC-402 (login success, replay
// rejection, expiry rejection) end to end through the real HTTP routes,
// not just signInMessage.ts's pure signature logic in isolation.
const runIfOptedIn = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

runIfOptedIn("POST /auth/nonce, /auth/verify (integration, AC-402)", () => {
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;
  const account = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireTestDatabaseUrl() });
    await runMigrations(pool, migrationsDir);
    app = buildApp({ pool });
  });

  afterAll(async () => {
    await pool.query(
      "DROP TABLE IF EXISTS sessions, auth_nonces, users, schema_migrations CASCADE",
    );
    await pool.end();
  });

  afterEach(async () => {
    // Isolate tests from each other: each test issues its own nonce, but
    // stale rows from a prior test (e.g. a consumed/expired one for the
    // same address) shouldn't affect the next test's assertions.
    await pool.query("DELETE FROM sessions");
    await pool.query("DELETE FROM auth_nonces");
    await pool.query("DELETE FROM users");
  });

  async function requestNonce(): Promise<{ nonce: string; issuedAt: string; expiresAt: string }> {
    const response = await app.inject({
      method: "POST",
      url: "/auth/nonce",
      payload: { address: account.address },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  it("completes a full login: nonce -> sign -> verify -> session issued", async () => {
    const { nonce, issuedAt, expiresAt } = await requestNonce();
    const message = buildSignInMessage({
      domain: "localhost",
      address: account.address,
      nonce,
      issuedAt: new Date(issuedAt),
      expiresAt: new Date(expiresAt),
    });
    const signature = await account.signMessage({ message });

    const response = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { address: account.address, signature, nonce },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.address).toBe(account.address.toLowerCase());
    expect(typeof body.sessionToken).toBe("string");
    expect(body.sessionToken.length).toBeGreaterThan(0);

    const setCookie = response.headers["set-cookie"];
    expect(setCookie).toBeTruthy();
    expect(String(setCookie)).toContain("HttpOnly");
  });

  it("rejects replaying an already-consumed nonce (AC-402)", async () => {
    const { nonce, issuedAt, expiresAt } = await requestNonce();
    const message = buildSignInMessage({
      domain: "localhost",
      address: account.address,
      nonce,
      issuedAt: new Date(issuedAt),
      expiresAt: new Date(expiresAt),
    });
    const signature = await account.signMessage({ message });

    const first = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { address: account.address, signature, nonce },
    });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { address: account.address, signature, nonce },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe("WALLET_SIGNATURE_INVALID");
  });

  it("rejects a nonce that has expired (AC-402)", async () => {
    const { nonce } = await requestNonce();
    await pool.query(
      `UPDATE auth_nonces SET expires_at = now() - interval '1 second' WHERE nonce = $1`,
      [nonce],
    );

    // Signed against whatever message a client would have built from the
    // (now-expired) issuance — the point is the server rejects based on
    // its own expiry check regardless of what's signed.
    const message = buildSignInMessage({
      domain: "localhost",
      address: account.address,
      nonce,
      issuedAt: new Date(),
      expiresAt: new Date(),
    });
    const signature = await account.signMessage({ message });

    const response = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { address: account.address, signature, nonce },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("WALLET_SIGNATURE_INVALID");
  });

  it("rejects a signature that doesn't match the address (wrong wallet)", async () => {
    const { nonce, issuedAt, expiresAt } = await requestNonce();
    const message = buildSignInMessage({
      domain: "localhost",
      address: account.address,
      nonce,
      issuedAt: new Date(issuedAt),
      expiresAt: new Date(expiresAt),
    });
    const otherAccount = privateKeyToAccount(generatePrivateKey());
    const signature = await otherAccount.signMessage({ message });

    const response = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { address: account.address, signature, nonce },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("WALLET_SIGNATURE_INVALID");

    // The nonce must still be usable afterward — an invalid signature
    // attempt must not burn a legitimate client's one chance to retry.
    const retrySignature = await account.signMessage({ message });
    const retry = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { address: account.address, signature: retrySignature, nonce },
    });
    expect(retry.statusCode).toBe(200);
  });

  it("rejects verifying a nonce that was never issued", async () => {
    const message = buildSignInMessage({
      domain: "localhost",
      address: account.address,
      nonce: "never-issued-nonce",
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const signature = await account.signMessage({ message });

    const response = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { address: account.address, signature, nonce: "never-issued-nonce" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("WALLET_SIGNATURE_INVALID");
  });
});
