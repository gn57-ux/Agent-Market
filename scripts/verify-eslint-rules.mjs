#!/usr/bin/env node
// Verifies AC-1108 (Feature 11 T-1107) stays true over time: the two
// mandated ESLint rules actually fire on real violations, and don't false-
// positive on clean code. Uses the project's real eslint.config.js (not a
// duplicated rule list) via ESLint's lintText API — no throwaway files
// written to disk.
import { ESLint } from "eslint";

const eslint = new ESLint({ cwd: process.cwd() });

const violatingCode = `export function violatesRules(value: unknown): number {
  const asAny: any = value;
  const forced = asAny!.length;
  return forced;
}
`;

const cleanCode = `export function isClean(value: string | undefined): number {
  return value ? value.length : 0;
}
`;

const violatingResults = await eslint.lintText(violatingCode, {
  filePath: "verify-eslint-rules-fixture.ts",
});
const violatingRuleIds = violatingResults
  .flatMap((result) => result.messages)
  .map((message) => message.ruleId);

const mustFire = ["@typescript-eslint/no-explicit-any", "@typescript-eslint/no-non-null-assertion"];
const missing = mustFire.filter((ruleId) => !violatingRuleIds.includes(ruleId));
if (missing.length > 0) {
  console.error(`FAIL: expected rule(s) did not fire on violating code: ${missing.join(", ")}`);
  console.error(`Actual rule IDs reported: ${violatingRuleIds.join(", ") || "(none)"}`);
  process.exit(1);
}

const cleanResults = await eslint.lintText(cleanCode, {
  filePath: "verify-eslint-rules-fixture-clean.ts",
});
const cleanErrorCount = cleanResults.reduce((sum, result) => sum + result.errorCount, 0);
if (cleanErrorCount > 0) {
  console.error(`FAIL: clean code triggered ${cleanErrorCount} error(s), expected 0`);
  console.error(JSON.stringify(cleanResults, null, 2));
  process.exit(1);
}

console.log(
  "OK: no-explicit-any and no-non-null-assertion both fire on violations; clean code passes.",
);
