import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { isIP } from 'node:net'
import { SEARCH_MCP_TOOL_CONTRACTS } from './server.js'
import { PACKAGE_VERSION } from '../package-version.js'
import { buildSearchMcpInstructions } from './instructions.js'

/** Запускает stdio proxy: PGlite и SearchRuntime остаются у уже работающего daemon. */
export async function runSearchMcpStdioProxy(endpoint: URL, bearerToken: string) {
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:')
    throw new Error('MCP_ENDPOINT_INVALID')
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error('MCP_ENDPOINT_INVALID')
  if (endpoint.protocol === 'http:' && !isLoopbackHost(endpoint.hostname))
    throw new Error('MCP_ENDPOINT_INVALID')
  if (!bearerToken || bearerToken.length > 8192) throw new Error('MCP_CREDENTIAL_INVALID')
  const client = new Client(
    { name: 'zorya-search-stdio-proxy', version: PACKAGE_VERSION },
    { versionNegotiation: { mode: 'auto' } },
  )
  const clientTransport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${bearerToken}` }, redirect: 'error' },
  })
  let server: McpServer | undefined
  const operations = new Set<Promise<unknown>>()
  const controllers = new Set<AbortController>()
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      for (const controller of controllers) controller.abort(new Error('STDIO_PROXY_CLOSED'))
      await Promise.allSettled([...operations])
      await server?.close().catch(() => undefined)
      await client.close().catch(() => undefined)
    })())
  try {
    await client.connect(clientTransport)
    const remote = await client.listTools()
    const exposedTools = remote.tools.filter((tool) => Object.hasOwn(SEARCH_MCP_TOOL_CONTRACTS, tool.name))
    server = new McpServer(
      { name: 'zorya-search-stdio-proxy', version: PACKAGE_VERSION },
      {
        instructions: buildSearchMcpInstructions(exposedTools.map((tool) => tool.name), {
          reuseContext: 'unknown',
          projectText: 'unknown',
          webDiscovery: 'unknown',
          webRead: 'unknown',
          classification: 'unknown',
          visual: 'unknown',
        }),
      },
    )
    for (const tool of exposedTools) {
      const contract =
        SEARCH_MCP_TOOL_CONTRACTS[tool.name as keyof typeof SEARCH_MCP_TOOL_CONTRACTS]
      server.registerTool(
        tool.name,
        {
          description: contract.description,
          inputSchema: contract.schema as unknown as StandardSchemaWithJSON,
          annotations: contract.annotations,
        },
        async (args, ctx) => {
          const controller = new AbortController()
          controllers.add(controller)
          const signal = AbortSignal.any([ctx.mcpReq.signal, controller.signal])
          const operation = client.callTool(
            { name: tool.name, arguments: args as Record<string, unknown> },
            { signal },
          )
          operations.add(operation)
          try {
            return await operation
          } catch {
            return {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify({ error: 'UPSTREAM_FAILED' }) }],
            }
          } finally {
            controllers.delete(controller)
            operations.delete(operation)
          }
        },
      )
    }
    const transport = new StdioServerTransport()
    transport.onclose = () => {
      void close()
    }
    transport.onerror = () => {
      void close()
    }
    await server.connect(transport)
    return { server, transport, close }
  } catch (error) {
    await close()
    throw error
  }
}

function isLoopbackHost(hostname: string) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIP(hostname) === 4 && hostname.startsWith('127.')
}
