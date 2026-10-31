import { z } from 'zod'

const idField = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/)
export const statusRequest = z.object({ rootId: idField }).strict()
export const indexRequest = statusRequest
export const searchRequest = z
  .object({
    rootId: idField,
    query: z.string().min(1).max(10_000),
    paths: z.array(z.string().min(1).max(1024)).max(256).optional(),
    language: z.string().min(1).max(64).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    mode: z.enum(['lexical', 'hybrid']).optional(),
  })
  .strict()
export const readRequest = z
  .object({
    rootId: idField,
    path: z.string().min(1).max(1024),
    lineStart: z.number().int().min(1).max(10_000_000).optional(),
    lineEnd: z.number().int().min(1).max(10_000_000).optional(),
    snapshotId: z.string().min(1).max(256).optional(),
  })
  .strict()
export const relatedRequest = z
  .object({
    rootId: idField,
    path: z.string().min(1).max(1024),
    symbol: z.string().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict()
export const contextRequest = z
  .object({
    rootId: idField,
    query: z.string().min(1).max(2000),
    featureQueries: z.array(z.string().min(1).max(2000)).max(8).optional(),
    mustInclude: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1024),
            lineStart: z.number().int().min(1).optional(),
            lineEnd: z.number().int().min(1).optional(),
          })
          .strict(),
      )
      .max(16)
      .optional(),
    includeRelated: z.boolean().optional(),
    maxChars: z.number().int().min(1).max(24_000).optional(),
    limit: z.number().int().min(1).max(40).optional(),
  })
  .strict()
export const webSearchRequest = z
  .object({
    query: z.string().min(1).max(2000),
    limit: z.number().int().min(1).max(100).optional(),
    maxChars: z.number().int().min(1).max(100_000).optional(),
  })
  .strict()
export const webReadRequest = z
  .object({
    url: z.string().min(1).max(2048),
    maxChars: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict()
export const classifyRequest = z
  .object({
    text: z.string().min(1).max(100_000),
    labels: z.array(z.string().min(1).max(256)).min(2).max(100),
    criteria: z.string().min(1).max(10_000),
    examples: z
      .array(
        z.object({ text: z.string().min(1).max(4000), label: z.string().min(1).max(256) }).strict(),
      )
      .max(20)
      .optional(),
    allowMultiple: z.boolean().optional(),
    allowAbstain: z.boolean().optional(),
  })
  .strict()
