import { createHash } from 'node:crypto'
import type { ProviderProfile } from '../providers/contracts.js'
import { createLifecycle, OperationClosedError } from '../context/lifecycle.js'

export interface VisualReference {
  id: string
  contentHash: string
  screen?: string
  state?: string
  breakpoint?: string
  text?: string
}
export interface VisualLimits {
  maxItems: number
  maxTextChars: number
  maxImageBytes: number
  maxResults: number
  maxTotalBytes: number
  maxConcurrency: number
  timeoutMs: number
}
const defaults: VisualLimits = {
  maxItems: 500,
  maxTextChars: 4000,
  maxImageBytes: 2_000_000,
  maxResults: 30,
  maxTotalBytes: 20_000_000,
  maxConcurrency: 4,
  timeoutMs: 15000,
}
/** Заимствованный порт сам отвечает за соблюдение своего профиля, включая модель, пространство и тип входа. */
type EmbeddingPort = {
  profile: ProviderProfile
  embed(input: {
    texts?: string[]
    images?: Array<{ bytes: Uint8Array; mimeType: string }>
    signal: AbortSignal
  }): Promise<number[][]>
}
interface Stored {
  ref: VisualReference
  vector: number[] | null
  bytes: number
}
export class VisualSearchError extends Error {
  constructor(
    readonly code: 'DISABLED' | 'CLOSED' | 'LIMIT' | 'STALE' | 'IMAGE_QUERY_UNSUPPORTED',
  ) {
    super(`Visual search operation failed: ${code}`)
    this.name = 'VisualSearchError'
  }
}

