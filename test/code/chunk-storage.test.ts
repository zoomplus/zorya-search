import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEmbeddedDatabase } from '../../src/storage/embedded.js'
import type { QueryableDatabase } from '../../src/storage/database.js'
import { initializeCodeIndex } from '../../src/code/schema.js'
import { persistCodeChunks } from '../../src/code/chunk-storage.js'
import type { CodeChunk } from '../../src/code/types.js'
import {
  persistSymbolAnalysis,
  symbolProfile,
  type SymbolAnalysisLimits,
} from '../../src/code/symbol-storage.js'
import { CODE_SYMBOL_EXTRACTOR_VERSION, type SymbolExtractionResult } from '../../src/code/symbol-types.js'

async function withDatabase<T>(operation: (database: Awaited<ReturnType<typeof openEmbeddedDatabase>>) => Promise<T>): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), 'zorya-chunk-storage-'))
  let database: Awaited<ReturnType<typeof openEmbeddedDatabase>> | undefined
  try {
    database = await openEmbeddedDatabase(dataDir)
    await initializeCodeIndex(database)
    return await operation(database)
  } finally {
    await database?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}

async function seedSnapshot(database: QueryableDatabase, snapshotId: string): Promise<void> {
  await database.query(
    `INSERT INTO zorya_code_snapshots(snapshot_id,worktree_id,repo_id,branch,head,content_hash,profile_id,file_count,chunk_count)
     VALUES($1,'worktree','repo',NULL,NULL,'tree-hash',NULL,0,0)`,
    [snapshotId],
  )
}

function makeChunk(index: number): CodeChunk {
  return {
    id: `chunk-${String(index).padStart(4, '0')}`,
    path: `src/file-${Math.floor(index / 7)}.ts`,
    lineStart: index + 1,
    lineEnd: index + 2,
    symbol: index % 2 === 0 ? `symbol${index}` : null,
    language: 'typescript',
    text: `export const value${index} = ${index} + "distinct-${index}";`,
    contentHash: `content-hash-${index}`,
    parserVersion: 'fixture-parser-v1',
  }
}

function observeQueries(tx: QueryableDatabase, captured: Array<{ sql: string; values: readonly unknown[] }>): QueryableDatabase {
  return {
    async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
      if (/^INSERT INTO zorya_code_chunks/u.test(sql)) captured.push({ sql, values: [...values] })
      return tx.query<Row>(sql, values)
    },
    exec(sql) { return tx.exec(sql) },
    transaction() { throw new Error('SEARCH_DATABASE_NESTED_TRANSACTION_UNSUPPORTED') },
  }
}

test('chunk batches persist exact rows and vectors, including the final partial batch and conflicts', async () => {
  await withDatabase(async (database) => {
    const snapshotId = 'snapshot-chunks'
    await seedSnapshot(database, snapshotId)
    const chunks = Array.from({ length: 131 }, (_, index) => makeChunk(index))
    const vectors = chunks.map((_, index) => [index + 0.25, index + 0.5, index + 0.75])
    const inserts: Array<{ sql: string; values: readonly unknown[] }> = []

    await database.transaction(async (tx) => {
      await persistCodeChunks(observeQueries(tx, inserts), snapshotId, chunks, vectors)
    })

    assert.equal(inserts.length, 3)
    assert.deepEqual(inserts.map((insert) => insert.values.length), [641, 641, 31])
    assert.match(inserts[0]!.sql, /ON CONFLICT\(snapshot_id,id\) DO NOTHING$/u)
    assert.match(inserts[0]!.sql, /vector_json\)\s+VALUES\s+\(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10,\$11::jsonb\)/u)

    const rows = await database.query<{
      id: string; path: string; line_start: number; line_end: number; symbol: string | null;
      language: string; body: string; content_hash: string; parser_version: string; vector_json: number[];
    }>(
      `SELECT id,path,line_start,line_end,symbol,language,body,content_hash,parser_version,vector_json
       FROM zorya_code_chunks WHERE snapshot_id=$1 ORDER BY id`,
      [snapshotId],
    )
    assert.equal(rows.rows.length, chunks.length)
    assert.deepEqual(rows.rows, chunks.map((chunk, index) => ({
      id: chunk.id, path: chunk.path, line_start: chunk.lineStart, line_end: chunk.lineEnd,
      symbol: chunk.symbol, language: chunk.language, body: chunk.text, content_hash: chunk.contentHash,
      parser_version: chunk.parserVersion, vector_json: vectors[index],
    })))

    const conflicting = { ...chunks[0]!, text: 'conflicting body must not replace the first row' }
    const appended = makeChunk(chunks.length)
    await database.transaction((tx) => persistCodeChunks(
      tx, snapshotId, [conflicting, appended], [[9, 9, 9], [1, 2, 3]],
    ))
    const afterConflict = await database.query<{ id: string; body: string; vector_json: number[] }>(
      'SELECT id,body,vector_json FROM zorya_code_chunks WHERE snapshot_id=$1 AND id=ANY($2::text[]) ORDER BY id',
      [snapshotId, [chunks[0]!.id, appended.id]],
    )
    assert.deepEqual(afterConflict.rows, [
      { id: chunks[0]!.id, body: chunks[0]!.text, vector_json: vectors[0] },
      { id: appended.id, body: appended.text, vector_json: [1, 2, 3] },
    ])
  })
})

