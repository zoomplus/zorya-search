import type { CodeHit, CodeIndex, CodeSourceIdentity } from '../code/types.js'
import type { CodeSymbol } from '../code/symbol-types.js'
import type { CodeSymbolAnalysisStatus, FindCodeSymbolsResult } from '../code/symbol-api.js'
import { codeSourceKindMatches } from '../code/filters.js'
import type {
  LogicalBlockRole, LogicalContextBlock, LogicalContextOmission, LogicalContextResult,
  LogicalRange,
} from './logical-types.js'
import { CodeContextError } from './errors.js'

export interface LogicalSeed {
  hit: CodeHit
  origins: Array<{
    source: 'query' | 'related'
    relatedKind?: 'dependency' | 'similar'
    relatedSeed?: string
    queryIndex: number | null
    rank: number
    mode: 'lexical' | 'hybrid'
    lexicalRank: number | null
    denseRank: number | null
    rerankRank: number | null
    score: number
    profileId: string | null
  }>
}

type SymbolReader = NonNullable<CodeIndex['findCodeSymbols']>
type ReferenceReader = NonNullable<CodeIndex['findCodeReferences']>

export async function collectLogicalContext(input: {
  root: string
  seeds: LogicalSeed[]
  language?: string
  sourceKind?: 'implementation' | 'tests' | 'documentation' | 'all'
  signal: AbortSignal
  identity: CodeSourceIdentity
  maxRangeLines: number
  symbols?: SymbolReader
  references?: ReferenceReader
  includeRange(path: string, lineStart: number, lineEnd: number, origins: LogicalSeed['origins']): Promise<boolean>
  readSource: CodeIndex['readSource']
  getCoveredRanges(path: string, lineStart: number, lineEnd: number): LogicalRange[]
}): Promise<LogicalContextResult> {
  const maxSeeds = 8 as const
  const maxReferencesPerSeed = 50 as const
  const maxBlocks = 24 as const
  const maxSourceReads = 120 as const
  const seeds = input.seeds.slice(0, maxSeeds)
  const omissions: LogicalContextOmission[] = []
  let omissionsOmitted = 0
  const blocks: LogicalContextBlock[] = []
  let analysis: CodeSymbolAnalysisStatus | null = null
  let analysisIdentity: CodeSymbolAnalysisStatus['identity'] | null = null
  let analysisProfileId: string | null | undefined
  let referencesInspected = 0
  let sourceReads = 0
  let referencesTruncated = false
  let symbolsTruncated = false
  let blocksTruncated = input.seeds.length > maxSeeds
  let readsTruncated = false
  let provenRelations = 0
  const symbolById = new Map<string, CodeSymbol>()
  const blockById = new Map<string, LogicalContextBlock>()
  const roles = new Map<string, { role: LogicalBlockRole; relationFrom: string | null; relationKind: LogicalContextBlock['relationKind'] }>()

  const addOmission = (value: LogicalContextOmission) => {
    const projected: LogicalContextOmission = {
      ...value,
      range: value.range ? { path: value.range.path, lineStart: value.range.lineStart, lineEnd: value.range.lineEnd } : null,
      continuation: value.continuation ? {
        path: value.continuation.path, lineStart: value.continuation.lineStart,
        lineEnd: value.continuation.lineEnd, snapshotId: value.continuation.snapshotId,
      } : null,
    }
    if (omissions.length < 80) omissions.push(projected)
    else omissionsOmitted++
  }
  const continuation = (path: string, lineStart: number, lineEnd: number) => ({
    path, lineStart, lineEnd: Math.min(lineEnd, lineStart + input.maxRangeLines - 1),
    snapshotId: input.identity.snapshotId,
  })
  const blockSource = (symbol: CodeSymbol): LogicalRange => ({
    path: symbol.location.path,
    lineStart: symbol.location.lineStart,
    lineEnd: symbol.location.lineEnd,
  })
  const statusOf = (result: FindCodeSymbolsResult) => {
    if (!sameIdentity(result.analysis.identity, input.identity) ||
      (analysisIdentity && !sameIdentity(result.analysis.identity, analysisIdentity)) ||
      (analysisProfileId !== undefined && result.analysis.profile?.id !== analysisProfileId))
      throw new CodeContextError('STALE_SNAPSHOT')
    analysisIdentity = result.analysis.identity
    analysisProfileId = result.analysis.profile?.id ?? null
    analysis = result.analysis
  }
  const findByEnclosing = async (path: string, lineStart: number, lineEnd: number) => {
    if (!input.symbols) return null
    const result = await input.symbols({ root: input.root, enclosing: { path, lineStart, lineEnd }, limit: 100, signal: input.signal })
    statusOf(result)
    return result
  }
  const exactSymbol = async (id: string): Promise<CodeSymbol | null> => {
    const cached = symbolById.get(id)
    if (cached) return cached
    if (!input.symbols) return null
    const result = await input.symbols({ root: input.root, symbolId: id, limit: 1, signal: input.signal })
    statusOf(result)
    const symbol = result.symbols.find((candidate) => candidate.id === id) ?? null
    if (symbol) symbolById.set(id, symbol)
    return symbol
  }
  const readCount = async (path: string): Promise<number | undefined> => {
    if (sourceReads >= maxSourceReads) { readsTruncated = true; return undefined }
    sourceReads++
    const result = await input.readSource({ root: input.root, path, lineStart: 1, lineEnd: 1,
      snapshotId: input.identity.snapshotId, signal: input.signal })
    if (result.stale || result.snapshotId !== input.identity.snapshotId) throw new CodeContextError('STALE_SNAPSHOT')
    return result.fileLineCount
  }
  const includeSymbol = async (
    symbol: CodeSymbol,
    role: LogicalBlockRole,
    relationFrom: string | null,
    relationKind: LogicalContextBlock['relationKind'],
    origins: LogicalSeed['origins'],
    depth = 1,
  ): Promise<LogicalContextBlock | null> => {
    const prior = blockById.get(symbol.id)
    if (prior) return prior
    const source = blockSource(symbol)
    if ((input.sourceKind && !codeSourceKindMatches(source.path, input.sourceKind)) ||
      (input.language && !languageMatchesPath(source.path, input.language))) {
      addOmission({ symbolId: symbol.id, role, range: source, reason: 'source_filter', continuation: null })
      return null
    }
    if (blocks.length >= maxBlocks) {
      blocksTruncated = true
        addOmission({ symbolId: symbol.id, role, range: source, reason: 'block_limit', continuation: continuation(source.path, source.lineStart, source.lineEnd) })
      return null
    }
    const block: LogicalContextBlock = {
      symbolId: symbol.id, name: symbol.name, kind: symbol.kind, role, source,
      complete: false, includedRanges: [], relationFrom, relationKind,
      depth, wholeFile: false,
    }
    blocks.push(block)
    blockById.set(symbol.id, block)
    let lineCount: number | undefined
    // A whole-file choice is made only when the producer supplies its exact count.
    lineCount = await readCount(source.path)
    const target = lineCount !== undefined && lineCount <= input.maxRangeLines
      ? { path: source.path, lineStart: 1, lineEnd: lineCount }
      : source
    const ranges: LogicalRange[] = []
    for (let start = target.lineStart; start <= target.lineEnd; ) {
      if (sourceReads >= maxSourceReads) {
        readsTruncated = true
        const nextEnd = Math.min(target.lineEnd, start + input.maxRangeLines - 1)
        addOmission({ symbolId: symbol.id, role, range: { path: target.path, lineStart: start, lineEnd: target.lineEnd },
          reason: 'read_limit', continuation: continuation(target.path, start, nextEnd) })
        break
      }
      const end = Math.min(target.lineEnd, start + input.maxRangeLines - 1)
      const coveredBefore = input.getCoveredRanges(target.path, start, end)
      const uncovered = subtractCovered(target.path, start, end, coveredBefore)
      let stopped = false
      for (const range of uncovered) {
        if (sourceReads >= maxSourceReads) {
          readsTruncated = true
          addOmission({ symbolId: symbol.id, role, range: { path: range.path, lineStart: range.lineStart, lineEnd: target.lineEnd },
            reason: 'read_limit', continuation: continuation(range.path, range.lineStart, target.lineEnd) })
          stopped = true
          break
        }
        sourceReads++
        const included = await input.includeRange(range.path, range.lineStart, range.lineEnd, origins)
        if (included) {
          ranges.push(range)
        } else {
          addOmission({ symbolId: symbol.id, role, range: { ...range, lineEnd: target.lineEnd }, reason: 'budget',
            continuation: continuation(range.path, range.lineStart, target.lineEnd) })
          stopped = true
          break
        }
      }
      if (stopped) break
      start = end + 1
    }
    block.includedRanges = mergeRanges([...input.getCoveredRanges(target.path, target.lineStart, target.lineEnd), ...ranges])
    block.complete = covers(block.includedRanges, target.lineStart, target.lineEnd)
    if (target.lineStart !== source.lineStart || target.lineEnd !== source.lineEnd) {
      if (!block.complete) block.source = source
      else block.source = target
    }
    if (!block.complete) {
      const first = firstMissing(block.includedRanges, target.lineStart, target.lineEnd)
      if (first && !omissions.some((omission) => omission.symbolId === symbol.id && omission.continuation?.lineStart === first))
        addOmission({ symbolId: symbol.id, role, range: { path: target.path, lineStart: first, lineEnd: target.lineEnd },
          reason: readsTruncated ? 'read_limit' : 'budget',
          continuation: continuation(target.path, first, target.lineEnd) })
    }
    block.wholeFile = block.complete && lineCount !== undefined && lineCount <= input.maxRangeLines &&
      target.lineStart === 1 && target.lineEnd === lineCount
    return block
  }
  const includeFallback = async (seed: LogicalSeed) => {
    const source = { path: seed.hit.path, lineStart: seed.hit.lineStart, lineEnd: seed.hit.lineEnd }
    addOmission({ symbolId: null, role: 'source_fallback', range: source, reason: 'no_enclosing_symbol',
      continuation: continuation(source.path, source.lineStart, source.lineEnd) })
    if (blocks.length >= maxBlocks) { blocksTruncated = true; return }
    const block: LogicalContextBlock = {
      symbolId: null, name: seed.hit.symbol, kind: null, role: 'source_fallback', source,
      complete: false, includedRanges: [], relationFrom: null, relationKind: 'seed',
      depth: 0, wholeFile: false,
    }
    blocks.push(block)
    for (const range of splitRange(source, input.maxRangeLines)) {
      if (sourceReads >= maxSourceReads) { readsTruncated = true; break }
      sourceReads++
      if (await input.includeRange(range.path, range.lineStart, range.lineEnd, seed.origins)) block.includedRanges.push(range)
      else break
    }
  }

  const stateUnsupported = (): LogicalContextResult => result('unsupported', null)
  if (!input.symbols || !input.references) return stateUnsupported()
  if (!seeds.length) {
    const probe = await input.symbols({ root: input.root, limit: 1, signal: input.signal })
    statusOf(probe)
    return result(normalizeAnalysisState(probe.analysis.state), probe.analysis)
  }

  const seedSymbols = new Map<string, { symbol: CodeSymbol; seed: LogicalSeed }>()
  const fallbackSeeds: LogicalSeed[] = []
  for (const seed of seeds) {
      const query = await findByEnclosing(seed.hit.path, seed.hit.lineStart, seed.hit.lineEnd)
    if (!query) { fallbackSeeds.push(seed); continue }
    if (query.analysis.state === 'not_indexed' || query.analysis.state === 'unavailable') continue
    const isApplicable = (symbol: CodeSymbol) => !symbol.synthetic &&
      ['function', 'method', 'callable', 'class', 'interface', 'type', 'enum', 'constructor'].includes(symbol.kind) &&
      symbol.location.path === seed.hit.path
    const applicable = query.symbols.filter((symbol) => isApplicable(symbol) &&
      symbol.location.lineStart <= seed.hit.lineStart && symbol.location.lineEnd >= seed.hit.lineEnd)
    const chosen = applicable.sort((a, b) =>
      (a.location.end - a.location.start) - (b.location.end - b.location.start) ||
      (a.location.lineEnd - a.location.lineStart) - (b.location.lineEnd - b.location.lineStart) || a.id.localeCompare(b.id))[0]
    if (query.truncated) {
      symbolsTruncated = true
      blocksTruncated = true
      addOmission({ symbolId: null, role: null,
        range: { path: seed.hit.path, lineStart: seed.hit.lineStart, lineEnd: seed.hit.lineEnd },
        reason: 'symbol_limit', continuation: null })
    }
    let associated = query.truncated ? undefined : chosen
    const hint = normalizeHitSymbol(seed.hit.symbol)
    // Chunk symbols describe the AST declaration, while chunk ranges start at
    // getFullStart() and may include imports/comments before that declaration.
    // A containing class can therefore be the smallest strict enclosure even
    // when the hit is specifically attributed to one of its methods. Prefer a
    // uniquely proven exact name match in that case, and keep ambiguity visible.
    if (!query.truncated && hint) {
      const named = await input.symbols({ root: input.root, name: hint, path: seed.hit.path, limit: 100, signal: input.signal })
      statusOf(named)
      const exact = named.symbols.filter((symbol) => isApplicable(symbol) &&
        (symbol.name === hint || symbol.qualifiedName === hint) &&
        symbol.location.lineStart <= seed.hit.lineEnd && symbol.location.lineEnd >= seed.hit.lineStart)
      const covering = exact.filter((symbol) => symbol.location.lineEnd >= seed.hit.lineEnd)
      if (named.truncated) {
        symbolsTruncated = true
        blocksTruncated = true
        associated = undefined
        addOmission({ symbolId: null, role: null,
          range: { path: seed.hit.path, lineStart: seed.hit.lineStart, lineEnd: seed.hit.lineEnd },
          reason: 'symbol_limit', continuation: null })
      } else if (exact.length > 0) {
        if (exact.length !== 1) associated = undefined
        else if (covering.length === 1) associated = covering[0]
      }
    }
    if (!associated) { fallbackSeeds.push(seed); continue }
    symbolById.set(associated.id, associated)
    seedSymbols.set(associated.id, { symbol: associated, seed })
    roles.set(associated.id, { role: 'seed_definition', relationFrom: null, relationKind: 'seed' })
  }
  const currentAnalysis = analysis as CodeSymbolAnalysisStatus | null
  if (!currentAnalysis) return result('not_indexed', null)
  if (currentAnalysis.state === 'not_indexed' || currentAnalysis.state === 'unavailable') return result(currentAnalysis.state, currentAnalysis)
  for (const [id, value] of seedSymbols) {
    const role = roles.get(id)!
    await includeSymbol(value.symbol, role.role, role.relationFrom, role.relationKind, value.seed.origins, 0)
  }
  for (const seed of fallbackSeeds) await includeFallback(seed)

  type Candidate = { symbol: CodeSymbol; role: LogicalBlockRole; from: string; kind: LogicalContextBlock['relationKind']; origins: LogicalSeed['origins']; depth: number }
  const queued = new Map<string, Candidate>()
  const enqueue = (key: string, candidate: Candidate, omittedRange: LogicalRange | null) => {
    const prior = queued.get(key)
    if (prior) {
      // Seeds are resolved before relations, so a second-hop route from an
      // earlier seed can queue a target before another seed reaches it
      // directly. Keep the strongest (shortest) proven route.
      if (candidate.depth < prior.depth) queued.set(key, candidate)
      return
    }
    if (blockById.has(key)) return
    if (blocks.length + queued.size >= maxBlocks) {
      blocksTruncated = true
      addOmission({ symbolId: candidate.symbol.id || null, role: candidate.role, range: omittedRange,
        reason: 'block_limit', continuation: null })
      return
    }
    queued.set(key, candidate)
  }
  for (const [seedId, value] of seedSymbols) {
    let seedReferencesInspected = 0
    const directCallees: CodeSymbol[] = []
    const perDirection = 20
    for (const direction of ['outgoing', 'incoming'] as const) {
      if (blocks.length + queued.size >= maxBlocks) {
        blocksTruncated = true
        addOmission({ symbolId: seedId, role: null, range: null, reason: 'block_limit', continuation: null })
        break
      }
      const refs = await input.references({ root: input.root, symbolId: seedId, direction, limit: perDirection, signal: input.signal })
      if (!sameIdentity(refs.analysis.identity, input.identity) ||
        (analysisIdentity && !sameIdentity(refs.analysis.identity, analysisIdentity)) ||
        (analysisProfileId !== undefined && refs.analysis.profile?.id !== analysisProfileId))
        throw new CodeContextError('STALE_SNAPSHOT')
      analysisIdentity = refs.analysis.identity
      analysisProfileId = refs.analysis.profile?.id ?? null
      analysis = refs.analysis
      referencesInspected += refs.references.length
      seedReferencesInspected += refs.references.length
      if (refs.truncated || refs.nextCursor) referencesTruncated = true
      if (refs.truncated || refs.nextCursor) addOmission({ symbolId: seedId, role: null, range: null,
        reason: 'reference_limit', continuation: null })
      for (const reference of refs.references) {
        input.signal.throwIfAborted()
        if (seedReferencesInspected > maxReferencesPerSeed) { referencesTruncated = true; break }
        if (reference.unresolvedReason === 'ambiguous') {
          addOmission({ symbolId: null, role: null, range: reference.from, reason: 'ambiguous', continuation: null })
          continue
        }
        if (reference.targetKind === 'external' || reference.targetKind === 'unresolved') {
          addOmission({ symbolId: null, role: null, range: reference.from, reason: reference.targetKind, continuation: null })
          continue
        }
        const testSource = codeSourceKindMatches(reference.from.path, 'tests')
        if (direction === 'outgoing') {
          for (const targetId of reference.targetSymbolIds) {
            if (!queued.has(targetId) && !blockById.has(targetId) && blocks.length + queued.size >= maxBlocks) {
              blocksTruncated = true
              addOmission({ symbolId: targetId, role: null, range: reference.from, reason: 'block_limit', continuation: null })
              continue
            }
            const target = await exactSymbol(targetId)
            if (!target) { addOmission({ symbolId: targetId, role: null, range: reference.from, reason: 'missing_target', continuation: null }); continue }
            const typeTarget = ['class', 'interface', 'type', 'enum'].includes(target.kind) && reference.kind !== 'call' && reference.kind !== 'construct'
            const role: LogicalBlockRole | null = typeTarget ? 'contract' : reference.kind === 'call' || reference.kind === 'construct' ? 'callee' : null
            if (!role) continue
            const candidate: Candidate = { symbol: target, role, from: seedId,
              kind: reference.kind === 'call' ? 'call' : reference.kind === 'construct' ? 'construct' : 'reference',
              origins: value.seed.origins, depth: 1 }
            enqueue(target.id, candidate, reference.from)
            if (role === 'callee') directCallees.push(target)
            provenRelations++
          }
        } else if (testSource) {
          if (input.sourceKind && input.sourceKind !== 'all' && input.sourceKind !== 'tests') {
            addOmission({ symbolId: reference.ownerSymbolId, role: 'test', range: reference.from, reason: 'source_filter', continuation: null })
            continue
          }
          if (reference.ownerSymbolId) {
            if (!queued.has(reference.ownerSymbolId) && !blockById.has(reference.ownerSymbolId) && blocks.length + queued.size >= maxBlocks) {
              blocksTruncated = true
              addOmission({ symbolId: reference.ownerSymbolId, role: 'test', range: reference.from,
                reason: 'block_limit', continuation: null })
              continue
            }
            const owner = await exactSymbol(reference.ownerSymbolId)
            if (owner && !owner.synthetic) enqueue(owner.id, { symbol: owner, role: 'test', from: seedId,
              kind: reference.kind === 'call' || reference.kind === 'construct' ? 'test_call' : 'test_reference',
              origins: value.seed.origins, depth: 1 }, reference.from)
            else enqueue(`source:${reference.from.path}:${reference.from.lineStart}`, {
              symbol: { id: '', name: '', qualifiedName: '', kind: 'module-init', location: reference.from,
                parentId: null, container: null, signature: '', signatureTruncated: false, contract: false,
                synthetic: true, overloadGroupId: null },
              role: 'test', from: seedId,
              kind: reference.kind === 'call' || reference.kind === 'construct' ? 'test_call' : 'test_reference',
              origins: value.seed.origins,
              depth: 1,
            }, reference.from)
          } else enqueue(`source:${reference.from.path}:${reference.from.lineStart}`, {
            symbol: { id: '', name: '', qualifiedName: '', kind: 'module-init', location: reference.from,
              parentId: null, container: null, signature: '', signatureTruncated: false, contract: false,
              synthetic: true, overloadGroupId: null },
            role: 'test', from: seedId,
            kind: reference.kind === 'call' || reference.kind === 'construct' ? 'test_call' : 'test_reference',
            origins: value.seed.origins,
            depth: 1,
          }, reference.from)
          provenRelations++
        } else if ((reference.kind === 'call' || reference.kind === 'construct') && reference.ownerSymbolId) {
          if (!queued.has(reference.ownerSymbolId) && !blockById.has(reference.ownerSymbolId) && blocks.length + queued.size >= maxBlocks) {
            blocksTruncated = true
            addOmission({ symbolId: reference.ownerSymbolId, role: 'caller', range: reference.from,
              reason: 'block_limit', continuation: null })
            continue
          }
          const caller = await exactSymbol(reference.ownerSymbolId)
          if (caller && !caller.synthetic) {
            enqueue(caller.id, { symbol: caller, role: 'caller', from: seedId, kind: reference.kind,
              origins: value.seed.origins, depth: 1 }, reference.from)
            provenRelations++
          }
        }
      }
    }
    // Follow only the next concrete call layer, within the seed's remaining reference allowance.
    for (const callee of [...new Map(directCallees.map((symbol) => [symbol.id, symbol])).values()].slice(0, 10)) {
      const remaining = maxReferencesPerSeed - seedReferencesInspected
      if (remaining <= 0 || blocks.length + queued.size >= maxBlocks) {
        referencesTruncated ||= remaining <= 0
        blocksTruncated ||= blocks.length + queued.size >= maxBlocks
        if (blocks.length + queued.size >= maxBlocks)
          addOmission({ symbolId: callee.id, role: 'callee', range: blockSource(callee), reason: 'block_limit', continuation: null })
        break
      }
      const refs = await input.references({ root: input.root, symbolId: callee.id, direction: 'outgoing',
        kind: 'call', limit: Math.min(remaining, 10), signal: input.signal })
      if (!sameIdentity(refs.analysis.identity, input.identity) ||
        (analysisProfileId !== undefined && refs.analysis.profile?.id !== analysisProfileId))
        throw new CodeContextError('STALE_SNAPSHOT')
      seedReferencesInspected += refs.references.length
      referencesInspected += refs.references.length
      referencesTruncated ||= refs.truncated || refs.nextCursor !== null
      for (const reference of refs.references) {
        input.signal.throwIfAborted()
        if (reference.targetKind !== 'concrete' && reference.targetKind !== 'contract') {
          addOmission({ symbolId: null, role: null, range: reference.from,
            reason: reference.unresolvedReason === 'ambiguous' ? 'ambiguous' : reference.targetKind, continuation: null })
          continue
        }
        for (const targetId of reference.targetSymbolIds) {
          if (!queued.has(targetId) && !blockById.has(targetId) && blocks.length + queued.size >= maxBlocks) {
            blocksTruncated = true
            addOmission({ symbolId: targetId, role: 'callee', range: reference.from, reason: 'block_limit', continuation: null })
            continue
          }
          const target = await exactSymbol(targetId)
          if (!target) { addOmission({ symbolId: targetId, role: null, range: reference.from, reason: 'missing_target', continuation: null }); continue }
          enqueue(target.id, { symbol: target, role: 'callee', from: callee.id, kind: 'call',
            origins: value.seed.origins, depth: 2 }, reference.from)
          provenRelations++
        }
      }
    }
  }
  const roleOrder: Record<LogicalBlockRole, number> = {
    contract: 0, seed_definition: 0, callee: 1, caller: 2, test: 3, source_fallback: 4,
  }
  for (const candidate of [...queued.values()].sort((a, b) =>
    roleOrder[a.role] - roleOrder[b.role] || a.depth - b.depth || a.symbol.location.path.localeCompare(b.symbol.location.path) ||
    a.symbol.location.lineStart - b.symbol.location.lineStart)) {
    if (blocks.length >= maxBlocks) { blocksTruncated = true; addOmission({ symbolId: candidate.symbol.id || null,
              role: candidate.role, range: blockSource(candidate.symbol),
              reason: 'block_limit', continuation: continuation(candidate.symbol.location.path, candidate.symbol.location.lineStart, candidate.symbol.location.lineEnd) }); continue }
    const role = roles.get(candidate.symbol.id)
    if (candidate.symbol.id && role && role.role === 'seed_definition') continue
    if (!candidate.symbol.id) {
      const referenceRange = blockSource(candidate.symbol)
      if ((input.sourceKind && !codeSourceKindMatches(referenceRange.path, input.sourceKind)) ||
        (input.language && !languageMatchesPath(referenceRange.path, input.language))) {
        addOmission({ symbolId: null, role: candidate.role, range: referenceRange, reason: 'source_filter', continuation: null })
        continue
      }
      const lineCount = await readCount(referenceRange.path)
      const wholeFile = lineCount !== undefined && lineCount <= input.maxRangeLines
      const range = wholeFile
        ? { path: referenceRange.path, lineStart: 1, lineEnd: lineCount }
        : referenceRange
      const block: LogicalContextBlock = { symbolId: null, name: null, kind: null, role: candidate.role, source: range,
        complete: false, includedRanges: [], relationFrom: candidate.from, relationKind: candidate.kind,
        depth: candidate.depth, wholeFile: false }
      blocks.push(block)
      let stopped = false
      for (const part of splitRange(range, input.maxRangeLines)) {
        if (sourceReads >= maxSourceReads) { readsTruncated = true; break }
        const covered = input.getCoveredRanges(part.path, part.lineStart, part.lineEnd)
        for (const missing of subtractCovered(part.path, part.lineStart, part.lineEnd, covered)) {
          if (sourceReads >= maxSourceReads) { readsTruncated = true; stopped = true; break }
          sourceReads++
          if (await input.includeRange(missing.path, missing.lineStart, missing.lineEnd, candidate.origins))
            block.includedRanges.push(missing)
          else { stopped = true; break }
        }
        if (stopped) break
      }
      block.includedRanges = mergeRanges([...input.getCoveredRanges(range.path, range.lineStart, range.lineEnd), ...block.includedRanges])
      block.complete = wholeFile && covers(block.includedRanges, range.lineStart, range.lineEnd)
      block.wholeFile = block.complete && wholeFile
      if (!block.complete) addOmission({ symbolId: null, role: candidate.role, range,
        reason: !wholeFile ? 'no_enclosing_symbol' : readsTruncated ? 'read_limit' : 'budget',
        continuation: continuation(range.path, firstMissing(block.includedRanges, range.lineStart, range.lineEnd) ?? range.lineStart,
          range.lineEnd) })
      continue
    }
    await includeSymbol(candidate.symbol, candidate.role, candidate.from, candidate.kind, candidate.origins, candidate.depth)
  }

  const state = currentAnalysis.state === 'partial' || !currentAnalysis.complete || blocks.some((block) => !block.complete) || omissions.length
    ? 'partial' : 'available'
  return result(state, currentAnalysis)

  function result(state: LogicalContextResult['state'], value: CodeSymbolAnalysisStatus | null): LogicalContextResult {
    const coverage = value ? {
      totalFiles: value.coverageTotalFiles,
      omittedFiles: value.coverageOmittedFiles,
      counts: { ...value.coverageCounts },
      unresolvedReferences: value.unresolvedReferenceCount,
      unresolvedCalls: value.unresolvedCallCount,
      truncation: { ...value.truncation },
    } : null
    const noMetadata = state === 'not_indexed' || state === 'unavailable' || state === 'unsupported'
    return {
      state: state === 'available' && (referencesTruncated || blocksTruncated || readsTruncated) ? 'partial' : state,
      profileId: value?.profile?.id ?? null,
      analysisComplete: value?.complete ?? false,
      coverage,
      blocks: noMetadata ? [] : blocks,
      omissions: noMetadata ? [] : omissions,
      omissionsOmitted: noMetadata ? 0 : omissionsOmitted,
      omissionsTruncated: !noMetadata && omissionsOmitted > 0,
      limits: { maxSeeds, seedsInspected: seeds.length, seedsTruncated: input.seeds.length > maxSeeds,
        maxReferencesPerSeed, referencesInspected,
        maxBlocks, blocksSelected: blocks.length, maxSourceReads, sourceReads, maxRangeLines: input.maxRangeLines,
        referencesTruncated, symbolsTruncated, blocksTruncated, readsTruncated },
      relationCoverage: state === 'unsupported' || state === 'unavailable' || state === 'not_indexed'
        ? 'unavailable' : provenRelations ? 'static_and_bounded' : 'no_proven_relation',
      runtimeCallCoverage: 'not_claimed',
    }
  }
}

