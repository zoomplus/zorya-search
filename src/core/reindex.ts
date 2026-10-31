import { createHash } from 'node:crypto'

import type { SearchModels } from './contracts.js'
import type {
  EmbeddingProfile,
  ReindexChunk,
  ReindexQueue,
  ReindexRepository,
} from './embedding-profile.js'

import { embeddingSchema } from './contracts.js'
import { embeddingProfileSchema, reindexPayloadSchema } from './embedding-profile.js'

const kind = 'search-embedding-reindex'
export interface ReindexDependencies {
  profile: EmbeddingProfile
  repository: ReindexRepository
  queue: ReindexQueue
  models: Pick<SearchModels, 'embed'>
}
export async function enqueueReindex(
  deps: ReindexDependencies,
  signal: AbortSignal,
): Promise<number> {
  const profile = embeddingProfileSchema.parse(deps.profile)
  signal.throwIfAborted()
  await deps.repository.registerProfile(profile)
  let after: { versionId: string; ordinal: number } | undefined
  let batches = 0
  for (;;) {
    signal.throwIfAborted()
    const chunks = await deps.repository.missingChunks(profile, after)
    signal.throwIfAborted()
    if (!chunks.length) return batches
    const hash = createHash('sha256').update(JSON.stringify({ profile, chunks })).digest('hex')
    signal.throwIfAborted()
    await deps.queue.enqueue({ key: `search-reindex:${hash}`, kind, payload: { profile, chunks } })
    batches++
    const last = chunks.at(-1)
    if (!last || chunks.length > 32) throw new Error('REINDEX_INVALID_BATCH')
    after = { versionId: last.versionId, ordinal: last.ordinal }
  }
}
function sameProfile(left: EmbeddingProfile, right: EmbeddingProfile): boolean {
  return (
    left.space === right.space &&
    left.model === right.model &&
    left.dimensions === right.dimensions &&
    left.encoding === right.encoding &&
    left.chunker === right.chunker
  )
}
function leaseHeartbeat(
  deps: ReindexDependencies,
  id: string,
  token: string,
  controller: AbortController,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = Promise.resolve()
  const tick = () => {
    if (controller.signal.aborted) return
    pending = deps.queue
      .heartbeat(id, token, 60_000)
      .then((owned) => {
        if (!owned) controller.abort(new Error('REINDEX_LEASE_LOST'))
        else if (!controller.signal.aborted) timer = setTimeout(tick, 10_000)
      })
      .catch(() => controller.abort(new Error('REINDEX_HEARTBEAT_FAILED')))
  }
  timer = setTimeout(tick, 10_000)
  const stop = () => clearTimeout(timer)
  controller.signal.addEventListener('abort', stop, { once: true })
  return async () => {
    clearTimeout(timer)
    controller.signal.removeEventListener('abort', stop)
    await pending
  }
}
export async function executeReindexBatch(
  deps: ReindexDependencies,
  external: AbortSignal,
): Promise<{ worked: boolean; indexed: number }> {
  external.throwIfAborted()
  const job = await deps.queue.lease(60_000, kind)
  if (!job) return { worked: false, indexed: 0 }
  if (job.attempt > 3) {
    await deps.queue.fail(job.id, job.token, 'REINDEX_ATTEMPTS_EXHAUSTED')
    return { worked: true, indexed: 0 }
  }
  const controller = new AbortController()
  const abort = () => controller.abort(external.reason)
  external.addEventListener('abort', abort, { once: true })
  if (external.aborted) abort()
  const stopHeartbeat = leaseHeartbeat(deps, job.id, job.token, controller)
  try {
    const { profile, chunks } = reindexPayloadSchema.parse(job.payload)
    if (!sameProfile(profile, deps.profile)) throw new Error('REINDEX_PROFILE_MISMATCH')
    controller.signal.throwIfAborted()
    const vectors = embeddingSchema.parse(
      await deps.models.embed({
        texts: chunks.map((chunk) => chunk.text),
        signal: controller.signal,
      }),
    )
    controller.signal.throwIfAborted()
    validateBatch(chunks, vectors, profile)
    const indexed = await deps.repository.writeReindexed(
      { id: job.id, token: job.token, profile, chunks, vectors },
      controller.signal,
    )
    controller.signal.throwIfAborted()
    if (!(await deps.queue.finish(job.id, job.token, { indexed })))
      throw new Error('REINDEX_LEASE_LOST')
    return { worked: true, indexed }
  } catch (error) {
    const code = error instanceof Error ? error.message : 'REINDEX_FAILED'
    if (job.attempt >= 3) await deps.queue.fail(job.id, job.token, code)
    else await deps.queue.retry(job.id, job.token, 1000, code)
    throw error
  } finally {
    controller.abort()
    await stopHeartbeat()
    external.removeEventListener('abort', abort)
  }
}
function validateBatch(
  chunks: ReindexChunk[],
  vectors: number[][],
  profile: EmbeddingProfile,
): void {
  if (vectors.length !== chunks.length) throw new Error('EMBEDDING_COUNT_MISMATCH')
  if (vectors.some((vector) => vector.length !== profile.dimensions))
    throw new Error('EMBEDDING_DIMENSION_MISMATCH')
}
