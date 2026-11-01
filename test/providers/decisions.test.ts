import { test } from "node:test";
import assert from "node:assert/strict";
import { createJevDecisions } from "../../src/providers/decisions.js";
import { ProviderError } from "../../src/providers/contracts.js";
import type { JevQuestion } from "../../src/providers/decision-types.js";

const signal = () => new AbortController().signal;
const choice: JevQuestion = {
  id: "axis",
  type: "choice",
  instructions: "Use the supplied criteria.",
  criteria: { "legacy::x": "First option", second: "Second option" },
};
function response(answers: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    model: "typesafe/jev-1.14",
    provider: "TypeSafe",
    answers,
    usage: { input_tokens: 7, output_tokens: 3, cost: 0.001 },
    ...extra,
  };
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("Jev Decisions pins the OpenRouter route and sends typed mixed questions", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const provider = createJevDecisions({
    apiKey: "fixture-secret",
    fetch: async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return json(response({
        axis: { type: "choice", choice: "legacy::x", confidence: 0.73 },
        existence: { type: "noul", noul: 0.87 },
        rating: { type: "score", score: 1.99, probabilities: { "0": 0, "1": 0, "2": 1 }, legend: { "0": "low", "1": "mid", "2": "high" } },
      }));
    },
  });
  const result = await provider.decide({
    state: { query: " literal data " },
    questions: [
      choice,
      { id: "existence", type: "noul", instructions: "Test presence.", criteria: { true: "Present", false: "Absent" } },
      { id: "rating", type: "score", instructions: "Rate it.", criteria: ["low", "mid", "high"] },
    ],
    signal: signal(),
  });
  assert.equal(capturedUrl, "https://openrouter.ai/api/alpha/decisions");
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("authorization"), "Bearer fixture-secret");
  assert.equal(capturedInit?.method, "POST");
  const payload = JSON.parse(String(capturedInit?.body)) as {
    model: string;
    provider: Record<string, unknown>;
    state: Record<string, unknown>;
    questions: Record<string, unknown>;
  };
  assert.equal(payload.model, "typesafe/jev-1.14");
  assert.deepEqual(payload.provider, { order: ["typesafe"], allow_fallbacks: false, require_parameters: true });
  assert.deepEqual(payload.state, { query: " literal data " });
  assert.deepEqual(Object.keys(payload.questions), ["axis", "existence", "rating"]);
  assert.deepEqual(payload.questions.axis, { type: "choice", instructions: choice.instructions, criteria: choice.criteria });
  assert.equal("probabilityRoundingStep" in payload, false);
  assert.equal(result.answers.axis?.type, "choice");
  assert.equal(result.answers.existence?.type, "noul");
  assert.deepEqual(result.answers.rating, {
    type: "score", score: 1.99, probabilities: { "0": 0, "1": 0, "2": 1 },
    probabilityBasis: "distribution", legend: { "0": "low", "1": "mid", "2": "high" },
  });
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10, estimatedCost: 0.001 });
  assert.deepEqual(provider.usage(), { calls: 1, inputTokens: 7, totalTokens: 10, estimatedCost: 0.001, latencyMs: provider.usage().latencyMs });
});

test("Jev snapshots caller data before dispatch and accepts technical JSON keys", async () => {
  let body = "";
  let release!: (value: Response) => void;
  const pendingResponse = new Promise<Response>((resolve) => { release = resolve; });
  const provider = createJevDecisions({ apiKey: "fixture", fetch: async (_url, init) => {
    body = String(init?.body);
    return pendingResponse;
  } });
  const state = { nested: { label: "before" } };
  const criteria = JSON.parse('{"__proto__":"Data","constructor":"Code"}') as Record<string, string>;
  const questions: JevQuestion[] = [{ id: "tech/id", type: "choice", instructions: "Choose", criteria }];
  const pending = provider.decide({ state, questions, signal: signal() });
  state.nested.label = "after";
  criteria.constructor = "mutated";
  questions[0]!.instructions = "mutated";
  await new Promise((resolve) => setImmediate(resolve));
  const sent = JSON.parse(body) as { state: { nested: { label: string } }; questions: Record<string, { instructions: string; criteria: Record<string, string> }> };
  assert.equal(sent.state.nested.label, "before");
  assert.equal(sent.questions["tech/id"]?.instructions, "Choose");
  assert.equal(sent.questions["tech/id"]?.criteria.constructor, "Code");
  release(json(response({ "tech/id": { type: "choice", choice: "__proto__" } })));
  await pending;
});

