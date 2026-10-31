
import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  KnowledgeRepository,
  Passage,
  SearchDependencies,
  SearchEvent,
  SearchModels,
  SearchProgressEvent,
  SourceDocument,
} from '../../src/index.js'

import {
  SEARCH_EVENT_SUBSCRIBER_LIMIT,
  SEARCH_PROGRESS_ATTEMPTED_MAX,
  SEARCH_PROGRESS_CANDIDATE_COUNT_MAX,
  SEARCH_PROGRESS_CHUNK_COUNT_MAX,
  SEARCH_PROGRESS_COLLECTED_MAX,
  SEARCH_PROGRESS_DISCOVERED_COUNT_MAX,
  SEARCH_PROGRESS_DOCUMENT_COUNT_MAX,
  SEARCH_PROGRESS_QUERY_COUNT_MAX,
  SEARCH_PROGRESS_QUERY_INDEX_MAX,
  createSearchService,
  searchEventSchema,
  searchProgressEventSchema,
  searchProgressFactSchema,
} from '../../src/index.js'

const date = '2026-10-09T00:00:00.000Z'
const passage: Passage = {
  id: 'p1',
  url: 'https://example.com/guide',
  title: 'Boss',
  excerpt: 'Dodge twice',
  score: 0.1,
  addedAt: date,
  fetchedAt: date,
  lastCheckedAt: date,
  publishedAt: null,
  sourceUpdatedAt: null,
}

type SearchProgressFact = SearchProgressEvent['progress']

function isCacheCompletedProgress(event: SearchProgressEvent): event is SearchProgressEvent & {
  progress: Extract<SearchProgressFact, { stage: 'cache'; state: 'completed' }>
} {
  return event.progress.stage === 'cache' && event.progress.state === 'completed'
}

function isIndexingCompletedProgress(event: SearchProgressEvent): event is SearchProgressEvent & {
  progress: Extract<SearchProgressFact, { stage: 'indexing'; state: 'completed' }>
} {
  return event.progress.stage === 'indexing' && event.progress.state === 'completed'
}

function progressEvents(events: SearchEvent[]): SearchProgressEvent[] {
  return events.flatMap((event) => {
    if (event.type !== 'progress') return []
    return [searchProgressEventSchema.parse(event)]
  })
}

