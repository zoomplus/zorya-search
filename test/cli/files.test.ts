import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalConfigPath,
  ownerDir,
  pathWithin,
  writePrivateFile,
  readPrivateFile,
} from "../../src/cli/files.js";
import { createSetupConfig, setupMode } from "../../src/cli/setup-config.js";

test("CLI path containment uses canonical component boundaries", () => {
  assert.equal(pathWithin("/a/root", "/a/root/sub"), true);
  assert.equal(pathWithin("/a/root", "/a/rooted/file"), false);
  assert.equal(pathWithin("/a/root", "/a/root/..example"), true);
  assert.equal(pathWithin("/a/root", "/a/root/../rooted"), false);
});
test("owner state is unique per config file and future config paths resolve symlink ancestors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zorya-cli-paths-"));
  try {
    const configs = join(dir, "configs");
    await mkdir(configs);
    const first = join(configs, "first.json");
    const second = join(configs, "second.json");
    assert.notEqual(ownerDir(first), ownerDir(second));
    const target = join(dir, "target");
    const alias = join(dir, "alias");
    await mkdir(target);
    await symlink(target, alias, "dir");
    assert.equal(
      await canonicalConfigPath(join(alias, "new", "config.json")),
      join(target, "new", "config.json"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("private state writes are exclusive, bounded, and reject symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zorya-cli-test-"));
  try {
    const file = join(dir, "private.json");
    await writePrivateFile(file, "{}");
    assert.equal(await readPrivateFile(file), "{}");
    if (process.platform !== "win32")
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(writePrivateFile(file, "{}"), /STATE_EXISTS/);
    const link = join(dir, "link");
    await symlink(file, link);
    await assert.rejects(readPrivateFile(link), /STATE_FILE_UNSAFE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("CLI setup writes separate code and optional visual env references without choosing a generic model", () => {
  const lexical = createSetupConfig({
    dataDir: "/tmp/search-data",
    root: { id: "project", path: "/tmp/project" },
  });
  assert.equal(setupMode(lexical), "lexical");
  assert.equal("mechanism" in lexical, false);
  const code = createSetupConfig({
    dataDir: "/tmp/search-data",
    root: { id: "project", path: "/tmp/project" },
    codeEnv: "VOYAGE_CODE_KEY",
  });
  assert.deepEqual(code.mechanism, {
    code: { secret: { kind: "env", name: "VOYAGE_CODE_KEY" } },
  });
  assert.equal("embedding" in code, false);
  const visual = createSetupConfig({
    dataDir: "/tmp/search-data",
    root: { id: "project", path: "/tmp/project" },
    codeEnv: "VOYAGE_CODE_KEY",
    visualEnv: "VOYAGE_VISUAL_KEY",
  });
  assert.deepEqual(visual.mechanism, {
    code: { secret: { kind: "env", name: "VOYAGE_CODE_KEY" } },
    visual: { secret: { kind: "env", name: "VOYAGE_VISUAL_KEY" } },
  });
  assert.equal(setupMode(visual), "code+visual");
  const visualOnly = createSetupConfig({
    dataDir: "/tmp/search-data",
    root: { id: "project", path: "/tmp/project" },
    visualEnv: "VOYAGE_VISUAL_KEY",
  });
  assert.equal(setupMode(visualOnly), "visual");
  const custom = createSetupConfig({
    dataDir: "/tmp/search-data",
    root: { id: "project", path: "/tmp/project" },
    customEmbedding: {
      profileId: "owner-profile",
      model: "owner/embed-model",
      dimensions: 768,
      baseUrl: "https://embeddings.example/v1",
      env: "CUSTOM_EMBEDDING_KEY",
    },
    webReranker: { model: "owner/web-reranker", env: "WEB_RERANKER_KEY" },
    classifier: { model: "owner/classifier", env: "CLASSIFIER_KEY" },
    webEnv: "WEB_DISCOVERY_KEY",
  });
  assert.deepEqual(custom.embedding, {
    provider: "openai-compatible",
    profileId: "owner-profile",
    model: "owner/embed-model",
    dimensions: 768,
    baseUrl: "https://embeddings.example/v1",
    secret: { kind: "env", name: "CUSTOM_EMBEDDING_KEY" },
  });
  assert.deepEqual(custom.reranker, {
    model: "owner/web-reranker",
    secret: { kind: "env", name: "WEB_RERANKER_KEY" },
  });
  assert.deepEqual(custom.classifier, {
    model: "owner/classifier",
    secret: { kind: "env", name: "CLASSIFIER_KEY" },
  });
  assert.throws(
    () =>
      createSetupConfig({
        dataDir: "/tmp/search-data",
        root: { id: "project", path: "/tmp/project" },
        codeEnv: "VOYAGE_CODE_KEY",
        customEmbedding: {
          profileId: "owner-profile",
          model: "owner/model",
          dimensions: 768,
          baseUrl: "https://embeddings.example/v1",
          env: "CUSTOM_KEY",
        },
      }),
    /CODE_AND_CUSTOM_EMBEDDING_CONFLICT/,
  );
  assert.throws(
    () =>
      createSetupConfig({
        dataDir: "/tmp/search-data",
        root: { id: "project", path: "/tmp/project" },
        codeEnv: "bad-name",
      }),
    /ENV_NAME_INVALID/,
  );
});
