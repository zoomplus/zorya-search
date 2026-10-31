import { legacyUuidSchema } from '../core/identifiers.js'
import type { OwnedDatabase } from './database.js'

import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import type {
  EmbeddingProfile,
  ReindexChunk,
  ReindexRepository,
} from '../core/embedding-profile.js'

import {
  embeddingProfileSchema,
  reindexChunkSchema,
  reindexPayloadSchema,
} from '../core/embedding-profile.js'

const validVectors = z.array(z.array(z.number().finite()).min(1)).min(1).max(32)
export class PostgresReindexRepository implements ReindexRepository {
  constructor(private readonly database: OwnedDatabase) {}
  async registerProfile(input: EmbeddingProfile): Promise<void> {
    const profile = embeddingProfileSchema.parse(input)
    await this.database.query(
      `INSERT INTO knowledge_embedding_profiles(space,model,dimensions,encoding,chunker)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(space) DO NOTHING`,
      [profile.space, profile.model, profile.dimensions, profile.encoding, profile.chunker],
    )
    const found = await this.database.query(
      'SELECT space,model,dimensions,encoding,chunker FROM knowledge_embedding_profiles WHERE space=$1',
      [profile.space],
    )
    const registered = embeddingProfileSchema.parse(found.rows[0])
    if (JSON.stringify(registered) !== JSON.stringify(profile))
      throw new Error('EMBEDDING_PROFILE_CONFLICT')
  }
  async missingChunks(
    profile: EmbeddingProfile,
    after?: { versionId: string; ordinal: number },
  ): Promise<ReindexChunk[]> {
    const cursor = after
      ? reindexChunkSchema.pick({ versionId: true, ordinal: true }).parse(after)
      : undefined
    const result = await this.database.query(
      `SELECT c.version_id AS "versionId",c.ordinal,min(c.excerpt) AS text,
      count(DISTINCT c.excerpt)::integer AS variants FROM knowledge_chunks c
      WHERE c.space<>$1 AND ($2::uuid IS NULL OR (c.version_id,c.ordinal)>($2::uuid,$3::integer))
      AND NOT EXISTS(SELECT 1 FROM knowledge_chunks target WHERE target.version_id=c.version_id AND target.ordinal=c.ordinal AND target.space=$1)
      GROUP BY c.version_id,c.ordinal ORDER BY c.version_id,c.ordinal LIMIT 32`,
      [profile.space, cursor?.versionId ?? null, cursor?.ordinal ?? null],
    )
    const rows = result.rows.map((row) =>
      reindexChunkSchema.extend({ variants: z.number().int().positive() }).parse(row),
    )
    if (rows.some((row) => row.variants !== 1)) throw new Error('REINDEX_CHUNKER_CONFLICT')
    return rows.map(({ variants: _variants, ...chunk }) => chunk)
  }
  async writeReindexed(
    input: {
      id: string
      token: string
      profile: EmbeddingProfile
      chunks: ReindexChunk[]
      vectors: number[][]
    },
    signal: AbortSignal,
  ): Promise<number> {
    const id = legacyUuidSchema.parse(input.id)
    const token = legacyUuidSchema.parse(input.token)
    const { profile, chunks } = reindexPayloadSchema.parse({
      profile: input.profile,
      chunks: input.chunks,
    })
    const vectors = validVectors.parse(input.vectors)
    if (
      vectors.length !== chunks.length ||
      vectors.some((vector) => vector.length !== profile.dimensions)
    )
      throw new Error('EMBEDDING_DIMENSION_MISMATCH')
    const rows = chunks.map((chunk, index) => ({
      ...chunk,
      id: randomUUID(),
      vector: `[${vectors[index]?.join(',')}]`,
    }))
    return this.database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [73513118])
      const lease = await client.query(
        `SELECT id FROM knowledge_reindex_queue WHERE id=$1 AND token=$2
        AND status='running' AND lease_until>now() FOR UPDATE`,
        [id, token],
      )
      if (lease.rowCount !== 1) throw new Error('REINDEX_LEASE_LOST')
      const result = await client.query(
        `INSERT INTO knowledge_chunks(id,version_id,ordinal,excerpt,embedding,space,dimensions)
        SELECT x.id::uuid,v.id,x.ordinal,x.text,x.vector::public.vector,$2,$3
        FROM jsonb_to_recordset($1::jsonb) x(id text,"versionId" text,ordinal integer,text text,vector text)
        JOIN knowledge_versions v ON v.id=x."versionId"::uuid
        JOIN knowledge_sources s ON s.id=v.source_id
        WHERE EXISTS(SELECT 1 FROM knowledge_chunks original WHERE original.version_id=v.id AND original.ordinal=x.ordinal AND original.excerpt=x.text)
        ON CONFLICT(version_id,space,ordinal) DO NOTHING`,
        [JSON.stringify(rows), profile.space, profile.dimensions],
      )
      return result.rowCount
    }, signal)
  }
}
