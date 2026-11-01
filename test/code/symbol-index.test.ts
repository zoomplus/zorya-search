import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openEmbeddedDatabase } from '../../src/storage/embedded.js'
import { createCodeIndex } from '../../src/code/index.js'
import { CodeIndexError } from '../../src/code/errors.js'
import type { QueryableDatabase } from '../../src/storage/database.js'

const owned: { dirs: string[]; close: Array<() => Promise<void>> } = { dirs: [], close: [] }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zorya-symbol-root-'))
  const data = await mkdtemp(join(tmpdir(), 'zorya-symbol-db-'))
  owned.dirs.push(root, data)
  const database = await openEmbeddedDatabase(data)
  const index = createCodeIndex({ database })
  owned.close.push(() => index.close(), () => database.close())
  return { root, database, index }
}
test.afterEach(async () => {
  await Promise.all(owned.close.splice(0).map((close) => close()))
  await Promise.all(owned.dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test('full repository indexing publishes bounded symbol metadata and supports filtered queries, references, and call traces', async () => {
  const { root, index, database } = await fixture()
  await writeFile(join(root, 'source.ts'), `export function leaf(value: number) { return value + 1 }
export function branch() { return leaf(2) }
export function entry() { return branch() }
`)
  await writeFile(join(root, 'source.test.ts'), 'export function testBranch() { return 1 }\n')
  await writeFile(join(root, 'docs.md'), '# leaf reference\n')
  await index.indexRepository({ root })
  const all = await index.findCodeSymbols!({ root })
  assert.equal(all.analysis.state, 'partial')
  assert.equal(all.analysis.complete, false)
  assert.ok(all.symbols.some((symbol) => symbol.name === 'branch'))
  assert.ok((await index.findCodeSymbols!({ root, query: 'branch' })).symbols.some((symbol) => symbol.name === 'branch'))
  assert.ok((await index.findCodeSymbols!({ root, path: 'source.ts' })).symbols.every((symbol) => symbol.location.path === 'source.ts'))
  assert.ok((await index.findCodeSymbols!({ root, sourceKind: 'tests' })).symbols.some((symbol) => symbol.name === 'testBranch'))
  assert.equal((await index.findCodeSymbols!({ root, sourceKind: 'documentation' })).symbols.length, 0)
  const page = await index.findCodeSymbols!({ root, limit: 1 })
  assert.equal(page.truncated, true)
  assert.ok(page.nextCursor)
  const next = await index.findCodeSymbols!({ root, limit: 1, cursor: page.nextCursor! })
  assert.equal(next.symbols[0]?.id === page.symbols[0]?.id, false)
  await assert.rejects(index.findCodeSymbols!({ root, limit: 2, sourceKind: 'tests', cursor: page.nextCursor! }), /CURSOR_STALE/u)

  const branch = all.symbols.find((symbol) => symbol.name === 'branch')!
  const outgoing = await index.findCodeReferences!({ root, symbolId: branch.id, direction: 'outgoing' })
  assert.ok(outgoing.references.some((reference) => reference.kind === 'call'))
  const leaf = all.symbols.find((symbol) => symbol.name === 'leaf')!
  const incoming = await index.findCodeReferences!({ root, symbolId: leaf.id })
  assert.ok(incoming.references.some((reference) => reference.ownerSymbolId === branch.id))
  const trace = await index.traceCodeCalls!({ root, symbolId: branch.id, direction: 'outgoing' })
  assert.equal(trace.startSymbol?.id, branch.id)
  assert.ok(trace.nodes.some((symbol) => symbol.name === 'leaf'))
  assert.ok(trace.edges.some((reference) => reference.kind === 'call'))
  const details = await database.query<{ count: string }>('SELECT count(*)::text AS count FROM zorya_code_analysis_state')
  assert.equal(details.rows[0]?.count, '1')
})

test('metadata-only refresh without models retains paid vector snapshot and makes no embedding calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-symbol-paid-root-'))
  const data = await mkdtemp(join(tmpdir(), 'zorya-symbol-paid-db-'))
  owned.dirs.push(root, data)
  const database = await openEmbeddedDatabase(data)
  const profile = { provider: 'fixture', space: 'paid-copy', model: 'paid-v1', dimensions: 2,
    inputType: 'text' as const, chunkerVersion: 'ts-ast-symbol-v1' }
  let calls = 0
  const paid = createCodeIndex({ database, profile, models: { async embed({ texts }) {
    calls++; return texts.map(() => [1, 0])
  } } })
  const noModels = createCodeIndex({ database })
  owned.close.push(() => paid.close(), () => noModels.close(), () => database.close())
  await writeFile(join(root, 'paid.ts'), 'export function preserveVector() { return "stable" }\n')
  const base = await paid.indexRepository({ root })
  const beforeChunks = await database.query<{ id: string; vector_json: unknown }>(
    'SELECT id,vector_json FROM zorya_code_chunks WHERE snapshot_id=$1 ORDER BY id', [base.identity!.snapshotId])
  const before = JSON.stringify(beforeChunks.rows)
  const beforeStatus = await paid.indexStatus(root)
  const callsBeforeRefresh = calls
  const status = await noModels.indexCodeSymbols!({ root })
  const afterChunks = await database.query<{ id: string; vector_json: unknown }>(
    'SELECT id,vector_json FROM zorya_code_chunks WHERE snapshot_id=$1 ORDER BY id', [base.identity!.snapshotId])
  assert.equal(status.identity.snapshotId, base.identity!.snapshotId)
  assert.equal(JSON.stringify(afterChunks.rows), before)
  assert.equal(calls, callsBeforeRefresh)
  assert.equal((await paid.indexStatus(root)).indexedAt, beforeStatus.indexedAt)
  assert.equal((await noModels.findCodeSymbols!({ root, query: 'preserveVector' })).symbols.length, 1)
})

