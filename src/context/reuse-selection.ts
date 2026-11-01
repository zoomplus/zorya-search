import { ProviderError } from '../providers/contracts.js'
import type { JevAnswer, JevDecisionsPort, JevQuestion } from '../providers/decision-types.js'
import { isPinnedJevModel } from '../providers/decision-validation.js'

export function safeId(prefix: string, index: number): string {
  return `${prefix}${index.toString(36)}`
}

export function topAlternate(
  answer: JevAnswer | undefined,
  excluded: string,
  allowed: ReadonlySet<string>,
): string | undefined {
  if (!answer || answer.type !== 'choice' || !answer.probabilities) return undefined
  const ranked = Object.entries(answer.probabilities)
    .filter(([key, probability]) =>
      key !== excluded && allowed.has(key) && Number.isFinite(probability) && probability >= 0 && probability <= 1,
    )
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return ranked[0]?.[0]
}

export function choiceAnswer(
  answer: JevAnswer | undefined,
  allowed: ReadonlySet<string>,
): answer is Extract<JevAnswer, { type: 'choice' }> {
  return Boolean(answer && answer.type === 'choice' && allowed.has(answer.choice))
}

export function hasPinnedJevProfile(port: Pick<JevDecisionsPort, 'profile'>): boolean {
  return port.profile.provider.toLowerCase() === 'typesafe' && isPinnedJevModel(port.profile.model)
}

export function validateChoiceStageResult(
  value: unknown,
  questions: readonly Extract<JevQuestion, { type: 'choice' }>[],
  profile: JevDecisionsPort['profile'],
): Record<string, Extract<JevAnswer, { type: 'choice' }>> {
  if (!isRecord(value)) throw new ProviderError('malformed')
  if (
    value.provider !== 'TypeSafe' ||
    !isPinnedJevModel(profile.model) ||
    typeof value.model !== 'string' ||
    !isPinnedJevModel(value.model) ||
    !(typeof value.requestId === 'string' || value.requestId === null) ||
    (typeof value.requestId === 'string' && value.requestId.length > 256) ||
    !isRecord(value.usage) ||
    !validNullableCount(value.usage.inputTokens) ||
    !validNullableCount(value.usage.outputTokens) ||
    !validNullableCount(value.usage.totalTokens) ||
    !validNullableCost(value.usage.estimatedCost) ||
    !isRecord(value.answers)
  )
    throw new ProviderError('malformed')
  const questionIds = questions.map((question) => question.id)
  const answers = value.answers as Record<string, unknown>
  const answerIds = Object.keys(answers)
  if (answerIds.length !== questionIds.length || questionIds.some((id) => !Object.hasOwn(answers, id)))
    throw new ProviderError('malformed')
  const validated: Record<string, Extract<JevAnswer, { type: 'choice' }>> =
    Object.create(null) as Record<string, Extract<JevAnswer, { type: 'choice' }>>
  for (const question of questions) {
    const answer = answers[question.id]
    if (!isRecord(answer)) throw new ProviderError('malformed')
    if (
      answer.type !== 'choice' ||
      typeof answer.choice !== 'string' ||
      !Object.hasOwn(question.criteria, answer.choice) ||
      !hasOnlyKeys(answer, ['type', 'choice', 'confidence', 'probabilities', 'probabilityRoundingStep', 'probabilityBasis']) ||
      (answer.confidence !== undefined && !probability(answer.confidence)) ||
      (answer.probabilityRoundingStep !== undefined && answer.probabilityRoundingStep !== 0.01) ||
      (answer.probabilityBasis !== undefined &&
        !['distribution', 'rounded-distribution', 'provider-choice'].includes(String(answer.probabilityBasis)))
    )
      throw new ProviderError('malformed')
    if (answer.probabilities !== undefined) {
      if (
        !isRecord(answer.probabilities) ||
        answer.probabilityBasis === 'provider-choice' ||
        Object.keys(answer.probabilities).length !== Object.keys(question.criteria).length ||
        Object.keys(question.criteria).some((key) => !Object.hasOwn(answer.probabilities as object, key)) ||
        Object.values(answer.probabilities).some((entry) => !probability(entry))
      )
        throw new ProviderError('malformed')
    } else if (
      answer.probabilityBasis === 'distribution' ||
      answer.probabilityBasis === 'rounded-distribution' ||
      answer.probabilityRoundingStep !== undefined
    ) {
      throw new ProviderError('malformed')
    }
    validated[question.id] = structuredClone(answer) as Extract<JevAnswer, { type: 'choice' }>
  }
  return validated
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}
function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}
function validNullableCount(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0)
}
function validNullableCost(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}
