import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCodeContext, CodeContextError } from '../../src/context/index.js'
import { createReuseContext } from '../../src/context/index.js'
import { OperationLimitError, OperationTimeoutError } from '../../src/context/lifecycle.js'
import type { CodeIndex, CodeHit, CodeSourceIdentity } from '../../src/code/types.js'
import { createWebSearch } from '../../src/context/web.js'
import { createClassificationTool } from '../../src/context/classify.js'
import type { JevDecisionsPort } from '../../src/providers/decision-types.js'
import { ProviderError, type Classifier } from '../../src/providers/contracts.js'
import { createOpenRouterReranker } from '../../src/providers/openrouter.js'
import { createCodeIndex } from '../../src/code/index.js'
import { openEmbeddedDatabase } from '../../src/storage/embedded.js'
import { afterEach } from 'node:test'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(cleanup.splice(0).map((fn) => fn())))

const identity: CodeSourceIdentity = {
  repoId: 'r',
  worktreeId: 'w',
  root: '/repo',
  branch: 'main',
  head: 'h',
  snapshotId: 's1',
  contentHash: 'tree1',
}
function fakeIndex(
  opts: {
    staleRead?: boolean
    staleFinalStatus?: boolean
    delay?: boolean
    profileId?: string
    metrics?: { reads: number; related: number }
    similar?: CodeHit[]
    searchHits?: CodeHit[]
  } = {},
) {
  let statusCalls = 0
  const hit = (path: string, lineStart: number): CodeHit => ({
    id: `${path}:${lineStart}`,
    path,
    lineStart,
    lineEnd: lineStart,
    symbol: null,
    language: 'typescript',
    contentHash: `chunk-${path}`,
    repoId: 'r',
    worktreeId: 'w',
    branch: 'main',
    head: 'h',
    snapshotId: 's1',
    profileId: opts.profileId ?? null,
    score: 1,
    ranking: { mode: 'lexical', lexicalRank: 1, denseRank: null, rerankRank: null },
  })
  const index = {
    indexStatus: async () => ({
      identity:
        (opts.staleRead && ++statusCalls > 2) || (opts.staleFinalStatus && ++statusCalls > 1)
          ? { ...identity, snapshotId: 's2' }
          : identity,
      indexedAt: null,
      fileCount: 3,
      chunkCount: 3,
      profileId: opts.profileId ?? null,
      denseAvailable: false,
      denseDisabledReason: null,
    }),
    searchCode: async ({ query }: { query: string }) => ({
      hits: opts.searchHits ?? (query.includes('feature') ? [hit('b.ts', 3)] : [hit('a.ts', 2), hit('b.ts', 3)]),
      identity,
      degraded: false,
      degradedReason: null,
    }),
    readSource: async ({
      path,
      lineStart = 1,
      lineEnd = 200,
    }: {
      path: string
      lineStart?: number
      lineEnd?: number
    }) => {
      if (opts.metrics) opts.metrics.reads++
      const text = Array.from({ length: lineEnd - lineStart + 1 }, () => 'x').join('\n')
      if (opts.delay)
        return new Promise<any>((resolve) =>
          setTimeout(
            () =>
              resolve({
                path,
                lineStart,
                lineEnd,
                text,
                contentHash: `file-${path}`,
                snapshotId: 's1',
                stale: false,
              }),
            100,
          ),
        )
      return {
        path,
        lineStart,
        lineEnd,
        text,
        contentHash: `file-${path}`,
        snapshotId: opts.staleRead ? 's2' : 's1',
        stale: false,
      }
    },
    close: async () => {},
    indexRepository: async () => ({ identity }),
    relatedCode: async () => {
      if (opts.metrics) opts.metrics.related++
      return { identity, imports: [], importedBy: [], similar: opts.similar ?? [], stale: false }
    },
    watchRepository: async () => ({ close: async () => {} }),
  }
  return index as unknown as CodeIndex
}

test('code context fuses feature queries, merges overlapping ranges and keeps hashes distinct', async () => {
  const context = createCodeContext({ index: fakeIndex() })
  const result = await context.getCodeContext({
    root: '/repo',
    query: 'base',
    featureQueries: ['feature'],
    mustInclude: [{ path: 'a.ts', lineStart: 1, lineEnd: 2 }],
  })
  assert.equal(result.identity.snapshotId, 's1')
  assert.equal(result.sections.find((x) => x.path === 'a.ts')?.reason, 'mandatory')
  assert.equal(result.sections.find((x) => x.path === 'a.ts')?.fileContentHash, 'file-a.ts')
  assert.equal(result.sections.find((x) => x.path === 'a.ts')?.candidateChunkHash, 'chunk-a.ts')
  assert.ok(result.sections.some((x) => x.path === 'b.ts'))
  assert.ok(result.budget.usedChars <= result.budget.maxChars)
  await context.close()
})

test('context compatibility barrel retains code context and exposes reuse constructor', async () => {
  assert.equal(typeof createCodeContext, 'function')
  assert.equal(typeof createReuseContext, 'function')
  const context = createCodeContext({ index: fakeIndex() })
  const result = await context.getCodeContext({ root: '/repo', query: 'base' })
  assert.equal(result.identity.snapshotId, 's1')
  await context.close()
})

