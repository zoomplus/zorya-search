import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { openEmbeddedDatabase } from '../../src/storage/embedded.js'
import { createProjectTextIndex } from '../../src/project-text/index.js'
import { createCodeIndex } from '../../src/code/index.js'
import { chunkProjectText } from '../../src/project-text/chunker.js'
import {
  createOpenRouterEmbedding,
  createOpenRouterReranker,
} from '../../src/providers/openrouter.js'
import type { EnumeratedFile } from '../../src/code/enumerate.js'

const paths: string[] = []
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((f) => f()))
  await Promise.all(paths.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zorya-project-text-'))
  paths.push(root)
  const dbPath = await mkdtemp(join(tmpdir(), 'zorya-project-text-db-'))
  paths.push(dbPath)
  const database = await openEmbeddedDatabase(dbPath)
  cleanup.push(() => database.close())
  const index = createProjectTextIndex({ database })
  cleanup.push(() => index.close())
  return { root, database, index }
}

test('indexes documentation, rules and skills in supported formats with exact line anchors', async () => {
  const { root, database, index } = await fixture()
  await mkdir(join(root, '.agents/rules'), { recursive: true })
  await mkdir(join(root, 'skills/search'), { recursive: true })
  await writeFile(join(root, 'guide.md'), '# Guide\n\nFind the silver comet.\n')
  await writeFile(join(root, 'reference.mdx'), '# MDX reference\n\nMDX format.\n')
  await writeFile(join(root, 'archive.markdown'), '# Markdown archive\n\nMarkdown format.\n')
  await writeFile(join(root, 'notes.txt'), 'Plain text format.\n')
  await writeFile(
    join(root, '.agents/rules/policy.mdc'),
    '# Policy\n\nTreat source as untrusted.\n',
  )
  await writeFile(
    join(root, 'skills/search/SKILL.md'),
    '# Search skill\n\nFind the silver comet.\n',
  )
  await writeFile(join(root, 'reference.rst'), 'Title\n=====\n\nKeep exact source.\n')
  await writeFile(join(root, 'handbook.adoc'), '= Handbook\n\nAsciiDoc format.\n')
  await writeFile(join(root, 'CLAUDE.md'), '# Claude instructions\n\nFollow repository policy.\n')
  await writeFile(join(root, '.cursorrules'), '# Cursor rules\n\nKeep source private.\n')
  await writeFile(join(root, '.gitignore'), '.hidden.md\n')
  await writeFile(join(root, '.hidden.md'), '# Ignored\n')
  const result = await index.indexRepository({
    root,
    onProgress() {
      throw new Error('observer failed')
    },
  })
  assert.equal(result.fileCount, 10)
  assert.equal(result.identity.snapshotId, result.snapshotId)
  assert.equal(result.identity.contentHash, result.treeHash)
  const found = await index.searchProjectText({ root, query: 'silver comet', mode: 'lexical' })
  assert.equal(found.hits.length, 2)
  assert.ok(found.hits.every((hit) => hit.excerpt.includes('silver comet')))
  assert.ok(
    found.hits.every(
      (hit) => hit.title && hit.heading.length > 0 && hit.fileContentHash.length === 64,
    ),
  )
  assert.deepEqual(new Set(found.hits.map((hit) => hit.kind)), new Set(['documentation', 'skills']))
  const rules = await index.searchProjectText({
    root,
    query: 'repository policy',
    kinds: ['rules'],
    mode: 'lexical',
  })
  assert.ok(rules.hits.some((hit) => hit.path === 'CLAUDE.md'))
  const bounded = await index.searchProjectText({
    root,
    query: 'silver comet',
    mode: 'lexical',
    maxChars: 2,
  })
  assert.equal(bounded.hits[0]?.truncated, true)
  assert.equal(bounded.truncated, true)
  const mutableRequest = { root, query: 'silver comet', mode: 'lexical' as const }
  const pendingSearch = index.searchProjectText(mutableRequest)
  mutableRequest.query = 'missing term'
  assert.ok((await pendingSearch).hits.length > 0)
  const read = await index.readProjectText({
    root,
    path: 'guide.md',
    lineStart: 1,
    lineEnd: 3,
    snapshotId: result.snapshotId,
  })
  assert.equal(read.text, '# Guide\n\nFind the silver comet.')
  assert.equal(read.lineStart, 1)
  assert.equal(read.lineEnd, 3)
  assert.equal(read.truncated, false)
  const status = await index.indexStatus(root)
  assert.equal(status.stale, false)
  assert.equal(typeof status.indexedAt, 'string')
  assert.equal(new Date(status.indexedAt!).toISOString(), status.indexedAt)
})

