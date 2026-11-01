import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findDuplicateBodies } from '../../src/code/duplicates.js'

const opts = { minTokens: 12, minOccurrences: 2, limit: 20, maxOccurrencesPerGroup: 10 }

test('duplicate body candidates ignore formatting but preserve exact identifiers and literals', async () => {
  const result = await findDuplicateBodies([
    { path: 'src/a.ts', hash: 'a'.repeat(64), text: 'export function alpha(value: number) { const total = value + 4; return total * 3 }' },
    { path: 'src/b.ts', hash: 'b'.repeat(64), text: 'export function beta(value: number) {\n // comment\n const total=value+4; return total*3\n}' },
    { path: 'src/c.ts', hash: 'c'.repeat(64), text: 'export function gamma(value: number) { const total = value + 5; return total * 3 }' },
  ], { ...opts, matchMode: 'exact' }, new AbortController().signal)
  assert.equal(result.groups.length, 1)
  assert.equal(result.groups[0]?.occurrences.length, 2)
  assert.equal(result.groups[0]?.occurrences[0]?.lineStart, 1)
  assert.equal(result.groups[0]?.occurrences[0]?.fileContentHash, 'a'.repeat(64))
})

test('renamed mode uses checker symbols to normalize function locals and preserves free identifiers', async () => {
  const result = await findDuplicateBodies([
    { path: 'src/a.ts', hash: 'a'.repeat(64), text: 'function alpha(input: number) { const value = input + externalA; return value * 3 }' },
    { path: 'src/b.ts', hash: 'b'.repeat(64), text: 'function beta(source: number) { const result = source + externalB; return result * 3 }' },
  ], { ...opts, minTokens: 12, matchMode: 'renamed' }, new AbortController().signal)
  assert.equal(result.groups.length, 0)
  const equivalent = await findDuplicateBodies([
    { path: 'src/a.ts', hash: 'a'.repeat(64), text: 'function alpha(input: number) { const value = input + 1; return value * 3 }' },
    { path: 'src/b.ts', hash: 'b'.repeat(64), text: 'function beta(source: number) { const result = source + 1; return result * 3 }' },
  ], { ...opts, minTokens: 12, matchMode: 'renamed' }, new AbortController().signal)
  assert.equal(equivalent.groups.length, 1)

  const exactUnderRenamedMode = await findDuplicateBodies(
    [
      {
        path: 'src/a.ts',
        hash: 'c'.repeat(64),
        text: 'function sameA(input: number) { const value = input + 1; return value * 3 }',
      },
      {
        path: 'src/b.ts',
        hash: 'd'.repeat(64),
        text: 'function sameB(input: number) { const value = input + 1; return value * 3 }',
      },
    ],
    { ...opts, matchMode: 'renamed' },
    new AbortController().signal,
  )
  assert.equal(exactUnderRenamedMode.groups[0]?.matchKind, 'exact-token-body')
})

test('invalid syntax is counted as skipped and unsupported language is not parsed', async () => {
  const result = await findDuplicateBodies([
    { path: 'src/broken.ts', hash: 'x', text: 'function {' },
    { path: 'src/readme.md', hash: 'y', text: '# not code' },
  ], { ...opts, matchMode: 'exact' }, new AbortController().signal)
  assert.equal(result.skippedParse, 1)
  assert.equal(result.skippedUnsupported, 1)
})

test('renamed matching preserves parameter positions, member names, template text, and expression body kinds', async () => {
  const result = await findDuplicateBodies([
    { path: 'a.ts', hash: 'a', text: 'function first(a:number,b:number){ return a-b }' },
    { path: 'b.ts', hash: 'b', text: 'function second(x:number,y:number){ return y-x }' },
  ], { ...opts, minTokens: 12, matchMode: 'renamed' }, new AbortController().signal)
  assert.equal(result.groups.length, 0)
  const properties = await findDuplicateBodies([
    { path: 'a.ts', hash: 'a', text: 'function first(){ const obj={left: 1}; return obj.left + 3 }' },
    { path: 'b.ts', hash: 'b', text: 'function second(){ const obj={right: 1}; return obj.right + 3 }' },
  ], { ...opts, minTokens: 12, matchMode: 'renamed' }, new AbortController().signal)
  assert.equal(properties.groups.length, 0)
  const shorthand = await findDuplicateBodies([
    { path: 'a.ts', hash: 'a', text: 'function first(){ const left=1; return {left} }' },
    { path: 'b.ts', hash: 'b', text: 'function second(){ const right=1; return {right} }' },
  ], { ...opts, minTokens: 12, matchMode: 'renamed' }, new AbortController().signal)
  assert.equal(shorthand.groups.length, 0)
  const templates = await findDuplicateBodies([
    { path: 'a.ts', hash: 'a', text: 'function first(){ return `left ${1}` }' },
    { path: 'b.ts', hash: 'b', text: 'function second(){ return `right ${1}` }' },
  ], { ...opts, minTokens: 12, matchMode: 'renamed' }, new AbortController().signal)
  assert.equal(templates.groups.length, 0)
})

test('duplicate output limits report exact omitted group and occurrence counts', async () => {
  const fn = (name: string) => `function ${name}(){ return 1 + 2 + 3 + 4 + 5 + 6 }`
  const result = await findDuplicateBodies([
    { path: 'a.ts', hash: 'a', text: fn('a') },
    { path: 'b.ts', hash: 'b', text: fn('b') },
    { path: 'c.ts', hash: 'c', text: fn('c') },
  ], { ...opts, minTokens: 12, maxOccurrencesPerGroup: 2, matchMode: 'exact' }, new AbortController().signal)
  assert.equal(result.groups.length, 1)
  assert.equal(result.groups[0]?.occurrences.length, 2)
  assert.equal(result.groups[0]?.occurrenceCount, 3)
  assert.equal(result.occurrenceTruncated, true)
})

test('uppercase TypeScript paths retain checker-backed parameter and local renames', async () => {
  const result = await findDuplicateBodies(
    [
      {
        path: 'UPPER.TS',
        hash: 'a'.repeat(64),
        text: 'function upper(value:number){const doubled=value*2;return doubled+Math.max(value,53)}',
      },
      {
        path: 'upper-peer.ts',
        hash: 'b'.repeat(64),
        text: 'function peer(input:number){const twice=input*2;return twice+Math.max(input,53)}',
      },
    ],
    { ...opts, matchMode: 'renamed' },
    new AbortController().signal,
  )

  assert.equal(result.groups.length, 1)
  assert.equal(result.groups[0]?.matchKind, 'renamed-local-body')
  assert.deepEqual(
    result.groups[0]?.occurrences.map((occurrence) => occurrence.path),
    ['upper-peer.ts', 'UPPER.TS'],
  )
})
