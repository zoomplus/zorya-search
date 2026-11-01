import { parseDocument } from 'htmlparser2'
import { ProviderError } from './contracts.js'

type HtmlNode = ReturnType<typeof parseDocument>['children'][number]
type HtmlElement = Extract<HtmlNode, { attribs: unknown }>

type TextPart = {
  value: string
  protected: boolean
  boundary?: boolean
}

type MetadataScope = {
  title?: string
  publishedAt?: string
  sourceUpdatedAt?: string
}

export interface ParsedWebDocument {
  title: string
  text: string
  publishedAt: string | null
  sourceUpdatedAt: string | null
}

const blockElements = new Set([
  'address', 'article', 'blockquote', 'dd', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th',
  'tr', 'ul',
])
const ignoredElements = new Set([
  'script', 'style', 'nav', 'noscript', 'svg', 'template', 'iframe', 'form',
])
const titleKeys = new Set(['title', 'headline', 'name'])
const publishedDateKeys = new Set(['datepublished', 'published', 'publishedat'])
const updatedDateKeys = new Set(['datemodified', 'modified', 'updated', 'lastmodified'])

export function parseWebDocument(
  raw: string,
  contentType: string,
  fallbackTitle: string,
): ParsedWebDocument {
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
    return parseHtml(raw, fallbackTitle)
  }
  if (contentType === 'application/json' || contentType.endsWith('+json')) {
    return parseJson(raw, fallbackTitle)
  }
  if (isXmlType(contentType)) {
    return parseXml(raw, fallbackTitle)
  }
  if (contentType === 'text/markdown' || contentType === 'text/x-markdown') {
    return parseMarkdown(raw, fallbackTitle)
  }
  if (contentType === 'text/plain') {
    return emptyMetadata(raw, fallbackTitle)
  }
  throw new ProviderError('malformed')
}

function emptyMetadata(text: string, title: string): ParsedWebDocument {
  return { title: boundedTitle(title), text, publishedAt: null, sourceUpdatedAt: null }
}

function isXmlType(contentType: string): boolean {
  return contentType === 'application/xml'
    || contentType === 'text/xml'
    || contentType === 'application/rss+xml'
    || contentType === 'application/atom+xml'
    || contentType.endsWith('+xml')
}

function parseHtml(raw: string, fallbackTitle: string): ParsedWebDocument {
  const root = parseDocument(raw, { decodeEntities: true })
  const metadata = readHtmlMetadata(root)
  const titleParts: string[] = []
  const textParts: TextPart[] = []
  const stack: Array<{
    node?: HtmlNode
    inTitle: boolean
    preserveWhitespace: boolean
    closeBlock?: boolean
  }> = []

  for (let index = root.children.length - 1; index >= 0; index -= 1) {
    stack.push({ node: root.children[index]!, inTitle: false, preserveWhitespace: false })
  }

  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.closeBlock) {
      appendBoundary(textParts)
      continue
    }
    const node = current.node
    if (!node) continue

    if (node.type === 'text') {
      if (current.inTitle) {
        titleParts.push(node.data)
      } else if (current.preserveWhitespace) {
        textParts.push({ value: node.data, protected: true })
      } else {
        textParts.push({ value: node.data.replace(/[\t\r\n\f ]+/gu, ' '), protected: false })
      }
      continue
    }

    if (isElement(node)) {
      const element = node as HtmlElement
      if (ignoredElements.has(element.name)
        || element.attribs.hidden !== undefined
        || element.attribs['aria-hidden'] === 'true') {
        continue
      }

      const inTitle = current.inTitle || element.name === 'title'
      const preserveWhitespace = current.preserveWhitespace
        || element.name === 'pre'
        || element.name === 'code'
      const isBlock = !inTitle && blockElements.has(element.name)

      if (!inTitle && element.name === 'br') {
        textParts.push({ value: '\n', protected: false })
        continue
      }
      if (isBlock) appendBoundary(textParts)
      if (isBlock) {
        stack.push({ inTitle, preserveWhitespace, closeBlock: true })
      }
      pushChildrenInSourceOrder(stack, element.children, inTitle, preserveWhitespace)
      continue
    }

    if ('children' in node) {
      pushChildrenInSourceOrder(stack, node.children, current.inTitle, current.preserveWhitespace)
    }
  }

  const titleFromDocument = titleParts.join('').replace(/\s+/gu, ' ').trim()
  const title = titleFromDocument || metadata.title || fallbackTitle
  const text = renderHtmlText(textParts)
  return {
    title: boundedTitle(title),
    text,
    publishedAt: parseDate(metadata.publishedAt ?? null),
    sourceUpdatedAt: parseDate(metadata.sourceUpdatedAt ?? null),
  }
}

