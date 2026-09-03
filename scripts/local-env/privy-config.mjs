// Feature 16 (identity-agent-review-funds-dashboard), T-1611.
//
// `env:start` deliberately does NOT source the repo root `.env` wholesale
// (see start.mjs's own header comment, principle 3: every spawned process
// receives its config only through explicit `env:` objects this tool
// constructs, never through `.env` inheritance — the whole point being one
// deterministic manifest as the single source of truth, immune to a stale
// or wrong `.env` a developer happens to have lying around).
//
// Real gap this file closes (T-1611, user-reported): Privy credentials
// have no other source — they're not chain-deployed, not
// database-derived, not something this tool can generate — they can only
// come from a developer's own `.env`. Without SOME explicit, narrow read
// of exactly `PRIVY_APP_ID`/`PRIVY_APP_SECRET`, `env:start` can never offer
// Privy login at all, forcing a manual `source .env` workaround that
// defeats the "one manifest, one source of truth" guarantee this tool
// exists to provide.
//
// This file is intentionally narrow: it reads ONLY these two keys, from
// ONLY the exact file path the caller gives it, and never touches
// `process.env` itself (unlike `node --env-file`/`process.loadEnvFile`,
// which would load every key in the file into the process — reintroducing
// exactly the "stale .env value leaks into a spawned child" risk
// start.mjs's own design note explicitly rejects). Missing file, missing
// key, or an empty value are all just "not configured" — never an error a
// caller needs to handle specially, matching ollama-preflight.mjs's own
// "optional external config, everything is a normal degrade state" model.
import { readFileSync } from "node:fs";

/**
 * Reads exactly `PRIVY_APP_ID`/`PRIVY_APP_SECRET` from a dotenv-format
 * file at `envFilePath`. Never throws (a missing file, an unreadable
 * file, or a key that's absent/blank all resolve to `undefined` for that
 * field) and never logs the file's contents or the values it finds —
 * callers must not either (see `formatPrivyConfigStatusLine` below for the
 * only sanctioned way to describe the result).
 *
 * Deliberately not a general dotenv parser: only these two `KEY=value`
 * lines (optionally quoted, matching this repo's own `.env.example`
 * convention of unquoted values) are recognized; anything else in the
 * file is not read, not returned, not retained.
 */
export function readPrivyConfigFromEnvFile(envFilePath) {
  let contents;
  try {
    contents = readFileSync(envFilePath, "utf8");
  } catch {
    return { appId: undefined, appSecret: undefined };
  }
  return {
    appId: extractEnvValue(contents, "PRIVY_APP_ID"),
    appSecret: extractEnvValue(contents, "PRIVY_APP_SECRET"),
  };
}

function extractEnvValue(fileContents, key) {
  const pattern = new RegExp(`^${key}=(.*)$`, "m");
  const match = pattern.exec(fileContents);
  if (!match) return undefined;
  const raw = match[1].trim();
  if (raw.length === 0) return undefined;
  const unquoted =
    (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1)
      : raw;
  return unquoted.length > 0 ? unquoted : undefined;
}

/**
 * Formats a redacted (F-1601-style "脱敏") status line for `env:start`'s
 * console output — the App ID's existence/absence may be reported (it is
 * itself non-secret, safe to appear in a browser bundle per
 * `.env.example`'s own documented reasoning for `VITE_PRIVY_APP_ID`), but
 * neither its value nor the App Secret's value or even its
 * presence-as-a-literal-string is ever interpolated into this line.
 */
export function formatPrivyConfigStatusLine(config) {
  if (config.appId && config.appSecret) {
    return "✅ Privy 已配置：/auth/verify/privy 与前端 Privy 登录入口均会启用。";
  }
  if (!config.appId && !config.appSecret) {
    return (
      "⚠️ Privy 未配置（根 .env 未设置 PRIVY_APP_ID/PRIVY_APP_SECRET）：" +
      "SIWE/MetaMask 登录正常可用，Privy 登录入口不会启用。"
    );
  }
  // Exactly one of the two is set — a real misconfiguration (T-1611's
  // defect A explicitly lists "只缺 App Secret" as its own test scenario),
  // not the same as "fully unconfigured" above.
  const missing = config.appId ? "PRIVY_APP_SECRET" : "PRIVY_APP_ID";
  return (
    `⚠️ Privy 配置不完整（缺少 ${missing}）：` +
    "SIWE/MetaMask 登录正常可用，Privy 登录入口不会启用。"
  );
}
