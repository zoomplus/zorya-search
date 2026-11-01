import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Worker } from 'node:worker_threads'
import {
  createOpenAICompatibleEmbedding,
  createOpenRouterEmbedding,
  createOpenRouterModels,
  createOpenRouterReranker,
  createOpenRouterMultimodalEmbedding,
} from "../../src/providers/openrouter.js";
import { isVerifiedVoyageResponseModel, MECHANISM_RETRIEVAL_PRESETS } from '../../src/providers/voyage.js'
import { createOpenRouterClassifier } from "../../src/providers/classifier.js";
import {
  assertPublicAddresses,
  canonicalPublicUrl,
  createBraveWebSource,
} from "../../src/providers/brave.js";
import { ProviderError } from "../../src/providers/contracts.js";
import { Semaphore, limitsOf } from "../../src/providers/http.js";
import { BraveQuota, createBraveQuotaState } from '../../src/providers/brave-quota.js'

function runBraveQuotaWorker(sharedQuota: SharedArrayBuffer | undefined, observations: SharedArrayBuffer, mode?: '429-once' | 'ok', onPhase?: (phase: string) => void, apiKey?: string, gate?: SharedArrayBuffer) {
  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL('./brave-quota-worker.mjs', import.meta.url), {
      workerData: { sharedQuota, observations, mode, apiKey, gate },
    })
    worker.on('message', (message: { ok?: boolean; error?: string; phase?: string }) => {
      if (message.phase) onPhase?.(message.phase)
      if (message.ok === undefined) return
      void worker.terminate()
      if (message.ok) resolve()
      else reject(new Error(message.error ?? 'Brave quota worker failed'))
    })
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Brave quota worker exited with ${code}`))
    })
  })
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeTextPdf(contentStream: string, pageWidth = 300): Buffer {
  const stream = `${contentStream}\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ]
  let document = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(document))
    document += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(document)
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) {
    document += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(document)
}

test('Mechanism presets stay pinned and multimodal OpenRouter embedding sends only bounded caller bytes', async () => {
  assert.deepEqual(MECHANISM_RETRIEVAL_PRESETS.code, {
    model: 'voyageai/voyage-code-4', dimensions: 1024, candidateLimit: 30,
    reranker: 'voyageai/rerank-2.5-lite', defaultLimit: 8,
  })
  assert.deepEqual(MECHANISM_RETRIEVAL_PRESETS.visual, {
    model: 'voyageai/voyage-multimodal-3.5', dimensions: 1024, defaultLimit: 5,
  })
  let payload: Record<string, unknown> | undefined
  const model = createOpenRouterMultimodalEmbedding({
    baseUrl: 'https://router.test/api/v1', apiKey: 'fixture', model: MECHANISM_RETRIEVAL_PRESETS.visual.model,
    dimensions: 2, fetch: async (_url, init) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse({ model: MECHANISM_RETRIEVAL_PRESETS.visual.model, data: [{ index: 0, embedding: [1, 0] }] })
    },
  })
  assert.deepEqual(await model.embed({ images: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }], signal: new AbortController().signal }), [[1, 0]])
  assert.equal(payload?.model, MECHANISM_RETRIEVAL_PRESETS.visual.model)
  assert.equal(payload?.dimensions, 2)
  assert.equal('input_type' in payload!, false)
  const input = (payload?.input as Array<{ content: Array<{ image_url: { url: string } }> }>)[0]!
  assert.equal(input.content[0]!.image_url.url, 'data:image/png;base64,AQID')
  const largeImage = new Uint8Array(1_100_000).fill(7)
  await model.embed({ images: [{ bytes: largeImage, mimeType: 'image/png' }], signal: new AbortController().signal })
  const mismatch = createOpenRouterMultimodalEmbedding({ baseUrl: 'https://router.test/api/v1', apiKey: 'fixture', model: 'voyageai/voyage-multimodal-3.5', dimensions: 2, fetch: async () => jsonResponse({ model: 'other/model', data: [{ index: 0, embedding: [1, 0] }] }) })
  await assert.rejects(mismatch.embed({ texts: ['query'], signal: new AbortController().signal }), (error: unknown) => error instanceof ProviderError && error.code === 'malformed')
})

test('verified Voyage adapters accept only the three exact observed response aliases', async () => {
  const cases = [
    { requested: MECHANISM_RETRIEVAL_PRESETS.code.model, response: 'voyage-code-4' },
    { requested: MECHANISM_RETRIEVAL_PRESETS.code.reranker, response: 'rerank-2.5-lite' },
    { requested: MECHANISM_RETRIEVAL_PRESETS.visual.model, response: 'voyage-multimodal-3.5' },
  ] as const
  for (const { requested, response } of cases) {
    assert.equal(isVerifiedVoyageResponseModel(requested, response), true)
    assert.equal(isVerifiedVoyageResponseModel(requested, requested), true)
  }
  for (const [requested, response] of [
    [MECHANISM_RETRIEVAL_PRESETS.code.model, 'other/voyage-code-4'],
    [MECHANISM_RETRIEVAL_PRESETS.code.model, 'rerank-2.5-lite'],
    [MECHANISM_RETRIEVAL_PRESETS.code.model, 'Voyage-code-4'],
    [MECHANISM_RETRIEVAL_PRESETS.code.model, 'voyage-code-4-1'],
    [MECHANISM_RETRIEVAL_PRESETS.code.model, 7],
    [MECHANISM_RETRIEVAL_PRESETS.code.model, undefined],
    ['vendor/custom-model', 'custom-model'],
    ['constructor', 'constructor'],
    ['__proto__', '__proto__'],
  ] as const)
    assert.equal(isVerifiedVoyageResponseModel(requested, response), false)

  const code = createOpenRouterEmbedding({
    baseUrl: 'https://router.test/api/v1', apiKey: 'fixture',
    model: MECHANISM_RETRIEVAL_PRESETS.code.model, dimensions: 2, verifyReturnedModel: true,
    fetch: async () => jsonResponse({ model: 'voyage-code-4', data: [{ index: 0, embedding: [1, 0] }] }),
  })
  assert.deepEqual(await code.embed({ texts: ['query'], signal: new AbortController().signal }), [[1, 0]])
  assert.equal(code.profile.model, MECHANISM_RETRIEVAL_PRESETS.code.model)
  const codeFullName = createOpenRouterEmbedding({
    baseUrl: 'https://router.test/api/v1', apiKey: 'fixture',
    model: MECHANISM_RETRIEVAL_PRESETS.code.model, dimensions: 2, verifyReturnedModel: true,
    fetch: async () => jsonResponse({ model: MECHANISM_RETRIEVAL_PRESETS.code.model, data: [{ index: 0, embedding: [1, 0] }] }),
  })
  assert.equal(code.profile.space, codeFullName.profile.space)
  const codeReranker = createOpenRouterReranker({
    baseUrl: 'https://router.test/api/v1', apiKey: 'fixture',
    model: MECHANISM_RETRIEVAL_PRESETS.code.reranker, verifyReturnedModel: true,
    fetch: async () => jsonResponse({ model: 'rerank-2.5-lite', results: [{ index: 0, relevance_score: 1 }] }),
  })
  assert.deepEqual(await codeReranker.rerank({ query: 'q', documents: ['d'], signal: new AbortController().signal }), [{ index: 0, score: 1 }])
  assert.equal(codeReranker.profile.model, MECHANISM_RETRIEVAL_PRESETS.code.reranker)
  const visual = createOpenRouterMultimodalEmbedding({
    baseUrl: 'https://router.test/api/v1', apiKey: 'fixture',
    model: MECHANISM_RETRIEVAL_PRESETS.visual.model, dimensions: 2, verifyReturnedModel: true,
    fetch: async () => jsonResponse({ model: 'voyage-multimodal-3.5', data: [{ index: 0, embedding: [1, 0] }] }),
  })
  assert.deepEqual(await visual.embed({ texts: ['query'], signal: new AbortController().signal }), [[1, 0]])
  assert.equal(visual.profile.model, MECHANISM_RETRIEVAL_PRESETS.visual.model)

  const strictCustomVisual = createOpenRouterMultimodalEmbedding({
    baseUrl: 'https://router.test/api/v1', apiKey: 'fixture',
    model: 'vendor/custom-visual', dimensions: 2, verifyReturnedModel: true,
    fetch: async () => jsonResponse({ model: 'vendor/custom-visual', data: [{ index: 0, embedding: [1, 0] }] }),
  })
  assert.deepEqual(await strictCustomVisual.embed({ texts: ['query'], signal: new AbortController().signal }), [[1, 0]])
  const wrongRoleVisualAlias = createOpenRouterMultimodalEmbedding({
    baseUrl: 'https://router.test/api/v1', apiKey: 'fixture',
    model: 'vendor/custom-visual', dimensions: 2,
    fetch: async () => jsonResponse({ model: 'voyage-code-4', data: [{ index: 0, embedding: [1, 0] }] }),
  })
  await assert.rejects(
    wrongRoleVisualAlias.embed({ texts: ['query'], signal: new AbortController().signal }),
    (error: unknown) => error instanceof ProviderError && error.code === 'malformed',
  )

  for (const responseModel of ['other/voyage-code-4', 'rerank-2.5-lite', 'Voyage-code-4', 'voyage-code-4-1', 7, null, undefined, 'vendor/custom-model']) {
    const invalid = createOpenRouterEmbedding({
      baseUrl: 'https://router.test/api/v1', apiKey: 'fixture',
      model: MECHANISM_RETRIEVAL_PRESETS.code.model, dimensions: 2, verifyReturnedModel: true,
      fetch: async () => jsonResponse({ model: responseModel, data: [{ index: 0, embedding: [1, 0] }] }),
    })
    await assert.rejects(
      invalid.embed({ texts: ['query'], signal: new AbortController().signal }),
      (error: unknown) => error instanceof ProviderError && error.code === 'malformed',
    )
  }
  const strictCustom = createOpenRouterEmbedding({
    baseUrl: 'https://router.test/api/v1', apiKey: 'fixture', model: 'vendor/custom-model', dimensions: 2,
    verifyReturnedModel: true,
    fetch: async () => jsonResponse({ model: 'vendor/custom-model', data: [{ index: 0, embedding: [1, 0] }] }),
  })
  assert.deepEqual(await strictCustom.embed({ texts: ['query'], signal: new AbortController().signal }), [[1, 0]])
  const mismatchedStrictCustom = createOpenRouterEmbedding({
    baseUrl: 'https://router.test/api/v1', apiKey: 'fixture', model: 'vendor/custom-model', dimensions: 2,
    verifyReturnedModel: true,
    fetch: async () => jsonResponse({ model: 'vendor/other', data: [{ index: 0, embedding: [1, 0] }] }),
  })
  await assert.rejects(
    mismatchedStrictCustom.embed({ texts: ['query'], signal: new AbortController().signal }),
    (error: unknown) => error instanceof ProviderError && error.code === 'malformed',
  )
  const generic = createOpenRouterEmbedding({
    baseUrl: 'https://router.test/api/v1', apiKey: 'fixture', model: 'vendor/generic', dimensions: 2,
    fetch: async () => jsonResponse({ model: 'other/vendor', data: [{ index: 0, embedding: [1, 0] }] }),
  })
  assert.deepEqual(await generic.embed({ texts: ['query'], signal: new AbortController().signal }), [[1, 0]])
})

