import { createHash, randomUUID } from 'node:crypto'
import { lstat, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseRuntimeConfig } from '../runtime/config.js'
import { PROJECT_TEXT_RETRIEVAL_PRESET } from '../providers/voyage.js'
import { JEV_DECISIONS_MODEL } from '../providers/decisions.js'
import { SEARCH_SETUP_CAPABILITIES, type SearchSetupCapability } from '../mcp/setup-guidance.js'
import { canonicalConfigPath, readPrivateFile, writePrivateFile } from './files.js'
import { ensureOwner, serviceStatus, stopOwner, withOwnerStartupLock } from './service.js'
import { confirmWatchedIndexing, readHiddenSecret } from './configure-terminal.js'

const envName = /^[A-Z_][A-Z0-9_]{0,127}$/
const reusePaths = [
  'mechanism.code.secret', 'mechanism.visual.secret', 'web.discovery.secret',
  'embedding.secret', 'web.embedding.secret', 'projectText.embedding.secret',
  'projectText.reranker.secret', 'classifier.secret', 'reranker.secret',
] as const
type SecretRef = { kind: 'env'; name: string } | { kind: 'file'; file: 'secrets.json'; key: string }

export interface ConfigureOptions {
  configPath: string
  capability: string
  secretEnv?: string
  reuseSecretRef?: string
  allowIndexing?: boolean
}

export interface ConfigureDependencies {
  status?: typeof serviceStatus
  stop?: typeof stopOwner
  restart?: typeof ensureOwner
}

