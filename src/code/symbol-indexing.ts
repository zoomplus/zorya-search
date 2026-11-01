import type { EnumeratedFile } from './enumerate.js'
import { extractCodeSymbols } from './symbol-extraction.js'
import { loadTypeScriptLibraryBundle } from './symbol-libraries.js'
import type { SymbolExtractionResult } from './symbol-types.js'
import type { CodeSymbolAnalysisProfile } from './symbol-api.js'
import { DEFAULT_SYMBOL_LIMITS, symbolProfile, type SymbolAnalysisLimits } from './symbol-storage.js'

export const HARD_SYMBOL_LIMITS = Object.freeze({ maxFiles: 20_000, maxSymbols: 500_000, maxReferences: 2_000_000 })

export async function prepareSymbolAnalysis(
  root: string,
  snapshotId: string,
  files: readonly EnumeratedFile[],
  signal: AbortSignal,
  limits: SymbolAnalysisLimits = DEFAULT_SYMBOL_LIMITS,
): Promise<{ result: SymbolExtractionResult; profile: CodeSymbolAnalysisProfile }> {
  signal.throwIfAborted()
  const libraries = await loadTypeScriptLibraryBundle({ signal, selector: 'es2023' })
  const result = await extractCodeSymbols(
    files.map(({ path, text, hash }) => ({ path, text, hash })),
    { root, snapshotId },
    { signal, maxFiles: limits.maxFiles, maxSymbols: limits.maxSymbols,
      maxReferences: limits.maxReferences, ...(limits.tsconfigPath ? { tsconfigPath: limits.tsconfigPath } : {}), libraries },
  )
  signal.throwIfAborted()
  return { result, profile: symbolProfile(result, limits) }
}
