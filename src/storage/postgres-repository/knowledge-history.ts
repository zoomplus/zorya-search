import { legacyUuidSchema } from '../../core/identifiers.js'
import type { OwnedDatabase } from '../database.js'

import { createHash } from 'node:crypto'
import { z } from 'zod'

import {
  KNOWLEDGE_HISTORY_CURSOR_MAX_LENGTH,
  KNOWLEDGE_HISTORY_CURSOR_VERSION,
  KNOWLEDGE_HISTORY_EXCERPT_MAX,
  type KnowledgeHistoryFilterInput,
  type KnowledgeHistoryPageInput,
  type SavedSourcePage,
  type SavedSourceVersionPage,
  knowledgeHistoryCursorTimestamptzUtcSchema,
  knowledgeHistoryFilterSchema,
  knowledgeHistoryPageSchema,
  savedSourceIdSchema,
  savedSourcePageSchema,
  savedSourceVersionPageSchema,
} from '../../core/knowledge-history.js'

const excerptSubquery = `(SELECT coalesce(left((SELECT c.excerpt FROM knowledge_chunks c WHERE c.version_id=cv.id ORDER BY c.ordinal,c.id LIMIT 1),${KNOWLEDGE_HISTORY_EXCERPT_MAX}),''))`

const versionExcerptSubquery = `(SELECT coalesce(left((SELECT c.excerpt FROM knowledge_chunks c WHERE c.version_id=v.id ORDER BY c.ordinal,c.id LIMIT 1),${KNOWLEDGE_HISTORY_EXCERPT_MAX}),''))`

const addedAtCursorUtcSql = `to_char(s.added_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
const fetchedAtCursorUtcSql = `to_char(v.fetched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

const sourceSelect = `s.id::text,s.url,s.title,s.added_at AS "addedAt",${addedAtCursorUtcSql} AS "addedAtCursorUtc",
(SELECT count(*)::int FROM knowledge_versions vc WHERE vc.source_id=s.id) AS "versionCount",
cv.id::text AS "currentVersionId",cv.fetched_at AS "currentFetchedAt",cv.last_checked_at AS "currentLastCheckedAt",
cv.published_at AS "currentPublishedAt",cv.source_updated_at AS "currentSourceUpdatedAt",cv.game AS "currentGame",
cv.game_version AS "currentGameVersion",cv.language AS "currentLanguage",${excerptSubquery} AS "currentExcerpt"`

const versionSelect = `v.id::text,v.fetched_at AS "fetchedAt",${fetchedAtCursorUtcSql} AS "fetchedAtCursorUtc",v.last_checked_at AS "lastCheckedAt",v.published_at AS "publishedAt",
v.source_updated_at AS "sourceUpdatedAt",v.game,v.game_version AS "gameVersion",v.language,${versionExcerptSubquery} AS excerpt,
COALESCE(s.current_version=v.id,false) AS "isCurrent"`

const sourceRowSchema = z.object({
  id: legacyUuidSchema,
  url: z.string().url(),
  title: z.string(),
  addedAt: z.union([z.date(), z.string().datetime()]),
  addedAtCursorUtc: knowledgeHistoryCursorTimestamptzUtcSchema,
  versionCount: z.coerce.number().refine(Number.isInteger).nonnegative(),
  currentVersionId: legacyUuidSchema.nullable(),
  currentFetchedAt: z.union([z.date(), z.string().datetime()]).nullable(),
  currentLastCheckedAt: z.union([z.date(), z.string().datetime()]).nullable(),
  currentPublishedAt: z.union([z.date(), z.string().datetime()]).nullable().optional(),
  currentSourceUpdatedAt: z.union([z.date(), z.string().datetime()]).nullable().optional(),
  currentGame: z.string().nullable().optional(),
  currentGameVersion: z.string().nullable().optional(),
  currentLanguage: z.string().nullable().optional(),
  currentExcerpt: z.string().nullable().optional(),
})

const versionRowSchema = z.object({
  id: legacyUuidSchema,
  fetchedAt: z.union([z.date(), z.string().datetime()]),
  fetchedAtCursorUtc: knowledgeHistoryCursorTimestamptzUtcSchema,
  lastCheckedAt: z.union([z.date(), z.string().datetime()]),
  publishedAt: z.union([z.date(), z.string().datetime()]).nullable().optional(),
  sourceUpdatedAt: z.union([z.date(), z.string().datetime()]).nullable().optional(),
  game: z.string().nullable().optional(),
  gameVersion: z.string().nullable().optional(),
  language: z.string(),
  excerpt: z.string().nullable().optional(),
  isCurrent: z.boolean(),
})

const gameFilterHashSchema = z.string().regex(/^[a-f0-9]{64}$/)

const sourcesCursorPayloadSchema = z
  .object({
    v: z.literal(KNOWLEDGE_HISTORY_CURSOR_VERSION),
    k: z.literal('sources'),
    g: gameFilterHashSchema.nullable(),
    a: knowledgeHistoryCursorTimestamptzUtcSchema,
    i: legacyUuidSchema,
  })
  .strict()

const versionsCursorPayloadSchema = z
  .object({
    v: z.literal(KNOWLEDGE_HISTORY_CURSOR_VERSION),
    k: z.literal('versions'),
    s: legacyUuidSchema,
    f: knowledgeHistoryCursorTimestamptzUtcSchema,
    i: legacyUuidSchema,
  })
  .strict()

const BASE64URL_CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/

function gameFilterCursorKey(game?: string): string | null {
  if (game === undefined) return null
  return createHash('sha256').update(game.toLowerCase(), 'utf8').digest('hex')
}

function decodeCursorUtf8(cursor: string): string {
  if (cursor.length === 0 || cursor.length > KNOWLEDGE_HISTORY_CURSOR_MAX_LENGTH) {
    throw new Error('KNOWLEDGE_HISTORY_CURSOR_INVALID')
  }
  if (!BASE64URL_CURSOR_PATTERN.test(cursor)) throw new Error('KNOWLEDGE_HISTORY_CURSOR_INVALID')
  const decoded = Buffer.from(cursor, 'base64url')
  if (Buffer.from(decoded).toString('base64url') !== cursor) {
    throw new Error('KNOWLEDGE_HISTORY_CURSOR_INVALID')
  }
  if (decoded.length > KNOWLEDGE_HISTORY_CURSOR_MAX_LENGTH)
    throw new Error('KNOWLEDGE_HISTORY_CURSOR_INVALID')
  return decoded.toString('utf8')
}

function encodeCursor(
  payload: z.infer<typeof sourcesCursorPayloadSchema> | z.infer<typeof versionsCursorPayloadSchema>,
): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  if (encoded.length > KNOWLEDGE_HISTORY_CURSOR_MAX_LENGTH)
    throw new Error('KNOWLEDGE_HISTORY_CURSOR_INVALID')
  return encoded
}

