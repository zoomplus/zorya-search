import { createHash } from 'node:crypto'
import { documentSchema, webDateRangeSchema, type WebDateRange, type WebSource } from '../core/contracts.js'
import { canonicalUrl } from '../core/retrieval.js'
import { ProviderError, type ProviderErrorCode, type ProviderProfile } from '../providers/contracts.js'
import { createLifecycle } from './lifecycle.js'

export interface WebContextModels {
  embed?: {
    profile: ProviderProfile
    embed(input: { texts: string[]; signal: AbortSignal }): Promise<number[][]>
  }
  rerank?: {
    profile: ProviderProfile
    rerank(input: {
      query: string
      documents: string[]
      signal: AbortSignal
    }): Promise<{ index: number; score: number }[]>
  }
}
export interface WebSearchLimits {
  maxQueryChars: number
  maxLimit: number
  maxChars: number
  maxDocuments: number
  maxDocumentChars: number
  maxTotalDocumentChars: number
  maxChunkChars: number
  maxChunks: number
  maxConcurrency: number
  timeoutMs: number
}
const defaults: WebSearchLimits = {
  maxQueryChars: 2000,
  maxLimit: 20,
  maxChars: 24000,
  maxDocuments: 40,
  maxDocumentChars: 200000,
  maxTotalDocumentChars: 8000000,
  maxChunkChars: 2400,
  maxChunks: 5000,
  maxConcurrency: 4,
  timeoutMs: 20000,
}
export interface WebPassage {
  canonicalURL: string
  title: string
  fetchedAt: string
  publishedAt: string | null
  sourceUpdatedAt: string | null
  excerpt: string
  contentHash: string
  ranking: {
    lexicalRank: number | null
    denseRank: number | null
    rerankRank: number | null
    score: number
    embeddingProfile?: string
    rerankerProfile?: string
  }
}
export interface WebSearchResult {
  passages: WebPassage[]
  rankingMode: 'lexical' | 'hybrid' | 'lexical-reranked' | 'hybrid-reranked'
  errors: Array<{
    stage: 'discovery' | 'document' | 'embedding' | 'rerank'
    url?: string
    code:
      | 'DISCOVERY_FAILED'
      | 'DISCOVERY_LIMIT'
      | 'DISCOVERY_INVALID_URL'
      | 'DOCUMENT_FAILED'
      | 'DOCUMENT_INVALID'
      | 'DOCUMENT_TOO_LARGE'
      | 'CHUNK_BUDGET'
      | 'EMBEDDING_FAILED'
      | 'EMBEDDING_INVALID'
      | 'RERANK_FAILED'
      | 'INVALID_RANKING'
    provider?: {
      code: ProviderErrorCode
      httpStatus?: number
      retryAfterMs?: number
    }
  }>
  partial: boolean
  budget: { usedChars: number; maxChars: number }
}

