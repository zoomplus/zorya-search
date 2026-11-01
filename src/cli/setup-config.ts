import { isAbsolute } from "node:path";

type EnvSecret = { kind: "env"; name: string };
type RootConfig = {
  id: string;
  path: string;
  exclude?: string[];
  limits?: { maxFiles?: number; maxChunks?: number; maxScanChunks?: number };
  watch?: boolean;
  watchIntervalMs?: number;
};

type NamedModelInput = { model: string; env: string };
type CustomEmbeddingInput = {
  profileId: string;
  model: string;
  dimensions: number;
  baseUrl: string;
  env: string;
};
type WebEmbeddingInput = {
  model: string;
  dimensions: number;
  env: string;
  profileId?: string;
  baseUrl?: string;
};

export interface SetupConfigInput {
  dataDir: string;
  root: RootConfig;
  codeEnv?: string;
  visualEnv?: string;
  webEnv?: string;
  webReranker?: NamedModelInput;
  classifier?: NamedModelInput;
  customEmbedding?: CustomEmbeddingInput;
  webEmbedding?: WebEmbeddingInput;
}

const envName = /^[A-Z_][A-Z0-9_]{0,127}$/;
const secret = (name: string): EnvSecret => {
  if (!envName.test(name)) throw new Error("ENV_NAME_INVALID");
  return { kind: "env", name };
};
function boundedName(value: string, code: string) {
  if (value.length < 1 || value.length > 256 || !value.trim())
    throw new Error(code);
}
function namedModel(input: NamedModelInput, code: string) {
  boundedName(input.model, code);
  return { model: input.model, secret: secret(input.env) };
}
function embeddingFields(input: {
  model: string;
  dimensions: number;
}) {
  boundedName(input.model, "CUSTOM_MODEL_INVALID");
  if (
    !Number.isInteger(input.dimensions) ||
    input.dimensions < 1 ||
    input.dimensions > 4096
  )
    throw new Error("CUSTOM_DIMENSIONS_INVALID");
  return {
    model: input.model,
    dimensions: input.dimensions,
  };
}
function customEmbedding(input: CustomEmbeddingInput) {
  boundedName(input.profileId, "CUSTOM_PROFILE_INVALID");
  const fields = embeddingFields(input);
  let endpoint: URL;
  try {
    endpoint = new URL(input.baseUrl);
  } catch {
    throw new Error("CUSTOM_ENDPOINT_INVALID");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    input.baseUrl.length > 2048
  )
    throw new Error("CUSTOM_ENDPOINT_INVALID");
  return {
    provider: "openai-compatible",
    profileId: input.profileId,
    ...fields,
    baseUrl: input.baseUrl,
    secret: secret(input.env),
  };
}
function webEmbedding(input: WebEmbeddingInput) {
  const customProfile = input.profileId !== undefined;
  const customEndpoint = input.baseUrl !== undefined;
  if (customProfile !== customEndpoint)
    throw new Error("WEB_EMBEDDING_CUSTOM_OPTIONS_PAIRED");
  if (customProfile && customEndpoint)
    return customEmbedding({
      profileId: input.profileId!,
      model: input.model,
      dimensions: input.dimensions,
      baseUrl: input.baseUrl!,
      env: input.env,
    });

  return {
    provider: "openrouter",
    ...embeddingFields(input),
    secret: secret(input.env),
  };
}

export function createSetupConfig(input: SetupConfigInput) {
  if (!isAbsolute(input.dataDir) || !isAbsolute(input.root.path))
    throw new Error("CONFIG_PATH_INVALID");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(input.root.id))
    throw new Error("ROOT_ID_INVALID");
  if (input.codeEnv && input.customEmbedding)
    throw new Error("CODE_AND_CUSTOM_EMBEDDING_CONFLICT");
  if (input.webEmbedding && !input.webEnv)
    throw new Error("WEB_EMBEDDING_REQUIRES_WEB_DISCOVERY");
  const config: Record<string, unknown> = {
    version: 1,
    dataDir: input.dataDir,
    roots: [input.root],
  };
  const mechanism: Record<string, unknown> = {};
  if (input.codeEnv) mechanism.code = { secret: secret(input.codeEnv) };
  if (input.visualEnv) mechanism.visual = { secret: secret(input.visualEnv) };
  if (Object.keys(mechanism).length) config.mechanism = mechanism;
  if (input.customEmbedding)
    config.embedding = customEmbedding(input.customEmbedding);
  if (input.webEnv || input.webEmbedding)
    config.web = {
      ...(input.webEnv ? { discovery: { secret: secret(input.webEnv) } } : {}),
      ...(input.webEmbedding
        ? { embedding: webEmbedding(input.webEmbedding) }
        : {}),
    };
  if (input.webReranker)
    config.reranker = namedModel(input.webReranker, "WEB_RERANKER_INVALID");
  if (input.classifier)
    config.classifier = namedModel(input.classifier, "CLASSIFIER_INVALID");
  return config;
}

export function setupMode(config: Record<string, unknown>) {
  const mechanism = config.mechanism as Record<string, unknown> | undefined;
  const code = Boolean(mechanism?.code);
  const visual = Boolean(mechanism?.visual);
  if (code && visual) return "code+visual";
  if (visual) return "visual";
  if (code) return "code";
  if (config.embedding) return "custom-embedding";
  return "lexical";
}
