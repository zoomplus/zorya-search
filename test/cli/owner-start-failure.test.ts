import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ownerDir } from "../../src/cli/files.js";

const node = process.execPath;
const entry = resolve("dist/cli/entry.js");

function run(args: string[], env = process.env) {
  return new Promise<{ code: number | null; out: string; err: string }>(
    (resolvePromise, reject) => {
      const child = spawn(node, [entry, ...args], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (out += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => (err += chunk));
      child.once("error", reject);
      child.once("close", (code) => resolvePromise({ code, out, err }));
    },
  );
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

test(
  "owner spawn failure is typed, cleans its credentials, and permits retry",
  { timeout: 90_000, skip: !existsSync(entry) ? "Run pnpm build first." : false },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "zorya-owner-spawn-failure-"));
    const root = join(dir, "root");
    const config = join(dir, "config", "config.json");
    const common = ["--config", config];
    const failurePreload = join(dir, "fail-spawn.mjs");
    let ownerPid: number | undefined;
    let primaryError: unknown;
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "fixture.ts"),
      "export const marker = 'spawn-retry-marker';\n",
    );
    await writeFile(
      failurePreload,
      `Object.defineProperty(process, "execPath", { value: ${JSON.stringify(join(dir, "missing-node"))} });\n`,
    );
    try {
      const setup = await run([
        "setup", "--root", root, "--data", join(dir, "data"), ...common,
      ]);
      assert.equal(setup.code, 0, setup.err);

      const state = ownerDir(await realpath(config));
      await mkdir(state, { recursive: true, mode: 0o700 });
      const foreignToken = join(state, "foreign-owner.token");
      const foreignLock = join(state, "foreign-startup.lock");
      await writeFile(foreignToken, "preserve-token\n");
      await writeFile(foreignLock, "preserve-lock\n");
      const failed = await run(["search", "--query", "spawn-retry-marker", ...common], {
        ...process.env,
        NODE_OPTIONS: `--import=${pathToFileURL(failurePreload).href}`,
      });
      assert.equal(failed.code, 1);
      assert.match(failed.err, /OWNER_START_FAILED/);
      assert.doesNotMatch(failed.err, /Unhandled 'error'|EACCES|ENOENT|token|control-/i);

      const names = await readdir(state);
      assert.ok(!names.some((name) => /^(owner|control)-.*\.token$/.test(name)));
      assert.equal(await readFile(foreignToken, "utf8"), "preserve-token\n");
      assert.equal(await readFile(foreignLock, "utf8"), "preserve-lock\n");
      await assert.rejects(readFile(join(state, "startup.lock")));

      const indexed = await run(["index", ...common]);
      assert.equal(indexed.code, 0, indexed.err);
      const searched = await run(["search", "--query", "spawn-retry-marker", ...common]);
      assert.equal(searched.code, 0, searched.err);
      assert.match(searched.out, /fixture\.ts/);
      const status = await run(["service", ...common]);
      assert.equal(status.code, 0, status.err);
      const runningOwner = JSON.parse(status.out) as { running: boolean; pid?: number };
      assert.equal(runningOwner.running, true);
      assert.ok(Number.isInteger(runningOwner.pid) && runningOwner.pid! > 0);
      ownerPid = runningOwner.pid;
      const stopped = await run(["service", "--stop", ...common]);
      assert.equal(stopped.code, 0, stopped.err);
      assert.deepEqual(JSON.parse(stopped.out), { stopped: true });
    } catch (error) {
      primaryError = error;
    }

    let cleanupError: unknown;
    try {
      if (existsSync(config)) {
        const status = await run(["service", ...common]);
        assert.equal(status.code, 0, status.err);
        const currentOwner = JSON.parse(status.out) as { running: boolean; pid?: number };
        if (currentOwner.running) {
          assert.ok(Number.isInteger(currentOwner.pid) && currentOwner.pid! > 0);
          if (ownerPid !== undefined)
            assert.equal(currentOwner.pid, ownerPid, "refusing to stop a replacement owner");
          else ownerPid = currentOwner.pid;
          const stopped = await run(["service", "--stop", ...common]);
          assert.equal(stopped.code, 0, stopped.err);
          assert.deepEqual(JSON.parse(stopped.out), { stopped: true });
        }
      }
      if (ownerPid !== undefined) {
        const deadline = Date.now() + 15_000;
        while (processExists(ownerPid) && Date.now() < deadline)
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        if (processExists(ownerPid))
          throw new Error(`Owner PID ${ownerPid} did not exit; fixture retained at ${dir}`);
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
    } catch (error) {
      cleanupError = error;
    }
    if (primaryError !== undefined && cleanupError !== undefined)
      throw new AggregateError([primaryError, cleanupError], `Test failed and cleanup did not complete; fixture retained at ${dir}`);
    if (cleanupError !== undefined) throw cleanupError;
    if (primaryError !== undefined) throw primaryError;
  },
);