export function createWebSearch(options: {
  web: WebSource
  models?: WebContextModels
  limits?: Partial<WebSearchLimits>
}) {
  const limits = Object.freeze({ ...defaults, ...options.limits })
  validateLimits(limits)
  if (options.models?.embed && !validEmbeddingProfile(options.models.embed.profile))
    throw new TypeError('Embedding profile must specify space and dimensions')
  if (options.models?.rerank && !validRerankerProfile(options.models.rerank.profile))
    throw new TypeError('Reranker profile must specify provider, model and space')
  const source = options.web
  const web = Object.freeze({
    discover: source.discover.bind(source),
    fetchDocument: source.fetchDocument.bind(source),
  })
  const models = snapshotModels(options.models)
  const lifecycle = createLifecycle(limits.maxConcurrency)
  return {
    searchWeb(input: {
      query: string
      limit?: number
      maxChars?: number
      dateRange?: WebDateRange
      signal?: AbortSignal
    }): Promise<WebSearchResult> {
      if (!input.query.trim() || input.query.length > limits.maxQueryChars)
        throw new TypeError('Invalid web query')
      const limit = input.limit ?? 8,
        maxChars = input.maxChars ?? limits.maxChars
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > limits.maxLimit ||
        !Number.isInteger(maxChars) ||
        maxChars < 1 ||
        maxChars > limits.maxChars
      )
        throw new TypeError('Web request exceeds configured limits')
      const dateRange = input.dateRange === undefined
        ? undefined
        : webDateRangeSchema.parse(input.dateRange)
      const request = Object.freeze({ ...input })
      return lifecycle.run(request.signal, limits.timeoutMs, async (signal) => {
        const errors: WebSearchResult['errors'] = []
        let urls: string[]
        try {
          signal.throwIfAborted()
          const discovered = await web.discover(
            request.query,
            Math.min(limits.maxDocuments, limit * 2),
            signal,
            dateRange ? { dateRange } : undefined,
          )
          if (!Array.isArray(discovered)) throw new Error('DISCOVERY_INVALID')
          const bounded = discovered.slice(0, limits.maxDocuments * 2)
          if (bounded.length < discovered.length)
            errors.push({ stage: 'discovery', code: 'DISCOVERY_LIMIT' })
          const normalized = new Set<string>()
          for (const candidate of bounded) {
            if (typeof candidate !== 'string' || candidate.length > 2048) {
              errors.push({ stage: 'discovery', code: 'DISCOVERY_INVALID_URL' })
              continue
            }
            try {
              normalized.add(canonicalUrl(candidate))
            } catch {
              errors.push({ stage: 'discovery', code: 'DISCOVERY_INVALID_URL' })
            }
          }
          urls = [...normalized].slice(0, limits.maxDocuments)
        } catch (error) {
          signal.throwIfAborted()
          const provider = providerFailureContext(error)
          return {
            passages: [],
            rankingMode: 'lexical',
            errors: [{ stage: 'discovery', code: 'DISCOVERY_FAILED', ...(provider ? { provider } : {}) }],
            partial: true,
            budget: { usedChars: 0, maxChars },
          }
        }
        let retainedDocumentChars = 0
        const documents = await mapLimit(urls, limits.maxConcurrency, signal, async (url) => {
          try {
            signal.throwIfAborted()
            const raw = await web.fetchDocument(url, signal)
            if (
              isDocument(raw) &&
              typeof raw.text === 'string' &&
              raw.text.length > limits.maxDocumentChars
            )
              throw new Error('DOCUMENT_TOO_LARGE')
            if (!boundedDocument(raw, limits.maxDocumentChars)) throw new Error('DOCUMENT_INVALID')
            const doc = documentSchema.parse(raw)
            if (retainedDocumentChars + doc.text.length > limits.maxTotalDocumentChars)
              throw new Error('DOCUMENT_TOO_LARGE')
            const canonical = canonicalUrl(doc.url)
            const contentHash = createHash('sha256').update(doc.text).digest('hex')
            retainedDocumentChars += doc.text.length
            return {
              doc,
              url: canonical,
              contentHash,
            }
          } catch (error) {
            signal.throwIfAborted()
            const provider = providerFailureContext(error)
            errors.push({
              stage: 'document',
              url,
              code: documentErrorCode(error),
              ...(provider ? { provider } : {}),
            })
            return null
          }
        })
        signal.throwIfAborted()
        const rows: NonNullable<(typeof documents)[number]>[] = []
        for (const item of documents) {
          if (!item) continue
          rows.push(item)
        }
        const chunks: Array<{ row: (typeof rows)[number]; excerpt: string }> = []
        let chunkBudgetReached = false
        for (const row of rows) {
          for (const excerpt of chunk(row.doc.text, limits.maxChunkChars)) {
            if (chunks.length >= limits.maxChunks) {
              chunkBudgetReached = true
              break
            }
            chunks.push({ row, excerpt })
          }
          if (chunkBudgetReached) break
        }
        if (chunkBudgetReached) errors.push({ stage: 'document', code: 'CHUNK_BUDGET' })
        const lexical = chunks
          .map((item) =>
            tokenScore(request.query, `${item.row.doc.title} ${item.row.url} ${item.excerpt}`),
          )
          .map((score, index) => ({ score, index }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score || a.index - b.index)
        const lexicalRanks = new Map(lexical.map((x, i) => [x.index, i + 1]))
        let denseRanks = new Map<number, number>()
        if (models?.embed && chunks.length) {
          try {
            signal.throwIfAborted()
            const texts = [request.query, ...chunks.slice(0, 80).map((x) => x.excerpt)]
            const vectors = await models.embed.embed({ texts, signal })
            validateVectors(vectors, texts.length, models.embed.profile.dimensions!)
            const ranked = vectors
              .slice(1)
              .map((v, i) => ({ index: i, score: cosine(vectors[0]!, v) }))
              .sort((a, b) => b.score - a.score || a.index - b.index)
            denseRanks = new Map(ranked.map((x, i) => [x.index, i + 1]))
          } catch (error) {
            signal.throwIfAborted()
            const provider = providerFailureContext(error)
            errors.push({
              stage: 'embedding',
              code: providerErrorCode(error, 'EMBEDDING_FAILED'),
              ...(provider ? { provider } : {}),
            })
          }
        }
        const candidates = new Set([...lexicalRanks.keys(), ...denseRanks.keys()])
        const fused = [...candidates]
          .map((index) => ({
            index,
            score:
              (lexicalRanks.has(index) ? 1 / (60 + lexicalRanks.get(index)!) : 0) +
              (denseRanks.has(index) ? 1 / (60 + denseRanks.get(index)!) : 0),
          }))
          .sort((a, b) => b.score - a.score || a.index - b.index)
          .slice(0, Math.min(40, limit * 3))
        let ordered = fused
        let rerankRanks = new Map<number, number>()
        if (models?.rerank && fused.length) {
          try {
            signal.throwIfAborted()
            const selected = fused.slice(0, 40)
            const result = await models.rerank.rerank({
              query: request.query,
              documents: selected.map((x) => chunks[x.index]!.excerpt),
              signal,
            })
            validateRanking(result, selected.length)
            const unique = new Set<number>()
            const ranking = result
              .map((x) => {
                if (unique.has(x.index) || !Number.isFinite(x.score))
                  throw new Error('INVALID_RANKING')
                unique.add(x.index)
                return x
              })
              .sort((a, b) => b.score - a.score || a.index - b.index)
            const rankedIndices = new Set(ranking.map((item) => item.index))
            const reranked = ranking.map((x) => ({
              index: selected[x.index]!.index,
              score: x.score,
            }))
            const fallback = [
              ...selected.filter((_, index) => !rankedIndices.has(index)),
              ...fused.slice(selected.length),
            ]
            ordered = [...reranked, ...fallback]
            rerankRanks = new Map(reranked.map((x, i) => [x.index, i + 1]))
          } catch (error) {
            signal.throwIfAborted()
            const provider = providerFailureContext(error)
            errors.push({
              stage: 'rerank',
              code: providerErrorCode(error, 'RERANK_FAILED'),
              ...(provider ? { provider } : {}),
            })
          }
        }
        const passages: WebPassage[] = []
        const rankingMode = rerankRanks.size
          ? denseRanks.size
            ? 'hybrid-reranked'
            : 'lexical-reranked'
          : denseRanks.size
            ? 'hybrid'
            : 'lexical'
        let usedChars = 0
        for (const candidate of ordered) {
          const item = chunks[candidate.index]
          if (!item) continue
          const excerpt = item.excerpt.slice(0, Math.max(0, maxChars - usedChars))
          if (!excerpt) break
          usedChars += excerpt.length
          passages.push({
            canonicalURL: item.row.url,
            title: item.row.doc.title,
            fetchedAt: item.row.doc.fetchedAt,
            publishedAt: item.row.doc.publishedAt,
            sourceUpdatedAt: item.row.doc.sourceUpdatedAt,
            excerpt,
            contentHash: item.row.contentHash,
            ranking: {
              lexicalRank: lexicalRanks.get(candidate.index) ?? null,
              denseRank: denseRanks.get(candidate.index) ?? null,
              rerankRank: rerankRanks.get(candidate.index) ?? null,
              score: candidate.score,
              ...(models?.embed ? { embeddingProfile: profileId(models.embed.profile) } : {}),
              ...(models?.rerank ? { rerankerProfile: profileId(models.rerank.profile) } : {}),
            },
          })
          if (passages.length >= limit || usedChars >= maxChars) break
        }
        signal.throwIfAborted()
        return {
          passages,
          rankingMode,
          errors,
          partial: errors.length > 0,
          budget: { usedChars, maxChars },
        }
      })
    },
    async readWebSource(input: { url: string; maxChars?: number; signal?: AbortSignal }) {
      if (input.url.length > 2048) throw new TypeError('Web URL exceeds configured limit')
      const url = canonicalUrl(input.url)
      const maxChars = input.maxChars ?? Math.min(limits.maxDocumentChars, limits.maxChars)
      if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > limits.maxDocumentChars)
        throw new TypeError('Read budget exceeds configured limits')
      const request = Object.freeze({ ...input, url })
      return lifecycle.run(request.signal, limits.timeoutMs, async (signal) => {
        signal.throwIfAborted()
        const raw = await web.fetchDocument(request.url, signal)
        if (
          isDocument(raw) &&
          typeof raw.text === 'string' &&
          raw.text.length > limits.maxDocumentChars
        )
          throw new Error('DOCUMENT_TOO_LARGE')
        if (!boundedDocument(raw, limits.maxDocumentChars)) throw new Error('DOCUMENT_INVALID')
        const doc = documentSchema.parse(raw)
        if (doc.text.length > limits.maxDocumentChars) throw new Error('DOCUMENT_TOO_LARGE')
        signal.throwIfAborted()
        const text = doc.text.slice(0, maxChars)
        return {
          canonicalURL: canonicalUrl(doc.url),
          title: doc.title,
          fetchedAt: doc.fetchedAt,
          publishedAt: doc.publishedAt,
          sourceUpdatedAt: doc.sourceUpdatedAt,
          text,
          truncated: text.length < doc.text.length,
          contentHash: createHash('sha256').update(doc.text).digest('hex'),
        }
      })
    },
    close: () => lifecycle.close(),
  }
}
function validateLimits(l: WebSearchLimits) {
  for (const v of Object.values(l))
    if (!Number.isInteger(v) || v < 1) throw new TypeError('Invalid web limit')
  if (
    l.maxDocuments > 200 ||
    l.maxQueryChars > 8000 ||
    l.maxChars > 100000 ||
    l.maxDocumentChars > 1000000 ||
    l.maxTotalDocumentChars > 20000000 ||
    l.maxChunkChars > 8000 ||
    l.maxChunks > 20000 ||
    l.maxConcurrency > 8 ||
    l.timeoutMs > 120000 ||
    l.maxLimit > 100
  )
    throw new TypeError('Web limits exceed hard caps')
}
async function mapLimit<T, R>(
  items: T[],
  n: number,
  signal: AbortSignal,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      signal.throwIfAborted()
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i]!)
    }
  })
  const settled = await Promise.allSettled(workers)
  const failed = settled.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  signal.throwIfAborted()
  return out
}

