import { constants } from 'node:fs'
import { open, lstat } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import {
  BRIDGE_MAX_CHUNK_BYTES,
  BRIDGE_MAX_REQUEST_BYTES,
  BridgeContractError,
  parseBridgeRequest,
  parseBridgeManifest,
  parseBridgeResponse,
  validateBridgeFilePayload,
  type BridgeErrorCode,
  type BridgeManifest,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeScope,
} from './protocol.js'
import type { BridgeClientConfig } from './config.js'
import { parseBridgeClientConfig } from './config.js'
import type { BoundWorkspace, WorkspaceSnapshot } from './workspace.js'

export const BRIDGE_CLIENT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
export const BRIDGE_CLIENT_DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const credentialFileLimit = 16_384
const bearerPattern = /^[A-Za-z0-9\-._~+/]+=*$/u

export class BridgeClientError extends BridgeContractError {
  readonly settlement?: 'unconfirmed'
  readonly publication?: 'unconfirmed'
  readonly committed?: true
  readonly originalError?: unknown

  constructor(
    code: BridgeErrorCode,
    message: string,
    settlement?: 'unconfirmed',
    originalError?: unknown,
    publication?: 'unconfirmed',
    committed?: true,
  ) {
    super(code, message)
    this.name = 'BridgeClientError'
    if (settlement) this.settlement = settlement
    if (publication) this.publication = publication
    if (committed) this.committed = committed
    if (originalError !== undefined) this.originalError = originalError
  }
}

export interface BridgeHttpClientOptions {
  config: BridgeClientConfig
  fetch?: typeof fetch
  allowedDocumentPaths?: readonly string[]
  maxResponseBytes?: number
  requestTimeoutMs?: number
}

export interface SynchronizeWorkspaceOptions {
  workspace: BoundWorkspace
  snapshot: WorkspaceSnapshot
  signal?: AbortSignal
}

export interface SynchronizeWorkspaceResult {
  readonly scope: BridgeScope
  readonly generation: number
  readonly manifestHash: string
  readonly alreadyCurrent: boolean
  readonly operationId: string
}

function fail(code: BridgeErrorCode, message: string): never {
  throw new BridgeClientError(code, message)
}

async function readCredentialFile(path: string): Promise<string> {
  let before: Awaited<ReturnType<typeof lstat>>
  try { before = await lstat(path) } catch { return fail('AUTH', 'Bridge credential is unavailable') }
  if (!before!.isFile() || before!.isSymbolicLink() || before!.size < 1 || before!.size > credentialFileLimit || process.platform !== 'win32' && (before!.mode & 0o077) !== 0)
    return fail('AUTH', 'Bridge credential is unavailable')
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const info = await handle.stat()
    if (!info.isFile() || info.dev !== before!.dev || info.ino !== before!.ino || info.size < 1 || info.size > credentialFileLimit || process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      fail('AUTH', 'Bridge credential is unavailable')
    const raw = await handle.readFile()
    if (raw.length > credentialFileLimit) fail('AUTH', 'Bridge credential is unavailable')
    const text = raw.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(raw)) fail('AUTH', 'Bridge credential is unavailable')
    const credential = text.replace(/\r?\n$/u, '')
    if (!credential || /[\r\n]/u.test(credential)) fail('AUTH', 'Bridge credential is unavailable')
    return credential
  } catch (error) {
    if (error instanceof BridgeContractError) throw error
    return fail('AUTH', 'Bridge credential is unavailable')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function loadCredential(config: BridgeClientConfig): Promise<string> {
  const credential = config.credential.kind === 'env'
    ? process.env[config.credential.name]
    : await readCredentialFile(config.credential.path)
  if (typeof credential !== 'string' || credential.length > credentialFileLimit || !bearerPattern.test(credential))
    fail('AUTH', 'Bridge credential is unavailable')
  return credential
}

function canonicalEndpoint(input: string): string {
  let endpoint: URL
  try { endpoint = new URL(input) } catch { fail('CONFIG_INVALID', 'Bridge endpoint is invalid') }
  if (endpoint!.protocol !== 'https:' || endpoint!.username || endpoint!.password || endpoint!.search || endpoint!.hash || endpoint!.pathname === '/' || endpoint!.href !== input)
    fail('CONFIG_INVALID', 'Bridge endpoint is invalid')
  return endpoint!.href
}

function abortableRead(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(new Error('Bridge response read aborted'))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    reader.read().then((part) => {
      cleanup()
      resolve(part)
    }, (error: unknown) => {
      cleanup()
      reject(error)
    })
    if (signal.aborted) onAbort()
  })
}

