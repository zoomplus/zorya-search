import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { BridgeClientError, type BridgeHttpClient } from '../../src/bridge/client.js'
import { BridgeContractError, type BridgeRequest, type BridgeResponse } from '../../src/bridge/protocol.js'
import { createBridgeMcpServer, runBridgeMcpStdio } from '../../src/bridge/mcp.js'
import { SEARCH_MCP_TOOL_CONTRACTS as extractedContracts } from '../../src/mcp/contracts.js'
import { SEARCH_MCP_TOOL_CONTRACTS as serverContracts } from '../../src/mcp/server.js'
import { bindCurrentWorkspace } from '../../src/bridge/workspace.js'

const clientInstanceId = '4d1237be-9821-4b95-9079-b77d935bbf01'
const threadId = '37cc2038-70ef-41f1-ae10-48cd6d936799'
const threadId2 = '97cc2038-70ef-41f1-ae10-48cd6d936799'
const roots: string[] = []
const originalCwd = process.cwd()

interface FakeOptions {
  request?: (request: BridgeRequest, signal?: AbortSignal) => Promise<BridgeResponse>
  synchronize?: (options: Parameters<BridgeHttpClient['synchronizeWorkspace']>[0]) => Promise<Awaited<ReturnType<BridgeHttpClient['synchronizeWorkspace']>>>
}

function fakeClient(options: FakeOptions = {}): BridgeHttpClient {
  return {
    request: options.request ?? (async (request) => {
      if (request.action === 'status') return {
        schemaVersion: 1, operationId: request.operationId, scope: request.scope,
        action: 'status', ok: true, generation: 1, manifestHash: 'a'.repeat(64), state: 'ready', activeOperations: 0,
      }
      throw new Error(`unexpected request ${request.action}`)
    }),
    synchronizeWorkspace: options.synchronize ?? (async ({ snapshot }) => ({
      scope: snapshot.scope, generation: 2, manifestHash: snapshot.manifest.manifestHash,
      alreadyCurrent: false, operationId: randomUUID(),
    })),
  } as unknown as BridgeHttpClient
}

async function setup(files: Record<string, string> = { 'src/a.ts': 'export const a = 1\r\n' }) {
  const cwd = await mkdtemp(join(tmpdir(), 'zorya-bridge-mcp-'))
  roots.push(cwd)
  for (const [path, body] of Object.entries(files)) {
    const absolute = join(cwd, path)
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, body)
  }
  process.chdir(cwd)
  return cwd
}

function nativeMeta(id = threadId, alias?: string) {
  return {
    'x-codex-turn-metadata': { thread_id: id },
    ...(alias === undefined ? {} : { threadId: alias }),
  }
}

