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

const verifiedResponseNames: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'voyageai/voyage-code-4': Object.freeze(['voyageai/voyage-code-4', 'voyage-code-4']),
  'voyageai/rerank-2.5-lite': Object.freeze(['voyageai/rerank-2.5-lite', 'rerank-2.5-lite']),
  'voyageai/voyage-multimodal-3.5': Object.freeze([
    'voyageai/voyage-multimodal-3.5',
    'voyage-multimodal-3.5',
  ]),
})

/** Exact full and observed OpenRouter response names for the three reviewed presets only. */
export function isVerifiedVoyageResponseModel(requestedModel: string, responseModel: unknown): boolean {
  return (
    typeof responseModel === 'string' &&
    Object.hasOwn(verifiedResponseNames, requestedModel) &&
    verifiedResponseNames[requestedModel]!.includes(responseModel)
  )
}

export function isVerifiedVoyageVisualResponseModel(
  requestedModel: string,
  responseModel: unknown,
): boolean {
  return (
    requestedModel === MECHANISM_RETRIEVAL_PRESETS.visual.model &&
    responseModel === 'voyage-multimodal-3.5'
  )
}
