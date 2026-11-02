#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PACKAGE_VERSION } from '../package-version.js'
import { workspaceIdForCanonicalPath } from '../bridge/protocol.js'
import { LocalConfigError, parseLocalConfig } from './config.js'
import { canonicalCurrentWorkspace, defaultLocalStateDirectory, inspectLocalOwner, LocalWorkspaceError } from './owner.js'
import { createLocalConfigFile, loadLocalConfigFile } from './config-file.js'
import { runLocalMcpStdio, stopLocalOwner } from './stdio.js'

const helpText = `zorya-search-local ${PACKAGE_VERSION}

Usage:
  zorya-search-local setup --config PATH
  zorya-search-local mcp --config PATH
  zorya-search-local client-config --config PATH
  zorya-search-local doctor --config PATH
  zorya-search-local stop --config PATH
  zorya-search-local --help
  zorya-search-local --version
`

type ConfigCommand = 'setup' | 'mcp' | 'client-config' | 'doctor' | 'stop'

function parseConfigCommand(args: readonly string[]): { command: ConfigCommand; configPath: string } | undefined {
  const command = args[0]
  if (command !== 'setup' && command !== 'mcp' && command !== 'client-config' && command !== 'doctor' && command !== 'stop') return undefined
  if (args.length !== 3 || args[1] !== '--config' || !args[2] || args[2]!.startsWith('-'))
    throw new LocalConfigError('LOCAL_CONFIG_INVALID')
  return { command, configPath: args[2]! }
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function validateConfigForCurrentWorkspace(value: unknown, configPath?: string) {
  const current = await canonicalCurrentWorkspace()
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LocalConfigError('LOCAL_CONFIG_INVALID')
  const stateDir = (value as Record<string, unknown>).stateDir
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) throw new LocalConfigError('LOCAL_CONFIG_INVALID')
  const parsed = parseLocalConfig(value, current.canonicalPath, resolve(stateDir, '.validation-data'))
  if (isWithin(current.canonicalPath, parsed.stateDir) || isWithin(parsed.stateDir, current.canonicalPath))
    throw new LocalConfigError('LOCAL_CONFIG_INVALID')
  if (configPath && (isWithin(parsed.stateDir, configPath) || isWithin(dirname(configPath), parsed.stateDir)))
    throw new LocalConfigError('LOCAL_CONFIG_INVALID')
  return { current, parsed }
}

function clientConfiguration(configPath: string) {
  const args = ['mcp', '--config', configPath]
  const installedArgs = [fileURLToPath(import.meta.url), ...args]
  const registryArgs = ['--yes', '--package', `zorya-search@${PACKAGE_VERSION}`, 'zorya-search-local', ...args]
  const quote = (value: string) => JSON.stringify(value)
  const toml = (command: string, values: readonly string[]) => [
    '[mcp_servers.zorya-search-local]',
    `command = ${quote(command)}`,
    `args = [${values.map(quote).join(', ')}]`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 900',
    '',
  ].join('\n')
  return {
    generic: { mcpServers: { 'zorya-search-local': { command: 'npx', args: registryArgs } } },
    installed: { command: process.execPath, args: installedArgs, startup_timeout_sec: 30, tool_timeout_sec: 900 },
    codexToml: toml('npx', registryArgs),
    codexInstalledToml: toml(process.execPath, installedArgs),
  }
}

async function setup(configPath: string): Promise<void> {
  const current = await canonicalCurrentWorkspace()
  const absoluteConfig = resolve(configPath)
  const stateDir = resolve(defaultLocalStateDirectory())
  if (isWithin(current.canonicalPath, absoluteConfig) || isWithin(absoluteConfig, current.canonicalPath) ||
    isWithin(current.canonicalPath, stateDir) || isWithin(stateDir, current.canonicalPath) ||
    isWithin(stateDir, absoluteConfig) || isWithin(dirname(absoluteConfig), stateDir))
    throw new LocalConfigError('LOCAL_CONFIG_INVALID')
  const config = { schemaVersion: 1, clientId: randomUUID(), stateDir }
  const created = await createLocalConfigFile(absoluteConfig, config)
  process.stdout.write(`Создана локальная конфигурация: ${created}\n`)
  process.stdout.write('Добавьте MCP команду из client-config; при запросе по исходникам индекс обновится по текущим локальным файлам.\n')
}