test('reuse context preserves original query, maps Jev choices to verified symbols, and runs scoped duplicate inspection', async () => {
  const fileHash = 'file-a.ts'
  const symbol = {
    id: 'symbol-real-1', name: 'applyChange', qualifiedName: 'applyChange', kind: 'function' as const,
    location: { path: 'a.ts', start: 0, end: 32, lineStart: 1, lineEnd: 2, fileHash },
    parentId: null, container: null, signature: 'function applyChange()', signatureTruncated: false,
    contract: false, synthetic: false, overloadGroupId: null,
  }
  const base = fakeIndex() as any
  const originalQuery = 'How can I safely cancel a waiting request?'
  const observedQueries: string[] = []
  let observedSymbolState: any
  let observedSymbolQuestion: any
  base.searchCode = async (input: { query: string }) => {
    observedQueries.push(input.query)
    return { hits: [{
      id: 'hit-a', path: 'a.ts', lineStart: 1, lineEnd: 2, symbol: 'applyChange', language: 'typescript',
      contentHash: fileHash, repoId: 'r', worktreeId: 'w', branch: 'main', head: 'h', snapshotId: 's1',
      profileId: null, score: 1, ranking: { mode: 'lexical', lexicalRank: 1, denseRank: null, rerankRank: null },
    }], identity, degraded: false, degradedReason: null }
  }
  base.findCodeSymbols = async () => ({
    analysis: { state: 'indexed', identity, profile: null, complete: true, coverage: [], coverageTotalFiles: 1, coverageOmittedFiles: 0,
      coverageCounts: { parsed: 1, parseError: 0, unsupported: 0, truncated: 0, error: 0 }, unresolvedReferenceCount: 0,
      unresolvedCallCount: 0, truncation: { symbols: false, references: false, files: false }, symbolCount: 1, referenceCount: 0, indexedAt: null },
    symbols: [symbol], nextCursor: null, truncated: false,
  })
  base.findCodeDuplicates = async () => ({ identity, supportedLanguages: ['TypeScript'], groups: [],
    counts: { scannedFiles: 1, indexedFiles: 1, eligibleFiles: 1, parsedFiles: 1, functions: 1, skippedParse: 0, skippedOversize: 0, skippedUnsupported: 0 },
    truncation: { groups: false, occurrences: false, scan: false, complete: true } })
  const decisions: JevDecisionsPort = {
    profile: { provider: 'TypeSafe', model: 'typesafe/jev-1.14', space: 'jev' },
    usage: () => ({ calls: 0, inputTokens: 0, totalTokens: 0, estimatedCost: 0, latencyMs: 0 }),
    async decide({ questions, state }) {
      const answers: Record<string, any> = Object.create(null)
      if (questions.some((q) => q.id.startsWith('symbol_'))) {
        observedSymbolState = state
        observedSymbolQuestion = questions.find((q) => q.id.startsWith('symbol_'))
      }
      for (const question of questions) {
        if (question.id === 'taskIntent') answers[question.id] = { type: 'choice', choice: 'explain_behavior' }
        else if (question.id === 'sourceScope') answers[question.id] = { type: 'choice', choice: 'unspecified' }
        else if (question.type === 'noul') answers[question.id] = { type: 'noul', noul: 0.9 }
        else answers[question.id] = { type: 'choice', choice: 's0', probabilities: { s0: 1, none: 0 } }
      }
      return { requestId: null, model: 'typesafe/jev-1.14', provider: 'TypeSafe', answers, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCost: 0 } }
    },
  }
  const reuse = createReuseContext({ index: base, decisions })
  const result = await reuse.getReuseContext({ root: '/repo', query: originalQuery })
  assert.equal(observedQueries[0], originalQuery)
  assert.ok(observedQueries.includes(originalQuery))
  assert.equal(result.selection.selected[0]?.symbol.id, symbol.id)
  assert.equal(observedSymbolState.questions.symbol_0.symbols.s0.name, symbol.name)
  assert.equal(observedSymbolState.questions.symbol_0.symbols.s0.evidence.fileHash, fileHash)
  assert.equal(observedSymbolState.questions.symbol_0.symbols.s0.evidence.range.lineStart, 1)
  assert.equal(typeof observedSymbolState.questions.symbol_0.symbols.s0.evidence.text, 'string')
  assert.ok(observedSymbolState.questions.symbol_0.symbols.s0.evidence.text.length > 0)
  assert.match(observedSymbolQuestion.criteria.s0, /applyChange/u)
  assert.match(observedSymbolQuestion.instructions, /untrusted data/u)
  assert.equal(result.context.sections.some((section) => section.path === 'a.ts'), true)
  assert.equal(result.readCoverage[0]?.status, 'full')
  assert.equal(result.duplicates.state, 'available')
  assert.deepEqual(result.duplicates.scope, ['a.ts'])
  await reuse.close()
})

test('reuse context stops semantic dispatch after a failed intent call', async () => {
  let calls = 0
  const decisions: JevDecisionsPort = {
    profile: { provider: 'TypeSafe', model: 'typesafe/jev-1.14', space: 'jev' },
    usage: () => ({ calls, inputTokens: null, totalTokens: null, estimatedCost: null, latencyMs: 0 }),
    async decide() { calls++; throw new ProviderError('auth') },
  }
  const reuse = createReuseContext({ index: fakeIndex(), decisions })
  const result = await reuse.getReuseContext({ root: '/repo', query: 'explain this behavior' })
  assert.equal(calls, 1)
  assert.equal(result.intent.state, 'unavailable')
  assert.equal(result.selection.selected.length, 0)
  assert.ok(result.selection.unassessed.length > 0)
  await reuse.close()
})

test('code context enforces source-kind filters on legacy adapters that ignore search fields', async () => {
  const context = createCodeContext({ index: fakeIndex() })
  const filtered = await context.getCodeContext({ root: '/repo', query: 'base', sourceKind: 'documentation' })
  assert.deepEqual(filtered.sections, [])
  const explicit = await context.getCodeContext({
    root: '/repo', query: 'base', sourceKind: 'documentation',
    mustInclude: [{ path: 'docs/README.md', lineStart: 1, lineEnd: 1 }],
  })
  assert.deepEqual(explicit.sections.map((section) => [section.path, section.reason]), [['docs/README.md', 'mandatory']])
  await context.close()
})

