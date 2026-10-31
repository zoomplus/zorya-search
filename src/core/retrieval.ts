import { z } from 'zod'

import type { Passage, SourceDocument, SearchRequest } from './contracts.js'

export function canonicalUrl(raw: string): string {
  const url = new URL(z.string().url().parse(raw))
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported URL protocol')
  if (url.username || url.password) throw new Error('Credential URLs are unsupported')
  url.hash = ''
  for (const key of [...url.searchParams.keys()])
    if (key.startsWith('utm_') || ['fbclid', 'gclid'].includes(key)) url.searchParams.delete(key)
  url.searchParams.sort()
  return url.toString()
}
export function chunkDocuments(
  documents: SourceDocument[],
  maxCharacters = 4000,
  overlap = 300,
): { documentIndex: number; text: string }[] {
  z.number().int().min(100).parse(maxCharacters)
  z.number()
    .int()
    .min(0)
    .max(maxCharacters - 1)
    .parse(overlap)
  return documents.flatMap((document, documentIndex) => {
    const text = document.text.replace(/\s+/g, ' ').trim()
    const chunks: { documentIndex: number; text: string }[] = []
    for (let start = 0; start < text.length; start += maxCharacters - overlap) {
      chunks.push({ documentIndex, text: text.slice(start, start + maxCharacters) })
      if (start + maxCharacters >= text.length) break
    }
    return chunks
  })
}
export function reciprocalRankFusion(lists: Passage[][], limit: number, k = 60): Passage[] {
  const entries = new Map<string, Passage>()
  for (const list of lists)
    list.forEach((passage, index) => {
      const key =
        passage.versionId !== undefined && passage.ordinal !== undefined
          ? `${passage.versionId}:${passage.ordinal}`
          : passage.id
      const prior = entries.get(key)
      entries.set(key, { ...(prior ?? passage), score: (prior?.score ?? 0) + 1 / (k + index + 1) })
    })
  return [...entries.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}
export function validateRanking(
  ranking: unknown,
  length: number,
): { index: number; score: number }[] {
  const rows = z
    .array(
      z.object({
        index: z
          .number()
          .int()
          .min(0)
          .max(length - 1),
        score: z.number().finite(),
      }),
    )
    .parse(ranking)
  const seen = new Set<number>()
  return rows.filter((row) => {
    if (seen.has(row.index)) return false
    seen.add(row.index)
    return true
  })
}

export function buildSearchQuery(request: SearchRequest): string {
  return `${request.game ?? ''} ${request.query}`.trim()
}

export function buildSearchQueries(request: SearchRequest): string[] {
  const base = buildSearchQuery(request)
  const locale = request.language.toLowerCase().split('-')[0]
  const facets =
    locale === 'ru'
      ? ['гайд', 'прохождение', 'вики', 'советы', 'карта', 'стратегия', 'форум', 'reddit']
      : locale === 'en'
        ? ['guide', 'walkthrough', 'wiki', 'tips', 'location', 'map', 'strategy', 'reddit', 'forum']
        : ['guide', 'wiki', 'tips', 'forum']
  const tokens = new Set(
    base
      .normalize('NFKC')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  )
  const queries = [base]
  const seen = new Set([base.normalize('NFKC').toLowerCase()])
  for (const facet of facets) {
    const additions = facet
      .split(/\s+/u)
      .filter((token) => !tokens.has(token.normalize('NFKC').toLowerCase()))
    if (!additions.length) continue
    const query = [base, additions.join(' ')].join(' ').trim()
    const normalized = query.normalize('NFKC').toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    queries.push(query)
  }
  if (request.game) {
    const gameFacets =
      locale === 'ru'
        ? ['прохождение', 'вики', 'карта', 'предметы', 'квесты', 'боссы']
        : locale === 'en'
          ? ['guide', 'wiki', 'map', 'items', 'quests', 'bosses']
          : ['guide', 'wiki', 'map', 'items']
    for (const facet of gameFacets) {
      const query = `${request.game} ${facet}`.trim()
      const normalized = query.normalize('NFKC').toLowerCase()
      if (seen.has(normalized)) continue
      seen.add(normalized)
      queries.push(query)
    }
  }
  return queries
}
