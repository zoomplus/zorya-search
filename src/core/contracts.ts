import { legacyUuidSchema } from './identifiers.js'
import { z } from 'zod'

export const searchRequestSchema = z.object({
  query: z.string().min(1).max(4000),
  context: z.string().max(20000).default(''),
  language: z.string().min(2).max(12).default('ru'),
  game: z.string().max(300).optional(),
  gameVersion: z.string().max(120).optional(),
  freshness: z
    .object({
      after: z.string().datetime().optional(),
      latest: z.boolean().default(false),
      explanation: z.string().max(2000).optional(),
    })
    .optional(),
  targetSources: z.number().int().min(1).max(200).default(100),
  maxAttempts: z.number().int().min(1).max(300).default(300),
  concurrency: z.number().int().min(1).max(6).default(6),
  collectionTimeoutMs: z.number().int().positive().max(120000).default(120000),
})
export type SearchRequest = z.infer<typeof searchRequestSchema>
export type SearchInput = z.input<typeof searchRequestSchema>
export const documentSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  text: z.string().min(1),
  fetchedAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable().default(null),
  sourceUpdatedAt: z.string().datetime().nullable().default(null),
  gameVersion: z.string().nullable().optional(),
  language: z.string().min(2).max(35).optional(),
})
export type SourceDocument = z.infer<typeof documentSchema>
export const passageSchema = z.object({
  id: z.string(),
  sourceId: legacyUuidSchema.optional(),
  versionId: legacyUuidSchema.optional(),
  ordinal: z.number().refine(Number.isInteger).nonnegative().optional(),
  indexedAt: z.string().datetime().nullable().optional(),
  url: z.string().url(),
  title: z.string(),
  excerpt: z.string(),
  score: z.number().finite(),
  addedAt: z.string().datetime(),
  fetchedAt: z.string().datetime(),
  lastCheckedAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable(),
  sourceUpdatedAt: z.string().datetime().nullable(),
  game: z.string().nullable().optional(),
  gameVersion: z.string().nullable().optional(),
  language: z.string().optional(),
})
export type Passage = z.infer<typeof passageSchema>
export type SearchResult = z.infer<typeof searchResultSchema>
export interface SearchModels {
  embed(input: { texts: string[]; signal: AbortSignal }): Promise<number[][]>
  rerank(input: {
    query: string
    documents: string[]
    signal: AbortSignal
  }): Promise<{ index: number; score: number }[]>
  judgeCache(input: {
    request: SearchRequest
    passages: Passage[]
    signal: AbortSignal
  }): Promise<number>
}
export interface KnowledgeRepository {
  retrieve(
    query: string,
    vector: number[],
    space: string,
    limit: number,
    filter?: { game?: string; gameVersion?: string | null; language?: string },
  ): Promise<Passage[]>
  save(
    documents: SourceDocument[],
    chunks: { documentIndex: number; text: string; vector: number[] }[],
    metadata: {
      space: string
      game?: string
      gameVersion?: string
      language: string
      query?: SearchRequest
    },
    signal: AbortSignal,
  ): Promise<void>
  recordQuery(request: SearchRequest, result: SearchResult): Promise<void>
  deleteKnowledge?(input: KnowledgeDeleteInput, signal: AbortSignal): Promise<KnowledgeDeleteResult>
  collectTemporary?(input: { before: string; limit: number }, signal: AbortSignal): Promise<number>
}
export interface WebSource {
  discover(query: string, target: number, signal: AbortSignal): Promise<string[]>
  fetchDocument(url: string, signal: AbortSignal): Promise<SourceDocument>
}
export type SearchStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'
export type SearchJobSnapshot = z.infer<typeof searchJobSnapshotSchema>
export const embeddingSchema = z.array(z.array(z.number().finite()).min(1)).min(1)

export const searchCollectionErrorSchema = z
  .object({
    stage: z.enum(['discovery', 'document']).optional(),
    url: z.string().optional(),
    queryIndex: z.number().refine(Number.isInteger).nonnegative().optional(),
    code: z.string(),
  })
  .strict()