test('git enumeration honors ignore, binary, invalid UTF-8, secret path, and symlink boundaries', async () => {
  const { root, index } = await fixture()
  execFileSync('git', ['-C', root, 'init', '-q'])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Fixture'])
  await writeFile(join(root, 'AGENTS.md'), '# Rules\nKeep the source readable.\n')
  await writeFile(join(root, '.gitignore'), 'ignored.md\n')
  await writeFile(join(root, 'ignored.md'), '# Ignored\n')
  await writeFile(join(root, 'guide.md'), '# Guide\nVisible text.\n')
  await writeFile(join(root, 'notes.txt'), 'Untracked text.\n')
  await writeFile(join(root, 'credential-notes.md'), 'Do not index this path.\n')
  await writeFile(join(root, 'binary.md'), Buffer.from([0x23, 0, 0x41]))
  await writeFile(join(root, 'invalid-utf8.md'), Buffer.from([0xff, 0xfe]))
  const externalRoot = await mkdtemp(join(tmpdir(), 'zorya-text-external-'))
  paths.push(externalRoot)
  const external = join(externalRoot, 'external-project-text.md')
  await writeFile(external, '# Outside\n')
  await symlink(external, join(root, 'linked.md'))
  execFileSync('git', [
    '-C',
    root,
    'add',
    'AGENTS.md',
    '.gitignore',
    'guide.md',
    'credential-notes.md',
    'binary.md',
    'invalid-utf8.md',
  ])
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture'])
  const indexed = await index.indexRepository({ root })
  assert.equal(indexed.fileCount, 3)
  const result = await index.searchProjectText({
    root,
    query: 'readable visible untracked',
    mode: 'lexical',
  })
  assert.deepEqual(
    new Set(result.hits.map((hit) => hit.path)),
    new Set(['AGENTS.md', 'guide.md', 'notes.txt']),
  )
})

test('lexical BM25 ranks a short specific passage above a long common-word distractor', async () => {
  const { root, index } = await fixture()
  await writeFile(
    join(root, 'release-guide.md'),
    '# Release verification\n\nСверка публикации выполняется перед релизом.\n',
  )
  await writeFile(
    join(root, 'publication-notes.md'),
    `# Публикации\n\n${'публикации '.repeat(500)}\n`,
  )
  await index.indexRepository({ root })

  const result = await index.searchProjectText({
    root,
    query: 'сверка публикации',
    mode: 'lexical',
    limit: 1,
  })

  assert.equal(result.hits[0]?.path, 'release-guide.md')
})

test('reading never backfills, stale source is an error, and index close leaves borrowed database open', async () => {
  const { root, database, index } = await fixture()
  await writeFile(join(root, 'notes.txt'), 'initial note\n')
  await assert.rejects(index.readProjectText({ root, path: 'notes.txt' }), {
    code: 'PROJECT_TEXT_NOT_INDEXED',
  })
  await assert.rejects(index.readProjectText({ root, path: '../outside.md' }), {
    code: 'PROJECT_TEXT_RANGE_INVALID',
  })
  await assert.rejects(
    index.searchProjectText({ root, query: 'note', kinds: ['other' as never] }),
    { code: 'PROJECT_TEXT_SEARCH_INPUT_INVALID' },
  )
  await assert.rejects(
    index.readProjectText({ root, path: 'notes.txt', lineStart: 1, lineEnd: 201 }),
    { code: 'PROJECT_TEXT_RANGE_INVALID' },
  )
  const indexed = await index.indexRepository({ root })
  await writeFile(join(root, 'notes.txt'), 'changed note\n')
  await assert.rejects(index.searchProjectText({ root, query: 'changed', mode: 'lexical' }), {
    code: 'PROJECT_TEXT_SOURCE_CHANGED',
  })
  await index.close()
  await database.query('SELECT 1')
  assert.ok(indexed.snapshotId)
})

