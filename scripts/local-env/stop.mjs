#!/usr/bin/env node
// 一键停止：只处理清单里记录、且核验身份仍然匹配的进程组；绝不按端口号或
// 进程名做全局 pkill。SIGTERM 优先，多次失败才报告升级选项——不自动发
// SIGKILL。
//
// N4 round 3 人工审查后：终止逻辑（发信号→有界等待→重试→核对进程和端口
// 都真的消失）改为调用共享深模块 `terminateProcessGroup`
// （process-terminate.mjs）——之前这里和 start.mjs 启动失败回滚各自维护
// 一套清理语义，真实出现过"改了一处、另一处没跟上"的分裂，见
// process-terminate.mjs 顶部注释。身份核对同样改为进程启动时间
// （`processStartTime`），不再用 command 字符串精确匹配：`npx` 一类命令会
// 在启动后自我 execve 导致 command 合法地变化，用字符串匹配曾经把这种
// 合法变化误判成"PID 被复用"、拒绝清理，真实泄漏过一个 Hardhat 进程。
import { readManifest, deleteManifest, manifestExists, MANIFEST_PATH } from "./manifest.mjs";
import { readProcessInfo } from "./process-check.mjs";
import { terminateProcessGroup } from "./process-terminate.mjs";

function log(message) {
  console.log(`[env:stop] ${message}`);
}

async function stopOne(name, record, port) {
  if (!record) return { name, status: "skipped-not-recorded" };

  const info = readProcessInfo(record.groupPid);
  if (!info) {
    log(`${name}（组长 PID ${record.groupPid}）已不存在，无需处理。`);
    return { name, status: "already-gone" };
  }
  log(`${name}（组长 PID ${record.groupPid}，${info.command}）开始核验身份并停止…`);

  const result = await terminateProcessGroup(
    { name, groupPid: record.groupPid, startTime: record.startTime, port },
    { log },
  );
  return { name, status: result.status, error: result.error };
}

async function main() {
  if (!manifestExists()) {
    log(`没有找到清单（${MANIFEST_PATH}）——没有需要停止的环境。`);
    return;
  }
  const manifest = readManifest();
  const results = [];
  // 停止顺序：先前端/网关类，再核心（API 依赖 Hardhat 才能响应交易复核，
  // 但停止顺序本身不影响正确性——这里只是让日志读起来符合直觉）。
  for (const [name, record] of [
    ["web", manifest.processes.web],
    ["dispatch", manifest.processes.dispatch],
    ["api", manifest.processes.api],
    ["hardhat", manifest.processes.hardhat],
  ]) {
    results.push(await stopOne(name, record, manifest.ports[name]));
  }

  const unresolved = results.filter((r) => r.status === "still-alive" || r.status === "kill-error");
  if (unresolved.length > 0) {
    console.error(
      `\n以下进程未能确认已停止，需要人工确认是否升级为 SIGKILL（本脚本不会自动执行）：`,
    );
    for (const r of unresolved) {
      const record = manifest.processes[r.name];
      const info = readProcessInfo(record.groupPid);
      console.error(
        `  - ${r.name}：进程组组长 PID ${record.groupPid}，状态 ${r.status}${r.error ? `（${r.error}）` : ""}，当前进程信息：${info ? info.command : "已查不到"}`,
      );
      console.error(
        `    如确认需要强制终止：kill -9 -${record.groupPid}（负号表示对整个进程组发送信号）`,
      );
    }
    console.error("\n清单未删除，保留供排查；解决后重新运行 pnpm env:stop 即可清理。");
    process.exitCode = 1;
    return;
  }

  deleteManifest();
  log("全部进程已停止，清单已删除。");
}

main().catch((error) => {
  console.error(`[env:stop] 停止过程出错：${error.message}`);
  process.exitCode = 1;
});
