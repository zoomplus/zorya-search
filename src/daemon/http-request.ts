import type { IncomingMessage } from 'node:http'
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from 'node:timers'
import type { NodeIncomingMessageLike } from '@modelcontextprotocol/node'

export function normalizeIncomingMessage(
  request: IncomingMessage,
): NodeIncomingMessageLike & IncomingMessage {
  if (
    !request.method ||
    !request.url ||
    !request.headers ||
    typeof request[Symbol.asyncIterator] !== 'function'
  ) {
    throw new Error('HTTP_REQUEST_INVALID')
  }
  return request as unknown as NodeIncomingMessageLike & IncomingMessage
}

/** Reads the Node stream once and supplies the parsed body to the SDK adapter. */
export async function readWebRequest(
  request: IncomingMessage,
  signal: AbortSignal,
  maxBytes: number,
) {
  const method = (request.method ?? 'GET').toUpperCase()
  let bodyText = ''
  let received = 0
  const decoder = new TextDecoder()
  const bodyController = new AbortController()
  const bodyDeadline = setNodeTimeout(
    () => bodyController.abort(new Error('HTTP_BODY_DEADLINE')),
    30_000,
  )
  const bodySignal = AbortSignal.any([signal, bodyController.signal])
  const abortInput = () => request.destroy()
  bodySignal.addEventListener('abort', abortInput, { once: true })
  try {
    if (method !== 'GET' && method !== 'HEAD') {
      for await (const chunk of request) {
        if (bodySignal.aborted) throw bodySignal.reason
        const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
        received += bytes
        if (received > maxBytes) {
          throw Object.assign(new Error('REQUEST_BODY_TOO_LARGE'), {
            name: 'RequestBodyTooLargeError',
          })
        }
        bodyText += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      }
      bodyText += decoder.decode()
    }
    if (bodySignal.aborted) throw bodySignal.reason

    let parsedBody: unknown
    if (bodyText) {
      try {
        parsedBody = JSON.parse(bodyText)
      } catch {
        parsedBody = undefined
      }
    }
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item)
      } else {
        headers.set(name, value)
      }
    }
    const host = headers.get('host') ?? 'localhost'
    const url = `http://${host}${request.url ?? '/'}`
    if (parsedBody !== undefined) {
      bodyText = JSON.stringify(parsedBody)
      headers.delete('content-encoding')
      headers.delete('transfer-encoding')
      headers.set('content-length', String(Buffer.byteLength(bodyText)))
    }
    const webRequest = new Request(url, {
      method,
      headers,
      signal: bodySignal,
      ...(bodyText && method !== 'GET' && method !== 'HEAD' ? { body: bodyText } : {}),
    })
    return { webRequest, parsedBody }
  } finally {
    clearNodeTimeout(bodyDeadline)
    bodySignal.removeEventListener('abort', abortInput)
  }
}
