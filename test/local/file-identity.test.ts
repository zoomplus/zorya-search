import assert from 'node:assert/strict'
import test from 'node:test'
import { fileIdentitySchema, serializeFileIdentity } from '../../src/local/file-identity.js'

test('filesystem identities keep adjacent values above the safe integer limit distinct', () => {
  const first = fileIdentitySchema.parse({ dev: '9007199254740992', ino: '9007199254740993' })
  const second = fileIdentitySchema.parse({ dev: '9007199254740993', ino: '9007199254740992' })

  assert.notEqual(first.dev, second.dev)
  assert.notEqual(first.ino, second.ino)
  assert.deepEqual(serializeFileIdentity(first), { dev: '9007199254740992', ino: '9007199254740993' })
})

test('filesystem identities read safe legacy numbers exactly and reject unsafe legacy numbers', () => {
  const legacy = fileIdentitySchema.parse({ dev: 12, ino: Number.MAX_SAFE_INTEGER })
  assert.deepEqual(serializeFileIdentity(legacy), { dev: '12', ino: '9007199254740991' })

  assert.equal(fileIdentitySchema.safeParse({ dev: 12, ino: Number.MAX_SAFE_INTEGER + 1 }).success, false)
  assert.equal(fileIdentitySchema.safeParse({ dev: '01', ino: '1' }).success, false)
  assert.equal(fileIdentitySchema.safeParse({ dev: '-1', ino: '1' }).success, false)
  assert.equal(fileIdentitySchema.safeParse({ dev: '1'.repeat(40), ino: '1' }).success, false)
})
