#!/usr/bin/env node
// 一键启动：唯一环境，唯一清单，启动前 fail-fast 拒绝任何已存在的冲突。
//
// 设计边界（有意的范围限定，不是遗漏）：本工具只保证"这个仓库检出目录同一
// 时刻只有一个由它管理的本地环境"，不试图解决"两个完全不同的工具互相不
// 知道对方存在"这种更大的问题——真实发生的双链事故，根因正是有第二个不
// 认识这份清单协议的调用者在跑自己的 `hardhat node`/`pnpm dev`。本工具能
// 做到的、也是这里实际做到的：
//   (1) 自己管理的环境启动前检测端口占用，拒绝在冲突端口上继续；
//   (2) 自己发起的每一次部署都把可验证的指纹写进唯一清单，其余环节
//       （API/Web/status/stop）都以这份清单为准，不再各自从可能被覆写
//       的 .env 读值；
//   (3) 绝不写入仓库根 `.env`——所有下游进程通过 spawn 时的显式环境变量
//       接收配置，Node 的 `--env-file-if-exists` 和 Vite 的 `loadEnv` 都
//       以真实 process.env 优先于 .env 文件，因此这里传入的值不会被
//       任何人手上那份 .env 覆盖。
//       （T-1611 的唯一例外，窄到只读两个键：Privy 凭据不是链上部署值、
//       不是数据库派生值，本工具没有别的来源能生成它——`readPrivyConfigFromEnvFile`
//       只精确读取 `PRIVY_APP_ID`/`PRIVY_APP_SECRET` 这两行，从不把整份
//       `.env` 载入 `process.env`，不违反"清单是唯一配置来源"这条原则本身
//       想避免的"陈旧/错误 .env 污染其他键"的风险——见该文件顶部注释。）
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, Pool } from "pg";
import {
  manifestExists,
  readManifest,
  writeManifest,
  MANIFEST_PATH,
  LOCAL_ENV_DIR,
} from "./manifest.mjs";
import { assertPortsFree, isPortInUse, findListenerPid } from "./ports.mjs";
import { deployContracts, DEPLOYER_PRIVATE_KEY } from "./deploy-contracts.mjs";
import { makePublicClient, captureFingerprint } from "./chain-fingerprint.mjs";
import {
  verifyProcessAlive,
  readProcessInfo,
  processStartTime,
  processesInGroup,
} from "./process-check.mjs";
import { terminateProcessGroup } from "./process-terminate.mjs";
import { checkOllamaEmbedding, formatOllamaPreflightLines } from "./ollama-preflight.mjs";
import { readPrivyConfigFromEnvFile, formatPrivyConfigStatusLine } from "./privy-config.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const PORTS = { hardhat: 8545, api: 3001, web: 5173, dispatch: 8081 };
const DATABASE_NAME = "agent_market_local_env";
const DATABASE_URL = `postgres://postgres@127.0.0.1:5432/${DATABASE_NAME}`;

function log(message) {
  console.log(`[env:start] ${message}`);
}

/** N4 review（Task A round 1，P1；round 2，P1 加深）：干净检出只跑过
 * `pnpm install` 时，`apps/api/dist` 和 `contracts/artifacts` 都不存在，必须
 * 先构建。round 1 的第一版只在产物"不存在"时才构建——round 2 指出这个判据
 * 不够：切分支、拉新代码或改了合约之后产物依然"存在"，只是陈旧，`env:start`
 * 会用旧字节码/旧 API 代码起一个看似正常、实际与当前检出源码不一致的环境。
 * 既然目标就是"一键"且"唯一配置来源"，这里不再做存在性判断，每次都直接构建
 * ——比省下几秒钟更重要的是这份清单描述的必须真的是当前源码对应的产物。 */
