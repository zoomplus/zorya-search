import { createHash } from 'node:crypto'
import type { QueryableDatabase } from '../storage/database.js'
import type { CodeSymbol, CodeSymbolReference, SymbolExtractionResult } from './symbol-types.js'
import type { CodeSymbolAnalysisProfile, CodeSymbolAnalysisStatus } from './symbol-api.js'
import { CodeIndexError } from './errors.js'
import { CODE_SYMBOL_EXTRACTOR_VERSION } from './symbol-types.js'
import ts from 'typescript'

export interface SymbolAnalysisLimits {
  maxFiles: number
  maxSymbols: number
  maxReferences: number
  tsconfigPath: string | null
}
export const DEFAULT_SYMBOL_LIMITS: Readonly<SymbolAnalysisLimits> = Object.freeze({
  maxFiles: 5_000,
  maxSymbols: 100_000,
  maxReferences: 500_000,
  tsconfigPath: null,
})

export function symbolProfile(
  result: SymbolExtractionResult,
  limits: SymbolAnalysisLimits,
): CodeSymbolAnalysisProfile {
  const normalizedLimits: SymbolAnalysisLimits = Object.freeze({
    maxFiles: limits.maxFiles,
    maxSymbols: limits.maxSymbols,
    maxReferences: limits.maxReferences,
    tsconfigPath: limits.tsconfigPath,
  })
  const profile = {
    extractorVersion: result.version,
    typescriptVersion: result.compiler.typescriptVersion,
    compilerOptionsHash: result.compiler.compilerOptionsHash,
    libraryProfileId: result.compiler.libraryProfileId,
    limits: normalizedLimits,
  }
  return Object.freeze({
    id: analysisProfileId(profile.extractorVersion, profile.typescriptVersion, profile.compilerOptionsHash,
      profile.libraryProfileId, normalizedLimits),
    ...profile,
  })
}

export function analysisProfileId(
  extractorVersion: string,
  typescriptVersion: string,
  compilerOptionsHash: string,
  libraryProfileId: string | null,
  limits: SymbolAnalysisLimits,
): string {
  return createHash('sha256').update(JSON.stringify([
    extractorVersion, typescriptVersion, compilerOptionsHash, libraryProfileId,
    limits.maxFiles, limits.maxSymbols, limits.maxReferences, limits.tsconfigPath,
  ])).digest('hex')
}

