import type { QueryableDatabase } from '../storage/database.js'

export type ProjectTextKind = 'rules' | 'skills' | 'documentation'
export interface ProjectTextEmbeddingProvider {
  profile: Readonly<{
    provider: string
    space: string
    model: string
    dimensions?: number
    inputType?: string
    profileId?: string
    routing?: Readonly<Record<string, unknown>>
  }>
  embed(input: { texts: string[]; signal: AbortSignal }): Promise<number[][]>
}
export interface ProjectTextOptions {
  database: QueryableDatabase
  documentEmbedding?: ProjectTextEmbeddingProvider
  queryEmbedding?: ProjectTextEmbeddingProvider
  reranker?: {
    rerank(input: {
      query: string
      documents: string[]
      topN?: number
      signal: AbortSignal
    }): Promise<{ index: number; score: number }[]>
  }
  rerankCandidateLimit?: number
  exclude?: string[]
  limits?: Partial<{
    maxFiles: number
    maxFileBytes: number
    maxTotalBytes: number
    maxChunks: number
    maxChunkChars: number
  }>
}
export interface ProjectTextChunk {
  id: string
  path: string
  kind: ProjectTextKind
  title: string | null
  heading: string[]
  lineStart: number
  lineEnd: number
  text: string
  contentHash: string
}
export interface ProjectTextSourceIdentity {
  repoId: string
  worktreeId: string
  root: string
  branch: string | null
  head: string | null
  snapshotId: string
  contentHash: string
}
export interface ProjectTextHit extends Omit<ProjectTextChunk, 'text'> {
  snapshotId: string
  fileContentHash: string
  score: number
  excerpt: string
  truncated: boolean
}
export interface ProjectTextIndexResult {
  identity: ProjectTextSourceIdentity
  snapshotId: string
  fileCount: number
  chunkCount: number
  treeHash: string
  profileId: string | null
}
export interface ProjectTextIndexStatus {
  identity: ProjectTextSourceIdentity | null
  snapshotId: string | null
  indexedAt: string | null
  fileCount: number
  chunkCount: number
  stale: boolean
}
export interface ProjectTextSearchInput {
  root: string
  query: string
  kinds?: ProjectTextKind[]
  paths?: string[]
  limit?: number
  mode?: 'lexical' | 'hybrid'
  maxChars?: number
  signal?: AbortSignal
}
export interface ProjectTextRerankStatus {
  status: 'complete' | 'incomplete' | 'empty'
  requested: number
  returned: number
}
export interface ProjectTextReadInput {
  root: string
  path: string
  lineStart?: number
  lineEnd?: number
  snapshotId?: string
  signal?: AbortSignal
}
export interface ProjectTextReadResult {
  identity: ProjectTextSourceIdentity
  path: string
  snapshotId: string
  lineStart: number
  lineEnd: number
  text: string
  contentHash: string
  truncated: boolean
}
export interface ProjectTextIndex {
  indexRepository(input: {
    root: string
    signal?: AbortSignal
    onProgress?: (progress: { files: number; chunks: number }) => void
  }): Promise<ProjectTextIndexResult>
  indexStatus(root: string, signal?: AbortSignal): Promise<ProjectTextIndexStatus>
  searchProjectText(input: ProjectTextSearchInput): Promise<{
    identity: ProjectTextSourceIdentity
    snapshotId: string
    hits: ProjectTextHit[]
    truncated: boolean
    degradation?: string
    rerank?: ProjectTextRerankStatus
  }>
  readProjectText(input: ProjectTextReadInput): Promise<ProjectTextReadResult>
  sourceFingerprint(root: string, signal?: AbortSignal): Promise<string>
  close(): Promise<void>
}
