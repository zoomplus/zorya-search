import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { canonicalFuturePath, isSameOrDescendantPath } from '../runtime/path.js'
import { parseRuntimeConfig, type RuntimeConfig } from '../runtime/config.js'
import { createSearchIpAccessPolicy, type SearchIpOperation } from '../daemon/ip-access.js'
import { BridgeContractError, validateBridgePath } from './protocol.js'
import { z } from 'zod'

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const operation = z.enum(['read', 'index', 'web', 'classify', 'visual'])

const ServerClientSchema = z.object({
  clientId: uuid,
  tokenSha256: hash,
  clientCidrs: z.array(z.string().min(3).max(128)).min(1).max(256),
  grants: z.array(operation).min(1).max(5),
  allowedDocumentPaths: z.array(z.string().min(1).max(1_024)).max(256).optional(),
  excludedPaths: z.array(z.string().min(1).max(512)).max(512).optional(),
}).strict()

const RuntimeTemplateInputSchema = z.record(z.string(), z.unknown())

const ServerConfigSchema = z.object({
  schemaVersion: z.literal(1),
  resource: z.string().min(1).max(2_048),
  bindHost: z.enum(['127.0.0.1', '::1']),
  port: z.number().int().min(0).max(65_535),
  dataDir: z.string().min(1).max(4_096),
  runtimeTemplate: RuntimeTemplateInputSchema.optional(),
  trustedProxyCidrs: z.array(z.string().min(3).max(128)).max(4_096),
  allowedOrigins: z.array(z.string().min(1).max(2_048)).min(1).max(32),
  clients: z.array(ServerClientSchema).min(1).max(256),
}).strict()

export type BridgeServerConfig = Omit<z.infer<typeof ServerConfigSchema>, 'dataDir' | 'resource' | 'runtimeTemplate'> & {
  dataDir: string
  resource: string
  runtimeTemplate?: Omit<RuntimeConfig, 'version' | 'dataDir' | 'roots'>
}

const ClientConfigSchema = z.object({
  schemaVersion: z.literal(1),
  endpoint: z.string().min(1).max(2_048),
  clientId: uuid,
  stateDir: z.string().min(1).max(4_096),
  credential: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('env'), name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/) }).strict(),
    z.object({ kind: z.literal('file'), path: z.string().min(1).max(4_096) }).strict(),
  ]),
}).strict()

export type BridgeClientConfig = z.infer<typeof ClientConfigSchema> & { endpoint: string; stateDir: string }

function fail(): never { throw new BridgeContractError('CONFIG_INVALID') }

function validateCidrPolicy(allowedCidrs: readonly string[], trustedProxyCidrs: readonly string[]) {
  try {
    createSearchIpAccessPolicy({
      allowedCidrs,
      trustedProxyCidrs,
      principalId: 'bridge-policy-check',
      rootIds: ['bridge'],
      operations: ['read'],
      allowedOrigins: [],
      resource: 'https://bridge.invalid/mcp',
      allowedHosts: ['bridge.invalid'],
      port: 0,
    })
    for (const cidr of allowedCidrs) if (cidr.endsWith('/0')) fail()
  } catch {
    fail()
  }
}

function loopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, '').toLowerCase().replace(/\.$/u, '')
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./u.test(host)
}

function parseEndpoint(value: string, allowInsecureLoopbackForTests: boolean): string {
  let url: URL
  try { url = new URL(value) } catch { fail() }
  const loopback = loopbackHost(url.hostname)
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  if (hostname === '::' || hostname === '0.0.0.0') fail()
  if (url.username || url.password || url.search || url.hash || url.pathname === '/' || url.href !== value) fail()
  if (url.protocol === 'https:' && !loopback) return url.href
  if (allowInsecureLoopbackForTests && url.protocol === 'http:' && loopback) return url.href
  fail()
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freezeDeep(child)
  }
  return value
}

