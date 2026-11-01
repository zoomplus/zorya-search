export type LogicalContextState = 'available' | 'partial' | 'not_indexed' | 'unavailable' | 'unsupported'

export type LogicalBlockRole = 'seed_definition' | 'contract' | 'caller' | 'callee' | 'test' | 'source_fallback'

export interface LogicalRange {
  path: string
  lineStart: number
  lineEnd: number
}

export interface LogicalContinuation extends LogicalRange {
  snapshotId: string
}

export interface LogicalContextBlock {
  symbolId: string | null
  name: string | null
  kind: string | null
  role: LogicalBlockRole
  source: LogicalRange
  complete: boolean
  includedRanges: LogicalRange[]
  relationFrom: string | null
  relationKind: 'seed' | 'reference' | 'call' | 'construct' | 'test_reference' | 'test_call'
  depth: number
  wholeFile: boolean
}

export type LogicalOmissionReason =
  | 'no_enclosing_symbol'
  | 'source_filter'
  | 'budget'
  | 'read_limit'
  | 'block_limit'
  | 'symbol_limit'
  | 'reference_limit'
  | 'external'
  | 'unresolved'
  | 'ambiguous'
  | 'missing_target'

export interface LogicalContextOmission {
  symbolId: string | null
  role: LogicalBlockRole | null
  range: LogicalRange | null
  reason: LogicalOmissionReason
  continuation: LogicalContinuation | null
}

export interface LogicalContextResult {
  state: LogicalContextState
  profileId: string | null
  analysisComplete: boolean
  coverage: {
    totalFiles: number
    omittedFiles: number
    counts: { parsed: number; parseError: number; unsupported: number; truncated: number; error: number }
    unresolvedReferences: number
    unresolvedCalls: number
    truncation: { symbols: boolean; references: boolean; files: boolean }
  } | null
  blocks: LogicalContextBlock[]
  omissions: LogicalContextOmission[]
  omissionsOmitted: number
  omissionsTruncated: boolean
  limits: {
    maxSeeds: 8
    seedsInspected: number
    seedsTruncated: boolean
    maxReferencesPerSeed: 50
    referencesInspected: number
    maxBlocks: 24
    blocksSelected: number
    maxSourceReads: 120
    sourceReads: number
    maxRangeLines: number
    referencesTruncated: boolean
    symbolsTruncated: boolean
    blocksTruncated: boolean
    readsTruncated: boolean
  }
  relationCoverage: 'static_and_bounded' | 'no_proven_relation' | 'unavailable'
  runtimeCallCoverage: 'not_claimed'
}