function validBaseProfile(profile: ProviderProfile) {
  return Boolean(
    profile.provider.trim() &&
      profile.provider.length <= 160 &&
      profile.model.trim() &&
      profile.model.length <= 500 &&
      profile.space.trim() &&
      profile.space.length <= 500 &&
      (profile.profileId === undefined ||
        (typeof profile.profileId === 'string' && profile.profileId.length <= 500)) &&
      (profile.inputType === undefined ||
        (typeof profile.inputType === 'string' && profile.inputType.length <= 100)) &&
      (profile.dimensions === undefined ||
        (Number.isInteger(profile.dimensions) &&
          profile.dimensions! > 0 &&
          profile.dimensions! <= 8192)),
  )
}

function validEmbeddingProfile(profile: ProviderProfile) {
  return validBaseProfile(profile) && profile.dimensions !== undefined
}

function validRerankerProfile(profile: ProviderProfile) {
  return validBaseProfile(profile)
}

function snapshotModels(models?: WebContextModels): WebContextModels | undefined {
  if (!models) return undefined
  const embed = models.embed
    ? Object.freeze({
        profile: deepFreeze(structuredClone(models.embed.profile)),
        embed: models.embed.embed.bind(models.embed),
      })
    : undefined
  const rerank = models.rerank
    ? Object.freeze({
        profile: deepFreeze(structuredClone(models.rerank.profile)),
        rerank: models.rerank.rerank.bind(models.rerank),
      })
    : undefined
  return Object.freeze({
    ...(embed ? { embed } : {}),
    ...(rerank ? { rerank } : {}),
  })
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
function* chunk(text: string, size: number): Generator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size)
}
function tokens(s: string) {
  return s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}
