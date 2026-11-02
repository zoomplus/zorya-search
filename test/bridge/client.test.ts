import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  BridgeClientError,
  createBridgeHttpClient,
  BRIDGE_CLIENT_DEFAULT_REQUEST_TIMEOUT_MS,
  BRIDGE_CLIENT_MAX_RESPONSE_BYTES,
} from '../../src/bridge/client.js'
import type { BridgeClientConfig } from '../../src/bridge/config.js'
import {
  BRIDGE_MAX_CHUNK_BYTES,
  BridgeContractError,
  type BridgeRequest,
  type BridgeResponse,
} from '../../src/bridge/protocol.js'
import { bindCurrentWorkspace } from '../../src/bridge/workspace.js'

const token = 'bridge-test-token-value-123'
const tokenEnv = 'ZORYA_BRIDGE_TEST_TOKEN'
const clientId = '4d1237be-9821-4b95-9079-b77d935bbf01'
const threadId = '37cc2038-70ef-41f1-ae10-48cd6d936799'
const roots: string[] = []
const originalCwd = process.cwd()
const priorEnv = process.env[tokenEnv]

test.afterEach(async () => {
  if (process.cwd() !== originalCwd) process.chdir(originalCwd)
  if (priorEnv === undefined) delete process.env[tokenEnv]
  else process.env[tokenEnv] = priorEnv
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'zorya-bridge-client-'))
  roots.push(path)
  await mkdir(join(path, 'src'), { recursive: true })
  return path
}

function config(credential: BridgeClientConfig['credential'] = { kind: 'env', name: tokenEnv }): BridgeClientConfig {
  return {
    schemaVersion: 1,
    endpoint: 'https://bridge.example/mcp/search',
    clientId,
    stateDir: join(tmpdir(), 'zorya-bridge-client-state'),
    credential,
  }
}

async function client(fetcher: typeof fetch, credential?: BridgeClientConfig['credential'], allowedDocumentPaths?: string[]) {
  process.env[tokenEnv] = token
  return createBridgeHttpClient({ config: config(credential), fetch: fetcher, ...(allowedDocumentPaths ? { allowedDocumentPaths } : {}) })
}