test('profile changes invalidate vector reuse and malformed vectors do not publish a generation', async () => {
  const { root, database, index: unused } = await fixture()
  await unused.close()
  await writeFile(join(root, 'guide.md'), '# Guide\nalpha text\n')
  const calls = new Map<string, number>()
  const provider = (model: string, role: 'document' | 'query', bad = false) => ({
    profile: { provider: 'fixture', space: 'text', model, dimensions: 2, inputType: role },
    async embed({ texts }: { texts: string[] }) {
      calls.set(model, (calls.get(model) ?? 0) + 1)
      return texts.map(() => (bad ? [1] : [1, 0]))
    },
  })
  const first = createProjectTextIndex({
    database,
    documentEmbedding: provider('model-a', 'document'),
    queryEmbedding: provider('model-a', 'query'),
  })
  cleanup.push(() => first.close())
  const original = await first.indexRepository({ root })
  assert.equal(calls.get('model-a'), 1)
  const second = createProjectTextIndex({
    database,
    documentEmbedding: provider('model-b', 'document'),
    queryEmbedding: provider('model-b', 'query'),
  })
  cleanup.push(() => second.close())
  const changed = await second.indexRepository({ root })
  assert.notEqual(changed.snapshotId, original.snapshotId)
  assert.equal(calls.get('model-b'), 1)
  const broken = createProjectTextIndex({
    database,
    documentEmbedding: provider('model-c', 'document', true),
    queryEmbedding: provider('model-c', 'query'),
  })
  cleanup.push(() => broken.close())
  await assert.rejects(broken.indexRepository({ root }), { code: 'PROJECT_TEXT_VECTOR_INVALID' })
  assert.equal((await second.indexStatus(root)).snapshotId, changed.snapshotId)
})

test('an overlong source line fails with a typed bound instead of silently clipping text', async () => {
  const { root, database, index: unused } = await fixture()
  await unused.close()
  await writeFile(join(root, 'guide.md'), `# Guide\n${'x'.repeat(40)}\n`)
  const bounded = createProjectTextIndex({ database, limits: { maxChunkChars: 16 } })
  cleanup.push(() => bounded.close())
  await assert.rejects(bounded.indexRepository({ root }), { code: 'PROJECT_TEXT_LINE_LIMIT' })
  assert.equal((await bounded.indexStatus(root)).snapshotId, null)
})

test('heading parser preserves depth, ignores headings in fences, and disambiguates repeated sections', () => {
  const text =
    '# Root\n## Parent\n#### Deep\ntext\n```md\n# fenced\n```\n## Repeat\nsame\n## Repeat\nsame\n'
  const file: EnumeratedFile = {
    path: 'manual.md',
    absolutePath: '/manual.md',
    text,
    hash: 'source',
    bytes: Buffer.byteLength(text),
  }
  const chunks = chunkProjectText(file, 1000)
  const deep = chunks.find((chunk) => chunk.text.includes('text\n```md'))!
  assert.deepEqual(deep.heading, ['Root', 'Parent', 'Deep'])
  assert.ok(!chunks.some((chunk) => chunk.heading.includes('fenced')))
  const repeats = chunks.filter((chunk) => chunk.heading.at(-1) === 'Repeat')
  assert.equal(repeats.length, 2)
  assert.notEqual(repeats[0]!.id, repeats[1]!.id)
  const mixed =
    '# Real title\n````md\n~~~\n# Still code\n```\n## Still code\n````\n# Visible section\ntext\n'
  const mixedChunks = chunkProjectText(
    { ...file, text: mixed, bytes: Buffer.byteLength(mixed) },
    1000,
  )
  assert.equal(mixedChunks[0]!.title, 'Real title')
  assert.ok(!mixedChunks.some((chunk) => chunk.heading.includes('Still code')))
  assert.ok(mixedChunks.some((chunk) => chunk.heading.includes('Visible section')))
})