test('legacy context filtering excludes documentation and preserves original primary and similar ranks', async () => {
  const makeHit = (path: string): CodeHit => ({
    id: path, path, lineStart: 1, lineEnd: 1, symbol: null, language: 'ts',
    contentHash: `chunk-${path}`, repoId: identity.repoId, worktreeId: identity.worktreeId,
    branch: identity.branch, head: identity.head, snapshotId: identity.snapshotId,
    profileId: null, score: 1,
    ranking: { mode: 'lexical', lexicalRank: 1, denseRank: null, rerankRank: null },
  })
  const context = createCodeContext({ index: fakeIndex({
    searchHits: [makeHit('docs/README.md'), makeHit('src/main.ts')],
    similar: [makeHit('docs/related.md'), makeHit('src/related.ts')],
  }) })
  const result = await context.getCodeContext({
    root: '/repo', query: 'base', sourceKind: 'implementation', includeRelated: true,
  })
  assert.ok(result.sections.every((section) => !section.path.startsWith('docs/')))
  const primary = result.sections.find((section) => section.path === 'src/main.ts')
  assert.equal(primary?.rankOrigins.find((origin) => origin.source === 'query')?.rank, 2)
  const similar = result.sections.find((section) => section.path === 'src/related.ts')
  assert.equal(similar?.rankOrigins.find((origin) => origin.relatedKind === 'similar')?.rank, 2)
  assert.equal(similar?.rankOrigins.find((origin) => origin.relatedKind === 'similar')?.source, 'related')
  await context.close()
})

test('code context reports status/profile and per-query ranking provenance separately from file hashes', async () => {
  const context = createCodeContext({ index: fakeIndex({ profileId: 'embed:model:2' }) })
  const result = await context.getCodeContext({ root: '/repo', query: 'base' })
  assert.equal(result.profileId, 'embed:model:2')
  assert.equal(result.sections[0]?.profileId, 'embed:model:2')
  assert.equal(result.sections[0]?.rankOrigins[0]?.mode, 'lexical')
  assert.equal(result.sections[0]?.rankOrigins[0]?.lexicalRank, 1)
  assert.ok((result.sections[0]?.fusionScore ?? 0) > 0)
  assert.match(result.sections[0]?.fileContentHash ?? '', /^file-/)
  assert.match(result.sections[0]?.candidateChunkHash ?? '', /^chunk-/)
  await context.close()
})

test('mandatory context fails explicitly when budget cannot contain it; stale reads are rejected', async () => {
  const context = createCodeContext({ index: fakeIndex() })
  await assert.rejects(
    context.getCodeContext({
      root: '/repo',
      query: 'base',
      mustInclude: [{ path: 'a.ts' }],
      maxChars: 5,
    }),
    (e) => e instanceof CodeContextError && e.code === 'MANDATORY_BUDGET',
  )
  await context.close()
  const stale = createCodeContext({ index: fakeIndex({ staleRead: true }) })
  await assert.rejects(
    stale.getCodeContext({ root: '/repo', query: 'base' }),
    (e) => e instanceof CodeContextError && e.code === 'STALE_SNAPSHOT',
  )
  await stale.close()
})

test('missing identity during a source reread yields a typed stale-snapshot error', async () => {
  const index = fakeIndex()
  let statusCalls = 0
  index.indexStatus = async () => {
    statusCalls++
    return statusCalls === 1
      ? {
          identity,
          indexedAt: null,
          fileCount: 1,
          chunkCount: 1,
          profileId: null,
          denseAvailable: false,
          denseDisabledReason: null,
        }
      : {
          identity: null,
          indexedAt: null,
          fileCount: 0,
          chunkCount: 0,
          profileId: null,
          denseAvailable: false,
          denseDisabledReason: null,
        }
  }
  const context = createCodeContext({ index })
  await assert.rejects(
    context.getCodeContext({ root: '/repo', query: 'base', mustInclude: [{ path: 'a.ts' }] }),
    (error) => error instanceof CodeContextError && error.code === 'STALE_SNAPSHOT',
  )
  await context.close()
})

test('code context defaults to no graph traversal and skips reads for fully covered candidates', async () => {
  const metrics = { reads: 0, related: 0 }
  const context = createCodeContext({ index: fakeIndex({ metrics }) })
  const result = await context.getCodeContext({
    root: '/repo',
    query: 'base',
    mustInclude: [{ path: 'a.ts', lineStart: 2, lineEnd: 2 }],
  })
  assert.equal(metrics.related, 0)
  assert.equal(metrics.reads, 2)
  assert.equal(result.sections.filter((section) => section.path === 'a.ts').length, 1)
  assert.ok(result.sections.find((section) => section.path === 'a.ts')?.rankOrigins.length)
  await context.close()
})

test('includeRelated opt-in marks only graph candidates as related with graph provenance', async () => {
  const metrics = { reads: 0, related: 0 }
  const index = fakeIndex({ metrics })
  const similar = {
    ...(await index.searchCode({ root: '/repo', query: 'base', limit: 2 })).hits[0]!,
    id: 'c.ts:7',
    path: 'c.ts',
    lineStart: 7,
    lineEnd: 7,
  }
  index.relatedCode = async () => {
    metrics.related++
    return { identity, imports: [], importedBy: [], similar: [similar], stale: false }
  }
  const context = createCodeContext({ index })
  const result = await context.getCodeContext({
    root: '/repo',
    query: 'base',
    includeRelated: true,
  })
  assert.ok(metrics.related > 0)
  assert.ok(
    result.sections.some((section) =>
      section.rankOrigins.some((origin) => origin.source === 'related' && origin.relatedKind === 'similar'),
    ),
  )
  assert.deepEqual(result.relatedGraph, { status: 'unsupported' })
  await context.close()
})

test('related graph bounds require explicit opt-in and honor the maximum depth', async () => {
  const context = createCodeContext({ index: fakeIndex() })
  assert.throws(() => context.getCodeContext({ root: '/repo', query: 'base', relatedDepth: 2 }),
    (error) => error instanceof CodeContextError && error.code === 'LIMIT')
  assert.throws(() => context.getCodeContext({ root: '/repo', query: 'base', includeRelated: true, relatedDepth: 5 }),
    (error) => error instanceof CodeContextError && error.code === 'LIMIT')
  await context.close()
})