test("embeddings reorder by index and reject duplicates, omissions, dimensions and zero vectors", async () => {
  const model = createOpenRouterEmbedding({
    baseUrl: "https://router.test/api/v1",
    apiKey: "secret",
    model: "custom/embed",
    dimensions: 2,
    fetch: async () =>
      jsonResponse({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
  });
  assert.deepEqual(
    await model.embed({
      texts: ["a", "b"],
      signal: new AbortController().signal,
    }),
    [
      [1, 0],
      [0, 1],
    ],
  );
  assert.deepEqual(model.usage(), {
    calls: 1,
    inputTokens: null,
    totalTokens: null,
    estimatedCost: null,
    latencyMs: model.usage().latencyMs,
  });
  for (const data of [
    [
      { index: 0, embedding: [1, 0] },
      { index: 0, embedding: [0, 1] },
    ],
    [{ index: 0, embedding: [1, 0] }],
    [
      { index: 0, embedding: [1] },
      { index: 1, embedding: [0, 1] },
    ],
    [
      { index: 0, embedding: [0, 0] },
      { index: 1, embedding: [0, 1] },
    ],
  ]) {
    const invalid = createOpenRouterEmbedding({
      baseUrl: "https://router.test/api/v1",
      apiKey: "secret",
      model: "custom/embed",
      dimensions: 2,
      fetch: async () => jsonResponse({ data }),
    });
    await assert.rejects(
      invalid.embed({
        texts: ["a", "b"],
        signal: new AbortController().signal,
      }),
      (e: unknown) => e instanceof ProviderError && e.code === "malformed",
    );
  }
  for (const invalidBody of [null, []]) {
    const invalid = createOpenRouterEmbedding({
      baseUrl: "https://router.test/api/v1",
      apiKey: "secret",
      model: "custom/embed",
      dimensions: 2,
      fetch: async () => jsonResponse(invalidBody),
    });
    await assert.rejects(
      invalid.embed({ texts: ["a"], signal: new AbortController().signal }),
      (e: unknown) => e instanceof ProviderError && e.code === "malformed",
    );
  }
});

test("reranker rejects duplicate or out of range indexes and non-finite scores", async () => {
  for (const results of [
    [
      { index: 0, relevance_score: 0.9 },
      { index: 0, relevance_score: 0.2 },
    ],
    [{ index: 2, relevance_score: 0.2 }],
    [{ index: 0, relevance_score: Number.NaN }],
  ]) {
    const model = createOpenRouterReranker({
      baseUrl: "https://router.test/api/v1",
      apiKey: "secret",
      model: "custom/rerank",
      fetch: async () => jsonResponse({ results }),
    });
    await assert.rejects(
      model.rerank({
        query: "q",
        documents: ["d1", "d2"],
        signal: new AbortController().signal,
      }),
      (e: unknown) => e instanceof ProviderError && e.code === "malformed",
    );
  }
});

test('reranker honors a per-call topN override without exceeding its configured ceiling', async () => {
  let topN: number | undefined
  const model = createOpenRouterReranker({
    baseUrl: 'https://router.test/api/v1', apiKey: 'secret', model: 'voyageai/rerank-2.5-lite', maxResults: 30,
    fetch: async (_input, init) => {
      topN = (JSON.parse(String(init?.body)) as { top_n?: number }).top_n
      return jsonResponse({ results: [{ index: 29, relevance_score: 1 }] })
    },
  })
  const result = await model.rerank({ query: 'needle', documents: Array.from({ length: 30 }, (_, i) => `doc ${i}`), topN: 8, signal: new AbortController().signal })
  assert.equal(topN, 8)
  assert.deepEqual(result, [{ index: 29, score: 1 }])
  await assert.rejects(model.rerank({ query: 'needle', documents: ['x'], topN: 201, signal: new AbortController().signal }), (error: unknown) => error instanceof ProviderError && error.code === 'budget')
})

test("embedding and reranker have separate model profiles and OpenAI-compatible config adds no assumed rerank or judge", async () => {
  const payloads: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    payloads.push({ path: url.pathname, body });
    return url.pathname.endsWith("/embeddings")
      ? jsonResponse({
          data: [{ index: 0, embedding: [1, 0] }],
          usage: { prompt_tokens: 4, total_tokens: 4, cost: 0.003 },
        })
      : jsonResponse({
          results: [{ index: 0, relevance_score: 0.8 }],
          usage: { total_tokens: 2 },
        });
  };
  const models = createOpenRouterModels({
    embedding: {
      baseUrl: "https://router.test/api/v1",
      apiKey: "secret",
      model: "vendor/embed-a",
      dimensions: 2,
      inputType: "search_query",
      provider: { order: ["one"] },
      fetch: fetcher,
    },
    reranker: {
      baseUrl: "https://router.test/api/v1",
      apiKey: "secret",
      model: "vendor/rerank-b",
      maxResults: 1,
      fetch: fetcher,
    },
  });
  await models.embed({ texts: ["q"], signal: new AbortController().signal });
  await models.rerank!({
    query: "q",
    documents: ["d"],
    signal: new AbortController().signal,
  });
  assert.deepEqual(
    payloads.map((item) => item.body.model),
    ["vendor/embed-a", "vendor/rerank-b"],
  );
  assert.equal(payloads[0]?.body.input_type, "search_query");
  assert.equal(models.profile.dimensions, 2);
  assert.ok(models.rerankerProfile);
  assert.equal("judgeCache" in models, false);
  assert.equal(models.usage().embedding.inputTokens, 4);
  assert.equal(models.usage().reranker?.totalTokens, 2);
  assert.equal(models.usage().embedding.estimatedCost, 0.003);
  const compatible = createOpenAICompatibleEmbedding({
    baseUrl: "https://embed.example/v1",
    apiKey: "secret",
    model: "custom-embed",
    profileId: "private-model",
    dimensions: 2,
    fetch: fetcher,
  });
  assert.equal(compatible.profile.provider, "private-model");
  assert.equal("rerank" in compatible, false);
});

test("concurrent successful requests aggregate known usage while any failed request keeps it unknown", async () => {
  const responses: Array<(response: Response) => void> = [];
  const model = createOpenRouterEmbedding({
    baseUrl: "https://router.test/api/v1",
    apiKey: "secret",
    model: "embed",
    dimensions: 1,
    fetch: async () =>
      new Promise<Response>((resolve) => responses.push(resolve)),
  });
  const first = model.embed({
    texts: ["one"],
    signal: new AbortController().signal,
  });
  const second = model.embed({
    texts: ["two"],
    signal: new AbortController().signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(model.usage().inputTokens, null);
  responses[1]!(
    jsonResponse({
      data: [{ index: 0, embedding: [1] }],
      usage: { prompt_tokens: 3, total_tokens: 4, cost: 0.002 },
    }),
  );
  responses[0]!(
    jsonResponse({
      data: [{ index: 0, embedding: [1] }],
      usage: { prompt_tokens: 2, total_tokens: 3, cost: 0.001 },
    }),
  );
  await Promise.all([first, second]);
  assert.deepEqual(model.usage(), {
    calls: 2,
    inputTokens: 5,
    totalTokens: 7,
    estimatedCost: 0.003,
    latencyMs: model.usage().latencyMs,
  });

  let call = 0;
  const partiallyFailed = createOpenRouterEmbedding({
    baseUrl: "https://router.test/api/v1",
    apiKey: "secret",
    model: "embed",
    dimensions: 1,
    limits: { attempts: 1 },
    fetch: async () => {
      if (++call === 1) return jsonResponse({}, 401);
      return jsonResponse({
        data: [{ index: 0, embedding: [1] }],
        usage: { prompt_tokens: 2, total_tokens: 3, cost: 0.001 },
      });
    },
  });
  const outcomes = await Promise.allSettled([
    partiallyFailed.embed({
      texts: ["unauthorized"],
      signal: new AbortController().signal,
    }),
    partiallyFailed.embed({
      texts: ["success"],
      signal: new AbortController().signal,
    }),
  ]);
  assert.equal(
    outcomes.filter((result) => result.status === "rejected").length,
    1,
  );
  assert.equal(partiallyFailed.usage().calls, 2);
  assert.equal(partiallyFailed.usage().inputTokens, null);
  assert.equal(partiallyFailed.usage().totalTokens, null);
  assert.equal(partiallyFailed.usage().estimatedCost, null);
});

test("provider configs and profiles are snapshots and endpoint differences create separate spaces", async () => {
  const config = {
    baseUrl: "https://embed.example/v1",
    apiKey: "secret",
    model: "same-model",
    profileId: "shared",
    dimensions: 2,
    provider: { order: ["first"] },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(String(input), "https://embed.example/v1/embeddings");
      assert.equal(body.model, "same-model");
      assert.equal(body.dimensions, 2);
      assert.deepEqual(body.provider, { order: ["first"] });
      return jsonResponse({ data: [{ index: 0, embedding: [1, 0] }] });
    },
  };
  const model = createOpenAICompatibleEmbedding(config);
  const firstSpace = model.profile.space;
  config.baseUrl = "https://changed.example/v1";
  config.model = "changed-model";
  config.dimensions = 1;
  config.provider.order[0] = "changed";
  await model.embed({ texts: ["query"], signal: new AbortController().signal });
  assert.equal(model.profile.space, firstSpace);
  assert.ok(Object.isFrozen(model.profile));
  assert.throws(
    () => Object.assign(model.profile, { space: "mutated" }),
    TypeError,
  );
  const otherEndpoint = createOpenAICompatibleEmbedding({
    baseUrl: "https://other.example/v1",
    apiKey: "secret",
    model: "same-model",
    profileId: "shared",
    dimensions: 2,
    fetch: async () =>
      jsonResponse({ data: [{ index: 0, embedding: [1, 0] }] }),
  });
  assert.notEqual(otherEndpoint.profile.space, firstSpace);
});

test("classification constrains labels and grounds evidence in input", async () => {
  const classifier = createOpenRouterClassifier({
    baseUrl: "https://router.test/api/v1",
    apiKey: "secret",
    model: "custom/classifier",
    fetch: async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                labels: [
                  {
                    label: "yes",
                    confidence: 0.7,
                    evidence: ["the quoted fact"],
                  },
                ],
                abstained: false,
                uncertainty: [],
              }),
            },
          },
        ],
      }),
  });
  assert.deepEqual(
    await classifier.classify({
      text: "the quoted fact",
      labels: ["yes", "no"],
      criteria: "meaning",
      signal: new AbortController().signal,
    }),
    {
      labels: [
        { label: "yes", confidence: 0.7, evidence: ["the quoted fact"] },
      ],
      abstained: false,
      uncertainty: [],
    },
  );
  for (const value of [
    { labels: [{ label: "unknown" }], abstained: false, uncertainty: [] },
    {
      labels: [{ label: "yes", evidence: ["invented"] }],
      abstained: false,
      uncertainty: [],
    },
    { labels: [], abstained: false, uncertainty: [] },
    {
      labels: [{ label: "yes" }, { label: "no" }],
      abstained: false,
      uncertainty: [],
    },
  ]) {
    const invalid = createOpenRouterClassifier({
      baseUrl: "https://router.test/api/v1",
      apiKey: "secret",
      model: "custom/classifier",
      fetch: async () =>
        jsonResponse({
          choices: [{ message: { content: JSON.stringify(value) } }],
        }),
    });
    await assert.rejects(
      invalid.classify({
        text: "the quoted fact",
        labels: ["yes", "no"],
        criteria: "meaning",
        signal: new AbortController().signal,
      }),
      (e: unknown) => e instanceof ProviderError && e.code === "malformed",
    );
  }
});

