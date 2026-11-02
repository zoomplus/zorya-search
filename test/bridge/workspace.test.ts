import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { bindCurrentWorkspace } from '../../src/bridge/workspace.js'
import { BridgeContractError } from '../../src/bridge/protocol.js'

const clientInstanceId = '4d1237be-9821-4b95-9079-b77d935bbf01'
const threadId = '37cc2038-70ef-41f1-ae10-48cd6d936799'
const call = { _meta: { 'x-codex-turn-metadata': { thread_id: threadId } }, threadId }
const dirs: string[] = []

async function workspace() {
  const path = await mkdtemp(join(tmpdir(), 'zorya-bridge-workspace-'))
  dirs.push(path)
  return path
}

test.afterEach(async () => {
  const current = process.cwd()
  const temporary = dirs.splice(0)
  if (temporary.includes(current)) process.chdir(tmpdir())
  await Promise.all(temporary.map((path) => rm(path, { recursive: true, force: true })))
})

test('workspace snapshots isolate clients and preserve source bytes, NFD paths, and empty files', async () => {
  const first = await workspace()
  const second = await workspace()
  for (const root of [first, second]) await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(first, 'src/same.ts'), 'const word = "first"\r\n')
  await writeFile(join(second, 'src/same.ts'), 'const word = "second"\n')
  await writeFile(join(first, 'src/cafe\u0301.ts'), 'const nfd = true\r\n')
  await writeFile(join(first, 'src/empty.ts'), '')

  process.chdir(first)
  const firstBinding = await bindCurrentWorkspace({ clientInstanceId, call })
  const firstSnapshot = await firstBinding.scan()
  process.chdir(second)
  const secondBinding = await bindCurrentWorkspace({ clientInstanceId, call })
  const secondSnapshot = await secondBinding.scan()
  assert.notEqual(firstSnapshot.manifest.manifestHash, secondSnapshot.manifest.manifestHash)
  assert.equal(Buffer.from(firstSnapshot.files.get('src/same.ts')!).toString('utf8'), 'const word = "first"\r\n')
  assert.equal(Buffer.from(secondSnapshot.files.get('src/same.ts')!).toString('utf8'), 'const word = "second"\n')
  assert.equal(Buffer.from(firstSnapshot.files.get('src/cafe\u0301.ts')!).toString('utf8'), 'const nfd = true\r\n')
  assert.equal(firstSnapshot.manifest.files.find((file) => file.path === 'src/empty.ts')?.bytes, 0)
  assert.notEqual(firstSnapshot.scope.workspaceId, secondSnapshot.scope.workspaceId)
  assert.notEqual(
    (await bindCurrentWorkspace({ clientInstanceId: randomUUID(), call })).scope.workspaceId,
    secondBinding.scope.workspaceId,
  )
})

test('native conversation identity is required and conflicting metadata is refused', async () => {
  const root = await workspace()
  process.chdir(root)
  await assert.rejects(bindCurrentWorkspace({ clientInstanceId, call: {} }), (error: unknown) =>
    error instanceof BridgeContractError && error.code === 'CONVERSATION_UNRESOLVED')
  await assert.rejects(bindCurrentWorkspace({
    clientInstanceId,
    call: { ...call, threadId: randomUUID() },
  }), (error: unknown) => error instanceof BridgeContractError && error.code === 'SCOPE_MISMATCH')
  await assert.rejects(bindCurrentWorkspace({
    clientInstanceId,
    call: { _meta: { 'x-codex-turn-metadata': { thread_id: 'invalid' } } },
  }), (error: unknown) => error instanceof BridgeContractError && error.code === 'CONVERSATION_UNRESOLVED')
  assert.equal((await bindCurrentWorkspace({
    clientInstanceId,
    call: { _meta: { threadId } },
  })).scope.conversationId, threadId)
  await assert.rejects(bindCurrentWorkspace({
    clientInstanceId,
    call: { ...call, _meta: { threadId: randomUUID() } },
  }), (error: unknown) => error instanceof BridgeContractError && error.code === 'SCOPE_MISMATCH')
})

