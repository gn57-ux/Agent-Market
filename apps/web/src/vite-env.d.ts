/// <reference types="vite/client" />

// Typed surface for the VITE_-prefixed variables this app actually reads
// (see .env.example). Keeps `import.meta.env.VITE_X` typo-safe instead of
// falling back to vite/client's default `any`-ish ImportMetaEnv.
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** Must match apps/api's AUTH_DOMAIN (defaults to "localhost" on both
   * sides) — embedded in the sign-in message the wallet signs; a mismatch
   * makes every login attempt fail signature verification. See
   * features/session/signInMessage.ts. */
  readonly VITE_AUTH_DOMAIN?: string;
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_WALLET_RPC_URL?: string;
  readonly VITE_DISPATCH_API_BASE_URL?: string;
  readonly VITE_TASK_ESCROW_ADDRESS?: string;
  readonly VITE_YD_TOKEN_ADDRESS?: string;
  readonly VITE_YD_FAUCET_ADDRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
