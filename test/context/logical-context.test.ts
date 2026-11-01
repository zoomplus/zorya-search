import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCodeContext } from '../../src/context/index.js'
import { createCodeIndex } from '../../src/code/index.js'
import { openEmbeddedDatabase } from '../../src/storage/embedded.js'
import type { CodeIndex, CodeHit, CodeSourceIdentity } from '../../src/code/types.js'

test('logical context reads complete long seed blocks and includes only statically linked contract, call chain, caller and test', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-logical-root-'))
  const data = await mkdtemp(join(tmpdir(), 'zorya-logical-db-'))
  const database = await openEmbeddedDatabase(data)
  const index = createCodeIndex({ database })
  t.after(async () => {
    await index.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  })

  const filler = Array.from({ length: 225 }, (_, position) => `  const stage${position} = ${position}`).join('\n')
  await writeFile(join(root, 'behavior.ts'), `// Leading source trivia exercises native chunk boundaries.
import type { RunnerContract } from './contract.js'
import { forwardingLayer } from './forward.js'
export async function performCriticalBehavior(runner: RunnerContract) {
${filler}
  if (criticalBranchNeedle) return forwardingLayer(runner)
  return runner.finish(stage224)
}
`)
  await writeFile(join(root, 'contract.ts'), `export interface RunnerContract { finish(value: number): number }
`)
  await writeFile(join(root, 'forward.ts'), `import type { RunnerContract } from './contract.js'
import { applyFinalBehavior } from './final.js'
export function forwardingLayer(runner: RunnerContract) { return applyFinalBehavior(runner) }
`)
  await writeFile(join(root, 'final.ts'), `import type { RunnerContract } from './contract.js'
export function applyFinalBehavior(runner: RunnerContract) { return runner.finish(9) }
`)
  await writeFile(join(root, 'caller.ts'), `import type { RunnerContract } from './contract.js'
import { performCriticalBehavior } from './behavior.js'
export async function dispatchCriticalJob(runner: RunnerContract) { return performCriticalBehavior(runner) }
`)
  await writeFile(join(root, 'external-caller.ts'), `import type { RunnerContract } from './contract.js'
import { performCriticalBehavior } from './behavior.js'
export async function externalDriver(runner: RunnerContract) { return performCriticalBehavior(runner) }
`)
  await writeFile(join(root, 'behavior.test.ts'), `import { test } from 'node:test'
import { performCriticalBehavior } from './behavior.js'
test('critical behavior', async () => { await performCriticalBehavior({ finish: (value) => value }) })
`)
  await writeFile(join(root, 'similar-name.test.ts'), `import { test } from 'node:test'
test('unrelated', () => { const candidate = 'no call edge' })
`)
  await index.indexRepository({ root })
  const context = createCodeContext({ index })
  t.after(() => context.close())
  const result = await context.getCodeContext({ root, query: 'stage224', limit: 1, includeLogical: true })
  const logical = result.logicalContext!
  assert.equal(logical.runtimeCallCoverage, 'not_claimed')
  const seed = logical.blocks.find((block) => block.name === 'performCriticalBehavior')
  assert.ok(seed)
  assert.equal(seed?.depth, 0)
  assert.equal(seed?.complete, true)
  assert.equal(seed!.includedRanges.length, 1)
  assert.equal(seed!.includedRanges[0]?.lineStart, seed!.source.lineStart)
  assert.equal(seed!.includedRanges[0]?.lineEnd, seed!.source.lineEnd)
  assert.ok(result.sections.filter((section) => section.path === 'behavior.ts').some((section) => section.text.includes('return runner.finish(stage224)')))
  assert.ok(logical.blocks.some((block) => block.name === 'RunnerContract' && block.role === 'contract'))
  assert.ok(logical.blocks.some((block) => block.name === 'forwardingLayer' && block.depth === 1))
  assert.ok(logical.blocks.some((block) => block.name === 'applyFinalBehavior' && block.depth === 2))
  assert.ok(logical.blocks.some((block) => block.name === 'externalDriver' && block.role === 'caller' && block.depth === 1 && block.complete))
  assert.ok(logical.blocks.some((block) => block.role === 'test' && block.source.path === 'behavior.test.ts'))
  assert.ok(!logical.blocks.some((block) => block.source.path === 'similar-name.test.ts'))
  assert.ok(logical.omissions.filter((omission) => omission.range).every((omission) =>
    Object.keys(omission.range!).sort().join(',') === 'lineEnd,lineStart,path'))
  assert.ok(logical.omissions.filter((omission) => omission.continuation).every((omission) =>
    Object.keys(omission.continuation!).sort().join(',') === 'lineEnd,lineStart,path,snapshotId'))
  assert.ok(result.sections.every((section) => section.lineEnd - section.lineStart + 1 <= 200))
  assert.ok(logical.limits.sourceReads <= 120)
  assert.ok(result.budget.usedChars <= result.budget.maxChars)
  const broadImportChunk = await context.getCodeContext({ root, query: 'dispatchCriticalJob', limit: 1, includeLogical: true })
  const recovered = broadImportChunk.logicalContext?.blocks.find((block) => block.name === 'dispatchCriticalJob')
  assert.equal(recovered?.role, 'seed_definition')
  assert.equal(recovered?.complete, true)
  assert.equal(recovered?.wholeFile, true, 'small-file coverage is whole-file and explicitly marked')
})

