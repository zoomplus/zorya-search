import {
  McpServer,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server'
import type { z as Zod } from 'zod'
import {
  SEARCH_RUNTIME_ERROR_CODES,
  SearchRuntimeError,
  type openSearchRuntime,
} from '../runtime/index.js'
import { parseSourceReadRecovery, readRequest } from '../runtime/requests.js'
import { PACKAGE_VERSION } from '../package-version.js'
import { compactReuseContext } from './reuse-presentation.js'
import { buildSearchMcpInstructions, type SearchMcpInstructionCapabilities } from './instructions.js'
import {
  getSearchCapabilityAvailability,
  getSearchMcpSetupHint,
  SEARCH_SETUP_CAPABILITIES,
  type SearchMcpOperation,
  type SearchSetupCapabilityField,
} from './setup-guidance.js'
import { SEARCH_MCP_TOOL_CONTRACTS, requiredOperationsForTool } from './contracts.js'

export {
  SEARCH_MCP_TOOL_CONTRACTS,
  SEARCH_MCP_TOOL_OPERATIONS,
  SEARCH_MCP_TOOL_REQUIRED_OPERATIONS,
  requiredOperationsForTool,
} from './contracts.js'

export type SearchMcpRuntime = Awaited<ReturnType<typeof openSearchRuntime>>
export interface SearchMcpAccess {
  rootIds: readonly string[]
  operations: readonly ('read' | 'index' | 'web' | 'classify' | 'visual')[]
}

export function createSearchMcpServer(
  runtime: SearchMcpRuntime,
  access: SearchMcpAccess,
  ownerSignal?: AbortSignal,
  filterUnauthorizedTools = false,
  oauthScopesAdvertised = false,
  noauthAdvertised = false,
) {
  const roots = new Set([...access.rootIds])
  const operationValues = [...access.operations]
  const validOperation = (value: string) => ['read', 'index', 'web', 'classify', 'visual'].includes(value)
  if (
    access.rootIds.length > 32 ||
    operationValues.length > 5 ||
    roots.size > 32 ||
    [...roots].some((id) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(id)) ||
    operationValues.some((operation) => !validOperation(operation))
  )
    throw new Error('MCP_ACCESS_INVALID')
  const operations = new Set<SearchMcpOperation>(operationValues)
  const registeredToolNames: string[] = []
  const registerTools: Array<(server: McpServer) => void> = []

  const add = <K extends keyof typeof SEARCH_MCP_TOOL_CONTRACTS>(
    name: K,
    work: (
      input: Zod.infer<(typeof SEARCH_MCP_TOOL_CONTRACTS)[K]['schema']>,
      signal?: AbortSignal,
    ) => Promise<unknown> | unknown,
  ) => {
    const requiredOperations = requiredOperationsForTool(name)
    if (!requiredOperations) return
    const missingRequired = requiredOperations.some((operation) => !operations.has(operation))
    if (missingRequired && (filterUnauthorizedTools || name === 'get_reuse_context')) return
    const contract = SEARCH_MCP_TOOL_CONTRACTS[name]
    registeredToolNames.push(name)
    registerTools.push((server) => {
      server.registerTool(
        name,
        {
          description: contract.description,
          inputSchema: contract.schema as unknown as StandardSchemaWithJSON,
          annotations: contract.annotations,
          ...(oauthScopesAdvertised || noauthAdvertised
            ? { _meta: { securitySchemes: oauthScopesAdvertised ? [{ type: 'oauth2', scopes: requiredOperations.map((operation) => `zorya:${operation}`) }] : [{ type: 'noauth' }] } }
            : {}),
        },
        async (input, ctx) => {
          if (requiredOperations.some((operation) => !operations.has(operation))) return failure('ACCESS_DENIED')
          const parsed = contract.schema.safeParse(input)
          if (!parsed.success) return failure('INVALID_REQUEST')
          input = parsed.data as typeof input
          const requestRoot =
            input && typeof input === 'object' && 'rootId' in input
              ? String((input as { rootId: unknown }).rootId)
              : undefined
          if (requestRoot && !roots.has(requestRoot)) return failure('ROOT_NOT_AUTHORIZED')
          try {
            const signal = ownerSignal
              ? AbortSignal.any([ctx.mcpReq.signal, ownerSignal])
              : ctx.mcpReq.signal
            const result = await work(
              input as Zod.infer<(typeof SEARCH_MCP_TOOL_CONTRACTS)[K]['schema']>,
              signal,
            )
            if (name === 'get_reuse_context' && (input as { responseDetail?: string }).responseDetail !== 'full') {
              return boundedCompactSuccess(
                compactReuseContext(
                  String((input as { rootId: string }).rootId),
                  result as Parameters<typeof compactReuseContext>[1],
                ),
              )
            }
            return boundedSuccess(result)
          } catch (error) {
            const code = safeCode(error)
            if (name === 'read_source' && error instanceof SearchRuntimeError) {
              const recoveryDescriptor = Object.getOwnPropertyDescriptor(error, 'sourceReadRecovery')
              const recovery = parseSourceReadRecovery(
                recoveryDescriptor && 'value' in recoveryDescriptor ? recoveryDescriptor.value : undefined,
              )
              if (error.code === 'CODE_INDEX_LINE_RANGE_INVALID' && recovery) {
                const pointer = readRequest.safeParse({
                  rootId: String((input as { rootId: string }).rootId),
                  path: String((input as { path: string }).path),
                  lineStart: recovery.lineStart,
                  snapshotId: recovery.snapshotId,
                })
                if (pointer.success) {
                  return failure(code, {
                    fileLineCount: recovery.fileLineCount,
                    maxDefaultLines: 200,
                    requestedRangeFulfilled: false,
                    readSourceRequest: pointer.data,
                  })
                }
              }
            }
            return failure(code)
          }
        },
      )
    })
  }
  add('list_roots', () => runtime.listRoots().filter((root) => roots.has(root.id)))
  add('capabilities', () => {
    const capabilities = runtime.capabilities()
    const configured: Readonly<Record<SearchSetupCapabilityField, boolean>> = {
      projectText: capabilities.projectText,
      webRead: capabilities.webRead,
      webDiscovery: capabilities.webDiscovery,
      visual: capabilities.visual,
      embedding: capabilities.embedding,
      projectTextEmbedding: capabilities.projectTextEmbedding,
      classification: capabilities.classification,
    }
    const capabilityAvailability = getSearchCapabilityAvailability(operations, configured)
    const setupOptions = SEARCH_SETUP_CAPABILITIES
      .filter((capability) => capabilityAvailability[capability].status === 'not_configured')
      .map((capability) => getSearchMcpSetupHint(capability))
    const reuseAllowed = operations.has('read') && operations.has('classify')
    const reuseContextAvailability = {
      status: !reuseAllowed ? 'access_denied' : capabilities.reuseContext ? 'available' : 'not_configured',
      requiredOperations: ['read', 'classify'],
    } as const
    const web = operations.has('web')
    return {
      ...capabilities,
      setupOptions,
      capabilityAvailability,
      reuseContextAvailability,
      code: operations.has('read') && capabilities.code,
      codeReranking: operations.has('read') && capabilities.codeReranking,
      embedding: operations.has('read') && capabilities.embedding,
      webEmbedding: web && capabilities.webEmbedding,
      webReranking: web && capabilities.webReranking,
      webRead: web && capabilities.webRead,
      webDiscovery: web && capabilities.webDiscovery,
      classification: operations.has('classify') && capabilities.classification,
      reuseContext: operations.has('read') && operations.has('classify') && capabilities.reuseContext,
      visual: operations.has('visual') && capabilities.visual,
      projectText: operations.has('read') && capabilities.projectText,
      projectTextIndexing: operations.has('index') && capabilities.projectTextIndexing,
      projectTextEmbedding: operations.has('read') && capabilities.projectTextEmbedding,
      projectTextReranking: operations.has('read') && capabilities.projectTextReranking,
    }
  })
  add('index_status', (input, signal) =>
    runtime.indexStatus({ rootId: input.rootId, ...(input.jobId ? { jobId: input.jobId } : {}), ...(signal ? { signal } : {}) }),
  )
  add('index_repository', (input, signal) =>
    runtime.indexRepository({ ...input, ...(signal ? { signal } : {}) }),
  )
  add('index_code_symbols', (input, signal) =>
    runtime.indexCodeSymbols({ ...input, ...(signal ? { signal } : {}) }),
  )
  add('start_indexing', (input, signal) => runtime.startIndexing({ ...input, ...(signal ? { signal } : {}) }))
  add('cancel_indexing', (input) => runtime.cancelIndexing(input))
  if (runtime.capabilities().projectText) {
    add('project_text_status', (input, signal) =>
      runtime.projectTextStatus({ ...input, ...(signal ? { signal } : {}) }),
    )
    add('index_project_text', (input, signal) =>
      runtime.indexProjectText({ ...input, ...(signal ? { signal } : {}) }),
    )
    add('search_project_text', (input, signal) =>
      runtime.searchProjectText({ ...input, ...(signal ? { signal } : {}) }),
    )
    add('read_project_text', (input, signal) =>
      runtime.readProjectText({ ...input, ...(signal ? { signal } : {}) }),
    )
  }
  add('search_code', (input, signal) =>
    runtime.searchCode({ ...input, ...(signal ? { signal } : {}) } as Parameters<
      typeof runtime.searchCode
    >[0]),
  )
  add('find_code_duplicates', (input, signal) =>
    runtime.findCodeDuplicates({
      ...input,
      ...(signal ? { signal } : {}),
    } as Parameters<typeof runtime.findCodeDuplicates>[0]),
  )
  add('find_code_symbols', (input, signal) =>
    runtime.findCodeSymbols({ ...input, ...(signal ? { signal } : {}) } as Parameters<typeof runtime.findCodeSymbols>[0]),
  )
  add('find_code_references', (input, signal) =>
    runtime.findCodeReferences({ ...input, ...(signal ? { signal } : {}) } as Parameters<typeof runtime.findCodeReferences>[0]),
  )
  add('trace_code_calls', (input, signal) =>
    runtime.traceCodeCalls({ ...input, ...(signal ? { signal } : {}) } as Parameters<typeof runtime.traceCodeCalls>[0]),
  )
  add('read_source', (input, signal) =>
    runtime.readSource({ ...input, ...(signal ? { signal } : {}) } as Parameters<
      typeof runtime.readSource
    >[0]),
  )
  add('related_code', (input, signal) =>
    runtime.relatedCode({ ...input, ...(signal ? { signal } : {}) } as Parameters<
      typeof runtime.relatedCode
    >[0]),
  )
  add('get_code_context', (input, signal) =>
    runtime.getCodeContext({ ...input, ...(signal ? { signal } : {}) } as Parameters<
      typeof runtime.getCodeContext
    >[0]),
  )
  add('get_reuse_context', (input, signal) => {
    const { responseDetail: _responseDetail, ...request } = input
    return runtime.getReuseContext({ ...request, ...(signal ? { signal } : {}) } as Parameters<typeof runtime.getReuseContext>[0])
  })
  add('search_web', (input, signal) =>
    runtime.searchWeb({ ...input, ...(signal ? { signal } : {}) } as Parameters<
      typeof runtime.searchWeb
    >[0]),
  )
  add('read_web_source', (input, signal) =>
    runtime.readWebSource({ ...input, ...(signal ? { signal } : {}) } as Parameters<
      typeof runtime.readWebSource
    >[0]),
  )
  add('classify', (input, signal) =>
    runtime.classify({ ...input, ...(signal ? { signal } : {}) } as Parameters<
      typeof runtime.classify
    >[0]),
  )
  if (runtime.capabilities().visual && operations.has('visual'))
    add('search_visual_references', (input, signal) =>
      runtime.searchVisualReferences({ ...input, ...(signal ? { signal } : {}) } as Parameters<typeof runtime.searchVisualReferences>[0]),
    )
  const grantedToolNames = registeredToolNames.filter((name) =>
    requiredOperationsForTool(name)?.every((operation) => operations.has(operation)),
  )
  const capabilities = runtime.capabilities()
  const instructionCapabilities: SearchMcpInstructionCapabilities = {
    reuseContext: operations.has('read') && operations.has('classify') ? capabilities.reuseContext : 'unknown',
    projectText: operations.has('read') ? capabilities.projectText : 'unknown',
    webDiscovery: operations.has('web') ? capabilities.webDiscovery : 'unknown',
    webRead: operations.has('web') ? capabilities.webRead : 'unknown',
    classification: operations.has('classify') ? capabilities.classification : 'unknown',
    visual: operations.has('visual') ? capabilities.visual : 'unknown',
  }
  const server = new McpServer(
    { name: 'zorya-search', version: PACKAGE_VERSION },
    { instructions: buildSearchMcpInstructions(grantedToolNames, instructionCapabilities) },
  )
  for (const register of registerTools) register(server)
  return server
}

function safeCode(error: unknown): string {
  if (error instanceof SearchRuntimeError && runtimeErrorCodes.has(error.code)) return error.code
  return 'OPERATION_FAILED'
}
const runtimeErrorCodes = new Set(SEARCH_RUNTIME_ERROR_CODES)
function failure(code: string, recovery?: Record<string, unknown>) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: code, ...(recovery ? { recovery } : {}) }) }],
  }
}
function boundedSuccess(result: unknown) {
  const json = JSON.stringify(result)
  const structuredContent =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : { items: result }
  const response = { structuredContent, content: [{ type: 'text' as const, text: json }] }
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 1_000_000)
    return failure('RESPONSE_TOO_LARGE')
  return response
}
function boundedCompactSuccess(result: Record<string, unknown>) {
  const response = {
    structuredContent: result,
    content: [{ type: 'text' as const, text: 'Compact reuse context v1 is available in structuredContent.' }],
  }
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 1_000_000)
    return failure('RESPONSE_TOO_LARGE')
  return response
}
