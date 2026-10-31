#!/usr/bin/env node
import { realpath, mkdir, lstat, open, unlink } from "node:fs/promises";
import { dirname, resolve, join, isAbsolute } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  defaultConfigPath,
  defaultDataDir,
  canonicalConfigPath,
  ownerDir,
  pathWithin,
  readConfig,
  writePrivateFile,
} from "./files.js";
import { createSetupConfig, setupMode } from "./setup-config.js";
import { parseRuntimeConfig } from "../runtime/config.js";
import { canonicalFuturePath } from "../runtime/path.js";
import { ensureOwner, runOwner, serviceStatus, stopOwner } from "./service.js";

const CLI_VERSION = "0.1.0";
const cliEntryPath = fileURLToPath(import.meta.url);
const help = `Zorya Search — локальный поиск по коду и источникам

Использование: zorya-search <команда> [параметры]

Команды:
  setup          создать локальную конфигурацию (можно задать --code-env NAME)
  doctor         проверить конфигурацию и локальный владелец
  index          построить индекс настроенного корня
  search         искать в коде (--query ТЕКСТ)
  context        собрать контекст (--query ТЕКСТ)
  serve          запустить владельца службы в foreground
  mcp            подключить stdio MCP к общей локальной службе
  client-config  вывести команду подключения Codex и JSON для совместимого клиента
  root-add       добавить разрешённый корень в конфигурацию
  service        проверить службу или остановить только подтверждённого владельца

Параметры: --config ПУТЬ, --root ПУТЬ, --query ТЕКСТ, --mode lexical|hybrid

По умолчанию поиск lexical локален. Включение облачных embeddings отправляет выбранные
фрагменты кода при индексировании, а запросы — при поиске. Этот CLI не исправляет файлы,
не меняет prompt или модель клиента и не устанавливает MCP в клиент автоматически.
`;
function parse(args: string[]) {
  const command = args[0]?.startsWith("--") ? "help" : (args[0] ?? "help");
  const start = args[0]?.startsWith("--") ? 0 : 1;
  const opts: Record<string, string | boolean> = {};
  for (let i = start; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const n = args[i + 1];
      if (n && !n.startsWith("--")) {
        opts[k] = n;
        i++;
      } else opts[k] = true;
    } else throw new Error("ARGUMENT_INVALID");
  }
  return { command, opts };
}
function json(value: unknown) {
  stdout.write(JSON.stringify(value, null, 2) + "\n");
}
function get(
  opts: Record<string, string | boolean>,
  key: string,
  fallback?: string,
) {
  const v = opts[key];
  if (typeof v === "string") return v;
  if (fallback) return fallback;
  throw new Error(`OPTION_REQUIRED:${key}`);
}
async function setup(opts: Record<string, string | boolean>) {
  const configPath = await canonicalConfigPath(
    resolve(get(opts, "config", defaultConfigPath())),
  );
  const rootPath = await realpath(resolve(get(opts, "root", process.cwd())));
  const rootInfo = await lstat(rootPath);
  if (!rootInfo.isDirectory()) throw new Error("ROOT_INVALID");
  const configDir = dirname(configPath);
  const dataDir = await canonicalFuturePath(
    resolve(get(opts, "data", defaultDataDir())),
  );
  if (
    pathWithin(rootPath, configPath) ||
    pathWithin(rootPath, dataDir) ||
    pathWithin(dataDir, rootPath)
  )
    throw new Error("STATE_MUST_BE_OUTSIDE_ROOT");
  const existing = await lstat(configPath).catch(() => undefined);
  if (existing)
    throw new Error(
      "CONFIG_ALREADY_EXISTS; use --config with a new path or edit the existing file explicitly",
    );

  const rootId = String(opts["root-id"] ?? "project");
  const rootLimits: Record<string, number> = {};
  for (const [option, key] of [
    ["max-files", "maxFiles"],
    ["max-chunks", "maxChunks"],
    ["max-scan-chunks", "maxScanChunks"],
  ] as const) {
    if (typeof opts[option] === "string")
      rootLimits[key] = Number(opts[option]);
  }
  const exclude =
    typeof opts.exclude === "string"
      ? opts.exclude.split(",").filter(Boolean)
      : undefined;
  const watchIntervalMs =
    typeof opts["watch-interval-ms"] === "string"
      ? Number(opts["watch-interval-ms"])
      : undefined;
  if (opts.watch !== undefined && opts.watch !== true)
    throw new Error("WATCH_FLAG_INVALID");
  if (watchIntervalMs !== undefined && opts.watch !== true)
    throw new Error("WATCH_REQUIRES_OPT_IN");
  if (
    watchIntervalMs !== undefined &&
    (!Number.isInteger(watchIntervalMs) ||
      watchIntervalMs < 250 ||
      watchIntervalMs > 60_000)
  )
    throw new Error("WATCH_INTERVAL_INVALID");
  const explicitCodeEnv =
    typeof opts["code-env"] === "string" ? opts["code-env"] : undefined;
  const legacyCodeEnv =
    typeof opts["embedding-env"] === "string"
      ? opts["embedding-env"]
      : undefined;
  if (explicitCodeEnv && legacyCodeEnv)
    throw new Error("CODE_ENV_ALIAS_CONFLICT");
  let codeEnv = explicitCodeEnv ?? legacyCodeEnv;
  let visualEnv =
    typeof opts["visual-env"] === "string" ? opts["visual-env"] : undefined;
  const webEnv =
    typeof opts["web-env"] === "string" ? opts["web-env"] : undefined;
  const customKeys = [
    "custom-embedding-profile",
    "custom-embedding-model",
    "custom-embedding-dimensions",
    "custom-embedding-endpoint",
    "custom-embedding-env",
  ];
  const hasCustom = customKeys.some((key) => opts[key] !== undefined);
  const customEmbedding = hasCustom
    ? {
        profileId: get(opts, "custom-embedding-profile"),
        model: get(opts, "custom-embedding-model"),
        dimensions: Number(get(opts, "custom-embedding-dimensions")),
        baseUrl: get(opts, "custom-embedding-endpoint"),
        env: get(opts, "custom-embedding-env"),
      }
    : undefined;
  const pairedModel = (modelKey: string, envKey: string, code: string) => {
    const model =
      typeof opts[modelKey] === "string" ? String(opts[modelKey]) : undefined;
    const env =
      typeof opts[envKey] === "string" ? String(opts[envKey]) : undefined;
    if (model === undefined && env === undefined) return undefined;
    if (!model || !env) throw new Error(code);
    return { model, env };
  };
  const webReranker = pairedModel(
    "web-reranker-model",
    "web-reranker-env",
    "WEB_RERANKER_MODEL_AND_ENV_REQUIRED",
  );
  const classifier = pairedModel(
    "classifier-model",
    "classifier-env",
    "CLASSIFIER_MODEL_AND_ENV_REQUIRED",
  );
  if (
    opts.interactive ||
    (stdin.isTTY && stdout.isTTY && !opts["non-interactive"])
  ) {
    stderr.write(
      "Lexical поиск остаётся локальным. Кодовый поиск отправляет индексируемый код и запросы провайдеру; visual может отправлять выбранные изображения и текст. При включённом watch изменения будут повторно индексироваться и отправляться выбранному провайдеру. Возможны расходы. В конфигурацию попадут только имена env-переменных, а не секреты.\n",
    );
    const rl = createInterface({ input: stdin, output: stderr });
    try {
      const acceptedRoot = await rl.question(
        `Будет настроен корень ${rootPath}. Продолжить? [Y/n] `,
      );
      if (["n", "no", "нет"].includes(acceptedRoot.trim().toLowerCase()))
        throw new Error("SETUP_CANCELLED");
      const mode = (
        await rl.question(
          "Режим: lexical, code, code+visual или visual? [lexical] ",
        )
      )
        .trim()
        .toLowerCase();
      if (mode === "code" || mode === "code+visual")
        codeEnv = await rl.question("Имя env-переменной для code provider: ");
      if (mode === "visual" || mode === "code+visual")
        visualEnv = await rl.question(
          "Имя env-переменной для visual provider: ",
        );
      const watchAnswer = (
        await rl.question(
          "Автоматически переиндексировать изменения файлов? [y/N] ",
        )
      )
        .trim()
        .toLowerCase();
      if (["y", "yes", "да"].includes(watchAnswer)) opts.watch = true;
    } finally {
      rl.close();
    }
  }
  if (codeEnv !== undefined && !codeEnv.trim())
    throw new Error("ENV_NAME_INVALID");
  if (visualEnv !== undefined && !visualEnv.trim())
    throw new Error("ENV_NAME_INVALID");
  const config = createSetupConfig({
    dataDir,
    root: {
      id: rootId,
      path: rootPath,
      ...(exclude ? { exclude } : {}),
      ...(Object.keys(rootLimits).length ? { limits: rootLimits } : {}),
      ...(opts.watch === true ? { watch: true } : {}),
      ...(watchIntervalMs !== undefined ? { watchIntervalMs } : {}),
    },
    ...(codeEnv ? { codeEnv } : {}),
    ...(visualEnv ? { visualEnv } : {}),
    ...(webEnv ? { webEnv } : {}),
    ...(webReranker ? { webReranker } : {}),
    ...(classifier ? { classifier } : {}),
    ...(customEmbedding ? { customEmbedding } : {}),
  });
  parseRuntimeConfig(config);

  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const configDirInfo = await (
    await import("node:fs/promises")
  ).stat(configDir);
  if (process.platform !== "win32" && (configDirInfo.mode & 0o077) !== 0)
    throw new Error("CONFIG_DIR_PERMISSIONS_UNSAFE");
  if ((await realpath(configDir)) !== configDir)
    throw new Error("CONFIG_DIR_UNSAFE");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const dataDirInfo = await (await import("node:fs/promises")).stat(dataDir);
  if (process.platform !== "win32" && (dataDirInfo.mode & 0o077) !== 0)
    throw new Error("DATA_DIR_PERMISSIONS_UNSAFE");
  if ((await realpath(dataDir)) !== dataDir) throw new Error("DATA_DIR_UNSAFE");
  await writePrivateFile(configPath, JSON.stringify(config, null, 2) + "\n");
  json({
    configured: true,
    configPath,
    root: rootPath,
    dataDir,
    mode: setupMode(config),
    providerCalls: 0,
  });
}

