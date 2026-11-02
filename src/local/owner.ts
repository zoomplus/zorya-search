import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { workspaceIdForCanonicalPath } from '../bridge/protocol.js'
import { canonicalFuturePath, isSameOrDescendantPath } from '../runtime/path.js'
import { openSearchRuntime, type RuntimeOptions } from '../runtime/index.js'
import { LocalConfigError, localConfigFingerprint, parseLocalConfig, type ParsedLocalConfig } from './config.js'

const ownerDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  pid: z.number().int().positive(),
  nonce: z.string().uuid(),
  clientId: z.string().uuid(),
  workspaceId: z.string().regex(/^[0-9a-f]{64}$/u),
  profileFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  canonicalPath: z.string().min(1).max(4_096),
  statePath: z.string().min(1).max(4_096),
  dataPath: z.string().min(1).max(4_096),
  startedAt: z.string().datetime(),
  databaseLock: z.object({
    dev: z.number().int().nonnegative(),
    ino: z.number().int().nonnegative(),
    nonce: z.string().uuid(),
  }).strict().optional(),
  service: z.object({
    port: z.number().int().min(1).max(65_535),
    token: z.string().min(43).max(256),
    packageVersion: z.string().min(1).max(64),
  }).strict().optional(),
}).strict()
type OwnerDescriptor = z.infer<typeof ownerDescriptorSchema>
export type LocalOwnerService = NonNullable<OwnerDescriptor['service']>

const recoveryDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  nonce: z.string().uuid(),
  pid: z.number().int().positive(),
  targetOwnerNonce: z.string().uuid(),
  clientId: z.string().uuid(),
  workspaceId: z.string().regex(/^[0-9a-f]{64}$/u),
  canonicalPath: z.string().min(1).max(4_096),
  statePath: z.string().min(1).max(4_096),
  dataPath: z.string().min(1).max(4_096),
  staleOwner: z.object({
    pid: z.number().int().positive(), nonce: z.string().uuid(), dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative(),
    databaseLock: ownerDescriptorSchema.shape.databaseLock.optional(),
  }).strict(),
}).strict()
type RecoveryDescriptor = z.infer<typeof recoveryDescriptorSchema>

export class LocalWorkspaceError extends Error {
  constructor(readonly code:
    | 'LOCAL_CONFIG_INVALID'
    | 'LOCAL_WORKSPACE_UNRESOLVED'
    | 'LOCAL_WORKSPACE_CHANGED'
    | 'LOCAL_STATE_INVALID'
    | 'LOCAL_WORKSPACE_BUSY'
    | 'LOCAL_PROFILE_MISMATCH'
    | 'LOCAL_RUNTIME_START_FAILED'
    | 'LOCAL_RUNTIME_CLOSE_FAILED'
  ) {
    super(`Local workspace error: ${code}`)
    this.name = 'LocalWorkspaceError'
  }
}

export interface LocalWorkspaceOptions {
  config: unknown
  configDir?: string
  runtimeOptions?: Omit<RuntimeOptions, 'config' | 'configDir' | 'signal' | 'backgroundWatchStartup'>
  /** Internal failure-injection seam; never read from client configuration or transport input. */
  testRuntimeFactory?: (options: RuntimeOptions) => Promise<Awaited<ReturnType<typeof openSearchRuntime>>>
}

export interface LocalWorkspace {
  readonly clientId: string
  readonly workspaceId: string
  readonly canonicalPath: string
  readonly statePath: string
  readonly dataPath: string
  readonly runtime: Awaited<ReturnType<typeof openSearchRuntime>>
  publishService(service: LocalOwnerService): Promise<void>
  assertCurrent(): Promise<void>
  close(): Promise<void>
}

