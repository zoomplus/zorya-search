import type { QueryableDatabase } from '../storage/database.js'

export async function initializeProjectTextSchema(database: QueryableDatabase): Promise<void> {
  await database.exec(`
CREATE TABLE IF NOT EXISTS zorya_project_text_snapshots (
 snapshot_id text PRIMARY KEY, worktree_id text NOT NULL, root text NOT NULL, repo_id text NOT NULL, scope_id text NOT NULL,
 branch text, head text, content_hash text NOT NULL, tree_hash text NOT NULL, profile_id text,
 file_count integer NOT NULL, chunk_count integer NOT NULL, indexed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS zorya_project_text_chunks (
 snapshot_id text NOT NULL REFERENCES zorya_project_text_snapshots(snapshot_id) ON DELETE CASCADE,
 id text NOT NULL, path text NOT NULL, kind text NOT NULL, title text, heading_json jsonb NOT NULL,
 line_start integer NOT NULL, line_end integer NOT NULL, body text NOT NULL, content_hash text NOT NULL,
 vector_json jsonb, PRIMARY KEY(snapshot_id,id)
);
CREATE TABLE IF NOT EXISTS zorya_project_text_files (
 snapshot_id text NOT NULL REFERENCES zorya_project_text_snapshots(snapshot_id) ON DELETE CASCADE,
 path text NOT NULL, content_hash text NOT NULL, bytes integer NOT NULL, PRIMARY KEY(snapshot_id,path)
);
CREATE INDEX IF NOT EXISTS zorya_project_text_chunks_path ON zorya_project_text_chunks(snapshot_id,path,line_start);
CREATE TABLE IF NOT EXISTS zorya_project_text_current (
 worktree_id text PRIMARY KEY, snapshot_id text NOT NULL REFERENCES zorya_project_text_snapshots(snapshot_id), generation bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS zorya_project_text_staging (
 worktree_id text NOT NULL, scope_id text NOT NULL, profile_id text NOT NULL, chunk_id text NOT NULL, content_hash text NOT NULL,
 vector_json jsonb NOT NULL, settled_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(worktree_id,scope_id,profile_id,chunk_id,content_hash)
);
CREATE TABLE IF NOT EXISTS zorya_project_text_generations (
 worktree_id text PRIMARY KEY, generation bigint NOT NULL
);`)
}