test('logical context keeps explicit source filters independent from mandatory ranges and includeRelated', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-logical-filter-root-'))
  const data = await mkdtemp(join(tmpdir(), 'zorya-logical-filter-db-'))
  const database = await openEmbeddedDatabase(data)
  const index = createCodeIndex({ database })
  t.after(async () => {
    await index.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  })
  await writeFile(join(root, 'src.ts'), `export function implementationSeed() { return testLinkedTarget() }
export function testLinkedTarget() { return 1 }
`)
  await writeFile(join(root, 'src.test.ts'), `import { implementationSeed } from './src.js'
export function testCaller() { return implementationSeed() }
`)
  await index.indexRepository({ root })
  const context = createCodeContext({ index })
  t.after(() => context.close())
  const filtered = await context.getCodeContext({ root, query: 'implementationSeed', sourceKind: 'implementation', includeLogical: true })
  assert.ok(filtered.logicalContext?.blocks.every((block) => !block.source.path.endsWith('.test.ts')))
  const explicit = await context.getCodeContext({ root, query: 'implementationSeed', sourceKind: 'implementation',
    includeLogical: true, includeRelated: true, mustInclude: [{ path: 'src.test.ts', lineStart: 1, lineEnd: 1 }] })
  assert.ok(explicit.sections.some((section) => section.path === 'src.test.ts' && section.reason === 'mandatory'))
  assert.equal(explicit.logicalContext?.limits.maxSeeds, 8)
  assert.ok(explicit.relatedGraph)
  const defaultContext = await context.getCodeContext({ root, query: 'implementationSeed' })
  assert.equal('logicalContext' in defaultContext, false)
})

test('named chunk association handles trivia and qualified methods, but falls back for duplicate-name ambiguity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-logical-name-root-'))
  const data = await mkdtemp(join(tmpdir(), 'zorya-logical-name-db-'))
  const database = await openEmbeddedDatabase(data)
  const index = createCodeIndex({ database })
  t.after(async () => {
    await index.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  })
  await writeFile(join(root, 'worker.ts'), `import type { WorkerState } from './state.js'
export class Worker {

  // Leading method trivia is included in the producer chunk range.
  methodSeedNeedle(state: WorkerState) { return state.value + qualifiedMethodNeedle }
}
`)
  await writeFile(join(root, 'state.ts'), 'export interface WorkerState { value: number }\n')
  await writeFile(join(root, 'nested.ts'), `// leading trivia
export class Outer {
  run() {
    class Inner {
      run() { return duplicateNeedle }
    }
    return 0
  }
}
`)
  await index.indexRepository({ root })
  const nativeHit = (await index.searchCode({ root, query: 'qualifiedMethodNeedle' })).hits
    .find((candidate) => candidate.path === 'worker.ts')
  assert.ok(nativeHit)
  assert.equal(nativeHit!.symbol, 'Worker.methodSeedNeedle')
  assert.ok(nativeHit!.lineStart < 5, 'native hit should include leading method comment/blank-line trivia')
  const wrapper: Record<string, unknown> = { ...index, withReadSnapshot: undefined }
  wrapper.searchCode = async (input: Parameters<CodeIndex['searchCode']>[0]) => {
    const result = await index.searchCode(input)
    if (input.query === 'ambiguousNestedNeedle') {
      const hit = result.hits.find((candidate) => candidate.path === 'nested.ts')!
      return { ...result, hits: [{ ...hit, lineStart: 1, lineEnd: 6, symbol: 'run' }] }
    }
    return result
  }
  const context = createCodeContext({ index: wrapper as unknown as CodeIndex })
  t.after(() => context.close())
  const qualified = await context.getCodeContext({ root, query: 'qualifiedMethodNeedle', includeLogical: true })
  assert.ok(qualified.logicalContext?.blocks.some((block) => block.name === 'methodSeedNeedle' && block.role === 'seed_definition' && block.complete))
  const ambiguous = await context.getCodeContext({ root, query: 'ambiguousNestedNeedle', includeLogical: true })
  assert.ok(ambiguous.logicalContext?.blocks.some((block) => block.name === 'run' && block.role === 'source_fallback' && !block.complete))
  assert.ok(ambiguous.logicalContext?.omissions.some((omission) => omission.reason === 'no_enclosing_symbol' && omission.range?.path === 'nested.ts'))
})

