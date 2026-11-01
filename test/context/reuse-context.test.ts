import assert from 'node:assert/strict'
import test from 'node:test'
import { CodeContextError } from '../../src/context/index.js'
import { OperationClosedError } from '../../src/context/lifecycle.js'
import { createReuseContext } from '../../src/context/reuse.js'
import type { CodeIndex, CodeSourceIdentity } from '../../src/code/types.js'
import type { CodeSymbol, CodeSymbolAnalysisStatus } from '../../src/code/symbol-api.js'
import type { JevDecisionsPort } from '../../src/providers/decision-types.js'

const identity: CodeSourceIdentity = {
  repoId: 'repo', worktreeId: 'worktree', root: '/repo', branch: 'main', head: 'head', snapshotId: 'snapshot-1', contentHash: 'tree-hash',
}
const analysis: CodeSymbolAnalysisStatus = {
  state: 'indexed', identity, profile: { id: 'symbol-v1', extractorVersion: 'extract-v1', typescriptVersion: '5', compilerOptionsHash: 'opts', libraryProfileId: null,
    limits: { maxFiles: 100, maxSymbols: 10000, maxReferences: 10000, tsconfigPath: null } }, complete: true, coverage: [], coverageTotalFiles: 1, coverageOmittedFiles: 0,
  coverageCounts: { parsed: 1, parseError: 0, unsupported: 0, truncated: 0, error: 0 }, unresolvedReferenceCount: 0, unresolvedCallCount: 0,
  truncation: { symbols: false, references: false, files: false }, symbolCount: 1, referenceCount: 0, indexedAt: null,
}

function makeSymbol(path: string, id: string, name: string, lineStart: number, lineEnd: number, hash: string): CodeSymbol {
  return { id, name, qualifiedName: name, kind: 'function', location: { path, start: 0, end: lineEnd * 4, lineStart, lineEnd, fileHash: hash },
    parentId: null, container: null, signature: `function ${name}()`, signatureTruncated: false, contract: false, synthetic: false, overloadGroupId: null }
}

