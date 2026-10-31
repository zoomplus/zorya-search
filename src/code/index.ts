import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { posix, resolve } from 'node:path'
import type {
  CodeIndex,
  CodeIndexOptions,
  CodeIndexStatus,
  CodeSourceIdentity,
  CodeHit,
  CodeIndexLimits,
  CodeChunk,
  CodeEmbeddingProfile,
} from './types.js'
import { CodeIndexError } from './errors.js'
import { createCodePathPolicy, enumerateCode, readScopedFile } from './enumerate.js'
import { identifyRoot } from './identity.js'
import {
  chunkCode,
  CODE_CHUNKER_VERSION,
  CODE_PARSER_VERSION,
  resolveLocalImport,
} from './chunker.js'
import { initializeCodeIndex } from './schema.js'
import { rankLexical, reciprocalRankFusion } from './ranking.js'
import { watchCodeRoot } from './watch.js'

const DEFAULT_LIMITS: CodeIndexLimits = {
  maxFiles: 5000,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 256_000_000,
  maxChunks: 10_000,
  maxChunkChars: 8000,
  maxQueryChars: 4000,
  maxScanChunks: 10_000,
  maxResults: 100,
}
const HARD_LIMITS: CodeIndexLimits = {
  maxFiles: 20_000,
  maxFileBytes: 10_000_000,
  maxTotalBytes: 1_000_000_000,
  maxChunks: 50_000,
  maxChunkChars: 32_000,
  maxQueryChars: 10_000,
  maxScanChunks: 50_000,
  maxResults: 500,
}
type Stored = CodeChunk & { vector_json: unknown; current_snapshot?: string }
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const checkAbort = (signal?: AbortSignal) => signal?.throwIfAborted()

function validateProfile(profile: CodeEmbeddingProfile | undefined): CodeEmbeddingProfile {
  if (
    !profile ||
    !profile.provider?.trim() ||
    profile.provider.length > 256 ||
    !profile.space?.trim() ||
    profile.space.length > 512 ||
    !profile.model?.trim() ||
    profile.model.length > 256 ||
    !Number.isInteger(profile.dimensions) ||
    profile.dimensions < 1 ||
    profile.dimensions > 4096 ||
    profile.inputType !== 'text' ||
    profile.chunkerVersion !== CODE_CHUNKER_VERSION
  )
    throw new CodeIndexError('CODE_INDEX_EMBEDDING_PROFILE_REQUIRED')
  return profile
}

function vector(value: unknown, dimensions: number): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== dimensions ||
    !value.every((part) => typeof part === 'number' && Number.isFinite(part))
  )
    throw new CodeIndexError('CODE_INDEX_VECTOR_INVALID')
  const magnitude = Math.sqrt(value.reduce((sum, part) => sum + part * part, 0))
  if (!Number.isFinite(magnitude) || magnitude === 0)
    throw new CodeIndexError('CODE_INDEX_VECTOR_INVALID')
  return value as number[]
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length)
    throw new CodeIndexError('CODE_INDEX_VECTOR_DIMENSION_MISMATCH')
  const dot = a.reduce((sum, value, index) => sum + value * b[index]!, 0)
  const normA = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0))
  const normB = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0))
  if (!Number.isFinite(dot + normA + normB) || !normA || !normB)
    throw new CodeIndexError('CODE_INDEX_VECTOR_INVALID')
  return dot / (normA * normB)
}