test('cancellation and write failure roll back a partially inserted publication and release the database', async (t) => {
  for (const mode of ['cancel', 'failure'] as const) {
    await t.test(mode, async () => {
      await withDatabase(async (database) => {
        const priorSnapshot = 'prior-snapshot'
        const nextSnapshot = 'pending-snapshot'
        await seedSnapshot(database, priorSnapshot)
        await database.transaction((tx) => persistCodeChunks(tx, priorSnapshot, [makeChunk(0)], [[3, 2, 1]]))
        const controller = new AbortController()
        const injectedFailure = new Error('fixture write failure after first executed batch')
        let chunkInsertCount = 0

        await assert.rejects(database.transaction(async (tx) => {
          const observed: QueryableDatabase = {
            async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
              const result = await tx.query<Row>(sql, values)
              if (/^INSERT INTO zorya_code_chunks/u.test(sql) && ++chunkInsertCount === 1) {
                if (mode === 'cancel') setImmediate(() => controller.abort())
                else throw injectedFailure
              }
              return result
            },
            exec(sql) { return tx.exec(sql) },
            transaction() { throw new Error('SEARCH_DATABASE_NESTED_TRANSACTION_UNSUPPORTED') },
          }
          await observed.query(
            `INSERT INTO zorya_code_snapshots(snapshot_id,worktree_id,repo_id,branch,head,content_hash,profile_id,file_count,chunk_count)
             VALUES($1,'worktree','repo',NULL,NULL,'pending-hash',NULL,0,70)`,
            [nextSnapshot],
          )
          await persistCodeChunks(observed, nextSnapshot, Array.from({ length: 70 }, (_, index) => makeChunk(index + 100)),
            Array.from({ length: 70 }, (_, index) => [index, index + 1, index + 2]), controller.signal)
        }, controller.signal), (error: unknown) => mode === 'cancel'
          ? error instanceof Error && error.name === 'AbortError'
          : error === injectedFailure)

        assert.equal(chunkInsertCount, 1)
        const prior = await database.query<{ body: string; vector_json: number[] }>(
          'SELECT body,vector_json FROM zorya_code_chunks WHERE snapshot_id=$1 AND id=$2',
          [priorSnapshot, makeChunk(0).id],
        )
        assert.deepEqual(prior.rows, [{ body: makeChunk(0).text, vector_json: [3, 2, 1] }])
        const unpublished = await database.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM zorya_code_chunks WHERE snapshot_id=$1', [nextSnapshot],
        )
        assert.equal(unpublished.rows[0]?.count, '0')
        const rolledBackSnapshot = await database.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM zorya_code_snapshots WHERE snapshot_id=$1', [nextSnapshot],
        )
        assert.equal(rolledBackSnapshot.rows[0]?.count, '0')
      })
    })
  }
})

