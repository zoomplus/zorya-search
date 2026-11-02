import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  BRIDGE_MAX_CHUNK_BYTES,
  BRIDGE_MAX_CHUNKS_PER_TRANSFER,
  BRIDGE_MAX_FILE_BYTES,
  BRIDGE_MAX_STATUS_OPERATIONS,
  BridgeContractError,
  BridgeScopeSchema,
  canonicalManifestBytes,
  createBridgeManifest,
  createBridgeScope,
  manifestHash,
  parseBridgeManifest,
  parseBridgeRequest,
  parseBridgeResponse,
  validateBridgeFilePayload,
  workspaceIdForCanonicalPath,
} from '../../src/bridge/protocol.js'
import { parseBridgeClientConfig, parseBridgeServerConfig } from '../../src/bridge/config.js'

const clientId = '4d1237be-9821-4b95-9079-b77d935bbf01'
const conversationId = '37cc2038-70ef-41f1-ae10-48cd6d936799'
const canonicalWorkspace = resolve(tmpdir(), 'zorya-workspace')

function file(path: string, content: string) {
  const bytes = Buffer.from(content)
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength }
}

function scope() {
  return createBridgeScope({ clientInstanceId: clientId, conversationId, canonicalPath: canonicalWorkspace, rootLabel: 'Проект поиска' })
}

function configFixture(dataDir: string) {
  return {
    schemaVersion: 1,
    resource: 'https://startzorya.com/mcp/search',
    bindHost: '127.0.0.1',
    port: 8787,
    dataDir,
    trustedProxyCidrs: [],
    allowedOrigins: ['https://chatgpt.com'],
    clients: [{
      clientId,
      tokenSha256: 'a'.repeat(64),
      clientCidrs: ['198.51.100.7/32'],
      grants: ['read'],
    }],
  }
}

test('scope binds a UUID client and conversation to a stable canonical-path hash', () => {
  const first = workspaceIdForCanonicalPath(clientId, canonicalWorkspace)
  assert.equal(first.length, 64)
  assert.match(first, /^[0-9a-f]{64}$/u)
  assert.equal(first, workspaceIdForCanonicalPath(clientId, canonicalWorkspace))
  assert.notEqual(first, workspaceIdForCanonicalPath(clientId, resolve(tmpdir(), 'zorya-other')))
  assert.notEqual(first, workspaceIdForCanonicalPath(randomUUID(), canonicalWorkspace))
  assert.throws(() => workspaceIdForCanonicalPath(clientId, 'relative'), BridgeContractError)
  assert.throws(() => BridgeScopeSchema.parse({ ...scope(), rootLabel: 'не/путь' }))
  assert.equal(scope().rootLabel, 'Проект поиска')
})

test('manifest hash is deterministic, sorted, and retains native Unicode spelling', () => {
  const nfd = 'cafe\u0301.ts'
  const files = [file('src/z.ts', 'z'), file(`src/${nfd}`, 'cafe')]
  const manifest = createBridgeManifest(files)
  assert.deepEqual(manifest.files.map(({ path }) => path), [`src/${nfd}`, 'src/z.ts'])
  assert.equal(manifest.manifestHash, manifestHash([...files].reverse()))
  assert.deepEqual(parseBridgeManifest(manifest).files, manifest.files)
  assert.equal(canonicalManifestBytes(files).toString('utf8').includes(nfd), true)
  assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest.files) && Object.isFrozen(manifest.files[0]))
})

test('manifest rejects traversal, absolute, platform-sensitive, private, and unpermitted paths', () => {
  for (const path of [
    '../outside.ts', 'src/../outside.ts', '/etc/passwd.ts', 'C:/secret.ts', 'src\\file.ts',
    'src/file.ts:stream', 'src/CON.ts', 'src/trailing. /file.ts', 'src/.env', 'src/.env.local',
    'src/.git/config', 'src/.codex/config.toml', 'src/.cursor/mcp.json', 'src/.aws/credentials',
    'src/.claude/settings.json', 'src/mcp.json', 'src/.netrc', 'src/id_rsa', 'src/private-key.ts',
    'src/config-store/settings.json', 'src/image.png',
  ]) {
    assert.throws(() => createBridgeManifest([file(path, 'x')]), BridgeContractError, path)
  }
  assert.throws(() => createBridgeManifest([file('README.md', 'docs')]), BridgeContractError)
  const permitted = createBridgeManifest([file('README.md', 'docs')], { allowedDocumentPaths: ['README.md'] })
  assert.equal(permitted.files[0]?.path, 'README.md')
  assert.throws(() => createBridgeManifest([file('.cursor/rules/agent.md', 'rule')]), BridgeContractError)
  const cursorDoc = createBridgeManifest([file('.cursor/rules/agent.md', 'rule')], { allowedDocumentPaths: ['.cursor/rules/agent.md'] })
  assert.equal(cursorDoc.files.length, 1)
  assert.equal(createBridgeManifest([file('.cursor/rules/project.mdc', 'rule')], { allowedDocumentPaths: ['.cursor/rules/project.mdc'] }).files.length, 1)
})

