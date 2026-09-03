#!/usr/bin/env node
// Feature 15 (T-1503): Cocos Creator 3.8.8's CLI/headless build was
// investigated for real automated CI builds (`CocosCreator --path/--project
// --build ...`) and found not straightforwardly reachable within reasonable
// investigation time on this machine — both flag spellings from the
// project's own documented CLI convention were rejected as "bad option" by
// the bundled binary, and no CLI entry point was found under
// `Contents/Resources`. This is design.md's explicitly anticipated "方案
// B" fallback: the export from the Cocos editor into
// `apps/web/public/office-cocos/` stays a human-triggered step, but this
// script closes the real gap that step used to leave open — a developer
// editing `apps/office-cocos/assets/**` and forgetting to re-export before
// committing. It cannot generate the bundle; it can only prove whether the
// currently-committed bundle still corresponds to the currently-committed
// source.
//
// Two modes:
//   node scripts/office-cocos-sync-check.mjs           (check, default)
//   node scripts/office-cocos-sync-check.mjs --record   (after a real
//     manual re-export, record the new expected hash)
//
// The hash covers only the human-authored Cocos source (assets/, settings/)
// — not `apps/web/public/office-cocos/` itself, which is generated output,
// not a hashing input.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirs = [
  path.join(repoRoot, "apps/office-cocos/assets"),
  path.join(repoRoot, "apps/office-cocos/settings"),
];
const bundleDir = path.join(repoRoot, "apps/web/public/office-cocos");
const manifestPath = path.join(repoRoot, "apps/office-cocos/.build-manifest.json");

function listFilesSorted(dir) {
  const results = [];
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const full = path.join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else results.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return results;
}

function computeSourceHash() {
  const hash = createHash("sha256");
  for (const dir of sourceDirs) {
    for (const file of listFilesSorted(dir)) {
      hash.update(path.relative(repoRoot, file));
      hash.update(readFileSync(file));
    }
  }
  return hash.digest("hex");
}

const mode = process.argv.includes("--record") ? "record" : "check";
const currentHash = computeSourceHash();

if (mode === "record") {
  if (!existsSync(bundleDir) || listFilesSorted(bundleDir).length === 0) {
    console.error(
      "office-cocos-sync-check --record: apps/web/public/office-cocos/ is missing or empty — " +
        "export from the Cocos Creator editor first, then re-run --record.",
    );
    process.exitCode = 1;
    process.exit();
  }
  writeFileSync(
    manifestPath,
    JSON.stringify({ sourceHash: currentHash, recordedAt: new Date().toISOString() }, null, 2) +
      "\n",
  );
  console.log(`office-cocos-sync-check: recorded source hash ${currentHash.slice(0, 12)}…`);
  process.exit(0);
}

if (!existsSync(manifestPath)) {
  console.error(
    "office-cocos-sync-check: no recorded manifest at apps/office-cocos/.build-manifest.json — " +
      "run `node scripts/office-cocos-sync-check.mjs --record` once after a real editor export.",
  );
  process.exitCode = 1;
  process.exit();
}

const recorded = JSON.parse(readFileSync(manifestPath, "utf8"));
if (recorded.sourceHash !== currentHash) {
  console.error(
    "office-cocos-sync-check: apps/office-cocos source has changed since the last recorded " +
      "export (apps/office-cocos/.build-manifest.json is stale). Re-export the Cocos project " +
      "from the editor into apps/web/public/office-cocos/, then run " +
      "`node scripts/office-cocos-sync-check.mjs --record`.",
  );
  process.exitCode = 1;
  process.exit();
}

if (!existsSync(bundleDir) || listFilesSorted(bundleDir).length === 0) {
  console.error(
    "office-cocos-sync-check: apps/web/public/office-cocos/ is missing or empty even though " +
      "the recorded manifest matches the current source — the built bundle itself was deleted " +
      "or never committed.",
  );
  process.exitCode = 1;
  process.exit();
}

console.log("office-cocos-sync-check: apps/web/public/office-cocos/ matches recorded source.");
