export interface SignInMessageFields {
  domain: string;
  address: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}

/**
 * Frontend twin of `apps/api/src/modules/auth/signInMessage.ts`'s
 * `buildSignInMessage` — must stay byte-for-byte identical (field order,
 * literal strings, ISO timestamp formatting), or a wallet signature
 * produced here will never verify against what the server reconstructs
 * from the same nonce/issuedAt/expiresAt. That file's own doc comment:
 * "a client reconstructs the identical string to sign only if it uses the
 * exact values the nonce endpoint returned."
 *
 * Not imported from `apps/api` directly (there's no shared package that
 * spans both apps for auth-protocol text, and Feature 4's
 * `app.requireSession` interface freeze doesn't cover this template) —
 * duplicating this ~6-line pure function here keeps Feature 5
 * self-contained rather than reopening Feature 4's already-shipped code.
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
