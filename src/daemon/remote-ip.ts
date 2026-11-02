import { parseSearchIpAccessPolicy, type SearchIpAccessPolicy } from './ip-access.js'

export function parseRemoteIpPolicy(input: unknown, configuredRootIds: readonly string[]): SearchIpAccessPolicy {
  return parseSearchIpAccessPolicy(input, configuredRootIds)
}
