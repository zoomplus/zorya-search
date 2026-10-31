export function parseBearer(authorization: string | string[] | undefined): string | undefined {
  if (typeof authorization !== 'string') return undefined
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(authorization)
  const token = match?.[1]
  return token && token.length <= 8192 ? token : undefined
}

export function hostAllowed(
  hostHeader: string | undefined,
  boundPort: number,
  allowedHosts: readonly string[] | undefined,
  local: boolean,
): boolean {
  if (!hostHeader) return false
  let parsed: URL
  try {
    parsed = new URL(`http://${hostHeader}`)
  } catch {
    return false
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    (allowedHosts
      ? !allowedHosts.includes(hostHeader) && !allowedHosts.includes(parsed.hostname)
      : Number(parsed.port) !== boundPort)
  ) {
    return false
  }
  if (allowedHosts)
    return allowedHosts.includes(hostHeader) || allowedHosts.includes(parsed.hostname)
  return local && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
}

export function originAllowed(
  origin: string | undefined,
  boundPort: number,
  allowedOrigins: readonly string[] | undefined,
  local: boolean,
): boolean {
  if (!origin) return true
  if (allowedOrigins) return allowedOrigins.includes(origin)
  if (!local) return false
  try {
    const parsed = new URL(origin)
    return (
      parsed.protocol === 'http:' &&
      parsed.port === String(boundPort) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    )
  } catch {
    return false
  }
}
