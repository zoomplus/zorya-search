import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { posix, resolve, win32 } from 'node:path'
import type { CodeIndexLimits } from '../code/types.js'
import { createCodePathPolicy, enumerateCode, readScopedFile } from '../code/enumerate.js'
import { identifyRoot } from '../code/identity.js'
import { CodeIndexError } from '../code/errors.js'
import { rankLexical } from '../code/ranking.js'
import { chunkProjectText } from './chunker.js'
import { projectTextProfileId, projectTextScopeId, PROJECT_TEXT_SELECTION } from './policy.js'
import { initializeProjectTextSchema } from './schema.js'
import type {
  ProjectTextIndex,
  ProjectTextOptions,
  ProjectTextKind,
  ProjectTextSearchInput,
  ProjectTextReadInput,
} from './types.js'
import type { ProjectTextSourceIdentity } from './types.js'

export type * from './types.js'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const isoTimestamp = (value: Date | string): string => {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new CodeIndexError('PROJECT_TEXT_INDEXED_AT_INVALID')
  return date.toISOString()
}
const defaults = {
  maxFiles: 5000,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 256_000_000,
  maxChunks: 20_000,
  maxChunkChars: 8000,
}
const validKinds = new Set<ProjectTextKind>(['rules', 'skills', 'documentation'])
const validateVector = (value: unknown, dimensions: number): number[] => {
  if (
    !Array.isArray(value) ||
    value.length !== dimensions ||
    !value.every((item) => typeof item === 'number' && Number.isFinite(item))
  )
    throw new CodeIndexError('PROJECT_TEXT_VECTOR_INVALID')
  const magnitude = Math.sqrt(value.reduce((sum, item) => sum + item * item, 0))
  if (!Number.isFinite(magnitude) || magnitude === 0)
    throw new CodeIndexError('PROJECT_TEXT_VECTOR_INVALID')
  return [...value] as number[]
}
const cosine = (left: number[], right: number[]) => {
  const dot = left.reduce((sum, value, index) => sum + value * right[index]!, 0)
  const a = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0))
  const b = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0))
  if (!Number.isFinite(dot + a + b) || !a || !b)
    throw new CodeIndexError('PROJECT_TEXT_VECTOR_INVALID')
  return dot / (a * b)
}
const publicIdentity = (
  identity: Pick<ProjectTextSourceIdentity, 'repoId' | 'worktreeId' | 'root' | 'branch' | 'head'>,
  snapshotId: string,
  contentHash: string,
): ProjectTextSourceIdentity => ({ ...identity, snapshotId, contentHash })

