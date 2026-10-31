import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { openEmbeddedDatabase } from '../../src/storage/embedded.js'
import { createCodeIndex } from '../../src/code/index.js'
import { CodeIndexError } from '../../src/code/errors.js'
import { chunkCode } from '../../src/code/chunker.js'
import type { CodeIndexLimits } from '../../src/code/types.js'

const roots: string[] = []
const databases: { close(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temp(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'zorya-code-index-'))
  roots.push(path)
  return path
}
function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
}
async function repository(): Promise<string> {
  const root = await temp()
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'fixture@example.invalid')
  git(root, 'config', 'user.name', 'Fixture')
  return root
}
async function index(
  root: string,
  models?: {
    embed(input: { texts: string[]; signal: AbortSignal }): Promise<number[][]>
    rerank?(input: {
      query: string
      documents: string[]
      signal: AbortSignal
    }): Promise<{ index: number; score: number }[]>
  },
  profile?: {
    provider: string
    space: string
    model: string
    dimensions: number
    inputType: 'text'
    chunkerVersion: string
  },
  limits?: Partial<CodeIndexLimits>,
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'zorya-code-db-'))
  roots.push(dataDir)
  const database = await openEmbeddedDatabase(dataDir)
  databases.push(database)
  const code = createCodeIndex({
    database,
    ...(models ? { models, profile } : {}),
    ...(limits ? { limits } : {}),
  })
  return { database, code }
}
async function commit(root: string, message: string): Promise<void> {
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', message)
}

test('indexes AST symbols and import edges, searches offline, and returns provenance-bound source lines', async () => {
  const root = await repository()
  await writeFile(
    join(root, 'math.ts'),
    'export function addNumbers(left: number, right: number) { return left + right }\n',
  )
  await writeFile(
    join(root, 'service.ts'),
    "import { addNumbers } from './math.js'\nexport class InvoiceService { total() { return addNumbers(2, 3) } }\n",
  )
  await commit(root, 'fixture')
  const { code, database } = await index(root)
  const status = await code.indexRepository({ root })
  assert.equal(status.fileCount, 2)
  assert.equal(status.identity?.branch !== null, true)
  const found = await code.searchCode({ root, query: 'addNumbers', limit: 5 })
  assert.ok(found.hits.some((hit) => hit.path === 'math.ts' && hit.symbol === 'addNumbers'))
  assert.equal(found.hits[0]?.repoId, status.identity?.repoId)
  const related = await code.relatedCode({ root, path: 'math.ts', symbol: 'addNumbers' })
  assert.deepEqual(related.importedBy, ['service.ts'])
  const sourceHit = found.hits.find((hit) => hit.path === 'math.ts')!
  const source = await code.readSource({
    root,
    path: sourceHit.path,
    lineStart: sourceHit.lineStart,
    lineEnd: sourceHit.lineEnd,
    snapshotId: sourceHit.snapshotId,
  })
  assert.match(source.text, /function addNumbers/u)
  await code.close()
  const restored = createCodeIndex({ database })
  assert.equal(
    (await restored.searchCode({ root, query: 'addNumbers' })).hits[0]?.snapshotId,
    status.identity?.snapshotId,
  )
  await restored.close()
  await code.close()
})

