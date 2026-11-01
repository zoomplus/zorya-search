import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCodeIndex } from '../../src/code/index.js'
import { createSymbolQueries } from '../../src/code/symbol-queries.js'
import { loadSymbolAnalysis, type SymbolAnalysisLimits } from '../../src/code/symbol-storage.js'
import type { QueryableDatabase } from '../../src/storage/database.js'
import { openEmbeddedDatabase } from '../../src/storage/embedded.js'

async function fixture(prefix: string, options: Parameters<typeof createCodeIndex>[0]['limits'] = undefined) {
  const root = await mkdtemp(join(tmpdir(), `zorya-symbol-budget-${prefix}-root-`))
  const data = await mkdtemp(join(tmpdir(), `zorya-symbol-budget-${prefix}-db-`))
  const database = await openEmbeddedDatabase(data)
  const index = createCodeIndex({ database, ...(options ? { limits: options } : {}) })
  return {
    root,
    database,
    index,
    async cleanup() {
      await index.close()
      await database.close()
      await Promise.all([rm(root, { recursive: true, force: true }), rm(data, { recursive: true, force: true })])
    },
  }
}

test('CodeIndex maxFiles covers symbol analysis, profile freshness, and unchanged refreshes', async () => {
  const maxFiles = 6_000
  const owned = await fixture('large', { maxFiles, maxChunks: maxFiles })
  const { root, index } = owned
  const indexedFiles = 5_001

  try {
    for (let start = 0; start < 5_000; start += 100) {
      await Promise.all(Array.from({ length: Math.min(100, 5_000 - start) }, (_, offset) => {
        const position = start + offset
        return writeFile(join(root, `a-${String(position).padStart(5, '0')}.ts`),
          `export function earlier${position}() { return ${position} }\n`)
      }))
    }
    await writeFile(join(root, 'z-tail.ts'), 'export function uniqueTailDeclaration() { return 1 }\n')

    const first = await index.indexRepository({ root })
    assert.equal(first.fileCount, indexedFiles)
    const found = await index.findCodeSymbols!({ root, query: 'uniqueTailDeclaration' })
    assert.ok(found.symbols.some((symbol) => symbol.name === 'uniqueTailDeclaration'))
    assert.equal(found.analysis.state, 'indexed')
    assert.equal(found.analysis.profile?.limits.maxFiles, maxFiles)
    assert.equal(found.analysis.coverageTotalFiles, indexedFiles)
    assert.equal(found.analysis.truncation.files, false)
    const profileId = found.analysis.profile!.id

    await index.indexRepository({ root })
    const unchanged = await index.findCodeSymbols!({ root, query: 'uniqueTailDeclaration' })
    assert.equal(unchanged.analysis.profile?.id, profileId)
    assert.equal(unchanged.analysis.coverageTotalFiles, indexedFiles)
    assert.equal(unchanged.analysis.truncation.files, false)

    const refreshed = await index.indexCodeSymbols!({ root })
    const afterRefresh = await index.findCodeSymbols!({ root, query: 'uniqueTailDeclaration' })
    assert.equal(refreshed.profile?.id, profileId)
    assert.ok(afterRefresh.symbols.some((symbol) => symbol.name === 'uniqueTailDeclaration'))
    assert.equal(afterRefresh.analysis.profile?.limits.maxFiles, maxFiles)
    assert.equal(afterRefresh.analysis.coverageTotalFiles, indexedFiles)
    assert.equal(afterRefresh.analysis.truncation.files, false)
  } finally {
    await owned.cleanup()
  }
})

test('CodeIndex default maxFiles remains 5000 for symbol profiles', async () => {
  const owned = await fixture('default')
  const { root, index } = owned
  try {
    await writeFile(join(root, 'small.ts'), 'export function defaultBudget() { return 1 }\n')
    await index.indexRepository({ root })
    const result = await index.findCodeSymbols!({ root, query: 'defaultBudget' })
    assert.ok(result.symbols.some((symbol) => symbol.name === 'defaultBudget'))
    assert.equal(result.analysis.profile?.limits.maxFiles, 5_000)
    assert.equal(result.analysis.state, 'indexed')
  } finally {
    await owned.cleanup()
  }
})

test('symbol analysis captures expected limits and rejects mismatched profiles', async () => {
  const maxFiles = 10
  const owned = await fixture('limits', { maxFiles })
  const { root, index, database } = owned
  try {
    await writeFile(join(root, 'captured.ts'), 'export function capturedBudget() { return 1 }\n')
    const indexed = await index.indexRepository({ root })
    const identity = indexed.identity!
    const limits: SymbolAnalysisLimits = {
      maxFiles, maxSymbols: 100_000, maxReferences: 500_000, tsconfigPath: null,
    }

    const queries = createSymbolQueries(database, async () => ({
      identity,
      snapshot: identity.snapshotId,
      metadataGeneration: null,
      metadataProfile: null,
    }), limits)
    limits.maxFiles = 11
    const queryResult = await queries.findCodeSymbols({ root, query: 'capturedBudget' })
    assert.equal(queryResult.analysis.state, 'indexed')
    assert.ok(queryResult.symbols.some((symbol) => symbol.name === 'capturedBudget'))

    const mismatch = await loadSymbolAnalysis(database, identity, identity.worktreeId, {
      ...limits,
      maxFiles: 12,
    })
    assert.equal(mismatch.state, 'unavailable')

    let entered: (() => void) | undefined
    let release: (() => void) | undefined
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const delayed: QueryableDatabase = {
      async query<T>(sql: string, values?: readonly unknown[]) {
        if (sql.includes('FROM zorya_code_analysis_state')) {
          entered?.()
          await gate
        }
        return database.query<T>(sql, values)
      },
      exec: database.exec.bind(database),
      transaction: database.transaction.bind(database),
    }
    const inFlightLimits: SymbolAnalysisLimits = {
      maxFiles, maxSymbols: 100_000, maxReferences: 500_000, tsconfigPath: null,
    }
    const pending = loadSymbolAnalysis(delayed, identity, identity.worktreeId, inFlightLimits)
    await enteredPromise
    inFlightLimits.maxFiles = 12
    release?.()
    assert.equal((await pending).state, 'indexed')
  } finally {
    await owned.cleanup()
  }
})
