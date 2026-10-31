import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { createCodeIndex } from '../code/index.js'
import { watchCodeRoot } from '../code/watch.js'
import type {
  CodeIndex,
  CodeIndexStatus,
  CodeSearchInput,
  CodeReadInput,
  CodeRelatedInput,
} from '../code/types.js'
import {
  CodeContextError,
  createCodeContext,
  type CodeContextRequest,
  type CodeContextResult,
} from '../context/index.js'
import { createClassificationTool } from '../context/classify.js'
import type { ClassificationResult } from '../providers/contracts.js'
import { createWebSearch, type WebSearchResult } from '../context/web.js'
import { createOpenRouterClassifier } from '../providers/classifier.js'
import { createBraveWebSource } from '../providers/brave.js'
import {
  createOpenAICompatibleEmbedding,
  createOpenRouterEmbedding,
  createOpenRouterReranker,
} from '../providers/openrouter.js'
import { ProviderError, type ProviderLimits } from '../providers/contracts.js'
import { openEmbeddedDatabase } from '../storage/embedded.js'
import type { OwnedDatabase } from '../storage/database.js'
import type { WebSource } from '../core/contracts.js'
import {
  loadRuntimeConfig,
  parseRuntimeConfig,
  readBoundedRegularFile,
  RuntimeConfigError,
  type RuntimeConfig,
} from './config.js'

export {
  loadRuntimeConfig,
  parseRuntimeConfig,
  runtimeConfigSchema,
  RuntimeConfigError,
} from './config.js'
export type { RuntimeConfig } from './config.js'

const idField = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/)
const statusRequest = z.object({ rootId: idField }).strict()
const indexRequest = statusRequest
const searchRequest = z
  .object({
    rootId: idField,
    query: z.string().min(1).max(10_000),
    paths: z.array(z.string().min(1).max(1024)).max(256).optional(),
    language: z.string().min(1).max(64).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    mode: z.enum(['lexical', 'hybrid']).optional(),
  })
  .strict()
const readRequest = z
  .object({
    rootId: idField,
    path: z.string().min(1).max(1024),
    lineStart: z.number().int().min(1).max(10_000_000).optional(),
    lineEnd: z.number().int().min(1).max(10_000_000).optional(),
    snapshotId: z.string().min(1).max(256).optional(),
  })
  .strict()
const relatedRequest = z
  .object({
    rootId: idField,
    path: z.string().min(1).max(1024),
    symbol: z.string().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict()
const contextRequest = z
  .object({
    rootId: idField,
    query: z.string().min(1).max(2000),
    featureQueries: z.array(z.string().min(1).max(2000)).max(8).optional(),
    mustInclude: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1024),
            lineStart: z.number().int().min(1).optional(),
            lineEnd: z.number().int().min(1).optional(),
          })
          .strict(),
      )
      .max(16)
      .optional(),
    includeRelated: z.boolean().optional(),
    maxChars: z.number().int().min(1).max(24_000).optional(),
    limit: z.number().int().min(1).max(40).optional(),
  })
  .strict()
const webSearchRequest = z
  .object({
    query: z.string().min(1).max(2000),
    limit: z.number().int().min(1).max(100).optional(),
    maxChars: z.number().int().min(1).max(100_000).optional(),
  })
  .strict()
const webReadRequest = z
  .object({
    url: z.string().min(1).max(2048),
    maxChars: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict()
const classifyRequest = z
  .object({
    text: z.string().min(1).max(100_000),
    labels: z.array(z.string().min(1).max(256)).min(2).max(100),
    criteria: z.string().min(1).max(10_000),
    examples: z
      .array(
        z.object({ text: z.string().min(1).max(4000), label: z.string().min(1).max(256) }).strict(),
      )
      .max(20)
      .optional(),
    allowMultiple: z.boolean().optional(),
    allowAbstain: z.boolean().optional(),
  })
  .strict()

export class SearchRuntimeError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(`Search runtime operation failed: ${code}`, options)
    this.name = 'SearchRuntimeError'
  }
}
export interface RuntimeRoot {
  id: string
  path: string
  label?: string
}
export interface RuntimeCapabilities {
  code: true
  embedding: boolean
  codeReranking: boolean
  webReranking: boolean
  webRead: boolean
  webDiscovery: boolean
  classification: boolean
  visual: false
}
export interface RuntimeIndexStatus extends CodeIndexStatus {
  watcherError: string | null
  watching: boolean
}
export interface RuntimeWatchStatus {
  enabled: boolean
  active: boolean
  errorCode: string | null
}
export interface RuntimeOptions {
  config: unknown
  configDir?: string
  signal?: AbortSignal
  /** SDK-only injection point for deterministic adapter tests. Never accepted by config or transport inputs. */
  testDependencies?: {
    env?: NodeJS.ProcessEnv
    fetch?: typeof fetch
    webSource?: WebSource
    beforeDatabaseReady?: (signal: AbortSignal) => Promise<void>
    beforeWatchSetup?: (signal: AbortSignal) => Promise<void>
  }
}