async function boundWithFile(name: string, contents: string | Uint8Array = 'export const value = 1') {
  const workspacePath = await root()
  await writeFile(join(workspacePath, 'src', name), contents)
  process.chdir(workspacePath)
  const workspace = await bindCurrentWorkspace({
    clientInstanceId: clientId,
    call: { _meta: { 'x-codex-turn-metadata': { thread_id: threadId } }, threadId },
  })
  return { workspace, snapshot: await workspace.scan(), workspacePath }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function requestBody(init: RequestInit): BridgeRequest {
  return JSON.parse(String(init.body)) as BridgeRequest
}

function statusResponse(request: BridgeRequest, generation: number | null, manifestHash: string | null): BridgeResponse {
  return {
    schemaVersion: 1, operationId: request.operationId, scope: request.scope,
    action: 'status', ok: true, generation, manifestHash,
    state: generation === null ? 'empty' : 'ready', activeOperations: 0,
  }
}

function planResponse(
  request: Extract<BridgeRequest, { action: 'plan' }>,
  generation: number | null,
  currentHash: string | null,
  missingFiles: Array<{ path: string; sha256: string; bytes: number }>,
  alreadyCurrent = false,
): BridgeResponse {
  return {
    schemaVersion: 1, operationId: request.operationId, scope: request.scope,
    action: 'plan', ok: true, expectedManifestHash: request.manifest.manifestHash,
    generation, manifestHash: currentHash, uploadId: request.operationId,
    alreadyCurrent, missingFiles, maxChunkBytes: BRIDGE_MAX_CHUNK_BYTES,
  }
}

function putResponse(request: Extract<BridgeRequest, { action: 'put' }>, complete: boolean): BridgeResponse {
  const length = Buffer.from(request.dataBase64, 'base64').byteLength
  return {
    schemaVersion: 1, operationId: request.operationId, scope: request.scope,
    action: 'put', ok: true, baseGeneration: request.baseGeneration,
    expectedManifestHash: request.expectedManifestHash, path: request.path,
    receivedBytes: request.offset + length, complete,
  }
}

function cancelResponse(request: Extract<BridgeRequest, { action: 'cancel' }>, settled: boolean): BridgeResponse {
  return {
    schemaVersion: 1, operationId: request.operationId, scope: request.scope,
    action: 'cancel', ok: true, targetGeneration: request.targetGeneration,
    expectedManifestHash: request.expectedManifestHash, targetOperationId: request.targetOperationId,
    settled,
  }
}

function commitResponse(request: Extract<BridgeRequest, { action: 'commit' }>, generation: number): BridgeResponse {
  const hash = request.expectedManifestHash
  return {
    schemaVersion: 1, operationId: request.operationId, scope: request.scope,
    action: 'commit', ok: true, expectedManifestHash: hash, generation, manifestHash: hash,
    provenance: { kind: 'analytical_snapshot', scope: request.scope, generation, manifestHash: hash },
  }
}

test('credential loading rejects missing or malformed values and keeps authorization failures secret-free', async () => {
  delete process.env[tokenEnv]
  await assert.rejects(createBridgeHttpClient({ config: config(), fetch: async () => { throw new Error(token) } }), (error: unknown) =>
    error instanceof BridgeContractError && error.code === 'AUTH' && !error.message.includes(token))

  process.env[tokenEnv] = `${token}\nleak`
  await assert.rejects(createBridgeHttpClient({ config: config(), fetch: async () => { throw new Error(token) } }), (error: unknown) =>
    error instanceof BridgeContractError && error.code === 'AUTH' && !String(error.stack).includes(token))

  const unauthorized = await client(async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`)
    assert.equal(init?.redirect, 'error')
    return new Response(token, { status: 401 })
  })
  const scopeFixture = await boundWithFile('auth.ts')
  const req: BridgeRequest = { schemaVersion: 1, operationId: randomUUID(), scope: scopeFixture.workspace.scope, action: 'status' }
  await assert.rejects(unauthorized.request(req), (error: unknown) =>
    error instanceof BridgeContractError && error.code === 'AUTH' && !String(error.stack).includes(token))

  const denied = await client(async () => new Response(token, { status: 403 }))
  await assert.rejects(denied.request(req), (error: unknown) =>
    error instanceof BridgeContractError && error.code === 'AUTH' && !String(error.stack).includes(token))
})

test('credential can be loaded from a bounded private file without surfacing its value', async () => {
  const secretPath = join(tmpdir(), `zorya-bridge-secret-${randomUUID()}`)
  roots.push(secretPath)
  await writeFile(secretPath, `${token}\n`, { mode: 0o600 })
  await chmod(secretPath, 0o600)
  const seen: string[] = []
  const bridge = await client(async (_url, init) => {
    seen.push(new Headers(init?.headers).get('authorization') ?? '')
    const req = requestBody(init!)
    return json(statusResponse(req, null, null))
  }, { kind: 'file', path: secretPath })
  const fixture = await boundWithFile('credential.ts')
  await bridge.request({ schemaVersion: 1, operationId: randomUUID(), scope: fixture.workspace.scope, action: 'status' })
  assert.deepEqual(seen, [`Bearer ${token}`])

  await writeFile(secretPath, Buffer.alloc(16_385, 97), { mode: 0o600 })
  await assert.rejects(createBridgeHttpClient({ config: config({ kind: 'file', path: secretPath }), fetch: fetch }), (error: unknown) =>
    error instanceof BridgeContractError && ['AUTH', 'CONFIG_INVALID'].includes(error.code) && !String(error.stack).includes(token))
})

test('redirects, malformed, oversized, and identity-mismatched responses fail without exposing credentials', async () => {
  assert.equal(BRIDGE_CLIENT_DEFAULT_REQUEST_TIMEOUT_MS, 120_000)
  const fixture = await boundWithFile('response.ts')
  const request: BridgeRequest = { schemaVersion: 1, operationId: randomUUID(), scope: fixture.workspace.scope, action: 'status' }
  const redirectClient = await client(async () => new Response(token, { status: 302, headers: { location: `https://other.invalid/${token}` } }))
  await assert.rejects(redirectClient.request(request), (error: unknown) =>
    error instanceof BridgeContractError && error.code === 'UPSTREAM_PROTOCOL_ERROR' && !String(error.stack).includes(token))

  const malformedClient = await client(async () => new Response(token, { status: 200 }))
  await assert.rejects(malformedClient.request(request), (error: unknown) =>
    error instanceof BridgeContractError && error.code === 'UPSTREAM_PROTOCOL_ERROR' && !String(error.stack).includes(token))

  const largeClient = await client(async () => new Response(new Uint8Array(BRIDGE_CLIENT_MAX_RESPONSE_BYTES + 1)))
  await assert.rejects(largeClient.request(request), (error: unknown) =>
    error instanceof BridgeContractError && error.code === 'UPSTREAM_PROTOCOL_ERROR' && !String(error.stack).includes(token))

  process.env[tokenEnv] = token
  const oversizedHangingCancelClient = await createBridgeHttpClient({
    config: config(),
    fetch: async () => {
      setTimeout(() => undefined, 40)
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(BRIDGE_CLIENT_MAX_RESPONSE_BYTES + 1)) },
        cancel: () => new Promise<void>(() => undefined),
      }))
    },
    requestTimeoutMs: 15,
  })
  const oversizedStartedAt = Date.now()
  await assert.rejects(oversizedHangingCancelClient.request(request), (error: unknown) =>
    error instanceof BridgeContractError && error.code === 'UPSTREAM_PROTOCOL_ERROR' &&
      error.message.includes('size limit') && !String(error.stack).includes(token))
  assert.ok(Date.now() - oversizedStartedAt < 1_000)

  const mismatchClient = await client(async (_url, init) => {
    const req = requestBody(init!)
    return json({ ...statusResponse(req, null, null), operationId: randomUUID() })
  })
  await assert.rejects(mismatchClient.request(request), (error: unknown) =>
    error instanceof BridgeContractError && error.code === 'UPSTREAM_PROTOCOL_ERROR' && !String(error.stack).includes(token))

  const echoedCredentialClient = await client(async (_url, init) => {
    const req = requestBody(init!)
    return json({ ...statusResponse(req, null, null), unexpected: token })
  })
  await assert.rejects(echoedCredentialClient.request(request), (error: unknown) =>
    error instanceof BridgeContractError && error.code === 'UPSTREAM_PROTOCOL_ERROR' && !String(error.stack).includes(token))

  const typed400Client = await client(async (_url, init) => {
    const req = requestBody(init!)
    return new Response(JSON.stringify({
      schemaVersion: 1, operationId: req.operationId, scope: req.scope, action: 'status',
      ok: false, generation: null, manifestHash: null, expectedManifestHash: null,
      error: { code: 'AUTH', message: 'typed rejection' },
    }), { status: 400, headers: { 'content-type': 'application/json' } })
  })
  const typedError = await typed400Client.request(request)
  assert.equal(typedError.ok, false)
  if (typedError.ok) assert.fail('expected a typed HTTP 400 response')
  assert.equal(typedError.error.code, 'AUTH')

  const timedClient = await createBridgeHttpClient({
    config: config(),
    fetch: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      setTimeout(() => undefined, 40)
    }),
    requestTimeoutMs: 15,
  })
  await assert.rejects(timedClient.request(request), (error: unknown) =>
    error instanceof BridgeContractError && error.code === 'UPSTREAM_PROTOCOL_ERROR' && !String(error.stack).includes(token))

  const hangingBodyClient = await createBridgeHttpClient({
    config: config(),
    fetch: async () => {
      setTimeout(() => undefined, 40)
      return new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
        cancel: () => new Promise<void>(() => undefined),
      }))
    },
    requestTimeoutMs: 15,
  })
  await assert.rejects(hangingBodyClient.request(request), (error: unknown) =>
    error instanceof BridgeContractError && error.code === 'UPSTREAM_PROTOCOL_ERROR' && !String(error.stack).includes(token))
})

