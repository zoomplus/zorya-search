import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { afterEach, test } from 'node:test'
import { openEmbeddedDatabase } from '../../src/storage/embedded.js'
import { createCodeIndex } from '../../src/code/index.js'
import { CodeIndexError } from '../../src/code/errors.js'
import { chunkCode, createLocalImportResolver } from '../../src/code/chunker.js'
import {
  prepareLexical,
  rankLexical,
  rankPreparedLexical,
  tokenizeCode,
} from '../../src/code/ranking.js'
import type { CodeIndexLimits } from '../../src/code/types.js'
import type { QueryableDatabase } from '../../src/storage/database.js'

const roots: string[] = []
const databases: { close(): Promise<void> }[] = []
const indexes: { close(): Promise<void> }[] = []
afterEach(async () => {
  const indexResults = await Promise.allSettled(indexes.splice(0).map((code) => code.close()))
  const databaseResults = await Promise.allSettled(databases.splice(0).map((database) => database.close()))
  const rootResults = await Promise.allSettled(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  const failures = [...indexResults, ...databaseResults, ...rootResults]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), 'CODE_INDEX_TEST_CLEANUP_FAILED')
})

function trackCodeIndex<T extends { close(): Promise<void> }>(code: T): T {
  indexes.push(code)
  return code
}

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
  exclude?: string[],
  rerankCandidateLimit?: number,
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'zorya-code-db-'))
  roots.push(dataDir)
  const database = await openEmbeddedDatabase(dataDir)
  databases.push(database)
  const code = trackCodeIndex(createCodeIndex({
    database,
    ...(models ? { models, profile } : {}),
    ...(limits ? { limits } : {}),
    ...(exclude ? { exclude } : {}),
    ...(rerankCandidateLimit === undefined ? {} : { rerankCandidateLimit }),
  }))
  return { database, code }
}

test('bounded rerank shortlist can promote a candidate beyond the requested output limit', async () => {
  const root = await repository()
  await writeFile(join(root, 'candidates.ts'), Array.from({ length: 12 }, (_, i) => `export function candidate${i}() { return "needle" }`).join('\n'))
  await commit(root, 'fixture')
  let offered = 0
  let requestedTopN: number | undefined
  const profile = { provider: 'mock', space: 'rerank-shortlist', model: 'fixture', dimensions: 2, inputType: 'text' as const, chunkerVersion: 'ts-ast-symbol-v1' }
  const { code } = await index(root, {
    async embed({ texts }) { return texts.map(() => [1, 0]) },
    async rerank({ documents, topN }) {
      offered = documents.length
      requestedTopN = topN
      return documents.map((_, index) => ({ index, score: index === documents.length - 1 ? 1 : 0 }))
    },
  }, profile, undefined, undefined, 10)
  await code.indexRepository({ root })
  const result = await code.searchCode({ root, query: 'needle', limit: 1 })
  assert.equal(offered, 10)
  assert.equal(requestedTopN, 1)
  assert.match(result.hits[0]?.path ?? '', /candidates\.ts$/u)
  assert.ok((result.hits[0]?.lineStart ?? 0) > 1)
  assert.equal(result.hits.length, 1)
})

test('exact symbol queries put AST declarations first while retaining usages and respecting filters', async () => {
  const root = await repository()
  await writeFile(join(root, 'a-usage.ts'), `export function chatter() { return ${'exactTarget + '.repeat(24)}0 }\n`)
  await writeFile(join(root, 'z-declaration.ts'), 'export function exactTarget() { return 1 }\n')
  await writeFile(join(root, 'other.js'), 'export function exactTarget() { return 2 }\n')
  await writeFile(join(root, 'dollar.js'), 'export function $() { return 3 }\n')
  await commit(root, 'exact declaration fixture')
  const { code } = await index(root)
  await code.indexRepository({ root })

  const all = await code.searchCode({ root, query: ' exactTarget ', mode: 'lexical', limit: 8 })
  assert.equal(all.hits[0]?.path, 'other.js')
  assert.equal(all.hits[0]?.symbol, 'exactTarget')
  assert.ok(all.hits.some((hit) => hit.path === 'a-usage.ts' && hit.symbol === 'chatter'))
  assert.equal(
    (await code.searchCode({ root, query: 'exactTarget', mode: 'lexical', limit: 1 })).hits[0]?.path,
    'other.js',
  )
  const scoped = await code.searchCode({
    root,
    query: 'exactTarget',
    mode: 'lexical',
    paths: ['z-declaration.ts'],
    language: 'ts',
    limit: 8,
  })
  assert.deepEqual(scoped.hits.map((hit) => hit.path), ['z-declaration.ts'])
  assert.equal((await code.searchCode({ root, query: 'ExactTarget', mode: 'lexical' })).hits[0]?.symbol, 'chatter')
  assert.ok((await code.searchCode({ root, query: 'exactTarget suffix', mode: 'lexical' })).hits[0]?.symbol !== 'exactTarget')
  assert.deepEqual((await code.searchCode({ root, query: 'noSuchSymbol', mode: 'lexical' })).hits, [])
  const dollar = await code.searchCode({ root, query: '$', mode: 'lexical', limit: 1 })
  assert.equal(dollar.hits[0]?.symbol, '$')
  assert.equal(
    (await code.readSource({ root, path: dollar.hits[0]!.path, lineStart: dollar.hits[0]!.lineStart })).stale,
    false,
  )
  await code.close()
})

test('exact declarations survive hybrid candidate caps and adversarial reranking', async () => {
  const root = await repository()
  await writeFile(join(root, 'usage.ts'), `export function chatter() { return ${'hybridTarget + '.repeat(24)}0 }\n`)
  await writeFile(join(root, 'declaration.ts'), 'export function hybridTarget() { return 1 }\n')
  await commit(root, 'hybrid exact declaration fixture')
  const profile = {
    provider: 'mock', space: 'exact-declaration', model: 'fixture', dimensions: 2,
    inputType: 'text' as const, chunkerVersion: 'ts-ast-symbol-v1',
  }
  let offeredDocuments: string[] = []
  const { code } = await index(root, {
    async embed({ texts }) {
      return texts.map((text) =>
        text.includes('export function hybridTarget') ? [1, 0] : [0, 1],
      )
    },
    async rerank({ documents }) {
      offeredDocuments = [...documents]
      return documents.map((_, index) => ({ index, score: index }))
    },
  }, profile, undefined, undefined, 1)
  await code.indexRepository({ root })
  const result = await code.searchCode({ root, query: 'hybridTarget', mode: 'hybrid', limit: 3 })
  assert.equal(result.hits[0]?.path, 'declaration.ts')
  assert.equal(result.hits[0]?.ranking.mode, 'hybrid')
  assert.equal(result.hits[0]?.ranking.rerankRank, null)
  assert.equal(result.hits[1]?.path, 'usage.ts')
  assert.equal(result.hits[1]?.ranking.rerankRank, 1)
  assert.equal(offeredDocuments.length, 1)
  await code.close()
})

