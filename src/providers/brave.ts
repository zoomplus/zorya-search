import { Resolver } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingHttpHeaders } from "node:http";
import {
  documentSchema,
  webDateRangeSchema,
  type SourceDocument,
  type WebSource,
} from "../core/contracts.js";
import { ProviderError, type ProviderUsage } from "./contracts.js";
import {
  parseDate,
  parsePdfDocument,
  parseWebDocument,
  type ParsedWebDocument,
} from "./web-document.js";
import {
  limitsOf,
  readBoundedJson,
  Semaphore,
  type FetchLike,
} from "./http.js";
import { BraveQuota } from "./brave-quota.js";
import { BraveDocumentCache } from "./brave-document-cache.js";

export type WebLoader = (
  url: URL,
  signal: AbortSignal,
  maxBytes: number,
) => Promise<{
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  url: URL;
}>;

export interface BraveWebSourceConfig {
  apiKey?: string;
  resolveApiKey?: () => string | undefined;
  apiKeyEnv?: string;
  fetch?: FetchLike;
  limits?: {
    maxItems?: number;
    maxInputBytes?: number;
    maxResponseBytes?: number;
    timeoutMs?: number;
    attempts?: number;
    concurrency?: number;
    maxRequestsPerSecond?: number;
  };
  allowPrivateForTests?: boolean;
  resolveForTests?: (
    hostname: string,
  ) => Promise<Array<{ address: string; family: number }>>;
  loader?: WebLoader;
  locale?: string;
  maxSearchRequests?: number;
}

