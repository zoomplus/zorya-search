import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer as createHttpServer } from 'node:http'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import type { ReuseContextResult } from '../../src/context/reuse-types.js'
import { findCodeSymbolsRequest, readRequest } from '../../src/runtime/requests.js'
import { compactReuseContext } from '../../src/mcp/reuse-presentation.js'
import { createSearchMcpServer, type SearchMcpRuntime } from '../../src/mcp/server.js'

const sourceText = 'export function selected() { return "source once" }\n'

function resultFixture(): ReuseContextResult {
  const identity = {
    repoId: 'repo', worktreeId: 'worktree', root: '/repo', branch: 'main', head: 'abc',
    snapshotId: 'snapshot-1', contentHash: 'tree-hash',
  }
  const symbol = {
    id: 'symbol-id', name: 'selected', nameTruncated: false, qualifiedName: 'module.selected',
    qualifiedNameTruncated: false, kind: 'function', lineStart: 10, lineEnd: 12, signature: 'function selected()',
  }
  return {
    identity,
    query: 'add selected behavior',
    context: {
      identity, profileId: null, sections: [{ path: 'src/selected.ts', lineStart: 10, lineEnd: 12,
        text: sourceText, fileContentHash: 'file-hash', candidateChunkHash: 'chunk-hash', profileId: null,
        truncated: false, fusionScore: 0.75, reason: 'mandatory', rankOrigins: [] }],
      budget: { usedChars: sourceText.length, maxChars: 48_000 }, omitted: [], degraded: true,
      degradedReasons: ['lexical-only'],
      logicalContext: {
        state: 'partial', profileId: 'symbols-v1', analysisComplete: false,
        coverage: { totalFiles: 4, omittedFiles: 1,
          counts: { parsed: 2, parseError: 0, unsupported: 1, truncated: 0, error: 0 },
          unresolvedReferences: 3, unresolvedCalls: 2,
          truncation: { symbols: false, references: false, files: true } },
        blocks: [{ symbolId: 'symbol-id', name: 'selected', kind: 'function', role: 'seed_definition',
          source: { path: 'src/selected.ts', lineStart: 10, lineEnd: 12 }, complete: false,
          includedRanges: [{ path: 'src/selected.ts', lineStart: 10, lineEnd: 11 }], relationFrom: null,
          relationKind: 'seed', depth: 0, wholeFile: false }],
        omissions: [], omissionsOmitted: 0, omissionsTruncated: false,
        limits: { maxSeeds: 8, seedsInspected: 1, seedsTruncated: false, maxReferencesPerSeed: 50,
          referencesInspected: 0, maxBlocks: 24, blocksSelected: 1, maxSourceReads: 120,
          sourceReads: 1, maxRangeLines: 200, referencesTruncated: false, symbolsTruncated: false,
          blocksTruncated: false, readsTruncated: false },
        relationCoverage: 'static_and_bounded', runtimeCallCoverage: 'not_claimed',
      },
    },
    intent: { state: 'available', result: {
      taskIntent: { type: 'choice', choice: 'implement_change', confidence: 0.91, probabilities: { implement_change: 0.91, explain_behavior: 0.09 } },
      sourceScope: { type: 'choice', choice: 'implementation', confidence: 0.88, probabilities: { implementation: 0.88, unspecified: 0.12 } },
      model: 'typesafe/jev-1.14', provider: 'TypeSafe', requestId: 'request-1',
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, estimatedCost: 0.0001 } } } as ReuseContextResult['intent'],
    candidates: {
      files: [{ id: 'f0', path: 'src/selected.ts', evidence: 'search-hit', symbols: [symbol],
        symbolCatalogue: ['module.selected'], symbolCatalogueTotal: 1, symbolCatalogueOffered: 1,
        symbolCatalogueOmitted: 0, symbolCatalogueTruncatedNames: 0, symbolCatalogueIncomplete: false,
        symbolPages: 1, symbolTruncated: false }],
      hits: [{ id: 'hit-1', path: 'src/selected.ts', lineStart: 10, lineEnd: 12, symbol: 'selected',
        language: 'typescript', contentHash: 'chunk-hash', repoId: 'repo', worktreeId: 'worktree',
        branch: 'main', head: 'abc', snapshotId: 'snapshot-1', profileId: null, score: 0.75,
        ranking: { mode: 'lexical', lexicalRank: 1, denseRank: null, rerankRank: null } }],
      graphState: 'available',
      graph: { identity, requestedDepth: 1, reachedDepth: 1, seeds: ['src/selected.ts'],
        limits: { depth: false, nodes: false, edges: false },
        nodes: [{ path: 'src/selected.ts', depth: 0, seed: 'src/selected.ts', parent: null, relation: 'seed' }], edges: [] },
    },
    selection: {
      fileAnswers: { file_f0: { type: 'noul', noul: 0.83 } as never },
      fileAssessments: [{ path: 'src/selected.ts', candidateId: 'f0', relevance: 0.83, state: 'positive' }],
      selectedFiles: ['src/selected.ts'],
      symbolAnswers: { 'src/selected.ts': { type: 'choice', choice: 's0', probabilities: { s0: 0.8, none: 0.2 } } as never },
      selected: [{ path: 'src/selected.ts', symbol }], unassessed: [],
    },
    symbolSelection: { files: [{ path: 'src/selected.ts', sourceSymbolsObserved: 400, choiceSymbolsAssessed: 384,
      choiceSymbolsUnassessed: 16, sourcePagesRead: 4, choicePagesPlanned: 8, choicePagesAttempted: 8,
      pageAnswers: [], state: 'selected-partial', continuationCursor: 'symbols-page-4', continuationOmittedCount: 10 }] },
    symbolAnalysis: { state: 'partial', complete: false, coverageTotalFiles: 4, coverageOmittedFiles: 1,
      coverageCounts: { parsed: 2, parseError: 0, unsupported: 1, truncated: 0, error: 0 },
      truncation: { symbols: false, references: false, files: true } },
    readCoverage: [{ path: 'src/selected.ts', symbolId: 'symbol-id', fileHash: 'file-hash',
      status: 'partial', ranges: [{ lineStart: 10, lineEnd: 11 }] }],
    duplicates: { state: 'unsupported', scope: ['src/selected.ts'], reason: 'fixture-unsupported' },
    omissions: ['symbol-analysis-partial'],
    continuation: [{ path: 'src/selected.ts', symbolId: 'symbol-id', lineStart: 12, lineEnd: 212,
      reason: 'character-budget' }, { path: 'src/selected.ts', cursor: 'symbols-page-4', snapshotId: 'snapshot-1',
      fileHash: 'source-hash', reason: 'symbol-choice-page-budget' }, { path: 'src/selected.ts', symbolId: 'a'.repeat(64),
      lineStart: 212, lineEnd: 214, snapshotId: 'snapshot-1', fileHash: 'source-hash', reason: 'symbol-choice-page-budget' },
      { path: 'src/selected.ts', snapshotId: 'snapshot-1', fileHash: 'source-hash', reason: 'symbol-continuation-omitted' },
      { path: 'src/omitted.ts', lineStart: 1, lineEnd: 200, snapshotId: 'snapshot-1', fileHash: 'omitted-hash', reason: 'positive-file-cap' },
      { path: 'src/omitted.ts', cursor: 'tail-page-3', snapshotId: 'snapshot-1', fileHash: 'omitted-hash', reason: 'positive-file-source-tail' }],
  }
}