async function readBoundedResponse(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await abortableRead(reader, signal)
      if (part.done) break
      size += part.value.byteLength
      if (size > limit) {
        void reader.cancel().catch(() => undefined)
        fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge response exceeds the size limit')
      }
      chunks.push(part.value)
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    throw error
  } finally {
    try { reader.releaseLock() } catch { /* The canceled stream may still be settling. */ }
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function expectedManifestHash(request: BridgeRequest): string | null | undefined {
  if (request.action === 'plan') return request.manifest.manifestHash
  if (request.action === 'put' || request.action === 'commit' || request.action === 'call' || request.action === 'cancel')
    return request.expectedManifestHash
  return undefined
}

function validateResponseMatch(request: BridgeRequest, response: BridgeResponse): void {
  if (response.action !== request.action || response.operationId !== request.operationId || stable(response.scope) !== stable(request.scope))
    fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge response identity does not match the request')
  if (!response.ok) {
    const expected = expectedManifestHash(request)
    if (expected !== undefined && (!('expectedManifestHash' in response) || response.expectedManifestHash !== expected))
      fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge response manifest identity does not match the request')
    return
  }
  if (request.action === 'plan') {
    const plan = response as Extract<BridgeResponse, { action: 'plan'; ok: true }>
    if (plan.uploadId !== request.operationId || plan.expectedManifestHash !== request.manifest.manifestHash)
      fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge plan does not match the requested manifest')
  }
  if (request.action === 'put') {
    const put = response as Extract<BridgeResponse, { action: 'put'; ok: true }>
    if (put.baseGeneration !== request.baseGeneration || put.expectedManifestHash !== request.expectedManifestHash || put.path !== request.path)
      fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge upload response does not match the request')
    const chunk = Buffer.from(request.dataBase64, 'base64')
    if (
      put.receivedBytes !== request.offset + chunk.byteLength ||
      put.receivedBytes > request.expectedBytes ||
      put.complete !== (put.receivedBytes === request.expectedBytes)
    )
      fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge upload byte count does not match the request')
  }
  if (request.action === 'commit') {
    const commit = response as Extract<BridgeResponse, { action: 'commit'; ok: true }>
    if (commit.expectedManifestHash !== request.expectedManifestHash)
      fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge commit does not match the requested manifest')
  }
  if (request.action === 'cancel') {
    const cancel = response as Extract<BridgeResponse, { action: 'cancel'; ok: true }>
    if (cancel.targetGeneration !== request.targetGeneration || cancel.expectedManifestHash !== request.expectedManifestHash || cancel.targetOperationId !== request.targetOperationId)
      fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge cancellation does not match the request')
  }
  if (request.action === 'call') {
    const call = response as Extract<BridgeResponse, { action: 'call'; ok: true }>
    if (request.generation === null) {
      if (call.generation !== null || call.expectedManifestHash !== null || call.manifestHash !== null || call.provenance.kind !== 'source_free')
        fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge source-free call response does not match the request')
    } else if (
      call.generation !== request.generation ||
      call.expectedManifestHash !== request.expectedManifestHash ||
      call.manifestHash !== request.expectedManifestHash ||
      call.provenance.kind !== 'analytical_snapshot' ||
      call.provenance.generation !== request.generation ||
      call.provenance.manifestHash !== request.expectedManifestHash
    )
      fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge call does not match the requested manifest')
  }
}

function fileBytes(snapshot: WorkspaceSnapshot, path: string, expectedHash: string, expectedBytes: number, allowedDocumentPaths: readonly string[]): Uint8Array {
  const bytes = snapshot.files.get(path)
  if (!bytes || bytes.byteLength !== expectedBytes || createHash('sha256').update(bytes).digest('hex') !== expectedHash)
    fail('STALE_GENERATION', 'Workspace snapshot bytes do not match its manifest')
  validateBridgeFilePayload(path, bytes, expectedHash, { allowedDocumentPaths })
  return Uint8Array.from(bytes)
}

export class BridgeHttpClient {
  readonly #endpoint: string
  readonly #credential: string
  readonly #fetch: typeof fetch
  readonly #allowedDocumentPaths: readonly string[]
  readonly #maxResponseBytes: number
  readonly #requestTimeoutMs: number

  private constructor(options: BridgeHttpClientOptions, credential: string) {
    this.#endpoint = canonicalEndpoint(options.config.endpoint)
    this.#credential = credential
    this.#fetch = options.fetch ?? fetch
    this.#allowedDocumentPaths = Object.freeze([...(options.allowedDocumentPaths ?? [])])
    const requestedLimit = options.maxResponseBytes ?? BRIDGE_CLIENT_MAX_RESPONSE_BYTES
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1)
      fail('CONFIG_INVALID', 'Bridge response size limit is invalid')
    this.#maxResponseBytes = Math.min(requestedLimit, BRIDGE_CLIENT_MAX_RESPONSE_BYTES)
    this.#requestTimeoutMs = options.requestTimeoutMs ?? BRIDGE_CLIENT_DEFAULT_REQUEST_TIMEOUT_MS
    if (!Number.isInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1 || this.#requestTimeoutMs > 120_000)
      fail('CONFIG_INVALID', 'Bridge request timeout is invalid')
  }

  static async create(options: BridgeHttpClientOptions): Promise<BridgeHttpClient> {
    let config: BridgeClientConfig
    try { config = await parseBridgeClientConfig(options.config, { cwd: process.cwd() }) } catch {
      fail('CONFIG_INVALID', 'Bridge client configuration is invalid')
    }
    return new BridgeHttpClient({ ...options, config: config! }, await loadCredential(config!))
  }

  async request(input: unknown, signal?: AbortSignal): Promise<BridgeResponse> {
    if (signal?.aborted) fail('CANCELLED', 'Bridge request was cancelled')
    const request = parseBridgeRequest(input, { allowedDocumentPaths: this.#allowedDocumentPaths })
    const body = JSON.stringify(request)
    if (Buffer.byteLength(body, 'utf8') > BRIDGE_MAX_REQUEST_BYTES)
      fail('REQUEST_TOO_LARGE', 'Bridge request exceeds the size limit')
    const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs)
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    const failIfAborted = () => {
      if (signal?.aborted) fail('CANCELLED', 'Bridge request was cancelled')
      if (timeoutSignal.aborted) fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge request timed out')
    }
    let response: Response
    try {
      response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${this.#credential}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        signal: requestSignal,
      })
    } catch {
      failIfAborted()
      fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge request failed')
    }
    if (response!.status === 401 || response!.status === 403) fail('AUTH', 'Bridge authentication or access was refused')
    if (!response!.ok && response!.status !== 400) fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge returned an unsuccessful HTTP status')
    let bytes: Uint8Array
    try { bytes = await readBoundedResponse(response!, this.#maxResponseBytes, requestSignal) } catch (error) {
      if (error instanceof BridgeContractError) throw error
      failIfAborted()
      fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge response could not be read')
    }
    failIfAborted()
    let decoded: unknown
    try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch {
      fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge response is not valid JSON')
    }
    let decodedText: string
    try { decodedText = JSON.stringify(decoded) } catch {
      fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge response is invalid')
    }
    if (decodedText!.includes(this.#credential))
      fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge response contains credential material')
    let parsed: BridgeResponse
    try { parsed = parseBridgeResponse(decoded, { allowedDocumentPaths: this.#allowedDocumentPaths }) } catch {
      fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge response does not match the protocol')
    }
    validateResponseMatch(request, parsed!)
    failIfAborted()
    if (response!.status === 400 && parsed!.ok)
      fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge returned an invalid HTTP error envelope')
    return parsed!
  }

  async synchronizeWorkspace(options: SynchronizeWorkspaceOptions): Promise<SynchronizeWorkspaceResult> {
    const { workspace, snapshot, signal } = options
    if (stable(snapshot.scope) !== stable(workspace.scope))
      fail('SCOPE_MISMATCH', 'Workspace snapshot scope does not match its binding')
    const manifest = parseBridgeManifest(snapshot.manifest, { allowedDocumentPaths: this.#allowedDocumentPaths })
    if (snapshot.files.size !== manifest.files.length)
      fail('MANIFEST_INVALID', 'Workspace snapshot bytes do not match its manifest')
    const initialManifest = await workspace.scan(signal)
    if (initialManifest.manifest.manifestHash !== manifest.manifestHash)
      fail('STALE_GENERATION', 'Workspace changed before synchronization')
    const verifiedBytes = new Map<string, Uint8Array>()
    for (const file of manifest.files)
      verifiedBytes.set(file.path, fileBytes(snapshot, file.path, file.sha256, file.bytes, this.#allowedDocumentPaths))

    const statusOperationId = randomUUID()
    const statusResponse = await this.request({
      schemaVersion: 1,
      operationId: statusOperationId,
      scope: workspace.scope,
      action: 'status',
    }, signal)
    if (!statusResponse.ok || statusResponse.action !== 'status')
      fail(statusResponse.ok ? 'UPSTREAM_PROTOCOL_ERROR' : statusResponse.error.code, 'Bridge status request failed')
    const baseGeneration = statusResponse.generation ?? 0
    const operationId = randomUUID()
    const targetGeneration = baseGeneration
    let pendingSync = false
    let commitAttempted = false
    let commitAcknowledged = false
    try {
      const planRequest = parseBridgeRequest({
        schemaVersion: 1,
        operationId,
        scope: workspace.scope,
        action: 'plan',
        baseGeneration,
        manifest,
      }, { allowedDocumentPaths: this.#allowedDocumentPaths })
      if (signal?.aborted) fail('CANCELLED', 'Bridge synchronization was cancelled')
      pendingSync = true
      const plan = await this.request(planRequest, signal)
      if (!plan.ok || plan.action !== 'plan')
        fail(plan.ok ? 'UPSTREAM_PROTOCOL_ERROR' : plan.error.code, 'Bridge synchronization plan failed')
      if (plan.uploadId !== operationId)
        fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge upload identity does not match the synchronization')
      if (plan.generation !== statusResponse.generation || plan.manifestHash !== statusResponse.manifestHash)
        fail('GENERATION_CONFLICT', 'Bridge generation changed while planning synchronization')
      const expected = new Map(manifest.files.map((file) => [file.path, file]))
      for (const missing of plan.missingFiles) {
        const source = expected.get(missing.path)
        if (!source || source.sha256 !== missing.sha256 || source.bytes !== missing.bytes)
          fail('MANIFEST_CONFLICT', 'Bridge requested a file outside the workspace manifest')
      }
      if (plan.alreadyCurrent) {
        pendingSync = false
        if (plan.missingFiles.length > 0)
          fail('MANIFEST_CONFLICT', 'Bridge marked a manifest with missing files as current')
        if (plan.generation === null) fail('SNAPSHOT_UNAVAILABLE', 'Bridge reported an unavailable current snapshot')
        const stillCurrent = await workspace.scan(signal)
        if (stillCurrent.manifest.manifestHash !== manifest.manifestHash)
          fail('STALE_GENERATION', 'Workspace changed during synchronization planning')
        return Object.freeze({ scope: workspace.scope, generation: plan.generation, manifestHash: manifest.manifestHash, alreadyCurrent: true, operationId })
      }
      for (const missing of plan.missingFiles) {
        const entry = expected.get(missing.path)!
        const payload = verifiedBytes.get(entry.path)!
        const chunkSize = Math.min(plan.maxChunkBytes, BRIDGE_MAX_CHUNK_BYTES)
        for (let offset = 0; offset < payload.byteLength || offset === 0; offset += chunkSize) {
          if (signal?.aborted) fail('CANCELLED', 'Bridge synchronization was cancelled')
          const chunk = payload.subarray(offset, Math.min(payload.byteLength, offset + chunkSize))
          const response = await this.request({
            schemaVersion: 1,
            operationId,
            scope: workspace.scope,
            action: 'put',
            baseGeneration,
            expectedManifestHash: manifest.manifestHash,
            path: entry.path,
            contentHash: entry.sha256,
            expectedBytes: entry.bytes,
            offset,
            dataBase64: Buffer.from(chunk).toString('base64'),
          }, signal)
          if (!response.ok || response.action !== 'put')
            fail(response.ok ? 'UPSTREAM_PROTOCOL_ERROR' : response.error.code, 'Bridge file upload failed')
          const expectedReceived = offset + chunk.byteLength
          if (response.receivedBytes !== expectedReceived || response.complete !== (expectedReceived === entry.bytes))
            fail('UPSTREAM_PROTOCOL_ERROR', 'Bridge upload progress does not match the file')
          if (payload.byteLength === 0) break
        }
      }
      const beforeCommit = await workspace.scan(signal)
      if (beforeCommit.manifest.manifestHash !== manifest.manifestHash)
        fail('STALE_GENERATION', 'Workspace changed before synchronization commit')
      const commitRequest = parseBridgeRequest({
        schemaVersion: 1,
        operationId,
        scope: workspace.scope,
        action: 'commit',
        baseGeneration,
        expectedManifestHash: manifest.manifestHash,
      }, { allowedDocumentPaths: this.#allowedDocumentPaths })
      if (signal?.aborted) fail('CANCELLED', 'Bridge synchronization was cancelled')
      commitAttempted = true
      const committed = await this.request(commitRequest, signal)
      if (!committed.ok || committed.action !== 'commit')
        fail(committed.ok ? 'UPSTREAM_PROTOCOL_ERROR' : committed.error.code, 'Bridge synchronization commit failed')
      if (committed.generation !== baseGeneration + 1)
        fail('GENERATION_CONFLICT', 'Bridge committed an unexpected generation')
      commitAcknowledged = true
      pendingSync = false
      const afterCommit = await workspace.scan(signal)
      if (afterCommit.manifest.manifestHash !== manifest.manifestHash)
        throw new BridgeClientError('STALE_GENERATION', 'Bridge snapshot committed, but the workspace changed afterward', undefined, undefined, undefined, true)
      return Object.freeze({ scope: workspace.scope, generation: committed.generation, manifestHash: committed.manifestHash, alreadyCurrent: false, operationId })
    } catch (error) {
      if (commitAcknowledged) {
        if (error instanceof BridgeClientError && error.committed) throw error
        const code = error instanceof BridgeContractError ? error.code : 'UPSTREAM_PROTOCOL_ERROR'
        throw new BridgeClientError(code, 'Bridge snapshot committed, but local verification failed', undefined, error, undefined, true)
      }
      if (!pendingSync) throw error
      const settled = await this.cancelOwnedOperation(workspace.scope, targetGeneration, manifest.manifestHash, operationId)
      if (commitAttempted) {
        const code = error instanceof BridgeContractError ? error.code : 'UPSTREAM_PROTOCOL_ERROR'
        throw new BridgeClientError(
          code,
          'Bridge commit acknowledgement was not confirmed; publication outcome is unconfirmed',
          settled ? undefined : 'unconfirmed',
          error,
          'unconfirmed',
        )
      }
      if (!settled) {
        const code = error instanceof BridgeContractError ? error.code : 'UPSTREAM_PROTOCOL_ERROR'
        throw new BridgeClientError(code, 'Bridge synchronization failed and settlement is unconfirmed', 'unconfirmed', error)
      }
      throw error
    }
  }

  private async cancelOwnedOperation(scope: BridgeScope, targetGeneration: number, manifestHash: string, targetOperationId: string): Promise<boolean> {
    const request: BridgeRequest = {
      schemaVersion: 1,
      operationId: randomUUID(),
      scope,
      action: 'cancel',
      targetGeneration,
      expectedManifestHash: manifestHash,
      targetOperationId,
    }
    try {
      const response = await this.request(request, AbortSignal.timeout(10_000))
      return response.ok && response.action === 'cancel' && response.settled
    } catch {
      return false
    }
  }
}

export async function createBridgeHttpClient(options: BridgeHttpClientOptions): Promise<BridgeHttpClient> {
  return BridgeHttpClient.create(options)
}

export type BridgeClientRequest = BridgeRequest
export type BridgeClientResponse = BridgeResponse
export type BridgeClientManifest = BridgeManifest
