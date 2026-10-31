import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  lstat,
  link,
  unlink,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, basename, isAbsolute, join, resolve } from "node:path";
import {
  canonicalFuturePath,
  isSameOrDescendantPath,
} from "../runtime/path.js";
import { loadRuntimeConfig } from "../runtime/index.js";

export function defaultConfigPath() {
  if (process.platform === "win32")
    return join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "Zorya",
      "Search",
      "config.json",
    );
  if (process.platform === "darwin")
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Zorya",
      "Search",
      "config.json",
    );
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "zorya-search",
    "config.json",
  );
}
export function defaultDataDir() {
  if (process.platform === "win32")
    return join(
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "Zorya",
      "Search",
      "data",
    );
  if (process.platform === "darwin")
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Zorya",
      "Search",
      "data",
    );
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "zorya-search",
    "data",
  );
}
export function ownerDir(configPath: string) {
  const identity = createHash("sha256")
    .update(resolve(configPath))
    .digest("hex")
    .slice(0, 24);
  return join(dirname(resolve(configPath)), `.zorya-search-owner-${identity}`);
}

export async function canonicalConfigPath(path: string) {
  const requested = resolve(path);
  return join(
    await canonicalFuturePath(dirname(requested)),
    basename(requested),
  );
}

export async function writePrivateFile(
  path: string,
  contents: string,
  replace = false,
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const dir = await realpath(dirname(path));
  const target = resolve(path);
  if (dirname(target) !== dir) throw new Error("STATE_PATH_INVALID");
  const existing = await lstat(target).catch(() => undefined);
  if (existing && (existing.isSymbolicLink() || !existing.isFile()))
    throw new Error("STATE_FILE_UNSAFE");
  if (existing && !replace) throw new Error("STATE_EXISTS");
  const temp = join(
    dir,
    `.zorya-search-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  const handle = await open(
    temp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") {
    const modeHandle = await open(temp, constants.O_RDONLY);
    try {
      await modeHandle.chmod(0o600);
    } finally {
      await modeHandle.close();
    }
  }
  if (replace) await rename(temp, target);
  else {
    try {
      await link(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw new Error("STATE_EXISTS", { cause: error });
    }
    await unlink(temp);
  }
}
export async function readPrivateFile(path: string, limit = 32_768) {
  const before = await lstat(path, { bigint: true });
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size > BigInt(limit)
  )
    throw new Error("STATE_FILE_UNSAFE");
  if (process.platform !== "win32" && (before.mode & 0o077n) !== 0n)
    throw new Error("STATE_PERMISSIONS_UNSAFE");
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > BigInt(limit)
    )
      throw new Error("STATE_FILE_CHANGED");
    const bytes = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (
      offset > limit ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== BigInt(offset) ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    )
      throw new Error("STATE_FILE_CHANGED");
    return bytes.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}
export function pathWithin(parent: string, child: string) {
  return isSameOrDescendantPath(resolve(parent), resolve(child));
}
export async function readConfig(path: string) {
  return loadRuntimeConfig(path);
}
export function temporaryRoot() {
  return tmpdir();
}
