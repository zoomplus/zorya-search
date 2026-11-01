import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import type { VerifiedSymbolSource } from './symbol-types.js'

export interface VerifiedSourceResolver {
  resolve(fromPath: string, specifier: string): string | null
  compilerOptions: ts.CompilerOptions
  diagnostics: string[]
  compilerOptionsHash: string
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
function normalizeRelative(path: string): string | null {
  const value = path.replaceAll('\\', '/').replace(/^\.\//u, '')
  if (value === '..' || value.startsWith('../') || value.startsWith('/')) return null
  return value
}
/** Создаёт resolver, чья файловая система ограничена переданной картой проверенных исходников. */
export function createVerifiedSourceResolver(rootInput: string, sources: readonly VerifiedSymbolSource[], tsconfigPath?: string): VerifiedSourceResolver {
  const root = resolve(rootInput)
  const paths = new Map<string, VerifiedSymbolSource>()
  const absoluteToLogical = new Map<string, string>()
  for (const source of sources) {
    const logical = normalizeRelative(source.path)
    if (!logical) throw new Error(`Source path is not canonical: ${source.path}`)
    const absolute = resolve(root, logical)
    if (!inside(root, absolute)) throw new Error(`Source path escapes verified root: ${source.path}`)
    if (paths.has(logical)) throw new Error(`Duplicate verified source path: ${logical}`)
    paths.set(logical, source)
    absoluteToLogical.set(absolute, logical)
  }
  const diagnostics: string[] = []
  const packageManifests: Array<{ name: string; directory: string; exports: Record<string, unknown> | string }> = []
  for (const [path, source] of paths) {
    if (!/(?:^|\/)package\.json$/iu.test(path)) continue
    try {
      const manifest = JSON.parse(source.text) as { name?: unknown; exports?: unknown }
      if (typeof manifest.name === 'string' && (typeof manifest.exports === 'string' || (manifest.exports && typeof manifest.exports === 'object')))
        packageManifests.push({ name: manifest.name, directory: dirname(path), exports: manifest.exports as Record<string, unknown> | string })
    } catch { diagnostics.push(`malformed verified package manifest: ${path}`) }
  }
  let compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.Latest,
  }
  const configContents = new Map([...paths].filter(([path]) => path.toLowerCase().endsWith('.json')))
  const configKey = tsconfigPath ? normalizeRelative(tsconfigPath) : configContents.has('tsconfig.json') ? 'tsconfig.json' : null
  if (tsconfigPath && !configKey) diagnostics.push('tsconfig path escaped verified root')
  const configIdentity = configKey ?? null
  if (configKey) {
    const visited = new Set<string>()
    const checked = new Set<string>()
    const allowedConfigPaths = new Set<string>()
    const checkChain = (key: string, depth: number): void => {
      const normalized = normalizeRelative(key)
      if (!normalized) { diagnostics.push('tsconfig extends escaped verified root'); return }
      if (depth > 8) { diagnostics.push('tsconfig extends depth exceeded'); return }
      if (visited.has(normalized)) { diagnostics.push(`tsconfig extends cycle: ${normalized}`); return }
      if (checked.has(normalized)) return
      const source = configContents.get(normalized)
      if (!source) { diagnostics.push(`unavailable verified tsconfig: ${normalized}`); return }
      const parsed = ts.parseConfigFileTextToJson(normalized, source.text)
      if (parsed.error || !parsed.config || typeof parsed.config !== 'object') { diagnostics.push(`malformed tsconfig: ${normalized}`); return }
      allowedConfigPaths.add(normalized)
      visited.add(normalized)
      const parent = (parsed.config as { extends?: unknown }).extends
      if (typeof parent === 'string') {
        if (!parent.startsWith('.') || parent.includes('*')) diagnostics.push('unsupported non-relative tsconfig extends')
        else {
          const parentPath = resolve(dirname(resolve(root, normalized)), parent.endsWith('.json') ? parent : `${parent}.json`)
          if (!inside(root, parentPath)) diagnostics.push('tsconfig extends escaped verified root')
          else checkChain(relative(root, parentPath).split(sep).join('/'), depth + 1)
        }
      }
      visited.delete(normalized)
      checked.add(normalized)
    }
    checkChain(configKey, 0)
    const parseHost: ts.ParseConfigFileHost = {
      useCaseSensitiveFileNames: true,
      getCurrentDirectory: () => root,
      fileExists: (file) => allowedConfigPaths.has(relative(root, resolve(file)).split(sep).join('/')),
      readFile: (file) => {
        const logical = relative(root, resolve(file)).split(sep).join('/')
        return allowedConfigPaths.has(logical) ? configContents.get(logical)?.text : undefined
      },
      readDirectory: () => [],
      directoryExists: (directory) => [...allowedConfigPaths].some((file) => inside(resolve(directory), resolve(root, file))),
      getDirectories: () => [],
      realpath: (file) => resolve(file),
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => diagnostics.push(`tsconfig: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`),
    }
    const configFileName = resolve(root, configKey)
    const parsed = ts.getParsedCommandLineOfConfigFile(configFileName, undefined, parseHost)
    if (parsed) {
      diagnostics.push(...parsed.errors
        .filter((diagnostic) => diagnostic.code !== 18003)
        .map((diagnostic) => `tsconfig: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`))
      compilerOptions = parsed.options
    } else diagnostics.push(`unavailable verified tsconfig: ${configKey}`)
  }
  // JavaScript включён намеренно: переданные JS-файлы анализируются и проверяются.
  // Пути, типы и плагины остаются ограничены явной политикой закрытого анализа.
  const effectiveOptions = { ...compilerOptions }
  delete effectiveOptions.plugins
  delete effectiveOptions.typeRoots
  compilerOptions = { ...effectiveOptions, allowJs: true, checkJs: true, noLib: true, noEmit: true, types: [] }
  const canonical = (value: unknown, stack = new Set<object>()): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value
    if (typeof value !== 'object') throw new TypeError('Compiler options contain a non-serializable value')
    if (stack.has(value)) throw new TypeError('Compiler options contain a cycle')
    stack.add(value)
    let result: unknown
    if (Array.isArray(value)) result = value.map((item) => canonical(item, stack))
    else {
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Compiler options contain a non-plain object')
      result = Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item, stack)]))
    }
    stack.delete(value)
    return result
  }
  const pathOptions = new Set(['baseUrl', 'pathsBasePath', 'rootDir', 'rootDirs', 'rootDirsBasePath', 'typeRoots', 'outDir', 'outFile', 'declarationDir', 'tsBuildInfoFile'])
  const optionsForHash: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(compilerOptions)) {
    if (key === 'configFilePath' || value === undefined) continue
    const relativize = (entry: unknown): unknown => typeof entry === 'string' && isAbsolute(entry) ? (relative(root, entry) || '.') : entry
    optionsForHash[key] = pathOptions.has(key)
      ? Array.isArray(value) ? value.map(relativize) : key === 'paths' ? value : relativize(value)
      : value
  }
  const compilerOptionsHash = createHash('sha256').update(JSON.stringify(canonical({
    typescriptVersion: ts.version,
    configPath: configIdentity,
    options: optionsForHash,
    policy: { allowJs: true, checkJs: true, noLib: true, noEmit: true, types: [], typeRoots: 'disabled', plugins: 'disabled', filesystem: 'verified-map-only' },
  }))).digest('hex')

  const dirs = new Set<string>([root])
  for (const file of absoluteToLogical.keys()) for (let dir = dirname(file); inside(root, dir); dir = dirname(dir)) { dirs.add(dir); if (dir === root) break }
  const host: ts.ModuleResolutionHost = {
    fileExists: (file) => absoluteToLogical.has(resolve(file)),
    readFile: (file) => { const logical = absoluteToLogical.get(resolve(file)); return logical ? paths.get(logical)?.text : undefined },
    directoryExists: (dir) => dirs.has(resolve(dir)), getCurrentDirectory: () => root,
    realpath: (file) => resolve(file),
  }
  const cache = ts.createModuleResolutionCache(root, (file) => resolve(file), compilerOptions)
  return {
    compilerOptions,
    diagnostics,
    compilerOptionsHash,
    resolve(fromPath, specifier) {
      if (!specifier || specifier.includes('\0')) return null
      const containing = resolve(root, fromPath)
      // Пакет разрешается по исходному условию только при наличии проверенного манифеста и цели.
      for (const pkg of packageManifests) {
        if (specifier !== pkg.name && !specifier.startsWith(`${pkg.name}/`)) continue
        const subpath = specifier === pkg.name ? '.' : `.${specifier.slice(pkg.name.length)}`
        const exports = pkg.exports
        const hasSubpathKeys = typeof exports === 'object' && Object.keys(exports).some((key) => key.startsWith('.'))
        const entry = typeof exports === 'string' ? undefined : hasSubpathKeys ? exports[subpath] : subpath === '.' ? exports : undefined
        const findDevelopment = (value: unknown): string | undefined => {
          if (!value || typeof value !== 'object') return undefined
          const conditions = value as Record<string, unknown>
          if (typeof conditions.development === 'string') return conditions.development
          for (const condition of ['import', 'node']) {
            const found = findDevelopment(conditions[condition])
            if (found) return found
          }
          return undefined
        }
        const target = findDevelopment(entry)
        if (typeof target === 'string' && target.startsWith('./')) {
          const logical = normalizeRelative(resolve(root, pkg.directory, target.slice(2)).replace(`${root}${sep}`, '').split(sep).join('/'))
          if (logical && paths.has(logical) && inside(root, resolve(root, logical))) return logical
        }
        // Для известного пакета без development-цели не подставляем dist или декларации.
        return null
      }
      const resolution = ts.resolveModuleName(specifier, containing, compilerOptions, host, cache)
        .resolvedModule?.resolvedFileName
      if (resolution) {
        const exact = absoluteToLogical.get(resolve(resolution))
        if (exact) return exact
      }
      // Учитываем принятую в TypeScript форму импорта исходника: foo.js -> foo.ts.
      if (specifier.startsWith('.')) {
        const base = resolve(dirname(containing), specifier)
        const stripped = base.replace(/\.(?:mjs|cjs|js|jsx)$/iu, '')
        const candidates = [base, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'].map((ext) => `${base}${ext}`), ...['index.ts', 'index.tsx', 'index.js', 'index.jsx'].map((name) => resolve(base, name)), ...['.ts', '.tsx', '.mts', '.cts'].map((ext) => `${stripped}${ext}`)]
        for (const candidate of candidates) { if (!inside(root, candidate)) continue; const logical = absoluteToLogical.get(candidate); if (logical) return logical }
      }
      return null
    },
  }
}