test('dependency graph context ranks reached paths with filtered search and exposes observed edges', async () => {
  const index = fakeIndex()
  const seed = (await index.searchCode({ root: '/repo', query: 'base', limit: 1 })).hits[0]!
  const documentation = { ...seed, id: 'docs.md:1', path: 'docs/readme.md', language: 'md' }
  const target = { ...seed, id: 'impl.ts:9', path: 'impl.ts', lineStart: 9, lineEnd: 9, contentHash: 'impl-chunk' }
  const similar = { ...target, id: 'helper.ts:4', path: 'helper.ts', lineStart: 4, lineEnd: 4 }
  index.dependencyGraph = async ({ seeds }: { seeds: string[] }) => ({
    identity, seeds, requestedDepth: 2, reachedDepth: 1,
    nodes: [{ path: seeds[0]!, depth: 0, seed: seeds[0]!, parent: null, relation: 'seed' }, { path: 'impl.ts', depth: 1, seed: seeds[0]!, parent: seeds[0]!, relation: 'imports' }],
    edges: [{ from: seeds[0]!, to: 'impl.ts', direction: 'imports' }], limits: { depth: false, nodes: false, edges: false },
  })
  index.searchCode = async (input: { paths?: string[] }) => ({
    hits: input.paths?.includes('impl.ts') ? [documentation, target] : [documentation, seed], identity,
    degraded: Boolean(input.paths?.includes('impl.ts')),
    degradedReason: input.paths?.includes('impl.ts') ? 'filtered-profile-unavailable' : null,
  })
  index.relatedCode = async () => ({ identity, imports: [], importedBy: [], similar: [documentation, similar], stale: false })
  const context = createCodeContext({ index })
  const result = await context.getCodeContext({ root: '/repo', query: 'base', includeRelated: true, sourceKind: 'implementation' })
  assert.equal(result.relatedGraph?.status, 'available')
  assert.deepEqual(result.relatedGraph?.graph?.edges, [{ from: 'a.ts', to: 'impl.ts', direction: 'imports' }])
  assert.ok(result.sections.every((item) => !item.path.startsWith('docs/')))
  const section = result.sections.find((item) => item.path === 'impl.ts')
  assert.equal(section?.reason, 'related')
  assert.equal(section?.rankOrigins[0]?.source, 'related')
  assert.equal(section?.rankOrigins[0]?.relatedKind, 'dependency')
  assert.equal(section?.rankOrigins[0]?.rank, 2)
  const similarSection = result.sections.find((item) => item.path === 'helper.ts')
  assert.equal(similarSection?.rankOrigins[0]?.relatedKind, 'similar')
  assert.equal(similarSection?.rankOrigins[0]?.relatedSeed, 'a.ts')
  assert.equal(similarSection?.rankOrigins[0]?.rank, 2)
  assert.deepEqual(result.degradedReasons, ['filtered-profile-unavailable'])
  await context.close()
})

test('overlapping dependency and primary reads keep search reason and both provenance kinds', async () => {
  const index = fakeIndex()
  const makeHit = (path: string, lineStart: number): CodeHit => ({
    id: `${path}:${lineStart}`, path, lineStart, lineEnd: lineStart,
    symbol: null, language: 'typescript', contentHash: `chunk-${path}`,
    repoId: identity.repoId, worktreeId: identity.worktreeId, branch: identity.branch,
    head: identity.head, snapshotId: identity.snapshotId, profileId: null, score: 1,
    ranking: { mode: 'lexical', lexicalRank: 1, denseRank: null, rerankRank: null },
  })
  const baseHits = [makeHit('a.ts', 1), makeHit('b.ts', 1), makeHit('c.ts', 1), makeHit('d.ts', 4)]
  const dependencyHit = makeHit('d.ts', 3)
  index.searchCode = async (input: { paths?: string[] }) => ({
    hits: input.paths?.includes('d.ts') ? [dependencyHit] : baseHits,
    identity, degraded: false, degradedReason: null,
  })
  index.dependencyGraph = async ({ seeds }: { seeds: string[] }) => ({
    identity, seeds, requestedDepth: 1, reachedDepth: 1,
    nodes: [
      ...seeds.map((path) => ({ path, depth: 0, seed: path, parent: null, relation: 'seed' as const })),
      { path: 'd.ts', depth: 1, seed: seeds[0]!, parent: seeds[0]!, relation: 'imports' as const },
    ],
    edges: [{ from: seeds[0]!, to: 'd.ts', direction: 'imports' }],
    limits: { depth: true, nodes: false, edges: false },
  })
  const context = createCodeContext({ index })
  const result = await context.getCodeContext({ root: '/repo', query: 'base', includeRelated: true })
  const merged = result.sections.find((section) => section.path === 'd.ts')
  assert.deepEqual([merged?.lineStart, merged?.lineEnd], [3, 4])
  assert.equal(merged?.reason, 'search')
  assert.equal(merged?.rankOrigins.some((origin) => origin.source === 'query'), true)
  assert.equal(merged?.rankOrigins.some((origin) => origin.relatedKind === 'dependency'), true)
  await context.close()
})

test('context rejects a dependency graph from a foreign snapshot and defaults off', async () => {
  const index = fakeIndex()
  let graphCalls = 0
  index.dependencyGraph = async () => {
    graphCalls++
    return { identity: { ...identity, snapshotId: 'foreign' }, seeds: ['a.ts'], nodes: [], edges: [],
      requestedDepth: 2, reachedDepth: 0, limits: { depth: false, nodes: false, edges: false } }
  }
  const context = createCodeContext({ index })
  const result = await context.getCodeContext({ root: '/repo', query: 'base' })
  assert.equal(graphCalls, 0)
  assert.equal('relatedGraph' in result, false)
  await assert.rejects(context.getCodeContext({ root: '/repo', query: 'base', includeRelated: true }),
    (error) => error instanceof CodeContextError && error.code === 'STALE_SNAPSHOT')
  assert.equal(graphCalls, 1)
  await context.close()
})

