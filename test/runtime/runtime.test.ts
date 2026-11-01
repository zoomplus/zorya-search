import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, writeFile, chmod, rename, symlink, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadRuntimeConfig,
  openSearchRuntime,
  parseRuntimeConfig,
  RuntimeConfigError,
  SearchRuntimeError,
} from '../../src/runtime/index.js'
import { readBoundedRegularFile } from '../../src/runtime/config.js'
import { createHash } from 'node:crypto'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-runtime-'))
  const a = join(dir, 'root-a'),
    b = join(dir, 'root-b'),
    dataDir = join(dir, 'state')
  await Promise.all([mkdir(a), mkdir(b), mkdir(dataDir)])
  await writeFile(join(a, 'alpha.ts'), 'export function alphaFeature() { return "alpha" }\n')
  await writeFile(join(b, 'beta.ts'), 'export function betaExclusiveSignal() { return "beta" }\n')
  return {
    dir,
    a,
    b,
    dataDir,
    config: {
      version: 1,
      dataDir,
      roots: [
        { id: 'a', path: a },
        { id: 'b', path: b },
      ],
    },
  }
}

function waitForAbort(
  signal: AbortSignal | null | undefined,
  onAbort?: () => void,
): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) {
      reject(new Error('EXPECTED_ABORT_SIGNAL'))
      return
    }
    const abort = () => {
      onAbort?.()
      reject(new DOMException('timeout', 'AbortError'))
    }
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

test('strict versioned owner configuration rejects unsafe extras and snapshots input', () => {
  const config = {
    version: 1,
    dataDir: '/tmp/search',
    roots: [{ id: 'r', path: '/tmp/repo', limits: { maxChunks: 50_000 } }],
  }
  const parsed = parseRuntimeConfig(config)
  config.roots[0]!.path = '/etc'
  assert.equal(parsed.roots[0]!.path, '/tmp/repo')
  assert.throws(() => parseRuntimeConfig({ ...config, apiKey: 'nope' }), RuntimeConfigError)
  assert.throws(
    () => parseRuntimeConfig({ ...config, roots: [{ id: 'r', path: 'relative/root' }] }),
    RuntimeConfigError,
  )
  const mechanismCode = parseRuntimeConfig({ ...config, mechanism: { code: { secret: { kind: 'env', name: 'VOYAGE_KEY' } } } })
  assert.equal(mechanismCode.mechanism?.code?.secret.kind, 'env')
  assert.throws(() => parseRuntimeConfig({ ...config, mechanism: {} }), RuntimeConfigError)
  assert.throws(() => parseRuntimeConfig({ ...config, mechanism: { code: { secret: { kind: 'env', name: 'VOYAGE_KEY' } } }, embedding: { provider: 'openrouter', model: 'legacy', dimensions: 1024, secret: { kind: 'env', name: 'OTHER_KEY' } } }), RuntimeConfigError)
  const braveRate = parseRuntimeConfig({
    ...config,
    web: { discovery: { secret: { kind: 'env', name: 'BRAVE_KEY' }, limits: { maxRequestsPerSecond: 8 } } },
  })
  assert.equal(braveRate.web?.discovery?.limits?.maxRequestsPerSecond, 8)
  for (const maxRequestsPerSecond of [0, 101]) {
    assert.throws(() => parseRuntimeConfig({
      ...config,
      web: { discovery: { secret: { kind: 'env', name: 'BRAVE_KEY' }, limits: { maxRequestsPerSecond } } },
    }), RuntimeConfigError)
  }
  assert.throws(() => parseRuntimeConfig({
    ...config,
    embedding: {
      provider: 'openrouter', model: 'm', dimensions: 3,
      secret: { kind: 'env', name: 'KEY' }, limits: { maxRequestsPerSecond: 8 },
    },
  }), RuntimeConfigError)
  assert.doesNotThrow(() =>
    parseRuntimeConfig({
      ...config,
      roots: [
        { id: 'upper', path: '/tmp/Repo' },
        { id: 'lower', path: '/tmp/repo' },
      ],
    }),
  )
  assert.throws(
    () =>
      parseRuntimeConfig({
        version: 1,
        dataDir: '/tmp/x',
        roots: [{ id: 'r', path: '/tmp/r', apiKey: 'bad' }],
      }),
    RuntimeConfigError,
  )
  assert.throws(
    () =>
      parseRuntimeConfig({
        version: 1,
        dataDir: '/tmp/x',
        roots: [{ id: 'r', path: '/tmp/r' }],
        embedding: {
          provider: 'openai-compatible',
          model: 'm',
          dimensions: 3,
          profileId: 'p',
          secret: { kind: 'env', name: 'KEY' },
          fetch: true,
        },
      }),
    RuntimeConfigError,
  )
  assert.throws(
    () =>
      parseRuntimeConfig({
        ...config,
        web: {
          embedding: {
            provider: 'openai-compatible',
            model: 'web-model',
            dimensions: 3,
            secret: { kind: 'env', name: 'WEB_KEY' },
          },
        },
      }),
    RuntimeConfigError,
  )
})

