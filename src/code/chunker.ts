import { createHash } from 'node:crypto'
import { dirname, extname, posix, relative, resolve } from 'node:path'
import ts from 'typescript'
import type { CodeChunk } from './types.js'
import type { EnumeratedFile } from './enumerate.js'

export const CODE_CHUNKER_VERSION = 'ts-ast-symbol-v1'
export const CODE_PARSER_VERSION = 'typescript-5.9-ast-v1'
const tsExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'])

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
function language(path: string): string {
  const ext = extname(path).toLowerCase().slice(1)
  return ext || 'text'
}
function tokenName(node: ts.Node): string | null {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)) &&
    node.name
  )
    return node.name.text
  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations[0]
    if (declaration && ts.isIdentifier(declaration.name)) return declaration.name.text
  }
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isPropertyDeclaration(node))
    return ts.isIdentifier(node.name) ? node.name.text : null
  return null
}

function makeChunk(
  file: EnumeratedFile,
  source: ts.SourceFile | null,
  range: { start: number; end: number },
  symbol: string | null,
  ordinal: number,
  maxChars: number,
): CodeChunk[] {
  const result: CodeChunk[] = []
  const sourceFile = source
  let cursor = range.start
  let part = 0
  while (cursor < range.end) {
    let end = Math.min(range.end, cursor + maxChars)
    if (end < range.end) {
      const newline = file.text.lastIndexOf('\n', end - 1)
      if (newline >= cursor + Math.floor(maxChars * 0.6)) end = newline + 1
    }
    const text = file.text.slice(cursor, end)
    const startLine = sourceFile
      ? sourceFile.getLineAndCharacterOfPosition(cursor).line
      : file.text.slice(0, cursor).split('\n').length - 1
    const endLine = sourceFile
      ? sourceFile.getLineAndCharacterOfPosition(Math.max(cursor, end - 1)).line
      : file.text.slice(0, Math.max(cursor, end - 1)).split('\n').length - 1
    const contentHash = digest(text)
    const symbolPart = part ? `${symbol ?? 'file'}#${part + 1}` : symbol
    const idKey = symbolPart ?? `anonymous:${ordinal}:${part}`
    const id = digest(`${file.path}\0${idKey}\0${contentHash}`)
    result.push({
      id,
      path: file.path,
      lineStart: startLine + 1,
      lineEnd: endLine + 1,
      symbol: symbolPart,
      language: language(file.path),
      text,
      contentHash,
      parserVersion: CODE_PARSER_VERSION,
    })
    cursor = end
    part++
  }
  return result
}

export function chunkCode(
  file: EnumeratedFile,
  maxChars: number,
): { chunks: CodeChunk[]; imports: string[] } {
  if (!tsExtensions.has(extname(file.path).toLowerCase())) {
    const chunk = makeChunk(file, null, { start: 0, end: file.text.length }, null, 0, maxChars)
    return { chunks: chunk, imports: [] }
  }
  const scriptKind =
    file.path.endsWith('.tsx') || file.path.endsWith('.jsx')
      ? ts.ScriptKind.TSX
      : file.path.endsWith('.js') ||
          file.path.endsWith('.mjs') ||
          file.path.endsWith('.cjs') ||
          file.path.endsWith('.jsx')
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, scriptKind)
  const chunks: CodeChunk[] = []
  const imports: string[] = []
  let ordinal = 0
  const symbolCounts = new Map<string, number>()
  for (const statement of source.statements) {
    const name = tokenName(statement)
    const occurrence = name ? (symbolCounts.get(name) ?? 0) + 1 : ordinal + 1
    if (name) symbolCounts.set(name, occurrence)
    const symbol = name && occurrence > 1 ? `${name}@${occurrence}` : name
    const start = statement.getFullStart()
    const end = statement.end
    chunks.push(...makeChunk(file, source, { start, end }, symbol, ordinal++, maxChars))
    const collectMethods = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
        const methodName = tokenName(node)
        if (methodName) {
          const qualified = `${symbol ?? 'type'}.${methodName}`
          const methodOccurrence = (symbolCounts.get(qualified) ?? 0) + 1
          symbolCounts.set(qualified, methodOccurrence)
          chunks.push(
            ...makeChunk(
              file,
              source,
              { start: node.getFullStart(), end: node.end },
              methodOccurrence > 1 ? `${qualified}@${methodOccurrence}` : qualified,
              ordinal++,
              maxChars,
            ),
          )
        }
      }
      ts.forEachChild(node, collectMethods)
    }
    collectMethods(statement)
  }
  const finalStatementEnd = source.statements.at(-1)?.end ?? 0
  if (finalStatementEnd < file.text.length)
    chunks.push(
      ...makeChunk(
        file,
        source,
        { start: finalStatementEnd, end: file.text.length },
        'file-tail',
        ordinal++,
        maxChars,
      ),
    )
  if (chunks.length === 0 || source.statements[0]?.getStart(source) !== 0) {
    const firstEnd = source.statements[0]?.getFullStart() ?? file.text.length
    if (firstEnd > 0)
      chunks.unshift(
        ...makeChunk(file, source, { start: 0, end: firstEnd }, 'file-preamble', -1, maxChars),
      )
  }
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
      imports.push(node.moduleSpecifier.text)
    else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      imports.push(node.moduleSpecifier.text)
    else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    )
      imports.push(node.arguments[0]!.text)
    else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    )
      imports.push(node.arguments[0]!.text)
    ts.forEachChild(node, walk)
  }
  walk(source)
  return { chunks, imports: [...new Set(imports)] }
}

