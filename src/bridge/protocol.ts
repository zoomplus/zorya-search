import { createHash } from 'node:crypto'
import { extname, isAbsolute, posix, resolve, win32 } from 'node:path'
import { z } from 'zod'

export const BRIDGE_PROTOCOL_VERSION = 1 as const
export const BRIDGE_MAX_FILES = 5_000
export const BRIDGE_MAX_FILE_BYTES = 1_000_000
export const BRIDGE_MAX_TOTAL_BYTES = 50_000_000
export const BRIDGE_MAX_CHUNK_BYTES = 128_000
export const BRIDGE_MAX_REQUEST_BYTES = 1_000_000
export const BRIDGE_MAX_CONCURRENT_OPERATIONS = 8
export const BRIDGE_MAX_WORKSPACES_PER_CLIENT = 8
export const BRIDGE_MAX_WORKSPACES = 32
export const BRIDGE_MAX_PENDING_TRANSFERS_PER_CLIENT = 2
export const BRIDGE_MAX_RETAINED_SNAPSHOTS_PER_WORKSPACE = 2

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const safeLabel = z.string().min(1).max(128).refine((value) => !/[\p{Cc}\u2028\u2029/\\]/u.test(value))

export const BridgeScopeSchema = z.object({
  clientInstanceId: uuid,
  workspaceId: sha256,
  conversationId: uuid,
  rootLabel: safeLabel.optional(),
  sourceRootHash: sha256.optional(),
}).strict()

export type BridgeScope = z.infer<typeof BridgeScopeSchema>

export type BridgeErrorCode =
  | 'INVALID_REQUEST'
  | 'AUTH'
  | 'SCOPE_MISMATCH'
  | 'CONVERSATION_UNRESOLVED'
  | 'WORKSPACE_UNRESOLVED'
  | 'WORKSPACE_CHANGED'
  | 'GENERATION_CONFLICT'
  | 'STALE_GENERATION'
  | 'PROFILE_CHANGED'
  | 'SNAPSHOT_UNAVAILABLE'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_CONFLICT'
  | 'FILE_HASH_MISMATCH'
  | 'FILE_TOO_LARGE'
  | 'TOTAL_TOO_LARGE'
  | 'FILE_LIMIT_EXCEEDED'
  | 'REQUEST_TOO_LARGE'
  | 'OPERATION_NOT_FOUND'
  | 'CANCELLED'
  | 'UPSTREAM_PROTOCOL_ERROR'
  | 'CONFIG_INVALID'

export const BridgeUpstreamErrorSchema = z.object({
  code: z.string().min(1).max(128),
  message: z.string().max(2_048).optional(),
  details: z.unknown().optional(),
  payload: z.unknown().optional(),
  isError: z.boolean().optional(),
}).strict()

export const BridgeErrorSchema = z.object({
  code: z.enum([
    'INVALID_REQUEST', 'SCOPE_MISMATCH', 'CONVERSATION_UNRESOLVED', 'GENERATION_CONFLICT',
    'AUTH', 'WORKSPACE_UNRESOLVED', 'WORKSPACE_CHANGED', 'STALE_GENERATION', 'PROFILE_CHANGED',
    'SNAPSHOT_UNAVAILABLE', 'MANIFEST_INVALID', 'MANIFEST_CONFLICT', 'FILE_HASH_MISMATCH',
    'FILE_TOO_LARGE', 'TOTAL_TOO_LARGE', 'FILE_LIMIT_EXCEEDED', 'REQUEST_TOO_LARGE',
    'OPERATION_NOT_FOUND', 'CANCELLED', 'UPSTREAM_PROTOCOL_ERROR', 'CONFIG_INVALID',
  ]),
  message: z.string().max(2_048).optional(),
  upstream: BridgeUpstreamErrorSchema.optional(),
}).strict()

export class BridgeContractError extends Error {
  readonly code: BridgeErrorCode
  readonly upstream?: z.infer<typeof BridgeUpstreamErrorSchema>

  constructor(code: BridgeErrorCode, message?: string, upstream?: z.infer<typeof BridgeUpstreamErrorSchema>) {
    super(message ?? code)
    this.name = 'BridgeContractError'
    this.code = code
    if (upstream) this.upstream = Object.freeze({ ...upstream })
  }
}

