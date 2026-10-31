/** Owner selectable, pinned presets matching the reviewed Mechanism retrieval configuration. */
export const MECHANISM_RETRIEVAL_PRESETS = Object.freeze({
  code: Object.freeze({
    model: 'voyageai/voyage-code-4',
    dimensions: 1024,
    candidateLimit: 30,
    reranker: 'voyageai/rerank-2.5-lite',
    defaultLimit: 8,
  }),
  visual: Object.freeze({
    model: 'voyageai/voyage-multimodal-3.5',
    dimensions: 1024,
    defaultLimit: 5,
  }),
})
