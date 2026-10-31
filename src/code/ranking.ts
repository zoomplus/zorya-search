export interface LexicalRow {
  id: string
  path: string
  symbol: string | null
  text: string
  lineStart: number
}

export interface LexicalRank<T extends LexicalRow> {
  row: T
  score: number
}
export interface FusedRank<T extends LexicalRow> {
  row: T
  lexicalRank: number | null
  denseRank: number | null
  score: number
}

export function tokenizeCode(text: string): string[] {
  return (
    text
      .match(/[\p{L}\p{N}]+/gu)
      ?.flatMap((part) =>
        part
          .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
          .split(/[\s_\-]+/u)
          .map((token) => token.toLowerCase()),
      )
      .filter(Boolean) ?? []
  )
}

export function rankLexical<T extends LexicalRow>(rows: T[], query: string): LexicalRank<T>[] {
  const queryTokens = tokenizeCode(query)
  const prepared = rows.map((row) => {
    const bodyTerms = tokenizeCode(row.text)
    const terms = [...tokenizeCode(`${row.path} ${row.symbol ?? ''}`), ...bodyTerms]
    const frequencies = new Map<string, number>()
    for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
    return { row, terms, bodyLength: bodyTerms.length, frequencies, uniqueTerms: new Set(terms) }
  })
  const documentFrequency = new Map<string, number>()
  for (const item of prepared)
    for (const token of item.uniqueTerms)
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
  const averageLength =
    prepared.reduce((sum, item) => sum + item.bodyLength, 0) / Math.max(1, prepared.length)
  return prepared
    .map(({ row, terms, frequencies }) => {
      const score = queryTokens.reduce((sum, term) => {
        const termFrequency = frequencies.get(term) ?? 0
        if (!termFrequency) return sum
        const documents = documentFrequency.get(term) ?? 0
        const inverseDocumentFrequency = Math.log(
          1 + (rows.length - documents + 0.5) / (documents + 0.5),
        )
        return (
          sum +
          (inverseDocumentFrequency * (termFrequency * 2.2)) /
            (termFrequency + 1.2 * (0.25 + (0.75 * terms.length) / Math.max(1, averageLength)))
        )
      }, 0)
      return { row, score }
    })
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.row.path.localeCompare(right.row.path) ||
        left.row.lineStart - right.row.lineStart,
    )
}

export function reciprocalRankFusion<T extends LexicalRow>(
  rows: T[],
  lexicalRanks: Map<string, number>,
  denseRanks: Map<string, number>,
): FusedRank<T>[] {
  return rows
    .map((row) => {
      const lexicalRank = lexicalRanks.get(row.id) ?? null
      const denseRank = denseRanks.get(row.id) ?? null
      const score =
        (lexicalRank ? 1 / (60 + lexicalRank) : 0) + (denseRank ? 1 / (60 + denseRank) : 0)
      return { row, lexicalRank, denseRank, score }
    })
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.row.path.localeCompare(right.row.path) ||
        left.row.lineStart - right.row.lineStart,
    )
}
