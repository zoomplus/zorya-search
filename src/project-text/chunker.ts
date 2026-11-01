import { createHash } from 'node:crypto'
import type { EnumeratedFile } from '../code/enumerate.js'
import { CodeIndexError } from '../code/errors.js'
import type { ProjectTextChunk, ProjectTextKind } from './types.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
export const PROJECT_TEXT_CHUNKER_VERSION = 'project-text-heading-v1'

export function classifyProjectText(path: string): ProjectTextKind {
  const normalized = path.toLowerCase()
  if (
    /(^|\/)(\.agents\/rules|\.cursor\/rules)(\/|$)/u.test(normalized) ||
    /(^|\/)(agents|claude)\.md$/u.test(normalized) ||
    /(^|\/)(\.cursorrules|\.windsurfrules)$/u.test(normalized)
  )
    return 'rules'
  const skillPath =
    /(^|\/)(skills|\.codex\/skills|\.agents\/skills|\.cursor\/skills|\.claude\/skills)(\/|$)/u.test(
      normalized,
    )
  if (skillPath || /(^|\/)skill\.md$/u.test(normalized)) return 'skills'
  return 'documentation'
}

export function chunkProjectText(file: EnumeratedFile, maxChars: number): ProjectTextChunk[] {
  const lines = file.text.split('\n')
  const kind = classifyProjectText(file.path)
  let title: string | null = null
  let titleFence: { marker: string; length: number } | null = null
  for (const line of lines) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)
    if (fence) {
      const marker = fence[1]![0]!
      if (!titleFence) titleFence = { marker, length: fence[1]!.length }
      else if (
        titleFence.marker === marker &&
        fence[1]!.length >= titleFence.length &&
        /^\s{0,3}(?:`{3,}|~{3,})\s*$/u.test(line)
      )
        titleFence = null
      continue
    }
    if (!titleFence && /^#\s+\S/u.test(line)) {
      title = line.replace(/^#\s+/u, '').trim()
      break
    }
  }
  const headings: string[] = []
  const chunks: ProjectTextChunk[] = []
  const occurrences = new Map<string, number>()
  let startLine = 1
  let body: string[] = []
  let bodyChars = 0
  let activeFence: { marker: string; length: number } | null = null

  const flush = (endLine: number) => {
    if (!body.length) return
    const text = body.join('\n')
    const breadcrumb = headings.filter((heading): heading is string => typeof heading === 'string')
    const stableKey = `${file.path}\0${breadcrumb.join('\0')}\0${text}`
    const occurrence = occurrences.get(stableKey) ?? 0
    occurrences.set(stableKey, occurrence + 1)
    chunks.push({
      id: hash(`${stableKey}\0${occurrence}`),
      path: file.path,
      kind,
      title,
      heading: breadcrumb,
      lineStart: startLine,
      lineEnd: endLine,
      text,
      contentHash: hash(text),
    })
    body = []
    bodyChars = 0
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const lineNumber = index + 1
    const fence = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)
    const isHeading = !activeFence && !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line)
    const headingMatch = typeof isHeading === 'object' && isHeading ? isHeading : null

    if (headingMatch) {
      flush(lineNumber - 1)
      const depth = headingMatch[1]!.length
      headings.length = depth - 1
      headings[depth - 1] = headingMatch[2]!
      startLine = lineNumber
    }

    if (line.length > maxChars) throw new CodeIndexError('PROJECT_TEXT_LINE_LIMIT')
    if (body.length && bodyChars + line.length + 1 > maxChars) {
      flush(lineNumber - 1)
      startLine = lineNumber
    }
    body.push(line)
    bodyChars += line.length + 1

    if (fence) {
      const marker = fence[1]![0]!
      if (!activeFence) activeFence = { marker, length: fence[1]!.length }
      else if (
        activeFence.marker === marker &&
        fence[1]!.length >= activeFence.length &&
        /^\s{0,3}(?:`{3,}|~{3,})\s*$/u.test(line)
      )
        activeFence = null
    }
  }
  flush(lines.length)
  return chunks
}