test('synchronization uploads only plan-missing hashes with one owned operation id', async () => {
  const fixturePath = await root()
  await writeFile(join(fixturePath, 'src/unchanged.ts'), 'export const unchanged = true')
  await writeFile(join(fixturePath, 'src/changed.ts'), 'export const changed = true')
  process.chdir(fixturePath)
  const workspace = await bindCurrentWorkspace({ clientInstanceId: clientId, call: { threadId } })
  const snapshot = await workspace.scan()
  const oldHash = 'f'.repeat(64)
  const requests: BridgeRequest[] = []
  const fetcher: typeof fetch = async (_url, init) => {
    const request = requestBody(init!)
    requests.push(request)
    if (request.action === 'status') return json(statusResponse(request, 1, oldHash))
    if (request.action === 'plan') return json(planResponse(request, 1, oldHash, [snapshot.manifest.files.find((file) => file.path === 'src/changed.ts')!]))
    if (request.action === 'put') return json(putResponse(request, request.offset + Buffer.from(request.dataBase64, 'base64').length === snapshot.manifest.files.find((file) => file.path === request.path)!.bytes))
    if (request.action === 'commit') return json(commitResponse(request, 2))
    throw new Error('unexpected action')
  }
  const result = await (await client(fetcher)).synchronizeWorkspace({ workspace, snapshot })
  assert.equal(result.generation, 2)
  const puts = requests.filter((request) => request.action === 'put')
  assert.deepEqual(puts.map((request) => request.path), ['src/changed.ts'])
  assert.ok(puts.every((request) => request.action === 'put' && request.expectedBytes === snapshot.manifest.files.find((file) => file.path === request.path)?.bytes))
  const syncOperationIds = requests.filter((request) => ['plan', 'put', 'commit'].includes(request.action)).map((request) => request.operationId)
  assert.equal(new Set(syncOperationIds).size, 1)
  assert.ok(requests.every((request) => JSON.stringify(request.scope) === JSON.stringify(workspace.scope)))
  assert.equal(requests.map((request) => request.action).join(','), 'status,plan,put,commit')
})

