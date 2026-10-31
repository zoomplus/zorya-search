import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

import type { SourceDocument } from '../../core/contracts.js'

import { passageSchema } from '../../core/contracts.js'

const dateSchema = z.union([
  z.date().transform((value) => value.toISOString()),
  z.string().datetime(),
])

export const retrievalRowSchema = passageSchema.extend({
  addedAt: dateSchema,
  fetchedAt: dateSchema,
  lastCheckedAt: dateSchema,
  publishedAt: dateSchema.nullable(),
  sourceUpdatedAt: dateSchema.nullable(),
  score: z.coerce.number().finite(),
  indexedAt: dateSchema.nullable(),
})

export function vectorLiteral(vector: number[]): string {
  return `[${z.array(z.number().finite()).min(1).parse(vector).join(',')}]`
}

export function prepareVersions(
  documents: SourceDocument[],
  metadata: { gameVersion?: string; language: string },
) {
  return documents.map((doc) => ({
    id: randomUUID(),
    url: doc.url,
    hash: createHash('sha256').update(doc.text).digest('hex'),
    text: doc.text,
    fetched: doc.fetchedAt,
    published: doc.publishedAt,
    updated: doc.sourceUpdatedAt,
    gameVersion: doc.gameVersion ?? metadata.gameVersion ?? null,
    language: doc.language ?? metadata.language,
  }))
}
