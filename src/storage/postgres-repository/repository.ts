import { legacyUuidSchema } from '../../core/identifiers.js'
import type { OwnedDatabase } from '../database.js'

import { migrate } from '../migrations.js'
import { SqlQueue } from '../queue/sql-queue.js'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

import type {
  KnowledgeDeleteInput,
  KnowledgeDeleteResult,
  KnowledgeRepository,
  Passage,
  SearchRequest,
  SearchResult,
  SourceDocument,
} from '../../core/contracts.js'
import type {
  KnowledgeHistoryFilterInput,
  KnowledgeHistoryPageInput,
  SavedSourcePage,
  SavedSourceVersionPage,
} from '../../core/knowledge-history.js'

import { knowledgeDeleteSchema, knowledgeDeleteResultSchema } from '../../core/contracts.js'
import { reciprocalRankFusion } from '../../core/retrieval.js'
import { runAnnQuery } from '../ann-index.js'
import { listSavedSourcesPage, listSavedSourceVersionsPage } from './knowledge-history.js'
import {
  embeddingProfileMigration,
  knowledgeAdvisoryLock,
  knowledgeHistoryPaginationMigration,
  lifecycleMigration,
  migration,
  versionPointerMigration,
} from './migrations.js'
import { knowledgeQueries } from './queries.js'
import { prepareVersions, retrievalRowSchema, vectorLiteral } from './row-mapping.js'