interface AcquiredLease {
  readonly path: string
  readonly recoveryPath: string
  readonly identity: Pick<OwnerDescriptor, 'clientId' | 'workspaceId' | 'profileFingerprint' | 'canonicalPath' | 'statePath' | 'dataPath'>
  readonly nonce: string
  readonly dev: number
  readonly ino: number
  updateDatabaseLock(): Promise<void>
  updateService(service: LocalOwnerService): Promise<void>
  release(): Promise<void>
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    return true
  }
}

const retainedStartupCleanup = new Map<string, {
  runtime: Awaited<ReturnType<typeof openSearchRuntime>>
  lease: AcquiredLease
}>()

async function secureDirectory(path: string): Promise<string> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error()
    if (process.platform !== 'win32') {
      if ((info.mode & 0o077) !== 0) throw new Error()
      if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error()
      await chmod(path, 0o700)
    }
    return await realpath(path)
  } catch { throw new LocalWorkspaceError('LOCAL_STATE_INVALID') }
}

async function readBoundedJson(path: string, maxBytes = 8_192): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const info = await handle.stat()
    if (!info.isFile() || info.size < 1 || info.size > maxBytes || process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      throw new Error()
    const bytes = await handle.readFile()
    if (bytes.byteLength > maxBytes) throw new Error()
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch { throw new LocalWorkspaceError('LOCAL_STATE_INVALID') }
  finally { await handle?.close().catch(() => undefined) }
}

async function unlinkExact(path: string, dev: number, ino: number): Promise<void> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.dev !== dev || info.ino !== ino) throw new Error()
    await unlink(path)
  } catch { throw new LocalWorkspaceError('LOCAL_STATE_INVALID') }
}

async function recoverDatabaseLock(stale: OwnerDescriptor): Promise<void> {
  const path = join(stale.dataPath, '.zorya-search-owner')
  let info
  try { info = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
  }
  if (!info.isFile() || info.isSymbolicLink() || !stale.databaseLock || info.dev !== stale.databaseLock.dev || info.ino !== stale.databaseLock.ino)
    throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
  const lock = await readBoundedJson(path)
  if (!lock || typeof lock !== 'object' || (lock as { pid?: unknown }).pid !== stale.pid || (lock as { nonce?: unknown }).nonce !== stale.databaseLock.nonce)
    throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
  const current = await lstat(path)
  if (current.dev !== info.dev || current.ino !== info.ino || processIsAlive(stale.pid))
    throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
  await unlinkExact(path, info.dev, info.ino)
}

function recoveryIdentityMatches(record: RecoveryDescriptor, identity: AcquiredLease['identity']): boolean {
  return record.clientId === identity.clientId && record.workspaceId === identity.workspaceId &&
    record.canonicalPath === identity.canonicalPath && record.statePath === identity.statePath && record.dataPath === identity.dataPath
}

async function recoverRecordedDatabaseLock(record: RecoveryDescriptor): Promise<void> {
  const stale: OwnerDescriptor = {
    schemaVersion: 1,
    pid: record.staleOwner.pid,
    nonce: record.staleOwner.nonce,
    clientId: record.clientId,
    workspaceId: record.workspaceId,
    profileFingerprint: '0'.repeat(64),
    canonicalPath: record.canonicalPath,
    statePath: record.statePath,
    dataPath: record.dataPath,
    startedAt: new Date(0).toISOString(),
    ...(record.staleOwner.databaseLock ? { databaseLock: record.staleOwner.databaseLock } : {}),
  }
  await recoverDatabaseLock(stale)
}