test('mandatory and primary context retain budget before dependency candidates', async () => {
  const index = fakeIndex()
  const seed = (await index.searchCode({ root: '/repo', query: 'base', limit: 1 })).hits[0]!
  const target = { ...seed, id: 'impl.ts:9', path: 'impl.ts', lineStart: 9, lineEnd: 9 }
  index.dependencyGraph = async ({ seeds }: { seeds: string[] }) => ({
    identity, seeds, requestedDepth: 2, reachedDepth: 1,
    nodes: [{ path: seeds[0]!, depth: 0, seed: seeds[0]!, parent: null, relation: 'seed' },
      { path: 'impl.ts', depth: 1, seed: seeds[0]!, parent: seeds[0]!, relation: 'imports' }],
    edges: [{ from: seeds[0]!, to: 'impl.ts', direction: 'imports' }],
    limits: { depth: false, nodes: false, edges: false },
  })
  index.searchCode = async (input: { paths?: string[] }) => ({
    hits: input.paths?.includes('impl.ts') ? [target] : [seed], identity, degraded: false, degradedReason: null,
  })
  const context = createCodeContext({ index })
  const result = await context.getCodeContext({ root: '/repo', query: 'base', includeRelated: true,
    mustInclude: [{ path: 'required.ts' }], maxChars: 400 })
  assert.equal(result.sections.find((section) => section.path === 'required.ts')?.reason, 'mandatory')
  assert.equal(result.sections.some((section) => section.path === 'a.ts'), true)
  assert.equal(result.sections.some((section) => section.path === 'impl.ts'), false)
  assert.ok(result.omitted.some((entry) => entry.path === 'impl.ts' && entry.reason === 'budget'))
  await context.close()
})

test('a changed snapshot during source reads is rejected by the final identity check', async () => {
  const context = createCodeContext({ index: fakeIndex({ staleFinalStatus: true }) })
  await assert.rejects(
    context.getCodeContext({ root: '/repo', query: 'base', mustInclude: [{ path: 'a.ts' }] }),
    (error) => error instanceof CodeContextError && error.code === 'STALE_SNAPSHOT',
  )
  await context.close()
})

test('adjacent mandatory ranges exceeding the merge cap remain represented without duplicate lines', async () => {
  const context = createCodeContext({ index: fakeIndex(), limits: { maxRangeLines: 2 } })
  const result = await context.getCodeContext({
    root: '/repo',
    query: 'absent',
    mustInclude: [
      { path: 'a.ts', lineStart: 1, lineEnd: 2 },
      { path: 'a.ts', lineStart: 2, lineEnd: 3 },
    ],
    maxChars: 4,
  })
  const sections = result.sections.filter((section) => section.path === 'a.ts')
  assert.deepEqual(
    sections.map(({ lineStart, lineEnd }) => [lineStart, lineEnd]),
    [
      [1, 2],
      [3, 3],
    ],
  )
  assert.equal(result.budget.usedChars, 4)
  assert.ok(sections.every((section) => section.lineEnd - section.lineStart + 1 <= 2))
  await context.close()
})

test('web search reports source provenance and partial fetch errors without generated answers', async () => {
  const web = createWebSearch({
    web: {
      discover: async () => ['https://example.com/a?utm_source=x', 'https://example.com/b'],
      fetchDocument: async (url) => {
        if (url.endsWith('/b')) throw new Error('offline')
        return {
          url,
          title: 'Example',
          text: 'alpha code source details',
          fetchedAt: '2026-01-01T00:00:00.000Z',
          publishedAt: null,
          sourceUpdatedAt: null,
        }
      },
    },
  })
  const result = await web.searchWeb({ query: 'alpha', limit: 4 })
  assert.equal(result.rankingMode, 'lexical')
  assert.equal(result.passages[0]?.canonicalURL, 'https://example.com/a')
  assert.match(result.passages[0]?.contentHash ?? '', /^[a-f0-9]{64}$/)
  assert.equal(result.partial, true)
  assert.equal(result.errors[0]?.stage, 'document')
  assert.equal('answer' in result, false)
  await web.close()
})

test('web search exposes bounded typed provider failures without leaking error text', async () => {
  const make = (discover: () => Promise<string[]>, fetchDocument = async (url: string) => ({
    url,
    title: 'needle',
    text: 'needle from a bounded source',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    publishedAt: null,
    sourceUpdatedAt: null,
  })) => createWebSearch({ web: { discover, fetchDocument } })

  const quota = new ProviderError('quota', 402)
  quota.message = 'secret API key and provider response body'
  const quotaSearch = make(async () => { throw quota })
  const quotaResult = await quotaSearch.searchWeb({ query: 'needle' })
  assert.deepEqual(quotaResult.errors, [
    { stage: 'discovery', code: 'DISCOVERY_FAILED', provider: { code: 'quota', httpStatus: 402 } },
  ])
  assert.doesNotMatch(JSON.stringify(quotaResult), /secret|response body/i)
  await quotaSearch.close()

  const rateLimitSearch = make(async () => { throw new ProviderError('rate_limit', 429, 1500) })
  const rateLimitResult = await rateLimitSearch.searchWeb({ query: 'needle' })
  assert.deepEqual(rateLimitResult.errors[0]?.provider, {
    code: 'rate_limit',
    httpStatus: 429,
    retryAfterMs: 1500,
  })
  await rateLimitSearch.close()

  const untypedSearch = make(async () => {
    throw Object.assign(new Error('secret untrusted error'), { code: 'quota', status: 402 })
  })
  const untypedResult = await untypedSearch.searchWeb({ query: 'needle' })
  assert.deepEqual(untypedResult.errors, [{ stage: 'discovery', code: 'DISCOVERY_FAILED' }])
  await untypedSearch.close()

  const emptySearch = make(async () => [])
  const emptyResult = await emptySearch.searchWeb({ query: 'needle' })
  assert.deepEqual(emptyResult.errors, [])
  assert.equal(emptyResult.partial, false)
  await emptySearch.close()
})

test('web search attaches typed provider context to partial document and model failures', async () => {
  const documentSearch = createWebSearch({
    web: {
      discover: async () => ['https://example.com/good', 'https://example.com/fail'],
      fetchDocument: async (url) => {
        if (url.endsWith('/fail')) throw new ProviderError('auth', 401)
        return {
          url,
          title: 'needle',
          text: 'needle from a bounded source',
          fetchedAt: '2026-01-01T00:00:00.000Z',
          publishedAt: null,
          sourceUpdatedAt: null,
        }
      },
    },
    models: {
      embed: {
        profile: { provider: 'test', model: 'embed', space: 'web', dimensions: 2 },
        embed: async () => { throw new ProviderError('timeout') },
      },
      rerank: {
        profile: { provider: 'test', model: 'rank', space: 'rank' },
        rerank: async () => { throw new ProviderError('unavailable', 503) },
      },
    },
  })
  const result = await documentSearch.searchWeb({ query: 'needle' })
  assert.deepEqual(
    result.errors.map(({ stage, code, provider }) => ({ stage, code, provider })),
    [
      { stage: 'document', code: 'DOCUMENT_FAILED', provider: { code: 'auth', httpStatus: 401 } },
      { stage: 'embedding', code: 'EMBEDDING_FAILED', provider: { code: 'timeout' } },
      { stage: 'rerank', code: 'RERANK_FAILED', provider: { code: 'unavailable', httpStatus: 503 } },
    ],
  )
  assert.equal(result.partial, true)
  assert.equal(result.passages.length, 1)
  await documentSearch.close()
})

