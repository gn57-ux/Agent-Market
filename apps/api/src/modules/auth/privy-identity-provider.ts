import { createHash, randomBytes } from "node:crypto";
import { PrivyClient, type User } from "@privy-io/server-auth";
import { z } from "zod";
import type { Pool } from "pg";
import type { Queryable } from "../../db/pool.js";
import { normalizeAddress, InvalidAddressError } from "./nonce.store.js";
import type { AuthChallenge, CompleteAuthResult, IdentityProvider } from "./identity-provider.js";

/**
 * N4 round-1 real finding (T-1601, P1): without this, any still-valid Privy
 * access token could be redeemed into an unlimited number of application
 * sessions via repeated `POST /auth/verify/privy` calls — nothing tracked
 * "this specific token has already been exchanged". Mirrors
 * `nonce.store.ts`'s `consumeNonce` (single atomic statement, race-safe via
 * Postgres row-level locking — two concurrent requests for the same token
 * can both attempt the INSERT, but only one gets a row back), except this
 * is an INSERT rather than an UPDATE: unlike a SIWE nonce (which this
 * project issues, so a row already exists to flip), a Privy token is
 * issued by Privy — the FIRST successful verification is what creates the
 * "consumed" record, not something pre-provisioned.
 *
 * Keyed on a SHA-256 hash of the raw token, never the token itself — this
 * project's hard constraint (`docs/security/privy-embedded-wallet-key-
 * management.md`) is that no credential/token material is ever persisted
 * in the business database; a hash is sufficient to detect reuse without
 * being reversible to the original token.
 */
export async function consumePrivyAccessToken(
  client: Queryable,
  accessToken: string,
): Promise<{ ok: true } | { ok: false; reason: "already_consumed" }> {
  const tokenHash = createHash("sha256").update(accessToken).digest("hex");
  const { rows } = await client.query<{ token_hash: string }>(
    `INSERT INTO consumed_privy_tokens (token_hash) VALUES ($1)
     ON CONFLICT (token_hash) DO NOTHING
     RETURNING token_hash`,
    [tokenHash],
  );
  return rows.length > 0 ? { ok: true } : { ok: false, reason: "already_consumed" };
}

const PRIVY_PROOF_SCHEMA = z.object({ accessToken: z.string().min(1) });

/** Opaque-nonce validity window for `beginAuth`'s contract-only stub (see
 * its doc comment below) — short because nothing ever actually checks it
 * server-side; it only has to be a plausible `expiresAt` for callers that
 * inspect the `AuthChallenge` shape. */
const STUB_CHALLENGE_TTL_MS = 5 * 60 * 1000;

type LinkedAccount = User["linkedAccounts"][number];
type PrivyEmbeddedWallet = Extract<LinkedAccount, { type: "wallet" }>;

/**
 * Identifies a linked account that is (a) an on-chain wallet, (b) Privy's
 * own embedded wallet specifically — not an external wallet (MetaMask,
 * Rainbow, ...) the same Privy user happens to have separately linked,
 * distinguished by `walletClientType === "privy"` per the installed
 * @privy-io/server-auth 1.32.5 type declarations' own doc comment on
 * `Wallet.walletClientType` ("If the value is `privy`, then this is a
 * privy embedded wallet") — and (c) an Ethereum-family address, since this
 * project's `ETH_ADDRESS_SCHEMA` (schema.ts) and `normalizeAddress`
 * (nonce.store.ts) only ever accept `0x`-prefixed 40-hex-char addresses;
 * Privy also supports Solana embedded wallets, which are out of scope for
 * this project's single-chain address model.
 */
function isPrivyEmbeddedEthereumWallet(account: LinkedAccount): account is PrivyEmbeddedWallet {
  return (
    account.type === "wallet" &&
    account.walletClientType === "privy" &&
    account.chainType === "ethereum"
  );
}

