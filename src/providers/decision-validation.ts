import { ProviderError } from "./contracts.js";
import type {
  DecisionJson,
  JevAnswer,
  JevDecisionResult,
  JevQuestion,
} from "./decision-types.js";
import { validCost, validCount } from "./usage-values.js";

const ROUNDING_STEP = 0.01;
const MAX_QUESTIONS = 32;
const MAX_OPTIONS = 200;
const MAX_SCORE_LEVELS = 10;
const MAX_TEXT_LENGTH = 16_384;
const PINNED_MODEL = "typesafe/jev-1.14";

export function snapshotDecisionInput(
  state: unknown,
  questions: unknown,
  maxBytes = 131_072,
): { state: DecisionJson; questions: JevQuestion[] } {
  const budget = { nodes: 0, approximateBytes: 0, maxBytes };
  const stateCopy = copyJson(state, new Set(), 0, budget) as DecisionJson;
  const questionCopy = copyJson(questions, new Set(), 0, budget) as unknown;
  if (!Array.isArray(questionCopy) || questionCopy.length < 1 || questionCopy.length > MAX_QUESTIONS)
    throw new ProviderError("budget");
  const ids = new Set<string>();
  for (const question of questionCopy) {
    if (!isRecord(question) || typeof question.id !== "string" ||
      question.id.length < 1 || question.id.length > 96 || ids.has(question.id) ||
      typeof question.instructions !== "string" || !question.instructions.trim() ||
      question.instructions.length > MAX_TEXT_LENGTH)
      throw new ProviderError("budget");
    ids.add(question.id);
    if (question.type === "choice") {
      if (!hasOnlyKeys(question, ["id", "type", "instructions", "criteria"])) throw new ProviderError("budget");
      if (!isRecord(question.criteria)) throw new ProviderError("budget");
      const entries = Object.entries(question.criteria);
      if (entries.length < 2 || entries.length > MAX_OPTIONS || entries.some(([key, value]) =>
        !validText(key, 160) || !validText(value, MAX_TEXT_LENGTH)))
        throw new ProviderError("budget");
    } else if (question.type === "noul") {
      if (!hasOnlyKeys(question, ["id", "type", "instructions", "criteria"])) throw new ProviderError("budget");
      if (!isRecord(question.criteria) || Object.keys(question.criteria).length !== 2 ||
        !Object.hasOwn(question.criteria, "true") || !Object.hasOwn(question.criteria, "false") ||
        !validText(question.criteria.true, MAX_TEXT_LENGTH) || !validText(question.criteria.false, MAX_TEXT_LENGTH))
        throw new ProviderError("budget");
    } else if (question.type === "score") {
      if (!hasOnlyKeys(question, ["id", "type", "instructions", "criteria"])) throw new ProviderError("budget");
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 ||
        question.criteria.length > MAX_SCORE_LEVELS || question.criteria.some((value) => !validText(value, MAX_TEXT_LENGTH)))
        throw new ProviderError("budget");
    } else {
      throw new ProviderError("budget");
    }
  }
  return { state: stateCopy, questions: questionCopy as JevQuestion[] };
}

export function validateDecisionResponse(
  value: unknown,
  questions: readonly JevQuestion[],
): JevDecisionResult {
  if (!isRecord(value) || typeof value.model !== "string" || !isPinnedJevModel(value.model) ||
    value.provider !== "TypeSafe" || !isRecord(value.answers))
    throw new ProviderError("malformed");
  const responseAnswers = value.answers;
  const expected = questions.map(({ id }) => id);
  const actual = Object.keys(responseAnswers);
  if (actual.length !== expected.length || expected.some((id) => !Object.hasOwn(responseAnswers, id)))
    throw new ProviderError("malformed");
  const answers: Record<string, JevAnswer> = {};
  for (const question of questions) Object.defineProperty(answers, question.id, {
    value: validateAnswer(responseAnswers[question.id], question), enumerable: true, writable: true, configurable: true,
  });
  const rawUsage = isRecord(value.usage) ? value.usage : undefined;
  const inputTokens = validCount(rawUsage?.input_tokens ?? rawUsage?.prompt_tokens);
  const outputTokens = validCount(rawUsage?.output_tokens);
  const totalTokens = validCount(rawUsage?.total_tokens) ??
    combinedCount(inputTokens, outputTokens);
  const estimatedCost = validCost(rawUsage?.cost ?? rawUsage?.estimated_cost);
  return {
    requestId: typeof value.id === "string" && value.id.length <= 256 ? value.id : null,
    model: value.model,
    provider: "TypeSafe",
    answers,
    usage: { inputTokens: inputTokens ?? null, outputTokens: outputTokens ?? null, totalTokens: totalTokens ?? null, estimatedCost: estimatedCost ?? null },
  };
}

