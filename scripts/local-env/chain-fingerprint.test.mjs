// 真实故障注入测试（不用 mock）：复现本次会话实际发生过的双链事故——两条
// 独立的本地 Hardhat 链，chainId 相同、部署顺序相同导致合约地址相同，但
// 状态完全不通。断言 verifyFingerprint 能在这种情况下真实检测出不一致并
// 抛出 ChainFingerprintMismatchError，而不是被 chainId/地址表面相同的假
// 象骗过。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deployContracts } from "./deploy-contracts.mjs";
import { makePublicClient, verifyFingerprint, captureFingerprint } from "./chain-fingerprint.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function startHardhat(port) {
  const child = spawn(
    "npx",
    ["hardhat", "node", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: path.join(REPO_ROOT, "contracts"), stdio: "ignore" },
  );
  return child;
}

async function waitForRpc(rpcUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const client = makePublicClient(31337, rpcUrl);
      await client.getChainId();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(`等待 ${rpcUrl} 就绪超时`);
}

function stopHardhat(child) {
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(resolve, 3000); // 测试自身的兜底，不代表生产 stop.mjs 的行为
  });
}

test("verifyFingerprint 检测出两条独立链即使 chainId 和确定性合约地址完全相同（真实复现本次事故）", async (t) => {
  const portA = 18645;
  const portB = 18646;
  const procA = startHardhat(portA);
  const procB = startHardhat(portB);
  t.after(async () => {
    await Promise.all([stopHardhat(procA), stopHardhat(procB)]);
  });

  const rpcA = `http://127.0.0.1:${portA}`;
  const rpcB = `http://127.0.0.1:${portB}`;
  await Promise.all([waitForRpc(rpcA), waitForRpc(rpcB)]);

  // 同样的部署顺序 + 同样的确定性部署账户 → 两条链上产出逐字节相同的合约
  // 地址、逐字节相同的部署交易哈希（这正是"chainId/合约地址/部署交易哈希
  // 都不能证明是同一条链"的真实复现，不是断言——本文件顶部注释记录了这三项
  // 全部实测相同的过程）。
  const deployedA = await deployContracts(31337, rpcA);
  const deployedB = await deployContracts(31337, rpcB);
  assert.equal(
    deployedA.contracts.taskEscrow.address,
    deployedB.contracts.taskEscrow.address,
    "前提条件：两条独立链上的确定性部署必须产生相同地址，否则这个测试没有复现真实场景",
  );
  assert.notEqual(
    deployedA.chainMarker.txHash,
    deployedB.chainMarker.txHash,
    "前提条件：两次独立部署的标记交易必须携带不同的真随机 data，否则标记机制本身没有意义",
  );

  const publicClientA = makePublicClient(31337, rpcA);
  const fingerprintA = await captureFingerprint(publicClientA, {
    taskEscrowAddress: deployedA.contracts.taskEscrow.address,
  });

  // 用链 A 的清单（包括 A 自己的标记交易），去校验链 B 的 RPC —— 模拟
  // "清单是在一条链上生成的，但现在这个端口上跑的其实是另一条独立的链"
  // （真实事故的形状）。
  const manifestClaimingB = {
    chain: { chainId: fingerprintA.chainId, rpcUrl: rpcB }, // 关键：RPC 指向 B
    chainMarker: deployedA.chainMarker, // 但标记交易来自 A
    contracts: deployedA.contracts,
  };

  await assert.rejects(
    () => verifyFingerprint(manifestClaimingB),
    (error) => {
      assert.equal(error.name, "ChainFingerprintMismatchError");
      assert.match(error.message, /标记交易.*不存在/);
      return true;
    },
    "verifyFingerprint 必须在标记交易查不到时 fail-fast，不能因为 chainId/合约地址/部署交易哈希相同而放行",
  );

  // 反向验证：清单如果如实描述链 B 自己的标记交易，则必须通过——证明上面
  // 的失败不是函数本身坏了，而是真的检测到了不一致。
  const manifestMatchingB = {
    chain: { chainId: fingerprintA.chainId, rpcUrl: rpcB },
    chainMarker: deployedB.chainMarker,
    contracts: deployedB.contracts,
  };
  await assert.doesNotReject(() => verifyFingerprint(manifestMatchingB));
});
