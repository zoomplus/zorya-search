import { randomUUID } from 'node:crypto'
import { BridgeContractError } from '../bridge/protocol.js'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer, type CallToolResult, type StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { PACKAGE_VERSION } from '../package-version.js'
import { buildSearchMcpInstructions } from '../mcp/instructions.js'
import { SEARCH_MCP_TOOL_CONTRACTS } from '../mcp/contracts.js'
import { createSearchMcpServer } from '../mcp/server.js'
import type { SearchMcpRuntime } from '../mcp/server.js'
import { LocalWorkspaceError, type LocalWorkspace } from './owner.js'
import { parseLocalConversationIdentity } from './conversation.js'

const sourceQueries = new Set([
  'search_code', 'find_code_duplicates', 'find_code_symbols', 'find_code_references',
  'trace_code_calls', 'read_source', 'related_code', 'get_code_context', 'get_reuse_context',
  'search_project_text', 'read_project_text',
])
const rootId = 'workspace'
interface LocalCallContext { mcpReq?: { signal?: AbortSignal } }

interface JobOwner {
  conversationId: string
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  order: number
}

export interface LocalMcpSharedState {
  readonly jobs: Map<string, JobOwner>
  readonly jobMutex: { tail: Promise<void>; order: number }
}

export function createLocalMcpSharedState(): LocalMcpSharedState {
  return { jobs: new Map(), jobMutex: { tail: Promise.resolve(), order: 0 } }
}

export interface LocalMcpHandle {
  readonly server: McpServer
  close(): Promise<void>
}

function localFailure(code: string) {
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: code }) }] }
}

function asResult(value: unknown): CallToolResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('UPSTREAM_RESULT_INVALID')
  const result = value as CallToolResult
  if (!Array.isArray(result.content)) throw new Error('UPSTREAM_RESULT_INVALID')
  return result
}

function structured(value: CallToolResult): Record<string, unknown> | undefined {
  return value.structuredContent && typeof value.structuredContent === 'object' && !Array.isArray(value.structuredContent)
    ? value.structuredContent as Record<string, unknown>
    : undefined
}

function toolErrorCode(value: CallToolResult): string | undefined {
  if (!value.isError) return undefined
  for (const block of value.content) {
    if (block.type !== 'text') continue
    try {
      const parsed = JSON.parse(block.text) as { error?: unknown }
      if (typeof parsed.error === 'string') return parsed.error
    } catch { /* Unknown tool error text is not interpreted. */ }
  }
  return undefined
}

function jobFrom(value: CallToolResult): Record<string, unknown> | undefined {
  const root = structured(value)
  const job = root?.job
  return job && typeof job === 'object' && !Array.isArray(job) ? job as Record<string, unknown> : undefined
}

function isActiveJob(job: Record<string, unknown> | undefined): job is Record<string, unknown> & { jobId: string; state: 'queued' | 'running' } {
  return Boolean(job && typeof job.jobId === 'string' && (job.state === 'queued' || job.state === 'running'))
}

