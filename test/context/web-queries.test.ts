import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebSearch } from '../../src/context/web.js'
import { ProviderError } from '../../src/providers/contracts.js'

const fixedFetchedAt = '2026-11-01T00:00:00.000Z'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function document(url: string, text = `needle ${new URL(url).pathname}`) {
  return {
    url,
    title: 'needle source',
    text,
    fetchedAt: fixedFetchedAt,
    publishedAt: null,
    sourceUpdatedAt: null,
  }
}

function createContext(
  discover: (query: string, target: number, signal: AbortSignal) => Promise<string[]>,
  options: {
    fetchDocument?: (url: string, signal: AbortSignal) => Promise<ReturnType<typeof document>>
    limits?: Parameters<typeof createWebSearch>[0]['limits']
    models?: Parameters<typeof createWebSearch>[0]['models']
  } = {},
) {
  return createWebSearch({
    web: {
      discover,
      fetchDocument: options.fetchDocument ?? (async (url) => document(url)),
    },
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.models ? { models: options.models } : {}),
  })
}

test('absent and empty additionalQueries keep the legacy result and discovery calls identical', async () => {
  const calls: string[] = []
  const source = async (query: string) => {
    calls.push(query)
    return ['https://example.test/primary']
  }
  const first = createContext(source)
  const second = createContext(source)

  try {
    const legacy = await first.searchWeb({ query: 'primary query', limit: 1 })
    const empty = await second.searchWeb({ query: 'primary query', limit: 1, additionalQueries: [] })
    assert.deepEqual(empty, legacy)
    assert.equal('discovery' in legacy, false)
    assert.equal('queryIndexes' in (legacy.passages[0] ?? {}), false)
    assert.deepEqual(calls, ['primary query', 'primary query'])
  } finally {
    await Promise.all([first.close(), second.close()])
  }
})

test('bounded discovery overlaps queries and preserves source order when completion timing reverses', async () => {
  const primary = 'needle primary'
  const secondary = 'needle secondary'
  const queryUrls: Record<string, string[]> = {
    [primary]: ['https://example.test/a', 'https://example.test/shared'],
    [secondary]: ['https://example.test/b', 'https://example.test/shared'],
  }
  const snapshots: Array<{ urls: string[]; discovery: unknown; errors: unknown[] }> = []

  for (const delays of [[25, 1], [1, 25]]) {
    let active = 0
    let peak = 0
    const targets: number[] = []
    const context = createContext(async (query, target) => {
      targets.push(target)
      const queryIndex = query === primary ? 0 : 1
      active++
      peak = Math.max(peak, active)
      try {
        await new Promise((resolve) => setTimeout(resolve, delays[queryIndex]))
        return queryUrls[query]!
      } finally {
        active--
      }
    }, { limits: { maxConcurrency: 2 } })

    try {
      const result = await context.searchWeb({
        query: primary,
        additionalQueries: [secondary],
        limit: 3,
      })
      snapshots.push({
        urls: result.passages.map((passage) => passage.canonicalURL),
        discovery: result.discovery,
        errors: result.errors,
      })
      assert.equal(peak, 2)
      assert.deepEqual(targets, [6, 6])
    } finally {
      await context.close()
    }
  }

  assert.deepEqual(snapshots[0], snapshots[1])
  assert.deepEqual(snapshots[0]?.urls, [
    'https://example.test/a',
    'https://example.test/b',
    'https://example.test/shared',
  ])
})

test('discovery deduplicates trimmed exact matches but preserves original query text and case', async () => {
  const calls: string[] = []
  const context = createContext(async (query) => {
    calls.push(query)
    return []
  })

  try {
    const result = await context.searchWeb({
      query: 'needle',
      additionalQueries: [' needle ', 'Needle', 'needle'],
      limit: 1,
    })
    assert.deepEqual(calls, ['needle', 'Needle'])
    assert.deepEqual(result.discovery?.queries.map(({ query }) => query), ['needle', 'Needle'])
  } finally {
    await context.close()
  }
})

test('round-robin admission gives a later query a source under the shared document cap', async () => {
  const context = createContext(async (query) => query === 'needle'
    ? ['https://example.test/shared', 'https://example.test/primary']
    : ['https://example.test/shared', 'https://example.test/needed'], {
    limits: { maxDocuments: 2, maxConcurrency: 2 },
  })

  try {
    const result = await context.searchWeb({ query: 'needle', additionalQueries: ['secondary'], limit: 2 })
    assert.deepEqual(result.passages.map((passage) => passage.canonicalURL), [
      'https://example.test/shared',
      'https://example.test/needed',
    ])
    assert.deepEqual(result.passages[0]?.queryIndexes, [0, 1])
    assert.deepEqual(result.discovery, {
      queries: [
        { query: 'needle', status: 'complete', discoveredUrls: 2, retainedUrls: 1 },
        { query: 'secondary', status: 'complete', discoveredUrls: 2, retainedUrls: 2 },
      ],
      uniqueUrls: 3,
      truncated: true,
    })
    assert.deepEqual(result.errors, [])
    assert.equal(result.partial, false)
  } finally {
    await context.close()
  }
})

