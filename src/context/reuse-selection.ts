import { ProviderError } from '../providers/contracts.js'
import type { JevAnswer, JevDecisionsPort, JevQuestion } from '../providers/decision-types.js'
import { isPinnedJevModel } from '../providers/decision-validation.js'

export function safeId(prefix: string, index: number): string {
  return `${prefix}${index.toString(36)}`
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
  const answers = validateResultEnvelope(value, questions, profile)
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

export function validateNoulStageResult(
  value: unknown,
  questions: readonly Extract<JevQuestion, { type: 'noul' }>[],
  profile: JevDecisionsPort['profile'],
): Record<string, Extract<JevAnswer, { type: 'noul' }>> {
  const answers = validateResultEnvelope(value, questions, profile)
  if (Object.keys(answers).length !== questions.length || questions.some((question) => !Object.hasOwn(answers, question.id)))
    throw new ProviderError('malformed')
  const validated: Record<string, Extract<JevAnswer, { type: 'noul' }>> = Object.create(null) as Record<string, Extract<JevAnswer, { type: 'noul' }>>
  for (const question of questions) {
    const answer = answers[question.id]
    if (!isRecord(answer) || answer.type !== 'noul' || !hasOnlyKeys(answer, ['type', 'noul', 'confidence']) ||
        !probability(answer.noul) || (answer.confidence !== undefined && !probability(answer.confidence)))
      throw new ProviderError('malformed')
    validated[question.id] = structuredClone(answer) as Extract<JevAnswer, { type: 'noul' }>
  }
  return validated
}

function validateResultEnvelope(
  value: unknown,
  questions: readonly JevQuestion[],
  profile: JevDecisionsPort['profile'],
): Record<string, unknown> {
  if (!isRecord(value) || value.provider !== 'TypeSafe' || !isPinnedJevModel(profile.model) ||
      typeof value.model !== 'string' || !isPinnedJevModel(value.model) ||
      !(typeof value.requestId === 'string' || value.requestId === null) ||
      (typeof value.requestId === 'string' && value.requestId.length > 256) ||
      !isRecord(value.usage) || !validNullableCount(value.usage.inputTokens) ||
      !validNullableCount(value.usage.outputTokens) || !validNullableCount(value.usage.totalTokens) ||
      !validNullableCost(value.usage.estimatedCost) || !isRecord(value.answers))
    throw new ProviderError('malformed')
  const answers = value.answers
  if (Object.keys(answers).length !== questions.length || questions.some((question) => !Object.hasOwn(answers, question.id)))
    throw new ProviderError('malformed')
  return answers
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