type RootEntry = { config: RuntimeConfig['roots'][number]; path: string; dev: number; ino: number }
type Operation = { controller: AbortController; promise: Promise<unknown> }
export async function openSearchRuntime(options: RuntimeOptions) {
  const config = parseRuntimeConfig(options.config)
  assertStartupActive(options.signal)
  const roots = await canonicalRoots(config)
  assertStartupActive(options.signal)
  let configDir: string | undefined
  if (options.configDir) {
    if (!isAbsolute(options.configDir)) throw new RuntimeConfigError('CONFIG_INVALID')
    try {
      configDir = await realpath(options.configDir)
      if (!(await stat(configDir)).isDirectory()) throw new Error()
    } catch {
      throw new RuntimeConfigError('CONFIG_INVALID')
    }
    assertStartupActive(options.signal)
  }
  const secrets = await loadSecrets(config, configDir)
  assertStartupActive(options.signal)
  const resolveSecret = (ref: SecretReference): string => {
    const value =
      ref.kind === 'env'
        ? (options.testDependencies?.env?.[ref.name] ?? process.env[ref.name])
        : secrets?.[ref.key]
    if (typeof value !== 'string' || !value.trim() || value.length > 8192)
      throw new RuntimeConfigError('SECRET_UNAVAILABLE')
    return value
  }
  const fetchOption = options.testDependencies?.fetch
    ? { fetch: options.testDependencies.fetch }
    : {}
  const providers = createProviders(
    config,
    resolveSecret,
    fetchOption,
    options.testDependencies?.webSource,
  )
  assertStartupActive(options.signal)
  let database: OwnedDatabase | undefined
  try {
    database = await openEmbeddedDatabase(config.dataDir)
    await options.testDependencies?.beforeDatabaseReady?.(
      options.signal ?? new AbortController().signal,
    )
    assertStartupActive(options.signal)
    return await createOwnedRuntime(
      config,
      roots,
      database,
      providers,
      options.signal,
      options.testDependencies?.beforeWatchSetup,
    )
  } catch (error) {
    if (!database) throw sanitize(error, options.signal)
    try {
      await database.close()
    } catch (closeError) {
      throw new SearchRuntimeError('STARTUP_CLEANUP_FAILED', undefined, undefined, {
        cause: new AggregateError([error, closeError]),
      })
    }
    throw sanitize(error, options.signal)
  }
}

export async function openSearchRuntimeFromFile(
  path: string,
  options: Omit<RuntimeOptions, 'config' | 'configDir'> = {},
) {
  const loaded = await loadRuntimeConfig(path)
  assertStartupActive(options.signal)
  return openSearchRuntime({ ...options, config: loaded.config, configDir: loaded.configDir })
}

type SecretReference =
  | { kind: 'env'; name: string }
  | { kind: 'file'; file: 'secrets.json'; key: string }
function assertStartupActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SearchRuntimeError('CANCELLED')
}
async function canonicalRoots(config: RuntimeConfig): Promise<RootEntry[]> {
  const entries = await Promise.all(
    config.roots.map(async (item) => {
      try {
        const path = await realpath(resolve(item.path))
        const info = await stat(path)
        if (!info.isDirectory()) throw new Error()
        return { config: item, path, dev: info.dev, ino: info.ino }
      } catch {
        throw new RuntimeConfigError('ROOT_INVALID')
      }
    }),
  )
  if (new Set(entries.map((item) => item.path)).size !== entries.length)
    throw new RuntimeConfigError('CONFIG_INVALID')
  return entries
}