test('exact symbol promotion keeps first class chunks and overload declarations in source order', async () => {
  const root = await repository()
  await writeFile(
    join(root, 'symbols.ts'),
    [
      'export function overloadedTarget(value: string): string',
      'export function overloadedTarget(value: number): number',
      'export function overloadedTarget(value: string | number) { return value }',
      'export class SplitTarget {',
      ...Array.from({ length: 20 }, (_, index) => `  method${index}() { return ${index} }`),
      '}',
    ].join('\n'),
  )
  await writeFile(join(root, 'other-class.ts'), 'export class SplitTarget { close() {} }\n')
  await commit(root, 'overload and split declaration fixture')
  const { code } = await index(root, undefined, undefined, { maxChunkChars: 96 })
  await code.indexRepository({ root })

  const overloads = await code.searchCode({ root, query: 'overloadedTarget', mode: 'lexical', limit: 8 })
  assert.deepEqual(
    overloads.hits.filter((hit) => hit.symbol?.startsWith('overloadedTarget')).map((hit) => hit.symbol),
    ['overloadedTarget', 'overloadedTarget@2', 'overloadedTarget@3'],
  )
  const classChunks = await code.searchCode({ root, query: 'SplitTarget', mode: 'lexical', limit: 8 })
  const matchedChunks = classChunks.hits.filter((hit) => hit.symbol?.startsWith('SplitTarget'))
  assert.equal(matchedChunks[0]?.symbol, 'SplitTarget')
  const boundedClassChunks = await code.searchCode({ root, query: 'SplitTarget', mode: 'lexical', limit: 2 })
  assert.deepEqual(boundedClassChunks.hits.map((hit) => hit.symbol), ['SplitTarget', 'SplitTarget'])
  assert.deepEqual(
    boundedClassChunks.hits.map((hit) => hit.path),
    ['other-class.ts', 'symbols.ts'],
  )
  await code.close()
})

test('exact declaration resolves past a leading comment chunk using current full-file AST source', async () => {
  const root = await repository()
  const source = `/*${'leading comment '.repeat(900)}*/\nexport function ExactDeclAfterComment() { return 1 }\n`
  await writeFile(join(root, 'commented.ts'), source)
  await commit(root, 'long leading comment fixture')
  const originalChunks = chunkCode(
    {
      path: 'commented.ts',
      absolutePath: join(root, 'commented.ts'),
      text: source,
      hash: '',
      bytes: Buffer.byteLength(source),
    },
    8000,
  ).chunks
  const { code } = await index(root, undefined, undefined, { maxChunkChars: 8000 })
  const indexed = await code.indexRepository({ root })

  const result = await code.searchCode({
    root,
    query: 'ExactDeclAfterComment',
    mode: 'lexical',
    limit: 1,
  })
  assert.equal(result.identity.snapshotId, indexed.identity?.snapshotId)
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0]?.symbol, 'ExactDeclAfterComment#2')
  assert.equal(
    result.hits[0]?.id,
    originalChunks.find((chunk) => chunk.symbol === 'ExactDeclAfterComment#2')?.id,
  )
  assert.ok(result.hits[0]!.lineStart <= 2 && result.hits[0]!.lineEnd >= 2)
  const declarationLine = await code.readSource({
    root,
    path: result.hits[0]!.path,
    lineStart: 2,
    lineEnd: 2,
    snapshotId: result.hits[0]!.snapshotId,
  })
  assert.equal(declarationLine.text, 'export function ExactDeclAfterComment() { return 1 }')
  await code.close()
})

test('exact declaration resolution refuses a candidate file changed after corpus read', async () => {
  const root = await repository()
  const path = join(root, 'changing.ts')
  await writeFile(path, 'export function ChangingDeclaration() { return 1 }\n')
  await commit(root, 'source mutation fixture')
  const dataDir = await mkdtemp(join(tmpdir(), 'zorya-code-db-'))
  roots.push(dataDir)
  const rawDatabase = await openEmbeddedDatabase(dataDir)
  databases.push(rawDatabase)
  let mutateAfterCorpusRead = false
  const database: QueryableDatabase = {
    query: async (sql, values) => {
      const result = await rawDatabase.query(sql, values)
      if (mutateAfterCorpusRead && /FROM zorya_code_chunks c WHERE c\.snapshot_id=\$1/iu.test(sql)) {
        mutateAfterCorpusRead = false
        await writeFile(path, 'export function ChangingDeclaration() { return 2 }\n')
      }
      return result
    },
    exec: (sql) => rawDatabase.exec(sql),
    transaction: (operation, signal) => rawDatabase.transaction(operation, signal),
  }
  const code = trackCodeIndex(createCodeIndex({ database }))
  await code.indexRepository({ root })
  mutateAfterCorpusRead = true

  await assert.rejects(
    code.searchCode({ root, query: 'ChangingDeclaration', mode: 'lexical', limit: 1 }),
    (error: unknown) =>
      error instanceof CodeIndexError && error.code === 'CODE_INDEX_SOURCE_CHANGED',
  )
  await code.close()
})

