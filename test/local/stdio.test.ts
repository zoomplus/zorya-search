import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { workspaceIdForCanonicalPath } from '../../src/bridge/protocol.js'
import { openSearchRuntime } from '../../src/runtime/index.js'
import { node24DaemonExecArgv } from '../../src/cli/node24.js'
import { inspectLocalOwner, openLocalWorkspace, processIsAlive } from '../../src/local/owner.js'
import { runLocalMcpStdio, stopLocalOwner } from '../../src/local/stdio.js'

const entry = fileURLToPath(new URL('../../src/local/entry.ts', import.meta.url))
const conversationOne = 'c19b5bf1-7dde-477c-a41e-048d829cdf04'
const conversationTwo = 'd19b5bf1-7dde-477c-a41e-048d829cdf04'

type TrackedStdioClient = {
  client: Client
  transport: StdioClientTransport
  frontendPid?: number
  stderr: () => string
}

function captureFrontendPid(transport: StdioClientTransport): number {
  const pid = transport.pid
  assert.ok(Number.isSafeInteger(pid) && pid! > 0, 'stdio frontend PID was unavailable before close')
  return pid!
}

async function waitForDefinitelyDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  do {
    try {
      process.kill(pid, 0)
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  } while (Date.now() < deadline)
  return false
}

async function closeTrackedClient(record: TrackedStdioClient): Promise<void> {
  const transportPid = record.transport.pid
  const pid = record.frontendPid ?? (Number.isSafeInteger(transportPid) && transportPid! > 0 ? transportPid : undefined)
  if (pid !== undefined) record.frontendPid = pid
  let closeFailed = false
  try { await record.client.close() } catch { closeFailed = true }
  const frontendDead = pid !== undefined && await waitForDefinitelyDead(pid, 5_000)
  if (closeFailed || pid === undefined || !frontendDead) {
    throw new Error(`LOCAL_STDIO_FRONTEND_CLEANUP_UNCONFIRMED:${JSON.stringify({ closeFailed, pidObserved: pid !== undefined, frontendDead })}`)
  }
}

function callMeta(threadId: string) {
  return { 'x-codex-turn-metadata': { thread_id: threadId }, threadId }
}

test('stdio facade reports a pre-call cwd change as LOCAL_WORKSPACE_CHANGED', async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'zorya-local-cwd-')))
  const originalCwd = process.cwd()
  const project = join(parent, 'project')
  const other = join(parent, 'other')
  const configPath = join(parent, 'client.json')
  await Promise.all([mkdir(project), mkdir(other)])
  process.chdir(project)
  const config = { schemaVersion: 1, clientId: 'a96c7ca2-e43b-4be1-a584-fd7533a3a574', stateDir: join(parent, 'state'), runtime: {} }
  await writeFile(configPath, JSON.stringify(config))
  await chmod(configPath, 0o600)
  const client = new Client({ name: 'local-cwd-classification', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  let handle: Awaited<ReturnType<typeof runLocalMcpStdio>> | undefined
  let ownerMayBeRunning = false
  try {
    ownerMayBeRunning = true
    handle = await runLocalMcpStdio(configPath, { transport: serverTransport })
    await client.connect(clientTransport)
    process.chdir(other)
    const result = await client.callTool({ name: 'capabilities', arguments: {}, _meta: callMeta(conversationOne) })
    assert.equal(result.isError, true)
    assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /LOCAL_WORKSPACE_CHANGED/u)
    const provenance = (result._meta as Record<string, unknown> | undefined)?.['zorya-search/local'] as Record<string, unknown> | undefined
    assert.equal(provenance?.localVerification, 'failed_currentness')
  } finally {
    process.chdir(project)
    await client.close().catch(() => undefined)
    await handle?.close().catch(() => undefined)
    if (ownerMayBeRunning) await stopLocalOwner(configPath, { timeoutMs: 5_000 })
    process.chdir(originalCwd)
    await rm(parent, { recursive: true, force: true })
  }
})

