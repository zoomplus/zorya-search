/** Внутренний режим представления результата только для stdio. */
export type ResultPresentation = 'legacy' | 'structured'

export function parseResultPresentation(value: unknown): ResultPresentation {
  if (value === 'legacy' || value === 'structured') return value
  throw new Error('MCP_RESULT_PRESENTATION_INVALID')
}

const STRUCTURED_CONTENT_SUMMARY = 'See structuredContent.'
const MAX_DUPLICATE_TEXT_LENGTH = 2 * 1024 * 1024
const MAX_COMPARISON_NODES = 100_000

/**
 * Удаляет только текстовый блок, который точно дублирует structured result
 * как JSON-данные. Неподдерживаемые значения и ошибки сравнения не меняют ответ.
 */
export function presentStructuredResult<T>(result: T): T {
  try {
    if (!isRecord(result)) return result
    const resultDescriptors = Object.getOwnPropertyDescriptors(result)
    const structured = resultDescriptors.structuredContent
    const contentDescriptor = resultDescriptors.content
    const errorDescriptor = resultDescriptors.isError
    if (
      errorDescriptor?.value === true ||
      !structured || !('value' in structured) ||
      !isPlainObject(structured.value) ||
      !contentDescriptor || !('value' in contentDescriptor) ||
      !Array.isArray(contentDescriptor.value)
    ) return result

    const upstreamContent = contentDescriptor.value as unknown[]
    const contentDescriptors = Object.getOwnPropertyDescriptors(upstreamContent)
    const contentLength = Object.getOwnPropertyDescriptor(upstreamContent, 'length')?.value
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) return result
    const contentKeys = Reflect.ownKeys(contentDescriptors)
    if (contentKeys.some((key) => typeof key === 'symbol' || (key !== 'length' && !/^(0|[1-9]\d*)$/u.test(key))))
      return result

    let changed = false
    const content: unknown[] = []
    for (let index = 0; index < contentLength; index++) {
      const blockDescriptor = contentDescriptors[String(index)]
      if (!blockDescriptor || !('value' in blockDescriptor)) return result
      const block: unknown = blockDescriptor.value
      if (!isRecord(block)) {
        content.push(block)
        continue
      }
      const descriptors = Object.getOwnPropertyDescriptors(block)
      if (
        descriptors.type?.value !== 'text' ||
        typeof descriptors.text?.value !== 'string'
      ) {
        content.push(block)
        continue
      }
      const text = descriptors.text.value as string
      if (text.length <= STRUCTURED_CONTENT_SUMMARY.length || text.length > MAX_DUPLICATE_TEXT_LENGTH) {
        content.push(block)
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        content.push(block)
        continue
      }
      if (!structuralJsonEqual(parsed, structured.value)) {
        content.push(block)
        continue
      }
      changed = true
      const blockCopy = Object.create(Object.getPrototypeOf(block))
      Object.defineProperties(blockCopy, {
        ...descriptors,
        text: { ...descriptors.text, value: STRUCTURED_CONTENT_SUMMARY },
      })
      content.push(blockCopy)
    }
    if (!changed) return result
    const resultCopy = Object.create(Object.getPrototypeOf(result))
    Object.defineProperties(resultCopy, {
      ...resultDescriptors,
      content: { ...contentDescriptor, value: content },
    })
    return resultCopy
  } catch {
    return result
  }
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function structuralJsonEqual(left: unknown, right: unknown) {
  const pending: Array<[unknown, unknown]> = [[left, right]]
  let visited = 0
  while (pending.length) {
    if (++visited > MAX_COMPARISON_NODES) return false
    const [a, b] = pending.pop()!
    if (typeof a !== typeof b) return false
    if (typeof a === 'number') {
      if (!Number.isFinite(a) || !Number.isFinite(b as number) || !Object.is(a, b)) return false
      continue
    }
    if (a === null || b === null) {
      if (a !== b) return false
      continue
    }
    if (typeof a !== 'object') {
      if (!Object.is(a, b)) return false
      continue
    }
    if (typeof b !== 'object') return false
    if (a === b) continue
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
      const aDescriptors = Object.getOwnPropertyDescriptors(a)
      const bDescriptors = Object.getOwnPropertyDescriptors(b)
      const aKeys = Object.keys(aDescriptors).filter((key) => key !== 'length')
      const bKeys = Object.keys(bDescriptors).filter((key) => key !== 'length')
      if (aKeys.length !== a.length || bKeys.length !== b.length) return false
      for (let index = 0; index < a.length; index++) {
        const ad = aDescriptors[String(index)]
        const bd = bDescriptors[String(index)]
        if (!ad || !bd || !('value' in ad) || !('value' in bd)) return false
        pending.push([ad.value, bd.value])
      }
      if (Reflect.ownKeys(aDescriptors).some((key) => typeof key === 'symbol') ||
          Reflect.ownKeys(bDescriptors).some((key) => typeof key === 'symbol')) return false
      continue
    }
    if (!isPlainObject(a) || !isPlainObject(b)) return false
    const aDescriptors = Object.getOwnPropertyDescriptors(a)
    const bDescriptors = Object.getOwnPropertyDescriptors(b)
    const aKeys = Object.keys(aDescriptors).sort()
    const bKeys = Object.keys(bDescriptors).sort()
    if (aKeys.length !== bKeys.length || aKeys.some((key, index) => key !== bKeys[index])) return false
    if (Reflect.ownKeys(aDescriptors).some((key) => typeof key === 'symbol') ||
        Reflect.ownKeys(bDescriptors).some((key) => typeof key === 'symbol')) return false
    for (const key of aKeys) {
      const ad = aDescriptors[key]!
      const bd = bDescriptors[key]!
      if (!('value' in ad) || !('value' in bd) || !ad.enumerable || !bd.enumerable) return false
      pending.push([ad.value, bd.value])
    }
  }
  return true
}

function isPlainObject(value: object) {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
