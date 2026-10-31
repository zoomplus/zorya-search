import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

import type { ReindexDependencies, ReindexLease } from '../../src/index.js'

import { SearchReindexer } from '../../src/index.js'
import { enqueueReindex, executeReindexBatch } from '../../src/core/reindex.js'

function fixture() {
  const profile = {
    space: 'fixture:2:chunker1',
    model: 'fixture/embedding',
    dimensions: 2,
    encoding: 'float' as const,
    chunker: 'fixture1',
  }
  const chunks = Array.from({ length: 3 }, (_, ordinal) => ({
    versionId: randomUUID(),
    ordinal,
    text: `old excerpt${ordinal}`,
  }))
  const jobs = new Map<string, ReindexLease>()
  const state = {
    embedded: [] as string[],
    written: 0,
    finished: 0,
    retried: 0,
    failed: 0,
    calls: 0,
  }
  const deps: ReindexDependencies = {
    profile,
    repository: {
      async registerProfile() {},
      async missingChunks(_profile, after) {
        return after ? [] : chunks
      },
      async writeReindexed(input, signal) {
        signal.throwIfAborted()
        state.written += input.chunks.length
        return input.chunks.length
      },
    },
    queue: {
      async enqueue({ key, payload }) {
        const existing = jobs.get(key)
        if (existing) return { id: existing.id }
        const job = { id: randomUUID(), token: randomUUID(), attempt: 1, payload }
        jobs.set(key, job)
        return { id: job.id }
      },
      async lease() {
        return [...jobs.values()][0]
      },
      async heartbeat() {
        return true
      },
      async finish() {
        state.finished++
        jobs.clear()
        return true
      },
      async retry() {
        state.retried++
        return true
      },
      async fail() {
        state.failed++
        jobs.clear()
        return true
      },
    },
    models: {
      async embed({ texts, signal }) {
        signal.throwIfAborted()
        state.calls++
        state.embedded.push(...texts)
        return texts.map(() => [1, 0])
      },
    },
  }
  return { deps, state, chunks, jobs }
}
await test('reindexenqueue idempotence survivesrestart and embeds storedexcerpts only', async () => {
  const { deps, state, chunks, jobs } = fixture()
  const signal = new AbortController().signal
  assert.equal(await enqueueReindex(deps, signal), 1)
  assert.equal(await enqueueReindex(deps, signal), 1)
  assert.equal(jobs.size, 1)
  const restarted = new SearchReindexer(deps)
  assert.deepEqual(await restarted.runOnce(signal), { worked: true, indexed: 3 })
  assert.deepEqual(
    state.embedded,
    chunks.map((chunk) => chunk.text),
  )
  assert.equal(state.finished, 1)
  await restarted.close()
})
await test('bad vector dimensions nevercommit and attempts arebounded', async () => {
  const { deps, state, jobs } = fixture()
  deps.models = {
    async embed() {
      return [[1], [1], [1]]
    },
  }
  const signal = new AbortController().signal
  await enqueueReindex(deps, signal)
  await assert.rejects(executeReindexBatch(deps, signal), /EMBEDDING_DIMENSION_MISMATCH/)
  assert.equal(state.written, 0)
  assert.equal(state.retried, 1)
  const job = [...jobs.values()][0]
  assert.ok(job)
  job.attempt = 3
  await assert.rejects(executeReindexBatch(deps, signal), /EMBEDDING_DIMENSION_MISMATCH/)
  assert.equal(state.failed, 1)
  job.attempt = 4
  jobs.set('fixture', job)
  await executeReindexBatch(deps, signal)
  assert.equal(state.failed, 2)
})
await test('closing cancels modelcall and latevectors neverwrite', async () => {
  const { deps, state } = fixture()
  let release: (vectors: number[][]) => void = () => undefined
  let began: () => void = () => undefined
  const entered = new Promise<void>((resolve) => {
    began = resolve
  })
  deps.models = {
    embed: () =>
      new Promise((resolve) => {
        release = resolve
        began()
      }),
  }
  const signal = new AbortController().signal
  const owner = new SearchReindexer(deps)
  await owner.enqueue(signal)
  const pending = owner.runOnce(signal)
  await entered
  const closed = owner.close()
  release([
    [1, 0],
    [1, 0],
    [1, 0],
  ])
  await assert.rejects(pending)
  await closed
  assert.equal(state.written, 0)
  assert.equal(state.finished, 0)
  assert.throws(() => owner.runOnce(signal), /REINDEX_CLOSED/)
})
await test('mismatched queuedprofile and exhaustedlease neverreachmodels', async () => {
  const { deps, state, jobs } = fixture()
  const signal = new AbortController().signal
  await enqueueReindex(deps, signal)
  deps.profile = { ...deps.profile, space: 'different' }
  await assert.rejects(executeReindexBatch(deps, signal), /REINDEX_PROFILE_MISMATCH/)
  assert.equal(state.calls, 0)
  const job = [...jobs.values()][0]
  assert.ok(job)
  job.attempt = 4
  assert.deepEqual(await executeReindexBatch(deps, signal), { worked: true, indexed: 0 })
  assert.equal(state.calls, 0)
})

await test('close joinscanceled enumeration and refuseslate durableenqueue', async () => {
  const { deps, jobs, chunks } = fixture()
  let release: (value: typeof chunks) => void = () => undefined
  let entered: () => void = () => undefined
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  deps.repository.missingChunks = () =>
    new Promise((resolve) => {
      release = resolve
      entered()
    })
  const owner = new SearchReindexer(deps)
  const pending = owner.enqueue(new AbortController().signal)
  await started
  const closed = owner.close()
  assert.equal(owner.close(), closed)
  release(chunks)
  await assert.rejects(pending)
  await closed
  assert.equal(jobs.size, 0)
})