function createProviders(
  config: RuntimeConfig,
  resolveSecret: (ref: SecretReference) => string,
  fetchOption: { fetch?: typeof fetch },
  testWebSource?: WebSource,
) {
  const embedding = config.embedding
    ? (() => {
        const p = config.embedding!
        const shared = {
          model: p.model,
          dimensions: p.dimensions,
          inputType: 'text',
          ...(p.profileId ? { profileId: p.profileId } : {}),
          apiKey: resolveSecret(p.secret),
          ...(p.limits ? { limits: compact(p.limits) } : {}),
          ...fetchOption,
        }
        return p.provider === 'openrouter'
          ? createOpenRouterEmbedding({
              ...shared,
              baseUrl: p.baseUrl ?? 'https://openrouter.ai/api/v1',
            })
          : createOpenAICompatibleEmbedding({
              ...shared,
              baseUrl: p.baseUrl!,
              profileId: p.profileId!,
            })
      })()
    : undefined
  const reranker = config.reranker
    ? createOpenRouterReranker({
        baseUrl: 'https://openrouter.ai/api/v1',
        model: config.reranker.model,
        ...(config.reranker.profileId ? { profileId: config.reranker.profileId } : {}),
        apiKey: resolveSecret(config.reranker.secret),
        ...(config.reranker.limits ? { limits: compact(config.reranker.limits) } : {}),
        ...fetchOption,
      })
    : undefined
  const classifier = config.classifier
    ? createOpenRouterClassifier({
        baseUrl: 'https://openrouter.ai/api/v1',
        model: config.classifier.model,
        ...(config.classifier.profileId ? { profileId: config.classifier.profileId } : {}),
        apiKey: resolveSecret(config.classifier.secret),
        ...(config.classifier.limits ? { limits: compact(config.classifier.limits) } : {}),
        ...fetchOption,
      })
    : undefined
  const webLimits = config.web?.discovery?.limits ?? config.web?.limits
  const braveWeb =
    config.web && !testWebSource
      ? createBraveWebSource({
          ...(config.web.discovery ? { apiKey: resolveSecret(config.web.discovery.secret) } : {}),
          ...(webLimits ? { limits: compact(webLimits) as ProviderLimits } : {}),
          ...fetchOption,
        })
      : undefined
  if (testWebSource && config.web?.discovery) resolveSecret(config.web.discovery.secret)
  return { embedding, reranker, classifier, web: testWebSource ?? braveWeb }
}