function assertSanitizedProgress(events: SearchProgressEvent[]): void {
  const serialized = JSON.stringify(events)
  assert.doesNotMatch(serialized, /https?:\/\//)
  assert.doesNotMatch(serialized, /Margit|boss guide|Dodge twice/i)
  assert.doesNotMatch(serialized, /SOURCE_HTTP|Exception|stack|DISCOVERY_FAILED|DOCUMENT_FAILED/i)
  for (const event of events) {
    searchProgressFactSchema.parse(event.progress)
    assert.equal('code' in event.progress, false)
    assert.equal('message' in event.progress, false)
    if (event.progress.stage === 'cache' && event.progress.state === 'completed') {
      assert.equal('outdated' in event.progress, false)
      assert.equal('fresh' in event.progress, false)
    }
  }
}

function serviceWithWeb(
  web: SearchDependencies['web'],
  cache: Passage[] = [],
  score = 0.2,
): ReturnType<typeof createSearchService> {
  const repository: KnowledgeRepository = {
    retrieve: async () => cache,
    save: async () => {},
    recordQuery: async () => {},
  }
  const models: SearchModels = {
    embed: async ({ texts }) => texts.map(() => [1, 0]),
    rerank: async ({ documents }) =>
      documents.map((_, index) => ({ index, score: 1 - index * 0.01 })),
    judgeCache: async () => score,
  }
  return createSearchService({ repository, models, embeddingSpace: 'fixture-2d', web })
}

function setup(cache: Passage[], score: number, options?: { slowJudgeCache?: boolean }) {
  const saved: SourceDocument[][] = []
  let webCalls = 0
  let lookups = 0
  let releaseJudge: ((value: number) => void) | undefined
  let judgeEntered: (() => void) | undefined
  const judgeEnteredPromise = new Promise<void>((resolve) => {
    judgeEntered = resolve
  })
  const repository: KnowledgeRepository = {
    retrieve: async () => (lookups++ === 0 ? cache : [passage]),
    save: async (documents) => {
      saved.push(documents)
    },
    recordQuery: async () => {},
  }
  const models: SearchModels = {
    embed: async ({ texts }) => texts.map(() => [1, 0]),
    rerank: async ({ documents }) =>
      documents.map((_, index) => ({ index, score: 1 - index * 0.01 })),
    judgeCache: async ({ signal }) => {
      if (options?.slowJudgeCache) {
        judgeEntered?.()
        return new Promise<number>((resolve, reject) => {
          releaseJudge = resolve
          signal.addEventListener(
            'abort',
            () => reject(signal.reason ?? new Error('SEARCH_ABORTED')),
            {
              once: true,
            },
          )
        })
      }
      return score
    },
  }
  const deps: SearchDependencies = {
    repository,
    models,
    embeddingSpace: 'fixture-2d',
    web: {
      discover: async () => {
        webCalls++
        return ['https://example.com/guide', 'https://example.com/second']
      },
      fetchDocument: async (url) => ({
        url,
        title: 'Guide title secret',
        text: 'Secret document body text for tests.',
        fetchedAt: date,
        publishedAt: null,
        sourceUpdatedAt: null,
      }),
    },
  }
  return {
    service: createSearchService(deps),
    saved,
    webCalls: () => webCalls,
    releaseJudge: (value: number) => releaseJudge?.(value),
    awaitJudge: options?.slowJudgeCache ? judgeEnteredPromise : Promise.resolve(),
  }
}

async function collectEvents(jobId: string, service: ReturnType<typeof createSearchService>) {
  const events: SearchEvent[] = []
  for await (const event of service.events(jobId)) {
    events.push(searchEventSchema.parse(event))
  }
  return events
}

await test('progress fact schema rejects incomplete completed facts and code or message fields', () => {
  const discoveryCompleted = {
    stage: 'discovery' as const,
    state: 'completed' as const,
    queryIndex: 0,
    queryCount: 1,
  }
  assert.equal(searchProgressFactSchema.safeParse(discoveryCompleted).success, false)
  assert.equal(
    searchProgressFactSchema.safeParse({ ...discoveryCompleted, discoveredCount: 0, code: 'X' })
      .success,
    false,
  )
  assert.equal(
    searchProgressFactSchema.safeParse({
      ...discoveryCompleted,
      discoveredCount: 0,
      message: 'leak',
    }).success,
    false,
  )
  assert.ok(
    searchProgressFactSchema.safeParse({ ...discoveryCompleted, discoveredCount: 2 }).success,
  )

  const documentCompleted = {
    stage: 'document' as const,
    state: 'completed' as const,
    queryIndex: 0,
    attempted: 1,
  }
  assert.equal(searchProgressFactSchema.safeParse(documentCompleted).success, false)
  assert.equal(
    searchProgressFactSchema.safeParse({ ...documentCompleted, collected: 0, code: 'X' }).success,
    false,
  )
  assert.ok(searchProgressFactSchema.safeParse({ ...documentCompleted, collected: 0 }).success)

  assert.ok(
    searchProgressFactSchema.safeParse({
      stage: 'discovery',
      state: 'failed',
      queryIndex: 0,
      queryCount: 1,
      discoveredCount: 0,
    }).success,
  )
  assert.equal(
    searchProgressFactSchema.safeParse({
      stage: 'cache',
      state: 'started',
      candidateCount: 1,
    }).success,
    false,
  )
})

await test('discovery failure emits failed progress without leaking exception text', async () => {
  const leakQuery = 'secret boss query facet leak'
  const leakUrl = 'https://evil.example/private-doc-id'
  const leakMessage = `discover failed query=${leakQuery} url=${leakUrl}`
  const service = serviceWithWeb({
    discover: async () => {
      throw new Error(leakMessage)
    },
    fetchDocument: async (url) => ({
      url,
      title: 'unused',
      text: 'unused',
      fetchedAt: date,
      publishedAt: null,
      sourceUpdatedAt: null,
    }),
  })
  const { jobId } = service.startSearch({ query: leakQuery, language: 'en', targetSources: 1 })
  const events = await collectEvents(jobId, service)
  const result = await service.result(jobId)
  const progress = progressEvents(events)
  assertSanitizedProgress(progress)
  assert.ok(progress.some((e) => e.progress.stage === 'discovery' && e.progress.state === 'failed'))
  assert.ok(
    !progress.some(
      (e) =>
        e.progress.stage === 'discovery' &&
        e.progress.state === 'completed' &&
        e.progress.discoveredCount === 0 &&
        'code' in e.progress,
    ),
  )
  const serialized = JSON.stringify(progress)
  assert.doesNotMatch(serialized, new RegExp(leakQuery, 'i'))
  assert.doesNotMatch(serialized, /evil\.example|private-doc-id/i)
  assert.equal(result.origin, 'web')
  assert.ok(
    result.errors.some((entry) => entry.stage === 'discovery' && entry.code === 'DISCOVERY_FAILED'),
  )
  assert.deepEqual(
    events.filter((e) => e.type !== 'progress').map((e) => e.type),
    ['started', 'cache', 'finished'],
  )
  await service.close()
})

await test('document failure emits failed progress without leaking exception text', async () => {
  const leakUrl = 'https://evil.example/private-guide-page'
  const leakBody = 'Secret document body text for regression leak test.'
  const service = serviceWithWeb({
    discover: async () => [leakUrl],
    fetchDocument: async () => {
      throw new Error(`fetch failed url=${leakUrl} body=${leakBody}`)
    },
  })
  const { jobId } = service.startSearch({
    query: 'secret boss query',
    language: 'en',
    targetSources: 1,
    maxAttempts: 2,
    concurrency: 1,
  })
  const events = await collectEvents(jobId, service)
  const result = await service.result(jobId)
  const progress = progressEvents(events)
  assertSanitizedProgress(progress)
  assert.ok(progress.some((e) => e.progress.stage === 'document' && e.progress.state === 'failed'))
  const serialized = JSON.stringify(progress)
  assert.doesNotMatch(serialized, /evil\.example|private-guide-page|Secret document body/i)
  assert.equal(result.origin, 'web')
  assert.equal(result.collected, 0)
  assert.deepEqual(result.errors, [{ stage: 'document', url: leakUrl, code: 'DOCUMENT_FAILED' }])
  assert.deepEqual(
    events.filter((e) => e.type !== 'progress').map((e) => e.type),
    ['started', 'cache', 'finished'],
  )
  await service.close()
})

await test('cache-hit emits typed cache progress without web stages', async () => {
  const { service } = setup([passage], 0.95)
  const { jobId } = service.startSearch({ query: 'secret boss query' })
  const events = await collectEvents(jobId, service)
  await service.result(jobId)
  const progress = progressEvents(events)
  assertSanitizedProgress(progress)
  assert.ok(progress.some((e) => e.progress.stage === 'cache' && e.progress.state === 'started'))
  const completed = progress.find(isCacheCompletedProgress)
  assert.ok(completed)
  assert.equal(completed.progress.sufficient, true)
  assert.equal(completed.progress.threshold, 0.9)
  assert.ok(!progress.some((e) => e.progress.stage === 'discovery'))
  assert.ok(!progress.some((e) => e.progress.stage === 'indexing'))
  let lastSequence = 0
  for (const event of events) {
    assert.ok(event.sequence > lastSequence)
    lastSequence = event.sequence
  }
  await service.close()
})

await test('cache-miss emits discovery, document, and indexing progress facts', async () => {
  const { service, saved } = setup([passage], 0.2)
  const { jobId } = service.startSearch({ query: 'secret boss query', targetSources: 2 })
  const events = await collectEvents(jobId, service)
  const result = await service.result(jobId)
  assert.equal(result.origin, 'web')
  assert.equal(saved[0]?.length, 1)
  const progress = progressEvents(events)
  assertSanitizedProgress(progress)
  assert.ok(progress.some((e) => e.progress.stage === 'discovery'))
  assert.ok(progress.some((e) => e.progress.stage === 'document'))
  const indexing = progress.filter((e) => e.progress.stage === 'indexing')
  assert.deepEqual(
    indexing.map((e) => e.progress.state),
    ['started', 'completed'],
  )
  const indexingCompleted = indexing.find(isIndexingCompletedProgress)
  assert.ok(indexingCompleted)
  assert.ok(indexingCompleted.progress.chunkCount >= indexingCompleted.progress.documentCount)
  assert.deepEqual(
    events.filter((e) => e.type !== 'progress').map((e) => e.type),
    ['started', 'cache', 'collected', 'indexed', 'finished'],
  )
  await service.close()
})

await test('cancel suppresses late progress after owner abort', async () => {
  const fixture = setup([passage], 0.2, { slowJudgeCache: true })
  const { jobId } = fixture.service.startSearch({ query: 'secret boss query' })
  const readerSignal = new AbortController()
  await (async () => {
    try {
      for await (const event of fixture.service.events(jobId, readerSignal.signal)) {
        if (event.type === 'progress' && event.progress.stage === 'cache') {
          readerSignal.abort()
          break
        }
      }
    } catch {
      /* subscriber detached */
    }
  })()
  fixture.service.cancel(jobId)
  fixture.releaseJudge(0.2)
  await assert.rejects(fixture.service.result(jobId), /SEARCH_CANCELLED/)
  const events: SearchEvent[] = []
  for await (const event of fixture.service.events(jobId)) events.push(event)
  const progress = progressEvents(events)
  const progressAfterCancel = progress.filter((e) => e.sequence > 2)
  assert.equal(progressAfterCancel.length, 0)
  assert.ok(!progress.some((e) => e.progress.stage === 'indexing'))
  await fixture.service.close()
})

await test('event reader failure does not change search result', async () => {
  const { service } = setup([passage], 0.95)
  const { jobId } = service.startSearch({ query: 'secret boss query' })
  const reader = (async () => {
    let count = 0
    for await (const _ of service.events(jobId)) {
      count++
      if (count === 2) throw new Error('READER_FAILED')
    }
  })()
  await reader.catch(() => undefined)
  const result = await service.result(jobId)
  assert.equal(result.origin, 'database')
  await service.close()
})

function manyPassages(count: number): Passage[] {
  return Array.from({ length: count }, (_, index) => ({
    ...passage,
    id: `p${index}`,
    url: `https://example.com/guide-${index}`,
  }))
}

function blockedSseStream(): {
  stream: PassThrough & ServerResponse
  releaseDrain: () => void
} {
  const stream = new PassThrough() as PassThrough & ServerResponse
  stream.writeHead = () => stream
  let drained = false
  Object.defineProperty(stream, 'writableNeedDrain', {
    configurable: true,
    get: () => !drained,
  })
  stream.write = ((chunk: string | Uint8Array) => {
    if (!drained) return false
    return PassThrough.prototype.write.call(stream, chunk, 'utf8', () => undefined)
  }) as ServerResponse['write']
  return {
    stream,
    releaseDrain: () => {
      drained = true
      stream.emit('drain')
    },
  }
}

await test('progress fact schema enforces count caps aligned with search bounds', () => {
  const validDiscovery = {
    stage: 'discovery' as const,
    state: 'completed' as const,
    queryIndex: SEARCH_PROGRESS_QUERY_INDEX_MAX,
    queryCount: SEARCH_PROGRESS_QUERY_COUNT_MAX,
    discoveredCount: SEARCH_PROGRESS_DISCOVERED_COUNT_MAX,
  }
  assert.ok(searchProgressFactSchema.safeParse(validDiscovery).success)
  assert.equal(
    searchProgressFactSchema.safeParse({
      ...validDiscovery,
      queryIndex: SEARCH_PROGRESS_QUERY_INDEX_MAX + 1,
    }).success,
    false,
  )
  assert.equal(
    searchProgressFactSchema.safeParse({
      stage: 'cache',
      state: 'completed',
      candidateCount: SEARCH_PROGRESS_CANDIDATE_COUNT_MAX + 1,
      score: 0.5,
      threshold: 0.9,
      sufficient: false,
    }).success,
    false,
  )
  assert.ok(
    searchProgressFactSchema.safeParse({
      stage: 'indexing',
      state: 'completed',
      documentCount: SEARCH_PROGRESS_DOCUMENT_COUNT_MAX,
      chunkCount: SEARCH_PROGRESS_CHUNK_COUNT_MAX,
    }).success,
  )
  assert.equal(
    searchProgressFactSchema.safeParse({
      stage: 'document',
      state: 'completed',
      queryIndex: 0,
      attempted: SEARCH_PROGRESS_ATTEMPTED_MAX,
      collected: SEARCH_PROGRESS_COLLECTED_MAX,
    }).success,
    true,
  )
  assert.equal(
    searchProgressFactSchema.safeParse({
      stage: 'document',
      state: 'completed',
      queryIndex: 0,
      attempted: SEARCH_PROGRESS_ATTEMPTED_MAX + 1,
      collected: 0,
    }).success,
    false,
  )
})

await test('events rejects excess subscribers with SEARCH_EVENT_SUBSCRIBER_LIMIT', async () => {
  const fixture = setup([passage], 0.2, { slowJudgeCache: true })
  const { jobId } = fixture.service.startSearch({ query: 'reader limit' })
  await fixture.awaitJudge
  const iterators = Array.from({ length: SEARCH_EVENT_SUBSCRIBER_LIMIT }, () =>
    fixture.service.events(jobId),
  )
  await Promise.all(iterators.map((iterator) => iterator.next()))
  const excess = fixture.service.events(jobId)
  await assert.rejects(excess.next(), /SEARCH_EVENT_SUBSCRIBER_LIMIT/)
  await excess.return(undefined)
  fixture.releaseJudge(0.2)
  await Promise.all(
    iterators.map(async (iterator) => {
      for await (const _ of iterator) {
        /* drain through job completion */
      }
    }),
  )
  await fixture.service.result(jobId)
  await fixture.service.close()
})

await test('events iterator return and reader abort release subscriber capacity', async () => {
  const fixture = setup([passage], 0.2, { slowJudgeCache: true })
  const { jobId } = fixture.service.startSearch({ query: 'release capacity' })
  const first = fixture.service.events(jobId)
  await first.next()
  await first.return(undefined)
  const readerSignal = new AbortController()
  const blockedGen = fixture.service.events(jobId, readerSignal.signal)
  readerSignal.abort()
  await assert.rejects(blockedGen.next())
  await blockedGen.return(undefined)
  assert.doesNotThrow(() => fixture.service.events(jobId))
  const spare = fixture.service.events(jobId)
  await spare.return(undefined)
  await fixture.awaitJudge
  fixture.releaseJudge(0.2)
  await fixture.service.result(jobId)
  await fixture.service.close()
})

await test('events abort rejects before remaining buffered history on completed job', async () => {
  const { service } = setup([passage], 0.95)
  const { jobId } = service.startSearch({ query: 'buffered abort history' })
  await service.result(jobId)
  const readerSignal = new AbortController()
  const iterator = service.events(jobId, readerSignal.signal)
  const first = await iterator.next()
  assert.ok(first.value)
  assert.equal(first.done, false)
  readerSignal.abort(new Error('READER_ABORT_BUFFERED'))
  await assert.rejects(iterator.next(), /READER_ABORT_BUFFERED/)
  await iterator.return(undefined)
  const spare = service.events(jobId)
  await spare.return(undefined)
  await service.close()
})

await test('events close rejects SEARCH_CLOSED before remaining buffered history on completed job', async () => {
  const { service } = setup([passage], 0.95)
  const { jobId } = service.startSearch({ query: 'buffered close history' })
  await service.result(jobId)
  const iterator = service.events(jobId)
  const first = await iterator.next()
  assert.ok(first.value)
  assert.equal(first.done, false)
  await service.close()
  await assert.rejects(iterator.next(), { code: 'SEARCH_CLOSED' })
  await iterator.return(undefined)
})

await test('service close wakes blocked event readers and completes cleanup', async () => {
  const fixture = setup([passage], 0.95, { slowJudgeCache: true })
  const { jobId } = fixture.service.startSearch({ query: 'close wake readers' })
  await fixture.awaitJudge
  const iterator = fixture.service.events(jobId)
  await iterator.next()
  await iterator.next()
  const pending = iterator.next().catch((error: unknown) => error)
  const closing = fixture.service.close()
  fixture.releaseJudge(0.95)
  await closing
  const error = await pending
  assert.ok(
    typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code: string }).code === 'SEARCH_CLOSED',
  )
  await iterator.return(undefined)
})