test('manifest rejects exact and normalized case collisions while allowing an uncollided NFD name', () => {
  assert.throws(() => createBridgeManifest([file('src/File.ts', 'a'), file('src/file.ts', 'b')]), BridgeContractError)
  assert.throws(() => createBridgeManifest([file('src/café.ts', 'a'), file('src/cafe\u0301.ts', 'b')]), BridgeContractError)
  assert.equal(createBridgeManifest([file('src/cafe\u0301.ts', 'a')]).files.length, 1)
})

test('manifest and chunk quotas are enforced before accepting transfer payloads', () => {
  assert.ok(BRIDGE_MAX_CHUNKS_PER_TRANSFER >= 5_000 + Math.ceil(50_000_000 / BRIDGE_MAX_CHUNK_BYTES))
  assert.equal(BRIDGE_MAX_STATUS_OPERATIONS, 10)
  assert.throws(() => createBridgeManifest(Array.from({ length: 5_001 }, (_, index) => file(`src/${index}.ts`, ''))), BridgeContractError)
  assert.throws(() => createBridgeManifest(Array.from({ length: 51 }, (_, index) => ({
    path: `src/${index}.ts`, sha256: 'a'.repeat(64), bytes: BRIDGE_MAX_FILE_BYTES,
  }))), BridgeContractError)
  assert.throws(() => createBridgeManifest([{
    path: 'src/large.ts', sha256: 'a'.repeat(64), bytes: BRIDGE_MAX_FILE_BYTES + 1,
  }]), BridgeContractError)
  const content = Buffer.alloc(BRIDGE_MAX_CHUNK_BYTES + 1, 97)
  const request = {
    schemaVersion: 1,
    operationId: randomUUID(),
    scope: scope(),
    action: 'put',
    baseGeneration: 0,
    expectedManifestHash: 'a'.repeat(64),
    path: 'src/a.ts',
    contentHash: 'b'.repeat(64),
    expectedBytes: BRIDGE_MAX_CHUNK_BYTES + 1,
    offset: 0,
    dataBase64: content.toString('base64'),
  }
  assert.ok(content.byteLength > BRIDGE_MAX_CHUNK_BYTES)
  assert.throws(() => parseBridgeRequest(request), BridgeContractError)
  const emptyHash = createHash('sha256').update(Buffer.alloc(0)).digest('hex')
  assert.equal(parseBridgeRequest({ ...request, contentHash: emptyHash, expectedBytes: 0, dataBase64: '' }).action, 'put')
  assert.throws(() => parseBridgeRequest({ ...request, dataBase64: '' }), BridgeContractError)
  assert.throws(() => validateBridgeFilePayload('src/a.ts', Buffer.from([0xff]), 'a'.repeat(64)), BridgeContractError)
  assert.deepEqual(validateBridgeFilePayload('src/empty.ts', Buffer.alloc(0), emptyHash), {
    path: 'src/empty.ts', sha256: emptyHash, bytes: 0,
  })
  const statusBase = { schemaVersion: 1, operationId: randomUUID(), scope: scope(), action: 'status', ok: true, generation: null, manifestHash: null, state: 'empty' }
  assert.equal(parseBridgeResponse({ ...statusBase, activeOperations: 10 }).action, 'status')
  assert.throws(() => parseBridgeResponse({ ...statusBase, activeOperations: 11 }), BridgeContractError)
})

test('file validation checks identity and rejects known secret material as a whole file', () => {
  const payload = Buffer.from('export const value = 1')
  const hash = createHash('sha256').update(payload).digest('hex')
  assert.deepEqual(validateBridgeFilePayload('src/value.ts', payload, hash), {
    path: 'src/value.ts', sha256: hash, bytes: payload.byteLength,
  })
  assert.throws(() => validateBridgeFilePayload('src/value.ts', payload, '0'.repeat(64)), BridgeContractError)
  for (const secret of [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'AKIA1234567890ABCDEF',
    'ghp_123456789012345678901234567890',
    'sk-123456789012345678901234',
    'xoxb-123456789012345678901234',
  ]) {
    const bytes = Buffer.from(`const token = '${secret}'`)
    const secretHash = createHash('sha256').update(bytes).digest('hex')
    assert.throws(() => validateBridgeFilePayload('src/token.ts', bytes, secretHash), BridgeContractError)
  }
})