test('canonical duplicates fetch once and passages list every query containing the requested URL', async () => {
  const tracked = 'https://example.test/page?utm_source=fixture#section'
  const canonical = 'https://example.test/page'
  const fetched: string[] = []
  const context = createContext(async (query) => query === 'needle'
    ? [tracked]
    : [canonical, 'https://example.test/other'], {
    fetchDocument: async (url) => {
      fetched.push(url)
      return document(url)
    },
  })

  try {
    const result = await context.searchWeb({ query: 'needle', additionalQueries: ['secondary'], limit: 3 })
    const shared = result.passages.find((passage) => passage.canonicalURL === canonical)
    assert.deepEqual(fetched, [canonical, 'https://example.test/other'])
    assert.deepEqual(shared?.queryIndexes, [0, 1])
    assert.deepEqual(result.discovery?.queries.map((query) => query.discoveredUrls), [1, 2])
    assert.deepEqual(result.discovery?.queries.map((query) => query.retainedUrls), [1, 2])
    assert.equal(result.discovery?.uniqueUrls, 2)
  } finally {
    await context.close()
  }
})

test('query failures retain safe provider context while other queries continue; all-failure stays partial and empty', async () => {
  const partialContext = createContext(async (query) => {
    if (query === 'needle') throw new ProviderError('rate_limit', 429, 900)
    return ['https://example.test/valid']
  })
  const allFailedContext = createContext(async (query) => {
    throw query === 'primary'
      ? new ProviderError('auth', 401)
      : new ProviderError('unavailable', 503)
  })

  try {
    const partial = await partialContext.searchWeb({
      query: 'needle',
      additionalQueries: ['secondary'],
      limit: 1,
    })
    assert.deepEqual(partial.errors, [
      {
        stage: 'discovery',
        code: 'DISCOVERY_FAILED',
        queryIndex: 0,
        provider: { code: 'rate_limit', httpStatus: 429, retryAfterMs: 900 },
      },
    ])
    assert.equal(partial.passages.length, 1)
    assert.equal(partial.partial, true)
    assert.deepEqual(partial.discovery?.queries.map(({ status }) => status), ['failed', 'complete'])

    const allFailed = await allFailedContext.searchWeb({
      query: 'needle',
      additionalQueries: ['secondary'],
      limit: 1,
    })
    assert.deepEqual(allFailed.passages, [])
    assert.equal(allFailed.rankingMode, 'lexical')
    assert.equal(allFailed.partial, true)
    assert.deepEqual(allFailed.errors.map(({ queryIndex }) => queryIndex), [0, 1])
    assert.deepEqual(allFailed.discovery?.queries.map(({ status }) => status), ['failed', 'failed'])
  } finally {
    await Promise.all([partialContext.close(), allFailedContext.close()])
  }
})

test('additional discovery never replaces the primary model query', async () => {
  let embeddingQuery = ''
  let rerankQuery = ''
  const modelProfile = { provider: 'fixture', model: 'fixture-model', space: 'web', dimensions: 2 }
  const context = createContext(async (query) => [
    `https://example.test/${query === 'primary question' ? 'primary' : 'secondary'}`,
  ], {
    models: {
      embed: {
        profile: modelProfile,
        embed: async ({ texts }) => {
          embeddingQuery = texts[0]!
          return texts.map(() => [1, 0])
        },
      },
      rerank: {
        profile: { provider: 'fixture', model: 'ranker', space: 'web-rank' },
        rerank: async ({ query, documents }) => {
          rerankQuery = query
          return documents.map((_document, index) => ({ index, score: documents.length - index }))
        },
      },
    },
  })

  try {
    await context.searchWeb({
      query: 'primary question',
      additionalQueries: ['secondary discovery'],
      limit: 2,
    })
    assert.equal(embeddingQuery, 'primary question')
    assert.equal(rerankQuery, 'primary question')
  } finally {
    await context.close()
  }
})

