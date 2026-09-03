// 单一配置来源：本地一键环境的唯一权威部署清单。
//
// 设计决定（两个方案的比较见 Task A 的 N3 记录，未写入仓库文档——按 CLAUDE.md
// "重要设计必须至少比较两个方案"要求，比较过程见对话记录，此处只记录结论）：
// 选择"清单文件是唯一真源，根目录 .env 永不被本工具写入"，而不是"继续用 .env
// 但加锁"——因为 .env 是所有工具/会话共享的单一文件，本工具的锁约定无法约束不
// 认识这份锁的其他调用者（真实发生过：另一个 Codex Desktop 会话与本会话交替
// 覆写同一个 .env，导致 apps/api 和 apps/web 分别读到两条不同链的配置）。
//
// 唯一性由构造保证，不是靠约定：MANIFEST_PATH 是进程内的常量单一路径，
// start.mjs 在写入前会检查是否已存在一个仍存活的环境，存在则拒绝启动
// （见 start.mjs），而不是允许多份清单并存后再去猜哪份是"当前"的。

import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// T-1311 incident fix: this directory (and therefore MANIFEST_PATH) used
// to be an unconditional constant — `scripts/local-env/*.test.mjs`'s real
// fault-injection tests (writeManifest/deleteManifest calls exercising
// crash-recovery scenarios) operated on this exact same path as a real,
// live `pnpm env:start`. Real incident: running `pnpm env:test` while a
// real environment was up let a test's own manifest write/delete clobber
// the live environment's manifest — the processes themselves kept running
// (this tool never touches processes it didn't spawn), but env:status/
// env:stop lost the only record of them until the manifest was manually
// reconstructed from on-chain/process state. `AGENT_MARKET_TEST_LOCAL_ENV_DIR`
// (set only by the `env:test` npm script, never by a human running
// env:start/env:status/env:stop directly) redirects every test file's
// reads/writes to one isolated, disposable directory for that whole test
// run — production behavior (no env var set) is completely unchanged.
export const LOCAL_ENV_DIR =
  process.env.AGENT_MARKET_TEST_LOCAL_ENV_DIR || path.join(REPO_ROOT, "local-env");
export const MANIFEST_PATH = path.join(LOCAL_ENV_DIR, "manifest.json");

const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "不是合法的以太坊地址");
const HashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "不是合法的 32 字节哈希");

const ContractRecordSchema = z.object({
  address: AddressSchema,
  deployBlock: z.number().int().nonnegative(),
  deployTxHash: HashSchema,
  runtimeCodeHash: HashSchema,
});

// `groupPid`/`startTime` 是 N4 round 3 人工审查后新增的字段（见
// process-terminate.mjs 顶部注释）：`pid` 保留原义"真实监听端口的那个
// PID"（`resolveListenerRecord` 解析出来，可能和组长 PID 不同，用于展示
// /人工排查）；`groupPid` 是 `detached: true` spawn 时的组长 PID，`stop.mjs`
// 和启动失败回滚都必须用它做 `process.kill(-groupPid, ...)` 才能保证信号
// 发给整个进程组；`startTime`（`ps -o lstart=`）是判断"这个 PID 号有没有被
// 复用给无关进程"的唯一依据——不能用 command 字符串，`npx` 一类命令会在
// 启动后自我 execve 导致 command 合法地变化。 */
const ProcessRecordSchema = z.object({
  pid: z.number().int().positive(),
  groupPid: z.number().int().positive(),
  startTime: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().min(1),
});