/** Remove only a fully validated dead recovery claim left by an earlier owner attempt. */
async function reclaimDeadRecoveryClaim(
  recoveryPath: string,
  ownerPath: string,
  identity: AcquiredLease['identity'],
): Promise<void> {
  let info
  try { info = await lstat(recoveryPath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
  let record: RecoveryDescriptor
  try { record = recoveryDescriptorSchema.parse(await readBoundedJson(recoveryPath)) }
  catch { throw new LocalWorkspaceError('LOCAL_STATE_INVALID') }
  if (!recoveryIdentityMatches(record, identity) || processIsAlive(record.pid)) throw new LocalWorkspaceError('LOCAL_WORKSPACE_BUSY')
  const confirmInfo = await lstat(recoveryPath).catch(() => undefined)
  let confirm: RecoveryDescriptor
  try { confirm = recoveryDescriptorSchema.parse(await readBoundedJson(recoveryPath)) }
  catch { throw new LocalWorkspaceError('LOCAL_WORKSPACE_BUSY') }
  if (!confirmInfo || confirmInfo.dev !== info.dev || confirmInfo.ino !== info.ino || confirm.nonce !== record.nonce ||
    confirm.pid !== record.pid || confirm.targetOwnerNonce !== record.targetOwnerNonce || processIsAlive(record.pid))
    throw new LocalWorkspaceError('LOCAL_WORKSPACE_BUSY')

  let ownerInfo
  try { ownerInfo = await lstat(ownerPath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
  }
  if (ownerInfo) {
    let owner: OwnerDescriptor
    try { owner = ownerDescriptorSchema.parse(await readBoundedJson(ownerPath)) }
    catch { throw new LocalWorkspaceError('LOCAL_STATE_INVALID') }
    const matchesOld = ownerInfo.dev === record.staleOwner.dev && ownerInfo.ino === record.staleOwner.ino &&
      owner.nonce === record.staleOwner.nonce && owner.pid === record.staleOwner.pid
    const matchesRecoveryTarget = owner.nonce === record.targetOwnerNonce && owner.pid === record.pid
    const exactIdentity = owner.clientId === record.clientId && owner.workspaceId === record.workspaceId &&
      owner.canonicalPath === record.canonicalPath && owner.statePath === record.statePath && owner.dataPath === record.dataPath
    if ((!matchesOld && !matchesRecoveryTarget) || !exactIdentity || processIsAlive(owner.pid))
      throw new LocalWorkspaceError('LOCAL_WORKSPACE_BUSY')
    await recoverDatabaseLock(owner)
    await unlinkExact(ownerPath, ownerInfo.dev, ownerInfo.ino)
  } else {
    await recoverRecordedDatabaseLock(record)
  }

  const finalInfo = await lstat(recoveryPath).catch(() => undefined)
  let finalRecord: RecoveryDescriptor
  try { finalRecord = recoveryDescriptorSchema.parse(await readBoundedJson(recoveryPath)) }
  catch { throw new LocalWorkspaceError('LOCAL_WORKSPACE_BUSY') }
  if (!finalInfo || finalInfo.dev !== info.dev || finalInfo.ino !== info.ino || finalRecord.nonce !== record.nonce ||
    finalRecord.pid !== record.pid || processIsAlive(record.pid))
    throw new LocalWorkspaceError('LOCAL_WORKSPACE_BUSY')
  await unlinkExact(recoveryPath, info.dev, info.ino)
}

async function acquireLease(
  statePath: string,
  dataPath: string,
  identity: AcquiredLease['identity'],
): Promise<AcquiredLease> {
  const path = join(statePath, 'owner.json')
  const recoveryPath = join(statePath, 'recovery.json')
  await reclaimDeadRecoveryClaim(recoveryPath, path, identity)
  const createOwner = async (recoveryClaim?: { nonce: string; targetOwnerNonce: string; dev: number; ino: number }) => {
    if (await exists(recoveryPath)) {
      if (!recoveryClaim) throw new LocalWorkspaceError('LOCAL_WORKSPACE_BUSY')
      const recoveryInfo = await lstat(recoveryPath)
      const recovery = recoveryDescriptorSchema.parse(await readBoundedJson(recoveryPath))
      if (recoveryInfo.dev !== recoveryClaim.dev || recoveryInfo.ino !== recoveryClaim.ino || recovery.nonce !== recoveryClaim.nonce ||
        recovery.targetOwnerNonce !== recoveryClaim.targetOwnerNonce || recovery.pid !== process.pid || !recoveryIdentityMatches(recovery, identity))
        throw new LocalWorkspaceError('LOCAL_WORKSPACE_BUSY')
    } else if (recoveryClaim) throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
    const nonce = recoveryClaim?.targetOwnerNonce ?? randomUUID()
    const descriptor: OwnerDescriptor = {
      schemaVersion: 1,
      pid: process.pid,
      nonce,
      ...identity,
      startedAt: new Date().toISOString(),
    }
    let handle: Awaited<ReturnType<typeof open>>
    try { handle = await open(path, 'wx', 0o600) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new LocalWorkspaceError('LOCAL_WORKSPACE_BUSY')
      throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
    }
    const info = await handle.stat()
    try {
      await handle.writeFile(JSON.stringify(descriptor))
      await handle.sync()
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlinkExact(path, info.dev, info.ino).catch(() => undefined)
      throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
    }
    await handle.close()
    if (await exists(recoveryPath)) {
      if (!recoveryClaim) {
        await unlinkExact(path, info.dev, info.ino)
        throw new LocalWorkspaceError('LOCAL_WORKSPACE_BUSY')
      }
      const recoveryInfo = await lstat(recoveryPath)
      const recovery = recoveryDescriptorSchema.parse(await readBoundedJson(recoveryPath))
      if (recoveryInfo.dev !== recoveryClaim.dev || recoveryInfo.ino !== recoveryClaim.ino || recovery.nonce !== recoveryClaim.nonce ||
        recovery.targetOwnerNonce !== recoveryClaim.targetOwnerNonce || recovery.pid !== process.pid || !recoveryIdentityMatches(recovery, identity)) {
        await unlinkExact(path, info.dev, info.ino)
        throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
      }
    }
    let released = false
    const updateDescriptor = async (next: OwnerDescriptor) => {
      const current = await lstat(path)
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino)
        throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
      const handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
        const existingBytes = await handle.readFile()
        const existing = ownerDescriptorSchema.parse(JSON.parse(existingBytes.toString('utf8')))
        if (existing.nonce !== nonce || existing.pid !== process.pid || existing.clientId !== identity.clientId || existing.workspaceId !== identity.workspaceId || existing.profileFingerprint !== identity.profileFingerprint || existing.canonicalPath !== identity.canonicalPath)
          throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
        const pathAgain = await lstat(path)
        if (pathAgain.dev !== info.dev || pathAgain.ino !== info.ino) throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
        await handle.truncate(0)
        const bytes = Buffer.from(JSON.stringify(next))
        await handle.write(bytes, 0, bytes.length, 0)
        await handle.sync()
      } finally { await handle.close() }
    }
    return {
      path, recoveryPath, identity, nonce, dev: info.dev, ino: info.ino,
      async updateDatabaseLock() {
        const lockPath = join(dataPath, '.zorya-search-owner')
        let lockInfo
        try { lockInfo = await lstat(lockPath) } catch { throw new LocalWorkspaceError('LOCAL_STATE_INVALID') }
        if (!lockInfo.isFile() || lockInfo.isSymbolicLink()) throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
        const lock = await readBoundedJson(lockPath)
        if (!lock || typeof lock !== 'object' || (lock as { pid?: unknown }).pid !== process.pid || typeof (lock as { nonce?: unknown }).nonce !== 'string' || !z.string().uuid().safeParse((lock as { nonce: unknown }).nonce).success)
          throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
        const currentDescriptor = ownerDescriptorSchema.parse(await readBoundedJson(path))
        await updateDescriptor({ ...currentDescriptor, databaseLock: { dev: lockInfo.dev, ino: lockInfo.ino, nonce: (lock as { nonce: string }).nonce } })
      },
      async updateService(service: LocalOwnerService) {
        const validated = ownerDescriptorSchema.shape.service.parse(service)
        const currentDescriptor = ownerDescriptorSchema.parse(await readBoundedJson(path))
        await updateDescriptor({ ...currentDescriptor, service: validated })
      },
      async release() {
        if (released) return
        const currentInfo = await lstat(path).catch(() => undefined)
        if (!currentInfo || currentInfo.dev !== info.dev || currentInfo.ino !== info.ino) throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
        const current = ownerDescriptorSchema.parse(await readBoundedJson(path))
        if (current.nonce !== nonce || current.pid !== process.pid || current.workspaceId !== identity.workspaceId)
          throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
        await unlinkExact(path, info.dev, info.ino)
        released = true
      },
    }
  }

  try { return await createOwner() } catch (error) {
    if (!(error instanceof LocalWorkspaceError) || error.code !== 'LOCAL_WORKSPACE_BUSY' || !(await exists(path))) throw error
  }

  // A separate exclusive recovery claim serializes stale lease cleanup. If any
  // part of the descriptor/DB-lock proof is missing, leave both locks intact.
  let observedInfo
  let observed: OwnerDescriptor
  try {
    observedInfo = await lstat(path)
    observed = ownerDescriptorSchema.parse(await readBoundedJson(path))
    const confirmInfo = await lstat(path)
    const confirm = ownerDescriptorSchema.parse(await readBoundedJson(path))
    if (!observedInfo.isFile() || observedInfo.isSymbolicLink() || confirmInfo.dev !== observedInfo.dev || confirmInfo.ino !== observedInfo.ino || confirm.nonce !== observed.nonce || processIsAlive(observed.pid))
      throw new LocalWorkspaceError('LOCAL_WORKSPACE_BUSY')
  } catch (error) {
    if (error instanceof LocalWorkspaceError) throw error
    throw new LocalWorkspaceError('LOCAL_WORKSPACE_BUSY')
  }
  if (observed.clientId !== identity.clientId || observed.workspaceId !== identity.workspaceId || observed.canonicalPath !== identity.canonicalPath || observed.statePath !== identity.statePath || observed.dataPath !== identity.dataPath)
    throw new LocalWorkspaceError('LOCAL_WORKSPACE_BUSY')
  const recoveryNonce = randomUUID()
  let recoveryHandle: Awaited<ReturnType<typeof open>>
  try { recoveryHandle = await open(recoveryPath, 'wx', 0o600) } catch { throw new LocalWorkspaceError('LOCAL_WORKSPACE_BUSY') }
  const recoveryInfo = await recoveryHandle.stat()
    const targetOwnerNonce = randomUUID()
    const recoveryRecord: RecoveryDescriptor = {
      schemaVersion: 1, nonce: recoveryNonce, pid: process.pid, targetOwnerNonce,
      clientId: identity.clientId, workspaceId: identity.workspaceId, canonicalPath: identity.canonicalPath,
      statePath: identity.statePath, dataPath: identity.dataPath,
      staleOwner: {
        pid: observed.pid, nonce: observed.nonce, dev: observedInfo.dev, ino: observedInfo.ino,
        ...(observed.databaseLock ? { databaseLock: observed.databaseLock } : {}),
      },
    }
    try { await recoveryHandle.writeFile(JSON.stringify(recoveryRecord)); await recoveryHandle.sync() } finally { await recoveryHandle.close() }
  try {
    const ownerInfo = await lstat(path)
    const stale = ownerDescriptorSchema.parse(await readBoundedJson(path))
    if (ownerInfo.isSymbolicLink() || !ownerInfo.isFile() || stale.clientId !== identity.clientId || stale.workspaceId !== identity.workspaceId || stale.canonicalPath !== identity.canonicalPath || stale.statePath !== identity.statePath || stale.dataPath !== identity.dataPath || processIsAlive(stale.pid))
      throw new LocalWorkspaceError('LOCAL_WORKSPACE_BUSY')
    const confirmInfo = await lstat(path)
    const confirm = ownerDescriptorSchema.parse(await readBoundedJson(path))
    if (confirmInfo.dev !== ownerInfo.dev || confirmInfo.ino !== ownerInfo.ino || confirm.nonce !== stale.nonce || processIsAlive(stale.pid))
      throw new LocalWorkspaceError('LOCAL_WORKSPACE_BUSY')
    await recoverDatabaseLock(stale)
    await unlinkExact(path, ownerInfo.dev, ownerInfo.ino)
    const lease = await createOwner({ nonce: recoveryNonce, targetOwnerNonce, dev: recoveryInfo.dev, ino: recoveryInfo.ino })
    const activeRecovery = recoveryDescriptorSchema.parse(await readBoundedJson(recoveryPath))
    const activeRecoveryInfo = await lstat(recoveryPath)
    if (activeRecovery.nonce !== recoveryNonce || activeRecovery.pid !== process.pid || activeRecoveryInfo.dev !== recoveryInfo.dev || activeRecoveryInfo.ino !== recoveryInfo.ino) {
      await lease.release().catch(() => undefined)
      throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
    }
    await unlinkExact(recoveryPath, recoveryInfo.dev, recoveryInfo.ino)
    return lease
  } catch (error) {
    await unlinkExact(recoveryPath, recoveryInfo.dev, recoveryInfo.ino).catch(() => undefined)
    if (error instanceof LocalWorkspaceError) throw error
    throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
  }
}

export async function canonicalCurrentWorkspace(): Promise<{ canonicalPath: string; dev: number; ino: number }> {
  let canonicalPath: string
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    canonicalPath = await realpath(resolve(process.cwd()))
    info = await lstat(canonicalPath)
  } catch { throw new LocalWorkspaceError('LOCAL_WORKSPACE_UNRESOLVED') }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new LocalWorkspaceError('LOCAL_WORKSPACE_UNRESOLVED')
  return { canonicalPath, dev: info.dev, ino: info.ino }
}

