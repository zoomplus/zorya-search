import { legacyUuidSchema } from './identifiers.js'
import { z } from 'zod'

export const embeddingProfileSchema = z
  .object({
    space: z.string().min(1).max(300),
    model: z.string().min(1).max(256),
    dimensions: z.number().int().min(1).max(4096),
    encoding: z.literal('float'),
    chunker: z.string().min(1).max(100),
  })
  .strict()
export type EmbeddingProfile = z.infer<typeof embeddingProfileSchema>
export const searchEmbeddingProfile: EmbeddingProfile = Object.freeze({
  space: 'perplexity/pplx-embed-v1-4b:2560:chunks4000-overlap300',
  model: 'perplexity/pplx-embed-v1-4b',
  dimensions: 2560,
  encoding: 'float',
  chunker: 'chunks4000-overlap300',
})
export const reindexChunkSchema = z
  .object({
    versionId: legacyUuidSchema,
    ordinal: z.number().int().nonnegative(),
    text: z.string().min(1),
  })
  .strict()
export type ReindexChunk = z.infer<typeof reindexChunkSchema>
export const reindexPayloadSchema = z
  .object({
    profile: embeddingProfileSchema,
    chunks: z.array(reindexChunkSchema).min(1).max(32),
  })
  .strict()
export type ReindexPayload = z.infer<typeof reindexPayloadSchema>
export interface ReindexRepository {
  registerProfile(profile: EmbeddingProfile): Promise<void>
  missingChunks(
    profile: EmbeddingProfile,
    after?: { versionId: string; ordinal: number },
  ): Promise<ReindexChunk[]>
  writeReindexed(
    input: {
      id: string
      token: string
      profile: EmbeddingProfile
      chunks: ReindexChunk[]
      vectors: number[][]
    },
    signal: AbortSignal,
  ): Promise<number>
}
export interface ReindexLease {
  id: string
  token: string
  attempt: number
  payload?: unknown
}
export interface ReindexQueue {
  enqueue(input: { key: string; kind: string; payload: unknown }): Promise<{ id: string }>
  lease(leaseMs: number, kind?: string): Promise<ReindexLease | undefined>
  heartbeat(id: string, token: string, leaseMs: number): Promise<boolean>
  finish(id: string, token: string, result: unknown): Promise<boolean>
  retry(id: string, token: string, delayMs: number, error: string): Promise<boolean>
  fail(id: string, token: string, error: string): Promise<boolean>
}