function decodeSourcesCursor(
  cursor: string,
  gameFilterKey: string | null,
): { addedAt: string; id: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeCursorUtf8(cursor))
  } catch (error) {
    if (error instanceof Error && error.message === 'KNOWLEDGE_HISTORY_CURSOR_INVALID') throw error
    throw new Error('KNOWLEDGE_HISTORY_CURSOR_INVALID')
  }
  let payload: z.infer<typeof sourcesCursorPayloadSchema>
  try {
    payload = sourcesCursorPayloadSchema.parse(parsed)
  } catch {
    throw new Error('KNOWLEDGE_HISTORY_CURSOR_INVALID')
  }
  if (payload.g !== gameFilterKey) throw new Error('KNOWLEDGE_HISTORY_CURSOR_MISMATCH')
  return { addedAt: payload.a, id: payload.i }
}

function decodeVersionsCursor(cursor: string, sourceId: string): { fetchedAt: string; id: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeCursorUtf8(cursor))
  } catch (error) {
    if (error instanceof Error && error.message === 'KNOWLEDGE_HISTORY_CURSOR_INVALID') throw error
    throw new Error('KNOWLEDGE_HISTORY_CURSOR_INVALID')
  }
  let payload: z.infer<typeof versionsCursorPayloadSchema>
  try {
    payload = versionsCursorPayloadSchema.parse(parsed)
  } catch {
    throw new Error('KNOWLEDGE_HISTORY_CURSOR_INVALID')
  }
  if (payload.s !== sourceId) throw new Error('KNOWLEDGE_HISTORY_CURSOR_MISMATCH')
  return { fetchedAt: payload.f, id: payload.i }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function toIsoNullable(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return toIso(value)
}

function mapCurrentVersion(row: z.infer<typeof sourceRowSchema>) {
  if (
    !row.currentVersionId ||
    !row.currentFetchedAt ||
    !row.currentLastCheckedAt ||
    !row.currentLanguage
  ) {
    return null
  }
  return {
    versionId: row.currentVersionId,
    fetchedAt: toIso(row.currentFetchedAt),
    lastCheckedAt: toIso(row.currentLastCheckedAt),
    publishedAt: toIsoNullable(row.currentPublishedAt),
    sourceUpdatedAt: toIsoNullable(row.currentSourceUpdatedAt),
    game: row.currentGame ?? null,
    gameVersion: row.currentGameVersion ?? null,
    language: row.currentLanguage,
    excerpt: row.currentExcerpt ?? '',
  }
}

function mapSourceRow(row: z.infer<typeof sourceRowSchema>) {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    addedAt: toIso(row.addedAt),
    versionCount: row.versionCount,
    current: mapCurrentVersion(row),
  }
}

function mapVersionRow(row: z.infer<typeof versionRowSchema>) {
  return {
    id: row.id,
    fetchedAt: toIso(row.fetchedAt),
    lastCheckedAt: toIso(row.lastCheckedAt),
    publishedAt: toIsoNullable(row.publishedAt),
    sourceUpdatedAt: toIsoNullable(row.sourceUpdatedAt),
    game: row.game ?? null,
    gameVersion: row.gameVersion ?? null,
    language: row.language,
    excerpt: row.excerpt ?? '',
    isCurrent: row.isCurrent,
  }
}

