import {
  GetSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { Pool } from "pg";

/**
 * T-2301 (Feature 23, F-2303): the single owner of "which environment
 * variables this system treats as secrets" (CLAUDE.md 原则 6) — every real
 * credential this codebase reads (permit signer key, Privy app secret,
 * database connection string, object-storage credentials) is listed here
 * exactly once, instead of each consuming module separately deciding
 * whether its own env var is sensitive.
 *
 * Split into required vs optional (N4 real finding, round 2, T-2301, P1):
 * a single flat list made every name a hard startup dependency once
 * `SECRETS_PROVIDER=aws-secrets-manager` was set, even for deployments
 * that don't use the feature the name belongs to — Privy disabled (existing
 * graceful-degradation behavior, `app.ts`'s own "Privy identity provider
 * not configured" path), local (not S3) deliverable storage, or S3 access
 * meant to come from an IAM role rather than static keys (`storage.s3.ts`'s
 * own default-credential-chain fallback, which this would have defeated by
 * forcing a value to exist). REQUIRED matches names `server.ts`'s existing
 * startup gates (`verifyStartupSignerConfig`, `resolveChainConfig`) already
 * treat as hard-required with or without this Task — this module doesn't
 * invent new mandatoriness, it only sources the existing mandatory ones
 * from Secrets Manager instead of a plaintext `.env`.
 */
export const REQUIRED_SECRET_ENV_VAR_NAMES = [
  "ACCEPTANCE_PERMIT_SIGNER_KEY",
  "DATABASE_URL",
  // N4 real finding (round 1, T-2301, P1): a production `BACKEND_RPC_URL`
  // typically embeds the RPC provider's own API key in the URL itself
  // (e.g. Alchemy/Infura's `https://.../v2/<key>` shape) — omitting it
  // from this list meant `aws-secrets-manager` mode still had to leave
  // this one real credential in the plaintext process environment,
  // missing F-2303's own requirement.
  "BACKEND_RPC_URL",
] as const;

export const OPTIONAL_SECRET_ENV_VAR_NAMES = [
  "PRIVY_APP_SECRET",
  "DELIVERABLE_STORAGE_S3_ACCESS_KEY_ID",
  "DELIVERABLE_STORAGE_S3_SECRET_ACCESS_KEY",
  // T-2305: the bearer token `GET /internal/metrics` (app.ts) requires from
  // a real scrape client — optional (not REQUIRED) because a deployment
  // that hasn't wired up Prometheus yet still starts fine; that route's
  // own fail-closed check (missing token = every request 401s) is what
  // keeps that case safe, not this list.
  "METRICS_SCRAPE_TOKEN",
] as const;

export const SECRET_ENV_VAR_NAMES = [
  ...REQUIRED_SECRET_ENV_VAR_NAMES,
  ...OPTIONAL_SECRET_ENV_VAR_NAMES,
] as const;

/**
 * Same reasoning as `storage.s3.ts`'s `createClient()`: an explicit
 * endpoint override means "not real AWS" (LocalStack here), so this module
 * supplies dummy static credentials rather than letting the SDK's default
 * credential provider chain resolve them — real AWS (no endpoint override)
 * still relies on that default chain untouched. Without this, a stale
 * local AWS CLI session (this environment's own real, already-documented
 * situation — see requirements.md's "云凭据现状") gets picked up and
 * rejected by LocalStack instead of LocalStack's own "any credentials
 * work" behavior applying.
 *
 * N4 real finding (round 1, T-2301, P2): both this and `secretId` below
 * used to read `process.env` directly instead of the `env` parameter
 * `hydrateSecretsFromManager` already accepts — a caller (a test, or an
 * embedded invocation) supplying an isolated `env` object still had its
 * client/secret-namespace configuration silently escape to the real global
 * `process.env`, defeating the whole point of that injection seam (real
 * risk: could point at real AWS instead of a test double, or read the
 * wrong namespace). Now threaded through consistently.
 */
function resolveClient(env: NodeJS.ProcessEnv): SecretsManagerClient {
  const endpoint = env.SECRETS_MANAGER_ENDPOINT;
  const region = env.SECRETS_MANAGER_REGION ?? (endpoint ? "us-east-1" : undefined);
  const accessKeyId = env.SECRETS_MANAGER_ACCESS_KEY_ID ?? (endpoint ? "test" : undefined);
  const secretAccessKey = env.SECRETS_MANAGER_SECRET_ACCESS_KEY ?? (endpoint ? "test" : undefined);
  return new SecretsManagerClient({
    ...(region ? { region } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
}

/**
 * `<prefix><name>` — the real full secret id a name in
 * `SECRET_ENV_VAR_NAMES` maps to in the manager, so one AWS account/region
 * can host secrets for more than one deployment without name collisions
 * (`SECRETS_MANAGER_PREFIX` defaults to a namespace scoped to this system).
 */
function secretId(env: NodeJS.ProcessEnv, name: string): string {
  const prefix = env.SECRETS_MANAGER_PREFIX ?? "agent-market/";
  return `${prefix}${name}`;
}

/**
 * Fetches one secret's value, or `undefined` if `optional` and the manager
 * genuinely has no such secret (`ResourceNotFoundException` — the "this
 * deployment doesn't use the feature this name belongs to" case). Any
 * OTHER error (network failure, permission denied, a real
 * misconfiguration) always propagates — "optional" means "absence is a
 * valid answer", never "swallow every failure".
 */
async function fetchSecretValue(
  client: SecretsManagerClient,
  env: NodeJS.ProcessEnv,
  name: string,
  optional: boolean,
): Promise<string | undefined> {
  const id = secretId(env, name);
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: id }));
    if (!response.SecretString) {
      throw new Error(`secrets: ${id} has no SecretString (binary secrets are not supported)`);
    }
    return response.SecretString;
  } catch (error) {
    if (optional && error instanceof ResourceNotFoundException) {
      return undefined;
    }
    throw error;
  }
}

