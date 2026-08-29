// 真实故障注入测试：manifest.mjs 的原子写入。用真实文件系统操作验证
// "manifest 部分写入或进程中途崩溃"这一类场景不会让 readManifest() 读到
// 损坏的 JSON——不 mock fs，直接对真实的 MANIFEST_PATH 做操作，测试结束
// 后清理，不影响其他测试或真实 env:start 的清单。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  writeManifest,
  readManifest,
  deleteManifest,
  manifestExists,
  MANIFEST_PATH,
  LOCAL_ENV_DIR,
} from "./manifest.mjs";

const VALID_HASH = `0x${"a".repeat(64)}`;
const VALID_ADDR = `0x${"b".repeat(40)}`;

function sampleManifest(overrides = {}) {
  return {
    version: 1,
    status: "running",
    createdAt: new Date(0).toISOString(),
    ownerLabel: "test-owner",
    ports: { hardhat: 8545, api: 3001, web: 5173, dispatch: 8081 },
    chain: { chainId: 31337, rpcUrl: "http://127.0.0.1:8545" },
    chainMarker: { txHash: VALID_HASH, markerHex: "0x1234" },
    deployer: VALID_ADDR,
    contracts: {
      ydToken: {
        address: VALID_ADDR,
        deployBlock: 1,
        deployTxHash: VALID_HASH,
        runtimeCodeHash: VALID_HASH,
      },
      taskEscrow: {
        address: VALID_ADDR,
        deployBlock: 2,
        deployTxHash: VALID_HASH,
        runtimeCodeHash: VALID_HASH,
        authorizedSigner: VALID_ADDR,
        arbitrator: VALID_ADDR,
        reviewWindowSeconds: 259200,
      },
      ydFaucet: {
        address: VALID_ADDR,
        deployBlock: 3,
        deployTxHash: VALID_HASH,
        runtimeCodeHash: VALID_HASH,
      },
    },
    database: { url: "postgres://x" },
    processes: {
      hardhat: {
        pid: 1,
        groupPid: 1,
        startTime: "Mon Jan  1 00:00:00 2026",
        command: "sleep 1",
        cwd: "/tmp",
      },
      api: {
        pid: 2,
        groupPid: 2,
        startTime: "Mon Jan  1 00:00:00 2026",
        command: "sleep 1",
        cwd: "/tmp",
      },
    },
    ...overrides,
  };
}

test("writeManifest 接受 status: partial 且只有部分 processes 字段（恢复清单场景）", () => {
  writeManifest({
    version: 1,
    status: "partial",
    createdAt: new Date(0).toISOString(),
    ownerLabel: "test-owner（回滚遗留）",
    ports: { hardhat: 8545, api: 3001, web: 5173, dispatch: 8081 },
    processes: {
      hardhat: {
        pid: 1,
        groupPid: 1,
        startTime: "Mon Jan  1 00:00:00 2026",
        command: "sleep 1",
        cwd: "/tmp",
      },
    },
    partialReason: "测试：模拟启动失败回滚遗留",
  });
  const read = readManifest();
  assert.equal(read.status, "partial");
  assert.equal(read.chain, undefined);
  assert.equal(read.processes.api, undefined);
  assert.equal(read.partialReason, "测试：模拟启动失败回滚遗留");
});

test.afterEach(() => {
  if (manifestExists()) deleteManifest();
  for (const f of readdirSync(LOCAL_ENV_DIR).filter((f) => f.startsWith("manifest.json.tmp-"))) {
    rmSync(path.join(LOCAL_ENV_DIR, f));
  }
});

test("writeManifest 之后可以完整读回（往返一致）", () => {
  writeManifest(sampleManifest());
  const read = readManifest();
  assert.equal(read.chain.chainId, 31337);
  assert.equal(read.contracts.taskEscrow.address, VALID_ADDR);
});

test("writeManifest 不会在目标路径留下残留的 .tmp 文件", () => {
  writeManifest(sampleManifest());
  const leftovers = readdirSync(LOCAL_ENV_DIR).filter((f) => f.startsWith("manifest.json.tmp-"));
  assert.deepEqual(leftovers, [], "rename 成功后不应该有残留的临时文件");
});

test("模拟'写入中途崩溃'：只留下孤立的 .tmp 文件，不影响 manifestExists/readManifest 对正式路径的判断", () => {
  writeManifest(sampleManifest({ ownerLabel: "before-crash" }));
  // 模拟第二次 env:start 在 rename 之前被杀掉——.tmp 文件写了一半，
  // 但从未 rename 到 MANIFEST_PATH。
  writeFileSync(`${MANIFEST_PATH}.tmp-99999`, "{not valid json, truncated", "utf8");

  assert.equal(manifestExists(), true);
  const read = readManifest();
  assert.equal(
    read.ownerLabel,
    "before-crash",
    "崩溃前最后一次成功写入的清单必须仍然可以被完整、干净地读出，不受孤立 .tmp 文件影响",
  );
});

test("writeManifest 拒绝写入不符合 schema 的数据（不会把无效清单原子化地落盘）", () => {
  assert.throws(() =>
    writeManifest(sampleManifest({ chain: { chainId: -1, rpcUrl: "not-a-url" } })),
  );
  assert.equal(existsSync(MANIFEST_PATH), false, "校验失败时不应该有任何文件被写入/rename");
});

test("deleteManifest 之后 manifestExists 为 false，可以重新 writeManifest", () => {
  writeManifest(sampleManifest());
  deleteManifest();
  assert.equal(manifestExists(), false);
  writeManifest(sampleManifest({ ownerLabel: "second-round" }));
  assert.equal(readManifest().ownerLabel, "second-round");
});
