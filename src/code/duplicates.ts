import ts from 'typescript'
import { resolve } from 'node:path'
import type { CodeDuplicateGroup, CodeDuplicateOccurrence } from './types.js'

export interface DuplicateSource {
  path: string
  text: string
  hash: string
}

export interface DuplicateOptions {
  matchMode: 'exact' | 'renamed'
  minTokens: number
  minOccurrences: number
  limit: number
  maxOccurrencesPerGroup: number
}

export interface DuplicateResult {
  groups: CodeDuplicateGroup[]
  parsed: number
  functions: number
  skippedParse: number
  skippedUnsupported: number
  eligibleGroupCount: number
  occurrenceTruncated: boolean
}

const extensions: Record<string, ts.ScriptKind> = {
  ts: ts.ScriptKind.TS,
  tsx: ts.ScriptKind.TSX,
  mts: ts.ScriptKind.TS,
  cts: ts.ScriptKind.TS,
  js: ts.ScriptKind.JS,
  jsx: ts.ScriptKind.JSX,
  mjs: ts.ScriptKind.JS,
  cjs: ts.ScriptKind.JS,
}
const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

export async function findDuplicateBodies(
  sources: DuplicateSource[],
  options: DuplicateOptions,
  signal: AbortSignal,
): Promise<DuplicateResult> {
  const files = new Map<string, { source: DuplicateSource; sf: ts.SourceFile }>()
  let skippedParse = 0
  let skippedUnsupported = 0
  for (const source of sources) {
    signal.throwIfAborted()
    const ext = source.path.toLowerCase().split('.').at(-1) ?? ''
    const kind = extensions[ext]
    if (kind === undefined) {
      skippedUnsupported++
      continue
    }
    const virtualPath = resolve(`/__zorya_search_virtual__/source-${files.size}.${ext}`)
    const sf = ts.createSourceFile(virtualPath, source.text, ts.ScriptTarget.Latest, true, kind)
    if ((sf as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length)
      skippedParse++
    else files.set(source.path, { source, sf })
    await yieldTurn()
  }
  const canonicalFiles = new Map(
    [...files.values()].map((entry) => [resolve(entry.sf.fileName), entry]),
  )
  // Checker видит только разрешённые прочитанные файлы и не загружает модули или библиотеки.
  const host = ts.createCompilerHost({
    allowJs: true,
    checkJs: false,
    noResolve: true,
    noLib: true,
    target: ts.ScriptTarget.Latest,
  })
  host.getSourceFile = (file) => canonicalFiles.get(resolve(file))?.sf
  host.fileExists = (file) => canonicalFiles.has(resolve(file))
  host.readFile = (file) => canonicalFiles.get(resolve(file))?.source.text
  host.readDirectory = () => []
  host.directoryExists = () => false
  host.realpath = (file) => file
  const program = ts.createProgram(
    [...canonicalFiles.keys()],
    { allowJs: true, noResolve: true, noLib: true, target: ts.ScriptTarget.Latest },
    host,
  )
  const checker = program.getTypeChecker()
  type Item = {
    exactKey: string
    renamedKey: string
    occurrence: CodeDuplicateOccurrence
  }
  const found: Item[] = []
  let visited = 0
  const add = async (
    sf: ts.SourceFile,
    node: ts.Node,
    body: ts.Node,
    name: string,
    kind: string,
    signature: string,
  ) => {
    const localSlots = new Map<ts.Symbol, number>()
    const normalized = new Map<number, string>()
    const bindings: Array<{
      declaration: ts.ParameterDeclaration | ts.VariableDeclaration
      symbol: ts.Symbol
    }> = []
    if (ts.isFunctionLike(node) && node.parameters) {
      for (const parameter of node.parameters) {
        if (!ts.isIdentifier(parameter.name)) continue
        const symbol = checker.getSymbolAtLocation(parameter.name)
        if (symbol) bindings.push({ declaration: parameter, symbol })
      }
    }
    const gatherVariables = async (part: ts.Node): Promise<void> => {
      if (++visited % 256 === 0) {
        signal.throwIfAborted()
        await yieldTurn()
      }
      if (part !== body && (ts.isFunctionLike(part) || ts.isClassLike(part))) return
      if (ts.isVariableDeclaration(part) && ts.isIdentifier(part.name)) {
        const symbol = checker.getSymbolAtLocation(part.name)
        if (symbol) bindings.push({ declaration: part, symbol })
      }
      for (const child of part.getChildren(sf)) await gatherVariables(child)
    }
    if (ts.isBlock(body)) await gatherVariables(body)
    bindings.sort(
      (left, right) =>
        Number(ts.isVariableDeclaration(left.declaration)) -
          Number(ts.isVariableDeclaration(right.declaration)) ||
        left.declaration.getStart(sf) - right.declaration.getStart(sf),
    )
    for (const binding of bindings) {
      if (!localSlots.has(binding.symbol)) localSlots.set(binding.symbol, localSlots.size)
    }
    const markLocals = async (part: ts.Node): Promise<void> => {
      if (++visited % 256 === 0) {
        signal.throwIfAborted()
        await yieldTurn()
      }
      if (ts.isIdentifier(part)) {
        const symbol = checker.getSymbolAtLocation(part)
        const shorthandKey =
          ts.isShorthandPropertyAssignment(part.parent) && part.parent.name === part
        if (symbol && !shorthandKey) {
          const isLocalBinding = (symbol.getDeclarations() ?? []).some((decl) => {
            if (
              decl.getSourceFile() !== sf ||
              decl.getStart(sf) < node.getStart(sf) ||
              decl.getEnd() > node.getEnd()
            )
              return false
            return (
              (ts.isParameter(decl) || ts.isVariableDeclaration(decl)) &&
              ts.isIdentifier(decl.name)
            )
          })
          if (
            isLocalBinding &&
            options.matchMode === 'renamed' &&
            localSlots.has(symbol)
          )
            normalized.set(part.getStart(sf), `LOCAL_${localSlots.get(symbol)}`)
        }
      }
      const children: ts.Node[] = []
      ts.forEachChild(part, (child) => {
        children.push(child)
      })
      for (const child of children) await markLocals(child)
    }
    await markLocals(body)
    const exact: string[] = []
    const renamed: string[] = []
    const leaves = async (part: ts.Node): Promise<void> => {
      if (++visited % 256 === 0) {
        signal.throwIfAborted()
        await yieldTurn()
      }
      const children = part.getChildren(sf)
      if (!children.length) {
        const text = sf.text.slice(part.getStart(sf), part.getEnd())
        if (!text) return
        const token = `${part.kind}:${text}`
        exact.push(token)
        renamed.push(normalized.get(part.getStart(sf)) ?? token)
      } else {
        for (const child of children) await leaves(child)
      }
    }
    await leaves(body)
    const isAsync =
      ts.canHaveModifiers(node) &&
      Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))
    const generator = 'asteriskToken' in node && Boolean(node.asteriskToken)
    const prefix = `${isAsync ? 'A' : 'S'}${generator ? 'G' : 'N'}${ts.isBlock(body) ? 'B' : 'E'}\0`
    const lineStart = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
    const lineEnd = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1
    const source = canonicalFiles.get(resolve(sf.fileName))!.source
    found.push({
      exactKey: prefix + exact.join('\u001f'),
      renamedKey: prefix + renamed.join('\u001f'),
      occurrence: {
        path: source.path,
        symbol: name,
        kind,
        lineStart,
        lineEnd,
        fileContentHash: source.hash,
        signature: signature.slice(0, 500),
        bodyTokenCount: exact.length,
      },
    })
  }
  for (const { sf } of files.values()) {
    signal.throwIfAborted()
    const visit = async (node: ts.Node): Promise<void> => {
      if (++visited % 256 === 0) {
        signal.throwIfAborted()
        await yieldTurn()
      }
      if (ts.isFunctionDeclaration(node) && node.body) {
        await add(
          sf,
          node,
          node.body,
          node.name?.text ?? '<anonymous>',
          'function',
          sf.text.slice(node.getStart(sf), node.body.getStart(sf)),
        )
      } else if (ts.isMethodDeclaration(node) && node.body) {
        await add(
          sf,
          node,
          node.body,
          node.name.getText(sf),
          'method',
          sf.text.slice(node.getStart(sf), node.body.getStart(sf)),
        )
      } else if (ts.isConstructorDeclaration(node) && node.body) {
        await add(
          sf,
          node,
          node.body,
          'constructor',
          'constructor',
          sf.text.slice(node.getStart(sf), node.body.getStart(sf)),
        )
      } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        const variableName =
          ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)
            ? node.parent.name.text
            : '<anonymous>'
        const bodyKind = ts.isBlock(node.body) ? 'block' : 'expression'
        const kind = ts.isArrowFunction(node)
          ? `arrow-${bodyKind}`
          : `function-expression-${bodyKind}`
        await add(
          sf,
          node,
          node.body,
          node.name?.text ?? variableName,
          kind,
          sf.text.slice(node.getStart(sf), node.body.getStart(sf)),
        )
      }
      for (const child of node.getChildren(sf)) await visit(child)
    }
    await visit(sf)
  }
  const grouped = new Map<string, Item[]>()
  for (const item of found) {
    const key = options.matchMode === 'exact' ? item.exactKey : item.renamedKey
    const rows = grouped.get(key) ?? []
    rows.push(item)
    grouped.set(key, rows)
  }
  const eligible = [...grouped.entries()]
    .filter(
      ([, rows]) =>
        rows.length >= options.minOccurrences &&
        rows[0]!.occurrence.bodyTokenCount >= options.minTokens,
    )
    .sort(
      (left, right) =>
        right[1][0]!.occurrence.bodyTokenCount * right[1].length -
          left[1][0]!.occurrence.bodyTokenCount * left[1].length ||
        left[0].localeCompare(right[0]),
    )
  const capped = eligible.slice(0, options.limit)
  let occurrenceTruncated = false
  const groups = capped.map(([key, rows]) => {
    const occurrences = rows
      .map((item) => item.occurrence)
      .sort((left, right) => left.path.localeCompare(right.path) || left.lineStart - right.lineStart)
    if (occurrences.length > options.maxOccurrencesPerGroup) occurrenceTruncated = true
    const exact = rows.every((item) => item.exactKey === rows[0]!.exactKey)
    return {
      matchKind: exact ? ('exact-token-body' as const) : ('renamed-local-body' as const),
      occurrences: occurrences.slice(0, options.maxOccurrencesPerGroup),
      occurrenceCount: occurrences.length,
      tokenCount: occurrences[0]!.bodyTokenCount,
    }
  })
  return {
    groups,
    parsed: files.size,
    functions: found.length,
    skippedParse,
    skippedUnsupported,
    eligibleGroupCount: eligible.length,
    occurrenceTruncated,
  }
}