async function createOwnedRuntime(
  config: RuntimeConfig,
  roots: RootEntry[],
  database: OwnedDatabase,
  providers: ReturnType<typeof createProviders>,
  startupSignal?: AbortSignal,
  beforeWatchSetup?: (signal: AbortSignal) => Promise<void>,
) {
  const indexes = new Map<string, CodeIndex>()
  const contexts = new Map<string, ReturnType<typeof createCodeContext>>()
  const watchers = new Map<string, { close(): Promise<void> }>()
  const watcherErrors = new Map<string, string>()
  const watcherStarts = new Map<string, Promise<void>>()
  const watcherControllers = new Map<string, AbortController>()
  const operations = new Set<Operation>()
  const maxConcurrency = config.limits?.maxConcurrency ?? 8
  let closed = false
  let closing: Promise<void> | undefined

  const getRoot = (id: string) => {
    const root = roots.find((entry) => entry.config.id === id)
    if (!root) throw new SearchRuntimeError('ROOT_NOT_CONFIGURED')
    return root
  }
  const assertRoot = async (id: string) => {
    const root = getRoot(id)
    const info = await stat(root.path).catch(() => undefined)
    if (!info || !info.isDirectory() || info.dev !== root.dev || info.ino !== root.ino)
      throw new SearchRuntimeError('ROOT_CHANGED')
    return root
  }
  const execute = <T>(
    callerSignal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (closed) return Promise.reject(new SearchRuntimeError('RUNTIME_CLOSED'))
    if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal))
      return Promise.reject(new SearchRuntimeError('INVALID_REQUEST'))
    if (operations.size >= maxConcurrency)
      return Promise.reject(new SearchRuntimeError('RUNTIME_BUSY'))
    const controller = new AbortController()
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal
    const timer = setTimeout(
      () => controller.abort(new SearchRuntimeError('TIMEOUT')),
      config.limits?.timeoutMs ?? 60_000,
    )
    const workPromise = Promise.resolve().then(() => {
      signal.throwIfAborted()
      return work(signal)
    })
    const operation: Operation = { controller, promise: workPromise }
    operations.add(operation)
    return workPromise
      .catch((error: unknown) => {
        throw sanitize(error, callerSignal, signal)
      })
      .finally(() => {
        clearTimeout(timer)
        operations.delete(operation)
      })
  }
  const getIndex = (id: string) => {
    let index = indexes.get(id)
    if (index) return index
    const root = getRoot(id)
    const modelSet = providers.embedding
      ? {
          embed: providers.embedding.embed,
          ...(providers.reranker ? { rerank: providers.reranker.rerank } : {}),
        }
      : undefined
    const profile = providers.embedding
      ? {
          provider: providers.embedding.profile.provider,
          model: providers.embedding.profile.model,
          space: providers.embedding.profile.space,
          dimensions: providers.embedding.profile.dimensions!,
          inputType: 'text' as const,
          chunkerVersion: 'ts-ast-symbol-v1',
        }
      : undefined
    const limits = root.config.limits ? compact(root.config.limits) : undefined
    index = createCodeIndex({
      database,
      ...(modelSet && profile ? { models: modelSet, profile } : {}),
      ...(root.config.exclude ? { exclude: [...root.config.exclude] } : {}),
      ...(limits ? { limits } : {}),
    })
    indexes.set(id, index)
    contexts.set(id, createCodeContext({ index }))
    return index
  }
  const getContext = (id: string) => {
    let context = contexts.get(id)
    if (!context) {
      getIndex(id)
      context = contexts.get(id)
    }
    if (!context) throw new SearchRuntimeError('OPERATION_FAILED')
    return context
  }

  async function shutdown() {
    if (closing) return closing
    closed = true
    for (const operation of operations)
      operation.controller.abort(new SearchRuntimeError('RUNTIME_CLOSED'))
    for (const controller of watcherControllers.values())
      controller.abort(new SearchRuntimeError('RUNTIME_CLOSED'))
    closing = (async () => {
      const failures: unknown[] = []
      const startupPromises = [...watcherStarts.values()]
      const operationPromises = [...operations].map((item) => item.promise)
      await Promise.allSettled(startupPromises)
      await Promise.allSettled([...watchers.values()].map((watcher) => watcher.close()))
      await Promise.allSettled(operationPromises)
      const lifecycle = await Promise.allSettled([
        ...[...contexts.values()].map((context) => context.close()),
        ...[...indexes.values()].map((index) => index.close()),
      ])
      for (const result of lifecycle) if (result.status === 'rejected') failures.push(result.reason)
      try {
        await database.close()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length)
        throw new SearchRuntimeError('CLOSE_FAILED', undefined, undefined, {
          cause: new AggregateError(failures),
        })
    })()
    return closing
  }

  async function startWatcherInternal(id: string, setupSignal?: AbortSignal): Promise<void> {
    if (watchers.has(id)) return
    const inFlight = watcherStarts.get(id)
    if (inFlight) return inFlight
    const root = getRoot(id)
    if (!root.config.watch) throw new SearchRuntimeError('WATCH_DISABLED')
    if (setupSignal?.aborted) throw new SearchRuntimeError('CANCELLED')
    const ownerController = new AbortController()
    watcherControllers.set(id, ownerController)
    const cancelOwnerDuringSetup = () => ownerController.abort(setupSignal?.reason)
    setupSignal?.addEventListener('abort', cancelOwnerDuringSetup, { once: true })
    let handle: Awaited<ReturnType<typeof watchCodeRoot>> | undefined
    let transferredToRuntime = false
    const startup = (async () => {
      await assertRoot(id)
      setupSignal?.throwIfAborted()
      await beforeWatchSetup?.(setupSignal ?? ownerController.signal)
      setupSignal?.throwIfAborted()
      handle = await watchCodeRoot({
        root: root.path,
        signal: ownerController.signal,
        intervalMs: root.config.watchIntervalMs ?? 5000,
        reconcile: async () => {
          try {
            await execute(ownerController.signal, async (signal) => {
              const currentRoot = await assertRoot(id)
              await getIndex(id).indexRepository({ root: currentRoot.path, signal })
            })
            watcherErrors.delete(id)
          } catch (error) {
            if (!ownerController.signal.aborted)
              watcherErrors.set(id, sanitize(error, undefined, ownerController.signal).code)
            throw error
          }
        },
        onError: (code) => {
          if (!watcherErrors.has(id)) watcherErrors.set(id, boundedCode(code))
        },
        onClose: () => {
          if (handle && watchers.get(id) === handle) watchers.delete(id)
          if (watcherControllers.get(id) === ownerController) watcherControllers.delete(id)
        },
      })
      if (closed || ownerController.signal.aborted || setupSignal?.aborted) {
        await handle.close()
        return
      }
      watchers.set(id, handle)
      transferredToRuntime = true
    })()
    watcherStarts.set(id, startup)
    try {
      await startup
    } finally {
      setupSignal?.removeEventListener('abort', cancelOwnerDuringSetup)
      watcherStarts.delete(id)
      if (!transferredToRuntime) {
        ownerController.abort(new SearchRuntimeError('RUNTIME_CLOSED'))
        if (watcherControllers.get(id) === ownerController) watcherControllers.delete(id)
      }
    }
  }

  const api = {
    listRoots(): RuntimeRoot[] {
      return roots.map(({ config: root, path }) => ({
        id: root.id,
        path,
        ...(root.label ? { label: root.label } : {}),
      }))
    },
    capabilities(): RuntimeCapabilities {
      return {
        code: true,
        embedding: Boolean(providers.embedding),
        codeReranking: Boolean(providers.embedding && providers.reranker),
        webReranking: Boolean(providers.web && config.web?.discovery && providers.reranker),
        webRead: Boolean(providers.web),
        webDiscovery: Boolean(config.web?.discovery && providers.web),
        classification: Boolean(providers.classifier),
        visual: false,
      }
    },
    usage() {
      return {
        embedding: providers.embedding?.usage() ?? null,
        reranking: providers.reranker?.usage() ?? null,
        classification: providers.classifier?.usage() ?? null,
        web:
          providers.web && 'usage' in providers.web
            ? (providers.web as WebSource & { usage(): unknown }).usage()
            : null,
      }
    },
    profiles() {
      return {
        embedding: providers.embedding ? structuredClone(providers.embedding.profile) : null,
        reranking: providers.reranker ? structuredClone(providers.reranker.profile) : null,
        classification: providers.classifier ? structuredClone(providers.classifier.profile) : null,
      }
    },
    async indexStatus(input: {
      rootId: string
      signal?: AbortSignal
    }): Promise<RuntimeIndexStatus> {
      const { request, signal } = captureRequest(statusRequest, input)
      return execute(signal, async (operationSignal) => {
        const root = await assertRoot(request.rootId)
        const status = await getIndex(request.rootId).indexStatus(root.path, operationSignal)
        return {
          ...status,
          watcherError: watcherErrors.get(request.rootId) ?? null,
          watching: watchers.has(request.rootId),
        }
      })
    },
    async indexRepository(input: { rootId: string; signal?: AbortSignal }) {
      const { request, signal } = captureRequest(indexRequest, input)
      return execute(signal, async (operationSignal) => {
        const root = await assertRoot(request.rootId)
        return getIndex(request.rootId).indexRepository({
          root: root.path,
          signal: operationSignal,
        })
      })
    },
    async searchCode(input: Omit<CodeSearchInput, 'root'> & { rootId: string }) {
      const { request, signal } = captureRequest(searchRequest, input)
      return execute(signal, async (operationSignal) => {
        const root = await assertRoot(request.rootId)
        return getIndex(request.rootId).searchCode({
          root: root.path,
          query: request.query,
          ...(request.paths === undefined ? {} : { paths: request.paths }),
          ...(request.language === undefined ? {} : { language: request.language }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
          ...(request.mode === undefined ? {} : { mode: request.mode }),
          signal: operationSignal,
        } as CodeSearchInput)
      })
    },
    async readSource(input: Omit<CodeReadInput, 'root'> & { rootId: string }) {
      const { request, signal } = captureRequest(readRequest, input)
      return execute(signal, async (operationSignal) => {
        const root = await assertRoot(request.rootId)
        return getIndex(request.rootId).readSource({
          root: root.path,
          path: request.path,
          ...(request.lineStart === undefined ? {} : { lineStart: request.lineStart }),
          ...(request.lineEnd === undefined ? {} : { lineEnd: request.lineEnd }),
          ...(request.snapshotId === undefined ? {} : { snapshotId: request.snapshotId }),
          signal: operationSignal,
        } as CodeReadInput)
      })
    },
    async relatedCode(input: Omit<CodeRelatedInput, 'root'> & { rootId: string }) {
      const { request, signal } = captureRequest(relatedRequest, input)
      return execute(signal, async (operationSignal) => {
        const root = await assertRoot(request.rootId)
        return getIndex(request.rootId).relatedCode({
          root: root.path,
          path: request.path,
          ...(request.symbol === undefined ? {} : { symbol: request.symbol }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
          signal: operationSignal,
        } as CodeRelatedInput)
      })
    },
    async getCodeContext(input: {
      rootId: string
      query: string
      featureQueries?: string[]
      mustInclude?: Array<{ path: string; lineStart?: number; lineEnd?: number }>
      includeRelated?: boolean
      maxChars?: number
      limit?: number
      signal?: AbortSignal
    }): Promise<CodeContextResult> {
      const { request, signal } = captureRequest(contextRequest, input)
      return execute(signal, async (operationSignal) => {
        const root = await assertRoot(request.rootId)
        return getContext(request.rootId).getCodeContext({
          root: root.path,
          query: request.query,
          ...(request.featureQueries === undefined
            ? {}
            : { featureQueries: request.featureQueries }),
          ...(request.mustInclude === undefined
            ? {}
            : {
                mustInclude: request.mustInclude.map((range) => ({
                  path: range.path,
                  ...(range.lineStart === undefined ? {} : { lineStart: range.lineStart }),
                  ...(range.lineEnd === undefined ? {} : { lineEnd: range.lineEnd }),
                })),
              }),
          ...(request.includeRelated === undefined
            ? {}
            : { includeRelated: request.includeRelated }),
          ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
          signal: operationSignal,
        } as CodeContextRequest)
      })
    },
    async searchWeb(input: {
      query: string
      limit?: number
      maxChars?: number
      signal?: AbortSignal
    }): Promise<WebSearchResult> {
      const { request, signal } = captureRequest(webSearchRequest, input)
      return execute(signal, async (operationSignal) => {
        if (!providers.web || !config.web?.discovery)
          throw new SearchRuntimeError('CAPABILITY_DISABLED')
        const models = {
          ...(providers.embedding
            ? { embed: { profile: providers.embedding.profile, embed: providers.embedding.embed } }
            : {}),
          ...(providers.reranker
            ? { rerank: { profile: providers.reranker.profile, rerank: providers.reranker.rerank } }
            : {}),
        }
        const search = createWebSearch({
          web: providers.web,
          ...(Object.keys(models).length ? { models } : {}),
          limits: { maxConcurrency: 2, timeoutMs: 30_000 },
        })
        try {
          return await search.searchWeb({
            query: request.query,
            ...(request.limit === undefined ? {} : { limit: request.limit }),
            ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }),
            signal: operationSignal,
          })
        } finally {
          await search.close()
        }
      })
    },
    async readWebSource(input: { url: string; maxChars?: number; signal?: AbortSignal }) {
      const { request, signal } = captureRequest(webReadRequest, input)
      return execute(signal, async (operationSignal) => {
        if (!providers.web) throw new SearchRuntimeError('CAPABILITY_DISABLED')
        const search = createWebSearch({ web: providers.web })
        try {
          return await search.readWebSource({
            url: request.url,
            ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }),
            signal: operationSignal,
          })
        } finally {
          await search.close()
        }
      })
    },
    async classify(input: {
      text: string
      labels: string[]
      criteria: string
      examples?: Array<{ text: string; label: string }>
      allowMultiple?: boolean
      allowAbstain?: boolean
      signal?: AbortSignal
    }): Promise<ClassificationResult> {
      const { request, signal } = captureRequest(classifyRequest, input)
      return execute(signal, async (operationSignal) => {
        if (!providers.classifier) throw new SearchRuntimeError('CAPABILITY_DISABLED')
        const classification = createClassificationTool({ classifier: providers.classifier })
        try {
          return await classification.classify({
            text: request.text,
            labels: request.labels,
            criteria: request.criteria,
            ...(request.examples === undefined ? {} : { examples: request.examples }),
            ...(request.allowMultiple === undefined
              ? {}
              : { allowMultiple: request.allowMultiple }),
            ...(request.allowAbstain === undefined ? {} : { allowAbstain: request.allowAbstain }),
            signal: operationSignal,
          })
        } finally {
          await classification.close()
        }
      })
    },
    async startWatcher(input: { rootId: string; signal?: AbortSignal }) {
      const { request, signal } = captureRequest(statusRequest, input)
      return execute(signal, (operationSignal) =>
        startWatcherInternal(request.rootId, operationSignal),
      )
    },
    watchStatus(input: { rootId: string }): RuntimeWatchStatus {
      const { request } = captureRequest(statusRequest, input)
      const root = getRoot(request.rootId)
      return {
        enabled: root.config.watch ?? false,
        active: watchers.has(request.rootId),
        errorCode: watcherErrors.get(request.rootId) ?? null,
      }
    },
    close: shutdown,
  }

  try {
    for (const root of roots)
      if (root.config.watch) {
        await execute(startupSignal, async (signal) => {
          const configuredRoot = await assertRoot(root.config.id)
          await getIndex(root.config.id).indexRepository({ root: configuredRoot.path, signal })
          await startWatcherInternal(root.config.id, signal)
        })
      }
    assertStartupActive(startupSignal)
    return api
  } catch (error) {
    try {
      await shutdown()
    } catch (closeError) {
      throw new SearchRuntimeError('STARTUP_CLEANUP_FAILED', undefined, undefined, {
        cause: new AggregateError([error, closeError]),
      })
    }
    throw sanitize(error, startupSignal)
  }
}

