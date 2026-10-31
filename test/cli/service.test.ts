import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  controlEndpoint,
  ownerReadinessTimeoutMs,
  requestStop,
} from "../../src/cli/service.js";
import { ownerDir } from "../../src/cli/files.js";

const entry = resolve("dist/cli/entry.js");
const canRunBuiltConsumer = existsSync(entry);
function run(args: string[], cwd: string) {
  return new Promise<{ code: number | null; out: string; err: string }>(
    (resolvePromise, reject) => {
      const child = spawn(process.execPath, [entry, ...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "",
        err = "";
      child.stdout.setEncoding("utf8").on("data", (x) => (out += x));
      child.stderr.setEncoding("utf8").on("data", (x) => (err += x));
      child.once("error", reject);
      child.once("close", (code) => resolvePromise({ code, out, err }));
    },
  );
}
test(
  "failed control socket startup closes only its runtime and allows a clean later owner",
  {
    skip: !canRunBuiltConsumer
      ? "Run pnpm build before built-consumer checks."
      : process.platform === "win32"
        ? "Unix socket occupancy fixture is POSIX-specific."
        : false,
    timeout: 60_000,
  },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "zorya-cli-control-failure-"));
    const repo = join(dir, "repo"),
      config = join(dir, "config", "config.json"),
      data = join(dir, "state", "data");
    await mkdir(repo, { recursive: true });
    await writeFile(
      join(repo, "fixture.ts"),
      "export const controlSocketMarker = 1\n",
    );
    const common = ["--config", config];
    let blocker: ReturnType<typeof createServer> | undefined;
    try {
      let result = await run(
        ["setup", "--root", repo, "--data", data, ...common],
        dir,
      );
      assert.equal(result.code, 0, result.err);
      const endpoint = await controlEndpoint(config);
      blocker = createServer();
      blocker.listen(endpoint);
      await once(blocker, "listening");
      result = await run(["serve", ...common], dir);
      assert.equal(result.code, 1);
      assert.match(result.err, /EADDRINUSE|address already in use/i);
      assert.equal(
        await import("node:fs/promises").then((fs) =>
          fs.stat(join(ownerDir(config), "owner.json")).then(
            () => true,
            () => false,
          ),
        ),
        false,
      );
      await new Promise<void>((resolvePromise) =>
        blocker!.close(() => resolvePromise()),
      );
      blocker = undefined;
      await unlink(endpoint).catch(() => undefined);
      result = await run(["index", ...common], dir);
      assert.equal(result.code, 0, result.err);
      result = await run(["service", "--stop", ...common], dir);
      assert.equal(result.code, 0, result.err);
    } finally {
      if (blocker?.listening)
        await new Promise<void>((resolvePromise) =>
          blocker!.close(() => resolvePromise()),
        );
      await run(["service", "--stop", ...common], dir).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("adjacent config profiles receive distinct local owner endpoints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zorya-cli-identities-"));
  try {
    const first = await controlEndpoint(join(directory, "first.json"));
    const second = await controlEndpoint(join(directory, "second.json"));
    assert.notEqual(first, second);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("watch startup readiness is bounded from validated root budgets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zorya-cli-watch-budget-"));
  try {
    const root = join(directory, "root");
    const dataDir = join(directory, "data");
    const config = join(directory, "config.json");
    await mkdir(root);
    await mkdir(dataDir);
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        dataDir,
        roots: [
          {
            id: "watched",
            path: root,
            watch: true,
            limits: { maxFiles: 20, maxChunks: 30, maxScanChunks: 40 },
          },
        ],
      }),
    );
    assert.equal(await ownerReadinessTimeoutMs(config), 61_800);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("owner control peer closing before acknowledgement settles stop request", async () => {
  const server = createServer((socket) => {
    socket.once("data", () => socket.end());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const started = Date.now();
    assert.equal(
      await requestStop(`127.0.0.1:${address.port}`, "control-secret"),
      false,
    );
    assert.ok(Date.now() - started < 1000);
  } finally {
    await new Promise<void>((resolvePromise) =>
      server.close(() => resolvePromise()),
    );
  }
});
