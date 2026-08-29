// 真实（非 mock）故障注入测试。
//
// 第一部分：针对共享深模块 `terminateProcessGroup`（process-terminate.mjs）
// 的低层行为——`start.mjs` 启动失败回滚和 `stop.mjs` 现在都调用同一份实现，
// 这里直接测这个共享原语，不再分别测两个调用方各自的转发逻辑。用真实、
// 无害的一次性子进程（`sleep`，以及一个真实自我 `execve` 的
// `bash -c 'exec sleep ...'`）演练"进程组清理""PID 被真正复用时拒绝误杀"
// "合法的自我 re-exec 不应被误判为 PID 复用""PID 已经不存在"。
//
// 第二部分：针对 N4 round 3 人工审查的 P1——`cleanupAndRecoverPartialStart`
// 在子进程忽略 SIGTERM 时必须原子保存恢复清单（不能像 round 2 之前那样只发
// 一次信号就放弃、不留任何痕迹）。用一个真实、主动忽略 SIGTERM 的 Node
// 进程复现"启动失败回滚时子进程不配合退出"，证明修复前会真实泄漏、修复后
// 要么完整退出，要么恢复清单被正确保留且后续 `stop.mjs` 能接管。
//
// 其余需要真实端口/真实构建产物、跑一次要几十秒到几分钟的场景（Hardhat/
// API/Go/Web 各阶段真实失败、双链指纹区分、重复 start 拒绝、崩溃自愈）不
// 适合作为常规单测反复执行，已经作为真实全栈手工验证跑过，证据见
// local-env/task-a-human-review-evidence.md。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readManifest, deleteManifest, manifestExists } from "./manifest.mjs";
import { terminateProcessGroup } from "./process-terminate.mjs";
import { processesInGroup, processStartTime } from "./process-check.mjs";
import { spawnTracked, cleanupAndRecoverPartialStart } from "./start.mjs";