export type LocalImportResolver = (fromPath: string, specifier: string) => string | null

export function createLocalImportResolver(
  root: string,
  knownPaths: Set<string>,
  contents: Map<string, string>,
  paths?: Record<string, string[]>,
  baseUrl = '.',
): LocalImportResolver {
  const canonicalPath = (path: string) =>
    process.platform === 'win32' ? resolve(path).toLocaleLowerCase() : resolve(path)
  const pathByAbsolute = new Map<string, string>()
  const directories = new Set<string>()
  const rootAbsolute = resolve(root)
  const canonicalRoot = canonicalPath(rootAbsolute)
  for (const knownPath of knownPaths) {
    const absolutePath = resolve(rootAbsolute, knownPath)
    pathByAbsolute.set(canonicalPath(absolutePath), knownPath)
    let directory = dirname(absolutePath)
    while (true) {
      const canonicalDirectory = canonicalPath(directory)
      directories.add(canonicalDirectory)
      if (canonicalDirectory === canonicalRoot) break
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  const compilerOptions: ts.CompilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    module: ts.ModuleKind.NodeNext,
    allowJs: true,
    baseUrl: resolve(rootAbsolute, baseUrl),
    ...(paths ? { paths } : {}),
  }
  const resolutionCache = ts.createModuleResolutionCache(
    rootAbsolute,
    canonicalPath,
    compilerOptions,
  )
  const host: ts.ModuleResolutionHost = {
    fileExists: (path) => pathByAbsolute.has(canonicalPath(path)),
    readFile: (path) => {
      const logicalPath = pathByAbsolute.get(canonicalPath(path))
      return logicalPath === undefined ? undefined : contents.get(logicalPath)
    },
    directoryExists: (path) => directories.has(canonicalPath(path)),
    getCurrentDirectory: () => rootAbsolute,
    realpath: (path) => resolve(path),
  }
  return (fromPath, specifier) => {
    const resolved = ts.resolveModuleName(
      specifier,
      resolve(rootAbsolute, fromPath),
      compilerOptions,
      host,
      resolutionCache,
    ).resolvedModule?.resolvedFileName
    if (resolved) {
      const relativePath = relative(rootAbsolute, resolve(resolved)).split('\\').join('/')
      if (knownPaths.has(relativePath) && !relativePath.startsWith('../')) return relativePath
    }
    if (!specifier.startsWith('.')) return null
    const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier))
    const candidates = [
      base,
      ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'].map(
        (ext) => `${base}${ext}`,
      ),
      ...['index.ts', 'index.tsx', 'index.js', 'index.jsx'].map((name) => posix.join(base, name)),
    ]
    // В исходниках TypeScript спецификатор .js может указывать на соответствующий файл .ts.
    const stripped = base.replace(/\.(?:mjs|cjs|js|jsx)$/u, '')
    candidates.push(...['.ts', '.tsx', '.mts', '.cts'].map((ext) => `${stripped}${ext}`))
    return candidates.find((candidate) => knownPaths.has(candidate)) ?? null
  }
}

export function resolveLocalImport(
  root: string,
  fromPath: string,
  specifier: string,
  knownPaths: Set<string>,
  contents: Map<string, string>,
  paths?: Record<string, string[]>,
  baseUrl = '.',
): string | null {
  return createLocalImportResolver(root, knownPaths, contents, paths, baseUrl)(fromPath, specifier)
}
