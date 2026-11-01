import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { z } from 'zod'

const secretRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('env'), name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/) }).strict(),
  z
    .object({
      kind: z.literal('file'),
      file: z.literal('secrets.json'),
      key: z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/),
    })
    .strict(),
])
const providerLimits = z
  .object({
    maxItems: z.number().int().min(1).max(200).optional(),
    maxInputBytes: z.number().int().min(1).max(8_000_000).optional(),
    maxResponseBytes: z.number().int().min(1).max(16_000_000).optional(),
    timeoutMs: z.number().int().min(1).max(120_000).optional(),
    attempts: z.number().int().min(1).max(4).optional(),
    concurrency: z.number().int().min(1).max(16).optional(),
  })
  .strict()
const braveDiscoveryLimits = providerLimits.extend({
  maxRequestsPerSecond: z.number().int().min(1).max(100).optional(),
}).strict()
const httpsEndpoint = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    } catch {
      return false
    }
  })
const embedding = z
  .object({
    provider: z.enum(['openrouter', 'openai-compatible']),
    profileId: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim().length > 0)
      .optional(),
    model: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim().length > 0),
    dimensions: z.number().int().min(1).max(4096),
    baseUrl: httpsEndpoint.optional(),
    secret: secretRef,
    limits: providerLimits.optional(),
  })
  .strict()
const reranker = z
  .object({
    profileId: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim().length > 0)
      .optional(),
    model: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim().length > 0),
    secret: secretRef,
    limits: providerLimits.optional(),
  })
  .strict()
const classifier = z
  .object({
    profileId: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim().length > 0)
      .optional(),
    model: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim().length > 0),
    secret: secretRef,
    limits: providerLimits.optional(),
  })
  .strict()
const mechanism = z.object({
  code: z.object({ secret: secretRef, limits: providerLimits.optional() }).strict().optional(),
  visual: z.object({ secret: secretRef, limits: providerLimits.optional() }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.code && !value.visual) ctx.addIssue({ code: 'custom', message: 'At least one Mechanism modality is required' })
})
const root = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/),
    path: z.string().min(1).max(4096).refine(isAbsolute),
    label: z.string().max(120).optional(),
    exclude: z.array(z.string().min(1).max(256)).max(128).optional(),
    limits: z
      .object({
        maxFiles: z.number().int().min(1).max(20_000).optional(),
        maxFileBytes: z.number().int().min(1).max(10_000_000).optional(),
        maxTotalBytes: z.number().int().min(1).max(1_000_000_000).optional(),
        maxChunks: z.number().int().min(1).max(50_000).optional(),
        maxChunkChars: z.number().int().min(1).max(32_000).optional(),
        maxQueryChars: z.number().int().min(1).max(10_000).optional(),
        maxScanChunks: z.number().int().min(1).max(50_000).optional(),
        maxResults: z.number().int().min(1).max(500).optional(),
      })
      .strict()
      .optional(),
    watch: z.boolean().optional(),
    watchIntervalMs: z.number().int().min(250).max(60_000).optional(),
  })
  .strict()