test("provider configuration and headers are snapshotted at construction", async () => {
  let seenUrl = "";
  let seenKey = "";
  let seenTenant = "";
  const config = {
    baseUrl: "https://router.fixture/api",
    apiKey: "initial-key",
    headers: { "x-tenant": "initial-tenant" },
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(url);
      const headers = new Headers(init?.headers);
      seenKey = headers.get("authorization") ?? "";
      seenTenant = headers.get("x-tenant") ?? "";
      return json(response({ axis: { type: "choice", choice: "legacy::x" } }));
    },
  };
  const provider = createJevDecisions(config);
  config.baseUrl = "https://mutated.invalid";
  config.apiKey = "mutated-key";
  config.headers["x-tenant"] = "mutated-tenant";
  await provider.decide({ state: {}, questions: [choice], signal: signal() });
  assert.equal(seenUrl, "https://router.fixture/api/alpha/decisions");
  assert.equal(seenKey, "Bearer initial-key");
  assert.equal(seenTenant, "initial-tenant");
});

test("Choice rounding is retained without normalization; bad mass, tied max, and foreign labels fail", async () => {
  const make = (answer: unknown) => createJevDecisions({ apiKey: "fixture", fetch: async () => json(response({ axis: answer })) });
  const rounded = await make({ type: "choice", choice: "legacy::x", probabilities: { "legacy::x": 0.67, second: 0.33 } }).decide({ state: {}, questions: [choice], signal: signal() });
  assert.equal(rounded.answers.axis?.type, "choice");
  const lattice = await make({ type: "choice", choice: "second", probabilities: { "legacy::x": 0.33, second: 0.66 } }).decide({ state: {}, questions: [choice], signal: signal() });
  assert.deepEqual(lattice.answers.axis, {
    type: "choice", choice: "second", probabilities: { "legacy::x": 0.33, second: 0.66 },
    probabilityBasis: "rounded-distribution", probabilityRoundingStep: 0.01,
  });
  for (const answer of [
    { type: "choice", choice: "legacy::x", probabilities: { "legacy::x": 0.5, second: 0.5 } },
    { type: "choice", choice: "legacy::x", probabilities: { "legacy::x": 0.8, second: 0.8 } },
    { type: "choice", choice: "foreign" },
  ]) {
    await assert.rejects(make(answer).decide({ state: {}, questions: [choice], signal: signal() }), (error: unknown) => error instanceof ProviderError && error.code === "malformed");
  }
});

test("Score keeps raw score and permits tied distributions with optional confidence", async () => {
  const question: JevQuestion = { id: "score", type: "score", instructions: "Score", criteria: ["low", "mid", "high"] };
  const provider = createJevDecisions({ apiKey: "fixture", fetch: async () => json(response({
    score: { type: "score", score: 0.5, confidence: 0.8, probabilities: { "0": 0.5, "1": 0.5, "2": 0 }, legend: { "0": "low", "1": "mid", "2": "high" } },
  })) });
  const result = await provider.decide({ state: {}, questions: [question], signal: signal() });
  assert.deepEqual(result.answers.score, {
    type: "score", score: 0.5, confidence: 0.8,
    probabilities: { "0": 0.5, "1": 0.5, "2": 0 }, probabilityBasis: "distribution",
    legend: { "0": "low", "1": "mid", "2": "high" },
  });
  const documented = createJevDecisions({ apiKey: "fixture", fetch: async () => json(response({
    score: { type: "score", score: 1.99, probabilities: { "0": 0, "1": 0, "2": 1 } },
  })) });
  const raw = await documented.decide({ state: {}, questions: [question], signal: signal() });
  assert.deepEqual(raw.answers.score && raw.answers.score.type === "score" ? [raw.answers.score.score, raw.answers.score.probabilities] : null,
    [1.99, { "0": 0, "1": 0, "2": 1 }]);
  const impossible = createJevDecisions({ apiKey: "fixture", fetch: async () => json(response({
    score: { type: "score", score: 1.99, probabilities: { "0": 0.5, "1": 0.5, "2": 0 } },
  })) });
  await assert.rejects(impossible.decide({ state: {}, questions: [question], signal: signal() }), (error: unknown) => error instanceof ProviderError && error.code === "malformed");
});

