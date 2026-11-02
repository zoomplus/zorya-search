import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { IncomingMessage } from 'node:http'
import { parseRemoteIpPolicy } from '../../src/daemon/remote-ip.js'
import { createSearchIpAccessPolicy, parseSearchIpAccessPolicy } from '../../src/daemon/ip-access.js'

const base = {
  resource: 'https://startzorya.com/mcp/search',
  allowedHosts: ['startzorya.com'],
  allowedCidrs: ['127.0.0.0/8', '2001:db8::/32'],
  trustedProxyCidrs: ['10.0.0.0/8'],
  allowedOrigins: ['https://chat.example'],
  principalId: 'chat-client',
  rootIds: ['repo'],
  operations: ['read'],
}

function request(remoteAddress: string, raw: string[] = []) {
  return { socket: { remoteAddress }, rawHeaders: raw } as unknown as IncomingMessage
}
function headers(host = 'startzorya.com', origin?: string, forwarded?: string) {
  return [
    'Host', host,
    ...(origin === undefined ? [] : ['Origin', origin]),
    ...(forwarded === undefined ? [] : ['X-Real-IP', forwarded]),
  ]
}

test('IP policy uses IPv4 and IPv6 socket peers and trusts one valid forwarded address only from trusted CIDRs', () => {
  const policy = createSearchIpAccessPolicy(parseRemoteIpPolicy(base, ['repo']))
  assert.equal(policy.authorize(request('127.0.0.1', headers())), true)
  assert.equal(policy.authorize(request('2001:db8::1', headers())), true)
  assert.equal(policy.authorize(request('10.0.0.4', headers('startzorya.com', undefined, '127.0.0.1'))), true)
  assert.equal(policy.authorize(request('10.0.0.4', headers('startzorya.com', undefined, '192.0.2.1'))), false)
  assert.equal(policy.authorize(request('192.0.2.2', headers('startzorya.com', undefined, '127.0.0.1'))), false)
})

test('IP policy rejects malformed, duplicate, untrusted, Host, and Origin headers', () => {
  const policy = createSearchIpAccessPolicy(parseRemoteIpPolicy(base, ['repo']))
  assert.equal(policy.authorize(request('10.0.0.4', [...headers('startzorya.com', undefined, '127.0.0.1'), 'X-Real-IP', '127.0.0.1'])), false)
  assert.equal(policy.authorize(request('10.0.0.4', headers('startzorya.com', undefined, '127.0.0.1, 127.0.0.2'))), false)
  assert.equal(policy.authorize(request('127.0.0.1', ['Host', 'startzorya.com', 'Host', 'startzorya.com'])), false)
  assert.equal(policy.authorize(request('127.0.0.1', headers('attacker.example'))), false)
  assert.equal(policy.authorize(request('127.0.0.1', headers('startzorya.com', 'https://evil.example'))), false)
  assert.equal(policy.authorize(request('127.0.0.1', ['Host', 'startzorya.com', 'Origin', 'https://chat.example', 'Origin', 'https://chat.example'])), false)
})

test('IP policy rejects invalid roots, operations, hosts, origins, and malformed ranges', () => {
  for (const change of [
    { rootIds: ['missing'] },
    { operations: ['read', 'admin'] },
    { allowedHosts: ['attacker.example'] },
    { allowedCidrs: ['127.0.0.0/33'] },
    { allowedOrigins: ['*'] },
    { resource: 'https://startzorya.com/' },
  ]) assert.throws(() => parseRemoteIpPolicy({ ...base, ...change }, ['repo']))
})

test('IP policy rejects all-address IPv4 and IPv6 CIDRs for client and trusted-proxy ranges', () => {
  for (const cidr of ['0.0.0.0/0', '::/0']) {
    assert.throws(() => parseRemoteIpPolicy({ ...base, allowedCidrs: [cidr] }, ['repo']))
    assert.throws(() => parseRemoteIpPolicy({ ...base, trustedProxyCidrs: [cidr] }, ['repo']))
  }

  const leastPrivilege = parseRemoteIpPolicy({
    ...base,
    allowedCidrs: ['192.0.2.17/32', '2001:db8::17/128'],
    trustedProxyCidrs: ['192.0.2.18/32', '2001:db8::18/128'],
  }, ['repo'])
  assert.deepEqual(leastPrivilege.allowedCidrs, ['192.0.2.17/32', '2001:db8::17/128'])
  assert.deepEqual(leastPrivilege.trustedProxyCidrs, ['192.0.2.18/32', '2001:db8::18/128'])
})

test('daemon policy parser requires an explicit canonical resource and rejects undeclared fields', () => {
  const { resource: _resource, ...withoutResource } = base
  assert.throws(() => parseSearchIpAccessPolicy(withoutResource, ['repo']))
  assert.throws(() => parseRemoteIpPolicy(withoutResource, ['repo']))
  assert.throws(() => parseSearchIpAccessPolicy({ ...base, surprise: true }, ['repo']))
})

test('public Host authority includes its configured port', () => {
  const value = { ...base, resource: 'https://startzorya.com:8443/mcp/search', allowedHosts: ['startzorya.com:8443'] }
  const policy = createSearchIpAccessPolicy(parseRemoteIpPolicy(value, ['repo']))
  assert.equal(policy.authorize(request('127.0.0.1', headers('startzorya.com:8443'))), true)
  assert.equal(policy.authorize(request('127.0.0.1', headers('startzorya.com'))), false)
})