export async function listSavedSourcesPage(
  database: OwnedDatabase,
  filterInput: KnowledgeHistoryFilterInput | undefined,
  pageInput: KnowledgeHistoryPageInput | undefined,
  signal: AbortSignal,
): Promise<SavedSourcePage> {
  const filter = knowledgeHistoryFilterSchema.parse(filterInput ?? {})
  const page = knowledgeHistoryPageSchema.parse(pageInput ?? {})
  signal.throwIfAborted()
  const gameFilterKey = gameFilterCursorKey(filter.game)
  const gameValue = filter.game === undefined ? null : filter.game.toLowerCase()
  const values: unknown[] = []
  const filters: string[] = []
  if (gameValue !== null) {
    values.push(gameValue)
    filters.push(
      `EXISTS (SELECT 1 FROM knowledge_versions vg WHERE vg.source_id=s.id AND lower(vg.game)=$${values.length})`,
    )
  }
  if (page.cursor) {
    const cursor = decodeSourcesCursor(page.cursor, gameFilterKey)
    values.push(cursor.addedAt, cursor.id)
    filters.push(`(s.added_at,s.id)>($${values.length - 1}::timestamptz,$${values.length}::uuid)`)
  }
  const where = filters.length ? filters.join(' AND ') : 'TRUE'
  values.push(page.size + 1)
  const limitParam = values.length
  const sql = `SELECT ${sourceSelect} FROM knowledge_sources s
LEFT JOIN knowledge_versions cv ON cv.id=s.current_version AND cv.source_id=s.id
WHERE ${where} ORDER BY s.added_at ASC,s.id ASC LIMIT $${limitParam}`
  const result = await database.query(sql, values)
  signal.throwIfAborted()
  const rows = result.rows.map((row) => sourceRowSchema.parse(row))
  const hasMore = rows.length > page.size
  const pageRows = hasMore ? rows.slice(0, page.size) : rows
  const items = pageRows.map((row) => mapSourceRow(row))
  let nextCursor: string | undefined
  if (hasMore) {
    const last = pageRows.at(-1)
    if (!last) throw new Error('KNOWLEDGE_HISTORY_PAGE_INCOMPLETE')
    nextCursor = encodeCursor({
      v: KNOWLEDGE_HISTORY_CURSOR_VERSION,
      k: 'sources',
      g: gameFilterKey,
      a: last.addedAtCursorUtc,
      i: last.id,
    })
  }
  return savedSourcePageSchema.parse({ items, nextCursor })
}

export async function listSavedSourceVersionsPage(
  database: OwnedDatabase,
  sourceIdInput: string,
  pageInput: KnowledgeHistoryPageInput | undefined,
  signal: AbortSignal,
): Promise<SavedSourceVersionPage> {
  const sourceId = savedSourceIdSchema.parse(sourceIdInput)
  const page = knowledgeHistoryPageSchema.parse(pageInput ?? {})
  signal.throwIfAborted()
  const values: unknown[] = [sourceId]
  const filters = ['v.source_id=$1']
  let cursorPosition: { fetchedAt: string; id: string } | undefined
  if (page.cursor) cursorPosition = decodeVersionsCursor(page.cursor, sourceId)
  const exists = await database.query('SELECT id::text FROM knowledge_sources WHERE id=$1', [
    sourceId,
  ])
  signal.throwIfAborted()
  if (!exists.rows[0]) throw new Error('KNOWLEDGE_HISTORY_SOURCE_NOT_FOUND')
  if (cursorPosition) {
    values.push(cursorPosition.fetchedAt, cursorPosition.id)
    filters.push(`(v.fetched_at,v.id)>($${values.length - 1}::timestamptz,$${values.length}::uuid)`)
  }
  values.push(page.size + 1)
  const limitParam = values.length
  const sql = `SELECT ${versionSelect} FROM knowledge_versions v
JOIN knowledge_sources s ON s.id=v.source_id
WHERE ${filters.join(' AND ')} ORDER BY v.fetched_at ASC,v.id ASC LIMIT $${limitParam}`
  const result = await database.query(sql, values)
  signal.throwIfAborted()
  const rows = result.rows.map((row) => versionRowSchema.parse(row))
  const hasMore = rows.length > page.size
  const pageRows = hasMore ? rows.slice(0, page.size) : rows
  const items = pageRows.map((row) => mapVersionRow(row))
  let nextCursor: string | undefined
  if (hasMore) {
    const last = pageRows.at(-1)
    if (!last) throw new Error('KNOWLEDGE_HISTORY_PAGE_INCOMPLETE')
    nextCursor = encodeCursor({
      v: KNOWLEDGE_HISTORY_CURSOR_VERSION,
      k: 'versions',
      s: sourceId,
      f: last.fetchedAtCursorUtc,
      i: last.id,
    })
  }
  return savedSourceVersionPageSchema.parse({ items, nextCursor })
}
