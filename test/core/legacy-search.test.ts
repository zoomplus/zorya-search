import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  KnowledgeRepository,
  Passage,
  SearchDependencies,
  SearchModels,
  SearchStageEmitter,
  SourceDocument,
  WebSource,
} from '../../src/index.js'

import { collectSources } from '../../src/core/collection.js'
import {
  buildSearchQueries,
  canonicalUrl,
  chunkDocuments,
  createSearchService,
  ProviderError,
  reciprocalRankFusion,
  searchRequestSchema,
} from '../../src/index.js'
import { createBraveWebSource } from '../../src/providers/brave.js'

const date = '2026-10-09T00:00:00.000Z'
function sourceDocument(url: string, text = `Guide for ${url}`): SourceDocument {
  return {
    url,
    title: 'Guide',
    text,
    fetchedAt: date,
    publishedAt: null,
    sourceUpdatedAt: null,
  }
}
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
function setup(cache: Passage[], score: number) {
  const saved: SourceDocument[][] = []
  let webCalls = 0
  const repository: KnowledgeRepository = {
    retrieve: async () => (cache.length ? cache : [passage]),
    save: async (documents) => {
      saved.push(documents)
    },
    recordQuery: async () => {},
  }
  let lookups = 0
  repository.retrieve = async () => (lookups++ === 0 ? cache : [passage])
  const models: SearchModels = {
    embed: async ({ texts }) => texts.map(() => [1, 0]),
    rerank: async ({ documents }) =>
      documents.map((_, index) => ({ index, score: 1 - index * 0.01 })),
    judgeCache: async () => score,
  }
  const deps: SearchDependencies = {
    repository,
    models,
    embeddingSpace: 'fixture-2d',
    web: {
      discover: async () => {
        webCalls++
        return ['https://example.com/guide']
      },
      fetchDocument: async (url) => ({
        url,
        title: 'Guide',
        text: 'Dodge twice to avoid the boss attack.',
        fetchedAt: date,
        publishedAt: null,
        sourceUpdatedAt: null,
      }),
    },
  }
  return { service: createSearchService(deps), deps, saved, webCalls: () => webCalls }
}
await test('cache sufficiency uses Jev score and preserves source dates', async () => {
  const { service, webCalls } = setup([passage], 0.95)
  const { jobId } = service.startSearch({ query: 'boss', freshness: { latest: true } })
  const result = await service.result(jobId)
  assert.equal(result.origin, 'database')
  assert.equal(webCalls(), 0)
  assert.equal(result.passages[0]?.fetchedAt, date)
  await service.close()
})
await test('insufficient cache collects, embeds, persists and labels partial result', async () => {
  const { service, saved } = setup([passage], 0.2)
  const { jobId } = service.startSearch({ query: 'boss', targetSources: 2 })
  const result = await service.result(jobId)
  assert.equal(result.origin, 'web')
  assert.equal(result.partial, true)
  assert.equal(saved[0]?.length, 1)
  const events = []
  for await (const event of service.events(jobId)) events.push(event.type)
  assert.deepEqual(
    events.filter((type) => type !== 'progress'),
    ['started', 'cache', 'collected', 'indexed', 'finished'],
  )
  await service.close()
})
await test('cancel rejects late provider response without persisting or publication', async () => {
  const fixture = setup([], 0)
  let release: (value: number[][]) => void = () => {}
  fixture.deps.models.embed = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const { jobId } = fixture.service.startSearch({ query: 'boss' })
  fixture.service.cancel(jobId)
  release([[1, 0]])
  await assert.rejects(fixture.service.result(jobId), /SEARCH_CANCELLED/)
  assert.equal(fixture.saved.length, 0)
  assert.equal(fixture.webCalls(), 0)
})
await test('bad Jev score fails instead of silently using stale knowledge', async () => {
  const { service, webCalls } = setup([passage], NaN)
  const { jobId } = service.startSearch({ query: 'boss' })
  await assert.rejects(service.result(jobId))
  assert.equal(webCalls(), 0)
})
await test('deduplicates tracking URLs and fuses independent rankings', () => {
  assert.equal(
    canonicalUrl('https://example.com/a?utm_source=x&b=2#toc'),
    'https://example.com/a?b=2',
  )
  const rows = reciprocalRankFusion([[passage], [{ ...passage, id: 'p2' }, passage]], 2)
  assert.equal(rows[0]?.id, 'p1')
  assert.equal(
    chunkDocuments(
      [
        {
          url: passage.url,
          title: 'x',
          text: 'a'.repeat(250),
          fetchedAt: date,
          publishedAt: null,
          sourceUpdatedAt: null,
        },
      ],
      100,
      20,
    ).length,
    3,
  )
})

