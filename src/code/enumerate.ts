import { lstat, realpath, open, stat, opendir } from 'node:fs/promises'
import { isAbsolute, posix, relative, resolve, sep, win32, join } from 'node:path'
import ignore from 'ignore'
import { CodeIndexError } from './errors.js'
import type { CodeIndexLimits } from './types.js'
import { codeSha256 } from './identity.js'
import { runGit } from './git.js'

const forbidden =
  /(^|\/)(?:\.git|node_modules|build|dist|coverage|\.cache|\.next|vendor|\.idea|\.vscode)(?:\/|$)|(^|\/)(?:\.env(?:\..*)?|[^/]*(?:secret|credential|private[-_]?key)[^/]*|id_(?:rsa|ed25519))(?:$|\/)/iu
export const CODE_EXCLUSION_POLICY_VERSION = 'code-exclusions-v1'
export const DEFAULT_CODE_EXCLUSIONS = Object.freeze([
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/yarn.lock',
])
const MAX_EXCLUSION_PATTERNS = 128
const MAX_EXCLUSION_PATTERN_LENGTH = 512
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

export function createCodePathPolicy(input: string[] | undefined): {
  patterns: readonly string[]
  id: string
  excludes(path: string): boolean
} {
  if (input !== undefined && (!Array.isArray(input) || input.length > MAX_EXCLUSION_PATTERNS))
    throw new CodeIndexError('CODE_INDEX_EXCLUSION_POLICY_INVALID')
  const explicit = (input ?? []).map((pattern) => {
    if (
      typeof pattern !== 'string' ||
      !pattern.length ||
      pattern.length > MAX_EXCLUSION_PATTERN_LENGTH ||
      pattern.trim() !== pattern ||
      pattern.startsWith('!') ||
      /[\p{Cc}\u2028\u2029]/u.test(pattern) ||
      /^[a-z]:/iu.test(pattern) ||
      pattern.includes('\\') ||
      pattern.includes('\0') ||
      isAbsolute(pattern) ||
      pattern.split('/').some((part) => part === '..')
    )
      throw new CodeIndexError('CODE_INDEX_EXCLUSION_POLICY_INVALID')
    return pattern
  })
  const patterns = Object.freeze([...DEFAULT_CODE_EXCLUSIONS, ...new Set(explicit)])
  let matcher: ReturnType<typeof ignore>
  try {
    matcher = ignore().add([...patterns])
  } catch {
    throw new CodeIndexError(
      'CODE_INDEX_EXCLUSION_POLICY_INVALID',
      'CODE_INDEX_EXCLUSION_POLICY_INVALID',
    )
  }
  const id = codeSha256(JSON.stringify([CODE_EXCLUSION_POLICY_VERSION, patterns]))
  return Object.freeze({
    patterns,
    id,
    excludes: (path: string) => matcher.test(path.replaceAll('\\', '/')).ignored,
  })
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
  diagnostics?: { path: string; allowedBytes: number },
): Promise<Buffer> {
  signal?.throwIfAborted()
  const pathStat = await lstat(path)
  if (!pathStat.isFile()) throw new CodeIndexError(errorCode)
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.dev !== pathStat.dev || info.ino !== pathStat.ino)
      throw new CodeIndexError(errorCode)
    if (info.size > maxBytes) throw sizeLimitError(errorCode, diagnostics, info.size, maxBytes)
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      signal?.throwIfAborted()
      const result = await handle.read(buffer, offset, buffer.length - offset, null)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset > maxBytes) {
      const actualBytes = (await handle.stat()).size
      throw sizeLimitError(errorCode, diagnostics, actualBytes, maxBytes)
    }
    return buffer.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

