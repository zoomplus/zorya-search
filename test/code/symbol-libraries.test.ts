import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import ts from 'typescript'
import { extractCodeSymbols } from '../../src/code/symbol-extraction.js'
import {
  loadTypeScriptLibraryBundle,
  TYPE_SCRIPT_LIBRARY_LIMITS,
  type TypeScriptLibraryBundle,
} from '../../src/code/symbol-libraries.js'
import type { VerifiedSymbolSource } from '../../src/code/symbol-types.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const source = (path: string, text: string): VerifiedSymbolSource => ({ path, text, hash: hash(text) })
const input = source(
  'initiative.ts',
  `interface RuntimeModels { initiative(reason: string): string }
type InitiativeDecisionInputs = { models: Pick<RuntimeModels, 'initiative'> }
type ReadonlyInput = Readonly<InitiativeDecisionInputs>
type PartialInput = Partial<ReadonlyInput>
export function use(inputs: PartialInput) { return inputs.models!.initiative('root') }
`,
)
const extractionOptions = { signal: new AbortController().signal }

function bundleWith(bundle: TypeScriptLibraryBundle, changes: Partial<TypeScriptLibraryBundle>): TypeScriptLibraryBundle {
  return Object.freeze({ ...bundle, ...changes }) as TypeScriptLibraryBundle
}
function profileFor(bundle: TypeScriptLibraryBundle, assets: readonly TypeScriptLibraryBundle['assets'][number][]): string {
  const rows = assets.map((asset) => `${asset.name}\0${asset.sha256}`).sort()
  return hash(`typescript-lib-closure-v1\0${bundle.typescriptVersion}\0${rows.join('\n')}`)
}

test('explicit es2023 bundle is a deterministic bounded closure from the installed TypeScript', async () => {
  const first = await loadTypeScriptLibraryBundle({ signal: extractionOptions.signal })
  const second = await loadTypeScriptLibraryBundle({ signal: extractionOptions.signal, selector: 'es2023' })
  assert.equal(first.typescriptVersion, ts.version)
  assert.equal(first.selector, 'es2023')
  assert.equal(first.profileId, second.profileId)
  assert.deepEqual(first.assets.map(({ name, sha256 }) => [name, sha256]), second.assets.map(({ name, sha256 }) => [name, sha256]))
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.assets) && first.assets.every(Object.isFrozen))
  assert.ok(first.assets.length <= TYPE_SCRIPT_LIBRARY_LIMITS.assets)
  assert.ok(first.assets.reduce((total, asset) => total + Buffer.byteLength(asset.content), 0) <= TYPE_SCRIPT_LIBRARY_LIMITS.totalBytes)
  assert.ok(first.assets.every((asset) => Buffer.byteLength(asset.content) <= TYPE_SCRIPT_LIBRARY_LIMITS.assetBytes))
  assert.ok(first.assets.some((asset) => asset.name === 'lib.es5.d.ts' && asset.content.includes('type Pick<')))
})

test('standard utility types resolve a contract only with an explicit library bundle', async () => {
  const plain = await extractCodeSymbols([input], { root: '/verified', snapshotId: 'same' }, extractionOptions)
  const bundle = await loadTypeScriptLibraryBundle({ signal: extractionOptions.signal })
  const loaded = await extractCodeSymbols([input], { root: '/verified', snapshotId: 'same' }, { ...extractionOptions, libraries: bundle })
  const plainCall = plain.references.find((edge) => edge.kind === 'call' && input.text.slice(edge.from.start, edge.from.end) === 'inputs.models!.initiative')
  const loadedCall = loaded.references.find((edge) => edge.kind === 'call' && input.text.slice(edge.from.start, edge.from.end) === 'inputs.models!.initiative')
  assert.ok(plainCall)
  assert.ok(loadedCall)
  assert.equal(plainCall.targetKind, 'unresolved')
  assert.equal(plainCall.targetSymbolIds.length, 0)
  assert.equal(loadedCall.targetKind, 'contract')
  assert.equal(loadedCall.targetSymbolIds.length, 1)
  assert.equal(loaded.symbols.find((symbol) => symbol.id === loadedCall.targetSymbolIds[0])?.qualifiedName, 'RuntimeModels.initiative')
  assert.ok(loaded.symbols.every((symbol) => symbol.location.path === input.path))
  assert.equal(plain.compiler.libraryProfileId, null)
  assert.equal(loaded.compiler.libraryProfileId, bundle.profileId)
  assert.deepEqual(loaded.compiler.libraryAssets, bundle.assets.map((asset) => asset.name))
  assert.equal(plain.symbols.find((symbol) => symbol.name === 'use')?.id, loaded.symbols.find((symbol) => symbol.name === 'use')?.id)
  assert.notEqual(plainCall.id, loadedCall.id)
})