test('synchronization preserves empty files and refuses local mutation before commit', async () => {
  const emptyFixture = await boundWithFile('empty.ts', '')
  const emptyRequests: BridgeRequest[] = []
  const emptyClient = await client(async (_url, init) => {
    const request = requestBody(init!)
    emptyRequests.push(request)
    if (request.action === 'status') return json(statusResponse(request, null, null))
    if (request.action === 'plan') return json(planResponse(request, null, null, [...emptyFixture.snapshot.manifest.files]))
    if (request.action === 'put') {
      assert.equal(request.dataBase64, '')
      assert.equal(request.offset, 0)
      return json(putResponse(request, true))
    }
    if (request.action === 'commit') return json(commitResponse(request, 1))
    throw new Error('unexpected action')
  })
  const emptyResult = await emptyClient.synchronizeWorkspace({ workspace: emptyFixture.workspace, snapshot: emptyFixture.snapshot })
  assert.equal(emptyResult.generation, 1)
  assert.ok(emptyRequests.some((request) => request.action === 'put'))

  const changed = await boundWithFile('mutate.ts')
  let commitCalled = false
  let mutationOperationId: string | undefined
  let cancellation: Extract<BridgeRequest, { action: 'cancel' }> | undefined
  const mutationClient = await client(async (_url, init) => {
    const request = requestBody(init!)
    if (request.action === 'status') return json(statusResponse(request, null, null))
    if (request.action === 'plan') {
      mutationOperationId = request.operationId
      return json(planResponse(request, null, null, [...changed.snapshot.manifest.files]))
    }
    if (request.action === 'put') {
      await writeFile(join(changed.workspacePath, 'src/mutate.ts'), 'export const value = 2')
      return json(putResponse(request, true))
    }
    if (request.action === 'cancel') {
      cancellation = request
      return json(cancelResponse(request, true))
    }
    if (request.action === 'commit') {
      commitCalled = true
      return json(commitResponse(request, 1))
    }
    throw new Error('unexpected action')
  })
  await assert.rejects(mutationClient.synchronizeWorkspace({ workspace: changed.workspace, snapshot: changed.snapshot }), (error: unknown) =>
    error instanceof BridgeContractError && error.code === 'STALE_GENERATION')
  assert.equal(commitCalled, false)
  assert.equal(cancellation?.targetOperationId, mutationOperationId)
})

test('aborted synchronization cancels only its exact operation and marks unsettled cancellation uncertain', async () => {
  const fixture = await boundWithFile('cancel.ts')
  const controller = new AbortController()
  let planOperationId: string | undefined
  let cancelRequest: Extract<BridgeRequest, { action: 'cancel' }> | undefined
  const fetcher: typeof fetch = async (_url, init) => {
    const request = requestBody(init!)
    if (request.action === 'status') return json(statusResponse(request, null, null))
    if (request.action === 'plan') {
      planOperationId = request.operationId
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        setTimeout(() => controller.abort(), 5)
      })
    }
    if (request.action === 'cancel') {
      cancelRequest = request
      return json(cancelResponse(request, false))
    }
    throw new Error('unexpected action')
  }
  const bridge = await client(fetcher)
  await assert.rejects(bridge.synchronizeWorkspace({ ...fixture, signal: controller.signal }), (error: unknown) =>
    error instanceof BridgeClientError && error.code === 'CANCELLED' && error.settlement === 'unconfirmed' &&
      error.originalError instanceof BridgeContractError && error.originalError.code === 'CANCELLED' && !String(error.stack).includes(token))
  assert.equal(cancelRequest?.targetOperationId, planOperationId)
  assert.ok(cancelRequest)
})