test('honors nested ignore negation, secret policy, binary exclusion, and symlink containment', async () => {
  const root = await repository()
  await mkdir(join(root, 'nested'))
  await writeFile(join(root, '.gitignore'), 'nested/*\n!nested/keep.ts\n')
  await writeFile(join(root, 'nested', 'keep.ts'), 'export const retained = 1\n')
  await writeFile(join(root, 'nested', 'drop.ts'), 'export const hidden = 1\n')
  await writeFile(join(root, 'credentials.json'), '{"secret":"hidden"}')
  await writeFile(join(root, 'blob.ts'), Buffer.from([0, 1, 2]))
  await commit(root, 'fixture')
  const outside = await temp()
  await writeFile(join(outside, 'escape.ts'), 'export const escaped = true')
  await symlink(join(outside, 'escape.ts'), join(root, 'escape.ts'))
  const { code } = await index(root)
  const result = await code.indexRepository({ root })
  assert.equal(result.fileCount, 1)
  assert.deepEqual(
    (await code.searchCode({ root, query: 'retained' })).hits.map((hit) => hit.path),
    ['nested/keep.ts'],
  )
  await assert.rejects(
    code.readSource({ root, path: 'escape.ts' }),
    (error: unknown) =>
      error instanceof CodeIndexError && error.code === 'CODE_INDEX_PATH_OUTSIDE_ROOT',
  )
})

test('prunes changed, renamed, and deleted source; detects equal-size edits and branch changes', async () => {
  const root = await repository()
  await writeFile(join(root, 'first.ts'), 'export const alpha = 100\n')
  await commit(root, 'first')
  const { code } = await index(root)
  const first = await code.indexRepository({ root })
  await writeFile(join(root, 'first.ts'), 'export const bravo = 200\n')
  await code.indexRepository({ root })
  assert.deepEqual((await code.searchCode({ root, query: 'alpha' })).hits, [])
  assert.equal(
    (await code.searchCode({ root, query: 'bravo' })).hits[0]?.contentHash ===
      first.identity?.contentHash,
    false,
  )
  git(root, 'mv', 'first.ts', 'renamed.ts')
  await commit(root, 'rename')
  await code.indexRepository({ root })
  assert.deepEqual(
    (await code.searchCode({ root, query: 'bravo' })).hits.map((hit) => hit.path),
    ['renamed.ts'],
  )
  await rm(join(root, 'renamed.ts'))
  await commit(root, 'delete')
  await code.indexRepository({ root })
  assert.deepEqual((await code.searchCode({ root, query: 'bravo' })).hits, [])
  const branch = await code.indexStatus(root)
  git(root, 'checkout', '-qb', 'other')
  assert.equal((await code.indexStatus(root)).identity, null)
  const nested = join(root, 'nested-scope')
  await mkdir(nested)
  await writeFile(join(nested, 'inside.ts'), 'export const scoped = true')
  git(root, 'add', 'nested-scope/inside.ts')
  await commit(root, 'nested scope')
  await code.indexRepository({ root })
  const childStatus = await code.indexRepository({ root: nested })
  assert.notEqual(
    childStatus.identity?.worktreeId,
    (await code.indexStatus(root)).identity?.worktreeId,
  )
  assert.equal(childStatus.fileCount, 1)
  assert.equal(
    (await code.searchCode({ root: nested, query: 'scoped' })).hits[0]?.path,
    'inside.ts',
  )
  await code.indexRepository({ root })
  assert.notEqual((await code.indexStatus(root)).identity?.branch, branch.identity?.branch)
})

test('validates profiles and provider output; stale embeddings cannot publish', async () => {
  const root = await repository()
  await writeFile(join(root, 'code.ts'), 'export function slowVectorTarget() { return 1 }\n')
  await commit(root, 'fixture')
  let release: (() => void) | undefined
  let announceStarted: (() => void) | undefined
  const embeddingStarted = new Promise<void>((resolve) => {
    announceStarted = resolve
  })
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const profile = {
    provider: 'mock',
    space: 'local-text-v1',
    model: 'fixture-v1',
    dimensions: 2,
    inputType: 'text' as const,
    chunkerVersion: 'ts-ast-symbol-v1',
  }
  const delayedModels = {
    async embed({ texts }: { texts: string[] }) {
      announceStarted!()
      await pending
      return texts.map(() => [1, 0])
    },
    async rerank({ documents }: { documents: string[] }) {
      return documents.map((_, index) => ({ index, score: 1 }))
    },
  }
  const { code } = await index(root, delayedModels, profile)
  const indexing = code.indexRepository({ root })
  const rejected = assert.rejects(
    indexing,
    (error: unknown) =>
      error instanceof CodeIndexError && error.code === 'CODE_INDEX_SOURCE_CHANGED_DURING_INDEX',
  )
  await embeddingStarted
  await writeFile(join(root, 'code.ts'), 'export function changedTarget() { return 2 }\n')
  release!()
  await rejected
  assert.equal((await code.indexStatus(root)).identity, null)
  const badModels = {
    async embed() {
      return [[NaN, 0]]
    },
    async rerank() {
      return [{ index: 999, score: 0 }]
    },
  }
  const bad = await index(root, badModels, profile)
  await assert.rejects(
    bad.code.indexRepository({ root }),
    (error: unknown) =>
      error instanceof CodeIndexError && error.code === 'CODE_INDEX_VECTOR_INVALID',
  )
})