await test('builds bounded localized search facets without adding private context', () => {
  const request = searchRequestSchema.parse({
    game: 'Elden Ring',
    query: 'Margit guide',
    context: 'secret inventory details',
    language: 'en-US',
  })
  assert.deepEqual(buildSearchQueries(request), [
    'Elden Ring Margit guide',
    'Elden Ring Margit guide walkthrough',
    'Elden Ring Margit guide wiki',
    'Elden Ring Margit guide tips',
    'Elden Ring Margit guide location',
    'Elden Ring Margit guide map',
    'Elden Ring Margit guide strategy',
    'Elden Ring Margit guide reddit',
    'Elden Ring Margit guide forum',
    'Elden Ring guide',
    'Elden Ring wiki',
    'Elden Ring map',
    'Elden Ring items',
    'Elden Ring quests',
    'Elden Ring bosses',
  ])
  const russian = buildSearchQueries(
    searchRequestSchema.parse({ game: 'Elden Ring', query: 'Маления гайд', language: 'ru' }),
  )
  assert.deepEqual(russian, [
    'Elden Ring Маления гайд',
    'Elden Ring Маления гайд прохождение',
    'Elden Ring Маления гайд вики',
    'Elden Ring Маления гайд советы',
    'Elden Ring Маления гайд карта',
    'Elden Ring Маления гайд стратегия',
    'Elden Ring Маления гайд форум',
    'Elden Ring Маления гайд reddit',
    'Elden Ring прохождение',
    'Elden Ring вики',
    'Elden Ring карта',
    'Elden Ring предметы',
    'Elden Ring квесты',
    'Elden Ring боссы',
  ])
})

await test('refills failed and duplicate sources with bounded localized discovery', async () => {
  const request = searchRequestSchema.parse({
    query: 'Маления',
    game: 'Elden Ring',
    language: 'ru',
    targetSources: 2,
    maxAttempts: 5,
    concurrency: 1,
  })
  const trackingUrl = 'https://example.com/a?utm_source=search#guide'
  const firstUrl = 'https://example.com/a'
  const failedUrl = 'https://example.com/broken'
  const secondUrl = 'https://example.com/second'
  const thirdUrl = 'https://example.com/third'
  const queries: string[] = []
  const fetched: string[] = []
  const web: WebSource = {
    discover: async (query) => {
      queries.push(query)
      return queries.length === 1 ? [trackingUrl, failedUrl] : [failedUrl, secondUrl, thirdUrl]
    },
    fetchDocument: async (url) => {
      fetched.push(url)
      if (url === failedUrl) throw new Error('SOURCE_HTTP_404')
      return sourceDocument(url)
    },
  }

  const noop: SearchStageEmitter = { legacy: () => {}, progress: () => {} }
  const result = await collectSources(request, web, new AbortController().signal, noop)

  assert.deepEqual(queries, ['Elden Ring Маления', 'Elden Ring Маления гайд'])
  assert.deepEqual(fetched, [firstUrl, failedUrl, secondUrl])
  assert.equal(result.documents.length, 2)
  assert.equal(result.attempted, 3)
  assert.deepEqual(result.errors, [{ stage: 'document', url: failedUrl, code: 'SOURCE_HTTP_404' }])
})

await test('searchRequestSchema keeps generic debug/indexing defaults', () => {
  const parsed = searchRequestSchema.parse({ query: 'boss' })
  assert.equal(parsed.targetSources, 100)
  assert.equal(parsed.maxAttempts, 300)
  assert.equal(parsed.collectionTimeoutMs, 120000)
  assert.equal(parsed.concurrency, 6)
})

