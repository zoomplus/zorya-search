import assert from 'node:assert/strict'
import test from 'node:test'
import { createSetupConfig, setupMode } from '../../src/cli/setup-config.js'
import { PROJECT_TEXT_RETRIEVAL_PRESET } from '../../src/providers/voyage.js'

test('new CLI setup enables local text retrieval and stores only the optional environment name', () => {
  const base = {
    dataDir: '/tmp/search-state',
    root: { id: 'repo', path: '/tmp/project' },
  }
  const lexical = createSetupConfig(base)
  assert.deepEqual(lexical.projectText, {})
  assert.equal(setupMode(lexical), 'lexical')

  const remoteText = createSetupConfig({ ...base, textEnv: 'VOYAGE_TEXT_KEY' })
  assert.deepEqual(remoteText.projectText, {
    embedding: {
      provider: 'openrouter',
      model: PROJECT_TEXT_RETRIEVAL_PRESET.embedding.model,
      dimensions: PROJECT_TEXT_RETRIEVAL_PRESET.embedding.dimensions,
      secret: { kind: 'env', name: 'VOYAGE_TEXT_KEY' },
    },
    reranker: {
      model: PROJECT_TEXT_RETRIEVAL_PRESET.reranker.model,
      secret: { kind: 'env', name: 'VOYAGE_TEXT_KEY' },
    },
  })
  assert.doesNotMatch(JSON.stringify(remoteText), /fixture-secret|sk-[A-Za-z0-9]/u)
  assert.throws(() => createSetupConfig({ ...base, textEnv: 'not an env name' }), /ENV_NAME_INVALID/u)
})
