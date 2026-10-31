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
const visualImage = z.object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), dataBase64: z.string().min(4).max(2_800_000) }).strict()
const visualReference = z.object({
  id: z.string().min(1).max(200), contentHash: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/iu),
  screen: z.string().min(1).max(200).optional(), state: z.string().min(1).max(200).optional(), breakpoint: z.string().min(1).max(200).optional(),
  text: z.string().min(1).max(4000).optional(), image: visualImage.optional(),
}).strict().refine((v) => Number(Boolean(v.text)) + Number(Boolean(v.image)) === 1)
export const visualSearchRequest = z.object({
  references: z.array(visualReference).min(1).max(12),
  queryText: z.string().min(1).max(4000).optional(), queryImage: visualImage.optional(), limit: z.number().int().min(1).max(5).optional(),
}).strict().refine((v) => Number(Boolean(v.queryText)) + Number(Boolean(v.queryImage)) === 1)
