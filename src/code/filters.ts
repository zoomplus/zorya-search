import { CodeIndexError } from './errors.js'
import type { CodeSearchInput } from './types.js'

const languageAliases = new Map<string, readonly string[]>([
  ['typescript', ['ts', 'tsx', 'mts', 'cts', 'typescript', 'typescriptreact']],
  ['javascript', ['js', 'jsx', 'mjs', 'cjs', 'javascript', 'javascriptreact']],
  ['python', ['py', 'python']],
  ['markdown', ['md', 'mdx', 'markdown']],
])

export function normalizeCodeLanguage(language: unknown): string | undefined {
  if (language === undefined) return undefined
  if (typeof language !== 'string' || !language.trim() || language.length > 64)
    throw new CodeIndexError('CODE_INDEX_LANGUAGE_FILTER_INVALID')
  const normalized = language.trim().toLowerCase()
  return languageAliases.has(normalized) ? normalized : language
}

export function codeLanguageMatches(rowLanguage: string, filter: string | undefined): boolean {
  if (!filter) return true
  const canonical = normalizeCodeLanguage(filter)!
  const aliases = languageAliases.get(canonical)
  return aliases ? aliases.includes(rowLanguage.toLowerCase()) : rowLanguage === filter
}

export function normalizeSourceKind(value: unknown): NonNullable<CodeSearchInput['sourceKind']> | undefined {
  if (value === undefined) return undefined
  if (value === 'implementation' || value === 'tests' || value === 'documentation' || value === 'all')
    return value
  throw new CodeIndexError('CODE_INDEX_SOURCE_KIND_INVALID')
}

export function codeSourceKind(path: string): Exclude<NonNullable<CodeSearchInput['sourceKind']>, 'all'> {
  const normalized = path.replaceAll('\\', '/').toLowerCase()
  const segments = normalized.split('/')
  const base = segments.at(-1) ?? ''
  if (
    segments.some((part) => ['test', 'tests', '__tests__', 'fixtures', '__fixtures__'].includes(part)) ||
    /(?:^|[.-])(?:test|spec)(?:\.[^.]+)*$/u.test(base)
  ) return 'tests'
  const extension = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : ''
  if (
    segments.includes('docs') ||
    ['readme', 'changelog', 'contributing', 'license', 'agents.md'].includes(base) ||
    ['md', 'mdx', 'rst', 'txt', 'adoc', 'mdc'].includes(extension)
  ) return 'documentation'
  return 'implementation'
}

export function codeSourceKindMatches(path: string, filter: CodeSearchInput['sourceKind']): boolean {
  return !filter || filter === 'all' || codeSourceKind(path) === filter
}

export function codeFilterCacheKey(input: Pick<CodeSearchInput, 'language' | 'sourceKind' | 'paths'>): string {
  const language = normalizeCodeLanguage(input.language) ?? ''
  const kind = normalizeSourceKind(input.sourceKind) ?? 'all'
  const paths = [...new Set(input.paths ?? [])].sort()
  return JSON.stringify([language, kind, paths])
}
