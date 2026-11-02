import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { McpServer, type CallToolResult, type StandardSchemaWithJSON, type Transport } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { BridgeClientError, type BridgeHttpClient } from './client.js'
import { bindCurrentWorkspace, type NativeCallMetadata } from './workspace.js'
import { BridgeContractError, type BridgeRequest, type BridgeResponse, type BridgeScope } from './protocol.js'
import { SEARCH_MCP_TOOL_CONTRACTS } from '../mcp/contracts.js'
import { buildSearchMcpInstructions } from '../mcp/instructions.js'
import { PACKAGE_VERSION } from '../package-version.js'

const sourceFreeTools = new Set([
  'list_roots', 'capabilities', 'index_status', 'cancel_indexing', 'project_text_status',
  'search_web', 'read_web_source', 'classify', 'search_visual_references',
])
const indexingTools = new Set(['index_repository', 'start_indexing', 'index_code_symbols', 'index_project_text'])
const bridgeMetadataKey = 'zorya-search/bridge'
type BridgeSnapshotProvenance = Extract<BridgeResponse, { action: 'call'; ok: true }>['provenance']

export interface BridgeMcpServerOptions {
  client: BridgeHttpClient
  clientInstanceId: string
  allowedDocumentPaths?: readonly string[]
  exclude?: string[]
  ownerSignal?: AbortSignal
}

export interface BridgeMcpServerHandle {
  readonly server: McpServer
  close(): Promise<void>
}

interface NativeRequestContext {
  _meta?: unknown
  threadId?: unknown
  signal?: AbortSignal
}

interface ActiveCall {
  readonly controller: AbortController
  readonly promise: Promise<unknown>
}

function failure(code: string, extra?: Record<string, unknown>) {
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: code, ...extra }) }] }
}

function bridgeCode(error: unknown): string {
  return error instanceof BridgeContractError ? error.code : 'OPERATION_FAILED'
}

function nativeCall(ctx: unknown): NativeCallMetadata {
  const context = ctx as { mcpReq?: NativeRequestContext; threadId?: unknown } | undefined
  const request = context?.mcpReq
  if (!request || typeof request !== 'object') throw new BridgeContractError('CONVERSATION_UNRESOLVED')
  const aliases = [request.threadId, context?.threadId].filter((value) => value !== undefined)
  if (aliases.length > 1 && aliases.some((value) => value !== aliases[0]))
    throw new BridgeContractError('CONVERSATION_UNRESOLVED')
  return { _meta: request._meta, ...(aliases.length ? { threadId: aliases[0] } : {}) }
}

function callSignal(ctx: unknown, controller: AbortController, ownerSignal?: AbortSignal): AbortSignal {
  const requestSignal = (ctx as { mcpReq?: NativeRequestContext } | undefined)?.mcpReq?.signal
  return AbortSignal.any([
    controller.signal,
    ...(requestSignal ? [requestSignal] : []),
    ...(ownerSignal ? [ownerSignal] : []),
  ])
}

function hasRootId(input: unknown): input is { rootId: unknown } {
  return input !== null && typeof input === 'object' && !Array.isArray(input) && Object.hasOwn(input, 'rootId')
}

async function assertBoundCwd(canonicalPath: string): Promise<void> {
  try {
    if (await realpath(resolve(process.cwd())) !== canonicalPath) throw new BridgeContractError('WORKSPACE_CHANGED')
  } catch (error) {
    if (error instanceof BridgeContractError) throw error
    throw new BridgeContractError('WORKSPACE_CHANGED')
  }
}

function withProvenance(
  result: CallToolResult,
  provenance: BridgeSnapshotProvenance,
  localManifestHash?: string,
): CallToolResult {
  const priorMeta = result._meta
  if (priorMeta !== undefined && (!priorMeta || typeof priorMeta !== 'object' || Array.isArray(priorMeta)))
    throw new BridgeContractError('UPSTREAM_PROTOCOL_ERROR')
  const meta = priorMeta && typeof priorMeta === 'object' && !Array.isArray(priorMeta)
    ? priorMeta as Record<string, unknown>
    : {}
  if (Object.hasOwn(meta, bridgeMetadataKey)) throw new BridgeContractError('UPSTREAM_PROTOCOL_ERROR')
  const bridgeProvenance = localManifestHash === undefined
    ? provenance
    : {
        ...provenance,
        origin: 'bound_current_workspace',
        localVerification: 'manifest_matched',
        localManifestHash,
      }
  return { ...result, _meta: { ...meta, [bridgeMetadataKey]: bridgeProvenance } } as CallToolResult
}