test('additionalQueries are validated synchronously and snapshotted before deferred work', async () => {
  const calls: string[] = []
  const context = createContext(async (query) => {
    calls.push(query)
    return [`https://example.test/${calls.length}`]
  }, { limits: { maxQueryChars: 12 } })

  try {
    assert.throws(
      () => context.searchWeb({ query: 'primary', additionalQueries: Array(8).fill('query') }),
      TypeError,
    )
    assert.throws(
      () => context.searchWeb({ query: 'primary', additionalQueries: ['  '] }),
      TypeError,
    )
    assert.throws(
      () => context.searchWeb({ query: 'primary', additionalQueries: ['query-that-is-too-long'] }),
      TypeError,
    )
    assert.throws(
      () => context.searchWeb({ query: 'primary', additionalQueries: ['valid', 2] as unknown as string[] }),
      TypeError,
    )
    assert.throws(
      () => context.searchWeb({ query: 'primary', additionalQueries: 'bad' as unknown as string[] }),
      TypeError,
    )

    const additionalQueries = ['second query']
    const pending = context.searchWeb({ query: 'primary', additionalQueries, limit: 2 })
    additionalQueries[0] = 'mutated query'
    additionalQueries.push('third query')
    await pending
    assert.deepEqual(calls, ['primary', 'second query'])
  } finally {
    await context.close()
  }
})

test('shared document and result character budgets apply across discovery queries', async () => {
  const fetched: string[] = []
  const context = createContext(async (query) => [
    `https://example.test/${query === 'needle' ? 'first' : 'second'}`,
  ], {
    fetchDocument: async (url) => {
      fetched.push(url)
      return document(url, 'needle ' + 'x'.repeat(13))
    },
    limits: { maxTotalDocumentChars: 25, maxConcurrency: 2 },
  })

  try {
    const result = await context.searchWeb({
      query: 'needle',
      additionalQueries: ['secondary'],
      limit: 2,
      maxChars: 8,
    })
    assert.deepEqual(fetched, [
      'https://example.test/first',
      'https://example.test/second',
    ])
    assert.deepEqual(result.errors, [
      { stage: 'document', url: 'https://example.test/second', code: 'DOCUMENT_TOO_LARGE' },
    ])
    assert.equal(result.passages.reduce((sum, passage) => sum + passage.excerpt.length, 0), 8)
    assert.equal(result.budget.usedChars, 8)
    assert.equal(result.partial, true)
  } finally {
    await context.close()
  }
})

test('caller cancellation drains started discoveries and never starts queued queries', async () => {
  const bothStarted = deferred<void>()
  const release = deferred<void>()
  const startedQueries: string[] = []
  let active = 0
  let peak = 0
  const context = createContext(async (query) => {
    startedQueries.push(query)
    active++
    peak = Math.max(peak, active)
    if (active === 2) bothStarted.resolve()
    try {
      await release.promise
      return [`https://example.test/${query}`]
    } finally {
      active--
    }
  }, { limits: { maxConcurrency: 2 } })
  const caller = new AbortController()
  const search = context.searchWeb({
    query: 'primary',
    additionalQueries: ['second', 'third'],
    signal: caller.signal,
  })
  let searchSettled = false
  void search.finally(() => { searchSettled = true }).catch(() => {})

  try {
    await bothStarted.promise
    caller.abort()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(searchSettled, false)
    assert.equal(active, 2)
    release.resolve()
    await assert.rejects(search)
    assert.equal(searchSettled, true)
    assert.equal(active, 0)
    assert.equal(peak, 2)
    assert.deepEqual(startedQueries.sort(), ['primary', 'second'])
  } finally {
    release.resolve()
    await Promise.allSettled([search])
    await context.close()
  }
})

test('context close physically drains held discoveries before settling', async () => {
  const bothStarted = deferred<void>()
  const release = deferred<void>()
  const startedQueries: string[] = []
  let active = 0
  const context = createContext(async (query) => {
    startedQueries.push(query)
    active++
    if (active === 2) bothStarted.resolve()
    try {
      await release.promise
      return [`https://example.test/${query}`]
    } finally {
      active--
    }
  }, { limits: { maxConcurrency: 2 } })
  const search = context.searchWeb({ query: 'primary', additionalQueries: ['second', 'third'] })
  let closeSettled = false
  let closing: Promise<void> | undefined

  try {
    await bothStarted.promise
    closing = context.close().then(() => { closeSettled = true })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(closeSettled, false)
    assert.equal(active, 2)
    release.resolve()
    await assert.rejects(search)
    await closing
    assert.equal(active, 0)
    assert.deepEqual(startedQueries.sort(), ['primary', 'second'])
  } finally {
    release.resolve()
    if (closing) await closing
    else await context.close()
    await Promise.allSettled([search])
  }
})
