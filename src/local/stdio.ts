import { spawn } from 'node:child_process'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { McpServer, type CallToolResult, type StandardSchemaWithJSON, type Transport } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { node24DaemonExecArgv } from '../cli/node24.js'
import { workspaceIdForCanonicalPath } from '../bridge/protocol.js'
import { isSameOrDescendantPath } from '../runtime/path.js'
import { PACKAGE_VERSION } from '../package-version.js'
import { buildSearchMcpInstructions } from '../mcp/instructions.js'
import { SEARCH_MCP_TOOL_CONTRACTS } from '../mcp/contracts.js'
import { LocalConfigError } from './config.js'
import { loadLocalConfigFile } from './config-file.js'
import { canonicalCurrentWorkspace, inspectLocalOwner, type LocalOwnerService } from './owner.js'
import { parseLocalConversationIdentity } from './conversation.js'

const maxOwnerStartupMs = 20_000
const sourceTypescript = import.meta.url.endsWith('.ts')
const ownerEntry = fileURLToPath(new URL(sourceTypescript ? './owner-entry.ts' : './owner-entry.js', import.meta.url))
const ownerLoaderArgs = sourceTypescript ? ['--import', import.meta.resolve('tsx')] : []

interface LocalCallContext { mcpReq?: { signal?: AbortSignal } }

export interface RunLocalMcpStdioOptions {
  transport?: Transport
  ownerEntryPath?: string
  ownerNodeArgs?: readonly string[]
  startupTimeoutMs?: number
  spawnOwner?: typeof spawn
}

export interface LocalStdioHandle {
  readonly server: McpServer
  readonly transport: Transport
  readonly ownerPid: number
  close(): Promise<void>
}

function failure(code: string) {
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: code }) }] }
}

function asResult(value: unknown): CallToolResult {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as CallToolResult).content))
    throw new Error('LOCAL_OWNER_PROTOCOL_INVALID')
  return value as CallToolResult
}

async function assertWorkspaceIdentity(expected: { path: string; dev: number; ino: number }): Promise<void> {
  const actual = await canonicalCurrentWorkspace()
  if (actual.canonicalPath !== expected.path || actual.dev !== expected.dev || actual.ino !== expected.ino)
    throw new Error('LOCAL_WORKSPACE_CHANGED')
}

