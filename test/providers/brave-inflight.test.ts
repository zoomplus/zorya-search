import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createWebSearch } from '../../src/context/web.js'
import { BraveDocumentCache } from '../../src/providers/brave-document-cache.js'
import { createBraveWebSource, type WebLoader } from '../../src/providers/brave.js'
import { ProviderError } from '../../src/providers/contracts.js'

const sharedUrl = 'https://fixture.example.test/shared'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function loaderDocument(url: URL, text = 'shared fixture text') {
  return {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: Buffer.from(text),
    url,
  }
}

function makeWeb(
  loader: WebLoader,
  concurrency = 2,
) {
  return createBraveWebSource({
    allowPrivateForTests: true,
    loader,
    limits: { attempts: 1, concurrency, timeoutMs: 10_000 },
  })
}

async function waitFor(signal: Promise<unknown>, message: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 2_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

test('same canonical URL shares one fetch and returns isolated document copies', async () => {
  const started = deferred<void>()
  const release = deferred<void>()
  let calls = 0
  const web = makeWeb(async (url) => {
    calls++
    started.resolve()
    await release.promise
    return loaderDocument(url)
  })

  try {
    const first = web.fetchDocument(sharedUrl, new AbortController().signal)
    const second = web.fetchDocument(`${sharedUrl}#fragment`, new AbortController().signal)
    await waitFor(started.promise, 'Shared Brave loader did not start')
    release.resolve()
    const [firstDocument, secondDocument] = await Promise.all([first, second])
    assert.equal(calls, 1)
    assert.notEqual(firstDocument, secondDocument)
    firstDocument.text = 'caller mutation'
    assert.equal(secondDocument.text, 'shared fixture text')
    assert.equal(web.usage().calls, 1)
  } finally {
    release.resolve()
  }
})

test('distinct URLs run in parallel without exceeding configured concurrency', async () => {
  const bothStarted = deferred<void>()
  const release = deferred<void>()
  let active = 0
  let peak = 0
  let calls = 0
  const web = makeWeb(async (url) => {
    calls++
    active++
    peak = Math.max(peak, active)
    if (active === 2) bothStarted.resolve()
    try {
      if (url.pathname !== '/third') await release.promise
      return loaderDocument(url, `source ${url.pathname}`)
    } finally {
      active--
    }
  })

  try {
    const requests = ['/first', '/second', '/third'].map((path) =>
      web.fetchDocument(`https://fixture.example.test${path}`, new AbortController().signal),
    )
    await waitFor(bothStarted.promise, 'Two distinct Brave requests did not overlap')
    assert.equal(peak, 2)
    release.resolve()
    const documents = await Promise.all(requests)
    assert.equal(documents.length, 3)
    assert.equal(calls, 3)
    assert.equal(peak, 2)
  } finally {
    release.resolve()
  }
})

test('aborting one waiter leaves a shared request available to another waiter', async () => {
  const started = deferred<void>()
  const release = deferred<void>()
  let calls = 0
  let sharedSignal: AbortSignal | undefined
  const web = makeWeb(async (url, signal) => {
    calls++
    sharedSignal = signal
    started.resolve()
    await release.promise
    return loaderDocument(url)
  })
  const firstController = new AbortController()

  try {
    const cancelled = web.fetchDocument(sharedUrl, firstController.signal)
    const retained = web.fetchDocument(sharedUrl, new AbortController().signal)
    await waitFor(started.promise, 'Shared Brave loader did not start')
    firstController.abort()
    await assert.rejects(
      cancelled,
      (error: unknown) => error instanceof ProviderError && error.code === 'cancel',
    )
    assert.equal(sharedSignal?.aborted, false)
    release.resolve()
    const result = await retained
    assert.equal(result.text, 'shared fixture text')
    assert.equal(calls, 1)
  } finally {
    release.resolve()
  }
})

test('last waiter abort joins an abort-ignoring loader before web context close settles', async () => {
  const started = deferred<void>()
  const release = deferred<void>()
  const url = 'https://fixture.example.test/close'
  const source = makeWeb(async (requestUrl) => {
    started.resolve()
    await release.promise
    return loaderDocument(requestUrl, 'late result must not publish')
  })
  const context = createWebSearch({
    web: {
      discover: async () => [url],
      fetchDocument: source.fetchDocument.bind(source),
    },
  })
  const search = context.searchWeb({ query: 'fixture', limit: 1 })
  let closeSettled = false
  let closing: Promise<void> | undefined

  try {
    await waitFor(started.promise, 'Context-owned Brave loader did not start')
    closing = context.close().then(() => { closeSettled = true })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(closeSettled, false)
    release.resolve()
    await assert.rejects(search)
    await closing
    assert.equal(closeSettled, true)
  } finally {
    release.resolve()
    if (closing) await closing
    else await context.close()
  }
})

test('late waiter retries only after an abandoned physical fetch has settled', async () => {
  const started = deferred<void>()
  const releaseFirst = deferred<void>()
  let calls = 0
  const web = makeWeb(async (url) => {
    calls++
    if (calls === 1) {
      started.resolve()
      await releaseFirst.promise
      return loaderDocument(url, 'abandoned result')
    }
    return loaderDocument(url, 'fresh result')
  })
  const firstController = new AbortController()

  try {
    const abandoned = web.fetchDocument(sharedUrl, firstController.signal)
    await waitFor(started.promise, 'First Brave loader did not start')
    firstController.abort()
    const lateWaiter = web.fetchDocument(sharedUrl, new AbortController().signal)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls, 1)
    releaseFirst.resolve()
    await assert.rejects(
      abandoned,
      (error: unknown) => error instanceof ProviderError && error.code === 'cancel',
    )
    assert.equal((await lateWaiter).text, 'fresh result')
    assert.equal(calls, 2)
  } finally {
    releaseFirst.resolve()
  }
})