test('degrades hybrid mode explicitly without models and keeps non-git roots supported', async () => {
  const root = await temp()
  await writeFile(join(root, 'loose.ts'), 'export const usefulFallback = true\n')
  await writeFile(join(root, '.gitignore'), 'ignored/\n')
  await mkdir(join(root, 'ignored'))
  await writeFile(join(root, 'ignored', 'secret.ts'), 'export const omitted = true')
  const { code } = await index(root)
  const result = await code.indexRepository({ root })
  assert.equal(result.fileCount, 1)
  const search = await code.searchCode({ root, query: 'usefulFallback', mode: 'hybrid' })
  assert.equal(search.degraded, true)
  assert.match(search.degradedReason ?? '', /векторная модель не настроена/iu)
})

test('fails closed on unreadable ignore files and explicit file or total-byte limits', async () => {
  const root = await temp()
  await mkdir(join(root, '.gitignore'))
  const { code } = await index(root)
  await assert.rejects(
    code.indexRepository({ root }),
    (error: unknown) =>
      error instanceof CodeIndexError && error.code === 'CODE_INDEX_IGNORE_FILE_UNREADABLE',
  )
  await rm(join(root, '.gitignore'), { recursive: true })
  await writeFile(join(root, 'large.ts'), '123456789012345')
  const smallFileLimit = await index(root, undefined, undefined, { maxFileBytes: 10 })
  await assert.rejects(
    smallFileLimit.code.indexRepository({ root }),
    (error: unknown) =>
      error instanceof CodeIndexError && error.code === 'CODE_INDEX_FILE_SIZE_LIMIT',
  )
  const smallTotalLimit = await index(root, undefined, undefined, { maxTotalBytes: 10 })
  await assert.rejects(
    smallTotalLimit.code.indexRepository({ root }),
    (error: unknown) =>
      error instanceof CodeIndexError && error.code === 'CODE_INDEX_TOTAL_BYTES_LIMIT',
  )
})

test('rejects malformed reranker order and joins watcher shutdown', async () => {
  const root = await repository()
  await writeFile(join(root, 'find.ts'), 'export function searchableNeedle() { return 1 }')
  await commit(root, 'fixture')
  const profile = {
    provider: 'mock',
    space: 'local-text-v1',
    model: 'fixture',
    dimensions: 2,
    inputType: 'text' as const,
    chunkerVersion: 'ts-ast-symbol-v1',
  }
  const models = {
    async embed({ texts }: { texts: string[] }) {
      return texts.map(() => [1, 0])
    },
    async rerank() {
      return [{ index: 100, score: 1 }]
    },
  }
  const { code } = await index(root, models, profile)
  await code.indexRepository({ root })
  await assert.rejects(
    code.searchCode({ root, query: 'searchableNeedle', mode: 'hybrid' }),
    (error: unknown) =>
      error instanceof CodeIndexError && error.code === 'CODE_INDEX_RERANK_INVALID',
  )
  const watcher = await code.watchRepository(root, { intervalMs: 250 })
  await watcher.close()
  await code.close()
})