test('compact reuse presentation keeps selected source once and preserves identity, decisions, and uncertainty', (t) => {
  const original = resultFixture()
  const before = structuredClone(original)
  const compact = compactReuseContext('repo', original)
  const serialized = JSON.stringify(compact)
  const originalBytes = Buffer.byteLength(JSON.stringify({
    structuredContent: original,
    content: [{ type: 'text', text: JSON.stringify(original) }],
  }))
  const compactBytes = Buffer.byteLength(JSON.stringify({
    structuredContent: compact,
    content: [{ type: 'text', text: 'Compact reuse context v1 is available in structuredContent.' }],
  }))

  assert.equal(compact.responseType, 'zorya-search.get_reuse_context')
  assert.equal(compact.responseVersion, 1)
  assert.deepEqual(compact.identity, original.identity)
  assert.equal(compact.query, original.query)
  assert.deepEqual(compact.intent, original.intent)
  assert.deepEqual(compact.selection, original.selection)
  assert.equal(serialized.split(JSON.stringify(sourceText).slice(1, -1)).length - 1, 1)
  assert.ok(compactBytes < originalBytes)
  t.diagnostic(JSON.stringify({ sample: 'controlled-fixture', originalBytes, compactBytes, sourceCoverage: 'partial' }))
  assert.equal('text' in compact.candidates.hits[0]!, false)
  assert.equal('symbols' in compact.candidates.files[0]!, false)
  assert.deepEqual(compact.coverage.readCoverage, original.readCoverage)
  assert.equal(compact.coverage.logical?.runtimeCallCoverage, 'not_claimed')
  assert.equal(compact.coverage.logical?.analysisComplete, false)
  assert.equal(compact.source.sections[0]?.truncated, false)
  assert.deepEqual(compact.coverage.continuation[0]?.readSourceRequest, {
    rootId: 'repo', path: 'src/selected.ts', lineStart: 12, lineEnd: 211, snapshotId: 'snapshot-1',
  })
  assert.deepEqual(compact.coverage.continuation[1]?.findCodeSymbolsRequest, {
    rootId: 'repo', path: 'src/selected.ts', sourceKind: 'implementation', cursor: 'symbols-page-4', limit: 100,
  })
  assert.deepEqual(compact.coverage.continuation[2]?.findCodeSymbolsRequest, {
    rootId: 'repo', path: 'src/selected.ts', sourceKind: 'implementation', symbolId: 'a'.repeat(64),
  })
  assert.deepEqual(compact.coverage.continuation[2]?.readSourceRequest, {
    rootId: 'repo', path: 'src/selected.ts', lineStart: 212, lineEnd: 214, snapshotId: 'snapshot-1',
  })
  assert.deepEqual(compact.coverage.continuation[3]?.findCodeSymbolsRequest, {
    rootId: 'repo', path: 'src/selected.ts', sourceKind: 'implementation', limit: 100,
  })
  const positiveRestart = compact.coverage.continuation[4]?.findCodeSymbolsRequest
  assert.deepEqual(positiveRestart, { rootId: 'repo', path: 'src/omitted.ts', sourceKind: 'implementation', limit: 100 })
  assert.equal(findCodeSymbolsRequest.safeParse(positiveRestart).success, true)
  assert.equal(readRequest.safeParse(compact.coverage.continuation[4]?.readSourceRequest).success, true)
  const positiveTail = compact.coverage.continuation[5]?.findCodeSymbolsRequest
  assert.deepEqual(positiveTail, { rootId: 'repo', path: 'src/omitted.ts', sourceKind: 'implementation', cursor: 'tail-page-3', limit: 100 })
  assert.equal(findCodeSymbolsRequest.safeParse(positiveTail).success, true)
  assert.equal(readRequest.safeParse(compact.coverage.continuation[2]?.readSourceRequest).success, true)
  assert.equal(compact.coverage.symbolSelection.files[0]?.choiceSymbolsUnassessed, 16)
  assert.equal(compact.coverage.symbolSelection.files[0]?.continuationOmittedCount, 10)
  assert.deepEqual(original, before)
})