/** Временный индекс переданных вызывающей стороной ссылок; это поиск, а не захват экрана или пиксельная проверка. */
export function createVisualSearch(
  options: {
    enabled?: boolean
    embedding?: EmbeddingPort
    profile?: ProviderProfile
    limits?: Partial<VisualLimits>
  } = {},
) {
  const enabled = options.enabled ?? false
  const limits = Object.freeze({ ...defaults, ...options.limits })
  validateLimits(limits)
  const embedding = enabled ? options.embedding : undefined
  const profile = enabled && options.profile ? snapshotProfile(options.profile) : undefined
  const embeddingProfile = embedding ? snapshotProfile(embedding.profile) : undefined
  if (embedding && !profile) throw new TypeError('An explicit visual embedding profile is required')
  if (embedding && profile && profileId(embeddingProfile!) !== profileId(profile))
    throw new TypeError('Visual embedding profile mismatch')
  const embedPort =
    embedding && embeddingProfile
      ? Object.freeze({
          profile: embeddingProfile,
          embed: embedding.embed.bind(embedding),
        })
      : undefined
  const capturedProfile = profile ? deepFreeze(profile) : undefined
  const rows = new Map<string, Stored>()
  const lifecycle = createLifecycle(limits.maxConcurrency)
  const pendingUpdates = new Map<string, AbortController>()
  let bytesStored = 0
  let generation = 0
  let closed = false
  let closePromise: Promise<void> | undefined
  const ensure = () => {
    if (!enabled) throw new VisualSearchError('DISABLED')
    if (closed) throw new VisualSearchError('CLOSED')
  }
  const embed = async (
    input: { text?: string; image?: { bytes: Uint8Array; mimeType: string } },
    signal: AbortSignal,
  ): Promise<number[] | null> => {
    if (!embedPort) return null
    signal.throwIfAborted()
    const response = await embedPort.embed({
      ...(input.text === undefined ? {} : { texts: [input.text] }),
      ...(input.image === undefined
        ? {}
        : {
            images: [{ bytes: Uint8Array.from(input.image.bytes), mimeType: input.image.mimeType }],
          }),
      signal,
    })
    signal.throwIfAborted()
    if (!Array.isArray(response) || response.length !== 1 || !Array.isArray(response[0]))
      throw new TypeError('Malformed visual embedding')
    const vector = [...response[0]]
    if (
      vector.length !== capturedProfile?.dimensions ||
      vector.some((value) => !Number.isFinite(value)) ||
      !Number.isFinite(norm(vector)) ||
      norm(vector) === 0
    )
      throw new TypeError('Malformed visual embedding')
    return vector
  }

  return {
    async upsert(input: {
      reference: VisualReference
      image?: { bytes: Uint8Array; mimeType: string }
      signal?: AbortSignal
    }) {
      ensure()
      const reference = snapshotReference(input.reference, limits)
      const image = input.image === undefined ? undefined : snapshotImage(input.image, limits)
      if (!image && !reference.text)
        throw new TypeError('Provide an explicit image or text reference')
      if (image && reference.text)
        throw new TypeError('Provide one embedding input per visual reference')
      const sourceBytes = image?.bytes ?? Buffer.from(reference.text ?? '', 'utf8')
      verifyContentHash(reference.contentHash, sourceBytes)
      return lifecycle.run(input.signal, limits.timeoutMs, async (signal) => {
        const pending = new AbortController()
        pendingUpdates.get(reference.id)?.abort(new VisualSearchError('STALE'))
        pendingUpdates.set(reference.id, pending)
        generation++
        const operationSignal = AbortSignal.any([signal, pending.signal])
        try {
          const vector = await embed(
            {
              ...(reference.text === undefined ? {} : { text: reference.text }),
              ...(image === undefined ? {} : { image }),
            },
            operationSignal,
          )
          operationSignal.throwIfAborted()
          if (pendingUpdates.get(reference.id) !== pending) throw new VisualSearchError('STALE')
          const storedBytes =
            Buffer.byteLength(JSON.stringify(reference)) + (vector?.length ?? 0) * 8
          const previous = rows.get(reference.id)
          const total = bytesStored - (previous?.bytes ?? 0) + storedBytes
          if ((!previous && rows.size >= limits.maxItems) || total > limits.maxTotalBytes)
            throw new VisualSearchError('LIMIT')
          rows.set(reference.id, { ref: reference, vector, bytes: storedBytes })
          bytesStored = total
          generation++
          return {
            id: reference.id,
            contentHash: reference.contentHash,
            profile: capturedProfile ? profileId(capturedProfile) : null,
            mode: embedPort ? ('embedding' as const) : ('metadata-lexical' as const),
            persistent: false as const,
          }
        } finally {
          if (pendingUpdates.get(reference.id) === pending) pendingUpdates.delete(reference.id)
        }
      })
    },
    async remove(id: string, signal?: AbortSignal) {
      ensure()
      validateBoundedString(id, 200, 'reference id')
      return lifecycle.run(signal, limits.timeoutMs, async (operationSignal) => {
        operationSignal.throwIfAborted()
        generation++
        pendingUpdates.get(id)?.abort(new VisualSearchError('STALE'))
        pendingUpdates.delete(id)
        const previous = rows.get(id)
        if (previous) {
          rows.delete(id)
          bytesStored -= previous.bytes
          generation++
        }
      })
    },
    async search(input: {
      text?: string
      image?: { bytes: Uint8Array; mimeType: string }
      filters?: { screen?: string; state?: string; breakpoint?: string }
      limit?: number
      signal?: AbortSignal
    }) {
      ensure()
      const text =
        input.text === undefined
          ? undefined
          : validateText(input.text, limits.maxTextChars, 'query')
      const image = input.image === undefined ? undefined : snapshotImage(input.image, limits)
      const filters = snapshotFilters(input.filters)
      if (text === undefined && image === undefined)
        throw new TypeError('Provide a query image or text')
      if (text !== undefined && image !== undefined)
        throw new TypeError('Provide one visual query input')
      const limit = input.limit ?? 10
      if (!Number.isInteger(limit) || limit < 1 || limit > limits.maxResults)
        throw new VisualSearchError('LIMIT')
      if (!embedPort && image) throw new VisualSearchError('IMAGE_QUERY_UNSUPPORTED')
      return lifecycle.run(input.signal, limits.timeoutMs, async (signal) => {
        const capturedGeneration = generation
        const candidates = [...rows.values()]
          .filter(({ ref }) => !pendingUpdates.has(ref.id) && matches(ref, filters))
          .map(({ ref, vector }) => ({
            ref: structuredClone(ref),
            vector: vector ? [...vector] : null,
          }))
        const query = await embed(
          { ...(text === undefined ? {} : { text }), ...(image === undefined ? {} : { image }) },
          signal,
        )
        signal.throwIfAborted()
        if (capturedGeneration !== generation) throw new VisualSearchError('STALE')
        const ranked = candidates
          .map(({ ref, vector }) => ({
            ref,
            score: query && vector ? cosine(query, vector) : metadataScore(text ?? '', ref),
          }))
          .filter(({ score }) => embedPort !== undefined || score > 0)
          .sort((a, b) => b.score - a.score || a.ref.id.localeCompare(b.ref.id))
          .slice(0, limit)
        return {
          profile: capturedProfile ? profileId(capturedProfile) : null,
          mode: embedPort ? ('embedding' as const) : ('metadata-lexical' as const),
          ephemeral: true as const,
          results: ranked.map(({ ref, score }, index) => ({
            rank: index + 1,
            reference: structuredClone(ref),
            score,
            uncertainty: embedPort
              ? 'embedding similarity is not a visual quality judgment'
              : 'metadata-only; no semantic image retrieval',
            contentHash: ref.contentHash,
          })),
        }
      })
    },
    close() {
      if (closePromise) return closePromise
      closed = true
      for (const update of pendingUpdates.values()) update.abort(new OperationClosedError())
      pendingUpdates.clear()
      closePromise = lifecycle.close().then(() => {
        rows.clear()
        bytesStored = 0
        generation++
      })
      return closePromise
    },
  }
}

