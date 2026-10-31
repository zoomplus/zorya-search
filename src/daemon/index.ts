import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { Socket } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from 'node:timers'
import {
  createMcpHandler,
  isInitializeRequest,
  isJsonContentType,
  isLegacyRequest,
} from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport, toNodeHandler } from '@modelcontextprotocol/node'
import { openSearchRuntime, openSearchRuntimeFromFile } from '../runtime/index.js'
import type { RuntimeOptions } from '../runtime/index.js'
import { createSearchMcpServer, type SearchMcpAccess } from '../mcp/server.js'
import { hostAllowed, originAllowed, parseBearer } from './http-policy.js'
import { normalizeIncomingMessage, readWebRequest } from './http-request.js'

export interface SearchDaemonOptions {
  config?: unknown
  configPath?: string
  runtimeOptions?: Omit<RuntimeOptions, 'config' | 'configDir'>
  host?: string
  port?: number
  /** Owner-local bearer credential. Keep it in a private secret store, never in a URL or argv. */
  bearerToken?: string
  /** Trusted verifier for remote principals. The caller cannot supply its own grants. */
  authorize?: (
    bearer: string,
    signal: AbortSignal,
  ) => Promise<(SearchMcpAccess & { principalId: string }) | undefined>
  allowedHosts?: readonly string[]
  allowedOrigins?: readonly string[]
  path?: string
  maxLegacySessions?: number
  legacyIdleTimeoutMs?: number
}

type LegacySession = {
  transport: NodeStreamableHTTPServerTransport
  principal: string
  grants: string
  active: number
  lastActive: number
}