test('failed physical fetch is removed so a later call can retry', async () => {
  let calls = 0
  const web = makeWeb(async (url) => {
    calls++
    if (calls === 1) throw new ProviderError('unavailable')
    return loaderDocument(url, 'retry succeeded')
  })

  await assert.rejects(
    web.fetchDocument(sharedUrl, new AbortController().signal),
    (error: unknown) => error instanceof ProviderError && error.code === 'unavailable',
  )
  assert.equal((await web.fetchDocument(sharedUrl, new AbortController().signal)).text, 'retry succeeded')
  assert.equal(calls, 2)
})

test('unsafe URL validation happens before any in-flight join', async () => {
  const started = deferred<void>()
  const release = deferred<void>()
  let calls = 0
  const web = makeWeb(async (url) => {
    calls++
    started.resolve()
    await release.promise
    return loaderDocument(url)
  })

  try {
    const active = web.fetchDocument(sharedUrl, new AbortController().signal)
    await waitFor(started.promise, 'Safe Brave request did not start')
    await assert.rejects(
      web.fetchDocument('file:///etc/hosts', new AbortController().signal),
      (error: unknown) => error instanceof ProviderError && error.code === 'malformed',
    )
    assert.equal(calls, 1)
    release.resolve()
    assert.equal((await active).url, sharedUrl)
  } finally {
    release.resolve()
  }
})

test('same URL waiter overflow is rejected with the existing budget error', async () => {
  const started = deferred<void>()
  const release = deferred<void>()
  let calls = 0
  const web = makeWeb(async (url) => {
    calls++
    started.resolve()
    await release.promise
    return loaderDocument(url)
  }, 1)
  const waiterLimit = 1 + 32
  const waiters = Array.from({ length: waiterLimit }, () =>
    web.fetchDocument(sharedUrl, new AbortController().signal),
  )

  try {
    await waitFor(started.promise, 'Bounded shared request did not start')
    await assert.rejects(
      web.fetchDocument(sharedUrl, new AbortController().signal),
      (error: unknown) => error instanceof ProviderError && error.code === 'budget',
    )
    release.resolve()
    const documents = await Promise.all(waiters)
    assert.equal(documents.length, waiterLimit)
    assert.equal(calls, 1)
  } finally {
    release.resolve()
    await Promise.allSettled(waiters)
  }
})