await test('insufficient cache with empty web collection keeps ranked cache as partial database fallback', async () => {
  const fixture = setup([passage], 0.55)
  fixture.deps.web.discover = async () => {
    return []
  }
  const { service } = fixture
  const { jobId } = service.startSearch({ query: 'boss', targetSources: 5 })
  const result = await service.result(jobId)
  assert.equal(result.origin, 'database')
  assert.equal(result.partial, true)
  assert.equal(result.passages.length, 1)
  assert.equal(result.cacheScore, 0.55)
  assert.equal(result.collected, 0)
  assert.ok(result.attempted >= 0)
  await service.close()
})

await test('insufficient cache with timed-out collection keeps partial cache fallback', async () => {
  const fixture = setup([passage], 0.4)
  fixture.deps.web.discover = async (_query, _limit, signal) => {
    while (!signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return []
  }
  const { jobId } = fixture.service.startSearch({
    query: 'boss',
    targetSources: 2,
    collectionTimeoutMs: 20,
  })
  const result = await fixture.service.result(jobId)
  assert.equal(result.origin, 'database')
  assert.equal(result.partial, true)
  assert.equal(result.passages[0]?.id, passage.id)
  assert.equal(result.cacheScore, 0.4)
  await fixture.service.close()
})

await test('fresh partial web collection persists without discarding collected documents', async () => {
  const { service, saved } = setup([], 0.1)
  const { jobId } = service.startSearch({ query: 'boss', targetSources: 5, concurrency: 1 })
  const result = await service.result(jobId)
  assert.equal(result.origin, 'web')
  assert.equal(result.partial, true)
  assert.equal(result.collected, 1)
  assert.ok(result.passages.length >= 1)
  assert.equal(saved.length, 1)
  await service.close()
})

await test('repository retrieve errors stay visible instead of empty fallback', async () => {
  const fixture = setup([], 0)
  let calls = 0
  fixture.deps.repository.retrieve = async () => {
    calls += 1
    if (calls === 1) throw new Error('REPOSITORY_UNAVAILABLE')
    return []
  }
  const { jobId } = fixture.service.startSearch({ query: 'boss' })
  await assert.rejects(fixture.service.result(jobId), /REPOSITORY_UNAVAILABLE/)
  await fixture.service.close()
})

await test('partial collection with empty fresh rank keeps cached passages as database fallback', async () => {
  const fixture = setup([passage], 0.45)
  let retrieveCalls = 0
  fixture.deps.repository.retrieve = async () => {
    retrieveCalls += 1
    return retrieveCalls === 1 ? [passage] : [passage]
  }
  let rerankCalls = 0
  fixture.deps.models.rerank = async () => {
    rerankCalls += 1
    return rerankCalls === 1 ? [{ index: 0, score: 0.9 }] : []
  }
  const { jobId } = fixture.service.startSearch({ query: 'boss', targetSources: 5 })
  const result = await fixture.service.result(jobId)
  assert.equal(result.origin, 'database')
  assert.equal(result.partial, true)
  assert.equal(result.passages.length, 1)
  assert.equal(result.collected, 1)
  assert.ok(result.attempted >= 1)
  assert.equal(result.cacheScore, 0.45)
  await fixture.service.close()
})

await test('empty fresh rank fallback still propagates repository save abort', async () => {
  const fixture = setup([passage], 0.35)
  fixture.deps.repository.retrieve = async () => [passage]
  let rerankCalls = 0
  fixture.deps.models.rerank = async () => {
    rerankCalls += 1
    return rerankCalls === 1 ? [{ index: 0, score: 0.8 }] : []
  }
  fixture.deps.repository.save = async () => {
    throw new Error('SAVE_ABORTED')
  }
  const { jobId } = fixture.service.startSearch({ query: 'boss', targetSources: 2 })
  await assert.rejects(fixture.service.result(jobId), /SAVE_ABORTED/)
  await fixture.service.close()
})

await test('continues with another query facet after discovery rate limiting', async () => {
  const request = searchRequestSchema.parse({
    query: 'boss',
    language: 'en',
    targetSources: 1,
    maxAttempts: 3,
    concurrency: 1,
  })
  let discoveries = 0
  const web: WebSource = {
    discover: async () => {
      discoveries++
      if (discoveries === 1) throw new Error('BRAVE_HTTP_429')
      return ['https://example.com/guide']
    },
    fetchDocument: async (url) => sourceDocument(url),
  }

  const noop: SearchStageEmitter = { legacy: () => {}, progress: () => {} }
  const result = await collectSources(request, web, new AbortController().signal, noop)

  assert.equal(discoveries, 2)
  assert.equal(result.documents.length, 1)
  assert.equal(result.attempted, 1)
  assert.deepEqual(result.errors, [{ stage: 'discovery', queryIndex: 0, code: 'BRAVE_HTTP_429' }])
})

await test('typed Brave discovery refusals stop only this operation and keep cache fallback', async () => {
  for (const [status, code] of [
    [401, 'DISCOVERY_AUTH'],
    [402, 'DISCOVERY_QUOTA'],
    [429, 'DISCOVERY_RATE_LIMIT'],
  ] as const) {
    let calls = 0
    const fixture = setup([passage], 0.4)
    fixture.deps.web = createBraveWebSource({
      apiKey: 'fixture',
      limits: { attempts: 1 },
      fetch: async () => {
        calls++
        return new Response('', { status })
      },
    })
    const first = fixture.service.startSearch({ query: 'boss', language: 'en', targetSources: 3 })
    const result = await fixture.service.result(first.jobId)
    assert.equal(result.origin, 'database')
    assert.equal(result.partial, true)
    assert.equal(result.passages[0]?.id, passage.id)
    assert.deepEqual(result.errors, [{ stage: 'discovery', queryIndex: 0, code }])
    assert.equal(calls, 1)

    const second = fixture.service.startSearch({ query: 'another request', language: 'en', targetSources: 3 })
    await fixture.service.result(second.jobId)
    assert.equal(calls, 2, 'a terminal response is scoped to one search operation')
    await fixture.service.close()
  }
})

await test('forged terminal errors do not stop discovery variants', async () => {
  const request = searchRequestSchema.parse({ query: 'boss', language: 'en', targetSources: 1 })
  let discoveries = 0
  const web: WebSource = {
    discover: async () => {
      discoveries++
      if (discoveries === 1) throw Object.assign(new Error('quota'), { code: 'quota', name: 'ProviderError' })
      return ['https://example.com/guide']
    },
    fetchDocument: async (url) => sourceDocument(url),
  }
  const result = await collectSources(request, web, new AbortController().signal, {
    legacy: () => {},
    progress: () => {},
  })
  assert.ok(discoveries > 1)
  assert.equal(result.documents.length, 1)
  assert.ok(result.errors.some((error) => error.code === 'DISCOVERY_FAILED'))
})

await test('typed terminal document errors do not stop later discovery variants', async () => {
  const request = searchRequestSchema.parse({ query: 'boss', language: 'en', targetSources: 1 })
  let discoveries = 0
  const web: WebSource = {
    discover: async () => {
      discoveries++
      return [`https://example.com/${discoveries}`]
    },
    fetchDocument: async (url) => {
      if (url.endsWith('/1')) throw new ProviderError('auth')
      return sourceDocument(url)
    },
  }
  const result = await collectSources(request, web, new AbortController().signal, {
    legacy: () => {},
    progress: () => {},
  })
  assert.equal(discoveries, 2)
  assert.equal(result.documents.length, 1)
  assert.deepEqual(result.errors, [{ stage: 'document', url: 'https://example.com/1', code: 'DOCUMENT_FAILED' }])
})

await test('caller cancellation wins over a simultaneous typed terminal discovery refusal', async () => {
  const request = searchRequestSchema.parse({ query: 'boss', language: 'en' })
  const controller = new AbortController()
  const web: WebSource = {
    discover: async () => {
      controller.abort(new Error('caller cancelled'))
      throw new ProviderError('auth')
    },
    fetchDocument: async (url) => sourceDocument(url),
  }
  await assert.rejects(
    collectSources(request, web, controller.signal, { legacy: () => {}, progress: () => {} }),
    /caller cancelled/,
  )
})