async function connect(bridge: BridgeHttpClient) {
  const handle = createBridgeMcpServer({ client: bridge, clientInstanceId })
  const client = new Client({ name: 'bridge-mcp-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await handle.server.connect(serverTransport)
  await client.connect(clientTransport)
  return { handle, client }
}

function callMeta(id = threadId, alias?: string) { return nativeMeta(id, alias) }

function toolResult(request: Extract<BridgeRequest, { action: 'call' }>, result: Record<string, unknown> = { content: [{ type: 'text', text: 'ok' }] }): BridgeResponse {
  const provenance = request.generation === null
    ? { kind: 'source_free' as const, scope: request.scope, projectFilesIncluded: false as const, localVerification: 'not_performed' as const }
    : { kind: 'analytical_snapshot' as const, scope: request.scope, generation: request.generation, manifestHash: request.expectedManifestHash! }
  return {
    schemaVersion: 1, operationId: request.operationId, scope: request.scope, action: 'call', ok: true,
    generation: request.generation, expectedManifestHash: request.expectedManifestHash,
    manifestHash: request.expectedManifestHash, provenance,
    result: { kind: 'tool_result', result },
  } as BridgeResponse
}

test.afterEach(async () => {
  if (process.cwd() !== originalCwd) process.chdir(originalCwd)
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

test('legacy server module re-exports the extracted tool contract object', () => {
  assert.deepEqual(Object.keys(extractedContracts), Object.keys(serverContracts))
  assert.equal(extractedContracts, serverContracts)
})

test('initialize and tools/list register only local known contracts without bridge or workspace reads', async () => {
  const calls: BridgeRequest[] = []
  const { handle, client } = await connect(fakeClient({ request: async (request) => { calls.push(request); throw new Error('unexpected bridge access') } }))
  try {
    const listed = await client.listTools()
    assert.deepEqual(new Set(listed.tools.map((tool) => tool.name)), new Set(Object.keys(extractedContracts)))
    assert.deepEqual(calls, [])
  } finally { await client.close(); await handle.close() }
})

test('stdio runner accepts an injected transport for in-memory adapter tests', async () => {
  const bridge = fakeClient({ request: async () => { throw new Error('tools/list must remain local') } })
  const client = new Client({ name: 'bridge-runner-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const handle = await runBridgeMcpStdio({ client: bridge, clientInstanceId, transport: serverTransport })
  try {
    await client.connect(clientTransport)
    const listed = await client.listTools()
    assert.deepEqual(new Set(listed.tools.map((tool) => tool.name)), new Set(Object.keys(extractedContracts)))
  } finally { await client.close(); await handle.close() }
})

test('all source-free tools forward with null snapshot and never synchronize workspace files', async () => {
  await setup({ 'src/a.ts': 'secret must not be scanned here' })
  const calls: BridgeRequest[] = []
  const bridge = fakeClient({
    request: async (request) => {
      calls.push(request)
      if (request.action === 'call') return toolResult(request, { content: [{ type: 'text', text: 'capabilities' }] })
      throw new Error(`unexpected ${request.action}`)
    },
    synchronize: async () => { throw new Error('must not synchronize') },
  })
  const { handle, client } = await connect(bridge)
  try {
    const cases = [
      ['list_roots', {}], ['capabilities', {}], ['index_status', { rootId: 'workspace' }],
      ['project_text_status', { rootId: 'workspace' }],
      ['cancel_indexing', { rootId: 'workspace', jobId: threadId }],
      ['search_web', { query: 'caller query' }], ['read_web_source', { url: 'https://example.com/source' }],
      ['classify', { text: 'sample', labels: ['a', 'b'], criteria: 'Use the provided criteria' }],
      ['search_visual_references', {
        references: [{ id: 'ref', contentHash: 'a'.repeat(64), text: 'reference' }], queryText: 'query',
      }],
    ] as const
    for (const [name, args] of cases) {
      const result = await client.callTool({ name, arguments: args, _meta: callMeta() })
      assert.notEqual(result.isError, true, name)
      assert.equal((result._meta as Record<string, unknown>)['zorya-search/bridge'] !== undefined, true, name)
    }
    assert.deepEqual(calls.map(({ action }) => action), cases.map(() => 'call'))
    for (const request of calls) {
      const call = request as Extract<BridgeRequest, { action: 'call' }>
      assert.equal(call.generation, null)
      assert.equal(call.expectedManifestHash, null)
    }
    assert.deepEqual(calls.map((request) => (request as Extract<BridgeRequest, { action: 'call' }>).toolName), cases.map(([name]) => name))
    assert.deepEqual(calls.map((request) => (request as Extract<BridgeRequest, { action: 'call' }>).arguments), cases.map(([, args]) => args))
    assert.equal(calls[0]?.scope.conversationId, threadId)
  } finally { await client.close(); await handle.close() }
})

test('missing, invalid, and conflicting native conversation metadata refuse before bridge activity', async () => {
  await setup()
  let requests = 0
  const { handle, client } = await connect(fakeClient({ request: async () => { requests += 1; throw new Error('unexpected') } }))
  try {
    const missing = await client.callTool({ name: 'capabilities', arguments: {} })
    const invalid = await client.callTool({ name: 'capabilities', arguments: {}, _meta: nativeMeta('not-a-uuid') })
    const conflict = await client.callTool({ name: 'capabilities', arguments: {}, _meta: callMeta(threadId, threadId2) })
    for (const result of [missing, invalid, conflict]) {
      assert.equal(result.isError, true)
      assert.match(JSON.stringify(result), /CONVERSATION_UNRESOLVED|SCOPE_MISMATCH/u)
    }
    assert.equal(requests, 0)
  } finally { await client.close(); await handle.close() }
})

test('wrong root and malformed schema fail locally before sync or bridge calls', async () => {
  await setup()
  let requests = 0
  const bridge = fakeClient({ request: async () => { requests += 1; throw new Error('unexpected') }, synchronize: async () => { requests += 1; throw new Error('unexpected') } })
  const { handle, client } = await connect(bridge)
  try {
    const wrongRoot = await client.callTool({ name: 'index_repository', arguments: { rootId: 'other' }, _meta: callMeta() })
    assert.equal(wrongRoot.isError, true)
    assert.match(JSON.stringify(wrongRoot), /ROOT_NOT_AUTHORIZED/u)
    const malformed = await client.callTool({ name: 'index_repository', arguments: { rootId: 'workspace', extra: true }, _meta: callMeta() })
    assert.equal(malformed.isError, true)
    assert.equal(requests, 0)
  } finally { await client.close(); await handle.close() }
})

test('index operation synchronizes first then forwards the original tool arguments', async () => {
  const cwd = await setup({ 'src/a.ts': 'export const a=1\n' })
  let snapshotHash = ''
  const calls: BridgeRequest[] = []
  const bridge = fakeClient({
    synchronize: async ({ workspace, snapshot }) => {
      snapshotHash = snapshot.manifest.manifestHash
      assert.equal(workspace.canonicalPath, await realpath(cwd))
      return { scope: snapshot.scope, generation: 3, manifestHash: snapshotHash, alreadyCurrent: false, operationId: randomUUID() }
    },
    request: async (request) => {
      calls.push(request)
      if (request.action === 'call') return toolResult(request, { content: [{ type: 'text', text: 'indexed' }], structuredContent: { indexed: true } })
      throw new Error(`unexpected ${request.action}`)
    },
  })
  const { handle, client } = await connect(bridge)
  try {
    const result = await client.callTool({ name: 'index_repository', arguments: { rootId: 'workspace' }, _meta: callMeta() })
    assert.deepEqual(calls.map((call) => call.action), ['call'])
    const call = calls[0] as Extract<BridgeRequest, { action: 'call' }>
    assert.equal(call.generation, 3)
    assert.equal(call.expectedManifestHash, snapshotHash)
    assert.deepEqual(call.arguments, { rootId: 'workspace' })
    assert.deepEqual(result.structuredContent, { indexed: true })
  } finally { await client.close(); await handle.close() }
})

test('snapshot reads require a current local manifest and preserve nested result data plus additive provenance', async () => {
  const cwd = await setup({ 'src/a.ts': 'export const a=1\n' })
  const workspace = await bindCurrentWorkspace({ clientInstanceId, call: { _meta: nativeMeta(), threadId } })
  const hash = (await workspace.scan()).manifest.manifestHash
  const calls: BridgeRequest[] = []
  const sourceContent = [
    { type: 'text', text: 'unchanged body' },
    { type: 'image', data: 'AA==', mimeType: 'image/png' },
  ]
  const bridge = fakeClient({
    request: async (request) => {
      calls.push(request)
      if (request.action === 'status') return {
        schemaVersion: 1, operationId: request.operationId, scope: request.scope, action: 'status', ok: true,
        generation: 4, manifestHash: hash, state: 'ready', activeOperations: 0,
      }
      if (request.action === 'call') return toolResult(request, {
        content: sourceContent, structuredContent: { nested: { exact: [1, 2, 3] } }, isError: true,
        _meta: { original: 'metadata' }, recovery: { hint: 'keep' },
      })
      throw new Error(`unexpected ${request.action}`)
    },
  })
  const { handle, client } = await connect(bridge)
  try {
    const result = await client.callTool({ name: 'search_code', arguments: { rootId: 'workspace', query: 'value' }, _meta: callMeta() })
    assert.deepEqual(calls.map((call) => call.action), ['status', 'call'])
    assert.deepEqual(result.content, sourceContent)
    assert.deepEqual(result.structuredContent, { nested: { exact: [1, 2, 3] } })
    assert.equal(result.isError, true)
    assert.equal((result as unknown as { recovery: unknown }).recovery !== undefined, true)
    assert.deepEqual((result._meta as Record<string, unknown>).original, 'metadata')
    const bridgeProvenance = (result._meta as Record<string, unknown>)['zorya-search/bridge'] as Record<string, unknown>
    assert.equal(bridgeProvenance.origin, 'bound_current_workspace')
    assert.equal(bridgeProvenance.localVerification, 'manifest_matched')
    assert.equal(bridgeProvenance.localManifestHash, hash)
    assert.equal(await realpath(process.cwd()), await realpath(cwd))
  } finally { await client.close(); await handle.close() }
})

test('read source changes after delegated call produce typed stale refusal', async () => {
  const cwd = await setup({ 'src/a.ts': 'export const a=1\n' })
  const workspace = await bindCurrentWorkspace({ clientInstanceId, call: { _meta: nativeMeta(), threadId } })
  const hash = (await workspace.scan()).manifest.manifestHash
  let changed = false
  const bridge = fakeClient({ request: async (request) => {
    if (request.action === 'status') return {
      schemaVersion: 1, operationId: request.operationId, scope: request.scope, action: 'status', ok: true,
      generation: 4, manifestHash: hash, state: 'ready', activeOperations: 0,
    }
    if (request.action === 'call') {
      if (!changed) { changed = true; await writeFile(join(cwd, 'src/a.ts'), 'export const a=2\n') }
      return toolResult(request)
    }
    throw new Error(`unexpected ${request.action}`)
  } })
  const { handle, client } = await connect(bridge)
  try {
    const result = await client.callTool({ name: 'read_source', arguments: { rootId: 'workspace', path: 'src/a.ts', lineStart: 1 }, _meta: callMeta() })
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), /STALE_GENERATION/u)
  } finally { await client.close(); await handle.close() }
})

test('indexing results are fenced after the delegated runtime call', async () => {
  const cwd = await setup({ 'src/a.ts': 'export const a=1\n' })
  const calls: BridgeRequest[] = []
  const bridge = fakeClient({
    synchronize: async ({ snapshot }) => ({
      scope: snapshot.scope, generation: 3, manifestHash: snapshot.manifest.manifestHash,
      alreadyCurrent: false, operationId: randomUUID(),
    }),
    request: async (request) => {
      calls.push(request)
      if (request.action === 'call') {
        await writeFile(join(cwd, 'src/a.ts'), 'export const a=2\n')
        return toolResult(request, { content: [{ type: 'text', text: 'index started' }] })
      }
      throw new Error(`unexpected ${request.action}`)
    },
  })
  const { handle, client } = await connect(bridge)
  try {
    const result = await client.callTool({ name: 'start_indexing', arguments: { rootId: 'workspace' }, _meta: callMeta() })
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), /STALE_GENERATION/u)
    assert.equal(calls.length, 1)
  } finally { await client.close(); await handle.close() }
})

test('every source-consuming index operation syncs before forwarding its unchanged arguments', async () => {
  await setup({ 'src/a.ts': 'export const a=1\n' })
  const syncs: string[] = []
  const calls: Array<Extract<BridgeRequest, { action: 'call' }>> = []
  const cases = [
    ['index_repository', { rootId: 'workspace' }],
    ['start_indexing', { rootId: 'workspace' }],
    ['index_code_symbols', { rootId: 'workspace' }],
    ['index_project_text', { rootId: 'workspace' }],
  ] as const
  const bridge = fakeClient({
    synchronize: async ({ snapshot }) => {
      syncs.push(snapshot.manifest.manifestHash)
      return { scope: snapshot.scope, generation: syncs.length, manifestHash: snapshot.manifest.manifestHash, alreadyCurrent: false, operationId: randomUUID() }
    },
    request: async (request) => {
      if (request.action !== 'call') throw new Error(`unexpected ${request.action}`)
      calls.push(request)
      return toolResult(request)
    },
  })
  const { handle, client } = await connect(bridge)
  try {
    for (const [name, args] of cases) {
      const previousSyncCount = syncs.length
      await client.callTool({ name, arguments: args, _meta: callMeta() })
      assert.equal(syncs.length, previousSyncCount + 1, name)
      assert.deepEqual(calls.at(-1)?.arguments, args, name)
      assert.equal(calls.at(-1)?.generation, previousSyncCount + 1, name)
      assert.equal(calls.at(-1)?.expectedManifestHash, syncs.at(-1), name)
    }
  } finally { await client.close(); await handle.close() }
})

test('protocol errors preserve their MCP code, message, and data', async () => {
  await setup()
  const bridge = fakeClient({ request: async (request) => {
    if (request.action !== 'call') throw new Error(`unexpected ${request.action}`)
    return {
      schemaVersion: 1, operationId: request.operationId, scope: request.scope, action: 'call', ok: true,
      generation: null, expectedManifestHash: null, manifestHash: null,
      provenance: { kind: 'source_free', scope: request.scope, projectFilesIncluded: false, localVerification: 'not_performed' },
      result: { kind: 'protocol_error', error: { code: -32602, message: 'original protocol error', data: { marker: 'kept' } } },
    }
  } })
  const { handle, client } = await connect(bridge)
  try {
    const result = await client.callTool({ name: 'capabilities', arguments: {}, _meta: callMeta() })
    assert.equal(result.isError, true)
    assert.equal(result.content[0]?.type, 'text')
    const expectedError = { kind: 'protocol_error', code: -32602, message: 'original protocol error', data: { marker: 'kept' } }
    assert.deepEqual(result.structuredContent, { error: expectedError })
    assert.deepEqual(JSON.parse(result.content[0]?.text ?? ''), { error: expectedError })
    const bridgeMeta = (result._meta as Record<string, unknown>)['zorya-search/bridge'] as Record<string, unknown>
    assert.deepEqual(bridgeMeta.upstreamProtocolError, { code: -32602, message: 'original protocol error', data: { marker: 'kept' } })
  } finally { await client.close(); await handle.close() }
})

test('existing reserved bridge metadata is rejected instead of silently overwritten', async () => {
  await setup()
  const bridge = fakeClient({ request: async (request) => {
    if (request.action !== 'call') throw new Error(`unexpected ${request.action}`)
    return toolResult(request, { content: [{ type: 'text', text: 'upstream' }], _meta: { 'zorya-search/bridge': { forged: true } } })
  } })
  const { handle, client } = await connect(bridge)
  try {
    const result = await client.callTool({ name: 'capabilities', arguments: {}, _meta: callMeta() })
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), /UPSTREAM_PROTOCOL_ERROR/u)
  } finally { await client.close(); await handle.close() }
})

