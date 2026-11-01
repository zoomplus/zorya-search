import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { connect as connectTcp } from 'node:net'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { z } from 'zod'
import { startSearchDaemon } from '../../src/daemon/index.js'
import { runSearchMcpStdioProxy } from '../../src/mcp/stdio.js'

test('loopback daemon serves real negotiated MCP clients and isolates root grants', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-mcp-daemon-'))
  const alpha = join(dir, 'alpha')
  const beta = join(dir, 'beta')
  await Promise.all([mkdir(alpha), mkdir(beta), mkdir(join(dir, 'state'))])
  await writeFile(join(alpha, 'alpha.ts'), 'export const alphaNeedle = "alpha"\n')
  await writeFile(join(beta, 'beta.ts'), 'export const betaNeedle = "beta"\n')
  const tokens = new Map([
    [
      'token-alpha-'.padEnd(40, 'x'),
      {
        principalId: 'alpha-client',
        rootIds: ['alpha'],
        operations: ['read', 'index', 'classify', 'web'] as const,
      },
    ],
    [
      'token-beta-'.padEnd(40, 'y'),
      {
        principalId: 'beta-client',
        rootIds: ['beta'],
        operations: ['read', 'index', 'classify', 'web'] as const,
      },
    ],
  ])
  const fetchStarts: Array<{ signal: AbortSignal }> = []
  const controlledFetch: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) {
        reject(new Error('signal missing'))
        return
      }
      fetchStarts.push({ signal })
      signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), {
        once: true,
      })
    })
  let daemon: Awaited<ReturnType<typeof startSearchDaemon>> | undefined
  const config = {
    version: 1,
    dataDir: join(dir, 'state'),
    roots: [
      { id: 'alpha', path: alpha },
      { id: 'beta', path: beta },
    ],
    classifier: { model: 'offline-test', secret: { kind: 'env', name: 'MCP_TEST_KEY' } },
  }
  const clients: Client[] = []
  const alphaToken = 'token-alpha-'.padEnd(40, 'x')
  const betaToken = 'token-beta-'.padEnd(40, 'y')
  let betaExpiresAt = Number.POSITIVE_INFINITY
  try {
    daemon = await startSearchDaemon({
      host: '127.0.0.1',
      authorize: async (token) =>
        token === betaToken && Date.now() >= betaExpiresAt ? undefined : tokens.get(token),
      allowedHosts: ['127.0.0.1'],
      allowedOrigins: ['http://127.0.0.1'],
      maxLegacySessions: 64,
      legacyIdleTimeoutMs: 500,
      config,
      runtimeOptions: {
        testDependencies: { env: { MCP_TEST_KEY: 'test-only' }, fetch: controlledFetch },
      },
    })
    const base = `http://127.0.0.1:${daemon.port}${daemon.path}`
    const hostDenied = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: daemon!.port,
          path: daemon!.path,
          headers: { Host: `evil.example:${daemon!.port}` },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(hostDenied, 403)
    assert.equal((await fetch(base, { headers: { Origin: 'https://evil.example' } })).status, 403)
    assert.equal((await fetch(base)).status, 401)
    assert.equal(
      (
        await fetch(base, {
          method: 'POST',
          headers: { Authorization: `Bearer ${alphaToken}`, 'Content-Type': 'application/json' },
          body: 'x'.repeat(1_048_577),
        })
      ).status,
      413,
    )

    const makeClient = async (mode: 'auto' | 'legacy', token: string) => {
      const client = new Client(
        { name: `test-${mode}`, version: '1.0.0' },
        mode === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {},
      )
      clients.push(client)
      const currentBase = `http://127.0.0.1:${daemon!.port}${daemon!.path}`
      const transport = new StreamableHTTPClientTransport(new URL(currentBase), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      })
      await client.connect(transport)
      assert.equal(client.getProtocolEra(), mode === 'auto' ? 'modern' : 'legacy')
      return client
    }
    const modern = await makeClient('auto', alphaToken)
    const listed = await modern.listTools()
    assert.equal(listed.tools.length, 13)
    assert.equal(listed.tools.some((tool) => tool.name === 'search_visual_references'), false)
    assert.ok(listed.tools.some((tool) => tool.name === 'search_code'))
    assert.equal(
      listed.tools.find((tool) => tool.name === 'index_repository')?.annotations?.readOnlyHint,
      false,
    )
    assert.equal(listed.tools.some((tool) => tool.name === 'start_indexing'), true)
    assert.equal(listed.tools.some((tool) => tool.name === 'cancel_indexing'), true)
    assert.equal(listed.tools.find((tool) => tool.name === 'start_indexing')?.annotations?.readOnlyHint, false)
    assert.equal(listed.tools.find((tool) => tool.name === 'cancel_indexing')?.annotations?.destructiveHint, true)
    const admission = await modern.callTool({ name: 'start_indexing', arguments: { rootId: 'alpha' } })
    assert.notEqual(admission.isError, true)
    const admittedJob = (admission.structuredContent as { job?: { jobId?: string } }).job
    assert.match(admittedJob?.jobId ?? '', /^[0-9a-f-]{36}$/u)
    const liveStatus = await modern.callTool({ name: 'index_status', arguments: { rootId: 'alpha' } })
    assert.equal((liveStatus.structuredContent as { indexingJob?: { jobId?: string } }).indexingJob?.jobId, admittedJob?.jobId)
    assert.equal(
      listed.tools.find((tool) => tool.name === 'classify')?.annotations?.openWorldHint,
      true,
    )
    const badCapabilities = await modern.callTool({
      name: 'capabilities',
      arguments: { unexpected: true },
    })
    assert.equal(badCapabilities.isError, true)
    const visibleRoots = await modern.callTool({ name: 'list_roots', arguments: {} })
    assert.match(JSON.stringify(visibleRoots), /alpha/)
    assert.doesNotMatch(JSON.stringify(visibleRoots), /beta/)
    await modern.callTool({ name: 'index_repository', arguments: { rootId: 'alpha' } })
    const result = await modern.callTool({
      name: 'search_code',
      arguments: { rootId: 'alpha', query: 'alphaNeedle', mode: 'lexical' },
    })
    assert.match(JSON.stringify(result), /alpha\.ts/)
    assert.ok(result.structuredContent && typeof result.structuredContent === 'object')
    assert.ok('identity' in result.structuredContent)
    const disabled = await modern.callTool({
      name: 'search_web',
      arguments: { query: 'offline only' },
    })
    assert.equal(disabled.isError, true)
    assert.match(JSON.stringify(disabled), /CAPABILITY_DISABLED/)
    await writeFile(join(alpha, 'alpha.ts'), 'export const changedAfterCall = "new generation"\n')
    await modern.callTool({ name: 'index_repository', arguments: { rootId: 'alpha' } })
    const updated = await modern.callTool({
      name: 'search_code',
      arguments: { rootId: 'alpha', query: 'changedAfterCall', mode: 'lexical' },
    })
    assert.match(JSON.stringify(updated), /alpha\.ts/)
    const denied = await modern.callTool({
      name: 'search_code',
      arguments: { rootId: 'beta', query: 'betaNeedle', mode: 'lexical' },
    })
    assert.equal(denied.isError, true)
    const malformed = await modern.callTool({
      name: 'search_code',
      arguments: { rootId: 'alpha', query: 'alphaNeedle', mode: 'lexical', root: '/etc' },
    })
    assert.equal(malformed.isError, true)
    const cancelCall = async (client: Client) => {
      const expected = fetchStarts.length + 1
      const controller = new AbortController()
      const call = client
        .callTool(
          {
            name: 'classify',
            arguments: { text: 'fixture', labels: ['yes', 'no'], criteria: 'Choose a label' },
          },
          { signal: controller.signal },
        )
        .catch(() => undefined)
      for (let i = 0; i < 100 && fetchStarts.length < expected; i++)
        await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(fetchStarts.length, expected)
      controller.abort()
      await call
      for (let i = 0; i < 100 && !fetchStarts[expected - 1]!.signal.aborted; i++)
        await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(fetchStarts[expected - 1]!.signal.aborted, true)
    }
    await cancelCall(modern)
    const rawCallIndex = fetchStarts.length
    const rawInitialize = await rawMcpPost(daemon.port, daemon.path, alphaToken, {
      jsonrpc: '2.0',
      id: 11,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'raw-disconnect', version: '1.0.0' },
      },
    })
    assert.equal(rawInitialize.status, 200)
    assert.ok(rawInitialize.sessionId)
    const disconnected = httpRequest({
      hostname: '127.0.0.1',
      port: daemon.port,
      path: daemon.path,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alphaToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-03-26',
        'Mcp-Session-Id': rawInitialize.sessionId!,
      },
    })
    disconnected.on('error', () => undefined)
    disconnected.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'classify',
          arguments: { text: 'raw-disconnect', labels: ['yes', 'no'], criteria: 'Choose a label' },
        },
      }),
    )
    for (let i = 0; i < 100 && fetchStarts.length <= rawCallIndex; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(fetchStarts.length, rawCallIndex + 1)
    disconnected.destroy()
    for (let i = 0; i < 100 && !fetchStarts[rawCallIndex]!.signal.aborted; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(fetchStarts[rawCallIndex]!.signal.aborted, true)

    const stdioClient = new Client({ name: 'stdio-proxy-client', version: '1.0.0' })
    clients.push(stdioClient)
    const stdioTransport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        "import { runSearchMcpStdioProxy } from './src/mcp/stdio.ts'; await runSearchMcpStdioProxy(new URL(process.env.SEARCH_ENDPOINT), process.env.SEARCH_TOKEN)",
      ],
      cwd: process.cwd(),
      env: { ...process.env, SEARCH_ENDPOINT: base, SEARCH_TOKEN: alphaToken },
      stderr: 'pipe',
    })
    let stdioStderr = ''
    stdioTransport.stderr?.on('data', (chunk) => {
      stdioStderr += String(chunk)
    })
    try {
      await stdioClient.connect(stdioTransport)
    } catch (error) {
      throw new Error(`stdio proxy failed: ${stdioStderr}`, { cause: error })
    }
    const stdioListed = await stdioClient.listTools()
    assert.ok(stdioListed.tools.some((tool) => tool.name === 'search_code'))
    const stdioResult = await stdioClient.callTool({
      name: 'search_code',
      arguments: { rootId: 'alpha', query: 'alphaNeedle', mode: 'lexical' },
    })
    assert.match(JSON.stringify(stdioResult), /alpha\.ts/)
    const stdioCallIndex = fetchStarts.length
    const activeStdioCall = stdioClient
      .callTool({
        name: 'classify',
        arguments: { text: 'stdio-eof', labels: ['yes', 'no'], criteria: 'Choose a label' },
      })
      .catch(() => undefined)
    for (let i = 0; i < 100 && fetchStarts.length <= stdioCallIndex; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(fetchStarts.length, stdioCallIndex + 1)
    const stdioPid = stdioTransport.pid
    assert.ok(stdioPid)
    await stdioClient.close()
    await activeStdioCall
    assert.equal(fetchStarts[stdioCallIndex]!.signal.aborted, true)
    let childExited = false
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(stdioPid, 0)
        await new Promise((resolve) => setTimeout(resolve, 10))
      } catch {
        childExited = true
        break
      }
    }
    assert.equal(childExited, true)
    t.diagnostic(`stdio proxy child pid ${stdioPid} exited after client EOF`)

    const legacy = await makeClient('legacy', betaToken)
    await legacy.callTool({ name: 'index_repository', arguments: { rootId: 'beta' } })
    const betaResult = await legacy.callTool({
      name: 'search_code',
      arguments: { rootId: 'beta', query: 'betaNeedle', mode: 'lexical' },
    })
    assert.match(JSON.stringify(betaResult), /beta\.ts/)
    await cancelCall(legacy)
    tokens.set(betaToken, {
      principalId: 'beta-client',
      rootIds: ['alpha'],
      operations: ['read', 'index', 'classify', 'web'],
    })
    await assert.rejects(() =>
      legacy.callTool({
        name: 'search_code',
        arguments: { rootId: 'beta', query: 'betaNeedle', mode: 'lexical' },
      }),
    )
    tokens.set(betaToken, {
      principalId: 'beta-client',
      rootIds: ['beta'],
      operations: ['read', 'index', 'classify', 'web'],
    })
    betaExpiresAt = Date.now() - 1
    await assert.rejects(() =>
      legacy.callTool({
        name: 'search_code',
        arguments: { rootId: 'beta', query: 'betaNeedle', mode: 'lexical' },
      }),
    )
    betaExpiresAt = Number.POSITIVE_INFINITY

    const firstClose = daemon.close()
    const joinedClose = daemon.close()
    assert.equal(firstClose, joinedClose)
    await firstClose
    daemon = await startSearchDaemon({
      host: '127.0.0.1',
      authorize: async (token) =>
        token === betaToken && Date.now() >= betaExpiresAt ? undefined : tokens.get(token),
      allowedHosts: ['127.0.0.1'],
      allowedOrigins: ['http://127.0.0.1'],
      maxLegacySessions: 1,
      legacyIdleTimeoutMs: 500,
      config,
      runtimeOptions: {
        testDependencies: { env: { MCP_TEST_KEY: 'test-only' }, fetch: controlledFetch },
      },
    })
    const afterRestart = await makeClient('auto', alphaToken)
    const persisted = await afterRestart.callTool({
      name: 'search_code',
      arguments: { rootId: 'alpha', query: 'changedAfterCall', mode: 'lexical' },
    })
    assert.match(JSON.stringify(persisted), /alpha\.ts/)
    const expectedShutdownFetch = fetchStarts.length + 1
    const shutdownCall = afterRestart
      .callTool({
        name: 'classify',
        arguments: { text: 'shutdown-test', labels: ['yes', 'no'], criteria: 'Choose a label' },
      })
      .catch(() => undefined)
    for (let i = 0; i < 100 && fetchStarts.length < expectedShutdownFetch; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(fetchStarts.length, expectedShutdownFetch)
    const shutdownSignal = fetchStarts.at(-1)!.signal
    const daemonClose = daemon.close()
    await Promise.all([daemonClose, shutdownCall])
    assert.equal(shutdownSignal.aborted, true)
    daemon = undefined
    daemon = await startSearchDaemon({
      host: '127.0.0.1',
      authorize: async (token) => tokens.get(token),
      allowedHosts: ['127.0.0.1'],
      allowedOrigins: ['http://127.0.0.1'],
      maxLegacySessions: 1,
      legacyIdleTimeoutMs: 500,
      config,
      runtimeOptions: {
        testDependencies: { env: { MCP_TEST_KEY: 'test-only' }, fetch: controlledFetch },
      },
    })
    const restartBase = `http://127.0.0.1:${daemon.port}${daemon.path}`
    const initializeBody = (name: string) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name, version: '1.0.0' },
        },
      })
    const quotaSession = await fetch(restartBase, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${betaToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: initializeBody('idle-check'),
    })
    assert.equal(quotaSession.status, 200)
    const legacySessionId = quotaSession.headers.get('mcp-session-id')
    assert.ok(legacySessionId)
    await quotaSession.arrayBuffer()
    const quota = await fetch(restartBase, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alphaToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: initializeBody('quota-check'),
    })
    assert.equal(quota.status, 503)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    const expiredSession = await fetch(restartBase, {
      headers: { Authorization: `Bearer ${betaToken}`, 'Mcp-Session-Id': legacySessionId! },
    })
    assert.equal(expiredSession.status, 404)
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)))
    await daemon?.close().catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  }
})

