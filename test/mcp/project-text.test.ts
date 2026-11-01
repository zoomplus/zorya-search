import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer as createHttpServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { openSearchRuntime } from '../../src/runtime/index.js'
import { createSearchMcpServer } from '../../src/mcp/server.js'

test('project text MCP tools enforce read/index grants and expose only the public source DTO', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-project-text-mcp-'))
  const root = join(dir, 'root')
  await mkdir(root)
  await mkdir(join(dir, 'state'))
  await writeFile(join(root, 'README.md'), '# MCP guide\n\nMCP project text is indexed.\n')
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  const httpServers: Array<ReturnType<typeof createHttpServer>> = []
  const clients: Client[] = []
  try {
    runtime = await openSearchRuntime({
      config: {
        version: 1,
        dataDir: join(dir, 'state'),
        roots: [{ id: 'repo', path: root }],
        projectText: {},
      },
    })

    const connect = async (operations: Array<'read' | 'index'>) => {
      const handler = createMcpHandler(() => createSearchMcpServer(runtime!, { rootIds: ['repo'], operations }, undefined, true))
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
      const client = new Client({ name: 'project-text-mcp-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)))
      return client
    }

    const readClient = await connect(['read'])
    const readTools = await readClient.listTools()
    const readNames = new Set(readTools.tools.map((tool) => tool.name))
    assert.ok(readNames.has('project_text_status'))
    assert.ok(readNames.has('search_project_text'))
    assert.ok(readNames.has('read_project_text'))
    assert.equal(readNames.has('index_project_text'), false)
    const readToolByName = new Map(readTools.tools.map((tool) => [tool.name, tool]))
    assert.equal(readToolByName.get('search_project_text')?.annotations?.readOnlyHint, true)
    assert.equal(readToolByName.get('search_project_text')?.annotations?.openWorldHint, true)
    const deniedCapabilities = await readClient.callTool({ name: 'capabilities', arguments: {} })
    assert.equal((deniedCapabilities.structuredContent as { projectText?: boolean }).projectText, true)
    assert.equal((deniedCapabilities.structuredContent as { projectTextIndexing?: boolean }).projectTextIndexing, false)

    const indexClient = await connect(['index'])
    const indexTools = await indexClient.listTools()
    const indexNames = new Set(indexTools.tools.map((tool) => tool.name))
    assert.equal(indexNames.has('search_project_text'), false)
    assert.equal(indexNames.has('read_project_text'), false)
    assert.ok(indexNames.has('index_project_text'))
    const indexTool = indexTools.tools.find((tool) => tool.name === 'index_project_text')
    assert.equal(indexTool?.annotations?.readOnlyHint, false)
    assert.equal(indexTool?.annotations?.idempotentHint, false)
    assert.equal(indexTool?.annotations?.openWorldHint, true)
    const indexed = await indexClient.callTool({
      name: 'index_project_text',
      arguments: { rootId: 'repo' },
    })
    assert.notEqual(indexed.isError, true)

    const status = await readClient.callTool({
      name: 'project_text_status',
      arguments: { rootId: 'repo' },
    })
    assert.notEqual(status.isError, true)
    const statusText = JSON.stringify(status.structuredContent)
    assert.match(statusText, /"indexedAt":"\d{4}-\d\d-\d\dT/)
    assert.doesNotMatch(statusText, /vector_json|resume|secret|apiKey/iu)

    const searched = await readClient.callTool({
      name: 'search_project_text',
      arguments: {
        rootId: 'repo',
        query: 'project text',
        kinds: ['documentation'],
        mode: 'lexical',
      },
    })
    assert.notEqual(searched.isError, true)
    assert.match(JSON.stringify(searched.structuredContent), /README\.md/)
    const read = await readClient.callTool({
      name: 'read_project_text',
      arguments: { rootId: 'other', path: 'README.md' },
    })
    assert.equal(read.isError, true)
    assert.match(JSON.stringify(read), /ROOT_NOT_AUTHORIZED/)

    const malformed = await readClient.callTool({
      name: 'search_project_text',
      arguments: { rootId: 'repo', query: 'x', kinds: ['not-a-kind'] },
    })
    assert.equal(malformed.isError, true)
    assert.match(JSON.stringify(malformed), /Input validation error/u)
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)))
    await Promise.all(
      httpServers.map(
        (http) =>
          new Promise<void>((resolve, reject) => {
            if (!http.listening) return resolve()
            http.close((error) => (error ? reject(error) : resolve()))
          }),
      ),
    )
    await runtime?.close()
    await rm(dir, { recursive: true, force: true })
  }
})