export function createBraveWebSource(
  config: BraveWebSourceConfig = {},
): WebSource & { usage(): ProviderUsage } {
  const { maxRequestsPerSecond = 1, ...providerLimits } = config.limits ?? {};
  const lim = limitsOf({
    ...providerLimits,
    maxItems: providerLimits.maxItems ?? 20,
  });
  const maxSearchRequests = config.maxSearchRequests ?? 10;
  if (
    !Number.isSafeInteger(maxSearchRequests) ||
    maxSearchRequests < 1 ||
    maxSearchRequests > 10
  )
    throw new RangeError("Превышен предел запросов поиска Brave");
  if (config.resolveForTests && !config.allowPrivateForTests)
    throw new TypeError(
      "Резолвер для тестов разрешён только в изолированном private-test режиме",
    );
  const options: Readonly<BraveWebSourceConfig> = Object.freeze({
    ...config,
    limits: Object.freeze(lim),
    maxSearchRequests,
  });
  const queue = new Semaphore(lim.concurrency);
  if (!Number.isSafeInteger(maxRequestsPerSecond) || maxRequestsPerSecond < 1 || maxRequestsPerSecond > 100)
    throw new RangeError("Некорректный предел частоты запросов Brave");
  const quota = new BraveQuota(maxRequestsPerSecond);
  const documentCache = new BraveDocumentCache(128, 16 * 1024 * 1024);
  const stats: ProviderUsage = {
    calls: 0,
    inputTokens: null,
    totalTokens: null,
    estimatedCost: null,
    latencyMs: 0,
  };
  const fetcher = options.fetch ?? fetch;
  return {
    usage: () => ({ ...stats }),
    async discover(query, target, signal, discoverOptions) {
      const dateRange = discoverOptions?.dateRange === undefined
        ? undefined
        : webDateRangeSchema.parse(discoverOptions.dateRange)
      if (
        !query.trim() ||
        Buffer.byteLength(query) > lim.maxInputBytes ||
        !Number.isSafeInteger(target) ||
        target < 1
      )
        throw new ProviderError("budget");
      const key =
        options.apiKey ??
        options.resolveApiKey?.() ??
        (options.apiKeyEnv ? process.env[options.apiKeyEnv] : undefined);
      if (!key?.trim()) throw new ProviderError("auth");
      return queue.run(
        signal,
        async (operationSignal) => {
          const urls: string[] = [];
          const seen = new Set<string>();
          const count = Math.min(target, lim.maxItems);
          const fetchBudget = maxSearchRequests;
          let requests = 0;
          const deadline = Date.now() + lim.timeoutMs;
          for (
            let page = 0;
            page < fetchBudget && urls.length < count;
            page++
          ) {
            if (requests >= maxSearchRequests) break;
            if (operationSignal.aborted)
              throw operationSignal.reason instanceof ProviderError
                ? operationSignal.reason
                : new ProviderError("cancel");
            const url = new URL(
              "https://api.search.brave.com/res/v1/web/search",
            );
            url.searchParams.set("q", query);
            url.searchParams.set("count", "20");
            url.searchParams.set("offset", String(page));
            if (dateRange) {
              url.searchParams.set(
                "freshness",
                `${dateRange.from}to${dateRange.through}`,
              );
            }
            if (options.locale)
              url.searchParams.set("search_lang", options.locale);
            let raw: unknown;
            for (
              let attempt = 0;
              attempt < lim.attempts && requests < maxSearchRequests;
              attempt++
            ) {
              const remaining = deadline - Date.now();
              if (remaining <= 0) throw new ProviderError("timeout");
              await quota.acquire(deadline, operationSignal);
              if (operationSignal.aborted)
                throw operationSignal.reason instanceof ProviderError
                  ? operationSignal.reason
                  : new ProviderError("cancel");
              const controller = new AbortController();
              const abort = () => controller.abort(operationSignal.reason);
              operationSignal.addEventListener("abort", abort, { once: true });
              const timer = setTimeout(
                () => controller.abort(new ProviderError("timeout")),
                remaining,
              );
              let response: Response | undefined;
              const callStarted = Date.now();
              requests++;
              stats.calls++;
              try {
                response = await fetcher(url, {
                  headers: {
                    "X-Subscription-Token": key,
                    accept: "application/json",
                  },
                  redirect: "error",
                  signal: controller.signal,
                });
                quota.observe(response.headers, response.status);
                if (operationSignal.aborted)
                  throw operationSignal.reason instanceof ProviderError
                    ? operationSignal.reason
                    : new ProviderError("cancel");
                if (!response.ok)
                  throw statusError(
                    response.status,
                    response.headers.get("retry-after"),
                  );
                raw = await readBoundedJson(
                  response,
                  lim.maxResponseBytes,
                  operationSignal,
                );
                break;
              } catch (error) {
                if (operationSignal.aborted)
                  throw operationSignal.reason instanceof ProviderError
                    ? operationSignal.reason
                    : new ProviderError("cancel");
                if (controller.signal.aborted)
                  throw controller.signal.reason instanceof ProviderError
                    ? controller.signal.reason
                    : new ProviderError("timeout");
                const failure =
                  error instanceof ProviderError
                    ? error
                    : new ProviderError("unavailable");
                if (
                  attempt + 1 >= lim.attempts ||
                  requests >= maxSearchRequests ||
                  !["rate_limit", "unavailable"].includes(failure.code)
                )
                  throw failure;
                if (response?.body && !response.body.locked)
                  await response.body.cancel().catch(() => undefined);
                if (failure.retryAfterMs !== undefined)
                  await waitUntil(
                    failure.retryAfterMs,
                    deadline,
                    operationSignal,
                  );
              } finally {
                clearTimeout(timer);
                operationSignal.removeEventListener("abort", abort);
                if (response?.body && !response.body.locked)
                  await response.body.cancel().catch(() => undefined);
                stats.latencyMs += Date.now() - callStarted;
              }
            }
            const results = (
              raw as { web?: { results?: Array<{ url?: unknown }> } }
            )?.web?.results;
            if (!Array.isArray(results)) throw new ProviderError("malformed");
            for (const item of results) {
              if (
                !item ||
                typeof item !== "object" ||
                typeof item.url !== "string"
              )
                continue;
              try {
                const safe = canonicalPublicUrl(
                  item.url,
                  options.allowPrivateForTests === true,
                );
                const keyUrl = safe.href;
                if (!seen.has(keyUrl)) {
                  seen.add(keyUrl);
                  urls.push(keyUrl);
                }
                if (urls.length >= count) break;
              } catch {
                /* Удаляем небезопасные URL из поисковой выдачи. */
              }
            }
            const moreAvailable =
              (raw as { query?: { more_results_available?: unknown } }).query
                ?.more_results_available === true;
            if (!moreAvailable) break;
          }
          return urls.slice(0, count);
        },
        lim.timeoutMs,
      );
    },
    async fetchDocument(input, signal) {
      const url = canonicalPublicUrl(
        input,
        options.allowPrivateForTests === true,
      );
      return queue.run(
        signal,
        async (operationSignal) => {
          const started = Date.now();
          let fetched: Awaited<ReturnType<WebLoader>> & { validatorsSent?: boolean };
          let cacheTicket: ReturnType<BraveDocumentCache["begin"]> | undefined;
          try {
            if (options.loader) {
              stats.calls++;
              try {
                fetched = await options.loader(
                  url,
                  operationSignal,
                  lim.maxResponseBytes,
                );
              } finally {
                stats.latencyMs += Date.now() - started;
              }
            } else {
              cacheTicket = documentCache.begin(url.href);
              fetched = await loadPublicUrl(
                url,
                operationSignal,
                lim.maxResponseBytes,
                options.allowPrivateForTests === true,
                lim.timeoutMs,
                options.resolveForTests,
                cacheTicket.validators,
                (duration) => {
                  stats.calls++;
                  stats.latencyMs += duration;
                },
              );
              if (fetched.status === 304) {
                if (
                  !cacheTicket.entry ||
                  !cacheTicket.validators ||
                  fetched.validatorsSent !== true ||
                  fetched.url.href !== url.href
                )
                  throw new ProviderError("malformed", 304);
                const responseEtag = header(fetched.headers, "etag");
                if (responseEtag && cacheTicket.validators.etag && !weaklyMatchesETag(responseEtag, cacheTicket.validators.etag))
                  throw new ProviderError("malformed", 304);
                const refreshed = documentCache.refresh(
                  cacheTicket,
                  fetched.headers,
                  new Date().toISOString(),
                );
                if (!refreshed) throw new ProviderError("malformed", 304);
                return refreshed;
              }
            }
            if (!Buffer.isBuffer(fetched.body) || fetched.body.byteLength > lim.maxResponseBytes)
              throw new ProviderError("budget");
            if (fetched.status < 200 || fetched.status >= 300)
              throw statusError(fetched.status);
            const contentType = header(fetched.headers, "content-type")
              ?.split(";")[0]
              ?.trim()
              .toLowerCase();
            const contentEncoding = header(
              fetched.headers,
              "content-encoding",
            )?.toLowerCase();
            if (contentEncoding && contentEncoding !== "identity")
              throw new ProviderError("malformed");
            const isPdf = contentType === "application/pdf";
            if (!isPdf && !isSupportedWebType(contentType ?? ""))
              throw new ProviderError("malformed", fetched.status);
            let parsed: ParsedWebDocument;
            if (isPdf) {
              parsed = await parsePdfDocument(fetched.body, fetched.url.hostname, operationSignal);
            } else {
              const charset = /charset\s*=\s*([\w-]+)/i
                .exec(header(fetched.headers, "content-type") ?? "")?.[1]
                ?.toLowerCase();
              if (
                charset &&
                !["utf-8", "utf8", "us-ascii", "ascii"].includes(charset)
              )
                throw new ProviderError("malformed");
              let raw: string;
              try {
                raw = new TextDecoder("utf-8", { fatal: true }).decode(
                  fetched.body,
                );
              } catch {
                throw new ProviderError("malformed");
              }
              parsed = parseWebDocument(raw, contentType ?? "", fetched.url.hostname);
            }
            if (!parsed.sourceUpdatedAt && fetched.status !== 304) {
              parsed.sourceUpdatedAt = lastModifiedDate(fetched.headers);
            }
            if (!parsed.text.trim()) throw new ProviderError("malformed");
            const document = {
              url: fetched.url.href,
              title: parsed.title,
              text: parsed.text,
              fetchedAt: new Date().toISOString(),
              publishedAt: parsed.publishedAt,
              sourceUpdatedAt: parsed.sourceUpdatedAt,
            };
            try {
              const parsedDocument = documentSchema.parse(document) as SourceDocument;
              if (!options.loader && fetched.status === 200 && cacheTicket && fetched.url.href === url.href && !operationSignal.aborted) {
                documentCache.store(cacheTicket, parsedDocument, fetched.headers);
              }
              return parsedDocument;
            } catch {
              throw new ProviderError("malformed");
            }
          } finally {
            if (cacheTicket) documentCache.release(cacheTicket);
          }
        },
        lim.timeoutMs,
      );
    },
  };
}

