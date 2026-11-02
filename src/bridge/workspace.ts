import { lstat, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  BRIDGE_MAX_FILES,
  BRIDGE_MAX_FILE_BYTES,
  BRIDGE_MAX_TOTAL_BYTES,
  BridgeContractError,
  createBridgeManifest,
  createBridgeScope,
  parseBridgeManifest,
  validateBridgeFilePayload,
  workspaceIdForCanonicalPath,
  type BridgeManifest,
  type BridgeScope,
} from './protocol.js'
import { createCodePathPolicy, enumerateCode, readScopedFile } from '../code/enumerate.js'
import type { CodeIndexLimits } from '../code/types.js'
import type { EnumerationSelection } from '../code/enumerate.js'
import { PROJECT_TEXT_SELECTION } from '../project-text/policy.js'

const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const scanLimits: CodeIndexLimits = {
  maxFiles: BRIDGE_MAX_FILES,
  maxFileBytes: BRIDGE_MAX_FILE_BYTES,
  maxTotalBytes: BRIDGE_MAX_TOTAL_BYTES,
  maxChunks: 1,
  maxChunkChars: 1,
  maxQueryChars: 1,
  maxScanChunks: 1,
  maxResults: 1,
}
const workspaceSelection: EnumerationSelection = Object.freeze({
  extensions: Object.freeze([...new Set([
    ...PROJECT_TEXT_SELECTION.extensions,
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '.yaml', '.yml',
    '.toml', '.html', '.css', '.scss', '.less', '.py', '.go', '.rs', '.java', '.kt', '.cs',
    '.cpp', '.h', '.hpp', '.c', '.sh', '.sql', '.graphql', '.proto', '.vue', '.svelte',
  ])]),
  ...(PROJECT_TEXT_SELECTION.filenames ? { filenames: PROJECT_TEXT_SELECTION.filenames } : {}),
})
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export interface NativeCallMetadata {
  _meta?: unknown
  threadId?: unknown
}

export interface WorkspaceSnapshot {
  readonly scope: BridgeScope
  readonly manifest: BridgeManifest
  readonly files: ReadonlyMap<string, Uint8Array>
}

