import type { CodeChunk } from './types.js'
import type { QueryableDatabase } from '../storage/database.js'

export const CHUNK_INSERT_BATCH_SIZE = 64

export async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

export async function persistCodeChunks(
  tx: QueryableDatabase,
  snapshotId: string,
  chunks: readonly CodeChunk[],
  vectors: readonly (number[] | null)[],
  signal?: AbortSignal,
): Promise<void> {
  for (let offset = 0; offset < chunks.length; offset += CHUNK_INSERT_BATCH_SIZE) {
    signal?.throwIfAborted()
    const batch = chunks.slice(offset, offset + CHUNK_INSERT_BATCH_SIZE)
    const values: unknown[] = [snapshotId]
    const rows = batch.map((chunk, index) => {
      const base = 2 + index * 10
      values.push(
        chunk.id,
        chunk.path,
        chunk.lineStart,
        chunk.lineEnd,
        chunk.symbol,
        chunk.language,
        chunk.text,
        chunk.contentHash,
        chunk.parserVersion,
        vectors[offset + index] ? JSON.stringify(vectors[offset + index]) : null,
      )
      return `($1,${Array.from({ length: 10 }, (_, field) =>
        `$${base + field}${field === 9 ? '::jsonb' : ''}`).join(',')})`
    })
    await tx.query(
      `INSERT INTO zorya_code_chunks(snapshot_id,id,path,line_start,line_end,symbol,language,body,content_hash,parser_version,vector_json)
       VALUES ${rows.join(',')} ON CONFLICT(snapshot_id,id) DO NOTHING`,
      values,
    )
    await yieldToEventLoop()
    signal?.throwIfAborted()
  }
}
