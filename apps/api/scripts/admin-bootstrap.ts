// Feature 16 (identity-agent-review-funds-dashboard), T-1607.
//
// One-time offline bootstrap for the very FIRST admin. `POST /admin/roles`
// (admin/routes.ts) requires the caller to already be an admin — on a fresh
// `admin_roles` table that requirement can never be satisfied by any HTTP
// caller, permanently 403-ing every admin endpoint with no way to recover
// from inside the running application. This script is the deliberate
// escape hatch: an operator runs it locally, once, directly against the
// database — never through an HTTP endpoint, never gated by an environment
// variable read at request time (design.md/T-1607's explicit decision:
// `admin_roles` stays the single runtime-queried source of truth for
// `app.requireAdmin`; this script only ever seeds its initial row).
//
// Reuses `grantAdminRole` (admin/repository.ts) rather than writing its own
// INSERT — the atomic "insert + audit row, no-op if already admin" contract
// belongs to that one function (CLAUDE.md 原则: 设计知识只能有一个归属), not
// re-implemented here. The bootstrapped admin is recorded as its own
// grantor (`granted_by` = the same address) since there is, by definition,
// no other existing admin to attribute the grant to.
//
// Run as `pnpm --filter @agent-market/api admin:bootstrap -- --address 0x...`
// (see package.json).
import { pathToFileURL } from "node:url";
import { getPool, closePool } from "../src/db/pool.js";
import { normalizeAddress } from "../src/modules/auth/nonce.store.js";
import { grantAdminRole } from "../src/modules/admin/repository.js";

function parseAddressArg(argv: string[]): string {
  const flagIndex = argv.indexOf("--address");
  const value = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  if (!value) {
    throw new Error(
      "缺少 --address 参数。用法：pnpm --filter @agent-market/api admin:bootstrap -- --address 0x...",
    );
  }
  return value;
}

export async function bootstrapAdmin(address: string): Promise<void> {
  const normalized = normalizeAddress(address);
  const pool = getPool();
  const result = await grantAdminRole(pool, normalized, normalized);
  if (!result.ok) {
    console.log(`${normalized} 已经是管理员，无需重复引导。`);
    return;
  }
  console.log(`已将 ${normalized} 引导为管理员（granted_by 记录为其自身，因引导时无其他管理员）。`);
}

async function main(): Promise<void> {
  const address = parseAddressArg(process.argv.slice(2));
  await bootstrapAdmin(address);
}

// Same import-time-safety guard as backfill-embeddings.ts (its own doc
// comment explains the `pathToFileURL` rationale) — keeps `bootstrapAdmin`
// importable by a future integration test without `main()` also running as
// a side effect of that import.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