export async function persistSymbolAnalysis(
  tx: QueryableDatabase,
  snapshotId: string,
  result: SymbolExtractionResult,
  profile: CodeSymbolAnalysisProfile,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const found = await tx.query<{ analysis_profile_id: string; extractor_version: string; typescript_version: string;
    compiler_options_hash: string; library_profile_id: string | null; limits_json: SymbolAnalysisLimits;
    complete: boolean; truncation_json: SymbolExtractionResult['truncation'];
    symbol_count: number; reference_count: number }>(
    `SELECT analysis_profile_id,extractor_version,typescript_version,compiler_options_hash,library_profile_id,
      limits_json,complete,truncation_json,symbol_count,reference_count
     FROM zorya_code_analysis WHERE snapshot_id=$1 AND active FOR UPDATE`,
    [snapshotId],
  )
  if (found.rows[0]?.analysis_profile_id === profile.id) {
    const row = found.rows[0]!
    const limitsMatch = row.limits_json.maxFiles === profile.limits.maxFiles &&
      row.limits_json.maxSymbols === profile.limits.maxSymbols &&
      row.limits_json.maxReferences === profile.limits.maxReferences &&
      (row.limits_json.tsconfigPath ?? null) === profile.limits.tsconfigPath
    const graphMatches = row.complete === result.complete &&
      row.truncation_json.symbols === result.truncation.symbols &&
      row.truncation_json.references === result.truncation.references &&
      row.truncation_json.files === result.truncation.files &&
      Number(row.symbol_count) === result.symbols.length && Number(row.reference_count) === result.references.length
    if (row.extractor_version !== profile.extractorVersion || row.typescript_version !== profile.typescriptVersion ||
      row.compiler_options_hash !== profile.compilerOptionsHash || row.library_profile_id !== profile.libraryProfileId ||
      !limitsMatch || !graphMatches)
      throw new CodeIndexError('CODE_INDEX_SYMBOL_PROFILE_MISMATCH')
    return
  }
  const symbolIds = new Set(result.symbols.map((item) => item.id))
  if (symbolIds.size !== result.symbols.length || result.references.some((reference) =>
    reference.targetSymbolIds.some((id) => !symbolIds.has(id)) ||
    (reference.ownerSymbolId !== null && !symbolIds.has(reference.ownerSymbolId))))
    throw new TypeError('Symbol graph contains duplicate or dangling symbol IDs')
  await tx.query('UPDATE zorya_code_analysis SET active=false WHERE snapshot_id=$1 AND active', [snapshotId])
  await tx.query(
    `INSERT INTO zorya_code_analysis(snapshot_id,analysis_profile_id,extractor_version,typescript_version,
      compiler_options_hash,library_profile_id,limits_json,complete,truncation_json,file_coverage_json,
      symbol_count,reference_count,unresolved_reference_count,unresolved_call_count,indexed_at,active)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,now(),true)
     ON CONFLICT(snapshot_id,analysis_profile_id) DO UPDATE SET active=true`,
    [snapshotId, profile.id, profile.extractorVersion, profile.typescriptVersion,
      profile.compilerOptionsHash, profile.libraryProfileId, JSON.stringify(profile.limits), result.complete,
      JSON.stringify(result.truncation), JSON.stringify(result.files), result.symbols.length, result.references.length,
      result.references.filter((reference) => reference.targetKind === 'unresolved').length,
      result.references.filter((reference) => (reference.kind === 'call' || reference.kind === 'construct') &&
        reference.targetKind === 'unresolved').length],
  )
  const files = new Map(result.files.map((file) => [file.path, file.language]))
  for (let offset = 0; offset < result.symbols.length; offset += 64) {
    signal?.throwIfAborted()
    const batch = result.symbols.slice(offset, offset + 64)
    const values: unknown[] = [snapshotId, profile.id]
    const rows = batch.map((symbol, index) => {
      const base = 3 + index * 11
      const fields = [symbol.id, symbol.name, symbol.qualifiedName, symbol.kind, symbol.location.path,
        symbol.location.lineStart, symbol.location.lineEnd, symbol.location.fileHash,
        files.get(symbol.location.path) ?? 'unsupported', symbol.parentId, JSON.stringify(symbol)]
      values.push(...fields)
      return `($1,$2,${fields.map((_, field) => `$${base + field}`).join(',')}::jsonb)`
    })
    await tx.query(
      `INSERT INTO zorya_code_symbols(snapshot_id,analysis_profile_id,symbol_id,name,qualified_name,kind,path,
        line_start,line_end,file_hash,language,parent_symbol_id,dto_json) VALUES ${rows.join(',')} ON CONFLICT DO NOTHING`,
      values,
    )
  }
  for (let offset = 0; offset < result.references.length; offset += 64) {
    signal?.throwIfAborted()
    const batch = result.references.slice(offset, offset + 64)
    const values: unknown[] = [snapshotId, profile.id]
    const rows = batch.map((reference, index) => {
      const base = 3 + index * 10
      const fields = [reference.id, reference.kind, reference.from.path, reference.from.lineStart,
        reference.from.lineEnd, reference.ownerSymbolId, JSON.stringify(reference.targetSymbolIds),
        reference.targetKind, reference.unresolvedReason, JSON.stringify(reference)]
      values.push(...fields)
      return `($1,$2,${fields.map((_, field) => `$${base + field}${field === 6 || field === 9 ? '::jsonb' : ''}`).join(',')})`
    })
    await tx.query(
      `INSERT INTO zorya_code_symbol_references(snapshot_id,analysis_profile_id,reference_id,kind,path,
        line_start,line_end,owner_symbol_id,target_symbol_ids,target_kind,unresolved_reason,dto_json)
       VALUES ${rows.join(',')} ON CONFLICT DO NOTHING`,
      values,
    )
  }
  await tx.query(
    `DELETE FROM zorya_code_analysis WHERE snapshot_id=$1 AND analysis_profile_id<>$2 AND analysis_profile_id NOT IN
     (SELECT analysis_profile_id FROM zorya_code_analysis WHERE snapshot_id=$1 AND analysis_profile_id<>$2
      ORDER BY indexed_at DESC LIMIT 1)`,
    [snapshotId, profile.id],
  )
}