async function waitForOwner(
  config: unknown,
  configPath: string,
  configDir: string,
  canonicalPath: string,
  options: RunLocalMcpStdioOptions,
): Promise<{ pid: number; service: LocalOwnerService; workspaceId: string }> {
  const deadline = Date.now() + (options.startupTimeoutMs ?? maxOwnerStartupMs)
  let launched = false
  while (Date.now() < deadline) {
    const owner = await inspectLocalOwner(config, configDir)
    if (owner.state === 'ready') {
      if (owner.canonicalPath !== canonicalPath || owner.service.packageVersion !== PACKAGE_VERSION)
        throw new Error('LOCAL_OWNER_MISMATCH')
      return { pid: owner.pid, service: owner.service, workspaceId: owner.workspaceId }
    }
    if (owner.state === 'starting') {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
      continue
    }
    if (!launched) {
      const childEntry = options.ownerEntryPath ?? ownerEntry
      const spawnOwner = options.spawnOwner ?? spawn
      const child = spawnOwner(process.execPath, [
        ...node24DaemonExecArgv(process.versions.node),
        ...(options.ownerNodeArgs ?? ownerLoaderArgs),
        childEntry,
        '--config',
        configPath,
      ], {
        cwd: canonicalPath,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env },
      })
      child.unref()
      launched = true
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error('LOCAL_OWNER_START_TIMEOUT')
}

export async function runLocalMcpStdio(configPath: string, options: RunLocalMcpStdioOptions = {}): Promise<LocalStdioHandle> {
  const input = await loadLocalConfigFile(configPath)
  const configCanonical = resolve(input.path)
  const workspace = await canonicalCurrentWorkspace()
  if (isSameOrDescendantPath(workspace.canonicalPath, configCanonical) || isSameOrDescendantPath(configCanonical, workspace.canonicalPath))
    throw new LocalConfigError('LOCAL_CONFIG_INVALID')
  const owner = await waitForOwner(input.value, input.path, input.configDir, workspace.canonicalPath, options)
  const configValue = input.value as { clientId?: unknown }
  if (typeof configValue.clientId !== 'string' || workspaceIdForCanonicalPath(configValue.clientId, workspace.canonicalPath) !== owner.workspaceId)
    throw new Error('LOCAL_OWNER_MISMATCH')
  const endpoint = new URL(`http://127.0.0.1:${owner.service.port}/mcp`)
  const coreClient = new Client({ name: 'zorya-search-local-client', version: PACKAGE_VERSION })
  const coreTransport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: { Authorization: `Bearer ${owner.service.token}` },
      redirect: 'error',
    },
  })
  const server = new McpServer({ name: 'zorya-search', version: PACKAGE_VERSION }, {
    instructions: buildSearchMcpInstructions(Object.keys(SEARCH_MCP_TOOL_CONTRACTS), {
      reuseContext: 'unknown', projectText: 'unknown', webDiscovery: 'unknown', webRead: 'unknown',
      classification: 'unknown', visual: 'unknown',
    }),
  })
  const active = new Set<Promise<unknown>>()
  const controllers = new Set<AbortController>()
  let accepting = true
  let closing: Promise<void> | undefined
  try {
    await coreClient.connect(coreTransport)
    const listed = await coreClient.listTools()
    const tools = listed.tools.map((tool) => tool.name).filter((name) => Object.hasOwn(SEARCH_MCP_TOOL_CONTRACTS, name))
    for (const name of tools) {
      const contract = SEARCH_MCP_TOOL_CONTRACTS[name as keyof typeof SEARCH_MCP_TOOL_CONTRACTS]
      if (!contract) continue
      server.registerTool(name, {
        description: contract.description,
        inputSchema: contract.schema as unknown as StandardSchemaWithJSON,
        annotations: contract.annotations,
      }, async (inputArgs, ctx) => {
        if (!accepting) return failure('CANCELLED')
        const parsed = contract.schema.safeParse(inputArgs)
        if (!parsed.success) return failure('INVALID_REQUEST')
        const args = parsed.data as Record<string, unknown>
        if (Object.hasOwn(args, 'rootId') && args.rootId !== 'workspace') return failure('ROOT_NOT_AUTHORIZED')
        let native: { meta: Record<string, unknown>; conversationId: string }
        try { native = parseLocalConversationIdentity(ctx) } catch { return failure('CONVERSATION_UNRESOLVED') }
        const controller = new AbortController()
        controllers.add(controller)
        const requestSignal = (ctx as LocalCallContext).mcpReq?.signal
        const signal = AbortSignal.any([controller.signal, ...(requestSignal ? [requestSignal] : [])])
        const operation = (async () => {
          let localVerification: 'workspace_unchanged_during_call' | 'failed_currentness' | 'not_verified' = 'not_verified'
          try {
          let result: CallToolResult = failure('LOCAL_WORKSPACE_CHANGED') as CallToolResult
          try {
            await assertWorkspaceIdentity({ path: workspace.canonicalPath, dev: workspace.dev, ino: workspace.ino })
            localVerification = 'workspace_unchanged_during_call'
          } catch { result = failure('LOCAL_WORKSPACE_CHANGED') as CallToolResult }
          if (localVerification === 'workspace_unchanged_during_call') {
            try { result = asResult(await coreClient.callTool({ name, arguments: args, _meta: native.meta }, { signal })) }
            catch { result = failure(signal.aborted ? 'CANCELLED' : 'LOCAL_OWNER_UNAVAILABLE') as CallToolResult }
          }
          try { await assertWorkspaceIdentity({ path: workspace.canonicalPath, dev: workspace.dev, ino: workspace.ino }) }
          catch { localVerification = 'failed_currentness'; if (!result.isError) result = failure('LOCAL_WORKSPACE_CHANGED') as CallToolResult }
          if (result.isError && localVerification !== 'failed_currentness') localVerification = 'not_verified'
          const priorMeta = result._meta
          if (priorMeta !== undefined && (!priorMeta || typeof priorMeta !== 'object' || Array.isArray(priorMeta) || Object.hasOwn(priorMeta, 'zorya-search/local')))
            return failure('LOCAL_OWNER_PROTOCOL_INVALID')
          const structured = result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)
            ? result.structuredContent as Record<string, unknown>
            : undefined
          const identity = structured?.identity && typeof structured.identity === 'object' && !Array.isArray(structured.identity)
            ? structured.identity as Record<string, unknown>
            : undefined
          const provenance = {
            clientInstanceId: configValue.clientId,
            workspaceId: owner.workspaceId,
            conversationId: native.conversationId,
            origin: 'current_local_workspace',
            localVerification,
            ...(typeof identity?.snapshotId === 'string' ? { snapshotId: identity.snapshotId } : {}),
            ...(typeof identity?.contentHash === 'string' && /^[0-9a-f]{64}$/u.test(identity.contentHash) ? { contentHash: identity.contentHash } : {}),
          }
          result = { ...result, _meta: { ...(priorMeta as Record<string, unknown> | undefined ?? {}), 'zorya-search/local': provenance } }
          return result
          } finally { controllers.delete(controller) }
        })()
        active.add(operation)
        try { return await operation } finally { active.delete(operation) }
      })
    }
    if (tools.length !== listed.tools.length) throw new Error('LOCAL_OWNER_PROTOCOL_INVALID')
    const transport = options.transport ?? new StdioServerTransport()
    await server.connect(transport)
    return Object.freeze({
      server,
      transport,
      ownerPid: owner.pid,
      close() {
        if (!closing) closing = (async () => {
          accepting = false
          for (const controller of controllers) controller.abort(new Error('LOCAL_STDIO_CLOSED'))
          await Promise.allSettled([...active])
          await server.close().catch(() => undefined)
          await coreTransport.terminateSession().catch(() => undefined)
          await coreClient.close().catch(() => undefined)
          await coreTransport.close().catch(() => undefined)
        })()
        return closing
      },
    })
  } catch (error) {
    await server.close().catch(() => undefined)
    await coreTransport.terminateSession().catch(() => undefined)
    await coreClient.close().catch(() => undefined)
    await coreTransport.close().catch(() => undefined)
    throw error
  }
}