test('HTTP clients reach status during first watch index and admission survives the admitting disconnect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-mcp-background-index-'))
  const root = join(dir, 'root')
  await mkdir(root)
  await mkdir(join(dir, 'state'))
  await writeFile(join(root, 'delayed.ts'), 'export const delayedIndex = true\n')
  const tokenA = 'background-client-a'.padEnd(40, 'a')
  const tokenB = 'background-client-b'.padEnd(40, 'b')
  let release: (() => void) | undefined
  let fetchStartedResolve: (() => void) | undefined
  const fetchStarted = new Promise<void>((resolve) => { fetchStartedResolve = resolve })
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    fetchStartedResolve?.()
    await new Promise<void>((resolve) => { release = resolve })
    const body = JSON.parse(String(init?.body)) as { input?: string[] }
    return new Response(JSON.stringify({ data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200 })
  }
  let daemon: Awaited<ReturnType<typeof startSearchDaemon>> | undefined
  const clients: Client[] = []
  try {
    daemon = await startSearchDaemon({
      host: '127.0.0.1',
      authorize: async (token) => token === tokenA || token === tokenB
        ? { principalId: token === tokenA ? 'client-a' : 'client-b', rootIds: ['watched'], operations: ['read', 'index'] }
        : undefined,
      allowedHosts: ['127.0.0.1'],
      allowedOrigins: ['http://127.0.0.1'],
      config: {
        version: 1,
        dataDir: join(dir, 'state'),
        roots: [{ id: 'watched', path: root, watch: true, watchIntervalMs: 250 }],
        embedding: { provider: 'openrouter', model: 'fixture-embed', dimensions: 3, secret: { kind: 'env', name: 'BACKGROUND_EMBED_KEY' } },
      },
      runtimeOptions: { testDependencies: { env: { BACKGROUND_EMBED_KEY: 'fixture-only' }, fetch } },
    })
    await Promise.race([fetchStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('BACKGROUND_EMBED_NOT_STARTED')), 5000))])
    const connect = async (token: string) => {
      const client = new Client({ name: 'background-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon!.port}${daemon!.path}`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
      return client
    }
    const admittingClient = await connect(tokenA)
    const observingClient = await connect(tokenB)
    const status = await observingClient.callTool({ name: 'index_status', arguments: { rootId: 'watched' } })
    const currentJob = (status.structuredContent as { indexingJob?: { jobId?: string; state?: string; attempt?: number } }).indexingJob
    assert.equal(currentJob?.state, 'running')
    assert.equal(currentJob?.attempt, 1)
    const reused = await admittingClient.callTool({ name: 'start_indexing', arguments: { rootId: 'watched' } })
    assert.equal((reused.structuredContent as { created?: boolean }).created, false)
    const wrongRoot = await admittingClient.callTool({ name: 'cancel_indexing', arguments: { rootId: 'other', jobId: currentJob!.jobId } })
    assert.equal(wrongRoot.isError, true)
    const wrongJob = await observingClient.callTool({ name: 'cancel_indexing', arguments: { rootId: 'watched', jobId: '00000000-0000-4000-8000-000000000000' } })
    assert.equal(wrongJob.isError, true)
    await admittingClient.close()
    clients.splice(clients.indexOf(admittingClient), 1)
    release?.()
    const deadline = Date.now() + 5000
    let finalStatus = status
    while (Date.now() < deadline) {
      finalStatus = await observingClient.callTool({ name: 'index_status', arguments: { rootId: 'watched', jobId: currentJob!.jobId } })
      const current = (finalStatus.structuredContent as { indexingJob?: { state?: string } }).indexingJob
      if (current?.state === 'completed' || current?.state === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal((finalStatus.structuredContent as { indexingJob?: { state?: string } }).indexingJob?.state, 'completed')
  } finally {
    release?.()
    for (const client of clients) await client.close().catch(() => undefined)
    await daemon?.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('daemon validates trust and lifecycle bounds before opening its service', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-mcp-startup-'))
  const root = join(dir, 'root')
  await Promise.all([mkdir(root), mkdir(join(dir, 'state'))])
  const config = { version: 1, dataDir: join(dir, 'state'), roots: [{ id: 'root', path: root }] }
  try {
    await assert.rejects(
      () => startSearchDaemon({ host: '0.0.0.0', config }),
      /DAEMON_REMOTE_POLICY_REQUIRED/,
    )
    await assert.rejects(
      () => startSearchDaemon({ host: '127.0.0.1', bearerToken: 'short', config }),
      /DAEMON_OWNER_TOKEN_REQUIRED/,
    )
    await assert.rejects(
      () =>
        startSearchDaemon({
          host: '127.0.0.1',
          bearerToken: 'startup-token'.padEnd(40, 's'),
          path: '/bad path',
          config,
        }),
      /DAEMON_PATH_INVALID/,
    )
    await assert.rejects(
      () =>
        startSearchDaemon({
          host: '127.0.0.1',
          bearerToken: 'startup-token'.padEnd(40, 's'),
          maxLegacySessions: 0,
          config,
        }),
      /DAEMON_SESSION_LIMIT_INVALID/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('daemon rejects malformed bearer before verifier and owns idle TCP sockets through close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-mcp-socket-close-'))
  const root = join(dir, 'root')
  await Promise.all([mkdir(root), mkdir(join(dir, 'state'))])
  let verifierCalls = 0
  const token = 'socket-boundary-token'.padEnd(40, 'k')
  const daemon = await startSearchDaemon({
    host: '127.0.0.1',
    authorize: async () => {
      verifierCalls++
      return { principalId: 'socket-client', rootIds: ['root'], operations: ['read'] }
    },
    allowedHosts: ['127.0.0.1'],
    config: { version: 1, dataDir: join(dir, 'state'), roots: [{ id: 'root', path: root }] },
  })
  try {
    for (const authorization of [undefined, 'Bearer ***', 'Bearer    ']) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: '127.0.0.1',
            port: daemon.port,
            path: daemon.path,
            headers: { ...(authorization ? { Authorization: authorization } : {}) },
          },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          },
        )
        req.on('error', reject)
        req.end()
      })
      assert.equal(status, 401)
    }
    assert.equal(verifierCalls, 0)
    const socket = connectTcp(daemon.port, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    socket.write(`GET ${daemon.path} HTTP/1.1\r\nHost: 127.0.0.1:${daemon.port}\r\nAuthorization:`)
    const remoteSocketClosed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('REMOTE_SOCKET_CLOSE_NOT_OBSERVED'))
      }, 2_000)
      socket.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.on('error', () => {})
    })
    let closeCompleted = false
    const closing = daemon.close().finally(() => {
      closeCompleted = true
    })
    await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, 500))])
    assert.equal(closeCompleted, true)
    await remoteSocketClosed
    assert.equal(socket.destroyed, true)
    socket.destroy()
  } finally {
    await daemon.close().catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  }
})

