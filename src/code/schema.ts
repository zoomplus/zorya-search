import type { QueryableDatabase } from '../storage/database.js'
import { CodeIndexError } from './errors.js'
import { codeSha256 } from './identity.js'

const schema = `
CREATE TABLE IF NOT EXISTS zorya_code_worktrees (
 worktree_id text PRIMARY KEY, repo_id text NOT NULL, root text NOT NULL, generation bigint NOT NULL DEFAULT 0,
 current_snapshot text, branch text, head text, content_hash text, profile_id text, chunk_config_id text, indexed_at timestamptz
);
CREATE TABLE IF NOT EXISTS zorya_code_migrations (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS zorya_code_snapshots (
 snapshot_id text PRIMARY KEY, worktree_id text NOT NULL, repo_id text NOT NULL, branch text, head text,
 content_hash text NOT NULL, profile_id text, file_count integer NOT NULL, chunk_count integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS zorya_code_files (
 snapshot_id text NOT NULL, path text NOT NULL, content_hash text NOT NULL, bytes integer NOT NULL,
 PRIMARY KEY(snapshot_id,path), FOREIGN KEY(snapshot_id) REFERENCES zorya_code_snapshots(snapshot_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS zorya_code_chunks (
 snapshot_id text NOT NULL, id text NOT NULL, path text NOT NULL, line_start integer NOT NULL, line_end integer NOT NULL,
 symbol text, language text NOT NULL, body text NOT NULL, content_hash text NOT NULL, parser_version text NOT NULL,
 vector_json jsonb, PRIMARY KEY(snapshot_id,id), FOREIGN KEY(snapshot_id) REFERENCES zorya_code_snapshots(snapshot_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS zorya_code_imports (
 snapshot_id text NOT NULL, from_path text NOT NULL, to_path text NOT NULL, specifier text NOT NULL,
 PRIMARY KEY(snapshot_id,from_path,specifier), FOREIGN KEY(snapshot_id) REFERENCES zorya_code_snapshots(snapshot_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS zorya_code_query_vectors (
 cache_key text PRIMARY KEY, repo_id text NOT NULL, worktree_id text NOT NULL, snapshot_id text NOT NULL,
 profile_id text NOT NULL, query_hash text NOT NULL, vector_json jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(snapshot_id) REFERENCES zorya_code_snapshots(snapshot_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS zorya_code_chunks_snapshot_path ON zorya_code_chunks(snapshot_id,path);
CREATE INDEX IF NOT EXISTS zorya_code_chunks_snapshot_language ON zorya_code_chunks(snapshot_id,language);
`

const resumeMigration = `
CREATE TABLE IF NOT EXISTS zorya_code_resume_sessions (
 worktree_id text PRIMARY KEY, scope_id text NOT NULL, generation bigint NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS zorya_code_resume_chunks (
 worktree_id text NOT NULL, scope_id text NOT NULL, id text NOT NULL,
 content_hash text NOT NULL, vector_json jsonb NOT NULL,
 PRIMARY KEY(worktree_id,id),
 FOREIGN KEY(worktree_id) REFERENCES zorya_code_resume_sessions(worktree_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS zorya_code_resume_chunks_scope ON zorya_code_resume_chunks(worktree_id,scope_id);
`

export async function initializeCodeIndex(database: QueryableDatabase): Promise<void> {
  const checksum = codeSha256(schema)
  await database.transaction(async (tx) => {
    await tx.exec(schema)
    const found = await tx.query<{ checksum: string }>(
      'SELECT checksum FROM zorya_code_migrations WHERE id=$1',
      ['code_001'],
    )
    if (found.rows[0] && found.rows[0].checksum !== checksum)
      throw new CodeIndexError('CODE_INDEX_MIGRATION_CHECKSUM_MISMATCH')
    if (!found.rows[0])
      await tx.query('INSERT INTO zorya_code_migrations(id,checksum) VALUES($1,$2)', [
        'code_001',
        checksum,
      ])
    const resumeChecksum = codeSha256(resumeMigration)
    const resume = await tx.query<{ checksum: string }>(
      'SELECT checksum FROM zorya_code_migrations WHERE id=$1',
      ['code_002_index_resume'],
    )
    if (resume.rows[0] && resume.rows[0].checksum !== resumeChecksum)
      throw new CodeIndexError('CODE_INDEX_MIGRATION_CHECKSUM_MISMATCH')
    if (!resume.rows[0]) {
      await tx.exec(resumeMigration)
      await tx.query('INSERT INTO zorya_code_migrations(id,checksum) VALUES($1,$2)', [
        'code_002_index_resume',
        resumeChecksum,
      ])
    }
  })
}