function harness(config: {
  files?: Array<{ path: string; text: string; symbols?: CodeSymbol[] }>
  omitGraph?: boolean
  omitSymbols?: boolean
  omitDuplicates?: boolean
  failGraph?: Error
  failDuplicates?: Error
  decide?: (input: Parameters<JevDecisionsPort['decide']>[0]) => ReturnType<JevDecisionsPort['decide']>
} = {}) {
  const files = config.files ?? [{ path: 'src/one.ts', text: 'export function target() { return 1 }\n', symbols: [makeSymbol('src/one.ts', 'sym-target', 'target', 1, 1, 'hash:src/one.ts')] }]
  const source = new Map(files.map((file) => [file.path, { text: file.text, hash: `hash:${file.path}` }]))
  const hit = (path: string) => ({ id: `hit:${path}`, path, lineStart: 1, lineEnd: 1, symbol: null, language: 'typescript', contentHash: `chunk:${path}`,
    repoId: identity.repoId, worktreeId: identity.worktreeId, branch: identity.branch, head: identity.head, snapshotId: identity.snapshotId, profileId: null, score: 1,
    ranking: { mode: 'lexical' as const, lexicalRank: 1, denseRank: null, rerankRank: null } })
  const counts = { snapshotCalls: 0, queries: [] as string[], readCalls: 0 }
  const base: any = {
    async indexStatus() { return { identity, indexedAt: null, fileCount: files.length, chunkCount: files.length, profileId: null, denseAvailable: false, denseDisabledReason: null } },
    async searchCode(input: { query: string }) { counts.queries.push(input.query); return { hits: files.slice(0, 24).map((file) => hit(file.path)), identity, degraded: false, degradedReason: null } },
    async readSource(input: { path: string; lineStart?: number; lineEnd?: number; signal?: AbortSignal }) {
      input.signal?.throwIfAborted()
      counts.readCalls++
      const item = source.get(input.path)
      if (!item) throw new Error('missing fixture file')
      const lines = item.text.split(/\r?\n/u)
      const start = input.lineStart ?? 1
      const end = input.lineEnd ?? Math.min(lines.length, start + 199)
      if (start > lines.length || end > lines.length) throw new Error('invalid fixture range')
      return { path: input.path, lineStart: start, lineEnd: end, fileLineCount: lines.length, text: lines.slice(start - 1, end).join('\n'), contentHash: item.hash, snapshotId: identity.snapshotId, stale: false }
    },
    async relatedCode() { return { identity, imports: [], importedBy: [], similar: [], stale: false } },
  }
  if (!config.omitGraph) base.dependencyGraph = async (input: { signal?: AbortSignal }) => {
    if (config.failGraph) throw config.failGraph
    input.signal?.throwIfAborted()
    const paths = files.slice(0, 24).map((file) => file.path)
    return { identity, seeds: paths.slice(0, 3), nodes: paths.map((path, i) => ({ path, depth: i ? 1 : 0, seed: paths[0]!, parent: i ? paths[0]! : null, relation: i ? 'imports' as const : 'seed' as const })),
      edges: paths.slice(1).map((path) => ({ from: paths[0]!, to: path, direction: 'imports' as const })), requestedDepth: 2, reachedDepth: 1, limits: { depth: false, nodes: false, edges: false } }
  }
  if (!config.omitSymbols) base.findCodeSymbols = async (input: { path: string; cursor?: string; signal?: AbortSignal }) => {
    input.signal?.throwIfAborted()
    const symbols = files.find((file) => file.path === input.path)?.symbols ?? []
    const offset = input.cursor ? 100 : 0
    const page = symbols.slice(offset, offset + 100)
    return { analysis: { ...analysis, identity, symbolCount: symbols.length }, symbols: page, nextCursor: offset + 100 < symbols.length ? 'page-2' : null, truncated: false }
  }
  if (!config.omitDuplicates) base.findCodeDuplicates = async (input: { paths?: string[]; signal?: AbortSignal }) => {
    if (config.failDuplicates) throw config.failDuplicates
    input.signal?.throwIfAborted()
    return { identity, supportedLanguages: ['TypeScript'], groups: [], counts: { scannedFiles: input.paths?.length ?? 0, indexedFiles: input.paths?.length ?? 0,
      eligibleFiles: input.paths?.length ?? 0, parsedFiles: input.paths?.length ?? 0, functions: 0, skippedParse: 0, skippedOversize: 0, skippedUnsupported: 0 },
      truncation: { groups: false, occurrences: false, scan: false, complete: true } }
  }
  base.withReadSnapshot = async (_root: string, signal: AbortSignal, work: (scoped: any) => Promise<unknown>) => {
    counts.snapshotCalls++
    signal.throwIfAborted()
    const scoped = { ...base }
    delete scoped.withReadSnapshot
    return work(scoped)
  }
  const decisionPort: JevDecisionsPort = {
    profile: { provider: 'typesafe', model: 'typesafe/jev-1.14', space: 'jev' },
    usage: () => ({ calls: 0, inputTokens: null, totalTokens: null, estimatedCost: null, latencyMs: 0 }),
    async decide(input) {
      if (config.decide) return config.decide(input)
      const answers: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      for (const question of input.questions) {
        if (question.type === 'noul') answers[question.id] = { type: 'noul', noul: 0.9 }
        else if (question.id === 'taskIntent') answers[question.id] = { type: 'choice', choice: 'explain_behavior' }
        else if (question.id === 'sourceScope') answers[question.id] = { type: 'choice', choice: 'unspecified' }
        else {
          const state = input.state as { questions?: Record<string, { symbols?: Record<string, { name?: string }> }> }
      const rows = state.questions?.[question.id]?.symbols ?? {}
          const target = Object.entries(rows).find(([, value]) => value.name === 'targetAfter100')?.[0] ?? Object.keys(rows)[0]
          answers[question.id] = { type: 'choice', choice: target ?? 'none' }
        }
      }
      return { requestId: null, model: 'typesafe/jev-1.14', provider: 'TypeSafe', answers, usage: { inputTokens: null, outputTokens: null, totalTokens: null, estimatedCost: null } }
    },
  }
  return { index: base as CodeIndex, decisions: decisionPort, counts, source }
}

