#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isSameOrDescendantPath } from '../runtime/path.js'
import { LocalConfigError } from './config.js'
import { loadLocalConfigFile } from './config-file.js'
import { LocalWorkspaceError, canonicalCurrentWorkspace, openLocalWorkspace } from './owner.js'
import type { LocalWorkspaceOptions } from './owner.js'
import { startLocalOwnerHttp } from './transport.js'

function configArgument(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== '--config' || !args[1] || args[1]!.startsWith('-'))
    throw new LocalConfigError('LOCAL_CONFIG_INVALID')
  return resolve(args[1]!)
}

export interface LocalOwnerProcessTestOptions {
  /** Failure-injection seam for spawned-process lifecycle tests; never accepted from a user config. */
  openWorkspace?: (options: LocalWorkspaceOptions) => ReturnType<typeof openLocalWorkspace>
  startupCleanupExitMs?: number
}

function scheduleBoundedOwnerExit(delayMs: number): void {
  const grace = Math.max(100, Math.min(5_000, delayMs))
  setTimeout(() => process.exit(1), grace)
}

export async function runLocalOwnerProcess(
  args: readonly string[] = process.argv.slice(2),
  testOptions: LocalOwnerProcessTestOptions = {},
): Promise<void> {
  const input = await loadLocalConfigFile(configArgument(args))
  const current = await canonicalCurrentWorkspace()
  const configRealPath = await realpathSync(input.path)
  if (!isAbsolute(configRealPath) || isSameOrDescendantPath(current.canonicalPath, configRealPath) || isSameOrDescendantPath(configRealPath, current.canonicalPath))
    throw new LocalConfigError('LOCAL_CONFIG_INVALID')
  let resolveStop!: () => void
  const stop = new Promise<void>((resolvePromise) => { resolveStop = resolvePromise })
  const onSignal = () => resolveStop()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  let workspace: Awaited<ReturnType<typeof openLocalWorkspace>>
  try {
    workspace = await (testOptions.openWorkspace ?? openLocalWorkspace)({ config: input.value, configDir: input.configDir })
  } catch (error) {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    if (error instanceof LocalWorkspaceError && error.code === 'LOCAL_RUNTIME_CLOSE_FAILED') {
      // A failed runtime close keeps its lease and may keep event-loop handles
      // alive. Bound the owner process lifetime without deleting either lock.
      scheduleBoundedOwnerExit(testOptions.startupCleanupExitMs ?? 2_000)
    }
    throw error
  }
  let http: Awaited<ReturnType<typeof startLocalOwnerHttp>> | undefined
  try {
    http = await startLocalOwnerHttp(workspace, { onStop: resolveStop })
    await stop
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    try { await http?.close() } finally {
      try { await workspace.close() }
      catch (error) {
        if (error instanceof LocalWorkspaceError && error.code === 'LOCAL_RUNTIME_CLOSE_FAILED')
          scheduleBoundedOwnerExit(testOptions.startupCleanupExitMs ?? 2_000)
        throw error
      }
    }
  }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof LocalConfigError || error instanceof LocalWorkspaceError) return error.code
  return 'LOCAL_OWNER_START_FAILED'
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href : undefined
if (invokedPath === import.meta.url) {
  void runLocalOwnerProcess().catch((error: unknown) => {
    process.stderr.write(`zorya-search-local-owner: ${safeErrorCode(error)}\n`)
    process.exitCode = 1
  })
}
