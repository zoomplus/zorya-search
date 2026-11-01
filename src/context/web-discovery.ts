import type { WebDateRange, WebSource } from '../core/contracts.js'
import { canonicalUrl } from '../core/retrieval.js'
import type { ProviderErrorCode } from '../providers/contracts.js'
import { mapConcurrentOrdered } from './ordered-pool.js'

export interface WebDiscoveryQuerySummary {
  query: string
  status: 'complete' | 'failed'
  discoveredUrls: number
  retainedUrls: number
}

export interface WebDiscoverySummary {
  queries: WebDiscoveryQuerySummary[]
  uniqueUrls: number
  truncated: boolean
}

export interface WebDiscoveryError {
  stage: 'discovery'
  code: 'DISCOVERY_FAILED' | 'DISCOVERY_LIMIT' | 'DISCOVERY_INVALID_URL'
  queryIndex: number
  provider?: {
    code: ProviderErrorCode
    httpStatus?: number
    retryAfterMs?: number
  }
}

export interface CollectedWebDiscovery {
  urls: string[]
  queryIndexesByUrl: Map<string, number[]>
  errors: WebDiscoveryError[]
  summary: WebDiscoverySummary
}

export function buildWebDiscoveryQueries(
  primaryQuery: string,
  additionalQueries: readonly string[],
): string[] {
  const queries = [primaryQuery]
  const seen = new Set([primaryQuery.trim()])
  for (const query of additionalQueries) {
    const equivalenceKey = query.trim()
    if (seen.has(equivalenceKey)) continue
    seen.add(equivalenceKey)
    queries.push(query)
  }
  return queries
}

export async function collectWebDiscovery(input: {
  queries: readonly string[]
  source: WebSource
  target: number
  maxArrayUrls: number
  maxDocuments: number
  concurrency: number
  dateRange?: WebDateRange
  signal: AbortSignal
  providerFailureContext: (
    error: unknown,
  ) => WebDiscoveryError['provider'] | undefined
}): Promise<CollectedWebDiscovery> {
  const queryResults: QueryDiscoveryResult[] = []
  for await (const queryResult of mapConcurrentOrdered(
    input.queries,
    input.concurrency,
    input.signal,
    async (query, operationSignal) => discoverQuery(query, operationSignal, input),
  )) {
    queryResults.push(queryResult)
  }
  input.signal.throwIfAborted()

  const allUniqueUrls = new Set<string>()
  for (const result of queryResults) {
    for (const url of result.urls) allUniqueUrls.add(url)
  }

  const urls = admitRoundRobin(queryResults, input.maxDocuments)
  const retainedUrls = new Set(urls)
  const queryIndexesByUrl = new Map<string, number[]>()
  const errors: WebDiscoveryError[] = []
  const summaries = queryResults.map((result, queryIndex) => {
    errors.push(...result.errors.map((error) => ({ ...error, queryIndex })))
    let retainedCount = 0
    for (const url of result.urls) {
      if (!retainedUrls.has(url)) continue
      retainedCount++
      const queryIndexes = queryIndexesByUrl.get(url)
      if (queryIndexes) queryIndexes.push(queryIndex)
      else queryIndexesByUrl.set(url, [queryIndex])
    }
    return {
      query: result.query,
      status: result.status,
      discoveredUrls: result.urls.length,
      retainedUrls: retainedCount,
    }
  })

  return {
    urls,
    queryIndexesByUrl,
    errors,
    summary: {
      queries: summaries,
      uniqueUrls: allUniqueUrls.size,
      truncated: queryResults.some((result) => result.clipped) ||
        allUniqueUrls.size > input.maxDocuments,
    },
  }
}

interface QueryDiscoveryResult {
  query: string
  status: 'complete' | 'failed'
  urls: string[]
  errors: Array<Omit<WebDiscoveryError, 'queryIndex'>>
  clipped: boolean
}

async function discoverQuery(
  query: string,
  signal: AbortSignal,
  input: {
    source: WebSource
    target: number
    maxArrayUrls: number
    dateRange?: WebDateRange
    providerFailureContext: (
      error: unknown,
    ) => WebDiscoveryError['provider'] | undefined
  },
): Promise<QueryDiscoveryResult> {
  try {
    signal.throwIfAborted()
    const discovered = await input.source.discover(
      query,
      input.target,
      signal,
      input.dateRange ? { dateRange: input.dateRange } : undefined,
    )
    signal.throwIfAborted()
    if (!Array.isArray(discovered)) throw new Error('DISCOVERY_INVALID')

    const bounded = discovered.slice(0, input.maxArrayUrls)
    const clipped = bounded.length < discovered.length
    const errors: QueryDiscoveryResult['errors'] = clipped
      ? [{ stage: 'discovery', code: 'DISCOVERY_LIMIT' }]
      : []
    const urls = new Set<string>()
    for (const candidate of bounded) {
      if (typeof candidate !== 'string' || candidate.length > 2048) {
        errors.push({ stage: 'discovery', code: 'DISCOVERY_INVALID_URL' })
        continue
      }
      try {
        urls.add(canonicalUrl(candidate))
      } catch {
        errors.push({ stage: 'discovery', code: 'DISCOVERY_INVALID_URL' })
      }
    }
    return { query, status: 'complete', urls: [...urls], errors, clipped }
  } catch (error) {
    signal.throwIfAborted()
    const provider = input.providerFailureContext(error)
    return {
      query,
      status: 'failed',
      urls: [],
      errors: [{
        stage: 'discovery',
        code: 'DISCOVERY_FAILED',
        ...(provider ? { provider } : {}),
      }],
      clipped: false,
    }
  }
}

function admitRoundRobin(
  queryResults: readonly QueryDiscoveryResult[],
  maxDocuments: number,
): string[] {
  const admitted: string[] = []
  const admittedSet = new Set<string>()
  const cursors = queryResults.map(() => 0)

  while (admitted.length < maxDocuments) {
    let visitedCandidate = false
    for (let queryIndex = 0; queryIndex < queryResults.length; queryIndex++) {
      const result = queryResults[queryIndex]!
      let cursor = cursors[queryIndex]!
      while (cursor < result.urls.length && admittedSet.has(result.urls[cursor]!)) {
        cursor++
      }
      cursors[queryIndex] = cursor
      if (cursor >= result.urls.length) continue
      visitedCandidate = true
      const url = result.urls[cursor]!
      cursors[queryIndex] = cursor + 1
      admittedSet.add(url)
      admitted.push(url)
      if (admitted.length >= maxDocuments) break
    }
    if (!visitedCandidate) break
  }

  return admitted
}
