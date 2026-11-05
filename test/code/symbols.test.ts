import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import ts from 'typescript'
import { extractCodeSymbols } from '../../src/code/symbol-extraction.js'
import { createVerifiedSourceResolver } from '../../src/code/symbol-resolver.js'
import type { VerifiedSymbolSource } from '../../src/code/symbol-types.js'

const file = (path: string, text: string): VerifiedSymbolSource => ({ path, text, hash: createHash('sha256').update(text).digest('hex') })
const run = (sources: VerifiedSymbolSource[], options: { maxSymbols?: number; maxReferences?: number; maxFiles?: number; tsconfigPath?: string } = {}) => extractCodeSymbols(sources, { root: '/verified', snapshotId: 'snap-1' }, { signal: new AbortController().signal, ...options })

test('extracts nested symbols and checker-confirmed alias, barrel, type-only and call relations', async () => {
  const result = await run([
    file('src/impl.ts', 'export interface Port { run(x: string): string }\nexport function run(x: string): string;\nexport function run(x: string) { return x }\nexport class Handler implements Port {\n  #secret() { return run("x") }\n  run(x: string) { const inner = () => this.#secret(); return inner() }\n}\n'),
    file('src/barrel.ts', 'export { Handler as PublicHandler } from "./impl.js"\nexport type { Port } from "./impl.js"\n'),
    file('src/use.ts', 'import { PublicHandler } from "./barrel.js"\nimport type { Port } from "./barrel.js"\nconst h = new PublicHandler(); const p: Port = h; p.run("ok")\n'),
  ])
  assert.equal(result.complete, true)
  assert.ok(result.symbols.some((symbol) => symbol.qualifiedName === 'Handler.#secret' && symbol.kind === 'method'))
  assert.ok(result.symbols.some((symbol) => symbol.qualifiedName.endsWith('.inner') && symbol.kind === 'callable'))
  assert.ok(result.references.some((reference) => reference.kind === 'call' && reference.targetSymbolIds.length > 0))
  assert.ok(result.references.some((reference) => reference.kind === 'construct' && reference.targetSymbolIds.length > 0))
  assert.ok(result.references.some((reference) => reference.targetKind === 'contract' && reference.targetSymbolIds.length > 0))
})

test('records property/private/namespace/chained calls, injected contracts, construction and dynamic uncertainty', async () => {
  const result = await run([
    file('contracts.ts', 'export interface Initiative { initiative(): string }\nexport function use(models: Initiative) { return models.initiative() }\n'),
    file('calls.ts', 'class C { #privateRun() { return "ok" } run() { return this.#privateRun() } }\nnamespace ns { export function run() { return 1 } }\nfunction factory() { return () => "value" }\nfunction exercise(key: string, models: import("./contracts.js").Initiative) { const c = new C(); c.run(); ns.run(); factory()(); const invoke = ({} as Record<string, () => void>)[key]; invoke(); models.initiative() }\n'),
  ])
  assert.ok(result.references.some((reference) => reference.kind === 'call' && reference.targetKind === 'contract' && reference.from.path === 'calls.ts'))
  assert.ok(result.references.some((reference) => reference.kind === 'call' && reference.from.path === 'calls.ts' && reference.targetSymbolIds.some((id) => result.symbols.find((symbol) => symbol.id === id)?.name === '#privateRun')))
  assert.ok(result.references.some((reference) => reference.kind === 'construct' && reference.targetSymbolIds.some((id) => result.symbols.find((symbol) => symbol.id === id)?.name === 'constructor' || result.symbols.find((symbol) => symbol.id === id)?.name === 'C')))
  assert.ok(result.references.some((reference) => reference.unresolvedReason === 'dynamic' && reference.targetSymbolIds.length === 0))
  assert.ok(result.references.some((reference) => reference.kind === 'call' && reference.targetSymbolIds.some((id) => result.symbols.find((symbol) => symbol.id === id)?.qualifiedName === 'ns.run')))
})

