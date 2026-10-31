import { legacyUuidSchema } from '../core/identifiers.js'
import type { OwnedDatabase } from './database.js'

import { createHash } from 'node:crypto'
import { z } from 'zod'

import type { EmbeddingProfile } from '../core/embedding-profile.js'

import { embeddingProfileSchema } from '../core/embedding-profile.js'

const measurementSchema = z
  .object({
    corpus: z.number().int().min(10_000),
    queries: z.number().int().min(50),
    recallAt40: z.number().finite().min(0).max(1),
    exactP50Ms: z.number().finite().nonnegative(),
    exactP95Ms: z.number().finite().nonnegative(),
    annP50Ms: z.number().finite().nonnegative(),
    annP95Ms: z.number().finite().nonnegative(),
  })
  .strict()
export type AnnMeasurement = z.infer<typeof measurementSchema>
export function annIndexName(space: string): string {
  return `knowledge_hnsw_${createHash('sha256').update(space).digest('hex').slice(0, 16)}`
}
function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0
}
const idRows = z.array(z.object({ id: legacyUuidSchema }))
export function runAnnQuery(database: OwnedDatabase, sql: string, values: readonly unknown[]) {
  return database.transaction(async (client) => {
    await client.query('SET LOCAL hnsw.ef_search=256')
    return client.query(sql, values)
  })
}
export class SearchAnnIndex {
  constructor(private readonly database: OwnedDatabase) {}
  async build(input: EmbeddingProfile, signal: AbortSignal): Promise<void> {
    const profile = embeddingProfileSchema.parse(input)
    if (profile.dimensions > 4000) throw new Error('ANN_HALF_DIMENSION_UNSUPPORTED')
    signal.throwIfAborted()
    const name = annIndexName(profile.space)
    const current = await this.database.query(
      `SELECT i.indisvalid FROM pg_index i
      JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND c.relname=$1`,
      [name],
    )
    if (current.rows[0] && !z.object({ indisvalid: z.boolean() }).parse(current.rows[0]).indisvalid)
      await this.database.query(`DROP INDEX CONCURRENTLY ${name}`)
    signal.throwIfAborted()
    // Utility DDL cannot bind a predicate parameter. The validated profile is
    // encoded as a SQL literal; identifier comes only from a fixed SHA256 prefix.
    const spaceLiteral = `'${profile.space.replaceAll("'", "''")}'`
    await this.database.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON knowledge_chunks
      USING hnsw ((embedding::public.halfvec(${profile.dimensions})) public.halfvec_cosine_ops)
      WHERE space=${spaceLiteral} AND dimensions=${profile.dimensions}`)
    signal.throwIfAborted()
  }
  async benchmark(
    input: { profile: EmbeddingProfile; queries: number[][] },
    signal: AbortSignal,
  ): Promise<AnnMeasurement> {
    const profile = embeddingProfileSchema.parse(input.profile)
    const queries = z
      .array(z.array(z.number().finite()).length(profile.dimensions))
      .min(50)
      .max(200)
      .parse(input.queries)
    const corpus = await this.database.query(
      `SELECT count(*)::integer AS count FROM knowledge_chunks c
      JOIN knowledge_sources s ON s.current_version=c.version_id WHERE c.space=$1 AND c.dimensions=$2`,
      [profile.space, profile.dimensions],
    )
    const count = z.object({ count: z.number().int().min(10_000) }).parse(corpus.rows[0]).count
    const exact: number[] = [],
      ann: number[] = [],
      recalls: number[] = []
    for (const vector of queries) {
      signal.throwIfAborted()
      const encoded = `[${vector.join(',')}]`
      const started = performance.now()
      const expected = await this.#neighbors(profile, encoded, false)
      exact.push(performance.now() - started)
      const next = performance.now()
      const approximate = await this.#neighbors(profile, encoded, true)
      ann.push(performance.now() - next)
      const ids = new Set(approximate.map((row) => row.id))
      recalls.push(expected.filter((row) => ids.has(row.id)).length / Math.max(1, expected.length))
      signal.throwIfAborted()
    }
    return measurementSchema.parse({
      corpus: count,
      queries: queries.length,
      recallAt40: recalls.reduce((sum, value) => sum + value, 0) / recalls.length,
      exactP50Ms: percentile(exact, 0.5),
      exactP95Ms: percentile(exact, 0.95),
      annP50Ms: percentile(ann, 0.5),
      annP95Ms: percentile(ann, 0.95),
    })
  }
  async #neighbors(profile: EmbeddingProfile, vector: string, ann: boolean) {
    const distance = ann
      ? `(c.embedding::public.halfvec(${profile.dimensions})) OPERATOR(public.<=>) $3::public.halfvec(${profile.dimensions})`
      : 'c.embedding OPERATOR(public.<=>) $3::public.vector'
    const sql = `SELECT c.id FROM knowledge_chunks c
      JOIN knowledge_sources s ON s.current_version=c.version_id WHERE c.space=$1 AND c.dimensions=$2
      ORDER BY ${distance} LIMIT 40`
    const values = [profile.space, profile.dimensions, vector]
    const result = ann
      ? await runAnnQuery(this.database, sql, values)
      : await this.database.query(sql, values)
    return idRows.parse(result.rows)
  }
  async validateAndEnable(
    profile: EmbeddingProfile,
    queries: number[][],
    signal: AbortSignal,
  ): Promise<{ enabled: boolean; measurement: AnnMeasurement }> {
    await this.build(profile, signal)
    const measurement = await this.benchmark({ profile, queries }, signal)
    const enabled =
      measurement.recallAt40 >= 0.95 &&
      measurement.annP50Ms < measurement.exactP50Ms &&
      measurement.annP95Ms <= measurement.exactP95Ms
    signal.throwIfAborted()
    const saved = await this.database.query(
      `UPDATE knowledge_embedding_profiles SET ann_enabled=$2,ann_validated_at=now(),ann_evidence=$3::jsonb
      WHERE space=$1 AND dimensions=$4 AND model=$5 AND encoding=$6 AND chunker=$7`,
      [
        profile.space,
        enabled,
        JSON.stringify(measurement),
        profile.dimensions,
        profile.model,
        profile.encoding,
        profile.chunker,
      ],
    )
    if (saved.rowCount !== 1) throw new Error('ANN_PROFILE_NOT_REGISTERED')
    return { enabled, measurement }
  }
}
