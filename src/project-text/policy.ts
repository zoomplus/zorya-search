import { createHash } from 'node:crypto'
import { PROJECT_TEXT_CHUNKER_VERSION } from './chunker.js'
import type { EnumerationSelection } from '../code/enumerate.js'

export const PROJECT_TEXT_SELECTION_VERSION = 'project-text-selection-v1'
export const PROJECT_TEXT_SELECTION: EnumerationSelection = Object.freeze({
  extensions: Object.freeze(['.md', '.mdx', '.markdown', '.mdc', '.txt', '.rst', '.adoc']),
  filenames: Object.freeze([
    'agents.md',
    'claude.md',
    'skill.md',
    '.cursorrules',
    '.windsurfrules',
  ]),
})
export function projectTextProfileId(document: unknown, query: unknown): string | null {
  if (!document && !query) return null
  const pair = [document, query] as const
  if (!document || !query) throw new Error('PROJECT_TEXT_EMBEDDING_PAIR_REQUIRED')
  const [d, q] = pair as [
    { profile: Record<string, unknown> },
    { profile: Record<string, unknown> },
  ]
  for (const [provider, purpose] of [
    [d, 'document'],
    [q, 'query'],
  ] as const) {
    const p = provider.profile
    const lengthLimits: Record<string, number> = { provider: 256, space: 512, model: 256 }
    if (
      p.inputType !== purpose ||
      !['provider', 'space', 'model'].every(
        (key) =>
          typeof p[key] === 'string' &&
          (p[key] as string).trim() &&
          (p[key] as string).length <= lengthLimits[key]!,
      ) ||
      (p.profileId !== undefined &&
        (typeof p.profileId !== 'string' || p.profileId.length > 512)) ||
      !Number.isInteger(p.dimensions) ||
      (p.dimensions as number) < 1 ||
      (p.dimensions as number) > 4096
    )
      throw new Error('PROJECT_TEXT_EMBEDDING_PROFILE_INVALID')
  }
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, stable(item)]),
      )
    return value
  }
  if (
    d.profile.dimensions !== q.profile.dimensions ||
    d.profile.provider !== q.profile.provider ||
    d.profile.model !== q.profile.model ||
    JSON.stringify(stable(d.profile.routing ?? null)) !==
      JSON.stringify(stable(q.profile.routing ?? null))
  )
    throw new Error('PROJECT_TEXT_EMBEDDING_PROFILE_MISMATCH')
  if (d.profile.profileId !== q.profile.profileId)
    throw new Error('PROJECT_TEXT_EMBEDDING_PROFILE_MISMATCH')
  const canonical = (profile: Record<string, unknown>) =>
    stable({
      provider: profile.provider,
      space: profile.space,
      model: profile.model,
      dimensions: profile.dimensions,
      inputType: profile.inputType,
      routing: profile.routing ?? null,
      profileId: profile.profileId ?? null,
    })
  return createHash('sha256')
    .update(JSON.stringify(['document', canonical(d.profile), 'query', canonical(q.profile)]))
    .digest('hex')
}

export function projectTextScopeId(
  exclusionId: string,
  limits: Readonly<Record<string, number>>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        PROJECT_TEXT_SELECTION_VERSION,
        PROJECT_TEXT_SELECTION,
        exclusionId,
        PROJECT_TEXT_CHUNKER_VERSION,
        limits,
      ]),
    )
    .digest('hex')
}
