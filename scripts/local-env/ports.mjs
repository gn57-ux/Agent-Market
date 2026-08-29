// 端口占用检测——启动前的第一道防线："拒绝重复 chainId 节点或端口冲突"里
// "端口冲突"的那一半（另一半是 chain-fingerprint.mjs 的多维指纹比对）。
import net from "node:net";
import { execFileSync } from "node:child_process";

/** 真正监听某端口的进程 PID——不是 spawn 时拿到的那个 PID。真实测得：
 * `npx hardhat node`/`npx vite`/`go run ./cmd/server` 都会先起一个包装进程
 * （npx 的 shim、`go run` 的临时构建器），包装进程的 PID 和最终真正绑定
 * 端口、需要被停止脚本安全核验/终止的那个进程是两个不同的 PID——这正是
 * 本次会话早些时候在另一个 Codex 会话的进程树上真实遇到过的同一类问题
 * （`pnpm exec hardhat node` 的 PID 发 SIGTERM 不会级联到它三层深的孙进程）。
 * 清单只应该记录"谁真正占着这个端口"，用 `lsof` 直接问操作系统，而不是
 * 信任 `child_process.spawn()` 返回的 PID。 */
export function findListenerPid(port) {
  try {
    const out = execFileSync("lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-t", "-n", "-P"], {
      encoding: "utf8",
    }).trim();
    const pid = out.split("\n")[0]?.trim();
    return pid ? Number(pid) : null;
  } catch {
    return null;
  }
}

/** 探测一个 TCP 端口在 127.0.0.1 上是否已被占用。真正尝试连接而不是只查
 * `lsof`/`ps`——服务是否真的在监听才是唯一可信的信号，进程列表可能滞后或
 * 包含已经在退出中的僵尸监听。 */
export function isPortInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const finish = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

export async function assertPortsFree(ports) {
  const busy = [];
  for (const [name, port] of Object.entries(ports)) {
    if (await isPortInUse(port)) busy.push({ name, port });
  }
  if (busy.length > 0) {
    const detail = busy.map((b) => `${b.name}:${b.port}`).join(", ");
    throw new Error(
      `以下端口已被占用，拒绝启动（可能已有环境在运行，或存在无关进程）：${detail}。` +
        " 请先运行 `pnpm env:status` 确认，再决定 `pnpm env:stop` 或手动处理占用者。",
    );
  }
}
