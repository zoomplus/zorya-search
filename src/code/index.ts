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
  CodeDependencyGraphInput,
  CodeDependencyGraph,
  CodeDuplicatesInput,
  CodeDuplicatesResult,
} from './types.js'
import { findDuplicateBodies } from './duplicates.js'
import { CodeIndexError } from './errors.js'
import { createCodePathPolicy, enumerateCode, readScopedFile } from './enumerate.js'
import { identifyRoot } from './identity.js'
import {
  chunkCode,
  CODE_CHUNKER_VERSION,
  CODE_PARSER_VERSION,
  createLocalImportResolver,
  findTopLevelDeclarationChunks,
} from './chunker.js'
import { initializeCodeIndex } from './schema.js'
import {
  prepareLexical,
  rankLexical,
  rankPreparedLexical,
  reciprocalRankFusion,
  type PreparedLexicalCorpus,
} from './ranking.js'
import { watchCodeRoot } from './watch.js'
import { walkDependencyGraph } from './dependency-graph.js'
import { codeFilterCacheKey, codeLanguageMatches, codeSourceKindMatches, normalizeCodeLanguage, normalizeSourceKind } from './filters.js'
import { prepareSymbolAnalysis } from './symbol-indexing.js'
import { loadTypeScriptLibraryBundle } from './symbol-libraries.js'
import { analysisProfileId, claimSymbolRefresh, DEFAULT_SYMBOL_LIMITS, loadSymbolAnalysis, publishIndexedSymbolAnalysis, publishSymbolRefresh } from './symbol-storage.js'
import { createSymbolQueries } from './symbol-queries.js'
import { CODE_SYMBOL_EXTRACTOR_VERSION } from './symbol-types.js'
import ts from 'typescript'

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

function exactDeclarationQuery(query: string): string | null {
  const trimmed = query.trim()
  return /^[$_\p{ID_Start}][$\u200c\u200d_\p{ID_Continue}]*$/u.test(trimmed)
    ? trimmed
    : null
}