test('read snapshots preserve dense results, rerank inputs, cancellation ownership, and admission limits', async () => {
  const root = await repository()
  await writeFile(join(root, 'first.ts'), 'export const sharedNeedle = "first"\n')
  await writeFile(join(root, 'second.ts'), 'export const sharedNeedle = "second"\n')
  await commit(root, 'scoped read fixture')

  const rerankCalls: Array<{ query: string; documents: string[] }> = []
  let heldQuery: string | undefined
  let queryStarted: (() => void) | undefined
  let heldQueryRelease: (() => void) | undefined
  let releaseHeldQuery = false
  let observedQuerySignal: AbortSignal | undefined
  let settledAborts = 0
  const profile = {
    provider: 'fixture',
    space: 'scoped-dense',
    model: 'fixture',
    dimensions: 2,
    inputType: 'text' as const,
    chunkerVersion: 'ts-ast-symbol-v1',
  }
  const { code } = await index(
    root,
    {
      async embed({ texts, signal }) {
        if (texts.length === 1 && texts[0] === heldQuery) {
          observedQuerySignal = signal
          queryStarted?.()
          await new Promise<never>((_resolve, reject) => {
            const finishOnAbort = () => setTimeout(() => {
              settledAborts++
              reject(signal.reason)
            }, 8)
            const finishOnRelease = () => {
              signal.removeEventListener('abort', finishOnAbort)
              heldQueryRelease = undefined
              _resolve()
            }
            signal.addEventListener(
              'abort',
              finishOnAbort,
              { once: true },
            )
            if (releaseHeldQuery) heldQueryRelease = finishOnRelease
          })
        }
        return texts.map(() => [1, 0])
      },
      async rerank({ query, documents }) {
        rerankCalls.push({ query, documents: [...documents] })
        return documents
          .map((_, position) => ({ index: position, score: documents.length - position }))
          .reverse()
      },
    },
    profile,
  )
  await code.indexRepository({ root })

  const queries = ['sharedNeedle', 'first']
  const before = await Promise.all(
    queries.map((query) => code.searchCode({ root, query, mode: 'hybrid', limit: 8 })),
  )
  const beforeRerank = rerankCalls.splice(0)
  let retained: Pick<CodeIndex, 'indexStatus' | 'searchCode' | 'readSource' | 'relatedCode'> | undefined
  const after = await code.withReadSnapshot!(root, new AbortController().signal, async (scoped) => {
    retained = scoped
    const status = await scoped.indexStatus(root)
    status.identity!.snapshotId = 'mutated-by-caller'
    const results = await Promise.all(
      queries.map((query) => scoped.searchCode({ root, query, mode: 'hybrid', limit: 8 })),
    )
    assert.equal((await scoped.indexStatus(root)).identity?.snapshotId, before[0]!.identity.snapshotId)
    return results
  })
  assert.deepEqual(after, before)
  assert.deepEqual(
    [...rerankCalls].sort((a, b) => a.query.localeCompare(b.query)),
    [...beforeRerank].sort((a, b) => a.query.localeCompare(b.query)),
  )
  const filteredInputs = [
    { root, query: 'sharedNeedle', mode: 'lexical' as const, paths: ['first.ts'], limit: 8 },
    { root, query: 'sharedNeedle', mode: 'lexical' as const, language: 'typescript', limit: 8 },
    { root, query: 'sharedNeedle', mode: 'lexical' as const, paths: ['missing.ts'], limit: 8 },
  ]
  const scopedFiltered = await code.withReadSnapshot!(
    root,
    new AbortController().signal,
    async (scoped) => {
      await scoped.searchCode({ root, query: 'sharedNeedle', mode: 'lexical' })
      await scoped.searchCode({ root, query: 'sharedNeedle', mode: 'hybrid' })
      return Promise.all(filteredInputs.map((input) => scoped.searchCode(input)))
    },
  )
  const directFiltered = await Promise.all(filteredInputs.map((input) => code.searchCode(input)))
  assert.deepEqual(scopedFiltered, directFiltered)
  const filteredFirst = await code.withReadSnapshot!(
    root,
    new AbortController().signal,
    (scoped) => Promise.all(filteredInputs.map((input) => scoped.searchCode(input))),
  )
  assert.deepEqual(filteredFirst, directFiltered)
  let joinedChild: ReturnType<CodeIndex['searchCode']> | undefined
  await code.withReadSnapshot!(root, new AbortController().signal, async (scoped) => {
    joinedChild = scoped.searchCode({ root, query: 'first', mode: 'hybrid', limit: 8 })
  })
  assert.ok((await joinedChild!).hits.length > 0)
  await assert.rejects(
    retained!.indexStatus(root),
    (error: unknown) => error instanceof CodeIndexError && error.code === 'CODE_INDEX_STALE',
  )

  const statuses = await code.withReadSnapshot!(root, new AbortController().signal, async (scoped) =>
    Promise.allSettled(Array.from({ length: 64 }, () => scoped.indexStatus(root))),
  )
  assert.equal(statuses.filter((result) => result.status === 'fulfilled').length, 63)
  assert.equal(statuses.filter((result) => result.status === 'rejected').length, 1)
  assert.equal(
    (statuses.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason.message,
    'CODE_INDEX_BUSY',
  )

  const armQuery = (query: string, waitForRelease = false) => {
    heldQuery = query
    releaseHeldQuery = waitForRelease
    return new Promise<void>((resolveStarted) => {
      queryStarted = resolveStarted
    })
  }
  const startSearch = (scoped: Pick<CodeIndex, 'searchCode'>, query: string, signal?: AbortSignal) =>
    scoped.searchCode({ root, query, mode: 'hybrid', ...(signal ? { signal } : {}) })

  const parentQuery = 'cancel-parent-owned-signal'
  const parentAbort = new AbortController()
  const parentReason = new Error('parent aborted')
  const parentStarted = armQuery(parentQuery)
  const parentWork = code.withReadSnapshot!(root, parentAbort.signal, async (scoped) => {
    const pending = startSearch(scoped, parentQuery)
    await parentStarted
    parentAbort.abort(parentReason)
    await pending
  })
  await assert.rejects(parentWork, (error: unknown) => error === parentReason)
  assert.equal(observedQuerySignal?.aborted, true)
  assert.ok(settledAborts >= 1)

  const independentQuery = 'cancel-independent-signal'
  const independentStarted = armQuery(independentQuery)
  await code.withReadSnapshot!(root, new AbortController().signal, async (scoped) => {
    const independent = new AbortController()
    const pending = startSearch(scoped, independentQuery, independent.signal)
    await independentStarted
    assert.ok(observedQuerySignal)
    const independentReason = new Error('call aborted')
    independent.abort(independentReason)
    await assert.rejects(pending, (error: unknown) => error === independentReason)
    assert.equal(observedQuerySignal?.aborted, true)
    assert.ok((await scoped.indexStatus(root)).identity)
  })
  assert.ok(settledAborts >= 2)

  const callbackQuery = 'cancel-callback-failure'
  const callbackStarted = armQuery(callbackQuery)
  const callbackError = new Error('callback failed')
  const callbackFailure = code.withReadSnapshot!(root, new AbortController().signal, async (scoped) => {
    void startSearch(scoped, callbackQuery)
    await callbackStarted
    throw callbackError
  })
  await assert.rejects(callbackFailure, (error: unknown) => error === callbackError)
  assert.ok(settledAborts >= 3)

  const alias = await temp()
  await rm(alias, { recursive: true, force: true })
  await symlink(root, alias)
  const foreign = await repository()
  await writeFile(join(foreign, 'foreign.ts'), 'export const foreignRootContent = true\n')
  await commit(foreign, 'foreign fixture')
  await code.withReadSnapshot!(root, new AbortController().signal, async (scoped) => {
    assert.equal((await scoped.indexStatus(alias)).identity?.snapshotId, before[0]!.identity.snapshotId)
    await assert.rejects(
      scoped.readSource({ root: foreign, path: 'foreign.ts' }),
      (error: unknown) => error instanceof CodeIndexError && error.code === 'CODE_INDEX_STALE',
    )
  })

  const aliasQuery = 'wait-release-alias-retarget'
  const aliasStarted = armQuery(aliasQuery, true)
  const aliasWork = code.withReadSnapshot!(alias, new AbortController().signal, (scoped) =>
    scoped.searchCode({ root: alias, query: aliasQuery, mode: 'hybrid' }),
  )
  await aliasStarted
  await rm(alias)
  await symlink(foreign, alias)
  heldQueryRelease?.()
  await assert.rejects(
    aliasWork,
    (error: unknown) => error instanceof CodeIndexError && error.code === 'CODE_INDEX_SOURCE_CHANGED_DURING_SEARCH',
  )

  const publishQuery = 'wait-release-index-publish'
  const publishStarted = armQuery(publishQuery, true)
  const publishWork = code.withReadSnapshot!(root, new AbortController().signal, (scoped) =>
    scoped.searchCode({ root, query: publishQuery, mode: 'hybrid' }),
  )
  await publishStarted
  await writeFile(join(root, 'first.ts'), 'export const changedDuringSearch = "new snapshot"\n')
  const published = await code.indexRepository({ root })
  assert.notEqual(published.identity?.snapshotId, before[0]!.identity.snapshotId)
  heldQueryRelease?.()
  await assert.rejects(
    publishWork,
    (error: unknown) => error instanceof CodeIndexError && error.code === 'CODE_INDEX_SOURCE_CHANGED_DURING_SEARCH',
  )

  const closeQuery = 'cancel-index-close'
  const closeStarted = armQuery(closeQuery)
  const closeWork = code.withReadSnapshot!(root, new AbortController().signal, (scoped) =>
    scoped.searchCode({ root, query: closeQuery, mode: 'hybrid' }),
  )
  await closeStarted
  const closing = code.close()
  await assert.rejects(closeWork)
  await closing
  assert.ok(settledAborts >= 4)
})

function countCodeWrites(database: QueryableDatabase) {
  let writes = 0
  const wrap = (client: QueryableDatabase): QueryableDatabase => ({
    query(sql, values) {
      if (/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?zorya_code_/iu.test(sql)) writes++
      return client.query(sql, values)
    },
    exec(sql) {
      return client.exec(sql)
    },
    transaction(operation, signal) {
      return client.transaction((transaction) => operation(wrap(transaction)), signal)
    },
  })
  return {
    database: wrap(database),
    writes: () => writes,
    reset: () => {
      writes = 0
    },
  }
}

test('excludes tracked lockfiles by default while retaining ordinary JSON documentation', async () => {
  const root = await repository()
  await mkdir(join(root, 'docs', 'evidence'), { recursive: true })
  await mkdir(join(root, 'nested'), { recursive: true })
  await writeFile(join(root, 'pnpm-lock.yaml'), 'x'.repeat(1_100_000))
  await writeFile(join(root, 'nested', 'package-lock.json'), '{}')
  await writeFile(join(root, 'docs', 'evidence', 'summary.json'), '{"meaningfulEvidence":true}')
  await writeFile(join(root, 'src.ts'), 'export const visibleSource = true')
  await commit(root, 'fixture')
  const { code } = await index(root)
  const indexed = await code.indexRepository({ root })
  assert.equal(indexed.fileCount, 2)
  assert.equal(
    (await code.searchCode({ root, query: 'meaningfulEvidence' })).hits[0]?.path,
    'docs/evidence/summary.json',
  )
  await assert.rejects(
    code.readSource({ root, path: 'pnpm-lock.yaml' }),
    (error: unknown) =>
      error instanceof CodeIndexError && error.code === 'CODE_INDEX_PATH_OUTSIDE_ROOT',
  )
  await code.close()

  const loose = await temp()
  await mkdir(join(loose, 'docs', 'evidence'), { recursive: true })
  await writeFile(join(loose, 'yarn.lock'), 'x'.repeat(1_100_000))
  await writeFile(join(loose, 'docs', 'evidence', 'summary.json'), '{"meaningfulEvidence":true}')
  await writeFile(join(loose, 'src.ts'), 'export const visibleSource = true')
  const nonGit = await index(loose)
  assert.equal((await nonGit.code.indexRepository({ root: loose })).fileCount, 2)
  await nonGit.code.close()
})

test('explicit exclusions apply to tracked and non-git files and reject excluded reads and relations', async () => {
  const tracked = await repository()
  await mkdir(join(tracked, 'docs', 'evidence'), { recursive: true })
  await writeFile(
    join(tracked, 'docs', 'evidence', 'large-report.json'),
    '{"shouldNotAppear":true}',
  )
  await writeFile(join(tracked, 'src.ts'), 'export function retainedTarget() { return true }')
  await commit(tracked, 'fixture')
  const gitIndex = await index(tracked, undefined, undefined, undefined, ['docs/evidence/**'])
  assert.equal((await gitIndex.code.indexRepository({ root: tracked })).fileCount, 1)
  await assert.rejects(
    gitIndex.code.readSource({ root: tracked, path: 'docs/evidence/large-report.json' }),
    (error: unknown) =>
      error instanceof CodeIndexError && error.code === 'CODE_INDEX_PATH_OUTSIDE_ROOT',
  )
  await assert.rejects(
    gitIndex.code.readSource({ root: tracked, path: './docs/evidence/large-report.json' }),
    (error: unknown) =>
      error instanceof CodeIndexError && error.code === 'CODE_INDEX_PATH_OUTSIDE_ROOT',
  )
  await assert.rejects(
    gitIndex.code.relatedCode({ root: tracked, path: 'docs/evidence/large-report.json' }),
    (error: unknown) =>
      error instanceof CodeIndexError && error.code === 'CODE_INDEX_SOURCE_UNAVAILABLE',
  )

  const loose = await temp()
  await mkdir(join(loose, 'docs', 'evidence'), { recursive: true })
  await writeFile(join(loose, 'docs', 'evidence', 'large-report.json'), '{"shouldNotAppear":true}')
  await writeFile(join(loose, 'src.ts'), 'export function retainedTarget() { return true }')
  const nonGitIndex = await index(loose, undefined, undefined, undefined, ['docs/evidence/**'])
  assert.equal((await nonGitIndex.code.indexRepository({ root: loose })).fileCount, 1)
  assert.deepEqual(
    (await nonGitIndex.code.searchCode({ root: loose, query: 'shouldNotAppear' })).hits,
    [],
  )
  await gitIndex.code.close()
  await nonGitIndex.code.close()
})

test('exclusion policy is copied, invalidates old snapshots, and cannot negate hard exclusions', async () => {
  const root = await repository()
  await mkdir(join(root, 'docs', 'evidence'), { recursive: true })
  await writeFile(join(root, 'docs', 'evidence', 'summary.json'), '{"uniqueEvidenceNeedle":true}')
  await writeFile(join(root, 'src.ts'), 'export function currentSource() { return true }')
  await commit(root, 'fixture')
  const first = await index(root)
  await first.code.indexRepository({ root })

  const exclusion = ['docs/evidence/**']
  const second = trackCodeIndex(createCodeIndex({ database: first.database, exclude: exclusion }))
  exclusion.splice(0, exclusion.length)
  const pending = await second.indexStatus(root)
  assert.equal(pending.identity, null)
  await assert.rejects(
    second.searchCode({ root, query: 'currentSource' }),
    (error: unknown) => error instanceof CodeIndexError && error.code === 'CODE_INDEX_STALE',
  )
  assert.equal((await second.indexRepository({ root })).fileCount, 1)
  assert.deepEqual((await second.searchCode({ root, query: 'uniqueEvidenceNeedle' })).hits, [])
  assert.throws(
    () => createCodeIndex({ database: first.database, exclude: ['!**/.env'] }),
    (error: unknown) =>
      error instanceof CodeIndexError && error.code === 'CODE_INDEX_EXCLUSION_POLICY_INVALID',
  )
  await second.close()
  await first.code.close()
})

test('oversized eligible files report bounded relative path and byte limits', async () => {
  const root = await repository()
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'large.ts'), '0123456789')
  await commit(root, 'fixture')
  const { code } = await index(root, undefined, undefined, { maxFileBytes: 5 })
  await assert.rejects(code.indexRepository({ root }), (error: unknown) => {
    assert.ok(error instanceof CodeIndexError)
    assert.equal(error.code, 'CODE_INDEX_FILE_SIZE_LIMIT')
    assert.deepEqual(error.details, { path: 'src/large.ts', actualBytes: 10, allowedBytes: 5 })
    assert.equal(error.message.includes('0123456789'), false)
    return true
  })
  await code.close()
})