test('spawned owner exits boundedly after unconfirmed startup cleanup and preserves lock files', async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'zorya-local-owner-failure-')))
  const project = join(parent, 'project')
  const stateDir = join(parent, 'state')
  const configPath = join(parent, 'client.json')
  const childScript = join(parent, 'owner-failure-child.mjs')
  await mkdir(project)
  const config = { schemaVersion: 1, clientId: 'fd829e65-a20c-4c67-86ce-e3019c6b37d7', stateDir, runtime: {} }
  await writeFile(configPath, JSON.stringify(config))
  await chmod(configPath, 0o600)
  const ownerModule = pathToFileURL(fileURLToPath(new URL('../../src/local/owner-entry.ts', import.meta.url))).href
  const workspaceModule = pathToFileURL(fileURLToPath(new URL('../../src/local/owner.ts', import.meta.url))).href
  await writeFile(childScript, `
    import { mkdir, writeFile } from 'node:fs/promises';
    import { randomUUID } from 'node:crypto';
    import { runLocalOwnerProcess } from ${JSON.stringify(ownerModule)};
    import { openLocalWorkspace } from ${JSON.stringify(workspaceModule)};
    const configPath = ${JSON.stringify(configPath)};
    const openWorkspace = async (options) => openLocalWorkspace({ ...options, testRuntimeFactory: async (runtimeOptions) => {
      const dataDir = runtimeOptions.config.dataDir;
      await mkdir(dataDir, { recursive: true });
      await writeFile(dataDir + '/.zorya-search-owner', JSON.stringify({ pid: process.pid + 10, nonce: randomUUID() }), { mode: 0o600 });
      setInterval(() => {}, 1000);
      return { close: async () => { throw new Error('INJECTED_CLOSE_FAILURE'); } };
    } });
    try { await runLocalOwnerProcess(['--config', configPath], { openWorkspace, startupCleanupExitMs: 250 }); }
    catch (error) { process.stderr.write(String(error?.code ?? 'UNKNOWN')); process.exitCode = 1; }
  `)
  const child = spawn(process.execPath, [...node24DaemonExecArgv(process.versions.node), '--import', import.meta.resolve('tsx'), childScript], {
    cwd: project,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('LOCAL_OWNER_FAILURE_EXIT_TIMEOUT')), 5_000)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
  try {
    const result = await exited
    assert.equal(result.code, 1)
    assert.equal(result.signal, null)
    assert.match(stderr, /LOCAL_RUNTIME_CLOSE_FAILED/u)
    const workspace = await realpath(project)
    const statePath = join(stateDir, workspaceIdForCanonicalPath(config.clientId, workspace))
    const owner = JSON.parse(await readFile(join(statePath, 'owner.json'), 'utf8')) as { pid: number; databaseLock?: unknown }
    assert.equal(owner.pid, child.pid)
    assert.equal(owner.databaseLock, undefined)
    assert.equal(JSON.parse(await readFile(join(statePath, 'data', '.zorya-search-owner'), 'utf8')).pid, child.pid! + 10)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
    await rm(parent, { recursive: true, force: true })
  }
})

