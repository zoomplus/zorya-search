import type { OwnedDatabase, QueryResult, QueryableDatabase } from './database.js'

interface PgClientLike {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>
  release(): void
}
export interface PgPoolLike {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>
  connect(): Promise<PgClientLike>
  end?(): Promise<void>
}

function createPostgresAdapter(pool: PgPoolLike, closePool: boolean): OwnedDatabase {
  let closed = false
  let closing: Promise<void> | undefined
  let pending = 0
  const idleWaiters = new Set<() => void>()
  const assertOpen = () => { if (closed) throw new Error('SEARCH_DATABASE_CLOSED') }
  const admit = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertOpen()
    pending++
    try { return await operation() } finally {
      pending--
      if (pending === 0) for (const wake of idleWaiters) wake()
    }
  }
  return {
    kind: 'postgres',
    async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
      return admit(async () => {
        const result = await pool.query<Row>(sql, [...values])
        return { rows: result.rows, rowCount: result.rowCount ?? 0 }
      })
    },
    async exec(sql: string) { return admit(async () => pool.query(sql)) },
    async transaction<T>(operation: (client: QueryableDatabase) => Promise<T>, signal?: AbortSignal): Promise<T> {
      return admit(async () => {
      signal?.throwIfAborted()
      const client = await pool.connect()
      const scope = { alive: true }
      try {
        await client.query('BEGIN')
        const scoped: QueryableDatabase = {
          query: async <Row = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => {
            if (!scope.alive) throw new Error('SEARCH_DATABASE_TRANSACTION_CLOSED')
            signal?.throwIfAborted()
            const result = await client.query<Row>(sql, [...values])
            return { rows: result.rows, rowCount: result.rowCount ?? 0 }
          },
          exec: async (sql: string) => {
            if (!scope.alive) throw new Error('SEARCH_DATABASE_TRANSACTION_CLOSED')
            signal?.throwIfAborted()
            return client.query(sql)
          },
          transaction: async () => { throw new Error('SEARCH_DATABASE_NESTED_TRANSACTION_UNSUPPORTED') },
        }
        const result = await operation(scoped)
        scope.alive = false
        signal?.throwIfAborted()
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally { scope.alive = false; client.release() }
      })
    },
    close() {
      if (!closing) {
        closed = true
        closing = (async () => {
          if (pending > 0) await new Promise<void>((resolveIdle) => {
            const wake = () => { idleWaiters.delete(wake); resolveIdle() }
            idleWaiters.add(wake)
            if (pending === 0) wake()
          })
          if (closePool) await pool.end?.()
        })()
      }
      return closing
    },
  }
}

/** Оборачивает пул, владельцем которого остаётся вызывающий код. */
export function wrapPostgresPool(pool: PgPoolLike): OwnedDatabase {
  return createPostgresAdapter(pool, false)
}

/** Подключается через необязательный `pg` и закрывает созданный здесь пул. */
export async function connectPostgres(connectionString: string): Promise<OwnedDatabase> {
  const pg = await import('pg')
  const pool = new pg.Pool({ connectionString })
  return createPostgresAdapter(pool, true)
}
