import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const consumer = mkdtempSync(join(tmpdir(), 'zorya-search-installed-storage-'))
const buildOutput = join(repository, 'dist')
const requiredStoragePackages = {
  '@electric-sql/pglite': '0.5.14',
  '@electric-sql/pglite-pgvector': '0.0.15',
  pg: '8.16.3',
}
let ownerMayBeRunning = false
let localOwnerMayBeRunning = false
let buildOutputOwned = false
let preserveConsumer = false

function findNpmCli() {
  const candidates = [process.env.npm_execpath]
  for (const pathEntry of (process.env.PATH ?? '').split(delimiter)) {
    if (!pathEntry) continue
    const command = join(pathEntry, process.platform === 'win32' ? 'npm.cmd' : 'npm')
    if (existsSync(command)) {
      try {
        candidates.push(realpathSync(command))
      } catch {
        candidates.push(command)
      }
      candidates.push(join(pathEntry, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    }
  }
  const executableDir = dirname(process.execPath)
  candidates.push(join(executableDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  for (const candidate of candidates) {
    if (candidate && /(?:^|[\\/])npm-cli\.js$/iu.test(candidate) && existsSync(candidate))
      return candidate
  }
  throw new Error('NPM_CLI_NOT_FOUND')
}
const npmCli = findNpmCli()

function runNpm(args) {
  execFileSync(process.execPath, [npmCli, ...args], {
    cwd: consumer,
    stdio: 'inherit',
  })
}

function runCli(entry, args, cwd = consumer) {
  return execFileSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
}

function stopOwnedService(entry, config) {
  const stopped = JSON.parse(runCli(entry, ['service', '--stop', '--config', config]))
  assert.equal(stopped.stopped, true, 'the owned local service must confirm shutdown')
  ownerMayBeRunning = false
}

function assertStoragePackagesAreRegularDependencies() {
  const appRoot = join(consumer, 'node_modules', 'zorya-search')
  const manifest = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'))
  const sourceManifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'zorya-search')
  assert.equal(manifest.version, sourceManifest.version)
  const requireFromSearch = createRequire(join(appRoot, 'package.json'))
  for (const [name, version] of Object.entries(requiredStoragePackages)) {
    assert.equal(manifest.dependencies?.[name], version, `${name} must be pinned as a regular dependency`)
    assert.equal(manifest.optionalDependencies?.[name], undefined, `${name} must not be optional`)
    assert.doesNotThrow(() => requireFromSearch.resolve(name), `${name} must be installed`)
  }
  assert.equal(manifest.optionalDependencies?.['pdfjs-dist'], '5.4.624')
}

try {
  if (existsSync(join(repository, 'dist')))
    throw new Error('installed-package smoke requires a clean source tree without dist')
  buildOutputOwned = true

  writeFileSync(
    join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'zorya-search-install-smoke', private: true }, null, 2)}\n`,
  )
  const pack = JSON.parse(
    execFileSync(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', consumer], {
      cwd: repository,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  )
  assert.equal(pack.length, 1)
  const archive = join(consumer, pack[0].filename)

  runNpm(['install', '--save-exact', archive, '--no-audit', '--no-fund'])
  runNpm(['install', '--no-audit', '--no-fund'])
  assertStoragePackagesAreRegularDependencies()

  const entry = join(consumer, 'node_modules', 'zorya-search', 'dist', 'cli', 'entry.js')
  const bridgeEntry = join(consumer, 'node_modules', 'zorya-search', 'dist', 'bridge', 'entry.js')
  const localEntry = join(consumer, 'node_modules', 'zorya-search', 'dist', 'local', 'entry.js')
  const appRoot = join(consumer, 'node_modules', 'zorya-search')
  const packageManifest = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'))
  assert.equal(packageManifest.bin?.['zorya-search-bridge'], './dist/bridge/entry.js')
  assert.equal(packageManifest.bin?.['zorya-search-local'], './dist/local/entry.js')
  for (const path of ['docs/local-workspace.md', 'docs/install-local-agent.md'])
    assert.ok(existsSync(join(appRoot, path)), `${path} must be included in the packed package`)
  for (const path of ['dist/bridge/entry.js', 'dist/bridge/client-api.js', 'dist/bridge/server-api.js'])
    assert.ok(existsSync(join(appRoot, path)), `${path} must be included in the packed package`)
  for (const path of ['dist/bridge/client-api.js', 'dist/bridge/server-api.js'])
    assert.equal(packageManifest.exports?.[`./bridge/${path.includes('client-api') ? 'client' : 'server'}`]?.import, `./${path}`)
  const version = runCli(entry, ['--version']).trim()
  assert.equal(version, packageManifest.version)
  runCli(entry, ['--help'])
  assert.equal(runCli(bridgeEntry, ['--version']).trim(), packageManifest.version)
  runCli(bridgeEntry, ['--help'])
  const bridgeBin = join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'zorya-search-bridge.cmd' : 'zorya-search-bridge')
  assert.ok(existsSync(bridgeBin), 'npm must install the bridge binary link')
  assert.equal(execFileSync(process.execPath, [npmCli, 'exec', '--offline', '--no', '--', 'zorya-search-bridge', '--version'], {
    cwd: consumer,
    encoding: 'utf8',
  }).trim(), packageManifest.version)
  assert.equal(execFileSync(process.execPath, [npmCli, 'exec', '--offline', '--no', '--', 'zorya-search-local', '--version'], {
    cwd: consumer,
    encoding: 'utf8',
  }).trim(), packageManifest.version)
  assert.equal(runCli(localEntry, ['--version']).trim(), packageManifest.version)
  runCli(localEntry, ['--help'])
  const clientConfig = JSON.parse(runCli(entry, ['client-config']))
  assert.equal(clientConfig.registry.command, 'npx')
  assert.deepEqual(clientConfig.registry.args, [
    '--yes',
    `zorya-search@${packageManifest.version}`,
    'mcp',
    '--config',
    clientConfig.configPath,
  ])
  assert.equal(clientConfig.registry.args.includes('--result-presentation'), false)
  assert.deepEqual(clientConfig.registryCodex.args.slice(-6), [
    'npx',
    '--yes',
    `zorya-search@${packageManifest.version}`,
    'mcp',
    '--config',
    clientConfig.configPath,
  ])
  const structuredClientConfig = JSON.parse(
    runCli(entry, ['client-config', '--result-presentation', 'structured']),
  )
  assert.deepEqual(structuredClientConfig.registry.args, [
    '--yes',
    `zorya-search@${packageManifest.version}`,
    'mcp',
    '--config',
    structuredClientConfig.configPath,
    '--result-presentation',
    'structured',
  ])
  const publicImports = [
    'zorya-search',
    'zorya-search/code',
    'zorya-search/project-text',
    'zorya-search/providers',
    'zorya-search/context',
    'zorya-search/context/web',
    'zorya-search/context/classify',
    'zorya-search/visual',
    'zorya-search/runtime',
    'zorya-search/mcp',
    'zorya-search/bridge/client',
    'zorya-search/bridge/server',
    'zorya-search/daemon',
  ]
  assert.deepEqual(
    [...publicImports].sort(),
    Object.keys(packageManifest.exports)
      .map((path) => path === '.' ? 'zorya-search' : `zorya-search${path.slice(1)}`)
      .sort(),
  )
  const importExpression = `for (const name of ${JSON.stringify(publicImports)}) await import(name)`
  execFileSync(process.execPath, ['--input-type=module', '-e', importExpression], {
    cwd: consumer,
    stdio: 'inherit',
  })
  const clientIsolationLoader = join(consumer, 'client-import-guard.mjs')
  writeFileSync(clientIsolationLoader, `export async function resolve(specifier, context, nextResolve) {
    if (/(?:\\/storage\\/|\\/providers\\/|\\/runtime\\/index\\.js$|^pg$|^@electric-sql\\/pglite(?:-pgvector)?$)/u.test(specifier))
      throw new Error('BRIDGE_CLIENT_IMPORTED_STORAGE_OR_PROVIDER')
    return nextResolve(specifier, context)
  }\n`)
  execFileSync(process.execPath, ['--experimental-loader', pathToFileURL(clientIsolationLoader).href, '--input-type=module', '-e', "await import('zorya-search/bridge/client')"], {
    cwd: consumer,
    stdio: 'inherit',
  })

  const root = join(consumer, 'fixture')
  const data = join(consumer, 'data')
  const config = join(consumer, 'runtime.json')
  mkdirSync(root)
  writeFileSync(
    join(root, 'install-smoke.ts'),
    'export const installSmokeNeedle = "zorya-install-smoke-needle"\n',
  )
  runCli(entry, ['setup', '--root', root, '--data', data, '--config', config])

  const exerciseInstalledStorage = () => {
    ownerMayBeRunning = true
    runCli(entry, ['index', '--config', config])
    const output = runCli(entry, [
      'search',
      '--config',
      config,
      '--mode',
      'lexical',
      '--query',
      'zorya-install-smoke-needle',
    ])
    const result = JSON.parse(output)
    assert.equal(result.structuredContent?.hits?.[0]?.path, 'install-smoke.ts')
    assert.equal(result.structuredContent?.hits?.[0]?.symbol, 'installSmokeNeedle')
    stopOwnedService(entry, config)
  }

  runNpm(['ci', '--no-audit', '--no-fund'])
  assertStoragePackagesAreRegularDependencies()
  exerciseInstalledStorage()

  runNpm(['ci', '--omit=optional', '--no-audit', '--no-fund'])
  assertStoragePackagesAreRegularDependencies()
  exerciseInstalledStorage()

  const localRoot = join(consumer, 'local-workspace')
  const localConfigDir = join(consumer, 'local-config')
  const localConfig = join(localConfigDir, 'client.json')
  const localState = join(consumer, 'local-state')
  mkdirSync(localRoot)
  mkdirSync(localConfigDir, { mode: 0o700 })
  const localSource = 'export const localSmokeNeedle = "zorya-installed-local-smoke-needle"\n'
  writeFileSync(join(localRoot, 'local-smoke.ts'), localSource)
  runCli(localEntry, ['setup', '--config', localConfig], localRoot)
  const localSettings = JSON.parse(readFileSync(localConfig, 'utf8'))
  localSettings.stateDir = localState
  writeFileSync(localConfig, `${JSON.stringify(localSettings)}\n`)
  chmodSync(localConfig, 0o600)
  assert.equal(JSON.parse(runCli(localEntry, ['doctor', '--config', localConfig], localRoot)).owner, 'missing')
  const localDescriptors = JSON.parse(runCli(localEntry, ['client-config', '--config', localConfig], localRoot))
  assert.equal(localDescriptors.generic.mcpServers['zorya-search-local'].args.at(-3), 'mcp')
  assert.equal(localDescriptors.generic.mcpServers['zorya-search-local'].args.at(-2), '--config')
  assert.equal(localDescriptors.generic.mcpServers['zorya-search-local'].args.at(-1), localConfig)

  const requireInstalled = createRequire(join(appRoot, 'package.json'))
  const [installedClient, installedStdio] = await Promise.all([
    import(pathToFileURL(requireInstalled.resolve('@modelcontextprotocol/client')).href),
    import(pathToFileURL(requireInstalled.resolve('@modelcontextprotocol/client/stdio')).href),
  ])
  const LocalClient = installedClient.Client
  const StdioClientTransport = installedStdio.StdioClientTransport
  const localClient = new LocalClient({ name: 'zorya-installed-local-smoke', version: packageManifest.version })
  const localTransport = new StdioClientTransport({
    command: process.execPath,
    args: [localEntry, 'mcp', '--config', localConfig],
    cwd: localRoot,
    env: { ...process.env },
    stderr: 'pipe',
  })
  let localStderr = ''
  localTransport.stderr?.setEncoding('utf8').on('data', (chunk) => { localStderr += chunk })
  try {
    localOwnerMayBeRunning = true
    await localClient.connect(localTransport)
    const conversationId = randomUUID()
    const nativeMeta = { 'x-codex-turn-metadata': { thread_id: conversationId }, threadId: conversationId }
    const capabilities = await localClient.callTool({ name: 'capabilities', arguments: {}, _meta: nativeMeta })
    assert.equal(capabilities.isError, undefined, localStderr)
    const searched = await localClient.callTool({
      name: 'search_code',
      arguments: { rootId: 'workspace', query: 'zorya-installed-local-smoke-needle', mode: 'lexical' },
      _meta: nativeMeta,
    })
    assert.equal(searched.isError, undefined, localStderr)
    const searchData = searched.structuredContent
    assert.equal(searchData.hits?.[0]?.path, 'local-smoke.ts')
    const snapshotId = searchData.identity?.snapshotId
    assert.equal(typeof snapshotId, 'string')
    const read = await localClient.callTool({
      name: 'read_source',
      arguments: { rootId: 'workspace', path: 'local-smoke.ts', snapshotId },
      _meta: nativeMeta,
    })
    assert.equal(read.isError, undefined, localStderr)
    assert.equal(read.structuredContent.text, localSource)
    assert.equal(read.structuredContent.contentHash, createHash('sha256').update(localSource, 'utf8').digest('hex'))
    assert.equal(read.structuredContent.snapshotId, snapshotId)
    assert.equal(read._meta['zorya-search/local'].conversationId, conversationId)
    assert.equal(read._meta['zorya-search/local'].origin, 'current_local_workspace')
  } finally {
    await localClient.close().catch(() => undefined)
  }
  runCli(localEntry, ['stop', '--config', localConfig], localRoot)
  localOwnerMayBeRunning = false
} finally {
  if (localOwnerMayBeRunning) {
    const localEntry = join(consumer, 'node_modules', 'zorya-search', 'dist', 'local', 'entry.js')
    try {
      runCli(localEntry, ['stop', '--config', join(consumer, 'local-config', 'client.json')], join(consumer, 'local-workspace'))
      localOwnerMayBeRunning = false
    } catch (error) {
      preserveConsumer = true
      console.error(`Smoke local owner shutdown was not confirmed; retaining ${consumer}`)
      throw new Error(`SMOKE_LOCAL_OWNER_SHUTDOWN_UNCONFIRMED:${consumer}`, { cause: error })
    }
  }
  if (ownerMayBeRunning) {
    const installedEntry = join(consumer, 'node_modules', 'zorya-search', 'dist', 'cli', 'entry.js')
    try {
      stopOwnedService(installedEntry, join(consumer, 'runtime.json'))
    } catch (error) {
      console.error(`Smoke service shutdown was not confirmed; retaining ${consumer}`)
      if (buildOutputOwned)
        rmSync(buildOutput, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      throw new Error(`SMOKE_SERVICE_SHUTDOWN_UNCONFIRMED:${consumer}`, { cause: error })
    }
  }
  if (!preserveConsumer) rmSync(consumer, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  if (buildOutputOwned)
    rmSync(buildOutput, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
