import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const childSource = (runtimeModuleUrl: string) => `
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const { openSearchRuntime } = await import(${JSON.stringify(runtimeModuleUrl)})
const rootDir = await mkdtemp(join(tmpdir(), 'zorya-index-deadline-gc-'))
const sourceRoot = join(rootDir, 'source')
const dataDir = join(rootDir, 'state')
await Promise.all([mkdir(sourceRoot), mkdir(dataDir)])
await writeFile(join(sourceRoot, 'target.ts'), 'export const deadlineGcTarget = true\\n')
let blockProvider = false
let providerAborted = false
let providerStartedAt = 0
let providerStartedResolveOnce
const providerStarted = new Promise((resolve) => { providerStartedResolveOnce = resolve })
const keepAlive = setInterval(() => {}, 20)
let runtime
let startTimer
try {
  runtime = await openSearchRuntime({
    config: {
      version: 1,
      dataDir,
      roots: [{ id: 'fixture', path: sourceRoot }],
      limits: { timeoutMs: 10_000 },
      indexing: { maxAttempts: 1, jobTimeoutMs: 25_000 },
      embedding: {
        provider: 'openrouter',
        model: 'fixture-embed',
        dimensions: 3,
        secret: { kind: 'env', name: 'EMBED_KEY' },
      },
    },
    testDependencies: {
      env: { EMBED_KEY: 'fixture-key' },
      fetch: async (_input, init) => {
        const signal = init?.signal
        if (!signal) throw new Error('provider request did not receive an abort signal')
        if (blockProvider) {
          if (signal.aborted) {
            providerAborted = true
            throw signal.reason
          }
          providerStartedAt = Date.now()
          providerStartedResolveOnce()
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              providerAborted = true
              reject(signal.reason)
            }, { once: true })
          })
        }
        const body = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({
          data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0] })),
        }), { status: 200 })
      },
    },
  })

  await runtime.indexRepository({ rootId: 'fixture' })
  await writeFile(join(sourceRoot, 'target.ts'), 'export const deadlineGcTarget = "changed"\\n')
  blockProvider = true
  const admission = runtime.startIndexing({ rootId: 'fixture' })
  await Promise.race([
    providerStarted,
    new Promise((_, reject) => {
      startTimer = setTimeout(() => reject(new Error('controlled provider start exceeded 15 seconds')), 15_000)
    }),
  ])
  clearTimeout(startTimer)

  globalThis.gc()
  await delay(25)
  globalThis.gc()
  const statusDeadline = Date.now() + 22_000
  let job
  while (Date.now() < statusDeadline) {
    job = (await runtime.indexStatus({ rootId: 'fixture', jobId: admission.job.jobId })).indexingJob
    if (job?.state === 'failed' || job?.state === 'cancelled' || job?.state === 'completed') break
    await delay(25)
  }
  const elapsedMs = providerStartedAt ? Date.now() - providerStartedAt : null
  if (!job || job.state !== 'failed' || job.errorCode !== 'TIMEOUT') {
    throw new Error('attempt did not finish as TIMEOUT before the overall deadline: ' + JSON.stringify(job))
  }
  if (!providerAborted) throw new Error('controlled provider did not observe attempt cancellation')
  if (elapsedMs === null || elapsedMs >= 15_000)
    throw new Error('attempt did not honor its own deadline promptly: ' + elapsedMs)
  console.log(JSON.stringify({ node: process.version, providerAborted, state: job.state, errorCode: job.errorCode, elapsedMs }))
} finally {
  clearInterval(keepAlive)
  clearTimeout(startTimer)
  await runtime?.close()
  await rm(rootDir, { recursive: true, force: true })
}
`

test('runtime attempt timeout survives explicit GC during a controlled provider request', (t) => {
  const runtimeModuleUrl = pathToFileURL(join(process.cwd(), 'src/runtime/index.ts')).href
  const child = spawnSync(
    process.execPath,
    ['--expose-gc', '--import', 'tsx', '--input-type=module', '--eval', childSource(runtimeModuleUrl)],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 39_000, maxBuffer: 2_000_000 },
  )
  assert.equal(
    child.status,
    0,
    `runtime deadline child failed on ${process.version}\n${child.stderr}\n${child.stdout}`,
  )
  const result = JSON.parse(child.stdout.trim().split('\n').at(-1)!) as {
    node: string
    providerAborted: boolean
    state: string
    errorCode: string
    elapsedMs: number
  }
  assert.equal(result.providerAborted, true)
  assert.equal(result.state, 'failed')
  assert.equal(result.errorCode, 'TIMEOUT')
  assert.ok(result.elapsedMs < 15_000)
  t.diagnostic(
    `${result.node}: controlled provider observed abort; job=${result.state}/${result.errorCode} after ${result.elapsedMs} ms`,
  )
})
