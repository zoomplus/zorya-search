import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { OwnedDatabase, QueryableDatabase } from './database.js'

export interface Migration { id: string; sql: string }
export async function migrate(database: OwnedDatabase, migrations: readonly Migration[]): Promise<void> {
  const valid = z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), sql: z.string().min(1) })).parse(migrations)
  if (new Set(valid.map((migration) => migration.id)).size !== valid.length) throw new Error('Duplicate migration identifiers')
  await database.transaction(async (client: QueryableDatabase) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [72513018])
    await client.query('CREATE TABLE IF NOT EXISTS element_migrations(id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())')
    for (const migration of valid) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex')
      const found = await client.query<{ checksum: string }>('SELECT checksum FROM element_migrations WHERE id=$1', [migration.id])
      if (found.rows[0]) {
        if (z.object({ checksum: z.string() }).parse(found.rows[0]).checksum !== checksum) throw new Error(`Migration checksum changed: ${migration.id}`)
        continue
      }
      await client.exec(migration.sql)
      await client.query('INSERT INTO element_migrations(id,checksum) VALUES($1,$2)', [migration.id, checksum])
    }
  })
}