test("classification allows default abstention, rejects it only when forbidden, and rejects extra keys", async () => {
  const abstention = { labels: [], abstained: true, uncertainty: ["unclear"] };
  const make = (value: unknown) =>
    createOpenRouterClassifier({
      baseUrl: "https://router.test/api/v1",
      apiKey: "secret",
      model: "custom/classifier",
      fetch: async () =>
        jsonResponse({
          choices: [{ message: { content: JSON.stringify(value) } }],
        }),
    });
  const input = {
    text: "maybe",
    labels: ["yes", "no"],
    criteria: "meaning",
    signal: new AbortController().signal,
  };
  assert.deepEqual(await make(abstention).classify(input), abstention);
  await assert.rejects(
    make(abstention).classify({ ...input, allowAbstain: false }),
    (e: unknown) => e instanceof ProviderError && e.code === "malformed",
  );
  await assert.rejects(
    make({ ...abstention, extra: true }).classify(input),
    (e: unknown) => e instanceof ProviderError && e.code === "malformed",
  );
  await assert.rejects(
    make({
      labels: [{ label: "yes", confidence: null, evidence: null, extra: true }],
      abstained: false,
      uncertainty: [],
    }).classify(input),
    (e: unknown) => e instanceof ProviderError && e.code === "malformed",
  );
});

test("classification maps null and array provider bodies to typed malformed errors", async () => {
  for (const value of [null, []]) {
    const classifier = createOpenRouterClassifier({
      baseUrl: "https://router.test/api/v1",
      apiKey: "secret",
      model: "classifier",
      fetch: async () => jsonResponse(value),
    });
    await assert.rejects(
      classifier.classify({
        text: "data",
        labels: ["yes", "no"],
        criteria: "meaning",
        signal: new AbortController().signal,
      }),
      (e: unknown) => e instanceof ProviderError && e.code === "malformed",
    );
  }
});

test("classifier snapshots mutable model, endpoint, and routing configuration", async () => {
  const payloads: Array<{ url: string; body: Record<string, unknown> }> = [];
  const config = {
    baseUrl: "https://classify.example/v1",
    apiKey: "secret",
    model: "classifier-a",
    provider: { order: ["first"] },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      payloads.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                labels: [{ label: "yes", confidence: null, evidence: null }],
                abstained: false,
                uncertainty: [],
              }),
            },
          },
        ],
      });
    },
  };
  const classifier = createOpenRouterClassifier(config);
  config.baseUrl = "https://changed.example/v1";
  config.model = "classifier-b";
  config.provider.order[0] = "second";
  await classifier.classify({
    text: "source",
    labels: ["yes", "no"],
    criteria: "meaning",
    signal: new AbortController().signal,
  });
  assert.equal(
    payloads[0]?.url,
    "https://classify.example/v1/chat/completions",
  );
  assert.equal(payloads[0]?.body.model, "classifier-a");
  assert.deepEqual(payloads[0]?.body.provider, {
    require_parameters: true,
    order: ["first"],
  });
});

