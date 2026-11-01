import type { IncomingHttpHeaders } from 'node:http'
import type { SourceDocument } from '../core/contracts.js'

export const WEB_DOCUMENT_PARSER_VERSION = 'web-document-v1'

interface CacheEntry {
  readonly document: SourceDocument
  readonly etag?: string
  readonly lastModified?: string
  readonly revision: number
  readonly bytes: number
}

interface ActiveKey {
  latestRevision: number
  readonly revisions: Set<number>
}

export interface CacheTicket {
  readonly key: string
  readonly revision: number
  readonly entry?: CacheEntry
  readonly validators?: { etag?: string; lastModified?: string }
}

export class BraveDocumentCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly activeKeys = new Map<string, ActiveKey>()
  private revision = 0
  private totalBytes = 0

  constructor(
    private readonly capacity: number,
    private readonly byteCapacity: number,
  ) {}

  begin(url: string): CacheTicket {
    const key = this.key(url)
    const entry = this.entries.get(key)
    if (entry) {
      this.entries.delete(key)
      this.entries.set(key, entry)
    }
    const revision = ++this.revision
    const active = this.activeKeys.get(key) ?? { latestRevision: revision, revisions: new Set<number>() }
    active.latestRevision = revision
    active.revisions.add(revision)
    this.activeKeys.set(key, active)
    const validators = entry && (entry.etag || entry.lastModified)
      ? {
          ...(entry.etag ? { etag: entry.etag } : {}),
          ...(entry.lastModified ? { lastModified: entry.lastModified } : {}),
        }
      : undefined
    return {
      key,
      revision,
      ...(entry ? { entry } : {}),
      ...(validators ? { validators } : {}),
    }
  }

  release(ticket: CacheTicket): void {
    const active = this.activeKeys.get(ticket.key)
    if (!active) return
    active.revisions.delete(ticket.revision)
    if (active.revisions.size === 0) this.activeKeys.delete(ticket.key)
  }

  store(ticket: CacheTicket, document: SourceDocument, headers: IncomingHttpHeaders): void {
    if (!this.isLatest(ticket)) return
    const current = this.entries.get(ticket.key)
    if (current && current.revision > ticket.revision) return
    this.delete(ticket.key)
    if (!isCacheable(headers)) return
    const etag = safeValidator(header(headers, 'etag'))
    const lastModified = safeValidator(header(headers, 'last-modified'))
    if (!etag && !lastModified) return
    const copy = Object.freeze({ ...document })
    const bytes = documentBytes(copy)
    if (bytes > this.byteCapacity) return
    this.entries.set(ticket.key, {
      document: copy,
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
      revision: ticket.revision,
      bytes,
    })
    this.totalBytes += bytes
    this.trim()
  }

  refresh(ticket: CacheTicket, headers: IncomingHttpHeaders, fetchedAt: string): SourceDocument | null {
    if (!ticket.entry || !ticket.validators || !this.isLatest(ticket)) return null
    const current = this.entries.get(ticket.key)
    if (current !== ticket.entry) return null
    if (!isCacheable(headers)) {
      this.delete(ticket.key)
      return null
    }
    const document = Object.freeze({ ...ticket.entry.document, fetchedAt })
    const bytes = documentBytes(document)
    if (bytes > this.byteCapacity) {
      this.delete(ticket.key)
      return null
    }
    this.delete(ticket.key)
    this.entries.set(ticket.key, { ...ticket.entry, document, revision: ticket.revision, bytes })
    this.totalBytes += bytes
    this.trim()
    return this.entries.get(ticket.key)?.document === document ? { ...document } : null
  }

  private isLatest(ticket: CacheTicket): boolean {
    const active = this.activeKeys.get(ticket.key)
    return active?.latestRevision === ticket.revision && active.revisions.has(ticket.revision)
  }

  private key(url: string): string {
    return `${WEB_DOCUMENT_PARSER_VERSION}\u0000${url}`
  }

  private delete(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.totalBytes -= entry.bytes
  }

  private trim(): void {
    while (this.entries.size > this.capacity || this.totalBytes > this.byteCapacity) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) return
      this.delete(oldest)
    }
  }
}

function documentBytes(document: SourceDocument): number {
  return Buffer.byteLength(document.url) + Buffer.byteLength(document.title) +
    Buffer.byteLength(document.text) + Buffer.byteLength(document.fetchedAt) +
    Buffer.byteLength(document.publishedAt ?? '') + Buffer.byteLength(document.sourceUpdatedAt ?? '') + 128
}

function isCacheable(headers: IncomingHttpHeaders): boolean {
  if ((header(headers, 'vary') ?? '').split(',').some((value) => value.trim() === '*')) return false
  const cacheControl = header(headers, 'cache-control') ?? ''
  return !/(?:^|,)\s*(?:no-store|private)(?:\s|,|$)/iu.test(cacheControl)
}

function safeValidator(value: string | undefined): string | undefined {
  return value && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}
