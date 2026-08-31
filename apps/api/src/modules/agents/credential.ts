// Feature 12 (agent-task-fields-credentials), T-1202.
//
// The ONE place in this codebase allowed to turn an Agent's `credentialRef`
// (a plain reference string, e.g. `env://AGENT_3F2A9C7B1E4D4F2A8B3C1D2E3F4A5B6C`
// — never the real credential value; see repository.ts's
// AgentRow.credentialRef doc comment) into the actual secret value it
// points to. No other module may
// read `process.env` to "do the same thing" — design.md's "零信任凭据边界":
// resolveCredential is the sole conversion step, and invocation-client.ts
// (T-1203) is its only intended caller.
//
// The resolved value itself is a return value only — this function never
// logs it, never includes it in a thrown error's message, and the caller
// is responsible for the same discipline (never assigning it to a variable
// that later gets logged/serialized as a whole object).

// Codex review (T-1203 round 1, P1): matches schema.ts's tightened
// CREDENTIAL_REF_SCHEMA (the `AGENT_` prefix requirement) as a defense-in-
// depth boundary — this function must not assume every caller went through
// the API schema (see resolveCredential's own doc comment on the same
// principle for the format check itself). Without this, resolveCredential
// would happily resolve `env://DATABASE_URL` or any other process
// environment variable for a caller that bypassed the API boundary.
//
// Codex review (T-1300 round 1, P1 — against this already-shipped T-1203
// code): the earlier `AGENT_[A-Z0-9_]+` shape allowed an owner-chosen
// free-text suffix, which let an attacker who knows a victim Agent's
// public id pre-claim `env://AGENT_<victim's id>` on their OWN Agent
// before the operator ever provisioned it ("front-running" — see
// 0013_add_agent_task_credentials.sql's own doc comment for the full
// writeup). The reference is now a fully deterministic function of the
// Agent's own real id — `computeCredentialRef` below is the one function
// allowed to produce it, and the migration's own CHECK enforces the same
// binding at the database layer independent of this code.
const CREDENTIAL_REF_PATTERN = /^env:\/\/(AGENT_[0-9A-F]{32})$/;

export class CredentialResolutionError extends Error {}

/**
 * The one function allowed to compute a `credentialRef` string (T-1300) —
 * repository.ts calls this, never accepts the string as free-text API
 * input. Deterministic: the same `agentId` always produces the same
 * reference, and no other agent's id can ever produce it, matching the
 * migration's own CHECK constraint exactly (`env://AGENT_` + this row's own
 * `id` with dashes stripped, hex uppercased) — kept in sync deliberately,
 * not just coincidentally similar.
 */
export function computeCredentialRef(agentId: string): string {
  return `env://AGENT_${agentId.replace(/-/g, "").toUpperCase()}`;
}

/**
 * Resolves `credentialRef` to the real secret value it references.
 *
 * Rejects (never silently skips authentication — F-1203: "缺失、为空字符串、
 * 或格式不满足...的 credential_ref 必须在解析时刻显式拒绝"):
 * - `credentialRef` is `null` (Agent has no credential configured at all);
 * - `credentialRef` doesn't match the `env://VAR_NAME` shape (should be
 *   unreachable in practice — schema.ts's CREDENTIAL_REF_SCHEMA already
 *   rejects this at the API boundary before it can reach the database —
 *   but this function must not trust that boundary blindly, since it is
 *   also reachable via any future direct-database write path);
 * - the referenced environment variable is unset or empty.
 *
 * Every error message below names the REFERENCE (`credentialRef`, or the
 * variable NAME it points to) — never the variable's actual value, which by
 * definition this function hasn't necessarily even read yet at the point
 * most of these throw.
 */
export function resolveCredential(credentialRef: string | null): string {
  if (credentialRef === null) {
    throw new CredentialResolutionError("该 Agent 尚未配置调用凭据（credentialRef 为空）。");
  }
  const match = CREDENTIAL_REF_PATTERN.exec(credentialRef);
  const variableName = match?.[1];
  if (!variableName) {
    // Codex review (T-1202 round 1, P1): the pre-fix version echoed the raw
    // `credentialRef` value into this message. schema.ts's
    // CREDENTIAL_REF_SCHEMA already rejects a non-`env://` value at the API
    // boundary, but this function must not assume every caller went
    // through that boundary — a value that bypassed it (a direct database
    // write, or a future code path) could be a real leaked secret rather
    // than a reference string, and this is exactly the format-mismatch
    // branch such a value would land in. A fixed, generic message never
    // risks echoing untrusted input, regardless of what it actually
    // contains.
    throw new CredentialResolutionError("凭据引用格式不合法，必须是 env://VARIABLE_NAME 格式。");
  }
  const value = process.env[variableName];
  if (!value) {
    throw new CredentialResolutionError(
      `凭据引用 ${credentialRef} 指向的环境变量 ${variableName} 未设置或为空。`,
    );
  }
  return value;
}
