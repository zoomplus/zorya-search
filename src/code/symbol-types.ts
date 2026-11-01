/** Внутренние версионируемые DTO детерминированного извлечения символов. */
export const CODE_SYMBOL_EXTRACTOR_VERSION = 'ts-symbol-graph-v1'

export interface VerifiedSymbolSource {
  path: string
  text: string
  hash: string
}

export interface SymbolSnapshot {
  root: string
  snapshotId: string
}

export interface SymbolLocation {
  path: string
  start: number
  end: number
  lineStart: number
  lineEnd: number
  fileHash: string
}
export type SymbolKind = 'class' | 'interface' | 'type' | 'enum' | 'function' | 'method' | 'constructor' | 'callable' | 'namespace' | 'module-init'
export type SymbolTargetKind = 'concrete' | 'contract' | 'external' | 'unresolved'
export type SymbolUnresolvedReason = 'dynamic' | 'external' | 'ambiguous' | 'unresolved' | null
export type SymbolLanguage = 'typescript' | 'javascript' | 'unsupported'
export type SymbolFileStatus = 'parsed' | 'parse-error' | 'unsupported' | 'truncated' | 'error'

export interface CodeSymbol {
  id: string
  name: string
  qualifiedName: string
  kind: SymbolKind
  location: SymbolLocation
  parentId: string | null
  container: string | null
  signature: string
  signatureTruncated: boolean
  contract: boolean
  synthetic: boolean
  overloadGroupId: string | null
}
export type ReferenceKind = 'reference' | 'call' | 'construct' | 'export'
export interface CodeSymbolReference {
  id: string
  kind: ReferenceKind
  from: SymbolLocation
  ownerSymbolId: string | null
  targetSymbolIds: string[]
  targetKind: SymbolTargetKind
  unresolvedReason: SymbolUnresolvedReason
}
export interface SymbolFileCoverage {
  path: string
  language: SymbolLanguage
  status: SymbolFileStatus
  symbols: number
  references: number
  diagnostics: string[]
}
export interface SymbolExtractionResult {
  version: typeof CODE_SYMBOL_EXTRACTOR_VERSION
  identity: SymbolSnapshot
  symbols: CodeSymbol[]
  references: CodeSymbolReference[]
  files: SymbolFileCoverage[]
  complete: boolean
  truncation: SymbolTruncation
}

export interface SymbolTruncation {
  symbols: boolean
  references: boolean
  files: boolean
}
export interface SymbolExtractionOptions {
  signal: AbortSignal
  maxFiles?: number
  maxSymbols?: number
  maxReferences?: number
  tsconfigPath?: string
}
