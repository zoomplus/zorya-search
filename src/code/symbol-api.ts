import type { CodeSourceIdentity } from './types.js'
import type { CodeSymbol, CodeSymbolReference, SymbolFileCoverage } from './symbol-types.js'
export type { CodeSymbol, CodeSymbolReference, SymbolFileCoverage, ReferenceKind } from './symbol-types.js'

export interface CodeSymbolAnalysisProfile {
  id: string
  extractorVersion: string
  typescriptVersion: string
  compilerOptionsHash: string
  libraryProfileId: string | null
  limits: { maxFiles: number; maxSymbols: number; maxReferences: number; tsconfigPath: string | null }
}
export interface CodeSymbolAnalysisStatus {
  state: 'indexed' | 'not_indexed' | 'partial' | 'unavailable'
  unavailableReason?: 'profile_outdated'
  identity: CodeSourceIdentity
  profile: CodeSymbolAnalysisProfile | null
  complete: boolean
  coverage: SymbolFileCoverage[]
  coverageTotalFiles: number
  coverageOmittedFiles: number
  coverageCounts: {
    parsed: number; parseError: number; unsupported: number; truncated: number; error: number
  }
  unresolvedReferenceCount: number
  unresolvedCallCount: number
  truncation: { symbols: boolean; references: boolean; files: boolean }
  symbolCount: number
  referenceCount: number
  indexedAt: string | null
}
export interface FindCodeSymbolsInput {
  root: string
  query?: string
  name?: string
  path?: string
  language?: string
  sourceKind?: 'implementation' | 'tests' | 'documentation' | 'all'
  limit?: number
  cursor?: string
  signal?: AbortSignal
}
export interface FindCodeSymbolsResult {
  analysis: CodeSymbolAnalysisStatus
  symbols: CodeSymbol[]
  nextCursor: string | null
  truncated: boolean
}
export interface FindCodeReferencesInput {
  root: string
  symbolId: string
  direction?: 'incoming' | 'outgoing'
  kind?: CodeSymbolReference['kind']
  limit?: number
  cursor?: string
  signal?: AbortSignal
}
export interface FindCodeReferencesResult {
  analysis: CodeSymbolAnalysisStatus
  symbol: CodeSymbol | null
  references: CodeSymbolReference[]
  nextCursor: string | null
  truncated: boolean
}
export interface TraceCodeCallsInput {
  root: string
  symbolId: string
  direction?: 'incoming' | 'outgoing' | 'both'
  maxDepth?: number
  maxNodes?: number
  maxEdges?: number
  signal?: AbortSignal
}
export interface CodeCallTrace {
  identity: CodeSourceIdentity
  analysis: CodeSymbolAnalysisStatus
  startSymbol: CodeSymbol | null
  nodes: CodeSymbol[]
  edges: CodeSymbolReference[]
  reachedDepth: number
  limits: { depth: boolean; nodes: boolean; edges: boolean }
  coverageComplete: boolean
}