test('cancelled waiters on a running shared fetch keep retained callbacks within the bound', async () => {
  const started = deferred<void>()
  const release = deferred<void>()
  let calls = 0
  const web = makeWeb(async (url) => {
    calls++
    started.resolve()
    await release.promise
    return loaderDocument(url)
  }, 1)
  const keeper = web.fetchDocument(sharedUrl, new AbortController().signal)
  const waiterLimit = 1 + 32
  let cancelledWaiters = 0

  try {
    await waitFor(started.promise, 'Shared Brave loader did not start')
    for (let index = 0; index < waiterLimit + 2; index++) {
      const controller = new AbortController()
      const waiter = web.fetchDocument(sharedUrl, controller.signal)
      controller.abort()
      if (index < waiterLimit - 1) {
        await assert.rejects(
          waiter,
          (error: unknown) => error instanceof ProviderError && error.code === 'cancel',
        )
        cancelledWaiters++
      } else {
        await assert.rejects(
          waiter,
          (error: unknown) => error instanceof ProviderError && error.code === 'budget',
        )
        break
      }
    }
    assert.equal(cancelledWaiters, waiterLimit - 1)
    release.resolve()
    await keeper
    assert.equal(calls, 1)
  } finally {
    release.resolve()
    await Promise.allSettled([keeper])
  }
})

test('cancelled late waiters on an aborting fetch also stay within the retained bound', async () => {
  const started = deferred<void>()
  const release = deferred<void>()
  let calls = 0
  const web = makeWeb(async (url) => {
    calls++
    started.resolve()
    await release.promise
    return loaderDocument(url)
  }, 1)
  const keeperController = new AbortController()
  const keeper = web.fetchDocument(sharedUrl, keeperController.signal)
  const waiterLimit = 1 + 32
  let cancelledWaiters = 0

  try {
    await waitFor(started.promise, 'Shared Brave loader did not start')
    keeperController.abort()
    for (let index = 0; index < waiterLimit + 2; index++) {
      const controller = new AbortController()
      const waiter = web.fetchDocument(sharedUrl, controller.signal)
      controller.abort()
      if (index < waiterLimit - 1) {
        await assert.rejects(
          waiter,
          (error: unknown) => error instanceof ProviderError && error.code === 'cancel',
        )
        cancelledWaiters++
      } else {
        await assert.rejects(
          waiter,
          (error: unknown) => error instanceof ProviderError && error.code === 'budget',
        )
        break
      }
    }
    assert.equal(cancelledWaiters, waiterLimit - 1)
    release.resolve()
    await assert.rejects(
      keeper,
      (error: unknown) => error instanceof ProviderError && error.code === 'cancel',
    )
    assert.equal(calls, 1)
  } finally {
    release.resolve()
    await Promise.allSettled([keeper])
  }
})

test('distinct URL entry overflow is bounded by the provider queue capacity', async () => {
  const started = deferred<void>()
  const release = deferred<void>()
  let calls = 0
  const web = makeWeb(async (url) => {
    calls++
    if (url.pathname === '/0') {
      started.resolve()
      await release.promise
    }
    return loaderDocument(url, url.pathname)
  }, 1)
  const entryLimit = 1 + 32
  const entries = Array.from({ length: entryLimit }, (_, index) =>
    web.fetchDocument(`https://fixture.example.test/${index}`, new AbortController().signal),
  )

  try {
    await waitFor(started.promise, 'First bounded queue entry did not start')
    await assert.rejects(
      web.fetchDocument('https://fixture.example.test/overflow', new AbortController().signal),
      (error: unknown) => error instanceof ProviderError && error.code === 'budget',
    )
    release.resolve()
    assert.equal((await Promise.all(entries)).length, entryLimit)
    assert.equal(calls, entryLimit)
  } finally {
    release.resolve()
    await Promise.allSettled(entries)
  }
})