test("Jev validates exact response identity, answer keys/types, and calendar revisions", async () => {
  const cases = [
    response({ axis: { type: "choice", choice: "legacy::x" } }, { model: "typesafe/jev-1.13" }),
    response({ axis: { type: "choice", choice: "legacy::x" } }, { model: "typesafe/jev-1.14-20260230" }),
    response({ axis: { type: "choice", choice: "legacy::x" } }, { model: "typesafe/jev-1.14-20260228" , provider: "typesafe" }),
    response({ axis: { type: "noul", noul: 0.7 } }),
    response({ other: { type: "choice", choice: "legacy::x" } }),
  ];
  cases[2] = response({ axis: { type: "choice", choice: "legacy::x" } }, { model: "typesafe/jev-1.14-20260228" });
  const dated = await createJevDecisions({ apiKey: "fixture", fetch: async () => json(cases[2]) }).decide({ state: {}, questions: [choice], signal: signal() });
  assert.equal(dated.model, "typesafe/jev-1.14-20260228");
  for (const invalid of [cases[0], cases[1], cases[3], cases[4]]) {
    await assert.rejects(createJevDecisions({ apiKey: "fixture", fetch: async () => json(invalid) }).decide({ state: {}, questions: [choice], signal: signal() }), (error: unknown) => error instanceof ProviderError && error.code === "malformed");
  }
});

test("input validation, unsupported retries, HTTP errors, and response caps fail safely", async () => {
  assert.throws(() => createJevDecisions({ limits: { attempts: 2 } }), TypeError);
  let calls = 0;
  const provider = createJevDecisions({ apiKey: "secret-value", fetch: async () => { calls++; return json({ secret: "response-secret" }, 401); } });
  const invalid: Array<{ state: unknown; questions: unknown }> = [
    { state: { count: Number.NaN }, questions: [choice] },
    { state: {}, questions: [] },
    { state: {}, questions: [choice, choice] },
    { state: {}, questions: [{ ...choice, criteria: { one: "x" } }] },
    { state: {}, questions: [{ id: "too_many_levels", type: "score", instructions: "Score", criteria: Array.from({ length: 11 }, (_, index) => `level ${index}`) }] },
  ];
  const cyclic: Record<string, unknown> = {};
  cyclic.loop = cyclic;
  invalid.push({ state: cyclic, questions: [choice] });
  const deep: Record<string, unknown> = {};
  let node = deep;
  for (let i = 0; i < 70; i++) { const child: Record<string, unknown> = {}; node.child = child; node = child; }
  invalid.push({ state: deep, questions: [choice] });
  for (const item of invalid) {
    await assert.rejects(provider.decide({ ...item, signal: signal() }), (error: unknown) => error instanceof ProviderError && error.code === "budget");
  }
  assert.equal(calls, 0);
  await assert.rejects(provider.decide({ state: {}, questions: [choice], signal: signal() }), (error: unknown) => error instanceof ProviderError && error.code === "auth" && !error.message.includes("secret"));
  assert.equal(calls, 1);
  assert.equal(provider.usage().calls, 1);
  assert.equal(provider.usage().estimatedCost, null);
  for (const [status, expected] of [[402, "quota"], [429, "rate_limit"]] as const) {
    let attempts = 0;
    const failed = createJevDecisions({ apiKey: "fixture", limits: { attempts: 1 }, fetch: async () => { attempts++; return json({ upstream: "private" }, status); } });
    await assert.rejects(failed.decide({ state: {}, questions: [choice], signal: signal() }), (error: unknown) => error instanceof ProviderError && error.code === expected && !error.message.includes("private"));
    assert.equal(attempts, 1);
    assert.equal(failed.usage().calls, 1);
  }
  const limited = createJevDecisions({ apiKey: "fixture", limits: { maxResponseBytes: 32 }, fetch: async () => json(response({ axis: { type: "choice", choice: "legacy::x" } })) });
  await assert.rejects(limited.decide({ state: {}, questions: [choice], signal: signal() }), (error: unknown) => error instanceof ProviderError && error.code === "budget");
});