export function defaultLocalStateDirectory(): string {
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || homedir(), 'Zorya', 'Search', 'state')
  const stateHome = process.env.XDG_STATE_HOME
  if (stateHome && isAbsolute(stateHome)) return join(stateHome, 'zorya-search-local')
  return join(homedir(), '.local', 'state', 'zorya-search-local')
}

export type LocalOwnerLookup =
  | { readonly state: 'missing' }
  | { readonly state: 'starting'; readonly pid?: number }
  | { readonly state: 'ready'; readonly pid: number; readonly service: LocalOwnerService; readonly workspaceId: string; readonly canonicalPath: string }

/** Read only the private per-workspace owner descriptor; never reads runtime secrets. */
export async function inspectLocalOwner(config: unknown, configDir?: string, options: { allowProfileMismatch?: boolean } = {}): Promise<LocalOwnerLookup> {
  const header = config && typeof config === 'object' ? config as Record<string, unknown> : undefined
  const current = await canonicalCurrentWorkspace()
  let prevalidated: ParsedLocalConfig
  try {
    const stateRoot = header?.stateDir ?? defaultLocalStateDirectory()
    if (typeof stateRoot !== 'string' || !isAbsolute(stateRoot)) throw new Error()
    prevalidated = parseLocalConfig(config, current.canonicalPath, join(resolve(stateRoot), '.validation-data'))
  } catch { throw new LocalWorkspaceError('LOCAL_CONFIG_INVALID') }
  const clientId = prevalidated.clientId
  const stateRoot = prevalidated.stateDir
  let workspaceId: string
  try { workspaceId = workspaceIdForCanonicalPath(clientId, current.canonicalPath) } catch { throw new LocalWorkspaceError('LOCAL_CONFIG_INVALID') }
  try {
    const original = await lstat(stateRoot)
    if (original.isSymbolicLink() || !original.isDirectory()) throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
    if (error instanceof LocalWorkspaceError) throw error
    throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
  }
  const stateCanonical = await realpath(stateRoot).catch(() => { throw new LocalWorkspaceError('LOCAL_STATE_INVALID') })
  if (isSameOrDescendantPath(current.canonicalPath, stateCanonical) || isSameOrDescendantPath(stateCanonical, current.canonicalPath))
    throw new LocalWorkspaceError('LOCAL_CONFIG_INVALID')
  const statePath = join(stateCanonical, workspaceId)
  let profileFingerprint: string
  try {
    const expectedParsed = parseLocalConfig(config, current.canonicalPath, join(statePath, 'data'))
    profileFingerprint = localConfigFingerprint(expectedParsed, configDir ?? '')
  } catch { throw new LocalWorkspaceError('LOCAL_CONFIG_INVALID') }
  try {
    const info = await lstat(statePath)
    if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
    if (error instanceof LocalWorkspaceError) throw error
    throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
  }
  const ownerPath = join(statePath, 'owner.json')
  let descriptor: OwnerDescriptor
  try { descriptor = ownerDescriptorSchema.parse(await readBoundedJson(ownerPath)) } catch (error) {
    if (error instanceof LocalWorkspaceError && error.code === 'LOCAL_STATE_INVALID') {
      try {
        const partial = await lstat(ownerPath)
        if (partial.isFile() && !partial.isSymbolicLink() && (process.platform === 'win32' || (partial.mode & 0o077) === 0))
          return { state: 'starting' }
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
      }
    }
    throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
  }
  if (descriptor.clientId !== clientId || descriptor.workspaceId !== workspaceId || descriptor.canonicalPath !== current.canonicalPath || descriptor.statePath !== statePath || descriptor.dataPath !== join(statePath, 'data'))
    throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
  if (!processIsAlive(descriptor.pid)) return { state: 'missing' }
  if (descriptor.profileFingerprint !== profileFingerprint && !options.allowProfileMismatch)
    throw new LocalWorkspaceError('LOCAL_PROFILE_MISMATCH')
  if (!descriptor.service) return { state: 'starting', pid: descriptor.pid }
  return { state: 'ready', pid: descriptor.pid, service: descriptor.service, workspaceId, canonicalPath: current.canonicalPath }
}

