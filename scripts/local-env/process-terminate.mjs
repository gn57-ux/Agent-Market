// 唯一实现"安全终止一个进程组，并且真的验证它退出了"这件事。
//
// 人工审查真实指出的 P1：round 2 之前，启动失败回滚（start.mjs 的
// `cleanupPartialStart`）只向进程组发一次 SIGTERM，不等待、不重试、也不
// 验证进程/端口是否真的消失；而 `pnpm env:stop` 另有一套独立的"发信号→
// 等待→重试 3 次→仍存活则报告"逻辑。两套清理语义分开维护，真实出现过
// "改了一处、另一处没跟上"的分裂（round 2 的 spawn 时立即登记只在 hardhat
// 一处落地，api/dispatch/web 三处当时还是旧代码）。更严重的是：启动回滚
// 阶段失败时正式 manifest 还没写入，如果子进程忽略 SIGTERM，回滚只发一次
// 信号就放弃，会留下一个 env:stop 根本不知道存在、因而永远无法接管的孤儿
// ——这正是这次真实要修的问题，而不是"回滚已经做得和 stop.mjs 一样好，只是
// 长得不一样"。
//
// 这里把"发 SIGTERM → 有界等待 → 重试 → 核对进程和端口都真的消失"收敛成
// 一个函数，`start.mjs`（启动失败回滚）和 `stop.mjs`（一键停止）都调用
// 同一份实现，不再各自维护重试循环。
//
// 身份核对只用进程启动时间（`processStartTime`），不用 command 字符串——
// `npx` 一类命令会在启动后自我 execve，PID 和启动时间不变但 command 合法
// 地变化；用 command 精确匹配曾经把这种合法变化误判成"PID 已被复用"，
// 真实泄漏过一个 Hardhat 进程（细节见 process-check.mjs 里
// `processStartTime` 的注释）。
//
// N4 round 3 最后一次人工核验指出的 P1：判断"这个进程组是否已经退出"曾经
// 只看 `processStartTime(groupPid)`（组长自己还在不在），没有真正检查
// 整个 PGID。`detached: true` spawn 出来的组长（`npx`/`go run` 这类包装
// 命令）完全可能自己先退出，而它启动的孙进程仍然留在同一个进程组里、还
// 没绑定任何端口——这种情况下旧实现会把整组误判成"已消失"，`stopped` 状态
// 掩盖了真实存在的孤儿，也不会触发恢复清单保存。修正为用
// `processesInGroup(groupPid)`（真实遍历系统进程表按 PGID 精确匹配，不按
// 进程名做任何模糊查杀）判断"这个组里还有没有任何进程"，而不只是组长。
import { processStartTime, processesInGroup } from "./process-check.mjs";
import { findListenerPid } from "./ports.mjs";

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 终止一个（`detached: true` spawn 出来的）进程组，直到确认组内所有成员
 * 和（提供了 port 时）它应该绑定的端口都已经消失，或者达到最大重试次数。
 *
 * @param {{ name: string, groupPid: number, startTime?: string, port?: number }} target
 * @param {{ maxAttempts?: number, intervalMs?: number, log?: (msg: string) => void }} [options]
 * @returns {Promise<{
 *   name: string, groupPid: number,
 *   status: "already-gone" | "pid-reused" | "kill-error" | "stopped" | "still-alive",
 *   error?: string,
 * }>}
 */
export async function terminateProcessGroup(
  { name, groupPid, startTime, port },
  { maxAttempts = 4, intervalMs = 1500, log = () => {} } = {},
) {
  const initialMembers = processesInGroup(groupPid);
  if (initialMembers.length === 0) {
    return { name, groupPid, status: "already-gone" };
  }

  // 身份核对只能在组长本身还在时做——它的启动时间是我们唯一能验证的、
  // spawn 时刻就记录下来的凭据。如果组长已经先退出、只剩下孙进程留在这个
  // PGID 里，就没有可供核对的组长启动时间了；但这个 PGID 号本来就是我们
  // 自己 spawn 时取得、由调用方（start.mjs 的 startedServices / 一份我们
  // 自己写的 manifest）传进来的，provenance 已经在更早的环节确立过，这里
  // 不需要（也没有条件）重新验证——继续处理已经核验过的这个进程组，而不
  // 是对一个从未见过的 PGID 凭空发起操作。
  if (initialMembers.includes(groupPid)) {
    const currentStartTime = processStartTime(groupPid);
    if (startTime && currentStartTime !== startTime) {
      log(
        `⚠️ ${name} 记录的组长 PID ${groupPid} 当前启动时间（${currentStartTime}）与记录时` +
          `（${startTime}）不一致，判定 PID 已被复用给无关进程，跳过发送信号（拒绝误杀）。`,
      );
      return { name, groupPid, status: "pid-reused" };
    }
  }

  function stillRunning() {
    const hasMembers = processesInGroup(groupPid).length > 0;
    const hasPort = port ? Boolean(findListenerPid(port)) : false;
    return hasMembers || hasPort;
  }

  try {
    process.kill(-groupPid, "SIGTERM");
  } catch (error) {
    return { name, groupPid, status: "kill-error", error: error.message };
  }
  log(`已对 ${name} 的进程组（组长 PID ${groupPid}）发送 SIGTERM，等待退出…`);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(intervalMs);
    if (!stillRunning()) {
      log(`${name} 已确认退出（组内进程已消失${port ? `，端口 ${port} 已释放` : ""}）。`);
      return { name, groupPid, status: "stopped" };
    }
    log(`${name} 仍未完全退出（组内仍有进程或端口仍被占用），第 ${attempt + 1} 次重试 SIGTERM…`);
    try {
      process.kill(-groupPid, "SIGTERM");
    } catch {
      // 组长已经不在，但组内可能还有其他成员——`kill(-pgid, ...)` 是按
      // PGID 发信号，只要组里还有进程，这个调用本身通常仍然成功；这里的
      // catch 只覆盖"整个组已经彻底消失"这种极端情况，下一轮 stillRunning()
      // 判断会捕获，不需要特殊处理。
    }
  }
  return { name, groupPid, status: "still-alive" };
}