export async function claimSymbolRefresh(
  database: QueryableDatabase,
  worktreeId: string,
  snapshotId: string,
  signal?: AbortSignal,
): Promise<number> {
  return database.transaction(async (tx) => {
    signal?.throwIfAborted()
    await tx.query(
      `INSERT INTO zorya_code_analysis_state(worktree_id,snapshot_id,generation,current_profile_id)
       VALUES($1,$2,0,NULL) ON CONFLICT(worktree_id) DO NOTHING`, [worktreeId, snapshotId])
    const state = await tx.query<{ snapshot_id: string; generation: string | number }>(
      'SELECT snapshot_id,generation FROM zorya_code_analysis_state WHERE worktree_id=$1 FOR UPDATE', [worktreeId])
    const base = await tx.query<{ current_snapshot: string | null }>(
      'SELECT current_snapshot FROM zorya_code_worktrees WHERE worktree_id=$1 FOR UPDATE', [worktreeId])
    if (base.rows[0]?.current_snapshot !== snapshotId) throw new CodeIndexError('CODE_INDEX_STALE')
    const generation = Number(state.rows[0]?.generation ?? 0) + 1
    await tx.query(
      `INSERT INTO zorya_code_analysis_state(worktree_id,snapshot_id,generation,current_profile_id)
       VALUES($1,$2,$3,NULL) ON CONFLICT(worktree_id) DO UPDATE SET
       snapshot_id=EXCLUDED.snapshot_id,generation=EXCLUDED.generation,
       current_profile_id=CASE WHEN zorya_code_analysis_state.snapshot_id=EXCLUDED.snapshot_id
         THEN zorya_code_analysis_state.current_profile_id ELSE NULL END,updated_at=now()`,
      [worktreeId, snapshotId, generation],
    )
    return generation
  }, signal)
}

export async function publishSymbolRefresh(
  database: QueryableDatabase,
  worktreeId: string,
  snapshotId: string,
  generation: number,
  result: SymbolExtractionResult,
  profile: CodeSymbolAnalysisProfile,
  signal?: AbortSignal,
  validateSource?: () => Promise<void>,
): Promise<void> {
  await database.transaction(async (tx) => {
    signal?.throwIfAborted()
    const state = await tx.query<{ snapshot_id: string; generation: string | number }>(
      'SELECT snapshot_id,generation FROM zorya_code_analysis_state WHERE worktree_id=$1 FOR UPDATE', [worktreeId])
    const base = await tx.query<{ current_snapshot: string | null }>(
      'SELECT current_snapshot FROM zorya_code_worktrees WHERE worktree_id=$1 FOR UPDATE', [worktreeId])
    if (state.rows[0]?.snapshot_id !== snapshotId || Number(state.rows[0]?.generation) !== generation ||
      base.rows[0]?.current_snapshot !== snapshotId)
      throw new CodeIndexError('CODE_INDEX_STALE_GENERATION')
    await validateSource?.()
    signal?.throwIfAborted()
    await persistSymbolAnalysis(tx, snapshotId, result, profile, signal)
    await tx.query(
      `UPDATE zorya_code_analysis_state SET current_profile_id=$3,updated_at=now()
       WHERE worktree_id=$1 AND snapshot_id=$2 AND generation=$4`,
      [worktreeId, snapshotId, profile.id, generation],
    )
  }, signal)
}

export async function publishIndexedSymbolAnalysis(
  tx: QueryableDatabase,
  worktreeId: string,
  snapshotId: string,
  result: SymbolExtractionResult,
  profile: CodeSymbolAnalysisProfile,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const state = await tx.query<{ generation: string | number }>(
    'SELECT generation FROM zorya_code_analysis_state WHERE worktree_id=$1 FOR UPDATE', [worktreeId])
  const generation = Number(state.rows[0]?.generation ?? 0) + 1
  await tx.query(
    `INSERT INTO zorya_code_analysis_state(worktree_id,snapshot_id,generation,current_profile_id)
     VALUES($1,$2,$3,$4) ON CONFLICT(worktree_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,
     generation=EXCLUDED.generation,current_profile_id=EXCLUDED.current_profile_id,updated_at=now()`,
    [worktreeId, snapshotId, generation, profile.id],
  )
  await persistSymbolAnalysis(tx, snapshotId, result, profile, signal)
}