test('separates explicit instances and credits direct and immutable alias method uses', async () => {
  const result = await run([
    file('service.ts', 'export class Service { run() { return 1 } stop() { return 2 } }\nexport const shared = new Service()\nexport function unrelated() { return 3 }\n'),
    file('consumer.ts', 'import { Service as ImportedService, shared as importedShared } from "./service.js"\nimport { unrelated } from "./service.js"\nconst first = new ImportedService(); const second = new ImportedService(); const firstAlias = first; const secondAlias = second; const firstAlias2 = firstAlias; first.run(); firstAlias2.stop(); secondAlias.run(); importedShared.run(); unrelated()\nlet mutable = first; mutable.run()\nconst madeByFactory = makeService(); madeByFactory.run()\ndeclare function makeService(): ImportedService\n'),
  ])
  const instances = result.symbols.filter((symbol) => symbol.kind === 'instance')
  assert.deepEqual(instances.map((symbol) => symbol.name).sort(), ['first', 'second', 'shared'])
  const byName = new Map(instances.map((symbol) => [symbol.name, symbol]))
  const uses = result.references.filter((reference) => reference.relationKind === 'uses_instance')
  const instanceName = (reference: typeof uses[number]) => result.symbols.find((symbol) => symbol.id === reference.targetSymbolIds[0])?.name
  assert.deepEqual(uses.map(instanceName).sort(), [
    'first', 'first', 'second', 'shared',
  ].sort())
  assert.ok(uses.every((reference) => reference.kind === 'reference'))
  assert.ok(uses.every((reference) => reference.ownerSymbolId && result.symbols.find((symbol) => symbol.id === reference.ownerSymbolId)?.kind === 'module-init'))
  assert.ok(uses.every((reference) => reference.targetSymbolIds.length === 1 && instances.some((instance) => instance.id === reference.targetSymbolIds[0])))
  const constructions = result.references.filter((reference) => reference.relationKind === 'instantiates')
  assert.equal(constructions.length, 3)
  assert.ok(constructions.every((reference) => reference.kind === 'construct' && instances.some((instance) => instance.id === reference.ownerSymbolId)))
  assert.ok(constructions.every((reference) => reference.unresolvedReason !== 'dynamic' && reference.targetSymbolIds.some((id) => result.symbols.find((symbol) => symbol.id === id)?.name === 'Service')))
  assert.ok(result.references.some((reference) => reference.kind === 'call' && reference.targetSymbolIds.some((id) => result.symbols.find((symbol) => symbol.id === id)?.name === 'unrelated')))
  assert.equal(result.references.filter((reference) => reference.kind === 'call' && reference.from.path === 'consumer.ts').length, 8)
  assert.equal(uses.length, 4)
  assert.equal(result.references.filter((reference) => reference.kind === 'call' && reference.from.path === 'consumer.ts' && reference.targetSymbolIds.some((id) => result.symbols.find((symbol) => symbol.id === id)?.name === 'run' || result.symbols.find((symbol) => symbol.id === id)?.name === 'stop')).length, 6)
})

test('marks explicit class heritage without inferring relationships from ordinary references', async () => {
  const result = await run([file('heritage.ts', 'interface Contract {}\nclass Base {}\nclass Child extends Base implements Contract {}\n')])
  const child = result.symbols.find((symbol) => symbol.name === 'Child')!
  assert.ok(result.references.some((reference) => reference.ownerSymbolId === child.id && reference.relationKind === 'inherits' && reference.targetSymbolIds.some((id) => result.symbols.find((symbol) => symbol.id === id)?.name === 'Base')))
  assert.ok(result.references.some((reference) => reference.ownerSymbolId === child.id && reference.relationKind === 'implements' && reference.targetSymbolIds.some((id) => result.symbols.find((symbol) => symbol.id === id)?.name === 'Contract')))
})

test('nested calls with a shared start offset receive distinct stable edge IDs', async () => {
  const result = await run([file('chain.ts', 'function factory() { return () => 1 } export function run() { return factory()() }')])
  const calls = result.references.filter((reference) => reference.kind === 'call')
  assert.equal(calls.length, 2)
  assert.equal(new Set(calls.map((call) => call.id)).size, 2)
  assert.ok(calls.every((call) => call.id.length === 64))
})

test('preserves source path, hash and uppercase script extension while reporting parse errors', async () => {
  const upper = file('UPPER.TS', 'export const fn = (x: number) => x')
  const bad = file('bad.ts', 'function broken( {')
  const result = await run([upper, bad])
  assert.equal(result.files.find((entry) => entry.path === upper.path)?.status, 'parsed')
  assert.equal(result.symbols.find((symbol) => symbol.name === 'fn')?.location.fileHash, upper.hash)
  assert.equal(result.files.find((entry) => entry.path === bad.path)?.status, 'parse-error')
  assert.equal(result.complete, false)
})

test('preserves overload declarations and points calls at the checker-selected overload', async () => {
  const result = await run([file('overloads.ts', 'export function choose(value: string): string;\nexport function choose(value: number): number;\nexport function choose(value: string | number) { return value }\nconst selected = choose(1)\n')])
  const choices = result.symbols.filter((symbol) => symbol.name === 'choose')
  assert.equal(choices.length, 3)
  assert.ok(choices.every((symbol) => symbol.overloadGroupId === choices[0]?.overloadGroupId))
  const call = result.references.find((reference) => reference.kind === 'call' && reference.targetSymbolIds.length > 0)
  assert.ok(call)
  assert.equal(call.targetSymbolIds.length, 1)
  assert.equal(result.symbols.find((symbol) => symbol.id === call.targetSymbolIds[0])?.signature.includes('value: number'), true)
})

