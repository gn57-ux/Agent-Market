#!/usr/bin/env node
// 状态检查：读清单 → 核对每个进程是否真的还是清单记录的那个 → 重新采集链
// 指纹并与清单比对（复用 verifyFingerprint，"只存在一条链"的证明就来自这里）。
import { readManifest, manifestExists, MANIFEST_PATH } from "./manifest.mjs";
import { verifyProcessAlive } from "./process-check.mjs";
import { verifyFingerprint, ChainFingerprintMismatchError } from "./chain-fingerprint.mjs";
import { isPortInUse } from "./ports.mjs";

async function main() {
  if (!manifestExists()) {
    console.log("没有找到清单 —— 当前没有由本工具管理的环境在运行。");
    return;
  }
  const manifest = readManifest();
  console.log(`清单：${MANIFEST_PATH}`);
  console.log(`创建于：${manifest.createdAt}  owner：${manifest.ownerLabel}`);

  // N4 round 3：`status: "partial"` 是 env:start 启动失败、回滚阶段未能
  // 确认所有进程组都已退出时留下的恢复清单——不是一个正常运行的环境，
  // chain/chainMarker/contracts 这些字段这时根本不存在（失败可能发生在
  // 部署合约之前），不能假装它是完整清单去访问 `manifest.chain.chainId`。
  if (manifest.status === "partial") {
    console.log("\n⚠️ 这是一份 env:start 启动失败后留下的恢复清单，不是一个正常运行的环境。");
    console.log(`   原因：${manifest.partialReason ?? "（未记录）"}`);
  } else if (manifest.chain && manifest.chainMarker) {
    console.log(`Chain ID：${manifest.chain.chainId}  RPC：${manifest.chain.rpcUrl}`);
    console.log(`标记交易：${manifest.chainMarker.txHash}`);
  }
  console.log("");

  console.log("进程核验：");
  let anyDead = false;
  for (const [name, record] of Object.entries(manifest.processes)) {
    if (!record) continue;
    const alive = await verifyProcessAlive(record, manifest.ports[name]);
    const portOpen = await isPortInUse(manifest.ports[name]);
    if (!alive) anyDead = true;
    console.log(
      `  ${name.padEnd(9)} 组长 PID ${String(record.groupPid).padEnd(8)} 存活=${alive ? "是" : "否"}  端口 ${manifest.ports[name]} 监听=${portOpen ? "是" : "否"}`,
    );
  }

  if (manifest.status === "partial") {
    console.log(
      "\n链指纹核验：跳过（恢复清单没有完整的链/合约信息）。请运行 `pnpm env:stop` 处理" +
        " 上面列出的进程，处理完成后重新 `pnpm env:start`。",
    );
    return;
  }

  console.log("\n链指纹核验（证明当前 RPC 确实是清单记录的那条链，而不只是 chainId 凑巧相同）：");
  try {
    await verifyFingerprint(manifest);
    console.log(
      "  ✅ chainId / 部署标记交易 / 每个合约的运行时字节码 / authorizedSigner 全部一致。",
    );
    console.log("  ✅ 只存在一条链——没有检测到与清单不匹配的分裂状态。");
  } catch (error) {
    if (error instanceof ChainFingerprintMismatchError) {
      console.log(`  ❌ 链指纹不一致：${error.message}`);
      process.exitCode = 1;
    } else {
      console.log(`  ⚠️ 无法完成核验（RPC 不可达等）：${error.message}`);
      process.exitCode = 1;
    }
  }

  if (anyDead) {
    console.log(
      "\n⚠️ 至少一个记录的进程已不存活，环境状态不完整；建议 pnpm env:stop 后重新 pnpm env:start。",
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[env:status] 出错：${error.message}`);
  process.exitCode = 1;
});