export async function configureSearchCapability(options: ConfigureOptions, dependencies: ConfigureDependencies = {}) {
  if (!SEARCH_SETUP_CAPABILITIES.some((item) => item === options.capability)) throw new Error('CONFIGURE_CAPABILITY_INVALID')
  const capability = options.capability as SearchSetupCapability
  if (options.secretEnv !== undefined && options.reuseSecretRef !== undefined) throw new Error('CONFIGURE_SECRET_SOURCE_CONFLICT')
  if ((capability === 'web-read' || capability === 'project-text') && (options.secretEnv !== undefined || options.reuseSecretRef !== undefined)) throw new Error('CONFIGURE_UNEXPECTED_SECRET_SOURCE')
  if (options.secretEnv !== undefined && !envName.test(options.secretEnv)) throw new Error('ENV_NAME_INVALID')
  const configPath = await canonicalConfigPath(resolve(options.configPath))
  const initialConfigBytes = await readPrivateFile(configPath, 256 * 1024)
  const initialHash = hash(initialConfigBytes)
  const initialConfig = parseRuntimeConfig(parseJson(initialConfigBytes))
  const initialCanonicalHash = hash(`${JSON.stringify(initialConfig, null, 2)}\n`)
  const current = getExistingSecret(initialConfig, options.reuseSecretRef, capability)
  const needsSecret = capability !== 'web-read' && capability !== 'project-text'
  let selectedSecret: SecretRef | undefined
  let newSecretValue: string | undefined
  if (needsSecret) {
    if (options.reuseSecretRef !== undefined) {
      selectedSecret = current
      if (selectedSecret?.kind === 'env' && !process.env[selectedSecret.name]?.trim()) throw new Error('CONFIGURE_ENV_SECRET_UNAVAILABLE')
    } else if (options.secretEnv !== undefined) {
      const value = process.env[options.secretEnv]
      if (typeof value !== 'string' || !value.trim() || value.length > 8192) throw new Error('CONFIGURE_ENV_SECRET_UNAVAILABLE')
      selectedSecret = { kind: 'env', name: options.secretEnv }
    } else {
      const provider = capability === 'web-discovery' ? 'Brave Search' : 'OpenRouter'
      newSecretValue = await readHiddenSecret(`API key (hidden; stored in the local private secrets file; provider: ${provider}): `)
      selectedSecret = { kind: 'file', file: 'secrets.json', key: `search-${capability}-${randomUUID().slice(0, 8)}` }
    }
  }
  const nextObject = applyCapability(initialConfig as unknown as Record<string, unknown>, capability, selectedSecret)
  const parsedNext = parseRuntimeConfig(nextObject)
  const nextConfigBytes = `${JSON.stringify(parsedNext, null, 2)}\n`
  const nextHash = hash(nextConfigBytes)
  if (nextHash === initialCanonicalHash) return { configured: true, changed: false, capability, mcpReconnectRequired: false, providerProbed: false, ownerRestarted: false, reindexMayBeRequired: false }

  const embeddingChange = capability === 'code-embeddings' || capability === 'project-text-embeddings'
  const watched = initialConfig.roots.some((root) => root.watch === true)
  let allowWatchedIndexing = options.allowIndexing === true
  if (embeddingChange && watched && options.allowIndexing !== true) {
    if (options.allowIndexing === false || !await confirmWatchedIndexing()) throw new Error('CONFIGURE_WATCH_INDEX_CONSENT_REQUIRED')
    allowWatchedIndexing = true
  }

  let hadRunningOwner = false
  try {
  await withOwnerStartupLock(configPath, async () => {
    const currentBytes = await readPrivateFile(configPath, 256 * 1024)
    if (hash(currentBytes) !== initialHash) throw new Error('CONFIGURE_CONCURRENT_CHANGE')
    const latestConfig = parseRuntimeConfig(parseJson(currentBytes))
    const actualNext = parseRuntimeConfig(applyCapability(latestConfig as unknown as Record<string, unknown>, capability, selectedSecret))
    if (hash(`${JSON.stringify(actualNext, null, 2)}\n`) !== nextHash) throw new Error('CONFIGURE_CONCURRENT_CHANGE')
    const secretsPath = join(dirname(configPath), 'secrets.json')
    const oldSecretBytes = await readOptionalPrivateFile(secretsPath)
    if (selectedSecret?.kind === 'file' && newSecretValue === undefined) {
      if (oldSecretBytes === undefined) throw new Error('SECRET_FILE_INVALID')
      const oldSecrets = parseSecrets(oldSecretBytes)
      if (!Object.hasOwn(oldSecrets, selectedSecret.key)) throw new Error('SECRET_FILE_INVALID')
    }
    const nextSecretBytes = newSecretValue === undefined
      ? undefined
      : buildSecretsFile(oldSecretBytes, selectedSecret as Extract<SecretRef, { kind: 'file' }>, newSecretValue)
    if (nextSecretBytes !== undefined && Buffer.byteLength(nextSecretBytes) > 64 * 1024) throw new Error('CONFIGURE_SECRETS_TOO_LARGE')
    const status = await (dependencies.status ?? serviceStatus)(configPath)
    hadRunningOwner = status.running
    if (hadRunningOwner) await (dependencies.stop ?? stopOwner)(configPath)
    let createdSecretIdentity: { dev: number; ino: number } | undefined
    let secretWriteCommitted = false
    try {
      if (hash(await readPrivateFile(configPath, 256 * 1024)) !== initialHash) throw new Error('CONFIGURE_CONCURRENT_CHANGE')
      if (await readOptionalPrivateFile(secretsPath) !== oldSecretBytes) throw new Error('CONFIGURE_SECRET_FILE_CHANGED')
      if (nextSecretBytes !== undefined) {
        await writePrivateFile(secretsPath, nextSecretBytes, oldSecretBytes !== undefined)
        secretWriteCommitted = true
        const info = await lstat(secretsPath)
        createdSecretIdentity = { dev: info.dev, ino: info.ino }
      }
      await writePrivateFile(configPath, nextConfigBytes, true)
    } catch (error) {
      if (nextSecretBytes !== undefined && secretWriteCommitted) {
        try {
          const now = await lstat(secretsPath).catch(() => undefined)
          const sameCommittedSecret = createdSecretIdentity && now?.dev === createdSecretIdentity.dev && now.ino === createdSecretIdentity.ino
          const currentBytes = sameCommittedSecret ? await readPrivateFile(secretsPath, 64 * 1024) : undefined
          if (!sameCommittedSecret || currentBytes !== nextSecretBytes) throw new Error('CONFIGURE_ROLLBACK_CONCURRENT_CHANGE')
          if (oldSecretBytes !== undefined) await writePrivateFile(secretsPath, oldSecretBytes, true)
          else {
            await unlink(secretsPath)
          }
        } catch {
          throw new Error('CONFIGURE_ROLLBACK_FAILED')
        }
      }
      throw error
    }
  })
  } catch (error) {
    if (hadRunningOwner && error instanceof Error && error.message === 'CONFIGURE_ROLLBACK_FAILED') {
      throw new Error('CONFIGURE_ROLLBACK_FAILED_OWNER_STOPPED')
    }
    if (hadRunningOwner) {
      try {
        const currentBytes = await readPrivateFile(configPath, 256 * 1024)
        if (hash(currentBytes) !== initialHash) throw new Error('CONFIGURE_CONFIG_CHANGED')
        await (dependencies.restart ?? ensureOwner)(configPath)
      } catch {
        throw new Error('CONFIGURE_TRANSACTION_FAILED_OWNER_NOT_RESTORED')
      }
    }
    throw error
  }

  let ownerRestarted = false
  let ownerRestartError: string | undefined
  if (hadRunningOwner) {
    try {
      await (dependencies.restart ?? ensureOwner)(configPath)
      ownerRestarted = true
    } catch (error) {
      ownerRestartError = safeErrorCode(error)
    }
  }
  return {
    configured: true,
    changed: true,
    capability,
    mcpReconnectRequired: true,
    providerProbed: false,
    ownerWasRunning: hadRunningOwner,
    ownerRestarted,
    ...(ownerRestartError ? { ownerRestartError } : {}),
    reindexMayBeRequired: embeddingChange,
    ...(embeddingChange && watched && allowWatchedIndexing ? { watchedRootsMayStartIndexing: true } : {}),
    ...(hadRunningOwner && watched ? { existingWatchMayStartIndexing: true } : {}),
  }
}

