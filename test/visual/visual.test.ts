import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createVisualSearch, VisualSearchError } from '../../src/visual/index.js'
import type { ProviderProfile } from '../../src/providers/contracts.js'
import { OperationLimitError, OperationTimeoutError } from '../../src/context/lifecycle.js'

const profile: ProviderProfile = {
  provider: 'test',
  model: 'image-v1',
  profileId: 'visual-profile-v1',
  space: 'visual:test',
  dimensions: 2,
  inputType: 'image-text',
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const ref = (id: string, text: string) => ({ id, contentHash: hash(text), text })
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('visual retrieval is disabled by default and explicit metadata mode is relevant lexical retrieval', async () => {
  const disabled = createVisualSearch()
  await assert.rejects(
    disabled.search({ text: 'button' }),
    (error) => error instanceof VisualSearchError && error.code === 'DISABLED',
  )
  const unconfigured = createVisualSearch({
    embedding: { profile: {} as ProviderProfile, embed: async () => [] },
  })
  await assert.rejects(
    unconfigured.search({ text: 'button' }),
    (error) => error instanceof VisualSearchError && error.code === 'DISABLED',
  )
  const visual = createVisualSearch({ enabled: true })
  await visual.upsert({
    reference: { ...ref('button-a', 'primary save button'), screen: 'settings' },
  })
  await visual.upsert({ reference: { ...ref('button-b', 'cancel dialog'), screen: 'settings' } })
  const result = await visual.search({ text: 'save', filters: { screen: 'settings' } })
  assert.equal(result.mode, 'metadata-lexical')
  assert.match(result.results[0]?.uncertainty ?? '', /no semantic image retrieval/)
  assert.equal(result.results[0]?.reference.id, 'button-a')
  assert.equal(result.results.length, 1)
  await assert.rejects(
    visual.search({ image: { bytes: new Uint8Array([1]), mimeType: 'image/png' } }),
    (error) => error instanceof VisualSearchError && error.code === 'IMAGE_QUERY_UNSUPPORTED',
  )
  await visual.remove('button-a')
  assert.equal((await visual.search({ text: 'save' })).results.length, 0)
  await disabled.close()
  await visual.close()
})

test('visual vectors use an isolated snapshotted profile and replace stored references', async () => {
  const mutableProfile = { ...profile }
  let inputCalls = 0
  const embed = {
    profile: mutableProfile,
    embed: async ({ texts, images }: { texts?: string[]; images?: unknown[] }) => {
      inputCalls++
      return Array.from({ length: texts?.length ?? images?.length ?? 0 }, (_, i) =>
        i === 0 ? [1, 0] : [0, 1],
      )
    },
  }
  const visual = createVisualSearch({ enabled: true, embedding: embed, profile: mutableProfile })
  mutableProfile.provider = 'mutated-provider'
  mutableProfile.model = 'mutated-model'
  embed.profile.dimensions = 8192
  await visual.upsert({ reference: ref('card', 'old state') })
  await visual.upsert({ reference: { ...ref('card', 'new state'), screen: 'settings' } })
  const result = await visual.search({ text: 'new state', filters: { screen: 'settings' } })
  assert.equal(
    result.profile,
    JSON.stringify(['test', 'image-v1', 'visual-profile-v1', 'visual:test', 2, 'image-text']),
  )
  assert.equal(result.results[0]?.contentHash, hash('new state'))
  assert.equal(inputCalls, 3)
  await visual.remove('card')
  assert.equal((await visual.search({ text: 'new state' })).results.length, 0)
  await visual.close()
})

test('embedding ports backed by class private fields retain their original receiver', async () => {
  class PrivatePort {
    readonly profile = { ...profile }
    #calls = 0
    async embed(input: { texts?: string[]; images?: Array<{ bytes: Uint8Array }> }) {
      this.#calls++
      assert.ok(input.texts || input.images)
      return [[1, 0]]
    }
    get calls() {
      return this.#calls
    }
  }
  const port = new PrivatePort()
  const visual = createVisualSearch({ enabled: true, embedding: port, profile: port.profile })
  await visual.upsert({ reference: ref('private', 'saved') })
  await visual.search({ text: 'saved' })
  assert.equal(port.calls, 2)
  await visual.close()
})

test('visual profiles enforce identity fields, bounded dimensions, and collision-safe role identity', async () => {
  const source = {
    provider: 'a:b',
    model: 'c',
    space: 'same',
    dimensions: 2,
    inputType: 'image-text',
  }
  const one = createVisualSearch({
    enabled: true,
    embedding: { profile: source, embed: async () => [[1, 0]] },
    profile: source,
  })
  const otherProfile = {
    provider: 'a',
    model: 'b:c',
    space: 'same',
    dimensions: 2,
    inputType: 'image-text',
  }
  const two = createVisualSearch({
    enabled: true,
    embedding: { profile: otherProfile, embed: async () => [[1, 0]] },
    profile: otherProfile,
  })
  await one.upsert({ reference: ref('one', 'value') })
  await two.upsert({ reference: ref('two', 'value') })
  assert.notEqual(
    (await one.search({ text: 'value' })).profile,
    (await two.search({ text: 'value' })).profile,
  )
  assert.throws(
    () =>
      createVisualSearch({
        enabled: true,
        embedding: { profile: { ...profile, dimensions: 8193 }, embed: async () => [[1]] },
        profile: { ...profile, dimensions: 8193 },
      }),
    /dimensions/,
  )
  assert.throws(
    () =>
      createVisualSearch({
        enabled: true,
        embedding: { profile: { ...profile, provider: '' }, embed: async () => [[1, 0]] },
        profile: { ...profile, provider: '' },
      }),
    /profile/,
  )
  assert.notEqual(one, two)
  await one.close()
  await two.close()
})

test('reference, filter, and image schemas are bounded, strict, and copy caller bytes before awaits', async () => {
  let resolveEmbedding!: (value: number[][]) => void
  let received: Uint8Array | undefined
  const visual = createVisualSearch({
    enabled: true,
    embedding: {
      profile,
      embed: async ({
        texts,
        images,
      }: {
        texts?: string[]
        images?: Array<{ bytes: Uint8Array }>
      }) => {
        if (texts) return [[1, 0]]
        received = images?.[0]?.bytes
        return new Promise((resolve) => (resolveEmbedding = resolve))
      },
    },
    profile,
  })
  await assert.rejects(
    visual.upsert({ reference: { ...ref('extra', 'x'), raw: 'secret' } as never }),
    /reference/,
  )
  await assert.rejects(
    visual.search({ text: 'x', filters: { screen: 'x', unsafe: true } as never }),
    /filters/,
  )
  await assert.rejects(
    visual.upsert({
      reference: ref('bad-image', 'x'),
      image: { bytes: new Uint8Array([1]), mimeType: 'application/octet-stream' },
    }),
    /image/,
  )
  const bytes = Buffer.from([1, 2, 3])
  const imageRef = { id: 'image', contentHash: createHash('sha256').update(bytes).digest('hex') }
  const updating = visual.upsert({ reference: imageRef, image: { bytes, mimeType: 'image/png' } })
  await tick()
  bytes.fill(9)
  assert.deepEqual([...received!], [1, 2, 3])
  resolveEmbedding([[1, 0]])
  await updating
  const result = await visual.search({ text: 'metadata', limit: 1 })
  assert.equal(result.results.length, 1)
  assert.deepEqual(Object.keys(result.results[0]!.reference).sort(), ['contentHash', 'id'])
  await visual.close()
})

test('malformed provider vectors are rejected before storage', async () => {
  for (const vector of [[], [0, 0], [1], [Number.NaN, 0], [1.7e308, 1.7e308]]) {
    const visual = createVisualSearch({
      enabled: true,
      embedding: { profile, embed: async () => [vector] },
      profile,
    })
    await assert.rejects(
      visual.upsert({ reference: ref('row', 'value') }),
      /Malformed visual embedding/,
    )
    await visual.close()
  }
})

test('metadata rows and total storage obey configured limits', async () => {
  const visual = createVisualSearch({ enabled: true, limits: { maxItems: 1, maxTotalBytes: 1000 } })
  await visual.upsert({ reference: ref('first', 'one') })
  await assert.rejects(
    visual.upsert({ reference: ref('second', 'two') }),
    (error) => error instanceof VisualSearchError && error.code === 'LIMIT',
  )
  await assert.rejects(
    visual.upsert({ reference: ref('first', 'x'.repeat(4001)) }),
    (error) => error instanceof VisualSearchError && error.code === 'LIMIT',
  )
  await visual.close()
})

test('pre-aborted calls do not reach embedding; concurrency, timeout, and close join physical work', async () => {
  let calls = 0
  const visual = createVisualSearch({
    enabled: true,
    profile,
    embedding: {
      profile,
      embed: async ({ signal }) => {
        calls++
        return new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        )
      },
    },
    limits: { maxConcurrency: 1, timeoutMs: 30 },
  })
  const aborted = new AbortController()
  aborted.abort(new Error('already cancelled'))
  await assert.rejects(visual.upsert({ reference: ref('pre', 'cancel'), signal: aborted.signal }))
  assert.equal(calls, 0)
  const first = visual.upsert({ reference: ref('first', 'one') })
  await tick()
  await assert.rejects(visual.search({ text: 'one' }), OperationLimitError)
  await assert.rejects(first, OperationTimeoutError)
  assert.equal(calls, 1)
  const hanging = visual.upsert({ reference: ref('closing', 'two') })
  await tick()
  const closing = visual.close()
  await assert.rejects(hanging)
  await closing
  assert.equal(calls, 2)
})

