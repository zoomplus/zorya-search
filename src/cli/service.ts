import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  connect as connectSocket,
  type Socket,
  type Server,
} from "node:net";
import {
  mkdir,
  open,
  lstat,
  readFile,
  unlink,
  realpath,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  readPrivateFile,
  writePrivateFile,
  ownerDir,
  readConfig,
} from "./files.js";

const DEFAULT_OWNER_START_TIMEOUT_MS = 15_000;
const MAX_OWNER_START_TIMEOUT_MS = 45 * 60_000;
export async function ownerReadinessTimeoutMs(configPath: string) {
  const config = (await readConfig(configPath)).config;
  const watched = config.roots.filter((root) => root.watch);
  if (!watched.length) return DEFAULT_OWNER_START_TIMEOUT_MS;
  const workUnits = watched.reduce((total, root) => {
    const limits = root.limits;
    return (
      total +
      (limits?.maxFiles ?? 5_000) +
      (limits?.maxChunks ?? 10_000) +
      (limits?.maxScanChunks ?? 10_000)
    );
  }, 0);
  return Math.min(
    MAX_OWNER_START_TIMEOUT_MS,
    Math.max(DEFAULT_OWNER_START_TIMEOUT_MS, 60_000 + workUnits * 20),
  );
}

interface Owner {
  version: 1;
  pid: number;
  port: number;
  configFingerprint: string;
  tokenFile: string;
  controlFile: string;
  controlEndpoint: string;
}
const entry = fileURLToPath(new URL("./entry.js", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function controlEndpoint(configPath: string) {
  const parent = await realpath(join(resolve(configPath), ".."));
  const canonical = join(parent, resolve(configPath).split(/[\\/]/).at(-1)!);
  const id = createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\zorya-search-${id}`
    : join(await realpath(tmpdir()), `zorya-search-${id}.sock`);
}
async function configFingerprint(configPath: string) {
  return createHash("sha256")
    .update(await readFile(configPath))
    .digest("hex");
}
function sameSecret(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
async function ownerRecord(configPath: string): Promise<Owner | undefined> {
  try {
    const dir = ownerDir(configPath);
    if (
      (await import("node:fs/promises").then((fs) => fs.realpath(dir))) !==
      resolve(dir)
    )
      return undefined;
    const parsed = JSON.parse(
      await readPrivateFile(join(dir, "owner.json")),
    ) as Owner;
    if (
      parsed.version !== 1 ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid < 1 ||
      !Number.isInteger(parsed.port) ||
      parsed.port < 1 ||
      parsed.port > 65535 ||
      !/^[A-Za-z0-9-]{1,80}\.token$/.test(parsed.tokenFile) ||
      !/^[A-Za-z0-9-]{1,80}\.token$/.test(parsed.controlFile) ||
      parsed.controlEndpoint !== (await controlEndpoint(configPath)) ||
      !/^[a-f0-9]{64}$/.test(parsed.configFingerprint)
    )
      return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
async function ownerToken(
  owner: Owner,
  configPath: string,
  file = owner.tokenFile,
) {
  if (!/^[A-Za-z0-9-]{1,80}\.token$/.test(file))
    throw new Error("OWNER_FILE_INVALID");
  return (await readPrivateFile(join(ownerDir(configPath), file), 8192)).trim();
}
async function authenticated(owner: Owner, configPath: string) {
  try {
    const token = await ownerToken(owner, configPath);
    const client = new Client(
      { name: "zorya-search-cli", version: "0.1.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${owner.port}/mcp`),
        {
          requestInit: {
            headers: { Authorization: `Bearer ${token}` },
            redirect: "error",
            signal: AbortSignal.timeout(2000),
          },
        },
      ),
    );
    try {
      return await client.callTool({ name: "list_roots", arguments: {} });
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch {
    return undefined;
  }
}
export async function requestStop(endpoint: string, secret: string) {
  return await new Promise<boolean>((resolvePromise) => {
    let socket: Socket;
    try {
      socket = connectSocket(endpoint);
    } catch {
      resolvePromise(false);
      return;
    }
    let response = "";
    let settled = false;
    const settle = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(accepted);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      settle(false);
    }, 2000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ secret }) + "\n"));
    socket.on("data", (data: string) => {
      response += data;
      if (response.length > 128) {
        socket.destroy();
        settle(false);
        return;
      }
      if (response.includes("\n")) {
        settle(response.trim() === '{"ok":true}');
        socket.end();
      }
    });
    socket.on("error", () => settle(false));
    socket.on("close", () => settle(false));
  });
}
export async function ensureOwner(configPath: string) {
  const dir = ownerDir(configPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await realpath(dir)) !== resolve(dir))
    throw new Error("OWNER_DIR_UNSAFE");
  const dirInfo = await import("node:fs/promises").then((fs) => fs.stat(dir));
  if (process.platform !== "win32" && (dirInfo.mode & 0o077) !== 0)
    throw new Error("OWNER_DIR_PERMISSIONS_UNSAFE");
  let old = await ownerRecord(configPath);
  if (
    old &&
    old.configFingerprint === (await configFingerprint(configPath)) &&
    (await authenticated(old, configPath))
  )
    return { owner: old, token: await ownerToken(old, configPath) };
  const lockPath = join(dir, "startup.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    const startupTimeout = await ownerReadinessTimeoutMs(configPath);
    const start = Date.now();
    while (Date.now() - start < startupTimeout) {
      await sleep(100);
      old = await ownerRecord(configPath);
      if (
        old &&
        old.configFingerprint === (await configFingerprint(configPath)) &&
        (await authenticated(old, configPath))
      )
        return { owner: old, token: await ownerToken(old, configPath) };
    }
    throw new Error("OWNER_STARTUP_BUSY");
  }
  const lockInfo = await lock.stat();
  try {
    old = await ownerRecord(configPath);
    if (old && (await authenticated(old, configPath))) {
      if (old.configFingerprint === (await configFingerprint(configPath)))
        return { owner: old, token: await ownerToken(old, configPath) };
      await stopOwner(configPath);
    }
    if (
      await lstat(join(dir, "owner.json")).then(
        () => true,
        () => false,
      )
    )
      throw new Error("OWNER_DESCRIPTOR_CONFLICT");
    const token = randomBytes(32).toString("base64url");
    const tokenFile = `owner-${randomBytes(12).toString("hex")}.token`;
    const controlSecret = randomBytes(32).toString("base64url");
    const controlFile = `control-${randomBytes(12).toString("hex")}.token`;
    await writePrivateFile(join(dir, tokenFile), token);
    await writePrivateFile(join(dir, controlFile), controlSecret);
    const child = spawn(
      process.execPath,
      [
        entry,
        "serve",
        "--config",
        resolve(configPath),
        "--token-file",
        join(dir, tokenFile),
        "--control-file",
        join(dir, controlFile),
      ],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    const childClosed = new Promise<void>((resolvePromise) =>
      child.once("close", () => resolvePromise()),
    );
    if (!child.pid) throw new Error("OWNER_START_FAILED");
    // Watch-enabled profiles perform their initial full index before the
    // runtime starts serving MCP. Give large projects a bounded cold-start
    // window; on expiry, terminate and join only the ChildProcess we spawned.
    const deadline = Date.now() + (await ownerReadinessTimeoutMs(configPath));
    while (Date.now() < deadline) {
      const candidate = await ownerRecord(configPath);
      if (
        candidate &&
        candidate.pid === child.pid &&
        candidate.tokenFile === tokenFile &&
        candidate.controlFile === controlFile &&
        (await authenticated(candidate, configPath))
      ) {
        child.unref();
        return { owner: candidate, token };
      }
      if (child.exitCode !== null) break;
      await sleep(100);
    }
    child.kill("SIGTERM");
    const closed = await Promise.race([
      childClosed.then(() => true),
      sleep(3000).then(() => false),
    ]);
    if (!closed) {
      child.kill("SIGKILL");
      await Promise.race([childClosed, sleep(2000)]);
    }
    await childClosed;
    await unlink(join(dir, tokenFile)).catch(() => undefined);
    await unlink(join(dir, controlFile)).catch(() => undefined);
    throw new Error("OWNER_NOT_READY");
  } finally {
    await lock.close();
    const current = await lstat(lockPath).catch(() => undefined);
    if (current?.dev === lockInfo.dev && current.ino === lockInfo.ino)
      await unlink(lockPath).catch(() => undefined);
  }
}
export async function runOwner(
  configPath: string,
  tokenFile?: string,
  controlFile?: string,
) {
  const dir = ownerDir(configPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await realpath(dir)) !== resolve(dir))
    throw new Error("OWNER_DIR_UNSAFE");
  const dirInfo = await import("node:fs/promises").then((fs) => fs.stat(dir));
  if (process.platform !== "win32" && (dirInfo.mode & 0o077) !== 0)
    throw new Error("OWNER_DIR_PERMISSIONS_UNSAFE");
  const descriptor = join(dir, "owner.json");
  if (
    await lstat(descriptor).then(
      () => true,
      () => false,
    )
  )
    throw new Error("OWNER_DESCRIPTOR_CONFLICT");
  const ownTokenFile =
    tokenFile ?? join(dir, `owner-${randomBytes(12).toString("hex")}.token`);
  const ownControlFile =
    controlFile ??
    join(dir, `control-${randomBytes(12).toString("hex")}.token`);
  const token = tokenFile
    ? (await readPrivateFile(ownTokenFile, 8192)).trim()
    : randomBytes(32).toString("base64url");
  const controlSecret = controlFile
    ? (await readPrivateFile(ownControlFile, 8192)).trim()
    : randomBytes(32).toString("base64url");
  if (!tokenFile) await writePrivateFile(ownTokenFile, token);
  if (!controlFile) await writePrivateFile(ownControlFile, controlSecret);
  const { startSearchDaemon } = await import("../daemon/index.js");
  let daemon: Awaited<ReturnType<typeof startSearchDaemon>> | undefined;
  let controlServer: Server | undefined;
  let ownSocketInfo: { dev: number; ino: number } | undefined;
  const endpoint = await controlEndpoint(configPath);
  const startupController = new AbortController();
  let finishRequested: (() => void) | undefined;
  let shutdownRequested = false;
  const onSignal = () => {
    shutdownRequested = true;
    startupController.abort(new Error("OWNER_STOP_REQUESTED"));
    finishRequested?.();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const cleanupFiles = async () => {
    if (ownSocketInfo && process.platform !== "win32") {
      const current = await lstat(endpoint).catch(() => undefined);
      if (
        current?.dev === ownSocketInfo.dev &&
        current.ino === ownSocketInfo.ino
      )
        await unlink(endpoint).catch(() => undefined);
    }
    const current = await lstat(descriptor).catch(() => undefined);
    if (
      descriptorInfo &&
      current?.dev === descriptorInfo.dev &&
      current.ino === descriptorInfo.ino
    )
      await unlink(descriptor).catch(() => undefined);
    await unlink(ownTokenFile).catch(() => undefined);
    await unlink(ownControlFile).catch(() => undefined);
  };
  let descriptorInfo: { dev: number; ino: number } | undefined;
  try {
    daemon = await startSearchDaemon({
      configPath,
      port: 0,
      bearerToken: token,
      runtimeOptions: { signal: startupController.signal },
    });
    const control = (controlServer = createServer((socket) => {
      socket.setTimeout(1500, () => socket.destroy());
      let input = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        input += chunk;
        if (input.length > 256) {
          socket.destroy();
          return;
        }
        const end = input.indexOf("\n");
        if (end < 0) return;
        try {
          const request = JSON.parse(input.slice(0, end)) as {
            secret?: unknown;
          };
          if (
            typeof request.secret !== "string" ||
            !sameSecret(request.secret, controlSecret)
          ) {
            socket.end('{"ok":false}\n');
            return;
          }
          socket.end('{"ok":true}\n');
          void finish();
        } catch {
          socket.end('{"ok":false}\n');
        }
      });
    }));
    const finish = () =>
      (stopPromise ??= (async () => {
        await daemon?.close();
        await new Promise<void>((resolvePromise) =>
          control.close(() => resolvePromise()),
        );
        await cleanupFiles();
        finishResolve();
      })());
    let stopPromise: Promise<void> | undefined;
    let finishResolve = () => {};
    await new Promise<void>((resolvePromise, reject) => {
      control.once("error", reject);
      control.listen(endpoint, () => {
        control.removeListener("error", reject);
        resolvePromise();
      });
    });
    if (process.platform !== "win32") {
      const info = await lstat(endpoint);
      ownSocketInfo = { dev: info.dev, ino: info.ino };
    }
    const owner: Owner = {
      version: 1,
      pid: process.pid,
      port: daemon.port,
      configFingerprint: await configFingerprint(configPath),
      tokenFile: ownTokenFile.split(/[\\/]/).at(-1)!,
      controlFile: ownControlFile.split(/[\\/]/).at(-1)!,
      controlEndpoint: endpoint,
    };
    await writePrivateFile(descriptor, JSON.stringify(owner), false);
    descriptorInfo = await lstat(descriptor);
    finishRequested = () => {
      void finish();
    };
    if (shutdownRequested) finishRequested();
    await new Promise<void>((resolvePromise) => {
      finishResolve = resolvePromise;
    });
  } catch (error) {
    await daemon?.close().catch(() => undefined);
    if (controlServer?.listening)
      await new Promise<void>((resolvePromise) =>
        controlServer!.close(() => resolvePromise()),
      );
    await cleanupFiles();
    throw error;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}
export async function serviceStatus(configPath: string) {
  const owner = await ownerRecord(configPath);
  if (!owner) return { running: false };
  const running = !!(await authenticated(owner, configPath));
  return {
    running,
    pid: owner.pid,
    port: owner.port,
    configurationChanged:
      owner.configFingerprint !== (await configFingerprint(configPath)),
  };
}
export async function stopOwner(configPath: string) {
  const owner = await ownerRecord(configPath);
  if (!owner || !(await authenticated(owner, configPath)))
    throw new Error("OWNER_NOT_VERIFIED");
  const secret = await ownerToken(owner, configPath, owner.controlFile);
  if (!(await requestStop(owner.controlEndpoint, secret)))
    throw new Error("OWNER_CONTROL_UNVERIFIED");
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (!(await ownerRecord(configPath))) return { stopped: true };
    await sleep(50);
  }
  throw new Error("OWNER_STOP_TIMEOUT");
}