function protocolFailure(
  error: { code: number; message: string; data?: unknown },
  provenance: BridgeSnapshotProvenance,
  localManifestHash?: string,
): CallToolResult {
  const bridgeProvenance = localManifestHash === undefined
    ? provenance
    : {
        ...provenance,
        origin: 'bound_current_workspace',
        localVerification: 'manifest_matched',
        localManifestHash,
      }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { kind: 'protocol_error', ...error } }) }],
    structuredContent: { error: { kind: 'protocol_error', ...error } },
    _meta: { [bridgeMetadataKey]: { ...bridgeProvenance, upstreamProtocolError: error } },
  }
}

export function createBridgeMcpServer(options: BridgeMcpServerOptions): BridgeMcpServerHandle {
  const toolNames = Object.keys(SEARCH_MCP_TOOL_CONTRACTS)
  const server = new McpServer(
    { name: 'zorya-search-bridge', version: PACKAGE_VERSION },
    { instructions: buildSearchMcpInstructions(toolNames, {
      reuseContext: 'unknown', projectText: 'unknown', webDiscovery: 'unknown', webRead: 'unknown',
      classification: 'unknown', visual: 'unknown',
    }) },
  )
  const active = new Set<ActiveCall>()
  let closing: Promise<void> | undefined
  let accepting = true

  const cancelDelegated = async (
    scope: BridgeScope,
    generation: number | null,
    manifestHash: string | null,
    targetOperationId: string,
  ): Promise<boolean> => {
    try {
      const response = await options.client.request({
        schemaVersion: 1, operationId: randomUUID(), scope, action: 'cancel',
        targetGeneration: generation, expectedManifestHash: manifestHash, targetOperationId,
      }, AbortSignal.timeout(10_000))
      return response.ok && response.action === 'cancel' && response.settled &&
        response.targetOperationId === targetOperationId && response.targetGeneration === generation &&
        response.expectedManifestHash === manifestHash
    } catch { return false }
  }

  const bridgeCall = async (
    scope: BridgeScope,
    toolName: string,
    args: Record<string, unknown>,
    generation: number | null,
    manifestHash: string | null,
    signal: AbortSignal,
  ): Promise<{ result?: CallToolResult; protocolError?: { code: number; message: string; data?: unknown }; provenance: BridgeSnapshotProvenance }> => {
    const operationId = randomUUID()
    let sent = false
    let responseReceived = false
    try {
      const request: BridgeRequest = {
        schemaVersion: 1, operationId, scope, action: 'call', generation,
        expectedManifestHash: manifestHash, toolName, arguments: args,
      }
      if (signal.aborted) throw new BridgeContractError('CANCELLED')
      sent = true
      const response = await options.client.request(request, signal)
      responseReceived = true
      if (!response.ok || response.action !== 'call')
        throw new BridgeContractError(response.ok ? 'UPSTREAM_PROTOCOL_ERROR' : response.error.code)
      if (response.result.kind === 'protocol_error') {
        return { protocolError: response.result.error, provenance: response.provenance }
      }
      return { result: response.result.result as CallToolResult, provenance: response.provenance }
    } catch (error) {
      const localRefusal = error instanceof BridgeContractError && [
        'AUTH', 'CONFIG_INVALID', 'INVALID_REQUEST', 'REQUEST_TOO_LARGE',
      ].includes(error.code)
      const cancelledBeforeSend = error instanceof BridgeContractError && error.code === 'CANCELLED' && !signal.aborted
      if (sent && !responseReceived && !localRefusal && !cancelledBeforeSend) {
        const settled = await cancelDelegated(scope, generation, manifestHash, operationId)
        if (!settled) {
          const code = bridgeCode(error) as BridgeContractError['code']
          throw new BridgeClientError(code, 'Bridge call settlement is unconfirmed', 'unconfirmed', error)
        }
      }
      throw error
    }
  }

  const register = <K extends keyof typeof SEARCH_MCP_TOOL_CONTRACTS>(name: K) => {
    const contract = SEARCH_MCP_TOOL_CONTRACTS[name]
    server.registerTool(name, {
      description: contract.description,
      inputSchema: contract.schema as unknown as StandardSchemaWithJSON,
      annotations: contract.annotations,
    }, async (input, ctx) => {
      if (!accepting) return failure('CANCELLED')
      const parsed = contract.schema.safeParse(input)
      if (!parsed.success) return failure('INVALID_REQUEST')
      const args = parsed.data as Record<string, unknown>
      if (hasRootId(args) && args.rootId !== 'workspace') return failure('ROOT_NOT_AUTHORIZED')

      const controller = new AbortController()
      const signal = callSignal(ctx, controller, options.ownerSignal)
      const promise = (async () => {
        try {
          const workspace = await bindCurrentWorkspace({
            clientInstanceId: options.clientInstanceId,
            call: nativeCall(ctx),
            ...(options.allowedDocumentPaths ? { allowedDocumentPaths: options.allowedDocumentPaths } : {}),
            ...(options.exclude ? { exclude: options.exclude } : {}),
            rootLabel: 'workspace',
          })
          if (sourceFreeTools.has(name)) {
            await assertBoundCwd(workspace.canonicalPath)
            const outcome = await bridgeCall(workspace.scope, name, args, null, null, signal)
            if (outcome.protocolError) return protocolFailure(outcome.protocolError, outcome.provenance)
            const { result, provenance } = outcome
            if (!result) throw new BridgeContractError('UPSTREAM_PROTOCOL_ERROR')
            return withProvenance(result, provenance)
          }

          let generation: number
          let manifestHash: string
          if (indexingTools.has(name)) {
            const snapshot = await workspace.scan(signal)
            const synchronized = await options.client.synchronizeWorkspace({ workspace, snapshot, signal })
            generation = synchronized.generation
            manifestHash = synchronized.manifestHash
            await assertBoundCwd(workspace.canonicalPath)
          } else {
            const status = await options.client.request({
              schemaVersion: 1, operationId: randomUUID(), scope: workspace.scope, action: 'status',
            }, signal)
            if (!status.ok || status.action !== 'status' || status.generation === null || status.manifestHash === null)
              throw new BridgeContractError(status.ok ? 'SNAPSHOT_UNAVAILABLE' : status.error.code)
            const before = await workspace.scan(signal)
            if (before.manifest.manifestHash !== status.manifestHash) throw new BridgeContractError('STALE_GENERATION')
            generation = status.generation
            manifestHash = status.manifestHash
            const outcome = await bridgeCall(workspace.scope, name, args, generation, manifestHash, signal)
            const after = await workspace.scan(signal)
            if (after.manifest.manifestHash !== manifestHash) throw new BridgeContractError('STALE_GENERATION')
            if (outcome.protocolError) return protocolFailure(outcome.protocolError, outcome.provenance, manifestHash)
            if (!outcome.result) throw new BridgeContractError('UPSTREAM_PROTOCOL_ERROR')
            return withProvenance(outcome.result, outcome.provenance, manifestHash)
          }
          const outcome = await bridgeCall(workspace.scope, name, args, generation, manifestHash, signal)
          const after = await workspace.scan(signal)
          if (after.manifest.manifestHash !== manifestHash) throw new BridgeContractError('STALE_GENERATION')
          if (outcome.protocolError) return protocolFailure(outcome.protocolError, outcome.provenance, manifestHash)
          if (!outcome.result) throw new BridgeContractError('UPSTREAM_PROTOCOL_ERROR')
          return withProvenance(outcome.result, outcome.provenance, manifestHash)
        } catch (error) {
          const code = bridgeCode(error)
          const extra = error instanceof BridgeClientError ? {
            ...(error.settlement ? { settlement: error.settlement } : {}),
            ...(error.publication ? { publication: error.publication } : {}),
            ...(error.committed ? { committed: true } : {}),
          } : undefined
          return failure(code, extra)
        }
      })()
      const tracked: ActiveCall = { controller, promise }
      active.add(tracked)
      try { return await promise } finally { active.delete(tracked) }
    })
  }

  for (const name of toolNames) register(name as keyof typeof SEARCH_MCP_TOOL_CONTRACTS)

  const close = () => (closing ??= (async () => {
    accepting = false
    for (const call of active) call.controller.abort(new Error('BRIDGE_MCP_CLOSED'))
    await Promise.allSettled([...active].map((call) => call.promise))
    await new Promise<void>((resolve) => setImmediate(resolve))
    await server.close().catch(() => undefined)
  })())
  return Object.freeze({ server, close })
}

export interface RunBridgeMcpStdioOptions extends BridgeMcpServerOptions {
  transport?: Transport
}

export async function runBridgeMcpStdio(options: RunBridgeMcpStdioOptions): Promise<BridgeMcpServerHandle & { transport: Transport }> {
  const transport = options.transport ?? new StdioServerTransport()
  const handle = createBridgeMcpServer(options)
  try {
    transport.onclose = () => { void handle.close() }
    transport.onerror = () => { void handle.close() }
    await handle.server.connect(transport)
    return Object.freeze({
      server: handle.server,
      transport,
      close: async () => {
        await handle.close()
        await transport.close().catch(() => undefined)
      },
    })
  } catch (error) {
    await handle.close()
    throw error
  }
}
