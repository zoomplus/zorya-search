import assert from 'node:assert/strict'
import test from 'node:test'
import { knowledgeHistoryFilterSchema, knowledgeHistoryPageSchema, savedSourcePageSchema } from '../../src/index.js'

test('knowledge history defaults and strict object contracts match the extracted DTO', () => {
  assert.deepEqual(knowledgeHistoryPageSchema.parse({}), { size: 20 })
  assert.deepEqual(knowledgeHistoryFilterSchema.parse({}), {})
  assert.equal(knowledgeHistoryFilterSchema.safeParse({ game: 'Game', extra: true }).success, false)
  assert.equal(savedSourcePageSchema.safeParse({ items: [], extra: true }).success, false)
})
