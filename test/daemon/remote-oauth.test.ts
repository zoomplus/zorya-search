import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { test } from 'node:test'
import { exportJWK, SignJWT } from 'jose'
import { createRemoteOAuthAuthorizer, parseRemoteOAuthPolicy, remoteOAuthMetadataUrl, remoteOAuthScopes, validateRemoteOAuthRoots } from '../../src/daemon/remote-oauth.js'
import { startSearchDaemon } from '../../src/daemon/index.js'

const basePolicy = {
  resource: 'https://search.example/mcp',
  issuer: 'https://identity.example',
  jwksUrl: 'https://identity.example/keys',
  port: 0,
  allowedOrigins: ['https://chat.example'],
  grants: [
    { subject: 'auth0|alice/123', rootIds: ['project'], operations: ['read', 'index'] },
  ],
}
const policy = parseRemoteOAuthPolicy(basePolicy)
const metadata = remoteOAuthMetadataUrl(policy.resource)

test('remote policy binds canonical HTTPS resource and only derives owner-approved scopes', () => {
  assert.equal(metadata, 'https://search.example/.well-known/oauth-protected-resource/mcp')
  assert.equal(policy.issuer, 'https://identity.example')
  assert.notEqual(parseRemoteOAuthPolicy({ ...basePolicy, issuer: 'https://identity.example/' }).issuer, policy.issuer)
  assert.throws(() => validateRemoteOAuthRoots(policy, ['other']), /REMOTE_GRANT_ROOT_UNKNOWN/)
  assert.doesNotThrow(() => validateRemoteOAuthRoots(policy, ['project', 'other']))
  assert.deepEqual(remoteOAuthScopes(policy), ['zorya:index', 'zorya:read'])
  for (const change of [
    { resource: 'https://user:pass@search.example/mcp' },
    { resource: 'https://search.example/mcp#fragment' },
    { resource: 'https://search.example/other' },
    { issuer: 'https://identity.example/tenant?query=1' },
    { jwksUrl: 'https://identity.example/keys?redirect=https://attacker.example' },
    { port: 65536 },
    { grants: [{ subject: 'alice', rootIds: ['missing'], operations: ['read', 'admin'] }] },
  ]) assert.throws(() => parseRemoteOAuthPolicy({ ...basePolicy, ...change }))
})