function applyCapability(config: Record<string, unknown>, capability: SearchSetupCapability, secretRef?: SecretRef) {
  const next = structuredClone(config)
  const requireSecret = () => { if (!secretRef) throw new Error('CONFIGURE_SECRET_REQUIRED'); return structuredClone(secretRef) }
  if (capability === 'web-read') {
    next.web = { ...(isRecord(next.web) ? next.web : {}) }
  } else if (capability === 'project-text') {
    next.projectText = { ...(isRecord(next.projectText) ? next.projectText : {}) }
  } else if (capability === 'web-discovery') {
    const web = isRecord(next.web) ? next.web : {}
    const discovery = isRecord(web.discovery) ? web.discovery : {}
    next.web = { ...web, discovery: { ...discovery, secret: requireSecret() } }
  } else if (capability === 'visual') {
    const mechanism = isRecord(next.mechanism) ? next.mechanism : {}
    const visual = isRecord(mechanism.visual) ? mechanism.visual : {}
    next.mechanism = { ...mechanism, visual: { ...visual, secret: requireSecret() } }
  } else if (capability === 'code-embeddings') {
    const mechanism = isRecord(next.mechanism) ? next.mechanism : {}
    const code = isRecord(mechanism.code) ? mechanism.code : {}
    if (next.embedding) throw new Error('CONFIGURE_LEGACY_EMBEDDING_CONFLICT')
    next.mechanism = { ...mechanism, code: { ...code, secret: requireSecret() } }
  } else if (capability === 'project-text-embeddings') {
    const projectText = isRecord(next.projectText) ? next.projectText : {}
    const oldEmbedding = isRecord(projectText.embedding) ? projectText.embedding : {}
    const oldReranker = isRecord(projectText.reranker) ? projectText.reranker : {}
    const embeddingMetadata = { ...oldEmbedding }
    if (oldEmbedding.provider !== 'openrouter') {
      delete embeddingMetadata.baseUrl
      delete embeddingMetadata.profileId
    }
    const embedding = {
      ...embeddingMetadata,
      provider: 'openrouter',
      ...PROJECT_TEXT_RETRIEVAL_PRESET.embedding,
      secret: requireSecret(),
    }
    const reranker = {
      ...oldReranker,
      model: PROJECT_TEXT_RETRIEVAL_PRESET.reranker.model,
      secret: structuredClone(embedding.secret),
    }
    next.projectText = { ...projectText, embedding, reranker }
  } else if (capability === 'jev-classification') {
    const classifier = isRecord(next.classifier) ? next.classifier : {}
    next.classifier = { ...classifier, model: JEV_DECISIONS_MODEL, secret: requireSecret() }
  }
  return next
}