test('profile changes create separate snapshots and never reuse vectors across profiles', async () => {
  const root = await repository()
  await writeFile(join(root, 'vectors.ts'), 'export function vectorTarget() { return 1 }')
  await commit(root, 'fixture')
  const dataDir = await mkdtemp(join(tmpdir(), 'zorya-code-db-'))
  roots.push(dataDir)
  const database = await openEmbeddedDatabase(dataDir)
  databases.push(database)
  const profileA = {
    provider: 'fixture',
    space: 'endpoint-a/input-text',
    model: 'same-model',
    dimensions: 2,
    inputType: 'text' as const,
    chunkerVersion: 'ts-ast-symbol-v1',
  }
  const profileB = { ...profileA, space: 'endpoint-b/input-text' }
  const modelsA = {
    async embed({ texts }: { texts: string[] }) {
      return texts.map(() => [1, 0])
    },
    async rerank({ documents }: { documents: string[] }) {
      return documents.map((_, index) => ({ index, score: 1 }))
    },
  }
  let profileBEmbeddings = 0
  const modelsB = {
    async embed({ texts }: { texts: string[] }) {
      profileBEmbeddings++
      return texts.map(() => [0, 1])
    },
    async rerank({ documents }: { documents: string[] }) {
      return documents.map((_, index) => ({ index, score: 1 }))
    },
  }
  const a = createCodeIndex({ database, models: modelsA, profile: profileA })
  const first = await a.indexRepository({ root })
  const b = createCodeIndex({ database, models: modelsB, profile: profileB })
  const second = await b.indexRepository({ root })
  assert.notEqual(first.identity?.snapshotId, second.identity?.snapshotId)
  assert.notEqual(first.profileId, second.profileId)
  assert.ok(profileBEmbeddings > 0)
  assert.equal(
    (await b.searchCode({ root, query: 'vectorTarget', mode: 'hybrid' })).hits[0]?.profileId,
    second.profileId,
  )
  await a.close()
  await b.close()
})

test('a later generation wins out-of-order indexing and close aborts then joins owned jobs', async () => {
  const root = await repository()
  await writeFile(join(root, 'order.ts'), 'export const orderedSymbol = true')
  await commit(root, 'fixture')
  const profile = {
    provider: 'fixture',
    space: 'local-text-v1',
    model: 'order',
    dimensions: 2,
    inputType: 'text' as const,
    chunkerVersion: 'ts-ast-symbol-v1',
  }
  let calls = 0
  let release: (() => void) | undefined
  let firstStarted: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve
  })
  const models = {
    async embed({ texts }: { texts: string[] }) {
      calls++
      if (calls === 1) {
        firstStarted!()
        await gate
      }
      return texts.map(() => [1, 0])
    },
    async rerank({ documents }: { documents: string[] }) {
      return documents.map((_, index) => ({ index, score: 1 }))
    },
  }
  const { code } = await index(root, models, profile)
  const first = code.indexRepository({ root })
  const rejected = assert.rejects(
    first,
    (error: unknown) =>
      error instanceof CodeIndexError && error.code === 'CODE_INDEX_STALE_GENERATION',
  )
  await started
  await code.indexRepository({ root })
  release!()
  await rejected
  assert.equal((await code.indexStatus(root)).identity?.branch, 'master')
  await code.close()

  let abortStarted: (() => void) | undefined
  const abortSignal = new Promise<void>((resolve) => {
    abortStarted = resolve
  })
  const waitForAbort = {
    async embed({ signal }: { texts: string[]; signal: AbortSignal }) {
      abortStarted!()
      await new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      )
    },
    async rerank() {
      return []
    },
  }
  const joined = await index(root, waitForAbort, profile)
  const pendingIndex = joined.code.indexRepository({ root })
  const cancelled = assert.rejects(pendingIndex)
  await abortSignal
  await joined.code.close()
  await cancelled
})