export function canonicalPublicUrl(value: string, allowPrivate = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderError("malformed");
  }
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (!allowPrivate && url.port && url.port !== defaultPort)
  )
    throw new ProviderError("malformed");
  url.hash = "";
  if (!allowPrivate && isForbiddenHost(url.hostname))
    throw new ProviderError("unavailable");
  return url;
}

async function loadPublicUrl(
  start: URL,
  signal: AbortSignal,
  maxBytes: number,
  allowPrivate: boolean,
  timeoutMs: number,
  resolveForTests?: BraveWebSourceConfig["resolveForTests"],
  conditionalHeaders?: { etag?: string; lastModified?: string },
  onRequestComplete?: (durationMs: number) => void,
): Promise<{
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  url: URL;
  validatorsSent: boolean;
}> {
  let url = start;
  for (let redirects = 0; redirects <= 3; redirects++) {
    url = canonicalPublicUrl(url.href, allowPrivate);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = resolveForTests
        ? await resolveForTests(host)
        : isIP(host)
          ? [{ address: host, family: isIP(host) }]
          : await resolveAddresses(host, signal);
    } catch (error) {
      if (signal.aborted)
        throw signal.reason instanceof ProviderError
          ? signal.reason
          : new ProviderError("cancel");
      throw error instanceof ProviderError
        ? error
        : new ProviderError("unavailable");
    }
    assertPublicAddresses(host, addresses, allowPrivate);
    const pinned = addresses[0]!;
    const requestStarted = Date.now();
    let response: Awaited<ReturnType<typeof requestPinned>>;
    try {
      response = await requestPinned(
        url,
        pinned,
        signal,
        maxBytes,
        timeoutMs,
        redirects === 0 ? conditionalHeaders : undefined,
      );
    } finally {
      onRequestComplete?.(Date.now() - requestStarted);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = header(response.headers, "location");
      if (!location || redirects === 3)
        throw new ProviderError("unavailable", response.status);
      url = canonicalPublicUrl(new URL(location, url).href, allowPrivate);
      continue;
    }
    return {
      ...response,
      url,
      validatorsSent: redirects === 0 && Boolean(conditionalHeaders && (conditionalHeaders.etag || conditionalHeaders.lastModified)),
    };
  }
  throw new ProviderError("unavailable");
}