test("Brave source deduplicates, caps discovery, parses documents, and blocks private or non-web URLs", async () => {
  const web = createBraveWebSource({
    apiKey: "secret",
    fetch: async () =>
      jsonResponse({
        web: {
          results: [
            null,
            { url: "https://example.org/a#x" },
            { url: "https://example.org/a" },
            { url: "http://127.0.0.1/" },
          ],
        },
      }),
    loader: async (url) => ({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: Buffer.from(
        "<html><title>Guide</title><nav>noise</nav><p>Useful &amp; safe text</p><script>ignore()</script></html>",
      ),
      url,
    }),
  });
  assert.deepEqual(
    await web.discover("query", 20, new AbortController().signal),
    ["https://example.org/a"],
  );
  const doc = await web.fetchDocument(
    "https://example.org/a",
    new AbortController().signal,
  );
  assert.equal(doc.title, "Guide");
  assert.match(doc.text, /Useful & safe text/);
  assert.doesNotMatch(doc.text, /noise|ignore/);
  const invalidUtf8 = createBraveWebSource({
    loader: async (url) => ({
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: Buffer.from([0xff]),
      url,
    }),
  });
  await assert.rejects(
    invalidUtf8.fetchDocument(
      "https://example.org/a",
      new AbortController().signal,
    ),
    (e: unknown) => e instanceof ProviderError && e.code === "malformed",
  );
  for (const url of [
    "file:///etc/passwd",
    "https://user:pass@example.org/",
    "http://127.0.0.1/",
    "http://[::ffff:127.0.0.1]/",
    "http://localhost/",
  ])
    assert.throws(() => canonicalPublicUrl(url), ProviderError);
  for (const answer of [
    "127.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:0:0:1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "198.18.0.1",
    "203.0.113.7",
  ]) {
    assert.throws(
      () =>
        assertPublicAddresses("rebind.example", [
          { address: answer, family: answer.includes(":") ? 6 : 4 },
        ]),
      ProviderError,
      `unsafe DNS answer was accepted: ${answer}`,
    );
  }
  assert.doesNotThrow(() =>
    assertPublicAddresses("public.example", [
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]),
  );
  assert.throws(
    () =>
      assertPublicAddresses("mixed.example", [
        { address: "8.8.8.8", family: 4 },
        { address: "::ffff:127.0.0.1", family: 6 },
      ]),
    ProviderError,
  );
});

test('Brave discovery forwards validated date ranges and does not mutate caller values', async () => {
  let requested: URL | undefined
  const web = createBraveWebSource({
    apiKey: 'fixture',
    fetch: async (input) => {
      requested = new URL(String(input))
      return jsonResponse({ web: { results: [{ url: 'https://example.org/a' }] } })
    },
  })
  const dateRange = { from: '2024-02-29', through: '2024-03-01' }
  await web.discover('query', 1, new AbortController().signal, { dateRange })
  assert.equal(requested?.searchParams.get('freshness'), '2024-02-29to2024-03-01')
  assert.deepEqual(dateRange, { from: '2024-02-29', through: '2024-03-01' })
  let invalidRangeCalls = 0
  const unavailable = createBraveWebSource({
    apiKey: 'fixture',
    fetch: async () => {
      invalidRangeCalls++
      throw new Error('Invalid date range reached provider')
    },
  })
  await assert.rejects(
    unavailable.discover('query', 1, new AbortController().signal, {
      dateRange: { from: '2024-02-30', through: '2024-03-01' },
    }),
  )
  assert.equal(invalidRangeCalls, 0)
})

test('Brave quota observes owner limits and shares a bounded 429 cooldown', async () => {
  const quota = new BraveQuota(20)
  quota.observe(new Headers({
    'x-ratelimit-policy': '1;w=1, 15000;w=2592000',
    'x-ratelimit-limit': '1, 15000',
    'x-ratelimit-remaining': '1, 14523',
    'x-ratelimit-reset': '1, 1234567',
  }), 200)
  const started = Date.now()
  await quota.acquire(started + 1500, new AbortController().signal)
  await assert.rejects(quota.acquire(started + 500, new AbortController().signal), ProviderError)
  quota.observe(new Headers({ 'retry-after': '0.05' }), 429)
  const blockedAt = Date.now()
  await quota.acquire(blockedAt + 1500, new AbortController().signal)
  assert.ok(Date.now() - blockedAt >= 950)
  const higherOwnerQuota = new BraveQuota(8)
  higherOwnerQuota.observe(new Headers({
    'x-ratelimit-policy': '6;w=1, 0;w=2592000',
    'x-ratelimit-limit': '6, 0',
    'x-ratelimit-remaining': '5, 0',
    'x-ratelimit-reset': '1, 1234567',
  }), 200)
  const ownerStarted = Date.now()
  await Promise.all(Array.from({ length: 6 }, () => higherOwnerQuota.acquire(ownerStarted + 1000, new AbortController().signal)))
  assert.ok(Date.now() - ownerStarted < 500)
  const unlimitedMonth = new BraveQuota(8)
  unlimitedMonth.observe(new Headers({
    'x-ratelimit-policy': '1;w=1, 0;w=2592000',
    'x-ratelimit-limit': '1, 0',
    'x-ratelimit-remaining': '1, 0',
    'x-ratelimit-reset': '1, 1234567',
  }), 429)
  await assert.rejects(
    unlimitedMonth.acquire(Date.now() + 100, new AbortController().signal),
    (error: unknown) => error instanceof ProviderError && error.code === 'rate_limit' && (error.retryAfterMs ?? Infinity) < 2000,
  )
})

test('Brave shared quota is owner-created, validated, and shared across actual Node workers', async () => {
  const invalid = new SharedArrayBuffer(64)
  assert.throws(() => createBraveWebSource({ apiKey: 'fixture', sharedQuota: invalid }), TypeError)
  assert.throws(() => new BraveQuota(1, new SharedArrayBuffer(0)), TypeError)
  const valid = createBraveQuotaState()
  const copiedBytes = new Uint8Array(valid)
  const copiedArrayBuffer = new ArrayBuffer(valid.byteLength)
  new Uint8Array(copiedArrayBuffer).set(copiedBytes)
  assert.throws(() => createBraveWebSource({ apiKey: 'fixture', sharedQuota: copiedArrayBuffer as unknown as SharedArrayBuffer }), TypeError)
  assert.throws(() => createBraveWebSource({ apiKey: 'fixture', sharedQuota: new Uint8Array(valid) as unknown as SharedArrayBuffer }), TypeError)
  assert.throws(() => createBraveWebSource({ apiKey: 'fixture', sharedQuota: null as unknown as SharedArrayBuffer }), TypeError)

  const freshQuota = new BraveQuota(1, createBraveQuotaState())
  await freshQuota.acquire(Date.now() + 100, new AbortController().signal)

  const shared = createBraveQuotaState()
  const observations = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT * 8)
  await Promise.all([
    runBraveQuotaWorker(shared, observations),
    runBraveQuotaWorker(shared, observations),
  ])
  const times = new BigInt64Array(observations)
  assert.equal(Atomics.load(times, 0), 2n)
  assert.ok(Atomics.load(times, 2) - Atomics.load(times, 1) >= 900_000n)
})

test('Brave shared cooldown safely handles fractional and very large untrusted reset headers', async () => {
  for (const status of [200, 429]) {
    const quota = new BraveQuota(10, createBraveQuotaState())
    const headers = status === 429
      ? new Headers({ 'retry-after': '1000000000000000000000000000' })
      : new Headers({
          'x-ratelimit-limit': '1',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1000000000000000000000000000',
        })
    assert.doesNotThrow(() => quota.observe(headers, status))
    await assert.rejects(
      quota.acquire(Date.now() + 100, new AbortController().signal),
      (error: unknown) => error instanceof ProviderError && error.code === 'rate_limit',
    )
  }

  const fractional = new BraveQuota(10, createBraveQuotaState())
  assert.doesNotThrow(() => fractional.observe(new Headers({ 'retry-after': '2.0005' }), 429))
  await assert.rejects(
    fractional.acquire(Date.now() + 100, new AbortController().signal),
    (error: unknown) => error instanceof ProviderError && error.code === 'rate_limit' && (error.retryAfterMs ?? 0) >= 1500,
  )
})

test('Brave shared cooldown propagates 429 across workers; default worker quotas stay independent', async () => {
  const shared = createBraveQuotaState()
  const observations = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT * 8)
  let second: Promise<void> | undefined
  const first = runBraveQuotaWorker(shared, observations, '429-once', (phase) => {
    if (phase === '429' && !second) second = runBraveQuotaWorker(shared, observations)
  })
  await first
  await second
  const sharedTimes = new BigInt64Array(observations)
  assert.equal(Atomics.load(sharedTimes, 0), 3n)
  const firstStart = Atomics.load(sharedTimes, 1)
  const firstAfter429 = Atomics.load(sharedTimes, 2)
  assert.ok(firstAfter429 - firstStart >= 1_400_000n)

  const independentObservations = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT * 8)
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const gateState = new Int32Array(gate)
  let readyCount = 0
  let releaseReady!: () => void
  const bothReady = new Promise<void>((resolve) => { releaseReady = resolve })
  const ready = () => {
    readyCount++
    if (readyCount === 2) releaseReady()
  }
  const independent = Promise.all([
    runBraveQuotaWorker(undefined, independentObservations, 'ok', (phase) => { if (phase === 'ready') ready() }, 'principal-a', gate),
    runBraveQuotaWorker(undefined, independentObservations, 'ok', (phase) => { if (phase === 'ready') ready() }, 'principal-b', gate),
  ])
  await bothReady
  Atomics.store(gateState, 0, 1)
  Atomics.notify(gateState, 0)
  await independent
  const independentTimes = new BigInt64Array(independentObservations)
  assert.equal(Atomics.load(independentTimes, 0), 2n)
  assert.ok(Math.abs(Number(Atomics.load(independentTimes, 2) - Atomics.load(independentTimes, 1))) < 900_000)
})

