import { z } from 'zod'

export interface MaintenanceHandle { close(): Promise<void>; lastError(): string | undefined }
/** Запускает ограниченное обслуживание только после явного вызова. */
export function startMaintenance(operation: (signal: AbortSignal) => Promise<unknown>, options: { signal?: AbortSignal; intervalMs?: number } = {}): MaintenanceHandle {
  const interval = z.number().int().min(10).max(3600000).parse(options.intervalMs ?? 60000)
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  let pending = Promise.resolve()
  let running = false
  let lastError: string | undefined
  const tick = () => {
    if (signal.aborted || running) return
    running = true
    pending = Promise.resolve().then(() => operation(signal)).then(() => { lastError = undefined }).catch((error: unknown) => {
      if (!signal.aborted) lastError = error instanceof Error ? error.message : 'MAINTENANCE_FAILED'
    }).finally(() => { running = false })
  }
  signal.throwIfAborted()
  const timer = setInterval(tick, interval)
  timer.unref()
  const abort = () => clearInterval(timer)
  signal.addEventListener('abort', abort, { once: true })
  tick()
  return { lastError: () => lastError, async close() { controller.abort(new Error('MAINTENANCE_CLOSED')); clearInterval(timer); signal.removeEventListener('abort', abort); await pending } }
}