test('tight logical budgets report snapshot-bound <=200-line continuations and reject them after source changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-logical-budget-root-'))
  const data = await mkdtemp(join(tmpdir(), 'zorya-logical-budget-db-'))
  const path = join(root, 'budget.ts')
  const source = `export function budgetSeed() {
${Array.from({ length: 45 }, (_, index) => `  const budgetStep${index} = ${index}`).join('\n')}
  return budgetNeedle(budgetStep44)
}
function budgetNeedle(value: number) { return value }
`
  await writeFile(path, source)
  const database = await openEmbeddedDatabase(data)
  const index = createCodeIndex({ database })
  t.after(async () => {
    await index.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  })
  await index.indexRepository({ root })
  const context = createCodeContext({ index, limits: { maxRangeLines: 20 } })
  t.after(() => context.close())
  const result = await context.getCodeContext({ root, query: 'budgetNeedle', includeLogical: true,
    maxChars: 180, mustInclude: [{ path: 'budget.ts', lineStart: 1, lineEnd: 1 }] })
  assert.equal(result.sections[0]?.reason, 'mandatory')
  assert.ok(result.budget.usedChars <= 180)
  assert.equal(result.budget.usedChars, result.sections.reduce((sum, section) => sum + section.text.length, 0))
  assert.ok(result.sections.every((section) => section.lineEnd - section.lineStart + 1 <= 20))
  const omission = result.logicalContext?.omissions.find((entry) => entry.reason === 'budget')
  assert.ok(omission?.continuation)
  assert.ok((omission!.continuation!.lineEnd - omission!.continuation!.lineStart + 1) <= 20)
  assert.equal(omission!.continuation!.snapshotId, result.identity.snapshotId)
  await writeFile(path, source.replace('budgetNeedle', 'changedBudgetNeedle'))
  await assert.rejects(index.readSource({ root, path: 'budget.ts', lineStart: omission!.continuation!.lineStart,
    lineEnd: omission!.continuation!.lineEnd, snapshotId: omission!.continuation!.snapshotId }),
  (error: unknown) => error instanceof Error && /SOURCE_CHANGED|SNAPSHOT_MISMATCH|STALE/u.test(error.message))
})

test('logical optional ports retain root and scoped this receivers and legacy adapters report unsupported', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-logical-receiver-root-'))
  const data = await mkdtemp(join(tmpdir(), 'zorya-logical-receiver-db-'))
  await writeFile(join(root, 'receiver.ts'), 'export function receiverNeedle() { return 7 }\n')
  const database = await openEmbeddedDatabase(data)
  const index = createCodeIndex({ database })
  t.after(async () => {
    await index.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  })
  await index.indexRepository({ root })
  const receiverCalls = { root: 0, scopedSymbols: 0, scopedReferences: 0 }
  const wrapped: Record<string, unknown> = { ...index }
  wrapped.findCodeSymbols = function (this: unknown, input: Parameters<NonNullable<CodeIndex['findCodeSymbols']>>[0]) {
    assert.equal(this, wrapped)
    receiverCalls.root++
    return index.findCodeSymbols!(input)
  }
  wrapped.findCodeReferences = function (this: unknown, input: Parameters<NonNullable<CodeIndex['findCodeReferences']>>[0]) {
    assert.equal(this, wrapped)
    return index.findCodeReferences!(input)
  }
  wrapped.withReadSnapshot = function (this: unknown, currentRoot: string, signal: AbortSignal, work: (scope: any) => Promise<unknown>) {
    assert.equal(this, wrapped)
    return index.withReadSnapshot!(currentRoot, signal, (baseScope) => {
      const scope: Record<string, unknown> = { ...baseScope }
      scope.findCodeSymbols = function (this: unknown, input: Parameters<NonNullable<CodeIndex['findCodeSymbols']>>[0]) {
        assert.equal(this, scope)
        receiverCalls.scopedSymbols++
        return baseScope.findCodeSymbols!(input)
      }
      scope.findCodeReferences = function (this: unknown, input: Parameters<NonNullable<CodeIndex['findCodeReferences']>>[0]) {
        assert.equal(this, scope)
        receiverCalls.scopedReferences++
        return baseScope.findCodeReferences!(input)
      }
      return work(scope as any)
    })
  }
  const context = createCodeContext({ index: wrapped as unknown as CodeIndex })
  t.after(() => context.close())
  const result = await context.getCodeContext({ root, query: 'receiverNeedle', includeLogical: true })
  assert.equal(result.logicalContext?.state, 'available')
  assert.ok(receiverCalls.scopedSymbols > 0)
  assert.ok(receiverCalls.scopedReferences > 0)
  assert.equal(receiverCalls.root, 0) // snapshot scoped methods are the active operation ports

  const legacy = createCodeContext({ index: legacyAdapter(root) })
  t.after(() => legacy.close())
  const unsupported = await legacy.getCodeContext({ root, query: 'receiverNeedle', includeLogical: true })
  assert.equal(unsupported.logicalContext?.state, 'unsupported')
  assert.equal(unsupported.logicalContext?.profileId, null)
  assert.equal(unsupported.logicalContext?.blocks.length, 0)
})

