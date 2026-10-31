import type { OwnedDatabase, QueryResult, QueryableDatabase } from '../storage/database.js'

export interface LegacySqlExecutor {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>
}
export interface LegacyPostgresDatabase {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>
  transaction<T>(operation: (client: LegacySqlExecutor) => Promise<T>, signal?: AbortSignal): Promise<T>
  close(): Promise<void>
}

/** Адаптирует структурно совместимый пул БД; закрытие адаптера не закрывает пул вызывающей стороны. */
export function wrapLegacyPostgresDatabase(database: LegacyPostgresDatabase): OwnedDatabase {
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
  const clientAdapter = (client: LegacySqlExecutor, scope: { alive: boolean }, signal?: AbortSignal): QueryableDatabase => ({
    async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
      if (!scope.alive) throw new Error('SEARCH_DATABASE_CLOSED')
      signal?.throwIfAborted()
      const result = await client.query(sql, values)
      return { rows: result.rows as Row[], rowCount: result.rowCount }
    },
    async exec(sql: string) { if (!scope.alive) throw new Error('SEARCH_DATABASE_CLOSED'); signal?.throwIfAborted(); return client.query(sql) },
    async transaction() { throw new Error('SEARCH_DATABASE_NESTED_TRANSACTION_UNSUPPORTED') },
  })
  return {
    kind: 'postgres',
    async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
      return admit(async () => {
        const result = await database.query(sql, values)
        return { rows: result.rows as Row[], rowCount: result.rowCount }
      })
    },
    async exec(sql: string) { return admit(() => database.query(sql)) },
    async transaction<T>(operation: (client: QueryableDatabase) => Promise<T>, signal?: AbortSignal): Promise<T> {
      return admit(() => database.transaction(async (client) => {
        const scope = { alive: true }
        try { return await operation(clientAdapter(client, scope, signal)) } finally { scope.alive = false }
      }, signal))
    },
    close() {
      if (!closing) {
        closed = true
        closing = pending === 0 ? Promise.resolve() : new Promise<void>((resolveIdle) => {
          const wake = () => { idleWaiters.delete(wake); resolveIdle() }
          idleWaiters.add(wake)
          if (pending === 0) wake()
        })
      }
      return closing
    },
  }
}
