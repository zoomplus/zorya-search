import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { PostgresKnowledgeRepository, wrapPostgresPool } from '../../src/index.js'

const connectionString = process.env.ELEMENT_DATABASE_URL

test('Postgres history excerpts respect the UTF-16 contract without changing stored text', { skip: !connectionString }, async () => {
  const adminPool = new Pool({ connectionString: connectionString! })
  const schema = `element_debug_history_unicode_${randomUUID().replaceAll('-', '')}`
  let schemaCreated = false
  let pool: Pool | undefined
  let database: ReturnType<typeof wrapPostgresPool> | undefined
  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    schemaCreated = true
    pool = new Pool({ connectionString: connectionString!, options: `-c search_path=${schema}` })
    database = wrapPostgresPool(pool)
    const repository = new PostgresKnowledgeRepository(database)
    await repository.initialize({ isolatedSchema: schema })

    const cases = [
      { name: 'ascii before a pair that would exceed the limit', text: `${'a'.repeat(1199)}😀tail`, expected: 'a'.repeat(1199) },
      { name: 'pair ending exactly at the limit', text: `${'a'.repeat(1198)}😀tail`, expected: `${'a'.repeat(1198)}😀` },
      { name: 'emoji throughout the excerpt', text: '😀'.repeat(700), expected: '😀'.repeat(600) },
      { name: 'ordinary BMP text', text: 'é'.repeat(1300), expected: 'é'.repeat(1200) },
    ]
    const documents = cases.map((item, index) => ({
      url: `https://history-unicode.invalid/${index}-${randomUUID()}`,
      title: item.name,
      text: item.text,
      fetchedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      publishedAt: null,
      sourceUpdatedAt: null,
    }))
    const abort = new AbortController()
    await repository.save(
      documents,
      cases.map((item, documentIndex) => ({ documentIndex, text: item.text, vector: [1, 0, 0] })),
      { space: `history-unicode-${randomUUID()}`, language: 'en' },
      abort.signal,
    )

    const storedHashes = new Map<string, string>()
    for (const document of documents) {
      const result = await database.query<{ excerptBytes: string }>(
        `SELECT encode(convert_to(c.excerpt,'UTF8'),'hex') AS "excerptBytes" FROM knowledge_chunks c
         JOIN knowledge_versions v ON v.id=c.version_id
         JOIN knowledge_sources s ON s.id=v.source_id
         WHERE s.url=$1 ORDER BY c.ordinal,c.id LIMIT 1`,
        [document.url],
      )
      assert.equal(result.rows.length, 1)
      storedHashes.set(document.url, createHash('sha256').update(Buffer.from(result.rows[0]!.excerptBytes, 'hex')).digest('hex'))
    }

    const sources = await repository.listSavedSources(undefined, undefined, abort.signal)
    assert.equal(sources.items.length, cases.length)
    for (const [index, item] of cases.entries()) {
      const source = sources.items.find((candidate) => candidate.url === documents[index]!.url)
      assert.ok(source?.current)
      assert.equal(source.current.excerpt, item.expected, item.name)
      assert.ok(source.current.excerpt.length <= 1200, item.name)
      assert.equal(source.current.excerpt, source.current.excerpt.toWellFormed(), item.name)

      const versions = await repository.listSavedSourceVersions(source.id, undefined, abort.signal)
      assert.equal(versions.items.length, 1)
      assert.equal(versions.items[0]!.excerpt, item.expected, `${item.name} version history`)
      assert.ok(versions.items[0]!.excerpt.length <= 1200, `${item.name} version history`)
      assert.equal(versions.items[0]!.excerpt, versions.items[0]!.excerpt.toWellFormed(), item.name)
    }

    for (const document of documents) {
      const result = await database.query<{ excerptBytes: string }>(
        `SELECT encode(convert_to(c.excerpt,'UTF8'),'hex') AS "excerptBytes" FROM knowledge_chunks c
         JOIN knowledge_versions v ON v.id=c.version_id
         JOIN knowledge_sources s ON s.id=v.source_id
         WHERE s.url=$1 ORDER BY c.ordinal,c.id LIMIT 1`,
        [document.url],
      )
      assert.equal(
        createHash('sha256').update(Buffer.from(result.rows[0]!.excerptBytes, 'hex')).digest('hex'),
        storedHashes.get(document.url),
        'history reads must leave stored excerpt bytes unchanged',
      )
    }
  } finally {
    if (database) await database.close()
    if (pool) await pool.end()
    if (schemaCreated) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await adminPool.end()
  }
})