test('Brave cancelled shared quota wait does not reserve a future request start', async () => {
  const quota = new BraveQuota(1, createBraveQuotaState())
  const started = Date.now()
  await quota.acquire(started + 3000, new AbortController().signal)
  const cancelled = new AbortController()
  const waiting = quota.acquire(Date.now() + 3000, cancelled.signal)
  setTimeout(() => cancelled.abort(), 50)
  await assert.rejects(waiting, (error: unknown) => error instanceof ProviderError && error.code === 'cancel')
  await quota.acquire(Date.now() + 3000, new AbortController().signal)
  assert.ok(Date.now() - started < 1800)
})

test('Brave source honors a standalone long rate reset before another physical request', async () => {
  let physicalCalls = 0
  const web = createBraveWebSource({
    apiKey: 'fixture',
    limits: { attempts: 2, timeoutMs: 1000, maxRequestsPerSecond: 10 },
    fetch: async () => {
      physicalCalls++
      return new Response('', {
        status: 429,
        headers: { 'x-ratelimit-reset': '45' },
      })
    },
  })
  await assert.rejects(
    web.discover('cooldown', 1, new AbortController().signal),
    (error: unknown) => error instanceof ProviderError && error.code === 'rate_limit' && (error.retryAfterMs ?? 0) >= 44_000,
  )
  assert.equal(physicalCalls, 1)
  assert.equal(web.usage().calls, 1)
})

test('concurrent Brave discoveries share pacing and remember a final-attempt 429', async () => {
  const starts: number[] = []
  let calls = 0
  const web = createBraveWebSource({
    apiKey: 'fixture',
    limits: { maxRequestsPerSecond: 2, attempts: 1 },
    fetch: async () => {
      starts.push(Date.now())
      calls++
      if (calls === 1) return new Response('', { status: 429, headers: { 'retry-after': '0.01' } })
      return jsonResponse({ web: { results: [{ url: `https://example.org/${calls}` }] } })
    },
  })
  await assert.rejects(web.discover('rate limit', 1, new AbortController().signal), ProviderError)
  const afterRateLimit = Date.now()
  await web.discover('next query', 1, new AbortController().signal)
  assert.ok(Date.now() - afterRateLimit >= 900)
  assert.equal(calls, 2)
  starts.length = 0
  await Promise.all([
    web.discover('parallel one', 1, new AbortController().signal),
    web.discover('parallel two', 1, new AbortController().signal),
    web.discover('parallel three', 1, new AbortController().signal),
  ])
  assert.equal(starts.length, 3)
  assert.ok(starts[2]! - starts[0]! >= 900)
})

