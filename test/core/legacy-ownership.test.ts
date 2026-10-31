import assert from 'node:assert/strict'
import test from 'node:test'

import type { SearchDependencies } from '../../src/index.js'

import { createSearchService } from '../../src/index.js'

function deferred() {
  let resolve: (() => void) | undefined
  const wait = new Promise<void>((done) => {
    resolve = done
  })
  return { wait, release: () => resolve?.() }
}
function dependencies(
  overrides: Partial<SearchDependencies['repository']> = {},
): SearchDependencies {
  return {
    embeddingSpace: 'controlled',
    repository: {
      retrieve: async () => [],
      save: async () => {},
      recordQuery: async () => {},
      ...overrides,
    },
    models: { embed: async () => [[1]], rerank: async () => [], judgeCache: async () => 1 },
    web: {
      discover: async () => [],
      fetchDocument: async () => {
        throw new Error('unused')
      },
    },
  }
}
const counts = { sources: 1, versions: 1, chunks: 1, provenance: 1 }
await test('standalone deletion blocks concurrent new jobs, old results and another deletion until storage joins', async () => {
  const entered = deferred()
  const release = deferred()
  const service = createSearchService(
    dependencies({
      async deleteKnowledge() {
        entered.release()
        await release.wait
        return counts
      },
    }),
  )
  try {
    const old = service.startSearch({ query: 'old' })
    await service.result(old.jobId)
    const deleting = service.deleteKnowledge(
      { scope: 'all-user-knowledge' },
      new AbortController().signal,
    )
    await entered.wait
    assert.throws(() => service.startSearch({ query: 'new' }), {
      code: 'KNOWLEDGE_DELETE_IN_PROGRESS',
    })
    assert.throws(() => service.status(old.jobId), { code: 'KNOWLEDGE_DELETE_IN_PROGRESS' })
    await assert.rejects(service.result(old.jobId), { code: 'KNOWLEDGE_DELETE_IN_PROGRESS' })
    await assert.rejects(
      service.deleteKnowledge({ scope: 'all-user-knowledge' }, new AbortController().signal),
      { code: 'KNOWLEDGE_DELETE_IN_PROGRESS' },
    )
    release.release()
    assert.deepEqual(await deleting, counts)
    assert.throws(() => service.status(old.jobId), /SEARCH_JOB_NOT_FOUND/)
    const fresh = service.startSearch({ query: 'fresh' })
    await service.result(fresh.jobId)
  } finally {
    release.release()
    await service.close()
  }
})
await test('close fences new work immediately, cancels deletion and joins one cleanup promise', async () => {
  const entered = deferred()
  const release = deferred()
  let deleteSignal: AbortSignal | undefined
  const service = createSearchService(
    dependencies({
      async deleteKnowledge(_input, signal) {
        deleteSignal = signal
        entered.release()
        await release.wait
        signal.throwIfAborted()
        return counts
      },
    }),
  )
  const deleting = service.deleteKnowledge(
    { scope: 'all-user-knowledge' },
    new AbortController().signal,
  )
  const rejected = assert.rejects(deleting, /SEARCH_CLOSED/)
  await entered.wait
  const closing = service.close()
  assert.equal(service.close(), closing)
  assert.equal(deleteSignal?.aborted, true)
  assert.throws(() => service.startSearch({ query: 'late' }), { code: 'SEARCH_CLOSED' })
  assert.throws(() => service.startMaintenance(), { code: 'SEARCH_CLOSED' })
  release.release()
  await rejected
  await closing
  await assert.rejects(
    service.deleteKnowledge({ scope: 'all-user-knowledge' }, new AbortController().signal),
    { code: 'SEARCH_CLOSED' },
  )
})
await test('a completed old job awaited concurrently with deletion cannot publish its former result', async () => {
  const service = createSearchService(dependencies({ deleteKnowledge: async () => counts }))
  try {
    const old = service.startSearch({ query: 'old' })
    await service.result(old.jobId)
    const reading = service.result(old.jobId)
    const rejected = assert.rejects(reading)
    const deleting = service.deleteKnowledge(
      { scope: 'all-user-knowledge' },
      new AbortController().signal,
    )
    await rejected
    await deleting
  } finally {
    await service.close()
  }
})