export async function hydrateSecretsFromManager(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env.SECRETS_PROVIDER !== "aws-secrets-manager") {
    return;
  }
  const client = resolveClient(env);
  for (const name of REQUIRED_SECRET_ENV_VAR_NAMES) {
    if (env[name]) {
      continue;
    }
    env[name] = await fetchSecretValue(client, env, name, false);
  }
  for (const name of OPTIONAL_SECRET_ENV_VAR_NAMES) {
    if (env[name]) {
      continue;
    }
    const value = await fetchSecretValue(client, env, name, true);
    if (value !== undefined) {
      env[name] = value;
    }
  }
}

/**
 * N4 real finding (round 2, T-2301, P1): `SECRET_ENV_VAR_NAMES` is a fixed,
 * enumerable list — but `credential.ts`'s `resolveCredential` reads a
 * per-Agent DYNAMIC variable name (`env://AGENT_<agent's own id>`,
 * `computeCredentialRef`'s own deterministic output), one per Agent row,
 * unknowable ahead of time. `resolveCredential` itself stays the sole,
 * synchronous conversion step its own doc comment establishes ("零信任凭据
 * 边界") — turning it async to fetch from Secrets Manager on every single
 * invocation would ripple that signature change through
 * `invocation-client.ts` and every one of its own callers, a real
 * regression risk for an already-shipped, security-sensitive path this
 * Task has no reason to touch (CLAUDE.md 原则 9).
 *
 * Instead: enumerate every Agent's real `credential_ref` from the database
 * ONCE at startup (same "hydrate `process.env` before anything reads it"
 * shape as `hydrateSecretsFromManager`), so `resolveCredential`'s existing
 * `process.env[variableName]` read keeps working completely unchanged —
 * the variable is already populated by the time any request needs it.
 * Required, not optional (matching `resolveCredential`'s own
 * `CredentialResolutionError` when the variable is missing): a real Agent
 * row with a real `credential_ref` but no corresponding secret in the
 * manager is a genuine misconfiguration this should surface at startup,
 * not as a confusing per-invocation failure much later.
 */
export async function hydrateAgentCredentialsFromManager(
  pool: Pool,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env.SECRETS_PROVIDER !== "aws-secrets-manager") {
    return;
  }
  const { rows } = await pool.query<{ credential_ref: string }>(
    `SELECT DISTINCT credential_ref FROM agents WHERE credential_ref IS NOT NULL`,
  );
  const client = resolveClient(env);
  for (const row of rows) {
    const match = /^env:\/\/(AGENT_[0-9A-F]{32})$/.exec(row.credential_ref);
    const variableName = match?.[1];
    if (!variableName || env[variableName]) {
      continue;
    }
    env[variableName] = await fetchSecretValue(client, env, variableName, false);
  }
}