export function assertPublicAddresses(
  _host: string,
  addresses: Array<{ address: string; family: number }>,
  allowPrivate = false,
): void {
  if (
    !addresses.length ||
    (!allowPrivate &&
      addresses.some((entry) => forbiddenAddress(entry.address)))
  )
    throw new ProviderError("unavailable");
}

async function resolveAddresses(
  host: string,
  signal: AbortSignal,
): Promise<Array<{ address: string; family: number }>> {
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  if (signal.aborted)
    throw signal.reason instanceof ProviderError
      ? signal.reason
      : new ProviderError("cancel");
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const results = await Promise.allSettled([
      resolver.resolve4(host),
      resolver.resolve6(host),
    ]);
    if (signal.aborted)
      throw signal.reason instanceof ProviderError
        ? signal.reason
        : new ProviderError("cancel");
    const addresses = results.flatMap((result, index) =>
      result.status === "fulfilled"
        ? result.value.map((address) => ({
            address,
            family: index === 0 ? 4 : 6,
          }))
        : [],
    );
    if (!addresses.length) throw new ProviderError("unavailable");
    return addresses;
  } catch (error) {
    if (signal.aborted)
      throw signal.reason instanceof ProviderError
        ? signal.reason
        : new ProviderError("cancel");
    throw error instanceof ProviderError
      ? error
      : new ProviderError("unavailable");
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function requestPinned(
  url: URL,
  pin: { address: string; family: number },
  signal: AbortSignal,
  maxBytes: number,
  timeoutMs: number,
  conditionalHeaders?: { etag?: string; lastModified?: string },
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted)
      return reject(
        signal.reason instanceof ProviderError
          ? signal.reason
          : new ProviderError("cancel"),
      );
    const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const lookupPinned: LookupFunction = (_hostname, options, callback) => {
      if (options.all)
        callback(null, [{ address: pin.address, family: pin.family }]);
      else callback(null, pin.address, pin.family);
    };
    const requestHeaders = {
      accept: [
        "text/html",
        "application/xhtml+xml",
        "text/plain",
        "text/markdown",
        "application/json",
        "application/ld+json",
        "application/activity+json",
        "application/feed+json",
        "application/xml",
        "text/xml",
        "application/rss+xml",
        "application/atom+xml",
        "application/pdf",
        "*/*;q=0.1",
      ].join(", "),
      "accept-encoding": "identity",
      "user-agent": "ZoryaSearch/1.0",
      ...(conditionalHeaders?.etag ? { "if-none-match": conditionalHeaders.etag } : {}),
      ...(conditionalHeaders?.lastModified ? { "if-modified-since": conditionalHeaders.lastModified } : {}),
    };
    const requestOptions = {
      agent: false as const,
      method: "GET",
      headers: requestHeaders,
      lookup: lookupPinned,
      ...(isIP(host) ? {} : { servername: host }),
    };
    let req: ClientRequest;
    let closed = false;
    let socketSeen = false;
    let socketClosed = false;
    let responseEnded = false;
    let result:
      | { status: number; headers: IncomingHttpHeaders; body: Buffer }
      | undefined;
    let failure: ProviderError | undefined;
    const finish = () => {
      if (!closed || (socketSeen && !socketClosed)) return;
      if (failure) reject(failure);
      else if (responseEnded && result) resolve(result);
      else reject(new ProviderError("unavailable"));
    };
    req = requester(url, requestOptions, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          failure = new ProviderError("budget", res.statusCode);
          res.destroy();
          req.destroy(failure);
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        responseEnded = true;
        result = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        };
        finish();
      });
      res.on("aborted", () => {
        failure ??= new ProviderError("unavailable");
        finish();
      });
      res.on("error", (error) => {
        failure ??=
          error instanceof ProviderError
            ? error
            : new ProviderError("unavailable");
        finish();
      });
    });
    const timer = setTimeout(() => {
      failure ??= new ProviderError("timeout");
      req.destroy(failure);
    }, timeoutMs);
    const abort = () => {
      failure ??=
        signal.reason instanceof ProviderError
          ? signal.reason
          : new ProviderError("cancel");
      req.destroy(failure);
    };
    signal.addEventListener("abort", abort, { once: true });
    req.on("socket", (socket) => {
      socketSeen = true;
      if (socket.destroyed) {
        socketClosed = true;
        finish();
      } else
        socket.once("close", () => {
          socketClosed = true;
          finish();
        });
    });
    req.on("error", (error) => {
      failure ??=
        error instanceof ProviderError
          ? error
          : signal.aborted
            ? signal.reason instanceof ProviderError
              ? signal.reason
              : new ProviderError("cancel")
            : new ProviderError("unavailable");
    });
    req.on("close", () => {
      closed = true;
      if (!socketSeen) socketClosed = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      finish();
    });
    req.end();
  });
}