function isElement(node: HtmlNode): boolean {
  return node.type === 'tag' || node.type === 'script' || node.type === 'style'
}

function pushChildrenInSourceOrder(
  stack: Array<{ node?: HtmlNode; inTitle: boolean; preserveWhitespace: boolean; closeBlock?: boolean }>,
  children: HtmlNode[],
  inTitle: boolean,
  preserveWhitespace: boolean,
): void {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    stack.push({ node: children[index]!, inTitle, preserveWhitespace })
  }
}

function appendBoundary(parts: TextPart[]): void {
  const last = parts.at(-1)
  if (!last?.protected && last?.value.endsWith('\n\n')) return
  parts.push({ value: '\n\n', protected: false, boundary: true })
}

function renderHtmlText(parts: TextPart[]): string {
  let result = ''
  let lastContent = parts.length - 1
  while (lastContent >= 0 && parts[lastContent]!.boundary) lastContent -= 1

  for (let index = 0; index <= lastContent; index += 1) {
    const part = parts[index]!
    if (part.boundary) {
      if (result.length > 0) result += part.value
      continue
    }
    if (part.protected) {
      result += part.value
      continue
    }
    const normalized = part.value
    if (result.length === 0) {
      result += normalized.replace(/^\s+/u, '')
    } else {
      result += normalized
    }
  }
  return result
}

function readHtmlMetadata(root: HtmlNode): MetadataScope {
  const metadata: MetadataScope = {}
  const stack: HtmlNode[] = []
  pushNodeChildren(stack, root)
  while (stack.length > 0) {
    const node = stack.pop()!
    if (!isElement(node)) continue
    const element = node as HtmlElement
    if (element.name === 'meta') {
      const key = (element.attribs.name || element.attribs.property || element.attribs.itemprop || '').toLowerCase()
      const value = element.attribs.content?.trim()
      if (value) setHtmlMetadata(metadata, key, value)
    }
    pushNodeChildren(stack, element)
  }
  return metadata
}

function pushNodeChildren(stack: HtmlNode[], node: HtmlNode): void {
  if (!('children' in node)) return
  for (let index = node.children.length - 1; index >= 0; index -= 1) {
    stack.push(node.children[index]!)
  }
}

function setHtmlMetadata(metadata: MetadataScope, key: string, value: string): void {
  if (!metadata.title && ['og:title', 'twitter:title'].includes(key)) metadata.title = value
  if (
    !metadata.publishedAt
    && ['article:published_time', 'datepublished', 'pubdate'].includes(key)
  ) {
    metadata.publishedAt = value
  }
  if (
    !metadata.sourceUpdatedAt
    && ['article:modified_time', 'datemodified', 'last-modified', 'dc.modified'].includes(key)
  ) {
    metadata.sourceUpdatedAt = value
  }
}

function parseMarkdown(raw: string, fallbackTitle: string): ParsedWebDocument {
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  const fields = new Map<string, string>()
  if (frontMatter) {
    for (const line of frontMatter[1]!.split(/\r?\n/u)) {
      const field = /^([\w-]+):\s*["']?(.*?)["']?\s*$/u.exec(line)
      if (field) fields.set(field[1]!.toLowerCase(), field[2]!)
    }
  }
  return {
    title: boundedTitle(fields.get('title') || fallbackTitle),
    text: raw,
    publishedAt: parseDate(fields.get('published') || null),
    sourceUpdatedAt: parseDate(fields.get('updated') || null),
  }
}

function parseJson(raw: string, fallbackTitle: string): ParsedWebDocument {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    throw new ProviderError('malformed')
  }

  const metadata = isPlainObject(value) ? readJsonMetadata(value) : {}
  return {
    title: boundedTitle(metadata.title || fallbackTitle),
    text: raw,
    publishedAt: parseDate(metadata.publishedAt ?? null),
    sourceUpdatedAt: parseDate(metadata.sourceUpdatedAt ?? null),
  }
}

