import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { NodeStreamableHTTPServerTransport, toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler, isInitializeRequest, isJsonContentType, isLegacyRequest } from '@modelcontextprotocol/server'
import { normalizeIncomingMessage, readWebRequest } from '../daemon/http-request.js'
import { PACKAGE_VERSION } from '../package-version.js'
import { LocalWorkspaceError, type LocalWorkspace } from './owner.js'
import { createLocalMcpServer, createLocalMcpSharedState } from './mcp.js'

interface Session {
  readonly id: string
  readonly transport: NodeStreamableHTTPServerTransport
  readonly mcp: Awaited<ReturnType<typeof createLocalMcpServer>>
  active: number
  lastActive: number
}

export interface LocalOwnerHttpHandle {
  readonly host: '127.0.0.1'
  readonly port: number
  close(): Promise<void>
}

function matchesBearer(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7))
  const expected = Buffer.from(token)
  return supplied.length >= 43 && supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function reject(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'cache-control': 'no-store', connection: 'close' }).end()
}

function loopbackPeer(req: IncomingMessage): boolean {
  return req.socket.remoteAddress === '127.0.0.1'
}

export async function startLocalOwnerHttp(workspace: LocalWorkspace, options: { idleTimeoutMs?: number; onStop?: () => void } = {}): Promise<LocalOwnerHttpHandle> {
  const token = randomBytes(32).toString('base64url')
  const sessions = new Map<string, Session>()
  const activeRequests = new Set<Promise<void>>()
  const openingMcps = new Set<Awaited<ReturnType<typeof createLocalMcpServer>>>()
  const modernHandlers = new Set<ReturnType<typeof createMcpHandler>>()
  const sockets = new Set<import('node:net').Socket>()
  const shared = createLocalMcpSharedState()
  const maxSessions = 16
  const maxRequests = 32
  let initializing = 0
  let closing: Promise<void> | undefined
  let accepting = true
  let port = 0
  const idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000

  const server = createServer((req, res) => {
    const task = (async () => {
      let initializationReserved = false
      let openingMcp: Awaited<ReturnType<typeof createLocalMcpServer>> | undefined
      let newTransport: NodeStreamableHTTPServerTransport | undefined
      if (!accepting) return reject(res, 503)
      if (!loopbackPeer(req)) return reject(res, 403)
      if (req.headers.origin !== undefined) return reject(res, 403)
      if (req.headers.host !== `127.0.0.1:${port}`) return reject(res, 403)
      if (!matchesBearer(req.headers.authorization, token)) return reject(res, 401)
      if (req.url === '/_control/stop') {
        if (req.method !== 'POST' || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') || req.headers['transfer-encoding'] !== undefined)
          return reject(res, 405)
        res.writeHead(202, { 'cache-control': 'no-store', connection: 'close' }).end()
        setImmediate(() => options.onStop?.())
        return
      }
      if (req.url !== '/mcp') return reject(res, 404)
      if (!['POST', 'GET', 'DELETE'].includes(req.method ?? '')) return reject(res, 405)
      if (activeRequests.size >= maxRequests) return reject(res, 503)

      const requestController = new AbortController()
      const abortRequest = () => requestController.abort(new Error('LOCAL_HTTP_DISCONNECTED'))
      req.once('aborted', abortRequest)
      res.once('close', () => { if (!res.writableEnded) abortRequest() })
      let parsedBody: unknown
      let webRequest: Request | undefined
      try {
        if (req.method === 'POST' && !isJsonContentType(req.headers['content-type'] ?? '')) return reject(res, 415)
        const parsed = await readWebRequest(normalizeIncomingMessage(req), requestController.signal, 1_000_000)
        parsedBody = parsed.parsedBody
        webRequest = parsed.webRequest
      } catch {
        return reject(res, requestController.signal.aborted ? 499 : 400)
      } finally {
        req.removeListener('aborted', abortRequest)
      }

      try {
        const adapted = normalizeIncomingMessage(req)
        if (!webRequest || !(await isLegacyRequest(webRequest, parsedBody, { maxRequestBodySize: 1_000_000 }))) {
          let modernMcp: Awaited<ReturnType<typeof createLocalMcpServer>> | undefined
          const handler = createMcpHandler(async () => {
            modernMcp = await createLocalMcpServer(workspace, shared)
            openingMcps.add(modernMcp)
            return modernMcp.server
          }, { legacy: 'reject', maxRequestBodySize: 1_000_000 })
          modernHandlers.add(handler)
          try { await toNodeHandler(handler)(adapted, res, parsedBody) }
          finally {
            modernHandlers.delete(handler)
            await handler.close().catch(() => undefined)
            if (modernMcp) {
              openingMcps.delete(modernMcp)
              await modernMcp.close().catch(() => undefined)
            }
          }
          return
        }
        const sessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined
        let session = sessionId ? sessions.get(sessionId) : undefined
        if (sessionId && !session) return reject(res, 404)
        if (!session) {
          if (req.method !== 'POST' || sessionId || !isInitializeRequest(parsedBody) || sessions.size + initializing >= maxSessions) return reject(res, 400)
          initializing++
          initializationReserved = true
          openingMcp = await createLocalMcpServer(workspace, shared)
          openingMcps.add(openingMcp)
          if (!accepting) return reject(res, 503)
          let provisional!: Session
          newTransport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            maxRequestBodySize: 1_000_000,
            onsessioninitialized: (id) => {
              const initialized = { ...provisional, id, active: 1, lastActive: Date.now() }
              session = initialized
              sessions.set(id, initialized)
              if (openingMcp) openingMcps.delete(openingMcp)
            },
            onsessionclosed: async (id) => {
              const closed = sessions.get(id)
              sessions.delete(id)
              await closed?.mcp.close().catch(() => undefined)
            },
          })
          newTransport.onclose = () => {
            const id = newTransport?.sessionId
            if (id) {
              const closed = sessions.get(id)
              sessions.delete(id)
              void closed?.mcp.close().catch(() => undefined)
            }
          }
          await openingMcp.server.connect(newTransport)
          provisional = { id: '', transport: newTransport, mcp: openingMcp, active: 1, lastActive: Date.now() }
          session = provisional
        } else {
          session.active++
          session.lastActive = Date.now()
        }
        if (!session) return reject(res, 500)
        await session.transport.handleRequest(req, res, parsedBody)
      } finally {
        if (initializationReserved) initializing--
        if (openingMcp) {
          openingMcps.delete(openingMcp)
          if (!newTransport?.sessionId) await openingMcp.close().catch(() => undefined)
        }
        const sessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : newTransport?.sessionId
        const settledSession = sessionId ? sessions.get(sessionId) : undefined
        if (settledSession) {
          settledSession.active = Math.max(0, settledSession.active - 1)
          settledSession.lastActive = Date.now()
        }
      }
    })()
    activeRequests.add(task)
    void task.catch(() => { if (!res.headersSent && !res.destroyed) reject(res, 500) })
      .finally(() => activeRequests.delete(task))
  })
  server.maxConnections = 64
  server.headersTimeout = 10_000
  server.requestTimeout = 30_000
  server.keepAliveTimeout = 5_000
  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const session of sessions.values()) {
      if (session.active === 0 && now - session.lastActive >= idleTimeoutMs) {
        sessions.delete(session.id)
        void session.transport.close().catch(() => undefined)
        void session.mcp.close().catch(() => undefined)
      }
    }
  }, Math.min(60_000, Math.max(50, Math.floor(idleTimeoutMs / 2))))
  sweeper.unref()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  try {
    await new Promise<void>((resolve, rejectPromise) => {
      server.once('error', rejectPromise)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', rejectPromise)
        const address = server.address()
        if (!address || typeof address === 'string') return rejectPromise(new Error('LOCAL_OWNER_BIND_FAILED'))
        port = address.port
        resolve()
      })
    })
    await workspace.publishService({ port, token, packageVersion: PACKAGE_VERSION })
  } catch {
    accepting = false
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined)
    throw new LocalWorkspaceError('LOCAL_STATE_INVALID')
  }

  return Object.freeze({
    host: '127.0.0.1' as const,
    port,
    close() {
      if (!closing) closing = (async () => {
        accepting = false
        clearInterval(sweeper)
        const currentSessions = [...sessions.values()]
        for (const session of currentSessions) await session.transport.close().catch(() => undefined)
        await Promise.allSettled(currentSessions.map((session) => session.mcp.close()))
        await Promise.all([...modernHandlers].map((handler) => handler.close().catch(() => undefined)))
        await Promise.allSettled([...openingMcps].map((mcp) => mcp.close()))
        openingMcps.clear()
        sessions.clear()
        for (const socket of sockets) socket.destroy()
        server.closeAllConnections()
        await Promise.allSettled([...activeRequests])
        await new Promise<void>((resolve, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolve()))
      })()
      return closing
    },
  })
}