test('Brave document validators are exact-path scoped and 304 preserves the parsed body', async () => {
  const seen: Array<{ path: string; etag: string | undefined }> = []
  let documentVersion = 1
  let unsolicited304OnRedirect = false
  let raceConditionals = 0
  let cancelCacheRequests = 0
  let releaseStale304!: () => void
  let notifyStale304Started!: () => void
  const stale304Gate = new Promise<void>((resolve) => { releaseStale304 = resolve })
  const stale304Started = new Promise<void>((resolve) => { notifyStale304Started = resolve })
  const server = createServer(async (request, response) => {
    const path = request.url ?? '/'
    const etag = request.headers['if-none-match']
    seen.push({ path, etag })
    if (path === '/race') {
      if (!etag) {
        response.writeHead(200, { 'content-type': 'text/plain', etag: '"race-v1"' })
        response.end('race body v1')
        return
      }
      raceConditionals++
      if (raceConditionals === 1) {
        notifyStale304Started()
        await stale304Gate
        response.writeHead(304, { etag: '"race-v1"' })
        response.end()
        return
      }
      if (raceConditionals === 2) {
        response.writeHead(200, { 'content-type': 'text/plain', etag: '"race-v2"' })
        response.end('race body v2')
        return
      }
      response.writeHead(304, { etag: '"race-v2"' })
      response.end()
      return
    }
    if (path === '/cancel-cache') {
      cancelCacheRequests++
      response.writeHead(200, { 'content-type': 'text/plain', etag: '"cancelled"' })
      if (cancelCacheRequests === 1) {
        response.write('partial')
        response.flushHeaders()
      } else {
        response.end('complete source')
      }
      return
    }
    if (path === '/weak-etag') {
      if (etag) {
        response.writeHead(304, { etag: '"weak-v1"' })
        response.end()
      } else {
        response.writeHead(200, { 'content-type': 'text/plain', etag: 'W/"weak-v1"' })
        response.end('weak validator source')
      }
      return
    }
    if (path === '/unexpected') {
      response.writeHead(304)
      response.end()
      return
    }
    if (path === '/private') {
      response.writeHead(200, { 'content-type': 'text/plain', etag: '"private"', 'cache-control': 'private="field"' })
      response.end('private source')
      return
    }
    if (path === '/redirect') {
      response.writeHead(302, { location: '/document' })
      response.end()
      return
    }
    if (path === '/redirect-to-cached') {
      response.writeHead(302, { location: '/document' })
      response.end()
      return
    }
    if (path === '/document' && unsolicited304OnRedirect && !etag) {
      response.writeHead(304, { etag: '"v1"' })
      response.end()
      return
    }
    if (path === '/document' && etag === '"v1"' && documentVersion === 1) {
      response.writeHead(304, { etag: '"v1"' })
      response.end()
      return
    }
    const etagValue = `"v${documentVersion}"`
    response.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      etag: etagValue,
      ...(documentVersion === 2 ? { 'cache-control': 'no-store' } : {}),
    })
    response.end(`document version ${documentVersion}`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const origin = `http://fixture.invalid:${address.port}`
  const web = createBraveWebSource({
    allowPrivateForTests: true,
    resolveForTests: async () => [{ address: '127.0.0.1', family: 4 }],
    limits: { attempts: 1 },
  })
  try {
    const first = await web.fetchDocument(`${origin}/document`, new AbortController().signal)
    const second = await web.fetchDocument(`${origin}/document`, new AbortController().signal)
    assert.equal(first.text, 'document version 1')
    assert.equal(second.text, first.text)
    assert.equal(second.publishedAt, first.publishedAt)
    assert.notEqual(second.fetchedAt, first.fetchedAt)
    assert.equal(seen[1]?.etag, '"v1"')
    const weakFirst = await web.fetchDocument(`${origin}/weak-etag`, new AbortController().signal)
    const weakSecond = await web.fetchDocument(`${origin}/weak-etag`, new AbortController().signal)
    assert.equal(weakFirst.text, weakSecond.text)
    assert.equal(seen.at(-1)?.etag, 'W/"weak-v1"')
    unsolicited304OnRedirect = true
    await assert.rejects(
      web.fetchDocument(`${origin}/redirect-to-cached`, new AbortController().signal),
      (error: unknown) => error instanceof ProviderError && error.code === 'malformed',
    )
    unsolicited304OnRedirect = false
    documentVersion = 2
    const changed = await web.fetchDocument(`${origin}/document`, new AbortController().signal)
    assert.equal(changed.text, 'document version 2')
    assert.equal(seen.filter((item) => item.path === '/document')[3]?.etag, '"v1"')
    await web.fetchDocument(`${origin}/document`, new AbortController().signal)
    assert.equal(seen.filter((item) => item.path === '/document')[4]?.etag, undefined)
    await web.fetchDocument(`${origin}/redirect`, new AbortController().signal)
    const redirectHop = seen.at(-1)
    assert.equal(redirectHop?.path, '/document')
    assert.equal(redirectHop?.etag, undefined)
    await web.fetchDocument(`${origin}/document?variant=one`, new AbortController().signal)
    await web.fetchDocument(`${origin}/document?variant=two`, new AbortController().signal)
    assert.equal(seen.at(-1)?.etag, undefined)
    await assert.rejects(
      web.fetchDocument(`${origin}/unexpected`, new AbortController().signal),
      (error: unknown) => error instanceof ProviderError && error.code === 'malformed',
    )
    await web.fetchDocument(`${origin}/private`, new AbortController().signal)
    await web.fetchDocument(`${origin}/private`, new AbortController().signal)
    assert.equal(seen.at(-1)?.etag, undefined)
    await web.fetchDocument(`${origin}/race`, new AbortController().signal)
    const stale = web.fetchDocument(`${origin}/race`, new AbortController().signal)
    await stale304Started
    const latest = await web.fetchDocument(`${origin}/race`, new AbortController().signal)
    assert.equal(latest.text, 'race body v2')
    releaseStale304()
    await assert.rejects(stale, (error: unknown) => error instanceof ProviderError && error.code === 'malformed')
    const revalidated = await web.fetchDocument(`${origin}/race`, new AbortController().signal)
    assert.equal(revalidated.text, 'race body v2')
    const cancelled = new AbortController()
    const cancelledRead = web.fetchDocument(`${origin}/cancel-cache`, cancelled.signal)
    await new Promise((resolve) => setTimeout(resolve, 10))
    cancelled.abort()
    await assert.rejects(cancelledRead, (error: unknown) => error instanceof ProviderError && error.code === 'cancel')
    const completedRead = await web.fetchDocument(`${origin}/cancel-cache`, new AbortController().signal)
    assert.equal(completedRead.text, 'complete source')
    assert.equal(seen.at(-1)?.etag, undefined)
  } finally {
    releaseStale304()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('Brave reader preserves literal formats, HTML code whitespace, and explicit source dates', async () => {
  const inputs = [
    {
      type: 'text/html',
      body: '<html><head><title>Guide</title><meta property="article:published_time" content="2025-02-03T04:05:06Z"></head><body><nav>hidden nav</nav><p>pre<span>fix</span> <code> x  y</code></p><pre>\tconst x = 1;\n  next()</pre><pre>\n   leading\n\n\n\nend\n</pre><p>a<br>b</p><script>"</script><p>post</p><pre>ONE</pre><pre>TWO</pre><pre>tail\n\n\n</pre></body></html>',
    },
    { type: 'text/plain', body: '  first\n\tsecond  ' },
    {
      type: 'text/markdown',
      body: '---\ntitle: Notes\npublished: 2023-03-04T00:00:00Z\n---\n# Title\n\n- one\n  - two',
    },
    {
      type: 'application/json',
      body: '{"title":"Record","datePublished":"2024-01-02T00:00:00Z","dateModified":"2024-02-03T00:00:00Z","body":"line one\\n  line two"}',
    },
    {
      type: 'application/rss+xml',
      body: '<rss><channel><title>Feed</title><item><title>old item</title><pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate><description>item &amp; detail</description></item><item><title>new item</title><pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate></item></channel></rss>',
    },
    {
      type: 'application/vnd.example+json',
      body: '{"title":"Structured","values":[1,true,null,"source order"]}',
    },
    {
      type: 'application/x-custom+xml',
      body: '<custom><title><![CDATA[Actual ]]><part>title</part></title><dateModified>2022-08-09T00:00:00Z</dateModified><value><![CDATA[first <literal>]]><part>second</part></value></custom>',
    },
  ];
  for (const item of inputs) {
    const web = createBraveWebSource({
      loader: async (url) => ({
        status: 200,
        headers: { 'content-type': `${item.type}; charset=utf-8` },
        body: Buffer.from(item.body),
        url,
      }),
    });
    const doc = await web.fetchDocument('https://example.org/doc', new AbortController().signal);
    if (item.type === 'text/html') {
      assert.match(doc.text, /prefix  x  y/);
      assert.match(doc.text, /\tconst x = 1;\n  next\(\)/);
      assert.match(doc.text, /\n   leading\n\n\n\nend\n/);
      assert.match(doc.text, /a\nb/);
      assert.match(doc.text, /ONE\n\nTWO/);
      assert.ok(doc.text.endsWith('tail\n\n\n'));
      assert.doesNotMatch(doc.text, /hidden nav/);
      assert.equal(doc.publishedAt, '2025-02-03T04:05:06.000Z');
      assert.equal(doc.sourceUpdatedAt, null);
    }
    if (item.type === 'text/plain') assert.equal(doc.text, item.body);
    if (item.type === 'text/markdown') {
      assert.equal(doc.text, item.body);
      assert.equal(doc.title, 'Notes');
      assert.equal(doc.publishedAt, '2023-03-04T00:00:00.000Z');
    }
    if (item.type === 'application/json') {
      assert.equal(doc.text, item.body);
      assert.equal(doc.title, 'Record');
      assert.equal(doc.publishedAt, '2024-01-02T00:00:00.000Z');
      assert.equal(doc.sourceUpdatedAt, '2024-02-03T00:00:00.000Z');
    }
    if (item.type === 'application/rss+xml') {
      assert.equal(doc.text, item.body);
      assert.equal(doc.title, 'Feed');
      assert.equal(doc.publishedAt, null);
    }
    if (item.type === 'application/vnd.example+json') assert.equal(doc.text, item.body);
    if (item.type === 'application/x-custom+xml') {
      assert.equal(doc.text, item.body);
      assert.equal(doc.title, 'Actual title');
      assert.equal(doc.sourceUpdatedAt, '2022-08-09T00:00:00.000Z');
    }
  }

  for (const body of ['42', 'true', 'false', 'null', '[1,true,null,"value"]', '[{"title":"item 1","datePublished":"1990-01-01"},{"title":"item 2","datePublished":"2020-01-01"}]', '{"date":"2024-01-02"}']) {
    const web = createBraveWebSource({
      loader: async (url) => ({
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: Buffer.from(body),
        url,
      }),
    });
    const doc = await web.fetchDocument('https://example.org/value', new AbortController().signal);
    assert.equal(doc.text, body);
    if (body === '{"date":"2024-01-02"}') assert.equal(doc.publishedAt, null);
    if (body.startsWith('[{')) {
      assert.equal(doc.title, 'example.org');
      assert.equal(doc.publishedAt, null);
    }
  }

  for (const dateValue of ['2026-02-30', '2026-02-29', '2026-02-03T10:20:30', '0']) {
    const markdown = `---\npublished: ${dateValue}\n---\nbody`;
    const web = createBraveWebSource({
      loader: async (url) => ({
        status: 200,
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
        body: Buffer.from(markdown),
        url,
      }),
    });
    const doc = await web.fetchDocument('https://example.org/invalid-date', new AbortController().signal);
    assert.equal(doc.publishedAt, null);
  }

  const modified = createBraveWebSource({
    loader: async (url) => ({
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT' },
      body: Buffer.from('untrimmed literal'),
      url,
    }),
  });
  const modifiedDocument = await modified.fetchDocument('https://example.org/modified', new AbortController().signal);
  assert.equal(modifiedDocument.text, 'untrimmed literal');
  assert.equal(modifiedDocument.sourceUpdatedAt, '2015-10-21T07:28:00.000Z');

  const feedBody = '<rss><channel><title>Whole feed</title><pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate><item><title>first entry</title><pubDate>Mon, 01 Jan 1990 00:00:00 GMT</pubDate></item><item><title>second entry</title><pubDate>Mon, 01 Jan 2000 00:00:00 GMT</pubDate></item></channel></rss>';
  const feed = createBraveWebSource({
    loader: async (url) => ({
      status: 200,
      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
      body: Buffer.from(feedBody),
      url,
    }),
  });
  const feedDocument = await feed.fetchDocument('https://example.org/feed', new AbortController().signal);
  assert.equal(feedDocument.title, 'Whole feed');
  assert.equal(feedDocument.publishedAt, '2024-01-02T00:00:00.000Z');

  const oversizedUnicode = createBraveWebSource({
    limits: { maxResponseBytes: 4 },
    loader: async (url) => ({
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: Buffer.from('ёёё'),
      url,
    }),
  });
  await assert.rejects(
    oversizedUnicode.fetchDocument('https://example.org/large', new AbortController().signal),
    (error: unknown) => error instanceof ProviderError && error.code === 'budget',
  );

  for (let index = 0; index < 32; index += 1) {
    const marker = `__SOURCE_${index}_&lt;tag&gt;&amp;__`;
    const decodedMarker = marker.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
    const html = `<p>left<span>${marker}</span>right</p><pre>\t${marker}\n  ${marker}</pre>`;
    const web = createBraveWebSource({
      loader: async (url) => ({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: Buffer.from(html),
        url,
      }),
    });
    const doc = await web.fetchDocument('https://example.org/marker', new AbortController().signal);
    assert.ok(doc.text.includes(`left${decodedMarker}right`));
    assert.ok(doc.text.includes(`\t${decodedMarker}\n  ${decodedMarker}`));
  }
});

test('Brave PDF reading is lazy, bounded, cancellable, and extracts actual text', async () => {
  const pdf = makeTextPdf('BT /F1 12 Tf 20 60 Td (tiny extracted) Tj 1 0 0 1 20 40 Tm (phrase) Tj 1 0 0 1 20 20 Tm (second line) Tj ET');
  const web = createBraveWebSource({
    loader: async (url) => ({
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      body: pdf,
      url,
    }),
  });
  const doc = await web.fetchDocument('https://example.org/tiny.pdf', new AbortController().signal);
  assert.match(doc.text, /tiny extracted\nphrase/);
  assert.match(doc.text, /phrase\nsecond line/);
  assert.equal(doc.publishedAt, null);
  assert.equal(doc.sourceUpdatedAt, null);

  const malformed = createBraveWebSource({
    loader: async (url) => ({
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      body: Buffer.from('%PDF-broken'),
      url,
    }),
  });
  await assert.rejects(
    malformed.fetchDocument('https://example.org/bad.pdf', new AbortController().signal),
    (error: unknown) => error instanceof ProviderError && error.code === 'malformed',
  );

  const bounded = createBraveWebSource({
    limits: { maxResponseBytes: 8 },
    loader: async (url) => ({
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      body: pdf,
      url,
    }),
  });
  await assert.rejects(
    bounded.fetchDocument('https://example.org/large.pdf', new AbortController().signal),
    (error: unknown) => error instanceof ProviderError && error.code === 'budget',
  );

  const overTextBudgetPdf = makeTextPdf(`BT /F1 12 Tf 20 60 Td (${ 'x'.repeat(200_001) }) Tj ET`, 2_000_000);
  const textBounded = createBraveWebSource({
    loader: async (url) => ({
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      body: overTextBudgetPdf,
      url,
    }),
  });
  await assert.rejects(
    textBounded.fetchDocument('https://example.org/over-text-budget.pdf', new AbortController().signal),
    (error: unknown) => error instanceof ProviderError && error.code === 'budget',
  );

  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    web.fetchDocument('https://example.org/tiny.pdf', preAborted.signal),
    (error: unknown) => error instanceof ProviderError && error.code === 'cancel',
  );

  const cancelController = new AbortController();
  const cancellingWeb = createBraveWebSource({
    loader: async (url, operationSignal) => {
      const addListener = operationSignal.addEventListener.bind(operationSignal);
      operationSignal.addEventListener = ((type, listener, options) => {
        addListener(type, listener, options);
        if (type === 'abort') queueMicrotask(() => cancelController.abort());
      }) as typeof operationSignal.addEventListener;
      return { status: 200, headers: { 'content-type': 'application/pdf' }, body: pdf, url };
    },
  });
  await assert.rejects(
    cancellingWeb.fetchDocument('https://example.org/cancel.pdf', cancelController.signal),
    (error: unknown) => error instanceof ProviderError && error.code === 'cancel',
  );
});

test("Brave continues only when more results are available to replace duplicates and blocked URLs", async () => {
  const offsets: number[] = [];
  const web = createBraveWebSource({
    apiKey: "secret",
    limits: { maxItems: 2 },
    maxSearchRequests: 3,
    fetch: async (input) => {
      const page = Number(new URL(String(input)).searchParams.get("offset"));
      offsets.push(page);
      return page === 0
        ? jsonResponse({
            query: { more_results_available: true },
            web: {
              results: [
                { url: "https://example.org/a" },
                { url: "https://example.org/a#duplicate" },
                { url: "http://127.0.0.1/private" },
              ],
            },
          })
        : jsonResponse({
            query: { more_results_available: false },
            web: { results: [{ url: "https://example.org/b" }] },
          });
    },
  });
  assert.deepEqual(await web.discover("q", 2, new AbortController().signal), [
    "https://example.org/a",
    "https://example.org/b",
  ]);
  assert.deepEqual(offsets, [0, 1]);
});

test("Brave returns bounded partial results when its total request budget is exhausted", async () => {
  let calls = 0;
  const web = createBraveWebSource({
    apiKey: "secret",
    limits: { maxItems: 40 },
    maxSearchRequests: 1,
    fetch: async () => {
      calls++;
      return jsonResponse({
        query: { more_results_available: true },
        web: { results: [{ url: "https://example.org/partial" }] },
      });
    },
  });
  assert.deepEqual(await web.discover("q", 40, new AbortController().signal), [
    "https://example.org/partial",
  ]);
  assert.equal(calls, 1);
});

test("Brave discovery retries transient errors within its attempt cap and preserves typed auth failures", async () => {
  let retryCalls = 0;
  const retrying = createBraveWebSource({
    apiKey: "secret",
    limits: { attempts: 2 },
    fetch: async () =>
      ++retryCalls === 1
        ? jsonResponse({}, 503)
        : jsonResponse({ web: { results: [{ url: "https://example.org/" }] } }),
  });
  assert.deepEqual(
    await retrying.discover("q", 1, new AbortController().signal),
    ["https://example.org/"],
  );
  assert.equal(retryCalls, 2);
  let authCalls = 0;
  const auth = createBraveWebSource({
    apiKey: "secret",
    limits: { attempts: 3 },
    fetch: async () => {
      authCalls++;
      return jsonResponse({ ignored: "secret" }, 401);
    },
  });
  await assert.rejects(
    auth.discover("q", 1, new AbortController().signal),
    (e: unknown) =>
      e instanceof ProviderError &&
      e.code === "auth" &&
      e.status === 401 &&
      !e.message.includes("secret"),
  );
  assert.equal(authCalls, 1);
  const empty = createBraveWebSource({
    apiKey: "secret",
    fetch: async () => jsonResponse({ web: { results: [] } }),
  });
  assert.deepEqual(
    await empty.discover("q", 1, new AbortController().signal),
    [],
  );
});

test("Brave discovery snapshots its direct key and locale", async () => {
  const seen: Array<{ locale: string | null; key: string | null }> = [];
  const config = {
    apiKey: "initial-key",
    locale: "en",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        locale: new URL(String(input)).searchParams.get("search_lang"),
        key: new Headers(init?.headers).get("X-Subscription-Token"),
      });
      return jsonResponse({ web: { results: [] } });
    },
  };
  const web = createBraveWebSource(config);
  config.apiKey = "mutated-key";
  config.locale = "ru";
  await web.discover("query", 1, new AbortController().signal);
  assert.deepEqual(seen, [{ locale: "en", key: "initial-key" }]);
});

