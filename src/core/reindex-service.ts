import type { OwnedDatabase } from '../storage/database.js'
import type { MaintenanceHandle } from './maintenance.js'

import type { SearchModels } from './contracts.js'
import type { EmbeddingProfile } from './embedding-profile.js'
import type { ReindexDependencies } from './reindex.js'

import { searchEmbeddingProfile } from './embedding-profile.js'
import { PostgresReindexRepository } from '../storage/postgres-reindex.js'
import { SqlQueue } from '../storage/queue/sql-queue.js'
import { startMaintenance } from './maintenance.js'
import { enqueueReindex, executeReindexBatch } from './reindex.js'

export class SearchReindexer {
  #maintenance: MaintenanceHandle | undefined
  #running: Promise<{ worked: boolean; indexed: number }> | undefined
  #closed = false
  #enqueuing: Promise<number> | undefined
  #closing: Promise<void> | undefined
  readonly #controller = new AbortController()
  constructor(private readonly dependencies: ReindexDependencies) {}
  enqueue(signal: AbortSignal): Promise<number> {
    this.#assertOpen()
    this.#enqueuing ??= enqueueReindex(
      this.dependencies,
      AbortSignal.any([signal, this.#controller.signal]),
    ).finally(() => {
      this.#enqueuing = undefined
    })
    return this.#enqueuing
  }
  runOnce(signal: AbortSignal): Promise<{ worked: boolean; indexed: number }> {
    this.#assertOpen()
    this.#running ??= executeReindexBatch(
      this.dependencies,
      AbortSignal.any([signal, this.#controller.signal]),
    ).finally(() => {
      this.#running = undefined
    })
    return this.#running
  }
  start(signal?: AbortSignal): void {
    this.#assertOpen()
    this.#maintenance ??= startMaintenance((owned) => this.runOnce(owned), {
      intervalMs: 1000,
      ...(signal ? { signal } : {}),
    })
  }
  lastError(): string | undefined {
    return this.#maintenance?.lastError()
  }
  close(): Promise<void> {
    if (!this.#closing) {
      this.#closed = true
      this.#controller.abort(new Error('REINDEX_CLOSED'))
      this.#closing = this.#finishClose()
    }
    return this.#closing
  }
  async #finishClose(): Promise<void> {
    await Promise.all([
      this.#maintenance?.close(),
      this.#enqueuing?.catch(() => undefined),
      this.#running?.catch(() => undefined),
    ])
  }
  #assertOpen(): void {
    if (this.#closed) throw new Error('REINDEX_CLOSED')
  }
}
export async function createPostgresReindexer(input: {
  database: OwnedDatabase
  models: Pick<SearchModels, 'embed'>
  profile?: EmbeddingProfile
}): Promise<SearchReindexer> {
  const queue = new SqlQueue(input.database, 'knowledge_reindex_queue')
  await queue.initialize()
  return new SearchReindexer({
    profile: input.profile ?? searchEmbeddingProfile,
    repository: new PostgresReindexRepository(input.database),
    queue,
    models: input.models,
  })
}