/** Stop only the authenticated owner for this validated current workspace. */
export async function stopLocalOwner(configPath: string, options: { timeoutMs?: number } = {}): Promise<void> {
  const input = await loadLocalConfigFile(configPath)
  const configCanonical = resolve(input.path)
  const workspace = await canonicalCurrentWorkspace()
  if (isSameOrDescendantPath(workspace.canonicalPath, configCanonical) || isSameOrDescendantPath(configCanonical, workspace.canonicalPath))
    throw new LocalConfigError('LOCAL_CONFIG_INVALID')
  const deadline = Date.now() + (options.timeoutMs ?? maxOwnerStartupMs)
  while (Date.now() < deadline) {
    const owner = await inspectLocalOwner(input.value, input.configDir, { allowProfileMismatch: true })
    if (owner.state === 'missing') return
    if (owner.state === 'starting') {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
      continue
    }
    if (owner.canonicalPath !== workspace.canonicalPath) throw new Error('LOCAL_OWNER_MISMATCH')
    const response = await fetch(`http://127.0.0.1:${owner.service.port}/_control/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.service.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(Math.min(5_000, Math.max(100, deadline - Date.now()))),
    }).catch(() => { throw new Error('LOCAL_OWNER_UNAVAILABLE') })
    if (response.status !== 202) throw new Error('LOCAL_OWNER_UNAVAILABLE')
    await assertWorkspaceIdentity({ path: workspace.canonicalPath, dev: workspace.dev, ino: workspace.ino })
    while (Date.now() < deadline) {
      const current = await inspectLocalOwner(input.value, input.configDir, { allowProfileMismatch: true })
      if (current.state === 'missing') return
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }
    throw new Error('LOCAL_OWNER_STOP_TIMEOUT')
  }
  throw new Error('LOCAL_OWNER_STOP_TIMEOUT')
}
