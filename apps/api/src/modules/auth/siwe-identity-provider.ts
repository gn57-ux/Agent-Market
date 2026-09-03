import { z } from "zod";
import type { Pool } from "pg";
import type { Queryable } from "../../db/pool.js";
import { consumeNonce, getActiveNonce, issueNonce, normalizeAddress } from "./nonce.store.js";
import { buildSignInMessage, verifySignInSignature } from "./signInMessage.js";
import type { AuthChallenge, CompleteAuthResult, IdentityProvider } from "./identity-provider.js";

const SIWE_PROOF_SCHEMA = z.object({ signature: z.string().regex(/^0x[0-9a-fA-F]+$/) });

/** Domain field embedded in the sign-in message (F-404, design.md) — an
 * anti-phishing binding (the same purpose EIP-4361's `domain` field
 * serves), not secret. Moved here from routes.ts (T-1600): this is a SIWE
 * concept specifically, not something a route handler that's meant to stay
 * provider-agnostic should know about. */
function authDomain(env: NodeJS.ProcessEnv): string {
  return env.AUTH_DOMAIN ?? "localhost";
}

/**
 * F-1601's default `IdentityProvider` implementation — the existing SIWE
 * flow (previously inlined directly in routes.ts/completeLogin.ts),
 * unchanged in behavior, now behind the adapter interface. Two-phase check
 * preserved exactly as it was: look up the still-active nonce (without
 * consuming it) BEFORE verifying the signature, so an invalid-signature
 * attempt doesn't cost a legitimate client its one real attempt; only
 * consume the nonce after a valid signature is confirmed.
 */
export function createSiweIdentityProvider(env: NodeJS.ProcessEnv = process.env): IdentityProvider {
  return {
    async beginAuth(pool: Pool, address: string): Promise<AuthChallenge> {
      const issued = await issueNonce(pool, address);
      return issued;
    },

    async completeAuth(client: Queryable, input): Promise<CompleteAuthResult> {
      const parsedProof = SIWE_PROOF_SCHEMA.safeParse(input.proof);
      if (!parsedProof.success) {
        return { ok: false, reason: "invalid_proof" };
      }

      const active = await getActiveNonce(client, input.address, input.nonce);
      if (!active) {
        return { ok: false, reason: "not_found" };
      }

      const message = buildSignInMessage({
        domain: authDomain(env),
        address: input.address,
        nonce: input.nonce,
        issuedAt: active.issuedAt,
        expiresAt: active.expiresAt,
      });
      const validSignature = await verifySignInSignature({
        address: input.address,
        message,
        signature: parsedProof.data.signature as `0x${string}`,
      });
      if (!validSignature) {
        return { ok: false, reason: "invalid_proof" };
      }

      const consumed = await consumeNonce(client, input.address, input.nonce);
      if (!consumed.ok) {
        return { ok: false, reason: consumed.reason };
      }

      return { ok: true, result: { address: normalizeAddress(input.address) } };
    },
  };
}