test('remote authorization validates signed access-token identity and intersects static grants with scopes', async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const otherPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const ecPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = await exportJWK(pair.publicKey)
  Object.assign(jwk, { kid: 'key-1', alg: 'RS256', use: 'sig' })
  const ecJwk = await exportJWK(ecPair.publicKey)
  Object.assign(ecJwk, { kid: 'ec-1', alg: 'ES256', use: 'sig' })
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), policy.jwksUrl)
    assert.equal(init?.redirect, 'error')
    return new Response(JSON.stringify({ keys: [jwk, ecJwk] }), { status: 200, headers: { 'content-type': 'application/jwk-set+json' } })
  }
  const abort = new AbortController().signal
  const authorize = createRemoteOAuthAuthorizer(policy)
  const sign = async (options: { subject?: string; issuer?: string; audience?: string; expires?: number; notBefore?: number; type?: string; scope?: string | null; kid?: string; privateKey?: typeof pair.privateKey; algorithm?: string } = {}) => {
    const now = Math.floor(Date.now() / 1000)
    const scopeClaims = options.scope === null ? {} : { scope: options.scope ?? 'zorya:read zorya:web' }
    let builder = new SignJWT(scopeClaims)
      .setProtectedHeader({ alg: options.algorithm ?? 'RS256', kid: options.kid ?? 'key-1', typ: options.type ?? 'at+jwt' })
      .setIssuer(options.issuer ?? policy.issuer)
      .setAudience(options.audience ?? policy.resource)
      .setSubject(options.subject ?? 'auth0|alice/123')
    if (options.expires !== 0) builder = builder.setExpirationTime(options.expires ?? now + 60)
    if (options.notBefore !== undefined) builder = builder.setNotBefore(options.notBefore)
    return builder.sign(options.privateKey ?? pair.privateKey)
  }
  try {
    const token = await sign()
    const authorized = await authorize(token, abort)
    assert.match(authorized?.principalId ?? '', /^[a-f0-9]{64}$/)
    assert.deepEqual(authorized, { principalId: authorized?.principalId, rootIds: ['project'], operations: ['read'], permittedScopes: ['zorya:read', 'zorya:index'] })
    assert.ok(await authorize(await sign({ type: 'APPLICATION/AT+JWT' }), abort))
    assert.ok(await authorize(await sign({ algorithm: 'ES256', kid: 'ec-1', privateKey: ecPair.privateKey }), abort))
    for (const token of [
      await sign({ privateKey: otherPair.privateKey }),
      await sign({ audience: 'https://other.example/mcp' }),
      await sign({ issuer: 'https://other.example/' }),
      await sign({ expires: Math.floor(Date.now() / 1000) - 1 }),
      await sign({ expires: 0 }),
      await sign({ notBefore: Math.floor(Date.now() / 1000) + 60 }),
      await sign({ kid: 'unknown-key' }),
      await sign({ type: 'JWT' }),
      await sign({ subject: 'mallory' }),
    ]) assert.equal(await authorize(token, abort), undefined)
    assert.deepEqual(await authorize(await sign({ scope: 'zorya:web' }), abort), { kind: 'insufficient_scope', scope: 'zorya:read' })
    assert.deepEqual(await authorize(await sign({ scope: null }), abort), { kind: 'insufficient_scope', scope: 'zorya:read' })
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'key-1', typ: 'at+jwt' })).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`
    assert.equal(await authorize(unsigned, abort), undefined)
    assert.equal(await authorize('not-a-token', abort), undefined)
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key-1', typ: 'at+jwt' })).toString('base64url')
    const payload = Buffer.from(`{"iss":"${policy.issuer}","aud":"${policy.resource}","sub":"auth0|alice/123","exp":1e999,"scope":"zorya:read"}`).toString('base64url')
    const signingInput = `${header}.${payload}`
    const infiniteExpiry = `${signingInput}.${cryptoSign('RSA-SHA256', Buffer.from(signingInput), pair.privateKey).toString('base64url')}`
    assert.equal(await authorize(infiniteExpiry, abort), undefined)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('remote authorization stops before fetching keys when already cancelled', async () => {
  const controller = new AbortController()
  controller.abort()
  const authorize = createRemoteOAuthAuthorizer(policy)
  assert.equal(await authorize('a.b.c', controller.signal), undefined)
})

test('remote authorizer close aborts and joins its shared JWKS fetch', async () => {
  const previousFetch = globalThis.fetch
  let fetchAborted = false
  globalThis.fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { fetchAborted = true; reject(new Error('aborted')) }, { once: true })
  })
  const authorize = createRemoteOAuthAuthorizer(policy)
  const token = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key-1', typ: 'at+jwt' })).toString('base64url')}.e30.signature`
  try {
    const job = authorize(token, new AbortController().signal)
    for (let index = 0; index < 20 && !fetchAborted; index++) await new Promise((resolve) => setTimeout(resolve, 2))
    await authorize.close()
    assert.equal(fetchAborted, true)
    assert.equal(await job, undefined)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('remote daemon exposes only public metadata and protects the whole MCP resource', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-remote-oauth-'))
  const root = join(dir, 'root')
  await Promise.all([mkdir(root), mkdir(join(dir, 'state'))])
  const insufficientScopeBearer = 'remote-oauth-no-scope'.padEnd(40, 's')
  const stepUpBearer = 'remote-oauth-step-up'.padEnd(40, 'u')
  const ungrantedStepUpBearer = 'remote-oauth-ungranted'.padEnd(40, 'g')
  const daemon = await startSearchDaemon({
    config: { version: 1, dataDir: join(dir, 'state'), roots: [{ id: 'project', path: root }] },
    host: '127.0.0.1', port: 0,
    allowedHosts: ['search.example'], allowedOrigins: ['https://chat.example'],
    authorize: async (token) => {
      if (token === insufficientScopeBearer) return { kind: 'insufficient_scope', scope: 'zorya:read' }
      if (token === stepUpBearer || token === ungrantedStepUpBearer) return {
        principalId: 'a'.repeat(64), rootIds: ['project'], operations: ['read'],
        ...(token === stepUpBearer ? { permittedScopes: ['zorya:read', 'zorya:index'] } : { permittedScopes: ['zorya:read'] }),
      }
      return undefined
    },
    protectedResource: { resource: policy.resource, issuer: policy.issuer, scopes: remoteOAuthScopes(policy), metadataUrl: metadata },
  })
  const request = (path: string, host = 'search.example', origin = 'https://chat.example', authorization?: string, body?: string) => new Promise<{ status: number; challenge?: string; body: string }>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: daemon.port, path, method: body ? 'POST' : 'GET', headers: { host, origin, ...(authorization ? { authorization } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, challenge: res.headers['www-authenticate'], body }))
    })
    req.on('error', reject)
    req.end(body)
  })
  try {
    const doc = await request('/.well-known/oauth-protected-resource/mcp')
    assert.equal(doc.status, 200)
    assert.deepEqual(JSON.parse(doc.body), {
      resource: policy.resource,
      authorization_servers: [policy.issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: ['zorya:index', 'zorya:read'],
    })
    const challenge = await request('/mcp')
    assert.equal(challenge.status, 401)
    assert.equal(challenge.challenge, `Bearer resource_metadata="${metadata}"`)
    const insufficientScope = await request('/mcp', 'search.example', 'https://chat.example', `Bearer ${insufficientScopeBearer}`)
    assert.equal(insufficientScope.status, 403)
    assert.equal(insufficientScope.challenge, `Bearer resource_metadata="${metadata}", error="insufficient_scope", scope="zorya:read"`)
    const callIndex = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'index_repository', arguments: { rootId: 'project' } } })
    const stepUp = await request('/mcp', 'search.example', 'https://chat.example', `Bearer ${stepUpBearer}`, callIndex)
    assert.equal(stepUp.status, 403)
    assert.equal(stepUp.challenge, `Bearer resource_metadata="${metadata}", error="insufficient_scope", scope="zorya:index"`)
    const foreignRoot = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'index_repository', arguments: { rootId: 'foreign' } } })
    assert.equal((await request('/mcp', 'search.example', 'https://chat.example', `Bearer ${stepUpBearer}`, foreignRoot)).status, 404)
    const ungranted = await request('/mcp', 'search.example', 'https://chat.example', `Bearer ${ungrantedStepUpBearer}`, callIndex)
    assert.notEqual(ungranted.status, 403)
    assert.equal(ungranted.challenge, undefined)
    assert.equal((await request('/other')).status, 404)
    assert.equal((await request('/.well-known/oauth-protected-resource/mcp', 'attacker.example')).status, 403)
    assert.equal((await request('/.well-known/oauth-protected-resource/mcp', 'search.example', 'https://attacker.example')).status, 403)
  } finally {
    await daemon.close()
    await rm(dir, { recursive: true, force: true })
  }
})
