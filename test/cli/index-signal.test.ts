import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { ownerDir } from '../../src/cli/files.js'

const node = process.execPath
const entry = resolve('dist/cli/entry.js')

test('CLI cancellation joins its own job and leaves a reused peer job running', {
  timeout: 90_000,
  skip: !existsSync(entry) ? 'Run pnpm build before installed CLI signal verification.' : false,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-cli-job-signal-'))
  const rootA = join(dir, 'root-a')
  const rootB = join(dir, 'root-b')
  const data = join(dir, 'state')
  const config = join(dir, 'config.json')
  const started1 = join(dir, 'started-1')
  const aborted1 = join(dir, 'aborted-1')
  const started2 = join(dir, 'started-2')
  const aborted2 = join(dir, 'aborted-2')
  const release2 = join(dir, 'release-2')
  const mockModule = join(dir, 'mock-fetch.mjs')
  await Promise.all([mkdir(rootA), mkdir(rootB), mkdir(data)])
  await writeFile(join(rootA, 'source.ts'), 'export const ownedSignalSource = true\n')
  await writeFile(join(rootB, 'source.ts'), 'export const peerOwnedSignalSource = true\n')
  await writeFile(config, JSON.stringify({
    version: 1,
    dataDir: data,
    roots: [{ id: 'a', path: rootA }, { id: 'b', path: rootB }],
    embedding: { provider: 'openrouter', model: 'fixture-embed', dimensions: 3, secret: { kind: 'env', name: 'CLI_MOCK_KEY' } },
    indexing: { jobTimeoutMs: 30_000 },
  }))
  await writeFile(mockModule, `import { writeFile, access } from 'node:fs/promises';
const dir=${JSON.stringify(dir)};
const original=globalThis.fetch.bind(globalThis);
let calls=0;
globalThis.fetch=async (input,init)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input:input.url);
  if(url.hostname==='127.0.0.1'||url.hostname==='localhost') return original(input,init);
  calls++;
  const n=calls;
  let interval;
  const abortWait=new Promise((resolve,reject)=>{
    const onAbort=async()=>{
      if(interval) clearInterval(interval);
      try { await writeFile(dir+'/aborted-'+n,'yes'); }
      finally { reject(new DOMException('cancelled','AbortError')); }
    };
    if(init.signal.aborted) void onAbort();
    else init.signal.addEventListener('abort',onAbort,{once:true});
  });
  await writeFile(dir+'/started-'+n,'yes');
  if(n===1) await abortWait;
  else await Promise.race([abortWait,new Promise((resolve)=>{
    interval=setInterval(async()=>{try{await access(dir+'/release-2');clearInterval(interval);resolve()}catch{}},20);
  })]);
  const body=JSON.parse(String(init.body));
  return new Response(JSON.stringify({data:body.input.map((_,index)=>({index,embedding:[1,0,0]}))}),{status:200,headers:{'content-type':'application/json'}});
};
`)
  const childEnv = { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(mockModule).href}`, CLI_MOCK_KEY: 'fixture-only' }
  const children: ChildProcess[] = []
  const childClosed = new Map<ChildProcess, Promise<void>>()
  const monitor = new Client({ name: 'job-signal-monitor', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
  let transport: StdioClientTransport | undefined
  const spawnCli = (args: string[]) => {
    const child = spawn(node, [entry, ...args], { cwd: dir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8').on('data', (value) => { out += value })
    child.stderr.setEncoding('utf8').on('data', (value) => { err += value })
    const closed = new Promise<{ code: number | null; out: string; err: string }>((resolvePromise, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolvePromise({ code, out, err }))
    })
    const physicalClose = new Promise<void>((resolvePromise) => {
      child.once('close', () => resolvePromise())
    })
    childClosed.set(child, physicalClose)
    void closed.catch(() => undefined)
    return { child, closed, getErr: () => err }
  }
  async function awaitBounded<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  const waitForProcessExit = async (pid: number, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
        throw error
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
    }
    throw new Error(`VERIFIED_OWNER_PROCESS_STILL_RUNNING:${pid}`)
  }
  const joinOwnedChild = async (child: ChildProcess) => {
    const closed = childClosed.get(child)
    if (!closed) return
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    try {
      await awaitBounded(closed, 'CHILD_PROCESS_CLOSE', 2_000)
      return
    } catch (firstError) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      try {
        await awaitBounded(closed, 'CHILD_PROCESS_CLOSE_AFTER_KILL', 3_000)
      } catch (secondError) {
        ownedProcessesSettled = false
        throw new AggregateError([firstError, secondError], `OWNED_CHILD_DID_NOT_CLOSE:${child.pid ?? 'unknown'}`)
      }
    }
  }
  const waitForFile = async (path: string) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      try { await readFile(path); return } catch { await new Promise((resolvePromise) => setTimeout(resolvePromise, 20)) }
    }
    throw new Error(`WAIT_FILE_TIMEOUT:${path.split('/').at(-1)}`)
  }
  const waitForCliText = async (child: ReturnType<typeof spawnCli>, expected: string) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && child.child.exitCode === null) {
      if (child.getErr().includes(expected)) return
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    }
    throw new Error('CLI_PROGRESS_NOT_OBSERVED')
  }
  const statusFor = async (rootId: string, jobId?: string) =>
    await monitor.callTool({ name: 'index_status', arguments: { rootId, ...(jobId ? { jobId } : {}) } })
  const waitForJobState = async (rootId: string, jobId: string, state: string) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const status = await statusFor(rootId, jobId)
      if ((status.structuredContent as { indexingJob?: { state?: string } }).indexingJob?.state === state) return status
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    }
    throw new Error(`JOB_STATE_TIMEOUT:${state}`)
  }
  let verifiedOwner: { pid: number; tokenFile: string; controlFile: string } | undefined
  let proxyClosedResolve: (() => void) | undefined
  let proxyClosed: Promise<void> | undefined
  let proxyPid: number | null = null
  let canonicalConfig: string | undefined
  let ownedProcessesSettled = true
  let ownerMayBeActive = false
  let primaryError: unknown
  let hasPrimaryError = false
  const readVerifiedOwner = async () => {
    canonicalConfig ??= await realpath(config)
    const owner = JSON.parse(await readFile(join(ownerDir(canonicalConfig), 'owner.json'), 'utf8')) as {
      pid?: number
      tokenFile?: string
      controlFile?: string
    }
    assert.ok(Number.isSafeInteger(owner.pid) && (owner.pid ?? 0) > 0)
    assert.match(owner.tokenFile ?? '', /^owner-[A-Za-z0-9]+\.token$/u)
    assert.match(owner.controlFile ?? '', /^control-[A-Za-z0-9]+\.token$/u)
    return { pid: owner.pid!, tokenFile: owner.tokenFile!, controlFile: owner.controlFile! }
  }
  const trackProxyClose = () => {
    if (!transport || transport.pid === null) {
      proxyClosed = Promise.resolve()
      return
    }
    proxyPid = transport.pid
    const previousOnClose = transport.onclose
    proxyClosed = new Promise<void>((resolvePromise) => { proxyClosedResolve = resolvePromise })
    transport.onclose = () => {
      try {
        previousOnClose?.()
      } finally {
        proxyClosedResolve?.()
      }
    }
  }
  try {
    transport = new StdioClientTransport({ command: node, args: [entry, 'mcp', '--config', config], cwd: dir, env: childEnv, stderr: 'pipe' })
    let proxyStderr = ''
    transport.stderr?.setEncoding('utf8').on('data', (value) => { proxyStderr += value })
    ownerMayBeActive = true
    await monitor.connect(transport).catch((error: unknown) => {
      trackProxyClose()
      throw new Error(`MCP_PROXY_CONNECT_FAILED:${proxyStderr}`, { cause: error })
    })
    trackProxyClose()
    verifiedOwner = await readVerifiedOwner()

    const ownedCli = spawnCli(['index', '--config', config, '--root-id', 'a'])
    await waitForFile(started1)
    await waitForCliText(ownedCli, 'Индексация a — running')
    const runningOwnedJob = (await statusFor('a')).structuredContent
    const ownerJobId = (runningOwnedJob as { indexingJob?: { jobId?: string } } | undefined)?.indexingJob?.jobId
    assert.ok(ownerJobId)
    if (process.platform === 'win32') {
      const cancelled = await monitor.callTool({ name: 'cancel_indexing', arguments: { rootId: 'a', jobId: ownerJobId } })
      assert.equal((cancelled.structuredContent as { state?: string }).state, 'cancelled')
      const ownedResult = await ownedCli.closed
      assert.equal(ownedResult.code, 1, ownedResult.err)
      const ownedEnvelope = JSON.parse(ownedResult.out) as { structuredContent?: { indexingJob?: { jobId?: string; state?: string } } }
      assert.ok(ownedEnvelope.structuredContent?.indexingJob)
      assert.equal(ownedEnvelope.structuredContent.indexingJob.jobId, ownerJobId)
      assert.equal(ownedEnvelope.structuredContent.indexingJob.state, 'cancelled')
    } else {
      ownedCli.child.kill('SIGINT')
      const ownedResult = await ownedCli.closed
      assert.equal(ownedResult.code, 130, ownedResult.err)
      const ownedPayload = JSON.parse(ownedResult.out) as { jobId: string; cancelledByThisInvocation: boolean }
      assert.equal(ownedPayload.jobId, ownerJobId)
      assert.equal(ownedPayload.cancelledByThisInvocation, true)
    }
    await waitForFile(aborted1)
    assert.equal((await waitForJobState('a', ownerJobId, 'cancelled')).isError, undefined)

    const peerAdmission = await monitor.callTool({ name: 'start_indexing', arguments: { rootId: 'b' } })
    const peerJobId = (peerAdmission.structuredContent as { job: { jobId: string } }).job.jobId
    await waitForFile(started2)
    const peerCli = spawnCli(['index', '--config', config, '--root-id', 'b'])
    await waitForCliText(peerCli, 'Индексация b — running')
    if (process.platform === 'win32') {
      const peerStatusWhileRunning = await statusFor('b', peerJobId)
      assert.equal((peerStatusWhileRunning.structuredContent as { indexingJob?: { state?: string } }).indexingJob?.state, 'running')
      await writeFile(release2, 'release')
      const peerResult = await peerCli.closed
      assert.equal(peerResult.code, 0, peerResult.err)
      const peerEnvelope = JSON.parse(peerResult.out) as { structuredContent?: { indexingJob?: { jobId?: string; state?: string } } }
      assert.ok(peerEnvelope.structuredContent?.indexingJob)
      assert.equal(peerEnvelope.structuredContent.indexingJob.jobId, peerJobId)
      assert.equal(peerEnvelope.structuredContent.indexingJob.state, 'completed')
    } else {
      peerCli.child.kill('SIGINT')
      const peerResult = await peerCli.closed
      assert.equal(peerResult.code, 130, peerResult.err)
      const peerPayload = JSON.parse(peerResult.out) as { jobId: string; cancelledByThisInvocation: boolean }
      assert.equal(peerPayload.jobId, peerJobId)
      assert.equal(peerPayload.cancelledByThisInvocation, false)
      assert.equal(await readFile(aborted2, 'utf8').then(() => true, () => false), false)
      const peerStatusWhileRunning = await statusFor('b', peerJobId)
      assert.equal((peerStatusWhileRunning.structuredContent as { indexingJob?: { state?: string } }).indexingJob?.state, 'running')
      await writeFile(release2, 'release')
      await waitForJobState('b', peerJobId, 'completed')
    }
  } catch (error) {
    primaryError = error
    hasPrimaryError = true
  }

  const teardownErrors: Error[] = []
  const teardown = async (label: string, action: () => Promise<unknown>) => {
    try {
      await action()
    } catch (error) {
      teardownErrors.push(new Error(`CLI_TEST_TEARDOWN:${label}`, { cause: error }))
    }
  }
  await teardown('release-provider-barrier', async () => {
    await writeFile(release2, 'release')
  })

  if (ownerMayBeActive && !verifiedOwner) {
    await teardown('capture-owner-for-safe-stop', async () => {
      verifiedOwner = await readVerifiedOwner()
    })
  }

  if (verifiedOwner) {
    await teardown('stop-owned-service', async () => {
      assert.ok(canonicalConfig)
      const ownerPath = join(ownerDir(canonicalConfig), 'owner.json')
      const currentOwner = JSON.parse(await readFile(ownerPath, 'utf8')) as {
        pid?: number
        tokenFile?: string
        controlFile?: string
      }
      assert.equal(currentOwner.pid, verifiedOwner!.pid)
      assert.equal(currentOwner.tokenFile, verifiedOwner!.tokenFile)
      assert.equal(currentOwner.controlFile, verifiedOwner!.controlFile)
      const stop = spawn(node, [entry, 'service', '--stop', '--config', config], { cwd: dir, env: childEnv, stdio: 'ignore' })
      const closed = new Promise<number>((resolvePromise, reject) => {
        stop.once('error', reject)
        stop.once('close', (code) => resolvePromise(code ?? -1))
      })
      const physicalClose = new Promise<void>((resolvePromise) => {
        stop.once('close', () => resolvePromise())
      })
      childClosed.set(stop, physicalClose)
      children.push(stop)
      void closed.catch(() => undefined)
      let stopCode: number | undefined
      let stopError: unknown
      try {
        stopCode = await awaitBounded(closed, 'SERVICE_STOP_PROCESS_CLOSE')
      } catch (error) {
        stopError = error
      }
      try {
        await waitForProcessExit(verifiedOwner!.pid)
        ownerMayBeActive = false
      } catch (error) {
        ownedProcessesSettled = false
        throw error
      }
      if (stopError !== undefined) throw stopError
      assert.equal(stopCode, 0)
    })
  }

  await teardown('monitor-close', async () => awaitBounded(monitor.close(), 'MCP_MONITOR_CLOSE'))
  if (transport) {
    await teardown('proxy-transport-close', async () => awaitBounded(transport!.close(), 'MCP_PROXY_TRANSPORT_CLOSE'))
  }
  if (proxyClosed) {
    await teardown(`proxy-process-close-${proxyPid ?? 'unstarted'}`, async () => {
      try {
        await awaitBounded(proxyClosed!, 'MCP_PROXY_PROCESS_CLOSE')
      } catch (error) {
        if (proxyPid !== null) ownedProcessesSettled = false
        throw error
      }
    })
  }

  await Promise.all(children.map(async (child) => {
    await teardown(`child-${child.pid ?? 'unknown'}-close`, async () => joinOwnedChild(child))
  }))
  if (ownedProcessesSettled && !ownerMayBeActive) {
    await teardown('remove-test-directory', async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
    })
  } else {
    teardownErrors.push(new Error('CLI_TEST_DIRECTORY_RETAINED_FOR_LIVE_OWNED_PROCESS_OR_UNVERIFIED_OWNER'))
  }

  if (hasPrimaryError && teardownErrors.length > 0) {
    throw new AggregateError([primaryError, ...teardownErrors], 'CLI_JOB_TEST_AND_TEARDOWN_FAILED', { cause: primaryError })
  }
  if (hasPrimaryError) throw primaryError
  if (teardownErrors.length > 0) {
    throw new AggregateError(teardownErrors, 'CLI_JOB_TEST_TEARDOWN_FAILED')
  }
})