function isExactDeclarationSymbol(symbol: string | null, query: string): boolean {
  if (!symbol) return false
  const base = symbol.replace(/#\d+$/u, '')
  if (base === query) return true
  const overloadPrefix = `${query}@`
  return base.startsWith(overloadPrefix) && /^\d+$/u.test(base.slice(overloadPrefix.length))
}

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
  const symbolAnalysisLimits = Object.freeze({ ...DEFAULT_SYMBOL_LIMITS, maxFiles: limits.maxFiles })
  const validatedProfile = options.models ? validateProfile(options.profile) : undefined
  const pathPolicy = createCodePathPolicy(options.exclude)
  const profile = validatedProfile ? Object.freeze({ ...validatedProfile }) : undefined
  if (options.models && typeof options.models.embed !== 'function')
    throw new CodeIndexError('CODE_INDEX_MODELS_INVALID')
  const rerankCandidateLimit = options.rerankCandidateLimit ?? 0
  if (!Number.isInteger(rerankCandidateLimit) || rerankCandidateLimit < 0 || rerankCandidateLimit > 200)
    throw new CodeIndexError('CODE_INDEX_LIMIT_INVALID')
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
      limits.maxFiles,
      limits.maxFileBytes,
      limits.maxTotalBytes,
      limits.maxChunks,
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
  const prepareAndPublishCurrentSymbols = async (
    root: string,
    identity: CodeSourceIdentity,
    files: Awaited<ReturnType<typeof enumerateCode>>['files'],
    treeHash: string,
    signal: AbortSignal,
  ) => {
    const generation = await claimSymbolRefresh(database, identity.worktreeId, identity.snapshotId, signal)
    const prepared = await prepareSymbolAnalysis(root, identity.snapshotId, files, signal, symbolAnalysisLimits)
    const verified = await enumerateCode(root, limits, signal, pathPolicy.excludes)
    const reidentified = await identifyRoot(root, verified.treeHash, signal)
    const validateSource = async () => {
      const finalFiles = await enumerateCode(root, limits, signal, pathPolicy.excludes)
      const finalIdentity = await identifyRoot(root, finalFiles.treeHash, signal)
      if (finalFiles.treeHash !== treeHash || finalIdentity.repoId !== identity.repoId ||
        finalIdentity.worktreeId !== identity.worktreeId || finalIdentity.root !== identity.root ||
        finalIdentity.branch !== identity.branch || finalIdentity.head !== identity.head ||
        finalIdentity.contentHash !== identity.contentHash)
        throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_INDEX')
    }
    if (verified.treeHash !== treeHash || reidentified.repoId !== identity.repoId ||
      reidentified.worktreeId !== identity.worktreeId || reidentified.root !== identity.root ||
      reidentified.branch !== identity.branch || reidentified.head !== identity.head ||
      reidentified.contentHash !== identity.contentHash)
      throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_INDEX')
    await publishSymbolRefresh(database, identity.worktreeId, identity.snapshotId, generation,
      prepared.result, prepared.profile, signal, validateSource)
    return loadSymbolAnalysis(database, identity, identity.worktreeId, symbolAnalysisLimits)
  }
  const hasCurrentSymbolAnalysis = async (worktreeId: string, snapshotId: string, signal: AbortSignal): Promise<boolean> => {
    const libraries = await loadTypeScriptLibraryBundle({ signal, selector: 'es2023' })
    const result = await database.query<{ analysis_profile_id: string; extractor_version: string;
      typescript_version: string; compiler_options_hash: string; library_profile_id: string | null;
      limits_json: typeof symbolAnalysisLimits }>(
      `SELECT a.analysis_profile_id,a.extractor_version,a.typescript_version,a.compiler_options_hash,a.library_profile_id,a.limits_json
       FROM zorya_code_analysis_state s JOIN zorya_code_analysis a
        ON a.snapshot_id=s.snapshot_id AND a.analysis_profile_id=s.current_profile_id
        WHERE s.worktree_id=$1 AND s.snapshot_id=$2 AND a.active=true`,
      [worktreeId, snapshotId],
    )
    const row = result.rows[0]
    if (!row || row.extractor_version !== CODE_SYMBOL_EXTRACTOR_VERSION || row.typescript_version !== ts.version)
      return false
    const limits = { maxFiles: Number(row.limits_json.maxFiles), maxSymbols: Number(row.limits_json.maxSymbols),
      maxReferences: Number(row.limits_json.maxReferences), tsconfigPath: row.limits_json.tsconfigPath ?? null }
    return JSON.stringify(limits) === JSON.stringify(symbolAnalysisLimits) &&
      row.library_profile_id === libraries.profileId &&
      row.analysis_profile_id === analysisProfileId(row.extractor_version, row.typescript_version,
        row.compiler_options_hash, row.library_profile_id, limits)
  }
  const getSymbolFence = async (worktreeId: string, snapshotId: string) => {
    const result = await database.query<{ generation: string | number; current_profile_id: string | null }>(
      'SELECT generation,current_profile_id FROM zorya_code_analysis_state WHERE worktree_id=$1 AND snapshot_id=$2',
      [worktreeId, snapshotId],
    )
    return result.rows[0]
      ? { generation: Number(result.rows[0].generation), profile: result.rows[0].current_profile_id }
      : { generation: null, profile: null }
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
    onProgress,
  }) => {
    ensureOpen()
    checkAbort(signal)
    await ensureSchema()
    const root = await realpath(resolve(inputRoot))
    const { files, treeHash } = await enumerateCode(root, limits, signal, pathPolicy.excludes)
    const identity = await identifyRoot(root, treeHash, signal)
    const worktreeId = identity.worktreeId
    identity.snapshotId = sha(`${identity.snapshotId}\0${profileId ?? 'lexical'}\0${chunkConfigId}`)
    type CurrentIndexRow = {
      current_snapshot: string | null
      root: string
      branch: string | null
      head: string | null
      content_hash: string | null
      profile_id: string | null
      chunk_config_id: string | null
      indexed_at: string | Date | null
      file_count: number | null
      chunk_count: number | null
    }
    const matchesCurrent = (
      row: CurrentIndexRow | undefined,
    ): row is CurrentIndexRow & {
      current_snapshot: string
      indexed_at: string | Date
    } =>
      Boolean(
        row?.current_snapshot === identity.snapshotId &&
          row.root === root &&
          row.branch === identity.branch &&
          row.head === identity.head &&
          row.content_hash === treeHash &&
          row.profile_id === profileId &&
          row.chunk_config_id === chunkConfigId &&
          row.indexed_at,
      )
    const previous = await database.query<CurrentIndexRow>(
      `SELECT w.current_snapshot,w.root,w.branch,w.head,w.content_hash,w.profile_id,w.chunk_config_id,w.indexed_at,s.file_count,s.chunk_count
       FROM zorya_code_worktrees w LEFT JOIN zorya_code_snapshots s ON s.snapshot_id=w.current_snapshot
       WHERE w.worktree_id=$1`,
      [worktreeId],
    )
    const previousRow = previous.rows[0]
    if (matchesCurrent(previousRow)) {
      const verified = await enumerateCode(root, limits, signal, pathPolicy.excludes)
      const verifiedIdentity = await identifyRoot(root, verified.treeHash, signal)
      if (
        verified.treeHash !== treeHash ||
        sha(`${verifiedIdentity.snapshotId}\0${profileId ?? 'lexical'}\0${chunkConfigId}`) !==
          identity.snapshotId
      )
        throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_INDEX')
      const confirmed = await database.query<CurrentIndexRow>(
        `SELECT w.current_snapshot,w.root,w.branch,w.head,w.content_hash,w.profile_id,w.chunk_config_id,w.indexed_at,s.file_count,s.chunk_count
         FROM zorya_code_worktrees w LEFT JOIN zorya_code_snapshots s ON s.snapshot_id=w.current_snapshot
         WHERE w.worktree_id=$1`,
        [worktreeId],
      )
      checkAbort(signal)
      const confirmedRow = confirmed.rows[0]
      if (
        matchesCurrent(confirmedRow) &&
        confirmedRow.current_snapshot === previousRow.current_snapshot
      ) {
        if (!(await hasCurrentSymbolAnalysis(worktreeId, identity.snapshotId, signal!)))
          await prepareAndPublishCurrentSymbols(root, identity, files, treeHash, signal!)
        return statusFrom(
          identity,
          new Date(confirmedRow.indexed_at).toISOString(),
          confirmedRow.file_count ?? 0,
          confirmedRow.chunk_count ?? 0,
          profileId,
          null,
          profileId,
        )
      }
    }
    const generationResult = await database.query<{ generation: string | number }>(
      `INSERT INTO zorya_code_worktrees(worktree_id,repo_id,root,generation) VALUES($1,$2,$3,1)
      ON CONFLICT(worktree_id) DO UPDATE SET repo_id=EXCLUDED.repo_id,root=EXCLUDED.root,generation=zorya_code_worktrees.generation+1 RETURNING generation`,
      [worktreeId, identity.repoId, identity.root],
    )
    const generation = Number(generationResult.rows[0]?.generation)
    const resumeScopeId = sha(JSON.stringify([
      worktreeId,
      identity.repoId,
      identity.root,
      identity.branch,
      identity.head,
      treeHash,
      identity.snapshotId,
      profileId,
      chunkConfigId,
    ]))
    await database.transaction(async (tx) => {
      checkAbort(signal)
      const currentGeneration = await tx.query<{ generation: string | number }>(
        'SELECT generation FROM zorya_code_worktrees WHERE worktree_id=$1 FOR UPDATE',
        [worktreeId],
      )
      if (Number(currentGeneration.rows[0]?.generation) !== generation)
        throw new CodeIndexError('CODE_INDEX_STALE_GENERATION')
      const session = await tx.query<{ scope_id: string }>(
        'SELECT scope_id FROM zorya_code_resume_sessions WHERE worktree_id=$1 FOR UPDATE',
        [worktreeId],
      )
      if (session.rows[0]?.scope_id !== resumeScopeId) {
        await tx.query('DELETE FROM zorya_code_resume_sessions WHERE worktree_id=$1', [worktreeId])
      }
      await tx.query(
        `INSERT INTO zorya_code_resume_sessions(worktree_id,scope_id,generation) VALUES($1,$2,$3)
         ON CONFLICT(worktree_id) DO UPDATE SET scope_id=EXCLUDED.scope_id,generation=EXCLUDED.generation,updated_at=now()`,
        [worktreeId, resumeScopeId, generation],
      )
    }, signal)
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
    const resolveImport = createLocalImportResolver(root, known, contents, pathMappings, baseUrl)
    for (const file of files) {
      checkAbort(signal)
      const parsed = chunkCode(file, limits.maxChunkChars)
      chunks.push(...parsed.chunks.filter((chunk) => chunk.text.trim().length > 0))
      for (const specifier of parsed.imports) {
        const to = resolveImport(file.path, specifier)
        if (to) imports.push({ from: file.path, to, specifier })
      }
      if (chunks.length > limits.maxChunks) throw new CodeIndexError('CODE_INDEX_CHUNK_LIMIT')
    }
    let checkpointWrites = 0
    try {
      onProgress?.({
        snapshotId: identity.snapshotId,
        totalChunks: chunks.length,
        checkpointChunks: 0,
        checkpointWrites,
      })
    } catch {
      /* Observers cannot control indexing. */
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
    let stagedCheckpointCount = 0
    if (models) {
      const staged = await database.query<{ id: string; content_hash: string; vector_json: unknown }>(
        `SELECT id,content_hash,vector_json FROM zorya_code_resume_chunks
         WHERE worktree_id=$1 AND scope_id=$2`,
        [worktreeId, resumeScopeId],
      )
      const stagedVectors = new Map(staged.rows.map((row) => [row.id + ':' + row.content_hash, row.vector_json]))
      stagedCheckpointCount = stagedVectors.size
      try {
        onProgress?.({
          snapshotId: identity.snapshotId,
          totalChunks: chunks.length,
          checkpointChunks: stagedVectors.size,
          checkpointWrites,
        })
      } catch {
        /* Observers cannot control indexing. */
      }
      vectors = vectors.map((value, index) => value ?? (
        stagedVectors.has(`${chunks[index]!.id}:${chunks[index]!.contentHash}`)
          ? vector(stagedVectors.get(`${chunks[index]!.id}:${chunks[index]!.contentHash}`), profile!.dimensions)
          : null
      ))
    }
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
        const batch = indexes.map((index, offset) => ({
          index,
          value: vector(embedded[offset], profile!.dimensions),
        }))
        await database.transaction(async (tx) => {
          checkAbort(signal)
          const current = await tx.query<{ generation: string | number }>(
            'SELECT generation FROM zorya_code_worktrees WHERE worktree_id=$1 FOR UPDATE',
            [worktreeId],
          )
          const session = await tx.query<{ generation: string | number; scope_id: string }>(
            'SELECT generation,scope_id FROM zorya_code_resume_sessions WHERE worktree_id=$1 FOR UPDATE',
            [worktreeId],
          )
          if (Number(current.rows[0]?.generation) !== generation ||
              Number(session.rows[0]?.generation) !== generation ||
              session.rows[0]?.scope_id !== resumeScopeId)
            throw new CodeIndexError('CODE_INDEX_STALE_GENERATION')
          for (const item of batch) {
            const chunk = chunks[item.index]!
            await tx.query(
              `INSERT INTO zorya_code_resume_chunks(worktree_id,scope_id,id,content_hash,vector_json)
               VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(worktree_id,id) DO UPDATE SET
               scope_id=EXCLUDED.scope_id,content_hash=EXCLUDED.content_hash,vector_json=EXCLUDED.vector_json`,
              [worktreeId, resumeScopeId, chunk.id, chunk.contentHash, JSON.stringify(item.value)],
            )
            vectors[item.index] = item.value
          }
        }, signal)
        checkpointWrites += batch.length
        try {
          onProgress?.({
            snapshotId: identity.snapshotId,
            totalChunks: chunks.length,
            checkpointChunks: Math.min(chunks.length, stagedCheckpointCount + cursor + batch.length),
            checkpointWrites,
          })
        } catch { /* Progress observers do not control indexing. */ }
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
    const preparedSymbols = await prepareSymbolAnalysis(root, identity.snapshotId, files, signal!, symbolAnalysisLimits)
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
      await publishIndexedSymbolAnalysis(tx, worktreeId, identity.snapshotId,
        preparedSymbols.result, preparedSymbols.profile, signal)
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
      await tx.query('DELETE FROM zorya_code_resume_sessions WHERE worktree_id=$1 AND scope_id=$2 AND generation=$3', [worktreeId, resumeScopeId, generation])
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
        return await indexRepositoryInner({
          root: input.root,
          signal,
          ...(input.onProgress ? { onProgress: input.onProgress } : {}),
        })
      } finally {
        activeIndexJobs--
      }
    })

  const sourceFingerprint: CodeIndex['sourceFingerprint'] = (inputRoot, callerSignal) =>
    own(callerSignal, async (signal) => {
      await options.beforeSourceFingerprint?.(signal)
      checkAbort(signal)
      const root = await realpath(resolve(inputRoot))
      const { treeHash } = await enumerateCode(root, limits, signal, pathPolicy.excludes)
      const identity = await identifyRoot(root, treeHash, signal)
      return sha(`${identity.snapshotId}\0${profileId ?? 'lexical'}\0${chunkConfigId}`)
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

  const indexCodeSymbols: NonNullable<CodeIndex['indexCodeSymbols']> = (input) => {
    const captured = { root: input.root, signal: input.signal }
    return own(captured.signal, async (signal) => {
      const stored = await current(captured.root, signal)
      const { files, treeHash } = await enumerateCode(stored.identity.root, limits, signal, pathPolicy.excludes)
      if (treeHash !== stored.identity.contentHash)
        throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_INDEX')
      return prepareAndPublishCurrentSymbols(stored.identity.root, stored.identity, files, treeHash, signal)
    })
  }

  const symbolQueries = createSymbolQueries(database, async (root, signal) => {
    const value = await current(root, signal)
    const metadata = await getSymbolFence(value.identity.worktreeId, value.snapshot)
    return { identity: value.identity, snapshot: value.snapshot,
      metadataGeneration: metadata.generation, metadataProfile: metadata.profile }
  }, symbolAnalysisLimits)
  const captureFindCodeSymbolsInput = (input: Parameters<NonNullable<CodeIndex['findCodeSymbols']>>[0]) => ({
    ...input,
    ...(input.enclosing === undefined ? {} : { enclosing: { ...input.enclosing } }),
  })
  const findCodeSymbols: NonNullable<CodeIndex['findCodeSymbols']> = (input) => {
    const captured = captureFindCodeSymbolsInput(input)
    return own(captured.signal, (signal) => symbolQueries.findCodeSymbols({ ...captured, signal }))
  }
  const findCodeReferences: NonNullable<CodeIndex['findCodeReferences']> = (input) => {
    const captured = { ...input }
    return own(captured.signal, (signal) => symbolQueries.findCodeReferences({ ...captured, signal }))
  }
  const traceCodeCalls: NonNullable<CodeIndex['traceCodeCalls']> = (input) => {
    const captured = { ...input }
    return own(captured.signal, (signal) => symbolQueries.traceCodeCalls({ ...captured, signal }))
  }

  type ReadScope = {
    root: string
    snapshot: Awaited<ReturnType<typeof current>>
    signal: AbortSignal
    rows?: Stored[]
    rowsHaveVectors: boolean
    rowsLoading?: Promise<Stored[]>
    vectorRowsLoading?: Promise<Stored[]>
    lexicalCorpus?: PreparedLexicalCorpus<Stored>
    lexicalCorpusKey?: string
    lexicalCorpusBaseKey?: string
    active: Set<Promise<unknown>>
    controller: AbortController
    closing: boolean
    closed: boolean
  }
  const assertReadScope = (scope: ReadScope, root: string, signal: AbortSignal) => {
    checkAbort(signal)
    if (scope.closed || resolve(root) !== scope.root)
      throw new CodeIndexError('CODE_INDEX_STALE')
  }
  const canonicalScopeRoot = async (scope: ReadScope, root: string, signal: AbortSignal) => {
    checkAbort(signal)
    if (scope.closed) throw new CodeIndexError('CODE_INDEX_STALE')
    const canonical = await realpath(resolve(root))
    checkAbort(signal)
    if (canonical !== scope.root) throw new CodeIndexError('CODE_INDEX_STALE')
    return canonical
  }
  const readRows = async (
    scope: ReadScope,
    withVectors: boolean,
    signal: AbortSignal,
  ): Promise<Stored[]> => {
    assertReadScope(scope, scope.root, signal)
    if (!scope.rowsLoading && !scope.rows) {
      scope.rowsLoading = database.query<Stored>(
        `SELECT c.id,c.path,c.line_start AS "lineStart",c.line_end AS "lineEnd",c.symbol,c.language,c.body AS text,c.content_hash AS "contentHash",c.parser_version AS "parserVersion"${withVectors ? ',c.vector_json' : ''} FROM zorya_code_chunks c WHERE c.snapshot_id=$1 ORDER BY c.path,c.line_start LIMIT $2`,
        [scope.snapshot.snapshot, limits.maxScanChunks + 1],
      ).then((result) => {
        const rows = result.rows
        if (rows.length > limits.maxScanChunks)
          throw new CodeIndexError('CODE_INDEX_QUERY_SCAN_LIMIT')
        scope.rows = rows
        scope.rowsHaveVectors = withVectors
        return rows
      })
    }
    if (!scope.rows) await scope.rowsLoading
    if (!scope.rows)
      throw new CodeIndexError('CODE_INDEX_QUERY_SCAN_LIMIT')
    if (withVectors && !scope.rowsHaveVectors) {
      if (!scope.vectorRowsLoading) {
        scope.vectorRowsLoading = database.query<Stored>(
          `SELECT c.id,c.path,c.line_start AS "lineStart",c.line_end AS "lineEnd",c.symbol,c.language,c.body AS text,c.content_hash AS "contentHash",c.parser_version AS "parserVersion",c.vector_json FROM zorya_code_chunks c WHERE c.snapshot_id=$1 ORDER BY c.path,c.line_start LIMIT $2`,
          [scope.snapshot.snapshot, limits.maxScanChunks + 1],
        ).then((result) => {
          if (result.rows.length > limits.maxScanChunks)
            throw new CodeIndexError('CODE_INDEX_QUERY_SCAN_LIMIT')
          scope.rows = result.rows
          scope.rowsHaveVectors = true
          return result.rows
        })
      }
      await scope.vectorRowsLoading
    }
    assertReadScope(scope, scope.root, signal)
    return scope.rows
  }

  const searchCodeInner: (
    input: Parameters<CodeIndex['searchCode']>[0],
    scope?: ReadScope,
  ) => ReturnType<CodeIndex['searchCode']> = async (input, scope) => {
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
    if (scope) assertReadScope(scope, input.root, input.signal!)
    const snapshot = scope?.snapshot ?? (await current(input.root, input.signal))
    const cap = input.limit ?? 10
    if (!Number.isInteger(cap) || cap < 1 || cap > limits.maxResults)
      throw new CodeIndexError('CODE_INDEX_RESULT_LIMIT')
    const mode = input.mode ?? (models ? 'hybrid' : 'lexical')
    const needsVectors = mode === 'hybrid' && Boolean(models && profile && snapshot.profileId === profileId)
    const corpus = scope
      ? await readRows(scope, needsVectors, input.signal ?? scope.signal)
      : (
          await database.query<Stored>(
            `SELECT c.id,c.path,c.line_start AS "lineStart",c.line_end AS "lineEnd",c.symbol,c.language,c.body AS text,c.content_hash AS "contentHash",c.parser_version AS "parserVersion"${needsVectors ? ',c.vector_json' : ''} FROM zorya_code_chunks c WHERE c.snapshot_id=$1 ORDER BY c.path,c.line_start LIMIT $2`,
            [snapshot.snapshot, limits.maxScanChunks + 1],
          )
        ).rows
    if (!scope && corpus.length > limits.maxScanChunks)
      throw new CodeIndexError('CODE_INDEX_QUERY_SCAN_LIMIT')
    const languageFilter = normalizeCodeLanguage(input.language)
    const sourceKind = normalizeSourceKind(input.sourceKind)
    const matchesFilter = (row: Stored) =>
      codeLanguageMatches(row.language, languageFilter) &&
      codeSourceKindMatches(row.path, sourceKind) &&
      (!input.paths?.length ||
        input.paths.some(
          (path) =>
            row.path === path || row.path.startsWith(path.endsWith('/') ? path : `${path}/`),
        ))
    const filtered = corpus.filter(matchesFilter)
    let lexical: ReturnType<typeof rankLexical<Stored>>
    if (scope) {
      const filterKey = codeFilterCacheKey(input)
      const baseFilterKey = codeFilterCacheKey({ ...input, paths: [] })
      const exactPreparedFilter = scope.lexicalCorpusKey === filterKey
      const preparedBaseCoversQuery = scope.lexicalCorpusBaseKey === baseFilterKey
      if (!exactPreparedFilter && !preparedBaseCoversQuery) {
        scope.lexicalCorpus = prepareLexical(filtered)
        scope.lexicalCorpusKey = filterKey
        if (input.paths?.length) delete scope.lexicalCorpusBaseKey
        else scope.lexicalCorpusBaseKey = baseFilterKey
      }
      lexical = rankPreparedLexical(
        scope.lexicalCorpus!,
        input.query,
        exactPreparedFilter ? undefined : matchesFilter,
      )
    } else lexical = rankLexical(filtered, input.query)
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
    const exactQuery = exactDeclarationQuery(input.query)
    const rankedById = exactQuery ? new Map(ranked.map((item) => [item.row.id, item])) : undefined
    const exactRows = exactQuery
      ? filtered.filter((row) => isExactDeclarationSymbol(row.symbol, exactQuery))
      : []
    const exactRowsByPath = new Map<string, Stored[]>()
    for (const row of exactRows) {
      const pathRows = exactRowsByPath.get(row.path) ?? []
      pathRows.push(row)
      exactRowsByPath.set(row.path, pathRows)
    }
    const exactDeclarations: typeof ranked = []
    if (exactQuery) {
      const candidatePaths = [...exactRowsByPath.keys()].sort((left, right) =>
        left.localeCompare(right),
      )
      for (const path of candidatePaths) {
        checkAbort(input.signal)
        const currentFile = await readScopedFile(
          snapshot.identity.root,
          path,
          limits.maxFileBytes,
          input.signal,
          pathPolicy.excludes,
        )
        const storedFile = await database.query<{ content_hash: string }>(
          'SELECT content_hash FROM zorya_code_files WHERE snapshot_id=$1 AND path=$2',
          [snapshot.snapshot, path],
        )
        checkAbort(input.signal)
        if (!storedFile.rows[0] || storedFile.rows[0].content_hash !== currentFile.hash)
          throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED')
        const declarations = findTopLevelDeclarationChunks(
          path,
          currentFile.text,
          exactQuery,
          limits.maxChunkChars,
        )
        checkAbort(input.signal)
        for (const declaration of declarations) {
          checkAbort(input.signal)
          const row = exactRowsByPath
            .get(path)
            ?.find((candidate) => candidate.id === declaration.chunkId)
          if (!row || !isExactDeclarationSymbol(row.symbol, exactQuery)) continue
          exactDeclarations.push(
            rankedById?.get(row.id) ?? {
              row,
              lexicalRank: null,
              denseRank: null,
              score: 0,
            },
          )
          if (exactDeclarations.length >= cap) break
        }
        if (exactDeclarations.length >= cap) break
      }
    }
    let result = ranked.slice(0, mode === 'hybrid' && models?.rerank ? (rerankCandidateLimit || cap) : cap)
    let rerankRanks = new Map<string, number>()
    if (mode === 'hybrid' && models?.rerank && profile && !degradedReason && result.length) {
      const reranked = await models.rerank({
        query: input.query,
        documents: result.map((item) => item.row.text),
        ...(rerankCandidateLimit > 0 ? { topN: Math.min(cap, rerankCandidateLimit) } : {}),
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
    if (exactDeclarations.length) {
      const exactIds = new Set(exactDeclarations.map((item) => item.row.id))
      result = [...exactDeclarations, ...result.filter((item) => !exactIds.has(item.row.id))]
    }
    result = result.slice(0, cap)
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
    if (scope) assertReadScope(scope, input.root, input.signal!)
    else {
      const after = await current(input.root, input.signal)
      if (after.snapshot !== snapshot.snapshot)
        throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_SEARCH')
    }
    return {
      hits,
      identity: structuredClone(snapshot.identity),
      degraded: Boolean(degradedReason),
      degradedReason: degradedReason ?? null,
    }
  }
  const searchCode: CodeIndex['searchCode'] = (input) =>
    own(input.signal, (signal) => searchCodeInner({ ...input, signal }))

  const findCodeDuplicatesInner: (
    input: Parameters<NonNullable<CodeIndex['findCodeDuplicates']>>[0],
    scope?: ReadScope,
  ) => ReturnType<NonNullable<CodeIndex['findCodeDuplicates']>> = async (input, scope) => {
      const signal = input.signal ?? scope?.signal
      if (!signal) throw new CodeIndexError('CODE_INDEX_STALE')
      checkAbort(signal)
      if (scope) assertReadScope(scope, input.root, signal)
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
      normalizeSourceKind(input.sourceKind)
      const minTokens = input.minTokens ?? 12
      const minOccurrences = input.minOccurrences ?? 2
      const limit = input.limit ?? 20
      const maxOccurrencesPerGroup = input.maxOccurrencesPerGroup ?? 10
      if (
        !Number.isInteger(minTokens) ||
        minTokens < 12 ||
        minTokens > 5000 ||
        !Number.isInteger(minOccurrences) ||
        minOccurrences < 2 ||
        minOccurrences > 50 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(maxOccurrencesPerGroup) ||
        maxOccurrencesPerGroup < 2 ||
        maxOccurrencesPerGroup > 50 ||
        (input.matchMode !== undefined && !['exact', 'renamed'].includes(input.matchMode))
      )
        throw new CodeIndexError('CODE_INDEX_LIMIT_INVALID')
      const snapshot = scope?.snapshot ?? (await current(input.root, signal))
      const rows = await database.query<{
        path: string
        content_hash: string
        bytes: number
      }>(
        'SELECT path,content_hash,bytes FROM zorya_code_files WHERE snapshot_id=$1 ORDER BY path LIMIT $2',
        [snapshot.snapshot, limits.maxFiles + 1],
      )
      if (rows.rows.length > limits.maxFiles) throw new CodeIndexError('CODE_INDEX_QUERY_SCAN_LIMIT')
      const languageFilter = normalizeCodeLanguage(input.language)
      const selected = rows.rows.filter(
        (row) =>
          codeSourceKindMatches(row.path, input.sourceKind ?? 'implementation') &&
          codeLanguageMatches(row.path.split('.').at(-1)?.toLowerCase() ?? '', languageFilter) &&
          (!input.paths?.length ||
            input.paths.some(
              (path) =>
                row.path === path || row.path.startsWith(path.endsWith('/') ? path : `${path}/`),
            )),
      )
      let totalBytes = 0
      let skippedOversize = 0
      const sources: Array<{ path: string; text: string; hash: string }> = []
      for (const row of selected) {
        checkAbort(signal)
        if (row.bytes > limits.maxFileBytes || totalBytes + row.bytes > limits.maxTotalBytes) {
          skippedOversize++
          continue
        }
        const file = await readScopedFile(
          snapshot.identity.root,
          row.path,
          limits.maxFileBytes,
          signal,
          pathPolicy.excludes,
        )
        if (file.hash !== row.content_hash) throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED')
        totalBytes += file.bytes
        sources.push({ path: row.path, text: file.text, hash: file.hash })
        if (sources.length % 32 === 0)
          await new Promise<void>((resolve) => setImmediate(resolve))
      }
      const result = await findDuplicateBodies(
        sources,
        {
          matchMode: input.matchMode ?? 'renamed',
          minTokens,
          minOccurrences,
          limit,
          maxOccurrencesPerGroup,
        },
        signal,
      )
      checkAbort(signal)
      if (scope) assertReadScope(scope, input.root, signal)
      else {
        const after = await current(input.root, signal)
        if (after.snapshot !== snapshot.snapshot) throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_SEARCH')
      }
      const groupsTruncated = result.eligibleGroupCount > result.groups.length
      const occurrencesTruncated = result.occurrenceTruncated
      const scanTruncated = skippedOversize > 0 || result.skippedParse > 0 || result.skippedUnsupported > 0
      return {
        identity: structuredClone(snapshot.identity),
        supportedLanguages: ['JavaScript', 'TypeScript'],
        groups: result.groups,
        counts: {
          scannedFiles: rows.rows.length,
          indexedFiles: rows.rows.length,
          eligibleFiles: selected.length,
          parsedFiles: result.parsed,
          functions: result.functions,
          skippedParse: result.skippedParse,
          skippedOversize,
          skippedUnsupported: result.skippedUnsupported,
        },
        truncation: {
          groups: groupsTruncated,
          occurrences: occurrencesTruncated,
          scan: scanTruncated,
          complete: !groupsTruncated && !occurrencesTruncated && !scanTruncated,
        },
      }
  }
  const findCodeDuplicates: NonNullable<CodeIndex['findCodeDuplicates']> = (input) =>
    own(input.signal, (signal) => findCodeDuplicatesInner({ ...input, signal }))

  const readSourceInner: (
    input: Parameters<CodeIndex['readSource']>[0],
    scope?: ReadScope,
  ) => ReturnType<CodeIndex['readSource']> = async (input, scope) => {
    checkAbort(input.signal)
    if (scope) assertReadScope(scope, input.root, input.signal!)
    const before = scope?.snapshot ?? (await current(input.root, input.signal))
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
    if (scope) assertReadScope(scope, input.root, input.signal!)
    else {
      const after = await current(input.root, input.signal)
      if (after.snapshot !== before.snapshot)
        throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_READ')
    }
    return {
      path: input.path.replaceAll('\\', '/'),
      lineStart: start,
      lineEnd: Math.min(end, lines.length),
      fileLineCount: lines.length,
      text,
      contentHash: currentFile.hash,
      snapshotId: before.snapshot,
      stale: false,
    }
  }
  const readSource: CodeIndex['readSource'] = (input) =>
    own(input.signal, (signal) => readSourceInner({ ...input, signal }))

  const relatedCodeInner: (
    input: Parameters<CodeIndex['relatedCode']>[0],
    scope?: ReadScope,
  ) => ReturnType<CodeIndex['relatedCode']> = async (input, scope) => {
    if (scope) assertReadScope(scope, input.root, input.signal ?? scope.signal)
    const snapshot = scope?.snapshot ?? (await current(input.root, input.signal))
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
    const found = await searchCodeInner({
      root: input.root,
      query,
      limit: input.limit ?? 8,
      mode: 'lexical',
      ...(input.signal ? { signal: input.signal } : {}),
      paths: [],
    }, scope)
    if (found.identity.snapshotId !== snapshot.snapshot)
      throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_SEARCH')
    if (scope) assertReadScope(scope, input.root, input.signal ?? scope.signal)
    else {
      const after = await current(input.root, input.signal)
      if (after.snapshot !== snapshot.snapshot)
        throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_SEARCH')
    }
    const similar = found.hits.filter((hit) => hit.path !== canonicalPath)
    return {
      identity: structuredClone(snapshot.identity),
      imports: imports.rows.map((row) => row.to_path),
      importedBy: importedBy.rows.map((row) => row.from_path),
      similar,
      stale: false,
    }
  }
  const relatedCode: CodeIndex['relatedCode'] = (input) =>
    own(input.signal, (signal) => relatedCodeInner({ ...input, signal }))

  const dependencyGraphInner = async (
    input: CodeDependencyGraphInput,
    scope?: ReadScope,
  ): Promise<CodeDependencyGraph> => {
    if (typeof input.root !== 'string' || !input.root || input.root.length > 4096)
      throw new CodeIndexError('CODE_INDEX_PATH_FILTER_INVALID')
    checkAbort(input.signal)
    if (scope) assertReadScope(scope, input.root, input.signal ?? scope.signal)
    const snapshot = scope?.snapshot ?? (await current(input.root, input.signal))
    const maxDepth = input.maxDepth ?? 2
    const maxNodes = input.maxNodes ?? 24
    const maxEdges = input.maxEdges ?? 128
    if (!Array.isArray(input.seeds) || input.seeds.length < 1 || input.seeds.length > 16 ||
        !Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 4 ||
        !Number.isInteger(maxNodes) || maxNodes < input.seeds.length || maxNodes > 64 ||
        !Number.isInteger(maxEdges) || maxEdges < 1 || maxEdges > 512)
      throw new CodeIndexError('CODE_INDEX_LIMIT_INVALID')
    const seeds = [...new Set(input.seeds.map((path) => {
      if (typeof path !== 'string' || !path || path.length > 1024 || path.startsWith('/') || path.split(/[\\/]/u).includes('..'))
        throw new CodeIndexError('CODE_INDEX_PATH_FILTER_INVALID')
      const normalized = posix.normalize(path.replaceAll('\\', '/'))
      if (normalized === '.' || normalized.startsWith('../') || pathPolicy.excludes(normalized))
        throw new CodeIndexError('CODE_INDEX_SOURCE_UNAVAILABLE')
      return normalized
    }))].sort()
    if (seeds.length > maxNodes) throw new CodeIndexError('CODE_INDEX_LIMIT_INVALID')
    const seedRows = await database.query<{ path: string }>(
      'SELECT path FROM zorya_code_files WHERE snapshot_id=$1 AND path=ANY($2::text[]) ORDER BY path',
      [snapshot.snapshot, seeds],
    )
    if (seedRows.rows.length !== seeds.length) throw new CodeIndexError('CODE_INDEX_SOURCE_UNAVAILABLE')
    const graph = await walkDependencyGraph({
      identity: snapshot.identity,
      seeds,
      maxDepth,
      maxNodes,
      maxEdges,
      signal: input.signal!,
      excluded: pathPolicy.excludes,
      readEdges: async (frontier, limit, signal) => {
        checkAbort(signal)
        const result = await database.query<{ from_path: string; to_path: string }>(
          `SELECT from_path,to_path FROM (
             SELECT DISTINCT from_path,to_path FROM zorya_code_imports
             WHERE snapshot_id=$1 AND (from_path=ANY($2::text[]) OR to_path=ANY($2::text[]))
           ) AS unique_edges
           ORDER BY CASE WHEN from_path=ANY($2::text[]) THEN 0 ELSE 1 END,from_path,to_path
           LIMIT $3`,
          [snapshot.snapshot, frontier, limit],
        )
        return result.rows.map((row) => ({ from: row.from_path, to: row.to_path }))
      },
    })
    if (scope) assertReadScope(scope, input.root, input.signal ?? scope.signal)
    else {
      const after = await current(input.root, input.signal)
      if (after.snapshot !== snapshot.snapshot) throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_SEARCH')
    }
    return graph
  }
  const dependencyGraph: NonNullable<CodeIndex['dependencyGraph']> = (input) => {
    const captured = { ...input, seeds: Array.isArray(input.seeds) ? [...input.seeds] : input.seeds }
    return own(captured.signal, (signal) => dependencyGraphInner({ ...captured, signal }))
  }

  const withReadSnapshot: NonNullable<CodeIndex['withReadSnapshot']> = (
    inputRoot,
    callerSignal,
    work,
  ) =>
    own(callerSignal, async (signal) => {
      const snapshot = await current(inputRoot, signal)
      const symbolFence = await getSymbolFence(snapshot.identity.worktreeId, snapshot.snapshot)
      const controller = new AbortController()
      const scopeSignal = AbortSignal.any([signal, controller.signal])
      const scope: ReadScope = {
        root: snapshot.identity.root,
        snapshot,
        signal: scopeSignal,
        rowsHaveVectors: false,
        active: new Set(),
        controller,
        closing: false,
        closed: false,
      }
      const scopedSymbolQueries = createSymbolQueries(database, async (root, operationSignal) => {
        const signalForRead = operationSignal ?? scope.signal
        assertReadScope(scope, root, signalForRead)
        const result = await database.query<{
          current_snapshot: string | null
          root: string
          branch: string | null
          head: string | null
          content_hash: string | null
          profile_id: string | null
          chunk_config_id: string | null
          generation: string | number | null
          current_profile_id: string | null
        }>(
          `SELECT w.current_snapshot,w.root,w.branch,w.head,w.content_hash,w.profile_id,w.chunk_config_id,
                  s.generation,s.current_profile_id
           FROM zorya_code_worktrees w
           LEFT JOIN zorya_code_analysis_state s
             ON s.worktree_id=w.worktree_id AND s.snapshot_id=w.current_snapshot
           WHERE w.worktree_id=$1`,
          [scope.snapshot.identity.worktreeId],
        )
        checkAbort(signalForRead)
        assertReadScope(scope, root, signalForRead)
        const row = result.rows[0]
        if (!row || row.current_snapshot !== scope.snapshot.snapshot || row.root !== scope.root ||
          row.branch !== scope.snapshot.identity.branch || row.head !== scope.snapshot.identity.head ||
          row.content_hash !== scope.snapshot.identity.contentHash || row.profile_id !== scope.snapshot.profileId ||
          row.chunk_config_id !== chunkConfigId ||
          (row.generation === null ? null : Number(row.generation)) !== symbolFence.generation ||
          row.current_profile_id !== symbolFence.profile)
          throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_SEARCH')
        return {
          identity: structuredClone(scope.snapshot.identity),
          snapshot: scope.snapshot.snapshot,
          metadataGeneration: symbolFence.generation,
          metadataProfile: symbolFence.profile,
        }
      }, symbolAnalysisLimits)
      const invoke = <T>(
        callerOperationSignal: AbortSignal | undefined,
        operation: (ownedSignal: AbortSignal, canonicalRoot: string) => Promise<T>,
        root: string,
      ): Promise<T> => {
        if (scope.closed || scope.closing) return Promise.reject(new CodeIndexError('CODE_INDEX_STALE'))
        const parentSignal = callerOperationSignal
          ? AbortSignal.any([scopeSignal, callerOperationSignal])
          : scopeSignal
        let pending: Promise<T>
        try {
          pending = own(parentSignal, async (ownedSignal) => {
            const canonicalRoot = await canonicalScopeRoot(scope, root, ownedSignal)
            return operation(ownedSignal, canonicalRoot)
          })
        } catch (error) {
          return Promise.reject(error)
        }
        scope.active.add(pending)
        void pending.finally(() => scope.active.delete(pending)).catch(() => {})
        return pending
      }
      const scoped = Object.freeze({
        indexStatus: (root: string, operationSignal?: AbortSignal) =>
          invoke(operationSignal, async () =>
            structuredClone(
              statusFrom(
                scope.snapshot.identity,
                scope.snapshot.indexedAt,
                scope.snapshot.fileCount,
                scope.snapshot.chunkCount,
                scope.snapshot.profileId,
                denseReason(scope.snapshot.profileId, true, profileId),
                profileId,
              ),
            ), root),
        searchCode: (input: Parameters<CodeIndex['searchCode']>[0]) =>
          invoke(input.signal, (ownedSignal, canonicalRoot) =>
            searchCodeInner({ ...input, root: canonicalRoot, signal: ownedSignal }, scope), input.root),
        readSource: (input: Parameters<CodeIndex['readSource']>[0]) =>
          invoke(input.signal, (ownedSignal, canonicalRoot) =>
            readSourceInner({ ...input, root: canonicalRoot, signal: ownedSignal }, scope), input.root),
        relatedCode: (input: Parameters<CodeIndex['relatedCode']>[0]) =>
          invoke(input.signal, (ownedSignal, canonicalRoot) =>
            relatedCodeInner({ ...input, root: canonicalRoot, signal: ownedSignal }, scope), input.root),
        findCodeDuplicates: (input: Parameters<NonNullable<CodeIndex['findCodeDuplicates']>>[0]) => {
          const captured = { ...input, ...(input.paths ? { paths: [...input.paths] } : {}) }
          return invoke(captured.signal, (ownedSignal, canonicalRoot) =>
            findCodeDuplicatesInner({ ...captured, root: canonicalRoot, signal: ownedSignal }, scope), captured.root)
        },
        dependencyGraph: (input: CodeDependencyGraphInput) => {
          const captured = { ...input, seeds: Array.isArray(input.seeds) ? [...input.seeds] : input.seeds }
          return invoke(captured.signal, (ownedSignal, canonicalRoot) =>
            dependencyGraphInner({ ...captured, root: canonicalRoot, signal: ownedSignal }, scope), captured.root)
        },
        findCodeSymbols: (input: Parameters<NonNullable<CodeIndex['findCodeSymbols']>>[0]) => {
          const captured = captureFindCodeSymbolsInput(input)
          return invoke(captured.signal, (ownedSignal, canonicalRoot) =>
            scopedSymbolQueries.findCodeSymbols({ ...captured, root: canonicalRoot, signal: ownedSignal }), captured.root)
        },
        findCodeReferences: (input: Parameters<NonNullable<CodeIndex['findCodeReferences']>>[0]) => {
          const captured = { ...input }
          return invoke(captured.signal, (ownedSignal, canonicalRoot) =>
            scopedSymbolQueries.findCodeReferences({ ...captured, root: canonicalRoot, signal: ownedSignal }), captured.root)
        },
        traceCodeCalls: (input: Parameters<NonNullable<CodeIndex['traceCodeCalls']>>[0]) => {
          const captured = { ...input }
          return invoke(captured.signal, (ownedSignal, canonicalRoot) =>
            scopedSymbolQueries.traceCodeCalls({ ...captured, root: canonicalRoot, signal: ownedSignal }), captured.root)
        },
      })
      try {
        const result = await work(scoped)
        scope.closing = true
        await Promise.allSettled([...scope.active])
        checkAbort(scopeSignal)
        const canonicalRoot = await realpath(resolve(inputRoot))
        if (canonicalRoot !== scope.root)
          throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_SEARCH')
        const after = await current(scope.root, scopeSignal)
        const afterSymbolFence = await getSymbolFence(after.identity.worktreeId, after.snapshot)
        if (
          after.identity.root !== snapshot.identity.root ||
          after.snapshot !== snapshot.snapshot ||
          afterSymbolFence.generation !== symbolFence.generation ||
          afterSymbolFence.profile !== symbolFence.profile
        )
          throw new CodeIndexError('CODE_INDEX_SOURCE_CHANGED_DURING_SEARCH')
        return result
      } catch (error) {
        scope.closing = true
        controller.abort(error)
        await Promise.allSettled([...scope.active])
        throw error
      } finally {
        scope.closing = true
        await Promise.allSettled([...scope.active])
        scope.closed = true
        delete scope.rows
        delete scope.rowsLoading
        delete scope.vectorRowsLoading
        delete scope.lexicalCorpus
        delete scope.lexicalCorpusKey
        delete scope.lexicalCorpusBaseKey
      }
    })

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
    sourceFingerprint,
    searchCode,
    findCodeDuplicates,
    indexStatus,
    readSource,
    relatedCode,
    dependencyGraph,
    indexCodeSymbols,
    findCodeSymbols,
    findCodeReferences,
    traceCodeCalls,
    withReadSnapshot,
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
