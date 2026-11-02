import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { BridgeServerConfig } from './config.js'
import {
  BRIDGE_MAX_CHUNKS_PER_TRANSFER,
  BRIDGE_MAX_PENDING_TRANSFERS_PER_CLIENT,
  BRIDGE_MAX_SNAPSHOT_BYTES,
  BRIDGE_MAX_TOTAL_BYTES,
  BridgeContractError,
  BridgeScopeSchema,
  parseBridgeManifest,
  validateBridgeFilePayload,
  type BridgeManifest,
  type BridgeManifestFile,
  type BridgeScope,
} from './protocol.js'

const STORE_SCHEMA_VERSION = 1
const MAX_JSON_BYTES = 2_000_000
const fileHash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')

export interface BridgePublishedSnapshot {
  readonly schemaVersion: 1
  readonly generation: number
  readonly manifestHash: string
  readonly runtimeFingerprint: string
  readonly createdAt: string
  readonly manifest: BridgeManifest
}

export interface BridgeTransfer {
  readonly operationId: string
  readonly scope: BridgeScope
  readonly baseGeneration: number
  readonly manifest: BridgeManifest
  readonly createdAt: string
  readonly chunks: Readonly<Record<string, readonly { offset: number; length: number; sha256: string }[]>>
}

export interface BridgeUploadProgress {
  readonly receivedBytes: number
  readonly complete: boolean
}

export interface BridgeSnapshotPaths {
  readonly pendingPath: string
  readonly workspacePath: string
  readonly stagingPath: string
  readonly backupPath: string
  readonly journalPath: string
  readonly sourcePath: string
  readonly dataPath: string
}

interface LockFile {
  readonly path: string
  readonly identity: { dev: number; ino: number }
  readonly nonce: string
}

function invalidStore(): never { throw new BridgeContractError('STORE_INVALID') }
function workspaceKey(scope: Pick<BridgeScope, 'clientInstanceId' | 'workspaceId'>): string {
  return `${scope.clientInstanceId}/${scope.workspaceId}`
}
function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
function isWithin(parent: string, path: string): boolean {
  const rel = relative(parent, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

async function readJson(path: string): Promise<unknown> {
  let info
  try { info = await lstat(path) } catch { invalidStore() }
  if (!info!.isFile() || info!.isSymbolicLink() || info!.size > MAX_JSON_BYTES) invalidStore()
  let text: string
  try { text = await readFile(path, 'utf8') } catch { invalidStore() }
  try { return JSON.parse(text!) as unknown } catch { invalidStore() }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const temporary = join(parent, `.bridge-tmp-${randomUUID()}`)
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_JSON_BYTES) throw new BridgeContractError('STORE_INVALID')
  let handle
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(serialized, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
  } catch {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw new BridgeContractError('STORE_INVALID')
  }
}

async function ensureDirectory(path: string): Promise<void> {
  try { await mkdir(path, { recursive: true, mode: 0o700 }) } catch { invalidStore() }
  let info
  try { info = await lstat(path) } catch { invalidStore() }
  if (!info!.isDirectory() || info!.isSymbolicLink() || process.platform !== 'win32' && (info!.mode & 0o077) !== 0) invalidStore()
}

async function assertRegularFile(path: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  let info
  try { info = await lstat(path) } catch { invalidStore() }
  if (!info!.isFile() || info!.isSymbolicLink()) invalidStore()
  return info!
}

async function assertDirectoryExists(path: string): Promise<void> {
  let info
  try { info = await lstat(path) } catch { invalidStore() }
  if (!info!.isDirectory() || info!.isSymbolicLink() || process.platform !== 'win32' && (info!.mode & 0o077) !== 0) invalidStore()
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    invalidStore()
  }
}

function exactMarker(value: unknown, fields: Record<string, unknown>): boolean {
  return plainObject(value) && Object.keys(fields).every((key) => value[key] === fields[key]) && Object.keys(value).length === Object.keys(fields).length
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) throw new BridgeContractError('INVALID_REQUEST')
}

export class BridgeStore {
  readonly dataDir: string
  private readonly lock: LockFile
  private readonly clientsRoot: string
  private readonly documentPaths = new Map<string, readonly string[]>()
  private closed = false
  private readonly workspaceTails = new Map<string, Promise<void>>()
  private quotaTail: Promise<void> = Promise.resolve()
  private readonly unsafeWorkspaces = new Set<string>()

  private constructor(dataDir: string, lock: LockFile, config: BridgeServerConfig) {
    this.dataDir = dataDir
    this.lock = lock
    this.clientsRoot = join(dataDir, 'clients')
    for (const client of config.clients) this.documentPaths.set(client.clientId, client.allowedDocumentPaths ?? [])
  }