export class PostgresKnowledgeRepository implements KnowledgeRepository {
  readonly #database: OwnedDatabase
  constructor(database: OwnedDatabase) {
    this.#database = database
  }
  async initialize(options: { isolatedSchema?: string } = {}): Promise<void> {
    let initialMigration = migration
    if (options.isolatedSchema !== undefined) {
      const schema = z
        .string()
        .regex(/^element_debug_[a-z0-9_]+$/)
        .max(63)
        .parse(options.isolatedSchema)
      const current = await this.#database.query(
        'SELECT current_schema() AS schema,current_schemas(false)::text[] AS schemas',
      )
      const row = z
        .object({ schema: z.string(), schemas: z.array(z.string()) })
        .parse(current.rows[0])
      if (row.schema !== schema || row.schemas.length !== 1 || row.schemas[0] !== schema)
        throw new Error('SEARCH_DEBUG_SCHEMA_MISMATCH')
      // Keep applied public migration SQL/checksums intact; only a fresh isolated
      // schema uses the explicitly provisioned public extension type.
      initialMigration = migration
        .replace('CREATE EXTENSION IF NOT EXISTS vector;', '')
        .replace('embedding vector NOT NULL', 'embedding public.vector NOT NULL')
    }
    await migrate(this.#database, [
      { id: 'search_001', sql: initialMigration },
      { id: 'search_002_current_version', sql: versionPointerMigration },
      { id: 'search_003_lifecycle', sql: lifecycleMigration },
      { id: 'search_004_embedding_profiles', sql: embeddingProfileMigration },
      { id: 'search_005', sql: knowledgeHistoryPaginationMigration },
    ])
    await new SqlQueue(this.#database, 'knowledge_reindex_queue').initialize()
  }
  async #annEligible(space: string, dimensions: number): Promise<boolean> {
    const eligible = await this.#database.query(
      'SELECT ann_enabled FROM knowledge_embedding_profiles WHERE space=$1 AND dimensions=$2',
      [space, dimensions],
    )
    return eligible.rows[0]
      ? z.object({ ann_enabled: z.boolean() }).parse(eligible.rows[0]).ann_enabled
      : false
  }
  async retrieve(
    query: string,
    vector: number[],
    space: string,
    limit: number,
    filter?: { game?: string; gameVersion?: string | null; language?: string },
  ): Promise<Passage[]> {
    z.number().int().min(1).max(200).parse(limit)
    const encoded = vectorLiteral(vector)
    const ann = await this.#annEligible(space, vector.length)
    const queries = knowledgeQueries(query, encoded, space, vector.length, limit, filter, ann)
    const [dense, text] = await Promise.all(
      queries.map((item, index) =>
        ann && index === 0
          ? runAnnQuery(this.#database, item.sql, item.values)
          : this.#database.query(item.sql, item.values),
      ),
    )
    if (!dense || !text) throw new Error('SEARCH_QUERY_MISSING')
    return reciprocalRankFusion(
      [
        dense.rows.map((row) => retrievalRowSchema.parse(row)),
        text.rows.map((row) => retrievalRowSchema.parse(row)),
      ],
      limit,
    )
  }
  async save(
    documents: SourceDocument[],
    chunks: { documentIndex: number; text: string; vector: number[] }[],
    metadata: {
      space: string
      game?: string
      gameVersion?: string
      language: string
      query?: SearchRequest
    },
    signal: AbortSignal,
  ): Promise<void> {
    // One array binding per table avoids a query per chunk and commits the corpus atomically.
    const sources = documents.map((doc) => ({ id: randomUUID(), url: doc.url, title: doc.title }))
    const versions = prepareVersions(documents, metadata)
    const ordinals = new Map<number, number>()
    const prepared = chunks.map((chunk) => {
      const version = versions[chunk.documentIndex]
      if (!version) throw new Error('Chunk has no source document')
      const ordinal = ordinals.get(chunk.documentIndex) ?? 0
      ordinals.set(chunk.documentIndex, ordinal + 1)
      return {
        id: randomUUID(),
        url: version.url,
        hash: version.hash,
        ordinal,
        text: chunk.text,
        vector: vectorLiteral(chunk.vector),
        dimensions: chunk.vector.length,
      }
    })
    await this.#database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [knowledgeAdvisoryLock])
      await client.query(
        `INSERT INTO knowledge_sources(id,url,title) SELECT id::uuid,url,title FROM jsonb_to_recordset($1::jsonb) AS x(id text,url text,title text)
       ON CONFLICT(url) DO UPDATE SET title=EXCLUDED.title`,
        [JSON.stringify(sources)],
      )
      await client.query(
        `INSERT INTO knowledge_versions(id,source_id,content_hash,text_content,fetched_at,last_checked_at,published_at,source_updated_at,game,game_version,language)
       SELECT x.id::uuid,s.id,x.hash,x.text,x.fetched::timestamptz,x.fetched::timestamptz,x.published::timestamptz,x.updated::timestamptz,$2,x."gameVersion",x.language
       FROM jsonb_to_recordset($1::jsonb) AS x(id text,url text,hash text,text text,fetched text,published text,updated text,"gameVersion" text,language text)
       JOIN knowledge_sources s ON s.url=x.url ON CONFLICT(source_id,content_hash) DO UPDATE SET last_checked_at=EXCLUDED.last_checked_at`,
        [JSON.stringify(versions), metadata.game ?? null],
      )
      await client.query(
        `UPDATE knowledge_sources s SET current_version=v.id FROM knowledge_versions v
        JOIN jsonb_to_recordset($1::jsonb) AS x(url text,hash text) ON v.content_hash=x.hash
        WHERE s.url=x.url AND v.source_id=s.id`,
        [JSON.stringify(versions)],
      )
      await client.query(
        `INSERT INTO knowledge_chunks(id,version_id,ordinal,excerpt,embedding,space,dimensions)
       SELECT x.id::uuid,v.id,x.ordinal,x.text,x.vector::public.vector,$2,x.dimensions
       FROM jsonb_to_recordset($1::jsonb) AS x(id text,url text,hash text,ordinal integer,text text,vector text,dimensions integer)
       JOIN knowledge_sources s ON s.url=x.url JOIN knowledge_versions v ON v.source_id=s.id AND v.content_hash=x.hash
       ON CONFLICT(version_id,space,ordinal) DO NOTHING`,
        [JSON.stringify(prepared), metadata.space],
      )
      if (metadata.query)
        await client.query(
          `INSERT INTO knowledge_query_provenance(id,source_id,version_id,query_hash,origin,request)
        SELECT gen_random_uuid(),v.source_id,v.id,$2,'web',$3::jsonb FROM knowledge_versions v JOIN knowledge_sources s ON s.id=v.source_id
        JOIN jsonb_to_recordset($1::jsonb) AS x(url text,hash text) ON s.url=x.url AND v.content_hash=x.hash`,
          [
            JSON.stringify(versions),
            createHash('sha256').update(JSON.stringify(metadata.query)).digest('hex'),
            JSON.stringify(metadata.query),
          ],
        )
    }, signal)
  }
  async recordQuery(request: SearchRequest, result: SearchResult): Promise<void> {
    await this.#database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [knowledgeAdvisoryLock])
      await client.query(
        'INSERT INTO search_queries(id,request,result) VALUES($1,$2::jsonb,$3::jsonb)',
        [randomUUID(), JSON.stringify(request), JSON.stringify(result)],
      )
      const ids = result.passages
        .map((passage) => passage.id)
        .filter((id) => legacyUuidSchema.safeParse(id).success)
      await client.query(
        `INSERT INTO knowledge_query_provenance(id,source_id,version_id,query_hash,origin,request)
        SELECT gen_random_uuid(),v.source_id,v.id,$2,$3,$4::jsonb FROM knowledge_chunks c JOIN knowledge_versions v ON v.id=c.version_id
        WHERE c.id=ANY($1::uuid[]) GROUP BY v.source_id,v.id`,
        [
          ids,
          createHash('sha256').update(JSON.stringify(request)).digest('hex'),
          result.origin,
          JSON.stringify(request),
        ],
      )
    })
  }
  async collectTemporary(
    input: { before: string; limit: number },
    signal: AbortSignal,
  ): Promise<number> {
    const valid = z
      .object({ before: z.string().datetime(), limit: z.number().int().min(1).max(1000) })
      .parse(input)
    const queries = await this.#database.transaction(async (client) => {
      const result = await client.query(
        `WITH expired AS (SELECT id FROM search_queries WHERE created_at<$1
        ORDER BY created_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)
        DELETE FROM search_queries q USING expired e WHERE q.id=e.id`,
        [valid.before, valid.limit],
      )
      return result.rowCount
    }, signal)
    await new SqlQueue(this.#database, 'knowledge_reindex_queue').collectTemporary(valid, signal)
    return queries
  }
  async deleteKnowledge(
    input: KnowledgeDeleteInput,
    signal: AbortSignal,
  ): Promise<KnowledgeDeleteResult> {
    const valid = knowledgeDeleteSchema.parse(input)
    return this.#database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [knowledgeAdvisoryLock])
      const selected = await client.query(
        'SELECT id FROM knowledge_sources WHERE ($1::uuid[] IS NULL OR id=ANY($1)) FOR UPDATE',
        [valid.scope === 'sources' ? valid.sourceIds : null],
      )
      const ids = selected.rows.map((row) => z.object({ id: legacyUuidSchema }).parse(row).id)
      const counts = await client.query(
        `SELECT
        (SELECT count(*)::integer FROM knowledge_sources WHERE id=ANY($1::uuid[])) AS sources,
        (SELECT count(*)::integer FROM knowledge_versions WHERE source_id=ANY($1::uuid[])) AS versions,
        (SELECT count(*)::integer FROM knowledge_chunks c JOIN knowledge_versions v ON v.id=c.version_id WHERE v.source_id=ANY($1::uuid[])) AS chunks,
        (SELECT count(*)::integer FROM knowledge_query_provenance WHERE source_id=ANY($1::uuid[])) AS provenance`,
        [ids],
      )
      await client.query(
        `DELETE FROM search_queries q WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(q.result->'passages') p
        JOIN knowledge_chunks c ON c.id::text=p->>'id' JOIN knowledge_versions v ON v.id=c.version_id WHERE v.source_id=ANY($1::uuid[]))`,
        [ids],
      )
      if (valid.scope === 'all-user-knowledge') await client.query('DELETE FROM search_queries')
      await client.query(
        `DELETE FROM knowledge_reindex_queue q WHERE q.kind='search-embedding-reindex'
        AND ($2::boolean OR EXISTS(SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(q.payload->'chunks')='array' THEN q.payload->'chunks' ELSE '[]'::jsonb END) item
          JOIN knowledge_versions v ON v.id::text=item->>'versionId' WHERE v.source_id=ANY($1::uuid[])))`,
        [ids, valid.scope === 'all-user-knowledge'],
      )
      await client.query('DELETE FROM knowledge_sources WHERE id=ANY($1::uuid[])', [ids])
      return knowledgeDeleteResultSchema.parse(counts.rows[0])
    }, signal)
  }
  async listSavedSources(
    filter: KnowledgeHistoryFilterInput | undefined,
    page: KnowledgeHistoryPageInput | undefined,
    signal: AbortSignal,
  ): Promise<SavedSourcePage> {
    return listSavedSourcesPage(this.#database, filter, page, signal)
  }
  async listSavedSourceVersions(
    sourceId: string,
    page: KnowledgeHistoryPageInput | undefined,
    signal: AbortSignal,
  ): Promise<SavedSourceVersionPage> {
    return listSavedSourceVersionsPage(this.#database, sourceId, page, signal)
  }
  async explainRetrieval(
    query: string,
    vector: number[],
    space: string,
    limit: number,
    filter?: { game?: string; gameVersion?: string | null; language?: string },
  ) {
    const ann = await this.#annEligible(space, vector.length)
    const queries = knowledgeQueries(
      query,
      vectorLiteral(vector),
      space,
      vector.length,
      limit,
      filter,
      ann,
    )
    return Promise.all(
      queries.map(async (item, index) => {
        const sql = `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${item.sql}`
        const result =
          ann && index === 0
            ? await runAnnQuery(this.#database, sql, item.values)
            : await this.#database.query(sql, item.values)
        return result.rows
      }),
    )
  }
}