test('second symbol page is offered; long selected bodies are read in bounded complete ranges', async () => {
  const path = 'src/large.ts'
  const text = Array.from({ length: 1200 }, (_, i) => `export const value${i} = ${i} + 1;`).join('\n')
  const symbols = Array.from({ length: 150 }, (_, i) => makeSymbol(path, `symbol-${i}`, i === 149 ? 'targetAfter100' : `function${i}`, 1, 1200, `hash:${path}`))
  const h = harness({ files: [{ path, text, symbols }] })
  const reuse = createReuseContext({ index: h.index, decisions: h.decisions })
  const result = await reuse.getReuseContext({ root: '/repo', query: 'where should I add this behavior?' })
  assert.equal(result.selection.selected[0]?.symbol.name, 'targetAfter100')
  assert.equal(result.selection.unassessed.length, 0)
  assert.equal(result.readCoverage[0]?.status, 'full')
  assert.equal(result.readCoverage[0]?.fileHash, `hash:${path}`)
  assert.ok(result.readCoverage[0]!.ranges.length >= 6)
  assert.ok(result.readCoverage[0]!.ranges.every((range) => range.lineEnd - range.lineStart < 200))
  assert.equal(result.context.sections.filter((section) => section.path === path).reduce((sum, section) => sum + section.text.length, 0) > 24000, true)
  assert.equal(h.counts.snapshotCalls, 1)
  assert.equal(h.counts.queries[0], 'where should I add this behavior?')
  await reuse.close()
})

test('late symbol names reach file Noul and all valid stages accept dated pinned Jev model metadata', async () => {
  const path = 'src/catalogue.ts'
  const symbols = Array.from({ length: 150 }, (_, i) => makeSymbol(path, `symbol-${i}`, i === 149 ? 'lateExtensionPoint' : `helper${i}`, i + 1, i + 1, `hash:${path}`))
  const h = harness({ files: [{ path, text: Array.from({ length: 150 }, (_, i) => `const v${i} = ${i}`).join('\n'), symbols }], decide: async ({ state, questions }) => {
    const answers = Object.fromEntries(questions.map((question) => {
      if (question.id === 'taskIntent') return [question.id, { type: 'choice', choice: 'implement_change' }]
      if (question.id === 'sourceScope') return [question.id, { type: 'choice', choice: 'implementation' }]
      if (question.type === 'noul') {
        const candidate = (state as { files: Record<string, { symbols: string[]; symbolCatalogueTotal: number; symbolCatalogueOmitted: number }> }).files.f0!
        assert.ok(candidate.symbols.includes('lateExtensionPoint'))
        assert.equal(candidate.symbolCatalogueTotal, 150)
        assert.equal(candidate.symbolCatalogueOmitted, 0)
        return [question.id, { type: 'noul', noul: 0.9 }]
      }
      const rows = (state as { questions: Record<string, { symbols: Record<string, { name: string }> }> }).questions[question.id]!.symbols
      const selected = Object.entries(rows).find(([, row]) => row.name === 'lateExtensionPoint')?.[0] ?? 'none'
      return [question.id, { type: 'choice', choice: selected, probabilityBasis: 'provider-choice' }]
    }))
    return { requestId: 'dated', model: 'typesafe/jev-1.14-20261014', provider: 'TypeSafe', answers,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, estimatedCost: 0 } }
  } })
  const result = await createReuseContext({ index: h.index, decisions: h.decisions }).getReuseContext({ root: '/repo', query: 'extend the late implementation' })
  assert.equal(result.intent.state, 'available')
  if (result.intent.state === 'available') assert.equal(result.intent.result.model, 'typesafe/jev-1.14-20261014')
  assert.equal(result.selection.fileAnswers.file_f0?.type, 'noul')
  assert.equal(result.selection.fileAssessments[0]?.state, 'positive')
  assert.equal(result.selection.selected[0]?.symbol.name, 'lateExtensionPoint')
  assert.equal(result.selection.unassessed.length, 0)
})

test('small character budget yields explicit continuation and partial read coverage', async () => {
  const path = 'src/large.ts'
  const text = Array.from({ length: 1200 }, (_, i) => `export const value${i} = ${i} + 1;`).join('\n')
  const symbol = makeSymbol(path, 'large-symbol', 'targetAfter100', 1, 1200, `hash:${path}`)
  const h = harness({ files: [{ path, text, symbols: [symbol] }] })
  const result = await createReuseContext({ index: h.index, decisions: h.decisions }).getReuseContext({ root: '/repo', query: 'change this code', maxChars: 1000 })
  assert.ok(result.continuation.some((entry) => entry.reason === 'character-budget'))
  assert.equal(result.readCoverage[0]?.status, 'partial')
  assert.equal(result.context.budget.maxChars, 1000)
})