test('compact projection bounds unselected expansions and discloses omissions without changing source limits', () => {
  const original = resultFixture()
  const file = original.candidates.files[0]!
  original.candidates.files = Array.from({ length: 30 }, (_, index) => ({ ...file, id: `f${index}`, path: index === 0 ? 'src/selected.ts' : `src/${index}.ts` }))
  const hit = original.candidates.hits[0]!
  original.candidates.hits = Array.from({ length: 50 }, (_, index) => ({ ...hit, id: `hit-${index}`, path: index === 0 ? 'src/selected.ts' : `src/${index}.ts` }))
  original.candidates.graph!.nodes = Array.from({ length: 40 }, (_, index) => ({
    path: index === 0 ? 'src/selected.ts' : `src/${index}.ts`, depth: index === 0 ? 0 : 1,
    seed: 'src/selected.ts', parent: index === 0 ? null : 'src/selected.ts', relation: index === 0 ? 'seed' as const : 'imports' as const,
  }))
  original.candidates.graph!.edges = Array.from({ length: 50 }, (_, index) => ({
    from: index === 0 ? 'src/selected.ts' : `src/${index}.ts`, to: index === 0 ? 'src/selected.ts' : `src/${index + 1}.ts`, direction: 'imports' as const,
  }))
  const logical = original.context.logicalContext!
  const baseBlock = logical.blocks[0]!
  logical.blocks = [
    ...Array.from({ length: 6 }, () => ({ ...baseBlock, symbolId: 'symbol-id' })),
    { ...baseBlock, symbolId: 'unselected-symbol', relationFrom: null },
  ]
  logical.omissions = Array.from({ length: 20 }, (_, index) => ({
    symbolId: index === 0 ? 'symbol-id' : `unselected-${index}`,
    role: 'callee' as const,
    range: { path: 'src/selected.ts', lineStart: index + 1, lineEnd: index + 1 },
    reason: index === 0 ? 'budget' as const : 'unresolved' as const,
    continuation: null,
  }))
  logical.omissionsOmitted = 3
  original.context.budget.maxChars = 1_000

  const compact = compactReuseContext('repo', original)
  assert.equal(compact.candidates.files.length, 5)
  assert.equal(compact.candidates.filesOmitted, 25)
  assert.equal(compact.candidates.hits.length, 5)
  assert.equal(compact.candidates.hitsOmitted, 45)
  assert.equal(compact.candidates.graph?.nodes.length, 3)
  assert.equal(compact.candidates.graph?.nodesOmitted, 37)
  assert.equal(compact.candidates.graph?.edges.length, 5)
  assert.equal(compact.candidates.graph?.edgesOmitted, 45)
  assert.equal(compact.coverage.logical?.blocks.length, 5)
  assert.equal(compact.coverage.logical?.selectedBlocksTotal, 6)
  assert.equal(compact.coverage.logical?.selectedBlocksOmitted, 2)
  assert.equal(compact.coverage.logical?.blocksTotal, 7)
  assert.equal(compact.coverage.logical?.blocksOmitted, 2)
  assert.equal(compact.coverage.logical?.omissions.length, 1)
  assert.equal(compact.coverage.logical?.omissionsTotal, 23)
  assert.equal(compact.coverage.logical?.omissionsOmitted, 22)
  assert.deepEqual(compact.coverage.logical?.omissionReasonCounts, { budget: 1, unresolved: 19 })
  assert.equal(compact.source.budget.maxChars, 1_000)
  assert.equal(compact.source.sections[0]?.text, sourceText)
})

