import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { canonicalConfigPath, ownerDir, readPrivateFile } from '../../src/cli/files.js'
import { configureSearchCapability } from '../../src/cli/configure.js'

const cliEntry = resolve('src/cli/entry.ts')
const builtCliEntry = resolve('dist/cli/entry.js')
const canaryValues = {
  BRAVE_SETUP_CANARY: 'brave-api-canary-never-print',
  VISUAL_SETUP_CANARY: 'visual-api-canary-never-print',
  CODE_SETUP_CANARY: 'code-api-canary-never-print',
  TEXT_SETUP_CANARY: 'text-api-canary-never-print',
  JEV_SETUP_CANARY: 'jev-api-canary-never-print',
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

function runBuiltCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [builtCliEntry, ...args], { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

test('configure CLI applies supported capabilities incrementally and keeps secret canaries out of output', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-search-configure-'))
  const configPath = join(dir, 'config', 'runtime.json')
  const root = join(dir, 'root')
  const dataDir = join(dir, 'state')
  const secretsPath = join(dirname(configPath), 'secrets.json')
  try {
    await mkdir(root, { recursive: true })
    await mkdir(dirname(configPath), { recursive: true })
    const priorSecret = 'preexisting-secret-canary'
    const priorSecrets = `${JSON.stringify({ web: priorSecret })}\n`
    await writeFile(secretsPath, priorSecrets, { mode: 0o600 })
    const initial = {
      version: 1,
      dataDir,
      roots: [{ id: 'repo', path: root, exclude: ['dist'], watch: false, limits: { maxFiles: 100 } }],
      reranker: { model: 'existing/reranker', secret: { kind: 'file', file: 'secrets.json', key: 'web' } },
      mechanism: {
        code: { secret: { kind: 'file', file: 'secrets.json', key: 'web' }, limits: { timeoutMs: 8000, attempts: 2 } },
        visual: { secret: { kind: 'file', file: 'secrets.json', key: 'web' }, limits: { timeoutMs: 7000 } },
      },
      limits: { timeoutMs: 7000 },
      indexing: { maxAttempts: 3 },
    }
    await writeFile(configPath, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 })
    const env = { ...canaryValues }
    const actions: Array<[string, string?]> = [
      ['project-text'],
      ['web-read'],
      ['web-discovery', 'BRAVE_SETUP_CANARY'],
      ['visual', 'VISUAL_SETUP_CANARY'],
      ['code-embeddings', 'CODE_SETUP_CANARY'],
      ['project-text-embeddings', 'TEXT_SETUP_CANARY'],
      ['jev-classification', 'JEV_SETUP_CANARY'],
    ]
    for (const [capability, keyName] of actions) {
      const result = await runCli([
        'configure', '--config', configPath, '--capability', capability,
        ...(keyName ? ['--secret-env', keyName] : []),
      ], env)
      assert.equal(result.code, 0, result.stderr)
      assert.doesNotMatch(result.stdout + result.stderr, /api-canary-never-print|preexisting-secret-canary/u)
      const receipt = JSON.parse(result.stdout) as { configured: boolean; changed: boolean; providerProbed: boolean; mcpReconnectRequired: boolean }
      assert.equal(receipt.configured, true)
      assert.equal(receipt.changed, true)
      assert.equal(receipt.providerProbed, false)
      assert.equal(receipt.mcpReconnectRequired, true)
      if (capability === 'project-text') {
        const lexicalOnly = JSON.parse(await readFile(configPath, 'utf8')) as { projectText?: Record<string, unknown> }
        assert.deepEqual(lexicalOnly.projectText, {})
      }
    }
    const unchanged = await runCli(['configure', '--config', configPath, '--capability', 'project-text'])
    assert.equal(unchanged.code, 0, unchanged.stderr)
    const unchangedReceipt = JSON.parse(unchanged.stdout) as { changed: boolean; mcpReconnectRequired: boolean }
    assert.equal(unchangedReceipt.changed, false)
    assert.equal(unchangedReceipt.mcpReconnectRequired, false)
    const configured = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>
    assert.deepEqual(configured.roots, initial.roots)
    assert.equal(configured.projectText.embedding.model, 'voyageai/voyage-4-large')
    assert.equal(configured.projectText.embedding.secret.name, 'TEXT_SETUP_CANARY')
    assert.equal(configured.projectText.reranker.model, 'voyageai/rerank-2.5-lite')
    assert.deepEqual(configured.web.discovery.secret, { kind: 'env', name: 'BRAVE_SETUP_CANARY' })
    assert.equal(configured.dataDir, dataDir)
    assert.deepEqual(configured.limits, initial.limits)
    assert.deepEqual(configured.indexing, initial.indexing)
    assert.deepEqual(configured.web.discovery.secret, { kind: 'env', name: 'BRAVE_SETUP_CANARY' })
    assert.deepEqual(configured.reranker.secret, initial.reranker.secret)
    assert.deepEqual(configured.mechanism.visual.secret, { kind: 'env', name: 'VISUAL_SETUP_CANARY' })
    assert.deepEqual(configured.mechanism.code.secret, { kind: 'env', name: 'CODE_SETUP_CANARY' })
    assert.deepEqual(configured.mechanism.code.limits, { timeoutMs: 8000, attempts: 2 })
    assert.deepEqual(configured.mechanism.visual.limits, { timeoutMs: 7000 })
    assert.equal(configured.projectText.embedding.model, 'voyageai/voyage-4-large')
    assert.equal(configured.projectText.reranker.model, 'voyageai/rerank-2.5-lite')
    assert.deepEqual(configured.projectText.embedding.secret, { kind: 'env', name: 'TEXT_SETUP_CANARY' })
    assert.equal(configured.classifier.model, 'typesafe/jev-1.14')
    assert.deepEqual(configured.classifier.secret, { kind: 'env', name: 'JEV_SETUP_CANARY' })
    assert.deepEqual(await readFile(secretsPath, 'utf8'), priorSecrets)
    if (process.platform !== 'win32') assert.equal((await stat(configPath)).mode & 0o777, 0o600)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('configure rejects missing owner consent and missing noninteractive secret before changing state', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-search-configure-refusal-'))
  const configPath = join(dir, 'runtime.json')
  const root = join(dir, 'root')
  const dataDir = join(dir, 'state')
  try {
    await mkdir(root, { recursive: true })
    const original = {
      version: 1,
      dataDir,
      roots: [{ id: 'repo', path: root, watch: true }],
      projectText: {},
    }
    const configBytes = `${JSON.stringify(original, null, 2)}\n`
    await writeFile(configPath, configBytes, { mode: 0o600 })
    const denied = await runCli(['configure', '--config', configPath, '--capability', 'code-embeddings', '--secret-env', 'CODE_SETUP_CANARY'], canaryValues)
    assert.equal(denied.code, 1)
    assert.match(denied.stderr, /CONFIGURE_WATCH_INDEX_CONSENT_REQUIRED/u)
    assert.equal(await readFile(configPath, 'utf8'), configBytes)
    await assert.rejects(access(join(dir, 'secrets.json')))

    const missing = await runCli(['configure', '--config', configPath, '--capability', 'visual'])
    assert.equal(missing.code, 1)
    assert.match(missing.stderr, /CONFIGURE_SECRET_TTY_REQUIRED/u)
    assert.equal(await readFile(configPath, 'utf8'), configBytes)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('configure can reuse an explicitly selected existing secret reference without printing its value', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-search-configure-reuse-'))
  const configPath = join(dir, 'runtime.json')
  const root = join(dir, 'root')
  try {
    await mkdir(root, { recursive: true })
    const config = {
      version: 1,
      dataDir: join(dir, 'state'),
      roots: [{ id: 'repo', path: root }],
      mechanism: { code: { secret: { kind: 'env', name: 'EXISTING_PROVIDER_KEY' } } },
    }
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    const result = await runCli(['configure', '--config', configPath, '--capability', 'visual', '--reuse-secret-ref', 'mechanism.code.secret'], { EXISTING_PROVIDER_KEY: 'explicit-reuse-canary' })
    assert.equal(result.code, 0, result.stderr)
    assert.doesNotMatch(result.stdout + result.stderr, /explicit-reuse-canary/u)
    const saved = JSON.parse(await readFile(configPath, 'utf8')) as { mechanism: { visual: { secret: unknown }; code: { secret: unknown } } }
    assert.deepEqual(saved.mechanism.visual.secret, config.mechanism.code.secret)
    assert.deepEqual(saved.mechanism.code.secret, config.mechanism.code.secret)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('configure accepts a hidden key in a local PTY without echoing it', { timeout: 60_000, skip: process.platform === 'win32' || spawnSync('script', ['--version'], { encoding: 'utf8' }).status !== 0 ? 'GNU script PTY is unavailable.' : false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-search-configure-pty-'))
  const root = join(dir, 'root')
  const configPath = join(dir, 'config', 'runtime.json')
  const canary = 'hidden-pty-secret-canary-do-not-echo'
  try {
    await mkdir(root, { recursive: true })
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, `${JSON.stringify({ version: 1, dataDir: join(dir, 'state'), roots: [{ id: 'repo', path: root }] }, null, 2)}\n`, { mode: 0o600 })
    const command = [process.execPath, '--import', 'tsx', cliEntry, 'configure', '--config', configPath, '--capability', 'visual'].map(shellQuote).join(' ')
    const child = spawn('script', ['-qefc', command, '/dev/null'], { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let transcript = ''
    let secretSent = false
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      transcript += chunk
      if (!secretSent && transcript.includes('API key (hidden; stored in the local private secrets file; provider: OpenRouter): ')) {
        secretSent = true
        child.stdin.write(canary + '\r')
        child.stdin.end()
      }
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { transcript += chunk })
    const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
      child.once('error', reject)
      child.once('close', resolvePromise)
    })
    assert.equal(exitCode, 0, transcript)
    assert.doesNotMatch(transcript, new RegExp(canary, 'u'))
    assert.match(transcript, /"providerProbed": false/u)
    const secrets = JSON.parse(await readFile(join(dirname(configPath), 'secrets.json'), 'utf8')) as Record<string, string>
    assert.deepEqual(Object.values(secrets), [canary])
    if (process.platform !== 'win32') assert.equal((await stat(join(dirname(configPath), 'secrets.json'))).mode & 0o777, 0o600)
    const configBytes = await readFile(configPath, 'utf8')
    const secretsBytes = await readFile(join(dirname(configPath), 'secrets.json'), 'utf8')
    const abortCommand = [process.execPath, '--import', 'tsx', cliEntry, 'configure', '--config', configPath, '--capability', 'web-discovery'].map(shellQuote).join(' ')
    const aborted = spawn('script', ['-qefc', abortCommand, '/dev/null'], { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let abortTranscript = ''
    let abortSent = false
    aborted.stdout.setEncoding('utf8').on('data', (chunk) => {
      abortTranscript += chunk
      if (!abortSent && abortTranscript.includes('API key (hidden; stored in the local private secrets file; provider: Brave Search): ')) {
        abortSent = true
        aborted.stdin.write('\u0004')
        aborted.stdin.end()
      }
    })
    aborted.stderr.setEncoding('utf8').on('data', (chunk) => { abortTranscript += chunk })
    const abortedCode = await new Promise<number | null>((resolvePromise, reject) => {
      aborted.once('error', reject)
      aborted.once('close', resolvePromise)
    })
    assert.equal(abortedCode, 1, abortTranscript)
    assert.match(abortTranscript, /CONFIGURE_ABORTED/u)
    assert.equal(await readFile(configPath, 'utf8'), configBytes)
    assert.equal(await readFile(join(dirname(configPath), 'secrets.json'), 'utf8'), secretsBytes)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('configure refuses incompatible provider secret references before changing config', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-search-configure-family-'))
  const root = join(dir, 'root')
  const configPath = join(dir, 'runtime.json')
  try {
    await mkdir(root, { recursive: true })
    const config = {
      version: 1,
      dataDir: join(dir, 'state'),
      roots: [{ id: 'repo', path: root }],
      web: { discovery: { secret: { kind: 'env', name: 'BRAVE_KEY' } } },
    }
    const bytes = `${JSON.stringify(config, null, 2)}\n`
    await writeFile(configPath, bytes, { mode: 0o600 })
    const result = await runCli(['configure', '--config', configPath, '--capability', 'visual', '--reuse-secret-ref', 'web.discovery.secret'], { BRAVE_KEY: 'brave-reference-canary' })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /CONFIGURE_SECRET_REFERENCE_INCOMPATIBLE/u)
    assert.doesNotMatch(result.stdout + result.stderr, /brave-reference-canary/u)
    assert.equal(await readFile(configPath, 'utf8'), bytes)

    const custom = {
      version: 1,
      dataDir: join(dir, 'state'),
      roots: [{ id: 'repo', path: root }],
      embedding: { provider: 'openai-compatible', profileId: 'owner-profile', model: 'owner/model', dimensions: 768, baseUrl: 'https://embed.example/v1', secret: { kind: 'env', name: 'CUSTOM_ENDPOINT_KEY' } },
    }
    const customBytes = `${JSON.stringify(custom, null, 2)}\n`
    await writeFile(configPath, customBytes, { mode: 0o600 })
    const customResult = await runCli(['configure', '--config', configPath, '--capability', 'code-embeddings', '--reuse-secret-ref', 'embedding.secret'], { CUSTOM_ENDPOINT_KEY: 'custom-provider-canary' })
    assert.equal(customResult.code, 1)
    assert.match(customResult.stderr, /CONFIGURE_SECRET_REFERENCE_INCOMPATIBLE/u)
    assert.doesNotMatch(customResult.stdout + customResult.stderr, /custom-provider-canary/u)
    assert.equal(await readFile(configPath, 'utf8'), customBytes)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('configure reports restart failure with a fixed safe code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-search-configure-restart-failure-'))
  const root = join(dir, 'root')
  const configPath = join(dir, 'runtime.json')
  const keyName = 'CONFIGURE_RESTART_CANARY'
  const secretValue = 'sk-or-restart-failure-canary'
  const previous = process.env[keyName]
  try {
    await mkdir(root, { recursive: true })
    await writeFile(configPath, `${JSON.stringify({ version: 1, dataDir: join(dir, 'state'), roots: [{ id: 'repo', path: root }] }, null, 2)}\n`, { mode: 0o600 })
    process.env[keyName] = secretValue
    const receipt = await configureSearchCapability({ configPath, capability: 'visual', secretEnv: keyName }, {
      status: async () => ({ running: true }) as never,
      stop: async () => ({ stopped: true }) as never,
      restart: async () => { throw new Error(`Provider said sk-or-secret-is ${secretValue}`) },
    })
    assert.equal(receipt.ownerWasRunning, true)
    assert.equal(receipt.ownerRestarted, false)
    assert.equal(receipt.ownerRestartError, 'OWNER_RESTART_FAILED')
    assert.doesNotMatch(JSON.stringify(receipt), /sk-or-restart-failure-canary|Provider said/u)
  } finally {
    if (previous === undefined) delete process.env[keyName]
    else process.env[keyName] = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('configure detects a config changed by another writer before mutation and reports stopped owner state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-search-configure-concurrent-'))
  const root = join(dir, 'root')
  const configPath = join(dir, 'runtime.json')
  const priorKey = process.env.CONCURRENT_VISUAL_KEY
  try {
    process.env.CONCURRENT_VISUAL_KEY = 'concurrent-visual-canary'
    await mkdir(root, { recursive: true })
    const initial = { version: 1, dataDir: join(dir, 'state'), roots: [{ id: 'repo', path: root }] }
    const initialBytes = `${JSON.stringify(initial, null, 2)}\n`
    await writeFile(configPath, initialBytes, { mode: 0o600 })
    const concurrent = { ...initial, limits: { timeoutMs: 12_000 } }
    const concurrentBytes = `${JSON.stringify(concurrent, null, 2)}\n`
    await assert.rejects(
      configureSearchCapability({ configPath, capability: 'visual', secretEnv: 'CONCURRENT_VISUAL_KEY' }, {
        status: async () => {
          await writeFile(configPath, concurrentBytes, { mode: 0o600 })
          return { running: true } as never
        },
        stop: async () => ({ stopped: true }) as never,
        restart: async () => { throw new Error('must not restart concurrent config') },
      }),
      /CONFIGURE_TRANSACTION_FAILED_OWNER_NOT_RESTORED/u,
    )
    assert.equal(await readFile(configPath, 'utf8'), concurrentBytes)
  } finally {
    if (priorKey === undefined) delete process.env.CONCURRENT_VISUAL_KEY
    else process.env.CONCURRENT_VISUAL_KEY = priorKey
    await rm(dir, { recursive: true, force: true })
  }
})

function shellQuote(value: string) { return `'${value.replaceAll("'", "'\\''")}'` }

test('built CLI stops and restarts the same owner and preserves the indexed source identity', { timeout: 120_000, skip: !existsSync(builtCliEntry) ? 'Run pnpm build before the built owner restart acceptance check.' : false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-search-configure-owner-'))
  const root = join(dir, 'root')
  const configPath = join(dir, 'config', 'runtime.json')
  const dataDir = join(dir, 'state')
  try {
    await mkdir(root, { recursive: true })
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(join(root, 'source.ts'), 'export const savedSourceIdentity = "unchanged"\n')
    await writeFile(configPath, `${JSON.stringify({ version: 1, dataDir, roots: [{ id: 'repo', path: root }], projectText: {} }, null, 2)}\n`, { mode: 0o600 })
    const initial = await runBuiltCli(['index', '--config', configPath])
    assert.equal(initial.code, 0, initial.stderr)
    const before = await readOwnerIndexStatus(configPath)
    if (process.platform !== 'win32') {
      const configAliasDirectory = join(dir, 'config-alias')
      await symlink(dirname(configPath), configAliasDirectory, 'dir')
      const aliasBefore = await readOwnerIndexStatus(join(configAliasDirectory, 'runtime.json'))
      assert.deepEqual(aliasBefore, before)
    }
    const initialMcp = await readBuiltMcp(configPath)
    assert.equal(initialMcp.visual, false)
    assert.equal(initialMcp.visualStatus, 'not_configured')
    assert.equal(initialMcp.visualSetupOffered, true)
    const env = { ...process.env, VISUAL_OWNER_RESTART_CANARY: 'provider-call-must-not-happen' }
    const configured = await runBuiltCli(['configure', '--config', configPath, '--capability', 'visual', '--secret-env', 'VISUAL_OWNER_RESTART_CANARY'], env)
    assert.equal(configured.code, 0, configured.stderr)
    const receipt = JSON.parse(configured.stdout) as { ownerWasRunning: boolean; ownerRestarted: boolean; providerProbed: boolean; mcpReconnectRequired: boolean }
    assert.equal(receipt.ownerWasRunning, true)
    assert.equal(receipt.ownerRestarted, true)
    assert.equal(receipt.providerProbed, false)
    assert.equal(receipt.mcpReconnectRequired, true)
    assert.doesNotMatch(configured.stdout + configured.stderr, /provider-call-must-not-happen/u)
    const after = await readOwnerIndexStatus(configPath)
    assert.deepEqual(after.identity, before.identity)
    assert.equal(after.chunkCount, before.chunkCount)
    const reconnectedMcp = await readBuiltMcp(configPath, { VISUAL_OWNER_RESTART_CANARY: 'provider-call-must-not-happen' })
    assert.ok(reconnectedMcp.tools.includes('search_visual_references'))
    assert.equal(reconnectedMcp.visual, true)
    assert.equal(reconnectedMcp.visualStatus, 'available')
    assert.doesNotMatch(reconnectedMcp.serialized, /provider-call-must-not-happen/u)
    const service = await runBuiltCli(['service', '--config', configPath])
    assert.equal(service.code, 0, service.stderr)
    assert.equal(JSON.parse(service.stdout).running, true)
  } finally {
    await runBuiltCli(['service', '--stop', '--config', configPath]).catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  }
})

async function readOwnerIndexStatus(configPath: string) {
  const state = ownerDir(await canonicalConfigPath(configPath))
  const descriptor = JSON.parse(await readPrivateFile(join(state, 'owner.json'))) as { pid: number; port: number; tokenFile: string }
  assert.ok(Number.isInteger(descriptor.pid))
  const token = (await readPrivateFile(join(state, descriptor.tokenFile))).trim()
  const client = new Client({ name: 'configure-test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${descriptor.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }))
  try {
    const status = await client.callTool({ name: 'index_status', arguments: { rootId: 'repo' } })
    assert.notEqual(status.isError, true)
    const value = status.structuredContent as { identity?: unknown; snapshot?: { identity?: unknown }; chunks?: unknown; chunkCount?: unknown }
    const identity = value.identity ?? value.snapshot?.identity
    assert.ok(identity)
    return { identity, chunkCount: value.chunkCount ?? value.chunks }
  } finally {
    await client.close()
  }
}

async function readBuiltMcp(configPath: string, env: NodeJS.ProcessEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [builtCliEntry, 'mcp', '--config', configPath],
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'configure-reconnect-test', version: '1.0.0' })
  await client.connect(transport)
  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name)
    const capabilities = await client.callTool({ name: 'capabilities', arguments: {} })
    assert.notEqual(capabilities.isError, true)
    const projection = capabilities.structuredContent as {
      visual: boolean
      capabilityAvailability: Record<string, { status: string }>
      setupOptions: Array<{ capability: string }>
    }
    return {
      tools,
      visual: projection.visual,
      visualStatus: projection.capabilityAvailability.visual?.status,
      visualSetupOffered: projection.setupOptions.some((option) => option.capability === 'visual'),
      serialized: JSON.stringify(capabilities),
    }
  } finally {
    await client.close()
  }
}