test('hybrid uses separate document and query roles, lexical mode avoids query models, and stable chunks reuse vectors', async () => {
  const { root, database, index: unusedIndex } = await fixture()
  await unusedIndex.close()
  await writeFile(join(root, 'guide.md'), '# Guide\n## Stable section\nalpha comet data\n')
  let documentCalls = 0,
    queryCalls = 0,
    rerankCalls = 0
  const documentEmbedding = {
    profile: {
      provider: 'fixture',
      space: 'text',
      model: 'model',
      dimensions: 2,
      inputType: 'document',
    },
    async embed({ texts }: { texts: string[] }) {
      documentCalls++
      return texts.map(() => [1, 0])
    },
  }
  const queryEmbedding = {
    profile: {
      provider: 'fixture',
      space: 'text',
      model: 'model',
      dimensions: 2,
      inputType: 'query',
    },
    async embed({ texts }: { texts: string[] }) {
      queryCalls++
      return texts.map((text) => (text === 'opposite' ? [-1, 0] : [1, 0]))
    },
  }
  const reranker = {
    async rerank({ documents }: { query: string; documents: string[]; signal: AbortSignal }) {
      rerankCalls++
      assert.ok(
        documents.some(
          (document) => document.includes('Stable section') && document.includes('alpha comet'),
        ),
      )
      return documents.map((_, index) => ({ index, score: documents.length - index }))
    },
  }
  const hybrid = createProjectTextIndex({
    database,
    documentEmbedding,
    queryEmbedding,
    reranker,
    rerankCandidateLimit: 10,
  })
  cleanup.push(() => hybrid.close())
  await hybrid.indexRepository({ root })
  const firstDocumentCalls = documentCalls
  const initialSnapshot = (await hybrid.indexStatus(root)).snapshotId
  const unchanged = await hybrid.indexRepository({ root })
  assert.equal(unchanged.snapshotId, initialSnapshot)
  assert.equal(documentCalls, firstDocumentCalls)
  assert.ok(firstDocumentCalls > 0)
  await hybrid.searchProjectText({ root, query: 'alpha comet', mode: 'lexical' })
  assert.equal(queryCalls, 0)
  assert.equal(rerankCalls, 0)
  const hybridResult = await hybrid.searchProjectText({
    root,
    query: 'alpha comet',
    mode: 'hybrid',
  })
  assert.ok(hybridResult.hits.length > 0)
  assert.equal(queryCalls, 1)
  assert.equal(rerankCalls, 1)
  const negativeDense = await hybrid.searchProjectText({ root, query: 'opposite', mode: 'hybrid' })
  assert.ok(negativeDense.hits.length > 0)
  await writeFile(
    join(root, 'guide.md'),
    '# Guide\n## Intro\nnew intro\n## Stable section\nalpha comet data\n',
  )
  await hybrid.indexRepository({ root })
  assert.equal(documentCalls, firstDocumentCalls + 1)
})

test('actual SDK adapters accept requested topN and skip empty source chunks', async () => {
  const { root, database, index: unused } = await fixture()
  await unused.close()
  await writeFile(join(root, 'empty.md'), '')
  await writeFile(join(root, 'blank.txt'), ' \n\t\n')
  await writeFile(join(root, 'a.md'), '# A\n\nanswer alpha\n')
  await writeFile(join(root, 'b.md'), '# B\n\nanswer beta\n')
  const requests: Array<{ route: string; body: Record<string, unknown> }> = []
  const fetcher: typeof fetch = async (input, init) => {
    const route = new URL(String(input)).pathname
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push({ route, body })
    if (route.endsWith('/embeddings')) {
      const texts = body.input as string[]
      return Response.json({
        model: body.model,
        data: texts.map((_, index) => ({ index, embedding: [1, 0, 0] })),
      })
    }
    const documents = body.documents as string[]
    const topN = Number(body.top_n)
    return Response.json({
      model: body.model,
      results: Array.from({ length: Math.min(topN, documents.length) }, (_, index) => ({
        index,
        relevance_score: 1 - index / 10,
      })),
    })
  }
  const providerConfig = {
    baseUrl: 'https://example.invalid/v1',
    dimensions: 3,
    apiKey: 'test-only-not-a-credential',
    fetch: fetcher,
    limits: { attempts: 1 },
  }
  const index = createProjectTextIndex({
    database,
    documentEmbedding: createOpenRouterEmbedding({
      ...providerConfig,
      model: 'fixture-text',
      inputType: 'document',
    }),
    queryEmbedding: createOpenRouterEmbedding({
      ...providerConfig,
      model: 'fixture-text',
      inputType: 'query',
    }),
    reranker: createOpenRouterReranker({
      ...providerConfig,
      model: 'fixture-rerank',
      maxResults: 3,
    }),
  })
  cleanup.push(() => index.close())
  const indexed = await index.indexRepository({ root })
  assert.equal(indexed.fileCount, 4)
  assert.equal(indexed.chunkCount, 2)
  const result = await index.searchProjectText({ root, query: 'answer', mode: 'hybrid', limit: 1 })
  assert.equal(result.rerank?.status, 'complete')
  assert.equal(result.rerank?.requested, 1)
  assert.equal(result.rerank?.returned, 1)
  const documentRequest = requests.find(
    ({ route, body }) => route.endsWith('/embeddings') && body.input_type === 'document',
  )
  assert.deepEqual(documentRequest?.body.input, ['# A\n\nanswer alpha\n', '# B\n\nanswer beta\n'])
  assert.ok(
    requests.some(
      ({ route, body }) =>
        route.endsWith('/rerank') && body.top_n === 1 && (body.documents as string[]).length > 1,
    ),
  )
})