export const ManifestSchema = z.object({
  version: z.literal(1),
  // "running"：一次成功的 env:start 写入的完整清单，`chain`/`contracts`/
  // `database` 均已知。"partial"：env:start 失败、回滚阶段未能确认所有
  // 已 spawn 的进程组都已退出时写入的**恢复清单**——只记录未能确认退出的
  // 那些服务，供 `pnpm env:stop` 继续处理；不代表任何链/合约信息真实存在
  // （失败可能发生在部署合约之前），所以 chain/chainMarker/deployer/
  // contracts/database 在这种情况下全部缺失，schema 因此把它们设为
  // optional，而不是为 partial 状态单独维护第二份 schema——两份 schema
  // 分裂的维护成本高于"这几个字段本来就是可选的"这个更简单的事实。
  status: z.enum(["running", "partial"]),
  createdAt: z.string(),
  // 人类可读的"谁启动的"标签（主机名 + 启动脚本自身 PID + 时间戳），仅用于
  // status 输出时辅助人工判断，不作为任何校验依据——本工具不区分"哪个 AI
  // 工具"启动了它，只区分"是不是本清单记录的这一份环境"。
  ownerLabel: z.string(),
  ports: z.object({
    hardhat: z.number().int().positive(),
    api: z.number().int().positive(),
    web: z.number().int().positive(),
    dispatch: z.number().int().positive(),
  }),
  chain: z
    .object({
      chainId: z.number().int().positive(),
      rpcUrl: z.string().url(),
    })
    .optional(),
  // 真正区分"这条链"与任何重放了同一份确定性部署脚本的独立链的凭据——见
  // chain-fingerprint.mjs 顶部注释：chainId/合约地址/部署交易哈希本身在两条
  // 独立链上可以完全相同，只有这笔携带真随机 UUID 的标记交易不能巧合复制。
  chainMarker: z
    .object({
      txHash: HashSchema,
      markerHex: z.string().regex(/^0x[0-9a-fA-F]*$/),
    })
    .optional(),
  deployer: AddressSchema.optional(),
  contracts: z
    .object({
      ydToken: ContractRecordSchema,
      taskEscrow: ContractRecordSchema.extend({
        authorizedSigner: AddressSchema,
        arbitrator: AddressSchema,
        reviewWindowSeconds: z.number().int().positive(),
      }),
      ydFaucet: ContractRecordSchema,
    })
    .optional(),
  database: z
    .object({
      url: z.string().min(1),
    })
    .optional(),
  // 一键脚本自己 spawn 出来的每个子进程 —— stop.mjs 只允许对这里记录、且
  // 当前仍能核对 startTime 一致的进程组发信号，绝不做按端口/进程名的全局
  // pkill（这正是用户对停止操作的硬性要求）。全部设为 optional：一份
  // "running" 清单实际总会四个都有，一份 "partial" 恢复清单可能只有其中
  // 一两个——schema 不替业务逻辑做"至少要有 hardhat"这类判断。
  processes: z.object({
    hardhat: ProcessRecordSchema.optional(),
    api: ProcessRecordSchema.optional(),
    web: ProcessRecordSchema.optional(),
    dispatch: ProcessRecordSchema.optional(),
  }),
  // 只有 status === "partial" 时才有意义：人类可读的"为什么会有这份恢复
  // 清单、哪些服务未能确认退出"，status.mjs/stop.mjs 直接原样展示。
  partialReason: z.string().optional(),
});

export function manifestExists() {
  return existsSync(MANIFEST_PATH);
}

export function readManifest() {
  if (!manifestExists()) return null;
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  return ManifestSchema.parse(raw);
}

/** 写清单时用"写临时文件 + 同目录 rename"而不是直接 writeFileSync 到
 * MANIFEST_PATH —— 直接写的话，如果 start.mjs 在写入过程中被中途杀掉
 * （断电、SIGKILL、OOM），MANIFEST_PATH 上会留下一个不完整的 JSON 文件：
 * `manifestExists()` 仍然返回 true，但 `readManifest()` 里的 `JSON.parse`
 * 会直接抛出，status.mjs/stop.mjs 都无法优雅处理"清单存在但已损坏"这种
 * 状态。同目录内的 rename 在 POSIX 文件系统上是原子操作——任何时刻
 * MANIFEST_PATH 要么是上一次成功写入的完整内容，要么是这一次成功写入的
 * 完整内容，不存在"只写了一半"的中间态可被读到。 */
export function writeManifest(manifest) {
  const parsed = ManifestSchema.parse(manifest);
  mkdirSync(LOCAL_ENV_DIR, { recursive: true });
  const tmpPath = `${MANIFEST_PATH}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  renameSync(tmpPath, MANIFEST_PATH);
  return parsed;
}

export function deleteManifest() {
  if (manifestExists()) rmSync(MANIFEST_PATH);
}