test('explicit library loading is opt-in and a pre-aborted load settles as cancelled', async () => {
  const methods = ['readFile', 'fileExists', 'readDirectory', 'directoryExists', 'realpath'] as const
  const system = ts.sys as unknown as Record<string, unknown>
  const originals = new Map(methods.map((method) => [method, system[method]]))
  try {
    for (const method of methods) system[method] = () => { throw new Error(`TypeScript filesystem fallback used: ${method}`) }
    const result = await extractCodeSymbols([input], { root: '/verified', snapshotId: 'no-lib' }, extractionOptions)
    assert.equal(result.compiler.libraryProfileId, null)
  } finally {
    for (const method of methods) system[method] = originals.get(method)
  }

  const controller = new AbortController()
  controller.abort(new Error('cancel before library access'))
  await assert.rejects(loadTypeScriptLibraryBundle({ signal: controller.signal }))

  const duringRead = new AbortController()
  const loading = loadTypeScriptLibraryBundle({ signal: duringRead.signal })
  const aborting = new Promise<void>((resume) => setTimeout(() => {
    duringRead.abort(new Error('cancel during library reads'))
    resume()
  }, 1))
  await Promise.all([assert.rejects(loading), aborting])
})

test('bundle integrity rejects altered profiles, hashes and incomplete closures', async () => {
  const bundle = await loadTypeScriptLibraryBundle({ signal: extractionOptions.signal })
  const alteredProfile = bundleWith(bundle, { profileId: 'f'.repeat(64) })
  await assert.rejects(extractCodeSymbols([input], { root: '/verified', snapshotId: 'bad-profile' }, { ...extractionOptions, libraries: alteredProfile }), /profile identity/u)

  const firstAsset = bundle.assets[0]!
  const alteredAsset = Object.freeze({ ...firstAsset, content: `${firstAsset.content}\n` })
  const alteredAssets = Object.freeze(bundle.assets.map((asset) => asset.name === alteredAsset.name ? alteredAsset : asset))
  const alteredHash = bundleWith(bundle, { assets: alteredAssets })
  await assert.rejects(extractCodeSymbols([input], { root: '/verified', snapshotId: 'bad-hash' }, { ...extractionOptions, libraries: alteredHash }), /hash mismatch/u)

  const incompleteAssets = Object.freeze(bundle.assets.filter((asset) => asset.name !== 'lib.es5.d.ts'))
  const incomplete = bundleWith(bundle, { assets: incompleteAssets })
  await assert.rejects(extractCodeSymbols([input], { root: '/verified', snapshotId: 'incomplete' }, { ...extractionOptions, libraries: incomplete }), /incomplete reference closure/u)
})