export function createCodeIndex(options: CodeIndexOptions): CodeIndex {
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  for (const [key, value] of Object.entries(limits))
    if (!Number.isInteger(value) || value < 1 || value > HARD_LIMITS[key as keyof CodeIndexLimits])
      throw new CodeIndexError('CODE_INDEX_LIMIT_INVALID', `Invalid code index limit: ${key}`)
  const validatedProfile = options.models ? validateProfile(options.profile) : undefined
  const pathPolicy = createCodePathPolicy(options.exclude)
  const profile = validatedProfile ? Object.freeze({ ...validatedProfile }) : undefined
  if (options.models && typeof options.models.embed !== 'function')
    throw new CodeIndexError('CODE_INDEX_MODELS_INVALID')
  const models = options.models
    ? Object.freeze({
        embed: options.models.embed.bind(options.models),
        ...(options.models.rerank ? { rerank: options.models.rerank.bind(options.models) } : {}),
      })
    : undefined
  if (!options.models && options.profile)
    throw new CodeIndexError('CODE_INDEX_PROFILE_WITHOUT_EMBEDDER')
  const profileId = profile
    ? sha(
        JSON.stringify([
          profile.provider,
          profile.space,
          profile.model,
          profile.dimensions,
          profile.inputType,
          profile.chunkerVersion,
        ]),
      )
    : null
  const chunkConfigId = sha(
    JSON.stringify([
      CODE_CHUNKER_VERSION,
      CODE_PARSER_VERSION,
      limits.maxChunkChars,
      pathPolicy.id,
    ]),
  )
  const database = options.database
  let initialization: Promise<void> | undefined
  const ensureSchema = () => (initialization ??= initializeCodeIndex(database))
  const jobs = new Set<Promise<unknown>>()
  const controllers = new Set<AbortController>()
  const watchers = new Set<{ close(): Promise<void> }>()
  let watchReservations = 0
  let activeIndexJobs = 0
  let closing: Promise<void> | undefined
  let closed = false
  const ensureOpen = () => {
    if (closed) throw new CodeIndexError('CODE_INDEX_CLOSED')
  }
  function own<T>(
    callerSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    ensureOpen()
    if (jobs.size >= 64) throw new CodeIndexError('CODE_INDEX_BUSY')
    const controller = new AbortController()
    controllers.add(controller)
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal
    const job = Promise.resolve().then(() => operation(signal))
    jobs.add(job)
    return job.finally(() => {
      jobs.delete(job)
      controllers.delete(controller)
    })
  }
  const indexRepositoryInner: CodeIndex['indexRepository'] = async ({
    root: inputRoot,
    signal,
  }) => {
    ensureOpen()
    checkAbort(signal)
    await ensureSchema()
    const root = await realpath(resolve(inputRoot))
    const { files, treeHash } = await enumerateCode(root, limits, signal, pathPolicy.excludes)
    const identity = await identifyRoot(root, treeHash, signal)
    const worktreeId = identity.worktreeId
    const generationResult = await database.query<{ generation: string | number }>(
      `INSERT INTO zorya_code_worktrees(worktree_id,repo_id,root,generation) VALUES($1,$2,$3,1)
      ON CONFLICT(worktree_id) DO UPDATE SET repo_id=EXCLUDED.repo_id,root=EXCLUDED.root,generation=zorya_code_worktrees.generation+1 RETURNING generation`,
      [worktreeId, identity.repoId, identity.root],
    )
    const generation = Number(generationResult.rows[0]?.generation)
    identity.snapshotId = sha(`${identity.snapshotId}\0${profileId ?? 'lexical'}\0${chunkConfigId}`)
    const chunks: CodeChunk[] = []
    const imports: { from: string; to: string; specifier: string }[] = []
    const known = new Set(files.map((file) => file.path))
    const contents = new Map(files.map((file) => [file.path, file.text]))
    let pathMappings: Record<string, string[]> | undefined
    let baseUrl = '.'
    const tsconfig = contents.get('tsconfig.json')
    if (tsconfig) {
      const parsed = (await import('typescript')).default.parseConfigFileTextToJson(
        'tsconfig.json',
        tsconfig,
      )
      const paths = parsed.config?.compilerOptions?.paths
      const configuredBaseUrl = parsed.config?.compilerOptions?.baseUrl
      if (typeof configuredBaseUrl === 'string') baseUrl = configuredBaseUrl
      if (paths && typeof paths === 'object')
        pathMappings = Object.fromEntries(
          Object.entries(paths as Record<string, unknown>).filter(
            (entry): entry is [string, string[]] =>
              Array.isArray(entry[1]) && entry[1].every((item) => typeof item === 'string'),
          ),
        )
    }
    for (const file of files) {
      checkAbort(signal)
      const parsed = chunkCode(file, limits.maxChunkChars)
      chunks.push(...parsed.chunks.filter((chunk) => chunk.text.trim().length > 0))
      for (const specifier of parsed.imports) {
        const to = resolveLocalImport(
          root,
          file.path,
          specifier,
          known,
          contents,
          pathMappings,
          baseUrl,
        )
        if (to) imports.push({ from: file.path, to, specifier })
      }
      if (chunks.length > limits.maxChunks) throw new CodeIndexError('CODE_INDEX_CHUNK_LIMIT')
    }
    const profileForChunks = profileId
    const cached = await database.query<{ id: string; content_hash: string; vector_json: unknown }>(
      `SELECT c.id,c.content_hash,c.vector_json FROM zorya_code_worktrees w
       JOIN zorya_code_snapshots s ON s.snapshot_id=w.current_snapshot
       JOIN zorya_code_chunks c ON c.snapshot_id=s.snapshot_id
       WHERE w.worktree_id=$1 AND s.profile_id IS NOT DISTINCT FROM $2`,
      [worktreeId, profileForChunks],
    )
    const reusable = new Map(
      cached.rows.map((row) => [row.id + ':' + row.content_hash, row.vector_json]),
    )
    let vectors: (number[] | null)[] = chunks.map((chunk) =>
      reusable.has(`${chunk.id}:${chunk.contentHash}`)
        ? vectorMaybe(reusable.get(`${chunk.id}:${chunk.contentHash}`), profile?.dimensions)
        : null,
    )
    if (models) {
      const missingIndexes = vectors.flatMap((value, index) => (value ? [] : [index]))
      for (let cursor = 0; cursor < missingIndexes.length; cursor += 32) {
        checkAbort(signal)
        const indexes = missingIndexes.slice(cursor, cursor + 32)
        const embedded = await models.embed({
          texts: indexes.map((index) => chunks[index]!.text),
          signal: signal ?? new AbortController().signal,
        })
        if (!Array.isArray(embedded) || embedded.length !== indexes.length)
          throw new CodeIndexError('CODE_INDEX_VECTOR_INVALID')
        for (let offset = 0; offset < indexes.length; offset++)
          vectors[indexes[offset]!] = vector(embedded[offset], profile!.dimensions)
      }
    }
    checkAbort(signal)
    const beforePublish = await enumerateCode(root, limits, signal, pathPolicy.excludes)
    if (beforePublish.treeHash !== treeHash)
      throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_INDEX')
    const reidentified = await identifyRoot(root, treeHash, signal)
    if (
      sha(`${reidentified.snapshotId}\0${profileId ?? 'lexical'}\0${chunkConfigId}`) !==
      identity.snapshotId
    )
      throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_INDEX')
    const latest = await database.query<{ generation: string | number }>(
      'SELECT generation FROM zorya_code_worktrees WHERE worktree_id=$1',
      [worktreeId],
    )
    if (Number(latest.rows[0]?.generation) !== generation)
      throw new CodeIndexError('CODE_INDEX_STALE_GENERATION')
    const job = database.transaction(async (tx) => {
      checkAbort(signal)
      await tx.query(
        `INSERT INTO zorya_code_snapshots(snapshot_id,worktree_id,repo_id,branch,head,content_hash,profile_id,file_count,chunk_count)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(snapshot_id) DO UPDATE SET file_count=EXCLUDED.file_count,chunk_count=EXCLUDED.chunk_count,created_at=now()`,
        [
          identity.snapshotId,
          worktreeId,
          identity.repoId,
          identity.branch,
          identity.head,
          treeHash,
          profileId,
          files.length,
          chunks.length,
        ],
      )
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index]!
        await tx.query(
          `INSERT INTO zorya_code_chunks(snapshot_id,id,path,line_start,line_end,symbol,language,body,content_hash,parser_version,vector_json)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT(snapshot_id,id) DO NOTHING`,
          [
            identity.snapshotId,
            chunk.id,
            chunk.path,
            chunk.lineStart,
            chunk.lineEnd,
            chunk.symbol,
            chunk.language,
            chunk.text,
            chunk.contentHash,
            chunk.parserVersion,
            vectors[index] ? JSON.stringify(vectors[index]) : null,
          ],
        )
      }
      if (files.length)
        await tx.query(
          `INSERT INTO zorya_code_files(snapshot_id,path,content_hash,bytes) VALUES ${files.map((_, i) => `($1,$${2 + i * 3},$${3 + i * 3},$${4 + i * 3})`).join(',')} ON CONFLICT DO NOTHING`,
          [identity.snapshotId, ...files.flatMap((file) => [file.path, file.hash, file.bytes])],
        )
      for (const item of imports)
        await tx.query(
          'INSERT INTO zorya_code_imports(snapshot_id,from_path,to_path,specifier) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [identity.snapshotId, item.from, item.to, item.specifier],
        )
      const current = await tx.query<{ generation: string | number }>(
        'SELECT generation FROM zorya_code_worktrees WHERE worktree_id=$1 FOR UPDATE',
        [worktreeId],
      )
      if (Number(current.rows[0]?.generation) !== generation)
        throw new CodeIndexError('CODE_INDEX_STALE_GENERATION')
      const finalFiles = await enumerateCode(root, limits, signal, pathPolicy.excludes)
      const finalIdentity = await identifyRoot(root, finalFiles.treeHash, signal)
      if (
        finalFiles.treeHash !== treeHash ||
        sha(`${finalIdentity.snapshotId}\0${profileId ?? 'lexical'}\0${chunkConfigId}`) !==
          identity.snapshotId
      )
        throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_INDEX')
      const published = await tx.query(
        `UPDATE zorya_code_worktrees SET current_snapshot=$2,branch=$3,head=$4,content_hash=$5,profile_id=$6,chunk_config_id=$7,indexed_at=now() WHERE worktree_id=$1 AND generation=$8`,
        [
          worktreeId,
          identity.snapshotId,
          identity.branch,
          identity.head,
          treeHash,
          profileId,
          chunkConfigId,
          generation,
        ],
      )
      if (published.rowCount !== 1) throw new CodeIndexError('CODE_INDEX_STALE_GENERATION')
      await tx.query(
        `DELETE FROM zorya_code_snapshots WHERE worktree_id=$1 AND snapshot_id<>$2 AND snapshot_id NOT IN (SELECT snapshot_id FROM zorya_code_snapshots WHERE worktree_id=$1 ORDER BY created_at DESC LIMIT 2)`,
        [worktreeId, identity.snapshotId],
      )
    }, signal)
    await job
    return statusFrom(
      identity,
      new Date().toISOString(),
      files.length,
      chunks.length,
      profileId,
      null,
      profileId,
    )
  }
  const indexRepository: CodeIndex['indexRepository'] = (input) =>
    own(input.signal, async (signal) => {
      if (activeIndexJobs >= 8) throw new CodeIndexError('CODE_INDEX_BUSY')
      activeIndexJobs++
      try {
        return await indexRepositoryInner({ root: input.root, signal })
      } finally {
        activeIndexJobs--
      }
    })

  async function current(
    rootInput: string,
    signal?: AbortSignal,
  ): Promise<{
    identity: CodeSourceIdentity
    snapshot: string
    profileId: string | null
    indexedAt: string
    fileCount: number
    chunkCount: number
  }> {
    ensureOpen()
    checkAbort(signal)
    await ensureSchema()
    const root = await realpath(resolve(rootInput))
    const { files, treeHash } = await enumerateCode(root, limits, signal, pathPolicy.excludes)
    const identity = await identifyRoot(root, treeHash, signal)
    const result = await database.query<{
      current_snapshot: string | null
      content_hash: string | null
      root: string
      branch: string | null
      head: string | null
      profile_id: string | null
      chunk_config_id: string | null
      indexed_at: string | Date | null
      file_count: number
      chunk_count: number
    }>(
      `SELECT w.current_snapshot,w.content_hash,w.root,w.branch,w.head,w.profile_id,w.chunk_config_id,w.indexed_at,s.file_count,s.chunk_count FROM zorya_code_worktrees w LEFT JOIN zorya_code_snapshots s ON s.snapshot_id=w.current_snapshot WHERE w.worktree_id=$1`,
      [identity.worktreeId],
    )
    const row = result.rows[0]
    if (
      !row?.current_snapshot ||
      row.root !== root ||
      row.content_hash !== treeHash ||
      row.chunk_config_id !== chunkConfigId ||
      identity.branch !== row.branch ||
      identity.head !== row.head
    )
      throw new CodeIndexError('CODE_INDEX_STALE')
    identity.snapshotId = row.current_snapshot
    identity.contentHash = treeHash
    identity.branch = row.branch
    identity.head = row.head
    return {
      identity,
      snapshot: row.current_snapshot,
      profileId: row.profile_id,
      indexedAt: row.indexed_at ? new Date(row.indexed_at).toISOString() : '',
      fileCount: row.file_count ?? 0,
      chunkCount: row.chunk_count ?? 0,
    }
  }

  async function indexStatusInner(root: string, signal?: AbortSignal): Promise<CodeIndexStatus> {
    try {
      const value = await current(root, signal)
      return statusFrom(
        value.identity,
        value.indexedAt,
        value.fileCount,
        value.chunkCount,
        value.profileId,
        denseReason(value.profileId, true, profileId),
        profileId,
      )
    } catch (error) {
      if (error instanceof CodeIndexError && error.code === 'CODE_INDEX_STALE')
        return statusFrom(null, null, 0, 0, null, denseReason(null, false, profileId), profileId)
      throw error
    }
  }
  const indexStatus: CodeIndex['indexStatus'] = (root, signal) =>
    own(signal, (ownedSignal) => indexStatusInner(root, ownedSignal))

  const searchCodeInner: CodeIndex['searchCode'] = async (input) => {
    checkAbort(input.signal)
    if (!input.query.trim() || input.query.length > limits.maxQueryChars)
      throw new CodeIndexError('CODE_INDEX_QUERY_INVALID')
    if (input.mode !== undefined && input.mode !== 'hybrid' && input.mode !== 'lexical')
      throw new CodeIndexError('CODE_INDEX_MODE_INVALID')
    if (
      input.paths &&
      (input.paths.length > 256 ||
        input.paths.some(
          (path) =>
            !path ||
            path.length > 1024 ||
            path.startsWith('/') ||
            path.split(/[\\/]/u).includes('..'),
        ))
    )
      throw new CodeIndexError('CODE_INDEX_PATH_FILTER_INVALID')
    const snapshot = await current(input.root, input.signal)
    const cap = input.limit ?? 10
    if (!Number.isInteger(cap) || cap < 1 || cap > limits.maxResults)
      throw new CodeIndexError('CODE_INDEX_RESULT_LIMIT')
    const mode = input.mode ?? (models ? 'hybrid' : 'lexical')
    const rows = await database.query<Stored>(
      `SELECT c.id,c.path,c.line_start AS "lineStart",c.line_end AS "lineEnd",c.symbol,c.language,c.body AS text,c.content_hash AS "contentHash",c.parser_version AS "parserVersion",c.vector_json FROM zorya_code_chunks c WHERE c.snapshot_id=$1 ORDER BY c.path,c.line_start LIMIT $2`,
      [snapshot.snapshot, limits.maxScanChunks + 1],
    )
    if (rows.rows.length > limits.maxScanChunks)
      throw new CodeIndexError('CODE_INDEX_QUERY_SCAN_LIMIT')
    const filtered = rows.rows.filter(
      (row) =>
        (!input.language || row.language === input.language) &&
        (!input.paths?.length ||
          input.paths.some(
            (path) =>
              row.path === path || row.path.startsWith(path.endsWith('/') ? path : `${path}/`),
          )),
    )
    const lexical = rankLexical(filtered, input.query)
    const lexicalRanks = new Map(lexical.map((item, index) => [item.row.id, index + 1]))
    let denseRanks = new Map<string, number>()
    let degradedReason =
      mode === 'hybrid' && !models
        ? (denseReason(snapshot.profileId, true, profileId) ?? undefined)
        : undefined
    if (mode === 'hybrid' && models && profile && snapshot.profileId === profileId) {
      const queryHash = sha(input.query)
      const cacheKey = sha(
        `${snapshot.identity.repoId}\0${snapshot.identity.worktreeId}\0${snapshot.snapshot}\0${profileId}\0${queryHash}`,
      )
      const cachedQuery = await database.query<{ vector_json: unknown }>(
        'SELECT vector_json FROM zorya_code_query_vectors WHERE cache_key=$1',
        [cacheKey],
      )
      let queryVector: number[]
      if (cachedQuery.rows[0])
        queryVector = vector(cachedQuery.rows[0].vector_json, profile.dimensions)
      else {
        const queryVectors = await models.embed({
          texts: [input.query],
          signal: input.signal ?? new AbortController().signal,
        })
        if (!Array.isArray(queryVectors) || queryVectors.length !== 1)
          throw new CodeIndexError('CODE_INDEX_VECTOR_INVALID')
        if (!Array.isArray(queryVectors) || queryVectors.length !== 1)
          throw new CodeIndexError('CODE_INDEX_VECTOR_INVALID')
        queryVector = vector(queryVectors[0], profile.dimensions)
        await database.query(
          `INSERT INTO zorya_code_query_vectors(cache_key,repo_id,worktree_id,snapshot_id,profile_id,query_hash,vector_json) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(cache_key) DO NOTHING`,
          [
            cacheKey,
            snapshot.identity.repoId,
            snapshot.identity.worktreeId,
            snapshot.snapshot,
            profileId,
            queryHash,
            JSON.stringify(queryVector),
          ],
        )
        await database.query(
          `DELETE FROM zorya_code_query_vectors WHERE cache_key IN (SELECT cache_key FROM zorya_code_query_vectors ORDER BY created_at DESC OFFSET 1000)`,
        )
      }
      const dense = filtered
        .flatMap((row) => {
          if (!row.vector_json) return []
          const embedding = vector(row.vector_json, profile.dimensions)
          return [{ id: row.id, score: cosine(queryVector, embedding) }]
        })
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      denseRanks = new Map(dense.map((item, index) => [item.id, index + 1]))
    } else if (mode === 'hybrid' && models)
      degradedReason = denseReason(snapshot.profileId, true, profileId) ?? undefined
    const ranked = reciprocalRankFusion(filtered, lexicalRanks, denseRanks)
    let result = ranked.slice(0, cap)
    let rerankRanks = new Map<string, number>()
    if (mode === 'hybrid' && models?.rerank && profile && !degradedReason && result.length) {
      const reranked = await models.rerank({
        query: input.query,
        documents: result.map((item) => item.row.text),
        signal: input.signal ?? new AbortController().signal,
      })
      if (
        !Array.isArray(reranked) ||
        reranked.some(
          (item) =>
            !Number.isInteger(item.index) ||
            item.index < 0 ||
            item.index >= result.length ||
            !Number.isFinite(item.score),
        ) ||
        new Set(reranked.map((item) => item.index)).size !== reranked.length
      )
        throw new CodeIndexError('CODE_INDEX_RERANK_INVALID')
      rerankRanks = new Map(
        reranked
          .slice()
          .sort((a, b) => b.score - a.score || a.index - b.index)
          .map((item, index) => [result[item.index]!.row.id, index + 1]),
      )
      const byId = new Map(result.map((item) => [item.row.id, item]))
      result = [...rerankRanks.keys()]
        .flatMap((id) => {
          const item = byId.get(id)
          return item ? [item] : []
        })
        .concat(result.filter((item) => !rerankRanks.has(item.row.id)))
    }
    const hits: CodeHit[] = result.map(({ row, lexicalRank, denseRank, score }) => ({
      id: row.id,
      path: row.path,
      lineStart: row.lineStart,
      lineEnd: row.lineEnd,
      symbol: row.symbol,
      language: row.language,
      contentHash: row.contentHash,
      repoId: snapshot.identity.repoId,
      worktreeId: snapshot.identity.worktreeId,
      branch: snapshot.identity.branch,
      head: snapshot.identity.head,
      snapshotId: snapshot.snapshot,
      profileId: snapshot.profileId,
      score,
      ranking: {
        mode: mode === 'hybrid' && !degradedReason ? 'hybrid' : 'lexical',
        lexicalRank,
        denseRank,
        rerankRank: rerankRanks.get(row.id) ?? null,
        ...(degradedReason ? { degradedReason } : {}),
      },
    }))
    const after = await current(input.root, input.signal)
    if (after.snapshot !== snapshot.snapshot)
      throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_SEARCH')
    return {
      hits,
      identity: snapshot.identity,
      degraded: Boolean(degradedReason),
      degradedReason: degradedReason ?? null,
    }
  }
  const searchCode: CodeIndex['searchCode'] = (input) =>
    own(input.signal, (signal) => searchCodeInner({ ...input, signal }))

  const readSourceInner: CodeIndex['readSource'] = async (input) => {
    checkAbort(input.signal)
    const before = await current(input.root, input.signal)
    if (input.snapshotId && input.snapshotId !== before.snapshot)
      throw new CodeIndexError('CODE_INDEX_SNAPSHOT_MISMATCH')
    const currentFile = await readScopedFile(
      before.identity.root,
      input.path,
      limits.maxFileBytes,
      input.signal,
      pathPolicy.excludes,
    )
    const stored = await database.query<{ content_hash: string }>(
      'SELECT content_hash FROM zorya_code_files WHERE snapshot_id=$1 AND path=$2',
      [before.snapshot, input.path.replaceAll('\\', '/')],
    )
    if (!stored.rows[0] || stored.rows[0].content_hash !== currentFile.hash)
      throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED')
    const lines = currentFile.text.split(/\r?\n/u)
    const start = input.lineStart ?? 1
    const end = input.lineEnd ?? Math.min(lines.length, start + 199)
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      start > lines.length ||
      end < start ||
      end > lines.length ||
      end - start > 999
    )
      throw new CodeIndexError('CODE_INDEX_LINE_RANGE_INVALID')
    const text = lines.slice(start - 1, end).join('\n')
    const after = await current(input.root, input.signal)
    if (after.snapshot !== before.snapshot)
      throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_READ')
    return {
      path: input.path.replaceAll('\\', '/'),
      lineStart: start,
      lineEnd: Math.min(end, lines.length),
      text,
      contentHash: currentFile.hash,
      snapshotId: before.snapshot,
      stale: false,
    }
  }
  const readSource: CodeIndex['readSource'] = (input) =>
    own(input.signal, (signal) => readSourceInner({ ...input, signal }))

  const relatedCodeInner: CodeIndex['relatedCode'] = async (input) => {
    const snapshot = await current(input.root, input.signal)
    if (
      !input.path ||
      input.path.length > 1024 ||
      input.path.startsWith('/') ||
      input.path.split(/[\\/]/u).includes('..')
    )
      throw new CodeIndexError('CODE_INDEX_PATH_FILTER_INVALID')
    const canonicalPath = posix.normalize(input.path.replaceAll('\\', '/'))
    if (pathPolicy.excludes(canonicalPath))
      throw new CodeIndexError('CODE_INDEX_SOURCE_UNAVAILABLE')
    const present = await database.query(
      'SELECT 1 FROM zorya_code_files WHERE snapshot_id=$1 AND path=$2',
      [snapshot.snapshot, canonicalPath],
    )
    if (!present.rows.length) throw new CodeIndexError('CODE_INDEX_SOURCE_UNAVAILABLE')
    const imports = await database.query<{ to_path: string }>(
      'SELECT to_path FROM zorya_code_imports WHERE snapshot_id=$1 AND from_path=$2 ORDER BY to_path',
      [snapshot.snapshot, canonicalPath],
    )
    const importedBy = await database.query<{ from_path: string }>(
      'SELECT from_path FROM zorya_code_imports WHERE snapshot_id=$1 AND to_path=$2 ORDER BY from_path',
      [snapshot.snapshot, canonicalPath],
    )
    const query =
      input.symbol ??
      canonicalPath
        .split('/')
        .at(-1)!
        .replace(/\.[^.]+$/u, '')
    const found = await searchCode({
      root: input.root,
      query,
      limit: input.limit ?? 8,
      mode: 'lexical',
      ...(input.signal ? { signal: input.signal } : {}),
      paths: [],
    })
    if (found.identity.snapshotId !== snapshot.snapshot)
      throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_SEARCH')
    const after = await current(input.root, input.signal)
    if (after.snapshot !== snapshot.snapshot)
      throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_SEARCH')
    const similar = found.hits.filter((hit) => hit.path !== canonicalPath)
    return {
      identity: snapshot.identity,
      imports: imports.rows.map((row) => row.to_path),
      importedBy: importedBy.rows.map((row) => row.from_path),
      similar,
      stale: false,
    }
  }
  const relatedCode: CodeIndex['relatedCode'] = (input) =>
    own(input.signal, (signal) => relatedCodeInner({ ...input, signal }))

  const watchRepositoryInner: CodeIndex['watchRepository'] = async (root, watchOptions = {}) => {
    ensureOpen()
    if (watchers.size + watchReservations >= 64) throw new CodeIndexError('CODE_INDEX_WATCH_LIMIT')
    const interval = watchOptions.intervalMs ?? 5000
    if (!Number.isInteger(interval) || interval < 250 || interval > 60000)
      throw new CodeIndexError('CODE_INDEX_WATCH_INTERVAL_INVALID')
    watchReservations++
    const controller = new AbortController()
    controllers.add(controller)
    const signal = watchOptions.signal
      ? AbortSignal.any([watchOptions.signal, controller.signal])
      : controller.signal
    try {
      signal.throwIfAborted()
      ensureOpen()
      let handle: Awaited<ReturnType<typeof watchCodeRoot>> | undefined
      handle = await watchCodeRoot({
        root,
        signal,
        intervalMs: interval,
        reconcile: async () => {
          await indexRepository({ root, signal })
        },
        ...(watchOptions.onError ? { onError: watchOptions.onError } : {}),
        onClose: () => {
          controller.abort()
          if (handle) watchers.delete(handle)
          controllers.delete(controller)
        },
      })
      watchers.add(handle)
      return handle
    } catch (error) {
      controller.abort()
      controllers.delete(controller)
      throw error
    } finally {
      watchReservations--
    }
  }
  const watchRepository: CodeIndex['watchRepository'] = (root, watchOptions) => {
    ensureOpen()
    if (jobs.size >= 64) throw new CodeIndexError('CODE_INDEX_BUSY')
    const setup = watchRepositoryInner(root, watchOptions)
    jobs.add(setup)
    return setup.finally(() => {
      jobs.delete(setup)
    })
  }

  return {
    indexRepository,
    searchCode,
    indexStatus,
    readSource,
    relatedCode,
    watchRepository,
    close() {
      if (closing) return closing
      closed = true
      for (const controller of controllers) controller.abort()
      closing = (async () => {
        await Promise.allSettled([...watchers].map((watcher) => watcher.close()))
        await Promise.allSettled([...jobs])
      })()
      return closing
    },
  }
}

