import { createHash } from 'node:crypto'
import { importJWK, jwtVerify, type JWK } from 'jose'
import type { SearchMcpAccess } from '../mcp/server.js'

export type SearchOperation = SearchMcpAccess['operations'][number]
export interface RemoteOAuthGrant {
  subject: string
  rootIds: readonly string[]
  operations: readonly SearchOperation[]
}
export interface RemoteOAuthPolicy {
  resource: string
  issuer: string
  jwksUrl: string
  port: number
  allowedOrigins: readonly string[]
  grants: readonly RemoteOAuthGrant[]
}

const operations = ['read', 'index', 'web', 'classify', 'visual'] as const
const algorithms = ['RS256', 'ES256'] as const
const scopeFor = (operation: SearchOperation) => `zorya:${operation}`

function httpsUrl(value: unknown, code: string, options: { path?: string } = {}): URL {
  if (typeof value !== 'string' || value.length > 2048) throw new Error(code)
  let url: URL
  try { url = new URL(value) } catch { throw new Error(code) }
  const canonicalWithoutRootSlash = options.path === undefined && url.pathname === '/' && value === url.origin
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    (options.path !== undefined && url.pathname !== options.path) || (url.href !== value && !canonicalWithoutRootSlash)) throw new Error(code)
  return url
}

export function parseRemoteOAuthPolicy(value: unknown): RemoteOAuthPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('REMOTE_POLICY_INVALID')
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some((key) => !['resource', 'issuer', 'jwksUrl', 'port', 'allowedOrigins', 'grants'].includes(key))) throw new Error('REMOTE_POLICY_INVALID')
  const resourceUrl = httpsUrl(raw.resource, 'REMOTE_RESOURCE_INVALID', { path: '/mcp' })
  httpsUrl(raw.issuer, 'REMOTE_ISSUER_INVALID')
  const jwksUrl = httpsUrl(raw.jwksUrl, 'REMOTE_JWKS_URL_INVALID')
  if (!Number.isInteger(raw.port) || (raw.port as number) < 0 || (raw.port as number) > 65535) throw new Error('REMOTE_PORT_INVALID')
  if (!Array.isArray(raw.allowedOrigins) || raw.allowedOrigins.length > 32) throw new Error('REMOTE_ORIGINS_INVALID')
  const allowedOrigins = raw.allowedOrigins.map((origin) => {
    if (typeof origin !== 'string' || origin.length > 2048) throw new Error('REMOTE_ORIGINS_INVALID')
    let parsed: URL
    try { parsed = new URL(origin) } catch { throw new Error('REMOTE_ORIGINS_INVALID') }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin !== origin) throw new Error('REMOTE_ORIGINS_INVALID')
    return origin
  })
  if (new Set(allowedOrigins).size !== allowedOrigins.length || !Array.isArray(raw.grants) || raw.grants.length < 1 || raw.grants.length > 256) throw new Error('REMOTE_GRANTS_INVALID')
  const subjects = new Set<string>()
  const grants = raw.grants.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('REMOTE_GRANTS_INVALID')
    const grant = entry as Record<string, unknown>
    if (Object.keys(grant).some((key) => !['subject', 'rootIds', 'operations'].includes(key)) || typeof grant.subject !== 'string' || Buffer.byteLength(grant.subject, 'utf8') > 255 || !grant.subject || /[\u0000-\u001f\u007f]/u.test(grant.subject) || subjects.has(grant.subject)) throw new Error('REMOTE_GRANTS_INVALID')
    subjects.add(grant.subject)
    if (!Array.isArray(grant.rootIds) || grant.rootIds.length < 1 || grant.rootIds.length > 32 || grant.rootIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) || new Set(grant.rootIds).size !== grant.rootIds.length) throw new Error('REMOTE_GRANTS_INVALID')
    if (!Array.isArray(grant.operations) || grant.operations.length < 1 || grant.operations.length > operations.length || grant.operations.some((operation) => !operations.includes(operation as SearchOperation)) || new Set(grant.operations).size !== grant.operations.length) throw new Error('REMOTE_GRANTS_INVALID')
    return Object.freeze({ subject: grant.subject, rootIds: Object.freeze([...grant.rootIds] as string[]), operations: Object.freeze([...grant.operations] as SearchOperation[]) })
  })
  return Object.freeze({ resource: resourceUrl.href, issuer: raw.issuer as string, jwksUrl: jwksUrl.href, port: raw.port as number, allowedOrigins: Object.freeze(allowedOrigins), grants: Object.freeze(grants) })
}

