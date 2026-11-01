import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import ts from 'typescript'
import { extractCodeSymbols } from '../../src/code/symbol-extraction.js'
import { createVerifiedSourceResolver } from '../../src/code/symbol-resolver.js'
import type { VerifiedSymbolSource } from '../../src/code/symbol-types.js'

const file = (path: string, text: string): VerifiedSymbolSource => ({ path, text, hash: createHash('sha256').update(text).digest('hex') })
const identity = { root: '/verified', snapshotId: 'same-snapshot' }
const run = (sources: VerifiedSymbolSource[], tsconfigPath = 'tsconfig.json') => extractCodeSymbols(
  sources,
  identity,
  { signal: new AbortController().signal, tsconfigPath },
)

const overloadSource = `
function choose(value: string): 'narrow';
function choose(value: string | undefined): 'wide';
function choose(value: string | undefined) { return 'wide' }
declare const input: string | undefined;
export const selected = choose(input);
`

function oracleCallParameterType(sourceText: string, oracleOptions: ts.CompilerOptions): string {
  const filename = '/oracle/source.ts'
  const source = ts.createSourceFile(filename, sourceText, ts.ScriptTarget.Latest, true)
  const options: ts.CompilerOptions = {
    ...oracleOptions,
    noLib: true,
    noEmit: true,
    types: [],
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
  }
  const host: ts.CompilerHost = {
    getSourceFile: (name) => name === filename ? source : undefined,
    getDefaultLibFileName: () => '/oracle/no-default-lib.d.ts',
    writeFile: () => { throw new Error('oracle must not emit') },
    getCurrentDirectory: () => '/oracle',
    getDirectories: () => [],
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === filename,
    readFile: (name) => name === filename ? sourceText : undefined,
  }
  const program = ts.createProgram([filename], options, host)
  let call: ts.CallExpression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'choose') call = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(call)
  const declaration = program.getTypeChecker().getResolvedSignature(call!)?.getDeclaration()
  assert.ok(declaration && ts.isFunctionDeclaration(declaration))
  return declaration.parameters[0]!.type!.getText(source)
}

function oracleParameterType(strict: boolean, strictNullChecks = strict): string {
  return oracleCallParameterType(overloadSource, { strict, strictNullChecks })
}

function selectedOverloadParameter(result: Awaited<ReturnType<typeof run>>): string {
  const edge = result.references.find((reference) => reference.kind === 'call' && reference.from.path === 'source.ts')
  assert.ok(edge)
  const target = result.symbols.find((symbol) => edge.targetSymbolIds.includes(symbol.id))
  assert.ok(target)
  return /value:\s*([\s\S]*?)\):/u.exec(target.signature)?.[1]?.replaceAll(/\s+/gu, '') ?? ''
}

test('uses strict overload semantics from the verified tsconfig, matching a closed TypeScript oracle', async () => {
  for (const strict of [false, true]) {
    const config = JSON.stringify({ compilerOptions: { strict } })
    const result = await run([file('tsconfig.json', config), file('source.ts', overloadSource)])
    const expected = oracleParameterType(strict)
    assert.equal(selectedOverloadParameter(result), expected.replaceAll(/\s+/gu, ''))
    assert.equal(expected, strict ? 'string | undefined' : 'string')
    assert.equal(result.files.find((entry) => entry.path === 'source.ts')?.status, 'parsed')
  }
})

test('matches actual TypeScript overload choices for strict function, optional-property and indexed-access flags', async () => {
  const fixtures = [
    {
      flag: 'strictFunctionTypes',
      base: {},
      text: "function choose(value:(x:string|number)=>void):'wide';function choose(value:(x:string)=>void):'narrow';function choose(value:any):any{return value} declare const input:(x:string)=>void;export const result=choose(input);",
    },
    {
      flag: 'exactOptionalPropertyTypes',
      base: { strictNullChecks: true },
      text: "function choose(value:{x?:string}):'optional';function choose(value:{x:string|undefined}):'present';function choose(value:any):any{return value} declare const input:{x:undefined};export const result=choose(input);",
    },
    {
      flag: 'noUncheckedIndexedAccess',
      base: { strictNullChecks: true },
      text: "function choose(value:string):'narrow';function choose(value:string|undefined):'wide';function choose(value:any):any{return value} declare const input:{[key:string]:string};export const result=choose(input['missing']);",
    },
  ] as const
  for (const fixture of fixtures) {
    const actualByFlag: string[] = []
    for (const enabled of [false, true]) {
      const options = { ...fixture.base, [fixture.flag]: enabled }
      const config = JSON.stringify({ compilerOptions: options })
      const result = await run([file('source.ts', fixture.text), file('tsconfig.json', config)])
      const actual = selectedOverloadParameter(result)
      const expected = oracleCallParameterType(fixture.text, options).replaceAll(/\s+/gu, '')
      assert.equal(actual, expected, `${fixture.flag}=${String(enabled)}`)
      actualByFlag.push(actual)
    }
    assert.notEqual(actualByFlag[0], actualByFlag[1], `${fixture.flag} must change the actual TypeScript oracle result`)
  }
})

