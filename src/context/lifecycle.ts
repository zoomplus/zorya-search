export class OperationLimitError extends Error {
  constructor() {
    super('Concurrent operation limit reached')
    this.name = 'OperationLimitError'
  }
}

export class OperationClosedError extends Error {
  constructor() {
    super('Operation owner is closed')
    this.name = 'OperationClosedError'
  }
}

export class OperationTimeoutError extends Error {
  constructor() {
    super('Operation deadline exceeded')
    this.name = 'OperationTimeoutError'
  }
}

export function createLifecycle(maxConcurrency: number) {
  const operations = new Map<AbortController, Promise<unknown>>()
  let closed = false
  let closing: Promise<void> | undefined

  return {
    run<T>(
      callerSignal: AbortSignal | undefined,
      timeoutMs: number,
      work: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
      if (closed) return Promise.reject(new OperationClosedError())
      if (callerSignal?.aborted) return Promise.reject(callerSignal.reason)
      if (operations.size >= maxConcurrency) return Promise.reject(new OperationLimitError())
      const controller = new AbortController()
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, controller.signal])
        : controller.signal
      const timer = setTimeout(() => controller.abort(new OperationTimeoutError()), timeoutMs)
      const operation = Promise.resolve().then(() => {
        signal.throwIfAborted()
        return work(signal)
      })
      operations.set(controller, operation)
      operation
        .finally(() => {
          clearTimeout(timer)
          operations.delete(controller)
        })
        .catch(() => {})
      return operation
    },
    async close(): Promise<void> {
      if (closing) return closing
      closed = true
      for (const controller of operations.keys()) controller.abort(new OperationClosedError())
      closing = Promise.allSettled(operations.values()).then(() => undefined)
      return closing
    },
  }
}
