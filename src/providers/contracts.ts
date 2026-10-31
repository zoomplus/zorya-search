import type {
  SearchModels,
  SourceDocument,
  WebSource,
} from "../core/contracts.js";

export type ProviderErrorCode =
  | "auth"
  | "quota"
  | "rate_limit"
  | "timeout"
  | "cancel"
  | "malformed"
  | "unavailable"
  | "budget";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: ProviderErrorCode, status?: number, retryAfterMs?: number) {
    super(
      `Ошибка адаптера провайдера (${code}${status ? `, HTTP ${status}` : ""})`,
    );
    this.name = "ProviderError";
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export interface ProviderProfile {
  provider: string;
  model: string;
  profileId?: string;
  dimensions?: number;
  inputType?: string;
  routing?: Record<string, unknown>;
  space: string;
}

export interface ProviderLimits {
  maxItems?: number;
  maxInputBytes?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
  attempts?: number;
  concurrency?: number;
}

export interface ProviderUsage {
  calls: number;
  inputTokens: number | null;
  totalTokens: number | null;
  estimatedCost: number | null;
  latencyMs: number;
}

export interface ProviderSnapshot {
  readonly profile: ProviderProfile;
  usage(): ProviderUsage;
}

export interface ClassificationInput {
  text: string;
  labels: string[];
  criteria: string;
  examples?: Array<{ text: string; label: string }>;
  allowMultiple?: boolean;
  allowAbstain?: boolean;
  signal: AbortSignal;
}

export interface ClassificationResult {
  labels: Array<{
    label: string;
    confidence?: number | null;
    evidence?: string[] | null;
  }>;
  abstained: boolean;
  uncertainty: string[];
}

export interface Classifier {
  readonly profile: ProviderProfile;
  usage(): ProviderUsage;
  classify(input: ClassificationInput): Promise<ClassificationResult>;
}

export interface SearchProviderSet {
  models: SearchModels;
  web: WebSource;
  classifier: Classifier;
}

export type { SourceDocument };
