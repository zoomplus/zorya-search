import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { connectPostgres, PostgresKnowledgeRepository, SqlQueue, wrapLegacyPostgresDatabase, wrapPostgresPool } from '../../src/index.js'

const connectionString = process.env.ELEMENT_DATABASE_URL

test('owned Postgres transaction fences retained clients before awaiting COMMIT', async () => {
  let commitStarted!: () => void
  let finishCommit!: () => void
  const reachedCommit = new Promise<void>((resolve) => { commitStarted = resolve })
  const commitGate = new Promise<void>((resolve) => { finishCommit = resolve })
  const pool = {
    async query() { return { rows: [], rowCount: 0 } },
    async connect() {
      return {
        async query(sql: string) {
          if (sql === 'COMMIT') { commitStarted(); await commitGate }
          return { rows: [], rowCount: 0 }
        },
        release() {},
      }
    },
  }
  const database = wrapPostgresPool(pool as unknown as Parameters<typeof wrapPostgresPool>[0])
  let escaped: { query(sql: string): Promise<unknown> } | undefined
  const transaction = database.transaction(async (client) => { escaped = client })
  await reachedCommit
  await assert.rejects(escaped!.query('SELECT 1'), { message: 'SEARCH_DATABASE_TRANSACTION_CLOSED' })
  finishCommit()
  await transaction
  await database.close()
})

test('owned isolated Postgres supports legacy migrations, history, vector persistence and leased reindex queue', { skip: !connectionString }, async () => {
  const database = await connectPostgres(connectionString!)
  const controller = new AbortController()
  const repository = new PostgresKnowledgeRepository(database)
  const url = `https://search-wave2.invalid/${randomUUID()}`
  const queue = new SqlQueue(database, 'search_wave2_reindex_queue')
  let sourceId: string | undefined
  try {
    await repository.initialize()
    await repository.initialize()
    const migrations = await database.query<{ id: string; checksum: string }>('SELECT id,checksum FROM element_migrations WHERE id LIKE $1 ORDER BY id', ['search_%'])
    assert.deepEqual(migrations.rows.map((row) => row.id), ['search_001','search_002_current_version','search_003_lifecycle','search_004_embedding_profiles','search_005'])

    const fetchedAt = new Date().toISOString()
    await repository.save([{ url, title: 'Wave 2 persistent fixture', text: 'wave two database persistence test', fetchedAt, publishedAt: null, sourceUpdatedAt: null }], [{ documentIndex: 0, text: 'wave two database persistence test', vector: [1, 0, 0] }], { space: 'wave2-fixture', language: 'en' }, controller.signal)
    const sources = await repository.listSavedSources(undefined, undefined, controller.signal)
    const saved = sources.items.find((item) => item.url === url)
    assert.ok(saved)
    sourceId = saved.id
    assert.equal(saved.current?.excerpt, 'wave two database persistence test')

    const reopenedRepository = new PostgresKnowledgeRepository(database)
    const passages = await reopenedRepository.retrieve('wave two database persistence', [1, 0, 0], 'wave2-fixture', 10)
    assert.equal(passages.some((passage) => passage.url === url), true)

    await queue.initialize()
    const queued = await queue.enqueue({ key: `wave2:${randomUUID()}`, kind: 'wave2-test', payload: { marker: 'lease' } })
    const lease = await queue.lease(10000, 'wave2-test')
    assert.equal(lease?.id, queued.id)
    assert.equal(await queue.finish(queued.id, lease!.token, { indexed: 1 }), true)
    assert.equal(await queue.finish(queued.id, lease!.token, { indexed: 2 }), false)
  } finally {
    if (sourceId) await repository.deleteKnowledge({ scope: 'sources', sourceIds: [sourceId] }, controller.signal)
    await database.query("DELETE FROM search_wave2_reindex_queue WHERE idempotency_key LIKE 'wave2:%'").catch(() => undefined)
    await database.close()
  }
})

test('legacy database shape adapts transaction and multi-statement migration calls without taking pool ownership', { skip: !connectionString }, async () => {
  const pool = new Pool({ connectionString: connectionString! })
  const legacy = {
    async query(sql: string, values: readonly unknown[] = []) {
      const result = await pool.query<Record<string, unknown>>(sql, [...values])
      return { rows: result.rows, rowCount: result.rowCount ?? 0 }
    },
    async transaction<T>(operation: (client: { query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> }) => Promise<T>, signal?: AbortSignal) {
      signal?.throwIfAborted()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const adapted = { async query(sql: string, values: readonly unknown[] = []) {
          signal?.throwIfAborted()
          const result = await client.query<Record<string, unknown>>(sql, [...values])
          return { rows: result.rows, rowCount: result.rowCount ?? 0 }
        } }
        const value = await operation(adapted)
        signal?.throwIfAborted()
        await client.query('COMMIT')
        return value
      } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
      finally { client.release() }
    },
    async close() { await pool.end() },
  }
  const database = wrapLegacyPostgresDatabase(legacy)
  try {
    const repository = new PostgresKnowledgeRepository(database)
    await repository.initialize()
    let escaped: { query(sql: string): Promise<unknown>; exec(sql: string): Promise<unknown> } | undefined
    await database.transaction(async (client) => { escaped = client; await client.query('SELECT 1 AS value') })
    await assert.rejects(escaped!.query('SELECT 1'), { message: 'SEARCH_DATABASE_CLOSED' })
    await assert.rejects(escaped!.exec('SELECT 1'), { message: 'SEARCH_DATABASE_CLOSED' })
  } finally {
    await database.close()
    const alive = await pool.query('SELECT 1 AS pool_still_open')
    assert.equal(alive.rows.length, 1)
    await legacy.close()
  }
})

test('owned pg connector closes its pool', { skip: !connectionString }, async () => {
  const database = await connectPostgres(connectionString!)
  await database.query('SELECT 1 AS ready')
  let escaped: { query(sql: string): Promise<unknown>; exec(sql: string): Promise<unknown> } | undefined
  await database.transaction(async (client) => { escaped = client; await client.query('SELECT 1 AS transaction_alive') })
  await assert.rejects(escaped!.query('SELECT 1'), { message: 'SEARCH_DATABASE_TRANSACTION_CLOSED' })
  await assert.rejects(escaped!.exec('SELECT 1'), { message: 'SEARCH_DATABASE_TRANSACTION_CLOSED' })
  const abort = new AbortController()
  await assert.rejects(database.transaction(async () => { abort.abort(new Error('abort before commit')) }, abort.signal), /abort before commit/u)
  await database.close()
  await assert.rejects(database.query('SELECT 1'), { message: 'SEARCH_DATABASE_CLOSED' })
})
