import { ProviderError } from './contracts.js'

interface HeaderReader {
  get(name: string): string | null
}

export class BraveQuota {
  private readonly starts: number[] = []
  private cooldownUntil = 0
  private requestLimit: number

  constructor(private readonly configuredLimit: number) {
    this.requestLimit = configuredLimit
  }

  async acquire(deadline: number, signal: AbortSignal): Promise<void> {
    while (true) {
      if (signal.aborted) throw cancellation(signal)
      const now = Date.now()
      while (this.starts.length && this.starts[0]! <= now - 1000) this.starts.shift()
      const cooldownDelay = Math.max(0, this.cooldownUntil - now)
      const windowDelay = this.starts.length >= this.requestLimit
        ? Math.max(0, this.starts[0]! + 1000 - now)
        : 0
      const delay = Math.max(cooldownDelay, windowDelay)
      if (delay === 0) {
        this.starts.push(now)
        return
      }
      if (now + delay >= deadline) throw new ProviderError('rate_limit', undefined, delay)
      await wait(delay, signal)
    }
  }

  observe(headers: HeaderReader, status: number): void {
    const now = Date.now()
    const retryAfter = retryAfterMs(headers.get('retry-after'), now)
    const limits = splitValues(headers.get('x-ratelimit-limit'))
    const remaining = splitValues(headers.get('x-ratelimit-remaining'))
    const resets = splitValues(headers.get('x-ratelimit-reset'))
    const policies = splitValues(headers.get('x-ratelimit-policy'))
    const windows = limits.map((limitText, index) => ({
      limit: parseFiniteNumber(limitText),
      remaining: parseFiniteNumber(remaining[index] ?? null),
      resetMs: resetDelay(resets[index] ?? null, now),
      windowSeconds: parseWindowSeconds(policies[index] ?? ''),
    }))
    const finiteWindows = windows.filter((window) => window.limit !== null && window.limit > 0)
    const requestWindow = finiteWindows
      .filter((window) => window.windowSeconds === null || window.windowSeconds <= 86_400)
      .sort((left, right) => (left.windowSeconds ?? 1) - (right.windowSeconds ?? 1))[0]
    if (requestWindow?.limit !== null && requestWindow?.limit !== undefined)
      this.requestLimit = Math.min(this.configuredLimit, Math.max(1, Math.floor(requestWindow.limit)))
    if (status === 429) {
      const exhaustedResets = finiteWindows
        .filter((window) => window.remaining === 0)
        .map((window) => window.resetMs ?? 0)
      const delay = Math.max(retryAfter ?? 0, ...exhaustedResets, 1000)
      this.cooldownUntil = Math.max(this.cooldownUntil, now + delay)
      return
    }
    for (const window of finiteWindows) {
      if (window.remaining === 0 && window.resetMs !== null)
        this.cooldownUntil = Math.max(this.cooldownUntil, now + window.resetMs)
    }
  }
}

function splitValues(value: string | null): string[] {
  return value === null ? [] : value.split(',').map((part) => part.trim())
}

function parseWindowSeconds(value: string): number | null {
  const match = /(?:^|;)\s*w\s*=\s*(\d+(?:\.\d+)?)/iu.exec(value)
  if (!match) return null
  const seconds = Number(match[1])
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

function parseFiniteNumber(value: string | null): number | null {
  if (value === null || !/^\d+(?:\.\d+)?$/u.test(value.trim())) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function resetDelay(value: string | null, now: number): number | null {
  if (value === null) return null
  const seconds = parseFiniteNumber(value)
  if (seconds !== null) return seconds * 1000
  if (/^[+-]?\d+(?:\.\d+)?$/u.test(value.trim())) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null
}

function retryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null
  const seconds = parseFiniteNumber(value)
  if (seconds !== null) return seconds * 1000
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null
}

function cancellation(signal: AbortSignal): ProviderError {
  return signal.reason instanceof ProviderError ? signal.reason : new ProviderError('cancel')
}

function wait(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancellation(signal))
      return
    }
    const timer = setTimeout(done, delay)
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(cancellation(signal))
    }
    function done() {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}
