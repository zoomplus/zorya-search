import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openEmbeddedDatabase, PostgresKnowledgeRepository } from '../../src/index.js'

test('legacy repository migrations execute as a multi-statement transaction in embedded PostgreSQL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-search-migrations-'))
  try {
    const db = await openEmbeddedDatabase(dir)
    const repository = new PostgresKnowledgeRepository(db)
    await repository.initialize()
    const migrations = await db.query<{ id: string; checksum: string }>('SELECT id,checksum FROM element_migrations ORDER BY id')
    assert.deepEqual(migrations.rows.map((row) => row.id), ['search_001','search_002_current_version','search_003_lifecycle','search_004_embedding_profiles','search_005'])
    const vector = await db.query<{ value: string }>("SELECT '[1,2,3]'::vector::text AS value")
    assert.equal(vector.rows[0]?.value, '[1,2,3]')
    await db.exec('CREATE TABLE result_count_probe(value integer)')
    const inserted = await db.query('INSERT INTO result_count_probe VALUES ($1)', [4])
    assert.equal(inserted.rowCount, 1)
    const fetchedAt = new Date().toISOString()
    await repository.save([{ url: 'https://example.test/page', title: 'Page', text: 'useful sample content', fetchedAt, publishedAt: null, sourceUpdatedAt: null }], [{ documentIndex: 0, text: 'useful sample content', vector: [1, 0, 0] }], { space: 'test-space', language: 'en' }, new AbortController().signal)
    const passages = await repository.retrieve('useful sample', [1, 0, 0], 'test-space', 10)
    assert.equal(passages.length, 1)
    assert.equal(passages[0]?.url, 'https://example.test/page')
    assert.equal(migrations.rows.every((row) => /^[a-f0-9]{64}$/u.test(row.checksum)), true)
    await db.close()
  } finally { await rm(dir, { recursive: true, force: true }) }
})