async function withOwnerStartupLock<T>(
  configPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const directory = ownerDir(configPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await realpath(directory)) !== directory)
    throw new Error("OWNER_DIR_UNSAFE");
  const directoryInfo = await lstat(directory);
  if (process.platform !== "win32" && (directoryInfo.mode & 0o077) !== 0)
    throw new Error("OWNER_DIR_PERMISSIONS_UNSAFE");
  const lockPath = join(directory, "startup.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch {
    throw new Error("CONFIG_UPDATE_BUSY");
  }
  const identity = await handle.stat();
  try {
    return await operation();
  } finally {
    await handle.close();
    const current = await lstat(lockPath).catch(() => undefined);
    if (current?.dev === identity.dev && current.ino === identity.ino)
      await unlink(lockPath).catch(() => undefined);
  }
}

async function withClient(
  configPath: string,
  fn: (client: Client, rootId: string) => Promise<unknown>,
) {
  const { owner, token } = await ensureOwner(configPath);
  const config = await readConfig(configPath);
  const rootId = config.config.roots[0]!.id;
  const client = new Client(
    { name: "zorya-search-cli", version: CLI_VERSION },
    { versionNegotiation: { mode: "auto" } },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${owner.port}/mcp`),
        {
          requestInit: {
            headers: { Authorization: `Bearer ${token}` },
            redirect: "error",
          },
        },
      ),
    );
    return await fn(client, rootId);
  } finally {
    await client.close();
  }
}
async function main() {
  const { command, opts } = parse(process.argv.slice(2));
  if (command === "version" || opts.version) {
    stdout.write(`${CLI_VERSION}\n`);
    return;
  }
  if (command === "help" || opts.help) {
    stdout.write(help);
    return;
  }
  const configPath = await canonicalConfigPath(
    resolve(get(opts, "config", defaultConfigPath())),
  );
  const allowed: Record<string, string[]> = {
    setup: [
      "config",
      "root",
      "data",
      "root-id",
      "max-files",
      "max-chunks",
      "max-scan-chunks",
      "exclude",
      "watch",
      "watch-interval-ms",
      "code-env",
      "embedding-env",
      "visual-env",
      "web-env",
      "web-reranker-model",
      "web-reranker-env",
      "classifier-model",
      "classifier-env",
      "custom-embedding-profile",
      "custom-embedding-model",
      "custom-embedding-dimensions",
      "custom-embedding-endpoint",
      "custom-embedding-env",
      "interactive",
      "non-interactive",
    ],
    serve: ["config", "token-file", "control-file"],
    "client-config": ["config"],
    doctor: ["config"],
    "root-add": ["config", "root-id", "root", "watch", "watch-interval-ms"],
    service: ["config", "stop"],
    mcp: ["config"],
    index: ["config", "root-id"],
    search: ["config", "root-id", "query", "mode"],
    context: ["config", "root-id", "query"],
  };
  if (!allowed[command]) throw new Error("COMMAND_UNKNOWN");
  const unknown = Object.keys(opts).find(
    (key) =>
      !["help", "version"].includes(key) && !allowed[command]!.includes(key),
  );
  if (unknown) throw new Error(`OPTION_UNKNOWN:${unknown}`);
  if (command === "setup") {
    await setup(opts);
    return;
  }
  if (command === "serve") {
    await runOwner(
      configPath,
      typeof opts["token-file"] === "string"
        ? get(opts, "token-file")
        : undefined,
      typeof opts["control-file"] === "string"
        ? get(opts, "control-file")
        : undefined,
    );
    return;
  }
  if (command === "client-config") {
    const installed = {
      command: process.execPath,
      args: [cliEntryPath, "mcp", "--config", configPath],
    };
    const registry = {
      command: "npx",
      args: [
        "--yes",
        `@zorya/search@${CLI_VERSION}`,
        "mcp",
        "--config",
        configPath,
      ],
    };
    json({
      installed,
      installedCodex: {
        command: "codex",
        args: [
          "mcp",
          "add",
          "zorya-search",
          "--",
          installed.command,
          ...installed.args,
        ],
      },
      registry,
      registryCodex: {
        command: "codex",
        args: [
          "mcp",
          "add",
          "zorya-search",
          "--",
          registry.command,
          ...registry.args,
        ],
      },
      configPath,
      credentialsIncluded: false,
    });
    return;
  }
  if (command === "doctor") {
    const status = await serviceStatus(configPath);
    let configured = false;
    try {
      await readConfig(configPath);
      configured = true;
    } catch {}
    json({
      installed: true,
      configured,
      service: status,
      authenticated: status.running,
      providerProbed: false,
      providerProbe: "not-run",
      databaseMetrics: "unknown",
    });
    return;
  }
  if (command === "root-add") {
    const id = get(opts, "root-id");
    const path = await realpath(resolve(get(opts, "root")));
    const watchIntervalMs =
      typeof opts["watch-interval-ms"] === "string"
        ? Number(opts["watch-interval-ms"])
        : undefined;
    if (opts.watch !== undefined && opts.watch !== true)
      throw new Error("WATCH_FLAG_INVALID");
    if (watchIntervalMs !== undefined && opts.watch !== true)
      throw new Error("WATCH_REQUIRES_OPT_IN");
    if (
      watchIntervalMs !== undefined &&
      (!Number.isInteger(watchIntervalMs) ||
        watchIntervalMs < 250 ||
        watchIntervalMs > 60_000)
    )
      throw new Error("WATCH_INTERVAL_INVALID");
    const result = await withOwnerStartupLock(configPath, async () => {
      if ((await serviceStatus(configPath)).running)
        throw new Error("STOP_SERVICE_BEFORE_PROFILE_CHANGE");
      const loaded = await readConfig(configPath);
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) ||
        loaded.config.roots.length >= 32 ||
        loaded.config.roots.some((root) => root.id === id || root.path === path)
      )
        throw new Error("ROOT_ALREADY_CONFIGURED_OR_INVALID");
      const next = {
        ...loaded.config,
        roots: [
          ...loaded.config.roots,
          {
            id,
            path,
            ...(opts.watch === true ? { watch: true } : {}),
            ...(watchIntervalMs !== undefined ? { watchIntervalMs } : {}),
          },
        ],
      };
      parseRuntimeConfig(next);
      await writePrivateFile(
        configPath,
        JSON.stringify(next, null, 2) + "\n",
        true,
      );
      return { added: true, rootId: id, path };
    });
    json(result);
    return;
  }
  if (command === "service") {
    if (opts.stop) {
      json(await stopOwner(configPath));
      return;
    }
    json(await serviceStatus(configPath));
    return;
  }
  if (command === "mcp") {
    const { owner, token } = await ensureOwner(configPath);
    const { runSearchMcpStdioProxy } = await import("../mcp/stdio.js");
    await runSearchMcpStdioProxy(
      new URL(`http://127.0.0.1:${owner.port}/mcp`),
      token,
    );
    return;
  }
  if (["index", "search", "context"].includes(command)) {
    const result = await withClient(
      configPath,
      async (client, defaultRootId) => {
        const rootId = String(opts["root-id"] ?? defaultRootId);
        if (command === "index")
          return client.callTool({
            name: "index_repository",
            arguments: { rootId },
          });
        if (command === "search")
          return client.callTool({
            name: "search_code",
            arguments: {
              rootId,
              query: get(opts, "query"),
              ...(typeof opts.mode === "string"
                ? { mode: opts.mode as "lexical" | "hybrid" }
                : {}),
            },
          });
        return client.callTool({
          name: "get_code_context",
          arguments: { rootId, query: get(opts, "query") },
        });
      },
    );
    json(result);
    if (
      result &&
      typeof result === "object" &&
      "isError" in result &&
      result.isError === true
    )
      process.exitCode = 1;
    return;
  }
  throw new Error("COMMAND_UNKNOWN");
}
void main().catch((error: unknown) => {
  const code =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : "CLI_FAILED";
  stderr.write(
    `zorya-search: ${code.replace(/[\r\n\t]/g, " ").slice(0, 240)}\n`,
  );
  process.exitCode = 1;
});