test('rejects malformed exclusion policies', async () => {
  const root = await temp()
  const { database, code } = await index(root)
  for (const exclude of [
    ['!src/**'],
    ['!**/.env'],
    ['unused\n!**/pnpm-lock.yaml'],
    ['C:/absolute/**'],
    ['/absolute/**'],
    ['../outside/**'],
    ['x'.repeat(513)],
    Array.from({ length: 129 }, (_, index) => `pattern-${index}`),
  ]) {
    assert.throws(
      () => createCodeIndex({ database, exclude }),
      (error: unknown) =>
        error instanceof CodeIndexError && error.code === 'CODE_INDEX_EXCLUSION_POLICY_INVALID',
    )
  }
  await code.close()
})
async function commit(root: string, message: string): Promise<void> {
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', message)
}

function referenceResolveLocalImport(
  root: string,
  fromPath: string,
  specifier: string,
  knownPaths: Set<string>,
  contents: Map<string, string>,
  paths?: Record<string, string[]>,
  baseUrl = '.',
): string | null {
  const canonicalPath = (path: string) =>
    process.platform === 'win32' ? resolve(path).toLocaleLowerCase() : resolve(path)
  const absolutePaths = new Set([...knownPaths].map((path) => canonicalPath(resolve(root, path))))
  const host: ts.ModuleResolutionHost = {
    fileExists: (path) => absolutePaths.has(canonicalPath(path)),
    readFile: (path) => {
      const absolute = resolve(path)
      if (!absolutePaths.has(canonicalPath(absolute))) return undefined
      return contents.get(relative(root, absolute).split('\\').join('/'))
    },
    directoryExists: (path) =>
      [...absolutePaths].some((candidate) => candidate.startsWith(`${canonicalPath(path)}${sep}`)),
    getCurrentDirectory: () => root,
    realpath: (path) => resolve(path),
  }
  const resolved = ts.resolveModuleName(
    specifier,
    resolve(root, fromPath),
    {
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      module: ts.ModuleKind.NodeNext,
      allowJs: true,
      baseUrl: resolve(root, baseUrl),
      ...(paths ? { paths } : {}),
    },
    host,
  ).resolvedModule?.resolvedFileName
  if (resolved) {
    const relativePath = relative(root, resolve(resolved)).split('\\').join('/')
    if (knownPaths.has(relativePath) && !relativePath.startsWith('../')) return relativePath
  }
  if (!specifier.startsWith('.')) return null
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier))
  const candidates = [
    base,
    ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'].map(
      (ext) => `${base}${ext}`,
    ),
    ...['index.ts', 'index.tsx', 'index.js', 'index.jsx'].map((name) => posix.join(base, name)),
  ]
  const stripped = base.replace(/\.(?:mjs|cjs|js|jsx)$/u, '')
  candidates.push(...['.ts', '.tsx', '.mts', '.cts'].map((ext) => `${stripped}${ext}`))
  return candidates.find((candidate) => knownPaths.has(candidate)) ?? null
}

