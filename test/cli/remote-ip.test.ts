import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { existsSync } from 'node:fs'

const entry = resolve('dist/cli/entry.js')
const canRunBuilt = existsSync(entry)

test('serve-remote-ip starts from config and policy, emits readiness, and closes on SIGTERM', { timeout: 30_000, skip: !canRunBuilt ? 'Run pnpm build before built CLI checks.' : process.platform === 'win32' ? 'SIGTERM lifecycle fixture is POSIX-specific.' : false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-remote-ip-cli-'))
  const root = join(dir, 'root')
  const state = join(dir, 'state')
  const config = join(dir, 'config.json')
  const policy = join(dir, 'policy.json')
  await Promise.all([mkdir(root), mkdir(state)])
  await writeFile(config, JSON.stringify({ version: 1, dataDir: state, roots: [{ id: 'repo', path: root }] }))
  await writeFile(policy, JSON.stringify({
    resource: 'https://startzorya.com/mcp/search', allowedHosts: ['startzorya.com'], allowedCidrs: ['127.0.0.0/8'], trustedProxyCidrs: [],
    allowedOrigins: ['https://chat.example'], principalId: 'cli-client', rootIds: ['repo'], operations: ['read'],
  }))
  const child = spawn(process.execPath, [entry, 'serve-remote-ip', '--config', config, '--policy', policy], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const closed = new Promise<void>((resolvePromise) => child.once('close', () => resolvePromise()))
  let output = ''
  let errors = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { errors += chunk })
  try {
    const deadline = Date.now() + 15_000
    while (!output.includes('"event":"ready"') && Date.now() < deadline && child.exitCode === null)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
    assert.equal(child.exitCode, null, errors)
    const ready = JSON.parse(output.trim().split('\n')[0]!) as { event: string; host: string; port: number; resource: string }
    assert.equal(ready.event, 'ready')
    assert.equal(ready.host, '127.0.0.1')
    assert.equal(ready.resource, 'https://startzorya.com/mcp/search')
    assert.ok(ready.port > 0)
    child.kill('SIGTERM')
    await new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error('CLI_SHUTDOWN_TIMEOUT')), 10_000)
      void closed.then(() => { clearTimeout(timeout); resolvePromise() })
    })
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
    await rm(dir, { recursive: true, force: true })
  }
})

test('serve-remote-ip rejects a malformed policy before opening runtime', { skip: !canRunBuilt ? 'Run pnpm build before built CLI checks.' : false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-remote-ip-invalid-'))
  const root = join(dir, 'root')
  const state = join(dir, 'state')
  const config = join(dir, 'config.json')
  const policy = join(dir, 'policy.json')
  await Promise.all([mkdir(root), mkdir(state)])
  await writeFile(config, JSON.stringify({ version: 1, dataDir: state, roots: [{ id: 'repo', path: root }] }))
  await writeFile(policy, JSON.stringify({
    resource: 'https://startzorya.com/mcp/search', allowedHosts: ['startzorya.com'], allowedCidrs: ['0.0.0.0/33'], trustedProxyCidrs: [],
    allowedOrigins: ['https://chat.example'], principalId: 'cli-client', rootIds: ['repo'], operations: ['read'],
  }))
  try {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [entry, 'serve-remote-ip', '--config', config, '--policy', policy], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
      child.once('error', reject)
      child.once('close', (code) => resolvePromise({ code, stderr }))
    })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /DAEMON_IP_POLICY_INVALID/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('serve-remote-ip requires resource to be explicit in policy', { skip: !canRunBuilt ? 'Run pnpm build before built CLI checks.' : false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-remote-ip-no-resource-'))
  const root = join(dir, 'root')
  const state = join(dir, 'state')
  const config = join(dir, 'config.json')
  const policy = join(dir, 'policy.json')
  await Promise.all([mkdir(root), mkdir(state)])
  await writeFile(config, JSON.stringify({ version: 1, dataDir: state, roots: [{ id: 'repo', path: root }] }))
  await writeFile(policy, JSON.stringify({
    allowedHosts: ['startzorya.com'], allowedCidrs: ['127.0.0.0/8'], trustedProxyCidrs: [],
    allowedOrigins: ['https://chat.example'], principalId: 'cli-client', rootIds: ['repo'], operations: ['read'],
  }))
  try {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [entry, 'serve-remote-ip', '--config', config, '--policy', policy], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
      child.once('error', reject)
      child.once('close', (code) => resolvePromise({ code, stderr }))
    })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /DAEMON_IP_POLICY_INVALID/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
