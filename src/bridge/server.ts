import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createSearchIpAccessPolicy } from '../daemon/ip-access.js'
import { createCodePathPolicy } from '../code/enumerate.js'
import { parseBridgeServerConfig, type BridgeServerConfig } from './config.js'
import { BRIDGE_MAX_CONCURRENT_OPERATIONS, BRIDGE_MAX_RESPONSE_BYTES, BridgeContractError, parseBridgeRequest, type BridgeRequest, type BridgeScope, type BridgeResponse } from './protocol.js'
import { BridgeStore, type BridgePublishedSnapshot } from './store.js'
import { bridgeRuntimeFingerprint, callBridgeTool, hasActiveBridgeIndexJob, openBridgeWorkspaceRuntime } from './runtime.js'

const SOURCE_FREE_TOOLS = new Set([
  'capabilities', 'list_roots', 'index_status', 'project_text_status', 'cancel_indexing',
  'search_web', 'read_web_source', 'classify', 'search_visual_references',
])
const MAX_TRACKED_INDEX_JOBS = 512
type ActiveRequest = { readonly clientId: string; readonly operationId: string; readonly action: BridgeRequest['action']; readonly scope: BridgeScope; readonly generation: number | null; readonly expectedManifestHash: string | null; readonly controller: AbortController; readonly settled: Promise<void> }
type WorkspaceState = { activeCalls: number; syncing: boolean }
type RuntimeEntry = { runtime: Awaited<ReturnType<typeof openBridgeWorkspaceRuntime>>; operations: readonly ('read' | 'index' | 'web' | 'classify' | 'visual')[] }

