// Feature 18 (outbox-queue-chain-indexer), T-1808.
//
// F-1811: "支持手动触发'从某个历史区块重新索引到当前'，用于修复 bug 后回填
// 正确的事件记录". A standalone, operator-triggered CLI — never called by
// `main.ts`'s own poll loop, and deliberately outside any migration
// (replay does real network `eth_getLogs` calls, not transactional DDL —
// same reasoning apps/api's own backfill-embeddings.ts documents for the
// identical class of "batch of real external calls" script).
//
// Reuses `replayEvents` (`src/indexer.ts`) verbatim — that function's own
// doc comment explains why replay has no logic beyond "scan this range":
// `insertChainIndexedEvent`'s `ON CONFLICT DO NOTHING` is what makes
// AC-1807's own repeatability requirement true for free, this script does
// not reimplement any part of it.
//
// Run as `pnpm --filter @agent-market/indexer replay -- --from-block 1000
// [--to-block 2000]` (see package.json). `--to-block` defaults to the
// chain's current tip when omitted.
import { pathToFileURL } from "node:url";
import { createChainLogScanner } from "../src/log-scanner.js";
import { replayEvents } from "../src/indexer.js";
import { getPool, closePool } from "../src/db.js";
import { resolveChainId, resolveContractAddress } from "../src/env.js";

function parseBlockArg(argv: string[], flag: string): bigint | undefined {
  const flagIndex = argv.indexOf(flag);
  const value = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  return value ? BigInt(value) : undefined;
}

export async function runReplay(argv: string[]): Promise<void> {
  const fromBlock = parseBlockArg(argv, "--from-block");
  if (fromBlock === undefined) {
    throw new Error(
      "缺少 --from-block 参数。用法：pnpm --filter @agent-market/indexer replay -- --from-block <n> [--to-block <n>]",
    );
  }
  const explicitToBlock = parseBlockArg(argv, "--to-block");

  const scanner = createChainLogScanner(process.env);
  const pool = getPool();
  const contractAddress = resolveContractAddress(process.env);
  const chainId = resolveChainId(process.env);
  const toBlock = explicitToBlock ?? (await scanner.getLatestBlockNumber());

  console.log(
    `apps/indexer replay starting: chainId=${chainId} contractAddress=${contractAddress} ` +
      `fromBlock=${fromBlock} toBlock=${toBlock}`,
  );
  const result = await replayEvents({
    scanner,
    client: pool,
    chainId,
    contractAddress,
    fromBlock,
    toBlock,
  });
  console.log(
    `apps/indexer replay complete: scanned=${result.logsScanned} indexed=${result.eventsIndexed} ` +
      `undecoded=${result.logsUndecoded}`,
  );
}

// Same import-time-safety guard apps/api's own admin-bootstrap.ts/
// backfill-embeddings.ts use — keeps `runReplay` importable by a future
// integration test without `main()` also running as a side effect of
// that import.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runReplay(process.argv.slice(2))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