test('missing symbol metadata is reported as not_indexed without read-time backfill', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-logical-metadata-root-'))
  const data = await mkdtemp(join(tmpdir(), 'zorya-logical-metadata-db-'))
  const database = await openEmbeddedDatabase(data)
  const index = createCodeIndex({ database })
  t.after(async () => {
    await index.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  })
  await writeFile(join(root, 'metadata.ts'), 'export function metadataNeedle() { return 1 }\n')
  await index.indexRepository({ root })
  await database.query('DELETE FROM zorya_code_analysis_state')
  await database.query('DELETE FROM zorya_code_analysis')
  const context = createCodeContext({ index })
  t.after(() => context.close())
  const result = await context.getCodeContext({ root, query: 'metadataNeedle', includeLogical: true })
  assert.equal(result.logicalContext?.state, 'not_indexed')
  assert.equal(result.logicalContext?.blocks.length, 0)
  const count = await database.query<{ count: string }>('SELECT count(*)::text AS count FROM zorya_code_analysis')
  assert.equal(count.rows[0]?.count, '0')
})

test('logical lookup cancellation and close physically join an abort-ignoring scoped symbol read', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-logical-close-root-'))
  const data = await mkdtemp(join(tmpdir(), 'zorya-logical-close-db-'))
  const database = await openEmbeddedDatabase(data)
  const index = createCodeIndex({ database })
  let enteredResolve: (() => void) | undefined
  let releaseResolve: (() => void) | undefined
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
  const gate = new Promise<void>((resolve) => { releaseResolve = resolve })
  let block = false
  const wrapped: Record<string, unknown> = { ...index }
  wrapped.withReadSnapshot = function (rootPath: string, signal: AbortSignal, work: (scope: any) => Promise<unknown>) {
    return index.withReadSnapshot!(rootPath, signal, (baseScope) => {
      const scope: Record<string, unknown> = { ...baseScope }
      scope.findCodeSymbols = async (input: Parameters<NonNullable<CodeIndex['findCodeSymbols']>>[0]) => {
        if (block) { block = false; enteredResolve?.(); await gate }
        return baseScope.findCodeSymbols!(input)
      }
      return work(scope as any)
    })
  }
  t.after(async () => {
    releaseResolve?.()
    await index.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  })
  await writeFile(join(root, 'pending.ts'), 'export function pendingNeedle() { return 1 }\n')
  await index.indexRepository({ root })
  const context = createCodeContext({ index: wrapped as unknown as CodeIndex })
  const pending = context.getCodeContext({ root, query: 'pendingNeedle', includeLogical: true })
  block = true
  await entered
  let closeSettled = false
  const closing = context.close().then(() => { closeSettled = true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(closeSettled, false)
  releaseResolve?.()
  await assert.rejects(pending)
  await closing
  assert.equal(closeSettled, true)
})

function legacyAdapter(root: string): CodeIndex {
  const identity: CodeSourceIdentity = { repoId: 'repo', worktreeId: 'wt', root, branch: null, head: null,
    snapshotId: 'legacy-snapshot', contentHash: 'legacy-content' }
  const hit: CodeHit = { id: 'legacy-hit', path: 'receiver.ts', lineStart: 1, lineEnd: 1, symbol: 'receiverNeedle',
    language: 'typescript', contentHash: 'chunk', repoId: identity.repoId, worktreeId: identity.worktreeId,
    branch: identity.branch, head: identity.head, snapshotId: identity.snapshotId, profileId: null, score: 1,
    ranking: { mode: 'lexical', lexicalRank: 1, denseRank: null, rerankRank: null } }
  return {
    indexStatus: async () => ({ identity, indexedAt: null, fileCount: 1, chunkCount: 1, profileId: null, denseAvailable: false, denseDisabledReason: null }),
    searchCode: async () => ({ hits: [hit], identity, degraded: false, degradedReason: null }),
    readSource: async () => ({ path: 'receiver.ts', lineStart: 1, lineEnd: 1, text: 'legacy', contentHash: 'file', snapshotId: identity.snapshotId, stale: false }),
    relatedCode: async () => ({ identity, imports: [], importedBy: [], similar: [], stale: false }),
    watchRepository: async () => ({ close: async () => {} }),
    close: async () => {},
    indexRepository: async () => ({ identity }),
    sourceFingerprint: async () => identity.contentHash,
  } as unknown as CodeIndex
}
