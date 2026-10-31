import { lstat, realpath, open, stat, opendir } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep, join } from 'node:path'
import ignore from 'ignore'
import { CodeIndexError } from './errors.js'
import type { CodeIndexLimits } from './types.js'
import { codeSha256 } from './identity.js'
import { runGit } from './git.js'

const forbidden =
  /(^|\/)(?:\.git|node_modules|build|dist|coverage|\.cache|\.next|vendor|\.idea|\.vscode)(?:\/|$)|(^|\/)(?:\.env(?:\..*)?|[^/]*(?:secret|credential|private[-_]?key)[^/]*|id_(?:rsa|ed25519))(?:$|\/)/iu
const textExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.md',
  '.mdx',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.html',
  '.css',
  '.scss',
  '.less',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.cs',
  '.cpp',
  '.h',
  '.hpp',
  '.c',
  '.sh',
  '.sql',
  '.graphql',
  '.proto',
  '.vue',
  '.svelte',
])
function isIndexablePath(path: string): boolean {
  return (
    !forbidden.test(path) && textExtensions.has(path.slice(path.lastIndexOf('.')).toLowerCase())
  )
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function readBoundedFile(
  path: string,
  maxBytes: number,
  errorCode: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted()
  const pathStat = await lstat(path)
  if (!pathStat.isFile()) throw new CodeIndexError(errorCode)
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (
      !info.isFile() ||
      info.dev !== pathStat.dev ||
      info.ino !== pathStat.ino ||
      info.size > maxBytes
    )
      throw new CodeIndexError(errorCode)
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      signal?.throwIfAborted()
      const result = await handle.read(buffer, offset, buffer.length - offset, null)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset > maxBytes) throw new CodeIndexError(errorCode)
    return buffer.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

async function gitFiles(
  root: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string[] | null> {
  const output = await runGit(
    root,
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { maxOutputBytes: maxBytes, ...(signal ? { signal } : {}) },
  )
  return output?.split('\0').filter(Boolean) ?? null
}

async function walkNonGit(root: string, maxFiles: number, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = []
  const maxEntries = Math.min(maxFiles * 20, 250_000)
  let entryCount = 0
  const visit = async (
    directory: string,
    parents: { base: string; matcher: ReturnType<typeof ignore> }[],
  ): Promise<void> => {
    signal?.throwIfAborted()
    const entries: import('node:fs').Dirent[] = []
    for await (const entry of await opendir(directory)) {
      signal?.throwIfAborted()
      if (++entryCount > maxEntries) throw new CodeIndexError('CODE_INDEX_DIRECTORY_LIMIT')
      entries.push(entry)
    }
    let inherited = parents
    const ignoreFile = join(directory, '.gitignore')
    try {
      const ignoreLinkStat = await lstat(ignoreFile)
      if (!ignoreLinkStat.isFile()) throw new CodeIndexError('CODE_INDEX_IGNORE_FILE_UNREADABLE')
      const ignoreStat = await stat(ignoreFile)
      if (ignoreStat.size > 1_000_000) throw new CodeIndexError('CODE_INDEX_IGNORE_FILE_LIMIT')
      const ignoreBytes = await readBoundedFile(
        ignoreFile,
        1_000_000,
        'CODE_INDEX_IGNORE_FILE_LIMIT',
        signal,
      )
      const text = ignoreBytes.toString('utf8')
      inherited = [
        ...parents,
        { base: relative(root, directory).split(sep).join('/'), matcher: ignore().add(text) },
      ]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new CodeIndexError('CODE_INDEX_IGNORE_FILE_UNREADABLE')
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const relativePath = relative(root, absolute).split(sep).join('/')
      if (forbidden.test(relativePath) || entry.name === '.git') continue
      let ignored = false
      for (const { base, matcher } of inherited) {
        const candidate = base ? relative(base, relativePath).split(sep).join('/') : relativePath
        if (candidate === '..' || candidate.startsWith('../')) continue
        const decision = matcher.test(candidate + (entry.isDirectory() ? '/' : ''))
        if (decision.ignored) ignored = true
        else if (decision.unignored) ignored = false
      }
      if (ignored) continue
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await visit(absolute, inherited)
      else if (entry.isFile() && isIndexablePath(relativePath)) {
        files.push(relativePath)
        if (files.length > maxFiles) throw new CodeIndexError('CODE_INDEX_FILE_LIMIT')
      }
    }
  }
  await visit(root, [])
  return files.sort()
}

export interface EnumeratedFile {
  path: string
  absolutePath: string
  text: string
  hash: string
  bytes: number
}

export async function enumerateCode(
  root: string,
  limits: CodeIndexLimits,
  signal?: AbortSignal,
): Promise<{ files: EnumeratedFile[]; treeHash: string; ignoredMode: 'git' | 'non-git' }> {
  signal?.throwIfAborted()
  const rootReal = await realpath(root)
  const gitListed = await gitFiles(
    rootReal,
    Math.min(limits.maxFiles * 4096, 64 * 1024 * 1024),
    signal,
  )
  const listed = gitListed ?? (await walkNonGit(rootReal, limits.maxFiles, signal))
  const files: EnumeratedFile[] = []
  let totalBytes = 0
  for (const path of listed.sort()) {
    signal?.throwIfAborted()
    if (!isIndexablePath(path)) continue
    const absolutePath = resolve(rootReal, path)
    if (!inside(rootReal, absolutePath)) continue
    const info = await lstat(absolutePath).catch(() => null)
    if (!info?.isFile()) continue
    if (info.size > limits.maxFileBytes) throw new CodeIndexError('CODE_INDEX_FILE_SIZE_LIMIT')
    const real = await realpath(absolutePath).catch(() => null)
    if (!real || !inside(rootReal, real)) continue
    const bytes = await readBoundedFile(
      real,
      limits.maxFileBytes,
      'CODE_INDEX_FILE_SIZE_LIMIT',
      signal,
    )
    const checkedReal = await realpath(real).catch(() => null)
    if (
      bytes.length > limits.maxFileBytes ||
      checkedReal !== real ||
      !inside(rootReal, checkedReal)
    )
      continue
    if (bytes.includes(0)) continue
    const text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes)) continue
    totalBytes += bytes.length
    if (totalBytes > limits.maxTotalBytes) throw new CodeIndexError('CODE_INDEX_TOTAL_BYTES_LIMIT')
    files.push({
      path: path.replaceAll('\\', '/'),
      absolutePath: real,
      text,
      hash: codeSha256(bytes),
      bytes: bytes.length,
    })
    if (files.length > limits.maxFiles) throw new CodeIndexError('CODE_INDEX_FILE_LIMIT')
  }
  const treeHash = codeSha256(files.map((file) => `${file.path}\0${file.hash}\n`).join(''))
  return { files, treeHash, ignoredMode: gitListed ? 'git' : 'non-git' }
}