function sizeLimitError(
  code: string,
  diagnostics: { path: string; allowedBytes: number } | undefined,
  actualBytes: number,
  allowedBytes: number,
): CodeIndexError {
  if (!diagnostics) return new CodeIndexError(code)
  return new CodeIndexError(code, code, undefined, {
    path: diagnostics.path.replace(/[\p{Cc}\u2028\u2029]/gu, '�').slice(0, 1024),
    actualBytes,
    allowedBytes,
  })
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

async function walkNonGit(
  root: string,
  maxFiles: number,
  signal?: AbortSignal,
  excludes: (path: string) => boolean = () => false,
): Promise<string[]> {
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
      if (excludes(relativePath + (entry.isDirectory() ? '/' : ''))) continue
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
  excludes: (path: string) => boolean = () => false,
): Promise<{ files: EnumeratedFile[]; treeHash: string; ignoredMode: 'git' | 'non-git' }> {
  signal?.throwIfAborted()
  const rootReal = await realpath(root)
  const gitListed = await gitFiles(
    rootReal,
    Math.min(limits.maxFiles * 4096, 64 * 1024 * 1024),
    signal,
  )
  const listed = gitListed ?? (await walkNonGit(rootReal, limits.maxFiles, signal, excludes))
  const files: EnumeratedFile[] = []
  let totalBytes = 0
  for (const path of listed.sort()) {
    signal?.throwIfAborted()
    const normalizedPath = path.replaceAll('\\', '/')
    if (!isIndexablePath(normalizedPath) || excludes(normalizedPath)) continue
    const absolutePath = resolve(rootReal, path)
    if (!inside(rootReal, absolutePath)) continue
    const info = await lstat(absolutePath).catch(() => null)
    if (!info?.isFile()) continue
    if (info.size > limits.maxFileBytes)
      throw sizeLimitError(
        'CODE_INDEX_FILE_SIZE_LIMIT',
        { path: normalizedPath, allowedBytes: limits.maxFileBytes },
        info.size,
        limits.maxFileBytes,
      )
    const real = await realpath(absolutePath).catch(() => null)
    if (!real || !inside(rootReal, real)) continue
    const bytes = await readBoundedFile(
      real,
      limits.maxFileBytes,
      'CODE_INDEX_FILE_SIZE_LIMIT',
      signal,
      { path: normalizedPath, allowedBytes: limits.maxFileBytes },
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
  excludes: (path: string) => boolean = () => false,
): Promise<{ text: string; hash: string; bytes: number }> {
  const normalizedPath = posix.normalize(path.replaceAll('\\', '/'))
  if (
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path.split(/[\\/]/u).includes('..') ||
    forbidden.test(normalizedPath) ||
    excludes(normalizedPath)
  )
    throw new CodeIndexError('CODE_INDEX_PATH_OUTSIDE_ROOT')
  const rootReal = await realpath(root)
  const absolute = resolve(rootReal, path)
  const real = await realpath(absolute).catch((error: unknown) => {
    throw new CodeIndexError('CODE_INDEX_SOURCE_UNAVAILABLE', 'CODE_INDEX_SOURCE_UNAVAILABLE', {
      cause: error,
    })
  })
  if (!inside(rootReal, real)) throw new CodeIndexError('CODE_INDEX_PATH_OUTSIDE_ROOT')
  const canonicalPath = relative(rootReal, real).split(sep).join('/')
  if (forbidden.test(canonicalPath) || excludes(canonicalPath))
    throw new CodeIndexError('CODE_INDEX_PATH_OUTSIDE_ROOT')
  const bytes = await readBoundedFile(real, maxBytes, 'CODE_INDEX_SOURCE_SIZE_LIMIT', signal, {
    path: normalizedPath,
    allowedBytes: maxBytes,
  })
  const checkedReal = await realpath(real).catch(() => null)
  if (bytes.length > maxBytes || checkedReal !== real || !inside(rootReal, checkedReal))
    throw new CodeIndexError('CODE_INDEX_PATH_OUTSIDE_ROOT')
  if (bytes.includes(0)) throw new CodeIndexError('CODE_INDEX_SOURCE_BINARY')
  return { text: bytes.toString('utf8'), hash: codeSha256(bytes), bytes: bytes.length }
}