function getExistingSecret(config: unknown, path: string | undefined, target: SearchSetupCapability): SecretRef | undefined {
  if (path === undefined) return undefined
  if (!(reusePaths as readonly string[]).includes(path)) throw new Error('CONFIGURE_SECRET_REFERENCE_INVALID')
  if (!isSecretReferenceCompatible(config, path, target)) throw new Error('CONFIGURE_SECRET_REFERENCE_INCOMPATIBLE')
  let value: unknown = config
  for (const segment of path.split('.')) value = isRecord(value) ? value[segment] : undefined
  if (!isRecord(value)) throw new Error('CONFIGURE_SECRET_REFERENCE_MISSING')
  const result = value
  if (result.kind === 'env' && typeof result.name === 'string' && envName.test(result.name)) return { kind: 'env', name: result.name }
  if (result.kind === 'file' && result.file === 'secrets.json' && typeof result.key === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(result.key)) return { kind: 'file', file: 'secrets.json', key: result.key }
  throw new Error('CONFIGURE_SECRET_REFERENCE_INVALID')
}

function parseJson(text: string): unknown { try { return JSON.parse(text) } catch { throw new Error('CONFIG_INVALID') } }
function hash(value: string) { return createHash('sha256').update(value).digest('hex') }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function safeErrorCode(_error: unknown) { return 'OWNER_RESTART_FAILED' }

async function readOptionalPrivateFile(path: string) {
  try { return await readPrivateFile(path, 64 * 1024) }
  catch (error) { if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

function buildSecretsFile(previous: string | undefined, ref: Extract<SecretRef, { kind: 'file' }>, value: string) {
  const parsed = previous === undefined ? {} : parseSecrets(previous)
  parsed[ref.key] = value
  if (Object.keys(parsed).length > 32) throw new Error('CONFIGURE_SECRETS_TOO_MANY')
  return `${JSON.stringify(parsed, null, 2)}\n`
}

function parseSecrets(text: string): Record<string, string> {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error('SECRET_FILE_INVALID') }
  if (!isRecord(raw) || Object.keys(raw).length > 32 || Object.values(raw).some((entry) => typeof entry !== 'string' || !entry.trim() || entry.length > 8192)) throw new Error('SECRET_FILE_INVALID')
  return raw as Record<string, string>
}

function isSecretReferenceCompatible(config: unknown, path: string, target: SearchSetupCapability) {
  const targetFamily = target === 'web-discovery' ? 'brave' : target === 'web-read' || target === 'project-text' ? 'none' : 'openrouter'
  if (targetFamily === 'none') return false
  const sourceFamily = getSecretReferenceFamily(config, path)
  return sourceFamily === targetFamily
}

function getSecretReferenceFamily(config: unknown, path: string): 'brave' | 'openrouter' | undefined {
  const segments = path.split('.')
  const refPath = segments.slice(0, -1).join('.')
  let value: unknown = config
  for (const segment of segments.slice(0, -1)) value = isRecord(value) ? value[segment] : undefined
  if (!isRecord(value) || !isRecord(value.secret)) return undefined
  if (refPath === 'web.discovery') return 'brave'
  if (refPath === 'mechanism.code' || refPath === 'mechanism.visual' || refPath === 'classifier' || refPath === 'reranker' || refPath === 'projectText.reranker') return 'openrouter'
  if (refPath === 'embedding' || refPath === 'web.embedding' || refPath === 'projectText.embedding') {
    return value.provider === 'openrouter' ? 'openrouter' : undefined
  }
  return undefined
}
