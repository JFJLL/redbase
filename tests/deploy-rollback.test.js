// 首次部署安全：deploy-rollback 编排的机器可判测试。
// 覆盖任务要求的五项：
//   1. 首次部署（无 dist 备份）可回退 legacy public；
//   2. 已有 dist/public 备份时可恢复旧产物；
//   3. 源码 SHA 回退命令实际被调用；
//   4. 烟测失败后的第二次烟测验证的是旧版本（发生在 pm2 restart 之后）；
//   5. 测试/构建/预算失败路径不触碰线上目录与源码 SHA（配合
//      tests/build-frontend-modes.test.js 的目录不变断言）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { restoreFrontendArtifacts, runDeployRollback, SMOKE_PATHS } = require("../scripts/deploy-rollback.cjs");

const OLD_SHA = "af820d50ab340dfef4211b9b06b603e7e46a2bbb";

function makeDist({ withTarget = true, withBackup = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "redbase-rollback-"));
  const distDir = path.join(base, "dist");
  const targetDir = path.join(distDir, "public");
  const backupDir = path.join(distDir, ".public-previous");
  fs.mkdirSync(distDir, { recursive: true });
  if (withTarget) {
    fs.mkdirSync(path.join(targetDir, "app"), { recursive: true });
    fs.mkdirSync(path.join(targetDir, "admin"), { recursive: true });
    fs.writeFileSync(path.join(targetDir, "index.html"), "NEW build");
    fs.writeFileSync(path.join(targetDir, "app", "index.html"), "NEW app");
    fs.writeFileSync(path.join(targetDir, "admin", "index.html"), "NEW admin");
  }
  if (withBackup) {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, "index.html"), "OLD build");
  }
  return { distDir, targetDir, backupDir };
}

function makeExecRecorder(failures = {}) {
  const calls = [];
  const exec = (command, args) => {
    calls.push([command, ...args].join(" "));
    const key = command;
    return { status: failures[key] ?? 0 };
  };
  return { calls, exec };
}

test("first deploy without dist backup falls back to legacy public", async () => {
  const { distDir, targetDir, backupDir } = makeDist({ withTarget: true, withBackup: false });
  const { calls, exec } = makeExecRecorder();
  const result = await runDeployRollback({
    oldSha: OLD_SHA,
    backupDir,
    distDir,
    targetDir,
    exec,
    smoke: async () => true,
    now: 12345,
  });

  assert.equal(result.mode, "legacy-public");
  // 失败的新 dist 被移走（保留待查），dist/public 不复存在 → 静态层回退旧 public。
  assert.equal(fs.existsSync(targetDir), false);
  assert.ok(result.movedAsideDir && fs.existsSync(result.movedAsideDir));
  assert.equal(fs.readFileSync(path.join(result.movedAsideDir, "index.html"), "utf8"), "NEW build");
  assert.ok(calls.some((call) => call.startsWith("git checkout --detach")));
});

test("with an existing backup the old dist/public artifacts are restored", async () => {
  const { distDir, targetDir, backupDir } = makeDist({ withTarget: true, withBackup: true });
  const { exec } = makeExecRecorder();
  const result = await runDeployRollback({
    oldSha: OLD_SHA,
    backupDir,
    distDir,
    targetDir,
    exec,
    smoke: async () => true,
  });

  assert.equal(result.mode, "backup");
  assert.equal(fs.readFileSync(path.join(targetDir, "index.html"), "utf8"), "OLD build");
  assert.equal(fs.existsSync(backupDir), false);
});

test("the source SHA checkout command is actually invoked, before npm ci and pm2", async () => {
  const { distDir, targetDir, backupDir } = makeDist({ withTarget: true, withBackup: true });
  const { calls, exec } = makeExecRecorder();
  await runDeployRollback({ oldSha: OLD_SHA, backupDir, distDir, targetDir, exec, smoke: async () => true });

  assert.deepEqual(calls, [
    `git checkout --detach ${OLD_SHA}`,
    "npm ci",
    "pm2 restart redbase",
  ]);
});

test("the second smoke run verifies the OLD version: it happens after restart and its result is reported", async () => {
  const { distDir, targetDir, backupDir } = makeDist({ withTarget: true, withBackup: true });
  const order = [];
  const exec = (command, args) => {
    order.push([command, ...args].join(" "));
    return { status: 0 };
  };
  let smokedAfterRestart = false;
  const result = await runDeployRollback({
    oldSha: OLD_SHA,
    backupDir,
    distDir,
    targetDir,
    exec,
    smoke: async () => {
      // 烟测时源码已在 OLD_SHA、依赖已恢复、服务已重启 —— 验证对象是旧版本。
      smokedAfterRestart = order.includes("pm2 restart redbase");
      assert.equal(order.at(-1), "pm2 restart redbase");
      assert.equal(fs.readFileSync(path.join(targetDir, "index.html"), "utf8"), "OLD build");
      return false;
    },
  });

  assert.equal(smokedAfterRestart, true);
  assert.equal(result.healthy, false);
  assert.deepEqual(result.steps.at(-1), { step: "smoke-old-version", healthy: false });
});

test("an invalid OLD_SHA aborts before any frontend or source mutation", async () => {
  const { distDir, targetDir, backupDir } = makeDist({ withTarget: true, withBackup: true });
  const { calls, exec } = makeExecRecorder();
  await assert.rejects(
    () => runDeployRollback({ oldSha: "; rm -rf /", backupDir, distDir, targetDir, exec, smoke: async () => true }),
    /valid OLD_SHA/,
  );
  assert.equal(calls.length, 0);
  assert.equal(fs.readFileSync(path.join(targetDir, "index.html"), "utf8"), "NEW build");
});

test("restoreFrontendArtifacts alone never touches git state (frontend-only step is side-effect scoped)", () => {
  const { distDir, targetDir, backupDir } = makeDist({ withTarget: true, withBackup: true });
  const result = restoreFrontendArtifacts({ backupDir, distDir, targetDir });
  assert.equal(result.mode, "backup");
  assert.equal(fs.readFileSync(path.join(targetDir, "index.html"), "utf8"), "OLD build");
});

test("deploy pipeline never mutates source SHA on test/build/budget failures (rollback is the only SHA-touching step and runs after smoke)", () => {
  // 机器可判：deploy-server.sh 中改动源码 SHA 的命令只存在于 deploy-rollback
  // 调用（第 9 步，烟测失败分支）；promote 之前的任何失败路径都不会经过它。
  const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "deploy-server.sh"), "utf8");
  assert.doesNotMatch(script, /git (checkout|reset)/);
  const rollbackCalls = script.match(/deploy-rollback\.cjs/g) || [];
  assert.equal(rollbackCalls.length, 1);
  const smokeFailIndex = script.indexOf("smoke checks failed");
  const rollbackIndex = script.indexOf("deploy-rollback.cjs");
  const promoteIndex = script.indexOf("--promote");
  assert.ok(smokeFailIndex > -1 && rollbackIndex > smokeFailIndex);
  assert.ok(promoteIndex > -1 && promoteIndex < smokeFailIndex);
  // OLD_SHA 在 pull 之前捕获，保证回滚目标是部署前的提交。
  assert.ok(script.indexOf("OLD_SHA=\"$(git rev-parse HEAD)\"") < script.indexOf("git pull --ff-only"));
});

test("smoke path list matches the four required routes", () => {
  assert.deepEqual(SMOKE_PATHS, ["/api/health", "/", "/app/", "/admin/"]);
});
