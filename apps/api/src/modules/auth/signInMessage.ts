import { recoverMessageAddress } from "viem";

export interface SignInMessageFields {
  domain: string;
  address: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}

/**
 * Builds the canonical plain-text message the wallet signs to log in
 * (F-404, design.md: "签名消息模板包含：域名、钱包地址、nonce、签发时间、过期时间
 * （对齐 EIP-4361 风格，不引入完整库依赖时也需覆盖同等字段）"). Deliberately a plain
 * template, not the full `siwe` package's EIP-4361 parser/validator — this
 * project doesn't need SIWE's broader feature set (chain-id-aware multi-app
 * session negotiation, statement/resources fields) for a single first-party
 * frontend, and pulling in a library only to reproduce five fields this
 * function already covers isn't proportionate (CLAUDE.md 原则: 复杂度必须下沉
 * 到合适的模块, not imported wholesale for unused surface area).
 *
 * This exact field order/formatting is the single source of truth for what
 * a client must sign — `/auth/nonce`'s issuedAt/expiresAt (and nonce) get
 * threaded straight into this by routes.ts, so a client reconstructs the
 * identical string to sign only if it uses the exact values the nonce
 * endpoint returned.
 */
export function buildSignInMessage(fields: SignInMessageFields): string {
  return [
    `${fields.domain} wants you to sign in with your Ethereum account:`,
    fields.address,
    "",
    "Nonce: " + fields.nonce,
    "Issued At: " + fields.issuedAt.toISOString(),
    "Expiration Time: " + fields.expiresAt.toISOString(),
  ].join("\n");
}

export interface VerifySignInSignatureParams {
  address: string;
  message: string;
  signature: `0x${string}`;
}

/**
 * Verifies an EIP-191 `personal_sign` signature (what MetaMask's
 * `eth_requestAccounts`-connected wallet produces, and what T-401's
 * `WalletProvider` already assumes elsewhere) recovers to `address`.
 * Returns `false` rather than throwing on a malformed signature — callers
 * (routes.ts) treat "couldn't verify" and "verified as the wrong address"
 * identically (both map to `WALLET_SIGNATURE_INVALID`), so there's no
 * reason to force them to also handle a thrown exception for the same
 * outcome.
 *
 * Only plain EOA signatures are supported (`recoverMessageAddress` does
 * local ECDSA recovery, no RPC call) — ERC-1271/6492 smart-contract-wallet
 * signature verification is out of scope for stage one (not something
 * T-401's WalletProvider issues in the first place).
 */
export async function verifySignInSignature({
  address,
  message,
  signature,
}: VerifySignInSignatureParams): Promise<boolean> {
  try {
    const recovered = await recoverMessageAddress({ message, signature });
    return recovered.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}
