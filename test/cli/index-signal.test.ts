import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const node = process.execPath
const entry = resolve('dist/cli/entry.js')

test('CLI OS signals cancel only a newly created job and leave a reused peer job running', {
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
  await writeFile(dir+'/started-'+n,'yes');
  if(n===1) return new Promise((resolve,reject)=>init.signal.addEventListener('abort',async()=>{await writeFile(dir+'/aborted-1','yes');reject(new DOMException('cancelled','AbortError'))},{once:true}));
  await new Promise((resolve,reject)=>{
    const interval=setInterval(async()=>{try{await access(dir+'/release-2');clearInterval(interval);resolve()}catch{}},20);
    init.signal.addEventListener('abort',async()=>{clearInterval(interval);await writeFile(dir+'/aborted-2','yes');reject(new DOMException('cancelled','AbortError'))},{once:true});
  });
  const body=JSON.parse(String(init.body));
  return new Response(JSON.stringify({data:body.input.map((_,index)=>({index,embedding:[1,0,0]}))}),{status:200,headers:{'content-type':'application/json'}});
};
`)
  const childEnv = { ...process.env, NODE_OPTIONS: `--import=${mockModule}`, CLI_MOCK_KEY: 'fixture-only' }
  const children: ChildProcess[] = []
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
    return { child, closed, getErr: () => err }
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
  const statusFor = async (rootId: string, jobId: string) =>
    await monitor.callTool({ name: 'index_status', arguments: { rootId, jobId } })
  const waitForJobState = async (rootId: string, jobId: string, state: string) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const status = await statusFor(rootId, jobId)
      if ((status.structuredContent as { indexingJob?: { state?: string } }).indexingJob?.state === state) return status
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    }
    throw new Error(`JOB_STATE_TIMEOUT:${state}`)
  }
  try {
    transport = new StdioClientTransport({ command: node, args: [entry, 'mcp', '--config', config], cwd: dir, env: childEnv, stderr: 'pipe' })
    await monitor.connect(transport)

    const ownedCli = spawnCli(['index', '--config', config, '--root-id', 'a'])
    await waitForFile(started1)
    await waitForCliText(ownedCli, 'Индексация a — running')
    ownedCli.child.kill('SIGINT')
    const ownedResult = await ownedCli.closed
    assert.equal(ownedResult.code, 130, ownedResult.err)
    const ownedPayload = JSON.parse(ownedResult.out) as { jobId: string; cancelledByThisInvocation: boolean }
    assert.equal(ownedPayload.cancelledByThisInvocation, true)
    await waitForFile(aborted1)
    assert.equal((await waitForJobState('a', ownedPayload.jobId, 'cancelled')).isError, undefined)

    const peerAdmission = await monitor.callTool({ name: 'start_indexing', arguments: { rootId: 'b' } })
    const peerJobId = (peerAdmission.structuredContent as { job: { jobId: string } }).job.jobId
    await waitForFile(started2)
    const peerCli = spawnCli(['index', '--config', config, '--root-id', 'b'])
    await waitForCliText(peerCli, 'Индексация b — running')
    peerCli.child.kill('SIGINT')
    const peerResult = await peerCli.closed
    assert.equal(peerResult.code, 130, peerResult.err)
    const peerPayload = JSON.parse(peerResult.out) as { jobId: string; cancelledByThisInvocation: boolean }
    assert.equal(peerPayload.jobId, peerJobId)
    assert.equal(peerPayload.cancelledByThisInvocation, false)
    assert.equal(await readFile(aborted2, 'utf8').then(() => true, () => false), false)
    assert.equal((await statusFor('b', peerJobId)).structuredContent && ((await statusFor('b', peerJobId)).structuredContent as { indexingJob?: { state?: string } }).indexingJob?.state, 'running')
    await writeFile(release2, 'release')
    await waitForJobState('b', peerJobId, 'completed')
  } finally {
    await writeFile(release2, 'release').catch(() => undefined)
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
    await monitor.close().catch(() => undefined)
    await transport?.close().catch(() => undefined)
    const stop = spawn(node, [entry, 'service', '--stop', '--config', config], { cwd: dir, env: childEnv, stdio: 'ignore' })
    await new Promise<void>((resolvePromise) => { stop.once('close', () => resolvePromise()); stop.once('error', () => resolvePromise()) })
    await rm(dir, { recursive: true, force: true })
  }
})