export async function openLocalWorkspace(options: LocalWorkspaceOptions): Promise<LocalWorkspace> {
  const current = await canonicalCurrentWorkspace()
  let clientId: string
  try {
    const localHeader = options.config && typeof options.config === 'object' ? options.config as Record<string, unknown> : undefined
    clientId = typeof localHeader?.clientId === 'string' ? localHeader.clientId : ''
    const workspaceId = workspaceIdForCanonicalPath(clientId, current.canonicalPath)
    let stateRoot = options.config && typeof options.config === 'object' ? (options.config as Record<string, unknown>).stateDir : undefined
    if (stateRoot === undefined) stateRoot = defaultLocalStateDirectory()
    if (typeof stateRoot !== 'string' || !isAbsolute(stateRoot)) throw new Error()
    try {
      const rootInfo = await lstat(stateRoot)
      if (rootInfo.isSymbolicLink()) throw new Error()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const canonicalStateRoot = await canonicalFuturePath(stateRoot)
    if (isSameOrDescendantPath(current.canonicalPath, canonicalStateRoot) || isSameOrDescendantPath(canonicalStateRoot, current.canonicalPath)) throw new Error()
    const secureStateRoot = await secureDirectory(canonicalStateRoot)
    const statePath = await secureDirectory(join(secureStateRoot, workspaceId))
    if (retainedStartupCleanup.has(statePath)) throw new LocalWorkspaceError('LOCAL_RUNTIME_CLOSE_FAILED')
    const dataPath = join(statePath, 'data')
    if (isSameOrDescendantPath(current.canonicalPath, dataPath) || isSameOrDescendantPath(dataPath, current.canonicalPath)) throw new Error()
    let parsed: ParsedLocalConfig
    try { parsed = parseLocalConfig(options.config, current.canonicalPath, dataPath) }
    catch { throw new LocalWorkspaceError('LOCAL_CONFIG_INVALID') }
    const profileFingerprint = localConfigFingerprint(parsed, options.configDir ?? '')
    const identity = { clientId, workspaceId, profileFingerprint, canonicalPath: current.canonicalPath, statePath, dataPath }
    const lease = await acquireLease(statePath, dataPath, identity)
    try {
      if (parsed.clientId !== clientId || parsed.stateDir !== stateRoot) throw new LocalConfigError('LOCAL_CONFIG_INVALID')
    } catch (error) {
      await lease.release().catch(() => undefined)
      if (error instanceof LocalConfigError) throw new LocalWorkspaceError('LOCAL_CONFIG_INVALID')
      throw new LocalWorkspaceError('LOCAL_CONFIG_INVALID')
    }
    let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
    try {
      const runtimeOptions: RuntimeOptions = {
        ...(options.runtimeOptions ?? {}),
        config: parsed.runtimeConfig,
        ...(options.configDir ? { configDir: options.configDir } : {}),
        backgroundWatchStartup: false,
      }
      runtime = await (options.testRuntimeFactory ?? openSearchRuntime)(runtimeOptions)
      await lease.updateDatabaseLock()
    } catch {
      if (!runtime) {
        const databaseLockPath = join(dataPath, '.zorya-search-owner')
        if (await exists(databaseLockPath)) {
          // If startup left a lock, retain this lease only when its exact nonce
          // and inode can be recorded for a later dead-owner recovery.
          try { await lease.updateDatabaseLock() } catch { /* fail closed by retaining state */ }
        } else {
          await lease.release().catch(() => undefined)
        }
      } else {
        try {
          await runtime.close()
          await lease.release()
        } catch {
          // Keep both references alive and refuse same-process retries. The
          // database close/lease settlement was not proven, so never unlock.
          retainedStartupCleanup.set(statePath, { runtime, lease })
          throw new LocalWorkspaceError('LOCAL_RUNTIME_CLOSE_FAILED')
        }
      }
      throw new LocalWorkspaceError('LOCAL_RUNTIME_START_FAILED')
    }
    if (!runtime) throw new LocalWorkspaceError('LOCAL_RUNTIME_START_FAILED')
    let closePromise: Promise<void> | undefined
    return Object.freeze({
      clientId,
      workspaceId,
      canonicalPath: current.canonicalPath,
      statePath,
      dataPath,
      runtime,
      publishService: (service: LocalOwnerService) => lease.updateService(service),
      async assertCurrent() {
        let now
        try { now = await canonicalCurrentWorkspace() } catch { throw new LocalWorkspaceError('LOCAL_WORKSPACE_CHANGED') }
        if (now.canonicalPath !== current.canonicalPath || now.dev !== current.dev || now.ino !== current.ino || workspaceIdForCanonicalPath(clientId, now.canonicalPath) !== workspaceId)
          throw new LocalWorkspaceError('LOCAL_WORKSPACE_CHANGED')
      },
      close() {
        if (!closePromise) closePromise = (async () => {
          try {
            await runtime.close()
            await lease.release()
          } catch { throw new LocalWorkspaceError('LOCAL_RUNTIME_CLOSE_FAILED') }
        })()
        return closePromise
      },
    })
  } catch (error) {
    if (error instanceof LocalWorkspaceError) throw error
    if (error instanceof LocalConfigError) throw new LocalWorkspaceError('LOCAL_CONFIG_INVALID')
    throw new LocalWorkspaceError('LOCAL_CONFIG_INVALID')
  }
}