export function responseUsage(value: unknown): {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
  cost: number | undefined;
} {
  if (!isRecord(value) || !isRecord(value.usage)) return { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined, cost: undefined };
  return {
    inputTokens: validCount(value.usage.input_tokens ?? value.usage.prompt_tokens),
    outputTokens: validCount(value.usage.output_tokens),
    totalTokens: validCount(value.usage.total_tokens) ?? combinedCount(
      validCount(value.usage.input_tokens ?? value.usage.prompt_tokens),
      validCount(value.usage.output_tokens),
    ),
    cost: validCost(value.usage.cost ?? value.usage.estimated_cost),
  };
}

function validateAnswer(value: unknown, question: JevQuestion): JevAnswer {
  if (!isRecord(value) || value.type !== question.type) throw new ProviderError("malformed");
  if (question.type === "choice") {
    if (!hasOnlyKeys(value, ["type", "choice", "confidence", "probabilities"])) throw new ProviderError("malformed");
    if (typeof value.choice !== "string" || !Object.hasOwn(question.criteria, value.choice)) throw new ProviderError("malformed");
    const confidence = optionalProbability(value.confidence);
    if (value.probabilities === undefined)
      return { type: "choice", choice: value.choice, ...(confidence === undefined ? {} : { confidence }), probabilityBasis: "provider-choice" };
    const validated = validateDistribution(value.probabilities, Object.keys(question.criteria));
    const values = Object.values(validated.probabilities);
    const maximum = Math.max(...values);
    if (validated.probabilities[value.choice] !== maximum || values.filter((entry) => entry === maximum).length !== 1)
      throw new ProviderError("malformed");
    return {
      type: "choice", choice: value.choice,
      ...(confidence === undefined ? {} : { confidence }),
      probabilities: validated.probabilities,
      probabilityBasis: validated.rounded ? "rounded-distribution" : "distribution",
      ...(validated.rounded ? { probabilityRoundingStep: ROUNDING_STEP as 0.01 } : {}),
    };
  }
  if (question.type === "noul") {
    if (!hasOnlyKeys(value, ["type", "noul", "confidence"])) throw new ProviderError("malformed");
    if (!isProbability(value.noul)) throw new ProviderError("malformed");
    const confidence = optionalProbability(value.confidence);
    return { type: "noul", noul: value.noul, ...(confidence === undefined ? {} : { confidence }) };
  }
  if (!hasOnlyKeys(value, ["type", "score", "confidence", "probabilities", "legend"]) ||
    typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > question.criteria.length - 1)
    throw new ProviderError("malformed");
  const confidence = optionalProbability(value.confidence);
  const result: Extract<JevAnswer, { type: "score" }> = {
    type: "score", score: value.score,
    ...(confidence === undefined ? {} : { confidence }),
  };
  if (value.probabilities !== undefined) {
    const keys = question.criteria.map((_, index) => String(index));
    const validated = validateDistribution(value.probabilities, keys);
    const rawProbabilities = keys.map((key) => {
      const probability = validated.probabilities[key];
      if (probability === undefined) throw new ProviderError("malformed");
      return probability;
    });
    if (!scoreMatchesDistribution(value.score, rawProbabilities)) throw new ProviderError("malformed");
    result.probabilities = validated.probabilities;
    result.probabilityBasis = validated.rounded ? "rounded-distribution" : "distribution";
    if (validated.rounded) result.probabilityRoundingStep = ROUNDING_STEP;
  }
  if (value.legend !== undefined) {
    if (!isRecord(value.legend)) throw new ProviderError("malformed");
    const legend = value.legend;
    if (Object.keys(legend).length !== question.criteria.length ||
      question.criteria.some((label, index) => legend[String(index)] !== label))
      throw new ProviderError("malformed");
    result.legend = Object.fromEntries(question.criteria.map((label, index) => [String(index), label]));
  }
  return result;
}

function validateDistribution(value: unknown, keys: string[]): { probabilities: Record<string, number>; rounded: boolean } {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    throw new ProviderError("malformed");
  const probabilities: Record<string, number> = {};
  for (const key of keys) {
    const entry = value[key];
    if (!isProbability(entry)) throw new ProviderError("malformed");
    Object.defineProperty(probabilities, key, { value: entry, enumerable: true, writable: true, configurable: true });
  }
  const values = Object.values(probabilities);
  const total = values.reduce((sum, entry) => sum + entry, 0);
  const exact = Math.abs(total - 1) <= 1e-6;
  const rounded = !exact && admitsRoundedUnitMass(values);
  if (!exact && !rounded) throw new ProviderError("malformed");
  return { probabilities, rounded };
}