test('applies child strict-flag overrides and individual strict settings', async () => {
  const inherited = await run([
    file('app/tsconfig.json', JSON.stringify({ extends: '../base.json', compilerOptions: { strictNullChecks: false } })),
    file('base.json', JSON.stringify({ compilerOptions: { strict: true } })),
    file('source.ts', overloadSource),
  ], 'app/tsconfig.json')
  assert.equal(selectedOverloadParameter(inherited), oracleParameterType(true, false))

  const independent = createVerifiedSourceResolver('/verified', [file('tsconfig.json', JSON.stringify({
    compilerOptions: {
      strict: false,
      strictNullChecks: true,
      strictFunctionTypes: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      useUnknownInCatchVariables: true,
      noImplicitAny: true,
    },
  }))])
  assert.equal(independent.compilerOptions.strict, false)
  assert.equal(independent.compilerOptions.strictNullChecks, true)
  assert.equal(independent.compilerOptions.strictFunctionTypes, true)
  assert.equal(independent.compilerOptions.exactOptionalPropertyTypes, true)
  assert.equal(independent.compilerOptions.noUncheckedIndexedAccess, true)
  assert.equal(independent.compilerOptions.useUnknownInCatchVariables, true)
  assert.equal(independent.compilerOptions.noImplicitAny, true)
})

test('retains target, JSX, module and interop options while forcing closed-analysis policy', async () => {
  const resolver = createVerifiedSourceResolver('/verified', [file('tsconfig.json', JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      jsx: 'react-jsx',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
      allowJs: false,
      checkJs: false,
      noEmit: false,
      noLib: false,
      types: ['node'],
      noResolve: true,
      skipLibCheck: false,
      plugins: [{ name: 'must-not-run' }],
    },
  }))])
  assert.equal(resolver.compilerOptions.target, ts.ScriptTarget.ES2022)
  assert.equal(resolver.compilerOptions.jsx, ts.JsxEmit.ReactJSX)
  assert.equal(resolver.compilerOptions.module, ts.ModuleKind.NodeNext)
  assert.equal(resolver.compilerOptions.moduleResolution, ts.ModuleResolutionKind.NodeNext)
  assert.equal(resolver.compilerOptions.esModuleInterop, true)
  assert.equal(resolver.compilerOptions.allowSyntheticDefaultImports, true)
  assert.equal(resolver.compilerOptions.resolveJsonModule, true)
  assert.equal(resolver.compilerOptions.allowJs, true)
  assert.equal(resolver.compilerOptions.checkJs, true)
  assert.equal(resolver.compilerOptions.noEmit, true)
  assert.equal(resolver.compilerOptions.noLib, true)
  assert.deepEqual(resolver.compilerOptions.types, [])
  assert.equal(resolver.compilerOptions.noResolve, true)
  assert.equal(resolver.compilerOptions.skipLibCheck, false)
  assert.equal(resolver.compilerOptions.plugins, undefined)

  const jsx = await run([
    file('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', jsx: 'react-jsx' } })),
    file('view.tsx', 'export const View = () => <section />'),
  ])
  assert.equal(jsx.files.find((entry) => entry.path === 'view.tsx')?.status, 'parsed')
})

test('parses only verified config files without TypeScript filesystem fallback', () => {
  const methods = ['readFile', 'fileExists', 'readDirectory', 'directoryExists', 'realpath', 'getDirectories'] as const
  const system = ts.sys as unknown as Record<string, unknown>
  const originals = new Map(methods.map((method) => [method, system[method]]))
  try {
    for (const method of methods) system[method] = () => { throw new Error(`filesystem fallback used: ${method}`) }
    const resolver = createVerifiedSourceResolver('/verified', [
      file('app/tsconfig.json', JSON.stringify({ extends: '../config/base.json', compilerOptions: { strictNullChecks: false } })),
      file('config/base.json', JSON.stringify({ compilerOptions: { strict: true } })),
      file('source.ts', overloadSource),
    ], 'app/tsconfig.json')
    assert.equal(resolver.compilerOptions.strict, true)
    assert.equal(resolver.compilerOptions.strictNullChecks, false)
    assert.deepEqual(resolver.diagnostics, [])
  } finally {
    for (const method of methods) system[method] = originals.get(method)
  }
})

test('invalid known options and unavailable configs make extraction incomplete', async () => {
  const invalid = await run([
    file('tsconfig.json', JSON.stringify({ compilerOptions: { strictNullChecks: 'sometimes' } })),
    file('source.ts', 'export const value = 1'),
  ])
  assert.equal(invalid.complete, false)
  assert.ok(invalid.files.some((entry) => entry.diagnostics.some((message) => message.includes('tsconfig'))))
  assert.ok(invalid.compiler.compilerOptionsHash)

  const missing = await run([file('source.ts', 'export const value = 1')])
  assert.equal(missing.complete, false)
  assert.ok(missing.files.some((entry) => entry.diagnostics.some((message) => message.includes('unavailable verified tsconfig'))))
})

test('compiler-options provenance is stable by effective config and separates strict profiles', async () => {
  const strictTrue = file('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022' } }))
  const strictFalse = file('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', strict: false } }))
  const source = file('source.ts', overloadSource)
  const first = await run([strictTrue, source])
  const reordered = await run([source, strictTrue])
  const other = await run([strictFalse, source])
  assert.equal(first.compiler.compilerOptionsHash, reordered.compiler.compilerOptionsHash)
  assert.notEqual(first.compiler.compilerOptionsHash, other.compiler.compilerOptionsHash)
  assert.notEqual(first.references.find((reference) => reference.kind === 'call')?.id, other.references.find((reference) => reference.kind === 'call')?.id)
})
