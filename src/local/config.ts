import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseRuntimeConfig, type RuntimeConfig } from '../runtime/config.js'

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
export const LOCAL_PRIVACY_EXCLUSIONS = Object.freeze([...new Set([
  '**/.codex/**', '**/.config/**', '**/.cursor/mcp.json', '**/.cursor/settings.json', '**/.cursor/extensions.json',
  '**/.azure/**', '**/.kube/**', '**/.gnupg/**', '**/.npm/**', '**/.ssh/**', '**/.aws/**', '**/.credentials/**',
  '**/.claude/**', '**/.continue/**', '**/.zed/**', '**/.aider/**',
  '**/mcp.json', '**/auth.json', '**/.env*', '**/.gitconfig', '**/.netrc', '**/.npmrc', '**/.pypirc',
  '**/known_hosts', '**/authorized_keys', '**/id_rsa', '**/id_ed25519',
])])
export const LOCAL_MAX_USER_EXCLUSIONS = 128 - LOCAL_PRIVACY_EXCLUSIONS.length

const LocalConfigSchema = z.object({
  schemaVersion: z.literal(1),
  clientId: uuid,
  stateDir: z.string().min(1).max(4_096).refine(isAbsolute),
  excludedPaths: z.array(z.string().min(1).max(512)).max(LOCAL_MAX_USER_EXCLUSIONS).optional(),
  runtime: z.record(z.string(), z.unknown()).optional(),
}).strict()

export class LocalConfigError extends Error {
  constructor(readonly code: 'LOCAL_CONFIG_INVALID' | 'LOCAL_SECRET_UNAVAILABLE') {
    super(`Local Search configuration error: ${code}`)
    this.name = 'LocalConfigError'
  }
}

export interface ParsedLocalConfig {
  readonly clientId: string
  readonly stateDir: string
  readonly excludedPaths?: readonly string[]
  readonly runtimeConfig: RuntimeConfig
}

/** Parse local settings while replacing every caller-supplied root/data path with the current workspace. */
export function parseLocalConfig(
  input: unknown,
  workspacePath: string,
  dataDir: string,
): ParsedLocalConfig {
  const local = LocalConfigSchema.safeParse(input)
  if (!local.success) throw new LocalConfigError('LOCAL_CONFIG_INVALID')
  if (local.data.runtime && ['version', 'roots', 'dataDir'].some((key) => Object.hasOwn(local.data.runtime!, key)))
    throw new LocalConfigError('LOCAL_CONFIG_INVALID')

  const runtimeInput = {
    ...(local.data.runtime ?? {}),
    version: 1,
    dataDir,
    roots: [{
      id: 'workspace',
      path: workspacePath,
      label: 'Current workspace',
      watch: false,
      exclude: [...new Set([...LOCAL_PRIVACY_EXCLUSIONS, ...(local.data.excludedPaths ?? [])])],
    }],
  }
  try {
    const runtimeConfig = parseRuntimeConfig(runtimeInput)
    if (runtimeConfig.roots.length !== 1 || runtimeConfig.roots[0]?.id !== 'workspace' || runtimeConfig.roots[0]?.path !== workspacePath || runtimeConfig.roots[0]?.watch !== false || runtimeConfig.dataDir !== dataDir)
      throw new LocalConfigError('LOCAL_CONFIG_INVALID')
    return Object.freeze({
      clientId: local.data.clientId,
      stateDir: local.data.stateDir,
      ...(local.data.excludedPaths ? { excludedPaths: Object.freeze([...local.data.excludedPaths]) } : {}),
      runtimeConfig,
    })
  } catch (error) {
    if (error instanceof LocalConfigError) throw error
    throw new LocalConfigError('LOCAL_CONFIG_INVALID')
  }
}

export function localConfigFingerprint(parsed: ParsedLocalConfig, configDir: string): string {
  // Runtime config contains secret references (never resolved credentials). The
  // file-reference base directory is part of the binding because it changes
  // which private secrets.json is used.
  const normalized = JSON.stringify({ clientId: parsed.clientId, stateDir: parsed.stateDir, runtimeConfig: parsed.runtimeConfig, configDir })
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}
