import assert from 'node:assert/strict'
import { access, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runLocalEntry } from '../../src/local/entry.js'

const roots: string[] = []

async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'zorya-local-entry-')))
  roots.push(parent)
  const project = join(parent, 'project')
  await mkdir(project)
  return { parent, project, configPath: join(parent, 'private', 'client.json') }
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = []
  const original = process.stdout.write
  process.stdout.write = ((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true }) as typeof process.stdout.write
  try { await run() } finally { process.stdout.write = original }
  return chunks.join('')
}

test.afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

test('setup creates a private external config once without starting an owner', async () => {
  const f = await fixture()
  const previous = process.cwd()
  const previousStateHome = process.env.XDG_STATE_HOME
  const previousLocalAppData = process.env.LOCALAPPDATA
  process.chdir(f.project)
  if (process.platform === 'win32') process.env.LOCALAPPDATA = join(f.parent, 'private-state-home')
  else process.env.XDG_STATE_HOME = join(f.parent, 'private-state-home')
  try {
    const output = await captureStdout(() => runLocalEntry(['setup', '--config', f.configPath]))
    assert.match(output, /Создана локальная конфигурация/u)
    const info = await lstat(f.configPath)
    assert.equal(info.isFile(), true)
    if (process.platform !== 'win32') assert.equal(info.mode & 0o077, 0)
    const config = JSON.parse(await readFile(f.configPath, 'utf8')) as Record<string, unknown>
    assert.equal(config.schemaVersion, 1)
    assert.match(String(config.clientId), /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    assert.equal(typeof config.stateDir, 'string')
    assert.equal(config.stateDir, process.platform === 'win32'
      ? join(f.parent, 'private-state-home', 'Zorya', 'Search', 'state')
      : join(f.parent, 'private-state-home', 'zorya-search-local'))
    await assert.rejects(() => access(String(config.stateDir)))
    assert.equal(Object.hasOwn(config, 'runtime'), false)
    await assert.rejects(() => runLocalEntry(['setup', '--config', f.configPath]))
    await assert.rejects(() => runLocalEntry(['setup', '--config', join(f.project, 'client.json')]))
  } finally {
    process.chdir(previous)
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousStateHome
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previousLocalAppData
  }
})

test('client-config emits pinned registry and installed descriptors without cwd or policy overrides', async () => {
  const f = await fixture()
  const previous = process.cwd()
  process.chdir(f.project)
  try {
    await runLocalEntry(['setup', '--config', f.configPath])
    const output = await captureStdout(() => runLocalEntry(['client-config', '--config', f.configPath]))
    const result = JSON.parse(output) as {
      generic: { mcpServers: Record<string, { command: string; args: string[] }> }
      installed: { command: string; args: string[]; startup_timeout_sec: number; tool_timeout_sec: number }
      codexToml: string
      codexInstalledToml: string
    }
    const generic = result.generic.mcpServers['zorya-search-local']!
    assert.equal(generic.command, 'npx')
    assert.deepEqual(generic.args, ['--yes', '--package', 'zorya-search@0.1.11', 'zorya-search-local', 'mcp', '--config', f.configPath])
    assert.deepEqual(Object.keys(generic).sort(), ['args', 'command'])
    assert.equal(result.installed.command, process.execPath)
    assert.equal(result.installed.args.at(-3), 'mcp')
    assert.equal(result.installed.args.at(-2), '--config')
    assert.equal(result.installed.args.at(-1), f.configPath)
    assert.equal(result.installed.startup_timeout_sec, 30)
    assert.equal(result.installed.tool_timeout_sec, 900)
    for (const descriptor of [result.generic, result.installed]) assert.equal(Object.hasOwn(descriptor, 'cwd'), false)
    assert.match(result.codexToml, /tool_timeout_sec = 900/u)
    assert.match(result.codexToml, /zorya-search@0\.1\.11/u)
    assert.match(result.codexInstalledToml, /startup_timeout_sec = 30/u)
    assert.doesNotMatch(output, /approval|sandbox|model|auto.?approve/iu)
  } finally { process.chdir(previous) }
})

test('doctor validates local config without creating an owner or database', async () => {
  const f = await fixture()
  const previous = process.cwd()
  process.chdir(f.project)
  try {
    await runLocalEntry(['setup', '--config', f.configPath])
    const config = JSON.parse(await readFile(f.configPath, 'utf8')) as Record<string, unknown>
    const stateDir = join(f.parent, 'doctor-state')
    config.stateDir = stateDir
    await writeFile(f.configPath, `${JSON.stringify(config)}\n`)
    await chmod(f.configPath, 0o600)
    const output = await captureStdout(() => runLocalEntry(['doctor', '--config', f.configPath]))
    const result = JSON.parse(output) as Record<string, unknown>
    assert.equal(result.status, 'ok')
    assert.equal(result.workspaceBound, true)
    assert.equal(result.workspacePath, await realpath(f.project))
    assert.equal(result.owner, 'missing')
    assert.equal(result.sourceIndexing, 'explicit-on-source-query')
    assert.equal(result.providerDefaults, 'none')
    await assert.rejects(() => access(stateDir))
  } finally { process.chdir(previous) }
})
