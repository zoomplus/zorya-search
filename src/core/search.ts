import { z } from 'zod'

import type {
  KnowledgeRepository,
  SearchModels,
  SearchRequest,
  SearchResult,
  SearchStageEmitter,
  WebSource,
} from './contracts.js'

import { embeddingSchema } from './contracts.js'
import { collectSources } from './collection.js'
import { embedChunks, rankPassages } from './indexing.js'
import { buildSearchQuery } from './retrieval.js'

export interface SearchDependencies {
  repository: KnowledgeRepository
  models: SearchModels
  web: WebSource
  embeddingSpace: string
  cacheThreshold?: number
}
export async function executeSearch(
  request: SearchRequest,
  deps: SearchDependencies,
  signal: AbortSignal,
  emit: SearchStageEmitter,
): Promise<SearchResult> {
  signal.throwIfAborted()
  const query = buildSearchQuery(request)
  const vectors = embeddingSchema.parse(await deps.models.embed({ texts: [query], signal }))
  const vector = vectors[0]
  if (!vector || vectors.length !== 1) throw new Error('EMBEDDING_COUNT_MISMATCH')
  const cache = await evaluateSearchCache(request, query, vector, deps, signal, emit)
  if (cache.sufficient) {
    return recordResult(
      request,
      deps.repository,
      {
        origin: 'database',
        passages: cache.passages,
        collected: 0,
        attempted: 0,
        partial: false,
        errors: [],
        cacheScore: cache.cacheScore,
      },
      signal,
    )
  }
  const cacheScore = cache.cacheScore
  const collection = await collectSources(request, deps.web, signal, emit)
  const collectionPartial =
    collection.budgetExpired || collection.documents.length < request.targetSources
  const empty: SearchResult = {
    origin: 'web',
    passages: [],
    collected: collection.documents.length,
    attempted: collection.attempted,
    partial: collectionPartial,
    errors: collection.errors,
    cacheScore,
  }
  if (collection.documents.length === 0) {
    const cacheFallback = cachePartialFallback(cache, collection, cacheScore)
    if (cacheFallback) return recordResult(request, deps.repository, cacheFallback, signal)
    return recordResult(request, deps.repository, empty, signal)
  }
  emit.progress({
    stage: 'indexing',
    state: 'started',
    documentCount: collection.documents.length,
  })
  const chunks = await embedChunks(collection.documents, deps.models, vector.length, signal)
  signal.throwIfAborted()
  const metadata = buildMetadata(request, deps.embeddingSpace)
  await deps.repository.save(collection.documents, chunks, metadata, signal)
  signal.throwIfAborted()
  emit.legacy('indexed', { documents: collection.documents.length, chunks: chunks.length })
  emit.progress({
    stage: 'indexing',
    state: 'completed',
    documentCount: collection.documents.length,
    chunkCount: chunks.length,
  })
  const candidates = await deps.repository.retrieve(
    query,
    vector,
    deps.embeddingSpace,
    40,
    buildFilter(request),
  )
  signal.throwIfAborted()
  const passages = await rankPassages(query, candidates, deps.models, signal)
  if (passages.length === 0) {
    const cacheFallback = cachePartialFallback(cache, collection, cacheScore)
    if (cacheFallback) return recordResult(request, deps.repository, cacheFallback, signal)
  }
  return recordResult(request, deps.repository, { ...empty, passages }, signal)
}

type CacheEvaluation =
  | {
      sufficient: true
      passages: SearchResult['passages']
      cacheScore: number
      rankedPassages: SearchResult['passages']
    }
  | { sufficient: false; cacheScore: number; rankedPassages: SearchResult['passages'] }

function cachePartialFallback(
  cache: CacheEvaluation,
  collection: Awaited<ReturnType<typeof collectSources>>,
  cacheScore: number,
): SearchResult | undefined {
  if (cache.rankedPassages.length === 0) return undefined
  return {
    origin: 'database',
    passages: cache.rankedPassages,
    collected: collection.documents.length,
    attempted: collection.attempted,
    partial: true,
    errors: collection.errors,
    cacheScore,
  }
}

async function evaluateSearchCache(
  request: SearchRequest,
  query: string,
  vector: number[],
  deps: SearchDependencies,
  signal: AbortSignal,
  emit: SearchStageEmitter,
): Promise<CacheEvaluation> {
  emit.progress({ stage: 'cache', state: 'started' })
  const cached = await deps.repository.retrieve(
    query,
    vector,
    deps.embeddingSpace,
    40,
    buildFilter(request),
  )
  signal.throwIfAborted()
  const cachedRanked = await rankPassages(query, cached, deps.models, signal)
  const cacheScore =
    cachedRanked.length === 0
      ? 0
      : z
          .number()
          .min(0)
          .max(1)
          .parse(await deps.models.judgeCache({ request, passages: cachedRanked, signal }))
  signal.throwIfAborted()
  const threshold = resolveCacheThreshold(deps.cacheThreshold)
  const sufficient = cachedRanked.length > 0 && cacheScore >= threshold
  emit.legacy('cache', { candidateCount: cached.length, score: cacheScore })
  emit.progress({
    stage: 'cache',
    state: 'completed',
    candidateCount: cached.length,
    score: cacheScore,
    threshold,
    sufficient,
  })
  if (sufficient) {
    return { sufficient: true, passages: cachedRanked, cacheScore, rankedPassages: cachedRanked }
  }
  return { sufficient: false, cacheScore, rankedPassages: cachedRanked }
}

async function recordResult(
  request: SearchRequest,
  repository: KnowledgeRepository,
  result: SearchResult,
  signal: AbortSignal,
): Promise<SearchResult> {
  signal.throwIfAborted()
  await repository.recordQuery(request, result)
  signal.throwIfAborted()
  return result
}
function buildMetadata(
  request: SearchRequest,
  space: string,
): { space: string; language: string; game?: string; gameVersion?: string; query: SearchRequest } {
  return {
    space,
    query: request,
    language: request.language,
    ...(request.game === undefined ? {} : { game: request.game }),
    ...(request.gameVersion === undefined ? {} : { gameVersion: request.gameVersion }),
  }
}
function buildFilter(request: SearchRequest): { game?: string; gameVersion?: string } {
  return {
    ...(request.game === undefined ? {} : { game: request.game }),
    ...(request.gameVersion === undefined ? {} : { gameVersion: request.gameVersion }),
  }
}

function resolveCacheThreshold(value: number | undefined): number {
  return z
    .number()
    .min(0)
    .max(1)
    .parse(value ?? 0.9)
}