function isAlive(pid) {
  try {
    execFileSync("ps", ["-o", "pid=", "-p", String(pid)], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

test.afterEach(() => {
  // 任何一条测试如果因为断言失败而提前退出，不应该让恢复清单残留、
  // 污染后面的测试或真实的 env:status/env:stop。
  if (manifestExists()) deleteManifest();
});

// ---------- 第一部分：terminateProcessGroup 共享原语 ----------

test("terminateProcessGroup 通过进程组 SIGTERM 真的终止一个 detached 子进程", async () => {
  const proc = spawnTracked("fake-hardhat", "sleep", ["120"], { cwd: "/tmp" });
  assert.ok(isAlive(proc.child.pid), "sleep 应该已经真实启动");

  const result = await terminateProcessGroup({
    name: "fake-hardhat",
    groupPid: proc.child.pid,
    startTime: proc.startTime,
  });

  assert.equal(result.status, "stopped");
  assert.equal(isAlive(proc.child.pid), false, "SIGTERM 之后 sleep 进程应该已经退出");
});

test("terminateProcessGroup 在启动时间不一致时拒绝发信号（真正的 PID 复用防护）", async () => {
  const proc = spawnTracked("fake-api", "sleep", ["120"], { cwd: "/tmp" });
  assert.ok(isAlive(proc.child.pid));

  // 故意传一个与真实 spawn 时不同的启动时间——模拟"这个 PID 号已经被复用
  // 给了一个无关进程"的场景（真实触发 OS 级 PID 复用不可控，用伪造的记录
  // 值来演练校验分支是否真的生效）。
  const result = await terminateProcessGroup({
    name: "fake-api",
    groupPid: proc.child.pid,
    startTime: "Mon Jan  1 00:00:00 1990",
  });

  assert.equal(result.status, "pid-reused");
  assert.ok(isAlive(proc.child.pid), "启动时间不一致时不应该杀掉这个进程");

  // 清理：测试自己负责收尾，不留下真正的孤儿。
  process.kill(-proc.child.pid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
});

test("terminateProcessGroup 不会把合法的自我 re-exec（PID/启动时间不变，command 变了）误判为 PID 复用", async () => {
  // 复现真实测得的 bug：`npx hardhat node` 启动后会自我 execve 成
  // `npm exec hardhat node ...`，PID 和启动时间不变，但 `ps -o command=`
  // 读到的字符串变了。用 `bash -c 'exec sleep 120'` 在受控、确定性的方式
  // 下复现同一种"合法自我 re-exec"。
  const proc = spawnTracked("fake-reexec", "bash", ["-c", "exec sleep 120"], { cwd: "/tmp" });
  assert.ok(isAlive(proc.child.pid));
  await new Promise((resolve) => setTimeout(resolve, 200)); // 等 exec 真正发生

  const result = await terminateProcessGroup({
    name: "fake-reexec",
    groupPid: proc.child.pid,
    startTime: proc.startTime,
  });

  assert.equal(result.status, "stopped");
  assert.equal(
    isAlive(proc.child.pid),
    false,
    "自我 re-exec 之后的进程仍然应该被正确识别并清理，不能因为 command 变了就放过",
  );
});

test("terminateProcessGroup 对已经不存在的 PID 返回 already-gone，不抛异常", async () => {
  const proc = spawnTracked("fake-dispatch", "sleep", ["1"], { cwd: "/tmp" });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(isAlive(proc.child.pid), false, "sleep 1 应该早就自己退出了");

  const result = await terminateProcessGroup({
    name: "fake-dispatch",
    groupPid: proc.child.pid,
    startTime: proc.startTime,
  });
  assert.equal(result.status, "already-gone");
});

test("terminateProcessGroup 对忽略 SIGTERM 的进程重试耗尽后返回 still-alive（不会误报成功）", async () => {
  // 真实、主动忽略 SIGTERM 的 Node 子进程——这正是启动回滚阶段可能真实
  // 遇到的场景：子进程 trap 掉了 SIGTERM。
  const child = spawn(
    "node",
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { cwd: "/tmp", detached: true, stdio: "ignore" },
  );
  child.unref();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(isAlive(child.pid));

  const result = await terminateProcessGroup(
    { name: "fake-stubborn", groupPid: child.pid, startTime: undefined },
    { maxAttempts: 2, intervalMs: 200 }, // 缩短重试参数，测试不用真的等默认的 4×1.5s
  );

  assert.equal(result.status, "still-alive");
  assert.ok(isAlive(child.pid), "忽略 SIGTERM 的进程理应仍然存活——不能被误报为已停止");

  // 清理：测试自己负责收尾。
  process.kill(-child.pid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 200));
});

test("terminateProcessGroup 在组长已先退出、同组孙进程仍存活且未监听端口时，正确判定 still-alive（N4 round 3 最后一个 P1）", async () => {
  // 真实复现：组长（bash）把一个忽略 SIGTERM、且从不监听任何端口的 Node
  // 进程放到后台（`&`，不 exec 替换自己），然后自己立即退出——`disown` 让
  // 这个后台子进程不会随 bash 的 job control 被牵连关闭，但它仍然留在
  // bash 启动时创建的那个进程组里。这正是修复前的 bug：旧实现只检查
  // `processStartTime(groupPid)`（组长是否还在）和端口是否监听——组长已经
  // 走了、又没传 port，旧逻辑会在完全没有发送信号、没有任何等待的情况下
  // 直接判定"already-gone"，把这个仍然存活的孙进程当场放过。
  const leader = spawn(
    "bash",
    [
      "-c",
      "node -e \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\" & disown; exit 0",
    ],
    { detached: true, stdio: "ignore" },
  );
  leader.unref();
  const groupPid = leader.pid;

  await new Promise((resolve) => setTimeout(resolve, 800)); // 等 bash 真的退出、子进程真的起来
  const membersBeforeTerminate = processesInGroup(groupPid);
  const grandchildPid = membersBeforeTerminate.find((pid) => pid !== groupPid);

  assert.equal(
    processStartTime(groupPid),
    null,
    "前提：组长这时应该已经退出（否则这条测试没有测到真实场景）",
  );
  assert.ok(
    grandchildPid && isAlive(grandchildPid),
    "前提：孙进程这时应该仍然存活、且和组长共享同一个 PGID",
  );

  try {
    const result = await terminateProcessGroup(
      { name: "fake-orphaned-grandchild", groupPid, startTime: undefined },
      { maxAttempts: 2, intervalMs: 300 },
    );

    assert.equal(
      result.status,
      "still-alive",
      "组内还有存活成员时必须报告 still-alive，不能因为组长已经不在就当场放过",
    );
    assert.ok(
      isAlive(grandchildPid),
      "孙进程应该仍然存活——如果这里已经死了，说明测试环境异常，不是修复本身的问题",
    );
  } finally {
    // 清理：按整个进程组强制终止，不留下真正的孤儿。
    try {
      process.kill(-groupPid, "SIGKILL");
    } catch {
      // 已经不在了。
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
});

// ---------- 第二部分：cleanupAndRecoverPartialStart 端到端行为 ----------

test("cleanupAndRecoverPartialStart：全部子进程正常退出时，不写任何恢复清单（要求 5）", async () => {
  const a = spawnTracked("fake-a", "sleep", ["120"], { cwd: "/tmp" });
  const b = spawnTracked("fake-b", "sleep", ["120"], { cwd: "/tmp" });
  assert.ok(isAlive(a.child.pid) && isAlive(b.child.pid));

  await cleanupAndRecoverPartialStart(
    [
      { name: "fake-a", groupPid: a.child.pid, startTime: a.startTime },
      { name: "fake-b", groupPid: b.child.pid, startTime: b.startTime },
    ],
    new Error("模拟的启动失败"),
  );

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(isAlive(a.child.pid), false);
  assert.equal(isAlive(b.child.pid), false);
  assert.equal(
    manifestExists(),
    false,
    "正常清理成功时不应该留下任何 manifest.json（无论是 running 还是 partial）",
  );
});

test("cleanupAndRecoverPartialStart：子进程忽略 SIGTERM 时，原子保存 partial 恢复清单，不声称清理成功（N4 round 3 P1 核心场景）", async () => {
  // 真实复现"启动回滚时子进程不配合退出"：一个正常退出（对照组），一个
  // 主动 trap 掉 SIGTERM（真正要验证的场景）。
  const cooperative = spawnTracked("fake-cooperative", "sleep", ["120"], { cwd: "/tmp" });
  const stubbornChild = spawn(
    "node",
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { cwd: "/tmp", detached: true, stdio: "ignore" },
  );
  stubbornChild.unref();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(isAlive(cooperative.child.pid) && isAlive(stubbornChild.pid));

  try {
    await cleanupAndRecoverPartialStart(
      [
        {
          name: "fake-cooperative",
          groupPid: cooperative.child.pid,
          startTime: cooperative.startTime,
        },
        // "dispatch" 是 PORTS 里真实存在的 key，借用它让内部的
        // `terminateProcessGroup` 调用能拿到一个 port 参数——这里我们不关心
        // 端口本身，只关心进程组是否被正确判定为 still-alive。
        //
        // `startTime: undefined` 是故意的：模拟 spawn 时刻 `processStartTime`
        // 采集失败的边界情况（第一版在这里真实抛出过 ZodError，把
        // `writeManifest` 本身写崩——见下面对 `manifest.processes.dispatch.
        // startTime` 的断言，证明修复后的"写入时重新现场读一次"兜底生效）。
        { name: "dispatch", groupPid: stubbornChild.pid, startTime: undefined },
      ],
      new Error("模拟的启动失败：某个必需步骤失败"),
    );

    // 配合的进程应该已经退出。
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(isAlive(cooperative.child.pid), false);

    // 不配合的进程理应仍然存活——修复前的 bug 是"发一次信号就假装清理完了"，
    // 这里直接断言它没有被谎报成"已清理"。
    assert.ok(isAlive(stubbornChild.pid), "忽略 SIGTERM 的进程在回滚阶段结束后应仍然存活");

    // 核心断言：必须有一份 partial 恢复清单被原子写入，且记录了这个仍然
    // 存活的进程组，不能声称清理成功、也不能什么都不留下。
    assert.equal(manifestExists(), true, "子进程未能确认退出时必须保留恢复清单");
    const manifest = readManifest();
    assert.equal(manifest.status, "partial");
    assert.ok(manifest.partialReason && manifest.partialReason.includes("模拟的启动失败"));
    assert.equal(manifest.processes.dispatch.groupPid, stubbornChild.pid);
    assert.ok(
      typeof manifest.processes.dispatch.startTime === "string" &&
        manifest.processes.dispatch.startTime.length > 0,
      "即使 spawn 时刻的 startTime 采集是 undefined，写入恢复清单时也必须现场重新读到一个有效值，" +
        "否则 writeManifest 的 schema 校验会直接抛错，把恢复路径自己写崩",
    );
    assert.deepEqual(
      Object.keys(manifest.processes),
      ["dispatch"],
      "已确认退出的 fake-cooperative 不应该出现在恢复清单里，只应该记录真正未能退出的那个",
    );

    // 证明"env:stop 能接管"：用同一个共享 terminateProcessGroup 对恢复
    // 清单里记录的进程组升级为 SIGKILL 级别的验证——先证明普通重试确实
    // 拿它没办法（还是 still-alive），再实际清理掉，不留下真正的孤儿。
    const followUp = await terminateProcessGroup(
      {
        name: "dispatch",
        groupPid: manifest.processes.dispatch.groupPid,
        startTime: manifest.processes.dispatch.startTime,
      },
      { maxAttempts: 1, intervalMs: 200 },
    );
    assert.equal(
      followUp.status,
      "still-alive",
      "恢复清单里的记录必须真实可用——用它发起的终止尝试应该作用于同一个真实进程",
    );
  } finally {
    // 清理：测试自己负责收尾，不留下真正的孤儿或残留 manifest。
    try {
      process.kill(-stubbornChild.pid, "SIGKILL");
    } catch {
      // 已经不在了。
    }
    if (manifestExists()) deleteManifest();
  }
});

test("cleanupAndRecoverPartialStart：组长先于孙进程退出时，恢复清单仍能被保存，env:stop 层面的接管仍然作用于同一个 PGID（N4 round 3 最后一个 P1，端到端）", async () => {
  // 和上一条测试的区别：这里组长本身在 cleanupAndRecoverPartialStart 被调用
  // 之前就已经先退出了（真实场景：包装命令启动孙进程后自己先退出，孙进程
  // 继续留在同一个 PGID 里）。这是修复前旧实现最容易完全漏判的情况——旧的
  // "already-gone" 判断只看组长，组长不在就直接当成"整组都已消失"，连
  // SIGTERM 都不会发一次，更不会有恢复清单。
  const leader = spawn(
    "bash",
    [
      "-c",
      "node -e \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\" & disown; exit 0",
    ],
    { detached: true, stdio: "ignore" },
  );
  leader.unref();
  const groupPid = leader.pid;

  await new Promise((resolve) => setTimeout(resolve, 800));
  const grandchildPid = processesInGroup(groupPid).find((pid) => pid !== groupPid);
  assert.equal(processStartTime(groupPid), null, "前提：组长应该已经退出");
  assert.ok(grandchildPid && isAlive(grandchildPid), "前提：孙进程应该仍然存活");

  try {
    await cleanupAndRecoverPartialStart(
      [{ name: "dispatch", groupPid, startTime: undefined }],
      new Error("模拟的启动失败：组长先于孙进程退出"),
    );

    assert.ok(
      isAlive(grandchildPid),
      "孙进程理应仍然存活——回滚阶段必须真的检测到并尝试终止这个 PGID，而不是因为组长已经不在就当场放过",
    );
    assert.equal(manifestExists(), true, "组内仍有存活成员时必须保留恢复清单");
    const manifest = readManifest();
    assert.equal(manifest.status, "partial");
    assert.equal(manifest.processes.dispatch.groupPid, groupPid);

    // 模拟 env:stop：用恢复清单里记录的 groupPid 再次发起终止，必须仍然
    // 作用于同一个真实进程组（孙进程仍在，端口未知——但组内成员检查本身
    // 就足够识别出它没有退出）。
    const followUp = await terminateProcessGroup(
      { name: "dispatch", groupPid: manifest.processes.dispatch.groupPid, startTime: undefined },
      { maxAttempts: 1, intervalMs: 200 },
    );
    assert.equal(
      followUp.status,
      "still-alive",
      "env:stop 用恢复清单里的记录重新尝试终止时，必须仍然识别出这个 PGID 里还有存活成员",
    );
  } finally {
    try {
      process.kill(-groupPid, "SIGKILL");
    } catch {
      // 已经不在了。
    }
    if (manifestExists()) deleteManifest();
  }
});