export const runtimeConfigSchema = z
  .object({
    version: z.literal(1),
    dataDir: z.string().min(1).max(4096).refine(isAbsolute),
    roots: z.array(root).min(1).max(32),
    embedding: embedding.optional(),
    reranker: reranker.optional(),
    classifier: classifier.optional(),
    mechanism: mechanism.optional(),
    web: z
      .object({
        embedding: embedding.optional(),
        discovery: z
          .object({ secret: secretRef, limits: braveDiscoveryLimits.optional() })
          .strict()
          .optional(),
        limits: providerLimits.optional(),
      })
      .strict()
      .optional(),
    limits: z
      .object({
        maxConcurrency: z.number().int().min(1).max(32).optional(),
        timeoutMs: z.number().int().min(100).max(120_000).optional(),
      })
      .strict()
      .optional(),
    indexing: z
      .object({
        maxConcurrentRoots: z.number().int().min(1).max(4).optional(),
        maxAttempts: z.number().int().min(1).max(32).optional(),
        jobTimeoutMs: z.number().int().min(1000).max(3600000).optional(),
        retryDelayMs: z.number().int().min(100).max(5000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mechanism?.code && value.embedding)
      ctx.addIssue({ code: 'custom', path: ['embedding'], message: 'Legacy embedding cannot be combined with mechanism.code' })
    const ids = new Set<string>()
    for (const item of value.roots) {
      if (ids.has(item.id))
        ctx.addIssue({ code: 'custom', path: ['roots'], message: 'Duplicate root id' })
      ids.add(item.id)
    }
    for (const [path, profile] of [
      [['embedding'], value.embedding],
      [['web', 'embedding'], value.web?.embedding],
    ] as const) {
      if (profile?.provider !== 'openai-compatible') continue
      if (!profile.profileId)
        ctx.addIssue({ code: 'custom', path: [...path, 'profileId'], message: 'Explicit profileId required' })
      if (!profile.baseUrl)
        ctx.addIssue({ code: 'custom', path: [...path, 'baseUrl'], message: 'Owner configured HTTPS baseUrl required' })
    }
  })
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>

export class RuntimeConfigError extends Error {
  constructor(
    readonly code:
      | 'CONFIG_TOO_LARGE'
      | 'CONFIG_INVALID'
      | 'CONFIG_FILE_INVALID'
      | 'SECRET_UNAVAILABLE'
      | 'SECRET_FILE_INVALID'
      | 'ROOT_INVALID',
  ) {
    super(`Search runtime configuration error: ${code}`)
    this.name = 'RuntimeConfigError'
  }
}

export function parseRuntimeConfig(input: unknown): RuntimeConfig {
  let bytes: number
  try {
    bytes = Buffer.byteLength(JSON.stringify(input))
  } catch {
    throw new RuntimeConfigError('CONFIG_INVALID')
  }
  if (bytes > 256 * 1024) throw new RuntimeConfigError('CONFIG_TOO_LARGE')
  const result = runtimeConfigSchema.safeParse(input)
  if (!result.success) throw new RuntimeConfigError('CONFIG_INVALID')
  return deepFreeze(structuredClone(result.data))
}

export async function loadRuntimeConfig(
  path: string,
): Promise<{ config: RuntimeConfig; configDir: string }> {
  const resolved = resolve(path)
  try {
    const text = await readBoundedRegularFile(resolved, 256 * 1024, false)
    const config = parseRuntimeConfig(JSON.parse(text))
    return { config, configDir: await realpath(dirname(resolved)) }
  } catch (error) {
    if (error instanceof RuntimeConfigError) throw error
    throw new RuntimeConfigError('CONFIG_FILE_INVALID')
  }
}

export async function readBoundedRegularFile(
  path: string,
  limit: number,
  privateMode: boolean,
  readChunkBytesForTests = limit + 1,
): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const before = await lstat(path, { bigint: true })
    if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(limit))
      throw new Error('invalid')
    const noFollow = constants.O_NOFOLLOW ?? 0
    handle = await open(path, constants.O_RDONLY | noFollow)
    const info = await handle.stat({ bigint: true })
    if (
      !info.isFile() ||
      info.dev !== before.dev ||
      info.ino !== before.ino ||
      info.size > BigInt(limit) ||
      (privateMode && process.platform !== 'win32' && (info.mode & 0o077n) !== 0n)
    )
      throw new Error('invalid')
    const bytes = Buffer.alloc(limit + 1)
    const maxRead = Math.max(1, Math.min(limit + 1, readChunkBytesForTests))
    let bytesRead = 0
    while (bytesRead < bytes.length) {
      const length = Math.min(maxRead, bytes.length - bytesRead)
      const result = await handle.read(bytes, bytesRead, length, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    if (bytesRead > limit) throw new Error('overflow')
    const after = await handle.stat({ bigint: true })
    if (
      after.dev !== info.dev ||
      after.ino !== info.ino ||
      after.mode !== info.mode ||
      after.size > BigInt(limit) ||
      BigInt(bytesRead) !== after.size ||
      after.mtimeNs !== info.mtimeNs ||
      after.ctimeNs !== info.ctimeNs
    )
      throw new Error('changed')
    return bytes.subarray(0, bytesRead).toString('utf8')
  } catch {
    throw new RuntimeConfigError(privateMode ? 'SECRET_FILE_INVALID' : 'CONFIG_FILE_INVALID')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
