import { randomUUID } from 'node:crypto'

import type { MaintenanceHandle } from './maintenance.js'
import type { SearchErrorFactory } from './errors.js'

import type {
  KnowledgeDeleteInput,
  KnowledgeDeleteResult,
  SearchEvent,
  SearchInput,
  SearchJobSnapshot,
  SearchLegacyEvent,
  SearchProgressFact,
  SearchResult,
  SearchStageEmitter,
} from './contracts.js'
import type { SearchDependencies } from './search.js'

import {
  knowledgeDeleteSchema,
  searchProgressEventSchema,
  searchProgressFactSchema,
  searchRequestSchema,
} from './contracts.js'
import { executeSearch } from './search.js'
import { defaultSearchErrorFactory } from './errors.js'
import { startMaintenance } from './maintenance.js'

/** Maximum concurrent `SearchService.events()` iterators per job (library + HTTP SSE). */
export const SEARCH_EVENT_SUBSCRIBER_LIMIT = 16

interface InternalJob {
  snapshot: SearchJobSnapshot
  controller: AbortController
  events: SearchEvent[]
  listeners: Set<() => void>
  activeEventReaders: number
  done: Promise<void>
  finishedAt?: number
}
export class SearchService {
  readonly #jobs = new Map<string, InternalJob>()
  readonly #dependencies: SearchDependencies
  #maintenance: MaintenanceHandle | undefined
  #closed = false
  #closing: Promise<void> | undefined
  #deletion: Promise<KnowledgeDeleteResult> | undefined
  #deletionController: AbortController | undefined
  readonly #error: SearchErrorFactory
  constructor(dependencies: SearchDependencies & { errorFactory?: SearchErrorFactory }) {
    this.#dependencies = dependencies
    this.#error = dependencies.errorFactory ?? defaultSearchErrorFactory
  }
  #requireJob(id: string): InternalJob {
    const job = this.#jobs.get(id)
    if (!job) throw new Error('SEARCH_JOB_NOT_FOUND')
    return job
  }
  startSearch(input: SearchInput, signal?: AbortSignal): { jobId: string } {
    const request = searchRequestSchema.parse(input)
    signal?.throwIfAborted()
    this.#assertAvailable()
    if (this.#jobs.size >= 1000) throw new Error('SEARCH_JOB_LIMIT')
    const id = randomUUID()
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const job: InternalJob = {
      snapshot: { id, status: 'running' },
      controller,
      events: [],
      listeners: new Set(),
      activeEventReaders: 0,
      done: Promise.resolve(),
    }
    this.#jobs.set(id, job)
    let sequence = 0
    const pushEvent = (event: SearchEvent) => {
      job.events.push(event)
      if (job.events.length > 512) job.events.shift()
      for (const listener of job.listeners) {
        try {
          listener()
        } catch {
          /* reader/listener failure must not affect job execution */
        }
      }
    }
    const emitLegacy = (type: SearchLegacyEvent['type'], detail: Record<string, unknown>) => {
      pushEvent({ jobId: id, sequence: ++sequence, type, detail })
    }
    const emitProgress = (fact: SearchProgressFact) => {
      if (controller.signal.aborted) return
      const progress = searchProgressFactSchema.safeParse(fact)
      if (!progress.success) return
      const event = searchProgressEventSchema.safeParse({
        jobId: id,
        sequence: ++sequence,
        timestamp: new Date().toISOString(),
        type: 'progress',
        progress: progress.data,
      })
      if (!event.success) return
      pushEvent(event.data)
    }
    const stageEmitter: SearchStageEmitter = {
      legacy: (type, detail) => {
        if (controller.signal.aborted) return
        emitLegacy(type, detail)
      },
      progress: emitProgress,
    }
    emitLegacy('started', { query: request.query })
    job.done = executeSearch(request, this.#dependencies, controller.signal, stageEmitter)
      .then((result) => {
        controller.signal.throwIfAborted()
        job.snapshot = { id, status: 'succeeded', result }
        emitLegacy('finished', { origin: result.origin, partial: result.partial })
      })
      .catch((error: unknown) => {
        job.snapshot = controller.signal.aborted
          ? { id, status: 'cancelled' }
          : {
              id,
              status: 'failed',
              error: error instanceof Error ? error.message : 'SEARCH_FAILED',
            }
        emitLegacy(job.snapshot.status === 'cancelled' ? 'cancelled' : 'failed', {
          code: job.snapshot.error ?? 'CANCELLED',
        })
      })
      .finally(() => {
        job.finishedAt = Date.now()
        signal?.removeEventListener('abort', onAbort)
      })
    return { jobId: id }
  }
  status(id: string): SearchJobSnapshot {
    this.#assertAvailable()
    return { ...this.#requireJob(id).snapshot }
  }
  async result(id: string): Promise<SearchResult> {
    this.#assertAvailable()
    const job = this.#requireJob(id)
    await job.done
    this.#assertAvailable()
    job.controller.signal.throwIfAborted()
    if (job.snapshot.status !== 'succeeded' || !job.snapshot.result)
      throw new Error(job.snapshot.error ?? 'SEARCH_CANCELLED')
    return job.snapshot.result
  }
  cancel(id: string): void {
    const job = this.#requireJob(id)
    if (job.snapshot.status === 'running') job.controller.abort(new Error('SEARCH_CANCELLED'))
  }
  async *events(id: string, signal?: AbortSignal): AsyncGenerator<SearchEvent> {
    this.#assertAvailable()
    const job = this.#requireJob(id)
    let slotHeld = false
    try {
      if (job.activeEventReaders >= SEARCH_EVENT_SUBSCRIBER_LIMIT) {
        throw new Error('SEARCH_EVENT_SUBSCRIBER_LIMIT')
      }
      job.activeEventReaders++
      slotHeld = true
      let cursor = 0
      for (;;) {
        this.#assertAvailable()
        signal?.throwIfAborted()
        for (const event of job.events) {
          if (event.sequence > cursor) {
            this.#assertAvailable()
            signal?.throwIfAborted()
            cursor = event.sequence
            yield event
          }
        }
        if (job.snapshot.status !== 'running') return
        await new Promise<void>((resolve, reject) => {
          const wake = () => {
            cleanup()
            resolve()
          }
          const abort = () => {
            cleanup()
            reject(signal?.reason ?? new Error('SEARCH_EVENT_READER_ABORTED'))
          }
          const cleanup = () => {
            job.listeners.delete(wake)
            signal?.removeEventListener('abort', abort)
          }
          job.listeners.add(wake)
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) abort()
        })
      }
    } finally {
      if (slotHeld) job.activeEventReaders--
    }
  }
  async deleteKnowledge(
    input: KnowledgeDeleteInput,
    signal: AbortSignal,
  ): Promise<KnowledgeDeleteResult> {
    const valid = knowledgeDeleteSchema.parse(input)
    signal.throwIfAborted()
    this.#assertAvailable()
    const remove = this.#dependencies.repository.deleteKnowledge
    if (!remove) throw new Error('KNOWLEDGE_DELETE_UNAVAILABLE')
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    this.#deletionController = controller
    const deletion = Promise.resolve()
      .then(() => this.#removeKnowledge(valid, controller.signal, remove))
      .finally(() => {
        signal.removeEventListener('abort', onAbort)
        this.#deletion = undefined
        this.#deletionController = undefined
      })
    this.#deletion = deletion
    return deletion
  }
  async #removeKnowledge(
    input: KnowledgeDeleteInput,
    signal: AbortSignal,
    remove: NonNullable<SearchDependencies['repository']['deleteKnowledge']>,
  ): Promise<KnowledgeDeleteResult> {
    signal.throwIfAborted()
    for (const job of this.#jobs.values()) job.controller.abort(new Error('KNOWLEDGE_DELETE'))
    await Promise.all([...this.#jobs.values()].map((job) => job.done))
    signal.throwIfAborted()
    const result = await remove.call(this.#dependencies.repository, input, signal)
    signal.throwIfAborted()
    this.#jobs.clear()
    return result
  }
  async collectTemporary(
    signal: AbortSignal,
    now = Date.now(),
  ): Promise<{ queries: number; jobs: number }> {
    signal.throwIfAborted()
    this.#assertAvailable()
    const cutoff = now - 86400000
    const queries =
      (await this.#dependencies.repository.collectTemporary?.(
        { before: new Date(cutoff).toISOString(), limit: 500 },
        signal,
      )) ?? 0
    let jobs = 0
    for (const [id, job] of this.#jobs) {
      if (jobs >= 500) break
      if (
        job.snapshot.status !== 'running' &&
        job.finishedAt !== undefined &&
        job.finishedAt < cutoff
      ) {
        this.#jobs.delete(id)
        jobs++
      }
    }
    return { queries, jobs }
  }
  startMaintenance(signal?: AbortSignal): void {
    this.#assertAvailable()
    this.#maintenance ??= startMaintenance(
      (owned) => this.collectTemporary(owned),
      signal ? { signal } : {},
    )
  }
  #assertAvailable(): void {
    if (this.#closed) throw this.#error('SEARCH_CLOSED', 'Search service is closed')
    if (this.#deletion)
      throw this.#error('KNOWLEDGE_DELETE_IN_PROGRESS', 'Knowledge deletion is in progress')
  }
  close(): Promise<void> {
    if (!this.#closing) {
      this.#closed = true
      this.#deletionController?.abort(new Error('SEARCH_CLOSED'))
      this.#closing = this.#finishClose()
    }
    return this.#closing
  }
  async #finishClose(): Promise<void> {
    for (const job of this.#jobs.values()) {
      if (job.snapshot.status === 'running') job.controller.abort()
      for (const listener of job.listeners) {
        try {
          listener()
        } catch {
          /* unblock event readers during shutdown */
        }
      }
    }
    const results = await Promise.allSettled([
      this.#maintenance?.close(),
      this.#deletion?.catch(() => undefined),
      ...[...this.#jobs.values()].map((job) => job.done),
    ])
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    )
    if (errors.length) throw new AggregateError(errors, 'Search service shutdown failed')
  }
}
export function createSearchService(dependencies: SearchDependencies & { errorFactory?: SearchErrorFactory }): SearchService {
  return new SearchService(dependencies)
}
