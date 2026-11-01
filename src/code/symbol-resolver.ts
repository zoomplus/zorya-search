import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import type { VerifiedSymbolSource } from './symbol-types.js'

export interface VerifiedSourceResolver {
  resolve(fromPath: string, specifier: string): string | null
  compilerOptions: ts.CompilerOptions
  diagnostics: string[]
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
    if (!logical) continue
    const absolute = resolve(root, logical)
    if (!inside(root, absolute)) continue
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
    allowJs: true, noResolve: true, noLib: true, target: ts.ScriptTarget.Latest,
  }
  const configContents = new Map([...paths].filter(([path]) => path.toLowerCase().endsWith('.json')))
  const configKey = tsconfigPath ? normalizeRelative(tsconfigPath) : 'tsconfig.json'
  if (configKey) {
    const visited = new Set<string>()
    const readConfig = (key: string, depth: number): Record<string, unknown> => {
      if (depth > 8) { diagnostics.push('tsconfig extends depth exceeded'); return {} }
      const normalized = normalizeRelative(key)
      if (!normalized) { diagnostics.push('tsconfig extends escaped verified root'); return {} }
      if (visited.has(normalized)) { diagnostics.push(`tsconfig extends cycle: ${normalized}`); return {} }
      const source = configContents.get(normalized)
      if (!source) { diagnostics.push(`unavailable verified tsconfig: ${normalized}`); return {} }
      visited.add(normalized)
      const parsed = ts.parseConfigFileTextToJson(normalized, source.text)
      if (parsed.error || !parsed.config || typeof parsed.config !== 'object') {
        diagnostics.push(`malformed tsconfig: ${normalized}`); visited.delete(normalized); return {}
      }
      const config = parsed.config as Record<string, unknown>
      let base: Record<string, unknown> = {}
      if (typeof config.extends === 'string') {
        const parentSpec = config.extends.endsWith('.json') ? config.extends : `${config.extends}.json`
        if (parentSpec.startsWith('.') || parentSpec.startsWith('/'))
          base = readConfig(resolve(dirname(resolve(root, normalized)), parentSpec).replace(`${root}${sep}`, '').split(sep).join('/'), depth + 1)
        else diagnostics.push(`package tsconfig extends not resolved: ${parentSpec}`)
      }
      const merged = { ...base, ...config }
      const baseCompiler = (base.compilerOptions && typeof base.compilerOptions === 'object' ? base.compilerOptions : {}) as Record<string, unknown>
      const ownCompiler = (config.compilerOptions && typeof config.compilerOptions === 'object' ? config.compilerOptions : {}) as Record<string, unknown>
      const own = { ...ownCompiler }
      const configDirectory = dirname(resolve(root, normalized))
      const ownBaseUrl = typeof own.baseUrl === 'string'
        ? resolve(configDirectory, own.baseUrl)
        : typeof baseCompiler.baseUrl === 'string' ? resolve(root, baseCompiler.baseUrl) : configDirectory
      if (typeof own.baseUrl === 'string') own.baseUrl = relative(root, ownBaseUrl) || '.'
      if (own.paths && typeof own.paths === 'object') {
        const normalizedPaths: Record<string, string[]> = {}
        for (const [pattern, substitutions] of Object.entries(own.paths as Record<string, unknown>)) {
          if (!Array.isArray(substitutions) || substitutions.some((item) => typeof item !== 'string')) {
            diagnostics.push(`malformed tsconfig paths mapping: ${normalized}:${pattern}`); continue
          }
          normalizedPaths[pattern] = (substitutions as string[]).map((item) => relative(root, resolve(ownBaseUrl, item)))
        }
        own.paths = normalizedPaths
      }
      if (Array.isArray(own.rootDirs)) own.rootDirs = own.rootDirs.filter((item): item is string => typeof item === 'string').map((item) => relative(root, resolve(configDirectory, item)))
      merged.compilerOptions = { ...baseCompiler, ...own }
      visited.delete(normalized)
      return merged
    }
    if (configContents.has(configKey)) {
      const config = readConfig(configKey, 0)
      const raw = (config.compilerOptions && typeof config.compilerOptions === 'object' ? config.compilerOptions : {}) as Record<string, unknown>
      const effectiveBaseUrl = typeof raw.baseUrl === 'string' ? resolve(root, raw.baseUrl) : root
      if (raw.paths && typeof raw.paths === 'object') {
        const finalPaths: Record<string, string[]> = {}
        for (const [pattern, substitutions] of Object.entries(raw.paths as Record<string, unknown>))
          if (Array.isArray(substitutions)) finalPaths[pattern] = substitutions.filter((item): item is string => typeof item === 'string').map((item) => relative(effectiveBaseUrl, resolve(root, item)))
        raw.paths = finalPaths
      }
      const options: ts.CompilerOptions = {
        ...compilerOptions,
        ...(raw.baseUrl || raw.paths ? { baseUrl: effectiveBaseUrl } : {}),
        ...(raw.paths && typeof raw.paths === 'object' ? { paths: raw.paths as Record<string, string[]> } : {}),
        ...(Array.isArray(raw.rootDirs) ? { rootDirs: raw.rootDirs.filter((item): item is string => typeof item === 'string').map((item) => resolve(root, item)) } : {}),
      }
      if (typeof raw.module === 'string' && ts.ModuleKind[raw.module as keyof typeof ts.ModuleKind] !== undefined)
        options.module = ts.ModuleKind[raw.module as keyof typeof ts.ModuleKind] as ts.ModuleKind
      if (typeof raw.moduleResolution === 'string' && ts.ModuleResolutionKind[raw.moduleResolution as keyof typeof ts.ModuleResolutionKind] !== undefined)
        options.moduleResolution = ts.ModuleResolutionKind[raw.moduleResolution as keyof typeof ts.ModuleResolutionKind] as ts.ModuleResolutionKind
      compilerOptions = options
    } else if (tsconfigPath) diagnostics.push(`unavailable verified tsconfig: ${configKey}`)
  }

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