test('different provider instances do not share fetch operations', async () => {
  const release = deferred<void>()
  const startedA = deferred<void>()
  const startedB = deferred<void>()
  let callsA = 0
  let callsB = 0
  const first = makeWeb(async (url) => {
    callsA++
    startedA.resolve()
    await release.promise
    return loaderDocument(url, 'first instance')
  })
  const second = makeWeb(async (url) => {
    callsB++
    startedB.resolve()
    await release.promise
    return loaderDocument(url, 'second instance')
  })

  try {
    const firstRead = first.fetchDocument(sharedUrl, new AbortController().signal)
    const secondRead = second.fetchDocument(sharedUrl, new AbortController().signal)
    await Promise.all([
      waitFor(startedA.promise, 'First provider instance did not start'),
      waitFor(startedB.promise, 'Second provider instance did not start'),
    ])
    assert.equal(callsA, 1)
    assert.equal(callsB, 1)
    release.resolve()
    assert.equal((await firstRead).text, 'first instance')
    assert.equal((await secondRead).text, 'second instance')
  } finally {
    release.resolve()
  }
})

test('ordinary next read still sends a conditional validator and preserves cached dates/body on 304', async () => {
  const conditionals: string[] = []
  const publishedAt = '2021-02-03T04:05:06.000Z'
  const lastModified = 'Wed, 10 Mar 2021 09:08:07 GMT'
  const server = createServer((request, response) => {
    conditionals.push(String(request.headers['if-none-match'] ?? ''))
    if (request.headers['if-none-match'] === '"body-v1"') {
      response.writeHead(304, { etag: '"body-v1"', 'cache-control': 'public' })
      response.end()
      return
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      etag: '"body-v1"',
      'last-modified': lastModified,
      'cache-control': 'public',
    })
    response.end(
      `<html><head><title>Cached title</title><meta property="article:published_time" content="${publishedAt}"></head><body><main>cached body text</main></body></html>`,
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const url = `http://fixture.invalid:${address.port}/cached`
  const web = createBraveWebSource({
    allowPrivateForTests: true,
    resolveForTests: async () => [{ address: '127.0.0.1', family: 4 }],
    limits: { attempts: 1 },
  })

  try {
    const original = await web.fetchDocument(url, new AbortController().signal)
    const refreshed = await web.fetchDocument(url, new AbortController().signal)
    assert.deepEqual(conditionals, ['', '"body-v1"'])
    assert.equal(original.title, 'Cached title')
    assert.equal(refreshed.text, original.text)
    assert.equal(refreshed.publishedAt, publishedAt)
    assert.equal(refreshed.sourceUpdatedAt, new Date(lastModified).toISOString())
    assert.equal(refreshed.url, original.url)
    assert.notEqual(refreshed.fetchedAt, original.fetchedAt)
    assert.equal(web.usage().calls, 2)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})

test('a stale cache ticket cannot replace a newer revision after an overlapped read', () => {
  const cache = new BraveDocumentCache(4, 10_000)
  const url = 'https://fixture.example.test/race'
  const initialTicket = cache.begin(url)
  const initialDocument = {
    url,
    title: 'original',
    text: 'original body',
    fetchedAt: '2026-11-01T00:00:00.000Z',
    publishedAt: null,
    sourceUpdatedAt: null,
  }
  cache.store(initialTicket, initialDocument, { etag: '"v1"', 'cache-control': 'public' })
  cache.release(initialTicket)

  const stale304Ticket = cache.begin(url)
  const newerTicket = cache.begin(url)
  const newerDocument = {
    url,
    title: 'newer',
    text: 'newer body',
    fetchedAt: '2026-11-01T00:00:01.000Z',
    publishedAt: null,
    sourceUpdatedAt: null,
  }
  const staleDocument = { ...initialDocument, title: 'stale', text: 'stale body' }

  assert.equal(stale304Ticket.validators?.etag, '"v1"')
  assert.equal(newerTicket.validators?.etag, '"v1"')
  cache.store(newerTicket, newerDocument, { etag: '"v2"', 'cache-control': 'public' })
  assert.equal(
    cache.refresh(
      stale304Ticket,
      { etag: '"v1"', 'cache-control': 'public' },
      '2026-11-01T00:00:02.000Z',
    ),
    null,
  )
  cache.store(stale304Ticket, staleDocument, { etag: '"v1"', 'cache-control': 'public' })
  const nextTicket = cache.begin(url)
  try {
    assert.equal(nextTicket.entry?.document.text, 'newer body')
    assert.equal(nextTicket.validators?.etag, '"v2"')
  } finally {
    cache.release(stale304Ticket)
    cache.release(newerTicket)
    cache.release(nextTicket)
  }
})