function validateDocumentPermission(paths: readonly string[] | undefined) {
  if (!paths) return
  const unique = new Set<string>()
  for (const path of paths) {
    if (path.includes('\\') || path.includes('\0') || path.includes(':') || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..') || !/\.(?:md|mdx|mdc)$/iu.test(path) || unique.has(path)) fail()
    try { validateBridgePath(path, { allowedDocumentPaths: paths }) } catch { fail() }
    unique.add(path)
  }
}

function validateExclusionPatterns(patterns: readonly string[] | undefined) {
  if (!patterns) return
  const unique = new Set<string>()
  for (const pattern of patterns) {
    if (!pattern || pattern.length > 512 || pattern.trim() !== pattern || pattern.startsWith('!') || pattern.includes('\\') || pattern.includes('\0') || pattern.includes(':') || /^[A-Za-z]:/u.test(pattern) || pattern.startsWith('/') || /[\p{Cc}\u2028\u2029]/u.test(pattern) || pattern.split('/').some((part) => part === '..') || unique.has(pattern)) fail()
    unique.add(pattern)
  }
}

function parseRuntimeTemplate(input: Record<string, unknown> | undefined): BridgeServerConfig['runtimeTemplate'] {
  if (!input) return undefined
  if (['version', 'dataDir', 'roots'].some((key) => Object.hasOwn(input, key))) fail()
  let parsed: RuntimeConfig
  try {
    parsed = parseRuntimeConfig({
      ...input,
      version: 1,
      dataDir: '/zorya-bridge-template-data',
      roots: [{ id: 'bridge-template', path: '/zorya-bridge-template-root' }],
    })
  } catch { fail() }
  const { version: _version, dataDir: _dataDir, roots: _roots, ...template } = parsed
  return template
}

function validateClientGrant(client: z.infer<typeof ServerClientSchema>) {
  if (new Set(client.grants).size !== client.grants.length || new Set(client.clientCidrs).size !== client.clientCidrs.length) fail()
  validateCidrPolicy(client.clientCidrs, [])
  validateDocumentPermission(client.allowedDocumentPaths)
  validateExclusionPatterns(client.excludedPaths)
}

export async function parseBridgeServerConfig(
  input: unknown,
  options: { forbiddenRoots?: readonly string[]; allowInsecureLoopbackForTests?: boolean } = {},
): Promise<BridgeServerConfig> {
  const parsed = ServerConfigSchema.safeParse(input)
  if (!parsed.success) fail()
  const resource = parseEndpoint(parsed.data.resource, options.allowInsecureLoopbackForTests === true)
  if (parsed.data.bindHost !== '127.0.0.1' && parsed.data.bindHost !== '::1') fail()
  if (new Set(parsed.data.clients.map((client) => client.clientId)).size !== parsed.data.clients.length || new Set(parsed.data.clients.map((client) => client.tokenSha256)).size !== parsed.data.clients.length) fail()
  if (new Set(parsed.data.trustedProxyCidrs).size !== parsed.data.trustedProxyCidrs.length || new Set(parsed.data.allowedOrigins).size !== parsed.data.allowedOrigins.length) fail()
  for (const origin of parsed.data.allowedOrigins) {
    let url: URL
    try { url = new URL(origin) } catch { fail() }
    if (url.protocol !== 'https:' || url.origin !== origin || url.pathname !== '/' || url.search || url.hash || url.username || url.password) fail()
  }
  validateCidrPolicy(['127.0.0.1/32'], parsed.data.trustedProxyCidrs)
  for (const client of parsed.data.clients) validateClientGrant(client)
  const runtimeTemplate = parseRuntimeTemplate(parsed.data.runtimeTemplate)
  let dataDir: string
  try {
    if (!isAbsolute(parsed.data.dataDir)) fail()
    dataDir = await canonicalFuturePath(parsed.data.dataDir)
  } catch { fail() }
  for (const root of options.forbiddenRoots ?? []) {
    let canonicalRoot: string
    try { canonicalRoot = await realpath(root) } catch { fail() }
    if (isSameOrDescendantPath(canonicalRoot!, dataDir!) || isSameOrDescendantPath(dataDir!, canonicalRoot!)) fail()
  }
  const { runtimeTemplate: _rawRuntimeTemplate, ...serverFields } = parsed.data
  const result: BridgeServerConfig = {
    ...serverFields,
    resource,
    dataDir,
    ...(runtimeTemplate === undefined ? {} : { runtimeTemplate }),
  }
  return freezeDeep(result)
}

export async function parseBridgeClientConfig(
  input: unknown,
  options: { cwd: string; allowInsecureLoopbackForTests?: boolean },
): Promise<BridgeClientConfig> {
  const parsed = ClientConfigSchema.safeParse(input)
  if (!parsed.success) fail()
  const endpoint = parseEndpoint(parsed.data.endpoint, options.allowInsecureLoopbackForTests === true)
  let cwd: string
  let stateDir: string
  try {
    cwd = await realpath(options.cwd)
    if (!isAbsolute(parsed.data.stateDir)) fail()
    stateDir = await canonicalFuturePath(parsed.data.stateDir)
  } catch { fail() }
  if (isSameOrDescendantPath(cwd!, stateDir!) || isSameOrDescendantPath(stateDir!, cwd!)) fail()
  if (parsed.data.credential.kind === 'file') {
    const path = parsed.data.credential.path
    if (!isAbsolute(path)) fail()
    let info
    try { info = await lstat(path) } catch { fail() }
    if (!info!.isFile() || info!.isSymbolicLink() || info!.size < 1 || info!.size > 16_384 || process.platform !== 'win32' && (info!.mode & 0o077) !== 0) fail()
    let canonicalSecretFile: string
    try { canonicalSecretFile = await realpath(path) } catch { fail() }
    if (isSameOrDescendantPath(cwd!, canonicalSecretFile!) || isSameOrDescendantPath(canonicalSecretFile!, cwd!)) fail()
  }
  return freezeDeep({ ...parsed.data, endpoint, stateDir })
}

export function validateBridgeGrants(input: readonly SearchIpOperation[]): readonly SearchIpOperation[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 5 || input.some((grant) => !['read', 'index', 'web', 'classify', 'visual'].includes(grant)) || new Set(input).size !== input.length) fail()
  return Object.freeze([...input])
}