test('superseded updates and removal cannot resurrect references', async () => {
  const pending: Array<(value: number[][]) => void> = []
  const visual = createVisualSearch({
    enabled: true,
    profile,
    embedding: {
      profile,
      embed: async ({ texts }: { texts?: string[] }) => {
        if (texts?.[0] === 'another query') return [[1, 0]]
        return new Promise((resolve) => pending.push(resolve))
      },
    },
  })
  const oldUpdate = visual.upsert({ reference: ref('item', 'old') })
  await tick()
  const newUpdate = visual.upsert({ reference: ref('item', 'new') })
  await tick()
  pending[0]!([[1, 0]])
  await assert.rejects(oldUpdate)
  pending[1]!([[0, 1]])
  await newUpdate
  const oldQuery = visual.search({ text: 'query' })
  await tick()
  const removal = visual.remove('item')
  await removal
  pending[2]!([[1, 0]])
  await assert.rejects(
    oldQuery,
    (error) => error instanceof VisualSearchError && error.code === 'STALE',
  )
  assert.equal((await visual.search({ text: 'another query' })).results.length, 0)
  await visual.close()
})

test('an update started during query embedding invalidates the captured old reference', async () => {
  const pending: Array<(value: number[][]) => void> = []
  const visual = createVisualSearch({
    enabled: true,
    profile,
    embedding: {
      profile,
      embed: async ({ texts }: { texts?: string[] }) => {
        if (texts?.[0] === 'seed' || texts?.[0] === 'replacement') return [[1, 0]]
        return new Promise((resolve) => pending.push(resolve))
      },
    },
  })
  await visual.upsert({ reference: ref('item', 'seed') })
  const search = visual.search({ text: 'slow query' })
  await tick()
  const update = visual.upsert({ reference: ref('item', 'replacement') })
  await tick()
  pending[0]!([[1, 0]])
  await assert.rejects(
    search,
    (error) => error instanceof VisualSearchError && error.code === 'STALE',
  )
  await update
  assert.equal(
    (await visual.search({ text: 'replacement' })).results[0]?.contentHash,
    hash('replacement'),
  )
  await visual.close()
})

