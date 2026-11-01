import { createHash } from 'node:crypto'
import type { QueryableDatabase } from '../storage/database.js'
import { CodeIndexError } from './errors.js'
import { normalizeCodeLanguage, normalizeSourceKind } from './filters.js'
import type { CodeSymbol, CodeSymbolReference } from './symbol-types.js'
import type { CodeIndex, CodeSourceIdentity } from './types.js'
import type {
  CodeCallTrace, CodeSymbolAnalysisStatus, FindCodeReferencesInput, FindCodeReferencesResult,
  FindCodeSymbolsInput, FindCodeSymbolsResult, TraceCodeCallsInput,
} from './symbol-api.js'
import { DEFAULT_SYMBOL_LIMITS, loadSymbolAnalysis, readStoredSymbol, type StoredReferenceRow, type StoredSymbolRow, type SymbolAnalysisLimits } from './symbol-storage.js'

type Current = { identity: CodeSourceIdentity; snapshot: string; metadataGeneration: number | null; metadataProfile: string | null }
type GetCurrent = (root: string, signal?: AbortSignal) => Promise<Current>
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const check = (signal?: AbortSignal) => signal?.throwIfAborted()
const CURSOR_VERSION = 1
type Cursor = { v: 1; snapshot: string; profile: string; filters: string; id: string }

function encodeCursor(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url') }
function decodeCursor(value: string | undefined, identity: CodeSymbolAnalysisStatus, filters: string): string | null {
  if (value === undefined) return null
  if (value.length > 4096) throw new CodeIndexError('CODE_INDEX_SYMBOL_CURSOR_INVALID')
  let parsed: Cursor
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor }
  catch { throw new CodeIndexError('CODE_INDEX_SYMBOL_CURSOR_INVALID') }
  if (!parsed || typeof parsed !== 'object' || parsed.v !== CURSOR_VERSION || parsed.snapshot !== identity.identity.snapshotId ||
    parsed.profile !== identity.profile?.id || parsed.filters !== filters || !/^[a-f0-9]{64}$/u.test(parsed.id))
    throw new CodeIndexError('CODE_INDEX_SYMBOL_CURSOR_STALE')
  return parsed.id
}
function limitValue(value: number | undefined, fallback: number, maximum: number): number {
  const limit = value ?? fallback
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum)
    throw new CodeIndexError('CODE_INDEX_SYMBOL_LIMIT_INVALID')
  return limit
}
function filterIdentity(input: object): string { return sha(JSON.stringify(input)) }
function normalizedEnclosingPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value.includes('\0'))
    throw new CodeIndexError('CODE_INDEX_SYMBOL_QUERY_INVALID')
  const slashed = value.replaceAll('\\', '/')
  if (slashed.startsWith('/') || /^[a-zA-Z]:/u.test(slashed))
    throw new CodeIndexError('CODE_INDEX_SYMBOL_QUERY_INVALID')
  const segments = slashed.split('/')
  if (segments.some((segment) => segment === '..'))
    throw new CodeIndexError('CODE_INDEX_SYMBOL_QUERY_INVALID')
  const normalized = segments.filter((segment) => segment !== '' && segment !== '.').join('/')
  if (!normalized) throw new CodeIndexError('CODE_INDEX_SYMBOL_QUERY_INVALID')
  return normalized
}
function sqlSourceKind(column: string, kind: string): string | null {
  if (kind === 'all') return null
  const tests = `(${column} ~* '(^|/)(test|tests|__tests__|fixtures|__fixtures__)(/|$)' OR ${column} ~* '(^|[.-])(test|spec)(\.[^.]+)*$')`
  const docs = `(${column} ~* '(^|/)docs(/|$)' OR lower(${column}) ~* '(^|/)(readme|changelog|contributing|license|agents\.md)$' OR lower(${column}) ~* '\.(md|mdx|rst|txt|adoc|mdc)$')`
  return kind === 'tests' ? tests : kind === 'documentation' ? `NOT ${tests} AND ${docs}` : `NOT ${tests} AND NOT ${docs}`
}
function languageValues(language: string): { values: string[]; insensitive: boolean } {
  const normalized = normalizeCodeLanguage(language)!
  if (normalized === 'typescript') return { values: ['ts', 'tsx', 'mts', 'cts', 'typescript', 'typescriptreact'], insensitive: true }
  if (normalized === 'javascript') return { values: ['js', 'jsx', 'mjs', 'cjs', 'javascript', 'javascriptreact'], insensitive: true }
  if (normalized === 'python') return { values: ['py', 'python'], insensitive: true }
  if (normalized === 'markdown') return { values: ['md', 'mdx', 'markdown'], insensitive: true }
  return { values: [normalized], insensitive: false }
}

