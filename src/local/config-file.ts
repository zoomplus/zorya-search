import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, parse, relative, resolve, sep, join } from 'node:path'
import { LocalConfigError } from './config.js'

const maxConfigBytes = 1_000_000

export interface LoadedLocalConfig {
  readonly path: string
  readonly configDir: string
  readonly value: unknown
}

/** Load one explicit, bounded, private JSON config without following its final symlink. */
export async function loadLocalConfigFile(configPath: string): Promise<LoadedLocalConfig> {
  if (typeof configPath !== 'string' || !configPath || configPath.includes('\0')) throw new LocalConfigError('LOCAL_CONFIG_INVALID')
  const path = resolve(configPath)
  if (!isAbsolute(path)) throw new LocalConfigError('LOCAL_CONFIG_INVALID')
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const info = await handle.stat()
    if (!info.isFile() || info.size < 1 || info.size > maxConfigBytes || process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      throw new Error()
    const bytes = await handle.readFile()
    if (bytes.byteLength < 1 || bytes.byteLength > maxConfigBytes) throw new Error()
    const text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error()
    const after = await lstat(path)
    if (after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino) throw new Error()
    const canonicalConfig = await realpath(path)
    if (canonicalConfig !== path) throw new Error()
    return Object.freeze({ path, configDir: dirname(path), value: JSON.parse(text) as unknown })
  } catch (error) {
    if (error instanceof LocalConfigError) throw error
    throw new LocalConfigError('LOCAL_CONFIG_INVALID')
  } finally { await handle?.close().catch(() => undefined) }
}

/** Create one new private config file without following symlinked parent components or overwriting data. */
export async function createLocalConfigFile(configPath: string, value: unknown): Promise<string> {
  if (typeof configPath !== 'string' || !configPath || configPath.includes('\0')) throw new LocalConfigError('LOCAL_CONFIG_INVALID')
  const path = resolve(configPath)
  const parent = dirname(path)
  if (!isAbsolute(path) || path === parent) throw new LocalConfigError('LOCAL_CONFIG_INVALID')
  const root = parse(parent).root
  let current = root
  try {
    for (const segment of relative(root, parent).split(sep).filter(Boolean)) {
      current = join(current, segment)
      try { await mkdir(current, { mode: 0o700 }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error()
    }
    const canonicalParent = await realpath(parent)
    if (canonicalParent !== parent) throw new Error()
    const parentInfo = await lstat(parent)
    if (process.platform !== 'win32' && ((parentInfo.mode & 0o077) !== 0 || typeof process.getuid === 'function' && parentInfo.uid !== process.getuid()))
      throw new Error()
  } catch { throw new LocalConfigError('LOCAL_CONFIG_INVALID') }
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  if (bytes.byteLength > maxConfigBytes) throw new LocalConfigError('LOCAL_CONFIG_INVALID')
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let created: { dev: number; ino: number } | undefined
  try {
    handle = await open(path, 'wx', 0o600)
    const info = await handle.stat()
    if (!info.isFile() || process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error()
    created = { dev: info.dev, ino: info.ino }
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    const after = await lstat(path)
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino || process.platform !== 'win32' && (after.mode & 0o077) !== 0 || await realpath(path) !== path)
      throw new Error()
    return path
  } catch {
    if (created) {
      try {
        const currentInfo = await lstat(path)
        if (currentInfo.isFile() && !currentInfo.isSymbolicLink() && currentInfo.dev === created.dev && currentInfo.ino === created.ino)
          await unlink(path)
      } catch { /* preserve the path if ownership can no longer be proved */ }
    }
    throw new LocalConfigError('LOCAL_CONFIG_INVALID')
  } finally { await handle?.close().catch(() => undefined) }
}
