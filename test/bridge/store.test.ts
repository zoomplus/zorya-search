import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import { parseBridgeServerConfig } from '../../src/bridge/config.js'
import { BridgeContractError, createBridgeManifest, createBridgeScope } from '../../src/bridge/protocol.js'
import { BridgeStore } from '../../src/bridge/store.js'

const clientId = '4d1237be-9821-4b95-9079-b77d935bbf01'
const conversationId = '37cc2038-70ef-41f1-ae10-48cd6d936799'
const fingerprint = createHash('sha256').update('{}').digest('hex')

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'zorya-bridge-store-'))
  const dataDir = join(root, 'data')
  const workspacePath = join(root, 'project')
  await mkdir(workspacePath)
  const config = await parseBridgeServerConfig({
    schemaVersion: 1,
    resource: 'http://127.0.0.1:8787/mcp/search',
    bindHost: '127.0.0.1',
    port: 0,
    dataDir,
    trustedProxyCidrs: [],
    allowedOrigins: ['https://chatgpt.com'],
    clients: [{ clientId, tokenSha256: 'a'.repeat(64), clientCidrs: ['127.0.0.1/32'], grants: ['read', 'index'] }],
  }, { allowInsecureLoopbackForTests: true })
  const scope = createBridgeScope({ clientInstanceId: clientId, conversationId, canonicalPath: resolve(workspacePath) })
  const store = await BridgeStore.open(config)
  return { root, dataDir, workspacePath, config, scope, store }
}

function manifest(entries: Record<string, string>) {
  return createBridgeManifest(Object.entries(entries).map(([path, text]) => {
    const bytes = Buffer.from(text)
    return { path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength }
  }))
}

async function transfer(store: BridgeStore, scope: ReturnType<typeof createBridgeScope>, generation: number, files: Record<string, string>, operationId = randomUUID()) {
  const next = manifest(files)
  const plan = await store.plan(scope, operationId, generation, next, fingerprint)
  for (const file of plan.missingFiles) {
    const content = Buffer.from(files[file.path]!)
    await store.put(scope, operationId, generation, next.manifestHash, file.path, file.sha256, file.bytes, 0, content)
  }
  return { operationId, next }
}

test('workspace source and persistent data directory keep stable inode across transfer commits and restart', async () => {
  const state = await setup()
  try {
    const first = await transfer(state.store, state.scope, 0, { 'src/a.ts': 'export const needle = 1', 'src/remove.ts': 'old' })
    const firstPaths = await state.store.createSnapshot(state.scope, first.operationId, first.next)
    const sourceIdentity = await stat(firstPaths.sourcePath)
    const dataIdentity = await stat(firstPaths.dataPath)
    const firstSnapshot = await state.store.publishSnapshot(state.scope, firstPaths, first.next, fingerprint)
    await state.store.removeTransfer(state.scope, first.operationId)
    await writeFile(join(firstPaths.dataPath, 'sentinel.db'), 'persistent')

    const second = await transfer(state.store, state.scope, 1, { 'src/a.ts': 'export const needle = 2', 'src/new.ts': '' })
    const secondPaths = await state.store.createSnapshot(state.scope, second.operationId, second.next)
    const secondSnapshot = await state.store.publishSnapshot(state.scope, secondPaths, second.next, fingerprint)
    await state.store.removeTransfer(state.scope, second.operationId)

    assert.equal(secondSnapshot.generation, firstSnapshot.generation + 1)
    assert.equal((await stat(secondPaths.sourcePath)).ino, sourceIdentity.ino)
    assert.equal((await stat(secondPaths.sourcePath)).dev, sourceIdentity.dev)
    assert.equal((await stat(secondPaths.dataPath)).ino, dataIdentity.ino)
    assert.equal(await readFile(join(secondPaths.sourcePath, 'src/a.ts'), 'utf8'), 'export const needle = 2')
    assert.equal(await readFile(join(secondPaths.sourcePath, 'src/new.ts'), 'utf8'), '')
    await assert.rejects(lstat(join(secondPaths.sourcePath, 'src/remove.ts')))
    assert.equal(await readFile(join(secondPaths.dataPath, 'sentinel.db'), 'utf8'), 'persistent')

    await state.store.close()
    const restarted = await BridgeStore.open(state.config)
    try {
      const current = await restarted.current(state.scope)
      assert.equal(current?.manifestHash, second.next.manifestHash)
      const paths = await restarted.snapshotPaths(state.scope, current!)
      assert.equal((await stat(paths.sourcePath)).ino, sourceIdentity.ino)
      assert.equal(await readFile(join(paths.dataPath, 'sentinel.db'), 'utf8'), 'persistent')
    } finally { await restarted.close() }
  } finally { await state.store.close().catch(() => undefined); await rm(state.root, { recursive: true, force: true }) }
})