test('call cancellation targets exact delegated operation and close drains until settlement', async () => {
  await setup()
  let target: string | undefined
  let callOperation: string | undefined
  let cancelRequest: Extract<BridgeRequest, { action: 'cancel' }> | undefined
  let release: (() => void) | undefined
  const bridge = fakeClient({ request: (request, signal) => {
    if (request.action === 'call') {
      callOperation = request.operationId
      return new Promise((_, reject) => {
      release = () => reject(new BridgeClientError('CANCELLED', 'cancelled'))
      signal?.addEventListener('abort', () => release?.(), { once: true })
      })
    }
    if (request.action === 'cancel') {
      cancelRequest = request
      target = request.targetOperationId
      return Promise.resolve({
        schemaVersion: 1, operationId: request.operationId, scope: request.scope, action: 'cancel', ok: true,
        targetGeneration: request.targetGeneration, expectedManifestHash: request.expectedManifestHash,
        targetOperationId: request.targetOperationId, settled: true,
      })
    }
    throw new Error(`unexpected ${request.action}`)
  } })
  const { handle, client } = await connect(bridge)
  const pending = client.callTool({ name: 'capabilities', arguments: {}, _meta: callMeta() })
  await new Promise((resolve) => setTimeout(resolve, 10))
  await handle.close()
  const result = await pending
  assert.equal(result.isError, true)
  assert.ok(target)
  assert.equal(target, callOperation)
  assert.equal(cancelRequest?.targetGeneration, null)
  assert.equal(cancelRequest?.expectedManifestHash, null)
  await client.close()
})