export interface BoundWorkspace {
  readonly canonicalPath: string
  readonly scope: BridgeScope
  scan(signal?: AbortSignal): Promise<WorkspaceSnapshot>
  readCurrentFile(
    priorManifest: BridgeManifest,
    path: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array>
}

export interface BindWorkspaceOptions {
  clientInstanceId: string
  call: NativeCallMetadata
  allowedDocumentPaths?: readonly string[]
  exclude?: string[]
  rootLabel?: string
}

function conversationIdFor(call: NativeCallMetadata): string {
  const metadata = call._meta
  const metaRecord = metadata && typeof metadata === 'object'
    ? metadata as Record<string, unknown>
    : undefined
  const native = metaRecord?.['x-codex-turn-metadata']
  const nativeThreadId = native && typeof native === 'object'
    ? (native as Record<string, unknown>).thread_id
    : undefined
  const metaThreadId = metaRecord?.threadId
  const topLevelThreadId = call.threadId
  const candidates = [nativeThreadId, metaThreadId, topLevelThreadId].filter((value) => value !== undefined)
  if (candidates.length === 0)
    throw new BridgeContractError('CONVERSATION_UNRESOLVED')
  if (candidates.some((value) => typeof value !== 'string' || !uuidPattern.test(value)))
    throw new BridgeContractError('CONVERSATION_UNRESOLVED')
  if (candidates.some((value) => value !== candidates[0]))
    throw new BridgeContractError('SCOPE_MISMATCH')
  return candidates[0] as string
}

function isContractError(error: unknown): error is BridgeContractError {
  return error instanceof BridgeContractError
}

function mapCancellation(error: unknown, signal?: AbortSignal): never {
  if (signal?.aborted)
    throw new BridgeContractError('CANCELLED')
  throw error
}

function pathAllowed(path: string, allowedDocuments: readonly string[]): boolean {
  try {
    // This first check excludes unsafe paths and restricts document files to the
    // caller's explicit allowlist. The payload check below also scans contents.
    validateBridgeFilePayload(path, Buffer.alloc(0), emptyHash, { allowedDocumentPaths: allowedDocuments })
    return true
  } catch (error) {
    if (isContractError(error) && error.code === 'MANIFEST_INVALID') return false
    throw error
  }
}

const privateDirectoryNames = new Set([
  '.git', 'node_modules', 'build', 'dist', 'coverage', '.cache', '.next', 'vendor', '.idea',
  '.vscode', '.ssh', '.aws', '.azure', '.config', '.gnupg', '.docker', '.kube', '.npm', '.pki',
  '.terraform', '.credentials', '.claude', '.continue', '.zed', '.aider', '.codex',
  'credentials', 'credential-store', 'config-store',
])
const privateFileNames = new Set([
  '.env', '.gitconfig', 'gitconfig', '.netrc', '.npmrc', '.pypirc', 'known_hosts',
  'authorized_keys', 'mcp.json', 'auth.json',
])

function hardExcludedPath(inputPath: string): boolean {
  const path = inputPath.endsWith('/') ? inputPath.slice(0, -1) : inputPath
  if (!path) return false
  const segments = path.normalize('NFC').toLowerCase().split('/')
  const cursorIndex = segments.indexOf('.cursor')
  if (cursorIndex >= 0 && !(cursorIndex === 0 && (segments.length === 1 || segments[1] === 'rules')))
    return true
  if (segments.some((segment) => privateDirectoryNames.has(segment))) return true
  return segments.some((segment) =>
    privateFileNames.has(segment) ||
    segment.startsWith('.env.') ||
    /(?:secret|credential|private[-_]?key)/u.test(segment) ||
    /^id_(?:rsa|ed25519)(?:\.|$)/u.test(segment),
  )
}

export async function bindCurrentWorkspace(options: BindWorkspaceOptions): Promise<BoundWorkspace> {
  const conversationId = conversationIdFor(options.call)
  const cwd = (() => {
    try { return resolve(process.cwd()) } catch { throw new BridgeContractError('WORKSPACE_UNRESOLVED') }
  })()
  let canonicalPath: string
  let initialStat: Awaited<ReturnType<typeof lstat>>
  try {
    canonicalPath = await realpath(cwd)
    initialStat = await lstat(canonicalPath)
  } catch {
    throw new BridgeContractError('WORKSPACE_UNRESOLVED')
  }
  if (!initialStat.isDirectory()) throw new BridgeContractError('WORKSPACE_UNRESOLVED')
  let scope: BridgeScope
  try {
    scope = Object.freeze(createBridgeScope({
      clientInstanceId: options.clientInstanceId,
      conversationId,
      canonicalPath,
      ...(options.rootLabel === undefined ? {} : { rootLabel: options.rootLabel }),
    }))
  } catch (error) {
    if (error instanceof BridgeContractError && error.code === 'INVALID_REQUEST')
      throw new BridgeContractError('CONVERSATION_UNRESOLVED')
    throw error
  }

  const allowedDocuments = Object.freeze([...(options.allowedDocumentPaths ?? [])])
  const pathPolicy = createCodePathPolicy(options.exclude)

  const assertCurrentRoot = async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    let currentCwd: string
    try { currentCwd = resolve(process.cwd()) } catch { throw new BridgeContractError('WORKSPACE_CHANGED') }
    let currentCanonical: string
    let currentStat: Awaited<ReturnType<typeof lstat>>
    try {
      currentCanonical = await realpath(currentCwd)
      currentStat = await lstat(currentCanonical)
    } catch { throw new BridgeContractError('WORKSPACE_CHANGED') }
    if (
      currentCanonical !== canonicalPath ||
      workspaceIdForCanonicalPath(options.clientInstanceId, currentCanonical) !== scope.workspaceId ||
      !currentStat.isDirectory() ||
      currentStat.dev !== initialStat.dev ||
      currentStat.ino !== initialStat.ino
    ) throw new BridgeContractError('WORKSPACE_CHANGED')
    signal?.throwIfAborted()
  }