function referenceRankLexical<
  T extends { id: string; path: string; symbol: string | null; text: string; lineStart: number },
>(rows: T[], query: string) {
  const queryTokens = tokenizeCode(query)
  const documentFrequency = new Map<string, number>()
  for (const row of rows)
    for (const token of new Set(tokenizeCode(`${row.path} ${row.symbol ?? ''} ${row.text}`)))
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
  const averageLength =
    rows.reduce((sum, row) => sum + tokenizeCode(row.text).length, 0) / Math.max(1, rows.length)
  return rows
    .map((row) => {
      const terms = tokenizeCode(`${row.path} ${row.symbol ?? ''} ${row.text}`)
      const frequency = new Map<string, number>()
      for (const term of terms) frequency.set(term, (frequency.get(term) ?? 0) + 1)
      const score = queryTokens.reduce((sum, term) => {
        const termFrequency = frequency.get(term) ?? 0
        if (!termFrequency) return sum
        const documents = documentFrequency.get(term) ?? 0
        const inverseDocumentFrequency = Math.log(
          1 + (rows.length - documents + 0.5) / (documents + 0.5),
        )
        return (
          sum +
          (inverseDocumentFrequency * (termFrequency * 2.2)) /
            (termFrequency + 1.2 * (0.25 + (0.75 * terms.length) / Math.max(1, averageLength)))
        )
      }, 0)
      return { row, score }
    })
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.row.path.localeCompare(right.row.path) ||
        left.row.lineStart - right.row.lineStart,
    )
}

test('scoped import resolver matches prior alias, relative, missing, add, and delete outcomes', () => {
  const root = '/virtual/search-fixture'
  const initialPaths = new Set(['src/main.ts', 'src/lib/target.ts', 'src/lib/entry/index.ts'])
  const initialContents = new Map([...initialPaths].map((path) => [path, 'export const value = 1']))
  const paths = { '@lib/*': ['src/lib/*'] }
  const compare = (knownPaths: Set<string>, contents: Map<string, string>, specifier: string) => {
    const scoped = createLocalImportResolver(root, knownPaths, contents, paths, '.')
    assert.equal(
      scoped('src/main.ts', specifier),
      referenceResolveLocalImport(root, 'src/main.ts', specifier, knownPaths, contents, paths, '.'),
      specifier,
    )
  }

  for (const specifier of [
    '@lib/target',
    './lib/target.js',
    './lib/entry',
    './missing.js',
    'external-package',
  ])
    compare(initialPaths, initialContents, specifier)
  assert.equal(
    createLocalImportResolver(
      root,
      initialPaths,
      initialContents,
      paths,
    )('src/main.ts', '@lib/target'),
    'src/lib/target.ts',
  )
  assert.equal(
    createLocalImportResolver(root, initialPaths, initialContents)('src/main.ts', './missing.js'),
    null,
  )

  const addedPaths = new Set([...initialPaths, 'src/new.ts'])
  const addedContents = new Map([...initialContents, ['src/new.ts', 'export const newValue = 1']])
  compare(addedPaths, addedContents, './new.js')
  assert.equal(
    createLocalImportResolver(root, addedPaths, addedContents)('src/main.ts', './new.js'),
    'src/new.ts',
  )

  const deletedPaths = new Set(addedPaths)
  deletedPaths.delete('src/new.ts')
  const deletedContents = new Map(addedContents)
  deletedContents.delete('src/new.ts')
  compare(deletedPaths, deletedContents, './new.js')
  assert.equal(
    createLocalImportResolver(root, deletedPaths, deletedContents)('src/main.ts', './new.js'),
    null,
  )
})

