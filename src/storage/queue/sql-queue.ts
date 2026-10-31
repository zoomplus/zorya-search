import { legacyUuidSchema } from '../../core/identifiers.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import type { OwnedDatabase } from '../database.js'

interface QueueJob { id: string; key: string; kind: string; payload?: unknown; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; attempt: number; token: string | null; leaseUntil: Date | null; result?: unknown; error: string | null }
interface QueueLease extends QueueJob { token: string }
const queueJobSchema = z.object({ id: legacyUuidSchema, key: z.string(), kind: z.string(), payload: z.unknown().default(null), status: z.enum(['queued','running','succeeded','failed','cancelled']), attempt: z.number().int(), token: legacyUuidSchema.nullable(), leaseUntil: z.coerce.date().nullable(), result: z.unknown().default(null), error: z.string().nullable() }).required()

const columns =
  'id, idempotency_key AS key, kind, payload, status, attempt, token, lease_until AS "leaseUntil", result, error'
export class SqlQueue {
  readonly #database: OwnedDatabase
  readonly #table: string
  constructor(database: OwnedDatabase, table = 'work_queue') {
    this.#database = database
    this.#table = z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .parse(table)
  }
  async initialize(): Promise<void> {
    await this.#database.query(`CREATE TABLE IF NOT EXISTS ${this.#table} (
      id uuid PRIMARY KEY, idempotency_key text UNIQUE NOT NULL, kind text NOT NULL, payload jsonb NOT NULL,
      status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
      attempt integer NOT NULL DEFAULT 0, token uuid, lease_until timestamptz,
      available_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
      result jsonb, error text)`)
    await this.#database.query(
      `ALTER TABLE ${this.#table} ADD COLUMN IF NOT EXISTS terminal_at timestamptz`,
    )
    await this.#database.query(
      `UPDATE ${this.#table} SET terminal_at=now() WHERE status IN ('succeeded','failed','cancelled') AND terminal_at IS NULL`,
    )
    await this.#database.query(
      `CREATE INDEX IF NOT EXISTS ${this.#table}_terminal_expiry ON ${this.#table}(terminal_at,id) WHERE status IN ('succeeded','failed','cancelled')`,
    )
    await this.#database.query(
      `CREATE INDEX IF NOT EXISTS ${this.#table}_available ON ${this.#table}(available_at,created_at) WHERE status IN ('queued','running')`,
    )
  }
  async enqueue(input: { key: string; kind: string; payload: unknown }): Promise<QueueJob> {
    const valid = z
      .object({ key: z.string().min(1), kind: z.string().min(1), payload: z.unknown() })
      .parse(input)
    const encoded = JSON.stringify(valid.payload)
    if (encoded === undefined) throw new Error('Queue payload must be JSON serializable')
    const result = await this.#database.query(
      `INSERT INTO ${this.#table}(id,idempotency_key,kind,payload)
      VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING ${columns}`,
      [randomUUID(), valid.key, valid.kind, encoded],
    )
    return queueJobSchema.parse(result.rows[0])
  }
  async lease(leaseMs: number, kind?: string): Promise<QueueLease | undefined> {
    z.number().int().positive().max(3_600_000).parse(leaseMs)
    const token = randomUUID()
    const result = await this.#database.query(
      `WITH candidate AS (
      SELECT id FROM ${this.#table} WHERE available_at<=now() AND
      (status='queued' OR (status='running' AND lease_until<now())) AND ($3::text IS NULL OR kind=$3)
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE ${this.#table} q SET status='running', token=$1, attempt=attempt+1,
      lease_until=now()+$2::double precision * interval '1 millisecond'
      FROM candidate WHERE q.id=candidate.id RETURNING ${columns
        .split(', ')
        .map((x) => `q.${x}`)
        .join(', ')}`,
      [token, leaseMs, kind ?? null],
    )
    if (result.rows.length === 0) return undefined
    const job = queueJobSchema.parse(result.rows[0])
    return { ...job, token }
  }
  async heartbeat(id: string, token: string, leaseMs: number): Promise<boolean> {
    legacyUuidSchema.parse(id)
    legacyUuidSchema.parse(token)
    z.number().positive().parse(leaseMs)
    const result = await this.#database.query(
      `UPDATE ${this.#table} SET lease_until=now()+$3::double precision*interval '1 millisecond'
      WHERE id=$1 AND token=$2 AND status='running' AND lease_until>now()`,
      [id, token, leaseMs],
    )
    return result.rowCount === 1
  }
  async finish(id: string, token: string, result: unknown): Promise<boolean> {
    legacyUuidSchema.parse(id)
    legacyUuidSchema.parse(token)
    const encoded = JSON.stringify(result)
    if (encoded === undefined) throw new Error('Queue result must be JSON serializable')
    const updated = await this.#database.query(
      `UPDATE ${this.#table} SET status='succeeded',result=$3::jsonb,lease_until=NULL,terminal_at=now()
      WHERE id=$1 AND token=$2 AND status='running' AND lease_until>now()`,
      [id, token, encoded],
    )
    return updated.rowCount === 1
  }
  async retry(id: string, token: string, delayMs: number, error: string): Promise<boolean> {
    legacyUuidSchema.parse(id)
    legacyUuidSchema.parse(token)
    z.number().nonnegative().parse(delayMs)
    const result = await this.#database.query(
      `UPDATE ${this.#table} SET status='queued',token=NULL,lease_until=NULL,error=$4,
      available_at=now()+$3::double precision*interval '1 millisecond' WHERE id=$1 AND token=$2 AND status='running' AND lease_until>now()`,
      [id, token, delayMs, error],
    )
    return result.rowCount === 1
  }
  async fail(id: string, token: string, error: string): Promise<boolean> {
    legacyUuidSchema.parse(id)
    legacyUuidSchema.parse(token)
    const result = await this.#database.query(
      `UPDATE ${this.#table} SET status='failed',error=$3,lease_until=NULL,terminal_at=now()
      WHERE id=$1 AND token=$2 AND status='running' AND lease_until>now()`,
      [id, token, error],
    )
    return result.rowCount === 1
  }
  async cancel(id: string): Promise<boolean> {
    legacyUuidSchema.parse(id)
    const result = await this.#database.query(
      `UPDATE ${this.#table} SET status='cancelled',token=NULL,lease_until=NULL,terminal_at=now()
      WHERE id=$1 AND status IN ('queued','running')`,
      [id],
    )
    return result.rowCount === 1
  }
  async collectTemporary(
    input: { before: string; limit: number },
    signal: AbortSignal,
  ): Promise<number> {
    const valid = z
      .object({ before: z.string().datetime(), limit: z.number().int().min(1).max(1000) })
      .parse(input)
    return this.#database.transaction(async (client) => {
      const result = await client.query(
        `WITH expired AS (SELECT id FROM ${this.#table}
        WHERE status IN('succeeded','failed','cancelled') AND terminal_at<$1 ORDER BY terminal_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)
        DELETE FROM ${this.#table} q USING expired e WHERE q.id=e.id AND q.status IN('succeeded','failed','cancelled')`,
        [valid.before, valid.limit],
      )
      return result.rowCount
    }, signal)
  }
  async get(id: string): Promise<QueueJob | undefined> {
    legacyUuidSchema.parse(id)
    const result = await this.#database.query(`SELECT ${columns} FROM ${this.#table} WHERE id=$1`, [
      id,
    ])
    return result.rows.length === 0 ? undefined : queueJobSchema.parse(result.rows[0])
  }
}