test('spawned owner exits boundedly after runtime close failure during normal stop', async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'zorya-local-close-failure-')))
  const previousCwd = process.cwd()
  const project = join(parent, 'project')
  const stateDir = join(parent, 'state')
  const configPath = join(parent, 'client.json')
  const childScript = join(parent, 'owner-close-failure-child.mjs')
  await mkdir(project)
  const config = { schemaVersion: 1, clientId: '77c653cf-9a63-498b-9f35-234d613825dc', stateDir, runtime: {} }
  await writeFile(configPath, JSON.stringify(config))
  await chmod(configPath, 0o600)
  const ownerModule = pathToFileURL(fileURLToPath(new URL('../../src/local/owner-entry.ts', import.meta.url))).href
  const workspaceModule = pathToFileURL(fileURLToPath(new URL('../../src/local/owner.ts', import.meta.url))).href
  const runtimeModule = pathToFileURL(fileURLToPath(new URL('../../src/runtime/index.ts', import.meta.url))).href
  await writeFile(childScript, `
    import { runLocalOwnerProcess } from ${JSON.stringify(ownerModule)};
    import { openLocalWorkspace } from ${JSON.stringify(workspaceModule)};
    import { openSearchRuntime } from ${JSON.stringify(runtimeModule)};
    const configPath = ${JSON.stringify(configPath)};
    const openWorkspace = async (options) => openLocalWorkspace({ ...options, testRuntimeFactory: async (runtimeOptions) => {
      const runtime = await openSearchRuntime(runtimeOptions);
      return new Proxy(runtime, { get(target, property) {
        if (property === 'close') return async () => { await target.close(); throw new Error('INJECTED_CLOSE_FAILURE'); };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    } });
    try { await runLocalOwnerProcess(['--config', configPath], { openWorkspace, startupCleanupExitMs: 250 }); }
    catch (error) { process.stderr.write(String(error?.code ?? 'UNKNOWN')); process.exitCode = 1; }
  `)
  const child = spawn(process.execPath, [...node24DaemonExecArgv(process.versions.node), '--import', import.meta.resolve('tsx'), childScript], {
    cwd: project,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  let cleanupConfirmed = false
  let primaryFailure: unknown
  try {
    process.chdir(project)
    const readinessStartedAt = Date.now()
    const deadline = readinessStartedAt + 20_000
    let ready = false
    let lastOwnerState = 'not_checked'
    while (Date.now() < deadline) {
      const owner = await inspectLocalOwner(config, parent)
      lastOwnerState = owner.state
      if (owner.state === 'ready') { ready = true; break }
      if (child.exitCode !== null || child.signalCode !== null) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(ready, true, JSON.stringify({
      elapsedMs: Date.now() - readinessStartedAt,
      childExitCode: child.exitCode,
      childSignal: child.signalCode,
      lastOwnerState,
    }))
    await stopLocalOwner(configPath, { timeoutMs: 5_000 })
    const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('LOCAL_OWNER_CLOSE_EXIT_TIMEOUT')), 5_000)
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      if (child.exitCode !== null || child.signalCode !== null)
        resolve({ code: child.exitCode, signal: child.signalCode })
    })
    assert.equal(exited.code, 1)
    assert.equal(exited.signal, null)
    assert.match(stderr, /LOCAL_RUNTIME_CLOSE_FAILED/u)
    const statePath = join(stateDir, workspaceIdForCanonicalPath(config.clientId, await realpath(project)))
    const ownerRecord = JSON.parse(await readFile(join(statePath, 'owner.json'), 'utf8')) as { pid: number; databaseLock?: unknown }
    assert.equal(ownerRecord.pid, child.pid)
    assert.ok(ownerRecord.databaseLock)
    await assert.rejects(() => readFile(join(statePath, 'data', '.zorya-search-owner')), { code: 'ENOENT' })
    const recovered = await openLocalWorkspace({ config })
    await recovered.close()
    cleanupConfirmed = true
  } catch (error) {
    primaryFailure = error
  } finally {
    process.chdir(project)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
    process.chdir(previousCwd)
    if (cleanupConfirmed) await rm(parent, { recursive: true, force: true })
  }
  if (primaryFailure) throw primaryFailure
  if (!cleanupConfirmed) throw new Error(`LOCAL_OWNER_CLOSE_FAILURE_CLEANUP_UNCONFIRMED:${parent}`)
})