test('partial and empty rerank results expose their returned ranking cardinality', async () => {
  const { root, database, index: unused } = await fixture()
  await unused.close()
  for (const letter of ['a', 'b', 'c'])
    await writeFile(join(root, `${letter}.md`), `# ${letter}\n\nanswer ${letter}\n`)
  let ranking: 'partial' | 'empty' = 'partial'
  const profile = (inputType: 'document' | 'query') => ({
    provider: 'fixture',
    space: 'text',
    model: 'fixture',
    dimensions: 2,
    inputType,
  })
  const index = createProjectTextIndex({
    database,
    documentEmbedding: {
      profile: profile('document'),
      async embed({ texts }: { texts: string[] }) {
        return texts.map(() => [1, 0])
      },
    },
    queryEmbedding: {
      profile: profile('query'),
      async embed({ texts }: { texts: string[] }) {
        return texts.map(() => [1, 0])
      },
    },
    rerankCandidateLimit: 3,
    reranker: {
      async rerank() {
        return ranking === 'empty' ? [] : [{ index: 0, score: 0.8 }]
      },
    },
  })
  cleanup.push(() => index.close())
  await index.indexRepository({ root })
  const partial = await index.searchProjectText({ root, query: 'answer', mode: 'hybrid', limit: 2 })
  assert.deepEqual(partial.rerank, { status: 'incomplete', requested: 2, returned: 1 })
  assert.equal(partial.hits.length, 1)
  assert.equal(partial.truncated, true)
  ranking = 'empty'
  const empty = await index.searchProjectText({ root, query: 'answer', mode: 'hybrid', limit: 2 })
  assert.deepEqual(empty.rerank, { status: 'empty', requested: 2, returned: 0 })
  assert.equal(empty.hits.length, 0)
  assert.equal(empty.truncated, true)
})

test('close aborts and joins a query provider that settles after cancellation', async () => {
  const { root, database, index: unusedIndex } = await fixture()
  await unusedIndex.close()
  await writeFile(join(root, 'guide.md'), '# Guide\nalpha comet\n')
  const documentEmbedding = {
    profile: {
      provider: 'fixture',
      space: 'text',
      model: 'model',
      dimensions: 2,
      inputType: 'document',
    },
    async embed({ texts }: { texts: string[] }) {
      return texts.map(() => [1, 0])
    },
  }
  let release!: () => void
  let started!: () => void
  const hasStarted = new Promise<void>((resolveStarted) => {
    started = resolveStarted
  })
  const queryEmbedding = {
    profile: {
      provider: 'fixture',
      space: 'text',
      model: 'model',
      dimensions: 2,
      inputType: 'query',
    },
    async embed() {
      started()
      await new Promise<void>((resolveRelease) => {
        release = resolveRelease
      })
      return [[1, 0]]
    },
  }
  const index = createProjectTextIndex({ database, documentEmbedding, queryEmbedding })
  cleanup.push(() => index.close())
  await index.indexRepository({ root })
  const searching = index.searchProjectText({ root, query: 'alpha', mode: 'hybrid' })
  await hasStarted
  let firstCloseSettled = false
  let secondCloseSettled = false
  const firstClosing = index.close().then(() => {
    firstCloseSettled = true
  })
  const secondClosing = index.close().then(() => {
    secondCloseSettled = true
  })
  try {
    await Promise.resolve()
    assert.equal(firstCloseSettled, false)
    assert.equal(secondCloseSettled, false)
  } finally {
    release()
  }
  await assert.rejects(searching, { code: 'PROJECT_TEXT_INDEX_CLOSED' })
  await Promise.all([firstClosing, secondClosing])
  assert.equal(firstCloseSettled, true)
  assert.equal(secondCloseSettled, true)
  await database.query('SELECT 1')
})

