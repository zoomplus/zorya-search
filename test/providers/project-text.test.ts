import assert from 'node:assert/strict'
import test from 'node:test'
import { createOpenRouterEmbedding, createOpenRouterReranker } from '../../src/providers/openrouter.js'
import { isVerifiedVoyageResponseModel, MECHANISM_RETRIEVAL_PRESETS, PROJECT_TEXT_RETRIEVAL_PRESET } from '../../src/providers/voyage.js'
import { ProviderError } from '../../src/providers/contracts.js'

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('project text preset keeps independent document/query roles and exact observed aliases', async () => {
  assert.deepEqual(PROJECT_TEXT_RETRIEVAL_PRESET, {
    embedding: { model: 'voyageai/voyage-4-large', dimensions: 1024 },
    reranker: { model: 'voyageai/rerank-2.5-lite', candidateLimit: 30 },
  })
  assert.deepEqual(MECHANISM_RETRIEVAL_PRESETS.code, {
    model: 'voyageai/voyage-code-4',
    dimensions: 1024,
    candidateLimit: 30,
    reranker: 'voyageai/rerank-2.5-lite',
    defaultLimit: 8,
  })
  assert.equal(isVerifiedVoyageResponseModel(PROJECT_TEXT_RETRIEVAL_PRESET.embedding.model, 'voyage-4-large'), true)
  assert.equal(isVerifiedVoyageResponseModel(PROJECT_TEXT_RETRIEVAL_PRESET.embedding.model, 'voyage-4-large-v2'), false)

  const bodies: Array<Record<string, unknown>> = []
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    bodies.push(body)
    const input = body.input as string[]
    return jsonResponse({
      model: 'voyage-4-large',
      data: input.map((_, index) => ({ index, embedding: [1, 0] })),
    })
  }
  const document = createOpenRouterEmbedding({
    baseUrl: 'https://router.test/api/v1',
    apiKey: 'fixture-only',
    model: PROJECT_TEXT_RETRIEVAL_PRESET.embedding.model,
    dimensions: 2,
    inputType: 'document',
    verifyReturnedModel: true,
    fetch,
  })
  const query = createOpenRouterEmbedding({
    baseUrl: 'https://router.test/api/v1',
    apiKey: 'fixture-only',
    model: PROJECT_TEXT_RETRIEVAL_PRESET.embedding.model,
    dimensions: 2,
    inputType: 'query',
    verifyReturnedModel: true,
    fetch,
  })
  const signal = new AbortController().signal
  await document.embed({ texts: ['project documentation'], signal })
  await query.embed({ texts: ['how is this documented?'], signal })
  assert.equal(document.profile.inputType, 'document')
  assert.equal(query.profile.inputType, 'query')
  assert.notEqual(document.profile.space, query.profile.space)
  assert.deepEqual(
    bodies.map((body) => body.input_type),
    ['document', 'query'],
  )

  const malformed = createOpenRouterEmbedding({
    baseUrl: 'https://router.test/api/v1',
    apiKey: 'fixture-only',
    model: PROJECT_TEXT_RETRIEVAL_PRESET.embedding.model,
    dimensions: 2,
    inputType: 'query',
    verifyReturnedModel: true,
    fetch: async () =>
      jsonResponse({
        model: 'vendor/voyage-4-large',
        data: [{ index: 0, embedding: [1, 0] }],
      }),
  })
  await assert.rejects(malformed.embed({ texts: ['query'], signal }), (error: unknown) => error instanceof ProviderError && error.code === 'malformed')
})

test('project text reranker accepts the exact short alias and sends a bounded topN', async () => {
  let body: Record<string, unknown> | undefined
  const reranker = createOpenRouterReranker({
    baseUrl: 'https://router.test/api/v1',
    apiKey: 'fixture-only',
    model: PROJECT_TEXT_RETRIEVAL_PRESET.reranker.model,
    maxResults: PROJECT_TEXT_RETRIEVAL_PRESET.reranker.candidateLimit,
    verifyReturnedModel: true,
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse({
        model: 'rerank-2.5-lite',
        results: [{ index: 1, relevance_score: 0.8 }],
      })
    },
  })
  const result = await reranker.rerank({
    query: 'configuration policy',
    documents: ['general readme', 'configuration policy'],
    topN: 1,
    signal: new AbortController().signal,
  })
  assert.deepEqual(result, [{ index: 1, score: 0.8 }])
  assert.equal(body?.top_n, 1)
})
