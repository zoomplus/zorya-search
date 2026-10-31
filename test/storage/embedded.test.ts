import assert from 'node:assert/strict'
import { mkdtemp, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { openEmbeddedDatabase } from '../../src/index.js'

test('embedded vector data survives clean restart and rejects a second directory owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-search-pglite-'))
  try {
    const db = await openEmbeddedDatabase(dir)
    await db.exec('CREATE EXTENSION IF NOT EXISTS vector; CREATE TABLE vectors(id integer primary key, value vector(3));')
    await db.query('INSERT INTO vectors VALUES ($1, $2::vector)', [1, '[1,2,3]'])
    await assert.rejects(openEmbeddedDatabase(dir), { message: 'SEARCH_EMBEDDED_DIRECTORY_ALREADY_OWNED' })
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import { openEmbeddedDatabase } from './src/index.ts'; try { await openEmbeddedDatabase(${JSON.stringify(dir)}); process.exitCode=2 } catch (error) { if (error.message !== 'SEARCH_EMBEDDED_OWNER_LOCK_EXISTS') throw error; console.log(error.message) }`], { cwd: process.cwd(), encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    assert.match(child.stdout, /SEARCH_EMBEDDED_OWNER_LOCK_EXISTS/u)
    await db.exec('CREATE TABLE tx_probe(value integer)')
    const aborted = new AbortController()
    await assert.rejects(db.transaction(async (client) => {
      await client.query('INSERT INTO tx_probe VALUES (1)')
      aborted.abort(new Error('cancel before commit'))
    }, aborted.signal), /cancel before commit/u)
    await assert.rejects(db.transaction((client) => client.transaction(async () => undefined)), { message: 'SEARCH_DATABASE_NESTED_TRANSACTION_UNSUPPORTED' })
    assert.equal((await db.query<{ count: string }>('SELECT count(*)::text AS count FROM tx_probe')).rows[0]?.count, '0')
    let escaped: { query(sql: string): Promise<unknown>; exec(sql: string): Promise<unknown> } | undefined
    await db.transaction(async (client) => { escaped = client; await client.query('SELECT 1') })
    await assert.rejects(escaped!.query('SELECT 1'), { message: 'SEARCH_DATABASE_TRANSACTION_CLOSED' })
    await assert.rejects(escaped!.exec('SELECT 1'), { message: 'SEARCH_DATABASE_TRANSACTION_CLOSED' })
    await db.close()
    const restarted = await openEmbeddedDatabase(dir)
    const result = await restarted.query<{ value: string }>('SELECT value::text AS value FROM vectors WHERE id=$1', [1])
    assert.equal(result.rows[0]?.value, '[1,2,3]')
    await restarted.close()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('embedded lock write failure removes only the lock file opened by this attempt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-search-lock-write-'))
  const probePath = join(dir, 'probe')
  const probe = await open(probePath, 'wx')
  const handlePrototype = Object.getPrototypeOf(probe) as { writeFile: (...args: unknown[]) => Promise<unknown> }
  await probe.close()
  await unlink(probePath)
  const originalWriteFile = handlePrototype.writeFile
  handlePrototype.writeFile = async () => { throw new Error('LOCK_WRITE_INJECTED') }
  try {
    await assert.rejects(openEmbeddedDatabase(dir), /LOCK_WRITE_INJECTED/u)
  } finally {
    handlePrototype.writeFile = originalWriteFile
  }
  await assert.rejects(stat(join(dir, '.zorya-search-owner')), { code: 'ENOENT' })
  const recovered = await openEmbeddedDatabase(dir)
  await recovered.close()
  await rm(dir, { recursive: true, force: true })
})

test('embedded close failure retains ownership and never removes a replacement lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zorya-search-lock-close-'))
  const lockPath = join(dir, '.zorya-search-owner')
  const preservedPath = join(dir, '.zorya-search-owner-preserved')
  const database = await openEmbeddedDatabase(dir)
  await rename(lockPath, preservedPath)
  const replacement = await open(lockPath, 'wx', 0o600)
  await replacement.writeFile('{"pid":1,"nonce":"replacement"}')
  await replacement.close()
  await assert.rejects(database.close(), { message: 'SEARCH_EMBEDDED_LOCK_RELEASE_FAILED' })
  assert.equal(await readFile(lockPath, 'utf8'), '{"pid":1,"nonce":"replacement"}')
  await assert.rejects(openEmbeddedDatabase(dir), { message: 'SEARCH_EMBEDDED_DIRECTORY_ALREADY_OWNED' })
  await unlink(lockPath)
  await unlink(preservedPath)
  await rm(dir, { recursive: true, force: true })
})