function vectorMaybe(value: unknown, dimensions: number | undefined): number[] | null {
  if (!value || !dimensions) return null
  try {
    return vector(typeof value === 'string' ? (JSON.parse(value) as unknown) : value, dimensions)
  } catch {
    return null
  }
}

function denseReason(
  currentProfile: string | null,
  hasIndex: boolean,
  configuredProfileId: string | null,
): string | null {
  if (!hasIndex) return 'Индекс кода ещё не создан.'
  if (!configuredProfileId) return 'Векторная модель не настроена; доступен лексический поиск.'
  if (currentProfile !== configuredProfileId)
    return 'Профиль embedding не совпадает с текущим снимком; доступен лексический поиск.'
  return null
}

function statusFrom(
  identity: CodeSourceIdentity | null,
  indexedAt: string | null,
  fileCount: number,
  chunkCount: number,
  currentProfile: string | null,
  denseDisabledReason: string | null,
  configuredProfileId: string | null,
): CodeIndexStatus {
  const reason =
    denseDisabledReason ?? denseReason(currentProfile, Boolean(identity), configuredProfileId)
  return {
    identity,
    indexedAt,
    fileCount,
    chunkCount,
    profileId: currentProfile,
    denseAvailable: Boolean(identity && currentProfile && !reason),
    denseDisabledReason: reason,
  }
}

export { CodeIndexError } from './errors.js'
export { CODE_CHUNKER_VERSION, CODE_PARSER_VERSION } from './chunker.js'
export type * from './types.js'
