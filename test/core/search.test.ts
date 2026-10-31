import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSearchQueries, canonicalUrl, chunkDocuments, reciprocalRankFusion, searchRequestSchema } from '../../src/index.js'

test('search request defaults and bounds match the legacy contract', () => {
  assert.deepEqual(searchRequestSchema.parse({ query: 'x' }), {
    query: 'x', context: '', language: 'ru', targetSources: 100,
    maxAttempts: 300, concurrency: 6, collectionTimeoutMs: 120000,
  })
})
test('legacy URL canonicalization and chunks remain stable', () => {
  assert.equal(canonicalUrl('https://example.test/a?utm_source=x&b=2#frag'), 'https://example.test/a?b=2')
  assert.deepEqual(chunkDocuments([{url:'https://x.test',title:'x',text:'a'.repeat(4100),fetchedAt:new Date(0).toISOString(),publishedAt:null,sourceUpdatedAt:null}],4000,300).map(x=>x.text.length), [4000,400])
})
test('search query expansion and reciprocal rank fusion preserve deterministic ranking', () => {
  const req = searchRequestSchema.parse({ query:'босс', game:'Game' })
  assert.equal(buildSearchQueries(req)[0], 'Game босс')
  const passage = {id:'a',url:'https://x.test',title:'x',excerpt:'x',score:0,addedAt:'2024-01-01T00:00:00.000Z',fetchedAt:'2024-01-01T00:00:00.000Z',lastCheckedAt:'2024-01-01T00:00:00.000Z',publishedAt:null,sourceUpdatedAt:null}
  assert.equal(reciprocalRankFusion([[passage],[passage]],10)[0]?.score, 2/61)
})