export function workspaceIdForCanonicalPath(clientInstanceId: string, canonicalPath: string): string {
  const parsedId = uuid.safeParse(clientInstanceId)
  if (!parsedId.success || typeof canonicalPath !== 'string' || !isAbsolute(canonicalPath) || resolve(canonicalPath) !== canonicalPath || canonicalPath.includes('\0'))
    throw new BridgeContractError('INVALID_REQUEST')
  return createHash('sha256')
    .update('zorya-search-workspace-v1\0')
    .update(clientInstanceId)
    .update('\0')
    .update(canonicalPath)
    .digest('hex')
}

export function createBridgeScope(input: {
  clientInstanceId: string
  conversationId: string
  canonicalPath: string
  rootLabel?: string
  sourceRootHash?: string
}): BridgeScope {
  return BridgeScopeSchema.parse({
    clientInstanceId: input.clientInstanceId,
    workspaceId: workspaceIdForCanonicalPath(input.clientInstanceId, input.canonicalPath),
    conversationId: input.conversationId,
    ...(input.rootLabel === undefined ? {} : { rootLabel: input.rootLabel }),
    ...(input.sourceRootHash === undefined ? {} : { sourceRootHash: input.sourceRootHash }),
  })
}

const BridgeManifestFileSchema = z.object({
  path: z.string().min(1).max(1_024),
  sha256,
  bytes: z.number().int().nonnegative().max(BRIDGE_MAX_FILE_BYTES),
}).strict()

export const BridgeManifestSchema = z.object({
  schemaVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
  files: z.array(BridgeManifestFileSchema).max(BRIDGE_MAX_FILES),
  fileCount: z.number().int().min(0).max(BRIDGE_MAX_FILES),
  totalBytes: z.number().int().min(0).max(BRIDGE_MAX_TOTAL_BYTES),
  manifestHash: sha256,
}).strict()

export type BridgeManifestFile = z.infer<typeof BridgeManifestFileSchema>
export interface BridgeManifest {
  readonly schemaVersion: typeof BRIDGE_PROTOCOL_VERSION
  readonly files: readonly BridgeManifestFile[]
  readonly fileCount: number
  readonly totalBytes: number
  readonly manifestHash: string
}

function isSafeRelativeSourcePath(path: string, allowedDocumentPaths: ReadonlySet<string> = new Set()): boolean {
  if (!path || path.includes('\0') || path.includes('\\') || path.includes(':') || /[\p{Cc}\u2028\u2029]/u.test(path)) return false
  if (isAbsolute(path) || win32.isAbsolute(path) || path.startsWith('/') || /^[A-Za-z]:/u.test(path)) return false
  const parts = path.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return false
  if (posix.normalize(path) !== path) return false
  const lower = path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC')
  const segments = lower.split('/')
  if (segments.some((part) => ['.git', 'node_modules', 'build', 'dist', 'coverage', '.cache', '.next', 'vendor', '.idea', '.vscode', '.ssh', '.aws', '.azure', '.config', '.gnupg', '.docker', '.kube', '.npm', '.pki', '.terraform', '.credentials', '.claude', '.continue', '.zed', '.aider', 'credentials', 'credential-store', 'config-store'].includes(part))) return false
  if (segments.includes('.codex')) return false
  const cursorIndex = segments.indexOf('.cursor')
  if (cursorIndex >= 0 && (cursorIndex !== 0 || segments[1] !== 'rules' || !/\.(?:md|mdx|mdc)$/iu.test(path) || !allowedDocumentPaths.has(path))) return false
  if (segments.some((part) => part === '.env' || part.startsWith('.env.') || part === 'gitconfig' || part === '.gitconfig' || ['.netrc', '.npmrc', '.pypirc', 'known_hosts', 'authorized_keys', 'mcp.json', 'auth.json'].includes(part) || /(?:secret|credential|private[-_]?key)/u.test(part) || /^id_(?:rsa|ed25519)(?:\.|$)/u.test(part))) return false
  if (segments.some((part) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(part) || /[. ]$/u.test(part))) return false
  if (/\.(?:md|mdx|mdc)$/iu.test(path) && !allowedDocumentPaths.has(path)) return false
  const extension = extname(lower)
  if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.md', '.mdx', '.mdc', '.json', '.yaml', '.yml', '.toml', '.html', '.css', '.scss', '.less', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.cpp', '.h', '.hpp', '.c', '.sh', '.sql', '.graphql', '.proto', '.vue', '.svelte'].includes(extension)) return false
  return true
}

