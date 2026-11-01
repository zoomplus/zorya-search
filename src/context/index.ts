import type { CodeHit, CodeIndex, CodeSourceIdentity } from '../code/types.js'
import { createLifecycle } from './lifecycle.js'

export interface CodeContextLimits {
  maxQueryChars: number
  maxFeatureQueries: number
  maxMandatory: number
  maxLimit: number
  maxChars: number
  maxConcurrency: number
  timeoutMs: number
  maxRangeLines: number
}

const defaults: CodeContextLimits = {
  maxQueryChars: 2000,
  maxFeatureQueries: 8,
  maxMandatory: 16,
  maxLimit: 40,
  maxChars: 24000,
  maxConcurrency: 4,
  timeoutMs: 15000,
  maxRangeLines: 200,
}

export interface RequiredCodeRange {
  path: string
  lineStart?: number
  lineEnd?: number
}

export interface CodeContextRequest {
  root: string
  query: string
  featureQueries?: string[]
  mustInclude?: RequiredCodeRange[]
  includeRelated?: boolean
  maxChars?: number
  limit?: number
  signal?: AbortSignal
}
export interface RelatedCodeRequest {
  root: string
  path: string
  symbol?: string
  limit?: number
  signal?: AbortSignal
}

export interface CodeContextRankOrigin {
  source: 'query' | 'related'
  queryIndex: number | null
  rank: number
  mode: 'lexical' | 'hybrid'
  lexicalRank: number | null
  denseRank: number | null
  rerankRank: number | null
  score: number
  profileId: string | null
}

export interface CodeContextSection {
  path: string
  lineStart: number
  lineEnd: number
  text: string
  fileContentHash: string
  candidateChunkHash: string | null
  profileId: string | null
  truncated: boolean
  fusionScore: number
  reason: 'mandatory' | 'search' | 'related'
  rankOrigins: CodeContextRankOrigin[]
}

export interface CodeContextResult {
  identity: CodeSourceIdentity
  profileId: string | null
  sections: CodeContextSection[]
  budget: { usedChars: number; maxChars: number }
  omitted: Array<{ path: string; reason: 'budget' | 'range-too-large' }>
  degraded: boolean
  degradedReasons: string[]
}

export class CodeContextError extends Error {
  constructor(
    readonly code: 'STALE_SNAPSHOT' | 'MANDATORY_BUDGET' | 'CLOSED' | 'LIMIT' | 'TIMEOUT',
  ) {
    super(`Code context operation failed: ${code}`)
    this.name = 'CodeContextError'
  }
}