test('prepared lexical ranking matches the prior BM25 scores and order exactly', () => {
  const rows = [
    {
      id: '1',
      path: 'src/fetchDocument.ts',
      symbol: 'fetchDocument',
      text: 'fetch data from источника',
      lineStart: 3,
    },
    {
      id: '2',
      path: 'docs/document.md',
      symbol: null,
      text: 'document fetch fetch from cache',
      lineStart: 1,
    },
    {
      id: '3',
      path: 'src/fetch.ts',
      symbol: 'fetch',
      text: 'document response source',
      lineStart: 8,
    },
    {
      id: '4',
      path: 'src/fetch.ts',
      symbol: 'fetch',
      text: 'document response source',
      lineStart: 12,
    },
    {
      id: '5',
      path: 'lib/unrelated.ts',
      symbol: 'otherThing',
      text: 'ничего общего',
      lineStart: 1,
    },
  ]
  for (const query of ['fetch document', 'fetchDocument', 'источника', 'nonexistent'])
    assert.deepEqual(rankLexical(rows, query), referenceRankLexical(rows, query), query)
})

test('prepared lexical corpus preserves filtered BM25 scores and order across queries', () => {
  const rows = [
    {
      id: '1',
      path: 'src/fetchDocument.ts',
      symbol: 'fetchDocument',
      language: 'typescript',
      text: 'fetch data from источника',
      lineStart: 3,
    },
    {
      id: '2',
      path: 'docs/document.md',
      symbol: null,
      language: 'markdown',
      text: 'document fetch fetch from cache',
      lineStart: 1,
    },
    {
      id: '3',
      path: 'src/fetch.ts',
      symbol: 'fetch',
      language: 'typescript',
      text: 'document response source',
      lineStart: 8,
    },
    {
      id: '4',
      path: 'src/fetch.ts',
      symbol: 'fetch',
      language: 'typescript',
      text: 'document response source',
      lineStart: 12,
    },
    {
      id: '5',
      path: 'docs/город.md',
      symbol: null,
      language: 'markdown',
      text: 'источника документ',
      lineStart: 1,
    },
  ]
  const prepared = prepareLexical(rows)
  const filters: Array<(row: (typeof rows)[number]) => boolean> = [
    () => true,
    (row) => row.language === 'typescript',
    (row) => row.path.startsWith('docs/'),
    (row) => row.path === 'src/fetch.ts',
    () => false,
  ]
  for (const query of ['fetch fetch document', 'fetchDocument', 'источника документ', 'missing']) {
    for (const include of filters) {
      const subset = rows.filter(include)
      assert.deepEqual(
        rankPreparedLexical(prepared, query, include),
        referenceRankLexical(subset, query),
        `${query} / ${subset.map((row) => row.path).join(',')}`,
      )
    }
  }
})

test('unchanged reindex validates current identity without parsing, embedding, or publishing again', async () => {
  const root = await repository()
  await writeFile(join(root, 'service.ts'), 'export function unchangedTarget() { return 1 }')
  await commit(root, 'fixture')
  const dataDir = await mkdtemp(join(tmpdir(), 'zorya-code-db-'))
  roots.push(dataDir)
  const database = await openEmbeddedDatabase(dataDir)
  databases.push(database)
  const tracked = countCodeWrites(database)
  const profile = {
    provider: 'fixture',
    space: 'perf-stable-v1',
    model: 'perf-stable',
    dimensions: 2,
    inputType: 'text' as const,
    chunkerVersion: 'ts-ast-symbol-v1',
  }
  let embeddingCalls = 0
  const code = trackCodeIndex(createCodeIndex({
    database: tracked.database,
    profile,
    models: {
      async embed({ texts }) {
        embeddingCalls++
        return texts.map(() => [1, 0])
      },
    },
  }))
  await code.indexRepository({ root })
  const before = await code.indexStatus(root)
  assert.ok(embeddingCalls > 0)
  const beforeEmbeddingCalls = embeddingCalls
  tracked.reset()
  const repeated = await code.indexRepository({ root })
  const after = await code.indexStatus(root)
  assert.equal(repeated.identity?.snapshotId, before.identity?.snapshotId)
  assert.equal(repeated.indexedAt, before.indexedAt)
  assert.equal(after.indexedAt, before.indexedAt)
  assert.equal(embeddingCalls, beforeEmbeddingCalls)
  assert.equal(tracked.writes(), 0)
  await code.close()
})

test('reuses only durably settled vectors after restart and publishes the complete snapshot', async () => {
  const root = await repository()
  await Promise.all(Array.from({ length: 84 }, (_, index) =>
    writeFile(join(root, `resume-${index}.ts`), `export function resumeTarget${index}() { return ${index} }\n`),
  ))
  await commit(root, 'fixture')
  const dataDir = await mkdtemp(join(tmpdir(), 'zorya-code-db-'))
  roots.push(dataDir)
  const database = await openEmbeddedDatabase(dataDir)
  databases.push(database)
  const profile = {
    provider: 'fixture', space: 'resume-v1', model: 'resume-model', dimensions: 2,
    inputType: 'text' as const, chunkerVersion: 'ts-ast-symbol-v1',
  }
  const firstBatches: number[] = []
  const first = trackCodeIndex(createCodeIndex({
    database, profile,
    models: { async embed({ texts }) {
      firstBatches.push(texts.length)
      if (firstBatches.length === 2) throw new Error('fixture provider interruption')
      return texts.map(() => [1, 0])
    } },
  }))
  await assert.rejects(first.indexRepository({ root }), /fixture provider interruption/u)
  assert.deepEqual(firstBatches, [32, 32])
  assert.equal((await first.indexStatus(root)).identity, null)
  await assert.rejects(
    first.searchCode({ root, query: 'resumeTarget' }),
    (error: unknown) => error instanceof CodeIndexError && error.code === 'CODE_INDEX_STALE',
  )
  await first.close()

  const retryBatches: number[] = []
  const retry = trackCodeIndex(createCodeIndex({
    database, profile,
    models: { async embed({ texts }) {
      retryBatches.push(texts.length)
      return texts.map(() => [1, 0])
    } },
  }))
  const completed = await retry.indexRepository({ root })
  assert.deepEqual(retryBatches, [32, 20])
  assert.equal(completed.chunkCount, 84)
  assert.equal((await retry.searchCode({ root, query: 'resumeTarget', limit: 100 })).hits.length, 84)
  const staged = await database.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM zorya_code_resume_chunks',
  )
  assert.equal(Number(staged.rows[0]?.count), 0)
  await retry.close()
})