test('compact source retains the full enclosing selected section and defers unrelated source by exact pointer', () => {
  const original = resultFixture()
  const selected = original.selection.selected[0]!
  selected.symbol.lineStart = 11
  selected.symbol.lineEnd = 11
  original.readCoverage[0]!.status = 'full'
  original.readCoverage[0]!.ranges = [{ lineStart: 11, lineEnd: 11 }]
  original.continuation = []
  const unrelatedText = 'export function unrelated() { return false }\n'
  original.context.sections.push({
    path: 'docs/guide.md', lineStart: 20, lineEnd: 20, text: unrelatedText,
    fileContentHash: 'docs-hash', candidateChunkHash: null, profileId: null,
    truncated: false, fusionScore: 0.2, reason: 'search', rankOrigins: [],
  })
  original.context.budget.usedChars += unrelatedText.length
  const before = structuredClone(original)

  const compact = compactReuseContext('repo', original)
  assert.equal(compact.source.sections.length, 1)
  assert.deepEqual(compact.source.sections[0], {
    path: 'src/selected.ts', lineStart: 10, lineEnd: 12, text: sourceText,
    fileContentHash: 'file-hash', candidateChunkHash: 'chunk-hash', profileId: null,
    truncated: false, reason: 'mandatory', rankOrigins: [],
  })
  assert.equal(compact.source.presentation.returnedSectionCount, 1)
  assert.equal(compact.source.presentation.deferredSectionCount, 1)
  assert.equal(compact.source.presentation.returnedSourceChars, sourceText.length)
  assert.equal(compact.source.presentation.deferredSourceChars, unrelatedText.length)
  assert.equal(compact.source.budget.usedChars, sourceText.length + unrelatedText.length)
  assert.deepEqual(compact.source.deferredSections, [{
    path: 'docs/guide.md', lineStart: 20, lineEnd: 20, fileContentHash: 'docs-hash',
    truncated: false, reason: 'search',
    readSourceRequests: [{ rootId: 'repo', path: 'docs/guide.md', lineStart: 20, lineEnd: 20, snapshotId: 'snapshot-1' }],
  }])
  assert.deepEqual(compact.selection, original.selection)
  assert.deepEqual(compact.coverage.readCoverage, original.readCoverage)
  assert.deepEqual(original, before)
})

