import type { Passage, SearchModels, SourceDocument } from './contracts.js'

import { embeddingSchema } from './contracts.js'
import { chunkDocuments, validateRanking } from './retrieval.js'

export async function embedChunks(
  documents: SourceDocument[],
  models: SearchModels,
  dimensions: number,
  signal: AbortSignal,
) {
  const chunks = chunkDocuments(documents)
  const embedded: { documentIndex: number; text: string; vector: number[] }[] = []
  for (let start = 0; start < chunks.length; start += 32) {
    signal.throwIfAborted()
    const batch = chunks.slice(start, start + 32)
    const values = embeddingSchema.parse(
      await models.embed({ texts: batch.map((chunk) => chunk.text), signal }),
    )
    if (values.length !== batch.length) throw new Error('EMBEDDING_COUNT_MISMATCH')
    batch.forEach((chunk, index) => {
      const vector = values[index]
      if (!vector || vector.length !== dimensions) throw new Error('EMBEDDING_DIMENSION_MISMATCH')
      embedded.push({ ...chunk, vector })
    })
  }
  return embedded
}
export async function rankPassages(
  query: string,
  passages: Passage[],
  models: SearchModels,
  signal: AbortSignal,
): Promise<Passage[]> {
  if (passages.length === 0) return []
  const rank = validateRanking(
    await models.rerank({ query, documents: passages.map((p) => p.excerpt), signal }),
    passages.length,
  )
  signal.throwIfAborted()
  return rank.slice(0, 8).flatMap((entry) => {
    const passage = passages[entry.index]
    return passage ? [{ ...passage, score: entry.score }] : []
  })
}