test('two stdio clients share one detached workspace owner and retain separate native conversations', async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'zorya-local-stdio-')))
  const originalCwd = process.cwd()
  const project = join(parent, 'project')
  const stateDir = join(parent, 'state')
  const configPath = join(parent, 'client.json')
  await mkdir(project)
  process.chdir(project)
  const config = { schemaVersion: 1, clientId: '741c63e3-edec-4868-b9ab-4ca4de737eba', stateDir, runtime: {} }
  await writeFile(configPath, JSON.stringify(config))
  await chmod(configPath, 0o600)
  const makeClient = (): TrackedStdioClient => {
    const client = new Client({ name: 'local-two-process-test', version: '1.0.0' })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', import.meta.resolve('tsx'), entry, 'mcp', '--config', configPath],
      cwd: project,
      env: { ...process.env, PWD: join(parent, 'decoy'), CODEX_THREAD_ID: 'e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1' },
      stderr: 'pipe',
    })
    let stderr = ''
    transport.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    return { client, transport, stderr: () => stderr }
  }
  const clients: TrackedStdioClient[] = []
  let ownerPid: number | undefined
  let cleanupSafe = true
  try {
    const first = makeClient()
    clients.push(first)
    const second = makeClient()
    clients.push(second)
    const connectResults = await Promise.allSettled(clients.map(({ client, transport }) => client.connect(transport)))
    const failedConnect = connectResults.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failedConnect) throw new Error(`LOCAL_STDIO_CONNECT_FAILED:${clients.find((record, index) => connectResults[index]?.status === 'rejected')?.stderr?.() ?? ''}`, { cause: failedConnect.reason })
    for (const record of clients) record.frontendPid = captureFrontendPid(record.transport)
    const [one, two] = await Promise.all([
      first.client.callTool({ name: 'capabilities', arguments: {}, _meta: callMeta(conversationOne) }),
      second.client.callTool({ name: 'capabilities', arguments: {}, _meta: callMeta(conversationTwo) }),
    ])
    assert.equal(one.isError, undefined, first.stderr())
    assert.equal(two.isError, undefined, second.stderr())
    const owner = await inspectLocalOwner(config, parent)
    assert.equal(owner.state, 'ready')
    if (owner.state !== 'ready') throw new Error('LOCAL_OWNER_NOT_READY')
    ownerPid = owner.pid
    const firstMeta = (one._meta as Record<string, unknown> | undefined)?.['zorya-search/local'] as Record<string, unknown> | undefined
    const secondMeta = (two._meta as Record<string, unknown> | undefined)?.['zorya-search/local'] as Record<string, unknown> | undefined
    assert.equal(firstMeta?.clientInstanceId, config.clientId)
    assert.equal(firstMeta?.workspaceId, owner.workspaceId)
    assert.equal(firstMeta?.conversationId, conversationOne)
    assert.equal(firstMeta?.origin, 'current_local_workspace')
    assert.equal(firstMeta?.localVerification, 'workspace_unchanged_during_call')
    assert.equal(secondMeta?.workspaceId, owner.workspaceId)
    assert.equal(secondMeta?.conversationId, conversationTwo)
    assert.notEqual(firstMeta?.conversationId, secondMeta?.conversationId)
    const startedJob = await first.client.callTool({ name: 'start_indexing', arguments: { rootId: 'workspace' }, _meta: callMeta(conversationOne) })
    assert.equal(startedJob.isError, undefined)
    const jobId = (startedJob.structuredContent as { job?: { jobId?: string } }).job?.jobId
    assert.ok(jobId)
    const foreignStatus = await second.client.callTool({ name: 'index_status', arguments: { rootId: 'workspace', jobId }, _meta: callMeta(conversationTwo) })
    assert.equal(foreignStatus.isError, true)
    const foreignCancel = await second.client.callTool({ name: 'cancel_indexing', arguments: { rootId: 'workspace', jobId }, _meta: callMeta(conversationTwo) })
    assert.equal(foreignCancel.isError, true)
    const ownedStatus = await first.client.callTool({ name: 'index_status', arguments: { rootId: 'workspace', jobId }, _meta: callMeta(conversationOne) })
    assert.equal(ownedStatus.isError, undefined)
    const ownedCancel = await first.client.callTool({ name: 'cancel_indexing', arguments: { rootId: 'workspace', jobId }, _meta: callMeta(conversationOne) })
    assert.equal(ownedCancel.isError, undefined)
    assert.equal(first.transport.pid === second.transport.pid, false)
    assert.equal(first.transport.pid === ownerPid, false)
    assert.equal(second.transport.pid === ownerPid, false)
    const closeResults = await Promise.allSettled(clients.map(closeTrackedClient))
    assert.ok(closeResults.every((result) => result.status === 'fulfilled'), 'stdio frontend processes did not all exit after client close')
    clients.length = 0
    const stillReady = await inspectLocalOwner(config, parent)
    assert.equal(stillReady.state, 'ready')
    if (stillReady.state === 'ready') assert.equal(stillReady.pid, ownerPid)
    const updatedConfig = { ...config, runtime: { limits: { timeoutMs: 5_000 } } }
    await writeFile(configPath, JSON.stringify(updatedConfig))
    await chmod(configPath, 0o600)
    await assert.rejects(
      () => runLocalMcpStdio(configPath),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'LOCAL_PROFILE_MISMATCH',
    )
    const stoppingPid = ownerPid
    assert.ok(stoppingPid)
    await stopLocalOwner(configPath)
    assert.equal(processIsAlive(stoppingPid), false)
    ownerPid = undefined
    assert.equal((await inspectLocalOwner(updatedConfig, parent)).state, 'missing')
    const updatedClient = makeClient()
    clients.push(updatedClient)
    await updatedClient.client.connect(updatedClient.transport)
    updatedClient.frontendPid = captureFrontendPid(updatedClient.transport)
    const restarted = await updatedClient.client.callTool({ name: 'capabilities', arguments: {}, _meta: callMeta(conversationOne) })
    assert.equal(restarted.isError, undefined, updatedClient.stderr())
    const updatedOwner = await inspectLocalOwner(updatedConfig, parent)
    assert.equal(updatedOwner.state, 'ready')
    if (updatedOwner.state === 'ready') ownerPid = updatedOwner.pid
    await closeTrackedClient(updatedClient)
    clients.length = 0
    await stopLocalOwner(configPath)
    assert.ok(ownerPid !== undefined && await waitForDefinitelyDead(ownerPid, 5_000), 'detached owner PID was not confirmed dead after stop')
    ownerPid = undefined
  } finally {
    let frontendCleanupConfirmed = true
    for (const record of clients) {
      try { await closeTrackedClient(record) }
      catch { frontendCleanupConfirmed = false }
    }
    try {
      process.chdir(project)
      await stopLocalOwner(configPath, { timeoutMs: 5_000 })
      if (ownerPid !== undefined && !await waitForDefinitelyDead(ownerPid, 5_000)) cleanupSafe = false
    } catch { cleanupSafe = false }
    process.chdir(originalCwd)
    if (!frontendCleanupConfirmed) cleanupSafe = false
    if (cleanupSafe) await rm(parent, { recursive: true, force: true })
    else throw new Error(`LOCAL_STDIO_CLEANUP_UNCONFIRMED:${JSON.stringify({ frontendCleanupConfirmed, ownerPidObserved: ownerPid !== undefined, ownerDead: ownerPid !== undefined && !processIsAlive(ownerPid) })}`)
  }
})

