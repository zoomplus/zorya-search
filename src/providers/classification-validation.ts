import { ProviderError, type ClassificationInput, type ClassificationResult } from './contracts.js'

export function validateClassificationInput(
  input: ClassificationInput,
  maxItems: number,
  maxBytes: number,
): void {
  if (input.signal.aborted) throw new ProviderError('cancel')
  if (
    !input.text.trim() ||
    Buffer.byteLength(input.text) > maxBytes ||
    !input.criteria.trim() ||
    Buffer.byteLength(input.criteria) > maxBytes ||
    input.labels.length < 2 ||
    input.labels.length > maxItems ||
    input.labels.some((label) => !label.trim() || label.length > 160) ||
    new Set(input.labels).size !== input.labels.length
  )
    throw new ProviderError('budget')
  if (
    input.examples &&
    (input.examples.length > 20 ||
      input.examples.some(
        (e) => !input.labels.includes(e.label) || Buffer.byteLength(e.text) > 2000,
      ))
  )
    throw new ProviderError('budget')
}

export function validateClassificationResult(
  value: unknown,
  input: ClassificationInput,
): ClassificationResult {
  if (
    !value ||
    typeof value !== 'object' ||
    !exactKeys(value, ['labels', 'abstained', 'uncertainty'])
  )
    throw new ProviderError('malformed')
  const result = value as ClassificationResult
  if (
    !Array.isArray(result.labels) ||
    !Array.isArray(result.uncertainty) ||
    typeof result.abstained !== 'boolean' ||
    result.labels.length > (input.allowMultiple ? input.labels.length : 1) ||
    result.uncertainty.length > 5
  )
    throw new ProviderError('malformed')
  if (input.allowAbstain === false && result.abstained) throw new ProviderError('malformed')
  if (result.abstained && result.labels.length) throw new ProviderError('malformed')
  if (!result.abstained && !result.labels.length) throw new ProviderError('malformed')
  const used = new Set<string>()
  for (const item of result.labels) {
    if (
      !item ||
      typeof item !== 'object' ||
      !exactKeys(item, ['label', 'confidence', 'evidence']) ||
      typeof item.label !== 'string' ||
      !input.labels.includes(item.label) ||
      used.has(item.label)
    )
      throw new ProviderError('malformed')
    used.add(item.label)
    if (
      item.confidence !== undefined &&
      item.confidence !== null &&
      (typeof item.confidence !== 'number' ||
        !Number.isFinite(item.confidence) ||
        item.confidence < 0 ||
        item.confidence > 1)
    )
      throw new ProviderError('malformed')
    if (
      item.evidence !== undefined &&
      item.evidence !== null &&
      (!Array.isArray(item.evidence) ||
        item.evidence.length > 5 ||
        item.evidence.some(
          (excerpt) =>
            typeof excerpt !== 'string' || excerpt.length > 500 || !input.text.includes(excerpt),
        ))
    )
      throw new ProviderError('malformed')
  }
  if (result.uncertainty.some((item) => typeof item !== 'string' || item.length > 500))
    throw new ProviderError('malformed')
  return structuredClone(result)
}

function exactKeys(value: object, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  )
}