test('embedding profile mutation during an operation is rejected before returning a result', async () => {
  const { root, database, index: unused } = await fixture()
  await unused.close()
  await writeFile(join(root, 'guide.md'), '# Guide\nalpha content\n')
  const documentProfile = {
    provider: 'fixture',
    space: 'text',
    model: 'model',
    dimensions: 2,
    inputType: 'document' as const,
  }
  const queryProfile = {
    provider: 'fixture',
    space: 'text',
    model: 'model',
    dimensions: 2,
    inputType: 'query' as const,
  }
  const documentEmbedding = {
    profile: documentProfile,
    async embed({ texts }: { texts: string[] }) {
      return texts.map(() => [1, 0])
    },
  }
  const queryEmbedding = {
    profile: queryProfile,
    async embed({ texts }: { texts: string[] }) {
      queryProfile.space = 'changed-space'
      return texts.map(() => [1, 0])
    },
  }
  const index = createProjectTextIndex({ database, documentEmbedding, queryEmbedding })
  cleanup.push(() => index.close())
  await index.indexRepository({ root })
  await assert.rejects(index.searchProjectText({ root, query: 'alpha', mode: 'hybrid' }), {
    code: 'PROJECT_TEXT_PROFILE_MUTATED',
  })
})

test('database generation fence prevents an older provider profile from publishing late', async () => {
  const { root, database, index: unusedIndex } = await fixture()
  await unusedIndex.close()
  await writeFile(join(root, 'guide.md'), '# Guide\nalpha comet\n')
  let release!: () => void
  let started!: () => void
  const hasStarted = new Promise<void>((resolveStarted) => {
    started = resolveStarted
  })
  const profile = (model: string, inputType: 'document' | 'query') => ({
    provider: 'fixture',
    space: 'text',
    model,
    dimensions: 2,
    inputType,
  })
  const documentA = {
    profile: profile('model-a', 'document'),
    async embed({ texts }: { texts: string[] }) {
      started()
      await new Promise<void>((resolveRelease) => {
        release = resolveRelease
      })
      return texts.map(() => [1, 0])
    },
  }
  const queryA = {
    profile: profile('model-a', 'query'),
    async embed({ texts }: { texts: string[] }) {
      return texts.map(() => [1, 0])
    },
  }
  const documentB = {
    profile: profile('model-b', 'document'),
    async embed({ texts }: { texts: string[] }) {
      return texts.map(() => [0, 1])
    },
  }
  const queryB = {
    profile: profile('model-b', 'query'),
    async embed({ texts }: { texts: string[] }) {
      return texts.map(() => [0, 1])
    },
  }
  const indexA = createProjectTextIndex({
    database,
    documentEmbedding: documentA,
    queryEmbedding: queryA,
  })
  const indexB = createProjectTextIndex({
    database,
    documentEmbedding: documentB,
    queryEmbedding: queryB,
  })
  cleanup.push(
    () => indexA.close(),
    () => indexB.close(),
  )
  const oldJob = indexA.indexRepository({ root })
  await hasStarted
  let winner: { snapshotId: string }
  try {
    winner = await indexB.indexRepository({ root })
  } finally {
    release()
  }
  await assert.rejects(oldJob, { code: 'PROJECT_TEXT_GENERATION_SUPERSEDED' })
  assert.equal((await indexB.indexStatus(root)).snapshotId, winner.snapshotId)
  const retained = await database.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM zorya_project_text_snapshots WHERE worktree_id=$1',
    [winner.identity.worktreeId],
  )
  assert.equal(retained.rows[0]?.count, '1')
  const vectors = await database.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM zorya_project_text_chunks WHERE snapshot_id=$1 AND vector_json IS NOT NULL',
    [winner.snapshotId],
  )
  assert.ok(Number(vectors.rows[0]?.count) > 0)
})