export function validateBridgePath(path: string, options: { allowedDocumentPaths?: readonly string[] } = {}): string {
  if (!isSafeRelativeSourcePath(path, new Set(options.allowedDocumentPaths ?? []))) throw new BridgeContractError('MANIFEST_INVALID')
  return path
}

function validateManifestFiles(files: readonly BridgeManifestFile[], allowedDocumentPaths: ReadonlySet<string> = new Set()): BridgeManifestFile[] {
  if (files.length > BRIDGE_MAX_FILES) throw new BridgeContractError('FILE_LIMIT_EXCEEDED')
  const paths = new Set<string>()
  const folded = new Set<string>()
  let totalBytes = 0
  const sorted = [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  for (const file of sorted) {
    if (!isSafeRelativeSourcePath(file.path, allowedDocumentPaths)) throw new BridgeContractError('MANIFEST_INVALID')
    const key = file.path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC')
    if (paths.has(file.path) || folded.has(key)) throw new BridgeContractError('MANIFEST_INVALID')
    paths.add(file.path)
    folded.add(key)
    if (!sha256.safeParse(file.sha256).success || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new BridgeContractError('MANIFEST_INVALID')
    if (file.bytes > BRIDGE_MAX_FILE_BYTES) throw new BridgeContractError('FILE_TOO_LARGE')
    totalBytes += file.bytes
    if (totalBytes > BRIDGE_MAX_TOTAL_BYTES) throw new BridgeContractError('TOTAL_TOO_LARGE')
  }
  return sorted.map((file) => Object.freeze({ ...file }))
}

export function canonicalManifestBytes(files: readonly BridgeManifestFile[], options: { allowedDocumentPaths?: readonly string[] } = {}): Buffer {
  const allowed = new Set(options.allowedDocumentPaths ?? [])
  const sorted = validateManifestFiles(files, allowed)
  const body = {
    schemaVersion: BRIDGE_PROTOCOL_VERSION,
    files: sorted,
    fileCount: sorted.length,
    totalBytes: sorted.reduce((sum, file) => sum + file.bytes, 0),
  }
  return Buffer.from(JSON.stringify(body), 'utf8')
}

export function manifestHash(files: readonly BridgeManifestFile[], options: { allowedDocumentPaths?: readonly string[] } = {}): string {
  return createHash('sha256').update(canonicalManifestBytes(files, options)).digest('hex')
}

export function createBridgeManifest(files: readonly BridgeManifestFile[], options: { allowedDocumentPaths?: readonly string[] } = {}): BridgeManifest {
  const sorted = validateManifestFiles(files, new Set(options.allowedDocumentPaths ?? []))
  const totalBytes = sorted.reduce((sum, file) => sum + file.bytes, 0)
  return Object.freeze({
    schemaVersion: BRIDGE_PROTOCOL_VERSION,
    files: Object.freeze(sorted),
    fileCount: sorted.length,
    totalBytes,
    manifestHash: manifestHash(sorted, options),
  }) as BridgeManifest
}

export function parseBridgeManifest(input: unknown, options: { allowedDocumentPaths?: readonly string[] } = {}): BridgeManifest {
  const parsed = BridgeManifestSchema.safeParse(input)
  if (!parsed.success) throw new BridgeContractError('MANIFEST_INVALID')
  const canonical = createBridgeManifest(parsed.data.files, options)
  if (parsed.data.fileCount !== canonical.fileCount || parsed.data.totalBytes !== canonical.totalBytes || parsed.data.manifestHash !== canonical.manifestHash || parsed.data.files.some((file, index) => file.path !== canonical.files[index]?.path))
    throw new BridgeContractError('MANIFEST_INVALID')
  return canonical
}

export function validateBridgeFilePayload(path: string, bytes: Uint8Array, expectedHash: string, options: { allowedDocumentPaths?: readonly string[] } = {}): BridgeManifestFile {
  if (!isSafeRelativeSourcePath(path, new Set(options.allowedDocumentPaths ?? []))) throw new BridgeContractError('MANIFEST_INVALID')
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > BRIDGE_MAX_FILE_BYTES) throw new BridgeContractError('FILE_TOO_LARGE')
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (!sha256.safeParse(expectedHash).success || hash !== expectedHash) throw new BridgeContractError('FILE_HASH_MISMATCH')
  const content = Buffer.from(bytes).toString('utf8')
  if (!Buffer.from(content, 'utf8').equals(Buffer.from(bytes))) throw new BridgeContractError('MANIFEST_INVALID')
  if (/\0/u.test(content) || /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bsk-[A-Za-z0-9_-]{24,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u.test(content)) throw new BridgeContractError('MANIFEST_INVALID')
  return Object.freeze({ path, sha256: hash, bytes: bytes.byteLength })
}

const base = {
  schemaVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
  operationId: uuid,
  scope: BridgeScopeSchema,
}

export const BridgeRequestSchema = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('plan'), baseGeneration: z.number().int().nonnegative(), manifest: BridgeManifestSchema }).strict(),
  z.object({ ...base, action: z.literal('put'), baseGeneration: z.number().int().nonnegative(), expectedManifestHash: sha256, path: z.string().min(1).max(1_024), contentHash: sha256, offset: z.number().int().nonnegative().max(BRIDGE_MAX_FILE_BYTES), dataBase64: z.string().max(Math.ceil(BRIDGE_MAX_CHUNK_BYTES / 3) * 4) }).strict(),
  z.object({ ...base, action: z.literal('commit'), baseGeneration: z.number().int().nonnegative(), expectedManifestHash: sha256 }).strict(),
  z.object({ ...base, action: z.literal('call'), generation: z.number().int().nonnegative(), expectedManifestHash: sha256, toolName: z.string().min(1).max(128), arguments: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ ...base, action: z.literal('cancel'), targetGeneration: z.number().int().nonnegative(), expectedManifestHash: sha256, targetOperationId: uuid }).strict(),
  z.object({ ...base, action: z.literal('status') }).strict(),
])