test('abort during unchanged-index confirmation prevents a successful return', async () => {
  const root = await repository()
  await writeFile(
    join(root, 'service.ts'),
    'export function abortConfirmationTarget() { return 1 }',
  )
  await commit(root, 'fixture')
  const dataDir = await mkdtemp(join(tmpdir(), 'zorya-code-db-'))
  roots.push(dataDir)
  const rawDatabase = await openEmbeddedDatabase(dataDir)
  databases.push(rawDatabase)
  let waitingForConfirmation = false
  let queryNumber = 0
  let resolveStarted: (() => void) | undefined
  let releaseQuery: (() => void) | undefined
  const started = new Promise<void>((resolvePromise) => {
    resolveStarted = resolvePromise
  })
  const delayedDatabase: QueryableDatabase = {
    query: async (sql, values) => {
      if (waitingForConfirmation && /SELECT w\.current_snapshot/iu.test(sql)) {
        queryNumber++
        if (queryNumber === 2) {
          resolveStarted?.()
          await new Promise<void>((resolvePromise) => {
            releaseQuery = resolvePromise
          })
        }
      }
      return rawDatabase.query(sql, values)
    },
    exec: (sql) => rawDatabase.exec(sql),
    transaction: (operation, signal) => rawDatabase.transaction(operation, signal),
  }
  const code = trackCodeIndex(createCodeIndex({ database: delayedDatabase }))
  await code.indexRepository({ root })
  waitingForConfirmation = true
  const controller = new AbortController()
  const result = code.indexRepository({ root, signal: controller.signal })
  await started
  controller.abort()
  releaseQuery?.()
  await assert.rejects(
    result,
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
  await code.close()
})

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
  const restored = trackCodeIndex(createCodeIndex({ database }))
  assert.equal(
    (await restored.searchCode({ root, query: 'addNumbers' })).hits[0]?.snapshotId,
    status.identity?.snapshotId,
  )
  await restored.close()
  await code.close()
})

test('dependency graph follows bounded import edges in both directions with snapshot identity', async () => {
  const root = await repository()
  await writeFile(join(root, 'a.ts'), "import './b.js'\n")
  await writeFile(join(root, 'b.ts'), "import './c.js'\n")
  await writeFile(join(root, 'c.ts'), "import './a.js'\nexport const value = 1\n")
  await writeFile(join(root, 'x.ts'), "import './y.js'\n")
  await writeFile(join(root, 'y.ts'), 'export const y = 1\n')
  await writeFile(join(root, 'outside.txt'), 'ignored')
  await writeFile(join(root, '.env'), 'secret')
  await commit(root, 'dependency graph fixture')
  const { code } = await index(root)
  const status = await code.indexRepository({ root })
  const mutableRequest = { root, seeds: ['a.ts'], maxDepth: 2 }
  const capturedGraph = code.dependencyGraph!(mutableRequest)
  mutableRequest.seeds[0] = 'missing.ts'
  mutableRequest.maxDepth = 1
  const captured = await capturedGraph
  assert.deepEqual(captured.seeds, ['a.ts'])
  assert.equal(captured.requestedDepth, 2)
  const scopedSeeds = ['a.ts']
  const scopedCaptured = await code.withReadSnapshot!(root, new AbortController().signal, (scoped) => {
    const pending = scoped.dependencyGraph!({ root, seeds: scopedSeeds, maxDepth: 2 })
    scopedSeeds[0] = 'missing.ts'
    return pending
  })
  assert.deepEqual(scopedCaptured.seeds, ['a.ts'])
  const graph = await code.withReadSnapshot!(root, new AbortController().signal, (scoped) =>
    scoped.dependencyGraph!({ root, seeds: ['a.ts'], maxDepth: 2 }),
  )
  assert.equal(graph.identity.snapshotId, status.identity?.snapshotId)
  assert.deepEqual(graph.nodes.map(({ path, depth, parent }) => [path, depth, parent]), [
    ['a.ts', 0, null], ['b.ts', 1, 'a.ts'], ['c.ts', 1, 'a.ts'],
  ])
  assert.deepEqual(graph.nodes.map((node) => [node.path, node.relation]), [
    ['a.ts', 'seed'], ['b.ts', 'imports'], ['c.ts', 'importedBy'],
  ])
  assert.deepEqual(new Set(graph.edges.map((edge) => `${edge.from}->${edge.to}:${edge.direction}`)), new Set([
    'a.ts->b.ts:imports', 'c.ts->a.ts:importedBy', 'b.ts->c.ts:imports',
  ]))
  assert.equal(graph.reachedDepth, 1)
  assert.equal(graph.limits.depth, false)
  const twoNodeBoundary = await code.dependencyGraph!({ root, seeds: ['x.ts'], maxDepth: 4 })
  assert.equal(twoNodeBoundary.nodes.length, 2)
  assert.equal(twoNodeBoundary.reachedDepth, 1)
  assert.equal(twoNodeBoundary.limits.depth, false)
  const importerView = await code.dependencyGraph!({ root, seeds: ['b.ts'], maxDepth: 1 })
  assert.equal(importerView.nodes.find((node) => node.path === 'a.ts')?.relation, 'importedBy')
  assert.equal(importerView.nodes.find((node) => node.path === 'c.ts')?.relation, 'imports')
  const capped = await code.dependencyGraph!({ root, seeds: ['a.ts'], maxDepth: 4, maxNodes: 2 })
  assert.deepEqual(capped.nodes.map((node) => node.path), ['a.ts', 'b.ts'])
  assert.equal(capped.limits.nodes, true)
  await assert.rejects(code.dependencyGraph!({ root, seeds: ['.env'] }))
  await assert.rejects(code.dependencyGraph!({ root, seeds: ['missing.ts'] }))
  await assert.rejects(code.dependencyGraph!({ root, seeds: ['../outside.txt'] }))
})

test('dependency graph edge budget counts unique edges across BFS levels', async () => {
  const root = await repository()
  await writeFile(join(root, 'a.ts'), "import './b.js'\n")
  await writeFile(join(root, 'b.ts'), "import './c.js'\n")
  await writeFile(join(root, 'c.ts'), 'export const c = 1\n')
  await commit(root, 'edge cap fixture')
  const { code } = await index(root)
  await code.indexRepository({ root })
  const graph = await code.dependencyGraph!({ root, seeds: ['a.ts'], maxDepth: 2, maxEdges: 2 })
  assert.deepEqual(graph.edges.map(({ from, to }) => `${from}->${to}`), ['a.ts->b.ts', 'b.ts->c.ts'])
  assert.equal(graph.limits.edges, false)
  assert.equal(graph.reachedDepth, 2)
})

