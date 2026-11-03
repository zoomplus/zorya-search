import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { parseBridgeServerConfig } from '../../src/bridge/config.js'
import { createBridgeManifest, createBridgeScope } from '../../src/bridge/protocol.js'
import { BridgeStore } from '../../src/bridge/store.js'
import { PACKAGE_VERSION } from '../../src/package-version.js'

const entry = resolve('src/bridge/entry.ts')
const tsxLoader = import.meta.resolve('tsx')
const bridgeClientId = '4d1237be-9821-4b95-9079-b77d935bbf01'
const bridgeConversationId = '37cc2038-70ef-41f1-ae10-48cd6d936799'
const bridgeRuntimeFingerprint = createHash('sha256').update('{}').digest('hex')

function run(args: readonly string[]) {
  return spawnSync(process.execPath, ['--import', tsxLoader, entry, ...args], { encoding: 'utf8', timeout: 10_000 })
}

function serveConfig(root: string) {
  const token = 'bridge-serve-entry-test-token'
  return {
    schemaVersion: 1,
    resource: 'https://search.example.test/mcp/search',
    bindHost: '127.0.0.1',
    port: 0,
    dataDir: join(root, 'data'),
    trustedProxyCidrs: [],
    allowedOrigins: ['https://chatgpt.com'],
    clients: [{
      clientId: bridgeClientId,
      tokenSha256: createHash('sha256').update(token).digest('hex'),
      clientCidrs: ['127.0.0.1/32'],
      grants: ['read'],
    }],
  }
}

async function writeServeConfig(root: string): Promise<string> {
  const configPath = join(root, 'server.json')
  await writeFile(configPath, JSON.stringify(serveConfig(root)))
  return configPath
}

async function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<[number | null, NodeJS.Signals | null]> {
  if (child.exitCode !== null || child.signalCode !== null) return [child.exitCode, child.signalCode]
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('CHILD_EXIT_TIMEOUT')), timeoutMs) }),
    ])
  } finally { if (timeout) clearTimeout(timeout) }
}

async function waitForDefinitelyDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  do {
    try { process.kill(pid, 0) }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  } while (Date.now() < deadline)
  return false
}

async function terminateOwnedChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await waitForChildExit(child, 3_000)
  if (child.pid !== undefined) assert.ok(await waitForDefinitelyDead(child.pid, 1_000), 'owned child PID did not become definitely dead')
}

test('bridge entry help and version are stdout-only and require no config', () => {
  const help = run(['--help'])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /zorya-search-bridge/)
  assert.equal(help.stderr, '')
  const version = run(['--version'])
  assert.equal(version.status, 0, version.stderr)
  assert.equal(version.stdout, `${PACKAGE_VERSION}\n`)
  assert.equal(version.stderr, '')
})

test('all bridge commands require an explicit config and reject malformed config without echoing input', () => {
  for (const command of ['mcp', 'client-config', 'serve']) {
    const missing = run([command])
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /CONFIG_INVALID/u)
    assert.equal(missing.stdout, '')
  }
  const bad = run(['serve', '--config', '/path/which/does/not/exist'])
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /CONFIG_INVALID/u)
  assert.equal(bad.stderr.includes('/path/which/does/not/exist'), false)
})