export type BridgeRequest = z.infer<typeof BridgeRequestSchema>

export function parseBridgeRequest(input: unknown, options: { allowedDocumentPaths?: readonly string[] } = {}): BridgeRequest {
  const parsed = BridgeRequestSchema.safeParse(input)
  if (!parsed.success) throw new BridgeContractError('INVALID_REQUEST')
  let request = parsed.data
  if (parsed.data.action === 'plan') request = { ...parsed.data, manifest: parseBridgeManifest(parsed.data.manifest, options) } as unknown as BridgeRequest
  if (parsed.data.action === 'put') {
    const chunk = Buffer.from(parsed.data.dataBase64, 'base64')
    if (chunk.length > BRIDGE_MAX_CHUNK_BYTES || chunk.toString('base64') !== parsed.data.dataBase64) throw new BridgeContractError('INVALID_REQUEST')
    if (!chunk.length && (parsed.data.offset !== 0 || parsed.data.contentHash !== createHash('sha256').update(Buffer.alloc(0)).digest('hex'))) throw new BridgeContractError('INVALID_REQUEST')
    if (parsed.data.offset + chunk.length > BRIDGE_MAX_FILE_BYTES) throw new BridgeContractError('FILE_TOO_LARGE')
    validateBridgePath(parsed.data.path, options)
  }
  let requestBytes: number
  try { requestBytes = Buffer.byteLength(JSON.stringify(request), 'utf8') } catch { throw new BridgeContractError('INVALID_REQUEST') }
  if (requestBytes > BRIDGE_MAX_REQUEST_BYTES) throw new BridgeContractError('REQUEST_TOO_LARGE')
  return request
}

const responseBase = {
  schemaVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
  operationId: uuid,
  scope: BridgeScopeSchema,
}

export const BridgeSnapshotProvenanceSchema = z.object({
  kind: z.literal('analytical_snapshot'),
  scope: BridgeScopeSchema,
  generation: z.number().int().nonnegative(),
  manifestHash: sha256,
}).strict()

export const BridgeMcpCallResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tool_result'),
    result: z.object({ content: z.array(z.unknown()).optional(), structuredContent: z.unknown().optional(), isError: z.boolean().optional() }).passthrough(),
  }).strict(),
  z.object({ kind: z.literal('protocol_error'), error: z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }).strict() }).strict(),
])

