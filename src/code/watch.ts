import { watch as fsWatch } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CodeIndexError } from './errors.js'
import type { CodeWatchHandle } from './types.js'

export async function watchCodeRoot(input: {
  root: string
  signal: AbortSignal
  intervalMs: number
  reconcile(): Promise<void>
  onError?(code: string): void
  onClose(): void
}): Promise<CodeWatchHandle> {
  input.signal.throwIfAborted()
  const root = await realpath(resolve(input.root))
  input.signal.throwIfAborted()
  let stopped = false
  let debounceTimer: NodeJS.Timeout | undefined
  let reconcileTimer: NodeJS.Timeout | undefined
  let active: Promise<void> | undefined
  let closePromise: Promise<void> | undefined
  let watcher: ReturnType<typeof fsWatch> | undefined
  let handle: CodeWatchHandle | undefined
  const report = (code: string) => {
    try {
      input.onError?.(code)
    } catch {
      /* Ошибка обработчика не должна ломать наблюдение. */
    }
  }
  const run = async () => {
    if (stopped || active) return
    active = input
      .reconcile()
      .catch(() => {
        if (!input.signal.aborted) report('CODE_INDEX_WATCH_RECONCILE_FAILED')
      })
      .finally(() => {
        active = undefined
      })
    await active
  }
  const onAbort = () => {
    void handle?.close()
  }
  try {
    watcher = fsWatch(root, { persistent: false }, () => {
      if (stopped) return
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        void run()
      }, 200)
    })
    const schedule = () => {
      if (stopped) return
      reconcileTimer = setTimeout(async () => {
        await run()
        schedule()
      }, input.intervalMs)
    }
    handle = {
      close: () => {
        if (closePromise) return closePromise
        closePromise = Promise.resolve().then(async () => {
          if (stopped) return
          stopped = true
          input.onClose()
          if (debounceTimer) clearTimeout(debounceTimer)
          if (reconcileTimer) clearTimeout(reconcileTimer)
          watcher?.close()
          input.signal.removeEventListener('abort', onAbort)
          await active
        })
        return closePromise
      },
    }
    watcher.on('error', () => {
      report('CODE_INDEX_WATCH_FAILED')
      void handle!.close()
    })
    schedule()
    input.signal.throwIfAborted()
    input.signal.addEventListener('abort', onAbort, { once: true })
    input.signal.throwIfAborted()
    return handle
  } catch (error) {
    stopped = true
    if (debounceTimer) clearTimeout(debounceTimer)
    if (reconcileTimer) clearTimeout(reconcileTimer)
    watcher?.close()
    input.onClose()
    if (error instanceof CodeIndexError) throw error
    throw new CodeIndexError('CODE_INDEX_WATCH_FAILED', 'CODE_INDEX_WATCH_FAILED', { cause: error })
  }
}
