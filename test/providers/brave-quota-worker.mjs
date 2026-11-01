import { parentPort, workerData } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { register } from 'tsx/esm/api'

register()
const { createBraveWebSource } = await import('../../src/providers/brave.js')
const input = workerData
const observations = new BigInt64Array(input.observations)
let calls = 0
const source = createBraveWebSource({
  apiKey: input.apiKey ?? 'fixture-only',
  ...(input.sharedQuota ? { sharedQuota: input.sharedQuota } : {}),
  limits: { maxRequestsPerSecond: 1, attempts: 2, timeoutMs: 5000 },
  fetch: async () => {
    const call = calls++
    const index = Atomics.add(observations, 0, 1n) + 1n
    Atomics.store(observations, Number(index), BigInt(Math.round(performance.now() * 1000)))
    if (input.mode === '429-once' && call === 0) {
      parentPort?.postMessage({ phase: '429' })
      return new Response('', { status: 429, headers: { 'retry-after': '1.5' } })
    }
    return new Response(JSON.stringify({ web: { results: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  },
})

try {
  if (input.gate) {
    parentPort?.postMessage({ phase: 'ready' })
    Atomics.wait(new Int32Array(input.gate), 0, 0)
  }
  await source.discover('quota fixture', 1, new AbortController().signal)
  parentPort?.postMessage({ ok: true })
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
}