export async function loadSymbolAnalysis(
  database: QueryableDatabase,
  identity: CodeSymbolAnalysisStatus['identity'],
  worktreeId: string,
): Promise<CodeSymbolAnalysisStatus> {
  const selected = await database.query<{
    analysis_profile_id: string; extractor_version: string; typescript_version: string;
    compiler_options_hash: string; library_profile_id: string | null; limits_json: SymbolAnalysisLimits;
    complete: boolean; truncation_json: CodeSymbolAnalysisStatus['truncation'];
    file_coverage_json: Array<CodeSymbolAnalysisStatus['coverage'][number]>; symbol_count: number;
    reference_count: number; unresolved_reference_count: number; unresolved_call_count: number; indexed_at: string | Date;
  }>(
    `SELECT a.analysis_profile_id,a.extractor_version,a.typescript_version,a.compiler_options_hash,a.library_profile_id,
      a.limits_json,a.complete,a.truncation_json,a.file_coverage_json,a.symbol_count,a.reference_count,
      a.unresolved_reference_count,a.unresolved_call_count,a.indexed_at
     FROM zorya_code_analysis_state s JOIN zorya_code_analysis a
       ON a.snapshot_id=s.snapshot_id AND a.analysis_profile_id=s.current_profile_id
     WHERE s.worktree_id=$1 AND s.snapshot_id=$2 AND a.active=true`,
    [worktreeId, identity.snapshotId],
  )
  const row = selected.rows[0]
  if (!row) return { state: 'not_indexed', identity, profile: null, complete: false, coverage: [],
    coverageTotalFiles: 0, coverageOmittedFiles: 0,
    coverageCounts: { parsed: 0, parseError: 0, unsupported: 0, truncated: 0, error: 0 },
    unresolvedReferenceCount: 0, unresolvedCallCount: 0,
    truncation: { symbols: false, references: false, files: false }, symbolCount: 0, referenceCount: 0, indexedAt: null }
  const normalizedLimits: SymbolAnalysisLimits = Object.freeze({ maxFiles: Number(row.limits_json.maxFiles),
    maxSymbols: Number(row.limits_json.maxSymbols), maxReferences: Number(row.limits_json.maxReferences),
    tsconfigPath: row.limits_json.tsconfigPath ?? null })
  const profile = Object.freeze({ id: row.analysis_profile_id, extractorVersion: row.extractor_version,
    typescriptVersion: row.typescript_version, compilerOptionsHash: row.compiler_options_hash,
    libraryProfileId: row.library_profile_id, limits: normalizedLimits })
  const profileIntegrity = profile.id === analysisProfileId(profile.extractorVersion, profile.typescriptVersion,
    profile.compilerOptionsHash, profile.libraryProfileId, normalizedLimits)
  const fullCoverage = row.file_coverage_json
  const coverage = fullCoverage.slice(0, 50).map((file) => ({ ...file,
    diagnostics: file.diagnostics.slice(0, 5).map((diagnostic) => diagnostic.slice(0, 512)) }))
  const coverageCounts = {
    parsed: fullCoverage.filter((file) => file.status === 'parsed').length,
    parseError: fullCoverage.filter((file) => file.status === 'parse-error').length,
    unsupported: fullCoverage.filter((file) => file.status === 'unsupported').length,
    truncated: fullCoverage.filter((file) => file.status === 'truncated').length,
    error: fullCoverage.filter((file) => file.status === 'error').length,
  }
  const compatible = profileIntegrity && row.extractor_version === CODE_SYMBOL_EXTRACTOR_VERSION &&
    row.typescript_version === ts.version && JSON.stringify({
      maxFiles: normalizedLimits.maxFiles, maxSymbols: normalizedLimits.maxSymbols,
      maxReferences: normalizedLimits.maxReferences, tsconfigPath: normalizedLimits.tsconfigPath,
    }) === JSON.stringify(DEFAULT_SYMBOL_LIMITS)
  if (!compatible) return { state: 'unavailable', unavailableReason: 'profile_outdated', identity, profile,
    complete: false, coverage, coverageTotalFiles: fullCoverage.length,
    coverageOmittedFiles: Math.max(0, fullCoverage.length - coverage.length),
    coverageCounts,
    unresolvedReferenceCount: Number(row.unresolved_reference_count),
    unresolvedCallCount: Number(row.unresolved_call_count), truncation: row.truncation_json,
    symbolCount: Number(row.symbol_count), referenceCount: Number(row.reference_count),
    indexedAt: new Date(row.indexed_at).toISOString() }
  return { state: row.complete ? 'indexed' : 'partial', identity, profile, complete: row.complete,
    coverage, coverageTotalFiles: fullCoverage.length, coverageOmittedFiles: Math.max(0, fullCoverage.length - coverage.length),
    coverageCounts,
    unresolvedReferenceCount: Number(row.unresolved_reference_count),
    unresolvedCallCount: Number(row.unresolved_call_count), truncation: row.truncation_json,
    symbolCount: Number(row.symbol_count), referenceCount: Number(row.reference_count),
    indexedAt: new Date(row.indexed_at).toISOString() }
}

export async function readStoredSymbol(
  database: QueryableDatabase,
  snapshotId: string,
  profileId: string,
  id: string,
): Promise<CodeSymbol | null> {
  const result = await database.query<{ dto_json: CodeSymbol }>(
    'SELECT dto_json FROM zorya_code_symbols WHERE snapshot_id=$1 AND analysis_profile_id=$2 AND symbol_id=$3',
    [snapshotId, profileId, id],
  )
  return result.rows[0]?.dto_json ?? null
}

export type StoredSymbolRow = { dto_json: CodeSymbol; symbol_id: string; path: string; line_start: number }
export type StoredReferenceRow = { dto_json: CodeSymbolReference; reference_id: string; path: string; line_start: number }