test('responses require typed analytical snapshot provenance tied to response scope and manifest', () => {
  const currentScope = scope()
  const manifest = 'c'.repeat(64)
  const provenance = { kind: 'analytical_snapshot', scope: currentScope, generation: 3, manifestHash: manifest }
  const response = {
    schemaVersion: 1,
    operationId: randomUUID(),
    scope: currentScope,
    action: 'commit',
    ok: true,
    expectedManifestHash: manifest,
    generation: 3,
    manifestHash: manifest,
    provenance,
  }
  assert.equal(parseBridgeResponse(response).action, 'commit')
  assert.throws(() => parseBridgeResponse({ ...response, provenance: { ...provenance, manifestHash: 'd'.repeat(64) } }), BridgeContractError)
  assert.throws(() => parseBridgeResponse({ ...response, provenance: { ...provenance, scope: { ...currentScope, conversationId: randomUUID() } } }), BridgeContractError)
  const syncOperationId = randomUUID()
  const planResponse = {
    schemaVersion: 1,
    operationId: syncOperationId,
    scope: currentScope,
    action: 'plan',
    ok: true,
    expectedManifestHash: manifest,
    generation: null,
    manifestHash: null,
    uploadId: syncOperationId,
    alreadyCurrent: false,
    missingFiles: [],
    maxChunkBytes: BRIDGE_MAX_CHUNK_BYTES,
  }
  assert.equal(parseBridgeResponse(planResponse).action, 'plan')
  assert.throws(() => parseBridgeResponse({ ...planResponse, uploadId: randomUUID() }), BridgeContractError)
  const callResponse = {
    ...response,
    action: 'call',
    result: { kind: 'tool_result', result: { isError: true, structuredContent: { code: 'source_changed' }, content: [{ type: 'text', text: 'Preserved result payload.' }] } },
  }
  assert.deepEqual((parseBridgeResponse(callResponse) as { result: { result: { structuredContent: unknown } } }).result.result.structuredContent, { code: 'source_changed' })
})

test('source-free requests and results use an explicit null snapshot pair and unverified provenance', () => {
  const currentScope = scope()
  const base = { schemaVersion: 1, operationId: randomUUID(), scope: currentScope, action: 'call', toolName: 'capabilities', arguments: {} }
  assert.equal(parseBridgeRequest({ ...base, generation: null, expectedManifestHash: null }).action, 'call')
  assert.throws(() => parseBridgeRequest({ ...base, generation: null, expectedManifestHash: 'a'.repeat(64) }), BridgeContractError)
  assert.throws(() => parseBridgeRequest({ ...base, generation: 1, expectedManifestHash: null }), BridgeContractError)

  const sourceFree = {
    schemaVersion: 1,
    operationId: base.operationId,
    scope: currentScope,
    action: 'call',
    ok: true,
    expectedManifestHash: null,
    generation: null,
    manifestHash: null,
    provenance: { kind: 'source_free', scope: currentScope, projectFilesIncluded: false, localVerification: 'not_performed' },
    result: { kind: 'tool_result', result: { structuredContent: { projectFilesIncluded: false } } },
  }
  assert.equal(parseBridgeResponse(sourceFree).action, 'call')
  assert.throws(() => parseBridgeResponse({ ...sourceFree, provenance: { ...sourceFree.provenance, scope: { ...currentScope, conversationId: randomUUID() } } }), BridgeContractError)
  const cancelBase = { schemaVersion: 1, operationId: randomUUID(), scope: currentScope, action: 'cancel', targetOperationId: randomUUID() }
  assert.equal(parseBridgeRequest({ ...cancelBase, targetGeneration: null, expectedManifestHash: null }).action, 'cancel')
  assert.throws(() => parseBridgeRequest({ ...cancelBase, targetGeneration: null, expectedManifestHash: 'b'.repeat(64) }), BridgeContractError)
})

