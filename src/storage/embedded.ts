import { resolve } from 'node:path'
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { OwnedDatabase, QueryResult, QueryableDatabase } from './database.js'
import type { PGlite } from '@electric-sql/pglite'

const owners = new Map<string, symbol>()
const DEFAULT_MAX_PENDING = 64

/** Открывает локальную БД PostgreSQL с pgvector и эксклюзивным владельцем каталога. */
export async function openEmbeddedDatabase(dataDir: string, options: { maxPending?: number } = {}): Promise<OwnedDatabase> {
  await mkdir(resolve(dataDir), { recursive: true })
  const directory = await realpath(resolve(dataDir))
  if (owners.has(directory)) throw new Error('SEARCH_EMBEDDED_DIRECTORY_ALREADY_OWNED')
  const owner = Symbol(directory)
  owners.set(directory, owner)
  const lockPath = `${directory}/.zorya-search-owner`
  const lockNonce = randomUUID()
  let lockCreated = false
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined
  let lockIdentity: { dev: number; ino: number } | undefined
  const createLock = async () => {
    lockHandle = await open(lockPath, 'wx', 0o600)
    lockCreated = true
    const stat = await lockHandle.stat()
    lockIdentity = { dev: stat.dev, ino: stat.ino }
    await lockHandle.writeFile(JSON.stringify({ pid: process.pid, nonce: lockNonce }))
    await lockHandle.close()
    lockHandle = undefined
  }
  const releaseOwnedLock = async (): Promise<boolean> => {
    await lockHandle?.close().catch(() => undefined)
    lockHandle = undefined
    if (!lockCreated) return true
    try {
      const [current, text] = await Promise.all([lstat(lockPath), readFile(lockPath, 'utf8').catch(() => '')])
      let recordedNonce: unknown
      try { recordedNonce = (JSON.parse(text) as { nonce?: unknown }).nonce } catch { /* nonce ещё не записался целиком */ }
      const identityMatches = lockIdentity !== undefined && current.dev === lockIdentity.dev && current.ino === lockIdentity.ino
      if (!identityMatches || (recordedNonce !== undefined && recordedNonce !== lockNonce)) return false
      await unlink(lockPath)
    } catch { return false }
    lockCreated = false
    return true
  }
  let engine: PGlite | undefined
  let engineInitializationStarted = false
  try {
    try {
      await createLock()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      throw new Error('SEARCH_EMBEDDED_OWNER_LOCK_EXISTS')
    }
    const [{ PGlite }, { vector }] = await Promise.all([import('@electric-sql/pglite'), import('@electric-sql/pglite-pgvector')])
    engineInitializationStarted = true
    engine = await PGlite.create(directory, { extensions: { vector } })
    const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING
    if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 4096) throw new Error('SEARCH_DATABASE_QUEUE_LIMIT_INVALID')
    let pending = 0
    let closed = false
    let closing: Promise<void> | undefined
    const idleWaiters = new Set<() => void>()
    const admit = async <T>(operation: () => Promise<T>): Promise<T> => {
      if (closed) throw new Error('SEARCH_DATABASE_CLOSED')
      if (pending >= maxPending) throw new Error('SEARCH_DATABASE_QUEUE_FULL')
      pending++
      try { return await operation() } finally {
        pending--
        if (pending === 0) for (const wake of idleWaiters) wake()
      }
    }
    const query = <Row = Record<string, unknown>>(sql: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> =>
      admit(async () => {
        const result = await engine!.query<Row>(sql, [...values])
        return { rows: result.rows, rowCount: result.rowCount ?? 0 }
      })
    const exec = (sql: string): Promise<unknown> => admit(async () => engine!.exec(sql))
    const transaction = <T>(operation: (client: QueryableDatabase) => Promise<T>, signal?: AbortSignal): Promise<T> => admit(async () => {
      signal?.throwIfAborted()
      return engine!.transaction(async (tx) => {
        const scope = { alive: true }
        const client: QueryableDatabase = {
        query: async <Row = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => {
          if (!scope.alive) throw new Error('SEARCH_DATABASE_TRANSACTION_CLOSED')
          signal?.throwIfAborted()
          const result = await tx.query<Row>(sql, [...values])
          return { rows: result.rows, rowCount: result.rowCount ?? 0 }
        },
        exec: async (sql: string) => {
          if (!scope.alive) throw new Error('SEARCH_DATABASE_TRANSACTION_CLOSED')
          signal?.throwIfAborted()
          return tx.exec(sql)
        },
        transaction: async () => { throw new Error('SEARCH_DATABASE_NESTED_TRANSACTION_UNSUPPORTED') },
        }
        try {
          const result = await operation(client)
          signal?.throwIfAborted()
          return result
        } finally { scope.alive = false }
      })
    })
    return {
      kind: 'embedded', query, exec, transaction,
      close() {
        if (!closing) {
          closed = true
          closing = (async () => {
            if (pending > 0) await new Promise<void>((resolveIdle) => {
              const wake = () => { idleWaiters.delete(wake); resolveIdle() }
              idleWaiters.add(wake)
              if (pending === 0) wake()
            })
            await engine!.close()
            if (!(await releaseOwnedLock())) throw new Error('SEARCH_EMBEDDED_LOCK_RELEASE_FAILED')
            if (owners.get(directory) === owner) owners.delete(directory)
          })()
        }
        return closing
      },
    }
  } catch (error) {
    let safelyClosed = !engineInitializationStarted
    if (engine) {
      try {
        await engine.close()
        safelyClosed = true
      } catch (closeError) {
        throw new AggregateError([error, closeError], 'Embedded database initialization and shutdown failed; ownership lock retained')
      }
    }
    if (safelyClosed) {
      if (await releaseOwnedLock()) {
        if (owners.get(directory) === owner) owners.delete(directory)
      }
    }
    throw error
  }
}