test('daemon bounds authorization jobs and joins them after shutdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-mcp-auth-'))
  const root = join(dir, 'root')
  await Promise.all([mkdir(root), mkdir(join(dir, 'state'))])
  const token = 'authorization-token'.padEnd(40, 'a')
  const entered: AbortSignal[] = []
  const daemon = await startSearchDaemon({
    host: '127.0.0.1',
    authorize: (_bearer, signal) =>
      new Promise((_resolve, reject) => {
        entered.push(signal)
        signal.addEventListener('abort', () => reject(new Error('verifier aborted')), {
          once: true,
        })
      }),
    allowedHosts: ['127.0.0.1'],
    config: { version: 1, dataDir: join(dir, 'state'), roots: [{ id: 'root', path: root }] },
  })
  const requests: ReturnType<typeof httpRequest>[] = []
  try {
    const issue = () => {
      const req = httpRequest({
        hostname: '127.0.0.1',
        port: daemon.port,
        path: daemon.path,
        headers: { Authorization: `Bearer ${token}` },
      })
      req.on('error', () => undefined)
      req.end()
      requests.push(req)
    }
    for (let index = 0; index < 32; index++) issue()
    for (let index = 0; index < 100 && entered.length < 32; index++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(entered.length, 32)
    const overflow = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: daemon.port,
          path: daemon.path,
          headers: { Authorization: `Bearer ${token}` },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(overflow, 503)
    await daemon.close()
    assert.ok(entered.every((signal) => signal.aborted))
  } finally {
    requests.forEach((req) => req.destroy())
    await daemon.close().catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  }
})

