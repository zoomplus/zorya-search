import {
  ProviderError,
  type ProviderLimits,
  type ProviderUsage,
} from "./contracts.js";

export type FetchLike = typeof fetch;

export interface HttpConfig {
  baseUrl: string;
  apiKey?: string;
  resolveApiKey?: () => string | undefined;
  apiKeyEnv?: string;
  fetch?: FetchLike;
  limits?: ProviderLimits;
  headers?: Record<string, string>;
}

export function endpoint(base: string, path: string): URL {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new TypeError("Некорректный базовый адрес провайдера");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new TypeError(
      "Базовый адрес провайдера должен использовать HTTPS и не содержать credentials, query или fragment",
    );
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  return url;
}

export function secret(config: HttpConfig): string {
  const value =
    config.apiKey ??
    config.resolveApiKey?.() ??
    (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined);
  if (!value?.trim()) throw new ProviderError("auth");
  return value;
}

const defaults: Required<ProviderLimits> = {
  maxItems: 64,
  maxInputBytes: 1_000_000,
  maxResponseBytes: 4_000_000,
  timeoutMs: 20_000,
  attempts: 2,
  concurrency: 4,
};

const hardCaps: Required<ProviderLimits> = {
  maxItems: 200,
  maxInputBytes: 8_000_000,
  maxResponseBytes: 16_000_000,
  timeoutMs: 120_000,
  attempts: 4,
  concurrency: 16,
};

export function limitsOf(limits?: ProviderLimits): Required<ProviderLimits> {
  const supported = new Set([
    "maxItems",
    "maxInputBytes",
    "maxResponseBytes",
    "timeoutMs",
    "attempts",
    "concurrency",
  ]);
  if (limits && Object.keys(limits).some((key) => !supported.has(key)))
    throw new TypeError("Неизвестное ограничение провайдера");
  const merged = { ...defaults, ...limits };
  for (const [key, value] of Object.entries(merged) as Array<
    [keyof ProviderLimits, number]
  >) {
    if (!Number.isSafeInteger(value) || value < 1 || value > hardCaps[key])
      throw new RangeError(`Превышен предел настройки провайдера: ${key}`);
  }
  return merged;
}

export function snapshotHttpConfig(config: HttpConfig): HttpConfig {
  return Object.freeze({
    baseUrl: config.baseUrl,
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    ...(config.resolveApiKey === undefined
      ? {}
      : { resolveApiKey: config.resolveApiKey }),
    ...(config.apiKeyEnv === undefined ? {} : { apiKeyEnv: config.apiKeyEnv }),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    limits: Object.freeze(limitsOf(config.limits)),
    ...(config.headers === undefined
      ? {}
      : { headers: Object.freeze(structuredClone(config.headers)) }),
  });
}

export class Semaphore {
  #active = 0;
  #queue: Array<{
    resolve: () => void;
    reject: (error: ProviderError) => void;
    signal: AbortSignal;
    cancel: () => void;
  }> = [];
  constructor(
    readonly capacity: number,
    readonly maxQueued = 32,
  ) {}
  async run<T>(
    signal: AbortSignal,
    action: (signal: AbortSignal) => Promise<T>,
    timeoutMs = 20_000,
  ): Promise<T> {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(new ProviderError("cancel"));
    if (signal.aborted) abortFromCaller();
    else signal.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(
      () => controller.abort(new ProviderError("timeout")),
      timeoutMs,
    );
    let acquired = false;
    try {
      await this.#acquire(controller.signal);
      acquired = true;
      if (controller.signal.aborted) throw abortReason(controller.signal);
      return await action(controller.signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abortFromCaller);
      if (acquired) this.#release();
    }
  }
  async #acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortReason(signal);
    if (this.#active < this.capacity) {
      this.#active++;
      return;
    }
    if (this.#queue.length >= this.maxQueued) throw new ProviderError("budget");
    await new Promise<void>((resolve, reject) => {
      let waiter: {
        resolve: () => void;
        reject: (error: ProviderError) => void;
        signal: AbortSignal;
        cancel: () => void;
      };
      const cancel = () => {
        const at = this.#queue.indexOf(waiter);
        if (at >= 0) this.#queue.splice(at, 1);
        reject(abortReason(signal));
      };
      waiter = {
        resolve: () => {
          signal.removeEventListener("abort", cancel);
          resolve();
        },
        reject,
        signal,
        cancel,
      };
      this.#queue.push(waiter);
      signal.addEventListener("abort", waiter.cancel, { once: true });
    });
    if (signal.aborted) {
      this.#release();
      throw abortReason(signal);
    }
    // Разрешение остаётся занятым от передачи очереди до завершения операции.
  }
  #release(): void {
    while (this.#queue.length) {
      const waiter = this.#queue.shift()!;
      if (waiter.signal.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      waiter.resolve();
      return;
    }
    this.#active--;
  }
}

function abortReason(signal: AbortSignal): ProviderError {
  return signal.reason instanceof ProviderError
    ? signal.reason
    : new ProviderError("cancel");
}

export interface HttpResult {
  response: Response;
  body: unknown;
  attempts: number;
}

export class UsageLedger {
  #calls = 0;
  #latencyMs = 0;
  #pending = 0;
  #inputTotal = 0;
  #totalTotal = 0;
  #costTotal = 0;
  #inputKnown = true;
  #totalKnown = true;
  #costKnown = true;