function validateLimits(limits: VisualLimits) {
  for (const [key, value] of Object.entries(limits))
    if (!Number.isInteger(value) || value < 1) throw new TypeError(`Invalid visual limit: ${key}`)
  if (
    limits.maxItems > 5000 ||
    limits.maxTextChars > 20000 ||
    limits.maxImageBytes > 10_000_000 ||
    limits.maxResults > 100 ||
    limits.maxTotalBytes > 100_000_000 ||
    limits.maxConcurrency > 8 ||
    limits.timeoutMs > 120000
  )
    throw new TypeError('Visual limits exceed hard caps')
}
function snapshotReference(input: VisualReference, limits: VisualLimits): VisualReference {
  assertKeys(input, ['id', 'contentHash', 'screen', 'state', 'breakpoint', 'text'], 'reference')
  validateBoundedString(input.id, 200, 'reference id')
  validateBoundedString(input.contentHash, 71, 'content hash')
  if (!/^(?:sha256:)?[a-f0-9]{64}$/iu.test(input.contentHash))
    throw new TypeError('Invalid visual content hash')
  const result: VisualReference = { id: input.id, contentHash: input.contentHash.toLowerCase() }
  for (const field of ['screen', 'state', 'breakpoint'] as const) {
    const value = input[field]
    if (value !== undefined) result[field] = validateBoundedString(value, 200, field)
  }
  if (input.text !== undefined)
    result.text = validateText(input.text, limits.maxTextChars, 'reference text')
  return Object.freeze(result)
}
function snapshotImage(input: { bytes: Uint8Array; mimeType: string }, limits: VisualLimits) {
  assertKeys(input, ['bytes', 'mimeType'], 'image')
  if (
    !(input.bytes instanceof Uint8Array) ||
    input.bytes.length < 1 ||
    input.bytes.length > limits.maxImageBytes ||
    typeof input.mimeType !== 'string' ||
    !/^image\/(png|jpeg|webp|gif)$/u.test(input.mimeType)
  )
    throw new TypeError('Invalid visual image input')
  return Object.freeze({ bytes: Uint8Array.from(input.bytes), mimeType: input.mimeType })
}
function snapshotFilters(input?: { screen?: string; state?: string; breakpoint?: string }) {
  if (input === undefined) return undefined
  assertKeys(input, ['screen', 'state', 'breakpoint'], 'filters')
  const result: { screen?: string; state?: string; breakpoint?: string } = {}
  for (const field of ['screen', 'state', 'breakpoint'] as const) {
    const value = input[field]
    if (value !== undefined) result[field] = validateBoundedString(value, 200, `filter ${field}`)
  }
  return Object.freeze(result)
}
function snapshotProfile(input: ProviderProfile): ProviderProfile {
  assertKeys(
    input,
    ['provider', 'model', 'profileId', 'space', 'dimensions', 'inputType', 'routing'],
    'profile',
  )
  for (const field of ['provider', 'model', 'space'] as const)
    validateBoundedString(input[field], 200, `profile ${field}`)
  if (input.profileId !== undefined) validateBoundedString(input.profileId, 200, 'profile id')
  if (input.inputType !== undefined)
    validateBoundedString(input.inputType, 200, 'profile input type')
  if (!Number.isInteger(input.dimensions) || input.dimensions! < 1 || input.dimensions! > 8192)
    throw new TypeError('Visual embedding profile must specify dimensions from 1 to 8192')
  if (
    input.routing !== undefined &&
    (!isRecord(input.routing) || Buffer.byteLength(JSON.stringify(input.routing)) > 2000)
  )
    throw new TypeError('Invalid visual embedding profile routing')
  const clone = structuredClone(input)
  return deepFreeze(clone)
}
function profileId(profile: ProviderProfile) {
  return JSON.stringify([
    profile.provider,
    profile.model,
    profile.profileId ?? null,
    profile.space,
    profile.dimensions,
    profile.inputType ?? null,
  ])
}
function validateText(value: string, max: number, label: string) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max)
    throw new VisualSearchError('LIMIT')
  return value
}
function validateBoundedString(value: string, max: number, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new TypeError(`Invalid visual ${label}`)
  return value
}
function assertKeys(
  value: unknown,
  allowed: string[],
  label: string,
): asserts value is Record<string, any> {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    throw new TypeError(`Invalid visual ${label}`)
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function verifyContentHash(contentHash: string, bytes: Uint8Array) {
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (contentHash.toLowerCase().replace(/^sha256:/u, '') !== actual)
    throw new TypeError('Visual reference content hash does not match supplied data')
}
function matches(r: VisualReference, f?: { screen?: string; state?: string; breakpoint?: string }) {
  return (
    (f?.screen === undefined || r.screen === f.screen) &&
    (f?.state === undefined || r.state === f.state) &&
    (f?.breakpoint === undefined || r.breakpoint === f.breakpoint)
  )
}
function metadataScore(query: string, r: VisualReference) {
  const q = new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  const d = (r.text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return d.reduce((n, t) => n + (q.has(t) ? 1 : 0), 0)
}
function norm(vector: number[]) {
  let scale = 0
  let sum = 1
  for (const value of vector) {
    const absolute = Math.abs(value)
    if (absolute === 0) continue
    if (scale < absolute) {
      sum = 1 + sum * (scale / absolute) ** 2
      scale = absolute
    } else sum += (absolute / scale) ** 2
  }
  return scale === 0 ? 0 : scale * Math.sqrt(sum)
}
function cosine(a: number[], b: number[]) {
  if (a.length !== b.length) return 0
  const scaleA = norm(a)
  const scaleB = norm(b)
  if (!Number.isFinite(scaleA) || !Number.isFinite(scaleB) || scaleA === 0 || scaleB === 0) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += (a[i]! / scaleA) * (b[i]! / scaleB)
  return Number.isFinite(dot) ? Math.max(-1, Math.min(1, dot)) : 0
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}