function isForbiddenHost(host: string): boolean {
  const normalized = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  )
    return true;
  return isIP(normalized) !== 0 && forbiddenAddress(normalized);
}

function forbiddenAddress(address: string): boolean {
  if (address.includes(":")) {
    let value: string;
    try {
      value = new URL(`http://[${address}]/`).hostname
        .slice(1, -1)
        .toLowerCase();
    } catch {
      return true;
    }
    if (value.startsWith("::ffff:") && isIP(value.slice(7)) === 4)
      return forbiddenAddress(value.slice(7));
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
    if (mapped)
      return forbiddenAddress(
        `${parseInt(mapped[1]!, 16) >> 8}.${parseInt(mapped[1]!, 16) & 255}.${parseInt(mapped[2]!, 16) >> 8}.${parseInt(mapped[2]!, 16) & 255}`,
      );
    const segments = value.split(":");
    const first = parseInt(segments[0] || "0", 16);
    const second = parseInt(segments[1] || "0", 16);
    const globalUnicast = (first & 0xe000) === 0x2000;
    const reserved =
      (first === 0x2001 && (second <= 0x01ff || second === 0x0db8)) ||
      first === 0x2002 ||
      first === 0x3fff;
    return (
      !globalUnicast ||
      reserved ||
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xffc0) === 0xfe80 ||
      (first & 0xff00) === 0xff00 ||
      (first & 0xffc0) === 0xfec0
    );
  }
  const octets = address.split(".").map(Number);
  const [a, b, c, d] = octets;
  return (
    octets.length !== 4 ||
    octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255) ||
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 &&
      (b === 0 ||
        b === 168 ||
        (b === 88 && c === 99) ||
        (b === 0 && c === 2))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a! >= 224 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 255 && b === 255 && c === 255 && d === 255)
  );
}

