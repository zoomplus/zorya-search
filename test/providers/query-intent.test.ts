import { test } from "node:test";
import assert from "node:assert/strict";
import { createJevDecisions } from "../../src/providers/decisions.js";
import { createQueryIntent } from "../../src/providers/query-intent.js";

function json(value: unknown): Response { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }); }

test("query-intent preserves literal query and the frozen V7 two-axis request", async () => {
  let sent: Record<string, unknown> | undefined;
  const decisions = createJevDecisions({ apiKey: "fixture", fetch: async (_url, init) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return json({
      id: "v7-fixture", model: "typesafe/jev-1.14", provider: "TypeSafe",
      answers: {
        taskIntent: { type: "choice", choice: "implement_change", probabilities: { locate_symbol: 0, implement_change: 1, explain_behavior: 0, find_duplicates: 0, find_documentation: 0, find_tests: 0, mixed: 0, unknown: 0 } },
        sourceScope: { type: "choice", choice: "implementation", probabilities: { implementation: 1, documentation: 0, tests: 0, mixed: 0, unspecified: 0 } },
      },
      usage: { input_tokens: 13, output_tokens: 5, cost: 0.0005 },
    });
  } });
  const query = "  Please fix implementation code.\n";
  const result = await createQueryIntent(decisions).classify({ query, signal: new AbortController().signal });
  assert.deepEqual(sent?.state, { query_text: query });
  assert.deepEqual(sent?.provider, { order: ["typesafe"], allow_fallbacks: false, require_parameters: true });
  assert.equal(sent?.model, "typesafe/jev-1.14");
  const questions = sent?.questions as Record<string, { type: string; instructions: string; criteria: Record<string, string> }>;
  assert.deepEqual(Object.keys(questions), ["taskIntent", "sourceScope"]);
  assert.equal(questions.taskIntent?.type, "choice");
  assert.deepEqual(Object.keys(questions.taskIntent?.criteria ?? {}), ["locate_symbol", "implement_change", "explain_behavior", "find_duplicates", "find_documentation", "find_tests", "mixed", "unknown"]);
  assert.deepEqual(Object.keys(questions.sourceScope?.criteria ?? {}), ["implementation", "documentation", "tests", "mixed", "unspecified"]);
  assert.match(questions.taskIntent?.instructions ?? "", /Several related questions or constraints about one behavior do not make the task mixed/);
  assert.match(questions.sourceScope?.instructions ?? "", /A software topic, behavior, bug, or technical identifier alone does not request implementation files/);
  assert.equal(result.taskIntent.choice, "implement_change");
  assert.equal(result.sourceScope.choice, "implementation");
  assert.equal(result.requestId, "v7-fixture");
  assert.deepEqual(result.usage, { inputTokens: 13, outputTokens: 5, totalTokens: 18, estimatedCost: 0.0005 });
});

test("query-intent rejects a foreign label from an injected decisions port", async () => {
  const classifier = createQueryIntent({
    profile: { provider: "typesafe", model: "typesafe/jev-1.14", space: "fixture" },
    usage: () => ({ calls: 0, inputTokens: 0, totalTokens: 0, estimatedCost: 0, latencyMs: 0 }),
    decide: async () => ({
      requestId: null, model: "typesafe/jev-1.14", provider: "TypeSafe",
      answers: {
        taskIntent: { type: "choice", choice: "secret label" },
        sourceScope: { type: "choice", choice: "unspecified" },
      },
      usage: { inputTokens: null, outputTokens: null, totalTokens: null, estimatedCost: null },
    }),
  });
  await assert.rejects(classifier.classify({ query: "find docs", signal: new AbortController().signal }));
});
