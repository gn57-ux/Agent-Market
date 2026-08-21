# Slither Static Analysis Report

- **Date**: 2026-08-21
- **Slither version**: 0.11.6
- **Scope**: `contracts/src/` (Hardhat project auto-detected via `hardhat.config.ts`), including `mocks/` (test-only contracts kept in scope; their findings are noted as such below rather than excluded, since exclusion would have hidden them from this record).
- **Satisfies**: AC-110 NFR — "静态分析报告无高危发现或已记录并说明处理方式" (no high-risk findings, or high/medium findings documented with disposition).

## Commands used

Run from `contracts/`:

```
slither . --exclude-dependencies --json slither_out.json
```

This succeeds and auto-detects the Hardhat project (uses `hardhat.config.ts`, `solidity.version = 0.8.24`, resolves `@openzeppelin/contracts` via the project's `node_modules`). Slither's process exit code was `255`, which is Slither's normal convention for "analysis completed, findings exist" — not a failure; `results.success` in the JSON output is `true` and `results.error` is `null`.

The alternative invocation style requested for verification, direct single-file mode:

```
slither src/TaskEscrow.sol
```

**does not work in this environment**: it bypasses the Hardhat/crytic-compile project integration and falls back to invoking a standalone `solc` binary on the file directly, which is not installed/on `PATH` here (`FileNotFoundError: No such file or directory: 'solc'`). This is expected and not a project defect — the Hardhat-aware invocation (`slither .`) is the correct and working way to run Slither against this project, since it reuses the project's pinned solc version and resolves the `@openzeppelin/contracts` imports through Hardhat's own compilation pipeline instead of requiring a separately installed solc. No further action needed; documenting this here so the single-file invocation isn't retried expecting a different result.

## Findings summary by severity

| Severity      | Count |
| ------------- | ----- |
| High          | 0     |
| Medium        | 1     |
| Low           | 10    |
| Informational | 3     |

No HIGH-severity findings. One MEDIUM finding, assessed below.

## Medium finding

### `incorrect-equality` — `YDFaucet.claim()` (`src/YDFaucet.sol#42-54`)

> `YDFaucet.claim()` uses a dangerous strict equality: `lastClaimedAt[msg.sender] == 0`

**Assessment: false positive / accepted, no action.**

- `lastClaimedAt` is a `mapping(address => uint256)` whose default (unset) value is `0`, and the code comments explicitly document `0` as "never claimed" sentinel. The check `lastClaimedAt[msg.sender] == 0 ? 0 : lastClaimedAt[msg.sender] + cooldownPeriod` is comparing against a mapping's well-defined Solidity default, not against a token balance or externally-influenced quantity that could be driven to exactly `0` by an attacker (the pattern this detector is designed to catch, e.g. `balanceOf(x) == 0` griefing via dust transfers). There is no way for any caller to manipulate another address's `lastClaimedAt` entry back to `0` once set — it is monotonically increasing (`block.timestamp` on each successful claim), so this equality can never misfire.
- `YDFaucet.sol` is explicitly out of scope for T-108's business-logic constraint in any case (it is testnet/local-only faucet infrastructure per its own NatSpec, not part of `TaskEscrow`'s fund-custody surface that this Feature is responsible for), so even if this had been judged a genuine issue, T-108 would not be the right task to fix it in — it would be flagged as a blocker for human triage instead. It is not flagged as a blocker because it is not a genuine issue.

## Low / Informational findings (skimmed, no individual write-up required)

- **`timestamp` (Low, ×6 in `TaskEscrow.sol`, ×1 in `YDFaucet.sol`)**: flags `block.timestamp` comparisons used for deadline/window logic (`deliveryDeadline`, `reviewDeadline`, faucet cooldown). This is the expected and required use of `block.timestamp` for a deadline-driven escrow contract — miners can influence `block.timestamp` by at most a few seconds, which does not create an exploitable window against day-scale (`deliveryDeadline`) or hour-scale (`reviewWindow`, default 72h) deadlines. Standard accepted pattern for this contract shape; no action.
- **`missing-zero-check` / `reentrancy-benign` / `reentrancy-events` (Low, `src/mocks/MaliciousReentrantToken.sol`)**: all in a test-only mock contract (`contracts/src/mocks/`) purpose-built to simulate a malicious reentrant token for `TaskEscrow`'s own reentrancy tests — not a real deliverable, not deployed, not part of the audited surface. No action.
- **`low-level-calls` (Informational, `src/mocks/MaliciousReentrantToken.sol`)**: same mock contract, uses a low-level `call` intentionally to simulate reentrancy. No action.
- **`pragma` (Informational, OpenZeppelin dependency files + project files)**: flags the range of Solidity pragma versions across `@openzeppelin/contracts` and project sources. All project files pin `pragma solidity 0.8.24` exactly (matching `hardhat.config.ts`); the spread comes from OpenZeppelin's own dependency pragmas, which are out of this project's control. No action.
- **`cyclomatic-complexity` (Informational, `src/TaskEscrow.sol`)**: informational size/complexity metric on the contract as a whole. `TaskEscrow.sol` is a feature-complete, fully-tested (91 tests) state machine with ten external functions handling create/accept/submit/approve/timeout/dispute/cancel; each function individually is straightforward (a handful of require-style checks plus a single state transition and transfer). T-108's scope is explicitly test + static-analysis only — no business-logic refactor — so no action was taken here; if a genuine complexity/maintainability rework is wanted later, it should be a separate, deliberately-scoped refactor task per this repo's own "增加功能和重构必须分开" rule, not folded into a static-analysis task.

## Disposition summary

No HIGH findings. The single MEDIUM finding is a false positive (documented above) in code outside `TaskEscrow.sol`'s scope. No contract code was modified as a result of this Slither run — `TaskEscrow.sol`'s business logic is unchanged from before T-108.