test('missing metadata is explicit and reads never backfill it', async () => {
  const { root, index, database } = await fixture()
  await writeFile(join(root, 'not-indexed.ts'), 'export function hiddenUntilIndexed() {}\n')
  await index.indexRepository({ root })
  await database.query('DELETE FROM zorya_code_analysis_state')
  await database.query('DELETE FROM zorya_code_analysis')
  const before = await database.query<{ count: string }>('SELECT count(*)::text AS count FROM zorya_code_analysis')
  const result = await index.findCodeSymbols!({ root, query: 'hiddenUntilIndexed' })
  const after = await database.query<{ count: string }>('SELECT count(*)::text AS count FROM zorya_code_analysis')
  assert.equal(result.analysis.state, 'not_indexed')
  assert.equal(result.symbols.length, 0)
  assert.deepEqual(after.rows, before.rows)
})

test('symbol reads reject metadata generation changes and close joins blocked SQL without closing the borrowed DB', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-symbol-race-root-'))
  const data = await mkdtemp(join(tmpdir(), 'zorya-symbol-race-db-'))
  const raw = await openEmbeddedDatabase(data)
  let blockNext = false
  let entered: (() => void) | undefined
  let release: (() => void) | undefined
  const queryStarted = () => new Promise<void>((resolve) => { entered = resolve })
  const queryGate = () => new Promise<void>((resolve) => { release = resolve })
  const wrap = (database: QueryableDatabase): QueryableDatabase => ({
    async query(sql, values) {
      if (blockNext && sql.includes('FROM zorya_code_symbols WHERE') && sql.includes('ORDER BY path,line_start,symbol_id')) {
        blockNext = false
        entered?.()
        await queryGatePromise
      }
      return database.query(sql, values)
    },
    exec(sql) { return database.exec(sql) },
    transaction(operation, signal) { return database.transaction((tx) => operation(wrap(tx)), signal) },
  })
  let queryGatePromise = Promise.resolve()
  const index = createCodeIndex({ database: wrap(raw) })
  t.after(async () => {
    await index.close().catch(() => undefined)
    await raw.close()
    await rm(root, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  })
  await writeFile(join(root, 'race.ts'), 'export function fencedSymbol() {}\n')
  await index.indexRepository({ root })
  const worktree = (await index.indexStatus(root)).identity!.worktreeId

  let started = queryStarted()
  queryGatePromise = queryGate()
  blockNext = true
  const inFlight = index.findCodeSymbols!({ root, query: 'fencedSymbol' })
  await started
  await raw.query('UPDATE zorya_code_analysis_state SET generation=generation+1 WHERE worktree_id=$1', [worktree])
  release?.()
  await assert.rejects(inFlight, (error: unknown) => error instanceof CodeIndexError &&
    error.code === 'CODE_INDEX_SOURCE_CHANGED_DURING_SEARCH')

  await assert.rejects(index.withReadSnapshot!(root, new AbortController().signal, async (scoped) => {
    await scoped.findCodeSymbols!({ root, query: 'fencedSymbol' })
    await raw.query('UPDATE zorya_code_analysis_state SET generation=generation+1 WHERE worktree_id=$1', [worktree])
  }), (error: unknown) => error instanceof CodeIndexError &&
    error.code === 'CODE_INDEX_SOURCE_CHANGED_DURING_SEARCH')

  started = queryStarted()
  queryGatePromise = queryGate()
  blockNext = true
  const closingRead = index.findCodeSymbols!({ root, query: 'fencedSymbol' })
  await started
  let closeSettled = false
  const closing = index.close().then(() => { closeSettled = true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(closeSettled, false)
  release?.()
  await assert.rejects(closingRead)
  await closing
  assert.equal(closeSettled, true)
  assert.equal((await raw.query('SELECT 1')).rowCount, 1)
})