test('web search and readWebSource retain source whitespace in returned excerpts', async () => {
  const literal='  const marker = 1\n\tif (marker) {\n    return "needle"\n  }\n'
  const context=createWebSearch({web:{discover:async()=>['https://example.com/literal'],fetchDocument:async(url)=>({url,title:'Literal',text:literal,fetchedAt:'2026-01-01T00:00:00.000Z',publishedAt:null,sourceUpdatedAt:null})},limits:{maxChunkChars:200}})
  const result=await context.searchWeb({query:'needle',limit:1})
  assert.equal(result.passages[0]?.excerpt,literal)
  const read=await context.readWebSource({url:'https://example.com/literal'})
  assert.equal(read.text,literal)
  await context.close()
})

test('web search forwards a validated date range through the public context reader', async () => {
  let options: { dateRange?: { from: string; through: string } } | undefined
  const context = createWebSearch({
    web: {
      discover: async (_query, _target, _signal, received) => {
        options = received
        return []
      },
      fetchDocument: async () => { throw new Error('unused') },
    },
  })
  const range = { from: '2025-01-01', through: '2025-01-31' }
  await context.searchWeb({ query: 'release notes', dateRange: range })
  assert.deepEqual(options, { dateRange: range })
  assert.deepEqual(range, { from: '2025-01-01', through: '2025-01-31' })
  await context.close()
})

test('web search marks malformed embedding and reranker responses as explicit partial failures', async () => {
  const web = createWebSearch({
    web: {
      discover: async () => ['https://example.com/a'],
      fetchDocument: async (url) => ({
        url,
        title: 'Example',
        text: 'needle in this bounded source excerpt',
        fetchedAt: '2026-01-01T00:00:00.000Z',
        publishedAt: null,
        sourceUpdatedAt: null,
      }),
    },
    models: {
      embed: {
        profile: { provider: 'test', model: 'embed', space: 'web', dimensions: 2 },
        embed: async () => [[0, 0]],
      },
      rerank: {
        profile: { provider: 'test', model: 'rank', space: 'rank', dimensions: 2 },
        rerank: async () => [{ index: 9, score: 1 }],
      },
    },
  })
  const result = await web.searchWeb({ query: 'needle' })
  assert.equal(result.rankingMode, 'lexical')
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ['EMBEDDING_INVALID', 'INVALID_RANKING'],
  )
  assert.equal(result.partial, true)
  await web.close()
})

test('web collection rejects oversized metadata early and reserves the total retained-text budget', async () => {
  const web = createWebSearch({
    web: {
      discover: async () => [
        'https://example.com/one',
        'https://example.com/two',
        `https://example.com/${'x'.repeat(2050)}`,
        'file:///etc/passwd',
      ],
      fetchDocument: async (url) => ({
        url,
        title: 'Example',
        text: '123456',
        fetchedAt: '2026-01-01T00:00:00.000Z',
        publishedAt: null,
        sourceUpdatedAt: null,
      }),
    },
    limits: { maxTotalDocumentChars: 7, maxConcurrency: 1 },
  })
  const result = await web.searchWeb({ query: 'Example' })
  assert.equal(result.passages.length, 1)
  assert.ok(result.errors.some((error) => error.code === 'DISCOVERY_INVALID_URL'))
  assert.ok(result.errors.some((error) => error.code === 'DOCUMENT_TOO_LARGE'))
  await web.close()
})

test('partial reranker responses retain the remaining lexical candidates', async () => {
  const web = createWebSearch({
    web: {
      discover: async () => ['https://example.com/one', 'https://example.com/two'],
      fetchDocument: async (url) => ({
        url,
        title: 'needle',
        text: `needle ${url}`,
        fetchedAt: '2026-01-01T00:00:00.000Z',
        publishedAt: null,
        sourceUpdatedAt: null,
      }),
    },
    models: {
      rerank: {
        profile: { provider: 'test', model: 'rank', space: 'rank', dimensions: 2 },
        rerank: async () => [{ index: 0, score: 1 }],
      },
    },
  })
  const result = await web.searchWeb({ query: 'needle' })
  assert.equal(result.rankingMode, 'lexical-reranked')
  assert.equal(result.passages.length, 2)
  assert.equal(result.passages.filter((passage) => passage.ranking.rerankRank === null).length, 1)
  await web.close()
})