  const enumerate = async (signal?: AbortSignal) => {
    await assertCurrentRoot(signal)
    const result = await enumerateCode(
      canonicalPath,
      scanLimits,
      signal,
      (path) => {
        if (pathPolicy.excludes(path) || hardExcludedPath(path)) return true
        // Enumeration passes directory names with a trailing slash while walking.
        // Keep those names out of file-path validation so allowed subtrees such as
        // `.cursor/rules` remain traversable without reading sibling config files.
        return !path.endsWith('/') && !pathAllowed(path, allowedDocuments)
      },
      workspaceSelection,
    )
    await assertCurrentRoot(signal)
    return result
  }

  const scan = async (signal?: AbortSignal): Promise<WorkspaceSnapshot> => {
    try {
      const first = await enumerate(signal)
      const second = await enumerate(signal)
      if (first.treeHash !== second.treeHash)
        throw new BridgeContractError('WORKSPACE_CHANGED')
      const bytesByPath = new Map<string, Uint8Array>()
      const manifestFiles = []
      for (const file of second.files) {
        signal?.throwIfAborted()
        if (!pathAllowed(file.path, allowedDocuments)) continue
        const bytes = Buffer.from(file.text, 'utf8')
        if (bytes.byteLength !== file.bytes) continue
        try {
          validateBridgeFilePayload(file.path, bytes, file.hash, { allowedDocumentPaths: allowedDocuments })
        } catch (error) {
          // Known secret material and invalid payloads are excluded before any
          // bytes enter the candidate upload map.
          if (isContractError(error) && error.code === 'MANIFEST_INVALID') continue
          throw error
        }
        bytesByPath.set(file.path, Uint8Array.from(bytes))
        manifestFiles.push({ path: file.path, sha256: file.hash, bytes: file.bytes })
      }
      const manifest = createBridgeManifest(manifestFiles, { allowedDocumentPaths: allowedDocuments })
      await assertCurrentRoot(signal)
      return Object.freeze({ scope, manifest, files: bytesByPath })
    } catch (error) {
      return mapCancellation(error, signal)
    }
  }

  const readCurrentFile = async (
    priorManifest: BridgeManifest,
    path: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> => {
    try {
      const verifiedPriorManifest = parseBridgeManifest(priorManifest, { allowedDocumentPaths: allowedDocuments })
      await assertCurrentRoot(signal)
      const current = await scan(signal)
      if (current.manifest.manifestHash !== verifiedPriorManifest.manifestHash)
        throw new BridgeContractError('STALE_GENERATION')
      const entry = verifiedPriorManifest.files.find((file) => file.path === path)
      if (!entry) throw new BridgeContractError('MANIFEST_INVALID')
      const read = await readScopedFile(canonicalPath, path, BRIDGE_MAX_FILE_BYTES, signal, pathPolicy.excludes)
      const bytes = Buffer.from(read.text, 'utf8')
      validateBridgeFilePayload(path, bytes, entry.sha256, { allowedDocumentPaths: allowedDocuments })
      if (read.hash !== entry.sha256 || bytes.byteLength !== entry.bytes)
        throw new BridgeContractError('STALE_GENERATION')
      const after = await scan(signal)
      if (after.manifest.manifestHash !== verifiedPriorManifest.manifestHash)
        throw new BridgeContractError('STALE_GENERATION')
      await assertCurrentRoot(signal)
      return Uint8Array.from(bytes)
    } catch (error) {
      return mapCancellation(error, signal)
    }
  }

  return Object.freeze({ canonicalPath, scope, scan, readCurrentFile })
}