test('bundle validation rejects unsupported versions, references, and size/count violations', async () => {
  const bundle = await loadTypeScriptLibraryBundle({ signal: extractionOptions.signal })
  const unsupportedVersion = bundleWith(bundle, { typescriptVersion: '5.8.0' })
  await assert.rejects(
    extractCodeSymbols([input], { root: '/verified', snapshotId: 'unsupported-version' }, { ...extractionOptions, libraries: unsupportedVersion }),
    /version mismatch/u,
  )
  const unsupportedSelector = bundleWith(bundle, { selector: 'dom' as TypeScriptLibraryBundle['selector'] })
  await assert.rejects(
    extractCodeSymbols([input], { root: '/verified', snapshotId: 'unsupported-selector' }, { ...extractionOptions, libraries: unsupportedSelector }),
    /Unsupported TypeScript library selector/u,
  )

  const leaf = bundle.assets.find((asset) => asset.name === 'lib.decorators.d.ts')!
  for (const reference of ['/// <reference path="../outside.d.ts" />', '/// <reference types="node" />']) {
    const content = `${reference}\n${leaf.content}`
    const changed = Object.freeze({ ...leaf, content, sha256: hash(content) })
    const assets = Object.freeze(bundle.assets.map((asset) => asset.name === leaf.name ? changed : asset))
    const malformedClosure = bundleWith(bundle, { assets, profileId: profileFor(bundle, assets) })
    await assert.rejects(
      extractCodeSymbols([input], { root: '/verified', snapshotId: `blocked-${reference}` }, { ...extractionOptions, libraries: malformedClosure }),
      /path or types reference/u,
    )
  }

  const tooMany = bundleWith(bundle, { assets: Object.freeze(Array.from({ length: TYPE_SCRIPT_LIBRARY_LIMITS.assets + 1 }, (_, index) => bundle.assets[index % bundle.assets.length]!)) })
  await assert.rejects(
    extractCodeSymbols([input], { root: '/verified', snapshotId: 'too-many-libraries' }, { ...extractionOptions, libraries: tooMany }),
    /asset count/u,
  )
  const first = bundle.assets[0]!
  const tooLargeAsset = Object.freeze({ ...first, content: 'x'.repeat(TYPE_SCRIPT_LIBRARY_LIMITS.assetBytes + 1) })
  const tooLarge = bundleWith(bundle, { assets: Object.freeze(bundle.assets.map((asset) => asset.name === first.name ? tooLargeAsset : asset)) })
  await assert.rejects(
    extractCodeSymbols([input], { root: '/verified', snapshotId: 'too-large-library' }, { ...extractionOptions, libraries: tooLarge }),
    /exceeds/u,
  )
  const largeContent = 'x'.repeat(Math.floor(TYPE_SCRIPT_LIBRARY_LIMITS.totalBytes / 3) + 1)
  const largeAssets = Object.freeze(['lib.a.d.ts', 'lib.b.d.ts', 'lib.c.d.ts'].map((name) =>
    Object.freeze({ name, content: largeContent, sha256: hash(largeContent) }),
  ))
  const tooLargeClosure = bundleWith(bundle, { assets: largeAssets })
  await assert.rejects(
    extractCodeSymbols([input], { root: '/verified', snapshotId: 'too-large-closure' }, { ...extractionOptions, libraries: tooLargeClosure }),
    /closure exceeds/u,
  )
})

test('unknown selectors and malformed library declarations fail explicitly', async () => {
  await assert.rejects(
    loadTypeScriptLibraryBundle({ signal: extractionOptions.signal, selector: 'dom' as never }),
    /Unsupported TypeScript library selector/u,
  )
  const bundle = await loadTypeScriptLibraryBundle({ signal: extractionOptions.signal })
  const brokenAsset = bundle.assets.find((asset) => asset.name === 'lib.decorators.d.ts')!
  const brokenContent = `${brokenAsset.content}\ninterface {`
  const brokenAssets = Object.freeze(bundle.assets.map((asset) =>
    asset.name === brokenAsset.name
      ? Object.freeze({ ...asset, content: brokenContent, sha256: hash(brokenContent) })
      : asset,
  ))
  const profileId = profileFor(bundle, brokenAssets)
  const malformedBundle = bundleWith(bundle, { assets: brokenAssets, profileId })
  await assert.rejects(
    extractCodeSymbols([input], { root: '/verified', snapshotId: 'malformed-lib' }, { ...extractionOptions, libraries: malformedBundle }),
    /Malformed TypeScript library declaration/u,
  )

  const malformedSource = await extractCodeSymbols(
    [source('bad.ts', 'export function broken( {')],
    { root: '/verified', snapshotId: 'malformed-source' },
    extractionOptions,
  )
  assert.equal(malformedSource.files[0]?.status, 'parse-error')
})