test("Brave discovery paginates in batches of at most twenty and obeys request and body budgets", async () => {
  const pages: number[] = [];
  const paged = createBraveWebSource({
    apiKey: "secret",
    limits: { maxItems: 45 },
    maxSearchRequests: 3,
    fetch: async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("offset"));
      const pageCount = Number(url.searchParams.get("count"));
      assert.ok(pageCount <= 20);
      pages.push(page);
      return jsonResponse({
        query: { more_results_available: page < 2 },
        web: {
          results: Array.from({ length: pageCount }, (_, index) => ({
            url: `https://example.org/${page}-${index}`,
          })),
        },
      });
    },
  });
  const urls = await paged.discover("q", 45, new AbortController().signal);
  assert.equal(urls.length, 45);
  assert.deepEqual(pages, [0, 1, 2]);
  const exhaustedPages: number[] = [];
  const exhausted = createBraveWebSource({
    apiKey: "secret",
    limits: { maxItems: 40 },
    fetch: async (input) => {
      exhaustedPages.push(
        Number(new URL(String(input)).searchParams.get("offset")),
      );
      return jsonResponse({
        query: { more_results_available: false },
        web: { results: [{ url: "https://example.org/only-one" }] },
      });
    },
  });
  assert.deepEqual(
    await exhausted.discover("q", 40, new AbortController().signal),
    ["https://example.org/only-one"],
  );
  assert.deepEqual(exhaustedPages, [0]);
  const tooLarge = createBraveWebSource({
    apiKey: "secret",
    limits: { maxResponseBytes: 10 },
    fetch: async () => jsonResponse({ web: { results: [] } }),
  });
  await assert.rejects(
    tooLarge.discover("q", 1, new AbortController().signal),
    (e: unknown) => e instanceof ProviderError && e.code === "budget",
  );
  const malformed = createBraveWebSource({
    apiKey: "secret",
    fetch: async () => jsonResponse({ web: {} }),
  });
  await assert.rejects(
    malformed.discover("q", 1, new AbortController().signal),
    (e: unknown) => e instanceof ProviderError && e.code === "malformed",
  );
});

test("provider endpoint requires TLS and API key never appears in errors", async () => {
  assert.throws(
    () =>
      createOpenRouterEmbedding({
        baseUrl: "http://router.test/api/v1",
        apiKey: "secret",
        model: "m",
        dimensions: 2,
      }),
    TypeError,
  );
  const model = createOpenRouterEmbedding({
    baseUrl: "https://router.test/api/v1",
    apiKey: "secret",
    model: "m",
    dimensions: 1,
    fetch: async () => jsonResponse({ error: "secret upstream text" }, 401),
  });
  await assert.rejects(
    model.embed({ texts: ["hello"], signal: new AbortController().signal }),
    (e: unknown) => e instanceof ProviderError && !e.message.includes("secret"),
  );
});

test("HTTP provider retries only transient status within configured attempts and enforces request and response budgets", async () => {
  let calls = 0;
  const model = createOpenRouterEmbedding({
    baseUrl: "https://router.test/api/v1",
    apiKey: "secret",
    model: "m",
    dimensions: 1,
    limits: { attempts: 2 },
    fetch: async () =>
      ++calls === 1
        ? jsonResponse({}, 503)
        : jsonResponse({ data: [{ index: 0, embedding: [1] }] }),
  });
  assert.deepEqual(
    await model.embed({
      texts: ["hello"],
      signal: new AbortController().signal,
    }),
    [[1]],
  );
  assert.equal(calls, 2);
  assert.equal(model.usage().calls, 2);
  assert.equal(model.usage().inputTokens, null);
  assert.equal(model.usage().estimatedCost, null);
  const requestLimited = createOpenRouterEmbedding({
    baseUrl: "https://router.test/api/v1",
    apiKey: "secret",
    model: "m",
    dimensions: 1,
    limits: { maxInputBytes: 4 },
    fetch: async () => {
      throw new Error("must not send");
    },
  });
  await assert.rejects(
    requestLimited.embed({
      texts: ["too large"],
      signal: new AbortController().signal,
    }),
    (e: unknown) => e instanceof ProviderError && e.code === "budget",
  );
  const responseLimited = createOpenRouterEmbedding({
    baseUrl: "https://router.test/api/v1",
    apiKey: "secret",
    model: "m",
    dimensions: 1,
    limits: { maxResponseBytes: 12 },
    fetch: async () => jsonResponse({ data: [{ index: 0, embedding: [1] }] }),
  });
  await assert.rejects(
    responseLimited.embed({
      texts: ["hello"],
      signal: new AbortController().signal,
    }),
    (e: unknown) => e instanceof ProviderError && e.code === "budget",
  );
});