export function createCodeContext(options: {
  index: CodeIndex
  limits?: Partial<CodeContextLimits>
}) {
  const limits = Object.freeze({ ...defaults, ...options.limits })
  validateLimits(limits)
  const source = options.index
  const index = Object.freeze({
    indexStatus: source.indexStatus.bind(source),
    searchCode: source.searchCode.bind(source),
    readSource: source.readSource.bind(source),
    relatedCode: source.relatedCode.bind(source),
    ...(source.withReadSnapshot ? { withReadSnapshot: source.withReadSnapshot.bind(source) } : {}),
  })
  const lifecycle = createLifecycle(limits.maxConcurrency)

  return {
    getCodeContext(input: CodeContextRequest): Promise<CodeContextResult> {
      const request = freezeRequest(input)
      validateRequest(request, limits)
      return lifecycle.run(request.signal, limits.timeoutMs, async (signal) => {
        const run = async (
          operationIndex: Pick<CodeIndex, 'indexStatus' | 'searchCode' | 'readSource' | 'relatedCode'>,
        ) => {
          signal.throwIfAborted()
          const status = structuredClone(await operationIndex.indexStatus(request.root, signal))
          if (!status.identity) throw new CodeContextError('STALE_SNAPSHOT')
          const identity = status.identity
          const profileId = status.profileId
          const snapshotId = identity.snapshotId
          const queries = [request.query, ...(request.featureQueries ?? [])]
          const lists: Awaited<ReturnType<typeof index.searchCode>>[] = []
          for (const query of queries) {
            signal.throwIfAborted()
            const list = structuredClone(
              await operationIndex.searchCode({
                root: request.root,
                query,
                limit: request.limit ?? Math.min(12, limits.maxLimit),
                mode: 'hybrid',
                signal,
              }),
            )
            assertIdentity(identity, [list.identity])
            lists.push(list)
          }
          signal.throwIfAborted()

          const ranked = new Map<
            string,
            {
              hit: CodeHit
              origins: Array<{
                source: 'query' | 'related'
                queryIndex: number | null
                rank: number
                mode: 'lexical' | 'hybrid'
                lexicalRank: number | null
                denseRank: number | null
                rerankRank: number | null
                score: number
                profileId: string | null
              }>
              score: number
            }
          >()
          lists.forEach((list, queryIndex) =>
            list.hits.forEach((hit, rank) => {
              const key = `${hit.path}:${hit.lineStart}:${hit.lineEnd}`
              const prior = ranked.get(key) ?? { hit, origins: [], score: 0 }
              prior.origins.push({
                source: 'query',
                queryIndex,
                rank: rank + 1,
                mode: hit.ranking.mode,
                lexicalRank: hit.ranking.lexicalRank,
                denseRank: hit.ranking.denseRank,
                rerankRank: hit.ranking.rerankRank,
                score: hit.score,
                profileId: hit.profileId,
              })
              prior.score += 1 / (60 + rank + 1)
              ranked.set(key, prior)
            }),
          )
          const hits = [...ranked.values()].sort(
            (a, b) =>
              b.score - a.score ||
              a.hit.path.localeCompare(b.hit.path) ||
              a.hit.lineStart - b.hit.lineStart,
          )
          const mandatory = request.mustInclude ?? []
          const maxChars = request.maxChars ?? limits.maxChars
          const sections: CodeContextSection[] = []
          const omitted: CodeContextResult['omitted'] = []
          let usedChars = 0
          const read = async (
            path: string,
            lineStart: number | undefined,
            lineEnd: number | undefined,
            reason: CodeContextSection['reason'],
            origins: CodeContextSection['rankOrigins'],
            chunkHash: string | null,
          ): Promise<void> => {
            signal.throwIfAborted()
            if (
              reason === 'mandatory' &&
              lineEnd !== undefined &&
              lineEnd - (lineStart ?? 1) + 1 > limits.maxRangeLines
            )
              throw new CodeContextError('LIMIT')
            const covered =
              lineStart !== undefined && lineEnd !== undefined
                ? sections.find(
                    (section) =>
                      section.path === path &&
                      section.lineStart <= lineStart &&
                      section.lineEnd >= lineEnd,
                  )
                : undefined
            if (covered) {
              if (reason === 'mandatory') covered.reason = 'mandatory'
              if (!covered.candidateChunkHash) covered.candidateChunkHash = chunkHash
              covered.rankOrigins.push(
                ...origins.filter(
                  (origin) =>
                    !covered.rankOrigins.some(
                      (prior) =>
                        prior.source === origin.source &&
                        prior.queryIndex === origin.queryIndex &&
                        prior.rank === origin.rank,
                    ),
                ),
              )
              covered.fusionScore = covered.rankOrigins.reduce(
                (sum, origin) => sum + 1 / (60 + origin.rank),
                0,
              )
              return
            }
            const boundedLineEnd =
              lineStart !== undefined &&
              lineEnd !== undefined &&
              lineEnd - lineStart + 1 > limits.maxRangeLines
                ? lineStart + limits.maxRangeLines - 1
                : lineEnd
            let truncated = boundedLineEnd !== lineEnd
            let result = structuredClone(
              await operationIndex.readSource({
                root: request.root,
                path,
                ...(lineStart === undefined ? {} : { lineStart }),
                ...(boundedLineEnd === undefined ? {} : { lineEnd: boundedLineEnd }),
                snapshotId,
                signal,
              }),
            )
            signal.throwIfAborted()
            if (result.stale || result.snapshotId !== snapshotId)
              throw new CodeContextError('STALE_SNAPSHOT')
            if (result.lineEnd - result.lineStart + 1 > limits.maxRangeLines) {
              if (reason === 'mandatory' && lineEnd !== undefined) throw new CodeContextError('LIMIT')
              const boundedEnd = result.lineStart + limits.maxRangeLines - 1
              result = structuredClone(
                await operationIndex.readSource({
                  root: request.root,
                  path,
                  lineStart: result.lineStart,
                  lineEnd: boundedEnd,
                  snapshotId,
                  signal,
                }),
              )
              signal.throwIfAborted()
              if (result.stale || result.snapshotId !== snapshotId)
                throw new CodeContextError('STALE_SNAPSHOT')
              truncated = true
            }
            const connected: CodeContextSection[] = []
            let start = result.lineStart
            let end = result.lineEnd
            let expanded = true
            while (expanded) {
              expanded = false
              for (const section of sections) {
                if (
                  section.path === result.path &&
                  !connected.includes(section) &&
                  start <= section.lineEnd + 1 &&
                  end >= section.lineStart - 1
                ) {
                  connected.push(section)
                  start = Math.min(start, section.lineStart)
                  end = Math.max(end, section.lineEnd)
                  expanded = true
                }
              }
            }
            if (connected.length) {
              const previous = connected[0]!
              if (end - start + 1 > limits.maxRangeLines) {
                if (reason === 'mandatory') {
                  const sourceLines = result.text.split('\n')
                  const coveredLines = new Set<number>()
                  for (const section of connected)
                    for (let line = section.lineStart; line <= section.lineEnd; line++)
                      coveredLines.add(line)
                  const additions: CodeContextSection[] = []
                  for (let line = result.lineStart; line <= result.lineEnd; ) {
                    if (coveredLines.has(line)) {
                      line++
                      continue
                    }
                    const rangeStart = line
                    while (line <= result.lineEnd && !coveredLines.has(line)) line++
                    const rangeEnd = line - 1
                    const text = sourceLines
                      .slice(rangeStart - result.lineStart, rangeEnd - result.lineStart + 1)
                      .join('\n')
                    additions.push(
                      makeSection({
                        result: { ...result, lineStart: rangeStart, lineEnd: rangeEnd, text },
                        reason,
                        origins,
                        chunkHash,
                        profileId,
                        truncated,
                      }),
                    )
                  }
                  const addedChars = additions.reduce((sum, section) => sum + section.text.length, 0)
                  if (usedChars + addedChars > maxChars)
                    throw new CodeContextError('MANDATORY_BUDGET')
                  usedChars += addedChars
                  sections.push(...additions)
                  return
                }
                omitted.push({ path, reason: 'range-too-large' })
                return
              }
              const lines: Array<string | undefined> = Array(end - start + 1)
              const populate = (lineStart: number, lineEnd: number, text: string) => {
                const parts = text.split('\n')
                if (parts.length !== lineEnd - lineStart + 1)
                  throw new CodeContextError('STALE_SNAPSHOT')
                parts.forEach((part, index) => {
                  lines[lineStart - start + index] = part
                })
              }
              for (const section of connected) {
                if (section.fileContentHash !== result.contentHash)
                  throw new CodeContextError('STALE_SNAPSHOT')
                populate(section.lineStart, section.lineEnd, section.text)
              }
              populate(result.lineStart, result.lineEnd, result.text)
              if (lines.some((line) => line === undefined))
                throw new CodeContextError('STALE_SNAPSHOT')
              const merged = {
                ...result,
                lineStart: start,
                lineEnd: end,
                text: (lines as string[]).join('\n'),
              }
              const priorChars = connected.reduce((sum, section) => sum + section.text.length, 0)
              const additionalChars = merged.text.length - priorChars
              if (usedChars + additionalChars > maxChars) {
                if (reason === 'mandatory') throw new CodeContextError('MANDATORY_BUDGET')
                omitted.push({ path, reason: 'budget' })
                return
              }
              usedChars += additionalChars
              for (const duplicate of connected.slice(1)) {
                const position = sections.indexOf(duplicate)
                if (position >= 0) sections.splice(position, 1)
              }
              previous.lineStart = merged.lineStart
              previous.lineEnd = merged.lineEnd
              previous.text = merged.text
              previous.fileContentHash = merged.contentHash
              previous.truncated ||= truncated
              if (!previous.candidateChunkHash) previous.candidateChunkHash = chunkHash
              if (reason === 'mandatory' || connected.some((s) => s.reason === 'mandatory'))
                previous.reason = 'mandatory'
              else if (reason === 'related') previous.reason = 'related'
              previous.rankOrigins.push(
                ...connected
                  .flatMap((section) => section.rankOrigins)
                  .concat(origins)
                  .filter(
                    (o) =>
                      !previous.rankOrigins.some(
                        (p) =>
                          p.source === o.source && p.queryIndex === o.queryIndex && p.rank === o.rank,
                      ),
                  ),
              )
              previous.fusionScore = previous.rankOrigins.reduce(
                (sum, origin) => sum + 1 / (60 + origin.rank),
                0,
              )
              return
            }
            const cost = result.text.length
            if (usedChars + cost > maxChars) {
              if (reason === 'mandatory') throw new CodeContextError('MANDATORY_BUDGET')
              omitted.push({ path, reason: 'budget' })
              return
            }
            usedChars += cost
            sections.push({
              path: result.path,
              lineStart: result.lineStart,
              lineEnd: result.lineEnd,
              text: result.text,
              fileContentHash: result.contentHash,
              candidateChunkHash: chunkHash,
              reason,
              rankOrigins: [...origins],
              profileId: origins.find((origin) => origin.profileId)?.profileId ?? profileId,
              truncated,
              fusionScore: origins.reduce((sum, origin) => sum + 1 / (60 + origin.rank), 0),
            })
          }

          // Required paths are read first and never silently truncated or omitted.
          for (const item of mandatory) {
            const start = item.lineStart
            const end = item.lineEnd
            if (end !== undefined && end - (start ?? 1) + 1 > limits.maxRangeLines)
              throw new CodeContextError('LIMIT')
            await read(item.path, start, end, 'mandatory', [], null)
          }
          const byPath = new Map<string, typeof hits>()
          for (const candidate of hits) {
            const group = byPath.get(candidate.hit.path) ?? []
            group.push(candidate)
            byPath.set(candidate.hit.path, group)
          }
          const firstPerPath = [...byPath.values()].map((group) => group[0]!)
          const additional = [...byPath.values()].flatMap((group) => group.slice(1, 2))
          const addCandidates = async (
            candidates: typeof hits,
            reason: CodeContextSection['reason'],
            maxPerPath: number,
          ) => {
            for (const candidate of candidates) {
              const existing = sections.filter((section) => section.path === candidate.hit.path)
              const overlaps = existing.some(
                (section) =>
                  candidate.hit.lineStart <= section.lineEnd + 1 &&
                  candidate.hit.lineEnd >= section.lineStart - 1,
              )
              if (existing.length >= maxPerPath && !overlaps) continue
              await read(
                candidate.hit.path,
                candidate.hit.lineStart,
                candidate.hit.lineEnd,
                reason,
                candidate.origins,
                candidate.hit.contentHash,
              )
            }
          }
          await addCandidates(firstPerPath, 'search', 1)
          await addCandidates(additional, 'search', 2)
          if (request.includeRelated) {
            const relatedCandidates: typeof hits = []
            const relatedPaths = new Set<string>()
            for (const candidate of firstPerPath.slice(0, 3)) {
              signal.throwIfAborted()
              if (relatedPaths.has(candidate.hit.path)) continue
              relatedPaths.add(candidate.hit.path)
              const related = structuredClone(
                await operationIndex.relatedCode({
                  root: request.root,
                  path: candidate.hit.path,
                  ...(candidate.hit.symbol ? { symbol: candidate.hit.symbol } : {}),
                  limit: 4,
                  signal,
                }),
              )
              signal.throwIfAborted()
              if (related.stale) throw new CodeContextError('STALE_SNAPSHOT')
              assertIdentity(identity, [related.identity])
              related.similar.forEach((hit, rank) => {
                if (hits.some((base) => base.hit.id === hit.id)) return
                relatedCandidates.push({
                  hit,
                  origins: [
                    {
                      source: 'related',
                      queryIndex: null,
                      rank: rank + 1,
                      mode: hit.ranking.mode,
                      lexicalRank: hit.ranking.lexicalRank,
                      denseRank: hit.ranking.denseRank,
                      rerankRank: hit.ranking.rerankRank,
                      score: hit.score,
                      profileId: hit.profileId,
                    },
                  ],
                  score: 1 / (60 + rank + 1),
                })
              })
            }
            await addCandidates(relatedCandidates, 'related', 2)
          }
          signal.throwIfAborted()
          const finalStatus = structuredClone(await operationIndex.indexStatus(request.root, signal))
          if (!finalStatus.identity) throw new CodeContextError('STALE_SNAPSHOT')
          assertIdentity(identity, [finalStatus.identity])
          const degradedReasons = lists.flatMap((list) =>
            list.degradedReason ? [list.degradedReason] : [],
          )
          return {
            identity,
            profileId,
            sections,
            budget: { usedChars, maxChars },
            omitted,
            degraded: degradedReasons.length > 0,
            degradedReasons: [...new Set(degradedReasons)],
          }
        }
        return index.withReadSnapshot
          ? index.withReadSnapshot(request.root, signal, run)
          : run(index)
      })
    },
    relatedCode(input: RelatedCodeRequest) {
      const request = Object.freeze({ ...input })
      if (
        !request.root ||
        request.root.length > 4096 ||
        !request.path.trim() ||
        request.path.length > 2000 ||
        (request.symbol !== undefined && request.symbol.length > limits.maxQueryChars)
      )
        throw new CodeContextError('LIMIT')
      if (
        request.limit !== undefined &&
        (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > limits.maxLimit)
      )
        throw new CodeContextError('LIMIT')
      return lifecycle.run(request.signal, limits.timeoutMs, async (signal) => {
        signal.throwIfAborted()
        const before = structuredClone(await index.indexStatus(request.root, signal))
        if (!before.identity) throw new CodeContextError('STALE_SNAPSHOT')
        signal.throwIfAborted()
        const related = structuredClone(
          await index.relatedCode({
            root: request.root,
            path: request.path,
            ...(request.symbol === undefined ? {} : { symbol: request.symbol }),
            limit: request.limit ?? 8,
            signal,
          }),
        )
        signal.throwIfAborted()
        const after = structuredClone(await index.indexStatus(request.root, signal))
        if (!after.identity || related.stale) throw new CodeContextError('STALE_SNAPSHOT')
        assertIdentity(before.identity, [after.identity, related.identity])
        return related
      })
    },
    close: () => lifecycle.close(),
  }
}

