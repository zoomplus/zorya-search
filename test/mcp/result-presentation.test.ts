import test from 'node:test'
import assert from 'node:assert/strict'
import { parseResultPresentation, presentStructuredResult } from '../../src/mcp/result-presentation.js'
import { runSearchMcpStdioProxy } from '../../src/mcp/stdio.js'

test('presentation mode accepts only the explicit supported values', () => {
  assert.equal(parseResultPresentation('legacy'), 'legacy')
  assert.equal(parseResultPresentation('structured'), 'structured')
  for (const value of [undefined, true, 'auto', 'STRUCTURED'])
    assert.throws(() => parseResultPresentation(value), /MCP_RESULT_PRESENTATION_INVALID/u)
})

test('stdio proxy validates options before endpoint validation or connection', async () => {
  const invalidEndpoint = new URL('ftp://invalid.example/mcp')
  await assert.rejects(
    runSearchMcpStdioProxy(invalidEndpoint, 'unused', { resultPresentation: 'invalid' as never }),
    /MCP_RESULT_PRESENTATION_INVALID/u,
  )
  await assert.rejects(
    runSearchMcpStdioProxy(invalidEndpoint, 'unused', { resultPresentation: undefined }),
    /MCP_ENDPOINT_INVALID/u,
  )
})

test('structured presentation replaces only an exact JSON duplicate and preserves fields', () => {
  const structuredContent = { nested: { label: 'café 雪', count: 3 }, values: [true, null] }
  const originalText = '{"values":[true,null],"nested":{"count":3,"label":"caf\\u00e9 雪"}}'
  const result = {
    content: [
      { type: 'text', text: originalText, annotations: { audience: ['user'] }, _meta: { tag: 'kept' } },
      { type: 'text', text: 'additional content' },
      { type: 'image', data: 'YWJj', mimeType: 'image/png' },
    ],
    structuredContent,
    isError: false,
    _meta: { trace: 'kept' },
    extension: { kept: true },
  }
  const projected = presentStructuredResult(result)
  assert.notEqual(projected, result)
  assert.deepEqual(projected.content[0], {
    type: 'text', text: 'See structuredContent.', annotations: { audience: ['user'] }, _meta: { tag: 'kept' },
  })
  assert.deepEqual(projected.content.slice(1), result.content.slice(1))
  assert.equal(projected.structuredContent, structuredContent)
  assert.equal(projected.isError, false)
  assert.deepEqual(projected._meta, result._meta)
  assert.deepEqual(projected.extension, result.extension)
  assert.equal(result.content[0]?.text, originalText)
})

test('legacy, errors, summaries, and all nonmatching payloads retain the original result', () => {
  const structuredContent = { items: [{ path: 'src/a.ts', excerpt: 'an implementation detail with enough text to justify compacting' }] }
  const text = JSON.stringify(structuredContent)
  const result = { content: [{ type: 'text', text }], structuredContent, isError: false }
  assert.notEqual(presentStructuredResult(result), result)
  const tiny = { content: [{ type: 'text', text: '{"value":1}' }], structuredContent: { value: 1 } }
  assert.equal(presentStructuredResult(tiny), tiny)
  const errorResult = { ...result, isError: true }
  assert.equal(presentStructuredResult(errorResult), errorResult)

  const cases = [
    { content: [{ type: 'text', text: 'See structuredContent.' }], structuredContent },
    { content: [{ type: 'text', text: '{malformed' }], structuredContent },
    { content: [{ type: 'text', text: '{"items":[]}' }], structuredContent },
    { content: [{ type: 'text', text }], structuredContent: undefined },
    { content: [{ type: 'text', text: JSON.stringify({ items: structuredContent.items, extra: true }) }], structuredContent },
    { content: [{ type: 'text', text: JSON.stringify({ items: structuredContent.items }) }], structuredContent: structuredContent.items },
  ]
  for (const candidate of cases) assert.equal(presentStructuredResult(candidate), candidate)
})

test('unsupported root shapes and nonfinite or signed-zero JSON numbers are not compacted', () => {
  const padding = 'x'.repeat(80)
  const candidates = [
    { content: [{ type: 'text', text: `{"value":1e309,"padding":"${padding}"}` }], structuredContent: { value: Infinity, padding } },
    { content: [{ type: 'text', text: `{"value":0,"padding":"${padding}"}` }], structuredContent: { value: -0, padding } },
    { content: [{ type: 'text', text: `{"value":"${padding}"}` }], structuredContent: padding },
    { content: [{ type: 'text', text: `{"value":"${padding}"}` }], structuredContent: [padding] },
  ]
  for (const candidate of candidates) {
    assert.ok(candidate.content[0]!.text.length > 'See structuredContent.'.length)
    assert.equal(presentStructuredResult(candidate), candidate)
  }
})

test('projection skips unsafe structured values without invoking accessors', () => {
  const description = 'an otherwise matching payload long enough to reach descriptor comparison'
  let getterCalls = 0
  const structuredContent = Object.defineProperty({ description }, 'items', {
    enumerable: true,
    get() { getterCalls++; return [] },
  })
  const text = `{"items":[],"description":"${description}"}`
  const result = { content: [{ type: 'text', text }], structuredContent }
  assert.equal(presentStructuredResult(result), result)
  assert.equal(getterCalls, 0)
  assert.ok(text.length > 'See structuredContent.'.length)

  let toJSONCalls = 0
  const withToJSON = Object.defineProperty({ description }, 'toJSON', {
    enumerable: true,
    get() { toJSONCalls++; return () => ({ description }) },
  })
  const toJSONText = `{"description":"${description}","toJSON":null}`
  const toJSONResult = { content: [{ type: 'text', text: toJSONText }], structuredContent: withToJSON }
  assert.equal(presentStructuredResult(toJSONResult), toJSONResult)
  assert.equal(toJSONCalls, 0)
  assert.ok(toJSONText.length > 'See structuredContent.'.length)

  let contentGetterCalls = 0
  const content = Object.defineProperty([], '0', {
    enumerable: true,
    get() { contentGetterCalls++; return { type: 'text', text } },
  })
  content.length = 1
  const unsafeContent = { content, structuredContent: { items: [] } }
  assert.equal(presentStructuredResult(unsafeContent), unsafeContent)
  assert.equal(contentGetterCalls, 0)
})

test('compact reuse summaries and unrelated blocks remain unchanged', () => {
  const result = {
    content: [
      { type: 'text', text: 'Found 2 reusable candidates.' },
      { type: 'text', text: JSON.stringify({ result: 'same', description: 'a repeated result payload that is longer than the compact summary' }) },
    ],
    structuredContent: { result: 'same', description: 'a repeated result payload that is longer than the compact summary' },
  }
  const projected = presentStructuredResult(result)
  assert.equal(projected.content[0], result.content[0])
  assert.equal(projected.content[1]?.text, 'See structuredContent.')
})
