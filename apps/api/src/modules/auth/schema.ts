import { z } from "zod";

const ETH_ADDRESS_SCHEMA = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "不是合法的以太坊地址");

export const nonceRequestSchema = z.object({
  address: ETH_ADDRESS_SCHEMA,
});

export const verifyRequestSchema = z.object({
  address: ETH_ADDRESS_SCHEMA,
  signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/, "不是合法的十六进制签名")
    .transform((value) => value as `0x${string}`),
  nonce: z.string().min(1, "nonce 不能为空"),
});

// F-1601 (T-1601, design decision 2) — POST /auth/verify/privy's request
// shape. Deliberately a separate schema (and separate route, see
// privy-routes.ts) rather than folding into `verifyRequestSchema`: unlike
// SIWE's nonce+signature challenge-response, Privy's proof is an
// already-issued opaque access token — there is no `signature`/`nonce` to
// validate here, `PrivyIdentityProvider.completeAuth` does its own
// deeper validation of `accessToken`'s contents (schema-level, this only
// enforces "some non-empty string was submitted").
export const privyVerifyRequestSchema = z.object({
  address: ETH_ADDRESS_SCHEMA,
  accessToken: z.string().min(1, "accessToken 不能为空"),
});