export async function readScopedFile(
  root: string,
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ text: string; hash: string; bytes: number }> {
  if (isAbsolute(path) || path.split(/[\\/]/u).includes('..') || forbidden.test(path))
    throw new CodeIndexError('CODE_INDEX_PATH_OUTSIDE_ROOT')
  const rootReal = await realpath(root)
  const absolute = resolve(rootReal, path)
  const real = await realpath(absolute).catch((error: unknown) => {
    throw new CodeIndexError('CODE_INDEX_SOURCE_UNAVAILABLE', 'CODE_INDEX_SOURCE_UNAVAILABLE', {
      cause: error,
    })
  })
  if (!inside(rootReal, real)) throw new CodeIndexError('CODE_INDEX_PATH_OUTSIDE_ROOT')
  const bytes = await readBoundedFile(real, maxBytes, 'CODE_INDEX_SOURCE_SIZE_LIMIT', signal)
  const checkedReal = await realpath(real).catch(() => null)
  if (bytes.length > maxBytes || checkedReal !== real || !inside(rootReal, checkedReal))
    throw new CodeIndexError('CODE_INDEX_PATH_OUTSIDE_ROOT')
  if (bytes.includes(0)) throw new CodeIndexError('CODE_INDEX_SOURCE_BINARY')
  return { text: bytes.toString('utf8'), hash: codeSha256(bytes), bytes: bytes.length }
}
