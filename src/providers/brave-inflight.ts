import type { SourceDocument } from '../core/contracts.js'
import { ProviderError } from './contracts.js'

type EntryState = 'running' | 'aborting' | 'settled'

interface WaiterSlot {
  readonly retained: boolean
  retainUntil(settled: Promise<void>): void
  release(): void
}

interface InFlightEntry<T> {
  readonly controller: AbortController
  readonly settled: Promise<void>
  readonly operation: Promise<T>
  state: EntryState
  waiters: number
}

/** Coalesces overlapping provider-local fetches while keeping callers independent. */
export class BraveInFlightDocuments {
  readonly #entries = new Map<string, InFlightEntry<SourceDocument>>()
  #retainedSlotCount = 0

  constructor(
    private readonly maxEntries: number,
    private readonly maxWaiters: number,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
      throw new RangeError('In-flight entry bound must be a positive integer')
    if (!Number.isSafeInteger(maxWaiters) || maxWaiters < 1)
      throw new RangeError('In-flight waiter bound must be a positive integer')
  }

  async fetch(
    key: string,
    signal: AbortSignal,
    load: (signal: AbortSignal) => Promise<SourceDocument>,
  ): Promise<SourceDocument> {
    if (signal.aborted) throw cancellationError(signal)
    let slot: WaiterSlot | undefined

    try {
      while (true) {
        if (signal.aborted) throw cancellationError(signal)
        const existing = this.#entries.get(key)
        if (existing?.state === 'aborting') {
          slot ??= this.#reserveWaiterSlot()
          try {
            await waitForSettlement(existing.settled, signal)
          } catch (error) {
            slot.retainUntil(existing.settled)
            throw error
          }
          continue
        }
        if (existing) {
          slot ??= this.#reserveWaiterSlot()
          slot.retainUntil(existing.settled)
          return await this.#waitForResult(existing, signal)
        }
        if (this.#entries.size >= this.maxEntries) throw new ProviderError('budget')

        slot ??= this.#reserveWaiterSlot()
        const entry = this.#start(key, load)
        slot.retainUntil(entry.settled)
        return await this.#waitForResult(entry, signal)
      }
    } finally {
      if (slot && !slot.retained) slot.release()
    }
  }

  #reserveWaiterSlot(): WaiterSlot {
    if (this.#retainedSlotCount >= this.maxWaiters) throw new ProviderError('budget')
    this.#retainedSlotCount++
    let retained = false
    let released = false
    const release = () => {
      if (released) return
      released = true
      this.#retainedSlotCount--
    }

    return {
      get retained() {
        return retained
      },
      retainUntil(settled) {
        if (retained) return
        retained = true
        void settled.then(() => queueMicrotask(release))
      },
      release,
    }
  }

  #start(
    key: string,
    load: (signal: AbortSignal) => Promise<SourceDocument>,
  ): InFlightEntry<SourceDocument> {
    const controller = new AbortController()
    const settled = deferred<void>()
    let entry!: InFlightEntry<SourceDocument>
    const operation = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) throw cancellationError(controller.signal)
        return load(controller.signal)
      })
      .then((document) => {
        if (controller.signal.aborted) throw cancellationError(controller.signal)
        return document
      })
      .finally(() => {
        entry.state = 'settled'
        if (this.#entries.get(key) === entry) this.#entries.delete(key)
        settled.resolve()
      })

    entry = {
      controller,
      settled: settled.promise,
      operation,
      state: 'running',
      waiters: 0,
    }
    this.#entries.set(key, entry)
    // Every returned waiter observes this promise; this handler also covers a
    // cancellation race in which the last waiter leaves before load begins.
    void operation.catch(() => undefined)
    return entry
  }

  #waitForResult(
    entry: InFlightEntry<SourceDocument>,
    signal: AbortSignal,
  ): Promise<SourceDocument> {
    if (signal.aborted) return Promise.reject(cancellationError(signal))
    entry.waiters++

    return new Promise<SourceDocument>((resolve, reject) => {
      let complete = false
      let drainError: ProviderError | undefined
      const detachAbortListener = () => {
        signal.removeEventListener('abort', abortWaiter)
      }
      const finish = (completeWaiter: () => void) => {
        if (complete) return false
        complete = true
        detachAbortListener()
        entry.waiters--
        completeWaiter()
        return true
      }
      const abortWaiter = () => {
        if (complete || drainError) return
        detachAbortListener()
        entry.waiters--
        const error = cancellationError(signal)
        if (entry.waiters === 0 && entry.state === 'running') {
          entry.state = 'aborting'
          entry.controller.abort(error)
          drainError = error
          return
        }
        complete = true
        reject(error)
      }

      signal.addEventListener('abort', abortWaiter, { once: true })
      entry.operation.then(
        (document) => {
          if (complete) return
          if (drainError) {
            complete = true
            reject(drainError)
            return
          }
          if (signal.aborted) {
            abortWaiter()
            if (drainError) {
              complete = true
              reject(drainError)
            }
            return
          }
          finish(() => resolve({ ...document }))
        },
        (error: unknown) => {
          if (complete) return
          if (drainError) {
            complete = true
            reject(drainError)
            return
          }
          if (signal.aborted) {
            abortWaiter()
            if (drainError) {
              complete = true
              reject(drainError)
            }
            return
          }
          finish(() => reject(error))
        },
      )
    })
  }
}

function waitForSettlement(settled: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(cancellationError(signal))

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => {
      cleanup()
      reject(cancellationError(signal))
    }
    signal.addEventListener('abort', abort, { once: true })
    void settled.then(() => {
      cleanup()
      if (signal.aborted) reject(cancellationError(signal))
      else resolve()
    })
  })
}

function cancellationError(signal: AbortSignal): ProviderError {
  return signal.reason instanceof ProviderError
    ? signal.reason
    : new ProviderError('cancel')
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
