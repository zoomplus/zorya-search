import { legacyUuidSchema } from './identifiers.js'
import { z } from 'zod'

// Схемы сохранены в той же форме, что и исходные контракты снимка извлечения.
const PAGE_SIZE_DEFAULT = 20
const PAGE_SIZE_MAX = 50
export const KNOWLEDGE_HISTORY_EXCERPT_MAX = 1200
export const KNOWLEDGE_HISTORY_CURSOR_MAX_LENGTH = 512
export const KNOWLEDGE_HISTORY_CURSOR_VERSION = 1
export const knowledgeHistoryCursorTimestamptzUtcSchema = z.string().datetime({ precision: 6 })
export const knowledgeHistoryFilterSchema = z.object({ game: z.string().min(1).max(300).optional() }).strict()
export type KnowledgeHistoryFilter = z.infer<typeof knowledgeHistoryFilterSchema>
export type KnowledgeHistoryFilterInput = z.input<typeof knowledgeHistoryFilterSchema>
export const knowledgeHistoryPageSchema = z.object({
  size: z.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  cursor: z.string().min(1).max(KNOWLEDGE_HISTORY_CURSOR_MAX_LENGTH).optional(),
}).strict()
export type KnowledgeHistoryPage = z.infer<typeof knowledgeHistoryPageSchema>
export type KnowledgeHistoryPageInput = z.input<typeof knowledgeHistoryPageSchema>
const historyDateSchema = z.union([z.date().transform((value) => value.toISOString()), z.string().datetime()])
export const savedSourceIdSchema = legacyUuidSchema
export const savedSourceCurrentVersionSchema = z.object({
  versionId: legacyUuidSchema, fetchedAt: historyDateSchema, lastCheckedAt: historyDateSchema,
  publishedAt: historyDateSchema.nullable(), sourceUpdatedAt: historyDateSchema.nullable(),
  game: z.string().nullable(), gameVersion: z.string().nullable(), language: z.string(),
  excerpt: z.string().max(KNOWLEDGE_HISTORY_EXCERPT_MAX),
}).strict()
export const savedSourceSchema = z.object({
  id: legacyUuidSchema, url: z.string().url(), title: z.string(), addedAt: historyDateSchema,
  versionCount: z.number().refine(Number.isInteger).nonnegative(), current: savedSourceCurrentVersionSchema.nullable(),
}).strict()
export type SavedSource = z.infer<typeof savedSourceSchema>
export const savedSourcePageSchema = z.object({ items: z.array(savedSourceSchema), nextCursor: z.string().max(KNOWLEDGE_HISTORY_CURSOR_MAX_LENGTH).optional() }).strict()
export type SavedSourcePage = z.infer<typeof savedSourcePageSchema>
export const savedSourceVersionSchema = z.object({
  id: legacyUuidSchema, fetchedAt: historyDateSchema, lastCheckedAt: historyDateSchema,
  publishedAt: historyDateSchema.nullable(), sourceUpdatedAt: historyDateSchema.nullable(),
  game: z.string().nullable(), gameVersion: z.string().nullable(), language: z.string(),
  excerpt: z.string().max(KNOWLEDGE_HISTORY_EXCERPT_MAX), isCurrent: z.boolean(),
}).strict()
export type SavedSourceVersion = z.infer<typeof savedSourceVersionSchema>
export const savedSourceVersionPageSchema = z.object({ items: z.array(savedSourceVersionSchema), nextCursor: z.string().max(KNOWLEDGE_HISTORY_CURSOR_MAX_LENGTH).optional() }).strict()
export type SavedSourceVersionPage = z.infer<typeof savedSourceVersionPageSchema>