export type SearchCollectionError = z.infer<typeof searchCollectionErrorSchema>
export const searchResultSchema = z.object({
  origin: z.enum(['database', 'web']),
  passages: z.array(passageSchema),
  collected: z.number().refine(Number.isInteger).nonnegative(),
  attempted: z.number().refine(Number.isInteger).nonnegative(),
  partial: z.boolean(),
  errors: z.array(searchCollectionErrorSchema),
  cacheScore: z.number().min(0).max(1),
})
export const searchJobSnapshotSchema = z.object({
  id: legacyUuidSchema,
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  result: searchResultSchema.optional(),
  error: z.string().optional(),
})
export const searchLegacyEventSchema = z.object({
  jobId: legacyUuidSchema,
  sequence: z.number().refine(Number.isInteger).positive(),
  type: z.enum(['started', 'cache', 'collected', 'indexed', 'finished', 'failed', 'cancelled']),
  detail: z.record(z.string(), z.unknown()),
})
export type SearchLegacyEvent = z.infer<typeof searchLegacyEventSchema>

/** Retrieve limit for cache/indexing candidates (see `executeSearch`). */
export const SEARCH_PROGRESS_CANDIDATE_COUNT_MAX = 40
/** Upper bound on `buildSearchQueries` facets (1 base + locale + optional game). */
export const SEARCH_PROGRESS_QUERY_COUNT_MAX = 16
export const SEARCH_PROGRESS_QUERY_INDEX_MAX = SEARCH_PROGRESS_QUERY_COUNT_MAX - 1
/** Brave discovery batch cap in `collectSources`. */
export const SEARCH_PROGRESS_DISCOVERED_COUNT_MAX = 200
export const SEARCH_PROGRESS_ATTEMPTED_MAX = 300
export const SEARCH_PROGRESS_COLLECTED_MAX = 200
export const SEARCH_PROGRESS_DOCUMENT_COUNT_MAX = 200
/**
 * Worst-case chunk count: 200 documents × chunks per doc at 8_000_000 chars with
 * chunker `chunks4000-overlap300` (step 3700) → 1 + ceil((8_000_000 − 4000) / 3700) = 2163 → 432_600.
 */
export const SEARCH_PROGRESS_CHUNK_COUNT_MAX = 432_600

const searchProgressCacheStartedSchema = z
  .object({ stage: z.literal('cache'), state: z.literal('started') })
  .strict()
const searchProgressCacheCompletedSchema = z
  .object({
    stage: z.literal('cache'),
    state: z.literal('completed'),
    candidateCount: z.number().int().nonnegative().max(SEARCH_PROGRESS_CANDIDATE_COUNT_MAX),
    score: z.number().min(0).max(1),
    threshold: z.number().min(0).max(1),
    sufficient: z.boolean(),
  })
  .strict()
const searchProgressDiscoveryStartedSchema = z
  .object({
    stage: z.literal('discovery'),
    state: z.literal('started'),
    queryIndex: z.number().int().nonnegative().max(SEARCH_PROGRESS_QUERY_INDEX_MAX),
    queryCount: z.number().int().positive().max(SEARCH_PROGRESS_QUERY_COUNT_MAX),
  })
  .strict()
const searchProgressDiscoveryCompletedSchema = z
  .object({
    stage: z.literal('discovery'),
    state: z.literal('completed'),
    queryIndex: z.number().int().nonnegative().max(SEARCH_PROGRESS_QUERY_INDEX_MAX),
    queryCount: z.number().int().positive().max(SEARCH_PROGRESS_QUERY_COUNT_MAX),
    discoveredCount: z.number().int().nonnegative().max(SEARCH_PROGRESS_DISCOVERED_COUNT_MAX),
  })
  .strict()
const searchProgressDiscoveryFailedSchema = z
  .object({
    stage: z.literal('discovery'),
    state: z.literal('failed'),
    queryIndex: z.number().int().nonnegative().max(SEARCH_PROGRESS_QUERY_INDEX_MAX),
    queryCount: z.number().int().positive().max(SEARCH_PROGRESS_QUERY_COUNT_MAX),
    discoveredCount: z.literal(0),
  })
  .strict()
