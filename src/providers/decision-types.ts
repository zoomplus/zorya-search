import type { ProviderProfile, ProviderUsage } from "./contracts.js";

export type DecisionJson =
  | null
  | boolean
  | number
  | string
  | DecisionJson[]
  | { [key: string]: DecisionJson };

export type JevQuestion =
  | {
      id: string;
      type: "choice";
      instructions: string;
      criteria: Record<string, string>;
    }
  | {
      id: string;
      type: "noul";
      instructions: string;
      criteria: { true: string; false: string };
    }
  | {
      id: string;
      type: "score";
      instructions: string;
      criteria: string[];
    };

export type JevAnswer =
  | {
      type: "choice";
      choice: string;
      confidence?: number;
      probabilities?: Record<string, number>;
      probabilityRoundingStep?: 0.01;
      probabilityBasis?: "distribution" | "rounded-distribution" | "provider-choice";
    }
  | { type: "noul"; noul: number; confidence?: number }
  | {
      type: "score";
      score: number;
      confidence?: number;
      probabilities?: Record<string, number>;
      legend?: Record<string, string>;
      probabilityRoundingStep?: 0.01;
      probabilityBasis?: "distribution" | "rounded-distribution";
    };

export interface JevDecisionResult {
  requestId: string | null;
  model: string;
  provider: "TypeSafe";
  answers: Record<string, JevAnswer>;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    estimatedCost: number | null;
  };
}

export interface JevDecisionsPort {
  readonly profile: ProviderProfile;
  usage(): ProviderUsage;
  decide(input: {
    state: DecisionJson;
    questions: JevQuestion[];
    signal: AbortSignal;
  }): Promise<JevDecisionResult>;
}