test('settled embedding batches survive a failed generation and resume without duplicate calls', async () => {
  const { root, database, index: unused } = await fixture()
  await unused.close()
  const sections = Array.from(
    { length: 34 },
    (_, number) => `## Section ${number}\nDistinct source ${number}.\n`,
  ).join('')
  await writeFile(join(root, 'guide.md'), `# Guide\n${sections}`)
  let calls = 0
  const provider = (inputType: 'document' | 'query') => ({
    profile: { provider: 'fixture', space: 'resume', model: 'model', dimensions: 2, inputType },
    async embed({ texts }: { texts: string[] }) {
      calls++
      if (inputType === 'document' && calls === 2) throw new Error('temporary provider failure')
      return texts.map(() => [1, 0])
    },
  })
  const index = createProjectTextIndex({
    database,
    documentEmbedding: provider('document'),
    queryEmbedding: provider('query'),
  })
  cleanup.push(() => index.close())
  await assert.rejects(index.indexRepository({ root }), /temporary provider failure/u)
  assert.equal((await index.indexStatus(root)).snapshotId, null)
  await index.indexRepository({ root })
  assert.equal(calls, 3)
})

test('snapshot retention keeps only each worktree current while preserving other roots', async () => {
  const { root, database, index } = await fixture()
  const otherRoot = await mkdtemp(join(tmpdir(), 'zorya-project-text-peer-'))
  paths.push(otherRoot)
  await writeFile(join(root, 'guide.md'), '# Guide\nRevision zero.\n')
  await writeFile(join(otherRoot, 'guide.md'), '# Peer\nUnrelated root.\n')
  await index.indexRepository({ root })
  const peer = await index.indexRepository({ root: otherRoot })
  for (let revision = 1; revision <= 5; revision++) {
    await writeFile(join(root, 'guide.md'), `# Guide\nRevision ${revision}.\n`)
    await index.indexRepository({ root })
  }
  const snapshots = await database.query<{ worktree_id: string; count: string }>(
    'SELECT worktree_id,COUNT(*)::text AS count FROM zorya_project_text_snapshots GROUP BY worktree_id ORDER BY worktree_id',
  )
  assert.equal(snapshots.rows.length, 2)
  assert.ok(snapshots.rows.every((row) => row.count === '1'))
  assert.equal((await index.indexStatus(otherRoot)).snapshotId, peer.snapshotId)
})

test('separate text indexing preserves code chunks and existing knowledge rows in the borrowed database', async () => {
  const { root, database, index: unused } = await fixture()
  await unused.close()
  await writeFile(join(root, 'module.ts'), 'export const answer = 42\n')
  await writeFile(join(root, 'README.md'), '# Guide\nRepository text.\n')
  const code = createCodeIndex({ database })
  cleanup.push(() => code.close())
  await code.indexRepository({ root })
  await database.exec('CREATE TABLE knowledge_fixture(id text PRIMARY KEY, excerpt text NOT NULL)')
  await database.query('INSERT INTO knowledge_fixture(id,excerpt) VALUES($1,$2)', [
    'retained',
    'Existing knowledge',
  ])
  const beforeCode = await database.query(
    'SELECT snapshot_id,id,path,body,content_hash,vector_json FROM zorya_code_chunks ORDER BY snapshot_id,id',
  )
  const beforeKnowledge = await database.query(
    'SELECT id,excerpt FROM knowledge_fixture ORDER BY id',
  )
  const textIndex = createProjectTextIndex({ database })
  cleanup.push(() => textIndex.close())
  await textIndex.indexRepository({ root })
  assert.deepEqual(
    await database.query(
      'SELECT snapshot_id,id,path,body,content_hash,vector_json FROM zorya_code_chunks ORDER BY snapshot_id,id',
    ),
    beforeCode,
  )
  assert.deepEqual(
    await database.query('SELECT id,excerpt FROM knowledge_fixture ORDER BY id'),
    beforeKnowledge,
  )
})