function makeSymbolResult(count: number): SymbolExtractionResult {
  const symbols: SymbolExtractionResult['symbols'] = Array.from({ length: count }, (_, index) => ({
    id: `symbol-${String(index).padStart(4, '0')}`,
    name: `symbol${index}`,
    qualifiedName: `module.symbol${index}`,
    kind: 'function',
    location: { path: 'src/batch.ts', start: index * 8, end: index * 8 + 7, lineStart: index + 1, lineEnd: index + 1, fileHash: 'batch-file-hash' },
    parentId: null,
    container: null,
    signature: `function symbol${index}()`,
    signatureTruncated: false,
    contract: false,
    synthetic: false,
    overloadGroupId: null,
  }))
  const references: SymbolExtractionResult['references'] = Array.from({ length: count }, (_, index) => ({
    id: `reference-${String(index).padStart(4, '0')}`,
    kind: 'reference',
    from: { path: 'src/batch.ts', start: index * 8, end: index * 8 + 7, lineStart: index + 1, lineEnd: index + 1, fileHash: 'batch-file-hash' },
    ownerSymbolId: symbols[index]!.id,
    targetSymbolIds: [],
    targetKind: 'unresolved',
    unresolvedReason: 'unresolved',
  }))
  return {
    version: CODE_SYMBOL_EXTRACTOR_VERSION,
    identity: { root: '/repo', snapshotId: 'snapshot-symbols' },
    symbols,
    references,
    files: [{ path: 'src/batch.ts', language: 'typescript', status: 'parsed', symbols: count, references: count, diagnostics: [] }],
    complete: true,
    truncation: { symbols: false, references: false, files: false },
    compiler: { typescriptVersion: 'fixture-ts', compilerOptionsHash: 'fixture-options', libraryProfileId: null, libraryAssets: [] },
  }
}

test('symbol and reference persistence batches retain exact DTO rows and final partial batches', async () => {
  await withDatabase(async (database) => {
    const snapshotId = 'snapshot-symbols'
    await seedSnapshot(database, snapshotId)
    const result = makeSymbolResult(260)
    const limits: SymbolAnalysisLimits = { maxFiles: 10, maxSymbols: 300, maxReferences: 300, tsconfigPath: null }
    const profile = symbolProfile(result, limits)
    const observed: string[] = []

    await database.transaction(async (tx) => {
      const capture: QueryableDatabase = {
        async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
          if (/^INSERT INTO zorya_code_symbols/u.test(sql) || /^INSERT INTO zorya_code_symbol_references/u.test(sql))
            observed.push(`${sql.startsWith('INSERT INTO zorya_code_symbols') ? 'symbol' : 'reference'}:${values.length}`)
          return tx.query<Row>(sql, values)
        },
        exec(sql) { return tx.exec(sql) },
        transaction() { throw new Error('SEARCH_DATABASE_NESTED_TRANSACTION_UNSUPPORTED') },
      }
      await persistSymbolAnalysis(capture, snapshotId, result, profile)
    })

    assert.deepEqual(observed, ['symbol:1410', 'symbol:1410', 'symbol:46', 'reference:1282', 'reference:1282', 'reference:42'])
    const persistedSymbols = await database.query<{ symbol_id: string; dto_json: unknown }>(
      'SELECT symbol_id,dto_json FROM zorya_code_symbols WHERE snapshot_id=$1 AND analysis_profile_id=$2 ORDER BY symbol_id',
      [snapshotId, profile.id],
    )
    const persistedReferences = await database.query<{ reference_id: string; dto_json: unknown }>(
      'SELECT reference_id,dto_json FROM zorya_code_symbol_references WHERE snapshot_id=$1 AND analysis_profile_id=$2 ORDER BY reference_id',
      [snapshotId, profile.id],
    )
    assert.deepEqual(persistedSymbols.rows.map((row) => row.dto_json), result.symbols)
    assert.deepEqual(persistedReferences.rows.map((row) => row.dto_json), result.references)
  })
})