  static async open(config: BridgeServerConfig): Promise<BridgeStore> {
    if (!isAbsolute(config.dataDir)) invalidStore()
    const dataDir = resolve(config.dataDir)
    await ensureDirectory(dataDir)
    const canonical = await realpath(dataDir).catch(() => invalidStore())
    if (canonical !== dataDir) invalidStore()
    const lockPath = join(dataDir, '.bridge-server-lock')
    const nonce = randomUUID()
    let handle
    let lockIdentity: { dev: number; ino: number } | undefined
    try {
      try {
        handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !await removeDeadBridgeLock(lockPath)) throw error
        handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      }
      const stat = await handle.stat()
      lockIdentity = { dev: stat.dev, ino: stat.ino }
      await handle.writeFile(JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, nonce, pid: process.pid }), 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      const lock = { path: lockPath, identity: { dev: stat.dev, ino: stat.ino }, nonce }
      const store = new BridgeStore(dataDir, lock, config)
      await store.initialize()
      await store.recoverIncomplete()
      return store
    } catch (error) {
      await handle?.close().catch(() => undefined)
      const removeOwnLock = async () => {
        if (!lockIdentity || !await lockOwned(lockPath, nonce)) return
        const info = await lstat(lockPath).catch(() => undefined)
        if (info?.dev === lockIdentity!.dev && info.ino === lockIdentity!.ino) await unlink(lockPath).catch(() => undefined)
      }
      if (error instanceof BridgeContractError) {
        await removeOwnLock()
        throw error
      }
      await removeOwnLock()
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new BridgeContractError('STORE_INVALID')
      throw new BridgeContractError('STORE_INVALID')
    }
  }

  private async initialize(): Promise<void> {
    const allowedEntries = new Set(['.bridge-server-lock', '.bridge-store.json', 'clients', 'secrets.json'])
    const rootEntries = await readdir(this.dataDir)
    if (rootEntries.some((entry) => !allowedEntries.has(entry))) invalidStore()
    if (rootEntries.includes('secrets.json')) {
      const secretInfo = await assertRegularFile(join(this.dataDir, 'secrets.json'))
      if (secretInfo.size > 256_000 || process.platform !== 'win32' && (Number(secretInfo.mode) & 0o077) !== 0) invalidStore()
    }
    const markerPath = join(this.dataDir, '.bridge-store.json')
    let info
    try { info = await lstat(markerPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') invalidStore()
    }
    if (info) {
      const marker = await readJson(markerPath)
      if (!plainObject(marker) || marker.schemaVersion !== STORE_SCHEMA_VERSION || typeof marker.storeId !== 'string' || !/^[0-9a-f-]{36}$/u.test(marker.storeId)) invalidStore()
    } else {
      const entries = await readdir(this.dataDir)
      if (entries.some((entry) => entry !== '.bridge-server-lock' && entry !== 'secrets.json')) invalidStore()
      await atomicJson(markerPath, { schemaVersion: STORE_SCHEMA_VERSION, storeId: randomUUID() })
    }
    await ensureDirectory(this.clientsRoot)
  }

  private assertOpen(): void {
    if (this.closed) throw new BridgeContractError('STORE_INVALID')
  }

  private clientPath(clientId: string): string { return join(this.clientsRoot, clientId) }
  private documentsFor(clientId: string): readonly string[] { return this.documentPaths.get(clientId) ?? [] }
  private workspacePath(scope: Pick<BridgeScope, 'clientInstanceId' | 'workspaceId'>): string {
    return join(this.clientPath(scope.clientInstanceId), scope.workspaceId)
  }
  private uploadsPath(scope: Pick<BridgeScope, 'clientInstanceId' | 'workspaceId'>): string { return join(this.workspacePath(scope), 'uploads') }
  private blobsPath(scope: Pick<BridgeScope, 'clientInstanceId' | 'workspaceId'>): string { return join(this.workspacePath(scope), 'blobs') }
  private snapshotsPath(scope: Pick<BridgeScope, 'clientInstanceId' | 'workspaceId'>): string { return join(this.workspacePath(scope), '.bridge-sync') }

  private async withQuotaLock<T>(work: () => Promise<T>): Promise<T> {
    const prior = this.quotaTail
    let release!: () => void
    this.quotaTail = new Promise<void>((resolveRelease) => { release = resolveRelease })
    await prior
    try { return await work() } finally { release() }
  }

  private async ensureOwnedDirectory(path: string, markerName: string, fields: Record<string, unknown>): Promise<void> {
    await ensureDirectory(path)
    const markerPath = join(path, markerName)
    let exists = true
    try { await lstat(markerPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') invalidStore()
      exists = false
    }
    if (exists) {
      if (!exactMarker(await readJson(markerPath), fields)) invalidStore()
      return
    }
    const entries = await readdir(path)
    if (entries.some((entry) => entry !== markerName)) invalidStore()
    await atomicJson(markerPath, fields)
  }

  private async ensureWorkspace(scope: BridgeScope, enforceLimits = true): Promise<string> {
    return this.withQuotaLock(() => this.ensureWorkspaceUnlocked(scope, enforceLimits))
  }

  private async ensureWorkspaceUnlocked(scope: BridgeScope, enforceLimits = true): Promise<string> {
    this.assertOpen()
    const clientId = scope.clientInstanceId
    if (!BridgeScopeSchema.safeParse(scope).success) throw new BridgeContractError('SCOPE_MISMATCH')
    const clientPath = this.clientPath(clientId)
    await this.ensureOwnedDirectory(clientPath, '.bridge-client.json', { schemaVersion: STORE_SCHEMA_VERSION, clientId })
    const workspacePath = this.workspacePath(scope)
    let workspaceExists = true
    try { await lstat(workspacePath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') invalidStore()
      workspaceExists = false
    }
    if (!workspaceExists && enforceLimits) {
      const counts = await this.countWorkspaces(clientId)
      if (counts.forClient >= 8 || counts.total >= 32) throw new BridgeContractError('WORKSPACE_LIMIT_EXCEEDED')
    }
    await this.ensureOwnedDirectory(workspacePath, '.bridge-workspace.json', {
      schemaVersion: STORE_SCHEMA_VERSION,
      clientId,
      workspaceId: scope.workspaceId,
    })
    await ensureDirectory(this.uploadsPath(scope))
    await ensureDirectory(this.blobsPath(scope))
    await ensureDirectory(this.snapshotsPath(scope))
    return workspacePath
  }

  private async countWorkspaces(clientId?: string): Promise<{ total: number; forClient: number }> {
    let clients: string[]
    try { clients = await readdir(this.clientsRoot) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { total: 0, forClient: 0 }
      invalidStore()
    }
    let total = 0
    let forClient = 0
    for (const name of clients!) {
      if (!/^[0-9a-f-]{36}$/u.test(name)) invalidStore()
      const dir = this.clientPath(name)
      await this.ensureOwnedDirectory(dir, '.bridge-client.json', { schemaVersion: STORE_SCHEMA_VERSION, clientId: name })
      let workspaces: string[]
      try { workspaces = await readdir(dir) } catch { invalidStore() }
      for (const workspaceId of workspaces!) {
        if (workspaceId === '.bridge-client.json') continue
        if (!/^[0-9a-f]{64}$/u.test(workspaceId)) invalidStore()
        const workspace = join(dir, workspaceId)
        await this.ensureOwnedDirectory(workspace, '.bridge-workspace.json', {
          schemaVersion: STORE_SCHEMA_VERSION,
          clientId: name,
          workspaceId,
        })
        total++
        if (name === clientId) forClient++
      }
    }
    return { total, forClient }
  }

  async withWorkspaceLock<T>(scope: Pick<BridgeScope, 'clientInstanceId' | 'workspaceId'>, work: () => Promise<T>): Promise<T> {
    this.assertOpen()
    assertUuid(scope.clientInstanceId)
    if (!/^[0-9a-f]{64}$/u.test(scope.workspaceId)) throw new BridgeContractError('SCOPE_MISMATCH')
    const key = workspaceKey(scope)
    const previous = this.workspaceTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolveRelease) => { release = resolveRelease })
    const queued = previous.then(() => current)
    this.workspaceTails.set(key, queued)
    await previous
    try { return await work() } finally {
      release()
      if (this.workspaceTails.get(key) === queued) this.workspaceTails.delete(key)
    }
  }

  async current(scope: BridgeScope): Promise<BridgePublishedSnapshot | null> {
    this.assertOpen()
    if (!BridgeScopeSchema.safeParse(scope).success) throw new BridgeContractError('SCOPE_MISMATCH')
    if (this.unsafeWorkspaces.has(workspaceKey(scope))) throw new BridgeContractError('WORKSPACE_CHANGED')
    let dirInfo
    try { dirInfo = await lstat(this.workspacePath(scope)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      invalidStore()
    }
    if (!dirInfo!.isDirectory() || dirInfo!.isSymbolicLink()) invalidStore()
    await this.ensureOwnedDirectory(this.workspacePath(scope), '.bridge-workspace.json', { schemaVersion: STORE_SCHEMA_VERSION, clientId: scope.clientInstanceId, workspaceId: scope.workspaceId })
    const pointerPath = join(this.workspacePath(scope), 'current.json')
    let info
    try { info = await lstat(pointerPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      invalidStore()
    }
    if (!info!.isFile() || info!.isSymbolicLink()) invalidStore()
    const snapshot = parseSnapshot(await readJson(pointerPath))
    await assertDirectoryExists(join(this.workspacePath(scope), 'source'))
    await assertDirectoryExists(join(this.workspacePath(scope), 'data'))
    return snapshot
  }

  async plan(scope: BridgeScope, operationId: string, baseGeneration: number, manifest: BridgeManifest, runtimeFingerprint: string, allowedDocumentPaths: readonly string[] = []): Promise<{ transfer: BridgeTransfer; missingFiles: BridgeManifestFile[]; current: BridgePublishedSnapshot | null; alreadyCurrent: boolean }> {
    return this.withQuotaLock(() => this.planUnlocked(scope, operationId, baseGeneration, manifest, runtimeFingerprint, allowedDocumentPaths))
  }

  private async planUnlocked(scope: BridgeScope, operationId: string, baseGeneration: number, manifest: BridgeManifest, runtimeFingerprint: string, allowedDocumentPaths: readonly string[]): Promise<{ transfer: BridgeTransfer; missingFiles: BridgeManifestFile[]; current: BridgePublishedSnapshot | null; alreadyCurrent: boolean }> {
    assertUuid(operationId)
    await this.ensureWorkspaceUnlocked(scope)
    const canonical = parseBridgeManifest(manifest, { allowedDocumentPaths })
    const current = await this.current(scope)
    const actualGeneration = current?.generation ?? 0
    if (baseGeneration !== actualGeneration) throw new BridgeContractError('GENERATION_CONFLICT')
    const uploadDir = join(this.uploadsPath(scope), operationId)
    let exists = true
    try { await lstat(uploadDir) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') invalidStore()
      exists = false
    }
    const alreadyCurrent = Boolean(current && current.manifestHash === canonical.manifestHash)
    let transfer: BridgeTransfer
    if (exists) {
      await this.ensureOwnedDirectory(uploadDir, '.bridge-upload.json', { schemaVersion: STORE_SCHEMA_VERSION, operationId, clientId: scope.clientInstanceId, workspaceId: scope.workspaceId })
      const state = await readJson(join(uploadDir, 'transfer.json'))
      if (!plainObject(state)) invalidStore()
      const prior = parseTransfer(state, allowedDocumentPaths)
      if (prior.operationId !== operationId || prior.baseGeneration !== baseGeneration || JSON.stringify(prior.scope) !== JSON.stringify(scope) || prior.manifest.manifestHash !== canonical.manifestHash) throw new BridgeContractError('MANIFEST_CONFLICT')
      transfer = prior
      if (alreadyCurrent) {
        await this.removeTransfer(scope, operationId)
        await this.collectBlobs(scope)
        transfer = Object.freeze({ operationId, scope, baseGeneration, manifest: canonical, createdAt: prior.createdAt, chunks: Object.freeze({}) })
      }
    } else {
      transfer = Object.freeze({ operationId, scope, baseGeneration, manifest: canonical, createdAt: new Date().toISOString(), chunks: Object.freeze({}) })
      if (!alreadyCurrent) {
        const pendingCount = await this.countPendingTransfers(scope.clientInstanceId)
        if (pendingCount >= BRIDGE_MAX_PENDING_TRANSFERS_PER_CLIENT) throw new BridgeContractError('TRANSFER_LIMIT_EXCEEDED')
        await this.ensureOwnedDirectory(uploadDir, '.bridge-upload.json', { schemaVersion: STORE_SCHEMA_VERSION, operationId, clientId: scope.clientInstanceId, workspaceId: scope.workspaceId })
        await ensureDirectory(join(uploadDir, 'parts'))
        await atomicJson(join(uploadDir, 'transfer.json'), transfer)
      }
    }
    const missingFiles: BridgeManifestFile[] = []
    const seenHashes = new Set<string>()
    for (const item of canonical.files) {
      if (seenHashes.has(item.sha256)) continue
      seenHashes.add(item.sha256)
      const blob = await this.readBlob(scope, item.sha256, item.bytes)
      if (!blob) missingFiles.push(item)
    }
    return { transfer, missingFiles, current, alreadyCurrent }
  }

  private async countPendingTransfers(clientId: string): Promise<number> {
    const client = this.clientPath(clientId)
    let workspaceIds: string[]
    try { workspaceIds = await readdir(client) } catch { invalidStore() }
    let count = 0
    for (const workspaceId of workspaceIds!) {
      if (workspaceId === '.bridge-client.json') continue
      if (!/^[0-9a-f]{64}$/u.test(workspaceId)) invalidStore()
      const uploads = join(client, workspaceId, 'uploads')
      const entries = await readdir(uploads).catch(() => invalidStore())
      count += entries.length
    }
    return count
  }

  async put(scope: BridgeScope, operationId: string, baseGeneration: number, expectedManifestHash: string, path: string, contentHash: string, expectedBytes: number, offset: number, chunk: Uint8Array, allowedDocumentPaths: readonly string[] = []): Promise<BridgeUploadProgress> {
    assertUuid(operationId)
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > 1_000_000 || !Number.isSafeInteger(offset) || offset < 0 || offset > expectedBytes || !(chunk instanceof Uint8Array) || chunk.byteLength > 128_000 || offset + chunk.byteLength > expectedBytes) throw new BridgeContractError('INVALID_REQUEST')
    await this.ensureWorkspace(scope, false)
    const uploadDir = join(this.uploadsPath(scope), operationId)
    await this.ensureOwnedDirectory(uploadDir, '.bridge-upload.json', { schemaVersion: STORE_SCHEMA_VERSION, operationId, clientId: scope.clientInstanceId, workspaceId: scope.workspaceId })
    const statePath = join(uploadDir, 'transfer.json')
    const transfer = parseTransfer(await readJson(statePath), allowedDocumentPaths)
    if (transfer.operationId !== operationId || transfer.baseGeneration !== baseGeneration || transfer.manifest.manifestHash !== expectedManifestHash || JSON.stringify(transfer.scope) !== JSON.stringify(scope)) throw new BridgeContractError('MANIFEST_CONFLICT')
    const declaration = transfer.manifest.files.find((file) => file.path === path)
    if (!declaration || declaration.sha256 !== contentHash || declaration.bytes !== expectedBytes) throw new BridgeContractError('MANIFEST_CONFLICT')
    const blob = await this.readBlob(scope, contentHash, expectedBytes)
    if (blob) return Object.freeze({ receivedBytes: expectedBytes, complete: true })
    const part = join(uploadDir, 'parts', contentHash)
    await ensureDirectory(dirname(part))
    let existing = Buffer.alloc(0)
    let partInfo
    try {
      partInfo = await lstat(part)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') invalidStore()
    }
    if (partInfo) {
      if (!partInfo.isFile() || partInfo.isSymbolicLink() || partInfo.size > expectedBytes) invalidStore()
      existing = await readFile(part).catch(() => invalidStore())
    }
    const journal = transfer.chunks[contentHash] ?? []
    if (journal.reduce((sum, entry) => sum + entry.length, 0) !== existing.byteLength || journal.length > BRIDGE_MAX_CHUNKS_PER_TRANSFER) invalidStore()
    const chunkTotal = Object.values(transfer.chunks).reduce((sum, entries) => sum + entries.length, 0)
    if (chunkTotal >= BRIDGE_MAX_CHUNKS_PER_TRANSFER && existing.byteLength !== expectedBytes) throw new BridgeContractError('TRANSFER_LIMIT_EXCEEDED')
    const chunkHash = fileHash(chunk)
    if (offset < existing.byteLength) {
      const replay = journal.find((item) => item.offset === offset && item.length === chunk.byteLength && item.sha256 === chunkHash)
      if (!replay || !existing.subarray(offset, offset + chunk.byteLength).equals(Buffer.from(chunk))) throw new BridgeContractError('MANIFEST_CONFLICT')
      return Object.freeze({ receivedBytes: existing.byteLength, complete: existing.byteLength === expectedBytes })
    }
    if (offset !== existing.byteLength || offset + chunk.byteLength > expectedBytes) throw new BridgeContractError('MANIFEST_CONFLICT')
    if (chunk.byteLength === 0 && (expectedBytes !== 0 || offset !== 0)) throw new BridgeContractError('MANIFEST_CONFLICT')
    let handle
    try {
      handle = await open(part, constants.O_CREAT | constants.O_WRONLY | (existing.byteLength === 0 ? constants.O_TRUNC : 0), 0o600)
      await handle.write(chunk, 0, chunk.byteLength, offset)
      await handle.sync()
      await handle.close()
      handle = undefined
    } catch {
      await handle?.close().catch(() => undefined)
      throw new BridgeContractError('STORE_INVALID')
    }
    const updatedBytes = Buffer.concat([existing, Buffer.from(chunk)])
    const updatedChunks = [...journal, { offset, length: chunk.byteLength, sha256: chunkHash }]
    const updated: BridgeTransfer = Object.freeze({ ...transfer, chunks: Object.freeze({ ...transfer.chunks, [contentHash]: Object.freeze(updatedChunks) }) })
    await atomicJson(statePath, updated)
    if (updatedBytes.byteLength === expectedBytes) {
      validateBridgeFilePayload(path, updatedBytes, contentHash, { allowedDocumentPaths })
      const blobPath = join(this.blobsPath(scope), contentHash)
      try {
        await rename(part, blobPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          const existingBlob = await this.readBlob(scope, contentHash, expectedBytes)
          if (!existingBlob) throw new BridgeContractError('STORE_INVALID')
          await unlink(part)
        } else throw new BridgeContractError('STORE_INVALID')
      }
    }
    return Object.freeze({ receivedBytes: updatedBytes.byteLength, complete: updatedBytes.byteLength === expectedBytes })
  }

  private async readBlob(scope: BridgeScope, hash: string, expectedBytes: number): Promise<Buffer | null> {
    const path = join(this.blobsPath(scope), hash)
    let info
    try { info = await lstat(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      invalidStore()
    }
    if (!info!.isFile() || info!.isSymbolicLink() || info!.size !== expectedBytes) invalidStore()
    const bytes = await readFile(path).catch(() => invalidStore())
    if (fileHash(bytes!) !== hash) invalidStore()
    return bytes!
  }

  async transfer(scope: BridgeScope, operationId: string, allowedDocumentPaths: readonly string[] = []): Promise<BridgeTransfer> {
    assertUuid(operationId)
    const path = join(this.uploadsPath(scope), operationId, 'transfer.json')
    return parseTransfer(await readJson(path), allowedDocumentPaths)
  }

  async createSnapshot(scope: BridgeScope, operationId: string, manifest: BridgeManifest, allowedDocumentPaths: readonly string[] = []): Promise<BridgeSnapshotPaths> {
    assertUuid(operationId)
    await this.ensureWorkspace(scope, false)
    await this.recoverWorkspaceSync(scope)
    manifest = parseBridgeManifest(manifest, { allowedDocumentPaths })
    const workspacePath = this.workspacePath(scope)
    const pendingPath = join(this.snapshotsPath(scope), operationId)
    const stagingPath = join(pendingPath, 'staging')
    const backupPath = join(pendingPath, 'backup')
    const sourcePath = join(workspacePath, 'source')
    const dataPath = join(workspacePath, 'data')
    const paths = Object.freeze({
      pendingPath, workspacePath, stagingPath, backupPath,
      journalPath: join(pendingPath, 'journal.json'), sourcePath, dataPath,
    })
    try {
      await mkdir(pendingPath, { mode: 0o700 })
      await atomicJson(join(pendingPath, '.bridge-sync.json'), { schemaVersion: STORE_SCHEMA_VERSION, operationId, clientId: scope.clientInstanceId, workspaceId: scope.workspaceId })
      await ensureDirectory(stagingPath)
      await ensureDirectory(backupPath)
      if (await pathExists(sourcePath)) await assertDirectoryExists(sourcePath)
      else await ensureDirectory(sourcePath)
      if (await pathExists(dataPath)) await assertDirectoryExists(dataPath)
      else await ensureDirectory(dataPath)
      const current = await this.current(scope)
      await this.assertCurrentSource(scope, current)
      for (const item of manifest.files) {
        const bytes = await this.readBlob(scope, item.sha256, item.bytes)
        if (!bytes) throw new BridgeContractError('SNAPSHOT_UNAVAILABLE')
        validateBridgeFilePayload(item.path, bytes, item.sha256, { allowedDocumentPaths })
        const destination = resolve(stagingPath, ...item.path.split('/'))
        if (!isWithin(stagingPath, destination)) throw new BridgeContractError('MANIFEST_INVALID')
        await ensureDirectory(dirname(destination))
        let handle
        try {
          handle = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
          await handle.writeFile(bytes)
          await handle.sync()
          await handle.close()
        } catch {
          await handle?.close().catch(() => undefined)
          throw new BridgeContractError('STORE_INVALID')
        }
      }
      return paths
    } catch (error) {
      try { await this.abortSnapshot(scope, paths) } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Bridge snapshot staging cleanup failed') }
      throw error
    }
  }

  async publishSnapshot(scope: BridgeScope, paths: BridgeSnapshotPaths, manifest: BridgeManifest, runtimeFingerprint: string): Promise<BridgePublishedSnapshot> {
    const current = await this.current(scope)
    const generation = (current?.generation ?? 0) + 1
    const canonicalWorkspace = this.workspacePath(scope)
    const pendingName = paths.pendingPath.split(sep).at(-1)
    if (!pendingName || resolve(paths.workspacePath) !== canonicalWorkspace || resolve(paths.pendingPath) !== join(this.snapshotsPath(scope), pendingName) || resolve(paths.sourcePath) !== join(canonicalWorkspace, 'source') || resolve(paths.dataPath) !== join(canonicalWorkspace, 'data')) throw new BridgeContractError('STORE_INVALID')
    const marker = await readJson(join(paths.pendingPath, '.bridge-sync.json'))
    if (!plainObject(marker) || marker.schemaVersion !== STORE_SCHEMA_VERSION || typeof marker.operationId !== 'string' || marker.clientId !== scope.clientInstanceId || marker.workspaceId !== scope.workspaceId) throw new BridgeContractError('WORKSPACE_CHANGED')
    if (resolve(paths.pendingPath) !== join(this.snapshotsPath(scope), marker.operationId) || resolve(paths.stagingPath) !== join(paths.pendingPath, 'staging') || resolve(paths.backupPath) !== join(paths.pendingPath, 'backup') || resolve(paths.journalPath) !== join(paths.pendingPath, 'journal.json')) throw new BridgeContractError('STORE_INVALID')
    const canonicalManifest = parseBridgeManifest(manifest, { allowedDocumentPaths: this.documentsFor(scope.clientInstanceId) })
    if (!/^[0-9a-f]{64}$/u.test(runtimeFingerprint)) throw new BridgeContractError('PROFILE_CHANGED')
    if (current?.manifestHash === canonicalManifest.manifestHash) {
      await this.abortSnapshot(scope, paths)
      return current
    }
    await this.assertCurrentSource(scope, current)
    await this.assertTreeMatches(paths.stagingPath, canonicalManifest)
    const oldTop = await readdir(paths.sourcePath)
    const newTop = await readdir(paths.stagingPath)
    const journal = {
      schemaVersion: STORE_SCHEMA_VERSION,
      operationId: marker.operationId,
      clientId: scope.clientInstanceId,
      workspaceId: scope.workspaceId,
      oldGeneration: current?.generation ?? 0,
      oldManifestHash: current?.manifestHash ?? null,
      generation,
      manifestHash: canonicalManifest.manifestHash,
      oldTop,
      newTop,
      phase: 'prepared',
    }
    await atomicJson(paths.journalPath, journal)
    try {
      for (const name of oldTop) await rename(join(paths.sourcePath, name), join(paths.backupPath, name))
      for (const name of newTop) await rename(join(paths.stagingPath, name), join(paths.sourcePath, name))
      await atomicJson(paths.journalPath, { ...journal, phase: 'swapped' })
    } catch (error) {
      try { await this.recoverSync(paths, journal, false) } catch {
        this.unsafeWorkspaces.add(workspaceKey(scope))
        throw new BridgeContractError('WORKSPACE_CHANGED')
      }
      throw error instanceof BridgeContractError ? error : new BridgeContractError('STORE_INVALID')
    }
    const snapshot: BridgePublishedSnapshot = Object.freeze({ schemaVersion: STORE_SCHEMA_VERSION, generation, manifestHash: canonicalManifest.manifestHash, runtimeFingerprint, createdAt: new Date().toISOString(), manifest: canonicalManifest })
    try {
      await atomicJson(join(this.workspacePath(scope), 'current.json'), snapshot)
    } catch (error) {
      try { await this.recoverSync(paths, journal, false) } catch {
        this.unsafeWorkspaces.add(workspaceKey(scope))
        throw new BridgeContractError('WORKSPACE_CHANGED')
      }
      throw error
    }
    await atomicJson(paths.journalPath, { ...journal, phase: 'published' }).catch(() => undefined)
    await rm(paths.pendingPath, { recursive: true, force: false }).catch(() => undefined)
    await this.collectBlobs(scope).catch(() => undefined)
    return snapshot
  }

  async snapshotPaths(scope: BridgeScope, snapshot: BridgePublishedSnapshot): Promise<BridgeSnapshotPaths> {
    const workspacePath = this.workspacePath(scope)
    if (!isWithin(this.dataDir, workspacePath)) invalidStore()
    await assertDirectoryExists(join(workspacePath, 'source'))
    await assertDirectoryExists(join(workspacePath, 'data'))
    return Object.freeze({
      pendingPath: this.snapshotsPath(scope), workspacePath,
      stagingPath: '', backupPath: '', journalPath: '',
      sourcePath: join(workspacePath, 'source'), dataPath: join(workspacePath, 'data'),
    })
  }

  async runtimePaths(scope: BridgeScope): Promise<BridgeSnapshotPaths> {
    const workspacePath = await this.withQuotaLock(() => this.ensureWorkspaceUnlocked(scope))
    const sourcePath = join(workspacePath, 'source')
    const dataPath = join(workspacePath, 'data')
    if (!await pathExists(sourcePath)) await ensureDirectory(sourcePath)
    if (!await pathExists(dataPath)) await ensureDirectory(dataPath)
    await assertDirectoryExists(sourcePath)
    await assertDirectoryExists(dataPath)
    if (!await this.current(scope) && (await readdir(sourcePath)).length !== 0) throw new BridgeContractError('WORKSPACE_CHANGED')
    return Object.freeze({
      pendingPath: this.snapshotsPath(scope), workspacePath,
      stagingPath: '', backupPath: '', journalPath: '', sourcePath, dataPath,
    })
  }

  async recoverDeadRuntimeOwnerLock(scope: BridgeScope): Promise<void> {
    const paths = await this.runtimePaths(scope)
    const lockPath = join(paths.dataPath, '.zorya-search-owner')
    let info
    try { info = await lstat(lockPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      invalidStore()
    }
    if (!info!.isFile() || info!.isSymbolicLink() || info!.size > 4_096) invalidStore()
    const text = await readFile(lockPath, 'utf8').catch(() => invalidStore())
    let record: unknown
    try { record = JSON.parse(text!) as unknown } catch { invalidStore() }
    if (!plainObject(record) || !Number.isSafeInteger(record.pid) || (record.pid as number) < 1 || typeof record.nonce !== 'string' || !/^[0-9a-f-]{36}$/u.test(record.nonce)) invalidStore()
    if (!await processDefinitelyDead(record.pid as number)) throw new BridgeContractError('STORE_INVALID')
    const confirmedInfo = await lstat(lockPath).catch(() => invalidStore())
    const confirmedText = await readFile(lockPath, 'utf8').catch(() => invalidStore())
    if (confirmedInfo.dev !== info!.dev || confirmedInfo.ino !== info!.ino || confirmedText !== text) invalidStore()
    await unlink(lockPath).catch(() => invalidStore())
  }

  async verifyPublishedSource(scope: BridgeScope, snapshot: BridgePublishedSnapshot): Promise<void> {
    const current = await this.current(scope)
    if (!current || current.generation !== snapshot.generation || current.manifestHash !== snapshot.manifestHash) throw new BridgeContractError('STALE_GENERATION')
    await this.assertCurrentSource(scope, current)
  }

  async assertSnapshotSize(paths: BridgeSnapshotPaths): Promise<number> {
    let total = 0
    const visit = async (directory: string): Promise<void> => {
      let entries
      try { entries = await readdir(directory) } catch { invalidStore() }
      for (const name of entries!) {
        const path = join(directory, name)
        let info
        try { info = await lstat(path) } catch { invalidStore() }
        if (info!.isSymbolicLink()) invalidStore()
        if (info!.isDirectory()) await visit(path)
        else if (info!.isFile()) {
          total += info!.size
          if (total > BRIDGE_MAX_SNAPSHOT_BYTES) throw new BridgeContractError('TOTAL_TOO_LARGE')
        } else invalidStore()
      }
    }
    await visit(paths.sourcePath)
    return total
  }

  private async assertCurrentSource(scope: BridgeScope, current: BridgePublishedSnapshot | null): Promise<void> {
    const sourcePath = join(this.workspacePath(scope), 'source')
    if (!current) {
      if ((await readdir(sourcePath)).length !== 0) throw new BridgeContractError('WORKSPACE_CHANGED')
      return
    }
    await this.assertTreeMatches(sourcePath, current.manifest)
  }

  private async assertTreeMatches(root: string, manifest: BridgeManifest): Promise<void> {
    const found = new Map<string, { bytes: number; hash: string }>()
    const walk = async (directory: string, prefix: string): Promise<void> => {
      for (const name of await readdir(directory)) {
        const path = join(directory, name)
        const relativePath = prefix ? `${prefix}/${name}` : name
        const info = await lstat(path).catch(() => invalidStore())
        if (info!.isSymbolicLink()) invalidStore()
        if (info!.isDirectory()) await walk(path, relativePath)
        else if (info!.isFile()) {
          const bytes = await readFile(path).catch(() => invalidStore())
          found.set(relativePath, { bytes: bytes!.byteLength, hash: fileHash(bytes!) })
        } else invalidStore()
      }
    }
    await walk(root, '')
    if (found.size !== manifest.files.length) throw new BridgeContractError('WORKSPACE_CHANGED')
    for (const file of manifest.files) {
      const actual = found.get(file.path)
      if (!actual || actual.bytes !== file.bytes || actual.hash !== file.sha256) throw new BridgeContractError('WORKSPACE_CHANGED')
    }
  }

  private async recoverSync(paths: BridgeSnapshotPaths, journal: unknown, published: boolean): Promise<void> {
    const safeNames = (value: unknown): value is string[] => Array.isArray(value) && value.every((name) => typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') && !name.includes('\0') && resolve(join(paths.sourcePath, name)) === join(paths.sourcePath, name)) && new Set(value).size === value.length
    if (!plainObject(journal) || !safeNames(journal.oldTop) || !safeNames(journal.newTop)) invalidStore()
    const oldTop = journal.oldTop as string[]
    const newTop = journal.newTop as string[]
    if (published) {
      for (const name of newTop) {
        const source = join(paths.sourcePath, name)
        const staged = join(paths.stagingPath, name)
        if (!await pathExists(source) && await pathExists(staged)) await rename(staged, source)
      }
      for (const name of oldTop) if (!newTop.includes(name)) await rm(join(paths.sourcePath, name), { recursive: true, force: true })
    } else {
      for (const name of newTop) {
        if (oldTop.includes(name)) continue
        await rm(join(paths.sourcePath, name), { recursive: true, force: true })
      }
      for (const name of oldTop) {
        const backup = join(paths.backupPath, name)
        if (await pathExists(backup)) {
          await rm(join(paths.sourcePath, name), { recursive: true, force: true })
          await rename(backup, join(paths.sourcePath, name))
        }
      }
    }
  }

  private async recoverWorkspaceSync(scope: BridgeScope): Promise<void> {
    const syncRoot = this.snapshotsPath(scope)
    const workspacePath = this.workspacePath(scope)
    if (!await pathExists(join(workspacePath, 'source'))) await ensureDirectory(join(workspacePath, 'source'))
    if (!await pathExists(join(workspacePath, 'data'))) await ensureDirectory(join(workspacePath, 'data'))
    const current = await this.current(scope)
    for (const operationId of await readdir(syncRoot).catch(() => invalidStore())) {
      assertUuid(operationId)
      const pendingPath = join(syncRoot, operationId)
      const marker = await readJson(join(pendingPath, '.bridge-sync.json'))
      if (!exactMarker(marker, { schemaVersion: STORE_SCHEMA_VERSION, operationId, clientId: scope.clientInstanceId, workspaceId: scope.workspaceId })) invalidStore()
      const paths: BridgeSnapshotPaths = {
        pendingPath,
        workspacePath: this.workspacePath(scope),
        stagingPath: join(pendingPath, 'staging'),
        backupPath: join(pendingPath, 'backup'),
        journalPath: join(pendingPath, 'journal.json'),
        sourcePath: join(this.workspacePath(scope), 'source'),
        dataPath: join(this.workspacePath(scope), 'data'),
      }
      if (await pathExists(paths.journalPath)) {
        const journal = await readJson(paths.journalPath)
        if (!plainObject(journal) || journal.operationId !== operationId || journal.clientId !== scope.clientInstanceId || journal.workspaceId !== scope.workspaceId) invalidStore()
        const published = current !== null && (current.generation > Number(journal.generation) || current.generation === journal.generation && current.manifestHash === journal.manifestHash)
        await this.recoverSync(paths, journal, published)
      }
      await rm(pendingPath, { recursive: true, force: false }).catch(() => invalidStore())
    }
    await this.assertCurrentSource(scope, current)
  }

  async abortSnapshot(scope: BridgeScope, paths: BridgeSnapshotPaths): Promise<void> {
    const resolved = resolve(paths.pendingPath)
    if (!isWithin(this.snapshotsPath(scope), resolved) || resolved === this.snapshotsPath(scope)) invalidStore()
    const marker = await readJson(join(resolved, '.bridge-sync.json'))
    if (!plainObject(marker) || marker.schemaVersion !== STORE_SCHEMA_VERSION || typeof marker.operationId !== 'string' || marker.clientId !== scope.clientInstanceId || marker.workspaceId !== scope.workspaceId || resolved !== join(this.snapshotsPath(scope), marker.operationId)) invalidStore()
    await rm(resolved, { recursive: true, force: false }).catch(() => invalidStore())
  }

  async removeTransfer(scope: BridgeScope, operationId: string): Promise<void> {
    const path = join(this.uploadsPath(scope), operationId)
    const marker = await readJson(join(path, '.bridge-upload.json'))
    if (!exactMarker(marker, { schemaVersion: STORE_SCHEMA_VERSION, operationId, clientId: scope.clientInstanceId, workspaceId: scope.workspaceId })) invalidStore()
    await rm(path, { recursive: true, force: false }).catch(() => invalidStore())
    await this.collectBlobs(scope)
  }

  async cancelPendingTransfer(
    scope: BridgeScope,
    operationId: string,
    baseGeneration: number,
    expectedManifestHash: string,
  ): Promise<'cancelled' | 'published'> {
    assertUuid(operationId)
    if (!Number.isSafeInteger(baseGeneration) || baseGeneration < 0 || !/^[0-9a-f]{64}$/u.test(expectedManifestHash)) throw new BridgeContractError('INVALID_REQUEST')
    const uploadPath = join(this.uploadsPath(scope), operationId)
    if (!await pathExists(uploadPath)) {
      const current = await this.current(scope)
      if (current && current.generation > baseGeneration && current.manifestHash === expectedManifestHash) return 'published'
      throw new BridgeContractError('OPERATION_NOT_FOUND')
    }
    const transfer = parseTransfer(await readJson(join(uploadPath, 'transfer.json')), this.documentsFor(scope.clientInstanceId))
    if (
      transfer.operationId !== operationId ||
      transfer.baseGeneration !== baseGeneration ||
      transfer.manifest.manifestHash !== expectedManifestHash ||
      transfer.scope.clientInstanceId !== scope.clientInstanceId ||
      transfer.scope.workspaceId !== scope.workspaceId
    ) throw new BridgeContractError('SCOPE_MISMATCH')
    if (transfer.scope.conversationId !== scope.conversationId) throw new BridgeContractError('OPERATION_NOT_FOUND')
    const current = await this.current(scope)
    if (current && current.generation > baseGeneration && current.manifestHash === expectedManifestHash) {
      await this.removeTransfer(scope, operationId)
      return 'published'
    }
    await this.removeTransfer(scope, operationId)
    return 'cancelled'
  }

  private async collectBlobs(scope: BridgeScope): Promise<void> {
    const referenced = new Set<string>()
    const current = await this.current(scope)
    for (const file of current?.manifest.files ?? []) referenced.add(file.sha256)
    const uploads = this.uploadsPath(scope)
    for (const operationId of await readdir(uploads).catch(() => invalidStore())) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId)) invalidStore()
      const transfer = parseTransfer(await readJson(join(uploads, operationId, 'transfer.json')), this.documentsFor(scope.clientInstanceId))
      for (const file of transfer.manifest.files) referenced.add(file.sha256)
    }
    const blobs = this.blobsPath(scope)
    for (const hash of await readdir(blobs).catch(() => invalidStore())) {
      if (!/^[0-9a-f]{64}$/u.test(hash)) invalidStore()
      const path = join(blobs, hash)
      const info = await assertRegularFile(path)
      if (!referenced.has(hash)) {
        await unlink(path).catch(() => invalidStore())
      } else {
        const bytes = await readFile(path).catch(() => invalidStore())
        if (info.size > BRIDGE_MAX_TOTAL_BYTES || fileHash(bytes!) !== hash) invalidStore()
      }
    }
  }

  private async recoverIncomplete(): Promise<void> {
    let clients: string[]
    try { clients = await readdir(this.clientsRoot) } catch { invalidStore() }
    for (const clientId of clients!) {
      if (!/^[0-9a-f-]{36}$/u.test(clientId)) invalidStore()
      const clientPath = this.clientPath(clientId)
      await this.ensureOwnedDirectory(clientPath, '.bridge-client.json', { schemaVersion: STORE_SCHEMA_VERSION, clientId })
      for (const workspaceId of await readdir(clientPath)) {
        if (workspaceId === '.bridge-client.json') continue
        if (!/^[0-9a-f]{64}$/u.test(workspaceId)) invalidStore()
        const scope: BridgeScope = { clientInstanceId: clientId, workspaceId, conversationId: '00000000-0000-4000-8000-000000000000' }
        await this.ensureOwnedDirectory(this.workspacePath(scope), '.bridge-workspace.json', { schemaVersion: STORE_SCHEMA_VERSION, clientId, workspaceId })
        const uploads = this.uploadsPath(scope)
        await ensureDirectory(uploads)
        for (const operationId of await readdir(uploads)) {
          assertUuid(operationId)
          const uploadPath = join(uploads, operationId)
          const marker = await readJson(join(uploadPath, '.bridge-upload.json'))
          if (!exactMarker(marker, { schemaVersion: STORE_SCHEMA_VERSION, operationId, clientId, workspaceId })) invalidStore()
          await rm(uploadPath, { recursive: true, force: false }).catch(() => invalidStore())
        }
        const syncRoot = this.snapshotsPath(scope)
        await ensureDirectory(syncRoot)
        const current = await this.current(scope)
        for (const operationId of await readdir(syncRoot)) {
          assertUuid(operationId)
          const pendingPath = join(syncRoot, operationId)
          const marker = await readJson(join(pendingPath, '.bridge-sync.json'))
          if (!exactMarker(marker, { schemaVersion: STORE_SCHEMA_VERSION, operationId, clientId, workspaceId })) invalidStore()
          const paths: BridgeSnapshotPaths = {
            pendingPath,
            workspacePath: this.workspacePath(scope),
            stagingPath: join(pendingPath, 'staging'),
            backupPath: join(pendingPath, 'backup'),
            journalPath: join(pendingPath, 'journal.json'),
            sourcePath: join(this.workspacePath(scope), 'source'),
            dataPath: join(this.workspacePath(scope), 'data'),
          }
          const journalExists = await pathExists(paths.journalPath)
          if (journalExists) {
            const journal = await readJson(paths.journalPath)
            if (!plainObject(journal) || journal.operationId !== operationId || journal.clientId !== clientId || journal.workspaceId !== workspaceId) invalidStore()
            const isPublished = current !== null && (current.generation > Number(journal.generation) || current.generation === journal.generation && current.manifestHash === journal.manifestHash)
            await this.recoverSync(paths, journal, isPublished)
          }
          await rm(pendingPath, { recursive: true, force: false }).catch(() => invalidStore())
        }
        const workspacePath = this.workspacePath(scope)
        if (current) {
          await assertDirectoryExists(join(workspacePath, 'source'))
          await assertDirectoryExists(join(workspacePath, 'data'))
          await this.assertCurrentSource(scope, current)
        } else if (await pathExists(join(workspacePath, 'source'))) {
          if ((await readdir(join(workspacePath, 'source'))).length !== 0) throw new BridgeContractError('WORKSPACE_CHANGED')
        }
        await this.collectBlobs(scope)
      }
    }
    const counts = await this.countWorkspaces()
    if (counts.total > 32) throw new BridgeContractError('WORKSPACE_LIMIT_EXCEEDED')
    for (const clientId of clients!) {
      const count = await this.countWorkspaces(clientId)
      if (count.forClient > 8) throw new BridgeContractError('WORKSPACE_LIMIT_EXCEEDED')
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    let info
    let marker: unknown
    try {
      info = await lstat(this.lock.path)
      marker = JSON.parse(await readFile(this.lock.path, 'utf8')) as unknown
    } catch { throw new BridgeContractError('STORE_INVALID') }
    if (info!.dev !== this.lock.identity.dev || info!.ino !== this.lock.identity.ino || !plainObject(marker) || marker.nonce !== this.lock.nonce) throw new BridgeContractError('STORE_INVALID')
    await unlink(this.lock.path).catch(() => { throw new BridgeContractError('STORE_INVALID') })
  }
}

async function lockOwned(path: string, nonce: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    return plainObject(parsed) && parsed.nonce === nonce
  } catch { return false }
}

async function processDefinitelyDead(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

async function removeDeadBridgeLock(path: string): Promise<boolean> {
  let info
  let text: string
  try {
    info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4_096) return false
    text = await readFile(path, 'utf8')
  } catch { return false }
  let value: unknown
  try { value = JSON.parse(text) as unknown } catch { return false }
  if (!plainObject(value) || value.schemaVersion !== STORE_SCHEMA_VERSION || !Number.isSafeInteger(value.pid) || (value.pid as number) < 1 || typeof value.nonce !== 'string' || !/^[0-9a-f-]{36}$/u.test(value.nonce)) return false
  if (!await processDefinitelyDead(value.pid as number)) return false
  let confirmedInfo
  let confirmedText: string
  try {
    confirmedInfo = await lstat(path)
    confirmedText = await readFile(path, 'utf8')
  } catch { return false }
  if (confirmedInfo.dev !== info.dev || confirmedInfo.ino !== info.ino || confirmedText !== text) return false
  try { await unlink(path); return true } catch { return false }
}

function parseTransfer(input: unknown, allowedDocumentPaths: readonly string[]): BridgeTransfer {
  if (!plainObject(input) || typeof input.operationId !== 'string' || !/^[0-9a-f-]{36}$/u.test(input.operationId) || !plainObject(input.scope) || !Number.isSafeInteger(input.baseGeneration) || (input.baseGeneration as number) < 0 || typeof input.createdAt !== 'string' || !plainObject(input.chunks)) invalidStore()
  const manifest = parseBridgeManifest(input.manifest, { allowedDocumentPaths })
  const chunks: Record<string, readonly { offset: number; length: number; sha256: string }[]> = {}
  for (const [hash, items] of Object.entries(input.chunks)) {
    if (!/^[0-9a-f]{64}$/u.test(hash) || !Array.isArray(items)) invalidStore()
    chunks[hash] = Object.freeze(items.map((item) => {
      if (!plainObject(item) || !Number.isSafeInteger(item.offset) || !Number.isSafeInteger(item.length) || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(item.sha256)) invalidStore()
      return Object.freeze({ offset: item.offset as number, length: item.length as number, sha256: item.sha256 })
    }))
  }
  const scope = BridgeScopeSchema.safeParse(input.scope)
  if (!scope.success) invalidStore()
  return Object.freeze({
    operationId: input.operationId,
    scope: Object.freeze(scope.data),
    baseGeneration: input.baseGeneration as number,
    manifest,
    createdAt: input.createdAt,
    chunks: Object.freeze(chunks),
  })
}

function historicalDocumentPaths(input: unknown): string[] {
  if (!plainObject(input) || !Array.isArray(input.files)) return []
  return input.files.flatMap((entry) =>
    plainObject(entry) && typeof entry.path === 'string' && /\.(?:md|mdx|mdc)$/iu.test(entry.path)
      ? [entry.path]
      : [],
  )
}

function parseSnapshot(input: unknown): BridgePublishedSnapshot {
  if (
    !plainObject(input) || input.schemaVersion !== STORE_SCHEMA_VERSION ||
    !Number.isSafeInteger(input.generation) || (input.generation as number) < 1 ||
    typeof input.manifestHash !== 'string' || !/^[0-9a-f]{64}$/u.test(input.manifestHash) ||
    typeof input.runtimeFingerprint !== 'string' || !/^[0-9a-f]{64}$/u.test(input.runtimeFingerprint) ||
    typeof input.createdAt !== 'string'
  ) invalidStore()
  // Published manifests outlive the client policy that authorized them. Validate
  // their document paths structurally; active authorization is enforced on calls.
  const manifest = parseBridgeManifest(input.manifest, { allowedDocumentPaths: historicalDocumentPaths(input.manifest) })
  if (manifest.manifestHash !== input.manifestHash) invalidStore()
  return Object.freeze({
    schemaVersion: STORE_SCHEMA_VERSION,
    generation: input.generation as number,
    manifestHash: input.manifestHash,
    runtimeFingerprint: input.runtimeFingerprint,
    createdAt: input.createdAt,
    manifest,
  })
}