function tokenScore(q: string, d: string) {
  const set = new Set(tokens(d))
  return tokens(q).reduce((n, t) => n + (set.has(t) ? 1 : 0), 0)
}
function validateVectors(v: number[][], count: number, dim: number) {
  if (
    !Array.isArray(v) ||
    v.length !== count ||
    v.some(
      (x) =>
        !Array.isArray(x) ||
        x.length !== dim ||
        x.some((n) => !Number.isFinite(n)) ||
        !hasFiniteNonzeroNorm(x),
    )
  )
    throw new Error('INVALID_EMBEDDING')
}
function cosine(a: number[], b: number[]) {
  const scaleA = Math.max(...a.map(Math.abs))
  const scaleB = Math.max(...b.map(Math.abs))
  if (!scaleA || !scaleB || !Number.isFinite(scaleA) || !Number.isFinite(scaleB))
    throw new Error('INVALID_EMBEDDING')
  let dot = 0,
    aa = 0,
    bb = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i]! / scaleA
    const bv = b[i]! / scaleB
    dot += av * bv
    aa += av * av
    bb += bv * bv
  }
  const score = dot / Math.sqrt(aa * bb)
  if (!Number.isFinite(score)) throw new Error('INVALID_EMBEDDING')
  return score
}
function hasFiniteNonzeroNorm(vector: number[]) {
  if (vector.some((value) => !Number.isFinite(value))) return false
  const scale = Math.max(...vector.map(Math.abs))
  if (!scale || !Number.isFinite(scale)) return false
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + (value / scale) ** 2, 0))
  return Number.isFinite(norm) && norm > 0 && Number.isFinite(scale * norm)
}
function validateRanking(
  r: unknown,
  len: number,
): asserts r is Array<{ index: number; score: number }> {
  if (!Array.isArray(r)) throw new Error('INVALID_RANKING')
  for (const x of r)
    if (
      !x ||
      !Number.isInteger(x.index) ||
      x.index < 0 ||
      x.index >= len ||
      !Number.isFinite(x.score)
    )
      throw new Error('INVALID_RANKING')
}
function profileId(p: ProviderProfile) {
  return JSON.stringify([
    p.provider,
    p.model,
    p.space,
    p.dimensions ?? null,
    p.inputType ?? null,
    p.profileId ?? null,
  ])
}
function documentErrorCode(e: unknown): WebSearchResult['errors'][number]['code'] {
  if (e instanceof Error && e.message === 'DOCUMENT_TOO_LARGE') return 'DOCUMENT_TOO_LARGE'
  if (e instanceof Error && e.message === 'DOCUMENT_INVALID') return 'DOCUMENT_INVALID'
  if (e instanceof Error && e.message.startsWith('[')) return 'DOCUMENT_INVALID'
  return 'DOCUMENT_FAILED'
}
function boundedDocument(
  raw: unknown,
  maxDocumentChars: number,
): raw is {
  url: string
  title: string
  text: string
  fetchedAt: string
  publishedAt: string | null
  sourceUpdatedAt: string | null
} {
  if (!raw || typeof raw !== 'object') return false
  const document = raw as Record<string, unknown>
  return (
    typeof document.url === 'string' &&
    document.url.length <= 2048 &&
    typeof document.title === 'string' &&
    document.title.length <= 500 &&
    typeof document.text === 'string' &&
    document.text.length <= maxDocumentChars &&
    typeof document.fetchedAt === 'string' &&
    document.fetchedAt.length <= 80 &&
    (document.publishedAt === undefined ||
      document.publishedAt === null ||
      (typeof document.publishedAt === 'string' && document.publishedAt.length <= 80)) &&
    (document.sourceUpdatedAt === undefined ||
      document.sourceUpdatedAt === null ||
      (typeof document.sourceUpdatedAt === 'string' && document.sourceUpdatedAt.length <= 80))
  )
}
function isDocument(raw: unknown): raw is Record<string, unknown> {
  return Boolean(raw && typeof raw === 'object')
}
function providerErrorCode(
  e: unknown,
  fallback: 'EMBEDDING_FAILED' | 'RERANK_FAILED',
): WebSearchResult['errors'][number]['code'] {
  if (e instanceof Error && e.message === 'INVALID_EMBEDDING') return 'EMBEDDING_INVALID'
  if (e instanceof Error && e.message === 'INVALID_RANKING') return 'INVALID_RANKING'
  return fallback
}

function providerFailureContext(
  error: unknown,
): { code: ProviderErrorCode; httpStatus?: number; retryAfterMs?: number } | undefined {
  if (!(error instanceof ProviderError)) return undefined
  const validCodes: readonly ProviderErrorCode[] = [
    'auth',
    'quota',
    'rate_limit',
    'timeout',
    'cancel',
    'malformed',
    'unavailable',
    'budget',
  ]
  if (!validCodes.includes(error.code)) return undefined
  const context: { code: ProviderErrorCode; httpStatus?: number; retryAfterMs?: number } = {
    code: error.code,
  }
  const status = error.status
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599)
    context.httpStatus = status
  const retryAfterMs = error.retryAfterMs
  if (
    typeof retryAfterMs === 'number' &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs >= 0 &&
    retryAfterMs <= 86_400_000
  )
    context.retryAfterMs = retryAfterMs
  return context
}