test('close aborts and joins a pending search embedding as well as indexing work', async () => {
  const root = await repository()
  await writeFile(join(root, 'query.ts'), 'export function pendingQueryVector() { return 1 }')
  await commit(root, 'fixture')
  const profile = {
    provider: 'fixture',
    space: 'local-text-v1',
    model: 'query-close',
    dimensions: 2,
    inputType: 'text' as const,
    chunkerVersion: 'ts-ast-symbol-v1',
  }
  let embeddings = 0
  let waiting: (() => void) | undefined
  const queryStarted = new Promise<void>((resolve) => {
    waiting = resolve
  })
  const models = {
    async embed({ texts, signal }: { texts: string[]; signal: AbortSignal }) {
      embeddings++
      if (embeddings > 1) {
        waiting!()
        await new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        )
      }
      return texts.map(() => [1, 0])
    },
    async rerank({ documents }: { documents: string[] }) {
      return documents.map((_, index) => ({ index, score: 1 }))
    },
  }
  const { code } = await index(root, models, profile)
  await code.indexRepository({ root })
  const searching = code.searchCode({ root, query: 'pendingQueryVector', mode: 'hybrid' })
  const rejected = assert.rejects(searching)
  await queryStarted
  await code.close()
  await rejected
})

test('retains complete long lines and disambiguates anonymous statements', async () => {
  const text = `export const longValue = '${'x'.repeat(20_000)}'\nvoid 1;\nvoid 1;\n`
  const file = {
    path: 'long.ts',
    absolutePath: '/not-read/long.ts',
    text,
    hash: 'fixture',
    bytes: text.length,
  }
  const chunks = chunkCode(file, 1024).chunks
  assert.ok(chunks.length > 10)
  const joined = chunks.map((chunk) => chunk.text).join('')
  assert.equal(joined.length, text.length)
  assert.equal(joined.slice(-20), text.slice(-20))
  assert.equal(new Set(chunks.map((chunk) => chunk.id)).size, chunks.length)
  assert.ok(chunks.every((chunk) => chunk.lineStart >= 1 && chunk.lineEnd >= chunk.lineStart))
})

