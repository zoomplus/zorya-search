import type { IncomingMessage } from 'node:http'
import { BlockList, isIP } from 'node:net'

export type SearchIpOperation = 'read' | 'index' | 'web' | 'classify' | 'visual'

export interface SearchIpAccessPolicy {
  readonly allowedCidrs: readonly string[]
  readonly trustedProxyCidrs: readonly string[]
  readonly principalId: string
  readonly rootIds: readonly string[]
  readonly operations: readonly SearchIpOperation[]
  readonly allowedOrigins: readonly string[]
  readonly resource: string
  readonly allowedHosts: readonly string[]
  readonly port: number
}

const operations = new Set<SearchIpOperation>(['read', 'index', 'web', 'classify', 'visual'])
const maxCidrs = 4096

function fail(): never { throw new Error('DAEMON_IP_POLICY_INVALID') }

function blockList(values: readonly string[], trusted: boolean): BlockList {
  if (!Array.isArray(values) || values.length > maxCidrs) fail()
  const result = new BlockList()
  for (const value of values) {
    if (typeof value !== 'string') fail()
    const parts = value.split('/')
    if (parts.length !== 2 || !/^(0|[1-9][0-9]*)$/.test(parts[1]!)) fail()
    const family = isIP(parts[0]!)
    const prefix = Number(parts[1])
    const max = family === 4 ? 32 : family === 6 ? 128 : -1
    if (max < 0 || !Number.isSafeInteger(prefix) || prefix < 0 || prefix > max || trusted && prefix === 0) fail()
    try { result.addSubnet(parts[0]!, prefix, family === 4 ? 'ipv4' : 'ipv6') } catch { fail() }
  }
  return result
}

function oneRawHeader(request: IncomingMessage, name: string): { present: boolean; value?: string } | undefined {
  let present = false
  let value: string | undefined
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]!.toLowerCase() !== name) continue
    if (present) return undefined
    present = true
    value = request.rawHeaders[index + 1]
  }
  return { present, ...(value === undefined ? {} : { value }) }
}

function allowedAddress(list: BlockList, address: string): boolean {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1]
  if (mapped && isIP(mapped) === 4) address = mapped
  const family = isIP(address)
  if (!family) return false
  try { return list.check(address, family === 4 ? 'ipv4' : 'ipv6') } catch { return false }
}

export function createSearchIpAccessPolicy(policy: SearchIpAccessPolicy) {
  const allowed = blockList([...policy.allowedCidrs], false)
  const trusted = blockList([...policy.trustedProxyCidrs], true)
  const origins = Object.freeze([...policy.allowedOrigins])
  const resourceHost = new URL(policy.resource).host
  return Object.freeze({
    authorize(request: IncomingMessage): boolean {
      const remote = request.socket.remoteAddress
      if (!remote || !isIP(remote)) return false
      let clientAddress = remote
      if (allowedAddress(trusted, remote)) {
        const forwarded = oneRawHeader(request, 'x-real-ip')
        if (!forwarded?.present || forwarded.value === undefined || !isIP(forwarded.value)) return false
        clientAddress = forwarded.value
      }
      if (!allowedAddress(allowed, clientAddress)) return false
      const origin = oneRawHeader(request, 'origin')
      if (!origin) return false
      if (origin.present) {
        if (!origin.value || !origins.includes(origin.value)) return false
      }
      const hostHeader = oneRawHeader(request, 'host')
      return Boolean(hostHeader?.present && hostHeader.value?.toLowerCase() === resourceHost.toLowerCase())
    },
  })
}

export function parseSearchIpAccessPolicy(input: unknown, configuredRootIds: readonly string[]): SearchIpAccessPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail()
  const value = input as Record<string, unknown>
  const knownKeys = new Set(['resource', 'allowedHosts', 'allowedCidrs', 'trustedProxyCidrs', 'allowedOrigins', 'principalId', 'rootIds', 'operations', 'port'])
  if (Object.keys(value).some((key) => !knownKeys.has(key))) fail()
  const resource = value.resource
  if (typeof resource !== 'string') fail()
  let url: URL
  try { url = new URL(resource) } catch { fail() }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const ipv4MappedLoopback = /^::ffff:(127(?:\.\d{1,3}){3})$/i.test(hostname)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname === '/' || url.search || url.hash || url.href !== resource || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' || /^127\./.test(hostname) || hostname === '0.0.0.0' || hostname === '::' || ipv4MappedLoopback) fail()
  const allowedCidrs = value.allowedCidrs
  const trustedProxyCidrs = value.trustedProxyCidrs
  const rootIds = value.rootIds
  const grantedOperations = value.operations
  const allowedOrigins = value.allowedOrigins
  if (!Array.isArray(allowedCidrs) || allowedCidrs.length < 1 || !Array.isArray(trustedProxyCidrs) || !Array.isArray(rootIds) || !rootIds.length || !Array.isArray(grantedOperations) || !grantedOperations.length || !Array.isArray(allowedOrigins) || !allowedOrigins.length) fail()
  blockList(allowedCidrs as string[], false)
  blockList(trustedProxyCidrs as string[], true)
  if (rootIds.length > 32 || rootIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) || !configuredRootIds.includes(id)) || new Set(rootIds).size !== rootIds.length) throw new Error('REMOTE_GRANT_ROOT_UNKNOWN')
  if (grantedOperations.length > 5 || grantedOperations.some((operation) => typeof operation !== 'string' || !operations.has(operation as SearchIpOperation)) || new Set(grantedOperations).size !== grantedOperations.length) fail()
  if (allowedOrigins.length > 32 || allowedOrigins.some((origin) => {
    if (typeof origin !== 'string') return true
    try { const parsed = new URL(origin); return parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password } catch { return true }
  })) fail()
  const principalId = value.principalId
  if (typeof principalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(principalId)) fail()
  const port = value.port === undefined ? 0 : value.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) fail()
  const allowedHosts = value.allowedHosts
  if (!Array.isArray(allowedHosts) || allowedHosts.length !== 1 || allowedHosts[0] !== url.host) fail()
  const frozenAllowedCidrs = Object.freeze([...(allowedCidrs as string[])])
  const frozenTrustedProxyCidrs = Object.freeze([...(trustedProxyCidrs as string[])])
  const frozenRootIds = Object.freeze([...(rootIds as string[])])
  const frozenOperations = Object.freeze([...(grantedOperations as SearchIpOperation[])])
  const frozenOrigins = Object.freeze([...new Set(allowedOrigins as string[])])
  const frozenHosts = Object.freeze([url.host])
  return Object.freeze({ allowedCidrs: frozenAllowedCidrs, trustedProxyCidrs: frozenTrustedProxyCidrs, principalId, rootIds: frozenRootIds, operations: frozenOperations, allowedOrigins: frozenOrigins, resource, allowedHosts: frozenHosts, port })
}
