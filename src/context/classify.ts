import type {
  ClassificationInput,
  ClassificationResult,
  Classifier,
  ProviderProfile,
} from '../providers/contracts.js'
import {
  validateClassificationInput,
  validateClassificationResult,
} from '../providers/classification-validation.js'
import { createLifecycle } from './lifecycle.js'

export interface ClassificationLimits {
  maxTextChars: number
  maxCriteriaChars: number
  maxExamples: number
  maxExampleChars: number
  maxLabels: number
  maxInputBytes: number
  maxConcurrency: number
  timeoutMs: number
}
const defaults: ClassificationLimits = {
  maxTextChars: 20000,
  maxCriteriaChars: 4000,
  maxExamples: 12,
  maxExampleChars: 1000,
  maxLabels: 32,
  maxInputBytes: 50000,
  maxConcurrency: 4,
  timeoutMs: 15000,
}

export function createClassificationTool(options: {
  classifier: Classifier
  limits?: Partial<ClassificationLimits>
}) {
  const limits = Object.freeze({ ...defaults, ...options.limits })
  for (const [key, value] of Object.entries(limits))
    if (!Number.isInteger(value) || value < 1)
      throw new TypeError(`Invalid classification limit: ${key}`)
  if (
    limits.maxTextChars > 100000 ||
    limits.maxCriteriaChars > 10000 ||
    limits.maxExamples > 20 ||
    limits.maxExampleChars > 4000 ||
    limits.maxLabels > 100 ||
    limits.maxInputBytes > 200000 ||
    limits.maxConcurrency > 16 ||
    limits.timeoutMs > 120000
  )
    throw new TypeError('Classification limits exceed hard caps')
  const classifier = options.classifier.classify.bind(options.classifier)
  const profile = deepFreeze(structuredClone(options.classifier.profile))
  const lifecycle = createLifecycle(limits.maxConcurrency)
  return {
    profile,
    classify(
      input: Omit<ClassificationInput, 'signal'> & { signal?: AbortSignal },
    ): Promise<ClassificationResult> {
      if (
        Object.keys(input).some(
          (key) =>
            ![
              'text',
              'labels',
              'criteria',
              'examples',
              'allowMultiple',
              'allowAbstain',
              'signal',
            ].includes(key),
        )
      )
        throw new TypeError('Unknown classification input field')
      const request = Object.freeze({
        ...input,
        labels: Object.freeze([...input.labels]) as unknown as string[],
        ...(input.examples
          ? {
              examples: Object.freeze(
                input.examples.map((example) => Object.freeze({ ...example })),
              ) as unknown as Array<{ text: string; label: string }>,
            }
          : {}),
      })
      validateInput(request, limits)
      return lifecycle.run(request.signal, limits.timeoutMs, async (signal) => {
        const result = await classifier({ ...request, signal })
        signal.throwIfAborted()
        const expected = {
          ...request,
          signal,
        } as ClassificationInput
        return validateClassificationResult(result, expected)
      })
    },
    close: () => lifecycle.close(),
  }
}

function validateInput(
  input: Omit<ClassificationInput, 'signal'> & { signal?: AbortSignal },
  limits: ClassificationLimits,
) {
  if (
    !input.text.trim() ||
    input.text.length > limits.maxTextChars ||
    !input.criteria.trim() ||
    input.criteria.length > limits.maxCriteriaChars ||
    input.labels.length < 2 ||
    input.labels.length > limits.maxLabels ||
    input.examples?.some(
      (example) => !example.text.trim() || example.text.length > limits.maxExampleChars,
    ) ||
    (input.examples?.length ?? 0) > limits.maxExamples
  )
    throw new TypeError('Invalid classification input')
  validateClassificationInput(
    { ...input, signal: input.signal ?? new AbortController().signal },
    limits.maxLabels,
    limits.maxInputBytes,
  )
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

export type ClassificationProfile = ProviderProfile