test("one attempt and the semaphore retain ownership until a delayed physical fetch settles", async () => {
  let resolveFirst!: (response: Response) => void;
  let calls = 0;
  const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve; });
  const firstController = new AbortController();
  const provider = createJevDecisions({
    apiKey: "fixture",
    limits: { concurrency: 1, timeoutMs: 1_000 },
    fetch: async () => {
      calls++;
      if (calls === 1) return firstResponse;
      return json(response({ axis: { type: "choice", choice: "legacy::x" } }));
    },
  });
  const first = provider.decide({ state: {}, questions: [choice], signal: firstController.signal });
  await new Promise((resolve) => setImmediate(resolve));
  const second = provider.decide({ state: {}, questions: [choice], signal: signal() });
  firstController.abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  resolveFirst(json(response({ axis: { type: "choice", choice: "legacy::x" } })));
  await assert.rejects(first, (error: unknown) => error instanceof ProviderError && error.code === "cancel");
  await second;
  assert.equal(calls, 2);
  assert.equal(provider.usage().calls, 2);
  assert.equal(provider.usage().estimatedCost, null);
});

test("aborted body cancellation is joined before a queued request acquires the permit", async () => {
  let releaseCancellation!: () => void;
  let notifyCancellation!: () => void;
  let notifyFirstRead!: () => void;
  const cancellationStarted = new Promise<void>((resolve) => { notifyCancellation = resolve; });
  const firstRead = new Promise<void>((resolve) => { notifyFirstRead = resolve; });
  const cancellationGate = new Promise<void>((resolve) => { releaseCancellation = resolve; });
  let calls = 0;
  const controller = new AbortController();
  const provider = createJevDecisions({
    apiKey: "fixture",
    limits: { concurrency: 1, timeoutMs: 1_000 },
    fetch: async () => {
      calls++;
      if (calls > 1) return json(response({ axis: { type: "choice", choice: "legacy::x" } }));
      const body = new ReadableStream<Uint8Array>({
        start(streamController) { streamController.enqueue(new TextEncoder().encode("{")); },
        pull() { notifyFirstRead(); },
        cancel() { notifyCancellation(); return cancellationGate; },
      });
      return new Response(body, { headers: { "content-type": "application/json" } });
    },
  });
  const first = provider.decide({ state: {}, questions: [choice], signal: controller.signal });
  await firstRead;
  const second = provider.decide({ state: {}, questions: [choice], signal: signal() });
  controller.abort();
  await cancellationStarted;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  releaseCancellation();
  await assert.rejects(first, (error: unknown) => error instanceof ProviderError && error.code === "cancel");
  await second;
  assert.equal(calls, 2);
});

test("queued cancellation never starts transport and timeout waits for an uncooperative fetch", async () => {
  let releaseFirst!: (response: Response) => void;
  let calls = 0;
  const firstResponse = new Promise<Response>((resolve) => { releaseFirst = resolve; });
  const provider = createJevDecisions({
    apiKey: "fixture", limits: { concurrency: 1, timeoutMs: 80 },
    fetch: async () => {
      calls++;
      if (calls === 1) return firstResponse;
      return json(response({ axis: { type: "choice", choice: "legacy::x" } }));
    },
  });
  const first = provider.decide({ state: {}, questions: [choice], signal: signal() });
  await new Promise((resolve) => setImmediate(resolve));
  const queuedController = new AbortController();
  const queued = provider.decide({ state: {}, questions: [choice], signal: queuedController.signal });
  queuedController.abort();
  await assert.rejects(queued, (error: unknown) => error instanceof ProviderError && error.code === "cancel");
  assert.equal(calls, 1);
  releaseFirst(json(response({ axis: { type: "choice", choice: "legacy::x" } })));
  await first;
  assert.equal(calls, 1);

  let releaseTimed!: (response: Response) => void;
  const timedResponse = new Promise<Response>((resolve) => { releaseTimed = resolve; });
  let timedStarted = false;
  const timed = createJevDecisions({ apiKey: "fixture", limits: { timeoutMs: 25 }, fetch: async () => {
    timedStarted = true;
    return timedResponse;
  } });
  const delayed = timed.decide({ state: {}, questions: [choice], signal: signal() });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(timedStarted, true);
  releaseTimed(json(response({ axis: { type: "choice", choice: "legacy::x" } })));
  await assert.rejects(delayed, (error: unknown) => error instanceof ProviderError && error.code === "timeout");
});
