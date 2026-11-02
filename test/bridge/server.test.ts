import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createBridgeScope, createBridgeManifest, type BridgeResponse, type BridgeScope } from '../../src/bridge/protocol.js'
import { parseBridgeServerConfig } from '../../src/bridge/config.js'
import { createBridgeServer } from '../../src/bridge/server.js'
import { BridgeStore } from '../../src/bridge/store.js'
import { callBridgeTool } from '../../src/bridge/runtime.js'
import { openSearchRuntime } from '../../src/runtime/index.js'

const clientA = '4d1237be-9821-4b95-9079-b77d935bbf01'
const clientB = 'af4c42a2-b189-4a98-b743-4abca5b59c2d'
const clientReadOnly = '5f7f8875-17d7-48f3-b4d2-1e5507e8fd2d'
const tokenA = 'bridge-test-token-a'
const tokenB = 'bridge-test-token-b'
const tokenReadOnly = 'bridge-test-token-read-only'
const conversationA = '37cc2038-70ef-41f1-ae10-48cd6d936799'
const conversationB = 'daaf95d2-74b9-45f5-b515-27b45f21c682'

function sha(value: string): string { return createHash('sha256').update(value).digest('hex') }
function requestBody(scope: BridgeScope, operationId: string, body: Record<string, unknown>) {
  return { schemaVersion: 1, operationId, scope, ...body }
}

async function post(port: number, token: string | undefined, body: unknown, headers: Record<string, string | string[]> = {}) {
  const bytes = Buffer.from(JSON.stringify(body))
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolveResponse, reject) => {
    const request = httpRequest({
      host: '127.0.0.1', port, method: 'POST', path: '/mcp/search',
      headers: {
        host: 'search.bridge.test',
        origin: 'https://chatgpt.com',
        'content-type': 'application/json',
        'content-length': String(bytes.byteLength),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        try { resolveResponse({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }) }
        catch (error) { reject(error) }
      })
    })
    request.on('error', reject)
    request.end(bytes)
  })
}

function file(path: string, content: string) {
  const bytes = Buffer.from(content)
  return { path, sha256: sha(content), bytes: bytes.byteLength }
}

async function sync(port: number, scope: BridgeScope, token: string, generation: number, content: Record<string, string>) {
  const manifest = createBridgeManifest(Object.entries(content).map(([path, value]) => file(path, value)))
  const operationId = randomUUID()
  const plan = await post(port, token, requestBody(scope, operationId, { action: 'plan', baseGeneration: generation, manifest }))
  assert.equal(plan.status, 200)
  const planValue = plan.body as unknown as Extract<BridgeResponse, { action: 'plan'; ok: true }>
  assert.equal(planValue.ok, true)
  for (const declaration of planValue.missingFiles) {
    const value = Buffer.from(content[declaration.path]!)
    const put = await post(port, token, requestBody(scope, operationId, {
      action: 'put', baseGeneration: generation, expectedManifestHash: manifest.manifestHash,
      path: declaration.path, contentHash: declaration.sha256, expectedBytes: declaration.bytes,
      offset: 0, dataBase64: value.toString('base64'),
    }))
    assert.equal(put.status, 200)
    assert.equal(put.body.ok, true)
  }
  const committed = await post(port, token, requestBody(scope, operationId, { action: 'commit', baseGeneration: generation, expectedManifestHash: manifest.manifestHash }))
  assert.equal(committed.status, 200)
  assert.equal(committed.body.ok, true)
  return manifest
}

async function call(port: number, token: string, scope: BridgeScope, generation: number | null, manifestHash: string | null, toolName: string, args: Record<string, unknown> = {}) {
  const response = await post(port, token, requestBody(scope, randomUUID(), {
    action: 'call', generation, expectedManifestHash: manifestHash, toolName, arguments: args,
  }))
  assert.equal(response.status, 200)
  return response.body as unknown as Extract<BridgeResponse, { action: 'call'; ok: true }>
}