export async function startSearchDaemon(options: SearchDaemonOptions) {
  const host = options.host ?? '127.0.0.1'
  const local = host === '127.0.0.1' || host === '::1' || host === 'localhost'
  if (
    !local &&
    (!options.authorize || !options.allowedHosts?.length || !options.allowedOrigins?.length)
  )
    throw new Error('DAEMON_REMOTE_POLICY_REQUIRED')
  if (
    options.allowedHosts &&
    (options.allowedHosts.length > 32 || options.allowedHosts.some((value) => value.length > 256))
  )
    throw new Error('DAEMON_HOST_POLICY_INVALID')
  if (
    options.allowedOrigins &&
    (options.allowedOrigins.length > 32 ||
      options.allowedOrigins.some((value) => value.length > 2048))
  )
    throw new Error('DAEMON_ORIGIN_POLICY_INVALID')
  if (
    !options.authorize &&
    (!options.bearerToken || options.bearerToken.length < 32 || options.bearerToken.length > 8192)
  )
    throw new Error('DAEMON_OWNER_TOKEN_REQUIRED')
  const runtime = options.configPath
    ? await openSearchRuntimeFromFile(options.configPath, options.runtimeOptions)
    : await openSearchRuntime({ ...(options.runtimeOptions ?? {}), config: options.config })
  const path = options.path ?? '/mcp'
  if (!/^\/[A-Za-z0-9/_-]{1,127}$/.test(path) || path.includes('//')) {
    await runtime.close()
    throw new Error('DAEMON_PATH_INVALID')
  }
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
  ) {
    await runtime.close()
    throw new Error('DAEMON_PORT_INVALID')
  }
  const sessions = new Map<string, LegacySession>()
  const modernHandlers = new Set<ReturnType<typeof createMcpHandler>>()
  const activeHttpRequests = new Set<Promise<void>>()
  const requestControllers = new Set<AbortController>()
  const sockets = new Set<Socket>()
  const authorizationJobs = new Set<Promise<unknown>>()
  const maxActiveHttpRequests = 64
  const maxAuthorizationJobs = 32
  let closing = false
  let initializing = 0
  const ownerController = new AbortController()
  const maxSessions = options.maxLegacySessions ?? 64
  const idleSessionMs = options.legacyIdleTimeoutMs ?? 15 * 60_000
  if (
    !Number.isInteger(maxSessions) ||
    maxSessions < 1 ||
    maxSessions > 256 ||
    !Number.isInteger(idleSessionMs) ||
    idleSessionMs < 100 ||
    idleSessionMs > 30 * 60_000
  ) {
    await runtime.close()
    throw new Error('DAEMON_SESSION_LIMIT_INVALID')
  }
  const localAccess: SearchMcpAccess & { principalId: string } = {
    principalId: 'local-owner',
    rootIds: runtime.listRoots().map((root) => root.id),
    operations: ['read', 'index', 'web', 'classify'],
  }
  const closeSession = async (session: LegacySession) => {
    if (session.transport.sessionId) sessions.delete(session.transport.sessionId)
    await session.transport.close().catch(() => undefined)
  }
  const sweep = setInterval(
    () => {
      const now = Date.now()
      for (const session of sessions.values())
        if (session.active === 0 && now - session.lastActive >= idleSessionMs)
          void closeSession(session)
    },
    Math.min(60_000, Math.max(50, Math.floor(idleSessionMs / 2))),
  )
  sweep.unref()
  const httpServer = createHttpServer((req, res) => {
    if (closing) {
      res.writeHead(503).end()
      return
    }
    if (activeHttpRequests.size >= maxActiveHttpRequests) {
      res.writeHead(503).end()
      return
    }
    const requestController = new AbortController()
    requestControllers.add(requestController)
    const requestTask = (async () => {
      const abortRequest = () => requestController.abort(new Error('HTTP_CLIENT_DISCONNECTED'))
      req.once('aborted', abortRequest)
      res.once('close', () => {
        if (!res.writableEnded) abortRequest()
      })
      try {
        if (closing) {
          res.writeHead(503).end()
          return
        }
        if (req.url?.split('?')[0] !== path) {
          res.writeHead(404).end()
          return
        }
        if (!['POST', 'GET', 'DELETE', 'OPTIONS'].includes(req.method ?? '')) {
          res.writeHead(405).end()
          return
        }
        const hostHeader = req.headers.host?.toLowerCase()
        const origin = req.headers.origin
        const address = httpServer.address()
        const boundPort = address && typeof address === 'object' ? address.port : -1
        const hostIsAllowed = hostAllowed(hostHeader, boundPort, options.allowedHosts, local)
        const originIsAllowed = originAllowed(origin, boundPort, options.allowedOrigins, local)
        if (!hostIsAllowed || !originIsAllowed) {
          res.writeHead(403).end()
          return
        }
        const authorization = req.headers.authorization
        const bearer = parseBearer(authorization)
        if (!bearer) {
          res.writeHead(401, { 'www-authenticate': 'Bearer' }).end()
          return
        }
        let access: (SearchMcpAccess & { principalId: string }) | undefined
        try {
          if (options.authorize) {
            if (authorizationJobs.size >= maxAuthorizationJobs) {
              res.writeHead(503).end()
              return
            }
            const authorizationController = new AbortController()
            const authorizationSignal = AbortSignal.any([
              requestController.signal,
              ownerController.signal,
              authorizationController.signal,
            ])
            const job = options.authorize(bearer, authorizationSignal)
            authorizationJobs.add(job)
            void job.finally(() => authorizationJobs.delete(job)).catch(() => undefined)
            let timeout: NodeJS.Timeout | undefined
            let finishAuthWait: (() => void) | undefined
            const timed = new Promise<undefined>((resolve) => {
              const done = () => resolve(undefined)
              finishAuthWait = () => {
                requestController.signal.removeEventListener('abort', done)
                ownerController.signal.removeEventListener('abort', done)
              }
              requestController.signal.addEventListener('abort', done, { once: true })
              ownerController.signal.addEventListener('abort', done, { once: true })
              timeout = setNodeTimeout(() => {
                authorizationController.abort(new Error('AUTHORIZATION_DEADLINE'))
                done()
              }, 10_000)
            })
            try {
              access = snapshotAccess(
                await Promise.race([job, timed]),
                runtime.listRoots().map((root) => root.id),
                true,
              )
            } finally {
              if (timeout) clearNodeTimeout(timeout)
              finishAuthWait?.()
            }
          } else if (bearer && constantTimeEqual(bearer, options.bearerToken!))
            access = snapshotAccess(
              localAccess,
              runtime.listRoots().map((root) => root.id),
              false,
            )
        } catch {
          access = undefined
        }
        if (closing || requestController.signal.aborted) {
          if (!res.headersSent && !res.destroyed) res.writeHead(closing ? 503 : 499).end()
          return
        }
        if (!access) {
          res.writeHead(401, { 'www-authenticate': 'Bearer' }).end()
          return
        }
        const principal = access.principalId
        const grants = grantKey(access)
        const adapted = normalizeIncomingMessage(req)
        const declaredLength = req.headers['content-length']
        if (
          typeof declaredLength === 'string' &&
          /^\d+$/.test(declaredLength) &&
          Number(declaredLength) > 1_048_576
        ) {
          res.setHeader('Connection', 'close')
          req.resume()
          res.writeHead(413).end()
          return
        }
        const { webRequest, parsedBody } = await readWebRequest(
          adapted,
          requestController.signal,
          1_048_576,
        )
        if (
          req.method === 'POST' &&
          !isJsonContentType(webRequest.headers.get('content-type') ?? '')
        ) {
          res.writeHead(415).end()
          return
        }
        if (req.method === 'POST' && parsedBody === undefined) {
          res.writeHead(400).end()
          return
        }
        if (await isLegacyRequest(webRequest, parsedBody, { maxRequestBodySize: 1_048_576 })) {
          if (closing || requestController.signal.aborted) return
          await routeLegacy(adapted, res, parsedBody, access, principal, grants)
          return
        }
        if (closing || requestController.signal.aborted) return
        const handler = createMcpHandler(
          () => createSearchMcpServer(runtime, access!, requestController.signal),
          { legacy: 'reject', maxRequestBodySize: 1_048_576 },
        )
        modernHandlers.add(handler)
        try {
          const nodeHandler = toNodeHandler(handler)
          await nodeHandler(adapted, res, parsedBody)
        } finally {
          modernHandlers.delete(handler)
          await handler.close().catch(() => undefined)
        }
      } finally {
        req.removeListener('aborted', abortRequest)
        requestControllers.delete(requestController)
      }
    })().catch((error: unknown) => {
      if (res.headersSent) return
      const status =
        error &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'RequestBodyTooLargeError'
          ? 413
          : 500
      res.writeHead(status).end()
    })
    activeHttpRequests.add(requestTask)
    void requestTask.finally(() => activeHttpRequests.delete(requestTask)).catch(() => undefined)
  })
  httpServer.maxConnections = 128
  httpServer.headersTimeout = 10_000
  httpServer.requestTimeout = 30_000
  httpServer.keepAliveTimeout = 5_000
  httpServer.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  async function routeLegacy(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
    access: SearchMcpAccess,
    principal: string,
    grants: string,
  ) {
    const sessionId =
      typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined
    let session = sessionId ? sessions.get(sessionId) : undefined
    if (sessionId && (!session || session.principal !== principal || session.grants !== grants)) {
      res.writeHead(404).end()
      return
    }
    if (!session && !sessionId && isInitializeRequest(body)) {
      if (sessions.size + initializing >= maxSessions) {
        res.writeHead(503).end()
        return
      }
      initializing++
      let transport!: NodeStreamableHTTPServerTransport
      let release: (() => void) | undefined
      transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => cryptoRandomId(),
        onsessioninitialized: (id) => {
          session = { transport, principal, grants, active: 0, lastActive: Date.now() }
          sessions.set(id, session)
          release = holdResponse(session, res)
        },
      })
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId)
      }
      try {
        await createSearchMcpServer(runtime, access, ownerController.signal).connect(transport)
        await transport.handleRequest(req, res, body)
      } finally {
        initializing--
        if (release && (res.writableEnded || res.destroyed)) release()
      }
      return
    }
    if (!session) {
      res.writeHead(sessionId ? 404 : 400).end()
      return
    }
    const release = holdResponse(session, res)
    try {
      await session.transport.handleRequest(req, res, body)
    } finally {
      if (res.writableEnded || res.destroyed) release()
    }
  }
  let closePromise: Promise<void> | undefined
  const close = () =>
    (closePromise ??= (async () => {
      closing = true
      ownerController.abort(new Error('DAEMON_CLOSED'))
      for (const controller of requestControllers) controller.abort(new Error('DAEMON_CLOSED'))
      await Promise.all([...sessions.values()].map(closeSession))
      await Promise.all(
        [...modernHandlers].map((handler) => handler.close().catch(() => undefined)),
      )
      await Promise.allSettled([...activeHttpRequests])
      const serverClosed = new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      )
      for (const socket of sockets) socket.destroy()
      await serverClosed
      await Promise.allSettled([...authorizationJobs])
      clearInterval(sweep)
      await runtime.close()
    })())
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(options.port ?? 0, host, () => {
      httpServer.removeListener('error', reject)
      resolve()
    })
  }).catch(async (error) => {
    closing = true
    ownerController.abort(new Error('DAEMON_START_FAILED'))
    clearInterval(sweep)
    for (const socket of sockets) socket.destroy()
    await runtime.close().catch(() => undefined)
    throw error
  })
  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    await close()
    throw new Error('DAEMON_BIND_FAILED')
  }
  if (options.runtimeOptions?.signal?.aborted) {
    await close()
    throw new Error('DAEMON_START_ABORTED')
  }
  return { host, port: address.port, path, runtime, close }
}

