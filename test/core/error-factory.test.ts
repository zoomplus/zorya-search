import assert from 'node:assert/strict'
import test from 'node:test'
import { createCompatibleErrorFactory } from '../../src/index.js'

test('compatible error factory constructs the host error class with unchanged code and message', () => {
  class ElementError extends Error { constructor(readonly code: string, message: string) { super(message) } }
  const error = createCompatibleErrorFactory(ElementError)('SEARCH_CLOSED', 'Search service is closed')
  assert.equal(error instanceof ElementError, true)
  assert.equal((error as ElementError).code, 'SEARCH_CLOSED')
  assert.equal(error.message, 'Search service is closed')
})
