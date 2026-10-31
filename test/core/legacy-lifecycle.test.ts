import assert from 'node:assert/strict'
import test from 'node:test'

import { createSearchService, knowledgeDeleteSchema } from '../../src/index.js'

await test('delete validates strict scope before invoking an owned repository', async () => {
  let calls = 0
  const service = createSearchService({
    embeddingSpace: 'test',
    repository: {
      retrieve: async () => [],
      save: async () => {},
      recordQuery: async () => {},
      deleteKnowledge: async () => {
        calls++
        return { sources: 1, versions: 2, chunks: 3, provenance: 4 }
      },
    },
    models: { embed: async () => [[1]], rerank: async () => [], judgeCache: async () => 1 },
    web: {
      discover: async () => [],
      fetchDocument: async () => {
        throw new Error('unused')
      },
    },
  })
  assert.equal(
    knowledgeDeleteSchema.safeParse({ scope: 'sources', sourceIds: ['invalid'] }).success,
    false,
  )
  assert.equal(
    knowledgeDeleteSchema.safeParse({ scope: 'all-user-knowledge', userId: 'another' }).success,
    false,
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(service.deleteKnowledge({ scope: 'all-user-knowledge' }, controller.signal))
  assert.equal(calls, 0)
  assert.equal(
    (await service.deleteKnowledge({ scope: 'all-user-knowledge' }, new AbortController().signal))
      .provenance,
    4,
  )
  await service.close()
})
await test('24h terminal search cleanup retains younger jobs and active work', async () => {
  let release: (value: number[][]) => void = () => {}
  let active = false
  const service = createSearchService({
    embeddingSpace: 'test',
    repository: { retrieve: async () => [], save: async () => {}, recordQuery: async () => {} },
    models: {
      embed: async () =>
        active
          ? new Promise((resolve) => {
              release = resolve
            })
          : [[1]],
      rerank: async () => [],
      judgeCache: async () => 1,
    },
    web: {
      discover: async () => [],
      fetchDocument: async () => {
        throw new Error('unused')
      },
    },
  })
  const done = service.startSearch({ query: 'finished' })
  await service.result(done.jobId)
  active = true
  const pending = service.startSearch({ query: 'active' })
  const now = Date.now()
  assert.equal(
    (await service.collectTemporary(new AbortController().signal, now + 23 * 3600000)).jobs,
    0,
  )
  assert.equal(
    (await service.collectTemporary(new AbortController().signal, now + 25 * 3600000)).jobs,
    1,
  )
  assert.throws(() => service.status(done.jobId), /SEARCH_JOB_NOT_FOUND/)
  assert.equal(service.status(pending.jobId).status, 'running')
  service.cancel(pending.jobId)
  release([[1]])
  await service.close()
})
