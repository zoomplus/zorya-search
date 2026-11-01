import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openSearchRuntime } from '../../src/runtime/index.js'
import { ProviderError } from '../../src/providers/contracts.js'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-web-runtime-'))
  const root = join(dir, 'root')
  const dataDir = join(dir, 'state')
  await Promise.all([mkdir(root), mkdir(dataDir)])
  return {
    dir,
    root,
    config: {
      version: 1 as const,
      dataDir,
      roots: [{ id: 'repo', path: root }],
      web: { discovery: { secret: { kind: 'env' as const, name: 'BRAVE_KEY' } } },
    },
  }
}

function document(url: string) {
  return {
    url,
    title: 'Fixture source',
    text: 'Caller supplied web query fixture content.',
    fetchedAt: '2026-11-01T00:00:00.000Z',
    publishedAt: null,
    sourceUpdatedAt: null,
  }
}

test('runtime forwards additional queries and date range, retains shared caps and discovery provenance', async () => {
  const f = await fixture()
  const discoveryCalls: Array<{ query: string; target: number; dateRange?: unknown }> = []
  const fetched: string[] = []
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({
      config: f.config,
      testDependencies: {
        env: { BRAVE_KEY: 'fixture-only' },
        webSource: {
          async discover(query, target, _signal, options) {
            discoveryCalls.push({ query, target, dateRange: options?.dateRange })
            if (query === 'fails safely') throw new ProviderError('rate_limit', 429, 250)
            const queryId = discoveryCalls.findIndex((call) => call.query === query)
            return Array.from({ length: 30 }, (_, index) =>
              `https://source-${queryId}-${index}.example.test/page`,
            )
          },
          async fetchDocument(url) {
            fetched.push(url)
            return document(url)
          },
        },
      },
    })

    const dateRange = { from: '2026-01-01', through: '2026-01-31' }
    const result = await runtime.searchWeb({
      query: 'primary query',
      additionalQueries: ['fails safely', 'second query'],
      dateRange,
      limit: 20,
    })

    assert.deepEqual(discoveryCalls.map(({ query }) => query), [
      'primary query',
      'fails safely',
      'second query',
    ])
    assert.deepEqual(discoveryCalls.map(({ target }) => target), [40, 40, 40])
    assert.deepEqual(discoveryCalls.map(({ dateRange: range }) => range), [dateRange, dateRange, dateRange])
    assert.equal(fetched.length, 40)
    assert.equal(new Set(fetched).size, 40)
    assert.equal(result.passages.length, 20)
    assert.deepEqual(result.discovery?.queries.map(({ query }) => query), [
      'primary query',
      'fails safely',
      'second query',
    ])
    assert.deepEqual(result.discovery?.queries.map(({ retainedUrls }) => retainedUrls), [20, 0, 20])
    assert.equal(result.discovery?.uniqueUrls, 60)
    assert.equal(result.discovery?.truncated, true)
    assert.deepEqual(result.errors, [{
      stage: 'discovery',
      code: 'DISCOVERY_FAILED',
      queryIndex: 1,
      provider: { code: 'rate_limit', httpStatus: 429, retryAfterMs: 250 },
    }])
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('runtime preserves legacy result shape and rejects malformed additional queries before discovery', async () => {
  const f = await fixture()
  let discoveryCalls = 0
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({
      config: f.config,
      testDependencies: {
        env: { BRAVE_KEY: 'fixture-only' },
        webSource: {
          async discover() {
            discoveryCalls++
            return ['https://legacy.example.test/page']
          },
          async fetchDocument(url) { return document(url) },
        },
      },
    })
    const legacy = await runtime.searchWeb({ query: 'legacy query' })
    assert.equal('discovery' in legacy, false)
    assert.equal('queryIndexes' in (legacy.passages[0] ?? {}), false)

    const invalid = [
      Array.from({ length: 8 }, (_, index) => `q${index}`),
      ['   '],
      ['x'.repeat(2001)],
      [42],
    ]
    const beforeInvalidCalls = discoveryCalls
    for (const additionalQueries of invalid) {
      await assert.rejects(
        runtime.searchWeb({ query: 'primary', additionalQueries } as never),
      )
    }
    assert.equal(discoveryCalls, beforeInvalidCalls)
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('runtime cancellation reaches the active discovery operation and waits for it to settle', async () => {
  const f = await fixture()
  let started!: () => void
  const discoveryStarted = new Promise<void>((resolve) => { started = resolve })
  let activeSignal: AbortSignal | undefined
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({
      config: f.config,
      testDependencies: {
        env: { BRAVE_KEY: 'fixture-only' },
        webSource: {
          discover(_query, _target, signal) {
            activeSignal = signal
            started()
            return new Promise<string[]>((_, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true })
            })
          },
          async fetchDocument(url) { return document(url) },
        },
      },
    })
    const controller = new AbortController()
    const pending = runtime.searchWeb({ query: 'primary', additionalQueries: ['secondary'], signal: controller.signal })
    await discoveryStarted
    controller.abort(new DOMException('cancelled', 'AbortError'))
    await assert.rejects(pending)
    assert.equal(activeSignal?.aborted, true)
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})