export function createSymbolQueries(
  database: QueryableDatabase,
  getCurrent: GetCurrent,
  expectedLimits: SymbolAnalysisLimits = DEFAULT_SYMBOL_LIMITS,
) {
  const capturedExpectedLimits: SymbolAnalysisLimits = Object.freeze({
    maxFiles: expectedLimits.maxFiles,
    maxSymbols: expectedLimits.maxSymbols,
    maxReferences: expectedLimits.maxReferences,
    tsconfigPath: expectedLimits.tsconfigPath,
  })
  async function context(root: string, signal?: AbortSignal) {
    check(signal)
    const current = await getCurrent(root, signal)
    const analysis = await loadSymbolAnalysis(database, current.identity, current.identity.worktreeId, capturedExpectedLimits)
    check(signal)
    return { current, analysis }
  }
  async function assertCurrent(root: string, before: Current, signal?: AbortSignal) {
    check(signal)
    const after = await getCurrent(root, signal)
    if (after.snapshot !== before.snapshot || after.identity.root !== before.identity.root ||
      after.metadataGeneration !== before.metadataGeneration || after.metadataProfile !== before.metadataProfile)
      throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_SEARCH')
  }
  async function findCodeSymbols(input: FindCodeSymbolsInput): Promise<FindCodeSymbolsResult> {
    const limit = limitValue(input.limit, 20, 100)
    const query = input.query ?? input.name
    if (query !== undefined && (typeof query !== 'string' || query.length > 256 || /[\p{Cc}\u2028\u2029]/u.test(query)))
      throw new CodeIndexError('CODE_INDEX_SYMBOL_QUERY_INVALID')
    if (input.path !== undefined && (typeof input.path !== 'string' || input.path.length > 1024 || input.path.includes('\0')))
      throw new CodeIndexError('CODE_INDEX_SYMBOL_QUERY_INVALID')
    if (input.symbolId !== undefined && (typeof input.symbolId !== 'string' || !/^[a-f0-9]{64}$/u.test(input.symbolId)))
      throw new CodeIndexError('CODE_INDEX_SYMBOL_ID_INVALID')
    let enclosing: { path: string; lineStart: number; lineEnd: number } | undefined
    if (input.enclosing !== undefined) {
      const candidate = input.enclosing
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
        throw new CodeIndexError('CODE_INDEX_SYMBOL_QUERY_INVALID')
      const path = normalizedEnclosingPath(candidate.path)
      const lineStart = candidate.lineStart
      const lineEnd = candidate.lineEnd ?? lineStart
      if (!Number.isSafeInteger(lineStart) || lineStart < 1 || lineStart > 2_147_483_647 ||
        !Number.isSafeInteger(lineEnd) || lineEnd < lineStart || lineEnd > 2_147_483_647)
        throw new CodeIndexError('CODE_INDEX_SYMBOL_QUERY_INVALID')
      enclosing = { path, lineStart, lineEnd }
    }
    const language = input.language === undefined ? undefined : normalizeCodeLanguage(input.language)
    const sourceKind = normalizeSourceKind(input.sourceKind) ?? 'all'
    const baseFilters = [query ?? null, input.path ?? null, language ?? null, sourceKind]
    const filters = input.symbolId === undefined && enclosing === undefined
      ? filterIdentity(baseFilters)
      : filterIdentity([...baseFilters, { symbolId: input.symbolId ?? null, enclosing: enclosing ?? null }])
    const { current, analysis } = await context(input.root, input.signal)
    if (analysis.state === 'not_indexed' || analysis.state === 'unavailable' || !analysis.profile) {
      await assertCurrent(input.root, current, input.signal)
      return { analysis, symbols: [], nextCursor: null, truncated: false }
    }
    const afterId = decodeCursor(input.cursor, analysis, filters)
    const values: unknown[] = [current.snapshot, analysis.profile.id]
    const conditions = ['snapshot_id=$1', 'analysis_profile_id=$2']
    if (input.symbolId !== undefined) { values.push(input.symbolId); conditions.push(`symbol_id=$${values.length}`) }
    if (query) { values.push(`%${query}%`); conditions.push(`(name ILIKE $${values.length} OR qualified_name ILIKE $${values.length})`) }
    if (input.path) {
      const escapedPath = input.path.replaceAll('\\', '/').replace(/\/$/u, '').replace(/[\\%_]/gu, '\\$&')
      values.push(escapedPath)
      conditions.push(`(path=$${values.length} OR path LIKE $${values.length} || '/%' ESCAPE '\\')`)
    }
    if (enclosing) {
      values.push(enclosing.path)
      const pathSlot = values.length
      values.push(enclosing.lineStart)
      const startSlot = values.length
      values.push(enclosing.lineEnd)
      conditions.push(`(path=$${pathSlot} AND line_start <= $${startSlot} AND line_end >= $${values.length})`)
    }
    if (language) {
      const normalized = languageValues(language)
      values.push(normalized.values)
      conditions.push(`${normalized.insensitive ? 'lower(language)' : 'language'}=ANY($${values.length}::text[])`)
    }
    const kindClause = sqlSourceKind('path', sourceKind)
    if (kindClause) conditions.push(kindClause)
    if (afterId) {
      values.push(afterId)
      if (!(await database.query(`SELECT 1 FROM zorya_code_symbols WHERE ${conditions.join(' AND ')} AND symbol_id=$${values.length} LIMIT 1`, values)).rows.length)
        throw new CodeIndexError('CODE_INDEX_SYMBOL_CURSOR_STALE')
      values.pop()
      values.push(afterId)
      const idSlot = values.length
      conditions.push(`(path,line_start,symbol_id) > (SELECT path,line_start,symbol_id FROM zorya_code_symbols WHERE snapshot_id=$1 AND analysis_profile_id=$2 AND symbol_id=$${idSlot})`)
    }
    values.push(limit + 1)
    const rows = await database.query<StoredSymbolRow>(
      `SELECT symbol_id,path,line_start,dto_json FROM zorya_code_symbols WHERE ${conditions.join(' AND ')}
       ORDER BY path,line_start,symbol_id LIMIT $${values.length}`,
      values,
    )
    await assertCurrent(input.root, current, input.signal)
    const truncated = rows.rows.length > limit
    const symbols = rows.rows.slice(0, limit).map((row) => row.dto_json)
    const last = rows.rows[Math.min(limit, rows.rows.length) - 1]
    const nextCursor = truncated && last ? encodeCursor({ v: CURSOR_VERSION, snapshot: current.snapshot,
      profile: analysis.profile.id, filters, id: last.symbol_id }) : null
    return { analysis, symbols, nextCursor, truncated }
  }

  async function findCodeReferences(input: FindCodeReferencesInput): Promise<FindCodeReferencesResult> {
    const limit = limitValue(input.limit, 50, 200)
    if (!/^[a-f0-9]{64}$/u.test(input.symbolId)) throw new CodeIndexError('CODE_INDEX_SYMBOL_ID_INVALID')
    if (input.direction !== undefined && input.direction !== 'incoming' && input.direction !== 'outgoing')
      throw new CodeIndexError('CODE_INDEX_SYMBOL_DIRECTION_INVALID')
    const direction = input.direction ?? 'incoming'
    if (input.kind !== undefined && !['reference', 'call', 'construct', 'export'].includes(input.kind))
      throw new CodeIndexError('CODE_INDEX_SYMBOL_KIND_INVALID')
    const filters = filterIdentity([input.symbolId, direction, input.kind ?? null])
    const { current, analysis } = await context(input.root, input.signal)
    if (analysis.state === 'not_indexed' || analysis.state === 'unavailable' || !analysis.profile) {
      await assertCurrent(input.root, current, input.signal)
      return { analysis, symbol: null, references: [], nextCursor: null, truncated: false }
    }
    const symbol = await readStoredSymbol(database, current.snapshot, analysis.profile.id, input.symbolId)
    if (!symbol) throw new CodeIndexError('CODE_INDEX_SYMBOL_NOT_FOUND')
    const afterId = decodeCursor(input.cursor, analysis, filters)
    const values: unknown[] = [current.snapshot, analysis.profile.id]
    const conditions = ['snapshot_id=$1', 'analysis_profile_id=$2']
    if (direction === 'outgoing') { values.push(input.symbolId); conditions.push(`owner_symbol_id=$${values.length}`) }
    else { values.push(JSON.stringify([input.symbolId])); conditions.push(`target_symbol_ids @> $${values.length}::jsonb`) }
    if (input.kind) { values.push(input.kind); conditions.push(`kind=$${values.length}`) }
    if (afterId) {
      values.push(afterId)
      if (!(await database.query(`SELECT 1 FROM zorya_code_symbol_references WHERE ${conditions.join(' AND ')} AND reference_id=$${values.length} LIMIT 1`, values)).rows.length)
        throw new CodeIndexError('CODE_INDEX_SYMBOL_CURSOR_STALE')
      values.pop()
      values.push(afterId)
      conditions.push(`(path,line_start,reference_id) > (SELECT path,line_start,reference_id FROM zorya_code_symbol_references WHERE snapshot_id=$1 AND analysis_profile_id=$2 AND reference_id=$${values.length})`)
    }
    values.push(limit + 1)
    const rows = await database.query<StoredReferenceRow>(
      `SELECT reference_id,path,line_start,dto_json FROM zorya_code_symbol_references WHERE ${conditions.join(' AND ')}
       ORDER BY path,line_start,reference_id LIMIT $${values.length}`,
      values,
    )
    await assertCurrent(input.root, current, input.signal)
    const truncated = rows.rows.length > limit
    const references = rows.rows.slice(0, limit).map((row) => row.dto_json)
    const last = rows.rows[Math.min(limit, rows.rows.length) - 1]
    return { analysis, symbol, references, truncated,
      nextCursor: truncated && last ? encodeCursor({ v: CURSOR_VERSION, snapshot: current.snapshot,
        profile: analysis.profile.id, filters, id: last.reference_id }) : null }
  }

  async function traceCodeCalls(input: TraceCodeCallsInput): Promise<CodeCallTrace> {
    const maxDepth = input.maxDepth ?? 2
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 4)
      throw new CodeIndexError('CODE_INDEX_SYMBOL_LIMIT_INVALID')
    const maxNodes = limitValue(input.maxNodes, 64, 256)
    const maxEdges = limitValue(input.maxEdges, 128, 1024)
    if (!/^[a-f0-9]{64}$/u.test(input.symbolId)) throw new CodeIndexError('CODE_INDEX_SYMBOL_ID_INVALID')
    const direction = input.direction ?? 'outgoing'
    if (!['incoming', 'outgoing', 'both'].includes(direction)) throw new CodeIndexError('CODE_INDEX_SYMBOL_DIRECTION_INVALID')
    const { current, analysis } = await context(input.root, input.signal)
    const base = { identity: current.identity, analysis, startSymbol: null as CodeSymbol | null,
      nodes: [] as CodeSymbol[], edges: [] as CodeSymbolReference[], reachedDepth: 0,
      limits: { depth: false, nodes: false, edges: false }, coverageComplete: analysis.complete }
    if (analysis.state === 'not_indexed' || analysis.state === 'unavailable' || !analysis.profile) {
      await assertCurrent(input.root, current, input.signal)
      return base
    }
    const start = await readStoredSymbol(database, current.snapshot, analysis.profile.id, input.symbolId)
    if (!start) throw new CodeIndexError('CODE_INDEX_SYMBOL_NOT_FOUND')
    base.startSymbol = start
    base.nodes = [start]
    const seenNodes = new Set([start.id])
    const seenEdges = new Set<string>()
    let frontier = [start.id]
    const hasAdjacentCalls = async (ids: string[]) => {
      if (!ids.length) return false
      const checks: Promise<{ rows: unknown[] }>[] = []
      if (direction !== 'incoming') checks.push(database.query(
        `SELECT 1 FROM zorya_code_symbol_references WHERE snapshot_id=$1 AND analysis_profile_id=$2
          AND kind IN ('call','construct') AND owner_symbol_id=ANY($3::text[]) LIMIT 1`,
        [current.snapshot, analysis.profile!.id, ids]))
      if (direction !== 'outgoing') checks.push(database.query(
        `SELECT 1 FROM zorya_code_symbol_references WHERE snapshot_id=$1 AND analysis_profile_id=$2
          AND kind IN ('call','construct') AND target_symbol_ids ?| $3::text[] LIMIT 1`,
        [current.snapshot, analysis.profile!.id, ids]))
      const results = await Promise.all(checks)
      return results.some((result) => result.rows.length > 0)
    }
    if (maxDepth === 0) base.limits.depth = await hasAdjacentCalls(frontier)
    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      check(input.signal)
      const directions = direction === 'both' ? ['outgoing', 'incoming'] as const : [direction]
      const perLevel = new Map<string, CodeSymbolReference>()
      for (const side of directions) {
        if (side === 'outgoing') {
          const result = await database.query<StoredReferenceRow>(
            `SELECT reference_id,path,line_start,dto_json FROM zorya_code_symbol_references
             WHERE snapshot_id=$1 AND analysis_profile_id=$2 AND kind IN ('call','construct') AND owner_symbol_id=ANY($3::text[])
             ORDER BY path,line_start,reference_id LIMIT $4`,
            [current.snapshot, analysis.profile.id, frontier, maxEdges - base.edges.length + 1],
          )
          for (const row of result.rows) perLevel.set(row.reference_id, row.dto_json)
        }
        if (side === 'incoming') {
          const result = await database.query<StoredReferenceRow>(
            `SELECT reference_id,path,line_start,dto_json FROM zorya_code_symbol_references
             WHERE snapshot_id=$1 AND analysis_profile_id=$2 AND kind IN ('call','construct')
               AND target_symbol_ids ?| $3::text[]
             ORDER BY path,line_start,reference_id LIMIT $4`,
            [current.snapshot, analysis.profile.id, frontier, maxEdges - base.edges.length + 1],
          )
          for (const row of result.rows) perLevel.set(row.reference_id, row.dto_json)
        }
      }
      let next: string[] = []
      for (const [edgeId, edge] of perLevel) {
        if (seenEdges.has(edgeId)) continue
        if (base.edges.length >= maxEdges) { base.limits.edges = true; break }
        seenEdges.add(edgeId); base.edges.push(edge)
        const adjacent = sideTargets(edge, frontier, direction)
        for (const id of adjacent) {
          if (seenNodes.has(id)) continue
          const symbol = await readStoredSymbol(database, current.snapshot, analysis.profile.id, id)
          if (!symbol) continue
          if (base.nodes.length >= maxNodes) { base.limits.nodes = true; continue }
          seenNodes.add(id); base.nodes.push(symbol); next.push(id)
        }
      }
      if (next.length) base.reachedDepth = depth
      frontier = [...new Set(next)]
      if (depth === maxDepth && frontier.length) base.limits.depth = await hasAdjacentCalls(frontier)
      if (base.limits.edges || base.limits.nodes) break
    }
    await assertCurrent(input.root, current, input.signal)
    base.coverageComplete = analysis.complete && !base.limits.depth && !base.limits.nodes && !base.limits.edges &&
      !analysis.unresolvedCallCount
    return base
  }
  return { findCodeSymbols, findCodeReferences, traceCodeCalls }
}

function sideTargets(edge: CodeSymbolReference, frontier: string[], direction: TraceCodeCallsInput['direction']): string[] {
  const incoming = edge.targetSymbolIds.some((id) => frontier.includes(id))
  const result: string[] = []
  if (direction !== 'incoming' && edge.ownerSymbolId && frontier.includes(edge.ownerSymbolId))
    result.push(...edge.targetSymbolIds)
  if (direction !== 'outgoing' && incoming && edge.ownerSymbolId) result.push(edge.ownerSymbolId)
  return result
}