test('manifest excludes private canaries and symlink escapes while allowing explicitly permitted project rules', async () => {
  const root = await workspace()
  const outside = await workspace()
  await mkdir(join(root, '.cursor/rules'), { recursive: true })
  await mkdir(join(root, '.codex'), { recursive: true })
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, '.env'), 'SECRET=not-for-upload')
  await writeFile(join(root, '.gitconfig'), '[credential]\npassword=not-for-upload')
  await writeFile(join(root, '.cursor/mcp.json'), '{"token":"not-for-upload"}')
  await writeFile(join(root, '.codex/config.toml'), Buffer.alloc(1_000_001, 97))
  await writeFile(join(root, '.cursor/mcp-big.json'), Buffer.alloc(1_000_001, 98))
  await writeFile(join(root, '.cursor/rules/project.mdc'), '# Allowed project rule\r\n')
  await writeFile(join(root, 'src/safe.ts'), 'export const safe = true')
  await writeFile(join(outside, 'outside.ts'), 'export const outside = true')
  await symlink(join(outside, 'outside.ts'), join(root, 'src/escape.ts'))

  process.chdir(root)
  const binding = await bindCurrentWorkspace({
    clientInstanceId,
    call,
    allowedDocumentPaths: ['.cursor/rules/project.mdc'],
  })
  const snapshot = await binding.scan()
  const paths = snapshot.manifest.files.map((file) => file.path)
  assert.deepEqual(paths, ['.cursor/rules/project.mdc', 'src/safe.ts'])
  assert.equal(snapshot.files.has('.cursor/mcp.json'), false)
  assert.equal(snapshot.files.has('.env'), false)
  assert.equal(snapshot.files.has('.gitconfig'), false)
  assert.equal(snapshot.files.has('.codex/config.toml'), false)
  assert.equal(snapshot.files.has('.cursor/mcp-big.json'), false)
})

test('manifest omits known-secret source contents before producing upload bytes', async () => {
  const root = await workspace()
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/safe.ts'), 'export const safe = true')
  await writeFile(join(root, 'src/leak.ts'), 'const token = "ghp_123456789012345678901234567890"')
  process.chdir(root)
  const snapshot = await (await bindCurrentWorkspace({ clientInstanceId, call })).scan()
  assert.deepEqual(snapshot.manifest.files.map((file) => file.path), ['src/safe.ts'])
  assert.equal(snapshot.files.has('src/leak.ts'), false)
})

test('workspace identity is revalidated, and source modifications or deletion invalidate prior reads', async () => {
  const root = await workspace()
  const other = await workspace()
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/value.ts'), 'export const value = 1')
  process.chdir(root)
  const binding = await bindCurrentWorkspace({ clientInstanceId, call })
  const initial = await binding.scan()
  assert.equal(Buffer.from(await binding.readCurrentFile(initial.manifest, 'src/value.ts')).toString(), 'export const value = 1')
  await assert.rejects(binding.readCurrentFile({ ...initial.manifest, manifestHash: '0'.repeat(64) }, 'src/value.ts'), (error: unknown) =>
    error instanceof BridgeContractError && error.code === 'MANIFEST_INVALID')

  await writeFile(join(root, 'src/value.ts'), 'export const value = 2')
  await assert.rejects(binding.readCurrentFile(initial.manifest, 'src/value.ts'), (error: unknown) =>
    error instanceof BridgeContractError && error.code === 'STALE_GENERATION')
  const changed = await binding.scan()
  await rm(join(root, 'src/value.ts'))
  await assert.rejects(binding.readCurrentFile(changed.manifest, 'src/value.ts'), (error: unknown) =>
    error instanceof BridgeContractError && error.code === 'STALE_GENERATION')

  process.chdir(other)
  await assert.rejects(binding.scan(), (error: unknown) =>
    error instanceof BridgeContractError && error.code === 'WORKSPACE_CHANGED')
})

test('cancelled scans return a typed refusal and exclusions are honored', async () => {
  const root = await workspace()
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/omit.ts'), 'export const omit = true')
  await writeFile(join(root, 'src/keep.ts'), 'export const keep = true')
  process.chdir(root)
  const binding = await bindCurrentWorkspace({ clientInstanceId, call, exclude: ['src/omit.ts'] })
  assert.deepEqual((await binding.scan()).manifest.files.map((file) => file.path), ['src/keep.ts'])
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(binding.scan(controller.signal), (error: unknown) =>
    error instanceof BridgeContractError && error.code === 'CANCELLED')
})

test('actual current working directory is used as the workspace root', async () => {
  const root = await workspace()
  const prior = process.cwd()
  process.chdir(root)
  try {
    const binding = await bindCurrentWorkspace({ clientInstanceId, call })
    assert.equal(binding.canonicalPath, resolve(root))
  } finally {
    process.chdir(prior)
  }
})
