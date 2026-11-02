import { BridgeContractError } from '../bridge/protocol.js'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

interface LocalCallContext {
  mcpReq?: { _meta?: unknown; threadId?: unknown }
  threadId?: unknown
}

export interface LocalConversationIdentity {
  readonly conversationId: string
  readonly meta: Record<string, unknown>
}

export function parseLocalConversationIdentity(input: unknown): LocalConversationIdentity {
  const ctx = input && typeof input === 'object' ? input as LocalCallContext : undefined
  const request = ctx?.mcpReq
  const rawMeta = request?._meta
  if (rawMeta !== undefined && (!rawMeta || typeof rawMeta !== 'object' || Array.isArray(rawMeta)))
    throw new BridgeContractError('CONVERSATION_UNRESOLVED')
  const meta = rawMeta as Record<string, unknown> | undefined
  const native = meta?.['x-codex-turn-metadata']
  if (native !== undefined && (!native || typeof native !== 'object' || Array.isArray(native)))
    throw new BridgeContractError('CONVERSATION_UNRESOLVED')
  const nativeId = (native as Record<string, unknown> | undefined)?.thread_id
  const aliases = [nativeId, meta?.threadId, request?.threadId, ctx?.threadId].filter((value) => value !== undefined)
  if (aliases.length === 0 || aliases.some((value) => typeof value !== 'string' || !uuidPattern.test(value)) || aliases.some((value) => value !== aliases[0]))
    throw new BridgeContractError('CONVERSATION_UNRESOLVED')
  const forwarded = { ...(meta ?? {}) }
  if (!Object.hasOwn(forwarded, 'threadId') && typeof (request?.threadId ?? ctx?.threadId) === 'string')
    forwarded.threadId = request?.threadId ?? ctx?.threadId
  return { conversationId: aliases[0] as string, meta: forwarded }
}