test('MCP full response remains exact per call; compact is default and its option is stripped before runtime', async () => {
  const source = resultFixture()
  const runtimeInputs: unknown[] = []
  const runtime = {
    capabilities: () => ({ reuseContext: true, projectText: false, visual: false }),
    getReuseContext(input: unknown) { runtimeInputs.push(input); return source },
  } as unknown as SearchMcpRuntime
  const handler = createMcpHandler(() => createSearchMcpServer(runtime, { rootIds: ['repo'], operations: ['read', 'classify'] }))
  const http = createHttpServer((request, response) => {
    void toNodeHandler(handler)(request, response).catch(() => undefined)
  })
  const client = new Client({ name: 'reuse-presentation-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })

  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(0, '127.0.0.1', resolve)
    })
    const address = http.address()
    assert.ok(address && typeof address !== 'string')
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)))

    const full = await client.callTool({ name: 'get_reuse_context', arguments: { rootId: 'repo', query: source.query, responseDetail: 'full' } })
    assert.deepEqual(full.structuredContent, source)
    assert.equal((full.content[0] as { text: string }).text, JSON.stringify(source))

    const compact = await client.callTool({ name: 'get_reuse_context', arguments: { rootId: 'repo', query: source.query } })
    assert.equal((compact.structuredContent as { responseVersion: number }).responseVersion, 1)
    assert.match((compact.content[0] as { text: string }).text, /structuredContent/u)
    assert.equal(JSON.stringify(compact).includes(JSON.stringify(sourceText).slice(1, -1)), true)

    const fullAgain = await client.callTool({ name: 'get_reuse_context', arguments: { rootId: 'repo', query: source.query, responseDetail: 'full' } })
    assert.deepEqual(fullAgain.structuredContent, source)
    assert.equal(runtimeInputs.length, 3)
    assert.ok(runtimeInputs.every((input) => !Object.hasOwn(input as object, 'responseDetail')))
  } finally {
    await client.close().catch(() => undefined)
    await new Promise<void>((resolve, reject) => {
      if (!http.listening) return resolve()
      http.close((error) => error ? reject(error) : resolve())
    })
  }
})