function readJsonMetadata(value: Record<string, unknown>): MetadataScope {
  const metadata: MetadataScope = {}
  for (const [key, field] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase()
    if (typeof field !== 'string') continue
    if (!metadata.title && titleKeys.has(normalizedKey)) metadata.title = field
    if (!metadata.publishedAt && publishedDateKeys.has(normalizedKey)) metadata.publishedAt = field
    if (!metadata.sourceUpdatedAt && updatedDateKeys.has(normalizedKey)) metadata.sourceUpdatedAt = field
  }
  return metadata
}

function parseXml(raw: string, fallbackTitle: string): ParsedWebDocument {
  const root = parseDocument(raw, { xmlMode: true, decodeEntities: true })
  const metadata = readXmlMetadata(root)
  return {
    title: boundedTitle(metadata.title || fallbackTitle),
    text: raw,
    publishedAt: parseDate(metadata.publishedAt ?? null),
    sourceUpdatedAt: parseDate(metadata.sourceUpdatedAt ?? null),
  }
}

function readXmlMetadata(root: HtmlNode): MetadataScope {
  const documentChildren = directElements(root)
  const documentElement = documentChildren[0]
  const rootChildren = documentElement ? directElements(documentElement) : documentChildren
  const feedContainer = rootChildren.find((element) => ['channel', 'feed'].includes(localName(element.name)))
  const scope = feedContainer ? directElements(feedContainer) : rootChildren
  return readXmlScope(scope)
}

function readXmlScope(elements: HtmlElement[]): MetadataScope {
  const metadata: MetadataScope = {}
  for (const element of elements) {
    const name = localName(element.name)
    const isTitle = name === 'title'
    const isPublishedDate = ['pubdate', 'published', 'issued', 'datepublished'].includes(name)
    const isUpdatedDate = ['updated', 'modified', 'datemodified'].includes(name)
    if (!isTitle && !isPublishedDate && !isUpdatedDate) continue

    const value = xmlText(element)
    if (!value) continue
    if (!metadata.title && isTitle) metadata.title = value
    if (!metadata.publishedAt && isPublishedDate) {
      metadata.publishedAt = value
    }
    if (!metadata.sourceUpdatedAt && isUpdatedDate) {
      metadata.sourceUpdatedAt = value
    }
  }
  return metadata
}

function collectDirectElements(parent: HtmlElement, into: HtmlElement[]): void {
  for (const child of parent.children) {
    if (isElement(child)) into.push(child as HtmlElement)
  }
}

function directElements(parent: HtmlNode): HtmlElement[] {
  const elements: HtmlElement[] = []
  if (!('children' in parent)) return elements
  collectDirectElements(parent as HtmlElement, elements)
  return elements
}

function xmlText(element: HtmlElement): string {
  const stack: HtmlNode[] = []
  pushNodeChildren(stack, element)
  let result = ''
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.type === 'text') {
      result += node.data
    } else if ('children' in node) {
      pushNodeChildren(stack, node)
    }
  }
  return result.trim()
}