function workspaceKey(scope: Pick<BridgeScope, 'clientInstanceId' | 'workspaceId'>): string { return `${scope.clientInstanceId}/${scope.workspaceId}` }
function activeKey(clientId: string, scope: BridgeScope, operationId: string): string { return `${clientId}/${scope.workspaceId}/${scope.conversationId}/${operationId}` }
function rawHeaderCount(request: IncomingMessage, name: string): number {
  let count = 0
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) if (request.rawHeaders[index]!.toLowerCase() === name) count++
  return count
}
function bearer(request: IncomingMessage): string | undefined {
  if (rawHeaderCount(request, 'authorization') !== 1) return undefined
  const value = request.headers.authorization
  if (typeof value !== 'string') return undefined
  const match = /^Bearer ([A-Za-z0-9._~+/-]{1,8192}={0,2})$/u.exec(value)
  return match?.[1]
}
function tokenMatches(token: string, digest: string): boolean {
  const actual = createHash('sha256').update(token).digest()
  const expected = Buffer.from(digest, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
function clientAccess(config: BridgeServerConfig, client: BridgeServerConfig['clients'][number]) {
  return createSearchIpAccessPolicy({
    allowedCidrs: client.clientCidrs,
    trustedProxyCidrs: config.trustedProxyCidrs,
    principalId: client.clientId,
    rootIds: ['workspace'],
    operations: client.grants,
    allowedOrigins: config.allowedOrigins,
    resource: config.resource,
    allowedHosts: [new URL(config.resource).host],
    port: config.port,
  })
}
function asError(error: unknown): BridgeContractError {
  if (error instanceof BridgeContractError) return error
  return new BridgeContractError('STORE_INVALID')
}
function protocolErrorEnvelope(error: unknown): { code: number; message: string; data?: unknown } {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : undefined
  let code = -32603
  let message = 'MCP protocol error'
  let data: unknown
  try {
    if (typeof record?.code === 'number' && Number.isSafeInteger(record.code)) code = record.code
    if (typeof record?.message === 'string') message = record.message
    if (record && Object.hasOwn(record, 'data')) data = Object.getOwnPropertyDescriptor(record, 'data')?.value
  } catch {}
  return { code, message, ...(data === undefined ? {} : { data }) }
}
function responseError(request: BridgeRequest, error: BridgeContractError, snapshot: BridgePublishedSnapshot | null): BridgeResponse {
  const expected = 'expectedManifestHash' in request ? request.expectedManifestHash : request.action === 'plan' ? request.manifest.manifestHash : null
  return {
    schemaVersion: 1,
    operationId: request.operationId,
    scope: request.scope,
    action: request.action,
    ok: false,
    generation: snapshot?.generation ?? null,
    manifestHash: snapshot?.manifestHash ?? null,
    expectedManifestHash: expected,
    error: { code: error.code, ...(error.message === error.code ? {} : { message: error.message }), ...(error.upstream ? { upstream: error.upstream } : {}) },
  } as BridgeResponse
}

async function readRequestBody(request: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  const declared = request.headers['content-length']
  if (Array.isArray(declared) || declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > 1_000_000)) throw new BridgeContractError('REQUEST_TOO_LARGE')
  const chunks: Buffer[] = []
  let total = 0
  for await (const value of request) {
    signal.throwIfAborted()
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    total += chunk.byteLength
    if (total > 1_000_000) throw new BridgeContractError('REQUEST_TOO_LARGE')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

export interface BridgeServer {
  readonly address: AddressInfo
  close(): Promise<void>
}

export async function createBridgeServer(config: BridgeServerConfig, options: { store?: BridgeStore } = {}): Promise<BridgeServer> {
  const frozenConfig = await parseBridgeServerConfig(config)
  config = frozenConfig
  const resource = new URL(config.resource)
  const expectedPath = resource.pathname
  const policies = new Map(config.clients.map((client) => [client.clientId, clientAccess(config, client)]))
  const exclusions = new Map(config.clients.map((client) => {
    try { return [client.clientId, createCodePathPolicy(client.excludedPaths).excludes] as const }
    catch { throw new BridgeContractError('CONFIG_INVALID') }
  }))
  const store = options.store ?? await BridgeStore.open(frozenConfig)
  const ownsStore = options.store === undefined
  const workspaceStates = new Map<string, WorkspaceState>()
  const runtimes = new Map<string, RuntimeEntry>()
  const active = new Map<string, ActiveRequest>()
  const jobOwners = new Map<string, string>()
  const requestControllers = new Set<AbortController>()
  const admission = new Set<Promise<void>>()
  let closing = false
  let closePromise: Promise<void> | undefined
  const runtimeStarts = new Map<string, Promise<RuntimeEntry>>()

  const send = (response: ServerResponse, value: BridgeResponse): void => {
    const body = Buffer.from(JSON.stringify(value), 'utf8')
    if (body.byteLength > BRIDGE_MAX_RESPONSE_BYTES) {
      const fallback = {
        schemaVersion: 1, operationId: value.operationId, scope: value.scope, action: value.action, ok: false,
        generation: 'generation' in value ? value.generation : null,
        manifestHash: 'manifestHash' in value ? value.manifestHash : null,
        expectedManifestHash: 'expectedManifestHash' in value ? value.expectedManifestHash : null,
        error: { code: 'RESPONSE_TOO_LARGE' },
      } as BridgeResponse
      send(response, fallback)
      return
    }
    response.statusCode = 200
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.end(body)
  }

  const authenticate = (request: IncomingMessage): BridgeServerConfig['clients'][number] | undefined => {
    const token = bearer(request)
    if (!token) return undefined
    for (const client of config.clients) {
      const policy = policies.get(client.clientId)!
      if (!policy.authorize(request)) continue
      if (tokenMatches(token, client.tokenSha256)) return client
    }
    return undefined
  }

  const stateFor = (scope: BridgeScope): WorkspaceState => {
    const key = workspaceKey(scope)
    let state = workspaceStates.get(key)
    if (!state) { state = { activeCalls: 0, syncing: false }; workspaceStates.set(key, state) }
    return state
  }

  const cleanupWorkspaceState = (scope: BridgeScope, state: WorkspaceState): void => {
    const key = workspaceKey(scope)
    if (workspaceStates.get(key) === state && !state.activeCalls && !state.syncing && ![...active.keys()].some((item) => item.startsWith(`${key}/`))) workspaceStates.delete(key)
  }

  const pruneJobOwners = async (): Promise<void> => {
    if (jobOwners.size < MAX_TRACKED_INDEX_JOBS) return
    for (const key of jobOwners.keys()) {
      const separator = key.lastIndexOf('/')
      const runtimeEntry = runtimes.get(key.slice(0, separator))
      if (!runtimeEntry) { jobOwners.delete(key); continue }
      const jobId = key.slice(separator + 1)
      const status = await runtimeEntry.runtime.indexStatus({ rootId: 'workspace', jobId }).catch(() => undefined)
      const job = status?.indexingJob
      if (!job || job.state !== 'queued' && job.state !== 'running') jobOwners.delete(key)
      if (jobOwners.size < MAX_TRACKED_INDEX_JOBS) return
    }
  }

  const runtimeFor = async (client: BridgeServerConfig['clients'][number], scope: BridgeScope, snapshot: BridgePublishedSnapshot | null): Promise<RuntimeEntry> => {
    const key = workspaceKey(scope)
    const found = runtimes.get(key)
    if (found) return found
    const pending = runtimeStarts.get(key)
    if (pending) return pending
    const start = (async () => {
      const paths = snapshot ? await store.snapshotPaths(scope, snapshot) : await store.runtimePaths(scope)
      await store.recoverDeadRuntimeOwnerLock(scope)
      const runtime = await openBridgeWorkspaceRuntime(config, paths.sourcePath, paths.dataPath, scope.rootLabel)
      const entry = { runtime, operations: Object.freeze([...client.grants]) }
      runtimes.set(key, entry)
      return entry
    })()
    runtimeStarts.set(key, start)
    try { return await start } finally { if (runtimeStarts.get(key) === start) runtimeStarts.delete(key) }
  }

  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let body: Buffer | undefined
    let decoded: unknown
    let client: BridgeServerConfig['clients'][number] | undefined
    let bridgeRequest: BridgeRequest | undefined
    let snapshot: BridgePublishedSnapshot | null = null
    const controller = new AbortController()
    requestControllers.add(controller)
    request.once('aborted', () => controller.abort(new BridgeContractError('CANCELLED')))
    response.once('close', () => { if (!response.writableEnded) controller.abort(new BridgeContractError('CANCELLED')) })
    let activeId: string | undefined
    let releaseCall: (() => void) | undefined
    let settleOperation: (() => void) | undefined
    try {
      if (closing) throw new BridgeContractError('BUSY')
      if (request.method !== 'POST' || request.url !== expectedPath) throw new BridgeContractError('INVALID_REQUEST')
      if (rawHeaderCount(request, 'host') !== 1 || rawHeaderCount(request, 'origin') > 1 || rawHeaderCount(request, 'x-real-ip') > 1) throw new BridgeContractError('AUTH')
      client = authenticate(request)
      if (!client) throw new BridgeContractError('AUTH')
      body = await readRequestBody(request, controller.signal)
      try { decoded = JSON.parse(body.toString('utf8')) as unknown } catch { throw new BridgeContractError('INVALID_REQUEST') }
      bridgeRequest = parseBridgeRequest(decoded, client.allowedDocumentPaths ? { allowedDocumentPaths: client.allowedDocumentPaths } : {})
      if (bridgeRequest.scope.clientInstanceId !== client.clientId) throw new BridgeContractError('SCOPE_MISMATCH')
      snapshot = await store.current(bridgeRequest.scope)
      const scopeKey = workspaceKey(bridgeRequest.scope)
      let gate = workspaceStates.get(scopeKey) ?? { activeCalls: 0, syncing: false }

      if (bridgeRequest.action === 'cancel') {
        const cancelRequest = bridgeRequest
        const target = active.get(activeKey(client.clientId, cancelRequest.scope, cancelRequest.targetOperationId))
        const siblingTarget = [...active.values()].some((entry) => entry.clientId === client!.clientId && entry.operationId === cancelRequest.targetOperationId && workspaceKey(entry.scope) === workspaceKey(cancelRequest.scope) && entry.scope.conversationId !== cancelRequest.scope.conversationId)
        if (!target && siblingTarget) throw new BridgeContractError('OPERATION_NOT_FOUND')
        if (target) {
          if (cancelRequest.targetGeneration !== target.generation || cancelRequest.expectedManifestHash !== target.expectedManifestHash) throw new BridgeContractError('STALE_GENERATION')
          target.controller.abort(new BridgeContractError('CANCELLED'))
          await target.settled
          if (['plan', 'put', 'commit'].includes(target.action) && cancelRequest.targetGeneration !== null && cancelRequest.expectedManifestHash !== null) {
            await store.withWorkspaceLock(cancelRequest.scope, () => store.cancelPendingTransfer(
              cancelRequest.scope,
              cancelRequest.targetOperationId,
              cancelRequest.targetGeneration!,
              cancelRequest.expectedManifestHash!,
            )).catch((error: unknown) => {
              if (!(error instanceof BridgeContractError) || error.code !== 'OPERATION_NOT_FOUND') throw error
            })
          }
        } else {
          if (!client.grants.includes('index') || cancelRequest.targetGeneration === null || cancelRequest.expectedManifestHash === null) throw new BridgeContractError('OPERATION_NOT_FOUND')
          await store.withWorkspaceLock(cancelRequest.scope, () => store.cancelPendingTransfer(
            cancelRequest.scope,
            cancelRequest.targetOperationId,
            cancelRequest.targetGeneration!,
            cancelRequest.expectedManifestHash!,
          ))
        }
        send(response, { schemaVersion: 1, operationId: cancelRequest.operationId, scope: cancelRequest.scope, action: 'cancel', ok: true, targetGeneration: cancelRequest.targetGeneration, expectedManifestHash: cancelRequest.expectedManifestHash, targetOperationId: cancelRequest.targetOperationId, settled: true })
        return
      }

      if (bridgeRequest.action === 'status') {
        if (admission.size >= BRIDGE_MAX_CONCURRENT_OPERATIONS + 1) throw new BridgeContractError('OPERATION_LIMIT_EXCEEDED')
        const workspace = workspaceKey(bridgeRequest.scope)
        send(response, {
          schemaVersion: 1, operationId: bridgeRequest.operationId, scope: bridgeRequest.scope,
          action: 'status', ok: true, generation: snapshot?.generation ?? null, manifestHash: snapshot?.manifestHash ?? null,
          state: gate.syncing ? 'syncing' : gate.activeCalls ? 'calling' : snapshot ? 'ready' : 'empty',
          activeOperations: Math.min(8, [...active.keys()].filter((key) => key.startsWith(`${workspace}/`)).length),
        })
        return
      }

      const controlCall = bridgeRequest.action === 'call' && ['index_status', 'cancel_indexing'].includes(bridgeRequest.toolName)
      const activeLimit = controlCall ? BRIDGE_MAX_CONCURRENT_OPERATIONS + 2 : BRIDGE_MAX_CONCURRENT_OPERATIONS
      if (active.size >= activeLimit) throw new BridgeContractError('OPERATION_LIMIT_EXCEEDED')
      activeId = activeKey(client.clientId, bridgeRequest.scope, bridgeRequest.operationId)
      if (active.has(activeId)) throw new BridgeContractError('MANIFEST_CONFLICT')
      const settled = new Promise<void>((resolve) => { settleOperation = resolve })
      const activeGeneration = bridgeRequest.action === 'call' ? bridgeRequest.generation : bridgeRequest.action === 'plan' || bridgeRequest.action === 'put' || bridgeRequest.action === 'commit' ? bridgeRequest.baseGeneration : null
      const activeManifestHash = bridgeRequest.action === 'call' || bridgeRequest.action === 'put' || bridgeRequest.action === 'commit' ? bridgeRequest.expectedManifestHash : bridgeRequest.action === 'plan' ? bridgeRequest.manifest.manifestHash : null
      active.set(activeId, { clientId: client.clientId, operationId: bridgeRequest.operationId, action: bridgeRequest.action, scope: bridgeRequest.scope, generation: activeGeneration, expectedManifestHash: activeManifestHash, controller, settled })

      if (bridgeRequest.action === 'plan') {
        if (!client.grants.includes('index')) throw new BridgeContractError('AUTH')
        const planRequest = bridgeRequest
        if (planRequest.manifest.files.some((file) => exclusions.get(client!.clientId)!(file.path))) throw new BridgeContractError('MANIFEST_INVALID')
        const plan = await store.withWorkspaceLock(planRequest.scope, () => {
          controller.signal.throwIfAborted()
          return store.plan(planRequest.scope, planRequest.operationId, planRequest.baseGeneration, planRequest.manifest, bridgeRuntimeFingerprint(config), client!.allowedDocumentPaths)
        })
        controller.signal.throwIfAborted()
        send(response, {
          schemaVersion: 1, operationId: bridgeRequest.operationId, scope: bridgeRequest.scope, action: 'plan', ok: true,
          expectedManifestHash: plan.transfer.manifest.manifestHash,
          generation: plan.current?.generation ?? null, manifestHash: plan.current?.manifestHash ?? null,
          uploadId: bridgeRequest.operationId, alreadyCurrent: plan.alreadyCurrent, missingFiles: plan.missingFiles,
          maxChunkBytes: 128_000,
        })
        return
      }

      if (bridgeRequest.action === 'put') {
        if (!client.grants.includes('index')) throw new BridgeContractError('AUTH')
        const chunk = Buffer.from(bridgeRequest.dataBase64, 'base64')
        const putRequest = bridgeRequest
        if (exclusions.get(client.clientId)!(putRequest.path)) throw new BridgeContractError('MANIFEST_INVALID')
        const progress = await store.withWorkspaceLock(putRequest.scope, () => {
          controller.signal.throwIfAborted()
          return store.put(putRequest.scope, putRequest.operationId, putRequest.baseGeneration, putRequest.expectedManifestHash, putRequest.path, putRequest.contentHash, putRequest.expectedBytes, putRequest.offset, chunk, client!.allowedDocumentPaths)
        })
        controller.signal.throwIfAborted()
        send(response, {
          schemaVersion: 1, operationId: bridgeRequest.operationId, scope: bridgeRequest.scope, action: 'put', ok: true,
          baseGeneration: bridgeRequest.baseGeneration, expectedManifestHash: bridgeRequest.expectedManifestHash,
          path: bridgeRequest.path, receivedBytes: progress.receivedBytes, complete: progress.complete,
        })
        return
      }

      if (bridgeRequest.action === 'commit') {
        if (!client.grants.includes('index')) throw new BridgeContractError('AUTH')
        const commitRequest = bridgeRequest
        gate = stateFor(bridgeRequest.scope)
        if (gate.syncing || gate.activeCalls) throw new BridgeContractError('BUSY')
        gate.syncing = true
        try {
          await store.withWorkspaceLock(bridgeRequest.scope, async () => {
            controller.signal.throwIfAborted()
            const latest = await store.current(commitRequest.scope)
            const transfer = await store.transfer(commitRequest.scope, commitRequest.operationId, client!.allowedDocumentPaths)
            if (transfer.manifest.manifestHash !== commitRequest.expectedManifestHash || transfer.baseGeneration !== commitRequest.baseGeneration) throw new BridgeContractError('MANIFEST_CONFLICT')
            if ((latest?.generation ?? 0) !== commitRequest.baseGeneration) throw new BridgeContractError('GENERATION_CONFLICT')
            if (latest?.manifestHash === transfer.manifest.manifestHash) {
              await store.removeTransfer(commitRequest.scope, commitRequest.operationId)
              snapshot = latest
              return
            }
            const runtimeEntry = runtimes.get(workspaceKey(commitRequest.scope))
            if (runtimeEntry && await hasActiveBridgeIndexJob(runtimeEntry.runtime)) throw new BridgeContractError('BUSY')
            const paths = await store.createSnapshot(commitRequest.scope, commitRequest.operationId, transfer.manifest, client!.allowedDocumentPaths)
            await store.assertSnapshotSize(paths)
            if (controller.signal.aborted) { await store.abortSnapshot(commitRequest.scope, paths); throw new BridgeContractError('CANCELLED') }
            snapshot = await store.publishSnapshot(commitRequest.scope, paths, transfer.manifest, bridgeRuntimeFingerprint(config))
            await store.removeTransfer(commitRequest.scope, commitRequest.operationId).catch(() => undefined)
          })
        } finally { gate.syncing = false }
        const committed = snapshot!
        const provenance = { kind: 'analytical_snapshot' as const, scope: bridgeRequest.scope, generation: committed.generation, manifestHash: committed.manifestHash }
        send(response, { schemaVersion: 1, operationId: bridgeRequest.operationId, scope: bridgeRequest.scope, action: 'commit', ok: true, expectedManifestHash: bridgeRequest.expectedManifestHash, generation: committed.generation, manifestHash: committed.manifestHash, provenance })
        return
      }

      if (bridgeRequest.action === 'call') {
        const sourceFree = bridgeRequest.generation === null
        const callSnapshot = snapshot
        if (sourceFree) {
          if (bridgeRequest.generation !== null || bridgeRequest.expectedManifestHash !== null) throw new BridgeContractError('STALE_GENERATION')
          if (!SOURCE_FREE_TOOLS.has(bridgeRequest.toolName)) throw new BridgeContractError('SNAPSHOT_UNAVAILABLE')
        } else if (callSnapshot === null) {
          throw new BridgeContractError('SNAPSHOT_UNAVAILABLE')
        } else {
          if (bridgeRequest.generation !== callSnapshot.generation || bridgeRequest.expectedManifestHash !== callSnapshot.manifestHash) throw new BridgeContractError('STALE_GENERATION')
          if (callSnapshot.manifest.files.some((file) => exclusions.get(client!.clientId)!(file.path))) throw new BridgeContractError('WORKSPACE_CHANGED')
          await store.verifyPublishedSource(bridgeRequest.scope, callSnapshot)
        }
        gate = stateFor(bridgeRequest.scope)
        if (gate.syncing) throw new BridgeContractError('BUSY')
        gate.activeCalls++
        releaseCall = () => { gate.activeCalls--; cleanupWorkspaceState(bridgeRequest!.scope, gate) }
        const runtimeEntry = await runtimeFor(client, bridgeRequest.scope, callSnapshot)
        if (bridgeRequest.toolName === 'cancel_indexing') {
          const jobId = bridgeRequest.arguments.jobId
          const owner = typeof jobId === 'string' ? jobOwners.get(`${workspaceKey(bridgeRequest.scope)}/${jobId}`) : undefined
          if (owner !== bridgeRequest.scope.conversationId) throw new BridgeContractError('AUTH')
        }
        if (bridgeRequest.toolName === 'start_indexing') {
          await pruneJobOwners()
          if (jobOwners.size >= MAX_TRACKED_INDEX_JOBS) throw new BridgeContractError('OPERATION_LIMIT_EXCEEDED')
        }
        let result: unknown
        let protocolError: unknown
        try {
          result = await callBridgeTool(runtimeEntry.runtime, runtimeEntry.operations, bridgeRequest.toolName, bridgeRequest.arguments, controller.signal)
        } catch (error) {
          protocolError = error
        } finally {
          releaseCall()
          releaseCall = undefined
        }
        const payload = protocolError
          ? { kind: 'protocol_error' as const, error: protocolErrorEnvelope(protocolError) }
          : { kind: 'tool_result' as const, result: result as Record<string, unknown> }
        if (!protocolError && bridgeRequest.toolName === 'start_indexing') {
          const callResult = result && typeof result === 'object' ? result as Record<string, unknown> : undefined
          const structured = callResult?.structuredContent && typeof callResult.structuredContent === 'object' ? callResult.structuredContent as Record<string, unknown> : undefined
          const job = structured?.job && typeof structured.job === 'object' ? structured.job as Record<string, unknown> : undefined
          if (structured?.created === true && typeof job?.jobId === 'string') jobOwners.set(`${workspaceKey(bridgeRequest.scope)}/${job.jobId}`, bridgeRequest.scope.conversationId)
        }
        if (!protocolError && bridgeRequest.toolName === 'cancel_indexing') {
          const jobId = bridgeRequest.arguments.jobId
          if (typeof jobId === 'string') jobOwners.delete(`${workspaceKey(bridgeRequest.scope)}/${jobId}`)
        }
        if (sourceFree) {
          const provenance = { kind: 'source_free' as const, scope: bridgeRequest.scope, projectFilesIncluded: false as const, localVerification: 'not_performed' as const }
          send(response, { schemaVersion: 1, operationId: bridgeRequest.operationId, scope: bridgeRequest.scope, action: 'call', ok: true, expectedManifestHash: null, generation: null, manifestHash: null, provenance, result: payload })
        } else {
          if (!callSnapshot) throw new BridgeContractError('SNAPSHOT_UNAVAILABLE')
          const provenance = { kind: 'analytical_snapshot' as const, scope: bridgeRequest.scope, generation: callSnapshot.generation, manifestHash: callSnapshot.manifestHash }
          send(response, { schemaVersion: 1, operationId: bridgeRequest.operationId, scope: bridgeRequest.scope, action: 'call', ok: true, expectedManifestHash: bridgeRequest.expectedManifestHash!, generation: callSnapshot.generation, manifestHash: callSnapshot.manifestHash, provenance, result: payload })
        }
        return
      }
      throw new BridgeContractError('INVALID_REQUEST')
    } catch (error) {
      if (bridgeRequest) {
        const current = snapshot ?? await store.current(bridgeRequest.scope).catch(() => null)
        send(response, responseError(bridgeRequest, asError(error), current))
      } else {
        response.statusCode = error instanceof BridgeContractError && error.code === 'AUTH' ? 403 : 400
        response.setHeader('content-type', 'application/json; charset=utf-8')
        response.setHeader('cache-control', 'no-store')
        response.end(JSON.stringify({ error: error instanceof BridgeContractError ? error.code : 'INVALID_REQUEST' }))
      }
    } finally {
      releaseCall?.()
      if (activeId) active.delete(activeId)
      if (bridgeRequest) {
        const workspaceState = workspaceStates.get(workspaceKey(bridgeRequest.scope))
        if (workspaceState) cleanupWorkspaceState(bridgeRequest.scope, workspaceState)
      }
      settleOperation?.()
      requestControllers.delete(controller)
      void body
    }
  }

  const server = createServer((request, response) => {
    if (admission.size >= BRIDGE_MAX_CONCURRENT_OPERATIONS + 2) {
      response.statusCode = 503
      response.end()
      return
    }
    let settled!: () => void
    const task = new Promise<void>((resolve) => { settled = resolve })
    admission.add(task)
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) { response.statusCode = 500; response.end() }
      else if (!response.writableEnded) response.destroy()
    }).finally(() => { admission.delete(task); settled() })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.bindHost, () => { server.removeListener('error', reject); resolve() })
    })
  } catch (error) {
    if (ownsStore) await store.close().catch(() => undefined)
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    if (ownsStore) await store.close().catch(() => undefined)
    throw new BridgeContractError('STORE_INVALID')
  }

  return {
    address,
    async close() {
      if (closePromise) return closePromise
      closing = true
      closePromise = (async () => {
        const failures: unknown[] = []
        const serverClosed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        for (const controller of requestControllers) controller.abort(new BridgeContractError('CANCELLED'))
        server.closeAllConnections()
        await Promise.allSettled([...admission])
        try { await serverClosed } catch (error) { failures.push(error) }
        const closingRuntimes = await Promise.allSettled([...runtimes.values()].map((entry) => entry.runtime.close()))
        failures.push(...closingRuntimes.flatMap((item) => item.status === 'rejected' ? [item.reason] : []))
        runtimes.clear()
        if (ownsStore) {
          try { await store.close() } catch (error) { failures.push(error) }
        }
        if (failures.length) throw new AggregateError(failures, 'Bridge shutdown failed')
      })()
      return closePromise
    },
  }
}
