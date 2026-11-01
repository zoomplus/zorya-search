import {
  ProviderError,
  type ProviderProfile,
  type ProviderUsage,
} from "./contracts.js";
import {
  endpoint,
  limitsOf,
  postJson,
  Semaphore,
  snapshotHttpConfig,
  UsageLedger,
  type HttpConfig,
} from "./http.js";
import {
  responseUsage,
  snapshotDecisionInput,
  validateDecisionResponse,
} from "./decision-validation.js";
import type { DecisionJson, JevDecisionsPort, JevQuestion } from "./decision-types.js";

export const JEV_DECISIONS_MODEL = "typesafe/jev-1.14";
export const JEV_DECISIONS_ENDPOINT = "/alpha/decisions";
const DEFAULT_BASE_URL = "https://openrouter.ai/api";

export interface JevDecisionsConfig extends Omit<HttpConfig, "baseUrl"> {
  baseUrl?: string;
}

export function createJevDecisions(config: JevDecisionsConfig = {}): JevDecisionsPort {
  if (config.limits) limitsOf(config.limits);
  if (config.limits?.attempts !== undefined && config.limits.attempts !== 1)
    throw new TypeError("Jev Decisions требует одну попытку транспорта");
  const mergedLimits = {
    maxItems: config.limits?.maxItems ?? 32,
    maxInputBytes: config.limits?.maxInputBytes ?? 131_072,
    maxResponseBytes: config.limits?.maxResponseBytes ?? 262_144,
    timeoutMs: config.limits?.timeoutMs ?? 15_000,
    attempts: 1,
    concurrency: config.limits?.concurrency ?? 1,
  };
  const httpConfig = snapshotHttpConfig({
    ...config,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    limits: mergedLimits,
  });
  const lim = limitsOf(mergedLimits);
  endpoint(httpConfig.baseUrl, JEV_DECISIONS_ENDPOINT);
  const http: HttpConfig = httpConfig;
  const profile: ProviderProfile = Object.freeze({
    provider: "typesafe",
    model: JEV_DECISIONS_MODEL,
    profileId: "typesafe-jev-1.14",
    routing: Object.freeze({
      order: Object.freeze(["typesafe"]),
      allow_fallbacks: false,
      require_parameters: true,
    }),
    space: `decisions:typesafe:${JEV_DECISIONS_MODEL}`,
  });
  const queue = new Semaphore(lim.concurrency);
  const ledger = new UsageLedger();
  return {
    profile,
    usage: (): ProviderUsage => ledger.snapshot(),
    async decide(input: { state: DecisionJson; questions: JevQuestion[]; signal: AbortSignal }) {
      if (input.signal.aborted) throw new ProviderError("cancel");
      const copied = snapshotDecisionInput(input.state, input.questions, lim.maxInputBytes);
      if (copied.questions.length > lim.maxItems) throw new ProviderError("budget");
      const wireQuestions: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const question of copied.questions) {
        wireQuestions[question.id] = question.type === "choice"
          ? { type: question.type, instructions: question.instructions, criteria: { ...question.criteria } }
          : { type: question.type, instructions: question.instructions, criteria: question.criteria };
      }
      const payload = {
        model: JEV_DECISIONS_MODEL,
        provider: { order: ["typesafe"], allow_fallbacks: false, require_parameters: true },
        state: copied.state,
        questions: wireQuestions,
      };
      const encoded = JSON.stringify(payload);
      if (Buffer.byteLength(encoded) > lim.maxInputBytes) throw new ProviderError("budget");
      return queue.run(input.signal, async (operationSignal) => {
        const started = Date.now();
        const receipt = ledger.begin();
        try {
          const result = await postJson(http, JEV_DECISIONS_ENDPOINT, payload, operationSignal, receipt.attempt);
          const usage = responseUsage(result.body);
          receipt.finish({ attempts: result.attempts, ...usage });
          return validateDecisionResponse(result.body, copied.questions);
        } catch (error) {
          receipt.fail();
          throw error;
        } finally {
          ledger.addLatency(Date.now() - started);
        }
      }, lim.timeoutMs);
    },
  };
}
