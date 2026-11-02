import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { createSearchMcpServer } from '../mcp/server.js'
import { openSearchRuntime, type RuntimeConfig } from '../runtime/index.js'
import type { BridgeServerConfig } from './config.js'
import { PACKAGE_VERSION } from '../package-version.js'

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

export function bridgeRuntimeConfig(
  config: BridgeServerConfig,
  sourcePath: string,
  dataPath: string,
  rootLabel?: string,
): RuntimeConfig {
  return {
    ...(config.runtimeTemplate ?? {}),
    version: 1,
    dataDir: dataPath,
    roots: [{ id: 'workspace', path: sourcePath, watch: false, ...(rootLabel ? { label: rootLabel } : {}) }],
  } as RuntimeConfig
}

export function bridgeRuntimeFingerprint(config: BridgeServerConfig): string {
  return createHash('sha256').update(canonicalJson(config.runtimeTemplate ?? {})).digest('hex')
}

export async function openBridgeWorkspaceRuntime(
  config: BridgeServerConfig,
  sourcePath: string,
  dataPath: string,
  rootLabel?: string,
) {
  return openSearchRuntime({
    config: bridgeRuntimeConfig(config, sourcePath, dataPath, rootLabel),
    configDir: config.dataDir,
  })
}

export async function hasActiveBridgeIndexJob(runtime: Awaited<ReturnType<typeof openBridgeWorkspaceRuntime>>): Promise<boolean> {
  const status = await runtime.indexStatus({ rootId: 'workspace' }) as unknown as { indexingJob?: { state?: string } | null }
  return status.indexingJob?.state === 'queued' || status.indexingJob?.state === 'running'
}

export async function callBridgeTool(
  runtime: Awaited<ReturnType<typeof openBridgeWorkspaceRuntime>>,
  operations: readonly ('read' | 'index' | 'web' | 'classify' | 'visual')[],
  toolName: string,
  arguments_: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const inFlight = new Set<Promise<unknown>>()
  const trackedRuntime = new Proxy(runtime, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown
      if (typeof value !== 'function') return value
      return (...arguments_: unknown[]) => {
        const result = Reflect.apply(value, target, arguments_) as unknown
        if (!result || typeof result !== 'object' && typeof result !== 'function' || typeof (result as PromiseLike<unknown>).then !== 'function') return result
        const operation = Promise.resolve(result)
        inFlight.add(operation)
        void operation.then(() => inFlight.delete(operation), () => inFlight.delete(operation))
        return operation
      }
    },
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createSearchMcpServer(trackedRuntime, { rootIds: ['workspace'], operations }, signal, true)
  const client = new Client({ name: 'zorya-search-bridge', version: PACKAGE_VERSION }, { versionNegotiation: { mode: 'auto' } })
  let failure: unknown
  let result: unknown
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    result = await client.callTool({ name: toolName, arguments: arguments_ }, { signal })
  } catch (error) {
    failure = error
  }
  await new Promise<void>((resolve) => setImmediate(resolve))
  while (inFlight.size) await Promise.allSettled([...inFlight])
  const closeResults = await Promise.allSettled([client.close(), server.close()])
  const closeErrors = closeResults.flatMap((item) => item.status === 'rejected' ? [item.reason] : [])
  if (failure !== undefined && closeErrors.length) throw new AggregateError([failure, ...closeErrors])
  if (failure !== undefined) throw failure
  if (closeErrors.length) throw new AggregateError(closeErrors, 'Bridge MCP operation cleanup failed')
  return result
}
