import type { Classifier } from "./contracts.js";
import type { ProviderLimits } from "./contracts.js";
import { createJevDecisions, JEV_DECISIONS_MODEL } from "./decisions.js";
import { createJevClassifier } from "./jev-classifier.js";
import { limitsOf, type HttpConfig } from "./http.js";

/**
 * Compatibility-shaped classifier constructor. Classification is performed by
 * the pinned Jev Decisions API; OpenRouter chat-completions models are no longer
 * accepted by this Search-owned semantic boundary.
 */
export interface OpenRouterClassifierConfig extends Omit<HttpConfig, "limits"> {
  model: string;
  provider?: Record<string, unknown>;
  profileId?: string;
  limits?: ProviderLimits;
}

export function createOpenRouterClassifier(config: OpenRouterClassifierConfig): Classifier {
  const model = config.model;
  if (model !== JEV_DECISIONS_MODEL) throw new TypeError("Классификатор Search требует typesafe/jev-1.14");
  if (config.provider !== undefined && !isPinnedRouting(config.provider))
    throw new TypeError("Классификатор Search допускает только закреплённую маршрутизацию TypeSafe");
  if (config.limits?.attempts !== undefined && config.limits.attempts !== 1)
    throw new TypeError("Классификатор Jev требует attempts=1");
  const limits = limitsOf({ ...config.limits, attempts: 1 });
  const baseUrl = compatibleBase(config.baseUrl);
  const decisions = createJevDecisions({
    baseUrl,
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    ...(config.resolveApiKey === undefined ? {} : { resolveApiKey: config.resolveApiKey }),
    ...(config.apiKeyEnv === undefined ? {} : { apiKeyEnv: config.apiKeyEnv }),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    ...(config.headers === undefined ? {} : { headers: config.headers }),
    limits: {
      maxItems: Math.min(32, limits.maxItems),
      maxInputBytes: limits.maxInputBytes,
      maxResponseBytes: limits.maxResponseBytes,
      timeoutMs: limits.timeoutMs,
      attempts: 1,
      concurrency: limits.concurrency,
    },
  });
  return createJevClassifier(decisions, {
    maxItems: limits.maxItems,
    maxInputBytes: limits.maxInputBytes,
    timeoutMs: limits.timeoutMs,
    concurrency: limits.concurrency,
    ...(config.profileId === undefined ? {} : { profileId: config.profileId }),
    questionBatchSize: Math.min(32, limits.maxItems),
  });
}

function compatibleBase(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError("Некорректный базовый адрес провайдера"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new TypeError("Базовый адрес провайдера должен использовать HTTPS без credentials, query или fragment");
  if (/\/api\/v1\/?$/u.test(url.pathname)) url.pathname = url.pathname.replace(/\/api\/v1\/?$/u, "/api");
  else if (/\/api\/?$/u.test(url.pathname)) url.pathname = url.pathname.replace(/\/$/u, "");
  else throw new TypeError("Базовый адрес классификатора должен оканчиваться на /api/v1 или /api");
  return url.toString().replace(/\/$/u, "");
}

function isPinnedRouting(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === 3 && value.allow_fallbacks === false && value.require_parameters === true &&
    Array.isArray(value.order) && value.order.length === 1 && value.order[0] === "typesafe";
}