function validateLimits(l: CodeContextLimits): void {
  for (const [key, value] of Object.entries(l))
    if (!Number.isInteger(value) || value <= 0) throw new TypeError(`Invalid context limit: ${key}`)
  if (
    l.maxFeatureQueries > 8 ||
    l.maxMandatory > 16 ||
    l.maxConcurrency > 8 ||
    l.maxLimit > 100 ||
    l.maxQueryChars > 8000 ||
    l.maxChars > 100000 ||
    l.timeoutMs > 120000 ||
    l.maxRangeLines > 200
  )
    throw new TypeError('Context limits exceed hard caps')
}
function validateRequest(input: CodeContextRequest, limits: CodeContextLimits): void {
  if (
    !input.root ||
    input.root.length > 4096 ||
    !input.query.trim() ||
    input.query.length > limits.maxQueryChars
  )
    throw new CodeContextError('LIMIT')
  if (
    (input.featureQueries?.length ?? 0) > limits.maxFeatureQueries ||
    (input.mustInclude?.length ?? 0) > limits.maxMandatory
  )
    throw new CodeContextError('LIMIT')
  if (input.includeRelated !== undefined && typeof input.includeRelated !== 'boolean')
    throw new CodeContextError('LIMIT')
  if (input.featureQueries?.some((query) => !query.trim() || query.length > limits.maxQueryChars))
    throw new CodeContextError('LIMIT')
  if (
    input.mustInclude?.some(
      (range) =>
        !range.path.trim() ||
        range.path.length > 2000 ||
        (range.lineStart !== undefined &&
          (!Number.isInteger(range.lineStart) || range.lineStart < 1)) ||
        (range.lineEnd !== undefined && (!Number.isInteger(range.lineEnd) || range.lineEnd < 1)) ||
        (range.lineStart !== undefined &&
          range.lineEnd !== undefined &&
          range.lineEnd < range.lineStart),
    )
  )
    throw new CodeContextError('LIMIT')
  if (
    input.limit !== undefined &&
    (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > limits.maxLimit)
  )
    throw new CodeContextError('LIMIT')
  if (
    input.maxChars !== undefined &&
    (!Number.isInteger(input.maxChars) || input.maxChars < 1 || input.maxChars > limits.maxChars)
  )
    throw new CodeContextError('LIMIT')
}
function assertIdentity(expected: CodeSourceIdentity, actual: CodeSourceIdentity[]): void {
  if (
    actual.some(
      (value) =>
        value.snapshotId !== expected.snapshotId ||
        value.contentHash !== expected.contentHash ||
        value.root !== expected.root ||
        value.worktreeId !== expected.worktreeId,
    )
  )
    throw new CodeContextError('STALE_SNAPSHOT')
}
function freezeRequest(input: CodeContextRequest): CodeContextRequest {
  return Object.freeze({
    ...input,
    ...(input.featureQueries
      ? { featureQueries: Object.freeze([...input.featureQueries]) as unknown as string[] }
      : {}),
    ...(input.mustInclude
      ? {
          mustInclude: Object.freeze(
            input.mustInclude.map((range) => Object.freeze({ ...range })),
          ) as unknown as RequiredCodeRange[],
        }
      : {}),
  })
}
function makeSection(input: {
  result: Awaited<ReturnType<CodeIndex['readSource']>>
  reason: CodeContextSection['reason']
  origins: CodeContextSection['rankOrigins']
  chunkHash: string | null
  profileId: string | null
  truncated: boolean
}): CodeContextSection {
  return {
    path: input.result.path,
    lineStart: input.result.lineStart,
    lineEnd: input.result.lineEnd,
    text: input.result.text,
    fileContentHash: input.result.contentHash,
    candidateChunkHash: input.chunkHash,
    profileId: input.origins.find((origin) => origin.profileId)?.profileId ?? input.profileId,
    truncated: input.truncated,
    fusionScore: input.origins.reduce((sum, origin) => sum + 1 / (60 + origin.rank), 0),
    reason: input.reason,
    rankOrigins: [...input.origins],
  }
}