test('short files, missing optional capabilities, missing Jev and explicit none remain honest', async () => {
  const file = { path: 'src/tiny.ts', text: 'x\n', symbols: [makeSymbol('src/tiny.ts', 'tiny', 'tiny', 1, 1, 'hash:src/tiny.ts')] }
  const h = harness({ files: [file], omitGraph: true, omitSymbols: true, omitDuplicates: true })
  const mechanical = await createReuseContext({ index: h.index }).getReuseContext({ root: '/repo', query: 'explain this behavior' })
  assert.equal(mechanical.candidates.graphState, 'unsupported')
  assert.equal(mechanical.duplicates.state, 'unsupported')
  assert.equal(mechanical.selection.selected.length, 0)
  assert.ok(mechanical.omissions.includes('symbol-index-unsupported'))
  await createReuseContext({ index: h.index, decisions: h.decisions }).getReuseContext({ root: '/repo', query: 'explain this behavior' })
  const none = harness({ files: [file], decide: async ({ questions }) => ({ requestId: null, model: 'typesafe/jev-1.14', provider: 'TypeSafe',
    answers: Object.fromEntries(questions.map((question) => [question.id, question.type === 'noul' ? { type: 'noul', noul: 0.9 } : { type: 'choice', choice: question.id === 'taskIntent' ? 'explain_behavior' : question.id === 'sourceScope' ? 'unspecified' : 'none' }])),
    usage: { inputTokens: null, outputTokens: null, totalTokens: null, estimatedCost: null } }) })
  const noneResult = await createReuseContext({ index: none.index, decisions: none.decisions }).getReuseContext({ root: '/repo', query: 'explain this behavior' })
  assert.equal(noneResult.selection.selected.length, 0)
  assert.equal(noneResult.selection.unassessed[0]?.reason, 'jev-selected-none')
})

test('foreign IDs are not mapped and graph/duplicate currentness errors propagate unchanged', async () => {
  const file = { path: 'src/one.ts', text: 'function target() {}\n', symbols: [makeSymbol('src/one.ts', 'symbol-1', 'target', 1, 1, 'hash:src/one.ts')] }
  const foreign = harness({ files: [file], decide: async ({ questions }) => ({ requestId: null, model: 'typesafe/jev-1.14', provider: 'TypeSafe',
    answers: Object.fromEntries(questions.map((question) => [question.id, question.type === 'noul' ? { type: 'noul', noul: 2 } : { type: 'choice', choice: question.id === 'taskIntent' ? 'explain_behavior' : 'unspecified' }])),
    usage: { inputTokens: null, outputTokens: null, totalTokens: null, estimatedCost: null } }) })
  const foreignResult = await createReuseContext({ index: foreign.index, decisions: foreign.decisions }).getReuseContext({ root: '/repo', query: 'change this code' })
  assert.equal(foreignResult.selection.selected.length, 0)
  assert.ok(foreignResult.omissions.some((value) => value.startsWith('file-assessment-unavailable:')))
  const foreignSymbol = harness({ files: [file], decide: async ({ questions }) => ({ requestId: null, model: 'typesafe/jev-1.14', provider: 'TypeSafe',
    answers: Object.fromEntries(questions.map((question) => [question.id, question.type === 'noul' ? { type: 'noul', noul: 0.9 } : { type: 'choice', choice: question.id === 'taskIntent' ? 'explain_behavior' : 'unspecified' }])),
    usage: { inputTokens: null, outputTokens: null, totalTokens: null, estimatedCost: null } }) })
  const foreignSymbolResult = await createReuseContext({ index: foreignSymbol.index, decisions: foreignSymbol.decisions }).getReuseContext({ root: '/repo', query: 'change this code' })
  assert.equal(foreignSymbolResult.selection.selected.length, 0)
  assert.ok(foreignSymbolResult.selection.unassessed.some((item) => item.reason === 'jev-unavailable:malformed'))
  const graphError = Object.assign(new Error('stale graph'), { code: 'CODE_INDEX_SOURCE_CHANGED_DURING_SEARCH' })
  const failedGraph = harness({ failGraph: graphError })
  await assert.rejects(createReuseContext({ index: failedGraph.index }).getReuseContext({ root: '/repo', query: 'x' }), (error) => error === graphError)
  const duplicateError = Object.assign(new Error('stale duplicate'), { code: 'CODE_INDEX_SOURCE_CHANGED_DURING_SEARCH' })
  const failedDuplicates = harness({ failDuplicates: duplicateError })
  await assert.rejects(createReuseContext({ index: failedDuplicates.index }).getReuseContext({ root: '/repo', query: 'x' }), (error) => error === duplicateError)
})

