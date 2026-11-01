import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { once } from "node:events";
import { runtimeConfigSchema } from "../../src/runtime/config.js";
import { ownerDir } from "../../src/cli/files.js";

const node = process.execPath;
const entry = resolve("dist/cli/entry.js");
const installedManifest = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
) as { name: string; version: string };
const canRunBuiltConsumer = existsSync(entry);
const mechanismConfigSupported = runtimeConfigSchema.safeParse({
  version: 1,
  dataDir: "/tmp/zorya-cli-profile-data",
  roots: [{ id: "project", path: "/tmp/zorya-cli-profile-root" }],
  mechanism: { code: { secret: { kind: "env", name: "VOYAGE_CODE_KEY" } } },
}).success;
function run(args: string[], cwd = process.cwd()) {
  return new Promise<{ code: number | null; out: string; err: string }>(
    (resolvePromise, reject) => {
      const child = spawn(node, [entry, ...args], {
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
  "packed-style CLI consumer setup, doctor, index, search, context, MCP, and owner stop",
  {
    timeout: 120_000,
    skip: !canRunBuiltConsumer
      ? "Run pnpm build before the built-consumer test; fresh-checkout package tests do not depend on dist."
      : false,
  },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "zorya-cli-consumer-"));
    const repo = join(dir, "repo"),
      second = join(dir, "second"),
      data = join(dir, "state", "data"),
      config = join(dir, "config", "config.json");
    await mkdir(repo, { recursive: true });
    await mkdir(second, { recursive: true });
    await writeFile(
      join(repo, "search-fixture.ts"),
      'export function searchableMarker(){ return "winter-orchid" }\n',
    );
    await writeFile(
      join(second, "secondary.ts"),
      'export function secondaryMarker(){ return "moonstone" }\n',
    );
    const common = ["--config", config];
    const transports: StdioClientTransport[] = [];
    try {
      assert.equal(installedManifest.name, "@zorya/search");
      const versionResult = await run(["--version"], dir);
      assert.equal(versionResult.code, 0, versionResult.err);
      assert.equal(versionResult.out.trim(), installedManifest.version);
      let r = await run([
        "setup",
        "--root",
        repo,
        "--data",
        data,
        "--exclude",
        "docs/evidence/**",
        "--max-files",
        "20000",
        "--max-chunks",
        "50000",
        "--max-scan-chunks",
        "50000",
        ...common,
      ]);
      assert.equal(r.code, 0, r.err);
      assert.equal(JSON.parse(r.out).providerCalls, 0);
      const symlinkRoot = join(dir, "repo-link");
      await symlink(repo, symlinkRoot, "dir");
      r = await run([
        "setup",
        "--root",
        repo,
        "--data",
        join(dir, "symlink-state"),
        "--config",
        join(symlinkRoot, ".must-not-create", "config.json"),
      ]);
      assert.equal(r.code, 1);
      assert.match(r.err, /STATE_MUST_BE_OUTSIDE_ROOT/);
      await assert.rejects(
        readFile(join(repo, ".must-not-create", "config.json")),
      );
      r = await run([
        "setup",
        "--root",
        repo,
        "--data",
        join(repo, "..example"),
        "--config",
        join(dir, "dotdot-config", "config.json"),
      ]);
      assert.equal(r.code, 1);
      assert.match(r.err, /STATE_MUST_BE_OUTSIDE_ROOT/);
      await assert.rejects(readFile(join(repo, "..example")));
      const configText = await readFile(config, "utf8");
      assert.doesNotMatch(configText, /sk-[A-Za-z0-9]{10,}/);
      assert.ok(configText.includes("docs/evidence/**"));
      assert.match(configText, /50000/);
      const webTextDefaultConfig = join(dir, "web-text-default-config", "config.json");
      r = await run([
        "setup",
        "--root",
        repo,
        "--data",
        join(dir, "web-text-default-state"),
        "--web-env",
        "BRAVE_KEY",
        "--web-embedding-model",
        "fixture-web-text-model",
        "--web-embedding-dimensions",
        "3",
        "--web-embedding-env",
        "WEB_TEXT_KEY",
        "--config",
        webTextDefaultConfig,
      ]);
      assert.equal(r.code, 0, r.err);
      const webTextDefault = JSON.parse(await readFile(webTextDefaultConfig, "utf8"));
      assert.deepEqual(webTextDefault.web.embedding, {
        provider: "openrouter",
        model: "fixture-web-text-model",
        dimensions: 3,
        secret: { kind: "env", name: "WEB_TEXT_KEY" },
      });

      const webTextConfig = join(dir, "web-text-config", "config.json");
      r = await run([
        "setup",
        "--root",
        repo,
        "--data",
        join(dir, "web-text-state"),
        "--web-env",
        "BRAVE_KEY",
        "--web-embedding-profile",
        "owner-web-text-profile",
        "--web-embedding-model",
        "owner-web-text-model",
        "--web-embedding-dimensions",
        "3",
        "--web-embedding-endpoint",
        "https://embeddings.example.test/v1",
        "--web-embedding-env",
        "WEB_TEXT_KEY",
        "--config",
        webTextConfig,
      ]);
      assert.equal(r.code, 0, r.err);
      assert.equal(JSON.parse(r.out).providerCalls, 0);
      const webText = JSON.parse(await readFile(webTextConfig, "utf8"));
      assert.deepEqual(webText.web, {
        discovery: { secret: { kind: "env", name: "BRAVE_KEY" } },
        embedding: {
          provider: "openai-compatible",
          profileId: "owner-web-text-profile",
          model: "owner-web-text-model",
          dimensions: 3,
          baseUrl: "https://embeddings.example.test/v1",
          secret: { kind: "env", name: "WEB_TEXT_KEY" },
        },
      });
      const partialWebTextConfig = join(dir, "partial-web-text-config", "config.json");
      r = await run([
        "setup",
        "--root",
        repo,
        "--data",
        join(dir, "partial-web-text-state"),
        "--web-env",
        "BRAVE_KEY",
        "--web-embedding-profile",
        "owner-web-text-profile",
        "--web-embedding-model",
        "fixture-web-text-model",
        "--web-embedding-dimensions",
        "3",
        "--web-embedding-env",
        "WEB_TEXT_KEY",
        "--config",
        partialWebTextConfig,
      ]);
      assert.equal(r.code, 1);
      assert.match(r.err, /WEB_EMBEDDING_CUSTOM_OPTIONS_PAIRED/);
      await assert.rejects(readFile(partialWebTextConfig));
      const watchConfig = join(dir, "watch-config", "config.json");
      r = await run([
        "setup",
        "--root",
        repo,
        "--data",
        join(dir, "watch-state"),
        "--watch",
        "--watch-interval-ms",
        "1500",
        "--config",
        watchConfig,
      ]);
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(
        JSON.parse(await readFile(watchConfig, "utf8")).roots[0],
        {
          id: "project",
          path: await realpath(repo),
          watch: true,
          watchIntervalMs: 1500,
        },
      );
      const invalidWatchConfig = join(dir, "invalid-watch", "config.json");
      r = await run([
        "setup",
        "--root",
        repo,
        "--data",
        join(dir, "invalid-watch-state"),
        "--watch-interval-ms",
        "1500",
        "--config",
        invalidWatchConfig,
      ]);
      assert.equal(r.code, 1);
      assert.match(r.err, /WATCH_REQUIRES_OPT_IN/);
      await assert.rejects(readFile(invalidWatchConfig));
      r = await run([
        "setup",
        "--root",
        repo,
        "--data",
        join(dir, "invalid-watch-bool-state"),
        "--watch",
        "false",
        "--config",
        join(dir, "invalid-watch-bool", "config.json"),
      ]);
      assert.equal(r.code, 1);
      assert.match(r.err, /WATCH_FLAG_INVALID/);
      r = await run([
        "root-add",
        "--root-id",
        "secondary",
        "--root",
        second,
        "--watch",
        "--watch-interval-ms",
        "1250",
        ...common,
      ]);
      assert.equal(r.code, 0, r.err);
      const watchedProfile = JSON.parse(await readFile(config, "utf8"));
      assert.deepEqual(
        watchedProfile.roots.find(
          (root: { id: string }) => root.id === "secondary",
        ),
        { id: "secondary", path: await realpath(second), watch: true, watchIntervalMs: 1250 },
      );
      const parallelAPath = join(dir, "parallel-a");
      const parallelBPath = join(dir, "parallel-b");
      await mkdir(parallelAPath);
      await mkdir(parallelBPath);
      const concurrentRoots = await Promise.all([
        run([
          "root-add",
          "--root-id",
          "parallel-a",
          "--root",
          parallelAPath,
          ...common,
        ]),
        run([
          "root-add",
          "--root-id",
          "parallel-b",
          "--root",
          parallelBPath,
          ...common,
        ]),
      ]);
      const successfulRootAdds = concurrentRoots.filter(
        (result) => result.code === 0,
      );
      assert.ok(successfulRootAdds.length >= 1);
      for (const failed of concurrentRoots.filter(
        (result) => result.code !== 0,
      ))
        assert.match(
          failed.err,
          /CONFIG_UPDATE_BUSY|ROOT_ALREADY_CONFIGURED_OR_INVALID/,
        );
      const currentConfig = JSON.parse(await readFile(config, "utf8"));
      const addedRootIds = currentConfig.roots.map(
        (root: { id: string }) => root.id,
      );
      assert.ok(addedRootIds.includes("secondary"));
      for (const result of successfulRootAdds) {
        const added = JSON.parse(result.out) as { rootId: string };
        assert.ok(addedRootIds.includes(added.rootId));
      }
      const legacyConfig = join(dir, "legacy-config", "config.json");
      const cloudConfig = join(dir, "cloud-config", "config.json");
      if (mechanismConfigSupported) {
        r = await run([
          "setup",
          "--root",
          repo,
          "--data",
          join(dir, "legacy-state"),
          "--embedding-env",
          "LEGACY_CODE_KEY",
          "--config",
          legacyConfig,
        ]);
        assert.equal(r.code, 0, r.err);
        const legacy = JSON.parse(await readFile(legacyConfig, "utf8"));
        assert.deepEqual(legacy.mechanism.code.secret, {
          kind: "env",
          name: "LEGACY_CODE_KEY",
        });
        r = await run([
          "setup",
          "--root",
          repo,
          "--data",
          join(dir, "cloud-state"),
          "--code-env",
          "VOYAGE_CODE_KEY",
          "--visual-env",
          "VOYAGE_VISUAL_KEY",
          "--config",
          cloudConfig,
        ]);
        assert.equal(r.code, 0, r.err);
        const cloud = JSON.parse(await readFile(cloudConfig, "utf8"));
        assert.deepEqual(cloud.mechanism, {
          code: { secret: { kind: "env", name: "VOYAGE_CODE_KEY" } },
          visual: { secret: { kind: "env", name: "VOYAGE_VISUAL_KEY" } },
        });
        assert.equal(JSON.parse(r.out).providerCalls, 0);
      } else {
        for (const [configPath, args] of [
          [legacyConfig, ["--embedding-env", "LEGACY_CODE_KEY"]],
          [
            cloudConfig,
            [
              "--code-env",
              "VOYAGE_CODE_KEY",
              "--visual-env",
              "VOYAGE_VISUAL_KEY",
            ],
          ],
        ] as const) {
          r = await run([
            "setup",
            "--root",
            repo,
            "--data",
            join(dir, "unvalidated-state"),
            ...args,
            "--config",
            configPath,
          ]);
          assert.equal(r.code, 1);
          assert.match(r.err, /CONFIG_INVALID/);
          await assert.rejects(readFile(configPath));
        }
      }
      const rejected = await run([
        "setup",
        "--embedding-endpoint",
        "https://example.invalid/v1/embeddings",
      ]);
      assert.equal(rejected.code, 1);
      assert.match(rejected.err, /OPTION_UNKNOWN/);
      r = await run(["doctor", ...common]);
      assert.equal(r.code, 0, r.err);
      assert.equal(JSON.parse(r.out).configured, true);
      r = await run(["client-config", ...common]);
      assert.equal(r.code, 0, r.err);
      const clientConfig = JSON.parse(r.out);
      assert.equal(clientConfig.installed.command, process.execPath);
      assert.deepEqual(clientConfig.installed.args, [
        entry,
        "mcp",
        "--config",
        await realpath(config),
      ]);
      assert.deepEqual(clientConfig.installedCodex.args, [
        "mcp",
        "add",
        "zorya-search",
        "--",
        process.execPath,
        ...clientConfig.installed.args,
      ]);
      assert.deepEqual(clientConfig.registry.args, [
        "--yes",
        `@zorya/search@${installedManifest.version}`,
        "mcp",
        "--config",
        await realpath(config),
      ]);
      assert.equal(clientConfig.credentialsIncluded, false);
      const coldClient = new Client(
        { name: "cold-mcp", version: "1.0.0" },
        { versionNegotiation: { mode: "auto" } },
      );
      const coldTransport = new StdioClientTransport({
        command: node,
        args: [entry, "mcp", ...common],
        cwd: dir,
        stderr: "pipe",
      });
      transports.push(coldTransport);
      const coldConnection = coldClient.connect(coldTransport);
      const coldIndex = run(["index", ...common]);
      await coldConnection;
      assert.equal(coldClient.getServerVersion()?.version, installedManifest.version);
      const coldTools = await coldClient.listTools();
      assert.ok(coldTools.tools.some((tool) => tool.name === "search_code"));
      const coldIndexResult = await coldIndex;
      assert.equal(coldIndexResult.code, 0, JSON.stringify(coldIndexResult));
      const backgroundIndex = await run(["index", "--background", ...common]);
      assert.equal(backgroundIndex.code, 0, backgroundIndex.err);
      assert.match(backgroundIndex.out, /"jobId"\s*:/u);
      await coldClient.close();
      await coldTransport.close();
      r = await run(["search", "--query", "searchableMarker", ...common]);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /search-fixture\.ts/);
      r = await run(["context", "--query", "searchableMarker", ...common]);
      assert.equal(r.code, 0, r.err);
      r = await run(["index", "--root-id", "secondary", ...common]);
      assert.equal(r.code, 0, r.err);
      r = await run([
        "search",
        "--root-id",
        "secondary",
        "--query",
        "secondaryMarker",
        ...common,
      ]);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /secondary.ts/);
      r = await run([
        "search",
        "--root-id",
        "missing",
        "--query",
        "never",
        ...common,
      ]);
      assert.equal(r.code, 1);
      const client = new Client(
        { name: "cli-e2e", version: "1.0.0" },
        { versionNegotiation: { mode: "auto" } },
      );
      const transport = new StdioClientTransport({
        command: clientConfig.installed.command,
        args: clientConfig.installed.args,
        cwd: second,
        stderr: "pipe",
      });
      transports.push(transport);
      await client.connect(transport);
      const tools = await client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === "search_code"));
      const response = await client.callTool({
        name: "search_code",
        arguments: { rootId: "secondary", query: "secondaryMarker" },
      });
      assert.notEqual(response.isError, true);
      assert.ok(JSON.stringify(response).includes("secondary.ts"));
      await client.close();
      await transport.close();
      const canonicalConfig = await realpath(config);
      const descriptorPath = join(ownerDir(canonicalConfig), "owner.json"),
        owner = JSON.parse(await readFile(descriptorPath, "utf8")) as {
          pid: number;
        };
      const canary = spawn(node, ["-e", "setInterval(()=>{},1000)"], {
        stdio: "ignore",
      });
      await once(canary, "spawn");
      owner.pid = canary.pid!;
      await writeFile(descriptorPath, JSON.stringify(owner));
      r = await run(["service", "--stop", ...common]);
      assert.equal(r.code, 0, r.err);
      assert.doesNotThrow(() => process.kill(canary.pid!, 0));
      canary.kill("SIGTERM");
      await once(canary, "close");
      r = await run(["doctor", ...common]);
      assert.equal(JSON.parse(r.out).service.running, false);
      r = await run(["search", "--query", "searchableMarker", ...common]);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /search-fixture\.ts/);
      await run(["service", "--stop", ...common]);
      const descriptor = join(ownerDir(canonicalConfig), "owner.json"),
        foreign = join(dir, "foreign.json");
      await writeFile(
        foreign,
        JSON.stringify({
          version: 1,
          pid: process.pid,
          started: "foreign",
          port: 1234,
          tokenFile: "foreign.token",
        }),
      );
      await symlink(foreign, descriptor);
      r = await run(["doctor", ...common]);
      assert.equal(JSON.parse(r.out).service.running, false);
      r = await run(["service", "--stop", ...common]);
      assert.equal(r.code, 1);
      assert.match(r.err, /OWNER_NOT_VERIFIED/);
    } finally {
      for (const transport of transports)
        await transport.close().catch(() => undefined);
      await run(["service", "--stop", ...common]).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  },
);