test('client-config emits generic MCP JSON and bounded Codex TOML without credentials or cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-bridge-entry-'))
  try {
    const workspace = join(root, 'workspace')
    const outside = join(root, 'state')
    await mkdir(workspace)
    await mkdir(outside)
    const configPath = join(outside, 'bridge.json')
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      endpoint: 'https://search.example.test/mcp/search',
      clientId: '4d1237be-9821-4b95-9079-b77d935bbf01',
      stateDir: join(outside, 'client-state'),
      credential: { kind: 'env', name: 'ZORYA_BRIDGE_TOKEN' },
      allowedDocumentPaths: ['docs/guide.mdc'],
      excludedPaths: ['generated/**'],
    }))
    const result = spawnSync(process.execPath, ['--import', tsxLoader, entry, 'client-config', '--config', configPath], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    const output = JSON.parse(result.stdout) as {
      generic: { mcpServers: Record<string, { command: string; args: string[]; startup_timeout_sec: number; tool_timeout_sec: number }> }
      installed: { command: string; args: string[]; startup_timeout_sec: number; tool_timeout_sec: number }
      codexToml: string
      codexInstalledToml: string
    }
    const server = output.generic.mcpServers['zorya-search-bridge']!
    assert.equal(server.command, 'npx')
    assert.deepEqual(server.args, [
      '--yes', '--package', `zorya-search@${PACKAGE_VERSION}`,
      'zorya-search-bridge', 'mcp', '--config', configPath,
    ])
    assert.equal(server.startup_timeout_sec, 30)
    assert.equal(server.tool_timeout_sec, 900)
    assert.equal(output.installed.command, process.execPath)
    assert.deepEqual(output.installed.args, [entry, 'mcp', '--config', configPath])
    assert.equal(output.installed.startup_timeout_sec, 30)
    assert.equal(output.installed.tool_timeout_sec, 900)
    assert.match(output.codexToml, /startup_timeout_sec = 30/u)
    assert.match(output.codexToml, /tool_timeout_sec = 900/u)
    assert.match(output.codexToml, /env_vars = \["ZORYA_BRIDGE_TOKEN"\]/u)
    assert.match(output.codexInstalledToml, /env_vars = \["ZORYA_BRIDGE_TOKEN"\]/u)
    assert.doesNotMatch(output.codexToml, /cwd\s*=/u)
    assert.doesNotMatch(result.stdout, /token-value/u)
    assert.doesNotMatch(result.stdout, /workspace/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('serve emits its actual loopback endpoint as a ready event and shuts down on signal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-bridge-serve-entry-'))
  const ownedRoots = new Set([root])
  let child: ReturnType<typeof spawn> | undefined
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const cycleRoot = process.platform === 'win32' && attempt > 0
        ? await mkdtemp(join(tmpdir(), 'zorya-bridge-serve-entry-cycle-'))
        : root
      ownedRoots.add(cycleRoot)
      const configPath = await writeServeConfig(cycleRoot)
      child = spawn(process.execPath, ['--import', tsxLoader, entry, 'serve', '--config', configPath], {
        cwd: cycleRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (value: string) => { stdout += value })
      child.stderr.setEncoding('utf8').on('data', (value: string) => { stderr += value })
      let timeout: NodeJS.Timeout | undefined
      const ready = await Promise.race([
        new Promise<string>((resolveReady) => child!.stdout.once('data', (value: string | Buffer) => resolveReady(String(value)))),
        new Promise<never>((_, rejectReady) => { timeout = setTimeout(() => rejectReady(new Error(`server did not become ready: ${stderr}`)), 10_000) }),
      ]).finally(() => { if (timeout) clearTimeout(timeout) })
      const event = JSON.parse(ready) as { event: string; host: string; port: number; resource: string }
      assert.deepEqual(event, { event: 'ready', host: '127.0.0.1', port: event.port, resource: 'https://search.example.test/mcp/search' })
      assert.ok(Number.isInteger(event.port) && event.port > 0)
      assert.equal(stderr, '')
      const childPid = child.pid
      assert.ok(childPid !== undefined)
      assert.ok(child.kill('SIGTERM'), 'failed to signal owned serve child')
      const [exitCode, exitSignal] = await waitForChildExit(child, 5_000)
      if (process.platform === 'win32') assert.equal(exitSignal, 'SIGTERM', stderr)
      else assert.equal(exitCode, 0, stderr)
      assert.ok(await waitForDefinitelyDead(childPid, 3_000), 'serve child PID was not confirmed dead after shutdown')
      assert.match(stdout, /"event":"ready"/u)
      child = undefined
    }
  } finally {
    if (child) await terminateOwnedChild(child)
    for (const ownedRoot of ownedRoots) await rm(ownedRoot, { recursive: true, force: true })
  }
})