test('dependency graph applies edge caps to unique file pairs rather than import aliases', async () => {
  const root = await repository()
  await writeFile(join(root, 'a.ts'), "import './b.js'\nimport './b.ts'\nimport '././b.js'\nimport './z.js'\n")
  await writeFile(join(root, 'b.ts'), 'export const b = 1\n')
  await writeFile(join(root, 'z.ts'), 'export const z = 1\n')
  await commit(root, 'dependency import alias fixture')
  const { code, database } = await index(root)
  const status = await code.indexRepository({ root })
  const storedImports = await database.query<{ from_path: string; to_path: string; specifier: string }>(
    'SELECT from_path,to_path,specifier FROM zorya_code_imports WHERE snapshot_id=$1 AND from_path=$2 ORDER BY specifier',
    [status.identity!.snapshotId, 'a.ts'],
  )
  assert.equal(storedImports.rows.length, 4)
  assert.equal(storedImports.rows.filter((row) => row.to_path === 'b.ts').length, 3)

  const graph = await code.dependencyGraph!({ root, seeds: ['a.ts'], maxDepth: 2, maxEdges: 2 })
  assert.deepEqual(graph.edges.map(({ from, to }) => `${from}->${to}`), ['a.ts->b.ts', 'a.ts->z.ts'])
  assert.deepEqual(graph.nodes.map((node) => node.path), ['a.ts', 'b.ts', 'z.ts'])
  assert.deepEqual(graph.limits, { depth: false, nodes: false, edges: false })
})

test('dependency graph scoped reads reject source changes and close joins canceled SQL', async () => {
  const makeFixture = async (prefix: string) => {
    const root = await repository()
    await writeFile(join(root, 'a.ts'), "import './b.js'\n")
    await writeFile(join(root, 'b.ts'), 'export const value = 1\n')
    await commit(root, 'dependency graph lifecycle fixture')
    const dataDir = await mkdtemp(join(tmpdir(), prefix))
    roots.push(dataDir)
    const rawDatabase = await openEmbeddedDatabase(dataDir)
    databases.push(rawDatabase)
    let waiting = false
    let resolveStarted: (() => void) | undefined
    let release: (() => void) | undefined
    const started = new Promise<void>((resolvePromise) => { resolveStarted = resolvePromise })
    const delayedDatabase: QueryableDatabase = {
      query: async (sql, values) => {
        if (waiting && /FROM zorya_code_imports/iu.test(sql)) {
          waiting = false
          resolveStarted?.()
          await new Promise<void>((resolvePromise) => { release = resolvePromise })
        }
        return rawDatabase.query(sql, values)
      },
      exec: (sql) => rawDatabase.exec(sql),
      transaction: (operation, signal) => rawDatabase.transaction(operation, signal),
    }
    const code = trackCodeIndex(createCodeIndex({ database: delayedDatabase }))
    await code.indexRepository({ root })
    return { root, code, started, block() { waiting = true }, release() { release?.() } }
  }

  const changed = await makeFixture('zorya-dependency-change-')
  changed.block()
  const scopedGraph = changed.code.withReadSnapshot!(changed.root, new AbortController().signal,
    (scoped) => scoped.dependencyGraph!({ root: changed.root, seeds: ['a.ts'] }))
  await changed.started
  await writeFile(join(changed.root, 'b.ts'), 'export const value = 2\n')
  changed.release()
  await assert.rejects(scopedGraph, (error) => error instanceof CodeIndexError)
  await changed.code.close()

  const canceled = await makeFixture('zorya-dependency-cancel-')
  canceled.block()
  const controller = new AbortController()
  let settled = false
  const graph = canceled.code.dependencyGraph!({ root: canceled.root, seeds: ['a.ts'], signal: controller.signal })
    .finally(() => { settled = true })
  await canceled.started
  controller.abort()
  let closed = false
  const close = canceled.code.close().then(() => { closed = true })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  assert.equal(settled, false)
  assert.equal(closed, false)
  canceled.release()
  await assert.rejects(graph, (error: unknown) => error instanceof Error && error.name === 'AbortError')
  await close
  assert.equal(closed, true)
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
  const a = trackCodeIndex(createCodeIndex({ database, models: modelsA, profile: profileA }))
  const first = await a.indexRepository({ root })
  const b = trackCodeIndex(createCodeIndex({ database, models: modelsB, profile: profileB }))
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
  const originalSnapshotId = (await code.indexStatus(root)).identity?.snapshotId
  assert.ok(originalSnapshotId)
  let watcher: Awaited<ReturnType<typeof code.watchRepository>> | undefined
  try {
    watcher = await code.watchRepository(root, { intervalMs: 250 })
    await writeFile(
      join(root, 'nested', 'late.ts'),
      'export function periodicReconcileTarget() { return 2 }',
    )
    const deadline = Date.now() + 10_000
    let publishedSnapshotId: string | undefined
    while (Date.now() < deadline) {
      const status = await code.indexStatus(root)
      if (status.fileCount === 2 && status.identity?.snapshotId !== originalSnapshotId) {
        publishedSnapshotId = status.identity?.snapshotId
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(publishedSnapshotId, 'watcher did not publish the changed source snapshot')
    assert.equal(
      (await code.searchCode({ root, query: 'periodicReconcileTarget' })).hits[0]?.path,
      'nested/late.ts',
    )
    const [firstClose, secondClose] = await Promise.all([watcher.close(), watcher.close()])
    assert.equal(firstClose, undefined)
    assert.equal(secondClose, undefined)
  } finally {
    try {
      await watcher?.close()
    } finally {
      await code.close()
    }
  }
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
  const lexical = trackCodeIndex(createCodeIndex({ database, limits: { maxChunkChars: 64 } }))
  const oldSnapshot = await lexical.indexRepository({ root })
  const changed = trackCodeIndex(createCodeIndex({ database, limits: { maxChunkChars: 32 } }))
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
  const hybrid = trackCodeIndex(createCodeIndex({ database, models, profile, limits: { maxChunkChars: 32 } }))
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
  const code = trackCodeIndex(createCodeIndex(options))
  options.models = replacement
  await code.indexRepository({ root })
  const found = await code.searchCode({ root, query: 'capturedEmbeddingTarget' })
  assert.ok(originalCalls >= 2)
  assert.equal(replacementCalls, 0)
  assert.equal(found.hits[0]?.ranking.mode, 'hybrid')
  assert.equal(found.hits[0]?.ranking.rerankRank, null)
  await code.close()
})