const searchProgressDocumentStartedSchema = z
  .object({
    stage: z.literal('document'),
    state: z.literal('started'),
    queryIndex: z.number().int().nonnegative().max(SEARCH_PROGRESS_QUERY_INDEX_MAX),
    attempted: z.number().int().positive().max(SEARCH_PROGRESS_ATTEMPTED_MAX),
  })
  .strict()
const searchProgressDocumentCompletedSchema = z
  .object({
    stage: z.literal('document'),
    state: z.literal('completed'),
    queryIndex: z.number().int().nonnegative().max(SEARCH_PROGRESS_QUERY_INDEX_MAX),
    attempted: z.number().int().positive().max(SEARCH_PROGRESS_ATTEMPTED_MAX),
    collected: z.number().refine(Number.isInteger).nonnegative().max(SEARCH_PROGRESS_COLLECTED_MAX),
  })
  .strict()
const searchProgressDocumentFailedSchema = z
  .object({
    stage: z.literal('document'),
    state: z.literal('failed'),
    queryIndex: z.number().int().nonnegative().max(SEARCH_PROGRESS_QUERY_INDEX_MAX),
    attempted: z.number().int().positive().max(SEARCH_PROGRESS_ATTEMPTED_MAX),
    collected: z.number().refine(Number.isInteger).nonnegative().max(SEARCH_PROGRESS_COLLECTED_MAX),
  })
  .strict()
const searchProgressIndexingStartedSchema = z
  .object({
    stage: z.literal('indexing'),
    state: z.literal('started'),
    documentCount: z.number().int().nonnegative().max(SEARCH_PROGRESS_DOCUMENT_COUNT_MAX),
  })
  .strict()
const searchProgressIndexingCompletedSchema = z
  .object({
    stage: z.literal('indexing'),
    state: z.literal('completed'),
    documentCount: z.number().int().nonnegative().max(SEARCH_PROGRESS_DOCUMENT_COUNT_MAX),
    chunkCount: z.number().int().nonnegative().max(SEARCH_PROGRESS_CHUNK_COUNT_MAX),
  })
  .strict()

export const searchProgressFactSchema = z.union([
  searchProgressCacheStartedSchema,
  searchProgressCacheCompletedSchema,
  searchProgressDiscoveryStartedSchema,
  searchProgressDiscoveryCompletedSchema,
  searchProgressDiscoveryFailedSchema,
  searchProgressDocumentStartedSchema,
  searchProgressDocumentCompletedSchema,
  searchProgressDocumentFailedSchema,
  searchProgressIndexingStartedSchema,
  searchProgressIndexingCompletedSchema,
])
export type SearchProgressFact = z.infer<typeof searchProgressFactSchema>

export const searchProgressEventSchema = z.object({
  jobId: legacyUuidSchema,
  sequence: z.number().refine(Number.isInteger).positive(),
  timestamp: z.string().datetime(),
  type: z.literal('progress'),
  progress: searchProgressFactSchema,
})
export type SearchProgressEvent = z.infer<typeof searchProgressEventSchema>

export const searchEventSchema = z.union([searchLegacyEventSchema, searchProgressEventSchema])
export type SearchEvent = z.infer<typeof searchEventSchema>

export interface SearchStageEmitter {
  legacy(type: 'cache' | 'collected' | 'indexed', detail: Record<string, unknown>): void
  progress(fact: SearchProgressFact): void
}

export const knowledgeDeleteSchema = z.discriminatedUnion('scope', [
  z
    .object({ scope: z.literal('sources'), sourceIds: z.array(legacyUuidSchema).min(1).max(500) })
    .strict(),
  z.object({ scope: z.literal('all-user-knowledge') }).strict(),
])
export type KnowledgeDeleteInput = z.infer<typeof knowledgeDeleteSchema>
export const knowledgeDeleteResultSchema = z.object({
  sources: z.number().refine(Number.isInteger).nonnegative(),
  versions: z.number().refine(Number.isInteger).nonnegative(),
  chunks: z.number().refine(Number.isInteger).nonnegative(),
  provenance: z.number().refine(Number.isInteger).nonnegative(),
})
export type KnowledgeDeleteResult = z.infer<typeof knowledgeDeleteResultSchema>