function ensureBuildArtifacts() {
  log("构建 apps/api（pnpm --filter @agent-market/api build）…");
  const apiResult = spawnSync("pnpm", ["--filter", "@agent-market/api", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (apiResult.status !== 0) throw new Error("apps/api 构建失败，无法继续启动。");

  log("编译 contracts（pnpm --filter @agent-market/contracts compile）…");
  const contractsResult = spawnSync("pnpm", ["--filter", "@agent-market/contracts", "compile"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (contractsResult.status !== 0) throw new Error("contracts 编译失败，无法继续启动。");
}

async function waitFor(label, checkFn, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkFn()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待 ${label} 就绪超时（${timeoutMs}ms）。`);
}

async function ensureDatabase() {
  const admin = new Client({ connectionString: "postgres://postgres@127.0.0.1:5432/postgres" });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      DATABASE_NAME,
    ]);
    if (rowCount === 0) {
      log(`创建数据库 ${DATABASE_NAME}（首次启动，之后的启动会复用并只跑迁移）。`);
      await admin.query(`CREATE DATABASE ${DATABASE_NAME}`);
    }
  } finally {
    await admin.end();
  }
}

async function runMigrations() {
  const { runMigrations: run } = await import(
    path.join(REPO_ROOT, "apps", "api", "dist", "db", "migrate.js")
  );
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    await run(pool, path.join(REPO_ROOT, "apps", "api", "migrations"));
  } finally {
    await pool.end();
  }
}

/**
 * T-1611 (Codex review, round 1, P2): "configured" is all-or-nothing, not
 * per-field. `PrivyIdentityProvider`'s factory (`createPrivyIdentityProvider`)
 * needs BOTH `PRIVY_APP_ID`/`PRIVY_APP_SECRET` to construct a real Privy SDK
 * client — with only one set, `app.ts`'s composition root still never
 * registers `/auth/verify/privy` (same as having neither set; see T-1602's
 * `privy-routes.integration.test.ts` precedent). The first version of this
 * fix let `buildWebPrivyEnv` react to `appId` alone, so a partial config
 * (App ID present, Secret missing) would mount a working-LOOKING Privy
 * button on a Web process whose paired API process never registers the
 * route it posts to — directly contradicting `formatPrivyConfigStatusLine`'s
 * own "配置不完整...Privy 登录入口不会启用" promise. Both env-builders below
 * now gate on this single shared predicate so that promise is structurally
 * true, not just documented.
 */
function isPrivyFullyConfigured(privyConfig) {
  return Boolean(privyConfig.appId && privyConfig.appSecret);
}

/**
 * T-1611: pure, independently testable — the only place that decides
 * which of `PRIVY_APP_ID`/`PRIVY_APP_SECRET` reach the API child process.
 * Extracted specifically so a test can assert this shape without spinning
 * up the full Hardhat/DB/API/Go/Vite stack `runStartupSequence` drives.
 */
function buildApiPrivyEnv(privyConfig) {
  if (!isPrivyFullyConfigured(privyConfig)) return {};
  return { PRIVY_APP_ID: privyConfig.appId, PRIVY_APP_SECRET: privyConfig.appSecret };
}

/**
 * T-1611: mirrors `buildApiPrivyEnv` above for the Web child process —
 * gated on the SAME full-configuration check (round 1 P2 fix: previously
 * gated on `appId` alone), and structurally incapable of including
 * `PRIVY_APP_SECRET` regardless — the fix's hard requirement ("PRIVY_APP_SECRET
 * 绝不能进入 Web 环境") stays a property of this function's own body, not
 * just something callers must remember to uphold.
 */
function buildWebPrivyEnv(privyConfig) {
  if (!isPrivyFullyConfigured(privyConfig)) return {};
  return { VITE_PRIVY_APP_ID: privyConfig.appId };
}

/** 端口就绪之后，问操作系统"到底是谁在监听这个端口"，而不是信任
 * `spawn()` 返回的 PID——见 ports.mjs 的 `findListenerPid` 注释：npx/go run
 * 这类包装命令的 PID 和真正绑定端口、需要被 stop.mjs 安全终止的那个 PID
 * 经常是两个不同的进程。清单只记录这里解析出的真实记录。 */
function resolveListenerRecord(port, fallbackCommand, fallbackCwd) {
  const pid = findListenerPid(port);
  if (!pid) {
    throw new Error(`端口 ${port} 显示已就绪，但找不到实际监听它的进程——无法安全记录清单。`);
  }
  const info = readProcessInfo(pid);
  return {
    pid,
    command: info?.command || fallbackCommand,
    cwd: info?.cwd || fallbackCwd,
  };
}

function spawnTracked(name, command, args, { cwd, env }) {
  // `detached: true` + 直接把日志文件描述符传给子进程的 stdio（而不是父进程
  // 里 `.pipe()` 一个 stream）——真实测得的教训：第一版用非 detached +
  // 父进程侧 pipe，start.mjs 打印完摘要 `process.exit(0)` 后，子进程被同一个
  // 会话/进程组的退出连带关闭（表现为 Hardhat 在 status.mjs 检查时已经不在
  // 了，日志文件里也没有任何崩溃痕迹——因为不是子进程自己崩溃，是父进程退出
  // 时把它带走的）。detached 让子进程有自己独立的进程组，不再随父进程的会话
  // 退出而消失；日志描述符直接由操作系统写，不依赖父进程还活着去转发。
  const logPath = path.join(LOCAL_ENV_DIR, `${name}.log`);
  const logFd = openSync(logPath, "a");
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  child.on("error", (err) => log(`${name} 进程错误：${err.message}`));
  child.unref();
  // 记录时间必须紧跟在 spawn() 之后：越早读取，`ps` 观察到 PID 尚未被
  // 复用/尚未自我 re-exec 完成的窗口就越可靠（虽然 re-exec 不影响启动
  // 时间，但仍然想尽量缩小任何理论竞态窗口）。
  const startTime = processStartTime(child.pid);
  return { child, command: `${command} ${args.join(" ")}`, cwd, startTime };
}

/** N4 review（Task A round 1，P1；round 2，P1 加深；round 3 人工审查，
 * 最后一个 P1）：部署/数据库/API/dispatch/Web 任一步骤失败都必须能清理
 * 已经 spawn 的子进程，不留孤儿。round 1/2 解决了"何时登记"（`spawn()`
 * 返回即登记 `child.pid`，因为 `detached: true` 让它同时是进程组组长 PID，
 * `process.kill(-pid, ...)` 能覆盖包装器不转发信号的情况）。
 *
 * round 3 人工审查指出这里仍不完整：修到 round 2 为止，回滚只发**一次**
 * SIGTERM，不等待、不重试、不验证进程和端口是否真的消失。如果某个子进程
 * 忽略 SIGTERM（真实可能：故意或意外 trap 掉信号的场景），启动失败会
 * "看起来清理过"但实际留下一个仍在监听端口的孤儿——而且此时正式 manifest
 * 从未写入过，`pnpm env:stop` 读不到任何记录，**没有任何后续手段能接管
 * 这个孤儿**。之前证据包里"可由后续 env:stop 处理"的说法与这里的真实控制
 * 流不符，已经是过时/不准确的描述。
 *
 * 修复分两部分：
 * (1) 把"发信号→有界等待→重试→核对进程和端口都真的消失"收敛成共享深模块
 *     `terminateProcessGroup`（process-terminate.mjs），`stop.mjs` 也改用
 *     同一个函数，不再各自维护两套清理语义。
 * (2) 如果重试耗尽仍未能确认退出：启动命令本身必须失败（已经如此，见
 *     `main()` 的 `throw error`）；额外原子写入一份 `status: "partial"`
 *     的恢复清单，只记录未能确认退出的那些服务的组长 PID/启动时间，让
 *     `pnpm env:stop` 之后真的有据可查、可以继续尝试终止；不删除这份记录、
 *     不在日志里声称"已清理"，并打印精确的 PID 和人工强制处理提示。 */
async function cleanupAndRecoverPartialStart(startedServices, originalError) {
  if (startedServices.length === 0) return;
  log(`启动失败，正在清理已启动的 ${startedServices.length} 个服务（按进程组）…`);

  const results = [];
  for (const svc of [...startedServices].reverse()) {
    const result = await terminateProcessGroup(
      { name: svc.name, groupPid: svc.groupPid, startTime: svc.startTime, port: PORTS[svc.name] },
      { log },
    );
    results.push({ ...svc, ...result });
  }

  // "pid-reused"：我们自己 spawn 的那个进程已经退出（不然 PID 不可能被
  // 复用），当前占着这个 PID 号的是别人——没有任何属于本次启动的东西需要
  // 保留在恢复清单里，等同于"已经消失"。真正需要保留、供 env:stop 继续
  // 处理的只有 SIGTERM 未能确认生效的那些。
  const unresolved = results.filter((r) => r.status === "still-alive" || r.status === "kill-error");
  if (unresolved.length === 0) {
    log("已确认本次启动失败时 spawn 出的子进程均已退出（或从未真正起来），无需保留恢复清单。");
    return;
  }

  log(`⚠️ 以下 ${unresolved.length} 个服务未能在回滚阶段确认已退出：`);
  const processes = {};
  const vanishedBeforeSave = [];
  for (const r of unresolved) {
    // "这个服务在写清单前是不是真的已经消失"必须按**整个进程组**判断
    // （`processesInGroup`），不能只看组长 PID 本身还在不在——这正是这一轮
    // 修复本身要解决的问题（见 process-terminate.mjs 顶部注释）：组长完全
    // 可能已经先退出，而组里的孙进程仍然存活。第一版这里用
    // `processStartTime(r.groupPid)`（只看组长）判断"是否已消失"，真实
    // 测出会在"组长先退出、孙进程仍存活"的场景下把仍然存活的一整组误判成
    // "写入前已自行消失"，连恢复清单都不写——比它想修的问题更糟。
    const stillHasMembers = processesInGroup(r.groupPid).length > 0;
    if (!stillHasMembers) {
      vanishedBeforeSave.push(r.name);
      log(
        `  - ${r.name}：进程组（组长 PID ${r.groupPid}）在写入恢复清单前已经完全消失` +
          `（组内不再有任何进程），视为已自行退出，不写入恢复清单。`,
      );
      continue;
    }
    // 组内仍有成员，但组长本身可能已经不在了——这种情况下读不到组长的
    // command/cwd/启动时间是预期行为，不是异常；用能拿到的信息尽量填充，
    // 拿不到就留下清楚的占位说明，而不是让 schema 校验直接抛错。
    const info = readProcessInfo(r.groupPid);
    const liveStartTime =
      processStartTime(r.groupPid) ??
      r.startTime ??
      "(组长已退出，仅通过 PGID 成员判定该组仍存活，无法记录组长自身的启动时间)";
    processes[r.name] = {
      pid: r.groupPid,
      groupPid: r.groupPid,
      startTime: liveStartTime,
      command: info?.command ?? "(组长已退出，具体 command 未知——组内其他成员仍存活)",
      cwd: info?.cwd ?? REPO_ROOT,
    };
    log(
      `  - ${r.name}：进程组组长 PID ${r.groupPid}，状态 ${r.status}${r.error ? `（${r.error}）` : ""}。` +
        ` 需要人工确认后可执行：kill -9 -${r.groupPid}（负号表示对整个进程组发送信号）。`,
    );
  }

  if (Object.keys(processes).length === 0) {
    log("重新核实后，所有未确认退出的服务在写入恢复清单前均已自行消失，无需保留恢复清单。");
    return;
  }

  writeManifest({
    version: 1,
    status: "partial",
    createdAt: new Date().toISOString(),
    ownerLabel: `${process.env.USER ?? "unknown"}@${path.basename(REPO_ROOT)}#${process.pid}（启动失败回滚遗留，非正常运行环境）`,
    ports: PORTS,
    processes,
    partialReason:
      `env:start 启动失败（${originalError.message}）。以下服务在回滚阶段发送 SIGTERM 并重试后仍未能` +
      ` 确认已退出，需要人工处理或运行 pnpm env:stop 继续尝试：${Object.keys(processes).join(", ")}。` +
      (vanishedBeforeSave.length > 0
        ? ` （另有 ${vanishedBeforeSave.join(", ")} 在写入这份清单前已自行消失，未记录。）`
        : ""),
  });
  log(
    `⚠️ 恢复清单已保存：${MANIFEST_PATH} —— 不会自动删除，也不会声称清理成功。` +
      " 请运行 `pnpm env:status` 查看，或 `pnpm env:stop` 继续尝试终止这些进程组。",
  );
}

async function main() {
  mkdirSync(LOCAL_ENV_DIR, { recursive: true });

  if (manifestExists()) {
    const existing = readManifest();
    const hardhatAlive = await verifyProcessAlive(
      existing.processes.hardhat,
      existing.ports.hardhat,
    );
    if (hardhatAlive) {
      throw new Error(
        `已存在一个存活的环境（清单：${MANIFEST_PATH}，Hardhat PID ${existing.processes.hardhat.pid}）。` +
          " 请先运行 `pnpm env:stop`，或 `pnpm env:status` 确认现状。拒绝启动第二份环境。",
      );
    }
    log("发现一份清单但其 Hardhat 进程已不存活，视为陈旧清单，将被覆盖。");
  }

  ensureBuildArtifacts();

  log(`检测端口占用：${JSON.stringify(PORTS)}`);
  await assertPortsFree(PORTS);

  const startedServices = [];
  try {
    await runStartupSequence(startedServices);
  } catch (error) {
    await cleanupAndRecoverPartialStart(startedServices, error);
    throw error;
  }
}

async function runStartupSequence(startedServices) {
  log("启动 Hardhat 节点…");
  const hardhatProc = spawnTracked(
    "hardhat",
    "npx",
    ["hardhat", "node", "--hostname", "127.0.0.1", "--port", String(PORTS.hardhat)],
    { cwd: path.join(REPO_ROOT, "contracts") },
  );
  startedServices.push({
    name: "hardhat",
    groupPid: hardhatProc.child.pid,
    startTime: hardhatProc.startTime,
  });
  const rpcUrl = `http://127.0.0.1:${PORTS.hardhat}`;
  await waitFor("Hardhat RPC", async () => {
    try {
      const client = makePublicClient(31337, rpcUrl);
      await client.getChainId();
      return true;
    } catch {
      return false;
    }
  });
  const hardhatRecord = resolveListenerRecord(PORTS.hardhat, hardhatProc.command, hardhatProc.cwd);
  log(`Hardhat 节点就绪（真实监听 PID ${hardhatRecord.pid}）。`);

  log("部署合约…");
  const { deployer, contracts, chainMarker } = await deployContracts(31337, rpcUrl);
  const publicClient = makePublicClient(31337, rpcUrl);
  const fingerprint = await captureFingerprint(publicClient, {
    taskEscrowAddress: contracts.taskEscrow.address,
  });
  log(
    `部署完成：YDToken=${contracts.ydToken.address} TaskEscrow=${contracts.taskEscrow.address} YDFaucet=${contracts.ydFaucet.address}`,
  );

  await ensureDatabase();
  log("运行数据库迁移…");
  await runMigrations();

  // T-1611: narrow, explicit, read-only — see this file's header comment
  // (principle 3's documented exception) and privy-config.mjs's own doc
  // comment for why this is safe and why it stays this narrow.
  const privyConfig = readPrivyConfigFromEnvFile(path.join(REPO_ROOT, ".env"));

  const apiEnv = {
    API_PORT: String(PORTS.api),
    DATABASE_URL,
    CHAIN_ID: "31337",
    BACKEND_RPC_URL: rpcUrl,
    TASK_ESCROW_ADDRESS: contracts.taskEscrow.address,
    YD_TOKEN_ADDRESS: contracts.ydToken.address,
    YD_FAUCET_ADDRESS: contracts.ydFaucet.address,
    ACCEPTANCE_PERMIT_SIGNER_KEY: DEPLOYER_PRIVATE_KEY,
    AUTH_DOMAIN: "localhost",
    WEB_ORIGIN: `http://localhost:${PORTS.web}`,
    COOKIE_INSECURE_LOCAL_DEV: "1",
    DISPATCH_SERVICE_URL: `http://127.0.0.1:${PORTS.dispatch}`,
    DELIVERABLE_STORAGE_DIR: path.join(LOCAL_ENV_DIR, "deliverables"),
    ...buildApiPrivyEnv(privyConfig),
  };
  log("启动 API 服务…");
  const apiProc = spawnTracked("api", "node", ["dist/server.js"], {
    cwd: path.join(REPO_ROOT, "apps", "api"),
    env: apiEnv,
  });
  startedServices.push({ name: "api", groupPid: apiProc.child.pid, startTime: apiProc.startTime });
  await waitFor("API", async () => isPortInUse(PORTS.api));
  const apiRecord = resolveListenerRecord(PORTS.api, apiProc.command, apiProc.cwd);

  log("启动 Go 撮合服务…");
  const dispatchProc = spawnTracked("dispatch", "go", ["run", "./cmd/server"], {
    cwd: path.join(REPO_ROOT, "services", "dispatch"),
    env: { DISPATCH_PORT: String(PORTS.dispatch) },
  });
  startedServices.push({
    name: "dispatch",
    groupPid: dispatchProc.child.pid,
    startTime: dispatchProc.startTime,
  });
  await waitFor("Go dispatch", async () => isPortInUse(PORTS.dispatch), { timeoutMs: 60_000 });
  const dispatchRecord = resolveListenerRecord(
    PORTS.dispatch,
    dispatchProc.command,
    dispatchProc.cwd,
  );

  const webEnv = {
    VITE_API_BASE_URL: `http://localhost:${PORTS.api}`,
    VITE_AUTH_DOMAIN: "localhost",
    VITE_CHAIN_ID: "31337",
    VITE_WALLET_RPC_URL: rpcUrl,
    VITE_DISPATCH_API_BASE_URL: `http://localhost:${PORTS.dispatch}`,
    VITE_TASK_ESCROW_ADDRESS: contracts.taskEscrow.address,
    VITE_YD_TOKEN_ADDRESS: contracts.ydToken.address,
    VITE_YD_FAUCET_ADDRESS: contracts.ydFaucet.address,
    ...buildWebPrivyEnv(privyConfig),
  };
  log("启动 Web 开发服务器…");
  const webProc = spawnTracked(
    "web",
    "npx",
    ["vite", "--host", "127.0.0.1", "--port", String(PORTS.web), "--strictPort"],
    { cwd: path.join(REPO_ROOT, "apps", "web"), env: webEnv },
  );
  startedServices.push({ name: "web", groupPid: webProc.child.pid, startTime: webProc.startTime });
  await waitFor("Web", async () => isPortInUse(PORTS.web));
  const webRecord = resolveListenerRecord(PORTS.web, webProc.command, webProc.cwd);

  const manifest = {
    version: 1,
    status: "running",
    createdAt: new Date().toISOString(),
    ownerLabel: `${process.env.USER ?? "unknown"}@${path.basename(REPO_ROOT)}#${process.pid}`,
    ports: PORTS,
    chain: { chainId: fingerprint.chainId, rpcUrl },
    chainMarker,
    deployer,
    contracts,
    database: { url: DATABASE_URL },
    processes: {
      hardhat: {
        ...hardhatRecord,
        groupPid: hardhatProc.child.pid,
        startTime: hardhatProc.startTime,
      },
      api: { ...apiRecord, groupPid: apiProc.child.pid, startTime: apiProc.startTime },
      web: { ...webRecord, groupPid: webProc.child.pid, startTime: webProc.startTime },
      dispatch: {
        ...dispatchRecord,
        groupPid: dispatchProc.child.pid,
        startTime: dispatchProc.startTime,
      },
    },
  };
  writeManifest(manifest);

  console.log("\n========== 环境已启动 ==========");
  console.log(`清单：${MANIFEST_PATH}`);
  console.log(`Web：       http://localhost:${PORTS.web}`);
  console.log(`API：       http://localhost:${PORTS.api}`);
  console.log(`Hardhat RPC：${rpcUrl}（chainId 31337）`);
  console.log(`Go dispatch：http://127.0.0.1:${PORTS.dispatch}`);

  // F-1317: read-only, informational only — never affects this script's
  // exit code (see ollama-preflight.mjs's own header comment for why).
  console.log("");
  const ollamaResult = await checkOllamaEmbedding();
  for (const line of formatOllamaPreflightLines(ollamaResult)) {
    console.log(line);
  }

  // T-1611: same "informational only, never fails startup" contract as
  // the Ollama preflight above — SIWE/MetaMask must start normally
  // regardless of Privy configuration state (fix requirement 6).
  console.log(formatPrivyConfigStatusLine(privyConfig));

  console.log("\nMetaMask 添加/切换网络指引：");
  console.log(`  网络名称：Agent Market Local`);
  console.log(`  RPC URL：${rpcUrl}`);
  console.log(`  Chain ID：31337`);
  console.log(`  货币符号：ETH`);
  console.log(
    "  重要：如果 MetaMask 里已经有一个指向其它 8545/Hardhat 实例的“Localhost 8545”网络，" +
      "请编辑而不是新建——两个同名不同 RPC 的网络是本次事故的直接原因。",
  );
  console.log("\n停止：pnpm env:stop  状态：pnpm env:status");
}

// 导出给故障注入测试用（见 start.mjs.test.mjs）——测试需要能单独调用
// `spawnTracked`/`cleanupPartialStart` 等内部函数并用真实（但一次性、无害）
// 的子进程演练"spawn 后立刻失败""SIGTERM 后进程赖着不退""PID 被复用"这些
// 场景，而不必每次都拉起完整的 Hardhat/API/Go/Vite 四件套。只有下面这个
// `import.meta.url` 守卫为真（即直接 `node start.mjs` 运行）时才会真的启动。
export {
  spawnTracked,
  cleanupAndRecoverPartialStart,
  resolveListenerRecord,
  ensureBuildArtifacts,
  waitFor,
  ensureDatabase,
  runMigrations,
  runStartupSequence,
  buildApiPrivyEnv,
  buildWebPrivyEnv,
  main,
  PORTS,
  DATABASE_URL,
};

// N4 round 3 自查发现：用字符串拼接 `file://${process.argv[1]}` 比较，在
// `node scripts/local-env/start.mjs`（相对路径调用，`pnpm env:start` 实际
// 就是这样调用的）这种最常见的调用方式下会失配——`process.argv[1]` 是相对
// 路径，`import.meta.url` 永远是绝对路径，字符串直接比较必然不相等，导致
// `main()` 从未被调用，脚本读完所有函数/export 后静默以 exit 0 退出，没有
// 任何输出也没有报错。用 `pathToFileURL` 把 `argv[1]` 转成同样规范化的
// file:// URL 再比较，才对相对/绝对路径调用都成立。
function isDirectlyExecuted() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectlyExecuted()) {
  main()
    .then(() => {
      // 四个子进程的 stdio 管道会一直让事件循环保持存活——它们本该在 start.mjs
      // 打印完摘要后继续独立运行（不带 detached，但父进程退出不会杀死它们，
      // 已用真实运行验证过），而不是让这个一次性的启动脚本自己也挂在前台。
      process.exit(0);
    })
    .catch((error) => {
      console.error(`[env:start] 启动失败：${error.message}`);
      process.exit(1);
    });
}
