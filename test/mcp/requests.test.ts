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
  findCodeSymbolsRequest,
  findCodeReferencesRequest,
  traceCodeCallsRequest,
  webSearchRequest,
  projectTextSearchRequest,
  projectTextReadRequest,
  reuseContextRequest,
} from '../../src/runtime/requests.js'
import { SEARCH_MCP_TOOL_CONTRACTS, requiredOperationsForTool } from '../../src/mcp/server.js'

test('shared MCP/runtime schemas keep owner paths and credentials out of tool inputs', () => {
  assert.deepEqual(requiredOperationsForTool('get_reuse_context'), ['read', 'classify'])
  assert.equal(requiredOperationsForTool('toString'), undefined)
  assert.equal(requiredOperationsForTool('__proto__'), undefined)
  assert.equal(SEARCH_MCP_TOOL_CONTRACTS.get_reuse_context.annotations.readOnlyHint, true)
  assert.equal(SEARCH_MCP_TOOL_CONTRACTS.get_reuse_context.annotations.openWorldHint, true)
  assert.equal(reuseContextRequest.safeParse({ rootId: 'repo', query: 'change lookup', maxChars: 48_000, limit: 40 }).success, true)
  assert.equal(reuseContextRequest.safeParse({ rootId: 'repo', query: 'x', maxChars: 48_001 }).success, false)
  assert.equal(reuseContextRequest.safeParse({ rootId: 'repo', query: 'x', signal: {} }).success, false)
  assert.equal(reuseContextRequest.safeParse({ rootId: 'repo', query: 'x', includeLogical: true }).success, false)
  assert.equal(SEARCH_MCP_TOOL_CONTRACTS.index_code_symbols.annotations.readOnlyHint, false)
  assert.equal(SEARCH_MCP_TOOL_CONTRACTS.index_code_symbols.annotations.idempotentHint, false)
  assert.equal(SEARCH_MCP_TOOL_CONTRACTS.index_code_symbols.annotations.openWorldHint, false)
  assert.equal(SEARCH_MCP_TOOL_CONTRACTS.index_code_symbols.annotations.destructiveHint, false)
  for (const name of ['find_code_symbols', 'find_code_references', 'trace_code_calls'] as const) {
    assert.equal(SEARCH_MCP_TOOL_CONTRACTS[name].annotations.readOnlyHint, true)
    assert.equal(SEARCH_MCP_TOOL_CONTRACTS[name].annotations.idempotentHint, true)
    assert.equal(SEARCH_MCP_TOOL_CONTRACTS[name].annotations.openWorldHint, false)
  }
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
  assert.equal(contextRequest.safeParse({ rootId: 'repo', query: 'needle', includeLogical: true }).success, true)
  assert.equal(contextRequest.safeParse({ rootId: 'repo', query: 'needle', includeLogical: 'yes' }).success, false)
  assert.equal(contextRequest.safeParse({ rootId: 'repo', query: 'needle', includeLogical: true, internal: true }).success, false)
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

test('symbol requests enforce bounded inputs, valid IDs and strict fields', () => {
  const symbolId = 'a'.repeat(64)
  assert.equal(findCodeSymbolsRequest.safeParse({ rootId: 'repo', query: 'worker', limit: 100, cursor: 'opaque' }).success, true)
  assert.equal(findCodeSymbolsRequest.safeParse({ rootId: 'repo', symbolId, enclosing: { path: 'src/a.ts', lineStart: 2, lineEnd: 4 } }).success, true)
  assert.equal(findCodeSymbolsRequest.safeParse({ rootId: 'repo', symbolId: 'bad' }).success, false)
  assert.equal(findCodeSymbolsRequest.safeParse({ rootId: 'repo', enclosing: { path: 'src/a.ts', lineStart: 0 } }).success, false)
  assert.equal(findCodeSymbolsRequest.safeParse({ rootId: 'repo', enclosing: { path: 'src/a.ts', lineStart: 4, lineEnd: 2 } }).success, false)
  assert.equal(findCodeSymbolsRequest.safeParse({ rootId: 'repo', enclosing: { path: 'src/a.ts', lineStart: 2_147_483_648 } }).success, false)
  assert.equal(findCodeSymbolsRequest.safeParse({ rootId: 'repo', query: 'x'.repeat(257) }).success, false)
  assert.equal(findCodeSymbolsRequest.safeParse({ rootId: 'repo', path: 'x'.repeat(1025) }).success, false)
  assert.equal(findCodeSymbolsRequest.safeParse({ rootId: 'repo', limit: 101 }).success, false)
  assert.equal(findCodeSymbolsRequest.safeParse({ rootId: 'repo', cursor: 'x'.repeat(4097) }).success, false)
  assert.equal(findCodeSymbolsRequest.safeParse({ rootId: 'repo', surprise: true }).success, false)
  assert.equal(findCodeReferencesRequest.safeParse({ rootId: 'repo', symbolId, direction: 'incoming', kind: 'call', limit: 200 }).success, true)
  assert.equal(findCodeReferencesRequest.safeParse({ rootId: 'repo', symbolId: 'bad' }).success, false)
  assert.equal(findCodeReferencesRequest.safeParse({ rootId: 'repo', symbolId, direction: 'both' }).success, false)
  assert.equal(findCodeReferencesRequest.safeParse({ rootId: 'repo', symbolId, limit: 201 }).success, false)
  assert.equal(traceCodeCallsRequest.safeParse({ rootId: 'repo', symbolId, direction: 'both', maxDepth: 4, maxNodes: 256, maxEdges: 1024 }).success, true)
  assert.equal(traceCodeCallsRequest.safeParse({ rootId: 'repo', symbolId, maxDepth: 5 }).success, false)
  assert.equal(traceCodeCallsRequest.safeParse({ rootId: 'repo', symbolId, maxNodes: 257 }).success, false)
  assert.equal(traceCodeCallsRequest.safeParse({ rootId: 'repo', symbolId, signal: {} }).success, false)
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

test('project text inputs strictly bound source kinds, query budgets, filters, and read ranges', () => {
  assert.equal(
    projectTextSearchRequest.safeParse({ rootId: 'repo', query: 'setup', kinds: ['rules'] })
      .success,
    true,
  )
  assert.equal(
    projectTextSearchRequest.safeParse({ rootId: 'repo', query: 'setup', kinds: ['other'] })
      .success,
    false,
  )
  assert.equal(
    projectTextSearchRequest.safeParse({
      rootId: 'repo',
      query: 'setup',
      kinds: ['rules', 'rules'],
    }).success,
    false,
  )
  assert.equal(
    projectTextSearchRequest.safeParse({ rootId: 'repo', query: 'setup', limit: 100 }).success,
    true,
  )
  assert.equal(
    projectTextSearchRequest.safeParse({ rootId: 'repo', query: 'setup', limit: 101 }).success,
    false,
  )
  assert.equal(
    projectTextSearchRequest.safeParse({ rootId: 'repo', query: 'setup', maxChars: 24_001 })
      .success,
    false,
  )
  assert.equal(
    projectTextSearchRequest.safeParse({ rootId: 'repo', query: 'setup', root: '/tmp' }).success,
    false,
  )
  assert.equal(
    projectTextReadRequest.safeParse({
      rootId: 'repo',
      path: 'README.md',
      lineStart: 2,
      lineEnd: 201,
    }).success,
    true,
  )
  assert.equal(
    projectTextReadRequest.safeParse({
      rootId: 'repo',
      path: 'README.md',
      lineStart: 2,
      lineEnd: 202,
    }).success,
    false,
  )
  assert.equal(
    projectTextReadRequest.safeParse({
      rootId: 'repo',
      path: 'README.md',
      lineStart: 4,
      lineEnd: 3,
    }).success,
    false,
  )
})
