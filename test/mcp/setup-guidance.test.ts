import assert from 'node:assert/strict'
import test from 'node:test'
import { getSearchMcpSetupHint, SEARCH_SETUP_CAPABILITIES } from '../../src/mcp/setup-guidance.js'

test('setup guidance exposes only supported stable enum actions and safe owner instructions', () => {
  assert.deepEqual(SEARCH_SETUP_CAPABILITIES, [
    'project-text', 'web-read', 'web-discovery', 'visual', 'code-embeddings', 'project-text-embeddings', 'jev-classification',
  ])
  const hints = SEARCH_SETUP_CAPABILITIES.map(getSearchMcpSetupHint)
  assert.deepEqual(hints.map((hint) => hint.capability), [...SEARCH_SETUP_CAPABILITIES])
  assert.ok(hints.every((hint) => hint.providerProbe === false))
  assert.ok(hints.every((hint) => hint.action.requiresConsent && hint.action.configScope === 'same-server-profile'))
  assert.ok(hints.every((hint) => hint.action.commandName === 'zorya-search' && hint.action.args[0] === 'configure' && hint.action.args[1] === '--capability' && hint.action.args[2] === hint.capability))
  assert.equal(getSearchMcpSetupHint('web-read').requiredGrant, 'web')
  assert.deepEqual(getSearchMcpSetupHint('web-read').requiredOperations, ['web'])
  assert.equal(getSearchMcpSetupHint('web-read').action.secretRequired, false)
  assert.equal(getSearchMcpSetupHint('project-text').requiredGrant, 'read')
  assert.equal(getSearchMcpSetupHint('project-text').action.secretRequired, false)
  assert.equal(getSearchMcpSetupHint('web-discovery').requiredGrant, 'web')
  assert.equal(getSearchMcpSetupHint('web-discovery').action.provider, 'Brave Search')
  assert.equal(getSearchMcpSetupHint('web-discovery').action.secretEntry, 'hidden-owner-terminal-or-explicit-env-reference')
  assert.equal(getSearchMcpSetupHint('visual').requiredGrant, 'visual')
  assert.equal(getSearchMcpSetupHint('visual').action.provider, 'OpenRouter')
  assert.equal(getSearchMcpSetupHint('visual').action.modelProvider, 'Voyage')
  assert.equal(getSearchMcpSetupHint('code-embeddings').action.provider, 'OpenRouter')
  assert.equal(getSearchMcpSetupHint('code-embeddings').action.modelProvider, 'Voyage')
  assert.equal(getSearchMcpSetupHint('jev-classification').requiredGrant, 'classify')
  assert.equal(getSearchMcpSetupHint('jev-classification').action.provider, 'OpenRouter')
  assert.equal(getSearchMcpSetupHint('jev-classification').action.modelProvider, 'TypeSafe')
  assert.ok(hints.every((hint) => !JSON.stringify(hint).match(/token|secretValue|\/root\//iu)))
})
