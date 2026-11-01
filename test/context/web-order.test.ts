import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebSearch } from '../../src/context/web.js'
import { mapConcurrentOrdered } from '../../src/context/ordered-pool.js'

const urls = [
  'https://first.example.test/guide',
  'https://second.example.test/guide',
]

function document(url: string, text = 'needle ' + 'x'.repeat(53)) {
  return {
    url,
    title: 'needle guide',
    text,
    fetchedAt: '2026-11-01T00:00:00.000Z',
    publishedAt: null,
    sourceUpdatedAt: null,
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test('web document admission and errors follow discovery order at either response timing', async () => {
  const snapshots: Array<{ urls: string[]; errors: unknown[] }> = []

  for (const delays of [[35, 1], [1, 35]]) {
    const context = createWebSearch({
      web: {
        discover: async () => urls,
        fetchDocument: async (url) => {
          await new Promise((resolve) => setTimeout(resolve, delays[urls.indexOf(url)]))
          return document(url)
        },
      },
      limits: { maxConcurrency: 2, maxTotalDocumentChars: 80 },
    })
    try {
      const result = await context.searchWeb({ query: 'needle', limit: 2 })
      snapshots.push({
        urls: result.passages.map((passage) => passage.canonicalURL),
        errors: result.errors,
      })
    } finally {
      await context.close()
    }
  }

  assert.deepEqual(snapshots[0], snapshots[1])
  assert.deepEqual(snapshots[0]?.urls, [urls[0]])
  assert.deepEqual(snapshots[0]?.errors, [
    { stage: 'document', url: urls[1], code: 'DOCUMENT_TOO_LARGE' },
  ])
})

test('an earlier document failure does not prevent a later valid page from being admitted', async () => {
  const context = createWebSearch({
    web: {
      discover: async () => urls,
      fetchDocument: async (url) => {
        if (url === urls[0]) throw new Error('offline')
        return document(url)
      },
    },
    limits: { maxConcurrency: 2 },
  })

  try {
    const result = await context.searchWeb({ query: 'needle', limit: 2 })
    assert.deepEqual(result.passages.map((passage) => passage.canonicalURL), [urls[1]])
    assert.deepEqual(result.errors, [
      { stage: 'document', url: urls[0], code: 'DOCUMENT_FAILED' },
    ])
  } finally {
    await context.close()
  }
})

test('ordered admission retains the existing total result character cap', async () => {
  const context = createWebSearch({
    web: {
      discover: async () => urls,
      fetchDocument: async (url) => document(url),
    },
    limits: { maxConcurrency: 2 },
  })

  try {
    const result = await context.searchWeb({ query: 'needle', limit: 2, maxChars: 12 })
    assert.equal(result.budget.maxChars, 12)
    assert.ok(result.budget.usedChars <= 12)
    assert.equal(result.passages.reduce((total, passage) => total + passage.excerpt.length, 0), 12)
  } finally {
    await context.close()
  }
})

test('ordered pool keeps parallel work within its configured bound', async () => {
  let active = 0
  let peak = 0
  const output: number[] = []
  for await (const value of mapConcurrentOrdered(
    [0, 1, 2, 3, 4],
    2,
    new AbortController().signal,
    async (value) => {
      active++
      peak = Math.max(peak, active)
      try {
        await new Promise((resolve) => setTimeout(resolve, value === 0 ? 20 : 1))
        return value
      } finally {
        active--
      }
    },
  )) {
    output.push(value)
  }

  assert.deepEqual(output, [0, 1, 2, 3, 4])
  assert.equal(peak, 2)
  assert.equal(active, 0)
})

test('early iterator break aborts pending operations and waits for physical settlement', async () => {
  const releaseFirst = deferred()
  const releaseSecond = deferred()
  const started: number[] = []
  let active = 0
  let settled = 0
  let siblingAborted = false
  const controller = new AbortController()
  const iterator = mapConcurrentOrdered([0, 1, 2], 2, controller.signal, async (value, signal) => {
    started.push(value)
    if (value === 1)
      signal.addEventListener('abort', () => { siblingAborted = true }, { once: true })
    active++
    try {
      await (value === 0 ? releaseFirst.promise : releaseSecond.promise)
      signal.throwIfAborted()
      return value
    } finally {
      active--
      settled++
    }
  })

  try {
    const first = iterator.next()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(started, [0, 1])
    releaseFirst.resolve()
    assert.deepEqual(await first, { value: 0, done: false })
    const stopping = iterator.return(undefined)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(active, 1)
    assert.equal(settled, 1)
    releaseSecond.resolve()
    await stopping
    assert.equal(active, 0)
    assert.equal(settled, 2)
    assert.equal(siblingAborted, true)
  } finally {
    releaseFirst.resolve()
    releaseSecond.resolve()
  }
})

test('unexpected worker failure cancels and drains sibling work', async () => {
  const release = deferred()
  const controller = new AbortController()
  let siblingSettled = false
  let siblingAborted = false
  const iterator = mapConcurrentOrdered([0, 1], 2, controller.signal, async (value, signal) => {
    if (value === 0) throw new Error('unexpected worker failure')
    signal.addEventListener('abort', () => { siblingAborted = true }, { once: true })
    try {
      await release.promise
      signal.throwIfAborted()
      return value
    } finally {
      siblingSettled = true
    }
  })

  try {
    const next = iterator.next()
    await new Promise((resolve) => setImmediate(resolve))
    const stopping = iterator.return(undefined)
    release.resolve()
    await assert.rejects(next, /unexpected worker failure/)
    await stopping
    assert.equal(siblingSettled, true)
    assert.equal(siblingAborted, true)
  } finally {
    release.resolve()
  }
})

test('lifecycle close waits for a fetcher that settles after cancellation', async () => {
  const release = deferred()
  const started = deferred()
  const context = createWebSearch({
    web: {
      discover: async () => [urls[0]],
      fetchDocument: async (url) => {
        started.resolve()
        await release.promise
        return document(url)
      },
    },
  })
  const search = context.searchWeb({ query: 'needle', limit: 1 })
  await started.promise
  let closed = false
  const closing = context.close().then(() => { closed = true })

  try {
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(closed, false)
    release.resolve()
    await assert.rejects(search)
    await closing
    assert.equal(closed, true)
  } finally {
    release.resolve()
    await closing
  }
})

test('caller cancellation waits for physically unsettled document work', async () => {
  const release = deferred()
  const started = deferred()
  const caller = new AbortController()
  const context = createWebSearch({
    web: {
      discover: async () => [urls[0]],
      fetchDocument: async (url) => {
        started.resolve()
        await release.promise
        return document(url)
      },
    },
  })
  const search = context.searchWeb({ query: 'needle', limit: 1, signal: caller.signal })

  try {
    await started.promise
    caller.abort(new Error('caller cancelled'))
    let searchSettled = false
    void search.finally(() => { searchSettled = true }).catch(() => {})
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(searchSettled, false)
    release.resolve()
    await assert.rejects(search, /caller cancelled/)
    assert.equal(searchSettled, true)
  } finally {
    release.resolve()
    await context.close()
  }
})
