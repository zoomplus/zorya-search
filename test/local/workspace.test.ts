import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { workspaceIdForCanonicalPath } from '../../src/bridge/protocol.js'
import { openSearchRuntime } from '../../src/runtime/index.js'
import { createLocalMcpServer, createLocalMcpSharedState } from '../../src/local/mcp.js'
import { canonicalCurrentWorkspace, inspectLocalOwner, openLocalWorkspace, type LocalWorkspace } from '../../src/local/owner.js'
import { startLocalOwnerHttp } from '../../src/local/transport.js'
import { LOCAL_MAX_USER_EXCLUSIONS, LOCAL_PRIVACY_EXCLUSIONS, parseLocalConfig } from '../../src/local/config.js'
import { createSearchMcpServer } from '../../src/mcp/server.js'

const clientId = '27b54e87-8e0e-4389-9c6d-64d613a129a1'
const conversationA = 'a9a1e1bd-509e-4be3-ae61-bacd2a491d02'
const conversationB = 'b9a1e1bd-509e-4be3-ae61-bacd2a491d02'
const originalCwd = process.cwd()
const roots: string[] = []

async function workspaceFixture(name = 'local-workspace') {
  const parent = await realpath(await mkdtemp(join(tmpdir(), `${name}-`)))
  roots.push(parent)
  const project = join(parent, 'project')
  const stateDir = join(parent, 'state')
  await mkdir(project)
  process.chdir(project)
  const config = { schemaVersion: 1, clientId, stateDir, runtime: {} }
  return { parent, project, stateDir, config }
}