test('a failed second owner leaves the original lock inode and contents intact', async () => {
  const state = await setup()
  try {
    const lockPath = join(state.dataDir, '.bridge-server-lock')
    const beforeInfo = await lstat(lockPath)
    const beforeBytes = await readFile(lockPath)
    await assert.rejects(BridgeStore.open(state.config), (error: unknown) => error instanceof BridgeContractError && error.code === 'STORE_INVALID')
    const afterInfo = await lstat(lockPath)
    assert.equal(afterInfo.dev, beforeInfo.dev)
    assert.equal(afterInfo.ino, beforeInfo.ino)
    assert.deepEqual(await readFile(lockPath), beforeBytes)
    assert.equal((await state.store.current(state.scope)), null)
  } finally { await state.store.close(); await rm(state.root, { recursive: true, force: true }) }
})

test('restart refuses a corrupt recovery journal without touching an outside canary', async () => {
  const state = await setup()
  try {
    const initial = await transfer(state.store, state.scope, 0, { 'src/a.ts': 'safe' })
    const initialPaths = await state.store.createSnapshot(state.scope, initial.operationId, initial.next)
    await state.store.publishSnapshot(state.scope, initialPaths, initial.next, fingerprint)
    await state.store.removeTransfer(state.scope, initial.operationId)
    const canaryPath = join(state.root, 'outside.ts')
    await writeFile(canaryPath, 'preserve')
    const pending = await transfer(state.store, state.scope, 1, { 'src/a.ts': 'changed' })
    const pendingPaths = await state.store.createSnapshot(state.scope, pending.operationId, pending.next)
    await writeFile(pendingPaths.journalPath, JSON.stringify({
      schemaVersion: 1, operationId: pending.operationId, clientId, workspaceId: state.scope.workspaceId,
      oldGeneration: 1, oldManifestHash: initial.next.manifestHash, generation: 2,
      manifestHash: pending.next.manifestHash, oldTop: ['../outside.ts'], newTop: ['src'], phase: 'prepared',
    }))
    await state.store.close()
    await assert.rejects(BridgeStore.open(state.config), (error: unknown) => error instanceof BridgeContractError && error.code === 'STORE_INVALID')
    assert.equal(await readFile(canaryPath, 'utf8'), 'preserve')
  } finally { await state.store.close().catch(() => undefined); await rm(state.root, { recursive: true, force: true }) }
})