test('a real killed serve owner leaves a recoverable store lock without losing store identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-bridge-killed-owner-'))
  let ownerSetupStore: BridgeStore | undefined
  let child: ReturnType<typeof spawn> | undefined
  let recovered: BridgeStore | undefined
  try {
    const configPath = await writeServeConfig(root)
    const validatedConfig = await parseBridgeServerConfig(serveConfig(root))
    const dataDir = validatedConfig.dataDir
    const lockPath = join(dataDir, '.bridge-server-lock')
    const markerPath = join(dataDir, '.bridge-store.json')
    const projectPath = join(root, 'project')
    await mkdir(projectPath)
    const scope = createBridgeScope({
      clientInstanceId: bridgeClientId,
      conversationId: bridgeConversationId,
      canonicalPath: await realpath(projectPath),
    })
    const sourceText = 'export const persistedAfterOwnerCrash = "snapshot-retained"\n'
    const sourceBytes = Buffer.from(sourceText)
    const sourcePath = 'src/recovery.ts'
    const manifest = createBridgeManifest([{
      path: sourcePath,
      sha256: createHash('sha256').update(sourceBytes).digest('hex'),
      bytes: sourceBytes.byteLength,
    }])
    const operationId = randomUUID()
    ownerSetupStore = await BridgeStore.open(validatedConfig)
    const plan = await ownerSetupStore.plan(scope, operationId, 0, manifest, bridgeRuntimeFingerprint)
    assert.equal(plan.missingFiles.length, 1)
    await ownerSetupStore.put(scope, operationId, 0, manifest.manifestHash, sourcePath, manifest.files[0]!.sha256, sourceBytes.byteLength, 0, sourceBytes)
    const paths = await ownerSetupStore.createSnapshot(scope, operationId, manifest)
    const published = await ownerSetupStore.publishSnapshot(scope, paths, manifest, bridgeRuntimeFingerprint)
    await ownerSetupStore.removeTransfer(scope, operationId)
    await ownerSetupStore.close()
    ownerSetupStore = undefined

    child = spawn(process.execPath, ['--import', tsxLoader, entry, 'serve', '--config', configPath], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (value: string) => { stdout += value })
    child.stderr.setEncoding('utf8').on('data', (value: string) => { stderr += value })
    let timeout: NodeJS.Timeout | undefined
    const ready = await Promise.race([
      new Promise<string>((resolveReady) => child!.stdout.once('data', (value: string | Buffer) => resolveReady(String(value)))),
      new Promise<never>((_, rejectReady) => { timeout = setTimeout(() => rejectReady(new Error('SERVER_READY_TIMEOUT')), 20_000) }),
    ]).finally(() => { if (timeout) clearTimeout(timeout) })
    const event = JSON.parse(ready) as { event: string; host: string; port: number; resource: string }
    assert.equal(event.event, 'ready')
    assert.equal(event.host, '127.0.0.1')
    assert.ok(Number.isInteger(event.port) && event.port > 0)
    assert.equal(event.resource, 'https://search.example.test/mcp/search')
    assert.equal(stderr, '')

    const childPid = child.pid
    assert.ok(childPid !== undefined)
    const previousLock = JSON.parse(await readFile(lockPath, 'utf8')) as { schemaVersion?: unknown; pid?: unknown; nonce?: unknown }
    assert.equal(previousLock.schemaVersion, 1)
    assert.ok(previousLock.pid === childPid)
    assert.ok(typeof previousLock.nonce === 'string' && /^[0-9a-f-]{36}$/u.test(previousLock.nonce))
    const previousNonce = previousLock.nonce as string
    const markerBefore = await readFile(markerPath, 'utf8')
    const marker = JSON.parse(markerBefore) as { schemaVersion?: unknown; storeId?: unknown }
    assert.equal(marker.schemaVersion, 1)
    assert.ok(typeof marker.storeId === 'string' && /^[0-9a-f-]{36}$/u.test(marker.storeId))
    assert.ok((await lstat(join(dataDir, 'clients'))).isDirectory())
    assert.ok(await readFile(join(paths.sourcePath, sourcePath), 'utf8') === sourceText)

    assert.ok(child.kill('SIGKILL'))
    const [exitCode, exitSignal] = await waitForChildExit(child, 5_000)
    assert.equal(exitSignal, 'SIGKILL')
    assert.equal(exitCode, null)
    assert.ok(await waitForDefinitelyDead(childPid, 3_000), 'killed owner PID was not confirmed dead')

    const validatedChildConfig = await parseBridgeServerConfig(JSON.parse(await readFile(configPath, 'utf8')))
    recovered = await BridgeStore.open(validatedChildConfig)
    const recoveredLock = JSON.parse(await readFile(lockPath, 'utf8')) as { schemaVersion?: unknown; pid?: unknown; nonce?: unknown }
    assert.equal(recoveredLock.schemaVersion, 1)
    assert.ok(recoveredLock.pid === process.pid)
    assert.ok(typeof recoveredLock.nonce === 'string' && recoveredLock.nonce !== previousNonce)
    assert.ok((await lstat(join(dataDir, 'clients'))).isDirectory())
    assert.ok(await readFile(markerPath, 'utf8') === markerBefore, 'store marker content changed during dead-owner recovery')
    const recoveredSnapshot = await recovered.current(scope)
    assert.ok(recoveredSnapshot)
    assert.ok(recoveredSnapshot.manifestHash === published.manifestHash)
    assert.equal(recoveredSnapshot.generation, 1)
    const recoveredPaths = await recovered.snapshotPaths(scope, recoveredSnapshot)
    assert.ok(await readFile(join(recoveredPaths.sourcePath, sourcePath), 'utf8') === sourceText, 'published source content changed during dead-owner recovery')
    await recovered.close()
    recovered = undefined
    await assert.rejects(readFile(lockPath, 'utf8'), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT')
    child = undefined
  } finally {
    await ownerSetupStore?.close()
    await recovered?.close()
    if (child) await terminateOwnedChild(child)
    await rm(root, { recursive: true, force: true })
  }
})
