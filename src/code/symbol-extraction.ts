import { createHash } from 'node:crypto'
import { isAbsolute, posix, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { compileVerifiedSymbolSources, sourceScriptKind } from './symbol-compiler.js'
import { CODE_SYMBOL_EXTRACTOR_VERSION } from './symbol-types.js'
import type { CodeSymbol, CodeSymbolReference, SymbolExtractionOptions, SymbolExtractionResult, SymbolFileCoverage, SymbolKind, SymbolLocation, VerifiedSymbolSource } from './symbol-types.js'

const yieldTurn = () => new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function namedDeclaration(node: ts.Node): node is ts.NamedDeclaration { return 'name' in node && Boolean((node as ts.NamedDeclaration).name) }
function displayName(node: ts.Node, source: ts.SourceFile): string {
  if (namedDeclaration(node)) {
    const name = node.name!
    return ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
      ? name.text : name.getText(source)
  }
  return ts.isConstructorDeclaration(node) ? 'constructor' : '<anonymous>'
}
function kindOf(node: ts.Node): SymbolKind | null {
  if (ts.isClassDeclaration(node)) return 'class'
  if (ts.isInterfaceDeclaration(node)) return 'interface'
  if (ts.isTypeAliasDeclaration(node)) return 'type'
  if (ts.isEnumDeclaration(node)) return 'enum'
  if (ts.isFunctionDeclaration(node)) return 'function'
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return 'method'
  if (ts.isConstructorDeclaration(node)) return 'constructor'
  if (ts.isModuleDeclaration(node)) return 'namespace'
  return null
}
function isCallableInitializer(node: ts.Expression | undefined): node is ts.ArrowFunction | ts.FunctionExpression {
  return Boolean(node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)))
}
function makeLocation(path: string, source: ts.SourceFile, fileHash: string, node: ts.Node): SymbolLocation {
  const start = node.getStart(source)
  const end = node.getEnd()
  return { path, start, end, lineStart: source.getLineAndCharacterOfPosition(start).line + 1, lineEnd: source.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line + 1, fileHash }
}
function idFor(snapshot: string, path: string, start: number, end: number, kind: string): string {
  return hash(`${CODE_SYMBOL_EXTRACTOR_VERSION}\0${snapshot}\0${path}\0${start}\0${end}\0${kind}`)
}
function callLike(node: ts.Node): node is ts.CallExpression | ts.NewExpression { return ts.isCallExpression(node) || ts.isNewExpression(node) }
function isContractDeclaration(node: ts.Node): boolean {
  if (node.getSourceFile().isDeclarationFile) return true
  if (
    ts.isInterfaceDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isTypeAliasDeclaration(node)
  ) return true
  if (ts.canHaveModifiers(node)) {
    const flags = ts.getModifiers(node) ?? []
    if (flags.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword || modifier.kind === ts.SyntaxKind.AbstractKeyword)) return true
  }
  return (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) && !node.body
}
function boundedLimit(name: string, value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > maximum)
    throw new RangeError(`${name} must be a finite integer from 0 to ${maximum}`)
  return value
}