function toolResult(response: Extract<BridgeResponse, { action: 'call'; ok: true }>): Record<string, unknown> {
  assert.equal(response.result.kind, 'tool_result')
  return response.result.kind === 'tool_result' ? response.result.result as Record<string, unknown> : {}
}

test('loopback bridge authenticates, syncs without auto-indexing, preserves the runtime, and isolates same-basename workspaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-bridge-server-'))
  const dataDir = join(root, 'central-data')
  const workspaceA = join(root, 'client-a', 'same-basename')
  const workspaceB = join(root, 'client-b', 'same-basename')
  const workspaceR = join(root, 'read-only', 'same-basename')
  await Promise.all([mkdir(workspaceA, { recursive: true }), mkdir(workspaceB, { recursive: true }), mkdir(workspaceR, { recursive: true })])
  const config = await parseBridgeServerConfig({
    schemaVersion: 1,
    resource: 'https://search.bridge.test/mcp/search',
    bindHost: '127.0.0.1', port: 0, dataDir, trustedProxyCidrs: [],
    allowedOrigins: ['https://chatgpt.com'],
    clients: [
      { clientId: clientA, tokenSha256: sha(tokenA), clientCidrs: ['127.0.0.1/32'], grants: ['read', 'index'] },
      { clientId: clientB, tokenSha256: sha(tokenB), clientCidrs: ['127.0.0.1/32'], grants: ['read', 'index'] },
      { clientId: clientReadOnly, tokenSha256: sha(tokenReadOnly), clientCidrs: ['127.0.0.1/32'], grants: ['read'] },
    ],
  })
  let server: Awaited<ReturnType<typeof createBridgeServer>> | undefined
  try {
    server = await createBridgeServer(config)
    const port = server.address.port
    const scopeA = createBridgeScope({ clientInstanceId: clientA, conversationId: conversationA, canonicalPath: resolve(workspaceA), rootLabel: 'Same project' })
    const scopeB = createBridgeScope({ clientInstanceId: clientB, conversationId: conversationB, canonicalPath: resolve(workspaceB), rootLabel: 'Same project' })
    const scopeR = createBridgeScope({ clientInstanceId: clientReadOnly, conversationId: conversationA, canonicalPath: resolve(workspaceR) })

    const missingKey = await post(port, undefined, requestBody(scopeA, randomUUID(), { action: 'status' }))
    assert.equal(missingKey.status, 403)
    const wrongKey = await post(port, 'wrong-token', requestBody(scopeA, randomUUID(), { action: 'status' }))
    assert.equal(wrongKey.status, 403)
    const wrongHost = await post(port, tokenA, requestBody(scopeA, randomUUID(), { action: 'status' }), { host: 'other.bridge.test' })
    assert.equal(wrongHost.status, 403)
    const wrongOrigin = await post(port, tokenA, requestBody(scopeA, randomUUID(), { action: 'status' }), { origin: 'https://evil.test' })
    assert.equal(wrongOrigin.status, 403)
    const duplicateAuth = await post(port, tokenA, requestBody(scopeA, randomUUID(), { action: 'status' }), { authorization: [`Bearer ${tokenA}`, `Bearer ${tokenA}`] })
    assert.equal(duplicateAuth.status, 403)
    const duplicateOrigin = await post(port, tokenA, requestBody(scopeA, randomUUID(), { action: 'status' }), { origin: ['https://chatgpt.com', 'https://chatgpt.com'] })
    assert.equal(duplicateOrigin.status, 403)
    const duplicateRealIp = await post(port, tokenA, requestBody(scopeA, randomUUID(), { action: 'status' }), { 'x-real-ip': ['127.0.0.1', '127.0.0.1'] })
    assert.equal(duplicateRealIp.status, 403)
    const untrustedSpoof = await post(port, tokenA, requestBody(scopeA, randomUUID(), { action: 'status' }), { 'x-real-ip': '192.0.2.17' })
    assert.equal(untrustedSpoof.status, 200)

    const sourceFree = await call(port, tokenA, scopeA, null, null, 'capabilities')
    assert.equal(sourceFree.provenance.kind, 'source_free')
    if (sourceFree.provenance.kind === 'source_free') {
      assert.equal(sourceFree.provenance.projectFilesIncluded, false)
      assert.equal(sourceFree.provenance.localVerification, 'not_performed')
    }
    assert.equal((toolResult(sourceFree).structuredContent as Record<string, unknown>).code, true)

    const readOnlyPlan = await post(port, tokenReadOnly, requestBody(scopeR, randomUUID(), {
      action: 'plan', baseGeneration: 0, manifest: createBridgeManifest([file('src/hidden.ts', 'export const hidden = true')]),
    }))
    assert.equal(readOnlyPlan.status, 200)
    assert.equal((readOnlyPlan.body.error as Record<string, unknown>).code, 'AUTH')

    const first = await sync(port, scopeA, tokenA, 0, { 'src/signal.ts': 'export function alphaPrivateSignal() { return "alpha" }\n' })
    const workspaceStoreA = join(dataDir, 'clients', clientA, scopeA.workspaceId)
    const sourcePathA = join(workspaceStoreA, 'source')
    const dataPathA = join(workspaceStoreA, 'data')
    const sourceIdentity = await stat(sourcePathA)
    const dataIdentity = await stat(dataPathA)
    const indexBefore = await call(port, tokenA, scopeA, 1, first.manifestHash, 'index_status', { rootId: 'workspace' })
    assert.equal(toolResult(indexBefore).structuredContent && ((toolResult(indexBefore).structuredContent as Record<string, unknown>).identity), null)

    const indexed = await call(port, tokenA, scopeA, 1, first.manifestHash, 'index_repository', { rootId: 'workspace' })
    assert.equal(toolResult(indexed).isError, undefined)
    const foundAlpha = await call(port, tokenA, scopeA, 1, first.manifestHash, 'search_code', { rootId: 'workspace', query: 'alphaPrivateSignal', mode: 'lexical' })
    const alphaHits = (toolResult(foundAlpha).structuredContent as { hits?: Array<{ path: string; contentHash?: string }> }).hits ?? []
    assert.equal(alphaHits[0]?.path, 'src/signal.ts')
    const read = await call(port, tokenA, scopeA, 1, first.manifestHash, 'read_source', { rootId: 'workspace', path: 'src/signal.ts' })
    const source = toolResult(read).structuredContent as { text: string; contentHash: string; snapshotId: string }
    assert.match(source.text, /alphaPrivateSignal/u)
    assert.equal(source.contentHash, first.files[0]?.sha256)
    assert.ok(source.snapshotId)

    const second = await sync(port, scopeA, tokenA, 1, { 'src/signal.ts': 'export function betaPrivateSignal() { return "beta" }\n', 'src/deleted.ts': '' })
    const staleSearch = await call(port, tokenA, scopeA, 2, second.manifestHash, 'search_code', { rootId: 'workspace', query: 'alphaPrivateSignal', mode: 'lexical' })
    assert.equal(toolResult(staleSearch).isError, true)
    const staleRead = await call(port, tokenA, scopeA, 2, second.manifestHash, 'read_source', { rootId: 'workspace', path: 'src/signal.ts' })
    assert.equal(toolResult(staleRead).isError, true)
    await call(port, tokenA, scopeA, 2, second.manifestHash, 'index_repository', { rootId: 'workspace' })
    const foundBeta = await call(port, tokenA, scopeA, 2, second.manifestHash, 'search_code', { rootId: 'workspace', query: 'betaPrivateSignal', mode: 'lexical' })
    assert.equal(((toolResult(foundBeta).structuredContent as { hits: Array<{ path: string }> }).hits)[0]?.path, 'src/signal.ts')
    assert.equal((await stat(sourcePathA)).ino, sourceIdentity.ino)
    assert.equal((await stat(dataPathA)).ino, dataIdentity.ino)

    const other = await sync(port, scopeB, tokenB, 0, { 'src/signal.ts': 'export function mangoVelvetUnique() { return "other" }\n' })
    await call(port, tokenB, scopeB, 1, other.manifestHash, 'index_repository', { rootId: 'workspace' })
    const onlyOther = await call(port, tokenB, scopeB, 1, other.manifestHash, 'search_code', { rootId: 'workspace', query: 'mangoVelvetUnique', mode: 'lexical' })
    assert.equal(((toolResult(onlyOther).structuredContent as { hits: Array<{ path: string }> }).hits)[0]?.path, 'src/signal.ts')
    const noCrossHit = await call(port, tokenA, scopeA, 2, second.manifestHash, 'search_code', { rootId: 'workspace', query: 'mangoVelvetUnique', mode: 'lexical' })
    assert.equal((toolResult(noCrossHit).structuredContent as { hits: unknown[] }).hits.length, 0)

    const sourceFreeAfterSync = await call(port, tokenA, scopeA, null, null, 'capabilities')
    assert.equal(sourceFreeAfterSync.provenance.kind, 'source_free')
    const sourceFreeSearch = await post(port, tokenA, requestBody(scopeA, randomUUID(), { action: 'call', generation: null, expectedManifestHash: null, toolName: 'search_code', arguments: { rootId: 'workspace', query: 'betaPrivateSignal' } }))
    assert.equal((sourceFreeSearch.body.error as Record<string, unknown>).code, 'SNAPSHOT_UNAVAILABLE')

    const started = await call(port, tokenA, scopeA, 2, second.manifestHash, 'start_indexing', { rootId: 'workspace' })
    const jobInfo = toolResult(started).structuredContent as { created: boolean; job: { jobId: string; state: string } }
    assert.equal(jobInfo.created, true)
    let statusJob: { jobId: string; state: string } | undefined
    for (let attempt = 0; attempt < 100; attempt++) {
      const jobStatus = await call(port, tokenA, scopeA, 2, second.manifestHash, 'index_status', { rootId: 'workspace', jobId: jobInfo.job.jobId })
      statusJob = (toolResult(jobStatus).structuredContent as { indexingJob: { jobId: string; state: string } }).indexingJob
      if (statusJob.state !== 'queued' && statusJob.state !== 'running') break
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    }
    assert.ok(statusJob)
    assert.equal(statusJob.jobId, jobInfo.job.jobId)
    assert.notEqual(statusJob.state, 'queued')
    assert.notEqual(statusJob.state, 'running')
    const otherConversation = createBridgeScope({ clientInstanceId: clientA, conversationId: conversationB, canonicalPath: resolve(workspaceA) })
    const deniedCancel = await post(port, tokenA, requestBody(otherConversation, randomUUID(), { action: 'call', generation: 2, expectedManifestHash: second.manifestHash, toolName: 'cancel_indexing', arguments: { rootId: 'workspace', jobId: jobInfo.job.jobId } }))
    assert.equal((deniedCancel.body.error as Record<string, unknown>).code, 'AUTH')
    const ownerCancel = await call(port, tokenA, scopeA, 2, second.manifestHash, 'cancel_indexing', { rootId: 'workspace', jobId: jobInfo.job.jobId })
    assert.equal(toolResult(ownerCancel).structuredContent !== undefined, true)

    const staleGeneration = await post(port, tokenA, requestBody(scopeA, randomUUID(), { action: 'call', generation: 1, expectedManifestHash: first.manifestHash, toolName: 'search_code', arguments: { rootId: 'workspace', query: 'alphaPrivateSignal' } }))
    assert.equal(staleGeneration.status, 200)
    assert.equal((staleGeneration.body.error as Record<string, unknown>).code, 'STALE_GENERATION')

    await writeFile(join(sourcePathA, 'src/signal.ts'), 'export function tamperedOutsideSync() { return "bad" }\n')
    const sourceFreeAfterTamper = await call(port, tokenA, scopeA, null, null, 'capabilities')
    assert.equal(sourceFreeAfterTamper.provenance.kind, 'source_free')
    const refusedTamperedRead = await post(port, tokenA, requestBody(scopeA, randomUUID(), { action: 'call', generation: 2, expectedManifestHash: second.manifestHash, toolName: 'search_code', arguments: { rootId: 'workspace', query: 'betaPrivateSignal' } }))
    assert.equal((refusedTamperedRead.body.error as Record<string, unknown>).code, 'WORKSPACE_CHANGED')
    await writeFile(join(sourcePathA, 'src/signal.ts'), 'export function betaPrivateSignal() { return "beta" }\n')
  } finally {
    await server?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('cancel settles a queued put for its owning conversation and rejects a sibling conversation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-bridge-cancel-'))
  const client = clientA
  const token = tokenA
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const config = await parseBridgeServerConfig({
    schemaVersion: 1, resource: 'https://search.bridge.test/mcp/search', bindHost: '127.0.0.1', port: 0,
    dataDir, trustedProxyCidrs: [], allowedOrigins: ['https://chatgpt.com'],
    clients: [{ clientId: client, tokenSha256: sha(token), clientCidrs: ['127.0.0.1/32'], grants: ['read', 'index'] }],
  })
  const store = await BridgeStore.open(config)
  let server: Awaited<ReturnType<typeof createBridgeServer>> | undefined
  let releaseBarrier!: () => void
  let acquired!: () => void
  const acquiredPromise = new Promise<void>((resolvePromise) => { acquired = resolvePromise })
  const barrier = new Promise<void>((resolvePromise) => { releaseBarrier = resolvePromise })
  try {
    server = await createBridgeServer(config, { store })
    const scope = createBridgeScope({ clientInstanceId: client, conversationId: conversationA, canonicalPath: resolve(workspace) })
    const sibling = createBridgeScope({ clientInstanceId: client, conversationId: conversationB, canonicalPath: resolve(workspace) })
    const manifest = createBridgeManifest([file('src/pending.ts', 'export const pending = true')])
    const operationId = randomUUID()
    const planned = await post(server.address.port, token, requestBody(scope, operationId, { action: 'plan', baseGeneration: 0, manifest }))
    assert.equal(planned.body.ok, true)

    const held = store.withWorkspaceLock(scope, async () => { acquired(); await barrier })
    await acquiredPromise
    const putPromise = post(server.address.port, token, requestBody(scope, operationId, {
      action: 'put', baseGeneration: 0, expectedManifestHash: manifest.manifestHash,
      path: 'src/pending.ts', contentHash: manifest.files[0]!.sha256, expectedBytes: manifest.files[0]!.bytes,
      offset: 0, dataBase64: Buffer.from('export const pending = true').toString('base64'),
    }))
    let activeCount = 0
    for (let attempt = 0; attempt < 50 && activeCount === 0; attempt++) {
      const status = await post(server.address.port, token, requestBody(scope, randomUUID(), { action: 'status' }))
      activeCount = Number(status.body.activeOperations)
      if (!activeCount) await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    }
    assert.equal(activeCount, 1)

    const siblingCancel = await post(server.address.port, token, requestBody(sibling, randomUUID(), {
      action: 'cancel', targetGeneration: 0, expectedManifestHash: manifest.manifestHash, targetOperationId: operationId,
    }))
    assert.equal((siblingCancel.body.error as Record<string, unknown>).code, 'OPERATION_NOT_FOUND')

    const cancelPromise = post(server.address.port, token, requestBody(scope, randomUUID(), {
      action: 'cancel', targetGeneration: 0, expectedManifestHash: manifest.manifestHash, targetOperationId: operationId,
    }))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    releaseBarrier()
    await held
    const [put, cancelled] = await Promise.all([putPromise, cancelPromise])
    assert.equal((put.body.error as Record<string, unknown>).code, 'CANCELLED')
    assert.equal(cancelled.body.ok, true)
    assert.equal(cancelled.body.settled, true)
    await assert.rejects(store.transfer(scope, operationId))
  } finally {
    releaseBarrier()
    await server?.close()
    await store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('idle cancel removes an owned pending transfer and configured exclusions fence manifests and snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-bridge-exclusions-'))
  const token = tokenA
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const base = {
    schemaVersion: 1,
    resource: 'https://search.bridge.test/mcp/search',
    bindHost: '127.0.0.1', port: 0, dataDir, trustedProxyCidrs: [],
    allowedOrigins: ['https://chatgpt.com'],
    clients: [{ clientId: clientA, tokenSha256: sha(token), clientCidrs: ['127.0.0.1/32'], grants: ['read', 'index'] }],
  }
  let server: Awaited<ReturnType<typeof createBridgeServer>> | undefined
  try {
    const initialConfig = await parseBridgeServerConfig(base)
    server = await createBridgeServer(initialConfig)
    const scope = createBridgeScope({ clientInstanceId: clientA, conversationId: conversationA, canonicalPath: resolve(workspace) })
    const pendingManifest = createBridgeManifest([file('src/cancel-me.ts', 'export const pending = true')])
    const pendingId = randomUUID()
    const planned = await post(server.address.port, token, requestBody(scope, pendingId, { action: 'plan', baseGeneration: 0, manifest: pendingManifest }))
    assert.equal(planned.body.ok, true)
    const cancelled = await post(server.address.port, token, requestBody(scope, randomUUID(), {
      action: 'cancel', targetGeneration: 0, expectedManifestHash: pendingManifest.manifestHash, targetOperationId: pendingId,
    }))
    assert.equal(cancelled.body.ok, true)
    assert.equal(cancelled.body.settled, true)

    const initialManifest = await sync(server.address.port, scope, token, 0, { 'src/blocked.ts': 'export const blocked = true' })
    await server.close()
    server = undefined

    const restrictedConfig = await parseBridgeServerConfig({
      ...base,
      clients: [{ ...base.clients[0], excludedPaths: ['src/blocked.ts'] }],
    })
    server = await createBridgeServer(restrictedConfig)
    const restrictedPort = server.address.port
    const excludedPlan = await post(restrictedPort, token, requestBody(scope, randomUUID(), {
      action: 'plan', baseGeneration: 1, manifest: createBridgeManifest([file('src/blocked.ts', 'export const blocked = true')]),
    }))
    assert.equal((excludedPlan.body.error as Record<string, unknown>).code, 'MANIFEST_INVALID')
    const fencedCall = await post(restrictedPort, token, requestBody(scope, randomUUID(), {
      action: 'call', generation: 1, expectedManifestHash: initialManifest.manifestHash,
      toolName: 'capabilities', arguments: {},
    }))
    assert.equal((fencedCall.body.error as Record<string, unknown>).code, 'WORKSPACE_CHANGED')

    const emptyManifest = createBridgeManifest([])
    const correctedId = randomUUID()
    const correctionPlan = await post(restrictedPort, token, requestBody(scope, correctedId, { action: 'plan', baseGeneration: 1, manifest: emptyManifest }))
    assert.equal(correctionPlan.body.ok, true)
    const correction = await post(restrictedPort, token, requestBody(scope, correctedId, {
      action: 'commit', baseGeneration: 1, expectedManifestHash: emptyManifest.manifestHash,
    }))
    assert.equal(correction.body.ok, true)
    const allowedCall = await post(restrictedPort, token, requestBody(scope, randomUUID(), {
      action: 'call', generation: 2, expectedManifestHash: emptyManifest.manifestHash,
      toolName: 'capabilities', arguments: {},
    }))
    assert.equal(allowedCall.body.ok, true)
  } finally {
    await server?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('client CIDR rejection is independent from the loopback listener and token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-bridge-cidr-'))
  const client = '4d1237be-9821-4b95-9079-b77d935bbf01'
  const token = 'cidr-test-token'
  const config = await parseBridgeServerConfig({
    schemaVersion: 1, resource: 'https://search.bridge.test/mcp/search', bindHost: '127.0.0.1', port: 0,
    dataDir: join(root, 'data'), trustedProxyCidrs: [], allowedOrigins: ['https://chatgpt.com'],
    clients: [{ clientId: client, tokenSha256: sha(token), clientCidrs: ['192.0.2.17/32'], grants: ['read'] }],
  })
  let server: Awaited<ReturnType<typeof createBridgeServer>> | undefined
  try {
    server = await createBridgeServer(config)
    const scope = createBridgeScope({ clientInstanceId: client, conversationId: conversationA, canonicalPath: resolve(root) })
    const result = await post(server.address.port, token, requestBody(scope, randomUUID(), { action: 'status' }))
    assert.equal(result.status, 403)
  } finally {
    await server?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('bridge call waits for delegated runtime work to physically settle after cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-bridge-drain-'))
  const source = join(root, 'source')
  const data = join(root, 'data')
  await Promise.all([mkdir(source), mkdir(data)])
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({ config: { version: 1, dataDir: data, roots: [{ id: 'workspace', path: source, watch: false }] } })
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolvePromise) => { entered = resolvePromise })
    runtime.searchCode = async () => {
      entered()
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
      return { hits: [] } as Awaited<ReturnType<typeof runtime.searchCode>>
    }
    const controller = new AbortController()
    const beganAt = Date.now()
    const operation = callBridgeTool(runtime, ['read'], 'search_code', { rootId: 'workspace', query: 'slowPhysicalCompletion' }, controller.signal)
    await enteredPromise
    const abortAt = Date.now()
    controller.abort(new Error('test cancellation'))
    await assert.rejects(operation)
    assert.ok(Date.now() - abortAt >= 80)
    assert.ok(Date.now() >= beganAt)
  } finally {
    await runtime?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('shutdown closes a slow request body and releases its owned store lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-bridge-shutdown-'))
  const token = 'shutdown-test-token'
  const client = clientA
  const config = await parseBridgeServerConfig({
    schemaVersion: 1, resource: 'https://search.bridge.test/mcp/search', bindHost: '127.0.0.1', port: 0,
    dataDir: join(root, 'data'), trustedProxyCidrs: [], allowedOrigins: ['https://chatgpt.com'],
    clients: [{ clientId: client, tokenSha256: sha(token), clientCidrs: ['127.0.0.1/32'], grants: ['read'] }],
  })
  const server = await createBridgeServer(config)
  const scope = createBridgeScope({ clientInstanceId: client, conversationId: conversationA, canonicalPath: resolve(root) })
  let request: ReturnType<typeof httpRequest> | undefined
  try {
    const clientClosed = new Promise<void>((resolvePromise) => {
      request = httpRequest({
        host: '127.0.0.1', port: server.address.port, method: 'POST', path: '/mcp/search',
        headers: { host: 'search.bridge.test', origin: 'https://chatgpt.com', authorization: `Bearer ${token}`, 'content-length': '4096', 'content-type': 'application/json' },
      })
      request.once('error', () => resolvePromise())
      request.once('close', () => resolvePromise())
      request.flushHeaders()
      request.write(JSON.stringify(requestBody(scope, randomUUID(), { action: 'status' })).slice(0, 20))
    })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40))
    await server.close()
    await clientClosed
    const reopened = await BridgeStore.open(config)
    await reopened.close()
  } finally {
    request?.destroy()
    await server.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

test('listen failure releases the second server owner lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-bridge-listen-'))
  const token = 'listen-test-token'
  const client = clientA
  const base = {
    schemaVersion: 1,
    resource: 'https://search.bridge.test/mcp/search',
    bindHost: '127.0.0.1',
    port: 0,
    trustedProxyCidrs: [],
    allowedOrigins: ['https://chatgpt.com'],
    clients: [{ clientId: client, tokenSha256: sha(token), clientCidrs: ['127.0.0.1/32'], grants: ['read'] }],
  }
  const firstConfig = await parseBridgeServerConfig({ ...base, dataDir: join(root, 'first-data') })
  const first = await createBridgeServer(firstConfig)
  const secondConfig = await parseBridgeServerConfig({ ...base, port: first.address.port, dataDir: join(root, 'second-data') })
  try {
    await assert.rejects(createBridgeServer(secondConfig))
    const reopened = await BridgeStore.open(secondConfig)
    await reopened.close()
  } finally {
    await first.close()
    await rm(root, { recursive: true, force: true })
  }
})
