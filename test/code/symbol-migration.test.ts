import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openEmbeddedDatabase } from '../../src/storage/embedded.js'
import { createCodeIndex } from '../../src/code/index.js'
import { initializeCodeIndex } from '../../src/code/schema.js'

test('additive graph migration is idempotent and refresh preserves legacy rows and paid timestamps', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zorya-symbol-migration-root-'))
  const data = await mkdtemp(join(tmpdir(), 'zorya-symbol-migration-db-'))
  const database = await openEmbeddedDatabase(data)
  const index = createCodeIndex({ database, profile: {
    provider: 'fixture', space: 'migration-preserve', model: 'v1', dimensions: 2,
    inputType: 'text', chunkerVersion: 'ts-ast-symbol-v1',
  }, models: { async embed({ texts }) { return texts.map(() => [0.6, 0.8]) } } })
  t.after(async () => {
    await index.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  })
  await writeFile(join(root, 'preserve.ts'), 'export function durableVector() { return "kept" }\n')
  const original = await index.indexRepository({ root })
  const indexedAtBefore = (await index.indexStatus(root)).indexedAt
  const legacyBefore = await database.query<Record<string, unknown>>(
    `SELECT w.worktree_id,w.current_snapshot,w.generation,w.indexed_at,s.file_count,s.chunk_count,
      (SELECT jsonb_agg(jsonb_build_object('id',id,'vector',vector_json) ORDER BY id)
       FROM zorya_code_chunks WHERE snapshot_id=w.current_snapshot) AS chunks,
      (SELECT jsonb_agg(jsonb_build_object('path',path,'hash',content_hash) ORDER BY path)
       FROM zorya_code_files WHERE snapshot_id=w.current_snapshot) AS files,
      (SELECT jsonb_agg(jsonb_build_object('from',from_path,'to',to_path,'specifier',specifier) ORDER BY from_path,specifier)
       FROM zorya_code_imports WHERE snapshot_id=w.current_snapshot) AS imports
     FROM zorya_code_worktrees w JOIN zorya_code_snapshots s ON s.snapshot_id=w.current_snapshot
     WHERE w.current_snapshot=$1`, [original.identity!.snapshotId])
  const immutableBefore = JSON.stringify(legacyBefore.rows)
  const oldMigrations = await database.query<{ id: string; checksum: string }>(
    `SELECT id,checksum FROM zorya_code_migrations WHERE id IN ('code_001','code_002_index_resume') ORDER BY id`)
  assert.deepEqual(oldMigrations.rows, [
    { id: 'code_001', checksum: 'fa3dfdb1f4044b622d551e759ffbb4cfde5dd865cea92ea9792c8d0ce7e7e1fc' },
    { id: 'code_002_index_resume', checksum: '0f29efb695966e3220e47b6b1a3e036fffd54bde3532107e916de411f9647007' },
  ])
  await initializeCodeIndex(database)
  await initializeCodeIndex(database)
  assert.equal((await database.query('SELECT 1 FROM zorya_code_analysis_state')).rowCount, 1)
  await index.indexCodeSymbols!({ root })
  const legacyAfter = await database.query<Record<string, unknown>>(
    `SELECT w.worktree_id,w.current_snapshot,w.generation,w.indexed_at,s.file_count,s.chunk_count,
      (SELECT jsonb_agg(jsonb_build_object('id',id,'vector',vector_json) ORDER BY id)
       FROM zorya_code_chunks WHERE snapshot_id=w.current_snapshot) AS chunks,
      (SELECT jsonb_agg(jsonb_build_object('path',path,'hash',content_hash) ORDER BY path)
       FROM zorya_code_files WHERE snapshot_id=w.current_snapshot) AS files,
      (SELECT jsonb_agg(jsonb_build_object('from',from_path,'to',to_path,'specifier',specifier) ORDER BY from_path,specifier)
       FROM zorya_code_imports WHERE snapshot_id=w.current_snapshot) AS imports
     FROM zorya_code_worktrees w JOIN zorya_code_snapshots s ON s.snapshot_id=w.current_snapshot
     WHERE w.current_snapshot=$1`, [original.identity!.snapshotId])
  assert.equal(JSON.stringify(legacyAfter.rows), immutableBefore)
  assert.deepEqual((await database.query<{ id: string; checksum: string }>(
    `SELECT id,checksum FROM zorya_code_migrations WHERE id IN ('code_001','code_002_index_resume') ORDER BY id`)).rows, oldMigrations.rows)
  assert.equal((await index.indexStatus(root)).indexedAt, indexedAtBefore)
  assert.equal((await index.findCodeSymbols!({ root, query: 'durableVector' })).symbols.length, 1)
})