/** Извлекает ограниченные статические факты из закрытого проверенного снимка исходников. */
export async function extractCodeSymbols(
  sources: readonly VerifiedSymbolSource[], identity: { root: string; snapshotId: string }, options: SymbolExtractionOptions,
): Promise<SymbolExtractionResult> {
  const maxFiles = boundedLimit('maxFiles', options.maxFiles, 100_000, 100_000)
  const maxSymbols = boundedLimit('maxSymbols', options.maxSymbols, 100_000, 100_000)
  const maxReferences = boundedLimit('maxReferences', options.maxReferences, 500_000, 500_000)
  const files: SymbolFileCoverage[] = []
  const symbols: CodeSymbol[] = []
  const references: CodeSymbolReference[] = []
  const truncation = { symbols: false, references: false, files: false }
  const root = resolve(identity.root)
  const sourceByPathInput = new Map<string, VerifiedSymbolSource>()
  for (const source of sources) {
    const logical = source.path.replaceAll('\\', '/')
    const absolute = resolve(root, logical)
    const rel = relative(root, absolute)
    if (!logical || logical.startsWith('/') || logical !== posix.normalize(logical) || logical.split('/').includes('..') || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Source path is not a canonical path under the verified root: ${source.path}`)
    if (sourceByPathInput.has(logical)) throw new Error(`Duplicate verified source path: ${logical}`)
    if (hash(source.text) !== source.hash) throw new Error(`Verified source hash mismatch: ${logical}`)
    sourceByPathInput.set(logical, { ...source, path: logical })
  }
  const orderedSources = [...sourceByPathInput.values()].sort((left, right) => left.path.localeCompare(right.path))
  const selected = orderedSources.slice(0, maxFiles)
  truncation.files = sources.length > selected.length
  const programResult = await compileVerifiedSymbolSources(
    identity.root,
    selected,
    options.tsconfigPath,
    options.signal,
    options.libraries,
  )
  const symbolIdByDeclaration = new Map<ts.Declaration, string>()
  const symbolIdByCheckerSymbol = new Map<ts.Symbol, string[]>()
  const sourceRecordByPath = new Map(selected.map((source) => [source.path, source]))
  const sourceByAbs = new Map([...programResult.sourceByPath].map(([path, source]) => [resolve(source.fileName), { path, source, hash: sourceRecordByPath.get(path)!.hash }]))
  const coverageByPath = new Map<string, SymbolFileCoverage>()
  const symbolById = new Map<string, CodeSymbol>()
  const publishedSymbolIds = new Set<string>()
  const nodeOwners = new WeakMap<ts.Node, string>()
  const overloadGroups = new Map<string, string>()
  let visited = 0
  let failed = false

  for (const [path, source] of programResult.sourceByPath) {
    options.signal.throwIfAborted()
    const supplied = sourceRecordByPath.get(path)!
    const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []
    files.push({ path, language: path.toLowerCase().endsWith('.js') || /\.(?:jsx|mjs|cjs)$/iu.test(path) ? 'javascript' : 'typescript', status: diagnostics.length ? 'parse-error' : 'parsed', symbols: 0, references: 0, diagnostics: diagnostics.slice(0, 20).map((item) => ts.flattenDiagnosticMessageText(item.messageText, ' ')) })
    const coverage = files.at(-1)!
    coverageByPath.set(path, coverage)
    if (diagnostics.length) continue
    const moduleId = idFor(identity.snapshotId, path, 0, source.text.length, 'module-init')
    const moduleSymbol: CodeSymbol = {
      id: moduleId, name: '<module-init>', qualifiedName: '<module-init>', kind: 'module-init',
      location: makeLocation(path, source, supplied.hash, source), parentId: null, container: null,
      signature: '', signatureTruncated: false, contract: false, synthetic: true, overloadGroupId: null,
    }
    if (symbols.length < maxSymbols) {
      symbols.push(moduleSymbol)
      publishedSymbolIds.add(moduleSymbol.id)
      coverage.symbols++
    } else {
      truncation.symbols = true
      coverage.status = 'truncated'
    }
    const addSymbol = (node: ts.Node, kind: SymbolKind, parentId: string | null, parentName: string | null, forcedName?: string) => {
      if (symbols.length >= maxSymbols) { truncation.symbols = true; coverage.status = 'truncated'; return null }
      const name = forcedName ?? displayName(node, source)
      const start = node.getStart(source)
      const end = node.getEnd()
      const qualifiedName = parentName ? `${parentName}.${name}` : name
      const overloadKey = `${path}\0${qualifiedName}\0${kind}`
      const existingOverloadGroupId = kind === 'function' || kind === 'method' ? overloadGroups.get(overloadKey) : undefined
      const symbol: CodeSymbol = {
        id: idFor(identity.snapshotId, path, start, end, kind), name, qualifiedName, kind,
        location: makeLocation(path, source, supplied.hash, node),
        parentId: parentId && publishedSymbolIds.has(parentId) ? parentId : null,
        container: parentName,
        signature: source.text.slice(start, Math.min(end, start + 500)), signatureTruncated: end - start > 500,
        contract: isContractDeclaration(node),
        synthetic: kind === 'module-init', overloadGroupId: existingOverloadGroupId ?? null,
      }
      symbols.push(symbol)
      publishedSymbolIds.add(symbol.id)
      symbolIdByDeclaration.set(node as ts.Declaration, symbol.id)
      symbolById.set(symbol.id, symbol)
      if (kind === 'function' || kind === 'method') {
        if (existingOverloadGroupId) {
          symbol.overloadGroupId = existingOverloadGroupId
          const first = symbolById.get(existingOverloadGroupId)
          if (first) first.overloadGroupId = existingOverloadGroupId
        } else overloadGroups.set(overloadKey, symbol.id)
      }
      const checkerSymbol = namedDeclaration(node) ? programResult.checker.getSymbolAtLocation(node.name!) : undefined
      if (checkerSymbol) {
        const ids = symbolIdByCheckerSymbol.get(checkerSymbol)
        if (ids) ids.push(symbol.id)
        else symbolIdByCheckerSymbol.set(checkerSymbol, [symbol.id])
      }
      nodeOwners.set(node, symbol.id)
      coverage.symbols++
      return symbol
    }
    const walk = async (node: ts.Node, ownerId: string | null, ownerName: string | null): Promise<void> => {
      if (++visited % 256 === 0) { options.signal.throwIfAborted(); await yieldTurn() }
      let nextOwner = ownerId
      let nextName = ownerName
      const kind = kindOf(node)
      let symbol: CodeSymbol | null = null
      if (kind) symbol = addSymbol(node, kind, ownerId, ownerName)
      else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        (isCallableInitializer(node.initializer) ||
          programResult.checker.getTypeAtLocation(node.name).getCallSignatures().length > 0)
      ) {
        symbol = addSymbol(node, 'callable', ownerId, ownerName, node.name.text)
      } else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !ts.isVariableDeclaration(node.parent)) {
        symbol = addSymbol(node, 'callable', ownerId, ownerName, '<anonymous>')
      }
      if (symbol) { nextOwner = symbol.id; nextName = symbol.qualifiedName }
      nodeOwners.set(node, nextOwner ?? '')
      const children: ts.Node[] = []
      ts.forEachChild(node, (child) => { children.push(child) })
      for (const child of children) await walk(child, nextOwner, nextName)
    }
    try { await walk(source, moduleId, null) } catch (error) {
      if (options.signal.aborted) throw error
      failed = true; coverage.status = 'error'; coverage.diagnostics.push(error instanceof Error ? error.message : 'symbol traversal failed')
    }
    if (coverage.status === 'parsed' && !source.statements.length && source.text.trim()) coverage.status = 'parse-error'
    await yieldTurn()
  }

  const declarationId = (declaration: ts.Declaration): string | null => {
    const direct = symbolIdByDeclaration.get(declaration)
    if (direct) return direct
    const symbol = namedDeclaration(declaration) ? programResult.checker.getSymbolAtLocation(declaration.name!) : undefined
    return symbol ? symbolIdByCheckerSymbol.get(symbol)?.[0] ?? null : null
  }
  for (const [absolute, entry] of sourceByAbs) {
    options.signal.throwIfAborted()
    const { path, source, hash: fileHash } = entry
    const coverage = coverageByPath.get(path)!
    if (coverage.status === 'parse-error' || coverage.status === 'error') continue
    const addReference = (node: ts.Node, kind: CodeSymbolReference['kind'], ownerId: string | null, target: ts.Symbol | undefined, directTargetId?: string, forcedDynamic = false): void => {
      let targetIds: string[] = directTargetId ? [directTargetId] : []
      let unresolvedReason: CodeSymbolReference['unresolvedReason'] = forcedDynamic ? 'dynamic' : null
      let targetKind: CodeSymbolReference['targetKind'] = 'unresolved'
      if (!target && !forcedDynamic) target = programResult.checker.getSymbolAtLocation(node)
      if (target && !targetIds.length) {
        let actual = target
        if (actual.flags & ts.SymbolFlags.Alias) {
          try {
            actual = programResult.checker.getAliasedSymbol(actual)
          } catch {
            // Циклический alias остаётся неразрешённым ребром.
          }
        }
        targetIds = symbolIdByCheckerSymbol.get(actual) ?? []
        if (!targetIds.length) targetIds = (actual.declarations ?? []).map(declarationId).filter((id): id is string => Boolean(id))
      }
      const publishedTargetIds = [...new Set(targetIds.filter((id) => publishedSymbolIds.has(id)))]
      if (publishedTargetIds.length) {
        targetKind = publishedTargetIds.every((id) => symbolById.get(id)?.contract) ? 'contract' : 'concrete'
        if (publishedTargetIds.length > 1) unresolvedReason = 'ambiguous'
      } else if (targetIds.length) {
        targetKind = 'unresolved'
        unresolvedReason = 'unresolved'
      } else if (forcedDynamic) targetKind = 'unresolved'
      else if (target && target.declarations?.some((declaration) => !programResult.fileByAbsolutePath.has(resolve(declaration.getSourceFile().fileName)))) {
        targetKind = 'external'; unresolvedReason = 'external'
      } else if (!target) { targetKind = 'unresolved'; unresolvedReason = 'unresolved' }
      if (references.length >= maxReferences) { truncation.references = true; coverage.status = 'truncated'; return }
      const location = makeLocation(path, source, fileHash, node)
      references.push({
        id: hash(`${CODE_SYMBOL_EXTRACTOR_VERSION}\0${identity.snapshotId}\0${programResult.libraryProfileId ?? 'no-lib'}\0${programResult.compilerOptionsHash}\0${path}\0${location.start}\0${location.end}\0${kind}`),
        kind,
        from: location,
        ownerSymbolId: ownerId && publishedSymbolIds.has(ownerId) ? ownerId : null,
        targetSymbolIds: publishedTargetIds,
        targetKind,
        unresolvedReason,
      })
      coverage.references++
    }
    const walkReferences = async (node: ts.Node, ownerId: string | null): Promise<void> => {
      if (++visited % 256 === 0) { options.signal.throwIfAborted(); await yieldTurn() }
      const directOwner = nodeOwners.get(node)
      const currentOwner = directOwner === undefined ? ownerId : directOwner || null
      if (callLike(node)) {
        const signature = programResult.checker.getResolvedSignature(node)
        const declaration = signature?.getDeclaration()
        const directId = declaration ? declarationId(declaration) ?? undefined : undefined
        const target = declaration ? programResult.checker.getSymbolAtLocation(namedDeclaration(declaration) ? declaration.name! : declaration) : programResult.checker.getSymbolAtLocation(node.expression)
        const argument = ts.isElementAccessExpression(node.expression) ? node.expression.argumentExpression : undefined
        const dynamic = Boolean(
          (ts.isElementAccessExpression(node.expression) && argument && !ts.isStringLiteralLike(argument) && !ts.isNumericLiteral(argument)) ||
          (!declaration && !directId),
        )
        addReference(node.expression, ts.isNewExpression(node) ? 'construct' : 'call', currentOwner, target, directId, dynamic)
      } else if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
        const parent = node.parent
        const isName = namedDeclaration(parent) && parent.name === node
        const callCallee = callLike(parent) && parent.expression.getStart(source) <= node.getStart(source) && parent.expression.end >= node.end
        const memberCallee = callLike(parent.parent) && parent.parent.expression.getStart(source) <= node.getStart(source) && parent.parent.expression.end >= node.end
        if (!isName && !callCallee && !memberCallee) {
          const kind = ts.isExportSpecifier(parent) ? 'export' : 'reference'
          addReference(node, kind, currentOwner, programResult.checker.getSymbolAtLocation(node))
        }
      }
      const children: ts.Node[] = []
      ts.forEachChild(node, (child) => { children.push(child) })
      for (const child of children) await walkReferences(child, currentOwner)
    }
    try { await walkReferences(source, null) } catch (error) {
      if (options.signal.aborted) throw error
      failed = true; coverage.status = 'error'; coverage.diagnostics.push(error instanceof Error ? error.message : 'reference traversal failed')
    }
    void absolute
    await yieldTurn()
  }
  for (const source of selected) {
    if (sourceScriptKind(source.path) !== null) continue
    const coverage: SymbolFileCoverage = {
      path: source.path,
      language: 'unsupported',
      status: 'unsupported',
      symbols: 0,
      references: 0,
      diagnostics: ['unsupported source language'],
    }
    files.push(coverage)
    coverageByPath.set(source.path, coverage)
  }
  for (const diagnostic of programResult.program.getSyntacticDiagnostics()) {
    const source = diagnostic.file
    if (!source) { failed = true; continue }
    const logical = sourceByAbs.get(resolve(source.fileName))?.path
    const coverage = logical ? coverageByPath.get(logical) : undefined
    if (coverage) {
      coverage.status = 'parse-error'
      if (coverage.diagnostics.length < 20) coverage.diagnostics.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))
    }
  }
  for (const diagnostic of programResult.configDiagnostics) {
    if (files.length < maxFiles) {
      files.push({
        path: options.tsconfigPath ?? 'tsconfig.json',
        language: 'unsupported',
        status: 'error',
        symbols: 0,
        references: 0,
        diagnostics: [diagnostic],
      })
    } else if (files.length > 0) {
      const coverage = files[0]!
      coverage.status = 'error'
      if (coverage.diagnostics.length < 20) coverage.diagnostics.push(diagnostic)
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  const complete = !failed && !truncation.files && !truncation.symbols && !truncation.references && files.every((file) => file.status === 'parsed') && programResult.configDiagnostics.length === 0
  return {
    version: CODE_SYMBOL_EXTRACTOR_VERSION,
    identity: { root: resolve(identity.root), snapshotId: identity.snapshotId },
    symbols,
    references,
    files,
    complete,
    truncation,
    compiler: {
      typescriptVersion: programResult.typescriptVersion,
      compilerOptionsHash: programResult.compilerOptionsHash,
      libraryProfileId: programResult.libraryProfileId,
      libraryAssets: programResult.libraryAssets,
    },
  }
}