test('a lost commit response remains publication-uncertain even when cancellation reports settled', async () => {
  const fixture = await boundWithFile('lost-commit.ts')
  let planOperationId: string | undefined
  let commitSent = false
  let cancellation: Extract<BridgeRequest, { action: 'cancel' }> | undefined
  const bridge = await client(async (_url, init) => {
    const request = requestBody(init!)
    if (request.action === 'status') return json(statusResponse(request, null, null))
    if (request.action === 'plan') {
      planOperationId = request.operationId
      return json(planResponse(request, null, null, [...fixture.snapshot.manifest.files]))
    }
    if (request.action === 'put') return json(putResponse(request, true))
    if (request.action === 'commit') {
      commitSent = true
      throw new Error(token)
    }
    if (request.action === 'cancel') {
      cancellation = request
      return json(cancelResponse(request, true))
    }
    throw new Error('unexpected action')
  })
  await assert.rejects(bridge.synchronizeWorkspace(fixture), (error: unknown) =>
    error instanceof BridgeClientError && error.publication === 'unconfirmed' && error.settlement === undefined &&
      error.originalError instanceof BridgeContractError && error.originalError.code === 'UPSTREAM_PROTOCOL_ERROR' &&
      !String(error.stack).includes(token))
  assert.equal(commitSent, true)
  assert.equal(cancellation?.targetOperationId, planOperationId)
})

test('already-current plan is a no-op and does not request cancellation', async () => {
  const fixture = await boundWithFile('current.ts')
  let planSeen = false
  let cancelSeen = false
  const bridge = await client(async (_url, init) => {
    const request = requestBody(init!)
    if (request.action === 'status') return json(statusResponse(request, 3, fixture.snapshot.manifest.manifestHash))
    if (request.action === 'plan') {
      planSeen = true
      return json(planResponse(request, 3, fixture.snapshot.manifest.manifestHash, [], true))
    }
    if (request.action === 'cancel') cancelSeen = true
    throw new Error('unexpected action')
  })
  const result = await bridge.synchronizeWorkspace(fixture)
  assert.equal(result.alreadyCurrent, true)
  assert.equal(planSeen, true)
  assert.equal(cancelSeen, false)
})

test('valid commit followed by local mutation reports committed stale state without cancellation', async () => {
  const fixture = await boundWithFile('post-commit.ts')
  let commitOperationId: string | undefined
  let cancelSeen = false
  const bridge = await client(async (_url, init) => {
    const request = requestBody(init!)
    if (request.action === 'status') return json(statusResponse(request, null, null))
    if (request.action === 'plan') return json(planResponse(request, null, null, [...fixture.snapshot.manifest.files]))
    if (request.action === 'put') return json(putResponse(request, true))
    if (request.action === 'commit') {
      commitOperationId = request.operationId
      await writeFile(join(fixture.workspacePath, 'src/post-commit.ts'), 'export const value = 2')
      return json(commitResponse(request, 1))
    }
    if (request.action === 'cancel') {
      cancelSeen = true
      return json(cancelResponse(request, false))
    }
    throw new Error('unexpected action')
  })
  await assert.rejects(bridge.synchronizeWorkspace(fixture), (error: unknown) =>
    error instanceof BridgeClientError && error.code === 'STALE_GENERATION' && error.committed === true &&
      error.message.includes('committed'))
  assert.ok(commitOperationId)
  assert.equal(cancelSeen, false)
})

test('typed HTTP 400 stale response retains its code and settles the pending plan', async () => {
  const fixture = await boundWithFile('typed-stale.ts')
  const currentHash = 'e'.repeat(64)
  let planOperationId: string | undefined
  let cancellation: Extract<BridgeRequest, { action: 'cancel' }> | undefined
  const bridge = await client(async (_url, init) => {
    const request = requestBody(init!)
    if (request.action === 'status') return json(statusResponse(request, 2, currentHash))
    if (request.action === 'plan') {
      planOperationId = request.operationId
      return new Response(JSON.stringify({
        schemaVersion: 1, operationId: request.operationId, scope: request.scope, action: 'plan', ok: false,
        generation: 2, manifestHash: currentHash, expectedManifestHash: request.manifest.manifestHash,
        error: { code: 'STALE_GENERATION', message: 'snapshot changed' },
      }), { status: 400 })
    }
    if (request.action === 'cancel') {
      cancellation = request
      return json(cancelResponse(request, true))
    }
    throw new Error('unexpected action')
  })
  await assert.rejects(bridge.synchronizeWorkspace(fixture), (error: unknown) =>
    error instanceof BridgeClientError && error.code === 'STALE_GENERATION' && error.settlement === undefined)
  assert.equal(cancellation?.targetOperationId, planOperationId)
  assert.ok(cancellation)
})