function grantKey(access: SearchMcpAccess) {
  return JSON.stringify({
    roots: [...access.rootIds].sort(),
    operations: [...access.operations].sort(),
  })
}
function snapshotAccess(
  value: unknown,
  availableRoots: string[],
  requirePrincipal: boolean,
): (SearchMcpAccess & { principalId: string }) | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Partial<SearchMcpAccess> & { principalId?: unknown }
  if (
    !Array.isArray(candidate.rootIds) ||
    candidate.rootIds.length > 32 ||
    !Array.isArray(candidate.operations) ||
    candidate.operations.length > 4
  )
    return undefined
  const rootIds = [...candidate.rootIds]
  const operations = [...candidate.operations]
  if (
    rootIds.some(
      (id) =>
        typeof id !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) ||
        !availableRoots.includes(id),
    ) ||
    new Set(rootIds).size !== rootIds.length ||
    operations.some((operation) => !['read', 'index', 'web', 'classify'].includes(operation)) ||
    new Set(operations).size !== operations.length
  )
    return undefined
  const principalId = requirePrincipal ? candidate.principalId : 'local-owner'
  if (typeof principalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(principalId))
    return undefined
  return Object.freeze({
    rootIds: Object.freeze(rootIds),
    operations: Object.freeze(operations),
    principalId,
  })
}
function holdResponse(session: LegacySession, response: ServerResponse) {
  session.active++
  let released = false
  const release = () => {
    if (released) return
    released = true
    response.removeListener('close', release)
    session.active = Math.max(0, session.active - 1)
    session.lastActive = Date.now()
  }
  response.once('close', release)
  return release
}
function cryptoRandomId() {
  return globalThis.crypto.randomUUID()
}

function constantTimeEqual(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}
