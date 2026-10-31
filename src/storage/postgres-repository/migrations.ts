export const knowledgeAdvisoryLock = 73513118

export const migration = `CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE knowledge_sources(id uuid PRIMARY KEY,url text UNIQUE NOT NULL,title text NOT NULL,added_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE knowledge_versions(id uuid PRIMARY KEY,source_id uuid NOT NULL REFERENCES knowledge_sources(id),content_hash text NOT NULL,
 text_content text NOT NULL,fetched_at timestamptz NOT NULL,last_checked_at timestamptz NOT NULL,published_at timestamptz,source_updated_at timestamptz,
 game text,game_version text,language text NOT NULL,UNIQUE(source_id,content_hash));
CREATE INDEX knowledge_versions_source ON knowledge_versions(source_id,fetched_at DESC);
CREATE INDEX knowledge_versions_game ON knowledge_versions(game,language,fetched_at DESC);
CREATE TABLE knowledge_chunks(id uuid PRIMARY KEY,version_id uuid NOT NULL REFERENCES knowledge_versions(id),ordinal integer NOT NULL,
 excerpt text NOT NULL,embedding vector NOT NULL,space text NOT NULL,dimensions integer NOT NULL,
 terms tsvector GENERATED ALWAYS AS(to_tsvector('simple',excerpt)) STORED,UNIQUE(version_id,space,ordinal));
CREATE INDEX knowledge_chunks_terms ON knowledge_chunks USING gin(terms);
CREATE INDEX knowledge_chunks_space ON knowledge_chunks(space,dimensions,version_id);
CREATE INDEX knowledge_chunks_version ON knowledge_chunks(version_id);
CREATE TABLE search_queries(id uuid PRIMARY KEY,request jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());`

export const versionPointerMigration = `ALTER TABLE knowledge_sources ADD COLUMN current_version uuid REFERENCES knowledge_versions(id);
UPDATE knowledge_sources s SET current_version=(SELECT v.id FROM knowledge_versions v WHERE v.source_id=s.id ORDER BY v.last_checked_at DESC,v.fetched_at DESC LIMIT 1);`

export const lifecycleMigration = `ALTER TABLE knowledge_sources DROP CONSTRAINT knowledge_sources_current_version_fkey;
ALTER TABLE knowledge_sources ADD CONSTRAINT knowledge_sources_current_version_fkey FOREIGN KEY(current_version) REFERENCES knowledge_versions(id) ON DELETE SET NULL;
ALTER TABLE knowledge_versions DROP CONSTRAINT knowledge_versions_source_id_fkey;
ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_versions_source_id_fkey FOREIGN KEY(source_id) REFERENCES knowledge_sources(id) ON DELETE CASCADE;
ALTER TABLE knowledge_chunks DROP CONSTRAINT knowledge_chunks_version_id_fkey;
ALTER TABLE knowledge_chunks ADD CONSTRAINT knowledge_chunks_version_id_fkey FOREIGN KEY(version_id) REFERENCES knowledge_versions(id) ON DELETE CASCADE;
CREATE INDEX search_queries_expiry ON search_queries(created_at,id);
CREATE INDEX knowledge_versions_filter ON knowledge_versions(lower(game),game_version,language,id);
CREATE TABLE knowledge_query_provenance(id uuid PRIMARY KEY,source_id uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
 version_id uuid NOT NULL REFERENCES knowledge_versions(id) ON DELETE CASCADE,query_hash text NOT NULL,request jsonb NOT NULL,origin text NOT NULL,queried_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX knowledge_provenance_source ON knowledge_query_provenance(source_id,version_id);`

export const embeddingProfileMigration = `ALTER TABLE knowledge_chunks ADD COLUMN indexed_at timestamptz;
ALTER TABLE knowledge_chunks ALTER COLUMN indexed_at SET DEFAULT now();
CREATE TABLE knowledge_embedding_profiles(space text PRIMARY KEY,model text NOT NULL,dimensions integer NOT NULL CHECK(dimensions>0),
 encoding text NOT NULL,chunker text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),ann_enabled boolean NOT NULL DEFAULT false,
 ann_validated_at timestamptz,ann_evidence jsonb);
CREATE INDEX knowledge_chunks_reindex ON knowledge_chunks(version_id,ordinal,space);`

export const knowledgeHistoryPaginationMigration = `CREATE INDEX knowledge_sources_history ON knowledge_sources(added_at,id);
CREATE INDEX knowledge_versions_history ON knowledge_versions(source_id,fetched_at,id);`