test('OpenRouter reranker factory profiles without dimensions interoperate through the web context factory', async () => {
  const requests: string[] = []
  const reranker = createOpenRouterReranker({
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'fixture-reranker',
    apiKey: 'fixture-no-network',
    fetch: async (input) => {
      requests.push(String(input))
      return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.8 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  assert.equal(reranker.profile.dimensions, undefined)
  const web = createWebSearch({
    web: {
      discover: async () => ['https://example.com/one'],
      fetchDocument: async (url) => ({
        url,
        title: 'needle',
        text: 'needle from one bounded source',
        fetchedAt: '2026-01-01T00:00:00.000Z',
        publishedAt: null,
        sourceUpdatedAt: null,
      }),
    },
    models: {
      rerank: {
        profile: reranker.profile,
        rerank: reranker.rerank.bind(reranker),
      },
    },
  })
  const result = await web.searchWeb({ query: 'needle' })
  assert.equal(requests.length, 1)
  assert.match(requests[0] ?? '', /openrouter\.ai\/api\/v1\/rerank/)
  assert.equal(result.rankingMode, 'lexical-reranked')
  assert.equal(result.errors.length, 0)
  assert.equal(
    result.passages[0]?.ranking.rerankerProfile,
    JSON.stringify(['openrouter', 'fixture-reranker', reranker.profile.space, null, null, null]),
  )
  await web.close()
})

test('web embedding rejects dimensions beyond provider caps and overflowed vector norms', async () => {
  assert.throws(
    () =>
      createWebSearch({
        web: {
          discover: async () => [],
          fetchDocument: async () => {
            throw new Error('unused')
          },
        },
        models: {
          embed: {
            profile: { provider: 'test', model: 'huge', space: 'huge', dimensions: 8193 },
            embed: async () => [],
          },
        },
      }),
    /Embedding profile/,
  )
  const web = createWebSearch({
    web: {
      discover: async () => ['https://example.com/one'],
      fetchDocument: async (url) => ({
        url,
        title: 'needle',
        text: 'needle from one bounded source',
        fetchedAt: '2026-01-01T00:00:00.000Z',
        publishedAt: null,
        sourceUpdatedAt: null,
      }),
    },
    models: {
      embed: {
        profile: { provider: 'test', model: 'huge', space: 'huge', dimensions: 2 },
        embed: async ({ texts }) => texts.map(() => [1.7e308, 1.7e308]),
      },
    },
  })
  const result = await web.searchWeb({ query: 'needle' })
  assert.ok(result.errors.some((error) => error.code === 'EMBEDDING_INVALID'))
  assert.equal(result.rankingMode, 'lexical')
  await web.close()
})

test('web embedding profile identity includes input type and encodes fields without delimiter collisions', async () => {
  const webSource = {
    discover: async () => ['https://example.com/one'],
    fetchDocument: async (url: string) => ({
      url,
      title: 'needle',
      text: 'needle from one bounded source',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      publishedAt: null,
      sourceUpdatedAt: null,
    }),
  }
  const make = (profile: {
    provider: string
    model: string
    space: string
    dimensions: number
    inputType: string
  }) =>
    createWebSearch({
      web: webSource,
      models: {
        embed: {
          profile,
          embed: async ({ texts }) => texts.map(() => [1, 0]),
        },
      },
    })
  const first = make({
    provider: 'a:b',
    model: 'c',
    space: 'shared',
    dimensions: 2,
    inputType: 'text-v1',
  })
  const second = make({
    provider: 'a',
    model: 'b:c',
    space: 'shared',
    dimensions: 2,
    inputType: 'text-v2',
  })
  const firstResult = await first.searchWeb({ query: 'needle' })
  const secondResult = await second.searchWeb({ query: 'needle' })
  assert.notEqual(
    firstResult.passages[0]?.ranking.embeddingProfile,
    secondResult.passages[0]?.ranking.embeddingProfile,
  )
  assert.match(firstResult.passages[0]?.ranking.embeddingProfile ?? '', /text-v1/)
  assert.match(secondResult.passages[0]?.ranking.embeddingProfile ?? '', /text-v2/)
  await first.close()
  await second.close()
})

test('web chunk collection stops at its configured cap with a typed partial budget error', async () => {
  const web = createWebSearch({
    web: {
      discover: async () => ['https://example.com/one'],
      fetchDocument: async (url) => ({
        url,
        title: 'needle',
        text: 'needle needle needle needle needle needle',
        fetchedAt: '2026-01-01T00:00:00.000Z',
        publishedAt: null,
        sourceUpdatedAt: null,
      }),
    },
    limits: { maxChunkChars: 1, maxChunks: 2 },
  })
  const result = await web.searchWeb({ query: 'needle' })
  assert.ok(result.errors.some((error) => error.code === 'CHUNK_BUDGET'))
  assert.equal(result.partial, true)
  await web.close()
})

test('classification wrapper rejects foreign labels', async () => {
  const classifier = {
    profile: { provider: 'test', model: 'm', space: 'labels' },
    usage: () => ({
      calls: 0,
      inputTokens: null,
      totalTokens: null,
      estimatedCost: null,
      latencyMs: 0,
    }),
    classify: async () => ({ labels: [{ label: 'foreign' }], abstained: false, uncertainty: [] }),
  } as unknown as Classifier
  const tool = createClassificationTool({ classifier })
  await assert.rejects(
    tool.classify({
      text: 'input',
      labels: ['yes', 'no'],
      criteria: 'choose',
      signal: new AbortController().signal,
    }),
    (error) => (error as { code?: string }).code === 'malformed',
  )
  await tool.close()
})

test('real CodeIndex accepts path-only mandatory context and fuses same-snapshot feature searches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-context-source-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'zorya-context-db-'))
  const db = await openEmbeddedDatabase(dataDir)
  cleanup.push(async () => {
    await db.close()
    await rm(root, { recursive: true, force: true })
    await rm(dataDir, { recursive: true, force: true })
  })
  execFileSync('git', ['-C', root, 'init', '-q'])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid'])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Fixture'])
  await writeFile(join(root, 'alpha.ts'), 'export const alphaFeatureNeedle = 1\n')
  await writeFile(
    join(root, 'beta.ts'),
    "import { alphaFeatureNeedle } from './alpha.js'\nexport const betaFeatureNeedle = alphaFeatureNeedle\n",
  )
  execFileSync('git', ['-C', root, 'add', '-A'])
  execFileSync('git', ['-C', root, 'commit', '-qm', 'context fixture'])
  const corpusReads: string[] = []
  const countingDatabase = {
    query: (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM zorya_code_chunks c WHERE c.snapshot_id=$1')) corpusReads.push(sql)
      return db.query(sql, params)
    },
    transaction: db.transaction.bind(db),
  }
  const index = createCodeIndex({ database: countingDatabase as typeof db })
  const indexed = await index.indexRepository({ root })
  corpusReads.length = 0
  const context = createCodeContext({ index, limits: { maxRangeLines: 1 } })
  const result = await context.getCodeContext({
    root,
    query: 'alphaFeatureNeedle',
    featureQueries: ['betaFeatureNeedle'],
    mustInclude: [{ path: 'alpha.ts' }],
  })
  assert.equal(corpusReads.length, 1, 'the context snapshot reads its chunk corpus once')
  assert.equal(corpusReads[0]?.includes('vector_json'), false, 'lexical context omits unused vectors')
  assert.equal(result.identity.snapshotId, indexed.identity?.snapshotId)
  assert.ok(result.sections.some((section) => section.path === 'alpha.ts'))
  assert.ok(result.sections.some((section) => section.path === 'beta.ts'))
  assert.ok(result.sections.every((section) => section.lineEnd - section.lineStart + 1 <= 1))
  assert.equal(result.sections.find((section) => section.path === 'alpha.ts')?.truncated, true)
  assert.equal(result.profileId, indexed.profileId)
  assert.equal(result.sections.filter((section) => section.path === 'alpha.ts').length, 1)
  assert.deepEqual((await context.relatedCode({ root, path: 'alpha.ts' })).importedBy, ['beta.ts'])
  let retainedScope: Pick<CodeIndex, 'indexStatus' | 'searchCode' | 'readSource' | 'relatedCode'> | undefined
  await index.withReadSnapshot!(root, new AbortController().signal, async (scoped) => {
    retainedScope = scoped
    void scoped.searchCode({ root, query: 'alphaFeatureNeedle', mode: 'lexical' })
  })
  await assert.rejects(
    retainedScope!.searchCode({ root, query: 'alphaFeatureNeedle', mode: 'lexical' }),
    (error: unknown) => error instanceof Error && error.message === 'CODE_INDEX_STALE',
  )
  await context.close()
  await index.close()
})

