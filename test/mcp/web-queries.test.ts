import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer as createHttpServer } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { openSearchRuntime } from '../../src/runtime/index.js'
import { createSearchMcpServer } from '../../src/mcp/server.js'
import { ProviderError } from '../../src/providers/contracts.js'

test('search_web MCP forwards caller queries and provenance while preserving the web grant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-web-mcp-'))
  const root = join(dir, 'root')
  const dataDir = join(dir, 'state')
  await Promise.all([mkdir(root), mkdir(dataDir)])
  const discoveryCalls: string[] = []
  const fetched: string[] = []
  const runtime = await openSearchRuntime({
    config: {
      version: 1,
      dataDir,
      roots: [{ id: 'repo', path: root }],
      web: { discovery: { secret: { kind: 'env', name: 'BRAVE_KEY' } } },
    },
    testDependencies: {
      env: { BRAVE_KEY: 'fixture-only' },
      webSource: {
        async discover(query) {
          discoveryCalls.push(query)
          if (query === 'provider failure') throw new ProviderError('rate_limit', 429, 250)
          return query === 'main query'
            ? ['https://source.example.test/shared?utm_source=fixture#main']
            : ['https://source.example.test/shared', 'https://source.example.test/other']
        },
        async fetchDocument(url) {
          fetched.push(url)
          return {
            url,
            title: 'Fixture page',
            text: 'MCP caller selected the additional query.',
            fetchedAt: '2026-11-01T00:00:00.000Z',
            publishedAt: null,
            sourceUpdatedAt: null,
          }
        },
      },
    },
  })
  const httpServers: Array<ReturnType<typeof createHttpServer>> = []
  const clients: Client[] = []
  const connect = async (operations: Array<'read' | 'web'>) => {
    const handler = createMcpHandler(() =>
      createSearchMcpServer(runtime, { rootIds: ['repo'], operations }),
    )
    const http = createHttpServer((request, response) => {
      void toNodeHandler(handler)(request, response).catch(() => undefined)
    })
    httpServers.push(http)
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(0, '127.0.0.1', resolve)
    })
    const address = http.address()
    assert.ok(address && typeof address !== 'string')
    const client = new Client({ name: 'web-query-mcp-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)))
    return client
  }

  try {
    const webClient = await connect(['web'])
    const tools = await webClient.listTools()
    const searchTool = tools.tools.find((tool) => tool.name === 'search_web')
    assert.ok(searchTool)
    assert.match(searchTool.description ?? '', /additional queries/u)
    assert.equal(searchTool.inputSchema.properties?.additionalQueries !== undefined, true)

    const dateRange = { from: '2026-01-01', through: '2026-01-31' }
    const result = await webClient.callTool({
      name: 'search_web',
      arguments: { query: 'main query', additionalQueries: ['caller query'], dateRange },
    })
    assert.notEqual(result.isError, true)
    assert.deepEqual(discoveryCalls, ['main query', 'caller query'])
    assert.deepEqual(fetched, ['https://source.example.test/shared', 'https://source.example.test/other'])
    const structured = result.structuredContent as {
      passages: Array<{ canonicalURL: string; queryIndexes?: number[] }>
      discovery: { queries: Array<{ query: string }> }
    }
    const shared = structured.passages.find((passage) => passage.canonicalURL === 'https://source.example.test/shared')
    assert.deepEqual(shared?.queryIndexes, [0, 1])
    assert.deepEqual(structured.discovery.queries.map(({ query }) => query), ['main query', 'caller query'])

    const safeFailure = await webClient.callTool({
      name: 'search_web',
      arguments: { query: 'main query', additionalQueries: ['provider failure'] },
    })
    assert.notEqual(safeFailure.isError, true)
    const failedStructured = safeFailure.structuredContent as {
      errors: Array<{ queryIndex?: number; provider?: { code?: string; httpStatus?: number } }>
    }
    assert.deepEqual(failedStructured.errors, [{
      stage: 'discovery',
      code: 'DISCOVERY_FAILED',
      queryIndex: 1,
      provider: { code: 'rate_limit', httpStatus: 429, retryAfterMs: 250 },
    }])

    const legacy = await webClient.callTool({ name: 'search_web', arguments: { query: 'legacy query' } })
    assert.notEqual(legacy.isError, true)
    const legacyStructured = legacy.structuredContent as Record<string, unknown> & {
      passages: Array<Record<string, unknown>>
    }
    assert.equal('discovery' in legacyStructured, false)
    assert.equal('queryIndexes' in (legacyStructured.passages[0] ?? {}), false)

    const deniedClient = await connect(['read'])
    const deniedTools = await deniedClient.listTools()
    assert.ok(deniedTools.tools.some((tool) => tool.name === 'search_web'))
    const denied = await deniedClient.callTool({
      name: 'search_web',
      arguments: { query: 'must not run', additionalQueries: ['also must not run'] },
    })
    assert.equal(denied.isError, true)
    assert.match(JSON.stringify(denied), /ACCESS_DENIED/u)
    assert.deepEqual(discoveryCalls, [
      'main query', 'caller query',
      'main query', 'provider failure',
      'legacy query',
    ])

    const invalid = await webClient.callTool({
      name: 'search_web',
      arguments: { query: 'main query', additionalQueries: ['   '] },
    })
    assert.equal(invalid.isError, true)
    assert.match(JSON.stringify(invalid), /Input validation error/u)
    assert.deepEqual(discoveryCalls, [
      'main query', 'caller query',
      'main query', 'provider failure',
      'legacy query',
    ])
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)))
    await Promise.all(httpServers.map((http) => new Promise<void>((resolve, reject) => {
      if (!http.listening) return resolve()
      http.close((error) => error ? reject(error) : resolve())
    })))
    await runtime.close()
    await rm(dir, { recursive: true, force: true })
  }
})