test('multiple positive file assessments each get a separate bounded symbol Choice', async () => {
  const files = ['src/first.ts', 'src/second.ts'].map((path, i) => ({ path, text: `function helper${i}() {}\n`, symbols: [makeSymbol(path, `s${i}`, `helper${i}`, 1, 1, `hash:${path}`)] }))
  const calls: string[][] = []
  const h = harness({ files, decide: async ({ questions }) => {
    calls.push(questions.map((question) => question.id))
    const answers = Object.fromEntries(questions.map((question) => [question.id, question.type === 'noul' ? { type: 'noul', noul: 0.9 } : { type: 'choice', choice: question.id === 'taskIntent' ? 'explain_behavior' : question.id === 'sourceScope' ? 'unspecified' : 's0' }]))
    return { requestId: null, model: 'typesafe/jev-1.14', provider: 'TypeSafe', answers, usage: { inputTokens: null, outputTokens: null, totalTokens: null, estimatedCost: null } }
  } })
  const result = await createReuseContext({ index: h.index, decisions: h.decisions }).getReuseContext({ root: '/repo', query: 'change these files' })
  assert.deepEqual(calls, [['taskIntent', 'sourceScope'], ['file_f0', 'file_f1'], ['symbol_0'], ['symbol_1']])
  assert.equal(result.selection.selected.length, 2)
  assert.equal(result.selection.selectedFiles.length, 2)
  assert.deepEqual(result.selection.selected.map((item) => item.path), ['src/first.ts', 'src/second.ts'])
  assert.equal(calls.length, 4)
})

test('binary relevance ties stay unresolved and positive files beyond the cap are disclosed', async () => {
  const files = ['src/first.ts', 'src/second.ts', 'src/third.ts', 'src/fourth.ts'].map((path, i) => ({
    path, text: `function helper${i}() {}\n`, symbols: [makeSymbol(path, `s${i}`, `helper${i}`, 1, 1, `hash:${path}`)],
  }))
  const h = harness({ files, decide: async ({ questions }) => {
    const scores: Record<string, number> = { file_f0: 0.9, file_f1: 0.5, file_f2: 0.8, file_f3: 0.7 }
    return { requestId: null, model: 'typesafe/jev-1.14-20261014', provider: 'TypeSafe',
      answers: Object.fromEntries(questions.map((question) => [question.id, question.type === 'noul'
        ? { type: 'noul', noul: scores[question.id] ?? 0.1 }
        : { type: 'choice', choice: question.id === 'taskIntent' ? 'implement_change' : question.id === 'sourceScope' ? 'implementation' : 's0' }])),
      usage: { inputTokens: null, outputTokens: null, totalTokens: null, estimatedCost: null } }
  } })
  const result = await createReuseContext({ index: h.index, decisions: h.decisions }).getReuseContext({ root: '/repo', query: 'add this behavior' })
  assert.deepEqual(result.selection.selectedFiles, ['src/first.ts', 'src/third.ts'])
  assert.equal(result.selection.fileAssessments[1]?.state, 'unresolved')
  assert.equal(result.selection.fileAssessments[1]?.relevance, 0.5)
  assert.equal(result.selection.fileAssessments[2]?.state, 'positive')
  assert.equal(result.selection.fileAssessments[3]?.state, 'omitted')
  assert.ok(result.omissions.includes('positive-files-omitted:1'))
})