function captureRequest<T>(
  schema: z.ZodType<T>,
  input: unknown,
): { request: T; signal?: AbortSignal } {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new SearchRuntimeError('INVALID_REQUEST')
  const source = input as Record<string, unknown>
  const signal = source.signal
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new SearchRuntimeError('INVALID_REQUEST')
  const dto = { ...source }
  delete dto.signal
  const parsed = schema.safeParse(dto)
  if (!parsed.success) throw new SearchRuntimeError('INVALID_REQUEST')
  return { request: structuredClone(parsed.data), ...(signal ? { signal } : {}) }
}

async function loadSecrets(
  config: RuntimeConfig,
  configDir?: string,
): Promise<Record<string, string> | undefined> {
  const references = [
    config.embedding?.secret,
    config.reranker?.secret,
    config.classifier?.secret,
    config.web?.discovery?.secret,
  ]
  if (!references.some((ref) => ref?.kind === 'file')) return undefined
  if (!configDir) throw new RuntimeConfigError('SECRET_FILE_INVALID')
  const raw = await readBoundedRegularFile(resolve(configDir, 'secrets.json'), 64 * 1024, true)
  try {
    const value: unknown = JSON.parse(raw)
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length > 32 ||
      Object.values(value).some(
        (item) => typeof item !== 'string' || !item.trim() || item.length > 8192,
      )
    )
      throw new Error()
    return value as Record<string, string>
  } catch {
    throw new RuntimeConfigError('SECRET_FILE_INVALID')
  }
}