async function printClientConfig(configPath: string): Promise<void> {
  const loaded = await loadLocalConfigFile(configPath)
  await validateConfigForCurrentWorkspace(loaded.value, loaded.path)
  process.stdout.write(`${JSON.stringify(clientConfiguration(loaded.path), null, 2)}\n`)
}

async function doctor(configPath: string): Promise<void> {
  const loaded = await loadLocalConfigFile(configPath)
  const { current, parsed } = await validateConfigForCurrentWorkspace(loaded.value, loaded.path)
  const owner = await inspectLocalOwner(loaded.value, loaded.configDir)
  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    workspaceBound: true,
    workspacePath: current.canonicalPath,
    workspaceId: workspaceIdForCanonicalPath(parsed.clientId, current.canonicalPath),
    stateDir: parsed.stateDir,
    owner: owner.state,
    sourceIndexing: 'explicit-on-source-query',
    providerDefaults: 'none',
  }, null, 2)}\n`)
}

export async function runLocalEntry(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(helpText); return }
  if (args.length === 1 && args[0] === '--version') { process.stdout.write(`${PACKAGE_VERSION}\n`); return }
  const parsed = parseConfigCommand(args)
  if (!parsed) throw new LocalConfigError('LOCAL_CONFIG_INVALID')
  if (parsed.command === 'setup') return setup(parsed.configPath)
  if (parsed.command === 'client-config') return printClientConfig(parsed.configPath)
  if (parsed.command === 'doctor') return doctor(parsed.configPath)
  if (parsed.command === 'stop') return stopLocalOwner(parsed.configPath)
  const handle = await runLocalMcpStdio(parsed.configPath)
  await new Promise<void>((resolveStop) => {
    let closing: Promise<void> | undefined
    const close = () => {
      if (!closing) closing = handle.close().finally(resolveStop)
      return closing
    }
    const onSignal = () => { void close() }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    handle.transport.onclose = () => { void close() }
    process.stdin.once('end', onSignal)
    process.stdin.once('close', onSignal)
  })
}

function safeErrorCode(error: unknown): string {
  if (error instanceof LocalConfigError || error instanceof LocalWorkspaceError) return error.code
  return 'LOCAL_OPERATION_FAILED'
}

function safeErrorHint(code: string): string {
  switch (code) {
    case 'LOCAL_WORKSPACE_UNRESOLVED': return 'Не удалось определить текущую папку проекта; запустите Codex с выбранной рабочей папкой.'
    case 'LOCAL_WORKSPACE_CHANGED': return 'Рабочая папка изменилась во время запроса; повторите вызов из исходной папки.'
    case 'LOCAL_PROFILE_MISMATCH': return 'Настройки локального владельца отличаются от конфигурации; выполните stop, затем снова запустите MCP.'
    case 'LOCAL_STATE_INVALID': return 'Каталог локального состояния недоступен или небезопасен; проверьте права и путь.'
    case 'LOCAL_CONFIG_INVALID': return 'Укажите существующий приватный JSON конфиг; для нового конфига выполните setup --config PATH.'
    default: return 'Операция локального Search не выполнена; проверьте конфигурацию и права доступа.'
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href : undefined
if (invokedPath === import.meta.url) {
  void runLocalEntry().catch((error: unknown) => {
    const code = safeErrorCode(error)
    process.stderr.write(`zorya-search-local: ${code}: ${safeErrorHint(code)}\n`)
    process.exitCode = 1
  })
}
