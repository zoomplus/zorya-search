import type {
  SearchCollectionError,
  SearchRequest,
  SearchStageEmitter,
  SourceDocument,
  WebSource,
} from './contracts.js'

import { documentSchema } from './contracts.js'
import { buildSearchQueries, canonicalUrl } from './retrieval.js'

interface Collection {
  documents: SourceDocument[]
  errors: SearchCollectionError[]
  attempted: number
  budgetExpired: boolean
}
interface CollectionContext {
  request: SearchRequest
  web: WebSource
  callerSignal: AbortSignal
  collectionSignal: AbortSignal
  budget: AbortSignal
  emit: SearchStageEmitter
  result: Collection
  attemptedUrls: Set<string>
  seenUrls: Set<string>
  seenContent: Set<string>
  queryCount: number
}
export async function collectSources(
  request: SearchRequest,
  web: WebSource,
  signal: AbortSignal,
  emit: SearchStageEmitter,
): Promise<Collection> {
  const queries = buildSearchQueries(request)
  const context = createContext(request, web, signal, emit, queries.length)
  for (const [queryIndex, query] of queries.entries()) {
    if (!canContinue(context)) break
    const urls = await discoverUrls(query, queryIndex, context)
    if (!urls) {
      if (context.budget.aborted) break
      continue
    }
    await fetchDocuments(urls, queryIndex, queries.length, context)
  }
  signal.throwIfAborted()
  return { ...context.result, budgetExpired: context.budget.aborted }
}
function createContext(
  request: SearchRequest,
  web: WebSource,
  callerSignal: AbortSignal,
  emit: SearchStageEmitter,
  queryCount: number,
): CollectionContext {
  const budget = AbortSignal.timeout(request.collectionTimeoutMs)
  return {
    request,
    web,
    callerSignal,
    collectionSignal: AbortSignal.any([callerSignal, budget]),
    budget,
    emit,
    queryCount,
    result: { documents: [], errors: [], attempted: 0, budgetExpired: false },
    attemptedUrls: new Set(),
    seenUrls: new Set(),
    seenContent: new Set(),
  }
}
function canContinue({ request, collectionSignal, result }: CollectionContext): boolean {
  return (
    result.documents.length < request.targetSources &&
    result.attempted < request.maxAttempts &&
    !collectionSignal.aborted
  )
}
async function discoverUrls(
  query: string,
  queryIndex: number,
  context: CollectionContext,
): Promise<string[] | undefined> {
  const { request, web, collectionSignal, callerSignal, budget, result, queryCount, emit } = context
  const remainingAttempts = request.maxAttempts - result.attempted
  const missingSources = request.targetSources - result.documents.length
  const limit = Math.min(200, remainingAttempts, Math.max(20, missingSources * 2))
  emit.progress({ stage: 'discovery', state: 'started', queryIndex, queryCount })
  try {
    const discovered = await web.discover(query, limit, collectionSignal)
    collectionSignal.throwIfAborted()
    const urls = canonicalizeDiscovered(discovered, queryIndex, context)
    emit.progress({
      stage: 'discovery',
      state: 'completed',
      queryIndex,
      queryCount,
      discoveredCount: urls.length,
    })
    return urls
  } catch (error) {
    callerSignal.throwIfAborted()
    const code = errorCode(error, budget.aborted, 'DISCOVERY_FAILED')
    result.errors.push({
      stage: 'discovery',
      queryIndex,
      code,
    })
    emit.progress({
      stage: 'discovery',
      state: 'failed',
      queryIndex,
      queryCount,
      discoveredCount: 0,
    })
    return undefined
  }
}
function canonicalizeDiscovered(
  discovered: string[],
  queryIndex: number,
  context: CollectionContext,
): string[] {
  const batch = new Set<string>()
  for (const rawUrl of discovered) {
    try {
      const url = canonicalUrl(rawUrl)
      if (!context.attemptedUrls.has(url)) batch.add(url)
    } catch {
      context.result.errors.push({ stage: 'discovery', queryIndex, code: 'INVALID_SOURCE_URL' })
    }
  }
  return [...batch]
}
async function fetchDocuments(
  urls: string[],
  queryIndex: number,
  queryCount: number,
  context: CollectionContext,
): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: context.request.concurrency }, async () => {
      while (next < urls.length && canContinue(context)) {
        const url = urls[next++]
        if (!url) break
        await fetchDocument(url, queryIndex, queryCount, context)
      }
    }),
  )
}
async function fetchDocument(
  url: string,
  queryIndex: number,
  queryCount: number,
  context: CollectionContext,
): Promise<void> {
  const { callerSignal, collectionSignal, budget, web, result, emit } = context
  result.attempted++
  context.attemptedUrls.add(url)
  const attempted = result.attempted
  emit.progress({ stage: 'document', state: 'started', queryIndex, attempted })
  try {
    const document = documentSchema.parse(await web.fetchDocument(url, collectionSignal))
    collectionSignal.throwIfAborted()
    appendUniqueDocument(document, queryIndex, queryCount, context)
    emit.progress({
      stage: 'document',
      state: 'completed',
      queryIndex,
      attempted,
      collected: result.documents.length,
    })
  } catch (error) {
    callerSignal.throwIfAborted()
    const code = errorCode(error, budget.aborted, 'DOCUMENT_FAILED')
    result.errors.push({
      stage: 'document',
      url,
      code,
    })
    emit.progress({
      stage: 'document',
      state: 'failed',
      queryIndex,
      attempted,
      collected: result.documents.length,
    })
  }
}
function appendUniqueDocument(
  document: SourceDocument,
  queryIndex: number,
  queryCount: number,
  context: CollectionContext,
): void {
  const { request } = context
  const { documents } = context.result
  const url = canonicalUrl(document.url)
  if (
    documents.length >= request.targetSources ||
    context.seenUrls.has(url) ||
    context.seenContent.has(document.text)
  )
    return
  context.seenUrls.add(url)
  context.seenContent.add(document.text)
  documents.push({ ...document, url })
  context.emit.legacy('collected', {
    count: documents.length,
    attempted: context.result.attempted,
    queryIndex,
    queryCount,
  })
}
function errorCode(error: unknown, timedOut: boolean, fallback: string): string {
  if (timedOut) return 'COLLECTION_TIMEOUT'
  const message = error instanceof Error ? error.message : ''
  if (/^(?:BRAVE|SOURCE)_HTTP_[1-5]\d{2}$/u.test(message)) return message
  if (
    [
      'SOURCE_CONTENT_TYPE_UNSUPPORTED',
      'SOURCE_EMPTY',
      'SOURCE_TOO_LARGE',
      'PRIVATE_SOURCE_UNSUPPORTED',
      'Unsupported URL protocol',
    ].includes(message)
  )
    return message === 'Unsupported URL protocol' ? 'INVALID_SOURCE_URL' : message
  return fallback
}