test('runtime forwards source-kind and named-language filters to code and context searches', async () => {
  const f = await fixture()
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    await mkdir(join(f.a, 'test'), { recursive: true })
    await mkdir(join(f.a, 'docs'), { recursive: true })
    await writeFile(join(f.a, 'typed.tsx'), 'export const runtimeSharedMarkerTsx = 1\n')
    await writeFile(join(f.a, 'test', 'runtime.test.ts'), 'export const runtimeSharedMarkerTest = 1\n')
    await writeFile(join(f.a, 'docs', 'README.md'), '# runtimeSharedMarkerDocs\n')
    runtime = await openSearchRuntime({ config: f.config })
    await runtime.indexRepository({ rootId: 'a' })
    const named = await runtime.searchCode({ rootId: 'a', query: 'runtimeSharedMarker', language: 'typescript', mode: 'lexical', limit: 20 })
    assert.ok(named.hits.some((hit) => hit.path === 'typed.tsx'))
    assert.ok(named.hits.some((hit) => hit.path === 'test/runtime.test.ts'))
    const tests = await runtime.searchCode({ rootId: 'a', query: 'runtimeSharedMarker', sourceKind: 'tests', mode: 'lexical', limit: 20 })
    assert.deepEqual(tests.hits.map((hit) => hit.path), ['test/runtime.test.ts'])
    const docs = await runtime.getCodeContext({ rootId: 'a', query: 'runtimeSharedMarker', sourceKind: 'documentation' })
    assert.deepEqual(docs.sections.map((section) => section.path), ['docs/README.md'])
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('offline PGlite runtime indexes isolated roots, preserves provenance, and reopens', async () => {
  const f = await fixture()
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({ config: f.config })
    assert.deepEqual(runtime.capabilities(), {
      code: true,
      embedding: false,
      webEmbedding: false,
      codeReranking: false,
      webReranking: false,
      webRead: false,
      webDiscovery: false,
      classification: false,
      visual: false,
    })
    await assert.rejects(runtime.searchVisualReferences({ references: [{ id: 'provided', contentHash: 'a'.repeat(64), text: 'reference' }], queryText: 'anything' }), isCode('CAPABILITY_DISABLED'))
    await runtime.indexRepository({ rootId: 'a' })
    await runtime.indexRepository({ rootId: 'b' })
    const result = await runtime.searchCode({ rootId: 'a', query: 'alphaFeature', mode: 'lexical' })
    assert.equal(result.hits[0]?.path, 'alpha.ts')
    assert.equal(result.identity.root, await realpath(f.a))
    assert.ok(result.identity.snapshotId)
    const mutableRequest = { rootId: 'a', query: 'alphaFeature', mode: 'lexical' as const }
    const captured = runtime.searchCode(mutableRequest)
    mutableRequest.query = 'unrelated'
    assert.equal((await captured).hits[0]?.path, 'alpha.ts')
    await assert.rejects(
      runtime.searchCode({ rootId: 'a', query: 'x', limit: 0 }),
      isCode('INVALID_REQUEST'),
    )
    await assert.rejects(runtime.readSource({ rootId: 'a', path: '' }), isCode('INVALID_REQUEST'))
    await assert.rejects(
      runtime.searchCode({ rootId: 'a', query: 'x', root: f.b } as never),
      isCode('INVALID_REQUEST'),
    )
    const cancelled = new AbortController()
    cancelled.abort()
    await assert.rejects(
      runtime.searchCode({ rootId: 'a', query: 'alphaFeature', signal: cancelled.signal }),
      (error: unknown) => error instanceof SearchRuntimeError && error.code === 'CANCELLED',
    )
    assert.equal(
      (await runtime.searchCode({ rootId: 'a', query: 'betaExclusiveSignal', mode: 'lexical' }))
        .hits.length,
      0,
    )
    const source = await runtime.readSource({ rootId: 'a', path: 'alpha.ts' })
    assert.match(source.text, /alphaFeature/)
    assert.equal(source.stale, false)
    const context = await runtime.getCodeContext({ rootId: 'a', query: 'alphaFeature' })
    assert.equal(context.sections[0]?.path, 'alpha.ts')
    assert.equal('vector' in context, false)
    const status = await runtime.indexStatus({ rootId: 'a' })
    assert.equal(status.fileCount, 1)
    await runtime.close()
    runtime = undefined
    runtime = await openSearchRuntime({ config: f.config })
    const firstOperationAfterReopen = await runtime.getCodeContext({
      rootId: 'a',
      query: 'alphaFeature',
    })
    assert.equal(firstOperationAfterReopen.sections[0]?.path, 'alpha.ts')
    assert.equal(
      (await runtime.indexStatus({ rootId: 'a' })).identity?.snapshotId,
      result.identity.snapshotId,
    )
    await assert.rejects(
      runtime.searchWeb({ query: 'hello' }),
      (error: unknown) =>
        error instanceof SearchRuntimeError && error.code === 'CAPABILITY_DISABLED',
    )
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('runtime background indexing deduplicates admissions and exposes a terminal status', async () => {
  const f = await fixture()
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({ config: f.config })
    const preCancelled = new AbortController()
    preCancelled.abort()
    assert.throws(() => runtime!.startIndexing({ rootId: 'a', signal: preCancelled.signal }), isCode('CANCELLED'))
    const first = runtime.startIndexing({ rootId: 'a' })
    const second = runtime.startIndexing({ rootId: 'a' })
    assert.equal(first.created, true)
    assert.equal(second.created, false)
    assert.equal(second.job.jobId, first.job.jobId)
    await waitFor(async () => (await runtime!.indexStatus({ rootId: 'a' })).indexingJob?.state === 'completed')
    const status = await runtime.indexStatus({ rootId: 'a' })
    assert.equal(status.fileCount, 1)
    assert.equal(status.indexingJob?.jobId, first.job.jobId)
    assert.equal(status.indexingJob?.state, 'completed')
    assert.equal(runtime.watchStatus({ rootId: 'a' }).job?.jobId, first.job.jobId)
    await assert.rejects(runtime.indexStatus({ rootId: 'a', jobId: '00000000-0000-4000-8000-000000000000' }), isCode('JOB_NOT_FOUND'))
    const next = runtime.startIndexing({ rootId: 'a' })
    assert.equal(next.created, true)
    await waitFor(async () => (await runtime!.indexStatus({ rootId: 'a', jobId: next.job.jobId })).indexingJob?.state === 'completed')
    assert.equal((await runtime.indexStatus({ rootId: 'a', jobId: first.job.jobId })).indexingJob?.jobId, first.job.jobId)
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('background watch startup returns before embedding settles and cancellation joins the owned job', async () => {
  const f = await fixture()
  let startedResolve: (() => void) | undefined
  let release: (() => void) | undefined
  let observedAbort = false
  const started = new Promise<void>((resolve) => { startedResolve = resolve })
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    init?.signal?.addEventListener('abort', () => { observedAbort = true }, { once: true })
    startedResolve?.()
    await new Promise<void>((resolve) => { release = resolve })
    const body = JSON.parse(String(init?.body)) as { input?: string[] }
    return new Response(JSON.stringify({ data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200 })
  }
  const config = {
    ...f.config,
    roots: [{ ...f.config.roots[0]!, watch: true }, f.config.roots[1]!],
    embedding: { provider: 'openrouter', model: 'fixture-embed', dimensions: 3, secret: { kind: 'env', name: 'EMBED_KEY' } },
  }
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({ config, backgroundWatchStartup: true, testDependencies: { env: { EMBED_KEY: 'fixture-key' }, fetch } })
    await awaitBounded(started)
    const during = await runtime.indexStatus({ rootId: 'a' })
    assert.equal(during.indexingJob?.state, 'running')
    assert.equal(runtime.watchStatus({ rootId: 'a' }).enabled, true)
    let cancelDone = false
    const cancelling = runtime.cancelIndexing({ rootId: 'a', jobId: during.indexingJob!.jobId }).then((job) => { cancelDone = true; return job })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(observedAbort, true)
    assert.equal(cancelDone, false)
    release?.()
    assert.equal((await cancelling).state, 'cancelled')
    await runtime.close()
    runtime = undefined
  } finally {
    release?.()
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('cancelled watched startup stays paused until source changes', async () => {
  const f = await fixture()
  await mkdir(join(f.a, 'nested'))
  let calls = 0
  let startedResolve: (() => void) | undefined
  const started = new Promise<void>((resolve) => { startedResolve = resolve })
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    calls++
    if (calls === 1) {
      startedResolve?.()
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
      })
    }
    const body = JSON.parse(String(init?.body)) as { input?: string[] }
    return new Response(JSON.stringify({ data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200 })
  }
  const config = {
    ...f.config,
    roots: [{ id: 'a', path: f.a, watch: true, watchIntervalMs: 250 }, f.config.roots[1]!],
    embedding: { provider: 'openrouter', model: 'fixture-embed', dimensions: 3, secret: { kind: 'env', name: 'EMBED_KEY' } },
  }
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({ config, backgroundWatchStartup: true, testDependencies: { env: { EMBED_KEY: 'fixture-key' }, fetch } })
    await awaitBounded(started)
    const running = (await runtime.indexStatus({ rootId: 'a' })).indexingJob!
    const cancelled = await runtime.cancelIndexing({ rootId: 'a', jobId: running.jobId })
    assert.equal(cancelled.state, 'cancelled')
    await waitFor(async () => runtime!.watchStatus({ rootId: 'a' }).active)
    assert.equal(runtime.watchStatus({ rootId: 'a' }).retryOnChange, true)
    await new Promise((resolve) => setTimeout(resolve, 700))
    assert.equal(calls, 1)
    await writeFile(join(f.a, 'nested', 'changed-after-cancel.ts'), 'export const resumedAfterActualChange = true\n')
    await waitFor(async () => calls === 2, 5000)
    await waitFor(async () => (await runtime!.indexStatus({ rootId: 'a' })).indexingJob?.state === 'completed', 5000)
    const result = await runtime.searchCode({ rootId: 'a', query: 'resumedAfterActualChange', mode: 'lexical' })
    assert.equal(result.hits[0]?.path, 'nested/changed-after-cancel.ts')
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('sync and background indexing serialize per root without changing the synchronous result', async () => {
  const f = await fixture()
  let startedResolve: (() => void) | undefined
  let release: (() => void) | undefined
  let calls = 0
  const started = new Promise<void>((resolve) => { startedResolve = resolve })
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    calls++
    if (calls === 1) {
      startedResolve?.()
      await new Promise<void>((resolve) => { release = resolve })
    }
    const body = JSON.parse(String(init?.body)) as { input?: string[] }
    return new Response(JSON.stringify({ data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200 })
  }
  const config = { ...f.config, embedding: { provider: 'openrouter', model: 'fixture-embed', dimensions: 3, secret: { kind: 'env', name: 'EMBED_KEY' } } }
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({ config, testDependencies: { env: { EMBED_KEY: 'fixture-key' }, fetch } })
    const admission = runtime.startIndexing({ rootId: 'a' })
    await awaitBounded(started)
    let syncDone = false
    const sync = runtime.indexRepository({ rootId: 'a' }).then((status) => { syncDone = true; return status })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(syncDone, false)
    release?.()
    const status = await sync
    assert.equal(syncDone, true)
    assert.equal(status.fileCount, 1)
    await waitFor(async () => (await runtime!.indexStatus({ rootId: 'a', jobId: admission.job.jobId })).indexingJob?.state === 'completed')
    assert.equal(calls, 1)
  } finally {
    release?.()
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('a cancelled lane waiter keeps its reservation until the prior index settles', async () => {
  const f = await fixture()
  let startedResolve: (() => void) | undefined
  let release: (() => void) | undefined
  let active = 0
  let maximumActive = 0
  let calls = 0
  const started = new Promise<void>((resolve) => { startedResolve = resolve })
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    calls++
    active++
    maximumActive = Math.max(maximumActive, active)
    try {
      if (calls === 1) {
        startedResolve?.()
        await new Promise<void>((resolve) => { release = resolve })
      }
      const body = JSON.parse(String(init?.body)) as { input?: string[] }
      return new Response(JSON.stringify({ data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200 })
    } finally {
      active--
    }
  }
  const config = { ...f.config, embedding: { provider: 'openrouter', model: 'fixture-embed', dimensions: 3, secret: { kind: 'env', name: 'EMBED_KEY' } } }
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({ config, testDependencies: { env: { EMBED_KEY: 'fixture-key' }, fetch } })
    const first = runtime.indexRepository({ rootId: 'a' })
    await awaitBounded(started)
    const waiterController = new AbortController()
    const waiter = runtime.indexRepository({ rootId: 'a', signal: waiterController.signal })
    waiterController.abort()
    await assert.rejects(waiter, isCode('CANCELLED'))
    const third = runtime.indexRepository({ rootId: 'a' })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(calls, 1)
    release?.()
    assert.equal((await first).fileCount, 1)
    assert.equal((await third).fileCount, 1)
    assert.equal(maximumActive, 1)
  } finally {
    release?.()
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('queued watched roots settle in order and a source edit during startup is retried once boundedly', async () => {
  const f = await fixture()
  let firstResolve: (() => void) | undefined
  let releaseFirst: (() => void) | undefined
  let calls = 0
  const firstStarted = new Promise<void>((resolve) => { firstResolve = resolve })
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    calls++
    if (calls === 1) {
      firstResolve?.()
      await new Promise<void>((resolve) => { releaseFirst = resolve })
    }
    const body = JSON.parse(String(init?.body)) as { input?: string[] }
    return new Response(JSON.stringify({ data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200 })
  }
  const config = {
    ...f.config,
    roots: [{ id: 'a', path: f.a, watch: true, watchIntervalMs: 250 }, { id: 'b', path: f.b, watch: true, watchIntervalMs: 250 }],
    indexing: { maxConcurrentRoots: 1, maxAttempts: 4, retryDelayMs: 100 },
    embedding: { provider: 'openrouter', model: 'fixture-embed', dimensions: 3, secret: { kind: 'env', name: 'EMBED_KEY' } },
  }
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({ config, backgroundWatchStartup: true, testDependencies: { env: { EMBED_KEY: 'fixture-key' }, fetch } })
    await awaitBounded(firstStarted)
    const queued = await runtime.indexStatus({ rootId: 'b' })
    assert.equal(queued.indexingJob?.state, 'queued')
    assert.equal(runtime.watchStatus({ rootId: 'b' }).active, false)
    await writeFile(join(f.a, 'alpha.ts'), 'export const changedWhileStartupRuns = "latest"\n')
    releaseFirst?.()
    await waitFor(async () => (await runtime!.indexStatus({ rootId: 'a' })).indexingJob?.state === 'completed')
    await waitFor(async () => (await runtime!.indexStatus({ rootId: 'b' })).indexingJob?.state === 'completed')
    await waitFor(async () => runtime!.watchStatus({ rootId: 'a' }).active && runtime!.watchStatus({ rootId: 'b' }).active)
    const final = await runtime.searchCode({ rootId: 'a', query: 'changedWhileStartupRuns', mode: 'lexical' })
    assert.equal(final.hits[0]?.path, 'alpha.ts')
    assert.ok((await runtime.indexStatus({ rootId: 'a' })).indexingJob!.attempt >= 2)
  } finally {
    releaseFirst?.()
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('job timeout retries only after durable checkpoints and exposes exact batch progress', async () => {
  const f = await fixture()
  await writeFile(
    join(f.a, 'units.ts'),
    Array.from({ length: 65 }, (_, index) => `export function unit${index}() { return ${index} }`).join('\n') + '\n',
  )
  let calls = 0
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    calls++
    if (calls === 2) {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true })
      })
    }
    const body = JSON.parse(String(init?.body)) as { input?: string[] }
    return new Response(JSON.stringify({ data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200 })
  }
  const config = {
    ...f.config,
    limits: { timeoutMs: 2000 },
    indexing: { maxAttempts: 3, jobTimeoutMs: 20_000, retryDelayMs: 100 },
    embedding: { provider: 'openrouter', model: 'fixture-embed', dimensions: 3, secret: { kind: 'env', name: 'EMBED_KEY' } },
  }
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({ config, testDependencies: { env: { EMBED_KEY: 'fixture-key' }, fetch } })
    const admission = runtime.startIndexing({ rootId: 'a' })
    await waitFor(async () => {
      const job = (await runtime!.indexStatus({ rootId: 'a', jobId: admission.job.jobId })).indexingJob
      return job?.state === 'completed' || job?.state === 'failed'
    }, 25_000)
    const job = (await runtime.indexStatus({ rootId: 'a', jobId: admission.job.jobId })).indexingJob!
    assert.equal(job.state, 'completed', JSON.stringify(job))
    assert.ok(job.attempt >= 2)
    assert.equal(job.totalChunks, 66)
    assert.equal(job.checkpointChunks, 66)
    assert.equal(calls, 4)
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('background indexing stops after a no-progress timeout or provider auth failure', async () => {
  const f = await fixture()
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    const config = {
      ...f.config,
      limits: { timeoutMs: 10_000 },
      indexing: { maxAttempts: 5, jobTimeoutMs: 30_000, retryDelayMs: 100 },
      embedding: { provider: 'openrouter', model: 'fixture-embed', dimensions: 3, secret: { kind: 'env', name: 'EMBED_KEY' } },
    }
    let timeoutCalls = 0
    const timeoutFetch: typeof globalThis.fetch = async (_input, init) => {
      timeoutCalls++
      const body = JSON.parse(String(init?.body)) as { input?: string[] }
      if (timeoutCalls === 1) {
        return new Response(JSON.stringify({ data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200 })
      }
      await waitForAbort(init?.signal)
      throw new Error('unreachable')
    }
    runtime = await openSearchRuntime({ config, testDependencies: { env: { EMBED_KEY: 'fixture-key' }, fetch: timeoutFetch } })
    await runtime.indexRepository({ rootId: 'a' })
    await writeFile(join(f.a, 'timeout-trigger.ts'), 'export const noNewCheckpointBeforeTimeout = true\n')
    const noProgress = runtime.startIndexing({ rootId: 'a' })
    await waitFor(async () => (await runtime!.indexStatus({ rootId: 'a', jobId: noProgress.job.jobId })).indexingJob?.state === 'failed', 15_000)
    let job = (await runtime.indexStatus({ rootId: 'a', jobId: noProgress.job.jobId })).indexingJob!
    assert.equal(job.attempt, 1)
    assert.equal(job.checkpointChunks, 0)
    assert.equal(timeoutCalls, 2)
    await runtime.close()
    runtime = undefined

    let authCalls = 0
    const authFetch: typeof globalThis.fetch = async (_input, init) => {
      authCalls++
      const body = JSON.parse(String(init?.body)) as { input?: string[] }
      if (authCalls === 1) {
        return new Response(JSON.stringify({ data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200 })
      }
      return new Response(JSON.stringify({ error: { message: 'private provider detail' } }), { status: 401 })
    }
    runtime = await openSearchRuntime({ config, testDependencies: { env: { EMBED_KEY: 'fixture-key' }, fetch: authFetch } })
    await writeFile(join(f.a, 'auth-prime.ts'), 'export const providerAuthPrime = true\n')
    await runtime.indexRepository({ rootId: 'a' })
    await writeFile(join(f.a, 'auth-trigger.ts'), 'export const providerAuthTrigger = true\n')
    const auth = runtime.startIndexing({ rootId: 'a' })
    await waitFor(async () => (await runtime!.indexStatus({ rootId: 'a', jobId: auth.job.jobId })).indexingJob?.state === 'failed', 15_000)
    job = (await runtime.indexStatus({ rootId: 'a', jobId: auth.job.jobId })).indexingJob!
    assert.equal(job.attempt, 1)
    assert.equal(job.errorCode, 'PROVIDER_AUTH')
    assert.equal(authCalls, 2)
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('three timeout attempts each retry after their own new durable batches', { timeout: 120_000 }, async () => {
  const f = await fixture()
  let successfulInputs: string[] = []
  const abortedCalls = new Set<number>()
  let calls = 0
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    calls++
    const callNumber = calls
    const body = JSON.parse(String(init?.body)) as { input?: string[] }
    if (callNumber === 3 || callNumber === 5) {
      await waitForAbort(init?.signal, () => abortedCalls.add(callNumber))
    }
    successfulInputs.push(...(body.input ?? []))
    return new Response(JSON.stringify({ data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200 })
  }
  const config = {
    ...f.config,
    limits: { timeoutMs: 15_000 },
    indexing: { maxAttempts: 4, jobTimeoutMs: 90_000, retryDelayMs: 100 },
    embedding: { provider: 'openrouter', model: 'fixture-embed', dimensions: 3, secret: { kind: 'env', name: 'EMBED_KEY' } },
  }
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({ config, testDependencies: { env: { EMBED_KEY: 'fixture-key' }, fetch } })
    await runtime.indexRepository({ rootId: 'a' })
    successfulInputs.length = 0
    await rm(join(f.a, 'alpha.ts'))
    await writeFile(
      join(f.a, 'units.ts'),
      Array.from({ length: 128 }, (_, index) => `export function repeated${index}() { return ${index} }`).join('\n') + '\n',
    )
    const admission = runtime.startIndexing({ rootId: 'a' })
    await waitFor(async () => (await runtime!.indexStatus({ rootId: 'a', jobId: admission.job.jobId })).indexingJob?.state === 'completed', 75_000)
    const job = (await runtime.indexStatus({ rootId: 'a', jobId: admission.job.jobId })).indexingJob!
    assert.equal(job.attempt, 3)
    assert.equal(job.totalChunks, 128)
    assert.equal(job.checkpointChunks, 128)
    assert.equal(abortedCalls.size, 2)
    assert.deepEqual([...abortedCalls], [3, 5])
    assert.equal(successfulInputs.length, 128)
    assert.equal(new Set(successfulInputs).size, 128)
    assert.equal(calls, 7)
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('overall deadlines fail queued and running jobs while owner cancellation stays cancelled', async () => {
  const f = await fixture()
  let startedResolve: (() => void) | undefined
  let release: (() => void) | undefined
  let calls = 0
  const started = new Promise<void>((resolve) => { startedResolve = resolve })
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    calls++
    if (calls === 1) {
      startedResolve?.()
      await new Promise<void>((resolve) => { release = resolve })
    }
    init?.signal?.throwIfAborted()
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }), { status: 200 })
  }
  const config = {
    ...f.config,
    limits: { timeoutMs: 2000, maxConcurrency: 1 },
    indexing: { maxConcurrentRoots: 1, jobTimeoutMs: 1200, maxAttempts: 2, retryDelayMs: 100 },
    embedding: { provider: 'openrouter', model: 'fixture-embed', dimensions: 3, secret: { kind: 'env', name: 'EMBED_KEY' } },
  }
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({ config, testDependencies: { env: { EMBED_KEY: 'fixture-key' }, fetch } })
    const running = runtime.startIndexing({ rootId: 'a' })
    await awaitBounded(started)
    const queued = runtime.startIndexing({ rootId: 'b' })
    await new Promise((resolve) => setTimeout(resolve, 1300))
    release?.()
    await waitFor(async () => (await runtime!.indexStatus({ rootId: 'b', jobId: queued.job.jobId })).indexingJob?.state === 'failed')
    const queuedStatus = (await runtime.indexStatus({ rootId: 'b', jobId: queued.job.jobId })).indexingJob!
    assert.equal(queuedStatus.errorCode, 'TIMEOUT')
    await waitFor(async () => (await runtime!.indexStatus({ rootId: 'a', jobId: running.job.jobId })).indexingJob?.state === 'failed')
    const runningStatus = (await runtime.indexStatus({ rootId: 'a', jobId: running.job.jobId })).indexingJob!
    assert.equal(runningStatus.errorCode, 'TIMEOUT')
    await runtime.close()
    runtime = undefined

    const neverStarted = async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise<void>((resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }))
      throw new Error('unreachable')
    }
    runtime = await openSearchRuntime({
      config: { ...config, indexing: { ...config.indexing, jobTimeoutMs: 5000 } },
      testDependencies: { env: { EMBED_KEY: 'fixture-key' }, fetch: neverStarted },
    })
    const owned = runtime.startIndexing({ rootId: 'a' })
    await waitFor(async () => (await runtime!.indexStatus({ rootId: 'a', jobId: owned.job.jobId })).indexingJob?.state === 'running')
    const cancelled = await runtime.cancelIndexing({ rootId: 'a', jobId: owned.job.jobId })
    assert.equal(cancelled.state, 'cancelled')
    assert.equal(cancelled.errorCode, 'CANCELLED')
  } finally {
    release?.()
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('cancelled queued jobs release queue capacity for later admissions', async () => {
  const f = await fixture()
  let startedResolve: (() => void) | undefined
  let release: (() => void) | undefined
  let calls = 0
  const started = new Promise<void>((resolve) => { startedResolve = resolve })
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    calls++
    if (calls === 1) {
      startedResolve?.()
      await new Promise<void>((resolve) => { release = resolve })
    }
    init?.signal?.throwIfAborted()
    const body = JSON.parse(String(init?.body)) as { input?: string[] }
    return new Response(JSON.stringify({ data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200 })
  }
  const config = {
    ...f.config,
    indexing: { maxConcurrentRoots: 1, maxAttempts: 1, jobTimeoutMs: 30_000 },
    embedding: { provider: 'openrouter', model: 'fixture-embed', dimensions: 3, secret: { kind: 'env', name: 'EMBED_KEY' } },
  }
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({ config, testDependencies: { env: { EMBED_KEY: 'fixture-key' }, fetch } })
    const active = runtime.startIndexing({ rootId: 'a' })
    await awaitBounded(started)
    for (let index = 0; index < 80; index++) {
      const queued = runtime.startIndexing({ rootId: 'b' })
      const cancelled = await runtime.cancelIndexing({ rootId: 'b', jobId: queued.job.jobId })
      assert.equal(cancelled.state, 'cancelled')
    }
    const finalQueued = runtime.startIndexing({ rootId: 'b' })
    assert.equal(finalQueued.job.state, 'queued')
    release?.()
    await waitFor(async () => (await runtime!.indexStatus({ rootId: 'a', jobId: active.job.jobId })).indexingJob?.state === 'completed')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const finalStatus = (await runtime.indexStatus({ rootId: 'b', jobId: finalQueued.job.jobId })).indexingJob!
    assert.equal(finalStatus.state, 'completed', JSON.stringify(finalStatus))
  } finally {
    release?.()
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('retry progress counts only checkpoint writes made during that attempt', async () => {
  const f = await fixture()
  let calls = 0
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    calls++
    const callNumber = calls
    if (callNumber === 2 || callNumber === 3) {
      await waitForAbort(init?.signal)
    }
    const body = JSON.parse(String(init?.body)) as { input?: string[] }
    return new Response(JSON.stringify({ data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200 })
  }
  const config = {
    ...f.config,
    limits: { timeoutMs: 5000 },
    indexing: { maxAttempts: 5, jobTimeoutMs: 30_000, retryDelayMs: 100 },
    embedding: { provider: 'openrouter', model: 'fixture-embed', dimensions: 3, secret: { kind: 'env', name: 'EMBED_KEY' } },
  }
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({ config, testDependencies: { env: { EMBED_KEY: 'fixture-key' }, fetch } })
    await runtime.indexRepository({ rootId: 'a' })
    calls = 0
    await writeFile(join(f.a, 'units.ts'), Array.from({ length: 65 }, (_, index) => `export function stage${index}() { return ${index} }`).join('\n') + '\n')
    const admission = runtime.startIndexing({ rootId: 'a' })
    await waitFor(async () => (await runtime!.indexStatus({ rootId: 'a', jobId: admission.job.jobId })).indexingJob?.state === 'failed', 20_000)
    const job = (await runtime.indexStatus({ rootId: 'a', jobId: admission.job.jobId })).indexingJob!
    assert.equal(job.attempt, 2)
    assert.equal(job.state, 'failed')
    assert.equal(job.errorCode, 'TIMEOUT')
    assert.ok(job.checkpointChunks > 0)
    assert.equal(calls, 3)
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('runtime close aborts and joins bounded index status control work', async () => {
  const f = await fixture()
  let startedResolve: (() => void) | undefined
  let release: (() => void) | undefined
  const started = new Promise<void>((resolve) => { startedResolve = resolve })
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({
      config: f.config,
      testDependencies: { beforeIndexStatus: async () => { startedResolve?.(); await new Promise<void>((resolve) => { release = resolve }) } },
    })
    const status = runtime.indexStatus({ rootId: 'a' })
    await awaitBounded(started)
    let closeDone = false
    const closing = runtime.close().then(() => { closeDone = true })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(closeDone, false)
    release?.()
    await assert.rejects(status, isCode('RUNTIME_CLOSED'))
    await closing
    runtime = undefined
  } finally {
    release?.()
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('runtime close waits for a watcher source fingerprint scan to settle', async () => {
  const f = await fixture()
  let startedResolve: (() => void) | undefined
  let release: (() => void) | undefined
  const started = new Promise<void>((resolve) => { startedResolve = resolve })
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({
      config: {
        ...f.config,
        roots: [{ id: 'a', path: f.a, watch: true, watchIntervalMs: 250 }],
      },
      testDependencies: {
        beforeSourceFingerprint: async () => {
          startedResolve?.()
          await new Promise<void>((resolve) => { release = resolve })
        },
      },
    })
    await awaitBounded(started)
    let closeDone = false
    const closing = runtime.close().then(() => { closeDone = true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(closeDone, false)
    release?.()
    await closing
    runtime = undefined
    assert.equal(closeDone, true)
  } finally {
    release?.()
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('a cancelled queued watcher callback cannot start after runtime close', async () => {
  const f = await fixture()
  let indexingStarted: (() => void) | undefined
  let fingerprintStarted: (() => void) | undefined
  let releaseFingerprint: (() => void) | undefined
  let watchSetupCalls = 0
  const indexing = new Promise<void>((resolve) => { indexingStarted = resolve })
  const fingerprint = new Promise<void>((resolve) => { fingerprintStarted = resolve })
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    indexingStarted?.()
    await new Promise<void>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
    })
    throw new Error('unreachable')
  }
  const config = {
    ...f.config,
    roots: [
      { ...f.config.roots[0]!, watch: true, watchIntervalMs: 250 },
      { id: 'b', path: f.b, watch: true, watchIntervalMs: 250 },
    ],
    indexing: { maxConcurrentRoots: 1, jobTimeoutMs: 30_000 },
    embedding: { provider: 'openrouter', model: 'fixture-embed', dimensions: 3, secret: { kind: 'env', name: 'EMBED_KEY' } },
  }
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({
      config,
      backgroundWatchStartup: true,
      testDependencies: {
        env: { EMBED_KEY: 'fixture-key' },
        fetch,
        beforeWatchSetup: async () => { watchSetupCalls++ },
        beforeSourceFingerprint: async () => {
          fingerprintStarted?.()
          await new Promise<void>((resolve) => { releaseFingerprint = resolve })
        },
      },
    })
    await awaitBounded(indexing)
    const queued = (await runtime.indexStatus({ rootId: 'b' })).indexingJob!
    assert.equal(queued.state, 'queued')
    await runtime.cancelIndexing({ rootId: 'b', jobId: queued.jobId })
    await awaitBounded(fingerprint)
    let closeDone = false
    const closing = runtime.close().then(() => { closeDone = true })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(closeDone, false)
    releaseFingerprint?.()
    await closing
    runtime = undefined
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(watchSetupCalls, 0)
  } finally {
    releaseFingerprint?.()
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('watch pauses after a permanent provider failure and resumes after explicit retry', async () => {
  const f = await fixture()
  let calls = 0
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    calls++
    if (calls === 2) return new Response(JSON.stringify({ error: { message: 'redacted' } }), { status: 401 })
    const body = JSON.parse(String(init?.body)) as { input?: string[] }
    return new Response(JSON.stringify({ data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200 })
  }
  const config = {
    ...f.config,
    roots: [{ id: 'a', path: f.a, watch: true, watchIntervalMs: 250 }, f.config.roots[1]!],
    embedding: { provider: 'openrouter', model: 'fixture-embed', dimensions: 3, secret: { kind: 'env', name: 'EMBED_KEY' } },
  }
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({ config, testDependencies: { env: { EMBED_KEY: 'fixture-key' }, fetch } })
    await writeFile(join(f.a, 'alpha.ts'), 'export const retryAfterSourceChange = true\n')
    await waitFor(async () => runtime!.watchStatus({ rootId: 'a' }).retryOnChange)
    assert.equal(runtime.watchStatus({ rootId: 'a' }).errorCode, 'PROVIDER_AUTH')
    await new Promise((resolve) => setTimeout(resolve, 700))
    assert.equal(calls, 2)
    const retry = runtime.startIndexing({ rootId: 'a' })
    await waitFor(async () => (await runtime!.indexStatus({ rootId: 'a', jobId: retry.job.jobId })).indexingJob?.state === 'completed', 5000)
    await waitFor(async () => runtime!.watchStatus({ rootId: 'a' }).errorCode === null, 5000)
    assert.equal(calls, 3)
    const result = await runtime.searchCode({ rootId: 'a', query: 'retryAfterSourceChange', mode: 'lexical' })
    assert.equal(result.hits[0]?.path, 'alpha.ts')
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('paused watcher probes the indexed source and ignores unrelated events', async () => {
  const f = await fixture()
  await mkdir(join(f.a, 'nested'))
  let calls = 0
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    calls++
    if (calls === 1) return new Response(JSON.stringify({ error: { message: 'redacted' } }), { status: 401 })
    const body = JSON.parse(String(init?.body)) as { input?: string[] }
    return new Response(JSON.stringify({ data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200 })
  }
  const config = {
    ...f.config,
    roots: [{ id: 'a', path: f.a, watch: true, watchIntervalMs: 250 }, f.config.roots[1]!],
    embedding: { provider: 'openrouter', model: 'fixture-embed', dimensions: 3, secret: { kind: 'env', name: 'EMBED_KEY' } },
  }
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({ config, backgroundWatchStartup: true, testDependencies: { env: { EMBED_KEY: 'fixture-key' }, fetch } })
    await waitFor(async () => runtime!.watchStatus({ rootId: 'a' }).retryOnChange)
    const failedJob = (await runtime.indexStatus({ rootId: 'a' })).indexingJob
    assert.equal(failedJob?.state, 'failed')
    await mkdir(join(f.a, '.git'))
    await writeFile(join(f.a, '.git', 'untracked'), 'ignored')
    await new Promise((resolve) => setTimeout(resolve, 650))
    assert.equal(calls, 1)
    await writeFile(join(f.a, 'nested', 'missed-event.ts'), 'export const recoveredFromNestedEdit = true\n')
    await waitFor(async () => calls === 2, 5000)
    const resumedJob = (await runtime.indexStatus({ rootId: 'a' })).indexingJob
    assert.ok(resumedJob)
    assert.notEqual(resumedJob.jobId, failedJob?.jobId)
    await waitFor(async () => (await runtime!.indexStatus({ rootId: 'a', jobId: resumedJob.jobId })).indexingJob?.state === 'completed', 5000)
    await waitFor(async () => runtime!.watchStatus({ rootId: 'a' }).errorCode === null, 5000)
    const result = await runtime.searchCode({ rootId: 'a', query: 'recoveredFromNestedEdit', mode: 'lexical' })
    assert.equal(result.hits[0]?.path, 'nested/missed-event.ts')
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('configured visual profile uses the isolated multimodal space and temporary caller references', async () => {
  const f = await fixture()
  const image = Uint8Array.from([1, 2, 3])
  const contentHash = createHash('sha256').update(image).digest('hex')
  const bodies: Array<Record<string, unknown>> = []
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    const embedding = Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0)
    return new Response(JSON.stringify({ model: 'voyageai/voyage-multimodal-3.5', data: [{ index: 0, embedding }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({ config: { ...f.config, mechanism: { visual: { secret: { kind: 'env', name: 'VOYAGE_VISUAL_KEY' } } } }, testDependencies: { env: { VOYAGE_VISUAL_KEY: 'fixture-only' }, fetch } })
    assert.equal(runtime.capabilities().visual, true)
    assert.equal(runtime.profiles().visual?.model, 'voyageai/voyage-multimodal-3.5')
    await assert.rejects(runtime.searchVisualReferences({
      references: [
        { id: 'valid-first', contentHash, image: { mimeType: 'image/png', dataBase64: Buffer.from(image).toString('base64') } },
        { id: 'invalid-second', contentHash: 'f'.repeat(64), image: { mimeType: 'image/png', dataBase64: Buffer.from(image).toString('base64') } },
      ],
      queryText: 'query',
    }), isCode('INVALID_REQUEST'))
    assert.equal(bodies.length, 0)
    const result = await runtime.searchVisualReferences({
      references: [{ id: 'provided-image', contentHash, image: { mimeType: 'image/png', dataBase64: Buffer.from(image).toString('base64') } }],
      queryText: 'find the supplied control',
    })
    assert.equal(result.results[0]?.reference.id, 'provided-image')
    assert.equal(result.ephemeral, true)
    assert.equal(bodies.length, 2)
    assert.equal(bodies[0]?.model, 'voyageai/voyage-multimodal-3.5')
    assert.equal('input_type' in bodies[0]!, false)
    assert.equal(JSON.stringify(result).includes('AQID'), false)
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('runtime rejects database locations inside indexed roots before creating state', async () => {
  const f = await fixture()
  const nestedExisting = join(f.a, 'already-existing')
  const rootAlias = join(f.dir, 'source-alias')
  const ancestorAlias = join(f.dir, 'workspace-alias')
  const danglingAlias = join(f.dir, 'dangling-alias')
  await mkdir(nestedExisting)
  await symlink(f.a, rootAlias, 'dir')
  await symlink(f.dir, ancestorAlias, 'dir')
  await symlink(join(f.dir, 'absent-target'), danglingAlias, 'dir')
  const notDirectory = join(f.dir, 'not-a-directory')
  await writeFile(notDirectory, 'file')

  const rejectedPaths = [
    f.a,
    join(f.a, 'not-yet-created', 'deep', 'state'),
    nestedExisting,
    join(rootAlias, 'not-yet-created', 'state'),
    join(ancestorAlias, 'root-a', 'not-yet-created', 'state'),
    f.b,
    join(danglingAlias, 'new', 'state'),
    join(notDirectory, 'new', 'state'),
  ]
  for (const dataDir of rejectedPaths) {
    await assert.rejects(
      openSearchRuntime({ config: { ...f.config, dataDir } }),
      (error: unknown) => error instanceof RuntimeConfigError && error.code === 'CONFIG_INVALID',
    )
  }
  assert.deepEqual((await readdir(f.a)).sort(), ['alpha.ts', 'already-existing'])
  assert.deepEqual(await readdir(f.b), ['beta.ts'])
  await assert.rejects(readdir(join(f.a, 'not-yet-created')))
  await assert.rejects(readdir(join(rootAlias, 'not-yet-created')))
  assert.equal(await readFile(join(f.a, 'alpha.ts'), 'utf8'), 'export function alphaFeature() { return "alpha" }\n')
  await rm(f.dir, { recursive: true, force: true })
})

test('runtime permits same-prefix sibling database directories and can reopen them', async () => {
  const f = await fixture()
  const dataDir = join(f.dir, 'root-a-sibling')
  for (let attempt = 0; attempt < 2; attempt++) {
    const runtime = await openSearchRuntime({ config: { ...f.config, dataDir } })
    await runtime.indexRepository({ rootId: 'a' })
    await runtime.close()
  }
  assert.equal(await readFile(join(f.a, 'alpha.ts'), 'utf8'), 'export function alphaFeature() { return "alpha" }\n')
  await rm(f.dir, { recursive: true, force: true })
})

test('runtime rejects a database parent of an indexed root before creating state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-runtime-ancestor-'))
  const dataDir = join(dir, 'data')
  const root = join(dataDir, 'base')
  const alias = join(dir, 'data-alias')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'sentinel.ts'), 'export const source = true\n')
  await symlink(dataDir, alias, 'dir')

  for (const candidate of [dataDir, alias]) {
    await assert.rejects(
      openSearchRuntime({
        config: { version: 1, dataDir: candidate, roots: [{ id: 'nested', path: root }] },
      }),
      (error: unknown) => error instanceof RuntimeConfigError && error.code === 'CONFIG_INVALID',
    )
  }
  assert.deepEqual(await readdir(root), ['sentinel.ts'])
  assert.equal(await readFile(join(root, 'sentinel.ts'), 'utf8'), 'export const source = true\n')
  await rm(dir, { recursive: true, force: true })
})

test('unconfigured roots reject before source access and a second owner fails closed', async () => {
  const f = await fixture()
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({ config: f.config })
    await assert.rejects(
      runtime.searchCode({ rootId: 'missing', query: 'x' }),
      (error: unknown) =>
        error instanceof SearchRuntimeError && error.code === 'ROOT_NOT_CONFIGURED',
    )
    await assert.rejects(
      openSearchRuntime({ config: f.config }),
      /SEARCH_EMBEDDED_(DIRECTORY_ALREADY_OWNED|OWNER_LOCK_EXISTS)/,
    )
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('watch is single per root, reconciles rename/delete, reports failure then recovery, and joins close', async () => {
  const f = await fixture()
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    const startupController = new AbortController()
    runtime = await openSearchRuntime({
      config: {
        ...f.config,
        roots: [
          { id: 'a', path: f.a, watch: true, watchIntervalMs: 300, limits: { maxFileBytes: 128 } },
        ],
      },
      signal: startupController.signal,
    })
    startupController.abort('startup has completed; watcher remains runtime-owned')
    await Promise.all([
      runtime.startWatcher({ rootId: 'a' }),
      runtime.startWatcher({ rootId: 'a' }),
    ])
    assert.deepEqual(runtime.watchStatus({ rootId: 'a' }), {
      enabled: true,
      active: true,
      errorCode: null,
      retryOnChange: false,
      job: null,
    })
    const before = await runtime.indexStatus({ rootId: 'a' })
    await writeFile(join(f.a, 'gamma.ts'), 'export const gammaSignal = "fresh"\n')
    const until = Date.now() + 8000
    let after = before
    while (Date.now() < until && after.fileCount < 2) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      after = await runtime.indexStatus({ rootId: 'a' })
    }
    assert.equal(after.fileCount, 2)
    await rename(join(f.a, 'alpha.ts'), join(f.a, 'renamed-alpha.ts'))
    await waitFor(
      async () =>
        (await runtime!.searchCode({ rootId: 'a', query: 'alphaFeature', mode: 'lexical' })).hits[0]
          ?.path === 'renamed-alpha.ts',
    )
    await rm(join(f.a, 'gamma.ts'))
    await waitFor(async () => (await runtime!.indexStatus({ rootId: 'a' })).fileCount === 1)
    await writeFile(join(f.a, 'oversized.ts'), 'x'.repeat(256))
    await waitFor(async () => runtime!.watchStatus({ rootId: 'a' }).errorCode !== null)
    assert.ok(runtime.watchStatus({ rootId: 'a' }).errorCode)
    await rm(join(f.a, 'oversized.ts'))
    await waitFor(async () => runtime!.watchStatus({ rootId: 'a' }).errorCode === null)
    const job = runtime.searchCode({ rootId: 'a', query: 'gammaSignal', mode: 'lexical' })
    const results = await Promise.allSettled([job, runtime.close()])
    assert.equal(results[1]?.status, 'fulfilled')
    runtime = undefined
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('secret references are bounded, file secrets require private regular files, and failures redact', async () => {
  const f = await fixture()
  const config = {
    version: 1,
    dataDir: f.dataDir,
    roots: [{ id: 'a', path: f.a }],
    embedding: {
      provider: 'openrouter',
      model: 'm',
      dimensions: 3,
      secret: { kind: 'file', file: 'secrets.json', key: 'embedding' },
    },
  }
  try {
    const secretPath = join(f.dir, 'secrets.json')
    await writeFile(secretPath, JSON.stringify({ embedding: 'fixture-secret-value' }))
    await chmod(secretPath, 0o600)
    const runtime = await openSearchRuntime({ config, configDir: f.dir })
    await runtime.close()
    await chmod(secretPath, 0o644)
    if (process.platform === 'win32') {
      const windowsAclRuntime = await openSearchRuntime({ config, configDir: f.dir })
      await windowsAclRuntime.close()
    } else {
      await assert.rejects(
        openSearchRuntime({ config, configDir: f.dir }),
        (error: unknown) =>
          error instanceof RuntimeConfigError && error.code === 'SECRET_FILE_INVALID',
      )
    }
    await chmod(secretPath, 0o600)
    await rm(secretPath)
    await symlink(join(f.dir, 'absent.json'), secretPath)
    await assert.rejects(
      openSearchRuntime({ config, configDir: f.dir }),
      (error: unknown) =>
        error instanceof RuntimeConfigError && error.code === 'SECRET_FILE_INVALID',
    )
    await rm(secretPath)
    await writeFile(secretPath, 'x'.repeat(65 * 1024))
    await chmod(secretPath, 0o600)
    await assert.rejects(
      openSearchRuntime({ config, configDir: f.dir }),
      (error: unknown) =>
        error instanceof RuntimeConfigError && error.code === 'SECRET_FILE_INVALID',
    )
    await assert.rejects(
      openSearchRuntime({
        config: {
          ...config,
          embedding: { ...config.embedding, secret: { kind: 'env', name: 'ABSENT_TEST_KEY' } },
        },
        configDir: f.dir,
      }),
      (error: unknown) =>
        error instanceof RuntimeConfigError && error.code === 'SECRET_UNAVAILABLE',
    )
    await writeFile(join(f.dir, 'runtime.json'), JSON.stringify(config))
    await chmod(join(f.dir, 'runtime.json'), 0o600)
    assert.equal((await loadRuntimeConfig(join(f.dir, 'runtime.json'))).config.version, 1)
    await assert.rejects(
      loadRuntimeConfig(secretPath),
      (error: unknown) =>
        error instanceof RuntimeConfigError && error.code === 'CONFIG_FILE_INVALID',
    )
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

function isCode(code: string) {
  return (error: unknown) => error instanceof SearchRuntimeError && error.code === code
}
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch {
      /* промежуточное поколение может быть stale */
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail('bounded predicate did not become true')
}

async function awaitBounded<T>(promise: Promise<T>, timeoutMs = 8000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('test gate timed out')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

test('startup failure preserves a foreign ownership lock and root replacement fails closed', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.dataDir, '.zorya-search-owner'), '{"foreign":true}')
    await assert.rejects(openSearchRuntime({ config: f.config }))
    assert.equal(
      await (
        await import('node:fs/promises')
      ).readFile(join(f.dataDir, '.zorya-search-owner'), 'utf8'),
      '{"foreign":true}',
    )
    await rm(join(f.dataDir, '.zorya-search-owner'))
    const runtime = await openSearchRuntime({
      config: { ...f.config, roots: [{ id: 'a', path: f.a }] },
    })
    await runtime.indexRepository({ rootId: 'a' })
    const moved = `${f.a}-moved`
    await rename(f.a, moved)
    await mkdir(f.a)
    await writeFile(join(f.a, 'replacement.ts'), 'export const replacement = true\n')
    await assert.rejects(
      runtime.searchCode({ rootId: 'a', query: 'replacement', mode: 'lexical' }),
      (error: unknown) => error instanceof SearchRuntimeError && error.code === 'ROOT_CHANGED',
    )
    await runtime.close()
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('watcher rejects a replaced configured root and close releases its owner', async () => {
  const f = await fixture()
  let providerCalls = 0
  let fingerprintScans = 0
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    providerCalls++
    const body = JSON.parse(String(init?.body)) as { input?: string[] }
    return new Response(JSON.stringify({ data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0] })) }), { status: 200 })
  }
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    const config = {
      ...f.config,
      roots: [{ id: 'a', path: f.a, watch: true, watchIntervalMs: 300 }],
      embedding: { provider: 'openrouter', model: 'fixture-embed', dimensions: 3, secret: { kind: 'env', name: 'EMBED_KEY' } },
    }
    runtime = await openSearchRuntime({
      config,
      testDependencies: {
        env: { EMBED_KEY: 'fixture-key' },
        fetch,
        beforeSourceFingerprint: async () => { fingerprintScans++ },
      },
    })
    assert.equal(providerCalls, 1)
    const moved = `${f.a}-moved`
    await rename(f.a, moved)
    await mkdir(f.a)
    await writeFile(join(f.a, 'replacement.ts'), 'export const replacement = true\n')
    await waitFor(async () => runtime!.watchStatus({ rootId: 'a' }).errorCode === 'ROOT_CHANGED')
    assert.equal(runtime.watchStatus({ rootId: 'a' }).errorCode, 'ROOT_CHANGED')
    assert.equal(providerCalls, 1)
    assert.equal(fingerprintScans, 0)
    await runtime.close()
    runtime = undefined
    const reopened = await openSearchRuntime({
      config: { ...config, roots: [{ id: 'a', path: moved }] },
      testDependencies: { env: { EMBED_KEY: 'fixture-key' }, fetch },
    })
    await reopened.close()
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('startup cancellation during watcher setup joins setup and releases the embedded owner', async () => {
  const f = await fixture()
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    const config = {
      ...f.config,
      roots: [{ id: 'a', path: f.a, watch: true, watchIntervalMs: 300 }],
    }
    const controller = new AbortController()
    let reached: (() => void) | undefined, release: (() => void) | undefined
    const setupReached = new Promise<void>((resolve) => {
      reached = resolve
    })
    const setupGate = new Promise<void>((resolve) => {
      release = resolve
    })
    let settled = false
    const opening = openSearchRuntime({
      config,
      signal: controller.signal,
      testDependencies: {
        beforeWatchSetup: async () => {
          reached?.()
          await setupGate
        },
      },
    }).finally(() => {
      settled = true
    })
    await awaitBounded(setupReached)
    controller.abort({ arbitrary: 'startup cancellation' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(settled, false)
    release?.()
    await assert.rejects(
      opening,
      (error: unknown) => error instanceof SearchRuntimeError && error.code === 'CANCELLED',
    )
    const reopened = await openSearchRuntime({
      config: { ...config, roots: [{ id: 'a', path: f.a }] },
    })
    await reopened.close()
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('startup cancellation after DB acquisition closes the owner before returning', async () => {
  const f = await fixture()
  let release: (() => void) | undefined
  try {
    const controller = new AbortController()
    let reached: (() => void) | undefined
    const acquired = new Promise<void>((resolve) => {
      reached = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const opening = openSearchRuntime({
      config: f.config,
      signal: controller.signal,
      testDependencies: {
        beforeDatabaseReady: async () => {
          reached?.()
          await gate
        },
      },
    })
    await awaitBounded(acquired)
    controller.abort({ startup: 'cancelled after embedded owner acquisition' })
    release?.()
    await assert.rejects(opening, isCode('CANCELLED'))
    const reopened = await openSearchRuntime({ config: f.config })
    await reopened.close()
  } finally {
    release?.()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('bounded regular-file reader handles deterministic short reads without parsing a prefix', async () => {
  const f = await fixture()
  try {
    const contents = JSON.stringify({
      version: 1,
      dataDir: f.dataDir,
      roots: [{ id: 'a', path: f.a }],
    })
    const path = join(f.dir, 'short-read-config.json')
    await writeFile(path, contents)
    assert.equal(await readBoundedRegularFile(path, 4096, false, 3), contents)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('watch setup deadline aborts the pending setup and waits for physical settlement', async () => {
  const f = await fixture()
  let release: (() => void) | undefined
  try {
    const baseline = await openSearchRuntime({ config: f.config })
    await baseline.indexRepository({ rootId: 'a' })
    await baseline.close()
    const config = {
      ...f.config,
      roots: [{ id: 'a', path: f.a, watch: true, watchIntervalMs: 300 }],
      limits: { timeoutMs: 2000 },
    }
    let reached: (() => void) | undefined, aborted: (() => void) | undefined
    const setupReached = new Promise<void>((resolve) => {
      reached = resolve
    })
    const setupAborted = new Promise<void>((resolve) => {
      aborted = resolve
    })
    const setupGate = new Promise<void>((resolve) => {
      release = resolve
    })
    let settled = false
    const opening = openSearchRuntime({
      config,
      testDependencies: {
        beforeWatchSetup: async (signal) => {
          reached?.()
          signal.addEventListener('abort', () => aborted?.(), { once: true })
          await setupGate
        },
      },
    }).finally(() => {
      settled = true
    })
    await awaitBounded(setupReached)
    await awaitBounded(setupAborted)
    assert.equal(settled, false)
    release?.()
    await assert.rejects(opening, isCode('TIMEOUT'))
    const reopened = await openSearchRuntime({
      config: { ...f.config, roots: [{ id: 'a', path: f.a }] },
    })
    await reopened.close()
  } finally {
    release?.()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('context and classifier preserve valid, pre-aborted and in-flight signals; close joins abort-ignoring provider work', async () => {
  const f = await fixture()
  let embeddingCalls = 0,
    classifierCalls = 0
  let holdQuery = '',
    releaseQuery: (() => void) | undefined,
    queryStarted: (() => void) | undefined
  let holdClassifier = false,
    releaseClassifier: (() => void) | undefined,
    classifierStarted: (() => void) | undefined
  let observedClassifierAbort = false,
    failClassifierStatus: number | undefined,
    hostileClassifierError: string | undefined
  const fakeFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input),
      body = JSON.parse(String(init?.body)) as {
        input?: string[]
        messages?: Array<{ role: string; content: string }>
      }
    if (url.endsWith('/embeddings')) {
      embeddingCalls++
      const query = body.input?.[0] ?? ''
      if (query === holdQuery) {
        queryStarted?.()
        await new Promise<void>((resolve) => {
          releaseQuery = resolve
        })
      }
      return new Response(
        JSON.stringify({
          data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0] })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    classifierCalls++
    if (hostileClassifierError) throw new Error(hostileClassifierError)
    const signal = init?.signal
    if (holdClassifier) {
      classifierStarted?.()
      signal?.addEventListener(
        'abort',
        () => {
          observedClassifierAbort = true
        },
        { once: true },
      )
      await new Promise<void>((resolve) => {
        releaseClassifier = resolve
      })
    }
    if (failClassifierStatus)
      return new Response('FIXTURESECRET-DO-NOT-LEAK', {
        status: failClassifierStatus,
        headers: { 'content-type': 'text/plain' },
      })
    const user = body.messages?.find((message) => message.role === 'user')
    const payload = user
      ? (JSON.parse(user.content) as { labels: string[] })
      : { labels: ['yes', 'no'] }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                labels: [{ label: payload.labels[0], confidence: 0.8, evidence: ['fixture'] }],
                abstained: false,
                uncertainty: [],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  const config = {
    version: 1,
    dataDir: f.dataDir,
    roots: [{ id: 'a', path: f.a }],
    embedding: {
      provider: 'openrouter',
      profileId: 'owner-embedding-profile',
      model: 'fixture-embed',
      dimensions: 3,
      secret: { kind: 'env', name: 'EMBED_KEY' },
    },
    classifier: {
      profileId: 'owner-classifier-profile',
      model: 'fixture-classifier',
      secret: { kind: 'env', name: 'CLASSIFY_KEY' },
    },
  }
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({
      config,
      testDependencies: {
        env: { EMBED_KEY: 'fixture-embedding-secret', CLASSIFY_KEY: 'fixture-classifier-secret' },
        fetch: fakeFetch,
      },
    })
    assert.equal(runtime.profiles().embedding?.profileId, 'owner-embedding-profile')
    assert.equal(runtime.profiles().classification?.provider, 'owner-classifier-profile')
    await runtime.indexRepository({ rootId: 'a' })
    const validContextController = new AbortController()
    const context = await runtime.getCodeContext({
      rootId: 'a',
      query: 'alphaFeature',
      signal: validContextController.signal,
    })
    assert.equal(context.sections[0]?.path, 'alpha.ts')
    const featureQueries = ['alphaFeature']
    const mutableContextCall = runtime.getCodeContext({
      rootId: 'a',
      query: 'noPrimaryMatch',
      featureQueries,
    })
    featureQueries[0] = 'mutatedAfterCall'
    assert.equal((await mutableContextCall).sections[0]?.path, 'alpha.ts')
    const beforePreAbort = embeddingCalls
    const preAborted = new AbortController()
    preAborted.abort('arbitrary caller reason')
    await assert.rejects(
      runtime.getCodeContext({ rootId: 'a', query: 'alphaFeature', signal: preAborted.signal }),
      isCode('CANCELLED'),
    )
    assert.equal(embeddingCalls, beforePreAbort)

    holdQuery = 'midflight-context'
    const contextStarted = new Promise<void>((resolve) => {
      queryStarted = resolve
    })
    const contextAbort = new AbortController()
    const contextPending = runtime.getCodeContext({
      rootId: 'a',
      query: holdQuery,
      signal: contextAbort.signal,
    })
    await awaitBounded(contextStarted)
    contextAbort.abort({ arbitrary: 'reason' })
    releaseQuery?.()
    await assert.rejects(contextPending, isCode('CANCELLED'))
    holdQuery = ''

    const labels = ['yes', 'no']
    const validClassifyPending = runtime.classify({
      text: 'fixture text',
      labels,
      criteria: 'Choose supported label',
      signal: new AbortController().signal,
    })
    labels[0] = 'mutated-after-call'
    const validClassify = await validClassifyPending
    assert.equal(validClassify.labels[0]?.label, 'yes')
    assert.equal(runtime.usage().classification?.calls, 1)
    failClassifierStatus = 401
    await assert.rejects(
      runtime.classify({
        text: 'fixture text',
        labels: ['yes', 'no'],
        criteria: 'Choose supported label',
      }),
      (error: unknown) =>
        error instanceof SearchRuntimeError &&
        error.code === 'PROVIDER_AUTH' &&
        error.status === 401 &&
        !error.message.includes('FIXTURESECRET'),
    )
    failClassifierStatus = undefined
    hostileClassifierError = 'API_KEY=UPPERCASE_FIXTURE_SECRET'
    await assert.rejects(
      runtime.classify({
        text: 'fixture text',
        labels: ['yes', 'no'],
        criteria: 'Choose supported label',
      }),
      (error: unknown) =>
        error instanceof SearchRuntimeError &&
        error.code === 'PROVIDER_UNAVAILABLE' &&
        !error.message.includes('UPPERCASE_FIXTURE_SECRET') &&
        !JSON.stringify(error).includes('UPPERCASE_FIXTURE_SECRET'),
    )
    hostileClassifierError = undefined
    const classifierCount = classifierCalls
    const classifyPreAbort = new AbortController()
    classifyPreAbort.abort('cancel')
    await assert.rejects(
      runtime.classify({
        text: 'fixture text',
        labels: ['yes', 'no'],
        criteria: 'Choose supported label',
        signal: classifyPreAbort.signal,
      }),
      isCode('CANCELLED'),
    )
    assert.equal(classifierCalls, classifierCount)

    holdClassifier = true
    const classifierGate = new Promise<void>((resolve) => {
      classifierStarted = resolve
    })
    const classifyAbort = new AbortController()
    const classifyPending = runtime.classify({
      text: 'fixture text',
      labels: ['yes', 'no'],
      criteria: 'Choose supported label',
      signal: classifyAbort.signal,
    })
    await awaitBounded(classifierGate)
    classifyAbort.abort({ arbitrary: 'reason' })
    releaseClassifier?.()
    await assert.rejects(classifyPending, isCode('CANCELLED'))

    classifierStarted = undefined
    releaseClassifier = undefined
    observedClassifierAbort = false
    const closeGate = new Promise<void>((resolve) => {
      classifierStarted = resolve
    })
    const closePending = runtime.classify({
      text: 'fixture text',
      labels: ['yes', 'no'],
      criteria: 'Choose supported label',
    })
    await closeGate
    let closeOneDone = false,
      closeTwoDone = false
    const closeOne = runtime.close().then(() => {
      closeOneDone = true
    })
    const closeTwo = runtime.close().then(() => {
      closeTwoDone = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(observedClassifierAbort, true)
    assert.equal(closeOneDone, false)
    assert.equal(closeTwoDone, false)
    releaseClassifier?.()
    await assert.rejects(closePending, isCode('RUNTIME_CLOSED'))
    await Promise.all([closeOne, closeTwo])
    runtime = undefined
  } finally {
    releaseQuery?.()
    releaseClassifier?.()
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('close aborts a delayed embedding job, joins physical completion and prevents snapshot publication', async () => {
  const f = await fixture()
  let startedResolve: (() => void) | undefined, release: (() => void) | undefined
  let observedAbort = false
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve
  })
  const fakeFetch: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    init?.signal?.addEventListener(
      'abort',
      () => {
        observedAbort = true
      },
      { once: true },
    )
    startedResolve?.()
    await new Promise<void>((resolve) => {
      release = resolve
    })
    const body = JSON.parse(String(init?.body)) as { input?: string[] }
    return new Response(
      JSON.stringify({
        data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0] })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  const config = {
    ...f.config,
    embedding: {
      provider: 'openrouter',
      model: 'fixture-embed',
      dimensions: 3,
      secret: { kind: 'env', name: 'EMBED_KEY' },
    },
  }
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({
      config,
      testDependencies: { env: { EMBED_KEY: 'fixture-key' }, fetch: fakeFetch },
    })
    const indexJob = runtime.indexRepository({ rootId: 'a' })
    await awaitBounded(started)
    let doneOne = false,
      doneTwo = false
    const closeOne = runtime.close().then(() => {
      doneOne = true
    })
    const closeTwo = runtime.close().then(() => {
      doneTwo = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(observedAbort, true)
    assert.equal(doneOne, false)
    assert.equal(doneTwo, false)
    release?.()
    await assert.rejects(indexJob, isCode('RUNTIME_CLOSED'))
    await Promise.all([closeOne, closeTwo])
    runtime = undefined
    const offline = await openSearchRuntime({ config: f.config })
    assert.equal((await offline.indexStatus({ rootId: 'a' })).identity, null)
    await offline.close()
  } finally {
    release?.()
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('missing configured credentials fail before DB ownership or any provider fetch', async () => {
  const f = await fixture()
  let requests = 0
  const fakeFetch: typeof fetch = (async () => {
    requests++
    return new Response('{}')
  }) as typeof fetch
  try {
    const config = {
      ...f.config,
      embedding: {
        provider: 'openrouter',
        profileId: 'profile-x',
        model: 'fixture',
        dimensions: 3,
        secret: { kind: 'env', name: 'MISSING_EMBED_SECRET_20261031' },
      },
    }
    await assert.rejects(
      openSearchRuntime({ config, testDependencies: { fetch: fakeFetch, env: {} } }),
      (error: unknown) =>
        error instanceof RuntimeConfigError && error.code === 'SECRET_UNAVAILABLE',
    )
    assert.equal(requests, 0)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('startup watcher-index failure unwinds DB owner and leaves later open possible', async () => {
  const f = await fixture()
  try {
    const broken = {
      ...f.config,
      roots: [{ id: 'a', path: f.a, watch: true, limits: { maxFileBytes: 1 } }],
    }
    await assert.rejects(
      openSearchRuntime({ config: broken }),
      (error: unknown) =>
        error instanceof SearchRuntimeError && error.code === 'CODE_INDEX_FILE_SIZE_LIMIT',
    )
    const recovered = await openSearchRuntime({
      config: { ...f.config, roots: [{ id: 'a', path: f.a }] },
    })
    assert.equal((await recovered.indexStatus({ rootId: 'a' })).identity, null)
    await recovered.close()
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('web reranker capability remains independent of code embedding', async () => {
  const f = await fixture()
  let rerankCalls = 0
  const discoveredRanges: Array<{ from: string; through: string } | undefined> = []
  const fakeFetch: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { documents?: string[] }
    rerankCalls++
    return new Response(
      JSON.stringify({
        results: (request.documents ?? []).map((_, index) => ({ index, relevance_score: 0.9 })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  try {
    const config = {
      ...f.config,
      reranker: {
        profileId: 'owner-rerank-profile',
        model: 'fixture-reranker',
        secret: { kind: 'env', name: 'RERANK_KEY' },
      },
      web: { discovery: { secret: { kind: 'env', name: 'BRAVE_KEY' } } },
    }
    const runtime = await openSearchRuntime({
      config,
      testDependencies: {
        env: { RERANK_KEY: 'fixture-reranker-key', BRAVE_KEY: 'fixture-brave-key' },
        fetch: fakeFetch,
        webSource: {
          async discover(_query, _target, _signal, options) {
            discoveredRanges.push(options?.dateRange)
            return ['https://docs.example.test/alpha']
          },
          async fetchDocument(url) {
            return {
              url,
              title: 'Alpha guide',
              text: 'alpha retrieval fixture content',
              fetchedAt: new Date().toISOString(),
              publishedAt: null,
              sourceUpdatedAt: null,
            }
          },
        },
      },
    })
    assert.equal(runtime.capabilities().embedding, false)
    assert.equal(runtime.capabilities().codeReranking, false)
    assert.equal(runtime.capabilities().webReranking, true)
    assert.equal(runtime.profiles().reranking?.model, 'fixture-reranker')
    assert.equal(runtime.profiles().reranking?.profileId, 'owner-rerank-profile')
    const dateRange = { from: '2025-01-01', through: '2025-01-31' }
    const results = await runtime.searchWeb({ query: 'alpha retrieval', dateRange })
    assert.deepEqual(discoveredRanges, [dateRange])
    assert.deepEqual(dateRange, { from: '2025-01-01', through: '2025-01-31' })
    assert.equal(rerankCalls, 1)
    assert.equal(results.rankingMode, 'lexical-reranked')
    assert.equal(runtime.usage().reranking?.calls, 1)
    await runtime.close()
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('legacy code embedding does not report web embedding without configured discovery', async () => {
  const f = await fixture()
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({
      config: {
        ...f.config,
        embedding: {
          provider: 'openrouter',
          model: 'legacy-code-model',
          dimensions: 3,
          secret: { kind: 'env', name: 'LEGACY_EMBED_KEY' },
        },
      },
      testDependencies: { env: { LEGACY_EMBED_KEY: 'fixture-only' } },
    })
    assert.equal(runtime.capabilities().embedding, true)
    assert.equal(runtime.capabilities().webEmbedding, false)
    assert.equal(runtime.profiles().webEmbedding, null)
    await assert.rejects(runtime.searchWeb({ query: 'unavailable without discovery' }), isCode('CAPABILITY_DISABLED'))
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('default owner web text profile routes to OpenRouter and uses the supplied model', async () => {
  const f = await fixture()
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push({ url: String(input), body })
    const texts = body.input as string[]
    return new Response(JSON.stringify({
      model: 'fixture-openrouter-web-model',
      data: texts.map((_, index) => ({ index, embedding: index === 0 ? [1, 0, 0] : [0.9, 0.1, 0] })),
      usage: { prompt_tokens: 3, total_tokens: 3 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const { createSetupConfig } = await import('../../src/cli/setup-config.js')
  const config = createSetupConfig({
    dataDir: f.dataDir,
    root: { id: 'a', path: f.a },
    webEnv: 'BRAVE_KEY',
    webEmbedding: {
      model: 'fixture-openrouter-web-model',
      dimensions: 3,
      env: 'WEB_TEXT_KEY',
    },
  })
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({
      config,
      testDependencies: {
        env: { BRAVE_KEY: 'fixture-brave-key', WEB_TEXT_KEY: 'fixture-web-key' },
        fetch,
        webSource: {
          async discover() { return ['https://docs.example.test/alpha'] },
          async fetchDocument(url) {
            return {
              url,
              title: 'Alpha guide',
              text: 'alpha retrieval fixture content',
              fetchedAt: new Date().toISOString(),
              publishedAt: null,
              sourceUpdatedAt: null,
            }
          },
        },
      },
    })
    assert.equal(runtime.capabilities().webEmbedding, true)
    assert.equal(runtime.profiles().webEmbedding?.provider, 'openrouter')
    assert.equal(runtime.profiles().webEmbedding?.model, 'fixture-openrouter-web-model')
    const result = await runtime.searchWeb({ query: 'alpha retrieval' })
    assert.equal(result.rankingMode, 'hybrid')
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.url, 'https://openrouter.ai/api/v1/embeddings')
    assert.equal(requests[0]?.body.model, 'fixture-openrouter-web-model')
    assert.equal(requests[0]?.body.input_type, 'text')
    assert.equal(runtime.usage().webEmbedding?.calls, 1)
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('owner-configured web text embedding stays isolated from the Mechanism code preset', async () => {
  const f = await fixture()
  const configDir = join(f.dir, 'owner-config')
  await mkdir(configDir, { mode: 0o700 })
  await writeFile(join(configDir, 'secrets.json'), JSON.stringify({ webText: 'web-text-fixture' }), { mode: 0o600 })
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
  const fakeFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push({ url: String(input), headers: new Headers(init?.headers), body })
    const texts = body.input as string[]
    return new Response(JSON.stringify({
      model: 'owner-web-text-model',
      data: texts.map((_, index) => ({ index, embedding: index === 0 ? [1, 0, 0] : [0.9, 0.1, 0] })),
      usage: { prompt_tokens: 3, total_tokens: 3 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const { createSetupConfig } = await import('../../src/cli/setup-config.js')
  const config = createSetupConfig({
    dataDir: f.dataDir,
    root: { id: 'a', path: f.a },
    codeEnv: 'VOYAGE_CODE_KEY',
    webEnv: 'BRAVE_KEY',
    webEmbedding: {
      profileId: 'owner-web-text-profile',
      model: 'owner-web-text-model',
      dimensions: 3,
      baseUrl: 'https://embeddings.example.test/v1',
      env: 'WEB_TEXT_KEY',
    },
  })
  const runtimeConfig = structuredClone(config) as {
    web: { embedding: { secret: unknown } }
  }
  runtimeConfig.web.embedding.secret = {
    kind: 'file',
    file: 'secrets.json',
    key: 'webText',
  }
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({
      config: runtimeConfig,
      configDir,
      testDependencies: {
        env: { VOYAGE_CODE_KEY: 'code-only-fixture', BRAVE_KEY: 'brave-fixture' },
        fetch: fakeFetch,
        webSource: {
          async discover() { return ['https://docs.example.test/alpha'] },
          async fetchDocument(url) {
            return {
              url,
              title: 'Alpha guide',
              text: 'alpha retrieval fixture content',
              fetchedAt: new Date().toISOString(),
              publishedAt: null,
              sourceUpdatedAt: null,
            }
          },
        },
      },
    })
    assert.equal(runtime.capabilities().embedding, true)
    assert.equal(runtime.capabilities().webEmbedding, true)
    assert.equal(runtime.profiles().codeEmbedding?.model, 'voyageai/voyage-code-4')
    assert.equal(runtime.profiles().webEmbedding?.profileId, 'owner-web-text-profile')
    assert.equal(runtime.profiles().webEmbedding?.model, 'owner-web-text-model')

    const result = await runtime.searchWeb({ query: 'alpha retrieval' })
    assert.equal(result.rankingMode, 'hybrid')
    assert.ok(result.passages[0]?.ranking.embeddingProfile?.includes('owner-web-text-profile'))
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.url, 'https://embeddings.example.test/v1/embeddings')
    assert.equal(requests[0]?.headers.get('authorization'), 'Bearer web-text-fixture')
    assert.equal(requests[0]?.body.model, 'owner-web-text-model')
    assert.equal(requests[0]?.body.input_type, 'text')
    assert.equal(runtime.usage().webEmbedding?.calls, 1)
    assert.equal(runtime.usage().codeEmbedding?.calls, 0)
    assert.equal(runtime.usage().embedding?.calls, 0)
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})