function localName(name: string): string {
  const separator = name.lastIndexOf(':')
  return (separator === -1 ? name : name.slice(separator + 1)).toLowerCase()
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedTitle(value: string): string {
  return value.slice(0, 500)
}

export function parseDate(value: string | null): string | null {
  if (!value) return null

  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (isoDate) {
    if (!validCalendarDate(Number(isoDate[1]), Number(isoDate[2]), Number(isoDate[3]))) return null
  }

  const isoDateTime = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/u.exec(value)
  if (isoDateTime) {
    if (!validCalendarDate(Number(isoDateTime[1]), Number(isoDateTime[2]), Number(isoDateTime[3]))) return null
    if (Number(isoDateTime[4]) > 23 || Number(isoDateTime[5]) > 59 || Number(isoDateTime[6]) > 59) return null
    if (isoDateTime[7] && (Number(isoDateTime[8]) > 23 || Number(isoDateTime[9]) > 59)) return null
  } else if (!isoDate && !isExplicitRfcDate(value)) {
    return null
  }

  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= days[month - 1]!
}

function isExplicitRfcDate(value: string): boolean {
  const match = /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun), )?(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) (GMT|UTC|UT|[+-]\d{4})$/iu.exec(value)
  if (!match) return false

  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    .indexOf(match[3]!.toLowerCase()) + 1
  const year = Number(match[4])
  const day = Number(match[2])
  const hour = Number(match[5])
  const minute = Number(match[6])
  const second = Number(match[7])
  if (!validCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return false

  const timezone = match[8]!
  if (/^[+-]/u.test(timezone) && (Number(timezone.slice(1, 3)) > 23 || Number(timezone.slice(3, 5)) > 59)) {
    return false
  }
  if (match[1]) {
    const localDate = new Date(0)
    localDate.setUTCFullYear(year, month - 1, day)
    localDate.setUTCHours(0, 0, 0, 0)
    const localWeekday = localDate.getUTCDay()
    const weekday = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][localWeekday]
    if (weekday !== match[1].toLowerCase()) return false
  }
  return true
}

export async function parsePdfDocument(
  bytes: Uint8Array,
  fallbackTitle: string,
  signal: AbortSignal,
): Promise<ParsedWebDocument> {
  const abortReason = (): ProviderError => signal.reason instanceof ProviderError
    ? signal.reason
    : new ProviderError('cancel')
  if (signal.aborted) throw abortReason()

  let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs')
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  } catch {
    if (signal.aborted) throw abortReason()
    throw new ProviderError('unavailable')
  }
  if (signal.aborted) throw abortReason()

  const loadingTask = pdfjs.getDocument({
    data: Uint8Array.from(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    stopAtErrors: true,
    useWorkerFetch: false,
  })
  let disposal: Promise<void> | undefined
  const destroyTask = (): Promise<void> => {
    if (!disposal) disposal = loadingTask.destroy().then(() => undefined)
    return disposal
  }
  const cancel = (): void => {
    void destroyTask().catch(() => undefined)
  }

  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()

  let completed = false
  try {
    if (signal.aborted) throw abortReason()
    const document = await loadingTask.promise
    if (signal.aborted) throw abortReason()
    if (document.numPages > 100) throw new ProviderError('budget')

    const pageTexts: string[] = []
    let totalCharacters = 0
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      if (signal.aborted) throw abortReason()
      const page = await document.getPage(pageNumber)
      try {
        if (signal.aborted) throw abortReason()
        const content = await page.getTextContent()
        if (signal.aborted) throw abortReason()
        const text = content.items.map((item) => {
          if (!('str' in item)) return ''
          return item.str + (item.hasEOL ? '\n' : ' ')
        }).join('').trimEnd()
        totalCharacters += text.length
        if (totalCharacters > 200_000) throw new ProviderError('budget')
        pageTexts.push(text)
      } finally {
        page.cleanup()
      }
    }
    if (signal.aborted) throw abortReason()
    const metadata = await document.getMetadata().catch(() => null)
    if (signal.aborted) throw abortReason()
    const info = metadata?.info as Record<string, unknown> | undefined
    const documentTitle = typeof info?.Title === 'string' ? info.Title.trim() : ''
    const text = pageTexts.join('\n\n')
    if (!text.trim()) throw new ProviderError('malformed')
    completed = true
    return {
      title: boundedTitle(documentTitle || fallbackTitle),
      text,
      publishedAt: null,
      sourceUpdatedAt: null,
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw signal.aborted ? abortReason() : new ProviderError('malformed')
  } finally {
    signal.removeEventListener('abort', cancel)
    await destroyTask().catch(() => undefined)
    if (completed && signal.aborted) throw abortReason()
  }
}
