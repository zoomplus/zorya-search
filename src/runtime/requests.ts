import { z } from 'zod'
import { webDateRangeSchema } from '../core/contracts.js'

const idField = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/)
export const statusRequest = z.object({ rootId: idField }).strict()
export const indexStatusRequest = z.object({ rootId: idField, jobId: z.string().uuid().optional() }).strict()
export const indexRequest = statusRequest
export const indexCodeSymbolsRequest = statusRequest
export const startIndexingRequest = statusRequest
export const cancelIndexingRequest = z.object({ rootId: idField, jobId: z.string().uuid() }).strict()
export const searchRequest = z
  .object({
    rootId: idField,
    query: z.string().min(1).max(10_000),
    paths: z.array(z.string().min(1).max(1024)).max(256).optional(),
    language: z.string().min(1).max(64).refine((value) => Boolean(value.trim())).optional(),
    sourceKind: z.enum(['implementation', 'tests', 'documentation', 'all']).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    mode: z.enum(['lexical', 'hybrid']).optional(),
  })
  .strict()
export const codeDuplicatesRequest = z
  .object({
    rootId: idField,
    paths: z.array(z.string().min(1).max(1024)).max(256).optional(),
    language: z
      .string()
      .min(1)
      .max(64)
      .refine((value) => Boolean(value.trim()))
      .optional(),
    sourceKind: z.enum(['implementation', 'tests', 'documentation', 'all']).optional(),
    matchMode: z.enum(['exact', 'renamed']).optional(),
    minTokens: z.number().int().min(12).max(5000).optional(),
    minOccurrences: z.number().int().min(2).max(50).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    maxOccurrencesPerGroup: z.number().int().min(2).max(50).optional(),
  })
  .strict()
export const findCodeSymbolsRequest = z.object({
  rootId: idField,
  query: z.string().max(256).optional(),
  name: z.string().max(256).optional(),
  path: z.string().min(1).max(1024).optional(),
  symbolId: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  enclosing: z.object({
    path: z.string().min(1).max(1024),
    lineStart: z.number().int().min(1).max(2_147_483_647),
    lineEnd: z.number().int().min(1).max(2_147_483_647).optional(),
  }).strict().refine((range) => range.lineEnd === undefined || range.lineEnd >= range.lineStart).optional(),
  language: z.string().min(1).max(64).refine((value) => Boolean(value.trim())).optional(),
  sourceKind: z.enum(['implementation', 'tests', 'documentation', 'all']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(4096).optional(),
}).strict()
export const findCodeReferencesRequest = z.object({
  rootId: idField,
  symbolId: z.string().regex(/^[a-f0-9]{64}$/u),
  direction: z.enum(['incoming', 'outgoing']).optional(),
  kind: z.enum(['reference', 'call', 'construct', 'export']).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).max(4096).optional(),
}).strict()
export const traceCodeCallsRequest = z.object({
  rootId: idField,
  symbolId: z.string().regex(/^[a-f0-9]{64}$/u),
  direction: z.enum(['incoming', 'outgoing', 'both']).optional(),
  maxDepth: z.number().int().min(0).max(4).optional(),
  maxNodes: z.number().int().min(1).max(256).optional(),
  maxEdges: z.number().int().min(1).max(1024).optional(),
}).strict()
export const readRequest = z
  .object({
    rootId: idField,
    path: z.string().min(1).max(1024),
    lineStart: z.number().int().min(1).max(10_000_000).optional(),
    lineEnd: z.number().int().min(1).max(10_000_000).optional(),
    snapshotId: z.string().min(1).max(256).optional(),
  })
  .strict()
const projectTextKind = z.enum(['documentation', 'rules', 'skills'])
export const projectTextSearchRequest = z
  .object({
    rootId: idField,
    query: z.string().min(1).max(10_000),
    kinds: z.array(projectTextKind).max(3).optional(),
    paths: z.array(z.string().min(1).max(1024)).max(256).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    mode: z.enum(['lexical', 'hybrid']).optional(),
    maxChars: z.number().int().min(1).max(24_000).optional(),
  })
  .strict()
  .refine((value) => !value.kinds || new Set(value.kinds).size === value.kinds.length)
export const projectTextReadRequest = z
  .object({
    rootId: idField,
    path: z.string().min(1).max(1024),
    lineStart: z.number().int().min(1).max(10_000_000).optional(),
    lineEnd: z.number().int().min(1).max(10_000_000).optional(),
    snapshotId: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine((value) => value.lineEnd === undefined || value.lineEnd >= (value.lineStart ?? 1))
  .refine(
    (value) => value.lineEnd === undefined || value.lineEnd - (value.lineStart ?? 1) + 1 <= 200,
  )
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
    language: z.string().min(1).max(64).refine((value) => Boolean(value.trim())).optional(),
    sourceKind: z.enum(['implementation', 'tests', 'documentation', 'all']).optional(),
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
    includeLogical: z.boolean().optional(),
    relatedDepth: z.number().int().min(1).max(4).optional(),
    relatedMaxPaths: z.number().int().min(1).max(64).optional(),
    maxChars: z.number().int().min(1).max(24_000).optional(),
    limit: z.number().int().min(1).max(40).optional(),
  })
  .strict()
  .refine((value) => (value.relatedDepth === undefined && value.relatedMaxPaths === undefined) || value.includeRelated === true)
export const reuseContextRequest = z.object({
  rootId: idField,
  query: z.string().min(1).max(2000),
  maxChars: z.number().int().min(1000).max(48_000).optional(),
  limit: z.number().int().min(1).max(40).optional(),
}).strict()
export const webSearchRequest = z
  .object({
    query: z.string().min(1).max(2000),
    limit: z.number().int().min(1).max(100).optional(),
    maxChars: z.number().int().min(1).max(100_000).optional(),
    dateRange: webDateRangeSchema.optional(),
    additionalQueries: z
      .array(z.string().min(1).max(2000).refine((query) => query.trim().length > 0))
      .max(7)
      .optional(),
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