export function createRemoteOAuthAuthorizer(policy: RemoteOAuthPolicy) {
  let cached: { expiresAt: number; keys: JWK[] } | undefined
  let loading: Promise<JWK[]> | undefined
  const pendingLoads = new Set<Promise<JWK[]>>()
  const loadControllers = new Set<AbortController>()
  let lastForcedRefreshAt = Number.NEGATIVE_INFINITY
  const raceAbort = <T>(promise: Promise<T>, signal: AbortSignal) => new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const aborted = () => reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
  const loadKeys = async (signal: AbortSignal, force = false): Promise<JWK[]> => {
    if (force && Date.now() - lastForcedRefreshAt < 30_000 && cached) return cached.keys
    if (force) lastForcedRefreshAt = Date.now()
    if (!force && cached && cached.expiresAt > Date.now()) return cached.keys
    if (loading) return raceAbort(loading, signal)
    const request = (async () => {
      const controller = new AbortController()
      loadControllers.add(controller)
      const timeout = setTimeout(() => controller.abort(new Error('JWKS_TIMEOUT')), 5_000)
      try {
        const response = await fetch(policy.jwksUrl, { redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' } })
        if (!response.ok || response.status !== 200 || !/^application\/(?:json|jwk-set\+json|jwks\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
          await response.body?.cancel().catch(() => undefined)
          throw new Error('JWKS_FETCH_FAILED')
        }
        const reader = response.body?.getReader()
        if (!reader) throw new Error('JWKS_FETCH_FAILED')
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > 262_144) {
              await reader.cancel().catch(() => undefined)
              throw new Error('JWKS_TOO_LARGE')
            }
            chunks.push(value)
          }
        } finally { reader.releaseLock() }
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { keys?: unknown }
        if (!Array.isArray(parsed.keys) || parsed.keys.length < 1 || parsed.keys.length > 32) throw new Error('JWKS_INVALID')
        const keys = parsed.keys.filter((key): key is JWK => {
          if (!key || typeof key !== 'object' || Array.isArray(key)) return false
          const candidate = key as JWK
          return typeof candidate.kid === 'string' && !('d' in key) && !('x5u' in key) &&
            (!candidate.key_ops || (Array.isArray(candidate.key_ops) && candidate.key_ops.every((operation) => operation === 'verify')))
        })
        if (keys.length !== parsed.keys.length) throw new Error('JWKS_INVALID')
        cached = { keys, expiresAt: Date.now() + 300_000 }
        return keys
      } finally {
        clearTimeout(timeout)
        loadControllers.delete(controller)
      }
    })()
    loading = request
    pendingLoads.add(request)
    void request.finally(() => pendingLoads.delete(request)).catch(() => undefined)
    try { return await raceAbort(request, signal) } finally { void request.finally(() => { if (loading === request) loading = undefined }).catch(() => undefined) }
  }
  const authorize = async (token: string, signal: AbortSignal): Promise<((SearchMcpAccess & { principalId: string; permittedScopes: readonly string[] }) | { kind: 'insufficient_scope'; scope: string } | undefined)> => {
    try {
      if (signal.aborted || token.length > 8192) return undefined
      const [encodedHeader] = token.split('.')
      if (!encodedHeader) return undefined
      const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as Record<string, unknown>
      const tokenType = typeof header.typ === 'string' ? header.typ.toLowerCase() : ''
      if (!['at+jwt', 'application/at+jwt'].includes(tokenType) || typeof header.kid !== 'string' || !algorithms.includes(header.alg as typeof algorithms[number]) || 'jku' in header || 'x5u' in header) return undefined
      const hadCachedKeys = Boolean(cached)
      let keys = await loadKeys(signal)
      let jwk = keys.find((key) => key.kid === header.kid && (!key.alg || key.alg === header.alg) && (!key.use || key.use === 'sig'))
      if (!jwk && hadCachedKeys && Date.now() - lastForcedRefreshAt >= 30_000) {
        keys = await loadKeys(signal, true)
        jwk = keys.find((key) => key.kid === header.kid && (!key.alg || key.alg === header.alg) && (!key.use || key.use === 'sig'))
      }
      if (!jwk) return undefined
      const key = await importJWK(jwk, header.alg as string)
      const { payload } = await jwtVerify(token, key, { algorithms: [...algorithms], issuer: policy.issuer, audience: policy.resource, requiredClaims: ['iss', 'aud', 'exp', 'sub'] })
      if (typeof payload.sub !== 'string' || Buffer.byteLength(payload.sub, 'utf8') > 255 || /[\u0000-\u001f\u007f]/u.test(payload.sub) || !payload.sub || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf))) || (payload.scope !== undefined && (typeof payload.scope !== 'string' || payload.scope.length > 4096))) return undefined
      const grant = policy.grants.find((item) => item.subject === payload.sub)
      if (!grant) return undefined
      const tokenScopes = new Set((typeof payload.scope === 'string' ? payload.scope : '').split(/\s+/).filter(Boolean))
      const grantedOperations = grant.operations.filter((operation) => tokenScopes.has(scopeFor(operation)))
      if (!grantedOperations.length) {
        const minimumOperation = [...grant.operations].sort((left, right) =>
          left === 'read' ? -1 : right === 'read' ? 1 : left.localeCompare(right),
        )[0]!
        return { kind: 'insufficient_scope' as const, scope: scopeFor(minimumOperation) }
      }
      const principalId = createHash('sha256').update(policy.issuer).update('\0').update(grant.subject).digest('hex')
      return { principalId, rootIds: [...grant.rootIds], operations: grantedOperations, permittedScopes: grant.operations.map(scopeFor) }
    } catch { return undefined }
  }
  return Object.assign(authorize, {
    async close() {
      for (const controller of loadControllers) controller.abort(new Error('DAEMON_CLOSED'))
      await Promise.allSettled([...pendingLoads])
    },
  })
}

export function validateRemoteOAuthRoots(policy: RemoteOAuthPolicy, availableRoots: readonly string[]) {
  const available = new Set(availableRoots)
  if (policy.grants.some((grant) => grant.rootIds.some((rootId) => !available.has(rootId)))) throw new Error('REMOTE_GRANT_ROOT_UNKNOWN')
}

export function remoteOAuthScopes(policy: RemoteOAuthPolicy) {
  return [...new Set(policy.grants.flatMap((grant) => grant.operations.map(scopeFor)))].sort()
}

export function remoteOAuthMetadataUrl(resource: string) {
  return `${new URL(resource).origin}/.well-known/oauth-protected-resource${new URL(resource).pathname}`
}
