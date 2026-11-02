import type { CodeIndex, CodeSourceIdentity, CodeHit, CodeDependencyGraph, CodeDuplicatesResult } from '../code/types.js'
import type { FindCodeSymbolsResult, CodeSymbolAnalysisStatus } from '../code/symbol-api.js'
import type { JevAnswer, JevDecisionsPort } from '../providers/decision-types.js'
import type { QueryIntentResult } from '../providers/query-intent.js'
import type { CodeContextResult } from './code-context.js'

export type ReuseIndex = Pick<CodeIndex, 'indexStatus' | 'searchCode' | 'readSource' | 'relatedCode'> &
  Partial<Pick<CodeIndex, 'dependencyGraph' | 'findCodeSymbols' | 'findCodeReferences' | 'withReadSnapshot' | 'findCodeDuplicates'>>

export interface ReuseLimits {
  maxChars: number
  maxCandidates: number
  timeoutMs: number
}

export interface ReuseContextInput {
  root: string
  query: string
  signal?: AbortSignal
  maxChars?: number
  limit?: number
}

export interface ReuseFileCandidate {
  id: string
  path: string
  evidence: 'search-hit' | 'dependency-graph'
  symbols: Array<{ id: string; name: string; nameTruncated: boolean; qualifiedName: string; qualifiedNameTruncated: boolean; kind: string; lineStart: number; lineEnd: number; signature: string }>
  symbolCatalogue: string[]
  symbolCatalogueTotal: number
  symbolCatalogueOffered: number
  symbolCatalogueOmitted: number
  symbolCatalogueTruncatedNames: number
  symbolCatalogueIncomplete: boolean
  symbolPages: number
  symbolTruncated: boolean
}

export interface ReuseContextResult {
  identity: CodeSourceIdentity
  query: string
  context: CodeContextResult
  intent: { state: 'available'; result: QueryIntentResult } | { state: 'unavailable'; reason: string }
  candidates: { files: ReuseFileCandidate[]; hits: CodeHit[]; graph?: CodeDependencyGraph; graphState: 'available' | 'unsupported' | 'unavailable' }
  selection: {
    fileAnswers: Record<string, JevAnswer>
    fileAssessments: Array<{ path: string; candidateId: string; relevance: number | null; state: 'positive' | 'negative' | 'unresolved' | 'unassessed' | 'omitted'; reason?: string }>
    selectedFiles: string[]
    symbolAnswers: Record<string, JevAnswer>
    selected: Array<{ path: string; symbol: ReuseFileCandidate['symbols'][number] }>
    unassessed: Array<{ path: string; reason: string }>
  }
  /** Optional bounded Jev coverage for paged symbol assessment. */
  symbolSelection?: {
    files: Array<{
      path: string
      sourceSymbolsObserved: number
      choiceSymbolsAssessed: number
      choiceSymbolsUnassessed: number
      sourcePagesRead: number
      choicePagesPlanned: number
      choicePagesAttempted: number
      pageAnswers: JevAnswer[]
      finalAnswer?: JevAnswer
      state: string
      continuationCursor?: string
      continuationOmittedCount?: number
    }>
  }
  symbolAnalysis: Pick<CodeSymbolAnalysisStatus, 'state' | 'complete' | 'coverageTotalFiles' | 'coverageOmittedFiles' | 'coverageCounts' | 'truncation'> | null
  readCoverage: Array<{ path: string; symbolId: string; fileHash: string; status: 'full' | 'partial' | 'unavailable'; ranges: Array<{ lineStart: number; lineEnd: number }> }>
  duplicates: { state: 'available'; scope: string[]; result: CodeDuplicatesResult } | { state: 'unsupported' | 'unavailable'; scope: string[]; reason: string }
  omissions: string[]
  continuation: Array<{ path: string; symbolId?: string; lineStart?: number; lineEnd?: number; fileLineCount?: number; reason: string; cursor?: string; snapshotId?: string; fileHash?: string }>
}

export interface ReuseContextOptions {
  index: ReuseIndex
  decisions?: JevDecisionsPort
  limits?: Partial<ReuseLimits>
}

export type ReuseSymbolPage = FindCodeSymbolsResult
