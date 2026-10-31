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
  limit?: number
  mode?: 'lexical' | 'hybrid'
  signal?: AbortSignal
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

export interface CodeWatchHandle {
  close(): Promise<void>
}

export interface CodeIndex {
  indexRepository(input: { root: string; signal?: AbortSignal }): Promise<CodeIndexStatus>
  searchCode(
    input: CodeSearchInput,
  ): Promise<{
    hits: CodeHit[]
    identity: CodeSourceIdentity
    degraded: boolean
    degradedReason: string | null
  }>
  indexStatus(root: string, signal?: AbortSignal): Promise<CodeIndexStatus>
  readSource(input: CodeReadInput): Promise<CodeReadResult>
  relatedCode(
    input: CodeRelatedInput,
  ): Promise<{
    identity: CodeSourceIdentity
    imports: string[]
    importedBy: string[]
    similar: CodeHit[]
    stale: boolean
  }>
  watchRepository(
    root: string,
    options?: { signal?: AbortSignal; intervalMs?: number; onError?: (code: string) => void },
  ): Promise<CodeWatchHandle>
  close(): Promise<void>
}

export type CodeIndexDatabase = QueryableDatabase
