import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { openSearchRuntime, SearchRuntimeError } from '../../src/runtime/index.js'
import { createSearchMcpServer, type SearchMcpRuntime } from '../../src/mcp/server.js'

test('HTTP read_source returns a validated bounded recovery request for strict EOF refusal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-read-recovery-'))
  const root = join(dir, 'root')
  const dataDir = join(dir, 'state')
  await Promise.all([mkdir(root), mkdir(dataDir)])
  const source = Array.from({ length: 57 }, (_, index) => `line ${index + 1}`).join('\n')
  await writeFile(join(root, 'range.ts'), source)
  const runtime = await openSearchRuntime({ config: { version: 1, dataDir, roots: [{ id: 'repo', path: root }] } })
  await runtime.indexRepository({ rootId: 'repo' })
  const snapshotId = (await runtime.indexStatus({ rootId: 'repo' })).identity?.snapshotId
  assert.match(snapshotId ?? '', /^[a-f0-9]{64}$/u)
  const servers: Array<ReturnType<typeof createHttpServer>> = []
  const clients: Client[] = []
  const connect = async (access: SearchMcpRuntime, operations: Array<'read' | 'index'>) => {
    const handler = createMcpHandler(() => createSearchMcpServer(access, { rootIds: ['repo'], operations }))
    const http = createHttpServer((request, response) => { void toNodeHandler(handler)(request, response).catch(() => undefined) })
    servers.push(http)
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve) })
    const address = http.address()
    assert.ok(address && typeof address !== 'string')
    const client = new Client({ name: 'read-recovery-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)))
    return client
  }

  try {
    const client = await connect(runtime, ['read'])
    const originalRequest = { rootId: 'repo', path: 'range.ts', lineStart: 1, lineEnd: 58 }
    const failed = await client.callTool({ name: 'read_source', arguments: originalRequest })
    assert.equal(failed.isError, true)
    const failure = JSON.parse(failed.content[0]?.type === 'text' ? failed.content[0].text : '{}') as {
      error: string
      recovery?: { fileLineCount: number; maxDefaultLines: number; requestedRangeFulfilled: boolean; readSourceRequest: Record<string, unknown> }
    }
    assert.equal(failure.error, 'CODE_INDEX_LINE_RANGE_INVALID')
    assert.deepEqual(failure.recovery, {
      fileLineCount: 57,
      maxDefaultLines: 200,
      requestedRangeFulfilled: false,
      readSourceRequest: { rootId: 'repo', path: 'range.ts', lineStart: 1, snapshotId },
    })
    assert.equal('lineEnd' in (failure.recovery?.readSourceRequest ?? {}), false)
    assert.deepEqual(originalRequest, { rootId: 'repo', path: 'range.ts', lineStart: 1, lineEnd: 58 })
    const recovered = await client.callTool({ name: 'read_source', arguments: failure.recovery!.readSourceRequest })
    assert.notEqual(recovered.isError, true)
    const body = recovered.structuredContent as { text: string; contentHash: string; snapshotId: string; lineStart: number; lineEnd: number; fileLineCount: number }
    assert.equal(body.text, source)
    assert.equal(body.contentHash, createHash('sha256').update(source).digest('hex'))
    assert.equal(body.snapshotId, snapshotId)
    assert.equal(body.lineStart, 1)
    assert.equal(body.lineEnd, 57)
    assert.equal(body.fileLineCount, 57)

    const deniedClient = await connect(runtime, ['index'])
    const denied = await deniedClient.callTool({ name: 'read_source', arguments: originalRequest })
    assert.equal(denied.isError, true)
    assert.doesNotMatch(JSON.stringify(denied), /recovery/u)

    await writeFile(join(root, 'range.ts'), `${source}\nchanged`)
    const stale = await client.callTool({ name: 'read_source', arguments: originalRequest })
    assert.equal(stale.isError, true)
    assert.doesNotMatch(JSON.stringify(stale), /recovery/u)

    const errorRuntime = (error: Error) => ({
      capabilities: () => ({ code: true, embedding: false, webEmbedding: false, codeReranking: false, webReranking: false, webRead: false, webDiscovery: false, classification: false, reuseContext: false, visual: false, projectText: false, projectTextIndexing: false }),
      async readSource() { throw error },
    }) as unknown as SearchMcpRuntime
    const legacyClient = await connect(errorRuntime(new SearchRuntimeError('CODE_INDEX_LINE_RANGE_INVALID')), ['read'])
    const legacy = await legacyClient.callTool({ name: 'read_source', arguments: originalRequest })
    assert.equal(legacy.isError, true)
    assert.doesNotMatch(JSON.stringify(legacy), /recovery/u)

    const cancelledError = Object.assign(new SearchRuntimeError('CANCELLED'), {
      sourceReadRecovery: { fileLineCount: 57, lineStart: 1, snapshotId, maxDefaultLines: 200 },
    })
    const cancelledClient = await connect(errorRuntime(cancelledError), ['read'])
    const cancelled = await cancelledClient.callTool({ name: 'read_source', arguments: originalRequest })
    assert.equal(cancelled.isError, true)
    assert.doesNotMatch(JSON.stringify(cancelled), /recovery/u)

    const maliciousError = Object.assign(new SearchRuntimeError('CODE_INDEX_LINE_RANGE_INVALID'), {
      sourceReadRecovery: { fileLineCount: 57, lineStart: 1, snapshotId, maxDefaultLines: 200, secret: 'fixture-secret-must-not-leak' },
      details: { message: 'fixture-message-must-not-leak' },
    })
    const maliciousClient = await connect(errorRuntime(maliciousError), ['read'])
    const malicious = await maliciousClient.callTool({ name: 'read_source', arguments: originalRequest })
    assert.equal(malicious.isError, true)
    assert.doesNotMatch(JSON.stringify(malicious), /recovery|fixture-secret|fixture-message/u)

    const malformedMetadata = Object.defineProperty({
      fileLineCount: 57,
      snapshotId,
      maxDefaultLines: 200,
    }, 'lineStart', {
      enumerable: true,
      get() { throw new Error('malformed-accessor-secret-must-not-leak') },
    })
    const malformedError = new SearchRuntimeError('CODE_INDEX_LINE_RANGE_INVALID')
    Object.defineProperty(malformedError, 'sourceReadRecovery', { value: malformedMetadata })
    const malformedClient = await connect(errorRuntime(malformedError), ['read'])
    const malformed = await malformedClient.callTool({ name: 'read_source', arguments: originalRequest })
    assert.equal(malformed.isError, true)
    assert.doesNotMatch(JSON.stringify(malformed), /recovery|malformed-accessor-secret/u)
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)))
    await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
      if (!server.listening) return resolve()
      server.close((error) => error ? reject(error) : resolve())
    })))
    await runtime.close()
    await rm(dir, { recursive: true, force: true })
  }
})