test('server config requires explicit HTTPS resource and rejects unsafe paths and unknown settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-bridge-contract-'))
  try {
    const dataDir = join(root, 'server-data')
    const forbidden = join(root, 'workspace')
    await mkdir(forbidden)
    const valid = configFixture(dataDir)
    const parsed = await parseBridgeServerConfig(valid, { forbiddenRoots: [forbidden] })
    assert.equal(parsed.resource, 'https://startzorya.com/mcp/search')
    assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.clients) && Object.isFrozen(parsed.clients[0]))
    for (const change of [
      { ...valid, resource: undefined },
      { ...valid, resource: 'https://startzorya.com/' },
      { ...valid, resource: 'https://user@startzorya.com/mcp/search' },
      { ...valid, resource: 'https://startzorya.com/mcp/search?x=1' },
      { ...valid, resource: 'http://127.0.0.1/mcp/search' },
      { ...valid, resource: 'https://0.0.0.0/mcp/search' },
      { ...valid, resource: 'https://localhost./mcp/search' },
      { ...valid, clients: [{ ...valid.clients[0], allowedDocumentPaths: ['.cursor/mcp.md'] }] },
      { ...valid, bindHost: '0.0.0.0' },
      { ...valid, unknown: true },
      { ...valid, dataDir: join(root, 'workspace', 'data') },
    ]) await assert.rejects(parseBridgeServerConfig(change, { forbiddenRoots: [forbidden] }), BridgeContractError)
    await assert.rejects(parseBridgeServerConfig({ ...valid, runtimeTemplate: { roots: [] } }), BridgeContractError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('server config rejects invalid CIDRs, duplicate grants, and unpermitted document paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-bridge-contract-'))
  try {
    const valid = configFixture(join(root, 'server-data'))
    const invalidCases = [
      { ...valid, clients: [{ ...valid.clients[0], clientCidrs: ['198.51.100.0/33'] }] },
      { ...valid, clients: [{ ...valid.clients[0], clientCidrs: ['0.0.0.0/0'] }] },
      { ...valid, clients: [{ ...valid.clients[0], grants: ['read', 'read'] }] },
      { ...valid, clients: [{ ...valid.clients[0], allowedDocumentPaths: ['../README.md'] }] },
      { ...valid, clients: [{ ...valid.clients[0], excludedPaths: Array.from({ length: 129 }, (_, index) => `excluded-${index}`) }] },
      { ...valid, trustedProxyCidrs: ['not-a-cidr'] },
      { ...valid, trustedProxyCidrs: ['198.51.100.1/32', '198.51.100.1/32'] },
      { ...valid, trustedProxyCidrs: ['::/0'] },
    ]
    for (const input of invalidCases) await assert.rejects(parseBridgeServerConfig(input), BridgeContractError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('client config binds local state to cwd and rejects credentials inside workspace or through symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-bridge-client-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  try {
    await mkdir(workspace)
    await mkdir(outside)
    await mkdir(join(outside, 'state'))
    const credentialFile = join(outside, 'token')
    await writeFile(credentialFile, 'opaque-token')
    await chmod(credentialFile, 0o600)
    const base = {
      schemaVersion: 1,
      endpoint: 'https://startzorya.com/mcp/search',
      clientId,
      stateDir: join(outside, 'state'),
      credential: { kind: 'file', path: credentialFile },
    }
    const parsed = await parseBridgeClientConfig(base, { cwd: workspace })
    assert.equal(parsed.endpoint, base.endpoint)
    assert.ok(Object.isFrozen(parsed))
    assert.deepEqual((await parseBridgeClientConfig({ ...base, allowedDocumentPaths: ['docs/guide.mdc'], excludedPaths: ['generated/**'] }, { cwd: workspace })).allowedDocumentPaths, ['docs/guide.mdc'])
    await assert.rejects(parseBridgeClientConfig({ ...base, allowedDocumentPaths: ['../private.mdc'] }, { cwd: workspace }), BridgeContractError)
    await assert.rejects(parseBridgeClientConfig({ ...base, excludedPaths: Array.from({ length: 129 }, (_, index) => `excluded-${index}`) }, { cwd: workspace }), BridgeContractError)
    const stateCredential = join(outside, 'state', 'credential')
    await writeFile(stateCredential, 'state-owned-token')
    await chmod(stateCredential, 0o600)
    assert.equal((await parseBridgeClientConfig({ ...base, credential: { kind: 'file', path: stateCredential } }, { cwd: workspace })).credential.kind, 'file')
    await assert.rejects(parseBridgeClientConfig({ ...base, stateDir: join(workspace, 'state') }, { cwd: workspace }), BridgeContractError)
    await assert.rejects(parseBridgeClientConfig({ ...base, credential: { kind: 'file', path: join(workspace, 'token') } }, { cwd: workspace }), BridgeContractError)
    const symlinkPath = join(outside, 'linked-token')
    if (process.platform !== 'win32') {
      await symlink(credentialFile, symlinkPath)
      await assert.rejects(parseBridgeClientConfig({ ...base, credential: { kind: 'file', path: symlinkPath } }, { cwd: workspace }), BridgeContractError)
    }
    await assert.rejects(parseBridgeClientConfig({ ...base, endpoint: 'http://127.0.0.1:8787/mcp/search' }, { cwd: workspace }), BridgeContractError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
