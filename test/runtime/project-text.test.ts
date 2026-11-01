import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openSearchRuntime, parseRuntimeConfig, RuntimeConfigError, SearchRuntimeError } from '../../src/runtime/index.js'
import { PROJECT_TEXT_RETRIEVAL_PRESET } from '../../src/providers/voyage.js'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-project-text-runtime-'))
  const root = join(dir, 'root')
  await mkdir(root)
  await mkdir(join(dir, 'state'))
  await writeFile(join(root, 'alpha.ts'), 'export const alphaRuntimeMarker = true\n')
  await writeFile(join(root, 'README.md'), '# Runtime guide\n\nProject text has a separate index.\n')
  return {
    dir,
    root,
    config: {
      version: 1,
      dataDir: join(dir, 'state'),
      roots: [{ id: 'repo', path: root }],
    },
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error('WAIT_FOR_TIMEOUT')
}

function isCode(code: string) {
  return (error: unknown) => error instanceof SearchRuntimeError && error.code === code
}

test('project text is opt-in, explicit, and keeps strict config and source-read boundaries', async () => {
  const f = await fixture()
  let disabled: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    assert.equal(parseRuntimeConfig(f.config).projectText, undefined)
    assert.deepEqual(parseRuntimeConfig({ ...f.config, projectText: {} }).projectText, {})
    assert.throws(() => parseRuntimeConfig({ ...f.config, projectText: { unexpected: true } }), RuntimeConfigError)

    disabled = await openSearchRuntime({ config: f.config })
    assert.equal(disabled.capabilities().projectText, false)
    await assert.rejects(disabled.projectTextStatus({ rootId: 'repo' }), isCode('CAPABILITY_DISABLED'))
    await assert.rejects(disabled.searchProjectText({ rootId: 'repo', query: 'guide' }), isCode('CAPABILITY_DISABLED'))
    await disabled.close()
    disabled = undefined

    runtime = await openSearchRuntime({ config: { ...f.config, projectText: {} } })
    assert.equal(runtime.capabilities().projectText, true)
    assert.equal(runtime.capabilities().projectTextEmbedding, false)
    assert.equal(runtime.profiles().projectTextEmbedding, null)
    assert.equal(runtime.usage().projectTextEmbedding, null)
    assert.equal((await runtime.projectTextStatus({ rootId: 'repo' })).snapshotId, null)
    await assert.rejects(runtime.searchProjectText({ rootId: 'repo', query: 'guide' }), isCode('PROJECT_TEXT_NOT_INDEXED'))

    const codeStatus = await runtime.indexRepository({ rootId: 'repo' })
    const textStatus = await runtime.projectTextStatus({ rootId: 'repo' })
    assert.equal(codeStatus.identity?.snapshotId !== undefined, true)
    assert.equal(textStatus.stale, false)
    const search = await runtime.searchProjectText({
      rootId: 'repo',
      query: 'separate index',
      kinds: ['documentation'],
      mode: 'lexical',
    })
    assert.equal(search.hits[0]?.path, 'README.md')
    const source = await runtime.readProjectText({
      rootId: 'repo',
      path: 'README.md',
      snapshotId: textStatus.snapshotId!,
      lineStart: 1,
      lineEnd: 3,
    })
    assert.equal(source.text, '# Runtime guide\n\nProject text has a separate index.')

    await assert.rejects(runtime.searchProjectText({ rootId: 'repo', query: 'guide', kinds: ['rules', 'rules'] }), isCode('INVALID_REQUEST'))
    await assert.rejects(runtime.readProjectText({ rootId: 'repo', path: 'README.md', lineStart: 1, lineEnd: 201 }), isCode('INVALID_REQUEST'))
    await assert.rejects(runtime.readProjectText({ rootId: 'repo', path: 'alpha.ts' }), isCode('PROJECT_TEXT_PATH_NOT_INDEXED'))
    await writeFile(join(f.root, 'README.md'), '# Runtime guide\n\nChanged source.\n')
    await assert.rejects(runtime.searchProjectText({ rootId: 'repo', query: 'Changed', mode: 'lexical' }), isCode('PROJECT_TEXT_SOURCE_CHANGED'))
  } finally {
    await runtime?.close()
    await disabled?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('runtime constructs separate text embedding roles, bounds provider batches, and reranks hybrid results', async () => {
  const f = await fixture()
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push({ url, body })
    if (url.endsWith('/rerank'))
      return new Response(
        JSON.stringify({
          model: 'rerank-2.5-lite',
          results: [{ index: 0, relevance_score: 0.9 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    const texts = body.input as string[]
    const vector = Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0))
    return new Response(
      JSON.stringify({
        model: 'voyage-4-large',
        data: texts.map((_, index) => ({ index, embedding: vector })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  const runtimeConfig = {
    ...f.config,
    projectText: {
      embedding: {
        provider: 'openrouter',
        model: PROJECT_TEXT_RETRIEVAL_PRESET.embedding.model,
        dimensions: PROJECT_TEXT_RETRIEVAL_PRESET.embedding.dimensions,
        secret: { kind: 'env', name: 'TEXT_KEY' },
        limits: { maxItems: 1 },
      },
      reranker: {
        model: PROJECT_TEXT_RETRIEVAL_PRESET.reranker.model,
        secret: { kind: 'env', name: 'TEXT_KEY' },
      },
    },
  }
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({
      config: runtimeConfig,
      testDependencies: { env: { TEXT_KEY: 'fixture-only' }, fetch },
    })
    assert.equal(runtime.capabilities().projectTextEmbedding, true)
    assert.equal(runtime.capabilities().projectTextReranking, true)
    assert.equal(runtime.capabilities().embedding, false)
    assert.equal(runtime.profiles().projectTextEmbedding?.model, 'voyageai/voyage-4-large')
    assert.equal(runtime.profiles().projectTextEmbedding?.inputType, 'document')
    assert.equal(runtime.profiles().projectTextQueryEmbedding?.inputType, 'query')
    assert.notEqual(runtime.profiles().projectTextEmbedding?.space, runtime.profiles().projectTextQueryEmbedding?.space)

    await runtime.indexRepository({ rootId: 'repo' })
    const result = await runtime.searchProjectText({
      rootId: 'repo',
      query: 'separate text index',
      mode: 'hybrid',
      limit: 1,
    })
    assert.equal(result.hits[0]?.path, 'README.md')
    assert.equal(result.rerank?.status, 'complete')
    const embeddingRequests = requests.filter((request) => request.url.endsWith('/embeddings'))
    assert.ok(embeddingRequests.every((request) => (request.body.input as string[]).length <= 1))
    assert.ok(embeddingRequests.some((request) => request.body.input_type === 'document'))
    assert.ok(embeddingRequests.some((request) => request.body.input_type === 'query'))
    assert.ok(embeddingRequests.every((request) => request.body.model === 'voyageai/voyage-4-large'))
    const rerank = requests.find((request) => request.url.endsWith('/rerank'))
    assert.equal(rerank?.body.model, 'voyageai/rerank-2.5-lite')
    assert.equal(rerank?.body.top_n, 1)
    assert.ok((runtime.usage().projectTextEmbedding?.calls ?? 0) > 0)
    assert.equal(runtime.usage().projectTextQueryEmbedding?.calls, 1)
    assert.equal(runtime.usage().projectTextReranking?.calls, 1)
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('watch fingerprints include text-only files and retain the code snapshot', async () => {
  const f = await fixture()
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({
      config: {
        ...f.config,
        roots: [{ id: 'repo', path: f.root, watch: true, watchIntervalMs: 250 }],
        projectText: {},
      },
      backgroundWatchStartup: true,
    })
    await waitFor(async () => (await runtime!.projectTextStatus({ rootId: 'repo' })).snapshotId !== null)
    const initialCode = await runtime.indexStatus({ rootId: 'repo' })
    const initialText = await runtime.projectTextStatus({ rootId: 'repo' })
    await mkdir(join(f.root, '.cursor', 'rules'), { recursive: true })
    await writeFile(join(f.root, '.cursor', 'rules', 'local.mdc'), '# Local rule\n\nInspect source.\n')
    await waitFor(async () => {
      const current = await runtime!.projectTextStatus({ rootId: 'repo' })
      return current.snapshotId !== initialText.snapshotId && current.stale === false
    })
    const finalCode = await runtime.indexStatus({ rootId: 'repo' })
    assert.equal(finalCode.identity?.snapshotId, initialCode.identity?.snapshotId)
    const results = await runtime.searchProjectText({
      rootId: 'repo',
      query: 'Inspect source',
      kinds: ['rules'],
      mode: 'lexical',
    })
    assert.equal(results.hits[0]?.path, '.cursor/rules/local.mdc')
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('combined indexing rejects a code mutation while the text model is physically pending', async () => {
  const f = await fixture()
  let release: (() => void) | undefined
  let startedResolve: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve
  })
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { input?: string[]; input_type?: string }
    if (body.input_type === 'document') {
      startedResolve?.()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
    const count = body.input?.length ?? 0
    const vector = Array.from({ length: 2 }, (_, index) => (index === 0 ? 1 : 0))
    return new Response(
      JSON.stringify({
        data: Array.from({ length: count }, (_, index) => ({ index, embedding: vector })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  const config = {
    ...f.config,
    projectText: {
      embedding: {
        provider: 'openrouter',
        model: 'fixture-text-model',
        dimensions: 2,
        secret: { kind: 'env', name: 'TEXT_KEY' },
      },
    },
  }
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({
      config,
      testDependencies: { env: { TEXT_KEY: 'fixture-only' }, fetch },
    })
    const indexing = runtime.indexRepository({ rootId: 'repo' })
    let startTimer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        started,
        new Promise<never>((_, reject) => {
          startTimer = setTimeout(() => reject(new Error('PROVIDER_START_TIMEOUT')), 5000)
          startTimer.unref?.()
        }),
      ])
    } finally {
      if (startTimer) clearTimeout(startTimer)
    }
    await writeFile(join(f.root, 'alpha.ts'), 'export const changedWhileTextProviderWaits = true\n')
    release?.()
    await assert.rejects(indexing, isCode('CODE_INDEX_SOURCE_CHANGED_DURING_INDEX'))
    assert.equal((await runtime.projectTextStatus({ rootId: 'repo' })).stale, false)
  } finally {
    release?.()
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('runtime carries the root aggregate-byte bound into text enumeration', async () => {
  const f = await fixture()
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({
      config: {
        ...f.config,
        roots: [{ id: 'repo', path: f.root, limits: { maxTotalBytes: 4 } }],
        projectText: {},
      },
    })
    await assert.rejects(runtime.indexProjectText({ rootId: 'repo' }), isCode('CODE_INDEX_TOTAL_BYTES_LIMIT'))
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('watch catches a text edit between completed indexing and watcher setup', async () => {
  const f = await fixture()
  let runtime: Awaited<ReturnType<typeof openSearchRuntime>> | undefined
  try {
    runtime = await openSearchRuntime({
      config: {
        ...f.config,
        roots: [{ id: 'repo', path: f.root, watch: true, watchIntervalMs: 250 }],
        projectText: {},
      },
      testDependencies: {
        beforeWatchSetup: async () => {
          await mkdir(join(f.root, '.agents', 'rules'), { recursive: true })
          await writeFile(join(f.root, '.agents', 'rules', 'post-index.mdc'), '# Post-index rule\n\nWatcher must detect this content.\n')
        },
      },
    })
    await waitFor(async () => {
      try {
        const result = await runtime!.searchProjectText({
          rootId: 'repo',
          query: 'detect this content',
          kinds: ['rules'],
          mode: 'lexical',
        })
        return result.hits.some((hit) => hit.path === '.agents/rules/post-index.mdc')
      } catch {
        return false
      }
    })
  } finally {
    await runtime?.close()
    await rm(f.dir, { recursive: true, force: true })
  }
})
