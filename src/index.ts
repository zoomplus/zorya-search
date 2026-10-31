export * from './core/contracts.js'
export * from './core/embedding-profile.js'
export * from './core/knowledge-history.js'
export * from './core/errors.js'
export { executeSearch } from './core/search.js'
export type { SearchDependencies } from './core/search.js'
export { enqueueReindex, executeReindexBatch } from './core/reindex.js'
export type { ReindexDependencies } from './core/reindex.js'
export { createPostgresReindexer, SearchReindexer } from './core/reindex-service.js'
export {
  buildSearchQueries,
  buildSearchQuery,
  canonicalUrl,
  chunkDocuments,
  reciprocalRankFusion,
} from './core/retrieval.js'
export {
  createSearchService,
  SearchService,
  SEARCH_EVENT_SUBSCRIBER_LIMIT,
} from './core/service.js'
export { startMaintenance } from './core/maintenance.js'
export type { MaintenanceHandle } from './core/maintenance.js'
export { openEmbeddedDatabase } from './storage/embedded.js'
export { wrapPostgresPool, connectPostgres } from './storage/postgres.js'
export type { OwnedDatabase, QueryResult, QueryableDatabase } from './storage/database.js'
export { PostgresKnowledgeRepository } from './storage/postgres-repository/repository.js'
export { PostgresReindexRepository } from './storage/postgres-reindex.js'
export { SqlQueue } from './storage/queue/sql-queue.js'
export { SearchAnnIndex, annIndexName } from './storage/ann-index.js'
export type { AnnMeasurement } from './storage/ann-index.js'
export type * from './code/types.js'
export type {
  CodeContextLimits,
  RequiredCodeRange,
  CodeContextRequest,
  RelatedCodeRequest,
  CodeContextSection,
  CodeContextResult,
  CodeContextRankOrigin,
} from './context/index.js'
export type {
  WebContextModels,
  WebSearchLimits,
  WebPassage,
  WebSearchResult,
} from './context/web.js'
export type { ClassificationLimits, ClassificationProfile } from './context/classify.js'
export type { VisualReference, VisualLimits } from './visual/index.js'
export { createCompatibleErrorFactory } from './compat/element-error-adapter.js'
export type { CompatibleSearchErrorConstructor } from './compat/element-error-adapter.js'
export { wrapLegacyPostgresDatabase } from './compat/postgres-database.js'
export type { LegacyPostgresDatabase, LegacySqlExecutor } from './compat/postgres-database.js'