export async function createLocalMcpServer(workspace: LocalWorkspace, shared = createLocalMcpSharedState()): Promise<LocalMcpHandle> {
  const runtime = workspace.runtime as SearchMcpRuntime
  const core = createSearchMcpServer(runtime, {
    rootIds: [rootId],
    operations: ['read', 'index', 'web', 'classify', 'visual'],
  })
  const coreClient = new Client({ name: 'zorya-search-local-core', version: PACKAGE_VERSION })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const jobs = shared.jobs
  const active = new Set<Promise<unknown>>()
  const controllers = new Set<AbortController>()
  let closing: Promise<void> | undefined
  let accepting = true

  const serializeJobs = async <T>(work: () => Promise<T>): Promise<T> => {
    let release!: () => void
    const turn = new Promise<void>((resolve) => { release = resolve })
    const prior = shared.jobMutex.tail
    shared.jobMutex.tail = prior.then(() => turn)
    await prior
    try { return await work() } finally { release() }
  }

  const callCore = async (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> => {
    const result = await coreClient.callTool({ name, arguments: args }, signal ? { signal } : undefined)
    return asResult(result)
  }

  const ensureCurrent = async (conversationId: string, signal?: AbortSignal): Promise<CallToolResult | undefined> => {
    await workspace.assertCurrent()
    signal?.throwIfAborted()
    const status = await callCore('index_status', { rootId }, signal)
    if (status.isError) return status
    const value = structured(status)
    if (!value) return localFailure('LOCAL_STATUS_INVALID')
    const codeIdentity = value.identity
    const codeCurrent = Boolean(codeIdentity && typeof codeIdentity === 'object' && typeof (codeIdentity as Record<string, unknown>).snapshotId === 'string')
    const project = value.projectTextStatus
    const projectStatus = project && typeof project === 'object' ? project as Record<string, unknown> : undefined
    const projectCurrent = !runtime.capabilities().projectText || Boolean(
      projectStatus && projectStatus.identity && typeof projectStatus.identity === 'object' &&
      typeof projectStatus.snapshotId === 'string' && projectStatus.stale !== true,
    )
    if (codeCurrent && projectCurrent) return undefined
    const currentJob = value.indexingJob && typeof value.indexingJob === 'object'
      ? value.indexingJob as Record<string, unknown>
      : undefined
    if (isActiveJob(currentJob)) {
      const owner = jobs.get(currentJob.jobId)
      return localFailure(owner?.conversationId === conversationId ? 'LOCAL_INDEXING_IN_PROGRESS' : 'LOCAL_JOB_OWNERSHIP_CONFLICT')
    }
    signal?.throwIfAborted()
    await workspace.assertCurrent()
    const indexed = await callCore('index_repository', { rootId }, signal)
    if (indexed.isError) return indexed
    await workspace.assertCurrent()
    return undefined
  }

  const currentJobStatus = async (args: Record<string, unknown>, conversationId: string, signal?: AbortSignal): Promise<CallToolResult> => {
    const requested = typeof args.jobId === 'string' ? args.jobId : undefined
    if (requested) {
      const owner = jobs.get(requested)
      if (!owner || owner.conversationId !== conversationId) return localFailure('JOB_NOT_FOUND')
    }
    const result = await callCore('index_status', args, signal)
    if (result.isError) return result
    const status = structured(result)
    const job = status?.indexingJob && typeof status.indexingJob === 'object' ? status.indexingJob as Record<string, unknown> : undefined
    if (job && typeof job.jobId === 'string') {
      const owner = jobs.get(job.jobId)
      if (!owner || owner.conversationId !== conversationId) return localFailure('JOB_NOT_FOUND')
      if (typeof job.state === 'string' && ['queued', 'running', 'completed', 'failed', 'cancelled'].includes(job.state))
        owner.state = job.state as JobOwner['state']
    }
    return result
  }

  const startOwnedJob = (args: Record<string, unknown>, conversationId: string, signal?: AbortSignal) => serializeJobs(async () => {
    await workspace.assertCurrent()
    const before = await callCore('index_status', { rootId }, signal)
    if (before.isError) return before
    const beforeStatus = structured(before)
    const existing = beforeStatus?.indexingJob && typeof beforeStatus.indexingJob === 'object'
      ? beforeStatus.indexingJob as Record<string, unknown>
      : undefined
    if (isActiveJob(existing)) {
      const owner = jobs.get(existing.jobId)
      if (!owner || owner.conversationId !== conversationId) return localFailure('LOCAL_JOB_OWNERSHIP_CONFLICT')
    } else {
      for (const [jobId, owner] of jobs.size >= 64 ? [...jobs.entries()].sort((a, b) => a[1].order - b[1].order) : []) {
        // Retain terminal history while capacity remains. At the bound, evict
        // only a state observed as terminal or confirmed absent by the engine.
        if (owner.state !== 'queued' && owner.state !== 'running') {
          jobs.delete(jobId)
        } else {
          const polled = await callCore('index_status', { rootId, jobId }, signal)
          const errorCode = toolErrorCode(polled)
          if (errorCode === 'JOB_NOT_FOUND') jobs.delete(jobId)
          else if (!polled.isError) {
            const status = structured(polled)
            const statusJob = status?.indexingJob && typeof status.indexingJob === 'object' ? status.indexingJob as Record<string, unknown> : undefined
            if (statusJob && statusJob.jobId === jobId && typeof statusJob.state === 'string' && !['queued', 'running'].includes(statusJob.state)) {
              owner.state = statusJob.state as JobOwner['state']
              jobs.delete(jobId)
            }
          }
        }
        if (jobs.size < 64) break
      }
      if (jobs.size >= 64) return localFailure('LOCAL_JOB_LEDGER_FULL')
    }
    const result = await callCore('start_indexing', args, signal)
    if (result.isError) return result
    const job = jobFrom(result)
    if (isActiveJob(job)) {
      const prior = jobs.get(job.jobId)
      if (prior && prior.conversationId !== conversationId) return localFailure('LOCAL_JOB_OWNERSHIP_CONFLICT')
      jobs.set(job.jobId, { conversationId, state: job.state, order: prior?.order ?? ++shared.jobMutex.order })
    } else if (job && typeof job.jobId === 'string') {
      jobs.set(job.jobId, { conversationId, state: 'completed', order: ++shared.jobMutex.order })
    }
    return result
  })

  const cancelOwnedJob = (args: Record<string, unknown>, conversationId: string, signal?: AbortSignal) => serializeJobs(async () => {
    const jobId = typeof args.jobId === 'string' ? args.jobId : ''
    const owner = jobs.get(jobId)
    if (!owner || owner.conversationId !== conversationId) return localFailure('JOB_NOT_FOUND')
    const result = await callCore('cancel_indexing', args, signal)
    if (result.isError) return result
    const job = structured(result)
    if (job && typeof job.state === 'string' && ['queued', 'running', 'completed', 'failed', 'cancelled'].includes(job.state))
      owner.state = job.state as JobOwner['state']
    return result
  })

  let initPromise: Promise<void> | undefined
  const initializeCore = () => (initPromise ??= (async () => {
    await core.connect(serverTransport)
    await coreClient.connect(clientTransport)
  })())
  let tools: string[] = []
  let server: McpServer
  try {
    // The inner MCP server is the source of truth for profile-dependent tool availability.
    await initializeCore()
    const listed = await coreClient.listTools()
    tools = listed.tools.map((tool) => tool.name).filter((name) => Object.hasOwn(SEARCH_MCP_TOOL_CONTRACTS, name))
    const capabilities = runtime.capabilities()
    server = new McpServer({ name: 'zorya-search', version: PACKAGE_VERSION }, {
      instructions: buildSearchMcpInstructions(tools, {
        reuseContext: capabilities.reuseContext,
        projectText: capabilities.projectText,
        webDiscovery: capabilities.webDiscovery,
        webRead: capabilities.webRead,
        classification: capabilities.classification,
        visual: capabilities.visual,
      }),
    })
    for (const name of tools) {
      const contract = SEARCH_MCP_TOOL_CONTRACTS[name as keyof typeof SEARCH_MCP_TOOL_CONTRACTS]
      if (!contract) continue
      server.registerTool(name, {
        description: contract.description,
        inputSchema: contract.schema as unknown as StandardSchemaWithJSON,
        annotations: contract.annotations,
      }, async (input, ctx) => {
        if (!accepting) return localFailure('CANCELLED')
        const parsed = contract.schema.safeParse(input)
        if (!parsed.success) return localFailure('INVALID_REQUEST')
        const args = parsed.data as Record<string, unknown>
        if (Object.hasOwn(args, 'rootId') && args.rootId !== rootId) return localFailure('ROOT_NOT_AUTHORIZED')

        let conversationId: string
        try { conversationId = parseLocalConversationIdentity(ctx).conversationId } catch { return localFailure('CONVERSATION_UNRESOLVED') }
        const controller = new AbortController()
        controllers.add(controller)
        const requestSignal = (ctx as LocalCallContext).mcpReq?.signal
        const signal = AbortSignal.any([controller.signal, ...(requestSignal ? [requestSignal] : [])])
        const operation = (async (): Promise<CallToolResult> => {
          try {
            await workspace.assertCurrent()
            let result: CallToolResult
            if (name === 'index_status') result = await currentJobStatus(args, conversationId, signal)
            else if (name === 'cancel_indexing') result = await cancelOwnedJob(args, conversationId, signal)
            else if (name === 'start_indexing') result = await startOwnedJob(args, conversationId, signal)
            else {
            if (sourceQueries.has(name)) {
              const stale = await ensureCurrent(conversationId, signal)
              if (stale) result = stale
            }
            if (!result!) {
              signal.throwIfAborted()
              await workspace.assertCurrent()
              result = await callCore(name, args, signal)
            }
            }
            if (!result.isError) await workspace.assertCurrent()
            return result
          } catch (error) {
            if (signal.aborted) return localFailure('CANCELLED')
            if (error instanceof LocalWorkspaceError) return localFailure(error.code)
            if (error instanceof BridgeContractError) return localFailure(error.code)
            return localFailure('OPERATION_FAILED')
          } finally { controllers.delete(controller) }
        })()
        active.add(operation)
        try { return await operation } finally { active.delete(operation) }
      })
    }
  } catch (error) {
    await coreClient.close().catch(() => undefined)
    await core.close().catch(() => undefined)
    throw error
  }

  return Object.freeze({
    server,
    async close() {
      if (!closing) closing = (async () => {
        accepting = false
        for (const controller of controllers) controller.abort(new Error('LOCAL_MCP_CLOSED'))
        await Promise.allSettled([...active])
        await server.close().catch(() => undefined)
        await coreClient.close().catch(() => undefined)
        await core.close().catch(() => undefined)
      })()
      await closing
    },
  })
}
