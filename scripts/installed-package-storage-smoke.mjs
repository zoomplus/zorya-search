import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))
const consumer = mkdtempSync(join(tmpdir(), 'zorya-search-installed-storage-'))
const buildOutput = join(repository, 'dist')
const requiredStoragePackages = {
  '@electric-sql/pglite': '0.5.14',
  '@electric-sql/pglite-pgvector': '0.0.15',
  pg: '8.16.3',
}
let ownerMayBeRunning = false
let buildOutputOwned = false

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

function runCli(entry, args) {
  return execFileSync(process.execPath, [entry, ...args], {
    cwd: consumer,
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
  const appRoot = join(consumer, 'node_modules', 'zorya-search')
  const packageManifest = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'))
  const version = runCli(entry, ['--version']).trim()
  assert.equal(version, packageManifest.version)
  runCli(entry, ['--help'])
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
} finally {
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
  rmSync(consumer, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  if (buildOutputOwned)
    rmSync(buildOutput, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
