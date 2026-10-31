import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyRequest,
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