test('restart rolls back an interrupted child swap and retains a published tree with leftover cleanup state', async () => {
  const state = await setup()
  try {
    const initial = await transfer(state.store, state.scope, 0, { 'src/value.ts': 'old value' })
    const initialPaths = await state.store.createSnapshot(state.scope, initial.operationId, initial.next)
    await state.store.publishSnapshot(state.scope, initialPaths, initial.next, fingerprint)
    await state.store.removeTransfer(state.scope, initial.operationId)

    const pending = await transfer(state.store, state.scope, 1, { 'src/value.ts': 'new value' })
    const paths = await state.store.createSnapshot(state.scope, pending.operationId, pending.next)
    await rename(join(paths.sourcePath, 'src'), join(paths.backupPath, 'src'))
    await writeFile(paths.journalPath, JSON.stringify({
      schemaVersion: 1, operationId: pending.operationId, clientId, workspaceId: state.scope.workspaceId,
      oldGeneration: 1, oldManifestHash: initial.next.manifestHash, generation: 2,
      manifestHash: pending.next.manifestHash, oldTop: ['src'], newTop: ['src'], phase: 'prepared',
    }))
    await state.store.close()
    const recovered = await BridgeStore.open(state.config)
    try {
      const current = await recovered.current(state.scope)
      assert.equal(current?.manifestHash, initial.next.manifestHash)
      const stablePaths = await recovered.snapshotPaths(state.scope, current!)
      assert.equal(await readFile(join(stablePaths.sourcePath, 'src/value.ts'), 'utf8'), 'old value')

      const next = await transfer(recovered, state.scope, 1, { 'src/value.ts': 'published value' })
      const nextPaths = await recovered.createSnapshot(state.scope, next.operationId, next.next)
      await recovered.publishSnapshot(state.scope, nextPaths, next.next, fingerprint)
      await recovered.removeTransfer(state.scope, next.operationId)

      const cleanupPath = join(state.dataDir, 'clients', clientId, state.scope.workspaceId, '.bridge-sync', randomUUID())
      await mkdir(join(cleanupPath, 'staging'), { recursive: true })
      await mkdir(join(cleanupPath, 'backup', 'src'), { recursive: true })
      await writeFile(join(cleanupPath, '.bridge-sync.json'), JSON.stringify({ schemaVersion: 1, operationId: basename(cleanupPath), clientId, workspaceId: state.scope.workspaceId }))
      await writeFile(join(cleanupPath, 'journal.json'), JSON.stringify({
        schemaVersion: 1, operationId: basename(cleanupPath), clientId, workspaceId: state.scope.workspaceId,
        oldGeneration: 1, oldManifestHash: initial.next.manifestHash, generation: 2,
        manifestHash: next.next.manifestHash, oldTop: ['src'], newTop: ['src'], phase: 'swapped',
      }))
      const newest = await transfer(recovered, state.scope, 2, { 'src/value.ts': 'newest published value' })
      const newestPaths = await recovered.createSnapshot(state.scope, newest.operationId, newest.next)
      await recovered.publishSnapshot(state.scope, newestPaths, newest.next, fingerprint)
      await recovered.removeTransfer(state.scope, newest.operationId)
      await assert.rejects(lstat(cleanupPath))
      await recovered.close()
      const restarted = await BridgeStore.open(state.config)
      try {
        const published = await restarted.current(state.scope)
        assert.equal(published?.manifestHash, newest.next.manifestHash)
        const publishedPaths = await restarted.snapshotPaths(state.scope, published!)
        assert.equal(await readFile(join(publishedPaths.sourcePath, 'src/value.ts'), 'utf8'), 'newest published value')
        await assert.rejects(lstat(cleanupPath))
      } finally { await restarted.close() }
    } finally { await recovered.close().catch(() => undefined) }
  } finally { await state.store.close().catch(() => undefined); await rm(state.root, { recursive: true, force: true }) }
})

test('dead embedded owner locks are removed only after PID and inode verification', async () => {
  const state = await setup()
  try {
    await state.store.close()
    const bridgeLock = join(state.dataDir, '.bridge-server-lock')
    await writeFile(bridgeLock, JSON.stringify({ schemaVersion: 1, pid: 2_147_483_647, nonce: randomUUID() }), { mode: 0o600 })
    const restarted = await BridgeStore.open(state.config)
    const paths = await restarted.runtimePaths(state.scope)
    const lockPath = join(paths.dataPath, '.zorya-search-owner')
    await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, nonce: randomUUID() }), { mode: 0o600 })
    await restarted.recoverDeadRuntimeOwnerLock(state.scope)
    await assert.rejects(lstat(lockPath))

    await writeFile(lockPath, JSON.stringify({ pid: process.pid, nonce: randomUUID() }), { mode: 0o600 })
    const before = await readFile(lockPath)
    await assert.rejects(restarted.recoverDeadRuntimeOwnerLock(state.scope), (error: unknown) => error instanceof BridgeContractError && error.code === 'STORE_INVALID')
    assert.deepEqual(await readFile(lockPath), before)
    await restarted.close()
  } finally { await state.store.close().catch(() => undefined); await rm(state.root, { recursive: true, force: true }) }
})

test('concurrent plans serialize pending-transfer quota admission across workspaces', async () => {
  const state = await setup()
  try {
    const manifestValue = manifest({ 'src/transfer.ts': 'export const transfer = true' })
    const plans = await Promise.allSettled(Array.from({ length: 3 }, (_, index) => {
      const scope = createBridgeScope({
        clientInstanceId: clientId,
        conversationId: randomUUID(),
        canonicalPath: resolve(state.root, `project-${index}`),
      })
      return state.store.plan(scope, randomUUID(), 0, manifestValue, fingerprint)
    }))
    assert.equal(plans.filter((plan) => plan.status === 'fulfilled').length, 2)
    const rejected = plans.find((plan) => plan.status === 'rejected')
    assert.ok(rejected && rejected.status === 'rejected')
    assert.ok(rejected.reason instanceof BridgeContractError)
    assert.equal(rejected.reason.code, 'TRANSFER_LIMIT_EXCEEDED')
  } finally { await state.store.close(); await rm(state.root, { recursive: true, force: true }) }
})