function admitsRoundedUnitMass(values: number[]): boolean {
  let lower = 0;
  let upper = 0;
  for (const value of values) {
    if (Math.abs(value - Math.round(value / ROUNDING_STEP) * ROUNDING_STEP) > 1e-12) return false;
    lower += Math.max(0, value - ROUNDING_STEP / 2);
    upper += Math.min(1, value + ROUNDING_STEP / 2);
  }
  return lower <= 1 + 1e-12 && upper >= 1 - 1e-12;
}

function scoreMatchesDistribution(score: number, probabilities: number[]): boolean {
  const roundedCells = probabilities.every(isRoundingLatticeValue);
  let minimum: number;
  let maximum: number;
  if (roundedCells) {
    const lows = probabilities.map((value) => Math.max(0, value - ROUNDING_STEP / 2));
    const highs = probabilities.map((value) => Math.min(1, value + ROUNDING_STEP / 2));
    const lowMass = lows.reduce((sum, value) => sum + value, 0);
    const highMass = highs.reduce((sum, value) => sum + value, 0);
    if (lowMass > 1 + 1e-12 || highMass < 1 - 1e-12) return false;
    minimum = weightedMeanAfterAllocating(lows, highs, Math.max(0, 1 - lowMass), false);
    maximum = weightedMeanAfterAllocating(lows, highs, Math.max(0, 1 - lowMass), true);
  } else {
    minimum = weightedMean(probabilities);
    maximum = minimum;
  }
  const roundedScore = isRoundingLatticeValue(score);
  const tolerance = roundedScore ? ROUNDING_STEP / 2 : 1e-9;
  const scoreMinimum = Math.max(0, score - tolerance);
  const scoreMaximum = Math.min(probabilities.length - 1, score + tolerance);
  return maximum + 1e-12 >= scoreMinimum && minimum - 1e-12 <= scoreMaximum;
}

function weightedMeanAfterAllocating(
  lows: number[],
  highs: number[],
  remainingMass: number,
  highestFirst: boolean,
): number {
  let mean = weightedMean(lows);
  let remaining = remainingMass;
  for (let offset = 0; offset < lows.length && remaining > 1e-12; offset++) {
    const index = highestFirst ? lows.length - offset - 1 : offset;
    const low = lows[index];
    const high = highs[index];
    if (low === undefined || high === undefined) throw new ProviderError("malformed");
    const extra = Math.min(remaining, high - low);
    mean += extra * index;
    remaining -= extra;
  }
  if (remaining > 1e-9) throw new ProviderError("malformed");
  return mean;
}

function weightedMean(probabilities: number[]): number {
  return probabilities.reduce((sum, value, index) => sum + value * index, 0);
}

function isRoundingLatticeValue(value: number): boolean {
  return Math.abs(value - Math.round(value / ROUNDING_STEP) * ROUNDING_STEP) <= 1e-12;
}

export function isPinnedJevModel(value: string): boolean {
  if (value === PINNED_MODEL) return true;
  const match = /^typesafe\/jev-1\.14-(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 2000 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function copyJson(value: unknown, active: Set<object>, depth: number, budget: { nodes: number; approximateBytes: number; maxBytes: number }): unknown {
  budget.nodes++;
  if (depth > 64 || budget.nodes > 50_000) throw new ProviderError("budget");
  if (value === null || typeof value === "boolean") {
    budget.approximateBytes += 5;
    if (budget.approximateBytes > budget.maxBytes) throw new ProviderError("budget");
    return value;
  }
  if (typeof value === "string") {
    budget.approximateBytes += Buffer.byteLength(value) + 2;
    if (budget.approximateBytes > budget.maxBytes) throw new ProviderError("budget");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProviderError("budget");
    budget.approximateBytes += String(value).length;
    if (budget.approximateBytes > budget.maxBytes) throw new ProviderError("budget");
    return value;
  }
  if (typeof value !== "object" || active.has(value)) throw new ProviderError("budget");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new ProviderError("budget");
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key))))
        throw new ProviderError("budget");
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new ProviderError("budget");
        result.push(copyJson(descriptor.value, active, depth + 1, budget));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new ProviderError("budget");
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new ProviderError("budget");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new ProviderError("budget");
      budget.approximateBytes += Buffer.byteLength(key) + 3;
      if (budget.approximateBytes > budget.maxBytes) throw new ProviderError("budget");
      result[key] = copyJson(descriptor.value, active, depth + 1, budget);
    }
    return result;
  } finally {
    active.delete(value);
  }
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function optionalProbability(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!isProbability(value)) throw new ProviderError("malformed");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function combinedCount(input: number | undefined, output: number | undefined): number | undefined {
  if (input === undefined || output === undefined) return undefined;
  const total = input + output;
  return Number.isSafeInteger(total) ? total : undefined;
}
