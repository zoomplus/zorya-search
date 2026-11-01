import { ProviderError } from './contracts.js'
import { performance } from 'node:perf_hooks'

const SHARED_QUOTA_VERSION = 1
const SHARED_QUOTA_BYTES = Int32Array.BYTES_PER_ELEMENT * 4 + BigInt64Array.BYTES_PER_ELEMENT * 3
const SHARED_QUOTA_MAGIC = 0x42525131
const META_MAGIC = 0
const META_VERSION = 1
const META_BYTES = 2
const STATE_LAST_START = 0
const STATE_COOLDOWN_UNTIL = 1
const STATE_INTERVAL = 2
const MAX_SHARED_MICROS = 0x7fff_ffff_ffff_ffffn

/** Create an explicitly owned quota state to share between Brave source instances in Node worker threads. */
export function createBraveQuotaState(): SharedArrayBuffer {
  const buffer = new SharedArrayBuffer(SHARED_QUOTA_BYTES)
  const metadata = new Int32Array(buffer, 0, 4)
  Atomics.store(metadata, META_MAGIC, SHARED_QUOTA_MAGIC)
  Atomics.store(metadata, META_VERSION, SHARED_QUOTA_VERSION)
  Atomics.store(metadata, META_BYTES, SHARED_QUOTA_BYTES)
  Atomics.store(sharedState(buffer), STATE_LAST_START, -1n)
  return buffer
}

function validateSharedQuotaState(buffer: unknown): asserts buffer is SharedArrayBuffer {
  if (typeof SharedArrayBuffer === 'undefined' || !(buffer instanceof SharedArrayBuffer))
    throw new TypeError('Общее состояние квоты Brave должно быть SharedArrayBuffer')
  if (buffer.byteLength !== SHARED_QUOTA_BYTES)
    throw new TypeError('Неверный размер общего состояния квоты Brave')
  const metadata = new Int32Array(buffer, 0, 4)
  if (
    Atomics.load(metadata, META_MAGIC) !== SHARED_QUOTA_MAGIC ||
    Atomics.load(metadata, META_VERSION) !== SHARED_QUOTA_VERSION ||
    Atomics.load(metadata, META_BYTES) !== SHARED_QUOTA_BYTES
  )
    throw new TypeError('Неверная версия общего состояния квоты Brave')
}

function sharedState(buffer: SharedArrayBuffer): BigInt64Array {
  return new BigInt64Array(buffer, Int32Array.BYTES_PER_ELEMENT * 4)
}

function monotonicMicros(): bigint {
  return BigInt(Math.round(performance.now() * 1000))
}

function atomicMax(state: BigInt64Array, index: number, value: bigint): void {
  let current = Atomics.load(state, index)
  while (current < value) {
    const previous = Atomics.compareExchange(state, index, current, value)
    if (previous === current) return
    current = previous
  }
}

function sharedDeadlineAfter(delayMs: number): bigint {
  const now = monotonicMicros()
  if (!Number.isFinite(delayMs)) return MAX_SHARED_MICROS
  const delayMicros = Math.ceil(Math.max(0, delayMs) * 1000)
  if (!Number.isFinite(delayMicros) || BigInt(delayMicros) >= MAX_SHARED_MICROS - now)
    return MAX_SHARED_MICROS
  return now + BigInt(delayMicros)
}

interface HeaderReader {
  get(name: string): string | null
}

export class BraveQuota {
  private readonly starts: number[] = []
  private cooldownUntil = 0
  private requestLimit: number

  private readonly shared?: BigInt64Array

  constructor(private readonly configuredLimit: number, sharedBuffer?: SharedArrayBuffer) {
    this.requestLimit = configuredLimit
    if (sharedBuffer !== undefined) {
      validateSharedQuotaState(sharedBuffer)
      this.shared = sharedState(sharedBuffer)
      atomicMax(this.shared, STATE_INTERVAL, BigInt(Math.ceil(1000 / configuredLimit)) * 1000n)
    }
  }

  async acquire(deadline: number, signal: AbortSignal): Promise<void> {
    while (true) {
      if (signal.aborted) throw cancellation(signal)
      const now = Date.now()
      if (this.shared) {
        await this.acquireShared(deadline, signal)
        return
      }
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
    const partialExhaustedResets = remaining.flatMap((remainingValue, index) => {
      if (parseFiniteNumber(remainingValue) !== 0) return []
      if (parseFiniteNumber(limits[index] ?? null) === 0) return []
      const delay = resetDelay(resets[index] ?? null, now)
      return delay === null ? [] : [delay]
    })
    const requestWindow = finiteWindows
      .filter((window) => window.windowSeconds === null || window.windowSeconds <= 86_400)
      .sort((left, right) => (left.windowSeconds ?? 1) - (right.windowSeconds ?? 1))[0]
    if (requestWindow?.limit !== null && requestWindow?.limit !== undefined) {
      this.requestLimit = Math.min(this.configuredLimit, Math.max(1, Math.floor(requestWindow.limit)))
      if (this.shared) atomicMax(this.shared, STATE_INTERVAL, BigInt(Math.ceil(1000 / this.requestLimit)) * 1000n)
    }
    if (status === 429) {
      const exhaustedResets = finiteWindows
        .filter((window) => window.remaining === 0)
        .map((window) => window.resetMs ?? 0)
      const partialResets = exhaustedResets.length > 0
        ? exhaustedResets
        : partialExhaustedResets.length > 0
          ? partialExhaustedResets
          : resets.flatMap((value, index) => {
              if (parseFiniteNumber(limits[index] ?? null) === 0) return []
              return [resetDelay(value, now) ?? 0]
            })
      const delay = Math.max(retryAfter ?? 0, ...partialResets, 1000)
      this.cooldownUntil = Math.max(this.cooldownUntil, now + delay)
      if (this.shared) atomicMax(this.shared, STATE_COOLDOWN_UNTIL, sharedDeadlineAfter(delay))
      return
    }
    for (const reset of partialExhaustedResets)
      this.cooldownUntil = Math.max(this.cooldownUntil, now + reset)
    for (const window of finiteWindows) {
      if (window.remaining === 0 && window.resetMs !== null)
        this.cooldownUntil = Math.max(this.cooldownUntil, now + window.resetMs)
    }
    if (this.shared && this.cooldownUntil > now)
      atomicMax(this.shared, STATE_COOLDOWN_UNTIL, sharedDeadlineAfter(this.cooldownUntil - now))
  }

  private async acquireShared(deadline: number, signal: AbortSignal): Promise<void> {
    const state = this.shared!
    for (;;) {
      if (signal.aborted) throw cancellation(signal)
      const monoNow = monotonicMicros()
      atomicMax(state, STATE_INTERVAL, BigInt(Math.ceil(1000 / this.requestLimit)) * 1000n)
      const lastStart = Atomics.load(state, STATE_LAST_START)
      const cooldownUntil = Atomics.load(state, STATE_COOLDOWN_UNTIL)
      const nextStart = lastStart < 0n
        ? monoNow
        : lastStart + Atomics.load(state, STATE_INTERVAL)
      const earliest = nextStart > cooldownUntil ? nextStart : cooldownUntil
      if (monoNow >= earliest) {
        if (Atomics.compareExchange(state, STATE_LAST_START, lastStart, monoNow) !== lastStart) continue
        if (signal.aborted) throw cancellation(signal)
        return
      }
      const waitMs = Math.max(1, Math.ceil(Number(earliest - monoNow) / 1000))
      if (Date.now() + waitMs >= deadline)
        throw new ProviderError('rate_limit', undefined, waitMs)
      await wait(waitMs, signal)
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
