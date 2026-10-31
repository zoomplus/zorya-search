import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, writeFile, chmod, rename, symlink, readFile } from 'node:fs/promises'
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
})

test('offline PGlite runtime indexes isolated roots, preserves provenance, and reopens', async () => {
  const f = await fixture()
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({ config: f.config })
    assert.deepEqual(runtime.capabilities(), {
      code: true,
      embedding: false,
      codeReranking: false,
      webReranking: false,
      webRead: false,
      webDiscovery: false,
      classification: false,
      visual: false,
    })
    await runtime.indexRepository({ rootId: 'a' })
    await runtime.indexRepository({ rootId: 'b' })
    const result = await runtime.searchCode({ rootId: 'a', query: 'alphaFeature', mode: 'lexical' })
    assert.equal(result.hits[0]?.path, 'alpha.ts')
    assert.equal(result.identity.root, f.a)
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
    await assert.rejects(
      openSearchRuntime({ config, configDir: f.dir }),
      (error: unknown) =>
        error instanceof RuntimeConfigError && error.code === 'SECRET_FILE_INVALID',
    )
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
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    const config = {
      ...f.config,
      roots: [{ id: 'a', path: f.a, watch: true, watchIntervalMs: 300 }],
    }
    runtime = await openSearchRuntime({ config })
    const moved = `${f.a}-moved`
    await rename(f.a, moved)
    await mkdir(f.a)
    await writeFile(join(f.a, 'replacement.ts'), 'export const replacement = true\n')
    await waitFor(async () => runtime!.watchStatus({ rootId: 'a' }).errorCode === 'ROOT_CHANGED')
    assert.equal(runtime.watchStatus({ rootId: 'a' }).errorCode, 'ROOT_CHANGED')
    await runtime.close()
    runtime = undefined
    const reopened = await openSearchRuntime({
      config: { ...config, roots: [{ id: 'a', path: moved }] },
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
          async discover() {
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
    const results = await runtime.searchWeb({ query: 'alpha retrieval' })
    assert.equal(rerankCalls, 1)
    assert.equal(results.rankingMode, 'lexical-reranked')
    assert.equal(runtime.usage().reranking?.calls, 1)
    await runtime.close()
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})