test('daemon accepts only explicitly allowed reverse-proxy authorities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-mcp-proxy-host-'))
  const root = join(dir, 'root')
  await Promise.all([mkdir(root), mkdir(join(dir, 'state'))])
  const daemon = await startSearchDaemon({
    host: '127.0.0.1',
    authorize: async () => ({
      principalId: 'proxy-client',
      rootIds: ['root'],
      operations: ['read'],
    }),
    allowedHosts: ['search.example:443'],
    allowedOrigins: ['https://search.example'],
    config: { version: 1, dataDir: join(dir, 'state'), roots: [{ id: 'root', path: root }] },
  })
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: daemon.port,
          path: daemon.path,
          headers: {
            Host: 'search.example:443',
            Origin: 'https://search.example',
            Authorization: `Bearer ${'proxy-token'.padEnd(40, 'p')}`,
          },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 400)
  } finally {
    await daemon.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('authorization deadline aborts the verifier and daemon close joins its physical settlement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-mcp-auth-deadline-'))
  const root = join(dir, 'root')
  await Promise.all([mkdir(root), mkdir(join(dir, 'state'))])
  let releaseVerifier!: () => void
  const verifierGate = new Promise<void>((resolve) => {
    releaseVerifier = resolve
  })
  let verifierSignal: AbortSignal | undefined
  const daemon = await startSearchDaemon({
    host: '127.0.0.1',
    authorize: async (_bearer, signal) => {
      verifierSignal = signal
      await verifierGate
      return undefined
    },
    allowedHosts: ['127.0.0.1'],
    config: { version: 1, dataDir: join(dir, 'state'), roots: [{ id: 'root', path: root }] },
  })
  try {
    const response = await fetch(`http://127.0.0.1:${daemon.port}${daemon.path}`, {
      headers: { Authorization: `Bearer ${'deadline-token'.padEnd(40, 'd')}` },
    })
    assert.equal(response.status, 401)
    assert.equal(verifierSignal?.aborted, true)
    let settled = false
    const closing = daemon.close().finally(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(settled, false)
    releaseVerifier()
    await closing
  } finally {
    releaseVerifier()
    await daemon.close().catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  }
})