function statusError(
  status: number,
  retry: string | null = null,
): ProviderError {
  const retryValue = retry === null ? undefined : Number(retry);
  const retryMs =
    retry === null
      ? undefined
      : Number.isFinite(retryValue)
        ? retryValue! * 1000
        : Date.parse(retry) - Date.now();
  const retryAfterMs =
    retryMs !== undefined && Number.isFinite(retryMs) && retryMs >= 0
      ? Math.min(60_000, retryMs)
      : undefined;
  return new ProviderError(
    status === 401 || status === 403
      ? "auth"
      : status === 402
        ? "quota"
        : status === 429
          ? "rate_limit"
          : status >= 500
            ? "unavailable"
            : "malformed",
    status,
    retryAfterMs,
  );
}
async function waitUntil(
  ms: number,
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted)
    throw signal.reason instanceof ProviderError
      ? signal.reason
      : new ProviderError("cancel");
  if (!Number.isFinite(ms) || Date.now() + ms >= deadline)
    throw new ProviderError("timeout");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(
        signal.reason instanceof ProviderError
          ? signal.reason
          : new ProviderError("cancel"),
      );
    };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  });
}
function header(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function isSupportedWebType(contentType: string): boolean {
  return [
    "text/html",
    "application/xhtml+xml",
    "text/plain",
    "application/json",
    "text/markdown",
    "text/x-markdown",
    "application/xml",
    "text/xml",
    "application/rss+xml",
    "application/atom+xml",
  ].includes(contentType) || contentType.endsWith("+json") || contentType.endsWith("+xml");
}

function lastModifiedDate(headers: IncomingHttpHeaders): string | null {
  const value = header(headers, "last-modified");
  return parseDate(value ?? null);
}

function weaklyMatchesETag(first: string, second: string): boolean {
  const removeWeakPrefix = (value: string) => value.trim().replace(/^W\//u, "");
  return removeWeakPrefix(first) === removeWeakPrefix(second);
}
