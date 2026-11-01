import { basename, extname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { createVerifiedSourceResolver } from './symbol-resolver.js'
import { validateTypeScriptLibraryBundle } from './symbol-libraries.js'
import type { TypeScriptLibraryBundle } from './symbol-libraries.js'
import type { VerifiedSymbolSource } from './symbol-types.js'

export interface VerifiedSymbolProgram {
  program: ts.Program
  checker: ts.TypeChecker
  sourceByPath: Map<string, ts.SourceFile>
  fileByAbsolutePath: Map<string, VerifiedSymbolSource>
  configDiagnostics: string[]
  typescriptVersion: string
  libraryProfileId: string | null
  libraryAssets: string[]
}
const kinds = new Map<string, ts.ScriptKind>([
  ['ts', ts.ScriptKind.TS],
  ['tsx', ts.ScriptKind.TSX],
  ['mts', ts.ScriptKind.TS],
  ['cts', ts.ScriptKind.TS],
  ['js', ts.ScriptKind.JS],
  ['jsx', ts.ScriptKind.JSX],
  ['mjs', ts.ScriptKind.JS],
  ['cjs', ts.ScriptKind.JS],
])
export function sourceScriptKind(path: string): ts.ScriptKind | null {
  const lower = path.toLowerCase()
  if (lower.endsWith('.d.ts')) return ts.ScriptKind.TS
  const extension = lower.split('.').at(-1) ?? ''
  return kinds.get(extension) ?? null
}
function virtualFilename(root: string, path: string): string {
  const absolute = resolve(root, '__verified_virtual__', createHash('sha256').update(path).digest('hex').slice(0, 20), basename(path))
  const ext = extname(absolute)
  return ext ? `${absolute.slice(0, -ext.length)}${ext.toLowerCase()}` : absolute
}
function virtualLibraryFilename(root: string, name: string): string {
  return resolve(root, '__verified_typescript_lib__', name)
}
function tsExtension(path: string): ts.Extension {
  const lower = path.toLowerCase()
  if (lower.endsWith('.d.ts')) return ts.Extension.Dts
  if (lower.endsWith('.tsx')) return ts.Extension.Tsx
  if (lower.endsWith('.mts')) return ts.Extension.Mts
  if (lower.endsWith('.cts')) return ts.Extension.Cts
  if (lower.endsWith('.jsx')) return ts.Extension.Jsx
  if (lower.endsWith('.mjs')) return ts.Extension.Mjs
  if (lower.endsWith('.cjs')) return ts.Extension.Cjs
  if (lower.endsWith('.js')) return ts.Extension.Js
  return ts.Extension.Ts
}

/** Компилирует программу только из закрытого набора уже проверенных файлов. */
export async function compileVerifiedSymbolSources(
  rootInput: string,
  sources: readonly VerifiedSymbolSource[],
  tsconfigPath?: string,
  signal?: AbortSignal,
  libraries?: TypeScriptLibraryBundle,
): Promise<VerifiedSymbolProgram> {
  const root = resolve(rootInput)
  signal?.throwIfAborted()
  if (libraries) validateTypeScriptLibraryBundle(libraries, signal)
  const resolver = createVerifiedSourceResolver(root, sources, tsconfigPath)
  const sourceByPath = new Map<string, ts.SourceFile>()
  const fileByAbsolutePath = new Map<string, VerifiedSymbolSource>()
  const librarySourceByAbsolutePath = new Map<string, ts.SourceFile>()
  let parsedCount = 0
  for (const source of sources) {
    signal?.throwIfAborted()
    const kind = sourceScriptKind(source.path)
    if (kind === null) continue
    const absolute = virtualFilename(root, source.path)
    const sourceFile = ts.createSourceFile(absolute, source.text, ts.ScriptTarget.Latest, true, kind)
    sourceByPath.set(source.path, sourceFile)
    fileByAbsolutePath.set(absolute, source)
    if (++parsedCount % 32 === 0) await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
  }
  if (libraries) {
    for (const asset of libraries.assets) {
      signal?.throwIfAborted()
      const absolute = virtualLibraryFilename(root, asset.name)
      const sourceFile = ts.createSourceFile(absolute, asset.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
      if (parseDiagnostics.length > 0)
        throw new TypeError(`Malformed TypeScript library declaration: ${asset.name}`)
      librarySourceByAbsolutePath.set(absolute, sourceFile)
      if (++parsedCount % 32 === 0) await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
    }
  }
  const options: ts.CompilerOptions = {
    ...resolver.compilerOptions, allowJs: true, checkJs: true, noResolve: false,
    noLib: true, noEmit: true, skipLibCheck: true, types: [],
  }
  const host = ts.createCompilerHost(options, true)
  const getVerifiedSourceFile: ts.CompilerHost['getSourceFile'] = (fileName, _languageVersion, onError) => {
    const absolute = resolve(fileName)
    const result = librarySourceByAbsolutePath.get(absolute) ??
      sourceByPath.get(fileByAbsolutePath.get(absolute)?.path ?? '')
    if (!result) onError?.(`Source is outside verified map: ${fileName}`)
    return result
  }
  host.getSourceFile = getVerifiedSourceFile
  host.getSourceFileByPath = (fileName, _path, _languageVersion, onError) => getVerifiedSourceFile(fileName, _languageVersion, onError)
  host.fileExists = (fileName) => {
    const absolute = resolve(fileName)
    return fileByAbsolutePath.has(absolute) || librarySourceByAbsolutePath.has(absolute)
  }
  host.readFile = (fileName) => {
    const absolute = resolve(fileName)
    return fileByAbsolutePath.get(absolute)?.text ?? librarySourceByAbsolutePath.get(absolute)?.text
  }
  host.readDirectory = () => []
  host.getDirectories = () => []
  host.useCaseSensitiveFileNames = () => true
  host.realpath = (fileName) => resolve(fileName)
  host.getCurrentDirectory = () => root
  host.getDefaultLibFileName = () => resolve(root, '__verified_sources_only_no_default_lib__.d.ts')
  const virtualLibraryDirectory = resolve(root, '__verified_typescript_lib__')
  host.getDefaultLibLocation = () => libraries ? virtualLibraryDirectory : resolve(root, '__verified_no_library_directory__')
  host.directoryExists = (directory) => Boolean(libraries) && resolve(directory) === virtualLibraryDirectory
  host.resolveModuleNames = (moduleNames, containingFile) => {
    const source = fileByAbsolutePath.get(resolve(containingFile))
    if (!source) return moduleNames.map(() => undefined)
    return moduleNames.map((specifier) => {
      const logical = resolver.resolve(source.path, specifier)
      if (!logical) return undefined
      const target = fileByAbsolutePath.get(virtualFilename(root, logical))
      return target
        ? {
            resolvedFileName: virtualFilename(root, logical),
            extension: tsExtension(target.path),
            isExternalLibraryImport: false,
          }
        : undefined
    })
  }
  host.resolveTypeReferenceDirectives = (typeReferenceNames) =>
    typeReferenceNames.map(() => undefined)
  const roots = [...fileByAbsolutePath.keys(), ...librarySourceByAbsolutePath.keys()].sort()
  signal?.throwIfAborted()
  const program = ts.createProgram({ rootNames: roots, options, host })
  signal?.throwIfAborted()
  return {
    program,
    checker: program.getTypeChecker(),
    sourceByPath,
    fileByAbsolutePath,
    configDiagnostics: resolver.diagnostics,
    typescriptVersion: ts.version,
    libraryProfileId: libraries?.profileId ?? null,
    libraryAssets: libraries?.assets.map((asset) => asset.name) ?? [],
  }
}
