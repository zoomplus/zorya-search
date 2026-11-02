import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { test } from 'node:test'
import { startSearchDaemon } from '../../src/daemon/index.js'
import { parseRemoteIpPolicy } from '../../src/daemon/remote-ip.js'
import type { SearchIpAccessPolicy } from '../../src/daemon/ip-access.js'

const policyInput = {
  resource: 'https://startzorya.com/mcp/search',
  allowedHosts: ['startzorya.com'],
  allowedCidrs: ['127.0.0.0/8'],
  trustedProxyCidrs: [],
  allowedOrigins: ['https://chat.example'],
  principalId: 'chat-client',
  rootIds: ['repo'],
  operations: ['read'],
}

test('IP mode initializes and lists MCP tools without bearer and advertises only filtered noauth tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-remote-ip-'))
  const root = join(dir, 'root')
  const otherRoot = join(dir, 'other')
  await Promise.all([mkdir(root), mkdir(otherRoot), mkdir(join(dir, 'state'))])
  await writeFile(join(root, 'needle.ts'), 'export const ipModeNeedle = "snapshot-bound-source"\n')
  const config = { version: 1, dataDir: join(dir, 'state'), roots: [{ id: 'repo', path: root }, { id: 'other', path: otherRoot }] }
  const policy = parseRemoteIpPolicy(policyInput, ['repo', 'other'])
  const mutablePolicy = structuredClone(policyInput) as unknown as SearchIpAccessPolicy
  const mutableHosts = ['startzorya.com']
  const mutableOrigins = ['https://chat.example']
  const daemon = await startSearchDaemon({
    config, host: '127.0.0.1', allowedHosts: mutableHosts, allowedOrigins: mutableOrigins, ipAccessPolicy: mutablePolicy,
  })
  ;(mutablePolicy.rootIds as string[]).push('other')
  ;(mutablePolicy.operations as string[]).push('index')
  ;(mutablePolicy.allowedOrigins as string[]).push('https://evil.example')
  mutableHosts[0] = 'evil.example'
  mutableOrigins[0] = 'https://evil.example'
  await daemon.runtime.indexRepository({ rootId: 'repo' })
  const exchange = (body: unknown, sessionId?: string) => new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const text = JSON.stringify(body)
    const req = httpRequest({
      hostname: '127.0.0.1', port: daemon.port, path: '/mcp', method: 'POST',
      headers: {
        Host: 'startzorya.com', Origin: 'https://chat.example', Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text),
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
    }, (res) => {
      let response = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { response += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: response }))
    })
    req.on('error', reject)
    req.end(text)
  })
  const data = (body: string) => JSON.parse(body.split('\n').find((line) => line.startsWith('data: '))!.slice(6)) as { result?: { tools?: Array<{ name: string; _meta?: { securitySchemes?: Array<{ type: string }> } }>; content?: unknown[]; structuredContent?: Record<string, unknown>; isError?: boolean }; error?: unknown }
  const fetchWithAuthority = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
    headers.set('host', 'startzorya.com')
    headers.set('origin', 'https://chat.example')
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const body = init?.body ?? null
    return await new Promise<Response>((resolve, reject) => {
      const request = httpRequest({ hostname: url.hostname, port: Number(url.port), path: `${url.pathname}${url.search}`, method, headers: Object.fromEntries(headers) }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers as HeadersInit })))
      })
      request.on('error', reject)
      if (body instanceof ReadableStream) {
        void new Response(body).arrayBuffer().then((bytes) => request.end(Buffer.from(bytes)), reject)
      } else request.end(body ? Buffer.from(body as ArrayBufferView) : undefined)
    })
  }
  try {
    const client = new Client({ name: 'remote-ip-modern-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp`), {
      fetch: fetchWithAuthority,
      requestInit: { headers: { Accept: 'application/json, text/event-stream' } },
    })
    await client.connect(transport)
    assert.equal(client.getProtocolEra(), 'modern')
    const sdkTools = await client.listTools()
    assert.ok(sdkTools.tools.every((tool) => tool._meta?.securitySchemes?.[0]?.type === 'noauth'))
    await client.close()
    for (const protocolVersion of ['2025-03-26']) {
      const initialize = await exchange({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'remote-ip-test', version: '1.0.0' } } })
      assert.equal(initialize.status, 200)
      const sessionId = initialize.headers['mcp-session-id']
      assert.equal(typeof sessionId, 'string')
      const listedResponse = await exchange({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId)
      assert.equal(listedResponse.status, 200)
      const listed = data(listedResponse.body).result?.tools ?? []
      assert.ok(listed.length > 0)
      assert.ok(listed.every((tool) => tool._meta?.securitySchemes?.[0]?.type === 'noauth'))
      assert.ok(listed.some((tool) => tool.name === 'search_code'))
      assert.equal(listed.some((tool) => tool.name === 'index_repository'), false)
      assert.equal(listed.some((tool) => tool.name === 'search_web'), false)
      const deniedRoots = await exchange({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_code', arguments: { rootId: 'other', query: 'needle' } } }, sessionId)
      assert.equal(data(deniedRoots.body).result?.isError, true)
      for (const [id, name, args] of [
        [4, 'index_repository', { rootId: 'repo' }],
        [5, 'search_web', { query: 'needle' }],
        [6, 'classify', { text: 'needle' }],
        [7, 'search_visual_references', { query: 'needle', references: [] }],
      ] as const) {
        const denied = await exchange({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, sessionId)
        assert.ok(data(denied.body).error || data(denied.body).result?.isError)
      }
      const search = await exchange({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'search_code', arguments: { rootId: 'repo', query: 'ipModeNeedle', mode: 'lexical' } } }, sessionId)
      const searchContent = JSON.stringify(data(search.body).result)
      assert.match(searchContent, /needle\.ts/u)
      assert.match(searchContent, /snapshotId/u)
      assert.match(searchContent, /contentHash/u)
      const searchResult = data(search.body).result?.structuredContent as { identity?: { snapshotId?: string } } | undefined
      assert.ok(searchResult?.identity?.snapshotId)
      const read = await exchange({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'read_source', arguments: { rootId: 'repo', path: 'needle.ts', lineStart: 1, snapshotId: searchResult!.identity!.snapshotId } } }, sessionId)
      assert.match(JSON.stringify(data(read.body).result), /snapshot-bound-source/u)
      const readResult = data(read.body).result?.structuredContent as { contentHash?: string; snapshotId?: string; stale?: boolean } | undefined
      assert.match(readResult?.contentHash ?? '', /^[a-f0-9]{64}$/u)
      assert.equal(readResult?.snapshotId, searchResult!.identity!.snapshotId)
      assert.equal(readResult?.stale, false)
      await exchange({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, sessionId)
    }
  } finally {
    await daemon.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('IP mode denies invalid Host and Origin with 403 and no bearer challenge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-remote-ip-host-'))
  const root = join(dir, 'root')
  await Promise.all([mkdir(root), mkdir(join(dir, 'state'))])
  const policy = parseRemoteIpPolicy(policyInput, ['repo'])
  const daemon = await startSearchDaemon({
    config: { version: 1, dataDir: join(dir, 'state'), roots: [{ id: 'repo', path: root }] },
    host: '127.0.0.1', allowedHosts: policy.allowedHosts, allowedOrigins: policy.allowedOrigins, ipAccessPolicy: policy,
  })
  const request = (host: string, origin: string, authorization?: string) => new Promise<{ status: number; challenge?: string }>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: daemon.port, path: '/mcp', headers: { Host: host, Origin: origin, ...(authorization ? { Authorization: authorization } : {}) } }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0, challenge: res.headers['www-authenticate'] }))
    })
    req.on('error', reject)
    req.end()
  })
  try {
    assert.deepEqual(await request('attacker.example', 'https://chat.example'), { status: 403, challenge: undefined })
    assert.deepEqual(await request('startzorya.com', 'https://evil.example'), { status: 403, challenge: undefined })
    assert.deepEqual(await request('startzorya.com', 'https://chat.example', `Bearer ${'unexpected'.padEnd(40, 'x')}`), { status: 403, challenge: undefined })
  } finally {
    await daemon.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('conflicting auth modes fail before opening runtime config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-remote-ip-modes-'))
  const root = join(dir, 'root')
  await Promise.all([mkdir(root), mkdir(join(dir, 'state'))])
  const config = { version: 1, dataDir: join(dir, 'state'), roots: [{ id: 'repo', path: root }] }
  try {
    await assert.rejects(() => startSearchDaemon({
      configPath: '/missing/config.json',
      bearerToken: 'x'.repeat(40),
      ipAccessPolicy: parseRemoteIpPolicy(policyInput, ['repo']),
    }), /DAEMON_AUTH_MODE_INVALID/)
    await assert.rejects(() => startSearchDaemon({ config, ipAccessPolicy: null as unknown as SearchIpAccessPolicy }), /DAEMON_IP_POLICY_INVALID/)
    await assert.rejects(() => startSearchDaemon({ configPath: '/missing/config.json' }), /DAEMON_OWNER_TOKEN_REQUIRED/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