test('lost bridge call acknowledgement is cancelled by exact operation and reports unconfirmed settlement', async () => {
  await setup()
  let callRequest: Extract<BridgeRequest, { action: 'call' }> | undefined
  let cancelRequest: Extract<BridgeRequest, { action: 'cancel' }> | undefined
  const bridge = fakeClient({ request: async (request) => {
    if (request.action === 'call') {
      callRequest = request
      throw new BridgeClientError('UPSTREAM_PROTOCOL_ERROR', 'transport response was lost')
    }
    if (request.action === 'cancel') {
      cancelRequest = request
      return {
        schemaVersion: 1, operationId: request.operationId, scope: request.scope, action: 'cancel', ok: true,
        targetGeneration: request.targetGeneration, expectedManifestHash: request.expectedManifestHash,
        targetOperationId: request.targetOperationId, settled: false,
      }
    }
    throw new Error(`unexpected ${request.action}`)
  } })
  const { handle, client } = await connect(bridge)
  try {
    const result = await client.callTool({ name: 'capabilities', arguments: {}, _meta: callMeta() })
    assert.equal(result.isError, true)
    assert.equal(cancelRequest?.targetOperationId, callRequest?.operationId)
    assert.equal(cancelRequest?.scope.conversationId, callRequest?.scope.conversationId)
    assert.equal(cancelRequest?.targetGeneration, null)
    assert.equal(cancelRequest?.expectedManifestHash, null)
    assert.match(JSON.stringify(result), /settlement.*unconfirmed/u)
  } finally { await client.close(); await handle.close() }
})
