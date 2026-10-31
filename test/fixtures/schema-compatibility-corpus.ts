const stamp = '2026-10-31T12:34:56.123Z'
const uuid = '018f0a88-5d99-7abc-8def-123456789abc'
const currentVersion = {
  versionId: uuid, fetchedAt: stamp, lastCheckedAt: stamp, publishedAt: null,
  sourceUpdatedAt: null, game: null, gameVersion: null, language: 'en', excerpt: 'text',
}
const savedSource = { id: uuid, url: 'https://example.test/page', title: 'Title', addedAt: stamp, versionCount: 1, current: currentVersion }
const savedVersion = {
  id: uuid, fetchedAt: stamp, lastCheckedAt: stamp, publishedAt: null,
  sourceUpdatedAt: null, game: null, gameVersion: null, language: 'en', excerpt: 'text', isCurrent: true,
}
const chunk = { versionId: uuid, ordinal: 0, text: 'text' }
const legacyUuid = '12345678-1234-1234-1234-123456789012'
const malformedUuid = '1234567g-1234-1234-1234-123456789012'
const legacySource = { ...savedSource, id: legacyUuid, current: { ...currentVersion, versionId: legacyUuid } }
const legacyVersion = { ...savedVersion, id: legacyUuid }

export const schemaCompatibilityCorpus = [
  { schema: 'searchRequestSchema', name: 'request defaults', input: { query: 'question' }, success: true },
  { schema: 'searchRequestSchema', name: 'nested freshness default', input: { query: 'question', freshness: {} }, success: true },
  { schema: 'searchRequestSchema', name: 'request object strips unknown keys', input: { query: 'question', extra: true }, success: true },
  { schema: 'searchRequestSchema', name: 'request bound rejects overflow', input: { query: 'question', targetSources: 201 }, success: false },
  { schema: 'documentSchema', name: 'document optional defaults', input: { url: 'https://example.test', title: 'Title', text: 'body', fetchedAt: stamp }, success: true },
  { schema: 'documentSchema', name: 'document rejects non-UTC offset date', input: { url: 'https://example.test', title: 'Title', text: 'body', fetchedAt: '2026-10-31T12:34:56+00:00' }, success: false },
  { schema: 'documentSchema', name: 'document strips unknown keys', input: { url: 'https://example.test', title: 'Title', text: 'body', fetchedAt: stamp, extra: true }, success: true },
  { schema: 'passageSchema', name: 'passage optional metadata', input: { id: 'id', url: 'https://example.test', title: 'Title', excerpt: 'text', score: 0, addedAt: stamp, fetchedAt: stamp, lastCheckedAt: stamp, publishedAt: null, sourceUpdatedAt: null }, success: true },
  { schema: 'embeddingSchema', name: 'finite vector accepted', input: [[0, 1]], success: true },
  { schema: 'embeddingSchema', name: 'non-finite vector rejected', input: [[Number.POSITIVE_INFINITY]], success: false },
  { schema: 'searchCollectionErrorSchema', name: 'optional error metadata', input: { code: 'FAILED' }, success: true },
  { schema: 'searchCollectionErrorSchema', name: 'error schema is strict', input: { code: 'FAILED', detail: 'private' }, success: false },
  { schema: 'searchResultSchema', name: 'empty result arrays', input: { origin: 'database', passages: [], collected: 0, attempted: 0, partial: false, errors: [], cacheScore: 0 }, success: true },
  { schema: 'searchJobSnapshotSchema', name: 'job UUID and running status', input: { id: uuid, status: 'running' }, success: true },
  { schema: 'searchLegacyEventSchema', name: 'legacy event detail record', input: { jobId: uuid, sequence: 1, type: 'started', detail: {} }, success: true },
  { schema: 'searchProgressFactSchema', name: 'bounded progress count', input: { stage: 'discovery', state: 'completed', queryIndex: 0, queryCount: 1, discoveredCount: 200 }, success: true },
  { schema: 'searchProgressFactSchema', name: 'progress count overflow rejected', input: { stage: 'discovery', state: 'completed', queryIndex: 0, queryCount: 1, discoveredCount: 201 }, success: false },
  { schema: 'searchProgressEventSchema', name: 'progress ISO timestamp', input: { jobId: uuid, sequence: 1, timestamp: stamp, type: 'progress', progress: { stage: 'cache', state: 'started' } }, success: true },
  { schema: 'searchEventSchema', name: 'event union accepts progress', input: { jobId: uuid, sequence: 1, timestamp: stamp, type: 'progress', progress: { stage: 'cache', state: 'started' } }, success: true },
  { schema: 'knowledgeDeleteSchema', name: 'delete all-user-knowledge branch', input: { scope: 'all-user-knowledge' }, success: true },
  { schema: 'knowledgeDeleteSchema', name: 'delete source cap rejects overflow', input: { scope: 'sources', sourceIds: Array.from({ length: 501 }, () => uuid) }, success: false },
  { schema: 'knowledgeDeleteSchema', name: 'delete branch is strict', input: { scope: 'all-user-knowledge', extra: true }, success: false },
  { schema: 'knowledgeDeleteResultSchema', name: 'delete integer totals', input: { sources: 1, versions: 1, chunks: 1, provenance: 0 }, success: true },
  { schema: 'embeddingProfileSchema', name: 'float embedding profile', input: { space: 'space', model: 'model', dimensions: 3, encoding: 'float', chunker: 'chunks' }, success: true },
  { schema: 'embeddingProfileSchema', name: 'profile schema is strict', input: { space: 'space', model: 'model', dimensions: 3, encoding: 'float', chunker: 'chunks', extra: 1 }, success: false },
  { schema: 'reindexChunkSchema', name: 'valid reindex chunk UUID', input: chunk, success: true },
  { schema: 'reindexPayloadSchema', name: 'reindex batch cap rejects overflow', input: { profile: { space: 'space', model: 'model', dimensions: 3, encoding: 'float', chunker: 'chunks' }, chunks: Array.from({ length: 33 }, (_, ordinal) => ({ ...chunk, ordinal })) }, success: false },
  { schema: 'knowledgeHistoryCursorTimestamptzUtcSchema', name: 'cursor preserves microseconds', input: '2026-10-31T12:34:56.123456Z', success: true },
  { schema: 'knowledgeHistoryCursorTimestamptzUtcSchema', name: 'cursor rejects millisecond precision', input: stamp, success: false },
  { schema: 'knowledgeHistoryFilterSchema', name: 'history filter strictness', input: { game: 'Game', extra: true }, success: false },
  { schema: 'knowledgeHistoryPageSchema', name: 'history page default', input: {}, success: true },
  { schema: 'savedSourceIdSchema', name: 'version 7 UUID', input: uuid, success: true },
  { schema: 'savedSourceCurrentVersionSchema', name: 'Date transform and nullable fields', input: { ...currentVersion, fetchedAt: new Date(stamp) }, success: true },
  { schema: 'savedSourceSchema', name: 'saved source DTO', input: savedSource, success: true },
  { schema: 'savedSourcePageSchema', name: 'saved source page DTO', input: { items: [savedSource] }, success: true },
  { schema: 'savedSourceVersionSchema', name: 'saved source version DTO', input: savedVersion, success: true },
  { schema: 'savedSourceVersionPageSchema', name: 'saved source version page DTO', input: { items: [savedVersion] }, success: true },
  { schema: 'searchJobSnapshotSchema', name: 'legacy UUID without version or variant bits', input: { id: legacyUuid, status: 'running' }, success: true },
  { schema: 'searchJobSnapshotSchema', name: 'UUID rejects non-hex character', input: { id: malformedUuid, status: 'running' }, success: false },
  { schema: 'searchLegacyEventSchema', name: 'legacy UUID uppercase hex', input: { jobId: legacyUuid.toUpperCase(), sequence: 1, type: 'started', detail: {} }, success: true },
  { schema: 'passageSchema', name: 'passage accepts legacy source and version UUID form', input: { id: 'p', sourceId: legacyUuid, versionId: legacyUuid, url: 'https://example.test', title: 'Title', excerpt: 'text', score: 0, addedAt: stamp, fetchedAt: stamp, lastCheckedAt: stamp, publishedAt: null, sourceUpdatedAt: null }, success: true },
  { schema: 'searchProgressEventSchema', name: 'progress event accepts legacy UUID form', input: { jobId: legacyUuid, sequence: 1, timestamp: stamp, type: 'progress', progress: { stage: 'cache', state: 'started' } }, success: true },
  { schema: 'searchEventSchema', name: 'event union rejects malformed UUID length', input: { jobId: '12345678-1234-1234-1234-12345678901', sequence: 1, timestamp: stamp, type: 'progress', progress: { stage: 'cache', state: 'started' } }, success: false },
  { schema: 'knowledgeDeleteSchema', name: 'delete accepts legacy UUID form', input: { scope: 'sources', sourceIds: [legacyUuid] }, success: true },
  { schema: 'embeddingProfileSchema', name: 'reindex chunk accepts legacy UUID form', input: { space: 'space', model: 'model', dimensions: 3, encoding: 'float', chunker: 'chunks' }, success: true },
  { schema: 'reindexChunkSchema', name: 'reindex accepts legacy UUID form', input: { versionId: legacyUuid, ordinal: 0, text: 'text' }, success: true },
  { schema: 'savedSourceIdSchema', name: 'history identifier accepts legacy UUID form', input: legacyUuid, success: true },
  { schema: 'savedSourceCurrentVersionSchema', name: 'history version accepts legacy UUID form', input: { ...currentVersion, versionId: legacyUuid }, success: true },
  { schema: 'savedSourceSchema', name: 'history source DTO accepts legacy UUID form', input: legacySource, success: true },
  { schema: 'savedSourcePageSchema', name: 'history page accepts legacy UUID form', input: { items: [legacySource] }, success: true },
  { schema: 'savedSourceVersionSchema', name: 'history version DTO accepts legacy UUID form', input: legacyVersion, success: true },
  { schema: 'savedSourceVersionPageSchema', name: 'history version page accepts legacy UUID form', input: { items: [legacyVersion] }, success: true },
  { schema: 'savedSourceSchema', name: 'history rejects malformed UUID length', input: { ...savedSource, id: '12345678-1234-1234-1234-12345678901' }, success: false },
  { schema: 'savedSourceSchema', name: 'history versionCount legacy large integer', input: { ...savedSource, versionCount: Number.MAX_SAFE_INTEGER + 1 }, success: true },
  { schema: 'passageSchema', name: 'passage ordinal legacy large integer', input: { id: 'p', ordinal: Number.MAX_SAFE_INTEGER + 1, url: 'https://example.test', title: 'Title', excerpt: 'text', score: 0, addedAt: stamp, fetchedAt: stamp, lastCheckedAt: stamp, publishedAt: null, sourceUpdatedAt: null }, success: true },
  { schema: 'searchResultSchema', name: 'result counters legacy large integers', input: { origin: 'database', passages: [], collected: Number.MAX_SAFE_INTEGER + 1, attempted: Number.MAX_SAFE_INTEGER + 2, partial: false, errors: [], cacheScore: 0 }, success: true },
  { schema: 'knowledgeDeleteResultSchema', name: 'delete totals legacy large integers', input: { sources: Number.MAX_SAFE_INTEGER + 1, versions: 1, chunks: 1, provenance: 0 }, success: true },
  { schema: 'searchLegacyEventSchema', name: 'legacy event sequence accepts large integer', input: { jobId: uuid, sequence: Number.MAX_SAFE_INTEGER + 1, type: 'started', detail: {} }, success: true },
  { schema: 'searchProgressEventSchema', name: 'progress sequence accepts large integer', input: { jobId: uuid, sequence: Number.MAX_SAFE_INTEGER + 1, timestamp: stamp, type: 'progress', progress: { stage: 'cache', state: 'started' } }, success: true },
  { schema: 'searchCollectionErrorSchema', name: 'collection query index accepts large integer', input: { queryIndex: Number.MAX_SAFE_INTEGER + 1, code: 'FAILED' }, success: true },
] as const