test('resolves tsconfig path mappings without reading outside the caller root', async () => {
  const root = await repository()
  await mkdir(join(root, 'src', 'lib'), { recursive: true })
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/lib/*'] } } }),
  )
  await writeFile(
    join(root, 'src', 'main.ts'),
    "import { aliased } from '@lib/target'\nexport const useAlias = aliased\n",
  )
  await writeFile(join(root, 'src', 'lib', 'target.ts'), 'export const aliased = true\n')
  await commit(root, 'fixture')
  const { code } = await index(root)
  await code.indexRepository({ root })
  assert.deepEqual((await code.relatedCode({ root, path: 'src/lib/target.ts' })).importedBy, [
    'src/main.ts',
  ])
})

test('scores camel-case identifiers by either word and observes nested changes after file events are missed', async () => {
  const root = await repository()
  await mkdir(join(root, 'nested'))
  await writeFile(join(root, 'nested', 'calls.ts'), 'export function fetchDocument() { return 1 }')
  await commit(root, 'fixture')
  const { code } = await index(root)
  await code.indexRepository({ root })
  assert.ok((await code.searchCode({ root, query: 'fetch' })).hits.length)
  assert.ok((await code.searchCode({ root, query: 'document' })).hits.length)
  const watcher = await code.watchRepository(root, { intervalMs: 250 })
  await writeFile(
    join(root, 'nested', 'late.ts'),
    'export function periodicReconcileTarget() { return 2 }',
  )
  await new Promise((resolve) => setTimeout(resolve, 450))
  assert.equal(
    (await code.searchCode({ root, query: 'periodicReconcileTarget' })).hits[0]?.path,
    'nested/late.ts',
  )
  const [firstClose, secondClose] = await Promise.all([watcher.close(), watcher.close()])
  assert.equal(firstClose, undefined)
  assert.equal(secondClose, undefined)
  await code.close()
})

test('rejects a pre-aborted watcher without retaining a watcher or job', async () => {
  const root = await repository()
  const { code } = await index(root)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    code.watchRepository(root, { signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
  await code.close()
})

test('chunk configuration changes invalidate the current snapshot and profile mismatch stays lexical', async () => {
  const root = await repository()
  await writeFile(join(root, 'config.ts'), 'export function configuredTarget() { return 1 }')
  await commit(root, 'fixture')
  const dataDir = await mkdtemp(join(tmpdir(), 'zorya-code-db-'))
  roots.push(dataDir)
  const database = await openEmbeddedDatabase(dataDir)
  databases.push(database)
  const lexical = createCodeIndex({ database, limits: { maxChunkChars: 64 } })
  const oldSnapshot = await lexical.indexRepository({ root })
  const changed = createCodeIndex({ database, limits: { maxChunkChars: 32 } })
  assert.equal((await changed.indexStatus(root)).identity, null)
  const newSnapshot = await changed.indexRepository({ root })
  assert.notEqual(newSnapshot.identity?.snapshotId, oldSnapshot.identity?.snapshotId)
  const profile = {
    provider: 'fixture',
    space: 'alternate/input-text',
    model: 'different',
    dimensions: 2,
    inputType: 'text' as const,
    chunkerVersion: 'ts-ast-symbol-v1',
  }
  let reranks = 0
  const models = {
    async embed({ texts }: { texts: string[] }) {
      return texts.map(() => [1, 0])
    },
    async rerank({ documents }: { documents: string[] }) {
      reranks++
      return documents.map((_, index) => ({ index, score: 1 }))
    },
  }
  const hybrid = createCodeIndex({ database, models, profile, limits: { maxChunkChars: 32 } })
  const status = await hybrid.indexStatus(root)
  assert.equal(status.denseAvailable, false)
  assert.match(status.denseDisabledReason ?? '', /профиль embedding не совпадает/iu)
  const found = await hybrid.searchCode({ root, query: 'configuredTarget', mode: 'hybrid' })
  assert.equal(found.degraded, true)
  assert.equal(reranks, 0)
  await lexical.close()
  await changed.close()
  await hybrid.close()
})

test('captures provider functions with the validated profile and permits embeddings without reranking', async () => {
  const root = await repository()
  await writeFile(join(root, 'ports.ts'), 'export function capturedEmbeddingTarget() { return 1 }')
  await commit(root, 'fixture')
  const dataDir = await mkdtemp(join(tmpdir(), 'zorya-code-db-'))
  roots.push(dataDir)
  const database = await openEmbeddedDatabase(dataDir)
  databases.push(database)
  const profile = {
    provider: 'fixture',
    space: 'stable-space',
    model: 'stable-model',
    dimensions: 2,
    inputType: 'text' as const,
    chunkerVersion: 'ts-ast-symbol-v1',
  }
  let originalCalls = 0
  let replacementCalls = 0
  const original = {
    async embed({ texts }: { texts: string[] }) {
      originalCalls++
      return texts.map(() => [1, 0])
    },
  }
  const replacement = {
    async embed({ texts }: { texts: string[] }) {
      replacementCalls++
      return texts.map(() => [0, 1])
    },
  }
  const options = { database, models: original, profile }
  const code = createCodeIndex(options)
  options.models = replacement
  await code.indexRepository({ root })
  const found = await code.searchCode({ root, query: 'capturedEmbeddingTarget' })
  assert.ok(originalCalls >= 2)
  assert.equal(replacementCalls, 0)
  assert.equal(found.hits[0]?.ranking.mode, 'hybrid')
  assert.equal(found.hits[0]?.ranking.rerankRank, null)
  await code.close()
})