function compact<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>
  }
}
const knownCodes = new Set([
  'SEARCH_EMBEDDED_DIRECTORY_ALREADY_OWNED',
  'SEARCH_EMBEDDED_OWNER_LOCK_EXISTS',
  'SEARCH_EMBEDDED_LOCK_RELEASE_FAILED',
  'CODE_INDEX_CLOSED',
  'CODE_INDEX_BUSY',
  'CODE_INDEX_STALE',
  'CODE_INDEX_ROOT_UNAVAILABLE',
  'CODE_INDEX_ROOT_INVALID',
  'CODE_INDEX_QUERY_INVALID',
  'CODE_INDEX_QUERY_SCAN_LIMIT',
  'CODE_INDEX_RESULT_LIMIT',
  'CODE_INDEX_PATH_FILTER_INVALID',
  'CODE_INDEX_SOURCE_UNAVAILABLE',
  'CODE_INDEX_SOURCE_CHANGED',
  'CODE_INDEX_SOURCE_CHANGED_DURING_INDEX',
  'CODE_INDEX_SOURCE_CHANGED_DURING_SEARCH',
  'CODE_INDEX_SOURCE_CHANGED_DURING_READ',
  'CODE_INDEX_SNAPSHOT_MISMATCH',
  'CODE_INDEX_STALE_GENERATION',
  'CODE_INDEX_EMBEDDING_PROFILE_REQUIRED',
  'CODE_INDEX_MODELS_INVALID',
  'CODE_INDEX_LIMIT_INVALID',
  'CODE_INDEX_CHUNK_LIMIT',
  'CODE_INDEX_LINE_RANGE_INVALID',
  'CODE_INDEX_MODE_INVALID',
  'CODE_INDEX_PROFILE_WITHOUT_EMBEDDER',
  'CODE_INDEX_RERANK_INVALID',
  'CODE_INDEX_VECTOR_INVALID',
  'CODE_INDEX_VECTOR_DIMENSION_MISMATCH',
  'CODE_INDEX_WATCH_FAILED',
  'CODE_INDEX_WATCH_INTERVAL_INVALID',
  'CODE_INDEX_WATCH_LIMIT',
  'CODE_INDEX_DIRECTORY_LIMIT',
  'CODE_INDEX_EXCLUSION_POLICY_INVALID',
  'CODE_INDEX_FILE_LIMIT',
  'CODE_INDEX_FILE_SIZE_LIMIT',
  'CODE_INDEX_SOURCE_SIZE_LIMIT',
  'CODE_INDEX_IGNORE_FILE_LIMIT',
  'CODE_INDEX_IGNORE_FILE_UNREADABLE',
  'CODE_INDEX_PATH_OUTSIDE_ROOT',
  'CODE_INDEX_SOURCE_BINARY',
  'CODE_INDEX_TOTAL_BYTES_LIMIT',
  'CODE_INDEX_CANCELLED',
  'CODE_INDEX_GIT_FAILED',
  'CODE_INDEX_GIT_OUTPUT_LIMIT',
  'CODE_INDEX_GIT_TIMEOUT',
  'CODE_INDEX_MIGRATION_CHECKSUM_MISMATCH',
  'CODE_CONTEXT_STALE_SNAPSHOT',
  'CODE_CONTEXT_MANDATORY_BUDGET',
  'CODE_CONTEXT_CLOSED',
  'CODE_CONTEXT_LIMIT',
  'CODE_CONTEXT_TIMEOUT',
  'OPERATION_LIMIT',
  'OPERATION_CLOSED',
  'OPERATION_TIMEOUT',
  'ROOT_CHANGED',
])
function sanitize(
  error: unknown,
  callerSignal?: AbortSignal,
  operationSignal?: AbortSignal,
): SearchRuntimeError {
  if (callerSignal?.aborted) return new SearchRuntimeError('CANCELLED')
  if (operationSignal?.aborted) {
    const reason = operationSignal.reason
    if (reason instanceof SearchRuntimeError) return reason
    return new SearchRuntimeError('CANCELLED')
  }
  if (error instanceof SearchRuntimeError) return error
  if (error instanceof RuntimeConfigError) return new SearchRuntimeError(error.code)
  if (error instanceof ProviderError)
    return new SearchRuntimeError(
      `PROVIDER_${error.code.toUpperCase()}`,
      error.status,
      error.retryAfterMs,
    )
  if (error instanceof Error && knownCodes.has(error.message))
    return new SearchRuntimeError(error.message)
  if (error instanceof CodeContextError) return new SearchRuntimeError(`CODE_CONTEXT_${error.code}`)
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    knownCodes.has(error.code)
  )
    return new SearchRuntimeError(error.code)
  if (
    error instanceof Error &&
    ['OperationLimitError', 'OperationClosedError', 'OperationTimeoutError'].includes(error.name)
  )
    return new SearchRuntimeError(
      error.name
        .replace('Error', '')
        .replace(/[A-Z]/g, (letter) => `_${letter}`)
        .toUpperCase()
        .replace(/^_/, ''),
    )
  return new SearchRuntimeError('OPERATION_FAILED')
}
function boundedCode(value: string): string {
  return knownCodes.has(value) ? value : 'WATCH_FAILED'
}