function subtractCovered(path: string, start: number, end: number, ranges: LogicalRange[]): LogicalRange[] {
  const result: LogicalRange[] = []
  let next = start
  for (const range of [...ranges].sort((a, b) => a.lineStart - b.lineStart)) {
    if (range.lineEnd < next) continue
    if (range.lineStart > next) result.push({ path, lineStart: next, lineEnd: Math.min(end, range.lineStart - 1) })
    next = Math.max(next, range.lineEnd + 1)
    if (next > end) break
  }
  if (next <= end) result.push({ path, lineStart: next, lineEnd: end })
  return result
}
function splitRange(range: LogicalRange, maxLines: number): LogicalRange[] {
  const result: LogicalRange[] = []
  for (let start = range.lineStart; start <= range.lineEnd; ) {
    const lineEnd = Math.min(range.lineEnd, start + maxLines - 1)
    result.push({ path: range.path, lineStart: start, lineEnd })
    start = lineEnd + 1
  }
  return result
}
function mergeRanges(ranges: LogicalRange[]): LogicalRange[] {
  const sorted = ranges.sort((a, b) => a.path.localeCompare(b.path) || a.lineStart - b.lineStart)
  const result: LogicalRange[] = []
  for (const range of sorted) {
    const prior = result.at(-1)
    if (prior && prior.path === range.path && range.lineStart <= prior.lineEnd + 1) prior.lineEnd = Math.max(prior.lineEnd, range.lineEnd)
    else result.push({ ...range })
  }
  return result
}
function covers(ranges: LogicalRange[], start: number, end: number): boolean {
  let next = start
  for (const range of [...ranges].sort((a, b) => a.lineStart - b.lineStart)) {
    if (range.lineStart > next) return false
    next = Math.max(next, range.lineEnd + 1)
    if (next > end) return true
  }
  return next > end
}
function firstMissing(ranges: LogicalRange[], start: number, end: number): number | null {
  let next = start
  for (const range of [...ranges].sort((a, b) => a.lineStart - b.lineStart)) {
    if (range.lineStart > next) return next
    next = Math.max(next, range.lineEnd + 1)
  }
  return next <= end ? next : null
}
function sameIdentity(actual: CodeSymbolAnalysisStatus['identity'], expected: CodeSourceIdentity): boolean {
  return actual.snapshotId === expected.snapshotId && actual.contentHash === expected.contentHash &&
    actual.root === expected.root && actual.worktreeId === expected.worktreeId && actual.repoId === expected.repoId &&
    actual.head === expected.head && actual.branch === expected.branch
}
function normalizeAnalysisState(state: CodeSymbolAnalysisStatus['state']): LogicalContextResult['state'] {
  if (state === 'indexed') return 'available'
  return state
}
function normalizeHitSymbol(symbol: string | null): string | null {
  if (typeof symbol !== 'string' || !symbol.trim() || symbol.length > 256) return null
  const normalized = symbol.trim().replace(/(?:#\d+|@\d+)+$/u, '')
  return normalized || null
}
function languageMatchesPath(path: string, language: string): boolean {
  const extension = path.replaceAll('\\', '/').split('/').at(-1)?.split('.').at(-1)?.toLowerCase() ?? ''
  const aliases: Record<string, string[]> = {
    typescript: ['ts', 'tsx', 'mts', 'cts'],
    javascript: ['js', 'jsx', 'mjs', 'cjs'],
    python: ['py'],
    markdown: ['md', 'mdx'],
  }
  const normalized = language.trim().toLowerCase()
  return (aliases[normalized] ?? [normalized]).includes(extension)
}