export const BridgeResponseSchema = z.union([
  z.object({ ...responseBase, action: z.literal('plan'), ok: z.literal(true), expectedManifestHash: sha256, generation: z.number().int().nonnegative().nullable(), manifestHash: sha256.nullable(), uploadId: uuid, alreadyCurrent: z.boolean(), missingFiles: z.array(BridgeManifestFileSchema).max(BRIDGE_MAX_FILES), maxChunkBytes: z.literal(BRIDGE_MAX_CHUNK_BYTES) }).strict(),
  z.object({ ...responseBase, action: z.literal('put'), ok: z.literal(true), baseGeneration: z.number().int().nonnegative(), expectedManifestHash: sha256, path: z.string().min(1).max(1_024), receivedBytes: z.number().int().min(0).max(BRIDGE_MAX_FILE_BYTES), complete: z.boolean() }).strict(),
  z.object({ ...responseBase, action: z.literal('commit'), ok: z.literal(true), expectedManifestHash: sha256, generation: z.number().int().nonnegative(), manifestHash: sha256, provenance: BridgeSnapshotProvenanceSchema }).strict(),
  z.object({ ...responseBase, action: z.literal('call'), ok: z.literal(true), expectedManifestHash: sha256, generation: z.number().int().nonnegative(), manifestHash: sha256, provenance: BridgeSnapshotProvenanceSchema, result: BridgeMcpCallResultSchema }).strict(),
  z.object({ ...responseBase, action: z.literal('cancel'), ok: z.literal(true), targetGeneration: z.number().int().nonnegative(), expectedManifestHash: sha256, targetOperationId: uuid, settled: z.boolean() }).strict(),
  z.object({ ...responseBase, action: z.literal('status'), ok: z.literal(true), generation: z.number().int().nonnegative().nullable(), manifestHash: sha256.nullable(), state: z.enum(['empty', 'ready', 'syncing', 'calling']), activeOperations: z.number().int().min(0).max(BRIDGE_MAX_CONCURRENT_OPERATIONS) }).strict(),
  z.object({ ...responseBase, action: z.enum(['plan', 'put', 'commit', 'call', 'cancel', 'status']), ok: z.literal(false), generation: z.number().int().nonnegative().nullable(), manifestHash: sha256.nullable(), expectedManifestHash: sha256.nullable(), error: BridgeErrorSchema }).strict(),
])

export type BridgeResponse = z.infer<typeof BridgeResponseSchema>

export function parseBridgeResponse(input: unknown, options: { allowedDocumentPaths?: readonly string[] } = {}): BridgeResponse {
  const parsed = BridgeResponseSchema.safeParse(input)
  if (!parsed.success) throw new BridgeContractError('INVALID_REQUEST')
  if (parsed.data.action === 'plan' && parsed.data.ok) {
    const safeFiles = validateManifestFiles(parsed.data.missingFiles, new Set(options.allowedDocumentPaths ?? []))
    if (parsed.data.uploadId !== parsed.data.operationId || parsed.data.missingFiles.some((file, index) => file.path !== safeFiles[index]?.path)) throw new BridgeContractError('MANIFEST_INVALID')
    if (parsed.data.alreadyCurrent && (parsed.data.generation === null || parsed.data.manifestHash !== parsed.data.expectedManifestHash)) throw new BridgeContractError('MANIFEST_CONFLICT')
  }
  if (parsed.data.action === 'put' && parsed.data.ok) validateBridgePath(parsed.data.path, options)
  if (parsed.data.ok && (parsed.data.action === 'commit' || parsed.data.action === 'call')) {
    const provenance = parsed.data.provenance
    if (
      JSON.stringify(provenance.scope) !== JSON.stringify(parsed.data.scope) ||
      provenance.generation !== parsed.data.generation ||
      provenance.manifestHash !== parsed.data.manifestHash ||
      parsed.data.expectedManifestHash !== parsed.data.manifestHash
    ) throw new BridgeContractError('SCOPE_MISMATCH')
  }
  if (parsed.data.ok && parsed.data.action === 'status') {
    if ((parsed.data.generation === null) !== (parsed.data.manifestHash === null)) throw new BridgeContractError('SNAPSHOT_UNAVAILABLE')
    if ((parsed.data.state === 'ready' || parsed.data.state === 'calling') && parsed.data.generation === null) throw new BridgeContractError('SNAPSHOT_UNAVAILABLE')
  }
  return parsed.data
}