  begin(): {
    attempt: () => void;
    finish: (input: {
      attempts: number;
      inputTokens: number | undefined;
      totalTokens: number | undefined;
      cost: number | undefined;
    }) => void;
    fail: () => void;
  } {
    this.#pending++;
    let settled = false;
    return {
      attempt: () => {
        this.#calls++;
      },
      finish: ({ attempts, inputTokens, totalTokens, cost }) => {
        if (settled) return;
        settled = true;
        this.#pending--;
        if (
          attempts !== 1 ||
          inputTokens === undefined ||
          !Number.isSafeInteger(inputTokens) ||
          inputTokens < 0
        )
          this.#inputKnown = false;
        else this.#inputTotal += inputTokens;
        if (
          attempts !== 1 ||
          totalTokens === undefined ||
          !Number.isSafeInteger(totalTokens) ||
          totalTokens < 0
        )
          this.#totalKnown = false;
        else this.#totalTotal += totalTokens;
        if (
          attempts !== 1 ||
          cost === undefined ||
          !Number.isFinite(cost) ||
          cost < 0
        )
          this.#costKnown = false;
        else this.#costTotal += cost;
      },
      fail: () => {
        if (settled) return;
        settled = true;
        this.#pending--;
        this.#inputKnown = false;
        this.#totalKnown = false;
        this.#costKnown = false;
      },
    };
  }

  addLatency(durationMs: number): void {
    this.#latencyMs += durationMs;
  }

  snapshot(): ProviderUsage {
    return {
      calls: this.#calls,
      inputTokens:
        this.#pending || !this.#calls || !this.#inputKnown
          ? null
          : this.#inputTotal,
      totalTokens:
        this.#pending || !this.#calls || !this.#totalKnown
          ? null
          : this.#totalTotal,
      estimatedCost:
        this.#pending || !this.#calls || !this.#costKnown
          ? null
          : this.#costTotal,
      latencyMs: this.#latencyMs,
    };
  }
}

export async function postJson(
  config: HttpConfig,
  path: string,
  payload: unknown,
  signal: AbortSignal,
  onAttempt?: () => void,
): Promise<HttpResult> {
  const lim = limitsOf(config.limits);
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded) > lim.maxInputBytes)
    throw new ProviderError("budget");
  const fetcher = config.fetch ?? fetch;
  const url = endpoint(config.baseUrl, path);
  const key = secret(config);
  const deadline = Date.now() + lim.timeoutMs;
  let last: ProviderError | undefined;
  let attempts = 0;
  for (let attempt = 0; attempt < lim.attempts; attempt++) {
    if (signal.aborted) throw abortReason(signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ProviderError("timeout");
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, remaining);
    let response: Response | undefined;
    try {
      attempts++;
      onAttempt?.();
      response = await fetcher(url, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          ...config.headers,
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: encoded,
      });
      if (response.status >= 300 && response.status < 400)
        throw new ProviderError("unavailable", response.status);
      if (!response.ok) {
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        const code =
          response.status === 401 || response.status === 403
            ? "auth"
            : response.status === 402
              ? "quota"
              : response.status === 429
                ? "rate_limit"
                : response.status >= 500
                  ? "unavailable"
                  : "malformed";
        throw new ProviderError(code, response.status, retryAfter);
      }
      const body = await readBoundedJson(
        response,
        lim.maxResponseBytes,
        controller.signal,
      );
      return { response, body, attempts };
    } catch (cause) {
      if (signal.aborted) throw abortReason(signal);
      if (controller.signal.aborted) throw new ProviderError("timeout");
      const failure =
        cause instanceof ProviderError
          ? cause
          : new ProviderError("unavailable");
      last = failure;
      if (
        attempt + 1 >= lim.attempts ||
        !["rate_limit", "unavailable"].includes(failure.code)
      )
        throw failure;
      if (response) await cancelResponseBody(response);
      if (failure.retryAfterMs !== undefined)
        await waitUntil(failure.retryAfterMs, deadline, signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (response?.body && !response.body.locked) {
        await response.body.cancel().catch(() => undefined);
      }
    }
  }
  throw last ?? new ProviderError("unavailable");
}

export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw abortReason(signal);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new ProviderError("budget", response.status);
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError("malformed", response.status);
  void reader.closed.catch(() => undefined);
  let cancelTask: Promise<void> | undefined;
  const cancelOnAbort = () => {
    cancelTask = reader
      .cancel(signal ? abortReason(signal) : new ProviderError("cancel"))
      .then(
        () => undefined,
        () => undefined,
      );
  };
  signal?.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    if (signal?.aborted) throw abortReason(signal);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw abortReason(signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ProviderError("budget", response.status);
      chunks.push(value);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ProviderError("malformed", response.status);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new ProviderError("malformed", response.status);
    return parsed;
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
    await (cancelTask ??
      reader.cancel().then(
        () => undefined,
        () => undefined,
      ));
    try {
      reader.releaseLock();
    } catch {
      /* Поток мог освободить блокировку после завершения чтения. */
    }
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body && !response.body.locked)
    await response.body.cancel().catch(() => undefined);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 60_000) : undefined;
}

async function waitUntil(
  ms: number,
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw abortReason(signal);
  if (Date.now() + ms >= deadline) throw new ProviderError("timeout");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", cancel);
      resolve();
    }
    function cancel() {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(abortReason(signal));
    }
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
  });
}
