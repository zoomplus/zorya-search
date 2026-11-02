#!/usr/bin/env node
import { constants } from 'node:fs'
import { open, realpathSync } from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createBridgeHttpClient } from './client.js'
import { parseBridgeClientConfig } from './config.js'
import { runBridgeMcpStdio } from './mcp.js'
import { BridgeContractError } from './protocol.js'
import { PACKAGE_VERSION } from '../package-version.js'

const maxConfigBytes = 1_000_000
const helpText = `zorya-search-bridge ${PACKAGE_VERSION}

Usage:
  zorya-search-bridge mcp --config PATH
  zorya-search-bridge client-config --config PATH
  zorya-search-bridge serve --config PATH
  zorya-search-bridge --help
  zorya-search-bridge --version
`

type Command = 'mcp' | 'client-config' | 'serve'

function parseArgs(args: readonly string[]): { command?: Command; configPath?: string; help?: boolean; version?: boolean } {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  if (args.length === 1 && args[0] === '--version') return { version: true }
  const command = args[0]
  if (command !== 'mcp' && command !== 'client-config' && command !== 'serve')
    throw new BridgeContractError('INVALID_REQUEST')
  if (args.length !== 3 || args[1] !== '--config' || !args[2] || args[2]!.startsWith('-'))
    throw new BridgeContractError('CONFIG_INVALID')
  return { command, configPath: args[2] }
}

async function readConfigFile(configPath: string): Promise<{ path: string; value: unknown }> {
  const path = resolve(configPath)
  let handle: Awaited<ReturnType<typeof openFile>> | undefined
  try {
    handle = await openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const info = await handle.stat()
    if (!info.isFile() || info.size < 1 || info.size > maxConfigBytes) throw new BridgeContractError('CONFIG_INVALID')
    const bytes = await handle.readFile()
    if (bytes.byteLength > maxConfigBytes) throw new BridgeContractError('CONFIG_INVALID')
    const text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new BridgeContractError('CONFIG_INVALID')
    try { return { path, value: JSON.parse(text) as unknown } } catch { throw new BridgeContractError('CONFIG_INVALID') }
  } catch (error) {
    if (error instanceof BridgeContractError) throw error
    throw new BridgeContractError('CONFIG_INVALID')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function quoteToml(value: string): string { return JSON.stringify(value) }

function clientConfiguration(configPath: string, config: Awaited<ReturnType<typeof parseBridgeClientConfig>>) {
  const registryArgs = [
    '--yes', '--package', `zorya-search@${PACKAGE_VERSION}`,
    'zorya-search-bridge', 'mcp', '--config', configPath,
  ]
  const installedArgs = [fileURLToPath(import.meta.url), 'mcp', '--config', configPath]
  const generic = {
    mcpServers: {
      'zorya-search-bridge': {
        command: 'npx',
        args: registryArgs,
        startup_timeout_sec: 30,
        tool_timeout_sec: 900,
      },
    },
  }
  const envVars = config.credential.kind === 'env' ? [config.credential.name] : []
  const toml = (command: string, args: readonly string[]) => [
    '[mcp_servers.zorya-search-bridge]',
    `command = ${quoteToml(command)}`,
    `args = [${args.map(quoteToml).join(', ')}]`,
    ...(envVars.length ? [`env_vars = [${envVars.map(quoteToml).join(', ')}]`] : []),
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 900',
    '',
  ].join('\n')
  const installed = { command: process.execPath, args: installedArgs, startup_timeout_sec: 30, tool_timeout_sec: 900 }
  return {
    generic,
    installed,
    codexToml: toml('npx', registryArgs),
    codexInstalledToml: toml(process.execPath, installedArgs),
  }
}

async function waitForTermination(close: () => Promise<void>, closeOnStdinEnd = false): Promise<void> {
  await new Promise<void>((resolveWait, rejectWait) => {
    let closing = false
    const finish = (signal?: NodeJS.Signals) => {
      if (closing) return
      closing = true
      if (signal) process.stderr.write(`zorya-search-bridge: stopping (${signal})\n`)
      void close().then(resolveWait, rejectWait)
    }
    const onInterrupt = () => finish('SIGINT')
    const onTerminate = () => finish('SIGTERM')
    process.once('SIGINT', onInterrupt)
    process.once('SIGTERM', onTerminate)
    if (closeOnStdinEnd) {
      process.stdin.once('end', () => finish())
      process.stdin.once('close', () => finish())
    }
  })
}

async function runMcp(configPath: string): Promise<void> {
  const input = await readConfigFile(configPath)
  const config = await parseBridgeClientConfig(input.value, { cwd: process.cwd() })
  const client = await createBridgeHttpClient({
    config,
    ...(config.allowedDocumentPaths ? { allowedDocumentPaths: config.allowedDocumentPaths } : {}),
  })
  const handle = await runBridgeMcpStdio({
    client,
    clientInstanceId: config.clientId,
    ...(config.allowedDocumentPaths ? { allowedDocumentPaths: config.allowedDocumentPaths } : {}),
    ...(config.excludedPaths ? { exclude: [...config.excludedPaths] } : {}),
  })
  await waitForTermination(() => handle.close(), true)
}

async function runServe(configPath: string): Promise<void> {
  const input = await readConfigFile(configPath)
  const { parseBridgeServerConfig } = await import('./config.js')
  const config = await parseBridgeServerConfig(input.value)
  const { createBridgeServer } = await import('./server.js')
  const server = await createBridgeServer(config)
  const termination = waitForTermination(() => server.close())
  process.stdout.write(`${JSON.stringify({ event: 'ready', host: server.address.address, port: server.address.port, resource: config.resource })}\n`)
  await termination
}

export async function runBridgeEntry(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(args)
  if (parsed.help) { process.stdout.write(helpText); return }
  if (parsed.version) { process.stdout.write(`${PACKAGE_VERSION}\n`); return }
  const configPath = parsed.configPath!
  if (parsed.command === 'client-config') {
    const input = await readConfigFile(configPath)
    const config = await parseBridgeClientConfig(input.value, { cwd: process.cwd() })
    process.stdout.write(`${JSON.stringify(clientConfiguration(input.path, config), null, 2)}\n`)
    return
  }
  if (parsed.command === 'mcp') return runMcp(configPath)
  return runServe(configPath)
}

function safeErrorCode(error: unknown): string {
  if (error instanceof BridgeContractError) return error.code
  return 'OPERATION_FAILED'
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href : undefined
if (invokedPath === import.meta.url) {
  void runBridgeEntry().catch((error: unknown) => {
    process.stderr.write(`zorya-search-bridge: ${safeErrorCode(error)}\n`)
    process.exitCode = 1
  })
}