async function connect(workspace: LocalWorkspace) {
  const handle = await createLocalMcpServer(workspace)
  const client = new Client({ name: 'local-workspace-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await handle.server.connect(serverTransport)
  await client.connect(clientTransport)
  return { handle, client }
}

function meta(threadId: string) {
  return { 'x-codex-turn-metadata': { thread_id: threadId }, threadId }
}

test.afterEach(async () => {
  if (process.cwd() !== originalCwd) process.chdir(originalCwd)
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

test('owner binds canonical current cwd, keeps state outside workspace, and does not index on startup', async () => {
  const fixture = await workspaceFixture()
  await writeFile(join(fixture.project, 'index-me.ts'), 'export const localNeedle = "LOCAL_OWNER_NEEDLE"\n')
  process.env.PWD = join(fixture.parent, 'decoy')
  const workspace = await openLocalWorkspace({ config: fixture.config })
  try {
    assert.equal(workspace.canonicalPath, await realpath(fixture.project))
    assert.equal(workspace.runtime.listRoots().length, 1)
    assert.equal(workspace.runtime.listRoots()[0]?.id, 'workspace')
    assert.equal(workspace.runtime.listRoots()[0]?.path, await realpath(fixture.project))
    assert.ok(!workspace.dataPath.startsWith(`${fixture.project}/`))
    const before = await workspace.runtime.indexStatus({ rootId: 'workspace' })
    assert.equal(before.identity, null)
    assert.equal(before.watching, false)
  } finally {
    await workspace.close()
    delete process.env.PWD
  }
})

test('workspace lease prevents a second runtime for the same canonical workspace', async () => {
  const fixture = await workspaceFixture()
  const first = await openLocalWorkspace({ config: fixture.config })
  try {
    await assert.rejects(
      () => openLocalWorkspace({ config: fixture.config }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'LOCAL_WORKSPACE_BUSY',
    )
  } finally { await first.close() }
})

test('owner persists exact database-lock identities as decimal strings', async () => {
  const fixture = await workspaceFixture('local-exact-owner-identity')
  const workspace = await openLocalWorkspace({ config: fixture.config })
  try {
    const owner = JSON.parse(await readFile(join(workspace.statePath, 'owner.json'), 'utf8')) as {
      databaseLock?: { dev?: unknown; ino?: unknown }
    }
    const lock = await lstat(join(workspace.dataPath, '.zorya-search-owner'), { bigint: true })
    assert.equal(typeof owner.databaseLock?.dev, 'string')
    assert.equal(typeof owner.databaseLock?.ino, 'string')
    assert.equal(owner.databaseLock?.dev, lock.dev.toString(10))
    assert.equal(owner.databaseLock?.ino, lock.ino.toString(10))
  } finally { await workspace.close() }
})

test('separate folders get separate private databases and workspace identities', async () => {
  const fixtureA = await workspaceFixture('local-a')
  const workspaceA = await openLocalWorkspace({ config: fixtureA.config })
  process.chdir(fixtureA.parent)
  const secondProject = join(fixtureA.parent, 'second')
  await mkdir(secondProject)
  process.chdir(secondProject)
  const configB = { ...fixtureA.config }
  const workspaceB = await openLocalWorkspace({ config: configB })
  try {
    assert.notEqual(workspaceA.workspaceId, workspaceB.workspaceId)
    assert.notEqual(workspaceA.dataPath, workspaceB.dataPath)
    assert.equal(workspaceA.runtime.listRoots()[0]?.path, await realpath(fixtureA.project))
    assert.equal(workspaceB.runtime.listRoots()[0]?.path, await realpath(secondProject))
  } finally {
    await workspaceB.close()
    await workspaceA.close()
  }
})

test('client identity also namespaces the state for one canonical workspace', async () => {
  const fixture = await workspaceFixture('local-client-identity')
  const first = await openLocalWorkspace({ config: fixture.config })
  const second = await openLocalWorkspace({ config: { ...fixture.config, clientId: randomUUID() } })
  try {
    assert.equal(first.canonicalPath, second.canonicalPath)
    assert.notEqual(first.workspaceId, second.workspaceId)
    assert.notEqual(first.dataPath, second.dataPath)
  } finally {
    await second.close()
    await first.close()
  }
})

test('local MCP leaves capabilities source-free and indexes only when a source query is called', async () => {
  const fixture = await workspaceFixture()
  const source = join(fixture.project, 'src', 'one.ts')
  await mkdir(join(fixture.project, 'src'))
  await writeFile(source, 'export const marker = "LOCAL_QUERY_ALPHA"\n')
  const workspace = await openLocalWorkspace({ config: fixture.config })
  const { handle, client } = await connect(workspace)
  const reference = createSearchMcpServer(workspace.runtime, {
    rootIds: ['workspace'], operations: ['read', 'index', 'web', 'classify', 'visual'],
  })
  const referenceClient = new Client({ name: 'local-contract-reference', version: '1.0.0' })
  const [referenceTransport, referenceServerTransport] = InMemoryTransport.createLinkedPair()
  await reference.connect(referenceServerTransport)
  await referenceClient.connect(referenceTransport)
  const originalFetch = globalThis.fetch
  let externalCalls = 0
  try {
    const listed = await client.listTools()
    assert.deepEqual(listed.tools, (await referenceClient.listTools()).tools)
    const names = new Set(listed.tools.map((tool) => tool.name))
    assert.equal(names.has('search_project_text'), false)
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      externalCalls++
      return originalFetch(...args)
    }) as typeof fetch
    const caps = await client.callTool({ name: 'capabilities', arguments: {}, _meta: meta(conversationA) })
    assert.equal(caps.isError, undefined)
    assert.equal((await workspace.runtime.indexStatus({ rootId: 'workspace' })).identity, null)

    const first = await client.callTool({
      name: 'search_code',
      arguments: { rootId: 'workspace', query: 'LOCAL_QUERY_ALPHA', mode: 'lexical' },
      _meta: meta(conversationA),
    })
    assert.equal(first.isError, undefined)
    const firstData = first.structuredContent as { identity?: { snapshotId?: string }; hits?: Array<{ path: string; text?: string }> }
    assert.ok(firstData.identity?.snapshotId)
    assert.ok(firstData.hits?.some((hit) => hit.path === 'src/one.ts'))
    const firstSnapshot = firstData.identity!.snapshotId

    await writeFile(source, 'export const marker = "LOCAL_QUERY_BETA"\n')
    const second = await client.callTool({
      name: 'search_code',
      arguments: { rootId: 'workspace', query: 'LOCAL_QUERY_BETA', mode: 'lexical' },
      _meta: meta(conversationA),
    })
    assert.equal(second.isError, undefined)
    const secondData = second.structuredContent as { identity?: { snapshotId?: string }; hits?: Array<{ path: string }> }
    assert.ok(secondData.identity?.snapshotId)
    assert.notEqual(secondData.identity?.snapshotId, firstSnapshot)
    assert.ok(secondData.hits?.some((hit) => hit.path === 'src/one.ts'))
    const pinnedOldSnapshot = await client.callTool({
      name: 'read_source',
      arguments: { rootId: 'workspace', path: 'src/one.ts', snapshotId: firstSnapshot },
      _meta: meta(conversationA),
    })
    assert.equal(pinnedOldSnapshot.isError, true)
    assert.match(pinnedOldSnapshot.content[0]?.type === 'text' ? pinnedOldSnapshot.content[0].text : '', /CODE_INDEX_SNAPSHOT_MISMATCH/u)
    assert.equal(externalCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
    await client.close()
    await referenceClient.close()
    await handle.close()
    await reference.close()
    await workspace.close()
  }
})

test('first configured project-text query refreshes a persisted code-only database', async () => {
  const fixture = await workspaceFixture('local-project-text-refresh')
  await mkdir(join(fixture.project, 'src'))
  await writeFile(join(fixture.project, 'src', 'one.ts'), 'export const codeMarker = "PROJECT_TEXT_REFRESH_CODE"\n')
  await writeFile(join(fixture.project, 'README.md'), '# Workspace notes\nA retained project text phrase for local refresh.\n')
  const codeOnly = await openLocalWorkspace({ config: fixture.config })
  await codeOnly.runtime.indexRepository({ rootId: 'workspace' })
  await codeOnly.close()

  const textConfig = { ...fixture.config, runtime: { projectText: {} } }
  const workspace = await openLocalWorkspace({ config: textConfig })
  const { handle, client } = await connect(workspace)
  try {
    const searched = await client.callTool({
      name: 'search_project_text',
      arguments: { rootId: 'workspace', query: 'retained project text phrase', kinds: ['documentation'], mode: 'lexical' },
      _meta: meta(conversationA),
    })
    assert.equal(searched.isError, undefined)
    const searchData = searched.structuredContent as { hits?: Array<{ path: string }> }
    assert.ok(searchData.hits?.some((hit) => hit.path === 'README.md'))
    const status = await client.callTool({ name: 'project_text_status', arguments: { rootId: 'workspace' }, _meta: meta(conversationA) })
    assert.equal(status.isError, undefined)
    const statusData = status.structuredContent as { identity?: unknown; snapshotId?: unknown; stale?: unknown }
    assert.ok(statusData.identity)
    assert.equal(typeof statusData.snapshotId, 'string')
    assert.equal(statusData.stale, false)
  } finally {
    await client.close()
    await handle.close()
    await workspace.close()
  }
})

test('explicit project-text profile preserves the original profile-dependent tool inventory', async () => {
  const fixture = await workspaceFixture('local-project-text-inventory')
  const configured = { ...fixture.config, runtime: { projectText: {} } }
  const workspace = await openLocalWorkspace({ config: configured })
  const { handle, client } = await connect(workspace)
  const reference = createSearchMcpServer(workspace.runtime, {
    rootIds: ['workspace'], operations: ['read', 'index', 'web', 'classify', 'visual'],
  })
  const referenceClient = new Client({ name: 'local-project-text-reference', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await reference.connect(serverTransport)
  await referenceClient.connect(clientTransport)
  try {
    const localTools = (await client.listTools()).tools
    const referenceTools = (await referenceClient.listTools()).tools
    assert.deepEqual(localTools, referenceTools)
    assert.ok(localTools.some((tool) => tool.name === 'search_project_text'))
    assert.ok(localTools.some((tool) => tool.name === 'index_project_text'))
  } finally {
    await client.close()
    await referenceClient.close()
    await handle.close()
    await reference.close()
    await workspace.close()
  }
})

test('local MCP refuses malformed or foreign workspace requests before forwarding', async () => {
  const fixture = await workspaceFixture()
  const workspace = await openLocalWorkspace({ config: fixture.config })
  const { handle, client } = await connect(workspace)
  try {
    const missing = await client.callTool({ name: 'capabilities', arguments: {} })
    assert.equal(missing.isError, true)
    assert.match(missing.content[0]?.type === 'text' ? missing.content[0].text : '', /CONVERSATION_UNRESOLVED/u)
    const foreign = await client.callTool({ name: 'search_code', arguments: { rootId: 'other', query: 'x' }, _meta: meta(conversationA) })
    assert.equal(foreign.isError, true)
    assert.match(foreign.content[0]?.type === 'text' ? foreign.content[0].text : '', /ROOT_NOT_AUTHORIZED/u)
    const conflict = await client.callTool({ name: 'capabilities', arguments: {}, _meta: { ...meta(conversationA), threadId: conversationB } })
    assert.equal(conflict.isError, true)
    assert.match(conflict.content[0]?.type === 'text' ? conflict.content[0].text : '', /CONVERSATION_UNRESOLVED/u)
  } finally {
    await client.close()
    await handle.close()
    await workspace.close()
  }
})

test('local job ownership is conversation-scoped and cancellation waits for physical completion', async () => {
  const fixture = await workspaceFixture('local-job-ownership')
  const originalWorkspace = await openLocalWorkspace({ config: fixture.config })
  const actualRuntime = originalWorkspace.runtime
  const originalStatus = actualRuntime.indexStatus.bind(actualRuntime)
  let job: Record<string, unknown> | undefined
  let resolveCancelStarted!: () => void
  const cancelStarted = new Promise<void>((resolve) => { resolveCancelStarted = resolve })
  let resolvePhysicalFinish!: () => void
  const physicalFinish = new Promise<void>((resolve) => { resolvePhysicalFinish = resolve })
  let physicalFinished = false
  const runtime = new Proxy(actualRuntime, {
    get(target, property) {
      if (property === 'indexStatus') return async (input: { rootId: string; jobId?: string }) => {
        if (input.jobId && job?.jobId !== input.jobId) return originalStatus(input)
        const base = await originalStatus({ rootId: input.rootId })
        return { ...base, indexingJob: job ?? null }
      }
      if (property === 'startIndexing') return async (input: { rootId: string }) => {
        job = {
          jobId: randomUUID(), rootId: input.rootId, state: 'running', createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(), attempt: 1, totalChunks: null, checkpointChunks: 0,
        }
        return { created: true, job }
      }
      if (property === 'cancelIndexing') return async () => {
        resolveCancelStarted()
        await physicalFinish
        physicalFinished = true
        job = { ...job, state: 'cancelled', finishedAt: new Date().toISOString(), errorCode: 'CANCELLED' }
        return job
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const workspace = { ...originalWorkspace, runtime } as unknown as LocalWorkspace
  const shared = createLocalMcpSharedState()
  const handle = await createLocalMcpServer(workspace, shared)
  const client = new Client({ name: 'local-job-owner-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await handle.server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const started = await client.callTool({ name: 'start_indexing', arguments: { rootId: 'workspace' }, _meta: meta(conversationA) })
    assert.equal(started.isError, undefined)
    const jobId = (started.structuredContent as { job?: { jobId?: string } }).job?.jobId
    assert.ok(jobId)
    assert.equal(shared.jobs.get(jobId!)?.conversationId, conversationA)
    const otherStatus = await client.callTool({ name: 'index_status', arguments: { rootId: 'workspace', jobId }, _meta: meta(conversationB) })
    assert.equal(otherStatus.isError, true)
    assert.match(otherStatus.content[0]?.type === 'text' ? otherStatus.content[0].text : '', /JOB_NOT_FOUND/u)
    const otherCancel = await client.callTool({ name: 'cancel_indexing', arguments: { rootId: 'workspace', jobId }, _meta: meta(conversationB) })
    assert.equal(otherCancel.isError, true)
    assert.match(otherCancel.content[0]?.type === 'text' ? otherCancel.content[0].text : '', /JOB_NOT_FOUND/u)
    const ownedStatus = await client.callTool({ name: 'index_status', arguments: { rootId: 'workspace', jobId }, _meta: meta(conversationA) })
    assert.equal(ownedStatus.isError, undefined, JSON.stringify({ started: started.structuredContent, owned: ownedStatus.structuredContent, error: ownedStatus.content[0] }))
    let cancelSettled = false
    const cancel = client.callTool({ name: 'cancel_indexing', arguments: { rootId: 'workspace', jobId }, _meta: meta(conversationA) })
      .then((result) => { cancelSettled = true; return result })
    await cancelStarted
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(cancelSettled, false)
    assert.equal(physicalFinished, false)
    resolvePhysicalFinish()
    const cancelled = await cancel
    assert.equal(physicalFinished, true)
    assert.equal(cancelled.isError, undefined)
    assert.equal((cancelled.structuredContent as { state?: string }).state, 'cancelled')
  } finally {
    resolvePhysicalFinish()
    await client.close()
    await handle.close()
    await originalWorkspace.close()
  }
})

test('job ledger evicts verified terminal history only when the 64-job capacity is full', async () => {
  const fixture = await workspaceFixture('local-job-ledger-bound')
  const originalWorkspace = await openLocalWorkspace({ config: fixture.config })
  const actualRuntime = originalWorkspace.runtime
  const runtime = new Proxy(actualRuntime, {
    get(target, property) {
      if (property === 'startIndexing') return async () => ({
        created: true,
        job: {
          jobId: randomUUID(), rootId: 'workspace', state: 'completed',
          createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
          attempt: 1, totalChunks: 0, checkpointChunks: 0,
        },
      })
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const workspace = { ...originalWorkspace, runtime } as unknown as LocalWorkspace
  const shared = createLocalMcpSharedState()
  const handle = await createLocalMcpServer(workspace, shared)
  const client = new Client({ name: 'local-job-ledger-bound', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await handle.server.connect(serverTransport)
  await client.connect(clientTransport)
  const createdIds: string[] = []
  try {
    for (let index = 0; index < 65; index += 1) {
      const result = await client.callTool({
        name: 'start_indexing', arguments: { rootId: 'workspace' }, _meta: meta(conversationA),
      })
      assert.equal(result.isError, undefined, `start ${index + 1} should fit after pruning a terminal record`)
      const jobId = (result.structuredContent as { job?: { jobId?: string } }).job?.jobId
      assert.equal(typeof jobId, 'string')
      createdIds.push(jobId!)
      assert.ok(shared.jobs.size <= 64)
    }
    assert.equal(shared.jobs.size, 64)
    assert.equal(shared.jobs.has(createdIds[0]!), false)
    assert.equal(shared.jobs.has(createdIds.at(-1)!), true)
    const evicted = await client.callTool({ name: 'index_status', arguments: { rootId: 'workspace', jobId: createdIds[0] }, _meta: meta(conversationA) })
    assert.equal(evicted.isError, true)
    assert.match(evicted.content[0]?.type === 'text' ? evicted.content[0].text : '', /JOB_NOT_FOUND/u)
  } finally {
    await client.close()
    await handle.close()
    await originalWorkspace.close()
  }
})

test('local config refuses static roots/data paths and provider settings do not inherit project config', async () => {
  const fixture = await workspaceFixture()
  const workspace = await openLocalWorkspace({ config: fixture.config })
  try {
    assert.equal(workspace.runtime.capabilities().embedding, false)
    assert.equal(workspace.runtime.capabilities().projectText, false)
  } finally { await workspace.close() }
  for (const field of ['roots', 'dataDir', 'version']) {
    await assert.rejects(
      () => openLocalWorkspace({ config: { ...fixture.config, runtime: { [field]: field === 'roots' ? [] : 1 } } }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'LOCAL_CONFIG_INVALID',
    )
  }
})

test('shared owner serves both legacy clients and SDK 2.4 auto-negotiation', async () => {
  const fixture = await workspaceFixture('local-protocol-eras')
  const workspace = await openLocalWorkspace({ config: fixture.config, configDir: fixture.parent })
  const http = await startLocalOwnerHttp(workspace)
  const owner = await inspectLocalOwner(fixture.config, fixture.parent)
  assert.equal(owner.state, 'ready')
  if (owner.state !== 'ready') throw new Error('owner not ready')
  const makeClient = async (mode: 'legacy' | 'auto') => {
    const client = new Client({ name: `local-${mode}`, version: '1.0.0', versionNegotiation: { mode } })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${owner.service.token}` }, redirect: 'error' },
    })
    await client.connect(transport)
    return { client, transport }
  }
  const clients: Array<{ client: Client; transport: StreamableHTTPClientTransport }> = []
  try {
    for (const mode of ['legacy', 'auto'] as const) {
      const connected = await makeClient(mode)
      clients.push(connected)
      assert.ok((await connected.client.listTools()).tools.some((tool) => tool.name === 'capabilities'))
      const result = await connected.client.callTool({
        name: 'capabilities', arguments: {}, _meta: meta(conversationA),
      })
      assert.equal(result.isError, undefined)
    }
  } finally {
    for (const { client, transport } of clients) {
      await transport.terminateSession().catch(() => undefined)
      await client.close().catch(() => undefined)
      await transport.close().catch(() => undefined)
    }
    await http.close()
    await workspace.close()
  }
})

test('shared owner rejects bad bearer, Host, and Origin before MCP routing', async () => {
  const fixture = await workspaceFixture('local-http-guards')
  const workspace = await openLocalWorkspace({ config: fixture.config, configDir: fixture.parent })
  const http = await startLocalOwnerHttp(workspace)
  const owner = await inspectLocalOwner(fixture.config, fixture.parent)
  assert.equal(owner.state, 'ready')
  if (owner.state !== 'ready') throw new Error('LOCAL_OWNER_NOT_READY')
  const rawStatus = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: http.port, path: '/mcp', method: 'POST', headers }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.once('error', reject)
    req.end('{}')
  })
  try {
    assert.equal(await rawStatus({ Authorization: 'Bearer wrong', 'Content-Type': 'application/json', Host: `127.0.0.1:${http.port}` }), 401)
    assert.equal(await rawStatus({ Authorization: `Bearer ${owner.service.token}`, 'Content-Type': 'application/json', Host: `localhost:${http.port}` }), 403)
    assert.equal(await rawStatus({ Authorization: `Bearer ${owner.service.token}`, 'Content-Type': 'application/json', Host: `127.0.0.1:${http.port}`, Origin: 'https://example.invalid' }), 403)
  } finally {
    await http.close()
    await workspace.close()
  }
})

test('shared owner bounds sessions and evicts abandoned clients after idle timeout', async () => {
  const fixture = await workspaceFixture('local-session-cap')
  const workspace = await openLocalWorkspace({ config: fixture.config, configDir: fixture.parent })
  const http = await startLocalOwnerHttp(workspace, { idleTimeoutMs: 100 })
  const owner = await inspectLocalOwner(fixture.config, fixture.parent)
  assert.equal(owner.state, 'ready')
  if (owner.state !== 'ready') throw new Error('LOCAL_OWNER_NOT_READY')
  const clients: Array<{ client: Client; transport: StreamableHTTPClientTransport }> = []
  const connect = async () => {
    const client = new Client({ name: 'local-session-limit', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${owner.service.token}` }, redirect: 'error' },
    })
    await client.connect(transport)
    return { client, transport }
  }
  try {
    for (let i = 0; i < 16; i++) clients.push(await connect())
    const overflowClient = new Client({ name: 'local-session-overflow', version: '1.0.0' })
    const overflowTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${owner.service.token}` }, redirect: 'error' },
    })
    await assert.rejects(() => overflowClient.connect(overflowTransport))
    await overflowTransport.close().catch(() => undefined)
    const abandoned = clients.shift()!
    await abandoned.client.close()
    await new Promise((resolve) => setTimeout(resolve, 250))
    clients.push(await connect())
    assert.equal(clients.length, 16)
  } finally {
    for (const { client } of clients) await client.close().catch(() => undefined)
    await http.close()
    await workspace.close()
  }
})

test('a ready owner refuses changed or invalid runtime policy instead of reusing stale settings', async () => {
  const fixture = await workspaceFixture('local-profile-binding')
  const workspace = await openLocalWorkspace({ config: fixture.config, configDir: fixture.parent })
  try {
    await assert.rejects(
      () => inspectLocalOwner({ ...fixture.config, runtime: { limits: { timeoutMs: 5_000 } } }, fixture.parent),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'LOCAL_PROFILE_MISMATCH',
    )
    await assert.rejects(
      () => inspectLocalOwner({ ...fixture.config, runtime: { roots: [] } }, fixture.parent),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'LOCAL_CONFIG_INVALID',
    )
  } finally { await workspace.close() }
})

test('local hard privacy exclusions are merged within the existing 128-pattern ceiling', async () => {
  const fixture = await workspaceFixture('local-private-config-excludes')
  const source = join(fixture.project, 'src', 'safe.ts')
  await mkdir(join(fixture.project, 'src'))
  await writeFile(source, 'export const marker = "SAFE_SOURCE_CURRENT"\n')
  await mkdir(join(fixture.project, '.codex'), { recursive: true })
  await mkdir(join(fixture.project, '.config'), { recursive: true })
  await mkdir(join(fixture.project, '.azure'), { recursive: true })
  await mkdir(join(fixture.project, '.cursor'), { recursive: true })
  await writeFile(join(fixture.project, '.codex', 'credential.ts'), `export const leaked = "LOCAL_PRIVATE_CANARY"\n${'x'.repeat(1_100_000)}`)
  await writeFile(join(fixture.project, '.config', 'auth.json'), '{"private":"LOCAL_AUTH_CANARY"}')
  await writeFile(join(fixture.project, '.azure', 'profile.json'), '{"private":"LOCAL_AZURE_CANARY"}')
  await writeFile(join(fixture.project, '.cursor', 'mcp.json'), '{"private":"LOCAL_MCP_CANARY"}')
  const outside = join(fixture.parent, 'outside.ts')
  await writeFile(outside, 'export const escaped = "LOCAL_SYMLINK_CANARY"\n')
  await symlink(outside, join(fixture.project, 'src', 'escaped.ts'))
  const workspace = await openLocalWorkspace({ config: fixture.config })
  const { handle, client } = await connect(workspace)
  try {
    const result = await client.callTool({ name: 'search_code', arguments: { rootId: 'workspace', query: 'SAFE_SOURCE_CURRENT', mode: 'lexical' }, _meta: meta(conversationA) })
    assert.equal(result.isError, undefined)
    const exact = await client.callTool({ name: 'read_source', arguments: { rootId: 'workspace', path: 'src/safe.ts' }, _meta: meta(conversationA) })
    assert.equal(exact.isError, undefined)
    assert.equal((exact.structuredContent as { text: string }).text, 'export const marker = "SAFE_SOURCE_CURRENT"\n')
    for (const path of ['.codex/credential.ts', '.config/auth.json', '.azure/profile.json', '.cursor/mcp.json', 'src/escaped.ts']) {
      const refused = await client.callTool({ name: 'read_source', arguments: { rootId: 'workspace', path }, _meta: meta(conversationA) })
      assert.equal(refused.isError, true, path)
    }
    const maxPaths = Array.from({ length: LOCAL_MAX_USER_EXCLUSIONS }, (_, index) => `private-${index}/**`)
    const parsed = parseLocalConfig({ ...fixture.config, excludedPaths: maxPaths }, workspace.canonicalPath, workspace.dataPath)
    assert.equal(parsed.runtimeConfig.roots[0]?.exclude?.length, 128)
    assert.equal(LOCAL_PRIVACY_EXCLUSIONS.length + LOCAL_MAX_USER_EXCLUSIONS, 128)
    assert.throws(
      () => parseLocalConfig({ ...fixture.config, excludedPaths: [...maxPaths, 'one-more/**'] }, workspace.canonicalPath, workspace.dataPath),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'LOCAL_CONFIG_INVALID',
    )
  } finally {
    await client.close()
    await handle.close()
    await workspace.close()
  }
})

test('close drains the local MCP server and runtime before releasing the workspace lease', async () => {
  const fixture = await workspaceFixture()
  const workspace = await openLocalWorkspace({ config: fixture.config })
  const { handle, client } = await connect(workspace)
  await client.close()
  await handle.close()
  await workspace.close()
  const lock = join(workspace.statePath, 'owner.json')
  await assert.rejects(() => readFile(lock), { code: 'ENOENT' })
  const reopened = await openLocalWorkspace({ config: fixture.config })
  await reopened.close()
})

test('SIGKILL recovery preserves the DB snapshot across a validated runtime-profile change', async () => {
  const fixture = await workspaceFixture('local-kill-recovery')
  await mkdir(join(fixture.project, 'src'))
  await writeFile(join(fixture.project, 'src', 'retained.ts'), 'export const retained = "LOCAL_RESTART_SNAPSHOT"\n')
  const initial = await openLocalWorkspace({ config: fixture.config })
  await initial.runtime.indexRepository({ rootId: 'workspace' })
  const beforeRestart = await initial.runtime.indexStatus({ rootId: 'workspace' })
  assert.ok(beforeRestart.identity?.snapshotId)
  assert.ok(beforeRestart.identity?.contentHash)
  await initial.close()
  const childFile = join(fixture.parent, 'owner-child.mjs')
  const configFile = join(fixture.parent, 'owner-config.json')
  await writeFile(configFile, JSON.stringify(fixture.config))
  const ownerModule = pathToFileURL(fileURLToPath(new URL('../../src/local/owner.ts', import.meta.url))).href
  await writeFile(childFile, `import { readFile } from 'node:fs/promises'; import { openLocalWorkspace } from ${JSON.stringify(ownerModule)}; const config=JSON.parse(await readFile(${JSON.stringify(configFile)},'utf8')); await openLocalWorkspace({config}); console.log('OWNER_READY'); setInterval(()=>{},1000);`)
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), childFile], {
    cwd: fixture.project,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const childExited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  try {
    let poll: NodeJS.Timeout | undefined
    let timeout: NodeJS.Timeout | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`owner child startup timeout: ${stderr}`)), 20_000)
        poll = setInterval(() => {
          if (stdout.includes('OWNER_READY')) resolve()
          else if (child.exitCode !== null || child.signalCode !== null) reject(new Error(`owner child exited early: ${stderr}`))
        }, 20)
        void childExited.then(({ code, signal }) => {
          if (!stdout.includes('OWNER_READY')) reject(new Error(`owner child exited early (${code ?? signal}): ${stderr}`))
        })
      })
    } finally {
      if (timeout) clearTimeout(timeout)
      if (poll) clearInterval(poll)
    }
    child.kill('SIGKILL')
    const exited = await childExited
    assert.equal(exited.signal, 'SIGKILL')
    const changedProfile = { ...fixture.config, runtime: { limits: { timeoutMs: 5_000 } } }
    const recovered = await openLocalWorkspace({ config: changedProfile })
    try {
      assert.equal(recovered.runtime.listRoots()[0]?.path, await realpath(fixture.project))
      const afterRestart = await recovered.runtime.indexStatus({ rootId: 'workspace' })
      assert.equal(afterRestart.identity?.snapshotId, beforeRestart.identity?.snapshotId)
      assert.equal(afterRestart.identity?.contentHash, beforeRestart.identity?.contentHash)
    } finally { await recovered.close() }
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await childExited
    }
  }
})

test('dead recovery claims are reclaimed only for the same workspace before or after stale owner removal', async () => {
  for (const ownerRemoved of [false, true]) {
    const fixture = await workspaceFixture(`local-recovery-claim-${ownerRemoved ? 'after' : 'before'}`)
    await writeFile(join(fixture.project, 'retained.ts'), 'export const recoveryClaimData = "PERSISTED"\n')
    const workspace = await openLocalWorkspace({ config: fixture.config })
    await workspace.runtime.indexRepository({ rootId: 'workspace' })
    const status = await workspace.runtime.indexStatus({ rootId: 'workspace' })
    assert.ok(status.identity?.snapshotId)
    await workspace.close()

    const exitedPid = () => new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
      child.once('error', reject)
      child.once('exit', () => resolve(child.pid!))
    })
    const [ownerPid, recoveryPid] = await Promise.all([exitedPid(), exitedPid()])
    const ownerPath = join(workspace.statePath, 'owner.json')
    const recoveryPath = join(workspace.statePath, 'recovery.json')

    const staleOwner = {
      schemaVersion: 1,
      pid: ownerPid,
      nonce: randomUUID(),
      clientId: fixture.config.clientId,
      workspaceId: workspace.workspaceId,
      profileFingerprint: '0'.repeat(64),
      canonicalPath: await realpath(fixture.project),
      statePath: workspace.statePath,
      dataPath: workspace.dataPath,
      startedAt: new Date(0).toISOString(),
    }
    await writeFile(ownerPath, JSON.stringify(staleOwner), { mode: 0o600 })
    const ownerInfo = await lstat(ownerPath, { bigint: true })
    const record = {
      schemaVersion: 1,
      nonce: randomUUID(),
      pid: recoveryPid,
      targetOwnerNonce: randomUUID(),
      clientId: fixture.config.clientId,
      workspaceId: workspace.workspaceId,
      canonicalPath: await realpath(fixture.project),
      statePath: workspace.statePath,
      dataPath: workspace.dataPath,
      staleOwner: { pid: ownerPid, nonce: staleOwner.nonce, dev: ownerInfo.dev.toString(10), ino: ownerInfo.ino.toString(10) },
    }
    await writeFile(recoveryPath, JSON.stringify(record), { mode: 0o600 })
    if (ownerRemoved) await unlink(ownerPath)

    const recovered = await openLocalWorkspace({ config: fixture.config })
    try {
      const recoveredStatus = await recovered.runtime.indexStatus({ rootId: 'workspace' })
      assert.equal(recoveredStatus.identity?.snapshotId, status.identity?.snapshotId)
      assert.equal(recoveredStatus.identity?.contentHash, status.identity?.contentHash)
      await assert.rejects(() => readFile(recoveryPath), { code: 'ENOENT' })
    } finally { await recovered.close() }
  }
})

test('live, malformed, and identity-mismatched recovery claims remain untouched', async () => {
  for (const kind of ['live', 'malformed', 'foreign'] as const) {
    const fixture = await workspaceFixture(`local-recovery-preserve-${kind}`)
    const workspace = await openLocalWorkspace({ config: fixture.config })
    await workspace.close()
    const recoveryPath = join(workspace.statePath, 'recovery.json')
    const claim = {
      schemaVersion: 1,
      nonce: randomUUID(),
      pid: kind === 'live' ? process.pid : 2_147_483_647,
      targetOwnerNonce: randomUUID(),
      clientId: kind === 'foreign' ? randomUUID() : fixture.config.clientId,
      workspaceId: workspace.workspaceId,
      canonicalPath: await realpath(fixture.project),
      statePath: workspace.statePath,
      dataPath: workspace.dataPath,
      staleOwner: { pid: 2_147_483_646, nonce: randomUUID(), dev: 0, ino: 0 },
    }
    const contents = kind === 'malformed' ? '{bad-json' : JSON.stringify(claim)
    await writeFile(recoveryPath, contents, { mode: 0o600 })
    const expectedCode = kind === 'malformed' ? 'LOCAL_STATE_INVALID' : 'LOCAL_WORKSPACE_BUSY'
    await assert.rejects(
      () => openLocalWorkspace({ config: fixture.config }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === expectedCode,
    )
    assert.equal(await readFile(recoveryPath, 'utf8'), contents)
  }
})

test('startup cleanup retains the runtime and lease when database-lock registration and runtime close both fail', async () => {
  const fixture = await workspaceFixture('local-startup-cleanup-retained')
  const fakeRuntime = { close: async () => { throw new Error('INJECTED_CLOSE_FAILURE') } }
  await assert.rejects(
    () => openLocalWorkspace({
      config: fixture.config,
      testRuntimeFactory: async (options) => {
        const dataDir = (options.config as { dataDir: string }).dataDir
        await mkdir(dataDir, { recursive: true })
        await writeFile(join(dataDir, '.zorya-search-owner'), JSON.stringify({ pid: process.pid + 1, nonce: randomUUID() }), { mode: 0o600 })
        return fakeRuntime as unknown as Awaited<ReturnType<typeof openSearchRuntime>>
      },
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'LOCAL_RUNTIME_CLOSE_FAILED',
  )
  const workspace = await canonicalCurrentWorkspace()
  assert.equal(workspace.canonicalPath, await realpath(fixture.project))
  const statePath = join(fixture.stateDir, workspaceIdForCanonicalPath(clientId, workspace.canonicalPath))
  const owner = JSON.parse(await readFile(join(statePath, 'owner.json'), 'utf8')) as { pid: number; databaseLock?: unknown }
  assert.equal(owner.pid, process.pid)
  assert.equal(owner.databaseLock, undefined)
  assert.equal(JSON.parse(await readFile(join(statePath, 'data', '.zorya-search-owner'), 'utf8')).pid, process.pid + 1)
  await assert.rejects(
    () => openLocalWorkspace({ config: fixture.config }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'LOCAL_RUNTIME_CLOSE_FAILED',
  )
  assert.equal(JSON.parse(await readFile(join(statePath, 'owner.json'), 'utf8')).pid, process.pid)
})
