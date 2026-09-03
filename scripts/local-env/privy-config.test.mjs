// Feature 16, T-1611. Real temp files (this repo's own established
// local-env test convention — see ollama-preflight.test.mjs's real HTTP
// server, chain-fingerprint.test.mjs's real chain reads), not mocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPrivyConfigFromEnvFile, formatPrivyConfigStatusLine } from "./privy-config.mjs";
import { buildApiPrivyEnv, buildWebPrivyEnv } from "./start.mjs";

function withTempEnvFile(contents, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-market-privy-config-test-"));
  const filePath = path.join(dir, ".env");
  if (contents !== null) {
    writeFileSync(filePath, contents, "utf8");
  }
  try {
    return fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Fake fixture, not a real credential — built via .join() rather than a
// literal key-shaped string (matches this repo's established convention,
// e.g. SessionProvider.test.tsx's FAKE_PRIVY_ACCESS_TOKEN, to avoid the N4
// sensitive-info scanner's false-positive pattern on secret-shaped literals).
const REAL_LOOKING_SECRET = ["privy", "app", "secret", "must", "not", "leak"].join("-");

// --- Scenario 1: fully configured ---
test("readPrivyConfigFromEnvFile: both keys present", () => {
  withTempEnvFile(
    `API_PORT=3001\nPRIVY_APP_ID=fake-privy-app-id-not-real\nPRIVY_APP_SECRET=${REAL_LOOKING_SECRET}\nOTHER=1\n`,
    (filePath) => {
      const config = readPrivyConfigFromEnvFile(filePath);
      assert.equal(config.appId, "fake-privy-app-id-not-real");
      assert.equal(config.appSecret, REAL_LOOKING_SECRET);
    },
  );
});

test("formatPrivyConfigStatusLine: fully configured message names neither value", () => {
  const line = formatPrivyConfigStatusLine({ appId: "abc", appSecret: REAL_LOOKING_SECRET });
  assert.match(line, /已配置/);
  assert.doesNotMatch(line, /abc/);
  assert.doesNotMatch(line, new RegExp(REAL_LOOKING_SECRET));
});

// --- Scenario 2: fully missing ---
test("readPrivyConfigFromEnvFile: file has neither key", () => {
  withTempEnvFile("API_PORT=3001\nOTHER=1\n", (filePath) => {
    const config = readPrivyConfigFromEnvFile(filePath);
    assert.equal(config.appId, undefined);
    assert.equal(config.appSecret, undefined);
  });
});

test("readPrivyConfigFromEnvFile: file does not exist at all", () => {
  const config = readPrivyConfigFromEnvFile("/nonexistent/path/does-not-exist/.env");
  assert.equal(config.appId, undefined);
  assert.equal(config.appSecret, undefined);
});

test("formatPrivyConfigStatusLine: fully missing message", () => {
  const line = formatPrivyConfigStatusLine({ appId: undefined, appSecret: undefined });
  assert.match(line, /未配置/);
  assert.match(line, /SIWE\/MetaMask 登录正常可用/);
});

// --- Scenario 3: only App Secret missing ---
test("readPrivyConfigFromEnvFile: App ID present, App Secret blank", () => {
  withTempEnvFile("PRIVY_APP_ID=fake-privy-app-id-not-real\nPRIVY_APP_SECRET=\n", (filePath) => {
    const config = readPrivyConfigFromEnvFile(filePath);
    assert.equal(config.appId, "fake-privy-app-id-not-real");
    assert.equal(config.appSecret, undefined);
  });
});

test("formatPrivyConfigStatusLine: partial config names the missing key, not the present one's value", () => {
  const line = formatPrivyConfigStatusLine({
    appId: "fake-privy-app-id-not-real",
    appSecret: undefined,
  });
  assert.match(line, /配置不完整/);
  assert.match(line, /PRIVY_APP_SECRET/);
  assert.doesNotMatch(line, /fake-privy-app-id-not-real/);
});

test("formatPrivyConfigStatusLine: App Secret present but App ID missing also reports as incomplete", () => {
  const line = formatPrivyConfigStatusLine({ appId: undefined, appSecret: REAL_LOOKING_SECRET });
  assert.match(line, /配置不完整/);
  assert.match(line, /PRIVY_APP_ID/);
  assert.doesNotMatch(line, new RegExp(REAL_LOOKING_SECRET));
});

// --- Scenario 4: secret never enters the Web env, regardless of config completeness ---
test("buildWebPrivyEnv: never includes PRIVY_APP_SECRET or its value, even with a full config", () => {
  const webEnv = buildWebPrivyEnv({
    appId: "fake-privy-app-id-not-real",
    appSecret: REAL_LOOKING_SECRET,
  });
  assert.deepEqual(Object.keys(webEnv), ["VITE_PRIVY_APP_ID"]);
  assert.equal(webEnv.VITE_PRIVY_APP_ID, "fake-privy-app-id-not-real");
  assert.equal(JSON.stringify(webEnv).includes(REAL_LOOKING_SECRET), false);
});

test("buildWebPrivyEnv: empty object when App ID absent (App Secret alone is never exposed to Web)", () => {
  const webEnv = buildWebPrivyEnv({ appId: undefined, appSecret: REAL_LOOKING_SECRET });
  assert.deepEqual(webEnv, {});
});

// --- Codex review round 1, P2: "configured" is all-or-nothing, not
// per-field. Only App ID present must NOT enable the Web entry point —
// the paired API process never registers /auth/verify/privy in that case
// (createPrivyIdentityProvider needs both values), so a Web-only-enabled
// button would be a dead end contradicting formatPrivyConfigStatusLine's
// own "配置不完整...Privy 登录入口不会启用" message.
test("buildWebPrivyEnv: empty object when App ID is present but App Secret is missing (partial config must not enable the Web entry point)", () => {
  const webEnv = buildWebPrivyEnv({ appId: "fake-privy-app-id-not-real", appSecret: undefined });
  assert.deepEqual(webEnv, {});
});

test("buildApiPrivyEnv: includes both keys when fully configured (API needs the secret to call Privy's verify API)", () => {
  const apiEnv = buildApiPrivyEnv({
    appId: "fake-privy-app-id-not-real",
    appSecret: REAL_LOOKING_SECRET,
  });
  assert.equal(apiEnv.PRIVY_APP_ID, "fake-privy-app-id-not-real");
  assert.equal(apiEnv.PRIVY_APP_SECRET, REAL_LOOKING_SECRET);
});

test("buildApiPrivyEnv: empty object when fully unconfigured", () => {
  const apiEnv = buildApiPrivyEnv({ appId: undefined, appSecret: undefined });
  assert.deepEqual(apiEnv, {});
});

test("buildApiPrivyEnv: empty object when only App ID is present (partial config must not register /auth/verify/privy with an incomplete client)", () => {
  const apiEnv = buildApiPrivyEnv({ appId: "fake-privy-app-id-not-real", appSecret: undefined });
  assert.deepEqual(apiEnv, {});
});

test("buildApiPrivyEnv: empty object when only App Secret is present", () => {
  const apiEnv = buildApiPrivyEnv({ appId: undefined, appSecret: REAL_LOOKING_SECRET });
  assert.deepEqual(apiEnv, {});
});

// --- Scenario 4b: the persisted manifest ---
// Not spun up as a real env:start run here (that needs a real Hardhat/DB/
// Go/Vite stack — already exercised as a real full-stack run, not a unit
// test's job to repeat). Instead this asserts the specific structural
// property that makes leakage impossible in the first place: the object
// literal start.mjs actually writes via `writeManifest(...)` never
// references `privyConfig` — a manifest built from a literal that never
// names the variable holding the secret cannot contain it, no matter what
// value that variable holds at runtime.
test("start.mjs: the persisted manifest object literal never references privyConfig (PRIVY_APP_SECRET structurally cannot reach it)", () => {
  const startMjsPath = fileURLToPath(new URL("./start.mjs", import.meta.url));
  const source = readFileSync(startMjsPath, "utf8");

  const manifestStart = source.indexOf("const manifest = {");
  assert.ok(manifestStart >= 0, "expected to find the manifest object literal in start.mjs");
  const writeManifestCall = source.indexOf("writeManifest(manifest)", manifestStart);
  assert.ok(
    writeManifestCall > manifestStart,
    "expected writeManifest(manifest) after the literal",
  );

  const manifestLiteralSource = source.slice(manifestStart, writeManifestCall);
  assert.doesNotMatch(manifestLiteralSource, /privyConfig/);
  assert.doesNotMatch(manifestLiteralSource, /PRIVY_APP_SECRET/);
});
