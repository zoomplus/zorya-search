import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyRequest,
  visualSearchRequest,
  contextRequest,
  readRequest,
  searchRequest,
} from '../../src/runtime/requests.js'

test('shared MCP/runtime schemas keep owner paths and credentials out of tool inputs', () => {
  assert.equal(
    searchRequest.safeParse({ rootId: 'repo', query: 'needle', mode: 'lexical' }).success,
    true,
  )
  assert.equal(
    searchRequest.safeParse({ rootId: 'repo', query: 'needle', root: '/etc' }).success,
    false,
  )
  assert.equal(
    searchRequest.safeParse({ rootId: 'repo', query: 'needle', credentials: { token: 'x' } })
      .success,
    false,
  )
  assert.equal(
    searchRequest.safeParse({ rootId: 'repo', query: 'needle', testDependencies: {} }).success,
    false,
  )
  assert.equal(
    readRequest.safeParse({ rootId: 'repo', path: 'src/a.ts', signal: {} }).success,
    false,
  )
  assert.equal(
    contextRequest.safeParse({
      rootId: 'repo',
      query: 'needle',
      mustInclude: [{ path: 'src/a.ts', callback: 'x' }],
    }).success,
    false,
  )
  assert.equal(
    classifyRequest.safeParse({
      text: 'untrusted input',
      labels: ['a', 'b'],
      criteria: 'choose',
      fetch: true,
    }).success,
    false,
  )
})

test('visual request accepts bounded caller-supplied bytes and rejects URL or path access', () => {
  const valid = {
    references: [{ id: 'button', contentHash: 'a'.repeat(64), image: { mimeType: 'image/png', dataBase64: 'AQID' } }],
    queryText: 'save button',
  }
  assert.equal(visualSearchRequest.safeParse(valid).success, true)
  assert.equal(visualSearchRequest.safeParse({ ...valid, queryImage: { mimeType: 'image/png', dataBase64: 'AQID' } }).success, false)
  assert.equal(visualSearchRequest.safeParse({ ...valid, references: [{ ...valid.references[0], image: undefined, text: 'save', url: 'https://example.test/image.png' }] }).success, false)
  assert.equal(visualSearchRequest.safeParse({ ...valid, queryText: undefined, queryImage: { mimeType: 'image/svg+xml', dataBase64: 'AQID' } }).success, false)
})