test('inherits path aliases from the declaring baseUrl config directory', async () => {
  const source = file('app/use.ts', 'import { work } from "@alias/work"; export function use() { return work() }')
  const result = await run([
    file('app/tsconfig.json', '{"extends":"../configs/base.json"}'),
    file('configs/base.json', '{"compilerOptions":{"baseUrl":"..","paths":{"@alias/*":["src/*"]}}}'),
    file('src/work.ts', 'export function work() { return 1 }'),
    source,
  ], { tsconfigPath: 'app/tsconfig.json' })
  assert.ok(result.references.some((reference) => reference.kind === 'call' && reference.from.path === source.path && reference.targetSymbolIds.some((id) => result.symbols.find((symbol) => symbol.id === id)?.location.path === 'src/work.ts')))
})

test('ambient declarations are contracts without runtime implementations', async () => {
  const source = file('use.ts', 'import { remote } from "./api.js"; export function use() { return remote() }')
  const result = await run([file('api.d.ts', 'export declare function remote(): string;'), source])
  const call = result.references.find((reference) => reference.kind === 'call' && reference.from.path === source.path)
  assert.ok(call)
  assert.equal(call.targetKind, 'contract')
  assert.ok(call.targetSymbolIds.every((id) => result.symbols.find((symbol) => symbol.id === id)?.contract))
})

test('caps and cancellation are explicit', async () => {
  const sources = [file('a.ts', 'export function a() {}'), file('b.ts', 'export function b() {}')]
  const capped = await run(sources, { maxFiles: 1, maxSymbols: 0 })
  assert.equal(capped.truncation.files, true)
  assert.equal(capped.truncation.symbols, true)
  assert.equal(capped.complete, false)
  const visibleIds = new Set(capped.symbols.map((symbol) => symbol.id))
  assert.ok(capped.references.every((reference) => reference.ownerSymbolId === null || visibleIds.has(reference.ownerSymbolId)))
  assert.ok(capped.references.every((reference) => reference.targetSymbolIds.every((id) => visibleIds.has(id))))
  assert.ok(capped.symbols.every((symbol) => symbol.parentId === null || visibleIds.has(symbol.parentId)))
  const unsupportedLimited = await run([
    file('a.json', '{}'),
    file('b.json', '{}'),
    file('c.ts', 'export {}'),
  ], { maxFiles: 1 })
  assert.ok(unsupportedLimited.files.length <= 1)
  assert.equal(unsupportedLimited.truncation.files, true)
  assert.equal(unsupportedLimited.complete, false)
  const controller = new AbortController(); controller.abort(new Error('cancel'))
  await assert.rejects(extractCodeSymbols(sources, { root: '/verified', snapshotId: 'snap' }, { signal: controller.signal }))
  await assert.rejects(run([file('../outside.ts', 'export {}')]))
  await assert.rejects(run([file('same.ts', 'export {}'), file('./same.ts', 'export {}')]))
  await assert.rejects(run(sources, { maxSymbols: Number.NaN }))
  await assert.rejects(run(sources, { maxReferences: -1 }))
  await assert.rejects(run(sources, { maxFiles: 1.5 }))
  await assert.rejects(run(sources, { maxFiles: 100_001 }))
  const unsupported = await run([file('example.constructor', 'arbitrary data')])
  assert.equal(unsupported.files[0]?.status, 'unsupported')
  assert.equal(unsupported.symbols.length, 0)
})

test('compiler and resolver do not use TypeScript filesystem fallback routes', async () => {
  const methods = ['readFile', 'fileExists', 'readDirectory', 'directoryExists', 'realpath'] as const
  const system = ts.sys as unknown as Record<string, unknown>
  const originals = new Map(methods.map((method) => [method, system[method]]))
  try {
    for (const method of methods) system[method] = () => { throw new Error(`filesystem fallback used: ${method}`) }
    const result = await run([
      file('src/a.ts', '/// <reference types="node" />\nimport { b } from "./b.js"; export const a = b()'),
      file('src/b.ts', 'export function b() { return 1 }'),
    ])
    assert.equal(result.complete, true)
    assert.ok(result.references.some((reference) => reference.kind === 'call' && reference.targetSymbolIds.length === 1))
  } finally {
    for (const method of methods) system[method] = originals.get(method)
  }
})