/**
 * F-1601 (T-1601) — the Privy `IdentityProvider` implementation (design.md
 * 决策 1, 方案 A / this Feature's design decisions 1-3). Reads
 * `PRIVY_APP_ID`/`PRIVY_APP_SECRET` directly from `env` (decision 4 —
 * platform-level env vars, same pattern as `BACKEND_RPC_URL`/
 * `ACCEPTANCE_PERMIT_SIGNER_KEY`; NOT the Agent-specific `env://` credential
 * reference format in `credential.ts`, which only parses a single Agent's
 * UUID-keyed reference and cannot represent a platform-wide credential —
 * see `docs/security/privy-embedded-wallet-key-management.md`).
 *
 * Returns `undefined` when either credential is missing so the composition
 * root (`app.ts`) can skip registering `/auth/verify/privy` entirely
 * instead of crashing startup — an environment with no Privy credentials
 * configured (e.g. a contributor's local `.env` that only sets up SIWE)
 * must still be able to run the rest of the system, including the
 * long-term-coexisting SIWE login path (ADR-0002's "failure conditions").
 */
export function createPrivyIdentityProvider(
  env: NodeJS.ProcessEnv = process.env,
): IdentityProvider | undefined {
  const appId = env.PRIVY_APP_ID;
  const appSecret = env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) {
    return undefined;
  }
  const client = new PrivyClient(appId, appSecret);

  return {
    /**
     * Privy's real login flow never calls this: the login challenge (if
     * any — Privy's own frontend SDK handles the user-facing auth
     * challenge itself, e.g. an email/SMS code or an external-wallet
     * signature request) is entirely between the user's browser and
     * Privy's infrastructure, and this project's backend is not a party
     * to it. This stub exists ONLY so `PrivyIdentityProvider` satisfies
     * the full `IdentityProvider` interface for T-1600's contract tests
     * (a static contract, not a route any client actually hits) —
     * `/auth/verify/privy` (privy-routes.ts) is a standalone route that
     * never calls `provider.beginAuth`, unlike `/auth/nonce` +
     * `/auth/verify`'s two-step SIWE flow. Deliberately does not touch the
     * database (unlike SIWE's `issueNonce`, whose persisted, one-time
     * challenge this project's own `/auth/verify` later looks up and
     * consumes) — a Privy access token isn't tied to any nonce this
     * project ever issues, so persisting one here would be dead state
     * nothing ever reads.
     */
    async beginAuth(_pool: Pool, address: string): Promise<AuthChallenge> {
      const issuedAt = new Date();
      return {
        address: normalizeAddress(address),
        nonce: randomBytes(32).toString("hex"),
        issuedAt,
        expiresAt: new Date(issuedAt.getTime() + STUB_CHALLENGE_TTL_MS),
      };
    },

    /**
     * The real verification logic (design decision 3, threat-model risk
     * "后端接受了前端提交的 Privy 访问令牌...未真实验证...就信任其中的地址声明"):
     *
     * 1. Parse `input.proof` as `{ accessToken: string }`.
     * 2. `client.verifyAuthToken` — a REAL call into @privy-io/server-auth
     *    that checks the token's signature and expiry against Privy's
     *    verification key (fetched/cached by the SDK). Any rejection
     *    (expired, malformed, wrong signature, wrong app) throws; caught
     *    below and mapped to `invalid_proof`.
     * 3. **Single-use consumption** (N4 round-1 P1 fix): atomically insert
     *    a hash of the token into `consumed_privy_tokens` — the same table
     *    a second exchange attempt of this exact token will find already
     *    occupied. Placed here, immediately after the token is confirmed
     *    cryptographically valid but BEFORE the user/address lookup below,
     *    so this is the earliest point a valid-but-already-used token can
     *    be rejected, and so a mismatched-address attempt (see step 4)
     *    with a DIFFERENT token never gets blocked by this check.
     * 4. `client.getUserById` — a REAL call to Privy's user-lookup API to
     *    resolve the verified `userId` (Privy DID, from step 2's claims)
     *    to the user's linked accounts, including their embedded wallet
     *    address. This second call is NOT optional: verified against the
     *    installed SDK's own type declarations
     *    (dist/dts/public-*.d.ts), `verifyAuthToken`'s return type
     *    `AuthTokenClaims` is `{ appId, issuer, issuedAt, expiration,
     *    sessionId, userId }` — it carries no wallet address at all, so
     *    decision 3 step 3's "skip the extra lookup if verify already
     *    returns a trusted address" case does not apply here; the address
     *    genuinely cannot be known without this second, real query. (An
     *    alternative that avoids the extra call — `getUser({ idToken })`,
     *    which decodes Privy's richer identity-token JWT locally without
     *    hitting Privy's rate-limited-by-the-SDK's-own-doc-comment
     *    `getUserById` path — would require the frontend to submit an
     *    `idToken` instead of an `accessToken`; decision 2's wire contract
     *    is fixed to `accessToken`, so that optimization is out of this
     *    task's scope, not overlooked.)
     * 5. Find the user's Privy embedded Ethereum wallet among
     *    `linkedAccounts` (NOT `user.wallet`, which is merely "the user's
     *    most recently linked wallet" and could be an external wallet the
     *    same Privy account separately linked) and compare it — case-
     *    insensitively, via the same `normalizeAddress` this project's
     *    SIWE path already uses — against `input.address` (the address the
     *    CLIENT claims). Any mismatch, or no embedded wallet found at all,
     *    is `invalid_proof`: this is the concrete test point for "客户端
     *    声称任意地址，服务端不核实".
     * 6. Only on every check passing does this return `{ok:true}`, and
     *    strictly `{ address }` — no other field of the Privy `User`
     *    object (which could otherwise carry email/OAuth/other linked
     *    accounts, none of which belong outside this function) ever
     *    escapes this boundary. See privy-identity-provider.integration.test.ts's
     *    `Object.keys()` assertion (same pattern as
     *    siwe-identity-provider.integration.test.ts) for the real runtime
     *    check of this, not just a TypeScript-compile-time one.
     *
     * The Privy access token itself is never logged, never persisted, and
     * never appears in this function's return value — its lifecycle ends
     * inside this function (threat-model risk "公共 API 响应体/错误信息/日志
     * 意外包含 Privy 原始 token").
     */
    async completeAuth(dbClient: Queryable, input): Promise<CompleteAuthResult> {
      const parsedProof = PRIVY_PROOF_SCHEMA.safeParse(input.proof);
      if (!parsedProof.success) {
        return { ok: false, reason: "invalid_proof" };
      }

      let userId: string;
      try {
        const claims = await client.verifyAuthToken(parsedProof.data.accessToken);
        userId = claims.userId;
      } catch {
        // Deliberately not re-thrown, and deliberately not logged with any
        // detail of the error: a Privy SDK error for an invalid/expired
        // token can legitimately embed the token or fragments of it in its
        // message (as many HTTP-client error paths do) — swallowing it
        // here (rather than at some outer error handler that might log
        // `error.message`) is this function's real enforcement of "Privy
        // token 绝不出现在日志输出" for the rejection path, not just the
        // success path.
        return { ok: false, reason: "invalid_proof" };
      }

      const consumed = await consumePrivyAccessToken(dbClient, parsedProof.data.accessToken);
      if (!consumed.ok) {
        return { ok: false, reason: consumed.reason };
      }

      let user: User;
      try {
        user = await client.getUserById(userId);
      } catch {
        return { ok: false, reason: "invalid_proof" };
      }

      const embeddedWallet = user.linkedAccounts.find(isPrivyEmbeddedEthereumWallet);
      if (!embeddedWallet) {
        return { ok: false, reason: "invalid_proof" };
      }

      let authoritativeAddress: string;
      let claimedAddress: string;
      try {
        authoritativeAddress = normalizeAddress(embeddedWallet.address);
        claimedAddress = normalizeAddress(input.address);
      } catch (error) {
        if (error instanceof InvalidAddressError) {
          return { ok: false, reason: "invalid_proof" };
        }
        throw error;
      }

      if (authoritativeAddress !== claimedAddress) {
        return { ok: false, reason: "invalid_proof" };
      }

      return { ok: true, result: { address: authoritativeAddress } };
    },
  };
}