test("HTTP provider timeout and caller cancellation settle with sanitized typed errors", async () => {
  const model = createOpenRouterEmbedding({
    baseUrl: "https://router.test/api/v1",
    apiKey: "secret",
    model: "m",
    dimensions: 1,
    limits: { timeoutMs: 20, attempts: 1 },
    fetch: async (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("secret timeout detail")),
          { once: true },
        ),
      ),
  });
  await assert.rejects(
    model.embed({ texts: ["hello"], signal: new AbortController().signal }),
    (e: unknown) =>
      e instanceof ProviderError &&
      e.code === "timeout" &&
      !e.message.includes("secret"),
  );
  const controller = new AbortController();
  const pending = model.embed({ texts: ["hello"], signal: controller.signal });
  controller.abort();
  await assert.rejects(
    pending,
    (e: unknown) =>
      e instanceof ProviderError &&
      e.code === "cancel" &&
      !e.message.includes("secret"),
  );
});

test("HTTP reader cancels and joins an unread response body after the deadline", async () => {
  let notifyRead!: () => void;
  let notifyCancelled!: () => void;
  const reading = new Promise<void>((resolve) => {
    notifyRead = resolve;
  });
  const cancelled = new Promise<void>((resolve) => {
    notifyCancelled = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
    pull() {
      notifyRead();
    },
    cancel() {
      notifyCancelled();
    },
  });
  const model = createOpenRouterEmbedding({
    baseUrl: "https://router.test/api/v1",
    apiKey: "secret",
    model: "m",
    dimensions: 1,
    limits: { timeoutMs: 20, attempts: 1 },
    fetch: async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  const pending = model.embed({
    texts: ["hello"],
    signal: new AbortController().signal,
  });
  await reading;
  await assert.rejects(
    pending,
    (e: unknown) => e instanceof ProviderError && e.code === "timeout",
  );
  await cancelled;
});

test("retry delay observes cancellation and never starts a second provider request", async () => {
  let calls = 0;
  const controller = new AbortController();
  const model = createOpenRouterEmbedding({
    baseUrl: "https://router.test/api/v1",
    apiKey: "secret",
    model: "m",
    dimensions: 1,
    limits: { attempts: 3 },
    fetch: async () => {
      calls++;
      controller.abort();
      return new Response("{}", {
        status: 429,
        headers: { "retry-after": "1" },
      });
    },
  });
  await assert.rejects(
    model.embed({ texts: ["hello"], signal: controller.signal }),
    (e: unknown) => e instanceof ProviderError && e.code === "cancel",
  );
  assert.equal(calls, 1);
});

test("retry response body is cancelled and joined before Retry-After delay and next request", async () => {
  let calls = 0;
  let bodyCancelled = false;
  const model = createOpenRouterEmbedding({
    baseUrl: "https://router.test/api/v1",
    apiKey: "secret",
    model: "m",
    dimensions: 1,
    limits: { attempts: 2 },
    fetch: async () => {
      if (++calls > 1) {
        assert.equal(bodyCancelled, true);
        return jsonResponse({ data: [{ index: 0, embedding: [1] }] });
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("rate limit body"));
        },
        cancel() {
          bodyCancelled = true;
        },
      });
      return new Response(body, {
        status: 429,
        headers: { "retry-after": "0.01" },
      });
    },
  });
  assert.deepEqual(
    await model.embed({ texts: ["q"], signal: new AbortController().signal }),
    [[1]],
  );
  assert.equal(calls, 2);
  assert.equal(bodyCancelled, true);
});

test("semaphore reserves permits during handoff and cancelled waiters do not strand the queue", async () => {
  const semaphore = new Semaphore(1, 4);
  const events: string[] = [];
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const first = semaphore.run(new AbortController().signal, async () => {
    events.push("first");
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
  });
  await Promise.resolve();
  const second = semaphore.run(new AbortController().signal, async () => {
    events.push("second");
    await new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
  });
  const third = semaphore.run(new AbortController().signal, async () => {
    events.push("third");
  });
  releaseFirst();
  const newcomer = semaphore.run(new AbortController().signal, async () => {
    events.push("newcomer");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first", "second"]);
  releaseSecond();
  await Promise.all([first, second, third, newcomer]);
  assert.deepEqual(events, ["first", "second", "third", "newcomer"]);

  let releaseHolder!: () => void;
  const holder = semaphore.run(
    new AbortController().signal,
    async () =>
      new Promise<void>((resolve) => {
        releaseHolder = resolve;
      }),
  );
  await Promise.resolve();
  const cancelled = new AbortController();
  const waiting = semaphore.run(cancelled.signal, async () =>
    assert.fail("cancelled waiter was run"),
  );
  const survivor = semaphore.run(new AbortController().signal, async () => {
    events.push("survivor");
  });
  cancelled.abort();
  await assert.rejects(
    waiting,
    (e: unknown) => e instanceof ProviderError && e.code === "cancel",
  );
  releaseHolder();
  await Promise.all([holder, survivor]);
  assert.equal(events.at(-1), "survivor");
});

test("semaphore deadline includes queue wait and provider limits have hard server caps", async () => {
  const semaphore = new Semaphore(1);
  let release!: () => void;
  const holder = semaphore.run(
    new AbortController().signal,
    async () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  let started = false;
  await assert.rejects(
    semaphore.run(
      new AbortController().signal,
      async () => {
        started = true;
      },
      15,
    ),
    (e: unknown) => e instanceof ProviderError && e.code === "timeout",
  );
  assert.equal(started, false);
  release();
  await holder;
  assert.throws(() => limitsOf({ timeoutMs: 120_001 }), RangeError);
  assert.throws(
    () => limitsOf({ maxResponseBytes: Number.MAX_SAFE_INTEGER }),
    RangeError,
  );
});

test("Brave reader performs a pinned loopback request and settles an aborted in-flight response", async () => {
  let requestCount = 0;
  let acceptHeader = "";
  let clientClosed = false;
  let notifySlowStarted!: () => void;
  const slowStarted = new Promise<void>((resolve) => {
    notifySlowStarted = resolve;
  });
  let notifyClientClosed!: () => void;
  const closeObserved = new Promise<void>((resolve) => {
    notifyClientClosed = resolve;
  });
  const waitForServerSignal = async (signal: Promise<void>, timeoutMs: number, message: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        signal,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const server = createServer((request, response) => {
    requestCount++;
    acceptHeader = String(request.headers.accept ?? "");
    if (request.url === "/slow") {
      response.on("close", () => {
        clientClosed = true;
        notifyClientClosed();
      });
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
      response.flushHeaders();
      notifySlowStarted();
      return;
    }
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/page" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<html><title>Guide &amp; Tips</title><nav>menu text</nav><main><p>one <b>two</b></p><!-- hidden --><script>bad()</script><p>three</p></main></html>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://fixture.invalid:${address.port}`;
  const resolvedHosts: string[] = [];
  const web = createBraveWebSource({
    allowPrivateForTests: true,
    resolveForTests: async (host) => {
      resolvedHosts.push(host);
      return [{ address: "127.0.0.1", family: 4 }];
    },
    limits: { attempts: 1 },
  });
  try {
    const doc = await web.fetchDocument(
      `${origin}/redirect`,
      new AbortController().signal,
    );
    assert.equal(doc.title, "Guide & Tips");
    assert.match(doc.text, /one two\n\nthree/);
    assert.doesNotMatch(doc.text, /menu text|bad\(\)|hidden/);
    assert.equal(requestCount, 2);
    assert.match(acceptHeader, /application\/rss\+xml/);
    assert.match(acceptHeader, /application\/atom\+xml/);
    assert.match(acceptHeader, /\*\/\*;q=0\.1/);
    assert.doesNotMatch(acceptHeader, /application\/\*\+xml/);
    assert.deepEqual(resolvedHosts, ["fixture.invalid", "fixture.invalid"]);
    const controller = new AbortController();
    const pending = web.fetchDocument(`${origin}/slow`, controller.signal);
    await waitForServerSignal(slowStarted, 1000, "Timed out waiting for loopback slow request");
    controller.abort();
    await assert.rejects(
      pending,
      (e: unknown) => e instanceof ProviderError && e.code === "cancel",
    );
    await waitForServerSignal(closeObserved, 500, "Timed out waiting for loopback client connection close");
    assert.equal(clientClosed, true);
    const timed = createBraveWebSource({
      allowPrivateForTests: true,
      resolveForTests: async () => [{ address: "127.0.0.1", family: 4 }],
      limits: { timeoutMs: 20, attempts: 1 },
    });
    await assert.rejects(
      timed.fetchDocument(`${origin}/slow`, new AbortController().signal),
      (e: unknown) => e instanceof ProviderError && e.code === "timeout",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