test('selected callback reads through an anonymous wrapper to its verified named method owner', async () => {
  const path = 'src/semaphore.ts'
  const lines = ['class Semaphore {', '  async #acquire() {', '    return new Promise((resolve) => {', '      const queue = [];',
    '      function cancel() {', '        queue.length = 0', '      }', '    })', '  }', '}']
  const child = { ...makeSymbol(path, 'cancel-id', 'cancel', 5, 6, `hash:${path}`), kind: 'callable' as const, parentId: 'anonymous-id' }
  const anonymous = { ...makeSymbol(path, 'anonymous-id', '<anonymous>', 3, 8, `hash:${path}`), kind: 'callable' as const, parentId: 'owner-id' }
  const owner = { ...makeSymbol(path, 'owner-id', '#acquire', 2, 9, `hash:${path}`), kind: 'method' as const, parentId: 'class-id' }
  const classSymbol = { ...makeSymbol(path, 'class-id', 'Semaphore', 1, 10, `hash:${path}`), kind: 'class' as const }
  const h = harness({ files: [{ path, text: lines.join('\n'), symbols: [child, anonymous, owner, classSymbol] }], decide: async ({ questions }) => ({
    requestId: null, model: 'typesafe/jev-1.14-20261014', provider: 'TypeSafe',
    answers: Object.fromEntries(questions.map((question) => [question.id, question.type === 'noul'
      ? { type: 'noul', noul: 0.9 }
      : { type: 'choice', choice: question.id === 'taskIntent' ? 'implement_change' : question.id === 'sourceScope' ? 'implementation' : 's0' }])),
    usage: { inputTokens: null, outputTokens: null, totalTokens: null, estimatedCost: null },
  }) })
  const reuse = createReuseContext({ index: h.index, decisions: h.decisions })
  const result = await reuse.getReuseContext({ root: '/repo', query: 'add cancellation cleanup' })
  assert.equal(result.selection.selected[0]?.symbol.name, 'cancel')
  const ownerSection = result.context.sections.find((section) => section.path === path && section.lineStart <= 2 && section.lineEnd >= 9)
  assert.ok(ownerSection)
  assert.match(ownerSection.text, /#acquire/u)
  assert.equal(result.readCoverage[0]?.status, 'full')
  await reuse.close()
})

test('cyclic, foreign, and non-containing ancestor links do not add parent context', async (t) => {
  for (const invalid of ['cycle', 'foreign', 'malformed'] as const) {
    await t.test(invalid, async () => {
      const path = 'src/nested.ts'
      const child = { ...makeSymbol(path, 'child-id', 'cancel', 5, 6, `hash:${path}`), kind: 'callable' as const, parentId: 'anonymous-id' }
      const anonymous = { ...makeSymbol(path, 'anonymous-id', '<anonymous>', 3, 8, `hash:${path}`), kind: 'callable' as const,
        parentId: invalid === 'cycle' ? 'child-id' : 'owner-id',
        ...(invalid === 'foreign' ? { location: { ...makeSymbol('src/other.ts', 'anonymous-id', '<anonymous>', 3, 8, 'hash:src/other.ts').location } } : {}),
        ...(invalid === 'malformed' ? { location: { ...makeSymbol(path, 'anonymous-id', '<anonymous>', 3, 4, `hash:${path}`).location } } : {}),
      }
      const owner = { ...makeSymbol(path, 'owner-id', 'owner', 2, 9, `hash:${path}`), kind: 'method' as const }
      const h = harness({ files: [{ path, text: Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n'), symbols: [child, anonymous, owner] }], decide: async ({ questions }) => ({
        requestId: null, model: 'typesafe/jev-1.14', provider: 'TypeSafe',
        answers: Object.fromEntries(questions.map((question) => [question.id, question.type === 'noul'
          ? { type: 'noul', noul: 0.9 }
          : { type: 'choice', choice: question.id === 'taskIntent' ? 'implement_change' : question.id === 'sourceScope' ? 'implementation' : 's0' }])),
        usage: { inputTokens: null, outputTokens: null, totalTokens: null, estimatedCost: null },
      }) })
      const reuse = createReuseContext({ index: h.index, decisions: h.decisions })
      const result = await reuse.getReuseContext({ root: '/repo', query: 'add cancellation cleanup' })
      assert.equal(result.selection.selected[0]?.symbol.name, 'cancel')
      assert.equal(result.context.sections.some((section) => section.path === path && section.lineStart <= 2 && section.lineEnd >= 9), false)
      await reuse.close()
    })
  }
})

test('wrong Jev model or provider after valid intent prevents dependent Choice calls', async (t) => {
  for (const invalid of [{ model: 'typesafe/jev-1.13', provider: 'TypeSafe' }, { model: 'typesafe/jev-1.14', provider: 'OtherProvider' }]) {
    await t.test(`${invalid.model}/${invalid.provider}`, async () => {
      const calls: string[][] = []
      const h = harness({ decide: async ({ questions }) => {
        calls.push(questions.map((question) => question.id))
        const answers = Object.fromEntries(questions.map((question) => [question.id, question.type === 'noul' ? { type: 'noul', noul: 0.9 } : { type: 'choice', choice: question.id === 'taskIntent' ? 'explain_behavior' : 'unspecified' }]))
        return { requestId: null, model: calls.length === 1 ? 'typesafe/jev-1.14' : invalid.model, provider: calls.length === 1 ? 'TypeSafe' : invalid.provider,
          answers, usage: { inputTokens: null, outputTokens: null, totalTokens: null, estimatedCost: null } }
      } })
      const result = await createReuseContext({ index: h.index, decisions: h.decisions }).getReuseContext({ root: '/repo', query: 'inspect this' })
      assert.deepEqual(calls, [['taskIntent', 'sourceScope'], ['file_f0']])
      assert.equal(result.selection.selected.length, 0)
      assert.ok(result.selection.unassessed.some((item) => item.reason.startsWith('file-assessment-unavailable:')))
    })
  }
})

test('candidate budgets are honored and the complete wire request stays bounded', async () => {
  const path = 'src/catalogue.ts'
  const symbols = Array.from({ length: 199 }, (_, i) => ({
    ...makeSymbol(path, `id-${i}`, `fn_${i}_${'x'.repeat(280)}`, i + 1, i + 1, `hash:${path}`),
    qualifiedName: `qualified_${i}_${'q'.repeat(280)}`, signature: `signature_${'s'.repeat(1000)}`,
  }))
  let requestBytes = 0
  const h = harness({ files: [{ path, text: Array.from({ length: 199 }, (_, i) => `line_${i}`).join('\n'), symbols }], decide: async ({ state, questions }) => {
    requestBytes = Math.max(requestBytes, Buffer.byteLength(JSON.stringify({ state, questions })))
    const answers = Object.fromEntries(questions.map((q) => [q.id, q.type === 'noul' ? { type: 'noul', noul: 0.9 } : { type: 'choice', choice: q.id === 'taskIntent' ? 'explain_behavior' : 'unspecified' }]))
    return { requestId: null, model: 'typesafe/jev-1.14', provider: 'TypeSafe', answers, usage: { inputTokens: null, outputTokens: null, totalTokens: null, estimatedCost: null } }
  } })
  const result = await createReuseContext({ index: h.index, decisions: h.decisions, limits: { maxCandidates: 1 } }).getReuseContext({ root: '/repo', query: 'inspect this' })
  assert.equal(result.candidates.files.length, 1)
  assert.ok(requestBytes <= 120000)
  assert.ok(result.omissions.includes('symbol-choice-facts-compacted'))
})

test('large file catalogue compaction reports total, offered, omitted, and clipped names', async () => {
  const files = Array.from({ length: 8 }, (_, fileIndex) => {
    const path = `src/catalogue-${fileIndex}.ts`
    const symbols = Array.from({ length: 180 }, (_, symbolIndex) => ({
      ...makeSymbol(path, `id-${fileIndex}-${symbolIndex}`, `symbol_${symbolIndex}`, symbolIndex + 1, symbolIndex + 1, `hash:${path}`),
      qualifiedName: `qualified_${fileIndex}_${symbolIndex}_${'q'.repeat(238)}`,
    }))
    return { path, text: Array.from({ length: 180 }, (_, i) => `const row${i} = ${i}`).join('\n'), symbols }
  })
  let payloadBytes = 0
  let catalogueFacts: Array<{ symbolCatalogueTotal: number; symbolCatalogueOffered: number; symbolCatalogueOmitted: number; symbolCatalogueTruncatedNames: number; symbolCatalogueIncomplete: boolean }> = []
  const h = harness({ files, decide: async ({ state, questions }) => {
    payloadBytes = Math.max(payloadBytes, Buffer.byteLength(JSON.stringify({ state, questions })))
    if (questions.some((q) => q.type === 'noul')) {
      catalogueFacts = Object.values((state as { files: Record<string, typeof catalogueFacts[number]> }).files)
    }
    const answers = Object.fromEntries(questions.map((question) => [question.id, question.type === 'noul' ? { type: 'noul', noul: 0.9 } : { type: 'choice', choice: question.id === 'taskIntent' ? 'implement_change' : 'implementation' }]))
    return { requestId: null, model: 'typesafe/jev-1.14', provider: 'TypeSafe', answers, usage: { inputTokens: null, outputTokens: null, totalTokens: null, estimatedCost: null } }
  } })
  const result = await createReuseContext({ index: h.index, decisions: h.decisions }).getReuseContext({ root: '/repo', query: 'inspect the catalogues' })
  assert.ok(payloadBytes <= 120000)
  assert.ok(catalogueFacts.some((item) => item.symbolCatalogueOmitted > 0))
  assert.ok(catalogueFacts.every((item) => item.symbolCatalogueOffered + item.symbolCatalogueOmitted === item.symbolCatalogueTotal))
  assert.ok(catalogueFacts.every((item) => item.symbolCatalogueTruncatedNames > 0 && item.symbolCatalogueIncomplete))
  assert.ok(result.selection.unassessed.length >= 0)
})

test('source edit during Jev await is rejected and close joins pending provider work', async () => {
  const file = { path: 'src/one.ts', text: 'function target() {}\n', symbols: [makeSymbol('src/one.ts', 'symbol-1', 'target', 1, 1, 'hash:src/one.ts')] }
  const edited = harness({ files: [file], decide: async (input) => {
    if (input.questions.some((question) => question.type === 'noul')) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      edited.source.get(file.path)!.hash = 'edited-hash'
    }
    const answers: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const question of input.questions) answers[question.id] = question.type === 'noul' ? { type: 'noul', noul: 0.9 } : { type: 'choice', choice: question.id === 'taskIntent' ? 'explain_behavior' : 'unspecified' }
    return { requestId: null, model: 'typesafe/jev-1.14', provider: 'TypeSafe', answers, usage: { inputTokens: null, outputTokens: null, totalTokens: null, estimatedCost: null } }
  } })
  await assert.rejects(createReuseContext({ index: edited.index, decisions: edited.decisions }).getReuseContext({ root: '/repo', query: 'change this' }),
    (error) => error instanceof CodeContextError && error.code === 'STALE_SNAPSHOT')

  let release!: () => void
  let entered!: () => void
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
  const releasePromise = new Promise<void>((resolve) => { release = resolve })
  const pending = harness({ decide: async ({ questions, signal }) => {
    if (questions.some((question) => question.id === 'taskIntent')) { entered(); await releasePromise }
    signal.throwIfAborted()
    return { requestId: null, model: 'typesafe/jev-1.14', provider: 'TypeSafe', answers: Object.fromEntries(questions.map((q) => [q.id, q.id === 'taskIntent' ? { type: 'choice', choice: 'explain_behavior' } : q.id === 'sourceScope' ? { type: 'choice', choice: 'unspecified' } : { type: 'choice', choice: 'none' }])), usage: { inputTokens: null, outputTokens: null, totalTokens: null, estimatedCost: null } }
  } })
  const reuse = createReuseContext({ index: pending.index, decisions: pending.decisions })
  const running = reuse.getReuseContext({ root: '/repo', query: 'explain this' })
  await enteredPromise
  let closed = false
  const close = reuse.close().then(() => { closed = true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(closed, false)
  release()
  await assert.rejects(running, OperationClosedError)
  await close
  await assert.rejects(reuse.getReuseContext({ root: '/repo', query: 'after close' }), OperationClosedError)
})

test('caller cancellation waits for the physical Jev promise to settle', async () => {
  let release!: () => void
  let entered!: () => void
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
  const releasePromise = new Promise<void>((resolve) => { release = resolve })
  const h = harness({ decide: async ({ questions }) => {
    if (questions.some((question) => question.id === 'taskIntent')) { entered(); await releasePromise }
    return { requestId: null, model: 'typesafe/jev-1.14', provider: 'TypeSafe', answers: Object.fromEntries(questions.map((q) => [q.id, q.id === 'taskIntent' ? { type: 'choice', choice: 'explain_behavior' } : q.id === 'sourceScope' ? { type: 'choice', choice: 'unspecified' } : { type: 'choice', choice: 'none' }])), usage: { inputTokens: null, outputTokens: null, totalTokens: null, estimatedCost: null } }
  } })
  const reuse = createReuseContext({ index: h.index, decisions: h.decisions })
  const controller = new AbortController()
  const cancellation = new Error('caller canceled')
  const running = reuse.getReuseContext({ root: '/repo', query: 'explain this', signal: controller.signal })
  await enteredPromise
  controller.abort(cancellation)
  let settled = false
  void running.finally(() => { settled = true }).catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(settled, false)
  release()
  await assert.rejects(running, (error) => error === cancellation)
  await reuse.close()
})
