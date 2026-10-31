import { createHash } from "node:crypto";
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

export interface OpenRouterModelConfig extends HttpConfig {
  model: string;
  provider?: Record<string, unknown>;
  profileId?: string;
  verifyReturnedModel?: boolean;
}

export interface OpenRouterEmbeddingConfig extends OpenRouterModelConfig {
  dimensions: number;
  inputType?: string;
}

export interface OpenRouterRerankerConfig extends OpenRouterModelConfig {
  maxResults?: number;
}

export interface EmbeddingProvider {
  readonly profile: ProviderProfile;
  embed(input: { texts: string[]; signal: AbortSignal }): Promise<number[][]>;
  usage(): ProviderUsage;
}

export interface MultimodalEmbeddingProvider {
  readonly profile: ProviderProfile
  embed(input: {
    texts?: string[]
    images?: Array<{ bytes: Uint8Array; mimeType: string }>
    signal: AbortSignal
  }): Promise<number[][]>
  usage(): ProviderUsage
}

/** OpenRouter multimodal embeddings. Images are supplied as bytes; this adapter never fetches URLs. */
export function createOpenRouterMultimodalEmbedding(
  config: OpenRouterEmbeddingConfig,
): MultimodalEmbeddingProvider {
  const options = snapshotEmbeddingConfig({
    ...config,
    limits: config.limits ?? { maxInputBytes: 8_000_000 },
  })
  if (!options.model?.trim()) throw new TypeError('Embedding model is required')
  endpoint(options.baseUrl, '/embeddings')
  if (!Number.isSafeInteger(options.dimensions) || options.dimensions < 1 || options.dimensions > 8192)
    throw new RangeError('Invalid embedding dimensions')
  const lim = limitsOf(options.limits)
  const profile = makeProfile('openrouter', options, options.dimensions, 'text+image', 'embedding')
  const usage = new UsageLedger()
  const semaphore = new Semaphore(lim.concurrency)
  return {
    profile,
    usage: () => usage.snapshot(),
    async embed({ texts = [], images = [], signal }) {
      if (texts.length + images.length < 1 || texts.length + images.length > lim.maxItems)
        throw new ProviderError('budget')
      if (texts.some((text) => typeof text !== 'string' || !text.trim() || text.length > 20_000))
        throw new ProviderError('malformed')
      const inputBytes = texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0) + images.reduce((sum, image) => sum + (image.bytes instanceof Uint8Array ? image.bytes.length : lim.maxInputBytes + 1), 0)
      if (inputBytes > lim.maxInputBytes) throw new ProviderError('budget')
      const content = [
        ...texts.map((text) => ({ type: 'text', text })),
        ...images.map(({ bytes, mimeType }) => {
          if (!(bytes instanceof Uint8Array) || bytes.length < 1 || !/^image\/(png|jpeg|webp|gif)$/u.test(mimeType))
            throw new ProviderError('malformed')
          return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}` } }
        }),
      ]
      const body = await requestJson(options, '/embeddings', {
        model: options.model,
        input: [{ content }],
        dimensions: options.dimensions,
        encoding_format: 'float',
      }, signal, semaphore, lim, usage)
      if (body.model !== undefined && body.model !== options.model) throw new ProviderError('malformed')
      if (!Array.isArray(body.data) || body.data.length !== 1) throw new ProviderError('malformed')
      const row = body.data[0] as { index?: unknown; embedding?: unknown } | undefined
      if (row?.index !== undefined && row.index !== 0) throw new ProviderError('malformed')
      const vector = row?.embedding
      if (!Array.isArray(vector) || vector.length !== options.dimensions || vector.some((v) => typeof v !== 'number' || !Number.isFinite(v)) || vector.every((v) => v === 0))
        throw new ProviderError('malformed')
      return [vector as number[]]
    },
  }
}

export interface RerankerProvider {
  readonly profile: ProviderProfile;
  rerank(input: {
    query: string;
    documents: string[];
    topN?: number;
    signal: AbortSignal;
  }): Promise<Array<{ index: number; score: number }>>;
  usage(): ProviderUsage;
}

export interface OpenRouterModels {
  readonly profile: ProviderProfile;
  readonly rerankerProfile?: ProviderProfile;
  embed: EmbeddingProvider["embed"];
  rerank?: RerankerProvider["rerank"];
  usage(): { embedding: ProviderUsage; reranker: ProviderUsage | null };
}

/** Эмбеддинги и rerank принимают независимые профили: эти модели часто различаются. */
export function createOpenRouterModels(config: {
  embedding: OpenRouterEmbeddingConfig;
  reranker?: OpenRouterRerankerConfig;
}): OpenRouterModels {
  const embedding = createOpenRouterEmbedding(config.embedding);
  const reranker = config.reranker
    ? createOpenRouterReranker(config.reranker)
    : undefined;
  return {
    profile: embedding.profile,
    ...(reranker
      ? { rerankerProfile: reranker.profile, rerank: reranker.rerank }
      : {}),
    embed: embedding.embed,
    usage: () => ({
      embedding: embedding.usage(),
      reranker: reranker?.usage() ?? null,
    }),
  };
}

export function createOpenRouterEmbedding(
  config: OpenRouterEmbeddingConfig,
): EmbeddingProvider {
  return createEmbedding(config, "openrouter");
}

/** Настройка OpenAI-совместимой embedding-точки не включает rerank автоматически. */
export function createOpenAICompatibleEmbedding(
  config: OpenRouterEmbeddingConfig & { profileId: string },
): EmbeddingProvider {
  return createEmbedding(config, config.profileId);
}

export function createOpenRouterReranker(
  config: OpenRouterRerankerConfig,
): RerankerProvider {
  const options = snapshotModelConfig(config);
  if (!options.model?.trim())
    throw new TypeError("Требуется идентификатор модели rerank");
  endpoint(options.baseUrl, "/rerank");
  if (
    options.maxResults !== undefined &&
    (!Number.isSafeInteger(options.maxResults) ||
      options.maxResults < 1 ||
      options.maxResults > 200)
  )
    throw new RangeError("Некорректный предел результатов rerank");
  const lim = limitsOf(options.limits);
  const profile = makeProfile(
    "openrouter",
    options,
    undefined,
    undefined,
    "rerank",
  );
  const usage = new UsageLedger();
  const semaphore = new Semaphore(lim.concurrency);
  return {
    profile,
    usage: () => usage.snapshot(),
    async rerank({ query, documents, signal, topN: requestedTopN }) {
      validateTexts([query, ...documents], lim.maxItems + 1, lim.maxInputBytes);
      if (!documents.length) return [];
      if (requestedTopN !== undefined && (!Number.isSafeInteger(requestedTopN) || requestedTopN < 1 || requestedTopN > 200))
        throw new ProviderError("budget");
      const topN = Math.min(
        documents.length,
        requestedTopN ?? options.maxResults ?? documents.length,
      );
      const body = await requestJson(
        options,
        "/rerank",
        {
          model: options.model,
          query,
          documents,
          top_n: topN,
          ...(options.provider ? { provider: options.provider } : {}),
        },
        signal,
        semaphore,
        lim,
        usage,
      );
      if (options.verifyReturnedModel && body.model !== undefined && body.model !== options.model)
        throw new ProviderError('malformed');
      if (!Array.isArray(body.results) || body.results.length > topN)
        throw new ProviderError("malformed");
      const seen = new Set<number>();
      return body.results.map((entry) => {
        if (!entry || typeof entry !== "object")
          throw new ProviderError("malformed");
        const { index, relevance_score } = entry as {
          index?: unknown;
          relevance_score?: unknown;
        };
        if (
          !Number.isSafeInteger(index) ||
          (index as number) < 0 ||
          (index as number) >= documents.length ||
          seen.has(index as number) ||
          typeof relevance_score !== "number" ||
          !Number.isFinite(relevance_score)
        )
          throw new ProviderError("malformed");
        seen.add(index as number);
        return { index: index as number, score: relevance_score };
      });
    },
  };
}

function createEmbedding(
  config: OpenRouterEmbeddingConfig,
  providerName: string,
): EmbeddingProvider {
  const options = snapshotEmbeddingConfig(config);
  if (!options.model?.trim())
    throw new TypeError("Требуется идентификатор embedding-модели");
  endpoint(options.baseUrl, "/embeddings");
  if (
    !Number.isSafeInteger(options.dimensions) ||
    options.dimensions < 1 ||
    options.dimensions > 8192
  )
    throw new RangeError("Некорректная размерность embedding-профиля");
  const lim = limitsOf(options.limits);
  const profile = makeProfile(
    providerName,
    options,
    options.dimensions,
    options.inputType,
    "embedding",
  );
  const usage = new UsageLedger();
  const semaphore = new Semaphore(lim.concurrency);
  return {
    profile,
    usage: () => usage.snapshot(),
    async embed({ texts, signal }) {
      validateTexts(texts, lim.maxItems, lim.maxInputBytes);
      const payload: Record<string, unknown> = {
        model: options.model,
        input: texts,
        dimensions: options.dimensions,
      };
      if (options.provider) payload.provider = options.provider;
      if (options.inputType) payload.input_type = options.inputType;
      const body = await requestJson(
        options,
        "/embeddings",
        payload,
        signal,
        semaphore,
        lim,
        usage,
      );
      if (options.verifyReturnedModel && body.model !== undefined && body.model !== options.model)
        throw new ProviderError('malformed');
      if (!Array.isArray(body.data) || body.data.length !== texts.length)
        throw new ProviderError("malformed");
      const ordered: number[][] = Array(texts.length);
      for (const entry of body.data) {
        if (!entry || typeof entry !== "object")
          throw new ProviderError("malformed");
        const { index, embedding } = entry as {
          index?: unknown;
          embedding?: unknown;
        };
        if (
          !Number.isSafeInteger(index) ||
          (index as number) < 0 ||
          (index as number) >= texts.length ||
          ordered[index as number]
        )
          throw new ProviderError("malformed");
        if (
          !Array.isArray(embedding) ||
          embedding.length !== options.dimensions ||
          embedding.some(
            (value) => typeof value !== "number" || !Number.isFinite(value),
          )
        )
          throw new ProviderError("malformed");
        const vector = embedding as number[];
        if (vector.every((value) => value === 0))
          throw new ProviderError("malformed");
        ordered[index as number] = vector;
      }
      if (ordered.some((vector) => !vector))
        throw new ProviderError("malformed");
      return ordered;
    },
  };
}

async function requestJson(
  config: HttpConfig,
  path: string,
  payload: unknown,
  signal: AbortSignal,
  semaphore: Semaphore,
  limits: ReturnType<typeof limitsOf>,
  usage: UsageLedger,
): Promise<Record<string, unknown>> {
  return semaphore.run(
    signal,
    async (operationSignal) => {
      const started = Date.now();
      const receipt = usage.begin();
      try {
        const result = await postJson(
          config,
          path,
          payload,
          operationSignal,
          receipt.attempt,
        );
        if (
          !result.body ||
          typeof result.body !== "object" ||
          Array.isArray(result.body)
        )
          throw new ProviderError("malformed");
        const usageDetails = (
          result.body as {
            usage?: {
              prompt_tokens?: number;
              input_tokens?: number;
              total_tokens?: number;
              cost?: number;
              estimated_cost?: number;
            };
          }
        ).usage;
        const input = usageDetails?.prompt_tokens ?? usageDetails?.input_tokens;
        const cost = usageDetails?.cost ?? usageDetails?.estimated_cost;
        receipt.finish({
          attempts: result.attempts,
          inputTokens: validCount(input),
          totalTokens: validCount(usageDetails?.total_tokens),
          cost: validCost(cost),
        });
        return result.body as Record<string, unknown>;
      } catch (error) {
        receipt.fail();
        throw error;
      } finally {
        usage.addLatency(Date.now() - started);
      }
    },
    limits.timeoutMs,
  );
}

function validCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
function validCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function makeProfile(
  provider: string,
  config: OpenRouterModelConfig,
  dimensions: number | undefined,
  inputType: string | undefined,
  kind: string,
): ProviderProfile {
  const routing = config.provider
    ? structuredClone(config.provider)
    : undefined;
  const fingerprint = stableJson({
    provider,
    profileId: config.profileId,
    endpoint: config.baseUrl,
    model: config.model,
    dimensions,
    inputType,
    kind,
    routing,
  });
  return deepFreeze({
    provider,
    model: config.model,
    ...(dimensions === undefined ? {} : { dimensions }),
    ...(inputType === undefined ? {} : { inputType }),
    ...(config.profileId ? { profileId: config.profileId } : {}),
    ...(routing ? { routing } : {}),
    space: `${kind}:${provider}:${createHash("sha256").update(fingerprint).digest("hex").slice(0, 20)}`,
  });
}

function snapshotModelConfig<T extends OpenRouterModelConfig>(config: T): T {
  const snapshot = snapshotHttpConfig(config);
  const modelConfig = {
    ...config,
    ...snapshot,
    model: config.model,
    ...(config.provider === undefined
      ? {}
      : { provider: deepFreeze(structuredClone(config.provider)) }),
    ...(config.profileId === undefined ? {} : { profileId: config.profileId }),
  };
  return Object.freeze(modelConfig) as T;
}

function snapshotEmbeddingConfig(
  config: OpenRouterEmbeddingConfig,
): OpenRouterEmbeddingConfig {
  return Object.freeze({
    ...snapshotModelConfig(config),
    dimensions: config.dimensions,
    ...(config.inputType === undefined ? {} : { inputType: config.inputType }),
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function validateTexts(
  texts: string[],
  maxItems: number,
  maxBytes: number,
): void {
  if (
    !texts.length ||
    texts.length > maxItems ||
    texts.some((text) => typeof text !== "string" || !text.trim()) ||
    Buffer.byteLength(JSON.stringify(texts)) > maxBytes
  )
    throw new ProviderError("budget");
}
