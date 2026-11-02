import type { ReuseContextResult } from '../context/reuse-types.js'

const MAX_OTHER_CANDIDATE_FILES = 4
const MAX_OTHER_HITS = 4
const MAX_OTHER_GRAPH_NODES = 2
const MAX_OTHER_GRAPH_EDGES = 4
const MAX_SELECTED_GRAPH_EDGES = 4
const MAX_SELECTED_LOGICAL_BLOCKS = 4
const MAX_OTHER_LOGICAL_BLOCKS = 1
const MAX_SELECTED_LOGICAL_OMISSIONS = 8
const MAX_DUPLICATE_GROUPS = 2
const MAX_DUPLICATE_OCCURRENCES = 1

/** MCP-only projection. The SDK and runtime continue to return the complete result. */
export function compactReuseContext(rootId: string, result: ReuseContextResult) {
  const graph = result.candidates.graph
  const selectedFiles = new Set(result.selection.selectedFiles)
  const compactDuplicateScope = [
    ...result.duplicates.scope.filter((path) => selectedFiles.has(path)),
    ...result.duplicates.scope.filter((path) => !selectedFiles.has(path)).slice(0, 4),
  ]
  const duplicateScopeOmitted = Math.max(0, result.duplicates.scope.length - compactDuplicateScope.length)
  const logical = result.context.logicalContext
  const selectedSymbols = result.selection.selected.map((item) => ({
    path: item.path,
    symbolId: item.symbol.id,
    lineStart: item.symbol.lineStart,
    lineEnd: item.symbol.lineEnd,
    fileHash: result.readCoverage.find((coverage) =>
      coverage.path === item.path && coverage.symbolId === item.symbol.id)?.fileHash,
  }))
  const selectedSymbolIds = new Set(selectedSymbols.map((item) => item.symbolId))
  const selectedSections = result.context.sections.filter((section) => selectedSymbols.some((symbol) =>
    symbol.path === section.path && symbol.fileHash !== undefined && symbol.fileHash === section.fileContentHash &&
    section.lineEnd >= symbol.lineStart && section.lineStart <= symbol.lineEnd))
  const deferredSections = result.context.sections.filter((section) => !selectedSections.includes(section))
  const selectedHits = result.candidates.hits.filter((hit) => selectedFiles.has(hit.path))
    .filter((hit, index, hits) => hits.findIndex((candidate) => candidate.path === hit.path) === index)
  const otherHits = result.candidates.hits.filter((hit) => !selectedFiles.has(hit.path)).slice(0, MAX_OTHER_HITS)
  const selectedFileFacts = result.candidates.files.filter((file) => selectedFiles.has(file.path))
  const otherFileFacts = result.candidates.files.filter((file) => !selectedFiles.has(file.path)).slice(0, MAX_OTHER_CANDIDATE_FILES)
  const selectedNodes = graph?.nodes.filter((node) =>
    selectedFiles.has(node.path) || (node.depth === 0 && selectedFiles.has(node.seed))) ?? []
  const otherNodes = graph?.nodes.filter((node) => !selectedNodes.includes(node)).slice(0, MAX_OTHER_GRAPH_NODES) ?? []
  const selectedEdges = graph?.edges.filter((edge) => selectedFiles.has(edge.from) || selectedFiles.has(edge.to))
    .slice(0, MAX_SELECTED_GRAPH_EDGES) ?? []
  const otherEdges = graph?.edges.filter((edge) =>
    !selectedFiles.has(edge.from) && !selectedFiles.has(edge.to)).slice(0, MAX_OTHER_GRAPH_EDGES) ?? []
  const allSelectedBlocks = logical?.blocks.filter((block) =>
    (block.symbolId !== null && selectedSymbolIds.has(block.symbolId)) ||
    (block.relationFrom !== null && selectedSymbolIds.has(block.relationFrom))) ?? []
  const selectedBlocks = [...allSelectedBlocks]
    .sort((left, right) => Number(right.symbolId !== null && selectedSymbolIds.has(right.symbolId)) - Number(left.symbolId !== null && selectedSymbolIds.has(left.symbolId)))
    .slice(0, MAX_SELECTED_LOGICAL_BLOCKS)
  const otherBlocks = logical?.blocks.filter((block) => !allSelectedBlocks.includes(block)).slice(0, MAX_OTHER_LOGICAL_BLOCKS) ?? []
  const allSelectedLogicalOmissions = logical?.omissions.filter((omission) =>
    omission.symbolId !== null && selectedSymbolIds.has(omission.symbolId)) ?? []
  const selectedLogicalOmissions = allSelectedLogicalOmissions.slice(0, MAX_SELECTED_LOGICAL_OMISSIONS)
  const logicalOmissionReasonCounts = Object.fromEntries(
    [...new Set(logical?.omissions.map((omission) => omission.reason) ?? [])].map((reason) => [
      reason,
      logical?.omissions.filter((omission) => omission.reason === reason).length ?? 0,
    ]),
  )
  const keptLogicalOmissions = [
    ...selectedLogicalOmissions,
  ]

  return {
    responseType: 'zorya-search.get_reuse_context',
    responseVersion: 1,
    identity: result.identity,
    query: result.query,
    intent: result.intent,
    selection: result.selection,
    source: {
      profileId: result.context.profileId,
      budget: result.context.budget,
      presentation: {
        mode: 'selected-source-only',
        returnedSectionCount: selectedSections.length,
        deferredSectionCount: deferredSections.length,
        returnedSourceChars: selectedSections.reduce((total, section) => total + section.text.length, 0),
        deferredSourceChars: deferredSections.reduce((total, section) => total + section.text.length, 0),
      },
      degraded: result.context.degraded,
      degradedReasons: result.context.degradedReasons,
      omitted: result.context.omitted,
      sections: selectedSections.map((section) => ({
        path: section.path,
        lineStart: section.lineStart,
        lineEnd: section.lineEnd,
        text: section.text,
        fileContentHash: section.fileContentHash,
        candidateChunkHash: section.candidateChunkHash,
        profileId: section.profileId,
        truncated: section.truncated,
        reason: section.reason,
        rankOrigins: section.rankOrigins,
      })),
      deferredSections: deferredSections.map((section) => ({
        path: section.path,
        lineStart: section.lineStart,
        lineEnd: section.lineEnd,
        fileContentHash: section.fileContentHash,
        truncated: section.truncated,
        reason: section.reason,
        readSourceRequests: readSourceRequests(rootId, result.identity.snapshotId, section.path, section.lineStart, section.lineEnd),
      })),
    },
    coverage: {
      symbolAnalysis: result.symbolAnalysis,
      readCoverage: result.readCoverage,
      omissions: result.omissions,
      continuation: result.continuation.map((entry) => ({
        ...entry,
        ...(entry.cursor !== undefined || entry.symbolId !== undefined || entry.reason === 'symbol-continuation-omitted' || entry.reason === 'positive-file-cap'
          ? { findCodeSymbolsRequest: { rootId, path: entry.path, sourceKind: 'implementation',
              ...(entry.cursor !== undefined ? { cursor: entry.cursor, limit: 100 }
                : entry.symbolId !== undefined ? { symbolId: entry.symbolId } : { limit: 100 }) } }
          : {}),
        ...(entry.lineStart !== undefined && entry.lineEnd !== undefined
          ? {
              readSourceRequest: {
                rootId,
                path: entry.path,
                lineStart: entry.lineStart,
                lineEnd: Math.min(entry.lineEnd, entry.lineStart + 199),
                snapshotId: result.identity.snapshotId,
              },
            }
          : {}),
      })),
      symbolSelection: result.symbolSelection ?? null,
      logical: logical
        ? {
            state: logical.state,
            profileId: logical.profileId,
            analysisComplete: logical.analysisComplete,
            coverage: logical.coverage,
            blocks: [...selectedBlocks, ...otherBlocks].map((block) => ({
              symbolId: block.symbolId,
              name: block.name,
              kind: block.kind,
              role: block.role,
              source: block.source,
              complete: block.complete,
              includedRanges: block.includedRanges.slice(0, 4),
              includedRangesTotal: block.includedRanges.length,
              includedRangesOmitted: Math.max(0, block.includedRanges.length - 4),
              relationFrom: block.relationFrom,
              relationKind: block.relationKind,
              depth: block.depth,
              wholeFile: block.wholeFile,
            })),
            selectedBlocksTotal: allSelectedBlocks.length,
            selectedBlocksOmitted: Math.max(0, allSelectedBlocks.length - selectedBlocks.length),
            blocksTotal: logical.blocks.length,
            blocksOmitted: Math.max(0, logical.blocks.length - selectedBlocks.length - otherBlocks.length),
            omissions: keptLogicalOmissions,
            selectedOmissionsTotal: allSelectedLogicalOmissions.length,
            selectedOmissionsOmitted: Math.max(0, allSelectedLogicalOmissions.length - selectedLogicalOmissions.length),
            omissionsTotal: logical.omissions.length + logical.omissionsOmitted,
            omissionsOmitted: logical.omissionsOmitted + Math.max(0, logical.omissions.length - keptLogicalOmissions.length),
            omissionReasonCounts: logicalOmissionReasonCounts,
            omissionsTruncated: logical.omissionsTruncated,
            limits: logical.limits,
            relationCoverage: logical.relationCoverage,
            runtimeCallCoverage: logical.runtimeCallCoverage,
          }
        : null,
    },
    candidates: {
      files: [...selectedFileFacts, ...otherFileFacts].map((file) => ({
        id: file.id,
        path: file.path,
        evidence: file.evidence,
        symbolCount: file.symbols.length,
        symbolCatalogueTotal: file.symbolCatalogueTotal,
        symbolCatalogueOffered: file.symbolCatalogueOffered,
        symbolCatalogueOmitted: file.symbolCatalogueOmitted,
        symbolCatalogueTruncatedNames: file.symbolCatalogueTruncatedNames,
        symbolCatalogueIncomplete: file.symbolCatalogueIncomplete,
        symbolPages: file.symbolPages,
        symbolTruncated: file.symbolTruncated,
      })),
      filesTotal: result.candidates.files.length,
      filesOmitted: Math.max(0, result.candidates.files.length - selectedFileFacts.length - otherFileFacts.length),
      hits: [...selectedHits, ...otherHits].map((hit) => ({
        id: hit.id,
        path: hit.path,
        lineStart: hit.lineStart,
        lineEnd: hit.lineEnd,
        symbol: hit.symbol,
        language: hit.language,
        contentHash: hit.contentHash,
        profileId: hit.profileId,
        score: hit.score,
        ranking: hit.ranking,
      })),
      hitsTotal: result.candidates.hits.length,
      hitsOmitted: Math.max(0, result.candidates.hits.length - selectedHits.length - otherHits.length),
      graphState: result.candidates.graphState,
      graph: graph
        ? {
            identity: graph.identity,
            requestedDepth: graph.requestedDepth,
            reachedDepth: graph.reachedDepth,
            seeds: graph.seeds,
            limits: graph.limits,
            nodes: [...selectedNodes, ...otherNodes],
            nodesTotal: graph.nodes.length,
            nodesOmitted: Math.max(0, graph.nodes.length - selectedNodes.length - otherNodes.length),
            edges: [...selectedEdges, ...otherEdges],
            edgesTotal: graph.edges.length,
            edgesOmitted: Math.max(0, graph.edges.length - selectedEdges.length - otherEdges.length),
          }
        : null,
    },
    duplicates: result.duplicates.state === 'available'
      ? {
          state: 'available' as const,
          scope: compactDuplicateScope,
          scopeTotal: result.duplicates.scope.length,
          scopeOmitted: duplicateScopeOmitted,
          supportedLanguages: result.duplicates.result.supportedLanguages,
          counts: result.duplicates.result.counts,
          truncation: result.duplicates.result.truncation,
          groups: result.duplicates.result.groups.slice(0, MAX_DUPLICATE_GROUPS).map((group) => ({
            matchKind: group.matchKind,
            occurrenceCount: group.occurrenceCount,
            tokenCount: group.tokenCount,
            occurrences: [
              ...group.occurrences.filter((occurrence) => selectedFiles.has(occurrence.path)),
              ...group.occurrences.filter((occurrence) => !selectedFiles.has(occurrence.path)).slice(0, MAX_DUPLICATE_OCCURRENCES),
            ],
            occurrencesOmitted: Math.max(0, group.occurrenceCount - group.occurrences.filter((occurrence) => selectedFiles.has(occurrence.path)).length -
              group.occurrences.filter((occurrence) => !selectedFiles.has(occurrence.path)).slice(0, MAX_DUPLICATE_OCCURRENCES).length),
          })),
          groupsTotal: result.duplicates.result.groups.length,
          groupsOmitted: Math.max(0, result.duplicates.result.groups.length - MAX_DUPLICATE_GROUPS),
        }
      : {
          state: result.duplicates.state,
          scope: compactDuplicateScope,
          scopeTotal: result.duplicates.scope.length,
          scopeOmitted: duplicateScopeOmitted,
          reason: result.duplicates.reason,
        },
  }
}

function readSourceRequests(rootId: string, snapshotId: string, path: string, lineStart: number, lineEnd: number) {
  const requests: Array<{ rootId: string; path: string; lineStart: number; lineEnd: number; snapshotId: string }> = []
  for (let start = lineStart; start <= lineEnd; start += 200) {
    requests.push({ rootId, path, lineStart: start, lineEnd: Math.min(lineEnd, start + 199), snapshotId })
  }
  return requests
}