export function createProjectTextIndex(options: ProjectTextOptions): ProjectTextIndex {
  if (
    !options?.database ||
    typeof options.database.query !== 'function' ||
    typeof options.database.exec !== 'function' ||
    typeof options.database.transaction !== 'function'
  )
    throw new CodeIndexError('PROJECT_TEXT_DATABASE_INVALID')
  if (
    (options.documentEmbedding !== undefined &&
      typeof options.documentEmbedding.embed !== 'function') ||
    (options.queryEmbedding !== undefined && typeof options.queryEmbedding.embed !== 'function')
  )
    throw new CodeIndexError('PROJECT_TEXT_MODELS_INVALID')
  const allowedLimitKeys = new Set([
    'maxFiles',
    'maxFileBytes',
    'maxTotalBytes',
    'maxChunks',
    'maxChunkChars',
  ])
  if (options.limits && Object.keys(options.limits).some((key) => !allowedLimitKeys.has(key)))
    throw new CodeIndexError('PROJECT_TEXT_LIMIT_INVALID')
  const limits = { ...defaults, ...options.limits }
  for (const [k, v] of Object.entries(limits))
    if (
      !Number.isInteger(v) ||
      v < 1 ||
      v >
        (
          {
            maxFiles: 20000,
            maxFileBytes: 10000000,
            maxTotalBytes: 1000000000,
            maxChunks: 50000,
            maxChunkChars: 32000,
          } as Record<string, number>
        )[k]!
    )
      throw new CodeIndexError('PROJECT_TEXT_LIMIT_INVALID')
  let profileId: string | null
  try {
    profileId = projectTextProfileId(options.documentEmbedding, options.queryEmbedding)
  } catch (error) {
    throw new CodeIndexError(
      error instanceof Error ? error.message : 'PROJECT_TEXT_EMBEDDING_PROFILE_INVALID',
    )
  }
  const docProvider = options.documentEmbedding
    ? {
        profile: Object.freeze({
          ...options.documentEmbedding.profile,
          dimensions: options.documentEmbedding.profile.dimensions!,
          inputType: options.documentEmbedding.profile.inputType!,
        }),
        embed: options.documentEmbedding.embed.bind(options.documentEmbedding),
      }
    : undefined
  const queryProvider = options.queryEmbedding
    ? {
        profile: Object.freeze({
          ...options.queryEmbedding.profile,
          dimensions: options.queryEmbedding.profile.dimensions!,
          inputType: options.queryEmbedding.profile.inputType!,
        }),
        embed: options.queryEmbedding.embed.bind(options.queryEmbedding),
      }
    : undefined
  const assertProfileStable = () => {
    try {
      if (projectTextProfileId(options.documentEmbedding, options.queryEmbedding) !== profileId)
        throw new CodeIndexError('PROJECT_TEXT_PROFILE_MUTATED')
    } catch (error) {
      if (error instanceof CodeIndexError) throw error
      throw new CodeIndexError('PROJECT_TEXT_PROFILE_MUTATED')
    }
  }
  if (options.reranker !== undefined && typeof options.reranker.rerank !== 'function')
    throw new CodeIndexError('PROJECT_TEXT_RERANKER_INVALID')
  const reranker = options.reranker?.rerank.bind(options.reranker)
  const rerankCandidateLimit = options.rerankCandidateLimit ?? (reranker ? 30 : 0)
  if (
    !Number.isInteger(rerankCandidateLimit) ||
    rerankCandidateLimit < 0 ||
    rerankCandidateLimit > 100
  )
    throw new CodeIndexError('PROJECT_TEXT_LIMIT_INVALID')
  const db = options.database
  if (options.exclude !== undefined && !Array.isArray(options.exclude))
    throw new CodeIndexError('PROJECT_TEXT_EXCLUSION_POLICY_INVALID')
  const commonPathPolicy = createCodePathPolicy(options.exclude ? [...options.exclude] : undefined)
  const scopeId = projectTextScopeId(commonPathPolicy.id, limits)
  let init: Promise<void> | undefined
  const ensure = () => (init ??= initializeProjectTextSchema(db))
  const active = new Map<
    string,
    { generation: number; controller: AbortController; promise?: Promise<unknown> }
  >()
  const operations = new Set<{ controller: AbortController; promise: Promise<unknown> }>()
  let closed = false
  let closing: Promise<void> | undefined
  const assertOpen = () => {
    if (closed) throw new CodeIndexError('PROJECT_TEXT_INDEX_CLOSED')
  }
  const limitsForEnumeration = (): CodeIndexLimits => ({
    ...limits,
    maxQueryChars: 4000,
    maxScanChunks: limits.maxChunks,
    maxResults: 100,
  })
  const enumerate = (root: string, signal?: AbortSignal) =>
    enumerateCode(
      root,
      limitsForEnumeration(),
      signal,
      commonPathPolicy.excludes,
      PROJECT_TEXT_SELECTION,
    )
  const sourceFingerprint = async (root: string, signal?: AbortSignal) => {
    assertOpen()
    signal?.throwIfAborted()
    return (await enumerate(root, signal)).treeHash
  }
  const checkCurrent = async (root: string, expected?: string, signal?: AbortSignal) => {
    const found = await enumerate(root, signal)
    if (expected && found.treeHash !== expected)
      throw new CodeIndexError('PROJECT_TEXT_SOURCE_CHANGED')
    return found
  }
  const api: Omit<ProjectTextIndex, 'close'> = {
    async indexRepository(input) {
      assertOpen()
      if (!input || typeof input.root !== 'string')
        throw new CodeIndexError('PROJECT_TEXT_ROOT_INVALID')
      const rootInput = `${input.root}`
      const signal = input.signal
      if (!rootInput.trim()) throw new CodeIndexError('PROJECT_TEXT_ROOT_INVALID')
      await ensure()
      signal?.throwIfAborted()
      const root = await realpath(resolve(rootInput))
      const prior = active.get(root)
      prior?.controller.abort(new CodeIndexError('PROJECT_TEXT_GENERATION_SUPERSEDED'))
      if (prior?.promise) await Promise.allSettled([prior.promise])
      const generation = (prior?.generation ?? 0) + 1
      const controller = new AbortController()
      const forwardAbort = () => controller.abort(signal?.reason)
      signal?.addEventListener('abort', forwardAbort, { once: true })
      const entry = { generation, controller } as {
        generation: number
        controller: AbortController
        promise?: Promise<unknown>
      }
      active.set(root, entry)
      const work = (async () => {
        const rootIdentity = await identifyRoot(root, '', controller.signal)
        const reservation = await db.query<{ generation: string | number }>(
          'INSERT INTO zorya_project_text_generations(worktree_id,generation) VALUES($1,1) ON CONFLICT(worktree_id) DO UPDATE SET generation=zorya_project_text_generations.generation+1 RETURNING generation',
          [rootIdentity.worktreeId],
        )
        const generation = Number(reservation.rows[0]?.generation)
        if (!Number.isSafeInteger(generation) || generation < 1)
          throw new CodeIndexError('PROJECT_TEXT_GENERATION_INVALID')
        await db.transaction(async (tx) => {
          const currentGeneration = await tx.query<{ generation: string }>(
            'SELECT generation FROM zorya_project_text_generations WHERE worktree_id=$1 FOR UPDATE',
            [rootIdentity.worktreeId],
          )
          if (Number(currentGeneration.rows[0]?.generation) !== generation)
            throw new CodeIndexError('PROJECT_TEXT_GENERATION_SUPERSEDED')
          await tx.query(
            'DELETE FROM zorya_project_text_staging WHERE worktree_id=$1 AND ($2::text IS NULL OR scope_id<>$3 OR profile_id<>$2)',
            [rootIdentity.worktreeId, profileId, scopeId],
          )
        }, controller.signal)
        const e = await enumerate(root, controller.signal)
        const chunks = e.files
          .flatMap((f) => chunkProjectText(f, limits.maxChunkChars))
          .filter((chunk) => chunk.text.trim().length > 0)
        if (chunks.length > limits.maxChunks) throw new CodeIndexError('PROJECT_TEXT_CHUNK_LIMIT')
        const identity = await identifyRoot(root, e.treeHash, controller.signal)
        const snapshotId = sha(
          JSON.stringify([
            identity.repoId,
            identity.worktreeId,
            identity.branch,
            identity.head,
            e.treeHash,
            profileId,
            scopeId,
          ]),
        )
        const published = await db.query<{
          snapshot_id: string
          tree_hash: string
          profile_id: string | null
          scope_id: string
          branch: string | null
          head: string | null
        }>(
          'SELECT s.snapshot_id,s.tree_hash,s.profile_id,s.scope_id,s.branch,s.head FROM zorya_project_text_current c JOIN zorya_project_text_snapshots s USING(snapshot_id) WHERE c.worktree_id=$1',
          [identity.worktreeId],
        )
        const previous = published.rows[0]
        if (
          previous &&
          previous.snapshot_id === snapshotId &&
          previous.tree_hash === e.treeHash &&
          previous.profile_id === profileId &&
          previous.scope_id === scopeId &&
          previous.branch === identity.branch &&
          previous.head === identity.head
        ) {
          const confirmed = await checkCurrent(root, e.treeHash, controller.signal)
          const confirmedIdentity = await identifyRoot(root, confirmed.treeHash, controller.signal)
          const currentRow = await db.query<{ snapshot_id: string }>(
            'SELECT snapshot_id FROM zorya_project_text_current WHERE worktree_id=$1',
            [identity.worktreeId],
          )
          if (
            confirmedIdentity.repoId !== identity.repoId ||
            confirmedIdentity.head !== identity.head ||
            confirmedIdentity.branch !== identity.branch ||
            currentRow.rows[0]?.snapshot_id !== snapshotId
          )
            throw new CodeIndexError('PROJECT_TEXT_SOURCE_CHANGED')
          await db.transaction(async (tx) => {
            const generationRow = await tx.query<{ generation: string }>(
              'SELECT generation FROM zorya_project_text_generations WHERE worktree_id=$1 FOR UPDATE',
              [identity.worktreeId],
            )
            if (Number(generationRow.rows[0]?.generation) !== generation)
              throw new CodeIndexError('PROJECT_TEXT_GENERATION_SUPERSEDED')
            const currentRow = await tx.query<{ snapshot_id: string }>(
              'SELECT snapshot_id FROM zorya_project_text_current WHERE worktree_id=$1 FOR UPDATE',
              [identity.worktreeId],
            )
            if (currentRow.rows[0]?.snapshot_id !== snapshotId)
              throw new CodeIndexError('PROJECT_TEXT_SNAPSHOT_SUPERSEDED')
            await tx.query(
              'DELETE FROM zorya_project_text_snapshots WHERE worktree_id=$1 AND snapshot_id<>$2',
              [identity.worktreeId, snapshotId],
            )
            await tx.query('DELETE FROM zorya_project_text_staging WHERE worktree_id=$1', [
              identity.worktreeId,
            ])
          }, controller.signal)
          try {
            input.onProgress?.({ files: e.files.length, chunks: chunks.length })
          } catch {
            /* Progress observers do not own index publication. */
          }
          return {
            identity: publicIdentity(identity, snapshotId, e.treeHash),
            snapshotId,
            fileCount: e.files.length,
            chunkCount: chunks.length,
            treeHash: e.treeHash,
            profileId,
          }
        }
        if (profileId)
          await db.transaction(async (tx) => {
            const currentGeneration = await tx.query<{ generation: string }>(
              'SELECT generation FROM zorya_project_text_generations WHERE worktree_id=$1 FOR UPDATE',
              [identity.worktreeId],
            )
            if (Number(currentGeneration.rows[0]?.generation) !== generation)
              throw new CodeIndexError('PROJECT_TEXT_GENERATION_SUPERSEDED')
            await tx.query(
              'DELETE FROM zorya_project_text_staging WHERE worktree_id=$1 AND scope_id=$2 AND profile_id=$3 AND chunk_id<>ALL($4)',
              [identity.worktreeId, scopeId, profileId, chunks.map((chunk) => chunk.id)],
            )
          }, controller.signal)
        let vectors: Array<number[] | null> = chunks.map(() => null)
        if (docProvider && profileId && queryProvider) {
          for (let offset = 0; offset < chunks.length; offset += 256) {
            const batchChunks = chunks.slice(offset, offset + 256)
            const reusable = await db.query<{
              chunk_id: string
              content_hash: string
              vector_json: unknown
            }>(
              `SELECT chunk_id,content_hash,vector_json FROM zorya_project_text_staging
               WHERE worktree_id=$1 AND scope_id=$2 AND profile_id=$3 AND chunk_id=ANY($4)
               UNION ALL
               SELECT c.id AS chunk_id,c.content_hash,c.vector_json FROM zorya_project_text_chunks c
               JOIN zorya_project_text_snapshots s USING(snapshot_id)
               JOIN zorya_project_text_current published
                 ON published.worktree_id=s.worktree_id AND published.snapshot_id=s.snapshot_id
               WHERE s.worktree_id=$1 AND s.scope_id=$2 AND s.profile_id=$3 AND c.id=ANY($4) AND c.vector_json IS NOT NULL`,
              [identity.worktreeId, scopeId, profileId, batchChunks.map((chunk) => chunk.id)],
            )
            const reusableByKey = new Map(
              reusable.rows.map((row) => [`${row.chunk_id}\0${row.content_hash}`, row.vector_json]),
            )
            for (let index = 0; index < batchChunks.length; index++) {
              const chunk = batchChunks[index]!
              const value = reusableByKey.get(`${chunk.id}\0${chunk.contentHash}`)
              if (value)
                vectors[offset + index] = validateVector(value, docProvider.profile.dimensions)
            }
          }
          const missing = chunks.map((_, i) => i).filter((i) => vectors[i] === null)
          for (let offset = 0; offset < missing.length; offset += 32) {
            controller.signal.throwIfAborted()
            const batchIndices = missing.slice(offset, offset + 32)
            assertProfileStable()
            const batch = await docProvider.embed({
              texts: batchIndices.map((i) => chunks[i]!.text),
              signal: controller.signal,
            })
            assertProfileStable()
            if (!Array.isArray(batch) || batch.length !== batchIndices.length)
              throw new CodeIndexError('PROJECT_TEXT_VECTOR_INVALID')
            const settled = batch.map((value) =>
              validateVector(value, docProvider.profile.dimensions),
            )
            await db.transaction(async (tx) => {
              const currentGeneration = await tx.query<{ generation: string }>(
                'SELECT generation FROM zorya_project_text_generations WHERE worktree_id=$1 FOR UPDATE',
                [identity.worktreeId],
              )
              if (Number(currentGeneration.rows[0]?.generation) !== generation)
                throw new CodeIndexError('PROJECT_TEXT_GENERATION_SUPERSEDED')
              for (let j = 0; j < batchIndices.length; j++) {
                const i = batchIndices[j]!,
                  vector = settled[j]!,
                  chunk = chunks[i]!
                vectors[i] = vector
                await tx.query(
                  'INSERT INTO zorya_project_text_staging(worktree_id,scope_id,profile_id,chunk_id,content_hash,vector_json) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(worktree_id,scope_id,profile_id,chunk_id,content_hash) DO UPDATE SET vector_json=EXCLUDED.vector_json,settled_at=now()',
                  [
                    identity.worktreeId,
                    scopeId,
                    profileId,
                    chunk.id,
                    chunk.contentHash,
                    JSON.stringify(vector),
                  ],
                )
              }
            })
            controller.signal.throwIfAborted()
          }
        }
        controller.signal.throwIfAborted()
        const current = await checkCurrent(root, e.treeHash, controller.signal)
        const finalIdentity = await identifyRoot(root, current.treeHash, controller.signal)
        if (
          current.treeHash !== e.treeHash ||
          finalIdentity.repoId !== rootIdentity.repoId ||
          finalIdentity.worktreeId !== rootIdentity.worktreeId ||
          finalIdentity.branch !== rootIdentity.branch ||
          finalIdentity.head !== rootIdentity.head ||
          active.get(root) !== entry
        )
          throw new CodeIndexError('PROJECT_TEXT_GENERATION_SUPERSEDED')
        const sid = snapshotId
        await db.transaction(async (tx) => {
          const generationRow = await tx.query<{ generation: string }>(
            'SELECT generation FROM zorya_project_text_generations WHERE worktree_id=$1 FOR UPDATE',
            [identity.worktreeId],
          )
          if (Number(generationRow.rows[0]?.generation) !== generation)
            throw new CodeIndexError('PROJECT_TEXT_GENERATION_SUPERSEDED')
          const publicationFiles = await checkCurrent(root, e.treeHash, controller.signal)
          const publicationIdentity = await identifyRoot(
            root,
            publicationFiles.treeHash,
            controller.signal,
          )
          if (
            publicationIdentity.repoId !== identity.repoId ||
            publicationIdentity.worktreeId !== identity.worktreeId ||
            publicationIdentity.branch !== identity.branch ||
            publicationIdentity.head !== identity.head
          )
            throw new CodeIndexError('PROJECT_TEXT_SOURCE_CHANGED')
          await tx.query(
            'INSERT INTO zorya_project_text_snapshots(snapshot_id,worktree_id,root,repo_id,scope_id,branch,head,content_hash,tree_hash,profile_id,file_count,chunk_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(snapshot_id) DO NOTHING',
            [
              sid,
              identity.worktreeId,
              root,
              identity.repoId,
              scopeId,
              identity.branch,
              identity.head,
              e.treeHash,
              e.treeHash,
              profileId,
              e.files.length,
              chunks.length,
            ],
          )
          await tx.query('DELETE FROM zorya_project_text_files WHERE snapshot_id=$1', [sid])
          for (const file of e.files)
            await tx.query(
              'INSERT INTO zorya_project_text_files(snapshot_id,path,content_hash,bytes) VALUES($1,$2,$3,$4)',
              [sid, file.path, file.hash, file.bytes],
            )
          await tx.query('DELETE FROM zorya_project_text_chunks WHERE snapshot_id=$1', [sid])
          for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i]!
            await tx.query(
              'INSERT INTO zorya_project_text_chunks(snapshot_id,id,path,kind,title,heading_json,line_start,line_end,body,content_hash,vector_json) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb)',
              [
                sid,
                c.id,
                c.path,
                c.kind,
                c.title,
                JSON.stringify(c.heading),
                c.lineStart,
                c.lineEnd,
                c.text,
                c.contentHash,
                vectors[i] ? JSON.stringify(vectors[i]) : null,
              ],
            )
          }
          await tx.query(
            'INSERT INTO zorya_project_text_current(worktree_id,snapshot_id,generation) VALUES($1,$2,$3) ON CONFLICT(worktree_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,generation=EXCLUDED.generation',
            [identity.worktreeId, sid, generation],
          )
          await tx.query(
            'DELETE FROM zorya_project_text_snapshots WHERE worktree_id=$1 AND snapshot_id<>$2',
            [identity.worktreeId, sid],
          )
          await tx.query('DELETE FROM zorya_project_text_staging WHERE worktree_id=$1', [
            identity.worktreeId,
          ])
        }, controller.signal)
        try {
          input.onProgress?.({ files: e.files.length, chunks: chunks.length })
        } catch {
          /* Progress observers do not own index publication. */
        }
        return {
          identity: publicIdentity(identity, sid, e.treeHash),
          snapshotId: sid,
          fileCount: e.files.length,
          chunkCount: chunks.length,
          treeHash: e.treeHash,
          profileId,
        }
      })()
      entry.promise = work
      try {
        return await work
      } finally {
        signal?.removeEventListener('abort', forwardAbort)
        if (active.get(root) === entry) active.delete(root)
      }
    },
    async indexStatus(rootInput, signal) {
      if (typeof rootInput !== 'string' || !rootInput.trim())
        throw new CodeIndexError('PROJECT_TEXT_ROOT_INVALID')
      assertOpen()
      await ensure()
      signal?.throwIfAborted()
      const root = await realpath(resolve(rootInput))
      const identity = await identifyRoot(root, '', signal)
      const q = await db.query<{
        snapshot_id: string
        indexed_at: Date | string
        file_count: number
        chunk_count: number
        tree_hash: string
        branch: string | null
        head: string | null
        scope_id: string
        repo_id: string
        worktree_id: string
        root: string
      }>(
        'SELECT s.snapshot_id,s.indexed_at,s.file_count,s.chunk_count,s.tree_hash,s.branch,s.head,s.scope_id,s.repo_id,s.worktree_id,s.root FROM zorya_project_text_current c JOIN zorya_project_text_snapshots s USING(snapshot_id) WHERE c.worktree_id=$1',
        [identity.worktreeId],
      )
      const row = q.rows[0]
      if (!row) {
        signal?.throwIfAborted()
        return {
          identity: null,
          snapshotId: null,
          indexedAt: null,
          fileCount: 0,
          chunkCount: 0,
          stale: false,
        }
      }
      const current = await sourceFingerprint(root, signal)
      const currentIdentity = await identifyRoot(root, current, signal)
      signal?.throwIfAborted()
      return {
        identity: publicIdentity(
          {
            repoId: row.repo_id,
            worktreeId: row.worktree_id,
            root: row.root,
            branch: row.branch,
            head: row.head,
          },
          row.snapshot_id,
          row.tree_hash,
        ),
        snapshotId: row.snapshot_id,
        indexedAt: isoTimestamp(row.indexed_at),
        fileCount: row.file_count,
        chunkCount: row.chunk_count,
        stale:
          current !== row.tree_hash ||
          row.scope_id !== scopeId ||
          currentIdentity.branch !== row.branch ||
          currentIdentity.head !== row.head,
      }
    },
    async searchProjectText(input: ProjectTextSearchInput) {
      if (!input || typeof input.root !== 'string' || typeof input.query !== 'string')
        throw new CodeIndexError('PROJECT_TEXT_SEARCH_INPUT_INVALID')
      assertOpen()
      const query = `${input.query}`
      const root = `${input.root}`
      const kinds = input.kinds ? [...input.kinds] : undefined
      const paths = input.paths ? [...input.paths] : undefined
      const limit = input.limit ?? 10
      const maxChars = input.maxChars ?? 24000
      const mode = input.mode ?? 'hybrid'
      if (
        !query.trim() ||
        query.length > 4000 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(maxChars) ||
        maxChars < 1 ||
        maxChars > 100000 ||
        !['lexical', 'hybrid'].includes(mode) ||
        (kinds &&
          (!Array.isArray(kinds) ||
            !kinds.length ||
            kinds.length > 3 ||
            new Set(kinds).size !== kinds.length ||
            kinds.some((k) => !validKinds.has(k)))) ||
        (paths &&
          (!Array.isArray(paths) ||
            !paths.length ||
            paths.length > 256 ||
            new Set(paths).size !== paths.length ||
            paths.some(
              (p) =>
                typeof p !== 'string' ||
                !p.length ||
                p.length > 1024 ||
                posix.isAbsolute(p) ||
                win32.isAbsolute(p) ||
                p.replaceAll('\\', '/').split('/').includes('..') ||
                /[\p{Cc}\u2028\u2029]/u.test(p),
            )))
      )
        throw new CodeIndexError('PROJECT_TEXT_SEARCH_INPUT_INVALID')
      await ensure()
      input.signal?.throwIfAborted()
      const rootReal = await realpath(resolve(root))
      const identity = await identifyRoot(rootReal, '', input.signal)
      const q = await db.query<{
        snapshot_id: string
        tree_hash: string
        profile_id: string | null
        scope_id: string
        repo_id: string
        worktree_id: string
        branch: string | null
        head: string | null
      }>(
        'SELECT s.snapshot_id,s.tree_hash,s.profile_id,s.scope_id,s.repo_id,s.worktree_id,s.branch,s.head FROM zorya_project_text_current c JOIN zorya_project_text_snapshots s USING(snapshot_id) WHERE c.worktree_id=$1',
        [identity.worktreeId],
      )
      const row = q.rows[0]
      if (!row) throw new CodeIndexError('PROJECT_TEXT_NOT_INDEXED')
      if (row.scope_id !== scopeId) throw new CodeIndexError('PROJECT_TEXT_SCOPE_MISMATCH')
      const current = await sourceFingerprint(rootReal, input.signal)
      if (current !== row.tree_hash) throw new CodeIndexError('PROJECT_TEXT_SOURCE_CHANGED')
      const openingIdentity = await identifyRoot(rootReal, current, input.signal)
      if (
        openingIdentity.repoId !== row.repo_id ||
        openingIdentity.worktreeId !== row.worktree_id ||
        openingIdentity.branch !== row.branch ||
        openingIdentity.head !== row.head
      )
        throw new CodeIndexError('PROJECT_TEXT_SOURCE_CHANGED')
      const clauses = ['c.snapshot_id=$1']
      const values: unknown[] = [row.snapshot_id]
      if (kinds) {
        values.push(kinds)
        clauses.push(`c.kind=ANY($${values.length})`)
      }
      if (paths) {
        values.push(paths)
        clauses.push(`c.path=ANY($${values.length})`)
      }
      if (paths) {
        const indexedPaths = await db.query<{ path: string }>(
          'SELECT path FROM zorya_project_text_files WHERE snapshot_id=$1 AND path=ANY($2)',
          [row.snapshot_id, paths],
        )
        if (indexedPaths.rows.length !== paths.length)
          throw new CodeIndexError('PROJECT_TEXT_PATH_NOT_INDEXED')
      }
      const rows = await db.query<{
        id: string
        path: string
        kind: ProjectTextKind
        title: string | null
        heading_json: unknown
        line_start: number
        line_end: number
        body: string
        content_hash: string
        file_content_hash: string
        vector_json: unknown
      }>(
        'SELECT c.id,c.path,c.kind,c.title,c.heading_json,c.line_start,c.line_end,c.body,c.content_hash,f.content_hash AS file_content_hash,c.vector_json FROM zorya_project_text_chunks c JOIN zorya_project_text_files f ON f.snapshot_id=c.snapshot_id AND f.path=c.path WHERE ' +
          clauses.join(' AND '),
        values,
      )
      const lexical = rankLexical(
        rows.rows.map((r) => ({
          id: r.id,
          path: r.path,
          symbol: null,
          text: `${r.title ?? ''} ${Array.isArray(r.heading_json) ? r.heading_json.join(' ') : ''} ${r.body}`,
          lineStart: r.line_start,
          source: r,
        })),
        query,
      ).map(({ row, score }) => ({ r: row.source, score }))
      const profileMatches =
        row.profile_id === profileId && !!profileId && !!docProvider && !!queryProvider
      const degradation =
        mode === 'hybrid' && !profileMatches
          ? !row.profile_id || !queryProvider
            ? 'embedding_profile_unavailable'
            : 'embedding_profile_mismatch'
          : undefined
      let ranked = lexical
      if (mode === 'hybrid' && profileMatches && queryProvider) {
        assertProfileStable()
        const embedded = await queryProvider.embed({
          texts: [query],
          signal: input.signal ?? new AbortController().signal,
        })
        assertProfileStable()
        input.signal?.throwIfAborted()
        if (!Array.isArray(embedded) || embedded.length !== 1)
          throw new CodeIndexError('PROJECT_TEXT_VECTOR_INVALID')
        const queryVector = validateVector(embedded[0], queryProvider.profile.dimensions)
        const dense = rows.rows
          .filter((r) => r.vector_json !== null)
          .map((r) => ({
            r,
            score: cosine(
              queryVector,
              validateVector(r.vector_json, queryProvider.profile.dimensions),
            ),
          }))
          .sort(
            (a, b) =>
              b.score - a.score ||
              a.r.path.localeCompare(b.r.path) ||
              a.r.line_start - b.r.line_start,
          )
        const ranks = new Map<string, number>()
        lexical.forEach((item, index) => ranks.set(item.r.id, 1 / (60 + index + 1)))
        dense.forEach((item, index) =>
          ranks.set(item.r.id, (ranks.get(item.r.id) ?? 0) + 1 / (60 + index + 1)),
        )
        const byId = new Map(rows.rows.map((r) => [r.id, r]))
        ranked = [...ranks]
          .map(([id, score]) => ({ r: byId.get(id)!, score }))
          .sort(
            (a, b) =>
              b.score - a.score ||
              a.r.path.localeCompare(b.r.path) ||
              a.r.line_start - b.r.line_start,
          )
      }
      let candidates = ranked.slice(0, Math.max(limit, rerankCandidateLimit))
      let rerankStatus:
        | { status: 'complete' | 'incomplete' | 'empty'; requested: number; returned: number }
        | undefined
      if (mode === 'hybrid' && reranker && rerankCandidateLimit > 0 && candidates.length) {
        const documents = candidates.map(
          ({ r }) =>
            `${r.path}\n${r.title ?? ''}\n${Array.isArray(r.heading_json) ? r.heading_json.join(' > ') : ''}\n${r.body}`,
        )
        const requested = Math.min(limit, documents.length)
        const ordered = await reranker({
          query,
          documents,
          topN: requested,
          signal: input.signal ?? new AbortController().signal,
        })
        input.signal?.throwIfAborted()
        if (
          !Array.isArray(ordered) ||
          ordered.length > requested ||
          ordered.some(
            (item) =>
              !item ||
              typeof item !== 'object' ||
              !Number.isInteger(item.index) ||
              item.index < 0 ||
              item.index >= documents.length ||
              !Number.isFinite(item.score),
          ) ||
          new Set(ordered.map((item) => item.index)).size !== ordered.length
        )
          throw new CodeIndexError('PROJECT_TEXT_RERANK_INVALID')
        rerankStatus = {
          status:
            ordered.length === 0 ? 'empty' : ordered.length < requested ? 'incomplete' : 'complete',
          requested,
          returned: ordered.length,
        }
        candidates = [...ordered]
          .sort((a, b) => b.score - a.score || a.index - b.index)
          .map((item) => ({ r: candidates[item.index]!.r, score: item.score }))
      }
      const selected = candidates.slice(0, limit)
      let remaining = maxChars
      const hits = selected
        .map(({ r, score }) => {
          const excerpt = r.body.slice(0, Math.max(0, remaining))
          remaining -= excerpt.length
          return {
            id: r.id,
            path: r.path,
            kind: r.kind,
            title: r.title,
            heading: Array.isArray(r.heading_json) ? (r.heading_json as string[]) : [],
            lineStart: r.line_start,
            lineEnd: r.line_end,
            contentHash: r.content_hash,
            fileContentHash: r.file_content_hash,
            snapshotId: row.snapshot_id,
            score,
            excerpt,
            truncated: excerpt.length < r.body.length,
          }
        })
        .filter((h) => h.excerpt.length)
      const final = await sourceFingerprint(rootReal, input.signal)
      const finalIdentity = await identifyRoot(rootReal, final, input.signal)
      if (
        final !== row.tree_hash ||
        finalIdentity.head !== row.head ||
        finalIdentity.branch !== row.branch
      )
        throw new CodeIndexError('PROJECT_TEXT_SOURCE_CHANGED')
      const dbFence = await db.query<{ snapshot_id: string }>(
        'SELECT snapshot_id FROM zorya_project_text_current WHERE worktree_id=$1',
        [identity.worktreeId],
      )
      if (dbFence.rows[0]?.snapshot_id !== row.snapshot_id)
        throw new CodeIndexError('PROJECT_TEXT_SNAPSHOT_SUPERSEDED')
      input.signal?.throwIfAborted()
      return {
        identity: publicIdentity(
          {
            repoId: row.repo_id,
            worktreeId: row.worktree_id,
            root: rootReal,
            branch: row.branch,
            head: row.head,
          },
          row.snapshot_id,
          row.tree_hash,
        ),
        snapshotId: row.snapshot_id,
        hits,
        truncated:
          candidates.length > hits.length ||
          ranked.length > limit ||
          hits.some((hit) => hit.truncated) ||
          (rerankStatus !== undefined && rerankStatus.status !== 'complete'),
        ...(degradation ? { degradation } : {}),
        ...(rerankStatus ? { rerank: rerankStatus } : {}),
      }
    },
    async readProjectText(input: ProjectTextReadInput) {
      if (!input || typeof input.root !== 'string' || typeof input.path !== 'string')
        throw new CodeIndexError('PROJECT_TEXT_RANGE_INVALID')
      assertOpen()
      const path = `${input.path}`
      const start = input.lineStart ?? 1
      const end = input.lineEnd ?? start + 199
      if (
        !path ||
        path.length > 1024 ||
        posix.isAbsolute(path) ||
        win32.isAbsolute(path) ||
        path.replaceAll('\\', '/').split('/').includes('..') ||
        /[\p{Cc}\u2028\u2029]/u.test(path) ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 1 ||
        end < start ||
        end - start >= 200
      )
        throw new CodeIndexError('PROJECT_TEXT_RANGE_INVALID')
      await ensure()
      input.signal?.throwIfAborted()
      const root = await realpath(resolve(`${input.root}`))
      const identity = await identifyRoot(root, '', input.signal)
      const q = await db.query<{
        snapshot_id: string
        tree_hash: string
        scope_id: string
        repo_id: string
        worktree_id: string
        branch: string | null
        head: string | null
      }>(
        'SELECT s.snapshot_id,s.tree_hash,s.scope_id,s.repo_id,s.worktree_id,s.branch,s.head FROM zorya_project_text_current c JOIN zorya_project_text_snapshots s USING(snapshot_id) WHERE c.worktree_id=$1',
        [identity.worktreeId],
      )
      const row = q.rows[0]
      if (!row) throw new CodeIndexError('PROJECT_TEXT_NOT_INDEXED')
      if (input.snapshotId && row.snapshot_id !== input.snapshotId)
        throw new CodeIndexError('PROJECT_TEXT_SNAPSHOT_MISMATCH')
      if (row.scope_id !== scopeId) throw new CodeIndexError('PROJECT_TEXT_SCOPE_MISMATCH')
      const membership = await db.query<{ content_hash: string }>(
        'SELECT content_hash FROM zorya_project_text_files WHERE snapshot_id=$1 AND path=$2',
        [row.snapshot_id, path],
      )
      if (!membership.rows[0]) throw new CodeIndexError('PROJECT_TEXT_PATH_NOT_INDEXED')
      if ((await sourceFingerprint(root, input.signal)) !== row.tree_hash)
        throw new CodeIndexError('PROJECT_TEXT_SOURCE_CHANGED')
      const file = await readScopedFile(
        root,
        path,
        limits.maxFileBytes,
        input.signal,
        commonPathPolicy.excludes,
      )
      if (file.hash !== membership.rows[0].content_hash)
        throw new CodeIndexError('PROJECT_TEXT_SOURCE_CHANGED')
      const lines = file.text.split('\n')
      if (start > lines.length) throw new CodeIndexError('PROJECT_TEXT_RANGE_OUT_OF_BOUNDS')
      const actualEnd = Math.min(end, lines.length)
      const text = lines.slice(start - 1, actualEnd).join('\n')
      const finalHash = await sourceFingerprint(root, input.signal)
      const finalIdentity = await identifyRoot(root, finalHash, input.signal)
      if (
        finalHash !== row.tree_hash ||
        finalIdentity.repoId !== row.repo_id ||
        finalIdentity.worktreeId !== row.worktree_id ||
        finalIdentity.head !== row.head ||
        finalIdentity.branch !== row.branch
      )
        throw new CodeIndexError('PROJECT_TEXT_SOURCE_CHANGED')
      const dbFence = await db.query<{ snapshot_id: string }>(
        'SELECT snapshot_id FROM zorya_project_text_current WHERE worktree_id=$1',
        [identity.worktreeId],
      )
      if (dbFence.rows[0]?.snapshot_id !== row.snapshot_id)
        throw new CodeIndexError('PROJECT_TEXT_SNAPSHOT_SUPERSEDED')
      input.signal?.throwIfAborted()
      return {
        identity: publicIdentity(
          {
            repoId: row.repo_id,
            worktreeId: row.worktree_id,
            root,
            branch: row.branch,
            head: row.head,
          },
          row.snapshot_id,
          row.tree_hash,
        ),
        path,
        snapshotId: row.snapshot_id,
        lineStart: start,
        lineEnd: actualEnd,
        text,
        contentHash: file.hash,
        truncated: actualEnd < end,
      }
    },
    sourceFingerprint,
  }
  const runOwned = <T>(
    signal: AbortSignal | undefined,
    work: (ownedSignal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    assertOpen()
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const promise = work(controller.signal)
    const tracked = { controller, promise }
    operations.add(tracked)
    void promise
      .finally(() => {
        operations.delete(tracked)
        signal?.removeEventListener('abort', onAbort)
      })
      .catch(() => {})
    return promise
  }
  return {
    indexRepository(input) {
      const snapshot = { ...input }
      return runOwned(snapshot.signal, (signal) => api.indexRepository({ ...snapshot, signal }))
    },
    indexStatus(root, signal) {
      return runOwned(signal, (ownedSignal) => api.indexStatus(`${root}`, ownedSignal))
    },
    searchProjectText(input) {
      if (
        !input ||
        (input.kinds !== undefined && !Array.isArray(input.kinds)) ||
        (input.paths !== undefined && !Array.isArray(input.paths))
      )
        throw new CodeIndexError('PROJECT_TEXT_SEARCH_INPUT_INVALID')
      const snapshot = {
        ...input,
        ...(input.kinds ? { kinds: [...input.kinds] } : {}),
        ...(input.paths ? { paths: [...input.paths] } : {}),
      }
      return runOwned(snapshot.signal, (signal) => api.searchProjectText({ ...snapshot, signal }))
    },
    readProjectText(input) {
      const snapshot = { ...input }
      return runOwned(snapshot.signal, (signal) => api.readProjectText({ ...snapshot, signal }))
    },
    sourceFingerprint(root, signal) {
      return runOwned(signal, (ownedSignal) => api.sourceFingerprint(`${root}`, ownedSignal))
    },
    close() {
      if (closing) return closing
      closed = true
      for (const operation of operations)
        operation.controller.abort(new CodeIndexError('PROJECT_TEXT_INDEX_CLOSED'))
      for (const item of active.values())
        item.controller.abort(new CodeIndexError('PROJECT_TEXT_INDEX_CLOSED'))
      closing = (async () => {
        await Promise.allSettled([...operations].map((operation) => operation.promise))
        await Promise.allSettled(
          [...active.values()].flatMap((item) => (item.promise ? [item.promise] : [])),
        )
      })()
      return closing
    },
  }
}