test('MCP bounds combined text and structured output from a real tool call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-mcp-output-cap-'))
  const root = join(dir, 'root')
  await Promise.all([mkdir(root), mkdir(join(dir, 'state'))])
  const daemon = await startSearchDaemon({
    host: '127.0.0.1',
    bearerToken: 'output-cap-token'.padEnd(40, 'o'),
    allowedHosts: ['127.0.0.1'],
    config: {
      version: 1,
      dataDir: join(dir, 'state'),
      roots: [{ id: 'root', path: root }],
      web: { discovery: { secret: { kind: 'env', name: 'WEB_TEST_KEY' } } },
    },
    runtimeOptions: {
      testDependencies: {
        env: { WEB_TEST_KEY: 'fixture-only' },
        webSource: {
          async discover() {
            return ['https://source.example.test/large']
          },
          async fetchDocument(url) {
            return {
              url,
              title: 'Large fixture',
              text: '漢'.repeat(190_000),
              fetchedAt: new Date().toISOString(),
              publishedAt: null,
              sourceUpdatedAt: null,
            }
          },
        },
      },
    },
  })
  const client = new Client(
    { name: 'output-cap-test', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  )
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}${daemon.path}`), {
        requestInit: { headers: { Authorization: `Bearer ${'output-cap-token'.padEnd(40, 'o')}` } },
      }),
    )
    const result = await client.callTool({
      name: 'read_web_source',
      arguments: { url: 'https://source.example.test/large', maxChars: 200_000 },
    })
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), /RESPONSE_TOO_LARGE/)
  } finally {
    await client.close().catch(() => undefined)
    await daemon.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('MCP preserves checked provider quota codes while redacting provider response details', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-mcp-provider-error-'))
  const root = join(dir, 'root')
  await Promise.all([mkdir(root), mkdir(join(dir, 'state'))])
  const token = 'provider-error-token'.padEnd(40, 'e')
  let providerCalls = 0
  const daemon = await startSearchDaemon({
    host: '127.0.0.1',
    bearerToken: token,
    allowedHosts: ['127.0.0.1'],
    config: {
      version: 1,
      dataDir: join(dir, 'state'),
      roots: [{ id: 'root', path: root }],
      classifier: { model: 'offline-test', secret: { kind: 'env', name: 'CLASSIFIER_TEST_KEY' } },
    },
    runtimeOptions: {
      testDependencies: {
        env: { CLASSIFIER_TEST_KEY: 'never-return-this-secret' },
        fetch: async () => {
          providerCalls++
          return new Response(
            JSON.stringify({
              error: 'private provider response',
              token: 'never-return-this-secret',
            }),
            { status: 402 },
          )
        },
      },
    },
  })
  const client = new Client(
    { name: 'provider-error-test', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  )
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}${daemon.path}`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    )
    const result = await client.callTool({
      name: 'classify',
      arguments: { text: 'fixture', labels: ['yes', 'no'], criteria: 'Choose a label' },
    })
    assert.equal(providerCalls, 1)
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), /PROVIDER_QUOTA/)
    assert.doesNotMatch(
      JSON.stringify(result),
      /private provider response|never-return-this-secret/,
    )
  } finally {
    await client.close().catch(() => undefined)
    await daemon.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('stdio proxy rejects redirects before forwarding bearer credentials', async () => {
  await assert.rejects(
    () =>
      runSearchMcpStdioProxy(
        new URL('http://search.example.test/mcp'),
        'remote-token'.padEnd(40, 't'),
      ),
    /MCP_ENDPOINT_INVALID/,
  )
  let redirectedRequests = 0
  const destination = createHttpServer((_req, res) => {
    redirectedRequests++
    res.writeHead(200).end()
  })
  await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve))
  const address = destination.address()
  assert.ok(address && typeof address !== 'string')
  const redirector = createHttpServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${address.port}/steal` }).end()
  })
  await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve))
  const redirectAddress = redirector.address()
  assert.ok(redirectAddress && typeof redirectAddress !== 'string')
  try {
    await assert.rejects(() =>
      runSearchMcpStdioProxy(
        new URL(`http://127.0.0.1:${redirectAddress.port}/mcp`),
        'redirect-secret'.padEnd(40, 'r'),
      ),
    )
    assert.equal(redirectedRequests, 0)
  } finally {
    await Promise.all([
      new Promise<void>((resolve, reject) =>
        redirector.close((error) => (error ? reject(error) : resolve())),
      ),
      new Promise<void>((resolve, reject) =>
        destination.close((error) => (error ? reject(error) : resolve())),
      ),
    ])
  }
})

