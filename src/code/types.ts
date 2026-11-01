import type { SearchModels } from '../core/contracts.js'
import type { QueryableDatabase } from '../storage/database.js'

export interface CodeIndexModels {
  embed: SearchModels['embed']
  rerank?: SearchModels['rerank']
}

export interface CodeEmbeddingProfile {
  provider: string
  space: string
  model: string
  dimensions: number
  inputType: 'text'
  chunkerVersion: string
}

export interface CodeIndexLimits {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
  maxChunks: number
  maxChunkChars: number
  maxQueryChars: number
  maxScanChunks: number
  maxResults: number
}

export interface CodeIndexOptions {
  database: QueryableDatabase
  models?: CodeIndexModels
  profile?: CodeEmbeddingProfile
  limits?: Partial<CodeIndexLimits>
  exclude?: string[]
  rerankCandidateLimit?: number
  beforeSourceFingerprint?: (signal: AbortSignal) => Promise<void>
}

export interface CodeSourceIdentity {
  repoId: string
  worktreeId: string
  root: string
  branch: string | null
  head: string | null
  snapshotId: string
  contentHash: string
}

export interface CodeChunk {
  id: string
  path: string
  lineStart: number
  lineEnd: number
  symbol: string | null
  language: string
  text: string
  contentHash: string
  parserVersion: string
}

export interface CodeHit extends Omit<CodeChunk, 'text' | 'parserVersion'> {
  repoId: string
  worktreeId: string
  branch: string | null
  head: string | null
  snapshotId: string
  profileId: string | null
  score: number
  ranking: {
    mode: 'lexical' | 'hybrid'
    lexicalRank: number | null
    denseRank: number | null
    rerankRank: number | null
    degradedReason?: string
  }
}

export interface CodeSearchInput {
  root: string
  query: string
  paths?: string[]
  language?: string
  sourceKind?: 'implementation' | 'tests' | 'documentation' | 'all'
  limit?: number
  mode?: 'lexical' | 'hybrid'
  signal?: AbortSignal
}

export interface CodeDuplicatesInput {
  root: string
  paths?: string[]
  language?: string
  sourceKind?: 'implementation' | 'tests' | 'documentation' | 'all'
  matchMode?: 'exact' | 'renamed'
  minTokens?: number
  minOccurrences?: number
  limit?: number
  maxOccurrencesPerGroup?: number
  signal?: AbortSignal
}

export interface CodeDuplicateOccurrence {
  path: string
  symbol: string
  kind: string
  lineStart: number
  lineEnd: number
  fileContentHash: string
  signature: string
  bodyTokenCount: number
}

export interface CodeDuplicateGroup {
  matchKind: 'exact-token-body' | 'renamed-local-body'
  occurrences: CodeDuplicateOccurrence[]
  occurrenceCount: number
  tokenCount: number
}

export interface CodeDuplicatesResult {
  identity: CodeSourceIdentity
  supportedLanguages: string[]
  groups: CodeDuplicateGroup[]
  counts: {
    scannedFiles: number
    indexedFiles: number
    eligibleFiles: number
    parsedFiles: number
    functions: number
    skippedParse: number
    skippedOversize: number
    skippedUnsupported: number
  }
  truncation: {
    groups: boolean
    occurrences: boolean
    scan: boolean
    complete: boolean
  }
}

export interface CodeIndexStatus {
  identity: CodeSourceIdentity | null
  indexedAt: string | null
  fileCount: number
  chunkCount: number
  profileId: string | null
  denseAvailable: boolean
  denseDisabledReason: string | null
}

export interface CodeIndexProgress {
  snapshotId: string
  totalChunks: number
  checkpointChunks: number
  checkpointWrites: number
}

export interface CodeReadInput {
  root: string
  path: string
  lineStart?: number
  lineEnd?: number
  snapshotId?: string
  signal?: AbortSignal
}

export interface CodeReadResult {
  path: string
  lineStart: number
  lineEnd: number
  text: string
  contentHash: string
  snapshotId: string
  stale: boolean
}

export interface CodeRelatedInput {
  root: string
  path: string
  symbol?: string
  limit?: number
  signal?: AbortSignal
}

export interface CodeDependencyGraphInput {
  root: string
  seeds: string[]
  maxDepth?: number
  maxNodes?: number
  maxEdges?: number
  signal?: AbortSignal
}

export interface CodeDependencyGraphNode {
  path: string
  depth: number
  seed: string
  parent: string | null
  relation: 'seed' | 'imports' | 'importedBy'
}

export interface CodeDependencyGraphEdge {
  from: string
  to: string
  direction: 'imports' | 'importedBy'
}

export interface CodeDependencyGraph {
  identity: CodeSourceIdentity
  seeds: string[]
  nodes: CodeDependencyGraphNode[]
  edges: CodeDependencyGraphEdge[]
  requestedDepth: number
  reachedDepth: number
  limits: { depth: boolean; nodes: boolean; edges: boolean }
}

export interface CodeWatchHandle {
  close(): Promise<void>
}

export interface CodeIndex {
  indexRepository(input: { root: string; signal?: AbortSignal; onProgress?: (progress: CodeIndexProgress) => void }): Promise<CodeIndexStatus>
  sourceFingerprint(root: string, signal?: AbortSignal): Promise<string>
  searchCode(input: CodeSearchInput): Promise<{
    hits: CodeHit[]
    identity: CodeSourceIdentity
    degraded: boolean
    degradedReason: string | null
  }>
  findCodeDuplicates?(input: CodeDuplicatesInput): Promise<CodeDuplicatesResult>
  indexStatus(root: string, signal?: AbortSignal): Promise<CodeIndexStatus>
  readSource(input: CodeReadInput): Promise<CodeReadResult>
  relatedCode(input: CodeRelatedInput): Promise<{
    identity: CodeSourceIdentity
    imports: string[]
    importedBy: string[]
    similar: CodeHit[]
    stale: boolean
  }>
  dependencyGraph?(input: CodeDependencyGraphInput): Promise<CodeDependencyGraph>
  withReadSnapshot?<T>(
    root: string,
    signal: AbortSignal,
    work: (
      index: Pick<CodeIndex, 'indexStatus' | 'searchCode' | 'readSource' | 'relatedCode'> &
        Partial<Pick<CodeIndex, 'dependencyGraph'>>,
    ) => Promise<T>,
  ): Promise<T>
  watchRepository(
    root: string,
    options?: { signal?: AbortSignal; intervalMs?: number; onError?: (code: string) => void },
  ): Promise<CodeWatchHandle>
  close(): Promise<void>
}

export type CodeIndexDatabase = QueryableDatabase