test('code context caps concurrent work, rejects pre-aborted calls before borrowed ports, and close joins cancellation', async () => {
  let calls = 0
  let activeSignal: AbortSignal | undefined
  const index = fakeIndex()
  index.searchCode = async (input) => {
    calls++
    activeSignal = input.signal
    return new Promise((_, reject) => {
      input.signal?.addEventListener('abort', () => reject(input.signal?.reason), { once: true })
    })
  }
  const context = createCodeContext({ index, limits: { maxConcurrency: 1 } })
  const canceled = new AbortController()
  canceled.abort(new Error('caller cancelled'))
  await assert.rejects(
    context.getCodeContext({ root: '/repo', query: 'skip', signal: canceled.signal }),
  )
  assert.equal(calls, 0)
  const running = context.getCodeContext({ root: '/repo', query: 'running' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  await assert.rejects(
    context.getCodeContext({ root: '/repo', query: 'overflow' }),
    OperationLimitError,
  )
  const closing = context.close()
  await assert.rejects(running)
  await closing
  assert.equal(activeSignal?.aborted, true)
})

test('context deadline retains timeout provenance after provider cancellation settles', async () => {
  const index = fakeIndex()
  let physicallySettled = false
  index.searchCode = async (input) =>
    new Promise((_, reject) => {
      input.signal?.addEventListener(
        'abort',
        () => setTimeout(() => {
          physicallySettled = true
          reject(new Error('provider_cancel'))
        }, 5),
        { once: true },
      )
    })
  const context = createCodeContext({ index, limits: { timeoutMs: 1 } })
  await assert.rejects(
    context.getCodeContext({ root: '/repo', query: 'deadline' }),
    (error: unknown) => error instanceof OperationTimeoutError,
  )
  assert.equal(physicallySettled, true)
  await context.close()
})

test('caller cancellation keeps precedence over a later context deadline while physical work settles', async () => {
  const index = fakeIndex()
  let physicallySettled = false
  index.searchCode = async (input) =>
    new Promise((_, reject) => {
      input.signal?.addEventListener(
        'abort',
        () => setTimeout(() => {
          physicallySettled = true
          reject(new Error('late provider cancellation'))
        }, 35),
        { once: true },
      )
    })
  const context = createCodeContext({ index, limits: { timeoutMs: 15 } })
  const caller = new AbortController()
  const callerReason = new Error('caller cancelled first')
  const pending = context.getCodeContext({ root: '/repo', query: 'caller-first', signal: caller.signal })
  setTimeout(() => caller.abort(callerReason), 2)
  await assert.rejects(pending, (error: unknown) => error === callerReason)
  assert.equal(physicallySettled, true)
  await context.close()
})

test('web lifecycle snapshots its borrowed adapter and joins all in-flight fetches on close', async () => {
  let fetches = 0
  const source = {
    discover: async () => ['https://example.com/a', 'https://example.com/b'],
    fetchDocument: async (_url: string, signal: AbortSignal) => {
      fetches++
      return new Promise<any>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
  }
  const web = createWebSearch({ web: source, limits: { maxConcurrency: 1 } })
  const aborted = new AbortController()
  aborted.abort(new Error('caller cancelled'))
  await assert.rejects(web.searchWeb({ query: 'x', signal: aborted.signal }))
  assert.equal(fetches, 0)
  const running = web.searchWeb({ query: 'x' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const closing = web.close()
  await assert.rejects(running)
  await closing
  assert.equal(fetches, 1)
  source.discover = async () => []
})

test('classification lifecycle snapshots profiles and caller labels and rejects unbounded concurrent requests', async () => {
  const profile = { provider: 'test', model: 'before', space: 'labels' }
  let calls = 0
  const classifier = {
    profile,
    usage: () => ({
      calls: 0,
      inputTokens: null,
      totalTokens: null,
      estimatedCost: null,
      latencyMs: 0,
    }),
    classify: async (input: any) => {
      calls++
      await new Promise<void>((resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })
      })
    },
  } as unknown as Classifier
  const tool = createClassificationTool({ classifier, limits: { maxConcurrency: 1 } })
  profile.model = 'after'
  assert.equal(tool.profile.model, 'before')
  const request = { text: 'input', labels: ['yes', 'no'], criteria: 'choose' }
  const running = tool.classify(request)
  request.labels[0] = 'mutated'
  await new Promise((resolve) => setTimeout(resolve, 0))
  await assert.rejects(
    tool.classify({ text: 'input', labels: ['yes', 'no'], criteria: 'choose' }),
    OperationLimitError,
  )
  const closing = tool.close()
  await assert.rejects(running)
  await closing
  assert.equal(calls, 1)
})