test('stdio proxy filters foreign tools and binds exposed schemas and hints to local contracts', async () => {
  let foreignCalls = 0
  const httpServer = createHttpServer((req, res) => {
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: 'hostile-test', version: '1.0.0' })
      server.registerTool('capabilities', { inputSchema: z.object({}).strict() }, () => ({
        content: [{ type: 'text', text: '{}' }],
      }))
      server.registerTool(
        'edit_source',
        { description: 'Edit files now', inputSchema: z.object({ path: z.string() }) },
        () => {
          foreignCalls++
          return { content: [{ type: 'text', text: 'edited' }] }
        },
      )
      return server
    })
    void toNodeHandler(handler)(req, res).catch(() => undefined)
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  assert.ok(address && typeof address !== 'string')
  const client = new Client({ name: 'proxy-surface-test', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "import { runSearchMcpStdioProxy } from './src/mcp/stdio.ts'; await runSearchMcpStdioProxy(new URL(process.env.SEARCH_ENDPOINT), process.env.SEARCH_TOKEN)",
    ],
    cwd: process.cwd(),
    env: {
      ...process.env,
      SEARCH_ENDPOINT: `http://127.0.0.1:${address.port}/mcp`,
      SEARCH_TOKEN: 'local-proxy-test-token',
    },
    stderr: 'pipe',
  })
  try {
    await client.connect(transport)
    const list = await client.listTools()
    assert.deepEqual(
      list.tools.map((tool) => tool.name),
      ['capabilities'],
    )
    assert.equal(list.tools[0]?.description, 'Return enabled Search capabilities.')
    assert.equal(list.tools[0]?.annotations?.readOnlyHint, true)
    await assert.rejects(() =>
      client.callTool({ name: 'edit_source', arguments: { path: 'owned.ts' } }),
    )
    assert.equal(foreignCalls, 0)
  } finally {
    await client.close().catch(() => undefined)
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

async function rawMcpPost(port: number, path: string, token: string, body: unknown) {
  return new Promise<{ status: number; body: string; sessionId?: string }>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
      },
      (res) => {
        let response = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          response += chunk
        })
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: response,
            sessionId: Array.isArray(res.headers['mcp-session-id'])
              ? res.headers['mcp-session-id'][0]
              : res.headers['mcp-session-id'],
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}
