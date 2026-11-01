/**
 * Run a bounded set of operations concurrently while yielding their results in
 * input order. If iteration stops early, cancel and drain every started task.
 */
export async function* mapConcurrentOrdered<T, R>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  operation: (item: T, signal: AbortSignal) => Promise<R>,
): AsyncGenerator<R> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new RangeError('Concurrency must be a positive integer')

  const controller = new AbortController()
  const operationSignal = AbortSignal.any([signal, controller.signal])
  type SettledResult = { ok: true; value: R } | { ok: false; error: unknown }
  const pending = new Map<number, Promise<SettledResult>>()
  let nextIndex = 0

  try {
    for (let index = 0; index < items.length; index++) {
      operationSignal.throwIfAborted()
      while (nextIndex < items.length && pending.size < concurrency) {
        const scheduledIndex = nextIndex++
        pending.set(
          scheduledIndex,
          Promise.resolve()
            .then(() => {
              operationSignal.throwIfAborted()
              return operation(items[scheduledIndex]!, operationSignal)
            })
            .then<SettledResult, SettledResult>(
              (value) => ({ ok: true, value }),
              (error: unknown) => ({ ok: false, error }),
            ),
        )
      }

      const result = await pending.get(index)!
      pending.delete(index)
      operationSignal.throwIfAborted()
      if (!result.ok) throw result.error
      yield result.value
    }
  } finally {
    controller.abort()
    await Promise.allSettled(pending.values())
  }
}
