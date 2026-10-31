import assert from 'node:assert/strict'
import test from 'node:test'
import * as search from '../../src/index.js'
import { schemaCompatibilityCorpus } from '../fixtures/schema-compatibility-corpus.js'

const schemas = search as unknown as Record<string, { safeParse(input: unknown): { success: boolean } }>

test('public schema compatibility corpus keeps acceptance, bounds, defaults, and strictness', () => {
  for (const item of schemaCompatibilityCorpus) {
    const schema = schemas[item.schema]
    assert.ok(schema, `missing public schema ${item.schema}`)
    assert.equal(schema.safeParse(item.input).success, item.success, item.name)
  }
})

test('public request and history defaults retain their parsed DTO values', () => {
  assert.deepEqual(search.searchRequestSchema.parse({ query: 'question' }), {
    query: 'question', context: '', language: 'ru', targetSources: 100,
    maxAttempts: 300, concurrency: 6, collectionTimeoutMs: 120000,
  })
  assert.deepEqual(search.searchRequestSchema.parse({ query: 'question', freshness: {} }).freshness, { latest: false })
  assert.deepEqual(search.knowledgeHistoryPageSchema.parse({}), { size: 20 })
  const parsed = search.savedSourceCurrentVersionSchema.parse({
    versionId: '018f0a88-5d99-7abc-8def-123456789abc',
    fetchedAt: new Date('2026-10-31T12:34:56.123Z'), lastCheckedAt: '2026-10-31T12:34:56.123Z',
    publishedAt: null, sourceUpdatedAt: null, game: null, gameVersion: null, language: 'en', excerpt: 'text',
  })
  assert.equal(parsed.fetchedAt, '2026-10-31T12:34:56.123Z')
})
