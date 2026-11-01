import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyRequest,
  visualSearchRequest,
  contextRequest,
  readRequest,
  searchRequest,
  codeDuplicatesRequest,
  cancelIndexingRequest,
  webSearchRequest,
} from '../../src/runtime/requests.js'
import { SEARCH_MCP_TOOL_CONTRACTS } from '../../src/mcp/server.js'

test('shared MCP/runtime schemas keep owner paths and credentials out of tool inputs', () => {
  assert.equal(SEARCH_MCP_TOOL_CONTRACTS.find_code_duplicates.annotations.readOnlyHint, true)
  assert.equal(SEARCH_MCP_TOOL_CONTRACTS.find_code_duplicates.annotations.idempotentHint, true)
  assert.equal(SEARCH_MCP_TOOL_CONTRACTS.find_code_duplicates.annotations.openWorldHint, false)
  assert.equal(codeDuplicatesRequest.safeParse({ rootId: 'repo', matchMode: 'renamed', limit: 20 }).success, true)
  assert.equal(codeDuplicatesRequest.safeParse({ rootId: 'repo', extra: true }).success, false)
  assert.equal(SEARCH_MCP_TOOL_CONTRACTS.start_indexing.annotations.openWorldHint, true)
  assert.equal(SEARCH_MCP_TOOL_CONTRACTS.cancel_indexing.annotations.openWorldHint, false)
  assert.equal(cancelIndexingRequest.safeParse({ rootId: 'repo', jobId: '00000000-0000-4000-8000-000000000000' }).success, true)
  assert.equal(cancelIndexingRequest.safeParse({ rootId: 'repo', jobId: '00000000-0000-4000-8000-000000000000', pid: 1 }).success, false)
  assert.equal(
    searchRequest.safeParse({ rootId: 'repo', query: 'needle', mode: 'lexical' }).success,
    true,
  )
  assert.equal(searchRequest.safeParse({ rootId: 'repo', query: 'needle', language: 'typescript', sourceKind: 'implementation' }).success, true)
  assert.equal(searchRequest.safeParse({ rootId: 'repo', query: 'needle', sourceKind: 'unknown' }).success, false)
  assert.equal(searchRequest.safeParse({ rootId: 'repo', query: 'needle', language: '   ' }).success, false)
  assert.equal(searchRequest.safeParse({ rootId: 'repo', query: 'needle', language: ' RUST ' }).data?.language, ' RUST ')
  assert.equal(contextRequest.safeParse({ rootId: 'repo', query: 'needle', language: 'javascript', sourceKind: 'documentation' }).success, true)
  assert.equal(contextRequest.safeParse({ rootId: 'repo', query: 'needle', sourceKind: 'unknown' }).success, false)
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
  assert.equal(contextRequest.safeParse({ rootId: 'repo', query: 'needle', includeRelated: true, relatedDepth: 4, relatedMaxPaths: 64 }).success, true)
  assert.equal(contextRequest.safeParse({ rootId: 'repo', query: 'needle', relatedDepth: 2 }).success, false)
  assert.equal(contextRequest.safeParse({ rootId: 'repo', query: 'needle', includeRelated: true, relatedDepth: 5 }).success, false)
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

test('web search date range is strict and accepts only ordered real calendar dates', () => {
  assert.equal(webSearchRequest.safeParse({ query: 'patch notes', dateRange: { from: '2024-02-29', through: '2024-03-01' } }).success, true)
  for (const dateRange of [
    { from: '2023-02-29', through: '2023-03-01' },
    { from: '2024-03-02', through: '2024-03-01' },
    { from: '2024-01-01', through: '2024-02-01', recent: true },
  ]) {
    assert.equal(webSearchRequest.safeParse({ query: 'patch notes', dateRange }).success, false)
  }
})