test('pending metadata-only upserts are also joined by close', async () => {
  const visual = createVisualSearch({ enabled: true, limits: { maxConcurrency: 1 } })
  const update = visual.upsert({ reference: ref('row', 'metadata') })
  const closing = visual.close()
  await assert.rejects(update)
  await closing
  await assert.rejects(
    visual.search({ text: 'metadata' }),
    (error) => error instanceof VisualSearchError && error.code === 'CLOSED',
  )
})

test('every close caller waits for the same terminal settlement of a slow provider port', async () => {
  let resolveProvider!: (value: number[][]) => void
  let enteredProvider!: () => void
  const entered = new Promise<void>((resolve) => (enteredProvider = resolve))
  const visual = createVisualSearch({
    enabled: true,
    profile,
    embedding: {
      profile,
      embed: async () => {
        enteredProvider()
        return new Promise((resolve) => (resolveProvider = resolve))
      },
    },
  })
  const update = visual.upsert({ reference: ref('slow', 'pending') })
  await entered
  let firstSettled = false
  let secondSettled = false
  const firstClose = visual.close().then(() => (firstSettled = true))
  const secondClose = visual.close().then(() => (secondSettled = true))
  await tick()
  assert.equal(firstSettled, false)
  assert.equal(secondSettled, false)
  resolveProvider([[1, 0]])
  await assert.rejects(update)
  await Promise.all([firstClose, secondClose])
  assert.equal(firstSettled, true)
  assert.equal(secondSettled, true)
})
