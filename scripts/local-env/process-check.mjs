// 停止脚本"只处理自己记录并核验过的 PID"这条硬性要求的唯一实现：给定清单里
// 记录的 {pid, command, cwd}，重新读一次操作系统当前对该 PID 的真实认知，
// 逐项核对 command 和 cwd 是否仍然一致，并核对它是否仍然绑定着当初记录的
// 那个端口。PID 在类 Unix 系统上会被复用——如果只信任数字本身，停止脚本
// 完全可能在原进程早已退出后，把同一个 PID 号复用给的另一个无关进程杀掉。
//
// N4 review（Task A round 1，P1）指出：第一版只用"当前 command 是否包含
// 记录 command 的可执行文件 basename"做核对，这个条件太松——任何同 cwd 下
// 恰好也叫 `node` 的进程都能通过。修正为两个更强的独立条件，缺一不可：
// (1) 完整 command 字符串精确相等（record.command 本身就是 `readProcessInfo`
//     在记录当时读出来的原始字符串，不是手写猜测值，重新读一次应当逐字节
//     相同）；(2) 这个 PID 现在仍然是绑定着调用方传入的 `expectedPort` 的
//     那个监听进程（`findListenerPid` 复用 start.mjs 记录时用的同一个判据）。
//     两个条件都通过，才能排除"同一个 PID 号被复用给外观相似的另一个进程"
//     这种情况——单靠 command 字符串比对本身无法区分。
import { execFileSync } from "node:child_process";
import { findListenerPid } from "./ports.mjs";

/** 读取某个 PID 的进程启动时刻（`ps -o lstart=`，精确到秒的绝对墙钟时间）。
 * 真实故障注入测得的教训（N4 round 2 修复自查时发现）：`npm exec`/`npx`
 * 这类包装命令会在启动后不久对自己做一次 `execve`（新版 npm 把 `npx` 实现
 * 成 `npm exec` 的包装，实际执行时会重新 exec 成 `npm exec ...`），这会让
 * `ps -o command=` 读到的字符串发生变化——但 `execve` 不创建新进程，PID和
 * 进程启动时间都不变。若用"command 字符串精确相等"判断"这个 PID 是否还是
 * 我们刚才 spawn 的那个"，会把这种合法的自我 re-exec 误判成"PID 已被复用给
 * 无关进程"，进而拒绝清理，导致真正启动失败时留下孤儿（已用真实
 * `npx hardhat node` 复现：这个问题一度让 hardhat 在故障注入测试中真实
 * 泄漏）。启动时间不受 `execve` 影响，只在"旧进程退出、OS 把同一个 PID 号
 * 分配给一个全新进程"时才会变化，是比 command 字符串更可靠的身份判据。 */
export function processStartTime(pid) {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** 列出当前系统上属于某个进程组（PGID）的全部 PID——不是"组长 PID 是否
 * 还在"，而是"这个组里究竟还有没有任何进程"。
 *
 * N4 round 3 最后一次人工核验指出的 P1：`process-terminate.mjs` 之前只用
 * `processStartTime(groupPid)`（组长自己是否还在）判断"这个组是否已经退
 * 出"——但 `detached: true` spawn 出来的组长（如 `npx`/`go run` 这类包装
 * 命令）完全可能自己先退出，而它启动的孙进程仍然留在同一个进程组里继续
 * 运行且尚未绑定任何端口。这种情况下组长已经不在了，`processStartTime`
 * 返回 null，旧逻辑会把整组误判成"已退出"，既留下真实的孤儿进程，也不会
 * 触发恢复清单的保存——比"没有重试"更隐蔽，因为日志上看起来完全正常。
 *
 * 用 `ps -e -o pid=,pgid=` 遍历系统上全部进程，按 PGID 精确匹配——不按
 * 进程名或 command 做任何模糊匹配（用户明确要求"不得按进程名全局查杀"），
 * 只信任内核维护的真实进程组关系。 */
export function processesInGroup(pgid) {
  try {
    const out = execFileSync("ps", ["-e", "-o", "pid=,pgid="], { encoding: "utf8" });
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/).map(Number))
      .filter(([, linePgid]) => linePgid === pgid)
      .map(([pid]) => pid);
  } catch {
    return [];
  }
}

/** 读取某个 PID 当前的 command 和 cwd；进程不存在时返回 null。 */
export function readProcessInfo(pid) {
  let command;
  try {
    command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null; // ps 对不存在的 PID 以非零退出码失败——视为"进程不存在"。
  }
  if (!command) return null;
  let cwd = null;
  try {
    // N4 round 3 真实故障注入自查发现的 bug：`lsof -p <pid>` 的默认列输出是
    // 空格对齐的表格，`.trim().split(/\s+/)` 取最后一段——这在路径本身不含
    // 空格时凑巧管用，但本仓库自己的目录名就带空格（"Agent Market"），会把
    // cwd 截断成 "Market"。因为 spawnTracked → resolveListenerRecord 写入
    // 清单时和这里重新读取时用的是同一段有 bug 的代码，写入值和读出值恰好
    // "一致地错"，所以正常一键 start/stop 流程里从未表现出故障——但这意味着
    // cwd 这一层校验实质上从未真正比较过完整路径，形同虚设。改用 `lsof -Fn`
    // 的字段输出模式（`-F` 给结构化的"字母前缀+值"逐行输出，`n` 前缀行就是
    // 文件名/路径整行，不再对路径内容做空格切分），路径里有多少个空格都不
    // 影响解析。 */
    const lsofOut = execFileSync("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], {
      encoding: "utf8",
    });
    const nameLine = lsofOut.split("\n").find((line) => line.startsWith("n"));
    if (nameLine) cwd = nameLine.slice(1);
  } catch {
    // lsof 在某些沙箱环境下可能不可用/无权限——cwd 校验退化为跳过，command
    // 核对仍然生效，不因此放弃整个安全检查。
  }
  return { command, cwd };
}

/** 清单记录的 {pid, command, cwd} 是否仍然对应操作系统当前真实存活、且仍
 * 绑定着 `expectedPort` 的那个进程——command 精确相等 AND 端口绑定不变，
 * 两者都通过才返回 true。`expectedPort` 是必需参数：没有端口这一层交叉
 * 验证，纯 command 字符串比对无法防住"PID 复用给外观相似进程"（N4 P1）。 */
export async function verifyProcessAlive(record, expectedPort) {
  if (!record) return false;
  if (!expectedPort) {
    throw new Error("verifyProcessAlive 需要 expectedPort 参数才能安全核验（N4 P1 修复）。");
  }
  const info = readProcessInfo(record.pid);
  if (!info) return false;
  if (info.command !== record.command) return false;
  if (info.cwd && record.cwd && info.cwd !== record.cwd) return false;
  const currentListenerPid = findListenerPid(expectedPort);
  if (currentListenerPid !== record.pid) return false;
  return true;
}
