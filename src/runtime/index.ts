import { realpath, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { createCodeIndex } from '../code/index.js'
import { watchCodeRoot } from '../code/watch.js'
import { createProjectTextIndex } from '../project-text/index.js'
import type {
  ProjectTextIndex,
  ProjectTextIndexResult,
  ProjectTextIndexStatus,
  ProjectTextKind,
  ProjectTextSearchInput,
  ProjectTextReadInput,
} from '../project-text/types.js'
import type {
  CodeIndex,
  CodeIndexStatus,
  CodeSearchInput,
  CodeReadInput,
  CodeRelatedInput,
  CodeDuplicatesInput,
  FindCodeSymbolsInput,
  FindCodeReferencesInput,
  TraceCodeCallsInput,
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
import { createJevClassifier } from '../providers/jev-classifier.js'
import { createJevDecisions } from '../providers/decisions.js'
import type { JevDecisionsPort } from '../providers/decision-types.js'
import { createReuseContext } from '../context/reuse.js'
import { createBraveWebSource, type BraveWebSourceConfig } from '../providers/brave.js'
import {
  createOpenAICompatibleEmbedding,
  createOpenRouterEmbedding,
  createOpenRouterReranker,
  createOpenRouterMultimodalEmbedding,
} from '../providers/openrouter.js'
import { MECHANISM_RETRIEVAL_PRESETS, PROJECT_TEXT_RETRIEVAL_PRESET } from '../providers/voyage.js'
import { createVisualSearch } from '../visual/index.js'
import {
  ProviderError,
  type ProviderErrorCode,
  type ProviderLimits,
} from '../providers/contracts.js'
import { openEmbeddedDatabase } from '../storage/embedded.js'
import { canonicalFuturePath, isSameOrDescendantPath } from './path.js'
import type { OwnedDatabase } from '../storage/database.js'
import type { WebDateRange, WebSource } from '../core/contracts.js'
import {
  statusRequest,
  indexStatusRequest,
  indexRequest,
  indexCodeSymbolsRequest,
  searchRequest,
  codeDuplicatesRequest,
  findCodeSymbolsRequest,
  findCodeReferencesRequest,
  traceCodeCallsRequest,
  projectTextSearchRequest,
  projectTextReadRequest,
  readRequest,
  relatedRequest,
  contextRequest,
  reuseContextRequest,
  webSearchRequest,
  webReadRequest,
  classifyRequest,
  visualSearchRequest,
  startIndexingRequest,
  cancelIndexingRequest,
} from './requests.js'
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
  webEmbedding: boolean
  codeReranking: boolean
  webReranking: boolean
  webRead: boolean
  webDiscovery: boolean
  classification: boolean
  reuseContext: boolean
  visual: boolean
  projectText: boolean
  projectTextIndexing: boolean
  projectTextEmbedding: boolean
  projectTextReranking: boolean
}
export interface RuntimeIndexStatus extends CodeIndexStatus {
  watcherError: string | null
  watching: boolean
  indexingJob: RuntimeIndexJobStatus | null
  projectTextStatus?: ProjectTextIndexStatus
}
export interface RuntimeIndexJobStatus {
  jobId: string
  rootId: string
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  createdAt: string
  startedAt?: string
  finishedAt?: string
  errorCode?: string
  attempt: number
  totalChunks: number | null
  checkpointChunks: number
  indexingComponent?: 'code' | 'projectText'
}
export interface RuntimeWatchStatus {
  enabled: boolean
  active: boolean
  errorCode: string | null
  retryOnChange: boolean
  job: RuntimeIndexJobStatus | null
}
export interface RuntimeOptions {
  config: unknown
  configDir?: string
  signal?: AbortSignal
  /** Return after storage validation while opt-in watched roots index under runtime ownership. */
  backgroundWatchStartup?: boolean
  /** SDK-only injection point for deterministic adapter tests. Never accepted by config or transport inputs. */
  testDependencies?: {
    env?: NodeJS.ProcessEnv
    fetch?: typeof fetch
    webSource?: WebSource
    beforeDatabaseReady?: (signal: AbortSignal) => Promise<void>
    beforeWatchSetup?: (signal: AbortSignal) => Promise<void>
    beforeIndexStatus?: (signal: AbortSignal) => Promise<void>
    beforeSourceFingerprint?: (signal: AbortSignal) => Promise<void>
  }
}

type RootEntry = { config: RuntimeConfig['roots'][number]; path: string; dev: number; ino: number }
type Operation = { controller: AbortController; promise: Promise<unknown> }
const hashFingerprint = (value: string) => createHash('sha256').update(value).digest('hex')
export async function openSearchRuntime(options: RuntimeOptions) {
  const config = parseRuntimeConfig(options.config)
  assertStartupActive(options.signal)
  const roots = await canonicalRoots(config)
  const dataDir = await assertDataDirectoryOutsideRoots(config.dataDir, roots)
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
    database = await openEmbeddedDatabase(dataDir)
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
      options.backgroundWatchStartup ?? false,
      options.testDependencies?.beforeIndexStatus,
      options.testDependencies?.beforeSourceFingerprint,
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

async function assertDataDirectoryOutsideRoots(dataDir: string, roots: RootEntry[]): Promise<string> {
  try {
    const candidate = await canonicalFuturePath(dataDir)
    if (
      roots.some(
        (root) =>
          isSameOrDescendantPath(root.path, candidate) ||
          isSameOrDescendantPath(candidate, root.path),
      )
    )
      throw new RuntimeConfigError('CONFIG_INVALID')
    return candidate
  } catch (error) {
    if (error instanceof RuntimeConfigError) throw error
    throw new RuntimeConfigError('CONFIG_INVALID')
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
  const configuredEmbedding = (p: NonNullable<RuntimeConfig['embedding']>) => {
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
  }
  const mechanismCode = config.mechanism?.code
  const codeEmbedding = mechanismCode
    ? createOpenRouterEmbedding({
        baseUrl: 'https://openrouter.ai/api/v1',
        model: MECHANISM_RETRIEVAL_PRESETS.code.model,
        dimensions: MECHANISM_RETRIEVAL_PRESETS.code.dimensions,
        verifyReturnedModel: true,
        apiKey: resolveSecret(mechanismCode.secret),
        ...(mechanismCode.limits ? { limits: compact(mechanismCode.limits) } : {}),
        ...fetchOption,
      })
    : undefined
  const embedding = config.embedding ? configuredEmbedding(config.embedding) : undefined
  const webEmbedding = config.web?.embedding
    ? configuredEmbedding(config.web.embedding)
    : undefined
  const projectTextConfig = config.projectText?.embedding
  const configuredProjectTextEmbedding = (
    p: NonNullable<RuntimeConfig['projectText']>['embedding'],
    inputType: 'document' | 'query',
  ) => {
    if (!p) return undefined
    const shared = {
      model: p.model,
      dimensions: p.dimensions,
      inputType,
      ...(p.profileId ? { profileId: p.profileId } : {}),
      apiKey: resolveSecret(p.secret),
      ...(p.limits ? { limits: compact(p.limits) } : {}),
      ...fetchOption,
    }
    const verifyReturnedModel = p.model === PROJECT_TEXT_RETRIEVAL_PRESET.embedding.model
    return p.provider === 'openrouter'
      ? createOpenRouterEmbedding({
          ...shared,
          baseUrl: p.baseUrl ?? 'https://openrouter.ai/api/v1',
          ...(verifyReturnedModel ? { verifyReturnedModel: true } : {}),
        })
      : createOpenAICompatibleEmbedding({
          ...shared,
          baseUrl: p.baseUrl!,
          profileId: p.profileId!,
        })
  }
  const projectTextDocumentEmbedding = configuredProjectTextEmbedding(projectTextConfig, 'document')
  const projectTextQueryEmbedding = configuredProjectTextEmbedding(projectTextConfig, 'query')
  const projectTextRerankerConfig = config.projectText?.reranker
  const projectTextReranker = projectTextRerankerConfig
    ? createOpenRouterReranker({
        baseUrl: 'https://openrouter.ai/api/v1',
        model: projectTextRerankerConfig.model,
        ...(projectTextRerankerConfig.profileId
          ? { profileId: projectTextRerankerConfig.profileId }
          : {}),
        maxResults: PROJECT_TEXT_RETRIEVAL_PRESET.reranker.candidateLimit,
        ...(projectTextRerankerConfig.model === PROJECT_TEXT_RETRIEVAL_PRESET.reranker.model
          ? { verifyReturnedModel: true }
          : {}),
        apiKey: resolveSecret(projectTextRerankerConfig.secret),
        ...(projectTextRerankerConfig.limits
          ? { limits: compact(projectTextRerankerConfig.limits) }
          : {}),
        ...fetchOption,
      })
    : undefined
  const codeReranker = mechanismCode
    ? createOpenRouterReranker({
        baseUrl: 'https://openrouter.ai/api/v1',
        model: MECHANISM_RETRIEVAL_PRESETS.code.reranker,
        maxResults: MECHANISM_RETRIEVAL_PRESETS.code.candidateLimit,
        verifyReturnedModel: true,
        apiKey: resolveSecret(mechanismCode.secret),
        ...(mechanismCode.limits ? { limits: compact(mechanismCode.limits) } : {}),
        ...fetchOption,
      })
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
  const classifierLimits = config.classifier?.limits
  const decisions: JevDecisionsPort | undefined = config.classifier
    ? createJevDecisions({
        baseUrl: 'https://openrouter.ai/api',
        apiKey: resolveSecret(config.classifier.secret),
        ...(classifierLimits ? { limits: {
          maxItems: Math.min(32, classifierLimits.maxItems ?? 32),
          maxInputBytes: classifierLimits.maxInputBytes ?? 131_072,
          maxResponseBytes: classifierLimits.maxResponseBytes ?? 262_144,
          timeoutMs: classifierLimits.timeoutMs ?? 15_000,
          attempts: 1,
          concurrency: classifierLimits.concurrency ?? 1,
        } } : {}),
        ...fetchOption,
      })
    : undefined
  const classifier = decisions
    ? createJevClassifier(decisions, {
        maxItems: Math.min(100, classifierLimits?.maxItems ?? 100),
        maxInputBytes: classifierLimits?.maxInputBytes ?? 131_072,
        timeoutMs: classifierLimits?.timeoutMs ?? 15_000,
        concurrency: classifierLimits?.concurrency ?? 1,
        questionBatchSize: Math.min(32, classifierLimits?.maxItems ?? 32),
        ...(config.classifier?.profileId ? { profileId: config.classifier.profileId } : {}),
      })
    : undefined
  const webLimits = config.web?.discovery?.limits ?? config.web?.limits
  const braveWeb =
    config.web && !testWebSource
      ? createBraveWebSource({
          ...(config.web.discovery ? { apiKey: resolveSecret(config.web.discovery.secret) } : {}),
          ...(webLimits ? { limits: compact(webLimits) as NonNullable<BraveWebSourceConfig['limits']> } : {}),
          ...fetchOption,
        })
      : undefined
  if (testWebSource && config.web?.discovery) resolveSecret(config.web.discovery.secret)
  const visualEmbedding = config.mechanism?.visual
    ? createOpenRouterMultimodalEmbedding({
        baseUrl: 'https://openrouter.ai/api/v1',
        model: MECHANISM_RETRIEVAL_PRESETS.visual.model,
        dimensions: MECHANISM_RETRIEVAL_PRESETS.visual.dimensions,
        apiKey: resolveSecret(config.mechanism.visual.secret),
        ...(config.mechanism.visual.limits ? { limits: compact(config.mechanism.visual.limits) } : {}),
        ...fetchOption,
      })
    : undefined
  return {
    embedding,
    webEmbedding,
    codeEmbedding,
    reranker,
    codeReranker,
    classifier,
    decisions,
    visualEmbedding,
    projectTextDocumentEmbedding,
    projectTextQueryEmbedding,
    projectTextReranker,
    web: testWebSource ?? braveWeb,
  }
}

async function createOwnedRuntime(
  config: RuntimeConfig,
  roots: RootEntry[],
  database: OwnedDatabase,
  providers: ReturnType<typeof createProviders>,
  startupSignal?: AbortSignal,
  beforeWatchSetup?: (signal: AbortSignal) => Promise<void>,
  optionsBackgroundWatchStartup = false,
  beforeIndexStatus?: (signal: AbortSignal) => Promise<void>,
  beforeSourceFingerprint?: (signal: AbortSignal) => Promise<void>,
) {
  const indexes = new Map<string, CodeIndex>()
  const projectTextIndexes = new Map<string, ProjectTextIndex>()
  const contexts = new Map<string, ReturnType<typeof createCodeContext>>()
  const reuseContexts = new Map<string, ReturnType<typeof createReuseContext>>()
  const watchers = new Map<string, { close(): Promise<void> }>()
  const watcherErrors = new Map<string, string>()
  const watcherPaused = new Set<string>()
  const watcherFailedFingerprints = new Map<string, string>()
  const watcherIndexedFingerprints = new Map<string, string>()
  const watcherFailures = new Map<string, number>()
  const watcherStarts = new Map<string, Promise<void>>()
  const watcherControllers = new Map<string, AbortController>()
  const completedIndexFingerprints = new Map<string, string>()
  const operations = new Set<Operation>()
  const controlOperations = new Set<Operation>()
  const rootIndexTails = new Map<string, Promise<void>>()
  const maxConcurrency = config.limits?.maxConcurrency ?? 8
  const maxControlOperations = 8
  let closed = false
  let closing: Promise<void> | undefined
  type IndexJob = Omit<RuntimeIndexJobStatus, 'jobId'> & {
    id: string
    controller: AbortController
    promise: Promise<void>
    resolveCompletion: () => void
    cancelRequested: boolean
    deadlineAt: number
    deadlineTimer: NodeJS.Timeout
    checkpointScope?: string
    checkpointComponent?: 'code' | 'projectText'
    componentCheckpointWrites: Map<'code' | 'projectText', number>
    checkpointWrites: number
  }
  const jobs = new Map<string, IndexJob>()
  const jobsByRoot = new Map<string, IndexJob>()
  const jobQueue: IndexJob[] = []
  const maxJobs = config.indexing?.maxConcurrentRoots ?? 1
  let activeJobs = 0
  let runtimeJobClose = false
  const publishJob = (job: IndexJob): RuntimeIndexJobStatus => ({
    jobId: job.id,
    rootId: job.rootId,
    state: job.state,
    createdAt: job.createdAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    attempt: job.attempt,
    totalChunks: job.totalChunks,
    checkpointChunks: job.checkpointChunks,
    ...(config.projectText ? { indexingComponent: job.checkpointComponent } : {}),
  })
  const settleJob = (job: IndexJob) => {
    if (!job.finishedAt) job.finishedAt = new Date().toISOString()
    clearTimeout(job.deadlineTimer)
    job.resolveCompletion()
  }
  const pumpJobs = () => {
    while (!runtimeJobClose && activeJobs < maxJobs && jobQueue.length) {
      const job = jobQueue.shift()!
      if (job.state !== 'queued') continue
      activeJobs++
      job.state = 'running'
      job.startedAt = new Date().toISOString()
      void (async () => {
        const maxAttempts = config.indexing?.maxAttempts ?? 12
        try {
          while (true) {
            if (job.controller.signal.aborted) throw job.controller.signal.reason
            const remaining = job.deadlineAt - Date.now()
            if (remaining <= 0) throw new SearchRuntimeError('TIMEOUT')
            job.attempt++
            job.checkpointWrites = 0
            job.componentCheckpointWrites.clear()
            const attemptController = new AbortController()
            const attemptTimeout = Math.min(config.limits?.timeoutMs ?? 60_000, remaining)
            const attemptTimer = setTimeout(
              () => attemptController.abort(new SearchRuntimeError('TIMEOUT')),
              attemptTimeout,
            )
            attemptTimer.unref?.()
            const attemptSignal = AbortSignal.any([job.controller.signal, attemptController.signal])
            try {
              await runIndexExclusive(job.rootId, attemptSignal, (progress) => {
                job.totalChunks = progress.totalChunks
                if (
                  progress.component !== job.checkpointComponent ||
                  progress.snapshotId !== job.checkpointScope
                ) {
                  job.checkpointComponent = progress.component
                  job.checkpointScope = progress.snapshotId
                  job.checkpointChunks = 0
                }
                job.checkpointComponent = progress.component
                job.checkpointChunks = progress.checkpointChunks
                const priorComponentWrites =
                  job.componentCheckpointWrites.get(progress.component) ?? 0
                if (progress.checkpointWrites > priorComponentWrites) {
                  job.checkpointWrites += progress.checkpointWrites - priorComponentWrites
                  job.componentCheckpointWrites.set(progress.component, progress.checkpointWrites)
                }
              })
              job.state = 'completed'
              break
            } catch (error) {
              clearTimeout(attemptTimer)
              const attemptDeadlineWon =
                attemptController.signal.aborted &&
                attemptSignal.reason === attemptController.signal.reason
              const safe = attemptDeadlineWon
                ? new SearchRuntimeError('TIMEOUT')
                : sanitize(error, undefined, job.controller.signal)
              const checkpointAdvanced = job.checkpointWrites > 0
              const changedWatchedSource =
                ['CODE_INDEX_SOURCE_CHANGED_DURING_INDEX', 'PROJECT_TEXT_SOURCE_CHANGED'].includes(
                  safe.code,
                ) && getRoot(job.rootId).config.watch === true
              if (!(safe.code === 'TIMEOUT' && checkpointAdvanced) && !changedWatchedSource) throw safe
              if (job.attempt >= maxAttempts || job.deadlineAt - Date.now() <= 0) throw safe
              await new Promise<void>((resolvePromise, reject) => {
                const delay = config.indexing?.retryDelayMs ?? 300
                const timeout = setTimeout(() => {
                  job.controller.signal.removeEventListener('abort', abort)
                  resolvePromise()
                }, Math.min(delay, Math.max(1, job.deadlineAt - Date.now())))
                const abort = () => {
                  clearTimeout(timeout)
                  reject(job.controller.signal.reason)
                }
                job.controller.signal.addEventListener('abort', abort, { once: true })
              })
            } finally {
              clearTimeout(attemptTimer)
            }
          }
        } catch (error) {
          const timedOut =
            job.controller.signal.reason instanceof SearchRuntimeError &&
            job.controller.signal.reason.code === 'TIMEOUT'
          const cancelled = job.cancelRequested || job.controller.signal.aborted
          if (timedOut) {
            job.state = 'failed'
            job.errorCode = 'TIMEOUT'
          } else if (cancelled) {
            job.state = 'cancelled'
            job.errorCode = 'CANCELLED'
          } else {
            job.state = 'failed'
            job.errorCode = sanitize(error).code
          }
        } finally {
          settleJob(job)
          activeJobs--
          pumpJobs()
        }
      })()
    }
  }
  const admitIndexJob = (rootId: string) => {
    if (closed) throw new SearchRuntimeError('RUNTIME_CLOSED')
    const existing = jobsByRoot.get(rootId)
    if (existing && (existing.state === 'queued' || existing.state === 'running'))
      return { created: false, job: publishJob(existing) }
    if (jobQueue.length >= roots.length) throw new SearchRuntimeError('RUNTIME_BUSY')
    let resolveCompletion = () => {}
    const completion = new Promise<void>((resolvePromise) => { resolveCompletion = resolvePromise })
    const controller = new AbortController()
    const deadlineAt = Date.now() + (config.indexing?.jobTimeoutMs ?? 900_000)
    const job: IndexJob = {
      id: randomUUID(),
      rootId,
      state: 'queued',
      createdAt: new Date().toISOString(),
      controller,
      promise: completion,
      resolveCompletion,
      cancelRequested: false,
      deadlineAt,
      deadlineTimer: setTimeout(
        () => controller.abort(new SearchRuntimeError('TIMEOUT')),
        Math.max(1, deadlineAt - Date.now()),
      ),
      attempt: 0,
      totalChunks: null,
      checkpointChunks: 0,
      checkpointWrites: 0,
      componentCheckpointWrites: new Map(),
    }
    job.deadlineTimer.unref?.()
    controller.signal.addEventListener('abort', () => {
      if (job.state !== 'queued') return
      const queuedIndex = jobQueue.indexOf(job)
      if (queuedIndex >= 0) jobQueue.splice(queuedIndex, 1)
      const timedOut =
        controller.signal.reason instanceof SearchRuntimeError &&
        controller.signal.reason.code === 'TIMEOUT'
      job.state = timedOut ? 'failed' : 'cancelled'
      job.errorCode = timedOut ? 'TIMEOUT' : 'CANCELLED'
      settleJob(job)
    }, { once: true })
    jobs.set(job.id, job)
    jobsByRoot.set(rootId, job)
    jobQueue.push(job)
    const terminal = (item: IndexJob) =>
      item.state === 'completed' || item.state === 'failed' || item.state === 'cancelled'
    while ([...jobs.values()].filter(terminal).length > 64) {
      const old = [...jobs.values()].find(terminal)
      if (!old) break
      jobs.delete(old.id)
    }
    if (getRoot(rootId).config.watch) {
      void job.promise.then(async () => {
        const isCurrentJob = () => !closed && jobsByRoot.get(rootId) === job
        if (!isCurrentJob()) return
        if (job.state === 'completed') {
          watcherPaused.delete(rootId)
          watcherFailures.delete(rootId)
          watcherFailedFingerprints.delete(rootId)
          watcherErrors.delete(rootId)
          if (config.projectText) {
            const fingerprint = completedIndexFingerprints.get(rootId)
            if (fingerprint) watcherIndexedFingerprints.set(rootId, fingerprint)
            else watcherIndexedFingerprints.delete(rootId)
          } else if (job.checkpointScope) {
            watcherIndexedFingerprints.set(rootId, job.checkpointScope)
          }
        } else if (job.state === 'failed') {
          if (config.projectText) {
            try {
              const fingerprint = await executeControl(undefined, (signal) =>
                sourceFingerprintForRoot(rootId, signal),
              )
              if (!isCurrentJob()) return
              watcherFailedFingerprints.set(rootId, fingerprint)
            } catch {
              if (!isCurrentJob()) return
              watcherFailedFingerprints.delete(rootId)
            }
          } else if (job.checkpointScope) {
            watcherFailedFingerprints.set(rootId, job.checkpointScope)
          }
          watcherPaused.add(rootId)
        } else if (job.state === 'cancelled') {
          watcherPaused.add(rootId)
          if (job.checkpointScope && !config.projectText) {
            watcherFailedFingerprints.set(rootId, job.checkpointScope)
          } else {
            try {
              const fingerprint = await executeControl(undefined, async (signal) => {
                return config.projectText
                  ? sourceFingerprintForRoot(rootId, signal)
                  : getIndex(rootId).sourceFingerprint((await assertRoot(rootId)).path, signal)
              })
              if (!isCurrentJob()) return
              watcherFailedFingerprints.set(rootId, fingerprint)
            } catch {
              if (!isCurrentJob()) return
              watcherFailedFingerprints.delete(rootId)
            }
          }
        }
        if (!isCurrentJob()) return
        if (!watchers.has(rootId)) {
          void startWatcherInternal(rootId).catch((error) => {
            watcherErrors.set(rootId, sanitize(error).code)
          })
        }
      })
    }
    pumpJobs()
    return { created: true, job: publishJob(job) }
  }

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
  const executeControl = <T>(
    callerSignal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (closed) return Promise.reject(new SearchRuntimeError('RUNTIME_CLOSED'))
    if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal))
      return Promise.reject(new SearchRuntimeError('INVALID_REQUEST'))
    if (controlOperations.size >= maxControlOperations)
      return Promise.reject(new SearchRuntimeError('RUNTIME_BUSY'))
    const controller = new AbortController()
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal
    const timer = setTimeout(
      () => controller.abort(new SearchRuntimeError('TIMEOUT')),
      config.limits?.timeoutMs ?? 60_000,
    )
    const promise = Promise.resolve().then(() => {
      signal.throwIfAborted()
      return work(signal)
    })
    const operation: Operation = { controller, promise }
    controlOperations.add(operation)
    return promise
      .catch((error: unknown) => {
        throw sanitize(error, callerSignal, signal)
      })
      .finally(() => {
        clearTimeout(timer)
        controlOperations.delete(operation)
      })
  }
  const runOnRootIndexLane = async <T>(
    rootId: string,
    signal: AbortSignal,
    work: (root: RootEntry) => Promise<T>,
  ): Promise<T> => {
    if (closed) throw new SearchRuntimeError('RUNTIME_CLOSED')
    signal.throwIfAborted()
    const prior = rootIndexTails.get(rootId) ?? Promise.resolve()
    let release = () => {}
    const turn = new Promise<void>((resolvePromise) => { release = resolvePromise })
    const tail = prior.then(() => turn)
    rootIndexTails.set(rootId, tail)
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const onAbort = () => {
          signal.removeEventListener('abort', onAbort)
          reject(signal.reason)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        prior.then(() => {
          signal.removeEventListener('abort', onAbort)
          if (signal.aborted) reject(signal.reason)
          else resolvePromise()
        }, reject)
      })
      signal.throwIfAborted()
      const root = await assertRoot(rootId)
      return await work(root)
    } catch (error) {
      throw sanitize(error, signal)
    } finally {
      release()
      void tail.then(() => {
        if (rootIndexTails.get(rootId) === tail) rootIndexTails.delete(rootId)
      })
    }
  }
  const runIndexExclusive = (
    rootId: string,
    signal: AbortSignal,
    onProgress?: (progress: {
      component: 'code' | 'projectText'
      snapshotId: string
      totalChunks: number
      checkpointChunks: number
      checkpointWrites: number
    }) => void,
  ): Promise<CodeIndexStatus> =>
    runOnRootIndexLane(rootId, signal, async (root) => {
      const codeStatus = await getIndex(rootId).indexRepository({
        root: root.path,
        signal,
        ...(onProgress
          ? { onProgress: (progress) => onProgress({ component: 'code', ...progress }) }
          : {}),
      })
      if (!config.projectText) return codeStatus

      const textResult = await getProjectTextIndex(rootId).indexRepository({
        root: root.path,
        signal,
        ...(onProgress
          ? {
              onProgress: (progress) =>
                onProgress({
                  component: 'projectText',
                  snapshotId: progress.snapshotId,
                  totalChunks: progress.totalChunks,
                  checkpointChunks: progress.checkpointChunks,
                  checkpointWrites: progress.checkpointWrites,
                }),
            }
          : {}),
      })
      const currentCodeStatus = await getIndex(rootId).indexStatus(root.path, signal)
      const currentTextStatus = await getProjectTextIndex(rootId).indexStatus(root.path, signal)
      if (
        !codeStatus.identity ||
        currentCodeStatus.identity?.snapshotId !== codeStatus.identity.snapshotId ||
        currentTextStatus.stale ||
        currentTextStatus.snapshotId !== textResult.snapshotId ||
        currentTextStatus.identity?.contentHash !== textResult.treeHash ||
        currentTextStatus.identity.branch !== textResult.identity.branch ||
        currentTextStatus.identity.head !== textResult.identity.head
      )
        throw new SearchRuntimeError('CODE_INDEX_SOURCE_CHANGED_DURING_INDEX')
      const codeFingerprint = await getIndex(rootId).sourceFingerprint(root.path, signal)
      const finalCodeStatus = await getIndex(rootId).indexStatus(root.path, signal)
      if (
        finalCodeStatus.identity?.snapshotId !== codeStatus.identity.snapshotId ||
        codeFingerprint !== codeStatus.identity.snapshotId
      )
        throw new SearchRuntimeError('CODE_INDEX_SOURCE_CHANGED_DURING_INDEX')
      completedIndexFingerprints.set(
        rootId,
        hashFingerprint(JSON.stringify([codeStatus.identity.snapshotId, textResult.treeHash])),
      )
      return codeStatus
    })
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
    const codeEmbedding = providers.codeEmbedding ?? providers.embedding
    const modelSet = codeEmbedding
      ? {
          embed: codeEmbedding.embed,
          ...((providers.codeReranker ?? providers.reranker) ? { rerank: (providers.codeReranker ?? providers.reranker)!.rerank } : {}),
        }
      : undefined
    const profile = codeEmbedding
      ? {
          provider: codeEmbedding.profile.provider,
          model: codeEmbedding.profile.model,
          space: codeEmbedding.profile.space,
          dimensions: codeEmbedding.profile.dimensions!,
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
      ...(beforeSourceFingerprint ? { beforeSourceFingerprint } : {}),
      ...(config.mechanism?.code ? { rerankCandidateLimit: MECHANISM_RETRIEVAL_PRESETS.code.candidateLimit } : {}),
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
  const getReuse = (id: string) => {
    if (!providers.decisions) throw new SearchRuntimeError('CAPABILITY_DISABLED')
    let reuse = reuseContexts.get(id)
    if (!reuse) {
      reuse = createReuseContext({ index: getIndex(id), decisions: providers.decisions })
      reuseContexts.set(id, reuse)
    }
    return reuse
  }
  const getProjectTextIndex = (id: string): ProjectTextIndex => {
    if (!config.projectText) throw new SearchRuntimeError('CAPABILITY_DISABLED')
    let index = projectTextIndexes.get(id)
    if (index) return index
    const root = getRoot(id)
    const embedding = config.projectText.embedding
    const maxItems = embedding?.limits?.maxItems ?? 32
    index = createProjectTextIndex({
      database,
      ...(providers.projectTextDocumentEmbedding && providers.projectTextQueryEmbedding
        ? {
            documentEmbedding: providers.projectTextDocumentEmbedding,
            queryEmbedding: providers.projectTextQueryEmbedding,
          }
        : {}),
      ...(providers.projectTextReranker
        ? {
            reranker: providers.projectTextReranker,
            rerankCandidateLimit: PROJECT_TEXT_RETRIEVAL_PRESET.reranker.candidateLimit,
          }
        : {}),
      ...(embedding ? { embeddingBatchSize: Math.min(32, maxItems) } : {}),
      ...(root.config.exclude ? { exclude: [...root.config.exclude] } : {}),
      ...(root.config.limits
        ? {
            limits: compact({
              maxFiles: root.config.limits.maxFiles,
              maxFileBytes: root.config.limits.maxFileBytes,
              maxTotalBytes: root.config.limits.maxTotalBytes,
              maxChunks: root.config.limits.maxChunks,
              maxChunkChars: root.config.limits.maxChunkChars,
            }),
          }
        : {}),
    })
    projectTextIndexes.set(id, index)
    return index
  }
  const sourceFingerprintForRoot = async (id: string, signal?: AbortSignal) => {
    const root = await assertRoot(id)
    const code = await getIndex(id).sourceFingerprint(root.path, signal)
    if (!config.projectText) return code
    const text = await getProjectTextIndex(id).sourceFingerprint(root.path, signal)
    return hashFingerprint(JSON.stringify([code, text]))
  }

  async function shutdown() {
    if (closing) return closing
    closed = true
    for (const operation of operations)
      operation.controller.abort(new SearchRuntimeError('RUNTIME_CLOSED'))
    runtimeJobClose = true
    for (const job of jobs.values()) {
      if (job.state === 'queued' || job.state === 'running') {
        job.cancelRequested = true
        job.controller.abort(new SearchRuntimeError('RUNTIME_CLOSED'))
      }
    }
    for (const controller of watcherControllers.values())
      controller.abort(new SearchRuntimeError('RUNTIME_CLOSED'))
    for (const operation of controlOperations)
      operation.controller.abort(new SearchRuntimeError('RUNTIME_CLOSED'))
    closing = (async () => {
      const failures: unknown[] = []
      const startupPromises = [...watcherStarts.values()]
      const operationPromises = [...operations].map((item) => item.promise)
      const controlPromises = [...controlOperations].map((item) => item.promise)
      jobQueue.length = 0
      for (const job of jobs.values()) if (job.state === 'queued') {
        job.state = 'cancelled'
        job.errorCode = 'CANCELLED'
        settleJob(job)
      }
      jobQueue.length = 0
      const jobPromises = [...jobs.values()].filter((job) => job.state === 'running').map((job) => job.promise)
      await Promise.allSettled(startupPromises)
      await Promise.allSettled([...watchers.values()].map((watcher) => watcher.close()))
      await Promise.allSettled(operationPromises)
      await Promise.allSettled(controlPromises)
      await Promise.allSettled(jobPromises)
      const contextLifecycle = await Promise.allSettled([
        ...[...reuseContexts.values()].map((context) => context.close()),
        ...[...contexts.values()].map((context) => context.close()),
      ])
      for (const result of contextLifecycle) if (result.status === 'rejected') failures.push(result.reason)
      const indexLifecycle = await Promise.allSettled([
        ...[...indexes.values()].map((index) => index.close()),
        ...[...projectTextIndexes.values()].map((index) => index.close()),
      ])
      for (const result of indexLifecycle) if (result.status === 'rejected') failures.push(result.reason)
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
        reconcile: async (_cause: 'event' | 'interval') => {
          let attemptedFingerprint: string | undefined
          try {
            const currentFingerprint = await executeControl(ownerController.signal, (signal) =>
              sourceFingerprintForRoot(id, signal),
            )
            if (watcherPaused.has(id)) {
              if (currentFingerprint === watcherFailedFingerprints.get(id)) return
              watcherPaused.delete(id)
              watcherFailures.delete(id)
            }
            if (currentFingerprint === watcherIndexedFingerprints.get(id)) {
              watcherPaused.delete(id)
              watcherFailedFingerprints.delete(id)
              watcherErrors.delete(id)
              watcherFailures.delete(id)
              return
            }
            attemptedFingerprint = currentFingerprint
            const admission = admitIndexJob(id)
            const job = jobs.get(admission.job.jobId)
            if (!job) throw new SearchRuntimeError('JOB_NOT_FOUND')
            await job.promise
            if (job.state !== 'completed') throw new SearchRuntimeError(job.errorCode ?? 'OPERATION_FAILED')
            const completedFingerprint = config.projectText
              ? completedIndexFingerprints.get(id)
              : currentFingerprint
            if (!completedFingerprint) throw new SearchRuntimeError('OPERATION_FAILED')
            watcherIndexedFingerprints.set(id, completedFingerprint)
            watcherFailedFingerprints.delete(id)
            watcherErrors.delete(id)
            watcherFailures.delete(id)
          } catch (error) {
            if (!ownerController.signal.aborted) {
              const safe = sanitize(error, undefined, ownerController.signal)
              watcherErrors.set(id, safe.code)
              const failures = (watcherFailures.get(id) ?? 0) + 1
              watcherFailures.set(id, failures)
              if (isPermanentIndexError(safe.code) || failures >= 3) {
                watcherPaused.add(id)
                if (attemptedFingerprint) watcherFailedFingerprints.set(id, attemptedFingerprint)
              }
            }
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
        embedding: Boolean(providers.codeEmbedding ?? providers.embedding),
        webEmbedding: Boolean(
          providers.web &&
            config.web?.discovery &&
            (providers.webEmbedding ?? providers.embedding),
        ),
        codeReranking: Boolean((providers.codeEmbedding ?? providers.embedding) && (providers.codeReranker ?? providers.reranker)),
        webReranking: Boolean(providers.web && config.web?.discovery && providers.reranker),
        webRead: Boolean(providers.web),
        webDiscovery: Boolean(config.web?.discovery && providers.web),
        classification: Boolean(providers.classifier),
        reuseContext: Boolean(providers.decisions),
        visual: Boolean(providers.visualEmbedding),
        projectText: Boolean(config.projectText),
        projectTextIndexing: Boolean(config.projectText),
        projectTextEmbedding: Boolean(
          providers.projectTextDocumentEmbedding && providers.projectTextQueryEmbedding,
        ),
        projectTextReranking: Boolean(providers.projectTextReranker),
      }
    },
    usage() {
      return {
        embedding: (providers.codeEmbedding ?? providers.embedding)?.usage() ?? null,
        codeEmbedding: providers.codeEmbedding?.usage() ?? null,
        webEmbedding: providers.webEmbedding?.usage() ?? null,
        reranking: providers.reranker?.usage() ?? null,
        classification: providers.classifier?.usage() ?? null,
        web:
          providers.web && 'usage' in providers.web
            ? (providers.web as WebSource & { usage(): unknown }).usage()
            : null,
        codeReranking: providers.codeReranker?.usage() ?? null,
        visual: providers.visualEmbedding?.usage() ?? null,
        projectTextEmbedding: providers.projectTextDocumentEmbedding?.usage() ?? null,
        projectTextQueryEmbedding: providers.projectTextQueryEmbedding?.usage() ?? null,
        projectTextReranking: providers.projectTextReranker?.usage() ?? null,
      }
    },
    profiles() {
      return {
        embedding: (providers.codeEmbedding ?? providers.embedding) ? structuredClone((providers.codeEmbedding ?? providers.embedding)!.profile) : null,
        codeEmbedding: providers.codeEmbedding ? structuredClone(providers.codeEmbedding.profile) : null,
        webEmbedding: providers.webEmbedding ? structuredClone(providers.webEmbedding.profile) : null,
        reranking: providers.reranker ? structuredClone(providers.reranker.profile) : null,
        codeReranking: (providers.codeReranker ?? providers.reranker)
          ? structuredClone((providers.codeReranker ?? providers.reranker)!.profile)
          : null,
        classification: providers.classifier ? structuredClone(providers.classifier.profile) : null,
        visual: providers.visualEmbedding ? structuredClone(providers.visualEmbedding.profile) : null,
        projectTextEmbedding: providers.projectTextDocumentEmbedding
          ? structuredClone(providers.projectTextDocumentEmbedding.profile)
          : null,
        projectTextQueryEmbedding: providers.projectTextQueryEmbedding
          ? structuredClone(providers.projectTextQueryEmbedding.profile)
          : null,
        projectTextReranking: providers.projectTextReranker
          ? structuredClone(providers.projectTextReranker.profile)
          : null,
      }
    },
    async indexStatus(input: {
      rootId: string
      jobId?: string
      signal?: AbortSignal
    }): Promise<RuntimeIndexStatus> {
      const { request, signal } = captureRequest(indexStatusRequest, input)
      return executeControl(signal, async (controlSignal) => {
        await beforeIndexStatus?.(controlSignal)
        controlSignal.throwIfAborted()
        const root = await assertRoot(request.rootId)
        const status = await getIndex(request.rootId).indexStatus(root.path, controlSignal)
        const job = request.jobId ? jobs.get(request.jobId) : jobsByRoot.get(request.rootId)
        if (request.jobId && (!job || job.rootId !== request.rootId)) throw new SearchRuntimeError('JOB_NOT_FOUND')
        return {
          ...status,
          watcherError: watcherErrors.get(request.rootId) ?? null,
          watching: watchers.has(request.rootId),
          indexingJob: job ? publishJob(job) : null,
          ...(config.projectText
            ? {
                projectTextStatus: await getProjectTextIndex(request.rootId).indexStatus(
                  root.path,
                  controlSignal,
                ),
              }
            : {}),
        }
      })
    },
    async projectTextStatus(input: { rootId: string; signal?: AbortSignal }) {
      const { request, signal } = captureRequest(statusRequest, input)
      return executeControl(signal, async (controlSignal) => {
        if (!config.projectText) throw new SearchRuntimeError('CAPABILITY_DISABLED')
        const root = await assertRoot(request.rootId)
        return getProjectTextIndex(request.rootId).indexStatus(root.path, controlSignal)
      })
    },
    async indexProjectText(input: { rootId: string; signal?: AbortSignal }) {
      const { request, signal } = captureRequest(statusRequest, input)
      return execute(signal, async (operationSignal) => {
        if (!config.projectText) throw new SearchRuntimeError('CAPABILITY_DISABLED')
        return runOnRootIndexLane(request.rootId, operationSignal, (root) =>
          getProjectTextIndex(request.rootId).indexRepository({
            root: root.path,
            signal: operationSignal,
          }),
        )
      })
    },
    async searchProjectText(input: {
      rootId: string
      query: string
      kinds?: ProjectTextKind[] | undefined
      paths?: string[] | undefined
      limit?: number | undefined
      mode?: 'lexical' | 'hybrid' | undefined
      maxChars?: number | undefined
      signal?: AbortSignal | undefined
    }) {
      const { request, signal } = captureRequest(projectTextSearchRequest, input)
      return execute(signal, async (operationSignal) => {
        if (!config.projectText) throw new SearchRuntimeError('CAPABILITY_DISABLED')
        const root = await assertRoot(request.rootId)
        return getProjectTextIndex(request.rootId).searchProjectText({
          root: root.path,
          query: request.query,
          ...(request.kinds === undefined ? {} : { kinds: request.kinds as ProjectTextKind[] }),
          ...(request.paths === undefined ? {} : { paths: [...request.paths] }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
          ...(request.mode === undefined ? {} : { mode: request.mode }),
          ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }),
          signal: operationSignal,
        })
      })
    },
    async readProjectText(input: {
      rootId: string
      path: string
      lineStart?: number | undefined
      lineEnd?: number | undefined
      snapshotId?: string | undefined
      signal?: AbortSignal | undefined
    }) {
      const { request, signal } = captureRequest(projectTextReadRequest, input)
      return execute(signal, async (operationSignal) => {
        if (!config.projectText) throw new SearchRuntimeError('CAPABILITY_DISABLED')
        const root = await assertRoot(request.rootId)
        return getProjectTextIndex(request.rootId).readProjectText({
          root: root.path,
          path: request.path,
          ...(request.lineStart === undefined ? {} : { lineStart: request.lineStart }),
          ...(request.lineEnd === undefined ? {} : { lineEnd: request.lineEnd }),
          ...(request.snapshotId === undefined ? {} : { snapshotId: request.snapshotId }),
          signal: operationSignal,
        })
      })
    },
    startIndexing(input: { rootId: string; signal?: AbortSignal }) {
      const { request, signal } = captureRequest(startIndexingRequest, input)
      if (signal?.aborted) throw new SearchRuntimeError('CANCELLED')
      getRoot(request.rootId)
      return admitIndexJob(request.rootId)
    },
    async cancelIndexing(input: { rootId: string; jobId: string }) {
      const { request } = captureRequest(cancelIndexingRequest, input)
      getRoot(request.rootId)
      const job = jobs.get(request.jobId)
      if (!job || job.rootId !== request.rootId) throw new SearchRuntimeError('INVALID_REQUEST')
      if (job.state === 'queued' || job.state === 'running') {
        job.cancelRequested = true
        job.controller.abort(new SearchRuntimeError('CANCELLED'))
        if (job.state === 'queued') {
          job.state = 'cancelled'
          job.errorCode = 'CANCELLED'
          settleJob(job)
        }
      }
      await job.promise
      return publishJob(job)
    },
    async indexRepository(input: { rootId: string; signal?: AbortSignal }) {
      const { request, signal } = captureRequest(indexRequest, input)
      return execute(signal, async (operationSignal) => {
        return runIndexExclusive(request.rootId, operationSignal)
      })
    },
    async indexCodeSymbols(input: { rootId: string; signal?: AbortSignal }) {
      const { request, signal } = captureRequest(indexCodeSymbolsRequest, input)
      return execute(signal, (operationSignal) => runOnRootIndexLane(
        request.rootId,
        operationSignal,
        (root) => {
          const index = getIndex(request.rootId)
          if (!index.indexCodeSymbols) throw new SearchRuntimeError('CAPABILITY_DISABLED')
          return index.indexCodeSymbols({ root: root.path, signal: operationSignal })
        },
      ))
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
          ...(request.sourceKind === undefined ? {} : { sourceKind: request.sourceKind }),
          ...(request.limit === undefined ? (config.mechanism?.code ? { limit: MECHANISM_RETRIEVAL_PRESETS.code.defaultLimit } : {}) : { limit: request.limit }),
          ...(request.mode === undefined ? {} : { mode: request.mode }),
          signal: operationSignal,
        } as CodeSearchInput)
      })
    },
    async findCodeDuplicates(input: Omit<CodeDuplicatesInput, 'root'> & { rootId: string }) {
      const { request, signal } = captureRequest(codeDuplicatesRequest, input)
      return execute(signal, async (operationSignal) => {
        const root = await assertRoot(request.rootId)
        const index = getIndex(request.rootId)
        if (!index.findCodeDuplicates) throw new SearchRuntimeError('CAPABILITY_DISABLED')
        return index.findCodeDuplicates({
          root: root.path,
          ...(request.paths === undefined ? {} : { paths: request.paths }),
          ...(request.language === undefined ? {} : { language: request.language }),
          ...(request.sourceKind === undefined ? {} : { sourceKind: request.sourceKind }),
          ...(request.matchMode === undefined ? {} : { matchMode: request.matchMode }),
          ...(request.minTokens === undefined ? {} : { minTokens: request.minTokens }),
          ...(request.minOccurrences === undefined
            ? {}
            : { minOccurrences: request.minOccurrences }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
          ...(request.maxOccurrencesPerGroup === undefined
            ? {}
            : { maxOccurrencesPerGroup: request.maxOccurrencesPerGroup }),
          signal: operationSignal,
        })
      })
    },
    async findCodeSymbols(input: Omit<FindCodeSymbolsInput, 'root'> & { rootId: string }) {
      const { request, signal } = captureRequest(findCodeSymbolsRequest, input)
      return execute(signal, async (operationSignal) => {
        const root = await assertRoot(request.rootId)
        const index = getIndex(request.rootId)
        if (!index.findCodeSymbols) throw new SearchRuntimeError('CAPABILITY_DISABLED')
        return index.findCodeSymbols({
          root: root.path,
          ...(request.query === undefined ? {} : { query: request.query }),
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.path === undefined ? {} : { path: request.path }),
          ...(request.symbolId === undefined ? {} : { symbolId: request.symbolId }),
          ...(request.enclosing === undefined ? {} : { enclosing: {
            path: request.enclosing.path,
            lineStart: request.enclosing.lineStart,
            ...(request.enclosing.lineEnd === undefined ? {} : { lineEnd: request.enclosing.lineEnd }),
          } }),
          ...(request.language === undefined ? {} : { language: request.language }),
          ...(request.sourceKind === undefined ? {} : { sourceKind: request.sourceKind }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          signal: operationSignal,
        })
      })
    },
    async findCodeReferences(input: Omit<FindCodeReferencesInput, 'root'> & { rootId: string }) {
      const { request, signal } = captureRequest(findCodeReferencesRequest, input)
      return execute(signal, async (operationSignal) => {
        const root = await assertRoot(request.rootId)
        const index = getIndex(request.rootId)
        if (!index.findCodeReferences) throw new SearchRuntimeError('CAPABILITY_DISABLED')
        return index.findCodeReferences({
          root: root.path,
          symbolId: request.symbolId,
          ...(request.direction === undefined ? {} : { direction: request.direction }),
          ...(request.kind === undefined ? {} : { kind: request.kind }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          signal: operationSignal,
        })
      })
    },
    async traceCodeCalls(input: Omit<TraceCodeCallsInput, 'root'> & { rootId: string }) {
      const { request, signal } = captureRequest(traceCodeCallsRequest, input)
      return execute(signal, async (operationSignal) => {
        const root = await assertRoot(request.rootId)
        const index = getIndex(request.rootId)
        if (!index.traceCodeCalls) throw new SearchRuntimeError('CAPABILITY_DISABLED')
        return index.traceCodeCalls({
          root: root.path,
          symbolId: request.symbolId,
          ...(request.direction === undefined ? {} : { direction: request.direction }),
          ...(request.maxDepth === undefined ? {} : { maxDepth: request.maxDepth }),
          ...(request.maxNodes === undefined ? {} : { maxNodes: request.maxNodes }),
          ...(request.maxEdges === undefined ? {} : { maxEdges: request.maxEdges }),
          signal: operationSignal,
        })
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
      language?: string
      sourceKind?: 'implementation' | 'tests' | 'documentation' | 'all'
      mustInclude?: Array<{ path: string; lineStart?: number; lineEnd?: number }>
      includeRelated?: boolean
      includeLogical?: boolean
      relatedDepth?: number
      relatedMaxPaths?: number
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
          ...(request.language === undefined ? {} : { language: request.language }),
          ...(request.sourceKind === undefined ? {} : { sourceKind: request.sourceKind }),
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
          ...(request.includeLogical === undefined ? {} : { includeLogical: request.includeLogical }),
          ...(request.relatedDepth === undefined ? {} : { relatedDepth: request.relatedDepth }),
          ...(request.relatedMaxPaths === undefined ? {} : { relatedMaxPaths: request.relatedMaxPaths }),
          ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
          signal: operationSignal,
        } as CodeContextRequest)
      })
    },
    async getReuseContext(input: { rootId: string; query: string; maxChars?: number; limit?: number; signal?: AbortSignal }) {
      const { request, signal } = captureRequest(reuseContextRequest, input)
      return execute(signal, async (operationSignal) => {
        const root = await assertRoot(request.rootId)
        if (!providers.decisions) throw new SearchRuntimeError('CAPABILITY_DISABLED')
        return getReuse(request.rootId).getReuseContext({
          root: root.path,
          query: request.query,
          ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }),
          ...(request.limit === undefined ? {} : { limit: request.limit }),
          signal: operationSignal,
        })
      })
    },
    async searchWeb(input: {
      query: string
      limit?: number
      maxChars?: number
      dateRange?: WebDateRange
      additionalQueries?: string[]
      signal?: AbortSignal
    }): Promise<WebSearchResult> {
      const { request, signal } = captureRequest(webSearchRequest, input)
      return execute(signal, async (operationSignal) => {
        if (!providers.web || !config.web?.discovery)
          throw new SearchRuntimeError('CAPABILITY_DISABLED')
        const webTextEmbedding = providers.webEmbedding ?? providers.embedding
        const models = {
          ...(webTextEmbedding
            ? { embed: { profile: webTextEmbedding.profile, embed: webTextEmbedding.embed } }
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
            ...(request.dateRange === undefined ? {} : { dateRange: request.dateRange }),
            ...(request.additionalQueries === undefined
              ? {}
              : { additionalQueries: request.additionalQueries }),
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
    async searchVisualReferences(input: {
      references: Array<{ id: string; contentHash: string; screen?: string; state?: string; breakpoint?: string; text?: string; image?: { mimeType: string; dataBase64: string } }>
      queryText?: string
      queryImage?: { mimeType: string; dataBase64: string }
      limit?: number
      signal?: AbortSignal
    }) {
      if (input && typeof input === 'object' && Array.isArray(input.references)) {
        let encodedBytes = typeof input.queryText === 'string' ? Buffer.byteLength(input.queryText) : 0
        for (const ref of input.references)
          if (ref && typeof ref === 'object' && ref.image && typeof ref.image.dataBase64 === 'string')
            encodedBytes += ref.image.dataBase64.length
        if (input.queryImage && typeof input.queryImage.dataBase64 === 'string')
          encodedBytes += input.queryImage.dataBase64.length
        if (encodedBytes > 11_000_000) throw new SearchRuntimeError('INVALID_REQUEST')
      }
      const { request, signal } = captureRequest(visualSearchRequest, input)
      return execute(signal, async (operationSignal) => {
        if (!providers.visualEmbedding) throw new SearchRuntimeError('CAPABILITY_DISABLED')
        const decode = (image: { mimeType: string; dataBase64: string }) => {
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(image.dataBase64))
            throw new SearchRuntimeError('INVALID_REQUEST')
          const bytes = Buffer.from(image.dataBase64, 'base64')
          if (!bytes.length || bytes.length > 2_000_000 || bytes.toString('base64') !== image.dataBase64)
            throw new SearchRuntimeError('INVALID_REQUEST')
          return { bytes: Uint8Array.from(bytes), mimeType: image.mimeType }
        }
        const ids = new Set<string>()
        let totalBytes = 0
        const prepared = request.references.map((ref) => {
          if (ids.has(ref.id)) throw new SearchRuntimeError('INVALID_REQUEST')
          ids.add(ref.id)
          const image = ref.image ? decode(ref.image) : undefined
          const bytes = image?.bytes ?? Buffer.from(ref.text!, 'utf8')
          totalBytes += bytes.length
          if (totalBytes > 8_000_000 || createHash('sha256').update(bytes).digest('hex') !== ref.contentHash.replace(/^sha256:/iu, '').toLowerCase())
            throw new SearchRuntimeError('INVALID_REQUEST')
          const reference = {
            id: ref.id,
            contentHash: ref.contentHash,
            ...(ref.screen === undefined ? {} : { screen: ref.screen }),
            ...(ref.state === undefined ? {} : { state: ref.state }),
            ...(ref.breakpoint === undefined ? {} : { breakpoint: ref.breakpoint }),
            ...(ref.text === undefined ? {} : { text: ref.text }),
          }
          return { reference, ...(image ? { image } : {}) }
        })
        const queryImage = request.queryImage ? decode(request.queryImage) : undefined
        if (queryImage) totalBytes += queryImage.bytes.length
        if (request.queryText) totalBytes += Buffer.byteLength(request.queryText)
        if (totalBytes > 8_000_000) throw new SearchRuntimeError('INVALID_REQUEST')
        const visual = createVisualSearch({ enabled: true, embedding: providers.visualEmbedding, profile: providers.visualEmbedding.profile })
        try {
          for (const ref of prepared) {
            operationSignal.throwIfAborted()
            await visual.upsert({ ...ref, signal: operationSignal })
          }
          return await visual.search({
            ...(request.queryText ? { text: request.queryText } : {}),
            ...(queryImage ? { image: queryImage } : {}),
            limit: request.limit ?? MECHANISM_RETRIEVAL_PRESETS.visual.defaultLimit,
            signal: operationSignal,
          })
        } finally { await visual.close() }
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
        retryOnChange: watcherPaused.has(request.rootId),
        job: jobsByRoot.has(request.rootId) ? publishJob(jobsByRoot.get(request.rootId)!) : null,
      }
    },
    close: shutdown,
  }

  try {
    for (const root of roots)
      if (root.config.watch) {
        if (optionsBackgroundWatchStartup) {
          admitIndexJob(root.config.id)
        } else await execute(startupSignal, async (signal) => {
          const indexed = await runIndexExclusive(root.config.id, signal)
          if (indexed.identity) {
            const acceptedFingerprint = config.projectText
              ? completedIndexFingerprints.get(root.config.id)
              : indexed.identity.snapshotId
            if (!acceptedFingerprint) throw new SearchRuntimeError('OPERATION_FAILED')
            watcherIndexedFingerprints.set(root.config.id, acceptedFingerprint)
          }
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

function captureRequest<S extends z.ZodType>(
  schema: S,
  input: unknown,
): { request: z.infer<S>; signal?: AbortSignal } {
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
    config.web?.embedding?.secret,
    config.reranker?.secret,
    config.projectText?.embedding?.secret,
    config.projectText?.reranker?.secret,
    config.classifier?.secret,
    config.web?.discovery?.secret,
    config.mechanism?.code?.secret,
    config.mechanism?.visual?.secret,
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
function isPermanentIndexError(code: string): boolean {
  return ['PROVIDER_AUTH', 'PROVIDER_QUOTA', 'PROVIDER_MALFORMED'].includes(code)
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
  'CODE_INDEX_SYMBOL_CURSOR_INVALID',
  'CODE_INDEX_SYMBOL_CURSOR_STALE',
  'CODE_INDEX_SYMBOL_DIRECTION_INVALID',
  'CODE_INDEX_SYMBOL_ID_INVALID',
  'CODE_INDEX_SYMBOL_KIND_INVALID',
  'CODE_INDEX_SYMBOL_LIMIT_INVALID',
  'CODE_INDEX_SYMBOL_NOT_FOUND',
  'CODE_INDEX_SYMBOL_PROFILE_MISMATCH',
  'CODE_INDEX_SYMBOL_QUERY_INVALID',
  'CODE_CONTEXT_STALE_SNAPSHOT',
  'CODE_CONTEXT_MANDATORY_BUDGET',
  'CODE_CONTEXT_CLOSED',
  'CODE_CONTEXT_LIMIT',
  'CODE_CONTEXT_TIMEOUT',
  'OPERATION_LIMIT',
  'OPERATION_CLOSED',
  'OPERATION_TIMEOUT',
  'ROOT_CHANGED',
  'PROJECT_TEXT_CHUNK_LIMIT',
  'PROJECT_TEXT_DATABASE_INVALID',
  'PROJECT_TEXT_EMBEDDING_PROFILE_INVALID',
  'PROJECT_TEXT_EMBEDDING_PROFILE_MISMATCH',
  'PROJECT_TEXT_EMBEDDING_PAIR_REQUIRED',
  'PROJECT_TEXT_EXCLUSION_POLICY_INVALID',
  'PROJECT_TEXT_GENERATION_INVALID',
  'PROJECT_TEXT_GENERATION_SUPERSEDED',
  'PROJECT_TEXT_INDEXED_AT_INVALID',
  'PROJECT_TEXT_INDEX_CLOSED',
  'PROJECT_TEXT_LIMIT_INVALID',
  'PROJECT_TEXT_LINE_LIMIT',
  'PROJECT_TEXT_MODELS_INVALID',
  'PROJECT_TEXT_NOT_INDEXED',
  'PROJECT_TEXT_PATH_NOT_INDEXED',
  'PROJECT_TEXT_PROFILE_MUTATED',
  'PROJECT_TEXT_RANGE_INVALID',
  'PROJECT_TEXT_RANGE_OUT_OF_BOUNDS',
  'PROJECT_TEXT_RERANKER_INVALID',
  'PROJECT_TEXT_RERANK_INVALID',
  'PROJECT_TEXT_ROOT_INVALID',
  'PROJECT_TEXT_SCOPE_MISMATCH',
  'PROJECT_TEXT_SEARCH_INPUT_INVALID',
  'PROJECT_TEXT_SNAPSHOT_MISMATCH',
  'PROJECT_TEXT_SNAPSHOT_SUPERSEDED',
  'PROJECT_TEXT_SOURCE_CHANGED',
  'PROJECT_TEXT_VECTOR_INVALID',
])
const providerRuntimeErrorCode = {
  auth: 'PROVIDER_AUTH',
  quota: 'PROVIDER_QUOTA',
  rate_limit: 'PROVIDER_RATE_LIMIT',
  timeout: 'PROVIDER_TIMEOUT',
  cancel: 'PROVIDER_CANCEL',
  malformed: 'PROVIDER_MALFORMED',
  unavailable: 'PROVIDER_UNAVAILABLE',
  budget: 'PROVIDER_BUDGET',
} satisfies Record<ProviderErrorCode, string>

export const SEARCH_RUNTIME_ERROR_CODES: readonly string[] = Object.freeze([
  'INVALID_REQUEST',
  'ROOT_NOT_CONFIGURED',
  'ROOT_CHANGED',
  'RUNTIME_CLOSED',
  'RUNTIME_BUSY',
  'JOB_NOT_FOUND',
  'TIMEOUT',
  'CANCELLED',
  'CAPABILITY_DISABLED',
  'STARTUP_CLEANUP_FAILED',
  'CLOSE_FAILED',
  'OPERATION_FAILED',
  'WATCH_DISABLED',
  'SECRET_UNAVAILABLE',
  'CONFIG_INVALID',
  ...Object.values(providerRuntimeErrorCode),
  ...knownCodes,
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
    if (reason instanceof Error && reason.name === 'OperationTimeoutError')
      return new SearchRuntimeError('OPERATION_TIMEOUT')
    return new SearchRuntimeError('CANCELLED')
  }
  if (error instanceof SearchRuntimeError) return error
  if (error instanceof RuntimeConfigError) return new SearchRuntimeError(error.code)
  if (error instanceof ProviderError)
    return new SearchRuntimeError(
      providerRuntimeErrorCode[error.code],
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