test('same machine identity keeps separate Git workspaces and indexes tracked edits, untracked files, and deletions', async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'zorya-local-git-isolation-')))
  const originalCwd = process.cwd()
  const clientId = 'b31c7c8e-4c53-4c90-9ed1-183fd14910b0'
  const stateDir = join(parent, 'state')
  const configPath = join(parent, 'client.json')
  const fixtures = [
    { dir: join(parent, 'workspace-a'), current: 'export const marker = "A_TRACKED_CURRENT"\n', untracked: 'export const only = "A_UNTRACKED_CURRENT"\n', deleted: 'A_DELETED_OLD' },
    { dir: join(parent, 'workspace-b'), current: 'export const marker = "B_TRACKED_CURRENT"\n', untracked: 'export const only = "B_UNTRACKED_CURRENT"\n', deleted: 'B_DELETED_OLD' },
  ]
  const config = { schemaVersion: 1, clientId, stateDir, runtime: {} }
  const clients: TrackedStdioClient[] = []
  const owners = new Map<string, number>()
  const workspaceIds: string[] = []
  let cleanupSafe = true
  try {
    await writeFile(configPath, JSON.stringify(config))
    await chmod(configPath, 0o600)
    for (const fixture of fixtures) {
      await mkdir(join(fixture.dir, 'src'), { recursive: true })
      await writeFile(join(fixture.dir, 'src', 'same.ts'), 'export const marker = "INITIAL_COMMITTED"\n')
      await writeFile(join(fixture.dir, 'src', 'deleted.ts'), `export const marker = "${fixture.deleted}"\n`)
      execFileSync('git', ['init', '-q'], { cwd: fixture.dir, stdio: 'ignore' })
      execFileSync('git', ['-c', 'user.name=Local Test', '-c', 'user.email=local-test@example.invalid', 'add', '.'], { cwd: fixture.dir, stdio: 'ignore' })
      execFileSync('git', ['-c', 'user.name=Local Test', '-c', 'user.email=local-test@example.invalid', 'commit', '-qm', 'initial snapshot'], { cwd: fixture.dir, stdio: 'ignore' })
      await writeFile(join(fixture.dir, 'src', 'same.ts'), fixture.current)
      await writeFile(join(fixture.dir, 'src', 'untracked.ts'), fixture.untracked)
      await rm(join(fixture.dir, 'src', 'deleted.ts'))
    }
    for (let i = 0; i < fixtures.length; i++) {
      const fixture = fixtures[i]!
      process.chdir(fixture.dir)
      const client = new Client({ name: `local-git-workspace-${i}`, version: '1.0.0' })
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', import.meta.resolve('tsx'), entry, 'mcp', '--config', configPath],
        cwd: fixture.dir,
        env: { ...process.env, PWD: join(parent, 'decoy'), CODEX_THREAD_ID: 'f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1' },
        stderr: 'pipe',
      })
      let stderr = ''
      transport.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
      const clientRecord: TrackedStdioClient = { client, transport, stderr: () => stderr }
      clients.push(clientRecord)
      await client.connect(transport).catch((error: unknown) => { throw new Error(`LOCAL_GIT_CONNECT_FAILED:${stderr}`, { cause: error }) })
      clientRecord.frontendPid = captureFrontendPid(transport)
      const threadId = i === 0 ? conversationOne : conversationTwo
      const searched = await client.callTool({
        name: 'search_code',
        arguments: { rootId: 'workspace', query: `TRACKED_CURRENT`, mode: 'lexical' },
        _meta: callMeta(threadId),
      })
      assert.equal(searched.isError, undefined, stderr)
      const searchData = searched.structuredContent as { identity?: { snapshotId?: string }; hits?: Array<{ path: string }> }
      assert.ok(searchData.identity?.snapshotId)
      assert.ok(searchData.hits?.some((hit) => hit.path === 'src/same.ts'))
      const read = await client.callTool({
        name: 'read_source',
        arguments: { rootId: 'workspace', path: 'src/same.ts', snapshotId: searchData.identity.snapshotId },
        _meta: callMeta(threadId),
      })
      assert.equal(read.isError, undefined, stderr)
      const readData = read.structuredContent as { text: string; contentHash: string; snapshotId: string }
      assert.equal(readData.text, fixture.current)
      assert.equal(readData.contentHash, createHash('sha256').update(Buffer.from(fixture.current, 'utf8')).digest('hex'))
      assert.equal(readData.snapshotId, searchData.identity.snapshotId)
      const untracked = await client.callTool({
        name: 'read_source', arguments: { rootId: 'workspace', path: 'src/untracked.ts' }, _meta: callMeta(threadId),
      })
      assert.equal(untracked.isError, undefined, stderr)
      assert.equal((untracked.structuredContent as { text: string }).text, fixture.untracked)
      const deleted = await client.callTool({
        name: 'read_source', arguments: { rootId: 'workspace', path: 'src/deleted.ts' }, _meta: callMeta(threadId),
      })
      assert.equal(deleted.isError, true)
      const localMeta = (read._meta as Record<string, unknown> | undefined)?.['zorya-search/local'] as Record<string, unknown> | undefined
      assert.equal(localMeta?.clientInstanceId, clientId)
      assert.equal(localMeta?.conversationId, threadId)
      assert.ok(typeof localMeta?.workspaceId === 'string')
      workspaceIds.push(localMeta!.workspaceId as string)
      const owner = await inspectLocalOwner(config, parent)
      assert.equal(owner.state, 'ready')
      if (owner.state === 'ready') owners.set(fixture.dir, owner.pid)
    }
    assert.notEqual(workspaceIds[0], workspaceIds[1])
    assert.equal(owners.size, 2)
    assert.notEqual(owners.get(fixtures[0]!.dir), owners.get(fixtures[1]!.dir))
  } finally {
    let frontendCleanupConfirmed = true
    for (const record of clients) {
      try { await closeTrackedClient(record) }
      catch { frontendCleanupConfirmed = false }
    }
    for (const fixture of fixtures) {
      process.chdir(fixture.dir)
      try {
        await stopLocalOwner(configPath, { timeoutMs: 5_000 })
        const ownerPid = owners.get(fixture.dir)
        if (ownerPid !== undefined && !await waitForDefinitelyDead(ownerPid, 5_000)) cleanupSafe = false
      } catch { cleanupSafe = false }
    }
    process.chdir(originalCwd)
    if (!frontendCleanupConfirmed) cleanupSafe = false
    if (cleanupSafe) await rm(parent, { recursive: true, force: true })
    else throw new Error(`LOCAL_GIT_CLEANUP_UNCONFIRMED:${JSON.stringify({ frontendCleanupConfirmed, ownersObserved: owners.size === fixtures.length, ownersDead: owners.size === fixtures.length && [...owners.values()].every((pid) => !processIsAlive(pid)) })}`)
  }
})
