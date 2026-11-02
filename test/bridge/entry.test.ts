import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { PACKAGE_VERSION } from '../../src/package-version.js'

const entry = resolve('src/bridge/entry.ts')
const tsxLoader = import.meta.resolve('tsx')

function run(args: readonly string[]) {
  return spawnSync(process.execPath, ['--import', tsxLoader, entry, ...args], { encoding: 'utf8', timeout: 10_000 })
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
  let child: ReturnType<typeof spawn> | undefined
  try {
    const configPath = join(root, 'server.json')
    const token = 'bridge-serve-entry-test-token'
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      resource: 'https://search.example.test/mcp/search',
      bindHost: '127.0.0.1',
      port: 0,
      dataDir: join(root, 'data'),
      trustedProxyCidrs: [],
      allowedOrigins: ['https://chatgpt.com'],
      clients: [{
        clientId: '4d1237be-9821-4b95-9079-b77d935bbf01',
        tokenSha256: createHash('sha256').update(token).digest('hex'),
        clientCidrs: ['127.0.0.1/32'],
        grants: ['read'],
      }],
    }))
    for (let attempt = 0; attempt < 5; attempt += 1) {
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
        new Promise<never>((_, rejectReady) => { timeout = setTimeout(() => rejectReady(new Error(`server did not become ready: ${stderr}`)), 10_000) }),
      ]).finally(() => { if (timeout) clearTimeout(timeout) })
      const event = JSON.parse(ready) as { event: string; host: string; port: number; resource: string }
      assert.deepEqual(event, { event: 'ready', host: '127.0.0.1', port: event.port, resource: 'https://search.example.test/mcp/search' })
      assert.ok(Number.isInteger(event.port) && event.port > 0)
      assert.equal(stderr, '')
      child.kill('SIGTERM')
      const [exitCode, exitSignal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
      if (process.platform === 'win32') assert.equal(exitSignal, 'SIGTERM', stderr)
      else assert.equal(exitCode, 0, stderr)
      assert.match(stdout, /"event":"ready"/u)
      child = undefined
    }
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await Promise.race([once(child, 'exit'), new Promise((resolveWait) => setTimeout(resolveWait, 2_000))])
    }
    await rm(root, { recursive: true, force: true })
  }
})