test('resolver honors verified tsconfig aliases and refuses files outside the supplied map', () => {
  const sources = [
    file('tsconfig.json', '{"extends":"./tsconfig.base.json"}'),
    file('tsconfig.base.json', '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}'),
    file('src/target.ts', 'export const target = 1'),
  ]
  const resolver = createVerifiedSourceResolver('/verified', sources)
  assert.equal(resolver.resolve('src/use.ts', '@/target'), 'src/target.ts')
  assert.equal(resolver.resolve('src/use.ts', './missing.js'), null)
  assert.ok(resolver.diagnostics.length === 0)
})

test('resolver selects only a verified development export target', () => {
  const resolver = createVerifiedSourceResolver('/verified', [
    file('package.json', JSON.stringify({ name: '@sample/pkg', exports: { '.': { development: './src/index.ts', types: './dist/index.d.ts', default: './dist/index.js' }, './sub': { development: './src/sub.ts', default: './dist/sub.js' } } })),
    file('src/index.ts', 'export {}'), file('src/sub.ts', 'export {}'),
  ])
  assert.equal(resolver.resolve('src/consumer.ts', '@sample/pkg'), 'src/index.ts')
  assert.equal(resolver.resolve('src/consumer.ts', '@sample/pkg/sub'), 'src/sub.ts')
  assert.equal(resolver.resolve('src/consumer.ts', '@sample/pkg/missing'), null)
  const noSourceCondition = createVerifiedSourceResolver('/verified', [
    file('package.json', JSON.stringify({ name: '@sample/no-dev', exports: { '.': { types: './src/index.d.ts', default: './src/index.ts' } } })),
    file('src/index.d.ts', 'export {}'), file('src/index.ts', 'export {}'),
  ])
  assert.equal(noSourceCondition.resolve('src/consumer.ts', '@sample/no-dev'), null)
  const nested = createVerifiedSourceResolver('/verified', [
    file('packages/runtime/package.json', JSON.stringify({ name: '@sample/runtime', exports: { '.': { types: './dist/index.d.ts', development: './src/index.ts', default: './dist/index.js' }, './server': { development: './src/server.ts', default: './dist/server.js' } } })),
    file('packages/runtime/src/index.ts', 'export {}'), file('packages/runtime/src/server.ts', 'export {}'),
  ])
  assert.equal(nested.resolve('apps/client/src/use.ts', '@sample/runtime'), 'packages/runtime/src/index.ts')
  assert.equal(nested.resolve('apps/client/src/use.ts', '@sample/runtime/server'), 'packages/runtime/src/server.ts')
  assert.equal(nested.resolve('apps/client/src/use.ts', '@sample/runtime/missing'), null)
})

test('tsconfig extends paths use their declaring config origin; cycles and malformed configs are visible', () => {
  const resolver = createVerifiedSourceResolver('/verified', [
    file('apps/leaf/tsconfig.json', '{"extends":"../../configs/base/tsconfig.json"}'),
    file('configs/base/tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@base/*":["../../src/*"]},"rootDirs":["../../src","../../generated"]}}'),
    file('src/base.ts', 'export {}'), file('apps/leaf/src/own.ts', 'export {}'),
    file('generated/shared.ts', 'export {}'), file('src/use.ts', 'export {}'),
  ], 'apps/leaf/tsconfig.json')
  assert.equal(resolver.resolve('apps/leaf/src/consumer.ts', '@base/base'), 'src/base.ts')
  const localConfig = createVerifiedSourceResolver('/verified', [
    file('apps/leaf/tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@leaf/*":["./src/*"]}}}'),
    file('apps/leaf/src/own.ts', 'export {}'),
  ], 'apps/leaf/tsconfig.json')
  assert.equal(localConfig.resolve('apps/leaf/src/consumer.ts', '@leaf/own'), 'apps/leaf/src/own.ts')
  const rootDirs = createVerifiedSourceResolver('/verified', [
    file('tsconfig.json', '{"compilerOptions":{"rootDirs":["src","generated"]}}'),
    file('src/use.ts', 'import "./shared.js"'), file('generated/shared.ts', 'export {}'),
  ])
  assert.equal(rootDirs.resolve('src/use.ts', './shared.js'), 'generated/shared.ts')
  const invalid = createVerifiedSourceResolver('/verified', [
    file('tsconfig.json', '{"extends":"./tsconfig.base.json"}'),
    file('tsconfig.base.json', '{"extends":"./tsconfig.json"}'),
  ])
  assert.ok(invalid.diagnostics.some((diagnostic) => diagnostic.includes('cycle')))
  const malformed = createVerifiedSourceResolver('/verified', [file('tsconfig.json', '{bad')])
  assert.ok(malformed.diagnostics.some((diagnostic) => diagnostic.includes('malformed')))
})