test('nested MCP tool result payload and protocol errors are preserved exactly', async () => {
  const fixture = await boundWithFile('result.ts')
  const manifestHash = 'd'.repeat(64)
  const generation = 4
  const operationId = randomUUID()
  const toolResult = {
    content: [
      { type: 'text', text: 'Error result text', annotations: { audience: ['assistant'], priority: 0.8 } },
      { type: 'image', data: 'YWJj', mimeType: 'image/png', annotations: { audience: ['user'] } },
    ],
    structuredContent: { code: 'source_changed', details: { nested: ['kept', 1] } },
    isError: true,
    extra: { untouched: true },
  }
  const bridge = await client(async (_url, init) => {
    const req = requestBody(init!)
    return json({
      schemaVersion: 1, operationId: req.operationId, scope: req.scope, action: 'call', ok: true,
      expectedManifestHash: manifestHash, generation, manifestHash,
      provenance: { kind: 'analytical_snapshot', scope: req.scope, generation, manifestHash },
      result: { kind: 'tool_result', result: toolResult },
    })
  })
  const request: BridgeRequest = {
    schemaVersion: 1, operationId, scope: fixture.workspace.scope, action: 'call',
    generation, expectedManifestHash: manifestHash, toolName: 'search', arguments: { query: 'x' },
  }
  const response = await bridge.request(request)
  assert.equal(response.action, 'call')
  if (response.action !== 'call' || !response.ok) assert.fail('expected successful call result')
  assert.deepEqual(response.result, { kind: 'tool_result', result: toolResult })
  const protocolError = {
    schemaVersion: 1, operationId: request.operationId, scope: request.scope, action: 'call',
    ok: true, expectedManifestHash: manifestHash, generation, manifestHash,
    provenance: { kind: 'analytical_snapshot', scope: request.scope, generation, manifestHash },
    result: { kind: 'protocol_error', error: { code: -32000, message: 'original protocol failure', data: { untouched: [1, 2] } } },
  }
  const protocolClient = await client(async () => json(protocolError))
  const second = await protocolClient.request(request)
  if (second.action !== 'call' || !second.ok) assert.fail('expected successful wrapper result')
  assert.deepEqual(second.result, protocolError.result)

  const sourceFreeCall = {
    schemaVersion: 1 as const, operationId: randomUUID(), scope: fixture.workspace.scope,
    action: 'call' as const, generation: null, expectedManifestHash: null,
    toolName: 'capabilities', arguments: {},
  }
  const sourceFreeClient = await client(async (_url, init) => {
    const req = requestBody(init!)
    return json({
      schemaVersion: 1, operationId: req.operationId, scope: req.scope, action: 'call', ok: true,
      generation: null, expectedManifestHash: null, manifestHash: null,
      provenance: { kind: 'source_free', scope: req.scope, projectFilesIncluded: false, localVerification: 'not_performed' },
      result: { kind: 'tool_result', result: { structuredContent: { capabilities: [] }, isError: false } },
    })
  })
  const sourceFreeResult = await sourceFreeClient.request(sourceFreeCall)
  assert.equal(sourceFreeResult.action, 'call')
  if (sourceFreeResult.action !== 'call' || !sourceFreeResult.ok) assert.fail('expected source-free call response')
  assert.equal(sourceFreeResult.provenance.kind, 'source_free')

  const sourceFreeCancel = {
    schemaVersion: 1 as const, operationId: randomUUID(), scope: fixture.workspace.scope,
    action: 'cancel' as const, targetGeneration: null, expectedManifestHash: null,
    targetOperationId: randomUUID(),
  }
  const cancelClient = await client(async (_url, init) => {
    const req = requestBody(init!)
    if (req.action !== 'cancel') throw new Error('unexpected action')
    return json(cancelResponse(req, true))
  })
  const sourceFreeCancelled = await cancelClient.request(sourceFreeCancel)
  assert.equal(sourceFreeCancelled.action, 'cancel')
  if (sourceFreeCancelled.action !== 'cancel' || !sourceFreeCancelled.ok) assert.fail('expected source-free cancellation')
  assert.equal(sourceFreeCancelled.targetGeneration, null)
  assert.equal(sourceFreeCancelled.expectedManifestHash, null)
})
